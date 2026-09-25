// Technical indicator library — ported from the 8794 console (trade-switch-rs) so the model sees the
// same numbers a discretionary trader would have on screen, instead of the four features
// (EMA20/50, ATR, 20-bar range, volume ratio) it had before. Full inventory + parity notes:
// docs/demo/indicators.md.
//
// Conventions (every export follows them, so callers never have to special-case):
//   * Input klines are ASCENDING (oldest first) — the same order fetchKlines / loadKlines return.
//   * Every series output is ALIGNED to the input: out.length === input.length.
//   * Warm-up is NaN (numeric series) or NaN fields (object series) — never 0, never a silently
//     shortened array. `last()` skips them.
//   * Pure: no I/O, no Date.now(), no mutation of the input. Everything here is replayable, which is
//     what lets a judgment be re-derived from the klines that were visible at the time.
//
// Deliberate divergence from market.ts: `market.ts#ema` seeds on the FIRST value (so it has no
// warm-up and its early values drift); this module seeds on the SMA of the first `period` values,
// which is the TA-Lib / TradingView convention 8794 uses. Over 200+ bars the two agree to ~1e-11.

import type { Kline } from './types.js';

// ---------------------------------------------------------------- helpers

const NA = Number.NaN;

/** Last "ready" entry of an aligned series (warm-up entries skipped), or null when nothing is ready. */
export function last<T>(series: readonly T[]): T | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i];
    if (v === null || v === undefined) continue;
    if (typeof v === 'number') {
      if (Number.isFinite(v)) return v;
      continue;
    }
    if (typeof v === 'object') {
      const nums = Object.values(v as Record<string, unknown>).filter((x) => typeof x === 'number') as number[];
      if (nums.length > 0 && nums.every((x) => Number.isFinite(x))) return v;
      continue;
    }
    return v;
  }
  return null;
}

const filled = (n: number): number[] => new Array<number>(n).fill(NA);

export const highs = (ks: readonly Kline[]): number[] => ks.map((k) => Number(k.high));
export const lows = (ks: readonly Kline[]): number[] => ks.map((k) => Number(k.low));
export const closes = (ks: readonly Kline[]): number[] => ks.map((k) => Number(k.close));
export const opens = (ks: readonly Kline[]): number[] => ks.map((k) => Number(k.open));
export const volumes = (ks: readonly Kline[]): number[] => ks.map((k) => Number(k.volume));
/** (H+L+C)/3 — the "typical price" CCI / MFI / VWAP are all built on. */
export const typicalPrices = (ks: readonly Kline[]): number[] => ks.map((k) => (Number(k.high) + Number(k.low) + Number(k.close)) / 3);

/** Decimals for printing a price of this magnitude (same rule review-metrics.ts / context.ts use). */
export function decimalsFor(price: number): number {
  return price > 100 ? 0 : price > 1 ? 2 : 5;
}

// ---------------------------------------------------------------- moving averages

/** Simple moving average. NaN until index `period - 1`. */
export function sma(values: readonly number[], period: number): number[] {
  const out = filled(values.length);
  if (period <= 0) return out;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) {
      // A hole resets the window rather than poisoning every later value.
      sum = 0;
      count = 0;
      continue;
    }
    sum += v;
    count++;
    if (count > period) {
      const drop = values[i - period]!;
      sum -= Number.isFinite(drop) ? drop : 0;
      count = period;
    }
    if (count === period) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average, seeded by the SMA of the first `period` values (TA-Lib convention). */
export function ema(values: readonly number[], period: number): number[] {
  const out = filled(values.length);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let prev: number | null = null;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    if (prev === null) {
      sum += v;
      count++;
      if (count === period) {
        prev = sum / period;
        out[i] = prev;
      }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Weighted moving average: weights 1..period, the newest bar carrying `period`. */
export function wma(values: readonly number[], period: number): number[] {
  const out = filled(values.length);
  if (period <= 0) return out;
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let acc = 0;
    let ok = true;
    for (let j = 0; j < period; j++) {
      const v = values[i - period + 1 + j]!;
      if (!Number.isFinite(v)) {
        ok = false;
        break;
      }
      acc += v * (j + 1);
    }
    if (ok) out[i] = acc / denom;
  }
  return out;
}

/** Double EMA: 2·EMA − EMA(EMA). Less lag than a plain EMA, more overshoot. */
export function dema(values: readonly number[], period: number): number[] {
  const e1 = ema(values, period);
  const e2 = ema(e1, period);
  return values.map((_, i) => (Number.isFinite(e1[i]!) && Number.isFinite(e2[i]!) ? 2 * e1[i]! - e2[i]! : NA));
}

/** Triple EMA: 3·EMA1 − 3·EMA2 + EMA3. */
export function tema(values: readonly number[], period: number): number[] {
  const e1 = ema(values, period);
  const e2 = ema(e1, period);
  const e3 = ema(e2, period);
  return values.map((_, i) => (Number.isFinite(e1[i]!) && Number.isFinite(e2[i]!) && Number.isFinite(e3[i]!) ? 3 * e1[i]! - 3 * e2[i]! + e3[i]! : NA));
}

/**
 * Wilder's smoothing (a.k.a. RMA / SMMA): the α = 1/period average RSI, ATR, ADX and DI are all
 * defined with. Emphatically NOT the same as `ema(values, period)` — Wilder's is EMA with
 * period 2·n−1, and using the wrong one is the single most common source of "my RSI differs by 3".
 */
export function rma(values: readonly number[], period: number): number[] {
  const out = filled(values.length);
  if (period <= 0) return out;
  let prev: number | null = null;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    if (prev === null) {
      sum += v;
      count++;
      if (count === period) {
        prev = sum / period;
        out[i] = prev;
      }
      continue;
    }
    prev = (prev * (period - 1) + v) / period;
    out[i] = prev;
  }
  return out;
}

/** Rolling standard deviation (population, matching Bollinger's definition). */
export function stdev(values: readonly number[], period: number): number[] {
  const out = filled(values.length);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j]!;
      if (!Number.isFinite(v)) {
        ok = false;
        break;
      }
      sum += v;
    }
    if (!ok) continue;
    const mean = sum / period;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += (values[j]! - mean) ** 2;
    out[i] = Math.sqrt(acc / period);
  }
  return out;
}

// ---------------------------------------------------------------- oscillators

