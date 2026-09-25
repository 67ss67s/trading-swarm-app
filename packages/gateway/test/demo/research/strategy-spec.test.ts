import { describe, it, expect } from 'vitest';
import { fixture, params } from './fixtures.js';
import { checkIRSpec, checkProposalSpec, specText, STRATEGY_SPEC_VERSION, STRATEGY_SPEC_VERSION_V1 } from '../../../src/demo/research/strategy-spec.js';
import { compileConstraints, compileStrategy, defaultIR, node } from '../../../src/demo/research/strategy.js';
// 规范 v1(旧口径 LEGACY_ORDER_GATE)的条款测试;v2(结构口径)见 structure-exits.test.ts
import { LEGACY_ORDER_GATE as DEFAULT_ORDER_GATE } from '../../../src/demo/research/order-gate.js';
import { runReplay } from '../../../src/demo/research/engine.js';
import { hash } from '../../../src/demo/research/primitives.js';
const exec = { fee_rate: '0.001', slippage_bps: '5' };
describe('strategy spec · IR', () => {
  it('default IR passes with warnings only (description discipline, no block)', () => {
    const c = compileConstraints('1h', null, exec, DEFAULT_ORDER_GATE, defaultIR());
    const r = checkIRSpec(defaultIR(), c);
    expect(r.version).toBe(STRATEGY_SPEC_VERSION_V1); expect(r.ok).toBe(true);
    expect(r.violations.every((v) => v.severity === 'warn')).toBe(true);
    expect(r.violations.map((v) => v.code)).toContain('description_missing_signal_frequency');
  });
  it('fixed R below min RR and missing target are blocks', () => {
    const c = compileConstraints('1h', null, exec, DEFAULT_ORDER_GATE);
    const ir = defaultIR(); ir.exit = [node('chandelier_trail', { atr_period: 22, multiple: 3 }), node('fixed_r_target', { r: 1 }, true)];
    const r = checkIRSpec(ir, c); expect(r.ok).toBe(false); expect(r.violations.find((v) => v.code === 'fixed_r_below_min_rr')?.severity).toBe('block');
    ir.exit = [node('chandelier_trail', { atr_period: 22, multiple: 3 })];
    expect(checkIRSpec(ir, c).violations.map((v) => v.code)).toContain('target_source_missing');
  });
  it('a 2 ATR stop on a dataset whose floor needs more ATR is blocked when most candidates would be widened', () => {
    const d = fixture(), ir = defaultIR(); ir.risk.stop = node('atr_stop', { atr_period: 5, multiple: 0.2 });
    const c = compileConstraints('1h', d, exec, DEFAULT_ORDER_GATE, ir);
    expect(c.stop_fit_rate).not.toBeNull(); expect(c.stop_fit_rate!).toBeGreaterThan(0.5);
    const r = checkIRSpec(ir, c); expect(r.ok).toBe(false); expect(r.violations.map((v) => v.code)).toContain('stop_mostly_widened');
  });
  it('compile without text returns spec + readable rules', async () => {
    const r = await compileStrategy({ ir: defaultIR(), timeframe: '1h' });
    expect(r.spec?.version).toBe(STRATEGY_SPEC_VERSION); expect(r.rules?.length).toBeGreaterThan(5);
    expect(r.rules?.find((x) => x.category === 'stop')?.primitive).toBe('atr_stop');
    expect(specText(r.constraints!, 'b_agent')).toContain('PROPOSE');
  });
});
describe('strategy spec · agent proposal', () => {
  it('flags tight stop / no target / low RR against the frozen gate', () => {
    expect(checkProposalSpec({ stop: '99.5', target: null }, '100', exec, DEFAULT_ORDER_GATE)).toEqual(['proposal_stop_below_cost_floor', 'proposal_stop_below_2x_cost', 'proposal_no_target']);
    expect(checkProposalSpec({ stop: '97', target: '101' }, '100', exec, DEFAULT_ORDER_GATE)).toEqual(['proposal_rr_below_min']);
    expect(checkProposalSpec({ stop: '97', target: '106' }, '100', exec, DEFAULT_ORDER_GATE)).toEqual([]);
    expect(checkProposalSpec({ stop: '101', target: null }, '100', exec, DEFAULT_ORDER_GATE)).toEqual(['proposal_stop_side']);
  });
  it('B-arm decisions carry spec_violations only for runs frozen with spec_version; legacy replay hash unchanged', async () => {
    const d = fixture(), base = { ...params(), arms: ['b_agent' as const], repeats: 1 };
    const tight = async (v: import('../../../src/demo/research/engine.js').DecisionView) => v.position ? { action: 'hold' as const, reason: 'hold', gate_errors: [], evidence_refs: [] } : { action: 'enter' as const, reason: 'tight', gate_errors: [], evidence_refs: [], entry: { candidate_id: `agent_${v.at}`, stop: (Number(v.bars.at(-1)!.close) * 0.995).toFixed(8), target: null, reason: 'tight' } };
    const legacy = await runReplay(d, base, tight), stamped = await runReplay(d, { ...base, spec_version: STRATEGY_SPEC_VERSION }, tight);
    expect(legacy.arms[0]!.decisions.every((x) => x.spec_violations === undefined)).toBe(true);
    const flagged = stamped.arms[0]!.decisions.filter((x) => x.spec_violations?.length);
    expect(flagged.length).toBeGreaterThan(0); expect(flagged[0]!.spec_violations).toContain('proposal_stop_below_cost_floor');
    const strip = (r: typeof legacy) => hash(r.arms.map((a) => a.decisions.map(({ spec_violations: _s, ...rest }) => rest)));
    expect(strip(legacy)).toBe(strip(stamped));
  });
});
