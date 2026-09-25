/**
 * 订阅服务扇出(按服务过滤订阅者):市场情报 / 微观告警这类推送型订阅的定时推送。
 *
 * - 订阅者集合 = `subscribe-active --agent-id <asp>` 里 serviceId 对得上的 job;行里没有 serviceId 时用
 *   `my-subscriptions --role provider` 按 jobId 补。对不上服务的 job 一律不推(策略信号订阅者不会收到行情简报)。
 * - 没有任何订阅者时不调用频道 tick:不取数、不花模型钱。
 * - 新订阅的欢迎包不在这里:poller 接单(accept-subscription)后调 register.ts 里的 produce → 频道 welcome(),由 poller deliver。
 * - 账本:okx_market_service_push(一次推送一行,event_id 主键判重)+ okx_market_service_push_job(每订阅者一行)。
 *   与 MarketPublisher 同一口径:发出前落 pending,进程中断后 pending 标 failed「结果未知」,失败不自动重发。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { MarketCli } from '../cli.js';
import { data, list } from '../cli.js';
import { BANNED_WORDS } from '../publisher.js';
import type { ChannelDeps, ChannelPush, SubscriptionChannel } from './types.js';

export interface SubscriptionServiceDef { service_id: string; channels: SubscriptionChannel<any>[] }
export interface BroadcastDeps {
  db: DatabaseSync;
  cli: MarketCli;
  aspId(): Promise<string>;
  now(): number;
  kvGet(key: string): string | null;
  kvSet(key: string, value: string): void;
  log(level: 'info' | 'warn' | 'error', msg: string): void;
  emit?(event: string, payload: unknown): void;
  /** 4.6.2:deliver 前要先 `okx-a2a session create`;用 provider-tasks.ts 导出的 ensureBuyerSession,别另写 */
  ensureSession?(job_id: string, asp: string, buyer: string | null): Promise<void>;
  /** 各频道的业务依赖(BriefDeps / RadarDeps / MicroDeps …),与 ChannelDeps 合并后传给 tick/welcome */
  channelDeps(channel: string): Record<string, unknown>;
}

