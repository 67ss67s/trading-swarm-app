/**
 * 改进环 HTTP 面(研究域,零交易所写入、零模型):
 *   POST /api/research/improve {strategy_id? | strategy_ir, strategy_version?, timeframe?, universe?, from_ms?, to_ms?, objective?, budget?, generators?, dataset_ids?, random_entry_runs?, write_version?}
 *        → 202 {job_id}(任务在 worker 线程里跑;同时只跑一个,第二个 409)
 *   GET  /api/research/improve?strategy_id=&limit=   → {jobs: ImproveJobSummary[]}
 *   GET  /api/research/improve/:id                   → ImproveJobDetail(状态、每代进度、谱系、排行榜、账本、留出段结果)
 *   POST /api/research/improve/:id/cancel            → ImproveJobSummary
 * 进度用 ctx.emit('research.improve', ImproveEvent) 广播(SSE 白名单在 http.ts,需主线程加上这个事件名)。
 * 错误约定同 routes-research.ts:含 not_found → 404,busy/conflict → 409,其余 400。
 */
import type { IncomingMessage } from 'node:http';
import type { StrategyIR } from '@trading-swarm/contracts';
import type { RouteContext, RouteHandler } from '../../http-extra.js';
import { timeframeMillis } from '../strategy.js';
import { StrategyStore } from '../strategies/store.js';
import { DEFAULT_DAYS, DEFAULT_TIMEFRAME, DEFAULT_UNIVERSE } from './data.js';
import { DEFAULT_GENERATORS, registeredGenerators } from './generators/index.js';
import { ImproveManager, type ManagerOptions } from './manager.js';
import { RANDOM_ENTRY_RUNS, RANDOM_ENTRY_SEED } from './random-entry.js';
import { IMPROVE_EVENT } from './runner.js';
import type { CandidateRow, ImproveSpec, JobRow } from './store.js';
import { DEFAULT_BUDGET, DEFAULT_OBJECTIVE, type Budget, type GeneratorName, type Objective } from './types.js';

const obj = (v: unknown, name: string): Record<string, unknown> => { if (v === undefined) return {}; if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error(`${name}_invalid`); return v as Record<string, unknown>; };
const num = (v: unknown, name: string, lo: number, hi: number, int = false): number => { if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi || (int && !Number.isInteger(v))) throw Error(`${name}_invalid`); return v; };
const bool = (v: unknown, name: string): boolean => { if (typeof v !== 'boolean') throw Error(`${name}_invalid`); return v; };
/** 资产池上限(批量研究的 20 币池要能直接拿来改进,2026-09-23 由 12 放到 30) */
export const MAX_UNIVERSE = 30;
const GENERATOR_NAMES: GeneratorName[] = ['diagnosis', 'neighborhood', 'swap', 'oracle', 'model'];

