/**
 * 矩阵研究持久化(migrations/0048)。所有状态变更与事件 outbox、bot handoff 在同一 BEGIN IMMEDIATE 事务里写;
 * 事务内不 await(judge 的预算 claim 也用 BEGIN IMMEDIATE,同一连接不能嵌套)。
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { BotRegistry, type BotRole } from '../../bots.js';
import { hash } from '../primitives.js';
import { judgeStageWorst } from './manifest.js';
import type { CellResult, DevResult, MatrixEvent, MatrixManifest, MatrixStage, MatrixState, MatrixStudyRow, MatrixStudyStatus } from './types.js';

type Raw = Record<string, unknown>;
const depth = new WeakMap<DatabaseSync, number>();
/** BEGIN IMMEDIATE;嵌套调用复用外层事务(内层用 SAVEPOINT,StrategyStore.tx 同法) */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  if (d > 0) {
    const sp = `matrix_sp_${d}`; db.exec(`SAVEPOINT ${sp}`); depth.set(db, d + 1);
    try { const out = fn(); db.exec(`RELEASE ${sp}`); return out; } catch (e) { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); throw e; } finally { depth.set(db, d); }
  }
  db.exec('BEGIN IMMEDIATE'); depth.set(db, 1);
  try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { depth.set(db, 0); }
}

export const emptyState = (): MatrixState => ({
  stage: 'queued', progress: { done: 0, total: 0, eta_ms: null, note: '排队' }, holdout_state: 'sealed', data_lock: null, data_lock_hash: null,
  cells: {}, generations: [], finalists: [], finalists_hash: null, trial_ledger_hash: null, conclusion: null, ledger: null, sharpe_variance: null,
  usage: { judge_calls: 0, judge_usd: '0', judge_reserved_usd: '0', judge_unknown_cost_calls: 0, llm_calls: 0, llm_usd: '0', wall_ms: 0 },
  stop_reason: null, notes: [], error: null, started_at: null, run_ms: 0,
});
const toRow = (r: Raw): MatrixStudyRow => ({
  id: String(r.id), idempotency_key: String(r.idempotency_key), research_program_id: String(r.research_program_id), manifest_hash: String(r.manifest_hash), protocol_hash: String(r.protocol_hash),
  manifest: JSON.parse(String(r.manifest_json)) as MatrixManifest, status: r.status as MatrixStudyStatus, stage: r.stage as MatrixStage, state: JSON.parse(String(r.state_json)) as MatrixState,
  lease_token: (r.lease_token as string | null) ?? null, lease_until: (r.lease_until as number | null) ?? null, created_at: Number(r.created_at), updated_at: Number(r.updated_at),
});

export interface HandoffSpec { from: BotRole; to: BotRole; kind: 'request' | 'result' | 'review' | 'alert' | 'blocked'; key: string; summary: string; payload?: Record<string, unknown> }
export interface TrialRowView { trial_id: string; cell_id: string; variant_id: string; parent_trial_id: string | null; generation: number; config_hash: string; ir_hash: string; status: string; selection_visible_at: number | null; candidate: Record<string, unknown> }

export class MatrixStudyStore {
  readonly bots: BotRegistry;
  constructor(readonly db: DatabaseSync, readonly now: () => number = Date.now) { this.bots = new BotRegistry(db); }
  tx<T>(fn: () => T): T { return tx(this.db, fn); }

