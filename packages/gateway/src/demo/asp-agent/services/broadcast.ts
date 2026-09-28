/**
 * 订阅服务扇出(按服务过滤订阅者):市场情报 / 微观告警这类推送型订阅的定时推送。
 *
 * - 订阅者集合 = `subscribe-active --agent-id <asp>` 里 serviceId 对得上的 job;行里没有 serviceId 时用
 *   `my-subscriptions --role provider` 按 jobId 补。对不上服务的 job 一律不推(策略信号订阅者不会收到行情简报)。
 * - 没有任何订阅者时不调用频道 tick:不取数、不花模型钱。
 * - 新订阅的欢迎包不在这里:poller 接单(accept-subscription)后调 register.ts 里的 produce → 频道 welcome(),由 poller deliver。
 * - 账本:okx_market_service_push(一次推送一行,event_id 主键判重)+ okx_market_service_push_job(每订阅者一行)。
 *   发出前落 pending,进程中断后 pending 标 failed「结果未知」;失败的投递 6 小时内冷却 5 分钟自动重发,最多 4 次(retryable)。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { MarketCli } from '../cli.js';
import { CliError, data, list, object } from '../cli.js';
import { BANNED_WORDS, SIGNAL_MAX_CHARS, validateSignalText } from '../publisher.js';
import { symbolToInstId } from '../../okx/instruments.js';
import type { ChannelDeps, ChannelPush, SubscriptionChannel } from './types.js';

const INFO_TAIL = ' | Info only, no order | Trading Swarm';
export const MAX_PUSH_ATTEMPTS = 4;
export const RETRY_AFTER_MS = 5 * 60_000;
export const RETRY_WINDOW_MS = 6 * 3_600_000;
/** 信息类订阅的一行信号:【Futures】类型头 + 标的 + 正文,整行 ≤200 字(正文超长截断,尾巴保留)。 */
export function infoSignal(head: string, body: string): string {
  const room = SIGNAL_MAX_CHARS - [...head].length - [...INFO_TAIL].length - 3;
  const b = body.replace(/\s+/g, ' ').trim();
  const clipped = [...b].length <= room ? b : `${[...b].slice(0, Math.max(0, room - 1)).join('')}…`;
  return `${head} | ${clipped}${INFO_TAIL}`;
}
/**
 * 一份推送对应的订阅信号行。OKX.AI 审核只把【Futures】/【Spot】等类型头开头、≤200 字的交付算作「发送了信号」,
 * 长段落简报不算;频道自带合规的 signal 就用它,否则按频道从 summary / payload 派生。
 */
export function signalFor(push: ChannelPush): string {
  if (push.signal) { const v = validateSignalText(push.signal); if (v.ok && v.executable) return push.signal; }
  const p = push.payload;
  switch (push.channel) {
    case 'market_brief': return infoSignal('【Futures】BTC-USDT-SWAP, ETH-USDT-SWAP | Market brief', `${typeof p['summary_line'] === 'string' ? `${p['summary_line']}. ` : ''}${push.summary}`);
    case 'radar_feed': {
      const picks = Array.isArray(p['picks']) ? (p['picks'] as Record<string, unknown>[]).map((x) => x['symbol']).filter((x): x is string => typeof x === 'string').slice(0, 5) : [];
      return infoSignal('【Futures】OKX perps | Radar picks', `${picks.length ? `Top: ${picks.map((x) => x.replace(/USDT$/, '')).join(', ')}. ` : ''}${push.summary}`);
    }
    case 'micro_alerts': {
      const sym = typeof p['symbol'] === 'string' && p['symbol'] !== 'ALL' ? symbolToInstId(p['symbol'], 'perp') : 'BTC-USDT-SWAP, ETH-USDT-SWAP';
      return infoSignal(`【Futures】${sym} | Microstructure`, push.summary);
    }
    default: return infoSignal('【Futures】OKX perps | Update', push.summary);
  }
}

