/**
 * 把按次处理器与订阅频道挂到 provider 轮询上:每个已上架服务注册 `service:<serviceId>`。
 * serviceId 上架后才有,从配置读(kv `asp_services.config`),没配的服务不注册 → poller 对它 no_handler、不接单。
 *
 * - 按次:decide = validate(只解析校验,不取数不花钱;不合格拒单并给理由);produce = validate + handle → 交付全文。
 *   同一处理器分档上架(研究报告 quick/full)时,把档位作为强制参数并进 service_params。
 * - 订阅:decide = 接;produce = 各频道 welcome() 拼成的欢迎包(订阅一生效就有内容,避免「长时间无内容」被拒)。
 *   之后的定时推送归 ServiceBroadcaster。
 * - 每次交付的哈希与摘要记进 okx_market_service_result,供链上存证与界面查询。
 */
import type { DatabaseSync } from 'node:sqlite';
import { LISTINGS, type ListingDef, type ListingKey } from './catalog.js';
import { jsonParams } from './params.js';
import type { ProviderDecision, ProviderHandler, ProviderOutput, ProviderTask, RegisterProviderHandler } from './provider-contract.js';
import { ServiceInputError, type ChannelDeps, type ChannelKey, type Deliverable, type PerCallJob, type PerCallService, type ServiceDeps, type ServiceKey, type SubscriptionChannel } from './types.js';

export interface AspServicesConfig { service_ids: Partial<Record<ListingKey, string>> }
export function readConfig(kvGet: (k: string) => string | null): AspServicesConfig {
  try { const v = JSON.parse(kvGet('asp_services.config') ?? '{}') as Partial<AspServicesConfig>; return { service_ids: v.service_ids && typeof v.service_ids === 'object' ? v.service_ids : {} }; }
  catch { return { service_ids: {} }; }
}

const str = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v : typeof v === 'number' ? String(v) : null;
const pick = (objs: (Record<string, unknown> | null)[], keys: string[]): unknown => {
  for (const o of objs) if (o) for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return null;
};

/** ProviderTask → PerCallJob;字段名驼峰/下划线都认,serviceParams 可能是对象也可能是字符串 */
export function jobFromTask(task: ProviderTask, listing: ListingDef): PerCallJob {
  const srcs = [task.detail, task.raw];
  const description = str(pick(srcs, ['description', 'taskDescription', 'task_description', 'jobDescription', 'job_description', 'requirement'])) ?? task.title ?? '';
  const rawParams = pick(srcs, ['serviceParams', 'service_params', 'params']);
  let service_params = rawParams === null ? null : typeof rawParams === 'string' ? rawParams : JSON.stringify(rawParams);
  let desc = description;
  const force = listing.handler?.force;
  if (force) {
    const job0: PerCallJob = { job_id: task.job_id, service_key: listing.handler!.service, description, service_params };
    const j = jsonParams(job0);
    if (j) service_params = JSON.stringify({ ...j, ...force });
    else { if (service_params) desc = `${description}\n${service_params}`; service_params = JSON.stringify(force); }
  }
  return { job_id: task.job_id, service_key: listing.handler!.service, description: desc, service_params, buyer_agent_id: task.buyer_agent_id };
}

export interface RegisterDeps {
  register: RegisterProviderHandler;
  config: AspServicesConfig;
  handlers: Partial<Record<string, PerCallService<any>>>;
  channels: Partial<Record<ChannelKey, SubscriptionChannel<any>>>;
  serviceDeps(): ServiceDeps;
  /** broadcaster.channelContext(channel):欢迎包与定时推送用同一份频道状态 */
  channelContext(channel: ChannelKey): ChannelDeps & Record<string, unknown>;
  /** 付费模型类服务的额外可用性闸(Jev 未绑定 / 条款未确认 → 拒单理由) */
  available?(listing: ListingKey): string | null;
  db: DatabaseSync;
  now(): number;
}

export function ensureResultTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS okx_market_service_result (
    job_id TEXT PRIMARY KEY, listing TEXT NOT NULL, service_id TEXT, created_at INTEGER NOT NULL,
    summary TEXT NOT NULL, sha256 TEXT, payload_json TEXT NOT NULL, anchor_json TEXT)`);
}

const reject = (reason: string): ProviderDecision => ({ accept: false, reason: [...reason].slice(0, 500).join('') });

/** 注册全部已配置 serviceId 的服务;返回注销函数 */
export function registerAspServices(d: RegisterDeps): () => void {
  ensureResultTable(d.db);
  const offs: (() => void)[] = [];
  for (const [key, sid] of Object.entries(d.config.service_ids) as [ListingKey, string][]) {
    const listing = LISTINGS[key];
    if (!listing || !sid) continue;
    const handler = listing.kind === 'one_time' ? perCallHandler(listing, sid, d) : subscriptionHandler(listing, sid, d);
    if (handler) offs.push(d.register(`service:${sid}`, handler));
  }
  return () => { for (const off of offs) off(); };
}

function perCallHandler(listing: ListingDef, sid: string, d: RegisterDeps): ProviderHandler | null {
  const svc = d.handlers[listing.handler!.service];
  if (!svc) return null;
  return {
    decide(task) {
      if (task.kind !== 'one_time') return reject(`该服务是按次服务,不接订阅 / ${listing.name} is a one-time service`);
      const gate = d.available?.(listing.key); if (gate) return reject(gate);
      try { svc.validate(jobFromTask(task, listing)); return { accept: true }; }
      catch (e) { return reject(e instanceof ServiceInputError ? e.message : `输入无法解析 / invalid input: ${(e as Error).message}`); }
    },
    async produce(task): Promise<ProviderOutput> {
      const job = jobFromTask(task, listing);
      let out: Deliverable;
      try { out = await svc.handle(job, svc.validate(job), d.serviceDeps()); }
      catch (e) { if (e instanceof ServiceInputError) return { skip: `${e.code}:${e.message}` }; throw e; }
      record(d, job.job_id, listing.key, sid, out.summary, out.sha256, out.payload);
      return { text: out.file ? `${out.text}\n${out.file.content}` : out.text };
    },
  };
}

function subscriptionHandler(listing: ListingDef, sid: string, d: RegisterDeps): ProviderHandler | null {
  const chans = (listing.channels ?? []).map((k) => d.channels[k]).filter((c): c is SubscriptionChannel<any> => !!c);
  if (!chans.length) return null;
  return {
    decide(task) { return task.kind === 'subscription' ? { accept: true } : reject(`该服务是订阅服务 / ${listing.name} is a subscription service`); },
    async produce(task): Promise<ProviderOutput> {
      const parts: string[] = [];
      for (const c of chans) {
        try { parts.push((await c.welcome(d.channelContext(c.key))).text); }
        catch (e) { parts.push(`【${c.key}】暂时无法生成,下一轮推送补上 / temporarily unavailable: ${(e as Error).message.slice(0, 120)}`); }
      }
      const text = parts.join('\n\n');
      record(d, task.job_id, listing.key, sid, `welcome ${listing.key}`, null, { channels: chans.map((c) => c.key) });
      return { text };
    },
  };
}

function record(d: RegisterDeps, job_id: string, listing: ListingKey, sid: string, summary: string, sha256: string | null, payload: Record<string, unknown>): void {
  d.db.prepare('INSERT OR REPLACE INTO okx_market_service_result(job_id,listing,service_id,created_at,summary,sha256,payload_json,anchor_json) VALUES (?,?,?,?,?,?,?,NULL)')
    .run(job_id, listing, sid, d.now(), summary, sha256, JSON.stringify(payload));
}
