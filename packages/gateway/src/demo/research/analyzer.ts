/**
 * 回测统计(参考 NautilusTrader PortfolioAnalyzer 的三类 statistics:PnL / returns / position),全部是确定性纯函数。
 *
 * 口径(契约 research-backtest.json 的 BacktestMetrics):
 * - 比例一律小数(0.0143 = 1.43%);金额(net_pnl / fees)是报价币(USDT)。
 * - returns 统计按 UTC 日:每天取最后一个净值点,相邻两天相除;年化按 crypto 365 天(sqrt(365) / 365)。
 *   sharpe = mean/std(样本)×√365,无风险利率 0;sortino 的下行偏差 = sqrt(Σmin(r,0)²/N)(与 Nautilus SortinoRatio 同式);
 *   volatility = std×√365;alpha/beta = 策略日收益对基准日收益的 OLS,alpha 年化 = (均值差)×365。日收益 < 30 个时这些给 null。
 * - cagr 窗口 < 30 天给 null;calmar = cagr / max_drawdown(回撤为 0 或 cagr 为 null 时 null)。
 * - max_drawdown 是逐根净值相对前高的最大跌幅(正数);time_in_drawdown = 净值低于前高的点数占比(等间隔 bar 即时间占比);
 *   max_drawdown_duration_ms = 从前高到重新站上前高(没收复就到窗口末)的最长时长。
 * - position 统计按「已平仓位」(同一 position 多次减仓合并):单笔收益 = 净盈亏 / 入场名义;avg_loss 为负数;
 *   risk_reward = avg_win / |avg_loss|;expectancy = 全部单笔收益均值;profit_factor = 盈利合计 / |亏损合计|(没有亏损时 null,不写无穷大)。
 * - exposure = 持仓市值/净值 的逐根均值(资金暴露);time_in_market = 有持仓的 bar 占比。
 * - benchmark_return 由调用方给的持有基准净值序列算(同一窗口、同一费率);excess_return = total_return - benchmark_return。
 *
 * 评分(Horizon 式 BacktestScore,0-100,只看主资产全窗口 + 分段):
 *   分项都先映射到 0-100 再按权重加总、四舍五入:
 *   risk_adjusted  25%  sharpe:≤0 → 0,≥2 → 100,线性;sharpe 为 null(样本不足)→ 0
 *   drawdown       20%  max_drawdown:0 → 100,≥50% → 0,线性
 *   profit_factor  15%  PF:≤0.5 → 0,≥2.5 → 100,线性;有盈利没有亏损 → 100;没有盈利 → 0
 *   vs_hold        15%  年化超额(cagr - 基准 cagr):≤-20% → 0,0 → 50,≥+20% → 100,分段线性;任一缺失 → 用总超额 ±50% 同式
 *   oos_stability  15%  样本外 vs 样本内年化收益:样本内 >0 时 ratio=oos/is,≤0 → 0,≥1 → 100;样本内 ≤0 时样本外 >0 → 50 否则 0;缺分段 → 50(中性)
 *   expectancy     10%  每笔期望:≤-2% → 0,0 → 50,≥+2% → 100,分段线性
 *   没有任何平仓交易时直接 0 分(poor),不让「没回撤」拿分。
 *   label:≥80 excellent,≥65 good,≥50 fair,≥35 needs_work,其余 poor。
 *   confidence 只看平仓笔数:<10 low、<30 medium、≥30 high;confidence_reason 形如「Low confidence, 1 trade」。
 */
