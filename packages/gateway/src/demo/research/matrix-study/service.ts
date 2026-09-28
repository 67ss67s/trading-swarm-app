import { claimSlot } from '../../public-demo.js';
/**
 * 矩阵研究服务:estimate / create / list / get / cancel / resume / finalize / adopt + 进程内排队执行。
 *
 * 状态机:queued → running(stage data → matrix → iterate → sealed)→ ready_to_finalize → finalizing(stage holdout)→ completed
 *   另有 cancelled / failed / interrupted(可 resume;计数、费用、留出占用都不清零)。没有 finalist 时 running → completed(no_candidate)。
 * 留出:finalize 在 BEGIN IMMEDIATE 内 sealed → claimed(插 research_holdout_releases,UNIQUE(study_id) + 同谱系同数据范围区间重叠检查),
 *   一次评估全部 finalist → Holm → released(结果写一次)。
 * 每个阶段在同一事务写 bot handoff(带 study_id):开始 gate_captain→strategy_lab、每代 strategy_lab→strategy_lab、
 *   封存 / 完成 strategy_lab→gate_captain、adopt gate_captain→thread_manager;事件走 outbox(research_study_events),flush 后 SSE。
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { StrategyIR } from '@trade-gate/contracts';
import type { AssetExecutor, BarsLoader } from '../backtest-report.js';
import { hash } from '../primitives.js';
import { ResearchStore } from '../store.js';
import { StrategyStore } from '../strategies/store.js';
import { irHash, StrategyService } from '../strategies/service.js';
import type { ResearchService } from '../service.js';
import { JudgeDecisionStore } from '../judge/index.js';
import type { AssetRecommendation } from '../../recommend.js';
import type { FrozenModelProfile } from '../judge/types.js';
import { better, cellResults, conclusionOf, judgeSkipped, judgeStageMarks, judgeTrials, JUDGE_ERROR_MAX, ledgerHash, ledgerOf, type JudgedTrial, type TrialRec } from './compute.js';
import { evaluateHoldout, judgeBudgetId, judgeRuntimeFor, loadDevView, loadHoldoutView, type DataView, type MatrixJudgeDeps } from './evaluate.js';
import { buildManifest, cellJudgeCalls, codeCellIdOf, estimate, manifestHash, type MatrixEstimate } from './manifest.js';
import { evalCellVariants, runIterate, runMatrix, type SearchCtx } from './search.js';
import { normalizeSpec, prefillFromRecommendation } from './spec.js';
import { holdoutTest, holm } from './stats.js';
import { MatrixStudyStore } from './store.js';
import { TIER_RANK, tierBoard, type TierBoard } from './scorecard.js';
import { HORIZON_OF, isMyFamily, MATRIX_EVENT, type FailureCause, type JudgeStageSelection, type MatrixStudySpec, type MyStrategySnapshot, type MatrixConclusion, type MatrixEvent, type MatrixFinalist, type MatrixSource, type MatrixStudyRow, type MatrixStudyStatus, type MatrixTier, type MatrixTimeframe, type MatrixVariantRef } from './types.js';

export interface PreflightLike { deployable: boolean; blockers: { code: string; message: string }[]; warnings: { code: string; message: string }[] }
/** 候补 adoption 记录键前缀:research_matrix_adoptions.finalist_id = `candidate:<trial_id>` 即「未经最终验收」 */
export const CANDIDATE_KEY = 'candidate:';
export const candidateKey = (trial_id: string) => `${CANDIDATE_KEY}${trial_id}`;
const srcText = (s: MatrixSource) => [s.recommendation_id ? `推荐 ${s.recommendation_id}` : null, s.radar_tier ? `雷达 ${s.radar_tier}` : null, s.universe_scan_at ? `扫描 ${new Date(s.universe_scan_at).toISOString().slice(0, 16)}Z` : null].filter(Boolean).join(' / ') || '手动研究';
const nextOf = (strategy_id: string) => ({ link: `#my-strategies?id=${encodeURIComponent(strategy_id)}`, text: '去我的策略里用模拟盘跑起来' });
export interface CandidateAdoptResult extends AdoptResult {
  kind: 'paper_candidate'; final_validation: false; trial_id: string; tier: MatrixTier;
  scorecard: { value: number; label: string; luck: string };
  /** 前端引导:去我的策略里用模拟盘跑(不自动启动运行) */
  next: { link: string; text: string };
}
export interface AdoptResult { strategy_id: string; version: number; preflight: { deployable: boolean; warnings: { code: string; message: string }[] }; horizon: MatrixFinalist['horizon']; source: MatrixSource }
export interface MatrixServiceDeps {
  db: DatabaseSync;
  now?: () => number;
  /** 行情取数;缺省走研究已有缓存 loader(okxLoader / okxPerpLoader,先复用 research_datasets) */
  loader?: BarsLoader;
  executorFor?: (ir: StrategyIR) => AssetExecutor;
  /** 判断依赖;可传函数延迟读取(runtime 的连接可能晚于路由注册就绪) */
  judge?: MatrixJudgeDeps | (() => MatrixJudgeDeps | undefined);
  /** 缺省判断模型配置(规格没给 model_profile 时用;runtime 从 §9.52 连接表取不可变版本) */
  modelProfile?: () => FrozenModelProfile | null;
  recommendation?: (id: string) => AssetRecommendation | null;
  /** StrategyRun 预检(runtime.strategyRuns().preflight);缺省用本模块的静态 IR 预检 */
  preflight?: (strategy_id: string, version: number) => PreflightLike;
  /** 静态预检用:运行器是否配了 judge 依赖(IR 带 judge 而运行器没有 → blocker) */
  runnerHasJudge?: boolean;
  emit?: (event: string, data: unknown) => void;
  onConclusion?: (row: MatrixStudyRow, conclusion: MatrixConclusion) => void;
  onAdopted?: (row: MatrixStudyRow, adopted: (AdoptResult | CandidateAdoptResult) & { finalist_id: string }) => void;
  lease_ms?: number;
  /**
   * 重计算外包(worker_threads,见 worker-runner.ts):返回 Promise 表示这次 run / 留出评估交给别处执行,返回 null 表示就在本线程跑。
   * run 整段外包;finalize 只外包 claim 之后的留出评估(claim 事务仍在调用方线程同步完成,路由 202 看到的状态不变)。
   */
  offload?: (job: { op: 'run' | 'finalize'; id: string }, signal?: AbortSignal) => Promise<MatrixStudyRow> | null;
}

const conflict = (m: string) => Error(`matrix_study_conflict:${m}`);
const ACTIVE: MatrixStudyStatus[] = ['queued', 'running', 'finalizing'];

export class MatrixStudyService {
  readonly store: MatrixStudyStore;
  private now: () => number;
  private queue: string[] = [];
  private running: { id: string; ac: AbortController } | null = null;
  private pump: Promise<void> = Promise.resolve();
  constructor(readonly deps: MatrixServiceDeps) { this.now = deps.now ?? Date.now; this.store = new MatrixStudyStore(deps.db, this.now); }

