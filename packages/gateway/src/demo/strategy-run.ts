/** Strategy Run (§9.51):独立收盘调度、持久化幂等、代码候选/退出。I/O 全由 deps 注入。 */
import { judgeWithBars, type JudgeRuntime } from './research/judge/index.js';
import { candidateSnapshot, judgeDecimal } from './research/judge/candidate.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BacktestReport, ResearchBar, StrategyIR } from '@trade-gate/contracts';
import { reportBars } from './research/backtest-report.js';
import { atr as researchAtr } from './research/primitives/registry.js';
import type { FrozenModelProfile, JudgeCandidateSnapshot, JudgeResult } from './research/judge/types.js';
import { needsMicrostructure } from './research/judge/microstructure.js';
import type { GateResult, Kline, StrategyThread } from './types.js';
import type { ReasonLayer } from './execution-policy.js';
import { isOpen } from './threads.js';
import { researchContext, toResearchBars, SYNTH_POLICY } from './strategy-candidate.js';
import { viewBars } from './research/engine.js';
import { irExit, irHistoryBars, timeframeMillis } from './research/strategy.js';
import { generateRunCandidate, runScreenRows, runHistoryBars, type RunCandidate } from './strategy-run-orders.js';
import { orderManager, resolveOrder } from './research/orders/intents.js';
import { newSignalAction, tighterStop } from './research/orders/shared.js';
import { volTargetOf } from './research/primitives/sizing.js';
import { orderGateFor } from './research/order-gate.js';
import { q, decimal } from './research/primitives.js';
import type { Position } from './research/ledger.js';
import { BINDING_LEVERAGE_CAP } from './research/strategies/compile-binding.js';
import { onStrategyArchived, type StrategyService } from './research/strategies/service.js';
import type { PublishEvent } from './asp-agent/publisher.js';
import { JEV_SHADOW_MAX_INFLIGHT, JudgeLiveLedger, gateRecord, memoMicro, runJevJudge, runShadowJudge, type JevShadowFactory, type JevVerdict, type JudgeLiveRecord } from './judge-live.js';
import { DEFAULT_EXECUTION_THRESHOLDS, blendedTarget, codeFromText, policyFit, policyFitAdvice, researchThresholds, thresholdsText, type ExecutionThresholds, type GeometrySample } from './execution-policy.js';

/** slow_ir 护栏:IR 是同步纯计算,按本进程 CPU 时间计(机器负载高时墙钟会被别的进程拉长,不能当成 IR 自己慢);
 *  另设墙钟硬上限防事件循环被长时间占住。测试可注入 deps.clock。 */
const IR_CPU_BUDGET_MS = 200, IR_WALL_CEILING_MS = 2000;
const irCpuClock = (): number => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };

/**
 * 判断层(§9.56):auto = 直接做;agent = LLM 判断 agent 过滤;jev = Jev 判断作真门(无 IR judge 块时);signal_only = 只发信号。
 * confirm(每笔问我)已下线:新建/修改不再接受,已存在的 confirm 运行照旧能跑(不迁移)。
 */
export type StrategyRunMode = 'auto' | 'agent' | 'jev' | 'confirm' | 'signal_only';
/** 新建/修改运行时可选的模式(confirm 不在内)。 */
export const RUN_MODES_WRITABLE: StrategyRunMode[] = ['auto', 'agent', 'jev', 'signal_only'];
/** jev 模式等 Jev 回答最多 30 秒,超时按跳过。judgeCandidate 对每道题有自己的超时,这里管的是读盘口数据之类的其它等待。 */
export const JEV_GATE_TIMEOUT_MS = 30_000;
export type StrategyRunStatus = 'running' | 'paused' | 'stopped' | 'error';
export type SymbolsSource = { kind: 'fixed' } | { kind: 'radar'; tier: 'short' | 'swing' | 'weekly'; top_n: number };
export interface StrategyRun {
  id: string; strategy_id: string; strategy_name: string; version: number; latest_version: number;
  ir_hash: string; timeframe: string; mode: StrategyRunMode; market: 'spot' | 'perp'; direction: 'long' | 'short' | 'both'; leverage: number;
  symbols: string[]; risk_pct: number; max_open: number; publish_asp: boolean; status: StrategyRunStatus; error: string | null;
  symbols_source?: SymbolsSource;
  /** Jev 影子判断开关(默认开;false = 不对无 judge 块的候选做影子判断)。只影响记录,不影响下单。 */
  jev_shadow?: boolean;
  execution: { backend: 'paper' | 'okx' | 'binance'; profile: 'demo' | 'live' | null; label: string };
  created_at: number; updated_at: number; last_scan_at: number | null; next_scan_at: number | null;
  stats: { scans: number; candidates: number; orders: number; pending_approval: number; skipped: number; rejected: number; open_threads: number; closed: number; realized_r: number | null; published: number; today_orders: number };
}
export interface StrategyRunEvent {
  id: string; run_id: string; at: number;
  kind: 'scan' | 'candidate' | 'agent_follow' | 'agent_skip' | 'skip' | 'order_opened' | 'order_pending' | 'order_rejected' | 'exit' | 'stop_moved' | 'published' | 'error' | 'status';
  symbol: string | null; message: string; data: Record<string, unknown> | null;
}
export interface StrategyRunPreflight {
  strategy_id: string; version: number; timeframe: string; deployable: boolean;
  sizing_mode: 'fixed_risk' | 'vol_target';
  blockers: { code: string; message: string }[]; warnings: { code: string; message: string }[];
  defaults: { mode: StrategyRunMode; market: 'spot' | 'perp'; leverage: number; symbols: string[]; symbols_source: SymbolsSource; risk_pct: number; max_open: number; publish_asp: boolean };
  watchlist: string[]; execution: StrategyRun['execution']; requires_live_confirm: boolean;
  asp: { identity: boolean; active: boolean; publisher_enabled: boolean }; existing_run: StrategyRun | null;
}
export interface RunEnvironment {
  execution: StrategyRun['execution']; execution_key: string;
  watchlist: string[]; risk_pct: number; leverage_cap: number;
  asp: StrategyRunPreflight['asp'] & { id: string | null };
  /** §9.56 执行层阈值(workflow);预检拿它核对回测/历史候选。不给 = 执行层缺省。 */
  execution_thresholds?: ExecutionThresholds;
}
export interface RunOpenResult { outcome: string; reason: string; thread_id?: string | null; /** §9.56 结构化拒绝(执行层闸等):写进 order_rejected 事件 data */ layer?: ReasonLayer; code?: string; gates?: GateResult[] }
export interface RunFilterResult { decision: 'follow' | 'skip'; reason: string }
export interface RunPositionState {
  fee_rate?: string; initial_stop?: string; first_tp_filled_at?: number;
  /** 已成交附加腿 + 仍在途(含 unknown/待批)附加腿；到期确认撤完才能释放名额。 */
  adds?: number; base_leg_margin?: string;
}
interface RunManagementState {
  initial_stop: string; high_water: string; low_water: string; fee_rate: string; as_of: number;
}
const freezeCandidate = (c: RunCandidate) => ({ ...c, entry_ref: judgeDecimal(c.entry_ref), stop: judgeDecimal(c.stop), target: c.target === null ? null : judgeDecimal(c.target), invalidation: judgeDecimal(c.invalidation ?? c.stop), take_profits: c.take_profits?.map(t => ({ ...t, price: judgeDecimal(t.price) })) });
const thawCandidate = (c: ReturnType<typeof freezeCandidate>): RunCandidate => ({ ...c, entry_ref: Number(c.entry_ref), stop: Number(c.stop), target: c.target === null ? null : Number(c.target), invalidation: Number(c.invalidation), take_profits: c.take_profits?.map(t => ({ ...t, price: Number(t.price) })) });
interface RunTransition {
  run_id: string; version: number; thread_id: string; action: 'replace' | 'flip'; phase: 'waiting' | 'opening';
  execution_key: string; mode: StrategyRunMode; candidate: ReturnType<typeof freezeCandidate>; new_thread_id?: string | null;
}
export interface StrategyRunDeps {
  db: DatabaseSync; strategies: StrategyService; environment: () => RunEnvironment;
  blocked: () => string | null;
  bars: (symbol: string, tf: string, limit: number, end: number, market: StrategyRun['market']) => Promise<Kline[]>;
  threads: (run_id: string) => StrategyThread[];
  open: (run: StrategyRun, candidate: RunCandidate, approval: 'auto' | 'manual') => Promise<RunOpenResult>;
  /** 使用 sizeRunOrder 后走原组合经理/风控；未接线时拒绝 vol_target，不能退回 fixed_risk。 */
  openSized?: StrategyRunDeps['open'];
  /** 只读核对候选与原 CID/线程：null/unknown 保留；仅确定已接受/明确拒绝才能解锁，查不到不等于拒绝。 */
  reconcileOpen?: (run: StrategyRun, candidate_id: string, thread_id: string | null) => Promise<RunOpenResult | null>;
  close: (thread: StrategyThread, reason: string) => Promise<void>;
  cancel?: (thread: StrategyThread, reason: string) => Promise<{ ok: boolean; detail: string }>;
  /** 必须按 thread+目标止损幂等，CID 调用前落库；unknown 先对账，ok 只表示已确认保护。 */
  moveStop?: (thread: StrategyThread, new_stop: string, reason: string) => Promise<{ ok: boolean; detail: string }>;
  positionState?: (thread: StrategyThread) => RunPositionState;
  /** 原仓位内新增等额腿，保留旧保护/期限；最终重查 adds/max_adds、审批、组合与风控，不创建独立仓。 */
  add?: (run: StrategyRun, thread: StrategyThread, candidate: RunCandidate, approval: 'auto' | 'manual', leg: { base_leg_margin: string; max_adds: number }) => Promise<RunOpenResult>;
  /** confirm 模式的完整反手审批(先批整项，再确认平仓，再开新腿)，不能先自动平仓再等审批。 */
  flip?: (run: StrategyRun, thread: StrategyThread, candidate: RunCandidate, approval: 'manual') => Promise<RunOpenResult>;
  radarSymbols?: (tier: 'short' | 'swing' | 'weekly', top_n: number) => Promise<string[]>;
  /** 预检用:IR judge 钉住的决策连接此刻是否可用;返回不可用原因(null = 可用) */
  judgeAvailable?: (ir: StrategyIR) => string | null;
  /** IR judge 的依赖，所有模式共用；无配置时 fail closed。 */
  microstructure?: import('./research/judge/microstructure.js').MicrostructureSource;
  judge?: (run: StrategyRun, ir: StrategyIR) => JudgeRuntime | null;
  /** Jev 影子判断(docs/design/jev-live-2026-09-25.md):IR 无 judge 块的候选只记录不挡单;不接 = 不做影子判断。 */
  jevShadow?: JevShadowFactory;
  filter: (run: StrategyRun, candidate: RunCandidate, ir: StrategyIR) => Promise<RunFilterResult>;
  publish: (event: PublishEvent) => Promise<unknown>;
  emit: (event: string, payload: unknown) => void;
  /** 与常规开/平仓、模型调用排同一队列;测试可直接执行。 */
  serial?: <T>(fn: () => Promise<T>) => Promise<T>;
  now?: () => number; clock?: () => number;
  generate?: typeof generateRunCandidate;
  realizedR?: (t: StrategyThread) => number | null;
  pendingApproval?: (t: StrategyThread) => boolean;
}
const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const emptyStats = (): StrategyRun['stats'] => ({ scans: 0, candidates: 0, orders: 0, pending_approval: 0, skipped: 0, rejected: 0, open_threads: 0, closed: 0, realized_r: null, published: 0, today_orders: 0 });
export const runOrigin = (id: string) => `strategy_run:${id}`;
export const isStrategyRunThread = (t: StrategyThread) => t.origin?.startsWith('strategy_run:') === true;
export const nextRunScan = (now: number, tf: string) => (Math.floor((now - 5000) / timeframeMillis(tf)) + 1) * timeframeMillis(tf) + 5000;
const live = (e: StrategyRun['execution']) => e.backend !== 'paper' && e.profile !== 'demo';
const failure = (message: string, code = 'invalid_request', status = 400): never => { throw Object.assign(new Error(message), { code, status }); };
/** §9.56 事件 data 的结构化原因:layer + code;认不出的按调用方给的层、取「code:说明」的前缀。 */
export const reasonData = (reason: string, fallback: ReasonLayer = 'strategy'): { layer: ReasonLayer; code: string } => {
  const c = codeFromText(reason);
  return c ?? { layer: fallback, code: (String(reason).split(':')[0] || 'unknown').slice(0, 60) };
};
export function parseSymbolsSource(raw: unknown): SymbolsSource {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return failure('symbols_source 必须是对象');
  const x = raw as Record<string, unknown>;
  if (x['kind'] === 'fixed' && Object.keys(x).length === 1) return { kind: 'fixed' };
  if (x['kind'] === 'radar' && Object.keys(x).every(k => ['kind', 'tier', 'top_n'].includes(k)) && ['short', 'swing', 'weekly'].includes(String(x['tier'])) && Number.isInteger(x['top_n']) && Number(x['top_n']) >= 1 && Number(x['top_n']) <= 30)
    return { kind: 'radar', tier: x['tier'] as 'short' | 'swing' | 'weekly', top_n: Number(x['top_n']) };
  return failure('symbols_source 需 fixed 或 radar(tier=short|swing|weekly, top_n=1–30 整数)');
}