import type { BacktestMetrics, BacktestPeriodReturn, BacktestScore, BacktestTradeStats, BacktestSideStats, BacktestCapitalUsage, BacktestCapacity, BacktestDailyPnl, BacktestExitReasonPnl } from '@trade-gate/contracts';
export const ANALYZER_VERSION = 'backtest-analyzer/v1';
const DAY = 86400000, YEAR = 365 * DAY;
export interface EquitySample { at: number; equity: number; exposure: number; benchmark: number | null; /** 同时持仓数(篮子按腿数);缺省按 exposure>0 记 1 */ positions?: number }
export interface ClosedTrade { entry_at: number; exit_at: number; pnl: number; return_pct: number; fees: number; bars_held: number; exit_reason: string; side: 'long' | 'short' }
const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
const std = (x: number[]) => { if (x.length < 2) return 0; const m = mean(x); return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1)); };
const fin = (x: number) => (Number.isFinite(x) ? x : null);
/** 每个 UTC 日最后一个点;返回 [day, value] 升序。 */
function dailyCloses(samples: EquitySample[], pick: (s: EquitySample) => number | null): [number, number][] {
  const m = new Map<number, number>();
  for (const s of samples) { const v = pick(s); if (v !== null && Number.isFinite(v)) m.set(Math.floor(s.at / DAY), v); }
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}
function returnsOf(closes: [number, number][]): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 1; i < closes.length; i++) { const prev = closes[i - 1]![1]; if (prev > 0) out.set(closes[i]![0], closes[i]![1] / prev - 1); }
  return out;
}
export const MIN_RETURNS = 30;
export function returnStats(samples: EquitySample[]) {
  const strat = returnsOf(dailyCloses(samples, (s) => s.equity)), bench = returnsOf(dailyCloses(samples, (s) => s.benchmark));
  const r = [...strat.values()], sd = std(r), enough = r.length >= MIN_RETURNS;
  const sharpe = enough && sd > 0 ? fin((mean(r) / sd) * Math.sqrt(365)) : null;
  const down = enough ? Math.sqrt(r.reduce((a, x) => a + Math.min(0, x) ** 2, 0) / r.length) : 0;
  const sortino = enough && down > 0 ? fin((mean(r) / down) * Math.sqrt(365)) : null;
  const volatility = enough ? fin(sd * Math.sqrt(365)) : null;
  const pairs = [...strat.entries()].filter(([d]) => bench.has(d)).map(([d, v]) => [v, bench.get(d)!] as const);
  let alpha: number | null = null, beta: number | null = null;
  if (pairs.length >= MIN_RETURNS) {
    const xs = pairs.map((p) => p[1]), ys = pairs.map((p) => p[0]), mx = mean(xs), my = mean(ys);
    const vx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    if (vx > 0) { beta = fin(xs.reduce((a, x, i) => a + (x - mx) * (ys[i]! - my), 0) / vx); alpha = beta === null ? null : fin((my - beta * mx) * 365); }
  }
  return { sharpe, sortino, volatility, alpha, beta, returns: r.length };
}
export function drawdownStats(samples: EquitySample[]) {
  let peak = -Infinity, peakAt = samples[0]?.at ?? 0, mdd = 0, under = 0, longest = 0, inDd = false;
  for (const s of samples) {
    if (s.equity >= peak) { if (inDd) longest = Math.max(longest, s.at - peakAt); peak = s.equity; peakAt = s.at; inDd = false; }
    else { inDd = true; under++; if (peak > 0) mdd = Math.max(mdd, 1 - s.equity / peak); }
  }
  if (inDd && samples.length) longest = Math.max(longest, samples.at(-1)!.at - peakAt);
  return { max_drawdown: mdd, time_in_drawdown: samples.length ? under / samples.length : 0, max_drawdown_duration_ms: Math.max(0, Math.round(longest)) };
}
export function cagrOf(start: number, end: number, from: number, to: number): number | null {
  const years = (to - from) / YEAR;
  if (!(start > 0) || years < 30 / 365) return null;
  return end <= 0 ? -1 : fin((end / start) ** (1 / years) - 1);
}
export type BacktestStats = BacktestMetrics;
/** samples[0] 是窗口起点净值(基准与策略同起点);trades 是本窗口内的已平仓位;fees 是本窗口内实付手续费合计。 */
export function analyze(samples: EquitySample[], trades: ClosedTrade[], fees: number): BacktestStats {
  const first = samples[0], last = samples.at(-1);
  const start = first?.equity ?? 0, end = last?.equity ?? start;
  const total_return = start > 0 ? end / start - 1 : 0;
  const cagr = first && last ? cagrOf(start, end, first.at, last.at) : null;
  const dd = drawdownStats(samples), rs = returnStats(samples);
  const b0 = first?.benchmark ?? null, b1 = last?.benchmark ?? null;
  const benchmark_return = b0 !== null && b1 !== null && b0 > 0 ? b1 / b0 - 1 : null;
  const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0), grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  const avg_win = wins.length ? mean(wins.map((t) => t.return_pct)) : null, avg_loss = losses.length ? mean(losses.map((t) => t.return_pct)) : null;
  let streakW = 0, streakL = 0, maxW = 0, maxL = 0;
  for (const t of [...trades].sort((a, b) => a.exit_at - b.exit_at)) {
    if (t.pnl > 0) { streakW++; streakL = 0; } else if (t.pnl < 0) { streakL++; streakW = 0; } else { streakW = 0; streakL = 0; }
    maxW = Math.max(maxW, streakW); maxL = Math.max(maxL, streakL);
  }
  const rets = trades.map((t) => t.return_pct);
  return {
    total_return, cagr, max_drawdown: dd.max_drawdown, sharpe: rs.sharpe, sortino: rs.sortino,
    calmar: cagr !== null && dd.max_drawdown > 0 ? fin(cagr / dd.max_drawdown) : null, volatility: rs.volatility,
    win_rate: trades.length ? wins.length / trades.length : null, profit_factor: grossLoss > 0 ? grossWin / grossLoss : null,
    avg_win, avg_loss, risk_reward: avg_win !== null && avg_loss !== null && avg_loss < 0 ? avg_win / -avg_loss : null,
    expectancy: trades.length ? mean(rets) : null, max_win_streak: maxW, max_loss_streak: maxL,
    time_in_drawdown: dd.time_in_drawdown, max_drawdown_duration_ms: dd.max_drawdown_duration_ms, trades: trades.length,
    exposure: samples.length ? mean(samples.map((s) => s.exposure)) : 0, time_in_market: samples.length ? samples.filter((s) => s.exposure > 0).length / samples.length : 0,
    avg_holding_ms: trades.length ? mean(trades.map((t) => t.exit_at - t.entry_at)) : null,
    best_trade: rets.length ? Math.max(...rets) : null, worst_trade: rets.length ? Math.min(...rets) : null,
    net_pnl: end - start, fees, benchmark_return, excess_return: benchmark_return === null ? null : total_return - benchmark_return,
    alpha: rs.alpha, beta: rs.beta,
  };
}
/** 日历月 / 年收益:期末净值 / 上一期期末(第一期用窗口起点)- 1;基准同式。 */
export function periodReturns(samples: EquitySample[], kind: 'month' | 'year'): BacktestPeriodReturn[] {
  const key = (at: number) => { const d = new Date(at); return kind === 'year' ? String(d.getUTCFullYear()) : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
  const out: BacktestPeriodReturn[] = [];
  if (!samples.length) return out;
  let prevE = samples[0]!.equity, prevB = samples[0]!.benchmark, cur = key(samples[0]!.at), lastE = prevE, lastB = prevB;
  const flush = () => out.push({ period: cur, return: prevE > 0 ? lastE / prevE - 1 : 0, benchmark: prevB !== null && lastB !== null && prevB > 0 ? lastB / prevB - 1 : null });
  for (const s of samples.slice(1)) {
    const k = key(s.at);
    if (k !== cur) { flush(); prevE = lastE; prevB = lastB; cur = k; }
    lastE = s.equity; lastB = s.benchmark;
  }
  flush();
  return out;
}
export const HOLDING_BINS = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377];
export const RETURN_BINS = [-0.2, -0.1, -0.05, -0.02, 0, 0.02, 0.05, 0.1, 0.2];
/** 边界数组 bins(k+1 个)对应 counts(k 个);落在两端之外的计入首/末桶。 */
export function histogram(values: number[], bins: number[]): { bins: number[]; counts: number[] } {
  const counts = Array<number>(bins.length - 1).fill(0);
  for (const v of values) { let i = bins.findIndex((edge, j) => j > 0 && v < edge) - 1; if (i < 0) i = v < bins[0]! ? 0 : counts.length - 1; counts[i] = counts[i]! + 1; }
  return { bins: [...bins], counts };
}
export function tradeStats(trades: ClosedTrade[]): BacktestTradeStats | null {
  if (!trades.length) return null;
  const exit_reasons: Record<string, number> = {}, pnl_by_exit_reason: Record<string, BacktestExitReasonPnl> = {};
  for (const t of trades) exit_reasons[t.exit_reason] = (exit_reasons[t.exit_reason] ?? 0) + 1;
  // 按退出原因的盈亏(Horizon 诊断「SL 56 笔亏 4950」就靠这一张):笔数、净盈亏合计、平均单笔收益
  for (const [reason, count] of Object.entries(exit_reasons)) { const g = trades.filter((t) => t.exit_reason === reason); pnl_by_exit_reason[reason] = { count, pnl: g.reduce((a, t) => a + t.pnl, 0), avg_return: mean(g.map((t) => t.return_pct)) }; }
  return { exit_reasons, pnl_by_exit_reason, holding_histogram: histogram(trades.map((t) => t.bars_held), HOLDING_BINS), return_histogram: histogram(trades.map((t) => t.return_pct), RETURN_BINS), long_trades: trades.filter((t) => t.side === 'long').length, short_trades: trades.filter((t) => t.side === 'short').length };
}
const lin = (x: number, lo: number, hi: number) => Math.max(0, Math.min(100, ((x - lo) / (hi - lo)) * 100));
/** 以 0 为 50 分的对称分段线性:x ≤ -span → 0,x ≥ span → 100。 */
const centered = (x: number, span: number) => Math.max(0, Math.min(100, 50 + (x / span) * 50));
export function scoreLabel(v: number): BacktestScore['label'] { return v >= 80 ? 'excellent' : v >= 65 ? 'good' : v >= 50 ? 'fair' : v >= 35 ? 'needs_work' : 'poor'; }
export function confidenceOf(trades: number): { confidence: BacktestScore['confidence']; confidence_reason: string } {
  const confidence = trades < 10 ? 'low' : trades < 30 ? 'medium' : 'high';
  return { confidence, confidence_reason: `${confidence[0]!.toUpperCase()}${confidence.slice(1)} confidence, ${trades} trade${trades === 1 ? '' : 's'}` };
}
export function score(m: BacktestMetrics, segments: { in_sample: BacktestMetrics | null; out_of_sample: BacktestMetrics | null }, benchmark_cagr: number | null): BacktestScore {
  const conf = confidenceOf(m.trades);
  if (!m.trades) return { value: 0, label: 'poor', ...conf, components: [{ key: 'no_trades', value: 0, weight: 1, note: '窗口内没有平仓交易,无法评价' }] };
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const excess = m.cagr !== null && benchmark_cagr !== null ? { v: centered(m.cagr - benchmark_cagr, 0.2), note: `年化 ${(m.cagr * 100).toFixed(1)}% vs 持有 ${(benchmark_cagr * 100).toFixed(1)}%` } : m.excess_return !== null ? { v: centered(m.excess_return, 0.5), note: `总超额 ${(m.excess_return * 100).toFixed(1)}%(年化不可用)` } : { v: 50, note: '缺持有基准,按中性计' };
  const is = segments.in_sample, oos = segments.out_of_sample;
  const isR = is?.cagr ?? null, oosR = oos?.cagr ?? null;
  const stability = isR === null || oosR === null ? { v: 50, note: '缺样本内/外年化收益,按中性计' } : isR > 0 ? { v: lin(oosR / isR, 0, 1), note: `样本外年化 ${(oosR * 100).toFixed(1)}% / 样本内 ${(isR * 100).toFixed(1)}%` } : { v: oosR > 0 ? 50 : 0, note: `样本内年化 ${(isR * 100).toFixed(1)}% 不为正,样本外 ${(oosR * 100).toFixed(1)}%` };
  const pf = m.profit_factor === null ? (m.win_rate && m.win_rate > 0 ? 100 : 0) : lin(m.profit_factor, 0.5, 2.5);
  const components = [
    { key: 'risk_adjusted', value: m.sharpe === null ? 0 : lin(m.sharpe, 0, 2), weight: 0.25, note: m.sharpe === null ? '日收益不足 30 个,Sharpe 不可用' : `Sharpe ${m.sharpe.toFixed(2)}` },
    { key: 'drawdown', value: lin(-m.max_drawdown, -0.5, 0), weight: 0.2, note: `最大回撤 ${(m.max_drawdown * 100).toFixed(1)}%` },
    { key: 'profit_factor', value: pf, weight: 0.15, note: m.profit_factor === null ? (pf ? '没有亏损交易' : '没有盈利交易') : `盈亏因子 ${m.profit_factor.toFixed(2)}` },
    { key: 'vs_hold', value: excess.v, weight: 0.15, note: excess.note },
    { key: 'oos_stability', value: stability.v, weight: 0.15, note: stability.note },
    { key: 'expectancy', value: m.expectancy === null ? 0 : centered(m.expectancy, 0.02), weight: 0.1, note: m.expectancy === null ? '无平仓交易' : `每笔期望 ${(m.expectancy * 100).toFixed(2)}%` },
  ].map((c) => ({ ...c, value: r2(c.value) }));
  const value = Math.max(0, Math.min(100, Math.round(components.reduce((a, c) => a + c.value * c.weight, 0))));
  return { value, label: scoreLabel(value), ...conf, components: components as BacktestScore['components'] };
}
/** 净值降采样到 ≤ max 点:按时间分桶,每桶保留最低点与最高点(按时间顺序),首尾点必留;不插值、不改值。 */
export function downsample<T extends { at: number; equity: number }>(points: T[], max = 1000): T[] {
  if (points.length <= max) return points;
  const buckets = Math.floor((max - 2) / 2), inner = points.slice(1, -1), size = inner.length / buckets, out: T[] = [points[0]!];
  for (let b = 0; b < buckets; b++) {
    const seg = inner.slice(Math.floor(b * size), Math.floor((b + 1) * size));
    if (!seg.length) continue;
    let lo = seg[0]!, hi = seg[0]!;
    for (const p of seg) { if (p.equity < lo.equity) lo = p; if (p.equity > hi.equity) hi = p; }
    if (lo === hi) out.push(lo); else out.push(...(lo.at < hi.at ? [lo, hi] : [hi, lo]));
  }
  out.push(points.at(-1)!);
  return out;
}

