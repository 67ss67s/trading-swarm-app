/** 订单周期执行核穷举测试。每条注明对照的 8794 shadow.rs 测试/版本注释(REPLAY_ENGINE_VERSION=11)。 */
import { describe, it, expect } from 'vitest';
import { simulateOrders, entryLimitFill, stopFill, takeProfitFill, defaultExpiryBars, liquidationPrice, type OrderBar, type PlanIntent, type OrderExecParams, type Manager } from '../../../../src/demo/research/orders/index.js';
const H = 3600_000, T0 = Date.UTC(2026, 0, 1);
const bar = (i: number, o: number, h: number, l: number, c: number): OrderBar => ({ open_time: T0 + i * H, close_time: T0 + (i + 1) * H - 1, open: o, high: h, low: l, close: c, volume: 1 });
const flat = (n: number, p = 100) => Array.from({ length: n }, (_, i) => bar(i, p, p + 0.5, p - 0.5, p));
const intent = (o: Partial<PlanIntent> = {}): PlanIntent => ({ side: 'long', reason: 't', entry: { type: 'market', price: null, source: null, note: '' }, reference_price: 100, expiry_bars: 3, stop: { price: 95, source: 'atr', note: '' }, take_profits: [{ price: 110, size_pct: 1, source: 'rr', note: '' }], min_rr: null, ...o });
const limit = (price: number, o: Partial<PlanIntent> = {}) => intent({ entry: { type: 'limit', price, source: 'structure_support', note: '' }, stop: { price: price - 5, source: 'structure_support', note: '' }, ...o });
const P = (o: Partial<OrderExecParams> = {}): OrderExecParams => ({ symbol: 'BTCUSDT', market: 'spot', leverage: 1, timeframe_ms: H, initial_cash: 10000, taker_fee_rate: 0, maker_fee_rate: 0, slippage_bps: 0, ...o });
const run = (bars: OrderBar[], at: Record<number, PlanIntent>, o: Partial<OrderExecParams> = {}, manage?: Manager) => simulateOrders(bars, bars.map((_, i) => at[i] ?? null), P(o), manage);
const set = (bars: OrderBar[], i: number, o: number, h: number, l: number, c: number) => { bars[i] = bar(i, o, h, l, c); return bars; };

describe('fills(8794 v9 entry_limit_fill / stop_fill / take_profit_fill)', () => {
  const b = bar(0, 100, 105, 95, 101);
  it('limit: touch fills at limit, open through limit fills at better open (gap), untouched is null', () => {
    expect(entryLimitFill(b, 97, 'long')).toEqual({ price: 97, gap: false });
    expect(entryLimitFill(b, 102, 'long')).toEqual({ price: 100, gap: true });
    expect(entryLimitFill(b, 94, 'long')).toBeNull();
    expect(entryLimitFill(b, 103, 'short')).toEqual({ price: 103, gap: false });
    expect(entryLimitFill(b, 98, 'short')).toEqual({ price: 100, gap: true });
  });
  it('stop is a market order: gap fills at the worse open; TP is a limit: gap fills at the better open', () => {
    expect(stopFill(b, 96, 'long')).toEqual({ price: 96, gap: false });
    expect(stopFill(b, 101, 'long')).toEqual({ price: 100, gap: true });
    expect(stopFill(b, 99, 'short')).toEqual({ price: 100, gap: true });
    expect(takeProfitFill(b, 99, 'long')).toEqual({ price: 100, gap: true });
    expect(takeProfitFill(b, 104, 'long')).toEqual({ price: 104, gap: false });
    expect(takeProfitFill(b, 101, 'short')).toEqual({ price: 100, gap: true });
    expect(takeProfitFill(b, 94, 'short')).toBeNull();
  });
  it('entry expiry tiers follow 8794 tiered_expiry_hours 24/48/72h', () => {
    expect(defaultExpiryBars(15 * 60_000)).toBe(96); expect(defaultExpiryBars(H)).toBe(24); expect(defaultExpiryBars(2 * H)).toBe(24);
    expect(defaultExpiryBars(4 * H)).toBe(18); expect(defaultExpiryBars(24 * H)).toBe(3);
  });
  it('isolated liquidation price', () => { expect(liquidationPrice(100, 10, 0.004, 'long')).toBeCloseTo(90.4, 9); expect(liquidationPrice(100, 10, 0.004, 'short')).toBeCloseTo(109.6, 9); });
});

