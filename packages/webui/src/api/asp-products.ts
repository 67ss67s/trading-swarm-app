/**
 * 「发布」栏的产品面(设计 docs/design/signal-market-ux-2026-09-25.md「后端接口(契约)」):
 *   GET  /api/asp-services/products                     → AspProductsResponse
 *   GET  /api/asp-services/products/:key/customers      → 订阅者 / 订单
 *   POST /api/asp-services/products/:key/pause          { paused }
 *   POST /api/asp-services/products/:key/draft          { price?, description? } → 预检(不写链)
 *   POST /api/asp-services/products/:key/apply          { confirm: true, service_payload } → 写链,触发 OKX 重新审核
 *   POST /api/asp-services/preview/:listing             按次服务本地预览(付费模型类要 allow_paid)
 *   POST /api/asp-services/channels/:channel/preview    订阅频道预览
 *
 * 后端与前端并行开发,这里所有字段都按「可能缺」归一:缺数字 = 0,缺时间 = null,缺数组 = []。
 */

import { t } from '../lib/i18n';
import { snapshotOf, type MarketSnapshotMeta } from './market-adapt';

export type ProductKind = 'subscription' | 'one_time';
export type ProductStatus = 'listed' | 'in_review' | 'paused' | 'not_listed';
export type ChecklistKey = 'asp' | 'listed' | 'review' | 'first_customer';

export interface AspApproval {
  code: number | null;
  label: string;
  remark: string | null;
}

export interface AspSummary {
  agent_id: string | null;
  name: string | null;
  approval: AspApproval;
  online: boolean | null;
  claimable_usdt: string | null;
}

export interface ChecklistItem {
  key: ChecklistKey | string;
  label: string;
  done: boolean;
  hint: string;
}

export interface ProductStats {
  active_subscribers: number;
  trial_subscribers: number;
  orders_7d: number;
  orders_total: number;
  deliveries_ok: number;
  deliveries_failed: number;
  last_delivery_at: number | null;
}

export interface AspProduct {
  /** 'strategy_signal' | ListingKey */
  key: string;
  name: string;
  kind: ProductKind;
  price: string;
  price_unit: 'month' | 'call';
  trial_hours: number | null;
  description: string;
  service_id: string | null;
  listing_id: string | null;
  status: ProductStatus;
  paused: boolean;
  stats: ProductStats;
}

export interface AspProductsResponse {
  asp: AspSummary;
  checklist: ChecklistItem[];
  products: AspProduct[];
  as_of: number;
  /** 评审版:网关从快照回的响应带 snapshot(可能缺) */
  snapshot?: MarketSnapshotMeta;
}

export interface SubscriberItem {
  job_id: string;
  buyer_agent_id: string | null;
  status_label: string;
  trial: boolean;
  started_at: number | null;
  ends_at: number | null;
  pushes: number;
}

export interface OrderItem {
  job_id: string;
  buyer_agent_id: string | null;
  request: string;
  state_label: string;
  created_at: number | null;
  delivered_at: number | null;
  summary: string | null;
}

export type CustomersResponse = { kind: 'subscription'; items: SubscriberItem[] } | { kind: 'one_time'; items: OrderItem[] };

export interface DraftFinding {
  field: string | null;
  severity: 'block' | 'suggest' | string;
  message: string;
}

export interface DraftResponse {
  service_payload: unknown;
  validate: { pass: boolean; findings: DraftFinding[] };
  warns: string[];
}

export interface ApplyResponse {
  tx_hash: string | null;
  message: string | null;
}

export interface PreviewResult {
  title: string | null;
  summary: string | null;
  text: string;
}

// ---------------------------------------------------------------------------
// 归一

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const bool = (v: unknown): boolean => v === true;
const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

const STATUSES: ProductStatus[] = ['listed', 'in_review', 'paused', 'not_listed'];

export function adaptProduct(raw: unknown): AspProduct {
  const p = obj(raw);
  const s = obj(p['stats']);
  const kind: ProductKind = p['kind'] === 'one_time' ? 'one_time' : 'subscription';
  const paused = bool(p['paused']);
  const status = STATUSES.includes(p['status'] as ProductStatus) ? (p['status'] as ProductStatus) : paused ? 'paused' : 'not_listed';
  return {
    key: str(p['key']) ?? '',
    name: str(p['name']) ?? str(p['key']) ?? '—',
    kind,
    price: str(p['price']) ?? '',
    price_unit: p['price_unit'] === 'call' || p['price_unit'] === 'month' ? p['price_unit'] : kind === 'one_time' ? 'call' : 'month',
    trial_hours: numOrNull(p['trial_hours']),
    description: str(p['description']) ?? '',
    service_id: str(p['service_id']),
    listing_id: str(p['listing_id']),
    status,
    paused,
    stats: {
      active_subscribers: num(s['active_subscribers']),
      trial_subscribers: num(s['trial_subscribers']),
      orders_7d: num(s['orders_7d']),
      orders_total: num(s['orders_total']),
      deliveries_ok: num(s['deliveries_ok']),
      deliveries_failed: num(s['deliveries_failed']),
      last_delivery_at: numOrNull(s['last_delivery_at']),
    },
  };
}

