/**
 * 订阅频道 micro_alerts:BTC/ETH 微观结构告警(事件驱动,约每分钟检查一次)。数据只来自 OKX 永续(单一交易所),文案都写明。
 *
 * 触发(阈值见 MICRO_ALERT_DEFAULTS,按 2026-09-24/25 录制数据校准到「一天个位数次」):
 *   liq_surge  近 liq_window 清算额 ≥ 绝对下限 且 ≥ 基线(近 liq_baseline 同长度均值)× liq_mult
 *   imbalance  ±imbalance_band 内买卖深度失衡 |(买-卖)/(买+卖)| ≥ imbalance_abs(且总深度够)
 *   wall_bid / wall_ask  ±wall_band 内单档或按距离分桶聚合的挂单名义额超阈值
 * 盘口两类(imbalance / wall)只在可见盘口覆盖 ≥ book_min_visible_pct 时才判:录制器 200 档只看得到 BTC ±0.03% / ETH ±0.08%,
 * 那种「墙」就是买一卖一,没有信息量;配置 book_alerts_when_shallow=true 可强制打开。
 * 清算放量告警附窗口内价格变化(优先 OKX 永续盘口中间价,取不到用窗口内首末笔清算成交价)。
 * 每个 (symbol, kind) 有冷却(默认 30 分钟),一次 tick 最多推一条(按优先级),其余下一次 tick 再推。
 * 保活:quiet_ms(默认 6h)内一条都没推过,推一份「静默期摘要」,避免订阅者长时间收不到内容。
 * 只陈述结构事实,不给买卖指令。推送正文全英文(OKX.AI 买家是国际用户);state 里改英文前存下的中文告警摘要按 kind 重写。
 */
import { BANNED_WORDS } from '../publisher.js';
import { CJK, asOfLabel, baseOf, channelPush, imbalanceText, plural, price, safely, signedPct, utcLabel } from './market-brief.js';
import { bookStats, sumLiquidations, usd, type BookStats, type LiqSum, type MicroBook, type MicroCoverage, type MicroLiq, type MicroSource } from './micro-source.js';
import { infoSignal } from './broadcast.js';
import { symbolToInstId } from '../../okx/instruments.js';
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
  /** 可见盘口(离中间价最远一档,两侧取小)不足这个范围就停发盘口失衡与大墙告警 */
  book_min_visible_pct: number;
  /** true = 可见范围不够也照样判盘口两类(不建议) */
  book_alerts_when_shallow: boolean;
  /** state 里保留最近几条告警(welcome / 静默摘要用) */
  recent_keep: number;
  block_timeout_ms: number;
  /** 静默摘要里的「盘口失衡区间」:每隔这么久采一次样(有深盘口用 ±0.5% 深盘口,否则用可见盘口) */
  imb_sample_ms: number;
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
  book_min_visible_pct: 0.003,
  book_alerts_when_shallow: false,
  recent_keep: 5,
  block_timeout_ms: 20_000,
  imb_sample_ms: 10 * 60_000,
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
  /** 订阅信号行正文(不含类型头与尾巴) */
  signal_body: string;
}
interface SymbolView { symbol: string; book: MicroBook | null; stats: BookStats | null; wide: BookStats | null; alive: boolean }
interface RecentAlert { at: number; symbol: string; kind: MicroAlertKind | 'quiet'; summary: string; event_id: string }

const pick = (p: PerSymbol, symbol: string): number => p[symbol] ?? p.default;
const K = {
  cooldown: (symbol: string, kind: string) => `micro:cd:${symbol}:${kind}`,
  lastPush: 'micro:last_push_at',
  recent: 'micro:recent',
  imb: (symbol: string) => `micro:imb:${symbol}`,
  imbAt: (symbol: string) => `micro:imb_at:${symbol}`,
};
export const KIND_LABEL: Record<MicroAlertKind, string> = { liq_surge: 'Liquidation spike', imbalance: 'Order-book imbalance', wall_bid: 'Bid wall near price', wall_ask: 'Ask wall near price' };
export const MICRO_SOURCE_LABEL = 'OKX perps';
const hoursText = (h: number): string => `${h}h`;

