/** 无 I/O 的无偏回放统计。窗口为左闭右开，所有选择只使用已完整结算的训练样本。 */
import type { Kline } from './types.js';
export function validKline(bar: Kline): boolean {
  const [open, high, low, close, volume] = [bar.open, bar.high, bar.low, bar.close, bar.volume].map(Number);
  return [open, high, low, close].every(v => Number.isFinite(v) && v! > 0) && Number.isFinite(volume) && volume! >= 0 && low! <= Math.min(open!, close!) && high! >= Math.max(open!, close!) && Number.isInteger(bar.open_time) && Number.isInteger(bar.close_time);
}
export const DAY = 86_400_000;
export const UNIVERSE_RULE = 'cached_listing_age>=30d;rank_by_pre_start_30d_close_times_base_volume;top_n;cached_delisted_included';
export interface ReplaySample { equity_marks?: { at: number; r: number }[]; at: number; exit_at: number; horizon_end_at: number; gross_r: number; net_r: number; regime: 'trend' | 'range' | 'high_vol' | 'unknown'; symbol: string }
export interface Fold { train_from: number; train_to: number; test_from: number; test_to: number }
export interface ConfidenceInterval { status: 'sufficient' | 'insufficient'; lower: number | null; upper: number | null; iterations: number; block_size: number }
const mean = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
export function anchoredWalkForward(from: number, to: number, horizonBars: number, timeframeMs: number, trainDays = 60, testDays = 20): Fold[] {
  if (!(to > from && horizonBars >= 1 && timeframeMs > 0 && trainDays > 0 && testDays > 0)) throw new Error('无效 walk-forward 窗口');
  const folds: Fold[] = []; const purge = horizonBars * timeframeMs;
  for (let start = from + trainDays * DAY + purge; start + testDays * DAY <= to; start += testDays * DAY + purge) {
    folds.push({ train_from: from, train_to: start - purge, test_from: start, test_to: start + testDays * DAY });
  }
  return folds;
}
/** 固定种子的循环移动块 bootstrap，保留短程序列相关；最少 1000 次。 */
export function bootstrapCI(values: number[], iterations = 2000, seed = 0x51a7): ConfidenceInterval {
  if (values.some(v => !Number.isFinite(v))) throw new Error('R 必须有限');
  const n = values.length; const block = Math.max(1, Math.ceil(Math.sqrt(n))); const count = Math.max(1000, Math.floor(iterations));
  if (n < 30) return { status: 'insufficient', lower: null, upper: null, iterations: count, block_size: block };
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  const means: number[] = [];
  for (let j = 0; j < count; j++) {
    let sum = 0; let used = 0;
    while (used < n) { const start = Math.floor(random() * n); for (let k = 0; k < block && used < n; k++, used++) sum += values[(start + k) % n]!; }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return { status: 'sufficient', lower: means[Math.floor(count * 0.025)]!, upper: means[Math.ceil(count * 0.975) - 1]!, iterations: count, block_size: block };
}
function cdf(x: number): number {
  const z = Math.abs(x); const t = 1 / (1 + 0.2316419 * z);
  const q = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI) * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - q : q;
}
function quantile(p: number): number { let lo = -10; let hi = 10; for (let i = 0; i < 70; i++) { const mid = (lo + hi) / 2; if (cdf(mid) < p) lo = mid; else hi = mid; } return (lo + hi) / 2; }
export function sharpe(v: number[]): number | null {
  if (v.length < 2) return null; const m = mean(v)!;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
  return sd > 0 ? m / sd : null;
}
/** Bailey–López de Prado (2014): 返回原文概率与有符号校正 Sharpe。零方差不声称显著。 */
export function deflatedSharpe(values: number[], trialCount: number, trialSharpes: number[] = []): { dsr: number | null; dsr_probability: number | null; sharpe: number | null; expected_max_sharpe: number | null } {
  const sr = sharpe(values); const n = values.length;
  if (sr === null || n < 30 || !Number.isInteger(trialCount) || trialCount < 1) return { dsr: null, dsr_probability: null, sharpe: sr, expected_max_sharpe: null };
  const m = mean(values)!; const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / n;
  const skew = values.reduce((a, b) => a + (b - m) ** 3, 0) / n / variance ** 1.5;
  const kurtosis = values.reduce((a, b) => a + (b - m) ** 4, 0) / n / variance ** 2;
  const trialMean = mean(trialSharpes) ?? 0;
  const empirical = trialSharpes.length > 1 ? trialSharpes.reduce((a, b) => a + (b - trialMean) ** 2, 0) / (trialSharpes.length - 1) : 0;
  // 缺历史 trial SR 时采用零假设标准误下限，并在报告标注估计。
  const sigma = Math.sqrt(Math.max(empirical, 1 / (n - 1)));
  const gamma = 0.5772156649015329;
  const expected = trialCount <= 1 ? 0 : sigma * ((1 - gamma) * quantile(1 - 1 / trialCount) + gamma * quantile(1 - 1 / (trialCount * Math.E)));
  const denominator = Math.sqrt(Math.max(1e-12, 1 - skew * sr + (kurtosis - 1) / 4 * sr * sr));
  return { dsr: sr - expected, dsr_probability: cdf((sr - expected) * Math.sqrt(n - 1) / denominator), sharpe: sr, expected_max_sharpe: expected };
}
/** 不按今天的 TRADING/白名单过滤。首根缓存只能作为保守上市时间代理。 */
export function selectUniverse(series: Record<string, Kline[]>, at: number, topN: number): string[] {
  return Object.entries(series).flatMap(([symbol, raw]) => {
    const bars = raw.filter(b => b.close_time < at).sort((a, b) => a.open_time - b.open_time);
    if (!bars.length || bars[0]!.open_time > at - 30 * DAY) return [];
    const recent = bars.filter(b => b.open_time >= at - 30 * DAY);
    if (!recent.length || recent.at(-1)!.close_time < at - DAY) return [];
    return [{ symbol, turnover: recent.reduce((n, b) => n + Number(b.close) * Number(b.volume), 0) }];
  }).sort((a, b) => b.turnover - a.turnover || a.symbol.localeCompare(b.symbol)).slice(0, Math.max(0, Math.floor(topN))).map(x => x.symbol);
}
/** 同一 4h 行情桶保守视为一个相关簇；推断统计使用簇均值。 */
export function effectiveReturns(samples: readonly { at: number; net_r: number }[]): number[] {
  const buckets = new Map<number, number[]>();
  for (const s of samples) { const k = Math.floor(s.at / (4 * 3600000)); const v = buckets.get(k) ?? []; v.push(s.net_r); buckets.set(k, v); }
  return [...buckets].sort((a, b) => a[0] - b[0]).map(([, v]) => mean(v)!);
}
/** 同一时点先合并全部仓位估值变化，避免成交排序制造或隐藏回撤。 */
export function equityDrawdown(samples: readonly { exit_at: number; net_r: number; equity_marks?: { at: number; r: number }[] }[]): number {
  const deltas = new Map<number, number>();
  for (const s of samples) {
    let prev = 0;
    const marks = [...(s.equity_marks ?? []).filter(m => m.at < s.exit_at), { at: s.exit_at, r: s.net_r }].sort((a,b) => a.at-b.at);
    for (const m of marks) { deltas.set(m.at, (deltas.get(m.at) ?? 0) + m.r - prev); prev = m.r; }
  }
  let equity = 0, peak = 0, dd = 0;
  for (const [, delta] of [...deltas].sort((a,b) => a[0]-b[0])) { equity += delta; peak = Math.max(peak, equity); dd = Math.max(dd, peak-equity); }
  return dd;
}
export function summarizeReplay(samples: ReplaySample[], folds: Fold[], trialCount: number, trialSharpes: number[] = []) {
  const sorted = [...samples].sort((a, b) => a.at - b.at || a.symbol.localeCompare(b.symbol));
  const oos = sorted.filter(s => folds.some(f => s.at >= f.test_from && s.horizon_end_at < f.test_to));
  const initial = folds[0];
  const ins = initial ? sorted.filter(s => s.at >= initial.train_from && s.horizon_end_at < initial.train_to) : [];
  const gross = sorted.map(s => s.gross_r); const net = sorted.map(s => s.net_r); const oosNet = effectiveReturns(oos);
  const dd = equityDrawdown(oos);
  const regime = Object.fromEntries(['trend', 'range', 'high_vol', 'unknown'].map(key => { const v = effectiveReturns(oos.filter(s => s.regime === key)); return [key, { n: v.length, net_expectancy: mean(v) }]; }));
  return { gross: { expectancy_r: mean(gross), total_r: gross.reduce((a, b) => a + b, 0) }, net: { expectancy_r: mean(net), total_r: net.reduce((a, b) => a + b, 0) }, is_expectancy: mean(ins.map(s => s.net_r)), oos_expectancy: mean(oosNet), oos_net_expectancy: mean(oosNet), raw_n: sorted.length, effective_n: effectiveReturns(sorted).length, oos_raw_n: oos.length, oos_n: oosNet.length, oos_ci: bootstrapCI(oosNet), ...deflatedSharpe(oosNet, trialCount, trialSharpes), trial_count: trialCount, regime, max_dd_r: dd, universe_rule: UNIVERSE_RULE, folds };
}
export type ReplayStats = ReturnType<typeof summarizeReplay>;
export function probeVerified(s: Partial<ReplayStats> | null | undefined): boolean { return !!s && (s.oos_n ?? 0) >= 30 && (s.dsr ?? -Infinity) > 0 && (s.oos_ci?.lower ?? -Infinity) > 0; }
/** 每折仅按训练净收益选一个候选；测试结果不参与排名。 */
export function selectWalkForward(candidates: { key: string; samples: ReplaySample[] }[], folds: Fold[]) {
  return folds.flatMap(f => {
    const ranked = candidates.map(c => ({ c, train: c.samples.filter(s => s.at >= f.train_from && s.horizon_end_at < f.train_to) })).filter(c => effectiveReturns(c.train).length >= 30).sort((a, b) => mean(effectiveReturns(b.train))! - mean(effectiveReturns(a.train))! || a.c.key.localeCompare(b.c.key));
    const best = ranked[0]; return best ? [{ fold: f, key: best.c.key, is_expectancy: mean(best.train.map(s => s.net_r)), samples: best.c.samples.filter(s => s.at >= f.test_from && s.horizon_end_at < f.test_to) }] : [];
  });
}
