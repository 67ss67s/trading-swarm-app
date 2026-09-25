/**
 * 推荐资产(§9.53 A,对话工具 recommend_assets):资产 × 短/中/长 → 适不适合、方向、建议策略族、证据。
 *
 * 全部代码计算、零模型:数字只来自 OKX 全集快照(成交额/上市时间)、每日全市场扫描(名次/分数)、
 * 日线 regime(runtime.dailyRegimeFor)与可选的盘口深度。模型拿到结果后只负责挑与说,不产出数字。
 *
 * 短线档只对高流动性永续开放(小市值山寨短线扣完费用和滑点基本必负,也没有可靠盘口);
 * 长线档要求上市满一年,否则日线历史不够做三段切分。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { FamilyKey } from './research/batch/families.js';
import type { DailyRegime, DailyRegimeKind } from './types.js';
import type { UniverseAsset, UniverseScanSummary } from './universe-okx.js';

export type Horizon = 'short' | 'mid' | 'long';
export const HORIZONS: readonly Horizon[] = ['short', 'mid', 'long'];
export const HORIZON_TIMEFRAMES: Record<Horizon, string[]> = { short: ['3m', '5m', '15m'], mid: ['1h', '4h'], long: ['12h', '1d'] };
export const HORIZON_LABEL: Record<Horizon, string> = { short: '短线', mid: '中线', long: '长线' };

export const SHORT_MIN_QUOTE_VOL_USD = 300_000_000;
export const SHORT_MIN_DEPTH_USD = 2_000_000;
export const MID_MIN_QUOTE_VOL_USD = 5_000_000;
export const LONG_MIN_QUOTE_VOL_USD = 1_000_000;
export const LONG_MIN_LISTED_DAYS = 365;
const DAY = 86_400_000;

type Direction = 'long' | 'short' | 'both';
export interface HorizonFit { eligible: boolean; reason: string | null; direction: Direction | null; families: FamilyKey[]; evidence: string[] }
export interface RecommendationRow {
  symbol: string;
  market: 'spot' | 'perp';
  quote_vol_24h: number | null;
  depth_usd_05: number | null;
  regime: DailyRegimeKind | null;
  scan: { rank: number; score: number; reasons: string[] } | null;
  /** 雷达三档漏斗里的名次:短线 ← short 档,中线 ← swing 档,长线 ← weekly 档 */
  radar: Partial<Record<Horizon, { rank: number; fit: number; reasons: string[] }>>;
  horizons: Record<Horizon, HorizonFit>;
}
export interface AssetRecommendation {
  id: string;
  as_of: number;
  source: { universe_scan_at: number | null; regime_at: number | null; radar_at: Partial<Record<Horizon, number>> };
  rows: RecommendationRow[];
  warnings: string[];
}

