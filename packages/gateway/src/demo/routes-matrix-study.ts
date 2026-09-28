/**
 * 矩阵研究 HTTP 面(契约 §9.53 B「2026-09-25 matrix study 修订」;研究域,零交易所写入):
 *   POST /api/research/matrix-studies/estimate      {spec?|recommendation_id?}           → {spec, estimate, cells}(不落库)
 *   GET  /api/research/matrix-studies/prefill?recommendation_id=                        → {spec, notes, estimate}(推荐卡只取 eligible 格子)
 *   POST /api/research/matrix-studies               {spec?, recommendation_id?, idempotency_key?} → 201 MatrixStudyView(queued,进程内排队执行)
 *   GET  /api/research/matrix-studies?limit=                                            → {items}(不含格子明细)
 *   GET  /api/research/matrix-studies/:id                                               → MatrixStudyView
 *   GET  /api/research/matrix-studies/:id/events?after_seq=                             → {items: MatrixEvent[]}(SSE 断线续传)
 *   POST /api/research/matrix-studies/:id/cancel | /resume
 *   POST /api/research/matrix-studies/:id/finalize  {expected_manifest_hash}            → 202 view(留出一次释放全部 finalist)
 *   POST /api/research/matrix-studies/:id/adopt     {finalist_id, name?}                → {strategy_id, version, preflight, horizon, source}
 *   POST /api/research/matrix-studies/:id/adopt-candidate {trial_id, name?}             → 同上 + {kind:'paper_candidate', final_validation:false, trial_id, tier, scorecard, next}
 *        (批量验证 v2:只收 tier=paper_candidate 或 verdict=near 的试验;存成我的策略 / 新版本,描述前缀「[批量验证候补 … · 未经最终验收」,不自动启动运行)
 *   GET  /api/research/matrix-studies/:id/trials/:trial_id                              → {cell, ir, tier, reasons, scorecard, adopted}(只含训练 / 选择段,研究台深链用)
 * SSE `research.matrix_study`(data = MatrixEvent,带 seq)。错误:not_found → 404,conflict/busy/already/mismatch → 409,其余 400。
 *
 * runtime 对接点(可选,鸭子类型读取,本文件不改 runtime.ts):
 *   rt.matrixStudyHooks?: { judgeProvider?(): DecisionProvider | null; modelProfile?(): FrozenModelProfile | null;
 *                           onConclusion?(row, conclusion): void; onAdopted?(row, adopted): void }
 *   rt.strategyRuns?.().preflight(strategy_id, version) 作 adopt 预检(没有时用静态 IR 预检)。
 */
import type { RouteContext, RouteHandler } from './http-extra.js';
import { RecommendationStore } from './recommend.js';
import type { DecisionProvider, FrozenModelProfile } from './research/judge/types.js';
import type { MicrostructureSource } from './research/judge/microstructure.js';
import { MatrixStudyService, type AdoptResult, type CandidateAdoptResult, type PreflightLike } from './research/matrix-study/service.js';
import type { MatrixConclusion, MatrixStudyRow } from './research/matrix-study/types.js';
import { MatrixWorkerRunner } from './research/matrix-study/worker-runner.js';

export interface MatrixStudyHooks {
  judgeProvider?(): DecisionProvider | null;
  modelProfile?(): FrozenModelProfile | null;
  /** 盘口 / 清算 live_only 特征的录制数据源;没有时依赖它的判断臂标数据不可评 */
  microstructure?(): MicrostructureSource | null;
  onConclusion?(row: MatrixStudyRow, conclusion: MatrixConclusion): void;
  onAdopted?(row: MatrixStudyRow, adopted: (AdoptResult | CandidateAdoptResult) & { finalist_id: string }): void;
}
let shared: MatrixStudyService | null = null;
/** 给 runtime / 对话工具取同一个服务实例(路由注册后可用) */
export const matrixStudyService = () => shared;
let sharedRunner: MatrixWorkerRunner | null = null;
/** 关停用:终止矩阵研究 worker,正在跑的研究标 interrupted(可 resume) */
export const closeMatrixStudyWorkers = (): Promise<void> => sharedRunner?.close() ?? Promise.resolve();