  // ---------------------------------------------------------------- 规格 / 估算 / 创建
  private judgeDeps(): MatrixJudgeDeps | undefined { const j = this.deps.judge; return typeof j === 'function' ? j() : j; }
  private rec(id: string | null | undefined): AssetRecommendation | null { return id ? this.deps.recommendation?.(id) ?? null : null; }
  /** 「我的策略」引用解析:未归档策略的指定版本(缺省当前版本) */
  private resolveStrategy = (strategy_id: string, version: number | null): { version: number } | null => {
    const st = new StrategyStore(this.deps.db).get(strategy_id);
    if (!st || st.status === 'archived') return null;
    const v = version ?? st.current_version;
    return v && new StrategyStore(this.deps.db).versionIR(strategy_id, v) ? { version: v } : null;
  };
  /** spec.strategies → 冻结快照(IR 取该版本,之后策略再改也不影响本研究) */
  private mineOf(spec: MatrixStudySpec): MyStrategySnapshot[] {
    const store = new StrategyStore(this.deps.db);
    return (spec.strategies ?? []).map((r) => {
      const st = store.require(r.strategy_id), ir = store.versionIR(r.strategy_id, r.version);
      if (!ir) throw Error(`strategy_not_found:${r.strategy_id}@v${r.version}`);
      return { strategy_id: r.strategy_id, version: r.version, name: st.name, symbol: st.symbol, timeframe: st.timeframe, ir, ir_hash: irHash(ir) };
    });
  }
  prefill(recommendation_id: string) {
    const r = this.rec(recommendation_id); if (!r) throw Error('recommendation_not_found');
    const p = prefillFromRecommendation(r), spec = normalizeSpec({ ...p.spec }, { now: this.now(), recommendation: r, model_profile: this.deps.modelProfile?.() ?? null, resolveStrategy: this.resolveStrategy });
    return { spec, notes: p.notes, estimate: estimate(buildManifest(spec, r, this.now(), this.mineOf(spec))) };
  }
  private specOf(body: Record<string, unknown>) {
    const raw = (body.spec ?? {}) as Record<string, unknown>;
    const rid = (body.recommendation_id ?? raw.recommendation_id) as string | undefined;
    const r = rid ? this.rec(rid) : null;
    if (rid && !r) throw Error('recommendation_not_found');
    const spec = normalizeSpec({ ...raw, ...(rid ? { recommendation_id: rid } : {}) }, { now: this.now(), recommendation: r, model_profile: this.deps.modelProfile?.() ?? null, resolveStrategy: this.resolveStrategy });
    return { spec, rec: r, mine: this.mineOf(spec) };
  }
  estimate(body: Record<string, unknown>): { spec: ReturnType<typeof normalizeSpec>; estimate: MatrixEstimate; cells: { id: string; applicability: string; reason: string | null; variants: number; judge_calls: number }[] } {
    const { spec, rec, mine } = this.specOf(body), m = buildManifest(spec, rec, this.now(), mine);
    return { spec, estimate: estimate(m), cells: m.cells.map((c) => ({ id: c.id, applicability: c.applicability, reason: c.reason, variants: c.variants.length, judge_calls: cellJudgeCalls(c) })) };
  }
  create(body: Record<string, unknown>): MatrixStudyRow {
    const { spec, rec, mine } = this.specOf(body), m = buildManifest(spec, rec, this.now(), mine), est = estimate(m);
    if (!est.within_budget) throw Error(`budget_max_variants_exceeded:${est.matrix_trials}>${spec.budget.max_variants}`);
    if (!est.cells.applicable) throw Error('no_applicable_cells');
    for (const [tf, g] of Object.entries(m.segments)) {
      const cs = m.cells.filter((c) => c.timeframe === tf && c.segments), from = cs.length ? Math.min(...cs.map((c) => c.segments!.holdout.from_ms)) : g!.holdout.from_ms;
      const o = this.store.overlappingHoldouts(spec.research_program_id, `${m.data_scope_id}:${tf}`, from, g!.holdout.to_ms);
      if (o.length) throw Error(`holdout_range_already_used:${o[0]!.study_id}:${tf}`);
    }
    const key = typeof body.idempotency_key === 'string' && body.idempotency_key ? body.idempotency_key.slice(0, 200) : randomUUID();
    const row = this.store.insert({ idempotency_key: key, manifest: m, manifest_hash: manifestHash(m) });
    this.flush();
    if (row.status === 'queued') this.start(row.id);
    return row;
  }

  // ---------------------------------------------------------------- 排队与执行
  start(id: string): void { if (!this.queue.includes(id) && this.running?.id !== id) { this.queue.push(id); this.pump = this.pump.then(() => this.drain()); } }
  /** 测试 / 关停用:等队列跑空 */
  idle(): Promise<void> { return this.pump; }
  private async drain(): Promise<void> {
    while (this.queue.length) {
      const id = this.queue.shift()!, ac = new AbortController();
      this.running = { id, ac };
      try { const r = this.store.get(id); if (r?.status === 'queued') await this.run(id, ac.signal); else if (r?.status === 'finalizing') await this.finalize(id, undefined, ac.signal, true); }
      catch { /* run / finalize 自己落状态 */ }
      finally { this.running = null; this.flush(); }
    }
  }
  cancel(id: string): MatrixStudyRow {
    const row = this.store.require(id);
    if (!['queued', 'running', 'ready_to_finalize', 'finalizing'].includes(row.status)) throw conflict(row.status);
    this.queue = this.queue.filter((x) => x !== id);
    if (this.running?.id === id) this.running.ac.abort();
    try { this.deps.db.prepare('UPDATE research_call_budgets SET cancelled=1 WHERE id=?').run(judgeBudgetId(id)); } catch { /* 没有 judge 预算 */ }
    row.state.notes.push(`已取消(${row.status} 时);计数、费用与留出占用保留,可 resume`);
    const out = this.store.update(id, { status: 'cancelled', state: row.state, lease: { token: null, until: null } }, { kind: 'status' });
    this.flush(); return out;
  }
  /** 恢复:cancelled / interrupted / failed → queued(已完成的评估复用;留出已 claimed 的直接回到 finalizing) */
  resume(id: string): MatrixStudyRow {
    const row = this.store.require(id);
    if (!['cancelled', 'interrupted', 'failed'].includes(row.status)) throw conflict(row.status);
    const db = this.deps.db;
    // 旧 worker 已不在(本进程没有它 / 租约已放):未定的判断调用转 unknown、保留预留,恢复不重抽
    if (this.running?.id !== id) { try { new JudgeDecisionStore(db).interruptBudget(judgeBudgetId(id)); db.prepare('UPDATE research_call_budgets SET cancelled=0 WHERE id=?').run(judgeBudgetId(id)); } catch { /* 无预算 */ } }
    const next: MatrixStudyStatus = row.state.holdout_state === 'claimed' ? 'finalizing' : row.state.finalists.length && row.state.stage === 'sealed' ? 'ready_to_finalize' : 'queued';
    row.state.error = null; row.state.notes.push(`resume → ${next}`);
    const out = this.store.update(id, { status: next, state: row.state, expect: ['cancelled', 'interrupted', 'failed'], lease: { token: null, until: null } }, { kind: 'status' });
    this.flush();
    if (next === 'queued' || next === 'finalizing' || (next === 'ready_to_finalize' && out.manifest.spec.auto_finalize)) {
      if (next === 'ready_to_finalize') void this.finalize(id).catch(() => undefined); else this.start(id);
    }
    return out;
  }
  recover(): string[] { const ids = this.store.recover(); this.flush(); return ids; }

