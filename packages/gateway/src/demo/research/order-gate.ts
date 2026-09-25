/** 实盘接入点：gates.ts 的提案校验处调用同一函数，参数来自 workflow；本轮未接。
 * Pure decimal boundary: no research state, I/O, models, or exchange dependencies.
 *
 * 两套口径,由冻结在请求里的 order_gate 决定(旧 manifest 重放逐字不变):
 *
 * 结构口径(2026-09-23 起新 run 的缺省,order_gate.min_stop_atr 非 null 即启用)。Jacky 原话:「不要强制盈亏比,而是根据前高这种
 * 去判断顶和底给出 reasonable 的止盈点位和止损点位」;与几何实验室(docs/research/geometry-lab-2026-09-23.md)的生产规则一致:
 *  - 止损离入场不到 min_stop_atr×ATR(14)(缺省 0.5)的单子直接不做(stop_too_close),不把止损挪远(挪远会让止损率翻倍);
 *  - 盈亏比用真正会让单子死的那条线(初始止损)计算并展示,不拦单;只有 IR 的 order.min_rr(用户原话硬约束)才是门槛;
 *  - 止盈必须是图上有的价位(前高/摆动高点/结构阻力/用户指定的指标线),不按 R 倍数倒推补止盈;图上没有就不设,交给追踪止损;
 *  - 成本下限只作展示(stop_floor=none):不放宽、不拦。
 *
 * 旧口径(LEGACY_ORDER_GATE,2026-09-21 ~ 09-23 的 run):fitOrderGate 先按约束把止损/止盈放到位,evaluateOrderGate 再判定——
 *  - 止损不得窄于成本下限 min_stop_cost_multiple×往返成本(stop_floor='widen' 放宽到下限;'block' 直接拦);
 *  - 止盈:策略给的结构目标;fixed_r 目标按放宽后的止损重算;没有目标时用 target_fallback_r×止损距离补,null 才判 no_target;
 *  - 结构目标离得太近(rr<min_rr)拦下。
 * 两套口径都默认不对 unit_notional 套单笔风险上限(risk_cap_sizing='risk_fraction_only')。
 */
