/**
 * 盯盘参数 / 筛选页的纯逻辑(无 React、无 i18n,test/watch.test.ts 覆盖):
 *   资产选择器的过滤 / 排序 / 联想、观察列表名额与合并去重、上移下移、雷达候选归并、
 *   全市场扫描挑选、调用量估算、候选的人话理由。
 * 文案一律返回「中文原文 + 变量」,由组件过 t() 翻译(中文原文就是 i18n key)。
 */
import type { OpportunityCard, ScreenRow, WatchCandidate } from '@/api/types';
import type { UniverseItem, UniverseMarketFilter } from '@/api/universe';

// ---------------------------------------------------------------- 代码归一

/** btc / BTC-USDT / BTC-USDT-SWAP / btcusdt → BTCUSDT;空串返回 ''。 */
export function normalizeSymbol(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/-SWAP$/, '').replace(/[^A-Z0-9]/g, '');
  if (!s) return '';
  return s.endsWith('USDT') && s.length > 4 ? s : `${s}USDT`;
}

/** 「btc, eth sol」→ ['BTCUSDT','ETHUSDT','SOLUSDT'](去重保序)。 */
export function parseSymbolInput(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[,，\s]+/)) {
    const s = normalizeSymbol(part);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------- 资产选择器

export type AssetSortKey = 'volume' | 'change' | 'funding';
export type SortDir = 'desc' | 'asc';

export interface AssetFilter {
  market: UniverseMarketFilter;
  q: string;
  /** 默认不显示后端打标排除的(稳定币 / 包装币) */
  includeExcluded?: boolean;
}

/** 搜索相关度:0 = base 完全相等,1 = 代码 / base 开头,2 = 包含,-1 = 不匹配。q 为空时全部 0。 */
export function matchTier(item: Pick<UniverseItem, 'symbol' | 'base'>, q: string): number {
  const qq = q.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!qq) return 0;
  if (item.base === qq || item.symbol === qq) return 0;
  if (item.base.startsWith(qq) || item.symbol.startsWith(qq)) return 1;
  if (item.symbol.includes(qq)) return 2;
  return -1;
}

/** 不匹配的(-1)排最后。 */
function tierRank(it: Pick<UniverseItem, 'symbol' | 'base'>, q: string): number {
  const t = matchTier(it, q);
  return t < 0 ? 99 : t;
}

export function filterUniverse(items: UniverseItem[], f: AssetFilter): UniverseItem[] {
  return items.filter((it) => {
    if (!f.includeExcluded && it.excluded) return false;
    if (f.market !== 'all' && !it.markets.includes(f.market)) return false;
    return matchTier(it, f.q) >= 0;
  });
}

function sortValue(it: UniverseItem, key: AssetSortKey): number | null {
  if (key === 'volume') return it.quote_volume_24h;
  if (key === 'change') return it.change_24h;
  return it.funding_rate;
}

/**
 * 排序:空值永远垫底;有搜索词时先按相关度分层,层内再按排序键。
 * 成交额 / 涨跌按数值;资金费 desc = 最高(多头拥挤)在前,asc = 最负(空头拥挤)在前。
 * 同值按成交额排名、再按代码,保证结果稳定。
 */
export function sortUniverse(items: UniverseItem[], key: AssetSortKey, dir: SortDir = 'desc', q = ''): UniverseItem[] {
  const sign = dir === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    const ta = tierRank(a, q);
    const tb = tierRank(b, q);
    if (ta !== tb) return ta - tb;
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va === null && vb !== null) return 1;
    if (vb === null && va !== null) return -1;
    if (va !== null && vb !== null && va !== vb) return sign * (va - vb);
    const ra = a.rank_by_volume ?? Number.POSITIVE_INFINITY;
    const rb = b.rank_by_volume ?? Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    return a.symbol.localeCompare(b.symbol);
  });
}

/** 过滤 + 排序 + 截断(列表只画前 limit 个,剩下的提示「继续输入缩小范围」)。 */
export function pickerRows(items: UniverseItem[], f: AssetFilter, key: AssetSortKey, dir: SortDir, limit = 200): { rows: UniverseItem[]; matched: number } {
  const matched = sortUniverse(filterUniverse(items, f), key, dir, f.q);
  return { rows: matched.slice(0, limit), matched: matched.length };
}

// ---------------------------------------------------------------- 名额 / 合并

export interface Quota {
  used: number;
  max: number;
  room: number;
  full: boolean;
}

export function quota(used: number, max: number): Quota {
  const m = Math.max(1, Math.floor(max || 1));
  const room = Math.max(0, m - used);
  return { used, max: m, room, full: room === 0 };
}

