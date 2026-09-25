import { describe, expect, it } from 'vitest';
import { missedMove, simulateOutcome } from '../src/index.js';
import { kl } from './helpers/synthetic.js';

const T = 1_700_000_000_000;
const bar = (i: number, o: number, h: number, l: number, c: number) => kl(T + i * 900_000, o, h, l, c);

describe('outcome simulator', () => {
  it('market entry fills at next open; same-bar stop+tp → stop wins at −1R', () => {
    const o = simulateOutcome({ direction: 'long', entry: 'market', limit_price: null, stop: 95, tp: 110, bars: [bar(0, 100, 111, 94, 105)] });
    expect(o.status).toBe('stop');
    expect(o.fill_price).toBe(100);
    expect(o.r).toBe(-1);
    expect(o.note).toContain('同根');
    expect(o.mfe_r).toBeCloseTo(11 / 5, 6);
    expect(o.mae_r).toBeCloseTo(-6 / 5, 6);
  });

  it('take-profit pays tp-distance / stop-distance in R', () => {
    const o = simulateOutcome({ direction: 'long', entry: 'market', limit_price: null, stop: 95, tp: 110, bars: [bar(0, 100, 105, 98, 104), bar(1, 104, 111, 103, 109)] });
    expect(o.status).toBe('tp');
    expect(o.r).toBeCloseTo(2, 9);
    expect(o.exit_bar).toBe(1);
    expect(o.bars_held).toBe(2);
  });

  it('expires at the last close when nothing is touched', () => {
    const o = simulateOutcome({ direction: 'long', entry: 'market', limit_price: null, stop: 95, tp: 110, bars: [bar(0, 100, 103, 98, 102), bar(1, 102, 104, 99, 101.5)] });
    expect(o.status).toBe('expired');
    expect(o.r).toBeCloseTo(1.5 / 5, 9);
  });

  it('a gap through the stop exits at the open (worse than −1R)', () => {
    const o = simulateOutcome({ direction: 'long', entry: 'market', limit_price: null, stop: 95, tp: null, bars: [bar(0, 100, 101, 98, 99), bar(1, 90, 92, 88, 91)] });
    expect(o.status).toBe('stop');
    expect(o.r).toBeCloseTo(-2, 9);
  });

  it('limit fills only when touched, at the limit (or the open when the bar gaps through)', () => {
    const touched = simulateOutcome({ direction: 'long', entry: 'limit', limit_price: 98, stop: 93, tp: 108, bars: [bar(0, 100, 101, 99, 100.5), bar(1, 100, 102, 97, 101), bar(2, 101, 109, 100, 108)] });
    expect(touched.status).toBe('tp');
    expect(touched.fill_bar).toBe(1);
    expect(touched.fill_price).toBe(98);
    expect(touched.r).toBeCloseTo(2, 9);
    const gapped = simulateOutcome({ direction: 'long', entry: 'limit', limit_price: 98, stop: 93, tp: 108, bars: [bar(0, 96, 99, 95, 97)] });
    expect(gapped.fill_price).toBe(98); // 09-12 保守口径:跳空穿过限价不改善成交价,仍按限价成交
    const unfilled = simulateOutcome({ direction: 'long', entry: 'limit', limit_price: 98, stop: 93, tp: 108, bars: [bar(0, 100, 101, 99, 100.5), bar(1, 100.5, 103, 99.5, 102)] });
    expect(unfilled.status).toBe('unfilled');
    expect(unfilled.r).toBeNull();
  });

  it('short side is symmetric and wrong-side stops are invalid', () => {
    const s = simulateOutcome({ direction: 'short', entry: 'market', limit_price: null, stop: 105, tp: 90, bars: [bar(0, 100, 106, 89, 95)] });
    expect(s.status).toBe('stop');
    expect(s.r).toBe(-1);
    const win = simulateOutcome({ direction: 'short', entry: 'market', limit_price: null, stop: 105, tp: 90, bars: [bar(0, 100, 102, 89, 95)] });
    expect(win.status).toBe('tp');
    expect(win.r).toBeCloseTo(2, 9);
    expect(simulateOutcome({ direction: 'long', entry: 'market', limit_price: null, stop: 105, tp: null, bars: [bar(0, 100, 102, 99, 101)] }).status).toBe('invalid');
  });

  it('missed move is the largest excursion in ATR units', () => {
    const m = missedMove(100, 2, [bar(0, 100, 103, 99, 101), bar(1, 101, 104, 95, 96)]);
    expect(m!.up_atr).toBeCloseTo(2, 9);
    expect(m!.down_atr).toBeCloseTo(2.5, 9);
    expect(m!.max_atr).toBeCloseTo(2.5, 9);
  });
});
