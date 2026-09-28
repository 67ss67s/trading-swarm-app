/** 结构口径(2026-09-23):止盈止损按图上结构放、盈亏比不拦单、止损 <0.5×ATR 不做、不按 R 补止盈。
 * 另含与几何实验室(geometry-lab/core.ts,只读 import)同一段数据同一信号的价位对拍。 */
import { describe, it, expect } from 'vitest';
import type { ResearchBar, ResearchRequest, StrategyIR } from '@trade-gate/contracts';
import { pivots, viewAt, findCandidates, armA, enumerateLevels, stopAtr, DEFAULT_SIGNAL } from '../../../src/demo/geometry-lab/core.js';
import { registry } from '../../../src/demo/research/primitives/index.js';
import { atrSeries } from '../../../src/demo/research/primitives/indicators.js';
import { structure } from '../../../src/demo/research/primitives/structure.js';
import { DEFAULT_ORDER_GATE, LEGACY_ORDER_GATE, MIN_STOP_ATR_DEFAULT, evaluateOrderGate, orderGateFor, isStructureGate, stopTooClose } from '../../../src/demo/research/order-gate.js';
import { simulateOrders, runOrderPath, resolveOrder, defaultTakeProfits, ORDERS_ENGINE_VERSION_V2, type OrderBar, type PlanIntent, type OrderExecParams } from '../../../src/demo/research/orders/index.js';
import { runReplay, FAST_ENGINE_VERSION_STRUCTURE } from '../../../src/demo/research/engine.js';
import { node, repairIR, compileConstraints, dropUnrequestedFixedR, checkIR } from '../../../src/demo/research/strategy.js';
import { checkIRSpec, specText, STRATEGY_SPEC_VERSION } from '../../../src/demo/research/strategy-spec.js';
import { synthBars, synthDataset } from './backtest-report-fixtures.js';

const H = 3600000, T0 = Date.UTC(2026, 0, 1);
const rb = (i: number, o: number, h: number, l: number, c: number): ResearchBar => ({ open_time: T0 + i * H, close_time: T0 + (i + 1) * H - 1, available_at: T0 + (i + 1) * H - 1, open: String(o), high: String(h), low: String(l), close: String(c), volume: '100' });
const ctxOf = (bars: ResearchBar[], side?: 'long' | 'short') => ({ bars, i: bars.length - 1, timeframe_ms: H, ...(side ? { side } : {}) });
const tgt = (bars: ResearchBar[], p: Record<string, unknown> = {}, side?: 'long' | 'short') => registry.get('pivot_target')!.compute(ctxOf(bars, side), { swing_length: 3, ...p }).target;
const stp = (bars: ResearchBar[], p: Record<string, unknown> = {}, side?: 'long' | 'short') => registry.get('pivot_stop')!.compute(ctxOf(bars, side), { swing_length: 3, ...p }).stop;

/** 手工形态:平台 100 → 冲高 110(摆动高点)→ 回落 104,再横盘;ATR ≈ 2 */
function shaped(extra: [number, number, number, number][] = []): ResearchBar[] {
  const rows: [number, number, number, number][] = [];
  for (let i = 0; i < 30; i++) rows.push([100, 101, 99, 100]);
  rows.push([100, 104, 99.5, 103], [103, 107, 102.5, 106], [106, 110, 105, 108], [108, 108.5, 104, 105], [105, 106, 102, 103], [103, 104, 101, 102], [102, 104.5, 101.5, 104]);
  rows.push(...extra);
  return rows.map(([o, h, l, c], i) => rb(i, o, h, l, c));
}