/** 请求 → 冻结的任务规格(校验在这里一次做完,跑中不再改)。 */
export function parseImproveRequest(raw: unknown, strategies: StrategyStore, now = Date.now()): ImproveSpec {
  const b = obj(raw, 'body');
  const known = new Set(['strategy_id', 'strategy_version', 'strategy_ir', 'timeframe', 'universe', 'from_ms', 'to_ms', 'objective', 'budget', 'generators', 'dataset_ids', 'random_entry_runs', 'seed', 'write_version']);
  const extra = Object.keys(b).filter((k) => !known.has(k));
  if (extra.length) throw Error(`unknown_fields:${extra.join(',')}`);
  let ir: StrategyIR, strategy_id: string | null = null, strategy_version: number | null = null;
  if (b.strategy_id !== undefined) {
    if (typeof b.strategy_id !== 'string') throw Error('strategy_id_invalid');
    const s = strategies.require(b.strategy_id);
    strategy_version = b.strategy_version === undefined ? s.current_version : num(b.strategy_version, 'strategy_version', 1, 1e6, true);
    const v = strategies.versionIR(s.id, strategy_version);
    if (!v) throw Error('strategy_version_not_found');
    ir = v; strategy_id = s.id;
  } else if (b.strategy_ir && typeof b.strategy_ir === 'object') ir = b.strategy_ir as StrategyIR;
  else throw Error('strategy_id_or_strategy_ir_required');
  const timeframe = b.timeframe === undefined ? DEFAULT_TIMEFRAME : String(b.timeframe);
  timeframeMillis(timeframe);
  const universe = b.universe === undefined ? DEFAULT_UNIVERSE : b.universe;
  if (!Array.isArray(universe) || !universe.length || universe.length > MAX_UNIVERSE || universe.some((s) => typeof s !== 'string' || !/^[A-Za-z0-9:/_-]{2,40}$/.test(s))) throw Error('universe_invalid');
  const to_ms = b.to_ms === undefined ? now : Math.min(now, num(b.to_ms, 'to_ms', 0, 1e14, true));
  const from_ms = b.from_ms === undefined ? to_ms - DEFAULT_DAYS * 86400000 : num(b.from_ms, 'from_ms', 0, 1e14, true);
  if (to_ms - from_ms < 30 * 86400000) throw Error('window_too_short:at_least_30_days');
  const o = obj(b.objective, 'objective'), bu = obj(b.budget, 'budget');
  const objective: Objective = {
    min_trades_per_fold: o.min_trades_per_fold === undefined ? DEFAULT_OBJECTIVE.min_trades_per_fold : num(o.min_trades_per_fold, 'objective.min_trades_per_fold', 0, 1e6, true),
    min_trades_total: o.min_trades_total === undefined ? DEFAULT_OBJECTIVE.min_trades_total : num(o.min_trades_total, 'objective.min_trades_total', 0, 1e6, true),
    max_drawdown: o.max_drawdown === undefined ? DEFAULT_OBJECTIVE.max_drawdown : num(o.max_drawdown, 'objective.max_drawdown', 0, 1),
    require_stress_positive: o.require_stress_positive === undefined ? DEFAULT_OBJECTIVE.require_stress_positive : bool(o.require_stress_positive, 'objective.require_stress_positive'),
    require_beats_exposure_matched_hold: o.require_beats_exposure_matched_hold === undefined ? DEFAULT_OBJECTIVE.require_beats_exposure_matched_hold : bool(o.require_beats_exposure_matched_hold, 'objective.require_beats_exposure_matched_hold'),
    plateau_ratio: o.plateau_ratio === undefined ? DEFAULT_OBJECTIVE.plateau_ratio : num(o.plateau_ratio, 'objective.plateau_ratio', 0, 1),
    stability_penalty: o.stability_penalty === undefined ? 0.5 : num(o.stability_penalty, 'objective.stability_penalty', 0, 10),
  };
  const budget: Budget = {
    generations: bu.generations === undefined ? DEFAULT_BUDGET.generations : num(bu.generations, 'budget.generations', 1, 10, true),
    candidates_per_generation: bu.candidates_per_generation === undefined ? DEFAULT_BUDGET.candidates_per_generation : num(bu.candidates_per_generation, 'budget.candidates_per_generation', 1, 16, true),
    promote_per_generation: bu.promote_per_generation === undefined ? DEFAULT_BUDGET.promote_per_generation : num(bu.promote_per_generation, 'budget.promote_per_generation', 1, 4, true),
    wall_clock_ms: bu.wall_clock_ms === undefined ? DEFAULT_BUDGET.wall_clock_ms : num(bu.wall_clock_ms, 'budget.wall_clock_ms', 1000, 4 * 3600000, true),
    model_calls: bu.model_calls === undefined ? 0 : num(bu.model_calls, 'budget.model_calls', 0, 0, true),
    patience: bu.patience === undefined ? 2 : num(bu.patience, 'budget.patience', 1, 10, true),
    allow_explore: bu.allow_explore === undefined ? DEFAULT_BUDGET.allow_explore ?? true : bool(bu.allow_explore, 'budget.allow_explore'),
  };
  const generators = (b.generators === undefined ? DEFAULT_GENERATORS : b.generators) as GeneratorName[];
  if (!Array.isArray(generators) || !generators.length || generators.some((g) => !GENERATOR_NAMES.includes(g))) throw Error('generators_invalid');
  let dataset_ids: Record<string, string> | null = null;
  if (b.dataset_ids !== undefined) { const d = obj(b.dataset_ids, 'dataset_ids'); if (Object.values(d).some((x) => typeof x !== 'string' || !/^[a-f0-9]{64}$/.test(x))) throw Error('dataset_ids_invalid'); dataset_ids = d as Record<string, string>; }
  return {
    strategy_id, strategy_version, strategy_ir: ir, timeframe, universe: universe as string[], from_ms, to_ms, objective, budget, generators: [...new Set(generators)], dataset_ids,
    random_entry_runs: b.random_entry_runs === undefined ? RANDOM_ENTRY_RUNS : num(b.random_entry_runs, 'random_entry_runs', 0, 200, true),
    seed: b.seed === undefined ? RANDOM_ENTRY_SEED : num(b.seed, 'seed', 0, 2 ** 31, true),
    write_version: b.write_version === undefined ? true : bool(b.write_version, 'write_version'),
  };
}

