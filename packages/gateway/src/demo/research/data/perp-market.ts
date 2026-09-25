/**
 * OKX USDT 线性永续回测数据层(WP-F):成交价 K 线 + 标记价 K 线 + 资金费(OKX 官方 > 币安代理)+ 维持保证金分档,全部落本地 sqlite 缓存、增量拉取。
 * 只读公共接口,不碰账户。真实网络走全局 fetch(先 configureOkxProxy 让 Node 24 fetch 继承 HTTPS_PROXY);所有入口可注入 fetchFn/sleep/now,测试零网络。
 * 口径:K 线周期一律 UTC 对齐(6h/12h/1d 用 OKX 的 6Hutc/12Hutc/1Dutc,不用香港时间对齐的 6H/12H/1D);未收盘 K 线不入库;
 * 资金费同一 ts 优先 OKX,币安只填 OKX 官方覆盖不到的时段并在溯源里写明代理到哪天、偏差多大;分档是当前值不是历史值。
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ResearchBar } from '@trading-swarm/contracts';
import type { FundingPoint, FundingSeries, MmrTier, OrderBar } from '../orders/types.js';
import { configureOkxProxy } from '../../okx-proxy.js';
import { timeframeMillis } from '../strategy.js';
import { readZipText } from './zip.js';
export const PERP_MARKET_VERSION = 'perp-market/v1';
const OKX = 'https://www.okx.com', BN_VISION = 'https://data.binance.vision';
const MIN = 60_000, H = 3600_000, DAY = 86_400_000, FUNDING_MS = 8 * H, TTL_MS = 7 * DAY, PAGE = 100, THROTTLE_MS = 110;
/** OKX 月度资金费归档最早月份(UTC+8 月);更早不去请求,直接走币安代理 */
const OKX_ARCHIVE_FIRST = '2022-01';
/** 归档列表接口 begin~end 不能超过 10 个月(50077),每段最多 9 个月 */
const ARCHIVE_SPAN = 9;
/** 资金费 REST 只能回约 3 个月;更早的月份不白打请求 */
const REST_REACH_MS = 100 * DAY;
/** 相邻两期资金费超过这个间隔视为缺期 */
const FUNDING_GAP_MS = 12 * H;
export type CandleKind = 'trade' | 'mark';
export type FundingSource = 'okx' | 'binance_proxy';
export type Window = { from_ms: number; to_ms: number };
type Seg = [number, number];
// ---------- 月份工具:idx = 年*12 + 月-1 ----------
const monthIdx = (ts: number) => { const d = new Date(ts); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
const utcMonthStart = (m: number) => Date.UTC(Math.floor(m / 12), m % 12, 1);
/** OKX 归档按 UTC+8 月切:m 月从 UTC 上月最后一天 16:00 开始 */
const hkMonthStart = (m: number) => utcMonthStart(m) - 8 * H;
const hkMonthIdx = (ts: number) => monthIdx(ts + 8 * H);
const monthKey = (m: number) => `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`;
const keyToIdx = (k: string) => { const [y, mo] = k.split('-').map(Number); return y! * 12 + mo! - 1; };
const iso = (ts: number) => new Date(ts).toISOString().replace('.000Z', 'Z');
const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);
// ---------- 符号 ----------
/** 'BTCUSDT' | 'BTC-USDT' | 'BTC/USDT:USDT' | 'BTC-USDT-SWAP' → 'BTC-USDT-SWAP'。只支持 USDT 线性永续,其他报错。 */
export function symbolToInstId(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  const m = /^([A-Z0-9]+)-USDT-SWAP$/.exec(s) ?? /^([A-Z0-9]+)[-/_]USDT(?::USDT)?$/.exec(s) ?? /^([A-Z0-9]+?)USDT$/.exec(s);
  if (!m || !m[1]) throw new Error(`UNSUPPORTED_ASSET: ${symbol} 只支持 USDT 线性永续`);
  return `${m[1]}-USDT-SWAP`;
}
const familyOf = (instId: string) => instId.replace(/-SWAP$/, '');
/** 币安 U 本位代理符号:BTC-USDT-SWAP → BTCUSDT(1000PEPE 这类改名合约没有映射,只验证过主流币) */
export const binanceSymbolOf = (instId: string) => familyOf(instId).replace('-', '');
/** 研究周期 → OKX bar 码(UTC 对齐)。OKX 的 6H/12H/1D 是香港时间对齐,必须用 *utc 版本。 */
export function okxBar(tf: string): string {
  const map: Record<string, string> = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6Hutc', '12h': '12Hutc', '1d': '1Dutc' };
  const bar = map[tf]; if (!bar) throw new Error(`timeframe_unsupported: ${tf}`); return bar;
}
// ---------- sqlite 缓存 ----------
export const defaultMarketDbPath = () => process.env.TG_RESEARCH_MARKET_DB ?? join(homedir(), '.trading-swarm', 'research', 'market-cache.sqlite');
const SCHEMA = `
CREATE TABLE IF NOT EXISTS candles (inst TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('trade','mark')), tf TEXT NOT NULL, open_time INTEGER NOT NULL, o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL, PRIMARY KEY (inst, kind, tf, open_time)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS funding (inst TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('okx','binance_proxy')), ts INTEGER NOT NULL, rate REAL NOT NULL, PRIMARY KEY (inst, source, ts)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS fetch_log (key TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, status TEXT NOT NULL, note TEXT);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, json TEXT NOT NULL);`;
export interface CandleRow { open_time: number; o: number; h: number; l: number; c: number; v: number }
export interface FetchLogRow { key: string; fetched_at: number; status: string; note: string | null }
export class MarketCache {
  readonly db: DatabaseSync; readonly path: string;
  constructor(path: string = defaultMarketDbPath()) {
    this.path = path; if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path); if (path !== ':memory:') this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;'); this.db.exec(SCHEMA);
  }
  close(): void { try { this.db.close(); } catch { /* 已关闭 */ } }
  private tx(fn: () => void): void { this.db.exec('BEGIN'); try { fn(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  putCandles(inst: string, kind: CandleKind, tf: string, rows: CandleRow[]): void {
    if (!rows.length) return; const st = this.db.prepare('INSERT OR REPLACE INTO candles(inst,kind,tf,open_time,o,h,l,c,v) VALUES (?,?,?,?,?,?,?,?,?)');
    this.tx(() => { for (const r of rows) st.run(inst, kind, tf, r.open_time, r.o, r.h, r.l, r.c, r.v); });
  }
  candles(inst: string, kind: CandleKind, tf: string, fromOpen: number, toOpen: number): CandleRow[] {
    return this.db.prepare('SELECT open_time,o,h,l,c,v FROM candles WHERE inst=? AND kind=? AND tf=? AND open_time BETWEEN ? AND ? ORDER BY open_time').all(inst, kind, tf, fromOpen, toOpen) as unknown as CandleRow[];
  }
  putFunding(inst: string, source: FundingSource, rows: { ts: number; rate: number }[]): void {
    if (!rows.length) return; const st = this.db.prepare('INSERT OR REPLACE INTO funding(inst,source,ts,rate) VALUES (?,?,?,?)');
    this.tx(() => { for (const r of rows) st.run(inst, source, r.ts, r.rate); });
  }
  funding(inst: string, source: FundingSource, from: number, to: number): { ts: number; rate: number }[] {
    return this.db.prepare('SELECT ts, rate FROM funding WHERE inst=? AND source=? AND ts BETWEEN ? AND ? ORDER BY ts').all(inst, source, from, to) as unknown as { ts: number; rate: number }[];
  }
  log(key: string): FetchLogRow | null { return (this.db.prepare('SELECT key,fetched_at,status,note FROM fetch_log WHERE key=?').get(key) as unknown as FetchLogRow | undefined) ?? null; }
  setLog(key: string, status: string, note: string | null, at: number): void { this.db.prepare('INSERT OR REPLACE INTO fetch_log(key,fetched_at,status,note) VALUES (?,?,?,?)').run(key, at, status, note); }
  meta<T>(key: string): { fetched_at: number; value: T } | null { const r = this.db.prepare('SELECT fetched_at,json FROM meta WHERE key=?').get(key) as { fetched_at: number; json: string } | undefined; return r ? { fetched_at: r.fetched_at, value: JSON.parse(r.json) as T } : null; }
  setMeta(key: string, value: unknown, at: number): void { this.db.prepare('INSERT OR REPLACE INTO meta(key,fetched_at,json) VALUES (?,?,?)').run(key, at, JSON.stringify(value)); }
  segments(key: string): Seg[] { const r = this.log(key); if (!r?.note) return []; try { return JSON.parse(r.note) as Seg[]; } catch { return []; } }
  setSegments(key: string, segs: Seg[], at: number): void { this.setLog(key, 'segments', JSON.stringify(segs), at); }
}
/** 合并区间:相邻判定 next.lo ≤ prev.hi + unit */
function mergeSegs(segs: Seg[], unit: number): Seg[] {
  const s = [...segs].sort((a, b) => a[0] - b[0]), out: Seg[] = [];
  for (const [lo, hi] of s) { const last = out.at(-1); if (last && lo <= last[1] + unit) last[1] = Math.max(last[1], hi); else out.push([lo, hi]); }
  return out;
}
/** [lo,hi] 扣掉已覆盖区间后剩下的缺口(unit=离散步长,K 线是周期,资金费 REST 是 1ms) */
function gapsOf(lo: number, hi: number, segs: Seg[], unit: number): Seg[] {
  const out: Seg[] = []; let cur = lo;
  for (const [a, b] of mergeSegs(segs, unit)) { if (b < cur) continue; if (a > hi) break; if (a > cur) out.push([cur, Math.min(hi, a - unit)]); cur = Math.max(cur, b + unit); if (cur > hi) break; }
  if (cur <= hi) out.push([cur, hi]);
  return out;
}
// ---------- 网络客户端:节流 + 重试 + 可注入 ----------
export interface PerpFetchOptions {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  /** true = 忽略缓存的覆盖记录/归档状态/meta 新鲜度,全部重拉(已有行 upsert) */
  refresh?: boolean;
  /** 请求最小间隔,缺省 110ms(OKX history 接口约 20 次/2 秒) */
  throttleMs?: number;
}
export interface PerpContext { cache: MarketCache; now: () => number; refresh: boolean; signal?: AbortSignal; okx(path: string): Promise<unknown>; bytes(url: string): Promise<Buffer | null>; requests(): number }
const aborted = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error('CANCELLED'); };
function makeCtx(cache: MarketCache, o: PerpFetchOptions): PerpContext {
  const fetchFn = o.fetchFn ?? (configureOkxProxy(), globalThis.fetch.bind(globalThis));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))), gap = o.throttleMs ?? THROTTLE_MS;
  let queue: Promise<void> = Promise.resolve(), last = 0, count = 0;
  // 串行节流:任何并发调用也按 ≥gap 间隔排队
  const slot = () => { const p = queue.then(async () => { const wait = last + gap - Date.now(); if (wait > 0) await sleep(wait); last = Date.now(); }); queue = p.catch(() => undefined); return p; };
  const request = async (url: string): Promise<Response> => {
    for (let attempt = 1; ; attempt++) {
      aborted(o.signal); await slot(); aborted(o.signal); count++;
      let res: Response | null = null, err: unknown = null;
      try { res = await fetchFn(url, { signal: o.signal, headers: { accept: '*/*' } }); } catch (e) { if (o.signal?.aborted) throw new Error('CANCELLED'); err = e; }
      if (res && res.status !== 429 && res.status < 500) return res;
      if (attempt >= 3) throw new Error(`PROVIDER_ERROR: ${res ? `http ${res.status}` : String((err as Error)?.message ?? err)} ${url}`);
      await sleep(500 * attempt);
    }
  };
  return {
    cache, now: o.now ?? Date.now, refresh: o.refresh === true, signal: o.signal, requests: () => count,
    async okx(path) {
      for (let attempt = 1; ; attempt++) {
        const res = await request(`${OKX}${path}`); let j: { code?: string; msg?: string; data?: unknown };
        try { j = (await res.json()) as typeof j; } catch { throw new Error(`PROVIDER_ERROR: okx http ${res.status} non-json ${path}`); }
        if (j.code === '0') return j.data ?? [];
        if (j.code === '50011' && attempt < 3) { await sleep(1000 * attempt); continue; } // 限频
        throw new Error(`PROVIDER_ERROR: okx ${j.code} ${j.msg ?? ''} ${path}`);
      }
    },
    async bytes(url) { const res = await request(url); if (res.status === 404 || res.status === 403) return null; if (!res.ok) throw new Error(`PROVIDER_ERROR: http ${res.status} ${url}`); return Buffer.from(await res.arrayBuffer()); },
  };
}
// ---------- K 线 ----------
const candleKey = (inst: string, kind: CandleKind, tf: string) => `candles:${inst}:${kind}:${tf}`;
/** 把 [from,to] 内(按 open≥from、close≤to、已收盘)的 K 线补进缓存。只请求覆盖记录之外的缺口;接口返回空 = 到达上市起点,记为覆盖到 0。 */
export async function syncCandles(ctx: PerpContext, inst: string, kind: CandleKind, tf: string, w: Window): Promise<void> {
  const step = timeframeMillis(tf), bar = okxBar(tf), key = candleKey(inst, kind, tf), now = ctx.now();
  const lastClosed = Math.floor(now / step) * step - step;
  const lo = Math.ceil(w.from_ms / step) * step, hi = Math.min(Math.floor((w.to_ms + 1) / step) * step - step, lastClosed);
  if (lo > hi) return;
  let segs = ctx.refresh ? [] : ctx.cache.segments(key);
  const endpoint = kind === 'trade' ? 'history-candles' : 'history-mark-price-candles';
  for (const [gLo, gHi] of gapsOf(lo, hi, segs, step)) {
    let after = gHi + 1, top = -Infinity, bottom = Infinity, floor = false, reached = false;
    const maxPages = Math.ceil((gHi - gLo) / step / PAGE) + 5, nearNow = gHi >= lastClosed - step;
    for (let page = 0; page < maxPages; page++) {
      const data = (await ctx.okx(`/api/v5/market/${endpoint}?instId=${inst}&bar=${bar}&after=${after}&limit=${PAGE}`)) as string[][];
      if (!Array.isArray(data) || !data.length) { floor = true; break; }
      const rows: CandleRow[] = []; let min = Infinity;
      for (const r of data) {
        const ts = Number(r[0]); if (!Number.isSafeInteger(ts)) continue; min = Math.min(min, ts);
        if ((kind === 'trade' ? r[8] : r[5]) !== '1' || ts > lastClosed) continue; // 只收已收盘
        const [o, h, l, c] = [r[1], r[2], r[3], r[4]].map(Number), v = kind === 'trade' ? Number(r[6]) : 0;
        if (![o, h, l, c, v].every(Number.isFinite)) continue;
        rows.push({ open_time: ts, o: o!, h: h!, l: l!, c: c!, v }); top = Math.max(top, ts);
      }
      ctx.cache.putCandles(inst, kind, tf, rows); bottom = Math.min(bottom, min);
      if (!(min < after)) throw new Error(`PROVIDER_ERROR: okx ${endpoint} pagination stalled at ${after}`);
      if (min <= gLo) { reached = true; break; }
      after = min;
    }
    if (floor) ctx.cache.setLog(`candles_floor:${inst}:${kind}:${tf}`, 'floor', `listing_start<=${bottom === Infinity ? after : bottom}`, now);
    if (!floor && !reached) { if (bottom !== Infinity) segs = mergeSegs([...segs, [bottom, gHi]], step); ctx.cache.setSegments(key, segs, now); continue; }
    // 贴近当前时刻的缺口:最新一根可能还没 confirm,覆盖只记到见过的最后一根已收盘,下次再补
    const segHi = nearNow && top > -Infinity ? Math.min(gHi, top) : nearNow && !floor ? gLo - step : gHi;
    const segLo = floor ? 0 : Math.min(gLo, bottom);
    if (segHi >= segLo) segs = mergeSegs([...segs, [segLo, segHi]], step);
    ctx.cache.setSegments(key, segs, now);
  }
}
const toOrderBar = (r: CandleRow, step: number): OrderBar => ({ open_time: r.open_time, close_time: r.open_time + step - 1, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v });
function readCandles(ctx: PerpContext, inst: string, kind: CandleKind, tf: string, w: Window): CandleRow[] {
  const step = timeframeMillis(tf), lastClosed = Math.floor(ctx.now() / step) * step - step;
  return ctx.cache.candles(inst, kind, tf, Math.ceil(w.from_ms / step) * step, Math.min(Math.floor((w.to_ms + 1) / step) * step - step, lastClosed));
}
// ---------- 资金费 ----------
function parseCsv(text: string): string[][] { return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))); }
/** 按表头取列;老文件没有表头时按缺省列序 */
function csvColumns(rows: string[][], want: string[], fallback: number[]): { body: string[][]; idx: number[] } {
  const head = rows[0] ?? [], hasHead = head.some((c) => /[a-z_]/i.test(c) && !/^[-+\d.eE]+$/.test(c));
  if (!hasHead) return { body: rows, idx: fallback };
  const idx = want.map((w) => head.indexOf(w)); if (idx.some((i) => i < 0)) throw new Error(`csv_header_unexpected: ${head.join(',')}`);
  return { body: rows.slice(1), idx };
}
const archiveKey = (inst: string, m: number) => `okx_funding_archive:${inst}:${monthKey(m)}`;
const bnKey = (sym: string, m: number) => `binance_funding_archive:${sym}:${monthKey(m)}`;
/** 已 final 的不再拉;missing 满 7 天才重试 */
function needsFetch(ctx: PerpContext, key: string): boolean { if (ctx.refresh) return true; const l = ctx.cache.log(key); if (!l) return true; if (l.status === 'final') return false; if (l.status === 'missing') return ctx.now() - l.fetched_at >= TTL_MS; return true; }
/** OKX 月度归档(UTC+8 月);只拉已完结月份,列表接口按 ≤9 个月分段。 */
export async function syncOkxFundingArchives(ctx: PerpContext, inst: string, months: number[]): Promise<void> {
  const first = keyToIdx(OKX_ARCHIVE_FIRST), now = ctx.now();
  const need = [...new Set(months)].filter((m) => m >= first && hkMonthStart(m + 1) <= now && needsFetch(ctx, archiveKey(inst, m))).sort((a, b) => a - b);
  const family = familyOf(inst);
  while (need.length) {
    const s = need[0]!, chunk = need.filter((m) => m - s < ARCHIVE_SPAN), e = chunk.at(-1)!; need.splice(0, chunk.length);
    const data = (await ctx.okx(`/api/v5/public/market-data-history?module=3&instType=SWAP&instFamilyList=${family}&dateAggrType=monthly&begin=${hkMonthStart(s)}&end=${utcMonthStart(e)}`)) as { details?: { groupDetails?: { filename?: string; url?: string }[] }[] }[];
    // 月份从文件名取(dateTs 是 UTC+8 月初,别当时间戳用)
    const urls = new Map<number, string>();
    for (const d of data?.[0]?.details ?? []) for (const g of d.groupDetails ?? []) { const m = /^(.+)-fundingrates-(\d{4})-(\d{2})\.zip$/.exec(g.filename ?? ''); if (m && m[1] === inst && g.url) urls.set(Number(m[2]) * 12 + Number(m[3]) - 1, g.url); }
    for (const m of chunk) {
      const url = urls.get(m); if (!url) { ctx.cache.setLog(archiveKey(inst, m), 'missing', 'not_listed', now); continue; }
      const buf = await ctx.bytes(url); if (!buf) { ctx.cache.setLog(archiveKey(inst, m), 'missing', 'http_404', now); continue; }
      const { body, idx } = csvColumns(parseCsv(readZipText(buf).text), ['instrument_name', 'funding_rate', 'funding_time'], [0, 1, 2]);
      const rows = body.filter((r) => r[idx[0]!] === inst).map((r) => ({ ts: Number(r[idx[2]!]), rate: Number(r[idx[1]!]) })).filter((r) => Number.isSafeInteger(r.ts) && Number.isFinite(r.rate));
      ctx.cache.putFunding(inst, 'okx', rows); ctx.cache.setLog(archiveKey(inst, m), 'final', `rows=${rows.length}`, now);
    }
  }
}
/** OKX 资金费 REST(近约 3 个月),按 after 向更早翻页;返回空 = 超出 REST 可回溯范围,该段也记为已拉过。 */
export async function syncOkxFundingRest(ctx: PerpContext, inst: string, lo: number, hi: number): Promise<void> {
  const key = `okx_funding_rest:${inst}`, now = ctx.now(); if (lo > hi) return;
  let segs = ctx.refresh ? [] : ctx.cache.segments(key);
  for (const [gLo, gHi] of gapsOf(lo, hi, segs, 1)) {
    let after = gHi + 1, bottom = Infinity, done = false;
    for (let page = 0; page < 40; page++) {
      const data = (await ctx.okx(`/api/v5/public/funding-rate-history?instId=${inst}&after=${after}&limit=${PAGE}`)) as { fundingTime?: string; fundingRate?: string }[];
      if (!Array.isArray(data) || !data.length) { done = true; break; }
      const rows = data.map((d) => ({ ts: Number(d.fundingTime), rate: Number(d.fundingRate) })).filter((r) => Number.isSafeInteger(r.ts) && Number.isFinite(r.rate) && r.ts <= now);
      ctx.cache.putFunding(inst, 'okx', rows); const min = Math.min(...data.map((d) => Number(d.fundingTime)).filter(Number.isFinite)); bottom = Math.min(bottom, min);
      if (!(min < after)) throw new Error('PROVIDER_ERROR: okx funding-rate-history pagination stalled');
      if (min <= gLo) { done = true; break; }
      after = min;
    }
    const segLo = done ? gLo : bottom; if (segLo <= gHi) segs = mergeSegs([...segs, [segLo, gHi]], 1);
    ctx.cache.setSegments(key, segs, now);
  }
}
/** 币安 U 本位月度资金费(UTC 月),只作代理;只拉已完结月份。 */
export async function syncBinanceFundingMonths(ctx: PerpContext, inst: string, months: number[]): Promise<void> {
  const sym = binanceSymbolOf(inst), now = ctx.now();
  for (const m of [...new Set(months)].sort((a, b) => a - b)) {
    if (utcMonthStart(m + 1) > now || !needsFetch(ctx, bnKey(sym, m))) continue;
    const mk = monthKey(m), buf = await ctx.bytes(`${BN_VISION}/data/futures/um/monthly/fundingRate/${sym}/${sym}-fundingRate-${mk}.zip`);
    if (!buf) { ctx.cache.setLog(bnKey(sym, m), 'missing', 'http_404', now); continue; }
    const { body, idx } = csvColumns(parseCsv(readZipText(buf).text), ['calc_time', 'last_funding_rate'], [0, 2]);
    const rows = body.map((r) => ({ ts: Number(r[idx[0]!]), rate: Number(r[idx[1]!]) })).filter((r) => Number.isSafeInteger(r.ts) && Number.isFinite(r.rate));
    ctx.cache.putFunding(inst, 'binance_proxy', rows); ctx.cache.setLog(bnKey(sym, m), 'final', `rows=${rows.length}`, now);
  }
}
/** 把按时间排好的点切成连续区间(相邻 ≤12h) */
function intervalsOf(pts: { ts: number }[]): Seg[] {
  const out: Seg[] = []; for (const p of pts) { const last = out.at(-1); if (last && p.ts - last[1] <= FUNDING_GAP_MS) last[1] = p.ts; else out.push([p.ts, p.ts]); } return out;
}
const covers = (iv: Seg[], lo: number, hi: number) => iv.some(([a, b]) => a <= lo + FUNDING_MS + MIN && b >= hi - FUNDING_MS - MIN);
export interface FundingSegment { source: 'okx_archive' | 'okx_rest' | 'binance_proxy'; from_ms: number; to_ms: number; points: number }
export interface FundingDeviation { months: string[]; n: number; corr: number | null; mean_diff: number; mean_abs_diff: number; cum_diff: number }
export interface FundingProvenance {
  coverage: 'complete' | 'partial' | 'missing';
  from_ms: number | null; to_ms: number | null;
  okx: { points: number; from_ms: number; to_ms: number } | null;
  proxy: { points: number; from_ms: number; to_ms: number; symbol: string } | null;
  /** 币安代理用到哪一期(null = 没用代理) */
  proxy_until_ms: number | null;
  note: string;
  notes: string[];
  gaps: { from_ms: number; to_ms: number }[];
  /** 按时间顺序的连续同源段:OKX 月度归档 / OKX REST / 币安代理(报告溯源写分界用) */
  segments: FundingSegment[];
  okx_archive: { final: string[]; missing: string[] };
  /** 最近 3 个完整月份 OKX vs 币安同期对照(okx − binance);拉不到为 null,见 deviation_note */
  deviation: FundingDeviation | null;
  deviation_note: string;
}
function deviationOf(ctx: PerpContext, inst: string): { deviation: FundingDeviation | null; note: string } {
  const cur = monthIdx(ctx.now()), sym = binanceSymbolOf(inst), months: string[] = [], okxV: number[] = [], bnV: number[] = [];
  for (const m of range(cur - 3, cur - 1)) {
    const a = utcMonthStart(m), b = utcMonthStart(m + 1) - 1, bn = ctx.cache.funding(inst, 'binance_proxy', a, b); if (!bn.length) continue;
    const okx = new Map(ctx.cache.funding(inst, 'okx', a - MIN, b + MIN).map((p) => [Math.round(p.ts / MIN), p.rate])); let n = 0;
    for (const p of bn) { const k = Math.round(p.ts / MIN), r = okx.get(k) ?? okx.get(k - 1) ?? okx.get(k + 1); if (r === undefined) continue; okxV.push(r); bnV.push(p.rate); n++; }
    if (n) months.push(monthKey(m));
  }
  if (okxV.length < 3) return { deviation: null, note: `最近 3 个完整月份(${range(cur - 3, cur - 1).map(monthKey).join('/')})OKX 与币安 ${sym} 配对不足 3 期,未计算偏差` };
  const n = okxV.length, d = okxV.map((x, i) => x - bnV[i]!), mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const mo = mean(okxV), mb = mean(bnV); let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { const x = okxV[i]! - mo, y = bnV[i]! - mb; sxy += x * y; sxx += x * x; syy += y * y; }
  const corr = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null, cum = d.reduce((s, x) => s + x, 0);
  return { deviation: { months, n, corr, mean_diff: mean(d), mean_abs_diff: mean(d.map(Math.abs)), cum_diff: cum }, note: `${months.join('/')} 共 ${n} 期同 ts 配对:相关 ${corr === null ? 'n/a' : corr.toFixed(3)},平均差 ${(mean(d) * 1e4).toFixed(3)}bp/期,累计差 ${(cum * 100).toFixed(4)}%(okx−binance)` };
}
/** 资金费合并:OKX 归档 + REST 为主,币安只填 OKX 覆盖不到的时段;from_ms/to_ms 是实际覆盖。 */
export async function loadFunding(ctx: PerpContext, inst: string, w: Window): Promise<{ series: FundingSeries; provenance: FundingProvenance }> {
  const now = ctx.now(), from = w.from_ms, to = Math.min(w.to_ms, now), sym = binanceSymbolOf(inst), notes: string[] = [];
  const cur = monthIdx(now), devMonths = range(cur - 3, cur - 1);
  if (from > to) throw new Error('invalid_window');
  const hkMonths = range(hkMonthIdx(from), hkMonthIdx(to));
  await syncOkxFundingArchives(ctx, inst, [...hkMonths, ...devMonths]);
  const first = keyToIdx(OKX_ARCHIVE_FIRST), status = (m: number) => ctx.cache.log(archiveKey(inst, m))?.status ?? null;
  // 没有 final 归档、且还在 REST 可回溯范围内的月份 → REST 补
  const restMonths = hkMonths.filter((m) => m >= first && status(m) !== 'final' && hkMonthStart(m + 1) > now - REST_REACH_MS);
  if (restMonths.length) {
    try { await syncOkxFundingRest(ctx, inst, Math.max(from, hkMonthStart(restMonths[0]!)), to); } catch (e) { notes.push(`OKX 资金费 REST 拉取失败:${(e as Error).message}`); }
  }
  let okxPts = ctx.cache.funding(inst, 'okx', from, to), okxIv = intervalsOf(okxPts);
  // 每个 UTC 月:OKX 没覆盖满 → 拉币安同月作代理(当月没有月度文件)
  const bnNeed = range(monthIdx(from), monthIdx(to)).filter((m) => !covers(okxIv, Math.max(from, utcMonthStart(m)), Math.min(to, utcMonthStart(m + 1) - 1)));
  try { await syncBinanceFundingMonths(ctx, inst, [...bnNeed, ...devMonths]); } catch (e) { notes.push(`币安代理资金费拉取失败:${(e as Error).message}`); }
  okxPts = ctx.cache.funding(inst, 'okx', from, to); okxIv = intervalsOf(okxPts);
  const proxyPts = ctx.cache.funding(inst, 'binance_proxy', from, to).filter((p) => !okxIv.some(([a, b]) => p.ts >= a - MIN && p.ts <= b + MIN));
  const points: FundingPoint[] = [...okxPts.map((p) => ({ ts: p.ts, rate: p.rate, source: 'okx' })), ...proxyPts.map((p) => ({ ts: p.ts, rate: p.rate, source: 'binance_proxy' }))].sort((a, b) => a.ts - b.ts);
  const gaps: { from_ms: number; to_ms: number }[] = []; for (let i = 1; i < points.length; i++) if (points[i]!.ts - points[i - 1]!.ts > FUNDING_GAP_MS) gaps.push({ from_ms: points[i - 1]!.ts, to_ms: points[i]!.ts });
  const f0 = points[0]?.ts, f1 = points.at(-1)?.ts;
  const coverage: FundingProvenance['coverage'] = f0 === undefined ? 'missing' : !gaps.length && f0 <= from + FUNDING_MS + MIN && f1! >= to - FUNDING_MS - MIN ? 'complete' : 'partial';
  if (coverage === 'partial') notes.push(`资金费只覆盖 ${iso(f0!)} ~ ${iso(f1!)}${gaps.length ? `,中间缺 ${gaps.length} 段` : ''}(请求 ${iso(from)} ~ ${iso(to)})`);
  // from_ms:第一期之前一个结算周期内不会有漏掉的结算;to_ms=最后一期(执行核自己再放宽 8h)。缺失时给一个空区间,任何持仓段都判 missing
  const series: FundingSeries = f0 === undefined ? { points: [], from_ms: from, to_ms: from - FUNDING_MS - 1 } : { points, from_ms: Math.max(from, f0 - FUNDING_MS + 1), to_ms: f1! };
  const okxInfo = okxPts.length ? { points: okxPts.length, from_ms: okxPts[0]!.ts, to_ms: okxPts.at(-1)!.ts } : null;
  const proxyInfo = proxyPts.length ? { points: proxyPts.length, from_ms: proxyPts[0]!.ts, to_ms: proxyPts.at(-1)!.ts, symbol: sym } : null;
  let note: string;
  if (!points.length) note = '请求窗口内没有任何资金费数据';
  else if (!proxyInfo) note = '资金费全部为 OKX 官方';
  else if (!okxInfo) note = `资金费全部为币安 ${sym} 代理(OKX 官方覆盖不到该时段)`;
  else {
    const before = proxyPts.filter((p) => p.ts < okxInfo.from_ms), holes = proxyPts.length - before.length, parts: string[] = [];
    if (before.length) parts.push(`${monthKey(hkMonthIdx(okxInfo.from_ms))} 前资金费为币安 ${sym} 代理(OKX 官方自 ${iso(okxInfo.from_ms)} 起)`);
    if (holes) parts.push(`另有 ${holes} 期 OKX 缺失由币安代理补(${[...new Set(proxyPts.filter((p) => p.ts >= okxInfo.from_ms).map((p) => monthKey(monthIdx(p.ts))))].join('/')})`);
    note = parts.join(';');
  }
  const archived = hkMonths.filter((m) => m >= first), dev = deviationOf(ctx, inst), segments: FundingSegment[] = [];
  for (const p of points) { const src: FundingSegment['source'] = p.source === 'binance_proxy' ? 'binance_proxy' : status(hkMonthIdx(p.ts)) === 'final' ? 'okx_archive' : 'okx_rest', last = segments.at(-1); if (last && last.source === src) { last.to_ms = p.ts; last.points++; } else segments.push({ source: src, from_ms: p.ts, to_ms: p.ts, points: 1 }); }
  return {
    series,
    provenance: {
      coverage, from_ms: f0 === undefined ? null : series.from_ms, to_ms: f0 === undefined ? null : series.to_ms, okx: okxInfo, proxy: proxyInfo, proxy_until_ms: proxyInfo?.to_ms ?? null, note, notes, gaps, segments,
      okx_archive: { final: archived.filter((m) => status(m) === 'final').map(monthKey), missing: archived.filter((m) => status(m) === 'missing').map(monthKey) },
      deviation: dev.deviation, deviation_note: dev.note,
    },
  };
}
// ---------- 维持保证金分档 ----------
interface RawTier { tier: string; minSz: string; maxSz: string; mmr: string; imr: string; maxLever: string }
interface RawInstrument { instId: string; ctVal: string; ctMult: string; ctType?: string; settleCcy?: string; listTime?: string; lotSz?: string; minSz?: string }
export interface PerpTiers { tiers: MmrTier[]; lever_tiers: { max_qty: number; max_lever: number; imr: number; mmr: number }[]; max_lever: number | null; ct_val: number; ct_mult: number; list_time: number | null; fetched_at: number; stale: boolean }
async function cachedMeta<T>(ctx: PerpContext, key: string, fetcher: () => Promise<T>): Promise<{ value: T; fetched_at: number; stale: boolean }> {
  const m = ctx.cache.meta<T>(key), now = ctx.now();
  if (m && !ctx.refresh && now - m.fetched_at < TTL_MS) return { ...m, stale: false };
  try { const value = await fetcher(); ctx.cache.setMeta(key, value, now); return { value, fetched_at: now, stale: false }; } catch (e) { if (m) return { ...m, stale: true }; throw e; }
}
const num12 = (x: number) => Number(x.toPrecision(12));
/** 分档(逐仓)+ 合约面值,换算成执行核的 MmrTier(max_qty 为 base 数量 = 张数上限 × ctVal × ctMult)。分档是当前值,不是历史值。 */
export async function loadTiers(ctx: PerpContext, inst: string): Promise<PerpTiers> {
  const ins = await cachedMeta(ctx, `instrument:${inst}`, async () => { const d = (await ctx.okx(`/api/v5/public/instruments?instType=SWAP&instId=${inst}`)) as RawInstrument[]; const x = d?.[0]; if (!x || x.instId !== inst) throw new Error(`UNSUPPORTED_ASSET: ${inst}`); if (x.ctType && x.ctType !== 'linear') throw new Error(`UNSUPPORTED_ASSET: ${inst} 不是线性合约`); return x; });
  const tr = await cachedMeta(ctx, `position_tiers:${familyOf(inst)}:isolated`, async () => { const d = (await ctx.okx(`/api/v5/public/position-tiers?instType=SWAP&tdMode=isolated&instFamily=${familyOf(inst)}`)) as RawTier[]; if (!Array.isArray(d) || !d.length) throw new Error(`PROVIDER_ERROR: okx position-tiers empty ${inst}`); return d; });
  const ctVal = Number(ins.value.ctVal), ctMult = Number(ins.value.ctMult || '1'); if (!(ctVal > 0) || !(ctMult > 0)) throw new Error(`PROVIDER_ERROR: bad ctVal/ctMult ${inst}`);
  const rows = [...tr.value].sort((a, b) => Number(a.tier) - Number(b.tier)).map((t) => ({ max_qty: num12(Number(t.maxSz) * ctVal * ctMult), mmr: Number(t.mmr), imr: Number(t.imr), max_lever: Number(t.maxLever) })).filter((t) => Number.isFinite(t.max_qty) && Number.isFinite(t.mmr));
  const levers = rows.map((r) => r.max_lever).filter((x) => Number.isFinite(x) && x > 0), lt = Number(ins.value.listTime);
  return { tiers: rows.map(({ max_qty, mmr }) => ({ max_qty, mmr })), lever_tiers: rows, max_lever: levers.length ? Math.max(...levers) : null, ct_val: ctVal, ct_mult: ctMult, list_time: Number.isSafeInteger(lt) && lt > 0 ? lt : null, fetched_at: Math.min(ins.fetched_at, tr.fetched_at), stale: ins.stale || tr.stale };
}
// ---------- 高层入口 ----------
export interface PerpMarketRequest { inst_id: string; timeframe: string; from_ms: number; to_ms: number }
export interface PerpMarketOptions extends PerpFetchOptions { cache?: MarketCache | string }
export interface PerpMarketProvenance { source: string; version: string; trade_coverage: Window | null; mark_coverage: Window | null; mark_missing_bars: number; flags: string[]; notes: string[]; requests: number }
export interface PerpMarket {
  inst_id: string; timeframe: string;
  bars: ResearchBar[];
  /** 与 bars 下标对齐的标记价 K 线;缺失为 null */
  mark: (OrderBar | null)[];
  funding: FundingSeries;
  funding_provenance: FundingProvenance;
  tiers: MmrTier[];
  lever_tiers: PerpTiers['lever_tiers'];
  max_lever: number | null;
  provenance: PerpMarketProvenance;
}
const f8 = (x: number) => x.toFixed(8);
const emptyFunding = (w: Window, why: string): { series: FundingSeries; provenance: FundingProvenance } => ({ series: { points: [], from_ms: w.from_ms, to_ms: w.from_ms - FUNDING_MS - 1 }, provenance: { coverage: 'missing', from_ms: null, to_ms: null, okx: null, proxy: null, proxy_until_ms: null, note: why, notes: [why], gaps: [], segments: [], okx_archive: { final: [], missing: [] }, deviation: null, deviation_note: '未计算' } });
/** 一次拿齐回测所需永续数据。成交价 K 线失败直接抛错;标记价/资金费/分档失败降级并写进 flags/notes,不伪造。 */
export async function loadPerpMarket(req: PerpMarketRequest, opts: PerpMarketOptions = {}): Promise<PerpMarket> {
  if (!Number.isSafeInteger(req.from_ms) || !Number.isSafeInteger(req.to_ms) || req.from_ms >= req.to_ms) throw new Error('invalid_window');
  const inst = symbolToInstId(req.inst_id), tf = req.timeframe, step = timeframeMillis(tf); okxBar(tf);
  const owned = !(opts.cache instanceof MarketCache), cache = opts.cache instanceof MarketCache ? opts.cache : new MarketCache(opts.cache);
  const ctx = makeCtx(cache, opts), w: Window = { from_ms: req.from_ms, to_ms: req.to_ms }, flags = new Set<string>(['tiers_current_not_historical', 'volume_base_ccy']), notes: string[] = [];
  try {
    await syncCandles(ctx, inst, 'trade', tf, w);
    const trade = readCandles(ctx, inst, 'trade', tf, w);
    const bars: ResearchBar[] = trade.map((r) => ({ open_time: r.open_time, close_time: r.open_time + step - 1, available_at: r.open_time + step - 1, open: f8(r.o), high: f8(r.h), low: f8(r.l), close: f8(r.c), volume: f8(r.v) }));
    for (let i = 1; i < trade.length; i++) if (trade[i]!.open_time - trade[i - 1]!.open_time !== step) { flags.add('gap_bars'); break; }
    if (!bars.length) { flags.add('trade_missing'); notes.push('请求窗口内没有已收盘的成交价 K 线(可能早于上市或窗口太短)'); }
    else if (bars[0]!.open_time - w.from_ms >= 2 * step || w.to_ms - bars.at(-1)!.close_time >= 2 * step) { flags.add('trade_partial'); notes.push(`成交价 K 线实际覆盖 ${iso(bars[0]!.open_time)} ~ ${iso(bars.at(-1)!.close_time)}`); }
    let markRows: CandleRow[] = [];
    try { await syncCandles(ctx, inst, 'mark', tf, w); markRows = readCandles(ctx, inst, 'mark', tf, w); } catch (e) { if ((e as Error).message === 'CANCELLED') throw e; flags.add('mark_unavailable'); notes.push(`标记价 K 线拉取失败,强平退回成交价:${(e as Error).message}`); }
    const byOpen = new Map(markRows.map((r) => [r.open_time, r])), mark = trade.map((r) => { const m = byOpen.get(r.open_time); return m ? toOrderBar(m, step) : null; }), markMissing = mark.filter((m) => !m).length;
    if (markMissing) { flags.add('mark_fallback_bars'); notes.push(`${markMissing}/${mark.length} 根没有标记价(OKX 标记价历史约从 2020 年中开始),这些根退回成交价`); }
    let funding: Awaited<ReturnType<typeof loadFunding>>;
    try { funding = await loadFunding(ctx, inst, w); } catch (e) { if ((e as Error).message === 'CANCELLED') throw e; funding = emptyFunding(w, `资金费拉取失败:${(e as Error).message}`); }
    if (funding.provenance.proxy) flags.add('funding_binance_proxy'); if (funding.provenance.coverage !== 'complete') flags.add(`funding_${funding.provenance.coverage}`);
    let tiers: PerpTiers | null = null;
    try { tiers = await loadTiers(ctx, inst); if (tiers.stale) { flags.add('tiers_stale'); notes.push('分档刷新失败,用的是超过 7 天的缓存'); } } catch (e) { if ((e as Error).message === 'CANCELLED') throw e; flags.add('tiers_missing'); notes.push(`维持保证金分档拉取失败:${(e as Error).message}`); }
    const markCov = markRows.length ? { from_ms: markRows[0]!.open_time, to_ms: markRows.at(-1)!.open_time + step - 1 } : null;
    return {
      inst_id: inst, timeframe: tf, bars, mark, funding: funding.series, funding_provenance: funding.provenance, tiers: tiers?.tiers ?? [], lever_tiers: tiers?.lever_tiers ?? [], max_lever: tiers?.max_lever ?? null,
      provenance: { source: `okx:${inst} history-candles(${okxBar(tf)}) + history-mark-price-candles + funding(okx 月度归档/REST,币安 ${binanceSymbolOf(inst)} 代理) + position-tiers(isolated)`, version: PERP_MARKET_VERSION, trade_coverage: bars.length ? { from_ms: bars[0]!.open_time, to_ms: bars.at(-1)!.close_time } : null, mark_coverage: markCov, mark_missing_bars: markMissing, flags: [...flags], notes: [...notes, funding.provenance.note], requests: ctx.requests() },
    };
  } finally { if (owned) cache.close(); }
}
/** 测试/脚本用:对已有缓存构造上下文,直接调 syncCandles/loadFunding/loadTiers */
export function perpContext(cache: MarketCache, opts: PerpFetchOptions = {}): PerpContext { return makeCtx(cache, opts); }
