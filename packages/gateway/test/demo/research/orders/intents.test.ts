/** StrategyIR.order → 意图 / 管理回调 / 编译检查。 */
import { describe, it, expect } from 'vitest';
import type { StrategyIR, ResearchBar } from '@trading-swarm/contracts';
import { orderIntents, orderManager, resolveOrder, evalLevel, mirrorBars, runOrderPath, defaultExpiryBars } from '../../../../src/demo/research/orders/index.js';
import { defaultIR, checkIR, rulesOf, repairIR, node, compileConstraints } from '../../../../src/demo/research/strategy.js';
import { checkIRSpec } from '../../../../src/demo/research/strategy-spec.js';
import { registry } from '../../../../src/demo/research/primitives/index.js';
import { atr } from '../../../../src/demo/research/primitives/registry.js';
import { indicatorLine } from '../../../../src/demo/research/primitives/indicators.js';
// 旧口径(LEGACY_ORDER_GATE)的缺省语义;结构口径的缺省止盈/min_rr/stop_too_close 见 ../structure-exits.test.ts
import { LEGACY_ORDER_GATE as DEFAULT_ORDER_GATE } from '../../../../src/demo/research/order-gate.js';
import { fixture, STEP } from '../fixtures.js';
const bars = fixture().bars;
const withOrder = (order: StrategyIR['order'], patch: Partial<StrategyIR> = {}): StrategyIR => ({ ...defaultIR(), order, ...patch });
const ctxOf = (b: ResearchBar[], i: number) => ({ bars: b, mirrored: mirrorBars(b), timeframe_ms: STEP });

describe('level primitives by role and side', () => {
  it('structure_level short equals the negated long result on mirrored bars (symmetry by construction)', () => {
    const p = { primitive: 'structure_level', params: { swing_length: 2 } }, m = mirrorBars(bars);
    let compared = 0;
    for (let i = 60; i < 400; i += 7) {
      const s = registry.get('structure_level')!.compute({ bars: bars.slice(0, i + 1), i, timeframe_ms: STEP, side: 'short' }, p.params);
      const l = registry.get('structure_level')!.compute({ bars: m.slice(0, i + 1), i, timeframe_ms: STEP, side: 'long' }, p.params);
      expect(s.level).toBe(l.level === undefined ? undefined : -l.level); expect(s.target).toBe(l.target === undefined ? undefined : -l.target);
      if (s.stop !== undefined) { expect(s.stop).toBeCloseTo(-l.stop!, 9); compared++; }
    }
    expect(compared).toBeGreaterThan(5);
  });
  it('atr_stop / structure_target for a short are mirrored above / below the close', () => {
    const i = 300, close = Number(bars[i]!.close), a = atr(bars.slice(0, i + 1), 14);
    expect(evalLevel(node('atr_stop', { atr_period: 14, multiple: 2 }), 'stop', 'short', ctxOf(bars, i), i)).toBeCloseTo(close + 2 * a, 6);
    expect(evalLevel(node('atr_stop', { atr_period: 14, multiple: 2 }), 'stop', 'long', ctxOf(bars, i), i)).toBeCloseTo(close - 2 * a, 6);
    const tpShort = evalLevel(node('structure_target', { swing_length: 2, htf: '4h' }), 'tp', 'short', ctxOf(bars, i), i), tpLong = evalLevel(node('structure_target', { swing_length: 2, htf: '4h' }), 'tp', 'long', ctxOf(bars, i), i);
    if (tpShort !== null) expect(tpShort).toBeLessThan(close); if (tpLong !== null) expect(tpLong).toBeGreaterThan(close);
  });
  it('indicator_level: level/target = indicator value, stop steps away by buffer ATR on the losing side', () => {
    const i = 250, v = indicatorLine('ema', bars.slice(0, i + 1), { period: 50 }).at(-1)!, a = atr(bars.slice(0, i + 1), 14);
    const x = node('indicator_level', { indicator: 'ema', args: { period: 50 }, buffer_atr: 0.5 });
    expect(evalLevel(x, 'entry', 'long', ctxOf(bars, i), i)).toBeCloseTo(v, 9);
    expect(evalLevel(x, 'stop', 'long', ctxOf(bars, i), i)).toBeCloseTo(v - 0.5 * a, 9);
    expect(evalLevel(x, 'stop', 'short', ctxOf(bars, i), i)).toBeCloseTo(v + 0.5 * a, 9);
    const bb = node('indicator_level', { indicator: 'bbands', output: 'upper' });
    expect(evalLevel(bb, 'tp', 'long', ctxOf(bars, i), i)).toBeCloseTo(indicatorLine('bbands', bars.slice(0, i + 1), null, 'upper').at(-1)!, 9);
  });
});

