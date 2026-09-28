/**
 * 服务一「资产 × 周期推荐」:把 §9.53 A 的 recommend()(代码计算、零模型)包成按次服务。
 * 输入(全可选):symbols ≤12、horizons short|mid|long、market spot|perp、top_n 1–12。都不给 = 全市场扫描 + 雷达三档。
 *
 * 服务层在 recommend() 结果上再做三件事(不改 recommend.ts):
 *   1. 只留 OKX 可交易的加密资产:股票代币 / 杠杆 ETF 黑名单恒生效;注入了 tradable(symbol, market) 时再按 OKX 全集快照剔除;
 *   2. 日线状态取不到的币重试一次,仍取不到就判不合格(regime_unavailable),不再给方向;取到了按同一套 familiesFor 重算方向与策略族;
 *   3. 按强弱排序(雷达名次 / 全市场扫描名次取较好者,再比成交额),正文英文(OKX.AI 国际买方)、只给分析与依据。
 */
import { familiesFor, HORIZON_RADAR_TIER, HORIZONS, LONG_MIN_LISTED_DAYS, LONG_MIN_QUOTE_VOL_USD, MID_MIN_QUOTE_VOL_USD, SHORT_MIN_DEPTH_USD, SHORT_MIN_QUOTE_VOL_USD, type AssetRecommendation, type Horizon as RecHorizon, type HorizonFit, type RecommendationRow } from '../../recommend.js';
import type { DailyRegime } from '../../types.js';
import { freeText, horizonsIn, jsonParams, marketIn, symbolList, symbolsIn } from './params.js';
import { deliverable } from './render.js';
import { englishEvidence } from './radar-feed.js';
import { ServiceInputError, type PerCallService, type ServiceDeps } from './types.js';

export interface AssetHorizonParams { symbols?: string[]; horizons?: RecHorizon[]; market: 'spot' | 'perp'; top_n: number }
/** 可选依赖:OKX 全集快照里有对应 instId 且未排除才 true(运行时由 index.ts serviceDeps 接好) */
export interface AssetHorizonDeps extends ServiceDeps { tradable?(symbol: string, market: 'spot' | 'perp'): boolean }

/**
 * 股票代币 / 杠杆与反向 ETF 代币(基础币名)。这些标的的日线状态、上市时长与加密资产口径不一致,且买方问的是币,
 * 不论交易所是否挂了对应永续都不进推荐。新增时只加明确的股票/ETF 代码,别加会和加密币重名的代码(STX/DIA/CVX 等是加密币,不在表里)。
 */
export const STOCK_LIKE_BASES: ReadonlySet<string> = new Set([
  // 杠杆 / 反向 ETF
  'SOXS', 'SOXL', 'TQQQ', 'SQQQ', 'SPXL', 'SPXS', 'UPRO', 'SPXU', 'TNA', 'TZA', 'LABU', 'LABD', 'FNGU', 'FNGD', 'UVXY', 'SVXY', 'TSLL', 'TSLQ', 'NVDL', 'NVDX', 'CONL', 'MSTU', 'MSTX', 'BITX',
  // 指数 / 商品 ETF
  'SPY', 'QQQ', 'IWM', 'VOO', 'VTI', 'GLD', 'SLV', 'USO', 'TLT', 'ARKK', 'SMH', 'SOXX', 'IBIT', 'FBTC', 'ETHA',
  // 美股
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'GOOG', 'AMZN', 'META', 'TSLA', 'NFLX', 'AMD', 'INTC', 'MU', 'SNDK', 'WDC', 'AVGO', 'TSM', 'QCOM', 'TXN', 'ARM', 'SMCI', 'ORCL', 'IBM', 'CRM', 'ADBE',
  'PLTR', 'COIN', 'MSTR', 'HOOD', 'CRCL', 'SBET', 'BMNR', 'GLXY', 'RIOT', 'MARA', 'CLSK', 'CRWV', 'NBIS', 'RDDT', 'SHOP', 'SNOW', 'UBER', 'ABNB', 'PYPL', 'SQ',
  'BABA', 'PDD', 'JD', 'BIDU', 'NIO', 'RIVN', 'LCID', 'GME', 'AMC', 'DIS', 'JPM', 'GS', 'BAC', 'WMT', 'COST', 'KO', 'MCD', 'NKE', 'LLY', 'UNH', 'JNJ', 'PFE', 'XOM', 'BRKB',
]);
/** 股票代币 / 杠杆 ETF / 杠杆代币(BTC3L、ETH3S 之类) */
export function stockLike(symbol: string): boolean {
  const base = symbol.toUpperCase().replace(/USDT$/, '');
  return STOCK_LIKE_BASES.has(base) || /^[A-Z]{2,}[235][LS]$/.test(base);
}

