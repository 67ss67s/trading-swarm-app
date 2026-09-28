/** ASP 对话读模型:只 SELECT / 读现有内存快照。不得构造 AspAgent,不得刷新 CLI 或推进账本。 */
import type { DatabaseSync } from 'node:sqlite';
import { cachedAspIdentity } from './identity.js';
import { providerTaskRows, type ProviderTaskPoller } from './provider-tasks.js';
import { marketInboxRows } from './inbox.js';
import { subscriptionDisplay, SUBSCRIPTION_GROUP_ORDER } from './agent.js';
import { object } from './cli.js';
import { normalizePublisherSettings } from './settings.js';
import { LISTING_KEYS, LISTINGS, DEFAULT_PRICES, type ListingKey } from './services/catalog.js';
import { readConfig } from './services/register.js';
import type { AspServices } from './services/index.js';

export const ASP_CHAT_TOOLS = ['get_asp_overview', 'list_asp_services', 'list_asp_tasks', 'list_asp_subscribers', 'list_market_inbox'] as const;
type Block = Record<string, unknown> & { ready: boolean };
type Live = { services?: ReturnType<AspServices['chatSnapshot']>; poller?: ReturnType<ProviderTaskPoller['status']> };
export interface AspChatReadDeps { db: DatabaseSync; kvGet(key: string): string | null; live?: () => Live; now?: () => number }
const links = [{ label: '信号市场', href: '#market' }];
/** CLI 错误可能夹完整命令/客户描述,模型只看第一行摘要。 */
const errorSummary = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const line = String(value).split('\n')[0]!;
  if (/Command failed:|execFile|--data\b/i.test(line)) return 'CLI 请求失败(命令参数已省略,详情见信号市场)';
  return line.replace(/0x[0-9a-f]{16,}/gi, '[redacted]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]').slice(0, 200);
};
const unavailable = (reason: string): Block => ({ ready: false, reason: errorSummary(reason) });
const block = (read: () => Record<string, unknown>): Block => {
  try { return { ready: true, ...read() }; }
  catch (e) { return unavailable((e as Error).message); }
};
const mask = (v: unknown): string | null => v === null || v === undefined || v === '' ? null : `…${String(v).slice(-4)}`;
const str = (v: unknown): string | null => v === undefined || v === null || v === '' ? null : String(v);
const decimal = (v: unknown): string | null => v !== null && v !== undefined && /^\d+(?:\.\d+)?$/.test(String(v)) ? String(v) : null;
function args(tool: string, raw: unknown, allowed: string[]): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`invalid_args:${tool}:args 必须是对象`);
  const a = raw as Record<string, unknown>;
  if (Object.keys(a).some((k) => !allowed.includes(k))) throw new Error(`invalid_args:${tool}:不认识的参数`);
  return a;
}
function limitOf(tool: string, a: Record<string, unknown>): number {
  const n = a['limit'] ?? 20;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 100) throw new Error(`invalid_args:${tool}:limit 必须是 1–100 的整数`);
  return n;
}

/** 本地交付统计涵盖欢迎包、按次交付与订阅扇出;任一表缺失由调用方降级这一块。 */
export function aspDeliveryStats(db: DatabaseSync, service: string | null) {
  const tasks = db.prepare(`SELECT COUNT(*) AS deliveries,MAX(updated_at) AS last_delivery_at
    FROM okx_market_provider_task WHERE service_id=? AND state='delivered'`).get(service)!;
  const pushes = db.prepare(`SELECT COUNT(*) AS deliveries,MAX(j.updated_at) AS last_delivery_at
    FROM okx_market_service_push_job j JOIN okx_market_service_push p ON p.event_id=j.event_id
    WHERE p.service_id=? AND j.status='delivered'`).get(service)!;
  const dates = [tasks['last_delivery_at'], pushes['last_delivery_at']].filter((v) => v !== null).map(Number);
  return { deliveries: Number(tasks['deliveries']) + Number(pushes['deliveries']), last_delivery_at: dates.length ? Math.max(...dates) : null };
}
/** 只读发布摘要,不读取交付全文或订阅者原始标识。 */
export function aspRecentPublish(db: DatabaseSync, limit = 5) {
  return db.prepare(`SELECT event_id,created_at,refusal FROM okx_market_delivery_out ORDER BY created_at DESC LIMIT ?`).all(limit).map((r) => ({ ...r, refusal: errorSummary(r['refusal']) }));
}

