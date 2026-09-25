/**
 * OKX 资产全集 + 每日全市场代码扫描(docs/design/watch-screener-review-2026-09-24.md 二-1)。
 *
 * 做什么:
 *   1. 资产全集:OKX 全部「在售」USDT 现货 + USDT 本位线性永续,按规范符号(BTCUSDT)合并成一行,附最新价、
 *      24h 涨跌、24h 成交额(现货 + 永续合计)、永续资金费、按 24h 成交额的名次;稳定币 / 法币锚定 / 包装与
 *      质押衍生币打标排除(复用 research/batch/universe.ts 的 looksExcluded)。落库 state.sqlite
 *      (migrations/0043),接口只读缓存,不在请求路径上打 OKX。
 *   2. 刷新:每天 UTC 00:10 一次;网关启动时缓存超过 24h 也刷一次;可手动刷新。一次刷新 = 5 个公共请求
 *      (SPOT/SWAP instruments、SPOT/SWAP tickers、funding-rate?instId=ANY),每个请求失败重试 3 次(退避),
 *      任一必需请求最终失败 → 整次作废、**保留上一次的表**。资金费那个请求失败不算致命(资金费留空)。
 *   3. 每日全市场扫描:刷新成功后,零模型地对全集(排除 excluded)跑一遍 screener 的打分(buildCard,
 *      沿用 funnel.ts 的 computeMetrics / evaluateBar 口径),存成当天的一次 screen(demo_screen,
 *      horizon='daily'、universe='okx_all')+ 候选(demo_watch_candidate)。
 *      K 线只对 24h 成交额前 N(默认 150)拉:每个币 2 个请求(4h×300、1d×300,约 50 天 / 300 天),
 *      按中线口径(4h 打分、1d 确认)算;其余的币不拉 K 线,只在资产全集里按成交额排序。
 *      失败的币(本机走 Clash,ECONNRESET 成串)歇 5 秒再补一遍,仍失败才记进 screen.errors。
 *      90 天成交额(近似 Σ 日线 volume×close,只算拉 K 线的那个市场:有永续用永续)也只有这前 N 个有,
 *      顺手写回资产表。
 *
 * 红线:零模型、零写交易所、不改 workflow。凭证不经过这里(全是公共接口)。
 */
import type { DatabaseSync } from 'node:sqlite';
import { fetchKlinesOkx, okxGet } from './market-okx.js';
import { parseInstruments, parseSpotInstruments, setInstruments } from './okx/instruments.js';
import { looksExcluded } from './research/batch/universe.js';
import { buildCard, screenId, ScreenStore, type OpportunityCard, type ScreenHorizon, type ScreenRow, type WatchCandidate, type WatchlistProposal } from './screener.js';
import type { StrategyLibrary, StrategySpec } from './strategies.js';
import type { Kline, Market } from './types.js';

// ---------------------------------------------------------------- 口径

export type UniverseMarket = 'spot' | 'perp';
export type UniverseSort = 'volume' | 'change' | 'funding';

export interface UniverseAsset {
  symbol: string;
  base: string;
  markets: UniverseMarket[];
  spot_inst_id: string | null;
  perp_inst_id: string | null;
  /** 最新价:有现货取现货,否则永续。十进制字符串。 */
  last: string | null;
  /** 24h 涨跌 %(与 last 同一个市场),十进制字符串,3 位小数。 */
  change_24h: string | null;
  /** 24h 报价币(USDT)成交额,现货 + 永续合计,2 位小数。 */
  quote_volume_24h: string;
  spot_quote_volume_24h: string | null;
  perp_quote_volume_24h: string | null;
  /** 永续当期资金费率(小数,不是 %);只有永续有。 */
  funding_rate: string | null;
  next_funding_at: number | null;
  listed_at: number | null;
  /** 在「未排除」集合里按 24h 成交额的名次(1 起);排除的为 null。 */
  rank_by_volume: number | null;
  /** 近 90 个完整 UTC 日成交额(近似),只有每日扫描拉过日线的前 N 个有。 */
  quote_volume_90d: string | null;
  rank_by_volume_90d: number | null;
  excluded: boolean;
  excluded_reason: string | null;
  updated_at: number;
}

/** 每天刷新时刻:UTC 00:10。 */
export const DAILY_REFRESH_UTC_MINUTE = 10;
/** 缓存多旧算过期(启动时检查)。 */
export const UNIVERSE_STALE_MS = 24 * 3_600_000;
/** 每日扫描拉 K 线的币数上限(24h 成交额前 N)。 */
export const DAILY_SCAN_TOP_N = 150;
/** 每日扫描存进 demo_screen 的 horizon(不是 radar 的三个周期之一,radar 的调度不会把它当成自己的上一次)。 */
export const DAILY_SCAN_HORIZON = 'daily';
export const DAILY_SCAN_UNIVERSE = 'okx_all';
/** 每日扫描候选的有效期:到下一次每日扫描 + 1 小时余量。 */
const DAILY_SCAN_TTL_MS = 25 * 3_600_000;