export interface MergeResult {
  next: string[];
  /** 真正加进去的 */
  added: string[];
  /** 本来就在名单里的 */
  already: string[];
  /** 超上限没加进去的 */
  overflow: string[];
}

/** 把 incoming 追加到名单尾部:去重、保序、不超过 max。 */
export function mergeAdd(watchlist: string[], incoming: string[], max: number): MergeResult {
  const next = [...watchlist];
  const added: string[] = [];
  const already: string[] = [];
  const overflow: string[] = [];
  const cap = quota(watchlist.length, max).max;
  for (const raw of incoming) {
    const s = raw.toUpperCase();
    if (!s) continue;
    if (next.includes(s)) {
      if (!added.includes(s) && !already.includes(s)) already.push(s);
      continue;
    }
    if (next.length >= cap) {
      if (!overflow.includes(s)) overflow.push(s);
      continue;
    }
    next.push(s);
    added.push(s);
  }
  return { next, added, already, overflow };
}

export interface WatchState {
  watchlist: string[];
  watch_only: string[];
}

/** 移除:连同 watch_only 里的标记一起清,不留孤儿标记。 */
export function removeSymbols(state: WatchState, syms: string[]): WatchState {
  const drop = new Set(syms);
  return { watchlist: state.watchlist.filter((s) => !drop.has(s)), watch_only: state.watch_only.filter((s) => !drop.has(s)) };
}

/** 可交易 / 只观察:trade=true 从 watch_only 去掉,否则加上(只对名单里的币生效)。 */
export function setTradable(state: WatchState, syms: string[], trade: boolean): WatchState {
  const inList = syms.filter((s) => state.watchlist.includes(s));
  const watch_only = trade ? state.watch_only.filter((s) => !inList.includes(s)) : [...new Set([...state.watch_only, ...inList])];
  return { watchlist: state.watchlist, watch_only };
}

/** 把 from 位置的元素挪到 to 位置(越界时夹到两端;同位置原样返回新数组)。 */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const dest = Math.max(0, Math.min(out.length - 1, to));
  const [x] = out.splice(from, 1);
  out.splice(dest, 0, x as T);
  return out;
}

// ---------------------------------------------------------------- 雷达候选 / 全市场扫描

export const MARKET_SCAN_UNIVERSE = 'okx_all';

export interface RadarHit {
  rank: number;
  fit: number;
  strategy_id: string;
  screen_id: string;
  at: number;
  universe: string;
}

/**
 * 把几次筛选(短线 / 全市场扫描…)的候选合成「每币最佳名次」;只收 windowMs 内完成的筛选
 * (默认 24h = 「今天的雷达候选」)。同一个币在多次筛选里出现时取名次最靠前的那次。
 */
export function radarHits(sources: { screen: ScreenRow | null; candidates: WatchCandidate[] }[], now: number, windowMs = 86_400_000): Map<string, RadarHit> {
  const m = new Map<string, RadarHit>();
  for (const src of sources) {
    const s = src.screen;
    if (!s || s.status === 'failed') continue;
    const at = s.finished_at ?? s.started_at;
    if (now - at > windowMs) continue;
    for (const c of src.candidates) {
      const prev = m.get(c.symbol);
      if (prev && prev.rank <= c.rank) continue;
      m.set(c.symbol, { rank: c.rank, fit: c.fit_score, strategy_id: c.strategy_id, screen_id: s.id, at, universe: String(s.universe) });
    }
  }
  return m;
}

/** 在若干份筛选记录里挑最近一次完成的全市场扫描(universe = okx_all)。 */
export function pickMarketScan(screens: (ScreenRow | null | undefined)[]): ScreenRow | null {
  let best: ScreenRow | null = null;
  for (const s of screens) {
    // 全市场扫描落在 horizon='daily'(universe-okx.ts);雷达切到 okx_all 模式后自己的 short/swing 也记成 universe='okx_all',要排除
    if (!s || String(s.universe) !== MARKET_SCAN_UNIVERSE || String(s.horizon) !== 'daily' || s.status !== 'done') continue;
    const at = s.finished_at ?? s.started_at;
    if (!best || at > (best.finished_at ?? best.started_at)) best = s;
  }
  return best;
}

/** 候选里的不同币数(一个币可能因多条策略出现多次)。 */
export function uniqueSymbols(candidates: WatchCandidate[]): string[] {
  const out: string[] = [];
  for (const c of candidates) if (!out.includes(c.symbol)) out.push(c.symbol);
  return out;
}

/** 同一个币只留名次最靠前的一行(候选表按币展示)。 */
export function bestPerSymbol(candidates: WatchCandidate[]): WatchCandidate[] {
  const m = new Map<string, WatchCandidate>();
  for (const c of candidates) {
    const prev = m.get(c.symbol);
    if (!prev || c.rank < prev.rank) m.set(c.symbol, c);
  }
  return [...m.values()].sort((a, b) => a.rank - b.rank);
}

