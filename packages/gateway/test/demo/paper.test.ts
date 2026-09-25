// execution.ts: PaperBackend, the in-process simulator (docs/demo/README.md §5 item 8). No
// network, no child process — this is the pure in-memory execution path. v2: limit entries rest
// and fill via tick(), same-side entries average into the position, opposite-side entries reduce
// it, prices/qtys are plain Number.toString() (no fixed decimals), and tick() returns structured
// PaperEvent[] instead of log strings.

import { beforeEach, describe, expect, it } from 'vitest';
import { PaperBackend } from '../../src/demo/execution.js';

const SYMBOL = 'BTCUSDT';
const FEE_RATE = 0.0004;

let backend: PaperBackend;

beforeEach(() => {
  backend = new PaperBackend(10_000);
});

describe('PaperBackend: entry', () => {
  it('fills at the current mark price and charges the fee against the wallet', async () => {
    backend.setMark(SYMBOL, '50000');
    const r = await backend.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '0.1', entry: 'market', limit_price: null, client_order_id: 'c1' });
    expect(r.outcome).toBe('filled');
    expect(r.avg_price).toBe('50000');

    const acct = await backend.account();
    const expectedFee = 50000 * 0.1 * FEE_RATE;
    expect(Number(acct.available)).toBeCloseTo(10_000 - expectedFee, 6);
    expect(acct.positions).toHaveLength(1);
    expect(acct.positions[0]).toMatchObject({ symbol: SYMBOL, side: 'long', qty: '0.1', entry_price: '50000' });
  });

  it('fails with no receipt when no mark price has been set yet', async () => {
    const r = await backend.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '0.1', entry: 'market', limit_price: null, client_order_id: 'c1' });
    expect(r.outcome).toBe('failed');
    expect(r.error).toMatch(/no mark price/);
  });

  it('fails when a limit entry has no limit_price', async () => {
    backend.setMark(SYMBOL, '50000');
    const r = await backend.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '0.1', entry: 'limit', limit_price: null, client_order_id: 'c1' });
    expect(r.outcome).toBe('failed');
    expect(r.error).toMatch(/limit price required/);
  });

  it('a limit entry that already crosses the mark fills immediately', async () => {
    backend.setMark(SYMBOL, '50000');
    // long limit at 51000 crosses immediately because mark (50000) <= price (51000)
    const r = await backend.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '0.1', entry: 'limit', limit_price: '51000', client_order_id: 'c1' });
    expect(r.outcome).toBe('filled');
    expect(r.avg_price).toBe('50000');
    const acct = await backend.account();
    expect(acct.open_orders).toHaveLength(0);
  });

  it('a limit entry that does not cross rests as a NEW order and does not fill', async () => {
    backend.setMark(SYMBOL, '50000');
    const r = await backend.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '0.1', entry: 'limit', limit_price: '49000', client_order_id: 'c1' });
    expect(r.outcome).toBe('submitted');
    expect(r.avg_price).toBeNull();
    const acct = await backend.account();
    expect(acct.positions).toHaveLength(0);
    expect(acct.open_orders).toHaveLength(1);
    expect(acct.open_orders[0]).toMatchObject({ type: 'LIMIT', price: '49000', status: 'NEW' });
  });

  it('a resting limit long fills via tick when mark drops to or below the limit price, emitting entry_filled', async () => {
    backend.setMark(SYMBOL, '50000');
    await backend.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '0.1', entry: 'limit', limit_price: '49000', client_order_id: 'c1' });

    const noEvents = backend.tick(SYMBOL, '49500');
    expect(noEvents).toEqual([]); // still above the limit price

    const events = backend.tick(SYMBOL, '48999');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'entry_filled', symbol: SYMBOL, client_order_id: 'c1', price: '49000', realized_pnl: null });
    expect(events[0]!.message).toMatch(/限价入场成交 @ 49000/);

    const acct = await backend.account();
    expect(acct.positions).toHaveLength(1);
    expect(acct.positions[0]).toMatchObject({ side: 'long', qty: '0.1', entry_price: '49000' });
    expect(acct.open_orders).toHaveLength(0);
  });

  it('a second entry on the same side averages into the existing position', async () => {
    backend.setMark(SYMBOL, '50000');
    await backend.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '1', entry: 'market', limit_price: null, client_order_id: 'c1' });
    backend.setMark(SYMBOL, '52000');
    const r2 = await backend.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '1', entry: 'market', limit_price: null, client_order_id: 'c2' });
    expect(r2.outcome).toBe('filled');

    const acct = await backend.account();
    expect(acct.positions).toHaveLength(1);
    expect(acct.positions[0]!.qty).toBe('2');
    expect(acct.positions[0]!.entry_price).toBe('51000'); // (50000*1 + 52000*1) / 2
  });

  it('an opposite-side entry reduces the existing position instead of flipping it', async () => {
    backend.setMark(SYMBOL, '50000');
    await backend.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '2', entry: 'market', limit_price: null, client_order_id: 'c1' });
    backend.setMark(SYMBOL, '51000');
    const r2 = await backend.placeEntry({ symbol: SYMBOL, direction: 'short', qty: '1', entry: 'market', limit_price: null, client_order_id: 'c2' });
    expect(r2.outcome).toBe('filled');

    const acct = await backend.account();
    expect(acct.positions).toHaveLength(1);
    expect(acct.positions[0]).toMatchObject({ side: 'long', qty: '1', entry_price: '50000' }); // entry unchanged, only qty reduced
  });
});

