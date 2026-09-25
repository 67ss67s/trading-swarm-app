// 步骤 2 的实现:「从均值回归的历史里算出回归概率和期望时间」
// (docs/design/strategy-library-2026-09-05.md §4;Jacky 的 agent 交易流程第 2 步)。
//
// 纯函数,不做 I/O。给定最近 N 根 K 线,统计:价格偏离 EMA20 达到 k 个 ATR 之后,H 根内重新触及
// EMA20 的历史比例、以及回归所用根数的中位数与样本量。数字由代码算出来,所以它作为一条
// 「回归统计(代码计算)」证据进上下文,eval 的 hallucinated_numbers 会把它当作有来源的数。
//
// 诚实边界(写进证据文本里,模型看得到):
// - 样本高度重叠(同一段偏离会被连续多根重复计数),概率是先验不是独立试验的频率;
// - 只用收盘价与当根高低价判断「触及」,没有盘中 tick;
// - 只看本币本周期的这段历史,换 regime 不保证成立。

import type { Kline } from './types.js';

export interface ReversionCell {
  /** 偏离阈值,单位 ATR。 */
  k: number;
  /** 观察窗口,单位 K 线根数。 */
  horizon: number;
  /** 达到该偏离的样本数(重叠计数)。 */
  samples: number;
  /** 窗口内重新触及 EMA20 的比例;样本为 0 时 null。 */
  prob: number | null;
  /** 回归所用根数的中位数(只统计确实回归的样本);无回归样本时 null。 */
  median_bars: number | null;
}

export interface ReversionStats {
  tf: string;
  /** 实际参与统计的 K 线根数。 */
  bars: number;
  ema_period: number;
  atr_period: number;
  ks: number[];
  horizons: number[];
  cells: ReversionCell[];
  /** 渲染给模型的一行证据文本。 */
  text: string;
}

export const DEFAULT_KS = [1.5, 2, 2.5];
export const DEFAULT_HORIZONS = [6, 12, 24];
/** 少于这么多根就不给统计——样本太少的概率比没有概率更危险。 */
export const MIN_BARS = 400;

/** EMA 序列(与 market.ts 的 ema() 同一口径,但这里要整条序列)。 */
export function emaSeries(values: number[], period: number): number[] {
  const out: number[] = [];
  const k = 2 / (period + 1);
  let prev = 0;
  for (const [i, v] of values.entries()) {
    prev = i === 0 ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Wilder ATR 序列;第一根用 high-low 起步。 */
export function atrSeries(klines: Kline[], period: number): number[] {
  const out: number[] = [];
  let prev = 0;
  for (const [i, k] of klines.entries()) {
    const high = Number(k.high);
    const low = Number(k.low);
    const prevClose = i === 0 ? Number(k.open) : Number(klines[i - 1]!.close);
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    prev = i === 0 ? tr : (prev * (period - 1) + tr) / period;
    out.push(prev);
  }
  return out;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export interface ReversionOptions {
  tf?: string;
  ema_period?: number;
  atr_period?: number;
  ks?: number[];
  horizons?: number[];
  min_bars?: number;
}

/**
 * 偏离 → 回归的历史统计。
 *
 * 一个样本 = 第 i 根收盘时 |close − EMA20| ≥ k·ATR14。回归 = 之后第 j 根(i < j ≤ i+H)的
 * 高低区间夹住了那根自己的 EMA20(等价于价格重新触到均线),记 j−i 根。
 */
export function reversionStats(klines: Kline[], opts: ReversionOptions = {}): ReversionStats | null {
  const emaPeriod = opts.ema_period ?? 20;
  const atrPeriod = opts.atr_period ?? 14;
  const ks = opts.ks ?? DEFAULT_KS;
  const horizons = opts.horizons ?? DEFAULT_HORIZONS;
  const minBars = opts.min_bars ?? MIN_BARS;
  if (klines.length < minBars) return null;

  const closes = klines.map((k) => Number(k.close));
  const highs = klines.map((k) => Number(k.high));
  const lows = klines.map((k) => Number(k.low));
  const ema = emaSeries(closes, emaPeriod);
  const atr = atrSeries(klines, atrPeriod);
  const warm = Math.max(emaPeriod, atrPeriod) * 2;
  const maxH = Math.max(...horizons);

  const cells: ReversionCell[] = [];
  for (const k of ks) {
    for (const H of horizons) {
      let samples = 0;
      const barsToRevert: number[] = [];
      for (let i = warm; i < klines.length - H; i++) {
        const a = atr[i]!;
        if (!(a > 0)) continue;
        const dev = Math.abs(closes[i]! - ema[i]!) / a;
        if (dev < k) continue;
        samples++;
        for (let j = i + 1; j <= i + H; j++) {
          if (lows[j]! <= ema[j]! && ema[j]! <= highs[j]!) {
            barsToRevert.push(j - i);
            break;
          }
        }
      }
      cells.push({ k, horizon: H, samples, prob: samples ? barsToRevert.length / samples : null, median_bars: median(barsToRevert) });
    }
  }

  const tf = opts.tf ?? '';
  const used = klines.length - warm - maxH;
  const pct = (v: number | null): string => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);
  const parts = cells.map((c) => `≥${c.k.toFixed(1)}ATR/${c.horizon}根:回归 ${pct(c.prob)}(样本 ${c.samples}${c.median_bars === null ? '' : `,中位 ${c.median_bars.toFixed(0)} 根`})`);
  const text = [
    `基于最近 ${klines.length} 根${tf ? ` ${tf}` : ''}(有效样本区 ${Math.max(0, used)} 根),偏离 EMA${emaPeriod} 达到 k 个 ATR${atrPeriod} 后、H 根内重新触及 EMA${emaPeriod} 的历史比例`,
    ...parts,
    '样本重叠(同一段偏离会被连续多根重复计数),只作先验;没有盘中 tick,只用高低区间判断触及',
  ].join(';');

  return { tf, bars: klines.length, ema_period: emaPeriod, atr_period: atrPeriod, ks, horizons, cells, text };
}

/** 取某个 (k, H) 格子;找不到返回 null。 */
export function reversionCell(s: ReversionStats, k: number, horizon: number): ReversionCell | null {
  return s.cells.find((c) => c.k === k && c.horizon === horizon) ?? null;
}