  private checker(row: MatrixStudyRow, signal: AbortSignal | undefined, started: number) {
    const budget = row.manifest.spec.budget, prev = row.state.run_ms;
    return {
      check: () => { if (signal?.aborted) throw Error('CANCELLED'); },
      overBudget: (): string | null => {
        if (prev + (this.now() - started) > budget.wall_clock_ms) return 'budget_wall_clock';
        if (this.store.studyTrialCount(row.id) >= budget.max_variants) return 'budget_max_variants';
        return null;
      },
    };
  }
  private usage(row: MatrixStudyRow): void {
    const b = this.deps.db.prepare('SELECT calls,spent_usd,reserved_usd FROM research_call_budgets WHERE id=?').get(judgeBudgetId(row.id)) as { calls: number; spent_usd: string; reserved_usd: string } | undefined;
    if (b) {
      const unk = this.deps.db.prepare("SELECT COUNT(*) n FROM research_call_attempts WHERE budget_id=? AND status IN ('unknown','reserved')").get(judgeBudgetId(row.id)) as { n: number };
      row.state.usage.judge_calls = Number(b.calls); row.state.usage.judge_usd = b.spent_usd; row.state.usage.judge_reserved_usd = b.reserved_usd; row.state.usage.judge_unknown_cost_calls = Number(unk.n);
    }
  }
  private judged(row: MatrixStudyRow, recs: TrialRec[]): { trials: JudgedTrial[]; variance: number } { return judgeTrials(recs, this.store.programTrialCount(row.research_program_id), row.manifest.spec.protocol); }
  private refresh(row: MatrixStudyRow, recs: TrialRec[], stop: string | null) {
    const { trials, variance } = this.judged(row, recs);
    const ledger = ledgerOf(trials, { attempt_count: this.store.attemptCount(row.id), trial_count: this.store.programTrialCount(row.research_program_id), study_trial_count: this.store.studyTrialCount(row.id) });
    row.state.ledger = ledger; row.state.sharpe_variance = variance; row.state.cells = cellResults(row.manifest, trials, stop, judgeStageMarks(row.manifest, row.state.judge_stage)); this.usage(row);
    return { trials, ledger };
  }