function config(deps: MicroDeps): MicroAlertConfig {
  const c = deps.micro_config ?? {};
  const merge = (k: keyof MicroAlertConfig) => ({ ...(MICRO_ALERT_DEFAULTS[k] as PerSymbol), ...((c[k] as unknown as PerSymbol | undefined) ?? {}) });
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

/** 一行盘口快照(不写价差:200 档盘口的价差恒为最小跳动;不写「墙」:可见范围太窄时那就是买一/卖一) */
export function snapshotLine(v: SymbolView): string {
  const b = baseOf(v.symbol);
  if (!v.book || !v.stats) return `${b} order book: temporarily unavailable (recorder and OKX REST both unreachable)`;
  const s = v.stats;
  const vis = s.visible_pct < s.band_pct ? `within the visible ±${(s.visible_pct * 100).toFixed(2)}%` : `within ±${(s.band_pct * 100).toFixed(1)}%`;
  return `${b} mid ${price(s.mid)} · ${vis}: bids ${usd(s.bid_depth_usd)} / asks ${usd(s.ask_depth_usd)} · imbalance ${imbalanceText(s.imbalance)}`;
}
/** 可见盘口够不够判盘口两类告警 */
export const bookDeepEnough = (v: SymbolView, cfg: Pick<MicroAlertConfig, 'book_min_visible_pct' | 'book_alerts_when_shallow'>): boolean =>
  cfg.book_alerts_when_shallow || (!!v.wide && v.wide.visible_pct >= cfg.book_min_visible_pct);
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
            const dom = dominance(recent.long_usd, recent.short_usd);
            const inWindow = rows.filter((r) => r.at > baseEnd);
            const move = await windowPriceMove(deps, cfg, v, now, liqPriceMove(inWindow));
            const vsBase = ratio !== null ? `${ratio.toFixed(1)}x the ${hoursText(hrs)} ${mins}-min average` : `no liquidations in the prior ${hoursText(hrs)}`;
            const moveText = move ? `price ${signedPct(Math.abs(move.change_pct) < 0.005 ? 0 : move.change_pct, 2)} over the window` : 'price change unavailable';
            alerts.push({
              symbol: v.symbol, kind: 'liq_surge',
              headline: `${b} liquidation spike: ${usd(recent.total_usd)} in ${mins} min on ${MICRO_SOURCE_LABEL}, ${vsBase}, ${dom}, ${moveText}`,
              signal_body: `${usd(recent.total_usd)} liquidated in ${mins} min, ${ratio !== null ? `${ratio.toFixed(1)}x the ${hoursText(hrs)} ${mins}-min avg` : `vs zero in prior ${hoursText(hrs)}`}, ${dom}, ${moveText}`,
              lines: [
                `Last ${mins} min: longs ${usd(recent.long_usd)} · shorts ${usd(recent.short_usd)} (${dom}) · ${plural(recent.count, 'liquidation')}`,
                priceMoveLine(move, now),
                `Baseline: ${usd(perWindow)} per ${mins}-min window on average over the last ${hoursText(hrs)}${ratio !== null ? `, now ~${ratio.toFixed(1)}×` : ''} (trigger: ≥ ${usd(floor)} and ≥ ${cfg.liq_mult}× baseline)`,
                ...(recent.largest ? [`Largest single liquidation: ${recent.largest.side === 'long' ? 'long' : 'short'} ${usd(recent.largest.notional_usd)} @ ${price(recent.largest.price)} (${utcLabel(recent.largest.at)})`] : []),
              ],
              data: { source: 'okx_swap', data_source: cov.source ?? 'recorder', window_ms: cfg.liq_window_ms, recent: liqData(recent), dominance: dom, baseline_per_window_usd: perWindow, baseline_covered_ms: covered, ratio, floor_usd: floor, mult: cfg.liq_mult, price_move: move },            });
          }
        }
      }
    }
    // 盘口两类:可见范围不够就不判(那点深度没有信息量)
    const deep = bookDeepEnough(v, cfg);
    // 盘口失衡
    const s = v.stats;
    if (deep && s && s.imbalance !== null) {
      const depth = s.bid_depth_usd + s.ask_depth_usd, minDepth = pick(cfg.imbalance_min_depth_usd, v.symbol);
      if (Math.abs(s.imbalance) >= cfg.imbalance_abs && depth >= minDepth) {
        const bidHeavy = s.imbalance > 0;
        const ratio = bidHeavy ? s.bid_depth_usd / Math.max(1, s.ask_depth_usd) : s.ask_depth_usd / Math.max(1, s.bid_depth_usd);
        alerts.push({
          symbol: v.symbol, kind: 'imbalance',
          headline: `${b}: ${MICRO_SOURCE_LABEL} order book clearly ${bidHeavy ? 'bid' : 'ask'}-heavy, imbalance ${imbalanceText(s.imbalance)} (~${ratio.toFixed(1)}:1)`,
          signal_body: `Order book ${bidHeavy ? 'bid' : 'ask'}-heavy: imbalance ${imbalanceText(s.imbalance)} (~${ratio.toFixed(1)}:1), bids ${usd(s.bid_depth_usd)} vs asks ${usd(s.ask_depth_usd)}`,
          lines: [`Trigger: |imbalance| ≥ ${cfg.imbalance_abs} within ±${(Math.min(s.visible_pct, s.band_pct) * 100).toFixed(2)}% and total depth ≥ ${usd(minDepth)}`],
          data: { source: 'okx_swap', visible_pct: s.visible_pct, imbalance: s.imbalance, bid_depth_usd: s.bid_depth_usd, ask_depth_usd: s.ask_depth_usd, ratio, threshold: cfg.imbalance_abs },
        });
      }
    }
    // 近价大墙
    const w = v.wide;
    if (deep && w) {
      for (const side of ['bid', 'ask'] as const) {
        const level = side === 'bid' ? w.wall_bid : w.wall_ask, cluster = side === 'bid' ? w.cluster_bid : w.cluster_ask;
        const lt = pick(cfg.wall_level_usd, v.symbol), ct = pick(cfg.wall_cluster_usd, v.symbol);
        const hitLevel = !!level && level.notional_usd >= lt, hitCluster = !!cluster && cluster.notional_usd >= ct;
        if (!hitLevel && !hitCluster) continue;
        const main = hitLevel ? level! : cluster!;
        const name = side === 'bid' ? 'bid wall' : 'ask wall';
        alerts.push({
          symbol: v.symbol, kind: side === 'bid' ? 'wall_bid' : 'wall_ask',
          headline: `${b}: ${usd(main.notional_usd)} ${name} near price on ${MICRO_SOURCE_LABEL} @ ${price(main.price)} (${(main.dist_pct * 100).toFixed(3)}% from mid)`,
          signal_body: `${usd(main.notional_usd)} ${name} ${(main.dist_pct * 100).toFixed(3)}% from mid`,
          lines: [
            ...(level ? [`Largest single level: ${usd(level.notional_usd)} @ ${price(level.price)}${hitLevel ? ' ▲' : ''}`] : []),
            ...(cluster ? [`Largest cluster (${(cfg.wall_bucket_pct * 100).toFixed(2)}% buckets): ${usd(cluster.notional_usd)} starting at ${price(cluster.price)}${hitCluster ? ' ▲' : ''}`] : []),
            `Trigger: single level ≥ ${usd(lt)} or cluster ≥ ${usd(ct)} (within ±${(Math.min(w.visible_pct, cfg.wall_band_pct) * 100).toFixed(2)}%)`,
          ],
          data: { source: 'okx_swap', visible_pct: w.visible_pct, side, level, cluster, level_threshold_usd: lt, cluster_threshold_usd: ct, band_pct: cfg.wall_band_pct },
        });
      }
    }
  }
  alerts.sort((a, b) => MICRO_ALERT_PRIORITY.indexOf(a.kind) - MICRO_ALERT_PRIORITY.indexOf(b.kind));
  return { alerts, views: vs };
}
const liqData = (s: LiqSum) => ({ long_usd: s.long_usd, short_usd: s.short_usd, total_usd: s.total_usd, count: s.count, largest: s.largest });

