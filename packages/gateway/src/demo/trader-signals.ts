/** 交易员启发的离线族：不扩展生产 StrategyFamily，不进入 active/measurable。 */
import type { SignalFn, Setup } from "./strategy-signals.js";
import { atr } from "./market.js";
export const TRADER_GRID = {
  trader_sr_reversal: [0.1, 0.2, 0.3].map((offset_atr) => ({ offset_atr })),
  trader_intraday_sweep: [0.1, 0.3, 0.5].map((sweep_atr) => ({ sweep_atr })),
} as const;
const sr: SignalFn = (c) => {
  const bars = c.bars["4h"] ?? [];
  if (bars.length < 25) return null;
  const last = bars.at(-1)!,
    prior = bars.slice(-21, -1),
    a = atr(bars.slice(-15), 14);
  if (!(a > 0)) return null;
  const hi = Math.max(...prior.map((b) => Number(b.high))),
    lo = Math.min(...prior.map((b) => Number(b.low))),
    close = Number(last.close);
  const long = Math.abs(close - lo) < Math.abs(close - hi),
    edge = long ? lo : hi,
    sign = long ? 1 : -1;
  if (Math.abs(close - edge) > 0.5 * a || sign * (close - edge) < 0)
    return null;
  const offset = c.params.offset_atr?.value ?? 0.2;
  const price = edge + sign * offset * a;
  // 已穿到报价另一侧则不追，当前根不用于成交。
  if (sign * (close - price) <= 0) return null;
  return {
    at: last.close_time,
    direction: long ? "long" : "short",
    entry: "limit",
    reference_price: String(price),
    trigger_price: String(edge),
    atr: a,
    stop_distance: String((0.5 + offset) * a),
    tp_r: 2,
    invalidation: ["24h到期；结构区外0.5ATR止损；1/2/3R等份止盈"],
    coverage: "ohlcv",
  };
};
const sweep: SignalFn = (c) => {
  const bars = c.bars["1h"] ?? [];
  if (bars.length < 25) return null;
  const last = bars.at(-1)!,
    prior = bars.slice(-25, -1),
    a = atr(bars.slice(-15), 14);
  if (!(a > 0)) return null;
  const hi = Math.max(...prior.map((b) => Number(b.high))),
    lo = Math.min(...prior.map((b) => Number(b.low))),
    close = Number(last.close),
    threshold = c.params.sweep_atr?.value ?? 0.3;
  const long = Number(last.low) < lo - threshold * a && close > lo;
  const short = Number(last.high) > hi + threshold * a && close < hi;
  if (long === short) return null;
  return {
    at: last.close_time,
    direction: long ? "long" : "short",
    entry: "market",
    reference_price: String(close),
    atr: a,
    stop_distance: String(1.5 * a),
    tp_r: 2,
    invalidation: [
      "两腿各占初始风险1/2；第二腿被动0.3ATR；首档止盈后下一根保本；24h到期",
    ],
    coverage: "ohlcv",
  };
};
export const TRADER_SIGNAL_REGISTRY: Record<
  keyof typeof TRADER_GRID,
  SignalFn
> = { trader_sr_reversal: sr, trader_intraday_sweep: sweep };
/** 人肉信号也走确定性接口；发布事件由离线 caller 注入，不进入生产上下文。 */
export function humanSignal(signal: Setup): SignalFn {
  return (c) => {
    const last = c.bars[c.timeframe]?.at(-1);
    return last &&
      last.close_time <= signal.at &&
      signal.at - last.close_time < last.close_time - last.open_time + 1
      ? structuredClone(signal)
      : null;
  };
}

export const HUMAN_SIGNAL_REGISTRY: Record<string, (event: Setup) => SignalFn> =
  {
    human_trader_a: humanSignal,
    human_trader_b: humanSignal,
    human_trader_c: humanSignal,
  };
