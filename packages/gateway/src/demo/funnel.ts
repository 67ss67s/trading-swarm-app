// 零 PROPOSE 漏斗(docs/research/zero-propose-funnel-2026-09-05.md)。
//
// 问题:agent 从来没给过一次 PROPOSE —— 三轮 eval 各 0/108,线上 668 次判断只有 1 次(还被闸挡了)。
// "是真没机会,还是条件框太死"这个问题不该靠读 reasons 猜,应该把「突破-回踩」playbook +
// `scanChecklist` 施加的每一条入场条件,在历史上逐根 K 线**确定性地**重放一遍,数出来:
//   · 每条条件单独的通过率;
//   · 联合通过数(= 本该 PROPOSE 的根数);
//   · **边际杀伤**:有多少根"其它条件全过、只死在这一条"上 —— 这才是"谁在杀机会"的答案;
//   · **放宽阶梯**:每种放宽下联合通过数变成多少(每币每周几个),以及这些新增机会用隐藏 K 线
//     结算出来的前瞻期望(胜率 / 期望 R / 笔数)—— 放宽出来的单子值不值得做。
//
// 全程零模型调用:只用 backtest.ts 的磁盘 K 线缓存 + 纯函数。
//
// 口径与实盘一致的地方:
//   · 特征窗口沿用 backtest.ts `barFeatures` 的窗口大小(15m 60 根 / 1h 120 根 / 4h 80 根 / 1d 260 根),
//     所以 EMA 的种子效应与实盘、回测完全相同;
//   · ATR 门槛用 `atrPctFloor(tf)`(review-metrics.ts 的分周期表);
//   · 追单上限、回踩量比、日线 range 量比取自 `breakout_retest` 的参数默认值。
//
//   · 现行规则(`CURRENT_THRESHOLDS`)的追单上限 / 回踩量比 / 突破窗口直接 import review-metrics.ts 的
//     `CHASE_ATR_MAX` / `RETEST_VOL_MIN` / `BREAKOUT_WINDOW`,不抄数字;`funnel.test.ts` 逐根断言
//     funnel 的现行口径与 `scanChecklist` 在同一组 K 线上判定一致。
//
// 突破位有两种口径(`breakout_level`):
//   `prior` = 收破与追单距离都按前 20 根(不含当根,`swing_high_20_prev`)—— `scanChecklist`(09-27 起
//             追单距离也量到这里)、triggers.ts、entry-policy.ts 追单闸共用的口径,现行规则用它。
//   `self`  = 收破与距离都比含当根的 20 根最高价 —— 2026-09-05 之前 `scanChecklist` 的旧 bug:
//             close ≤ high ≤ max(high),`last_close > swing_high_20` 恒为假,"回踩确认"永远不成立
//             (见文档第 1 节)。只留作复现/对照,不再是现行规则。

import { atrPctFloor, BREAKOUT_WINDOW, CHASE_ATR_MAX, RETEST_VOL_MIN } from './review-metrics.js';
import { dailyRegime, ema, fetchFundingRateHistory, marketExchange, tfToMs } from './market.js';
import { loadOkxInstruments } from './market-okx.js';
import { lastClosedIndex, loadKlines, loadFunding } from './backtest.js';
import { openTrade, stepTrade, tradeR, simulateOutcome } from './outcome.js';
import type { DailyRegime, Direction, Kline } from './types.js';

// ---------------------------------------------------------------- 条件与阈值

/** 一根 K 线上、与方向无关的原始度量;阶梯里所有变体都只在这些数上做算术。 */
export interface BarMetrics {
  /** 该根收盘时刻(= 判断可见的边界)。 */
  t: number;
  close: number;
  atr: number;
  atr_pct: number;
  atr_floor: number;
  /** 含当前根的 20 根高/低(tfFeatures.swing_high_20 / swing_low_20)。 */
  hi20: number;
  lo20: number;
  /** 不含当前根的前 20 根高/低(triggers.ts 的比较基准)。 */
  hi20_prev: number;
  lo20_prev: number;
  vol_ratio: number;
  ema20: number;
  dir_h1: Direction | null;
  dir_h4: Direction | null;
  /** 4h 收盘距 4h EMA20 多少个 4h ATR —— "4h 强烈反向"否决用的强度。 */
  h4_dist_atr: number | null;
  regime: DailyRegime['regime'] | null;
  /** |资金费率|,单位 %。历史缺失时为 null(缺失不算违规)。 */
  funding_abs_pct: number | null;
  /** 本根按 prior 口径收破了上/下沿。 */
  broke_up: boolean;
  broke_down: boolean;
  /** 距最近一次 prior 口径向上/向下突破多少根(0 = 就是本根,-1 = 窗口内没有)。 */
  bars_since_up: number;
  bars_since_down: number;
  /** 那次突破那根的量比(没有则 null)。 */
  break_vol_up: number | null;
  break_vol_down: number | null;
}

export interface FunnelThresholds {
  /** ATR% 门槛的倍数(1 = review-metrics 的分周期表原值)。 */
  atr_floor_mult: number;
  /** 距突破位多少 ATR 以内才算"在射程内"。 */
  chase_atr_max: number;
  /** 回踩确认要的量比。 */
  retest_vol_min: number;
  /** `current` = 只看当前这根的量比(现行);`either` = 当前根或那次突破那根任一达标即可。 */
  vol_mode: 'current' | 'either';
  /** `both` = 1h 与 4h 必须同向(现行);`h1_veto` = 只看 1h,4h 仅在"强烈反向"时否决。 */
  trend_mode: 'both' | 'h1_veto';
  /** h1_veto 下,4h 反向且距 4h EMA20 超过这么多 ATR 才算否决。 */
  h4_veto_atr: number;
  /** 突破位口径(见文件头):`prior` = 前 20 根(scanChecklist 现行);`self` = 旧 bug(含当根,收破恒不可达),只作对照。 */
  breakout_level: 'self' | 'prior';
  /** 突破视为"仍然有效"的回看根数(1 = 只认最近这一根收破)。 */
  breakout_window: number;
  /** 日线 range 时突破要的量比。 */
  range_vol_min: number;
  /** |资金费率| 上限,单位 %。 */
  funding_abs_max: number;
  /** true = 只在日线 bull/bear 里做(range/volatile 一律不做);质量变体用。 */
  require_trend_regime: boolean;
}

