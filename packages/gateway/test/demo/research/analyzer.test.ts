import { describe, it, expect } from 'vitest';
import { analyze, cagrOf, capitalUsage, confidenceOf, dailyPnl, sideBreakdown, strategyCapacity, downsample, drawdownStats, histogram, periodReturns, returnStats, score, scoreLabel, tradeStats, type ClosedTrade, type EquitySample } from '../../../src/demo/research/analyzer.js';
const D = 86400000, T0 = Date.UTC(2024, 0, 1);
const s = (day: number, equity: number, benchmark: number | null = null, exposure = 0): EquitySample => ({ at: T0 + day * D, equity, benchmark, exposure });
const t = (pnl: number, ret: number, exitDay: number, bars = 3, reason = 'stop'): ClosedTrade => ({ entry_at: T0 + (exitDay - 1) * D, exit_at: T0 + exitDay * D, pnl, return_pct: ret, fees: 1, bars_held: bars, exit_reason: reason, side: 'long' });
describe('Nautilus 式统计(手算小例子)', () => {
  it('回撤深度、回撤时间占比与最长回撤时长', () => {
    const d = drawdownStats([s(0, 100), s(1, 120), s(2, 90), s(3, 130), s(4, 110)]);
    expect(d.max_drawdown).toBeCloseTo(0.25, 12); // 120 → 90
    expect(d.time_in_drawdown).toBeCloseTo(2 / 5, 12); // 90 与 110 两个点在前高之下
    expect(d.max_drawdown_duration_ms).toBe(2 * D); // 前高 120(第 1 天)到第 3 天收复
  });
  it('PnL / position 统计:胜率、盈亏因子、均盈均亏、盈亏比、期望、连胜连亏、最好最差', () => {
    const trades = [t(10, 0.1, 1), t(-5, -0.05, 2), t(20, 0.2, 3), t(-5, -0.05, 4), t(-5, -0.05, 5)];
    const m = analyze([s(0, 100, 100), s(1, 120, 110, 0.5), s(2, 90, 100), s(3, 130, 120, 0.25), s(4, 110, 121)], trades, 5);
    expect(m.total_return).toBeCloseTo(0.1, 12); expect(m.net_pnl).toBeCloseTo(10, 12); expect(m.fees).toBe(5);
    expect(m.trades).toBe(5); expect(m.win_rate).toBeCloseTo(0.4, 12); expect(m.profit_factor).toBeCloseTo(30 / 15, 12);
    expect(m.avg_win).toBeCloseTo(0.15, 12); expect(m.avg_loss).toBeCloseTo(-0.05, 12); expect(m.risk_reward).toBeCloseTo(3, 12);
    expect(m.expectancy).toBeCloseTo(0.03, 12); expect(m.max_win_streak).toBe(1); expect(m.max_loss_streak).toBe(2);
    expect(m.best_trade).toBeCloseTo(0.2, 12); expect(m.worst_trade).toBeCloseTo(-0.05, 12);
    expect(m.avg_holding_ms).toBe(D); expect(m.benchmark_return).toBeCloseTo(0.21, 12); expect(m.excess_return).toBeCloseTo(0.1 - 0.21, 12);
    expect(m.exposure).toBeCloseTo(0.75 / 5, 12); expect(m.time_in_market).toBeCloseTo(2 / 5, 12);
    // 样本不足(日收益 < 30):sharpe/sortino/vol/alpha/beta 全部 null,不给假数;窗口 < 30 天 cagr/calmar 也是 null
    for (const k of ['sharpe', 'sortino', 'volatility', 'alpha', 'beta', 'cagr', 'calmar'] as const) expect(m[k]).toBeNull();
  });
  it('没有亏损时盈亏因子为 null;没有交易时交易统计全 null', () => {
    expect(analyze([s(0, 100), s(1, 110)], [t(10, 0.1, 1)], 0).profit_factor).toBeNull();
    const m = analyze([s(0, 100), s(1, 100)], [], 0);
    for (const k of ['win_rate', 'avg_win', 'avg_loss', 'risk_reward', 'expectancy', 'avg_holding_ms', 'best_trade', 'worst_trade'] as const) expect(m[k]).toBeNull();
    expect(m.trades).toBe(0); expect(m.max_drawdown).toBe(0);
  });
  it('CAGR 按 365 天;两年 100→121 = 10%', () => {
    expect(cagrOf(100, 121, T0, T0 + 730 * D)).toBeCloseTo(0.1, 12);
    expect(cagrOf(100, 121, T0, T0 + 29 * D)).toBeNull();
  });
  it('Sharpe / Sortino / 波动率按日收益 ×√365;beta/alpha 对基准日收益 OLS', () => {
    // 40 个日收益交替 +2% / -1%;基准日收益正好是策略的 2 倍 → beta = 0.5,alpha = 0
    const samples: EquitySample[] = [s(0, 100, 100)];
    let e = 100, b = 100;
    for (let i = 1; i <= 40; i++) { const r = i % 2 ? 0.02 : -0.01; e *= 1 + r; b *= 1 + 2 * r; samples.push(s(i, e, b)); }
    const r = returnStats(samples), sd = 0.015 * Math.sqrt(40 / 39);
    expect(r.returns).toBe(40);
    expect(r.sharpe!).toBeCloseTo((0.005 / sd) * Math.sqrt(365), 9);
    expect(r.sortino!).toBeCloseTo((0.005 / Math.sqrt((20 * 0.0001) / 40)) * Math.sqrt(365), 9);
    expect(r.volatility!).toBeCloseTo(sd * Math.sqrt(365), 9);
    expect(r.beta!).toBeCloseTo(0.5, 9); expect(r.alpha!).toBeCloseTo(0, 9);
  });
  it('月度 / 年度收益按期末净值相除,基准同式', () => {
    const m = periodReturns([{ at: Date.UTC(2024, 0, 1), equity: 100, benchmark: 100, exposure: 0 }, { at: Date.UTC(2024, 0, 31), equity: 110, benchmark: 105, exposure: 0 }, { at: Date.UTC(2024, 1, 29), equity: 99, benchmark: 105, exposure: 0 }, { at: Date.UTC(2025, 0, 5), equity: 108.9, benchmark: 126, exposure: 0 }], 'month');
    expect(m.map((x) => x.period)).toEqual(['2024-01', '2024-02', '2025-01']);
    expect(m[0]!.return).toBeCloseTo(0.1, 12); expect(m[1]!.return).toBeCloseTo(-0.1, 12); expect(m[2]!.return).toBeCloseTo(0.1, 12);
    expect(m[0]!.benchmark).toBeCloseTo(0.05, 12); expect(m[1]!.benchmark).toBeCloseTo(0, 12); expect(m[2]!.benchmark).toBeCloseTo(0.2, 12);
    const y = periodReturns([s(0, 100), s(200, 90), { at: Date.UTC(2025, 5, 1), equity: 99, benchmark: null, exposure: 0 }], 'year');
    expect(y.map((x) => [x.period, Number(x.return.toFixed(12))])).toEqual([['2024', -0.1], ['2025', 0.1]]);
  });
  it('直方图边界与退出原因计数', () => {
    expect(histogram([-1, -0.15, 0, 0.01, 5], [-0.2, -0.1, 0, 0.1]).counts).toEqual([2, 0, 3]);
    const st = tradeStats([t(1, 0.01, 1, 1, 'trail'), t(-1, -0.03, 2, 40, 'stop'), t(1, 0.3, 3, 1000, 'trail')])!;
    expect(st.exit_reasons).toEqual({ trail: 2, stop: 1 }); expect(st.long_trades).toBe(3); expect(st.short_trades).toBe(0);
    expect(st.holding_histogram.counts.reduce((a, b) => a + b, 0)).toBe(3); expect(st.holding_histogram.counts.at(-1)).toBe(1);
    expect(tradeStats([])).toBeNull();
  });
});
describe('Horizon 诊断口径(多空 / 退出原因盈亏 / 日盈亏 / 资金使用 / 容量)', () => {
  it('手算小例子', () => {
    const trades = [t(10, 0.1, 1, 2, 'trail'), t(-6, -0.06, 2, 1, 'stop'), t(-4, -0.02, 3, 1, 'stop')];
    const sb = sideBreakdown(trades);
    expect(sb.long).toEqual({ trades: 3, total_pnl: 0, win_rate: 1 / 3, avg_return: (0.1 - 0.06 - 0.02) / 3 });
    expect(sb.short).toEqual({ trades: 0, total_pnl: 0, win_rate: null, avg_return: null });
    expect(tradeStats(trades)!.pnl_by_exit_reason).toEqual({ trail: { count: 1, pnl: 10, avg_return: 0.1 }, stop: { count: 2, pnl: -10, avg_return: -0.04 } });
    expect(dailyPnl([s(0, 100), s(1, 110), s(2, 99)]).map((x) => [x.day, Number(x.pnl_pct.toFixed(12))])).toEqual([['2024-01-01', 0], ['2024-01-02', 0.1], ['2024-01-03', -0.1]]);
    expect(dailyPnl(Array.from({ length: 4000 }, (_, i) => s(i, 100 + i)))).toHaveLength(3000);
    const cu = capitalUsage([s(0, 100, null, 0), s(1, 100, null, 0.5), { ...s(2, 100, null, 0.2), positions: 2 }, s(3, 100, null, 0)])!;
    expect(cu).toEqual({ avg_exposure: 0.7 / 4, max_exposure: 0.5, time_in_market: 0.5, avg_concurrent_positions: 3 / 4, idle_fraction: 0.5 });
    // 中位成交额 1000(close×volume),平均入场占净值 25% ⇒ 容量 = 1000 × 1% / 0.25 = 40
    const cap = strategyCapacity([500, 1000, 3000], [{ at: T0 + D, notional: 25 }, { at: T0 + 3 * D, notional: 30 }], [s(0, 100), s(1, 100), s(2, 120)]);
    expect(cap.median_bar_quote_volume).toBe(1000); expect(cap.avg_entry_fraction).toBeCloseTo((0.25 + 0.25) / 2, 12); expect(cap.capacity_usd).toBeCloseTo(40, 9);
    expect(strategyCapacity([1000], [], [s(0, 100)]).capacity_usd).toBeNull();
  });
});
describe('Horizon 式评分', () => {
  const base = analyze([s(0, 100, 100), s(1, 110, 105)], [t(10, 0.1, 1)], 1);
  it('没有交易直接 0 分 poor;confidence 按笔数', () => {
    const z = score({ ...base, trades: 0 }, { in_sample: null, out_of_sample: null }, null);
    expect(z.value).toBe(0); expect(z.label).toBe('poor'); expect(z.confidence_reason).toBe('Low confidence, 0 trades');
    expect(confidenceOf(1)).toEqual({ confidence: 'low', confidence_reason: 'Low confidence, 1 trade' });
    expect(confidenceOf(12).confidence).toBe('medium'); expect(confidenceOf(30).confidence_reason).toBe('High confidence, 30 trades');
  });
  it('分项与权重确定性,手算加总', () => {
    // sharpe 1 → 50;回撤 10% → 80;PF 1.5 → 50;年化超额 +10% → 75;oos/is = 0.5 → 50;期望 +1% → 75
    const m = { ...base, sharpe: 1, max_drawdown: 0.1, profit_factor: 1.5, cagr: 0.2, expectancy: 0.01, trades: 40 };
    const sc = score(m, { in_sample: { ...m, cagr: 0.2 }, out_of_sample: { ...m, cagr: 0.1 } }, 0.1);
    const expected = 0.25 * 50 + 0.2 * 80 + 0.15 * 50 + 0.15 * 75 + 0.15 * 50 + 0.1 * 75;
    expect(sc.value).toBe(Math.round(expected)); expect(sc.components.map((c) => c.key)).toEqual(['risk_adjusted', 'drawdown', 'profit_factor', 'vs_hold', 'oos_stability', 'expectancy']);
    expect(sc.components.reduce((a, c) => a + c.weight, 0)).toBeCloseTo(1, 12); expect(sc.confidence).toBe('high');
    expect(sc.label).toBe(scoreLabel(sc.value));
    expect([80, 65, 50, 35, 34].map(scoreLabel)).toEqual(['excellent', 'good', 'fair', 'needs_work', 'poor']);
  });
});
describe('净值降采样', () => {
  it('≤1000 点,首尾与全局极值保留,时间单调', () => {
    const pts = Array.from({ length: 20000 }, (_, i) => ({ at: i, equity: 100 + Math.sin(i / 50) * 10 + (i === 12345 ? -80 : 0) + (i === 777 ? 90 : 0) }));
    const d = downsample(pts, 1000);
    expect(d.length).toBeLessThanOrEqual(1000); expect(d[0]).toBe(pts[0]); expect(d.at(-1)).toBe(pts.at(-1));
    expect(d.some((p) => p.at === 12345)).toBe(true); expect(d.some((p) => p.at === 777)).toBe(true);
    expect(d.every((p, i) => i === 0 || p.at > d[i - 1]!.at)).toBe(true);
    expect(downsample(pts.slice(0, 10), 1000)).toHaveLength(10);
  });
});
describe('稳健中心:平均旁边给中位数与截尾均值(两端各截 10%)', () => {
  it('手算:20 个值两端各截 2 个;一簇大赚撑起均值时 tailDriven=up', async () => {
    const { centerStats, tailDriven, centerText } = await import('../../../src/demo/research/analyzer.js');
    // 16 笔各亏 1%,4 笔各赚 10%:均值 +1.2%,中位 −1%,截尾(去掉最小 2 个 −1% 与最大 2 个 +10%)= (14×−1 + 2×10)/16 = +0.375%
    const xs = [...Array(16).fill(-0.01), ...Array(4).fill(0.1)];
    const c = centerStats(xs);
    expect(c.n).toBe(20); expect(c.trimmed_each_side).toBe(2);
    expect(c.mean).toBeCloseTo(0.012, 12); expect(c.median).toBeCloseTo(-0.01, 12); expect(c.trimmed_mean).toBeCloseTo((14 * -0.01 + 2 * 0.1) / 16, 12);
    expect(tailDriven(c)).toBe('up');
    expect(c.basis).toBe('两端各截 2 笔(20 笔 × 10% 向下取整)');
    expect(centerText(c, (v) => (v === null ? '—' : v.toFixed(3)))).toBe('均值 0.012、中位数 -0.010、截尾均值 0.004(两端各截 2 笔(20 笔 × 10% 向下取整))');
  });
  it('不足 10 笔不截尾(截尾均值 = 均值);偶数个中位数取中间两个均值;空输入全 null', async () => {
    const { centerStats } = await import('../../../src/demo/research/analyzer.js');
    const c = centerStats([0.03, -0.01, 0.02, 0.1]);
    expect(c.trimmed_each_side).toBe(0); expect(c.trimmed_mean).toBeCloseTo(c.mean!, 12); expect(c.median).toBeCloseTo(0.025, 12);
    expect(c.basis).toBe('笔数 4 < 10,不截尾,截尾均值 = 均值');
    const ten = centerStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 100]);
    expect(ten.trimmed_each_side).toBe(1); expect(ten.trimmed_mean).toBeCloseTo(5.5, 12); expect(ten.median).toBeCloseTo(5.5, 12); expect(ten.mean).toBeCloseTo(14.5, 12);
    const none = centerStats([]);
    expect([none.mean, none.median, none.trimmed_mean]).toEqual([null, null, null]);
    expect(centerStats([Number.NaN, 1]).n).toBe(1);
  });
  it('tailDriven:均值为负而中位与截尾都为正 → down;方向一致 → null', async () => {
    const { centerStats, tailDriven } = await import('../../../src/demo/research/analyzer.js');
    expect(tailDriven(centerStats([...Array(18).fill(-0.01), 0.02, 0.02]))).toBe(null); // 均值、中位、截尾全为负:方向一致
    expect(tailDriven(centerStats([...Array(18).fill(0.01), -0.3, -0.3]))).toBe('down');
    expect(tailDriven(centerStats([0.01, 0.02, 0.03]))).toBe(null);
  });
});
