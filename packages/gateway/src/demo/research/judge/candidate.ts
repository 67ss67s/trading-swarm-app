import type { StrategyIR } from '@trade-gate/contracts';
import { hash } from '../primitives.js';
import type { PlanIntent } from '../orders/types.js';
import type { JudgeCandidateSnapshot } from './types.js';
const decimal = (n: number) => (typeof n === 'number' && Number.isFinite(n) ? n : 0).toFixed(12).replace(/\.?0+$/, '') || '0';
/** 身份与数据库 strategy_id 无关，回测/运行器同一几何生成同一候选 ID。 */
export function candidateSnapshot(ir: StrategyIR, x: Omit<JudgeCandidateSnapshot,'id'>): JudgeCandidateSnapshot {
  const { judge: _judge, version: _version, label: _label, description: _description, ...code } = ir;
  return { id: hash({code,...x}), ...x };
}
export function intentSnapshot(ir: StrategyIR, intent: PlanIntent, symbol: string, as_of: number, timeframe_ms: number): JudgeCandidateSnapshot {
  const entry = intent.entry.type === 'limit' ? intent.entry.price! : intent.reference_price, stop = intent.stop?.price ?? 0, dir = intent.side === 'long' ? 1 : -1;
  const targets = intent.take_profits.filter(t => Number.isFinite(t.price) && (t.price-entry)*dir>0).sort((a,b)=>(a.price-b.price)*dir);
  const weight = targets.reduce((s,t)=>s+Math.max(0,t.size_pct),0);
  const rr = targets.length && entry !== stop ? targets.reduce((s,t)=>s+Math.abs(t.price-entry)*(weight>0?Math.max(0,t.size_pct)/weight:1/targets.length),0)/Math.abs(entry-stop) : null;
  return candidateSnapshot(ir,{symbol,as_of,timeframe_ms,direction:intent.side,entry:decimal(entry),stop:decimal(stop),target:targets[0]?decimal(targets[0].price):null,reward_risk:rr});
}
export { decimal as judgeDecimal };