describe('entry lifecycle', () => {
  it('market entry fills next bar open (8794 market_entry_fills_next_bar_open)', () => {
    const bars = set(flat(6), 1, 101, 101.5, 100.5, 101);
    const r = run(bars, { 0: intent() });
    expect(r.plans[0]).toMatchObject({ status: 'filled', filled_at: bars[1]!.open_time, fill_price: 101, fill_gap: false, placed_at: bars[0]!.close_time });
    expect(r.plans[0]!.exit!.reason).toBe('open');
  });
  it('limit fill then TP: positive R = (tp-entry)/(entry-sl) (8794 limit_fill_then_tp_exit_positive_r)', () => {
    const bars = flat(8); set(bars, 2, 100, 100.5, 97.5, 99); set(bars, 4, 100, 111, 99.5, 110);
    const r = run(bars, { 0: limit(98, { stop: { price: 94, source: 'structure_support', note: '' } }) });
    const p = r.plans[0]!;
    expect(p).toMatchObject({ status: 'filled', fill_price: 98, entry_type: 'limit', entry_price: 98 });
    expect(p.exit).toMatchObject({ reason: 'tp', price: 110 });
    expect(p.r_multiple).toBeCloseTo(12 / 4, 9); expect(p.planned_rr).toBeCloseTo(12 / 4, 9);
    expect(r.trades).toHaveLength(1); expect(r.trades[0]!.return_pct).toBeCloseTo(110 / 98 - 1, 9);
  });
  it('limit never touched within its window is no_fill; still inside window at data end is pending (8794 no_fill / awaiting_fill)', () => {
    const r = run(flat(8), { 0: limit(90, { expiry_bars: 3 }) });
    expect(r.plans[0]).toMatchObject({ status: 'no_fill', filled_at: null, exit: null });
    expect(r.plans[0]!.events.map((e) => e.kind)).toEqual(['placed', 'no_fill']);
    expect(run(flat(3), { 0: limit(90, { expiry_bars: 5 }) }).plans[0]!.status).toBe('pending');
    expect(r.stats).toMatchObject({ placed: 1, filled: 0, no_fill: 1, fill_rate: 0 });
  });
  it('limit gap: open already through the limit fills at the better open (8794 v9_limit_entry_gap_gets_open)', () => {
    const bars = set(flat(5), 1, 96, 97, 95.5, 96.5);
    const p = run(bars, { 0: limit(98) }).plans[0]!;
    expect(p).toMatchObject({ fill_price: 96, fill_gap: true });
  });
  it('market entry whose next open already breaches the stop is cancelled as gap_invalidated (ledger gap_invalidated_entry)', () => {
    const bars = set(flat(5), 1, 94, 94.5, 93, 94);
    const p = run(bars, { 0: intent() }).plans[0]!;
    expect(p).toMatchObject({ status: 'cancelled', blocked_reason: 'gap_invalidated', filled_at: null });
  });
  it('placement gate: min_rr blocks, missing / wrong-side stop blocks, none of them touch the ledger', () => {
    const r = run(flat(6), { 0: intent({ min_rr: 3 }), 1: intent({ stop: null }), 2: intent({ stop: { price: 101, source: 'atr', note: '' } }) });
    expect(r.plans.map((p) => [p.status, p.blocked_reason])).toEqual([['blocked', 'min_rr'], ['blocked', 'no_stop'], ['blocked', 'stop_side']]);
    expect(r.plans[0]!.planned_rr).toBeCloseTo(2, 9); expect(r.stats).toMatchObject({ placed: 0, blocked: 3 }); expect(r.equity.at(-1)!.equity).toBe(10000);
    expect(run(flat(6), { 0: intent({ min_rr: 2 }) }).plans[0]!.status).toBe('filled');
  });
  it('min_rr with no valid target blocks as no_target; wrong-side TP levels are dropped before rr', () => {
    const r = run(flat(4), { 0: intent({ min_rr: 1, take_profits: [{ price: 90, size_pct: 1, source: 'rr', note: '' }] }) });
    expect(r.plans[0]).toMatchObject({ status: 'blocked', blocked_reason: 'no_target' });
    const ok = run(flat(4), { 0: intent({ take_profits: [{ price: 90, size_pct: 0.5, source: 'rr', note: '' }, { price: 115, size_pct: 0.5, source: 'rr', note: '' }] }) }).plans[0]!;
    expect(ok.take_profits).toHaveLength(1); expect(ok.take_profits[0]!.size_pct).toBe(1); expect(ok.planned_rr).toBeCloseTo(3, 9);
  });
});

