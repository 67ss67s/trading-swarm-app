/**
 * 候选评估(改进环第一阶段,设计第二、四节):一个 IR 在给定窗口上跑全资产池,零模型。
 *
 * 执行:逐资产调用 backtest-report 的单资产执行器 —— IR 带 order 块走订单周期执行核(orders/executor.ts 的 pickOrderExecutor),
 *   否则 engine v4 快路径(engineExecutor)。不走 runBacktestReport 整份报告:那条路每次都落 research_backtests 并广播 onBacktestReport,
 *   会被策略对象监听器挂成新策略/新版本,改进环一代几十个候选会把策略库刷满。执行口径(撮合、费率、滑点、仓位)与报告完全相同。
 * 资金:资产池等资金(初始 10000 按资产数均分),各资产独立记账、不再平衡;资产池净值 = 各资产净值在并集时间点上逐点相加(缺点前值填充)。
 * 基准:资产池等权买入持有(与报告同式:首个可成交 open 含滑点与 taker 费买入,之后按收盘 × (1−滑点) × (1−费率) 计清算价值);
 *   BTC 单独持有另报;同敞口持有 = 资产池持有收益 × 策略平均敞口(只做空的 IR 取负号 = 同敞口做空持有,2026-09-23 补)。
 * 压力:同一 IR 以 2 倍手续费再跑一次(候选信号按资产记忆复用,只多算撮合),stressed_return = 压力净值的总收益。
 * 分折:训练段一次连续跑完,按折边界(close_time)切净值与交易(交易只计段内入场且已在段内退出的成熟交易),与报告的样本内/外切法同口径;
 *   仓位可以跨折持有,折首净值取上一折最后一点。
 * 目标与门槛见 objectiveOf / trainGates,门槛数字来自任务冻结的 Objective(跑中不改)。
 */
import type { BacktestReport, ResearchBar, ResearchDataset, ResearchExecution, ResearchRequest, StrategyIR } from '@trade-gate/contracts';
import { DEFAULT_EXECUTION, WARMUP_BARS, assetExecutorFor, type AssetExecutor, type AssetRunEquity, type AssetRunOutput } from '../backtest-report.js';
import { orderGateFor } from '../order-gate.js';
import { assertSplitPurges } from '../judge/purge.js';
import { irWarmup, resolveRequest } from '../strategy.js';
import { prewarmPineSeries } from '../primitives/pine.js';
import { analyze, capitalUsage, tradeStats, type ClosedTrade, type EquitySample } from '../analyzer.js';
import { diagnoseReport, type DiagnosisFinding } from '../loop/diagnose.js';
import type { SignalCache } from '../engine.js';
import { dailyReturns, median, periodSharpe, stdev } from './stats.js';
import type { FrozenAsset, FrozenData, GateResult, Objective, SegmentScore } from './types.js';

export const POOL_CASH = 10000;
export const STRESS_FEE_MULTIPLE = 2;
export const DEFAULT_STABILITY_PENALTY = 0.5;
/** 永续缺省费率(与 backtest-report 同):吃单 0.05%、挂单 0.02% */
export const PERP_TAKER = 0.0005, PERP_MAKER = 0.0002;
export interface Window { from_ms: number; to_ms: number }
export interface PoolTrade extends ClosedTrade { symbol: string }
/** 一次资产池运行的原始结果(分折/分段都从这里切)。 */
export interface PoolRun {
  candidates?: import('../judge/filter.js').CandidateLog[];
  window: Window;
  samples: EquitySample[];
  trades: PoolTrade[];
  per_asset: { symbol: string; status: 'completed' | 'failed' | 'data_missing'; error: string | null; equity: AssetRunEquity[]; bench: Map<number, number>; trades: PoolTrade[]; initial: number }[];
  /** 与 samples 同时间点的 BTC 持有价值(池里没有 BTC 时为 null) */
  btc: Map<number, number> | null;
  warnings: string[];
  engine_version: string;
  /** 同敞口持有的方向:只做空的 IR 取 −1(同敞口做空持有),其余 1 */
  sign?: 1 | -1;
}

