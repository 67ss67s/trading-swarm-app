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
import type { StrategyIR } from '@trading-swarm/contracts';
import type { AssetExecutor, BarsLoader } from '../backtest-report.js';
import { hash } from '../primitives.js';
import { ResearchStore } from '../store.js';
import { StrategyStore } from '../strategies/store.js';
import { StrategyService } from '../strategies/service.js';
import type { ResearchService } from '../service.js';
import { JudgeDecisionStore } from '../judge/index.js';
import type { AssetRecommendation } from '../../recommend.js';
import type { FrozenModelProfile } from '../judge/types.js';
import { cellResults, conclusionOf, judgeTrials, JUDGE_ERROR_MAX, ledgerHash, ledgerOf, type JudgedTrial, type TrialRec } from './compute.js';
import { evaluateHoldout, judgeBudgetId, judgeRuntimeFor, loadDevView, loadHoldoutView, type DataView, type MatrixJudgeDeps } from './evaluate.js';
import { buildManifest, estimate, manifestHash, type MatrixEstimate } from './manifest.js';
import { runIterate, runMatrix, type SearchCtx } from './search.js';
import { normalizeSpec, prefillFromRecommendation } from './spec.js';
import { holdoutTest, holm } from './stats.js';
import { MatrixStudyStore } from './store.js';
import { HORIZON_OF, MATRIX_EVENT, type FailureCause, type MatrixConclusion, type MatrixEvent, type MatrixFinalist, type MatrixSource, type MatrixStudyRow, type MatrixStudyStatus, type MatrixTimeframe, type MatrixVariantRef } from './types.js';

