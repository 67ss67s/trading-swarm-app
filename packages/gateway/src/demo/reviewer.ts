/**
 * Reviewer(AI 角色,便宜大脑,有界):
 *   ① 平仓即刻算一张**确定性复盘卡**(代码:R、持有时长、离场原因分类、保护是否到位)→ bot_run(routine trade_card);
 *   ② 合格已平仓累计 ≥ 5 笔,或距上次批次 ≥ 24h 且至少 1 笔新的 → **批量提炼教训**(模型,每天 ≤ 2 次,每轮 ≤ 2 条)
 *      → memory.propose(status=proposed,等人批)+ handoff reviewer → gate_captain(kind=review)。
 *   ③ 提案反方审查(countercase)这版**不做**(见设计文档 §5 延后项)。
 *
 * 教训的硬闸(Codex 稿 §5.3):每条必须有 observation / mechanism / falsifier(可证伪条件)/ source_refs(非空且属于本批);
 * 正文不许出现具体价位(≥ 3 位的数字或带小数的价格);symbol 只能是本批出现过的或 null;regime 只能是枚举。
 * 教训被批准也只是「记忆」——它不能改任何策略参数(参数 diff 归 Strategy Lab)。
 */
import { createHash } from 'node:crypto';
import type { Brain } from './brain.js';
import type { ProposeInput } from './memory.js';
import type { StrategyThread } from './types.js';

export const REVIEWER_PROMPT_VERSION = 'reviewer-reflect-v2';
export const BATCH_MIN_THREADS = 5;
export const BATCH_MAX_THREADS = 20;
export const BATCH_STALE_MS = 24 * 3_600_000;
export const BATCH_MAX_PER_DAY = 2;
export const LESSONS_PER_BATCH = 2;

// ---------------------------------------------------------------- ① 复盘卡(纯代码)

export type ExitClass = 'stop' | 'take_profit' | 'model_exit' | 'invalidated' | 'canceled' | 'manual' | 'halt' | 'other';

export interface TradeCard {
  thread_id: string;
  symbol: string;
  side: 'long' | 'short';
  source: string;
  strategy_id: string | null;
  status: string;
  filled: boolean;
  entry_price: number | null;
  exit_price: number | null;
  stop_price: number | null;
  qty: number;
  realized_pnl: number | null;
  /** 盈亏 / 初始风险(|入场−止损|×数量);算不出 → null */
  r_multiple: number | null;
  hold_ms: number | null;
  /** 线程结束时刻(closed_at,缺则 updated_at) */
  ended_at: number;
  exit_class: ExitClass;
  close_reason: string | null;
  outcome: 'win' | 'loss' | 'scratch' | 'unfilled' | 'unknown';
  protection_ok: boolean;
  episode_count: number;
  notes: string[];
}