describe('pivot_target / pivot_stop:图上的结构价位', () => {
  it('止盈取入场上方最近的未被扫的摆动高点;止损取下方最近摆动低点再让 0.1 ATR', () => {
    const bars = shaped();
    const a = atrSeries(bars, 14).at(-1)!;
    expect(tgt(bars, { min_atr: 0 })).toBe(110);
    const lows = pivots(bars, 3, 3).filter((p) => p.kind === 'low' && p.price < 104).map((p) => p.price);
    expect(stp(bars)).toBeCloseTo(Math.max(...lows) - 0.1 * a, 10);
  });
  it('上方没有结构(一路创新高)→ 不设止盈;被扫过的高点不算', () => {
    const up = Array.from({ length: 60 }, (_, i) => rb(i, 100 + i, 101.5 + i, 99.5 + i, 101 + i));
    expect(tgt(up, { min_atr: 0 })).toBeUndefined();
    // 110 的高点之后有 111 扫过它,再跌回 104:110 已被扫,缺省不取;unswept=false 才取
    const swept = shaped([[104, 111, 103.5, 105], [105, 105.5, 103, 103.5], [103.5, 104, 102.5, 103], [103, 103.5, 102, 102.5], [102.5, 103.5, 102, 103]]);
    const s = structure(swept, 3);
    expect(s.pivots.some((p) => p.kind === 'high' && Number(p.price) === 111)).toBe(true);
    expect(tgt(swept, { min_atr: 0, unswept: false })).toBe(110);
    expect(tgt(swept, { min_atr: 0 })).toBe(111);
  });
  it('目标太近(<min_atr)或太远(>max_atr)都不取;空单镜像', () => {
    const bars = shaped();
    const a = atrSeries(bars, 14).at(-1)!, d = (110 - 104) / a;
    expect(tgt(bars, { min_atr: d + 0.01 })).toBeUndefined();
    expect(tgt(bars, { min_atr: 0, max_atr: d - 0.01 })).toBeUndefined();
    const lows = pivots(bars, 3, 3).filter((p) => p.kind === 'low' && p.price < 104).map((p) => p.price);
    expect(tgt(bars, { min_atr: 0 }, 'short')).toBe(Math.max(...lows));
    const highs = pivots(bars, 3, 3).filter((p) => p.kind === 'high' && p.price > 104).map((p) => p.price);
    expect(stp(bars, {}, 'short')).toBeCloseTo(Math.min(...highs) + 0.1 * a, 10);
  });
});

describe('与几何实验室 arm A 对拍(同一段数据同一信号)', () => {
  const all = synthBars(3000, H, 23, Date.UTC(2026, 0, 1), 100);
  const cands = findCandidates('SYN', all, DEFAULT_SIGNAL);
  it('候选足够;ATR 同一定义', () => {
    expect(cands.length).toBeGreaterThan(20);
    for (const c of cands) expect(atrSeries(viewAt('SYN', all, c.as_of).bars.slice(), 14).at(-1)).toBeCloseTo(c.atr14, 12);
  });
  it('pivot_target{unswept:false,min_atr:1,max_atr:6} 与 armA 目标逐笔一致;缺省(只取未被扫)差异只来自被扫过的高点', () => {
    let same = 0, differ = 0;
    for (const c of cands) {
      const v = viewAt('SYN', all, c.as_of), bars = v.bars.slice(), g = armA(v);
      expect(tgt(bars, { unswept: false, min_atr: 1, max_atr: 6 }) ?? null).toBe(g.target);
      const mine = tgt(bars) ?? null;
      if (mine === g.target) { same++; continue; }
      differ++;
      // armA 取的高点之后有更高的高点扫过它
      if (g.target !== null) { const k = pivots(bars, 3, 3).find((p) => p.kind === 'high' && p.price === g.target)!.index; expect(Math.max(...bars.slice(k + 1).map((b) => Number(b.high)))).toBeGreaterThan(g.target); }
    }
    expect(same + differ).toBe(cands.length);
  });
  it('pivot_stop{pick:nearest} = 几何实验室 D 臂菜单里的「1h swing low #1 −0.1ATR」;缺省 recent 取时间上最近的摆动低点;止血规则与 stopRule 同口径', () => {
    let compared = 0;
    for (const c of cands) {
      const v = viewAt('SYN', all, c.as_of), bars = v.bars.slice(), s = stp(bars, { pick: 'nearest' })!, menu = enumerateLevels(v);
      const recent = pivots(bars, 3, 3).filter((p) => p.kind === 'low' && p.price < c.ref_close).at(-1)!;
      expect(stp(bars)).toBeCloseTo(recent.price - 0.1 * c.atr14, 9);
      const opt = menu.stops.find((x) => x.kind === 'swing_low_1h' && x.label.startsWith('1h swing low #1'));
      if (opt) { expect(s).toBeCloseTo(opt.price!, 9); compared++; }
      const row = { ref_close: c.ref_close, atr14: c.atr14, g: { stop: s, target: null, rationale: '', source_levels: [], flags: [] } };
      expect(stopTooClose(c.ref_close, s, c.atr14, MIN_STOP_ATR_DEFAULT)).toBe(stopAtr(row) < MIN_STOP_ATR_DEFAULT - 1e-9);
    }
    expect(compared).toBeGreaterThan(10);
  });
});

