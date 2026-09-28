/**
 * BTC/ETH 微观结构数据源(给订阅频道 market_brief / micro_alerts 用):盘口快照 + 清算流。
 *
 * 运行时实现读盘口/清算录制器(~/.trade-gate-okx/micro/recorder.mjs)写的 gzip jsonl:
 *   book-<INST>-<UTC日>.<pid>.jsonl.gz  每 60s 一帧 OKX 永续 books(sz=200),{at, ts, bids, asks},数量单位 = 张
 *   liq-<INST>-<UTC日>.<pid>.jsonl.gz   每 20s 轮询公共清算单(去重),{at, inst, ts, side, posSide, px, sz},sz 单位 = 张
 * 张 → 基础币按冻结的 ctVal 换算(research/judge/microstructure.ts 的 baseQuantity),读 gzip 前缀复用 recordings.ts 的 readRecordingLines。
 * 时间一律用交易所时刻 ts(本机时钟可能被代理搞偏,at 只是本机请求时刻)。
 *
 * 注意:sz=200 档只覆盖近价很窄的一段(BTC 约 ±0.03%、ETH 约 ±0.08%),所以「±0.5% 深度」实际是「可见 200 档内深度」,
 * bookStats 会把可见范围(visible_pct)一起给出,文案要如实写。
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { constants, gunzipSync } from 'node:zlib';
import { baseQuantity } from '../../research/judge/microstructure.js';
import { readRecordingLines } from '../../research/judge/recordings.js';
import { okxGet } from '../../market-okx.js';

/** 盘口快照:价格与数量都已是数字,数量为基础币(已按 ctVal 换算) */
export interface MicroBook {
  symbol: string;
  inst_id: string;
  /** 交易所时刻 ms */
  at: number;
  /** 买盘价格降序 [price, base_qty] */
  bids: readonly (readonly [number, number])[];
  /** 卖盘价格升序 [price, base_qty] */
  asks: readonly (readonly [number, number])[];
  /** 可选:数据来自哪里(录制器文件 / OKX 公共 REST 兜底);缺省 = 录制器 */
  source?: MicroDataSource;
}
export type MicroDataSource = 'recorder' | 'okx_rest';
export interface MicroLiq {
  id: string;
  /** 交易所时刻 ms */
  at: number;
  /** 被强平的持仓方向 */
  side: 'long' | 'short';
  price: number;
  qty: number;
  notional_usd: number;
}
export interface MicroCoverage {
  /** 录制器最早/最新一帧盘口的交易所时刻(只看最近两个 UTC 日的文件) */
  from_ms: number;
  to_ms: number;
  /** 可选:覆盖来自哪里;'mixed' = 录制器 + REST 兜底拼起来 */
  source?: MicroDataSource | 'mixed';
}
/** 1 分钟/任意周期 K 线(OKX 永续),时间升序 */
export interface MicroCandle { at: number; open: number; high: number; low: number; close: number }
/** 持仓量(USD)序列,时间升序 */
export interface MicroOpenInterest { at: number; oi_usd: number; history: readonly { at: number; oi_usd: number }[] }
export interface MicroFunding { at: number; rate: number; next_at: number | null }
export interface MicroSource {
  /** 支持的 symbol(如 BTCUSDT) */
  symbols(): string[];
  /** 最新一帧盘口;没数据或比 now 旧超过上限返回 null */
  book(symbol: string, now: number): Promise<MicroBook | null>;
  /** 交易所时刻落在 (from_ms, to_ms] 的清算,已去重,按时间升序 */
  liquidations(symbol: string, from_ms: number, to_ms: number): Promise<MicroLiq[]>;
  /** 录制器对该 symbol 的覆盖区间;完全没数据返回 null */
  coverage(symbol: string, now: number): Promise<MicroCoverage | null>;
  /** 可选:离 ts 最近一帧盘口的中间价(交易所时刻,相差超过 tolerance_ms 返回 null);清算告警写窗口内价格变化用 */
  midAt?(symbol: string, ts: number, tolerance_ms?: number): Promise<MidPoint | null>;
  // ---- 以下可选,只在告警/摘要详情里用(OKX 公共 REST;录制器实现在配了 fallback 时代理过去)
  /** 深盘口快照(books-full,覆盖约 ±1%),详情里写 ±0.5% 失衡与最大挂单 */
  deepBook?(symbol: string, now: number): Promise<MicroBook | null>;
  /** K 线(bar 取 OKX 写法 1m/5m/15m/1H),时间升序,含未收盘的最后一根 */
  candles?(symbol: string, bar: string, limit: number): Promise<MicroCandle[]>;
  /** 持仓量现值 + 5 分钟序列(近 period_count 个点) */
  openInterest?(symbol: string, points: number): Promise<MicroOpenInterest | null>;
  /** 当期资金费率 */
  funding?(symbol: string): Promise<MicroFunding | null>;
}
export interface MidPoint { at: number; mid: number }
/** midAt 默认容差:录制器 60s 一帧,允许错开两帧 */
export const MID_TOLERANCE_MS = 2 * 60_000;
/** 在按时间升序的中间价序列里找离 ts 最近、且相差不超过 tol 的一帧 */
export function nearestMid(points: readonly MidPoint[], ts: number, tol = MID_TOLERANCE_MS): MidPoint | null {
  let best: MidPoint | null = null;
  for (const p of points) if (Math.abs(p.at - ts) <= tol && (!best || Math.abs(p.at - ts) < Math.abs(best.at - ts))) best = p;
  return best;
}

