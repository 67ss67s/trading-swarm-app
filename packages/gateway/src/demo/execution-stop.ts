/** §9.51 移损账本与编排。独立于 placeProtection：不节流、不补偿平仓、不重发未知写。 */
import { createHash } from 'node:crypto';
import type { DemoStore } from './store.js';
import type { ExecBackend, StopMoveRequest, StopProtection } from './execution.js';
import type { StrategyThread } from './types.js';
import { compareStopPrices, stopMoveDecimal } from './threads.js';

export type StopMovePhase = 'planned' | 'submitted' | 'confirmed' | 'replaced' | 'failed' | 'unknown';
export interface StopMoveRow {
  thread_id: string; run_id: string | null; target_stop: string; old_stop: string; new_cid: string;
  old_cid: string | null; old_algo_id: string | null; new_algo_id: string | null;
  phase: StopMovePhase; method: 'paper' | 'amend' | 'replace'; execution_key: string; request_json: string;
  reason: string; detail: string; attention: string | null; at: number; updated_at: number;
}
type Frozen = Pick<StopMoveRequest, 'symbol' | 'market' | 'side' | 'qty'> & { old_cids: string[]; old_proof?: StopProtection };
type Result = { ok: boolean; detail: string };
interface Deps {
  store: DemoStore; backend: () => ExecBackend; executionKey: () => string;
  blocked: (thread: StrategyThread) => string | null;
  changed?: (thread: StrategyThread) => void;
  event?: (row: StopMoveRow) => void;
}

/** 自动补挂/余仓重挂也须尊重移损未决账本，不能绕过 CID 对账去旧链路盲发。 */
export function hasPendingStopMove(store: DemoStore, thread_id: string): boolean {
  return !!store.marketDb.prepare("SELECT 1 FROM demo_stop_moves WHERE thread_id=? AND (phase IN ('planned','submitted','unknown') OR attention IS NOT NULL) LIMIT 1").get(thread_id);
}

