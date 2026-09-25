import { describe, it, expect } from 'vitest';
import { conservativeLimitFill, openTrade, tradeCosts, simulateOutcome } from '../../src/demo/outcome.js';
import type { Kline } from '../../src/demo/types.js';
import { replayJudgmentLeg } from '../../src/demo/backtest.js';
const bar: Kline = { open_time: 0, close_time: 999, open: '100', high: '102', low: '99', close: '101', volume: '100' };
describe('共享保守成交与成本', () => {
  it('触价不成交，穿过一个 tick 才成交，多空镜像', () => {
    expect(conservativeLimitFill('long', 99, bar, 0.1)).toBeNull();
    expect(conservativeLimitFill('long', 99.1, bar, 0.1)).toBe(99.1);
    expect(conservativeLimitFill('short', 102, bar, 0.1)).toBeNull();
    expect(conservativeLimitFill('short', 101.9, bar, 0.1)).toBe(101.9);
  });
  it('手续费和不利滑点按固定初始风险计 R', () => {
    const t = openTrade('long', 100, 98, 104)!;
    const c = tradeCosts(t, 104, 'market', 0, 1000, 2, [], { tick: 0.1 });
    expect(c.cost_r).toBeCloseTo((0.05 + 0.052 + 0.2) / 2);
    expect(tradeCosts(t, 104, 'limit', 0, 1000, 2, [], { tick: 0.1 }).cost_r).toBeCloseTo((0.02 + 0.052 + 0.1) / 2);
  });
  it('跨两次资金结算，一次历史一次估计；空头获得正费率', () => {
    const from = 1; const to = 2 * 28_800_000;
    const f = [{ at: 28_800_000, rate: '0.001' }];
    const long = tradeCosts(openTrade('long', 100, 98, null)!, 100, 'market', from, to, 0, f, { funding_mean: 0.002 });
    const short = tradeCosts(openTrade('short', 100, 102, null)!, 100, 'market', from, to, 0, f, { funding_mean: 0.002 });
    expect(long.funding_estimated).toBe(true);
    expect(long.cost_r - short.cost_r).toBeCloseTo(0.3);
  });
  it('限价成交根不能利用可能发生在成交前的高点止盈', () => {
    const result = simulateOutcome({ direction: 'long', entry: 'limit', limit_price: 100, stop: 95, tp: 105, bars: [{ ...bar, open: '104', high: '106', low: '99', close: '100' }] });
    expect(result.status).toBe('expired'); expect(result.gross_r).toBe(0);
  });
  it('日线开盘跳空退出，不计离场后当日资金费', () => {
    const day = 86400000;
    const bars = [{ ...bar, open: '100', high: '101', low: '99', close: '100', open_time: 1, close_time: day - 1 }, { ...bar, open: '89', high: '90', low: '88', close: '89', open_time: day, close_time: 2 * day - 1 }];
    const input = { direction: 'short' as const, entry: 'market' as const, limit_price: null, stop: 110, tp: 90, bars };
    const empty = simulateOutcome(input);
    const funded = simulateOutcome({ ...input, funding: [{ at: day + 28800000, rate: '0.01' }, { at: day + 57600000, rate: '0.01' }] });
    expect(funded.exit_at).toBe(day); expect(funded.net_r).toBe(empty.net_r);
  });
  it('净值低于毛值，双触碰先止损', () => {
    const r = simulateOutcome({ direction: 'long', entry: 'market', limit_price: null, stop: 99, tp: 102, bars: [bar], costs: { tick: 0.01 } });
    expect(r.status).toBe('stop'); expect(r.gross_r).toBe(-1); expect(r.net_r).toBeLessThan(-1);
  });
});

// 09-12 P1-12:回放腿的 null direction 要分「缺数据/未实现 → unknown」与「明确不入场 → flat」。
describe('replayJudgmentLeg 的 null direction', () => {
  const snapshot = { timeframe: '1h', last_close: 100, mark: 100, atr14: 2, swing_high_20: 105, swing_low_20: 95, ema20_1h: 100, ema50_1h: 100 };
  const bars: Kline[] = [
    { open_time: 0, close_time: 3_599_999, open: '100', high: '103', low: '99', close: '102', volume: '10' },
    { open_time: 3_600_000, close_time: 7_199_999, open: '102', high: '106', low: '101', close: '105', volume: '10' },
  ];

  it('明确不入场 = flat,记 0R', () => {
    const leg = replayJudgmentLeg(null, snapshot, bars, 2, [], { stance: 'flat' });
    expect(leg).toMatchObject({ stance: 'flat', r: 0, status: 'flat' });
  });

  it('缺数据 / 这条腿没跑出方向 = unknown,记 null(不记 0R)', () => {
    const leg = replayJudgmentLeg(null, snapshot, bars, 2, [], { stance: 'unknown' });
    expect(leg).toMatchObject({ stance: 'unknown', r: null, gross_r: null, status: 'unscoreable' });
  });

  it('不传 stance 时保持旧默认(flat),有方向就照常结算', () => {
    expect(replayJudgmentLeg(null, snapshot, bars, 2).stance).toBe('flat');
    expect(replayJudgmentLeg('long', snapshot, bars, 2).stance).toBe('direction');
  });

  it('horizon 数据不足时不编 0:r 为 null', () => {
    expect(replayJudgmentLeg(null, snapshot, bars.slice(0, 1), 2, [], { stance: 'unknown' })).toMatchObject({ r: null, status: 'unscoreable' });
  });
});
