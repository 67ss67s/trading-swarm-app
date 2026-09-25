import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoopRevisionCommand, ResearchRequest, StrategyIR } from '@trading-swarm/contracts';
import { openStateDb } from '../../../../src/state-db.js';
import { LoopStore, DEFAULT_BUDGET } from '../../../../src/demo/research/loop/store.js';
import { ResearchStore } from '../../../../src/demo/research/store.js';
import { ResearchService } from '../../../../src/demo/research/service.js';
import { LoopService } from '../../../../src/demo/research/loop/service.js';
import { BacktestBridge } from '../../../../src/demo/research/loop/backtest.js';
import { Budget } from '../../../../src/demo/research/loop/budget.js';
import { commandPlan, prepareRevision, runRevision, compareRuns, revisionContext, buildReport } from '../../../../src/demo/research/loop/revisions.js';
import { executePlan } from '../../../../src/demo/research/loop/executor.js';
import { createToolRegistry, failure, result, type ToolContext } from '../../../../src/demo/research/loop/tools.js';
import { compileConstraints, policyToIR, resolveRequest } from '../../../../src/demo/research/strategy.js';
import { hash } from '../../../../src/demo/research/primitives.js';
import type { RunResult } from '../../../../src/demo/research/engine.js';
import { fixture, params, study as fixtureStudy } from '../fixtures.js';
import { fakeMarket, fakeAnalyses } from './fixtures.js';
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach((fn) => fn()); vi.restoreAllMocks(); });
const identity = { kind: 'stub' as const, model: null, name: 'test-rules', configuration_hash: 'test' };
function modernIR(): StrategyIR { const ir = policyToIR(params().policy!); delete ir.compatibility; ir.exit.push({ primitive: 'chandelier_trail', params: { atr_period: 5, multiple: 2 } }); return ir; }
const savedResult = { status: 'completed', arms: [{ arm: 'a_rules', metrics: { net_return: 0.1, max_drawdown: 0.04, closed_trades: 35, fees: '10' } }] } as unknown as RunResult;
function setup(options: { maxTrials?: number; legacyPolicy?: boolean; mode?: LoopRevisionCommand['mode']; candidates?: number; dataset?: ReturnType<typeof fixture>; parentExecution?: Partial<ResearchRequest['execution']> } = {}) {
  const handle = openStateDb(':memory:'); cleanup.push(() => handle.close());
  const store = new ResearchStore(handle.db), loop = new LoopStore(handle.db), service = new ResearchService(store), bridge = new BacktestBridge(store, service);
  const dataset = options.dataset ?? fixture(), id = store.putDataset(dataset).id, study = store.putStudy({ ...fixtureStudy(id), max_trials: options.maxTrials ?? 5 });
  const raw = { ...params(id), arms: ['a_rules'], repeats: 1, max_model_calls: 0, acknowledge_adaptive_search: false } as ResearchRequest;
  if (options.parentExecution) raw.execution = { ...raw.execution, ...options.parentExecution };
  if (!options.legacyPolicy) { raw.strategy_ir = modernIR(); delete raw.policy; }
  const parent = store.create(raw, null, identity, ''); store.status(parent.id, 'completed', savedResult);
  const session = loop.createSession(), command: LoopRevisionCommand = { mode: options.mode ?? 'revise', baseline_run_id: parent.id, instruction: '调整突破阈值', max_candidates: options.candidates ?? 1 };
  const inquiry = loop.createInquiry(session.id, command.instruction, 'revision-inquiry').inquiry, plan = commandPlan(command, bridge); loop.updateInquiry(inquiry.id, { plan, status: 'planning' }); loop.updateInquiry(inquiry.id, { status: 'running' });
  const ctx: ToolContext = { inquiry_id: inquiry.id, step_id: `${inquiry.id}:test`, store: loop, backtests: bridge, budget: new Budget({ ...DEFAULT_BUDGET, max_backtests: 2, max_model_calls: 20, wall_clock_ms: 120_000 }), signal: new AbortController().signal, now: Date.now, market: fakeMarket(), analyses: fakeAnalyses };
  return { handle, store, loop, service, bridge, parent: store.get(parent.id)!, study, dataset, session, command, inquiry, ctx, plan };
}
function candidate() { const ir = modernIR(); ir.risk.stop.params.multiple = 2.5; return ir; }
function model(ir: StrategyIR) { return { name: 'fixture-brain', complete: vi.fn(async () => ({ text: JSON.stringify({ ir, unmapped: [] }), model: 'fixture', latency_ms: 0, input_tokens: 0, output_tokens: 0 })) }; }
function seedDraft(env: ReturnType<typeof setup>, ir = candidate(), extra: Record<string, unknown> = {}) {
  return env.loop.putArtifact({ inquiry_id: env.inquiry.id, kind: 'table', title: 'candidate', caption: 'test fixture', question: env.command.instruction, snapshot_refs: [], data_kind: 'derived', availability: 'available', spec: { type: 'table' }, content: { view: 'strategy_draft', ir, execution: env.parent.manifest.request.execution, baseline_run_id: env.parent.id, baseline_hash: env.parent.manifest.hash, command_hash: hash(env.command), valid: true, candidate_index: 1, ...extra } });
}
function runInput(env: ReturnType<typeof setup>, draft: ReturnType<typeof seedDraft>) { return { baseline_run_id: env.parent.id, draft_artifact_id: draft.id }; }
function studyCount(env: ReturnType<typeof setup>) { return (env.handle.db.prepare('SELECT COUNT(*) AS n FROM research_studies').get() as { n: number }).n; }
function anotherRun(env: ReturnType<typeof setup>, suffix: string, overrides: Partial<ResearchRequest> = {}, status = 'completed') { const raw = { ...env.parent.manifest.request, idempotency_key: suffix, parent_run_id: env.parent.id, acknowledge_adaptive_search: true, ...overrides }; const row = env.store.create(Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined)), null, identity, ''); env.store.status(row.id, status, status === 'completed' ? savedResult : null); return env.store.get(row.id)!; }