/** 评估环境:冻结数据 + 每资产一份固定的 dataset 对象(引擎的数值化/链式摘要按对象缓存)+ 候选信号记忆。 */
export class EvalEnv {
  readonly datasets = new Map<string, ResearchDataset>();
  private memos = new Map<string, SignalCache>();
  private prewarmed = new Set<string>();
  /** 实际跑过的单资产回测次数(给账本与耗时统计) */
  runs = 0;
  judge?: import('../judge/index.js').JudgeRuntime;
  candidate_filter?: import('../orders/index.js').OrderPathInput['candidate_filter'];
  on_candidate?: import('../orders/index.js').OrderPathInput['on_candidate'];
  constructor(readonly data: FrozenData, readonly check: () => void = () => {}, readonly executorFor: (ir: StrategyIR) => AssetExecutor = assetExecutorFor) {
    for (const a of data.assets) this.datasets.set(a.symbol, { venue: 'okx', market: data.market ?? 'spot', symbol: a.symbol, timeframe_ms: data.timeframe_ms, source: 'improve:frozen', retrieved_at: (a.bars.at(-1)?.close_time ?? 0) + 1, bars: a.bars });
  }
  /** 候选信号记忆:同一 IR × 资产 × 窗口复用(正常费率与 2 倍费率共用;信号不依赖费率)。 */
  memo(key: string): SignalCache { let m = this.memos.get(key); if (!m) { m = new Map(); this.memos.set(key, m); if (this.memos.size > 64) this.memos.delete(this.memos.keys().next().value!); } return m; }
  async prewarm(ir: StrategyIR, irKey: string, asset: FrozenAsset): Promise<void> {
    const k = irKey + '|' + asset.symbol;
    if (this.prewarmed.has(k)) return;
    this.prewarmed.add(k);
    await prewarmPineSeries(ir, asset.bars, this.data.timeframe_ms).catch(() => undefined);
  }
}

/** 与 runBacktestReport 同口径的执行参数:缺省执行 + IR 的仓位原语。 */
export function executionFor(ir: StrategyIR, base: Partial<ResearchExecution> = {}): ResearchExecution {
  const req: ResearchRequest = { idempotency_key: 'x', dataset_id: 'x', study_id: 'x', strategy_ir: ir, execution: { ...DEFAULT_EXECUTION, ...base }, from_ms: 0, to_ms: 1, arms: ['a_rules'], repeats: 1, max_model_calls: 0, timeout_ms: 1000, purpose: 'development', acknowledge_adaptive_search: false };
  return resolveRequest(req).execution;
}
const fmtCash = (x: number) => x.toFixed(8).replace(/\.?0+$/, '') || '0';
/** 窗口在资产 K 线里的决策首根/末根下标;预热不够时起点后移(与报告同理:统一预热 300 根,策略自身更长时按策略)。 */
export function windowIndex(bars: ResearchBar[], win: Window, warmup: number): { start: number; end: number; shifted: boolean } | null {
  let end = -1; for (let i = bars.length - 1; i >= 0; i--) if (bars[i]!.close_time <= win.to_ms) { end = i; break; }
  let start = bars.findIndex((b) => b.close_time >= win.from_ms), shifted = false;
  const need = Math.max(WARMUP_BARS, warmup);
  if (start < 0) return null;
  if (start < need) { start = need; shifted = true; }
  if (end < 0 || start >= end - 1) return null;
  return { start, end, shifted };
}
function benchmark(bars: ResearchBar[], start: number, end: number, cash: number, e: ResearchExecution): Map<number, number> {
  const out = new Map<number, number>(), fee = Number(e.fee_rate), slip = Number(e.slippage_bps) / 1e4;
  out.set(bars[start]!.close_time - 1, cash); out.set(bars[start]!.close_time, cash);
  const qty = cash / (Number(bars[start + 1]!.open) * (1 + slip) * (1 + fee));
  for (let i = start + 1; i <= end; i++) out.set(bars[i]!.close_time, qty * Number(bars[i]!.close) * (1 - slip) * (1 - fee));
  return out;
}

