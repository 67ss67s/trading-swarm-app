import { describe, it, expect } from 'vitest';
import type { ResearchBar } from '@trading-swarm/contracts';
import { registry } from '../../../src/demo/research/primitives/index.js';
import { indicatorLine } from '../../../src/demo/research/primitives/indicators.js';
import { checkIR, defaultIR, node } from '../../../src/demo/research/strategy.js';

const T0 = Date.UTC(2025, 0, 1), STEP = 3600000;
const bar = (i: number, c: number, v = 100): ResearchBar =>
  ({ open_time: T0 + i * STEP, close_time: T0 + (i + 1) * STEP - 1, open: (c - 0.2).toFixed(6), high: (c + 0.5).toFixed(6), low: (c - 0.5).toFixed(6), close: c.toFixed(6), volume: v.toFixed(6) });
const make = (closes: number[]) => closes.map((c, i) => bar(i, c));
/** 先跌后涨的 V 形:快线必然在底部之后上穿慢线一次。 */
const vShape = () => make([...Array.from({ length: 80 }, (_, i) => 1200 - i * 2), ...Array.from({ length: 80 }, (_, i) => 1042 + i * 3)]);
/** 正弦波动:价格反复穿越均线,两个方向的穿越都会发生。 */
const wave = () => make(Array.from({ length: 200 }, (_, i) => 1000 + 40 * Math.sin(i / 9) + i * 0.2));
/** 价格:先跌到 90 反弹,再跌到更低但跌势更缓 → 指标在第二个低点更高 = 底背离(与 macd 原语测试同构)。 */
function divergenceBars(kind: 'bullish' | 'bearish'): ResearchBar[] {
  const closes: number[] = [];
  for (let i = 0; i < 60; i++) closes.push(100);
  for (let i = 0; i < 12; i++) closes.push(100 - i * 0.9);
  for (let i = 0; i < 12; i++) closes.push(90.1 + i * 0.6);
  for (let i = 0; i < 20; i++) closes.push(97 - i * 0.62);
  for (let i = 0; i < 6; i++) closes.push(85 + i * 0.5);
  const series = kind === 'bullish' ? closes : closes.map((c) => 200 - c);
  return series.map((c, i) => ({ open_time: T0 + i * STEP, close_time: T0 + (i + 1) * STEP - 1, open: c.toFixed(2), high: (c + 0.3).toFixed(2), low: (c - 0.3).toFixed(2), close: c.toFixed(2), volume: '1' }));
}
const position = (bars: ResearchBar[]) => ({ entry_at: bars[10]!.open_time, entry_price: 100, initial_distance: 5, bars_held: 5 });
/** 逐根跑一个原语,返回触发的下标 */
const fired = (name: string, bars: ResearchBar[], p: Record<string, unknown>, withPosition = false) =>
  bars.map((_, i) => {
    const v = registry.get(name)!.compute({ bars, i, timeframe_ms: STEP, ...(withPosition ? { position: position(bars) } : {}) }, p);
    return (v.pass || v.exit) ? i : -1;
  }).filter((i) => i >= 0);

describe('通用穿越原语 indicator_cross', () => {
  it('指标对指标:快慢 SMA 金叉只在穿越那一根触发一次', () => {
    const bars = vShape(), p = { indicator: 'sma', args: { period: 5 }, compare_to: 'indicator', compare_indicator: 'sma', compare_args: { period: 20 }, direction: 'cross_above' };
    const hits = fired('indicator_cross', bars, p);
    expect(hits).toHaveLength(1);
    const fast = indicatorLine('sma', bars, { period: 5 }), slow = indicatorLine('sma', bars, { period: 20 }), i = hits[0]!;
    expect(fast[i]! > slow[i]! && fast[i - 1]! <= slow[i - 1]!).toBe(true);
  });
  it('价格对指标:price/close 上穿 EMA20,与手工比较两条线的结果一致', () => {
    const bars = vShape(), p = { indicator: 'price', output: 'close', compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: 20 }, direction: 'cross_above' };
    const line = indicatorLine('ema', bars, { period: 20 }), closes = bars.map((b) => Number(b.close));
    const expected = bars.map((_, i) => (i > 0 && Number.isFinite(line[i]!) && Number.isFinite(line[i - 1]!) && closes[i - 1]! <= line[i - 1]! && closes[i]! > line[i]! ? i : -1)).filter((i) => i >= 0);
    expect(fired('indicator_cross', bars, p)).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });
  it('指标对价格与指标对常数:MACD 柱上穿 0 轴,方向反过来则不触发', () => {
    const bars = vShape();
    const up = { indicator: 'macd', output: 'hist', compare_to: 'constant', constant: 0, direction: 'cross_above' };
    const hits = fired('indicator_cross', bars, up);
    expect(hits.length).toBeGreaterThan(0);
    const hist = indicatorLine('macd', bars, null, 'hist');
    for (const i of hits) expect(hist[i]! > 0 && hist[i - 1]! <= 0).toBe(true);
    // 同一根不可能既上穿又下穿
    const down = { ...up, direction: 'cross_below' };
    expect(fired('indicator_cross', bars, down).filter((i) => hits.includes(i))).toEqual([]);
  });
  it('cross_exit 只在持仓时离场,且默认 compare_to=price 用收盘价', () => {
    const bars = wave(), p = { indicator: 'ema', args: { period: 20 }, compare_to: 'price', compare_price: 'close', direction: 'cross_above' };
    expect(fired('indicator_cross_exit', bars, p, false)).toEqual([]);
    const hits = fired('indicator_cross_exit', bars, p, true);
    expect(hits.length).toBeGreaterThan(0); // 均线上穿价格 = 价格跌破均线
  });
  it('warmup 等于两条线的较大预热加一根(要看上一根才谈得上穿越)', () => {
    const p = { indicator: 'sma', args: { period: 20 }, compare_to: 'indicator', compare_indicator: 'sma', compare_args: { period: 50 }, direction: 'cross_above' };
    expect(registry.get('indicator_cross')!.warmup_bars(p)).toBe(51);
    expect(registry.get('indicator_cross')!.warmup_bars({ indicator: 'macd', compare_to: 'constant', constant: 0, direction: 'cross_above' })).toBe(35);
  });
});

