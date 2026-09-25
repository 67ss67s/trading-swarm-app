/**
 * Radar 的筛选 routine(docs/design/screener-radar-2026-09-05.md;
 * notebook §11.1「情报与机会」的第一段:数据 → Radar → 候选 → Thread Manager)。
 *
 * 要回答的问题:**现在这一刻,哪个币 × 哪条策略最值得做**。判断 Agent 只跟筛选器捞上来的那几个币,
 * 而不是永远盯着写死的四个。
 *
 * 三条纪律:
 *  1. **打分是确定性的。** `fit_score`、条件通过与否、前瞻期望全部由代码算,复算得到同一个数。
 *     模型只做一件事:在已经排好序的前 25 张卡里挑一个短名单并给一句人话理由。
 *  2. **模型不许造数。** 它那句理由里任何 ≥ 3 位的数字必须在卡片里出现过,否则整行丢掉
 *     (与 schema.ts `findMemoryNumberLeaks` 同一套口径)。
 *  3. **Radar 只提议。** 产物是 `watch_candidates` + 一条给 Gate Captain 的 handoff + 一份
 *     watchlist 提案。默认要人点「应用」;`screener_apply: 'auto'` 时也只写 `workflow.watchlist`,
 *     绝不碰风险/杠杆/执行字段。
 *
 * 复用而不是重写:条件判定走 funnel.ts 的 `computeMetrics` / `evaluateBar`(与漏斗、回测同一口径),
 * 指标走 indicators.ts,回归概率走 reversion-stats.ts,K 线走 backtest.ts 的磁盘缓存。
 */

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Brain } from './brain.js';
import { estimateCny } from './brain.js';
import {
  CURRENT_THRESHOLDS,
  computeMetrics,
  evaluateBar,
  loadFunnelSeries,
  scoreCandidate,
  OUTCOME_DEFAULTS,
  DEFAULT_FUNNEL_SYMBOLS,
  listTradableSymbols,
  notListedLabel,
  type BarMetrics,
  type ConditionEval,
  type FunnelThresholds,
  type OutcomeParams,
  type SeriesBundle,
} from './funnel.js';
import { indicatorSnapshot, type IndicatorSnapshot } from './indicators.js';
import { marketExchange, tfToMs } from './market.js';
import { okxGet } from './market-okx.js';
import { looksExcluded } from './research/batch/universe.js';
import { currentDailyScan, currentUniverse } from './universe-okx.js';
import { reversionCell, reversionStats, type ReversionStats } from './reversion-stats.js';
import { extractJson } from './schema.js';
import { fundingZScore, type StrategyLibrary, type StrategySpec } from './strategies.js';
import type { Kline, Workflow } from './types.js';

// ---------------------------------------------------------------- 口径

/** 三条节奏。`swing` 与 `weekly` 用同一套(4h/1d)打分,只是跑得稀不稀。 */
export type ScreenHorizon = 'short' | 'swing' | 'weekly';
export const SCREEN_HORIZONS: ScreenHorizon[] = ['short', 'swing', 'weekly'];
export const HORIZON_LABEL: Record<ScreenHorizon, string> = { short: '短线(12h)', swing: '中线(3d)', weekly: '周线' };

export interface HorizonSpec {
  /** 打分用的基础周期。 */
  timeframe: string;
  /** 趋势确认周期(短线 1h/4h;中长线 4h/1d)。 */
  confirm_timeframe: string;
  /** 前瞻期望回看多少天。 */
  expectancy_days: number;
  /** 候选卡的有效期:过了就该重算,不该再当依据。 */
  ttl_ms: number;
  /** 结算参数(中长线止损放宽一点、持有更久)。 */
  outcome: OutcomeParams;
  cooldown_bars: number;
}

export const HORIZON_SPECS: Record<ScreenHorizon, HorizonSpec> = {
  short: { timeframe: '15m', confirm_timeframe: '1h', expectancy_days: 60, ttl_ms: 12 * 3_600_000, outcome: { ...OUTCOME_DEFAULTS }, cooldown_bars: 4 },
  // 4h 上 60 天只有 360 根,机会数会少到没法看:中长线一律回看 180 天。
  swing: { timeframe: '4h', confirm_timeframe: '1d', expectancy_days: 180, ttl_ms: 72 * 3_600_000, outcome: { stop_atr: 1, tp_r: 2, horizon_bars: 30 }, cooldown_bars: 3 },
  weekly: { timeframe: '4h', confirm_timeframe: '1d', expectancy_days: 180, ttl_ms: 7 * 86_400_000, outcome: { stop_atr: 1, tp_r: 2, horizon_bars: 42 }, cooldown_bars: 3 },
};

/** `okx_all` = OKX 全市场(每日全市场扫描的候选优先,再按 24h 成交额补齐;universe-okx.ts)。 */
export type ScreenUniverse = 'watchlist+whitelist' | 'top_volume' | 'explicit' | 'okx_all';
export const SCREEN_UNIVERSES: ScreenUniverse[] = ['watchlist+whitelist', 'top_volume', 'explicit', 'okx_all'];
export type ScreenApplyMode = 'propose' | 'auto';

/** 便宜大脑那一次调用的预算上限(¥)。超了只记账 + 告警,不会中途砍断已经发出去的请求。 */
export const BRAIN_BUDGET_CNY = 0.02;
/** 递给模型的卡片数上限(也是 prompt 的天花板)。 */
export const BRAIN_TOP_CARDS = 25;

// ---------------------------------------------------------------- 机会卡

export interface FitCondition {
  key: string;
  label: string;
  pass: boolean;
  /** 差一点点就过(阈值放宽 ~25% 就成立);算半分。 */
  near: boolean;
  detail: string;
}

export interface FitExpectancy {
  days: number;
  setups: number;
  per_week: number;
  n: number;
  win_rate: number | null;
  expectancy_r: number | null;
}

export interface StrategyFit {
  strategy_id: string;
  name: string;
  version: number;
  status: string;
  /** 0..1:通过的条件数 +(差一点的 × 0.5)÷ 条件总数。纯代码。 */
  fit_score: number;
  passed: number;
  near: number;
  total: number;
  /** 方向:条件成立时该往哪边做;不成立时 null。 */
  direction: 'long' | 'short' | null;
  conditions: FitCondition[];
  reasons: string[];
  /** 这条策略在这个币上、过去 N 天的机械前瞻期望;算不动的策略是 null。 */
  expectancy: FitExpectancy | null;
  expectancy_note: string | null;
}

export interface OpportunityCard {
  symbol: string;
  horizon: ScreenHorizon;
  timeframe: string;
  confirm_timeframe: string;
  as_of: number;
  bars: number;
  last_close: number | null;
  trend: {
    base_dir: 'long' | 'short' | null;
    confirm_dir: 'long' | 'short' | null;
    agree: 'long' | 'short' | null;
    adx_base: number | null;
    adx_confirm: number | null;
    note: string;
  };
  atr_pct: number | null;
  atr_pct_rank_90: number | null;
  bb_width_rank_90: number | null;
  squeeze_on: boolean | null;
  squeeze_bars: number | null;
  breakout: {
    level_long: number | null;
    level_short: number | null;
    dist_long_atr: number | null;
    dist_short_atr: number | null;
    bars_since_up: number;
    bars_since_down: number;
    vol_ratio: number | null;
  };
  funding: { rate_pct: number | null; z_30d: number | null; samples: number };
  reversion: { text: string; best_prob: number | null; best_k: number | null; best_horizon: number | null } | null;
  daily_regime: string | null;
  volume: { quote_24h: number | null; rank: number | null; of: number };
  strategies: StrategyFit[];
  best: { strategy_id: string; fit_score: number } | null;
  note: string | null;
}

