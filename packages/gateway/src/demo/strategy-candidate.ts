/**
 * CandidateV0 影子候选(docs/research/candidate-v0-2026-09-23.md;设计 strategy-apply-spec §10、
 * judgment-exit-redesign §4 方案 B / §7 第 3 条;契约 v3-ui-contract §9.50)。
 *
 * 目的:证明「研究台 StrategyIR 定义几何、模型只做过滤」有前向证据。每根策略周期收盘时,代码用
 * `irCandidate` 在 watchlist 上算做多候选(方向 / 入场参考 / 止损 / 目标 / 失效线 / RR),落 demo_strategy_candidate;
 * 同一币同一时段模型的判断(demo_episodes)配对记下;到期(48 根)后按计划腿与吊灯腿结算。
 *
 * 硬约束:零下单、零模型调用、只写 demo_strategy_candidate 一张表;导入本模块没有任何副作用
 * (模块级只有两个进程内节流变量),运行时钩子挂上之前完全惰性。能力子集钉死为
 * `long-only / next_open_market / 单目标 / 机械退出`;IR 要求而这里做不到的一律进 `unmapped[]`,不近似。
 *
 * 与研究引擎的关系:候选直接调 research/strategy.ts 的 `irCandidate`(不复制);视图长度用 engine.ts 的
 * `viewBars`。PrimitiveContext 的构造(最近 W 根已收盘 bar、i = 最后一根、timeframe_ms)在 engine.ts 里是
 * runReplay 循环体内的内联表达式,没有导出的 helper —— `researchContext()` 按同一口径重写了这三行(见文档「重复」一节)。
 * 吊灯腿与 scripts/ledger-backfill.ts 的 `walkChandelier` 同口径;那个脚本有顶层副作用不能 import,这里用
 * outcome.ts 的 openTrade/stepTrade 重写了同一个循环。
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ResearchBar, ResearchPolicy, StrategyIR, StrategyPrimitive } from '@trading-swarm/contracts';
import { irCandidate, policyToIR, strategyNodes, orderNodes, timeframeMillis } from './research/strategy.js';
import { viewBars } from './research/engine.js';
import { hash } from './research/primitives.js';
import type { PrimitiveContext } from './research/primitives/registry.js';
import { fetchKlines } from './market.js';
import { openTrade, simulateOutcome, stepTrade, tradeR } from './outcome.js';
import type { Kline } from './types.js';

// ---------------------------------------------------------------- constants

export const CANDIDATE_VERSION = 'candidate-v0';
/** 结算窗口:48 根(与判断账本 MECHANICAL_HORIZON_BARS 同口径)。IR 有更短的 time_stop 时取更短的。 */
export const CANDIDATE_HORIZON_BARS = 48;
/** 吊灯腿:入场起 HH − 3×ATR22,只收紧、无目标(ledger-backfill 的对照腿)。 */
export const TRAIL_ATR_PERIOD = 22;
export const TRAIL_ATR_MULT = 3;
/** 影子只接受 ≤ 1h 的研究策略;更慢的周期前向证据攒得太慢。 */
export const SHADOW_MAX_TIMEFRAME_MS = 3_600_000;
/** 合成 IR 的 strategy_id(研究台没有 ≤1h 的 long-only 版本时用)。 */
export const SYNTH_STRATEGY_ID = 'synth:donchian_close_long_v1:1h';
/** 旧 donchian_close_long_v1 策略的缺省参数(研究台 defaultIR 同一组:20 根通道、1.2 倍量、ATR14×2 止损、2R 目标)。 */
export const SYNTH_POLICY: ResearchPolicy = {
  label: '1h 唐奇安收盘突破(CandidateV0 影子)',
  description: '收盘价突破此前 20 根最高价且成交量 ≥ 20 根均量 1.2 倍,下一根开盘市价做多;止损 = 收盘 − 2×ATR14,目标 = 2R,最多持有 48 根。',
  interpretation: 'donchian_close_long_v1',
  lookback: 20,
  volume_multiple: 1.2,
  atr_period: 14,
  stop_atr: 2,
  take_profit_r: 2,
  holding_bars: CANDIDATE_HORIZON_BARS,
};

// ---------------------------------------------------------------- types

export interface ShadowIR {
  strategy_id: string;
  version: number;
  ir_hash: string;
  timeframe: string;
  ir: StrategyIR;
  source: 'research_strategy_version' | 'synthesized_legacy';
  label: string;
  /** IR 静态检查出来的做不到的部分(每个候选原样带上)。 */
  unmapped: string[];
  horizon_bars: number;
  /** 为什么选了这条(或为什么研究台版本都不合格)。 */
  pick_note: string;
}

export type PairBucket = 'propose_same' | 'propose_opposite' | 'no_trade' | 'watch' | 'review' | 'no_judgment' | 'no_episode';

export interface ModelPairing {
  status: 'matched' | 'none';
  bucket: PairBucket;
  episode_id: string | null;
  at: number | null;
  as_of: number | null;
  mode: 'scan' | 'review' | null;
  action: string | null;
  direction: string | null;
  strategy_id: string | null;
  trigger: string | null;
  /** 最终闸结果:没过的闸名(空 = 全过或没到闸)。 */
  gates_failed: string[];
  /** 闸后是否真的生成了 intent(= 最终放行)。 */
  intent: boolean;
  matched_at: number;
}

export interface CandidateLeg {
  status: string;
  r: number | null;
  net_r?: number | null;
  fill_price: number | null;
  exit_price: number | null;
  bars_held: number | null;
  mae_r?: number | null;
  mfe_r?: number | null;
}

