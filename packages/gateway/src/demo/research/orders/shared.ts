/** 从订单执行核提取的纯算式/分支；运行器与回测共用，保持回测运算顺序。 */
import type { NewSignalPolicy, Side } from './types.js';
export const firstLegMargin = (equity: number, fraction: number, max_adds: number, weight?: number): number =>
  weight === undefined ? Math.max(0, equity) * fraction / (1 + max_adds) : Math.max(0, equity) * fraction * weight / (1 + max_adds);
export function fundedLeg(base_margin: number, cash: number, leverage: number, fee_rate: number, price: number): { margin: number; qty: number } {
  const margin = Math.min(base_margin, cash / (1 + leverage * fee_rate));
  return { margin, qty: margin * leverage / price };
}
export function tighterStop(side: Side, current: number | null, next: number): boolean {
  return Number.isFinite(next) && next > 0 && (current === null || (next - current) * (side === 'long' ? 1 : -1) > 1e-12);
}
/** 反向信号优先于 filled=ignore/add/roll；现货空头由调用方在此前拒绝。 */
export function newSignalAction(policy: NewSignalPolicy, side: Side, next: Side, filled: boolean, adds: number, max_adds: number): 'replace' | 'flip' | 'roll' | 'add' | 'ignore' {
  if (!filled) return side === next && policy.unfilled === 'keep' ? 'ignore' : 'replace';
  if (side !== next) return 'flip';
  if (policy.filled === 'roll') return 'roll';
  return policy.filled === 'add' && adds < max_adds ? 'add' : 'ignore';
}