export interface RecommendDeps {
  now(): number;
  universe(): { updated_at: number | null; items: UniverseAsset[] } | null;
  scan(limit: number): UniverseScanSummary;
  regime(symbol: string): Promise<DailyRegime | null>;
  /** 雷达某档最新一轮的候选(已排好名次);没跑过返回 null */
  radar?(tier: RadarTier): { at: number; candidates: { symbol: string; rank: number; fit_score: number; reasons: string[] }[] } | null;
  /** 近价 ±0.5% 双边挂单名义额(USDT);取不到返回 null,短线档退回只看成交额 */
  depth?(symbol: string): Promise<number | null>;
  id(): string;
}
export type RadarTier = 'short' | 'swing' | 'weekly';
/** 周期档 ↔ 雷达档:雷达的短线/波段/周线漏斗就是短/中/长线的信息来源 */
export const HORIZON_RADAR_TIER: Record<Horizon, RadarTier> = { short: 'short', mid: 'swing', long: 'weekly' };
export const RADAR_TIER_TEXT: Record<RadarTier, string> = { short: '雷达短线档', swing: '雷达波段档', weekly: '雷达周线档' };
/** 雷达各档的刷新节奏(radar.ts 错峰定时:短线 12h / 中线 72h / 周线 7d) */
export const RADAR_TIER_EVERY_MS: Record<RadarTier, number> = { short: 12 * 3_600_000, swing: 72 * 3_600_000, weekly: 7 * DAY };
const ago = (ms: number): string => (ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} 分钟前` : ms < DAY ? `${Math.round(ms / 3_600_000)} 小时前` : `${Math.round(ms / DAY)} 天前`);
export interface RecommendArgs { symbols?: string[]; top_n?: number; horizons?: Horizon[]; market?: 'spot' | 'perp' }

/** 按日线状态给方向与策略族。现货不能做空:空头行情下现货档写成不适合而不是换族。 */
export function familiesFor(regime: DailyRegimeKind | null, horizon: Horizon, market: 'spot' | 'perp'): { direction: Direction | null; families: FamilyKey[]; note: string | null } {
  const trend: FamilyKey[] = horizon === 'short' ? ['breakout', 'ema_cross'] : ['breakout', 'ma_trend', 'ema_cross', 'pullback'];
  switch (regime) {
    case 'bull': return { direction: 'long', families: trend, note: null };
    case 'bear': return market === 'spot' ? { direction: null, families: [], note: '日线空头,现货只能做多' } : { direction: 'short', families: trend, note: null };
    case 'range': return { direction: market === 'spot' ? 'long' : 'both', families: horizon === 'long' ? ['mean_reversion'] : ['mean_reversion', 'smc'], note: null };
    case 'volatile': return horizon === 'long' ? { direction: market === 'spot' ? 'long' : 'both', families: ['breakout'], note: null } : { direction: null, families: [], note: '日线高波动,中短线假突破多,先不做' };
    default: return { direction: market === 'spot' ? 'long' : 'both', families: [...trend.slice(0, 2), 'mean_reversion'], note: '日线状态未知,族按趋势 + 回归各给一类' };
  }
}

/** 订单簿 → 近价 ±pct 双边名义额(USDT)。books 为 [price, size(币)] 字符串对;合约张数换算由调用方先做。 */
export function depthWithin(bids: [string, string][], asks: [string, string][], pct: number): number | null {
  const bb = Number(bids[0]?.[0]), ba = Number(asks[0]?.[0]);
  if (!(bb > 0) || !(ba > 0)) return null;
  const mid = (bb + ba) / 2, lo = mid * (1 - pct), hi = mid * (1 + pct);
  let sum = 0;
  for (const [p, s] of bids) { const px = Number(p); if (px < lo) break; sum += px * Number(s); }
  for (const [p, s] of asks) { const px = Number(p); if (px > hi) break; sum += px * Number(s); }
  return sum;
}

const num = (s: string | null | undefined): number | null => { const v = s == null ? NaN : Number(s); return Number.isFinite(v) ? v : null; };
const usd = (v: number): string => v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1e3)}K`;
const REGIME_TEXT: Record<DailyRegimeKind, string> = { bull: '多头', bear: '空头', range: '震荡', volatile: '高波动' };

function horizonFit(h: Horizon, a: UniverseAsset | null, market: 'spot' | 'perp', vol: number | null, depth: number | null, reg: DailyRegime | null, now: number): HorizonFit {
  const out = (eligible: boolean, reason: string | null, evidence: string[], f?: ReturnType<typeof familiesFor>): HorizonFit =>
    ({ eligible, reason, direction: eligible ? f?.direction ?? null : null, families: eligible ? f?.families ?? [] : [], evidence });
  const ev: string[] = [];
  if (vol !== null) ev.push(`24h ${market === 'perp' ? '永续' : '现货'}成交额 ${usd(vol)}`);
  if (!a) return out(false, 'unknown_asset', ['OKX 全集里没有这个币(或全集还没刷新)']);
  if (a.excluded) return out(false, 'excluded', [`全集排除:${a.excluded_reason ?? '稳定币/包装币'}`]);
  if (market === 'perp' && !a.perp_inst_id) return out(false, 'no_market', ['OKX 没有该币的 USDT 永续']);
  if (market === 'spot' && !a.spot_inst_id) return out(false, 'no_market', ['OKX 没有该币的 USDT 现货']);
  if (h === 'short') {
    if (market !== 'perp') return out(false, 'liquidity', ['短线只做高流动性永续']);
    if (vol === null || vol < SHORT_MIN_QUOTE_VOL_USD) return out(false, 'liquidity', [...ev, `短线要求永续成交额 ≥ ${usd(SHORT_MIN_QUOTE_VOL_USD)}(小市值短线扣费后基本必负)`]);
    if (depth !== null) {
      ev.push(`近价 ±0.5% 挂单 ${usd(depth)}`);
      if (depth < SHORT_MIN_DEPTH_USD) return out(false, 'liquidity', [...ev, `短线要求 ±0.5% 深度 ≥ ${usd(SHORT_MIN_DEPTH_USD)}`]);
    }
  } else if (h === 'mid') {
    if (vol === null || vol < MID_MIN_QUOTE_VOL_USD) return out(false, 'liquidity', [...ev, `中线要求成交额 ≥ ${usd(MID_MIN_QUOTE_VOL_USD)}`]);
  } else {
    if (vol === null || vol < LONG_MIN_QUOTE_VOL_USD) return out(false, 'liquidity', [...ev, `长线要求成交额 ≥ ${usd(LONG_MIN_QUOTE_VOL_USD)}`]);
    if (a.listed_at !== null && now - a.listed_at < LONG_MIN_LISTED_DAYS * DAY) return out(false, 'history', [...ev, `上市 ${Math.floor((now - a.listed_at) / DAY)} 天,日线历史不够切训练/验证/留出`]);
  }
  if (reg) ev.push(`日线${REGIME_TEXT[reg.regime]}(${reg.ema_stack},20 日 ${reg.ret_20d_pct.toFixed(1)}%)`);
  const f = familiesFor(reg?.regime ?? null, h, market);
  if (f.note) ev.push(f.note);
  if (!f.families.length) return out(false, 'regime', ev);
  return out(true, null, ev, f);
}