describe('PaperBackend: protective orders', () => {
  it('placeStop and placeTakeProfit both list in account().open_orders', async () => {
    backend.setMark(SYMBOL, '50000');
    await backend.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '1', entry: 'market', limit_price: null, client_order_id: 'c1' });
    await backend.placeStop(SYMBOL, 'long', '49000', 's1');
    await backend.placeTakeProfit(SYMBOL, 'long', '52000', 't1');

    const acct = await backend.account();
    expect(acct.open_orders).toHaveLength(2);
    const stop = acct.open_orders.find((o) => o.client_order_id === 's1')!;
    const tp = acct.open_orders.find((o) => o.client_order_id === 't1')!;
    expect(stop).toMatchObject({ type: 'STOP_MARKET', side: 'SELL', stop_price: '49000', reduce_only: true });
    expect(tp).toMatchObject({ type: 'TAKE_PROFIT_MARKET', side: 'SELL', stop_price: '52000', reduce_only: true });
  });

  it('cancelAll clears the open orders for the symbol', async () => {
    backend.setMark(SYMBOL, '50000');
    await backend.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '1', entry: 'market', limit_price: null, client_order_id: 'c1' });
    await backend.placeStop(SYMBOL, 'long', '49000', 's1');
    const res = await backend.cancelAll(SYMBOL);
    expect(res.ok).toBe(true);
    const acct = await backend.account();
    expect(acct.open_orders).toHaveLength(0);
  });
});

