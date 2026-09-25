/**
 * 搜索阶段(开发视图上):数据冻结 → 矩阵全部变体 → 迭代环(复用 improve 生成器 diagnosis/neighborhood/swap,不启用 model)。
 * 每个试验:先登记(config_hash 唯一)→ 已有 completed 评估直接复用(恢复不重跑)→ 否则开一次 attempt 跑评估。
 * 生成器只拿开发视图(单资产、截断到选择段末、holdout 哨兵)。
 */
import type { StrategyIR } from '@trading-swarm/contracts';
import type { AssetExecutor } from '../backtest-report.js';
import { getGenerator } from '../improve/generators/index.js';
import { compileCheck } from '../improve/runner.js';
import type { Candidate, Evaluation, GeneratorContext } from '../improve/types.js';
import { hash } from '../primitives.js';
import type { JudgeRuntime } from '../judge/index.js';
import { better, failedCause, judgeTrials, type JudgedTrial, type TrialRec } from './compute.js';
import { evaluateDev, singleAsset, type DataView } from './evaluate.js';
import type { MatrixStudyStore } from './store.js';
import { MATRIX_RUNNER_VERSION, type DevResult, type MatrixCell, type MatrixGeneration, type MatrixStudyRow, type MatrixVariantRef } from './types.js';

export const ENGINE_HASH = hash({ runner: MATRIX_RUNNER_VERSION });
export interface SearchCtx {
  store: MatrixStudyStore; row: MatrixStudyRow; views: Map<string, DataView>;
  check: () => void; overBudget: () => string | null;
  executorFor?: (ir: StrategyIR) => AssetExecutor; judge: JudgeRuntime | null;
  onTrial: (rec: TrialRec) => void;
}
export const dataHashOf = (row: MatrixStudyRow, tf: string, symbol: string) => hash(row.state.data_lock?.[`${tf}:${symbol}`] ?? null);

export function configOf(row: MatrixStudyRow, cell: MatrixCell, v: MatrixVariantRef) {
  const s = row.manifest.spec, g = cell.segments!;
  return { program: s.research_program_id, symbol: cell.symbol, market: s.market, timeframe: cell.timeframe, arm: cell.arm, ir: v.ir, vol_target: v.vol_target ?? null, model_profile: cell.arm === 'code_judge' ? s.model_profile : null, execution: row.manifest.execution_spec_hash, train: g.train, selection: g.selection, boundary: s.protocol.boundary };
}

/** 登记并评估一个试验(已完成的评估直接复用) */
export async function evalTrial(x: SearchCtx, cell: MatrixCell, v: MatrixVariantRef, generation: number, parent: string | null, stage: 'dev' | 'template_train' = 'dev'): Promise<TrialRec> {
  x.check();
  const row = x.row, config_hash = hash(configOf(row, cell, v)), ir_hash = hash(v.ir);
  const base = { cell_id: cell.id, variant_id: v.id, param: v.param, parent_trial_id: parent, generation, config_hash, ir_hash, ir: v.ir, ...(v.vol_target ? { vol_target: v.vol_target } : {}) };
  let t = x.store.trial(row.id, config_hash);
  const data_hash = dataHashOf(row, cell.timeframe, cell.symbol);
  if (t) {
    const e = x.store.evaluation(t.trial_id, stage, data_hash, ENGINE_HASH);
    if (e?.status === 'completed' && e.result) { const rec: TrialRec = { ...base, trial_id: t.trial_id, dev: e.result as DevResult, error: null, status: 'evaluated' }; if (stage === 'dev') x.onTrial(rec); return rec; }
  }
  const stop = x.overBudget();
  if (stop && !t?.selection_visible_at) { const rec: TrialRec = { ...base, trial_id: t?.trial_id ?? `unregistered:${config_hash.slice(0, 12)}`, dev: null, error: stop, status: 'budget_skipped' }; if (stage === 'dev') x.onTrial(rec); return rec; }
  t ??= x.store.insertTrial({ study_id: row.id, program: row.research_program_id, cell_id: cell.id, variant_id: v.id, parent_trial_id: parent, generation, config_hash, ir_hash, judge_hash: v.ir.judge ? hash(v.ir.judge) : null, model_revision: cell.arm === 'code_judge' ? row.manifest.spec.model_profile?.model_revision ?? null : null, candidate: { variant: v, cell_id: cell.id } });
  const view = x.views.get(cell.timeframe), data = view ? singleAsset(view.data, cell.symbol) : null;
  const fail = (error: string): TrialRec => { x.store.setTrialStatus(t!.trial_id, 'failed'); const rec: TrialRec = { ...base, trial_id: t!.trial_id, dev: null, error, status: 'failed' }; if (stage === 'dev') x.onTrial(rec); return rec; };
  if (!data) return fail('DATA_MISSING:no_bars_for_symbol_timeframe');
  if (v.ir.judge && !x.judge) return fail('judge_runtime_unavailable');
  if (stage === 'template_train') x.store.markVisible(t.trial_id,'template_train_started');
  const a = x.store.beginAttempt(row.id, t.trial_id, stage, data_hash, ENGINE_HASH);
  try {
    const trainOnly = stage === 'template_train';
    const g = cell.segments!;
    const dev = await evaluateDev(data, g, v, { train_only: trainOnly, check: x.check, ...(x.executorFor ? { executorFor: x.executorFor } : {}), judge: x.judge, onCandidate: (c) => { if (c.decision) x.store.putCandidate(row.id, t!.trial_id, stage, c.candidate.id, c.candidate, c.decision); } });
    x.store.finishAttempt(a, 'completed', dev, null);
    x.store.markVisible(t.trial_id, stage === 'dev' ? 'evaluated' : 'template_train_evaluated');
    const rec: TrialRec = { ...base, trial_id: t.trial_id, dev, error: null, status: 'evaluated' }; if (stage === 'dev') x.onTrial(rec); return rec;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/CANCELLED/.test(msg)) { x.store.finishAttempt(a, 'cancelled', null, 'CANCELLED'); throw Error('CANCELLED'); }
    x.store.finishAttempt(a, 'failed', null, msg.slice(0, 300));
    return fail(msg.slice(0, 300));
  }
}

