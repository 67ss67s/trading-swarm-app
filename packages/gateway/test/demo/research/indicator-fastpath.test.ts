/** 指标快路径逐位对拍(2026-09-26 性能改造):登记视图 + 数值列缓存 + 逐根记忆 + 视图起点 0 的整段前缀,
 * 必须与改造前的实现逐位相同(同一个 double、同一位置的 NaN、-0 也要一致;比较用 Object.is)。
 * 参照:ref/indicators-ref.ts 是改造前 primitives/indicators.ts 的冻结副本;原语与订单意图层用 setIndicatorFastPath(false) 跑原路径做参照。 */
import { describe, it, expect, afterEach } from 'vitest';
import type { ResearchBar, StrategyIR } from '@trade-gate/contracts';
import * as REF from './ref/indicators-ref.js';
import { INDICATORS, PREFIX_SAFE, indicatorSeries, indicatorLine, registerWindow, setIndicatorFastPath, resolveArgs } from '../../../src/demo/research/primitives/indicators.js';
import { registry } from '../../../src/demo/research/primitives/index.js';
import { orderIntents, runOrderPath, mirrorBars } from '../../../src/demo/research/orders/index.js';
import { numericBars } from '../../../src/demo/research/engine.js';
import { node } from '../../../src/demo/research/strategy.js';
import { synthBars, benchIR, rng, STEP15 } from './orders/perf-fixture.js';