/** 多空拆分:现货只有多头,空头一栏为 0 笔、null 比例。 */
export function sideBreakdown(trades: ClosedTrade[]): { long: BacktestSideStats; short: BacktestSideStats } {
  const side = (k: 'long' | 'short'): BacktestSideStats => { const g = trades.filter((t) => t.side === k); return { trades: g.length, total_pnl: g.reduce((a, t) => a + t.pnl, 0), win_rate: g.length ? g.filter((t) => t.pnl > 0).length / g.length : null, avg_return: g.length ? mean(g.map((t) => t.return_pct)) : null }; };
  return { long: side('long'), short: side('short') };
}
/** UTC 日净值收益(Trades analysis 的 Net Daily P/L 柱图),第一天相对窗口起点;只留最近 max 天。 */
export function dailyPnl(samples: EquitySample[], max = 3000): BacktestDailyPnl[] {
  const closes = dailyCloses(samples, (s) => s.equity), out: BacktestDailyPnl[] = [];
  let prev = samples[0]?.equity ?? 0;
  for (const [d, v] of closes) { out.push({ day: new Date(d * DAY).toISOString().slice(0, 10), pnl_pct: prev > 0 ? v / prev - 1 : 0 }); prev = v; }
  return out.slice(-max);
}
/** 资金使用:idle_fraction = 没有任何持仓的 bar 占比(Horizon 诊断「资金 53% 时间闲置」)。 */
export function capitalUsage(samples: EquitySample[]): BacktestCapitalUsage | null {
  if (!samples.length) return null;
  const pos = samples.map((s) => s.positions ?? (s.exposure > 0 ? 1 : 0)), busy = pos.filter((p) => p > 0).length;
  return { avg_exposure: mean(samples.map((s) => s.exposure)), max_exposure: Math.max(...samples.map((s) => s.exposure)), time_in_market: busy / samples.length, avg_concurrent_positions: mean(pos), idle_fraction: 1 - busy / samples.length };
}
export const CAPACITY_PARTICIPATION = 0.01;
/**
 * 策略容量粗估:单笔入场名义 ≤ 窗口内每根 bar 成交额(close×volume)中位数 × 参与率(1%)时,可容纳资金 ≈ 中位成交额 × 1% / 平均单笔入场占净值比例。
 * 入场占比按每笔入场名义 / 入场前最后一个净值点;没有交易或成交额为 0 时给 null。只是量级,不含冲击成本模型。
 */