describe('exits', () => {
  it('same bar touches SL and TP → SL first (8794 same_bar_sl_and_tp_resolves_to_sl)', () => {
    const bars = set(flat(5), 2, 100, 111, 94, 100);
    expect(run(bars, { 0: intent() }).plans[0]!.exit).toMatchObject({ reason: 'sl', price: 95 });
  });
  it('stop gapped at open fills at the worse open, not the unreachable stop (8794 v9_gap_stop_fixture)', () => {
    const bars = set(flat(5), 2, 92, 93, 91, 92);
    const p = run(bars, { 0: intent() }).plans[0]!;
    expect(p.exit).toMatchObject({ reason: 'sl', price: 92 }); expect(p.r_multiple).toBeCloseTo(-8 / 5, 9);
  });
  it('multi TP ladder exits by declared weight; last level takes the remainder (8794 multiple_take_profits_exit_by_declared_weight)', () => {
    const bars = flat(8); set(bars, 2, 100, 106, 99.5, 105); set(bars, 4, 105, 112, 104, 111);
    const p = run(bars, { 0: intent({ take_profits: [{ price: 110, size_pct: 0.7, source: 'rr', note: '' }, { price: 105, size_pct: 0.3, source: 'structure_resistance', note: '' }] }) }).plans[0]!;
    expect(p.take_profits.map((t) => [t.price, t.size_pct])).toEqual([[105, 0.3], [110, 0.7]]);
    expect(p.exit).toMatchObject({ reason: 'tp' }); expect(p.exit!.price).toBeCloseTo(0.3 * 105 + 0.7 * 110, 9);
    expect(p.events.filter((e) => e.kind === 'tp_hit')).toHaveLength(2);
  });
  it('partial TP then stop: weighted exit price and final reason sl (8794 partial_take_profit_then_stop_uses_weighted_exit_price)', () => {
    const bars = flat(8); set(bars, 2, 100, 106, 99.5, 105); set(bars, 4, 99, 99.5, 94, 95);
    const p = run(bars, { 0: intent({ take_profits: [{ price: 105, size_pct: 0.5, source: 'rr', note: '' }, { price: 120, size_pct: 0.5, source: 'rr', note: '' }] }) }).plans[0]!;
    expect(p.exit).toMatchObject({ reason: 'sl' }); expect(p.exit!.price).toBeCloseTo(0.5 * 105 + 0.5 * 95, 9); expect(p.r_multiple).toBeCloseTo(0, 9);
    expect(run(bars, { 0: intent({ take_profits: [{ price: 105, size_pct: 0.5, source: 'rr', note: '' }, { price: 120, size_pct: 0.5, source: 'rr', note: '' }] }) }).stats.tp_hit_rate).toBe(1);
  });
  it('missing size_pct → equal weights (8794 missing_size_pct_makes_all_take_profit_levels_equal_weight)', () => {
    const p = run(flat(4), { 0: intent({ take_profits: [{ price: 105, size_pct: 0, source: 'rr', note: '' }, { price: 110, size_pct: 0, source: 'rr', note: '' }] }) }).plans[0]!;
    expect(p.take_profits.map((t) => t.size_pct)).toEqual([0.5, 0.5]);
  });
  it('breakeven after first TP: remaining stop moves to avg entry from the next bar (8794 stop_loss_moved_to_breakeven_exits_near_zero_r)', () => {
    const bars = flat(8); set(bars, 2, 100, 106, 99.5, 105); set(bars, 3, 104, 104.5, 99, 99.5);
    const p = run(bars, { 0: intent({ take_profits: [{ price: 105, size_pct: 0.5, source: 'rr', note: '' }, { price: 120, size_pct: 0.5, source: 'rr', note: '' }] }) }, { breakeven_after_tp: true }).plans[0]!;
    expect(p.exit).toMatchObject({ reason: 'breakeven' }); expect(p.exit!.price).toBeCloseTo(102.5, 9);
    expect(p.stop_path.map((s) => s.price)).toEqual([95, 100]);
  });
  it('limit fill bar does not take TP (the high may predate the fill) but does take SL — deliberate deviation from 8794', () => {
    const bars = flat(6); set(bars, 1, 100, 111, 97.5, 104); set(bars, 2, 104, 105, 103, 104);
    const p = run(bars, { 0: limit(98) }).plans[0]!;
    expect(p.fill_price).toBe(98); expect(p.exit!.reason).toBe('open');
    const sl = run(set(flat(6), 1, 100, 111, 94, 104), { 0: limit(98, { stop: { price: 95, source: 'atr', note: '' } }) }).plans[0]!;
    expect(sl.exit).toMatchObject({ reason: 'sl', price: 95 });
  });
  it('max_holding_bars exits at the next open with reason time; manage exit → signal_exit; manage stop → trail', () => {
    const bars = flat(10);
    const t = run(bars, { 0: intent() }, { max_holding_bars: 3 }).plans[0]!;
    expect(t.exit).toMatchObject({ reason: 'time', at: bars[4]!.open_time }); expect(t.bars_held).toBe(3);
    const s = run(bars, { 0: intent() }, {}, (v) => v.bar_index === 2 ? { exit: 'trend_break' } : null).plans[0]!;
    expect(s.exit).toMatchObject({ reason: 'signal_exit', at: bars[3]!.open_time });
    const trailBars = set(flat(10), 4, 100, 100.5, 98, 99);
    const tr = run(trailBars, { 0: intent() }, {}, (v) => v.bar_index === 2 ? { stop: 99, stop_source: 'trail' } : { stop: 90 }).plans[0]!;
    expect(tr.exit).toMatchObject({ reason: 'trail', price: 99 }); expect(tr.stop_path.map((x) => x.price)).toEqual([95, 99]);
  });
});

