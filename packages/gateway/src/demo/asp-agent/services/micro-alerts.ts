/**
 * 订阅频道 micro_alerts:BTC/ETH 微观结构告警(事件驱动,约每分钟检查一次)。
 *
 * 触发(阈值见 MICRO_ALERT_DEFAULTS,按 2026-09-24/25 录制数据校准到「一天个位数次」):
 *   liq_surge  近 liq_window 清算额 ≥ 绝对下限 且 ≥ 基线(近 liq_baseline 同长度均值)× liq_mult
 *   imbalance  ±imbalance_band 内买卖深度失衡 |(买-卖)/(买+卖)| ≥ imbalance_abs(且总深度够)
 *   wall_bid / wall_ask  ±wall_band 内单档或按距离分桶聚合的挂单名义额超阈值
 * 每个 (symbol, kind) 有冷却(默认 30 分钟),一次 tick 最多推一条(按优先级),其余下一次 tick 再推。
 * 保活:quiet_ms(默认 6h)内一条都没推过,推一份「静默期摘要」,避免订阅者长时间收不到内容。
 * 只陈述结构事实,不给买卖指令。
 */
import { BANNED_WORDS } from '../publisher.js';
import { baseOf, channelPush, imbalanceText, price, safely, utcLabel } from './market-brief.js';
import { bookStats, sumLiquidations, usd, type BookStats, type LiqSum, type MicroBook, type MicroSource } from './micro-source.js';
import { num } from './render.js';
import type { ChannelDeps, ChannelPush, SubscriptionChannel } from './types.js';

export type MicroAlertKind = 'liq_surge' | 'imbalance' | 'wall_bid' | 'wall_ask';
/** 同一 tick 多个同时成立时的推送顺序 */
export const MICRO_ALERT_PRIORITY: readonly MicroAlertKind[] = ['liq_surge', 'imbalance', 'wall_bid', 'wall_ask'];

/** 按 symbol 给阈值,没列的用 default */
export type PerSymbol = Record<string, number> & { default: number };
export interface MicroAlertConfig {
  cooldown_ms: number;
  quiet_ms: number;
  liq_window_ms: number;
  liq_baseline_ms: number;
  /** 基线窗口里录制器至少要覆盖这么久,否则不判清算放量(基线不可信) */
  liq_min_baseline_ms: number;
  liq_mult: number;
  liq_floor_usd: PerSymbol;
  imbalance_band_pct: number;
  imbalance_abs: number;
  imbalance_min_depth_usd: PerSymbol;
  wall_band_pct: number;
  wall_bucket_pct: number;
  wall_level_usd: PerSymbol;
  wall_cluster_usd: PerSymbol;
  /** state 里保留最近几条告警(welcome / 静默摘要用) */
  recent_keep: number;
  block_timeout_ms: number;
}
export const MICRO_ALERT_DEFAULTS: MicroAlertConfig = {
  cooldown_ms: 30 * 60_000,
  quiet_ms: 6 * 3_600_000,
  liq_window_ms: 15 * 60_000,
  liq_baseline_ms: 6 * 3_600_000,
  liq_min_baseline_ms: 60 * 60_000,
  liq_mult: 6,
  // 09-25 实测:每 15 分钟清算中位数 ~$30K、p90 $0.3–0.5M、最大 $0.5–0.75M
  liq_floor_usd: { default: 500_000, BTCUSDT: 500_000, ETHUSDT: 500_000 },
  imbalance_band_pct: 0.005,
  // 09-25 实测:失衡 p5/p95 约 ±0.3,极值 -0.66
  imbalance_abs: 0.6,
  imbalance_min_depth_usd: { default: 2_000_000, BTCUSDT: 2_000_000, ETHUSDT: 2_000_000 },
  wall_band_pct: 0.01,
  wall_bucket_pct: 0.0001,
  // 09-25 实测:单档最大 p95 BTC $1.6M / ETH $2.3M,极值 $9.6M / $3.5M;0.01% 分桶 p99 BTC $5.5M / ETH $5.2M
  wall_level_usd: { default: 3_000_000, BTCUSDT: 5_000_000, ETHUSDT: 3_000_000 },
  wall_cluster_usd: { default: 6_000_000, BTCUSDT: 8_000_000, ETHUSDT: 6_000_000 },
  recent_keep: 5,
  block_timeout_ms: 20_000,
};
export const MICRO_EVERY_MS = 60_000;

export interface MicroDeps {
  micro: MicroSource | null;
  micro_config?: Partial<MicroAlertConfig>;
}

