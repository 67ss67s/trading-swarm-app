import type {ResearchExecution,OrderGateParams,ResearchEntry,StrategyIR} from '@trading-swarm/contracts';
import {evaluateOrderGate,fitOrderGate,riskCapApplies} from './order-gate.js';
import {q,mul,div,min,decimal,SCALE} from './primitives.js';
/** Fixed-R targets are always re-anchored to the placed stop: a strategy_ir with fixed_r_target, or a legacy policy's take_profit_r. */
export function fixedTargetR(ir:StrategyIR|undefined|null,policy:{take_profit_r:number}|undefined):number|undefined{
 if(ir&&!ir.compatibility){const rs=ir.exit.filter(x=>x.primitive==='fixed_r_target').map(x=>Number(x.params.r)).filter(Number.isFinite);return rs.length?Math.min(...rs):undefined;}
 return policy?.take_profit_r;
}
/** Place stop/target under the gate's constraints at the visible close; the ledger re-fits at the actual next-open fill. */
export function fitCandidate(entry:ResearchEntry,price:string,execution:ResearchExecution,params:OrderGateParams,fixed_r?:number):ResearchEntry{
 // Idempotent: an already-fitted entry is re-placed from the strategy's original levels, never from the placed ones.
 const target_r=entry.target_r??fixed_r,stop=entry.fit?.strategy_stop??entry.stop,target=entry.fit?entry.fit.strategy_target:entry.target;
 const f=fitOrderGate({side:'long',entry:price,stop,target,target_r,costs:execution,params});
 return {...entry,...(target_r!==undefined?{target_r}:{}),stop:f.stop,target:f.target,fit:f.fit};
}
/** Estimate at the visible close; the ledger repeats the gate at the actual next-open fill.
 * atr = 决策时刻 ATR(14);结构口径下据此判「止损太近不做」(stop_too_close),只在决策时刻判,成交时刻不重判(与几何实验室止血规则同口径)。 */
export function candidateGate(entry:ResearchEntry,price:string,cash:string,equity:string,execution:ResearchExecution,params:OrderGateParams,portfolio=false,atr?:number|null){
 const p=q(price),stop=q(entry.stop),eq=q(equity),available=q(cash),unit=execution.sizing_mode==='unit_notional',cap=unit?eq/BigInt(portfolio?(execution.max_positions??3):1):mul(eq,q(execution.max_allocation))/BigInt(portfolio&&execution.allocation==='equal_notional'?(execution.max_positions??3):1);
 const budget=mul(eq,q(execution.risk_fraction));
 let qty=p>stop?min(unit||execution.allocation==='equal_notional'?div(cap,p):div(budget,p-stop),div(cap,p),div(available,mul(p,SCALE+q(execution.fee_rate)))):0n;
 const step=q(execution.qty_step);qty=qty/step*step;
 return evaluateOrderGate({side:'long',entry:price,stop:entry.stop,target:entry.target,costs:execution,equity,qty:riskCapApplies(params,execution.sizing_mode)?decimal(qty):null,params,...(atr!==undefined?{atr}:{})});
}