export interface SubscriptionServiceDef { service_id: string; channels: SubscriptionChannel<any>[]; /** 服务方暂停接单:整服务跳过扇出(不取数、不推送) */ paused?: boolean }
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

  /**
   * 该服务当前活跃订阅 job(serviceId 精确匹配)。subscribe-active 只给 jobId/status,serviceId 和买方按序补:
   * kv 缓存(订阅的服务与买方不会变)→ my-subscriptions(provider 视图,常报超时/agenticId 缺失)→ subscribe-detail 单查。
   * 只有 subscribe-active 本身失败才整轮放弃(官方口径:查询失败不沿用旧名单)。
   */
  async subscribers(asp: string, service_id: string): Promise<{ job: string; buyer: string | null }[]> {
    const rows = list(await this.deps.cli.call('subscribe-active', ['--agent-id', asp]));
    let byJob: Map<string, Record<string, unknown>> | null = null; let byJobFailed = false;
    const out: { job: string; buyer: string | null }[] = [];
    for (const r of rows) {
      const job = jobOf(r); if (!job) continue;
      const kSid = `asp_services.job_service.${job}`, kBuyer = `asp_services.job_buyer.${job}`;
      let sid = serviceOf(r) ?? this.deps.kvGet(kSid), buyer = buyerOf(r) ?? this.deps.kvGet(kBuyer);
      if ((sid === null || buyer === null) && !byJobFailed) {
        try { byJob ??= new Map(list(await this.deps.cli.call('my-subscriptions', ['--role', 'provider'])).map((x) => [jobOf(x), x])); }
        catch (e) { byJobFailed = true; this.deps.log('warn', `my-subscriptions 失败,改逐单 subscribe-detail:${(e as Error).message.slice(0, 160)}`); }
        const p = byJob?.get(job);
        if (p) { sid ??= serviceOf(p); buyer ??= buyerOf(p); }
      }
      if (sid === null || buyer === null) {
        try { const d = object(data(await this.deps.cli.call('subscribe-detail', [job, '--format', 'json']))); sid ??= serviceOf(d); buyer ??= buyerOf(d); }
        catch (e) { this.deps.log('warn', `subscribe-detail ${job} 失败:${(e as Error).message.slice(0, 160)}`); }
      }
      if (sid !== null) this.deps.kvSet(kSid, sid);
      if (buyer !== null) this.deps.kvSet(kBuyer, buyer);
      if (sid === service_id && !out.some((x) => x.job === job)) out.push({ job, buyer });
    }
    return out;
  }

  /** 定时器每分钟调一次:到期的频道才 tick;没有订阅者整服务跳过;先补发近期失败的投递 */
  tick(): Promise<void> { return this.serial(async () => {
    const now = this.deps.now();
    const due = this.services().filter((s) => !s.paused).map((s) => ({ s, channels: s.channels.filter((c) => now - (this.lastTick.get(`${s.service_id}:${c.key}`) ?? 0) >= c.every_ms) })).filter((x) => x.channels.length);
    const retry = this.retryable(now);
    if (!due.length && !retry.length) return;
    let asp: string;
    try { asp = await this.deps.aspId(); } catch (e) { this.deps.log('warn', `没有 ASP 身份,跳过订阅推送:${(e as Error).message}`); return; }
    for (const r of retry) await this.send(r.event_id, r.job_id, asp, this.deps.kvGet(`asp_services.job_buyer.${r.job_id}`), r.signal, r.detail, true);
    for (const { s, channels } of due) {
      let subs: { job: string; buyer: string | null }[];
      try { subs = await this.subscribers(asp, s.service_id); } catch (e) { this.deps.log('warn', `订阅者列表获取失败(${s.service_id}):${(e as Error).message}`); continue; }
      // 没有订阅者不记 lastTick:第一个订阅者进来后下一分钟就推,不用等满一个周期
      if (!subs.length) continue;
      for (const c of channels) {
        this.lastTick.set(`${s.service_id}:${c.key}`, now);
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
    const signal = signalFor(push);
    const refusal = BANNED_WORDS.test(push.text) || BANNED_WORDS.test(signal) ? '敏感词拦截:禁止收益保证' : null;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO okx_market_service_push VALUES (?,?,?,?,?,?,?,?,?)').run(push.event_id, service_id, push.channel, this.deps.now(), push.summary, push.text, JSON.stringify({ ...push.payload, signal }), JSON.stringify(subs.map((x) => x.job)), refusal);
      if (!refusal) for (const { job } of subs) db.prepare("INSERT INTO okx_market_service_push_job(event_id,job_id,status,updated_at) VALUES (?,?,'pending',?)").run(push.event_id, job, this.deps.now());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    if (refusal) { this.deps.log('warn', `${push.event_id} 被敏感词拦截,未推送`); return; }
    for (const { job, buyer } of subs) await this.send(push.event_id, job, asp, buyer, signal, push.text === signal ? null : push.text);
    this.deps.emit?.('market_service_push', this.get(push.event_id));
  }

  /**
   * 近 RETRY_WINDOW_MS 内失败、冷却满 RETRY_AFTER_MS、尝试不足 MAX_PUSH_ATTEMPTS 的投递(网络抖动/CLI 超时,09-26 实测每小时 20–40 次)。
   * 超时的「结果未确认」也重发:信号行重复一条无害,漏发会让订阅服务掉进平台「12 小时没发信号」的判定。
   */
  private retryable(now: number): { event_id: string; job_id: string; signal: string; detail: string | null }[] {
    const rows = this.deps.db.prepare(`SELECT j.event_id, j.job_id, p.text, p.payload_json FROM okx_market_service_push_job j JOIN okx_market_service_push p USING(event_id)
      WHERE j.status='failed' AND j.attempts < ? AND j.updated_at BETWEEN ? AND ? AND p.refusal IS NULL ORDER BY j.updated_at LIMIT 20`).all(MAX_PUSH_ATTEMPTS, now - RETRY_WINDOW_MS, now - RETRY_AFTER_MS) as Record<string, unknown>[];
    return rows.map((r) => {
      const text = String(r['text']); let signal = text;
      try { const s = (JSON.parse(String(r['payload_json'])) as Record<string, unknown>)['signal']; if (typeof s === 'string' && s) signal = s; } catch {}
      return { event_id: String(r['event_id']), job_id: String(r['job_id']), signal, detail: text === signal ? null : text };
    });
  }

  /** 先 deliver 信号行(账本状态只跟它走),成功后再补一条详情(尽力而为,失败只记日志) */
  private async send(event_id: string, job: string, asp: string, buyer: string | null, signal: string, detail: string | null, retry = false): Promise<void> {
    const db = this.deps.db;
    const claim = retry
      ? db.prepare("UPDATE okx_market_service_push_job SET status='pending',attempts=attempts+1,updated_at=? WHERE event_id=? AND job_id=? AND status='failed' AND attempts<?").run(this.deps.now(), event_id, job, MAX_PUSH_ATTEMPTS)
      : db.prepare("UPDATE okx_market_service_push_job SET attempts=attempts+1,updated_at=? WHERE event_id=? AND job_id=? AND status='pending' AND attempts=0").run(this.deps.now(), event_id, job);
    if (!claim.changes) return;
    const delivered = () => db.prepare("UPDATE okx_market_service_push_job SET status='delivered',error=NULL,updated_at=? WHERE event_id=? AND job_id=?").run(this.deps.now(), event_id, job);
    try {
      await this.deps.ensureSession?.(job, asp, buyer);
      data(await this.deps.cli.call('deliver', [job, '--deliverable-text', signal, '--agent-id', asp]));
      delivered();
    } catch (e) {
      // 4.6.2 的 deliver 成功时可能 exit 0 且不打 JSON(MarketCli 报 cli_invalid_json);exit 0 即 CLI 认定成功(与 provider-tasks 同口径)
      if (e instanceof CliError && e.code === 'cli_invalid_json') delivered();
      else { db.prepare("UPDATE okx_market_service_push_job SET status='failed',error=?,updated_at=? WHERE event_id=? AND job_id=?").run((e as Error).message.slice(0, 2000), this.deps.now(), event_id, job); return; }
    }
    if (!detail) return;
    try { await this.deps.cli.call('deliver', [job, '--deliverable-text', detail, '--agent-id', asp]); }
    catch (e) { if (!(e instanceof CliError && e.code === 'cli_invalid_json')) this.deps.log('warn', `详情补发失败 ${event_id} → ${job}:${(e as Error).message.slice(0, 200)}`); }
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