describe('study discipline and frozen requests', () => {
  it('keeps legacy max_trials=1 immutable without cloning a study or starting a run', async () => {
    const e = setup({ maxTrials: 1 }), start = vi.spyOn(e.service, 'start'), before = e.store.study(e.study.id);
    expect(await runRevision(runInput(e, seedDraft(e)), e.ctx)).toMatchObject({ status: 'error', error_code: 'BUDGET_EXHAUSTED' });
    expect(start).not.toHaveBeenCalled(); expect(e.store.studyRuns(e.study.id)).toHaveLength(1); expect(e.store.study(e.study.id)).toEqual(before); expect(studyCount(e)).toBe(1); expect(revisionContext(e.bridge, e.parent.id).remaining_candidates).toBe(0);
  });
  it('still saves a draft when legacy trial credit is exhausted', async () => {
    const e = setup({ maxTrials: 1 }); e.ctx.brain = model(candidate());
    const r = await prepareRevision({ baseline_run_id: e.parent.id, instruction: e.command.instruction, candidate_index: 1 }, e.ctx);
    expect(r.status).toBe('ok'); expect(r.artifact_refs).toHaveLength(1); expect(e.store.studyRuns(e.study.id)).toHaveLength(1); expect(studyCount(e)).toBe(1);
  });
  it('blocks a sealed study even when its holdout run failed', async () => {
    const e = setup(), draft = seedDraft(e); anotherRun(e, 'holdout', { purpose: 'holdout', from_ms: e.study.holdout_from_ms, to_ms: e.study.to_ms, parent_run_id: undefined }, 'failed');
    await expect(runRevision(runInput(e, draft), e.ctx)).rejects.toThrow('study_sealed'); expect(e.store.studyRuns(e.study.id)).toHaveLength(2);
  });
  it('rejects a validation run as revision parent', async () => {
    const e = setup(), validation = anotherRun(e, 'validation', { purpose: 'validation', from_ms: e.study.validation_from_ms, to_ms: e.study.validation_to_ms });
    e.loop.updateInquiry(e.inquiry.id, { plan: { ...e.plan, command: { ...e.command, baseline_run_id: validation.id } } });
    await expect(prepareRevision({ baseline_run_id: validation.id, instruction: e.command.instruction, candidate_index: 1 }, e.ctx)).rejects.toThrow('development_parent_required');
  });
  it('counts failed development trials toward the persistent development cap of three', async () => {
    const e = setup(); anotherRun(e, 'failed-1', {}, 'failed'); anotherRun(e, 'cancelled-2', {}, 'cancelled');
    const reopened = new BacktestBridge(new ResearchStore(e.handle.db), e.service);
    expect(revisionContext(reopened, e.parent.id).remaining_candidates).toBe(0);
    expect((await runRevision(runInput(e, seedDraft(e)), { ...e.ctx, backtests: reopened })).error_code).toBe('BUDGET_EXHAUSTED'); expect(e.store.studyRuns(e.study.id)).toHaveLength(3); expect(e.study.max_trials).toBe(5);
  });
  it('uses ordinary store validation and reuses persisted run identity after trial exhaustion', async () => {
    const e = setup(), draft = seedDraft(e), start = vi.spyOn(e.service, 'start');
    const first = await runRevision(runInput(e, draft), e.ctx); expect(first.status).toBe('ok'); const id = (first.output as { run_id: string }).run_id;
    anotherRun(e, 'consume-last-development', {}, 'failed');
    expect(((await runRevision(runInput(e, draft), e.ctx)).output as { run_id: string }).run_id).toBe(id); expect(start).toHaveBeenCalledTimes(1);
    expect(e.store.get(id)!.manifest.request).toMatchObject({ study_id: e.study.id, parent_run_id: e.parent.id, purpose: 'development', acknowledge_adaptive_search: true, from_ms: e.study.from_ms, to_ms: e.study.development_to_ms, dataset_id: e.parent.manifest.request.dataset_id, execution: e.parent.manifest.request.execution }); expect(e.store.studyRuns(e.study.id)).toHaveLength(3);
  });
  it('rejects drafts bound to another command or baseline', async () => {
    const e = setup();
    await expect(runRevision(runInput(e, seedDraft(e, candidate(), { command_hash: 'wrong' })), e.ctx)).rejects.toThrow('draft_identity_mismatch');
    await expect(runRevision(runInput(e, seedDraft(e, candidate(), { baseline_hash: 'wrong' })), e.ctx)).rejects.toThrow('draft_identity_mismatch'); expect(e.store.studyRuns(e.study.id)).toHaveLength(1);
  });
});