export interface CandidateSettlement {
  source: 'plan_walk' | 'invalid' | 'unscoreable';
  settled_at: number;
  horizon_bars: number;
  bars_seen: number;
  plan: CandidateLeg | null;
  trail: CandidateLeg | null;
  note: string;
}

export interface StrategyCandidate {
  id: string;
  version_tag: typeof CANDIDATE_VERSION;
  at: number;
  /** 信号根收盘时刻 = open_time + 周期(整点边界);入场在下一根 open。 */
  as_of: number;
  symbol: string;
  timeframe: string;
  strategy_id: string;
  version: number;
  ir_hash: string;
  ir_source: ShadowIR['source'];
  /** online = 运行时钩子实时生成;replay = scripts/candidate-replay.ts 在库副本上离线回放(不是前向证据)。 */
  origin: 'online' | 'replay';
  direction: 'long';
  entry_type: 'next_open_market';
  /** 信号根收盘价(irCandidate 的几何锚);真实成交按下一根 open,结算时记 fill_price。 */
  entry_ref: number;
  stop: number;
  target: number | null;
  target_source: 'fixed_r_target' | 'structure_target' | null;
  rr: number | null;
  /** 单线规则:失效线 = 止损(spec §4 方案 B「risk.stop → 硬止损与失效线」)。 */
  invalidation: number;
  horizon_bars: number;
  reason: string;
  unmapped: string[];
  view_bars: number;
  status: 'open' | 'settled';
  model: ModelPairing | null;
  settlement: CandidateSettlement | null;
}

export type KlinesLoader = (symbol: string, tf: string, limit: number, endTime?: number) => Promise<Kline[]>;
export type CandidateLog = (level: 'info' | 'warn', message: string, data?: unknown) => void;

// ---------------------------------------------------------------- IR selection

const TARGETS = new Set(['fixed_r_target', 'structure_target']);
/** 计划腿不模拟、但也不影响候选几何的出场原语(持仓管理) → 进 unmapped,写清楚。 */
function exitNote(x: StrategyPrimitive): string {
  if (x.primitive === 'chandelier_trail') {
    const same = Number(x.params.atr_period) === TRAIL_ATR_PERIOD && Number(x.params.multiple) === TRAIL_ATR_MULT;
    return same
      ? 'exit:chandelier_trail 计划腿不追踪;由吊灯腿(ATR22×3)单独结算'
      : `exit:chandelier_trail(ATR${String(x.params.atr_period)}×${String(x.params.multiple)}) 未模拟;吊灯腿固定用 ATR22×3 对照`;
  }
  return `exit:${x.primitive} 未模拟(V0 计划腿只认止损/单目标/time_stop)`;
}

/** IR 静态检查:做不到的全列出来。`eligible=false` 的 IR 不能拿来做影子(会系统性不出候选或方向不对)。 */
export function analyzeIR(ir: StrategyIR): { unmapped: string[]; eligible: boolean; horizon_bars: number; why: string[] } {
  const unmapped: string[] = [];
  const why: string[] = [];
  if (ir.entry.primitive !== 'next_open_market') unmapped.push(`entry:${ir.entry.primitive} 未支持(V0 只做 next_open_market)`);
  if (ir.universe?.screen) {
    unmapped.push('universe.screen 线上没有筛选行,候选永远不会触发');
    why.push('universe_screen');
  }
  const targets = ir.exit.filter((x) => TARGETS.has(x.primitive));
  if (targets.length > 1) unmapped.push(`exit:${targets.map((x) => x.primitive).join('+')} 多目标;V0 单目标,irCandidate 取 fixed_r 最小值,其次 structure_target`);
  for (const x of ir.exit) if (!TARGETS.has(x.primitive) && x.primitive !== 'time_stop') unmapped.push(exitNote(x));
  const times = ir.exit.filter((x) => x.primitive === 'time_stop').map((x) => Number(x.params.bars)).filter((n) => Number.isFinite(n) && n > 0);
  const horizon = Math.min(CANDIDATE_HORIZON_BARS, ...times);
  if (times.length && Math.min(...times) > CANDIDATE_HORIZON_BARS) unmapped.push(`exit:time_stop(${Math.min(...times)}) 长于 V0 结算窗口 ${CANDIDATE_HORIZON_BARS} 根,按 ${CANDIDATE_HORIZON_BARS} 根收盘结算`);
  const o = ir.order;
  if (o) {
    if (o.direction !== 'long') why.push(`order.direction=${o.direction}`);
    if (o.market === 'perp' && o.leverage && o.leverage > 1) unmapped.push(`order.leverage=${o.leverage} 未用(R 口径与杠杆无关)`);
    if (o.entry && o.entry.type !== 'market') unmapped.push(`order.entry.type=${o.entry.type} 未支持(V0 市价)`);
    if (o.take_profits?.length) unmapped.push(`order.take_profits(${o.take_profits.length} 档) 未支持(V0 单目标取 exit[])`);
    if (o.min_rr !== undefined) unmapped.push(`order.min_rr=${o.min_rr} 未执行(候选只记 rr,不按 rr 拒)`);
    if (o.short_signal?.length || o.short_regime) why.push('order.short_*');
    for (const k of Object.keys(o)) if (!['direction', 'market', 'leverage', 'entry', 'take_profits', 'min_rr', 'short_signal', 'short_regime'].includes(k)) unmapped.push(`order.${k} 未支持`);
  }
  const all = [...strategyNodes(ir), ...orderNodes(ir)];
  const pine = all.filter(({ node }) => node.primitive.startsWith('pine_'));
  if (pine.length) {
    unmapped.push(...pine.map(({ node, category }) => `${category}:${node.primitive} 线上影子不跑 Pine 引擎`));
    why.push('pine');
  }
  if (ir.signal.some((x) => x.params.direction === 'down')) why.push('signal_direction_down');
  return { unmapped, eligible: why.length === 0, horizon_bars: horizon, why };
}

