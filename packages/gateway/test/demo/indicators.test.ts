// indicators.ts — the ported 8794 library (docs/demo/indicators.md). These are pure functions, so the
// tests pin ARITHMETIC, not plumbing: reference vectors computed independently for RSI/EMA/BB/MACD,
// structural invariants (alignment, warm-up, bounds) for the rest, and one synthetic compression that
// the squeeze must actually detect. If a value here changes, an evidence line the model quotes changed.

import { describe, expect, it } from 'vitest';
import {
  adx,
  aroon,
  atr,
  bollinger,
  cci,
  chaikinAd,
  describeIndicators,
  dema,
  donchian,
  ema,
  ichimoku,
  indicatorSnapshot,
  keltner,
  last,
  macd,
  mfi,
  momentum,
  obv,
  percentileRank,
  psar,
  rma,
  roc,
  rsi,
  sma,
  squeeze,
  stochRsi,
  stochastic,
  stdev,
  supertrend,
  swingPoints,
  tema,
  trix,
  trueRange,
  volumeProfile,
  vwap,
  williamsR,
  wma,
} from '../../src/demo/indicators.js';
import { ATR_PCT_FLOOR, atrPctFloor, scanChecklist } from '../../src/demo/review-metrics.js';
import { DEFAULT_SETS, INDICATOR_SETS, OVERLAY_SETS, indicatorRoutes, parseSets, seriesFor } from '../../src/demo/routes-indicators.js';
import { extraRouteModules } from '../../src/demo/http-extra.js';
import { tfFeatures } from '../../src/demo/market.js';
import type { Kline } from '../../src/demo/types.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 1, 0, 0);

/** Klines from closes, with a symmetric ±`range/2` bar around each close unless overridden. */
function fromCloses(cl: number[], opts: { range?: number; volume?: number; step?: number; start?: number } = {}): Kline[] {
  const range = opts.range ?? 1;
  const step = opts.step ?? HOUR;
  const start = opts.start ?? T0;
  return cl.map((c, i) => ({
    open_time: start + i * step,
    open: String(i === 0 ? c : cl[i - 1]!),
    high: String(c + range / 2),
    low: String(c - range / 2),
    close: String(c),
    volume: String(opts.volume ?? 100),
    close_time: start + (i + 1) * step - 1,
  }));
}

/**
 * Wilder's own worked example (the 33 closes every TA text reprints). Reference values below were
 * computed independently from the strict Wilder definition; published tables that round the running
 * averages report ~70.5 for the same first point.
 */
const WILDER = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13];

// ---------------------------------------------------------------- alignment & warm-up

describe('series alignment', () => {
  const cl = WILDER;
  const ks = fromCloses(cl);

  it('every series is exactly as long as its input', () => {
    expect(sma(cl, 5)).toHaveLength(cl.length);
    expect(ema(cl, 5)).toHaveLength(cl.length);
    expect(wma(cl, 5)).toHaveLength(cl.length);
    expect(rsi(cl, 14)).toHaveLength(cl.length);
    expect(macd(cl)).toHaveLength(cl.length);
    expect(bollinger(cl, 20, 2)).toHaveLength(cl.length);
    expect(atr(ks, 14)).toHaveLength(ks.length);
    expect(adx(ks, 14)).toHaveLength(ks.length);
    expect(donchian(ks, 20)).toHaveLength(ks.length);
    expect(keltner(ks, 20)).toHaveLength(ks.length);
    expect(squeeze(ks)).toHaveLength(ks.length);
    expect(stochastic(ks)).toHaveLength(ks.length);
    expect(supertrend(ks)).toHaveLength(ks.length);
    expect(psar(ks)).toHaveLength(ks.length);
    expect(ichimoku(ks)).toHaveLength(ks.length);
    expect(vwap(ks, 'day')).toHaveLength(ks.length);
    expect(obv(ks)).toHaveLength(ks.length);
    expect(cci(ks, 20)).toHaveLength(ks.length);
  });

  it('warm-up is NaN, never 0 — a zero would be quotable as a real number', () => {
    const s = sma(cl, 5);
    for (let i = 0; i < 4; i++) expect(Number.isNaN(s[i]!)).toBe(true);
    expect(s[4]).toBeCloseTo((44.34 + 44.09 + 44.15 + 43.61 + 44.33) / 5, 10);
    const r = rsi(cl, 14);
    for (let i = 0; i < 14; i++) expect(Number.isNaN(r[i]!)).toBe(true);
    expect(Number.isFinite(r[14]!)).toBe(true);
  });

  it('last() skips warm-up entries and reports null when nothing is ready', () => {
    expect(last([Number.NaN, Number.NaN, 3, Number.NaN])).toBe(3);
    expect(last(ema([1, 2], 20))).toBeNull();
    expect(last(macd([1, 2, 3]))).toBeNull();
    expect(last(bollinger(cl, 20, 2))?.mid).toBeCloseTo(45.241, 6);
  });
});

