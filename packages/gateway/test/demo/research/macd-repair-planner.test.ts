import { LEGACY_ORDER_GATE } from '../../../src/demo/research/order-gate.js';
import { describe, it, expect, vi } from 'vitest';
import type { ResearchBar } from '@trading-swarm/contracts';
import { macd, confirmedPivots, macdDivergence } from '../../../src/demo/research/primitives/signals.js';
import { registry } from '../../../src/demo/research/primitives/index.js';
import { checkIR, compileStrategy, defaultIR, repairIR, compileConstraints, node } from '../../../src/demo/research/strategy.js';
import { fallbackPlan, inferTimeframe, normalizePlan, MIN_VALIDATE_BARS } from '../../../src/demo/research/loop/planner.js';
const T0 = Date.UTC(2025, 0, 1), STEP = 3600000;
const bar = (i: number, o: number, h: number, l: number, c: number): ResearchBar => ({ open_time: T0 + i * STEP, close_time: T0 + (i + 1) * STEP - 1, open: o.toFixed(2), high: h.toFixed(2), low: l.toFixed(2), close: c.toFixed(2), volume: '1' });
/** 价格:先跌到 90 反弹,再跌到 85(更低)但跌势更缓 → 柱在第二个低点更高 = 底背离;顶背离对称。 */
function divergenceBars(kind: 'bullish' | 'bearish'): ResearchBar[] {
  const closes: number[] = [];
  for (let i = 0; i < 60; i++) closes.push(100);
  for (let i = 0; i < 12; i++) closes.push(100 - i * 0.9);      // 快速下跌到 ~90
  for (let i = 0; i < 12; i++) closes.push(90.1 + i * 0.6);      // 反弹到 ~97
  for (let i = 0; i < 20; i++) closes.push(97 - i * 0.62);       // 缓慢下跌到 ~85(更低)
  for (let i = 0; i < 6; i++) closes.push(85 + i * 0.5);         // 反弹确认 pivot
  const series = kind === 'bullish' ? closes : closes.map((c) => 200 - c);
  return series.map((c, i) => bar(i, c, c + 0.3, c - 0.3, c));
}
describe('MACD 原语', () => {
  it('macd() 与手算一致且柱=线-信号', () => {
    const v = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const m = macd(v, 12, 26, 9);
    expect(m.macd.length).toBe(50); expect(m.hist[49]).toBeCloseTo(m.macd[49]! - m.signal[49]!, 10);
  });
  it('confirmedPivots 只在中心右侧 swing 根收盘后确认', () => {
    const v = [5, 4, 3, 1, 3, 4, 5, 6, 7, 2, 3];
    expect(confirmedPivots(v, 2, 'low')).toEqual([{ index: 3, confirmed: 5 }]);
    expect(confirmedPivots(v.slice(0, 5), 2, 'low')).toEqual([]);
  });
  it('底背离在第二个 pivot low 确认当根触发一次,之后不再重复', () => {
    const bars = divergenceBars('bullish');
    const p = { fast: 12, slow: 26, signal: 9, swing_length: 3, lookback: 60 };
    const fired = bars.map((_, i) => macdDivergence(bars.slice(0, i + 1), p, 'bullish'));
    const hits = fired.map((f, i) => (f ? i : -1)).filter((i) => i >= 0);
    expect(hits.length).toBe(1);
    expect(hits[0]).toBe(104 + 3); // 第二个低点在 index 104(85.00 低于前一根 85.22)+ swing 根确认
    expect(registry.get('macd_divergence')!.compute({ bars, i: hits[0]!, timeframe_ms: STEP }, p).pass).toBe(true);
    expect(registry.get('macd_divergence')!.compute({ bars, i: hits[0]! - 1, timeframe_ms: STEP }, p).pass).toBe(false);
  });
  it('顶背离是离场原语,无持仓不触发', () => {
    const bars = divergenceBars('bearish');
    const p = { fast: 12, slow: 26, signal: 9, swing_length: 3, lookback: 60 };
    const i = bars.findIndex((_, j) => macdDivergence(bars.slice(0, j + 1), p, 'bearish'));
    expect(i).toBeGreaterThan(0);
    const exit = registry.get('macd_divergence_exit')!;
    expect(exit.compute({ bars, i, timeframe_ms: STEP }, p).exit).toBe(false);
    expect(exit.compute({ bars, i, timeframe_ms: STEP, position: { entry_at: bars[70]!.open_time, entry_price: 100, initial_distance: 5, bars_held: i - 70 } }, p).exit).toBe(true);
  });
  it('IR 里 macd_divergence 入场 + macd_divergence_exit 离场通过全部检查', () => {
    const ir = defaultIR();
    ir.signal = [node('ema_cross', { fast: 20, slow: 50 }), node('macd_divergence', { fast: 12, slow: 26, signal: 9, swing_length: 3, lookback: 60 })];
    ir.exit.push(node('macd_divergence_exit', { fast: 12, slow: 26, signal: 9, swing_length: 3, lookback: 60 }));
    const r = checkIR(ir, '1h');
    expect(r.ok, JSON.stringify(r.checks)).toBe(true);
    expect(checkIR({ ...ir, signal: [node('macd_cross', { fast: 26, slow: 12, signal: 9 })] }, '1h').checks.find((c) => c.name === 'warmup')!.ok).toBe(false);
  });
});
describe('编译自动补全与回喂重试', () => {
  const c = compileConstraints('1d', null, undefined, LEGACY_ORDER_GATE); // 旧口径补全(固定 R 提到最小盈亏比);结构口径见 structure-exits.test.ts
  it('缺止盈/追踪出场/仓位时补齐并逐条写进 notes;已有的不动', () => {
    const bare = { version: 1, label: 'x', description: 'y', signal: [node('ema_cross', { fast: 20, slow: 50 })], entry: node('next_open_market', {}), risk: { stop: node('atr_stop', { atr_period: 14, multiple: 3 }) }, exit: [node('fixed_r_target', { r: 1 })] };
    const { ir, notes } = repairIR(bare, c);
    const out = ir as any;
    expect(out.exit.map((x: any) => x.primitive)).toEqual(['fixed_r_target', 'chandelier_trail']);
    expect(out.exit[0].optional).toBe(true); expect(out.exit[0].params.r).toBe(2);
    expect(out.risk.sizing.primitive).toBe('equal_notional');
    expect(notes.length).toBe(4);
    expect(checkIR(ir, '1d').ok).toBe(true);
    expect(repairIR(defaultIR(), c).notes).toEqual([]);
  });
  it('模型第一次漏掉止盈:代码补全后一次编译成功,不再要求模型重来', async () => {
    const ir = defaultIR(); ir.exit = ir.exit.filter((x) => x.primitive !== 'structure_target');
    const complete = vi.fn(async () => ({ text: JSON.stringify({ ir, unmapped: ['MACD 背离:略'] }), latency_ms: 1, model: 'mock', input_tokens: 1, output_tokens: 1 }));
    const out = await compileStrategy({ text: '均线交叉', timeframe: '1h' }, { name: 'mock', complete });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(true); expect(out.spec?.ok).toBe(true);
    expect(out.unmapped[0]).toBe('MACD 背离:略'); expect(out.unmapped.some((x) => x.includes('自动补全:未指定止盈,按图上结构'))).toBe(true);
  });
  it('检查失败且代码补不了(未知原语)时把失败原因回喂模型,最多三次', async () => {
    const bad = defaultIR(); bad.signal[0]!.primitive = 'no_such_thing';
    const complete = vi.fn(async () => ({ text: JSON.stringify({ ir: bad, unmapped: [] }), latency_ms: 1, model: 'mock', input_tokens: 1, output_tokens: 1 }));
    const out = await compileStrategy({ text: 'x', timeframe: '1h' }, { name: 'mock', complete });
    expect(complete).toHaveBeenCalledTimes(3); expect(out.ok).toBe(false);
    expect(String((complete.mock.calls[1] as any)[1])).toContain('上一次输出未通过检查');
    complete.mockClear(); complete.mockResolvedValueOnce({ text: JSON.stringify({ ir: bad, unmapped: [] }), latency_ms: 1, model: 'mock', input_tokens: 1, output_tokens: 1 }).mockResolvedValueOnce({ text: JSON.stringify({ ir: defaultIR(), unmapped: [] }), latency_ms: 1, model: 'mock', input_tokens: 1, output_tokens: 1 });
    expect((await compileStrategy({ text: 'x', timeframe: '1h' }, { name: 'mock', complete })).ok).toBe(true); expect(complete).toHaveBeenCalledTimes(2);
  });
});
describe('规划器周期与窗口', () => {
  const NOW = Date.UTC(2026, 8, 22);
  it('中文周期词映射', () => {
    expect(inferTimeframe('BTC 日线 20/50 均线交叉')).toBe('1d'); expect(inferTimeframe('4小时级别突破')).toBe('4h'); expect(inferTimeframe('15分钟')).toBe('15m'); expect(inferTimeframe('BTC 杠杆')).toBe(null); expect(inferTimeframe('用 4h 看')).toBe('4h');
  });
  it('validate 的规则计划按日线并拉到至少 1200 根;market 不动', () => {
    const p = fallbackPlan('验证BTC现货日线20/50均线交叉策略扣除成本后和直接持有相比如何', undefined, NOW);
    expect(p.task_kind).toBe('validate'); expect(p.timeframe).toBe('1d');
    expect((p.window.to_ms - p.window.from_ms) / 86400000).toBeGreaterThanOrEqual(MIN_VALIDATE_BARS);
    for (const s of p.plan) { if ('timeframe' in s.args) expect(s.args.timeframe).toBe('1d'); if ('window' in s.args) expect(s.args.window).toEqual(p.window); }
    const m = fallbackPlan('BTC 杠杆', undefined, NOW); expect(m.timeframe).toBe('1h'); expect((m.window.to_ms - m.window.from_ms) / 86400000).toBe(30);
    expect((fallbackPlan('BTC 日线策略最近 90 天回测', undefined, NOW).window.to_ms - fallbackPlan('BTC 日线策略最近 90 天回测', undefined, NOW).window.from_ms) / 86400000).toBe(90);
  });
  it('模型给的 1h/30 天 validate 计划被改成用户说的日线并整体改写参数', () => {
    const raw = fallbackPlan('BTC 策略回测', undefined, NOW);
    const fixed = normalizePlan(raw, '验证 BTC 日线均线交叉策略');
    expect(fixed.timeframe).toBe('1d'); expect(fixed.plan.every((s) => !('timeframe' in s.args) || s.args.timeframe === '1d')).toBe(true);
    expect(fixed.plan.every((s) => !('window' in s.args) || (s.args.window as any).from_ms === fixed.window.from_ms)).toBe(true);
  });
});
describe('事件型信号拆分', () => {
  it('两个单根事件信号 AND 时只保留第一个,并写明原因', () => {
    const c = compileConstraints('1d', null);
    const ir = defaultIR(); ir.signal = [node('ema_cross', { fast: 20, slow: 50 }), node('volume_surge', { lookback: 20, multiple: 1.2 }), node('macd_divergence', { fast: 12, slow: 26, signal: 9, swing_length: 3, lookback: 60 })];
    const { ir: out, notes } = repairIR(ir, c);
    expect((out as any).signal.map((x: any) => x.primitive)).toEqual(['ema_cross', 'volume_surge']);
    expect(notes.some((x) => x.startsWith('自动拆分:ema_cross 与 macd_divergence'))).toBe(true);
    expect(repairIR(defaultIR(), c).notes).toEqual([]);
  });
});

describe('用户给了信号离场时忠于用户(2026-09-23)', () => {
  it('死叉离场:不补固定 R 目标、不补吊灯追踪,规范只 warn', () => {
    const c = { min_rr: 1.5, min_atr_multiple: 1 } as never;
    const raw = { version: 1, label: 'x', description: '', signal: [{ primitive: 'ema_cross', params: { fast: 20, slow: 50 } }], entry: { primitive: 'next_open_market', params: {} }, risk: { stop: { primitive: 'order_blocks', params: { swing_length: 5 } } },
      exit: [{ primitive: 'indicator_cross_exit', params: { indicator: 'ema', args: { period: 20 }, compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: 50 }, direction: 'cross_below' } }] };
    const { ir } = repairIR(raw, c) as { ir: any };
    expect(ir.exit.map((x: any) => x.primitive)).toEqual(['indicator_cross_exit']);
    expect(ir.risk.sizing.primitive).toBe('equal_notional');
  });
});