/** `2026-09-24T00:10Z` 之后的下一个 UTC 00:10。 */
export function nextDailyRefreshAt(now: number): number {
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, DAILY_REFRESH_UTC_MINUTE);
  return now < today ? today : today + 86_400_000;
}
/** 最近一个已经过去的 UTC 00:10(「今天的扫描」从这一刻算起)。 */
export function lastDailyRefreshAt(now: number): number {
  return nextDailyRefreshAt(now) - 86_400_000;
}

// ---------------------------------------------------------------- 解析(纯函数)

interface RawTicker { instId?: string; last?: string; open24h?: string; volCcy24h?: string }
interface RawFunding { instId?: string; fundingRate?: string; fundingTime?: string }
interface RawInst { instId?: string; listTime?: string }

export interface UniverseRaw {
  spot_instruments: unknown[];
  swap_instruments: unknown[];
  spot_tickers: unknown[];
  swap_tickers: unknown[];
  /** null = 资金费那个请求失败了(不致命)。 */
  funding: unknown[] | null;
}

const num = (s: unknown): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};
function pctChange(t: RawTicker | undefined): { pct: string | null; sort: number | null } {
  if (!t) return { pct: null, sort: null };
  const last = num(t.last), open = num(t.open24h);
  if (!(open > 0) || !(last > 0)) return { pct: null, sort: null };
  const v = ((last - open) / open) * 100;
  return { pct: v.toFixed(3), sort: v };
}

/**
 * 原始响应 → 合并后的资产行(已排名)。只收在售(state=live)的 USDT 现货与 USDT 本位线性永续。
 * 永续成交额 = volCcy24h(币本位)× last;现货的 volCcy24h 本身就是报价币成交额。
 */
export function buildUniverseRows(raw: UniverseRaw, now: number): UniverseAsset[] {
  const spot = parseSpotInstruments(raw.spot_instruments);
  const swap = parseInstruments(raw.swap_instruments);
  const listTime = new Map<string, number>();
  for (const r of [...raw.spot_instruments, ...raw.swap_instruments] as RawInst[]) {
    if (r && r.instId && Number(r.listTime) > 0) listTime.set(r.instId, Number(r.listTime));
  }
  const tick = new Map<string, RawTicker>();
  for (const t of [...raw.spot_tickers, ...raw.swap_tickers] as RawTicker[]) if (t && t.instId) tick.set(t.instId, t);
  const fund = new Map<string, RawFunding>();
  for (const f of (raw.funding ?? []) as RawFunding[]) if (f && f.instId) fund.set(f.instId, f);

  const rows = new Map<string, UniverseAsset>();
  const blank = (symbol: string, base: string): UniverseAsset => ({
    symbol, base, markets: [], spot_inst_id: null, perp_inst_id: null, last: null, change_24h: null,
    quote_volume_24h: '0.00', spot_quote_volume_24h: null, perp_quote_volume_24h: null, funding_rate: null,
    next_funding_at: null, listed_at: null, rank_by_volume: null, quote_volume_90d: null, rank_by_volume_90d: null,
    excluded: false, excluded_reason: null, updated_at: now,
  });
  const listed = (row: UniverseAsset, instId: string): void => {
    const t = listTime.get(instId);
    if (t && (row.listed_at === null || t < row.listed_at)) row.listed_at = t;
  };
  for (const s of spot) {
    const base = s.instId.split('-')[0]!.toUpperCase();
    const row = rows.get(s.symbol) ?? blank(s.symbol, base);
    row.markets.push('spot');
    row.spot_inst_id = s.instId;
    const t = tick.get(s.instId);
    row.spot_quote_volume_24h = num(t?.volCcy24h).toFixed(2);
    if (t?.last) row.last = String(t.last);
    row.change_24h = pctChange(t).pct;
    listed(row, s.instId);
    rows.set(s.symbol, row);
  }
  for (const p of swap) {
    const base = p.instFamily.split('-')[0]!.toUpperCase();
    const row = rows.get(p.symbol) ?? blank(p.symbol, base);
    row.markets.push('perp');
    row.perp_inst_id = p.instId;
    const t = tick.get(p.instId);
    row.perp_quote_volume_24h = (num(t?.volCcy24h) * num(t?.last)).toFixed(2);
    if (row.last === null && t?.last) {
      row.last = String(t.last);
      row.change_24h = pctChange(t).pct;
    }
    const f = fund.get(p.instId);
    if (f && f.fundingRate !== undefined && f.fundingRate !== '' && Number.isFinite(Number(f.fundingRate))) {
      row.funding_rate = String(f.fundingRate);
      row.next_funding_at = Number(f.fundingTime) > 0 ? Number(f.fundingTime) : null;
    }
    listed(row, p.instId);
    rows.set(p.symbol, row);
  }
  const out = [...rows.values()];
  for (const r of out) {
    r.quote_volume_24h = (num(r.spot_quote_volume_24h) + num(r.perp_quote_volume_24h)).toFixed(2);
    if (looksExcluded(r.base)) {
      r.excluded = true;
      r.excluded_reason = 'stable_or_wrapped';
    }
  }
  out.sort((a, b) => num(b.quote_volume_24h) - num(a.quote_volume_24h) || a.symbol.localeCompare(b.symbol));
  let rank = 0;
  for (const r of out) r.rank_by_volume = r.excluded ? null : ++rank;
  return out;
}