export function strategyCapacity(quoteVolumes: number[], entries: { at: number; notional: number }[], samples: EquitySample[]): BacktestCapacity {
  const method = `单笔入场名义不超过窗口内 bar 成交额(close×volume)中位数的 ${CAPACITY_PARTICIPATION * 100}% ⇒ 资金 ≈ 中位成交额 × ${CAPACITY_PARTICIPATION} / 平均单笔入场占净值比例;粗估量级,不含冲击成本`;
  const v = quoteVolumes.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b), median = v.length ? (v[Math.floor((v.length - 1) / 2)]! + v[Math.floor(v.length / 2)]!) / 2 : null;
  const fr: number[] = [];
  for (const e of entries) { let eq: number | null = null; for (const s of samples) { if (s.at <= e.at) eq = s.equity; else break; } if (eq && eq > 0 && e.notional > 0) fr.push(e.notional / eq); }
  const avg = fr.length ? mean(fr) : null;
  return { capacity_usd: median !== null && avg !== null && avg > 0 ? (median * CAPACITY_PARTICIPATION) / avg : null, participation_rate: CAPACITY_PARTICIPATION, median_bar_quote_volume: median, avg_entry_fraction: avg, method };
}

/**
 * 稳健中心(2026-09-23 晚,交接六-4):平均值旁边必给中位数与截尾均值。教训:几何实验室 8/19 一簇行情撑起了整个平均值。
 * 口径:截尾均值两端各截 floor(n × 10%) 个(排序后丢掉最小与最大各 k 个再求均值);n < 10 时 k = 0,不截尾,截尾均值 = 均值,basis 里写明。
 * 中位数:偶数个取中间两个的均值。纯函数,只在报告层派生,不进回测指标与报告哈希输入(BacktestMetrics 不变)。
 */
