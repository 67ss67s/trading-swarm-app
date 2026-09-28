/**
 * 改进环持久化(migrations/0042):improve_jobs / improve_candidates。只做 SQL 读写与行↔对象转换。
 * 主线程(路由)和 worker 各自用自己的 DatabaseSync 连接实例化它;写都是单行小事务,不长时间占写锁。
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { StrategyIR } from '@trade-gate/contracts';
import type { Budget, Candidate, Evaluation, GeneratorName, Objective, OverfitLedger } from './types.js';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
/** parent = promote 父策略(门槛全过且验证段优于当时冠军);explore_parent = 多步搜索的父策略(训练目标更高但没 promote,不能当冠军) */
export type CandidateStatus = 'rejected' | 'evaluated' | 'gated_out' | 'plateau_failed' | 'validated' | 'parent' | 'explore_parent' | 'champion';
/** 任务创建时冻结的全部输入(跑中不改)。 */
export interface ImproveSpec {
  strategy_id: string | null;
  strategy_version: number | null;
  strategy_ir: StrategyIR;
  timeframe: string;
  universe: string[];
  from_ms: number;
  to_ms: number;
  objective: Objective;
  budget: Budget;
  generators: GeneratorName[];
  dataset_ids: Record<string, string> | null;
  random_entry_runs: number;
  seed: number;
  /** 冠军以新版本写入策略对象(有 strategy_id 且冠军不是基线时) */
  write_version: boolean;
}
export interface GenerationProgress { generation: number; parent_id: string; candidates: number; evaluated: number; passed: number; promoted: string[]; improved: boolean; best_candidate_id: string | null; best_objective: number | null; note: string;
  /** 这一代怎么选出下一代父策略:promote(门槛全过且验证段优于冠军)/ explore(训练目标更高,多步搜索)/ null(都没有) */
  mode?: 'promote' | 'explore' | null;
  /** 这一代结束时的冠军 */
  champion_id?: string }
export interface ImproveProgress { phase: string; message: string; generation: number; generations: GenerationProgress[]; trials: number; single_runs: number; started_at: number | null; elapsed_ms: number; stop_reason: string | null; notes: string[] }
export interface ImproveResult {
  champion_id: string | null;
  baseline_id: string | null;
  champion_is_baseline: boolean;
  holdout: import('./types.js').SegmentScore | null;
  baseline_validation: import('./types.js').SegmentScore | null;
  strategy_version_written: number | null;
  stop_reason: string | null;
  summary: string;
}
export interface JobRow { id: string; status: JobStatus; strategy_id: string | null; strategy_version: number | null; spec: ImproveSpec; frozen: Record<string, unknown> | null; progress: ImproveProgress | null; ledger: OverfitLedger | null; result: ImproveResult | null; error: string | null; holdout_used_at: number | null; created_at: number; updated_at: number; finished_at: number | null }
export interface CandidateRow extends Candidate { ir_hash: string; status: CandidateStatus; evaluation: Evaluation | null; created_at: number }

type Raw = Record<string, unknown>;
const j = <T>(s: unknown): T | null => (typeof s === 'string' && s ? (JSON.parse(s) as T) : null);
const toJob = (r: Raw): JobRow => ({ id: r.id as string, status: r.status as JobStatus, strategy_id: (r.strategy_id as string | null) ?? null, strategy_version: (r.strategy_version as number | null) ?? null, spec: j<ImproveSpec>(r.spec_json)!, frozen: j(r.frozen_json), progress: j(r.progress_json), ledger: j(r.ledger_json), result: j(r.result_json), error: (r.error as string | null) ?? null, holdout_used_at: (r.holdout_used_at as number | null) ?? null, created_at: r.created_at as number, updated_at: r.updated_at as number, finished_at: (r.finished_at as number | null) ?? null });
const toCandidate = (r: Raw): CandidateRow => ({ id: r.id as string, parent_id: (r.parent_id as string | null) ?? null, generation: r.generation as number, generator: r.generator as GeneratorName, ir_hash: r.ir_hash as string, ir: j<StrategyIR>(r.ir_json)!, diff: j(r.diff_json) ?? [], rationale: r.rationale as string, ...(r.evidence_json ? { evidence: j<Record<string, unknown>>(r.evidence_json)! } : {}), evaluation: j(r.evaluation_json), status: r.status as CandidateStatus, created_at: r.created_at as number });