/**
 * 现行规则:`scanChecklist` 原样 + `breakout_retest` v1 参数默认值。前五项(ATR 分周期表、1h/4h 同向、
 * 追单距离、收破窗口、当根量比)与 scanChecklist 一一对应;资金费率与日线状态两条来自 playbook
 * 文字规则(scanChecklist 不算它们,模型按规则读)。
 */
export const CURRENT_THRESHOLDS: FunnelThresholds = {
  atr_floor_mult: 1,
  chase_atr_max: CHASE_ATR_MAX,
  retest_vol_min: RETEST_VOL_MIN,
  vol_mode: 'current',
  trend_mode: 'both',
  h4_veto_atr: 1,
  breakout_level: 'prior',
  breakout_window: BREAKOUT_WINDOW,
  range_vol_min: 1.5,
  funding_abs_max: 0.05,
  require_trend_regime: false,
};

export const CONDITION_KEYS = ['atr_ok', 'trend_agree', 'within_chase', 'breakout', 'retest_vol', 'funding_ok', 'regime_ok'] as const;
export type ConditionKey = (typeof CONDITION_KEYS)[number];

export const CONDITION_LABEL: Record<ConditionKey, string> = {
  atr_ok: 'ATR% ≥ 分周期门槛',
  trend_agree: '1h/4h EMA20-vs-EMA50 同向',
  within_chase: '距突破位 ≤ chase_atr_max ATR',
  breakout: '已收破突破位(窗口内)',
  retest_vol: '量比 ≥ retest_vol_min',
  funding_ok: '资金费率绝对值 ≤ 上限', // 标签里不放 `|`:它要进 markdown 表格
  regime_ok: '日线状态不反对该方向',
};

export interface ConditionEval {
  /** 该根的评估方向:联合判定用 1h/4h 同向的结果,同向不成立时退化成"离哪边近算哪边"。 */
  dir: Direction;
  /** 趋势条件本身是否成立(成立时 dir 就是它)。 */
  dir_trend: Direction | null;
  pass: Record<ConditionKey, boolean>;
  /** 七条全过 = 本该 PROPOSE。 */
  joint: boolean;
  /** 距突破位多少 ATR(按 dir + breakout_level;prior 口径与 scanChecklist 的 dist_to_break_atr 一致)。 */
  dist_atr: number;
  /** 该根的突破位价格(按 dir + breakout_level;prior 口径与实盘 freezeEntryBasis 一致),前瞻结算的止损锚。 */
  level: number;
  /** WATCH 口径:1h/4h 同向 且 在射程内 且 回踩尚未确认。 */
  watch_eligible: boolean;
  /** 现行"回踩确认" = 收破 且 量比达标。 */
  retest_confirmed: boolean;
}

/** 一根 K 线在一组阈值下的判定。纯算术,阶梯里被调用几十万次。 */
export function evaluateBar(m: BarMetrics, th: FunnelThresholds): ConditionEval {
  const dirTrend: Direction | null =
    th.trend_mode === 'both'
      ? m.dir_h1 !== null && m.dir_h1 === m.dir_h4
        ? m.dir_h1
        : null
      : m.dir_h1 !== null && !(m.dir_h4 !== null && m.dir_h4 !== m.dir_h1 && (m.h4_dist_atr ?? 0) > th.h4_veto_atr)
        ? m.dir_h1
        : null;
  // 方向无关的兜底:哪边的 20 根边沿更近就按哪边评估其余条件。只影响单条通过率与边际杀伤,
  // 联合判定仍然要求 trend_agree 成立(所以联合数对趋势口径是单调的)。
  const nearUp = Math.abs(m.close - m.hi20) <= Math.abs(m.close - m.lo20);
  const dir: Direction = dirTrend ?? (nearUp ? 'long' : 'short');
  const long = dir === 'long';
  const level = th.breakout_level === 'self' ? (long ? m.hi20 : m.lo20) : long ? m.hi20_prev : m.lo20_prev;
  const distAtr = m.atr > 0 ? Math.abs(m.close - level) / m.atr : Number.POSITIVE_INFINITY;

  const since = long ? m.bars_since_up : m.bars_since_down;
  const breakout =
    th.breakout_level === 'self'
      ? long
        ? m.close > m.hi20
        : m.close < m.lo20 // 恒为假:close ≤ high ≤ hi20(见文件头注释)
      : since >= 0 && since < th.breakout_window; // = scanChecklist 的 beyond / brokeWithin(近 window 根内有一根收破其前 20 根)
  const breakVol = long ? m.break_vol_up : m.break_vol_down;
  const volOk = m.vol_ratio >= th.retest_vol_min || (th.vol_mode === 'either' && breakVol !== null && since >= 0 && since < th.breakout_window && breakVol >= th.retest_vol_min);

  const regimeOk =
    m.regime === null
      ? !th.require_trend_regime
      : th.require_trend_regime && m.regime !== 'bull' && m.regime !== 'bear'
        ? false
        : m.regime === 'bear' && long
          ? false
          : m.regime === 'bull' && !long
            ? false
            : m.regime === 'range'
              ? m.vol_ratio >= th.range_vol_min
              : true;

  const pass: Record<ConditionKey, boolean> = {
    atr_ok: m.atr_pct >= m.atr_floor * th.atr_floor_mult,
    trend_agree: dirTrend !== null,
    within_chase: distAtr <= th.chase_atr_max,
    breakout,
    retest_vol: volOk,
    funding_ok: m.funding_abs_pct === null || m.funding_abs_pct <= th.funding_abs_max,
    regime_ok: regimeOk,
  };
  const joint = CONDITION_KEYS.every((k) => pass[k]);
  const retestConfirmed = breakout && volOk;
  return { dir, dir_trend: dirTrend, pass, joint, dist_atr: distAtr, level, watch_eligible: dirTrend !== null && pass.within_chase && !retestConfirmed, retest_confirmed: retestConfirmed };
}

