import { describe, expect, it } from 'vitest';
import type { StrategyIR } from '@trading-swarm/contracts';
import { node } from '../../../../src/demo/research/strategy.js';
import { compileCheck } from '../../../../src/demo/research/improve/runner.js';
import { diagnosisGenerator, RULES } from '../../../../src/demo/research/improve/generators/diagnosis.js';
import { neighborhoodGenerator, neighborhoodVariants, plateauNeighbors } from '../../../../src/demo/research/improve/generators/neighborhood.js';
import { swapGenerator, swapProposals } from '../../../../src/demo/research/improve/generators/swap.js';
import { getGenerator, loadOptionalGenerator, registeredGenerators } from '../../../../src/demo/research/improve/generators/index.js';
import { periodSlots } from '../../../../src/demo/research/improve/generators/params.js';
import type { Candidate, GeneratorContext } from '../../../../src/demo/research/improve/types.js';
import { emaIR } from './fixtures.js';

const check = (ir: StrategyIR) => { const r = compileCheck(ir, '1h'); return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? '' }; };
function ctx(ir: StrategyIR, diagnosis: GeneratorContext['diagnosis'] = []): GeneratorContext {
  const parent: Candidate = { id: 'p', parent_id: null, generation: 0, generator: 'baseline', ir, diff: [], rationale: '' };
  return { parent, evaluation: { candidate_id: 'p', folds: [], objective: null, gates: [], passed: false }, diagnosis, data: { universe: [], timeframe: '1h', timeframe_ms: 3600000, assets: [], segments: { folds: [], train: { from_ms: 0, to_ms: 1 }, validation: { from_ms: 2, to_ms: 3 }, holdout: { from_ms: 4, to_ms: 5 } }, warmup_bars: 300 }, budget: 8, check };
}