export class ImproveStore {
  constructor(readonly db: DatabaseSync, readonly now: () => number = Date.now) {}
  createJob(spec: ImproveSpec): JobRow {
    const id = `imp_${randomUUID().replace(/-/g, '').slice(0, 20)}`, at = this.now();
    this.db.prepare('INSERT INTO improve_jobs(id,status,strategy_id,strategy_version,spec_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, 'queued', spec.strategy_id, spec.strategy_version, JSON.stringify(spec), at, at);
    return this.job(id)!;
  }
  job(id: string): JobRow | null { const r = this.db.prepare('SELECT * FROM improve_jobs WHERE id=?').get(id) as Raw | undefined; return r ? toJob(r) : null; }
  require(id: string): JobRow { const r = this.job(id); if (!r) throw Error('improve_job_not_found'); return r; }
  list(q: { strategy_id?: string | null; limit?: number } = {}): JobRow[] {
    const limit = Math.max(1, Math.min(200, Math.floor(q.limit ?? 50)));
    const rows = (q.strategy_id ? this.db.prepare('SELECT * FROM improve_jobs WHERE strategy_id=? ORDER BY created_at DESC LIMIT ?').all(q.strategy_id, limit) : this.db.prepare('SELECT * FROM improve_jobs ORDER BY created_at DESC LIMIT ?').all(limit)) as Raw[];
    return rows.map(toJob);
  }
  active(): JobRow[] { return (this.db.prepare("SELECT * FROM improve_jobs WHERE status IN ('queued','running') ORDER BY created_at").all() as Raw[]).map(toJob); }
  update(id: string, f: { status?: JobStatus; frozen?: unknown; progress?: ImproveProgress; ledger?: OverfitLedger; result?: ImproveResult; error?: string | null; finished?: boolean }): void {
    const sets: string[] = [], vals: (string | number | null)[] = [];
    const put = (col: string, v: string | number | null) => { sets.push(`${col}=?`); vals.push(v); };
    if (f.status) put('status', f.status);
    if (f.frozen !== undefined) put('frozen_json', JSON.stringify(f.frozen));
    if (f.progress) put('progress_json', JSON.stringify(f.progress));
    if (f.ledger) put('ledger_json', JSON.stringify(f.ledger));
    if (f.result) put('result_json', JSON.stringify(f.result));
    if (f.error !== undefined) put('error', f.error);
    if (f.finished) put('finished_at', this.now());
    put('updated_at', this.now());
    this.db.prepare(`UPDATE improve_jobs SET ${sets.join(',')} WHERE id=?`).run(...vals, id);
  }
  /** 留出段占用:每个任务只成功一次;第二次抛 improve_holdout_already_used。 */
  claimHoldout(id: string): void {
    const r = this.db.prepare('UPDATE improve_jobs SET holdout_used_at=?,updated_at=? WHERE id=? AND holdout_used_at IS NULL').run(this.now(), this.now(), id);
    if (Number(r.changes) !== 1) throw Error('improve_holdout_already_used');
  }
  putCandidate(job_id: string, c: Candidate, ir_hash: string, status: CandidateStatus, evaluation: Evaluation | null = null): void {
    this.db.prepare('INSERT INTO improve_candidates(job_id,id,parent_id,generation,generator,ir_hash,ir_json,diff_json,rationale,evidence_json,evaluation_json,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(job_id, c.id, c.parent_id, c.generation, c.generator, ir_hash, JSON.stringify(c.ir), JSON.stringify(c.diff), c.rationale.slice(0, 4000), c.evidence ? JSON.stringify(c.evidence) : null, evaluation ? JSON.stringify(evaluation) : null, status, this.now());
  }
  updateCandidate(job_id: string, id: string, f: { status?: CandidateStatus; evaluation?: Evaluation }): void {
    if (f.status) this.db.prepare('UPDATE improve_candidates SET status=? WHERE job_id=? AND id=?').run(f.status, job_id, id);
    if (f.evaluation) this.db.prepare('UPDATE improve_candidates SET evaluation_json=? WHERE job_id=? AND id=?').run(JSON.stringify(f.evaluation), job_id, id);
  }
  candidates(job_id: string): CandidateRow[] { return (this.db.prepare('SELECT * FROM improve_candidates WHERE job_id=? ORDER BY generation,created_at,id').all(job_id) as Raw[]).map(toCandidate); }
  /** 进程重启:排队/在跑的任务一律标 interrupted(worker 随进程没了,不自动重跑)。 */
  recover(): number { return Number(this.db.prepare("UPDATE improve_jobs SET status='interrupted',error=COALESCE(error,'process_restart'),updated_at=?,finished_at=? WHERE status IN ('queued','running')").run(this.now(), this.now()).changes); }
}