// ---------------------------------------------------------------- 逐根度量(从 K 线到 BarMetrics)

/** market.ts `atr()` 的滚动版:atr[i] = 最近 period 根真实波幅的算术平均(i < period 时为 0)。 */
export function rollingAtr(bars: Kline[], period: number): number[] {
  const out = new Array<number>(bars.length).fill(0);
  const tr: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const h = Number(bars[i]!.high);
    const l = Number(bars[i]!.low);
    const pc = Number(bars[i - 1]!.close);
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let sum = 0;
  for (let i = 1; i < bars.length; i++) {
    sum += tr[i]!;
    if (i > period) sum -= tr[i - period]!;
    if (i >= period) out[i] = sum / period;
  }
  return out;
}

/** 每根之前(可含自身)最近 `n` 根的极值。`inclusive=false` 时不含自身(prior 口径)。 */
function rollingExtreme(bars: Kline[], n: number, pick: 'high' | 'low', inclusive: boolean): number[] {
  const out = new Array<number>(bars.length).fill(Number.NaN);
  for (let i = 0; i < bars.length; i++) {
    const end = inclusive ? i : i - 1;
    const start = Math.max(0, end - n + 1);
    if (end < start) continue;
    let best = pick === 'high' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    for (let j = start; j <= end; j++) {
      const v = Number(bars[j]![pick]);
      best = pick === 'high' ? Math.max(best, v) : Math.min(best, v);
    }
    out[i] = best;
  }
  return out;
}

/** tfFeatures 的量比口径:本根量 / 前 20 根均量。 */
function rollingVolRatio(bars: Kline[], n = 20): number[] {
  const out = new Array<number>(bars.length).fill(1);
  for (let i = 1; i < bars.length; i++) {
    const start = Math.max(0, i - n);
    const win = bars.slice(start, i);
    const avg = win.reduce((a, k) => a + Number(k.volume), 0) / Math.max(1, win.length);
    out[i] = avg > 0 ? Number(bars[i]!.volume) / avg : 1;
  }
  return out;
}

/** 窗口内(最后 `window` 根)重算的 EMA —— 与 tfFeatures 的种子效应一致。 */
function windowedEmaDir(bars: Kline[], window: number): { dir: (Direction | null)[]; ema20: number[] } {
  const dir: (Direction | null)[] = [];
  const e20out: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const win = bars.slice(Math.max(0, i - window + 1), i + 1).map((k) => Number(k.close));
    const a = ema(win, 20).at(-1)!;
    const b = ema(win, 50).at(-1)!;
    e20out.push(a);
    dir.push(a > b ? 'long' : a < b ? 'short' : null);
  }
  return { dir, ema20: e20out };
}

export interface SeriesBundle {
  base: Kline[];
  h1: Kline[];
  h4: Kline[];
  d1: Kline[];
  funding: { at: number; rate: string }[];
}

/**
 * 把一组 K 线压成逐根度量。`from`/`to` 之外的根只作暖机,不进结果。
 * 返回的 `bars` 与 `metrics` 一一对应(bars[i] 就是 metrics[i] 那根),前瞻结算要用它取隐藏 K 线。
 */
