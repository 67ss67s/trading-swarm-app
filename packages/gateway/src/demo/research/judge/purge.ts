import type { StrategyIR } from '@trade-gate/contracts';
import { defaultExpiryBars } from '../orders/fills.js';
interface Window { from_ms:number; to_ms:number }
/** 标签成熟至少覆盖挂单等待 + 最大持仓 + 下根执行；无界策略必须另定边界协议。 */
export function requiredPurgeBars(ir: StrategyIR, timeframe_ms?: number): number | null {
  const bounds = ir.exit.filter(x=>x.primitive==='time_stop').map(x=>Number(x.params.bars));
  // orders/resolveOrder 中显式 order 上限覆盖 time_stop，不能取两者较小值。
  const finite = (ir.order?.max_holding_bars !== undefined ? [ir.order.max_holding_bars] : bounds).filter(n=>Number.isSafeInteger(n)&&n>0);
  if (!finite.length) return null;
  const expiry = ir.order?.entry?.type === 'limit' ? ir.order.entry.expiry_bars ?? (timeframe_ms ? defaultExpiryBars(timeframe_ms) : null) : 1;
  if (expiry === null) return null;
  return Math.min(...finite)+expiry+1;
}
export function assertPurge(ir: StrategyIR, purge_bars: number, timeframe_ms: number, windows: readonly Window[]): void {
  const need = requiredPurgeBars(ir,timeframe_ms);
  if (need === null) throw Error('unbounded_holding_requires_boundary_protocol');
  if (!Number.isSafeInteger(purge_bars) || purge_bars < need) throw Error(`purge_below_max_holding:${need}`);
  for (let i=1;i<windows.length;i++) if (windows[i]!.from_ms-windows[i-1]!.to_ms<=purge_bars*timeframe_ms) throw Error('purge_gap_required');
}
/** 显式隔离的开发视图：每次新变体实际执行前核对，不能只验证初始 manifest。
 * 旧连续窗口(没有空档且未封存留出)仍按 MTM 历史分析，不冒充隔离研究。
 */
export function assertSplitPurges(ir:StrategyIR,timeframe_ms:number,windows:readonly Window[],sealed_holdout=false):void {
  const ordered=windows.filter(w=>w.from_ms>=0&&w.to_ms>w.from_ms).sort((a,b)=>a.from_ms-b.from_ms);
  const gaps=ordered.slice(1).map((w,i)=>Math.floor((w.from_ms-ordered[i]!.to_ms)/timeframe_ms)-1);
  if(!sealed_holdout&&!gaps.some(g=>g>0))return;
  for(let i=1;i<ordered.length;i++)assertPurge(ir,gaps[i-1]!,timeframe_ms,[ordered[i-1]!,ordered[i]!]);
}
