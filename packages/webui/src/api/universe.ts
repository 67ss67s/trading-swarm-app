/**
 * OKX 资产全集(docs/design/watch-screener-review-2026-09-24.md 二-1,后端 universe-okx.ts)。
 *
 *   GET  /api/universe?market=spot|perp|all&q=&limit=&sort=volume|change|funding
 *        → { updated_at, total, items: UniverseItem[] }
 *   POST /api/universe/refresh   手动刷新(刷新之后后端零模型跑一遍全市场扫描)
 *
 * 前端一次取全量(limit 大),过滤 / 排序在本地做(components/watch/watch-logic.ts),联想才能即敲即出。
 * 接口没上线(404 / 网络错)时优雅降级:回退到现有 GET /api/symbols(只有代码,没有价格 / 涨跌 / 资金费),
 * 结果里 `fallback=true`,界面提示「OKX 资产全集接口未就绪」。
 * 类型放这里,不改 api/types.ts(别人在动)。
 */
import { useQuery } from '@tanstack/react-query';

export type UniverseMarket = 'spot' | 'perp';
export type UniverseMarketFilter = UniverseMarket | 'all';
export type UniverseSort = 'volume' | 'change' | 'funding';

export interface UniverseItem {
  /** 与 workflow.watchlist 同口径,如 BTCUSDT */
  symbol: string;
  base: string;
  markets: UniverseMarket[];
  last: number | null;
  /** 24h 涨跌,百分数(+3.2 = 涨 3.2%) */
  change_24h: number | null;
  quote_volume_24h: number | null;
  /** 当期资金费,**小数**(OKX 原生口径,0.0001 = 0.01%);只有永续有,现货为 null */
  funding_rate: number | null;
  rank_by_volume: number | null;
  /** 稳定币 / 包装币等,后端打标排除 */
  excluded: boolean;
}

export interface UniverseResponse {
  updated_at: number | null;
  total: number;
  items: UniverseItem[];
  /** true = /api/universe 没上线,这份是 /api/symbols 拼出来的(只有代码) */
  fallback: boolean;
}

// ---------------------------------------------------------------- 归一

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** 从 BTCUSDT / BTC-USDT / BTC-USDT-SWAP 取 base。 */
export function baseOf(symbol: string): string {
  const s = symbol.toUpperCase().replace(/-SWAP$/, '').replace(/-/g, '');
  return s.endsWith('USDT') && s.length > 4 ? s.slice(0, -4) : s;
}

export function adaptUniverseItem(raw: unknown): UniverseItem | null {
  const o = rec(raw);
  const symbol = str(o?.symbol)?.toUpperCase() ?? null;
  if (!o || !symbol) return null;
  const markets = arr(o.markets).filter((m): m is UniverseMarket => m === 'spot' || m === 'perp');
  return {
    symbol,
    base: str(o.base)?.toUpperCase() ?? baseOf(symbol),
    markets: markets.length ? [...new Set(markets)] : ['perp'],
    last: num(o.last),
    change_24h: num(o.change_24h),
    quote_volume_24h: num(o.quote_volume_24h),
    funding_rate: num(o.funding_rate),
    rank_by_volume: num(o.rank_by_volume),
    excluded: o.excluded === true,
  };
}

export function adaptUniverse(raw: unknown): UniverseResponse {
  const o = rec(raw) ?? {};
  const seen = new Set<string>();
  const items: UniverseItem[] = [];
  for (const x of arr(o.items)) {
    const it = adaptUniverseItem(x);
    if (!it || seen.has(it.symbol)) continue;
    seen.add(it.symbol);
    items.push(it);
  }
  return { updated_at: num(o.updated_at), total: num(o.total) ?? items.length, items, fallback: false };
}

/** /api/symbols → 降级版全集:只有代码,按永续算(/api/symbols 默认就是永续列表)。 */
export function universeFromSymbols(raw: unknown): UniverseResponse {
  const seen = new Set<string>();
  const items: UniverseItem[] = [];
  for (const x of arr(rec(raw)?.symbols)) {
    const o = rec(x);
    const symbol = str(o?.symbol)?.toUpperCase();
    if (!o || !symbol || seen.has(symbol)) continue;
    const status = str(o.status);
    if (status && status !== 'TRADING') continue;
    seen.add(symbol);
    items.push({ symbol, base: baseOf(symbol), markets: ['perp'], last: null, change_24h: null, quote_volume_24h: null, funding_rate: null, rank_by_volume: null, excluded: false });
  }
  return { updated_at: null, total: items.length, items, fallback: true };
}

// ---------------------------------------------------------------- fetch

export class UniverseApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function getJson(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(path, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = rec(rec(body)?.error)?.message;
    throw new UniverseApiError(res.status, typeof msg === 'string' ? msg : res.statusText);
  }
  return body;
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const universeApi = {
  list: async (opts: { market?: UniverseMarketFilter; q?: string; limit?: number; sort?: UniverseSort } = {}) =>
    adaptUniverse(await getJson(`/api/universe${qs(opts)}`)),
  /** 全集没上线时的降级:现有 /api/symbols */
  fallback: async () => universeFromSymbols(await getJson('/api/symbols')),
  refresh: async () => getJson('/api/universe/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
};

/**
 * 全集(一次取全量,本地过滤排序)。/api/universe 出错 → 自动降级到 /api/symbols,`fallback=true`。
 * react-query key ['universe','all'];5 分钟内不重拉(后端每天刷一次,接口读缓存)。
 */
export function useUniverse() {
  return useQuery({
    queryKey: ['universe', 'all'],
    queryFn: async (): Promise<UniverseResponse> => {
      try {
        return await universeApi.list({ market: 'all', limit: 5000, sort: 'volume' });
      } catch {
        return await universeApi.fallback();
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}