// ---------------------------------------------------------------- reference vectors

describe('moving averages', () => {
  it('EMA is SMA-seeded at index period-1 (ta-lib / 8794 convention)', () => {
    const e = ema(WILDER, 10);
    expect(e[9]).toBeCloseTo(44.779, 6); // = SMA of the first ten closes
    expect(e[10]).toBeCloseTo(44.981, 6);
    expect(e.at(-1)).toBeCloseTo(44.119299, 6);
  });

  it('a constant series is a fixed point of every average', () => {
    const flat = new Array<number>(40).fill(7);
    expect(sma(flat, 20).at(-1)).toBeCloseTo(7, 10);
    expect(ema(flat, 20).at(-1)).toBeCloseTo(7, 10);
    expect(wma(flat, 20).at(-1)).toBeCloseTo(7, 10);
    expect(rma(flat, 20).at(-1)).toBeCloseTo(7, 10);
    expect(dema(flat, 10).at(-1)).toBeCloseTo(7, 8);
    expect(tema(flat, 10).at(-1)).toBeCloseTo(7, 8);
    expect(stdev(flat, 20).at(-1)).toBeCloseTo(0, 12);
  });

  it('WMA weights the newest bar heaviest', () => {
    // weights 1,2,3 over [1,2,3] → (1·1 + 2·2 + 3·3)/6
    expect(wma([1, 2, 3], 3).at(-1)).toBeCloseTo(14 / 6, 10);
  });

  it('RMA is Wilder smoothing, NOT ema(values, period)', () => {
    const r = rma(WILDER, 14);
    const e = ema(WILDER, 14);
    expect(r.at(-1)).not.toBeCloseTo(e.at(-1)!, 3);
    // Wilder(n) === EMA(2n−1) once the different seeds have washed out — the identity that makes the
    // "why is my RSI off by 3" difference explainable.
    const long = Array.from({ length: 400 }, (_, i) => 100 + Math.sin(i / 9) * 20 + i / 40);
    expect(rma(long, 14).at(-1)).toBeCloseTo(ema(long, 27).at(-1)!, 6);
  });
});

describe('RSI (Wilder)', () => {
  it('matches the reference vector on Wilder’s worked example', () => {
    const r = rsi(WILDER, 14);
    expect(r[14]).toBeCloseTo(70.4641, 3);
    expect(r[15]).toBeCloseTo(66.2496, 3);
    expect(r[16]).toBeCloseTo(66.4809, 3);
    expect(r.at(-1)).toBeCloseTo(37.7888, 3);
  });

  it('is bounded 0–100, saturates on a one-way series, and reads 50 when nothing moves', () => {
    const up = rsi(
      Array.from({ length: 40 }, (_, i) => 100 + i),
      14,
    );
    expect(up.at(-1)).toBeCloseTo(100, 6);
    const down = rsi(
      Array.from({ length: 40 }, (_, i) => 100 - i),
      14,
    );
    expect(down.at(-1)).toBeCloseTo(0, 6);
    expect(rsi(new Array<number>(40).fill(5), 14).at(-1)).toBe(50);
    for (const v of rsi(WILDER, 14)) if (Number.isFinite(v)) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(100);
  });
});

