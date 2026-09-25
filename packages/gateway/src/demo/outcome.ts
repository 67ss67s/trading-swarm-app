// Outcome simulation on bars the judgment could not see (docs/eval/README.md §4 outcome_R / missed_move).
// Moved here from packages/eval-a/src/outcome.ts (2026-09-05) so the blind backtester (backtest.ts) and the
// eval harness share ONE definition of "what happened after"; eval-a's outcome.ts now re-exports this file.
//
// Conventions: market entry fills at the next bar's open; a limit fills at the limit (or at the open
// if the bar gaps through it) the first bar that touches it — gap-through does NOT improve the fill (09-12 conservative); on any bar where both the stop and the
// take-profit are touched the stop wins (fail-pessimistic); a gap through the stop exits at the open;
// unresolved at the horizon → closed at the last close. R is signed P&L over the initial stop distance.
//
// Two entry points on the same rules:
//   simulateOutcome() — one shot over a fixed window (eval: the hidden bars).
//   openTrade()/stepTrade() — the same rules bar by bar, for a walk that can be interrupted (backtest:
//   a blind review may EXIT before the stop/tp is reached). simulateOutcome is implemented on top of
//   them, so there is exactly one copy of the fill/stop/tp semantics.

import type { Direction, Kline } from './types.js';

export interface OutcomeInput {
  direction: Direction;
  entry: 'market' | 'limit';
  limit_price: number | null;
  stop: number;
  tp: number | null;
  bars: Kline[];
  costs?: Partial<CostModel>;
  atr?: number;
  funding?: { at: number; rate: string }[];
}

export type OutcomeStatus = 'stop' | 'tp' | 'expired' | 'unfilled' | 'invalid';

export interface Outcome {
  status: OutcomeStatus;
  fill_price: number | null;
  fill_bar: number | null;
  exit_price: number | null;
  exit_bar: number | null;
  exit_at?: number;
  stop_distance: number | null;
  gross_r?: number | null;
  net_r?: number | null;
  cost_r?: number | null;
  funding_estimated?: boolean;
  r: number | null;
  mae_r: number | null;
  mfe_r: number | null;
  bars_held: number | null;
  note: string;
}

const none = (status: OutcomeStatus, note: string): Outcome => ({ status, fill_price: null, fill_bar: null, exit_price: null, exit_bar: null, stop_distance: null, r: null, mae_r: null, mfe_r: null, bars_held: null, note });

/** A filled position being walked forward one bar at a time. Mutated by stepTrade(). */
export interface OpenTrade {
  direction: Direction;
  fill_price: number;
  stop: number;
  tp: number | null;
  /** |fill − stop| at entry; the denominator of every R on this trade (never re-based). */
  stop_distance: number;
  mae_r: number;
  mfe_r: number;
  /** Bars processed since (and including) the fill bar. */
  bars_held: number;
}

/** null when the stop sits on the wrong side of the fill (the one case the walk cannot start). */
export function openTrade(direction: Direction, fill: number, stop: number, tp: number | null): OpenTrade | null {
  const sgn = direction === 'long' ? 1 : -1;
  const stopDistance = sgn * (fill - stop);
  if (!(stopDistance > 0)) return null;
  return { direction, fill_price: fill, stop, tp, stop_distance: stopDistance, mae_r: 0, mfe_r: 0, bars_held: 0 };
}

/** Signed R of `px` for this trade (positive = in the trade's favour). */
export function tradeR(t: OpenTrade, px: number): number {
  const sgn = t.direction === 'long' ? 1 : -1;
  return (sgn * (px - t.fill_price)) / t.stop_distance;
}

export interface TradeStep {
  /** Set when this bar closed the trade; the caller stops walking. */
  exit: { price: number; at: number; status: 'stop' | 'tp'; note: string } | null;
}

/**
 * One bar against an open trade: updates MAE/MFE and the held-bar count, then checks stop before
 * take-profit (fail-pessimistic) with gap-through handled at the bar's open.
 */