export class StrategyRunStore {
  constructor(readonly db: DatabaseSync) {}
  get(id: string): StrategyRun | null { const r = this.db.prepare('SELECT json FROM strategy_runs WHERE id=?').get(id); return r ? JSON.parse(String(r['json'])) as StrategyRun : null; }
  list(): StrategyRun[] { return this.db.prepare('SELECT json FROM strategy_runs ORDER BY updated_at DESC,id').all().map(r => JSON.parse(String(r['json'])) as StrategyRun); }
  require(id: string): StrategyRun { return this.get(id) ?? failure('运行不存在', 'run_not_found', 404); }
  ir(id: string): StrategyIR { return JSON.parse(String(this.db.prepare('SELECT ir_json FROM strategy_runs WHERE id=?').get(id)?.['ir_json'])) as StrategyIR; }
  key(id: string): string { return String(this.db.prepare('SELECT execution_key FROM strategy_runs WHERE id=?').get(id)?.['execution_key']); }
  save(run: StrategyRun, ir?: StrategyIR, key?: string): void {
    if (ir && key) this.db.prepare('INSERT INTO strategy_runs VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,json=excluded.json,ir_json=excluded.ir_json,execution_key=excluded.execution_key').run(run.id, run.strategy_id, run.status, run.updated_at, JSON.stringify(run), JSON.stringify(ir), key);
    else this.db.prepare('UPDATE strategy_runs SET status=?,updated_at=?,json=? WHERE id=?').run(run.status, run.updated_at, JSON.stringify(run), run.id);
  }
  claim(id: string, symbol: string, as_of: number): boolean { return Number(this.db.prepare('INSERT OR IGNORE INTO strategy_run_seen VALUES (?,?,?)').run(id, symbol, as_of).changes) === 1; }
  /** 临时失败(网络/限流/标记价取不到)时放回这根 K 线,下个周期重试;只用于确定没发出任何订单的情况 */
  release(id: string, symbol: string, as_of: number): void { this.db.prepare('DELETE FROM strategy_run_seen WHERE run_id=? AND symbol=? AND as_of=?').run(id, symbol, as_of); }
  seen(id: string, symbol: string, as_of: number): boolean { return !!this.db.prepare('SELECT 1 FROM strategy_run_seen WHERE run_id=? AND symbol=? AND as_of=?').get(id, symbol, as_of); }
  management(id: string): RunManagementState | null {
    const row = this.db.prepare('SELECT value FROM demo_kv WHERE key=?').get(`strategy_run:management:${id}`);
    return row ? JSON.parse(String(row['value'])) as RunManagementState : null;
  }
  saveManagement(id: string, state: RunManagementState, now: number): void {
    this.db.prepare('INSERT INTO demo_kv VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(`strategy_run:management:${id}`, JSON.stringify(state), now);
  }
  transitions(id: string): RunTransition[] {
    return this.db.prepare('SELECT value FROM demo_kv WHERE key GLOB ?').all(`strategy_run:transition:${id}:*`).map(row => JSON.parse(String(row['value'])) as RunTransition);
  }
  saveTransition(t: RunTransition, now: number): void {
    this.db.prepare('INSERT INTO demo_kv VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(`strategy_run:transition:${t.run_id}:${t.candidate.symbol}`, JSON.stringify(t), now);
  }
  clearTransition(id: string, symbol: string): void { this.db.prepare('DELETE FROM demo_kv WHERE key=?').run(`strategy_run:transition:${id}:${symbol}`); }
  append(e: StrategyRunEvent): void { this.db.prepare('INSERT INTO strategy_run_events(id,run_id,at,kind,json) VALUES (?,?,?,?,?)').run(e.id, e.run_id, e.at, e.kind, JSON.stringify(e)); }
  sequence(): number { return Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM strategy_run_events').get()?.['n']); }
  /**
   * view() 的事件统计:按 kind 计数(走 (run_id, kind, at) 覆盖索引),只读 order_opened 行的 at/thread_id。
   * 与「since(id,0) 全量读出再逐条数」同口径:kind 列与 JSON 里的 kind 同源写入(append / 平仓 upsert 只改 json 不改 kind)。
   */
  eventStats(id: string): { kinds: Map<string, number>; opened: { at: number; thread_id: unknown }[] } {
    const kinds = new Map<string, number>();
    for (const r of this.db.prepare('SELECT kind, COUNT(*) AS n FROM strategy_run_events WHERE run_id=? GROUP BY kind').all(id)) kinds.set(String(r['kind']), Number(r['n']));
    const opened = this.db.prepare("SELECT json_extract(json,'$.at') AS at, json_extract(json,'$.data.thread_id') AS thread_id FROM strategy_run_events WHERE run_id=? AND kind='order_opened'").all(id)
      .map(r => ({ at: Number(r['at']), thread_id: r['thread_id'] ?? undefined }));
    return { kinds, opened };
  }
  since(id: string, seq: number): StrategyRunEvent[] { return this.db.prepare('SELECT json FROM strategy_run_events WHERE run_id=? AND seq>? ORDER BY seq').all(id, seq).map(r => JSON.parse(String(r['json'])) as StrategyRunEvent); }
  events(id: string, limit = 50, cursor?: string | null): { rows: StrategyRunEvent[]; next_cursor: string | null } {
    this.require(id);
    if (cursor && !/^\d+$/.test(cursor)) failure('无效的事件游标');
    const n = Math.min(500, Math.max(1, Math.floor(limit) || 50));
    const rows = this.db.prepare('SELECT seq,json FROM strategy_run_events WHERE run_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(id, cursor ? Number(cursor) : Number.MAX_SAFE_INTEGER, n + 1);
    return { rows: rows.slice(0, n).map(r => JSON.parse(String(r['json'])) as StrategyRunEvent), next_cursor: rows.length > n ? String(rows[n - 1]!['seq']) : null };
  }
}

/** 严格限制模型输出:不能夹带经济字段,异常由调用方统一 skip。 */
export function parseRunFilter(raw: unknown): RunFilterResult {
  const o = typeof raw === 'string' ? JSON.parse(raw) as Record<string, unknown> : raw as Record<string, unknown>;
  if (!o || typeof o !== 'object' || !['follow', 'skip'].includes(String(o['decision'])) || typeof o['reason'] !== 'string' || !o['reason'].trim() || Object.keys(o).some(k => !['decision', 'reason'].includes(k))) throw new Error('模型返回不是 {decision:follow|skip,reason}');
  return { decision: o['decision'] as RunFilterResult['decision'], reason: o['reason'].slice(0, 1000) };
}

/** 与订单核/旧 irExit 同源；入场所在根算第 1 根，只使用 as_of 前已收盘数据。 */
export function runExit(ir: StrategyIR, thread: StrategyThread, klines: Kline[], as_of: number,
  state: Partial<RunManagementState> & Pick<RunPositionState, 'first_tp_filled_at'> = {}): ReturnType<typeof irExit> {
  const ms = timeframeMillis(thread.timeframe), bars = toResearchBars(klines, ms, as_of);
  const ctx = researchContext(bars, viewBars(ir, SYNTH_POLICY, ms), ms);
  const entry_at = Math.floor((thread.opened_at ?? thread.created_at) / ms) * ms;
  const entry_price = Number(thread.filled_avg_price ?? thread.entry.price), stop = Number(thread.stop_price);
  const initial_stop = Number(state.initial_stop ?? thread.holding_plan?.hard_stop ?? thread.stop_price);
  const initial_distance = Math.abs(entry_price - initial_stop), bars_held = Math.max(0, Math.floor((as_of - entry_at) / ms));
  const held = bars.filter(b => b.open_time >= entry_at);
  const high_water = Math.max(Number(state.high_water ?? '-Infinity'), ...held.map(b => Number(b.high)));
  const low_water = Math.min(Number(state.low_water ?? 'Infinity'), ...held.map(b => Number(b.low)));
  const fee_rate = state.fee_rate ?? (thread.market === 'perp' ? '0.0005' : '0.001');
  ctx.position = { entry_at, entry_price, initial_distance, bars_held, high_water };
  ctx.side = thread.side; ctx.fee_rate = Number(fee_rate);
  if (ir.order) {
    const managed = orderManager(ir, bars, ms, { fee_rate, view: viewBars(ir, SYNTH_POLICY, ms) })({ plan_id: thread.id, side: thread.side, bar_index: bars.length - 1, entry_at, avg_entry: entry_price, initial_stop, initial_distance, bars_held, high_water, low_water, stop });
    const order = resolveOrder(ir, ms, orderGateFor(ir));
    let next = stop, source = managed?.stop_source;
    // simulateOrders 的首档保本在 manager 之前收紧；只吃确认成交时间，不按触价猜成交。
    if (order?.breakeven_after_tp && state.first_tp_filled_at !== undefined && state.first_tp_filled_at < as_of && tighterStop(thread.side, next, entry_price)) { next = entry_price; source = 'breakeven'; }
    if (managed?.stop !== undefined && tighterStop(thread.side, next, managed.stop)) { next = managed.stop; source = managed.stop_source; }
    const quantized = q(next.toFixed(8));
    return { stop: tighterStop(thread.side, stop, Number(decimal(quantized))) ? quantized : null, stop_reason: source,
      reason: managed?.exit ?? (order?.max_holding_bars && bars_held >= order.max_holding_bars ? 'time' : null) };
  }
  const p: Position = { id: thread.id, candidate_id: thread.id, entry_at, entry_price: q(entry_price.toFixed(8)), qty: q(thread.qty), stop: q(stop.toFixed(8)), target: null, entry_fee: 0n, entry_notional: 0n, initial_risk: 0n, bars_held };
  return irExit(ir, ctx, p);
}

export const TRANSIENT_RETRY_MS = 30_000;
/** 临时性失败:网络断/重置/超时、HTTP 429/5xx、标记价取不到。这类失败下一轮重试,不把运行打成出错。 */
export function isTransient(message: string | null | undefined): boolean {
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|网络错误|network|timeout|超时|HTTP 429|HTTP 5\d\d|Too Many Requests|标记价不可用|账户快照质量|快照不完整|行情过期/i.test(String(message ?? ''));
}
export class StrategyRunner {
  readonly store: StrategyRunStore;
  private timer: ReturnType<typeof setInterval> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private ticking = false;
  private closed = false;
  private off: () => void;
  private now: () => number;
  /** 实盘 Jev 判断账本(影子 + 挡单),routes-judge-live.ts 读它。 */
  readonly judgeLedger: JudgeLiveLedger;
  private shadows = new Set<Promise<unknown>>();
  private shadowAbort = new AbortController();
  constructor(readonly deps: StrategyRunDeps) {
    this.store = new StrategyRunStore(deps.db); this.now = deps.now ?? Date.now; this.judgeLedger = new JudgeLiveLedger(deps.db, this.now);
    this.off = onStrategyArchived(id => this.archive(id));
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(() => this.deps.serial ? this.deps.serial(fn) : fn());
    this.chain = p.catch(() => {}); return p;
  }
  private update(r: StrategyRun): StrategyRun { r.updated_at = this.now(); this.store.save(r); const out = this.view(r); this.deps.emit('strategy_run.updated', out); return out; }
  event(r: StrategyRun, kind: StrategyRunEvent['kind'], message: string, symbol: string | null = null, data: Record<string, unknown> | null = null): StrategyRunEvent {
    const e = { id: newId('runev'), run_id: r.id, at: this.now(), kind, symbol, message, data };
    this.store.append(e); this.deps.emit('strategy_run.event', e); return e;
  }
  private view(r: StrategyRun): StrategyRun {
    // 统计只要按 kind 的计数和 order_opened 的 at/thread_id:SQL 聚合,不再每次把整段事件历史读出来逐条 JSON.parse。
    const { kinds, opened } = this.store.eventStats(r.id), ts = this.deps.threads(r.id), today = new Date(this.now()); today.setHours(0, 0, 0, 0);
    const stats = emptyStats(), n = (k: StrategyRunEvent['kind']) => kinds.get(k) ?? 0;
    stats.scans = n('scan');
    stats.candidates = n('candidate');
    stats.orders = opened.length; stats.today_orders = opened.filter(e => e.at >= today.getTime()).length;
    stats.skipped = n('skip') + n('agent_skip');
    stats.rejected = n('order_rejected');
    stats.published = n('published');
    // 人工审批通过后也算订单,按线程去重;closed 的结算仍可继续补齐 R。
    const recorded = new Set(opened.map(e => e.thread_id));
    for (const t of ts) if (t.opened_at && !recorded.has(t.id)) { stats.orders++; if (t.opened_at >= today.getTime()) stats.today_orders++; }
    stats.open_threads = ts.filter(isOpen).length;
    stats.pending_approval = ts.filter(t => isOpen(t) && this.deps.pendingApproval?.(t)).length;
    stats.closed = ts.filter(t => t.status === 'closed').length;
    const rs = ts.filter(t => t.status === 'closed').map(t => this.deps.realizedR?.(t) ?? null).filter((x): x is number => x !== null && Number.isFinite(x));
    stats.realized_r = rs.length ? rs.reduce((a, b) => a + b, 0) : null;
    return { ...r, symbols_source: r.symbols_source ?? { kind: 'fixed' }, jev_shadow: r.jev_shadow !== false, latest_version: this.deps.strategies.store.get(r.strategy_id)?.current_version ?? r.latest_version, stats };
  }
  list(): StrategyRun[] { return this.store.list().map(r => this.view(r)); }
  get(id: string): StrategyRun { return this.view(this.store.require(id)); }
  /** 成交/平仓/补结算均刷新运行统计;一条线程一条结算行,未知 R 保留 null。 */
  threadChanged(t: StrategyThread): void {
    if (!isStrategyRunThread(t)) return;
    const r = this.store.get(t.origin!.slice('strategy_run:'.length)); if (!r) return;
    if (t.status === 'canceled' && t.entry_expires_at && this.now() >= t.entry_expires_at && this.store.claim(r.id, `expiry:${t.id}`, t.entry_expires_at)) this.event(r, 'skip', '限价挂单已过期,已确认未成交入场单结束', t.symbol, { code: 'entry_expired', thread_id: t.id, as_of: t.entry_expires_at });
    // 09-26 stuck-entry:「已提交、结果未知」的入场单经复核判定未到交易所 → 本运行该币占位释放(没有重发)。
    if (t.status === 'canceled' && t.close_reason?.startsWith('entry_unknown_not_found') && this.store.claim(r.id, `entry_unknown:${t.id}`, t.closed_at ?? 0)) this.event(r, 'skip', `${t.symbol} 入场单按 clientOrderId 多次查无此单,复核无持仓/挂单,判定未到交易所,释放占位(未重发)`, t.symbol, { code: 'entry_unknown_not_found', thread_id: t.id, client_order_id: t.entry_client_order_id, lookup_misses: t.entry_lookup_misses });
    if (t.status === 'closed') {
      const id = `runev_closed_${t.id}`, value = this.deps.realizedR?.(t) ?? null;
      const prior = this.deps.db.prepare('SELECT json FROM strategy_run_events WHERE id=?').get(id);
      if (!prior || (JSON.parse(String(prior['json'])) as StrategyRunEvent).data?.['realized_r'] !== value) {
        const e: StrategyRunEvent = { id, run_id: r.id, at: t.closed_at ?? this.now(), kind: 'exit', symbol: t.symbol,
          message: `${t.symbol} 已平仓:${t.close_reason ?? '已结束'}${value === null ? '(等待完整结算)' : `,实现 ${value.toFixed(4)}R`}`,
          data: { thread_id: t.id, closed: true, realized_r: value, reason: t.close_reason, version: t.strategy_version ?? null } };
        this.deps.db.prepare('INSERT INTO strategy_run_events(id,run_id,at,kind,json) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(id, r.id, e.at, e.kind, JSON.stringify(e));
        this.deps.emit('strategy_run.event', e);
      }
    }
    this.update(r);
  }
  preflight(strategy_id: string, version?: number, market?: StrategyRun['market'], symbols_source: SymbolsSource = { kind: 'fixed' }): StrategyRunPreflight {
    symbols_source = parseSymbolsSource(symbols_source);
    const s = this.deps.strategies.store.require(strategy_id), v = version ?? s.current_version, env = this.deps.environment();
    const compiled = this.deps.strategies.binding(strategy_id, v ? String(v) : undefined, this.now());
    const ir = v ? this.deps.strategies.store.versionIR(strategy_id, v) : null;
    // binding 的 V0 能力闸仍服务旧影子路径;运行器只剔除这里已经真正接通的能力。
    const handled = new Set(['direction_not_long', 'universe_screen', 'v0_limit_entry', 'v0_multi_target']);
    const blockers = compiled.unmapped.filter(x => x.severity === 'block' && !handled.has(x.code)).map(({ code, message }) => ({ code, message: blockerMessage(code, message) }));
    const warnings = compiled.unmapped.filter(x => x.severity === 'warn' && !handled.has(x.code)).map(({ code, message }) => ({ code, message }));
    const block = (code: string, message: string) => { if (!blockers.some(x => x.code === code)) blockers.push({ code, message }); };
    if (symbols_source.kind === 'radar' && !this.deps.radarSymbols) block('radar_not_connected', '雷达币池依赖尚未接线');
    if (ir && volTargetOf(ir) && !this.deps.openSized) block('vol_target_not_connected', '波动率目标仓位执行尚未接线，不能退回固定风险仓位');
    if (ir?.judge && !this.deps.judge) block('judge_runtime_missing', '该策略需要钉住模型与判断账本，请配置 judge 依赖后运行');
    // 复审 Medium-6:只查依赖函数在不在不够 —— 钉住的决策连接不可用时运行会「看着在跑、永远全 skip」,预检就挡住
    else if (ir?.judge && this.deps.judgeAvailable) { const why = this.deps.judgeAvailable(ir); if (why) block('judge_unavailable', why); }
    if (!ir) block('no_ir', '这条策略还没有可执行规则,请先在研究台生成并保存一个规则版本');
    if (compiled.binding && !compiled.binding.deployable && !compiled.unmapped.some(x => x.severity === 'block')) block('binding_not_deployable', '规则暂时无法执行,请在研究台修正编译提示后保存新版本');
    if (s.status === 'archived') block('strategy_archived', '这条策略已归档,请先恢复策略再运行');
    const selectedMarket = market ?? ir?.order?.market ?? 'spot';
    const rawLeverage = ir?.order?.leverage ?? 1;
    if (selectedMarket === 'spot' && ir?.order && ir.order.direction !== 'long') block('direction_not_long', '这条策略要做空,请把市场选永续');
    if (['1m', '3m', '5m'].includes(s.timeframe)) block('horizon_scalp', '运行器不支持 1m/3m/5m,请用 15m 及以上周期');
    if (ir?.order?.direction === 'both' && !ir.order.short_signal?.length) block('short_signal_missing', '这条双向策略还没有做空触发条件,请在研究台补充做空条件或改为只做多');
    if (selectedMarket === 'spot' && rawLeverage > 1) block('spot_leverage', '这条策略要求杠杆,请把市场选永续,或在研究台改为无杠杆');
    if (ir?.entry.primitive !== 'next_open_market' && ir) block('entry_unsupported', '这条入场规则还不能执行,请在研究台改为收盘确认、下一根入场');
    if (ir && !ir.order && ir.exit.filter(x => ['fixed_r_target', 'structure_target', 'pivot_target'].includes(x.primitive)).length > 1) block('multi_target_unsupported', '止盈规则没有说明各档比例,请在研究台用 order.take_profits 配置目标和比例');
    if (ir) {
      try { const ms = timeframeMillis(s.timeframe); if (irHistoryBars(ir, ms) > viewBars(ir, SYNTH_POLICY, ms)) block('history_window_unsupported', '这条策略需要更多高周期历史,请缩短高周期指标回看长度后重试'); } catch { /* 编译器已给出周期提示 */ }
      const targets = resolveOrder(ir, timeframeMillis(s.timeframe), orderGateFor(ir))?.take_profits ?? [];
      if (targets.length > 1) {
        warnings.push({ code: 'targets_partial', message: '只挂最近第一档,按研究核归一后的 size_pct 部分止盈;其他档位不挂并记录在线程上,余仓由止损/信号离场/时间止损管理' });
        if (env.execution.backend === 'binance') block('partial_tp_backend', '当前执行通道不支持按数量挂止盈,请切换纸面或 OKX,或把策略改为单目标');
      }
      if (ir.universe?.screen) warnings.push({ code: 'screen_pool', message: '每根收盘用运行币池等权构造市场因子并筛选;币池变化会影响排名,历史不足时跳过' });
      if (ir.order) {
        const order = resolveOrder(ir, timeframeMillis(s.timeframe))!, missing: string[] = [];
        if (order.on_new_signal.unfilled === 'replace' && !this.deps.cancel) missing.push('未成交 replace 缺撤单接线');
        if (order.on_new_signal.filled === 'roll') missing.push('roll 无费结转尚未实现');
        // 复审 High-4:回测会加仓而实盘不加 → 结果必然对不上,挡住而不是只警告;confirm 反手只影响「每笔我确认」,保留警告
        if (order.on_new_signal.filled === 'add' && (!this.deps.add || !this.deps.positionState)) block('add_not_connected', '这条策略的同币新信号会加仓,运行器还没接加仓执行链;先改 IR 的 on_new_signal 或等接线后再运行');
        if (order.direction === 'both' && !this.deps.flip) missing.push('confirm 模式反手缺整项审批接线(auto/agent 已支持)');
        if (missing.length) warnings.push({ code: 'new_signal_policy', message: missing.join(';') });
      }
    }
    // 复审 High-4:移损是回测收益的一部分(吊灯线是账本里唯一不亏的持仓管理),没接通就跑 = 实盘与回测两套规则 → 挡住
    if (ir && ((!this.deps.moveStop && (ir.exit.some(x => ['chandelier_trail', 'breakeven_after_r', 'swing_structure_stop'].includes(x.primitive)) || ir.order?.breakeven_after_tp)) || (ir.order?.breakeven_after_tp && !this.deps.positionState))) block('trailing_not_connected', '这条策略靠追踪/保本/结构移损管仓,运行器的移损还没接通(缺 moveStop 或首档止盈成交状态);接通前不能运行');
    if (!this.deps.strategies.store.reports(strategy_id).some(r => r.version === v && r.completed)) warnings.push({ code: 'not_backtested', message: '这个版本还没有完成的回测报告' });
    // §9.56 回测/历史候选按当前执行层核对:实盘会被拒掉多少(与实盘开仓闸同一个判定)
    if (ir && v) {
      // 样本里的 ATR 是策略周期的,阈值按回测同一套折算(ATR 模式的倍数折到策略周期),这样和回测报告里冻结的快照能直接比
      const current = env.execution_thresholds ?? DEFAULT_EXECUTION_THRESHOLDS;
      const snapshot = researchThresholds(current, timeframeMillis(s.timeframe));
      // 样本检查保留模式和自定义百分比,缺 ATR 时仍按当前设置计算。
      const sampleThresholds = { ...current, min_stop_atr: snapshot.min_stop_atr };
      delete sampleThresholds.stop_floor_atr_tf;
      const fit = this.executionFit(strategy_id, v, sampleThresholds);
      for (const w of fit.warnings) warnings.push(w);
      if (fit.blocker) block(fit.blocker.code, fit.blocker.message);
    }
    if (!env.asp.identity) warnings.push({ code: 'asp_identity_missing', message: '尚未注册 ASP 身份,发布会跳过;请到信号市场 → 发布注册' });
    const cap = Math.min(BINDING_LEVERAGE_CAP, env.leverage_cap);
    if (selectedMarket === 'perp' && rawLeverage > cap) warnings.push({ code: 'leverage_capped', message: `杠杆按账户/工作流上限封顶为 ${cap} 倍` });
    const report = this.deps.strategies.detail(strategy_id).report;
    const symbols = [...new Set(report?.assets.flatMap(a => a.symbols) ?? [s.symbol])].filter(x => /^[A-Z0-9]+USDT$/.test(x)).slice(0, 30);
    return { strategy_id, version: v, timeframe: s.timeframe, sizing_mode: ir && volTargetOf(ir) ? 'vol_target' : 'fixed_risk', deployable: blockers.length === 0, blockers, warnings,
      defaults: { mode: 'auto', market: selectedMarket, leverage: selectedMarket === 'spot' ? 1 : Math.min(rawLeverage, cap), symbols: symbols.length ? symbols : [s.symbol], symbols_source, risk_pct: env.risk_pct, max_open: 3, publish_asp: false },
      watchlist: env.watchlist, execution: env.execution, requires_live_confirm: live(env.execution), asp: { identity: env.asp.identity, active: env.asp.active, publisher_enabled: env.asp.publisher_enabled },
      existing_run: this.list().find(r => r.strategy_id === strategy_id && r.status !== 'stopped') ?? null };
  }
  /**
   * §9.56 预检:用这个版本的回测结果检查执行层会拒掉多少。新回测报告直接读 execution_gate;旧报告用订单计划里的止损止盈和数据集算的 ATR;
   * 都没有就用本策略同版本实盘候选)按当前执行层阈值过一遍。拒掉 ≥50% → blocker,>0 → warning,拿不到样本 → warning「无法核对」。
   * 文案只建议改策略(止损倍数/止盈),不建议调低执行层下限。
   */
  private executionFit(strategy_id: string, version: number, th: ExecutionThresholds): { warnings: { code: string; message: string }[]; blocker: { code: string; message: string } | null } {
    const warnings: { code: string; message: string }[] = [];
    const link = this.deps.strategies.store.reports(strategy_id).find(r => r.version === version && r.completed);
    let report: BacktestReport | null = null;
    try { report = link ? this.deps.strategies.detail(strategy_id, link.report_id).report : null; } catch { report = null; }
    const samples: GeometrySample[] = [];
    let source = '';
    for (const a of report?.assets ?? []) {
      let bars: readonly ResearchBar[] | null = null;
      try { bars = reportBars(this.deps.strategies.research, report!, a.key); } catch { bars = null; }
      for (const p of a.plans ?? []) {
        if (p.status === 'blocked' || !p.stop) continue;
        const ref = p.entry_price ?? p.reference_price, upto = bars ? bars.filter(b => b.close_time <= p.placed_at).slice(-15) : [];
        const atrNow = upto.length === 15 ? researchAtr(upto as ResearchBar[], 14) : NaN;
        samples.push({ side: p.side === 'short' ? 'short' : 'long', ref, stop: p.stop.price, target: blendedTarget(p.take_profits.map(t => ({ price: t.price, size: t.size_pct }))), atr: Number.isFinite(atrNow) && atrNow > 0 ? atrNow : null });
      }
    }
    if (samples.length) source = '回测订单';
    else {
      // 同策略同版本的实盘候选(运行器已经看到的真实几何;没有 ATR,只核对百分比与净RR)
      for (const r of this.store.list().filter(r => r.strategy_id === strategy_id && r.version === version)) {
        for (const e of this.deps.db.prepare("SELECT json FROM strategy_run_events WHERE run_id=? AND kind='candidate' ORDER BY seq DESC LIMIT 200").all(r.id).map(x => JSON.parse(String(x['json'])) as StrategyRunEvent)) {
          const d = e.data ?? {};
          const tps = Array.isArray(d['take_profits']) ? (d['take_profits'] as { price: string; size_pct: number }[]).map(t => ({ price: t.price, size: t.size_pct })) : [];
          samples.push({ side: d['direction'] === 'short' ? 'short' : 'long', ref: Number(d['entry_ref']), stop: Number(d['stop']), target: tps.length ? blendedTarget(tps) : d['target'] === null || d['target'] === undefined ? null : Number(d['target']), atr: null });
        }
      }
      if (samples.length) source = '实盘候选';
    }
    const gate = (report as { execution_gate?: { thresholds?: Partial<ExecutionThresholds>; checked: number; rejected: number; rejected_by_execution: Record<string, number> } | null } | null)?.execution_gate;
    const fit = policyFit(samples, th);
    let checked = fit.checked, rejected = fit.rejected, by = fit.rejected_by_execution as Record<string, number>;
    if (gate && gate.checked > 0) {
      // 新回测报告在回测时就按执行层拒过单,直接用报告里的数;当时用的阈值和现在不一样就提示重跑
      checked = gate.checked; rejected = gate.rejected; by = gate.rejected_by_execution; source = '回测';
      const snap = gate.thresholds ?? {}, currentSnapshot = researchThresholds(th, null);
      if ((['min_stop_pct', 'max_stop_pct', 'min_stop_atr', 'min_net_rr'] as const).some(k => snap[k] !== undefined && snap[k] !== currentSnapshot[k]))
        warnings.push({ code: 'execution_policy_changed', message: `回测时的执行层阈值(${thresholdsText({ ...currentSnapshot, ...snap } as ExecutionThresholds)})与现在(${thresholdsText(th)})不同,回测结果不代表现在的实盘,请重跑回测` });
    }
    if (!checked) {
      warnings.push({ code: 'execution_unverified', message: `无法核对执行层:没有找到这个版本的回测订单或实盘候选(执行层要求${thresholdsText(th)}),实盘可能被执行层拒单` });
      return { warnings, blocker: null };
    }
    if (!rejected) return { warnings, blocker: null };
    const pct = Math.round((rejected / checked) * 100);
    const parts = [['stop_distance', '止损低于下限'], ['stop_atr', '止损小于 ATR 下限'], ['stop_too_wide', '止损过宽'], ['min_net_rr', '净RR不足']].filter(([k]) => (by[k!] ?? 0) > 0).map(([k, l]) => `${l} ${by[k!]}`).join('、');
    const advice = policyFitAdvice({ ...fit, rejected_by_execution: { stop_distance: by['stop_distance'] ?? 0, stop_atr: by['stop_atr'] ?? 0, stop_too_wide: by['stop_too_wide'] ?? 0, min_net_rr: by['min_net_rr'] ?? 0 } }, th);
    const message = `${source}按当前执行层会被拒掉 ${pct}%(${rejected}/${checked}:${parts})${fit.median_stop_pct !== null ? `,样本止损中位 ${fit.median_stop_pct.toFixed(2)}%` : ''};建议${advice || '调整策略几何'}`;
    // 只有回测样本过半被拒才挡住上线;实盘候选只提示,运行时本来就会逐单拒掉并记下原因,不该连暂停/改参数都拦
    return source !== '实盘候选' && rejected / checked >= 0.5 ? { warnings, blocker: { code: 'execution_policy_mismatch', message } } : { warnings: [...warnings, { code: 'execution_policy_mismatch', message }], blocker: null };
  }
  private validate(raw: unknown, create: boolean): Record<string, unknown> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) failure('请求体必须是对象');
    const b = raw as Record<string, unknown>, allowed = ['version', 'mode', 'symbols', 'symbols_source', 'risk_pct', 'max_open', 'publish_asp', 'jev_shadow', 'confirm', ...(create ? ['strategy_id', 'market'] : ['status'])];
    for (const key of Object.keys(b)) if (!allowed.includes(key)) failure(`未知字段 ${key}`);
    if (create && (typeof b['strategy_id'] !== 'string' || !b['strategy_id'])) failure('strategy_id 必填');
    if ('version' in b && !(Number.isInteger(b['version']) && Number(b['version']) > 0)) failure('version 必须是正整数');
    if ('mode' in b && b['mode'] === 'confirm') failure('「每笔问我确认」已下线;请选 auto(直接做)/ agent(LLM 判断)/ jev(Jev 判断)/ signal_only(只发信号)。已在跑的 confirm 运行不受影响', 'mode_confirm_removed');
    if ('mode' in b && !RUN_MODES_WRITABLE.includes(String(b['mode']) as StrategyRunMode)) failure('无效的 mode,只能是 auto / agent / jev / signal_only');
    if ('market' in b && !['spot', 'perp'].includes(String(b['market']))) failure('无效的 market');
    if ('status' in b && !['running', 'paused', 'stopped'].includes(String(b['status']))) failure('无效的 status');
    if ('symbols' in b && !(Array.isArray(b['symbols']) && b['symbols'].length > 0 && b['symbols'].length <= 30 && b['symbols'].every(x => typeof x === 'string' && /^[A-Z0-9]+USDT$/.test(x)))) failure('symbols 必须是 1–30 个内部 USDT 符号');
    if ('symbols_source' in b) parseSymbolsSource(b['symbols_source']);
    if ('risk_pct' in b && !(typeof b['risk_pct'] === 'number' && Number.isFinite(b['risk_pct']) && b['risk_pct'] > 0 && b['risk_pct'] <= 100)) failure('risk_pct 必须在 (0,100]');
    if ('max_open' in b && !(Number.isInteger(b['max_open']) && Number(b['max_open']) >= 1 && Number(b['max_open']) <= 30)) failure('max_open 必须在 1–30');
    if ('publish_asp' in b && typeof b['publish_asp'] !== 'boolean') failure('publish_asp 必须是布尔值');
    if ('jev_shadow' in b && typeof b['jev_shadow'] !== 'boolean') failure('jev_shadow 必须是布尔值');
    if ('confirm' in b && b['confirm'] !== 'LIVE') failure('confirm 必须是 LIVE');
    return b;
  }
  create(raw: unknown): Promise<{ run: StrategyRun; scan: StrategyRunEvent[] }> {
    const b = this.validate(raw, true);
    return this.serial(async () => {
      const existing = this.store.list().find(r => r.strategy_id === b['strategy_id'] && r.status !== 'stopped');
      const run = this.configure(b, existing ?? null), seq = this.store.sequence();
      await this.scanInner(run.id); return { run: this.get(run.id), scan: this.store.since(run.id, seq) };
    });
  }
  patch(id: string, raw: unknown): Promise<{ run: StrategyRun }> {
    const b = this.validate(raw, false);
    // 停止/暂停立即生效,令等待行情或过滤器的扫描在下一道检查终止。
    if ((b['status'] === 'paused' || b['status'] === 'stopped') && Object.keys(b).length === 1) {
      const r = this.store.require(id); r.status = b['status']; r.next_scan_at = null; this.update(r); this.event(r, 'status', r.status === 'paused' ? '运行已暂停' : '运行已停止');
      return Promise.resolve({ run: this.get(id) });
    }
    return this.serial(async () => ({ run: this.configure(b, this.store.require(id)) }));
  }
  private configure(b: Record<string, unknown>, old: StrategyRun | null): StrategyRun {
    const sid = old?.strategy_id ?? String(b['strategy_id']);
    const pf = this.preflight(sid, b['version'] as number | undefined ?? old?.version, b['market'] as StrategyRun['market'] | undefined ?? old?.market, b['symbols_source'] as SymbolsSource | undefined ?? old?.symbols_source);
    if (!pf.deployable) failure(pf.blockers.map(x => x.message).join(';'), pf.blockers[0]?.code ?? 'not_deployable', 409);
    if (old?.status === 'stopped' && this.store.list().some(r => r.strategy_id === sid && r.id !== old.id && r.status !== 'stopped')) failure('该策略已有运行', 'run_conflict', 409);
    const env = this.deps.environment(), changingChannel = !!old && this.store.key(old.id) !== env.execution_key;
    if (old && changingChannel && (this.deps.threads(old.id).some(isOpen) || this.store.transitions(old.id).length)) failure('旧执行通道仍有持仓、待批线程或待对账新信号,请先处理再切换运行通道', 'run_channel_has_positions', 409);
    if (pf.requires_live_confirm && (!old || changingChannel || b['status'] === 'running' || 'version' in b || 'mode' in b || 'risk_pct' in b || 'symbols' in b || 'symbols_source' in b || 'max_open' in b) && b['confirm'] !== 'LIVE') failure('实盘运行需要输入 LIVE 确认', 'live_requires_confirm', 409);
    const now = this.now();
    const r: StrategyRun = { ...(old ?? { id: newId('run'), created_at: now, last_scan_at: null, stats: emptyStats(), status: 'running' }),
      ...pf.defaults, ...(old ? { mode: old.mode, symbols: old.symbols, symbols_source: old.symbols_source ?? { kind: 'fixed' }, risk_pct: old.risk_pct, max_open: old.max_open, publish_asp: old.publish_asp, ...(old.jev_shadow === false ? { jev_shadow: false } : {}) } : {}),
      ...Object.fromEntries(Object.entries(b).filter(([k]) => ['mode', 'symbols', 'symbols_source', 'risk_pct', 'max_open', 'publish_asp', 'jev_shadow', 'status'].includes(k))),
      strategy_id: sid, strategy_name: this.deps.strategies.store.require(sid).name, version: pf.version, latest_version: this.deps.strategies.store.require(sid).current_version,
      ir_hash: this.deps.strategies.binding(sid, String(pf.version)).binding!.ir_hash, timeframe: pf.timeframe, direction: this.deps.strategies.store.versionIR(sid, pf.version)?.order?.direction ?? 'long', execution: env.execution,
      error: old?.error?.startsWith('slow_ir:') && b['status'] !== 'running' && !('version' in b) ? old.error : null,
      updated_at: now, next_scan_at: nextRunScan(now, pf.timeframe) };
    r.symbols = [...new Set(r.symbols)]; if (r.status !== 'running') r.next_scan_at = null;
    const ir = this.deps.strategies.store.versionIR(sid, r.version)!;
    // service 的 SAVEPOINT 保证研究生命周期与运行行一起提交/回滚。
    this.deps.strategies.store.tx(() => {
      this.deps.strategies.activateRun(sid, { live: pf.requires_live_confirm, ...(pf.requires_live_confirm ? { confirm: 'LIVE' } : {}), ...(r.publish_asp && env.asp.id ? { listing_id: `asp:${env.asp.id}:${r.id}` } : {}) });
      this.store.save(r, ir, env.execution_key);
    });
    this.event(r, 'status', old ? '运行参数已更新' : '策略开始运行');
    return this.update(r);
  }
  archive(strategy_id: string): void { for (const r of this.store.list()) if (r.strategy_id === strategy_id && r.status !== 'stopped') { r.status = 'stopped'; r.next_scan_at = null; this.update(r); this.event(r, 'status', '策略已归档,运行已停止'); } }
  private canRun(id: string): boolean { return !this.closed && this.store.get(id)?.status === 'running' && !this.deps.blocked() && this.store.key(id) === this.deps.environment().execution_key; }
  scan(id: string): Promise<{ run: StrategyRun; scan: StrategyRunEvent[] }> { return this.serial(async () => { this.store.require(id); const seq = this.store.sequence(); await this.scanInner(id); return { run: this.get(id), scan: this.store.since(id, seq) }; }); }
  private async scanInner(id: string, entries = true): Promise<void> {
    let r = this.store.require(id);
    if (this.deps.strategies.store.require(r.strategy_id).status === 'archived') { this.archive(r.strategy_id); r = this.store.require(id); }
    const blocked = this.deps.blocked();
    if (this.closed) return;
    if (this.store.key(id) !== this.deps.environment().execution_key) { r.status = 'paused'; r.next_scan_at = null; this.event(r, 'error', '执行通道已变化,请确认新通道后恢复运行'); this.update(r); return; }
    const now = this.now(), ir = this.store.ir(id), ms = timeframeMillis(r.timeframe), as_of = Math.floor((now - 5000) / ms) * ms;
    try {
      // 暂停/停止只禁止新开仓,已有持仓继续按钉住的旧版本做机械退出。
      await this.expireEntries(r, now);
      if (blocked) { this.event(r, 'skip', blocked); return; }
      if (r.error?.startsWith('slow_ir:')) return;
      await this.exits(r, now);
      if (this.canRun(id)) await this.resumeTransitions(r);
      if (!entries || !this.canRun(id)) return;
      let retryBars = false;
      const source = r.symbols_source ?? { kind: 'fixed' }, previous = [...r.symbols];
      let ranked: string[] = [], retained: string[] = [];
      if (source.kind === 'radar') {
        try {
          if (!this.deps.radarSymbols) throw new Error('radar_not_connected');
          const rows = await this.deps.radarSymbols(source.tier, source.top_n);
          if (!Array.isArray(rows) || rows.some(s => typeof s !== 'string' || !/^[A-Z0-9]+USDT$/.test(s))) throw new Error('radar_invalid_symbols');
          ranked = [...new Set(rows)].slice(0, source.top_n);
        } catch (e) {
          this.event(r, 'error', `雷达币池读取失败,本轮不生成入场:${(e as Error).message}`, null, { code: 'radar_unavailable', as_of, symbols_source: source });
          r = this.store.require(id); r.next_scan_at = r.status === 'running' ? now + TRANSIENT_RETRY_MS : null; this.update(r); return;
        }
        if (!this.canRun(id)) return;
        retained = [...new Set(this.deps.threads(id).filter(isOpen).map(t => t.symbol))].filter(s => !ranked.includes(s));
        r.symbols = [...ranked, ...retained]; this.update(r);
      }
      this.event(r, 'scan', `扫描 ${r.symbols.length} 个币的 ${r.timeframe} 已收盘 K 线(${source.kind === 'radar' ? `雷达 ${source.tier} 前 ${source.top_n}` : '固定币池'})`, null,
        { as_of, symbols_source: source, symbols: r.symbols, added: r.symbols.filter(s => !previous.includes(s)), removed: previous.filter(s => !r.symbols.includes(s)), retained, ...(source.kind === 'radar' ? { ranked } : {}) });
      const pool = new Map<string, Kline[]>();
      let screens: ReturnType<typeof runScreenRows> = [];
      if (ir.universe?.screen) {
        for (const symbol of r.symbols) {
          pool.set(symbol, await this.deps.bars(symbol, r.timeframe, Math.max(2162, runHistoryBars(ir, ms)), as_of - 1, r.market));
          if (!this.canRun(id)) return;
        }
        if ([...pool.values()].some(ks => !ks.some(k => k.open_time + ms === as_of))) {
          this.event(r, 'skip', '筛选池尚有币缺最新收盘行情,整池稍后重试');
          r.next_scan_at = now + 15_000; this.update(r); return;
        }
        screens = runScreenRows(pool, ms, as_of, r.market);
      }
      for (const symbol of r.symbols) {
        if (!this.canRun(id)) break;
        if (this.store.seen(id, symbol, as_of)) continue;
        const ks = pool.get(symbol) ?? await this.deps.bars(symbol, r.timeframe, runHistoryBars(ir, ms), as_of - 1, r.market);
        if (!this.canRun(id)) break;
        const clock = this.deps.clock ?? irCpuClock, start = clock(), wallStart = performance.now();
        const g = (this.deps.generate ?? generateRunCandidate)({ shadow: { strategy_id: r.strategy_id, version: r.version, ir_hash: r.ir_hash, timeframe: r.timeframe, ir, source: 'research_strategy_version', label: r.strategy_name, unmapped: [], horizon_bars: Number(ir.exit.find(x => x.primitive === 'time_stop')?.params['bars'] ?? 48), pick_note: 'strategy_run' }, symbol, klines: { [r.timeframe]: ks }, now: as_of, screen: screens.find(row => row.symbol === symbol) });
        if (clock() - start > IR_CPU_BUDGET_MS || performance.now() - wallStart > IR_WALL_CEILING_MS) throw new Error(`slow_ir: ${symbol} 单次 IR 计算超过 ${IR_CPU_BUDGET_MS}ms CPU(或 ${IR_WALL_CEILING_MS}ms 墙钟),运行已停止`);
        if (g.reason.startsWith('ir_error:')) throw new Error(g.reason);
        if (g.as_of !== as_of) { retryBars = true; this.event(r, 'skip', '行情尚未返回最新收盘 K 线,稍后重试', symbol); continue; }
        // 在任何模型/下单/发布之前持久化;崩溃留下已消费信号,不盲重放未知提交。
        if (!this.store.claim(id, symbol, as_of)) continue;
        const c = g.candidate;
        if (!c) { if (g.reason !== 'no_candidate' && g.reason !== 'regime_filter') this.event(r, 'skip', g.reason === 'screen_filter' ? '筛选条件未通过或历史不足,本根跳过' : g.reason, symbol, { code: g.reason.split(':')[0], as_of }); continue; }
        this.event(r, 'candidate', `${symbol} 命中 ${r.strategy_name}`, symbol, { entry_ref: String(c.entry_ref), stop: String(c.stop), target: c.target === null ? null : String(c.target), rr: c.rr, as_of, direction: c.direction, entry_type: c.entry_type, take_profits: c.take_profits?.map(t => ({ price: String(t.price), size_pct: t.size_pct })), warnings: c.unmapped, sizing_mode: c.size_weight === undefined ? 'fixed_risk' : 'vol_target', ...(c.size_weight !== undefined ? { size_weight: c.size_weight, size_note: c.size_note } : {}) });
        let traded = false, judgeFollow = true;
        // Jev 影子判断:claim 之后、下单之前发起,fire-and-forget —— 不 await、不挡单、失败只记账本(见 shadowJudge)。
        if (!ir.judge && r.mode !== 'jev' && r.jev_shadow !== false && this.deps.jevShadow) this.shadowJudge(r, ir, c, ks, ms);
        if (ir.judge) {
          const runtime = this.deps.judge?.(r, ir), started = performance.now();
          if (!runtime) { judgeFollow = false; this.event(r, 'agent_skip', 'judge_runtime_missing', symbol, { layer: 'judge', code: 'ir_judge_skip' }); this.recordGate(r, ir, c, null, [], ms, null, 'judge_runtime_missing', { source: undefined, snapshot: () => undefined }, null, started); }
          else {
            const snapshot = candidateSnapshot(ir, { symbol, as_of: c.as_of, timeframe_ms: ms, direction: c.direction,
              entry: judgeDecimal(c.entry_ref), stop: judgeDecimal(c.stop), target: c.target === null ? null : judgeDecimal(c.target), reward_risk: c.rr });
            // 同一录制源,只是记住这次读到的快照给账本复用;判断输入与原来完全一致。
            const micro = memoMicro(this.deps.microstructure), bars = toResearchBars(ks, ms, c.as_of);
            let answer: Awaited<ReturnType<typeof judgeWithBars>>;
            try { answer = await judgeWithBars(ir, snapshot, bars, { ...runtime, ...(micro.source ? { microstructure: micro.source } : {}) }); }
            catch (e) { this.recordGate(r, ir, c, snapshot, bars, ms, null, `judge_threw:${(e as Error).message}`, micro, runtime.model_profile, started); throw e; }
            judgeFollow = answer.action === 'follow';
            this.event(r, judgeFollow ? 'agent_follow' : 'agent_skip', answer.reason_codes.join(',') || answer.action, symbol, { candidate_id: snapshot.id, judge: answer, layer: 'judge', code: judgeFollow ? 'ir_judge_follow' : 'ir_judge_skip' });
            this.recordGate(r, ir, c, snapshot, bars, ms, answer, null, micro, runtime.model_profile, started);
          }
        }
        const active = this.deps.threads(id).filter(isOpen);
        const same = active.filter(t => t.symbol === symbol), current = same[0];
        let skip = same.length > 1 ? 'ambiguous_position:同币多条活动线程需先对账' : !current && active.length >= r.max_open ? 'max_open:已达本运行同时持仓上限' : null;
        if (ir.order?.min_rr && (c.rr === null || c.rr < ir.order.min_rr)) skip = 'min_rr:候选不满足 IR 盈亏比要求';
        if (!judgeFollow) skip = 'ir_judge_skip';
        if (skip) this.event(r, 'skip', skip, symbol, skip === 'ir_judge_skip' ? { layer: 'judge', code: 'ir_judge_skip' } : reasonData(skip));
        else if (r.mode !== 'signal_only') {
          let follow = true;
          if (r.mode === 'agent' && !ir.judge) {
            let answer: RunFilterResult;
            try { answer = parseRunFilter(await this.deps.filter(r, c, ir)); }
            catch (e) { answer = { decision: 'skip', reason: `过滤超时或解析失败:${(e as Error).message}` }; }
            follow = answer.decision === 'follow'; this.event(r, follow ? 'agent_follow' : 'agent_skip', answer.reason, symbol, { layer: 'judge', code: follow ? 'agent_follow' : 'agent_skip', judge: 'llm' });
          } else if (r.mode === 'jev' && !ir.judge) {
            // §9.56 jev 模式由 Jev 决定做不做:Jev 说跟才开仓;说跳过、调不到、超时或预算用完都不开,并记下原因。
            const v = await this.jevGate(r, ir, c, ks, ms);
            follow = v.code === 'jev_follow';
            this.event(r, follow ? 'agent_follow' : 'agent_skip', follow ? `Jev 放行:${v.reason}` : v.code === 'jev_skip' ? `Jev 跳过:${v.reason}` : `Jev 不可用,按跳过:${v.reason}`, symbol,
              { layer: 'judge', code: v.code, judge: 'jev', decision_id: v.row?.decision_id ?? null, judge_live_id: v.row?.id ?? null });
          }
          if (follow && this.canRun(id)) {
            const result = await this.executeCandidate(r, c, ir, current);
            // 没发出任何订单的临时失败(标记价取不到/限流/网络)不消费这根 K 线:放回去,15 秒后重试同一根
            if (result.outcome !== 'opened' && result.outcome !== 'unknown' && result.outcome !== 'skipped' && isTransient(result.reason)) {
              this.store.release(id, symbol, as_of); retryBars = true;
              this.event(r, 'skip', `临时失败,15 秒后重试:${result.reason}`, symbol, { as_of, transient: true, layer: 'execution', code: 'transient' });
              continue;
            }
            const accepted = result.outcome === 'opened';
            traded = accepted && r.mode !== 'confirm';
            const structured = result.outcome === 'unknown' ? { layer: 'execution' as const, code: 'execution_unknown' }
              : result.outcome === 'skipped' ? reasonData(result.reason)
              : !accepted ? { layer: result.layer ?? reasonData(result.reason, 'execution').layer, code: result.code ?? reasonData(result.reason, 'execution').code, ...(result.gates?.length ? { gates: result.gates } : {}) } : {};
            this.event(r, result.outcome === 'unknown' ? 'error' : result.outcome === 'skipped' ? 'skip' : accepted ? r.mode === 'confirm' ? 'order_pending' : 'order_opened' : 'order_rejected', result.reason, symbol, { thread_id: result.thread_id ?? null, ...(result.outcome === 'unknown' ? { execution_unknown: true } : {}), ...structured });
          }
        }
        if (judgeFollow && r.publish_asp && this.canRun(id)) await this.publish(r, c, traded);
      }
      r = this.store.require(id); r.last_scan_at = now; r.next_scan_at = r.status === 'running' ? retryBars ? now + 15_000 : nextRunScan(now, r.timeframe) : null; this.update(r);
    } catch (e) {
      r = this.store.require(id);
      const message = (e as Error).message;
      // 网络抖动 / 交易所限流不是运行出错:记一条,30 秒后重试,运行保持「运行中」
      if (r.status === 'running' && !message.startsWith('slow_ir:') && isTransient(message)) {
        r.error = null; r.next_scan_at = this.now() + TRANSIENT_RETRY_MS;
        this.event(r, 'error', `网络或交易所限流,30 秒后自动重试:${message}`, null, { transient: true }); this.update(r); return;
      }
      if (message.startsWith('slow_ir:')) r.error = message;
      if (r.status === 'running') { r.status = 'error'; r.error = message; r.next_scan_at = null; }
      this.event(r, 'error', message); this.update(r);
    }
  }
  private liveRun(r: StrategyRun) { return { id: r.id, strategy_id: r.strategy_id, strategy_name: r.strategy_name, timeframe: r.timeframe, ir_hash: r.ir_hash, market: r.market }; }
  private emitLive(row: JudgeLiveRecord | null): void { if (row) try { this.deps.emit('judge.live', row); } catch { /* SSE 失败不影响运行 */ } }
  /**
   * 影子判断:fire-and-forget。不 await(不给下单链路加任何延迟,也不占 serial 队列);
   * 整个调用包在 runShadowJudge 里永不抛错,外层再兜一层 try + .catch,异常绝不进 scanInner 的 catch。
   * 同时在途上限 JEV_SHADOW_MAX_INFLIGHT,超了记一条 shadow_busy;stop() 会中止并等在途的收尾。
   */
  private shadowJudge(r: StrategyRun, ir: StrategyIR, c: RunCandidate, ks: Kline[], ms: number): void {
    try {
      const busy = this.shadows.size >= JEV_SHADOW_MAX_INFLIGHT, factory = this.deps.jevShadow!;
      const p = Promise.resolve().then(() => runShadowJudge({ run: this.liveRun(r), ir, candidate: { symbol: c.symbol, as_of: c.as_of, direction: c.direction, entry_ref: c.entry_ref, stop: c.stop, target: c.target, rr: c.rr },
        bars: toResearchBars(ks, ms, c.as_of), timeframe_ms: ms, factory: busy ? () => 'shadow_busy' : factory, ledger: this.judgeLedger, signal: this.shadowAbort.signal, now: this.now }))
        .then(row => this.emitLive(row)).catch(() => {});
      this.shadows.add(p); void p.finally(() => this.shadows.delete(p));
    } catch { /* 影子判断失败不影响下单 */ }
  }
  /**
   * §9.56 运行模式 jev:无 IR judge 块的候选由 Jev(默认模板 take + quality,与影子判断同一条链)作真门。
   * 永不抛错;没接 Jev / 决策模型未绑定 / 预算用尽 / 超时 / 出错 → code=jev_unavailable,调用方按跳过处理。账本行 mode='gate'。
   */
  private async jevGate(r: StrategyRun, ir: StrategyIR, c: RunCandidate, ks: Kline[], ms: number): Promise<JevVerdict> {
    if (!this.deps.jevShadow) return { row: null, action: null, reason: 'jev_not_connected', code: 'jev_unavailable' };
    const ac = new AbortController(), abort = () => ac.abort();
    this.shadowAbort.signal.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const judged = runJevJudge({ run: this.liveRun(r), ir, candidate: { symbol: c.symbol, as_of: c.as_of, direction: c.direction, entry_ref: c.entry_ref, stop: c.stop, target: c.target, rr: c.rr },
        bars: toResearchBars(ks, ms, c.as_of), timeframe_ms: ms, factory: this.deps.jevShadow, ledger: this.judgeLedger, signal: ac.signal, now: this.now }, 'gate');
      const timeout = new Promise<JevVerdict>(resolve => { timer = setTimeout(() => { ac.abort(); resolve({ row: null, action: null, reason: `jev_timeout:${JEV_GATE_TIMEOUT_MS}ms`, code: 'jev_unavailable' }); }, JEV_GATE_TIMEOUT_MS); });
      const v = await Promise.race([judged, timeout]);
      this.emitLive(v.row);
      return v;
    } catch (e) { return { row: null, action: null, reason: `jev_failed:${(e as Error).message}`, code: 'jev_unavailable' }; }
    finally { if (timer) clearTimeout(timer); this.shadowAbort.signal.removeEventListener('abort', abort); }
  }
  /** 挡单判断的账本行:只记录,异常吞掉,不改变挡单结果。 */
  private recordGate(r: StrategyRun, ir: StrategyIR, c: RunCandidate, snapshot: JudgeCandidateSnapshot | null, bars: readonly ResearchBar[], _ms: number,
    result: JudgeResult | null, error: string | null, micro: ReturnType<typeof memoMicro>, profile: FrozenModelProfile | null, started: number): void {
    try {
      const requested = !!micro.source && !!ir.judge && needsMicrostructure(ir.judge);
      this.emitLive(this.judgeLedger.record(gateRecord({ run: this.liveRun(r), ir, snapshot, bars, candidate: { symbol: c.symbol, as_of: c.as_of, direction: c.direction, entry_ref: c.entry_ref, stop: c.stop, target: c.target, rr: c.rr },
        result, error, micro: { requested, snapshot: micro.snapshot() }, profile, wall_ms: Math.round(performance.now() - started) })));
    } catch { /* 账本失败不影响挡单语义 */ }
  }
  private async executeCandidate(r: StrategyRun, c: RunCandidate, ir: StrategyIR, current?: StrategyThread): Promise<RunOpenResult> {
    const reject = (reason: string): RunOpenResult => ({ outcome: 'skipped', reason });
    if (this.store.transitions(r.id).some(t => t.candidate.symbol === c.symbol)) return reject('new_signal_pending:旧信号仍待对账续接');
    const approval = r.mode === 'confirm' ? 'manual' : 'auto';
    const open = c.size_weight === undefined ? this.deps.open : this.deps.openSized;
    if (!open) return reject('vol_target_not_connected:禁止退回固定风险仓位');
    if (current) {
      // 待归属、部分成交、撤余量或外部状态不确定时不能判成「未成交」。
      if (current.entry_cancel_pending || current.entry_submitting_since || current.attention || !['pending_entry', 'in_position'].includes(current.status)) return reject('position_unsettled:同币线程需先对账');
      const order = resolveOrder(ir, timeframeMillis(r.timeframe));
      if (!order) return reject('already_open:本运行已有该币持仓或挂单');
      const version = current.strategy_version ?? Number(current.strategy_id?.split('@').at(-1));
      if (version !== r.version) return reject('position_version_mismatch:旧版本持仓按旧 IR 管理,不接新版本信号');
      const state = this.deps.positionState?.(current);
      const action = newSignalAction(order.on_new_signal, current.side, c.direction, current.status === 'in_position', state?.adds ?? 0, order.max_adds);
      if (action === 'ignore') return reject('already_open:IR 要求忽略新信号或已达加仓腿上限');
      if (action === 'roll') return reject('new_signal_policy:roll 无费结转尚未实现');
      if (action === 'add') {
        if (!this.deps.add || !state || !Number.isInteger(state.adds) || state.adds! < 0 || !(Number(state.base_leg_margin) > 0)) return reject('new_signal_policy:add 缺首腿额度/在途腿状态或执行接线');
        return this.deps.add(r, current, c, approval, { base_leg_margin: state.base_leg_margin!, max_adds: order.max_adds });
      }
      if (action === 'replace') {
        if (current.opened_at || current.filled_avg_price) return reject('position_unsettled:部分成交不能按未成交替换');
        if (!this.deps.cancel) return reject('new_signal_policy:replace 缺撤单接线');
      } else if (action === 'flip') {
        if (r.market !== 'perp') return reject('flip_perp_only:反手只支持永续');
        if (approval === 'manual') return this.deps.flip ? this.deps.flip(r, current, c, approval) : reject('new_signal_policy:confirm 反手缺整项审批接线');
      }
      const transition: RunTransition = { run_id: r.id, version: r.version, execution_key: this.store.key(r.id), mode: r.mode, thread_id: current.id, action, phase: 'waiting', candidate: freezeCandidate(c) };
      this.store.saveTransition(transition, this.now()); // 撤/平前落库，信号 claim 不等于复合动作完成。
      try {
        if (action === 'replace') {
          const cancelled = await this.deps.cancel!(current, '策略新信号替换未成交挂单');
          if (!cancelled.ok) return reject(`replace_unconfirmed:${cancelled.detail}`);
        } else await this.deps.close(current, '策略反向信号:flipped');
      } catch (e) { return reject(`${action}_unconfirmed:${(e as Error).message}`); }
      return this.finishTransition(r, transition);
    }
    if (!this.canRun(r.id)) return reject('run_not_running:执行前运行已暂停或通道改变');
    return open(r, c, approval);
  }
  private async finishTransition(r: StrategyRun, x: RunTransition): Promise<RunOpenResult> {
    const c = thawCandidate(x.candidate), skip = (reason: string): RunOpenResult => ({ outcome: 'skipped', reason });
    if (x.phase === 'opening') {
      if (x.execution_key !== this.store.key(r.id)) return skip('execution_unknown:需在原执行通道核对新腿');
      const reconciled = await this.deps.reconcileOpen?.(r, c.id, x.new_thread_id ?? null);
      if (reconciled?.outcome === 'opened' || reconciled?.outcome === 'rejected') { this.store.clearTransition(r.id, c.symbol); return reconciled; }
      return skip('execution_unknown:新腿提交相位已持久化,按原 CID 对账,不重复开腿');
    }
    if (x.version !== r.version || x.mode !== r.mode || x.execution_key !== this.store.key(r.id) || this.now() >= (c.entry_expires_at ?? c.as_of + timeframeMillis(r.timeframe))) {
      this.store.clearTransition(r.id, c.symbol); return skip('new_signal_expired:候选过期或运行版本/模式/通道已变化');
    }
    const rows = this.deps.threads(r.id), old = rows.find(t => t.id === x.thread_id);
    if (x.action === 'replace' && old && (old.opened_at || old.filled_avg_price)) {
      this.store.clearTransition(r.id, c.symbol); return skip('replace_partial_fill:旧挂单已成交,不按未成交替换');
    }
    if (!old || old.status !== (x.action === 'replace' ? 'canceled' : 'closed') || old.entry_cancel_pending || old.attention || old.entry_submitting_since) return skip(`${x.action}_unconfirmed:等待旧腿终态对账`);
    const active = rows.filter(isOpen);
    if (active.some(t => t.symbol === c.symbol) || active.length >= r.max_open || !this.canRun(r.id)) return skip('new_signal_waiting:暂停或仓位上限阻止续接');
    const open = c.size_weight === undefined ? this.deps.open : this.deps.openSized;
    if (!open) return skip('vol_target_not_connected:禁止退回固定风险仓位');
    this.event(r, 'status', `${c.symbol} 新信号 ${x.action} 已确认旧腿结束`, c.symbol, { thread_id: old.id, action: x.action, as_of: c.as_of });
    x.phase = 'opening'; this.store.saveTransition(x, this.now());
    let result: RunOpenResult;
    try { result = await open(r, c, r.mode === 'confirm' ? 'manual' : 'auto'); }
    catch (e) { return { outcome: 'unknown', reason: `新腿提交抛错,先对账:${(e as Error).message}` }; }
    if (result.outcome !== 'unknown') this.store.clearTransition(r.id, c.symbol);
    else { x.new_thread_id = result.thread_id ?? null; this.store.saveTransition(x, this.now()); }
    return result;
  }
  private async resumeTransitions(r: StrategyRun): Promise<void> {
    for (const x of this.store.transitions(r.id)) {
      if (!this.canRun(r.id)) return;
      const result = await this.finishTransition(r, x);
      this.event(r, result.outcome === 'opened' ? x.mode === 'confirm' ? 'order_pending' : 'order_opened' : result.outcome === 'unknown' ? 'error' : 'skip', result.reason, x.candidate.symbol, { thread_id: result.thread_id ?? x.thread_id, action: x.action, resumed: true, as_of: x.candidate.as_of });
    }
  }
  private async expireEntries(r: StrategyRun, now: number): Promise<void> {
    for (const t of this.deps.threads(r.id).filter(isOpen)) {
      if (this.closed || this.store.key(r.id) !== this.deps.environment().execution_key) return;
      if (!t.entry_expires_at || now < t.entry_expires_at || (t.status !== 'pending_entry' && !t.entry_cancel_pending && t.attention !== 'ENTRY_REMAINDER')) continue;
      const result = await this.deps.cancel?.(t, '策略限价挂单有效期已到,撤未成交余量');
      if (!result?.ok) { this.event(r, 'error', result?.detail ?? '撤单能力不可用,请在线程页撤单', t.symbol, { thread_id: t.id }); continue; }
      if (this.store.claim(r.id, `expiry:${t.id}`, t.entry_expires_at)) this.event(r, 'skip', '限价挂单已过期,已撤未成交余量', t.symbol, { code: 'entry_expired', thread_id: t.id, as_of: t.entry_expires_at });
    }
  }
  private async exits(r: StrategyRun, now: number): Promise<void> {
    const allowed = () => !this.closed && !this.deps.blocked() && this.store.key(r.id) === this.deps.environment().execution_key;
    for (const original of this.deps.threads(r.id).filter(t => t.status === 'in_position')) {
      if (!allowed()) return;
      const version = original.strategy_version ?? Number(original.strategy_id?.split('@').at(-1)), ir = this.deps.strategies.store.versionIR(r.strategy_id, version);
      if (!ir) throw new Error(`持仓 ${original.id} 钉住的 IR 版本不存在`);
      const ms = timeframeMillis(original.timeframe), as_of = Math.floor((now - 5000) / ms) * ms;
      const entry_at = Math.floor((original.opened_at ?? original.created_at) / ms) * ms;
      if (as_of <= entry_at || this.store.seen(r.id, `exit:${original.id}`, as_of)) continue;
      const position = this.deps.positionState?.(original);
      let state = this.store.management(original.id);
      const from = state?.as_of ?? entry_at;
      const needed = Math.ceil((as_of - from) / ms) + viewBars(ir, SYNTH_POLICY, ms) + 2;
      if (needed > 60_000) { this.event(r, 'error', '持仓历史缺口超过 60000 根,需补齐状态后继续移损', original.symbol, { code: 'management_history_gap', thread_id: original.id }); continue; }
      const ks = await this.deps.bars(original.symbol, original.timeframe, needed, as_of - 1, original.market);
      if (!allowed()) return;
      const closed = toResearchBars(ks, ms, as_of), times = new Set(closed.map(b => b.open_time));
      let complete = true;
      for (let at = from; at < as_of; at += ms) if (!times.has(at)) { complete = false; break; }
      if (!complete) { this.event(r, 'skip', '持仓行情存在缺根,补齐后重试,不推进移损水位', original.symbol, { code: 'management_history_gap', thread_id: original.id, as_of }); continue; }
      if (!state) {
        const first = closed.find(b => b.open_time === entry_at)!;
        state = { initial_stop: position?.initial_stop ?? original.holding_plan?.hard_stop ?? original.stop_price!, high_water: first.high, low_water: first.low,
          fee_rate: position?.fee_rate ?? (original.market === 'perp' ? '0.0005' : '0.001'), as_of: entry_at };
        this.store.saveManagement(original.id, state, now); // 冻结初始距离，不能随已收紧的 stop 漂移。
      }
      let move_pending = false;
      for (let at = from + ms; at <= as_of; at += ms) {
        const t = this.deps.threads(r.id).find(t => t.id === original.id);
        if (!allowed()) return;
        if (!t || t.status !== 'in_position') break;
        const clock = this.deps.clock ?? irCpuClock, start = clock(), wallStart = performance.now();
        const out = runExit(ir, t, ks, at, { ...state, first_tp_filled_at: position?.first_tp_filled_at });
        if (clock() - start > IR_CPU_BUDGET_MS || performance.now() - wallStart > IR_WALL_CEILING_MS) throw new Error(`slow_ir: ${t.symbol} 持仓 IR 超过 ${IR_CPU_BUDGET_MS}ms CPU(或 ${IR_WALL_CEILING_MS}ms 墙钟)`);
        if (!allowed()) return;
        if (out.stop !== null && !move_pending) {
          const new_stop = decimal(out.stop);
          let moved: { ok: boolean; detail: string } | undefined;
          try { moved = await this.deps.moveStop?.(t, new_stop, `策略机械移损:${out.stop_reason ?? 'trail'}:${at}`); }
          catch (e) { moved = { ok: false, detail: (e as Error).message }; }
          if (!moved?.ok) {
            this.event(r, 'error', moved?.detail ?? 'moveStop 未接线,本根移损未确认', t.symbol, { code: 'stop_move_unconfirmed', thread_id: t.id, as_of: at, new_stop });
            move_pending = true; // 不再提交新目标；继续逐根检查离场，水位在确认前不落库。
          } else this.event(r, 'stop_moved', `${t.symbol} 止损收紧至 ${new_stop}`, t.symbol, { thread_id: t.id, as_of: at, new_stop, reason: out.stop_reason });
        }
        if (!allowed()) return;
        if (out.reason) {
          await this.deps.close(this.deps.threads(r.id).find(x => x.id === t.id) ?? t, `策略机械离场:${out.reason}`);
          const latest = this.deps.threads(r.id).find(x => x.id === t.id);
          if (latest?.status !== 'closed') { this.event(r, 'error', '机械离场尚未确认,等待对账', t.symbol, { thread_id: t.id, as_of: at }); break; }
          this.event(r, 'exit', `${t.symbol} 策略机械离场:${out.reason}`, t.symbol, { thread_id: t.id, as_of: at, reason: out.reason });
        }
        const bar = closed.find(b => b.open_time === at - ms)!;
        state = { ...state, high_water: String(Math.max(Number(state.high_water), Number(bar.high))), low_water: String(Math.min(Number(state.low_water), Number(bar.low))), as_of: at };
        if (!move_pending || out.reason) {
          this.store.saveManagement(t.id, state, now);
          this.store.claim(r.id, `exit:${t.id}`, at);
        }
        if (out.reason) break;
      }
    }
  }
  private async publish(r: StrategyRun, c: RunCandidate, traded: boolean): Promise<void> {
    if (!this.deps.environment().asp.identity) { this.event(r, 'error', '没有 ASP 身份,已跳过信号发布', c.symbol); return; }
    try {
      const result = await this.deps.publish({ event_id: `${r.id}:${c.symbol}:${c.as_of}`, kind: 'strategy_signal', signal_time: c.as_of, symbol: c.symbol, direction: c.direction, price: String(c.entry_ref), stop_loss: String(c.stop), take_profit: c.take_profits?.map(t => String(t.price)) ?? (c.target === null ? [] : [String(c.target)]), reason: c.reason + ((c.take_profits?.length ?? 0) > 1 && r.mode !== 'signal_only' ? ';本账户只挂首档部分止盈,后续档位不挂,余仓由止损/信号/时间离场管理' : ''), thread_id: null, realized_r: null, backend: r.execution.backend, paper: r.execution.backend === 'paper', strategy: strategyBlock(r), market: r.market, leverage: r.leverage, traded, entry_type: c.entry_type, take_profit_sizes: c.take_profits?.map(t => t.size_pct), valid_until: c.entry_expires_at ?? c.as_of + timeframeMillis(r.timeframe), signal_only: r.mode === 'signal_only' });
      const refusal = (result as { refusal?: string } | null)?.refusal;
      if (!result || refusal) this.event(r, 'error', refusal ?? '发布器未接受信号', c.symbol);
      else this.event(r, 'published', `${c.symbol} 策略信号已交 ASP 发布器`, c.symbol);
    } catch (e) { this.event(r, 'error', `发布失败:${(e as Error).message}`, c.symbol); }
  }
  async tick(): Promise<void> {
    if (this.ticking || this.closed) return; this.ticking = true;
    try { for (const r of this.store.list()) {
      if (this.deps.strategies.store.get(r.strategy_id)?.status === 'archived') this.archive(r.strategy_id);
      const holds = this.deps.threads(r.id).some(t => t.status === 'in_position' || isOpen(t) && !!t.entry_expires_at && t.entry_expires_at <= this.now());
      const due = r.status === 'running' && (!r.next_scan_at || r.next_scan_at <= this.now());
      if (holds || due || r.status === 'running' && this.store.transitions(r.id).length) await this.serial(() => this.scanInner(r.id, due));
    } } finally { this.ticking = false; }
  }
  start(): void { if (this.timer) return; this.closed = false; this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 15_000); this.timer.unref(); void this.tick().catch(() => {}); }
  async stop(): Promise<void> {
    this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = null; this.off(); await this.chain;
    this.shadowAbort.abort(); await Promise.allSettled([...this.shadows]);
  }
  /** 测试/收尾用:等在途影子判断结束。 */
  async settleShadows(): Promise<void> { while (this.shadows.size) await Promise.allSettled([...this.shadows]); }
}
export function strategyBlock(r: StrategyRun, version = r.version, timeframe = r.timeframe): NonNullable<PublishEvent['strategy']> { return { id: r.strategy_id, name: r.strategy_name, version, timeframe, run_id: r.id }; }

function blockerMessage(code: string, original: string): string {
  const messages: Record<string, string> = {
    no_ir: '这条策略还没有可执行规则,请先在研究台生成并保存规则版本',
    no_stop: '这条策略没有硬止损,请在研究台添加止损规则后再运行',
    pine_primitive: '这条策略使用了线上不能运行的 Pine 规则,请在研究台换成内置规则',
    unknown_primitive: '这条策略包含未识别的规则,请在研究台替换该规则并保存新版本',
    timeframe_invalid: '策略周期无法识别,请在研究台选择支持的周期后重试',
    leverage_over_cap: '策略杠杆超过执行上限,请在研究台降低杠杆后重试',
  };
  return messages[code] ?? `${original};请在研究台按这条提示修正规则并保存新版本后重试`;
}
