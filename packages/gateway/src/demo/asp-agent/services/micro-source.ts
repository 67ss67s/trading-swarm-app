/**
 * BTC/ETH 微观结构数据源(给订阅频道 market_brief / micro_alerts 用):盘口快照 + 清算流。
 *
 * 运行时实现读盘口/清算录制器(~/.trading-swarm-okx/micro/recorder.mjs)写的 gzip jsonl:
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
}
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
}
export interface MicroSource {
  /** 支持的 symbol(如 BTCUSDT) */
  symbols(): string[];
  /** 最新一帧盘口;没数据或比 now 旧超过上限返回 null */
  book(symbol: string, now: number): Promise<MicroBook | null>;
  /** 交易所时刻落在 (from_ms, to_ms] 的清算,已去重,按时间升序 */
  liquidations(symbol: string, from_ms: number, to_ms: number): Promise<MicroLiq[]>;
  /** 录制器对该 symbol 的覆盖区间;完全没数据返回 null */
  coverage(symbol: string, now: number): Promise<MicroCoverage | null>;
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

export const DEFAULT_MICRO_DIR = join(homedir(), '.trading-swarm-okx/micro/data');
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

  return {
    symbols: () => Object.keys(instruments),
    async book(symbol, now) {
      let best: MicroBook | null = null;
      for (const f of await bookFiles(symbol, now)) if (f.last && (!best || f.last.at > best.at)) best = f.last;
      // 本机时钟可能落后交易所几十秒:比 now 新 2 分钟以内也算有效
      if (!best || now - best.at > maxAge || best.at - now > 120_000) return null;
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
}

// ---------------------------------------------------------------- 内存实现(测试 / 演示)

export interface MemoryMicroData { books?: Record<string, MicroBook | null>; liqs?: Record<string, MicroLiq[]>; coverage?: Record<string, MicroCoverage | null> }
/** 内存假实现:数据可以随时改(测试里直接改 data 字段) */
export function memoryMicroSource(data: MemoryMicroData, symbols: string[] = ['BTCUSDT', 'ETHUSDT']): MicroSource & { data: MemoryMicroData } {
  return {
    data,
    symbols: () => symbols,
    book: async (s) => data.books?.[s] ?? null,
    liquidations: async (s, from, to) => (data.liqs?.[s] ?? []).filter((r) => r.at > from && r.at <= to).sort((a, b) => a.at - b.at),
    coverage: async (s) => data.coverage?.[s] ?? null,
  };
}