// ---------------------------------------------------------------- 盘口特征(纯函数)

export interface Wall { side: 'bid' | 'ask'; price: number; notional_usd: number; dist_pct: number }
export interface BookStats {
  mid: number;
  spread_bps: number;
  /** 取深度用的带宽(小数,0.005 = ±0.5%) */
  band_pct: number;
  /** 可见档位实际覆盖到离中间价多远(小数,两侧取小) */
  visible_pct: number;
  bid_depth_usd: number;
  ask_depth_usd: number;
  /** (买-卖)/(买+卖),与 microstructure.ts 的 ob_imbalance_05 同定义 */
  imbalance: number | null;
  /** 带宽内最大的单档挂单 */
  wall_bid: Wall | null;
  wall_ask: Wall | null;
  /** 按离中间价距离分桶(bucket_pct 一桶)聚合后的最大一桶 */
  cluster_bid: Wall | null;
  cluster_ask: Wall | null;
}

/** 盘口统计;book 不合法(空边、交叉)返回 null */
export function bookStats(book: MicroBook, opts: { band_pct?: number; bucket_pct?: number } = {}): BookStats | null {
  const band = opts.band_pct ?? 0.005;
  const bucket = opts.bucket_pct ?? 0.0001;
  const bb = book.bids[0], ba = book.asks[0];
  if (!bb || !ba || !(bb[0] > 0) || !(ba[0] > bb[0])) return null;
  const mid = (bb[0] + ba[0]) / 2;
  const side = (rows: MicroBook['bids'], s: 'bid' | 'ask') => {
    let depth = 0; let wall: Wall | null = null;
    const buckets = new Map<number, { notional: number; price: number }>();
    for (const [px, qty] of rows) {
      const dist = Math.abs(px - mid) / mid;
      if (!(px > 0) || !(qty >= 0) || dist > band) continue;
      const n = px * qty;
      depth += n;
      if (!wall || n > wall.notional_usd) wall = { side: s, price: px, notional_usd: n, dist_pct: dist };
      const k = Math.floor(dist / bucket);
      const b = buckets.get(k) ?? { notional: 0, price: px };
      b.notional += n; buckets.set(k, b);
    }
    let cluster: Wall | null = null;
    for (const [k, b] of buckets) if (!cluster || b.notional > cluster.notional_usd) cluster = { side: s, price: b.price, notional_usd: b.notional, dist_pct: k * bucket };
    const edge = rows.length ? Math.abs(rows[rows.length - 1]![0] - mid) / mid : 0;
    return { depth, wall, cluster, edge };
  };
  const b = side(book.bids, 'bid'), a = side(book.asks, 'ask');
  return {
    mid,
    spread_bps: ((ba[0] - bb[0]) / mid) * 10_000,
    band_pct: band,
    visible_pct: Math.min(b.edge, a.edge, band),
    bid_depth_usd: b.depth,
    ask_depth_usd: a.depth,
    imbalance: b.depth + a.depth > 0 ? (b.depth - a.depth) / (b.depth + a.depth) : null,
    wall_bid: b.wall, wall_ask: a.wall, cluster_bid: b.cluster, cluster_ask: a.cluster,
  };
}