describe('purge, warmup and model information boundary', () => {
  it('rejects holding beyond registered purge without moving study boundaries', async () => {
    const e = setup(), ir = candidate(); ir.exit.find((n) => n.primitive === 'time_stop')!.params.bars = 13;
    await expect(runRevision(runInput(e, seedDraft(e, ir)), e.ctx)).rejects.toThrow('holding_exceeds_preregistered_purge'); expect(e.store.study(e.study.id)).toEqual(e.study); expect(e.store.studyRuns(e.study.id)).toHaveLength(1);
  });
  it('rejects deleting the finite holding horizon', async () => {
    const e = setup(), ir = candidate(); ir.exit = ir.exit.filter((n) => n.primitive !== 'time_stop');
    await expect(runRevision(runInput(e, seedDraft(e, ir)), e.ctx)).rejects.toThrow('holding_exceeds_preregistered_purge');
  });
  it('does not let a legacy policy mask removal of the candidate time stop', async () => {
    const e = setup({ legacyPolicy: true }), ir = candidate(); ir.exit = ir.exit.filter((n) => n.primitive !== 'time_stop');
    await expect(runRevision(runInput(e, seedDraft(e, ir)), e.ctx)).rejects.toThrow('holding_exceeds_preregistered_purge'); expect(e.store.studyRuns(e.study.id)).toHaveLength(1);
  });
  it('rejects longer lookback instead of moving the frozen development start', async () => {
    const e = setup(), ir = candidate(); ir.signal[0]!.params.lookback = 100;
    await expect(runRevision(runInput(e, seedDraft(e, ir)), e.ctx)).rejects.toThrow('revision_warmup_insufficient'); expect(e.store.study(e.study.id)).toEqual(e.study);
  });
  it('keeps model prompts identical when only validation and holdout price ranges change', async () => {
    const first = setup(), data = fixture(); data.bars = data.bars.map((b, i) => i > 180 ? { ...b, high: '999999', low: '0.01' } : b);
    const second = setup({ dataset: data }), brainA = model(candidate()), brainB = model(candidate()); first.ctx.brain = brainA; second.ctx.brain = brainB;
    await prepareRevision({ baseline_run_id: first.parent.id, instruction: first.command.instruction, candidate_index: 1 }, first.ctx);
    await prepareRevision({ baseline_run_id: second.parent.id, instruction: second.command.instruction, candidate_index: 1 }, second.ctx);
    expect(brainA.complete).toHaveBeenCalledTimes(1); expect(brainB.complete.mock.calls).toEqual(brainA.complete.mock.calls); expect(compileConstraints('1h', first.dataset).atr_pct_median).not.toBe(compileConstraints('1h', second.dataset).atr_pct_median);
  });
});