describe('order_gate 结构口径', () => {
  const costs = { fee_rate: '0.001', slippage_bps: '5' };
  it('缺省是结构口径;旧口径常量保持原值', () => {
    expect(isStructureGate(DEFAULT_ORDER_GATE)).toBe(true);
    expect(DEFAULT_ORDER_GATE).toMatchObject({ min_rr: 0, require_target: false, stop_floor: 'none', target_fallback_r: null, min_stop_atr: 0.5 });
    expect(isStructureGate(LEGACY_ORDER_GATE)).toBe(false);
    expect(LEGACY_ORDER_GATE).toMatchObject({ min_rr: 1.5, min_stop_cost_multiple: 8, stop_floor: 'widen', target_fallback_r: 2 });
  });
  it('盈亏比不拦单;止损 <0.5×ATR 才拦(只在给了决策时刻 ATR 时判)', () => {
    const base = { side: 'long' as const, entry: '100', costs, equity: '10000', qty: null, params: DEFAULT_ORDER_GATE };
    expect(evaluateOrderGate({ ...base, stop: '98', target: '100.5', atr: 2 }).ok).toBe(true);
    expect(evaluateOrderGate({ ...base, stop: '98', target: '100.5', atr: 2 }).rr).toBeCloseTo(0.25, 10);
    expect(evaluateOrderGate({ ...base, stop: '99.5', target: null, atr: 2 }).blocked_by).toEqual(['stop_too_close']);
    expect(evaluateOrderGate({ ...base, stop: '99.5', target: null }).ok).toBe(true);
    // 旧口径同一输入:成本下限与盈亏比都拦
    expect(evaluateOrderGate({ ...base, stop: '99.5', target: '100.5', params: LEGACY_ORDER_GATE }).blocked_by).toEqual(['min_rr', 'stop_too_tight']);
  });
  it('orderGateFor:只有用户原话的 order.min_rr 才是门槛', () => {
    const ir: StrategyIR = { version: 1, label: 'x', description: 'x', signal: [node('ema_cross', { fast: 5, slow: 20 })], entry: node('next_open_market', {}), risk: { stop: node('pivot_stop', { swing_length: 3 }), sizing: node('equal_notional', { max_allocation: '1' }) }, exit: [node('pivot_target', { swing_length: 3 })] };
    expect(orderGateFor(ir)).toMatchObject({ min_rr: 0, require_target: false, target_fallback_r: null });
    expect(orderGateFor({ ...ir, order: { direction: 'long', market: 'spot', min_rr: 2 } })).toMatchObject({ min_rr: 2, require_target: true });
  });
});