  /** 搜索阶段(开发视图)→ 封存 finalist 或直接给 no_candidate */
  async run(id: string, signal?: AbortSignal): Promise<MatrixStudyRow> {
    const release = claimSlot('heavy'); // 1 vCPU 保护:重计算并发上限(TG_HEAVY_CONCURRENCY)
    try {
      return await this.runInner(id, signal);
    } finally {
      release();
    }
  }
  private async runInner(id: string, signal?: AbortSignal): Promise<MatrixStudyRow> {
    const off = this.deps.offload?.({ op: 'run', id }, signal); if (off) return off;
    const lease = randomUUID(), started = this.now(), lease_ms = this.deps.lease_ms ?? 10 * 60_000;
    this.store.acquireLease(id, lease, lease_ms);
    let row = this.store.update(id, { status: 'running', stage: 'data', expect: ['queued'], lease: { token: lease, until: started + lease_ms } }, { kind: 'status' });
    row.state.started_at ??= started;
    const { check, overBudget } = this.checker(row, signal, started);
    const save = (kind: MatrixEvent['kind'] = 'progress', extra: Partial<MatrixEvent> = {}, h?: Parameters<MatrixStudyStore['update']>[3]) => {
      row.state.usage.wall_ms = row.state.run_ms + (this.now() - started);
      row = this.store.update(id, { state: row.state, lease: { token: lease, until: this.now() + lease_ms } }, { kind, extra }, h); this.flush();
    };
    try {
      // ---- data(开发视图,截断到选择段末)
      const views = new Map<string, DataView>(), lock: NonNullable<typeof row.state.data_lock> = {};
      for (const tf of Object.keys(row.manifest.segments) as MatrixTimeframe[]) {
        check();
        try { const v = await loadDevView(this.deps.db, row.manifest, tf, { ...(this.deps.loader ? { loader: this.deps.loader } : {}), ...(signal ? { signal } : {}) }); views.set(tf, v); Object.assign(lock, v.lock); row.state.notes.push(...v.notes.map((n) => `${tf}:${n}`)); }
        catch (e) { const msg = String(e instanceof Error ? e.message : e); if (/CANCELLED/.test(msg)) throw Error('CANCELLED'); row.state.notes.push(`${tf} 取数失败,该周期格子按样本不足处理:${msg.slice(0, 200)}`); }
      }
      if (row.state.data_lock) { for (const [k, v] of Object.entries(lock)) { const old = row.state.data_lock[k]; if (old && old.content_hash !== v.content_hash) throw Error(`data_drift:${k}`); } }
      else { row.state.data_lock = lock; row.state.data_lock_hash = hash(lock); }
      row.state.stage = 'matrix'; row.state.progress.note = '矩阵评估'; save();
      // ---- matrix
      const judge = judgeRuntimeFor(this.deps.db, row, this.judgeDeps(), signal);
      let done = 0;
      const ctx: SearchCtx = { store: this.store, row, views, check, overBudget, ...(this.deps.executorFor ? { executorFor: this.deps.executorFor } : {}), judge,
        onTrial: () => { done++; row.state.progress.done = done; const el = this.now() - started; row.state.progress.eta_ms = done ? Math.max(0, Math.round((el / done) * (row.state.progress.total - done))) : null; if (done % 5 === 0) save(); } };
      const recs = await runMatrix(ctx);
      let stop: string | null = recs.find((r) => r.status === 'budget_skipped')?.error ?? null;
      this.refresh(row, recs, stop);
      for (const c of Object.values(row.state.cells)) if (c.verdict !== 'ineligible') this.store.tx(() => this.store.event(this.store.require(id), 'cell', { cell: c }));
      row.state.stage = 'iterate'; row.state.progress.note = '迭代环'; save();
      // ---- iterate
      const it = await runIterate(ctx, recs, () => this.store.programTrialCount(row.research_program_id), (g) => {
        row.state.generations = [...row.state.generations.filter((x) => !(x.cell_id === g.cell_id && x.n === g.n)), g];
        save('generation', { generation: g }, { from: 'strategy_lab', to: 'strategy_lab', kind: 'result', key: `gen:${g.cell_id}:${g.n}`, summary: `第 ${g.n} 代 ${g.cell_id}:${g.change.slice(0, 120)} → ${g.promoted ? '晋升' : '未改进'}`, payload: { generation: g.n, cell_id: g.cell_id, trial_id: g.trial_id } });
      });
      stop = stop ?? it.stop;
      // ---- Jev 两段式补跑(candidates):纯代码臂搜索结束后、封存前;同一开发视图、同一 manifest 冻结的变体,试验照常记账
      const staged = row.manifest.judge_stage?.mode === 'candidates' ? await this.judgeStage(row, ctx, [...recs, ...it.added], save) : { added: [] as TrialRec[], stop: null as string | null };
      stop = stop ?? staged.stop;
      // save() 会换掉 row 对象:完成标记写在当前 row 上
      if (row.state.judge_stage && row.manifest.judge_stage) row.state.judge_stage.status = 'done';
      const all = [...recs, ...it.added, ...staged.added], { trials, ledger } = this.refresh(row, all, stop);
      for (const c of Object.values(row.state.cells)) if (c.judge_stage === 'rerun') this.store.tx(() => this.store.event(this.store.require(id), 'cell', { cell: c }));
      row.state.stop_reason = stop;
      // ---- seal
      const rec = this.rec(row.manifest.spec.recommendation_id);
      const finals = trials.filter((t) => t.verdict === 'pass' && t.dev).sort((a, b) => (b.dev!.selection.sharpe ?? -Infinity) - (a.dev!.selection.sharpe ?? -Infinity) || a.trial_id.localeCompare(b.trial_id)).slice(0, row.manifest.spec.iterate.top_k);
      row.state.finalists = finals.map((t) => this.finalistOf(row, t, rec));
      row.state.run_ms += this.now() - started;
      if (!finals.length) return this.complete(row, lease);
      row.state.finalists_hash = hash(row.state.finalists.map((f) => ({ id: f.id, ir: f.ir_hash })));
      row.state.trial_ledger_hash = ledgerHash(ledger, trials);
      row.state.stage = 'sealed'; row.state.holdout_state = 'sealed'; row.state.progress.note = `${finals.length} 个 finalist 已封存,等待留出段一次释放`;
      row = this.store.update(id, { status: 'ready_to_finalize', state: row.state, lease: { token: null, until: null } }, { kind: 'status' }, { from: 'strategy_lab', to: 'gate_captain', kind: 'review', key: 'sealed', summary: `批量验证选出 ${finals.length} 个候选,等最终验收`, payload: { finalists_hash: row.state.finalists_hash, trial_count: ledger.trial_count } });
      for (const f of row.state.finalists) this.store.tx(() => this.store.event(this.store.require(id), 'finalist', { finalist: f }));
      this.flush();
      if (row.manifest.spec.auto_finalize) return await this.finalize(id, row.manifest_hash, signal);
      return row;
    } catch (e) { return this.fail(id, e, started, lease); }
  }
  /**
   * Jev 两段式第二阶段:入选名单一次算定并写进 state(resume 复用,不因谱系试验数变化重算),再对入选格补跑 code_judge。
   * 入选:code 格 verdict ∈ pass/near,或三档(未封存口径)∈ pending/paper_candidate;排序:评分卡分数 → 档位 → 选择段夏普 → cell_id;取前 K 格。
   * 补跑变体:code_judge 格 manifest 里与代表性第 0 代 code 试验同 param 的变体(冻结在 manifest 里,不新造 IR)。
   */
  private async judgeStage(row: MatrixStudyRow, ctx: SearchCtx, recs: TrialRec[], save: (kind?: MatrixEvent['kind']) => void): Promise<{ added: TrialRec[]; stop: string | null }> {
    const rule = row.manifest.judge_stage!, st = row.state.judge_stage ??= { mode: 'candidates', max_cells: rule.max_cells, status: 'pending', eligible: 0, selected: [] };
    if (st.status === 'pending') {
      const { trials, variance } = this.judged(row, recs), marks = judgeStageMarks(row.manifest, st);
      const cells = cellResults(row.manifest, trials, null, marks);
      const best = Object.fromEntries(Object.values(cells).map((c) => [c.cell_id, c.best_trial_id]));
      const counts = { study_trials: trials.filter((t) => t.dev).length, program_trials: this.store.programTrialCount(row.research_program_id) };
      const board = tierBoard(row.manifest, [], trials, counts, variance, best, false, judgeSkipped(marks));
      const byId = new Map(row.manifest.cells.map((c) => [c.id, c])), pool: JudgeStageSelection[] = [];
      for (const jc of row.manifest.cells) {
        if (jc.arm !== 'code_judge' || jc.applicability !== 'applicable') continue;
        const codeId = codeCellIdOf(jc.id), cc = byId.get(codeId), r = cells[codeId], b = board.cells[codeId];
        if (!cc || cc.applicability !== 'applicable' || !r || !b) continue;
        const ok = r.verdict === 'pass' || r.verdict === 'near' || b.tier === 'pending' || b.tier === 'paper_candidate';
        if (!ok) continue;
        const gen0 = trials.filter((t) => t.cell_id === codeId && t.generation === 0 && t.dev);
        const rep = gen0.find((t) => t.trial_id === b.tier_trial_id) ?? [...gen0].sort(better)[0];
        if (!rep || !jc.variants.some((v) => v.param === rep.param)) continue;
        pool.push({ cell_id: jc.id, code_cell_id: codeId, code_trial_id: rep.trial_id, param: rep.param, score: b.scorecard?.score.value ?? null, tier: b.tier, verdict: r.verdict === 'ineligible' ? 'fail' : r.verdict });
      }
      const sharpe = (x: JudgeStageSelection) => cells[x.code_cell_id]?.selection?.sharpe ?? -Infinity;
      pool.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || TIER_RANK[b.tier] - TIER_RANK[a.tier] || (b.verdict === 'pass' ? 1 : 0) - (a.verdict === 'pass' ? 1 : 0) || sharpe(b) - sharpe(a) || a.cell_id.localeCompare(b.cell_id));
      st.eligible = pool.length; st.selected = pool.slice(0, rule.max_cells); st.status = 'selected';
      const planned = st.selected.reduce((a, x) => a + byId.get(x.cell_id)!.variants.filter((v) => v.param === x.param).length, 0);
      row.state.progress.total = row.state.progress.done + planned;
      row.state.progress.note = `Jev 两段式:${pool.length} 格合格,补跑前 ${st.selected.length} 格`;
      row.state.notes.push(`Jev 两段式入选 ${st.selected.length}/${pool.length} 格(K=${rule.max_cells}):${st.selected.map((x) => x.code_cell_id).join(', ').slice(0, 600)}`);
      save();
    }
    const added: TrialRec[] = [];
    let stop: string | null = null;
    for (const x of st.selected) {
      const cell = row.manifest.cells.find((c) => c.id === x.cell_id)!;
      const recsOfCell = await evalCellVariants(ctx, cell, cell.variants.filter((v) => v.param === x.param));
      added.push(...recsOfCell);
      const skipped = recsOfCell.find((r) => r.status === 'budget_skipped');
      if (skipped) { stop = skipped.error; break; }
    }
    return { added, stop };
  }
  private finalistOf(row: MatrixStudyRow, t: JudgedTrial, rec: AssetRecommendation | null): MatrixFinalist {
    const cell = row.manifest.cells.find((c) => c.id === t.cell_id)!, horizon = HORIZON_OF[cell.timeframe];
    const recRow = rec?.rows.find((r) => r.symbol === cell.symbol);
    const source: MatrixSource = { recommendation_id: row.manifest.spec.recommendation_id, radar_tier: recRow ? ({ short: 'short', mid: 'swing', long: 'weekly' } as const)[horizon] : null, universe_scan_at: rec?.source.universe_scan_at ?? null };
    return { id: t.trial_id, trial_id: t.trial_id, cell_id: t.cell_id, arm: cell.arm, symbol: cell.symbol, timeframe: cell.timeframe, family: cell.family, side: cell.side, ir: t.ir, ir_hash: t.ir_hash, selection: t.dev!.selection, dsr: t.dsr, holdout: null, holdout_gross: null, test: null, passed: null, cause: null, horizon, source, portfolio: null, judge: t.dev!.judge };
  }
  private complete(row: MatrixStudyRow, lease: string | null): MatrixStudyRow {
    // v2:结论补「候补 N 组」(三档按 completed 状态算:finalist 的最终验收结果已定)
    const board = this.safeBoard({ ...row, status: 'completed' }, false);
    const conclusion = this.withStage(row, conclusionOf(row.manifest, row.state.cells, row.state.finalists, board ?? undefined));
    row.state.conclusion = conclusion; row.state.stage = 'done'; row.state.progress.note = conclusion.text.slice(0, 200);
    const out = this.store.update(row.id, { status: 'completed', state: row.state, lease: { token: null, until: null } }, { kind: 'conclusion', extra: { conclusion } }, { from: 'strategy_lab', to: 'gate_captain', kind: 'result', key: 'complete', summary: conclusion.text.slice(0, 400), payload: { kind: conclusion.kind, finalist_ids: conclusion.finalist_ids, causes: conclusion.causes, paper_candidates: conclusion.paper_candidates ?? 0, paper_candidate_trial_ids: conclusion.paper_candidate_trial_ids ?? [] } });
    void lease; this.flush();
    try { this.deps.onConclusion?.(out, conclusion); } catch { /* 回调失败不影响研究结果 */ }
    return out;
  }
  private withStage(row: MatrixStudyRow, c: MatrixConclusion): MatrixConclusion {
    if (c.judge_stage && row.state.judge_stage) c.judge_stage = { ...c.judge_stage, eligible: row.state.judge_stage.eligible };
    return c;
  }
  private fail(id: string, e: unknown, started: number, _lease: string | null): MatrixStudyRow {
    const msg = e instanceof Error ? e.message : String(e), row = this.store.require(id);
    row.state.run_ms += this.now() - started;
    if (/CANCELLED/.test(msg)) {
      if (row.status === 'cancelled') { this.store.update(id, { state: row.state }); this.flush(); return this.store.require(id); }
      return this.store.update(id, { status: 'cancelled', state: row.state, lease: { token: null, until: null } }, { kind: 'status' });
    }
    row.state.error = msg.slice(0, 1000);
    const out = this.store.update(id, { status: 'failed', state: row.state, lease: { token: null, until: null } }, { kind: 'status' }, { from: 'strategy_lab', to: 'gate_captain', kind: 'blocked', key: `failed:${row.state.run_ms}`, summary: `批量验证失败:${msg.slice(0, 200)}` });
    this.flush(); return out;
  }

  // ---------------------------------------------------------------- 留出段:一次释放全部 finalist
  private finalizing = new Set<string>();
  /** resume=true 只给恢复路径(留出已 claimed、上一个 worker 已不在);其余调用遇到已 claimed 一律拒绝 */
  async finalize(id: string, expected_manifest_hash?: string, signal?: AbortSignal, resume = false): Promise<MatrixStudyRow> {
    if (this.finalizing.has(id)) throw Error('holdout_already_claimed');
    this.finalizing.add(id);
    try { return await this.finalizeOnce(id, expected_manifest_hash, signal, resume); } finally { this.finalizing.delete(id); }
  }
  private async finalizeOnce(id: string, expected_manifest_hash: string | undefined, signal: AbortSignal | undefined, resume: boolean): Promise<MatrixStudyRow> {
    const started = this.now();
    let row = this.store.require(id);
    if (expected_manifest_hash !== undefined && expected_manifest_hash !== row.manifest_hash) throw Error('manifest_hash_mismatch');
    if (row.status === 'ready_to_finalize') {
      row = this.store.tx(() => {
        const cur = this.store.require(id);
        if (cur.status !== 'ready_to_finalize' || cur.state.holdout_state !== 'sealed' || this.store.release(id)) throw Error('holdout_already_claimed');
        const tfs = [...new Set(cur.state.finalists.map((f) => f.timeframe))];
        const hw = (tf: MatrixTimeframe) => { const ws = cur.state.finalists.filter((f) => f.timeframe === tf).map((f) => cur.manifest.cells.find((c) => c.id === f.cell_id)!.segments!.holdout); return { from_ms: Math.min(...ws.map((w) => w.from_ms)), to_ms: Math.max(...ws.map((w) => w.to_ms)) }; };
        const segs = tfs.map((tf) => ({ holdout: hw(tf) }));
        for (const tf of tfs) { const g = { holdout: hw(tf) }, o = this.store.overlappingHoldouts(cur.research_program_id, `${cur.manifest.data_scope_id}:${tf}`, g.holdout.from_ms, g.holdout.to_ms, id); if (o.length) throw Error(`holdout_range_already_used:${o[0]!.study_id}:${tf}`); }
        this.store.insertRelease({ study_id: id, program: cur.research_program_id, data_scope_id: cur.manifest.data_scope_id, from_ms: Math.min(...segs.map((g) => g.holdout.from_ms)), to_ms: Math.max(...segs.map((g) => g.holdout.to_ms)), finalists_hash: cur.state.finalists_hash!, protocol_hash: cur.protocol_hash, trial_ledger_hash: cur.state.trial_ledger_hash!, model_revision: cur.manifest.spec.model_profile?.model_revision ?? 'none', data_manifest_hash: cur.state.data_lock_hash ?? 'none', capability_hash: hash({ study: id, nonce: randomUUID() }) });
        for (const tf of tfs) { const w = hw(tf); this.store.exposure(id, cur.manifest, `${cur.manifest.data_scope_id}:${tf}`, w.from_ms, w.to_ms, 'holdout'); }
        cur.state.holdout_state = 'claimed'; cur.state.stage = 'holdout'; cur.state.progress.note = '留出段一次释放中';
        return this.store.update(id, { status: 'finalizing', state: cur.state }, { kind: 'status' });
      });
      this.flush();
    } else if (row.status === 'finalizing' && row.state.holdout_state === 'claimed') { if (!resume) throw Error('holdout_already_claimed'); } else throw conflict(row.status);
    const off = this.deps.offload?.({ op: 'finalize', id }, signal); if (off) return off;
    try {
      const s = row.manifest.spec, check = () => { if (signal?.aborted) throw Error('CANCELLED'); };
      const judge = judgeRuntimeFor(this.deps.db, row, this.judgeDeps(), signal), views = new Map<string, DataView>();
      for (const f of row.state.finalists) {
        check();
        const cell = row.manifest.cells.find((c) => c.id === f.cell_id)!, g = cell.segments!;
        try {
          if (!views.has(f.timeframe)) views.set(f.timeframe, await loadHoldoutView(this.deps.db, row, f.timeframe, { ...(this.deps.loader ? { loader: this.deps.loader } : {}), ...(signal ? { signal } : {}) }));
          const t = this.store.trials(id).find((x) => x.trial_id === f.trial_id)!, v = (t.candidate.variant as MatrixVariantRef);
          if (f.ir.judge && !judge) throw Error('judge_runtime_unavailable');
          const ev = await evaluateHoldout(views.get(f.timeframe)!.data, g, f.symbol, v, s.market, { check, ...(this.deps.executorFor ? { executorFor: this.deps.executorFor } : {}), judge, portfolio: { risk_pct: s.portfolio.risk_pct / 100, max_open: s.portfolio.max_open } });
          for (const c of ev.candidates) if (c.decision) this.store.putCandidate(id, f.trial_id, 'holdout', c.candidate.id, c.candidate, c.decision);
          f.holdout = ev.score; f.holdout_gross = ev.gross; f.test = holdoutTest(ev.returns, s.protocol); f.portfolio = ev.portfolio; f.judge = ev.judge ?? f.judge; void cell;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/CANCELLED/.test(msg)) throw e;
          f.holdout = null; f.test = null; f.passed = false; f.cause = /DATA_MISSING|data_missing|too_short/.test(msg) ? 'insufficient_evidence' : 'unsupported_execution';
          row.state.notes.push(`finalist ${f.id} 留出段评估失败:${msg.slice(0, 200)}`);
        }
      }
      // Holm:K 个 finalist 同时查看,一次校正
      const H = holm(row.state.finalists.map((f) => f.test?.p_value ?? null), s.protocol.alpha);
      row.state.finalists.forEach((f, i) => {
        if (!f.test || !f.holdout) return;
        f.test.holm_threshold = H[i]!.threshold; f.test.rejected = H[i]!.rejected;
        const h = f.holdout, beats = h.exposure_matched_hold !== null && h.total_return - h.exposure_matched_hold >= s.protocol.min_effect && h.total_return > h.exposure_matched_hold;
        const enough = h.trades >= s.protocol.min_trades && f.test.p_value !== null;
        f.passed = enough && f.test.rejected && h.total_return > 0 && (h.stressed_return ?? -1) > 0 && beats && h.max_drawdown <= s.protocol.max_drawdown;
        f.cause = f.passed ? null : (!enough ? 'insufficient_evidence' : (h.total_return <= 0 || (h.stressed_return ?? -1) <= 0) && (f.holdout_gross ?? 0) > 0 ? 'cost_dominated' : 'underperform_hold') as FailureCause;
        // 复审 High-2:留出段判断大面积出错 → 不能凭少数跟单通过(与开发段 judgeTrials 同一阈值)
        const j = f.judge, er = j && j.candidates ? (j.error + j.uncertain) / j.candidates : null;
        if (er !== null && er > JUDGE_ERROR_MAX) { f.passed = false; f.cause = 'unsupported_execution'; }
      });
      row.state.run_ms += this.now() - started; this.usage(row);
      const result = { finalists: row.state.finalists.map((f) => ({ id: f.id, holdout: f.holdout, test: f.test, passed: f.passed, cause: f.cause, portfolio: f.portfolio })) };
      row = this.store.tx(() => { this.store.completeRelease(id, result); const cur = this.store.require(id); cur.state = { ...row.state, holdout_state: 'released' }; for (const f of cur.state.finalists) this.store.event(cur, 'finalist', { finalist: f }); return cur; });
      return this.complete(row, null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e), cur = this.store.require(id);
      cur.state.run_ms += this.now() - started;
      if (/CANCELLED/.test(msg)) { if (cur.status !== 'cancelled') return this.store.update(id, { status: 'cancelled', state: cur.state }, { kind: 'status' }); return cur; }
      cur.state.error = msg.slice(0, 1000);
      const out = this.store.update(id, { status: 'failed', state: cur.state }, { kind: 'status' }); this.flush(); return out;
    }
  }

  // ---------------------------------------------------------------- adopt:通过的 finalist → ResearchStrategy(先过运行器预检)
  adopt(id: string, finalist_id: string, name?: string): AdoptResult {
    const row = this.store.require(id);
    if (row.status !== 'completed') throw conflict(row.status);
    const f = row.state.finalists.find((x) => x.id === finalist_id);
    if (!f) throw Error('finalist_not_found');
    if (f.passed !== true) throw Error('finalist_not_passed');
    const prior = this.store.adoption(id, finalist_id);
    if (prior) return { ...prior, preflight: { deployable: true, warnings: [] }, horizon: f.horizon, source: f.source };
    const H = { short: '短线', mid: '中线', long: '长线' }[f.horizon];
    const h = f.holdout!;
    const description = `[矩阵研究 ${id} · horizon=${f.horizon}(${H} ${f.timeframe}) · ${f.family}/${f.side}/${f.arm} · 来源:${srcText(f.source)}] 留出段 ${(h.total_return * 100).toFixed(1)}%(同敞口持有 ${h.exposure_matched_hold === null ? '—' : (h.exposure_matched_hold * 100).toFixed(1) + '%'},${h.trades} 笔,Holm p=${f.test?.p_value?.toFixed(4) ?? '—'});账户级回放 ${f.portfolio ? (f.portfolio.total_return * 100).toFixed(1) + '%' : '—'};证据口径 ${row.manifest.spec.protocol.evidence_mode}`;
    const result = this.saveStrategy(row, {
      key: finalist_id, kind: 'finalist', symbol: f.symbol, timeframe: f.timeframe, family: f.family, side: f.side, arm: f.arm, ir: f.ir, horizon: f.horizon, source: f.source, description, name,
      summary: (st) => st.base ? `批量验证 finalist ${f.symbol} ${f.timeframe} 已存为「${st.name}」v${st.version}(基于 v${st.base}),可设为当前策略` : `批量验证 finalist ${f.symbol} ${f.timeframe} ${f.family} 已存为策略 ${st.strategy_id} v${st.version},可设为当前策略`,
      payload: { finalist_id },
    });
    try { this.deps.onAdopted?.(this.store.require(id), { ...result, finalist_id }); } catch { /* 回调失败不影响 adopt */ }
    return result;
  }

  /**
   * 批量验证 v2「存为候补策略」:tier=paper_candidate 或 verdict=near 的试验 → 我的策略(新策略,或「我的策略」行的新版本)。
   * 与 adopt 同一条保存路径(同 IR 不重复建版本、先过运行器预检、handoff + outbox);描述前缀「[批量验证候补 … · 未经最终验收」,
   * adoption 记录键 `candidate:<trial_id>`(据此可判断未经最终验收)。不自动启动运行。
   */
  adoptCandidate(id: string, trial_id: string, name?: string): CandidateAdoptResult {
    const row = this.store.require(id);
    if (row.status !== 'completed') throw conflict(row.status);
    const b = this.board(row), tt = b.trials.get(trial_id);
    if (!tt) throw Error('trial_not_found');
    if (row.state.finalists.some((f) => f.trial_id === trial_id)) throw Error('candidate_is_finalist:use_adopt');
    const cell = row.manifest.cells.find((c) => c.id === this.store.trials(id).find((t) => t.trial_id === trial_id)?.cell_id);
    if (!cell) throw Error('trial_not_found');
    if (row.state.finalists.some((f) => f.cell_id === cell.id && f.passed === false)) throw Error('candidate_not_allowed:cell_failed_final_validation');
    if (tt.tier !== 'paper_candidate' && tt.verdict !== 'near') throw Error(`candidate_not_allowed:${tt.tier}`);
    const key = candidateKey(trial_id), card = tt.scorecard!;
    const horizon = HORIZON_OF[cell.timeframe], rec = this.rec(row.manifest.spec.recommendation_id), recRow = rec?.rows.find((r) => r.symbol === cell.symbol);
    const source: MatrixSource = { recommendation_id: row.manifest.spec.recommendation_id, radar_tier: recRow ? ({ short: 'short', mid: 'swing', long: 'weekly' } as const)[horizon] : null, universe_scan_at: rec?.source.universe_scan_at ?? null };
    const prior = this.store.adoption(id, key);
    const extra = { kind: 'paper_candidate' as const, final_validation: false as const, trial_id, tier: tt.tier, scorecard: { value: card.score.value, label: card.score.label, luck: card.luck.text } };
    if (prior) return { ...prior, preflight: { deployable: true, warnings: [] }, horizon, source, ...extra, next: nextOf(prior.strategy_id) };
    const ir = this.trialIR(row, trial_id);
    const H = { short: '短线', mid: '中线', long: '长线' }[horizon], m = card.metrics;
    const description = `[批量验证候补 ${id} · 未经最终验收 · horizon=${horizon}(${H} ${cell.timeframe}) · ${cell.family}/${cell.side}/${cell.arm} · 来源:${srcText(source)}] 选择段 ${(m.total_return * 100).toFixed(1)}%(同敞口持有 ${m.exposure_matched_hold === null ? '—' : (m.exposure_matched_hold * 100).toFixed(1) + '%'},${m.trades} 笔,最大回撤 ${(m.max_drawdown * 100).toFixed(1)}%);评分 ${card.score.value}(${card.score.label});${card.luck.text};档位 ${tt.tier}(${tt.reasons.join(';')});证据口径 ${row.manifest.spec.protocol.evidence_mode};没做最终验收,只建议先用模拟盘跑前向`;
    const result = this.saveStrategy(row, {
      key, kind: 'paper_candidate', symbol: cell.symbol, timeframe: cell.timeframe, family: cell.family, side: cell.side, arm: cell.arm, ir, horizon, source, description, name,
      summary: (st) => `批量验证候补(未经最终验收)${cell.symbol} ${cell.timeframe} ${cell.family} 已存为${st.base ? `「${st.name}」v${st.version}(基于 v${st.base})` : `策略 ${st.strategy_id} v${st.version}`},建议先用模拟盘跑`,
      payload: { trial_id, kind: 'paper_candidate', final_validation: false, score: card.score.value, score_label: card.score.label },
    });
    const out: CandidateAdoptResult = { ...result, ...extra, next: nextOf(result.strategy_id) };
    try { this.deps.onAdopted?.(this.store.require(id), { ...out, finalist_id: key }); } catch { /* 回调失败不影响 adopt */ }
    return out;
  }
  /** 试验的 IR(开发视图登记时冻结的变体 IR;不含任何留出信息) */
  private trialIR(row: MatrixStudyRow, trial_id: string): StrategyIR {
    const t = this.store.trials(row.id).find((x) => x.trial_id === trial_id), v = t?.candidate.variant as MatrixVariantRef | undefined;
    if (!v?.ir) throw Error('trial_ir_missing');
    return v.ir;
  }

  /** adopt / adoptCandidate 共用:我的策略行 → 该策略新版本;否则新建策略。预检不过整笔回滚 */
  private saveStrategy(row: MatrixStudyRow, a: { key: string; kind: 'finalist' | 'paper_candidate'; symbol: string; timeframe: MatrixTimeframe; family: string; side: string; arm: string; ir: StrategyIR; horizon: MatrixFinalist['horizon']; source: MatrixSource; description: string; name?: string | undefined; summary: (st: { strategy_id: string; version: number; name: string; base: number | null }) => string; payload: Record<string, unknown> }): AdoptResult {
    const id = row.id, svc = new StrategyService(new StrategyStore(this.deps.db), new ResearchStore(this.deps.db), null as unknown as ResearchService);
    const H = { short: '短线', mid: '中线', long: '长线' }[a.horizon];
    let result: AdoptResult | null = null;
    const finish = (strategy_id: string, version: number, pf: PreflightLike, name: string, base: number | null) => {
      if (!pf.deployable) throw Error(`adopt_preflight_blocked:${pf.blockers.map((b) => `${b.code}(${b.message})`).join(';').slice(0, 600)}`);
      this.store.insertAdoption(id, a.key, strategy_id, version);
      result = { strategy_id, version, preflight: { deployable: true, warnings: pf.warnings }, horizon: a.horizon, source: a.source };
      const cur = this.store.require(id);
      this.store.handoff(cur, { from: 'gate_captain', to: 'thread_manager', kind: 'request', key: `adopt:${a.key}`, summary: a.summary({ strategy_id, version, name, base }), payload: { ...a.payload, strategy_id, version, ...(base ? { base_version: base } : {}), horizon: a.horizon, source: a.source } });
      this.store.event(cur, 'adopted', { adopted: { finalist_id: a.key, strategy_id, version, ...(a.kind === 'paper_candidate' ? { kind: a.kind, trial_id: String(a.payload.trial_id) } : {}) } });
    };
    const pre = (sid: string, v: number) => (this.deps.preflight ? this.deps.preflight(sid, v) : staticPreflight(svc, sid, v, a.ir, !!this.deps.runnerHasJudge));
    // 我的策略行:adopt 出来的是该策略的新版本(同 IR 不重复建版本),不是新策略;登记的资产 / 周期跟到这一版
    const snap = isMyFamily(a.family) ? (row.manifest.my_strategies ?? []).find((m) => `my:${m.strategy_id}@v${m.version}` === a.family) ?? null : null;
    if (isMyFamily(a.family) && !snap) throw Error('my_strategy_snapshot_missing');
    if (snap) {
      this.store.tx(() => {
        const st = svc.store.require(snap.strategy_id);
        if (st.status === 'archived') throw Error('strategy_archived_conflict');
        const moved = [st.symbol !== a.symbol ? `资产 ${st.symbol}→${a.symbol}` : null, st.timeframe !== a.timeframe ? `周期 ${st.timeframe}→${a.timeframe}` : null].filter(Boolean).join(',');
        svc.addVersion(snap.strategy_id, { strategy_ir: a.ir, note: `${a.description}(基于 v${snap.version}${moved ? `;${moved}` : ''})`.slice(0, 4000) });
        const version = svc.store.versionByHash(snap.strategy_id, irHash(a.ir));
        if (!version) throw Error('adopt_version_missing');
        if (moved) { svc.store.update(snap.strategy_id, { symbol: a.symbol, timeframe: a.timeframe }); svc.store.event(snap.strategy_id, 'version_added', { version, note: `矩阵研究 ${id} ${a.kind === 'paper_candidate' ? '存候补' : 'adopt'}:${moved}` }); }
        finish(snap.strategy_id, version, pre(snap.strategy_id, version), snap.name, snap.version);
      });
    } else {
      this.store.tx(() => {
        const s = svc.create({ name: (a.name?.trim() || `${a.symbol.replace(/USDT$/, '')} ${H}${a.timeframe} ${a.family}${a.arm === 'code_judge' ? '+判断' : ''}${a.kind === 'paper_candidate' ? ' 候补' : ''}`).slice(0, 120), description: a.description.slice(0, 4000), symbol: a.symbol, timeframe: a.timeframe, strategy_ir: a.ir });
        const version = svc.store.require(s.id).current_version;
        if (!version) throw Error('adopt_version_missing');
        finish(s.id, version, pre(s.id, version), s.name, null);
      });
    }
    this.flush();
    return result!;
  }

  // ---------------------------------------------------------------- v2 三档 / 评分卡(读视图重算,只读开发视图评估)
  private boards = new Map<string, TierBoard>();
  /** 从库里重建本 Study 的判定试验:试验登记 + 已完成的开发视图评估(segment='dev');留出段评估不在这张表的 dev 行里 */
  private judgedFromStore(row: MatrixStudyRow): { trials: JudgedTrial[]; variance: number } {
    const devs = this.store.devResults(row.id);
    const recs: TrialRec[] = this.store.trials(row.id).map((t) => {
      const v = t.candidate.variant as MatrixVariantRef | undefined, dev = devs.get(t.trial_id) ?? null;
      return { trial_id: t.trial_id, cell_id: t.cell_id, variant_id: t.variant_id, param: v?.param ?? t.variant_id, parent_trial_id: t.parent_trial_id, generation: t.generation, config_hash: t.config_hash, ir_hash: t.ir_hash, ir: (v?.ir ?? null) as StrategyIR, ...(v?.vol_target ? { vol_target: v.vol_target } : {}), dev, error: dev ? null : t.status, status: dev ? 'evaluated' : 'failed' };
    });
    return judgeTrials(recs, row.state.ledger?.trial_count ?? this.store.programTrialCount(row.research_program_id), row.manifest.spec.protocol);
  }
  /** 三档 + 评分卡(按 study id + updated_at 缓存) */
  board(row: MatrixStudyRow, useCache = true): TierBoard {
    const key = `${row.id}:${row.updated_at}:${row.status}`, hit = useCache ? this.boards.get(key) : undefined;
    if (hit) return hit;
    const { trials, variance } = this.judgedFromStore(row), vis = trials.filter((t) => t.dev).length;
    const counts = { study_trials: row.state.ledger?.study_trial_count ?? vis, program_trials: row.state.ledger?.trial_count ?? this.store.programTrialCount(row.research_program_id) };
    const best = Object.fromEntries(Object.values(row.state.cells).map((c) => [c.cell_id, c.best_trial_id]));
    const sealed = row.state.finalists_hash !== null || ['completed', 'ready_to_finalize', 'finalizing'].includes(row.status);
    const b = tierBoard(row.manifest, row.state.finalists, trials, counts, row.state.sharpe_variance ?? variance, best, sealed, judgeSkipped(judgeStageMarks(row.manifest, row.state.judge_stage)));
    if (useCache) { if (this.boards.size > 64) this.boards.delete(this.boards.keys().next().value!); this.boards.set(key, b); }
    return b;
  }
  private safeBoard(row: MatrixStudyRow, useCache = true): TierBoard | null { try { return this.board(row, useCache); } catch { return null; } }
  /** 某个试验的明细(给「在研究台继续打磨」带 IR;只含训练 / 选择段) */
  trialDetail(id: string, trial_id: string) {
    const row = this.store.require(id), b = this.board(row), tt = b.trials.get(trial_id);
    const t = this.store.trials(id).find((x) => x.trial_id === trial_id);
    if (!tt || !t) throw Error('trial_not_found');
    const cell = row.manifest.cells.find((c) => c.id === t.cell_id)!, snap = isMyFamily(cell.family) ? (row.manifest.my_strategies ?? []).find((m) => `my:${m.strategy_id}@v${m.version}` === cell.family) ?? null : null;
    return { study_id: id, trial_id, cell: { id: cell.id, symbol: cell.symbol, timeframe: cell.timeframe, horizon: HORIZON_OF[cell.timeframe], family: cell.family, family_name: snap ? `${snap.name} v${snap.version}` : null, side: cell.side, arm: cell.arm, market: row.manifest.spec.market }, ir: this.trialIR(row, trial_id), tier: tt.tier, reasons: tt.reasons, verdict: tt.verdict, scorecard: tt.scorecard, adopted: this.store.adoption(id, candidateKey(trial_id)) };
  }

  // ---------------------------------------------------------------- 读视图与事件
  view(row: MatrixStudyRow, detail = true) {
    const s = row.state, b = this.safeBoard(row);
    // v2:结论按三档重算(旧研究也能看到候补);kind 与 v1 同一规则,不变
    const conclusion = s.conclusion ? (b ? { ...this.withStage(row, conclusionOf(row.manifest, s.cells, s.finalists, b)), kind: s.conclusion.kind } : s.conclusion) : null;
    const base = { id: row.id, status: row.status, stage: row.stage, research_program_id: row.research_program_id, manifest_hash: row.manifest_hash, protocol_hash: row.protocol_hash, created_at: row.created_at, updated_at: row.updated_at, progress: s.progress, holdout_state: s.holdout_state, conclusion, usage: s.usage, ledger: s.ledger, judge_stage: s.judge_stage ?? null, stop_reason: s.stop_reason, error: s.error, origin: row.manifest.spec.origin, spec: row.manifest.spec, my_strategies: (row.manifest.my_strategies ?? []).map((m) => ({ strategy_id: m.strategy_id, version: m.version, name: m.name, symbol: m.symbol, timeframe: m.timeframe })) };
    if (!detail) return { ...base, finalists: s.finalists.map((f) => ({ id: f.id, symbol: f.symbol, timeframe: f.timeframe, family: f.family, arm: f.arm, passed: f.passed, horizon: f.horizon })) };
    const adoptionRows = this.deps.db.prepare('SELECT finalist_id,strategy_id,version FROM research_matrix_adoptions WHERE study_id=?').all(row.id) as { finalist_id: string; strategy_id: string; version: number }[];
    return { ...base, segments: row.manifest.segments, cells: row.manifest.cells.map((c) => ({ id: c.id, symbol: c.symbol, timeframe: c.timeframe, horizon: HORIZON_OF[c.timeframe], family: c.family, side: c.side, arm: c.arm, applicability: c.applicability, reason: c.reason, variants: c.variants.length, result: s.cells[c.id] ? { ...s.cells[c.id]!, ...(b?.cells[c.id] ?? {}) } : null })), generations: s.generations, finalists: s.finalists, notes: s.notes.slice(-50), release: this.store.release(row.id) ? { status: this.store.release(row.id)!.status, released_at: this.store.release(row.id)!.released_at } : null, adoptions: s.finalists.map((f) => ({ finalist_id: f.id, adopted: this.store.adoption(row.id, f.id) })).filter((x) => x.adopted),
      candidate_adoptions: adoptionRows.filter((a) => a.finalist_id.startsWith(CANDIDATE_KEY)).map((a) => ({ trial_id: a.finalist_id.slice(CANDIDATE_KEY.length), adopted: { strategy_id: a.strategy_id, version: Number(a.version) } })) };
  }
  get(id: string) { return this.view(this.store.require(id)); }
  list(limit = 50) { return { items: this.store.list(limit).map((r) => this.view(r, false)) }; }
  events(id: string, after = 0) { this.store.require(id); return { items: this.store.events(id, after) }; }
  /** outbox → SSE(至少一次;消费方按 seq 幂等) */
  flush(): void {
    if (!this.deps.emit) return;
    const evs = this.store.undelivered(500);
    for (const e of evs) this.deps.emit(MATRIX_EVENT, e);
    this.store.markDelivered(evs.map((e) => e.seq));
  }
  isActive(id: string): boolean { return this.running?.id === id || this.queue.includes(id) || ACTIVE.includes(this.store.require(id).status); }
}

