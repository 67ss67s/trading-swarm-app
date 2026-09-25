/** 逐单成交规则,逐字对照 8794 shadow.rs(REPLAY_ENGINE_VERSION=11)的 v9 口径:
 *  - 限价入场(entry_limit_fill):多单 open 已低于限价 → 按更优 open 成交(gap);否则 low 触价按限价。空单镜像。
 *  - 止损(stop_fill):触发后是市价单,open 已越过 → 按更差 open;否则按 stop。多单向下触发,空单向上。
 *  - 止盈(take_profit_fill):限价单,open 已越过 → 按更优 open;否则按 target。
 *  - 所有成交价钳制到当根 [low,high](candle_bounded_price),绝不让够不到的价进入盈亏。
 *  - 入场时效(8794 status.rs tiered_expiry_hours):≤1h 周期 24h、≥4h 周期 72h、其余 48h。
 */
import type { OrderBar, Side } from './types.js';
export interface Fill { price: number; gap: boolean }
export const clampToBar = (b: OrderBar, price: number) => Math.min(b.high, Math.max(b.low, price));
export function entryLimitFill(b: OrderBar, limit: number, side: Side): Fill | null {
  if (side === 'long') { if (b.open < limit) return { price: clampToBar(b, b.open), gap: true }; return b.low <= limit ? { price: clampToBar(b, limit), gap: false } : null; }
  if (b.open > limit) return { price: clampToBar(b, b.open), gap: true }; return b.high >= limit ? { price: clampToBar(b, limit), gap: false } : null;
}
export function stopFill(b: OrderBar, stop: number, side: Side): Fill | null {
  if (side === 'long') { if (b.open < stop) return { price: clampToBar(b, b.open), gap: true }; return b.low <= stop ? { price: clampToBar(b, stop), gap: false } : null; }
  if (b.open > stop) return { price: clampToBar(b, b.open), gap: true }; return b.high >= stop ? { price: clampToBar(b, stop), gap: false } : null;
}
export function takeProfitFill(b: OrderBar, target: number, side: Side): Fill | null {
  if (side === 'long') { if (b.open > target) return { price: clampToBar(b, b.open), gap: true }; return b.high >= target ? { price: clampToBar(b, target), gap: false } : null; }
  if (b.open < target) return { price: clampToBar(b, b.open), gap: true }; return b.low <= target ? { price: clampToBar(b, target), gap: false } : null;
}
/** 8794 分档时效换成根数:≤1h → 24h,≥4h → 72h,其余 48h;至少 1 根。 */
export function defaultExpiryBars(timeframe_ms: number): number {
  const hours = timeframe_ms <= 3600_000 ? 24 : timeframe_ms >= 4 * 3600_000 ? 72 : 48;
  return Math.max(1, Math.ceil(hours * 3600_000 / timeframe_ms));
}
/** 逐仓强平价:多 = 均价×(1−1/杠杆+mmr),空 = 均价×(1+1/杠杆−mmr)。资金费走现金不进保证金,因此不移动强平价。 */
export const liquidationPrice = (avg: number, leverage: number, mmr: number, side: Side) => side === 'long' ? avg * (1 - 1 / leverage + mmr) : avg * (1 + 1 / leverage - mmr);
export const toOrderBar = (b: { open_time: number; close_time: number; open: string | number; high: string | number; low: string | number; close: string | number; volume?: string | number }): OrderBar => ({ open_time: b.open_time, close_time: b.close_time, open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close), volume: Number(b.volume ?? 0) });