export function computeMetrics(s: SeriesBundle, tf: string, from: number, to: number): { metrics: BarMetrics[]; index: number[] } {
  const bars = s.base;
  const atrArr = rollingAtr(bars, 14);
  const hiIncl = rollingExtreme(bars, 20, 'high', true);
  const loIncl = rollingExtreme(bars, 20, 'low', true);
  const hiPrev = rollingExtreme(bars, 20, 'high', false);
  const loPrev = rollingExtreme(bars, 20, 'low', false);
  const vol = rollingVolRatio(bars, 20);
  const base = windowedEmaDir(bars, 60);
  const h1 = windowedEmaDir(s.h1, 120);
  const h4 = windowedEmaDir(s.h4, 80);
  const h4Atr = rollingAtr(s.h4, 14);
  const floor = atrPctFloor(tf);

  // prior 口径的突破序列(方向各一条),外加"那次突破那根的量比"。
  const brokeUp: boolean[] = [];
  const brokeDown: boolean[] = [];
  for (let i = 0; i < bars.length; i++) {
    const c = Number(bars[i]!.close);
    brokeUp.push(Number.isFinite(hiPrev[i]!) && c > hiPrev[i]!);
    brokeDown.push(Number.isFinite(loPrev[i]!) && c < loPrev[i]!);
  }

  const regimeCache = new Map<number, DailyRegime['regime'] | null>();
  const funding = s.funding;

  const metrics: BarMetrics[] = [];
  const index: number[] = [];
  let lastUp = -1;
  let lastDown = -1;
  for (let i = 0; i < bars.length; i++) {
    if (brokeUp[i]) lastUp = i;
    if (brokeDown[i]) lastDown = i;
    const t = bars[i]!.close_time;
    if (t < from || t > to) continue;
    if (i < 20 || !Number.isFinite(hiPrev[i]!)) continue;
    const close = Number(bars[i]!.close);
    const atr = atrArr[i]!;
    if (!(atr > 0) || !(close > 0)) continue;
    const i1 = lastClosedIndex(s.h1, t);
    const i4 = lastClosedIndex(s.h4, t);
    const iD = lastClosedIndex(s.d1, t);
    let regime: DailyRegime['regime'] | null = null;
    if (iD >= 0) {
      const cached = regimeCache.get(iD);
      if (cached !== undefined) regime = cached;
      else {
        const daily = s.d1.slice(Math.max(0, iD - 259), iD + 1);
        regime = daily.length >= 30 ? (dailyRegime(daily, t)?.regime ?? null) : null;
        regimeCache.set(iD, regime);
      }
    }
    const fIdx = lastFundingIndex(funding, t);
    const h4Dist = i4 >= 0 && h4Atr[i4]! > 0 ? Math.abs(Number(s.h4[i4]!.close) - h4.ema20[i4]!) / h4Atr[i4]! : null;
    metrics.push({
      t,
      close,
      atr,
      atr_pct: (atr / close) * 100,
      atr_floor: floor,
      hi20: hiIncl[i]!,
      lo20: loIncl[i]!,
      hi20_prev: hiPrev[i]!,
      lo20_prev: loPrev[i]!,
      vol_ratio: vol[i]!,
      ema20: base.ema20[i]!,
      dir_h1: i1 >= 0 ? h1.dir[i1]! : null,
      dir_h4: i4 >= 0 ? h4.dir[i4]! : null,
      h4_dist_atr: h4Dist,
      regime,
      funding_abs_pct: fIdx >= 0 ? Math.abs(Number(funding[fIdx]!.rate)) * 100 : null,
      broke_up: brokeUp[i]!,
      broke_down: brokeDown[i]!,
      bars_since_up: lastUp >= 0 ? i - lastUp : -1,
      bars_since_down: lastDown >= 0 ? i - lastDown : -1,
      break_vol_up: lastUp >= 0 ? vol[lastUp]! : null,
      break_vol_down: lastDown >= 0 ? vol[lastDown]! : null,
    });
    index.push(i);
  }
  return { metrics, index };
}