describe('订单执行核:stop_too_close / 不拦 RR / 不补 2R', () => {
  const ob = (i: number, o: number, h: number, l: number, c: number): OrderBar => ({ open_time: T0 + i * H, close_time: T0 + (i + 1) * H - 1, open: o, high: h, low: l, close: c, volume: 1 });
  const flat = (n: number) => Array.from({ length: n }, (_, i) => ob(i, 100, 100.5, 99.5, 100));
  const it0 = (o: Partial<PlanIntent>): PlanIntent => ({ side: 'long', reason: 't', entry: { type: 'market', price: null, source: null, note: '' }, reference_price: 100, expiry_bars: 3, stop: { price: 95, source: 'structure_support', note: '' }, take_profits: [], min_rr: null, ...o });
  const P: OrderExecParams = { symbol: 'X', market: 'spot', leverage: 1, timeframe_ms: H, initial_cash: 10000, taker_fee_rate: 0, maker_fee_rate: 0, slippage_bps: 0, structure: true };
  it('止损离参考价 <0.5×ATR → blocked stop_too_close(计入 blocked_by,planned_rr 照算);够远的正常下单', () => {
    const bars = flat(10), at: (PlanIntent | null)[] = bars.map(() => null);
    at[1] = it0({ stop: { price: 99.5, source: 'structure_support', note: '' }, take_profits: [{ price: 101, size_pct: 1, source: 'structure_resistance', note: '' }], atr: 2, min_stop_atr: 0.5 });
    at[5] = it0({ atr: 2, min_stop_atr: 0.5 });
    const r = simulateOrders(bars, at, P);
    expect(r.engine_version).toBe(ORDERS_ENGINE_VERSION_V2);
    const blocked = r.plans.find((p) => p.status === 'blocked')!;
    expect(blocked.blocked_reason).toBe('stop_too_close');
    expect(blocked.planned_rr).toBeCloseTo(2, 10);
    expect(r.stats.blocked_by).toEqual({ stop_too_close: 1 });
    const placed = r.plans.find((p) => p.status !== 'blocked')!;
    expect(placed.filled_at).not.toBeNull();
    expect(placed.take_profits).toEqual([]);
    expect(placed.planned_rr).toBeNull();
  });
  it('RR 低也下单(min_rr=null);用户 min_rr 仍拦', () => {
    const bars = flat(6), at: (PlanIntent | null)[] = bars.map(() => null);
    at[1] = it0({ take_profits: [{ price: 101, size_pct: 1, source: 'structure_resistance', note: '' }], atr: 2, min_stop_atr: 0.5 });
    expect(simulateOrders(bars, at, P).plans[0]!.status).not.toBe('blocked');
    at[1] = { ...at[1]!, min_rr: 2 };
    expect(simulateOrders(bars, at, P).plans[0]!.blocked_reason).toBe('min_rr');
  });
  it('resolveOrder / defaultTakeProfits:缺省止盈 pivot_target,信号离场型不补,min_rr 只认订单块', () => {
    const base: StrategyIR = { version: 1, label: 'x', description: 'x', signal: [node('ema_cross', { fast: 5, slow: 20 })], entry: node('next_open_market', {}), risk: { stop: node('pivot_stop', { swing_length: 3 }), sizing: node('equal_notional', { max_allocation: '1' }) }, exit: [node('chandelier_trail', { atr_period: 22, multiple: 3 })], order: { direction: 'long', market: 'spot' } };
    expect(defaultTakeProfits(base, H, true)).toEqual([{ source: { primitive: 'pivot_target', params: { swing_length: 3 } }, size_pct: 1 }]);
    expect(defaultTakeProfits({ ...base, exit: [node('indicator_cross_exit', { indicator: 'ema', args: { period: 5 }, compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: 20 }, direction: 'cross_below' })] }, H, true)).toEqual([]);
    expect(resolveOrder(base, H, DEFAULT_ORDER_GATE)!.min_rr).toBeNull();
    expect(resolveOrder({ ...base, order: { ...base.order!, min_rr: 2 } }, H, DEFAULT_ORDER_GATE)!.min_rr).toBe(2);
    expect(resolveOrder(base, H, LEGACY_ORDER_GATE)!.min_rr).toBe(1.5);
  });
  it('全链路:没有 fallback_r 止盈、有 stop_too_close 统计、engine v2', () => {
    const d = synthDataset(1200, H, 'BTCUSDT', 5);
    const ir: StrategyIR = { version: 1, label: 'x', description: 'x', signal: [node('donchian_breakout', { lookback: 20, basis: 'close' })], entry: node('next_open_market', {}), risk: { stop: node('pivot_stop', { swing_length: 3 }), sizing: node('equal_notional', { max_allocation: '1' }) }, exit: [node('chandelier_trail', { atr_period: 22, multiple: 3 })], order: { direction: 'long', market: 'spot' } };
    const r = runOrderPath({ ir, bars: d.bars, timeframe_ms: H, symbol: 'BTCUSDT', from_index: 300, to_index: 1190, initial_cash: 10000, fee_rate: '0.001', slippage_bps: '5', gate: orderGateFor(ir) });
    expect(r.engine_version).toBe(ORDERS_ENGINE_VERSION_V2);
    expect(r.plans.some((p) => p.take_profits.some((t) => t.source === 'rr'))).toBe(false);
    expect(r.plans.filter((p) => p.status !== 'blocked').some((p) => p.take_profits.length === 0)).toBe(true);
    expect(r.plans.filter((p) => p.status !== 'blocked').some((p) => p.take_profits.length > 0 && p.take_profits[0]!.source === 'structure_resistance')).toBe(true);
    expect(r.plans.every((p) => p.status !== 'blocked' || ['stop_too_close', 'stop_side', 'no_stop'].includes(p.blocked_reason!))).toBe(true);
    expect(r.stats.blocked_by).toBeDefined();
  });
});

