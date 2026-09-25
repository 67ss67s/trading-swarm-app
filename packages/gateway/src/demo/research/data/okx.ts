/**
 * OKX 公共数据适配器(§9.44 数据层)。只读公共接口:现货/永续 K 线、资金费结算历史、持仓量历史、已发生清算。
 * 没有账户、没有下单。每个快照带 requested/actual 窗口、单位、覆盖状态和 checksum;缺数据返回 coverage 而不是空数组假装有。
 * 清算热图(估计)没有数据源,这里根本不提供,由 loop 的 get_liquidation_estimates 固定返回 missing。
 */
import { publicExchange, type PublicExchange } from '../market-ccxt.js';
import { timeframeMillis } from '../strategy.js';
import { hash } from '../primitives.js';
import type { Coverage, Instrument, MarketData, MetricKey, SnapshotDraft, SnapshotKind, Window } from './index.js';
export const OKX_DATA_VERSION = 'okx-data/v1';
const FUNDING_INTERVAL_MS = 8 * 3600_000;
const LIQ_PAGE = 100, LIQ_MAX_PAGES = 5;
interface RawMarket { symbol: string; base: string; quote: string; spot?: boolean; swap?: boolean; linear?: boolean; active?: boolean; settle?: string; id?: string }
type Client = PublicExchange & {
  fetchFundingRateHistory?(symbol: string, since?: number, limit?: number): Promise<{ timestamp: number; fundingRate: number }[]>;
  fetchOpenInterestHistory?(symbol: string, timeframe?: string, since?: number, limit?: number, params?: Record<string, unknown>): Promise<{ timestamp: number; openInterestAmount?: number; openInterestValue?: number }[]>;
  fetch?(url: string, method?: string, headers?: unknown, body?: unknown): Promise<unknown>;
};
const checkWindow = (w: Window) => { if (!Number.isSafeInteger(w.from_ms) || !Number.isSafeInteger(w.to_ms) || w.from_ms >= w.to_ms) throw new Error('invalid_window'); };
const aborted = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error('CANCELLED'); };
function draft(kind: SnapshotKind, instrument: Instrument, requested: Window, rows: Record<string, number | string | null>[], tsKey: string, units: Record<string, string>, frequency: string | null, flags: string[], coverageHint?: SnapshotDraft['coverage']): SnapshotDraft {
  const sorted = [...rows].sort((a, b) => Number(a[tsKey]) - Number(b[tsKey]));
  const first = sorted[0] ? Number(sorted[0][tsKey]) : null, last = sorted.at(-1) ? Number(sorted.at(-1)![tsKey]) : null;
  const actual = first !== null && last !== null ? { from_ms: first, to_ms: last } : null;
  let coverage: SnapshotDraft['coverage'] = coverageHint ?? 'available';
  if (!coverageHint) {
    if (!sorted.length) coverage = 'missing';
    else if (frequency && first !== null && (first - requested.from_ms > 2 * timeframeMillis(frequency === '8h' ? '8h' : frequency) || requested.to_ms - last! > 2 * timeframeMillis(frequency === '8h' ? '8h' : frequency))) coverage = 'partial';
  }
  return { kind, provider: 'okx', instrument, requested_window: requested, actual_window: actual, as_of: last ?? requested.to_ms, fetched_at: Date.now(), frequency, units, coverage, quality_flags: flags, rows: sorted, method_version: OKX_DATA_VERSION, checksum: hash({ kind, id: instrument.canonical_id, requested, rows: sorted, v: OKX_DATA_VERSION }) };
}
export function okxMarketData(opts: { exchange?: string; client?: Client } = {}): MarketData {
  const exchange = opts.exchange ?? 'okx';
  let clientP: Promise<Client> | null = opts.client ? Promise.resolve(opts.client) : null;
  const client = () => (clientP ??= publicExchange(exchange) as Promise<Client>);
  let marketsP: Promise<Record<string, RawMarket>> | null = null;
  // 首次 loadMarkets 失败(代理掐连接「other side closed」)不能把失败的 promise 缓存成永久失败:清掉下次重试(2026-09-23 实测 18811 重启后 resolve_instruments 一直 PROVIDER_ERROR)
  const markets = () => (marketsP ??= client().then((c) => c.loadMarkets() as Promise<Record<string, RawMarket>>).catch((e) => { marketsP = null; throw e; }));
  const toInstrument = (m: RawMarket): Instrument => {
    const perp = m.swap === true;
    return { canonical_id: perp ? `okx:perp:${m.base}-${m.quote}-SWAP` : `okx:spot:${m.base}-${m.quote}`, asset_class: 'crypto', venue: 'okx', market_type: perp ? 'perp' : 'spot', base: m.base, quote: m.quote, timezone: 'UTC', ccxt_symbol: m.symbol, display: `${m.base}-${m.quote} ${perp ? '永续' : '现货'}` };
  };
  const findMarket = async (i: Instrument): Promise<RawMarket> => { const m = (await markets())[i.ccxt_symbol]; if (!m) throw new Error('UNSUPPORTED_ASSET'); return m; };
  return {
    async resolve(input, signal) {
      aborted(signal);
      const all = Object.values(await markets()).filter((m) => m.active !== false && m.quote === 'USDT' && (m.spot === true || (m.swap === true && m.linear !== false)));
      const bases = new Set<string>();
      for (const s of input.symbols ?? []) { const b = s.toUpperCase().replace(/[-/:_].*$/, '').replace(/USDT$/, ''); if (b) bases.add(b); }
      if (input.query) {
        const known = new Set(all.map((m) => m.base));
        for (const tok of input.query.toUpperCase().match(/[A-Z0-9]{2,10}/g) ?? []) { const b = tok.replace(/USDT$/, ''); if (known.has(b)) bases.add(b); }
        for (const [zh, b] of Object.entries({ 比特币: 'BTC', 以太坊: 'ETH', 以太: 'ETH', 索拉纳: 'SOL', 狗狗币: 'DOGE' })) if (input.query.includes(zh)) bases.add(b);
      }
      const out: Instrument[] = [];
      for (const b of bases) for (const m of all.filter((x) => x.base === b)) { const i = toInstrument(m); if (!input.market || i.market_type === input.market) out.push(i); }
      // 现货在前、永续在后;同一 base 两个市场都给,规划器按指标选(资金费/OI/清算只有永续有)
      return out.sort((a, b) => a.base.localeCompare(b.base) || (a.market_type === 'spot' ? -1 : 1));
    },
    async coverage(instrument, metric: MetricKey, window, signal) {
      aborted(signal); checkWindow(window);
      const perpOnly = (note: string): Coverage => instrument.market_type === 'perp' ? { availability: 'available', note } : { availability: 'not_applicable', note: '现货没有资金费 / 持仓量 / 强平;这些指标只在永续合约上成立' };
      if (metric === 'price') return { availability: 'available', note: 'OKX 公共 K 线,已收盘' };
      if (metric === 'funding') return perpOnly('OKX 资金费结算历史,每 8 小时一期,比率是每期分数(不年化)');
      if (metric === 'open_interest') return perpOnly('OKX 合约持仓量历史(USD 名义)');
      if (metric === 'liquidations') return perpOnly('OKX 公共强平订单:只提供最近记录,长窗口只能部分覆盖');
      if (metric === 'liquidation_estimates') return { availability: 'missing', note: '潜在清算区域(估计热图)没有数据源,尚未接入;不能用 K 线或成交量伪造' };
      return { availability: 'missing', note: '订单簿快照本版未接入' };
    },
    async price(instrument, timeframe, window, signal) {
      aborted(signal); checkWindow(window); const step = timeframeMillis(timeframe), c = await client(); await findMarket(instrument);
      const rows: Record<string, number | string | null>[] = []; let cursor = Math.floor(window.from_ms / step) * step; const now = Date.now();
      // 窗口起点早于上市:OKX 带 since 的请求在上市前返回空(会被当成缺数据)。先探 since 处有没有 bar,没有就在 [from,to] 上二分首根(约 log2(根数) 次请求)
      const has = async (at: number) => (await c.fetchOHLCV(instrument.ccxt_symbol, timeframe, at, 1)).some((r) => typeof r[0] === 'number' && r[0] >= at && r[0] < at + 2 * step);
      const flagsPre: string[] = [];
      if (!(await has(cursor))) {
        let lo = cursor, hi = Math.floor((Math.min(window.to_ms, now) - step) / step) * step;
        if (hi > lo && (await has(hi))) { while (hi - lo > step) { aborted(signal); const mid = lo + Math.floor((hi - lo) / 2 / step) * step; if (await has(mid)) hi = mid; else lo = mid; } cursor = hi; flagsPre.push('window_before_listing'); }
      }
      for (let page = 0; page < 400 && cursor <= window.to_ms; page++) {
        aborted(signal);
        const batch = await c.fetchOHLCV(instrument.ccxt_symbol, timeframe, cursor, 100); if (!batch.length) break; let max = cursor - 1;
        for (const r of batch) { if (r.length < 6 || r.slice(0, 6).some((x) => typeof x !== 'number' || !Number.isFinite(x))) continue; const [at, o, h, l, cl, v] = r as number[]; max = Math.max(max, at!); if (at! < window.from_ms || at! + step - 1 > window.to_ms || at! + step > now) continue; rows.push({ open_time: at!, close_time: at! + step - 1, open: o!.toFixed(8), high: h!.toFixed(8), low: l!.toFixed(8), close: cl!.toFixed(8), volume: v!.toFixed(8) }); }
        if (max < cursor) break; cursor = max + step;
      }
      const flags: string[] = [...flagsPre]; for (let i = 1; i < rows.length; i++) if (Number(rows[i]!.open_time) - Number(rows[i - 1]!.open_time) !== step) { flags.push('gap_bars'); break; }
      return draft('price', instrument, window, rows, 'close_time', { price: instrument.quote, volume: instrument.base }, timeframe, flags);
    },
    async funding(instrument, window, signal) {
      aborted(signal); checkWindow(window); if (instrument.market_type !== 'perp') return draft('funding', instrument, window, [], 'ts', { rate: 'fraction_per_8h' }, '8h', ['not_applicable_spot'], 'not_applicable');
      const c = await client(); if (!c.fetchFundingRateHistory) throw new Error('PROVIDER_ERROR: funding history unsupported');
      const rows: Record<string, number | string | null>[] = []; let since = window.from_ms;
      for (let page = 0; page < 50; page++) { aborted(signal); const batch = await c.fetchFundingRateHistory(instrument.ccxt_symbol, since, 100); if (!batch.length) break; let max = since; for (const f of batch) { if (!Number.isFinite(f.timestamp) || !Number.isFinite(f.fundingRate)) continue; max = Math.max(max, f.timestamp); if (f.timestamp >= window.from_ms && f.timestamp <= window.to_ms && !rows.some((r) => r.ts === f.timestamp)) rows.push({ ts: f.timestamp, rate: f.fundingRate, interval_ms: FUNDING_INTERVAL_MS, kind: 'settled' }); } if (max <= since || max > window.to_ms) break; since = max + 1; }
      return draft('funding', instrument, window, rows, 'ts', { rate: 'fraction_per_8h' }, '8h', ['settled_only_no_prediction']);
    },
    async openInterest(instrument, timeframe, window, signal) {
      aborted(signal); checkWindow(window); if (instrument.market_type !== 'perp') return draft('open_interest', instrument, window, [], 'ts', { oi_value_usd: 'USD' }, timeframe, ['not_applicable_spot'], 'not_applicable');
      const c = await client(); if (!c.fetchOpenInterestHistory) throw new Error('PROVIDER_ERROR: open interest history unsupported');
      const step = timeframeMillis(timeframe), rows: Record<string, number | string | null>[] = []; let since = window.from_ms;
      for (let page = 0; page < 50; page++) { aborted(signal); const batch = await c.fetchOpenInterestHistory(instrument.ccxt_symbol, timeframe, since, 100, { until: window.to_ms }); if (!batch.length) break; let max = since; for (const o of batch) { if (!Number.isFinite(o.timestamp)) continue; max = Math.max(max, o.timestamp); if (o.timestamp >= window.from_ms && o.timestamp <= window.to_ms && !rows.some((r) => r.ts === o.timestamp)) rows.push({ ts: o.timestamp, oi_contracts: Number.isFinite(o.openInterestAmount) ? o.openInterestAmount! : null, oi_value_usd: Number.isFinite(o.openInterestValue) ? o.openInterestValue! : null }); } if (max <= since || max + step > window.to_ms) break; since = max + 1; }
      return draft('open_interest', instrument, window, rows, 'ts', { oi_value_usd: 'USD', oi_contracts: 'contracts' }, timeframe, []);
    },
    async liquidations(instrument, window, signal) {
      aborted(signal); checkWindow(window); if (instrument.market_type !== 'perp') return draft('liquidations', instrument, window, [], 'ts', { size: 'contracts', price: instrument.quote }, null, ['not_applicable_spot'], 'not_applicable');
      const c = await client(); const m = await findMarket(instrument); if (!c.fetch) throw new Error('PROVIDER_ERROR: raw fetch unsupported');
      const uly = `${m.base}-${m.quote}`, rows: Record<string, number | string | null>[] = [], flags: string[] = []; let before: string | null = null, pages = 0, oldest = Infinity;
      for (; pages < LIQ_MAX_PAGES; pages++) {
        aborted(signal);
        const url = `https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&uly=${encodeURIComponent(uly)}&state=filled&limit=${LIQ_PAGE}${before ? `&after=${before}` : ''}`;
        const res = (await c.fetch(url, 'GET')) as { code?: string; msg?: string; data?: { details?: { ts: string; side: string; posSide: string; sz: string; bkPx: string }[] }[] };
        if (res.code !== '0') throw new Error(`PROVIDER_ERROR: okx ${res.code} ${res.msg ?? ''}`);
        const details = res.data?.[0]?.details ?? []; if (!details.length) break;
        for (const d of details) { const ts = Number(d.ts); oldest = Math.min(oldest, ts); if (ts >= window.from_ms && ts <= window.to_ms) rows.push({ ts, side: d.side, pos_side: d.posSide, size: Number(d.sz), price: d.bkPx }); }
        before = details.at(-1)!.ts; if (oldest < window.from_ms || details.length < LIQ_PAGE) break;
      }
      if (oldest > window.from_ms) flags.push(`truncated_to_recent_${pages * LIQ_PAGE}`);
      return draft('liquidations', instrument, window, rows, 'ts', { size: 'contracts', price: instrument.quote }, null, flags, oldest > window.from_ms ? 'partial' : rows.length ? 'available' : 'available');
    },
  };
}