/** 静态 IR 预检(与 StrategyRunner.preflight 的 IR 相关 blocker 同口径;runtime 注入真预检时不用它) */
export function staticPreflight(svc: StrategyService, strategy_id: string, version: number, ir: StrategyIR, runnerHasJudge: boolean): PreflightLike {
  const blockers: PreflightLike['blockers'] = [], warnings: PreflightLike['warnings'] = [];
  const s = svc.store.require(strategy_id);
  try { const b = svc.binding(strategy_id, String(version)); for (const u of b.unmapped) (u.severity === 'block' && !['direction_not_long', 'universe_screen', 'v0_limit_entry', 'v0_multi_target'].includes(u.code) ? blockers : warnings).push({ code: u.code, message: u.message }); } catch (e) { blockers.push({ code: 'binding_failed', message: String(e instanceof Error ? e.message : e).slice(0, 200) }); }
  if (ir.judge && !runnerHasJudge) blockers.push({ code: 'judge_runtime_missing', message: '该策略需要钉住模型与判断账本,运行器没有配置 judge 依赖' });
  if (['1m', '3m', '5m'].includes(s.timeframe)) blockers.push({ code: 'horizon_scalp', message: '运行器不支持 1m/3m/5m' });
  if (ir.order?.market === 'spot' && ir.order.direction !== 'long') blockers.push({ code: 'direction_not_long', message: '现货只能做多' });
  if (ir.entry.primitive !== 'next_open_market') blockers.push({ code: 'entry_unsupported', message: '入场规则运行器还不能执行' });
  if (ir.exit.some((x) => ['chandelier_trail', 'breakeven_after_r', 'swing_structure_stop'].includes(x.primitive))) warnings.push({ code: 'trailing_not_connected', message: '追踪 / 保本改止损尚未接入运行器' });
  return { deployable: blockers.length === 0, blockers, warnings };
}
export type { MatrixJudgeDeps };
