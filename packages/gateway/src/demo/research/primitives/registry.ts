import { schemas, type ResearchBar, type ResearchScreenRow, type ResearchTrend, type ResearchPrimitiveDescription } from '@trading-swarm/contracts';
export interface PrimitiveContext {bars:ResearchBar[];i:number;timeframe_ms:number;screen?:ResearchScreenRow;position?:{entry_at:number;entry_price:number;initial_distance:number;bars_held:number;high_water?:number};fee_rate?:number;/** 订单周期执行核(orders/)专用:价位原语按方向取值;缺省 long,旧调用方行为不变 */side?:'long'|'short';/** 整段已收盘 K 线与当前根在其中的下标(2026-09-23 夜,多周期原语 htf_ma_state / macd_divergence{htf} 用):不受决策视图根数上限约束;只允许读 series[0..series_i]。缺省时这些原语退回 bars(决策视图),其余原语不读它 */series?:ResearchBar[];series_i?:number}
export interface PrimitiveValue {target?:number;structure?:ReturnType<typeof import('./structure.js').structure>;htf_structure?:import('@trading-swarm/contracts').ResearchStructure;sizing?:{allocation:'equal_risk'|'equal_notional';risk_fraction?:string;max_allocation:string;/** 波动率目标仓位(sizing/vol_target):执行核入场时按 w=min(1,目标/入场前实现年化波动) 缩放 */vol_target?:{target_vol:number;lookback_bars:number|null}};pass?:boolean;stop?:number;exit?:boolean;trend?:ResearchTrend;/** 价位原语(primitives/levels.ts):入场角色取的价(限价),stop/target 分别是止损/止盈角色的价 */level?:number}
export interface Primitive {name:string;category:ResearchPrimitiveDescription['category'];params:Record<string,unknown>;warmup_bars:(p:Record<string,unknown>,base?:number)=>number;/** 窗口前要借的已收盘历史根数(可超过 5000,只影响取数;缺省 0)。多周期原语从整段 series 计算,决策视图预热记 0,历史需求记这里 */history_bars?:(p:Record<string,unknown>,base?:number)=>number;lookahead:'none';describe:(p:Record<string,unknown>)=>string;compute:(ctx:PrimitiveContext,p:Record<string,unknown>)=>PrimitiveValue}
export const registry=new Map<string,Primitive>();
export function define(name:string,category:Primitive['category'],description:string,warmup:Primitive['warmup_bars'],compute:Primitive['compute'],history?:Primitive['history_bars']):Primitive {
  const params=(schemas.research.$defs as Record<string,unknown>)[`PrimitiveParams${name.split('_').map(x=>x[0]!.toUpperCase()+x.slice(1)).join('')}`] as Record<string,unknown>;
  const primitive:Primitive={name,category,params,warmup_bars:warmup,lookahead:'none',describe:p=>`${description}（${JSON.stringify(p)}）`,compute:(ctx,p)=>compute({...ctx,bars:ctx.bars.slice(0,ctx.i+1)},p),...(history?{history_bars:history}:{})};registry.set(name,primitive);return primitive;
}
export const n=(p:Record<string,unknown>,key:string)=>Number(p[key]);
export function atr(bars:ResearchBar[],period:number):number {
  if(bars.length<=period)return NaN;let sum=0;
  for(let i=bars.length-period;i<bars.length;i++){const b=bars[i]!,prev=Number(bars[i-1]!.close);sum+=Math.max(Number(b.high)-Number(b.low),Math.abs(Number(b.high)-prev),Math.abs(Number(b.low)-prev));}return sum/period;
}
export const last=(ctx:PrimitiveContext)=>Number(ctx.bars.at(-1)?.close);