const num = (s: string | null | undefined): number | null => {
  if (s === null || s === undefined || s === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

export function classifyExit(t: StrategyThread): ExitClass {
  const r = (t.close_reason ?? '').toLowerCase();
  if (t.status === 'canceled') return 'canceled';
  if (t.status === 'invalidated') return 'invalidated';
  if (/止损|stop|sl/.test(r)) return 'stop';
  if (/止盈|take.?profit|tp/.test(r)) return 'take_profit';
  if (/紧急|halt/.test(r)) return 'halt';
  if (/用户|手动|manual|user/.test(r)) return 'manual';
  if (/离场|exit|论点|翻转|减仓|reduce/.test(r)) return 'model_exit';
  return 'other';
}

export function tradeCard(t: StrategyThread, episodeCount = t.episode_ids.length): TradeCard {
  const entry = num(t.filled_avg_price);
  const exit = num(t.exit_price ?? null);
  const stop = num(t.stop_price);
  const qty = num(t.qty) ?? 0;
  const pnl = num(t.realized_pnl);
  const filled = entry !== null && t.opened_at !== null;
  const notes: string[] = [];
  let r: number | null = null;
  if (filled && entry !== null && stop !== null && qty > 0) {
    const risk = Math.abs(entry - stop) * qty;
    if (risk > 0 && pnl !== null) r = pnl / risk;
    else if (risk > 0 && exit !== null) r = ((t.side === 'long' ? exit - entry : entry - exit) * qty) / risk;
    else notes.push('无盈亏与离场价,R 算不出');
  } else if (filled) notes.push(stop === null ? (t.market === 'spot' ? '现货,无止损(可选)' : '没有止损价,R 算不出') : '数量缺失');
  const optionalStop = t.market === 'spot' && t.stop_price === null;
  const protectionOk = optionalStop || !filled || t.protection_client_order_ids.length > 0;
  if (filled && !protectionOk) notes.push('入场后没有挂过保护腿');
  if (filled && t.attention) notes.push(`结束时仍带 attention=${t.attention}`);
  const outcome: TradeCard['outcome'] = !filled ? 'unfilled' : r === null && pnl === null ? 'unknown' : (r ?? pnl!) > 0.05 ? 'win' : (r ?? pnl!) < -0.05 ? 'loss' : 'scratch';
  return {
    thread_id: t.id,
    symbol: t.symbol,
    side: t.side,
    source: t.source,
    strategy_id: t.strategy_id ?? null,
    status: t.status,
    filled,
    entry_price: entry,
    exit_price: exit,
    stop_price: stop,
    qty,
    realized_pnl: pnl,
    r_multiple: r === null ? null : Math.round(r * 100) / 100,
    hold_ms: filled && t.closed_at && t.opened_at ? t.closed_at - t.opened_at : null,
    ended_at: t.closed_at ?? t.updated_at,
    exit_class: classifyExit(t),
    close_reason: t.close_reason,
    outcome,
    protection_ok: protectionOk,
    episode_count: episodeCount,
    notes,
  };
}

/** 批次里只用成交过的、结果已知的交易;取消/未成交单列,不混进胜率。 */
export function eligibleForBatch(c: TradeCard): boolean {
  return c.filled && c.outcome !== 'unknown';
}

// ---------------------------------------------------------------- ② 批次触发(纯代码)

export interface BatchDecision {
  run: boolean;
  reason: string;
}

export function shouldRunBatch(inp: { eligible_new: number; last_batch_at: number | null; oldest_pending_at?: number | null; runs_today: number; paused: boolean; now: number }): BatchDecision {
  if (inp.paused) return { run: false, reason: '已暂停:不调模型' };
  if (inp.runs_today >= BATCH_MAX_PER_DAY) return { run: false, reason: `今日已跑 ${inp.runs_today}/${BATCH_MAX_PER_DAY} 次` };
  if (inp.eligible_new <= 0) return { run: false, reason: '没有新的合格平仓' };
  if (inp.eligible_new >= BATCH_MIN_THREADS) return { run: true, reason: `累计 ${inp.eligible_new} 笔新平仓 ≥ ${BATCH_MIN_THREADS}` };
  // 24h 时钟从「上次批次」起算;从没跑过批次就从最早那张待复盘卡起算(不是从 0 起算——否则第一笔平仓就会立刻花钱)。
  const since = inp.last_batch_at ?? inp.oldest_pending_at ?? inp.now;
  if (inp.now - since >= BATCH_STALE_MS) return { run: true, reason: `距${inp.last_batch_at === null ? '最早待复盘' : '上次批次'} ≥ 24h,有 ${inp.eligible_new} 笔新平仓(样本少,只许观察/待检假设)` };
  return { run: false, reason: `只有 ${inp.eligible_new} 笔新平仓(< ${BATCH_MIN_THREADS}),${inp.last_batch_at === null ? '最早待复盘' : '上次批次'} ${Math.round((inp.now - since) / 3_600_000)}h 前` };
}

// ---------------------------------------------------------------- ③ 提炼教训(模型 + 闸)

export interface LessonCandidate {
  observation: string;
  mechanism: string;
  falsifier: string;
  confidence: number;
  symbol: string | null;
  regime: 'bull' | 'bear' | 'range' | 'volatile' | null;
  tags: string[];
  source_refs: string[];
}

export function batchKey(cards: readonly TradeCard[]): string {
  const ids = cards.map((c) => `${c.thread_id}:${c.status}`).sort().join(',');
  return createHash('sha256').update(`${REVIEWER_PROMPT_VERSION}|${ids}`).digest('hex').slice(0, 16);
}

export function reflectPromptV2(cards: readonly TradeCard[], existingLessons: readonly string[], smallSample: boolean): { system: string; user: string } {
  const system = [
    '你是 trade-gate 的复盘模块(Reviewer)。你读一批已结束交易的**代码算好的复盘卡**,提炼最多 2 条可证伪的"教训"。',
    '每条必须有四段:observation(从这批卡里直接看得出的规律,一句话)、mechanism(为什么会这样,一句话)、falsifier(什么样的后续证据会推翻它,一句话)、source_refs(引用下面卡片的线程 id,至少 1 个,只能引用本批)。',
    '硬规则:不写任何具体价位或盈亏金额(只许引用卡上给的 R 倍数、持有时长、次数);不写通用常识;不重复已有教训;不给任何参数数字建议(参数改动归 Strategy Lab);symbol 只能是本批出现过的或 null;regime 只能是 bull/bear/range/volatile 或 null。',
    smallSample ? '**本批样本少于 5 笔:只许输出「待检假设」级别的教训(confidence ≤ 0.4),或者输出空数组。**' : 'confidence 0.3–0.8;没有值得记的规律就输出空数组。',
    '只输出 JSON 数组:[{"observation":"…","mechanism":"…","falsifier":"…","confidence":0.5,"symbol":"BTCUSDT"|null,"regime":"bear"|null,"tags":["…"],"source_refs":["thr-…"]}]',
  ].join('\n');
  const lines = ['## 复盘卡(代码计算)'];
  for (const c of cards) {
    lines.push(`- ${c.thread_id} ${c.symbol} ${c.side} 来源 ${c.source}${c.strategy_id ? ` 策略 ${c.strategy_id}` : ''} 结果 ${c.outcome} R ${c.r_multiple ?? 'n/a'} 离场 ${c.exit_class}${c.hold_ms !== null ? ` 持有 ${Math.round(c.hold_ms / 60_000)} 分钟` : ''} 复查次数 ${c.episode_count}${c.protection_ok ? '' : ' 保护缺失'}${c.notes.length ? ` 备注:${c.notes.join(';')}` : ''}`);
  }
  const wins = cards.filter((c) => c.outcome === 'win').length;
  const losses = cards.filter((c) => c.outcome === 'loss').length;
  const rs = cards.map((c) => c.r_multiple).filter((r): r is number => r !== null);
  lines.push('', `## 汇总:${cards.length} 笔,胜 ${wins} 负 ${losses},平均 R ${rs.length ? (rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(2) : 'n/a'}`);
  lines.push('', '## 已有教训(不要重复)');
  for (const e of existingLessons) lines.push(`- ${e}`);
  lines.push('', '只输出 JSON 数组。');
  return { system, user: lines.join('\n') };
}

/** 正文里的「价位」:≥ 3 位的整数,或带小数点的数字(允许 R 倍数那种 1 位小数 ≤ 2 位整数,如 1.5R / 0.8)。 */
const PRICE_LIKE = /(?<![\d.])(\d{3,}(?:\.\d+)?|\d{1,2}\.\d{2,})(?![\d.]*\s*(?:分钟|次|笔|%|R\b))/;
const REGIMES = new Set(['bull', 'bear', 'range', 'volatile']);

export function parseLessons(text: string, cards: readonly TradeCard[], smallSample: boolean): { kept: LessonCandidate[]; dropped: { raw: unknown; reason: string }[] } {
  const kept: LessonCandidate[] = [];
  const dropped: { raw: unknown; reason: string }[] = [];
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return { kept, dropped: [{ raw: text.slice(0, 200), reason: '不是 JSON 数组' }] };
  let arr: unknown;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { kept, dropped: [{ raw: text.slice(0, 200), reason: 'JSON 解析失败' }] };
  }
  if (!Array.isArray(arr)) return { kept, dropped: [{ raw: arr, reason: '不是数组' }] };
  const ids = new Set(cards.map((c) => c.thread_id));
  const symbols = new Set(cards.map((c) => c.symbol));
  for (const x of arr) {
    if (kept.length >= LESSONS_PER_BATCH) {
      dropped.push({ raw: x, reason: `超过每轮 ${LESSONS_PER_BATCH} 条` });
      continue;
    }
    if (!x || typeof x !== 'object') {
      dropped.push({ raw: x, reason: '不是对象' });
      continue;
    }
    const o = x as Record<string, unknown>;
    const str = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
    const observation = str('observation');
    const mechanism = str('mechanism');
    const falsifier = str('falsifier');
    if (!observation || !mechanism || !falsifier) {
      dropped.push({ raw: x, reason: 'observation/mechanism/falsifier 缺一' });
      continue;
    }
    const refs = Array.isArray(o['source_refs']) ? (o['source_refs'] as unknown[]).filter((r): r is string => typeof r === 'string' && ids.has(r)) : [];
    if (!refs.length) {
      dropped.push({ raw: x, reason: 'source_refs 为空或不属于本批' });
      continue;
    }
    const joined = `${observation} ${mechanism} ${falsifier}`;
    const m = PRICE_LIKE.exec(joined);
    if (m) {
      dropped.push({ raw: x, reason: `正文含价位/金额样数字 ${m[0]}` });
      continue;
    }
    if (joined.length > 400) {
      dropped.push({ raw: x, reason: '太长(> 400 字)' });
      continue;
    }
    const symbol = typeof o['symbol'] === 'string' && symbols.has(o['symbol'].toUpperCase()) ? o['symbol'].toUpperCase() : null;
    const regime = typeof o['regime'] === 'string' && REGIMES.has(o['regime']) ? (o['regime'] as LessonCandidate['regime']) : null;
    let confidence = typeof o['confidence'] === 'number' && Number.isFinite(o['confidence']) ? Math.min(0.8, Math.max(0.3, o['confidence'])) : 0.4;
    if (smallSample) confidence = Math.min(confidence, 0.4);
    const tags = Array.isArray(o['tags']) ? (o['tags'] as unknown[]).filter((t): t is string => typeof t === 'string' && /^[a-z0-9_:-]{1,24}$/.test(t)).slice(0, 6) : [];
    kept.push({ observation, mechanism, falsifier, confidence, symbol, regime, tags, source_refs: refs });
  }
  return { kept, dropped };
}

/** 教训 → 记忆提案(proposed,等人批)。正文把四段拼起来,tags 带 reviewer / 批次 / eval 状态。 */
export function lessonToProposal(l: LessonCandidate, batch: string, now: number): ProposeInput {
  return {
    kind: 'lesson',
    content: `${l.observation} 机制:${l.mechanism} 推翻条件:${l.falsifier}`,
    confidence: l.confidence,
    scope: { symbol: l.symbol, regime: l.regime },
    tags: ['reviewer', `batch:${batch}`, 'eval:pending', ...l.tags],
    source_refs: l.source_refs,
    proposed_by: 'agent',
    proposed_by_role: 'reviewer',
    now,
  };
}

export interface ReflectResult {
  kept: LessonCandidate[];
  dropped: { raw: unknown; reason: string }[];
  raw: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  model: string;
}

export async function reflectBatch(brain: Brain, cards: readonly TradeCard[], existingLessons: readonly string[], opts: { timeoutMs?: number } = {}): Promise<ReflectResult> {
  const smallSample = cards.length < BATCH_MIN_THREADS;
  const { system, user } = reflectPromptV2(cards, existingLessons, smallSample);
  const r = await brain.complete(system, user, { timeoutMs: opts.timeoutMs ?? 90_000 });
  const parsed = parseLessons(r.text, cards, smallSample);
  return { ...parsed, raw: r.text, input_tokens: r.input_tokens, output_tokens: r.output_tokens, latency_ms: r.latency_ms, model: r.model };
}