// ---------------------------------------------------------------- 打分

function cond(key: string, label: string, pass: boolean, near: boolean, detail: string): FitCondition {
  return { key, label, pass, near: !pass && near, detail };
}

function score(conds: FitCondition[]): { fit: number; passed: number; near: number } {
  const passed = conds.filter((c) => c.pass).length;
  const near = conds.filter((c) => c.near).length;
  return { fit: conds.length ? Math.round(((passed + near * 0.5) / conds.length) * 1000) / 1000 : 0, passed, near };
}

const n2 = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : v.toFixed(2));
const n0 = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : v.toFixed(0));

/** 一条策略的参数 → funnel 的阈值。`breakout_level` 恒为 `prior`:`self` 口径下突破永不可达。 */
function thresholdsFor(spec: StrategySpec, base: FunnelThresholds): FunnelThresholds {
  const p = (k: string, d: number): number => spec.params[k]?.value ?? d;
  return {
    ...base,
    breakout_level: 'prior',
    vol_mode: 'either',
    chase_atr_max: p('chase_atr_max', base.chase_atr_max),
    retest_vol_min: p('retest_vol_min', base.retest_vol_min),
    range_vol_min: p('range_vol_min', base.range_vol_min),
    breakout_window: Math.max(1, Math.round(p('breakout_window', 12))),
  };
}

interface FitInput {
  m: BarMetrics;
  snap: IndicatorSnapshot | null;
  reversion: ReversionStats | null;
  now: number;
  minutes_to_funding: number | null;
  funding_pct: number | null;
  funding_z: number | null;
}

/**
 * 一条策略当前的契合度。返回的条件表是**这条策略自己清单里的条件**,不是七条通用条件 ——
 * 「压缩→扩张」不该因为 1h/4h 不同向就被扣分,「区间均值回归」更是要求趋势**不**成立。
 */