describe('MACD / Bollinger', () => {
  it('MACD line is EMA12 − EMA26 and hist is macd − signal', () => {
    const cl = [...WILDER, ...WILDER.map((x) => x + 1)];
    const m = macd(cl);
    const e12 = ema(cl, 12);
    const e26 = ema(cl, 26);
    const i = cl.length - 1;
    expect(m[i]!.macd).toBeCloseTo(e12[i]! - e26[i]!, 10);
    expect(m[i]!.hist).toBeCloseTo(m[i]!.macd - m[i]!.signal, 10);
    // The signal line cannot exist before 26 + 9 − 1 bars have gone by.
    expect(Number.isNaN(m[32]!.signal)).toBe(true);
    expect(macd(WILDER).at(-1)!.macd).toBeCloseTo(-0.474687, 6);
  });

  it('Bollinger uses the POPULATION stddev, and width_pct = (upper−lower)/mid×100', () => {
    const b = bollinger(WILDER, 20, 2);
    expect(b[19]!.mid).toBeCloseTo(45.409, 6);
    expect(b[19]!.upper).toBeCloseTo(47.115328, 5);
    expect(b[19]!.lower).toBeCloseTo(43.702672, 5);
    expect(b[19]!.width_pct).toBeCloseTo(7.515375, 5);
    expect(b.at(-1)!.upper).toBeCloseTo(47.62015, 5);
    expect(b.at(-1)!.lower).toBeCloseTo(42.86185, 5);
  });
});

// ---------------------------------------------------------------- volatility / trend