export function adaptProducts(raw: unknown): AspProductsResponse {
  const r = obj(raw);
  const a = obj(r['asp']);
  const ap = obj(a['approval']);
  return {
    ...snapshotOf(r),
    asp: {
      agent_id: str(a['agent_id']),
      name: str(a['name']),
      approval: { code: numOrNull(ap['code']), label: str(ap['label']) ?? '', remark: str(ap['remark']) },
      online: boolOrNull(a['online']),
      claimable_usdt: str(a['claimable_usdt']),
    },
    checklist: arr(r['checklist']).map((x) => {
      const c = obj(x);
      return { key: str(c['key']) ?? '', label: str(c['label']) ?? '', done: bool(c['done']), hint: str(c['hint']) ?? '' };
    }),
    products: arr(r['products'])
      .map(adaptProduct)
      .filter((p) => p.key),
    as_of: num(r['as_of']),
  };
}

export function adaptCustomers(raw: unknown, kind: ProductKind): CustomersResponse {
  const items = arr(obj(raw)['items']).map(obj);
  if (kind === 'subscription') {
    return {
      kind,
      items: items.map((x) => ({
        job_id: str(x['job_id']) ?? '',
        buyer_agent_id: str(x['buyer_agent_id']),
        status_label: str(x['status_label']) ?? '',
        trial: bool(x['trial']),
        started_at: numOrNull(x['started_at']),
        ends_at: numOrNull(x['ends_at']),
        pushes: num(x['pushes']),
      })),
    };
  }
  return {
    kind,
    items: items.map((x) => ({
      job_id: str(x['job_id']) ?? '',
      buyer_agent_id: str(x['buyer_agent_id']),
      request: str(x['request']) ?? '',
      state_label: str(x['state_label']) ?? '',
      created_at: numOrNull(x['created_at']),
      delivered_at: numOrNull(x['delivered_at']),
      summary: str(x['summary']),
    })),
  };
}

export function adaptDraft(raw: unknown): DraftResponse {
  const r = obj(raw);
  const v = obj(r['validate']);
  const findings = arr(v['findings']).map((f): DraftFinding => {
    if (typeof f === 'string') return { field: null, severity: 'block', message: f };
    const o = obj(f);
    return { field: str(o['field']), severity: str(o['severity']) ?? 'block', message: str(o['message']) ?? str(o['code']) ?? '' };
  });
  return {
    service_payload: r['service_payload'] ?? null,
    validate: { pass: v['pass'] === true && !findings.some((f) => f.severity === 'block'), findings },
    warns: arr(r['warns'])
      .map((w) => str(w) ?? '')
      .filter(Boolean),
  };
}

export function adaptApply(raw: unknown): ApplyResponse {
  const r = obj(raw);
  return { tx_hash: str(r['txHash']) ?? str(r['tx_hash']), message: str(r['message']) };
}

function adaptPreview(raw: unknown): PreviewResult {
  const r = obj(raw);
  const text = str(r['text']) ?? '';
  return { title: null, summary: str(r['summary']), text };
}

// ---------------------------------------------------------------------------
// 请求

/** 与 api/client.ts 的错误同形(status + code),页面按 status 409 识别「需要付费确认」。 */
export class AspApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call(path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init?.method ?? 'GET',
      headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new AspApiError(0, 'gateway_unavailable', t('网关暂时连不上(多半在重启),恢复后自动刷新'));
  }
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const e = obj(obj(body)['error']);
    throw new AspApiError(res.status, str(e['code']) ?? 'unknown', str(e['message']) ?? (res.statusText || `HTTP ${res.status}`));
  }
  return body;
}

const enc = encodeURIComponent;

export const aspProductsApi = {
  products: async (): Promise<AspProductsResponse> => adaptProducts(await call('/api/asp-services/products')),
  customers: async (key: string, kind: ProductKind): Promise<CustomersResponse> => adaptCustomers(await call(`/api/asp-services/products/${enc(key)}/customers`), kind),
  pause: async (key: string, paused: boolean): Promise<void> => {
    await call(`/api/asp-services/products/${enc(key)}/pause`, { method: 'POST', body: { paused } });
  },
  draft: async (key: string, body: { price?: string; description?: [string, string, string] }): Promise<DraftResponse> =>
    adaptDraft(await call(`/api/asp-services/products/${enc(key)}/draft`, { method: 'POST', body })),
  apply: async (key: string, service_payload: unknown): Promise<ApplyResponse> =>
    adaptApply(await call(`/api/asp-services/products/${enc(key)}/apply`, { method: 'POST', body: { confirm: true, service_payload } })),
  previewListing: async (listing: string, body: { description?: string; allow_paid?: boolean }): Promise<PreviewResult> =>
    adaptPreview(await call(`/api/asp-services/preview/${enc(listing)}`, { method: 'POST', body })),
  previewChannel: async (channel: string): Promise<PreviewResult> => adaptPreview(await call(`/api/asp-services/channels/${enc(channel)}/preview`, { method: 'POST', body: {} })),
};