export interface LiqSum { long_usd: number; short_usd: number; total_usd: number; count: number; largest: MicroLiq | null }
export function sumLiquidations(rows: readonly MicroLiq[]): LiqSum {
  let long = 0, short = 0, largest: MicroLiq | null = null;
  for (const r of rows) {
    if (r.side === 'long') long += r.notional_usd; else short += r.notional_usd;
    if (!largest || r.notional_usd > largest.notional_usd) largest = r;
  }
  return { long_usd: long, short_usd: short, total_usd: long + short, count: rows.length, largest };
}

/** 美元金额的短写:$1.23M / $456K / $789 */
export function usd(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  const a = Math.abs(x), s = x < 0 ? '-' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}K`;
  return `${s}$${a.toFixed(0)}`;
}

// ---------------------------------------------------------------- 录制器实现

export const DEFAULT_MICRO_DIR = join(homedir(), '.trade-gate-okx/micro/data');
/** 冻结的 OKX 线性 USDT 永续合约面值(基础币/张);未列出的资产不支持 */
export const DEFAULT_MICRO_INSTRUMENTS: Record<string, { inst_id: string; base_per_contract: string }> = {
  BTCUSDT: { inst_id: 'BTC-USDT-SWAP', base_per_contract: '0.01' },
  ETHUSDT: { inst_id: 'ETH-USDT-SWAP', base_per_contract: '0.1' },
};

export interface RecorderSourceOptions {
  directory?: string;
  instruments?: Record<string, { inst_id: string; base_per_contract: string }>;
  /** 最新一帧盘口比 now 旧超过这个就当没有(默认 5 分钟;录制器 60s 一帧) */
  max_book_age_ms?: number;
  /** 读最近几个 UTC 日的文件(默认 2 = 今天 + 昨天) */
  days?: number;
  /**
   * 录制器断档时的兜底数据源(OKX 公共 REST)。undefined = 生产默认:没指定 directory 且不在 vitest 里时自动接 okxRestMicroSource();
   * null = 不兜底(测试 / 离线)。
   */
  fallback?: MicroSource | null;
}

/** 只解最后一行完整 JSON(盘口文件一天 20MB+ 明文,整份 JSON.parse 每分钟跑太浪费) */
function firstAndLastLine(bytes: Uint8Array): { first: Record<string, unknown> | null; last: Record<string, unknown> | null } {
  const text = gunzipSync(bytes, { finishFlush: constants.Z_SYNC_FLUSH }).toString('utf8');
  const end = text.lastIndexOf('\n');
  if (end <= 0) return { first: null, last: null };
  const firstEnd = text.indexOf('\n');
  const prev = text.lastIndexOf('\n', end - 1);
  try {
    return { first: JSON.parse(text.slice(0, firstEnd)) as Record<string, unknown>, last: JSON.parse(text.slice(prev + 1, end)) as Record<string, unknown> };
  } catch { return { first: null, last: null }; }
}

export function recorderMicroSource(opts: RecorderSourceOptions = {}): MicroSource {
  const dir = opts.directory ?? DEFAULT_MICRO_DIR;
  const instruments = opts.instruments ?? DEFAULT_MICRO_INSTRUMENTS;
  const maxAge = opts.max_book_age_ms ?? 5 * 60_000;
  const days = Math.max(1, opts.days ?? 2);
  // 文件没变大就复用上次的解析结果(录制器只追加)
  const bookCache = new Map<string, { size: number; first_ts: number | null; last: MicroBook | null }>();
  const liqCache = new Map<string, { size: number; rows: MicroLiq[] }>();
  // 中间价序列:book() 每次读到新帧顺手记一笔(近 8 小时);记不到(刚重启)时 midAt 再去扫整份文件
  const midMem = new Map<string, MidPoint[]>();
  const midIndex = new Map<string, { size: number; points: MidPoint[] }>();
  const rememberMid = (symbol: string, b: MicroBook) => {
    const bb = b.bids[0]?.[0], ba = b.asks[0]?.[0];
    if (!(bb! > 0) || !(ba! > bb!)) return;
    const list = midMem.get(symbol) ?? [];
    if (list.length && list[list.length - 1]!.at >= b.at) return;
    list.push({ at: b.at, mid: (bb! + ba!) / 2 });
    while (list.length && list[0]!.at < b.at - 8 * 3_600_000) list.shift();
    midMem.set(symbol, list);
  };
  /** 整份盘口文件建中间价索引:只用正则抠 ts 与买一/卖一价,不整行 JSON.parse */
  const indexMids = (bytes: Uint8Array): MidPoint[] => {
    const text = gunzipSync(bytes, { finishFlush: constants.Z_SYNC_FLUSH }).toString('utf8');
    const out: MidPoint[] = [];
    const firstPx = (line: string, key: string): number => {
      const i = line.indexOf(`"${key}":[["`);
      if (i < 0) return NaN;
      const from = i + key.length + 6;
      return Number(line.slice(from, line.indexOf('"', from)));
    };
    for (const line of text.split('\n')) {
      const at = Number(/"ts":"?(\d+)/.exec(line.slice(0, 120))?.[1]);
      const b = firstPx(line, 'bids'), a = firstPx(line, 'asks');
      if (Number.isSafeInteger(at) && b > 0 && a > b) out.push({ at, mid: (a + b) / 2 });
    }
    return out.sort((x, y) => x.at - y.at);
  };

  const files = async (kind: 'book' | 'liq', inst: string, now: number): Promise<string[]> => {
    let names: string[];
    try { names = await readdir(dir); } catch { return []; }
    const dates = new Set(Array.from({ length: days }, (_, i) => new Date(now - i * 86_400_000).toISOString().slice(0, 10)));
    return names.filter((n) => n.startsWith(`${kind}-${inst}-`) && n.endsWith('.jsonl.gz') && [...dates].some((d) => n.startsWith(`${kind}-${inst}-${d}.`))).sort();
  };
  const levels = (v: unknown, ctVal: string): [number, number][] =>
    Array.isArray(v) ? (v as unknown[]).flatMap((x) => {
      if (!Array.isArray(x)) return [];
      const px = Number(x[0]);
      try { const q = Number(baseQuantity(String(x[1]), ctVal)); return Number.isFinite(px) && Number.isFinite(q) ? [[px, q] as [number, number]] : []; } catch { return []; }
    }) : [];

  const bookFiles = async (symbol: string, now: number) => {
    const ins = instruments[symbol];
    if (!ins) return [];
    const out: { first_ts: number | null; last: MicroBook | null }[] = [];
    for (const name of await files('book', ins.inst_id, now)) {
      const path = join(dir, name);
      try {
        const size = (await stat(path)).size;
        let c = bookCache.get(path);
        if (!c || c.size !== size) {
          const { first, last } = firstAndLastLine(await readFile(path));
          const ts = Number(last?.['ts']);
          c = {
            size,
            first_ts: Number.isSafeInteger(Number(first?.['ts'])) ? Number(first!['ts']) : null,
            last: last && Number.isSafeInteger(ts) ? { symbol, inst_id: ins.inst_id, at: ts, bids: levels(last['bids'], ins.base_per_contract), asks: levels(last['asks'], ins.base_per_contract) } : null,
          };
          bookCache.set(path, c);
        }
        out.push(c);
      } catch { /* 半写/损坏的文件跳过 */ }
    }
    return out;
  };

  const rec: MicroSource = {
    symbols: () => Object.keys(instruments),
    async book(symbol, now) {
      let best: MicroBook | null = null;
      for (const f of await bookFiles(symbol, now)) if (f.last && (!best || f.last.at > best.at)) best = f.last;
      // 本机时钟可能落后交易所几十秒:比 now 新 2 分钟以内也算有效
      if (!best || now - best.at > maxAge || best.at - now > 120_000) return null;
      rememberMid(symbol, best);
      return best;
    },
    async midAt(symbol, ts, tol = MID_TOLERANCE_MS) {
      const mem = nearestMid(midMem.get(symbol) ?? [], ts, tol);
      if (mem) return mem;
      const ins = instruments[symbol];
      if (!ins) return null;
      let best: MidPoint | null = null;
      for (const name of await files('book', ins.inst_id, ts + tol)) {
        const path = join(dir, name);
        try {
          const size = (await stat(path)).size;
          let c = midIndex.get(path);
          if (!c || c.size !== size) { c = { size, points: indexMids(await readFile(path)) }; midIndex.set(path, c); }
          const hit = nearestMid(c.points, ts, tol);
          if (hit && (!best || Math.abs(hit.at - ts) < Math.abs(best.at - ts))) best = hit;
        } catch { /* 坏文件跳过 */ }
      }
      return best;
    },
    async coverage(symbol, now) {
      let from = Infinity, to = -Infinity;
      for (const f of await bookFiles(symbol, now)) {
        if (f.first_ts !== null) from = Math.min(from, f.first_ts);
        if (f.last) to = Math.max(to, f.last.at);
      }
      return Number.isFinite(from) && Number.isFinite(to) ? { from_ms: from, to_ms: to } : null;
    },
    async liquidations(symbol, from_ms, to_ms) {
      const ins = instruments[symbol];
      if (!ins) return [];
      const seen = new Map<string, MicroLiq>();
      for (const name of await files('liq', ins.inst_id, to_ms)) {
        const path = join(dir, name);
        try {
          const size = (await stat(path)).size;
          let c = liqCache.get(path);
          if (!c || c.size !== size) {
            const rows: MicroLiq[] = [];
            for (const r of readRecordingLines(await readFile(path))) {
              const at = Number(r['ts']);
              if (!Number.isSafeInteger(at) || (r['posSide'] !== 'long' && r['posSide'] !== 'short')) continue;
              const price = Number(r['px']);
              let qty: number;
              try { qty = Number(baseQuantity(String(r['sz']), ins.base_per_contract)); } catch { continue; }
              if (!(price > 0) || !(qty > 0)) continue;
              rows.push({ id: `${ins.inst_id}:${at}:${r['posSide']}:${r['px']}:${r['sz']}`, at, side: r['posSide'], price, qty, notional_usd: price * qty });
            }
            c = { size, rows };
            liqCache.set(path, c);
          }
          for (const r of c.rows) if (r.at > from_ms && r.at <= to_ms) seen.set(r.id, r);
        } catch { /* 跳过坏文件 */ }
      }
      return [...seen.values()].sort((a, b) => a.at - b.at);
    },
  };
  const fallback = opts.fallback !== undefined ? opts.fallback
    : opts.directory === undefined && !process.env['VITEST'] ? okxRestMicroSource({ instruments }) : null;
  return fallback ? withFallback(rec, fallback, { max_book_age_ms: maxAge }) : rec;
}