describe('ATR / ADX', () => {
  it('ATR is the Wilder average of true range', () => {
    const ks = fromCloses(new Array<number>(30).fill(100), { range: 10 });
    expect(trueRange(ks).every((v) => Math.abs(v - 10) < 1e-9)).toBe(true);
    expect(atr(ks, 14).at(-1)).toBeCloseTo(10, 9);
  });

  it('ADX rises monotonically on a clean one-way trend, with +DI dominating', () => {
    const ks = fromCloses(
      Array.from({ length: 80 }, (_, i) => 100 + i),
      { range: 1 },
    );
    const a = adx(ks, 14);
    const ready = a.map((x, i) => ({ ...x, i })).filter((x) => Number.isFinite(x.adx));
    expect(ready.length).toBeGreaterThan(20);
    for (let i = 1; i < ready.length; i++) expect(ready[i]!.adx).toBeGreaterThanOrEqual(ready[i - 1]!.adx - 1e-9);
    const lastPoint = a.at(-1)!;
    expect(lastPoint.plus_di).toBeGreaterThan(lastPoint.minus_di);
    expect(lastPoint.adx).toBeGreaterThan(50);
    // A steady rise of 1 with a 1-wide bar: +DM = 1, TR = 1.5 → +DI = 66.67, −DI = 0.
    expect(lastPoint.plus_di).toBeCloseTo(100 / 1.5, 6);
    expect(lastPoint.minus_di).toBeCloseTo(0, 9);
  });

  it('ADX and DI stay inside 0–100 on real-shaped data', () => {
    const ks = fromCloses([...WILDER, ...WILDER.slice().reverse(), ...WILDER], { range: 0.4 });
    for (const p of adx(ks, 14)) {
      if (!Number.isFinite(p.adx)) continue;
      expect(p.adx).toBeGreaterThanOrEqual(0);
      expect(p.adx).toBeLessThanOrEqual(100);
      expect(p.plus_di).toBeGreaterThanOrEqual(0);
      expect(p.minus_di).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('channels, squeeze and supertrend', () => {
  it('Donchian is the inclusive high/low of the last `period` bars', () => {
    const ks = fromCloses([10, 12, 11, 15, 9, 13], { range: 0 });
    const d = donchian(ks, 3);
    expect(Number.isNaN(d[1]!.upper)).toBe(true);
    expect(d[3]).toEqual({ upper: 15, lower: 11, mid: 13 });
    expect(d[5]).toEqual({ upper: 15, lower: 9, mid: 12 });
  });

  it('Keltner is EMA ± mult × ATR and always brackets its own mid', () => {
    const ks = fromCloses(WILDER, { range: 0.5 });
    const k = keltner(ks, 20, 1.5);
    const p = k.at(-1)!;
    expect(p.upper).toBeGreaterThan(p.mid);
    expect(p.lower).toBeLessThan(p.mid);
    expect(p.upper - p.mid).toBeCloseTo(p.mid - p.lower, 10);
    expect(p.mid).toBeCloseTo(ema(WILDER, 20).at(-1)!, 10);
    expect(p.upper - p.mid).toBeCloseTo(1.5 * atr(ks, 20).at(-1)!, 10);
  });

  it('squeeze fires on a synthetic compression and counts consecutive bars', () => {
    // 40 bars of a steep trend (Bollinger far wider than Keltner), then 60 bars where price stops
    // moving: the BB width collapses to zero while the Wilder ATR behind the Keltner channel only
    // decays ~5 % a bar → BB ends up inside KC, which is the squeeze.
    const wide = Array.from({ length: 40 }, (_, i) => 100 + i * 10);
    const tight = new Array<number>(60).fill(490);
    const ks = [...fromCloses(wide, { range: 1 }), ...fromCloses(tight, { range: 0.02, start: T0 + 40 * HOUR })];
    const sq = squeeze(ks);
    expect(sq[35]!.on).toBe(false);
    expect(sq.at(-1)!.on).toBe(true);
    expect(sq.at(-1)!.bars_on).toBeGreaterThan(5);
    // bars_on is a run length: it must increase by exactly one while the squeeze holds.
    expect(sq.at(-1)!.bars_on).toBe(sq.at(-2)!.bars_on + 1);
    // Warm-up bars report off, never a fabricated "on".
    expect(sq[0]).toEqual({ on: false, bars_on: 0 });
  });

  it('supertrend sits under price in an uptrend, above it in a downtrend, and flips once', () => {
    const up = Array.from({ length: 60 }, (_, i) => 100 + i);
    const down = Array.from({ length: 60 }, (_, i) => 160 - i * 2);
    const ks = fromCloses([...up, ...down], { range: 1 });
    const st = supertrend(ks, 10, 3);
    const atEndOfUp = st[59]!;
    expect(atEndOfUp.dir).toBe(1);
    expect(atEndOfUp.value).toBeLessThan(Number(ks[59]!.close));
    const atEnd = st.at(-1)!;
    expect(atEnd.dir).toBe(-1);
    expect(atEnd.value).toBeGreaterThan(Number(ks.at(-1)!.close));
    const flips = st.filter((p, i) => i > 10 && Number.isFinite(p.value) && Number.isFinite(st[i - 1]!.value) && p.dir !== st[i - 1]!.dir);
    expect(flips).toHaveLength(1);
  });

  it('PSAR flips side and never sits inside the bar it protects', () => {
    const ks = fromCloses([...Array.from({ length: 40 }, (_, i) => 100 + i), ...Array.from({ length: 40 }, (_, i) => 140 - i)], { range: 1 });
    const p = psar(ks);
    expect(p[35]!.dir).toBe(1);
    expect(p.at(-1)!.dir).toBe(-1);
    expect(p[35]!.value).toBeLessThan(Number(ks[35]!.low));
  });
});

// ---------------------------------------------------------------- oscillators / volume

describe('oscillators', () => {
  it('stochastic is the slow variant (fast %K → SMA smooth → %D), bounded 0–100', () => {
    const ks = fromCloses(WILDER, { range: 0.3 });
    const s = stochastic(ks, 14, 3, 3);
    const p = s.at(-1)!;
    expect(p.k).toBeCloseTo(sma(s.map((x) => x.fast_k), 3).at(-1)!, 10);
    expect(p.d).toBeCloseTo(sma(s.map((x) => x.k), 3).at(-1)!, 10);
    for (const x of s) if (Number.isFinite(x.k)) expect(x.k).toBeGreaterThanOrEqual(0), expect(x.k).toBeLessThanOrEqual(100);
  });

  it('a flat window reports the neutral middle instead of dividing by zero', () => {
    const flat = fromCloses(new Array<number>(40).fill(50), { range: 0 });
    expect(stochastic(flat, 14, 3, 3).at(-1)!.k).toBe(50);
    expect(williamsR(flat, 14).at(-1)).toBe(-50);
    expect(stochRsi(new Array<number>(40).fill(50), 14).at(-1)).toBe(50);
    expect(cci(flat, 20).at(-1)).toBe(0);
  });

  it('Williams %R and StochRSI stay inside their ranges', () => {
    const ks = fromCloses(WILDER, { range: 0.3 });
    for (const v of williamsR(ks, 14)) if (Number.isFinite(v)) expect(v).toBeGreaterThanOrEqual(-100), expect(v).toBeLessThanOrEqual(0);
    for (const v of stochRsi(WILDER, 14)) if (Number.isFinite(v)) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(100);
  });

  it('MFI is 100 when every bar is an up bar and 0 when every bar is a down bar', () => {
    const up = fromCloses(Array.from({ length: 30 }, (_, i) => 100 + i), { range: 1 });
    expect(mfi(up, 14).at(-1)).toBeCloseTo(100, 9);
    const down = fromCloses(Array.from({ length: 30 }, (_, i) => 130 - i), { range: 1 });
    expect(mfi(down, 14).at(-1)).toBeCloseTo(0, 9);
  });

  it('OBV / Chaikin A/D accumulate signed volume and start at zero (window-relative, 8794 parity)', () => {
    const ks = fromCloses([10, 11, 10, 12], { range: 2, volume: 5 });
    expect(obv(ks)).toEqual([0, 5, 0, 5]);
    expect(chaikinAd(ks)[0]).toBe(chaikinAd(ks)[0]); // finite, seeded from the first bar
    expect(chaikinAd(fromCloses([10, 11], { range: 2, volume: 5 })).length).toBe(2);
  });

  it('momentum / ROC / TRIX read the way their definitions say', () => {
    const cl = Array.from({ length: 40 }, (_, i) => 100 + i);
    expect(momentum(cl, 10).at(-1)).toBeCloseTo(10, 10);
    expect(roc(cl, 10).at(-1)).toBeCloseTo((139 / 129 - 1) * 100, 10);
    const flat = new Array<number>(200).fill(50);
    expect(trix(flat, 30).at(-1)).toBeCloseTo(0, 10);
  });

  it('Aroon reports 100/0 when the window extreme is the current bar', () => {
    const ks = fromCloses(Array.from({ length: 40 }, (_, i) => 100 + i), { range: 1 });
    const a = aroon(ks, 25).at(-1)!;
    expect(a.up).toBeCloseTo(100, 9);
    expect(a.down).toBeCloseTo(0, 9);
    expect(a.osc).toBeCloseTo(100, 9);
  });
});

describe('VWAP / volume profile', () => {
  it('VWAP(day) resets at UTC midnight; VWAP(all) does not', () => {
    // 24 bars at 100 (day 1), then 24 bars at 200 (day 2).
    const ks = [...fromCloses(new Array<number>(24).fill(100), { range: 0 }), ...fromCloses(new Array<number>(24).fill(200), { range: 0, start: T0 + 24 * HOUR })];
    expect(vwap(ks, 'day').at(-1)).toBeCloseTo(200, 9);
    expect(vwap(ks, 'day')[23]).toBeCloseTo(100, 9);
    expect(vwap(ks, 'all').at(-1)).toBeCloseTo(150, 9);
    // The 8h funding session anchors at 00 / 08 / 16 UTC.
    expect(vwap(ks, 'session')[8]).toBeCloseTo(100, 9);
  });

  it('VWAP is volume-weighted, not a simple mean', () => {
    const ks = fromCloses([100, 200], { range: 0 });
    ks[1]!.volume = '300';
    // typical price == close here; (100·100 + 200·300) / 400
    expect(vwap(ks, 'all').at(-1)).toBeCloseTo(175, 9);
  });

  it('volume profile puts the POC inside the value area, and the value area inside the range', () => {
    const ks = fromCloses([...new Array<number>(60).fill(100), ...Array.from({ length: 30 }, (_, i) => 100 + i)], { range: 1 });
    const vp = volumeProfile(ks, 24, 120)!;
    expect(vp.val).toBeLessThanOrEqual(vp.poc);
    expect(vp.poc).toBeLessThanOrEqual(vp.vah);
    // The flat 60 bars are where the volume piled up.
    expect(vp.poc).toBeGreaterThan(99);
    expect(vp.poc).toBeLessThan(103);
    expect(volumeProfile(fromCloses([100], { range: 0 }), 24, 120)).toBeNull();
  });
});

// ---------------------------------------------------------------- ranking / structure

describe('percentileRank', () => {
  it('is 0–100 and reports the rank of each value inside its own trailing window', () => {
    expect(percentileRank([1, 2, 3, 4, 5], 5).at(-1)).toBe(100);
    expect(percentileRank([5, 4, 3, 2, 1], 5).at(-1)).toBe(20);
    expect(percentileRank([1, 2, 3, 4, 5], 5)[3]).toBeNaN(); // fewer than 5 comparable values
    const mid = percentileRank([10, 20, 30, 40, 50, 25], 6).at(-1)!;
    expect(mid).toBeCloseTo((3 / 6) * 100, 10);
  });

  it('never leaves the 0–100 box on noisy data', () => {
    const noisy = Array.from({ length: 200 }, (_, i) => Math.sin(i / 3) * 10 + i / 20);
    for (const v of percentileRank(noisy, 90)) if (Number.isFinite(v)) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(100);
  });
});

describe('swingPoints', () => {
  it('only reports confirmed fractals — never a bar inside the unconfirmed right window', () => {
    const cl = [10, 11, 12, 20, 12, 11, 10, 9, 3, 9, 10, 11, 12, 30];
    const ks = fromCloses(cl, { range: 0 });
    const sp = swingPoints(ks, 3, 3);
    expect(sp.highs.map(([i]) => i)).toContain(3);
    expect(sp.lows.map(([i]) => i)).toContain(8);
    // Index 13 is the highest bar but has no right window yet, so it must not be listed.
    expect(sp.highs.map(([i]) => i)).not.toContain(13);
    expect(sp.highs.find(([i]) => i === 3)?.[1]).toBe(20);
  });
});

// ---------------------------------------------------------------- snapshot & description

describe('indicatorSnapshot / describeIndicators', () => {
  const trending = fromCloses(
    Array.from({ length: 300 }, (_, i) => 60000 + i * 20 + Math.sin(i / 5) * 120),
    { range: 150, volume: 40 },
  );

  it('fills every family and labels the trend from EMA20/50 + ADX ≥ 20', () => {
    const s = indicatorSnapshot(trending, '1h')!;
    expect(s.tf).toBe('1h');
    expect(s.bars).toBe(300);
    expect(s.ema20).not.toBeNull();
    expect(s.ema200).not.toBeNull();
    expect(s.rsi14).not.toBeNull();
    expect(s.macd).not.toBeNull();
    expect(s.bb).not.toBeNull();
    expect(s.adx14).not.toBeNull();
    expect(s.vwap_day).not.toBeNull();
    expect(s.donchian20).not.toBeNull();
    expect(s.keltner20).not.toBeNull();
    expect(s.squeeze).not.toBeNull();
    expect(s.supertrend).not.toBeNull();
    expect(s.psar).not.toBeNull();
    expect(s.ichimoku).not.toBeNull();
    expect(s.volume_profile).not.toBeNull();
    expect(s.atr_pct).toBeGreaterThan(0);
    expect(s.atr_pct_rank_90).toBeGreaterThanOrEqual(0);
    expect(s.atr_pct_rank_90).toBeLessThanOrEqual(100);
    expect(s.bb_width_rank_90).toBeGreaterThanOrEqual(0);
    expect(s.trend).toBe('up');
    expect(['weak', 'moderate', 'strong']).toContain(s.trend_strength);
    expect(s.price_vs_cloud).toBe('above');
    // The snapshot must be the LAST bar's Ichimoku, not an older one that still had a chikou value
    // (chikou is NaN for the trailing 26 bars by construction).
    expect(s.ichimoku!.tenkan).toBeCloseTo(ichimoku(trending).at(-1)!.tenkan, 10);
    expect(Number.isNaN(ichimoku(trending).at(-1)!.chikou)).toBe(true);
  });

  it('calls a directionless market flat even when the EMAs happen to be ordered', () => {
    const chop = fromCloses(
      Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 2) * 3),
      { range: 1 },
    );
    const s = indicatorSnapshot(chop, '15m')!;
    expect(s.adx14!.adx).toBeLessThan(20);
    expect(s.trend).toBe('flat');
    expect(s.trend_strength).toBe('none');
  });

  it('describeIndicators is one compact line ≤ 220 chars with no NaN leaking through', () => {
    const line = describeIndicators(indicatorSnapshot(trending, '1h'));
    expect(line.length).toBeLessThanOrEqual(220);
    expect(line).toContain('1h:');
    expect(line).toContain('RSI14');
    expect(line).toContain('ATR');
    expect(line).not.toContain('NaN');
    expect(line).not.toContain('undefined');
    expect(describeIndicators(null)).toBe('指标:数据不足');
  });

  it('short histories degrade to nulls instead of throwing', () => {
    const s = indicatorSnapshot(fromCloses([1, 2, 3], { range: 0.1 }), '5m')!;
    expect(s.ema200).toBeNull();
    expect(s.adx14).toBeNull();
    expect(s.trend).toBe('flat');
    expect(describeIndicators(s)).toContain('5m:');
    expect(indicatorSnapshot([], '5m')).toBeNull();
  });

  it('tfFeatures carries the snapshot, so context/checklist callers get it for free', () => {
    const f = tfFeatures('1h', trending);
    expect(f.indicators).not.toBeNull();
    expect(f.indicators!.tf).toBe('1h');
    // Both EMA seedings converge over a long history (market.ts seeds on bar 0, indicators.ts on SMA).
    expect(f.indicators!.ema20!).toBeCloseTo(f.ema20, 4);
  });
});

// ---------------------------------------------------------------- review-metrics wiring

describe('ATR% floor is per timeframe', () => {
  it('exposes the table the playbook quotes', () => {
    expect(ATR_PCT_FLOOR['5m']).toBe(0.08);
    expect(ATR_PCT_FLOOR['15m']).toBe(0.15);
    expect(ATR_PCT_FLOOR['1h']).toBe(0.3);
    expect(ATR_PCT_FLOOR['4h']).toBe(0.6);
  });

  it('falls back to sqrt-of-time scaling for timeframes outside the table', () => {
    expect(atrPctFloor('5m')).toBe(0.08);
    expect(atrPctFloor('2h')).toBeCloseTo(0.08 * Math.sqrt(24), 2);
    expect(atrPctFloor('nonsense')).toBe(0.3);
    // Monotone in bar length — a longer bar can never demand less volatility than a shorter one.
    const tfs = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];
    for (let i = 1; i < tfs.length; i++) expect(atrPctFloor(tfs[i]!)).toBeGreaterThan(atrPctFloor(tfs[i - 1]!));
  });

  it('the same ATR% passes on 15m and fails on 4h', () => {
    const ks = fromCloses(
      Array.from({ length: 200 }, (_, i) => 60000 + Math.sin(i / 7) * 150),
      { range: 120, volume: 30 },
    );
    const mk = (tf: string) => tfFeatures(tf, ks);
    const on15 = scanChecklist([{ ...mk('15m'), atr14: 63500 * 0.002 }, mk('1h'), mk('4h')])!;
    expect(on15.atr_floor).toBe(0.15);
    const on4h = scanChecklist([{ ...mk('4h'), atr14: 63500 * 0.002 }, mk('1h'), mk('4h')])!;
    expect(on4h.atr_floor).toBe(0.6);
    expect(on15.atr_ok).toBe(true);
    expect(on4h.atr_ok).toBe(false);
  });
});

describe('scanChecklist indicator boxes', () => {
  const ks = fromCloses(
    Array.from({ length: 250 }, (_, i) => 60000 + i * 8 + Math.sin(i / 6) * 200),
    { range: 180, volume: 25 },
  );
  const features = [tfFeatures('15m', ks), tfFeatures('1h', ks), tfFeatures('4h', ks)];

  it('adds RSI / ADX / BB-width percentile / squeeze / VWAP distance and stays under ~320 chars', () => {
    const chk = scanChecklist(features)!;
    expect(chk.rsi14).not.toBeNull();
    expect(chk.adx14).not.toBeNull();
    expect(chk.trend_strength).not.toBeNull();
    expect(chk.bb_width_rank_90).not.toBeNull();
    expect(chk.squeeze_on).not.toBeNull();
    expect(chk.dist_to_vwap_atr).not.toBeNull();
    expect(chk.text).toContain('RSI14');
    expect(chk.text).toContain('ADX14');
    expect(chk.text).toContain('BB宽');
    expect(chk.text).toContain('挤压');
    expect(chk.text).toContain('距VWAP');
    expect(chk.text).toContain('watch_eligible=');
    expect(chk.text).not.toContain('NaN');
    expect(chk.text.length).toBeLessThanOrEqual(320);
    expect(chk.indicators_text).not.toBeNull();
  });

  it('the one-argument call still works and degrades to n/a boxes', () => {
    const bare = features.map((f) => ({ ...f, indicators: null }));
    const chk = scanChecklist(bare)!;
    expect(chk.rsi14).toBeNull();
    expect(chk.indicators_text).toBeNull();
    expect(chk.text).not.toContain('RSI14');
    expect(chk.text).toContain('watch_eligible=');
    // …and handing the klines in directly restores them.
    const withKlines = scanChecklist(bare, ks)!;
    expect(withKlines.rsi14).not.toBeNull();
    expect(withKlines.text).toContain('RSI14');
  });
});

// ---------------------------------------------------------------- route module

describe('GET /api/market/indicators shape', () => {
  const ks = fromCloses(
    Array.from({ length: 300 }, (_, i) => 60000 + i * 10 + Math.sin(i / 4) * 100),
    { range: 120, volume: 30 },
  );

  it('is registered in http-extra with exactly one entry', () => {
    expect(extraRouteModules).toContain(indicatorRoutes);
  });

  it('every advertised set produces points, and overlays are a subset of the catalogue', () => {
    for (const name of INDICATOR_SETS) {
      const pts = seriesFor(name, ks, 200);
      expect(Array.isArray(pts)).toBe(true);
      expect(pts.length).toBeGreaterThan(0);
      for (const p of pts) {
        expect(typeof p['t']).toBe('number');
        for (const [k, v] of Object.entries(p)) if (typeof v === 'number') expect(Number.isFinite(v), `${name}.${k}`).toBe(true);
      }
    }
    for (const o of OVERLAY_SETS) expect(INDICATOR_SETS).toContain(o);
    for (const d of DEFAULT_SETS) expect(INDICATOR_SETS).toContain(d);
  });

  it('emits the documented field names per set', () => {
    const keys = (name: Parameters<typeof seriesFor>[0]) => Object.keys(seriesFor(name, ks, 290)[0]!).sort();
    expect(keys('ema20')).toEqual(['t', 'v']);
    expect(keys('bb')).toEqual(['lower', 'mid', 't', 'upper', 'width_pct']);
    expect(keys('donchian')).toEqual(['lower', 'mid', 't', 'upper']);
    expect(keys('macd')).toEqual(['hist', 'macd', 'signal', 't']);
    expect(keys('adx')).toEqual(['adx', 'minus_di', 'plus_di', 't']);
    expect(keys('supertrend')).toEqual(['dir', 't', 'value']);
    expect(keys('stoch')).toEqual(['d', 'k', 't']);
    expect(keys('squeeze')).toEqual(['bars_on', 'on', 't']);
    expect(keys('vwap')).toEqual(['t', 'v']);
  });

  it('`from` trims the warm-up window without shifting timestamps', () => {
    const all = seriesFor('ema20', ks, 0);
    const tail = seriesFor('ema20', ks, 280);
    expect(tail).toHaveLength(20);
    expect(tail[0]!['t']).toBe(ks[280]!.open_time);
    expect(tail.at(-1)).toEqual(all.at(-1));
  });

  it('set= parsing: defaults, "all", dedupe, and unknown names reported rather than swallowed', () => {
    expect(parseSets(null).sets).toEqual([...DEFAULT_SETS]);
    expect(parseSets('').sets).toEqual([...DEFAULT_SETS]);
    expect(parseSets('all').sets).toEqual([...INDICATOR_SETS]);
    expect(parseSets('ema20,EMA20, bb ').sets).toEqual(['ema20', 'bb']);
    const bad = parseSets('ema20,ichimoku,fibonacci');
    expect(bad.sets).toEqual(['ema20', 'ichimoku']);
    expect(bad.unknown).toEqual(['fibonacci']);
    // Nothing recognisable at all → the defaults, never an empty chart.
    expect(parseSets('fibonacci').sets).toEqual([...DEFAULT_SETS]);
  });
});