describe('PaperBackend: tick triggers', () => {
  it('a long stop triggers when mark drops to or below the stop price, closing the position at the stop price', async () => {
    backend.setMark(SYMBOL, '50000');
    await backend.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '1', entry: 'market', limit_price: null, client_order_id: 'c1' });
    await backend.placeStop(SYMBOL, 'long', '49000', 's1');
    await backend.placeTakeProfit(SYMBOL, 'long', '52000', 't1');

    const entryFee = 50000 * 1 * FEE_RATE;
    const closePnl = (49000 - 50000) * 1 - 49000 * 1 * FEE_RATE;

    const events = backend.tick(SYMBOL, '48999');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'sl_hit', symbol: SYMBOL, client_order_id: 's1', price: '49000', realized_pnl: closePnl.toFixed(2) });
    expect(events[0]!.message).toMatch(/止损触发 @ 49000/);

    const acct = await backend.account();
    expect(acct.positions).toHaveLength(0);
    expect(acct.open_orders).toHaveLength(0); // protective orders cleared with the position
    expect(Number(acct.available)).toBeCloseTo(10_000 - entryFee + closePnl, 6);
  });

  it('a long take-profit triggers when mark rises to or above the tp price', async () => {
    backend.setMark(SYMBOL, '50000');
    await backend.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '1', entry: 'market', limit_price: null, client_order_id: 'c1' });
    await backend.placeStop(SYMBOL, 'long', '49000', 's1');
    await backend.placeTakeProfit(SYMBOL, 'long', '52000', 't1');

    const events = backend.tick(SYMBOL, '52500');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'tp_hit', symbol: SYMBOL, client_order_id: 't1', price: '52000' });
    expect(events[0]!.message).toMatch(/止盈触发 @ 52000/);

    const acct = await backend.account();
    expect(acct.positions).toHaveLength(0);
  });

  it('no trigger, no event, when mark stays between stop and tp', () => {
    backend.setMark(SYMBOL, '50000');
    const events = backend.tick(SYMBOL, '50500');
    expect(events).toEqual([]);
  });

  it('getOrder returns NEW for a resting order, then FILLED after tick fills it', async () => {
    backend.setMark(SYMBOL, '50000');
    await backend.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '0.1', entry: 'limit', limit_price: '49000', client_order_id: 'c1' });
    const before = await backend.getOrder(SYMBOL, 'c1');
    expect(before).toMatchObject({ status: 'NEW' });

    backend.tick(SYMBOL, '48999');
    const after = await backend.getOrder(SYMBOL, 'c1');
    expect(after).toMatchObject({ status: 'FILLED', avg_price: '49000' });
  });
});

describe('PaperBackend: cancelOrder', () => {
  it('cancels a resting order and getOrder reports CANCELED afterwards', async () => {
    backend.setMark(SYMBOL, '50000');
    await backend.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '0.1', entry: 'limit', limit_price: '49000', client_order_id: 'c1' });
    const res = await backend.cancelOrder(SYMBOL, 'c1');
    expect(res.ok).toBe(true);

    const acct = await backend.account();
    expect(acct.open_orders).toHaveLength(0);
    const status = await backend.getOrder(SYMBOL, 'c1');
    expect(status).toMatchObject({ status: 'CANCELED' });
  });

  it('fails with an error when the order does not exist', async () => {
    const res = await backend.cancelOrder(SYMBOL, 'nope');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/);
  });
});

describe('PaperBackend: closePosition / reducePosition', () => {
  it('closePosition realizes PnL at the current mark and empties the position', async () => {
    backend.setMark(SYMBOL, '50000');
    await backend.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '1', entry: 'market', limit_price: null, client_order_id: 'c1' });
    backend.setMark(SYMBOL, '51000');
    const r = await backend.closePosition(SYMBOL, 'x1');
    expect(r.closed).toBe(true);

    const acct = await backend.account();
    expect(acct.positions).toHaveLength(0);
    const entryFee = 50000 * 1 * FEE_RATE;
    const closePnl = (51000 - 50000) * 1 - 51000 * 1 * FEE_RATE;
    expect(Number(acct.available)).toBeCloseTo(10_000 - entryFee + closePnl, 6);
  });

  it('closePosition on a symbol with no position is a no-op (closed: false)', async () => {
    const r = await backend.closePosition(SYMBOL, 'x1');
    expect(r.closed).toBe(false);
  });

  it('reducePosition halves the position and realizes PnL on only the reduced portion', async () => {
    backend.setMark(SYMBOL, '50000');
    await backend.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '2', entry: 'market', limit_price: null, client_order_id: 'c1' });
    backend.setMark(SYMBOL, '51000');
    const r = await backend.reducePosition(SYMBOL, '1', 'r1');
    expect(r.outcome).toBe('filled');

    const acct = await backend.account();
    expect(acct.positions).toHaveLength(1);
    expect(acct.positions[0]!.qty).toBe('1');
  });
});

