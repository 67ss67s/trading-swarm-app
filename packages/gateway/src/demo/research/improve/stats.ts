/**
 * 改进环用到的统计工具(纯函数,零依赖):正态分布、日收益矩、Deflated Sharpe、固定种子随机数。
 *
 * Deflated Sharpe(Bailey & López de Prado, 2014, "The Deflated Sharpe Ratio"):
 *   SR0 = √V[SR_n] × ((1−γ)·Φ⁻¹(1−1/N) + γ·Φ⁻¹(1−1/(N·e))),γ = 0.5772(欧拉–马歇罗尼常数)
 *   DSR = Φ( (SR − SR0)·√(T−1) / √(1 − γ3·SR + (γ4−1)/4·SR²) )
 *   SR 与 V[SR_n] 都是「每期」(这里是日)夏普,不年化;T = 日收益个数;γ3 偏度、γ4 峰度(正态为 3,不是超额峰度)。
 *   N = 这条谱系累计试过的候选数;N < 2 时 SR0 = 0,退化为 Probabilistic Sharpe Ratio。
 *   含义:在「试了 N 次挑最好的」这个事实下,观测夏普仍显著大于 0 的概率;≥ 0.95 才算扛住了多重试验。
 */
const EULER_GAMMA = 0.5772156649015329;
const DAY = 86400000;

/** 标准正态 CDF:Φ(x) = ½·erfc(−x/√2),erfc 用 Numerical Recipes 的 Chebyshev 近似(相对误差 < 1.2e-7)。 */
export function normCdf(x: number): number {
  if (x === Infinity) return 1;
  if (x === -Infinity) return 0;
  const z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.5 * z);
  const erfc = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - erfc / 2 : erfc / 2;
}

/** 标准正态分位数 Φ⁻¹(p):Acklam 有理近似(相对误差 < 1.2e-9)。p ∉ (0,1) 返回 ±Infinity。 */
export function normInv(p: number): number {
  if (!(p > 0)) return -Infinity;
  if (!(p < 1)) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425, hi = 1 - lo;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  if (p > hi) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

export const mean = (x: number[]): number => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
/** 样本标准差(n−1);n < 2 返回 0。 */
export function stdev(x: number[]): number { if (x.length < 2) return 0; const m = mean(x); return Math.sqrt(x.reduce((a, v) => a + (v - m) ** 2, 0) / (x.length - 1)); }
/** 样本方差(n−1);n < 2 返回 0。 */
export const variance = (x: number[]): number => stdev(x) ** 2;
export function median(x: number[]): number | null { if (!x.length) return null; const s = [...x].sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; }
/** 偏度与峰度(总体矩,峰度不减 3;正态 = 0 / 3)。 */
export function moments(x: number[]): { skew: number; kurtosis: number } {
  const n = x.length, m = mean(x);
  if (n < 3) return { skew: 0, kurtosis: 3 };
  const m2 = x.reduce((a, v) => a + (v - m) ** 2, 0) / n, m3 = x.reduce((a, v) => a + (v - m) ** 3, 0) / n, m4 = x.reduce((a, v) => a + (v - m) ** 4, 0) / n;
  return m2 > 0 ? { skew: m3 / m2 ** 1.5, kurtosis: m4 / m2 ** 2 } : { skew: 0, kurtosis: 3 };
}

/** 净值序列 → UTC 日收益(每天最后一个点,相邻两天相除;与 analyzer.returnStats 同口径)。 */
export function dailyReturns(samples: { at: number; equity: number }[]): number[] {
  const m = new Map<number, number>();
  for (const s of samples) if (Number.isFinite(s.equity)) m.set(Math.floor(s.at / DAY), s.equity);
  const closes = [...m.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1]), out: number[] = [];
  for (let i = 1; i < closes.length; i++) if (closes[i - 1]! > 0) out.push(closes[i]! / closes[i - 1]! - 1);
  return out;
}
/** 每期(日)夏普,不年化;样本 < 2 或波动为 0 时 null。 */
export function periodSharpe(r: number[]): number | null { const sd = stdev(r); return r.length >= 2 && sd > 0 ? mean(r) / sd : null; }

/** 试了 N 次、各候选夏普方差为 V 时,纯噪声下期望的最大夏普 SR0。 */
export function expectedMaxSharpe(trials: number, sharpeVariance: number): number {
  if (trials < 2 || !(sharpeVariance > 0)) return 0;
  return Math.sqrt(sharpeVariance) * ((1 - EULER_GAMMA) * normInv(1 - 1 / trials) + EULER_GAMMA * normInv(1 - 1 / (trials * Math.E)));
}
export interface DeflatedSharpe { dsr: number; sr0: number }
/** Deflated Sharpe(见文件头);分母非正(极端偏度)时返回 null。 */
export function deflatedSharpe(input: { sharpe: number; trials: number; sharpeVariance: number; days: number; skew: number; kurtosis: number }): DeflatedSharpe | null {
  const { sharpe: sr, days: t, skew, kurtosis } = input;
  if (!Number.isFinite(sr) || t < 2) return null;
  const sr0 = expectedMaxSharpe(input.trials, input.sharpeVariance);
  const denom = 1 - skew * sr + ((kurtosis - 1) / 4) * sr * sr;
  if (!(denom > 0)) return null;
  return { dsr: normCdf(((sr - sr0) * Math.sqrt(t - 1)) / Math.sqrt(denom)), sr0 };
}

/** 固定种子伪随机数(mulberry32),[0,1)。同种子同序列,随机入场基线可复现。 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