export function stepTrade(t: OpenTrade, bar: Kline, allowTakeProfit = true): TradeStep {
  const o = Number(bar.open);
  const h = Number(bar.high);
  const l = Number(bar.low);
  t.bars_held += 1;
  const adverse = t.direction === 'long' ? l : h;
  const favorable = t.direction === 'long' ? h : l;
  t.mae_r = Math.min(t.mae_r, tradeR(t, adverse));
  t.mfe_r = Math.max(t.mfe_r, tradeR(t, favorable));
  const hitStop = t.direction === 'long' ? l <= t.stop : h >= t.stop;
  const hitTp = allowTakeProfit && t.tp !== null && (t.direction === 'long' ? h >= t.tp : l <= t.tp);
  if (hitStop) {
    const gapped = t.direction === 'long' ? o < t.stop : o > t.stop;
    return { exit: { price: gapped ? o : t.stop, at: gapped ? bar.open_time : bar.close_time, status: 'stop', note: hitTp ? '同根同时触及止损与止盈,按止损计' : gapped ? '跳空穿越止损,按开盘价出' : '触及止损' } };
  }
  if (hitTp && t.tp !== null) {
    const gapped = t.direction === 'long' ? o > t.tp : o < t.tp;
    return { exit: { price: gapped ? o : t.tp, at: gapped ? bar.open_time : bar.close_time, status: 'tp', note: gapped ? '跳空穿越止盈,按开盘价出' : '触及止盈' } };
  }
  return { exit: null };
}

export interface CostModel {
  taker: number; maker: number; tick: number; slippage_atr: number;
  funding_mean: number; funding_interval_ms: number;
}
export const DEFAULT_COSTS: CostModel = { taker: 0.0005, maker: 0.0002, tick: 0.00000001, slippage_atr: 0.01, funding_mean: 0, funding_interval_ms: 28_800_000 };
/** 以初始风险归一化；资金费正值由多头付给空头。费率以小数给入。 */
export function tradeCosts(t: OpenTrade, exit: number, entry: 'market' | 'limit', from: number, to: number, atrValue: number, funding: { at: number; rate: string }[] = [], overrides: Partial<CostModel> = {}) {
  const c = { ...DEFAULT_COSTS, ...overrides };
  if (Object.values(c).some(v => !Number.isFinite(v)) || c.tick <= 0 || c.taker < 0 || c.maker < 0 || c.slippage_atr < 0 || c.funding_interval_ms <= 0) throw new Error('无效成本模型');
  const slip = Math.max(c.tick, c.slippage_atr * atrValue);
  const fees = t.fill_price * (entry === 'limit' ? c.maker : c.taker) + exit * c.taker;
  const known = funding.filter(f => f.at > from && f.at <= to);
  const expected = Math.max(0, Math.floor(to / c.funding_interval_ms) - Math.floor(from / c.funding_interval_ms));
  const missing = Math.max(0, expected - known.length);
  const interval = funding.filter(f => f.at >= from - 30 * 86_400_000 && f.at <= to);
  const fallback = overrides.funding_mean ?? (interval.length ? interval.reduce((a, f) => a + Number(f.rate), 0) / interval.length : c.funding_mean);
  const rate = known.reduce((v, f) => v + Number(f.rate), 0) + missing * fallback;
  const fundingCost = (t.direction === 'long' ? 1 : -1) * t.fill_price * rate;
  const cost_r = (fees + slip * (entry === 'market' ? 2 : 1) + fundingCost) / t.stop_distance;
  return { cost_r, fee_r: fees / t.stop_distance, slip_r: slip * (entry === 'market' ? 2 : 1) / t.stop_distance, funding_r: fundingCost / t.stop_distance, funding_expected: expected, funding_known: Math.min(expected, known.length), funding_estimated: missing > 0 };
}
/** 挂单仅在穿价至少一 tick 后成交；触价不算，避免 OHLC 排队乐观偏差。 */
export function conservativeLimitFill(direction: Direction, limit: number, bar: Kline, tick = DEFAULT_COSTS.tick): number | null {
  const crossed = direction === 'long' ? Number(bar.low) <= limit - tick : Number(bar.high) >= limit + tick;
  if (!crossed) return null;
  // 不给跳空改善价格，且不使用未完成的信号根。
  return limit;
}

/** The fill bar and price for an entry against `bars` (bars[0] = the first bar after the judgment). */
export function findFill(inp: Pick<OutcomeInput, 'direction' | 'entry' | 'limit_price' | 'costs'>, bars: Kline[]): { bar: number; price: number } | null {
  if (!bars.length) return null;
  if (inp.entry === 'market') return { bar: 0, price: Number(bars[0]!.open) };
  if (inp.limit_price === null) return null;
  const lim = inp.limit_price;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const price = conservativeLimitFill(inp.direction, lim, b, inp.costs?.tick);
    if (price !== null) return { bar: i, price };
  }
  return null;
}