export interface MicroAlert {
  symbol: string;
  kind: MicroAlertKind;
  headline: string;
  lines: string[];
  data: Record<string, unknown>;
}
interface SymbolView { symbol: string; book: MicroBook | null; stats: BookStats | null; wide: BookStats | null; alive: boolean }
interface RecentAlert { at: number; symbol: string; kind: MicroAlertKind | 'quiet'; summary: string; event_id: string }

const pick = (p: PerSymbol, symbol: string): number => p[symbol] ?? p.default;
const K = {
  cooldown: (symbol: string, kind: string) => `micro:cd:${symbol}:${kind}`,
  lastPush: 'micro:last_push_at',
  recent: 'micro:recent',
};
const KIND_LABEL: Record<MicroAlertKind, string> = { liq_surge: '清算放量 / Liquidation surge', imbalance: '盘口失衡 / Book imbalance', wall_bid: '近价买墙 / Bid wall', wall_ask: '近价卖墙 / Ask wall' };

function config(deps: MicroDeps): MicroAlertConfig {
  const c = deps.micro_config ?? {};
  const merge = (k: keyof MicroAlertConfig) => ({ ...(MICRO_ALERT_DEFAULTS[k] as PerSymbol), ...((c[k] as PerSymbol | undefined) ?? {}) });
  return { ...MICRO_ALERT_DEFAULTS, ...c, liq_floor_usd: merge('liq_floor_usd'), imbalance_min_depth_usd: merge('imbalance_min_depth_usd'), wall_level_usd: merge('wall_level_usd'), wall_cluster_usd: merge('wall_cluster_usd') };
}

function readRecent(deps: ChannelDeps): RecentAlert[] {
  try { const r = deps.state.get(K.recent); const v = r ? JSON.parse(r) : []; return Array.isArray(v) ? v as RecentAlert[] : []; } catch { return []; }
}
const numState = (deps: ChannelDeps, key: string): number | null => { const v = Number(deps.state.get(key)); return deps.state.get(key) !== null && Number.isFinite(v) ? v : null; };

async function view(deps: ChannelDeps & MicroDeps, cfg: MicroAlertConfig, symbol: string, now: number): Promise<SymbolView> {
  const micro = deps.micro!;
  const book = await safely(deps, `micro book ${symbol}`, () => micro.book(symbol, now), cfg.block_timeout_ms);
  return {
    symbol, book, alive: !!book,
    stats: book ? bookStats(book, { band_pct: cfg.imbalance_band_pct, bucket_pct: cfg.wall_bucket_pct }) : null,
    wide: book ? bookStats(book, { band_pct: cfg.wall_band_pct, bucket_pct: cfg.wall_bucket_pct }) : null,
  };
}

export function snapshotLine(v: SymbolView): string {
  const b = baseOf(v.symbol);
  if (!v.book || !v.stats) return `${b} 盘口:录制器暂无数据 / recorder has no fresh data`;
  const s = v.stats;
  const vis = s.visible_pct < s.band_pct ? `可见 ±${(s.visible_pct * 100).toFixed(2)}%` : `±${(s.band_pct * 100).toFixed(1)}%`;
  return `${b} 中间价 ${price(s.mid)} · 价差 ${num(s.spread_bps, 2)}bp · 深度(${vis}) 买 ${usd(s.bid_depth_usd)} / 卖 ${usd(s.ask_depth_usd)} · 失衡 ${imbalanceText(s.imbalance)}`;
}
const snapshotData = (v: SymbolView) => v.stats && v.book ? { at: v.book.at, mid: v.stats.mid, spread_bps: v.stats.spread_bps, bid_depth_usd: v.stats.bid_depth_usd, ask_depth_usd: v.stats.ask_depth_usd, imbalance: v.stats.imbalance, visible_pct: v.stats.visible_pct } : null;

