/** 订单意图性能基准与逐位对拍共用的合成数据(2026-09-26):确定性随机游走 15m K 线 + 一份典型 IR(indicator_cross 信号 + 方向门 + ATR 止损 + 信号离场)。 */
import type { ResearchBar, StrategyIR } from '@trade-gate/contracts';
import { defaultIR, node } from '../../../../src/demo/research/strategy.js';
export const STEP15 = 15 * 60_000;
/** mulberry32:确定性伪随机,同种子同序列 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** 带趋势段与波动聚集的随机游走;价格为十进制字符串(同真实数据集) */
export function synthBars(n: number, seed = 7, t0 = Date.UTC(2025, 0, 1)): ResearchBar[] {
  const r = rng(seed); let price = 60000, drift = 0, vol = 0.002;
  const out: ResearchBar[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 200 === 0) drift = (r() - 0.5) * 0.0008;
    vol = Math.min(0.01, Math.max(0.0008, vol * (0.97 + r() * 0.06)));
    const open = price, ret = drift + (r() - 0.5) * 2 * vol; price = Math.max(100, price * (1 + ret));
    const hi = Math.max(open, price) * (1 + r() * vol), lo = Math.min(open, price) * (1 - r() * vol);
    out.push({ open_time: t0 + i * STEP15, close_time: t0 + (i + 1) * STEP15 - 1, available_at: t0 + (i + 1) * STEP15 - 1, open: open.toFixed(2), high: hi.toFixed(2), low: lo.toFixed(2), close: price.toFixed(2), volume: (50 + r() * 500).toFixed(3) } as ResearchBar);
  }
  return out;
}
/** 典型研究 IR:EMA20 上穿 EMA50 入场,价格在 EMA200 上方为方向门,ATR 止损,死叉 + chandelier 离场 */
export function benchIR(direction: 'long' | 'both' = 'long'): StrategyIR {
  const base = defaultIR();
  return {
    ...base,
    signal: [node('indicator_cross', { indicator: 'ema', args: { period: 20 }, compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: 50 }, direction: 'cross_above' })],
    regime: node('indicator_cross', { indicator: 'ema', args: { period: 200 }, compare_to: 'price', compare_price: 'close', direction: 'below' }),
    risk: { ...base.risk, stop: node('atr_stop', { atr_period: 14, multiple: 2 }) },
    exit: [node('indicator_cross_exit', { indicator: 'ema', args: { period: 20 }, compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: 50 }, direction: 'cross_below' }), node('chandelier_trail', { atr_period: 22, multiple: 3 }), node('fixed_r_target', { r: 2 })],
    order: direction === 'long'
      ? { direction: 'long', market: 'perp', leverage: 2 }
      : { direction: 'both', market: 'perp', leverage: 2, short_signal: [node('indicator_cross', { indicator: 'ema', args: { period: 20 }, compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: 50 }, direction: 'cross_below' })], short_regime: node('indicator_threshold', { indicator: 'rsi', args: { period: 14 }, operator: 'below', threshold: 55 }) },
  } as StrategyIR;
}