describe('new-signal policy (8794 v7 rolled / v8 replacement)', () => {
  it('unfilled + same side → whole plan replaced; the old limit touching later cannot fill the new plan (8794 replacement_before_fill / superseded_old_price_touch)', () => {
    const bars = flat(10); set(bars, 3, 100, 100.5, 97.5, 99);
    const r = run(bars, { 0: limit(98), 1: limit(96, { stop: { price: 92, source: 'atr', note: '' } }) });
    expect(r.plans.map((p) => [p.id, p.status, p.replaced_by])).toEqual([['plan_1', 'replaced', 'plan_2'], ['plan_2', 'no_fill', null]]);
    expect(r.stats).toMatchObject({ replaced: 1, no_fill: 1, filled: 0 });
  });
  it('replacement owns a fresh expiry window (8794 replacement_owns_a_fresh_expiry_window)', () => {
    const bars = flat(10); set(bars, 5, 100, 100.5, 95.5, 99);
    const r = run(bars, { 0: limit(96, { expiry_bars: 3 }), 2: limit(96, { expiry_bars: 3 }) });
    expect(r.plans[1]).toMatchObject({ status: 'filled', filled_at: bars[5]!.open_time });
  });
  it('unfilled keep policy ignores the newcomer', () => {
    const r = run(flat(6), { 0: limit(90, { expiry_bars: 5 }), 1: limit(80) }, { on_new_signal: { unfilled: 'keep' } });
    expect(r.plans).toHaveLength(1); expect(r.stats.ignored).toBe(1);
  });
  it('filled + same side → roll: old closes rolled at next open without fees, new plan inherits qty and its SL/TP take over (8794 v7)', () => {
    const bars = flat(10); set(bars, 3, 104, 104.5, 103.5, 104); set(bars, 4, 104, 104.5, 101.5, 103);
    const r = run(bars, { 0: intent(), 2: intent({ reference_price: 104, stop: { price: 102, source: 'structure_support', note: '' }, take_profits: [{ price: 120, size_pct: 1, source: 'rr', note: '' }] }) }, { taker_fee_rate: 0.001 });
    const [a, b] = r.plans;
    expect(a).toMatchObject({ rolled_to: 'plan_2', exit: { reason: 'rolled', price: 104, at: bars[3]!.open_time } });
    expect(b).toMatchObject({ rolled_from: 'plan_1', fill_price: 104, filled_at: bars[3]!.open_time, exit: { reason: 'sl', price: 102 } });
    expect(b!.qty).toBeCloseTo(a!.qty!, 9);
    expect(r.trades[0]!.fees).toBeCloseTo(a!.qty! * 100 * 0.001, 6);
    expect(r.trades[1]!.fees).toBeCloseTo(b!.qty! * 102 * 0.001, 6);
    const net = r.trades.reduce((x, t) => x + t.pnl, 0);
    expect(r.equity.at(-1)!.equity).toBeCloseTo(10000 + net, 6);
    expect(r.stats).toMatchObject({ rolled: 1, filled: 2 }); expect(r.stats.fill_rate).toBe(1);
  });
  it('filled + add → equal-weight leg averages the entry; an add limit that never touches does not fill (8794 a_filled_add_leg_averages / add_leg_never_touches)', () => {
    const bars = flat(10); set(bars, 3, 98, 98.5, 97.5, 98);
    const r = run(bars, { 0: intent(), 2: intent({ reference_price: 98 }), 4: limit(80) }, { on_new_signal: { filled: 'add' }, max_adds: 2 });
    const p = r.plans[0]!;
    expect(r.plans).toHaveLength(1); expect(p.legs.map((l) => l.price)).toEqual([100, 98]); expect(p.legs[1]!.qty_frac).toBeCloseTo(100 / 98, 8);
    expect(p.exit!.reason).toBe('open'); expect(p.margin).toBeCloseTo(2 * 10000 / 3, 6); expect(r.stats.added).toBe(1);
    expect(p.events.filter((e) => e.kind === 'added')).toHaveLength(1);
  });
  it('filled + ignore → nothing changes', () => {
    const r = run(flat(6), { 0: intent(), 2: intent() }, { on_new_signal: { filled: 'ignore' } });
    expect(r.plans).toHaveLength(1); expect(r.stats.ignored).toBe(1);
  });
  it('opposite signal: unfilled → cancelled; filled → flipped at next open and the new side opens (8794 flip_reason_propagates)', () => {
    const r1 = run(flat(8), { 0: limit(90, { expiry_bars: 5 }), 1: intent({ side: 'short', stop: { price: 105, source: 'atr', note: '' }, take_profits: [{ price: 90, size_pct: 1, source: 'rr', note: '' }] }) }, { market: 'perp' });
    expect(r1.plans.map((p) => [p.side, p.status])).toEqual([['long', 'cancelled'], ['short', 'filled']]);
    const bars = set(flat(8), 3, 102, 102.5, 101.5, 102);
    const r2 = run(bars, { 0: intent(), 2: intent({ side: 'short', reference_price: 102, stop: { price: 106, source: 'atr', note: '' }, take_profits: [{ price: 90, size_pct: 1, source: 'rr', note: '' }] }) }, { market: 'perp' });
    expect(r2.plans[0]!.exit).toMatchObject({ reason: 'flipped', price: 102, at: bars[3]!.open_time });
    expect(r2.plans[1]).toMatchObject({ side: 'short', fill_price: 102, filled_at: bars[3]!.open_time });
    expect(r2.stats.flipped).toBe(1);
  });
});