export interface UniverseQuery {
  market?: 'spot' | 'perp' | 'all';
  q?: string;
  limit?: number;
  sort?: UniverseSort;
  order?: 'asc' | 'desc';
  include_excluded?: boolean;
}

/**
 * 过滤 + 排序(纯函数,给路由和联想用)。
 * q:代码或 base 包含即可,大小写不敏感;「以 q 开头」的排在前面(联想时输 BT 先出 BTC)。
 * sort:volume = 24h 成交额;change = 24h 涨跌;funding = 资金费率(只有永续有,没有的沉底)。默认降序。
 */
export function queryUniverse(items: UniverseAsset[], q: UniverseQuery): { total: number; items: UniverseAsset[] } {
  const market = q.market ?? 'all';
  const needle = (q.q ?? '').trim().toUpperCase().replace(/[-/_\s]/g, '');
  const sort = q.sort ?? 'volume';
  const dir = q.order === 'asc' ? 1 : -1;
  const limit = Math.min(5000, Math.max(1, Math.floor(q.limit ?? 100)));
  const key = (r: UniverseAsset): number | null =>
    sort === 'volume' ? num(r.quote_volume_24h) : sort === 'change' ? (r.change_24h === null ? null : Number(r.change_24h)) : r.funding_rate === null ? null : Number(r.funding_rate);
  const hits = items.filter((r) => {
    if (!q.include_excluded && r.excluded) return false;
    if (market !== 'all' && !r.markets.includes(market)) return false;
    if (needle && !r.symbol.includes(needle) && !r.base.includes(needle)) return false;
    return true;
  });
  const prefix = (r: UniverseAsset): number => (!needle ? 0 : r.base === needle || r.symbol === needle ? 0 : r.base.startsWith(needle) || r.symbol.startsWith(needle) ? 1 : 2);
  hits.sort((a, b) => {
    const p = prefix(a) - prefix(b);
    if (p) return p;
    const ka = key(a), kb = key(b);
    if (ka === null && kb !== null) return 1;
    if (kb === null && ka !== null) return -1;
    if (ka !== null && kb !== null && ka !== kb) return (ka - kb) * dir;
    return num(b.quote_volume_24h) - num(a.quote_volume_24h) || a.symbol.localeCompare(b.symbol);
  });
  return { total: hits.length, items: hits.slice(0, limit) };
}

// ---------------------------------------------------------------- 取数

export type OkxGetFn = <T>(path: string, timeoutMs?: number) => Promise<T>;

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** 重试(含 HTTP 429 / 5xx;okxGet 自己只重试网络错一次)。每次调用 get 计一个请求。 */
async function withRetry<T>(fn: () => Promise<T>, counter: { n: number }, attempts: number, delayMs: number): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    counter.n++;
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts - 1) await sleep(delayMs * (i + 1));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export interface FetchUniverseOptions {
  get?: OkxGetFn;
  attempts?: number;
  retry_delay_ms?: number;
  /** 两个请求之间的停顿(公共接口 20 次/2 秒,5 个请求本来就远低于上限,这里只是别连发)。 */
  pause_ms?: number;
}

/** 拉一次原始数据:5 个请求。必需请求失败 → 抛(调用方保留旧缓存)。 */
export async function fetchUniverseRaw(opts: FetchUniverseOptions = {}): Promise<{ raw: UniverseRaw; requests: number; notes: string[] }> {
  const get: OkxGetFn = opts.get ?? (<T,>(path: string, timeoutMs?: number) => okxGet<T>(path, timeoutMs ?? 15_000));
  const attempts = opts.attempts ?? 3;
  const delay = opts.retry_delay_ms ?? 1500;
  const pause = opts.pause_ms ?? 150;
  const counter = { n: 0 };
  const notes: string[] = [];
  const one = async (path: string): Promise<unknown[]> => {
    const rows = await withRetry(() => get<unknown[]>(path, 15_000), counter, attempts, delay);
    await sleep(pause);
    if (!Array.isArray(rows)) throw new Error(`${path} 返回的不是数组`);
    return rows;
  };
  const spot_instruments = await one('/api/v5/public/instruments?instType=SPOT');
  const swap_instruments = await one('/api/v5/public/instruments?instType=SWAP');
  const spot_tickers = await one('/api/v5/market/tickers?instType=SPOT');
  const swap_tickers = await one('/api/v5/market/tickers?instType=SWAP');
  let funding: unknown[] | null = null;
  try {
    funding = await one('/api/v5/public/funding-rate?instId=ANY');
  } catch (e) {
    notes.push(`资金费拉取失败(${(e as Error).message.slice(0, 80)}),这次资金费留空`);
  }
  if (!spot_instruments.length && !swap_instruments.length) throw new Error('OKX instruments 返回空表');
  return { raw: { spot_instruments, swap_instruments, spot_tickers, swap_tickers, funding }, requests: counter.n, notes };
}

// ---------------------------------------------------------------- 持久化

export interface UniverseRefreshRow {
  id: number;
  started_at: number;
  finished_at: number | null;
  status: 'running' | 'done' | 'failed';
  reason: string;
  total: number | null;
  requests: number | null;
  duration_ms: number | null;
  error: string | null;
}

export class UniverseStore {
  constructor(private readonly db: DatabaseSync) {}