export function ensureBroadcastTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS okx_market_service_push (
    event_id TEXT PRIMARY KEY, service_id TEXT NOT NULL, channel TEXT NOT NULL, created_at INTEGER NOT NULL,
    summary TEXT NOT NULL, text TEXT NOT NULL, payload_json TEXT NOT NULL, subscribers_json TEXT NOT NULL, refusal TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS okx_market_service_push_job (
    event_id TEXT NOT NULL, job_id TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (event_id, job_id))`);
}

const jobOf = (r: Record<string, unknown>) => String(r['jobId'] ?? r['job_id'] ?? '');
const buyerOf = (r: Record<string, unknown>) => { const v = r['buyerAgentId'] ?? r['buyer_agent_id'] ?? r['userAgentId'] ?? r['user_agent_id']; return v === undefined || v === null || v === '' ? null : String(v); };
const serviceOf = (r: Record<string, unknown>) => { const v = r['serviceId'] ?? r['service_id'] ?? r['sid']; return v === undefined || v === null || v === '' ? null : String(v); };

export class ServiceBroadcaster {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly lastTick = new Map<string, number>();
  constructor(private readonly deps: BroadcastDeps, private readonly services: () => SubscriptionServiceDef[]) {
    ensureBroadcastTables(deps.db);
    deps.db.prepare("UPDATE okx_market_service_push_job SET status='failed',error='进程中断,投递结果未知;人工核实后可重发',updated_at=? WHERE status='pending'").run(deps.now());
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const p = this.chain.then(fn); this.chain = p.catch(() => {}); return p; }
  stop(): Promise<unknown> { return this.chain; }

  /** 频道依赖:ChannelDeps(状态 kv 按频道隔离)+ 业务依赖 */
  channelContext(channel: string): ChannelDeps & Record<string, unknown> {
    const prefix = `asp_services.channel.${channel}.`;
    return {
      ...this.deps.channelDeps(channel),
      now: () => this.deps.now(),
      state: { get: (k) => this.deps.kvGet(prefix + k), set: (k, v) => this.deps.kvSet(prefix + k, v) },
      log: (level, msg) => this.deps.log(level, `[${channel}] ${msg}`),
    };
  }

  /** 该服务当前活跃订阅 job(serviceId 精确匹配;行里缺 serviceId 时查 provider 视图补) */
  async subscribers(asp: string, service_id: string): Promise<{ job: string; buyer: string | null }[]> {
    const rows = list(await this.deps.cli.call('subscribe-active', ['--agent-id', asp]));
    let byJob: Map<string, Record<string, unknown>> | null = null;
    const out: { job: string; buyer: string | null }[] = [];
    for (const r of rows) {
      const job = jobOf(r); if (!job) continue;
      let sid = serviceOf(r), buyer = buyerOf(r);
      if (sid === null || buyer === null) {
        byJob ??= new Map(list(await this.deps.cli.call('my-subscriptions', ['--role', 'provider'])).map((x) => [jobOf(x), x]));
        const p = byJob.get(job);
        if (p) { sid ??= serviceOf(p); buyer ??= buyerOf(p); }
      }
      if (sid === service_id && !out.some((x) => x.job === job)) out.push({ job, buyer });
    }
    return out;
  }

  /** 定时器每分钟调一次:到期的频道才 tick;没有订阅者整服务跳过 */
  tick(): Promise<void> { return this.serial(async () => {
    const now = this.deps.now();
    const due = this.services().map((s) => ({ s, channels: s.channels.filter((c) => now - (this.lastTick.get(`${s.service_id}:${c.key}`) ?? 0) >= c.every_ms) })).filter((x) => x.channels.length);
    if (!due.length) return;
    let asp: string;
    try { asp = await this.deps.aspId(); } catch (e) { this.deps.log('warn', `没有 ASP 身份,跳过订阅推送:${(e as Error).message}`); return; }
    for (const { s, channels } of due) {
      let subs: { job: string; buyer: string | null }[];
      try { subs = await this.subscribers(asp, s.service_id); } catch (e) { this.deps.log('warn', `订阅者列表获取失败(${s.service_id}):${(e as Error).message}`); continue; }
      for (const c of channels) {
        this.lastTick.set(`${s.service_id}:${c.key}`, now);
        if (!subs.length) continue;
        let push: ChannelPush | null;
        try { push = await c.tick(this.channelContext(c.key)); } catch (e) { this.deps.log('error', `频道 ${c.key} 生成失败:${(e as Error).message}`); continue; }
        if (push) await this.fanOut(asp, s.service_id, push, subs);
      }
    }
  }); }

  /** 把一份推送发给该服务的订阅者;同 event_id 只发一次 */
  private async fanOut(asp: string, service_id: string, push: ChannelPush, subs: { job: string; buyer: string | null }[]): Promise<void> {
    const db = this.deps.db;
    if (db.prepare('SELECT 1 FROM okx_market_service_push WHERE event_id=?').get(push.event_id)) return;
    const refusal = BANNED_WORDS.test(push.text) ? '敏感词拦截:禁止收益保证' : null;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO okx_market_service_push VALUES (?,?,?,?,?,?,?,?,?)').run(push.event_id, service_id, push.channel, this.deps.now(), push.summary, push.text, JSON.stringify(push.payload), JSON.stringify(subs.map((x) => x.job)), refusal);
      if (!refusal) for (const { job } of subs) db.prepare("INSERT INTO okx_market_service_push_job(event_id,job_id,status,updated_at) VALUES (?,?,'pending',?)").run(push.event_id, job, this.deps.now());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    if (refusal) { this.deps.log('warn', `${push.event_id} 被敏感词拦截,未推送`); return; }
    for (const { job, buyer } of subs) await this.send(push.event_id, job, asp, buyer, push.text);
    this.deps.emit?.('market_service_push', this.get(push.event_id));
  }

  private async send(event_id: string, job: string, asp: string, buyer: string | null, text: string): Promise<void> {
    const db = this.deps.db;
    const claim = db.prepare("UPDATE okx_market_service_push_job SET attempts=attempts+1,updated_at=? WHERE event_id=? AND job_id=? AND status='pending' AND attempts=0").run(this.deps.now(), event_id, job);
    if (!claim.changes) return;
    try {
      await this.deps.ensureSession?.(job, asp, buyer);
      data(await this.deps.cli.call('deliver', [job, '--deliverable-text', text, '--agent-id', asp]));
      db.prepare("UPDATE okx_market_service_push_job SET status='delivered',error=NULL,updated_at=? WHERE event_id=? AND job_id=?").run(this.deps.now(), event_id, job);
    } catch (e) {
      db.prepare("UPDATE okx_market_service_push_job SET status='failed',error=?,updated_at=? WHERE event_id=? AND job_id=?").run((e as Error).message.slice(0, 2000), this.deps.now(), event_id, job);
    }
  }

  get(event_id: string): Record<string, unknown> | null {
    const row = this.deps.db.prepare('SELECT * FROM okx_market_service_push WHERE event_id=?').get(event_id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const jobs = this.deps.db.prepare('SELECT job_id,status,attempts,error,updated_at FROM okx_market_service_push_job WHERE event_id=? ORDER BY job_id').all(event_id);
    return { event_id, service_id: row['service_id'], channel: row['channel'], created_at: row['created_at'], summary: row['summary'], refusal: row['refusal'], subscribers: JSON.parse(String(row['subscribers_json'])), jobs };
  }
  recent(limit = 50): Record<string, unknown>[] {
    return this.deps.db.prepare('SELECT event_id FROM okx_market_service_push ORDER BY created_at DESC LIMIT ?').all(limit).map((r) => this.get(String((r as Record<string, unknown>)['event_id']))!);
  }
}