describe('comparisons and proposal validation', () => {
  it('compares frozen results without running replay, attribution, or another experiment', () => {
    const e = setup(), child = anotherRun(e, 'child'), start = vi.spyOn(e.service, 'start'), attribution = vi.spyOn(e.service, 'attribution'), before = e.store.studyRuns(e.study.id);
    const r = compareRuns({ baseline_run_id: e.parent.id, candidate_run_id: child.id }, e.ctx);
    expect(r.output).toMatchObject({ comparable: true }); expect(start).not.toHaveBeenCalled(); expect(attribution).not.toHaveBeenCalled(); expect(e.store.studyRuns(e.study.id)).toEqual(before); expect(e.loop.artifact(r.artifact_refs[0]!).content).toMatchObject({ adopted: false });
  });
  it('marks changed costs noncomparable and refuses incomplete runs', () => {
    const e = setup(), changed = anotherRun(e, 'cost-change', { execution: { ...e.parent.manifest.request.execution, fee_rate: '0.002' } });
    expect(compareRuns({ baseline_run_id: e.parent.id, candidate_run_id: changed.id }, e.ctx).output).toMatchObject({ comparable: false });
    const failed = anotherRun(e, 'failed-child', {}, 'failed'); expect(() => compareRuns({ baseline_run_id: e.parent.id, candidate_run_id: failed.id }, e.ctx)).toThrow('run_incomplete');
  });
  it('blocks strategy-spec violations even when structural IR checks pass', async () => {
    const e = setup(), ir = candidate(); ir.risk.stop.params.multiple = 0.3; e.ctx.brain = model(ir); // 规范 v2:ATR 止损低于「止损太近不做」的 0.5 倍 = block
    const r = await prepareRevision({ baseline_run_id: e.parent.id, instruction: e.command.instruction, candidate_index: 1 }, e.ctx);
    expect(r.status).toBe('error'); expect(e.loop.artifact(r.artifact_refs[0]!).content).toMatchObject({ valid: false }); expect(e.store.studyRuns(e.study.id)).toHaveLength(1);
  });
  it('rejects proposals changing more than two economic parameters', async () => {
    const e = setup({ mode: 'optimize' }), ir = candidate(); ir.signal[0]!.params.lookback = 7; ir.signal[1]!.params.multiple = 1.2; e.ctx.brain = model(ir);
    const r = await prepareRevision({ baseline_run_id: e.parent.id, instruction: e.command.instruction, candidate_index: 1 }, e.ctx);
    expect(r.status).toBe('error'); expect(e.loop.artifact(r.artifact_refs[0]!).content).toMatchObject({ valid: false });
  });
});