// ---------------------------------------------------------------- OKX 公共 REST 兜底(录制器断档时用;只读公共接口,不需要 key)

/** GET 一个 OKX v5 公共路径,返回 data 字段(测试注入假实现) */
export type OkxGetFn = (path: string) => Promise<unknown>;
export interface RestSourceOptions {
  instruments?: Record<string, { inst_id: string; base_per_contract: string }>;
  get?: OkxGetFn;
  /** 本机时钟(测试注入) */
  now?: () => number;
  /** 清算回补目标:往回翻到 now - history_ms(默认 7h = 6h 基线 + 15 分钟窗口 + 余量) */
  history_ms?: number;
  /** 一次刷新最多翻几页(每页 ≤100 笔),行情暴走时防止翻爆;翻不完就如实缩短覆盖区间 */
  max_pages?: number;
  /** 同一 symbol 两次真正请求清算的最小间隔(一次 tick 里 coverage/liquidations 多次调用共用一次拉取) */
  min_refresh_ms?: number;
  /** 盘口比 now 旧超过这个就当没有 */
  max_book_age_ms?: number;
}
const LIQ_PAGE = 100;
const num = (x: unknown): number => { const v = Number(x); return Number.isFinite(v) ? v : NaN; };
function toLevels(v: unknown, ctVal: string): [number, number][] {
  return Array.isArray(v) ? (v as unknown[]).flatMap((x) => {
    if (!Array.isArray(x)) return [];
    const px = Number(x[0]);
    try { const q = Number(baseQuantity(String(x[1]), ctVal)); return Number.isFinite(px) && Number.isFinite(q) ? [[px, q] as [number, number]] : []; } catch { return []; }
  }) : [];
}