function simulateGrossOutcome(inp: OutcomeInput): Outcome {
  const bars = inp.bars;
  if (!bars.length) return none('invalid', '没有未来 K 线');
  if (inp.entry === 'limit' && inp.limit_price === null) return none('invalid', '限价单没有 limit_price');
  const fill = findFill(inp, bars);
  if (!fill) return none('unfilled', '限价在 horizon 内未触及');
  const t = openTrade(inp.direction, fill.price, inp.stop, inp.tp);
  if (!t) return none('invalid', `止损 ${inp.stop} 在成交价 ${fill.price} 的错误一侧`);
  for (let i = fill.bar; i < bars.length; i++) {
    const ambiguousFill = i === fill.bar && inp.entry === 'limit' && (inp.direction === 'long' ? Number(bars[i]!.open) > fill.price : Number(bars[i]!.open) < fill.price);
    const step = stepTrade(t, bars[i]!, !ambiguousFill);
    if (!step.exit) continue;
    return { status: step.exit.status, fill_price: fill.price, fill_bar: fill.bar, exit_price: step.exit.price, exit_bar: i, exit_at: step.exit.at, stop_distance: t.stop_distance, r: tradeR(t, step.exit.price), mae_r: t.mae_r, mfe_r: t.mfe_r, bars_held: t.bars_held, note: step.exit.note };
  }
  const last = bars[bars.length - 1]!;
  const exit = Number(last.close);
  return { status: 'expired', fill_price: fill.price, fill_bar: fill.bar, exit_price: exit, exit_bar: bars.length - 1, exit_at: last.close_time, stop_distance: t.stop_distance, r: tradeR(t, exit), mae_r: t.mae_r, mfe_r: t.mfe_r, bars_held: t.bars_held, note: '到期按收盘价出' };
}

/** Largest absolute excursion from p0 over the hidden bars, in ATR units. */
export function missedMove(p0: number, atr: number, bars: Kline[]): { up_atr: number; down_atr: number; max_atr: number } | null {
  if (!bars.length || !(atr > 0)) return null;
  let hi = Number.NEGATIVE_INFINITY;
  let lo = Number.POSITIVE_INFINITY;
  for (const b of bars) {
    hi = Math.max(hi, Number(b.high));
    lo = Math.min(lo, Number(b.low));
  }
  const up = (hi - p0) / atr;
  const down = (p0 - lo) / atr;
  return { up_atr: up, down_atr: down, max_atr: Math.max(up, down) };
}

/** gross 保留既有 r 兼容；策略与晋升调用方必须显式取 net_r。 */
export function simulateOutcome(inp: OutcomeInput): Outcome {
  const out = simulateGrossOutcome(inp);
  if (out.r === null || out.fill_bar === null || out.exit_bar === null) return { ...out, gross_r: null, net_r: null, cost_r: null, funding_estimated: false };
  const t = openTrade(inp.direction, out.fill_price!, inp.stop, inp.tp)!;
  const cost = tradeCosts(t, out.exit_price!, inp.entry, inp.bars[out.fill_bar]!.open_time, out.exit_at ?? inp.bars[out.exit_bar]!.close_time, inp.atr ?? t.stop_distance, inp.funding, inp.costs);
  return { ...out, gross_r: out.r, net_r: out.r - cost.cost_r, ...cost };
}

/** 各闭合根的净清算权益；费用/资金费只使用估值时点以前的数据。 */
export function outcomeEquityMarks(inp: OutcomeInput, out: Outcome): { at: number; r: number }[] {
  if (out.fill_price === null || out.fill_bar === null || out.exit_bar === null) return [];
  const trade = openTrade(inp.direction, out.fill_price, inp.stop, inp.tp);
  if (!trade) return [];
  const from = inp.bars[out.fill_bar]!.open_time;
  const exitAt = out.exit_at ?? inp.bars[out.exit_bar]!.close_time;
  return inp.bars.slice(out.fill_bar, out.exit_bar + 1).filter(b => b.close_time < exitAt).map(b => {
    const px = Number(b.close);
    const cost = tradeCosts(trade, px, inp.entry, from, b.close_time, inp.atr ?? trade.stop_distance, inp.funding, inp.costs);
    return { at: b.close_time, r: tradeR(trade, px) - cost.cost_r };
  });
}

// 独立离线双腿结算，不复用单腿R/执行协议。
export { simulatePairOutcome, settlePairLeg } from './pair-outcome.js';