/** 资产池跑一次:feeMultiple=2 即压力测试;memoPrefix 区分信号记忆(随机入场基线用自己的记忆)。 */
export async function runPool(env: EvalEnv, ir: StrategyIR, irKey: string, win: Window, opts: { feeMultiple?: number; execution?: Partial<ResearchExecution>; memo?: (symbol: string) => SignalCache; assets?: FrozenAsset[] } = {}): Promise<PoolRun> {
  const segs = env.data.segments;
  assertSplitPurges(ir,env.data.timeframe_ms,[segs.train,segs.validation,segs.holdout],segs.holdout.from_ms < 0);
  if (ir.judge && !ir.order) throw Error('judge_requires_order_ir');
  if (ir.judge && !env.judge && !env.candidate_filter) throw Error('judge_runtime_missing');
  const assets = opts.assets ?? env.data.assets, per = POOL_CASH / assets.length, step = env.data.timeframe_ms;
  const base = executionFor(ir, opts.execution), mult = opts.feeMultiple ?? 1;
  const execution: ResearchExecution = { ...base, fee_rate: fmtCash(Number(base.fee_rate) * mult), initial_cash: fmtCash(per) };
  // 手续费与全窗口报告同口径:现货沿用 execution.fee_rate;永续 taker 0.05% / maker 0.02%(压力测试同样乘倍数)
  const perp = ir.order?.market === 'perp';
  const fees = ir.order ? (perp ? { taker: fmtCash(PERP_TAKER * mult), maker: fmtCash(PERP_MAKER * mult) } : { taker: execution.fee_rate }) : undefined;
  const warmup = irWarmup(ir, step), order_gate = orderGateFor(ir), executor = env.executorFor(ir);
  const out: PoolRun = { window: win, samples: [], trades: [], per_asset: [], btc: null, warnings: [], engine_version: '', sign: ir.order?.direction === 'short' ? -1 : 1 };
  for (const a of assets) {
    env.check();
    const ds = env.datasets.get(a.symbol)!, idx = windowIndex(a.bars, win, warmup);
    if (!idx) { out.per_asset.push({ symbol: a.symbol, status: 'data_missing', error: '窗口内没有预热后可交易的 bar', equity: [], bench: new Map(), trades: [], initial: per }); continue; }
    if (idx.shifted) out.warnings.push(`${a.symbol} 窗口前预热不足,起点后移到 ${new Date(a.bars[idx.start]!.close_time + 1).toISOString().slice(0, 13)}`);
    await env.prewarm(ir, irKey, a);
    const from_ms = a.bars[idx.start]!.close_time, to_ms = a.bars[idx.end]!.close_time;
    const cache = opts.memo ? opts.memo(a.symbol) : env.memo(`${irKey}|${a.symbol}|${from_ms}|${to_ms}`);
    let r: AssetRunOutput;
    try { r = await executor({ judge: env.judge, candidate_filter: env.candidate_filter, on_candidate: env.on_candidate, symbol: a.symbol, dataset: ds, dataset_id: a.dataset_id, ir, execution, order_gate, timeframe: env.data.timeframe, from_ms, to_ms, cache, check: env.check, ...(fees ? { fees } : {}), ...(perp && a.perp ? { perp: a.perp } : {}) }); }
    catch (e) { const msg = e instanceof Error ? e.message : String(e); if (/CANCELLED|TIMEOUT/.test(msg)) throw e; r = { status: 'failed', error: msg.slice(0, 300), engine_version: '', equity: [], trades: [], fees: 0 }; }
    env.runs++;
    if (r.candidates) (out.candidates ??= []).push(...r.candidates);
    out.engine_version ||= r.engine_version;
    if (r.status !== 'completed') { out.per_asset.push({ symbol: a.symbol, status: 'failed', error: r.error, equity: [], bench: new Map(), trades: [], initial: per }); out.warnings.push(`${a.symbol} 回测失败:${r.error}`); continue; }
    const trades: PoolTrade[] = r.trades.map((t) => ({ symbol: a.symbol, entry_at: t.entry_at, exit_at: t.exit_at, pnl: t.pnl, return_pct: t.return_pct, fees: t.fees, bars_held: t.bars_held, exit_reason: t.exit_reason, side: t.side }));
    out.per_asset.push({ symbol: a.symbol, status: 'completed', error: null, equity: r.equity, bench: benchmark(a.bars, idx.start, idx.end, per, fees ? { ...execution, fee_rate: fees.taker } : execution), trades, initial: per });
    out.trades.push(...trades);
  }
  const done = out.per_asset.filter((p) => p.status === 'completed');
  // 资产池净值:并集时间点,各资产前值填充;失败/缺数据的资产按初始资金计(现金不动),保证「等资金」口径不因剔除而放大
  const times = [...new Set(done.flatMap((p) => p.equity.map((e) => e.at)))].sort((x, y) => x - y);
  const cur = done.map((p) => ({ p, i: 0, eq: p.initial, hold: 0, bench: p.initial }));
  const idle = (assets.length - done.length) * per;
  for (const t of times) {
    let eq = idle, hold = 0, bench = idle, positions = 0;
    for (const c of cur) {
      while (c.i < c.p.equity.length && c.p.equity[c.i]!.at <= t) { const e = c.p.equity[c.i]!; c.eq = e.equity; c.hold = e.holdings; c.i++; }
      const b = c.p.bench.get(t); if (b !== undefined) c.bench = b;
      eq += c.eq; hold += c.hold; bench += c.bench; if (c.hold > 0) positions++;
    }
    out.samples.push({ at: t, equity: eq, exposure: eq > 0 ? hold / eq : 0, benchmark: bench, positions });
  }
  const btc = done.find((p) => p.symbol === 'BTCUSDT');
  if (btc) { const m = new Map<number, number>(); let last = btc.initial; for (const t of times) { const b = btc.bench.get(t); if (b !== undefined) last = b; m.set(t, last); } out.btc = m; }
  out.trades.sort((x, y) => x.exit_at - y.exit_at || x.entry_at - y.entry_at);
  return out;
}