/**
 * OKX 公共 REST 版微观结构数据源:books(sz=200,与录制器同口径)、清算单(按 after 往回翻页 + 内存缓存,之后每次只拉最新一页)、
 * 以及详情用的 books-full / K 线 / 持仓量 / 资金费。请求量:回补一次最多 max_pages 页,之后每 symbol 每分钟 1 次清算 + 1 次盘口。
 */
export function okxRestMicroSource(opts: RestSourceOptions = {}): MicroSource {
  const instruments = opts.instruments ?? DEFAULT_MICRO_INSTRUMENTS;
  const get: OkxGetFn = opts.get ?? ((path) => okxGet<unknown>(path));
  const clock = opts.now ?? Date.now;
  const history = opts.history_ms ?? 7 * 3_600_000;
  const maxPages = Math.max(1, opts.max_pages ?? 20);
  const minRefresh = opts.min_refresh_ms ?? 20_000;
  const maxAge = opts.max_book_age_ms ?? 5 * 60_000;
  interface LiqState { rows: Map<string, MicroLiq>; complete_from: number; newest: number; fetched_at: number; inflight: Promise<void> | null }
  const liq = new Map<string, LiqState>();
  const memo = new Map<string, { at: number; value: Promise<unknown> }>();
  /** 短缓存:同一路径 ttl 内复用(失败不缓存) */
  const cached = <T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> => {
    const hit = memo.get(key), t = clock();
    if (hit && t - hit.at < ttl) return hit.value as Promise<T>;
    const value = fn();
    memo.set(key, { at: t, value });
    value.catch(() => { if (memo.get(key)?.value === value) memo.delete(key); });
    return value;
  };
  const parseLiqs = (inst: string, ctVal: string, data: unknown): MicroLiq[] => {
    const out: MicroLiq[] = [];
    for (const r of Array.isArray(data) ? data as Record<string, unknown>[] : []) {
      for (const d of Array.isArray(r?.['details']) ? r['details'] as Record<string, unknown>[] : []) {
        const at = Number(d['ts']), side = d['posSide'];
        if (!Number.isSafeInteger(at) || (side !== 'long' && side !== 'short')) continue;
        const price = Number(d['bkPx']);
        let qty: number;
        try { qty = Number(baseQuantity(String(d['sz']), ctVal)); } catch { continue; }
        if (!(price > 0) || !(qty > 0)) continue;
        // id 与录制器实现同一格式,两边拼起来天然去重
        out.push({ id: `${inst}:${at}:${side}:${String(d['bkPx'])}:${String(d['sz'])}`, at, side, price, qty, notional_usd: price * qty });
      }
    }
    return out;
  };
  const refresh = async (symbol: string): Promise<LiqState | null> => {
    const ins = instruments[symbol];
    if (!ins) return null;
    let st = liq.get(symbol);
    if (!st) { st = { rows: new Map(), complete_from: Infinity, newest: -Infinity, fetched_at: 0, inflight: null }; liq.set(symbol, st); }
    if (st.inflight) { await st.inflight; return st; }
    const now = clock();
    if (st.fetched_at && now - st.fetched_at < minRefresh) return st;
    const s = st;
    s.inflight = (async () => {
      const uly = ins.inst_id.replace(/-SWAP$/, '');
      const target = now - history;
      const fresh: MicroLiq[] = [];
      let after: number | null = null, oldest = Infinity, exhausted = false, reachedKnown = false;
      for (let page = 0; page < maxPages; page++) {
        let data: unknown;
        try { data = await get(`/api/v5/public/liquidation-orders?instType=SWAP&uly=${uly}&state=filled&limit=${LIQ_PAGE}${after === null ? '' : `&after=${after}`}`); }
        catch (e) { if (page === 0) throw e; break; }
        const rows = parseLiqs(ins.inst_id, ins.base_per_contract, data);
        const raw = Array.isArray(data) ? (data as Record<string, unknown>[]).reduce((n, r) => n + (Array.isArray(r?.['details']) ? (r['details'] as unknown[]).length : 0), 0) : 0;
        if (!raw) { exhausted = true; break; }
        fresh.push(...rows);
        const pageOldest = rows.reduce((m, r) => Math.min(m, r.at), Infinity);
        if (!(pageOldest < oldest)) break; // 翻不动了(同一时刻超过一页),按已拿到的算
        oldest = pageOldest;
        if (s.rows.size && pageOldest <= s.newest) { reachedKnown = true; break; }
        if (pageOldest <= target) break;
        if (raw < LIQ_PAGE) { exhausted = true; break; }
        after = pageOldest + 1; // after 是「严格早于」;+1 让同一毫秒的几笔不被页边界吃掉(重复的按 id 去重)
      }
      if (!reachedKnown) {
        // 首次回补,或断了太久接不上缓存:以这次翻到的为准
        s.rows = new Map();
        s.complete_from = exhausted ? Math.min(oldest, target) : Number.isFinite(oldest) ? oldest : target;
      }
      for (const r of fresh) s.rows.set(r.id, r);
      const cutoff = now - history - 3_600_000;
      for (const [id, r] of s.rows) if (r.at < cutoff) s.rows.delete(id);
      s.complete_from = Math.max(s.complete_from, cutoff);
      for (const r of fresh) if (r.at > s.newest) s.newest = r.at;
      s.fetched_at = now;
    })();
    try { await s.inflight; } finally { s.inflight = null; }
    return s;
  };
  const bookOf = async (symbol: string, now: number, path: string, ttl: number): Promise<MicroBook | null> => {
    const ins = instruments[symbol];
    if (!ins) return null;
    const data = await cached(path, ttl, () => get(path));
    const b = (Array.isArray(data) ? data[0] : null) as Record<string, unknown> | null;
    const at = Number(b?.['ts']);
    if (!b || !Number.isSafeInteger(at) || now - at > maxAge) return null;
    const out: MicroBook = { symbol, inst_id: ins.inst_id, at, bids: toLevels(b['bids'], ins.base_per_contract), asks: toLevels(b['asks'], ins.base_per_contract), source: 'okx_rest' };
    return out.bids.length && out.asks.length ? out : null;
  };
  return {
    symbols: () => Object.keys(instruments),
    book: (symbol, now) => bookOf(symbol, now, `/api/v5/market/books?instId=${instruments[symbol]?.inst_id}&sz=200`, 15_000),
    deepBook: (symbol, now) => bookOf(symbol, now, `/api/v5/market/books-full?instId=${instruments[symbol]?.inst_id}&sz=5000`, 30_000),
    async liquidations(symbol, from_ms, to_ms) {
      const st = await refresh(symbol);
      return st ? [...st.rows.values()].filter((r) => r.at > from_ms && r.at <= to_ms).sort((a, b) => a.at - b.at) : [];
    },
    async coverage(symbol, now) {
      const st = await refresh(symbol);
      if (!st || !st.fetched_at || !Number.isFinite(st.complete_from)) return null;
      return { from_ms: st.complete_from, to_ms: st.fetched_at, source: 'okx_rest' };
    },
    async candles(symbol, bar, limit) {
      const ins = instruments[symbol];
      if (!ins) return [];
      const n = Math.min(300, Math.max(1, Math.floor(limit)));
      const path = `/api/v5/market/candles?instId=${ins.inst_id}&bar=${bar}&limit=${n}`;
      const data = await cached(path, 30_000, () => get(path));
      return (Array.isArray(data) ? data as unknown[][] : [])
        .map((r) => ({ at: num(r?.[0]), open: num(r?.[1]), high: num(r?.[2]), low: num(r?.[3]), close: num(r?.[4]) }))
        .filter((c) => Number.isSafeInteger(c.at) && c.open > 0 && c.close > 0 && c.high > 0 && c.low > 0)
        .sort((a, b) => a.at - b.at);
    },
    async openInterest(symbol, points) {
      const ins = instruments[symbol];
      if (!ins) return null;
      const path = `/api/v5/rubik/stat/contracts/open-interest-history?instId=${ins.inst_id}&period=5m&limit=${Math.min(100, Math.max(2, Math.floor(points)))}`;
      const data = await cached(path, 60_000, () => get(path));
      const history = (Array.isArray(data) ? data as unknown[][] : [])
        .map((r) => ({ at: num(r?.[0]), oi_usd: num(r?.[3]) }))
        .filter((p) => Number.isSafeInteger(p.at) && p.oi_usd > 0)
        .sort((a, b) => a.at - b.at);
      const last = history[history.length - 1];
      return last ? { at: last.at, oi_usd: last.oi_usd, history } : null;
    },
    async funding(symbol) {
      const ins = instruments[symbol];
      if (!ins) return null;
      const path = `/api/v5/public/funding-rate?instId=${ins.inst_id}`;
      const data = await cached(path, 60_000, () => get(path));
      const r = (Array.isArray(data) ? data[0] : null) as Record<string, unknown> | null;
      const rate = num(r?.['fundingRate']);
      if (!r || !Number.isFinite(rate)) return null;
      const next = num(r['fundingTime']);
      return { at: Number.isSafeInteger(num(r['ts'])) ? num(r['ts']) : clock(), rate, next_at: Number.isSafeInteger(next) ? next : null };
    },
  };
}

