import { effectiveReturns, equityDrawdown, validKline } from './replay-stats.js';
import { simulateOutcome, outcomeEquityMarks } from './outcome.js';
import type { Setup } from './strategy-signals.js';
/**
 * 策略闭环 v2 —— **状态机 + 门 + 台账集中在这一处**
 * (设计 docs/design/strategy-loop-v2-and-events-2026-09-12.md §1;契约 docs/demo/v3-ui-contract.md §9.27)。
 *
 * ```
 * 发现(hypothesis) → 起草(draft) → 漏斗回测(backtest) → 影子实盘(shadow) → 纸面(paper) → 限额实盘(live_capped)
 *       ↑                                                                                     │
 *       └────────── 复盘归因(attribution) → 参数提案 → Lab 探针队列验证 → 新版本 ←──────────────┘
 *                                                     降级(→ backtest 重来) ← 连续劣化
 * ```
 *
 * 这一版新增的三件事:
 *  1. **shadow → paper 自动**:门全在 {@link shadowToPaperGate}(strategies.ts,纯读 spec)。
 *  2. **降级**:paper 及以上最近 30 笔期望 < −0.1R 或连续 10 笔亏 → 退回 backtest(**不是 retired**)。
 *  3. **影子实盘**:shadow 状态的策略也表态,单独给出方向且 `entry_timing='confirmed'` 时建一条
 *     **虚拟线程**({@link ShadowThread}):不下单、不占 Portfolio 容量、不进风控、不进 history 胜率,
 *     按真实 K 线在 horizon 内结算 R(复用 outcome.ts 的走法),写回该版本的 `lab_stats.shadow`。
 *     虚拟线程复查**零模型**——它从头到尾没有一次模型调用。
 *
 * 边界:这里没有任何一条路径能让模型改状态。`who` 只会是 code / human / lab / attribution,
 * 模型的产出永远落在 `draft`,再由这些代码门一格一格推。
 */

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { counterfactualLeg, MECHANICAL_HORIZON_BARS, settlementCompleteness, type LedgerLeg, type LedgerSnapshot } from './judgment-ledger.js';
import { tfToMs } from './market.js';
import type { DemoStore } from './store.js';
import {
  EMPTY_SHADOW_STATS,
  strategyForBackend,
  SHADOW_LAB_DIVERGENCE_MAX_R,
  SHADOW_MAX_DRAWDOWN_R,
  SHADOW_MIN_EXPECTANCY_R,
  SHADOW_MIN_N,
  shadowToPaperGate,
  STATUS_ORDER,
  type ShadowStats,
  type StrategySpec,
  type StrategyStatus,
} from './strategies.js';
import type { Direction, Kline, StrategyThread } from './types.js';

export const STRATEGY_LOOP_VERSION = 'sl-v3-p1b';

export { SHADOW_LAB_DIVERGENCE_MAX_R, SHADOW_MAX_DRAWDOWN_R, SHADOW_MIN_EXPECTANCY_R, SHADOW_MIN_N, shadowToPaperGate };

/** 影子线程走多少根判断周期 K 线(与判断账本的机械基线同口径)。 */
export const SHADOW_HORIZON_BARS = MECHANICAL_HORIZON_BARS;

// ---------------------------------------------------------------- 降级门(§1.2 表最后一行)

/** 劣化判定只看最近这么多笔。 */
export const DEGRADE_WINDOW = 30;
/** 最近 30 笔期望低于它就降级。 */
export const DEGRADE_MIN_EXPECTANCY_R = -0.1;
/** 连续这么多笔亏也降级(即使均值还没塌)。 */
export const DEGRADE_LOSS_STREAK = 10;

export interface DegradeDecision {
  degrade: boolean;
  reason: string;
  n: number;
  expectancy_r: number | null;
  loss_streak: number;
}

/**
 * 降级判据(纯函数)。`rs` 是这条策略**已结算**交易的 R,**按时间从旧到新**。
 * 两条触发线各自独立:最近 30 笔期望 < −0.1R,或末尾连续 10 笔亏。
 * 样本不足 30 笔时只看连亏——「刚上线三笔就亏两笔」不该把一条策略打回去。
 */