describe('候选生成器(零模型)', () => {
  it('注册表:三个内置生成器在册;oracle 按约定动态加载(模块缺失时返回 null 不抛)', async () => {
    expect(registeredGenerators()).toEqual(expect.arrayContaining(['diagnosis', 'neighborhood', 'swap']));
    expect(getGenerator('swap')).toBe(swapGenerator);
    const o = await loadOptionalGenerator('oracle');
    expect(o === null || o.name === 'oracle').toBe(true);
    expect(await loadOptionalGenerator('model')).toBeNull();
  });
  it('诊断驱动:按映射表出确定性改法,每条带理由与诊断证据,全部过编译检查', async () => {
    const ir = emaIR();
    const out = await diagnosisGenerator.generate(ctx(ir, [
      { key: 'stop_tight', severity: 'high', text: '60% 的交易被止损打出' },
      { key: 'concentration', severity: 'medium', text: '利润集中' },
      { key: 'fees', severity: 'medium', text: '手续费占 40%' },
      { key: 'worst_exit', severity: 'medium', text: '亏损主要来自「信号离场」出场(40 笔,合计 -900)' },
      { key: 'exit_mix', severity: 'info', text: '按退出方式…' },
    ]));
    expect(out.length).toBeGreaterThanOrEqual(5);
    expect(out.every((c) => c.generator === 'diagnosis' && c.rationale.length > 5 && c.diff.length && compileCheck(c.ir, '1h').ok)).toBe(true);
    // stop_tight:order_blocks → 换 swing_low_stop / swing_length ×2
    expect(out.find((c) => c.diff[0]!.path === 'risk.stop')?.ir.risk.stop).toEqual({ primitive: 'swing_low_stop', params: { lookback: 20 } });
    expect(out.find((c) => c.diff[0]!.path === 'risk.stop.params.swing_length')?.diff[0]).toMatchObject({ from: 5, to: 10 });
    // concentration:加保本
    expect(out.some((c) => c.ir.exit.some((e) => e.primitive === 'breakeven_after_r'))).toBe(true);
    // fees:信号周期 ×1.5(只动信号)
    expect(out.find((c) => (c.evidence as { finding: string }).finding === 'fees')?.diff).toEqual([{ path: 'signal.0.params.fast', from: 20, to: 30 }, { path: 'signal.0.params.slow', from: 50, to: 75 }]);
    // worst_exit:信号离场换成吊灯线
    expect(out.find((c) => (c.evidence as { finding: string }).finding === 'worst_exit')?.ir.exit[0]).toMatchObject({ primitive: 'chandelier_trail' });
    // info 级别不出候选
    expect(out.some((c) => (c.evidence as { finding: string }).finding === 'exit_mix')).toBe(false);
    // 同样输入同样输出(确定性)
    expect(JSON.stringify(await diagnosisGenerator.generate(ctx(ir, [{ key: 'fees', severity: 'medium', text: '' }])))).toBe(JSON.stringify(await diagnosisGenerator.generate(ctx(ir, [{ key: 'fees', severity: 'medium', text: '' }]))));
    // 映射表每条诊断都有规则
    for (const k of ['stop_tight', 'exposure', 'decay', 'concentration', 'fees', 'worst_exit', 'sample']) expect(typeof RULES[k]).toBe('function');
  });
  it('参数邻域:周期类参数 ±25%/±50%(含通用指标 args 里的周期,入场离场一起缩放),平台检验点是整体 ±25%', async () => {
    const ir = emaIR();
    expect(periodSlots(ir).map((s) => s.path)).toEqual(['signal.0.params.fast', 'signal.0.params.slow', 'risk.stop.params.swing_length', 'exit.0.params.args.period', 'exit.0.params.compare_args.period', 'exit.2.params.atr_period']);
    const vs = neighborhoodVariants(ir);
    expect(vs.slice(0, 4).map((v) => v.factor)).toEqual([0.75, 1.25, 0.5, 1.5]);
    const up = vs[1]!.ir;
    expect(up.signal[0]!.params).toEqual({ fast: 25, slow: 63 });
    expect(up.exit[0]!.params).toMatchObject({ args: { period: 25 }, compare_args: { period: 63 } });
    expect(vs.find((v) => v.label === '信号周期 ×1.25')!.ir.exit[0]!.params).toMatchObject({ args: { period: 20 } });
    expect(plateauNeighbors(ir).map((n) => n.ir.signal[0]!.params)).toEqual([{ fast: 15, slow: 38 }, { fast: 25, slow: 63 }]);
    const out = await neighborhoodGenerator.generate(ctx(ir));
    expect(out.length).toBe(vs.length);
    expect(out.every((c) => compileCheck(c.ir, '1h').ok && c.generator === 'neighborhood')).toBe(true);
  });
  it('组件替换:信号/离场/止损/方向门逐段换同类别原语,止盈目标不换,过不了编译检查的丢掉', async () => {
    const ir: StrategyIR = { ...emaIR(), regime: node('trend_state', { adx_period: 14, adx_min: 20, ema_fast: 20, ema_slow: 50, htf: '4h' }) };
    const props = swapProposals(ir, '1h');
    const sections = new Set(props.map((p) => (p.evidence as { section: string }).section));
    expect([...sections].sort()).toEqual(['exit', 'regime', 'signal', 'sizing', 'stop']);
    expect(props.slice(0, 5).map((p) => (p.evidence as { section: string }).section)).toEqual(['sizing', 'stop', 'signal', 'exit', 'exit']);// 轮流排,仓位段(波动率目标)第一条道
    expect(props.some((p) => p.diff[0]!.path === 'exit.1')).toBe(false);// fixed_r_target 不换
    for (const p of props) { const e = p.evidence as { from: string; to: string }; expect(e.from).not.toBe(e.to); }
    const out = await swapGenerator.generate(ctx(ir));
    expect(out.length).toBeGreaterThan(5);
    expect(out.every((c) => compileCheck(c.ir, '1h').ok)).toBe(true);
    // 把死叉离场换掉、又没有别的信号离场时,吊灯线仍在,状态机检查照样过;把唯一的追踪出场换成 time_stop 这类不合法的不会出现
    expect(out.every((c) => c.ir.exit.some((e) => ['chandelier_trail', 'swing_structure_stop', 'trend_break', 'breakeven_after_r'].includes(e.primitive) || /_exit$/.test(e.primitive)))).toBe(true);
  });
  it('编译检查:参数越界 / 快慢颠倒直接不过;不新增策略规范 block', () => {
    expect(compileCheck(emaIR(50, 20), '1h').ok).toBe(false);
    const bad = emaIR(); bad.risk.stop = node('atr_stop', { atr_period: 14, multiple: 0.01 });
    const r = compileCheck(bad, '1h');
    expect(r.ok || r.reason?.startsWith('spec_block')).toBe(true);
    expect(compileCheck(bad, '1h', new Set(r.blocks)).ok).toBe(true);
  });
});