/** 推荐主函数。symbols 为空时取每日全市场扫描前 top_n(缺省 8,上限 12)。 */
export async function recommendAssets(deps: RecommendDeps, args: RecommendArgs = {}): Promise<AssetRecommendation> {
  const now = deps.now(), market = args.market ?? 'perp', warnings: string[] = [];
  const horizons = (args.horizons?.length ? args.horizons : HORIZONS).filter((h) => HORIZONS.includes(h));
  const uni = deps.universe();
  if (!uni?.items.length) warnings.push('OKX 全集快照还没有(每日 UTC 00:10 刷新),成交额与上市时间缺失');
  const bySymbol = new Map((uni?.items ?? []).map((a) => [a.symbol, a]));
  const topN = Math.min(12, Math.max(1, Math.floor(args.top_n ?? 8)));
  const scan = deps.scan(Math.max(topN, 50));
  if (!scan.ready) warnings.push(scan.note ?? '还没有每日全市场扫描');
  const scanBy = new Map(scan.candidates.map((c) => [c.symbol, c]));
  const norm = (s: string): string => { const u = s.trim().toUpperCase().replace(/[-_/]/g, '').replace(/SWAP$/, ''); return u.endsWith('USDT') ? u : `${u}USDT`; };
  const radar: Partial<Record<Horizon, ReturnType<NonNullable<RecommendDeps['radar']>>>> = {};
  for (const h of horizons) radar[h] = deps.radar?.(HORIZON_RADAR_TIER[h]) ?? null;
  const radarAt: Partial<Record<Horizon, number>> = {};
  for (const h of horizons) if (radar[h]) radarAt[h] = radar[h]!.at;
  if (deps.radar && horizons.every((h) => !radar[h])) warnings.push('雷达三档还没跑过,短/中/长线只按全市场扫描与日线状态推荐');
  // 各档按自己的节奏刷新(短 12h / 波段 72h / 周线 7d):超过两倍周期才算过期
  for (const h of horizons) {
    const at = radar[h]?.at;
    if (at && now - at > 2 * RADAR_TIER_EVERY_MS[HORIZON_RADAR_TIER[h]]) warnings.push(`${RADAR_TIER_TEXT[HORIZON_RADAR_TIER[h]]}的结果是 ${ago(now - at)}的,已过期,${HORIZON_LABEL[h]}推荐参考价值下降`);
  }
  // 不指定币:全市场扫描前 top_n ∪ 每档雷达前 3(雷达是短/中/长线各自的信息来源,排在前面)
  const fromRadar = horizons.flatMap((h) => radar[h]?.candidates.slice(0, 3).map((c) => c.symbol) ?? []);
  const symbols = [...new Set((args.symbols?.length ? args.symbols.map(norm) : [...fromRadar, ...scan.candidates.slice(0, topN).map((c) => c.symbol)]))].slice(0, 12);
  if (!symbols.length) warnings.push('没有可推荐的币:没给 symbols,且扫描结果为空');
  let regimeAt: number | null = null;
  const rows: RecommendationRow[] = [];
  for (const symbol of symbols) {
    const a = bySymbol.get(symbol) ?? null;
    const vol = a ? num(market === 'perp' ? a.perp_quote_volume_24h : a.spot_quote_volume_24h) : null;
    const reg = await deps.regime(symbol).catch(() => null);
    if (reg) regimeAt = Math.max(regimeAt ?? 0, reg.as_of);
    const wantDepth = horizons.includes('short') && market === 'perp' && vol !== null && vol >= SHORT_MIN_QUOTE_VOL_USD;
    const depth = wantDepth && deps.depth ? await deps.depth(symbol).catch(() => null) : null;
    const sc = scanBy.get(symbol);
    const fits = Object.fromEntries(HORIZONS.map((h) => [h, horizons.includes(h)
      ? horizonFit(h, a, market, vol, depth, reg, now)
      : { eligible: false, reason: 'not_requested', direction: null, families: [], evidence: [] }])) as Record<Horizon, HorizonFit>;
    if (sc) for (const h of horizons) if (fits[h].eligible) fits[h].evidence.push(`全市场扫描第 ${sc.rank} 名(分 ${sc.score.toFixed(2)})`);
    const rr: RecommendationRow['radar'] = {};
    for (const h of horizons) {
      const c = radar[h]?.candidates.find((x) => x.symbol === symbol);
      if (!c) continue;
      rr[h] = { rank: c.rank, fit: c.fit_score, reasons: c.reasons.slice(0, 2) };
      if (fits[h].eligible) fits[h].evidence.unshift(`${RADAR_TIER_TEXT[HORIZON_RADAR_TIER[h]]}第 ${c.rank} 名(适配 ${c.fit_score.toFixed(2)},${ago(now - radar[h]!.at)})`);
    }
    rows.push({ symbol, market, quote_vol_24h: vol, depth_usd_05: depth, regime: reg?.regime ?? null, scan: sc ? { rank: sc.rank, score: sc.score, reasons: sc.reasons.slice(0, 2) } : null, radar: rr, horizons: fits });
  }
  return { id: deps.id(), as_of: now, source: { universe_scan_at: scan.at, regime_at: regimeAt, radar_at: radarAt }, rows, warnings };
}

