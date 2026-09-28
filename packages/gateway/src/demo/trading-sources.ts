/**
 * 交易页来源漏斗(契约 §9.56 GET /api/trading/sources):每个机会来源今天看了多少、判断层放了/挡了多少、
 * 执行层拒了多少、下了几单,以及「挡在哪一层」的原因排行。零模型、只读。
 *
 * 原因优先读源头写好的结构化字段(事件 data.layer/code、episode 闸的 code),旧记录没有时才按闸名/文本归一。
 */
import type { DatabaseSync } from 'node:sqlite';
import { NOT_TAKEN_CODES, codeFromText, gateReasonCode, normalizeReasonText, reasonLabel, type ReasonLayer } from './execution-policy.js';
import type { StrategyRun, StrategyRunEvent } from './strategy-run.js';
import type { GateResult } from './types.js';

export interface TopReason { layer: ReasonLayer; key: string; label: string; count: number; example: string }

/** 原因计数器:同 (layer,key) 合并,保留第一条原文做样例。被挡的进 top_reasons,没做但不算被挡的进 not_taken。 */
export class ReasonTally {
  private rows = new Map<string, TopReason>();
  private info = new Map<string, TopReason>();
  add(layer: ReasonLayer, key: string, example: string, label = reasonLabel(key)): void {
    const bucket = NOT_TAKEN_CODES.has(key) ? this.info : this.rows;
    const id = `${layer}:${key}`, row = bucket.get(id);
    if (row) row.count++;
    else bucket.set(id, { layer, key, label, count: 1, example: example.slice(0, 200) });
  }
  top(n = 8): TopReason[] { return sort(this.rows).slice(0, n); }
  notTaken(n = 8): TopReason[] { return sort(this.info).slice(0, n); }
  /** 被挡的总次数(top_reasons 各行加起来,不截断) */
  blocked(): number { return [...this.rows.values()].reduce((a, r) => a + r.count, 0); }
}
const sort = (m: Map<string, TopReason>) => [...m.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

// ------------------------------------------------------------------ AI 扫盘

export interface AiScanEpisodeRow {
  id: string; at: number; symbol: string; model: string; status: string; error: string | null;
  action: string | null; headline: string | null; gates: GateResult[]; intent_status: string | null; intent_error: string | null;
}

/**
 * AI 扫盘的 episode:自己的盯盘循环叫起来的扫描(不是复查、不是对话、不是跟单/策略运行借用的 episode)。
 * 只取漏斗要的小字段,不把整段证据 JSON 读出来。
 */
export function aiScanEpisodes(db: DatabaseSync, since: number, until: number): AiScanEpisodeRow[] {
  const rows = db.prepare(`SELECT id, at,
      json_extract(json,'$.symbol') AS symbol, json_extract(json,'$.model') AS model, status, json_extract(json,'$.error') AS error,
      action, json_extract(json,'$.judgment.headline') AS headline, json_extract(json,'$.gates') AS gates,
      json_extract(json,'$.intent.status') AS intent_status, json_extract(json,'$.intent.error') AS intent_error
    FROM demo_episodes
    WHERE at >= ? AND at < ?
      AND json_extract(json,'$.origin') IS NULL
      AND json_extract(json,'$.strategy_before.state') = 'researching'
      AND COALESCE(json_extract(json,'$.trigger.kind'),'') NOT IN ('chat','trader_signal')
      AND COALESCE(json_extract(json,'$.trigger.detail'),'') NOT LIKE 'strategy_run:%'
    ORDER BY at DESC LIMIT 20000`).all(since, until);
  return rows.map((r) => ({
    id: String(r['id']), at: Number(r['at']), symbol: String(r['symbol'] ?? ''), model: String(r['model'] ?? ''), status: String(r['status'] ?? ''),
    error: r['error'] === null || r['error'] === undefined ? null : String(r['error']), action: r['action'] === null || r['action'] === undefined ? null : String(r['action']),
    headline: r['headline'] === null || r['headline'] === undefined ? null : String(r['headline']),
    gates: (() => { try { return JSON.parse(String(r['gates'] ?? '[]')) as GateResult[]; } catch { return []; } })(),
    intent_status: r['intent_status'] === null || r['intent_status'] === undefined ? null : String(r['intent_status']),
    intent_error: r['intent_error'] === null || r['intent_error'] === undefined ? null : String(r['intent_error']),
  }));
}

const SENT = new Set(['submitted', 'filled', 'unknown', 'approved', 'partially_filled']);

export function summarizeAiScan(rows: AiScanEpisodeRow[], skippedModel: string) {
  const actions: Record<string, number> = {}, tally = new ReasonTally();
  let judgments = 0, proposals = 0, gateRejected = 0, orders = 0, pending = 0, failed = 0;
  for (const e of rows) {
    if (e.model !== skippedModel) judgments++;
    if (e.status === 'failed') {
      failed++;
      // 失败不一定是模型坏了:提议没过持仓计划 / 净盈亏比这类检查、或者行情接口限流,都会记成 failed
      const c = e.error ? codeFromText(e.error) : null;
      tally.add(c?.layer ?? 'execution', c?.code ?? 'model_failed', `${e.symbol}:${e.error ?? '模型调用失败'}`);
      continue;
    }
    if (e.action) actions[e.action] = (actions[e.action] ?? 0) + 1;
    if (e.action === 'NO_TRADE') tally.add('judge', 'no_trade', `${e.symbol}:${e.headline ?? 'NO_TRADE'}`);
    else if (e.action === 'WATCH') tally.add('judge', 'watch', `${e.symbol}:${e.headline ?? 'WATCH'}`);
    if (e.action !== 'PROPOSE') continue;
    proposals++;
    const blocked = e.gates.filter((g) => !g.passed);
    if (blocked.length) {
      gateRejected++;
      // 每个 episode 每个原因码只计一次(一条提议可能同时撞几道闸,都要看得见)
      const seen = new Set<string>();
      for (const g of blocked) { const code = gateReasonCode(g); if (!seen.has(code)) { seen.add(code); tally.add('gate', code, `${e.symbol} ${g.name}:${g.reason}`); } }
      continue;
    }
    if (e.intent_status === 'pending_approval') pending++;
    else if (e.intent_status && SENT.has(e.intent_status)) orders++;
    else if (e.intent_status === 'rejected' || e.intent_status === 'failed') {
      const c = codeFromText(e.intent_error ?? '');
      tally.add(c?.layer ?? 'execution', c?.code ?? 'execution_error', `${e.symbol}:${e.intent_error ?? e.intent_status}`);
    }
  }
  const last = rows[0] ?? null;
  return {
    today: { judgments, actions, proposals, gate_rejected: gateRejected, orders, pending_approval: pending, failed },
    last_event: last ? { at: last.at, symbol: last.symbol, action: last.action, summary: last.headline ?? last.error ?? null } : null,
    top_reasons: tally.top(),
    not_taken: tally.notTaken(),
  };
}

// ------------------------------------------------------------------ 策略运行

/** 从事件里取「为什么没下单」。先看事件自带的 layer/code,旧事件再按文字和事件类型猜。和没下单无关的事件返回 null。 */
export function eventReason(e: StrategyRunEvent): { layer: ReasonLayer; key: string; label: string } | null {
  if (!['skip', 'agent_skip', 'order_rejected', 'error'].includes(e.kind)) return null;
  const d = e.data ?? {};
  const layer = d['layer'], code = d['code'];
  if (typeof layer === 'string' && ['judge', 'strategy', 'gate', 'execution'].includes(layer) && typeof code === 'string' && code)
    return { layer: layer as ReasonLayer, key: code, label: reasonLabel(code) };
  const c = codeFromText(e.message);
  if (c) return { layer: c.layer, key: c.code, label: reasonLabel(c.code) };
  const fallback: ReasonLayer = e.kind === 'agent_skip' ? 'judge' : e.kind === 'error' ? 'execution' : e.kind === 'order_rejected' ? 'execution' : 'strategy';
  // 旧事件、没有结构化字段:去数字归一后当分桶键,标签就是归一后的原文
  const text = normalizeReasonText(e.message);
  return { layer: fallback, key: `text:${text}`, label: text };
}

export function summarizeRun(run: StrategyRun, events: StrategyRunEvent[], openThreads: number) {
  const tally = new ReasonTally();
  const today = { scans: 0, candidates: 0, judged: { follow: 0, skip: 0 }, gate_rejected: 0, skipped: 0, orders: 0, open_threads: openThreads, errors: 0 };
  for (const e of events) {
    if (e.kind === 'scan') today.scans++;
    else if (e.kind === 'candidate') today.candidates++;
    else if (e.kind === 'agent_follow') today.judged.follow++;
    else if (e.kind === 'agent_skip') today.judged.skip++;
    else if (e.kind === 'order_opened' || e.kind === 'order_pending') today.orders++;
    else if (e.kind === 'skip') today.skipped++;
    else if (e.kind === 'error') today.errors++;
    const r = eventReason(e);
    if (!r) continue;
    // IR 判断要素说跳过时会先记一条 agent_skip,再记一条 skip:ir_judge_skip,同一个候选只算一次
    if (e.kind === 'skip' && r.key === 'ir_judge_skip') { today.skipped--; continue; }
    if (e.kind === 'order_rejected') { if (r.layer === 'gate') today.gate_rejected++; else today.errors++; }
    tally.add(r.layer, r.key, `${e.symbol ? `${e.symbol} ` : ''}${e.message}`, r.label);
  }
  const last = events.at(-1) ?? null;
  return {
    kind: 'strategy_run' as const, id: run.id, run_id: run.id, strategy_id: run.strategy_id, name: run.strategy_name, version: run.version,
    symbols: run.symbols, timeframe: run.timeframe, mode: run.mode, judge: run.mode === 'agent' ? 'llm' : run.mode === 'jev' ? 'jev' : run.mode === 'signal_only' ? 'none' : 'code',
    status: run.status, enabled: run.status === 'running', market: run.market, risk_pct: run.risk_pct, max_open: run.max_open,
    execution: { backend: run.execution.backend, profile: run.execution.profile, label: run.execution.label },
    today, last_event: last ? { at: last.at, kind: last.kind, symbol: last.symbol, message: last.message } : null,
    top_reasons: tally.top(),
    not_taken: tally.notTaken(),
  };
}

export function runEventsSince(db: DatabaseSync, runId: string, since: number, until: number): StrategyRunEvent[] {
  return db.prepare('SELECT json FROM strategy_run_events WHERE run_id=? AND at>=? AND at<? ORDER BY seq LIMIT 20000').all(runId, since, until)
    .map((r) => JSON.parse(String(r['json'])) as StrategyRunEvent);
}

/** `?since=` 解析:缺省今天 UTC 00:00;非法 → null(路由回 400)。窗口最长 31 天。 */
export function parseSince(raw: string | null, now: number): number | null {
  const day = Math.floor(now / 86_400_000) * 86_400_000;
  if (raw === null || raw === '') return day;
  if (!/^\d{1,16}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= now && now - n <= 31 * 86_400_000 ? n : null;
}