/** 从一次运行里切出 [from, to] 的样本:折首取上一点作为起点净值。 */
function sliceSamples(samples: EquitySample[], win: Window): EquitySample[] {
  const inside = samples.filter((s) => s.at >= win.from_ms && s.at <= win.to_ms);
  const before = samples.filter((s) => s.at < win.from_ms).at(-1);
  return before ? [before, ...inside] : inside;
}
const ratio = (a: number | undefined, b: number | undefined) => (a !== undefined && b !== undefined && a > 0 ? b / a - 1 : null);

/** 一段(或一折)的 SegmentScore;stressed 为同一 IR 2 倍手续费的运行(可缺)。 */
export function scoreSegment(name: string, run: PoolRun, win: Window, stressed?: PoolRun | null): SegmentScore {
  // 分段收益按边界权益盯市；完整交易统计只含段内已成熟标签，跨段持仓只贡献权益变化。
  const ss = sliceSamples(run.samples, win), lo = ss[0] && ss[0].at < win.from_ms ? ss[0].at : win.from_ms - 1, inSeg = (t: PoolTrade) => t.entry_at > lo && t.exit_at <= win.to_ms, trades = run.trades.filter(inSeg);
  const fees = trades.reduce((a, t) => a + t.fees, 0), m = analyze(ss, trades, fees), r = dailyReturns(ss);
  const hold = m.benchmark_return, btc = run.btc ? ratio(run.btc.get(ss[0]?.at ?? -1) ?? POOL_CASH / run.per_asset.length, run.btc.get(ss.at(-1)?.at ?? -1)) : null;
  const st = stressed ? sliceSamples(stressed.samples, win) : null;
  const per_asset = run.per_asset.map((p) => {
    const eq = sliceSamples(p.equity.map((e) => ({ at: e.at, equity: e.equity, exposure: e.exposure, benchmark: p.bench.get(e.at) ?? null })), win);
    return { symbol: p.symbol, status: p.status, trades: p.trades.filter(inSeg).length, total_return: eq.length >= 2 ? eq.at(-1)!.equity / eq[0]!.equity - 1 : 0, hold_return: eq.length >= 2 ? ratio(eq[0]!.benchmark ?? undefined, eq.at(-1)!.benchmark ?? undefined) : null };
  });
  return {
    segment: name, from_ms: win.from_ms, to_ms: win.to_ms, trades: trades.length, total_return: m.total_return, sharpe: m.sharpe, max_drawdown: m.max_drawdown, exposure: m.exposure,
    exposure_matched_hold: hold === null ? null : (run.sign ?? 1) * hold * m.exposure, stressed_return: st && st.length >= 2 ? st.at(-1)!.equity / st[0]!.equity - 1 : null,
    hold_return: hold, btc_hold_return: btc, daily_sharpe: periodSharpe(r), days: r.length, win_rate: m.win_rate, profit_factor: m.profit_factor, fees, per_asset,
  };
}

