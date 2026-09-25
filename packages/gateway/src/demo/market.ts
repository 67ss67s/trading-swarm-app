// Public USDⓈ-M market data (no key) + deterministic structure features. Everything the model
// "sees" about the market is computed here and registered as evidence by context.ts, so a
// judgment can always be replayed from the numbers that were actually visible.

import type { Market, DailyRegime, Kline, MarketView, SymbolInfo } from './types.js';
import { indicatorSnapshot, type IndicatorSnapshot } from './indicators.js';
import { fetchExchangeInfoOkx, fetchFundingRateHistoryOkx, fetchKlinesOkx, fetchOpenInterestHistOkx, fetchOpenInterestOkx, fetchPremiumIndexOkx, fetchTicker24hOkx } from './market-okx.js';

/**
 * 当前交易所(docs/design/okx-atk-2026-09-20.md §1)。fork 默认 `okx`;`TG_EXCHANGE=binance` 走原来的
 * 币安实现,代码一行不删。每次调用现读,理由同 fapi()。
 */
export function exchange(): 'okx' | 'binance' {
  return process.env['TG_EXCHANGE'] === 'binance' ? 'binance' : 'okx';
}

/**
 * 行情实现选谁。刻意与 exchange() 不同:`TG_DEMO_MARKET_BASE` 一旦被设,就说明调用方(整套现有测试、
 * 也包括手工指定币安镜像的场景)给的是**币安形状**的假服务器;这时除非显式 `TG_EXCHANGE=okx`,
 * 一律继续走币安实现。OKX 的假服务器用 `TG_OKX_REST_BASE`,两条基址互不干扰。
 */
export function marketExchange(): 'okx' | 'binance' {
  const explicit = process.env['TG_EXCHANGE'];
  if (explicit === 'okx' || explicit === 'binance') return explicit;
  if (process.env['TG_DEMO_MARKET_BASE']) return 'binance';
  return 'okx';
}

/**
 * Read per call, not once at import. A module-level const captured whatever `TG_DEMO_MARKET_BASE` was
 * at the moment ANY module in the graph first pulled this file in — so a test that sets the env in
 * `beforeAll` and then dynamic-imports the module under test still got the real Binance URL as soon as
 * some other static import reached market.ts first (2026-09-05: adding one import edge to strategies.ts
 * silently pointed three blind-replay tests at live BTC data).
 */
function fapi(): string {
  return process.env['TG_DEMO_MARKET_BASE'] ?? 'https://fapi.binance.com';
}

/** Network-level failure (undici "fetch failed" / abort) → a message carrying the cause code so logs say ECONNRESET / timeout instead of "fetch failed". */
function describeNetError(e: unknown, path: string, timeoutMs: number): Error {
  const err = e as Error & { cause?: { code?: string; message?: string }; name?: string };
  if (err.name === 'AbortError') return Object.assign(new Error(`${path} 超时 ${timeoutMs}ms`), { transient: true });
  const code = err.cause?.code ?? err.cause?.message ?? err.message;
  return Object.assign(new Error(`${path} 网络错误 ${code}`), { transient: true });
}

/**
 * One GET with timeout and ONE retry on network-level failures only (reset / timeout / DNS). HTTP errors
 * (429 / 418 rate limits, 5xx) are never retried here — hammering Binance on a ban makes it longer.
 * Why retry at all: on this machine every "direct" fetch actually goes through the Clash TUN and its proxy
 * node; node hiccups show up as bursts of ECONNRESET / 8 s timeouts (see docs/handoff, 2026-09-04).
 */