/** 矩阵阶段:全部 applicable 格子 × 变体(第 0 代) */
export async function runMatrix(x: SearchCtx): Promise<TrialRec[]> {
  const out: TrialRec[] = [];
  for (const cell of x.row.manifest.cells) if (cell.applicability === 'applicable') {
    const groups = new Map<string, MatrixVariantRef[]>();
    for (const v of cell.variants) { const key=v.template_group??v.id;groups.set(key,[...(groups.get(key)??[]),v]); }
    for (const vs of groups.values()) {
      if (!vs[0]!.template_group) { out.push(await evalTrial(x,cell,vs[0]!,0,null));continue; }
      const training: {v:MatrixVariantRef;t:TrialRec}[]=[];
      for (const v of vs) training.push({v,t:await evalTrial(x,cell,v,0,null,'template_train')});
      training.sort((a,b)=>(b.t.dev?.train.sharpe??-Infinity)-(a.t.dev?.train.sharpe??-Infinity)||a.v.id.localeCompare(b.v.id));
      const winner=training.find(t=>t.t.dev)?.v;
      for (const item of training) if(item.v!==winner) {
        const rec:TrialRec={...item.t,dev:null,status:'failed',error:item.t.error??'template_train_not_selected'};out.push(rec);x.onTrial(rec);
      }
      if(winner)out.push(await evalTrial(x,cell,winner,0,null));
    }
  }
  return out;
}

/**
 * 迭代环:验证(选择)段 near 格子里最好的 top_k 格,每代由父试验的训练段诊断 → 生成器出变体 → 逐个作为新试验评估;
 * 子代比父更好(pass > near > fail,再比选择段夏普)才晋升为下一代父;连续 patience 代没有改进或预算 / 墙钟用完即停。
 * 返回新增试验与每代记录(「诊断出什么问题 → 改了什么 → 选择段结果」)。
 */