// ---------------------------------------------------------------- 详情补充(深盘口 / 持仓量 / 资金费 / 数据来源)

const instOf = (symbol: string): string => symbolToInstId(symbol, 'perp');
const pctText = (x: number, digits = 2): string => signedPct(x, digits);
/** 资金费率(小数)→ `+0.0100%` */
const fundingText = (rate: number): string => `${rate >= 0 ? '+' : ''}${(rate * 100).toFixed(4)}%`;
const hhmm = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

export interface MicroExtras { lines: string[]; data: Record<string, unknown>; deep_imbalance: number | null; funding_rate: number | null }
/**
 * 告警 / 摘要详情:±0.5% 深盘口(失衡 + 两侧最大挂单)、持仓量变化、资金费。数据源没有这些可选方法(测试 / 纯录制器)就不写。
 * window_ms = 持仓量变化的回看窗口(告警 15 分钟、摘要 6 小时);窗口短于 1 小时时另写 1 小时变化。
 */
async function extrasFor(deps: ChannelDeps & MicroDeps, cfg: MicroAlertConfig, symbol: string, now: number, window_ms: number): Promise<MicroExtras> {
  const micro = deps.micro, b = baseOf(symbol);
  const out: MicroExtras = { lines: [], data: {}, deep_imbalance: null, funding_rate: null };
  if (!micro) return out;
  const [deep, oi, fr] = await Promise.all([
    micro.deepBook ? safely(deps, `micro deep book ${symbol}`, () => micro.deepBook!(symbol, now), cfg.block_timeout_ms) : null,
    micro.openInterest ? safely(deps, `micro oi ${symbol}`, () => micro.openInterest!(symbol, Math.ceil(Math.max(window_ms, 3_600_000) / 300_000) + 2), cfg.block_timeout_ms) : null,
    micro.funding ? safely(deps, `micro funding ${symbol}`, () => micro.funding!(symbol), cfg.block_timeout_ms) : null,
  ]);
  const ds = deep ? bookStats(deep, { band_pct: cfg.imbalance_band_pct, bucket_pct: cfg.wall_bucket_pct }) : null;
  if (ds && ds.imbalance !== null) {
    const band = ds.visible_pct >= ds.band_pct * 0.8 ? `within ±${(ds.band_pct * 100).toFixed(1)}%` : `within the visible ±${(ds.visible_pct * 100).toFixed(2)}%`;
    const wall = (w: typeof ds.wall_bid, name: string) => w ? `largest ${name} ${usd(w.notional_usd)} @ ${price(w.price)} (${(Math.abs(w.price / ds.mid - 1) * 100).toFixed(2)}% ${name === 'bid' ? 'below' : 'above'} mid)` : null;
    out.lines.push(`${b} order book ${band} (full depth): bids ${usd(ds.bid_depth_usd)} / asks ${usd(ds.ask_depth_usd)} · imbalance ${imbalanceText(ds.imbalance)}${[wall(ds.wall_bid, 'bid'), wall(ds.wall_ask, 'ask')].filter(Boolean).map((x) => ` · ${x}`).join('')}`);
    out.deep_imbalance = ds.imbalance;
    out.data['deep_book'] = { at: deep!.at, mid: ds.mid, band_pct: ds.band_pct, visible_pct: ds.visible_pct, bid_depth_usd: ds.bid_depth_usd, ask_depth_usd: ds.ask_depth_usd, imbalance: ds.imbalance, wall_bid: ds.wall_bid, wall_ask: ds.wall_ask };
  }
  if (oi && oi.history.length >= 2) {
    const at = (ms: number) => { let hit: { at: number; oi_usd: number } | null = null; for (const p of oi.history) if (p.at <= ms) hit = p; return hit; };
    const change = (ms: number) => { const p = at(oi.at - ms); return p && p.oi_usd > 0 ? (oi.oi_usd / p.oi_usd - 1) * 100 : null; };
    const w = change(window_ms), h = window_ms < 3_600_000 ? change(3_600_000) : null;
    const wLabel = window_ms >= 3_600_000 ? `${Math.round(window_ms / 3_600_000)}h` : `${Math.round(window_ms / 60_000)} min`;
    const parts = [w !== null ? `${pctText(w)} over the last ${wLabel}` : null, h !== null ? `${pctText(h)} over 1h` : null].filter(Boolean);
    out.lines.push(`${b} open interest: ${usd(oi.oi_usd)}${parts.length ? `, ${parts.join(', ')}` : ''} (5-min data as of ${asOfLabel(oi.at, now)})`);
    out.data['open_interest'] = { at: oi.at, oi_usd: oi.oi_usd, change_pct_window: w, change_pct_1h: h, window_ms };
  }
  if (fr) {
    out.lines.push(`${b} funding rate: ${fundingText(fr.rate)} for the current period${fr.next_at ? ` (settles ${asOfLabel(fr.next_at, now)})` : ''}`);
    out.funding_rate = fr.rate;
    out.data['funding'] = { rate: fr.rate, next_at: fr.next_at };
  }
  return out;
}

