import type { DatabaseSync } from 'node:sqlite';
import { hash } from '../primitives.js';
import type { JudgeResult, RecordedResponse } from './types.js';

const SCALE = 1_000_000_000_000n;
export function usdUnits(s: string): bigint {
  if (!/^(0|[1-9]\d*)(\.\d{1,12})?$/.test(s)) throw Error('usd_decimal_invalid');
  const [a,b = ''] = s.split('.'); return BigInt(a!) * SCALE + BigInt(b.padEnd(12,'0'));
}
export function usdString(n: bigint): string { const s = `${n / SCALE}.${(n % SCALE).toString().padStart(12,'0')}`; return s.replace(/\.?0+$/, '') || '0'; }
export function actualUsd(n: number): string { if (!Number.isFinite(n) || n < 0 || n > 1e6) throw Error('usage_cost_invalid'); return n.toFixed(12).replace(/\.?0+$/, '') || '0'; }
export function immediate<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export interface BudgetView { id: string; max_calls: number; max_usd: string; calls: number; spent_usd: string; reserved_usd: string; cancelled: number; blocked: number }
export class AtomicCallBudget {
  constructor(readonly db: DatabaseSync, readonly id: string) {}
  static create(db: DatabaseSync, id: string, max_calls: number, max_usd: string): AtomicCallBudget {
    usdUnits(max_usd); if (!Number.isSafeInteger(max_calls) || max_calls < 0) throw Error('max_calls_invalid');
    db.prepare('INSERT OR IGNORE INTO research_call_budgets(id,max_calls,max_usd) VALUES (?,?,?)').run(id,max_calls,max_usd);
    const b = new AtomicCallBudget(db,id), v = b.view();
    if (v.max_calls !== max_calls || v.max_usd !== max_usd) throw Error('budget_immutable'); return b;
  }
  view(): BudgetView { const v = this.db.prepare('SELECT * FROM research_call_budgets WHERE id=?').get(this.id); if (!v) throw Error('budget_not_found'); return v as unknown as BudgetView; }
  cancel(): void { this.db.prepare('UPDATE research_call_budgets SET cancelled=1 WHERE id=?').run(this.id); }
  resume(): void { this.db.prepare('UPDATE research_call_budgets SET cancelled=0 WHERE id=?').run(this.id); }
  /** 必须在与 response claim 相同的 IMMEDIATE 事务内调用。 */
  reserve(max_usd: string): void {
    const v = this.view(), n = usdUnits(max_usd);
    if (v.cancelled) throw Error('CANCELLED');
    if (v.blocked || v.calls >= v.max_calls || usdUnits(v.spent_usd) + usdUnits(v.reserved_usd) + n > usdUnits(v.max_usd)) throw Error('judge_budget_exhausted');
    this.db.prepare('UPDATE research_call_budgets SET calls=calls+1,reserved_usd=? WHERE id=?').run(usdString(usdUnits(v.reserved_usd)+n),this.id);
  }
}
export interface ResponseRow { request_hash: string; budget_id: string; status: string; raw_json: string | null; error_code: string | null }
export class JudgeDecisionStore {
  constructor(readonly db: DatabaseSync, readonly now: () => number = Date.now) {}
  result(key: string, input_hash: string): JudgeResult | null {
    const r = this.db.prepare('SELECT input_hash,result_json FROM research_judge_decisions WHERE decision_key=?').get(key);
    if (!r) return null; if (r.input_hash !== input_hash) throw Error('judge_decision_key_conflict'); return JSON.parse(String(r.result_json)) as JudgeResult;
  }
  response(request_hash: string): ResponseRow | null { return this.db.prepare('SELECT * FROM research_judge_responses WHERE request_hash=?').get(request_hash) as unknown as ResponseRow ?? null; }
  claim(request_hash: string, request: unknown, budget: AtomicCallBudget, reservation_usd: string): boolean {
    if (budget.db !== this.db) throw Error('judge_budget_connection_mismatch');
    return immediate(this.db, () => {
      if (this.response(request_hash)) return false;
      budget.reserve(reservation_usd); const at = this.now();
      this.db.prepare('INSERT INTO research_judge_responses VALUES (?,?,?,?,?,?,?,?)').run(request_hash,budget.id,'pending',JSON.stringify(request),null,null,at,at);
      this.db.prepare('INSERT INTO research_call_attempts VALUES (?,?,?,?,?,?,?,?,?,?)').run(`call_${request_hash}`,request_hash,budget.id,reservation_usd,null,null,null,'reserved',at,null);
      return true;
    });
  }
  /** 首次响应和结算在同一事务钉住；缺用量/超时不释放最大预留。 */
  finish(request_hash: string, response: RecordedResponse | null, error_code: string | null): void {
    immediate(this.db, () => {
      const row = this.response(request_hash); if (!row || row.status !== 'pending') return;
      const a = this.db.prepare('SELECT * FROM research_call_attempts WHERE request_hash=?').get(request_hash)!;
      const budget = new AtomicCallBudget(this.db,row.budget_id), b = budget.view();
      let cost: string | null = null;
      if (response?.usage && response.usage.cost_usd !== null) {
        try { cost = actualUsd(response.usage.cost_usd); } catch { /* unknown 保留预留 */ }
      }
      let blocked = b.blocked;
      if (cost !== null) {
        if (usdUnits(cost) > usdUnits(String(a.reservation_usd))) blocked = 1;
        this.db.prepare('UPDATE research_call_budgets SET spent_usd=?,reserved_usd=?,blocked=? WHERE id=?').run(usdString(usdUnits(b.spent_usd)+usdUnits(cost)),usdString(usdUnits(b.reserved_usd)-usdUnits(String(a.reservation_usd))),blocked,b.id);
      }
      const status = response ? 'recorded' : 'unknown';
      this.db.prepare('UPDATE research_judge_responses SET status=?,raw_json=?,error_code=?,updated_at=? WHERE request_hash=?').run(status,response ? JSON.stringify(response) : null,error_code,this.now(),request_hash);
      this.db.prepare('UPDATE research_call_attempts SET actual_usd=?,usage_json=?,provider_request_id=?,status=?,finished_at=? WHERE request_hash=?').run(cost,response?.usage ? JSON.stringify(response.usage) : null,response?.provider_request_id ?? null,cost === null ? 'unknown' : blocked ? 'overrun' : 'settled',this.now(),request_hash);
    });
  }
  put(key: string, input_hash: string, result: JudgeResult, input: unknown = null): JudgeResult {
    this.db.prepare('INSERT OR IGNORE INTO research_judge_decisions VALUES (?,?,?,?,?,?,?)').run(result.decision_id,key,result.request_hash,input_hash,JSON.stringify(input),JSON.stringify(result),this.now());
    return this.result(key,input_hash)!;
  }
  usage(request_hash: string): { actual_usd: string | null; status: string } | null { return this.db.prepare('SELECT actual_usd,status FROM research_call_attempts WHERE request_hash=?').get(request_hash) as {actual_usd:string|null;status:string}|undefined ?? null; }
  /** 只由已确认失去租约的恢复路径调用；未知请求不得重发。 */
  interruptBudget(id: string): void {
    for (const r of this.db.prepare("SELECT request_hash FROM research_judge_responses WHERE budget_id=? AND status='pending'").all(id)) this.finish(String(r.request_hash),null,'process_interrupted');
  }
}
export const decisionId = (key: string) => `jd_${hash(key)}`;