/**
 * 录制器为主、REST 兜底:盘口录制器没新帧就用 REST;清算在录制器覆盖不了所问区间时两边合并(同一格式 id 去重);
 * 覆盖区间取两边拼接;详情用的深盘口 / K 线 / 持仓量 / 资金费直接走兜底源。
 */
export function withFallback(primary: MicroSource, fallback: MicroSource, o: { max_book_age_ms?: number; history_ms?: number } = {}): MicroSource {
  const maxAge = o.max_book_age_ms ?? 5 * 60_000;
  const history = o.history_ms ?? 7 * 3_600_000;
  const quiet = async <T>(p: () => Promise<T>): Promise<T | null> => { try { return await p(); } catch { return null; } };
  const recCovers = async (symbol: string, from: number, to: number): Promise<boolean> => {
    const c = await quiet(() => primary.coverage(symbol, to));
    return !!c && c.from_ms <= from && c.to_ms >= to - maxAge;
  };
  const out: MicroSource = {
    symbols: () => primary.symbols(),
    async book(symbol, now) {
      const b = await quiet(() => primary.book(symbol, now));
      if (b) return b.source ? b : { ...b, source: 'recorder' };
      return fallback.book(symbol, now);
    },
    async liquidations(symbol, from_ms, to_ms) {
      const rec = (await quiet(() => primary.liquidations(symbol, from_ms, to_ms))) ?? [];
      if (await recCovers(symbol, from_ms, to_ms)) return rec;
      const fb = await fallback.liquidations(symbol, from_ms, to_ms);
      const seen = new Map<string, MicroLiq>();
      for (const r of [...rec, ...fb]) seen.set(r.id, r);
      return [...seen.values()].sort((a, b) => a.at - b.at);
    },
    async coverage(symbol, now) {
      const rc = await quiet(() => primary.coverage(symbol, now));
      // 录制器活着且覆盖够一个完整基线窗口:不碰 REST(省请求,文案也如实写「录制器」)
      if (rc && rc.from_ms <= now - history && rc.to_ms >= now - maxAge) return { ...rc, source: rc.source ?? 'recorder' };
      const fc = await quiet(() => fallback.coverage(symbol, now));
      if (!fc) return rc ? { ...rc, source: rc.source ?? 'recorder' } : null;
      if (!rc || rc.to_ms < fc.from_ms - maxAge) return fc;
      return { from_ms: Math.min(rc.from_ms, fc.from_ms), to_ms: Math.max(rc.to_ms, fc.to_ms), source: rc.from_ms < fc.from_ms ? 'mixed' : 'okx_rest' };
    },
  };
  if (primary.midAt) out.midAt = (s, ts, tol) => primary.midAt!(s, ts, tol);
  if (fallback.deepBook) out.deepBook = (s, now) => fallback.deepBook!(s, now);
  if (fallback.candles) out.candles = (s, bar, limit) => fallback.candles!(s, bar, limit);
  if (fallback.openInterest) out.openInterest = (s, n) => fallback.openInterest!(s, n);
  if (fallback.funding) out.funding = (s) => fallback.funding!(s);
  return out;
}