export function matrixStudyRoutes(ctx: RouteContext): void {
  const rt = ctx.rt as unknown as { matrixStudyHooks?: MatrixStudyHooks; strategyRuns?: () => { preflight(id: string, v?: number): PreflightLike } };
  const hooks = () => rt.matrixStudyHooks ?? {};
  const judge = () => { const provider = hooks().judgeProvider?.() ?? null; const microstructure = hooks().microstructure?.() ?? null; return provider ? { provider, ...(microstructure ? { microstructure } : {}) } : undefined; };
  // 搜索 / 回测 / 留出评估进 worker_threads(主事件循环只收消息);内存库、注入了 loader/executorFor、TG_MATRIX_WORKER=0 时本线程跑
  const runner = new MatrixWorkerRunner({ db: ctx.store.marketDb, flush: () => svc.flush(), judge, onConclusion: (row, c) => hooks().onConclusion?.(row, c), inlineIf: () => !!(svc.deps.loader || svc.deps.executorFor) });
  const svc: MatrixStudyService = new MatrixStudyService({
    db: ctx.store.marketDb,
    judge,
    offload: runner.offload,
    modelProfile: () => hooks().modelProfile?.() ?? null,
    recommendation: (id) => new RecommendationStore(ctx.store.marketDb).get(id),
    ...(typeof rt.strategyRuns === 'function' ? { preflight: (id: string, v: number) => rt.strategyRuns!().preflight(id, v) } : {}),
    emit: (event, data) => ctx.emit(event, data),
    onConclusion: (row, c) => hooks().onConclusion?.(row, c),
    onAdopted: (row, a) => hooks().onAdopted?.(row, a),
  });
  shared = svc; sharedRunner = runner;
  svc.recover();
  const wrap = (h: RouteHandler): RouteHandler => async (req, res, url, p) => {
    try { await h(req, res, url, p); } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      ctx.fail(res, /not_found/.test(m) ? 404 : /conflict|busy|already|mismatch|not_passed|preflight_blocked|candidate_not_allowed|candidate_is_finalist/.test(m) ? 409 : 400, m, 'research_matrix_study_error');
    }
  };
  const base = '/api/research/matrix-studies';
  ctx.route('POST', `${base}/estimate`, wrap(async (req, res) => ctx.json(res, 200, svc.estimate(await ctx.readBody(req)))));
  ctx.route('GET', `${base}/prefill`, wrap(async (_req, res, url) => ctx.json(res, 200, svc.prefill(url.searchParams.get('recommendation_id') ?? ''))));
  ctx.route('POST', base, wrap(async (req, res) => ctx.json(res, 201, svc.get(svc.create(await ctx.readBody(req)).id))));
  ctx.route('GET', base, wrap(async (_req, res, url) => { const l = Number(url.searchParams.get('limit') ?? 50); if (!Number.isFinite(l) || l < 1) throw Error('invalid_limit'); ctx.json(res, 200, svc.list(l)); }));
  ctx.route('GET', `${base}/:id`, wrap(async (_req, res, _u, p) => ctx.json(res, 200, svc.get(p['id']!))));
  ctx.route('GET', `${base}/:id/events`, wrap(async (_req, res, url, p) => ctx.json(res, 200, svc.events(p['id']!, Number(url.searchParams.get('after_seq') ?? 0) || 0))));
  ctx.route('POST', `${base}/:id/cancel`, wrap(async (_req, res, _u, p) => ctx.json(res, 200, svc.view(svc.cancel(p['id']!)))));
  ctx.route('POST', `${base}/:id/resume`, wrap(async (_req, res, _u, p) => ctx.json(res, 200, svc.view(svc.resume(p['id']!)))));
  ctx.route('POST', `${base}/:id/finalize`, wrap(async (req, res, _u, p) => {
    const b = await ctx.readBody(req), h = b['expected_manifest_hash'];
    if (typeof h !== 'string') throw Error('expected_manifest_hash_required');
    const row = svc.store.require(p['id']!);
    if (row.manifest_hash !== h) throw Error('manifest_hash_mismatch');
    if (row.status !== 'ready_to_finalize') throw Error(`matrix_study_conflict:${row.status}`);
    void svc.finalize(row.id, h).catch(() => undefined);
    ctx.json(res, 202, svc.get(row.id));
  }));
  ctx.route('POST', `${base}/:id/adopt`, wrap(async (req, res, _u, p) => {
    const b = await ctx.readBody(req);
    if (typeof b['finalist_id'] !== 'string') throw Error('finalist_id_required');
    if (b['name'] !== undefined && typeof b['name'] !== 'string') throw Error('name_invalid');
    ctx.json(res, 200, svc.adopt(p['id']!, b['finalist_id'], b['name'] as string | undefined));
  }));
  ctx.route('POST', `${base}/:id/adopt-candidate`, wrap(async (req, res, _u, p) => {
    const b = await ctx.readBody(req);
    if (typeof b['trial_id'] !== 'string' || !b['trial_id']) throw Error('trial_id_required');
    if (b['name'] !== undefined && typeof b['name'] !== 'string') throw Error('name_invalid');
    ctx.json(res, 200, svc.adoptCandidate(p['id']!, b['trial_id'], b['name'] as string | undefined));
  }));
  ctx.route('GET', `${base}/:id/trials/:trial_id`, wrap(async (_req, res, _u, p) => ctx.json(res, 200, svc.trialDetail(p['id']!, p['trial_id']!))));
}