describe('perp: short, leverage, liquidation, funding', () => {
  const shortIntent = (o: Partial<PlanIntent> = {}) => intent({ side: 'short', stop: { price: 105, source: 'structure_resistance', note: '' }, take_profits: [{ price: 90, size_pct: 1, source: 'structure_support', note: '' }], ...o });
  it('short pnl sign is inverted (8794 short_side_pnl_is_inverted) and spot rejects shorts / leverage', () => {
    const bars = set(flat(6), 2, 100, 100.5, 89, 90);
    const p = run(bars, { 0: shortIntent() }, { market: 'perp', funding: { points: [], from_ms: 0, to_ms: T0 + 100 * H } }).plans[0]!;
    expect(p.exit).toMatchObject({ reason: 'tp', price: 90 }); expect(p.pnl_pct).toBeCloseTo(0.1, 9); expect(p.r_multiple).toBeCloseTo(2, 9); expect(p.price_move_pct).toBeCloseTo(0.1, 9);
    const spot = run(bars, { 0: shortIntent() });
    expect(spot.plans).toHaveLength(0); expect(spot.flags).toContain('spot_short_rejected');
    expect(() => run(bars, {}, { market: 'spot', leverage: 3 })).toThrow('spot_leverage_forbidden');
  });
  it('leverage multiplies return on margin, not the price move; MFE/MAE stay unlevered', () => {
    const bars = set(flat(6), 2, 100, 106, 99, 105);
    const p = run(bars, { 0: intent({ take_profits: [{ price: 105, size_pct: 1, source: 'rr', note: '' }] }) }, { market: 'perp', leverage: 3, funding: { points: [], from_ms: 0, to_ms: T0 + 100 * H } }).plans[0]!;
    expect(p.pnl_pct).toBeCloseTo(0.15, 9); expect(p.price_move_pct).toBeCloseTo(0.05, 9); expect(p.mfe_pct).toBeCloseTo(0.06, 9);
    expect(p.qty! * 100).toBeCloseTo(30000, 6); expect(p.margin).toBeCloseTo(10000, 6);
  });
  it('liquidation beats a stop placed beyond it; a stop inside the liquidation price fires first', () => {
    const bars = set(flat(6), 2, 100, 100.5, 85, 86);
    const liq = run(bars, { 0: intent({ stop: { price: 80, source: 'atr', note: '' }, take_profits: [] }) }, { market: 'perp', leverage: 10, maintenance_margin: 0.004 });
    const p = liq.plans[0]!;
    expect(p.liquidation_price).toBeCloseTo(90.4, 6); expect(p.exit).toMatchObject({ reason: 'liquidation', price: 90.4 });
    expect(p.pnl_pct).toBeCloseTo(-1, 9); expect(liq.equity.at(-1)!.equity).toBeCloseTo(0, 6); expect(liq.stats.liquidated).toBe(1);
    const sl = run(bars, { 0: intent({ stop: { price: 95, source: 'atr', note: '' }, take_profits: [] }) }, { market: 'perp', leverage: 10 }).plans[0]!;
    expect(sl.exit).toMatchObject({ reason: 'sl', price: 95 }); expect(sl.pnl_pct).toBeCloseTo(-0.5, 9);
  });
  it('liquidation is judged on mark price when given; a missing mark bar falls back to trade price and is flagged', () => {
    const bars = set(flat(6), 2, 100, 100.5, 89, 99);
    const mark = bars.map((b) => ({ ...b, low: Math.max(b.low, 95) }));
    const onMark = run(bars, { 0: intent({ stop: { price: 50, source: 'atr', note: '' }, take_profits: [] }) }, { market: 'perp', leverage: 10, mark });
    expect(onMark.plans[0]!.exit!.reason).toBe('open');
    const holes = mark.map((m, i) => (i === 2 ? null : m));
    const fb = run(bars, { 0: intent({ stop: { price: 50, source: 'atr', note: '' }, take_profits: [] }) }, { market: 'perp', leverage: 10, mark: holes });
    expect(fb.plans[0]!.exit!.reason).toBe('liquidation'); expect(fb.flags.some((f) => f.startsWith('mark_fallback'))).toBe(true);
  });
  it('tiered maintenance margin picks the tier by position size', () => {
    const p = run(flat(4), { 0: intent({ take_profits: [] }) }, { market: 'perp', leverage: 5, maintenance_margin: [{ max_qty: 100, mmr: 0.004 }, { max_qty: Infinity, mmr: 0.01 }] }).plans[0]!;
    expect(p.qty).toBeCloseTo(500, 6); expect(p.liquidation_price).toBeCloseTo(100 * (1 - 0.2 + 0.01), 6);
  });
  it('funding: long pays positive rate, short receives; charged per real series point inside the holding interval', () => {
    const bars = flat(20), pts = [4, 12].map((h) => ({ ts: T0 + h * H, rate: 0.001 }));
    const series = { points: pts, from_ms: T0, to_ms: T0 + 20 * H };
    const long = run(bars, { 0: intent({ take_profits: [] }) }, { market: 'perp', funding: series }).plans[0]!;
    expect(long.funding_periods).toBe(2); expect(long.funding_pct).toBeCloseTo(-0.002, 9); expect(long.funding_status).toBe('complete');
    const short = run(bars, { 0: intent({ side: 'short', stop: { price: 105, source: 'atr', note: '' }, take_profits: [] }) }, { market: 'perp', funding: series }).plans[0]!;
    expect(short.funding_pct).toBeCloseTo(0.002, 9);
    const late = run(bars, { 0: intent({ take_profits: [] }) }, { market: 'perp', funding: { points: [], from_ms: T0 + 30 * H, to_ms: T0 + 40 * H } }).plans[0]!;
    expect(late.funding_status).toBe('missing'); expect(late.funding_pct).toBeNull();
    const partial = run(bars, { 0: intent({ take_profits: [] }) }, { market: 'perp', funding: { points: [pts[0]!], from_ms: T0, to_ms: T0 + 8 * H } });
    expect(partial.plans[0]!.funding_status).toBe('partial'); expect(partial.flags).toContain('funding_partial'); expect(partial.stats.funding_missing).toBe(1);
  });
  it('funding at a bar-open instant belongs to the position held before that open (exit at that open still pays; entry at it does not)', () => {
    const bars = flat(10), series = { points: [{ ts: T0 + 1 * H, rate: 0.01 }, { ts: T0 + 4 * H, rate: 0.01 }], from_ms: T0, to_ms: T0 + 10 * H };
    const p = run(bars, { 0: intent({ take_profits: [] }) }, { market: 'perp', funding: series, max_holding_bars: 3 }).plans[0]!;
    expect(p.filled_at).toBe(T0 + H); expect(p.exit!.at).toBe(T0 + 4 * H); expect(p.funding_periods).toBe(1);
  });
  it('perp without any funding series → funding_pct null + funding_missing flag (never silently 0); spot is not_applicable', () => {
    const r = run(flat(5), { 0: intent({ take_profits: [] }) }, { market: 'perp' });
    expect(r.plans[0]).toMatchObject({ funding_status: 'missing', funding_pct: null }); expect(r.flags).toContain('funding_missing');
    expect(run(flat(5), { 0: intent() }).plans[0]).toMatchObject({ funding_status: 'not_applicable', funding_pct: null });
  });
});