describe('bounded command lifecycle', () => {
  it('runs candidate two after candidate one fails and reports both outcomes', async () => {
    const e = setup({ mode: 'optimize', candidates: 2 }), registry = createToolRegistry(), realCall = registry.call.bind(registry), order: string[] = [];
    vi.spyOn(registry, 'call').mockImplementation(async (name, input, ctx) => {
      if (name === 'revise_strategy') { const n = (input as { candidate_index: number }).candidate_index; order.push(`draft${n}`); return n === 1 ? failure('SCHEMA_MISMATCH', 'fixture-invalid-rule') : result({ draft_artifact_id: 'fixture-draft' }); }
      if (name === 'run_strategy_revision') { order.push('run2'); return result({ run_id: 'fixture-run', status: 'completed' }); }
      if (name === 'compare_strategy_runs') { order.push('compare2'); return result({ comparable: true }); }
      return realCall(name, input, ctx);
    });
    await executePlan(e.plan, registry, e.ctx, () => {});
    expect(order).toEqual(['draft1', 'draft2', 'run2', 'compare2']);
    expect(e.loop.steps(e.inquiry.id).map((s) => [s.tool, s.status])).toEqual([['revise_strategy', 'failed'], ['run_strategy_revision', 'skipped'], ['compare_strategy_runs', 'skipped'], ['revise_strategy', 'succeeded'], ['run_strategy_revision', 'succeeded'], ['compare_strategy_runs', 'succeeded'], ['build_research_report', 'succeeded'], ['compose_answer', 'succeeded']]);
    const report = e.loop.artifacts(e.session.id).find((a) => (a.content as any).view === 'research_report'); expect(report?.availability).toBe('partial');
    expect((report?.content as any).steps).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'failed' }), expect.objectContaining({ status: 'succeeded' })])); expect(e.loop.inquiry(e.inquiry.id).status).toBe('incomplete');
  });
  it('enforces command limits before creating an inquiry', () => {
    const e = setup(); e.loop.updateInquiry(e.inquiry.id, { status: 'validating' }); e.loop.updateInquiry(e.inquiry.id, { status: 'completed' }); const svc = new LoopService(e.loop, { market: fakeMarket(), analyses: fakeAnalyses, backtests: e.bridge });
    expect(() => svc.command(e.session.id, { ...e.command, mode: 'optimize', max_candidates: 3 }, 'too-many')).toThrow();
    expect(() => svc.command(e.session.id, { ...e.command, mode: 'revise', max_candidates: 2 }, 'wrong-mode')).toThrow('invalid_candidate_limit');
    expect(() => svc.command(e.session.id, { ...e.command, execution_overrides: { fee_rate: '0' } }, 'cost-injection')).toThrow('invalid_execution_override'); expect(e.loop.inquiries(e.session.id)).toHaveLength(1);
  });
  it('retries the same command as the same inquiry and rejects changed command payloads', async () => {
    const e = setup({ mode: 'rerun' }); e.loop.updateInquiry(e.inquiry.id, { status: 'validating' }); e.loop.updateInquiry(e.inquiry.id, { status: 'completed' }); const svc = new LoopService(e.loop, { market: fakeMarket(), analyses: fakeAnalyses, backtests: e.bridge });
    const first = svc.command(e.session.id, e.command, 'command-key'); expect(svc.command(e.session.id, e.command, 'command-key').inquiry.id).toBe(first.inquiry.id);
    expect(() => svc.command(e.session.id, { ...e.command, instruction: 'different' }, 'command-key')).toThrow('idempotency_conflict'); await svc.wait(first.inquiry.id); expect(e.store.studyRuns(e.study.id).length).toBeLessThanOrEqual(2);
  });
});


describe('retry and failure recovery edge cases', () => {
  it('allows a persisted candidate retry as a read after the study is later sealed', async () => {
    const e = setup(), draft = seedDraft(e);
    const first = await runRevision(runInput(e, draft), e.ctx);
    expect(first.status).toBe('ok');
    anotherRun(e, 'later-holdout', { purpose: 'holdout', from_ms: e.study.holdout_from_ms, to_ms: e.study.to_ms, parent_run_id: undefined }, 'failed');
    const retry = await runRevision(runInput(e, draft), e.ctx);
    expect(retry.output).toEqual(first.output); expect(e.store.studyRuns(e.study.id)).toHaveLength(3);
  });
  it('does not classify an ordinary failed run as exhausted optimization budget', async () => {
    const e = setup(), failed = anotherRun(e, 'engine-failure', {}, 'failed');
    const r = await e.bridge.waitForRun(failed.id, e.ctx);
    expect(r.status).toBe('error'); expect(r.error_code).not.toBe('BUDGET_EXHAUSTED');
  });
});

describe('command delivery and admission races', () => {
  it('does not exceed the persistent development cap if another trial arrives during precheck', async () => {
    const e = setup(); anotherRun(e, 'earlier-candidate', {}, 'failed'); const draft = seedDraft(e);
    e.ctx.progress = (summary) => { if (summary.precheck) anotherRun(e, 'interleaved-final-candidate', {}, 'failed'); };
    const r = await runRevision(runInput(e, draft), e.ctx);
    expect(r.error_code).toBe('BUDGET_EXHAUSTED'); expect(e.store.studyRuns(e.study.id)).toHaveLength(3);
  });
  it('keeps accepted commands running even when the event sink throws', async () => {
    const e = setup({ mode: 'rerun' }); e.loop.updateInquiry(e.inquiry.id, { status: 'validating' }); e.loop.updateInquiry(e.inquiry.id, { status: 'completed' });
    const svc = new LoopService(e.loop, { market: fakeMarket(), analyses: fakeAnalyses, backtests: e.bridge, emit: () => { throw Error('client disconnected'); } });
    let accepted: ReturnType<typeof svc.command> | undefined;
    expect(() => { accepted = svc.command(e.session.id, e.command, 'sink-failure'); }).not.toThrow();
    await svc.wait(accepted!.inquiry.id);
    expect(['completed', 'incomplete', 'failed']).toContain(e.loop.inquiry(accepted!.inquiry.id).status);
  });
});

