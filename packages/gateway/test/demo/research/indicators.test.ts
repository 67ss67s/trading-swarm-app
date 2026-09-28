import { describe, it, expect } from 'vitest';
import type { ResearchBar } from '@trade-gate/contracts';
import { schemas } from '@trade-gate/contracts';
import {
  INDICATORS, INDICATOR_NAMES, INDICATOR_ALIASES, resolveIndicatorName, resolveArgs,
  indicatorSeries, indicatorLine, indicatorWarmup,
  smaSeries, emaSeries, wmaSeries, rmaSeries, stdevSeries, atrSeries, rsiSeries, rollingMax, rollingMin,
} from '../../../src/demo/research/primitives/indicators.js';

const T0 = Date.UTC(2025, 0, 1), STEP = 3600000;
const bar = (i: number, o: number, h: number, l: number, c: number, v = 100): ResearchBar =>
  ({ open_time: T0 + i * STEP, close_time: T0 + (i + 1) * STEP - 1, open: o.toFixed(6), high: h.toFixed(6), low: l.toFixed(6), close: c.toFixed(6), volume: v.toFixed(6) });
/** 线性行情:收盘每根 +1,上下影恒为 1。所有滞后型指标在这种行情上都有闭式解,便于逐个手算校验。 */
const ramp = (len = 300): ResearchBar[] => Array.from({ length: len }, (_, i) => { const c = 1000 + i; return bar(i, c, c + 1, c - 1, c); });
/** 起伏行情:用来检查 warmup 之后不出现 NaN(不含除零、常量段等退化情形)。 */
const wavy = (len = 400): ResearchBar[] => Array.from({ length: len }, (_, i) => {
  const c = 1000 + 50 * Math.sin(i / 7) + 20 * Math.sin(i / 23) + (i % 11) * 0.7;
  return bar(i, c - 0.3, c + 1 + Math.abs(Math.sin(i)), c - 1 - Math.abs(Math.cos(i)), c, 50 + (i % 37) * 4);
});
const lastOf = (name: string, bars: ResearchBar[], args?: Record<string, unknown>, output?: string) => indicatorLine(name, bars, args ?? null, output).at(-1)!;

describe('指标库:小样本逐项手算', () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  it('SMA/EMA/WMA/RMA/标准差与逐项算式一致,预热之前全是 NaN', () => {
    expect(smaSeries(v, 3).slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(smaSeries(v, 3)[2]).toBeCloseTo(2, 10);
    expect(smaSeries(v, 3)[9]).toBeCloseTo(9, 10);
    // EMA 以前 3 根 SMA 播种(TA-Lib / pandas-ta 默认),k=0.5
    expect(emaSeries(v, 3)[2]).toBeCloseTo(2, 10);
    expect(emaSeries(v, 3)[3]).toBeCloseTo(0.5 * 4 + 0.5 * 2, 10);
    expect(emaSeries(v, 3)[9]).toBeCloseTo(9, 10); // 线性序列稳态滞后 (n-1)/2 = 1
    expect(wmaSeries(v, 3)[9]).toBeCloseTo((10 * 3 + 9 * 2 + 8 * 1) / 6, 10);
    expect(rmaSeries(v, 3)[3]).toBeCloseTo((2 * 2 + 4) / 3, 10);
    expect(stdevSeries(v, 3)[9]).toBeCloseTo(Math.sqrt(2 / 3), 10); // 总体口径 ddof=0
  });
  it('滚动极值窗口含当前根,窗口不足时为 NaN', () => {
    expect(rollingMax([3, 1, 4, 1, 5], 3).slice(2)).toEqual([4, 4, 5]);
    expect(rollingMin([3, 1, 4, 1, 5], 3).slice(2)).toEqual([1, 1, 1]);
    expect(rollingMax([3, 1, 4, 1, 5], 3).slice(0, 2).every(Number.isNaN)).toBe(true);
  });
  it('ATR 与 RSI 用 Wilder 平滑,首个有效下标等于周期', () => {
    const bars = ramp(30);
    expect(atrSeries(bars, 14)[13]).toBeNaN();
    expect(atrSeries(bars, 14)[14]).toBeCloseTo(2, 10); // 每根 TR 恒为 2
    expect(rsiSeries(bars.map((b) => Number(b.close)), 14)[29]).toBeCloseTo(100, 10); // 只涨不跌
  });
});

