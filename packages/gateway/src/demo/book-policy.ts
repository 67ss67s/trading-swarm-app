/** Book 的可回放决策：风险先于名义敞口，杠杆仅解决保证金占用。当前仅 shadow。 */
import { capacityDecimal as D } from './capacity-decimal.js';
import type { StrategyHorizon } from './horizon.js';
export interface BookInputs {
  equity: string; available: string; entry: string; stop: string; side: 'long' | 'short';
  risk_pct: string; remaining_stop_budget: string; remaining_notional: string;
  liquidity_cap: string; step_size: string; min_qty: string; min_notional: string;
  max_leverage: number; horizon: StrategyHorizon;
  regime: 'trend' | 'range' | 'transition' | 'stress' | 'unknown';
  strategy_health: 'healthy' | 'degraded' | 'unknown';
  round_trip_cost_bps: string; funding_budget_bps: string;
  observed_at: number; now: number;
}
export interface BookDecision {
  version: 'book-v1-shadow'; verdict: 'candidate' | 'reject'; reasons: string[];
  qty: string; notional: string; leverage: number; margin: string;
  risk_budget: string; loss_at_stop_with_costs: string; cost_bps: string;
}
export function evaluateBook(i: BookInputs): BookDecision {
  const out: BookDecision = { version:'book-v1-shadow', verdict:'reject', reasons:[], qty:'0', notional:'0', leverage:1, margin:'0', risk_budget:'0', loss_at_stop_with_costs:'0', cost_bps:'0' };
  const fail = (s:string) => {out.reasons.push(s);return out;};
  try {
    if (!Number.isSafeInteger(i.now) || !Number.isSafeInteger(i.observed_at) || i.observed_at>i.now || i.now-i.observed_at>180000) return fail('snapshot_stale');
    const fields = ['equity','available','entry','stop','risk_pct','remaining_stop_budget','remaining_notional','liquidity_cap','step_size','min_qty','min_notional','round_trip_cost_bps','funding_budget_bps'] as const;
    if (fields.some(k=>typeof i[k]!=='string'||!/^\d+(\.\d+)?$/.test(i[k]))) return fail('invalid_decimal');
    const z=D('0'), eq=D(i.equity), entry=D(i.entry), stop=D(i.stop), step=D(i.step_size);
    if ([eq,entry,stop,step].some(x=>x.cmp(z)<=0)||D(i.risk_pct).cmp(D('2'))>0||!Number.isInteger(i.max_leverage)||i.max_leverage<1||i.max_leverage>125) return fail('invalid_bounds');
    const riskUnit=i.side==='long'?entry.sub(stop):stop.sub(entry);
    if(riskUnit.cmp(z)<=0) return fail('stop_wrong_side');
    if(i.regime==='stress') return fail('stress_no_new_risk');
    const factors={trend:'1',range:'0.75',transition:'0.5',unknown:'0.25',stress:'0'};
    const health={healthy:'1',degraded:'0.5',unknown:'0.5'};
    if(!(i.regime in factors)||!(i.strategy_health in health)||!(['scalp','intraday','swing','position'] as string[]).includes(i.horizon))return fail('invalid_state');
    const budget=eq.mul(D(i.risk_pct)).div(D('100')).mul(D(factors[i.regime])).mul(D(health[i.strategy_health])).min(D(i.remaining_stop_budget));
    const costs=D(i.round_trip_cost_bps).add(D(i.funding_budget_bps));
    const unit=riskUnit.add(entry.max(stop).mul(costs).div(D('10000')));
    out.cost_bps=costs.text();out.risk_budget=budget.text();
    const cap=Math.min(i.max_leverage,{scalp:10,intraday:5,swing:3,position:2}[i.horizon]);
    const marginBudget=D(i.available).mul(D('0.5')).min(eq.mul(D('0.25')));
    const qtyLimit=budget.div(unit).min(D(i.remaining_notional).div(entry)).min(D(i.liquidity_cap).div(entry)).min(marginBudget.mul(D(cap)).div(entry));
    const units=qtyLimit.div(step);const qty=D((units.n/units.d).toString()).mul(step);
    const notional=qty.mul(entry);
    if(qty.cmp(z)<=0||qty.cmp(D(i.min_qty))<0||notional.cmp(D(i.min_notional))<0)return fail('minimum_lot_exceeds_budget');
    let leverage=1;
    while(leverage<cap&&notional.div(D(leverage)).cmp(marginBudget)>0)leverage++;
    const loss=qty.mul(unit), margin=notional.div(D(leverage));
    if(loss.cmp(budget)>0||margin.cmp(marginBudget)>0)return fail('rounding_budget_exceeded');
    Object.assign(out,{verdict:'candidate',qty:qty.text(),notional:notional.text(),leverage,margin:margin.text(),loss_at_stop_with_costs:loss.text()});
    out.reasons.push('risk_first','minimum_sufficient_leverage','shadow_not_execution');return out;
  }catch{return fail('invalid_input');}
}