/** 目标:各折夏普(日收益年化)中位数 − stability_penalty × 各折夏普标准差;某折夏普算不出(无波动/样本不足)按 0 计。 */
export function objectiveOf(folds: SegmentScore[], objective: Objective): number | null {
  if (!folds.length) return null;
  const s = folds.map((f) => f.sharpe ?? 0);
  return median(s)! - (objective.stability_penalty ?? DEFAULT_STABILITY_PENALTY) * stdev(s);
}
/** 训练段门槛(平台检验单独算,见 plateauGate)。 */
export function trainGates(train: SegmentScore, folds: SegmentScore[], o: Objective): GateResult[] {
  const minFold = folds.length ? Math.min(...folds.map((f) => f.trades)) : 0;
  const gates: GateResult[] = [
    { name: 'min_trades_per_fold', ok: minFold >= o.min_trades_per_fold, value: minFold, threshold: o.min_trades_per_fold, note: `最少一折 ${minFold} 笔` },
    { name: 'min_trades_total', ok: train.trades >= o.min_trades_total, value: train.trades, threshold: o.min_trades_total },
    { name: 'max_drawdown', ok: train.max_drawdown <= o.max_drawdown, value: train.max_drawdown, threshold: o.max_drawdown },
  ];
  if (o.require_stress_positive) gates.push({ name: 'stress_positive', ok: train.stressed_return !== null && train.stressed_return > 0, value: train.stressed_return, threshold: 0, note: `${STRESS_FEE_MULTIPLE} 倍手续费下训练段总收益` });
  if (o.require_beats_exposure_matched_hold) gates.push({ name: 'beats_exposure_matched_hold', ok: train.exposure_matched_hold !== null && train.total_return > train.exposure_matched_hold, value: train.exposure_matched_hold === null ? null : train.total_return - train.exposure_matched_hold, threshold: 0, note: `训练段 ${pct(train.total_return)} vs 同敞口持有 ${pct(train.exposure_matched_hold)}` });
  return gates;
}
/** 平台检验:邻域点(周期类参数 ±25%)的目标都不低于 obj − (1−ratio)·|obj|(obj>0 时即 ratio×obj)。没有邻域点 = 不适用,记通过。 */
export function plateauGate(obj: number | null, neighbors: { label: string; objective: number | null }[], o: Objective): GateResult {
  if (obj === null) return { name: 'plateau', ok: false, value: null, threshold: null, note: '目标值缺失' };
  if (!neighbors.length) return { name: 'plateau', ok: true, value: null, threshold: null, note: '没有周期类参数,平台检验不适用' };
  const need = obj - (1 - o.plateau_ratio) * Math.abs(obj), worst = Math.min(...neighbors.map((n) => n.objective ?? -Infinity));
  return { name: 'plateau', ok: worst >= need, value: Number.isFinite(worst) ? worst : null, threshold: need, note: neighbors.map((n) => `${n.label} ${n.objective === null ? '—' : n.objective.toFixed(2)}`).join(';') };
}
export const pct = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);

