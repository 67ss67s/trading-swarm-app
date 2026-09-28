/**
 * 订阅频道「雷达榜单」(市场情报 · radar_feed):雷达三档(短线 short / 波段 swing / 周线 weekly)每跑完一轮就推一次。
 *
 * 只列两种币(排好序、最多 5 个):策略条件清单全过的;只差一步(1 条,或 2 条都「差一点」)且能写出具体触发条件
 * (价位 / 指标阈值,取自筛选器的 OpportunityCard)的。其余一律不展开,只在末尾计数。
 * 「差一步」里带价位触发(突破位 / 距突破位区间)的,触发价离现价(有实时价用实时价,否则用筛选时收盘)必须 ≤ 1.5 × 该档周期 ATR
 * 且 ≤ 每档百分比上限(短线 3% / 波段 6% / 周线 10%;ATR 缺失只看百分比),否则不算「Near」,计入末尾 Not listed;行内写出距离。
 * 另外都要通过对应周期的流动性门,并且与「资产 × 周期」服务同一口径 —— OKX 上有 USDT 永续(tradable(symbol,'perp'))。
 * 依据文字可能来自筛选大脑的自由文本:过红线词(屏蔽)+ 指令 / 推荐语气(整句删),模型写的行标 [AI],此时免责声明用 AI 版。
 * 推送正文全英文;每份推送显式带订阅信号行(【Futures】类型头、≤200 字)。
 * 何时调用、扇出、deliver、落账归 broadcaster;取数全走注入的 RadarDeps(测试零网络)。只给分析与依据,不给买卖指令。
 */
import {
  HORIZON_RADAR_TIER, RADAR_TIER_EVERY_MS,
  type Horizon, type HorizonFit, type RadarTier,
} from '../../recommend.js';
import { BANNED_WORDS } from '../publisher.js';
import { infoSignal } from './broadcast.js';
import { CJK, REGIME_LABEL, asOfLabel, baseOf, channelPush, englishReason, plural, price, safely, scrubInstructions, strategyName, tradableCheck, utcLabel, type TradableFn } from './market-brief.js';
import { num } from './render.js';
import type { ChannelDeps, ChannelPush, SubscriptionChannel } from './types.js';


/** 推荐层(recommend.ts)的数额短写 1.20B / 300.0M / 800K → 加 $ */
const money = (s: string): string => `$${s}`;
const HZ_ZH: Record<string, string> = { 短线: 'Short-term', 中线: 'Mid-term', 长线: 'Long-term' };
const RADAR_TIER_ZH: Record<string, string> = { 短线档: 'short-term tier', 波段档: 'swing tier', 周线档: 'weekly tier' };
/**
 * 流动性门证据(recommend.ts horizonFit 的中文句式)→ 英文;认不出的交给 englishReason(含中日韩字符就丢)。
 */