/** 是不是今天(本地日历日)。 */
export function isSameLocalDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

// ---------------------------------------------------------------- 调用量估算

export interface PaceLike {
  watchlist: string[];
  timeframe: string;
  scan_mode: 'triggered' | 'every_close';
  heartbeat_every_ms: number;
}

export function tfMinutes(tf: string): number {
  const n = Number(tf.slice(0, -1));
  const u = tf.slice(-1);
  const v = u === 'h' ? n * 60 : u === 'd' ? n * 1440 : n;
  return Number.isFinite(v) && v > 0 ? v : 15;
}

/**
 * 预计每小时判断次数(docs/demo/v3-ui-contract.md §1 的近似公式,与 workflow-form 同口径):
 * 每根收盘都问 = 币数 × 每小时根数;触发器 = 心跳下限 ~ 心跳 + 每币每小时约 4 次触发。
 */
export function estimateCallsPerHour(w: PaceLike): { low: number; high: number } {
  const n = Math.max(1, w.watchlist.length);
  if (w.scan_mode === 'every_close') {
    const c = n * (60 / tfMinutes(w.timeframe));
    return { low: c, high: c };
  }
  const hb = n * (60 / Math.max(5, w.heartbeat_every_ms / 60_000));
  return { low: hb, high: hb + n * 4 };
}

/** 每天判断次数估算;cap > 0 时封顶。单价按 GLM ≈ ¥0.006/次。 */
export function estimateDaily(w: PaceLike, cap = 0, unitCny = 0.006): { low: number; high: number; costHigh: number; capped: boolean } {
  const h = estimateCallsPerHour(w);
  let low = Math.round(h.low * 24);
  let high = Math.round(h.high * 24);
  let capped = false;
  if (cap > 0) {
    if (high > cap) capped = true;
    low = Math.min(low, cap);
    high = Math.min(high, cap);
  }
  return { low, high, costHigh: high * unitCny, capped };
}

// ---------------------------------------------------------------- 人话理由

export interface Phrase {
  /** 中文原文(i18n key) */
  zh: string;
  vars?: Record<string, string | number>;
  tone?: 'up' | 'down' | 'warn' | 'muted';
}

/** 把一张机会卡翻成 2–4 句人话(只用代码算出的字段,不含模型文本)。 */
export function humanReasons(card: OpportunityCard): Phrase[] {
  const out: Phrase[] = [];
  const agree = card.trend.agree;
  if (agree) out.push({ zh: agree === 'long' ? '{tf} 与 {ctf} 都在涨' : '{tf} 与 {ctf} 都在跌', vars: { tf: card.timeframe, ctf: card.confirm_timeframe }, tone: agree === 'long' ? 'up' : 'down' });
  if (card.squeeze_on) out.push({ zh: '波动收窄 {n} 根,可能要选方向', vars: { n: card.squeeze_bars ?? 0 }, tone: 'warn' });
  const b = card.breakout;
  const near = [b.dist_long_atr, b.dist_short_atr].filter((x): x is number => x !== null && Number.isFinite(x) && Math.abs(x) <= 0.5);
  if (near.length) out.push({ zh: '离突破位不到 {n} 个 ATR', vars: { n: Math.min(...near.map(Math.abs)).toFixed(2) } });
  if (b.vol_ratio !== null && b.vol_ratio >= 1.5) out.push({ zh: '放量 {n} 倍', vars: { n: b.vol_ratio.toFixed(1) }, tone: 'warn' });
  const fz = card.funding.z_30d;
  if (fz !== null && Math.abs(fz) >= 2) out.push({ zh: fz > 0 ? '资金费偏高(多头拥挤)' : '资金费偏低(空头拥挤)', tone: 'warn' });
  if (card.volume.rank !== null && card.volume.rank <= 20) out.push({ zh: '成交额排第 {n}', vars: { n: card.volume.rank } });
  if (out.length === 0 && card.daily_regime) out.push({ zh: '日线:{r}', vars: { r: card.daily_regime }, tone: 'muted' });
  return out.slice(0, 4);
}

// ---------------------------------------------------------------- 格式

/** 成交额:紧凑到 1.23B / 345.6M / 12.3K。 */
export function fmtCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

/** 涨跌(百分数)→ +3.21% / -0.50%。 */
export function fmtChange(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
}

/** 资金费(小数)→ 0.0100%。 */
export function fmtFunding(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(4)}%`;
}

/** 价格:按量级给有效位。 */
export function fmtLast(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const d = a >= 1000 ? 1 : a >= 1 ? 3 : a >= 0.01 ? 5 : 8;
  return String(Number(v.toFixed(d)));
}