export const TRIM_FRACTION = 0.1;
export interface CenterStats {
  n: number;
  mean: number | null;
  median: number | null;
  trimmed_mean: number | null;
  /** 两端各截掉的个数 */
  trimmed_each_side: number;
  trim_fraction: number;
  /** 口径说明,例:「两端各截 3 笔(33 笔 × 10% 向下取整)」「笔数 6 < 10,不截尾,截尾均值 = 均值」 */
  basis: string;
}
export function centerStats(values: number[], trim = TRIM_FRACTION, unit = '笔'): CenterStats {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b), n = xs.length;
  const k = Math.floor(n * trim + 1e-9), minN = Math.ceil(1 / trim - 1e-9);
  if (!n) return { n, mean: null, median: null, trimmed_mean: null, trimmed_each_side: 0, trim_fraction: trim, basis: `没有${unit === '笔' ? '平仓交易' : '样本'}` };
  const median = (xs[Math.floor((n - 1) / 2)]! + xs[Math.floor(n / 2)]!) / 2, kept = xs.slice(k, n - k);
  return {
    n, mean: mean(xs), median, trimmed_mean: mean(kept), trimmed_each_side: k, trim_fraction: trim,
    basis: k > 0 ? `两端各截 ${k} ${unit}(${n} ${unit} × ${Math.round(trim * 100)}% 向下取整)` : `${unit}数 ${n} < ${minN},不截尾,截尾均值 = 均值`,
  };
}
/** 均值是否被少数极端值撑起:均值 > 0,但中位数或截尾均值 ≤ 0(或反向:均值 < 0 而两者都 > 0)。 */
export function tailDriven(c: CenterStats): 'up' | 'down' | null {
  if (c.mean === null || c.median === null || c.trimmed_mean === null) return null;
  if (c.mean > 0 && (c.median <= 0 || c.trimmed_mean <= 0)) return 'up';
  if (c.mean < 0 && c.median > 0 && c.trimmed_mean > 0) return 'down';
  return null;
}
/** 一句话展示:「均值 +1.20%、中位数 −0.40%、截尾均值 +0.10%(两端各截 3 笔…)」;fmt 由调用方给(百分比 / R)。 */
export function centerText(c: CenterStats, fmt: (v: number | null) => string): string {
  return `均值 ${fmt(c.mean)}、中位数 ${fmt(c.median)}、截尾均值 ${fmt(c.trimmed_mean)}(${c.basis})`;
}
/** 已平仓逐笔收益(return_pct)的稳健中心。 */
export function tradeReturnCenter(trades: { return_pct: number }[]): CenterStats { return centerStats(trades.map((t) => t.return_pct)); }