/** 数据来源一句话:录制器 / REST 兜底 / 两者拼接,如实写 */
export function sourceLine(views: readonly SymbolView[], covs: readonly (Pick<MicroCoverage, 'source'> | null | undefined)[] = []): string {
  const rest = new Set<string>();
  for (const v of views) if (v.book?.source === 'okx_rest') rest.add(baseOf(v.symbol));
  const liqRest = covs.some((c) => c?.source === 'okx_rest' || c?.source === 'mixed');
  if (!rest.size && !liqRest) return `Data source: ${MICRO_SOURCE_LABEL} public market data, captured by our order-book and liquidation recorder.`;
  const what = [rest.size ? `order book (${[...rest].join(', ')})` : null, liqRest ? 'liquidations' : null].filter(Boolean).join(' and ');
  return `Data source: ${MICRO_SOURCE_LABEL} public market data; ${what} read directly from the OKX public REST API while our recorder catches up.`;
}

/** 窗口内最大的一段 window_ms 清算(滑动窗口,以每笔为窗口终点) */
export interface LiqBurst { total_usd: number; long_usd: number; short_usd: number; count: number; from: number; to: number }
export function maxLiqBurst(rows: readonly MicroLiq[], window_ms: number): LiqBurst | null {
  const r = [...rows].sort((a, b) => a.at - b.at);
  let best: LiqBurst | null = null, i = 0, total = 0, long = 0;
  for (let j = 0; j < r.length; j++) {
    total += r[j]!.notional_usd; if (r[j]!.side === 'long') long += r[j]!.notional_usd;
    while (r[i]!.at <= r[j]!.at - window_ms) { total -= r[i]!.notional_usd; if (r[i]!.side === 'long') long -= r[i]!.notional_usd; i++; }
    if (!best || total > best.total_usd) best = { total_usd: total, long_usd: long, short_usd: total - long, count: j - i + 1, from: r[j]!.at - window_ms, to: r[j]!.at };
  }
  return best;
}
/** `99% longs` / `62% shorts`(按金额) */
export const dominance = (long: number, short: number): string => {
  const t = long + short;
  if (!(t > 0)) return 'no side dominance';
  return long >= short ? `${Math.round(long / t * 100)}% longs` : `${Math.round(short / t * 100)}% shorts`;
};

// ---------------------------------------------------------------- 盘口失衡采样(静默摘要用;按小时分桶存 state)

interface ImbBucket { h: number; min: number; max: number; n: number; first: number; deep: boolean }
function readImb(deps: ChannelDeps, symbol: string): ImbBucket[] {
  try { const v = JSON.parse(deps.state.get(K.imb(symbol)) ?? '[]'); return Array.isArray(v) ? v as ImbBucket[] : []; } catch { return []; }
}
async function sampleImbalance(deps: ChannelDeps & MicroDeps, cfg: MicroAlertConfig, views: readonly SymbolView[], now: number): Promise<void> {
  const micro = deps.micro;
  if (!micro) return;
  for (const v of views) {
    const last = numState(deps, K.imbAt(v.symbol));
    if (last !== null && now - last < cfg.imb_sample_ms && now >= last) continue;
    const deep = micro.deepBook ? await safely(deps, `micro deep book ${v.symbol}`, () => micro.deepBook!(v.symbol, now), cfg.block_timeout_ms) : null;
    const ds = deep ? bookStats(deep, { band_pct: cfg.imbalance_band_pct }) : null;
    const st = ds && ds.imbalance !== null ? ds : v.stats;
    if (!st || st.imbalance === null) continue;
    const isDeep = st === ds;
    const h = Math.floor(now / 3_600_000) * 3_600_000;
    const list = readImb(deps, v.symbol).filter((x) => x.h > now - 8 * 3_600_000);
    const cur = list.find((x) => x.h === h && x.deep === isDeep);
    if (cur) { cur.min = Math.min(cur.min, st.imbalance); cur.max = Math.max(cur.max, st.imbalance); cur.n++; }
    else list.push({ h, min: st.imbalance, max: st.imbalance, n: 1, first: now, deep: isDeep });
    deps.state.set(K.imb(v.symbol), JSON.stringify(list));
    deps.state.set(K.imbAt(v.symbol), String(now));
  }
}
function imbalanceRange(deps: ChannelDeps, symbol: string, from: number): { min: number; max: number; n: number; since: number; deep: boolean } | null {
  const all = readImb(deps, symbol).filter((x) => x.h + 3_600_000 > from && x.first >= from - 3_600_000);
  // 有深盘口样本就只用深盘口(口径一致),否则用可见盘口
  const deepOnes = all.filter((x) => x.deep), use = deepOnes.length ? deepOnes : all;
  if (!use.length) return null;
  return { min: Math.min(...use.map((x) => x.min)), max: Math.max(...use.map((x) => x.max)), n: use.reduce((a, x) => a + x.n, 0), since: Math.min(...use.map((x) => x.first)), deep: deepOnes.length > 0 };
}

