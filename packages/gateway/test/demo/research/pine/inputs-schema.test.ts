/**
 * inputs_schema:从源码推导、schema 自洽校验、参数校验(类型/范围/枚举/source),
 * 以及它在目录入库、准入、编译引用 pine_series 三处的强制。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { openStateDb } from '../../../../src/state-db.js';
import { PineCatalog, setPineCatalog } from '../../../../src/demo/research/pine/catalog.js';
import { parsePineInputs, validatePineInputs, checkInputsSchema, effectiveInputsSchema } from '../../../../src/demo/research/pine/inputs-schema.js';
import { admitScript, syntheticBars } from '../../../../src/demo/research/pine/admission.js';
import { applyInputs } from '../../../../src/demo/research/pine/client.js';
import { setPineRuntime, pineSeriesParamErrors, type PineRuntime } from '../../../../src/demo/research/primitives/pine.js';
import type { PineScript } from '../../../../src/demo/research/pine/catalog.js';
import { checkIR, defaultIR, node } from '../../../../src/demo/research/strategy.js';
import { registry } from '../../../../src/demo/research/primitives/index.js';

/** 直接调原语 compute,验证运行期同样拒绝不合 schema 的参数。 */
function registryCompute(p: Record<string, unknown>) {
  return registry.get('pine_series')!.compute({ bars: syntheticBars(40), i: 30, timeframe_ms: 3600000 }, p);
}

const SCRIPT = `//@version=5
indicator("demo", overlay=false)
length = input.int(14, "Length", minval=2, maxval=200)
mult = input.float(2.0, title="Mult", minval=0.1, step=0.1)
src = input.source(close, "Source")
mode = input.string("EMA", "Mode", options=["EMA", "SMA"])
useVol = input.bool(true, "Use volume")
legacy = input(20, "Legacy")
plot(ta.sma(src, length) * mult, "line")
`;

const clean: (() => void)[] = [];
afterEach(() => { clean.splice(0).forEach((f) => f()); setPineCatalog(null); setPineRuntime(null); });

