/**
 * 改进环主体 runImprovement(job)(设计第四节,零模型)。每一代:
 *   1. 父策略训练段诊断(diagnoseRun,只看训练段);
 *   2. 各生成器产出候选 → 与本任务已试过的 IR 去重 → 零模型编译检查(checkIR + 不引入新的策略规范 block)→ 按生成器轮流取满 candidates_per_generation;
 *   3. 训练段一次连续回测(正常费率 + 2 倍费率)切 4 折 → 门槛淘汰 → 目标排序;
 *   4. 排名靠前的逐个做平台检验(周期整体 ±25% 两个邻域点,不参与选择、单独计数),通过的取前 promote_per_generation 个进验证段;
 *   5. 验证段夏普(年化日收益)严格高于当前冠军(起始为基线)验证段夏普的,取最好的一个成为冠军兼下一代父策略(promote);
 *   6. 多步搜索(budget.allow_explore,缺省开,2026-09-23 Jacky 认可):这一代没有 promote 时,训练目标严格高于父策略的最好候选
 *      (门槛没过也行)成为下一代父策略(explore),继续往下搜;它不进验证段、不能当冠军。冠军只能是「门槛全过(含平台)且验证段优于基线」的候选,
 *      没有就是基线。谱系里 promote 父策略标 parent,explore 父策略标 explore_parent,每代进度带 mode。试验数照常计入 Deflated Sharpe。
 *   停止:连续 patience 代(缺省 2)既没有 promote 也没有 explore,或代数 / 墙钟 / 模型调用预算用完。结束时冠军(可能就是基线)跑一次留出段,
 *   留出段由 improve_jobs.holdout_used_at 原子占用,同一任务第二次调用直接报错。
 * 账本:试验数 = 做过训练段评估的候选数(含基线,不含编译不过的与平台检验点);Deflated Sharpe 用冠军训练段日收益、
 *   全部候选训练段日夏普的方差与试验数折算;随机入场基线在训练段上以冠军的离场规则跑 20 次(固定种子)。PBO 第二阶段做,先留 null。
 * 产出:冠军不是基线且任务带 strategy_id 时,以新版本写入策略对象(StrategyService.addVersion,状态不推进)。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { StrategyIR } from '@trade-gate/contracts';
import { ResearchStore } from '../store.js';
import { hash } from '../primitives.js';
import { checkIR, compileConstraints } from '../strategy.js';
import { checkIRSpec } from '../strategy-spec.js';
import { orderGateFor } from '../order-gate.js';
import { DEFAULT_EXECUTION, type AssetExecutor, type BarsLoader } from '../backtest-report.js';
import { StrategyStore } from '../strategies/store.js';
import { StrategyService, irHash } from '../strategies/service.js';
import type { ResearchService } from '../service.js';
import { freezeData, frozenSummary } from './data.js';
import { EvalEnv, evaluateSegment, evaluateTrain, diagnoseRun, plateauGate, pct, runPool, scoreSegment, type PoolRun } from './evaluate.js';
import { randomEntryBaseline } from './random-entry.js';
import { dailyReturns, deflatedSharpe, expectedMaxSharpe, moments, periodSharpe, variance } from './stats.js';
import { getGenerator, loadOptionalGenerator } from './generators/index.js';
import { plateauNeighbors } from './generators/neighborhood.js';
import { ImproveStore, type CandidateStatus, type GenerationProgress, type ImproveProgress, type ImproveResult, type ImproveSpec, type JobRow } from './store.js';
import type { Candidate, Evaluation, GeneratorContext, GeneratorName, OverfitLedger, SegmentScore } from './types.js';

export const IMPROVE_EVENT = 'research.improve';
export const RUNNER_VERSION = 'improve-runner/v1';
export interface ImproveEvent { job_id: string; phase: string; generation: number; message: string; trials: number; status?: string; candidate?: { id: string; generator: GeneratorName; objective: number | null; passed: boolean; status: CandidateStatus } }
export interface RunnerDeps {
  db: DatabaseSync;
  /** 测试注入合成行情;缺省 OKX(先复用已存数据集) */
  loader?: BarsLoader;
  emit?: (e: ImproveEvent) => void;
  signal?: AbortSignal;
  /** 测试可替换单资产执行器;缺省 order 块 → 订单执行核,否则 engine v4 */
  executorFor?: (ir: StrategyIR) => AssetExecutor;
  /** 冠军写版本;缺省 StrategyService.addVersion(同一 DB 连接) */
  writeVersion?: (strategy_id: string, ir: StrategyIR, note: string) => number | null;
  now?: () => number;
}

