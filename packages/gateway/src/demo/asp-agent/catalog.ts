/**
 * OKX.AI 市场目录(设计 asp-market §2.3 补充,2026-09-20 晚):
 * okx.ai 的网页列表接口(/priapi/v2/wallet/agentic/agent/list)要 OKX 的请求签名,不能直调;
 * 但页面是 SSR 的,`<script id="appState">` 里带完整 JSON:
 *   - /agents            → 首页 20 个(含评分/已售/起价/标签/分类)+ 分类表;翻页参数无效
 *   - /sitemap/agents/N  → 全量 agent 的 id + 名 + 简介(11 页 × 20)
 *   - /agents/<id>       → overview(评分/好评率/已售/分类/起价)+ services(serviceId/price/priceInterval/freeTrial)
 *                          + reviews(分布 + 列表)+ similar
 * 这里只读、低频:目录整体每 6h 刷一次(可手动),详情缓存 10min;并发 3,失败留痕不重试。
 * CLI `service-match` 仍是订阅动作的数据源(serviceId uuid / feeToken 地址只有它给)。
 */
import type { DemoStore } from '../store.js';

const BASE = 'https://www.okx.ai';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 trading-swarm/1.0';
const CATALOG_KEY = 'market.catalog';
const CATALOG_TTL_MS = 6 * 3_600_000;
const DETAIL_TTL_MS = 10 * 60_000;
const SITEMAP_MAX_PAGES = 40;
const CONCURRENCY = 3;

export interface CatalogAgent {
  agent_id: string;
  name: string;
  avatar: string | null;
  description: string;
  score: string | null;
  approval_rate: string | null;
  usage_count: number;
  starting_price: string | null;
  price_interval: string | null;
  symbol: string;
  categories: string[];
  tags: string[];
  online: boolean;
  /** 详情页扒到的服务(可能为空:只在 sitemap 里见过、详情还没抓)。 */
  services: CatalogService[];
  /** 详情抓取时间;null = 只来自列表/sitemap。 */
  detail_at: number | null;
}
export interface CatalogService {
  service_id: number | null;
  name: string;
  price: string | null;
  price_interval: string | null;
  description: string;
  free_trial: boolean;
  free_trial_hours: number | null;
  service_type: string | null;
}
export interface Catalog {
  fetched_at: number | null;
  building: boolean;
  total_site: number | null;
  categories: { id: string; name: string }[];
  agents: CatalogAgent[];
  errors: string[];
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

export async function fetchHtml(path: string, timeoutMs = 20_000): Promise<string> {
  const res = await fetch(`${BASE}${path}`, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`okx.ai ${path} → HTTP ${res.status}`);
  return res.text();
}

/** SSR 状态:`<script data-id="__app_data_for_ssr__" type="application/json" id="appState">{…}</script>`。 */
export function appState(html: string): Record<string, unknown> | null {
  const m = /<script[^>]*id="appState"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  try { return obj(obj(obj(JSON.parse(m[1]!))['appContext'])['initialProps']); } catch { return null; }
}

export function parseListPage(html: string): { categories: { id: string; name: string }[]; total: number | null; agents: CatalogAgent[] } {
  const props = appState(html);
  const L = obj(props?.['AgentMarketplaceAgentList']);
  const categories = (Array.isArray(L['categories']) ? L['categories'] : []).map(obj).map((c) => ({ id: String(c['categoryId'] ?? ''), name: String(c['name'] ?? '') })).filter((c) => c.id);
  const al = obj(L['agentList']);
  const agents = (Array.isArray(al['list']) ? al['list'] : []).map((x) => agentFromListItem(obj(x)));
  return { categories, total: num(al['total']), agents };
}

function agentFromListItem(x: Record<string, unknown>): CatalogAgent {
  return {
    agent_id: String(x['agentId'] ?? ''),
    name: String(x['name'] ?? ''),
    avatar: str(x['avatar']),
    description: String(x['description'] ?? ''),
    score: str(x['score']),
    approval_rate: str(x['approvalRate']),
    usage_count: num(x['usageCount']) ?? 0,
    starting_price: str(x['startingPrice'] ?? x['serviceLowestFee']),
    price_interval: str(x['priceInterval']),
    symbol: str(x['symbol']) ?? 'USDT',
    categories: Array.isArray(x['categories']) ? x['categories'].map(String) : [],
    tags: Array.isArray(x['tags']) ? x['tags'].map(String) : [],
    online: x['onlineStatus'] === 1 || x['onlineStatus'] === true,
    services: [],
    detail_at: null,
  };
}

/** sitemap 页:`<a href="/agents/<id>">名 … 简介</a>`(纯 HTML,没有 appState)。 */
export function parseSitemapPage(html: string): { agent_id: string; name: string; description: string }[] {
  const out: { agent_id: string; name: string; description: string }[] = [];
  const seen = new Set<string>();
  const re = /<a[^>]*href="\/agents\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const id = m[1]!;
    if (seen.has(id)) continue;
    const parts = m[2]!.split(/<[^>]+>/).map((s) => decode(s).trim()).filter(Boolean);
    if (!parts.length) continue;
    seen.add(id);
    out.push({ agent_id: id, name: parts[0]!, description: parts.slice(1).join(' ') });
  }
  return out;
}

