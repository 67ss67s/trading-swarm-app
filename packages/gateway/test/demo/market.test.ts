// market.ts pure functions: ema, atr, tfFeatures (structure features on synthetic klines),
// tfToMs, nextCloseAfter. No network here — fetch* wrappers are exercised end-to-end in
// runtime.test.ts / http.test.ts against a local fake server instead.

import { describe, expect, it } from 'vitest';
import { atr, ema, nextCloseAfter, tfFeatures, tfToMs } from '../../src/demo/market.js';
import type { Kline } from '../../src/demo/types.js';

function mkKline(partial: Partial<Kline>): Kline {
  return { open_time: 0, open: '100', high: '101', low: '99', close: '100', volume: '10', close_time: 0, ...partial };
}

// ---------------------------------------------------------------- ema

describe('ema', () => {
  it('returns one output per input, seeded by the first value', () => {
    const out = ema([5, 5, 5, 5], 3);
    expect(out).toHaveLength(4);
    expect(out[0]).toBe(5);
  });

  it('a constant series stays constant (no drift)', () => {
    const out = ema([42, 42, 42, 42, 42], 10);
    for (const v of out) expect(v).toBeCloseTo(42, 9);
  });

  it('matches the standard EMA recurrence value-by-value', () => {
    const period = 2;
    const k = 2 / (period + 1);
    const values = [1, 2, 3, 4];
    const out = ema(values, period);
    let expected = values[0]!;
    const expectedOut = [expected];
    for (let i = 1; i < values.length; i++) {
      expected = values[i]! * k + expected * (1 - k);
      expectedOut.push(expected);
    }
    for (let i = 0; i < out.length; i++) expect(out[i]).toBeCloseTo(expectedOut[i]!, 9);
  });

  it('empty input yields empty output', () => {
    expect(ema([], 20)).toEqual([]);
  });
});

// ---------------------------------------------------------------- atr

describe('atr', () => {
  it('is 0 for a single candle (no true ranges to average)', () => {
    expect(atr([mkKline({ high: '110', low: '90', close: '100' })], 14)).toBe(0);
  });

  it('averages true range over flat candles with a constant close (true range = high-low)', () => {
    const klines: Kline[] = [];
    for (let i = 0; i < 5; i++) klines.push(mkKline({ open_time: i, high: '105', low: '95', close: '100', close_time: i }));
    // Every bar: high-low=10, |high-prevClose|=5, |low-prevClose|=5 → true range = 10 every time.
    expect(atr(klines, 14)).toBeCloseTo(10, 9);
  });

  it('only averages the last `period` true ranges when more bars are available', () => {
    const klines: Kline[] = [
      mkKline({ high: '200', low: '0', close: '100' }), // huge TR, should be excluded once period=1
      mkKline({ high: '101', low: '99', close: '100' }),
    ];
    // period=1 → only the most recent true range counts: |101-99|=2 (vs prevClose 100: both diffs =1..1)
    expect(atr(klines, 1)).toBeCloseTo(2, 9);
  });
});

// ---------------------------------------------------------------- tfFeatures

/**
 * Builds `count` closed candles ending "now" (spaced `stepMs` apart), plus one still-open candle
 * appended at the end whose close_time is in the future — mirroring what Binance actually returns
 * (the currently-forming candle). closes rise by 1 per bar so trend/EMA ordering is unambiguous.
 */
function buildKlines(count: number, opts: { stepMs?: number; startClose?: number; volumes?: number[]; openCandle?: boolean } = {}): Kline[] {
  const stepMs = opts.stepMs ?? 3_600_000;
  const startClose = opts.startClose ?? 100;
  const now = Date.now();
  const out: Kline[] = [];
  for (let i = 0; i < count; i++) {
    const close = startClose + i;
    const open = close - 1;
    const openTime = now - (count - i) * stepMs;
    out.push({
      open_time: openTime,
      open: open.toFixed(2),
      high: (close + 1).toFixed(2),
      low: (close - 1).toFixed(2),
      close: close.toFixed(2),
      volume: String(opts.volumes?.[i] ?? 1000),
      close_time: openTime + stepMs - 1000, // safely in the past
    });
  }
  if (opts.openCandle ?? true) {
    const close = startClose + count;
    out.push({
      open_time: now,
      open: (close - 1).toFixed(2),
      high: (close + 5).toFixed(2), // deliberately a huge wick, would corrupt swing_high if included
      low: (close - 5).toFixed(2),
      close: close.toFixed(2),
      volume: '999999',
      close_time: now + stepMs, // still forming: close_time in the future
    });
  }
  return out;
}