/** 当前成立的告警(不看冷却),按优先级排序 */
export async function evaluateMicro(deps: ChannelDeps & MicroDeps, now: number, views?: SymbolView[]): Promise<{ alerts: MicroAlert[]; views: SymbolView[] }> {
  const cfg = config(deps);
  const micro = deps.micro;
  if (!micro) return { alerts: [], views: [] };
  const vs = views ?? await Promise.all(micro.symbols().map((s) => view(deps, cfg, s, now)));
  const alerts: MicroAlert[] = [];
  for (const v of vs) {
    const b = baseOf(v.symbol);
    // 清算放量:录制器活着 + 基线窗口覆盖够长
    if (v.alive) {
      const cov = await safely(deps, `micro coverage ${v.symbol}`, () => micro.coverage(v.symbol, now), cfg.block_timeout_ms);
      const baseEnd = now - cfg.liq_window_ms, baseStart = baseEnd - cfg.liq_baseline_ms;
      const covered = cov ? Math.max(0, Math.min(baseEnd, cov.to_ms) - Math.max(baseStart, cov.from_ms)) : 0;
      if (cov && cov.from_ms <= baseEnd && covered >= cfg.liq_min_baseline_ms) {
        const rows = await safely(deps, `micro liq ${v.symbol}`, () => micro.liquidations(v.symbol, baseStart, now), cfg.block_timeout_ms);
        if (rows) {
          const recent = sumLiquidations(rows.filter((r) => r.at > baseEnd));
          const base = sumLiquidations(rows.filter((r) => r.at <= baseEnd && r.at > Math.max(baseStart, cov.from_ms)));
          const perWindow = base.total_usd * cfg.liq_window_ms / covered;
          const floor = pick(cfg.liq_floor_usd, v.symbol);
          if (recent.total_usd >= floor && recent.total_usd >= perWindow * cfg.liq_mult) {
            const mins = Math.round(cfg.liq_window_ms / 60_000), hrs = Math.round(covered / 3_600_000 * 10) / 10;
            const ratio = perWindow > 0 ? recent.total_usd / perWindow : null;
            const dom = recent.long_usd >= recent.short_usd ? '多头被强平为主 / longs liquidated' : '空头被强平为主 / shorts liquidated';
            alerts.push({
              symbol: v.symbol, kind: 'liq_surge',
              headline: `${b} 近 ${mins} 分钟清算 ${usd(recent.total_usd)},${dom}`,
              lines: [
                `近 ${mins} 分钟 / last ${mins}m: 多头被强平 ${usd(recent.long_usd)} · 空头被强平 ${usd(recent.short_usd)} · ${recent.count} 笔`,
                `基线 / baseline: 近 ${hrs}h 同长度均值 ${usd(perWindow)}${ratio !== null ? `,当前约 ${ratio.toFixed(1)} 倍` : ''}(阈值:≥ ${usd(floor)} 且 ≥ ${cfg.liq_mult} 倍基线)`,
                ...(recent.largest ? [`最大一笔 / largest: ${recent.largest.side === 'long' ? '多头' : '空头'} ${usd(recent.largest.notional_usd)} @ ${price(recent.largest.price)}(${utcLabel(recent.largest.at)})`] : []),
              ],
              data: { window_ms: cfg.liq_window_ms, recent: liqData(recent), baseline_per_window_usd: perWindow, baseline_covered_ms: covered, ratio, floor_usd: floor, mult: cfg.liq_mult },
            });
          }
        }
      }
    }
    // 盘口失衡
    const s = v.stats;
    if (s && s.imbalance !== null) {
      const depth = s.bid_depth_usd + s.ask_depth_usd, minDepth = pick(cfg.imbalance_min_depth_usd, v.symbol);
      if (Math.abs(s.imbalance) >= cfg.imbalance_abs && depth >= minDepth) {
        const bidHeavy = s.imbalance > 0;
        const ratio = bidHeavy ? s.bid_depth_usd / Math.max(1, s.ask_depth_usd) : s.ask_depth_usd / Math.max(1, s.bid_depth_usd);
        alerts.push({
          symbol: v.symbol, kind: 'imbalance',
          headline: `${b} 盘口${bidHeavy ? '买盘' : '卖盘'}明显偏厚,失衡 ${imbalanceText(s.imbalance)}(约 ${ratio.toFixed(1)}:1)`,
          lines: [`阈值 / threshold: |失衡| ≥ ${cfg.imbalance_abs} 且总深度 ≥ ${usd(minDepth)}`],
          data: { imbalance: s.imbalance, bid_depth_usd: s.bid_depth_usd, ask_depth_usd: s.ask_depth_usd, ratio, threshold: cfg.imbalance_abs },
        });
      }
    }
    // 近价大墙
    const w = v.wide;
    if (w) {
      for (const side of ['bid', 'ask'] as const) {
        const level = side === 'bid' ? w.wall_bid : w.wall_ask, cluster = side === 'bid' ? w.cluster_bid : w.cluster_ask;
        const lt = pick(cfg.wall_level_usd, v.symbol), ct = pick(cfg.wall_cluster_usd, v.symbol);
        const hitLevel = !!level && level.notional_usd >= lt, hitCluster = !!cluster && cluster.notional_usd >= ct;
        if (!hitLevel && !hitCluster) continue;
        const main = hitLevel ? level! : cluster!;
        const name = side === 'bid' ? '买墙' : '卖墙';
        alerts.push({
          symbol: v.symbol, kind: side === 'bid' ? 'wall_bid' : 'wall_ask',
          headline: `${b} 近价${name} ${usd(main.notional_usd)} @ ${price(main.price)}(距中间价 ${(main.dist_pct * 100).toFixed(3)}%)`,
          lines: [
            ...(level ? [`最大单档 / largest level: ${usd(level.notional_usd)} @ ${price(level.price)}${hitLevel ? ' ▲' : ''}`] : []),
            ...(cluster ? [`最大聚合档(${(cfg.wall_bucket_pct * 100).toFixed(2)}% 一桶)/ largest cluster: ${usd(cluster.notional_usd)} 起于 ${price(cluster.price)}${hitCluster ? ' ▲' : ''}`] : []),
            `阈值 / threshold: 单档 ≥ ${usd(lt)} 或聚合 ≥ ${usd(ct)}(±${(cfg.wall_band_pct * 100).toFixed(1)}% 内)`,
          ],
          data: { side, level, cluster, level_threshold_usd: lt, cluster_threshold_usd: ct, band_pct: cfg.wall_band_pct },
        });
      }
    }
  }
  alerts.sort((a, b) => MICRO_ALERT_PRIORITY.indexOf(a.kind) - MICRO_ALERT_PRIORITY.indexOf(b.kind));
  return { alerts, views: vs };
}
const liqData = (s: LiqSum) => ({ long_usd: s.long_usd, short_usd: s.short_usd, total_usd: s.total_usd, count: s.count, largest: s.largest });

