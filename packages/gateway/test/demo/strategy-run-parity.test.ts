/** R14/R19 离线 G4：同段历史、同成交事实；不访问运行端口/交易所/模型。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StrategyIR } from '@trading-swarm/contracts';
import { openStateDb } from '../../src/state-db.js';
import { ResearchStore } from '../../src/demo/research/store.js';
import { StrategyStore } from '../../src/demo/research/strategies/store.js';
import { StrategyService } from '../../src/demo/research/strategies/service.js';
import { node, policyToIR, irExit } from '../../src/demo/research/strategy.js';
import { SYNTH_POLICY, toResearchBars, researchContext } from '../../src/demo/strategy-candidate.js';
import { viewBars } from '../../src/demo/research/engine.js';
import { orderManager, orderIntents } from '../../src/demo/research/orders/intents.js';
import { simulateOrders } from '../../src/demo/research/orders/simulate.js';
import type { PlanIntent } from '../../src/demo/research/orders/types.js';
import { q, decimal } from '../../src/demo/research/primitives.js';
import { volTargetWeight } from '../../src/demo/research/primitives/sizing.js';
import { orderGateFor } from '../../src/demo/research/order-gate.js';
import { StrategyRunner, runOrigin, runExit, type StrategyRunDeps, type StrategyRun, type RunPositionState } from '../../src/demo/strategy-run.js';
import { generateRunCandidate, sizeRunOrder, runHistoryBars, type RunCandidate } from '../../src/demo/strategy-run-orders.js';
import { newThread } from '../../src/demo/threads.js';
import type { Kline, StrategyThread } from '../../src/demo/types.js';

const H = 3600000, T = Date.UTC(2026, 8, 1), cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const bar = (i: number, price: number, range = 1): Kline => ({ open_time: T + i * H, close_time: T + (i + 1) * H - 1, open: String(price), high: String(price + range), low: String(price - range), close: String(price), volume: '100' });
const history = (n = 640, side: 'long' | 'short' = 'long') => Array.from({ length: n }, (_, i) => bar(i, (side === 'long' ? 100 : 1000) + (side === 'long' ? 1 : -1) * Math.max(0, i - 99) * 0.3 + Math.sin(i / 3) * 0.4));
function irOf(exit: StrategyIR['exit'] = [], side: 'long' | 'short' = 'long'): StrategyIR {
  const ir = policyToIR(SYNTH_POLICY); delete ir.compatibility;
  ir.exit = exit; ir.order = { market: side === 'short' ? 'perp' : 'spot', direction: side, on_new_signal: { unfilled: 'replace', filled: 'ignore' }, take_profits: [{ source: node('fixed_r_target', { r: 50 }) }] };
  return ir;
}
function candidate(as_of: number, symbol = 'BTCUSDT', direction: 'long' | 'short' = 'long'): RunCandidate {
  return { id: `c:${symbol}:${as_of}`, symbol, direction, as_of, at: as_of, entry_ref: 100, stop: direction === 'long' ? 90 : 110, target: direction === 'long' ? 150 : 50,
    rr: 5, entry_type: 'next_open_market', reason: 'fixture', unmapped: [], timeframe: '1h' } as unknown as RunCandidate;
}
function thread(side: 'long' | 'short' = 'long', at = T + 100 * H, stop = side === 'long' ? '90' : '1010') {
  const entry = side === 'long' ? '100' : '1000';
  const t = newThread({ id: 't', backend: 'paper', symbol: 'BTCUSDT', market: side === 'long' ? 'spot' : 'perp', strategy_id: 's@1', side, source: 'agent', timeframe: '1h', thesis: 'fixture', invalidation_text: null, watch_conditions: [], entry: { type: 'market', price: entry, zone: null }, stop_price: stop, take_profits: [], qty: '1', margin_usdt: '100', leverage: 1, margin_mode: 'isolated', now: at });
  t.status = 'in_position'; t.opened_at = at; t.filled_avg_price = entry; t.strategy_version = 1; return t;
}
function fixture(ir = irOf()) {
  const state = openStateDb(':memory:'); let now = T + 100 * H + 5000, ks = history(100), signal: RunCandidate | null = candidate(T + 100 * H);
  const service = new StrategyService(new StrategyStore(state.db, () => now), new ResearchStore(state.db), null), s = service.create({ name: 'R19', symbol: 'BTCUSDT', timeframe: '1h', strategy_ir: ir });
  const threads: StrategyThread[] = [], positions = new Map<string, RunPositionState>();
  const deps: StrategyRunDeps = { db: state.db, strategies: service, environment: () => ({ execution: { backend: 'paper', profile: null, label: '纸面' }, execution_key: 'paper', watchlist: [], risk_pct: 0.3, leverage_cap: 3, asp: { id: 'x', identity: true, active: true, publisher_enabled: false } }),
    now: () => now, clock: () => 0, blocked: () => null, bars: vi.fn(async (_s, _tf, limit, end) => ks.filter(k => k.close_time <= end).slice(-limit)), threads: id => threads.filter(t => t.origin === runOrigin(id)),
    generate: x => ({ candidate: signal ? { ...signal, symbol: x.symbol, as_of: x.now } : null, as_of: x.now, reason: signal ? 'signal' : 'no_candidate', view_bars: 100 }),
    open: vi.fn(async (r, c, approval) => {
      const t = thread(c.direction, now, String(c.stop)); t.id = `t${threads.length}`; t.symbol = c.symbol; t.origin = runOrigin(r.id); t.strategy_id = `${r.strategy_id}@1`;
      if (approval === 'manual' || c.entry_type === 'limit') { t.status = 'pending_entry'; t.opened_at = null; t.filled_avg_price = null; t.entry.type = 'limit'; }
      threads.push(t); return { outcome: 'opened', reason: 'fixture', thread_id: t.id };
    }), close: vi.fn(async t => { t.status = 'closed'; }), cancel: vi.fn(async t => { t.status = 'canceled'; return { ok: true, detail: 'cancelled' }; }),
    moveStop: vi.fn(async (t, stop) => { t.stop_price = stop; return { ok: true, detail: 'confirmed' }; }), positionState: t => positions.get(t.id) ?? {},
    // 复审 High-4 后缺 add 接线是 blocker:夹具默认给一个,需要的测试再覆盖
    add: vi.fn(async () => ({ outcome: 'rejected' as const, reason: 'fixture default add' })),
    filter: vi.fn(async () => ({ decision: 'follow', reason: 'fixture' })), publish: vi.fn(async () => ({})), emit: vi.fn() };
  const runner = new StrategyRunner(deps); cleanup.push(async () => { await runner.stop(); state.close(); });
  return { state, runner, deps, service, s, threads, positions, create: (x = {}) => runner.create({ strategy_id: s.id, market: ir.order?.market ?? 'spot', ...x }),
    step: (n: number) => { now = T + n * H + 5000; ks = history(n); }, setBars: (x: Kline[]) => { ks = x; }, signal: (x: RunCandidate | null) => { signal = x; } };
}
const toOrders = (ks: Kline[]) => ks.map(k => ({ open_time: k.open_time, close_time: k.close_time, open: Number(k.open), high: Number(k.high), low: Number(k.low), close: Number(k.close), volume: Number(k.volume) }));
const intent = (side: 'long' | 'short', stop: number, weight?: number): PlanIntent => ({ side, reason: 'fixture', entry: { type: 'market', price: null, source: null, note: '' }, reference_price: side === 'long' ? 100 : 1000, expiry_bars: 10, stop: { price: stop, source: 'atr', note: '' }, take_profits: [], min_rr: null, ...(weight === undefined ? {} : { size_weight: weight }) });

// 真正模拟 stop_path 对拍，不只是调用两次同一个 helper。
describe('G4 持仓逐根止损序列', () => {
  it.each(['long', 'short'] as const)('%s 吊灯/保本/结构组合 540 根，含 500 根视图滚出和重启', async side => {
    const ir = irOf([node('chandelier_trail', { atr_period: 22, multiple: 3 }), node('breakeven_after_r', { r: 1 }), node('swing_structure_stop', { lookback: 3 })], side);
    const ks = history(640, side), rb = toResearchBars(ks, H, T + 640 * H), stop = side === 'long' ? 90 : 1010;
    const reference = simulateOrders(toOrders(ks), ks.map((_, i) => i === 99 ? intent(side, stop) : null), { symbol: 'BTCUSDT', market: side === 'long' ? 'spot' : 'perp', leverage: 1, timeframe_ms: H, initial_cash: 10000, taker_fee_rate: 0.001 }, orderManager(ir, rb, H, { fee_rate: '0.001', view: viewBars(ir, SYNTH_POLICY, H) }));
    expect(reference.plans).toHaveLength(1);
    const f = fixture(ir); f.signal(null); const { run } = await f.create(); const t = thread(side, T + 100 * H + 5000, String(stop));
    // 实际成交均价与模拟下一根 open 完全相同；仅真实成交时间在根内。
    t.filled_avg_price = ks[100]!.open; t.entry.price = t.filled_avg_price; t.origin = runOrigin(run.id); t.strategy_id = `${f.s.id}@1`; f.threads.push(t); f.positions.set(t.id, { fee_rate: '0.001' });
    await f.runner.patch(run.id, { status: 'paused' });
    let runner = f.runner; const actual: { at: number; price: number }[] = [];
    // 首次逐根，重启后每次补多根，验证持久水位/缺轮补算。
    for (const n of [101, 102, 120, 300, 500, 620, 640]) {
      if (n === 500) { await runner.stop(); runner = new StrategyRunner(f.deps); cleanup.push(() => runner.stop()); }
      f.step(n); f.setBars(ks.slice(0, n)); const result = await runner.scan(run.id);
      actual.push(...result.scan.filter(e => e.kind === 'stop_moved').map(e => ({ at: Number(e.data!.as_of) - 1, price: Number(e.data!.new_stop) })));
    }
    expect(actual).toHaveLength(side === 'long' ? 529 : 531);
    expect(actual).toEqual(reference.plans[0]!.stop_path.slice(1));
    for (let i = 1; i < actual.length; i++) expect((actual[i]!.price - actual[i - 1]!.price) * (side === 'long' ? 1 : -1)).toBeGreaterThan(0);
  });
  it.each(['chandelier_trail', 'breakeven_after_r', 'swing_structure_stop'])('无 order 的 %s 仍与旧 irExit 一致', primitive => {
    const ir = irOf([node(primitive, primitive === 'chandelier_trail' ? { atr_period: 22, multiple: 3 } : primitive === 'breakeven_after_r' ? { r: 1 } : { lookback: 3 })]); delete ir.order;
    const ks = history(150), t = thread(); let updates = 0;
    for (let n = 101; n <= 150; n++) {
      const rb = toResearchBars(ks, H, T + n * H), ctx = researchContext(rb, viewBars(ir, SYNTH_POLICY, H), H);
      ctx.position = { entry_at: T + 100 * H, entry_price: 100, initial_distance: 10, bars_held: n - 100, high_water: Math.max(...rb.slice(100).map(b => Number(b.high))) }; ctx.fee_rate = 0.001;
      const expected = irExit(ir, ctx, { id: t.id, candidate_id: t.id, entry_at: t.opened_at!, entry_price: q('100'), qty: q('1'), stop: q(t.stop_price!), target: null, entry_fee: 0n, entry_notional: 0n, initial_risk: q('10'), bars_held: n - 100 });
      const got = runExit(ir, t, ks, T + n * H, { initial_stop: '90' }); expect(got).toEqual(expected);
      if (got.stop !== null) { updates++; t.stop_price = decimal(got.stop); }
    }
    expect(updates).toBeGreaterThan(0);
  });
  it('首档保本只认已确认成交且多空都只收紧', () => {
    for (const side of ['long', 'short'] as const) {
      const ir = irOf([], side); ir.order!.breakeven_after_tp = true; const t = thread(side), ks = history(102, side);
      expect(runExit(ir, t, ks, T + 102 * H).stop).toBeNull();
      const moved = runExit(ir, t, ks, T + 102 * H, { first_tp_filled_at: T + 101 * H }); expect(moved.stop).toBe(q(t.filled_avg_price!));
      t.stop_price = side === 'long' ? '101' : '999'; expect(runExit(ir, t, ks, T + 102 * H, { first_tp_filled_at: T + 101 * H }).stop).toBeNull();
    }
  });
  it('移损未知重试同一目标、不推进水位；缺根也不推进', async () => {
    const f = fixture(irOf([node('chandelier_trail', { atr_period: 22, multiple: 3 })])); const { run } = await f.create(); f.signal(null); f.step(102);
    f.deps.moveStop = vi.fn(async () => ({ ok: false, detail: 'unknown CID' }));
    await f.runner.scan(run.id); await f.runner.scan(run.id); const calls = vi.mocked(f.deps.moveStop).mock.calls;
    expect(calls).toHaveLength(2); expect(calls[0]!.slice(1)).toEqual(calls[1]!.slice(1)); expect(f.runner.store.management(f.threads[0]!.id)?.as_of).toBe(T + 100 * H);
    f.deps.moveStop = vi.fn(async (t, stop) => { t.stop_price = stop; return { ok: true, detail: 'confirmed' }; });
    f.setBars(history(102).filter(k => k.open_time !== T + 100 * H)); const result = await f.runner.scan(run.id); expect(result.scan.some(e => e.data?.code === 'management_history_gap')).toBe(true); expect(f.deps.moveStop).not.toHaveBeenCalled();
    f.setBars(history(102)); await f.runner.scan(run.id); expect(f.runner.store.management(f.threads[0]!.id)?.as_of).toBe(T + 102 * H);
  });
});

describe('G4 波动率权重与数量', () => {
  it.each([false, true])('order=%s 候选权重与研究核一致，回看超过信号窗口', order => {
    const ir = irOf(); if (!order) delete ir.order;
    ir.risk.sizing = node('vol_target', { target_vol: 0.3, lookback_bars: 700 });
    const ks = Array.from({ length: 801 }, (_, i) => ({ ...bar(i, i === 800 ? 103 : i % 2 ? 100.3 : 99.7, i === 800 ? 0.2 : 1), volume: i === 800 ? '300' : '100' }));
    const inp = { shadow: { strategy_id: 's', version: 1, ir_hash: 'h', timeframe: '1h', ir, source: 'research_strategy_version' as const, label: 'G4', unmapped: [], horizon_bars: 48, pick_note: '' }, symbol: 'BTCUSDT', klines: { '1h': ks }, now: T + 801 * H };
    const c = generateRunCandidate(inp).candidate!; expect(c).not.toBeNull();
    const rb = toResearchBars(ks, H, inp.now), weight = volTargetWeight(rb, 800, H, { target_vol: 0.3, lookback_bars: 700 }).weight;
    expect(c.size_weight).toBe(weight); expect(c.size_weight).toBeLessThan(1); expect(runHistoryBars(ir, H)).toBe(701);
    if (order) expect(c.size_weight).toBe(orderIntents(ir, rb, H, { fee_rate: '0', slippage_bps: '0', gate: orderGateFor(ir), from_index: 800 }).intents[0]!.size_weight);
  });
  it.each([['spot', 1, 0], ['perp', 3, 0], ['perp', 3, 2]] as const)('%s leverage=%s max_adds=%s 数量与模拟器成交相同', (market, leverage, max_adds) => {
    const ir = irOf(); ir.order!.market = market; ir.order!.leverage = leverage; ir.order!.on_new_signal!.filled = max_adds ? 'add' : 'ignore'; ir.order!.max_adds = max_adds;
    const ks = Array.from({ length: 4 }, (_, i) => bar(i, 100));
    const r = simulateOrders(toOrders(ks), [intent('long', 90, 0.4), null, null, null], { symbol: 'BTCUSDT', market, leverage, timeframe_ms: H, initial_cash: 10000, taker_fee_rate: 0.001, on_new_signal: ir.order!.on_new_signal, max_adds });
    const got = sizeRunOrder({ market, leverage }, { size_weight: 0.4 }, ir, { equity: '10000', cash: '10000', price: '100', fee_rate: '0.001', step_size: '0.00000001', leverage_cap: 3 })!;
    expect(Number(got.qty)).toBeCloseTo(r.plans[0]!.margin! * leverage / 100, 8); expect(Number(got.base_leg_margin)).toBeCloseTo(4000 / (max_adds + 1), 8);
  });
  it('现金/手续费/杠杆封顶/step，缺权重保持原路径，非法权重拒绝', () => {
    const ir = irOf(), r = { market: 'perp' as const, leverage: 5 }, inp = { equity: '10000', cash: '100', price: '100', fee_rate: '0.001', step_size: '0.01', leverage_cap: 2 };
    expect(sizeRunOrder(r, {}, ir, inp)).toBeNull();
    const x = sizeRunOrder(r, { size_weight: 1 }, ir, inp)!; expect(x).toMatchObject({ qty: '1.99000000', leverage: 2 }); expect(Number(x.margin) * 1.002).toBeLessThanOrEqual(100);
    for (const size_weight of [0, -1, NaN, Infinity, 1.1]) expect(() => sizeRunOrder(r, { size_weight }, ir, inp)).toThrow('invalid_run_sizing');
  });
  it('vol_target 缺接线 blocker；接线后所有开仓走 openSized', async () => {
    const ir = irOf(); ir.risk.sizing = node('vol_target', { target_vol: 0.3 }); const f = fixture(ir);
    expect(f.runner.preflight(f.s.id)).toMatchObject({ sizing_mode: 'vol_target', deployable: false });
    f.deps.openSized = vi.fn(async () => ({ outcome: 'opened', reason: 'sized' })); f.signal({ ...candidate(T + 100 * H), size_weight: 0.4 });
    await f.create(); expect(f.deps.openSized).toHaveBeenCalledOnce(); expect(f.deps.open).not.toHaveBeenCalled();
    expect(f.runner.preflight(f.s.id).blockers.map(b => b.code)).not.toContain('vol_target_not_connected');
  });
});

describe('同币新信号：确认旧腿结束后才增风险', () => {
  it('replace 与回测一致；同根重扫不重发，max_open=1 不阻止替换', async () => {
    const f = fixture(); f.signal({ ...candidate(T + 100 * H), entry_type: 'limit' }); const { run } = await f.create({ max_open: 1 });
    f.step(101); const got = await f.runner.scan(run.id); await f.runner.scan(run.id);
    expect(f.deps.cancel).toHaveBeenCalledOnce(); expect(f.deps.open).toHaveBeenCalledTimes(2); expect(f.threads[0]!.status).toBe('canceled'); expect(got.scan.some(e => e.data?.action === 'replace')).toBe(true);
    const ks = Array.from({ length: 4 }, (_, i) => bar(i, 100)); const limit = { ...intent('long', 80), entry: { type: 'limit' as const, price: 90, source: null, note: '' } };
    const sim = simulateOrders(toOrders(ks), [limit, limit, null, null], { symbol: 'BTCUSDT', market: 'spot', leverage: 1, timeframe_ms: H, initial_cash: 10000 });
    expect(sim.plans.map(p => p.status)).toEqual(['replaced', 'pending']);
  });
  it.each(['unknown', 'partial', 'pause'] as const)('撤单 %s 时不发替换腿', async kind => {
    const f = fixture(); f.signal({ ...candidate(T + 100 * H), entry_type: 'limit' }); const { run } = await f.create();
    f.deps.cancel = vi.fn(async t => {
      if (kind === 'partial') { t.status = 'in_position'; t.opened_at = T + 100 * H; t.filled_avg_price = '100'; }
      if (kind === 'pause') { t.status = 'canceled'; await f.runner.patch(run.id, { status: 'paused' }); }
      return { ok: kind !== 'unknown', detail: kind };
    });
    f.step(101); await f.runner.scan(run.id); expect(f.deps.open).toHaveBeenCalledTimes(1);
  });
  it('keep/ignore 不撤不加；默认 roll 继续 warning', async () => {
    const ir = irOf(); ir.order!.on_new_signal = { unfilled: 'keep', filled: 'ignore' };
    const f = fixture(ir); const { run } = await f.create({ mode: 'confirm' }); f.step(101); await f.runner.scan(run.id);
    expect(f.deps.cancel).not.toHaveBeenCalled(); expect(f.deps.open).toHaveBeenCalledTimes(1); expect(f.runner.preflight(f.s.id).warnings.map(w => w.code)).not.toContain('new_signal_policy');
    const roll = irOf(); delete roll.order!.on_new_signal; const g = fixture(roll); expect(g.runner.preflight(g.s.id).warnings.find(w => w.code === 'new_signal_policy')?.message).toContain('roll');
  });
  it('add 沿用首腿额度、不采用新信号权重；max_adds 含在途/未知/待批', async () => {
    const ir = irOf(); ir.order!.on_new_signal!.filled = 'add'; ir.order!.max_adds = 2; const f = fixture(ir); const { run } = await f.create({ max_open: 1 });
    const t = f.threads[0]!; f.positions.set(t.id, { adds: 0, base_leg_margin: '123.45' });
    f.deps.add = vi.fn(async (_r, old, _c, _a, leg) => { expect(leg).toEqual({ max_adds: 2, base_leg_margin: '123.45' }); f.positions.get(old.id)!.adds!++; return { outcome: 'opened', reason: 'pending add', thread_id: old.id }; });
    for (const n of [101, 102, 103]) { f.step(n); await f.runner.scan(run.id); }
    expect(f.deps.add).toHaveBeenCalledTimes(2); expect(f.deps.open).toHaveBeenCalledTimes(1);
    const sized = sizeRunOrder({ market: 'spot', leverage: 1 }, { size_weight: 0.01 }, ir, { equity: '99999', cash: '99999', price: '100', fee_rate: '0', step_size: '0.00000001', leverage_cap: 1, base_leg_margin: '123.45' }); expect(sized!.qty).toBe('1.23450000');
  });
  it('agent 拒绝新信号不撤旧挂单，confirm add 传 manual', async () => {
    const f = fixture(); f.signal({ ...candidate(T + 100 * H), entry_type: 'limit' }); const { run } = await f.create({ mode: 'agent' }); f.step(101);
    f.deps.filter = vi.fn(async () => ({ decision: 'skip', reason: 'no' })); await f.runner.scan(run.id); expect(f.deps.cancel).not.toHaveBeenCalled();
    const ir = irOf(); ir.order!.on_new_signal!.filled = 'add'; const g = fixture(ir); const a = await g.create(); g.positions.set(g.threads[0]!.id, { adds: 0, base_leg_margin: '100' });
    g.deps.add = vi.fn(async () => ({ outcome: 'opened', reason: 'manual pending' })); await g.runner.patch(a.run.id, { mode: 'confirm' }); g.step(101); await g.runner.scan(a.run.id);
    expect(g.deps.add).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 'manual', { base_leg_margin: '100', max_adds: 2 });
  });
  it.each([true, false])('永续反手必须确认平仓=%s；ignore 同向策略也允许反手', async closed => {
    const ir = irOf(); ir.order!.market = 'perp'; const f = fixture(ir); const { run } = await f.create({ max_open: 1 }); f.signal(candidate(T + 101 * H, 'BTCUSDT', 'short'));
    if (!closed) f.deps.close = vi.fn(async () => {});
    f.step(101); const got = await f.runner.scan(run.id); expect(f.deps.close).toHaveBeenCalledOnce(); expect(f.deps.open).toHaveBeenCalledTimes(closed ? 2 : 1);
    if (closed) expect(got.scan.some(e => e.data?.action === 'flip')).toBe(true);
  });
  it('confirm 反手只走整项审批 hook，不先平仓；现货不能反手', async () => {
    for (const market of ['spot', 'perp'] as const) {
      const ir = irOf(); ir.order!.market = market; const f = fixture(ir); const { run } = await f.create(); await f.runner.patch(run.id, { mode: 'confirm' });
      f.deps.flip = vi.fn(async () => ({ outcome: 'opened', reason: 'composite approval' })); f.signal(candidate(T + 101 * H, 'BTCUSDT', 'short')); f.step(101); await f.runner.scan(run.id);
      expect(f.deps.close).not.toHaveBeenCalled(); expect(f.deps.open).toHaveBeenCalledTimes(1); expect(f.deps.flip).toHaveBeenCalledTimes(market === 'perp' ? 1 : 0);
    }
  });
});

describe('R14 雷达币池', () => {
  it('每轮取最新排序、保留掉榜仓位/挂单、事件含增减；重启后保持来源', async () => {
    const f = fixture(); let ranked = ['BTCUSDT', 'ETHUSDT']; f.deps.radarSymbols = vi.fn(async () => ranked);
    const { run } = await f.create({ symbols_source: { kind: 'radar', tier: 'swing', top_n: 2 } });
    expect(f.threads).toHaveLength(2); ranked = ['SOLUSDT', 'XRPUSDT', 'LTCUSDT']; f.step(101); const got = await f.runner.scan(run.id);
    expect(got.run.symbols).toEqual(['SOLUSDT', 'XRPUSDT', 'BTCUSDT', 'ETHUSDT']);
    expect(got.scan.find(e => e.kind === 'scan')!.data).toMatchObject({ symbols_source: { kind: 'radar', tier: 'swing', top_n: 2 }, added: ['SOLUSDT', 'XRPUSDT'], retained: ['BTCUSDT', 'ETHUSDT'], removed: [] });
    f.threads[0]!.status = 'closed'; f.step(102); const after = await f.runner.scan(run.id); expect(after.scan.find(e => e.kind === 'scan')!.data!.removed).toEqual(['BTCUSDT']);
    await f.runner.stop(); const restored = new StrategyRunner(f.deps); cleanup.push(() => restored.stop()); expect(restored.get(run.id).symbols_source).toEqual({ kind: 'radar', tier: 'swing', top_n: 2 });
  });
  it('空榜是空池；雷达失败继续旧仓管理、不用旧榜开仓；恢复可重试', async () => {
    const f = fixture(irOf([node('chandelier_trail', { atr_period: 22, multiple: 3 })])); f.deps.radarSymbols = vi.fn(async () => ['BTCUSDT']); const { run } = await f.create({ symbols_source: { kind: 'radar', tier: 'short', top_n: 1 } });
    f.deps.radarSymbols = vi.fn(async () => { throw new Error('offline'); }); f.step(101); const result = await f.runner.scan(run.id);
    expect(f.deps.moveStop).toHaveBeenCalled(); expect(f.deps.open).toHaveBeenCalledTimes(1); expect(result.run.status).toBe('running'); expect(result.scan.some(e => e.data?.code === 'radar_unavailable')).toBe(true);
    f.threads[0]!.status = 'closed'; f.deps.radarSymbols = vi.fn(async () => []); const empty = await f.runner.scan(run.id); expect(empty.run.symbols).toEqual([]);
    f.deps.radarSymbols = vi.fn(async () => ['ETHUSDT']); await f.runner.scan(run.id); expect(f.deps.open).toHaveBeenCalledTimes(2);
  });
  it('缺省 fixed 兼容旧 JSON；POST/PATCH/预检严格拒绝无效来源，缺接线 blocker', async () => {
    const f = fixture();
    for (const symbols_source of [null, [], { kind: 'radar', tier: 'mid', top_n: 2 }, { kind: 'radar', tier: 'short', top_n: 0 }, { kind: 'radar', tier: 'short', top_n: 31 }, { kind: 'radar', tier: 'short', top_n: 1.5 }, { kind: 'fixed', top_n: 1 }]) expect(() => f.create({ symbols_source })).toThrow();
    const source = { kind: 'radar' as const, tier: 'weekly' as const, top_n: 3 };
    expect(f.runner.preflight(f.s.id, undefined, undefined, source).blockers.map(b => b.code)).toContain('radar_not_connected');
    const { run } = await f.create(); expect(run.symbols_source).toEqual({ kind: 'fixed' }); const saved = f.runner.store.require(run.id); delete saved.symbols_source; f.runner.store.save(saved); expect(f.runner.get(run.id).symbols_source).toEqual({ kind: 'fixed' });
    await expect(f.runner.patch(run.id, { symbols_source: source })).rejects.toMatchObject({ code: 'radar_not_connected' });
    expect(() => f.runner.patch(run.id, { symbols_source: { kind: 'radar', tier: 'weekly', top_n: '3' } })).toThrow();
    f.deps.radarSymbols = vi.fn(async () => ['SOLUSDT']); await f.runner.patch(run.id, { symbols_source: source }); await f.runner.scan(run.id); expect(f.deps.radarSymbols).toHaveBeenCalledWith('weekly', 3);
  });
  it('雷达 await 期间暂停不会更新币池或开仓', async () => {
    const f = fixture(); f.deps.radarSymbols = vi.fn(async () => ['BTCUSDT']); const { run } = await f.create({ symbols_source: { kind: 'radar', tier: 'short', top_n: 2 } });
    f.deps.radarSymbols = vi.fn(async () => { await f.runner.patch(run.id, { status: 'paused' }); return ['ETHUSDT']; }); f.step(101); await f.runner.scan(run.id);
    expect(f.runner.get(run.id)).toMatchObject({ status: 'paused', symbols: ['BTCUSDT'] }); expect(f.deps.open).toHaveBeenCalledTimes(1);
  });
});

it('预检 warning 夹具统计：能力接好只剩 roll，缺接线如实保留', () => {
  const cases = [irOf([node('chandelier_trail', { atr_period: 22, multiple: 3 })]), irOf([node('breakeven_after_r', { r: 1 })]), irOf([node('swing_structure_stop', { lookback: 3 })]), irOf(), irOf()];
  cases[3]!.order!.on_new_signal!.filled = 'add'; cases[4]!.order!.on_new_signal!.filled = 'roll';
  const count = { trailing_not_connected: 0, new_signal_policy: 0 };
  for (const ir of cases) {
    const f = fixture(ir); f.deps.add = vi.fn(async () => ({ outcome: 'opened', reason: 'fixture' }));
    for (const warning of f.runner.preflight(f.s.id).warnings) if (warning.code in count) count[warning.code as keyof typeof count]++;
  }
  expect(count).toEqual({ trailing_not_connected: 0, new_signal_policy: 1 }); // 原实现 3/5
  // 复审 High-4:缺接线从 warning 升为 blocker(回测与实盘两套规则不允许运行)
  const f = fixture(cases[0]!); delete f.deps.moveStop; expect(f.runner.preflight(f.s.id).blockers.map(w => w.code)).toContain('trailing_not_connected');
  const g = fixture(cases[3]!); delete g.deps.add; expect(g.runner.preflight(g.s.id).blockers.map(w => w.code)).toContain('add_not_connected');
});

describe('对抗复查边界', () => {
  it.each(['missing', 'unknown', 'throw'] as const)('移损 %s 不能阻断后来补根触发的 time_stop', async mode => {
    const f = fixture(irOf([node('chandelier_trail', { atr_period: 22, multiple: 3 }), node('time_stop', { bars: 3 })])); const { run } = await f.create(); f.signal(null); f.step(104);
    if (mode === 'missing') delete f.deps.moveStop;
    else f.deps.moveStop = vi.fn(async () => { if (mode === 'throw') throw new Error('timeout'); return { ok: false, detail: 'unknown' }; });
    await f.runner.scan(run.id); expect(f.deps.close).toHaveBeenCalledOnce(); expect(f.threads[0]!.status).toBe('closed');
  });
  it('空雷达榜 + universe.screen 合法且可重试', async () => {
    const ir = irOf(); ir.universe = { screen: { top_n: 3 } }; const f = fixture(ir); f.deps.radarSymbols = vi.fn(async () => []);
    const result = await f.create({ symbols_source: { kind: 'radar', tier: 'short', top_n: 1 } }); expect(result.run.status).toBe('running'); expect(result.run.symbols).toEqual([]); expect(f.deps.open).not.toHaveBeenCalled();
  });
  it('步长 1e-8 时不四舍五入透支现金', () => {
    const got = sizeRunOrder({ market: 'spot', leverage: 1 }, { size_weight: 1 }, irOf(), { equity: '1', cash: '1', price: '6', fee_rate: '0', step_size: '0.00000001', leverage_cap: 1 })!;
    expect(got.qty).toBe('0.16666666'); expect(Number(got.qty) * 6).toBeLessThanOrEqual(1);
  });
  it.each(['replace', 'flip'] as const)('%s 旧腿延迟确认可重启续接；不重问 Agent/不重撤平', async action => {
    const ir = irOf(); ir.order!.market = 'perp'; const f = fixture(ir);
    if (action === 'replace') f.signal({ ...candidate(T + 100 * H), entry_type: 'limit' });
    const { run } = await f.create({ mode: 'agent' }); f.step(101);
    if (action === 'replace') f.deps.cancel = vi.fn(async () => ({ ok: false, detail: 'unknown' }));
    else { f.signal(candidate(T + 101 * H, 'BTCUSDT', 'short')); f.deps.close = vi.fn(async () => {}); }
    await f.runner.scan(run.id); expect(f.deps.open).toHaveBeenCalledTimes(1); expect(f.runner.store.transitions(run.id)).toHaveLength(1);
    f.threads[0]!.status = action === 'replace' ? 'canceled' : 'closed'; await f.runner.stop(); const restored = new StrategyRunner(f.deps); cleanup.push(() => restored.stop());
    await restored.scan(run.id); await restored.scan(run.id); expect(f.deps.open).toHaveBeenCalledTimes(2); expect(f.deps.filter).toHaveBeenCalledTimes(2); expect(restored.store.transitions(run.id)).toHaveLength(0);
    expect(action === 'replace' ? f.deps.cancel : f.deps.close).toHaveBeenCalledOnce();
  });
  it('新腿 unknown 不再次提交；候选过期时不续接', async () => {
    const f = fixture(); f.signal({ ...candidate(T + 100 * H), entry_type: 'limit' }); const { run } = await f.create(); f.step(101);
    f.deps.open = vi.fn(async () => ({ outcome: 'unknown', reason: 'unknown' })); await f.runner.scan(run.id); await f.runner.scan(run.id); expect(f.deps.open).toHaveBeenCalledOnce(); expect(f.runner.store.transitions(run.id)[0]?.phase).toBe('opening');
    const g = fixture(); g.signal({ ...candidate(T + 100 * H), entry_type: 'limit', entry_expires_at: T + 102 * H }); const a = await g.create(); g.step(101);
    g.deps.cancel = vi.fn(async () => ({ ok: false, detail: 'unknown' })); await g.runner.scan(a.run.id); g.threads[0]!.status = 'canceled'; g.signal(null); g.step(103); await g.runner.scan(a.run.id);
    expect(g.deps.open).toHaveBeenCalledTimes(1); expect(g.runner.store.transitions(a.run.id)).toHaveLength(0);
  });
});

it('新腿 unknown 可按候选身份只读对账恢复，查不到不视为拒绝', async () => {
  const f = fixture(); f.signal({ ...candidate(T + 100 * H), entry_type: 'limit' }); const { run } = await f.create(); f.step(101);
  f.deps.open = vi.fn(async () => ({ outcome: 'unknown', reason: 'lost receipt', thread_id: 'new_known_id' })); await f.runner.scan(run.id);
  const x = f.runner.store.transitions(run.id)[0]!; expect(x.new_thread_id).toBe('new_known_id');
  f.deps.reconcileOpen = vi.fn(async () => null); await f.runner.scan(run.id); expect(f.runner.store.transitions(run.id)).toHaveLength(1); expect(f.deps.open).toHaveBeenCalledOnce();
  f.deps.reconcileOpen = vi.fn(async () => ({ outcome: 'opened', reason: 'original CID filled', thread_id: 'new_known_id' }));
  await f.runner.scan(run.id); expect(f.runner.store.transitions(run.id)).toHaveLength(0); expect(f.deps.open).toHaveBeenCalledOnce(); expect(f.deps.reconcileOpen).toHaveBeenCalledWith(expect.anything(), x.candidate.id, 'new_known_id');
});

it.each(['long', 'short'] as const)('订单 %s 单独保本移损与模拟 stop_path 同口径(含费)', side => {
  const ir = irOf([node('breakeven_after_r', { r: 1 })], side), ks = history(150, side), rb = toResearchBars(ks, H, T + 150 * H), stop = side === 'long' ? 90 : 1010;
  const sim = simulateOrders(toOrders(ks), ks.map((_, i) => i === 99 ? intent(side, stop) : null), { symbol: 'BTCUSDT', market: side === 'long' ? 'spot' : 'perp', leverage: 1, timeframe_ms: H, initial_cash: 10000, taker_fee_rate: 0.001 }, orderManager(ir, rb, H, { fee_rate: '0.001', view: viewBars(ir, SYNTH_POLICY, H) }));
  const t = thread(side, T + 100 * H + 30000, String(stop)); t.filled_avg_price = ks[100]!.open;
  const got: { at: number; price: number }[] = [];
  for (let n = 101; n <= 150; n++) {
    const out = runExit(ir, t, ks, T + n * H, { initial_stop: String(stop), fee_rate: '0.001' });
    if (out.stop !== null) { t.stop_price = decimal(out.stop); got.push({ at: T + n * H - 1, price: Number(t.stop_price) }); }
  }
  expect(got).toHaveLength(1); expect(got).toEqual(sim.plans[0]!.stop_path.slice(1));
});

it('vol_target 同一历史的候选→权重→目标数量→模拟成交端到端对拍', () => {
  const ir = irOf(); ir.risk.sizing = node('vol_target', { target_vol: 0.3, lookback_bars: 80 });
  const ks = Array.from({ length: 103 }, (_, i) => ({ ...bar(i, i >= 100 ? 103 : i % 2 ? 100.3 : 99.7, i >= 100 ? 0.2 : 1), volume: i === 100 ? '300' : '100' }));
  const as_of = T + 101 * H, c = generateRunCandidate({ shadow: { strategy_id: 's', version: 1, ir_hash: 'h', timeframe: '1h', ir, source: 'research_strategy_version', label: 'G4', unmapped: [], horizon_bars: 48, pick_note: '' }, symbol: 'BTCUSDT', klines: { '1h': ks }, now: as_of }).candidate!;
  const research = toResearchBars(ks, H, T + 103 * H), all = orderIntents(ir, research, H, { fee_rate: '0', slippage_bps: '0', gate: orderGateFor(ir), view: viewBars(ir, SYNTH_POLICY, H) });
  const sim = simulateOrders(toOrders(ks), all.intents, { symbol: 'BTCUSDT', market: 'spot', leverage: 1, timeframe_ms: H, initial_cash: 10000, taker_fee_rate: 0.001 });
  const plan = sim.plans.find(p => p.placed_at === as_of - 1)!; expect(plan.filled_at).toBe(as_of);
  const qty = sizeRunOrder({ market: 'spot', leverage: 1 }, c, ir, { equity: '10000', cash: '10000', price: ks[101]!.open, fee_rate: '0.001', step_size: '0.00000001', leverage_cap: 1 })!;
  expect(Number(qty.qty)).toBe(Math.floor(plan.margin! / plan.fill_price! * 1e8) / 1e8); expect(c.size_weight).toBe(all.intents[100]!.size_weight);
});

it('入场滑点越过 bar 极值时，水位仍按回测 bar high/low 初始化', async () => {
  const ir = irOf([node('chandelier_trail', { atr_period: 22, multiple: 3 })]), f = fixture(ir), ks = Array.from({ length: 101 }, (_, i) => bar(i, 100));
  const { run } = await f.create(); f.threads[0]!.filled_avg_price = '110'; f.signal(null); f.step(101); f.setBars(ks);
  const got = await f.runner.scan(run.id);
  const sim = simulateOrders(toOrders(ks), ks.map((_, i) => i === 99 ? intent('long', 90) : null), { symbol: 'BTCUSDT', market: 'spot', leverage: 1, timeframe_ms: H, initial_cash: 10000, slippage_bps: 1000 }, orderManager(ir, toResearchBars(ks, H, T + 101 * H), H, { fee_rate: '0.001', view: viewBars(ir, SYNTH_POLICY, H) }));
  expect(got.scan.filter(e => e.kind === 'stop_moved').map(e => Number(e.data!.new_stop))).toEqual(sim.plans[0]!.stop_path.slice(1).map(x => x.price));
  expect(f.threads[0]!.stop_price).toBe('95.00000000');
});
