// Mirror transform (docs/eval/README.md §2): p → 2·p₀ − p with p₀ = the as_of close. Highs and lows
// swap (the mirror of the high is the new low), volume is untouched, timestamps are untouched.

import type { Kline, MarketState, Ticker24h } from './types.js';
import { decimalsOf, fmtDec } from './util.js';

export function mirrorPrice(p: number, p0: number): number {
  return 2 * p0 - p;
}

export function mirrorPriceStr(s: string, p0: number, decimals = decimalsOf(s)): string {
  return fmtDec(mirrorPrice(Number(s), p0), decimals);
}

export function mirrorKline(k: Kline, p0: number): Kline {
  return {
    open_time: k.open_time,
    close_time: k.close_time,
    open: mirrorPriceStr(k.open, p0),
    high: mirrorPriceStr(k.low, p0),
    low: mirrorPriceStr(k.high, p0),
    close: mirrorPriceStr(k.close, p0),
    volume: k.volume,
  };
}

export function mirrorKlines(ks: Kline[], p0: number): Kline[] {
  return ks.map((k) => mirrorKline(k, p0));
}

export function mirrorTicker(t: Ticker24h, p0: number): Ticker24h {
  const pct = Number(t.priceChangePercent);
  return {
    priceChangePercent: fmtDec(-pct, decimalsOf(t.priceChangePercent)),
    highPrice: mirrorPriceStr(t.lowPrice, p0),
    lowPrice: mirrorPriceStr(t.highPrice, p0),
    quoteVolume: t.quoteVolume,
  };
}

export function mirrorMarketState(ms: MarketState, p0: number): MarketState {
  const flipRegime = (r: MarketState['regime']): MarketState['regime'] => (r === 'trend_up' ? 'trend_down' : r === 'trend_down' ? 'trend_up' : r);
  const flipBias = (b: MarketState['bias']): MarketState['bias'] => (b === 'long' ? 'short' : b === 'short' ? 'long' : b);
  return {
    ...ms,
    regime: flipRegime(ms.regime),
    bias: flipBias(ms.bias),
    summary: ms.summary.replace(/偏多/g, '⟂B').replace(/偏空/g, '偏多').replace(/⟂B/g, '偏空').replace(/上行/g, '⟂U').replace(/下行/g, '上行').replace(/⟂U/g, '下行'),
    majors: ms.majors.map((m) => ({
      ...m,
      last: mirrorPriceStr(m.last, p0),
      change_24h_pct: fmtDec(-Number(m.change_24h_pct), decimalsOf(m.change_24h_pct)),
    })),
    candidates: ms.candidates.map((c) => ({ ...c, direction: c.direction === 'long' ? 'short' : 'long' })),
  };
}

/** Smallest mirrored price across the given bars; ≤ 0 means the mirror would be nonsense. */
export function mirrorFloor(ks: Kline[], p0: number): number {
  let min = Number.POSITIVE_INFINITY;
  for (const k of ks) min = Math.min(min, mirrorPrice(Number(k.high), p0));
  return min;
}
