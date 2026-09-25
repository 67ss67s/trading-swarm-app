import { describe, expect, it } from 'vitest';
import { mirrorKline, mirrorKlines } from '../src/index.js';
import { kl, synthCases } from './helpers/synthetic.js';

describe('mirror transform', () => {
  it('maps p → 2p₀ − p, swaps high/low, keeps volume and timestamps', () => {
    const k = kl(1_000_000, 100.25, 103.5, 98.75, 101.0, 42);
    const m = mirrorKline(k, 100);
    expect(m.open).toBe('99.75');
    expect(m.close).toBe('99.00');
    expect(m.high).toBe('101.25'); // 2·100 − low
    expect(m.low).toBe('96.50'); // 2·100 − high
    expect(m.volume).toBe(k.volume);
    expect(m.open_time).toBe(k.open_time);
    expect(m.close_time).toBe(k.close_time);
    expect(Number(m.high)).toBeGreaterThanOrEqual(Number(m.low));
    // involution: mirroring twice is the identity
    expect(mirrorKline(m, 100)).toEqual(k);
  });

  it('mirror cases are exact mirrors of their base at every tf, with the same as_of and p₀ fixed', async () => {
    const cases = await synthCases({ n: 2 });
    const mirrors = cases.filter((c) => c.mode === 'scan' && c.tags.includes('mirror'));
    expect(mirrors.length).toBe(2);
    for (const m of mirrors) {
      const b = cases.find((c) => c.id === m.hidden.mirror_of)!;
      const p0 = Number(b.visible.market.last);
      expect(m.as_of).toBe(b.as_of);
      expect(m.visible.market.last).toBe(b.visible.market.last); // 2p₀ − p₀ = p₀
      for (const tf of Object.keys(b.visible.klines)) {
        const bk = b.visible.klines[tf]!;
        const mk = m.visible.klines[tf]!;
        expect(mk.length).toBe(bk.length);
        expect(JSON.stringify(mk)).toBe(JSON.stringify(mirrorKlines(bk, p0)));
        bk.forEach((k, i) => {
          const x = mk[i]!;
          expect(Math.abs(Number(x.open) - (2 * p0 - Number(k.open)))).toBeLessThan(0.006);
          expect(Math.abs(Number(x.high) - (2 * p0 - Number(k.low)))).toBeLessThan(0.006);
          expect(Math.abs(Number(x.low) - (2 * p0 - Number(k.high)))).toBeLessThan(0.006);
          expect(x.volume).toBe(k.volume);
          expect(x.open_time).toBe(k.open_time);
        });
      }
      expect(JSON.stringify(m.hidden.future_klines)).toBe(JSON.stringify(mirrorKlines(b.hidden.future_klines, p0)));
      expect(m.visible.ticker24h.quoteVolume).toBe(b.visible.ticker24h.quoteVolume);
      expect(Number(m.visible.ticker24h.highPrice)).toBeCloseTo(2 * p0 - Number(b.visible.ticker24h.lowPrice), 1);
    }
    // review mirrors carry the mirrored thread: opposite side, mirrored stop
    const rev = cases.filter((c) => c.mode === 'review' && c.hidden.mirror_of);
    expect(rev.length).toBeGreaterThan(0);
    for (const m of rev) {
      const b = cases.find((c) => c.id === m.hidden.mirror_of)!;
      // the thread was mirrored around the *base scan* close, not the review step's close
      const baseScan = cases.find((c) => c.id === b.id.replace(/-rev\d+$/, ''))!;
      const p0 = Number(baseScan.visible.market.last);
      expect(m.thread!.side).not.toBe(b.thread!.side);
      expect(Math.abs(Number(m.thread!.stop_price) - (2 * p0 - Number(b.thread!.stop_price)))).toBeLessThan(0.006);
      expect(m.thread!.qty).toBe(b.thread!.qty);
    }
  });
});