export function degradeDecision(rs: readonly number[]): DegradeDecision {
  const window = rs.slice(-DEGRADE_WINDOW);
  const n = window.length;
  const expectancy = n ? Math.round((window.reduce((a, b) => a + b, 0) / n) * 10_000) / 10_000 : null;
  let streak = 0;
  for (let i = rs.length - 1; i >= 0; i--) {
    if (rs[i]! < 0) streak++;
    else break;
  }
  if (streak >= DEGRADE_LOSS_STREAK) {
    return { degrade: true, reason: `连续 ${streak} 笔亏(门槛 ${DEGRADE_LOSS_STREAK})`, n, expectancy_r: expectancy, loss_streak: streak };
  }
  if (n >= DEGRADE_WINDOW && expectancy !== null && expectancy < DEGRADE_MIN_EXPECTANCY_R) {
    return { degrade: true, reason: `最近 ${n} 笔期望 ${expectancy.toFixed(2)}R < ${DEGRADE_MIN_EXPECTANCY_R}R`, n, expectancy_r: expectancy, loss_streak: streak };
  }
  const why = n < DEGRADE_WINDOW ? `只有 ${n} 笔已结算(期望门槛要 ${DEGRADE_WINDOW} 笔)` : `最近 ${n} 笔期望 ${expectancy!.toFixed(2)}R`;
  return { degrade: false, reason: `${why},连亏 ${streak} 笔`, n, expectancy_r: expectancy, loss_streak: streak };
}

// ---------------------------------------------------------------- 台账(§1.3)

export type StrategyEventActor = 'code' | 'human' | 'lab' | 'attribution';
export type StrategyEventKind = 'version_created' | 'promote' | 'demote' | 'retire' | 'activated' | 'deactivated';

export interface StrategyEvent {
  id: number;
  strategy_id: string;
  version: number;
  at: number;
  /** 谁触发的。模型不在这个枚举里——它没有触发状态迁移的权限。 */
  who: StrategyEventActor;
  kind: StrategyEventKind;
  from_status: StrategyStatus | null;
  to_status: StrategyStatus | null;
  reason: string;
  /** 判这一步时用到的**数字**(n / 期望 / 回撤 …);没有数字的步骤是空对象,不写形容词。 */
  evidence: Record<string, number | null>;
}

export type StrategyEventInput = Omit<StrategyEvent, 'id'>;

export class StrategyEventStore {
  constructor(private readonly db: DatabaseSync) {}