import type { OrderGateParams } from '@trading-swarm/contracts';
export type { OrderGateParams } from '@trading-swarm/contracts';
export const LEGACY_ORDER_GATE:OrderGateParams={min_rr:1.5,min_stop_cost_multiple:8,max_risk_fraction:'0.02',require_target:true,stop_floor:'widen',target_fallback_r:2,risk_cap_sizing:'risk_fraction_only'};
/** 结构口径下「止损太近不做」的缺省倍数(ATR14);几何实验室止血规则同一阈值 */
export const MIN_STOP_ATR_DEFAULT=0.5;
/** 新 run 的缺省:结构口径。min_stop_cost_multiple=0 → 成本下限为 0(只展示往返成本);min_rr=0 且不要求止盈 → 盈亏比不拦单。 */
export const DEFAULT_ORDER_GATE:OrderGateParams={min_rr:0,min_stop_cost_multiple:0,max_risk_fraction:'0.02',require_target:false,stop_floor:'none',target_fallback_r:null,risk_cap_sizing:'risk_fraction_only',min_stop_atr:MIN_STOP_ATR_DEFAULT};
/** 冻结的 order_gate 是否是结构口径(有 min_stop_atr)。旧 manifest 没有这个字段 → 旧口径。 */
export const isStructureGate=(p:OrderGateParams|null|undefined):p is OrderGateParams&{min_stop_atr:number}=>!!p&&typeof p.min_stop_atr==='number'&&Number.isFinite(p.min_stop_atr);
/** 止损离参考价(市价=信号收盘,限价=挂单价)是否不到 k×ATR;atr 缺失/非正时不判(预热不足不当成太近)。 */
export const stopTooClose=(ref:number,stop:number,atr:number|null|undefined,k:number)=>typeof atr==='number'&&Number.isFinite(atr)&&atr>0&&Math.abs(ref-stop)<k*atr-1e-12;
export type GateBlock='min_rr'|'stop_too_tight'|'stop_too_close'|'no_target'|'risk_cap'|'stop_side';
const decimal=(s:string)=>{if(!/^(0|[1-9]\d*)(\.\d{1,8})?$/.test(s))throw Error('order_gate_invalid_decimal');const [a,b='']=s.split('.');return BigInt(a!)*100000000n+BigInt(b.padEnd(8,'0'));};
const fmt=(n:bigint)=>{const s=(n<0n?-n:n).toString().padStart(9,'0');return `${n<0n?'-':''}${s.slice(0,-8)}.${s.slice(-8)}`;};
export const roundTripCostPct=(costs:{fee_rate:string;slippage_bps:string})=>2*Number(decimal(costs.fee_rate))/1e8+2*Number(decimal(costs.slippage_bps))/1e12;
export const stopFloorPct=(costs:{fee_rate:string;slippage_bps:string},p:OrderGateParams)=>p.min_stop_cost_multiple*roundTripCostPct(costs);
/** atr:决策时刻的 ATR(14,Wilder);只有结构口径(params.min_stop_atr)且给了 atr 才判 stop_too_close——成交时刻(ledger)不再判。 */
export function evaluateOrderGate(input:{side:'long'|'short';entry:string;stop:string;target:string|null;costs:{fee_rate:string;slippage_bps:string};equity:string;qty:string|null;params:OrderGateParams;atr?:number|null}) {
 const {params:p}=input,e=decimal(input.entry),s=decimal(input.stop),t=input.target===null?null:decimal(input.target),fee=decimal(input.costs.fee_rate),slip=decimal(input.costs.slippage_bps),equity=decimal(input.equity),risk=decimal(p.max_risk_fraction);
 if(e<=0n||equity<=0n||risk>100000000n||!Number.isFinite(p.min_rr)||p.min_rr<0||!Number.isFinite(p.min_stop_cost_multiple)||p.min_stop_cost_multiple<0)throw Error('order_gate_invalid_input');
 const abs=(n:bigint)=>n<0n?-n:n,d=abs(e-s),td=t===null?null:abs(t-e),stop_pct=Number(d)/Number(e),target_pct=td===null?null:Number(td)/Number(e),round_trip_cost_pct=2*Number(fee)/1e8+2*Number(slip)/1e12,rr=d===0n||td===null?null:Number(td)/Number(d),stop_over_cost=round_trip_cost_pct===0?Number.MAX_VALUE:stop_pct/round_trip_cost_pct;
 const blocked_by:GateBlock[]=[],reasons:string[]=[];const block=(name:GateBlock,note:string)=>{blocked_by.push(name);reasons.push(note);};
 if(s<=0n||(input.side==='long'?s>=e:s<=e)||(t!==null&&(input.side==='long'?t<=e:t>=e)))block('stop_side','止损/止盈方向错误');
 if(t===null&&p.require_target)block('no_target','必须提供独立止盈来源');
 if(t!==null&&(rr===null||rr<p.min_rr))block('min_rr','盈亏比低于阈值');
 if((p.stop_floor??'widen')!=='none'&&stop_pct<p.min_stop_cost_multiple*round_trip_cost_pct)block('stop_too_tight','止损距离不足成本倍数');
 if(isStructureGate(p)&&s>0n&&stopTooClose(Number(e),Number(s),input.atr===undefined||input.atr===null?null:input.atr*1e8,p.min_stop_atr))block('stop_too_close',`止损离入场不到 ${p.min_stop_atr}×ATR(14),不做(不替策略把止损挪远)`);
 if(input.qty!==null&&decimal(input.qty)*d>equity*risk)block('risk_cap','初始风险超过权益上限');
 return {ok:blocked_by.length===0,rr,stop_pct,target_pct,round_trip_cost_pct,stop_over_cost,reasons,blocked_by};
}
export interface OrderFit {stop_source:'strategy'|'cost_floor';target_source:'strategy'|'fallback_r'|'none';strategy_stop:string;strategy_target:string|null;stop_pct:number;target_pct:number|null;rr:number|null;floor_pct:number}
/** Place stop/target under the constraints before judging. target_r (fixed-R strategies) is re-anchored to the placed stop. */
export function fitOrderGate(input:{side:'long'|'short';entry:string;stop:string;target:string|null;target_r?:number;costs:{fee_rate:string;slippage_bps:string};params:OrderGateParams}):{stop:string;target:string|null;fit:OrderFit} {
 const {params:p}=input,e=decimal(input.entry),long=input.side==='long';let s=decimal(input.stop);
 const floor_pct=stopFloorPct(input.costs,p),floorDist=BigInt(Math.ceil(floor_pct*Number(e)));
 const abs=(n:bigint)=>n<0n?-n:n;let stop_source:OrderFit['stop_source']='strategy';
 const validSide=s>0n&&(long?s<e:s>e);
 if(validSide&&(p.stop_floor??'widen')==='widen'&&abs(e-s)<floorDist){s=long?e-floorDist:e+floorDist;stop_source='cost_floor';}
 const d=abs(e-s);let t:bigint|null=null,target_source:OrderFit['target_source']='none';
 if(input.target_r!==undefined&&input.target_r>0){t=long?e+BigInt(Math.round(input.target_r*Number(d))):e-BigInt(Math.round(input.target_r*Number(d)));target_source='strategy';}
 else if(input.target!==null){t=decimal(input.target);target_source='strategy';}
 else if(p.target_fallback_r!=null&&p.target_fallback_r>0&&validSide){t=long?e+BigInt(Math.round(p.target_fallback_r*Number(d))):e-BigInt(Math.round(p.target_fallback_r*Number(d)));target_source='fallback_r';}
 const td=t===null?null:abs(t-e);
 return {stop:fmt(s),target:t===null?null:fmt(t),fit:{stop_source,target_source,strategy_stop:input.stop,strategy_target:input.target,stop_pct:Number(d)/Number(e),target_pct:td===null?null:Number(td)/Number(e),rr:td===null||d===0n?null:Number(td)/Number(d),floor_pct}};
}
/** unit_notional has sizing removed from the return metric, so the per-trade risk cap only applies to risk_fraction sizing (unless risk_cap_sizing='all'). */
export const riskCapApplies=(p:OrderGateParams,sizing_mode:string|undefined)=>(p.risk_cap_sizing??'risk_fraction_only')==='all'||(sizing_mode??'unit_notional')!=='unit_notional';
/**
 * 研究回测的放置/判定门槛跟着策略走。
 * 结构口径(base 有 min_stop_atr,新缺省):盈亏比不拦单;只有用户在 order.min_rr 里硬约束的盈亏比才是门槛,且这时必须有有效止盈
 * (require_target,算不出止盈就无法核对用户的约束,不下单)。不按 R 倍数补止盈。
 * 旧口径(LEGACY_ORDER_GATE,2026-09-23 结构改造前):策略自己有价位止盈来源(structure_target / fixed_r_target / order.take_profits)
 * 才要求止盈、才套最小盈亏比、才允许按 R 兜底补止盈;用户在 order.min_rr 里硬约束的盈亏比优先;「死叉离场」这类只有信号离场的
 * 策略不再被塞一个 2R 目标。
 */
export function orderGateFor(ir:import('@trading-swarm/contracts').StrategyIR|null|undefined,base:OrderGateParams=DEFAULT_ORDER_GATE):OrderGateParams{
 if(!ir)return base;
 const userRR=ir.order?.min_rr;
 if(isStructureGate(base))return userRR!==undefined&&userRR>0?{...base,min_rr:userRR,require_target:true}:{...base};
 const hasTarget=(ir.exit??[]).some(x=>x.primitive==='structure_target'||x.primitive==='fixed_r_target')||!!ir.order?.take_profits?.length;// 订单块没写 take_profits 时缺省止盈由 orders/ 执行核给,执行核接入全窗口回测前 v4 看不到它,不能当作「有止盈」(复审 09-23)
 if(hasTarget)return userRR!==undefined?{...base,min_rr:userRR}:base;
 return {...base,require_target:false,min_rr:0,target_fallback_r:0};
}