describe('explicit revision scope and optimization proposals', () => {
  it('allows an explicit revise request to change several parameters', async () => {
    const e = setup({ mode: 'revise' }), ir = candidate(); ir.signal[0]!.params.lookback = 7; ir.signal[1]!.params.multiple = 1.2; e.ctx.brain = model(ir);
    const r = await prepareRevision({ baseline_run_id: e.parent.id, instruction: e.command.instruction, candidate_index: 1 }, e.ctx);
    expect(r.status).toBe('ok'); expect(e.loop.artifact(r.artifact_refs[0]!).content).toMatchObject({ valid: true });
  });
  it('allows two optimization parameter changes inside the same signal array', async () => {
    const e = setup({ mode: 'optimize' }), ir = modernIR(); ir.signal[0]!.params.lookback = 7; ir.signal[1]!.params.multiple = 1.2; e.ctx.brain = model(ir);
    const r = await prepareRevision({ baseline_run_id: e.parent.id, instruction: e.command.instruction, candidate_index: 1 }, e.ctx);
    expect(r.status).toBe('ok'); expect((e.loop.artifact(r.artifact_refs[0]!).content as any).changes).toHaveLength(2);
  });
  it('keeps a duplicate second candidate as an invalid draft without starting another trial', async () => {
    const e = setup({ mode: 'optimize', candidates: 2 }); e.ctx.brain = model(candidate());
    const first = await prepareRevision({ baseline_run_id: e.parent.id, instruction: e.command.instruction, candidate_index: 1 }, e.ctx);
    const second = await prepareRevision({ baseline_run_id: e.parent.id, instruction: e.command.instruction, candidate_index: 2 }, e.ctx);
    expect(first.status).toBe('ok'); expect(second.status).toBe('error'); expect(e.loop.artifact(second.artifact_refs[0]!).content).toMatchObject({ valid: false }); expect(e.store.studyRuns(e.study.id)).toHaveLength(1);
  });
});


it('preserves legacy policy sizing when rerunning under frozen execution settings', async () => {
  const e = setup({ mode: 'rerun', legacyPolicy: true, parentExecution: { risk_fraction: '0.02', max_allocation: '0.4' } });
  const r = await prepareRevision({ baseline_run_id: e.parent.id, instruction: e.command.instruction, candidate_index: 1 }, e.ctx);
  expect(r.status).toBe('ok');
  const draft = e.loop.artifact(r.artifact_refs[0]!).content as any;
  expect(draft.ir.risk.sizing.params).toMatchObject({ fraction: '0.02', max_allocation: '0.4' });
});


it('applies rerun sizing overrides to effective engine execution, not only manifest labels', async () => {
  const e = setup({ mode: 'rerun' }); e.command.execution_overrides = { risk_fraction: '0.02', max_allocation: '0.4' };
  e.loop.updateInquiry(e.inquiry.id, { plan: { ...e.plan, command: e.command } });
  const r = await prepareRevision({ baseline_run_id: e.parent.id, instruction: e.command.instruction, candidate_index: 1 }, e.ctx);
  expect(r.status).toBe('ok'); const draft = e.loop.artifact(r.artifact_refs[0]!).content as any;
  const effective = resolveRequest({ ...e.parent.manifest.request, strategy_ir: draft.ir, execution: draft.execution });
  expect(effective.execution).toMatchObject({ risk_fraction: '0.02', max_allocation: '0.4' });
});