export function fitConditions(spec: StrategySpec, inp: FitInput): { conditions: FitCondition[]; direction: 'long' | 'short' | null; thresholds: FunnelThresholds } {
  const { m, snap } = inp;
  const th = thresholdsFor(spec, CURRENT_THRESHOLDS);
  const p = (k: string, d: number): number => spec.params[k]?.value ?? d;
  const adx = snap?.adx14 && Number.isFinite(snap.adx14.adx) ? snap.adx14.adx : null;

  const evOf = (patch: Partial<FunnelThresholds> = {}): ConditionEval => evaluateBar(m, { ...th, ...patch });

  switch (spec.id === 'swing_breakout_retest' || spec.id === 'position_breakout_retest' ? 'breakout_retest' : spec.id) {
    case 'breakout_retest': {
      const ev = evOf();
      const since = ev.dir === 'long' ? m.bars_since_up : m.bars_since_down;
      const breakVol = ev.dir === 'long' ? m.break_vol_up : m.break_vol_down;
      const conditions = [
        cond('atr_ok', 'ATR% ≥ 分周期门槛', ev.pass.atr_ok, m.atr_pct >= m.atr_floor * 0.8, `ATR% ${n2(m.atr_pct)}(门槛 ${n2(m.atr_floor)})`),
        cond('trend_agree', '1h/4h EMA20-vs-EMA50 同向', ev.pass.trend_agree, m.dir_h1 !== null, ev.dir_trend ? `同向(${ev.dir_trend === 'long' ? '偏多' : '偏空'})` : '不同向'),
        cond('within_chase', `距突破位 ≤ ${th.chase_atr_max} ATR`, ev.pass.within_chase, ev.dist_atr <= th.chase_atr_max * 1.25, `距 ${n2(ev.dist_atr)} ATR`),
        cond('breakout', `${th.breakout_window} 根内收破突破位`, ev.pass.breakout, since >= 0 && since < th.breakout_window * 2, since < 0 ? '窗口内没有突破' : `${since} 根前突破`),
        cond('retest_vol', `量比 ≥ ${th.retest_vol_min}`, ev.pass.retest_vol, m.vol_ratio >= th.retest_vol_min * 0.8 || (breakVol !== null && breakVol >= th.retest_vol_min * 0.8), `当根量比 ${n2(m.vol_ratio)},突破那根 ${n2(breakVol)}`),
        cond('funding_ok', '资金费率绝对值不极端', ev.pass.funding_ok, false, `${m.funding_abs_pct === null ? 'n/a' : `${n2(m.funding_abs_pct)}%`}(上限 ${th.funding_abs_max}%)`),
        cond('regime_ok', '日线状态不反对该方向', ev.pass.regime_ok, false, `日线 ${m.regime ?? 'n/a'}`),
      ];
      return { conditions, direction: ev.dir_trend, thresholds: th };
    }

    case 'mtf_alignment': {
      const veto = p('veto_atr', 1);
      const ev = evOf({ trend_mode: 'h1_veto', h4_veto_atr: veto });
      const since = ev.dir === 'long' ? m.bars_since_up : m.bars_since_down;
      const conditions = [
        cond('atr_ok', 'ATR% ≥ 分周期门槛', ev.pass.atr_ok, m.atr_pct >= m.atr_floor * 0.8, `ATR% ${n2(m.atr_pct)}(门槛 ${n2(m.atr_floor)})`),
        cond('confirm_dir', '确认周期方向明确(高周期只做否决)', ev.pass.trend_agree, m.dir_h1 !== null, ev.dir_trend ? `确认周期偏${ev.dir_trend === 'long' ? '多' : '空'}` : `高周期反向且距 EMA20 > ${veto} ATR,否决`),
        cond('within_chase', `距突破位 ≤ ${th.chase_atr_max} ATR`, ev.pass.within_chase, ev.dist_atr <= th.chase_atr_max * 1.25, `距 ${n2(ev.dist_atr)} ATR`),
        cond('breakout', `${th.breakout_window} 根内收破突破位`, ev.pass.breakout, since >= 0 && since < th.breakout_window * 2, since < 0 ? '窗口内没有突破' : `${since} 根前突破`),
        cond('regime_ok', '日线状态不反对该方向', ev.pass.regime_ok, false, `日线 ${m.regime ?? 'n/a'}`),
      ];
      return { conditions, direction: ev.dir_trend, thresholds: { ...th, trend_mode: 'h1_veto', h4_veto_atr: veto } };
    }

    case 'vol_compression_expansion': {
      const ev = evOf();
      const rankMax = p('bb_width_rank_max', 20);
      const barsMin = p('squeeze_bars_min', 6);
      const spikeMin = p('vol_spike_min', 1.8);
      const rank = snap?.bb_width_rank_90 ?? null;
      const sqBars = snap?.squeeze?.bars_on ?? null;
      const compressed = (rank !== null && rank <= rankMax) || (sqBars !== null && sqBars >= barsMin);
      const compressedNear = (rank !== null && rank <= rankMax * 1.5) || (sqBars !== null && sqBars >= barsMin * 0.6);
      const since = ev.dir === 'long' ? m.bars_since_up : m.bars_since_down;
      const breakVol = ev.dir === 'long' ? m.break_vol_up : m.break_vol_down;
      const spikeVol = Math.max(m.vol_ratio, breakVol ?? 0);
      const conditions = [
        cond('compressed', `带宽分位 ≤ ${rankMax}% 或 squeeze ≥ ${barsMin} 根`, compressed, compressedNear, `带宽 90 根分位 ${n0(rank)}%,squeeze ${snap?.squeeze?.on ? '开' : '关'} 连续 ${sqBars ?? 0} 根`),
        cond('expansion_vol', `扩张量比 ≥ ${spikeMin}`, spikeVol >= spikeMin, spikeVol >= spikeMin * 0.8, `当根 ${n2(m.vol_ratio)},突破那根 ${n2(breakVol)}`),
        cond('breakout', `${th.breakout_window} 根内收破压缩区间`, ev.pass.breakout, since >= 0 && since < th.breakout_window * 2, since < 0 ? '窗口内没有突破' : `${since} 根前突破`),
        cond('within_chase', `距突破位 ≤ ${th.chase_atr_max} ATR`, ev.pass.within_chase, ev.dist_atr <= th.chase_atr_max * 1.25, `距 ${n2(ev.dist_atr)} ATR`),
        cond('atr_ok', 'ATR% ≥ 分周期门槛', ev.pass.atr_ok, m.atr_pct >= m.atr_floor * 0.8, `ATR% ${n2(m.atr_pct)}(门槛 ${n2(m.atr_floor)})`),
      ];
      return { conditions, direction: ev.pass.breakout ? ev.dir : null, thresholds: th };
    }

    case 'funding_oi_extreme': {
      const ev = evOf();
      const absMin = p('funding_abs_min', 0.05);
      const zMin = p('funding_z_min', 2);
      const beforeMin = p('minutes_before_funding', 30);
      const absPct = inp.funding_pct === null ? null : Math.abs(inp.funding_pct);
      const z = inp.funding_z === null ? null : Math.abs(inp.funding_z);
      const mins = inp.minutes_to_funding;
      const conditions = [
        cond('funding_abs', `|费率| ≥ ${absMin}%`, absPct !== null && absPct >= absMin, absPct !== null && absPct >= absMin * 0.7, `当前 ${absPct === null ? 'n/a' : `${absPct.toFixed(4)}%`}`),
        cond('funding_z', `|30 天 z| ≥ ${zMin}`, z !== null && z >= zMin, z !== null && z >= zMin * 0.7, `z=${n2(inp.funding_z)}`),
        cond('not_settling', `距结算 > ${beforeMin} 分钟`, mins === null || mins > beforeMin, false, mins === null ? '结算时间未知' : `${mins} 分钟`),
        cond('atr_ok', 'ATR% ≥ 分周期门槛', ev.pass.atr_ok, m.atr_pct >= m.atr_floor * 0.8, `ATR% ${n2(m.atr_pct)}(门槛 ${n2(m.atr_floor)})`),
      ];
      // fade:正极值做空、负极值做多(OI 确认这一格筛选器拿不到,留给判断 Agent)。
      const dir = inp.funding_pct === null || absPct === null || absPct < absMin ? null : inp.funding_pct > 0 ? 'short' : 'long';
      return { conditions, direction: dir, thresholds: th };
    }

    case 'range_mean_reversion': {
      const ev = evOf();
      const devMin = p('dev_atr_min', 2);
      const adxMax = p('adx_max', 20);
      const horizon = Math.round(p('horizon_bars', 12));
      const probMin = p('min_reversion_prob', 55);
      const ranging = m.regime === 'range' || (adx !== null && adx < adxMax);
      const dev = m.atr > 0 ? (m.close - m.ema20) / m.atr : null;
      const absDev = dev === null ? null : Math.abs(dev);
      // 取「离要求的偏离最近的那个 k 格」,而不是永远看 2.0 —— 策略参数改了这里要跟着走。
      const ks = inp.reversion?.ks ?? [];
      const k = ks.length ? ks.reduce((a, b) => (Math.abs(b - devMin) < Math.abs(a - devMin) ? b : a)) : null;
      const hs = inp.reversion?.horizons ?? [];
      const h = hs.length ? hs.reduce((a, b) => (Math.abs(b - horizon) < Math.abs(a - horizon) ? b : a)) : null;
      const cell = inp.reversion && k !== null && h !== null ? reversionCell(inp.reversion, k, h) : null;
      const prob = cell?.prob === null || cell?.prob === undefined ? null : cell.prob * 100;
      const conditions = [
        cond('ranging', `震荡(日线 range 或 ADX < ${adxMax})`, ranging, adx !== null && adx < adxMax * 1.25, `日线 ${m.regime ?? 'n/a'},ADX ${n2(adx)}`),
        cond('deviation', `距 EMA20 ≥ ${devMin} ATR`, absDev !== null && absDev >= devMin, absDev !== null && absDev >= devMin * 0.7, `偏离 ${dev === null ? 'n/a' : `${dev >= 0 ? '+' : ''}${dev.toFixed(2)}`} ATR`),
        cond('reversion_prob', `历史回归比例 ≥ ${probMin}%`, prob !== null && prob >= probMin, prob !== null && prob >= probMin * 0.8, cell ? `≥${k}ATR/${h}根:回归 ${n0(prob)}%(样本 ${cell.samples})` : '样本不足 400 根,回归概率不可得'),
        cond('atr_ok', 'ATR% ≥ 分周期门槛', ev.pass.atr_ok, m.atr_pct >= m.atr_floor * 0.8, `ATR% ${n2(m.atr_pct)}(门槛 ${n2(m.atr_floor)})`),
      ];
      // 均值回归是反着偏离方向做的。
      const dir = absDev === null || dev === null || absDev < devMin * 0.7 ? null : dev > 0 ? 'short' : 'long';
      return { conditions, direction: dir, thresholds: th };
    }

    default: {
      // 库里出现了一条没有注册打分口径的策略(比如用户新建的):退回七条通用条件,别静默给 0 分。
      const ev = evOf();
      const conditions = [
        cond('atr_ok', 'ATR% ≥ 分周期门槛', ev.pass.atr_ok, m.atr_pct >= m.atr_floor * 0.8, `ATR% ${n2(m.atr_pct)}`),
        cond('trend_agree', '趋势同向', ev.pass.trend_agree, m.dir_h1 !== null, ev.dir_trend ?? '不同向'),
        cond('within_chase', '在射程内', ev.pass.within_chase, ev.dist_atr <= th.chase_atr_max * 1.25, `距 ${n2(ev.dist_atr)} ATR`),
        cond('breakout', '窗口内收破突破位', ev.pass.breakout, false, ''),
        cond('retest_vol', '量比达标', ev.pass.retest_vol, false, `${n2(m.vol_ratio)}`),
      ];
      return { conditions, direction: ev.dir_trend, thresholds: th };
    }
  }
}

/** funnel.ts 的 `dedupe`(没导出;这里五行重写,口径一致:两次机会至少隔 cooldown 根)。 */
function dedupeHits<T extends { i: number }>(hits: T[], cooldown: number): T[] {
  const out: T[] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (const h of hits) {
    if (h.i - last < cooldown) continue;
    out.push(h);
    last = h.i;
  }
  return out;
}

/**
 * 一条策略在这个币上、过去 N 天的机械前瞻期望。只对**能用一组 funnel 阈值表达**的策略算
 * (突破-回踩 / 多周期对齐);压缩、资金费率、均值回归的条件不在 `evaluateBar` 的七条里,
 * 硬套会算出一个看着像数其实不是它的数 —— 那比没有数更危险,所以宁可返回 null + 一句说明。
 */