describe('通用阈值原语 indicator_threshold', () => {
  const bars = vShape();
  it('above/below 是状态:每根 RSI 低于 30 都成立,与直接算 RSI 一致', () => {
    const rsi = indicatorLine('rsi', bars, { period: 14 });
    const expected = bars.map((_, i) => (Number.isFinite(rsi[i]!) && rsi[i]! < 30 ? i : -1)).filter((i) => i >= 0);
    expect(fired('indicator_threshold', bars, { indicator: 'rsi', args: { period: 14 }, operator: 'below', threshold: 30 })).toEqual(expected);
    expect(expected.length).toBeGreaterThan(1);
  });
  it('cross_above 是单根事件:只在从下方越过阈值那一根触发', () => {
    const rsi = indicatorLine('rsi', bars, { period: 14 });
    const hits = fired('indicator_threshold', bars, { indicator: 'rsi', args: { period: 14 }, operator: 'cross_above', threshold: 50 });
    expect(hits.length).toBeGreaterThan(0);
    for (const i of hits) expect(rsi[i]! > 50 && rsi[i - 1]! <= 50).toBe(true);
    expect(registry.get('indicator_threshold')!.warmup_bars({ indicator: 'rsi', args: { period: 14 }, operator: 'above', threshold: 50 })).toBe(15);
    expect(registry.get('indicator_threshold')!.warmup_bars({ indicator: 'rsi', args: { period: 14 }, operator: 'cross_above', threshold: 50 })).toBe(16);
  });
  it('threshold_exit 需要持仓才离场', () => {
    const p = { indicator: 'rsi', args: { period: 14 }, operator: 'below', threshold: 45 };
    expect(fired('indicator_threshold_exit', bars, p, false)).toEqual([]);
    expect(fired('indicator_threshold_exit', bars, p, true).length).toBeGreaterThan(0);
  });
});

describe('通用背离原语 indicator_divergence', () => {
  it('底背离在第二个 pivot low 被确认那一根触发一次,之后不再重复', () => {
    const bars = divergenceBars('bullish'), p = { indicator: 'macd', output: 'hist', swing_length: 3, lookback: 60 };
    const hits = fired('indicator_divergence', bars, p);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toBe(104 + 3); // 第二个低点在 104,加 swing 根确认
  });
  it('换成 RSI 也能出底背离,说明背离逻辑与具体指标无关', () => {
    const bars = divergenceBars('bullish'), p = { indicator: 'rsi', args: { period: 14 }, swing_length: 3, lookback: 60 };
    expect(fired('indicator_divergence', bars, p).length).toBeGreaterThan(0);
  });
  it('顶背离是离场原语,无持仓不触发,有持仓才离场', () => {
    const bars = divergenceBars('bearish'), p = { indicator: 'macd', output: 'hist', swing_length: 3, lookback: 60 };
    expect(fired('indicator_divergence_exit', bars, p, false)).toEqual([]);
    expect(fired('indicator_divergence_exit', bars, p, true)).toHaveLength(1);
  });
  it('warmup = 指标预热 + lookback + 2×swing + 1', () => {
    expect(registry.get('indicator_divergence')!.warmup_bars({ indicator: 'rsi', args: { period: 14 }, swing_length: 3, lookback: 60 })).toBe(15 + 60 + 6 + 1);
  });
});

describe('通用原语接入 IR 检查', () => {
  it('通用穿越入场 + 通用阈值离场的 IR 通过全部检查', () => {
    const ir = defaultIR();
    ir.signal = [node('indicator_cross', { indicator: 'sma', args: { period: 20 }, compare_to: 'indicator', compare_indicator: 'sma', compare_args: { period: 50 }, direction: 'cross_above' })];
    ir.exit.push(node('indicator_threshold_exit', { indicator: 'rsi', args: { period: 14 }, operator: 'below', threshold: 45 }));
    const r = checkIR(ir, '1h');
    expect(r.ok, JSON.stringify(r.checks)).toBe(true);
  });
  it('args 里 fast 不小于 slow 时 ordered 判死,未知参数被 units 判死', () => {
    const ir = defaultIR();
    ir.signal = [node('indicator_cross', { indicator: 'macd', args: { fast: 26, slow: 12, signal: 9 }, output: 'hist', compare_to: 'constant', constant: 0, direction: 'cross_above' })];
    expect(checkIR(ir, '1h').checks.find((c) => c.name === 'warmup')!.ok).toBe(false);
    const bad = defaultIR();
    bad.signal = [node('indicator_threshold', { indicator: 'rsi', args: { period: 14 }, operator: 'below', threshold: 30, nonsense: 1 })];
    expect(checkIR(bad, '1h').checks.find((c) => c.name === 'units')!.ok).toBe(false);
  });
});
