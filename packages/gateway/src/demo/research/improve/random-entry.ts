/**
 * 随机入场基线(设计第四节「防过拟合要记的账」):同样的离场/止损/仓位/成本,只把入场换成随机的,检验入场本身有没有贡献。
 *
 * 做法(零模型,走同一个 engine v4 执行器,不另写撮合):
 *   引擎的候选信号按 bar 下标记忆在 SignalCache 里('c'+i);这里给每次随机运行一份自己的记忆,
 *   被抽中的 bar 返回「信号成立」时的候选(止损/目标按策略自己的止损原语与目标原语当场算,和 irCandidate 信号之后的那段同式),
 *   没抽中的返回无候选。方向门(regime)也视为入场条件,随机入场不看它。离场记忆('x' 键)只依赖持仓状态与 K 线,跨次共享。
 * 入场概率:p = 冠军每资产平均笔数 /(窗口根数 × (1 − 冠军平均敞口)),即空仓时每根被抽中的概率,使期望笔数与冠军相当;
 *   实际笔数随持仓长短浮动,逐次记录。固定种子(seed + 第 k 次),同输入逐位可复现;缺省 20 次取分布。
 * 只支持 engine v4 路径:IR 带 order 块(订单周期执行核)时返回 null 并写原因。
 */
import type { StrategyIR } from '@trading-swarm/contracts';
import { registry } from '../primitives/index.js';
import { numericBars, viewBars } from '../engine.js';
import { irWarmup, resolveRequest, strategyNodes } from '../strategy.js';
import { DEFAULT_EXECUTION } from '../backtest-report.js';
import { runPool, scoreSegment, windowIndex, type EvalEnv, type Window } from './evaluate.js';
import { median, seededRandom } from './stats.js';
import type { FrozenAsset, OverfitLedger, SegmentScore } from './types.js';
import type { SignalCache } from '../engine.js';

export const RANDOM_ENTRY_RUNS = 20;
export const RANDOM_ENTRY_SEED = 20260923;
type Candidate = { entry: Record<string, unknown> | null; reason: string };

/** irCandidate 在信号成立之后的那一段:止损原语给初始止损,fixed_r_target / structure_target / pivot_target 给目标(与 irCandidate 同优先级)。 */
export function forcedCandidate(ir: StrategyIR, ctx: { bars: import('@trading-swarm/contracts').ResearchBar[]; i: number; timeframe_ms: number }): Candidate {
  const stop = registry.get(ir.risk.stop.primitive)!.compute(ctx, ir.risk.stop.params).stop, close = Number(ctx.bars[ctx.i]?.close);
  if (!(stop && Number.isFinite(stop) && stop > 0 && stop < close)) return { entry: null, reason: 'invalid_stop' };
  // 与 irCandidate 同优先级:fixed_r_target > structure_target > pivot_target(2026-09-23 结构口径缺省止盈);都没有 = 不设止盈
  const targets = ir.exit.filter((x) => x.primitive === 'fixed_r_target').map((x) => Number(x.params.r)), structural = ir.exit.find((x) => x.primitive === 'structure_target') ?? ir.exit.find((x) => x.primitive === 'pivot_target');
  const target = targets.length ? close + (close - stop) * Math.min(...targets) : structural ? (registry.get(structural.primitive)!.compute(ctx, structural.params).target ?? null) : null;
  return { entry: { candidate_id: `candidate_${ctx.bars[ctx.i]!.close_time}`, stop: stop.toFixed(8), target: target?.toFixed(8) ?? null, ...(targets.length ? { target_r: Math.min(...targets) } : {}), reason: 'random_entry' }, reason: 'random_entry' };
}

/** 订单执行核的随机入场记忆:条件键('oL'/'oS'+下标)按抽签给,其余键(计划意图)落到跨次共享的 shared。 */
export class RandomOrderMemo extends Map<string, unknown> {
  constructor(private chosen: Set<number>, private shared: Map<string, unknown>) { super(); }
  private static cond(k: string): boolean { return k.length > 2 && k[0] === 'o' && (k[1] === 'L' || k[1] === 'S'); }
  override get(k: string): unknown { return RandomOrderMemo.cond(k) ? this.chosen.has(Number(k.slice(2))) : this.shared.get(k); }
  override set(k: string, v: unknown): this { if (!RandomOrderMemo.cond(k)) this.shared.set(k, v); return this; }
}