export function englishEvidence(raw: string): string | null {
  const s = String(raw).trim();
  let m: RegExpExecArray | null;
  if ((m = /^24h\s*(永续|现货)成交额\s*(\S+)$/.exec(s))) return `24h ${m[1] === '永续' ? 'perp' : 'spot'} volume ${money(m[2]!)}`;
  if (/^OKX 全集里没有这个币/.test(s)) return 'Not in the OKX universe (or the universe has not refreshed yet)';
  if ((m = /^全集排除[::]\s*(.*)$/.exec(s))) return `Excluded from the OKX universe${m[1] && !CJK.test(m[1]) ? ` (${m[1].replace(/_/g, ' ')})` : ' (stablecoin / wrapped token)'}`;
  if ((m = /^OKX 没有该币的 USDT (永续|现货)$/.exec(s))) return `No USDT ${m[1] === '永续' ? 'perp' : 'spot market'} on OKX`;
  if (/^短线只做高流动性永续/.test(s)) return 'Short-term tier covers liquid perps only';
  if ((m = /^短线要求永续成交额\s*≥\s*(\S+?)(?:[((].*)?$/.exec(s))) return `Short-term requires 24h perp volume ≥ ${money(m[1]!)} (small caps rarely clear fees on short timeframes)`;
  if ((m = /^近价\s*±0\.5%\s*挂单\s*(\S+)$/.exec(s))) return `Depth within ±0.5%: ${money(m[1]!)}`;
  if ((m = /^短线要求\s*±0\.5%\s*深度\s*≥\s*(\S+)$/.exec(s))) return `Short-term requires ±0.5% depth ≥ ${money(m[1]!)}`;
  if ((m = /^(中线|长线)要求成交额\s*≥\s*(\S+)$/.exec(s))) return `${HZ_ZH[m[1]!]} requires 24h volume ≥ ${money(m[2]!)}`;
  if ((m = /^上市\s*(\d+)\s*天(.*)$/.exec(s))) return `Listed ${plural(Number(m[1]), 'day')} ago${m[2] ? '; not enough daily history for a train/validation/holdout split' : ''}`;
  if ((m = /^日线(多头|空头|震荡|高波动)[((](.+?)[,,]\s*20\s*日\s*(-?\d+(?:\.\d+)?)%[))]$/.exec(s))) return `Daily ${REGIME_LABEL[REGIME_ZH_KEY[m[1]!]!]} (${m[2]!.replace(/价/g, 'price')}; 20d ${m[3]}%)`;
  if (/^日线空头[,,]\s*现货只能做多$/.test(s)) return 'Daily bearish; spot markets are long-only';
  if (/^日线高波动[,,]\s*中短线假突破多/.test(s)) return 'Daily volatile; false breakouts are frequent on short and mid horizons';
  if (/^日线状态未知/.test(s)) return 'Daily regime unknown; trend and mean-reversion families both listed';
  if ((m = /^日线(多头|空头|震荡|高波动)$/.exec(s))) return `Daily ${REGIME_LABEL[REGIME_ZH_KEY[m[1]!]!]}`;
  if ((m = /^全市场扫描第\s*(\d+)\s*名[((]分\s*(-?\d+(?:\.\d+)?)[))]$/.exec(s))) return `Market-wide scan #${m[1]} (score ${m[2]})`;
  if ((m = /^雷达(短线档|波段档|周线档)第\s*(\d+)\s*名[((]适配\s*(-?\d+(?:\.\d+)?)/.exec(s))) return `Radar ${RADAR_TIER_ZH[m[1]!]} #${m[2]} (fit ${m[3]})`;
  return englishReason(s);
}

/** ScreenStore.latest 的子集 */
export interface RadarScreenLike { id: string; status: string; started_at: number; finished_at: number | null }
/**
 * ScreenStore.candidates 的子集(同一币可能对应多条策略,按 rank 升序)。
 * card = 筛选器的 OpportunityCard(条件清单 / 突破位 / 收盘价 / ATR),有它才能写出「差哪一步、在哪个价位」。
 */
export interface RadarCandidateLike { symbol: string; rank: number; fit_score: number; reasons: string[]; strategy_id?: string; card?: unknown }
/** 推荐层对单币单周期的流动性门结果(recommendAssets 的 row 摊平) */
export interface RadarFitRow { symbol: string; fit: HorizonFit; quote_vol_24h: number | null; depth_usd_05: number | null }

export interface RadarDeps {
  /** 该档最近一轮跑完的筛选;没有返回 null(runtime: store.screens.latest(tier)) */
  latest(tier: RadarTier): RadarScreenLike | null;
  /** 该轮候选,按 rank 升序(runtime: store.screens.candidates(screen_id, n)) */
  candidates(screen_id: string, n: number): RadarCandidateLike[];
  /** 推荐层流动性门:对这些币只评估 horizon 一档(runtime: recommendAssets(..., { symbols, horizons: [horizon] }).rows 摊平);单次 ≤ 12 个 */
  fit(symbols: string[], horizon: Horizon): Promise<RadarFitRow[]>;
  /** 该档刷新周期(过期 = 超过两倍周期);缺省用 RADAR_TIER_EVERY_MS(runtime: radar.everyMs(tier)) */
  every_ms?(tier: RadarTier): number;
  /** 可选:OKX 上有没有对应市场(默认 perp);没提供不过滤 */
  tradable?: TradableFn;
  /** 可选:实时最新价(OKX 永续);有它就在触发条件旁写现价,并标出筛选后已越过的价位 */
  tickers?(symbols: string[]): Promise<Record<string, { last: number }>>;
}

type Deps = ChannelDeps & RadarDeps;

/** 未满足的一条清单条件;trigger = 让它成立的具体条件(价位 / 指标阈值),写不出具体条件的为 null */
export interface OpenCondition { key: string; near: boolean; trigger: string | null }
export interface Checklist {
  /** complete = 清单全过;near = 最多差 2 条且每条都写得出具体触发条件(价位 / 阈值);far = 其余;unknown = 没有清单 */
  status: 'complete' | 'near' | 'far' | 'unknown';
  met: number | null; total: number | null;
  direction: 'long' | 'short' | null;
  timeframe: string | null;
  /** 筛选时的收盘价与时刻 */
  last_close: number | null; as_of: number | null;
  /** 该方向的突破位(前 20 根高 / 低) */
  level: number | null;
  /** 该档周期 ATR 绝对值(atr_pct × 收盘);缺失为 null */
  atr_abs?: number | null;
  /** 「距突破位 ≤ k ATR」的 k(清单里有这条时) */
  chase_k?: number | null;
  open: OpenCondition[];
  /** 给人读的触发条件(「突破位」与「距突破位」同时未满足时合并成一个收盘区间) */
  triggers: string[];
}
export interface Pick {
  rank: number; symbol: string; fit_score: number; strategy_id: string | null; strategy_name: string | null; reasons: string[];
  checklist: Checklist;
  /** 实时最新价(可选依赖);没有为 null */
  live_price: number | null;
  /** 价位类触发离现价多远(只对「差一步」且触发里有价位的);其余为 null */
  trigger_distance: TriggerDistance | null;
  gate: { eligible: boolean; reason: string | null; reason_text: string | null; direction: string | null; direction_text: string | null; families: string[]; evidence: string[]; quote_vol_24h: number | null; depth_usd_05: number | null };
}
export interface TierReport {
  tier: RadarTier; horizon: Horizon; screen_id: string; finished_at: number; age_ms: number; stale: boolean; refresh_every_ms: number;
  picks: Pick[]; gate_error: string | null;
  /** 看过但没列出的:无 OKX USDT 永续 / 清单差太多或写不出触发条件 / 没过流动性门(按原因计数) / 超出条数 */
  hidden: { untradable: number; incomplete: number; too_far: number; ineligible: number; ineligible_reasons: Record<string, number>; overflow: number };
  /** 没列出的里面离清单全过最近的几个(一行带过,不展开) */
  closest: { symbol: string; met: number; total: number }[];
  screened: number;
  ai: boolean;
}

export const RADAR_TIERS: readonly RadarTier[] = ['short', 'swing', 'weekly'];
/** 雷达档 → 推荐层周期档(short←short、mid←swing、long←weekly) */
export const RADAR_TIER_HORIZON: Record<RadarTier, Horizon> = Object.fromEntries(
  (Object.entries(HORIZON_RADAR_TIER) as [Horizon, RadarTier][]).map(([h, t]) => [t, h]),
) as Record<RadarTier, Horizon>;
const TIER_LABEL: Record<RadarTier, string> = { short: 'Short-term tier', swing: 'Swing tier', weekly: 'Weekly tier' };
/** 周期档英文(recommend.ts 的 HORIZON_LABEL 是中文,这里自带一份) */
const HORIZON_EN: Record<Horizon, string> = { short: 'short-term', mid: 'mid-term', long: 'long-term' };
/** 各档都只列通过对应周期流动性门的币(不合格的只在末尾计数) */
export const RADAR_ELIGIBLE_ONLY: Record<RadarTier, boolean> = { short: true, swing: true, weekly: true };
/** 每次推送最多列几个(清单全过的在前,差一步的在后) */
export const RADAR_FEED_TOP = 5;
const WELCOME_TOP = 3;
/** 每轮最多看多少个不同的币 */
const POOL = 40;
/** recommendAssets 单次最多 12 个币;最多评估 3 批 */
const FIT_BATCH = 12;
const FIT_MAX_BATCHES = 3;
const STATE_KEY = (t: RadarTier): string => `radar_feed:last:${t}`;
/** 差几条以内、且每条都写得出具体触发条件的,才作为「差一步」列出 */
export const MAX_OPEN = 2;
/** 「Near」的距离上限:价位触发离现价 ≤ atr × 该档周期 ATR,且 ≤ pct(每档) */
export const RADAR_NEAR_MAX: { atr: number; pct: Record<RadarTier, number> } = { atr: 1.5, pct: { short: 0.03, swing: 0.06, weekly: 0.1 } };

/** 价位类触发离现价的距离;abs / pct / atr 都按「现价到触发区间最近一端」算,已在区间里为 0 */
export interface TriggerDistance {
  ref_price: number; ref_source: 'live' | 'last_close';
  /** 触发区间 [lo, hi](突破:收盘越过突破位,开放一端为 null) */
  zone: { lo: number | null; hi: number | null };
  abs: number; pct: number; atr: number | null;
  cap_pct: number; cap_atr: number; within: boolean;
}
/** 清单里有价位类未满足条件(突破位 / 距突破位)时,返回触发区间;否则 null(非价位触发不做距离过滤) */
export function triggerZone(k: Checklist, chaseK = 1.5): { lo: number | null; hi: number | null } | null {
  if (k.level === null || k.direction === null) return null;
  const bo = k.open.some((o) => o.key === 'breakout'), chase = k.open.some((o) => o.key === 'within_chase');
  if (!bo && !chase) return null;
  const atr = k.atr_abs, long = k.direction === 'long';
  if (bo && chase && atr) return long ? { lo: k.level, hi: k.level + chaseK * atr } : { lo: k.level - chaseK * atr, hi: k.level };
  if (bo) return long ? { lo: k.level, hi: null } : { lo: null, hi: k.level };
  return atr ? { lo: k.level - chaseK * atr, hi: k.level + chaseK * atr } : null;
}
/** 「差一步」的价位触发离现价多远、是否够近;没有价位触发 / 没有参考价返回 null(不过滤) */
export function triggerDistance(k: Checklist, tier: RadarTier, live: number | null): TriggerDistance | null {
  if (k.status !== 'near') return null;
  const zone = triggerZone(k, k.chase_k ?? 1.5);
  const ref = live ?? k.last_close;
  if (!zone || ref === null || !(ref > 0)) return null;
  const abs = zone.lo !== null && ref < zone.lo ? zone.lo - ref : zone.hi !== null && ref > zone.hi ? ref - zone.hi : 0;
  const pct = abs / ref, atr = k.atr_abs ? abs / k.atr_abs : null;
  const cap_pct = RADAR_NEAR_MAX.pct[tier], cap_atr = RADAR_NEAR_MAX.atr;
  const within = pct <= cap_pct + 1e-12 && (atr === null || atr <= cap_atr + 1e-12);
  return { ref_price: ref, ref_source: live !== null ? 'live' : 'last_close', zone, abs, pct, atr, cap_pct, cap_atr, within };
}
/** 距离短写:「0.8 ATR / 1.2% away」;ATR 缺失只写百分比 */
export function distanceText(d: TriggerDistance): string {
  return `${d.atr !== null ? `${d.atr.toFixed(1)} ATR / ` : ''}${(d.pct * 100).toFixed(1)}% away`;
}

const REASON_TEXT: Record<string, string> = {
  liquidity: 'insufficient liquidity', history: 'listing history too short', regime: 'daily regime not suitable', no_market: 'no matching OKX market',
  excluded: 'excluded from the OKX universe', equity: 'tokenized stock', unknown_asset: 'not in the OKX universe', not_requested: 'not evaluated', unavailable: 'liquidity gate unavailable',
};
const reasonLabel = (k: string): string => REASON_TEXT[k] ?? 'other reason';
const REGIME_ZH_KEY: Record<string, keyof typeof REGIME_LABEL> = { 多头: 'bull', 空头: 'bear', 震荡: 'range', 高波动: 'volatile' };
const REGIME_IN_EVIDENCE = /^(?:日线(多头|空头|震荡|高波动)|Daily:?\s+(bullish|bearish|ranging|volatile))/i;
const DIR_TEXT: Record<string, string> = { long: 'Direction: trending up', short: 'Direction: trending down', both: 'Direction: no single bias' };
function directionText(f: HorizonFit): string | null {
  const m = f.evidence.map((e) => REGIME_IN_EVIDENCE.exec(e)).find((x) => !!x);
  if (m) return `Daily: ${m[1] ? REGIME_LABEL[REGIME_ZH_KEY[m[1]]!] : m[2]!.toLowerCase()}`;
  return f.direction ? DIR_TEXT[f.direction] ?? null : null;
}

const SCRUB = new RegExp(BANNED_WORDS.source, 'gi');
const REDACTED = '[redacted]';
/** 红线词屏蔽 + 空白收拢 + 截断 */
const scrub = (s: string, max = 60): string => {
  const t = String(s).replace(SCRUB, REDACTED).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const AI_PREFIX = /^\s*(模型|AI|LLM)\s*[::]\s*/i;
/** 依据文字:先翻成英文(含中日韩字符的整条丢),模型行改标 [AI];红线词屏蔽;指令 / 推荐语气整句删;删空返回 null */
function reasonText(raw: string, max = 60, evidence = false): { text: string; ai: boolean } | null {
  const ai = AI_PREFIX.test(raw);
  const stripped = String(raw).replace(AI_PREFIX, '');
  const en = evidence ? englishEvidence(stripped) : englishReason(stripped);
  if (!en) return null;
  const body = scrubInstructions(en.replace(SCRUB, REDACTED));
  if (!body || CJK.test(body)) return null;
  return { text: scrub(`${ai ? '[AI] ' : ''}${body}`, max), ai };
}
const finishedAt = (s: RadarScreenLike): number => s.finished_at ?? s.started_at;

function latestDone(deps: Deps, tier: RadarTier): RadarScreenLike | null {
  const s = deps.latest(tier);
  return s && s.status === 'done' ? s : null;
}
/** 同一币多条策略只留名次最前的那条 */
function distinctPicks(rows: RadarCandidateLike[], n: number): RadarCandidateLike[] {
  const out: RadarCandidateLike[] = [];
  const seen = new Set<string>();
  for (const c of [...rows].sort((a, b) => a.rank - b.rank)) {
    if (out.length >= n) break;
    if (seen.has(c.symbol)) continue;
    seen.add(c.symbol);
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------- 条件清单 → 具体触发条件

interface CardCond { key?: unknown; label?: unknown; pass?: unknown; near?: unknown; detail?: unknown }
interface CardStrat { strategy_id?: unknown; passed?: unknown; total?: unknown; direction?: unknown; conditions?: unknown }
interface CardLike {
  timeframe?: unknown; as_of?: unknown; last_close?: unknown; atr_pct?: unknown; daily_regime?: unknown;
  breakout?: { level_long?: unknown; level_short?: unknown; dist_long_atr?: unknown; dist_short_atr?: unknown } | null;
  strategies?: unknown;
}
const fin = (x: unknown): number | null => { const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() ? Number(x) : NaN; return Number.isFinite(n) ? n : null; };
const numsIn = (x: unknown): number[] => [...String(x ?? '').matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
const TF_RE = /^\d+[mhdwM]$/;
const up = (d: 'long' | 'short' | null): string => d === 'short' ? 'down' : 'up';
/** 阈值短写:1.50 → 1.5、1.00 → 1 */
const k2 = (x: number): string => String(+x.toFixed(2));
const REGIME_KEY_EN: Record<string, string> = { bull: 'bullish', bear: 'bearish', range: 'ranging', volatile: 'volatile' };

/** 一条未满足条件 → 让它成立的具体条件(英文);写不出具体价位 / 阈值的返回 null */
export function conditionTrigger(c: { key: string; label: string; detail: string }, ctx: { tf: string; dir: 'long' | 'short' | null; level: number | null; last: number | null; atr_pct: number | null; regime: string | null }): string | null {
  const { tf, dir, level, last, atr_pct } = ctx;
  const lastN = (xs: number[]): number | null => xs.length ? xs[xs.length - 1]! : null;
  switch (c.key) {
    case 'breakout':
      return level !== null ? `a fresh ${tf} close ${dir === 'short' ? 'below' : 'above'} ${price(level)}` : null;
    case 'within_chase': {
      const k = lastN(numsIn(c.label)) ?? 1.5;
      const atr = atr_pct !== null && last !== null ? atr_pct / 100 * last : null;
      return level !== null && atr ? `price back within ${k2(k)} ATR of ${price(level)} (${price(level - k * atr)}–${price(level + k * atr)})` : null;
    }
    case 'retest_vol': case 'expansion_vol': {
      const th = lastN(numsIn(c.label));
      return th !== null ? `${tf} volume at least ${k2(th)}× its average${c.key === 'expansion_vol' ? ' on the breakout bar' : ''}` : null;
    }
    case 'trend_agree': {
      const m = /(\d+[mhdw])\s*\/\s*(\d+[mhdw])/.exec(c.label);
      return `${m ? `${m[1]} and ${m[2]}` : 'both timeframes'} EMA20 vs EMA50 aligned ${dir ? up(dir) : 'in one direction'}`;
    }
    case 'confirm_dir': return 'higher-timeframe trend no longer opposing';
    case 'regime_ok': return `daily regime no longer ${REGIME_KEY_EN[ctx.regime ?? ''] ?? 'opposing this direction'}`;
    case 'funding_ok': { const cap = lastN(numsIn(c.detail)); return cap !== null ? `|funding| back under ${num(cap)}% per period` : null; }
    case 'atr_ok': { const [now, thr] = numsIn(c.detail); return thr !== undefined ? `ATR% above ${num(thr)} (now ${num(now!)})` : null; }
    case 'compressed': { const [pct, bars] = numsIn(c.label); return pct !== undefined ? `Bollinger bandwidth in the lowest ${pct}% of 90 bars${bars !== undefined ? `, or a squeeze lasting ${bars}+ bars` : ''}` : null; }
    case 'deviation': { const k = lastN(numsIn(c.label)); const now = numsIn(c.detail)[0]; return k !== null ? `price stretched at least ${num(k)} ATR from the ${tf} EMA20${now !== undefined ? ` (now ${num(now)} ATR)` : ''}` : null; }
    case 'ranging': { const adx = lastN(numsIn(c.label)); return adx !== null ? `daily regime turns ranging or ADX drops below ${adx}` : null; }
    case 'funding_abs': { const n = lastN(numsIn(c.label)); return n !== null ? `|funding| at least ${num(n)}% per period` : null; }
    case 'funding_z': { const n = lastN(numsIn(c.label)); return n !== null ? `funding 30-day z-score beyond ±${num(n)}` : null; }
    case 'not_settling': { const n = lastN(numsIn(c.label)); return n !== null ? `more than ${n} minutes before funding settlement` : null; }
    default: return null;
  }
}

/** 候选 → 清单状态。card 缺失时只能从依据文字认「a/b 条通过」,全过算 complete,否则 unknown */
export function checklistOf(c: RadarCandidateLike): Checklist {
  const card = (c.card && typeof c.card === 'object' ? c.card : null) as CardLike | null;
  const strats = Array.isArray(card?.strategies) ? card!.strategies as CardStrat[] : [];
  const s = strats.find((x) => x.strategy_id === c.strategy_id) ?? strats[0];
  const conds = s && Array.isArray(s.conditions) ? (s.conditions as CardCond[]).filter((x) => x && typeof x.key === 'string') : [];
  if (!card || !s || !conds.length) {
    const m = c.reasons.map((r) => /(\d+)\/(\d+)\s*条通过|Checklist (\d+)\/(\d+) met/.exec(r)).find(Boolean);
    const met = m ? Number(m[1] ?? m[3]) : null, total = m ? Number(m[2] ?? m[4]) : null;
    return { status: met !== null && met === total ? 'complete' : 'unknown', met, total, direction: null, timeframe: null, last_close: null, as_of: null, level: null, atr_abs: null, chase_k: null, open: [], triggers: [] };
  }
  const tfRaw = String(card.timeframe ?? '');
  const tf = TF_RE.test(tfRaw) ? tfRaw : 'bar';
  let dir: 'long' | 'short' | null = s.direction === 'long' || s.direction === 'short' ? s.direction : null;
  const bo = card.breakout ?? null;
  if (!dir && bo) { const dl = fin(bo.dist_long_atr), ds = fin(bo.dist_short_atr); dir = dl !== null && ds !== null ? (dl <= ds ? 'long' : 'short') : null; }
  const level = bo ? fin(dir === 'short' ? bo.level_short : bo.level_long) : null;
  const last = fin(card.last_close), atr_pct = fin(card.atr_pct);
  const regime = typeof card.daily_regime === 'string' ? card.daily_regime : null;
  const open: OpenCondition[] = conds.filter((x) => x.pass !== true).map((x) => ({
    key: String(x.key), near: x.near === true,
    trigger: conditionTrigger({ key: String(x.key), label: String(x.label ?? ''), detail: String(x.detail ?? '') }, { tf, dir, level, last, atr_pct, regime }),
  }));
  const total = conds.length, met = total - open.length;
  const status: Checklist['status'] = !open.length ? 'complete' : open.length <= MAX_OPEN && open.every((x) => x.trigger) ? 'near' : 'far';
  // 「收破突破位」+「距突破位 ≤ k ATR」都没满足:合起来就是「收盘落在突破位到 k ATR 之间」
  let triggers = open.map((o) => o.trigger).filter((x): x is string => !!x);
  const chase = conds.find((x) => x.key === 'within_chase');
  const atrAbs = atr_pct !== null && last !== null ? atr_pct / 100 * last : null;
  if (level !== null && atrAbs && chase && open.some((o) => o.key === 'breakout') && open.some((o) => o.key === 'within_chase')) {
    const k = numsIn(chase.label).pop() ?? 1.5;
    const far = dir === 'short' ? level - k * atrAbs : level + k * atrAbs;
    const merged = `a fresh ${tf} close ${dir === 'short' ? 'below' : 'above'} ${price(level)} but not beyond ${price(far)} (${k2(k)} ATR)`;
    triggers = [merged, ...open.filter((o) => o.key !== 'breakout' && o.key !== 'within_chase').map((o) => o.trigger).filter((x): x is string => !!x)];
  }
  const chaseK = chase ? numsIn(chase.label).pop() ?? 1.5 : null;
  return { status, met, total, direction: dir, timeframe: tf === 'bar' ? null : tf, last_close: last, as_of: fin(card.as_of), level, atr_abs: atrAbs && atrAbs > 0 ? atrAbs : null, chase_k: chaseK, open, triggers };
}

// ---------------------------------------------------------------- 取数与组装

function toPick(c: RadarCandidateLike, chk: Checklist, r: RadarFitRow | undefined, gateError: string | null, live: number | null, dist: TriggerDistance | null): { pick: Pick; ai: boolean } {
  const f: HorizonFit = r?.fit ?? { eligible: false, reason: 'unavailable', direction: null, families: [], evidence: [gateError ? 'Liquidity-gate data fetch failed' : 'Not returned by the recommendation layer'] };
  // 清单条数已在 checklist 里;依据只留清单以外、能翻成英文的一条(模型写的标 [AI])
  const reasons = c.reasons.filter((x) => !/条通过|^还差|Checklist/.test(x)).map((x) => reasonText(x, 110)).filter((x): x is NonNullable<typeof x> => !!x).slice(0, 1);
  const sid = c.strategy_id ? scrub(c.strategy_id, 80) : null;
  return {
    ai: reasons.some((x) => x.ai),
    pick: {
      rank: c.rank, symbol: c.symbol, fit_score: c.fit_score, strategy_id: sid, strategy_name: sid ? scrub(strategyName(sid) ?? '', 40) || null : null, reasons: reasons.map((x) => x.text),
      checklist: chk, live_price: live, trigger_distance: dist,
      gate: {
        eligible: f.eligible, reason: f.reason, reason_text: f.reason ? reasonLabel(f.reason) : null,
        direction: f.direction, direction_text: f.eligible ? directionText(f) : null, families: [...f.families],
        evidence: f.evidence.slice(0, 4).map((x) => reasonText(x, 120, true)?.text ?? '').filter(Boolean),
        quote_vol_24h: r?.quote_vol_24h ?? null, depth_usd_05: r?.depth_usd_05 ?? null,
      },
    },
  };
}

async function buildReport(deps: Deps, tier: RadarTier, screen: RadarScreenLike, top: number): Promise<TierReport> {
  const now = deps.now(), horizon = RADAR_TIER_HORIZON[tier];
  const every = deps.every_ms?.(tier) ?? RADAR_TIER_EVERY_MS[tier];
  const at = finishedAt(screen);
  const pool = distinctPicks(deps.candidates(screen.id, POOL * 4), POOL);
  // 与「资产 × 周期」服务同一口径:只列有 OKX USDT 永续的
  const tradableOnes = pool.filter((c) => tradableCheck(deps, c.symbol, ['perp']));
  const scored = tradableOnes.map((c) => ({ c, chk: checklistOf(c) }));
  const order = (x: { c: RadarCandidateLike; chk: Checklist }): number => (x.chk.status === 'complete' ? 0 : 1) * 1e6 + (x.chk.open.length * 1e4) + x.c.rank;
  const listable = scored.filter((x) => x.chk.status === 'complete' || x.chk.status === 'near').sort((a, b) => order(a) - order(b));
  const incomplete = scored.filter((x) => x.chk.status === 'far' || x.chk.status === 'unknown');

  // 「Near」要真的近:价位触发离现价 ≤ 1.5 ATR 且 ≤ 每档百分比上限;先取实时价(可选依赖,取不到用筛选时收盘)
  const live: Record<string, { last: number }> = {};
  const asked = new Set<string>();
  const fetchLive = async (symbols: string[]): Promise<void> => {
    const need = symbols.filter((s) => !asked.has(s));
    if (!deps.tickers || !need.length) return;
    need.forEach((s) => asked.add(s));
    const got = await safely(deps, 'radar tickers', () => deps.tickers!(need), 10_000);
    for (const [k, v] of Object.entries(got ?? {})) if (typeof v?.last === 'number' && Number.isFinite(v.last) && v.last > 0) live[k] = v;
  };
  const livePrice = (sym: string): number | null => live[sym]?.last ?? null;
  await fetchLive(listable.filter((x) => x.chk.status === 'near' && triggerZone(x.chk, x.chk.chase_k ?? 1.5)).map((x) => x.c.symbol));
  const dists = new Map<string, TriggerDistance | null>(listable.map((x) => [x.c.symbol, triggerDistance(x.chk, tier, livePrice(x.c.symbol))]));
  const tooFar = listable.filter((x) => dists.get(x.c.symbol)?.within === false);
  const want = listable.filter((x) => dists.get(x.c.symbol)?.within !== false);

  // 只对清单够格的去跑流动性门(省推荐层调用);凑够 top 个合格的就停
  const fits = new Map<string, RadarFitRow>();
  let gateError: string | null = null;
  const evaluated: typeof want = [];
  const cand = want.slice(0, FIT_BATCH * FIT_MAX_BATCHES);
  for (let i = 0; i < cand.length; i += FIT_BATCH) {
    const batch = cand.slice(i, i + FIT_BATCH);
    try { for (const r of await deps.fit(batch.map((x) => x.c.symbol), horizon)) fits.set(r.symbol, r); }
    catch (err) { gateError = scrub((err as Error).message, 120); deps.log('warn', `radar_feed: 流动性门取数失败 ${tier}/${screen.id}: ${gateError}`); break; }
    evaluated.push(...batch);
    if (evaluated.filter((x) => fits.get(x.c.symbol)?.fit.eligible).length >= top) break;
  }
  // 取数失败时没法按门过滤:照旧列清单够格的并注明
  const passed = gateError ? cand : evaluated.filter((x) => fits.get(x.c.symbol)?.fit.eligible);
  const shown = passed.slice(0, top);
  const ineligible = gateError ? [] : evaluated.filter((x) => !fits.get(x.c.symbol)?.fit.eligible);
  const reasons: Record<string, number> = {};
  for (const x of ineligible) { const k = fits.get(x.c.symbol)?.fit.reason ?? 'unavailable'; reasons[k] = (reasons[k] ?? 0) + 1; }

  await fetchLive(shown.map((x) => x.c.symbol));
  const built = shown.map((x) => toPick(x.c, x.chk, fits.get(x.c.symbol), gateError, livePrice(x.c.symbol), dists.get(x.c.symbol) ?? null));
  const closest = incomplete.filter((x) => x.chk.met !== null && x.chk.total).sort((a, b) => (b.chk.met! / b.chk.total!) - (a.chk.met! / a.chk.total!) || a.c.rank - b.c.rank)
    .slice(0, 3).map((x) => ({ symbol: x.c.symbol, met: x.chk.met!, total: x.chk.total! }));
  return {
    tier, horizon, screen_id: screen.id, finished_at: at, age_ms: now - at, stale: now - at > 2 * every, refresh_every_ms: every,
    picks: built.map((b) => b.pick), gate_error: gateError,
    hidden: { untradable: pool.length - tradableOnes.length, incomplete: incomplete.length, too_far: tooFar.length, ineligible: ineligible.length, ineligible_reasons: reasons, overflow: Math.max(0, passed.length - shown.length) + Math.max(0, want.length - cand.length) },
    closest, screened: pool.length,
    ai: built.some((b) => b.ai),
  };
}

// ---------------------------------------------------------------- 渲染

/** 证据时效:Updated X · next run ~Y;超过一个周期没更新写「was due」,超过两倍算过期 */
export function freshness(r: TierReport, now: number): string {
  const next = r.finished_at + r.refresh_every_ms;
  const done = `Updated ${asOfLabel(r.finished_at, now)}`;
  if (r.stale) return `${done} · not refreshed for over 2× the refresh interval, treat as stale`;
  if (next < now) return `${done} · next run was due ${asOfLabel(next, now)}, not finished yet`;
  return `${done} · next run ~${asOfLabel(next, now)}`;
}

/** 价位类触发条件:实时价已经越过(突破位)时如实写出,下一轮筛选再确认 */
function crossedNote(p: Pick): string | null {
  const k = p.checklist, lp = p.live_price;
  if (lp === null || k.level === null || !k.open.some((o) => o.key === 'breakout')) return null;
  const crossed = k.direction === 'short' ? lp < k.level : lp > k.level;
  return crossed ? `now ${price(lp)}, already ${k.direction === 'short' ? 'below' : 'above'} the level intrabar; a ${k.timeframe ?? 'bar'} close there completes it` : null;
}

function pickLine(p: Pick, i: number, horizon: Horizon, now: number, compact = false): string {
  const k = p.checklist;
  const head = `${i}. ${baseOf(p.symbol)}${p.strategy_name ? ` · ${p.strategy_name}` : ''}${k.direction ? ` · bias ${up(k.direction)}` : ''}`;
  const score = k.met !== null && k.total !== null ? `Checklist ${k.met}/${k.total}${k.status === 'complete' ? ' met' : ''}` : `fit ${num(p.fit_score)}`;
  const lastTxt = k.last_close !== null ? `last close ${price(k.last_close)}${k.as_of ? ` at ${asOfLabel(k.as_of, now)}` : ''}` : null;
  const liveTxt = p.live_price !== null ? `now ${price(p.live_price)}` : null;
  const segs: string[] = [head, score];
  if (k.status === 'complete') {
    if (k.level !== null) segs.push(`breakout level ${price(k.level)}`);
    const px = [lastTxt, liveTxt].filter(Boolean).join(', ');
    if (px) segs.push(px);
  } else {
    const crossed = crossedNote(p);
    const dist = p.trigger_distance;
    const distTxt = dist && dist.abs > 0 ? distanceText(dist) : dist && !crossed ? 'price inside the trigger zone now' : null;
    const px = [lastTxt, liveTxt].filter(Boolean).join(', ');
    const paren = crossed ?? (px ? `${px}${distTxt ? `; ${distTxt}` : ''}` : distTxt);
    segs.push(`Trigger: ${k.triggers.join(' + ')}${paren ? ` (${paren})` : ''}`);
  }
  if (!compact) {
    const g = p.gate;
    if (g.eligible && g.direction_text) segs.push(g.direction_text);
    else if (!g.eligible) segs.push(`${cap(HORIZON_EN[horizon])} gate: ${g.reason_text ?? 'unavailable'}`);
    if (p.reasons.length) segs.push(`Basis: ${p.reasons.join('; ')}`);
  }
  return segs.join(' · ');
}
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function hiddenLine(r: TierReport): string | null {
  const hz = HORIZON_EN[r.horizon];
  const parts: string[] = [];
  if (r.hidden.incomplete) parts.push(`${r.hidden.incomplete} with ${MAX_OPEN + 1}+ checklist conditions open or no concrete trigger`);
  if (r.hidden.too_far) parts.push(`${r.hidden.too_far} with a price trigger too far from the current price to count as near (over ${RADAR_NEAR_MAX.atr} ATR or ${RADAR_NEAR_MAX.pct[r.tier] * 100}%)`);
  if (r.hidden.ineligible) parts.push(`${r.hidden.ineligible} failed the ${hz} liquidity gate (${Object.entries(r.hidden.ineligible_reasons).map(([k, n]) => `${reasonLabel(k)} ×${n}`).join(', ')})`);
  if (r.hidden.untradable) parts.push(`${r.hidden.untradable} without an OKX USDT perp`);
  if (r.hidden.overflow) parts.push(`${r.hidden.overflow} beyond the top ${RADAR_FEED_TOP}`);
  const closest = r.closest.length && !r.picks.length ? ` Closest: ${r.closest.map((c) => `${baseOf(c.symbol)} ${c.met}/${c.total}`).join(', ')}.` : '';
  return parts.length ? `Not listed (of ${r.screened} screened): ${parts.join('; ')}.${closest}` : closest.trim() || null;
}

function tierPayload(r: TierReport): Record<string, unknown> {
  return {
    tier: r.tier, horizon: r.horizon, screen_id: r.screen_id, finished_at: r.finished_at, age_ms: r.age_ms, stale: r.stale,
    refresh_every_ms: r.refresh_every_ms, gate_error: r.gate_error, eligible_only: RADAR_ELIGIBLE_ONLY[r.tier], screened: r.screened,
    hidden: r.hidden, closest: r.closest, picks: r.picks,
  };
}

function methodLine(horizonLabel: string, ai: boolean, tier?: RadarTier): string {
  const cap = tier ? `${RADAR_NEAR_MAX.pct[tier] * 100}%` : 'the tier cap (short-term 3%, swing 6%, weekly 10%)';
  return `Method: rule-based radar screening. Listed only when the strategy checklist is fully met, or at most ${MAX_OPEN} conditions are open and each has a concrete trigger (shown; a price trigger must sit within ${RADAR_NEAR_MAX.atr} ATR of the tier timeframe and within ${cap} of the current price), and the symbol passes the ${horizonLabel} liquidity gate (volume, depth, listing age) and has an OKX USDT perp. Complete setups first, then by radar rank. Trigger levels come from the screening snapshot; the next run re-checks them. ${ai ? 'Basis lines marked [AI] were written by the screening model; everything else is computed by code.' : 'Everything is computed by code.'}`;
}

const counts = (r: TierReport): { done: number; near: number } => ({ done: r.picks.filter((p) => p.checklist.status === 'complete').length, near: r.picks.filter((p) => p.checklist.status !== 'complete').length });

function tierSummary(r: TierReport): string {
  const { done, near } = counts(r);
  const stale = r.stale ? ' · stale' : '';
  if (!r.picks.length) return `${TIER_LABEL[r.tier]}: no symbol has the full checklist met or sits within ${MAX_OPEN} named triggers this round (${r.screened} screened)${stale}`;
  const parts = [...(done ? [`${plural(done, 'setup')} with the full checklist met`] : []), ...(near ? [`${near} within ${MAX_OPEN} named triggers`] : [])];
  return `${TIER_LABEL[r.tier]}: ${parts.join(', ')} (${r.screened} screened)${stale}`;
}

/** 订阅信号行(【Futures】类型头、≤200 字):清单全过的与差一步的(带最短触发) */
export function radarSignal(r: TierReport): string {
  const { done } = counts(r);
  const met = r.picks.filter((p) => p.checklist.status === 'complete').map((p) => baseOf(p.symbol));
  const nearPicks = r.picks.filter((p) => p.checklist.status !== 'complete');
  const near = nearPicks.slice(0, 3).map((p) => {
    const t = p.checklist.open[0]?.trigger;
    const lvl = p.checklist.open.find((o) => o.key === 'breakout') && p.checklist.level !== null ? `${p.checklist.timeframe ?? ''} close ${p.checklist.direction === 'short' ? '<' : '>'} ${price(p.checklist.level)}`.trim() : t && t.length <= 28 ? t : 'one condition';
    return `${baseOf(p.symbol)} (${lvl})`;
  });
  const body = r.picks.length
    ? [done ? `Checklist met: ${met.join(', ')}` : null, near.length ? `Near: ${near.join(', ')}${nearPicks.length > near.length ? ` +${nearPicks.length - near.length} more` : ''}` : null].filter(Boolean).join('. ')
    : `No qualifying setups this round (${r.screened} screened)`;
  return infoSignal(`【Futures】OKX USDT perps | Radar · ${TIER_LABEL[r.tier]}`, body);
}

export function renderTierPush(r: TierReport, now = r.finished_at + r.age_ms): ChannelPush {
  const hz = HORIZON_EN[r.horizon];
  const hidden = hiddenLine(r);
  const lines = [
    `Evidence freshness: ${freshness(r, now)}`,
    ...(r.gate_error ? [`Note: the liquidity-gate data fetch failed, so the ${hz} gate could not be applied this round`] : []),
    ...(r.picks.length ? r.picks.map((p, i) => pickLine(p, i + 1, r.horizon, now)) : ['No symbols to list this round.']),
    ...(hidden ? [hidden] : []),
    methodLine(hz, r.ai, r.tier),
  ];
  return channelPush('radar_feed', `radar:${r.tier}:${r.screen_id}`, `Radar Picks · ${TIER_LABEL[r.tier]} · ${utcLabel(r.finished_at)}`, tierSummary(r), lines,
    { kind: 'tier_update', ...tierPayload(r) }, { ai: r.ai, signal: radarSignal(r) });
}

export const radarFeedChannel: SubscriptionChannel<RadarDeps> = {
  key: 'radar_feed',
  every_ms: 5 * 60_000,

  async tick(deps) {
    // 首次启用:各档当前这一轮已经在欢迎包里给过了,只记游标不推,免得开服头 15 分钟连推三档旧榜
    if (!deps.state.get('radar_feed:primed')) {
      for (const tier of RADAR_TIERS) { const s = latestDone(deps, tier); if (s) deps.state.set(STATE_KEY(tier), s.id); }
      deps.state.set('radar_feed:primed', String(deps.now()));
      return null;
    }
    const fresh = RADAR_TIERS
      .map((tier, i) => ({ tier, i, screen: latestDone(deps, tier) }))
      .filter((x): x is { tier: RadarTier; i: number; screen: RadarScreenLike } => !!x.screen && deps.state.get(STATE_KEY(x.tier)) !== x.screen.id)
      .sort((a, b) => finishedAt(a.screen) - finishedAt(b.screen) || a.i - b.i);
    const next = fresh[0];
    if (!next) return null;
    let push: ChannelPush;
    try { push = renderTierPush(await buildReport(deps, next.tier, next.screen, RADAR_FEED_TOP), deps.now()); }
    catch (err) { deps.log('error', `radar_feed: ${next.tier}/${next.screen.id} 渲染失败: ${(err as Error).message}`); return null; }
    deps.state.set(STATE_KEY(next.tier), next.screen.id);
    return push;
  },

  async welcome(deps) {
    const now = deps.now();
    const reports: (TierReport | null)[] = [];
    for (const tier of RADAR_TIERS) {
      const s = latestDone(deps, tier);
      reports.push(s ? await buildReport(deps, tier, s, WELCOME_TOP) : null);
    }
    const lines = RADAR_TIERS.flatMap((tier, i) => {
      const r = reports[i];
      if (!r) return [`${TIER_LABEL[tier]}: not run yet`];
      return [
        `${TIER_LABEL[tier]} (${freshness(r, now)}):`,
        ...(r.picks.length ? r.picks.map((p, j) => `· ${pickLine(p, j + 1, r.horizon, now, true)}`) : [`· Nothing qualifies this round (${r.screened} screened)`]),
      ];
    });
    const ran = reports.filter((r): r is TierReport => !!r);
    const summary = ran.length
      ? `Latest round across the three radar tiers: ${ran.length}/3 tiers have run, ${ran.reduce((s, r) => s + r.picks.length, 0)} setups listed${ran.some((r) => r.stale) ? ', including stale tiers' : ''}`
      : 'No radar tier has run yet; you will get a push as soon as a round finishes';
    const payload = { kind: 'welcome', as_of: now, tiers: Object.fromEntries(RADAR_TIERS.map((t, i) => [t, reports[i] ? tierPayload(reports[i]!) : null])) };
    const ids = RADAR_TIERS.map((t, i) => `${t}=${reports[i]?.screen_id ?? 'none'}`).join(',');
    const picks = ran.flatMap((r) => r.picks.map((p) => baseOf(p.symbol)));
    const signal = infoSignal('【Futures】OKX USDT perps | Radar · All tiers', picks.length ? `Listed now: ${[...new Set(picks)].join(', ')}` : summary);
    return channelPush('radar_feed', `radar:welcome:${ids}`, `Radar Picks · All tiers (short-term / swing / weekly) · ${utcLabel(now)}`, summary,
      [...lines, 'From here on, each tier gets its own push whenever a round finishes: complete setups, near setups with their exact triggers, evidence freshness.', methodLine('per-horizon', ran.some((r) => r.ai))],
      payload, { ai: ran.some((r) => r.ai), signal });
  },
};