/** 触发时间桶:宽度 = max(1 分钟, 冷却);两次同类告警至少隔一个冷却,必落在不同桶 */
export const bucketOf = (now: number, cooldown_ms: number): number => { const w = Math.max(60_000, cooldown_ms); return Math.floor(now / w) * w; };

function remember(deps: ChannelDeps, cfg: MicroAlertConfig, r: RecentAlert): void {
  const list = [r, ...readRecent(deps)].slice(0, Math.max(1, cfg.recent_keep));
  deps.state.set(K.recent, JSON.stringify(list));
  deps.state.set(K.lastPush, String(r.at));
}

function recentLines(recent: RecentAlert[], now: number, max = 3): string[] {
  const real = recent.filter((r) => r.kind !== 'quiet').slice(0, max);
  if (!real.length) return ['最近告警 / Recent alerts: 无 / none'];
  return ['最近告警 / Recent alerts:', ...real.map((r) => `· ${utcLabel(r.at)}(${Math.max(1, Math.round((now - r.at) / 60_000))} 分钟前)${r.summary}`)];
}

export const microAlertsChannel: SubscriptionChannel<MicroDeps> = {
  key: 'micro_alerts',
  every_ms: MICRO_EVERY_MS,
  async tick(deps) {
    const now = deps.now();
    const cfg = config(deps);
    if (!deps.micro) return null;
    const { alerts, views } = await evaluateMicro(deps, now);
    for (const a of alerts) {
      const last = numState(deps, K.cooldown(a.symbol, a.kind));
      if (last !== null && now - last < cfg.cooldown_ms && now >= last) continue;
      const event_id = `micro:${a.symbol}:${a.kind}:${bucketOf(now, cfg.cooldown_ms)}`;
      const v = views.find((x) => x.symbol === a.symbol);
      const push = channelPush('micro_alerts', event_id, `【微观结构告警 / Microstructure Alert】 ${baseOf(a.symbol)} ${KIND_LABEL[a.kind]} · ${utcLabel(now)}`, a.headline,
        [...a.lines, ...(v ? [`当前盘口 / Book now: ${snapshotLine(v)}`] : []), '结构性观察,不构成交易指令 / Structural observation only, not a trade instruction.'],
        { kind: a.kind, symbol: a.symbol, at: now, alert: a.data, book: v ? snapshotData(v) : null });
      deps.state.set(K.cooldown(a.symbol, a.kind), String(now));
      remember(deps, cfg, { at: now, symbol: a.symbol, kind: a.kind, summary: a.headline, event_id });
      return push;
    }
    // 保活:quiet_ms 内一条都没推 → 静默期摘要。第一次 tick 只起表,不推
    const last = numState(deps, K.lastPush);
    if (last === null) { deps.state.set(K.lastPush, String(now)); return null; }
    if (now - last < cfg.quiet_ms) return null;
    const push = await quietSummary(deps, cfg, now, views);
    remember(deps, cfg, { at: now, symbol: 'ALL', kind: 'quiet', summary: push.summary, event_id: push.event_id });
    return push;
  },
  async welcome(deps) {
    const now = deps.now();
    const cfg = config(deps);
    const title = `【微观结构告警 / Microstructure Alerts】 当前快照 / Snapshot · ${utcLabel(now)}`;
    const event_id = `micro:ALL:welcome:${Math.floor(now / 60_000) * 60_000}`;
    const recent = readRecent(deps);
    if (!deps.micro) {
      return channelPush('micro_alerts', event_id, title, '录制器暂无数据 / Recorder has no data yet', ['BTC/ETH 盘口与清算录制器未接入或暂无数据,恢复后会自动开始推送告警。', ...recentLines(recent, now)], { kind: 'welcome', at: now, books: {}, active: [], recent });
    }
    const { alerts, views } = await evaluateMicro(deps, now);
    const anyData = views.some((v) => v.alive);
    const lines = [
      ...views.map(snapshotLine),
      ...(alerts.length ? [`当前成立的条件 / Active now: ${alerts.map((a) => `${baseOf(a.symbol)} ${KIND_LABEL[a.kind].split(' / ')[0]}`).join(' · ')}`] : []),
      ...recentLines(recent, now),
      `规则 / Rules: 清算放量 ≥ ${cfg.liq_mult} 倍基线、盘口失衡 |x| ≥ ${cfg.imbalance_abs}、近价大墙;同类 ${Math.round(cfg.cooldown_ms / 60_000)} 分钟冷却;${Math.round(cfg.quiet_ms / 3_600_000)} 小时无告警推静默期摘要。`,
    ];
    const summary = anyData ? (alerts.length ? `当前 ${alerts.length} 个条件成立` : '当前无告警 / No active alerts') : '录制器暂无数据 / Recorder has no fresh data';
    return channelPush('micro_alerts', event_id, title, summary, lines,
      { kind: 'welcome', at: now, books: Object.fromEntries(views.map((v) => [v.symbol, snapshotData(v)])), active: alerts.map((a) => ({ symbol: a.symbol, kind: a.kind, headline: a.headline })), recent });
  },
};