function decode(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

export interface CatalogDetail {
  agent: CatalogAgent;
  overview: Record<string, unknown>;
  services: CatalogService[];
  reviews: { total_score: string | null; total_count: number; distribution: Record<string, number>; list: { reviewer: string | null; time: number | null; content: string; rating: string | null }[] };
  similar: CatalogAgent[];
  fetched_at: number;
}

export function parseDetailPage(html: string, agentId: string): CatalogDetail | null {
  const props = appState(html);
  const P = obj(props?.['AgentDetailPage']);
  const ov = obj(P['overview']);
  if (!ov['agentId'] && !ov['name']) return null;
  const services = (Array.isArray(obj(P['services'])['list']) ? (obj(P['services'])['list'] as unknown[]) : []).map(obj).map((s): CatalogService => {
    const trialHours = num(s['freeTrialHours'] ?? s['freeTrial']);
    return {
      service_id: num(s['serviceId']),
      name: String(s['name'] ?? ''),
      price: str(s['price']),
      price_interval: str(s['priceInterval']),
      description: String(s['description'] ?? ''),
      free_trial: s['freeTrial'] === true || (trialHours !== null && trialHours > 0) || (Array.isArray(s['tags']) && s['tags'].includes('FREETRY')),
      free_trial_hours: trialHours !== null && trialHours > 1 ? trialHours : null,
      service_type: str(s['serviceType'] ?? s['type']),
    };
  });
  const rv = obj(P['reviews']);
  const agent: CatalogAgent = {
    ...agentFromListItem({ ...ov, startingPrice: ov['serviceLowestFee'] ?? ov['startingPrice'] }),
    agent_id: String(ov['agentId'] ?? agentId),
    tags: [...new Set(services.flatMap((s) => [s.price_interval === 'month' ? 'MONTHLY' : 'ONETIME', ...(s.free_trial ? ['FREETRY'] : [])]))],
    services,
    detail_at: Date.now(),
  };
  return {
    agent,
    overview: ov,
    services,
    reviews: {
      total_score: str(rv['totalScore']),
      total_count: num(rv['totalCount'] ?? rv['total']) ?? 0,
      distribution: Object.fromEntries(Object.entries(obj(rv['distribution'])).map(([k, v]) => [k, num(v) ?? 0])),
      list: (Array.isArray(rv['list']) ? (rv['list'] as unknown[]) : []).map(obj).map((r) => ({ reviewer: str(r['reviewerAddress']), time: num(r['time']), content: String(r['content'] ?? ''), rating: str(r['ratingValue']) })),
    },
    similar: (Array.isArray(P['similar']) ? (P['similar'] as unknown[]) : []).map(obj).map(agentFromListItem),
    fetched_at: Date.now(),
  };
}

export class MarketCatalog {
  private building: Promise<void> | null = null;
  private details = new Map<string, CatalogDetail>();
  private detailInflight = new Map<string, Promise<CatalogDetail | null>>();
  constructor(private readonly deps: { store: DemoStore; fetchHtml?: (path: string) => Promise<string>; now?: () => number; log?: (level: 'info' | 'warn', message: string) => void }) {}
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private html(path: string): Promise<string> { return (this.deps.fetchHtml ?? fetchHtml)(path); }

  cached(): Catalog {
    const raw = this.deps.store.kvGet(CATALOG_KEY);
    const base: Catalog = { fetched_at: null, building: this.building !== null, total_site: null, categories: [], agents: [], errors: [] };
    if (!raw) return base;
    try { return { ...base, ...(JSON.parse(raw) as Partial<Catalog>), building: this.building !== null }; } catch { return base; }
  }

  /** 读目录:过期或空就在后台重建,先把手头的返回(`building:true`),不阻塞页面。 */
  get(opts: { refresh?: boolean } = {}): Catalog {
    const c = this.cached();
    if (opts.refresh || c.fetched_at === null || this.now() - c.fetched_at > CATALOG_TTL_MS) void this.rebuild();
    return { ...c, building: this.building !== null };
  }

  rebuild(): Promise<void> {
    if (this.building) return this.building;
    this.building = this.rebuildInner().catch((e: Error) => this.deps.log?.('warn', `市场目录重建失败:${e.message}`)).finally(() => { this.building = null; });
    return this.building;
  }

  private async rebuildInner(): Promise<void> {
    const errors: string[] = [];
    const prev = this.cached();
    const byId = new Map<string, CatalogAgent>(prev.agents.map((a) => [a.agent_id, a]));
    let categories = prev.categories;
    let total: number | null = prev.total_site;
    try {
      const list = parseListPage(await this.html('/agents'));
      if (list.categories.length) categories = list.categories;
      total = list.total ?? total;
      for (const a of list.agents) byId.set(a.agent_id, { ...(byId.get(a.agent_id) ?? a), ...a, services: byId.get(a.agent_id)?.services ?? [], detail_at: byId.get(a.agent_id)?.detail_at ?? null });
    } catch (e) { errors.push(`列表页:${(e as Error).message}`); }
    for (let page = 1; page <= SITEMAP_MAX_PAGES; page++) {
      let rows: ReturnType<typeof parseSitemapPage>;
      try { rows = parseSitemapPage(await this.html(`/sitemap/agents/${page}`)); } catch (e) { errors.push(`sitemap ${page}:${(e as Error).message}`); break; }
      if (!rows.length) break;
      for (const r of rows) {
        const cur = byId.get(r.agent_id);
        if (cur) { if (!cur.description) cur.description = r.description; continue; }
        byId.set(r.agent_id, { agent_id: r.agent_id, name: r.name, avatar: null, description: r.description, score: null, approval_rate: null, usage_count: 0, starting_price: null, price_interval: null, symbol: 'USDT', categories: [], tags: [], online: false, services: [], detail_at: null });
      }
    }
    // 详情补全:没抓过或超过一天的,按并发 3 慢慢抓;每抓 10 个落一次盘,页面能看到进度。
    const stale = [...byId.values()].filter((a) => a.detail_at === null || this.now() - a.detail_at > 24 * 3_600_000);
    let done = 0;
    const worker = async () => {
      for (;;) {
        const a = stale.shift(); if (!a) return;
        try {
          const d = parseDetailPage(await this.html(`/agents/${a.agent_id}`), a.agent_id);
          if (d) { byId.set(a.agent_id, { ...a, ...d.agent, description: d.agent.description || a.description }); this.details.set(a.agent_id, d); }
        } catch (e) { errors.push(`详情 ${a.agent_id}:${(e as Error).message}`); }
        if (++done % 10 === 0) this.persist({ fetched_at: prev.fetched_at, total_site: total, categories, agents: [...byId.values()], errors: errors.slice(-20) });
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    this.persist({ fetched_at: this.now(), total_site: total, categories, agents: [...byId.values()], errors: errors.slice(-20) });
    this.deps.log?.('info', `市场目录已刷新:${byId.size} 个 agent(站点计数 ${total ?? '?'}),${errors.length} 个错误`);
  }

  private persist(c: Omit<Catalog, 'building'>): void {
    this.deps.store.kvSet(CATALOG_KEY, JSON.stringify(c));
  }

  async detail(agentId: string): Promise<CatalogDetail | null> {
    const hit = this.details.get(agentId);
    if (hit && this.now() - hit.fetched_at < DETAIL_TTL_MS) return hit;
    const inflight = this.detailInflight.get(agentId);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        const d = parseDetailPage(await this.html(`/agents/${encodeURIComponent(agentId)}`), agentId);
        if (d) {
          this.details.set(agentId, d);
          const c = this.cached();
          const idx = c.agents.findIndex((a) => a.agent_id === agentId);
          const merged = { ...(c.agents[idx] ?? d.agent), ...d.agent };
          if (idx === -1) c.agents.push(merged); else c.agents[idx] = merged;
          this.persist({ fetched_at: c.fetched_at, total_site: c.total_site, categories: c.categories, agents: c.agents, errors: c.errors });
        }
        return d;
      } finally { this.detailInflight.delete(agentId); }
    })();
    this.detailInflight.set(agentId, p);
    return p;
  }
}