/** Wilder RSI. 0–100; NaN for the first `period` bars. */
export function rsi(cl: readonly number[], period = 14): number[] {
  const n = cl.length;
  const gains = filled(n);
  const losses = filled(n);
  for (let i = 1; i < n; i++) {
    const d = cl[i]! - cl[i - 1]!;
    gains[i] = d > 0 ? d : 0;
    losses[i] = d < 0 ? -d : 0;
  }
  const avgGain = rma(gains, period);
  const avgLoss = rma(losses, period);
  const out = filled(n);
  for (let i = 0; i < n; i++) {
    const g = avgGain[i]!;
    const l = avgLoss[i]!;
    if (!Number.isFinite(g) || !Number.isFinite(l)) continue;
    out[i] = l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
  }
  return out;
}

export interface MacdPoint {
  macd: number;
  signal: number;
  hist: number;
}

/** MACD(12, 26, 9) on EMA (not Wilder). `hist = macd − signal`. */
export function macd(cl: readonly number[], fast = 12, slow = 26, signal = 9): MacdPoint[] {
  const ef = ema(cl, fast);
  const es = ema(cl, slow);
  const line = cl.map((_, i) => (Number.isFinite(ef[i]!) && Number.isFinite(es[i]!) ? ef[i]! - es[i]! : NA));
  const sig = ema(line, signal);
  return cl.map((_, i) => {
    const m = line[i]!;
    const s = sig[i]!;
    return { macd: m, signal: s, hist: Number.isFinite(m) && Number.isFinite(s) ? m - s : NA };
  });
}

export interface StochPoint {
  /** Raw (fast) %K over the lookback window. */
  fast_k: number;
  /** Slow %K = SMA(fast %K, `smooth`) — this is what 8794's `stoch_k` reports. */
  k: number;
  /** %D = SMA(slow %K, `d`) — 8794's `stoch_d`. */
  d: number;
}

/**
 * Slow stochastic, 8794 parity: fast %K over `k` bars → SMA(`smooth`) = slow %K → SMA(`d`) = %D.
 * A flat window (high === low) reports 50 rather than dividing by zero.
 */
export function stochastic(ks: readonly Kline[], k = 14, d = 3, smooth = 3): StochPoint[] {
  const hi = highs(ks);
  const lo = lows(ks);
  const cl = closes(ks);
  const fast = filled(ks.length);
  for (let i = k - 1; i < ks.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - k + 1; j <= i; j++) {
      if (hi[j]! > hh) hh = hi[j]!;
      if (lo[j]! < ll) ll = lo[j]!;
    }
    fast[i] = hh === ll ? 50 : ((cl[i]! - ll) / (hh - ll)) * 100;
  }
  const slowK = sma(fast, smooth);
  const dv = sma(slowK, d);
  return ks.map((_, i) => ({ fast_k: fast[i]!, k: slowK[i]!, d: dv[i]! }));
}

/** Stochastic RSI: min-max position of RSI inside its own trailing `period` window (ta-lib fastK of RSI), 0–100. */
export function stochRsi(cl: readonly number[], period = 14): number[] {
  const r = rsi(cl, period);
  const out = filled(cl.length);
  for (let i = 0; i < cl.length; i++) {
    if (!Number.isFinite(r[i]!)) continue;
    let hh = -Infinity;
    let ll = Infinity;
    let count = 0;
    for (let j = Math.max(0, i - period + 1); j <= i; j++) {
      const v = r[j]!;
      if (!Number.isFinite(v)) continue;
      count++;
      if (v > hh) hh = v;
      if (v < ll) ll = v;
    }
    if (count < period) continue;
    out[i] = hh === ll ? 50 : ((r[i]! - ll) / (hh - ll)) * 100;
  }
  return out;
}

/** Momentum: close[t] − close[t − period]. */
export function momentum(cl: readonly number[], period = 10): number[] {
  return cl.map((v, i) => (i >= period && Number.isFinite(v) && Number.isFinite(cl[i - period]!) ? v - cl[i - period]! : NA));
}

/** Rate of change, in percent. */
export function roc(cl: readonly number[], period = 10): number[] {
  return cl.map((v, i) => {
    const base = i >= period ? cl[i - period]! : NA;
    return Number.isFinite(base) && base !== 0 ? (v / base - 1) * 100 : NA;
  });
}

/** TRIX: 1-bar percent rate of change of a triple-smoothed EMA. */
export function trix(cl: readonly number[], period = 30): number[] {
  const e3 = ema(ema(ema(cl, period), period), period);
  return e3.map((v, i) => {
    const prev = i > 0 ? e3[i - 1]! : NA;
    return Number.isFinite(v) && Number.isFinite(prev) && prev !== 0 ? ((v - prev) / prev) * 100 : NA;
  });
}

/**
 * Chaikin Accumulation/Distribution line — cumulative `((C−L)−(H−C))/(H−L) · volume`. Like OBV it is
 * relative to the window handed in (8794 does the same), so only its slope is meaningful.
 */
export function chaikinAd(ks: readonly Kline[]): number[] {
  const out = new Array<number>(ks.length).fill(0);
  let acc = 0;
  for (let i = 0; i < ks.length; i++) {
    const h = Number(ks[i]!.high);
    const l = Number(ks[i]!.low);
    const c = Number(ks[i]!.close);
    const v = Number(ks[i]!.volume);
    if (h > l && Number.isFinite(v)) acc += (((c - l) - (h - c)) / (h - l)) * v;
    out[i] = acc;
  }
  return out;
}

export interface AroonPoint {
  up: number;
  down: number;
  /** up − down: > 0 = the recent high is fresher than the recent low. */
  osc: number;
}

/** Aroon(25): how recently the window's extreme printed, as a percentage of the window. */
export function aroon(ks: readonly Kline[], period = 25): AroonPoint[] {
  const hi = highs(ks);
  const lo = lows(ks);
  const out: AroonPoint[] = ks.map(() => ({ up: NA, down: NA, osc: NA }));
  for (let i = period; i < ks.length; i++) {
    let hiIdx = i - period;
    let loIdx = i - period;
    for (let j = i - period; j <= i; j++) {
      if (hi[j]! > hi[hiIdx]!) hiIdx = j;
      if (lo[j]! < lo[loIdx]!) loIdx = j;
    }
    const up = ((period - (i - hiIdx)) / period) * 100;
    const down = ((period - (i - loIdx)) / period) * 100;
    out[i] = { up, down, osc: up - down };
  }
  return out;
}