export interface PriceMove { source: 'book_mid' | 'candles_1m' | 'liq_price'; from: { at: number; price: number }; to: { at: number; price: number }; change_pct: number }
/** 退路:窗口内首末笔清算成交价(至少两笔且不同时刻) */
function liqPriceMove(rows: readonly MicroLiq[]): PriceMove | null {
  if (rows.length < 2) return null;
  const a = rows[0]!, z = rows[rows.length - 1]!;
  if (z.at <= a.at || !(a.price > 0)) return null;
  return { source: 'liq_price', from: { at: a.at, price: a.price }, to: { at: z.at, price: z.price }, change_pct: (z.price / a.price - 1) * 100 };
}
/** 清算窗口内价格变化:窗口起点那一帧盘口中间价 → 当前中间价;取不到用首末笔清算价 */
async function windowPriceMove(deps: ChannelDeps & MicroDeps, cfg: MicroAlertConfig, v: SymbolView, now: number, fallback: PriceMove | null): Promise<PriceMove | null> {
  const micro = deps.micro;
  if (micro?.midAt && v.book && v.stats) {
    const start = await safely(deps, `micro midAt ${v.symbol}`, () => micro.midAt!(v.symbol, now - cfg.liq_window_ms), cfg.block_timeout_ms);
    if (start && start.mid > 0 && start.at < v.book.at) return { source: 'book_mid', from: { at: start.at, price: start.mid }, to: { at: v.book.at, price: v.stats.mid }, change_pct: (v.stats.mid / start.mid - 1) * 100 };
  }
  // 录制器没有窗口起点那一帧(断档 / 刚重启):用 OKX 永续 1 分钟 K 线,窗口起点那根的开盘价 → 最新一根的收盘价
  if (micro?.candles) {
    const n = Math.ceil(cfg.liq_window_ms / 60_000) + 3;
    const cs = await safely(deps, `micro candles ${v.symbol}`, () => micro.candles!(v.symbol, '1m', n), cfg.block_timeout_ms);
    const startAt = Math.floor((now - cfg.liq_window_ms) / 60_000) * 60_000;
    const first = cs?.find((c) => c.at >= startAt), last = cs?.[cs.length - 1];
    // 起点那根必须真落在窗口起点附近(K 线条数上限 300,窗口太长时拿不到起点就不用)
    if (first && last && first.at - startAt <= 2 * 60_000 && last.at > first.at && first.open > 0) return { source: 'candles_1m', from: { at: first.at, price: first.open }, to: { at: Math.min(now, last.at + 60_000), price: last.close }, change_pct: (last.close / first.open - 1) * 100 };
  }
  return fallback;
}
export function priceMoveLine(m: PriceMove | null, ref: number): string {
  if (!m) return 'Price change over the window: unavailable (not enough order-book or liquidation prices)';
  const what = m.source === 'book_mid' ? `${MICRO_SOURCE_LABEL} mid` : m.source === 'candles_1m' ? `${MICRO_SOURCE_LABEL} 1-min candles` : 'first/last liquidation fill';
  return `Price over the window (${what}): ${asOfLabel(m.from.at, ref)} ${price(m.from.price)} → ${asOfLabel(m.to.at, ref)} ${price(m.to.price)} (${signedPct(m.change_pct, 2)})`;
}

/** 触发时间桶:宽度 = max(1 分钟, 冷却);两次同类告警至少隔一个冷却,必落在不同桶 */
export const bucketOf = (now: number, cooldown_ms: number): number => { const w = Math.max(60_000, cooldown_ms); return Math.floor(now / w) * w; };

function remember(deps: ChannelDeps, cfg: MicroAlertConfig, r: RecentAlert): void {
  const list = [r, ...readRecent(deps)].slice(0, Math.max(1, cfg.recent_keep));
  deps.state.set(K.recent, JSON.stringify(list));
  deps.state.set(K.lastPush, String(r.at));
}

/** state 里改英文前存下的中文摘要:按 symbol + kind 重写成英文短标签 */
function recentSummary(r: RecentAlert): string {
  if (!CJK.test(r.summary)) return r.summary;
  return r.kind === 'quiet' ? 'Quiet-period summary' : `${baseOf(r.symbol)} ${KIND_LABEL[r.kind] ?? 'alert'}`;
}
const englishRecent = (list: RecentAlert[]): RecentAlert[] => list.map((r) => ({ ...r, summary: recentSummary(r) }));

