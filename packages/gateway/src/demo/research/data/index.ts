/**
 * 研究 loop 的数据层接口(§9.44)。数据层实现 okx.ts / analyses.ts;loop 核心只依赖这里的类型与签名,
 * 测试用假的 MarketData 注入。快照是不可变的:同一请求参数 + 同一 method_version 得到同一 checksum。
 */
export type SnapshotKind = 'price' | 'funding' | 'open_interest' | 'liquidations';
export type Availability = 'available' | 'partial' | 'missing' | 'not_applicable' | 'stale';
export type MetricKey = 'price' | 'funding' | 'open_interest' | 'liquidations' | 'liquidation_estimates' | 'orderbook';
export interface Window { from_ms: number; to_ms: number }
export interface Instrument {
  canonical_id: string;            // 'okx:spot:BTC-USDT' | 'okx:perp:BTC-USDT-SWAP'
  asset_class: 'crypto';
  venue: 'okx';
  market_type: 'spot' | 'perp';
  base: string; quote: string;
  timezone: 'UTC';
  ccxt_symbol: string;             // 'BTC/USDT' | 'BTC/USDT:USDT'
  display: string;                 // 'BTC-USDT 现货' | 'BTC-USDT 永续'
}
export interface Coverage { availability: Availability; earliest?: number | null; latest?: number | null; note: string }
export interface SnapshotDraft {
  kind: SnapshotKind;
  provider: 'okx';
  instrument: Instrument;
  requested_window: Window;
  actual_window: Window | null;
  as_of: number;                   // 最后一行的时间
  fetched_at: number;
  frequency: string | null;        // '1h' / '8h' / null(事件)
  units: Record<string, string>;   // {rate:'fraction_per_8h', oi_value_usd:'USD', price:'USDT'}
  coverage: Availability;
  quality_flags: string[];         // 'truncated_to_recent_100' / 'gap_bars:3' ...
  rows: Record<string, number | string | null>[];
  method_version: string;          // 'okx-data/v1'
  checksum: string;                // sha256(kind+instrument+rows)
}
export interface MarketData {
  resolve(input: { query?: string; symbols?: string[]; market?: 'spot' | 'perp' }, signal?: AbortSignal): Promise<Instrument[]>;
  coverage(instrument: Instrument, metric: MetricKey, window: Window, signal?: AbortSignal): Promise<Coverage>;
  price(instrument: Instrument, timeframe: string, window: Window, signal?: AbortSignal): Promise<SnapshotDraft>;
  funding(instrument: Instrument, window: Window, signal?: AbortSignal): Promise<SnapshotDraft>;
  openInterest(instrument: Instrument, timeframe: string, window: Window, signal?: AbortSignal): Promise<SnapshotDraft>;
  liquidations(instrument: Instrument, window: Window, signal?: AbortSignal): Promise<SnapshotDraft>;
}
export { okxMarketData } from './okx.js';
export * from './analyses.js';
export * from './proxies.js';
export * from './catalog.js';

import { hash } from '../primitives.js';
import { okxMarketData } from './okx.js';
import { adaptersFor, marketTypeOf, resolveDataConcept } from './catalog.js';
/** 一个已接入的数据来源:目录里的 adapter id + 它的运行时实现。 */
export interface MarketAdapterEntry { adapter_id: string; market: MarketData }
const CATALOG_MARKET_VERSION = 'catalog-market/v1';
const cancelled = (e: unknown) => String(e instanceof Error ? e.message : e).includes('CANCELLED');
const reason = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 120);
/**
 * 空快照:一行都没有,coverage 写死 missing,flags 里记清楚试过谁。
 * 注意 provider 仍是 'okx' —— 契约 LoopSnapshot 把 provider 钉成了 const 'okx',真实来源只能记在 quality_flags 的 source: 里。
 * 等第二个 adapter 真的接上时,要先改契约再改这里(schema 归另一工作包)。
 */
function missingDraft(kind: SnapshotKind, instrument: Instrument, requested: Window, frequency: string | null, units: Record<string, string>, flags: string[]): SnapshotDraft {
  return { kind, provider: 'okx', instrument, requested_window: requested, actual_window: null, as_of: requested.to_ms, fetched_at: Date.now(), frequency, units, coverage: 'missing', quality_flags: flags, rows: [], method_version: CATALOG_MARKET_VERSION, checksum: hash({ kind, id: instrument.canonical_id, requested, rows: [], v: CATALOG_MARKET_VERSION }) };
}
/**
 * 按目录顺序尝试多个数据来源的 MarketData。规则:
 * - 目录说这个指标在这个市场不成立 → 直接 not_applicable,一个来源都不调;
 * - 已接来源按 catalog 的 connectedAdapterIds 顺序试,谁先给出非 missing 的快照就用谁,flags 里写 source:<id>;
 * - 某个来源抛错或返回空 missing → 记 adapter_failed / adapter_missing 继续下一个(CANCELLED 例外,直接往上抛);
 * - 全部试完还是没有 → 返回 rows 为空的 missing 快照,flags 里列出试过哪些。任何情况下都不编行。
 */