describe('orderIntents', () => {
  it('state signals fire only on the rising edge (a new signal, not every bar it stays true)', () => {
    const ir = withOrder({ direction: 'long', market: 'spot' }, { signal: [node('indicator_threshold', { indicator: 'rsi', args: { period: 14 }, operator: 'above', threshold: 50 })], regime: undefined });
    delete (ir as Partial<StrategyIR>).regime;
    const { intents } = orderIntents(ir, bars, STEP, { fee_rate: '0.001', slippage_bps: '5', from_index: 100, to_index: 400 });
    let edges = 0, prev = false;
    for (let i = 99; i <= 400; i++) { const on = !!registry.get('indicator_threshold')!.compute({ bars: bars.slice(0, i + 1), i, timeframe_ms: STEP }, ir.signal[0]!.params).pass; if (i >= 100 && on && !prev) edges++; prev = on; }
    expect(intents.filter(Boolean).length).toBe(edges); expect(edges).toBeGreaterThan(2);
  });
  it('defaults: TP from exit structure_target, min_rr from gate unless order.min_rr, expiry by timeframe; cost floor widens the stop and fixed_r re-anchors', () => {
    const ir = withOrder({ direction: 'long', market: 'spot', entry: { type: 'limit', price: node('atr_offset_level', { atr_period: 14, multiple: 0.3 }) }, take_profits: [{ source: node('fixed_r_target', { r: 2 }) }] }, { risk: { ...defaultIR().risk, stop: node('atr_stop', { atr_period: 14, multiple: 0.05 }) } });
    const r = resolveOrder(ir, STEP, DEFAULT_ORDER_GATE)!;
    expect(r).toMatchObject({ min_rr: 1.5, entry: { type: 'limit', expiry_bars: defaultExpiryBars(STEP) }, on_new_signal: { unfilled: 'replace', filled: 'roll' } });
    expect(resolveOrder(withOrder({ direction: 'long', market: 'spot', min_rr: 3 }), STEP, DEFAULT_ORDER_GATE)!.min_rr).toBe(3);
    expect(resolveOrder(withOrder({ direction: 'long', market: 'spot' }), STEP)!.take_profits[0]!.source.primitive).toBe('structure_target');
    const all = orderIntents({ ...ir, signal: [node('indicator_threshold', { indicator: 'rsi', args: { period: 14 }, operator: 'cross_above', threshold: 50 })] }, bars, STEP, { fee_rate: '0.001', slippage_bps: '5', gate: DEFAULT_ORDER_GATE, from_index: 100, to_index: 400 }).intents.filter(Boolean);
    expect(all.length).toBeGreaterThan(0);
    for (const it of all) { const ref = it!.entry.price!, d = ref - it!.stop!.price; expect(d / ref).toBeGreaterThanOrEqual(0.024 - 1e-9); expect(it!.stop!.note).toContain('cost_floor'); expect(it!.take_profits[0]!.price).toBeCloseTo(ref + 2 * d, 6); expect(it!.min_rr).toBe(1.5); }
  });
  it('direction=both uses short_signal for shorts; short stops sit above and targets below the reference', () => {
    const ir = withOrder({ direction: 'both', market: 'perp', leverage: 2, short_signal: [node('indicator_threshold', { indicator: 'rsi', args: { period: 14 }, operator: 'cross_below', threshold: 50 })] }, { signal: [node('indicator_threshold', { indicator: 'rsi', args: { period: 14 }, operator: 'cross_above', threshold: 50 })], risk: { ...defaultIR().risk, stop: node('atr_stop', { atr_period: 14, multiple: 3 }) } });
    delete (ir as Partial<StrategyIR>).regime;
    const xs = orderIntents(ir, bars, STEP, { fee_rate: '0.0005', slippage_bps: '5', from_index: 100, to_index: 400 }).intents.filter(Boolean);
    const shorts = xs.filter((x) => x!.side === 'short'), longs = xs.filter((x) => x!.side === 'long');
    expect(shorts.length).toBeGreaterThan(0); expect(longs.length).toBeGreaterThan(0);
    for (const s of shorts) { expect(s!.stop!.price).toBeGreaterThan(s!.reference_price); expect(s!.stop!.source).toBe('atr'); for (const t of s!.take_profits) expect(t.price).toBeLessThan(s!.reference_price); }
  });
});