function recentLines(recent: RecentAlert[], now: number, max = 3): string[] {
  const real = recent.filter((r) => r.kind !== 'quiet').slice(0, max);
  if (!real.length) return ['Recent alerts: none'];
  return ['Recent alerts:', ...real.map((r) => `· ${utcLabel(r.at)} (${Math.max(1, Math.round((now - r.at) / 60_000))} min ago) ${recentSummary(r)}`)];
}

const PAIR_INST = 'BTC-USDT-SWAP, ETH-USDT-SWAP';
/** infoSignal 给正文留的字数(类型头 + ' | ' + 尾巴 ' | Info only, no order | Trading Swarm' 之外) */
const roomFor = (head: string): number => 200 - [...head].length - 3 - [...' | Info only, no order | Trading Swarm'].length;
/** 按片段拼信号正文:放不下的片段整段丢掉(infoSignal 另有截断兜底) */
function fitBody(parts: string[], room = 118): string {
  let out = '';
  for (const p of parts) { const next = out ? `${out}; ${p}` : p; if ([...next].length > room) break; out = next; }
  return out || parts[0] || '';
}

export const microAlertsChannel: SubscriptionChannel<MicroDeps> = {
  key: 'micro_alerts',
  every_ms: MICRO_EVERY_MS,
  async tick(deps) {
    const now = deps.now();
    const cfg = config(deps);
    if (!deps.micro) return null;
    const { alerts, views } = await evaluateMicro(deps, now);
    await sampleImbalance(deps, cfg, views, now);
    for (const a of alerts) {
      const last = numState(deps, K.cooldown(a.symbol, a.kind));
      if (last !== null && now - last < cfg.cooldown_ms && now >= last) continue;
      const event_id = `micro:${a.symbol}:${a.kind}:${bucketOf(now, cfg.cooldown_ms)}`;
      const v = views.find((x) => x.symbol === a.symbol);
      const ex = await extrasFor(deps, cfg, a.symbol, now, a.kind === 'liq_surge' ? cfg.liq_window_ms : 3_600_000);
      const cov = a.kind === 'liq_surge' ? { source: a.data['data_source'] as MicroCoverage['source'] } : null;
      const push = channelPush('micro_alerts', event_id, `Microstructure Alert · ${baseOf(a.symbol)} ${KIND_LABEL[a.kind]} · ${MICRO_SOURCE_LABEL} · ${utcLabel(now)}`, a.headline,
        [...a.lines, ...ex.lines, ...(v ? [`Current order book (${MICRO_SOURCE_LABEL}): ${snapshotLine(v)}`] : []), sourceLine(v ? [v] : [], [cov]), 'Structural observation only, not a trading instruction.'],
        { kind: a.kind, symbol: a.symbol, source: 'okx_swap', at: now, alert: a.data, context: ex.data, book: v ? snapshotData(v) : null });
      push.signal = infoSignal(`【Futures】${instOf(a.symbol)} | ${KIND_LABEL[a.kind]}`, a.signal_body);
      deps.state.set(K.cooldown(a.symbol, a.kind), String(now));
      remember(deps, cfg, { at: now, symbol: a.symbol, kind: a.kind, summary: a.headline, event_id });
      return push;
    }
    // 保活:quiet_ms 内一条都没推 → 静默期摘要。第一次 tick 只起表,不推
    const last = numState(deps, K.lastPush);
    if (last === null) { deps.state.set(K.lastPush, String(now)); return null; }
    if (now - last < cfg.quiet_ms) return null;
    const push = await quietSummary(deps, cfg, now, views);
    // 录制器和 REST 都拿不到数:不推空摘要,下个 tick 再试(保活计时不重置)
    if (!push) return null;
    remember(deps, cfg, { at: now, symbol: 'ALL', kind: 'quiet', summary: push.summary, event_id: push.event_id });
    return push;
  },
  async welcome(deps) {
    const now = deps.now();
    const cfg = config(deps);
    const title = `Microstructure Alerts · Current snapshot · ${MICRO_SOURCE_LABEL} · ${utcLabel(now)}`;
    const event_id = `micro:ALL:welcome:${Math.floor(now / 60_000) * 60_000}`;
    const recent = englishRecent(readRecent(deps));
    const head = `【Futures】${PAIR_INST} | Microstructure snapshot`;
    if (!deps.micro) {
      const p = channelPush('micro_alerts', event_id, title, 'Live data temporarily unreachable', [`The BTC/ETH ${MICRO_SOURCE_LABEL} order-book and liquidation feed is not reachable from our server right now; alerts will start automatically once it is back.`, ...recentLines(recent, now)], { kind: 'welcome', source: 'okx_swap', at: now, books: {}, active: [], recent });
      p.signal = infoSignal(head, 'Subscription active. Live OKX data is reconnecting; alerts start automatically once it is back');
      return p;
    }
    const { alerts, views } = await evaluateMicro(deps, now);
    const anyData = views.some((v) => v.alive);
    const shallow = views.filter((v) => v.alive && !bookDeepEnough(v, cfg));
    const allPaused = shallow.length > 0 && shallow.length === views.filter((v) => v.alive).length;
    // 盘口类告警已暂停的币,别再在「最近告警」里列出暂停前触发的失衡/大墙(否则和「已暂停」自相矛盾)
    const paused = new Set(shallow.map((v) => v.symbol));
    const shownRecent = recent.filter((r) => !(['imbalance', 'wall_bid', 'wall_ask'].includes(r.kind) && paused.has(r.symbol)));
    const extras = await Promise.all(views.map((v) => extrasFor(deps, cfg, v.symbol, now, 3_600_000)));
    const lines = [
      `Current order book (${MICRO_SOURCE_LABEL}):`,
      ...views.map(snapshotLine),
      ...extras.flatMap((e) => e.lines),
      ...(alerts.length ? [`Conditions currently met: ${alerts.map((a) => `${baseOf(a.symbol)} ${KIND_LABEL[a.kind]}`).join(' · ')}`] : []),
      ...recentLines(shownRecent, now),
      `Rules: ${MICRO_SOURCE_LABEL} liquidations ≥ ${cfg.liq_mult}× baseline (with the price change over the window)${allPaused ? '' : `; order-book imbalance |x| ≥ ${cfg.imbalance_abs}; large walls near price`}. ${Math.round(cfg.cooldown_ms / 60_000)}-min cooldown per alert type; a quiet-period summary after ${hoursText(Math.round(cfg.quiet_ms / 3_600_000))} without alerts.`,
      ...(shallow.length ? [`Order-book imbalance and wall alerts paused: ${shallow.map((v) => `${baseOf(v.symbol)} visible book only ±${((v.wide?.visible_pct ?? 0) * 100).toFixed(2)}%`).join(', ')}, below the ±${(cfg.book_min_visible_pct * 100).toFixed(1)}% minimum. They resume once a full-depth book feed is connected.`] : []),
      ...(anyData ? [sourceLine(views)] : []),
    ];
    const summary = anyData ? (alerts.length ? `${plural(alerts.length, 'condition')} currently met` : 'No active alerts') : 'Live data temporarily unreachable';
    const p = channelPush('micro_alerts', event_id, title, summary, lines,
      { kind: 'welcome', source: 'okx_swap', book_alerts_paused: shallow.map((v) => v.symbol), at: now, books: Object.fromEntries(views.map((v) => [v.symbol, snapshotData(v)])), context: Object.fromEntries(views.map((v, i) => [v.symbol, extras[i]!.data])), active: alerts.map((a) => ({ symbol: a.symbol, kind: a.kind, headline: a.headline })), recent: shownRecent });
    const per = views.map((v, i) => {
      const imb = extras[i]!.deep_imbalance ?? v.stats?.imbalance ?? null;
      const f = extras[i]!.funding_rate;
      return v.stats ? `${baseOf(v.symbol)} imbalance ${imbalanceText(imb)}${f !== null ? `, funding ${fundingText(f)}` : ''}` : null;
    }).filter((x): x is string => !!x);
    p.signal = infoSignal(head, fitBody([alerts.length ? `${plural(alerts.length, 'condition')} met` : 'No active alerts', ...per], roomFor(head)));
    return p;
  },
};

