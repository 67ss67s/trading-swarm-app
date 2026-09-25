/** 离线双腿研究接口；不得传给单腿执行入口。价格/数量序列化为十进制字符串。 */
export interface PairModel {
  alpha: number; hedge_ratio: number; mean: number; variance: number;
  phi: number; half_life: number | null; stable: boolean; train_n: number;
}
export interface PairSetup {
  at: number; symbols: readonly [string, string]; hedge_ratio: number; z: number;
  direction: 'long_spread' | 'short_spread';
  legs: readonly [{ symbol: string; direction: 'long' | 'short' }, { symbol: string; direction: 'long' | 'short' }];
}
export interface PairSignalContext { at: number; symbols: readonly [string, string]; closes: readonly [string, string]; model: Readonly<PairModel> }
export type PairSignalFn = (ctx: PairSignalContext) => PairSetup | null;
const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
export function estimatePairModel(a: string[], b: string[]): PairModel {
  if (a.length !== b.length || a.length < 48) throw new Error('训练数据不足或不对齐');
  const logs = (v: string[]) => v.map(x => { const n = Number(x); if (!(n > 0 && Number.isFinite(n))) throw new Error('价格无效'); return Math.log(n); });
  const y = logs(a); const x = logs(b); const mx = mean(x); const my = mean(y);
  const xx = x.reduce((v, n) => v + (n - mx) ** 2, 0);
  if (xx <= 1e-16) throw new Error('退化训练方差');
  const beta = x.reduce((v, n, i) => v + (n - mx) * (y[i]! - my), 0) / xx;
  const alpha = my - beta * mx;
  const residual = y.map((n, i) => n - alpha - beta * x[i]!); const mu = mean(residual);
  const variance = residual.reduce((v, n) => v + (n - mu) ** 2, 0) / (x.length - 1);
  if (!(variance > 1e-16)) throw new Error('退化残差方差');
  const lag = residual.slice(0, -1); const next = residual.slice(1); const ml = mean(lag); const mn = mean(next);
  const phi = lag.reduce((v, n, i) => v + (n - ml) * (next[i]! - mn), 0) / lag.reduce((v, n) => v + (n - ml) ** 2, 0);
  const half = phi > 0 && phi < 1 ? -Math.log(2) / Math.log(phi) : null;
  return { alpha, hedge_ratio: beta, mean: mu, variance, phi, half_life: half, stable: beta > 0 && half !== null && half >= 1 && half <= 24, train_n: a.length };
}
export function pairZ(model: Readonly<PairModel>, a: string, b: string): number {
  if (![Number(a), Number(b), model.variance].every(v => Number.isFinite(v) && v > 0)) throw new Error('无效z输入');
  return (Math.log(Number(a)) - model.alpha - model.hedge_ratio * Math.log(Number(b)) - model.mean) / Math.sqrt(model.variance);
}
export const relativeValueSignal: PairSignalFn = c => {
  if (!c.model.stable) return null;
  const z = pairZ(c.model, ...c.closes);
  if (Math.abs(z) < 2 || Math.abs(z) >= 3) return null;
  return { at: c.at, symbols: c.symbols, hedge_ratio: c.model.hedge_ratio, z, direction: z > 0 ? 'short_spread' : 'long_spread', legs: [{ symbol: c.symbols[0], direction: z > 0 ? 'short' : 'long' }, { symbol: c.symbols[1], direction: z > 0 ? 'long' : 'short' }] };
};
export const PAIR_SIGNAL_REGISTRY: Readonly<Record<'relative_value', PairSignalFn>> = { relative_value: relativeValueSignal };