export function expectancyFor(
  spec: StrategySpec,
  bars: Kline[],
  metrics: BarMetrics[],
  index: number[],
  th: FunnelThresholds,
  o: OutcomeParams,
  cooldown: number,
  days: number,
): { expectancy: FitExpectancy | null; note: string | null } {
  if (!['breakout_retest', 'swing_breakout_retest', 'position_breakout_retest', 'mtf_alignment'].includes(spec.id)) {
    return { expectancy: null, note: '该策略的条件不在漏斗的七条口径里,机械期望未计算(要用回测跑)' };
  }
  const hits: { i: number; ev: ConditionEval }[] = [];
  for (let i = 0; i < metrics.length; i++) {
    const ev = evaluateBar(metrics[i]!, th);
    if (ev.joint) hits.push({ i, ev });
  }
  const kept = dedupeHits(hits, cooldown);
  const rs: number[] = [];
  for (const h of kept) {
    const r = scoreCandidate(bars, index[h.i]!, metrics[h.i]!, h.ev, o);
    if (r !== null) rs.push(r);
  }
  const weeks = Math.max(1e-9, days / 7);
  const wins = rs.filter((r) => r > 0).length;
  return {
    expectancy: {
      days,
      setups: kept.length,
      per_week: Math.round((kept.length / weeks) * 100) / 100,
      n: rs.length,
      win_rate: rs.length ? Math.round((wins / rs.length) * 1000) / 1000 : null,
      expectancy_r: rs.length ? Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 1000) / 1000 : null,
    },
    note: rs.length < 10 ? `样本只有 ${rs.length} 笔,期望不可当结论` : null,
  };
}

// ---------------------------------------------------------------- 一个币的卡

export interface CardInput {
  symbol: string;
  horizon: ScreenHorizon;
  series: SeriesBundle;
  strategies: StrategySpec[];
  now: number;
  quote_volume_24h: number | null;
  next_funding_at: number | null;
  with_expectancy: boolean;
}

/**
 * 中长线口径的技巧:把 `SeriesBundle` 的 `h1/h4` 换成 `4h/1d`,`computeMetrics` 那套「确认周期
 * 同向 / 高周期否决」就整体上移了一层,一行代码都不用改。
 */
function bundleFor(horizon: ScreenHorizon, s: SeriesBundle): SeriesBundle {
  return horizon === 'short' ? s : { base: s.base, h1: s.h4, h4: s.d1, d1: s.d1, funding: s.funding };
}

export function buildCard(inp: CardInput): OpportunityCard {
  const spec = HORIZON_SPECS[inp.horizon];
  const tf = spec.timeframe;
  const now = inp.now;
  const from = now - spec.expectancy_days * 86_400_000;
  const bundle = bundleFor(inp.horizon, inp.series);
  const { metrics, index } = computeMetrics(bundle, tf, from, now);
  const closed = bundle.base.filter((k) => k.close_time <= now);
  const snap = closed.length >= 30 ? indicatorSnapshot(closed, tf) : null;
  const confirmBars = (inp.horizon === 'short' ? inp.series.h1 : inp.series.d1).filter((k) => k.close_time <= now);
  const confirmSnap = confirmBars.length >= 30 ? indicatorSnapshot(confirmBars, spec.confirm_timeframe) : null;
  const rev = closed.length ? reversionStats(closed, { tf }) : null;

  const empty: OpportunityCard = {
    symbol: inp.symbol,
    horizon: inp.horizon,
    timeframe: tf,
    confirm_timeframe: spec.confirm_timeframe,
    as_of: now,
    bars: metrics.length,
    last_close: null,
    trend: { base_dir: null, confirm_dir: null, agree: null, adx_base: null, adx_confirm: null, note: '窗口内没有可用 K 线' },
    atr_pct: null,
    atr_pct_rank_90: null,
    bb_width_rank_90: null,
    squeeze_on: null,
    squeeze_bars: null,
    breakout: { level_long: null, level_short: null, dist_long_atr: null, dist_short_atr: null, bars_since_up: -1, bars_since_down: -1, vol_ratio: null },
    funding: { rate_pct: null, z_30d: null, samples: 0 },
    reversion: null,
    daily_regime: null,
    volume: { quote_24h: inp.quote_volume_24h, rank: null, of: 0 },
    strategies: [],
    best: null,
    note: '窗口内没有可用 K 线',
  };
  const m = metrics[metrics.length - 1];
  if (!m) return empty;

  const fundingRows = inp.series.funding;
  const lastFunding = fundingRows.length ? Number(fundingRows[fundingRows.length - 1]!.rate) : null;
  const fundingPct = lastFunding === null || !Number.isFinite(lastFunding) ? null : lastFunding * 100;
  const z = lastFunding === null ? { z: null, samples: 0 } : fundingZScore(fundingRows, lastFunding, now);
  const minutesToFunding = inp.next_funding_at === null ? null : Math.max(0, Math.round((inp.next_funding_at - now) / 60_000));

  const adxBase = snap?.adx14 && Number.isFinite(snap.adx14.adx) ? snap.adx14.adx : null;
  const adxConfirm = confirmSnap?.adx14 && Number.isFinite(confirmSnap.adx14.adx) ? confirmSnap.adx14.adx : null;
  const baseEv = evaluateBar(m, { ...CURRENT_THRESHOLDS, breakout_level: 'prior' });
  const distLong = m.atr > 0 ? Math.abs(m.close - m.hi20_prev) / m.atr : null;
  const distShort = m.atr > 0 ? Math.abs(m.close - m.lo20_prev) / m.atr : null;
  const bestCell = rev
    ? rev.cells.filter((c) => c.prob !== null && c.samples >= 20).sort((a, b) => (b.prob ?? 0) - (a.prob ?? 0))[0] ?? null
    : null;

  const fitInput: FitInput = { m, snap, reversion: rev, now, minutes_to_funding: minutesToFunding, funding_pct: fundingPct, funding_z: z.z };

  const fits: StrategyFit[] = inp.strategies.map((s) => {
    const { conditions, direction, thresholds } = fitConditions(s, fitInput);
    const sc = score(conditions);
    const { expectancy, note } = inp.with_expectancy
      ? expectancyFor(s, bundle.base, metrics, index, thresholds, spec.outcome, spec.cooldown_bars, spec.expectancy_days)
      : { expectancy: null, note: '本次未计算机械期望' };
    return {
      strategy_id: s.id,
      name: s.name,
      version: s.version,
      status: s.status,
      fit_score: sc.fit,
      passed: sc.passed,
      near: sc.near,
      total: conditions.length,
      direction,
      conditions,
      reasons: conditions.filter((c) => !c.pass).map((c) => `${c.label}未成立(${c.detail})`).slice(0, 3),
      expectancy,
      expectancy_note: note,
    };
  });
  fits.sort((a, b) => b.fit_score - a.fit_score || a.strategy_id.localeCompare(b.strategy_id));

  return {
    symbol: inp.symbol,
    horizon: inp.horizon,
    timeframe: tf,
    confirm_timeframe: spec.confirm_timeframe,
    as_of: now,
    bars: metrics.length,
    last_close: m.close,
    trend: {
      base_dir: m.dir_h1,
      confirm_dir: m.dir_h4,
      agree: m.dir_h1 !== null && m.dir_h1 === m.dir_h4 ? m.dir_h1 : null,
      adx_base: adxBase,
      adx_confirm: adxConfirm,
      note: `${inp.horizon === 'short' ? '1h' : '4h'} ${m.dir_h1 ?? 'n/a'}、${inp.horizon === 'short' ? '4h' : '1d'} ${m.dir_h4 ?? 'n/a'}`,
    },
    atr_pct: m.atr_pct,
    atr_pct_rank_90: snap?.atr_pct_rank_90 ?? null,
    bb_width_rank_90: snap?.bb_width_rank_90 ?? null,
    squeeze_on: snap?.squeeze?.on ?? null,
    squeeze_bars: snap?.squeeze?.bars_on ?? null,
    breakout: {
      level_long: m.hi20_prev,
      level_short: m.lo20_prev,
      dist_long_atr: distLong,
      dist_short_atr: distShort,
      bars_since_up: m.bars_since_up,
      bars_since_down: m.bars_since_down,
      vol_ratio: m.vol_ratio,
    },
    funding: { rate_pct: fundingPct, z_30d: z.z, samples: z.samples },
    reversion: rev ? { text: rev.text, best_prob: bestCell?.prob ?? null, best_k: bestCell?.k ?? null, best_horizon: bestCell?.horizon ?? null } : null,
    daily_regime: m.regime,
    volume: { quote_24h: inp.quote_volume_24h, rank: null, of: 0 },
    strategies: fits,
    best: fits[0] ? { strategy_id: fits[0].strategy_id, fit_score: fits[0].fit_score } : null,
    note: baseEv.dir_trend === null ? '趋势周期不同向' : null,
  };
}