/** 随机入场的信号记忆:'c'+i 按抽签结果给候选,其余键(离场)落到跨次共享的 exits。 */
class RandomMemo extends Map<string, unknown> {
  constructor(private chosen: Set<number>, private forced: (i: number) => Candidate, private exits: Map<string, unknown>) { super(); }
  override get(k: string): unknown { if (k.startsWith('c')) { const i = Number(k.slice(1)); return this.chosen.has(i) ? this.forced(i) : { entry: null, reason: 'random_skip' }; } return this.exits.get(k); }
  override set(k: string, v: unknown): this { if (!k.startsWith('c')) this.exits.set(k, v); return this; }
}

export async function randomEntryBaseline(env: EvalEnv, ir: StrategyIR, irKey: string, win: Window, champion: SegmentScore, opts: { runs?: number; seed?: number; segment?: string; assets?: FrozenAsset[] } = {}): Promise<{ ledger: NonNullable<OverfitLedger['random_entry']>; median_score: SegmentScore | null } | null> {
  const runs = opts.runs ?? RANDOM_ENTRY_RUNS, seed = opts.seed ?? RANDOM_ENTRY_SEED, step = env.data.timeframe_ms, warmup = irWarmup(ir, step);
  const pine = strategyNodes(ir).some((x) => x.node.primitive.startsWith('pine_'));
  const policy = resolveRequest({ idempotency_key: 'x', dataset_id: 'x', study_id: 'x', strategy_ir: ir, execution: DEFAULT_EXECUTION, from_ms: 0, to_ms: 1, arms: ['a_rules'], repeats: 1, max_model_calls: 0, timeout_ms: 1000, purpose: 'development', acknowledge_adaptive_search: false }).policy;
  const W = viewBars(ir, policy, step), assets = opts.assets ?? env.data.assets, orderPath = !!ir.order;
  // 每资产的抽签区间与强制候选(强制候选只依赖 IR 与 bar 下标,跨次共享)
  const per = assets.map((a) => {
    const idx = windowIndex(a.bars, win, warmup), forced = new Map<number, Candidate>(), exits = new Map<string, unknown>();
    let src: typeof a.bars | null = null;
    const force = (i: number) => { let c = forced.get(i); if (!c) { src ??= pine ? a.bars : numericBars(a.bars); const bars = src.slice(Math.max(0, i - W + 1), i + 1); c = forcedCandidate(ir, { bars, i: bars.length - 1, timeframe_ms: step }); forced.set(i, c); } return c; };
    return { a, idx, force, exits };
  });
  const bars = per.reduce((s, p) => s + (p.idx ? p.idx.end - p.idx.start : 0), 0) / Math.max(1, per.filter((p) => p.idx).length);
  const active = per.filter((x) => x.idx).length || 1, tradesPerAsset = champion.trades / active, flat = Math.max(1e-6, 1 - Math.min(0.95, champion.exposure));
  const p = Math.min(0.5, Math.max(1e-5, tradesPerAsset / Math.max(1, bars * flat)));
  const returns: number[] = [], trades: number[] = [], sharpes: (number | null)[] = [], scores: SegmentScore[] = [];
  for (let k = 0; k < runs; k++) {
    env.check();
    const rnd = seededRandom(seed + k), memos = new Map<string, Map<string, unknown>>();
    for (const x of per) {
      const chosen = new Set<number>();
      if (x.idx) for (let i = x.idx.start; i <= x.idx.end; i++) if (rnd() < p) chosen.add(i);
      memos.set(x.a.symbol, orderPath ? new RandomOrderMemo(chosen, x.exits) : new RandomMemo(chosen, x.force, x.exits));
    }
    const run = await runPool(env, ir, irKey + '|random', win, { memo: (s) => memos.get(s)! as SignalCache, ...(opts.assets ? { assets: opts.assets } : {}) });
    const s = scoreSegment(`random_${k + 1}`, run, win);
    scores.push(s); returns.push(s.total_return); trades.push(s.trades); sharpes.push(s.sharpe);
  }
  const med = median(returns), below = returns.filter((r) => r < champion.total_return).length, ties = returns.filter((r) => r === champion.total_return).length;
  const sorted = [...scores].sort((x, y) => x.total_return - y.total_return), mid = sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
  return {
    ledger: { runs, seed, segment: opts.segment ?? 'train', returns, trades, sharpes, median_return: med, champion_return: champion.total_return, champion_percentile: runs ? (below + ties / 2) / runs : null, note: `入场概率 ${(p * 100).toFixed(3)}%/根(空仓时),期望每资产约 ${tradesPerAsset.toFixed(1)} 笔;离场、止损、仓位、成本与冠军相同;冠军收益高于 ${below}/${runs} 次随机入场` },
    median_score: mid,
  };
}