describe('tfFeatures', () => {
  it('excludes the still-open last candle (its huge wick must not leak into swing_high/low or volume)', () => {
    const klines = buildKlines(24, { volumes: Array.from({ length: 24 }, () => 1000) });
    const f = tfFeatures('1h', klines);
    // closes are 100..123 (24 values); the open candle would have high=129 if it leaked in.
    expect(f.swing_high_20).toBeLessThan(125);
    expect(f.last_close).toBe(123); // last *closed* close, not the open candle's 124
  });

  it('computes swing_high_20 / swing_low_20 over exactly the last 20 closed candles', () => {
    const klines = buildKlines(24, { volumes: Array.from({ length: 24 }, () => 1000) });
    const f = tfFeatures('1h', klines);
    // closes[4..23] = 104..123 → highs = closes+1 = 105..124, lows = closes-1 = 103..122.
    expect(f.swing_high_20).toBeCloseTo(124, 6);
    expect(f.swing_low_20).toBeCloseTo(103, 6);
  });

  it('computes dist_to_high20_pct / dist_to_low20_pct relative to the last closed close', () => {
    const klines = buildKlines(24, { volumes: Array.from({ length: 24 }, () => 1000) });
    const f = tfFeatures('1h', klines);
    // lastClose=123; hi20=124 → dist=(124-123)/123*100; lo20=103 → dist=(123-103)/123*100
    expect(f.dist_to_high20_pct).toBeCloseTo(((124 - 123) / 123) * 100, 6);
    expect(f.dist_to_low20_pct).toBeCloseTo(((123 - 103) / 123) * 100, 6);
  });

  it('computes vol_ratio_20 as last closed volume over the average of the prior 20', () => {
    const volumes = Array.from({ length: 24 }, () => 1000);
    volumes[23] = 5000; // last closed candle's volume spikes
    const klines = buildKlines(24, { volumes });
    const f = tfFeatures('1h', klines);
    expect(f.vol_ratio_20).toBeCloseTo(5, 6); // 5000 / avg(1000×20) = 5
  });

  it('EMA20 reacts faster than EMA50 to a rising series (ema20 > ema50)', () => {
    const klines = buildKlines(60, { volumes: Array.from({ length: 60 }, () => 1000) });
    const f = tfFeatures('1h', klines);
    expect(f.ema20).toBeGreaterThan(f.ema50);
  });

  it('falls back to the full kline array (including the open candle) when fewer than 5 closed candles are available', () => {
    const klines = buildKlines(3, { volumes: [1000, 1000, 1000] }); // 3 closed + 1 open = 4 total, < 5 closed
    const f = tfFeatures('1h', klines);
    // last_close should be the *open* candle's close since the closed-only slice was too short to use.
    expect(f.last_close).toBe(103);
  });
});

// ---------------------------------------------------------------- tfToMs

describe('tfToMs', () => {
  it('converts minute timeframes', () => {
    expect(tfToMs('15m')).toBe(15 * 60_000);
  });
  it('converts hour timeframes', () => {
    expect(tfToMs('4h')).toBe(4 * 3_600_000);
  });
  it('converts day timeframes', () => {
    expect(tfToMs('1d')).toBe(86_400_000);
  });
  it('throws on an unrecognized timeframe format', () => {
    expect(() => tfToMs('15x')).toThrow(/bad timeframe/);
    expect(() => tfToMs('h1')).toThrow(/bad timeframe/);
  });
});

// ---------------------------------------------------------------- nextCloseAfter

describe('nextCloseAfter', () => {
  const ms = 3_600_000; // 1h

  it('when `now` is exactly on a bar boundary, returns the *next* bar close (not the current one)', () => {
    const now = ms * 3; // exactly the start of bar #3
    expect(nextCloseAfter(now, '1h', 5000)).toBe(ms * 4 + 5000);
  });

  it('when `now` is one ms before a boundary, still returns the close of the bar in progress', () => {
    const now = ms * 3 - 1; // still inside bar #2
    expect(nextCloseAfter(now, '1h', 5000)).toBe(ms * 3 + 5000);
  });

  it('when `now` is one ms after a boundary, returns the close of the new bar (not the one that just closed)', () => {
    const now = ms * 3 + 1; // just inside bar #3
    expect(nextCloseAfter(now, '1h', 5000)).toBe(ms * 4 + 5000);
  });

  it('respects a custom grace period', () => {
    const now = ms * 3;
    expect(nextCloseAfter(now, '1h', 0)).toBe(ms * 4);
    expect(nextCloseAfter(now, '1h', 12_345)).toBe(ms * 4 + 12_345);
  });
});
