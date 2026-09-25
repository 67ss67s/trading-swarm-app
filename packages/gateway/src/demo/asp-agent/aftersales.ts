import type { DemoStore } from '../store.js';
import { MarketCli, data } from './cli.js';
import { captainHandoff, startAspRun } from './audit.js';
import { normMs } from './inbox.js';
export class MarketAftersales {
  constructor(private readonly deps: { store: DemoStore; cli: MarketCli; aspId: () => Promise<string>; emit: (event: string, payload: unknown) => void; activity: (title: string) => void }) {}
  private get db() { return this.deps.store.marketDb; }
  async receive(e: Record<string, unknown>, id: string): Promise<void> {
    if (this.db.prepare('SELECT 1 FROM okx_market_aftersale WHERE event_id=?').get(id)) return;
    const event = String(e['event']); const job = String(e['jobId'] ?? 'unknown');
    const asp = String(e['agentId'] ?? e['aspAgentId'] ?? '');
    const deadline = normMs(e['rejectWindowEndsAt'] ?? e['deadline'] ?? e['deadlineAt'] ?? e['rejectDeadline']) ?? Date.now() + 86400000;
    this.db.prepare('INSERT INTO okx_market_aftersale(event_id,job_id,event,asp_id,buyer,period,reason,deadline,received_at,status,raw) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, job, event, asp, String(e['buyer'] ?? e['buyerAgentId'] ?? ''), String(e['periodIndex'] ?? e['period'] ?? ''), String(e['reason'] ?? ''), deadline, Date.now(), event === 'sub_user_reject' ? 'pending' : 'received', JSON.stringify(e));
    if (event === 'sub_user_reject') {
      const run = startAspRun(this.deps.store, 'asp_aftersale', { event: e });
      captainHandoff(this.deps.store, `reject:${id}`, '订阅者拒收，等待退款或争议处理', { job_id: job, event_id: id, event: e }, deadline);
      this.deps.store.bots.finishRun(run, { status: 'done', result: { pending: true, job_id: job } });
    } else if (event === 'sub_renew') {
      const run = startAspRun(this.deps.store, 'asp_claim', { event: e });
      this.db.prepare("UPDATE okx_market_aftersale SET status='processing' WHERE event_id=?").run(id);
      try {
        const r = await this.deps.cli.call('subscribe-asp-claim', [job, '--agent-id', asp || await this.deps.aspId()]);
        this.db.prepare("UPDATE okx_market_aftersale SET status='done',result_json=? WHERE event_id=?").run(JSON.stringify(data(r)), id);
        this.deps.store.bots.finishRun(run, { status: 'done', result: data(r) });
      } catch (e) { this.db.prepare("UPDATE okx_market_aftersale SET status='failed',result_json=? WHERE event_id=?").run(JSON.stringify({ error: (e as Error).message }), id); this.deps.store.bots.finishRun(run, { status: 'failed', error: (e as Error).message }); }
    } else if (event === 'sub_asp_selected') this.deps.activity('新订阅者');
    this.deps.emit('market_aftersale', { event_id: id, job_id: job, event });
  }
  rows(): Record<string, unknown>[] { return this.db.prepare('SELECT * FROM okx_market_aftersale ORDER BY received_at DESC LIMIT 500').all().map(({ raw, result_json, ...r }) => ({ ...r, result: result_json ? JSON.parse(String(result_json)) : null })); }
  async decide(job: string, decision: 'agree_refund' | 'dispute', reason?: string) {
    if (decision === 'dispute' && !reason?.trim()) throw Object.assign(new Error('争议必须填写理由'), { status: 400 });
    const rows = this.db.prepare("SELECT * FROM okx_market_aftersale WHERE job_id=? AND event='sub_user_reject' AND status='pending' ORDER BY received_at DESC").all(job);
    if (rows.length !== 1) throw Object.assign(new Error('需要唯一待处理拒收记录'), { status: 409 });
    const row = rows[0]!;
    if (Number(row['deadline']) < Date.now()) throw Object.assign(new Error('处理期限已过'), { status: 409 });
    const claimed = this.db.prepare("UPDATE okx_market_aftersale SET status='processing',decision=? WHERE event_id=? AND status='pending'").run(decision, String(row['event_id']));
    if (!claimed.changes) throw Object.assign(new Error('售后正在处理'), { status: 409 });
    const run = startAspRun(this.deps.store, 'asp_aftersale', { job_id: job, decision, reason: reason ?? null });
    try {
      const r = data(await this.deps.cli.call(decision === 'agree_refund' ? 'subscribe-agree-refund' : 'subscribe-dispute', [job, '--agent-id', String(row['asp_id']) || await this.deps.aspId(), ...(reason ? ['--reason', reason] : [])]));
      this.db.prepare("UPDATE okx_market_aftersale SET status='done',result_json=? WHERE event_id=?").run(JSON.stringify(r), String(row['event_id']));
      this.deps.store.bots.finishRun(run, { status: 'done', result: r }); this.deps.emit('market_aftersale', { job_id: job, decision, result: r }); return r;
    } catch (e) {
      this.db.prepare("UPDATE okx_market_aftersale SET status='failed',result_json=? WHERE event_id=?").run(JSON.stringify({ error: (e as Error).message }), String(row['event_id']));
      this.deps.store.bots.finishRun(run, { status: 'failed', error: (e as Error).message }); throw e;
    }
  }
}