function synthShadow(note: string): ShadowIR {
  const ir = policyToIR(SYNTH_POLICY);
  const a = analyzeIR(ir);
  return { strategy_id: SYNTH_STRATEGY_ID, version: 1, ir_hash: hash(ir), timeframe: '1h', ir, source: 'synthesized_legacy', label: SYNTH_POLICY.label, unmapped: a.unmapped, horizon_bars: a.horizon_bars, pick_note: note };
}

/**
 * 选要影子的 IR。优先研究台的策略版本(research_strategy_versions 的当前版本,周期 ≤ 1h、long-only、无 Pine、无 screen、
 * 没归档;状态 live > paper > backtested > draft,同级取最近更新);一条都不合格就合成 1h 唐奇安突破
 * (旧 `donchian_close_long_v1` 策略经 `policyToIR`,即实盘声称在做的经典突破)。只读。
 */
export function loadIRForShadow(db: DatabaseSync): ShadowIR {
  let rows: { id: string; name: string; status: string; timeframe: string; version: number; ir_hash: string; ir_json: string }[] = [];
  try {
    rows = db
      .prepare(
        `SELECT s.id, s.name, s.status, s.timeframe, v.version, v.ir_hash, v.ir_json
         FROM research_strategies s JOIN research_strategy_versions v ON v.strategy_id = s.id AND v.version = s.current_version
         WHERE s.status != 'archived'`,
      )
      .all() as typeof rows;
  } catch {
    return synthShadow('研究台表不存在,合成 1h 唐奇安突破');
  }
  const rank: Record<string, number> = { live: 0, paper: 1, published: 2, backtested: 3, draft: 4 };
  const skipped: string[] = [];
  const ok: (ShadowIR & { rank: number })[] = [];
  for (const r of rows) {
    let tfMs: number;
    try {
      tfMs = timeframeMillis(r.timeframe);
    } catch {
      skipped.push(`${r.id}:bad_tf`);
      continue;
    }
    if (tfMs > SHADOW_MAX_TIMEFRAME_MS) {
      skipped.push(`${r.id}:${r.timeframe}`);
      continue;
    }
    let ir: StrategyIR;
    try {
      ir = JSON.parse(r.ir_json) as StrategyIR;
    } catch {
      skipped.push(`${r.id}:bad_json`);
      continue;
    }
    const a = analyzeIR(ir);
    if (!a.eligible) {
      skipped.push(`${r.id}:${a.why.join('+')}`);
      continue;
    }
    ok.push({ strategy_id: r.id, version: r.version, ir_hash: r.ir_hash || hash(ir), timeframe: r.timeframe, ir, source: 'research_strategy_version', label: r.name, unmapped: a.unmapped, horizon_bars: a.horizon_bars, pick_note: `研究台 ${r.status} 版本`, rank: rank[r.status] ?? 9 });
  }
  if (ok.length) {
    // TG_CANDIDATE_SHADOW_STRATEGY=<rs_id> 钉住影子输入(研究台导入多条合格策略时不让排序换掉样本口径);钉的不合格就按排序取。
    const pin = process.env['TG_CANDIDATE_SHADOW_STRATEGY'];
    const pinned = pin ? ok.find((o) => o.strategy_id === pin) : undefined;
    ok.sort((a, b) => a.rank - b.rank);
    const { rank: _rank, ...best } = pinned ?? ok[0]!;
    return best;
  }
  const tfs = [...new Set(skipped.map((s) => s.split(':').slice(1).join(':')))].slice(0, 6).join(', ');
  return synthShadow(`研究台 ${rows.length} 条当前版本都不合格(${tfs || '无'}),合成 1h 唐奇安突破`);
}

// ---------------------------------------------------------------- generation

const r8 = (n: number): number => Number(n.toFixed(8));
const r4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** 已收盘的 K 线 → ResearchBar(与 research/market-dataset.ts 同口径:close_time = available_at = open_time + 周期 − 1)。 */
export function toResearchBars(klines: readonly Kline[], tfMs: number, now: number): ResearchBar[] {
  const seen = new Set<number>();
  return klines
    .filter((k) => k.open_time + tfMs <= now && !seen.has(k.open_time) && (seen.add(k.open_time), true))
    .sort((a, b) => a.open_time - b.open_time)
    .map((k) => ({ open_time: k.open_time, close_time: k.open_time + tfMs - 1, available_at: k.open_time + tfMs - 1, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume }));
}

/**
 * 研究引擎 runReplay 对第 i 根的 ctx 口径:最近 W 根(含 i)、i = 最后一根、timeframe_ms;高周期原语从基础周期
 * bar 自己聚合,不需要另给高周期 K 线。engine.ts 里这是内联表达式(没有导出 helper),这里重写同样三行。
 */
export function researchContext(bars: ResearchBar[], w: number, timeframe_ms: number): PrimitiveContext {
  const view = bars.slice(Math.max(0, bars.length - w));
  return { bars: view, i: view.length - 1, timeframe_ms };
}

export function candidateId(strategy_id: string, version: number, symbol: string, as_of: number): string {
  return `cand_${createHash('sha256').update(`${strategy_id}|${version}|${symbol}|${as_of}`).digest('hex').slice(0, 20)}`;
}

export interface GenerateInput {
  shadow: ShadowIR;
  symbol: string;
  /** 按周期给的 K 线;只读 shadow.timeframe 那一份(高周期由原语自己聚合)。 */
  klines: Record<string, readonly Kline[]>;
  now: number;
  origin?: StrategyCandidate['origin'];
}