describe('PaperBackend: account view', () => {
  it('equity = wallet(available) + unrealized pnl, while a position is open', async () => {
    backend.setMark(SYMBOL, '50000');
    await backend.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '1', entry: 'market', limit_price: null, client_order_id: 'c1' });
    backend.setMark(SYMBOL, '52000');

    const acct = await backend.account();
    expect(acct.unrealized_pnl).toBe('2000.00');
    const entryFee = 50000 * 1 * FEE_RATE;
    expect(Number(acct.available)).toBeCloseTo(10_000 - entryFee, 6);
    expect(Number(acct.equity)).toBeCloseTo(Number(acct.available) + 2000, 6);
  });

  it('equity = wallet, unrealized_pnl = 0, when flat', async () => {
    const acct = await backend.account();
    expect(acct.unrealized_pnl).toBe('0.00');
    expect(acct.equity).toBe(acct.available);
    expect(acct.equity).toBe('10000.00');
  });
});

describe('PaperBackend: setLeverage', () => {
  it('affects the leverage shown on a position opened afterwards', async () => {
    backend.setMark(SYMBOL, '50000');
    await backend.setLeverage(SYMBOL, 10);
    await backend.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '0.1', entry: 'market', limit_price: null, client_order_id: 'c1' });
    const acct = await backend.account();
    expect(acct.positions[0]!.leverage).toBe(10);
  });

  it('defaults to 3x when leverage was never set', async () => {
    backend.setMark(SYMBOL, '50000');
    await backend.placeEntry({ symbol: SYMBOL, direction: 'long', qty: '0.1', entry: 'market', limit_price: null, client_order_id: 'c1' });
    const acct = await backend.account();
    expect(acct.positions[0]!.leverage).toBe(3);
  });
});

describe('PaperBackend: symbols', () => {
  it('returns the built-in symbol list including BTCUSDT with trading rules', async () => {
    const list = await backend.symbols();
    expect(list.length).toBeGreaterThanOrEqual(20);
    const btc = list.find((s) => s.symbol === 'BTCUSDT')!;
    expect(btc).toMatchObject({ symbol: 'BTCUSDT', status: 'TRADING' });
    expect(typeof btc.step_size).toBe('string');
    expect(typeof btc.min_notional).toBe('string');
  });

  it('symbolRules returns the rules for a known symbol and a sane default for an unknown one', async () => {
    const btc = await backend.symbolRules('BTCUSDT');
    expect(btc).toMatchObject({ step_size: '0.001', tick_size: '0.1', min_qty: '0.001', min_notional: '5' });
    const unknown = await backend.symbolRules('NOPEUSDT');
    expect(unknown).toMatchObject({ step_size: '0.001', tick_size: '0.01', min_qty: '0.001', min_notional: '5' });
  });
});