describe('orderManager and runOrderPath', () => {
  it('chandelier trail for a short = lowest low since entry + m×ATR (mirrored evaluation)', () => {
    const ir = withOrder({ direction: 'short', market: 'perp' }, { exit: [node('chandelier_trail', { atr_period: 22, multiple: 3 }), node('structure_target', { htf: '1d', swing_length: 3 })] });
    const m = orderManager(ir, bars, STEP, { fee_rate: '0.0005' }), i = 300, entryAt = bars[280]!.open_time;
    const u = m({ plan_id: 'p', side: 'short', bar_index: i, entry_at: entryAt, avg_entry: 150, initial_stop: 160, initial_distance: 10, bars_held: 20, high_water: 0, low_water: 1e9, stop: 160 })!;
    const low = Math.min(...bars.slice(280, i + 1).map((b) => Number(b.low))), a = atr(bars.slice(0, i + 1), 22);
    expect(u.stop).toBeCloseTo(low + 3 * a, 6); expect(u.stop_source).toBe('trail');
  });
  it('end to end on a spot fixture: trades are exactly the settled filled plans, equity covers the window, deterministic', () => {
    const ir = withOrder({ direction: 'long', market: 'spot', min_rr: 1.2 }, { signal: [node('indicator_threshold', { indicator: 'rsi', args: { period: 14 }, operator: 'cross_above', threshold: 55 })] });
    delete (ir as Partial<StrategyIR>).regime;
    const run = () => runOrderPath({ ir, bars, timeframe_ms: STEP, symbol: 'TEST', from_index: 100, to_index: 419, initial_cash: 10000, fee_rate: '0.001', slippage_bps: '5' });
    const r = run();
    expect(r.equity).toHaveLength(320); expect(r.plans.length).toBeGreaterThan(0);
    const settled = r.plans.filter((p) => p.filled_at !== null && p.exit && p.exit.reason !== 'open');
    expect(r.trades.map((t) => t.id)).toEqual(settled.map((p) => p.id));
    expect(r.stats.placed + (r.stats.blocked ?? 0)).toBe(r.plans.length);
    expect(JSON.stringify(run())).toBe(JSON.stringify(r));
    for (const p of r.plans) expect(p.segment).toBe('in_sample');
  });
  it('perp short end to end: fee defaults are OKX taker 0.05% / maker 0.02%, funding missing is flagged not zeroed', () => {
    const ir = withOrder({ direction: 'short', market: 'perp', leverage: 3 }, { signal: [node('indicator_threshold', { indicator: 'rsi', args: { period: 14 }, operator: 'cross_below', threshold: 50 })], risk: { ...defaultIR().risk, stop: node('atr_stop', { atr_period: 14, multiple: 3 }) } });
    delete (ir as Partial<StrategyIR>).regime;
    const r = runOrderPath({ ir, bars, timeframe_ms: STEP, symbol: 'TEST', from_index: 100, to_index: 419, initial_cash: 10000 });
    expect(r.flags).toContain('funding_missing');
    const filled = r.plans.filter((p) => p.filled_at !== null);
    expect(filled.length).toBeGreaterThan(0);
    for (const p of filled) { expect(p.side).toBe('short'); expect(p.leverage).toBe(3); expect(p.funding_pct).toBeNull(); expect(p.liquidation_price!).toBeGreaterThan(p.fill_price!); }
  });
});