export interface GenerateResult {
  candidate: StrategyCandidate | null;
  reason: string;
  as_of: number | null;
  view_bars: number;
}

/** 对最后一根已收盘 bar 跑 irCandidate;有入场就给出代码算的几何。纯函数(不碰库、不联网)。 */
export function generateCandidates(inp: GenerateInput): GenerateResult {
  const { shadow, symbol, now } = inp;
  const tfMs = timeframeMillis(shadow.timeframe);
  const bars = toResearchBars(inp.klines[shadow.timeframe] ?? [], tfMs, now);
  const w = viewBars(shadow.ir, SYNTH_POLICY, tfMs);
  if (!bars.length) return { candidate: null, reason: 'no_closed_bars', as_of: null, view_bars: 0 };
  const lastBar = bars[bars.length - 1]!;
  const as_of = lastBar.open_time + tfMs;
  const ctx = researchContext(bars, w, tfMs);
  let out: ReturnType<typeof irCandidate>;
  try {
    out = irCandidate(shadow.ir, ctx);
  } catch (e) {
    return { candidate: null, reason: `ir_error:${(e as Error).message}`, as_of, view_bars: ctx.bars.length };
  }
  if (!out.entry) return { candidate: null, reason: out.reason, as_of, view_bars: ctx.bars.length };
  const entry_ref = Number(lastBar.close);
  const stop = Number(out.entry.stop);
  const target = out.entry.target === null ? null : Number(out.entry.target);
  if (!(stop > 0 && stop < entry_ref)) return { candidate: null, reason: 'invalid_stop', as_of, view_bars: ctx.bars.length };
  const hasFixed = shadow.ir.exit.some((x) => x.primitive === 'fixed_r_target');
  const target_source = target === null ? null : hasFixed ? 'fixed_r_target' : 'structure_target';
  const unmapped = [...shadow.unmapped];
  // 结构目标可能落在入场价下方(阻力块在价下):不是合法目标,记下来而不是改它。
  const targetOk = target !== null && target > entry_ref;
  if (target !== null && !targetOk) unmapped.push(`target ${r8(target)} ≤ entry_ref ${r8(entry_ref)}:${target_source} 给出的目标不在入场上方,按无目标处理`);
  const tgt = targetOk ? target : null;
  const rr = tgt !== null ? r4((tgt - entry_ref) / (entry_ref - stop)) : null;
  return {
    as_of,
    view_bars: ctx.bars.length,
    reason: out.reason,
    candidate: {
      id: candidateId(shadow.strategy_id, shadow.version, symbol, as_of),
      version_tag: CANDIDATE_VERSION,
      at: now,
      as_of,
      symbol,
      timeframe: shadow.timeframe,
      strategy_id: shadow.strategy_id,
      version: shadow.version,
      ir_hash: shadow.ir_hash,
      ir_source: shadow.source,
      origin: inp.origin ?? 'online',
      direction: 'long',
      entry_type: 'next_open_market',
      entry_ref: r8(entry_ref),
      stop: r8(stop),
      target: tgt === null ? null : r8(tgt),
      target_source: tgt === null ? null : target_source,
      rr,
      invalidation: r8(stop),
      horizon_bars: shadow.horizon_bars,
      reason: `${shadow.label}:${out.entry.reason}`,
      unmapped,
      view_bars: ctx.bars.length,
      status: 'open',
      model: null,
      settlement: null,
    },
  };
}

// ---------------------------------------------------------------- persistence