/** Commodity Channel Index on the typical price, Lambert's 0.015 constant, mean (not standard) deviation. */
export function cci(ks: readonly Kline[], period = 20): number[] {
  const tp = typicalPrices(ks);
  const base = sma(tp, period);
  const out = filled(ks.length);
  for (let i = period - 1; i < ks.length; i++) {
    const m = base[i]!;
    if (!Number.isFinite(m)) continue;
    let md = 0;
    for (let j = i - period + 1; j <= i; j++) md += Math.abs(tp[j]! - m);
    md /= period;
    out[i] = md === 0 ? 0 : (tp[i]! - m) / (0.015 * md);
  }
  return out;
}

/** Williams %R: −100 (at the window low) … 0 (at the window high). */
export function williamsR(ks: readonly Kline[], period = 14): number[] {
  const hi = highs(ks);
  const lo = lows(ks);
  const cl = closes(ks);
  const out = filled(ks.length);
  for (let i = period - 1; i < ks.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (hi[j]! > hh) hh = hi[j]!;
      if (lo[j]! < ll) ll = lo[j]!;
    }
    out[i] = hh === ll ? -50 : ((hh - cl[i]!) / (hh - ll)) * -100;
  }
  return out;
}

/** Money Flow Index — RSI on volume-weighted typical price. 0–100. */
export function mfi(ks: readonly Kline[], period = 14): number[] {
  const tp = typicalPrices(ks);
  const vol = volumes(ks);
  const out = filled(ks.length);
  for (let i = period; i < ks.length; i++) {
    let pos = 0;
    let neg = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const flow = tp[j]! * vol[j]!;
      if (tp[j]! > tp[j - 1]!) pos += flow;
      else if (tp[j]! < tp[j - 1]!) neg += flow;
    }
    out[i] = neg === 0 ? (pos === 0 ? 50 : 100) : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

/** On-Balance Volume — a running signed volume total (starts at 0 on the first bar, no warm-up). */
export function obv(ks: readonly Kline[]): number[] {
  const cl = closes(ks);
  const vol = volumes(ks);
  const out = new Array<number>(ks.length).fill(0);
  for (let i = 1; i < ks.length; i++) {
    const d = cl[i]! - cl[i - 1]!;
    out[i] = out[i - 1]! + (d > 0 ? vol[i]! : d < 0 ? -vol[i]! : 0);
  }
  return out;
}

// ---------------------------------------------------------------- volatility / range

/** True range per bar. TR[0] = high − low (no previous close to reach back to). */
export function trueRange(ks: readonly Kline[]): number[] {
  const out = filled(ks.length);
  for (let i = 0; i < ks.length; i++) {
    const h = Number(ks[i]!.high);
    const l = Number(ks[i]!.low);
    if (i === 0) {
      out[0] = h - l;
      continue;
    }
    const pc = Number(ks[i - 1]!.close);
    out[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return out;
}

/**
 * Wilder ATR as a SERIES (market.ts#atr returns the simple mean of the last `period` TRs as one
 * number; this is the smoothed version 8794 charts and both are documented in indicators.md).
 */
export function atr(ks: readonly Kline[], period = 14): number[] {
  return rma(trueRange(ks), period);
}

export interface BollingerPoint {
  mid: number;
  upper: number;
  lower: number;
  /** (upper − lower) / mid × 100 — the number the squeeze / percentile logic actually ranks. */
  width_pct: number;
}

export function bollinger(cl: readonly number[], period = 20, mult = 2): BollingerPoint[] {
  const mid = sma(cl, period);
  const sd = stdev(cl, period);
  return cl.map((_, i) => {
    const m = mid[i]!;
    const s = sd[i]!;
    if (!Number.isFinite(m) || !Number.isFinite(s)) return { mid: NA, upper: NA, lower: NA, width_pct: NA };
    const upper = m + mult * s;
    const lower = m - mult * s;
    return { mid: m, upper, lower, width_pct: m === 0 ? NA : ((upper - lower) / m) * 100 };
  });
}

export interface KeltnerPoint {
  mid: number;
  upper: number;
  lower: number;
}

/** Keltner Channel: EMA(close, period) ± mult × ATR(period). */
export function keltner(ks: readonly Kline[], period = 20, mult = 1.5): KeltnerPoint[] {
  const mid = ema(closes(ks), period);
  const a = atr(ks, period);
  return ks.map((_, i) => {
    const m = mid[i]!;
    const v = a[i]!;
    if (!Number.isFinite(m) || !Number.isFinite(v)) return { mid: NA, upper: NA, lower: NA };
    return { mid: m, upper: m + mult * v, lower: m - mult * v };
  });
}

export interface SqueezePoint {
  /** Bollinger band entirely inside the Keltner channel = volatility compressed. */
  on: boolean;
  /** How many consecutive bars (including this one) the squeeze has been on; 0 when off. */
  bars_on: number;
}

/** TTM-style squeeze: BB(20, 2) inside KC(20, 1.5). Warm-up bars report `{ on: false, bars_on: 0 }`. */
export function squeeze(ks: readonly Kline[], bbPeriod = 20, bbMult = 2, kcPeriod = 20, kcMult = 1.5): SqueezePoint[] {
  const bb = bollinger(closes(ks), bbPeriod, bbMult);
  const kc = keltner(ks, kcPeriod, kcMult);
  const out: SqueezePoint[] = [];
  let run = 0;
  for (let i = 0; i < ks.length; i++) {
    const b = bb[i]!;
    const k = kc[i]!;
    const ready = Number.isFinite(b.upper) && Number.isFinite(k.upper);
    const on = ready && b.upper < k.upper && b.lower > k.lower;
    run = on ? run + 1 : 0;
    out.push({ on, bars_on: run });
  }
  return out;
}

export interface DonchianPoint {
  upper: number;
  lower: number;
  mid: number;
}

/** Donchian channel over the last `period` bars INCLUDING the current one (highest high / lowest low). */
export function donchian(ks: readonly Kline[], period = 20): DonchianPoint[] {
  const hi = highs(ks);
  const lo = lows(ks);
  const out: DonchianPoint[] = ks.map(() => ({ upper: NA, lower: NA, mid: NA }));
  for (let i = period - 1; i < ks.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (hi[j]! > hh) hh = hi[j]!;
      if (lo[j]! < ll) ll = lo[j]!;
    }
    out[i] = { upper: hh, lower: ll, mid: (hh + ll) / 2 };
  }
  return out;
}

// ---------------------------------------------------------------- trend

export interface AdxPoint {
  adx: number;
  plus_di: number;
  minus_di: number;
}

/** Wilder ADX / +DI / −DI. ADX ≥ 20 is the "there is a trend" line the snapshot keys off. */
export function adx(ks: readonly Kline[], period = 14): AdxPoint[] {
  const n = ks.length;
  const hi = highs(ks);
  const lo = lows(ks);
  const tr = trueRange(ks);
  const plusDM = filled(n);
  const minusDM = filled(n);
  for (let i = 1; i < n; i++) {
    const up = hi[i]! - hi[i - 1]!;
    const down = lo[i - 1]! - lo[i]!;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  // TR[0] exists but +DM/−DM start at index 1; drop TR[0] so the three smoothings stay in phase.
  const trShift = tr.slice();
  trShift[0] = NA;
  const smTr = rma(trShift, period);
  const smPlus = rma(plusDM, period);
  const smMinus = rma(minusDM, period);
  const dx = filled(n);
  const pdi = filled(n);
  const mdi = filled(n);
  for (let i = 0; i < n; i++) {
    const t = smTr[i]!;
    if (!Number.isFinite(t) || t === 0) continue;
    const p = (smPlus[i]! / t) * 100;
    const m = (smMinus[i]! / t) * 100;
    pdi[i] = p;
    mdi[i] = m;
    dx[i] = p + m === 0 ? 0 : (Math.abs(p - m) / (p + m)) * 100;
  }
  const adxv = rma(dx, period);
  return ks.map((_, i) => ({ adx: adxv[i]!, plus_di: pdi[i]!, minus_di: mdi[i]! }));
}

export interface SupertrendPoint {
  value: number;
  /** 1 = uptrend (band under price), −1 = downtrend (band above price). */
  dir: 1 | -1;
}

/**
 * Supertrend: hl2 ± mult × ATR(period), with the trailing bands "ratcheted" so they only move in the
 * favourable direction while the trend holds. Direction flips when the close crosses the opposite band.
 */
export function supertrend(ks: readonly Kline[], period = 10, mult = 3): SupertrendPoint[] {
  const n = ks.length;
  const cl = closes(ks);
  const hi = highs(ks);
  const lo = lows(ks);
  const a = atr(ks, period);
  const fUp = filled(n);
  const fDn = filled(n);
  const out: SupertrendPoint[] = ks.map(() => ({ value: NA, dir: 1 as 1 | -1 }));
  let dir: 1 | -1 = 1;
  let started = false;
  for (let i = 0; i < n; i++) {
    const v = a[i]!;
    if (!Number.isFinite(v)) continue;
    const hl2 = (hi[i]! + lo[i]!) / 2;
    const bUp = hl2 + mult * v;
    const bDn = hl2 - mult * v;
    if (!started) {
      fUp[i] = bUp;
      fDn[i] = bDn;
      dir = cl[i]! >= hl2 ? 1 : -1;
      started = true;
    } else {
      const pUp = fUp[i - 1]!;
      const pDn = fDn[i - 1]!;
      fUp[i] = bUp < pUp || cl[i - 1]! > pUp ? bUp : pUp;
      fDn[i] = bDn > pDn || cl[i - 1]! < pDn ? bDn : pDn;
      dir = cl[i]! > fUp[i - 1]! ? 1 : cl[i]! < fDn[i - 1]! ? -1 : dir;
    }
    out[i] = { value: dir === 1 ? fDn[i]! : fUp[i]!, dir };
  }
  return out;
}

export interface PsarPoint {
  value: number;
  dir: 1 | -1;
}

/** Parabolic SAR (Wilder): AF starts at `step`, increments by `step` on each new extreme, capped at `max`. */
export function psar(ks: readonly Kline[], step = 0.02, max = 0.2): PsarPoint[] {
  const n = ks.length;
  const hi = highs(ks);
  const lo = lows(ks);
  const out: PsarPoint[] = ks.map(() => ({ value: NA, dir: 1 as 1 | -1 }));
  if (n < 2) return out;
  let dir: 1 | -1 = Number(ks[1]!.close) >= Number(ks[0]!.close) ? 1 : -1;
  let sar = dir === 1 ? lo[0]! : hi[0]!;
  let ep = dir === 1 ? hi[0]! : lo[0]!;
  let af = step;
  out[0] = { value: sar, dir };
  for (let i = 1; i < n; i++) {
    sar += af * (ep - sar);
    // The SAR may not penetrate the previous two bars' range.
    if (dir === 1) sar = Math.min(sar, lo[i - 1]!, i >= 2 ? lo[i - 2]! : lo[i - 1]!);
    else sar = Math.max(sar, hi[i - 1]!, i >= 2 ? hi[i - 2]! : hi[i - 1]!);
    if (dir === 1 && lo[i]! < sar) {
      dir = -1;
      sar = ep;
      ep = lo[i]!;
      af = step;
    } else if (dir === -1 && hi[i]! > sar) {
      dir = 1;
      sar = ep;
      ep = hi[i]!;
      af = step;
    } else if (dir === 1 && hi[i]! > ep) {
      ep = hi[i]!;
      af = Math.min(max, af + step);
    } else if (dir === -1 && lo[i]! < ep) {
      ep = lo[i]!;
      af = Math.min(max, af + step);
    }
    out[i] = { value: sar, dir };
  }
  return out;
}

export interface IchimokuPoint {
  tenkan: number;
  kijun: number;
  /** Senkou A/B as COMPUTED at this bar (they are plotted `displacement` bars into the future). */
  senkou_a: number;
  senkou_b: number;
  /** The cloud that actually applies AT this bar (i.e. computed `displacement` bars ago). */
  cloud_top: number;
  cloud_bottom: number;
  /** Close shifted back `displacement` bars — the lagging span, aligned to the bar it belongs to. */
  chikou: number;
}

/** Ichimoku Kinko Hyo (9 / 26 / 52, displacement 26). */
export function ichimoku(ks: readonly Kline[], conversion = 9, base = 26, spanB = 52, displacement = 26): IchimokuPoint[] {
  const hi = highs(ks);
  const lo = lows(ks);
  const cl = closes(ks);
  const midOf = (period: number, i: number): number => {
    if (i < period - 1) return NA;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (hi[j]! > hh) hh = hi[j]!;
      if (lo[j]! < ll) ll = lo[j]!;
    }
    return (hh + ll) / 2;
  };
  const tenkan = ks.map((_, i) => midOf(conversion, i));
  const kijun = ks.map((_, i) => midOf(base, i));
  const senkouA = ks.map((_, i) => (Number.isFinite(tenkan[i]!) && Number.isFinite(kijun[i]!) ? (tenkan[i]! + kijun[i]!) / 2 : NA));
  const senkouB = ks.map((_, i) => midOf(spanB, i));
  return ks.map((_, i) => {
    const src = i - displacement;
    const a = src >= 0 ? senkouA[src]! : NA;
    const b = src >= 0 ? senkouB[src]! : NA;
    const both = Number.isFinite(a) && Number.isFinite(b);
    return {
      tenkan: tenkan[i]!,
      kijun: kijun[i]!,
      senkou_a: senkouA[i]!,
      senkou_b: senkouB[i]!,
      cloud_top: both ? Math.max(a, b) : NA,
      cloud_bottom: both ? Math.min(a, b) : NA,
      chikou: i + displacement < cl.length ? cl[i + displacement]! : NA,
    };
  });
}

// ---------------------------------------------------------------- VWAP / volume structure

export type VwapAnchor = 'session' | 'day' | 'all';

/**
 * Volume-weighted average price on the typical price.
 *   'day'     — resets at each UTC midnight (the anchored VWAP a desk quotes).
 *   'session' — resets at each 8-hour funding session (00 / 08 / 16 UTC), which is how the perp
 *               market actually segments its day.
 *   'all'     — cumulative over the whole array (no reset).
 * Bars with zero cumulative volume stay NaN rather than reporting the price as its own VWAP.
 */
export function vwap(ks: readonly Kline[], anchor: VwapAnchor = 'day'): number[] {
  const tp = typicalPrices(ks);
  const vol = volumes(ks);
  const out = filled(ks.length);
  const bucket = (t: number): number => (anchor === 'all' ? 0 : anchor === 'day' ? Math.floor(t / 86_400_000) : Math.floor(t / 28_800_000));
  let cumPv = 0;
  let cumV = 0;
  let cur: number | null = null;
  for (let i = 0; i < ks.length; i++) {
    const b = bucket(ks[i]!.open_time);
    if (cur === null || b !== cur) {
      cur = b;
      cumPv = 0;
      cumV = 0;
    }
    const v = vol[i]!;
    if (Number.isFinite(v) && Number.isFinite(tp[i]!)) {
      cumPv += tp[i]! * v;
      cumV += v;
    }
    out[i] = cumV > 0 ? cumPv / cumV : NA;
  }
  return out;
}

export interface VolumeProfile {
  /** Point of control: the price bin that traded the most volume. */
  poc: number;
  /** Value-area high / low: the tightest band around the POC holding `valueAreaPct` of volume. */
  vah: number;
  val: number;
  bins: { price: number; volume: number }[];
}

/**
 * Bar-approximated volume profile over the last `lookback` bars: each bar's volume is spread evenly
 * across the bins its high–low range covers. Not tick data — good enough to say "the POC is 0.6 %
 * below price", which is what the model needs, and never claimed to be exchange footprint.
 */
export function volumeProfile(ks: readonly Kline[], bins = 24, lookback = 120, valueAreaPct = 0.7): VolumeProfile | null {
  const win = ks.slice(-Math.max(2, lookback));
  if (win.length < 2 || bins < 2) return null;
  const hi = Math.max(...win.map((k) => Number(k.high)));
  const lo = Math.min(...win.map((k) => Number(k.low)));
  if (!(hi > lo)) return null;
  const step = (hi - lo) / bins;
  const acc = new Array<number>(bins).fill(0);
  for (const k of win) {
    const kh = Number(k.high);
    const kl = Number(k.low);
    const v = Number(k.volume);
    if (!Number.isFinite(v) || v <= 0) continue;
    const from = Math.max(0, Math.min(bins - 1, Math.floor((kl - lo) / step)));
    const to = Math.max(0, Math.min(bins - 1, Math.floor((kh - lo) / step)));
    const share = v / (to - from + 1);
    for (let b = from; b <= to; b++) acc[b]! += share;
  }
  const total = acc.reduce((a, b) => a + b, 0);
  const priceOf = (b: number): number => lo + step * (b + 0.5);
  let pocIdx = 0;
  for (let b = 1; b < bins; b++) if (acc[b]! > acc[pocIdx]!) pocIdx = b;
  // Grow outward from the POC, always taking the fatter neighbour, until valueAreaPct is covered.
  let loIdx = pocIdx;
  let hiIdx = pocIdx;
  let covered = acc[pocIdx]!;
  while (covered < total * valueAreaPct && (loIdx > 0 || hiIdx < bins - 1)) {
    const below = loIdx > 0 ? acc[loIdx - 1]! : -1;
    const above = hiIdx < bins - 1 ? acc[hiIdx + 1]! : -1;
    if (above >= below) {
      hiIdx++;
      covered += Math.max(0, above);
    } else {
      loIdx--;
      covered += Math.max(0, below);
    }
  }
  return {
    poc: priceOf(pocIdx),
    vah: lo + step * (hiIdx + 1),
    val: lo + step * loIdx,
    bins: acc.map((v, b) => ({ price: priceOf(b), volume: v })),
  };
}

// ---------------------------------------------------------------- ranking / structure

/**
 * Percentile rank of each value inside its own trailing `window` (0–100): "today's ATR% is at the
 * 12th percentile of the last 90 bars" is what turns a raw ATR into a regime statement. NaN until at
 * least 5 comparable values exist.
 */
export function percentileRank(series: readonly number[], window: number): number[] {
  const out = filled(series.length);
  for (let i = 0; i < series.length; i++) {
    const cur = series[i]!;
    if (!Number.isFinite(cur)) continue;
    const from = Math.max(0, i - window + 1);
    let count = 0;
    let le = 0;
    for (let j = from; j <= i; j++) {
      const v = series[j]!;
      if (!Number.isFinite(v)) continue;
      count++;
      if (v <= cur) le++;
    }
    if (count < 5) continue;
    out[i] = (le / count) * 100;
  }
  return out;
}

export interface SwingPoints {
  /** [bar index, price] pairs, oldest first. */
  highs: [number, number][];
  lows: [number, number][];
}

/**
 * Fractal swing highs / lows: a bar whose high is the strict maximum of the `left` bars before and
 * `right` bars after it (mirrored for lows). Bars inside the last `right` window can still change, so
 * they are never reported — a swing point here is confirmed, not provisional.
 */
export function swingPoints(ks: readonly Kline[], left = 3, right = 3): SwingPoints {
  const hi = highs(ks);
  const lo = lows(ks);
  const out: SwingPoints = { highs: [], lows: [] };
  for (let i = left; i < ks.length - right; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (hi[j]! >= hi[i]!) isHigh = false;
      if (lo[j]! <= lo[i]!) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.highs.push([i, hi[i]!]);
    if (isLow) out.lows.push([i, lo[i]!]);
  }
  return out;
}

// ---------------------------------------------------------------- snapshot

export type Trend = 'up' | 'down' | 'flat';
export type TrendStrength = 'none' | 'weak' | 'moderate' | 'strong';

export interface IndicatorSnapshot {
  tf: string;
  bars: number;
  last_open_time: number;
  last_close: number;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  /** 09-12 P1-11:SMA 也进快照 —— 证据集允许点名 sma20/50/200,以前渲染永远返回 null(等于「装不上」)。 */
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  rsi14: number | null;
  macd: MacdPoint | null;
  bb: BollingerPoint | null;
  /** Wilder ATR(14) — the smoothed series' last value. */
  atr14: number | null;
  atr_pct: number | null;
  /** Where ATR% sits within the last 90 bars of ATR% (0–100). */
  atr_pct_rank_90: number | null;
  /** Where the Bollinger width sits within the last 90 bars of widths (0–100). */
  bb_width_rank_90: number | null;
  adx14: AdxPoint | null;
  vwap_day: number | null;
  vwap_session: number | null;
  /** Signed distance from the close to VWAP(day), in ATR units (+ = price above VWAP). */
  dist_to_vwap_atr: number | null;
  donchian20: DonchianPoint | null;
  keltner20: KeltnerPoint | null;
  squeeze: SqueezePoint | null;
  stoch: StochPoint | null;
  stoch_rsi14: number | null;
  cci20: number | null;
  williams_r14: number | null;
  mfi14: number | null;
  /** ATR as a percentage of the last close — 8794's `natr`, kept as its own field for parity. */
  natr14: number | null;
  mom10: number | null;
  roc10: number | null;
  trix30: number | null;
  aroon25: AroonPoint | null;
  wma20: number | null;
  dema20: number | null;
  tema20: number | null;
  stddev20: number | null;
  /** Chaikin A/D line (window-relative, like OBV). */
  ad: number | null;
  obv: number | null;
  /** OBV change over the last 10 bars as a fraction of the mean |OBV step| — a sign-and-size read. */
  obv_slope_10: number | null;
  supertrend: SupertrendPoint | null;
  psar: PsarPoint | null;
  ichimoku: IchimokuPoint | null;
  /** 'above' / 'in' / 'below' the Ichimoku cloud that applies at this bar. */
  price_vs_cloud: 'above' | 'in' | 'below' | null;
  volume_profile: { poc: number; vah: number; val: number; dist_to_poc_pct: number } | null;
  /** Confirmed fractal swings, most recent last, at most 5 each. */
  swing_highs: [number, number][];
  swing_lows: [number, number][];
  /** EMA20 vs EMA50 with ADX ≥ 20 as the "is there actually a trend" gate. */
  trend: Trend;
  trend_strength: TrendStrength;
}

const fin = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** ADX → a word. Wilder's own bands: < 20 none, 20–25 weak, 25–40 moderate, ≥ 40 strong. */
export function trendStrengthOf(adxValue: number | null): TrendStrength {
  if (adxValue === null) return 'none';
  if (adxValue >= 40) return 'strong';
  if (adxValue >= 25) return 'moderate';
  if (adxValue >= 20) return 'weak';
  return 'none';
}

/** Last value of everything above, in one object. ~O(bars) — safe to call per bar in a backtest. */
export function indicatorSnapshot(ks: readonly Kline[], tf: string): IndicatorSnapshot | null {
  if (ks.length === 0) return null;
  const lastK = ks[ks.length - 1]!;
  const lastClose = Number(lastK.close);
  const cl = closes(ks);
  const atrSeries = atr(ks, 14);
  const atrPctSeries = atrSeries.map((v, i) => (Number.isFinite(v) && cl[i]! > 0 ? (v / cl[i]!) * 100 : NA));
  const bbSeries = bollinger(cl, 20, 2);
  const widthSeries = bbSeries.map((b) => b.width_pct);
  const adxSeries = adx(ks, 14);
  const vwapDay = vwap(ks, 'day');
  const vwapSession = vwap(ks, 'session');
  const st = supertrend(ks, 10, 3);
  const ichi = ichimoku(ks);
  const obvSeries = obv(ks);
  const swings = swingPoints(ks, 3, 3);

  const atrLast = fin(last(atrSeries));
  const atrPct = fin(last(atrPctSeries));
  const bbLast = last(bbSeries);
  const adxLast = last(adxSeries);
  const e20 = fin(last(ema(cl, 20)));
  const e50 = fin(last(ema(cl, 50)));
  const vwapDayLast = fin(last(vwapDay));
  // NOT last(ichi): chikou is NaN for the trailing `displacement` bars by construction, so a
  // readiness check over every field would silently hand back a 26-bar-stale point.
  const ichiRaw = ichi.at(-1) ?? null;
  const ichiLast = ichiRaw && Number.isFinite(ichiRaw.tenkan) && Number.isFinite(ichiRaw.kijun) ? ichiRaw : null;
  const vp = volumeProfile(ks, 24, 120);

  const distVwapAtr = vwapDayLast !== null && atrLast !== null && atrLast > 0 ? (lastClose - vwapDayLast) / atrLast : null;
  const cloudTop = ichiLast && Number.isFinite(ichiLast.cloud_top) ? ichiLast.cloud_top : null;
  const cloudBottom = ichiLast && Number.isFinite(ichiLast.cloud_bottom) ? ichiLast.cloud_bottom : null;
  const priceVsCloud = cloudTop === null || cloudBottom === null ? null : lastClose > cloudTop ? 'above' : lastClose < cloudBottom ? 'below' : 'in';

  // OBV slope: net change over 10 bars scaled by the average absolute step, so it is comparable
  // across symbols (raw OBV units are meaningless on their own).
  let obvSlope: number | null = null;
  if (obvSeries.length >= 11) {
    const tail = obvSeries.slice(-11);
    let absStep = 0;
    for (let i = 1; i < tail.length; i++) absStep += Math.abs(tail[i]! - tail[i - 1]!);
    const mean = absStep / (tail.length - 1);
    obvSlope = mean > 0 ? (tail[tail.length - 1]! - tail[0]!) / (mean * (tail.length - 1)) : 0;
  }

  const adxValue = adxLast ? fin(adxLast.adx) : null;
  const strength = trendStrengthOf(adxValue);
  const trend: Trend = e20 === null || e50 === null || adxValue === null || adxValue < 20 ? 'flat' : e20 > e50 ? 'up' : e20 < e50 ? 'down' : 'flat';

  return {
    tf,
    bars: ks.length,
    last_open_time: lastK.open_time,
    last_close: lastClose,
    ema20: e20,
    ema50: e50,
    ema200: fin(last(ema(cl, 200))),
    sma20: fin(last(sma(cl, 20))),
    sma50: fin(last(sma(cl, 50))),
    sma200: fin(last(sma(cl, 200))),
    rsi14: fin(last(rsi(cl, 14))),
    macd: last(macd(cl)),
    bb: bbLast,
    atr14: atrLast,
    atr_pct: atrPct,
    atr_pct_rank_90: fin(last(percentileRank(atrPctSeries, 90))),
    bb_width_rank_90: fin(last(percentileRank(widthSeries, 90))),
    adx14: adxLast,
    vwap_day: vwapDayLast,
    vwap_session: fin(last(vwapSession)),
    dist_to_vwap_atr: distVwapAtr,
    donchian20: last(donchian(ks, 20)),
    keltner20: last(keltner(ks, 20, 1.5)),
    squeeze: ks.length >= 20 ? (squeeze(ks).at(-1) ?? null) : null,
    stoch: last(stochastic(ks, 14, 3)),
    stoch_rsi14: fin(last(stochRsi(cl, 14))),
    cci20: fin(last(cci(ks, 20))),
    williams_r14: fin(last(williamsR(ks, 14))),
    mfi14: fin(last(mfi(ks, 14))),
    natr14: atrPct,
    mom10: fin(last(momentum(cl, 10))),
    roc10: fin(last(roc(cl, 10))),
    trix30: fin(last(trix(cl, 30))),
    aroon25: last(aroon(ks, 25)),
    wma20: fin(last(wma(cl, 20))),
    dema20: fin(last(dema(cl, 20))),
    tema20: fin(last(tema(cl, 20))),
    stddev20: fin(last(stdev(cl, 20))),
    ad: fin(chaikinAd(ks).at(-1)),
    obv: fin(obvSeries.at(-1)),
    obv_slope_10: obvSlope,
    supertrend: last(st),
    psar: last(psar(ks)),
    ichimoku: ichiLast,
    price_vs_cloud: priceVsCloud,
    volume_profile: vp ? { poc: vp.poc, vah: vp.vah, val: vp.val, dist_to_poc_pct: lastClose > 0 ? ((lastClose - vp.poc) / lastClose) * 100 : 0 } : null,
    swing_highs: swings.highs.slice(-5),
    swing_lows: swings.lows.slice(-5),
    trend,
    trend_strength: strength,
  };
}

// ---------------------------------------------------------------- 自定义参数(09-12 P1-11)

/**
 * 指标库 id → 它的**主窗口**默认值。策略在 `evidence.indicators[].params` 里点名
 * `{period: 7}` 时按这个窗口重算(以前 params 只进了去重键与标签,算的还是默认的 RSI14 ——
 * 「RSI7 / RSI21」在证据里只是两个不同的名字,数字一模一样)。
 * 没有主窗口概念(vwap/obv/ad/ichimoku/squeeze)的不在表里。
 */
export const INDICATOR_DEFAULT_PERIOD: Record<string, number> = {
  ema20: 20, ema50: 50, ema200: 200,
  sma20: 20, sma50: 50, sma200: 200,
  wma20: 20, dema20: 20, tema20: 20,
  rsi: 14, stochrsi: 14, stoch: 14, adx: 14, atr: 14, natr: 14, mfi: 14, willr: 14,
  cci: 20, stddev: 20, bb: 20, keltner: 20, donchian: 20,
  mom: 10, roc: 10, trix: 30, aroon: 25, macd: 26, supertrend: 10, psar: 0,
};

/** params 里的窗口(认 `period/length/window/n`);没写就用默认窗口,没有默认窗口返回 null。 */
export function periodOf(id: string, params?: Record<string, number> | undefined): number | null {
  const explicit = params ? ['period', 'length', 'window', 'n'].map((k) => params[k]).find((v) => typeof v === 'number' && Number.isFinite(v) && v > 0) : undefined;
  if (typeof explicit === 'number') return Math.round(explicit);
  const d = INDICATOR_DEFAULT_PERIOD[id];
  return d === undefined ? null : d;
}

/** 这个指标算得出来至少要几根 K 线(窗口 + 预热)。 */
export function minBarsForIndicator(id: string, params?: Record<string, number>): number {
  const p = periodOf(id, params);
  return Math.max(30, p === null ? 30 : p + 10);
}

/**
 * 按自定义参数重算快照里**这一个**指标,返回一份改写过对应字段的快照。
 *
 * - 没给参数、或参数就是默认窗口 → 原样返回 `base`(不重算,省 CPU);
 * - 给了参数但这个指标还不支持自定义窗口 → 返回 `null`,调用方按「装不上」处理(fail closed,
 *   绝不把默认窗口的数字贴上自定义标签发给模型)。
 */
export function indicatorWithParams(id: string, ks: readonly Kline[], base: IndicatorSnapshot, params?: Record<string, number>): IndicatorSnapshot | null {
  const custom = params && Object.keys(params).length ? params : null;
  if (!custom) return base;
  const p = periodOf(id, custom);
  const mult = typeof custom['mult'] === 'number' && Number.isFinite(custom['mult']) ? custom['mult'] : null;
  const cl = closes(ks);
  const f = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const def = INDICATOR_DEFAULT_PERIOD[id];
  if (p === null) return null; // 没有窗口概念的指标不接受自定义参数
  if (p === def && mult === null) return base;
  switch (id) {
    case 'ema20': return { ...base, ema20: f(last(ema(cl, p))) };
    case 'ema50': return { ...base, ema50: f(last(ema(cl, p))) };
    case 'ema200': return { ...base, ema200: f(last(ema(cl, p))) };
    case 'sma20': return { ...base, sma20: f(last(sma(cl, p))) };
    case 'sma50': return { ...base, sma50: f(last(sma(cl, p))) };
    case 'sma200': return { ...base, sma200: f(last(sma(cl, p))) };
    case 'wma20': return { ...base, wma20: f(last(wma(cl, p))) };
    case 'dema20': return { ...base, dema20: f(last(dema(cl, p))) };
    case 'tema20': return { ...base, tema20: f(last(tema(cl, p))) };
    case 'rsi': return { ...base, rsi14: f(last(rsi(cl, p))) };
    case 'stochrsi': return { ...base, stoch_rsi14: f(last(stochRsi(cl, p))) };
    case 'stoch': return { ...base, stoch: last(stochastic(ks, p, Math.round(custom['d'] ?? 3))) };
    case 'adx': return { ...base, adx14: last(adx(ks, p)) };
    case 'cci': return { ...base, cci20: f(last(cci(ks, p))) };
    case 'mfi': return { ...base, mfi14: f(last(mfi(ks, p))) };
    case 'willr': return { ...base, williams_r14: f(last(williamsR(ks, p))) };
    case 'mom': return { ...base, mom10: f(last(momentum(cl, p))) };
    case 'roc': return { ...base, roc10: f(last(roc(cl, p))) };
    case 'trix': return { ...base, trix30: f(last(trix(cl, p))) };
    case 'stddev': return { ...base, stddev20: f(last(stdev(cl, p))) };
    case 'aroon': return { ...base, aroon25: last(aroon(ks, p)) };
    case 'donchian': return { ...base, donchian20: last(donchian(ks, p)) };
    case 'bb': return { ...base, bb: last(bollinger(cl, p, mult ?? 2)), bb_width_rank_90: null };
    case 'keltner': return { ...base, keltner20: last(keltner(ks, p, mult ?? 1.5)) };
    case 'supertrend': return { ...base, supertrend: last(supertrend(ks, p, mult ?? 3)) };
    case 'macd': {
      const fast = Math.round(custom['fast'] ?? 12);
      const slow = Math.round(custom['slow'] ?? (p === def ? 26 : p));
      return { ...base, macd: last(macd(cl, fast, slow, Math.round(custom['signal'] ?? 9))) };
    }
    case 'atr': {
      const a = f(last(atr(ks, p)));
      return { ...base, atr14: a, atr_pct: a !== null && base.last_close > 0 ? (a / base.last_close) * 100 : null, atr_pct_rank_90: null };
    }
    case 'natr': {
      const a = f(last(atr(ks, p)));
      return { ...base, natr14: a !== null && base.last_close > 0 ? (a / base.last_close) * 100 : null };
    }
    default: return null;
  }
}

const TREND_LABEL: Record<Trend, string> = { up: '上升', down: '下降', flat: '无趋势' };
const STRENGTH_LABEL: Record<TrendStrength, string> = { none: '无', weak: '弱', moderate: '中', strong: '强' };

/**
 * One compact Chinese line for the evidence registry (≤ 220 chars). Only indicators that are actually
 * ready are printed — a warm-up NaN is dropped, never rendered as 0, because every number in here is
 * quotable by the model (system rule 2b).
 */
export function describeIndicators(s: IndicatorSnapshot | null): string {
  if (!s) return '指标:数据不足';
  const d = decimalsFor(s.last_close);
  const p = (v: number | null, dec = d): string => (v === null ? 'n/a' : v.toFixed(dec));
  const parts: string[] = [];
  parts.push(`趋势 ${TREND_LABEL[s.trend]}(ADX ${p(s.adx14 ? fin(s.adx14.adx) : null, 1)}/${STRENGTH_LABEL[s.trend_strength]})`);
  parts.push(`RSI14 ${p(s.rsi14, 1)}`);
  if (s.macd) parts.push(`MACD柱 ${p(fin(s.macd.hist), d + 1)}`);
  if (s.bb) parts.push(`BB ${p(fin(s.bb.lower))}~${p(fin(s.bb.upper))}(宽 ${p(fin(s.bb.width_pct), 2)}%${s.bb_width_rank_90 === null ? '' : `,${Math.round(s.bb_width_rank_90)}分位`})`);
  parts.push(`ATR ${p(s.atr_pct, 2)}%${s.atr_pct_rank_90 === null ? '' : `(${Math.round(s.atr_pct_rank_90)}分位)`}`);
  if (s.squeeze) parts.push(`挤压${s.squeeze.on ? `中(${s.squeeze.bars_on}根)` : '否'}`);
  if (s.vwap_day !== null) parts.push(`VWAP ${p(s.vwap_day)}(距 ${s.dist_to_vwap_atr === null ? 'n/a' : `${s.dist_to_vwap_atr >= 0 ? '+' : ''}${s.dist_to_vwap_atr.toFixed(2)}`}ATR)`);
  if (s.supertrend && Number.isFinite(s.supertrend.value)) parts.push(`超级趋势 ${s.supertrend.dir === 1 ? '多' : '空'} ${p(s.supertrend.value)}`);
  if (s.donchian20 && Number.isFinite(s.donchian20.upper)) parts.push(`唐奇安 ${p(fin(s.donchian20.lower))}~${p(fin(s.donchian20.upper))}`);
  if (s.stoch && Number.isFinite(s.stoch.k)) parts.push(`KD ${p(fin(s.stoch.k), 0)}/${p(fin(s.stoch.d), 0)}`);
  const line = `${s.tf}:${parts.join(';')}`;
  return line.length <= 220 ? line : `${line.slice(0, 219)}…`;
}
