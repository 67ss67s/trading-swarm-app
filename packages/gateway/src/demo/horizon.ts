/** 策略持有周期:复查节奏、证据与容忍度的共同来源;不改已批准的经济字段。 */
export type StrategyHorizon = 'scalp' | 'intraday' | 'swing' | 'position';
export const HORIZON_POLICY = {
  scalp: { timeframe: '5m', confirm: '1h', review_bars: 1, stop_atr: 0.8, entry_zone_atr: 0.5, invalidation_atr: 0.2 },
  intraday: { timeframe: '1h', confirm: '4h', review_bars: 1, stop_atr: 1, entry_zone_atr: 0.75, invalidation_atr: 0.3 },
  swing: { timeframe: '4h', confirm: '1d', review_bars: 1, stop_atr: 1.5, entry_zone_atr: 1, invalidation_atr: 0.5 },
  position: { timeframe: '1d', confirm: '1w', review_bars: 1, stop_atr: 2, entry_zone_atr: 1.5, invalidation_atr: 0.75 },
} as const;
export function inferHorizon(tf: string): StrategyHorizon {
  return tf === '1d' || tf === '1w' ? 'position' : tf === '4h' ? 'swing' : ['1m','3m','5m'].includes(tf) ? 'scalp' : 'intraday';
}
export function threadHorizon(t: { horizon?: StrategyHorizon; timeframe: string }): StrategyHorizon { return t.horizon ?? inferHorizon(t.timeframe); }
export function reviewTimeframe(t: { horizon?: StrategyHorizon; timeframe: string; holding_plan?: { thesis_timeframe: string } }): string {
  if (t.holding_plan) return t.holding_plan.thesis_timeframe;
  if (!t.horizon) return t.timeframe; // 无策略/手工线程沿用自己的周期,不被推断 horizon 改慢
  return threadHorizon(t) === 'scalp' ? t.timeframe : HORIZON_POLICY[threadHorizon(t)].timeframe;
}
export function reviewDue(t: { horizon?: StrategyHorizon; timeframe: string; created_at: number; opened_at: number | null }, now: number, last: number): boolean {
  const h = threadHorizon(t);
  if (h === 'scalp') return true;
  const ms = h === 'position' ? 86_400_000 : h === 'swing' ? 14_400_000 : 3_600_000;
  // 按完整周期收盘,不能拿入场前那根收盘立即复查。
  return Math.floor(now / ms) - Math.floor(Math.max(last, t.opened_at ?? t.created_at) / ms) >= HORIZON_POLICY[h].review_bars;
}