/** 同一 (strategy_id, version, symbol, as_of) 只落一条;返回是否新插入。 */
export function persistCandidate(db: DatabaseSync, c: StrategyCandidate): boolean {
  const tfMs = timeframeMillis(c.timeframe);
  const r = db
    .prepare(
      `INSERT OR IGNORE INTO demo_strategy_candidate(id, at, as_of, symbol, timeframe, strategy_id, version, ir_hash, json, settle_due_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(c.id, c.at, c.as_of, c.symbol, c.timeframe, c.strategy_id, c.version, c.ir_hash, JSON.stringify(c), c.as_of + c.horizon_bars * tfMs);
  return Number(r.changes) > 0;
}

function readCandidate(json: string): StrategyCandidate {
  return JSON.parse(json) as StrategyCandidate;
}

export function listCandidates(db: DatabaseSync, q: { limit?: number; cursor?: string | null; symbol?: string | null; strategy_id?: string | null } = {}): { rows: StrategyCandidate[]; next_cursor: string | null } {
  const limit = Math.min(500, Math.max(1, Math.floor(q.limit ?? 100) || 100));
  const where: string[] = [];
  const args: (string | number)[] = [];
  const cur = q.cursor ? /^(\d+)_(cand_[0-9a-f]+)$/.exec(q.cursor) : null;
  if (cur) {
    where.push('(as_of < ? OR (as_of = ? AND id < ?))');
    args.push(Number(cur[1]), Number(cur[1]), cur[2]!);
  }
  if (q.symbol) {
    where.push('symbol = ?');
    args.push(q.symbol);
  }
  if (q.strategy_id) {
    where.push('strategy_id = ?');
    args.push(q.strategy_id);
  }
  const sql = `SELECT json FROM demo_strategy_candidate ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY as_of DESC, id DESC LIMIT ?`;
  const rows = (db.prepare(sql).all(...args, limit + 1) as { json: string }[]).map((r) => readCandidate(r.json));
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return { rows: page, next_cursor: more && last ? `${last.as_of}_${last.id}` : null };
}

// ---------------------------------------------------------------- model pairing

interface EpisodeLite {
  id: string;
  at: number;
  as_of?: number;
  symbol: string;
  thread_id: string | null;
  trigger?: { kind?: string };
  judgment?: { action?: string; direction?: string | null; strategy_id?: string | null } | null;
  gates?: { name: string; passed: boolean }[];
  intent?: unknown;
}

function bucketOf(ep: EpisodeLite | null): PairBucket {
  if (!ep) return 'no_episode';
  if (ep.thread_id) return 'review';
  const a = ep.judgment?.action;
  if (!a) return 'no_judgment';
  if (a === 'PROPOSE') return ep.judgment?.direction === 'long' ? 'propose_same' : 'propose_opposite';
  if (a === 'WATCH') return 'watch';
  if (a === 'NO_TRADE') return 'no_trade';
  return 'review';
}

/**
 * 候选 × 模型判断配对:同一币、episode.as_of 落在候选 as_of ± 1 根策略周期内,取离得最近的(同距先扫描后复查)。
 * 窗口内没有 episode = 模型根本没被问(D6 漏斗的另一面),记 bucket='no_episode'。只读 demo_episodes。
 */
export function matchModelEpisode(db: DatabaseSync, c: Pick<StrategyCandidate, 'symbol' | 'as_of' | 'timeframe'>, now: number): ModelPairing {
  const tfMs = timeframeMillis(c.timeframe);
  const rows = db
    .prepare(`SELECT json FROM demo_episodes WHERE at BETWEEN ? AND ? AND json_extract(json, '$.symbol') = ?`)
    .all(c.as_of - 2 * tfMs, c.as_of + 2 * tfMs, c.symbol) as { json: string }[];
  let best: EpisodeLite | null = null;
  let bestD = Infinity;
  for (const r of rows) {
    let ep: EpisodeLite;
    try {
      ep = JSON.parse(r.json) as EpisodeLite;
    } catch {
      continue;
    }
    const t = ep.as_of ?? ep.at;
    const d = Math.abs(t - c.as_of);
    if (d > tfMs) continue;
    if (d < bestD || (d === bestD && best?.thread_id && !ep.thread_id)) {
      best = ep;
      bestD = d;
    }
  }
  const ep = best;
  return {
    status: ep ? 'matched' : 'none',
    bucket: bucketOf(ep),
    episode_id: ep?.id ?? null,
    at: ep?.at ?? null,
    as_of: ep ? (ep.as_of ?? ep.at) : null,
    mode: ep ? (ep.thread_id ? 'review' : 'scan') : null,
    action: ep?.judgment?.action ?? null,
    direction: ep?.judgment?.direction ?? null,
    strategy_id: ep?.judgment?.strategy_id ?? null,
    trigger: ep?.trigger?.kind ?? null,
    gates_failed: (ep?.gates ?? []).filter((g) => !g.passed).map((g) => g.name),
    intent: !!ep?.intent,
    matched_at: now,
  };
}

/** 配对窗口(as_of + 1 根 + 宽限)关了的候选定稿配对;返回定稿条数。 */
export function matchPending(db: DatabaseSync, now: number, graceMs = 120_000): number {
  const rows = db.prepare('SELECT id, json FROM demo_strategy_candidate WHERE model_action IS NULL ORDER BY as_of LIMIT 500').all() as { id: string; json: string }[];
  const upd = db.prepare('UPDATE demo_strategy_candidate SET json = ?, model_episode_id = ?, model_action = ?, model_dir = ?, model_matched_at = ? WHERE id = ?');
  let n = 0;
  for (const r of rows) {
    const c = readCandidate(r.json);
    if (now < c.as_of + timeframeMillis(c.timeframe) + graceMs) continue;
    const m = matchModelEpisode(db, c, now);
    c.model = m;
    upd.run(JSON.stringify(c), m.episode_id, m.status === 'none' ? 'none' : (m.action ?? 'no_judgment'), m.direction, now, c.id);
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- settlement

/** 计划腿:止损/目标不动,下一根 open 市价成交,到期按收盘(outcome.ts simulateOutcome,同根止损优先)。 */
export function planLeg(stop: number, target: number | null, forward: Kline[]): CandidateLeg | null {
  if (!forward.length) return null;
  const o = simulateOutcome({ direction: 'long', entry: 'market', limit_price: null, stop, tp: target, bars: forward });
  return { status: o.status, r: o.r === null ? null : r4(o.r), net_r: o.net_r == null ? null : r4(o.net_r), fill_price: o.fill_price, exit_price: o.exit_price, bars_held: o.bars_held, mae_r: o.mae_r === null ? null : r4(o.mae_r), mfe_r: o.mfe_r === null ? null : r4(o.mfe_r) };
}

/**
 * 吊灯腿:入场起止损 = max(计划止损, 入场后最高价 − 3×ATR22),ATR 与最高价只用已收盘 K 线(截止上一根),只收紧、无目标,
 * 到期按收盘。与 scripts/ledger-backfill.ts `walkChandelier` 逐行同口径(那边最多 7 天,这里用同一个 48 根窗口)。
 */
export function trailLeg(stop: number, history: readonly Kline[], forward: readonly Kline[]): CandidateLeg | null {
  if (!forward.length) return null;
  const fill = Number(forward[0]!.open);
  const t = openTrade('long', fill, stop, null);
  if (!t) return { status: 'invalid', r: null, fill_price: fill, exit_price: null, bars_held: null };
  const seen: Kline[] = [...history];
  let extreme = fill;
  for (const b of forward) {
    const tail = seen.slice(-(TRAIL_ATR_PERIOD + 1));
    if (tail.length > TRAIL_ATR_PERIOD) {
      let tr = 0;
      for (let i = 1; i < tail.length; i++) {
        const h = Number(tail[i]!.high), l = Number(tail[i]!.low), pc = Number(tail[i - 1]!.close);
        tr += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      }
      const trail = extreme - TRAIL_ATR_MULT * (tr / TRAIL_ATR_PERIOD);
      if (trail > t.stop) t.stop = trail;
    }
    const s = stepTrade(t, b, false);
    if (s.exit) return { status: s.exit.status === 'stop' && t.stop > stop ? 'trail' : s.exit.status, r: r4(tradeR(t, s.exit.price)), fill_price: fill, exit_price: s.exit.price, bars_held: t.bars_held, mae_r: r4(t.mae_r), mfe_r: r4(t.mfe_r) };
    seen.push(b);
    extreme = Math.max(extreme, Number(b.high));
  }
  const last = Number(forward[forward.length - 1]!.close);
  return { status: 'expired', r: r4(tradeR(t, last)), fill_price: fill, exit_price: last, bars_held: t.bars_held, mae_r: r4(t.mae_r), mfe_r: r4(t.mfe_r) };
}

/** 一条候选的结算(纯函数):bars 需覆盖 as_of 前 ≥ 23 根(吊灯 ATR)+ as_of 起 horizon 根。 */
export function settleCandidate(c: StrategyCandidate, bars: readonly Kline[], now: number): CandidateSettlement {
  const tfMs = timeframeMillis(c.timeframe);
  const closed = [...new Map(bars.filter((k) => k.open_time + tfMs <= now).map((k) => [k.open_time, k])).values()].sort((a, b) => a.open_time - b.open_time);
  const end = c.as_of + c.horizon_bars * tfMs;
  const forward = closed.filter((k) => k.open_time >= c.as_of && k.open_time < end);
  const history = closed.filter((k) => k.open_time < c.as_of).slice(-(TRAIL_ATR_PERIOD + 1));
  const base = { settled_at: now, horizon_bars: c.horizon_bars, bars_seen: forward.length };
  if (!forward.length || forward[0]!.open_time !== c.as_of || forward.length < c.horizon_bars) {
    return { ...base, source: 'unscoreable', plan: null, trail: null, note: `K 线不全:入场根 ${forward[0]?.open_time === c.as_of ? '在' : '缺'},窗口 ${forward.length}/${c.horizon_bars} 根` };
  }
  const plan = planLeg(c.stop, c.target, forward);
  if (!plan || plan.r === null) return { ...base, source: 'invalid', plan, trail: null, note: `下一根开盘 ${forward[0]!.open} 已在止损 ${c.stop} 下方,计划无法成立` };
  const trail = trailLeg(c.stop, history, forward);
  const note = history.length > TRAIL_ATR_PERIOD ? '计划腿 + 吊灯腿' : `入场前只有 ${history.length} 根历史,吊灯线首根起算延后`;
  return { ...base, source: 'plan_walk', plan, trail, note };
}

/** 到期的开放候选逐条拉 K 线结算;单条失败只记日志、下次再试。返回结算条数。 */
export async function settleCandidates(db: DatabaseSync, load: KlinesLoader, now: number, opts: { max?: number; log?: CandidateLog } = {}): Promise<number> {
  const rows = db
    .prepare('SELECT id, json FROM demo_strategy_candidate WHERE settled_at IS NULL AND settle_due_at <= ? ORDER BY settle_due_at LIMIT ?')
    .all(now, opts.max ?? 20) as { id: string; json: string }[];
  const upd = db.prepare('UPDATE demo_strategy_candidate SET json = ?, settled_at = ?, outcome_r = ?, outcome_r_trail = ?, outcome_source = ? WHERE id = ?');
  let n = 0;
  for (const r of rows) {
    const c = readCandidate(r.json);
    const tfMs = timeframeMillis(c.timeframe);
    try {
      const bars = await load(c.symbol, c.timeframe, c.horizon_bars + TRAIL_ATR_PERIOD + 3, c.as_of + (c.horizon_bars - 1) * tfMs);
      const s = settleCandidate(c, bars, now);
      // K 线还没全(交易所延迟):不到 as_of 之后 4 根就放弃等,标 unscoreable
      if (s.source === 'unscoreable' && now < c.as_of + (c.horizon_bars + 4) * tfMs) continue;
      c.settlement = s;
      c.status = 'settled';
      upd.run(JSON.stringify(c), now, s.plan?.r ?? null, s.trail?.r ?? null, s.source, c.id);
      n++;
    } catch (e) {
      opts.log?.('warn', `影子候选结算失败 ${c.symbol} ${new Date(c.as_of).toISOString()}:${(e as Error).message}`);
    }
  }
  return n;
}

// ---------------------------------------------------------------- summary

export interface CandidateGroupStats {
  n: number;
  settled: number;
  plan_mean_r: number | null;
  trail_mean_r: number | null;
}

export interface CandidateSummary {
  version: typeof CANDIDATE_VERSION;
  n: number;
  open: number;
  settled: number;
  scoreable: number;
  since: number | null;
  first_as_of: number | null;
  last_as_of: number | null;
  mean_rr: number | null;
  share_with_target: number | null;
  plan_expectancy_r: number | null;
  plan_net_expectancy_r: number | null;
  trail_expectancy_r: number | null;
  plan_win_rate: number | null;
  /**
   * 不重叠口径:同一 (策略, 币) 上一条候选的计划腿还没出场时出现的候选跳过(研究引擎 A 臂持仓时不接新候选)。
   * 全量口径每根突破都记一条,连续突破会重复计同一段行情,期望会被放大或缩小 —— 两个口径都看。
   */
  nonoverlap: { n: number; plan_expectancy_r: number | null; plan_net_expectancy_r: number | null; trail_expectancy_r: number | null };
  by_symbol: Record<string, CandidateGroupStats>;
  by_strategy: Record<string, CandidateGroupStats & { strategy_id: string; version: number; ir_hash: string }>;
  /** 候选 × 模型判断:PROPOSE 同向 / 反向 / NO_TRADE / WATCH / 复查 / 有 episode 没判断 / 模型没被问 / 配对窗口没关。 */
  pairing: Record<PairBucket | 'pending', CandidateGroupStats>;
  /** 反方向覆盖:同时段模型 PROPOSE(扫描)但 ±1 根内没有 IR 候选的次数。 */
  model_proposals_without_candidate: number;
  unmapped: Record<string, number>;
  sample_note: string;
}

const mean = (xs: number[]): number | null => (xs.length ? r4(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

function group(cs: StrategyCandidate[]): CandidateGroupStats {
  const s = cs.filter((c) => c.settlement?.source === 'plan_walk');
  return { n: cs.length, settled: s.length, plan_mean_r: mean(s.map((c) => c.settlement!.plan!.r!)), trail_mean_r: mean(s.flatMap((c) => (c.settlement!.trail?.r == null ? [] : [c.settlement!.trail!.r]))) };
}

export function summarizeCandidates(db: DatabaseSync, opts: { since?: number | null } = {}): CandidateSummary {
  const since = opts.since ?? null;
  const cs = (db.prepare(`SELECT json FROM demo_strategy_candidate ${since ? 'WHERE as_of >= ?' : ''} ORDER BY as_of`).all(...(since ? [since] : [])) as { json: string }[]).map((r) => readCandidate(r.json));
  const scored = cs.filter((c) => c.settlement?.source === 'plan_walk');
  const plan = scored.map((c) => c.settlement!.plan!);
  const by = <K extends string>(key: (c: StrategyCandidate) => K): Map<K, StrategyCandidate[]> => {
    const m = new Map<K, StrategyCandidate[]>();
    for (const c of cs) m.set(key(c), [...(m.get(key(c)) ?? []), c]);
    return m;
  };
  const buckets: (PairBucket | 'pending')[] = ['propose_same', 'propose_opposite', 'no_trade', 'watch', 'review', 'no_judgment', 'no_episode', 'pending'];
  const pairMap = by((c) => c.model?.bucket ?? 'pending');
  const unmapped: Record<string, number> = {};
  for (const c of cs) for (const u of c.unmapped) unmapped[u] = (unmapped[u] ?? 0) + 1;
  const strat = by((c) => `${c.strategy_id}@${c.version}`);
  // 反方向覆盖:模型扫描 PROPOSE 的时点,±1 根内有没有 IR 候选(只看候选覆盖到的币与时间段)
  let orphan = 0;
  if (cs.length) {
    const first = cs[0]!.as_of, last = cs[cs.length - 1]!.as_of;
    const tfMs = Math.min(...cs.map((c) => timeframeMillis(c.timeframe)));
    const symbols = [...new Set(cs.map((c) => c.symbol))];
    const eps = db
      .prepare(`SELECT json_extract(json,'$.symbol') AS symbol, COALESCE(json_extract(json,'$.as_of'), at) AS t FROM demo_episodes WHERE at BETWEEN ? AND ? AND action = 'PROPOSE' AND json_extract(json,'$.thread_id') IS NULL`)
      .all(first - tfMs, last + tfMs) as { symbol: string; t: number }[];
    for (const e of eps) if (symbols.includes(e.symbol) && !cs.some((c) => c.symbol === e.symbol && Math.abs(c.as_of - e.t) <= tfMs)) orphan++;
  }
  const withTarget = cs.filter((c) => c.target !== null);
  const kept: StrategyCandidate[] = [];
  const busyUntil = new Map<string, number>();
  for (const c of scored) {
    const k = `${c.strategy_id}@${c.version}:${c.symbol}`;
    if (c.as_of < (busyUntil.get(k) ?? 0)) continue;
    kept.push(c);
    busyUntil.set(k, c.as_of + (c.settlement!.plan!.bars_held ?? c.horizon_bars) * timeframeMillis(c.timeframe));
  }
  return {
    version: CANDIDATE_VERSION,
    n: cs.length,
    open: cs.filter((c) => !c.settlement).length,
    settled: cs.filter((c) => !!c.settlement).length,
    scoreable: scored.length,
    since,
    first_as_of: cs[0]?.as_of ?? null,
    last_as_of: cs[cs.length - 1]?.as_of ?? null,
    mean_rr: mean(withTarget.map((c) => c.rr!).filter((x) => Number.isFinite(x))),
    share_with_target: cs.length ? r4(withTarget.length / cs.length) : null,
    plan_expectancy_r: mean(plan.map((p) => p.r!)),
    plan_net_expectancy_r: mean(plan.flatMap((p) => (p.net_r == null ? [] : [p.net_r]))),
    trail_expectancy_r: mean(scored.flatMap((c) => (c.settlement!.trail?.r == null ? [] : [c.settlement!.trail!.r]))),
    plan_win_rate: plan.length ? r4(plan.filter((p) => p.r! > 0).length / plan.length) : null,
    nonoverlap: {
      n: kept.length,
      plan_expectancy_r: mean(kept.map((c) => c.settlement!.plan!.r!)),
      plan_net_expectancy_r: mean(kept.flatMap((c) => (c.settlement!.plan!.net_r == null ? [] : [c.settlement!.plan!.net_r]))),
      trail_expectancy_r: mean(kept.flatMap((c) => (c.settlement!.trail?.r == null ? [] : [c.settlement!.trail!.r]))),
    },
    by_symbol: Object.fromEntries([...by((c) => c.symbol)].map(([k, v]) => [k, group(v)])),
    by_strategy: Object.fromEntries([...strat].map(([k, v]) => [k, { ...group(v), strategy_id: v[0]!.strategy_id, version: v[0]!.version, ir_hash: v[0]!.ir_hash }])),
    pairing: Object.fromEntries(buckets.map((b) => [b, group(pairMap.get(b) ?? [])])) as CandidateSummary['pairing'],
    model_proposals_without_candidate: orphan,
    unmapped,
    sample_note: scored.length < 30 ? `只有 ${scored.length} 条可评分,不到 30 条样本门槛,只能看方向` : '样本 ≥ 30,仍按单策略单窗口解读',
  };
}

// ---------------------------------------------------------------- runtime entry

/** 进程内节流(不是副作用:导入时不跑任何东西)。 */
let running = false;
let lastSettleAt = 0;
const doneAsOf = new Map<string, number>();

export interface CandidateShadowDeps {
  db: DatabaseSync;
  symbols: readonly string[];
  now?: number;
  loadKlines?: KlinesLoader;
  log?: CandidateLog;
  /** 测试 / 回放用:直接给 IR,不查研究台。 */
  shadow?: ShadowIR;
  /** 结算节流,默认 10 分钟一次。 */
  settleEveryMs?: number;
}

export interface CandidateShadowResult {
  skipped?: 'busy' | 'disabled' | 'slow_ir';
  generated: number;
  matched: number;
  settled: number;
  errors: number;
  as_of: number | null;
}

/**
 * 运行时钩子:每根工作流 K 线收盘调用一次(runtime.onKlineClose)。自己判断策略周期有没有新收盘的 bar,
 * 有就对 watchlist 生成 → 落库;每次都定稿到窗的配对;按节流结算。永远不抛错(影子绝不能打断实盘循环)。
 * `TG_CANDIDATE_SHADOW=0` 关掉。
 */
/** 单币单次 irCandidate 的同步耗时上限:重 IR(高周期结构门等)会占住网关主线程,超过就把这条 IR 整个停掉直到重启(jacky-f5 09-23 实测 irCandidate 曾堵事件循环 8 分钟)。 */
const SLOW_IR_MS = 200;
const slowIR = new Set<string>();

export async function runCandidateShadow(deps: CandidateShadowDeps): Promise<CandidateShadowResult> {
  const res: CandidateShadowResult = { generated: 0, matched: 0, settled: 0, errors: 0, as_of: null };
  if (process.env['TG_CANDIDATE_SHADOW'] === '0') return { ...res, skipped: 'disabled' };
  if (running) return { ...res, skipped: 'busy' };
  running = true;
  const log = deps.log ?? (() => {});
  try {
    const now = deps.now ?? Date.now();
    const load = deps.loadKlines ?? ((s, tf, limit, end) => fetchKlines(s, tf, limit, end));
    const shadow = deps.shadow ?? loadIRForShadow(deps.db);
    const tfMs = timeframeMillis(shadow.timeframe);
    const expected = Math.floor(now / tfMs) * tfMs;
    const key = `${shadow.strategy_id}@${shadow.version}:${shadow.ir_hash}`;
    res.as_of = expected;
    if (slowIR.has(key)) return { ...res, skipped: 'slow_ir' };
    if (doneAsOf.get(key) !== expected) {
      const w = viewBars(shadow.ir, SYNTH_POLICY, tfMs);
      let complete = true;
      await Promise.all(
        deps.symbols.map(async (symbol) => {
          try {
            const klines = await load(symbol, shadow.timeframe, w + 2);
            const t0 = performance.now();
            const g = generateCandidates({ shadow, symbol, klines: { [shadow.timeframe]: klines }, now });
            const dt = performance.now() - t0;
            if (dt > SLOW_IR_MS) {
              slowIR.add(key);
              log('warn', `影子候选 ${symbol} 单次同步计算 ${dt.toFixed(0)}ms 超过 ${SLOW_IR_MS}ms,${key} 本进程内不再跑(重启后重试)`, { elapsed_ms: dt });
            }
            if (g.as_of !== expected) complete = false; // 刚收盘那根交易所还没给:下次再试
            if (g.candidate && persistCandidate(deps.db, g.candidate)) {
              res.generated++;
              const c = g.candidate;
              log('info', `影子候选 ${symbol} ${shadow.timeframe}:入场参考 ${c.entry_ref} 止损 ${c.stop} 目标 ${c.target ?? '—'} RR ${c.rr ?? '—'}(${shadow.strategy_id}@${shadow.version})`, { candidate_id: c.id, unmapped: c.unmapped });
            }
          } catch (e) {
            complete = false;
            res.errors++;
            log('warn', `影子候选生成失败 ${symbol}:${(e as Error).message}`);
          }
        }),
      );
      if (complete) doneAsOf.set(key, expected);
    }
    res.matched = matchPending(deps.db, now);
    if (now - lastSettleAt >= (deps.settleEveryMs ?? 600_000)) {
      lastSettleAt = now;
      res.settled = await settleCandidates(deps.db, load, now, { log });
    }
  } catch (e) {
    res.errors++;
    log('warn', `影子候选整轮失败:${(e as Error).message}`);
  } finally {
    running = false;
  }
  return res;
}

/** 测试用:清进程内节流。 */
export function resetCandidateShadowState(): void {
  running = false;
  lastSettleAt = 0;
  doneAsOf.clear();
  slowIR.clear();
}