describe('PaperBackend: spot 现金账本', () => {
  it('买入扣全额 USDT,一倍杠杆;卖出返回本金及盈亏', async () => {
    backend.setMark(SYMBOL, '50000', 'spot');
    await backend.setLeverage(SYMBOL, 10);
    expect(backend.marketsSupported()).toEqual(['perp', 'spot']);
    expect((await backend.placeEntry({ market: 'spot', symbol: SYMBOL, direction: 'long', qty: '0.1', entry: 'market', limit_price: null, client_order_id: 'spot1' })).outcome).toBe('filled');
    const account = await backend.account();
    expect(account.positions[0]).toMatchObject({ market: 'spot', leverage: 1, side: 'long' });
    expect(Number(account.available)).toBeCloseTo(4998);
    expect(Number(account.equity)).toBeCloseTo(9998);
    backend.setMark(SYMBOL, '51000', 'spot');
    expect((await backend.closePosition(SYMBOL, 'close1', 'spot')).closed).toBe(true);
    expect(Number((await backend.account()).available)).toBeCloseTo(10095.96);
  });

  it('现货拒绝做空且与同币永续持仓隔离', async () => {
    backend.setMark(SYMBOL, '50000', 'spot');
    backend.setMark(SYMBOL, '50100');
    const base = { symbol: SYMBOL, qty: '0.01', entry: 'market' as const, limit_price: null, client_order_id: 'p1' };
    expect(await backend.placeEntry({ ...base, market: 'spot', direction: 'short' })).toMatchObject({ outcome: 'failed', error: 'spot_no_short' });
    await backend.placeEntry({ ...base, direction: 'short' });
    await backend.placeEntry({ ...base, market: 'spot', direction: 'long', client_order_id: 's1' });
    expect((await backend.account()).positions).toHaveLength(2);
    await backend.closePosition(SYMBOL, 'sclose', 'spot');
    expect((await backend.account()).positions).toMatchObject([{ market: 'perp', side: 'short' }]);
  });

  it('现货余额不足不允许借钱买入', async () => {
    backend.setMark(SYMBOL, '50000', 'spot');
    expect((await backend.placeEntry({ market: 'spot', symbol: SYMBOL, direction: 'long', qty: '1', entry: 'market', limit_price: null, client_order_id: 'excess' })).outcome).toBe('failed');
    expect((await backend.account()).positions).toHaveLength(0);
  });
});

describe('PaperBackend: spot/perp 保护隔离', () => {
  it('同币双市场止损互不借用,现货 tick 只卖出现货', async () => {
    const open = { symbol: SYMBOL, direction: 'long' as const, qty: '0.01', entry: 'market' as const, limit_price: null };
    backend.setMark(SYMBOL, '50000', 'spot'); backend.setMark(SYMBOL, '51000', 'perp');
    await backend.placeEntry({ ...open, market: 'spot', client_order_id: 'spot-e' });
    await backend.placeEntry({ ...open, market: 'perp', client_order_id: 'perp-e' });
    await backend.placeStop(SYMBOL, 'long', '49000', 'spot-s', 'spot');
    await backend.placeStop(SYMBOL, 'long', '49500', 'perp-s', 'perp');
    expect((await backend.account()).open_orders).toEqual(expect.arrayContaining([
      expect.objectContaining({ market: 'spot', client_order_id: 'spot-s' }),
      expect.objectContaining({ market: 'perp', client_order_id: 'perp-s' }),
    ]));
    const events = backend.tick(SYMBOL, '48900', 'spot');
    expect(events).toMatchObject([{ market: 'spot', kind: 'sl_hit' }]);
    const a = await backend.account();
    expect(a.positions).toMatchObject([{ market: 'perp', qty: '0.01' }]);
    expect(a.open_orders).toMatchObject([{ market: 'perp', client_order_id: 'perp-s' }]);
  });
});

describe('spot realized PnL reconciles cash ledger', () => {
  it('两次退出按比例分摊入场手续费,累计回执盈亏等于钱包变化', async () => {
    const before = backend.snapshot().wallet;
    backend.setMark(SYMBOL, '50000', 'spot');
    await backend.placeEntry({ symbol: SYMBOL, market: 'spot', direction: 'long', qty: '0.1', entry: 'market', limit_price: null, client_order_id: 'fee-entry' });
    backend.setMark(SYMBOL, '51000', 'spot');
    const partial = await backend.reducePosition(SYMBOL, '0.04', 'fee-partial', 'spot');
    backend.setMark(SYMBOL, '52000', 'spot');
    const closed = await backend.closePosition(SYMBOL, 'fee-final', 'spot');
    const receipts = Number((partial.receipt as { realizedPnl: string }).realizedPnl) + Number((closed.receipt as { realizedPnl: string }).realizedPnl);
    const after = backend.snapshot().wallet;
    expect(receipts).toBeCloseTo(after - before, 8);
    expect(receipts).toBeCloseTo(160 - 2 - 0.816 - 1.248, 8);
  });
});