// ---------------------------------------------------------------- 全市场

interface TickerRow {
  symbol: string;
  quoteVolume: number;
  priceChangePercent: number;
}

function fapi(): string {
  return process.env['TG_DEMO_MARKET_BASE'] ?? 'https://fapi.binance.com';
}

/** OKX 的 USDT 本位线性永续 instId → 规范符号;别的(币本位、交割)返回 null。 */
function okxSwapSymbol(instId: string | undefined): string | null {
  if (!instId || !instId.endsWith('-USDT-SWAP')) return null;
  return instId.slice(0, -'-SWAP'.length).replace(/-/g, '');
}

/**
 * 一次拿全市场 24h 行情:既是 `top_volume` 的排序依据,也是每张卡上的成交额与排名。
 * 按 `marketExchange()` 分流:OKX 走 `/api/v5/market/tickers?instType=SWAP`(成交额 = volCcy24h × last,
 * 涨跌 = (last-open24h)/open24h);币安走 fapi `ticker/24hr`。
 */
export async function fetchTickerMap(): Promise<Map<string, TickerRow>> {
  if (marketExchange() === 'okx') {
    const rows = await okxGet<{ instId?: string; last?: string; open24h?: string; volCcy24h?: string }[]>('/api/v5/market/tickers?instType=SWAP', 15_000);
    const out = new Map<string, TickerRow>();
    for (const r of Array.isArray(rows) ? rows : []) {
      const symbol = okxSwapSymbol(r.instId);
      if (!symbol) continue;
      const last = Number(r.last ?? 0) || 0;
      const open = Number(r.open24h ?? 0) || 0;
      out.set(symbol, { symbol, quoteVolume: (Number(r.volCcy24h ?? 0) || 0) * last, priceChangePercent: open > 0 ? ((last - open) / open) * 100 : 0 });
    }
    return out;
  }
  const res = await fetch(`${fapi()}/fapi/v1/ticker/24hr`);
  if (!res.ok) throw new Error(`ticker/24hr -> HTTP ${res.status}`);
  const raw = (await res.json()) as unknown;
  const rows = Array.isArray(raw) ? raw : [raw];
  const out = new Map<string, TickerRow>();
  for (const r of rows as { symbol?: string; quoteVolume?: string; priceChangePercent?: string }[]) {
    if (!r.symbol) continue;
    out.set(r.symbol, { symbol: r.symbol, quoteVolume: Number(r.quoteVolume ?? 0) || 0, priceChangePercent: Number(r.priceChangePercent ?? 0) || 0 });
  }
  return out;
}

/**
 * 下次资金费结算时间(全市场一次)。拿不到就 null —— 缺失不算违规。
 * OKX:`/api/v5/public/funding-rate?instId=ANY` 一个请求拿全部永续(fundingTime = 当期结算时刻);
 * 币安:fapi `premiumIndex`。
 */
export async function fetchNextFundingMap(): Promise<Map<string, number>> {
  if (marketExchange() === 'okx') {
    const rows = await okxGet<{ instId?: string; fundingTime?: string }[]>('/api/v5/public/funding-rate?instId=ANY', 15_000);
    const out = new Map<string, number>();
    for (const r of Array.isArray(rows) ? rows : []) {
      const symbol = okxSwapSymbol(r.instId);
      if (symbol && Number(r.fundingTime) > 0) out.set(symbol, Number(r.fundingTime));
    }
    return out;
  }
  const res = await fetch(`${fapi()}/fapi/v1/premiumIndex`);
  if (!res.ok) throw new Error(`premiumIndex -> HTTP ${res.status}`);
  const raw = (await res.json()) as unknown;
  const rows = Array.isArray(raw) ? raw : [raw];
  const out = new Map<string, number>();
  for (const r of rows as { symbol?: string; nextFundingTime?: number }[]) {
    if (r.symbol && r.nextFundingTime) out.set(r.symbol, Number(r.nextFundingTime));
  }
  return out;
}

export interface UniverseResult {
  symbols: string[];
  universe: ScreenUniverse;
  note: string | null;
}

/**
 * 这次要筛哪些币。
 *  - `watchlist+whitelist`（默认）= 当前观察列表 + `workflow.screener_whitelist`(设置里可改,
 *    初值 `DEFAULT_FUNNEL_SYMBOLS`)里在当前交易所存在的那些(存在性由 `listTradableSymbols` 按交易所判;
 *    币安含 TRADIFI_PERPETUAL)。
 *  - `top_volume` = 24h 成交额前 N 的 USDT 永续。
 *  - `explicit` = `workflow.screener_symbols`。
 *  - `okx_all` = OKX 全市场:先取最近一次每日全市场扫描的候选(按名次),再用资产全集里 24h 成交额靠前的
 *    补齐到上限;只取**有永续**的(radar 的 K 线与资金费按永续拉),排除稳定币/包装币。
 *    资产全集还没刷过 → 退回用永续 24h 行情按成交额排。
 */
export async function resolveUniverse(w: Workflow, tickers: Map<string, TickerRow> | null): Promise<UniverseResult> {
  const cap = Math.max(1, w.screener_max_symbols ?? 60);
  const universe = (w.screener_universe ?? 'watchlist+whitelist') as ScreenUniverse;
  if (universe === 'explicit') {
    const list = (w.screener_symbols ?? []).slice(0, cap);
    if (!list.length) return { symbols: [], universe, note: 'screener_symbols 是空的,这次没有可筛的币' };
    const { existing, missing } = await listTradableSymbols(list);
    return { symbols: existing.map((e) => e.symbol), universe, note: missing.length ? `${notListedLabel()}:${missing.join('、')}` : null };
  }
  if (universe === 'okx_all') return resolveOkxAll(cap, tickers);
  if (universe === 'top_volume') {
    if (!tickers || !tickers.size) return { symbols: [], universe, note: '拉不到 24h 行情,无法按成交额排序' };
    const { existing } = await listTradableSymbols([...tickers.keys()].filter((s) => s.endsWith('USDT')));
    const live = new Set(existing.map((e) => e.symbol));
    const ranked = [...tickers.values()].filter((t) => live.has(t.symbol)).sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, cap);
    return { symbols: ranked.map((t) => t.symbol), universe, note: null };
  }
  const wanted = [...new Set([...(w.watchlist ?? []), ...(w.screener_whitelist ?? DEFAULT_FUNNEL_SYMBOLS)])].slice(0, cap);
  const { existing, missing } = await listTradableSymbols(wanted);
  return { symbols: existing.map((e) => e.symbol), universe, note: missing.length ? `${notListedLabel()}(已跳过):${missing.join('、')}` : null };
}

