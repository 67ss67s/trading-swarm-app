// OKX 公共行情(docs/design/okx-atk-2026-09-20.md §3)。不需要 key、不走 CLI 进程:
// K 线抓得很频繁,每次 spawn 一个 node 进程是自找麻烦。
//
// 对外签名与 market.ts 的 Binance 版完全一致(由 market.ts 按 exchange() 分发),
// 差异都在这里抹平:instId、合约张数、新→旧的 K 线顺序、300 条上限、没有 24h 涨跌幅字段。

import { configureOkxProxy } from './okx-proxy.js';
import type { Market, Kline, SymbolInfo } from './types.js';
import { cachedInstruments, contractsToQty, instrumentOf, instrumentsFresh, parseInstruments, parseSpotInstruments, addDec, negDec, mulDec, divDec, setInstruments, symbolInfoOf, symbolToInstId, type OkxInstrument } from './okx/instruments.js';

/** 每次调用现读,理由同 market.ts 的 fapi():模块级常量会在测试设 env 之前就被别的 import 边固化。 */
export function okxBase(): string {
  return process.env['TG_OKX_REST_BASE'] ?? 'https://www.okx.com';
}

function describeNetError(e: unknown, path: string, timeoutMs: number): Error {
  const err = e as Error & { cause?: { code?: string; message?: string }; name?: string };
  if (err.name === 'AbortError') return Object.assign(new Error(`${path} 超时 ${timeoutMs}ms`), { transient: true });
  const code = err.cause?.code ?? err.cause?.message ?? err.message;
  return Object.assign(new Error(`${path} 网络错误 ${code}`), { transient: true });
}

/**
 * 一次 GET + 网络级失败重试一次(与 market.ts 同策略:HTTP 错误不重试,别在限频时加倍捶)。
 * OKX v5 统一包 `{code,data,msg}`;code 非 '0' 当业务错误抛(不重试)。
 */