/** 策略族英文名(交付正文用;market-brief 有自己的一份) */
export const FAMILY_TEXT: Record<string, string> = { breakout: 'Channel breakout', ma_trend: 'MA trend', ema_cross: 'EMA crossover', pullback: 'MA pullback', mean_reversion: 'Mean reversion', smc: 'SMC structure break', xsmom: 'Cross-sectional momentum', carry: 'Funding carry' };
const REGIME_TEXT: Record<string, string> = { bull: 'Daily uptrend', bear: 'Daily downtrend', range: 'Daily range', volatile: 'Daily high volatility' };
const DIR_TEXT: Record<string, string> = { long: 'Long bias', short: 'Short bias', both: 'Both directions' };
const MARKET_TEXT: Record<'spot' | 'perp', string> = { spot: 'spot', perp: 'USDT perpetual' };
export const HORIZON_TEXT: Record<RecHorizon, string> = { short: 'Short-term', mid: 'Mid-term', long: 'Long-term' };
/** 雷达三档(与 recommend.ts RADAR_TIER_TEXT 同一套档位,英文) */
const RADAR_TEXT: Record<string, string> = { short: 'Radar short tier', swing: 'Radar swing tier', weekly: 'Radar weekly tier' };
const radarTier = (h: RecHorizon): string => RADAR_TEXT[HORIZON_RADAR_TIER[h]] ?? HORIZON_RADAR_TIER[h];
/** 周期含义(与 recommend.ts HORIZON_TIMEFRAMES 同口径) */
export const HORIZON_MEANING: Record<RecHorizon, string> = { short: 'Short-term ≈ 15m bars, held hours to 1 day', mid: 'Mid-term ≈ 1h/4h bars, held days to weeks', long: 'Long-term ≈ daily bars, held weeks to months' };
const HORIZON_MIN_VOL: Record<RecHorizon, number> = { short: SHORT_MIN_QUOTE_VOL_USD, mid: MID_MIN_QUOTE_VOL_USD, long: LONG_MIN_QUOTE_VOL_USD };
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