function resolveOkxAll(cap: number, tickers: Map<string, TickerRow> | null): UniverseResult {
  const universe: ScreenUniverse = 'okx_all';
  const snap = currentUniverse();
  if (snap && snap.items.length) {
    const perp = new Set(snap.items.filter((a) => !a.excluded && a.markets.includes('perp')).map((a) => a.symbol));
    const scan = currentDailyScan();
    const fromScan = [...new Set((scan?.symbols ?? []).filter((s) => perp.has(s)))];
    const picked = fromScan.slice(0, cap);
    const seen = new Set(picked);
    for (const a of snap.items) {
      if (picked.length >= cap) break;
      if (!perp.has(a.symbol) || seen.has(a.symbol)) continue;
      picked.push(a.symbol);
      seen.add(a.symbol);
    }
    const nScan = Math.min(fromScan.length, cap);
    return { symbols: picked, universe, note: `OKX 全市场:每日扫描候选 ${nScan} 个${scan ? '' : '(今天还没扫)'} + 24h 成交额补齐 ${picked.length - nScan} 个(只取有永续的)` };
  }
  if (!tickers || !tickers.size) return { symbols: [], universe, note: 'OKX 资产全集还没刷新过,也拉不到 24h 行情,这次没有可筛的币' };
  const ranked = [...tickers.values()].filter((t) => t.symbol.endsWith('USDT') && !looksExcluded(t.symbol.slice(0, -4))).sort((a, b) => b.quoteVolume - a.quoteVolume).slice(0, cap);
  return { symbols: ranked.map((t) => t.symbol), universe, note: 'OKX 资产全集还没刷新过:退回按永续 24h 成交额排序' };
}

// ---------------------------------------------------------------- 便宜大脑那一层

const BRAIN_SYSTEM = [
  '你是一个交易筛选台的排序助手。输入是一批**已经由代码算好**的机会卡。',
  '你的唯一任务:从中挑出最值得现在盯的若干个 币×策略 组合,每个给一句不超过 40 字的中文理由。',
  '硬规则:',
  '1. 只能从卡片里出现过的 symbol 与 strategy_id 里挑,不得发明新的。',
  '2. **不得写出卡片里没有的数字。** 任何三位以上的数(价格、成交额、根数、百分比)必须原样来自卡片。',
  '   不确定就不要写数字,用「带宽处在低位」这类词。',
  '3. 不得给出入场价、止损价、仓位或杠杆 —— 那不是你的职责,由后面的判断与风控做。',
  '4. 卡片里的分数已经排好序;你可以调整顺序,但要在理由里说清楚为什么。',
  '只输出 JSON 对象:{"ranked":[{"symbol":"...","strategy_id":"...","why":"..."}]},最多 10 条,不要任何解释文字。',
].join('\n');

/** 一张卡压成模型看得见的一行(数字都在这里;守卫只认这段文本里的数)。 */
export function renderCardLine(c: OpportunityCard, rank: number): string {
  const f = c.strategies[0];
  const parts = [
    `#${rank} ${c.symbol}`,
    `最佳策略 ${f ? `${f.strategy_id}(契合 ${f.fit_score.toFixed(2)},${f.passed}/${f.total} 条通过${f.direction ? `,方向 ${f.direction === 'long' ? '多' : '空'}` : ''})` : '无'}`,
    `趋势 ${c.trend.note}`,
    `ATR% ${n2(c.atr_pct)}(分位 ${n0(c.atr_pct_rank_90)})`,
    `带宽分位 ${n0(c.bb_width_rank_90)}%`,
    `squeeze ${c.squeeze_on ? `开 ${c.squeeze_bars ?? 0} 根` : '关'}`,
    `距上沿 ${n2(c.breakout.dist_long_atr)} ATR / 距下沿 ${n2(c.breakout.dist_short_atr)} ATR`,
    `量比 ${n2(c.breakout.vol_ratio)}`,
    `资金费率 ${c.funding.rate_pct === null ? 'n/a' : `${c.funding.rate_pct.toFixed(4)}%`}(z ${n2(c.funding.z_30d)})`,
    `日线 ${c.daily_regime ?? 'n/a'}`,
  ];
  if (f?.expectancy && f.expectancy.n > 0) parts.push(`近 ${f.expectancy.days} 天机械期望 ${n2(f.expectancy.expectancy_r)}R(${f.expectancy.n} 笔)`);
  const others = c.strategies.slice(1, 3).map((s) => `${s.strategy_id} ${s.fit_score.toFixed(2)}`);
  if (others.length) parts.push(`其他策略 ${others.join('、')}`);
  if (f?.reasons.length) parts.push(`还差:${f.reasons.join(';')}`);
  return parts.join(' | ');
}

const NUM_RE = /(?<![\w.])\d{3,}(?:\.\d+)?(?![\w])/g;

export interface BrainLine {
  symbol: string;
  strategy_id: string;
  why: string;
}

export interface BrainPassResult {
  used: boolean;
  model: string | null;
  cost_cny: number | null;
  ranked: BrainLine[];
  dropped: { line: BrainLine; reason: string }[];
  error: string | null;
}

/**
 * 数字守卫:模型那句理由里任何 ≥ 3 位的数字必须在卡片文本里出现过,否则整行丢掉
 * (schema.ts `findMemoryNumberLeaks` 的同款口径 —— 造出来的数比说错话危险得多)。
 */
export function guardBrainLines(lines: BrainLine[], cardsText: string, known: Map<string, Set<string>>): { kept: BrainLine[]; dropped: { line: BrainLine; reason: string }[] } {
  const kept: BrainLine[] = [];
  const dropped: { line: BrainLine; reason: string }[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    const symbol = String(l.symbol ?? '').toUpperCase();
    const strategyId = String(l.strategy_id ?? '');
    const why = String(l.why ?? '').slice(0, 80);
    const strategies = known.get(symbol);
    if (!strategies) {
      dropped.push({ line: l, reason: `卡片里没有 ${symbol || '(空)'}` });
      continue;
    }
    if (!strategies.has(strategyId)) {
      dropped.push({ line: l, reason: `${symbol} 的卡片里没有策略 ${strategyId || '(空)'}` });
      continue;
    }
    const key = `${symbol}:${strategyId}`;
    if (seen.has(key)) {
      dropped.push({ line: l, reason: '重复' });
      continue;
    }
    const bad = [...why.matchAll(NUM_RE)].map((mm) => mm[0]!).find((num) => !cardsText.includes(num));
    if (bad !== undefined) {
      dropped.push({ line: l, reason: `理由里的数字 ${bad} 不在卡片里` });
      continue;
    }
    seen.add(key);
    kept.push({ symbol, strategy_id: strategyId, why });
  }
  return { kept, dropped };
}

export async function brainPass(brain: Brain, cards: OpportunityCard[], opts: { timeoutMs?: number } = {}): Promise<BrainPassResult> {
  const top = cards.slice(0, BRAIN_TOP_CARDS);
  if (!top.length) return { used: false, model: null, cost_cny: null, ranked: [], dropped: [], error: '没有卡片' };
  const cardsText = top.map((c, i) => renderCardLine(c, i + 1)).join('\n');
  const known = new Map<string, Set<string>>();
  for (const c of top) known.set(c.symbol, new Set(c.strategies.map((s) => s.strategy_id)));
  const user = [`当前时间 ${new Date(top[0]!.as_of).toISOString()},周期 ${HORIZON_LABEL[top[0]!.horizon]}。`, '机会卡(已按契合度排序):', cardsText].join('\n');
  try {
    const r = await brain.complete(BRAIN_SYSTEM, user, { timeoutMs: opts.timeoutMs ?? 90_000 });
    const parsed = extractJson(r.text) as { ranked?: unknown };
    const raw = Array.isArray(parsed.ranked) ? (parsed.ranked as BrainLine[]) : [];
    const { kept, dropped } = guardBrainLines(raw.slice(0, 10), cardsText, known);
    return { used: true, model: r.model, cost_cny: estimateCny([{ model: brain.name, input_tokens: r.input_tokens, output_tokens: r.output_tokens }]), ranked: kept, dropped, error: null };
  } catch (e) {
    return { used: true, model: brain.name, cost_cny: null, ranked: [], dropped: [], error: (e as Error).message.slice(0, 200) };
  }
}

// ---------------------------------------------------------------- 一次筛选