export interface PreflightLike { deployable: boolean; blockers: { code: string; message: string }[]; warnings: { code: string; message: string }[] }
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
  onAdopted?: (row: MatrixStudyRow, adopted: AdoptResult & { finalist_id: string }) => void;
  lease_ms?: number;
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
  prefill(recommendation_id: string) {
    const r = this.rec(recommendation_id); if (!r) throw Error('recommendation_not_found');
    const p = prefillFromRecommendation(r), spec = normalizeSpec({ ...p.spec }, { now: this.now(), recommendation: r, model_profile: this.deps.modelProfile?.() ?? null });
    return { spec, notes: p.notes, estimate: estimate(buildManifest(spec, r, this.now())) };
  }
  private specOf(body: Record<string, unknown>) {
    const raw = (body.spec ?? {}) as Record<string, unknown>;
    const rid = (body.recommendation_id ?? raw.recommendation_id) as string | undefined;
    const r = rid ? this.rec(rid) : null;
    if (rid && !r) throw Error('recommendation_not_found');
    const spec = normalizeSpec({ ...raw, ...(rid ? { recommendation_id: rid } : {}) }, { now: this.now(), recommendation: r, model_profile: this.deps.modelProfile?.() ?? null });
    return { spec, rec: r };
  }
  estimate(body: Record<string, unknown>): { spec: ReturnType<typeof normalizeSpec>; estimate: MatrixEstimate; cells: { id: string; applicability: string; reason: string | null; variants: number }[] } {
    const { spec, rec } = this.specOf(body), m = buildManifest(spec, rec, this.now());
    return { spec, estimate: estimate(m), cells: m.cells.map((c) => ({ id: c.id, applicability: c.applicability, reason: c.reason, variants: c.variants.length })) };
  }
  create(body: Record<string, unknown>): MatrixStudyRow {
    const { spec, rec } = this.specOf(body), m = buildManifest(spec, rec, this.now()), est = estimate(m);
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
    row.state.ledger = ledger; row.state.sharpe_variance = variance; row.state.cells = cellResults(row.manifest, trials, stop); this.usage(row);
    return { trials, ledger };
  }

  /** 搜索阶段(开发视图)→ 封存 finalist 或直接给 no_candidate */
  async run(id: string, signal?: AbortSignal): Promise<MatrixStudyRow> {
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
      const all = [...recs, ...it.added], { trials, ledger } = this.refresh(row, all, stop);
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
      row = this.store.update(id, { status: 'ready_to_finalize', state: row.state, lease: { token: null, until: null } }, { kind: 'status' }, { from: 'strategy_lab', to: 'gate_captain', kind: 'review', key: 'sealed', summary: `矩阵研究封存 ${finals.length} 个 finalist,待一次释放留出段`, payload: { finalists_hash: row.state.finalists_hash, trial_count: ledger.trial_count } });
      for (const f of row.state.finalists) this.store.tx(() => this.store.event(this.store.require(id), 'finalist', { finalist: f }));
      this.flush();
      if (row.manifest.spec.auto_finalize) return await this.finalize(id, row.manifest_hash, signal);
      return row;
    } catch (e) { return this.fail(id, e, started, lease); }
  }
  private finalistOf(row: MatrixStudyRow, t: JudgedTrial, rec: AssetRecommendation | null): MatrixFinalist {
    const cell = row.manifest.cells.find((c) => c.id === t.cell_id)!, horizon = HORIZON_OF[cell.timeframe];
    const recRow = rec?.rows.find((r) => r.symbol === cell.symbol);
    const source: MatrixSource = { recommendation_id: row.manifest.spec.recommendation_id, radar_tier: recRow ? ({ short: 'short', mid: 'swing', long: 'weekly' } as const)[horizon] : null, universe_scan_at: rec?.source.universe_scan_at ?? null };
    return { id: t.trial_id, trial_id: t.trial_id, cell_id: t.cell_id, arm: cell.arm, symbol: cell.symbol, timeframe: cell.timeframe, family: cell.family, side: cell.side, ir: t.ir, ir_hash: t.ir_hash, selection: t.dev!.selection, dsr: t.dsr, holdout: null, holdout_gross: null, test: null, passed: null, cause: null, horizon, source, portfolio: null, judge: t.dev!.judge };
  }
  private complete(row: MatrixStudyRow, lease: string | null): MatrixStudyRow {
    const conclusion = conclusionOf(row.manifest, row.state.cells, row.state.finalists);
    row.state.conclusion = conclusion; row.state.stage = 'done'; row.state.progress.note = conclusion.text.slice(0, 200);
    const out = this.store.update(row.id, { status: 'completed', state: row.state, lease: { token: null, until: null } }, { kind: 'conclusion', extra: { conclusion } }, { from: 'strategy_lab', to: 'gate_captain', kind: 'result', key: 'complete', summary: conclusion.text.slice(0, 400), payload: { kind: conclusion.kind, finalist_ids: conclusion.finalist_ids, causes: conclusion.causes } });
    void lease; this.flush();
    try { this.deps.onConclusion?.(out, conclusion); } catch { /* 回调失败不影响研究结果 */ }
    return out;
  }
  private fail(id: string, e: unknown, started: number, _lease: string | null): MatrixStudyRow {
    const msg = e instanceof Error ? e.message : String(e), row = this.store.require(id);
    row.state.run_ms += this.now() - started;
    if (/CANCELLED/.test(msg)) {
      if (row.status === 'cancelled') { this.store.update(id, { state: row.state }); this.flush(); return this.store.require(id); }
      return this.store.update(id, { status: 'cancelled', state: row.state, lease: { token: null, until: null } }, { kind: 'status' });
    }
    row.state.error = msg.slice(0, 1000);
    const out = this.store.update(id, { status: 'failed', state: row.state, lease: { token: null, until: null } }, { kind: 'status' }, { from: 'strategy_lab', to: 'gate_captain', kind: 'blocked', key: `failed:${row.state.run_ms}`, summary: `矩阵研究失败:${msg.slice(0, 200)}` });
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
    const svc = new StrategyService(new StrategyStore(this.deps.db), new ResearchStore(this.deps.db), null as unknown as ResearchService);
    const H = { short: '短线', mid: '中线', long: '长线' }[f.horizon];
    const src = [f.source.recommendation_id ? `推荐 ${f.source.recommendation_id}` : null, f.source.radar_tier ? `雷达 ${f.source.radar_tier}` : null, f.source.universe_scan_at ? `扫描 ${new Date(f.source.universe_scan_at).toISOString().slice(0, 16)}Z` : null].filter(Boolean).join(' / ') || '手动研究';
    const h = f.holdout!;
    const description = `[矩阵研究 ${id} · horizon=${f.horizon}(${H} ${f.timeframe}) · ${f.family}/${f.side}/${f.arm} · 来源:${src}] 留出段 ${(h.total_return * 100).toFixed(1)}%(同敞口持有 ${h.exposure_matched_hold === null ? '—' : (h.exposure_matched_hold * 100).toFixed(1) + '%'},${h.trades} 笔,Holm p=${f.test?.p_value?.toFixed(4) ?? '—'});账户级回放 ${f.portfolio ? (f.portfolio.total_return * 100).toFixed(1) + '%' : '—'};证据口径 ${row.manifest.spec.protocol.evidence_mode}`;
    let result: AdoptResult | null = null;
    this.store.tx(() => {
      const s = svc.create({ name: (name?.trim() || `${f.symbol.replace(/USDT$/, '')} ${H}${f.timeframe} ${f.family}${f.arm === 'code_judge' ? '+判断' : ''}`).slice(0, 120), description: description.slice(0, 4000), symbol: f.symbol, timeframe: f.timeframe, strategy_ir: f.ir });
      const version = svc.store.require(s.id).current_version;
      if (!version) throw Error('adopt_version_missing');
      const pf = this.deps.preflight ? this.deps.preflight(s.id, version) : staticPreflight(svc, s.id, version, f.ir, !!this.deps.runnerHasJudge);
      if (!pf.deployable) throw Error(`adopt_preflight_blocked:${pf.blockers.map((b) => `${b.code}(${b.message})`).join(';').slice(0, 600)}`);
      this.store.insertAdoption(id, finalist_id, s.id, version);
      result = { strategy_id: s.id, version, preflight: { deployable: true, warnings: pf.warnings }, horizon: f.horizon, source: f.source };
      const cur = this.store.require(id);
      this.store.handoff(cur, { from: 'gate_captain', to: 'thread_manager', kind: 'request', key: `adopt:${finalist_id}`, summary: `矩阵研究 finalist ${f.symbol} ${f.timeframe} ${f.family} 已存为策略 ${s.id} v${version},可设为当前策略`, payload: { finalist_id, strategy_id: s.id, version, horizon: f.horizon, source: f.source } });
      this.store.event(cur, 'adopted', { adopted: { finalist_id, strategy_id: s.id, version } });
    });
    this.flush();
    try { this.deps.onAdopted?.(this.store.require(id), { ...result!, finalist_id }); } catch { /* 回调失败不影响 adopt */ }
    return result!;
  }

  // ---------------------------------------------------------------- 读视图与事件
  view(row: MatrixStudyRow, detail = true) {
    const s = row.state, base = { id: row.id, status: row.status, stage: row.stage, research_program_id: row.research_program_id, manifest_hash: row.manifest_hash, protocol_hash: row.protocol_hash, created_at: row.created_at, updated_at: row.updated_at, progress: s.progress, holdout_state: s.holdout_state, conclusion: s.conclusion, usage: s.usage, ledger: s.ledger, stop_reason: s.stop_reason, error: s.error, origin: row.manifest.spec.origin, spec: row.manifest.spec };
    if (!detail) return { ...base, finalists: s.finalists.map((f) => ({ id: f.id, symbol: f.symbol, timeframe: f.timeframe, family: f.family, arm: f.arm, passed: f.passed, horizon: f.horizon })) };
    return { ...base, segments: row.manifest.segments, cells: row.manifest.cells.map((c) => ({ id: c.id, symbol: c.symbol, timeframe: c.timeframe, horizon: HORIZON_OF[c.timeframe], family: c.family, side: c.side, arm: c.arm, applicability: c.applicability, reason: c.reason, variants: c.variants.length, result: s.cells[c.id] ?? null })), generations: s.generations, finalists: s.finalists, notes: s.notes.slice(-50), release: this.store.release(row.id) ? { status: this.store.release(row.id)!.status, released_at: this.store.release(row.id)!.released_at } : null, adoptions: s.finalists.map((f) => ({ finalist_id: f.id, adopted: this.store.adoption(row.id, f.id) })).filter((x) => x.adopted) };
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