describe('指标库:线性行情上的闭式解(均线族)', () => {
  const bars = ramp(), x = 1299;
  it('SMA/EMA/VWMA 滞后 (n-1)/2,WMA 滞后 (n-1)/3,DEMA/TEMA 零滞后,HMA 滞后 -2/3', () => {
    expect(lastOf('sma', bars)).toBeCloseTo(x - 9.5, 8);
    expect(lastOf('ema', bars)).toBeCloseTo(x - 9.5, 8);
    expect(lastOf('vwma', bars)).toBeCloseTo(x - 9.5, 8);
    expect(lastOf('wma', bars)).toBeCloseTo(x - 19 / 3, 8);
    expect(lastOf('dema', bars)).toBeCloseTo(x, 6);
    expect(lastOf('tema', bars)).toBeCloseTo(x, 6);
    expect(lastOf('hma', bars)).toBeCloseTo(x - 2 / 3, 6);
    expect(lastOf('smma', bars)).toBeCloseTo(x - 19, 4); // Wilder 滞后 n-1,从 SMA 播种收敛
    expect(lastOf('kama', bars)).toBeCloseTo(x - 1.25, 6); // 效率比=1 时 sc=(2/3)^2,稳态滞后 1/sc-1
  });
});

describe('指标库:线性行情上的闭式解(趋势与动量)', () => {
  const bars = ramp(), x = 1299;
  it('MACD 恒等于快慢滞后差,柱归零;TRIX 与 ROC 为纯斜率项', () => {
    const m = indicatorSeries('macd', bars, null);
    expect(m.macd!.at(-1)!).toBeCloseTo(7, 8); // (x-5.5)-(x-12.5)
    expect(m.signal!.at(-1)!).toBeCloseTo(7, 8);
    expect(m.hist!.at(-1)!).toBeCloseTo(0, 8);
    expect(lastOf('trix', bars)).toBeCloseTo(100 / (x - 21 - 1), 4);
    expect(lastOf('roc', bars)).toBeCloseTo(100 * 12 / (x - 12), 8);
    expect(lastOf('momentum', bars)).toBeCloseTo(10, 8);
  });
  it('单边上涨时 ADX=100、+DI=50、-DI=0,RSI=100,威廉 %R=-100/(n+1),CCI=126.67', () => {
    const a = indicatorSeries('adx', bars, null);
    expect(a.adx!.at(-1)!).toBeCloseTo(100, 8);
    expect(a.plus_di!.at(-1)!).toBeCloseTo(50, 8);
    expect(a.minus_di!.at(-1)!).toBeCloseTo(0, 8);
    expect(lastOf('rsi', bars)).toBeCloseTo(100, 8);
    expect(lastOf('willr', bars)).toBeCloseTo(-100 / 15, 8);
    expect(lastOf('cci', bars)).toBeCloseTo(9.5 / (0.015 * 5), 8); // 平均绝对偏差 5
    expect(lastOf('stoch', bars, null, 'k')).toBeCloseTo(100 * 14 / 15, 8); // 收盘贴近窗口上沿但上影更高
    expect(lastOf('stoch', bars, null, 'd')).toBeCloseTo(100 * 14 / 15, 8);
  });
  it('Aroon / 涡旋 / 震荡指数 / 艾达透视 / UO / AO 与定义式一致', () => {
    const ar = indicatorSeries('aroon', bars, null);
    expect(ar.up!.at(-1)!).toBeCloseTo(100, 8); expect(ar.down!.at(-1)!).toBeCloseTo(0, 8); expect(ar.oscillator!.at(-1)!).toBeCloseTo(100, 8);
    const vx = indicatorSeries('vortex', bars, null);
    expect(vx.plus!.at(-1)!).toBeCloseTo(1.5, 8); expect(vx.minus!.at(-1)!).toBeCloseTo(0.5, 8);
    expect(lastOf('chop', bars)).toBeCloseTo(100 * Math.log10(28 / 15) / Math.log10(14), 8);
    const er = indicatorSeries('elder_ray', bars, null);
    expect(er.bull!.at(-1)!).toBeCloseTo(7, 8); expect(er.bear!.at(-1)!).toBeCloseTo(5, 8);
    expect(lastOf('uo', bars)).toBeCloseTo(50, 8); // bp/tr 恒为 1/2
    expect(lastOf('ao', bars)).toBeCloseTo(14.5, 8); // (x-2)-(x-16.5)
  });
  it('超级趋势与 SAR 在单边上涨里方向恒为多', () => {
    expect(lastOf('supertrend', bars, null, 'direction')).toBe(1);
    expect(lastOf('psar', bars, null, 'direction')).toBe(1);
    expect(lastOf('supertrend', bars)).toBeLessThan(1299);
    expect(lastOf('psar', bars)).toBeLessThan(1299);
  });
});