export interface WatchCandidate {
  screen_id: string;
  horizon: ScreenHorizon;
  symbol: string;
  strategy_id: string;
  fit_score: number;
  rank: number;
  reasons: string[];
  card: OpportunityCard;
  ttl_at: number;
  created_at: number;
}

export interface WatchlistProposal {
  /** 建议观察的币,已按名次截到 K 个。 */
  symbols: string[];
  /** 每个币建议启用哪几条策略(仅供参考:workflow.active_strategies 是全局的,应用时不写它)。 */
  active_strategies: Record<string, string[]>;
  k: number;
  note: string;
}

export interface ScreenRow {
  id: string;
  horizon: ScreenHorizon;
  started_at: number;
  finished_at: number | null;
  status: 'running' | 'done' | 'failed';
  universe: ScreenUniverse;
  symbols: string[];
  errors: { symbol: string; error: string }[];
  run_id: string | null;
  handoff_id: string | null;
  proposal: WatchlistProposal | null;
  brain: (Omit<BrainPassResult, 'ranked' | 'dropped'> & { ranked: BrainLine[]; dropped_lines: number }) | null;
  cost_cny: number;
  error: string | null;
}

export function screenId(now = Date.now()): string {
  return `scr-${now.toString(36)}${randomBytes(3).toString('hex')}`;
}

// ---------------------------------------------------------------- 持久化

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class ScreenStore {
  constructor(private readonly db: DatabaseSync) {}

  saveScreen(s: ScreenRow): void {
    this.db
      .prepare(
        `INSERT INTO demo_screen(id, horizon, started_at, finished_at, status, universe, symbols_json, errors_json, run_id, handoff_id, proposal_json, brain_json, cost_cny, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET finished_at = excluded.finished_at, status = excluded.status, symbols_json = excluded.symbols_json,
           errors_json = excluded.errors_json, run_id = excluded.run_id, handoff_id = excluded.handoff_id,
           proposal_json = excluded.proposal_json, brain_json = excluded.brain_json, cost_cny = excluded.cost_cny, error = excluded.error`,
      )
      .run(
        s.id,
        s.horizon,
        s.started_at,
        s.finished_at,
        s.status,
        s.universe,
        JSON.stringify(s.symbols),
        JSON.stringify(s.errors),
        s.run_id,
        s.handoff_id,
        s.proposal === null ? null : JSON.stringify(s.proposal),
        s.brain === null ? null : JSON.stringify(s.brain),
        s.cost_cny,
        s.error,
      );
  }

  private toScreen(row: Record<string, unknown>): ScreenRow {
    return {
      id: String(row['id']),
      horizon: String(row['horizon']) as ScreenHorizon,
      started_at: Number(row['started_at']),
      finished_at: row['finished_at'] === null || row['finished_at'] === undefined ? null : Number(row['finished_at']),
      status: String(row['status']) as ScreenRow['status'],
      universe: String(row['universe']) as ScreenUniverse,
      symbols: parseJson<string[]>(row['symbols_json'], []),
      errors: parseJson<{ symbol: string; error: string }[]>(row['errors_json'], []),
      run_id: row['run_id'] === null || row['run_id'] === undefined ? null : String(row['run_id']),
      handoff_id: row['handoff_id'] === null || row['handoff_id'] === undefined ? null : String(row['handoff_id']),
      proposal: parseJson<WatchlistProposal | null>(row['proposal_json'], null),
      brain: parseJson<ScreenRow['brain']>(row['brain_json'], null),
      cost_cny: Number(row['cost_cny'] ?? 0),
      error: row['error'] === null || row['error'] === undefined ? null : String(row['error']),
    };
  }

  screen(id: string): ScreenRow | null {
    const row = this.db.prepare('SELECT * FROM demo_screen WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.toScreen(row) : null;
  }
  /** 某个周期最近一次**跑完**的筛选。 */
  latest(horizon: ScreenHorizon): ScreenRow | null {
    const row = this.db.prepare("SELECT * FROM demo_screen WHERE horizon = ? AND status = 'done' ORDER BY started_at DESC LIMIT 1").get(horizon) as Record<string, unknown> | undefined;
    return row ? this.toScreen(row) : null;
  }
  /** 新的在前。 */
  screens(opts: { horizon?: ScreenHorizon; limit?: number } = {}): ScreenRow[] {
    const rows = (
      opts.horizon
        ? this.db.prepare('SELECT * FROM demo_screen WHERE horizon = ? ORDER BY started_at DESC LIMIT ?').all(opts.horizon, opts.limit ?? 30)
        : this.db.prepare('SELECT * FROM demo_screen ORDER BY started_at DESC LIMIT ?').all(opts.limit ?? 30)
    ) as Record<string, unknown>[];
    return rows.map((r) => this.toScreen(r));
  }

  saveCandidates(rows: WatchCandidate[]): void {
    const ins = this.db.prepare(
      `INSERT INTO demo_watch_candidate(screen_id, horizon, symbol, strategy_id, fit_score, rank, reasons_json, card_json, ttl_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(screen_id, symbol, strategy_id) DO UPDATE SET fit_score = excluded.fit_score, rank = excluded.rank,
         reasons_json = excluded.reasons_json, card_json = excluded.card_json, ttl_at = excluded.ttl_at`,
    );
    for (const c of rows) ins.run(c.screen_id, c.horizon, c.symbol, c.strategy_id, c.fit_score, c.rank, JSON.stringify(c.reasons), JSON.stringify(c.card), c.ttl_at, c.created_at);
  }

  candidates(screenId_: string, limit = 200): WatchCandidate[] {
    const rows = this.db.prepare('SELECT * FROM demo_watch_candidate WHERE screen_id = ? ORDER BY rank ASC LIMIT ?').all(screenId_, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      screen_id: String(r['screen_id']),
      horizon: String(r['horizon']) as ScreenHorizon,
      symbol: String(r['symbol']),
      strategy_id: String(r['strategy_id']),
      fit_score: Number(r['fit_score']),
      rank: Number(r['rank']),
      reasons: parseJson<string[]>(r['reasons_json'], []),
      card: parseJson<OpportunityCard>(r['card_json'], {} as OpportunityCard),
      ttl_at: Number(r['ttl_at']),
      created_at: Number(r['created_at']),
    }));
  }
}

// ---------------------------------------------------------------- 编排