function lastFundingIndex(funding: { at: number }[], t: number): number {
  let lo = 0;
  let hi = funding.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (funding[mid]!.at <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

// ---------------------------------------------------------------- 前瞻结算

export interface OutcomeStats {
  gross?: { expectancy_r: number | null; total_r: number };
  net?: { expectancy_r: number | null; total_r: number };
  n: number;
  wins: number;
  win_rate: number | null;
  /** 每笔平均 R。 */
  expectancy_r: number | null;
  median_r: number | null;
  total_r: number;
  stops: number;
  tps: number;
  expired: number;
}

const EMPTY_OUTCOME: OutcomeStats = { n: 0, wins: 0, win_rate: null, expectancy_r: null, median_r: null, total_r: 0, stops: 0, tps: 0, expired: 0 };

export interface OutcomeParams {
  /** 止损放在突破位外多少个 ATR。 */
  stop_atr: number;
  /** 第一止盈 = 多少倍止损距离。 */
  tp_r: number;
  /** 最多向前走几根。 */
  horizon_bars: number;
}

export const OUTCOME_DEFAULTS: OutcomeParams = { stop_atr: 0.8, tp_r: 1.5, horizon_bars: 48 };

/**
 * 一个候选点的前瞻结算:下一根开盘市价成交,止损 = 突破位 ∓ stop_atr·ATR(突破位落在成交价错误
 * 一侧时退化成"成交价 ∓ stop_atr·ATR",否则开不了仓),第一止盈 = tp_r 倍止损距离。
 * 同根同触止损优先(outcome.ts 的 fail-pessimistic 口径),到期按收盘价出。
 */
export function scoreCandidate(bars: Kline[], i: number, m: BarMetrics, ev: ConditionEval, p: OutcomeParams): number | null {
  return scoreCandidateOutcome(bars, i, m, ev, p)?.gross_r ?? null;
}
function scoreCandidateOutcome(bars: Kline[], i: number, m: BarMetrics, ev: ConditionEval, p: OutcomeParams, funding: SeriesBundle['funding'] = []) {
  const next = bars[i + 1];
  if (!next || i + p.horizon_bars >= bars.length) return null;
  const fill = Number(next.open); const long = ev.dir === 'long'; const sign = long ? 1 : -1;
  const anchor = long ? Math.min(ev.level, fill) : Math.max(ev.level, fill);
  const stop = anchor - sign * p.stop_atr * m.atr;
  const tp = fill + sign * p.tp_r * Math.abs(fill - stop);
  return simulateOutcome({ direction: ev.dir, entry: 'market', limit_price: null, stop, tp, atr: m.atr, funding, bars: bars.slice(i + 1, i + 1 + p.horizon_bars) });
}

function summarize(rs: number[], statuses: { stops: number; tps: number; expired: number }): OutcomeStats {
  if (!rs.length) return { ...EMPTY_OUTCOME, ...statuses };
  const sorted = [...rs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return {
    n: rs.length,
    wins: rs.filter((r) => r > 0).length,
    win_rate: rs.filter((r) => r > 0).length / rs.length,
    expectancy_r: rs.reduce((a, b) => a + b, 0) / rs.length,
    median_r: sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2,
    total_r: rs.reduce((a, b) => a + b, 0),
    ...statuses,
  };
}

// ---------------------------------------------------------------- 放宽阶梯

export interface LadderRung {
  key: string;
  label: string;
  patch: Partial<FunnelThresholds>;
  /** 只有质量变体会动结算参数(止损/止盈/持有上限);阶梯本身全用同一套。 */
  outcome?: Partial<OutcomeParams>;
}

/**
 * 阶梯是**单调**的:每一级都在现行规则(`prior` 口径)上只把某个门槛放松,不会把原本通过的根挡掉,
 * 所以联合通过数只能升不能降(`funnel.test.ts` 断言这一点)。两处刻意的设计保证了这条性质:
 *   · `vol_mode: 'either'` 是"当前根 **或** 突破那根达标",不是"改成只看突破那根";
 *   · `trend_mode: 'h1_veto'` 在 1h/4h 同向时给出与 `both` 完全相同的方向。
 * 旧版这里有一级 `fix`(F:把收破基准从 self 换成前 20 根),各级都叠在它上面。scanChecklist 早已改成比前 20 根,
 * 现行规则本身就是修过的口径(09-27 起追单距离也量前 20 根),那一级与现行完全相同,所以删掉;
 * 各级直接叠在现行规则上,key 去掉了 `fix+` 前缀。
 */
export const LADDER: LadderRung[] = [
  { key: 'current', label: '现行规则(scanChecklist 原样)', patch: {} },
  { key: 'atr', label: '现行 + ATR 门槛 ×0.5', patch: { atr_floor_mult: 0.5 } },
  { key: 'chase2', label: '现行 + 距突破位 ≤ 2.0 ATR', patch: { chase_atr_max: 2 } },
  { key: 'vol08', label: '现行 + 量比 ≥ 0.8', patch: { retest_vol_min: 0.8 } },
  { key: 'volbreak', label: '现行 + 量比当根或突破那根达标即可', patch: { vol_mode: 'either' } },
  { key: 'h1', label: '现行 + 只看 1h(4h 强烈反向才否决)', patch: { trend_mode: 'h1_veto' } },
  { key: 'win12', label: '现行 + 回踩窗口放宽到 12 根', patch: { breakout_window: 12 } },
  { key: 'win12+volbreak', label: '现行 + 窗口 12 根 + 量比查突破那根', patch: { breakout_window: 12, vol_mode: 'either' } },
  { key: 'win12+volbreak+atr', label: '现行 + 窗口 12 + 量比突破根 + ATR ×0.5', patch: { breakout_window: 12, vol_mode: 'either', atr_floor_mult: 0.5 } },
  {
    key: 'win12+volbreak+atr+h1',
    label: '现行 + 窗口 12 + 量比突破根 + ATR ×0.5 + 只看 1h',
    patch: { breakout_window: 12, vol_mode: 'either', atr_floor_mult: 0.5, trend_mode: 'h1_veto' },
  },
  {
    key: 'all',
    label: '全部放宽(再加 chase 2.0 / range 量比 1.0)',
    patch: { breakout_window: 12, vol_mode: 'either', atr_floor_mult: 0.5, trend_mode: 'h1_veto', chase_atr_max: 2, range_vol_min: 1 },
  },
];

/**
 * 质量变体:都建立在阶梯 `win12+volbreak` 这个"能出单"的底座上,一次只动一个旋钮,
 * 回答的是另一个问题 —— **怎么把出来的单子变成正期望**(阶梯回答的是"有没有单子")。
 * 这些变体里有收紧的(量比 1.5、追单 0.8 ATR),所以它们**不满足**阶梯的单调性,单独一组。
 */
export const RECOMMENDED_BASE: Partial<FunnelThresholds> = { breakout_window: 12, vol_mode: 'either' };

export const VARIANTS: LadderRung[] = [
  { key: 'v-base', label: '底座:现行 + 窗口 12 + 量比查突破那根', patch: { ...RECOMMENDED_BASE } },
  { key: 'v-vol15', label: '底座 + 突破那根量比 ≥ 1.5', patch: { ...RECOMMENDED_BASE, retest_vol_min: 1.5 } },
  { key: 'v-vol20', label: '底座 + 突破那根量比 ≥ 2.0', patch: { ...RECOMMENDED_BASE, retest_vol_min: 2 } },
  { key: 'v-chase08', label: '底座 + 只在距突破位 ≤ 0.8 ATR 处入场', patch: { ...RECOMMENDED_BASE, chase_atr_max: 0.8 } },
  { key: 'v-chase05', label: '底座 + 只在距突破位 ≤ 0.5 ATR 处入场', patch: { ...RECOMMENDED_BASE, chase_atr_max: 0.5 } },
  { key: 'v-window4', label: '底座 + 突破必须在 4 根内(更新鲜)', patch: { ...RECOMMENDED_BASE, breakout_window: 4 } },
  { key: 'v-trendonly', label: '底座 + 只在日线 bull/bear 里做', patch: { ...RECOMMENDED_BASE, require_trend_regime: true } },
  { key: 'v-atr15', label: '底座 + ATR% 门槛 ×1.5(只做活跃的)', patch: { ...RECOMMENDED_BASE, atr_floor_mult: 1.5 } },
  { key: 'v-tp1', label: '底座,第一止盈 1.0R', patch: { ...RECOMMENDED_BASE }, outcome: { tp_r: 1 } },
  { key: 'v-tp2', label: '底座,第一止盈 2.0R', patch: { ...RECOMMENDED_BASE }, outcome: { tp_r: 2 } },
  { key: 'v-tp3', label: '底座,第一止盈 3.0R', patch: { ...RECOMMENDED_BASE }, outcome: { tp_r: 3 } },
  { key: 'v-stop12', label: '底座,止损 1.2 ATR', patch: { ...RECOMMENDED_BASE }, outcome: { stop_atr: 1.2 } },
  { key: 'v-stop05', label: '底座,止损 0.5 ATR', patch: { ...RECOMMENDED_BASE }, outcome: { stop_atr: 0.5 } },
  { key: 'v-horizon96', label: '底座,最多持有 96 根', patch: { ...RECOMMENDED_BASE }, outcome: { horizon_bars: 96 } },
  { key: 'v-quality', label: '底座 + 量比 1.5 + 窗口 4 + 只做趋势日线', patch: { ...RECOMMENDED_BASE, retest_vol_min: 1.5, breakout_window: 4, require_trend_regime: true } },
  // 对照组:把所有条件都拆掉,只剩"跟着 1h EMA20/50 的方向,每 cooldown 根开一次"。它回答的是
  // 「这套形态到底有没有超过'随便顺着 1h 做'的价值」—— 没有这一行,阶梯里的期望 R 无从参照。
  {
    key: 'v-control',
    label: '对照:无条件,只跟 1h 方向(每 4 根一次)',
    patch: { ...RECOMMENDED_BASE, atr_floor_mult: 0, chase_atr_max: 1e9, breakout_window: 1e9, retest_vol_min: 0, range_vol_min: 0, trend_mode: 'h1_veto', h4_veto_atr: 1e9 },
  },
];

// ---------------------------------------------------------------- 一个币的漏斗

export interface ConditionRow {
  key: ConditionKey;
  label: string;
  pass: number;
  rate: number;
  /** 其余六条全过、只死在这一条上的根数 —— "谁在杀机会"。 */
  marginal_kills: number;
}

export interface LadderRow {
  key: string;
  label: string;
  joint: number;
  /** 按 cooldown 去重后的独立机会数。 */
  setups: number;
  per_week: number;
  outcome: OutcomeStats;
}

export interface FunnelSymbol {
  symbol: string;
  timeframe: string;
  from: number;
  to: number;
  bars: number;
  weeks: number;
  conditions: ConditionRow[];
  /**
   * 兼容字段。原意是"底座换成突破位用前 20 根"的边际分析(旧现行口径 self 下 `breakout` 恒为假,
   * `conditions` 只能证明根因)。现行规则已是修过的口径,所以它与 `conditions` 相同;只有调用方
   * 用 `thresholds.breakout_level: 'self'` 复现旧 bug 时,它才换成 `prior` 口径单独算。
   */
  conditions_fixed: ConditionRow[];
  joint: number;
  setups: number;
  per_week: number;
  /** 参考口径:WATCH 资格、现行"回踩确认"、"最近一根收破其前 20 根"。 */
  watch_eligible: number;
  retest_confirmed: number;
  breakout_prior_last_bar: number;
  top_killers: ConditionRow[];
  /** conditions_fixed 排出来的前三。 */
  top_killers_fixed: ConditionRow[];
  ladder: LadderRow[];
  /** 质量变体(VARIANTS):同一批底座候选下,收紧/放松单个旋钮后的前瞻期望。 */
  variants: LadderRow[];
  note: string | null;
}

export interface FunnelOptions {
  timeframe?: string;
  cooldown_bars?: number;
  outcome?: Partial<OutcomeParams>;
  ladder?: LadderRung[];
  variants?: LadderRung[];
  thresholds?: Partial<FunnelThresholds>;
}

/** 联合通过的根按 cooldown 去重(与 breakout_retest.trigger.cooldown_bars 同义)。 */
function dedupe<T extends { i: number }>(hits: T[], cooldown: number): T[] {
  const out: T[] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (const h of hits) {
    if (h.i - last < cooldown) continue;
    out.push(h);
    last = h.i;
  }
  return out;
}

/** 纯函数版:K 线已经在手上时算一个币的漏斗(测试直接喂合成序列)。 */
export function funnelForSeries(symbol: string, s: SeriesBundle, from: number, to: number, opts: FunnelOptions = {}): FunnelSymbol {
  const tf = opts.timeframe ?? '15m';
  const cooldown = opts.cooldown_bars ?? 4;
  const outcomeParams: OutcomeParams = { ...OUTCOME_DEFAULTS, ...opts.outcome };
  const ladder = opts.ladder ?? LADDER;
  const th0: FunnelThresholds = { ...CURRENT_THRESHOLDS, ...opts.thresholds };
  const { metrics, index } = computeMetrics(s, tf, from, to);
  const weeks = Math.max(1e-9, (to - from) / (7 * 86_400_000));

  const conditionsFor = (th: FunnelThresholds): ConditionRow[] => {
    const evals = metrics.map((m) => evaluateBar(m, th));
    return CONDITION_KEYS.map((key) => {
      let pass = 0;
      let kills = 0;
      for (const ev of evals) {
        if (ev.pass[key]) pass++;
        else if (CONDITION_KEYS.every((k) => k === key || ev.pass[k])) kills++;
      }
      return { key, label: CONDITION_LABEL[key], pass, rate: metrics.length ? pass / metrics.length : 0, marginal_kills: kills };
    });
  };
  const evals = metrics.map((m) => evaluateBar(m, th0));
  const conditions = conditionsFor(th0);
  const conditionsFixed = th0.breakout_level === 'self' ? conditionsFor({ ...th0, breakout_level: 'prior' }) : conditions;

  const runRungs = (rungs: LadderRung[]): LadderRow[] =>
    rungs.map((rung) => {
      const th: FunnelThresholds = { ...th0, ...rung.patch };
      const op: OutcomeParams = { ...outcomeParams, ...rung.outcome };
      const hits: { i: number; ev: ConditionEval }[] = [];
      for (let i = 0; i < metrics.length; i++) {
        const ev = evaluateBar(metrics[i]!, th);
        if (ev.joint) hits.push({ i, ev });
      }
      const kept = dedupe(hits, cooldown);
      const rs: number[] = []; const netRs: number[] = [];
      const statuses = { stops: 0, tps: 0, expired: 0 };
      for (const h of kept) {
        const scored = scoreCandidateOutcome(s.base, index[h.i]!, metrics[h.i]!, h.ev, op, s.funding);
        const r = scored?.gross_r ?? null;
        if (r === null) continue;
        rs.push(r); netRs.push(scored!.net_r!);
        if (r <= -0.999) statuses.stops++;
        else if (r >= op.tp_r - 0.001) statuses.tps++;
        else statuses.expired++;
      }
      return { key: rung.key, label: rung.label, joint: hits.length, setups: kept.length, per_week: kept.length / weeks, outcome: { ...summarize(rs, statuses), gross: { expectancy_r: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null, total_r: rs.reduce((a, b) => a + b, 0) }, net: { expectancy_r: netRs.length ? netRs.reduce((a, b) => a + b, 0) / netRs.length : null, total_r: netRs.reduce((a, b) => a + b, 0) } } };
    });

  const rows = runRungs(ladder);
  const variantRows = runRungs(opts.variants ?? VARIANTS);

  const base = rows.find((r) => r.key === 'current');
  return {
    symbol,
    timeframe: tf,
    from,
    to,
    bars: metrics.length,
    weeks,
    conditions,
    conditions_fixed: conditionsFixed,
    joint: base?.joint ?? 0,
    setups: base?.setups ?? 0,
    per_week: base?.per_week ?? 0,
    watch_eligible: evals.filter((e) => e.watch_eligible).length,
    retest_confirmed: evals.filter((e) => e.retest_confirmed).length,
    breakout_prior_last_bar: metrics.filter((m) => m.broke_up || m.broke_down).length,
    top_killers: [...conditions].sort((a, b) => b.marginal_kills - a.marginal_kills).slice(0, 3),
    top_killers_fixed: [...conditionsFixed].sort((a, b) => b.marginal_kills - a.marginal_kills).slice(0, 3),
    ladder: rows,
    variants: variantRows,
    note: metrics.length ? null : '窗口内没有可用 K 线',
  };
}

// ---------------------------------------------------------------- 拉数据 + 全量报告

/** 当前行情交易所的中文名(文案用:「OKX 上没有」/「币安上没有」)。 */
export function venueLabel(): string {
  return marketExchange() === 'okx' ? 'OKX' : '币安';
}
/** 「OKX 上没有」/「币安上没有」。 */
export function notListedLabel(): string {
  return marketExchange() === 'okx' ? 'OKX 上没有' : '币安上没有';
}

/**
 * 存在性判断,按 `marketExchange()` 分流(TG_EXCHANGE 显式优先)。
 *  - OKX:在售的 USDT 本位线性永续(okx/instruments 的 10 分钟缓存表;funnel / radar 都按永续算),
 *    contract_type 固定 'SWAP',onboard 给 0(上线时间看 /api/universe 的 listed_at)。
 *    不 import universe-okx:它 → screener → funnel 会成环,screener 顶层用到 funnel 的常量。
 *  - 币安:`fetchExchangeInfo` 只收 PERPETUAL,币安的**股票/商品永续是 TRADIFI_PERPETUAL**,要单独判存在性。
 */
export async function listTradableSymbols(candidates: string[]): Promise<{ existing: { symbol: string; contract_type: string; onboard: number }[]; missing: string[] }> {
  if (marketExchange() === 'okx') {
    const insts = await loadOkxInstruments(false, 'perp');
    const live = new Set(insts.map((i) => i.symbol));
    const existing: { symbol: string; contract_type: string; onboard: number }[] = [];
    const missing: string[] = [];
    for (const c of candidates) {
      if (live.has(c)) existing.push({ symbol: c, contract_type: 'SWAP', onboard: 0 });
      else missing.push(c);
    }
    return { existing, missing };
  }
  const base = process.env['TG_DEMO_MARKET_BASE'] ?? 'https://fapi.binance.com';
  const res = await fetch(`${base}/fapi/v1/exchangeInfo`);
  if (!res.ok) throw new Error(`exchangeInfo -> HTTP ${res.status}`);
  const info = (await res.json()) as { symbols: { symbol: string; status: string; contractType: string; onboardDate?: number }[] };
  const map = new Map(info.symbols.map((s) => [s.symbol, s]));
  const existing: { symbol: string; contract_type: string; onboard: number }[] = [];
  const missing: string[] = [];
  for (const c of candidates) {
    const s = map.get(c);
    if (s && s.status === 'TRADING') existing.push({ symbol: c, contract_type: s.contractType, onboard: Number(s.onboardDate ?? 0) });
    else missing.push(c);
  }
  return { existing, missing };
}

/** funnel 需要的四条 K 线序列 + 资金费率,全部走 backtest.ts 的磁盘缓存。 */
export async function loadFunnelSeries(symbol: string, tf: string, from: number, to: number): Promise<SeriesBundle> {
  const step = tfToMs(tf);
  const base = await loadKlines(symbol, tf, from - 400 * step, to);
  const h1 = await loadKlines(symbol, '1h', from - 120 * 3_600_000, to);
  const h4 = await loadKlines(symbol, '4h', from - 80 * 14_400_000, to);
  const d1 = await loadKlines(symbol, '1d', from - 400 * 86_400_000, to);
  let funding: { at: number; rate: string }[] = [];
  try {
    if (marketExchange() === 'okx') {
      // OKX:资金费历史走 market-okx(新→旧翻页,只保留约 3 个月);backtest.loadFunding 是币安 fapi 专用。
      const start = from - 30 * 86_400_000;
      const want = Math.min(1000, Math.ceil((to - start) / (8 * 3_600_000)) + 10);
      funding = (await fetchFundingRateHistory(symbol, want, start)).filter((f) => f.at <= to);
    } else funding = await loadFunding(symbol, from - 30 * 86_400_000, to);
  } catch {
    funding = [];
  }
  return { base, h1, h4, d1, funding };
}

export interface FunnelReport {
  generated_at: number;
  timeframe: string;
  days: number;
  from: number;
  to: number;
  outcome: OutcomeParams;
  cooldown_bars: number;
  symbols: FunnelSymbol[];
  /** 请求过但当前交易所上没有(OKX:不在售的永续;币安:不在 TRADING)的代码。 */
  missing: string[];
  /** 存在的代码及合约类型(TRADIFI_PERPETUAL = 股票/商品永续)。 */
  listed: { symbol: string; contract_type: string; onboard: number }[];
  errors: { symbol: string; error: string }[];
}

export interface RunFunnelOptions extends FunnelOptions {
  days?: number;
  now?: number;
  /** 每个币之间的停顿,别把公共 REST 打到限速。 */
  pause_ms?: number;
  onProgress?: (symbol: string, done: number, total: number) => void;
}

export async function runFunnel(symbols: string[], opts: RunFunnelOptions = {}): Promise<FunnelReport> {
  const tf = opts.timeframe ?? '15m';
  const days = opts.days ?? 60;
  const now = opts.now ?? Date.now();
  const to = now;
  const from = to - days * 86_400_000;
  const listing = await listTradableSymbols(symbols).catch(() => ({ existing: symbols.map((s) => ({ symbol: s, contract_type: 'UNKNOWN', onboard: 0 })), missing: [] as string[] }));
  const out: FunnelSymbol[] = [];
  const errors: { symbol: string; error: string }[] = [];
  let done = 0;
  for (const row of listing.existing) {
    try {
      const series = await loadFunnelSeries(row.symbol, tf, from, to);
      out.push(funnelForSeries(row.symbol, series, from, to, opts));
    } catch (e) {
      errors.push({ symbol: row.symbol, error: (e as Error).message.slice(0, 200) });
    }
    done++;
    opts.onProgress?.(row.symbol, done, listing.existing.length);
    if (opts.pause_ms) await new Promise((r) => setTimeout(r, opts.pause_ms));
  }
  return {
    generated_at: now,
    timeframe: tf,
    days,
    from,
    to,
    outcome: { ...OUTCOME_DEFAULTS, ...opts.outcome },
    cooldown_bars: opts.cooldown_bars ?? 4,
    symbols: out,
    missing: listing.missing,
    listed: listing.existing,
    errors,
  };
}

/** 6 个主流 + 8794 白名单里的候选(存在性由 listTradableSymbols 按交易所判;OKX 上没有的会进 missing)。 */
export const DEFAULT_FUNNEL_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'HYPEUSDT',
  'PENGUUSDT',
  'TSLAUSDT',
  'NVDAUSDT',
  'AAPLUSDT',
  'GOOGLUSDT',
  'AMDUSDT',
  'QQQUSDT',
  'MUUSDT',
  'SNDKUSDT',
  'CRCLUSDT',
  'SPCXUSDT',
  'CLUSDT',
  'XAUUSDT',
  'XAUTUSDT',
  'XAGUSDT',
  'SOXSUSDT',
  'KORUUSDT',
  'TENCENTUSDT',
  'CXMTUSDT',
  'SKHYNIXUSDT',
];

/** 汇总:所有币的联合通过数、每周机会数、前瞻期望,按阶梯级别合并。 */
export function aggregateLadder(report: FunnelReport, which: 'ladder' | 'variants' = 'ladder'): (LadderRow & { symbols_with_setups: number })[] {
  const keys = report.symbols[0]?.[which].map((r) => r.key) ?? [];
  return keys.map((key) => {
    const rows = report.symbols.map((s) => s[which].find((r) => r.key === key)).filter((r): r is LadderRow => !!r);
    const joint = rows.reduce((a, r) => a + r.joint, 0);
    const setups = rows.reduce((a, r) => a + r.setups, 0);
    const perWeek = rows.reduce((a, r) => a + r.per_week, 0);
    const n = rows.reduce((a, r) => a + r.outcome.n, 0);
    const wins = rows.reduce((a, r) => a + r.outcome.wins, 0);
    const totalR = rows.reduce((a, r) => a + r.outcome.total_r, 0);
    return {
      key,
      label: rows[0]?.label ?? key,
      joint,
      setups,
      per_week: perWeek,
      symbols_with_setups: rows.filter((r) => r.setups > 0).length,
      outcome: {
        gross: { expectancy_r: n ? totalR / n : null, total_r: totalR },
        net: { expectancy_r: n ? rows.reduce((a, r) => a + (r.outcome.net?.total_r ?? 0), 0) / n : null, total_r: rows.reduce((a, r) => a + (r.outcome.net?.total_r ?? 0), 0) },
        n,
        wins,
        win_rate: n ? wins / n : null,
        expectancy_r: n ? totalR / n : null,
        median_r: null,
        total_r: totalR,
        stops: rows.reduce((a, r) => a + r.outcome.stops, 0),
        tps: rows.reduce((a, r) => a + r.outcome.tps, 0),
        expired: rows.reduce((a, r) => a + r.outcome.expired, 0),
      },
    };
  });
}