/** 训练段评估:一次正常费率 + 一次 2 倍费率,切 4 折。 */
export async function evaluateTrain(env: EvalEnv, ir: StrategyIR, irKey: string, o: Objective): Promise<{ run: PoolRun; train: SegmentScore; folds: SegmentScore[]; objective: number | null; gates: GateResult[] }> {
  const segs = env.data.segments, win = segs.train;
  const run = await runPool(env, ir, irKey, win), stressed = await runPool(env, ir, irKey, win, { feeMultiple: STRESS_FEE_MULTIPLE });
  const folds = segs.folds.map((f, k) => scoreSegment(`fold_${k + 1}`, run, f, stressed)), train = scoreSegment('train', run, win, stressed);
  return { run, train, folds, objective: objectiveOf(folds, o), gates: trainGates(train, folds, o) };
}
/** 单段评估(验证 / 留出):同样带 2 倍手续费压力。 */
export async function evaluateSegment(env: EvalEnv, ir: StrategyIR, irKey: string, name: 'validation' | 'holdout'): Promise<SegmentScore> {
  const win = env.data.segments[name];
  const run = await runPool(env, ir, irKey, win), stressed = await runPool(env, ir, irKey, win, { feeMultiple: STRESS_FEE_MULTIPLE });
  return scoreSegment(name, run, win, stressed);
}

/**
 * 训练段运行 → 诊断(loop/diagnose.ts 的 diagnoseReport)。诊断吃的是回测报告:这里把资产池拼成主资产 POOL,
 * 样本内/外 = 训练段前两折 / 后两折(只用训练段,验证与留出段对生成器不可见),各资产作为 single 附上供「资产差异」一条用。
 */
export function diagnoseRun(run: PoolRun, data: FrozenData, ir?: StrategyIR): DiagnosisFinding[] {
  const f = data.segments.folds, mid = f[Math.floor(f.length / 2) - 1]?.to_ms ?? data.segments.train.to_ms;
  const asset = (key: string, label: string, samples: EquitySample[], trades: PoolTrade[]) => {
    const fees = trades.reduce((a, t) => a + t.fees, 0), m = analyze(samples, trades, fees);
    const seg = (name: string, w: Window) => { const ss = sliceSamples(samples, w), ts = trades.filter((t) => t.entry_at >= w.from_ms && t.entry_at <= w.to_ms); return ss.length >= 2 ? { name, from_ms: w.from_ms, to_ms: w.to_ms, metrics: analyze(ss, ts, ts.reduce((a, t) => a + t.fees, 0)) } : null; };
    return { key, label, kind: 'single', symbols: [key], status: 'completed', error: null, metrics: m, segments: [seg('in_sample', { from_ms: data.segments.train.from_ms, to_ms: mid }), seg('out_of_sample', { from_ms: mid + 1, to_ms: data.segments.train.to_ms })].filter(Boolean), trades, trade_stats: tradeStats(trades), capital_usage: capitalUsage(samples), equity: [], monthly_returns: [], yearly_returns: [], data: null, window: run.window };
  };
  const singles = run.per_asset.filter((p) => p.status === 'completed').map((p) => asset(p.symbol, p.symbol.replace(/USDT$/, ''), p.equity.map((e) => ({ at: e.at, equity: e.equity, exposure: e.exposure, benchmark: p.bench.get(e.at) ?? null })), p.trades));
  // 诊断 v2 读 execution.sizing_mode / strategy_ir / warnings:按改进环的执行口径补上(与 runPool 同:每笔 100% 可用资金)
  const report = { id: 'improve-train', timeframe: data.timeframe, primary_key: 'POOL', execution: { sizing_mode: 'unit_notional(每笔 100% 可用资金,资产池等资金)', fee_rate: Number(DEFAULT_EXECUTION.fee_rate), slippage_bps: Number(DEFAULT_EXECUTION.slippage_bps), initial_cash: POOL_CASH }, strategy_ir: ir ?? null, warnings: run.warnings, assets: [asset('POOL', '资产池', run.samples, run.trades), ...singles] } as unknown as BacktestReport;
  return diagnoseReport(report).findings;
}