async function quietSummary(deps: ChannelDeps & MicroDeps, cfg: MicroAlertConfig, now: number, views: SymbolView[]): Promise<ChannelPush | null> {
  const hrs = Math.round(cfg.quiet_ms / 3_600_000), from = now - cfg.quiet_ms;
  const mins = Math.round(cfg.liq_window_ms / 60_000);
  const micro = deps.micro!;
  const lines: string[] = [`No alerts in the past ${hoursText(hrs)}. What the ${MICRO_SOURCE_LABEL} microstructure did in that window:`];
  const liqs: Record<string, ReturnType<typeof liqData> | null> = {};
  const ctx: Record<string, Record<string, unknown>> = {};
  const covs: (MicroCoverage | null)[] = [];
  const sig: string[] = [], sigShort: string[] = [];
  const brief: string[] = [];
  let anyData = views.some((v) => v.alive);
  for (const v of views) {
    const b = baseOf(v.symbol);
    const c: Record<string, unknown> = {};
    lines.push(snapshotLine(v));
    // 6h 价格:15 分钟 K 线
    let chg: number | null = null;
    if (micro.candles) {
      const cs = await safely(deps, `micro candles ${v.symbol}`, () => micro.candles!(v.symbol, '15m', Math.ceil(cfg.quiet_ms / 900_000) + 2), cfg.block_timeout_ms);
      const win = (cs ?? []).filter((x) => x.at >= Math.floor(from / 900_000) * 900_000);
      if (win.length >= 2) {
        const hi = Math.max(...win.map((x) => x.high)), lo = Math.min(...win.map((x) => x.low));
        chg = (win[win.length - 1]!.close / win[0]!.open - 1) * 100;
        lines.push(`${b} price, last ${hoursText(hrs)}: ${price(win[0]!.open)} → ${price(win[win.length - 1]!.close)} (${signedPct(chg, 2)}), range ${price(lo)}–${price(hi)} (${((hi / lo - 1) * 100).toFixed(2)}%)`);
        c['price'] = { from: win[0]!.open, to: win[win.length - 1]!.close, change_pct: chg, high: hi, low: lo };
      }
    }
    // 6h 清算 + 最大 15 分钟爆发(对照告警门槛)
    const cov = await safely(deps, `micro coverage ${v.symbol}`, () => micro.coverage(v.symbol, now), cfg.block_timeout_ms);
    covs.push(cov);
    const rows = cov ? await safely(deps, `micro liq ${v.symbol}`, () => micro.liquidations(v.symbol, from, now), cfg.block_timeout_ms) : null;
    let burstUsd: number | null = null;
    if (!rows || !cov) {
      liqs[v.symbol] = null;
      lines.push(`${b} liquidations, last ${hoursText(hrs)}: temporarily unavailable`);
    } else {
      anyData = true;
      const s = sumLiquidations(rows);
      liqs[v.symbol] = liqData(s);
      const partial = cov.from_ms > from ? ` (data covers only the last ${Math.max(0, (now - cov.from_ms) / 3_600_000).toFixed(1)}h)` : '';
      lines.push(`${b} liquidations, last ${hoursText(hrs)}${partial}: longs ${usd(s.long_usd)} / shorts ${usd(s.short_usd)} · ${plural(s.count, 'liquidation')}${s.largest ? ` · largest: ${s.largest.side === 'long' ? 'long' : 'short'} ${usd(s.largest.notional_usd)} @ ${price(s.largest.price)}` : ''}`);
      const burst = maxLiqBurst(rows, cfg.liq_window_ms);
      const span = Math.max(cfg.liq_window_ms, now - Math.max(from, cov.from_ms));
      const avg = s.total_usd * cfg.liq_window_ms / span;
      if (burst && burst.total_usd > 0) {
        burstUsd = burst.total_usd;
        const x = avg > 0 ? burst.total_usd / avg : null;
        lines.push(`${b} largest ${mins}-min liquidation burst: ${usd(burst.total_usd)} (${new Date(burst.from).toISOString().slice(11, 16)}–${hhmm(burst.to)}, ${dominance(burst.long_usd, burst.short_usd)})${x !== null ? `, ${x.toFixed(1)}× the ${hoursText(hrs)} ${mins}-min average` : ''}; an alert needs ≥ ${usd(pick(cfg.liq_floor_usd, v.symbol))} and ≥ ${cfg.liq_mult}× baseline`);
        c['max_burst'] = { ...burst, ratio_vs_avg: x };
      } else {
        burstUsd = 0;
        lines.push(`${b} largest ${mins}-min liquidation burst: none (no liquidations in the window)`);
      }
    }
    // 盘口失衡区间(频道每 10 分钟采样)
    const ir = imbalanceRange(deps, v.symbol, from);
    const ex = await extrasFor(deps, cfg, v.symbol, now, cfg.quiet_ms);
    if (ir) {
      const partial = ir.since > from + 30 * 60_000 ? `, sampled since ${asOfLabel(ir.since, now)}` : '';
      lines.push(`${b} order-book imbalance ${ir.deep ? `within ±${(cfg.imbalance_band_pct * 100).toFixed(1)}%` : 'on the visible book'} over the window: ${imbalanceText(ir.min)} to ${imbalanceText(ir.max)} (${plural(ir.n, 'sample')}${partial})`);
      c['imbalance_range'] = ir;
    }
    lines.push(...ex.lines);
    if (ex.lines.length || v.alive) anyData = true;
    Object.assign(c, ex.data);
    ctx[v.symbol] = c;
    const chg1 = chg !== null ? signedPct(Math.abs(chg) < 0.05 ? 0 : chg, 1) : null;
    const bp = [chg1, burstUsd !== null ? `max ${mins}-min liquidations ${usd(burstUsd)}` : null].filter(Boolean);
    brief.push(`${b} ${bp.length ? bp.join(', ') : 'data partial'}`);
    const sp = [chg1, burstUsd !== null ? `max ${mins}m liq ${usd(burstUsd)}` : null, ex.funding_rate !== null ? `funding ${fundingText(ex.funding_rate)}` : null].filter(Boolean);
    sig.push(`${b} ${sp.join(', ')}`.trim());
    sigShort.push(`${b} ${sp.slice(0, 2).join(', ')}`.trim());
  }
  if (!anyData) { deps.log('warn', 'micro_alerts 静默摘要:录制器与 OKX REST 都没数据,跳过本次'); return null; }
  lines.push(...recentLines(readRecent(deps), now));
  lines.push(sourceLine(views, covs));
  const summary = `No alerts in the past ${hoursText(hrs)}: ${brief.join('; ')}`;
  if (BANNED_WORDS.test(summary)) throw new Error('micro_alerts_banned_words');
  const p = channelPush('micro_alerts', `micro:ALL:quiet:${bucketOf(now, cfg.quiet_ms)}`, `Microstructure Quiet-Period Summary · ${utcLabel(now)}`, summary, lines,
    { kind: 'quiet', source: 'okx_swap', at: now, quiet_ms: cfg.quiet_ms, books: Object.fromEntries(views.map((v) => [v.symbol, snapshotData(v)])), liquidations: liqs, context: ctx });
  const head = `【Futures】${PAIR_INST} | Quiet ${hoursText(hrs)}`, room = roomFor(head);
  const full = [`No liquidation spike in ${hoursText(hrs)}`, ...sig].join('; ');
  p.signal = infoSignal(head, [...full].length <= room ? full : fitBody([`No liquidation spike in ${hoursText(hrs)}`, ...sigShort], room));
  return p;
}