export async function okxGet<T>(path: string, timeoutMs = 8000, retries = 1): Promise<T> {
  configureOkxProxy();
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${okxBase()}${path}`, { signal: ctrl.signal });
      if (!res.ok) throw Object.assign(new Error(`${path} -> HTTP ${res.status}`), { transient: false });
      const body = (await res.json()) as { code?: string; msg?: string; data?: T };
      if (body && typeof body === 'object' && 'code' in body && String(body.code) !== '0') {
        throw Object.assign(new Error(`${path} -> OKX ${String(body.code)} ${String(body.msg ?? '')}`.trim()), { transient: false });
      }
      return (body?.data ?? ([] as unknown)) as T;
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

// ---------------------------------------------------------------- instruments

const instrumentsInflight = new Map<Market, Promise<OkxInstrument[]>>();

/** 抓 SWAP 合约表并写进 okx/instruments.ts 的缓存(10 分钟)。并发调用合并成一次请求。 */
export async function loadOkxInstruments(force = false, market: Market = 'perp'): Promise<OkxInstrument[]> {
  if (!force && instrumentsFresh(Date.now(), market)) return cachedInstruments(market);
  if (instrumentsInflight.has(market)) return instrumentsInflight.get(market)!;
  const pending = (async () => {
    const raw = await okxGet<unknown[]>(`/api/v5/public/instruments?instType=${market === 'spot' ? 'SPOT' : 'SWAP'}`, 15_000);
    const rows = market === 'spot' ? parseSpotInstruments(raw) : parseInstruments(raw);
    setInstruments(rows, Date.now(), market);
    return rows;
  })().finally(() => {
    instrumentsInflight.delete(market);
  });
  instrumentsInflight.set(market, pending);
  return pending;
}

/** 合约的规格;缓存里没有就先抓一次表。 */
export async function okxInstrument(symbol: string, market: Market = 'perp'): Promise<OkxInstrument> {
  const hit = instrumentOf(symbol, market);
  if (hit && instrumentsFresh(Date.now(), market)) return hit;
  await loadOkxInstruments(false, market);
  const after = instrumentOf(symbol, market);
  if (!after) throw new Error(`OKX 没有这个合约:${symbol}(${symbolToInstId(symbol)})`);
  return after;
}

/** 张数 → 币,给结算/持仓/挂单用;合约表里没有就按 1:1(不吞掉数字,调用方至少拿到原值)。 */
export function contractsToQtySync(sz: string | number, symbol: string): string {
  const inst = instrumentOf(symbol);
  return inst ? contractsToQty(sz, inst) : String(sz);
}

// ---------------------------------------------------------------- K 线

/**
 * 内部 timeframe → OKX bar(§3)。**≥6H 的档位必须用 UTC 版**:OKX 不带 `utc` 后缀的
 * `6H/12H/1D/1W` 按香港时间(UTC+8)分桶,策略与指标全系统按 UTC 切(codex-review #15)。
 * `1m…4H` 没有 utc 变体 —— 这些档位在两种时区下的边界本来就重合,原样发。
 */
export function tfToBar(tf: string): string {
  const map: Record<string, string> = {
    '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
    '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6Hutc', '12h': '12Hutc',
    '1d': '1Dutc', '3d': '3Dutc', '1w': '1Wutc',
  };
  return map[tf] ?? tf;
}

function tfMs(tf: string): number {
  const m = /^(\d+)([mhdw])$/.exec(tf);
  if (!m) return 60_000;
  const n = Number(m[1]);
  const u = m[2];
  return u === 'm' ? n * 60_000 : u === 'h' ? n * 3_600_000 : u === 'd' ? n * 86_400_000 : n * 604_800_000;
}

/** OKX 单次 candles 上限。 */
const CANDLE_PAGE = 300;
/** history-candles 的单次上限只有 100。 */
const HISTORY_PAGE = 100;

type RawCandle = [string, string, string, string, string, string, string, string, string];

/**
 * K 线。OKX 返回**新→旧**,这里反成旧→新(和 Binance 一致);limit > 300 时用 `after` 往更早翻页。
 * 含当前未收盘那根(和 Binance 的 klines 一致,`confirm==='0'` 不过滤),下游 tfFeatures 自己按
 * close_time 丢掉未收盘的。成交量取 `volCcy`(币本位),对应 Binance 的 base volume。
 *
 * 两个端点:`/market/candles` 只覆盖最近约 1440 根,再往前它**返回空数组而不是报错**——只靠它的话
 * 深 limit 会静默少给数据,endTime 落在窗外直接空手而归(下游看起来像「这个币历史很短」)。
 * 所以一旦某页空了或不足,就切到 `/market/history-candles` 继续往前翻(单页 100)。
 */
export async function fetchKlinesOkx(symbol: string, tf: string, limit: number, endTime?: number, market: Market = 'perp'): Promise<Kline[]> {
  const instId = symbolToInstId(symbol, market);
  const bar = tfToBar(tf);
  const span = tfMs(tf);
  const want = Math.max(1, Math.floor(limit));
  const rows: RawCandle[] = [];
  // after = 「返回 ts 比它更早的数据」。endTime 要含当根,所以 +1。
  let after = endTime ? Math.floor(endTime) + 1 : null;
  let history = false;
  let guard = 0;
  while (rows.length < want && guard++ < 200) {
    const pageCap = history ? HISTORY_PAGE : CANDLE_PAGE;
    const n = Math.min(pageCap, want - rows.length);
    const endpoint = history ? 'history-candles' : 'candles';
    const q = `instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${n}${after === null ? '' : `&after=${after}`}`;
    const page = await okxGet<RawCandle[]>(`/api/v5/market/${endpoint}?${q}`);
    if (Array.isArray(page) && page.length > 0) {
      rows.push(...page);
      const oldest = Number(page[page.length - 1]![0]);
      if (!Number.isFinite(oldest)) break;
      after = oldest; // 下一页要更早的;OKX 的 after 是严格小于
      continue;
    }
    // 只在**真的空页**上切换:短页(OKX 偶尔会削页)继续用当前端点更划算(300/页 vs 100/页),
    // 游标已经往前推了,不会原地打转。
    if (history) break; // 归档端点也给不出更多了 = 真的没有了
    history = true; // 近窗到头,换归档端点接着往前
  }
  const out = rows.map((k) => ({
    open_time: Number(k[0]),
    open: k[1],
    high: k[2],
    low: k[3],
    close: k[4],
    volume: market === 'spot' ? k[5] : k[6], // volCcy = 币本位成交量
    close_time: Number(k[0]) + span - 1,
  }));
  out.sort((a, b) => a.open_time - b.open_time);
  // 两个端点的窗口有重叠,去重后再截取。
  const seen = new Set<number>();
  const uniq = out.filter((k) => (seen.has(k.open_time) ? false : (seen.add(k.open_time), true)));
  return uniq.slice(-want);
}

// ---------------------------------------------------------------- 批量行情缓存
// OKX 公共行情按 IP 限频(ticker / mark-price 约 20 次 / 2s)。轮询曾对观察列表逐币 × 5 个接口各打一次,
// 20 多个币就是每轮上百个请求,15 分钟 1500+ 次 429,把运行器和下单前取标记价一起拖死(2026-09-24)。
// 改成全市场批量接口:一次请求拿到整个 instType,短 TTL 内所有币共用,并发调用合并成一个请求(single-flight)。
type Row = Record<string, string | undefined>;
const batchCache = new Map<string, { at: number; rows: Map<string, Row> }>();
const batchInflight = new Map<string, Promise<Map<string, Row>>>();
async function batchRows(path: string, ttlMs: number, key: (r: Row) => string = (r) => String(r['instId'] ?? '')): Promise<Map<string, Row>> {
  const cacheKey = `${okxBase()}:${path}`;
  const hit = batchCache.get(cacheKey);
  if (hit && Date.now() - hit.at < ttlMs) return hit.rows;
  const running = batchInflight.get(cacheKey);
  if (running) return running;
  const p = okxGet<Row[]>(path, 15_000)
    .then((raw) => {
      const rows = new Map((Array.isArray(raw) ? raw : []).map((r) => [key(r), r] as const));
      batchCache.set(cacheKey, { at: Date.now(), rows });
      return rows;
    })
    .catch((e) => {
      // 批量失败时短时间内沿用上一份(行情晚几秒比整轮失败好),没有上一份才抛
      if (hit) return hit.rows;
      throw e;
    })
    .finally(() => batchInflight.delete(cacheKey));
  batchInflight.set(cacheKey, p);
  return p;
}
async function batchRow(path: string, ttlMs: number, id: string, key?: (r: Row) => string): Promise<Row> {
  const row = (await batchRows(path, ttlMs, key)).get(id);
  if (!row) throw new Error(`OKX 没有 ${id} 的行情(${path.split('?')[0]})`);
  return row;
}
const fundingCache = new Map<string, { at: number; row: Row }>();
async function fundingRow(instId: string): Promise<Row> {
  const hit = fundingCache.get(instId);
  if (hit && Date.now() - hit.at < 60_000) return hit.row;
  const row = (await okxGet<Row[]>(`/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`))[0] ?? {};
  fundingCache.set(instId, { at: Date.now(), row });
  return row;
}

// ---------------------------------------------------------------- 溢价 / 资金费 / 持仓量

export async function fetchPremiumIndexOkx(symbol: string, market: Market = 'perp'): Promise<{ markPrice: string; indexPrice: string; lastFundingRate: string; nextFundingTime: number; time: number }> {
  if (market === 'spot') return { markPrice: '0', indexPrice: '0', lastFundingRate: '0', nextFundingTime: 0, time: Date.now() };
  const instId = symbolToInstId(symbol, market);
  const family = instId.replace(/-SWAP$/, '');
  const [m, f, index] = await Promise.all([
    batchRow('/api/v5/public/mark-price?instType=SWAP', 3_000, instId),
    fundingRow(instId),
    // 指数价只是展示用,拿不到就退回标记价,不让整条行情因为它失败。
    batchRow('/api/v5/market/index-tickers?quoteCcy=USDT', 10_000, family).catch(() => ({}) as Row),
  ]);
  const markPrice = String(m['markPx'] ?? '0');
  return {
    markPrice,
    indexPrice: String(index['idxPx'] ?? markPrice),
    lastFundingRate: String(f['fundingRate'] ?? '0'),
    nextFundingTime: Number(f['fundingTime'] ?? 0),
    time: Number(m['ts'] ?? f['ts'] ?? Date.now()),
  };
}

/** 持仓量:Binance 的 openInterest 是币本位 → OKX 的 `oiCcy`。 */
export async function fetchOpenInterestOkx(symbol: string, market: Market = 'perp'): Promise<{ openInterest: string; time: number }> {
  if (market === 'spot') return { openInterest: '0', time: Date.now() };
  const instId = symbolToInstId(symbol, market);
  const r = await batchRow('/api/v5/public/open-interest?instType=SWAP', 30_000, instId);
  return { openInterest: String(r['oiCcy'] ?? r['oi'] ?? '0'), time: Number(r['ts'] ?? Date.now()) };
}

/** Binance 的 openInterestHist period → OKX rubik period。 */
export function periodToOkx(period: string): string {
  const map: Record<string, string> = { '5m': '5m', '15m': '15m', '30m': '15m', '1h': '1H', '2h': '1H', '4h': '4H', '6h': '4H', '12h': '4H', '1d': '1D' };
  return map[period] ?? period;
}

/** 持仓量历史。rubik 返回 `[ts, oi(张), oiCcy(币), oiUsd]`,新→旧,这里反成旧→新。单页实际上限 100(要更多得自己翻页)。 */
export async function fetchOpenInterestHistOkx(symbol: string, period: string, limit: number, market: Market = 'perp'): Promise<{ sumOpenInterest: string; sumOpenInterestValue: string; timestamp: number }[]> {
  if (market === 'spot') return [];
  const instId = symbolToInstId(symbol, market);
  const rows = await okxGet<[string, string, string, string][]>(
    `/api/v5/rubik/stat/contracts/open-interest-history?instId=${encodeURIComponent(instId)}&period=${periodToOkx(period)}&limit=${Math.min(100, Math.max(1, Math.floor(limit)))}`,
  );
  return (Array.isArray(rows) ? rows : [])
    .map((r) => ({ sumOpenInterest: String(r[2] ?? '0'), sumOpenInterestValue: String(r[3] ?? '0'), timestamp: Number(r[0]) }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

/** 资金费历史。OKX 单页 100 条、新→旧;`realizedRate` 是已结算的真实费率,优先用它。 */
export async function fetchFundingRateHistoryOkx(symbol: string, limit = 120, startTime?: number, market: Market = 'perp'): Promise<{ at: number; rate: string }[]> {
  if (market === 'spot') return [];
  const instId = symbolToInstId(symbol, market);
  const want = Math.min(1000, Math.max(1, Math.floor(limit)));
  const out: { at: number; rate: string }[] = [];
  let after: number | null = null;
  while (out.length < want) {
    const n = Math.min(100, want - out.length);
    const q: string = `instId=${encodeURIComponent(instId)}&limit=${n}${after === null ? '' : `&after=${after}`}`;
    const page = await okxGet<{ fundingTime?: string; fundingRate?: string; realizedRate?: string }[]>(`/api/v5/public/funding-rate-history?${q}`);
    if (!Array.isArray(page) || page.length === 0) break;
    for (const r of page) out.push({ at: Number(r.fundingTime ?? 0), rate: String(r.realizedRate || r.fundingRate || '0') });
    const oldest = Number(page[page.length - 1]?.fundingTime ?? 0);
    if (!Number.isFinite(oldest) || oldest <= 0) break;
    if (startTime && oldest <= startTime) break;
    after = oldest;
    if (page.length < n) break;
  }
  return out.filter((r) => !startTime || r.at >= startTime).sort((a, b) => a.at - b.at);
}

/**
 * 24h ticker。OKX 不给涨跌幅,自己按 `(last-open24h)/open24h×100` 算;
 * quoteVolume 用 `volCcy24h × last` 近似(OKX 的 `vol24h` 是张数,不是 U)。
 */
export async function fetchTicker24hOkx(symbol: string, market: Market = 'perp'): Promise<{ lastPrice: string; priceChangePercent: string; quoteVolume: string; highPrice: string; lowPrice: string }> {
  const instId = symbolToInstId(symbol, market);
  const t = await batchRow(`/api/v5/market/tickers?instType=${market === 'spot' ? 'SPOT' : 'SWAP'}`, 3_000, instId);
  const last = Number(t['last'] ?? '0');
  const open = Number(t['open24h'] ?? '0');
  const pct = open > 0 ? ((last - open) / open) * 100 : 0;
  return {
    lastPrice: String(t['last'] ?? '0'),
    priceChangePercent: pct.toFixed(3),
    quoteVolume: (Number(t['volCcy24h'] ?? '0') * (market === 'spot' ? 1 : last)).toFixed(2),
    highPrice: String(t['high24h'] ?? '0'),
    lowPrice: String(t['low24h'] ?? '0'),
  };
}

// ---------------------------------------------------------------- exchange info

const infoCaches = new Map<Market, { at: number; rows: SymbolInfo[] }>();

/**
 * 全部 USDT 本位永续的规格(§2)。min_notional 要最新价,顺手拉一次全市场 tickers
 * (一个请求),失败就退回 '5'。缓存 10 分钟,和 instruments 同步。
 */
export async function fetchExchangeInfoOkx(market: Market = 'perp'): Promise<SymbolInfo[]> {
  const infoCache = infoCaches.get(market);
  if (infoCache && Date.now() - infoCache.at < 10 * 60_000) return infoCache.rows;
  const [insts, tickers] = await Promise.all([
    loadOkxInstruments(true, market),
    okxGet<{ instId?: string; last?: string }[]>(`/api/v5/market/tickers?instType=${market === 'spot' ? 'SPOT' : 'SWAP'}`, 15_000).catch(() => [] as { instId?: string; last?: string }[]),
  ]);
  const last = new Map((Array.isArray(tickers) ? tickers : []).map((t) => [String(t.instId ?? ''), String(t.last ?? '')]));
  const rows = insts.map((i) => symbolInfoOf(i, last.get(i.instId) ?? null));
  rows.sort((a, b) => (a.status === b.status ? a.symbol.localeCompare(b.symbol) : a.status === 'TRADING' ? -1 : 1));
  infoCaches.set(market, { at: Date.now(), rows });
  return rows;
}

/** 测试用:丢掉 exchangeInfo 缓存。 */
export function resetOkxMarketCaches(): void {
  infoCaches.clear();
  instrumentsInflight.clear();
  batchCache.clear();
  batchInflight.clear();
  fundingCache.clear();
  basisCache.clear();
}

export interface BasisView {
  symbol: string; spot_last: string; perp_mark: string; perp_last: string; basis: string; basis_pct: string;
  funding_rate: string; funding_interval_ms: number; funding_annualized_pct: string; next_funding_at: number; as_of: number;
}
const basisCache = new Map<string, BasisView>();
export async function fetchBasis(symbol: string): Promise<BasisView> {
  const key = `${okxBase()}:${symbol}`;
  const cached = basisCache.get(key);
  if (cached && Date.now() - cached.as_of < 10_000) return cached;
  const instId = symbolToInstId(symbol);
  const [spot, perp] = await Promise.allSettled([
    fetchTicker24hOkx(symbol, 'spot'),
    Promise.all([fetchTicker24hOkx(symbol), okxGet<{markPx:string}[]>(`/api/v5/public/mark-price?instType=SWAP&instId=${encodeURIComponent(instId)}`),
      okxGet<{fundingRate:string; fundingTime:string; nextFundingTime:string}[]>(`/api/v5/public/funding-rate?instId=${encodeURIComponent(instId)}`)]),
  ]);
  const unavailable = (missing: 'spot' | 'perp'): never => { throw Object.assign(new Error('basis_unavailable'), { status: 404, missing }); };
  if (spot.status !== 'fulfilled' || !(Number(spot.value.lastPrice) > 0)) return unavailable('spot');
  if (perp.status !== 'fulfilled') return unavailable('perp');
  const [ticker, marks, funding] = perp.value;
  const mark = marks[0]?.markPx, f = funding[0];
  if (!mark || !(Number(mark) > 0) || !(Number(ticker.lastPrice) > 0) || !f || !Number.isFinite(Number(f.fundingRate))) return unavailable('perp');
  const interval = Number(f.nextFundingTime) - Number(f.fundingTime);
  const funding_interval_ms = interval > 0 ? interval : 28_800_000;
  const basis = addDec(mark, negDec(spot.value.lastPrice));
  const view: BasisView = { symbol, spot_last: spot.value.lastPrice, perp_mark: mark, perp_last: ticker.lastPrice, basis,
    basis_pct: mulDec(divDec(basis, spot.value.lastPrice, 12), '100'), funding_rate: f.fundingRate, funding_interval_ms,
    funding_annualized_pct: divDec(mulDec(f.fundingRate, '3153600000000'), String(funding_interval_ms), 8),
    next_funding_at: Number(f.fundingTime), as_of: Date.now() };
  basisCache.set(key, view); return view;
}
