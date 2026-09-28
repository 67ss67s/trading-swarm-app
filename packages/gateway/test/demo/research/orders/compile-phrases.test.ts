/** 编译:五种订单说法由规则层确定性落进 order 块并过 checkIR(不调真模型,模型用桩)。 */
import { describe, it, expect } from 'vitest';
import type { StrategyIR } from '@trade-gate/contracts';
import { applyOrderPhrases, checkIR, compileStrategy, compileConstraints, repairIR, node } from '../../../../src/demo/research/strategy.js';
/** 模型桩:只给信号/止损/仓位,故意漏掉订单块(测规则层兜底);返回的是模型的原始 JSON */
const bare = (patch: Partial<StrategyIR> = {}): StrategyIR => ({ version: 1, label: 't', description: '持有数天,每 1000 根约数十个信号', signal: [node('ema_cross', { fast: 20, slow: 50 })], entry: node('next_open_market', {}), risk: { stop: node('htf_structure', { htf: '1d', swing_length: 3 }), sizing: node('equal_notional', { max_allocation: '1' }) }, exit: [node('structure_target', { htf: '1d', swing_length: 3 })], ...patch });
/** 规则层完整链路(与 compileStrategy 同序):原话规则 → repairIR 补全 → checkIR */
const passes = (ir: unknown, tf: string) => checkIR(repairIR(ir, compileConstraints(tf, null)).ir, tf).ok;
const brain = (ir: unknown) => ({ name: 'stub', complete: async () => ({ text: JSON.stringify({ ir, unmapped: [] }), latency_ms: 0, model: 'stub', input_tokens: 0, output_tokens: 0 }) });
describe('杠杆上限(2026-09-23)', () => {
  it('原话 50 倍按 20 倍,模型直接写 50 倍也被 repairIR 钳到 20', () => {
    const a = bare() as unknown as Record<string, any>; const notes = applyOrderPhrases('BTC 永续 50 倍做多', a);
    expect(a.order.leverage).toBe(20); expect(notes.join()).toContain('上限');
    const b = bare({ order: { direction: 'long', market: 'perp', leverage: 50 } as never });
    expect(((repairIR(b, compileConstraints('1h', null)).ir) as any).order.leverage).toBe(20);
  });
});
describe('回踩语义(2026-09-23 实测修正)', () => {
  it('模型写出互相矛盾/重复的状态条件时,repairIR 规整:等价去重、矛盾保留先出现的', () => {
    const above = node('indicator_cross', { indicator: 'price', compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: 20 }, direction: 'above' });
    const dupBelow = node('indicator_cross', { indicator: 'ema', args: { period: 20 }, compare_to: 'price', compare_price: 'close', direction: 'below' });
    const contra = node('indicator_cross', { indicator: 'ema', args: { period: 20 }, compare_to: 'price', compare_price: 'close', direction: 'above' });
    const ir = bare({ signal: [above, dupBelow, contra] as StrategyIR['signal'] });
    const out = repairIR(ir, compileConstraints('1d', null));
    expect((out.ir as StrategyIR).signal).toEqual([above]);
    expect(out.notes.join()).toContain('矛盾');
  });
  it('「回踩 EMA20 限价买入,止损跌破 EMA50」→ 信号为「价格在 EMA20 之上且 EMA20 在 EMA50 之上」,去掉「价格下穿 EMA20」', () => {
    const ir = bare({ signal: [node('indicator_cross', { indicator: 'price', compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: 20 }, direction: 'cross_below' })] as StrategyIR['signal'] }) as unknown as Record<string, any>;
    applyOrderPhrases('ETH 日线 回踩 EMA20 限价买入,止损跌破 EMA50,止盈看布林上轨,盈亏比至少 2', ir);
    expect(ir.signal).toEqual([
      node('indicator_cross', { indicator: 'price', compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: 20 }, direction: 'above' }),
      node('indicator_cross', { indicator: 'ema', args: { period: 20 }, compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: 50 }, direction: 'above' }),
    ]);
    expect(passes(ir, '1d')).toBe(true);
  });
});
describe('五种订单说法 → order 块', () => {
  it('「限价回踩支撑买入」→ 限价 + structure_level;「回踩 EMA20 限价买入」→ indicator_level ema 20', () => {
    const a = bare() as unknown as Record<string, any>; applyOrderPhrases('BTC 4小时 限价回踩支撑买入', a);
    expect(a.order).toMatchObject({ direction: 'long', market: 'spot', entry: { type: 'limit', price: { primitive: 'structure_level' } } });
    expect(passes(a, '4h')).toBe(true);
    const b = bare() as unknown as Record<string, any>; applyOrderPhrases('ETH 日线 回踩 EMA20 限价买入', b);
    expect(b.order.entry).toEqual({ type: 'limit', price: node('indicator_level', { indicator: 'ema', args: { period: 20 } }) });
    expect(passes(b, '1d')).toBe(true);
  });
  it('「盈亏比至少 2」→ min_rr=2;「止盈看布林上轨」→ take_profits bbands.upper;「止损跌破 EMA50」→ risk.stop indicator_level ema 50', () => {
    const ir = bare() as unknown as Record<string, any>;
    const notes = applyOrderPhrases('盈亏比至少 2,止盈看布林上轨,止损跌破 EMA50', ir);
    expect(ir.order.min_rr).toBe(2);
    expect(ir.order.take_profits).toEqual([{ source: node('indicator_level', { indicator: 'bbands', output: 'upper' }) }]);
    expect(ir.risk.stop).toEqual(node('indicator_level', { indicator: 'ema', args: { period: 50 } }));
    expect(notes.length).toBeGreaterThanOrEqual(3);
    expect(passes(ir, '1d')).toBe(true);
  });
  it('「做空 / 永续 3 倍」→ direction=short、market=perp、leverage=3;盈亏比里的「2 倍」不算杠杆', () => {
    const ir = bare({ signal: [node('donchian_breakout', { lookback: 120, basis: 'close', direction: 'down' })] }) as unknown as Record<string, any>;
    applyOrderPhrases('BTC 永续 4小时 跌破 20 日低点做空,3 倍杠杆,止损在前高,盈亏比至少 2', ir);
    expect(ir.order).toMatchObject({ direction: 'short', market: 'perp', leverage: 3, min_rr: 2 });
    expect(passes(ir, '4h')).toBe(true);
    const only = bare() as unknown as Record<string, any>; applyOrderPhrases('做空', only); expect(only.order).toMatchObject({ direction: 'short', market: 'perp' });
    const rr = bare() as unknown as Record<string, any>; applyOrderPhrases('永续 盈亏比至少 2 倍', rr); expect(rr.order.leverage).toBeUndefined();
    const none = bare() as unknown as Record<string, any>; expect(applyOrderPhrases('均线金叉做多,死叉离场', none)).toEqual([]); expect(none.order).toBeUndefined();
  });
  it('checkIR 对做空按镜像判:空单止损在上方不判死;现货做空仍拦', () => {
    const ir = bare({ signal: [node('donchian_breakout', { lookback: 20, basis: 'close', direction: 'down' })], risk: { stop: node('swing_low_stop', { lookback: 10 }), sizing: node('equal_notional', { max_allocation: '1' }) }, exit: [], order: { direction: 'short', market: 'perp', leverage: 3, take_profits: [{ source: node('fixed_r_target', { r: 2 }) }], min_rr: 2 } });
    expect(checkIR(ir, '4h').ok).toBe(true);
    expect(checkIR({ ...ir, order: { ...ir.order!, market: 'spot' } }, '4h').ok).toBe(false);
  });
  it('compileStrategy(模型桩漏掉订单块):五种说法全部落进 order 块、过检查,且不再补用户没说的追踪止损', async () => {
    const out = await compileStrategy({ text: 'ETH 日线 回踩 EMA20 限价买入,止损跌破 EMA50,止盈看布林上轨,盈亏比至少 2', timeframe: '1d' }, brain(bare({ exit: [node('structure_target', { htf: '1d', swing_length: 3 })] })));
    expect(out.ok).toBe(true);
    expect(out.ir!.order).toMatchObject({ direction: 'long', market: 'spot', min_rr: 2, entry: { type: 'limit', price: { primitive: 'indicator_level' } }, take_profits: [{ source: { primitive: 'indicator_level', params: { indicator: 'bbands', output: 'upper' } } }] });
    expect(out.ir!.risk.stop.params).toMatchObject({ indicator: 'ema', args: { period: 50 } });
    expect(out.ir!.exit.some((x) => x.primitive === 'chandelier_trail')).toBe(false);
    const short = await compileStrategy({ text: 'BTC 永续 4小时 跌破 20 日低点做空,3 倍杠杆,盈亏比至少 2', timeframe: '4h' }, brain(bare({ signal: [node('donchian_breakout', { lookback: 120, basis: 'close', direction: 'down' })] })));
    expect(short.ok).toBe(true); expect(short.ir!.order).toMatchObject({ direction: 'short', market: 'perp', leverage: 3, min_rr: 2 });
    // 护栏保留:没提永续/做空时,模型写的永续做空订单块退回现货做多
    const guard = await compileStrategy({ text: 'BTC 日线 均线金叉', timeframe: '1d' }, brain(bare({ order: { direction: 'short', market: 'perp', leverage: 5 } })));
    expect(guard.ir!.order).toMatchObject({ direction: 'long', market: 'spot', leverage: 1 });
  });
});