  /** 整表替换(单事务):失败回滚,旧表原样保留。 */
  replaceAll(rows: UniverseAsset[]): void {
    const ins = this.db.prepare(
      `INSERT INTO okx_universe_asset(symbol, base, markets_json, spot_inst_id, perp_inst_id, last, change_24h, quote_volume_24h,
         spot_quote_volume_24h, perp_quote_volume_24h, volume_sort, change_sort, funding_rate, funding_sort, next_funding_at, listed_at,
         rank_by_volume, quote_volume_90d, rank_by_volume_90d, excluded, excluded_reason, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM okx_universe_asset');
      for (const r of rows) {
        ins.run(
          r.symbol, r.base, JSON.stringify(r.markets), r.spot_inst_id, r.perp_inst_id, r.last, r.change_24h, r.quote_volume_24h,
          r.spot_quote_volume_24h, r.perp_quote_volume_24h, num(r.quote_volume_24h), r.change_24h === null ? null : Number(r.change_24h),
          r.funding_rate, r.funding_rate === null ? null : Number(r.funding_rate), r.next_funding_at, r.listed_at,
          r.rank_by_volume, r.quote_volume_90d, r.rank_by_volume_90d, r.excluded ? 1 : 0, r.excluded_reason, r.updated_at,
        );
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  all(): UniverseAsset[] {
    const rows = this.db.prepare('SELECT * FROM okx_universe_asset ORDER BY volume_sort DESC, symbol ASC').all() as Record<string, unknown>[];
    const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
    const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    return rows.map((r) => ({
      symbol: String(r['symbol']),
      base: String(r['base']),
      markets: JSON.parse(String(r['markets_json'] ?? '[]')) as UniverseMarket[],
      spot_inst_id: s(r['spot_inst_id']),
      perp_inst_id: s(r['perp_inst_id']),
      last: s(r['last']),
      change_24h: s(r['change_24h']),
      quote_volume_24h: String(r['quote_volume_24h'] ?? '0.00'),
      spot_quote_volume_24h: s(r['spot_quote_volume_24h']),
      perp_quote_volume_24h: s(r['perp_quote_volume_24h']),
      funding_rate: s(r['funding_rate']),
      next_funding_at: n(r['next_funding_at']),
      listed_at: n(r['listed_at']),
      rank_by_volume: n(r['rank_by_volume']),
      quote_volume_90d: s(r['quote_volume_90d']),
      rank_by_volume_90d: n(r['rank_by_volume_90d']),
      excluded: Number(r['excluded']) === 1,
      excluded_reason: s(r['excluded_reason']),
      updated_at: Number(r['updated_at']),
    }));
  }

  /** 每日扫描算出的 90 天成交额写回;名次在「有值的」里排。 */
  setVolume90d(values: Map<string, number>): void {
    const ranked = [...values.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const upd = this.db.prepare('UPDATE okx_universe_asset SET quote_volume_90d = ?, rank_by_volume_90d = ? WHERE symbol = ?');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('UPDATE okx_universe_asset SET quote_volume_90d = NULL, rank_by_volume_90d = NULL');
      ranked.forEach(([sym, v], i) => upd.run(v.toFixed(2), i + 1, sym));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  startRefresh(reason: string, at: number): number {
    const r = this.db.prepare("INSERT INTO okx_universe_refresh(started_at, status, reason) VALUES (?, 'running', ?)").run(at, reason);
    return Number(r.lastInsertRowid);
  }
  finishRefresh(id: number, f: { status: 'done' | 'failed'; finished_at: number; total?: number | null; requests?: number | null; error?: string | null }): void {
    this.db
      .prepare('UPDATE okx_universe_refresh SET status = ?, finished_at = ?, total = ?, requests = ?, error = ? WHERE id = ?')
      .run(f.status, f.finished_at, f.total ?? null, f.requests ?? null, f.error ?? null, id);
    this.db.prepare('UPDATE okx_universe_refresh SET duration_ms = finished_at - started_at WHERE id = ?').run(id);
  }
  lastRefresh(): UniverseRefreshRow | null {
    const r = this.db.prepare('SELECT * FROM okx_universe_refresh ORDER BY id DESC LIMIT 1').get() as Record<string, unknown> | undefined;
    return r ? toRefresh(r) : null;
  }
  /** 最近一次**成功**刷新的完成时刻;从没成功过 → null。 */
  updatedAt(): number | null {
    const r = this.db.prepare("SELECT finished_at FROM okx_universe_refresh WHERE status = 'done' ORDER BY id DESC LIMIT 1").get() as { finished_at: number } | undefined;
    if (r) return Number(r.finished_at);
    const m = this.db.prepare('SELECT MAX(updated_at) AS t FROM okx_universe_asset').get() as { t: number | null } | undefined;
    return m?.t ?? null;
  }
}

function toRefresh(r: Record<string, unknown>): UniverseRefreshRow {
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    id: Number(r['id']),
    started_at: Number(r['started_at']),
    finished_at: n(r['finished_at']),
    status: String(r['status']) as UniverseRefreshRow['status'],
    reason: String(r['reason']),
    total: n(r['total']),
    requests: n(r['requests']),
    duration_ms: n(r['duration_ms']),
    error: r['error'] === null || r['error'] === undefined ? null : String(r['error']),
  };
}

// ---------------------------------------------------------------- 进程内快照(给 funnel / screener 同步读)

let snapshot: { updated_at: number | null; items: UniverseAsset[] } | null = null;
let dailyScanSymbols: { screen_id: string; at: number; symbols: string[] } | null = null;

/** 当前内存里的资产全集;服务没起来 / 从没刷过 → null。 */
export function currentUniverse(): { updated_at: number | null; items: UniverseAsset[] } | null {
  return snapshot;
}
/** 最近一次每日扫描的候选(按名次);没有 → null。 */
export function currentDailyScan(): { screen_id: string; at: number; symbols: string[] } | null {
  return dailyScanSymbols;
}
/** 测试用。 */
export function resetUniverseSnapshot(): void {
  snapshot = null;
  dailyScanSymbols = null;
}

// ---------------------------------------------------------------- 每日全市场扫描

export type KlineFetcher = (symbol: string, tf: string, limit: number, endTime: number | undefined, market: Market) => Promise<Kline[]>;

export interface DailyScanOptions {
  assets: UniverseAsset[];
  strategies: StrategySpec[];
  now: number;
  top_n?: number;
  /** 每个币之间的停顿(OKX candles 公共限速 40 次/2 秒;每币 2 个请求 + 150ms ≈ 每秒 6 个)。 */
  pause_ms?: number;
  /** 提案截几个(只是给 UI 的「建议观察」,不会自动应用)。 */
  proposal_k?: number;
  fetch_klines?: KlineFetcher;
  /** 失败的币第二遍重试前歇多久(默认 5s)。 */
  second_pass_pause_ms?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface DailyScanResult {
  screen: ScreenRow;
  candidates: WatchCandidate[];
  cards: OpportunityCard[];
  /** symbol → 近 90 个完整 UTC 日成交额(近似)。 */
  volume_90d: Map<string, number>;
  requests: number;
}

/** 近 90 个**完整** UTC 日的成交额,近似为 Σ volume(币)× close。日线不足 → null。 */
export function volume90d(d1: Kline[], now: number): { value: number; days: number } | null {
  const closed = d1.filter((k) => k.close_time < now).slice(-90);
  if (!closed.length) return null;
  return { value: closed.reduce((a, k) => a + num(k.volume) * num(k.close), 0), days: closed.length };
}

/** 中线口径的策略:swing / position;库里一条都没有就用全部非退役策略(别让全市场扫描静默出空卡)。 */
export function dailyScanStrategies(all: StrategySpec[]): StrategySpec[] {
  const live = all.filter((s) => s.status !== 'retired');
  const swing = live.filter((s) => s.horizon === 'swing' || s.horizon === 'position');
  return swing.length ? swing : live;
}

async function klinesWithRetry(f: KlineFetcher, symbol: string, tf: string, market: Market, counter: { n: number }): Promise<Kline[]> {
  return withRetry(() => f(symbol, tf, 300, undefined, market), counter, 2, 2000);
}

/**
 * 跑一次全市场扫描(不落库;落库由 OkxUniverseService 做)。
 * 打分:screener.buildCard 的中线(swing)口径 —— 4h 打分、1d 确认、funnel.computeMetrics / evaluateBar 判条件。
 * 资金费:只有当期一个点(资产全集里的 funding_rate),所以 30 天 z 分数恒为空;funding 类策略的「极端」判定照常。
 */
export async function runDailyScan(opts: DailyScanOptions): Promise<DailyScanResult> {
  const now = opts.now;
  const topN = Math.max(0, opts.top_n ?? DAILY_SCAN_TOP_N);
  const pause = opts.pause_ms ?? 150;
  const fetchK: KlineFetcher = opts.fetch_klines ?? ((s, tf, limit, end, market) => fetchKlinesOkx(s, tf, limit, end, market));
  const eligible = opts.assets.filter((a) => !a.excluded).sort((a, b) => num(b.quote_volume_24h) - num(a.quote_volume_24h) || a.symbol.localeCompare(b.symbol));
  const heavy = eligible.slice(0, topN);
  const counter = { n: 0 };
  const cards: OpportunityCard[] = [];
  const marketOf = new Map<string, UniverseMarket>();
  const errors: { symbol: string; error: string }[] = [];
  const vol90 = new Map<string, number>();
  let done = 0;
  const one = async (a: UniverseAsset): Promise<void> => {
    const market: UniverseMarket = a.markets.includes('perp') ? 'perp' : 'spot';
    marketOf.set(a.symbol, market);
    // 同一个币的两条并发(每币 2 个请求,OKX candles 限速 40 次/2 秒,远不到);币与币之间串行 + pause。
    const [h4, d1] = await Promise.all([klinesWithRetry(fetchK, a.symbol, '4h', market, counter), klinesWithRetry(fetchK, a.symbol, '1d', market, counter)]);
    const v = volume90d(d1, now);
    if (v) vol90.set(a.symbol, v.value);
    const lastClosed = h4.filter((k) => k.close_time <= now).at(-1)?.close_time ?? now;
    const funding = a.funding_rate !== null ? [{ at: lastClosed, rate: a.funding_rate }] : [];
    const card = buildCard({
      symbol: a.symbol,
      horizon: 'swing',
      series: { base: h4, h1: h4, h4, d1, funding },
      strategies: opts.strategies,
      now,
      quote_volume_24h: num(a.quote_volume_24h),
      next_funding_at: a.next_funding_at,
      with_expectancy: true,
    });
    card.volume.rank = a.rank_by_volume;
    card.volume.of = eligible.length;
    cards.push(card);
  };
  const failed: { a: UniverseAsset; error: string }[] = [];
  for (const a of heavy) {
    try {
      await one(a);
    } catch (e) {
      failed.push({ a, error: (e as Error).message.slice(0, 200) });
    }
    done++;
    opts.onProgress?.(done, heavy.length);
    await sleep(pause);
  }
  // 第二遍:本机走 Clash,ECONNRESET 成串出现(实测一轮 150 个里 21 个);歇一下把失败的再补一遍,仍失败才记 errors。
  if (failed.length) await sleep(opts.second_pass_pause_ms ?? 5_000);
  for (const f of failed) {
    try {
      await one(f.a);
    } catch (e) {
      errors.push({ symbol: f.a.symbol, error: (e as Error).message.slice(0, 200) });
    }
    await sleep(pause);
  }

  cards.sort((a, b) => {
    const fa = a.best?.fit_score ?? 0, fb = b.best?.fit_score ?? 0;
    if (fb !== fa) return fb - fa;
    const ea = a.strategies[0]?.expectancy?.expectancy_r ?? -99, eb = b.strategies[0]?.expectancy?.expectancy_r ?? -99;
    if (eb !== ea) return eb - ea;
    return (b.volume.quote_24h ?? 0) - (a.volume.quote_24h ?? 0);
  });

  const id = screenId(now);
  const horizon = DAILY_SCAN_HORIZON as unknown as ScreenHorizon;
  const f2 = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : v.toFixed(2));
  const candidates: WatchCandidate[] = cards
    .filter((c) => c.best !== null)
    .map((c, i) => {
      const best = c.strategies[0]!;
      const m = marketOf.get(c.symbol) === 'perp' ? '永续' : '现货';
      return {
        screen_id: id,
        horizon,
        symbol: c.symbol,
        strategy_id: best.strategy_id,
        fit_score: best.fit_score,
        rank: i + 1,
        reasons: [
          `OKX ${m},24h 成交额第 ${c.volume.rank ?? '?'} / ${c.volume.of}`,
          `契合 ${best.fit_score.toFixed(2)}(${best.passed}/${best.total} 条通过${best.near ? `,${best.near} 条差一点` : ''})`,
          ...(best.expectancy && best.expectancy.n > 0 ? [`近 ${best.expectancy.days} 天机械期望 ${f2(best.expectancy.expectancy_r)}R,${best.expectancy.n} 笔`] : []),
          ...(best.reasons.length ? [`还差:${best.reasons.join(';')}`] : []),
        ],
        card: c,
        ttl_at: now + DAILY_SCAN_TTL_MS,
        created_at: now,
      };
    });

  const k = Math.max(1, opts.proposal_k ?? 20);
  const top = candidates.slice(0, k);
  const rest = Math.max(0, eligible.length - heavy.length);
  const proposal: WatchlistProposal = {
    symbols: top.map((c) => c.symbol),
    active_strategies: Object.fromEntries(top.map((c) => [c.symbol, c.card.strategies.filter((s) => s.fit_score >= 0.5).slice(0, 2).map((s) => s.strategy_id)])),
    k,
    note: `每日全市场扫描(OKX):全集 ${eligible.length} 个(已排除稳定币/包装币),24h 成交额前 ${heavy.length} 个按中线口径(4h 打分、1d 确认)算指标,${cards.length} 张卡、${candidates.length} 个候选;其余 ${rest} 个只按 24h 成交额排序(见 /api/universe)。零模型;应用只改 watchlist。`,
  };
  const screen: ScreenRow = {
    id,
    horizon,
    started_at: now,
    finished_at: Date.now(),
    status: 'done',
    universe: DAILY_SCAN_UNIVERSE as ScreenRow['universe'],
    symbols: eligible.map((a) => a.symbol),
    errors,
    run_id: null,
    handoff_id: null,
    proposal,
    brain: null,
    cost_cny: 0,
    error: null,
  };
  return { screen, candidates, cards, volume_90d: vol90, requests: counter.n };
}

export interface UniverseScanSummary {
  ready: boolean;
  screen_id: string | null;
  /** 这次扫描覆盖的全集大小(已排除稳定币/包装币)。 */
  scanned: number;
  /** 拉 K 线 / 算指标失败的币数。 */
  errors: number;
  at: number | null;
  note: string | null;
  candidates: { symbol: string; score: number; reasons: string[]; strategy_id: string; rank: number }[];
}

/**
 * 最近一次每日全市场扫描的只读摘要(给 Agent 对话工具 get_universe_scan 用;零模型、纯读库)。
 * 读 demo_screen 里 horizon='daily'、universe='okx_all' 的最新一行 + 对应 demo_watch_candidate。
 */
export function latestUniverseScan(db: DatabaseSync, opts: { limit?: number } = {}): UniverseScanSummary {
  const store = new ScreenStore(db);
  const screen = store.latest(DAILY_SCAN_HORIZON as unknown as ScreenHorizon);
  if (!screen || screen.universe !== DAILY_SCAN_UNIVERSE) return { ready: false, screen_id: null, scanned: 0, errors: 0, at: null, note: '还没有每日全市场扫描', candidates: [] };
  const limit = Math.min(500, Math.max(1, Math.floor(opts.limit ?? 20)));
  return {
    ready: true,
    screen_id: screen.id,
    scanned: screen.symbols.length,
    errors: screen.errors.length,
    at: screen.finished_at ?? screen.started_at,
    note: screen.proposal?.note ?? null,
    candidates: store.candidates(screen.id, limit).map((c) => ({ symbol: c.symbol, score: c.fit_score, reasons: c.reasons, strategy_id: c.strategy_id, rank: c.rank })),
  };
}

// ---------------------------------------------------------------- 服务(定时 + 单飞 + 落库)

export interface UniverseServiceOptions {
  /** 注入:拉原始数据(测试用桩)。 */
  fetchRaw?: (opts: FetchUniverseOptions) => Promise<{ raw: UniverseRaw; requests: number; notes: string[] }>;
  fetchOptions?: FetchUniverseOptions;
  fetchKlines?: KlineFetcher;
  library?: () => StrategyLibrary | null;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** screener.changed 之类(必须是 http.ts EVENTS 里有的)。 */
  emit?: (event: string, data: unknown) => void;
  now?: () => number;
  scan_top_n?: number;
  scan_pause_ms?: number;
  /** 开机后多久检查一次过期(让别的开机任务先跑;radar 在 60s 起跑)。 */
  boot_delay_ms?: number;
  /** 失败后多久再试;一天最多 retry_max 次。 */
  retry_ms?: number;
  retry_max?: number;
}

export interface RefreshResult {
  ok: boolean;
  updated_at: number | null;
  total: number;
  eligible: number;
  requests: number;
  duration_ms: number;
  error: string | null;
  notes: string[];
}

export class OkxUniverseService {
  readonly store: UniverseStore;
  private readonly screens: ScreenStore;
  private refreshing: Promise<RefreshResult> | null = null;
  private scanning: Promise<DailyScanResult | null> | null = null;
  private scanProgress: { done: number; total: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private retries = 0;
  private stopped = true;
  private readonly now: () => number;

  constructor(db: DatabaseSync, private readonly opts: UniverseServiceOptions = {}) {
    this.store = new UniverseStore(db);
    this.screens = new ScreenStore(db);
    this.now = opts.now ?? (() => Date.now());
    this.load();
  }

  /** 从库里装进内存快照(开机、每次刷新后)。 */
  load(): void {
    const items = this.store.all();
    snapshot = { updated_at: items.length ? this.store.updatedAt() : null, items };
    const latest = this.latestScan();
    dailyScanSymbols = latest ? { screen_id: latest.id, at: latest.started_at, symbols: this.screens.candidates(latest.id, 500).map((c) => c.symbol) } : null;
  }

  get isRefreshing(): boolean {
    return this.refreshing !== null;
  }
  get isScanning(): boolean {
    return this.scanning !== null;
  }
  get progress(): { done: number; total: number } | null {
    return this.scanProgress;
  }

  latestScan(): ScreenRow | null {
    return this.screens.latest(DAILY_SCAN_HORIZON as unknown as ScreenHorizon);
  }

  /** 单飞:并发调用拿到同一个 promise。失败不动旧表。 */
  refresh(reason: 'boot' | 'timer' | 'manual'): Promise<RefreshResult> {
    if (this.refreshing) return this.refreshing;
    const p = this.refreshInner(reason).finally(() => {
      this.refreshing = null;
    });
    this.refreshing = p;
    return p;
  }

  private async refreshInner(reason: string): Promise<RefreshResult> {
    const t0 = this.now();
    const id = this.store.startRefresh(reason, t0);
    const log = this.opts.log ?? (() => {});
    try {
      const { raw, requests, notes } = await (this.opts.fetchRaw ?? fetchUniverseRaw)(this.opts.fetchOptions ?? {});
      const finished = this.now();
      const rows = buildUniverseRows(raw, finished);
      // 顺手预热 okx/instruments 的进程内缓存(1000PEPE 这种符号 ↔ instId 映射只能靠表)。
      setInstruments(parseSpotInstruments(raw.spot_instruments), finished, 'spot');
      setInstruments(parseInstruments(raw.swap_instruments), finished, 'perp');
      // 90 天成交额是每日扫描算的,整表替换前先把上次的值带过来(下次扫描再覆盖)。
      const prev = new Map((snapshot?.items ?? []).map((r) => [r.symbol, r]));
      for (const r of rows) {
        const o = prev.get(r.symbol);
        if (o) {
          r.quote_volume_90d = o.quote_volume_90d;
          r.rank_by_volume_90d = o.rank_by_volume_90d;
        }
      }
      this.store.replaceAll(rows);
      this.store.finishRefresh(id, { status: 'done', finished_at: finished, total: rows.length, requests, error: notes.length ? notes.join(';') : null });
      this.load();
      this.retries = 0;
      const eligible = rows.filter((r) => !r.excluded).length;
      log('info', `OKX 资产全集已刷新(${reason}):${rows.length} 个(可交易 ${eligible},排除 ${rows.length - eligible}),${requests} 个请求,${finished - t0}ms${notes.length ? `;${notes.join(';')}` : ''}`);
      return { ok: true, updated_at: finished, total: rows.length, eligible, requests, duration_ms: finished - t0, error: null, notes };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      const finished = this.now();
      this.store.finishRefresh(id, { status: 'failed', finished_at: finished, error: msg });
      log('warn', `OKX 资产全集刷新失败(${reason}),保留上次缓存:${msg}`);
      return { ok: false, updated_at: snapshot?.updated_at ?? null, total: snapshot?.items.length ?? 0, eligible: (snapshot?.items ?? []).filter((r) => !r.excluded).length, requests: 0, duration_ms: finished - t0, error: msg, notes: [] };
    }
  }

  /** 跑每日扫描并落库(单飞)。资产全集是空的 → null。 */
  scan(reason: 'boot' | 'timer' | 'manual'): Promise<DailyScanResult | null> {
    if (this.scanning) return this.scanning;
    const p = this.scanInner(reason).finally(() => {
      this.scanning = null;
      this.scanProgress = null;
    });
    this.scanning = p;
    return p;
  }

  private async scanInner(reason: string): Promise<DailyScanResult | null> {
    const log = this.opts.log ?? (() => {});
    const assets = snapshot?.items ?? [];
    if (!assets.length) {
      log('warn', '每日全市场扫描跳过:资产全集是空的(还没刷新成功过)');
      return null;
    }
    const lib = this.opts.library?.() ?? null;
    const strategies = dailyScanStrategies(lib ? lib.list() : []);
    const t0 = this.now();
    try {
      const r = await runDailyScan({
        assets,
        strategies,
        now: t0,
        ...(this.opts.scan_top_n !== undefined ? { top_n: this.opts.scan_top_n } : {}),
        ...(this.opts.scan_pause_ms !== undefined ? { pause_ms: this.opts.scan_pause_ms } : {}),
        ...(this.opts.fetchKlines ? { fetch_klines: this.opts.fetchKlines } : {}),
        onProgress: (done, total) => {
          this.scanProgress = { done, total };
        },
      });
      r.screen.finished_at = this.now();
      this.screens.saveScreen(r.screen);
      this.screens.saveCandidates(r.candidates);
      this.store.setVolume90d(r.volume_90d);
      this.load();
      log('info', `每日全市场扫描完成(${reason}):全集 ${r.screen.symbols.length} 个,算指标 ${r.cards.length} 个,候选 ${r.candidates.length} 个,K 线请求 ${r.requests} 个,失败 ${r.screen.errors.length} 个,${r.screen.finished_at - t0}ms`);
      this.opts.emit?.('screener.changed', { screen_id: r.screen.id, horizon: DAILY_SCAN_HORIZON, universe: DAILY_SCAN_UNIVERSE, status: 'done' });
      return r;
    } catch (e) {
      log('warn', `每日全市场扫描失败(${reason}):${(e as Error).message.slice(0, 200)}`);
      return null;
    }
  }

  // ------------------------------------------------------------ 定时

  /**
   * 开机:boot_delay 之后检查 —— 缓存超过 24h(或从没刷过)就刷新;今天(最近一个 UTC 00:10 之后)还没有
   * 每日扫描就扫一次。然后挂到下一个 UTC 00:10。定时器全部 unref,不拖住进程退出。
   */
  start(): void {
    this.stopped = false;
    this.arm(this.opts.boot_delay_ms ?? 30_000, 'boot');
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(delayMs: number, reason: 'boot' | 'timer'): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.onTimer(reason), Math.min(Math.max(0, delayMs), 2 ** 31 - 1));
    this.timer.unref?.();
  }

  private armDaily(): void {
    if (this.stopped) return;
    this.arm(nextDailyRefreshAt(this.now()) - this.now(), 'timer');
  }

  /** 给测试和开机检查用:现在该不该刷 / 该不该扫。 */
  due(now = this.now()): { refresh: boolean; scan: boolean } {
    const updated = snapshot?.updated_at ?? null;
    const latest = this.latestScan();
    return {
      refresh: updated === null || now - updated > UNIVERSE_STALE_MS,
      scan: !latest || latest.started_at < lastDailyRefreshAt(now),
    };
  }

  async tick(reason: 'boot' | 'timer'): Promise<void> {
    const due = this.due();
    let ok = true;
    if (reason === 'timer' || due.refresh) ok = (await this.refresh(reason)).ok;
    if (!ok) {
      // 失败:过一会儿再试,一天最多 retry_max 次;旧缓存照用。
      const max = this.opts.retry_max ?? 4;
      if (!this.stopped && this.retries < max) {
        this.retries++;
        this.arm(this.opts.retry_ms ?? 15 * 60_000, 'timer'); // timer = 强制刷新 + 扫描
        return;
      }
    } else if (reason === 'timer' || this.due().scan) {
      await this.scan(reason);
    }
    this.armDaily();
  }

  private async onTimer(reason: 'boot' | 'timer'): Promise<void> {
    if (this.stopped) return;
    try {
      await this.tick(reason);
    } catch (e) {
      this.opts.log?.('warn', `OKX 资产全集定时任务出错:${(e as Error).message.slice(0, 200)}`);
      this.armDaily();
    }
  }
}