// ---------------------------------------------------------------- 内存实现(测试 / 演示)

export interface MemoryMicroData {
  books?: Record<string, MicroBook | null>; liqs?: Record<string, MicroLiq[]>; coverage?: Record<string, MicroCoverage | null>; mids?: Record<string, MidPoint[]>;
  /** 详情用的可选数据(没给就返回空,等同数据源没有这项) */
  deep?: Record<string, MicroBook | null>; candles?: Record<string, MicroCandle[]>; oi?: Record<string, MicroOpenInterest | null>; funding?: Record<string, MicroFunding | null>;
}
/** 内存假实现:数据可以随时改(测试里直接改 data 字段) */
export function memoryMicroSource(data: MemoryMicroData, symbols: string[] = ['BTCUSDT', 'ETHUSDT']): MicroSource & { data: MemoryMicroData } {
  return {
    data,
    symbols: () => symbols,
    book: async (s) => data.books?.[s] ?? null,
    liquidations: async (s, from, to) => (data.liqs?.[s] ?? []).filter((r) => r.at > from && r.at <= to).sort((a, b) => a.at - b.at),
    coverage: async (s) => data.coverage?.[s] ?? null,
    midAt: async (s, ts, tol) => nearestMid(data.mids?.[s] ?? [], ts, tol),
    deepBook: async (s) => data.deep?.[s] ?? null,
    candles: async (s, _bar, limit) => (data.candles?.[s] ?? []).slice(-limit),
    openInterest: async (s) => data.oi?.[s] ?? null,
    funding: async (s) => data.funding?.[s] ?? null,
  };
}