  // ---------------------------------------------------------------- studies
  get(id: string): MatrixStudyRow | null { const r = this.db.prepare('SELECT * FROM research_matrix_studies WHERE id=?').get(id) as Raw | undefined; return r ? toRow(r) : null; }
  require(id: string): MatrixStudyRow { const r = this.get(id); if (!r) throw Error('matrix_study_not_found'); return r; }
  byKey(key: string): MatrixStudyRow | null { const r = this.db.prepare('SELECT * FROM research_matrix_studies WHERE idempotency_key=?').get(key) as Raw | undefined; return r ? toRow(r) : null; }
  list(limit = 50): MatrixStudyRow[] { return (this.db.prepare('SELECT * FROM research_matrix_studies ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(200, limit))) as Raw[]).map(toRow); }
  withStatus(statuses: MatrixStudyStatus[]): MatrixStudyRow[] { return (this.db.prepare(`SELECT * FROM research_matrix_studies WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at`).all(...statuses) as Raw[]).map(toRow); }

  /** 创建 + 冻结 manifest + 格子 + 搜索区间暴露 + 开始 handoff(gate_captain → strategy_lab)+ 事件,同一事务 */
  insert(input: { idempotency_key: string; manifest: MatrixManifest; manifest_hash: string }): MatrixStudyRow {
    return this.tx(() => {
      const prior = this.byKey(input.idempotency_key);
      if (prior) { if (prior.manifest_hash !== input.manifest_hash && hash(prior.manifest.spec) !== hash(input.manifest.spec)) throw Error('idempotency_conflict'); return prior; }
      const id = `ms_${randomUUID().replace(/-/g, '').slice(0, 20)}`, at = this.now(), m = input.manifest, st = emptyState();
      // 两段式:第一阶段 code 格变体 + 补跑最坏 K 格(入选后按实际名单改)
      st.progress.total = m.judge_stage ? m.cells.filter((c) => c.applicability === 'applicable' && c.arm === 'code').reduce((a, c) => a + c.variants.length, 0) + judgeStageWorst(m).trials_max : m.cells.filter((c) => c.applicability === 'applicable').reduce((a, c) => a + c.variants.length, 0);
      if (m.judge_stage) st.judge_stage = { mode: 'candidates', max_cells: m.judge_stage.max_cells, status: 'pending', eligible: 0, selected: [] };
      this.db.prepare('INSERT INTO research_matrix_studies(id,idempotency_key,research_program_id,manifest_hash,protocol_hash,manifest_json,status,stage,state_json,lease_token,lease_until,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,NULL,?,?)')
        .run(id, input.idempotency_key, m.spec.research_program_id, input.manifest_hash, m.protocol_hash, JSON.stringify(m), 'queued', 'queued', JSON.stringify(st), at, at);
      const ins = this.db.prepare('INSERT INTO research_study_cells(study_id,cell_id,applicability,cell_json) VALUES (?,?,?,?)');
      for (const c of m.cells) ins.run(id, c.id, c.applicability, JSON.stringify(c));
      for (const [tf, g] of Object.entries(m.segments)) this.exposure(id, m, `${m.data_scope_id}:${tf}`, g!.train.from_ms, g!.selection.to_ms, 'search');
      const row = this.get(id)!;
      this.handoff(row, { from: 'gate_captain', to: 'strategy_lab', kind: 'request', key: 'start', summary: `矩阵研究 ${m.spec.symbols.join('/')} × ${m.spec.timeframes.join('/')}:${st.progress.total} 个变体排队`, payload: { manifest_hash: input.manifest_hash, protocol_hash: m.protocol_hash } });
      this.event(row, 'status');
      return row;
    });
  }
  /** 更新状态 / 阶段 / state;可附带事件与 handoff(同事务)。expect 不符时抛 conflict */
  update(id: string, f: { status?: MatrixStudyStatus; stage?: MatrixStage; state?: MatrixState; expect?: MatrixStudyStatus[]; lease?: { token: string | null; until: number | null } }, ev?: { kind: MatrixEvent['kind']; extra?: Partial<MatrixEvent> }, h?: HandoffSpec): MatrixStudyRow {
    return this.tx(() => {
      const cur = this.require(id);
      if (f.expect && !f.expect.includes(cur.status)) throw Error(`matrix_study_conflict:${cur.status}`);
      const state = f.state ?? cur.state, stage = f.stage ?? state.stage ?? cur.stage;
      state.stage = stage;
      const sets = ['state_json=?', 'stage=?', 'updated_at=?'], vals: (string | number | null)[] = [JSON.stringify(state), stage, this.now()];
      if (f.status) { sets.push('status=?'); vals.push(f.status); }
      if (f.lease) { sets.push('lease_token=?', 'lease_until=?'); vals.push(f.lease.token, f.lease.until); }
      this.db.prepare(`UPDATE research_matrix_studies SET ${sets.join(',')} WHERE id=?`).run(...vals, id);
      const row = this.require(id);
      if (h) this.handoff(row, h);
      if (ev) this.event(row, ev.kind, ev.extra);
      return row;
    });
  }
  /** 租约:同一时间只允许一个 worker 推进(续租 = 同 token 再调用) */
  acquireLease(id: string, token: string, ttl_ms: number): void {
    this.tx(() => {
      const cur = this.require(id), at = this.now();
      if (cur.lease_token && cur.lease_token !== token && (cur.lease_until ?? 0) > at) throw Error('matrix_study_busy');
      this.db.prepare('UPDATE research_matrix_studies SET lease_token=?,lease_until=? WHERE id=?').run(token, at + ttl_ms, id);
    });
  }

  // ---------------------------------------------------------------- outbox / handoff
  event(row: MatrixStudyRow, kind: MatrixEvent['kind'], extra: Partial<MatrixEvent> = {}): void {
    const payload = { study_id: row.id, stage: row.state.stage, status: row.status, kind, progress: row.state.progress, ...extra };
    this.db.prepare('INSERT INTO research_study_events(study_id,at,stage,payload_json,delivered_at) VALUES (?,?,?,?,NULL)').run(row.id, this.now(), row.state.stage, JSON.stringify(payload));
  }
  events(study_id: string, after = 0, limit = 200): MatrixEvent[] {
    return (this.db.prepare('SELECT * FROM research_study_events WHERE study_id=? AND seq>? ORDER BY seq LIMIT ?').all(study_id, after, Math.max(1, Math.min(500, limit))) as Raw[]).map((r) => ({ ...(JSON.parse(String(r.payload_json)) as Omit<MatrixEvent, 'seq' | 'at'>), seq: Number(r.seq), at: Number(r.at) }));
  }
  /** 未投递事件(至少一次投递;消费方按 seq 幂等) */
  undelivered(limit = 200): MatrixEvent[] { return (this.db.prepare('SELECT * FROM research_study_events WHERE delivered_at IS NULL ORDER BY seq LIMIT ?').all(limit) as Raw[]).map((r) => ({ ...(JSON.parse(String(r.payload_json)) as Omit<MatrixEvent, 'seq' | 'at'>), seq: Number(r.seq), at: Number(r.at) })); }
  markDelivered(seqs: number[]): void { const at = this.now(), st = this.db.prepare('UPDATE research_study_events SET delivered_at=? WHERE seq=? AND delivered_at IS NULL'); for (const s of seqs) st.run(at, s); }
  handoff(row: MatrixStudyRow, h: HandoffSpec): void {
    this.bots.handoff({ handoff_id: randomUUID(), run_id: null, from_role: h.from, to_role: h.to, kind: h.kind, subject: { type: 'matrix_study', id: row.id }, summary: h.summary.slice(0, 500), evidence_refs: [`matrix_study:${row.id}`], artifact_refs: [], requested_output_schema: null, priority: 50, deadline_at: null, idempotency_key: `matrix_study:${row.id}:${h.key}`, payload: { study_id: row.id, ...(h.payload ?? {}) }, created_at: this.now() });
  }
  handoffs(study_id: string) { return (this.db.prepare("SELECT from_role,to_role,kind,idempotency_key,payload_json FROM demo_bot_handoff WHERE subject_type='matrix_study' AND subject_id=? ORDER BY created_at, rowid").all(study_id) as Raw[]).map((r) => ({ from: String(r.from_role), to: String(r.to_role), kind: String(r.kind), key: String(r.idempotency_key), payload: r.payload_json ? JSON.parse(String(r.payload_json)) as Record<string, unknown> : null })); }

  // ---------------------------------------------------------------- exposures / ledger
  exposure(study_id: string, m: MatrixManifest, scope: string, from_ms: number, to_ms: number, purpose: 'search' | 'holdout'): void {
    this.db.prepare('INSERT INTO research_data_exposures VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), study_id, m.spec.research_program_id, scope, from_ms, to_ms, purpose, this.now());
  }
  /** 同谱系、同数据范围、区间重叠的已占用留出(claimed / released) */
  overlappingHoldouts(program: string, scopePrefix: string, from_ms: number, to_ms: number, except_study?: string): { study_id: string; from_ms: number; to_ms: number }[] {
    return (this.db.prepare("SELECT study_id,from_ms,to_ms FROM research_data_exposures WHERE research_program_id=? AND purpose='holdout' AND data_scope_id LIKE ? AND from_ms<=? AND to_ms>=?").all(program, `${scopePrefix}%`, to_ms, from_ms) as Raw[])
      .filter((r) => r.study_id !== except_study).map((r) => ({ study_id: String(r.study_id), from_ms: Number(r.from_ms), to_ms: Number(r.to_ms) }));
  }
  trial(study_id: string, config_hash: string): TrialRowView | null {
    const r = this.db.prepare('SELECT * FROM research_study_trials WHERE study_id=? AND config_hash=?').get(study_id, config_hash) as Raw | undefined;
    return r ? this.toTrial(r) : null;
  }
  private toTrial(r: Raw): TrialRowView { return { trial_id: String(r.trial_id), cell_id: String(r.cell_id), variant_id: String(r.variant_id), parent_trial_id: (r.parent_trial_id as string | null) ?? null, generation: Number(r.generation), config_hash: String(r.config_hash), ir_hash: String(r.ir_hash), status: String(r.status), selection_visible_at: (r.selection_visible_at as number | null) ?? null, candidate: JSON.parse(String(r.candidate_json)) as Record<string, unknown> }; }
  trials(study_id: string): TrialRowView[] { return (this.db.prepare('SELECT * FROM research_study_trials WHERE study_id=? ORDER BY generation, created_at, trial_id').all(study_id) as Raw[]).map((r) => this.toTrial(r)); }
  insertTrial(t: { study_id: string; program: string; cell_id: string; variant_id: string; parent_trial_id: string | null; generation: number; config_hash: string; ir_hash: string; judge_hash: string | null; model_revision: string | null; candidate: Record<string, unknown> }): TrialRowView {
    const trial_id = `mt_${hash({ s: t.study_id, c: t.config_hash }).slice(0, 24)}`;
    this.db.prepare('INSERT OR IGNORE INTO research_study_trials(trial_id,study_id,research_program_id,cell_id,variant_id,parent_trial_id,generation,config_hash,ir_hash,judge_hash,model_revision,candidate_json,selection_visible_at,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)')
      .run(trial_id, t.study_id, t.program, t.cell_id, t.variant_id, t.parent_trial_id, t.generation, t.config_hash, t.ir_hash, t.judge_hash, t.model_revision, JSON.stringify(t.candidate), 'registered', this.now());
    return this.trial(t.study_id, t.config_hash)!;
  }
  /** 成绩被看到的时刻 = 进入试验计数 */
  markVisible(trial_id: string, status: string): void { this.db.prepare('UPDATE research_study_trials SET status=?,selection_visible_at=COALESCE(selection_visible_at,?) WHERE trial_id=?').run(status, this.now(), trial_id); }
  setTrialStatus(trial_id: string, status: string): void { this.db.prepare('UPDATE research_study_trials SET status=? WHERE trial_id=?').run(status, trial_id); }
  /** 谱系级试验数:跨 Study 按 config_hash 去重、只数看过成绩的 */
  programTrialCount(program: string): number { return Number((this.db.prepare('SELECT COUNT(DISTINCT config_hash) n FROM research_study_trials WHERE research_program_id=? AND selection_visible_at IS NOT NULL').get(program) as Raw).n); }
  studyTrialCount(study_id: string): number { return Number((this.db.prepare('SELECT COUNT(*) n FROM research_study_trials WHERE study_id=? AND selection_visible_at IS NOT NULL').get(study_id) as Raw).n); }
  attemptCount(study_id: string): number { return Number((this.db.prepare('SELECT COUNT(*) n FROM research_study_attempts WHERE study_id=?').get(study_id) as Raw).n); }

  // ---------------------------------------------------------------- evaluations / attempts
  evaluation(trial_id: string, segment: string, data_hash: string, engine_hash: string): { evaluation_id: string; status: string; result: DevResult | Record<string, unknown> | null; error_code: string | null; attempt_count: number } | null {
    const r = this.db.prepare("SELECT * FROM research_study_evaluations WHERE trial_id=? AND segment=? AND cost_scenario='base+stress2x' AND data_hash=? AND engine_hash=?").get(trial_id, segment, data_hash, engine_hash) as Raw | undefined;
    return r ? { evaluation_id: String(r.evaluation_id), status: String(r.status), result: r.result_json ? JSON.parse(String(r.result_json)) as DevResult : null, error_code: (r.error_code as string | null) ?? null, attempt_count: Number(r.attempt_count) } : null;
  }
  /** 开始一次评估尝试:评估行不存在则建,attempt_count+1,写 attempt 行 */
  beginAttempt(study_id: string, trial_id: string, segment: string, data_hash: string, engine_hash: string): { evaluation_id: string; attempt_id: string } {
    return this.tx(() => {
      const at = this.now();
      this.db.prepare("INSERT OR IGNORE INTO research_study_evaluations(evaluation_id,study_id,trial_id,segment,cost_scenario,data_hash,engine_hash,status,result_json,error_code,attempt_count,created_at,updated_at) VALUES (?,?,?,?,'base+stress2x',?,?,'running',NULL,NULL,0,?,?)")
        .run(`me_${hash({ trial_id, segment, data_hash, engine_hash }).slice(0, 24)}`, study_id, trial_id, segment, data_hash, engine_hash, at, at);
      const e = this.evaluation(trial_id, segment, data_hash, engine_hash)!, attempt_id = randomUUID();
      this.db.prepare("UPDATE research_study_evaluations SET attempt_count=attempt_count+1,status='running',updated_at=? WHERE evaluation_id=?").run(at, e.evaluation_id);
      this.db.prepare("INSERT INTO research_study_attempts VALUES (?,?,?,'running',NULL,?,NULL)").run(attempt_id, e.evaluation_id, study_id, at);
      return { evaluation_id: e.evaluation_id, attempt_id };
    });
  }
  finishAttempt(a: { evaluation_id: string; attempt_id: string }, status: 'completed' | 'failed' | 'cancelled', result: unknown, error_code: string | null): void {
    this.tx(() => {
      const at = this.now();
      this.db.prepare('UPDATE research_study_attempts SET status=?,error_code=?,finished_at=? WHERE attempt_id=?').run(status, error_code, at, a.attempt_id);
      this.db.prepare('UPDATE research_study_evaluations SET status=?,result_json=COALESCE(?,result_json),error_code=?,updated_at=? WHERE evaluation_id=?').run(status, result === null || result === undefined ? null : JSON.stringify(result), error_code, at, a.evaluation_id);
    });
  }
  /** 本 Study 全部已完成的开发视图评估(segment='dev',每个试验取最近一条);读视图重算评分卡 / 三档用,不含留出 */
  devResults(study_id: string): Map<string, DevResult> {
    const out = new Map<string, DevResult>();
    for (const r of this.db.prepare("SELECT trial_id,result_json FROM research_study_evaluations WHERE study_id=? AND segment='dev' AND status='completed' AND result_json IS NOT NULL ORDER BY updated_at").all(study_id) as Raw[]) out.set(String(r.trial_id), JSON.parse(String(r.result_json)) as DevResult);
    return out;
  }
  putCandidate(study_id: string, trial_id: string, segment: string, candidate_id: string, snapshot: unknown, decision: unknown): void {
    this.db.prepare('INSERT OR IGNORE INTO research_study_candidates VALUES (?,?,?,?,?,?)').run(study_id, trial_id, segment, candidate_id, JSON.stringify(snapshot), decision === null ? null : JSON.stringify(decision));
  }
  candidateCount(study_id: string): number { return Number((this.db.prepare('SELECT COUNT(*) n FROM research_study_candidates WHERE study_id=?').get(study_id) as Raw).n); }

  // ---------------------------------------------------------------- holdout release
  release(study_id: string): Raw | null { return (this.db.prepare('SELECT * FROM research_holdout_releases WHERE study_id=?').get(study_id) as Raw | undefined) ?? null; }
  insertRelease(r: { study_id: string; program: string; data_scope_id: string; from_ms: number; to_ms: number; finalists_hash: string; protocol_hash: string; trial_ledger_hash: string; model_revision: string; data_manifest_hash: string; capability_hash: string }): void {
    this.db.prepare("INSERT INTO research_holdout_releases VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'claimed',?,NULL,NULL)").run(`hr_${randomUUID().replace(/-/g, '').slice(0, 20)}`, r.study_id, r.program, r.data_scope_id, r.from_ms, r.to_ms, r.finalists_hash, r.protocol_hash, r.trial_ledger_hash, r.model_revision, r.data_manifest_hash, r.capability_hash, this.now());
  }
  completeRelease(study_id: string, result: unknown): void { this.db.prepare("UPDATE research_holdout_releases SET status='released',released_at=?,result_json=? WHERE study_id=?").run(this.now(), JSON.stringify(result), study_id); }

  // ---------------------------------------------------------------- adoptions
  adoption(study_id: string, finalist_id: string): { strategy_id: string; version: number } | null { const r = this.db.prepare('SELECT strategy_id,version FROM research_matrix_adoptions WHERE study_id=? AND finalist_id=?').get(study_id, finalist_id) as Raw | undefined; return r ? { strategy_id: String(r.strategy_id), version: Number(r.version) } : null; }
  insertAdoption(study_id: string, finalist_id: string, strategy_id: string, version: number): void { this.db.prepare('INSERT INTO research_matrix_adoptions VALUES (?,?,?,?,?)').run(study_id, finalist_id, strategy_id, version, this.now()); }

  /** 进程重启:没有 worker 的 running / finalizing 一律 interrupted(不自动重跑;恢复走 resume) */
  recover(): string[] {
    return this.tx(() => {
      const rows = this.withStatus(['running', 'finalizing']);
      for (const r of rows) { r.state.notes.push('进程重启,研究中断;可 resume 从断点继续(已完成的评估不重跑、计数不清零)'); this.update(r.id, { status: 'interrupted', state: r.state, lease: { token: null, until: null } }, { kind: 'status' }); }
      return rows.map((r) => r.id);
    });
  }
  cellResultsFrom(state: MatrixState): CellResult[] { return Object.values(state.cells); }
}