  append(e: StrategyEventInput): StrategyEvent {
    const r = this.db
      .prepare('INSERT INTO demo_strategy_event(strategy_id, version, at, who, kind, from_status, to_status, reason, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.strategy_id, e.version, e.at, e.who, e.kind, e.from_status, e.to_status, e.reason, JSON.stringify(e.evidence));
    return { ...e, id: Number(r.lastInsertRowid) };
  }

  /** 一条策略的台账,**旧的在前**(时间线从左到右画)。 */
  timeline(strategyId: string, limit = 200): StrategyEvent[] {
    const rows = this.db.prepare('SELECT * FROM demo_strategy_event WHERE strategy_id = ? ORDER BY at ASC, id ASC LIMIT ?').all(strategyId, Math.max(1, limit)) as Record<string, unknown>[];
    return rows.map(toEvent);
  }

  /** 全库最近的台账,新的在前。 */
  recent(limit = 50): StrategyEvent[] {
    const rows = this.db.prepare('SELECT * FROM demo_strategy_event ORDER BY at DESC, id DESC LIMIT ?').all(Math.max(1, limit)) as Record<string, unknown>[];
    return rows.map(toEvent);
  }
}

function toEvent(r: Record<string, unknown>): StrategyEvent {
  let evidence: Record<string, number | null> = {};
  try {
    evidence = JSON.parse(String(r['evidence_json'] ?? '{}')) as Record<string, number | null>;
  } catch {
    evidence = {};
  }
  return {
    id: Number(r['id']),
    strategy_id: String(r['strategy_id']),
    version: Number(r['version']),
    at: Number(r['at']),
    who: String(r['who']) as StrategyEventActor,
    kind: String(r['kind']) as StrategyEventKind,
    from_status: r['from_status'] === null || r['from_status'] === undefined ? null : (String(r['from_status']) as StrategyStatus),
    to_status: r['to_status'] === null || r['to_status'] === undefined ? null : (String(r['to_status']) as StrategyStatus),
    reason: String(r['reason'] ?? ''),
    evidence,
  };
}

// ---------------------------------------------------------------- 影子实盘的虚拟线程(§1.2)

export type ShadowStatus = 'open' | 'settled' | 'unscoreable';

export interface ShadowThread {
  id: string;
  /** 永远是 'shadow':它和真线程共享语义,但**刻意不进 demo_threads**——不占容量、不进风控、不进胜率。 */
  kind: 'shadow';
  strategy_id: string;
  version: number;
  content_hash: string;
  symbol: string;
  timeframe: string;
  side: Direction;
  /** 判断那一刻(as_of);反事实从这里之后的第一根开盘进场。 */
  opened_at: number;
  horizon_end_at: number;
  /** 建仓时冻结的指标快照(结算时不再重算,回放可复现)。 */
  snapshot: LedgerSnapshot;
  status: ShadowStatus;
  r: number | null;
  backend?: string;
  setup?: Setup;
  score_kind?: 'direction_proxy' | 'full_strategy';
  equity_marks?: { at: number; r: number }[];
  exit_at?: number;
  retry_after?: number;
  generation?: number;
  horizon_bars?: number;
  net_r?: number | null;
  funding_estimated?: boolean;
  leg: LedgerLeg | null;
  settled_at: number | null;
  /** 触发它的那次 episode(有就记,没有也不影响结算)。 */
  episode_id: string | null;
  note: string;
}

const sid = (): string => `sh-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

export interface OpenShadowInput {
  spec: Pick<StrategySpec, 'id' | 'version' | 'content_hash'> & Partial<Pick<StrategySpec, 'params' | 'shadow_generation'>>;
  symbol: string;
  timeframe: string;
  side: Direction;
  at: number;
  snapshot: LedgerSnapshot;
  episode_id?: string | null;
}

/** 纯函数:一次「shadow 策略单独给出方向且时机已确认」→ 一条待结算的虚拟线程。 */
export function openShadowThread(inp: OpenShadowInput): ShadowThread {
  return {
    id: sid(),
    kind: 'shadow',
    generation: inp.spec.shadow_generation ?? 0,
    strategy_id: inp.spec.id,
    version: inp.spec.version,
    content_hash: inp.spec.content_hash,
    symbol: inp.symbol,
    timeframe: inp.timeframe,
    side: inp.side,
    opened_at: inp.at,
    horizon_bars: inp.spec.params?.horizon_bars?.value ?? SHADOW_HORIZON_BARS,
    horizon_end_at: inp.at + (inp.spec.params?.horizon_bars?.value ?? SHADOW_HORIZON_BARS) * tfToMs(inp.timeframe),
    snapshot: inp.snapshot,
    status: 'open',
    r: null,
    leg: null,
    settled_at: null,
    episode_id: inp.episode_id ?? null,
    note: '',
  };
}

/**
 * 结算一条虚拟线程:用 {@link counterfactualLeg}(= outcome.ts 的 openTrade/stepTrade 走法)
 * 在 `bars`(opened_at 之后那段)上走 48 根。零模型、零下单。
 */
export function settleShadowThread(t: ShadowThread, bars: readonly Kline[], now: number, funding: { at: number; rate: string }[] = []): ShadowThread {
  const horizon = t.horizon_bars ?? SHADOW_HORIZON_BARS;
  const ms = tfToMs(t.timeframe);
  const first = (Math.floor(t.opened_at / ms) + 1) * ms;
  const window = bars.slice(0, horizon);
  if (now < t.horizon_end_at || window.length !== horizon || window.some((b, i) => !validKline(b) || b.open_time !== first + i * ms || b.close_time !== b.open_time + ms - 1 || b.close_time >= now)) {
    return { ...t, status: 'open', r: null, net_r: null, settled_at: null, retry_after: now + 300000, note: '等待完整闭合 horizon 与连续数据水位' };
  }
  bars = window;
  const proxy = counterfactualLeg(t.side, t.snapshot, bars);
  const sign = t.side === 'long' ? 1 : -1;
  const setup = t.setup;
  const px = setup ? Number(setup.reference_price) : Number(bars[0]!.open);
  const stop = setup ? px - sign * Number(setup.stop_distance) : proxy.stop;
  const tp = setup ? px + sign * Number(setup.stop_distance) * setup.tp_r : proxy.tp;
  if (stop === null) return { ...t, status: 'unscoreable', settled_at: now, note: '无有效止损' };
  const input = { direction: t.side, entry: setup?.entry ?? 'market' as const, limit_price: setup?.entry === 'limit' ? px : null, stop, tp, bars: [...bars], atr: setup?.atr ?? t.snapshot.atr14, funding };
  const outcome = simulateOutcome(input);
  const scoreable = outcome.net_r != null;
  const exitAt = outcome.exit_at ?? bars[Math.max(0, outcome.exit_bar ?? bars.length-1)]!.close_time;
  const marks = outcomeEquityMarks(input, outcome);
  const leg: LedgerLeg = { stance: 'direction', direction: t.side, r: outcome.gross_r ?? null, status: scoreable ? outcome.status as LedgerLeg['status'] : 'unscoreable', fill: outcome.fill_price, stop, tp, bars_walked: outcome.bars_held ?? 0, note: outcome.note };
  return { ...t, equity_marks: marks, exit_at: exitAt, net_r: outcome.net_r ?? null, funding_estimated: outcome.funding_estimated ?? false, status: scoreable ? 'settled' : 'unscoreable', r: outcome.gross_r ?? null, leg, settled_at: now, note: outcome.note };

}

/**
 * 一批已结算虚拟线程 → {@link ShadowStats}。`max_drawdown_r` 是累计 R 曲线的峰-谷最大回撤(正数)。
 * 只数 `status='settled'` 且 `r !== null` 的(NULL 不是 0)。
 */
function aggregateShadow(threads: readonly ShadowThread[]): ShadowStats & { net_expectancy_r?: number | null; net_max_drawdown_r?: number | null } {
  const done = threads.filter((t) => t.status === 'settled' && t.r !== null).sort((a, b) => a.opened_at - b.opened_at);
  if (!done.length) return { ...EMPTY_SHADOW_STATS };
  const gross = effectiveReturns(done.map(t => ({ at: t.opened_at, net_r: t.r! })));
  const netComplete = done.every(t => t.net_r != null && Number.isFinite(t.net_r));
  const net = netComplete ? effectiveReturns(done.map(t => ({ at: t.opened_at, net_r: t.net_r! }))) : [];
  const total = done.reduce((sum,t) => sum+t.r!,0);
  const round = (n: number): number => Math.round(n * 10_000) / 10_000;
  return {
    net_expectancy_r: net.length ? net.reduce((a,b) => a+b,0)/net.length : null,
    net_max_drawdown_r: netComplete ? equityDrawdown(done.map(t => ({ exit_at: t.exit_at ?? t.settled_at ?? t.horizon_end_at, net_r: t.net_r!, ...(t.equity_marks ? { equity_marks: t.equity_marks } : {}) }))) : null,
    n: effectiveReturns(done.map(t => ({ at: t.opened_at, net_r: t.net_r ?? t.r! }))).length,
    win_rate: round(gross.filter(r => r > 0).length / gross.length),
    expectancy_r: round(gross.reduce((a,b) => a+b,0) / gross.length),
    raw_n: done.length,
    total_r: round(total),
    max_drawdown_r: round(equityDrawdown(done.map(t => ({ exit_at: t.exit_at ?? t.settled_at ?? t.horizon_end_at, net_r: t.r! })))),
    first_at: done[0]!.opened_at,
    last_at: done[done.length - 1]!.opened_at,
  };
}

/** 两本账分别展示，晋升只消费完整策略执行器的有效样本。 */
export function shadowStatsOf(threads: readonly ShadowThread[]): ShadowStats {
  const direction_proxy = aggregateShadow(threads.filter(t => t.score_kind !== 'full_strategy'));
  const full_strategy = aggregateShadow(threads.filter(t => t.score_kind === 'full_strategy'));
  return { ...full_strategy, direction_proxy, full_strategy };
}

export class ShadowThreadStore {
  constructor(private readonly db: DatabaseSync) {}

  save(t: ShadowThread): void {
    this.db
      .prepare(
        `INSERT INTO demo_shadow_thread(id, strategy_id, version, content_hash, symbol, timeframe, side, opened_at, horizon_end_at, status, r, settled_at, episode_id, json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, r = excluded.r, settled_at = excluded.settled_at, json = excluded.json`,
      )
      .run(t.id, t.strategy_id, t.version, t.content_hash, t.symbol, t.timeframe, t.side, t.opened_at, t.horizon_end_at, t.status, t.r, t.settled_at, t.episode_id, JSON.stringify(t));
  }

  get(id: string): ShadowThread | null {
    const r = this.db.prepare('SELECT json FROM demo_shadow_thread WHERE id = ?').get(id) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as ShadowThread) : null;
  }

  /** 这个策略版本的全部虚拟线程(新的在前)。 */
  forVersion(strategyId: string, version: number, limit = Number.MAX_SAFE_INTEGER): ShadowThread[] {
    const rows = this.db.prepare('SELECT json FROM demo_shadow_thread WHERE strategy_id = ? AND version = ? ORDER BY opened_at DESC LIMIT ?').all(strategyId, version, Math.max(1, limit)) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as ShadowThread);
  }

  /** 这个策略版本这个币上还开着的那条(同一时间只许一条,免得一根 K 线上重复计数)。 */
  openFor(strategyId: string, version: number, symbol: string, backend?: string, generation?: number): ShadowThread | null {
    const r = this.db.prepare("SELECT json FROM demo_shadow_thread WHERE strategy_id = ? AND version = ? AND symbol = ? AND status = 'open' AND COALESCE(json_extract(json, '$.backend'), '') = ? AND COALESCE(json_extract(json, '$.generation'), 0) = ?").get(strategyId, version, symbol, backend ?? '', generation ?? 0) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as ShadowThread) : null;
  }

  /** horizon 已到、还没结算的虚拟线程(最旧的先结)。 */
  pending(now: number, limit = 10): ShadowThread[] {
    const rows = this.db.prepare("SELECT json FROM demo_shadow_thread WHERE settled_at IS NULL AND horizon_end_at <= ? AND COALESCE(json_extract(json, '$.retry_after'), 0) <= ? ORDER BY horizon_end_at ASC LIMIT ?").all(now, now, Math.max(1, limit)) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as ShadowThread);
  }

  count(strategyId: string, version: number): number {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM demo_shadow_thread WHERE strategy_id = ? AND version = ?').get(strategyId, version) as { n: number };
    return Number(r.n);
  }
}

// ---------------------------------------------------------------- Lab 探针队列(§1.3)

export type ProbeQueueStatus = 'queued' | 'verified' | 'rejected';

export interface LabProbeItem {
  id: string;
  strategy_id: string;
  param: string;
  value: number;
  source: 'attribution' | 'human';
  source_ref: string | null;
  queued_at: number;
  status: ProbeQueueStatus;
  checked_at: number | null;
  note: string | null;
}

export class LabProbeQueue {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * 入队一条待验证的参数提案。**这不是采纳**:值要等下一轮 Lab 在同一份数据上跑出来达标,
   * 才由 labAutopilot 落成 draft 新版本。同一 (策略, 参数, 值) 还在队里就不重复入队。
   */
  enqueue(inp: { strategy_id: string; param: string; value: number; source: LabProbeItem['source']; source_ref?: string | null; now?: number }): LabProbeItem | null {
    const now = inp.now ?? Date.now();
    const existing = this.db.prepare("SELECT id FROM demo_lab_probe_queue WHERE strategy_id = ? AND param = ? AND value = ? AND status = 'queued'").get(inp.strategy_id, inp.param, inp.value) as { id: string } | undefined;
    if (existing) return null;
    const item: LabProbeItem = {
      id: `probe-${now.toString(36)}${randomBytes(3).toString('hex')}`,
      strategy_id: inp.strategy_id,
      param: inp.param,
      value: inp.value,
      source: inp.source,
      source_ref: inp.source_ref ?? null,
      queued_at: now,
      status: 'queued',
      checked_at: null,
      note: null,
    };
    this.db
      .prepare('INSERT INTO demo_lab_probe_queue(id, strategy_id, param, value, source, source_ref, queued_at, status, checked_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(item.id, item.strategy_id, item.param, item.value, item.source, item.source_ref, item.queued_at, item.status, item.checked_at, item.note);
    return item;
  }

  queued(limit = 50): LabProbeItem[] {
    const rows = this.db.prepare("SELECT * FROM demo_lab_probe_queue WHERE status = 'queued' ORDER BY queued_at ASC LIMIT ?").all(Math.max(1, limit)) as Record<string, unknown>[];
    return rows.map(toProbe);
  }

  list(limit = 100): LabProbeItem[] {
    const rows = this.db.prepare('SELECT * FROM demo_lab_probe_queue ORDER BY queued_at DESC LIMIT ?').all(Math.max(1, limit)) as Record<string, unknown>[];
    return rows.map(toProbe);
  }

  resolve(id: string, status: Exclude<ProbeQueueStatus, 'queued'>, note: string, now = Date.now()): void {
    this.db.prepare('UPDATE demo_lab_probe_queue SET status = ?, checked_at = ?, note = ? WHERE id = ?').run(status, now, note.slice(0, 300), id);
  }
}

function toProbe(r: Record<string, unknown>): LabProbeItem {
  return {
    id: String(r['id']),
    strategy_id: String(r['strategy_id']),
    param: String(r['param']),
    value: Number(r['value']),
    source: String(r['source']) as LabProbeItem['source'],
    source_ref: r['source_ref'] === null || r['source_ref'] === undefined ? null : String(r['source_ref']),
    queued_at: Number(r['queued_at']),
    status: String(r['status']) as ProbeQueueStatus,
    checked_at: r['checked_at'] === null || r['checked_at'] === undefined ? null : Number(r['checked_at']),
    note: r['note'] === null || r['note'] === undefined ? null : String(r['note']),
  };
}

// ---------------------------------------------------------------- 状态机一轮(纯编排,零模型)

export interface LoopAction {
  strategy_id: string;
  version: number;
  kind: 'promote' | 'demote';
  from: StrategyStatus;
  to: StrategyStatus;
  reason: string;
  evidence: Record<string, number | null>;
}

export interface LoopResult {
  actions: LoopAction[];
  /** 因为降级而必须从 `workflow.active_strategies` 里移出的策略 id。 */
  deactivate: string[];
}

export interface LoopDeps {
  allow_promotions?: boolean;
  backend?: string;
  active_ids?: string[];
  now?: number;
  /**
   * 一条策略已结算交易的 R,**从旧到新**。默认实现读真实平仓线程(reviewer 的 tradeCard 口径);
   * 测试可以直接喂数字。
   */
  realizedR?: (strategyId: string, version: number, backend: string) => number[];
  log?: (level: 'info' | 'warn', message: string) => void;
}

/** `paper` 及以上 = 真的在跑的状态(降级只看这些)。 */
export function isLive(status: StrategyStatus): boolean {
  return STATUS_ORDER.indexOf(status) >= STATUS_ORDER.indexOf('paper');
}

/**
 * 跑一轮状态机:先降级(坏消息优先),再自动晋升。每一步都落一行台账。
 * **只动 head**,paper → live_capped 仍然只能人批(这里不碰)。
 */
export function runStrategyLoop(store: DemoStore, deps: LoopDeps = {}): LoopResult {
  const now = deps.now ?? Date.now();
  const lib = store.strategies;
  const backend = deps.backend ?? 'paper';
  const realized = deps.realizedR ?? ((id: string, version: number) => realizedRFromThreads(store, id, version, backend));
  const out: LoopResult = { actions: [], deactivate: [] };

  // 1. 降级:paper / live_capped 连续劣化 → 退回 backtest 重来(不是 retired)
  for (const head of lib.resolve(deps.active_ids ?? lib.list().map(s => s.id), { backend }).specs) {
    if (!isLive(head.status)) continue;
    const d = degradeDecision(realized(head.id, head.version, backend));
    if (!d.degrade) continue;
    const r = lib.demote(head.id, 'backtest', { version: head.version, ...(deps.backend ? { backend } : {}), now });
    if (!r.spec) {
      deps.log?.('warn', `${head.id} 该降级但没降成:${r.error}`);
      continue;
    }
    const evidence = { n: d.n, expectancy_r: d.expectancy_r, loss_streak: d.loss_streak };
    out.actions.push({ strategy_id: head.id, version: head.version, kind: 'demote', from: head.status, to: 'backtest', reason: d.reason, evidence });
    out.deactivate.push(head.id);
    store.strategyEvents.append({ strategy_id: head.id, version: head.version, at: now, who: 'code', kind: 'demote', from_status: head.status, to_status: 'backtest', reason: d.reason, evidence });
    deps.log?.('warn', `${head.id} v${head.version} 降级 ${head.status} → backtest:${d.reason}`);
  }

  if (deps.allow_promotions === false) return out;

  // 2. shadow → paper 自动(门全在 shadowToPaperGate)
  for (const raw of lib.list().flatMap(h => lib.versions(h.id))) {
    const head = deps.backend ? strategyForBackend(raw, backend) : raw;
    if (head.status !== 'shadow') continue;
    const block = shadowToPaperGate(head);
    if (block) continue;
    const r = lib.promote(head.id, 'paper', { version: head.version, ...(deps.backend ? { backend } : {}) });
    if (!r.spec) {
      deps.log?.('warn', `${head.id} 影子数据够格但没晋成 paper:${r.error}`);
      continue;
    }
    const sh = head.lab_stats?.shadow ?? null;
    const reason = `影子实盘 ${sh?.n ?? 0} 笔,期望 ${sh?.expectancy_r?.toFixed(2) ?? 'n/a'}R,最大回撤 ${sh?.max_drawdown_r?.toFixed(2) ?? 'n/a'}R`;
    const evidence = { shadow_n: sh?.n ?? null, shadow_expectancy_r: sh?.expectancy_r ?? null, shadow_max_drawdown_r: sh?.max_drawdown_r ?? null, lab_expectancy_r: head.lab_stats?.expectancy_r ?? null };
    out.actions.push({ strategy_id: head.id, version: head.version, kind: 'promote', from: 'shadow', to: 'paper', reason, evidence });
    store.strategyEvents.append({ strategy_id: head.id, version: head.version, at: now, who: 'code', kind: 'promote', from_status: 'shadow', to_status: 'paper', reason, evidence });
    deps.log?.('info', `${head.id} v${head.version} 自动晋升 shadow → paper:${reason}`);
  }

  return out;
}

/** 一条已平线程的结算够不够完整:新字段优先,旧行(生产端不写 status)退回完整性判据。 */
export function settlementComplete(t: StrategyThread): boolean {
  const declared = t.settlement?.status;
  if (declared) return declared === 'complete';
  return settlementCompleteness(t).status === 'complete';
}

/**
 * 真实平仓线程里这条策略的 R 序列(从旧到新);口径与 reviewer 的 tradeCard 一致。
 * **降级(strategy-loop)与轮换(allocator)共用这一个 helper** —— 09-12 复审的缺口 3 就是两边
 * 各写了一套判据:一边不带 version/backend、一边要求 `settlement.status==='complete'`,而生产端
 * `runtime.settleThread` 根本不写这个字段,于是标准线程被判据 A 全收、被判据 B 全排空。
 *
 * 统一后的判据:
 *  - version:传了就按它过滤,但**线程上没记版本的旧行照收**(否则默认种子的全部成交直接归零);
 *  - backend:`closedThreads` 已按通道取,线程上没记 backend 的旧行同样照收;
 *  - 完整性:优先信 `settlement.status`,没有这个字段就用 {@link settlementCompleteness} 判
 *    (它按 trades/exit_price/资金费告警判,是账本那边已经在用的同一套口径)。
 */
export function realizedRFromThreads(store: DemoStore, strategyId: string, version?: number, backend = 'paper'): number[] {
  const spec = version === undefined ? null : store.strategies.version(strategyId, version);
  const since = spec?.health_by_backend?.[backend]?.window_from ?? 0;
  const rows = store.closedThreads(Number.MAX_SAFE_INTEGER, backend).filter((t) =>
    (t.strategy_id ?? null) === strategyId
    && (version === undefined || t.strategy_version == null || t.strategy_version === version)
    && (t.backend == null || t.backend === backend)
    && settlementComplete(t)
    && (t.closed_at ?? t.updated_at) >= since);
  const out: { at: number; r: number }[] = [];
  for (const t of rows) {
    const entry = Number(t.filled_avg_price ?? '');
    const stop = Number(t.stop_price ?? '');
    const qty = Number(t.qty ?? '');
    const pnl = t.settlement?.net_pnl == null ? null : Number(t.settlement.net_pnl);
    if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(qty) || qty <= 0) continue;
    const risk = Number(t.settlement?.initial_risk_usdt ?? '') || Math.abs(entry - stop) * qty;
    if (!(risk > 0)) continue;
    let r: number | null = null;
    if (pnl !== null && Number.isFinite(pnl)) r = pnl / risk;
    else {
      const exit = t.exit_price === null || t.exit_price === undefined || t.exit_price === '' ? null : Number(t.exit_price);
      if (exit !== null && Number.isFinite(exit)) r = ((t.side === 'long' ? exit - entry : entry - exit) * qty) / risk;
    }
    if (r === null || !Number.isFinite(r)) continue;
    out.push({ at: t.closed_at ?? t.updated_at, r });
  }
  return out.sort((a, b) => a.at - b.at).map((x) => x.r);
}

// ---------------------------------------------------------------- 影子结算巡检(runtime 钩子)

export interface ShadowSettleDeps {
  shouldStop?: () => boolean;
  fetchFunding?: (symbol: string, from: number) => Promise<{ at: number; rate: string }[]>;
  now?: number;
  limit?: number;
  fetchKlines: (symbol: string, tf: string, limit: number, endTime?: number) => Promise<Kline[]>;
  log?: (level: 'info' | 'warn', message: string, data?: unknown) => void;
}

export interface ShadowSettleResult {
  settled: number;
  errors: number;
  /** 结算后重算过 `lab_stats.shadow` 的版本。 */
  updated: { strategy_id: string; version: number; stats: ShadowStats }[];
}

/**
 * runtime 巡检:到期的虚拟线程拉一次公共 K 线结算,再把该版本的影子成绩整体重算写回
 * `lab_stats.shadow`。零模型、只读公共行情、不碰账户。失败只记日志,绝不影响交易。
 */
export async function settleShadowThreads(store: DemoStore, deps: ShadowSettleDeps): Promise<ShadowSettleResult> {
  const now = deps.now ?? Date.now();
  const out: ShadowSettleResult = { settled: 0, errors: 0, updated: [] };
  const touched = new Map<string, { strategy_id: string; version: number; backend?: string }>();
  for (const t of store.shadowThreads.pending(now, deps.limit ?? 5)) {
    if (deps.shouldStop?.()) break;
    let bars: Kline[] = [];
    try {
      const tfMs = tfToMs(t.timeframe);
      bars = await deps.fetchKlines(t.symbol, t.timeframe, (t.horizon_bars ?? SHADOW_HORIZON_BARS) + 10, t.horizon_end_at + tfMs);
    } catch (e) {
      out.errors++;
      deps.log?.('warn', `${t.symbol} 影子线程取 K 线失败:${(e as Error).message}`, { shadow_id: t.id });
      continue;
    }
    if (deps.shouldStop?.()) break;
    // 只走 opened_at 之后的那段:bars[0] 必须是判断之后的第一根(与判断账本同口径)。
    const after = bars.filter((b) => b.open_time > t.opened_at);
    let funding: { at: number; rate: string }[] = [];
    if (deps.fetchFunding) { try { funding = await deps.fetchFunding(t.symbol, t.opened_at); } catch (e) { out.errors++; deps.log?.('warn', `影子资金费数据失败:${(e as Error).message}`); continue; } }
    if (deps.shouldStop?.()) break;
    const settled = settleShadowThread(t, after, now, funding);
    store.shadowThreads.save(settled);
    if (settled.status === 'open') continue;
    out.settled++;
    touched.set(`${t.strategy_id}@${t.version}:${t.backend ?? ''}`, { strategy_id: t.strategy_id, version: t.version, ...(t.backend ? { backend: t.backend } : {}) });
  }
  for (const { strategy_id, version, backend } of touched.values()) {
    const spec = store.strategies.version(strategy_id, version);
    const stats = shadowStatsOf(store.shadowThreads.forVersion(strategy_id, version).filter(t => t.content_hash === spec?.content_hash && t.backend === backend && t.opened_at >= (backend ? spec?.health_by_backend?.[backend]?.window_from ?? 0 : spec?.shadow_window_from ?? 0) && (t.generation ?? 0) === (backend ? spec?.health_by_backend?.[backend]?.generation ?? 0 : spec?.shadow_generation ?? 0)));
    store.strategies.updateShadowStats(strategy_id, version, stats, backend);
    out.updated.push({ strategy_id, version, stats });
  }
  if (out.settled) deps.log?.('info', `影子线程结算 ${out.settled} 条,重算 ${out.updated.length} 个版本的影子成绩`);
  return out;
}