async function quietSummary(deps: ChannelDeps & MicroDeps, cfg: MicroAlertConfig, now: number, views: SymbolView[]): Promise<ChannelPush> {
  const hrs = Math.round(cfg.quiet_ms / 3_600_000);
  const lines: string[] = [`过去 ${hrs} 小时没有触发告警,以下是当前盘口与清算概况 / No alerts in the past ${hrs}h; current snapshot below.`];
  const liqs: Record<string, ReturnType<typeof liqData> | null> = {};
  for (const v of views) {
    lines.push(snapshotLine(v));
    const cov = await safely(deps, `micro coverage ${v.symbol}`, () => deps.micro!.coverage(v.symbol, now), cfg.block_timeout_ms);
    const rows = cov ? await safely(deps, `micro liq ${v.symbol}`, () => deps.micro!.liquidations(v.symbol, now - cfg.quiet_ms, now), cfg.block_timeout_ms) : null;
    if (!rows || !cov) { liqs[v.symbol] = null; lines.push(`${baseOf(v.symbol)} 近 ${hrs}h 清算:录制器暂无数据`); continue; }
    const s = sumLiquidations(rows);
    liqs[v.symbol] = liqData(s);
    const partial = cov.from_ms > now - cfg.quiet_ms ? `(录制器只覆盖近 ${Math.max(0, (now - cov.from_ms) / 3_600_000).toFixed(1)}h)` : '';
    lines.push(`${baseOf(v.symbol)} 近 ${hrs}h 清算${partial}:多头被强平 ${usd(s.long_usd)} / 空头被强平 ${usd(s.short_usd)} · ${s.count} 笔${s.largest ? ` · 最大一笔 ${s.largest.side === 'long' ? '多头' : '空头'} ${usd(s.largest.notional_usd)}` : ''}`);
  }
  lines.push(...recentLines(readRecent(deps), now));
  const summary = views.some((v) => v.alive) ? `过去 ${hrs} 小时无告警,附当前盘口与清算概况` : '录制器暂无数据,暂无法判断告警条件';
  if (BANNED_WORDS.test(summary)) throw new Error('micro_alerts_banned_words');
  return channelPush('micro_alerts', `micro:ALL:quiet:${bucketOf(now, cfg.quiet_ms)}`, `【微观结构静默期摘要 / Microstructure Quiet-Period Summary】 ${utcLabel(now)}`, summary, lines,
    { kind: 'quiet', at: now, quiet_ms: cfg.quiet_ms, books: Object.fromEntries(views.map((v) => [v.symbol, snapshotData(v)])), liquidations: liqs });
}
