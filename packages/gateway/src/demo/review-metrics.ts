import { HORIZON_POLICY, type StrategyHorizon } from './horizon.js';
// Boundary metrics computed by CODE, for the two decisions the model kept flipping on
// (docs/eval/results-2026-09-04.md 「去噪后的结论」: scan NO_TRADE↔WATCH 12 例, review HOLD↔EXIT 10 例).
// Each is handed to the model as ONE evidence line, so it reads a checklist instead of eyeballing
// differences — and so every number it may quote has a registered source (the 3 remaining
// hallucinated_numbers were all self-computed differences like "止损距离 249.66").
// Pure functions, no I/O. Formatting follows context.ts (decimals by price magnitude).

import type { TfFeatures } from './market.js';
import { tfToMs } from './market.js';
import { describeIndicators, indicatorSnapshot, trendStrengthOf, type IndicatorSnapshot } from './indicators.js';
import type { Kline } from './types.js';

/** Same decimals rule context.ts uses for structure evidence. */
export function priceDecimals(p: number): number {
  return p > 100 ? 0 : p > 1 ? 2 : 5;
}

function f(n: number | null | undefined, d: number): string {
  return n === null || n === undefined || !Number.isFinite(n) ? 'n/a' : n.toFixed(d);
}

const num = (s: string | null | undefined): number | null => {
  if (s === null || s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

// ------------------------------------------------------------------ scan checklist

/** playbook thresholds the checklist makes machine-checkable (mirrors DEFAULT_PLAYBOOK wording). */

/**
 * Minimum ATR% for a timeframe to be worth trading at all. This used to be ONE number (0.4 %), which
 * is a 4h threshold applied to 5m bars: on 5m almost nothing ever cleared it, so the box read
 * "不足" on every scan and the model learned to ignore it. Volatility scales with the square
 * root of time, so the floors do too (0.08 % x sqrt(minutes/5) - which is exactly where 0.15 / 0.30 /
 * 0.6 come from).
 */
export const ATR_PCT_FLOOR: Record<string, number> = { '1m': 0.04, '5m': 0.08, '15m': 0.15, '30m': 0.2, '1h': 0.3, '4h': 0.6, '1d': 1.5 };

/** The floor for `tf`: the table when it is listed, otherwise sqrt-of-time scaling off the 5m anchor. */
export function atrPctFloor(tf: string): number {
  const listed = ATR_PCT_FLOOR[tf];
  if (listed !== undefined) return listed;
  try {
    const minutes = tfToMs(tf) / 60_000;
    return Math.round(0.08 * Math.sqrt(minutes / 5) * 100) / 100;
  } catch {
    return 0.3;
  }
}

export const CHASE_ATR_MAX = 1.5;
export const RETEST_VOL_MIN = 1.0;
/** How many closed bars back a breakout still counts as "just happened" (1 = only the last bar). */
export const BREAKOUT_WINDOW = 1;

/**
 * The three numbers the scan checklist applies. They live in `breakout_retest`'s `params`, so a new
 * strategy version can move them without touching this file — `scanThresholdsOf(spec)` in
 * strategies.ts turns a spec into one of these. Omitted → the module defaults above.
 */
export interface ScanThresholds {
  trend_timeframes?: readonly [string, string];
  /** null / undefined = the per-timeframe `atrPctFloor(tf)` table. */
  atr_pct_floor?: number | null;
  chase_atr_max?: number;
  retest_vol_min?: number;
  /** > 1 only takes effect when the caller also hands in `klines` (the checklist needs the bars to look back). */
  breakout_window?: number;
}

export interface ScanChecklist {
  tf: string;
  atr_pct: number | null;
  /** The per-timeframe floor actually applied (ATR_PCT_FLOOR / atrPctFloor). */
  atr_floor: number;
  atr_ok: boolean;
  /** Indicator reads that make the WATCH boundary legible (null when no klines/snapshot were available). */
  rsi14: number | null;
  adx14: number | null;
  trend_strength: 'none' | 'weak' | 'moderate' | 'strong' | null;
  /** Bollinger width percentile over the trailing 90 bars (0-100): low = coiled, high = extended. */
  bb_width_rank_90: number | null;
  squeeze_on: boolean | null;
  squeeze_bars: number | null;
  /** Signed distance from the close to VWAP(day), in ATR (+ = above VWAP). */
  dist_to_vwap_atr: number | null;
  /** One-line dump of every indicator (describeIndicators), for callers that want the long form. */
  indicators_text: string | null;
  /** 1h and 4h EMA20-vs-EMA50 pointing the same way ('long' = both EMA20>EMA50), null when they disagree or data is missing. */
  trend_agree: 'long' | 'short' | null;
  trend_note: string;
  /** Distance from the last close to the breakout level in the agreed direction, in ATR. */
  dist_to_break_atr: number | null;
  within_chase: boolean;
  retest_confirmed: boolean;
  vol_ratio: number | null;
  price_above_ema20: boolean | null;
  /** The WATCH/NO_TRADE boundary, decided by code: 1h/4h agree AND ≤ 1.5 ATR from the level AND retest not yet confirmed. */
  watch_eligible: boolean;
  text: string;
}

function byTf(features: TfFeatures[], tf: string): TfFeatures | null {
  return features.find((x) => x.tf === tf) ?? null;
}

/** Direction of a timeframe's EMA20 vs EMA50 ('long' = EMA20 above EMA50). */
export function tfDirection(x: TfFeatures | null): 'long' | 'short' | null {
  if (!x) return null;
  return x.ema20 > x.ema50 ? 'long' : x.ema20 < x.ema50 ? 'short' : null;
}

/** 1h and 4h agreeing on direction; null when either is missing or they point opposite ways. */
export function trendAgreement(features: TfFeatures[], tfs: readonly [string, string] = ['1h', '4h']): 'long' | 'short' | null {
  const h1 = tfDirection(byTf(features, tfs[0]));
  const h4 = tfDirection(byTf(features, tfs[1]));
  return h1 !== null && h1 === h4 ? h1 : null;
}

/**
 * Did any of the last `window` CLOSED bars close beyond its own preceding 20-bar extreme? Only used
 * when a strategy widens `breakout_window` past 1 (the "突破发生在前几根、现在回来踩" shape); needs the
 * raw bars because TfFeatures only carries the newest window.
 */
export function brokeWithin(klines: readonly Kline[], dir: 'long' | 'short', window: number): boolean {
  const n = klines.length;
  for (let i = n - 1; i >= Math.max(21, n - window); i--) {
    const prior = klines.slice(Math.max(0, i - 20), i);
    if (prior.length < 20) break;
    const c = Number(klines[i]!.close);
    const level = dir === 'long' ? Math.max(...prior.map((k) => Number(k.high))) : Math.min(...prior.map((k) => Number(k.low)));
    if (dir === 'long' ? c > level : c < level) return true;
  }
  return false;
}

/**
 * `features[0]` is the judged timeframe (context.ts feeds [tf, 1h, 4h]).
 *
 * The indicator half of the checklist comes from `features[0].indicators` (tfFeatures computes it) and
 * falls back to computing it from `klines` when a caller hands the bars in directly - the old
 * one-argument call still works and simply reports the indicator boxes as n/a.
 */
export function scanChecklist(features: TfFeatures[], klines?: readonly Kline[], thresholds?: ScanThresholds): ScanChecklist | null {
  const base = features[0];
  if (!base) return null;
  const chaseMax = thresholds?.chase_atr_max ?? CHASE_ATR_MAX;
  const volMin = thresholds?.retest_vol_min ?? RETEST_VOL_MIN;
  const breakWindow = Math.max(1, Math.floor(thresholds?.breakout_window ?? BREAKOUT_WINDOW));
  const d = priceDecimals(base.last_close);
  const atrPct = base.last_close > 0 ? (base.atr14 / base.last_close) * 100 : null;
  const floor = thresholds?.atr_pct_floor ?? atrPctFloor(base.tf);
  const atrOk = atrPct !== null && atrPct >= floor;
  const snap: IndicatorSnapshot | null = base.indicators ?? (klines && klines.length ? indicatorSnapshot(klines, base.tf) : null);
  const agree = trendAgreement(features, thresholds?.trend_timeframes);
  const trendTfs = thresholds?.trend_timeframes ?? ['1h', '4h'];
  const h1 = byTf(features, trendTfs[0]!);
  const h4 = byTf(features, trendTfs[1]!);
  const dirText = (x: TfFeatures | null, tf: string): string => (x ? `${tf} ${x.ema20 > x.ema50 ? 'EMA20>EMA50(偏多)' : 'EMA20<EMA50(偏空)'}` : `${tf} 数据缺失`);
  const trendNote = agree === null ? `${dirText(h1, trendTfs[0]!)}、${dirText(h4, trendTfs[1]!)} → 不一致` : `${dirText(h1, trendTfs[0]!)}、${dirText(h4, trendTfs[1]!)} → 同向(${agree === 'long' ? '偏多' : '偏空'})`;
  const level = agree === 'long' ? base.swing_high_20 : agree === 'short' ? base.swing_low_20 : null;
  const distAtr = level !== null && base.atr14 > 0 ? Math.abs(base.last_close - level) / base.atr14 : null;
  const within = distAtr !== null && distAtr <= chaseMax;
  // The level a close is compared AGAINST must not contain that close's own bar, or the test is
  // arithmetically impossible (close ≤ high ≤ swing_high_20) and "回踩确认" can never fire — which is
  // exactly why three eval rounds and 668 live judgments produced zero PROPOSE
  // (docs/research/zero-propose-funnel-2026-09-05.md §1). triggers.ts always used the previous window;
  // this now does too, falling back to the old field only for features recorded before it existed.
  const breakLevel = agree === 'long' ? (base.swing_high_20_prev ?? base.swing_high_20) : agree === 'short' ? (base.swing_low_20_prev ?? base.swing_low_20) : null;
  const beyond = breakLevel !== null && (agree === 'long' ? base.last_close > breakLevel : base.last_close < breakLevel);
  const beyondRecent = beyond || (breakWindow > 1 && agree !== null && klines ? brokeWithin(klines, agree, breakWindow) : false);
  const retest = beyondRecent && base.vol_ratio_20 >= volMin;
  const watch = agree !== null && within && !retest;
  const adxValue = snap?.adx14 && Number.isFinite(snap.adx14.adx) ? snap.adx14.adx : null;
  const strength = snap ? trendStrengthOf(adxValue) : null;
  const strengthLabel: Record<'none' | 'weak' | 'moderate' | 'strong', string> = { none: '无趋势', weak: '趋势弱', moderate: '趋势中', strong: '趋势强' };
  const squeezeOn = snap?.squeeze ? snap.squeeze.on : null;
  const squeezeBars = snap?.squeeze ? snap.squeeze.bars_on : null;
  const bbRank = snap?.bb_width_rank_90 ?? null;
  const vwapAtr = snap?.dist_to_vwap_atr ?? null;
  // One extra line, five boxes: momentum (RSI), trend quality (ADX), compression (BB width percentile +
  // squeeze) and where price sits against the day's volume-weighted average. Together they are what
  // separates "quiet coil worth watching" from "already extended, nothing left to chase".
  const indicatorLine =
    snap === null
      ? null
      : [
          `RSI14 ${f(snap.rsi14, 1)}`,
          `ADX14 ${f(adxValue, 1)}(${strength ? strengthLabel[strength] : 'n/a'})`,
          `BB宽 ${bbRank === null ? 'n/a' : `${Math.round(bbRank)} 分位`}`,
          `挤压 ${squeezeOn === null ? 'n/a' : squeezeOn ? `是(${squeezeBars} 根)` : '否'}`,
          `距VWAP ${vwapAtr === null ? 'n/a' : `${vwapAtr >= 0 ? '+' : ''}${vwapAtr.toFixed(2)}`} ATR`,
        ].join(',');

  const text = [
    `周期 ${base.tf}`,
    `ATR% ${f(atrPct, 2)}%(门槛 ${floor.toFixed(2)}% → ${atrOk ? '达标' : '不足'})`,
    trendNote,
    agree === null ? `突破位:${trendTfs.join('/')} 不同向,不取` : `${agree === 'long' ? '上方 20 根高' : '下方 20 根低'} ${f(level, d)},距 ${f(distAtr, 2)} ATR(上限 ${chaseMax.toFixed(1)} → ${within ? '在射程内' : '已超出'})`,
    `${breakWindow > 1 ? `近 ${breakWindow} 根内` : '最近一根'}${beyondRecent ? '已' : '尚未'}收破突破位 ${f(breakLevel, d)};量比 ${f(base.vol_ratio_20, 2)}(门槛 ${volMin.toFixed(2)})→ 回踩确认 ${retest ? '是' : '否'}`,
    `价在 EMA20 ${base.last_close > base.ema20 ? '上' : '下'}`,
    ...(indicatorLine ? [indicatorLine] : []),
    `watch_eligible=${watch ? '是' : '否'}(${trendTfs.join('/')} 同向 且 距突破位 ≤ ${chaseMax.toFixed(1)} ATR 且 回踩未确认)`,
  ].join(';');
  return {
    tf: base.tf,
    atr_pct: atrPct,
    atr_floor: floor,
    atr_ok: atrOk,
    rsi14: snap?.rsi14 ?? null,
    adx14: adxValue,
    trend_strength: strength,
    bb_width_rank_90: bbRank,
    squeeze_on: squeezeOn,
    squeeze_bars: squeezeBars,
    dist_to_vwap_atr: vwapAtr,
    indicators_text: snap ? describeIndicators(snap) : null,
    trend_agree: agree,
    trend_note: trendNote,
    dist_to_break_atr: distAtr,
    within_chase: within,
    retest_confirmed: retest,
    vol_ratio: base.vol_ratio_20,
    price_above_ema20: base.last_close > base.ema20,
    watch_eligible: watch,
    text,
  };
}

// ------------------------------------------------------------------ review metrics

export interface ReviewMetricsInput {
  horizon?: StrategyHorizon;
  now: number;
  side: 'long' | 'short';
  status: 'pending_entry' | 'in_position';
  /** Mark price (decimal string, as the thread/market carry it). */
  mark: string | null;
  entry: string | null;
  entry_zone: [string, string] | null;
  stop: string | null;
  take_profits: string[];
  invalidation_text: string | null;
  opened_at: number | null;
  created_at: number;
  /** Milliseconds per bar of the thread's timeframe (0 = unknown → bars_held null). */
  tf_ms: number;
  /** The judged timeframe's features, for the last CLOSED candle and the structure check. */
  features: TfFeatures[];
  /** v7:判断周期的已收盘 K 线(最后一根 = 最近已收盘),用来数「连续几根越过失效价」;缺 → 只看最近一根。 */
  klines?: readonly Kline[];
  /** v7:失效确认口径(workflow;eval 不传用默认 2 / 0.2)。 */
  invalidation_confirm_bars?: number;
  invalidation_buffer_atr?: number;
}

export interface ReviewMetrics {
  /** |entry − stop| per unit — the R unit everything else is expressed in. */
  risk_per_unit: number | null;
  unrealized_r: number | null;
  unrealized_pct: number | null;
  dist_to_stop_r: number | null;
  dist_to_stop_pct: number | null;
  /** First take-profit distance from the mark, in R (how much further the trade has to run). */
  tp1_r: number | null;
  /** First take-profit as a reward:risk multiple of the entry (the plan's R). */
  tp1_from_entry_r: number | null;
  bars_held: number | null;
  minutes_held: number;
  /** The last CLOSED candle closed on the wrong side of the stop. */
  closed_beyond_stop: boolean | null;
  invalidation_price: number | null;
  closed_beyond_invalidation: boolean | null;
  /** v7:连续多少根已收盘 K 线越过失效价(0 = 最近一根没越过);越过深度(ATR 计,正数 = 越过);是否达到确认口径。 */
  bars_beyond_invalidation: number | null;
  invalidation_depth_atr: number | null;
  invalidation_confirmed: boolean | null;
  /** pending_entry only: the mark sits inside the entry zone (or at the limit price ±0.1 %). */
  in_entry_zone: boolean | null;
  /** 1h/4h agreement pointing against the thread, or price on the wrong side of EMA20. */
  structure_against: boolean;
  /** Current EMA20-vs-EMA50 direction on 15m / 1h (null = flat or missing). */
  trend_now_15m: 'long' | 'short' | null;
  trend_now_h1: 'long' | 'short' | null;
  /** Either current 15m or 1h direction disagrees with the position side; allows discretionary EXIT. */
  thesis_trend_flipped: boolean;
  text: string;
}

/**
 * A price mentioned in the thread's free-text invalidation ("15m 收盘升破止损 63820.86"), when one is
 * within ±20 % of the entry (so a "3 根" or a percentage is not mistaken for a level). Never invents a number.
 */
export function parseInvalidationPrice(text: string | null, ref: number | null): number | null {
  if (!text || ref === null || !Number.isFinite(ref) || ref <= 0) return null;
  for (const m of text.matchAll(/(?<![A-Za-z0-9_.])\d+(?:,\d{3})*(?:\.\d+)?/g)) {
    const v = Number(m[0].replace(/,/g, ''));
    if (!Number.isFinite(v) || v <= 0) continue;
    if (Math.abs(v - ref) / ref <= 0.2) return v;
  }
  return null;
}

export function reviewMetrics(inp: ReviewMetricsInput): ReviewMetrics | null {
  const mark = num(inp.mark);
  const entry = num(inp.entry);
  const stop = num(inp.stop);
  const tps = inp.take_profits.map(num).filter((x): x is number => x !== null);
  const long = inp.side === 'long';
  const hp = inp.horizon && inp.horizon !== 'scalp' ? HORIZON_POLICY[inp.horizon] : null;
  const base = hp ? byTf(inp.features, hp.timeframe) : inp.features[0] ?? null;
  const d = priceDecimals(mark ?? entry ?? base?.last_close ?? 1);
  // The R unit is a *difference*: at 0 decimals "250" hides the 249.66 the model then "computed" itself
  // (the whole hallucinated_numbers class in runs/pi-v3-s5). Always print it with two more digits.
  const rd = d + 2;
  const risk = entry !== null && stop !== null ? Math.abs(entry - stop) : null;
  const sign = long ? 1 : -1;
  const unrealized = mark !== null && entry !== null ? sign * (mark - entry) : null;
  const unrealizedR = unrealized !== null && risk ? unrealized / risk : null;
  const unrealizedPct = unrealized !== null && entry ? (unrealized / entry) * 100 : null;
  const distStop = mark !== null && stop !== null ? sign * (mark - stop) : null;
  const distStopR = distStop !== null && risk ? distStop / risk : null;
  const distStopPct = distStop !== null && mark ? (Math.abs(distStop) / mark) * 100 : null;
  const tp1 = tps[0] ?? null;
  const tp1R = tp1 !== null && mark !== null && risk ? (sign * (tp1 - mark)) / risk : null;
  const tp1FromEntryR = tp1 !== null && entry !== null && risk ? (sign * (tp1 - entry)) / risk : null;
  const since = inp.status === 'in_position' ? (inp.opened_at ?? inp.created_at) : inp.created_at;
  const heldMs = Math.max(0, inp.now - since);
  const minutesHeld = Math.round(heldMs / 60_000);
  const barsHeld = inp.tf_ms > 0 ? Math.floor(heldMs / inp.tf_ms) : null;
  const lastClose = base ? base.last_close : null;
  const beyondStop = lastClose !== null && stop !== null ? (long ? lastClose < stop : lastClose > stop) : null;
  const invPrice = parseInvalidationPrice(inp.invalidation_text, entry ?? mark);
  const beyondInv = lastClose !== null && invPrice !== null ? (long ? lastClose < invPrice : lastClose > invPrice) : null;
  // v7:失效价不再是「一根越过就必须走」——数连续几根越过、越过多深(ATR),给模型一个确认口径(workflow 可调,记忆里的偏好可覆盖判断)。
  const confirmBars = Math.max(1, Math.round(inp.invalidation_confirm_bars ?? 2));
  const bufferAtr = Math.max(0, inp.invalidation_buffer_atr ?? 0.2);
  const atr = base?.atr14 ?? null;
  let barsBeyond: number | null = null;
  let depthAtr: number | null = null;
  let invConfirmed: boolean | null = null;
  if (invPrice !== null && lastClose !== null) {
    const closes = inp.klines && inp.klines.length ? inp.klines.filter((k) => k.close_time <= inp.now).map((k) => Number(k.close)) : [lastClose];
    let n = 0;
    for (let i = closes.length - 1; i >= 0; i--) {
      const c = closes[i]!;
      if (long ? c < invPrice : c > invPrice) n++;
      else break;
    }
    barsBeyond = n;
    depthAtr = atr && atr > 0 ? (long ? invPrice - lastClose : lastClose - invPrice) / atr : null;
    invConfirmed = n >= confirmBars && (depthAtr === null ? true : depthAtr >= bufferAtr);
  }
  const zone = inp.entry_zone ? (inp.entry_zone.map(num).filter((x): x is number => x !== null) as number[]) : [];
  const inZone = inp.status === 'pending_entry' && mark !== null ? (zone.length === 2 ? mark >= Math.min(zone[0]!, zone[1]!) && mark <= Math.max(zone[0]!, zone[1]!) : entry !== null ? Math.abs(mark - entry) / entry <= 0.001 : null) : null;
  const a = hp ? tfDirection(byTf(inp.features, hp.timeframe)) : null;
  const b = hp ? tfDirection(byTf(inp.features, hp.confirm)) : null;
  const agree = hp ? (a !== null && a === b ? a : null) : trendAgreement(inp.features);
  const againstTrend = agree !== null && agree !== inp.side;
  const againstEma = base ? (long ? base.last_close < base.ema20 : base.last_close > base.ema20) : false;
  const structureAgainst = againstTrend || againstEma;

  // Threads do not record the entry-time trend. This flag describes CURRENT disagreement,
  // not a historical crossover, and is independent of feature ordering / the judged timeframe.
  const trendNow15m = tfDirection(byTf(inp.features, hp?.timeframe ?? '15m'));
  const trendNowH1 = tfDirection(byTf(inp.features, hp?.confirm ?? '1h'));
  const thesisFlipped = [trendNow15m, trendNowH1].some((direction) => direction !== null && direction !== inp.side);
  const dirLabel = (x: 'long' | 'short' | null): string => (x === 'long' ? 'EMA20>EMA50(偏多)' : x === 'short' ? 'EMA20<EMA50(偏空)' : '无方向/缺失');

  const parts: string[] = [];
  parts.push(`${long ? '做多' : '做空'}${inp.status === 'in_position' ? '持仓中' : '挂单未成交'}`);
  parts.push(`标记 ${f(mark, d)},入场 ${f(entry, d)},止损 ${f(stop, d)},每张风险 ${f(risk, rd)}(=1R)`);
  if (inp.status === 'in_position') {
    parts.push(`浮盈 ${unrealizedR === null ? 'n/a' : `${unrealizedR >= 0 ? '+' : ''}${unrealizedR.toFixed(2)}R`}(${unrealizedPct === null ? 'n/a' : `${unrealizedPct >= 0 ? '+' : ''}${unrealizedPct.toFixed(2)}%`})`);
    parts.push(`距止损 ${distStopR === null ? 'n/a' : `${distStopR.toFixed(2)}R`}(${f(distStopPct, 2)}%${distStopR !== null && distStopR < 0 ? ',已在止损另一侧' : ''})`);
    parts.push(tp1 === null ? '第一止盈 无' : `第一止盈 ${f(tp1, d)},距现价 ${f(tp1R, 2)}R,相对入场 ${f(tp1FromEntryR, 2)}R`);
    parts.push(`已持有 ${barsHeld === null ? 'n/a' : `${barsHeld} 根`}${base ? ` ${base.tf}` : ''}(${minutesHeld} 分钟)`);
  } else {
    parts.push(inZone === null ? '入场区:未给' : `现价${inZone ? '在' : '不在'}入场区${zone.length === 2 ? ` ${f(zone[0]!, d)}–${f(zone[1]!, d)}` : ''}`);
    parts.push(`第一止盈 ${tp1 === null ? '无' : `${f(tp1, d)}(相对入场 ${f(tp1FromEntryR, 2)}R)`};已等待 ${barsHeld === null ? 'n/a' : `${barsHeld} 根`}${base ? ` ${base.tf}` : ''}(${minutesHeld} 分钟)`);
  }
  parts.push(`最近一根已收盘 K 线收 ${f(lastClose, d)}:${beyondStop === null ? '止损未知' : beyondStop ? '已越过止损一侧' : '未越过止损'}`);
  parts.push(
    invPrice === null
      ? '失效价:线程未给可比价位'
      : `失效价 ${f(invPrice, d)}:${beyondInv ? `已越过,连续 ${barsBeyond} 根,深度 ${depthAtr === null ? 'n/a' : `${depthAtr.toFixed(2)} ATR`}` : '未越过'}(确认口径:连续 ≥ ${confirmBars} 根且深度 ≥ ${bufferAtr.toFixed(2)} ATR;距入场 ${entry !== null && atr ? `${(Math.abs(entry - invPrice) / atr).toFixed(2)} ATR` : 'n/a'}${entry !== null && risk ? `=${(Math.abs(entry - invPrice) / risk).toFixed(2)}R` : ''}) → 失效确认=${invConfirmed === null ? 'n/a' : invConfirmed ? '是' : '否'}`,
  );
  const trendText = agree === null ? `${hp ? `${hp.timeframe}/${hp.confirm}` : '1h/4h'} 不同向` : `${hp ? `${hp.timeframe}/${hp.confirm}` : '1h/4h'} 同向(${agree === 'long' ? '偏多' : '偏空'}),与本线程方向${againstTrend ? '相反' : '一致'}`;
  const emaText = base ? `价在 EMA20 ${base.last_close > base.ema20 ? '上' : '下'}(对${long ? '多' : '空'}${againstEma ? '不利' : '有利'})` : '价 vs EMA20 n/a';
  parts.push(`结构:${trendText};${emaText} → 结构转弱=${structureAgainst ? '是' : '否'}`);
  parts.push(
    `论点趋势:${hp?.timeframe ?? '15m'} ${dirLabel(trendNow15m)}、${hp?.confirm ?? '1h'} ${dirLabel(trendNowH1)},本线程${long ? '做多' : '做空'}(按当前方向与持仓是否相反判,不代表入场以来发生交叉) → 论点趋势翻转=${thesisFlipped ? '是' : '否'}`,
  );

  return {
    risk_per_unit: risk,
    unrealized_r: unrealizedR,
    unrealized_pct: unrealizedPct,
    dist_to_stop_r: distStopR,
    dist_to_stop_pct: distStopPct,
    tp1_r: tp1R,
    tp1_from_entry_r: tp1FromEntryR,
    bars_held: barsHeld,
    minutes_held: minutesHeld,
    closed_beyond_stop: beyondStop,
    invalidation_price: invPrice,
    closed_beyond_invalidation: beyondInv,
    bars_beyond_invalidation: barsBeyond,
    invalidation_depth_atr: depthAtr,
    invalidation_confirmed: invConfirmed,
    in_entry_zone: inZone,
    structure_against: structureAgainst,
    trend_now_15m: trendNow15m,
    trend_now_h1: trendNowH1,
    thesis_trend_flipped: thesisFlipped,
    text: parts.join(';'),
  };
}