describe('指标库:通道、波动率与量能', () => {
  const bars = ramp(), x = 1299, sd = Math.sqrt((20 * 20 - 1) / 12);
  it('布林/肯特纳/唐奇安的上中下轨、带宽与 %B', () => {
    const bb = indicatorSeries('bbands', bars, null);
    expect(bb.middle!.at(-1)!).toBeCloseTo(x - 9.5, 8);
    expect(bb.upper!.at(-1)!).toBeCloseTo(x - 9.5 + 2 * sd, 8);
    expect(bb.lower!.at(-1)!).toBeCloseTo(x - 9.5 - 2 * sd, 8);
    expect(bb.bandwidth!.at(-1)!).toBeCloseTo(100 * 4 * sd / (x - 9.5), 8);
    expect(bb.percent_b!.at(-1)!).toBeCloseTo((x - (x - 9.5 - 2 * sd)) / (4 * sd), 8);
    expect(lastOf('stdev', bars)).toBeCloseTo(sd, 8);
    const kc = indicatorSeries('keltner', bars, null);
    expect(kc.middle!.at(-1)!).toBeCloseTo(x - 9.5, 8);
    expect(kc.upper!.at(-1)!).toBeCloseTo(x - 9.5 + 4, 8); // ATR=2、倍数 2
    const dc = indicatorSeries('donchian', bars, null);
    expect(dc.upper!.at(-1)!).toBeCloseTo(x + 1, 8); expect(dc.lower!.at(-1)!).toBeCloseTo(x - 20, 8); expect(dc.middle!.at(-1)!).toBeCloseTo(x - 9.5, 8);
    expect(lastOf('atr', bars)).toBeCloseTo(2, 8);
    expect(lastOf('natr', bars)).toBeCloseTo(200 / x, 8);
  });
  it('OBV 累计成交量、AD/CMF 在对称影线下归零、量比为 1、MFI 只涨为 100', () => {
    expect(lastOf('obv', bars)).toBeCloseTo(100 * 299, 8);
    expect(lastOf('ad', bars)).toBeCloseTo(0, 8);
    expect(lastOf('cmf', bars)).toBeCloseTo(0, 8);
    expect(lastOf('chaikin', bars)).toBeCloseTo(0, 8);
    expect(lastOf('volume_ratio', bars)).toBeCloseTo(1, 8);
    expect(lastOf('mfi', bars)).toBeCloseTo(100, 8);
  });
  it('VWAP 按 UTC 日重置:跨日第一根等于当根典型价', () => {
    const perDay = 24, bars2 = Array.from({ length: 48 }, (_, i) => { const c = 1000 + i; return bar(i, c, c + 1, c - 1, c, 10); });
    const vwap = indicatorLine('vwap', bars2, null);
    expect(vwap[0]).toBeCloseTo(1000, 8);
    expect(vwap[perDay]).toBeCloseTo(1000 + perDay, 8); // 新的一天从头累计
    expect(vwap[perDay - 1]).toBeCloseTo((1000 + 1023) / 2, 8); // 第一天 24 根等权典型价
  });
});

describe('指标库:一目均衡表只看已收盘数据', () => {
  it('先行 A/B 取 displacement 根之前算出的云,迟行线给出对照值', () => {
    const bars = ramp(), x = 1299, ich = indicatorSeries('ichimoku', bars, null);
    expect(ich.conversion!.at(-1)!).toBeCloseTo(x - 4, 8);
    expect(ich.base!.at(-1)!).toBeCloseTo(x - 12.5, 8);
    expect(ich.span_a!.at(-1)!).toBeCloseTo(x - 34.25, 8);
    expect(ich.span_b!.at(-1)!).toBeCloseTo(x - 51.5, 8);
    expect(ich.lagging!.at(-1)!).toBeCloseTo(x, 8);
    expect(ich.lagging_ref!.at(-1)!).toBeCloseTo(x - 26, 8);
    // 把未来 bar 换成垃圾数据,已算出的值不变 —— 证明没有前视
    const poisoned = [...bars.slice(0, 200), ...bars.slice(200).map((b) => ({ ...b, high: 'NaN', low: 'NaN', close: 'NaN' }))];
    expect(indicatorSeries('ichimoku', poisoned, null).span_a![199]).toBeCloseTo(ich.span_a![199]!, 10);
  });
});