/** 成交额:7.83B / 911.2M / 530K */
export const usdAbbr = (v: number | null | undefined): string => v === null || v === undefined || !Number.isFinite(v) ? '—' : v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}K` : v.toFixed(0);
const utc = (t: number, withTime = true): string => { const s = new Date(t).toISOString(); return withTime ? `${s.slice(5, 10)} ${s.slice(11, 16)} UTC` : s.slice(5, 10); };

/** 不合格原因 → 英文(流动性按行里的成交额/深度与 recommend.ts 同一组门槛重写,不引用中文证据) */
export function reasonText(f: HorizonFit, h: RecHorizon, row: { regime: string | null; quote_vol_24h?: number | null; depth_usd_05?: number | null }, market: 'spot' | 'perp'): string {
  switch (f.reason) {
    case 'history': return 'Listed for less than 1 year; not enough daily history for long-term validation';
    case 'regime':
      if (row.regime === 'volatile') return 'High daily volatility; frequent false breakouts on shorter horizons, excluded for now';
      if (row.regime === 'bear' && market === 'spot') return 'Daily downtrend and spot is long-only; excluded for now';
      return 'Daily regime does not fit the strategy families for this horizon';
    case 'regime_unavailable': return 'Daily regime unknown (still unavailable after one retry); no direction given';
    case 'liquidity': {
      const vol = row.quote_vol_24h ?? null, depth = row.depth_usd_05 ?? null;
      if (h === 'short' && market !== 'perp') return 'Short-term covers liquid USDT perpetuals only';
      if (vol === null || vol < HORIZON_MIN_VOL[h]) return `24h volume ${usdAbbr(vol)} is below the ${HORIZON_TEXT[h].toLowerCase()} minimum of ${usdAbbr(HORIZON_MIN_VOL[h])}`;
      if (h === 'short' && depth !== null && depth < SHORT_MIN_DEPTH_USD) return `Order book depth within ±0.5% (${usdAbbr(depth)}) is below the short-term minimum of ${usdAbbr(SHORT_MIN_DEPTH_USD)}`;
      return `Liquidity below the ${HORIZON_TEXT[h].toLowerCase()} threshold`;
    }
    case 'unknown_asset': return 'Not found in the OKX instrument universe';
    case 'excluded': return 'Stablecoin or wrapped token; out of scope';
    case 'no_market': return `OKX has no ${MARKET_TEXT[market]} market for this coin`;
    case 'not_tradable': return `No tradable ${MARKET_TEXT[market]} on OKX right now`;
    case 'stock_like': return 'Stock token or leveraged ETF; outside the crypto asset scope';
    case 'not_requested': return 'Not requested';
    default: return f.reason ? `Not eligible (${f.reason})` : 'Not eligible';
  }
}

/** recommend() 的中文提示 → 英文(已知几类按原意改写;认不出的中文提示只留在 JSON 的 warnings 里) */
export function warningText(w: string): string {
  if (!CJK.test(w)) return w;
  if (/OKX 全集快照还没有/.test(w)) return 'OKX instrument snapshot not available yet (refreshed daily at 00:10 UTC); volume and listing dates are missing';
  if (/雷达三档还没跑过/.test(w)) return 'Radar tiers have not run yet; horizons rely on the market scan and daily regime only';
  const stale = /^(雷达短线档|雷达波段档|雷达周线档)的结果.*已过期/.exec(w);
  if (stale) { const tier = { 雷达短线档: 'short', 雷达波段档: 'swing', 雷达周线档: 'weekly' }[stale[1] as '雷达短线档']; return `${RADAR_TEXT[tier] ?? 'Radar'} results are stale; lower reference value for that horizon`; }
  if (/没有可推荐的币/.test(w)) return 'No eligible coins: no symbols were given and the market scan is empty';
  if (/全市场扫描|扫描/.test(w)) return 'Daily market scan not available yet';
  return 'Data-source note (see warnings in the JSON)';
}

/** 强弱键:雷达该档名次与全市场扫描名次取较好者,其次成交额大者在前 */
function strength(r: RecommendationRow, h: RecHorizon): [number, number] {
  return [Math.min(r.radar[h]?.rank ?? Infinity, r.scan?.rank ?? Infinity), -(r.quote_vol_24h ?? 0)];
}
const cmp = (a: [number, number], b: [number, number]): number => (a[0] - b[0]) || (a[1] - b[1]);

/** 日线状态缺失的行:重试一次;取到了按 familiesFor 重算原本只因「状态未知」才合格的档,仍取不到就判不合格 */
async function refreshRegime(row: RecommendationRow, horizons: readonly RecHorizon[], market: 'spot' | 'perp', deps: ServiceDeps, seen?: Map<string, DailyRegime | null>): Promise<RecommendationRow> {
  const reg: DailyRegime | null = await deps.regime(row.symbol).catch(() => null);
  seen?.set(row.symbol, reg);
  const fits = { ...row.horizons };
  for (const h of horizons) {
    const f = fits[h];
    if (!f.eligible) continue; // 流动性 / 上市时长等门槛没过的,原因不变
    const ev = f.evidence.filter((e) => !/日线状态未知/.test(e));
    if (!reg) { fits[h] = { eligible: false, reason: 'regime_unavailable', direction: null, families: [], evidence: [...ev, 'Daily regime unknown (still unavailable after one retry)'] }; continue; }
    const fam = familiesFor(reg.regime, h, market);
    const regEv = `${REGIME_TEXT[reg.regime] ?? reg.regime} (${reg.ema_stack}, 20d ${reg.ret_20d_pct.toFixed(1)}%)`;
    fits[h] = fam.families.length
      ? { eligible: true, reason: null, direction: fam.direction, families: fam.families, evidence: [...ev, regEv] }
      : { eligible: false, reason: 'regime', direction: null, families: [], evidence: [...ev, regEv, ...(fam.note ? [fam.note] : [])] };
  }
  return { ...row, regime: reg?.regime ?? null, horizons: fits };
}

/** 过滤 + 日线补取 + 排序;纯服务层,输入是 recommend() 的原样结果 */
export async function refineRecommendation(rec: AssetRecommendation, horizons: readonly RecHorizon[], market: 'spot' | 'perp', deps: AssetHorizonDeps): Promise<{ rows: RecommendationRow[]; excluded: { symbol: string; reason: string }[]; regimes: Map<string, DailyRegime | null> }> {
  const rows: RecommendationRow[] = [], excluded: { symbol: string; reason: string }[] = [], regimes = new Map<string, DailyRegime | null>();
  for (const r0 of rec.rows) {
    if (stockLike(r0.symbol)) { excluded.push({ symbol: r0.symbol, reason: 'stock_like' }); continue; }
    let tradable = true;
    try { tradable = deps.tradable ? deps.tradable(r0.symbol, market) : true; } catch { tradable = true; }
    if (!tradable) { excluded.push({ symbol: r0.symbol, reason: 'not_tradable' }); continue; }
    let r = r0;
    if (r.regime === null) r = await refreshRegime(r, horizons, market, deps, regimes);
    rows.push(r);
  }
  const best = (r: RecommendationRow): [number, number] => horizons.filter((h) => r.horizons[h].eligible).map((h) => strength(r, h)).sort(cmp)[0] ?? [Infinity, -(r.quote_vol_24h ?? 0)];
  const nOk = (r: RecommendationRow) => horizons.filter((h) => r.horizons[h].eligible).length;
  rows.sort((a, b) => (nOk(b) > 0 ? 1 : 0) - (nOk(a) > 0 ? 1 : 0) || cmp(best(a), best(b)) || a.symbol.localeCompare(b.symbol));
  return { rows, excluded, regimes };
}

const short = (s: string) => s.replace(/USDT$/, '');

/** 日线高波动门槛:20 日已实现波动率在近 100 日的分位 ≥ 0.85 记 volatile(与 market.ts dailyRegime 同一口径) */
export const VOLATILE_RANK = 0.85;
/** 没有任何币合格的档位,最多列几个「最接近」的候选 */
export const CLOSEST_MAX = 5;
/** 能靠条件变化转为合格的原因(无市场 / 股票 / 稳定币这类不算) */
const NEAR_MISS = new Set(['regime', 'liquidity', 'history', 'regime_unavailable']);

/** 日线 EMA 排列(ema_stack 是 market.ts 的中文串,只认符号)→ 波动回落后会读成的状态 */
function stackLean(reg: DailyRegime): 'bull' | 'bear' | 'range' {
  const up = /价>EMA20/.test(reg.ema_stack) && /EMA20>EMA50/.test(reg.ema_stack), down = /价<EMA20/.test(reg.ema_stack) && /EMA20<EMA50/.test(reg.ema_stack);
  return up && reg.ret_20d_pct > 0 ? 'bull' : down && reg.ret_20d_pct < 0 ? 'bear' : 'range';
}
const ord = (x: number): string => `p${Math.round(x * 100)}`;

/**
 * 不合格行的「具体差在哪、到什么水平就合格」:一句英文,带数值;给「最接近的候选」用。
 * 日线数据用注入的 regime()(运行时有 6h 缓存),取不到就只给门槛本身。
 */
export function unmetText(f: HorizonFit, h: RecHorizon, row: RecommendationRow, reg: DailyRegime | null, market: 'spot' | 'perp'): { blocker: string; qualifies_at: string } {
  switch (f.reason) {
    case 'regime': {
      if (row.regime === 'volatile' || reg?.regime === 'volatile') {
        const lean = reg ? stackLean(reg) : null;
        const after = !lean ? '' : lean === 'bull' ? '; the daily EMA stack is bullish, so once volatility eases it would read as an uptrend (long bias, trend families)'
          : lean === 'bear' ? (market === 'spot' ? '; the daily EMA stack is bearish, so it would still be blocked on spot (long-only)' : '; the daily EMA stack is bearish, so once volatility eases it would read as a downtrend (short bias, trend families)')
            : '; the daily EMA stack is mixed, so once volatility eases it would read as a range (mean reversion / structure families)';
        return {
          blocker: `daily volatility gate: 20d realized volatility ${reg ? `at ${ord(reg.vol_pct_rank)} of the last 100 days` : 'in the top 15% of the last 100 days'}${reg ? ` (daily ATR ${reg.atr_pct.toFixed(1)}%)` : ''}`,
          qualifies_at: `20d realized volatility below ${ord(VOLATILE_RANK)}${after}`,
        };
      }
      if ((row.regime === 'bear' || reg?.regime === 'bear') && market === 'spot') {
        return { blocker: `daily downtrend${reg ? ` (20d ${reg.ret_20d_pct.toFixed(1)}%)` : ''} and spot is long-only`, qualifies_at: 'on perpetuals as a short-bias pick, or on spot once the daily trend turns (close back above EMA20 with a positive 20d return)' };
      }
      return { blocker: 'daily regime does not fit this horizon\'s strategy families', qualifies_at: 'a daily uptrend, downtrend or range reading' };
    }
    case 'liquidity': {
      const vol = row.quote_vol_24h ?? null, depth = row.depth_usd_05 ?? null, min = HORIZON_MIN_VOL[h];
      if (h === 'short' && market !== 'perp') return { blocker: 'short-term covers liquid USDT perpetuals only', qualifies_at: 'request market=perp' };
      if (vol === null || vol < min) return { blocker: `24h volume ${usdAbbr(vol)}`, qualifies_at: `24h volume ≥ ${usdAbbr(min)}${vol ? ` (${(min / vol).toFixed(1)}× current)` : ''}` };
      if (h === 'short' && depth !== null && depth < SHORT_MIN_DEPTH_USD) return { blocker: `±0.5% book depth ${usdAbbr(depth)}`, qualifies_at: `±0.5% depth ≥ ${usdAbbr(SHORT_MIN_DEPTH_USD)}` };
      return { blocker: 'liquidity below threshold', qualifies_at: `24h volume ≥ ${usdAbbr(min)}` };
    }
    case 'history': {
      const days = f.evidence.map((e) => /上市\s*(\d+)\s*天/.exec(e)?.[1] ?? /listed\s*(\d+)\s*days?/i.exec(e)?.[1]).find(Boolean);
      return { blocker: `listed ${days ? `${days} days` : 'under 1 year'}`, qualifies_at: `≥ ${LONG_MIN_LISTED_DAYS} days of daily history${days ? ` (in ${LONG_MIN_LISTED_DAYS - Number(days)} days)` : ''}` };
    }
    case 'regime_unavailable': return { blocker: 'daily regime could not be computed (daily candles unavailable)', qualifies_at: 'a readable daily regime; re-run later' };
    default: return { blocker: reasonText(f, h, row, market), qualifies_at: '—' };
  }
}

export const assetHorizonService: PerCallService<AssetHorizonParams> = {
  key: 'asset_horizon',
  validate(job) {
    const p = jsonParams(job) ?? {}, text = freeText(job);
    const found = symbolsIn(text, 12);
    const symbols = symbolList(p['symbols'], 12) ?? (found.length ? found : undefined);
    const top = p['top_n'] === undefined ? 8 : Number(p['top_n']);
    if (!Number.isInteger(top) || top < 1 || top > 12) throw new ServiceInputError('top_n_invalid', 'top_n must be an integer from 1 to 12');
    const horizons = horizonsIn(p['horizons'], text);
    return { ...(symbols ? { symbols } : {}), ...(horizons ? { horizons } : {}), market: marketIn(p['market'], text), top_n: top };
  },
  async handle(job, params, deps) {
    const rec = await deps.recommend(params);
    const horizons = params.horizons ?? [...HORIZONS];
    const { rows, excluded, regimes } = await refineRecommendation(rec, horizons, params.market, deps as AssetHorizonDeps);
    // 某档一个合格的都没有:按强弱列「最接近」的候选,每个写清差在哪条门槛、到什么水平合格(复审 09-26:只有一句 none qualified + 同一句话重复 8 遍)
    const regimeFor = async (sym: string): Promise<DailyRegime | null> => {
      if (!regimes.has(sym)) regimes.set(sym, await deps.regime(sym).catch(() => null));
      return regimes.get(sym) ?? null;
    };
    const closest: Partial<Record<RecHorizon, { symbol: string; reason: string | null; blocker: string; qualifies_at: string; radar_rank: number | null; scan_rank: number | null; quote_vol_24h: number | null }[]>> = {};
    for (const h of horizons) {
      if (rows.some((r) => r.horizons[h].eligible)) continue;
      const near = rows.filter((r) => NEAR_MISS.has(r.horizons[h].reason ?? '')).sort((a, b) => cmp(strength(a, h), strength(b, h))).slice(0, CLOSEST_MAX);
      closest[h] = [];
      for (const r of near) {
        const f = r.horizons[h];
        const reg = f.reason === 'regime' ? await regimeFor(r.symbol) : null;
        closest[h]!.push({ symbol: r.symbol, reason: f.reason, ...unmetText(f, h, r, reg, params.market), radar_rank: r.radar[h]?.rank ?? null, scan_rank: r.scan?.rank ?? null, quote_vol_24h: r.quote_vol_24h });
      }
    }
    const ranked = (h: RecHorizon) => rows.filter((r) => r.horizons[h].eligible).sort((a, b) => cmp(strength(a, h), strength(b, h)));
    const picks: Record<string, string[]> = Object.fromEntries(horizons.map((h) => [h, ranked(h).map((r) => r.symbol)]));
    const regimeOf = (r: RecommendationRow) => r.regime ? REGIME_TEXT[r.regime] ?? r.regime : 'Daily regime unknown';
    const summary = rows.length
      ? `Asset × horizon picks (${MARKET_TEXT[params.market]}): ${horizons.map((h) => `${HORIZON_TEXT[h]} ${picks[h]!.length ? picks[h]!.map(short).join(', ') : `none qualified${closest[h]?.length ? ` (closest: ${closest[h]!.slice(0, 3).map((c) => short(c.symbol)).join(', ')})` : ''}`}`).join(' · ')}`
      : 'No eligible assets';

    const src = rec.source;
    const stamp = [
      ...(src.universe_scan_at ? [`market scan ${utc(src.universe_scan_at)}`] : []),
      ...(src.regime_at ? [`daily regime ${utc(src.regime_at, false)}`] : []),
      ...horizons.flatMap((h) => { const at = src.radar_at[h]; return at ? [`${radarTier(h).replace(/ tier$/, '').replace(/^Radar/, 'radar')} ${utc(at, false)}`] : []; }),
    ];
    const lines: string[] = [
      `Data as of: ${stamp.join(' · ') || '—'} (generated ${utc(rec.as_of)})`,
      `Horizons: ${horizons.map((h) => HORIZON_MEANING[h]).join('; ')}`,
      // 没有任何币进当期雷达榜时如实说只按全市场扫描排(复审 09-26:声称用了雷达排名但 radar_rank 全空)
      rows.some((r) => horizons.some((h) => r.radar[h]?.rank !== undefined))
        ? 'Ranking: better of the radar-tier rank and the market-scan rank, then 24h volume'
        : 'Ranking: market-scan rank, then 24h volume (none of these coins is on the current radar-tier lists)',
    ];
    for (const h of horizons) {
      const list = ranked(h);
      lines.push(`[${HORIZON_TEXT[h]}] ${list.length ? `${list.length} eligible` : 'none eligible'}`);
      const near = closest[h] ?? [];
      if (!list.length && near.length) {
        lines.push(`Closest candidates for ${HORIZON_TEXT[h].toLowerCase()} (ranked by radar / scan strength; what blocks each and the level that would qualify it):`);
        near.forEach((c, i) => {
          const basis = [...(c.radar_rank !== null ? [`${radarTier(h)} #${c.radar_rank}`] : []), ...(c.scan_rank !== null ? [`market scan #${c.scan_rank}`] : []), `24h volume ${usdAbbr(c.quote_vol_24h)}`].join('; ');
          lines.push(`${i + 1}. ${c.symbol} (${basis}) — blocked by ${c.blocker}; qualifies at ${c.qualifies_at}`);
        });
      } else if (!list.length) lines.push(`No candidate is within reach of the ${HORIZON_TEXT[h].toLowerCase()} gates (remaining coins lack an OKX ${MARKET_TEXT[params.market]} market or are out of scope).`);
      list.forEach((r, i) => {
        const f = r.horizons[h];
        const basis = [
          ...(r.radar[h] ? [`${radarTier(h)} #${r.radar[h]!.rank}`] : []),
          ...(r.scan ? [`market scan #${r.scan.rank} (score ${r.scan.score.toFixed(2)})`] : []),
          `24h volume ${usdAbbr(r.quote_vol_24h)}`,
        ];
        lines.push(`${i + 1}. ${r.symbol} · ${regimeOf(r)} · ${DIR_TEXT[f.direction ?? ''] ?? '—'} · Fits: ${f.families.map((x) => FAMILY_TEXT[x] ?? x).join(', ')} · Basis: ${basis.join('; ')}`);
      });
    }
    const bad = rows.filter((r) => horizons.some((h) => !r.horizons[h].eligible));
    if (bad.length) {
      // 同一组原因只写一次(复审 09-26:同一句「High daily volatility…」对 8 个币各重复一遍)
      lines.push('Not eligible:');
      const groups = new Map<string, { regime: string; why: string; syms: string[] }>();
      for (const r of bad) {
        const why = horizons.filter((h) => !r.horizons[h].eligible).map((h) => `${HORIZON_TEXT[h]}: ${reasonText(r.horizons[h], h, r, params.market)}`).join('; ');
        const key = `${regimeOf(r)}\n${why}`;
        const g = groups.get(key) ?? { regime: regimeOf(r), why, syms: [] };
        g.syms.push(r.symbol); groups.set(key, g);
      }
      for (const g of groups.values()) lines.push(g.syms.length === 1 ? `· ${g.syms[0]} (${g.regime}) — ${g.why}` : `· ${g.syms.map(short).join(', ')} (${g.syms.length} coins, ${g.regime}) — ${g.why}`);
    }
    if (excluded.length) {
      const by = (code: string) => excluded.filter((x) => x.reason === code).map((x) => short(x.symbol));
      const parts = [...(by('stock_like').length ? [`${by('stock_like').join(', ')} (stock token / leveraged ETF)`] : []), ...(by('not_tradable').length ? [`${by('not_tradable').join(', ')} (no tradable ${MARKET_TEXT[params.market]} on OKX)`] : [])];
      lines.push(`Excluded: ${parts.join('; ')}`);
    }
    if (rec.warnings.length) lines.push(`Notes: ${[...new Set(rec.warnings.map(warningText))].join('; ')}`);
    lines.push('Method: rule-based, no LLM. Liquidity thresholds + daily regime → direction and strategy families, plus market-scan rank and radar-tier ranks. Analysis and evidence only.');

    return deliverable(job, 'asset_horizon', '[Asset × Horizon Picks] Trading Swarm', summary, lines, {
      recommendation_id: rec.id, as_of: rec.as_of, market: params.market, horizons, picks,
      rows: rows.map((r) => ({
        symbol: r.symbol, regime: r.regime, quote_vol_24h: r.quote_vol_24h, scan_rank: r.scan?.rank ?? null,
        radar_rank: Object.fromEntries(Object.entries(r.radar).map(([h, v]) => [h, v?.rank ?? null])),
        horizons: Object.fromEntries(horizons.map((h) => { const f = r.horizons[h]; return [h, { eligible: f.eligible, direction: f.direction, families: f.families, reason: f.reason, reason_text: f.eligible ? null : reasonText(f, h, r, params.market), evidence: f.evidence.map(englishEvidence).filter((x): x is string => !!x).slice(0, 3) }]; })),
      })),
      closest: Object.fromEntries(Object.entries(closest).map(([h, xs]) => [h, xs!.map((c) => ({ ...c, quote_vol_24h: c.quote_vol_24h === null ? null : Math.round(c.quote_vol_24h) }))])),
      excluded: excluded.map((x) => ({ ...x, reason_text: x.reason === 'stock_like' ? 'Stock token / leveraged ETF' : 'Not tradable on OKX right now' })),
      warnings: rec.warnings, source: rec.source,
      method: 'Rule-based, no LLM: liquidity thresholds + daily regime → direction and strategy families + market-scan rank + radar-tier ranks; stock tokens / leveraged ETFs and assets not tradable on OKX are excluded; a missing daily regime is retried once, then marked not eligible',
    });
  },
};