describe('compile checks with the order block', () => {
  it('IR without order keeps exactly the old check list; valid order adds an order_block check that passes', () => {
    const old = checkIR(defaultIR(), '1h');
    expect(old.checks.map((c) => c.name)).toEqual(['units', 'timeframe_consistency', 'lookahead', 'state_machine', 'order_gate_ready', 'risk_bounds', 'warmup']);
    const ok = checkIR(withOrder({ direction: 'both', market: 'perp', leverage: 3, entry: { type: 'limit', price: node('structure_level', { swing_length: 3 }), expiry_bars: 12 }, take_profits: [{ source: node('fixed_r_target', { r: 1.5 }), size_pct: 0.5 }, { source: node('indicator_level', { indicator: 'bbands', output: 'upper' }), size_pct: 0.5 }], min_rr: 2, short_signal: [node('indicator_cross', { indicator: 'ema', args: { period: 20 }, compare_to: 'price', direction: 'cross_below' })] }), '1h');
    expect(ok.checks.filter((c) => !c.ok)).toEqual([]); expect(ok.checks.find((c) => c.name === 'order_block')!.ok).toBe(true);
    expect(rulesOf(ok.ir!).some((r) => r.primitive === 'order' && r.text.includes('永续 3 倍'))).toBe(true);
  });
  it('spot short / spot leverage / both without short_signal / limit without price / non-level sources are rejected', () => {
    const bad = (o: StrategyIR['order']) => checkIR(withOrder(o), '1h').checks.find((c) => c.name === 'order_block')!;
    expect(bad({ direction: 'short', market: 'spot' }).ok).toBe(false);
    expect(bad({ direction: 'long', market: 'spot', leverage: 2 }).ok).toBe(false);
    expect(bad({ direction: 'both', market: 'perp' }).message).toContain('short_signal');
    expect(bad({ direction: 'long', market: 'perp', entry: { type: 'limit' } }).message).toContain('entry.price');
    expect(bad({ direction: 'long', market: 'perp', take_profits: [{ source: node('trend_break', { ema_period: 50, htf: '4h' }) }] }).ok).toBe(false);
    const params = checkIR(withOrder({ direction: 'long', market: 'perp', entry: { type: 'limit', price: node('indicator_level', { indicator: 'ema', nonsense: 1 }) } }), '1h');
    expect(params.checks.find((c) => c.name === 'units')!.ok).toBe(false);
  });
  it('repairIR fills order defaults (stop = support break, limit price = support near edge) and does not add a fixed_r target when order has TPs', () => {
    const c = compileConstraints('1h', null, undefined, DEFAULT_ORDER_GATE);
    const raw = { ...withOrder({ direction: 'long', market: 'perp', entry: { type: 'limit' }, take_profits: [{ source: node('structure_target', { htf: '1d', swing_length: 3 }) }] }), exit: [node('chandelier_trail', { atr_period: 22, multiple: 3 })] } as Partial<StrategyIR>;
    delete (raw as { risk?: unknown }).risk;
    const out = repairIR(raw, c), ir = out.ir as StrategyIR;
    expect(ir.risk.stop.primitive).toBe('htf_structure'); expect(ir.order!.entry!.price!.primitive).toBe('structure_level');
    expect(ir.exit.some((x) => x.primitive === 'fixed_r_target')).toBe(false);
    expect(checkIR(ir, '1h').ok).toBe(true);
    expect(checkIRSpec(ir, c).violations.some((v) => v.code === 'target_source_missing')).toBe(false);
    expect(checkIRSpec(withOrder({ direction: 'long', market: 'spot', min_rr: 1 }), c).violations.find((v) => v.code === 'order_min_rr_below_spec')!.severity).toBe('warn');
  });
});