/** 零模型编译检查:checkIR 全过,且不引入基线没有的策略规范 block。 */
export function compileCheck(ir: StrategyIR, timeframe: string, baselineBlocks: Set<string> = new Set()): { ok: boolean; reason?: string; blocks: string[] } {
  const c = checkIR(ir, timeframe);
  if (!c.ok || !c.ir) return { ok: false, reason: c.checks.filter((x) => !x.ok).map((x) => x.name).join(',') || 'invalid', blocks: [] };
  const spec = checkIRSpec(c.ir, compileConstraints(timeframe, null, DEFAULT_EXECUTION, orderGateFor(c.ir), c.ir));
  const blocks = spec.violations.filter((v) => v.severity === 'block').map((v) => v.code), fresh = blocks.filter((b) => !baselineBlocks.has(b));
  return fresh.length ? { ok: false, reason: 'spec_block:' + fresh.join(','), blocks } : { ok: true, blocks };
}

function defaultWriteVersion(db: DatabaseSync): NonNullable<RunnerDeps['writeVersion']> {
  return (strategy_id, ir, note) => {
    const svc = new StrategyService(new StrategyStore(db), new ResearchStore(db), null as unknown as ResearchService);
    const detail = svc.addVersion(strategy_id, { strategy_ir: ir, note });
    return detail.versions.find((v) => v.ir_hash === irHash(ir))?.version ?? null;
  };
}

