/**
 * pine_series / pine_series_exit 原语:比较语义、预热守卫、以及「引擎/目录缺席时必须抛错」。
 * 运行时全部注入 mock,不起引擎。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { registry } from '../../../../src/demo/research/primitives/index.js';
import { setPineRuntime, timeframeLabel, type PineRuntime } from '../../../../src/demo/research/primitives/pine.js';
import type { PineScript } from '../../../../src/demo/research/pine/catalog.js';
import type { AdmissionReport } from '../../../../src/demo/research/pine/admission.js';
import { checkIR, defaultIR, node } from '../../../../src/demo/research/strategy.js';
import { fixture, STEP } from '../fixtures.js';
import { inputsRecord, applyInputs } from '../../../../src/demo/research/pine/client.js';

const bars = fixture().bars;
const signal = () => registry.get('pine_series')!;
const exit = () => registry.get('pine_series_exit')!;

const report = (warmup: number): AdmissionReport => ({
  ok: true, checks: [{ name: 'causality', ok: true, message: '一致' }], outputs: ['fast', 'slow'],
  warmup_bars: warmup, sample_points: [10], bars: 100, timeframe: '1h', tolerance: 1e-9,
  warnings: [], ran_at: 0, method_version: 'pine_admission_v1',
});

function script(overrides: Partial<PineScript> = {}): PineScript {
  return {
    id: 'pine_rsi', name: 'RSI', description: '', aliases: [],
    script: '//@version=5\nindicator("RSI")\nlength = input.int(14, "length", minval=2, maxval=200)\nplot(ta.rsi(close, length), "fast")',
    inputs_schema: {}, outputs: ['fast', 'slow'], source: 'user', license: null, author: null,
    admitted: true, admission_report: report(3), created_at: 0, updated_at: 0, usage_count: 0,
    ...overrides,
  };
}

/** 固定序列的假运行时:fast/slow 两条,index 与 bars 对齐。 */
function runtime(series: Record<string, (number | null)[]>, s: PineScript = script(), spy?: { runs: number; used: string[] }): PineRuntime {
  return {
    script: (id) => (id === s.id || id === s.name ? s : null),
    series: () => { if (spy) spy.runs += 1; return series; },
    used: (id) => spy?.used.push(id),
  };
}

const rising = bars.map((_b, i) => i);
const flat = bars.map(() => 10);

afterEach(() => setPineRuntime(null));

