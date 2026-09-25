// 判断回放账户折算(account.ts,口径照搬 scripts/research-judgment/account-pnl.py):手算小例子钉住每一条仓位规则。
import { describe, expect, it } from 'vitest';
import { ACCOUNT_RULES, accountPeriod, accountRow, holdReturn } from '../../../../src/demo/research/judgment-replay/account.js';
import type { Bar, JrEvent, SettleOut } from '../../../../src/demo/research/judgment-replay/types.js';

const H = 3_600_000;
const so = (o: Partial<SettleOut>): SettleOut => ({ management: 'trail', status: 'trail', fill: 100, exit_price: 100, bars_held: 1, gross_r: 0, net_r: 0, funding_r: 0, funding_estimated: false, note: '', ...o });
const ev = (id: string, hour: number, stop: number, net_r: number, bars_held: number, o: Partial<JrEvent> = {}, status = 'trail'): JrEvent =>
  ({ id, venue: 'spot', symbol: 'BTCUSDT', period: 'p', as_of: hour * H, direction: 'long', kind: 'x', hits: [], ref_close: 100, atr14: 1, stop, stop_source: 's', stop_atr: 1, target: null, trend_ok: true, trail: so({ net_r, bars_held, status }), plan: so({ management: 'plan', net_r, bars_held, status }), ...o }) as JrEvent;

// e1 止损 2%:名义 5000,赚 2R=+200,10h 后平;e2 止损 0.5%:按风险名义 20000 → 压到权益 10000,现货总名义超了跳过、永续 3 倍内开仓(亏 1R × 名义比例 1/2 = −50);
// e3 在 e1 平仓后开,风险按平仓后的权益算;e4 no_fill 不开仓。
const events = [ev('e1', 0, 98, 2, 10), ev('e2', 1, 99.5, -1, 3), ev('e3', 12, 95, -1, 5), ev('e4', 13, 98, 5, 5, {}, 'no_fill')];

describe('账户折算:每笔风险 1%、$10k 起、满仓跳过、复利', () => {
  it('现货:总名义不超过权益,满仓跳过;风险按已实现权益复利', () => {
    const r = accountPeriod(events, () => true, 'trail', 'spot', 'p');
    expect(r.trades).toBe(2);
    expect(r.skipped_full).toBe(1);
    expect(r.end_equity).toBeCloseTo(10_000 + 200 - 102, 9); // e3 风险 = 10200 × 1% = 102
    expect(r.return).toBeCloseTo(0.0098, 12);
    expect(r.max_drawdown).toBeCloseTo(1 - 10_098 / 10_200, 12);
  });
  it('永续:总名义上限 3 倍权益;单笔名义仍不超过权益,盈亏按名义比例缩小;平仓按时间先后入账', () => {
    const r = accountPeriod(events, () => true, 'trail', 'perp', 'p');
    expect(r.trades).toBe(3);
    expect(r.skipped_full).toBe(0);
    // e2(4h 平,−50)先入账 → 9950,e1(10h 平,+200)→ 10150,e3 风险 101.5 亏 1R → 10048.5
    expect(r.end_equity).toBeCloseTo(10_048.5, 9);
    expect(r.max_drawdown).toBeCloseTo(Math.max(1 - 9_950 / 10_000, 1 - 10_048.5 / 10_150), 12);
  });
  it('follow 决定做不做;管仓口径取对应结算;同一时刻按事件 id 先到先得(与输入顺序无关)', () => {
    expect(accountPeriod(events, (e) => e.id !== 'e1', 'trail', 'spot', 'p').trades).toBe(2); // 没有 e1 占仓,e2 能开
    const big = [ev('b', 0, 99, 1, 5), ev('a', 0, 99, -1, 5)]; // 各按风险要 10000 → 压到 10000;现货只能开一笔
    const x = accountPeriod(big, () => true, 'plan', 'spot', 'p'), y = accountPeriod([...big].reverse(), () => true, 'plan', 'spot', 'p');
    expect(x).toEqual(y);
    expect(x.end_equity).toBeCloseTo(10_000 - 100, 9); // 'a' 先开(亏 1R),'b' 满仓跳过
    expect(accountPeriod([ev('b', 0, 90, 1, 5), ev('a', 0, 80, -1, 5)], () => true, 'plan', 'spot', 'p').trades).toBe(2); // 名义 1000 + 500 < 权益,都能开
  });
  it('按行情段分开算,各自从 $10k 起;持有对照 = 末根收盘 / 首根开盘 − 1 的等权平均', () => {
    const two = [ev('x', 0, 98, 1, 1, { period: 'p1' }), ev('y', 0, 98, -1, 1, { period: 'p2' })];
    const row = accountRow('A', two, () => true, 'trail', 'spot', [{ id: 'p1' }, { id: 'p2' }]);
    expect(row.periods.map((p) => p.end_equity)).toEqual([10_100, 9_900]);
    const bar = (t: number, o: number, c: number): Bar => ({ open_time: t, close_time: t + H - 1, available_at: t + H - 1, open: String(o), high: String(Math.max(o, c)), low: String(Math.min(o, c)), close: String(c), volume: '1' });
    const h = holdReturn([{ symbol: 'A', bars: [bar(0, 100, 105), bar(H, 105, 120)] }, { symbol: 'B', bars: [bar(0, 50, 50), bar(H, 50, 40)] }, { symbol: 'C', bars: [] }], { from: 0, to: 2 * H });
    expect(h.symbols).toBe(2);
    expect(h.return).toBeCloseTo((0.2 + -0.2) / 2, 12);
  });
  it('仓位规则说明写全:1% 风险、$10k、满仓跳过、永续 3 倍、不是实盘账户', () => {
    const text = ACCOUNT_RULES.join('\n');
    for (const k of ['$10,000', '1%', '满仓跳过', '3 × 权益', '不是实盘账户', 'account-pnl.py']) expect(text).toContain(k);
  });
});