describe('MFE/MAE (8794 v11)', () => {
  it('exit bar counts fully even when exiting at its open; anchored on the final multi-leg average', () => {
    const bars = flat(10); set(bars, 3, 98, 98.5, 97.5, 98); set(bars, 5, 100, 108, 100, 101);
    const p = run(bars, { 0: intent(), 2: intent() }, { on_new_signal: { filled: 'add' } }, (v) => v.bar_index === 4 ? { exit: 'x' } : null).plans[0]!;
    expect(p.exit).toMatchObject({ reason: 'signal_exit', at: bars[5]!.open_time });
    const avg = 2 / (1 / 100 + 1 / 98); // 每腿等保证金 → 数量加权均价
    expect(p.mfe_pct).toBeCloseTo((108 - avg) / avg, 9); expect(p.mae_pct).toBeCloseTo((97.5 - avg) / avg, 9);
    expect(run(flat(6), { 0: limit(50) }).plans[0]).toMatchObject({ mfe_pct: null, mae_pct: null });
  });
});

describe('fees, slippage and equity', () => {
  it('maker for limit entry and TP, taker + adverse slippage for market entry and stops', () => {
    const bars = flat(8); set(bars, 2, 100, 100.5, 97.5, 99); set(bars, 4, 100, 111, 99.5, 110);
    const lim = run(bars, { 0: limit(98) }, { market: 'perp', taker_fee_rate: 0.0005, maker_fee_rate: 0.0002, slippage_bps: 10, funding: { points: [], from_ms: 0, to_ms: T0 + 99 * H } });
    const t = lim.trades[0]!, p = lim.plans[0]!;
    expect(p.fill_price).toBe(98); expect(t.exit_price).toBe(110); expect(t.fees).toBeCloseTo(p.qty! * 98 * 0.0002 + p.qty! * 110 * 0.0002, 6);
    const mkt = run(set(flat(6), 2, 100, 100.5, 94, 95), { 0: intent() }, { taker_fee_rate: 0.001, slippage_bps: 10 });
    expect(mkt.plans[0]!.fill_price).toBeCloseTo(100.1, 9); expect(mkt.trades[0]!.exit_price).toBeCloseTo(95 * 0.999, 9);
    expect(mkt.equity.at(-1)!.equity).toBeCloseTo(10000 + mkt.trades[0]!.pnl, 6);
  });
  it('equity marks open positions to close and returns to cash after exit; drawdown is from the peak', () => {
    const bars = flat(6); set(bars, 2, 100, 104.5, 99.5, 104); set(bars, 3, 104, 104.5, 94, 95);
    const r = run(bars, { 0: intent() });
    expect(r.equity[2]!.equity).toBeCloseTo(10400, 6); expect(r.equity[3]!.equity).toBeCloseTo(9500, 6);
    expect(r.equity[3]!.drawdown).toBeCloseTo(1 - 9500 / 10400, 9); expect(r.equity[2]!.exposure).toBeCloseTo(1, 9); expect(r.equity[4]!.exposure).toBe(0);
  });
});