/** 目录筛选/排序(纯函数,路由和测试共用)。 */
export function filterCatalog(agents: CatalogAgent[], q: { category?: string | null; text?: string | null; monthly?: boolean; trial?: boolean; sort?: string | null }): CatalogAgent[] {
  const text = (q.text ?? '').trim().toLowerCase();
  let out = agents.filter((a) => (!q.category || q.category === 'ALL' || a.categories.includes(q.category)) && (!q.monthly || a.tags.includes('MONTHLY')) && (!q.trial || a.tags.includes('FREETRY')) && (!text || `${a.name} ${a.description} ${a.services.map((s) => s.name).join(' ')}`.toLowerCase().includes(text)));
  const n = (v: string | null) => (v === null ? -1 : Number(v));
  switch (q.sort ?? 'hot') {
    case 'score': out = out.sort((a, b) => n(b.score) - n(a.score) || b.usage_count - a.usage_count); break;
    case 'price': out = out.sort((a, b) => (a.starting_price === null ? 1 : b.starting_price === null ? -1 : n(a.starting_price) - n(b.starting_price))); break;
    case 'newest': out = out.sort((a, b) => Number(b.agent_id) - Number(a.agent_id)); break;
    default: out = out.sort((a, b) => b.usage_count - a.usage_count || n(b.score) - n(a.score));
  }
  return out;
}