afterEach(() => setIndicatorFastPath(true));
/** 逐位深比较:数字用 Object.is(NaN===NaN、+0≠-0),数组/对象逐项;返回第一处差异的路径,相同返回 null */
function diff(a: unknown, b: unknown, path = '$'): string | null {
  if (typeof a === 'number' || typeof b === 'number') return Object.is(a, b) ? null : `${path}: ${String(a)} !== ${String(b)}`;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b ? null : `${path}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array/object mismatch`;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return `${path}: keys ${ka.join(',')} vs ${kb.join(',')}`;
  for (const k of ka) { const d = diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`); if (d) return d; }
  return null;
}
const N = 3000, VIEW = 500, STR = synthBars(N, 11), NUM = numericBars(STR);
/** 每个指标:缺省参数 + 最小参数 + 两组随机参数(整数参数在 [min, min(max,80)] 里取) */
function argSets(name: string): Record<string, number>[] {
  const spec = INDICATORS[name]!, r = rng(name.length * 977 + name.charCodeAt(0));
  const pick = () => Object.fromEntries(spec.args.map((a) => { const hi = Math.min(a.max, a.integer === false ? a.max : 80), v = a.min + r() * (hi - a.min); return [a.key, a.integer === false ? Math.round(v * 100) / 100 : Math.round(v)]; }));
  return [Object.fromEntries(spec.args.map((a) => [a.key, a.default])), Object.fromEntries(spec.args.map((a) => [a.key, a.min])), pick(), pick()];
}
/** 订单核同口径的视图:前段 s=0 逐步变长,满 view 后逐根滑动 */
const windows = (() => { const out: [number, number][] = []; for (let i = 0; i < N; i += i < VIEW + 20 ? 13 : 97) { const s = Math.max(0, i - VIEW + 1); out.push([s, i - s + 1]); } out.push([0, 1], [0, 2], [N - VIEW, VIEW], [0, N]); return out; })();

describe('indicator fast path is bit-identical to the frozen original', () => {
  for (const [label, src] of [['string bars', STR], ['numeric bars', NUM]] as const) {
    it(`every indicator × 4 arg sets × growing and sliding windows (${label})`, () => {
      let checked = 0;
      // 字符串 K 线只多验证取价列(与指标无关),参数组减半省时间
      for (const name of Object.keys(INDICATORS)) for (const raw of argSets(name).slice(0, label === 'string bars' ? 2 : 4)) {
        const spec = INDICATORS[name]!;
        for (const [s, len] of windows) {
          const plain = src.slice(s, s + len), view = registerWindow(src.slice(s, s + len), src, s);
          const want = REF.indicatorSeries(name, plain, raw);
          // 原始路径(未登记)、快路径 indicatorSeries、快路径 indicatorLine(每条输出 + 缺省输出)都要逐位一致
          const d = diff(indicatorSeries(name, plain, raw), want) ?? diff(indicatorSeries(name, view, raw), want)
            ?? spec.outputs.map((o) => diff(indicatorLine(name, view, raw, o), want[o])).find(Boolean) ?? diff(indicatorLine(name, view, raw), want[spec.outputs[0]!]);
          if (d) throw new Error(`${name} ${JSON.stringify(resolveArgs(name, raw))} window [${s}, +${len}] ${label}: ${d}`);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(Object.keys(INDICATORS).length * 2 * 50);
    }, 300_000);
  }
  it('PREFIX_SAFE covers every indicator and each is prefix-consistent under the original implementation', () => {
    expect([...PREFIX_SAFE].sort()).toEqual(Object.keys(INDICATORS).sort());
    for (const name of PREFIX_SAFE) for (const raw of argSets(name)) {
      const full = REF.indicatorSeries(name, STR, raw);
      for (const len of [1, 2, 3, 10, 27, 60, 150, 500, 1234, N - 1]) {
        const part = REF.indicatorSeries(name, STR.slice(0, len), raw);
        const d = diff(part, Object.fromEntries(Object.entries(full).map(([k, v]) => [k, v.slice(0, len)])));
        if (d) throw new Error(`${name} ${JSON.stringify(raw)} prefix ${len}: ${d}`);
      }
    }
  }, 300_000);
  it('source array appended after columns were cached: stale columns are rebuilt', () => {
    const src = STR.slice(0, 800), w1 = registerWindow(src.slice(300, 800), src, 300);
    expect(diff(indicatorLine('ema', w1, { period: 20 }), REF.indicatorLine('ema', src.slice(300, 800), { period: 20 }))).toBeNull();
    src.push(STR[800]!, STR[801]!);
    const w2 = registerWindow(src.slice(302, 802), src, 302);
    expect(diff(indicatorLine('ema', w2, { period: 20 }), REF.indicatorLine('ema', src.slice(302, 802), { period: 20 }))).toBeNull();
    const w3 = registerWindow(src.slice(0, 802), src, 0);
    expect(diff(indicatorLine('supertrend', w3, null, 'direction'), REF.indicatorLine('supertrend', src.slice(0, 802), null, 'direction'))).toBeNull();
  });
});

/** 原语层:同一组视图,快路径(登记)与原路径(setIndicatorFastPath(false))的 compute 结果逐位一致 */
describe('generic primitives: fast path equals original path', () => {
  const nodes: [string, Record<string, unknown>][] = [
    ['indicator_cross', { indicator: 'ema', args: { period: 20 }, compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: 50 }, direction: 'cross_above' }],
    ['indicator_cross', { indicator: 'macd', output: 'macd', compare_to: 'indicator', compare_indicator: 'macd', compare_output: 'signal', direction: 'cross_below' }],
    ['indicator_cross', { indicator: 'sma', args: { period: 30 }, compare_to: 'price', compare_price: 'hlc3', direction: 'below' }],
    ['indicator_cross', { indicator: 'supertrend', output: 'supertrend', compare_to: 'price', compare_price: 'ohlc4', direction: 'cross_above' }],
    ['indicator_cross', { indicator: 'ichimoku', output: 'span_a', compare_to: 'indicator', compare_output: 'span_b', direction: 'above' }],
    ['indicator_cross', { indicator: 'bbands', output: 'upper', compare_to: 'price', compare_price: 'hl2', direction: 'cross_below' }],
    ['indicator_cross', { indicator: 'rsi', args: { period: 14 }, compare_to: 'constant', constant: 50, direction: 'cross_above' }],
    ['indicator_threshold', { indicator: 'rsi', args: { period: 14 }, operator: 'cross_above', threshold: 30 }],
    ['indicator_threshold', { indicator: 'atr', args: { period: 14 }, operator: 'above', threshold: 150 }],
    ['indicator_threshold', { indicator: 'adx', output: 'adx', operator: 'above', threshold: 20 }],
    ['indicator_threshold', { indicator: 'bbands', output: 'percent_b', operator: 'cross_below', threshold: 0 }],
    ['indicator_threshold_exit', { indicator: 'stochrsi', output: 'k', operator: 'cross_below', threshold: 80 }],
    ['indicator_divergence', { indicator: 'rsi', args: { period: 14 }, swing_length: 3, lookback: 60 }],
    ['indicator_divergence', { indicator: 'macd', output: 'hist', swing_length: 2, lookback: 40 }],
    ['indicator_divergence_exit', { indicator: 'cci', swing_length: 3, lookback: 50 }],
    ['indicator_level', { indicator: 'ema', args: { period: 50 }, buffer_atr: 0.5 }],
    ['indicator_level', { indicator: 'keltner', output: 'lower' }],
    ['atr_stop', { atr_period: 14, multiple: 2 }],
  ];
  it('indicator_cross / indicator_threshold / divergence / indicator_level / atr_stop, long and mirrored, every 5th bar', () => {
    const run = (fast: boolean) => {
      setIndicatorFastPath(fast); const out: unknown[] = [];
      for (const src of [NUM, mirrorBars(NUM)]) for (let i = 1; i < N; i += 5) {
        const s = Math.max(0, i - VIEW + 1), bars = registerWindow(src.slice(s, i + 1), src, s);
        const ctx = { bars, i: bars.length - 1, timeframe_ms: STEP15, side: 'long' as const, series: src, series_i: i, position: { entry_at: src[Math.max(0, i - 20)]!.open_time, entry_price: 1, initial_distance: 1, bars_held: 20 } };
        for (const [name, p] of nodes) { try { out.push(registry.get(name)!.compute(ctx, p)); } catch (e) { out.push(`throw:${(e as Error).message}`); } }
      }
      return out;
    };
    const ref = run(false), fast = run(true);
    expect(ref.length).toBe(fast.length);
    const d = diff(fast, ref); if (d) throw new Error(d);
    // 对拍要有内容:确实有穿越/背离触发
    expect(ref.filter((x) => (x as { pass?: boolean }).pass === true).length).toBeGreaterThan(50);
  }, 300_000);
});

/** 订单意图与执行核全链路:意图、计划、成交、净值逐位一致 */
describe('orderIntents / runOrderPath: fast path equals original path', () => {
  const extraIR = (): StrategyIR => {
    const ir = benchIR('long');
    return { ...ir, signal: [node('indicator_threshold', { indicator: 'rsi', args: { period: 14 }, operator: 'cross_above', threshold: 45 }), node('indicator_cross', { indicator: 'supertrend', output: 'direction', compare_to: 'constant', constant: 0, direction: 'above' })], regime: node('indicator_cross', { indicator: 'ichimoku', output: 'span_a', compare_to: 'indicator', compare_output: 'span_b', direction: 'above' }), exit: [...ir.exit, node('indicator_divergence_exit', { indicator: 'macd', output: 'hist', swing_length: 3, lookback: 60 })], order: { direction: 'short', market: 'perp', leverage: 3, entry: { type: 'limit', price: node('indicator_level', { indicator: 'bbands', output: 'upper' }) } } } as StrategyIR;
  };
  const cases: [string, StrategyIR, ResearchBar[]][] = [['long numeric', benchIR('long'), NUM], ['long string', benchIR('long'), STR], ['both numeric', benchIR('both'), NUM], ['short limit + divergence exit', extraIR(), NUM]];
  for (const [label, ir, src] of cases) {
    it(`${label}: 3000 bars, view 500`, () => {
      const opts = { fee_rate: '0.0005', slippage_bps: '5', from_index: 250, to_index: N - 1, view: VIEW };
      const path = () => runOrderPath({ ir, bars: src, timeframe_ms: STEP15, symbol: 'T-USDT', from_index: 250, to_index: N - 1, initial_cash: 10000, view_bars: VIEW });
      setIndicatorFastPath(false); const refI = orderIntents(ir, src, STEP15, opts), refP = path();
      setIndicatorFastPath(true); const fastI = orderIntents(ir, src, STEP15, opts), fastP = path();
      expect(diff(fastI, refI)).toBeNull();
      expect(diff(fastP, refP)).toBeNull();
      expect(refI.intents.filter(Boolean).length).toBeGreaterThan(3);
    }, 300_000);
  }
});