async function getJson<T>(path: string, timeoutMs = 8000, retries = 1): Promise<T> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${fapi()}${path}`, { signal: ctrl.signal });
      if (!res.ok) throw Object.assign(new Error(`${path} -> HTTP ${res.status}`), { transient: false });
      return (await res.json()) as T;
    } catch (e) {
      if ((e as { transient?: boolean }).transient === false) throw e;
      lastErr = describeNetError(e, path, timeoutMs);
      if (attempt < retries) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr ?? new Error(`${path} failed`);
}

type RawKline = [number, string, string, string, string, string, number, ...unknown[]];

async function fetchKlinesBinance(symbol: string, tf: string, limit: number, endTime?: number): Promise<Kline[]> {
  const raw = await getJson<RawKline[]>(`/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=${limit}${endTime ? `&endTime=${Math.floor(endTime)}` : ''}`);
  return raw.map((k) => ({
    open_time: k[0],
    open: k[1],
    high: k[2],
    low: k[3],
    close: k[4],
    volume: k[5],
    close_time: k[6],
  }));
}

export interface PremiumIndex {
  markPrice: string;
  indexPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
  time: number;
}

async function fetchPremiumIndexBinance(symbol: string): Promise<PremiumIndex> {
  return getJson<PremiumIndex>(`/fapi/v1/premiumIndex?symbol=${symbol}`);
}

async function fetchOpenInterestBinance(symbol: string): Promise<{ openInterest: string; time: number }> {
  return getJson(`/fapi/v1/openInterest?symbol=${symbol}`);
}

async function fetchOpenInterestHistBinance(symbol: string, period: string, limit: number): Promise<{ sumOpenInterest: string; sumOpenInterestValue: string; timestamp: number }[]> {
  return getJson(`/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=${limit}`);
}

/**
 * Funding-rate history (fapi /fundingRate) — the 30-day z-score the `funding_oi_extreme` strategy needs.
 * `limit` is capped at 1000 by the exchange; 30 days of 8-hour settlements is ~90 points.
 */
async function fetchFundingRateHistoryBinance(symbol: string, limit = 120, startTime?: number): Promise<{ at: number; rate: string }[]> {
  const raw = await getJson<{ fundingTime: number; fundingRate: string }[]>(
    `/fapi/v1/fundingRate?symbol=${symbol}&limit=${Math.min(1000, Math.max(1, Math.floor(limit)))}${startTime ? `&startTime=${Math.floor(startTime)}` : ''}`,
  );
  return (Array.isArray(raw) ? raw : []).map((r) => ({ at: Number(r.fundingTime), rate: String(r.fundingRate) })).sort((a, b) => a.at - b.at);
}

async function fetchTicker24hBinance(symbol: string): Promise<{ lastPrice: string; priceChangePercent: string; quoteVolume: string; highPrice: string; lowPrice: string }> {
  return getJson(`/fapi/v1/ticker/24hr?symbol=${symbol}`);
}

export async function fetchMarketView(symbol: string, tf: string, market: Market = 'perp'): Promise<MarketView> {
  const [pi, oi, t] = await Promise.all([fetchPremiumIndex(symbol, market), fetchOpenInterest(symbol, market), fetchTicker24h(symbol, market)]);
  return {
    symbol, market,
    last: t.lastPrice,
    // 不能按小数位截:DOGE 0.09473 截成 "0.09" 会让所有低价币的止损/目标判断全错(2026-09-24 运行器联调抓到)
    mark: market === 'spot' ? t.lastPrice : pi.markPrice,
    funding_rate: pi.lastFundingRate,
    next_funding_at: pi.nextFundingTime,
    open_interest: oi.openInterest,
    as_of: Date.now(),
    klines_tf: tf,
  };
}

// ---------- features ----------

export function trimDecimal(s: string, places: number): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return n.toFixed(places);
}

export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev: number | null = null;
  for (const v of values) {
    prev = prev === null ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function atr(klines: Kline[], period: number): number {
  const trs: number[] = [];
  for (let i = 1; i < klines.length; i++) {
    const k = klines[i]!;
    const p = klines[i - 1]!;
    const h = Number(k.high);
    const l = Number(k.low);
    const pc = Number(p.close);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const tail = trs.slice(-period);
  if (tail.length === 0) return 0;
  return tail.reduce((a, b) => a + b, 0) / tail.length;
}

export interface TfFeatures {
  tf: string;
  last_close: number;
  last_open_time: number;
  ema20: number;
  ema50: number;
  atr14: number;
  swing_high_20: number;
  swing_low_20: number;
  /**
   * The same 20-bar extremes over the bars BEFORE the last one. `swing_high_20` includes the last bar,
   * so `last_close > swing_high_20` is arithmetically impossible (close ≤ high ≤ max high) — which is
   * why `scanChecklist`'s "回踩确认" could never fire and the agent never produced a PROPOSE
   * (docs/research/zero-propose-funnel-2026-09-05.md §1). `triggers.ts` always compared against the
   * PREVIOUS window; these two fields let the checklist do the same without a second features object.
   * Optional so recorded eval fixtures and hand-built test features still typecheck.
   */
  swing_high_20_prev?: number;
  swing_low_20_prev?: number;
  swing_high_50: number;
  swing_low_50: number;
  dist_to_high20_pct: number;
  dist_to_low20_pct: number;
  vol_ratio_20: number;
  change_pct_last: number;
  change_pct_5: number;
  last_bars: string;
  /**
   * Full indicator snapshot for the same closed bars (docs/demo/indicators.md). Optional so recorded
   * v2/v3 eval fixtures and hand-built test features still typecheck; live and backtest always have it.
   */
  indicators?: IndicatorSnapshot | null;
}

export function tfFeatures(tf: string, klines: Kline[]): TfFeatures {
  // Drop the still-open last candle so features are computed on closed bars only.
  const closed = klines.filter((k) => k.close_time <= Date.now());
  const ks = closed.length >= 5 ? closed : klines;
  const closes = ks.map((k) => Number(k.close));
  const last = ks[ks.length - 1]!;
  const lastClose = Number(last.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const win20 = ks.slice(-20);
  const win50 = ks.slice(-50);
  const prev20 = ks.slice(-21, -1);
  const hi20 = Math.max(...win20.map((k) => Number(k.high)));
  const lo20 = Math.min(...win20.map((k) => Number(k.low)));
  const hi20prev = prev20.length ? Math.max(...prev20.map((k) => Number(k.high))) : hi20;
  const lo20prev = prev20.length ? Math.min(...prev20.map((k) => Number(k.low))) : lo20;
  const hi50 = Math.max(...win50.map((k) => Number(k.high)));
  const lo50 = Math.min(...win50.map((k) => Number(k.low)));
  const vols = ks.map((k) => Number(k.volume));
  const avgVol20 = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(20, vols.length - 1));
  const prev = ks[ks.length - 2] ?? last;
  const prev5 = ks[ks.length - 6] ?? ks[0]!;
  // 价位小数跟价格走(与 context.ts 结构行同一规则):低价币(DOGE/XRP)用 toFixed(0) 会把 OHLC 全打成 0,模型看不到价格(jacky-f5 09-23 回放发现)。
  const pd = lastClose > 100 ? 0 : lastClose > 1 ? 2 : 5;
  const lastBars = ks
    .slice(-4)
    .map((k) => {
      const o = Number(k.open);
      const c = Number(k.close);
      const body = ((c - o) / o) * 100;
      return `${new Date(k.open_time).toISOString().slice(5, 16).replace('T', ' ')} O${o.toFixed(pd)} H${Number(k.high).toFixed(pd)} L${Number(k.low).toFixed(pd)} C${c.toFixed(pd)} (${body >= 0 ? '+' : ''}${body.toFixed(2)}%)`;
    })
    .join('; ');
  return {
    tf,
    last_close: lastClose,
    last_open_time: last.open_time,
    ema20: e20[e20.length - 1]!,
    ema50: e50[e50.length - 1]!,
    atr14: atr(ks, 14),
    swing_high_20: hi20,
    swing_low_20: lo20,
    swing_high_20_prev: hi20prev,
    swing_low_20_prev: lo20prev,
    swing_high_50: hi50,
    swing_low_50: lo50,
    dist_to_high20_pct: ((hi20 - lastClose) / lastClose) * 100,
    dist_to_low20_pct: ((lastClose - lo20) / lastClose) * 100,
    vol_ratio_20: avgVol20 > 0 ? Number(last.volume) / avgVol20 : 1,
    change_pct_last: ((lastClose - Number(prev.close)) / Number(prev.close)) * 100,
    change_pct_5: ((lastClose - Number(prev5.close)) / Number(prev5.close)) * 100,
    last_bars: lastBars,
    indicators: indicatorSnapshot(ks, tf),
  };
}

export function tfToMs(tf: string): number {
  const m = /^(\d+)([mhdw])$/.exec(tf);
  if (!m) throw new Error(`bad timeframe ${tf}`);
  const n = Number(m[1]);
  const unit = m[2];
  return unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : unit === 'd' ? n * 86_400_000 : n * 604_800_000;
}

/** Next candle close for `tf` strictly after `now`, plus a small grace so the exchange has closed the bar. */
export function nextCloseAfter(now: number, tf: string, graceMs = 5000): number {
  const ms = tfToMs(tf);
  const anchor = tf.endsWith('w') ? 345600000 : 0; // 交易所周线从周一 UTC 开始
  return Math.floor((now - anchor) / ms) * ms + ms + anchor + graceMs;
}

// ---------- exchange info (all USDT perpetuals; no key needed) ----------

interface RawExchangeInfo {
  symbols: { symbol: string; status: string; contractType: string; quoteAsset: string; pricePrecision: number; quantityPrecision: number; filters: { filterType: string; stepSize?: string; tickSize?: string; minQty?: string; notional?: string }[] }[];
}

let exchangeInfoCache: { at: number; rows: SymbolInfo[] } | null = null;

/** Every USDT-margined perpetual (status included so callers can hide non-TRADING). Cached 10 minutes. */
async function fetchExchangeInfoBinance(): Promise<SymbolInfo[]> {
  if (exchangeInfoCache && Date.now() - exchangeInfoCache.at < 10 * 60_000) return exchangeInfoCache.rows;
  const info = await getJson<RawExchangeInfo>('/fapi/v1/exchangeInfo', 15_000);
  const rows: SymbolInfo[] = [];
  for (const s of info.symbols) {
    // TRADIFI_PERPETUAL = Binance's tokenized stock / commodity perps (TSLA, NVDA, XAU …), the 8794 whitelist lives there.
    if ((s.contractType !== 'PERPETUAL' && s.contractType !== 'TRADIFI_PERPETUAL') || s.quoteAsset !== 'USDT') continue;
    const lot = s.filters.find((f) => f.filterType === 'LOT_SIZE');
    const price = s.filters.find((f) => f.filterType === 'PRICE_FILTER');
    const notional = s.filters.find((f) => f.filterType === 'MIN_NOTIONAL');
    rows.push({
      symbol: s.symbol,
      status: s.status,
      price_precision: s.pricePrecision,
      qty_precision: s.quantityPrecision,
      step_size: lot?.stepSize ?? '0.001',
      tick_size: price?.tickSize ?? '0.01',
      min_qty: lot?.minQty ?? lot?.stepSize ?? '0.001',
      min_notional: notional?.notional ?? '5',
    });
  }
  rows.sort((a, b) => (a.status === b.status ? a.symbol.localeCompare(b.symbol) : a.status === 'TRADING' ? -1 : 1));
  exchangeInfoCache = { at: Date.now(), rows };
  return rows;
}

// ---------- daily regime (code-computed; docs/demo/v3-ui-contract.md §6) ----------

/**
 * Bull / bear / range / volatile from daily closes. Deterministic, so the model gets it as evidence
 * instead of guessing the higher-timeframe picture from a few 1h bars.
 *   bull: close > EMA20 > EMA50 (and > EMA200 when available) with 20d return > 0
 *   bear: the mirror
 *   volatile: realized-vol rank ≥ 0.85 of the last 100 days regardless of stack
 *   range: everything else
 */
export function dailyRegime(klines: Kline[], now = Date.now()): DailyRegime | null {
  const closed = klines.filter((k) => k.close_time <= now);
  const ks = closed.length >= 30 ? closed : klines;
  if (ks.length < 30) return null;
  const closes = ks.map((k) => Number(k.close));
  const last = closes[closes.length - 1]!;
  const e20 = ema(closes, 20).at(-1)!;
  const e50 = ema(closes, 50).at(-1)!;
  const e200 = closes.length >= 200 ? ema(closes, 200).at(-1)! : null;
  const ret = (n: number): number => {
    const base = closes[closes.length - 1 - n] ?? closes[0]!;
    return ((last - base) / base) * 100;
  };
  const ret20 = ret(20);
  const ret5 = ret(5);
  // Realized vol: stdev of daily log returns over 20d, ranked against the trailing 100 windows.
  const logs: number[] = [];
  for (let i = 1; i < closes.length; i++) logs.push(Math.log(closes[i]! / closes[i - 1]!));
  const stdev = (xs: number[]): number => {
    if (xs.length < 2) return 0;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  };
  const windows: number[] = [];
  for (let end = logs.length; end >= 20 && windows.length < 100; end--) windows.push(stdev(logs.slice(end - 20, end)));
  const cur = windows[0] ?? 0;
  const rank = windows.length > 1 ? windows.filter((w) => w <= cur).length / windows.length : 0.5;
  const atrPct = (atr(ks, 14) / last) * 100;
  const stackUp = last > e20 && e20 > e50 && (e200 === null || e50 > e200);
  const stackDown = last < e20 && e20 < e50 && (e200 === null || e50 < e200);
  const stack = `${last > e20 ? '价>EMA20' : '价<EMA20'}, ${e20 > e50 ? 'EMA20>EMA50' : 'EMA20<EMA50'}${e200 === null ? '' : e50 > e200 ? ', EMA50>EMA200' : ', EMA50<EMA200'}`;
  let regime: DailyRegime['regime'] = 'range';
  if (rank >= 0.85) regime = 'volatile';
  else if (stackUp && ret20 > 0) regime = 'bull';
  else if (stackDown && ret20 < 0) regime = 'bear';
  const distE200 = e200 === null ? null : ((last - e200) / e200) * 100;
  const label: Record<DailyRegime['regime'], string> = { bull: '日线多头排列(牛)', bear: '日线空头排列(熊)', range: '日线无趋势(震荡)', volatile: '日线高波动' };
  const text = `${label[regime]},${stack};20 日 ${ret20 >= 0 ? '+' : ''}${ret20.toFixed(1)}%,5 日 ${ret5 >= 0 ? '+' : ''}${ret5.toFixed(1)}%;波动率处于近 ${windows.length} 日 ${Math.round(rank * 100)}% 分位,日 ATR ${atrPct.toFixed(2)}%${distE200 === null ? '' : `,距 EMA200 ${distE200 >= 0 ? '+' : ''}${distE200.toFixed(1)}%`}`;
  return { regime, ema_stack: stack, ret_20d_pct: ret20, ret_5d_pct: ret5, vol_pct_rank: rank, atr_pct: atrPct, dist_to_ema200_pct: distE200, text, as_of: ks[ks.length - 1]!.open_time };
}


// ---------- 交易所分发(§3:签名不变,内部按 marketExchange() 选实现) ----------

export function fetchKlines(symbol: string, tf: string, limit: number, endTime?: number, market: Market = 'perp'): Promise<Kline[]> {
  if (market === 'spot' && marketExchange() !== 'okx') throw new Error('market_unsupported');
  return marketExchange() === 'okx' ? fetchKlinesOkx(symbol, tf, limit, endTime, market) : fetchKlinesBinance(symbol, tf, limit, endTime);
}
export function fetchPremiumIndex(symbol: string, market: Market = 'perp'): Promise<PremiumIndex> {
  if (market === 'spot') return Promise.resolve({markPrice:'0', indexPrice:'0', lastFundingRate:'0',nextFundingTime:0,time:Date.now()});
  return marketExchange() === 'okx' ? fetchPremiumIndexOkx(symbol, market) : fetchPremiumIndexBinance(symbol);
}
export function fetchOpenInterest(symbol: string, market: Market = 'perp'): Promise<{ openInterest: string; time: number }> {
  if (market === 'spot') return Promise.resolve({openInterest:'0',time:Date.now()});
  return marketExchange() === 'okx' ? fetchOpenInterestOkx(symbol, market) : fetchOpenInterestBinance(symbol);
}
export function fetchOpenInterestHist(symbol: string, period: string, limit: number, market: Market = 'perp'): Promise<{ sumOpenInterest: string; sumOpenInterestValue: string; timestamp: number }[]> {
  if (market === 'spot') return Promise.resolve([]);
  return marketExchange() === 'okx' ? fetchOpenInterestHistOkx(symbol, period, limit, market) : fetchOpenInterestHistBinance(symbol, period, limit);
}
export function fetchFundingRateHistory(symbol: string, limit = 120, startTime?: number, market: Market = 'perp'): Promise<{ at: number; rate: string }[]> {
  if (market === 'spot') return Promise.resolve([]);
  return marketExchange() === 'okx' ? fetchFundingRateHistoryOkx(symbol, limit, startTime, market) : fetchFundingRateHistoryBinance(symbol, limit, startTime);
}
export function fetchTicker24h(symbol: string, market: Market = 'perp'): Promise<{ lastPrice: string; priceChangePercent: string; quoteVolume: string; highPrice: string; lowPrice: string }> {
  if (market === 'spot' && marketExchange() !== 'okx') throw new Error('market_unsupported');
  return marketExchange() === 'okx' ? fetchTicker24hOkx(symbol, market) : fetchTicker24hBinance(symbol);
}
export function fetchExchangeInfo(market: Market = 'perp'): Promise<SymbolInfo[]> {
  if (market === 'spot' && marketExchange() !== 'okx') throw new Error('market_unsupported');
  return marketExchange() === 'okx' ? fetchExchangeInfoOkx(market) : fetchExchangeInfoBinance();
}

export { fetchBasis } from './market-okx.js';