export async function runIterate(x: SearchCtx, all: TrialRec[], programTrials: () => number, onGeneration: (g: MatrixGeneration) => void): Promise<{ added: TrialRec[]; stop: string | null }> {
  const s = x.row.manifest.spec, added: TrialRec[] = [];
  if (s.iterate.generations <= 0) return { added, stop: 'iterate_disabled' };
  const judged = () => judgeTrials([...all, ...added], programTrials(), s.protocol).trials;
  const bestOf = (cell_id: string) => judged().filter((t) => t.cell_id === cell_id && t.dev).sort(better)[0];
  const cells = x.row.manifest.cells.filter((c) => c.applicability === 'applicable');
  const near = cells.map((c) => bestOf(c.id)).filter((t): t is JudgedTrial => !!t && t.verdict === 'near').sort(better).slice(0, s.iterate.top_k);
  let stop: string | null = null;
  const generators = ['diagnosis', 'neighborhood', 'swap'].map((n) => getGenerator(n as 'diagnosis')).filter((g): g is NonNullable<typeof g> => !!g);
  for (const start of near) {
    const cell = cells.find((c) => c.id === start.cell_id)!, view = x.views.get(cell.timeframe), data = view ? singleAsset(view.data, cell.symbol) : null;
    if (!data) continue;
    const seen = new Set([...all, ...added].filter((t) => t.cell_id === cell.id).map((t) => t.ir_hash));
    let parent: JudgedTrial = start, stale = 0;
    for (let n = 1; n <= s.iterate.generations; n++) {
      x.check();
      const over = x.overBudget(); if (over) { stop = over; break; }
      const diag = (parent.dev?.diagnosis ?? []).filter((d) => d.severity !== 'info');
      const pc: Candidate = { id: parent.trial_id, parent_id: parent.parent_trial_id, generation: parent.generation, generator: 'baseline', ir: parent.ir, diff: [], rationale: '父试验' };
      const ev: Evaluation = { candidate_id: parent.trial_id, folds: [], objective: parent.dev?.train.sharpe ?? null, gates: [], passed: false };
      // 我的策略行:用户策略自带的规范阻断(父 IR 已有的)不拦子代,只拦新引入的;内置族照旧全拦
      const baseline = cell.family.startsWith('my:') ? new Set(compileCheck(parent.ir, cell.timeframe).blocks) : new Set<string>();
      const ctx: GeneratorContext = { parent: pc, evaluation: ev, diagnosis: parent.dev?.diagnosis ?? [], data, budget: s.iterate.candidates_per_generation, check: (ir) => { const r = compileCheck(ir, cell.timeframe, baseline); return r.ok ? { ok: true } : { ok: false, reason: r.reason ?? 'invalid' }; } };
      const lanes: { ir: StrategyIR; rationale: string; diff: Candidate['diff']; generator: string }[][] = [];
      for (const g of generators) {
        let out: Awaited<ReturnType<typeof g.generate>> = [];
        try { out = await g.generate(ctx); } catch { out = []; }
        lanes.push(out.map((c) => ({ ir: cell.arm === 'code_judge' ? { ...c.ir, version: 2 as const, judge: parent.ir.judge ?? s.judge! } : c.ir, rationale: c.rationale, diff: c.diff, generator: g.name })).filter((c) => { const h = hash(c.ir); if (seen.has(h)) return false; seen.add(h); return true; }));
      }
      const picked: (typeof lanes)[number] = [];
      for (let k = 0; picked.length < s.iterate.candidates_per_generation && lanes.some((l) => l.length > k); k++) for (const l of lanes) if (l[k] && picked.length < s.iterate.candidates_per_generation) picked.push(l[k]!);
      const kids: TrialRec[] = [];
      for (const [k, c] of picked.entries()) {
        const parentVariant = { id: parent.variant_id, param: parent.param, vol_target: parent.vol_target };
        const rec = await evalTrial(x, cell, { id: `${parentVariant.id}~g${n}c${k + 1}`, param: `${parentVariant.param}~${c.generator}${n}.${k + 1}`, ir: c.ir, ...(parentVariant.vol_target ? { vol_target: parentVariant.vol_target } : {}) }, n, parent.trial_id);
        added.push(rec); kids.push(rec);
        if (rec.status === 'budget_skipped') { stop = rec.error; break; }
      }
      const j = judged(), jk = j.filter((t) => kids.some((k) => k.trial_id === t.trial_id) && t.dev).sort(better), bestKid = jk[0], jp = j.find((t) => t.trial_id === parent.trial_id) ?? parent;
      const promoted = !!bestKid && better(bestKid, jp) < 0;
      const src = bestKid ? picked[kids.findIndex((k) => k.trial_id === bestKid.trial_id)] : null;
      onGeneration({
        n, cell_id: cell.id, parent_trial_id: parent.trial_id,
        diagnosis: diag.length ? diag.map((d) => `${d.key}:${d.text}`).join(';').slice(0, 600) : '训练段诊断没有高 / 中级问题',
        change: src ? `${src.generator}:${src.rationale}(${src.diff.map((d) => d.path).join(', ')})`.slice(0, 600) : picked.length ? '候选都没能评估' : '生成器没有产出新变体',
        trial_id: bestKid?.trial_id ?? null, generator: src?.generator ?? null, selection: bestKid?.dev?.selection ?? null, promoted,
        note: promoted ? `第 ${n} 代 ${bestKid!.trial_id} 优于父试验,晋升为下一代父` : `第 ${n} 代没有优于父试验的变体`,
      });
      if (promoted) { parent = bestKid!; stale = 0; } else if (++stale >= s.iterate.patience) break;
      if (stop) break;
    }
    if (stop) break;
  }
  return { added, stop };
}
export { failedCause };