export interface RunScreenDeps {
  workflow: Workflow;
  library: StrategyLibrary;
  /** null = 这次不调模型(paused、关掉了、或者没预算)。 */
  brain: Brain | null;
  now?: number;
  /** 每个币之间的停顿,别把公共 REST 打到限速。 */
  pause_ms?: number;
  onProgress?: (symbol: string, done: number, total: number) => void;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface RunScreenResult {
  screen: ScreenRow;
  cards: OpportunityCard[];
  candidates: WatchCandidate[];
  proposal: WatchlistProposal;
  brain: BrainPassResult | null;
}

/**
 * 一次筛选。全程只读:不下单、不改 workflow、不碰风险字段。产物是卡片 + 候选 + 一份提案。
 *
 * 策略取的是库里**每条策略的 head**(含 `backtest` 状态的),因为筛选是研究行为不是下单行为 ——
 * 「哪条策略现在最贴」这个问题,不该只在已经晋升到 paper 的那一条里问。
 */
export async function runScreen(horizon: ScreenHorizon, deps: RunScreenDeps): Promise<RunScreenResult> {
  const now = deps.now ?? Date.now();
  const spec = HORIZON_SPECS[horizon];
  const log = deps.log ?? (() => {});
  const id = screenId(now);

  let tickers: Map<string, TickerRow> | null = null;
  try {
    tickers = await fetchTickerMap();
  } catch (e) {
    log('warn', `筛选:拉 24h 行情失败(${(e as Error).message.slice(0, 80)}),成交额与排名这次留空`);
  }
  let fundingAt: Map<string, number> = new Map();
  try {
    fundingAt = await fetchNextFundingMap();
  } catch {
    // 结算时间缺失只影响 funding 策略的一条 near 判定,不值得中断整次筛选。
  }

  const { symbols, universe, note } = await resolveUniverse(deps.workflow, tickers);
  const strategies = deps.library.list().filter((s) => s.status !== 'retired' && (horizon === 'weekly' ? s.horizon === 'position' : horizon === 'swing' ? s.horizon === 'swing' : s.horizon === 'scalp' || s.horizon === 'intraday'));
  const withExpectancy = deps.workflow.screener_expectancy !== false;

  const screen: ScreenRow = {
    id,
    horizon,
    started_at: now,
    finished_at: null,
    status: 'running',
    universe,
    symbols,
    errors: [],
    run_id: null,
    handoff_id: null,
    proposal: null,
    brain: null,
    cost_cny: 0,
    error: null,
  };

  const from = now - spec.expectancy_days * 86_400_000;
  const cards: OpportunityCard[] = [];
  const errors: { symbol: string; error: string }[] = [];
  let done = 0;
  for (const symbol of symbols) {
    try {
      const series = await loadFunnelSeries(symbol, spec.timeframe, from, now);
      cards.push(
        buildCard({
          symbol,
          horizon,
          series,
          strategies,
          now,
          quote_volume_24h: tickers?.get(symbol)?.quoteVolume ?? null,
          next_funding_at: fundingAt.get(symbol) ?? null,
          with_expectancy: withExpectancy,
        }),
      );
    } catch (e) {
      errors.push({ symbol, error: (e as Error).message.slice(0, 200) });
    }
    done++;
    deps.onProgress?.(symbol, done, symbols.length);
    if (deps.pause_ms) await new Promise((r) => setTimeout(r, deps.pause_ms));
  }

  // 成交额排名(名次是在**这次筛过的币**里排的,写进卡里让 UI 不用再算一遍)。
  const byVol = [...cards].filter((c) => c.volume.quote_24h !== null).sort((a, b) => (b.volume.quote_24h ?? 0) - (a.volume.quote_24h ?? 0));
  byVol.forEach((c, i) => {
    c.volume.rank = i + 1;
    c.volume.of = byVol.length;
  });

  // 排名:先看最佳策略的契合度,平手时看机械期望,再平手看成交额。全是代码。
  cards.sort((a, b) => {
    const fa = a.best?.fit_score ?? 0;
    const fb = b.best?.fit_score ?? 0;
    if (fb !== fa) return fb - fa;
    const ea = a.strategies[0]?.expectancy?.expectancy_r ?? -99;
    const eb = b.strategies[0]?.expectancy?.expectancy_r ?? -99;
    if (eb !== ea) return eb - ea;
    return (b.volume.quote_24h ?? 0) - (a.volume.quote_24h ?? 0);
  });

  let brainResult: BrainPassResult | null = null;
  if (deps.brain && deps.workflow.screener_use_brain !== false && cards.length) {
    brainResult = await brainPass(deps.brain, cards);
    if (brainResult.error) log('warn', `筛选:模型排序失败(${brainResult.error}),只用确定性排名`);
    if (brainResult.dropped.length) log('warn', `筛选:模型有 ${brainResult.dropped.length} 行被数字守卫丢掉(${brainResult.dropped[0]!.reason})`);
    if (brainResult.cost_cny !== null && brainResult.cost_cny > BRAIN_BUDGET_CNY) log('warn', `筛选:这次模型花了 ¥${brainResult.cost_cny}(预算 ¥${BRAIN_BUDGET_CNY})`);
    // 模型的意见只影响**排序**,不新增币也不改分数(它挑的必须已经在卡里)。
    const order = new Map(brainResult.ranked.map((r, i) => [r.symbol, i]));
    if (order.size) cards.sort((a, b) => (order.get(a.symbol) ?? 999) - (order.get(b.symbol) ?? 999));
  }

  const whyBySymbol = new Map((brainResult?.ranked ?? []).map((r) => [`${r.symbol}:${r.strategy_id}`, r.why]));
  const candidates: WatchCandidate[] = cards
    .filter((c) => c.best !== null)
    .map((c, i) => {
      const best = c.strategies[0]!;
      const why = whyBySymbol.get(`${c.symbol}:${best.strategy_id}`);
      const reasons = [
        `契合 ${best.fit_score.toFixed(2)}(${best.passed}/${best.total} 条通过${best.near ? `,${best.near} 条差一点` : ''})`,
        ...(best.expectancy && best.expectancy.n > 0 ? [`近 ${best.expectancy.days} 天机械期望 ${n2(best.expectancy.expectancy_r)}R,${best.expectancy.n} 笔`] : []),
        ...(best.reasons.length ? [`还差:${best.reasons.join(';')}`] : []),
        ...(why ? [`模型:${why}`] : []),
      ];
      return {
        screen_id: id,
        horizon,
        symbol: c.symbol,
        strategy_id: best.strategy_id,
        fit_score: best.fit_score,
        rank: i + 1,
        reasons,
        card: c,
        ttl_at: now + spec.ttl_ms,
        created_at: now,
      };
    });

  const k = Math.max(1, deps.workflow.watchlist_max ?? 60);
  const top = candidates.slice(0, k);
  const proposal: WatchlistProposal = {
    symbols: top.map((c) => c.symbol),
    active_strategies: Object.fromEntries(top.map((c) => [c.symbol, c.card.strategies.filter((s) => s.fit_score >= 0.5).slice(0, 2).map((s) => s.strategy_id)])),
    k,
    note: `${HORIZON_LABEL[horizon]}:筛了 ${cards.length} 个币,取契合度前 ${top.length} 个。应用只改 watchlist,不动风险/杠杆/执行。`,
  };

  screen.finished_at = Date.now();
  screen.status = 'done';
  screen.errors = errors;
  screen.proposal = proposal;
  screen.cost_cny = brainResult?.cost_cny ?? 0;
  screen.brain = brainResult ? { used: brainResult.used, model: brainResult.model, cost_cny: brainResult.cost_cny, error: brainResult.error, ranked: brainResult.ranked, dropped_lines: brainResult.dropped.length } : null;
  if (note) screen.error = note;

  return { screen, cards, candidates, proposal, brain: brainResult };
}

/** 这个周期下一次该跑的时刻(给 UI 倒计时用;`last` 为 0 表示从没跑过 → 现在就该跑)。 */
export function nextScreenAt(last: number, everyMs: number, now = Date.now()): number {
  return last === 0 ? now : last + everyMs;
}

/**
 * 提案能落到 workflow 的部分。**只有 watchlist**;风险、杠杆、执行后端一个字都不碰。
 * `pick` = 用户在确认框里勾出来的最终名单(可保留原名单里的、可去掉提案里的);
 * 只认提案里或当前名单里已有的币,别的一律丢掉——这是「应用提案」不是随便改名单。
 */
export function proposalPatch(p: WatchlistProposal, max: number, pick?: string[] | null, current: string[] = []): { watchlist: string[] } {
  const cap = Math.max(1, max);
  if (pick && pick.length) {
    const allowed = new Set([...p.symbols, ...current]);
    const list = [...new Set(pick.map((s) => String(s).trim().toUpperCase()))].filter((s) => allowed.has(s));
    return { watchlist: list.slice(0, cap) };
  }
  return { watchlist: p.symbols.slice(0, cap) };
}

/** 便于测试断言:一次筛选的 K 线拉取量(每个币四条序列)。 */
export function klineRequestCount(symbols: number): number {
  return symbols * 4;
}

export { tfToMs };