export async function runImprovement(deps: RunnerDeps, job_id: string): Promise<JobRow> {
  const jobs = new ImproveStore(deps.db, deps.now), research = new ResearchStore(deps.db), job = jobs.require(job_id), spec = job.spec;
  const now = deps.now ?? Date.now, started = now();
  const check = () => { if (deps.signal?.aborted) throw Error('CANCELLED'); };
  const progress: ImproveProgress = { phase: 'data', message: '冻结数据', generation: 0, generations: [], trials: 0, single_runs: 0, started_at: started, elapsed_ms: 0, stop_reason: null, notes: [] };
  const emit = (phase: string, message: string, candidate?: ImproveEvent['candidate'], status?: string) => {
    progress.phase = phase; progress.message = message; progress.elapsed_ms = now() - started;
    jobs.update(job_id, { progress });
    deps.emit?.({ job_id, phase, generation: progress.generation, message, trials: progress.trials, ...(candidate ? { candidate } : {}), ...(status ? { status } : {}) });
  };
  jobs.update(job_id, { status: 'running' });
  emit('data', `冻结数据:${spec.universe.join('/')} ${spec.timeframe}`, undefined, 'running');
  try {
    // ---- 1) 冻结数据与切段
    const market = spec.strategy_ir.order?.market === 'perp' ? 'perp' as const : 'spot' as const;
    const frozen = await freezeData(research, { universe: spec.universe, timeframe: spec.timeframe, from_ms: spec.from_ms, to_ms: spec.to_ms, market, ...(spec.dataset_ids ? { dataset_ids: spec.dataset_ids } : {}) }, { ...(deps.loader ? { loader: deps.loader } : {}), ...(deps.signal ? { signal: deps.signal } : {}), progress: (m) => emit('data', m) });
    progress.notes.push(...frozen.notes);
    jobs.update(job_id, { frozen: frozenSummary(frozen.data, frozen.dataset_ids) });
    const data = frozen.data, env = new EvalEnv(data, check, deps.executorFor);
    const overBudget = () => now() - started > spec.budget.wall_clock_ms;
    const baseCheck = compileCheck(spec.strategy_ir, spec.timeframe);
    const firstCheck = checkIR(spec.strategy_ir, spec.timeframe);
    if (!firstCheck.ok) throw Error('SCHEMA_MISMATCH:strategy_ir_checks_failed:' + firstCheck.checks.filter((c) => !c.ok).map((c) => c.name).join(','));
    const baselineBlocks = new Set(baseCheck.blocks);
    if (baselineBlocks.size) progress.notes.push(`基线本身有策略规范 block(${[...baselineBlocks].join(',')}),候选只要求不新增 block`);
    const check0 = (ir: StrategyIR) => compileCheck(ir, spec.timeframe, baselineBlocks);

    // ---- 2) 生成器
    const generators = [] as NonNullable<ReturnType<typeof getGenerator>>[];
    for (const name of spec.generators) {
      if (name === 'model' && spec.budget.model_calls <= 0) { progress.notes.push('模型提议生成器预算为 0,未启用'); continue; }
      const g = getGenerator(name) ?? (await loadOptionalGenerator(name));
      if (g) generators.push(g); else progress.notes.push(`生成器 ${name} 未注册,跳过`);
    }

    // ---- 3) 基线
    const evals = new Map<string, Evaluation>(), runs = new Map<string, PoolRun>(), cands = new Map<string, Candidate>();
    const seen = new Set<string>();
    const evaluateCandidate = async (c: Candidate): Promise<Evaluation> => {
      const t = await evaluateTrain(env, c.ir, hash(c.ir), spec.objective);
      const ev: Evaluation = { candidate_id: c.id, folds: t.folds, train: t.train, objective: t.objective, gates: t.gates, passed: t.gates.every((g) => g.ok) };
      evals.set(c.id, ev); runs.set(c.id, t.run); progress.trials++; progress.single_runs = env.runs;
      return ev;
    };
    const baseline: Candidate = { id: 'g0_base', parent_id: null, generation: 0, generator: 'baseline', ir: spec.strategy_ir, diff: [], rationale: '基线:任务给定的原策略' };
    seen.add(hash(baseline.ir)); cands.set(baseline.id, baseline);
    jobs.putCandidate(job_id, baseline, hash(baseline.ir), 'evaluated');
    emit('baseline', '基线训练段评估');
    const baseEval = await evaluateCandidate(baseline);
    baseEval.validation = await evaluateSegment(env, baseline.ir, hash(baseline.ir), 'validation');
    jobs.updateCandidate(job_id, baseline.id, { status: 'parent', evaluation: baseEval });
    emit('baseline', `基线:训练目标 ${fmt(baseEval.objective)},门槛${baseEval.passed ? '全过' : '未全过'},验证夏普 ${fmt(baseEval.validation.sharpe)}`, { id: baseline.id, generator: 'baseline', objective: baseEval.objective, passed: baseEval.passed, status: 'parent' });

    // ---- 4) 逐代
    // parent = 搜索前沿(下一代从它出发);champion = 门槛全过且验证段优于基线的最好候选(起始为基线)。不开 explore 时二者始终相同。
    let parent = baseline, champion = baseline, stale = 0, plateauChecks = 0, stop: string | null = null;
    const allowExplore = spec.budget.allow_explore ?? true;
    for (let gen = 1; gen <= spec.budget.generations; gen++) {
      check();
      if (overBudget()) { stop = 'budget_wall_clock'; break; }
      progress.generation = gen;
      const pEval = evals.get(parent.id)!, pRun = runs.get(parent.id)!;
      const diagnosis = diagnoseRun(pRun, data, parent.ir).map((f) => ({ key: f.key, severity: f.severity, text: f.text }));
      emit('generate', `第 ${gen} 代:父策略 ${parent.id} 诊断 ${diagnosis.filter((d) => d.severity !== 'info').map((d) => d.key).join('/') || '无高/中级问题'}`);
      const ctx: GeneratorContext = {
        parent, evaluation: pEval, diagnosis, data, budget: spec.budget.candidates_per_generation, ...(deps.signal ? { signal: deps.signal } : {}),
        check: (ir) => { const r = check0(ir); return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? 'invalid' }; },
        quickScore: async (ir, w) => { const t = data.segments.train; if (w.from_ms < t.from_ms || w.to_ms > t.to_ms) throw Error('improve_quick_score_outside_train'); return scoreSegment('quick', await runPool(env, ir, hash(ir), w), w); },
      };
      // 各生成器全部产出 → 去重 → 按生成器轮流取满预算
      const lanes: Omit<Candidate, 'id' | 'parent_id' | 'generation'>[][] = [];
      for (const g of generators) {
        let out: Omit<Candidate, 'id' | 'parent_id' | 'generation'>[] = [];
        try { out = await g.generate(ctx); } catch (e) { progress.notes.push(`第 ${gen} 代生成器 ${g.name} 失败:${String(e instanceof Error ? e.message : e).slice(0, 200)}`); }
        lanes.push(out.filter((c) => { const h = hash(c.ir); if (seen.has(h)) return false; seen.add(h); return true; }));
      }
      const picked: Omit<Candidate, 'id' | 'parent_id' | 'generation'>[] = [];
      for (let k = 0; picked.length < spec.budget.candidates_per_generation && lanes.some((l) => l.length > k); k++) for (const l of lanes) if (l[k] && picked.length < spec.budget.candidates_per_generation) picked.push(l[k]!);
      // 没被选中的放回「未试过」:下一代换了父策略可能还会产出同样的 IR
      const pickedHashes = new Set(picked.map((c) => hash(c.ir)));
      for (const l of lanes) for (const c of l) if (!pickedHashes.has(hash(c.ir))) seen.delete(hash(c.ir));
      const gp: GenerationProgress = { generation: gen, parent_id: parent.id, candidates: picked.length, evaluated: 0, passed: 0, promoted: [], improved: false, best_candidate_id: null, best_objective: null, note: '', mode: null, champion_id: champion.id };
      progress.generations.push(gp);
      const children: Candidate[] = [];
      for (const [k, raw] of picked.entries()) {
        check();
        if (overBudget()) { stop = 'budget_wall_clock'; break; }
        const c: Candidate = { ...raw, id: `g${gen}_c${k + 1}`, parent_id: parent.id, generation: gen };
        const h = hash(c.ir), ok = check0(c.ir);
        if (!ok.ok) { jobs.putCandidate(job_id, { ...c, rationale: `${c.rationale}(编译检查不过:${ok.reason})` }, h, 'rejected'); continue; }
        cands.set(c.id, c); jobs.putCandidate(job_id, c, h, 'evaluated');
        const ev = await evaluateCandidate(c);
        gp.evaluated++; if (ev.passed) gp.passed++;
        jobs.updateCandidate(job_id, c.id, { status: ev.passed ? 'evaluated' : 'gated_out', evaluation: ev });
        children.push(c);
        emit('evaluate', `第 ${gen} 代 ${c.id}(${c.generator}):目标 ${fmt(ev.objective)},${ev.passed ? '门槛全过' : '淘汰:' + ev.gates.filter((g) => !g.ok).map((g) => g.name).join('/')}`, { id: c.id, generator: c.generator, objective: ev.objective, passed: ev.passed, status: ev.passed ? 'evaluated' : 'gated_out' });
      }
      const ranked = children.filter((c) => evals.get(c.id)!.passed).sort((a, b) => (evals.get(b.id)!.objective ?? -Infinity) - (evals.get(a.id)!.objective ?? -Infinity));
      const best = [...children].sort((a, b) => (evals.get(b.id)!.objective ?? -Infinity) - (evals.get(a.id)!.objective ?? -Infinity))[0];
      gp.best_candidate_id = best?.id ?? null; gp.best_objective = best ? evals.get(best.id)!.objective : null;
      // 平台检验 → 验证段
      const promoted: Candidate[] = [];
      let tested = 0;
      for (const c of ranked) {
        // 每代最多对 2×promote 个候选做平台检验:排在后面的即使过了平台,目标也不如已淘汰的,不值得再花邻域回测
        if (promoted.length >= spec.budget.promote_per_generation || tested >= 2 * spec.budget.promote_per_generation) break;
        tested++; check();
        const ev = evals.get(c.id)!, nbrs: { label: string; objective: number | null }[] = [];
        for (const n of plateauNeighbors(c.ir)) { if (!check0(n.ir).ok) continue; const t = await evaluateTrain(env, n.ir, hash(n.ir), spec.objective); plateauChecks++; nbrs.push({ label: n.label, objective: t.objective }); }
        const gate = plateauGate(ev.objective, nbrs, spec.objective);
        ev.gates.push(gate); ev.passed = ev.gates.every((g) => g.ok);
        if (!gate.ok) { jobs.updateCandidate(job_id, c.id, { status: 'plateau_failed', evaluation: ev }); emit('plateau', `${c.id} 邻域不是平台(${gate.note}),淘汰`); continue; }
        ev.validation = await evaluateSegment(env, c.ir, hash(c.ir), 'validation');
        jobs.updateCandidate(job_id, c.id, { status: 'validated', evaluation: ev });
        promoted.push(c); gp.promoted.push(c.id);
        emit('validate', `${c.id} 验证段:夏普 ${fmt(ev.validation.sharpe)}、收益 ${pct(ev.validation.total_return)}(父 ${fmt(evals.get(parent.id)!.validation?.sharpe ?? null)})`);
      }
      // 冠军比较:验证段夏普更高(相等时收益更高)。parent 不再用来比验证段(explore 父策略没有验证段)
      const cv = evals.get(champion.id)!.validation!, beats = (v: SegmentScore) => (v.sharpe ?? -Infinity) > (cv.sharpe ?? -Infinity) || ((v.sharpe ?? -Infinity) === (cv.sharpe ?? -Infinity) && v.total_return > cv.total_return);
      const winner = promoted.filter((c) => beats(evals.get(c.id)!.validation!)).sort((a, b) => (evals.get(b.id)!.validation!.sharpe ?? -Infinity) - (evals.get(a.id)!.validation!.sharpe ?? -Infinity))[0];
      const pObj = evals.get(parent.id)!.objective ?? -Infinity;
      const explorer = !winner && allowExplore ? children.filter((c) => (evals.get(c.id)!.objective ?? -Infinity) > pObj).sort((a, b) => (evals.get(b.id)!.objective ?? -Infinity) - (evals.get(a.id)!.objective ?? -Infinity))[0] : undefined;
      if (winner) {
        jobs.updateCandidate(job_id, winner.id, { status: 'parent' });
        gp.improved = true; gp.mode = 'promote'; gp.note = `${winner.id}(${winner.generator})门槛全过且验证段优于当前冠军,成为冠军与下一代父策略(promote)`;
        parent = winner; champion = winner; stale = 0;
      } else if (explorer) {
        const ev = evals.get(explorer.id)!;
        jobs.updateCandidate(job_id, explorer.id, { status: 'explore_parent' });
        gp.mode = 'explore'; gp.note = `没有候选能 promote;${explorer.id}(${explorer.generator})训练目标 ${fmt(ev.objective)} 高于父策略 ${fmt(pObj)}${ev.passed ? '' : '(门槛未全过:' + ev.gates.filter((g) => !g.ok).map((g) => g.name).join('/') + ')'},作为下一代父策略继续搜索(explore,不能当冠军)`;
        parent = explorer; stale = 0;
      } else {
        stale++; gp.note = promoted.length ? '进验证段的候选都没有优于当前冠军' : ranked.length ? '门槛通过的候选都没过平台检验' : '没有候选通过训练段门槛';
        if (allowExplore) gp.note += ',也没有训练目标高于父策略的候选可 explore';
      }
      gp.champion_id = champion.id;
      emit('generation', `第 ${gen} 代结束:${gp.note}`);
      if (stop) break;
      if (stale >= (spec.budget.patience ?? 2)) { stop = `no_improvement_${spec.budget.patience ?? 2}_generations`; break; }
    }
    stop ??= 'budget_generations';
    progress.stop_reason = stop;

    // ---- 5) 冠军只跑一次留出段
    const cEval = evals.get(champion.id)!;
    check();
    jobs.claimHoldout(job_id);
    emit('holdout', `冠军 ${champion.id} 跑留出段(只此一次)`);
    cEval.holdout = await evaluateSegment(env, champion.ir, hash(champion.ir), 'holdout');
    jobs.updateCandidate(job_id, champion.id, { status: 'champion', evaluation: cEval });

    // ---- 6) 过拟合账本
    emit('ledger', '算 Deflated Sharpe 与随机入场基线');
    const trainSharpes = [...evals.values()].map((e) => e.train?.daily_sharpe).filter((x): x is number => typeof x === 'number');
    const cr = dailyReturns(runs.get(champion.id)!.samples), sr = periodSharpe(cr), mo = moments(cr), V = variance(trainSharpes);
    const dsr = sr === null ? null : deflatedSharpe({ sharpe: sr, trials: progress.trials, sharpeVariance: V, days: cr.length, skew: mo.skew, kurtosis: mo.kurtosis });
    const ledger: OverfitLedger = {
      trials: progress.trials, deflated_sharpe: dsr?.dsr ?? null, pbo: null, random_entry_baseline: null, plateau_checks: plateauChecks,
      deflated_inputs: sr === null ? null : { sharpe: sr, sharpe_variance: V, expected_max_sharpe: expectedMaxSharpe(progress.trials, V), days: cr.length, skew: mo.skew, kurtosis: mo.kurtosis },
      random_entry: null,
      notes: [`试验数 ${progress.trials}(训练段评估过的候选,含基线;平台检验点 ${plateauChecks} 个另计)`, 'Deflated Sharpe 按训练段日收益(不年化)折算:冠军是在这些试验里挑出来的,DSR ≥ 0.95 才算扛住多重试验', 'PBO(组合对称交叉验证)第二阶段做,暂为 null'],
    };
    const rnd = await randomEntryBaseline(env, champion.ir, hash(champion.ir), data.segments.train, cEval.train!, { runs: spec.random_entry_runs, seed: spec.seed });
    if (rnd) { ledger.random_entry = rnd.ledger; ledger.random_entry_baseline = rnd.median_score; ledger.notes.push(rnd.ledger.note); }
    const explored = progress.generations.filter((g) => g.mode === 'explore').length;
    if (explored) ledger.notes.push(`多步搜索:${explored} 代由 explore 父策略(门槛未过或未验证、训练目标更高)继续往下搜;冠军只从门槛全过且验证段优于基线的候选里选`);
    progress.single_runs = env.runs;

    // ---- 7) 写版本(状态不推进)
    let written: number | null = null;
    const isBase = champion.id === baseline.id;
    if (!isBase && spec.write_version && spec.strategy_id) {
      const note = `改进环 ${job_id} 冠军 ${champion.id}(第 ${champion.generation} 代,${champion.generator}:${champion.rationale.slice(0, 200)});训练目标 ${fmt(cEval.objective)} vs 基线 ${fmt(baseEval.objective)};验证夏普 ${fmt(cEval.validation?.sharpe ?? null)} vs 基线 ${fmt(baseEval.validation?.sharpe ?? null)};留出段 ${pct(cEval.holdout.total_return)}(同敞口持有 ${pct(cEval.holdout.exposure_matched_hold)});Deflated Sharpe ${fmt(ledger.deflated_sharpe)};状态未推进,进 paper 需人工确认`;
      try { written = (deps.writeVersion ?? defaultWriteVersion(deps.db))(spec.strategy_id, champion.ir, note); }
      catch (e) { progress.notes.push(`冠军写入策略版本失败:${String(e instanceof Error ? e.message : e).slice(0, 300)}`); }
    }
    const summary = isBase
      ? `${progress.generations.length} 代没有找到在验证段优于原策略的改法(${stop});原策略留出段 ${pct(cEval.holdout.total_return)},同敞口持有 ${pct(cEval.holdout.exposure_matched_hold)}`
      : `冠军 ${champion.id}(第 ${champion.generation} 代,${champion.generator}):验证夏普 ${fmt(cEval.validation?.sharpe ?? null)} vs 原策略 ${fmt(baseEval.validation?.sharpe ?? null)};留出段 ${pct(cEval.holdout.total_return)}(同敞口持有 ${pct(cEval.holdout.exposure_matched_hold)},资产池持有 ${pct(cEval.holdout.hold_return)});Deflated Sharpe ${fmt(ledger.deflated_sharpe)}`;
    const result: ImproveResult = { champion_id: champion.id, baseline_id: baseline.id, champion_is_baseline: isBase, holdout: cEval.holdout, baseline_validation: baseEval.validation ?? null, strategy_version_written: written, stop_reason: stop, summary };
    progress.elapsed_ms = now() - started;
    jobs.update(job_id, { status: 'completed', ledger, result, progress, finished: true });
    emit('done', summary, undefined, 'completed');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e), cancelled = /CANCELLED/.test(msg) || !!deps.signal?.aborted;
    progress.elapsed_ms = now() - started;
    jobs.update(job_id, { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? 'cancelled' : msg.slice(0, 2000), progress, finished: true });
    deps.emit?.({ job_id, phase: 'done', generation: progress.generation, message: cancelled ? '已取消' : `失败:${msg.slice(0, 300)}`, trials: progress.trials, status: cancelled ? 'cancelled' : 'failed' });
  }
  return jobs.require(job_id);
}
const fmt = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(2));