describe('engine v4 路径(无订单块)与执行核同一口径', () => {
  it('决策时刻止损 <0.5×ATR → blocked stop_too_close;不拦 RR、不补 2R;engine 记 v5', async () => {
    const d = synthDataset(900, H, 'BTCUSDT', 9);
    const mk = (stop: ReturnType<typeof node>): StrategyIR => ({ version: 1, label: 'x', description: 'x', signal: [node('donchian_breakout', { lookback: 20, basis: 'close' })], entry: node('next_open_market', {}), risk: { stop, sizing: node('equal_notional', { max_allocation: '1' }) }, exit: [node('chandelier_trail', { atr_period: 22, multiple: 3 }), node('pivot_target', { swing_length: 3 })] });
    const req = (ir: StrategyIR) => ({ idempotency_key: 'k', dataset_id: 'd', study_id: 's', strategy_ir: ir, execution: { initial_cash: '10000', risk_fraction: '0.01', max_allocation: '1', fee_rate: '0.001', slippage_bps: '5', qty_step: '0.00000001', min_notional: '5', max_opens_per_day: 10, sizing_mode: 'unit_notional' }, order_gate: orderGateFor(ir), from_ms: d.bars[300]!.close_time, to_ms: d.bars[890]!.close_time, arms: ['a_rules'], repeats: 1, max_model_calls: 0, timeout_ms: 60000, purpose: 'development', acknowledge_adaptive_search: true, spec_version: `${STRATEGY_SPEC_VERSION};engine=v4` }) as ResearchRequest;
    const none = async () => { throw new Error('no model'); };
    const tight = (await runReplay(d, req(mk(node('atr_stop', { atr_period: 14, multiple: 0.3 }))), none, { fast: true })).arms[0]!;
    expect(tight.trades.length).toBe(0);
    expect(tight.decisions.some((x) => x.action === 'blocked' && x.gate_errors.includes('stop_too_close'))).toBe(true);
    const out = await runReplay(d, req(mk(node('pivot_stop', { swing_length: 3 }))), none, { fast: true });
    expect(out.engine_version).toBe(FAST_ENGINE_VERSION_STRUCTURE);
    const arm = out.arms[0]!;
    expect(arm.decisions.some((x) => ['min_rr', 'no_target', 'stop_too_tight'].some((g) => x.gate_errors.includes(g)))).toBe(false);
    expect(arm.decisions.every((x) => x.fit === undefined || (x.fit.target_source !== 'fallback_r' && x.fit.stop_source !== 'cost_floor'))).toBe(true);
    expect(arm.trades.length).toBeGreaterThan(0);
  });
});

