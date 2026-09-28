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
import { ServiceInputError, type BroadcastChannelKey, type ChannelDeps, type ChannelKey, type ChannelPush, type Deliverable, type PerCallJob, type PerCallService, type ServiceDeps, type ServiceKey, type SubscriptionChannel } from './types.js';
import { infoSignal, signalFor } from './broadcast.js';

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
  channelContext(channel: BroadcastChannelKey): ChannelDeps & Record<string, unknown>;
  /** 付费模型类服务的额外可用性闸(Jev 未绑定 / 条款未确认 → 拒单理由) */
  available?(listing: ListingKey): string | null;
  db: DatabaseSync;
  now(): number;
  /** produce 单轮最多等多久(测试调小) */
  produce_wait_ms?: number;
  /** 服务方暂停接单(kv asp_services.paused):decide 一律拒单;已接的单照常交付 */
  paused?(listing: ListingKey): boolean;
}

export function ensureResultTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS okx_market_service_result (
    job_id TEXT PRIMARY KEY, listing TEXT NOT NULL, service_id TEXT, created_at INTEGER NOT NULL,
    summary TEXT NOT NULL, sha256 TEXT, payload_json TEXT NOT NULL, anchor_json TEXT)`);
  db.exec('CREATE TABLE IF NOT EXISTS okx_market_service_attempt (job_id TEXT PRIMARY KEY, failures INTEGER NOT NULL, last_error TEXT, updated_at INTEGER NOT NULL)');
}

const reject = (reason: string): ProviderDecision => ({ accept: false, reason: [...reason].slice(0, 500).join('') });
/** 暂停接单时的拒单理由(买方可见,英文;策略信号的包装 handler 也用这一句) */
export const PAUSE_REASON = 'The provider has paused new orders for this service.';
/** 暂停闸:暂停中返回拒单决定,否则 null */
export function pauseGate(paused: boolean): ProviderDecision | null { return paused ? reject(PAUSE_REASON) : null; }

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
      if (task.kind !== 'one_time') return reject(`${listing.name} is a one-time service and does not accept subscriptions.`);
      const paused = pauseGate(!!d.paused?.(listing.key)); if (paused) return paused;
      const gate = d.available?.(listing.key); if (gate) return reject(gate);
      try { svc.validate(jobFromTask(task, listing)); return { accept: true }; }
      catch (e) { return reject(e instanceof ServiceInputError ? e.message : `Could not parse your request: ${(e as Error).message}`); }
    },
    async produce(task): Promise<ProviderOutput> {
      const job = jobFromTask(task, listing);
      // 生成放后台跑(矩阵研究要 10–30 分钟):轮询器串行处理所有单,这里最多等 PRODUCE_WAIT_MS,没跑完就抛「生成中」让它先去处理别的单,下一轮再来取
      let p = inflight.get(job.job_id);
      if (!p) { p = Promise.resolve().then(() => svc.handle(job, svc.validate(job), d.serviceDeps())); inflight.set(job.job_id, p); p.catch(() => {}); }
      const settled = await Promise.race([p.then((v) => ({ ok: v }), (e: unknown) => ({ err: e as Error })), wait(d.produce_wait_ms ?? PRODUCE_WAIT_MS)]);
      if (!settled) throw new Error('生成中,下一轮再取结果 / still running');
      inflight.delete(job.job_id);
      let out: Deliverable;
      try { if ('err' in settled) throw settled.err; out = settled.ok; }
      catch (e) {
        if (e instanceof ServiceInputError) return { skip: `${e.code}:${e.message}` };
        // 接单后生成失败(数据源/网络):前几次抛出让轮询下一轮重试;连续失败到上限就如实交付失败说明,不让已付款的单无限挂着
        const n = failures(d, job.job_id, (e as Error).message);
        if (n < MAX_PRODUCE_FAILURES) throw e;
        record(d, job.job_id, listing.key, sid, `failed: ${(e as Error).message.slice(0, 120)}`, null, { error: (e as Error).message.slice(0, 500), attempts: n });
        return { text: failureText(listing, (e as Error).message) };
      }
      record(d, job.job_id, listing.key, sid, out.summary, out.sha256, out.payload);
      return { text: out.text };
    },
  };
}

function subscriptionHandler(listing: ListingDef, sid: string, d: RegisterDeps): ProviderHandler | null {
  const chans = (listing.channels ?? []).map((k) => d.channels[k]).filter((c): c is SubscriptionChannel<any> => !!c);
  if (!chans.length) return null;
  return {
    decide(task) {
      if (task.kind !== 'subscription') return reject(`${listing.name} is a subscription service and does not accept one-time orders.`);
      return pauseGate(!!d.paused?.(listing.key)) ?? { accept: true };
    },
    async produce(task): Promise<ProviderOutput> {
      // 先发一条合规信号行(【Futures】… ≤200 字,平台审核按它判「发了信号」),各频道欢迎包全文作为详情逐条跟上
      const pushes: ChannelPush[] = []; const parts: string[] = [];
      for (const c of chans) {
        try { const p = await c.welcome(d.channelContext(c.key)); pushes.push(p); parts.push(p.text); }
        catch { parts.push(`${listing.name}: the ${c.key.replace(/_/g, ' ')} section is temporarily unavailable and will be included in the next scheduled push.`); }
      }
      const text = pushes.length ? signalFor(pushes[0]!) : infoSignal(`【Futures】OKX perps | ${listing.name}`, 'Subscription active. Data sources are warming up; the first scheduled push follows shortly.');
      record(d, task.job_id, listing.key, sid, `welcome ${listing.key}`, null, { channels: chans.map((c) => c.key), signal: text });
      return { text, follow_up: parts };
    },
  };
}

export const MAX_PRODUCE_FAILURES = 3;
export const PRODUCE_WAIT_MS = 15_000;
/** 进行中的按次生成(进程内;重启后重新发起,矩阵研究靠幂等键续上同一个研究) */
const inflight = new Map<string, Promise<Deliverable>>();
const wait = (ms: number) => new Promise<null>((r) => { const t = setTimeout(() => r(null), ms); (t as { unref?: () => void }).unref?.(); });
function failures(d: RegisterDeps, job_id: string, error: string): number {
  d.db.prepare(`INSERT INTO okx_market_service_attempt(job_id,failures,last_error,updated_at) VALUES (?,1,?,?)
    ON CONFLICT(job_id) DO UPDATE SET failures=failures+1,last_error=excluded.last_error,updated_at=excluded.updated_at`).run(job_id, error.slice(0, 1000), d.now());
  return Number((d.db.prepare('SELECT failures FROM okx_market_service_attempt WHERE job_id=?').get(job_id) as { failures: number }).failures);
}
function failureText(listing: ListingDef, error: string): string {
  const why = /network|socket|TLS|timed? ?out|429|ECONN|fetch failed/i.test(error) ? 'the market data source timed out or was rate-limited' : 'an error occurred while generating the result';
  return [`【${listing.name}】Could not complete`, `This order could not be generated after ${MAX_PRODUCE_FAILURES} retries because ${why}; no analysis was delivered.`, 'Please reject this delivery for a refund, or place the order again later.'].join('\n');
}

function record(d: RegisterDeps, job_id: string, listing: ListingKey, sid: string, summary: string, sha256: string | null, payload: Record<string, unknown>): void {
  d.db.prepare('INSERT OR REPLACE INTO okx_market_service_result(job_id,listing,service_id,created_at,summary,sha256,payload_json,anchor_json) VALUES (?,?,?,?,?,?,?,NULL)')
    .run(job_id, listing, sid, d.now(), summary, sha256, JSON.stringify(payload));
}
