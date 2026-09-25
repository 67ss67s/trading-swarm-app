// 4h 永续均线趋势 · 杠杆 × 组合仓位:持仓段切分、共享资金组合、截尾均值、持有基准、训练段选择规则(合成数据,只做工程验证)
import { describe, expect, it } from 'vitest';
import { episodes, trimmedMean, weightOf, simulatePortfolio, curveStats, tradeSummary, holdCurve, selectConfig, type UnitPath } from '../../../../src/demo/research/batch/perp-trend.js';

const H = 4 * 3600000, T0 = Date.UTC(2024, 0, 1);
const path = (symbol: string, eq: number[], ex: number[], mf = 0.25, bench?: number[]): UnitPath => ({ symbol, eligible: true, mf, at: eq.map((_, i) => T0 + i * H), equity: eq, exposure: ex, bench: bench ?? eq.map(() => 100) });

describe('持仓段与截尾均值', () => {
  it('episodes:参考点 = 段前一点,离场点 = 敞口回到 0 的第一点;期末仍持有标 open', () => {
    expect(episodes({ exposure: [0, 1, 1, 0, 0, 2, 2] })).toEqual([{ ref: 0, first: 1, last: 3, open: false }, { ref: 4, first: 5, last: 6, open: true }]);
    expect(episodes({ exposure: [0, 0, 0] })).toEqual([]);
  });
  it('trimmedMean 两端各去 10%(向下取整);少于 10 个不截', () => {
    const xs = [100, 1, 2, 3, 4, 5, 6, 7, 8, -100];
    expect(trimmedMean(xs)).toBeCloseTo(4.5);
    expect(trimmedMean([1, 2, 30])).toBeCloseTo(11);
    expect(trimmedMean([])).toBeNull();
  });
});

describe('仓位规则', () => {
  const sig = (s: string) => ({ A: 0.5, B: 1.0, C: null }[s] ?? null);
  it('equal = 1/N;equal_vt = 1/N × min(1, 50%/σ);inv_vol = (1/σ)/Σ(1/σ),σ 缺失的成员不进分母', () => {
    expect(weightOf('equal', 'A', 0, ['A', 'B', 'C'], sig)).toBeCloseTo(1 / 3);
    expect(weightOf('equal_vt', 'B', 0, ['A', 'B', 'C'], sig)).toBeCloseTo(0.5 / 3);
    expect(weightOf('equal_vt', 'A', 0, ['A', 'B', 'C'], sig)).toBeCloseTo(1 / 3);
    expect(weightOf('inv_vol', 'A', 0, ['A', 'B', 'C'], sig)).toBeCloseTo(2 / 3);
    expect(weightOf('inv_vol', 'B', 0, ['A', 'B', 'C'], sig)).toBeCloseTo(1 / 3);
    expect(weightOf('inv_vol', 'C', 0, ['A', 'B', 'C'], sig)).toBeCloseTo(1 / 3);
  });
});

describe('共享资金组合', () => {
  it('单资产一笔:保证金收益 = (E/E_ref − 1)/mf,按 w×权益缩放;强平只损失该笔保证金', () => {
    // 子账户 mf=0.25:1000 → 1100 表示保证金 250 赚 100 = +40%
    const a = path('A', [1000, 1000, 1050, 1100, 1100], [0, 0, 2, 2, 0]);
    const r = simulatePortfolio([a], 'equal', () => null, { initial: 10000 });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]!.ret_on_margin).toBeCloseTo(0.4);
    expect(r.equity.at(-1)).toBeCloseTo(14000);
    // 被强平:子账户 1000 → 750(整份保证金 250 没了)
    const b = path('B', [1000, 1000, 750, 750], [0, 0, 3, 0]);
    const q = simulatePortfolio([b], 'equal', () => null, { initial: 10000 });
    expect(q.trades[0]!.ret_on_margin).toBeCloseTo(-1);
    expect(q.equity.at(-1)).toBeCloseTo(0);
  });
  it('两资产等权:各 1/2 权益,敞口 = 名义/组合权益;现金不足时按可用现金下单并计数', () => {
    const a = path('A', [1000, 1000, 1000, 1000], [0, 0, 1, 0]), b = path('B', [1000, 1000, 1000, 1000], [0, 0, 1, 0]);
    const r = simulatePortfolio([a, b], 'equal', () => null, { initial: 10000 });
    // 子账户敞口 1 = 名义 1000 = 4 倍保证金(mf 0.25);组合各投 5000 保证金 → 名义 2×20000 / 10000 = 4
    expect(r.exposure[2]).toBeCloseTo(4);
    expect(r.cash_capped).toBe(0);
    const c = simulatePortfolio([a, b], 'equal_vt', () => 0.1, { initial: 10000, vtAnnual: 0.5 });
    expect(c.trades.map((t) => t.weight)).toEqual([0.5, 0.5]);
  });
  it('没有前视:新仓保证金按信号根收盘时的组合权益定', () => {
    const a = path('A', [1000, 1000, 2000, 2000, 2000], [0, 1, 1, 0, 0], 1), b = path('B', [1000, 1000, 1000, 1000, 1000], [0, 0, 0, 1, 0], 1);
    const r = simulatePortfolio([a, b], 'equal', () => null, { initial: 10000 });
    // A 在第 1 根入场 5000,第 2 根翻倍 → 组合 15000;B 的信号根是第 2 根,保证金 = 15000/2
    expect(r.trades.find((t) => t.symbol === 'B')!.margin).toBeCloseTo(7500);
  });
  it('curveStats / tradeSummary / holdCurve / selectConfig', () => {
    const st = curveStats([T0, T0 + 86400000, T0 + 2 * 86400000], [10000, 12000, 9000]);
    expect(st.total_return).toBeCloseTo(-0.1); expect(st.max_drawdown).toBeCloseTo(0.25); expect(st.pnl_usd).toBeCloseTo(-1000);
    const ts = tradeSummary([{ symbol: 'A', entry_at: 0, exit_at: 1, weight: 1, margin: 1, ret_on_margin: -1, pnl: -1, open: false, reason: 'liquidation' }, { symbol: 'A', entry_at: 2, exit_at: 3, weight: 1, margin: 1, ret_on_margin: 0.5, pnl: 0.5, open: false, reason: 'signal_exit' }]);
    expect(ts.liquidations).toBe(1); expect(ts.median).toBeCloseTo(-0.25); expect(ts.win_rate).toBe(0.5);
    const h = holdCurve([path('A', [1, 1, 1], [0, 0, 0], 1, [100, 110, 120]), path('B', [1, 1, 1], [0, 0, 0], 1, [100, 90, 80])], [T0, T0 + H, T0 + 2 * H]);
    expect(h).toEqual([1, 1, 1]);
    const rows = [{ id: 'a', train: { total_return: 3, max_drawdown: 0.5, trades: 100 } }, { id: 'b', train: { total_return: 1, max_drawdown: 0.3, trades: 100 } }, { id: 'c', train: { total_return: 2, max_drawdown: 0.34, trades: 10 } }];
    expect(selectConfig(rows).pick!.id).toBe('b');
    expect(selectConfig([rows[0]!]).pick!.id).toBe('a');
  });
});