describe('编译补全与策略规范 v2', () => {
  const c = compileConstraints('1h', null, undefined, DEFAULT_ORDER_GATE);
  it('约束带 min_stop_atr,规范正文是 v2', () => {
    expect(c.min_stop_atr).toBe(0.5);
    expect(c.min_rr).toBe(0);
    expect(specText(c, 'compile')).toContain(STRATEGY_SPEC_VERSION);
    expect(specText(c, 'compile')).toMatch(/不能用「1\.5 倍 \/ 2R」/);
    expect(specText(compileConstraints('1h', null, undefined, LEGACY_ORDER_GATE), 'compile')).toContain('strategy-spec/v1');
  });
  it('repairIR 缺省:结构止损 + 结构止盈 + 吊灯追踪,不补固定 R;信号离场不补;原话不要追踪就不补', () => {
    const raw = { version: 1, label: 'x', description: 'x', signal: [node('ema_cross', { fast: 5, slow: 20 })], exit: [] };
    const r = repairIR(structuredClone(raw), c).ir as StrategyIR;
    expect(r.risk.stop.primitive).toBe('pivot_stop');
    expect(r.exit.map((x) => x.primitive)).toEqual(['pivot_target', 'chandelier_trail']);
    expect(checkIR(r, '1h').ok).toBe(true);
    expect(checkIRSpec(r, c).ok).toBe(true);
    const sig = repairIR({ ...structuredClone(raw), exit: [node('indicator_cross_exit', { indicator: 'ema', args: { period: 5 }, compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: 20 }, direction: 'cross_below' })] }, c).ir as StrategyIR;
    expect(sig.exit.map((x) => x.primitive)).toEqual(['indicator_cross_exit']);
    const noTrail = repairIR(structuredClone(raw), c, 'EMA 金叉买,不要追踪止损').ir as StrategyIR;
    expect(noTrail.exit.map((x) => x.primitive)).toEqual(['pivot_target']);
    // 订单块缺省止损同样是结构止损(不是 1d 结构块下沿)
    const ord = repairIR({ ...structuredClone(raw), order: { direction: 'long', market: 'spot' } }, c).ir as StrategyIR;
    expect(ord.risk.stop.primitive).toBe('pivot_stop');
    // 用户说「止盈看前高」(结构止盈可能缺位)→ 补追踪兜底
    const liq = repairIR({ ...structuredClone(raw), order: { direction: 'long', market: 'spot', take_profits: [{ source: node('smc_liquidity_target', {}) }] } }, c).ir as StrategyIR;
    expect(liq.exit.map((x) => x.primitive)).toEqual(['chandelier_trail']);
  });
  it('原话没要 R 倍数止盈 → 去掉 fixed_r_target;原话要了就保留', () => {
    const ir = { exit: [node('fixed_r_target', { r: 2 }, true), node('chandelier_trail', { atr_period: 22, multiple: 3 })], order: { take_profits: [{ source: node('fixed_r_target', { r: 1.5 }) }] } };
    const a = structuredClone(ir);
    expect(dropUnrequestedFixedR('BTC 突破做多,盈亏比至少 2', a).length).toBe(2);
    expect(a.exit.map((x) => x.primitive)).toEqual(['chandelier_trail']);
    expect('take_profits' in a.order).toBe(false);
    const b = structuredClone(ir);
    expect(dropUnrequestedFixedR('突破做多,2R 止盈', b)).toEqual([]);
    expect(dropUnrequestedFixedR('止盈 3 倍风险', structuredClone(ir))).toEqual([]);
  });
  it('规范 v2:盈亏比/缺止盈不 block;R 倍数止盈 warn;ATR 止损低于 0.5 倍 block', () => {
    const base: StrategyIR = { version: 1, label: 'x', description: '持有约 20 根,每 1000 根约 10 个信号', signal: [node('ema_cross', { fast: 5, slow: 20 })], entry: node('next_open_market', {}), risk: { stop: node('pivot_stop', { swing_length: 3 }), sizing: node('equal_notional', { max_allocation: '1' }) }, exit: [node('chandelier_trail', { atr_period: 22, multiple: 3 })], regime: node('htf_structure_regime', { htf: '4h', swing_length: 3 }) };
    const r1 = checkIRSpec(base, c);
    expect(r1.ok).toBe(true); expect(r1.version).toBe(STRATEGY_SPEC_VERSION);
    expect(r1.violations.map((v) => v.code)).toContain('target_by_trail');
    const r2 = checkIRSpec({ ...base, exit: [...base.exit, node('fixed_r_target', { r: 1 }, true)] }, c);
    expect(r2.ok).toBe(true); expect(r2.violations.find((v) => v.code === 'target_is_r_multiple')?.severity).toBe('warn');
    const r3 = checkIRSpec({ ...base, risk: { ...base.risk, stop: node('atr_stop', { atr_period: 14, multiple: 0.3 }) } }, c);
    expect(r3.ok).toBe(false); expect(r3.violations.find((v) => v.code === 'atr_stop_below_min_stop_atr')?.severity).toBe('block');
  });
});
