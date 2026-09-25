// market.ts dailyRegime: bull / bear / range / volatile from synthetic daily closes (offline).

import { describe, expect, it } from 'vitest';
import { dailyRegime } from '../../src/demo/market.js';
import type { Kline } from '../../src/demo/types.js';

const DAY = 86_400_000;
function series(closes: number[], now: number): Kline[] {
  return closes.map((c, i) => {
    const open = i === 0 ? c : closes[i - 1]!;
    const openTime = now - (closes.length - i) * DAY;
    return { open_time: openTime, open: String(open), high: String(Math.max(open, c) * 1.01), low: String(Math.min(open, c) * 0.99), close: String(c), volume: '1000', close_time: openTime + DAY - 1 };
  });
}

describe('dailyRegime', () => {
  const now = Date.UTC(2026, 8, 4);

  it('needs at least 30 closed days', () => {
    expect(dailyRegime(series(Array.from({ length: 20 }, (_, i) => 100 + i), now), now)).toBeNull();
  });

  it('a steady uptrend is bull with a positive 20d return and a stacked EMA text', () => {
    const r = dailyRegime(series(Array.from({ length: 120 }, (_, i) => 100 * Math.pow(1.004, i)), now), now)!;
    expect(r.regime).toBe('bull');
    expect(r.ret_20d_pct).toBeGreaterThan(0);
    expect(r.ema_stack).toMatch(/价>EMA20, EMA20>EMA50/);
    expect(r.text).toMatch(/牛/);
  });

  it('a steady downtrend is bear', () => {
    const r = dailyRegime(series(Array.from({ length: 120 }, (_, i) => 100 * Math.pow(0.996, i)), now), now)!;
    expect(r.regime).toBe('bear');
    expect(r.ret_20d_pct).toBeLessThan(0);
  });

  it('a flat oscillation is range', () => {
    const r = dailyRegime(series(Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 3) * 0.5), now), now)!;
    expect(r.regime).toBe('range');
  });

  it('a recent burst of volatility after a calm history is volatile', () => {
    const calm = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 5) * 0.2);
    const wild = Array.from({ length: 20 }, (_, i) => 100 + (i % 2 === 0 ? 8 : -8));
    const r = dailyRegime(series([...calm, ...wild], now), now)!;
    expect(r.regime).toBe('volatile');
    expect(r.vol_pct_rank).toBeGreaterThanOrEqual(0.85);
  });

  it('ignores the still-open candle', () => {
    const ks = series(Array.from({ length: 60 }, (_, i) => 100 + i), now);
    ks.push({ open_time: now, open: '1', high: '1', low: '1', close: '1', volume: '0', close_time: now + DAY }); // absurd open candle
    const r = dailyRegime(ks, now)!;
    expect(r.regime).toBe('bull');
  });
});