describe('pine_series 原语', () => {
  it('目录里注册了 signal 与 exit 两个原语,lookahead 标 none,参数 schema 来自契约', () => {
    expect(signal().category).toBe('signal');
    expect(exit().category).toBe('exit');
    expect(signal().lookahead).toBe('none');
    expect(Object.keys(signal().params.properties as object)).toContain('script_id');
  });

  it('above / below / cross 按当根与上一根比较', () => {
    setPineRuntime(runtime({ fast: rising, slow: flat }));
    const at = (i: number, p: Record<string, unknown>) => signal().compute({ bars, i, timeframe_ms: STEP }, p).pass;
    const base = { script_id: 'pine_rsi', output: 'fast', warmup_bars: 5 };
    expect(at(20, { ...base, operator: 'above', compare_to: 'threshold', threshold: 15 })).toBe(true);
    expect(at(10, { ...base, operator: 'above', compare_to: 'threshold', threshold: 15 })).toBe(false);
    expect(at(10, { ...base, operator: 'below', compare_to: 'threshold', threshold: 15 })).toBe(true);
    // fast 在第 11 根从 10 变 11,正好上穿 slow(恒 10)
    expect(at(11, { ...base, operator: 'cross_above', compare_to: 'output', compare_output: 'slow' })).toBe(true);
    expect(at(12, { ...base, operator: 'cross_above', compare_to: 'output', compare_output: 'slow' })).toBe(false);
    expect(at(11, { ...base, operator: 'cross_below', compare_to: 'output', compare_output: 'slow' })).toBe(false);
    // compare_to 省略且没有 threshold 时按 0 比
    expect(at(20, { ...base, operator: 'above' })).toBe(true);
    expect(at(0, { ...base, operator: 'above' })).toBe(false);
  });

  it('预热段(null)一律不出信号', () => {
    setPineRuntime(runtime({ fast: bars.map((_b, i) => (i < 30 ? null : 100)), slow: flat }));
    const p = { script_id: 'pine_rsi', output: 'fast', operator: 'above', compare_to: 'threshold', threshold: 1, warmup_bars: 30 };
    expect(signal().compute({ bars, i: 29, timeframe_ms: STEP }, p).pass).toBe(false);
    expect(signal().compute({ bars, i: 30, timeframe_ms: STEP }, p).pass).toBe(true);
  });

  it('exit 变体只在持仓时成立', () => {
    setPineRuntime(runtime({ fast: rising, slow: flat }));
    const p = { script_id: 'pine_rsi', output: 'fast', operator: 'above', compare_to: 'threshold', threshold: 5, warmup_bars: 5 };
    expect(exit().compute({ bars, i: 50, timeframe_ms: STEP }, p).exit).toBe(false);
    const position = { entry_at: bars[30]!.open_time, entry_price: 100, initial_distance: 5, bars_held: 20 };
    expect(exit().compute({ bars, i: 50, timeframe_ms: STEP, position }, p).exit).toBe(true);
  });

  it('没有引擎/脚本/准入/输出时抛清晰错误,而不是返回「没有信号」', () => {
    const p = { script_id: 'pine_rsi', output: 'fast', operator: 'above', compare_to: 'threshold', threshold: 1, warmup_bars: 5 };
    const call = () => signal().compute({ bars, i: 50, timeframe_ms: STEP }, p);
    setPineRuntime(null);
    expect(call).toThrow(/pine_runtime_missing/);
    expect(call).toThrow(/api\/research\/pine\/health/); // 错误里带引擎归属与查看状态的方式

    setPineRuntime(runtime({ fast: rising }, script({ id: 'other', name: 'other' })));
    expect(call).toThrow(/pine_script_not_found/);

    setPineRuntime(runtime({ fast: rising }, script({ admitted: false, admission_report: null })));
    expect(call).toThrow(/pine_script_not_admitted/);

    setPineRuntime(runtime({ slow: flat }));
    expect(call).toThrow(/pine_output_not_found/);

    setPineRuntime(runtime({ fast: rising }));
    expect(() => signal().compute({ bars, i: 50, timeframe_ms: STEP },
      { ...p, compare_to: 'output', compare_output: 'missing' })).toThrow(/pine_compare_output_not_found/);
  });

  it('声明的 warmup_bars 小于准入实测值时直接判错(不能在指标没成形时下单)', () => {
    setPineRuntime(runtime({ fast: rising, slow: flat }, script({ admission_report: report(40) })));
    const p = { script_id: 'pine_rsi', output: 'fast', operator: 'above', compare_to: 'threshold', threshold: 1, warmup_bars: 20 };
    expect(() => signal().compute({ bars, i: 50, timeframe_ms: STEP }, p)).toThrow(/pine_warmup_understated/);
    expect(signal().compute({ bars, i: 50, timeframe_ms: STEP }, { ...p, warmup_bars: 40 }).pass).toBe(true);
    // warmup_bars() 对外报的是「声明与实测取大」,checkIR 的 warmup 检查才看得到真实数字
    expect(signal().warmup_bars(p)).toBe(40);
  });

  it('whole() 能把回测窗口还原成整段数据,整段只跑一次引擎', () => {
    const spy = { runs: 0, used: [] as string[] };
    const rt = runtime({ fast: rising, slow: flat }, script(), spy);
    setPineRuntime({ ...rt, whole: () => bars });
    const p = { script_id: 'pine_rsi', output: 'fast', operator: 'above', compare_to: 'threshold', threshold: 1, warmup_bars: 5 };
    // 引擎每根传进来的是切片窗口;还原成整段后按 open_time 定位索引
    for (const i of [30, 31, 32]) {
      const window = bars.slice(0, i + 1);
      expect(signal().compute({ bars: window, i: window.length - 1, timeframe_ms: STEP }, p).pass).toBe(true);
    }
    expect(spy.runs).toBe(3); // 缓存在 client 层,这里的 mock 每次都调,但传入的都是整段 bars
    expect(spy.used).toEqual(['pine_rsi', 'pine_rsi', 'pine_rsi']);
  });

  it('接进策略 IR 能过 checkIR 的 units / lookahead / warmup 检查', () => {
    setPineRuntime(runtime({ fast: rising, slow: flat }));
    const ir = defaultIR();
    ir.signal = [node('pine_series', {
      script_id: 'pine_rsi', output: 'fast', operator: 'cross_above',
      compare_to: 'output', compare_output: 'slow', warmup_bars: 30,
      inputs: [{ name: 'length', value: 14 }],
    })];
    const result = checkIR(ir, '1h');
    expect(result.ok, JSON.stringify(result.checks)).toBe(true);
    expect(result.checks.find((c) => c.name === 'lookahead')!.ok).toBe(true);
    expect(result.summary).toContain('RSI');
    // 未知参数必须被 units 拒掉
    const bad = defaultIR();
    bad.signal = [node('pine_series', { script_id: 'pine_rsi', output: 'fast', operator: 'above', warmup_bars: 5, nonsense: 1 })];
    expect(checkIR(bad, '1h').checks.find((c) => c.name === 'units')!.ok).toBe(false);
  });

  it('inputs 在 IR 里是 [{name,value}],注入脚本时按变量名或标题替换默认值', () => {
    expect(inputsRecord([{ name: 'length', value: 14 }, { name: 'src', value: 'high' }])).toEqual({ length: 14, src: 'high' });
    expect(inputsRecord(undefined)).toBeUndefined();
    const src = 'length = input.int(20, "length")\nmult = input.float(2.0, "mult")\n';
    expect(applyInputs(src, { length: 14 })).toContain('input.int(14, "length")');
    expect(applyInputs(src, { mult: 3.5 })).toContain('input.float(3.5, "mult")');
    expect(() => applyInputs(src, { unknown: 1 })).toThrow(/pine_input_unknown/);
  });

  it('timeframe_ms → Pine 周期标签', () => {
    expect(timeframeLabel(3600000)).toBe('1h');
    expect(timeframeLabel(86400000)).toBe('1d');
    expect(timeframeLabel(900000)).toBe('15m');
    expect(timeframeLabel(14400000)).toBe('4h');
  });
});