describe('指标库:预热边界与参数解析', () => {
  const bars = wavy();
  it('每个指标在 warmup 根之后所有输出都不是 NaN', () => {
    for (const spec of Object.values(INDICATORS)) {
      const w = indicatorWarmup(spec.name), out = indicatorSeries(spec.name, bars, null);
      expect(Object.keys(out).sort()).toEqual([...spec.outputs].sort());
      for (const [key, line] of Object.entries(out)) {
        expect(line.length, `${spec.name}.${key} 长度`).toBe(bars.length);
        const bad = line.slice(w - 1).findIndex((v) => !Number.isFinite(v));
        expect(bad, `${spec.name}.${key} 在 warmup(${w}) 之后第 ${bad} 个值是 NaN`).toBe(-1);
      }
    }
  });
  it('warmup 是紧的:恰好 warmup 根有值,少一根至少有一条输出还是 NaN', () => {
    const line = ramp(400);
    for (const spec of Object.values(INDICATORS)) {
      const w = indicatorWarmup(spec.name);
      const enough = indicatorSeries(spec.name, line.slice(0, w), null);
      for (const [key, s] of Object.entries(enough)) expect(Number.isFinite(s.at(-1) as number), `${spec.name}.${key} 在 ${w} 根时应有值`).toBe(true);
      const short = w > 1 ? indicatorSeries(spec.name, line.slice(0, w - 1), null) : { x: [] as number[] };
      expect(Object.values(short).some((s) => !Number.isFinite(s.at(-1) as number)), `${spec.name} 的 warmup 比实际需要多`).toBe(true);
    }
  });
  it('参数按默认值补齐并钳进区间,未知指标直接报错', () => {
    expect(resolveArgs('macd', {})).toEqual({ fast: 12, slow: 26, signal: 9 });
    expect(resolveArgs('macd', { fast: 5, slow: 20, signal: 3 })).toEqual({ fast: 5, slow: 20, signal: 3 });
    expect(resolveArgs('rsi', { period: 0 })).toEqual({ period: 2 });
    expect(resolveArgs('supertrend', { multiple: 1.5 })).toEqual({ period: 10, multiple: 1.5 });
    expect(() => indicatorWarmup('not_an_indicator')).toThrow('unknown_indicator');
    expect(indicatorWarmup('macd', { fast: 5, slow: 20, signal: 3 })).toBe(22);
  });
  it('output 缺失或写错时回落到主输出', () => {
    const bars2 = ramp(120);
    expect(indicatorLine('macd', bars2, null)).toEqual(indicatorSeries('macd', bars2, null).macd);
    expect(indicatorLine('macd', bars2, null, 'not_a_line')).toEqual(indicatorSeries('macd', bars2, null).macd);
    expect(indicatorLine('macd', bars2, null, 'hist')).toEqual(indicatorSeries('macd', bars2, null).hist);
  });
  it('中英文别名可以查到规范名,规范名与 schema 枚举一一对应', () => {
    expect(resolveIndicatorName('布林')).toBe('bbands');
    expect(resolveIndicatorName('KDJ'.toLowerCase())).toBe('stoch');
    expect(resolveIndicatorName('一目')).toBe('ichimoku');
    expect(resolveIndicatorName('相对强弱')).toBe('rsi');
    expect(INDICATOR_ALIASES.rma).toBe('smma');
    const defs = schemas.research.$defs as Record<string, { properties: Record<string, { enum?: string[] }> }>;
    for (const key of ['PrimitiveParamsIndicatorCross', 'PrimitiveParamsIndicatorCrossExit', 'PrimitiveParamsIndicatorThreshold', 'PrimitiveParamsIndicatorThresholdExit', 'PrimitiveParamsIndicatorDivergence', 'PrimitiveParamsIndicatorDivergenceExit']) {
      expect(defs[key]!.properties.indicator!.enum, key).toEqual(INDICATOR_NAMES);
    }
    expect(defs.PrimitiveParamsIndicatorCross!.properties.compare_indicator!.enum).toEqual(INDICATOR_NAMES);
    expect(INDICATOR_NAMES).toHaveLength(42);
  });
});