export class StopMover {
  private readonly locks = new Map<string, Promise<Result>>();
  constructor(private readonly deps: Deps) {}
  get(thread_id: string, target: string): StopMoveRow | null {
    return this.deps.store.marketDb.prepare('SELECT * FROM demo_stop_moves WHERE thread_id=? AND target_stop=?').get(thread_id, stopMoveDecimal(target)) as unknown as StopMoveRow ?? null;
  }
  pending(thread_id: string): StopMoveRow | null {
    return this.deps.store.marketDb.prepare("SELECT * FROM demo_stop_moves WHERE thread_id=? AND (phase IN ('planned','submitted','unknown') OR attention IS NOT NULL) LIMIT 1").get(thread_id) as unknown as StopMoveRow ?? null;
  }
  move(thread_id: string, target: string, reason: string): Promise<Result> {
    const previous = this.locks.get(thread_id) ?? Promise.resolve({ ok: false, detail: '' });
    const next = previous.catch(() => ({ ok: false, detail: '' })).then(() => this.perform(thread_id, target, reason)).catch(e => {
      if ((e as Error).message === 'stop_move_concurrent_transition') {
        const current = this.get(thread_id, target); if (current) return this.result(current);
      }
      throw e;
    });
    this.locks.set(thread_id, next);
    void next.finally(() => { if (this.locks.get(thread_id) === next) this.locks.delete(thread_id); }).catch(() => {});
    return next;
  }
  private result(row: StopMoveRow): Result { return { ok: row.phase === 'confirmed' || row.phase === 'replaced', detail: `${row.phase}:${row.detail}` }; }
  private notify(row: StopMoveRow, thread?: StrategyThread): void {
    // 账本已经提交；观察者失败不能把确定写变成失败或触发重发。
    try { if (thread) this.deps.changed?.(thread); this.deps.event?.(row); } catch { /* persistent events remain */ }
  }
  private transition(row: StopMoveRow, phase: StopMovePhase, detail: string, thread?: StrategyThread): void {
    const allowed: Record<StopMovePhase, StopMovePhase[]> = {
      planned: ['planned', 'submitted', 'failed'], submitted: ['unknown', 'failed', 'confirmed'], unknown: ['unknown', 'confirmed'],
      confirmed: ['confirmed', 'replaced', 'unknown'], replaced: [], failed: [],
    };
    if (!allowed[row.phase].includes(phase)) throw new Error(`invalid_stop_move_transition:${row.phase}:${phase}`);
    const next = { ...row, phase, detail, updated_at: Date.now() }, db = this.deps.store.marketDb;
    db.exec('BEGIN IMMEDIATE');
    try {
      const updated = db.prepare('UPDATE demo_stop_moves SET phase=?,detail=?,updated_at=?,old_cid=?,old_algo_id=?,new_algo_id=?,request_json=?,attention=? WHERE thread_id=? AND target_stop=? AND phase=?')
        .run(next.phase, next.detail, next.updated_at, next.old_cid, next.old_algo_id, next.new_algo_id, next.request_json, next.attention, next.thread_id, next.target_stop, row.phase);
      if (updated.changes !== 1) throw new Error('stop_move_concurrent_transition');
      if (thread) this.deps.store.saveThread(thread);
      db.prepare('INSERT INTO demo_stop_move_events(thread_id,new_cid,phase,at,data) VALUES (?,?,?,?,?)').run(next.thread_id, next.new_cid, phase, next.updated_at, JSON.stringify(next));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    Object.assign(row, next); this.notify(row, thread);
  }
  private guard(row: StopMoveRow, backend: ExecBackend): StrategyThread | null {
    const t = this.deps.store.thread(row.thread_id), f: Frozen = JSON.parse(row.request_json);
    if (!t || t.status !== 'in_position' || this.deps.blocked(t) || this.deps.backend() !== backend || row.execution_key !== this.deps.executionKey()
      || t.backend !== backend.kind || t.symbol !== f.symbol || t.market !== f.market || t.side !== f.side || compareStopPrices(t.qty, f.qty) !== 0
      || !t.stop_price || compareStopPrices(t.stop_price, row.attention === 'STOP_MOVE_NEW_UNCONFIRMED' ? row.target_stop : row.old_stop) !== 0) return null;
    return t;
  }
  private proof(p: StopProtection | null, row: StopMoveRow, stop: string): p is StopProtection {
    if (!p) return false;
    const f: Frozen = JSON.parse(row.request_json);
    try {
      return p.symbol === f.symbol && p.market === f.market && p.side === f.side && compareStopPrices(p.stop_price, stop) === 0
        && (f.market === 'spot' ? !p.close_position && compareStopPrices(p.qty, f.qty) === 0 : p.close_position || compareStopPrices(p.qty, f.qty) >= 0);
    } catch { return false; }
  }
  private async perform(thread_id: string, target: string, reason: string): Promise<Result> {
    try { target = stopMoveDecimal(target); } catch { return { ok: false, detail: 'invalid_target_stop' }; }
    let row = this.get(thread_id, target);
    if (row && ['failed', 'replaced', 'confirmed'].includes(row.phase)) return this.result(row);
    const backend = this.deps.backend(), t = this.deps.store.thread(thread_id);
    if (!t || t.status !== 'in_position' || t.backend !== backend.kind || this.deps.blocked(t)) return { ok: false, detail: 'stop_move_thread_or_execution_blocked' };
    if (!['paper', 'okx'].includes(backend.kind) || !backend.stopMoveMode || !backend.getStopProtection) return { ok: false, detail: 'stop_move_unsupported' };
    const pending = this.pending(thread_id);
    if (pending && pending.target_stop !== target) {
      if (pending.phase === 'submitted' || pending.phase === 'unknown') await this.reconcile(pending, backend);
      return { ok: false, detail: `stop_move_pending:${pending.target_stop}:${pending.phase}` };
    }
    if (!row) {
      let old: string;
      try {
        old = stopMoveDecimal(t.stop_price ?? ''); stopMoveDecimal(t.qty);
        const cmp = compareStopPrices(target, old);
        if (t.side === 'long' ? cmp <= 0 : cmp >= 0) return { ok: false, detail: 'stop_move_must_tighten' };
      } catch { return { ok: false, detail: 'stop_move_invalid_thread_prices' }; }
      const at = Date.now(), new_cid = `tgm${createHash('sha256').update(`${thread_id}:${target}`).digest('hex').slice(0, 24)}-s1`;
      const f: Frozen = { symbol: t.symbol, market: t.market, side: t.side, qty: t.qty, old_cids: [...new Set([...t.protection_client_order_ids, ...(t.run_take_profit?.stop_client_order_id ? [t.run_take_profit.stop_client_order_id] : [])])] };
      row = { thread_id, run_id: t.origin?.startsWith('strategy_run:') ? t.origin.slice('strategy_run:'.length) : null, target_stop: target, old_stop: old, new_cid,
        old_cid: null, old_algo_id: null, new_algo_id: null, phase: 'planned', method: backend.stopMoveMode, execution_key: this.deps.executionKey(), request_json: JSON.stringify(f), reason, detail: '移损计划已落库', attention: null, at, updated_at: at };
      const db = this.deps.store.marketDb;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO demo_stop_moves(thread_id,run_id,target_stop,old_stop,new_cid,phase,method,execution_key,request_json,reason,detail,at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(thread_id, row.run_id, target, old, new_cid, row.phase, row.method, row.execution_key, row.request_json, reason, row.detail, at, at);
        db.prepare('INSERT INTO demo_stop_move_events(thread_id,new_cid,phase,at,data) VALUES (?,?,?,?,?)').run(thread_id, new_cid, row.phase, at, JSON.stringify(row));
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      this.notify(row);
    }
    if (row.execution_key !== this.deps.executionKey()) return { ok: false, detail: 'stop_move_execution_changed' };
    if (row.phase !== 'planned') return this.reconcile(row, backend);
    const f: Frozen = JSON.parse(row.request_json);
    const candidates: StopProtection[] = [];
    try {
      for (const cid of f.old_cids) {
        const p = await backend.getStopProtection(f.symbol, cid, f.market);
        if (this.proof(p, row, row.old_stop) && !candidates.some(x => (x.algo_id ?? x.client_order_id) === (p.algo_id ?? p.client_order_id))) candidates.push(p);
      }
    } catch {
      this.transition(row, 'failed', '发送前未能核实原保护，本次零写；允许原保护修复链继续'); return this.result(row);
    }
    if (candidates.length !== 1) {
      this.transition(row, 'failed', '发送前原保护缺失/不唯一/未确认，本次零写；允许原保护修复链继续'); return this.result(row);
    }
    const old = candidates[0]!;
    // 挂新撤旧不能顺带撤掉 OCO 内的止盈。当前 OKX 使用 amend；无 amend 的 OCO 明确拒绝。
    if (row.method === 'replace' && old.take_profit_price || row.method === 'amend' && (!backend.amendStop || !old.algo_id) || row.method === 'paper' && !backend.replacePaperStop) {
      this.transition(row, 'failed', 'stop_move_atomic_capability_missing'); return this.result(row);
    }
    row.old_cid = old.client_order_id; row.old_algo_id = old.algo_id; row.request_json = JSON.stringify({ ...f, old_proof: old });
    const before = this.guard(row, backend);
    if (!before) { this.transition(row, 'failed', 'stop_move_pre_submit_gate_rejected'); return this.result(row); }
    // 新 CID 只是待核归属，stop 仍是旧目标。崩溃后巡检也能识别已挂的新单，避免误走旧保护补挂/补偿路径。
    this.transition(row, 'submitted', 'CID/目标/原保护身份已持久化，即将调用执行通道', row.method === 'amend' ? undefined : {
      ...before, protection_client_order_ids: [...new Set([...before.protection_client_order_ids, row.new_cid])], version: before.version + 1, updated_at: Date.now(),
    });
    const req: StopMoveRequest = { ...f, old_stop: row.old_stop, target_stop: row.target_stop, new_cid: row.new_cid, old_cid: row.old_cid, old_algo_id: row.old_algo_id };
    let receipt;
    try {
      receipt = row.method === 'amend' ? await backend.amendStop!(req, () => !!this.guard(row!, backend)) : row.method === 'paper' ? await backend.replacePaperStop!(req)
        : await backend.placeStop(f.symbol, f.side, row.target_stop, row.new_cid, f.market);
    } catch { this.transition(row, 'unknown', '移损调用异常，按原 CID/algo 对账'); return this.reconcile(row, backend); }
    if (receipt.outcome === 'failed') {
      this.transition(row, 'failed', `新止损明确失败，保留原止损:${receipt.error ?? 'rejected'}`); return this.result(row);
    }
    // submitted 只是 ACK；unknown/filled 也必须核到仍活动的目标止损，不能当保护成功。
    return this.reconcile(row, backend);
  }
  private async reconcile(row: StopMoveRow, backend: ExecBackend): Promise<Result> {
    if (row.execution_key !== this.deps.executionKey() || this.deps.backend() !== backend) return { ok: false, detail: 'stop_move_execution_changed' };
    const f: Frozen = JSON.parse(row.request_json);
    let p: StopProtection | null = null;
    try { p = await backend.getStopProtection!(f.symbol, row.method === 'amend' ? row.old_cid! : row.new_cid, f.market, row.method === 'amend' ? row.old_algo_id : row.new_algo_id); } catch { /* unknown */ }
    if (!this.proof(p, row, row.target_stop) || row.method === 'amend' && p.take_profit_price !== f.old_proof?.take_profit_price) {
      this.transition(row, 'unknown', '目标止损未确认；保留原目标/CID，仅查询、不重发'); return this.result(row);
    }
    const recoveringCleanup = row.attention === 'STOP_MOVE_NEW_UNCONFIRMED';
    const current = this.guard(row, backend);
    if (!current) { this.transition(row, 'unknown', '新保护已查询到，但线程/执行环境变化，等待人工核对'); return this.result(row); }
    row.new_algo_id = p.algo_id;
    const cid = row.method === 'amend' ? row.old_cid! : row.new_cid;
    const next: StrategyThread = { ...current, stop_price: row.target_stop, protection_missing: false,
      protection_client_order_ids: [...new Set([...current.protection_client_order_ids, cid])],
      ...(current.run_take_profit ? { run_take_profit: { ...current.run_take_profit, stop_client_order_id: cid, stop_pending: false } } : {}),
      attention: current.attention === 'PROTECTION_MISSING' || current.attention === 'STOP_MOVE_NEW_UNCONFIRMED' ? null : current.attention, updated_at: Date.now(), version: current.version + 1 };
    // 先记 confirmed 与线程新 stop（同事务），再撤旧。崩溃时保留两张保护并阻止继续累积。
    if (row.method === 'replace') { row.attention = 'STOP_MOVE_OLD_CANCEL_PENDING'; next.attention = row.attention; }
    else next.protection_client_order_ids = next.protection_client_order_ids.filter(id => row.method === 'amend' || id !== row.old_cid);
    this.transition(row, 'confirmed', '精确查询确认新止损活动，线程 stop 已更新', next);
    if (row.method === 'replace') {
      let canceled: { ok: boolean; error: string | null } = { ok: false, error: '清理结果未知，仅读取原CID' };
      try { if (!recoveringCleanup) canceled = backend.cancelAlgoOrder ? await backend.cancelAlgoOrder(f.symbol, row.old_cid!, f.market) : await backend.cancelOrder(f.symbol, row.old_cid!, f.market); }
      catch (e) { canceled = { ok: false, error: String(e) }; }
      let gone = false;
      try {
        gone = backend.algoOrderExists ? await backend.algoOrderExists(f.symbol, row.old_cid!, f.market) === false
          : backend.kind === 'paper' && (await backend.getOrder(f.symbol, row.old_cid!, true, f.market))?.status === 'CANCELED';
      } catch { /* 撤单 ACK 不能证明旧单已消失 */ }
      let stillProtected: StopProtection | null = null;
      try { stillProtected = await backend.getStopProtection!(f.symbol, row.new_cid, f.market, row.new_algo_id); } catch { /* unknown */ }
      if (!this.proof(stillProtected, row, row.target_stop)) {
        row.attention = 'STOP_MOVE_NEW_UNCONFIRMED';
        const latest = this.deps.store.thread(row.thread_id);
        this.transition(row, 'unknown', '撤旧后新保护无法再次确认，保留原CID对账，不盲发', latest?.status === 'in_position'
          ? { ...latest, attention: row.attention, protection_missing: true, version: latest.version + 1, updated_at: Date.now() } : undefined);
        return this.result(row);
      }
      if (!gone) {
        row.attention = 'STOP_MOVE_OLD_CANCEL_FAILED';
        const latest = this.deps.store.thread(row.thread_id);
        this.transition(row, 'confirmed', `新止损已确认；撤旧失败/未知，两张保护可能并存:${canceled.error ?? '撤旧尚未核实'}`, latest?.status === 'in_position' ? { ...latest, attention: row.attention, version: latest.version + 1, updated_at: Date.now() } : undefined);
        return this.result(row);
      }
      row.attention = null;
      const latest = this.deps.store.thread(row.thread_id);
      this.transition(row, 'replaced', '移损替换完成', latest ? { ...latest,
        protection_client_order_ids: latest.protection_client_order_ids.filter(cid => cid !== row.old_cid),
        attention: latest.attention?.startsWith('STOP_MOVE_OLD_CANCEL_') ? ['PROTECTION_MISSING', 'STOP_MOVE_NEW_UNCONFIRMED'].includes(current.attention ?? '') ? null : current.attention : latest.attention,
        version: latest.version + 1, updated_at: Date.now() } : undefined);
      return this.result(row);
    }
    this.transition(row, 'replaced', '移损替换完成', next); return this.result(row);
  }
}