export function jobSummary(j: JobRow) {
  return { id: j.id, status: j.status, strategy_id: j.strategy_id, strategy_version: j.strategy_version, label: j.spec.strategy_ir.label, timeframe: j.spec.timeframe, universe: j.spec.universe, created_at: j.created_at, updated_at: j.updated_at, finished_at: j.finished_at, phase: j.progress?.phase ?? null, message: j.progress?.message ?? null, generation: j.progress?.generation ?? 0, trials: j.progress?.trials ?? 0, champion_id: j.result?.champion_id ?? null, summary: j.result?.summary ?? null, error: j.error };
}
const lineageRow = (c: CandidateRow) => ({ id: c.id, parent_id: c.parent_id, generation: c.generation, generator: c.generator, status: c.status, ir_hash: c.ir_hash, strategy_ir: c.ir, diff: c.diff, rationale: c.rationale, evidence: c.evidence ?? null, evaluation: c.evaluation });
/** 排行榜:训练段评估过的候选,门槛全过的排前,再按目标降序;最多 50 行。 */
export function leaderboard(cs: CandidateRow[]) {
  return cs.filter((c) => c.evaluation).map((c) => { const e = c.evaluation!; return { id: c.id, generation: c.generation, generator: c.generator, status: c.status, objective: e.objective, passed: e.passed, failed_gates: e.gates.filter((g) => !g.ok).map((g) => g.name), train_return: e.train?.total_return ?? null, train_sharpe: e.train?.sharpe ?? null, train_trades: e.train?.trades ?? null, validation_return: e.validation?.total_return ?? null, validation_sharpe: e.validation?.sharpe ?? null, holdout_return: e.holdout?.total_return ?? null }; })
    .sort((a, b) => Number(b.passed) - Number(a.passed) || (b.objective ?? -Infinity) - (a.objective ?? -Infinity)).slice(0, 50);
}
export function jobDetail(j: JobRow, cs: CandidateRow[]) {
  return { job: jobSummary(j), spec: { ...j.spec }, frozen: j.frozen, progress: j.progress, ledger: j.ledger, result: j.result, lineage: cs.map(lineageRow), leaderboard: leaderboard(cs), generators_available: registeredGenerators() };
}

export function registerImproveRoutes(ctx: RouteContext, body: (req: IncomingMessage) => Promise<unknown>, opts: ManagerOptions = {}): ImproveManager {
  const db = ctx.store.marketDb, manager = new ImproveManager(db, (e) => ctx.emit(IMPROVE_EVENT, e), opts), strategies = new StrategyStore(db);
  const wrap = (handler: RouteHandler): RouteHandler => async (req, res, url, p) => {
    try { await handler(req, res, url, p); } catch (e) { const message = e instanceof Error ? e.message : String(e); ctx.fail(res, message.includes('not_found') ? 404 : /busy|conflict|already_used/.test(message) ? 409 : 400, message, 'research_improve_error'); }
  };
  const base = '/api/research/improve';
  ctx.route('POST', base, wrap(async (req, res) => { const spec = parseImproveRequest(await body(req), strategies); const job = manager.start(spec); ctx.json(res, 202, { job_id: job.id }); }));
  ctx.route('GET', base, wrap(async (_req, res, url) => {
    const limit = Number(url.searchParams.get('limit') ?? 50);
    if (!Number.isFinite(limit) || limit < 1) throw Error('invalid_limit');
    ctx.json(res, 200, { jobs: manager.jobs.list({ strategy_id: url.searchParams.get('strategy_id'), limit }).map(jobSummary) });
  }));
  ctx.route('GET', `${base}/:id`, wrap(async (_req, res, _url, p) => { const j = manager.jobs.require(p['id']!); ctx.json(res, 200, jobDetail(j, manager.jobs.candidates(j.id))); }));
  ctx.route('POST', `${base}/:id/cancel`, wrap(async (_req, res, _url, p) => ctx.json(res, 200, jobSummary(manager.cancel(p['id']!)))));
  return manager;
}