describe('Pine inputs_schema', () => {
  it('从源码 input.*() 推导类型、默认值、范围、枚举、标题', () => {
    const p = parsePineInputs(SCRIPT);
    expect(p.length).toEqual({ type: 'int', default: 14, title: 'Length', min: 2, max: 200 });
    expect(p.mult).toMatchObject({ type: 'float', default: 2, title: 'Mult', min: 0.1, step: 0.1 });
    expect(p.src).toMatchObject({ type: 'source', default: 'close' });
    expect(p.mode).toMatchObject({ type: 'string', default: 'EMA', options: ['EMA', 'SMA'] });
    expect(p.useVol).toMatchObject({ type: 'bool', default: true });
    expect(p.legacy).toMatchObject({ type: 'int', default: 20 });
    expect(checkInputsSchema({ params: p })).toEqual([]);
  });

  it('参数校验:类型 / 范围 / 枚举 / source 白名单 / 未知参数;按变量名或标题都认', () => {
    const schema = effectiveInputsSchema({}, SCRIPT);
    expect(validatePineInputs(schema, { length: 20, Mult: 1.5, src: 'hl2', mode: 'SMA', useVol: false })).toEqual([]);
    expect(validatePineInputs(schema, { length: '30' })).toEqual([]); // 数字字符串可接受
    const errors = validatePineInputs(schema, { length: 1, mult: 'abc', src: 'close; plot(1)', mode: 'WMA', useVol: 'yes', nope: 1, legacy: 2.5 });
    expect(errors.join('\n')).toMatch(/length:1 小于下限 2/);
    expect(errors.join('\n')).toMatch(/mult:应为数字/);
    expect(errors.join('\n')).toMatch(/src:应为 open\/high/);
    expect(errors.join('\n')).toMatch(/mode:"WMA" 不在可选值/);
    expect(errors.join('\n')).toMatch(/useVol:应为 true\/false/);
    expect(errors.join('\n')).toMatch(/nope:脚本没有这个参数/);
    expect(errors.join('\n')).toMatch(/legacy:应为整数/);
  });

  it('schema 自洽检查:未知类型、min>max、默认值越界都拒', () => {
    expect(checkInputsSchema({ params: { a: { type: 'color' as never } } })[0]).toMatch(/未知类型/);
    expect(checkInputsSchema({ params: { a: { type: 'int', min: 5, max: 1 } } })[0]).toMatch(/min 5 > max 1/);
    expect(checkInputsSchema({ params: { a: { type: 'int', default: 0, min: 1 } } })[0]).toMatch(/小于下限.*默认值/);
  });

  it('参数值拼进源码前先过闸:source 注裸标识符,表达式 / 对象注入被拒', () => {
    expect(applyInputs(SCRIPT, { src: 'hl2' })).toContain('input.source(hl2, "Source")');
    expect(applyInputs(SCRIPT, { length: '30' })).toContain('input.int(30, "Length"');
    expect(() => applyInputs(SCRIPT, { src: 'close) + request.security(' })).toThrow(/pine_input_invalid/);
    expect(() => applyInputs(SCRIPT, { length: { evil: 1 } })).toThrow(/pine_input_invalid/);
  });

  it('目录入库:缺省 schema 从源码推导并存下;坏 schema 直接拒;只改名不作废准入', () => {
    const db = openStateDb(':memory:');
    clean.push(() => db.close());
    const catalog = new PineCatalog(db.db, () => 1);
    const created = catalog.create({ name: 'demo', script: SCRIPT });
    expect((created.inputs_schema as { derived?: boolean; params: Record<string, unknown> }).derived).toBe(true);
    expect(Object.keys((created.inputs_schema as { params: Record<string, unknown> }).params)).toEqual(['length', 'mult', 'src', 'mode', 'useVol', 'legacy']);
    expect(() => catalog.create({ name: 'bad', script: SCRIPT, inputs_schema: { params: { length: { type: 'int', min: 10, max: 1 } } } })).toThrow(/pine_inputs_schema_invalid/);
    const admitted = catalog.admit(created.id, { ok: true, checks: [], outputs: ['line'], warmup_bars: 14, sample_points: [], bars: 1, timeframe: '1h', tolerance: 0, warnings: [], ran_at: 1, method_version: 'x' });
    expect(catalog.update(admitted.id, { name: 'demo2' }).admitted).toBe(true);
    expect(catalog.update(admitted.id, { script: SCRIPT.replace('14', '21') }).admitted).toBe(false);
  });

  it('准入:参数不合 schema 直接判死,引擎一次都不跑', async () => {
    let calls = 0;
    const report = await admitScript(SCRIPT, async (i) => { calls++; return { bars: i.bars.length, warnings: [], series: { line: i.bars.map(() => 1) } }; }, {
      bars: syntheticBars(60), schema: effectiveInputsSchema({}, SCRIPT), inputs: { length: 500 },
    });
    expect(report.ok).toBe(false);
    expect(report.checks).toEqual([{ name: 'inputs', ok: false, message: expect.stringMatching(/length:500 大于上限 200/) }]);
    expect(calls).toBe(0);
    const good = await admitScript(SCRIPT, async (i) => ({ bars: i.bars.length, warnings: [], series: { line: i.bars.map(() => 1) } }), {
      bars: syntheticBars(60), schema: effectiveInputsSchema({}, SCRIPT), inputs: { length: 20 },
    });
    expect(good.ok, JSON.stringify(good.checks)).toBe(true);
    expect(good.checks[0]!.name).toBe('inputs');
  });

  it('编译引用 pine_series 时参数不合 schema → checkIR 判死,summary 里说清原因', () => {
    const script: PineScript = {
      id: 'pine_demo', name: 'demo', description: '', aliases: [], script: SCRIPT, inputs_schema: {},
      outputs: ['line'], source: 'user', license: null, author: null, admitted: true,
      admission_report: { ok: true, checks: [], outputs: ['line'], warmup_bars: 14, sample_points: [], bars: 1, timeframe: '1h', tolerance: 0, warnings: [], ran_at: 0, method_version: 'pine_admission_v2' },
      created_at: 0, updated_at: 0, usage_count: 0,
    };
    const rt: PineRuntime = { script: (id) => (id === script.id ? script : null), series: () => ({ line: [] }) };
    setPineRuntime(rt);
    const ir = (inputs: unknown) => {
      const x = defaultIR();
      x.signal = [node('pine_series', { script_id: 'pine_demo', output: 'line', operator: 'above', compare_to: 'close', warmup_bars: 20, inputs })];
      return x;
    };
    expect(checkIR(ir([{ name: 'length', value: 30 }, { name: 'mode', value: 'SMA' }]), '1h').ok).toBe(true);
    const bad = checkIR(ir([{ name: 'length', value: 999 }, { name: 'mode', value: 'WMA' }]), '1h');
    expect(bad.ok).toBe(false);
    expect(bad.checks.find((c) => c.name === 'warmup')!.ok).toBe(false);
    expect(bad.summary).toMatch(/参数不合 schema.*length:999 大于上限 200/);
    expect(pineSeriesParamErrors({ script_id: 'pine_demo', inputs: [{ name: 'mode', value: 'WMA' }] })[0]).toMatch(/不在可选值/);
    // 运行期同样拒
    expect(() => (registryCompute({ script_id: 'pine_demo', output: 'line', operator: 'above', compare_to: 'close', warmup_bars: 20, inputs: [{ name: 'length', value: 1 }] }))).toThrow(/pine_inputs_invalid/);
  });
});