export function catalogMarketData(opts: { adapters?: MarketAdapterEntry[] } = {}): MarketData {
  let cached: MarketAdapterEntry[] | null = opts.adapters ?? null;
  const adapters = () => (cached ??= [{ adapter_id: 'okx-public', market: okxMarketData() }]);
  const find = (id: string) => adapters().find((a) => a.adapter_id === id);
  /**
   * 尝试顺序 = 目录里登记了这个指标的 adapter 顺序,过滤条件是「目录标了 connected」或「调用方给了运行时实现」——
   * 给了实现就等于接上了,目录的 status 只是默认注册状态。没给实现又标 not_connected 的,这里根本不会被调到。
   */
  const order = (metric: MetricKey, instrument: Instrument) =>
    adaptersFor(metric, marketTypeOf(instrument)).filter((x) => x.adapter.status === 'connected' || !!find(x.adapter.id)).map((x) => x.adapter.id);
  async function attempt(kind: SnapshotKind, metric: MetricKey, instrument: Instrument, requested: Window, frequency: string | null, units: Record<string, string>, run: (m: MarketData) => Promise<SnapshotDraft>): Promise<SnapshotDraft> {
    const resolved = resolveDataConcept(metric, instrument, frequency);
    const flags: string[] = [];
    if (resolved.availability === 'not_applicable') return { ...missingDraft(kind, instrument, requested, frequency, units, [`not_applicable:${resolved.note}`]), coverage: 'not_applicable' };
    const tried: string[] = [];
    for (const id of order(metric, instrument)) {
      const entry = find(id);
      if (!entry) { flags.push(`catalog_connected_no_impl:${id}`); continue; }
      tried.push(id);
      let draft: SnapshotDraft;
      try { draft = await run(entry.market); } catch (e) { if (cancelled(e)) throw e; flags.push(`adapter_failed:${id}:${reason(e)}`); continue; }
      if (draft.coverage === 'missing' && !draft.rows.length) { flags.push(`adapter_missing:${id}`); continue; }
      return { ...draft, quality_flags: [...flags, ...draft.quality_flags, `source:${id}`] };
    }
    flags.push(tried.length ? `tried:${tried.join(',')}` : `no_connected_adapter:${metric}`);
    if (resolved.availability === 'not_connected' && resolved.adapter_id) flags.push(`not_connected:${resolved.adapter_id}`);
    return missingDraft(kind, instrument, requested, frequency, units, flags);
  }
  return {
    async resolve(input, signal) {
      const seen = new Set<string>(), out: Instrument[] = [], failed: string[] = [];
      for (const { adapter_id, market } of adapters()) {
        try { for (const i of await market.resolve(input, signal)) if (!seen.has(i.canonical_id)) { seen.add(i.canonical_id); out.push(i); } } catch (e) { if (cancelled(e)) throw e; failed.push(`${adapter_id}:${reason(e)}`); }
      }
      if (!out.length && failed.length) throw new Error(`PROVIDER_ERROR: all adapters failed (${failed.join('; ')})`);
      return out;
    },
    async coverage(instrument, metric, window, signal) {
      const resolved = resolveDataConcept(metric, instrument, null);
      if (resolved.availability === 'not_applicable') return { availability: 'not_applicable', note: resolved.note };
      for (const id of order(metric, instrument)) {
        const entry = find(id);
        if (!entry) continue;
        try { const c = await entry.market.coverage(instrument, metric, window, signal); if (c.availability !== 'missing') return c; } catch (e) { if (cancelled(e)) throw e; }
      }
      return { availability: 'missing', note: resolved.note };
    },
    price: (instrument, timeframe, window, signal) => attempt('price', 'price', instrument, window, timeframe, { price: instrument.quote, volume: instrument.base }, (m) => m.price(instrument, timeframe, window, signal)),
    funding: (instrument, window, signal) => attempt('funding', 'funding', instrument, window, '8h', { rate: 'fraction_per_8h' }, (m) => m.funding(instrument, window, signal)),
    openInterest: (instrument, timeframe, window, signal) => attempt('open_interest', 'open_interest', instrument, window, timeframe, { oi_value_usd: 'USD', oi_contracts: 'contracts' }, (m) => m.openInterest(instrument, timeframe, window, signal)),
    liquidations: (instrument, window, signal) => attempt('liquidations', 'liquidations', instrument, window, null, { size: 'contracts', price: instrument.quote }, (m) => m.liquidations(instrument, window, signal)),
  };
}