it('completes a two-candidate optimization with real runs, immutable parent and two persisted comparisons', async () => {
  const e = setup({ mode: 'optimize', candidates: 2 });
  e.loop.updateInquiry(e.inquiry.id, { status: 'validating' }); e.loop.updateInquiry(e.inquiry.id, { status: 'completed' });
  const before = e.store.get(e.parent.id), brain = { name: 'two-candidate-fixture', complete: vi.fn(async (system: string, user: string) => {
    const ir = candidate(); if (user.includes('候选编号 2')) ir.risk.stop.params.multiple = 3;
    return { text: JSON.stringify(system.includes('StrategyIR') ? { ir, unmapped: [] } : { blocks: [] }), model: 'fixture', latency_ms: 0, input_tokens: 0, output_tokens: 0 };
  }) };
  const svc = new LoopService(e.loop, { market: fakeMarket(), analyses: fakeAnalyses, backtests: e.bridge, brain });
  const response = svc.command(e.session.id, e.command, 'real-two-candidates'); await svc.wait(response.inquiry.id);
  const inquiry = svc.inquiry(response.inquiry.id);
  expect(inquiry.status, JSON.stringify(inquiry.steps.map((s) => [s.tool, s.status, s.output_summary.result]))).toBe('completed');
  expect(e.store.studyRuns(e.study.id)).toHaveLength(3); expect(e.store.get(e.parent.id)).toEqual(before);
  const outputs = e.loop.artifacts(e.session.id).filter((a) => a.inquiry_id === inquiry.id);
  expect(outputs.filter((a) => (a.content as any).view === 'run_comparison')).toHaveLength(2);
  expect(outputs.filter((a) => (a.content as any).view === 'research_report')).toHaveLength(1);
  expect(inquiry.steps.filter((s) => s.tool === 'run_strategy_revision').every((s) => s.status === 'succeeded')).toBe(true);
});


describe('independent final revision review regressions', () => {
  it('derives comparison trajectories only from each saved equity series', () => {
    const e = setup(), child = anotherRun(e, 'saved-equity-child');
    const cash = Number(e.parent.manifest.request.execution.initial_cash);
    const at = e.parent.manifest.request.from_ms;
    const withEquity = (equity: string) => ({ ...savedResult, arms: [{ ...savedResult.arms[0]!, equity: [{ at, equity }, { at: at + 1000, equity: String(cash) }] }] }) as unknown as RunResult;
    e.store.status(e.parent.id, 'completed', withEquity(String(cash * 1.1)));
    e.store.status(child.id, 'completed', withEquity(String(cash * 0.9)));
    const start = vi.spyOn(e.service, 'start'), attribution = vi.spyOn(e.service, 'attribution');
    const output = compareRuns({ baseline_run_id: e.parent.id, candidate_run_id: child.id }, e.ctx);
    const chart = output.artifact_refs.map((id) => e.loop.artifact(id)).find((a) => a.kind === 'chart')!;
    const series = (chart.content as any).series;
    expect(series).toHaveLength(2); expect(series[0].points[0][0]).toBe(at);
    expect(series[0].points[0][1]).toBeCloseTo(10); expect(series[1].points[0][1]).toBeCloseTo(-10);
    expect(series[0].points[1]).toEqual([at + 1000, 0]); expect(series[1].points[1]).toEqual([at + 1000, 0]);
    expect(start).not.toHaveBeenCalled(); expect(attribution).not.toHaveBeenCalled(); expect(e.store.studyRuns(e.study.id)).toHaveLength(2);
  });
  it('labels a report partial when wall-clock budget expires even without a failed ordinary step', () => {
    const e = setup(); let now = 0;
    e.ctx.budget = new Budget({ ...DEFAULT_BUDGET, wall_clock_ms: 1000 }, () => now);
    now = 1000;
    const output = buildReport({}, e.ctx), report = e.loop.artifact(output.artifact_refs[0]!);
    expect(output.status).toBe('ok'); expect(report.availability).toBe('partial');
    expect((report.content as any).stop_reason).toContain('预算已耗尽');
    expect((report.content as any).steps).toEqual([]);
  });
  it('includes prior saved candidate observations in candidate two without fabricating an outcome', async () => {
    const e = setup({ mode: 'optimize', candidates: 2 });
    const child = anotherRun(e, 'prior-observation');
    seedDraft(e);
    const compared = compareRuns({ baseline_run_id: e.parent.id, candidate_run_id: child.id }, e.ctx);
    const observation = (compared.output as { observation: string }).observation;
    const ir = candidate(); ir.risk.stop.params.multiple = 3;
    const brain = model(ir); e.ctx.brain = brain;
    const output = await prepareRevision({ baseline_run_id: e.parent.id, instruction: e.command.instruction, candidate_index: 2 }, e.ctx);
    expect(output.status).toBe('ok'); expect(JSON.stringify(brain.complete.mock.calls)).toContain(observation);
    expect(e.store.studyRuns(e.study.id)).toHaveLength(2);
  });
});