// ---------------------------------------------------------------- 落库(对话消息里只放 id,推荐卡按 id 取)

export class RecommendationStore {
  constructor(private readonly db: DatabaseSync) {}
  put(r: AssetRecommendation): void {
    this.db.prepare('INSERT OR REPLACE INTO asset_recommendations(id, created_at, body_json) VALUES (?,?,?)').run(r.id, r.as_of, JSON.stringify(r));
  }
  get(id: string): AssetRecommendation | null {
    const row = this.db.prepare('SELECT body_json FROM asset_recommendations WHERE id = ?').get(id) as { body_json: string } | undefined;
    return row ? JSON.parse(row.body_json) as AssetRecommendation : null;
  }
}

/** 给对话模型看的精简版(工具结果只回前 4000 字给模型);完整结果按 id 从 GET /api/recommendations/:id 取,前端渲染推荐卡。 */
export function recommendationSummary(r: AssetRecommendation): Record<string, unknown> {
  return {
    recommendation_id: r.id,
    card: '界面已渲染推荐卡(含「去研究台验证」按钮),回复里不要重复整张表,挑重点说',
    warnings: r.warnings,
    rows: r.rows.map((x) => ({
      symbol: x.symbol,
      regime: x.regime,
      vol_24h: x.quote_vol_24h === null ? null : usd(x.quote_vol_24h),
      scan_rank: x.scan?.rank ?? null,
      radar: Object.fromEntries(Object.entries(x.radar).map(([h, v]) => [h, v!.rank])),
      horizons: Object.fromEntries(HORIZONS.filter((h) => x.horizons[h].reason !== 'not_requested').map((h) => {
        const f = x.horizons[h];
        return [h, f.eligible ? { ok: true, dir: f.direction, families: f.families, why: f.evidence.slice(0, 3) } : { ok: false, reason: f.reason, why: f.evidence.slice(-1) }];
      })),
    })),
  };
}
