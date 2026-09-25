import { describe, expect, it } from 'vitest';
import { deflatedSharpe, expectedMaxSharpe, moments, normCdf, normInv, seededRandom, dailyReturns, periodSharpe } from '../../../../src/demo/research/improve/stats.js';

describe('改进环统计工具', () => {
  it('正态 CDF / 分位数对得上 Python statistics.NormalDist', () => {
    expect(normCdf(1.2345)).toBeCloseTo(0.8914916766373298, 6);
    expect(normInv(0.975)).toBeCloseTo(1.9599639845400534, 7);
    expect(normInv(0.001)).toBeCloseTo(-3.090232306167813, 7);
    expect(normCdf(normInv(0.3))).toBeCloseTo(0.3, 6);
  });
  it('Deflated Sharpe 对手算例子(SR=0.08/日,T=500,偏度 -0.3,峰度 5,N=10,V=0.002)', () => {
    // 手算(Python NormalDist):SR0 = √V·((1-γ)Φ⁻¹(1-1/N) + γΦ⁻¹(1-1/(Ne))) = 0.0704181767812959;DSR = 0.5835019873519492
    const r = deflatedSharpe({ sharpe: 0.08, trials: 10, sharpeVariance: 0.002, days: 500, skew: -0.3, kurtosis: 5 })!;
    expect(r.sr0).toBeCloseTo(0.0704181767812959, 6);
    expect(r.dsr).toBeCloseTo(0.5835019873519492, 5);
    expect(expectedMaxSharpe(10, 0.002)).toBeCloseTo(r.sr0, 12);
  });
  it('只试一次时退化为 PSR(SR0=0);试得越多 DSR 越低', () => {
    const one = deflatedSharpe({ sharpe: 0.05, trials: 1, sharpeVariance: 0.002, days: 250, skew: 0, kurtosis: 3 })!;
    expect(one.sr0).toBe(0); expect(one.dsr).toBeCloseTo(0.784796107435966, 5);
    const many = deflatedSharpe({ sharpe: 0.05, trials: 100, sharpeVariance: 0.002, days: 250, skew: 0, kurtosis: 3 })!;
    expect(many.dsr).toBeLessThan(one.dsr);
  });
  it('矩、日收益与固定种子随机数', () => {
    expect(moments([1, 2, 3, 4, 5])).toEqual({ skew: 0, kurtosis: expect.closeTo(1.7, 6) });
    const day = 86400000, r = dailyReturns([{ at: 0, equity: 100 }, { at: day / 2, equity: 101 }, { at: day, equity: 110 }, { at: 2 * day, equity: 99 }]);
    expect(r).toEqual([expect.closeTo(110 / 101 - 1, 12), expect.closeTo(99 / 110 - 1, 12)]);
    expect(periodSharpe([0.01])).toBeNull();
    const a = seededRandom(42), b = seededRandom(42), xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});