export function aspReadonlyChatTools(d: AspChatReadDeps): Record<(typeof ASP_CHAT_TOOLS)[number], (raw?: unknown) => Record<string, unknown>> {
  const now = d.now ?? Date.now;
  const live = () => d.live?.() ?? {};
  const json = (key: string) => object(JSON.parse(d.kvGet(key) ?? '{}'));
  const identity = (): Block => block(() => {
    const cached = cachedAspIdentity(d.kvGet);
    if (!cached) return unavailable('尚无 ASP 身份快照,请在信号市场页刷新');
    const asp = cached.asp;
    if (!asp) return { agent_id: null, name: null, registered: false, as_of: cached.at };
    const svc = live().services?.services;
    const agent = svc?.value.agent ?? asp;
    return { agent_id: str(asp['agentId'] ?? asp['aspAgentId'] ?? asp['id']), name: str(agent['name'] ?? asp['name']), registered: true,
      approval_status: agent['approvalStatus'] ?? null, online_status: agent['onlineStatus'] ?? null,
      as_of: svc?.at ?? cached.at, stale: now() - (svc?.at ?? cached.at) > 60_000 };
  });
  const services = (): Block => block(() => {
    // 先读 kv,让缺 kv 表明确降级,不被 readConfig 的兼容兜底吞掉。
    const cfg = json('asp_services.config');
    const ids = readConfig((key) => key === 'asp_services.config' ? JSON.stringify(cfg) : d.kvGet(key)).service_ids;
    const prices = json('asp_services.prices'), paused = json('asp_services.paused');
    const cached = live().services;
    const online = cached?.services;
    return { source: 'local_config_and_cached_service_list', as_of: online?.at ?? null, items: LISTING_KEYS.map((key: ListingKey) => {
      const def = LISTINGS[key], sid = ids[key] ?? null;
      const remote = online?.value.items.find((x) => sid && String(x['serviceId']) === sid);
      const sub = Array.isArray(remote?.['subscription']) ? object(remote['subscription'][0]) : {};
      const remotePrice = decimal(sub['fee']) ?? decimal(remote?.['fee']), localPrice = decimal(prices[key]);
      return { key, service_id: sid, name: def.name, description: def.description.join('\n'), kind: def.kind,
        price: remotePrice ?? localPrice ?? DEFAULT_PRICES[key], price_unit: def.kind === 'subscription' ? 'month' : 'call',
        price_source: remotePrice !== null ? 'cached_listing' : localPrice !== null ? 'local_config' : 'suggested_default',
        trial_hours: def.kind === 'subscription' ? 72 : null, configured: !!sid, enabled: !!sid && paused[key] !== true,
        registered: cached ? cached.registered && !!sid : null, listing: online ? { ready: true, found: !!remote, approval_status: online.value.agent['approvalStatus'] ?? null, as_of: online.at } : unavailable('尚无上架列表快照'),
        delivery: block(() => aspDeliveryStats(d.db, sid)) };
    }) };
  });
  const subscribers = (limit: number): Block => block(() => {
    const cached = live().services?.subscribers;
    if (!cached) return unavailable('尚无卖方订阅者快照,请在信号市场页刷新;本地接单数不等于订阅者数');
    const groups: Record<string, number> = Object.fromEntries(SUBSCRIPTION_GROUP_ORDER.map((g) => [g, 0]));
    const rows = cached.value.map((row) => {
      const display = subscriptionDisplay({ ...row, statusName: row['statusName'] ?? (typeof row['status'] === 'string' && /^[A-Z_]+$/i.test(row['status']) ? row['status'] : undefined) }, now()); groups[display.group]!++;
      return { job_id: mask(row['jobId']), buyer_agent_id: mask(row['buyerAgentId']), service_id: str(row['serviceId']), group: display.group,
        status: display.label, started_at: display.started_at, until: display.until };
    }).sort((a, b) => SUBSCRIPTION_GROUP_ORDER.indexOf(a.group) - SUBSCRIPTION_GROUP_ORDER.indexOf(b.group) || (b.started_at ?? 0) - (a.started_at ?? 0));
    return { count: rows.length, groups, items: rows.slice(0, limit), as_of: cached.at, stale: now() - cached.at > 60_000 };
  });
  const provider = (): Block => block(() => {
    const counts = d.db.prepare("SELECT COUNT(*) AS pending FROM okx_market_provider_task WHERE state NOT IN ('delivered','declined','closed')").get()!;
    const p = live().poller;
    return { pending: Number(counts['pending']), running: p?.working ?? false, enabled: p?.running ?? null,
      last_poll_at: p?.last_tick?.at ?? null, last_error: errorSummary(p?.last_tick?.error),
      next_poll_at: p?.running && p.last_tick ? p.last_tick.at + p.interval_ms : null,
      poller: p ? { ready: true } : unavailable('本进程尚无接单轮询状态') };
  });
  const publisher = (): Block => block(() => ({ enabled: normalizePublisherSettings(json('market.settings')['publisher']).enabled,
    recent: aspRecentPublish(d.db, 1), service_pushes: block(() => ({ items: d.db.prepare('SELECT event_id,service_id,channel,created_at,summary,refusal FROM okx_market_service_push ORDER BY created_at DESC LIMIT 1').all().map((r) => ({ ...r, summary: str(r['summary'])?.slice(0, 300) ?? null, refusal: errorSummary(r['refusal']) })) })) }));
  const claimable = (): Block => block(() => {
    const cached = live().services?.claimable;
    return cached && cached.value !== null ? { amount: cached.value, currency: 'USDT', as_of: cached.at, stale: now() - cached.at > 60_000 }
      : unavailable('尚无可领收入快照或查询未成功,请在信号市场页刷新');
  });
  return {
    get_asp_overview: (raw) => {
      args('get_asp_overview', raw, []);
      const svc = services();
      const compactServices = svc['items'] ? { ...svc, items: (svc['items'] as Record<string, unknown>[]).map((r) => ({ service_id: r['service_id'], name: r['name'], price: r['price'], price_unit: r['price_unit'], price_source: r['price_source'], enabled: r['enabled'], registered: r['registered'], listing: r['listing'] })) } : svc;
      return { links, identity: identity(), subscribers: subscribers(0), publisher: publisher(), provider_tasks: provider(), claimable: claimable(),
        recent_errors: block(() => ({ items: d.db.prepare("SELECT id,routine,error,started_at,finished_at FROM demo_bot_run WHERE role='asp_agent' AND error IS NOT NULL ORDER BY started_at DESC LIMIT 3").all().map((r) => ({ ...r, error: errorSummary(r['error']) })) })),
        services: compactServices,
        note: '只读本地账本与已有快照;未就绪不代表零。上架、发布、领款、售后请在信号市场页操作。' };
    },
    list_asp_services: (raw) => { args('list_asp_services', raw, []); return { links, ...services() }; },
    list_asp_tasks: (raw) => {
      const a = args('list_asp_tasks', raw, ['status', 'limit']), limit = limitOf('list_asp_tasks', a), status = a['status'] ?? 'open';
      if (status !== 'open' && status !== 'all') throw new Error('invalid_args:list_asp_tasks:status 只能是 open|all');
      return { links, ...block(() => ({ items: providerTaskRows(d.db, { status, limit }).map((r) => ({ job_id: mask(r.job_id), kind: r.kind, service_id: r.service_id,
        state: r.state, remote_status: r.remote_status, accept_attempts: r.accept_attempts, deliver_attempts: r.deliver_attempts,
        error: errorSummary(r.error), test_flag: r.test_flag, created_at: r.created_at, updated_at: r.updated_at,
        // 不把原始 CLI 结果或买方需求交给模型;只投影回查的状态与确认信息。
        reconciliation: { remote_status: r.remote_status, result_recorded: r.result !== null, unknown: r.state.endsWith('_unknown') } })) })) };
    },
    list_asp_subscribers: (raw) => { const a = args('list_asp_subscribers', raw, ['limit']); return { links, ...subscribers(limitOf('list_asp_subscribers', a)) }; },
    list_market_inbox: (raw) => {
      const a = args('list_market_inbox', raw, ['limit']); const limit = limitOf('list_market_inbox', a);
      return { links, ...block(() => ({ items: marketInboxRows(d.db, { limit }).map((r) => ({ delivery_id: r.delivery_id, job_id: mask(r.job_id), received_at: r.received_at,
        parse_status: r.parse_status, signal_id: r.signal_id, signal_type: r.signal_type })) })) };
    },
  };
}
