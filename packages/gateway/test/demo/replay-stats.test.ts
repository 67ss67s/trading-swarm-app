import { describe, it, expect } from 'vitest';
import { anchoredWalkForward, bootstrapCI, deflatedSharpe, selectUniverse, selectWalkForward, summarizeReplay, DAY, type ReplaySample } from '../../src/demo/replay-stats.js';
import type { Kline } from '../../src/demo/types.js';
const sample = (day: number, r: number): ReplaySample => ({ at: day * DAY, exit_at: day * DAY + 1000, horizon_end_at: (day + 1) * DAY, gross_r: r + 0.1, net_r: r, regime: 'range', symbol: 'A' });
describe('无偏统计', () => {
  it('60/20 anchored，purge 与 embargo 不重叠，保留完整测试窗', () => {
    const folds = anchoredWalkForward(0, 130 * DAY, 48, 900000);
    expect(folds).toHaveLength(3);
    expect(folds[0]).toEqual({ train_from: 0, train_to: 60 * DAY, test_from: 60.5 * DAY, test_to: 80.5 * DAY });
    expect(folds[1]!.train_from).toBe(0);
    expect(folds[1]!.test_from - folds[0]!.test_to).toBe(0.5 * DAY);
    expect(anchoredWalkForward(0, 60 * DAY, 48, 900000)).toEqual([]);
  });
  it('bootstrap 小样本不足、常数区间准确、正负镜像、重现性', () => {
    expect(bootstrapCI(Array(29).fill(1)).status).toBe('insufficient');
    expect(bootstrapCI(Array(30).fill(2))).toMatchObject({ lower: 2, upper: 2, iterations: 2000 });
    const values = Array.from({ length: 80 }, (_, i) => i % 3 ? 0.9 : -0.8);
    expect(bootstrapCI(values)).toEqual(bootstrapCI(values));
    expect(bootstrapCI(values).lower).toBeGreaterThan(0);
    expect(bootstrapCI(values.map(v => -v)).upper).toBeLessThan(0);
  });
  it('相同 OOS 在更多试验后 DSR 降低；零方差不可识别', () => {
    const values = Array.from({ length: 100 }, (_, i) => i % 2 ? 1 : -0.4);
    const one = deflatedSharpe(values, 1); const many = deflatedSharpe(values, 100);
    expect(many.dsr!).toBeLessThan(one.dsr!);
    expect(many.dsr_probability!).toBeLessThan(one.dsr_probability!);
    expect(deflatedSharpe(Array(100).fill(1), 2).dsr).toBeNull();
  });
  it('只按训练选，测试窗暴赚候选不能反向胜出；跨窗交易剔除', () => {
    const fold = anchoredWalkForward(0, 90 * DAY, 1, DAY)[0]!;
    const a = [...Array.from({ length: 40 }, (_, i) => sample(i, 1)), sample(65, -2)];
    const b = [...Array.from({ length: 40 }, (_, i) => sample(i, 0)), sample(65, 100), { ...sample(59, 9999), exit_at: 62 * DAY }];
    const chosen = selectWalkForward([{ key: 'a', samples: a }, { key: 'b', samples: b }], [fold]);
    expect(chosen[0]!.key).toBe('a'); expect(chosen[0]!.samples[0]!.net_r).toBe(-2);
  });
  it('测试窗尾部不能只留下提前止盈，资格只看预定 horizon', () => {
    const fold = { train_from: 0, train_to: 60 * DAY, test_from: 61 * DAY, test_to: 81 * DAY };
    const rows = Array.from({ length: 80 }, (_, i) => ({ ...sample(80.9, i < 40 ? 1 : -1), exit_at: (i < 40 ? 80.99 : 81.2) * DAY }));
    const stats = summarizeReplay(rows, [fold], 1);
    expect(stats.oos_n).toBe(0); expect(stats.oos_expectancy).toBeNull();
  });
  it('未来成交额与后来上市币不改变起点币池，历史退市候选仍参与', () => {
    const bars = (start: number, volume: number): Kline[] => Array.from({ length: 61 - start }, (_, i) => ({ open_time: (start + i) * DAY, close_time: (start + i + 1) * DAY - 1, open: '1', high: '1', low: '1', close: '1', volume: String(volume) }));
    const a = bars(0, 10); const b = bars(0, 20); const fresh = bars(50, 9999);
    a.push({ ...a[0]!, open_time: 80 * DAY, close_time: 81 * DAY, volume: '99999999999' });
    expect(selectUniverse({ old_delisted: b, a, fresh }, 60 * DAY, 1)).toEqual(['old_delisted']);
  });
});
