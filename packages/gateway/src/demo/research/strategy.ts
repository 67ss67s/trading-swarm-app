import { validateJudge } from './judge/pure.js';
import {htfStructure} from './primitives/structure.js';
import {specText,checkIRSpec,hasSignalExit} from './strategy-spec.js';
import {atr} from './primitives/registry.js';
import {DEFAULT_ORDER_GATE,roundTripCostPct,stopFloorPct,isStructureGate,type OrderGateParams} from './order-gate.js';
import {atrSeries} from './primitives/indicators.js';
import type {ResearchDataset} from '@trading-swarm/contracts';
import { schemas,validate,type StrategyIR,type ResearchPolicy,type ResearchRequest,type ResearchExecution,type StrategyCompileResult,type StrategyPrimitive } from '@trading-swarm/contracts';
import type { Brain } from '../brain.js';
import { extractJson } from '../schema.js';
import { registry,listPrimitives } from './primitives/index.js';
import { hash,clone,q } from './primitives.js';
import type { PrimitiveContext } from './primitives/registry.js';
import type { Entry,Position } from './ledger.js';
export const node=(primitive:string,params:Record<string,unknown>,optional=false):StrategyPrimitive=>({primitive,params,...(optional?{optional:true}:{})});
export function policyToIR(p:ResearchPolicy,e?:ResearchExecution):StrategyIR {
 return {version:1,label:p.label,description:p.description,compatibility:'donchian_close_long_v1',signal:[node('donchian_breakout',{lookback:p.lookback,basis:'close'}),node('volume_surge',{lookback:p.lookback,multiple:p.volume_multiple})],entry:node('next_open_market',{}),risk:{stop:node('atr_stop',{atr_period:p.atr_period,multiple:p.stop_atr}),sizing:node('risk_fraction',{fraction:e?.risk_fraction??'0.01',max_allocation:e?.max_allocation??'0.25'})},exit:[node('fixed_r_target',{r:p.take_profit_r},true),node('time_stop',{bars:p.holding_bars},true)]};
}
export function irToPolicy(ir:StrategyIR):ResearchPolicy {
 if(ir.compatibility!=='donchian_close_long_v1')throw new Error('not_legacy_ir');
 const signal=ir.signal.find(x=>x.primitive==='donchian_breakout'),volume=ir.signal.find(x=>x.primitive==='volume_surge'),time=ir.exit.find(x=>x.primitive==='time_stop'),target=ir.exit.find(x=>x.primitive==='fixed_r_target');
 const p:ResearchPolicy={label:ir.label,description:ir.description,interpretation:'donchian_close_long_v1',lookback:Number(signal?.params.lookback),volume_multiple:Number(volume?.params.multiple),atr_period:Number(ir.risk.stop.params.atr_period),stop_atr:Number(ir.risk.stop.params.multiple),take_profit_r:Number(target?.params.r),holding_bars:Number(time?.params.bars)};
 if(!validate('research',p).ok)throw new Error('invalid_legacy_mapping');
 const canonical=policyToIR(p);canonical.risk.sizing=clone(ir.risk.sizing);if(hash(canonical)!==hash(ir))throw new Error('legacy_mapping_not_lossless');return p;
}
export function defaultIR():StrategyIR {return {version:1,label:'顺势突破',description:'收盘突破且放量，在上升趋势入场，以 ATR 跟踪和趋势转弱退出。',signal:[node('donchian_breakout',{lookback:20,basis:'close'}),node('volume_surge',{lookback:20,multiple:1.2})],entry:node('next_open_market',{}),risk:{stop:node('atr_stop',{atr_period:14,multiple:2}),sizing:node('risk_fraction',{fraction:'0.01',max_allocation:'0.25'})},exit:[node('chandelier_trail',{atr_period:22,multiple:3}),node('trend_break',{ema_period:50,htf:'4h'}),node('structure_target',{htf:'1d',swing_length:3})],regime:node('trend_state',{adx_period:14,adx_min:20,ema_fast:20,ema_slow:50,htf:'4h'})};}
export function strategyNodes(ir:StrategyIR):{node:StrategyPrimitive;category:string}[]{return [...ir.signal.map(node=>({node,category:'signal'})),{node:ir.entry,category:'entry'},{node:ir.risk.stop,category:'stop'},{node:ir.risk.sizing,category:'sizing'},...ir.exit.map(node=>({node,category:'exit'})),...(ir.regime?[{node:ir.regime,category:'regime'}]:[])];}
/** 订单周期块(ir.order,WP-F)里的原语:限价来源、止盈来源、做空条件与做空方向门。不并入 strategyNodes,旧 IR 的检查与规则卡逐字不变。 */
export const ORDER_LEVEL_PRIMITIVES=['structure_level','indicator_level','atr_offset_level','pct_offset_level','smc_ob_level','smc_liquidity_target'];
export const ORDER_TP_PRIMITIVES=['structure_target','pivot_target','fixed_r_target',...ORDER_LEVEL_PRIMITIVES];
export function orderNodes(ir:StrategyIR):{node:StrategyPrimitive;category:string;role:'entry_price'|'take_profit'|'short_signal'|'short_regime'}[]{const o=ir.order;if(!o)return [];return [...(o.entry?.price?[{node:o.entry.price,category:'stop',role:'entry_price' as const}]:[]),...(o.take_profits??[]).map(t=>({node:t.source,category:registry.get(t.source.primitive)?.category??'exit',role:'take_profit' as const})),...(o.short_signal??[]).map(node=>({node,category:'signal',role:'short_signal' as const})),...(o.short_regime?[{node:o.short_regime,category:'regime',role:'short_regime' as const}]:[])];}
/** 订单块语义检查(只在 ir.order 存在时调用):现货禁空禁杠杆、双向必须有做空条件、限价必须有来源、止盈/限价来源只能是价位原语。 */
export function orderIssues(ir:StrategyIR):string[]{const o=ir.order;if(!o)return [];const out:string[]=[];
 if(o.market==='spot'&&o.direction!=='long')out.push('现货不能做空(direction 只能是 long;做空请用 market=perp)');
 if(o.market==='spot'&&o.leverage!==undefined&&o.leverage!==1)out.push('现货不能加杠杆(leverage 必须为 1)');
 if(o.direction==='both'&&!o.short_signal?.length)out.push('direction=both 必须提供 short_signal(做空条件)');
 if(o.direction!=='both'&&(o.short_signal||o.short_regime))out.push('short_signal/short_regime 只在 direction=both 时使用');
 if(o.entry?.type==='limit'&&!o.entry.price)out.push('限价入场必须给 entry.price(价位原语)');
 if(o.entry?.price&&!ORDER_LEVEL_PRIMITIVES.includes(o.entry.price.primitive))out.push(`entry.price 只能用价位原语 ${ORDER_LEVEL_PRIMITIVES.join('/')}`);
 for(const t of o.take_profits??[])if(!ORDER_TP_PRIMITIVES.includes(t.source.primitive))out.push(`止盈来源 ${t.source.primitive} 不是价位原语(可用 ${ORDER_TP_PRIMITIVES.join('/')})`);
 for(const x of orderNodes(ir))if(x.role==='short_signal'||x.role==='short_regime'){const c=registry.get(x.node.primitive)?.category;if(c!==x.category)out.push(`${x.role} 里的 ${x.node.primitive} 类别是 ${c??'未知'},应为 ${x.category}`);}
 return out;}
/** 订单块的一句话规则卡。 */
export function orderRuleText(ir:StrategyIR):string|null{const o=ir.order;if(!o)return null;const dir={long:'做多',short:'做空',both:'双向'}[o.direction],roll=o.on_new_signal?.filled??'roll';
 return `${o.market==='perp'?`永续${o.leverage&&o.leverage>1?` ${o.leverage} 倍`:''}`:'现货'} · ${dir} · ${o.entry?.type==='limit'?`限价(${o.entry.price?.primitive??'未指定'},${o.entry.expiry_bars??'按周期'} 根内有效)`:'市价'} · 止盈 ${(o.take_profits??[]).map(t=>`${t.source.primitive}${t.size_pct?` ${Math.round(t.size_pct*100)}%`:''}`).join(' / ')||'结构阻力(缺省)'} · ${o.min_rr!==undefined?`盈亏比 ≥ ${o.min_rr}`:'盈亏比按规范'} · 同向新信号:未成交${(o.on_new_signal?.unfilled??'replace')==='replace'?'替换':'保留'}、已成交${roll==='roll'?'结转':roll==='add'?'加仓':'忽略'}${o.max_holding_bars?` · 最长持有 ${o.max_holding_bars} 根`:''}${o.breakeven_after_tp?' · 首档止盈后保本':''}`;}
/** 可读规则卡:每个原语一句中文,给策略卡 / 规则卡用;JSON IR 只在「查看规则表示」里出现。 */
/** describe() 末尾带的原始 JSON 参数(`（{"lookback":10}）`)改成 `lookback 10 · basis close`;识别不了就原样保留。 */
function humanizeRule(text:string):string {return text.replace(/[（(](\{[^）)]*\})[）)]\s*$/,(m,json)=>{try{const p=JSON.parse(json) as Record<string,unknown>;const parts=Object.entries(p).map(([k,v])=>`${k} ${typeof v==='object'?JSON.stringify(v):String(v)}`);return parts.length?`（${parts.join(' · ')}）`:'';}catch{return m;}});}
export function rulesOf(ir:StrategyIR):NonNullable<StrategyCompileResult['rules']> {const rules:NonNullable<StrategyCompileResult['rules']>=strategyNodes(ir).map(({node,category})=>({category:category as 'signal'|'entry'|'stop'|'sizing'|'exit'|'regime',primitive:node.primitive,text:humanizeRule(registry.get(node.primitive)?.describe(node.params)??`未识别 ${node.primitive}`),...(node.optional?{optional:true}:{})}));
 const order=orderRuleText(ir);if(order){rules.push({category:'entry',primitive:'order',text:order});for(const x of orderNodes(ir))rules.push({category:(x.role==='take_profit'?'exit':x.role==='entry_price'?'entry':x.role==='short_signal'?'signal':'regime'),primitive:x.node.primitive,text:`${{entry_price:'限价来源',take_profit:'止盈来源',short_signal:'做空条件',short_regime:'做空方向门'}[x.role]}:${humanizeRule(registry.get(x.node.primitive)?.describe(x.node.params)??`未识别 ${x.node.primitive}`)}`});}
 return rules.slice(0,40);}
export function timeframeMillis(tf:string):number {const m=/^(\d+)(m|h|d)$/.exec(tf);if(!m)throw new Error('timeframe_invalid');return Number(m[1])*({m:60000,h:3600000,d:86400000}[m[2]!]!);}
function matches(value:unknown,s:Record<string,unknown>):boolean {
 if(s.enum&&!(s.enum as unknown[]).includes(value))return false;
 if(s.type==='object'){if(!value||typeof value!=='object'||Array.isArray(value))return false;const v=value as Record<string,unknown>,props=s.properties as Record<string,Record<string,unknown>>;return (s.required as string[]??[]).every(k=>k in v)&&Object.entries(v).every(([k,x])=>!!props[k]&&matches(x,props[k]!));}
 if(s.type==='array')return Array.isArray(value)&&value.length<=(s.maxItems as number??Infinity)&&value.every(x=>matches(x,s.items as Record<string,unknown>));
 if(s.type==='string')return typeof value==='string'&&(!s.pattern||new RegExp(String(s.pattern)).test(value));
 if(s.type==='number'||s.type==='integer')return typeof value==='number'&&Number.isFinite(value)&&(s.type!=='integer'||Number.isInteger(value))&&value>=(s.minimum as number??-Infinity)&&value<=(s.maximum as number??Infinity);
 return true;
}
export function checkIR(raw:unknown,timeframe:string):StrategyCompileResult {
 const result:StrategyCompileResult={ir:null,checks:[],ok:false,hash:null,summary:'策略未通过检查',unmapped:[]};
 const checked=validate('research',raw);if(!checked.ok||!raw||typeof raw!=='object'||!('version' in raw)||!('signal' in raw)){result.checks=[{name:'units',ok:false,message:'IR schema 不合格：'+(!checked.ok?checked.errors.join(';'):'expected_strategy_ir')}];return result;}
 const ir=raw as StrategyIR,nodes=strategyNodes(ir),allNodes=[...nodes,...orderNodes(ir)];result.ir=clone(ir);result.hash=hash(ir);
 const check=(name:string,ok:boolean,message:string)=>result.checks.push({name,ok,message});
 if(ir.judge){try{validateJudge(ir.judge);check('judge',!!ir.order,'judge 只支持完整订单执行核');}catch(e){check('judge',false,(e as Error).message);}}
 const validParams=allNodes.every(({node})=>{const p=registry.get(node.primitive);return !!p&&matches(node.params,p.params);});check('units',validParams,'参数类型、单位和目录定义必须一致，拒绝未知参数');
 let base=0;try{base=timeframeMillis(timeframe);}catch{}
 let timeOK=false;try{timeOK=base>0&&allNodes.every(({node})=>{const tf=node.params.htf;return !tf||(timeframeMillis(String(tf))>=base&&timeframeMillis(String(tf))%base===0);});}catch{}check('timeframe_consistency',timeOK,'高周期不得低于基础周期，且必须可整除');
 check('lookahead',allNodes.every(({node})=>registry.get(node.primitive)?.lookahead==='none'),'仅允许已登记、无前视原语');
 if(ir.order){const issues=orderIssues(ir);check('order_block',issues.length===0,issues.length?issues.join('；'):'订单周期块:方向/市场/杠杆/限价与止盈来源一致');}
 let legacy=false;if(ir.compatibility)try{irToPolicy(ir);legacy=true;}catch{}
 const tracked=ir.exit.some(x=>['chandelier_trail','swing_structure_stop','trend_break','breakeven_after_r'].includes(x.primitive));
 check('state_machine',nodes.every(({node,category})=>registry.get(node.primitive)?.category===category)&&(legacy||tracked||hasSignalExit(ir.exit)||!!ir.order?.take_profits?.length)&&(!ir.compatibility||legacy)&&ir.exit.every(x=>!['time_stop','fixed_r_target'].includes(x.primitive)||x.optional===true),'entry→stop/exit；新策略至少一个走势跟踪出场、用户指定的信号离场或订单块止盈，固定目标/时间必须 optional；legacy 必须无损映射');
 let riskOK=false;try{const p=ir.risk.sizing.params;if(ir.risk.sizing.primitive==='vol_target')riskOK=validParams&&Number(p.target_vol)>0&&!ir.universe?.screen;else{const fraction=String(p.fraction??'0.01'),allocation=String(p.max_allocation);riskOK=q(fraction)>0n&&q(fraction)<=q('0.1')&&q(allocation)>0n&&q(allocation)<=q('1');}}catch{}
 // 2026-09-23 结构口径:止盈是图上有就设、没有就交给追踪止损,所以「止损 + 追踪出场」也是完整的出场周期
 check('order_gate_ready',!!registry.get(ir.risk.stop.primitive)&&(ir.exit.some(x=>['fixed_r_target','structure_target','pivot_target'].includes(x.primitive))||!!ir.order?.take_profits?.length||hasSignalExit(ir.exit)||tracked),'必须声明止损,以及图上止盈来源、追踪止损或用户明确的信号离场之一');
 check('risk_bounds',riskOK,ir.risk.sizing?.primitive==='vol_target'?'vol_target:target_vol 在 (0,5],lookback_bars 为 5–4000 的整数;资产池筛选(universe.screen)策略暂不支持波动率目标仓位':'risk_fraction 必须在 (0,0.1]，max_allocation 在 (0,1]');
 // 通用指标原语的快慢周期约束落在 params.args/compare_args 里(macd/kama/ao/chaikin/uo 的 fast 必须小于 slow)
 const argsOrdered=(v:unknown)=>{const a=(v&&typeof v==='object'?v:{}) as Record<string,unknown>;return !(Number.isFinite(Number(a.fast))&&Number.isFinite(Number(a.slow)))||Number(a.fast)<Number(a.slow);};
 const GENERIC=['indicator_cross','indicator_cross_exit','indicator_threshold','indicator_threshold_exit','indicator_divergence','indicator_divergence_exit'];
 const ordered=nodes.every(({node})=>['ema_cross','macd_cross','macd_divergence','macd_divergence_exit'].includes(node.primitive)?Number(node.params.fast)<Number(node.params.slow):GENERIC.includes(node.primitive)?argsOrdered(node.params.args)&&argsOrdered(node.params.compare_args):node.primitive==='trend_state'?Number(node.params.ema_fast)<Number(node.params.ema_slow):node.primitive==='trend_break'?Number(node.params.ema_period)>=5:true);
 let warmup=Infinity;try{if(validParams&&timeOK&&ordered)warmup=Math.max(...allNodes.map(({node})=>registry.get(node.primitive)!.warmup_bars(node.params,base)));}catch{}
 check('warmup',Number.isFinite(warmup)&&warmup<=5000,`需要 ${warmup} 根预热；窗口上限 5000，快周期必须小于慢周期`);
 result.ok=result.checks.every(c=>c.ok);result.summary=nodes.map(({node})=>registry.get(node.primitive)?.describe(node.params)??`未识别 ${node.primitive}`).join('；');return result;
}
/** Concrete numbers the strategy author (human or model) must design the stop/target against: cost, stop floor, min RR, and the
 * dataset's ATR scale so "2 ATR" can be checked against the floor before anything is run.
 * 结构口径(gate.min_stop_atr):成本只展示;min_atr_multiple = min_stop_atr(止损至少离入场几倍 ATR);stop_too_close_rate = 本策略原始止损
 * 离收盘不到 min_stop_atr×ATR(14,Wilder)的比例(这些信号会被判太近不做);stop_fit_rate(旧口径「会被放宽」)记 null。 */
export function compileConstraints(timeframe:string,dataset:ResearchDataset|null,execution?:Partial<ResearchExecution>,gate:OrderGateParams=DEFAULT_ORDER_GATE,ir?:StrategyIR|null):NonNullable<StrategyCompileResult['constraints']> {
 const costs={fee_rate:execution?.fee_rate??'0.001',slippage_bps:execution?.slippage_bps??'5'},cost=roundTripCostPct(costs),floor=stopFloorPct(costs,gate),structure=isStructureGate(gate);
 let atr_pct_median:number|null=null,strategy_stop_pct_median:number|null=null,stop_fit_rate:number|null=null,stop_too_close_rate:number|null=null;
 if(dataset&&dataset.bars.length>20){
  const pcts:number[]=[],stops:number[]=[];const step=Math.max(1,Math.floor(dataset.bars.length/400));let widened=0,close_=0;const wilder=structure?atrSeries(dataset.bars,14):null;
  for(let i=15;i<dataset.bars.length;i+=step){const bars=dataset.bars.slice(Math.max(0,i-4999),i+1),close=Number(bars.at(-1)!.close),a=atr(bars,14);if(Number.isFinite(a)&&close>0)pcts.push(a/close);
   if(ir?.risk?.stop){try{const stop=registry.get(ir.risk.stop.primitive)?.compute({bars,i:bars.length-1,timeframe_ms:dataset.timeframe_ms},ir.risk.stop.params).stop;if(stop&&Number.isFinite(stop)&&stop>0&&stop<close){const pct=(close-stop)/close;stops.push(pct);if(pct<floor)widened++;const w=wilder?.[i];if(structure&&w!==undefined&&Number.isFinite(w)&&w>0&&close-stop<gate.min_stop_atr!*w)close_++;}}catch{}}}
  const med=(x:number[])=>{const a=[...x].sort((a,b)=>a-b);return a.length?a[Math.floor(a.length/2)]!:null;};
  atr_pct_median=med(pcts);strategy_stop_pct_median=med(stops);stop_fit_rate=stops.length&&!structure?widened/stops.length:null;stop_too_close_rate=stops.length&&structure?close_/stops.length:null;
 }
 if(structure){
  const k=gate.min_stop_atr!;
  const note=`往返成本 ${(cost*100).toFixed(2)}%(只计入收益,不再把止损放宽到成本下限);止损离入场不到 ${k}×ATR(14) 的单子不做`+(atr_pct_median!==null?`;${dataset!.symbol} ${timeframe} ATR(14) 中位 ${(atr_pct_median*100).toFixed(2)}%,即止损至少约 ${(k*atr_pct_median*100).toFixed(2)}%`:'')+`;盈亏比只计算展示,不拦单(用户原话硬约束除外)`+(strategy_stop_pct_median!==null?`;本策略原始止损中位 ${(strategy_stop_pct_median*100).toFixed(2)}%,${Math.round((stop_too_close_rate??0)*100)}% 的信号会因止损太近不做`:'');
  return {symbol:dataset?.symbol??null,timeframe,round_trip_cost_pct:cost,stop_floor_pct:floor,min_rr:gate.min_rr,atr_pct_median,min_atr_multiple:k,strategy_stop_pct_median,stop_fit_rate,note,min_stop_atr:k,stop_too_close_rate};
 }
 const min_atr_multiple=atr_pct_median?floor/atr_pct_median:null;
 const note=`往返成本 ${(cost*100).toFixed(2)}%，止损下限 ${(floor*100).toFixed(2)}%（成本×${gate.min_stop_cost_multiple}），最小盈亏比 ${gate.min_rr}`+(atr_pct_median!==null?`；${dataset!.symbol} ${timeframe} ATR(14) 中位 ${(atr_pct_median*100).toFixed(2)}%，止损至少 ${min_atr_multiple!.toFixed(1)} ATR`:'')+(strategy_stop_pct_median!==null?`；本策略原始止损中位 ${(strategy_stop_pct_median*100).toFixed(2)}%，${Math.round((stop_fit_rate??0)*100)}% 会被放宽到下限`:'');
 return {symbol:dataset?.symbol??null,timeframe,round_trip_cost_pct:cost,stop_floor_pct:floor,min_rr:gate.min_rr,atr_pct_median,min_atr_multiple,strategy_stop_pct_median,stop_fit_rate,note};
}
/** 编译期确定性补全:只补规范要求但文本里没说的槽位,每条都记进 unmapped 让用户看见;不改用户明确给出的参数。 */
/** 状态型 indicator_cross(above/below)规整成「线 A 在线 B 之上」的标准形式:等价的去重,互相矛盾的只保留先出现的那条。
 * 2026-09-23 实测模型同时写了「EMA20 在收盘之下」和「EMA20 在收盘之上」,AND 永远不成立 → 0 笔。 */
export function normalizeStateSignals(signals:StrategyPrimitive[]):{signals:StrategyPrimitive[];dropped:string[]}{
 const line=(ind:unknown,args:unknown,out:unknown,priceKey?:unknown)=>ind==='price'?`price:${String(priceKey??'close')}`:`${String(ind)}:${JSON.stringify(args??{})}:${String(out??'')}`;
 const sides=(x:StrategyPrimitive)=>{const p=x.params;const a=line(p.indicator,p.args,p.output,'close');const to=String(p.compare_to??'price');const b=to==='constant'?`const:${Number(p.constant??0)}`:to==='indicator'?line(p.compare_indicator??p.indicator,p.compare_args,p.compare_output):`price:${String(p.compare_price??'close')}`;return {a,b};};
 const seen=new Map<string,string>(),out:StrategyPrimitive[]=[],dropped:string[]=[];
 for(const x of signals){
  const dir=String(x.params?.direction);
  if(x.primitive!=='indicator_cross'||!['above','below'].includes(dir)){out.push(x);continue;}
  const {a,b}=sides(x),[hi,lo]=dir==='above'?[a,b]:[b,a],key=[hi,lo].sort().join('|'),rel=`${hi}>${lo}`,prev=seen.get(key);
  if(prev===rel){dropped.push(`重复条件 ${rel}`);continue;}
  if(prev){dropped.push(`与先前条件矛盾的 ${rel}(保留 ${prev})`);continue;}
  seen.set(key,rel);out.push(x);
 }
 return {signals:out,dropped};
}
/** 结构口径(c.min_stop_atr,2026-09-23)下的缺省:止损 = pivot_stop(最近已确认摆动低点下方 0.1 ATR),止盈 = pivot_target(图上最近未被扫的摆动高点,
 * 没有就不设),持仓用吊灯线 ATR(22)×3 追踪(用户给了信号离场、说了不要追踪、或已有走势跟踪出场时不补);不再补固定 R 目标。
 * text = 用户原话(可选),只用来认「不要追踪止损」这类否定说法。 */
export const NO_TRAIL_TEXT=/不(要|用|设|加)?\s*(追踪|跟踪|移动)止损|不(要|用|加)?\s*(吊灯|追踪|trail)/i;
/** 止盈来源可能在某根算不出价位(图上没有结构)的原语:这类止盈缺位时要靠追踪止损管 */
const STRUCTURAL_TP=new Set(['structure_target','pivot_target','smc_liquidity_target','structure_level','smc_ob_level']);
export function repairIR(raw:unknown,c:NonNullable<StrategyCompileResult['constraints']>,text=''):{ir:unknown;notes:string[]} {
 const structure=typeof c.min_stop_atr==='number';
 const notes:string[]=[];if(!raw||typeof raw!=='object'||Array.isArray(raw))return {ir:raw,notes};
 const ir=clone(raw) as Partial<StrategyIR>&Record<string,unknown>;
 if(!Array.isArray(ir.exit))(ir as Record<string,unknown>).exit=[];if(!ir.risk||typeof ir.risk!=='object')ir.risk={} as StrategyIR['risk'];
 if(!ir.entry||typeof ir.entry!=='object'){ir.entry=node('next_open_market',{});notes.push('自动补全:未指定入场方式,按下一根 open 市价成交');}
 const order=ir.order&&typeof ir.order==='object'?ir.order as StrategyIR['order']&Record<string,unknown>:null;
 // 订单周期块(WP-F):缺省止损 = 支撑破位(高周期结构块下沿,做空时镜像为阻力上沿);限价没给来源 = 回踩下方支撑块上沿
 if(structure&&(!ir.risk.stop||typeof ir.risk.stop!=='object')){ir.risk.stop=node('pivot_stop',{swing_length:3});notes.push(`自动补全:未指定止损,按图上结构——最近已确认摆动低点下方 0.1 ATR(做空为上方摆动高点);离入场不到 ${c.min_stop_atr}×ATR 的信号不做`);}
 if(order&&(!ir.risk.stop||typeof ir.risk.stop!=='object')){ir.risk.stop=node('htf_structure',{htf:'1d',swing_length:3});notes.push('自动补全:订单块未指定止损,按支撑破位(1d 结构块下沿;做空时为阻力上沿)');}
 if(order&&order.entry&&typeof order.entry==='object'&&(order.entry as {type?:string}).type==='limit'&&!(order.entry as {price?:unknown}).price){(order.entry as {price?:StrategyPrimitive}).price=node('structure_level',{swing_length:3});notes.push('自动补全:限价入场未指定挂单价,按回踩最近支撑块上沿(做空为阻力块下沿)');}
 if(!ir.risk.stop||typeof ir.risk.stop!=='object'){const multiple=Math.max(2,Math.ceil((c.min_atr_multiple??0)*10)/10);ir.risk.stop=node('atr_stop',{atr_period:14,multiple});notes.push(`自动补全:未指定止损,按 ATR(14)×${multiple} 初始止损(占位,可在设置里改)`);}
 if(!ir.risk.sizing||typeof ir.risk.sizing!=='object'){ir.risk.sizing=node('equal_notional',{max_allocation:'1'});notes.push('自动补全:未指定仓位,按每笔 100% 可用资金(现货不加杠杆)');}
 const exits=ir.exit as StrategyPrimitive[];
 for(const x of exits)if(['fixed_r_target','time_stop'].includes(x.primitive)&&x.optional!==true){x.optional=true;notes.push(`自动补全:${x.primitive} 标为 optional(规范要求固定目标/时间出场只能是可选)`);}
 const minR=Math.max(2,c.min_rr);
 for(const x of exits)if(x.primitive==='fixed_r_target'&&Number(x.params.r)<c.min_rr){notes.push(`自动补全:固定 R 目标 ${x.params.r} 低于最小盈亏比 ${c.min_rr},提高到 ${minR}`);x.params.r=minR;}
 // 用户给了信号离场(死叉离场等)就是用户自己定的止盈方式:不再补固定 R 目标与吊灯追踪,否则回测的不是用户的策略(2026-09-23 实测 22 笔里 17 笔被补上的追踪止损打出)
 const userExit=hasSignalExit(exits);
 if(structure&&!userExit&&!ir.compatibility&&!exits.some(x=>['fixed_r_target','structure_target','pivot_target'].includes(x.primitive))&&!(ir.order as StrategyIR['order'])?.take_profits?.length){exits.push(node('pivot_target',{swing_length:3}));notes.push('自动补全:未指定止盈,按图上结构——入场上方最近的未被扫的摆动高点(1–6 ATR 内,做空镜像);图上没有就不设止盈,交给追踪止损(不按 R 倍数倒推)');}
 if(!structure&&!userExit&&!exits.some(x=>['fixed_r_target','structure_target'].includes(x.primitive))&&!(ir.order as StrategyIR['order'])?.take_profits?.length){exits.push(node('fixed_r_target',{r:minR},true));notes.push(`自动补全:未指定独立止盈来源,按固定 ${minR}R 目标(optional,规范最小盈亏比 ${c.min_rr});可改为 structure_target`);}
 {const o=ir.order as Record<string,unknown>|undefined;if(o&&typeof o==='object'&&Number(o.leverage)>MAX_RESEARCH_LEVERAGE){notes.push(`自动更正:杠杆 ${o.leverage} 倍超过研究回测上限,按 ${MAX_RESEARCH_LEVERAGE} 倍`);o.leverage=MAX_RESEARCH_LEVERAGE;}}
 if(Array.isArray(ir.signal)){const n=normalizeStateSignals(ir.signal as StrategyPrimitive[]);if(n.dropped.length){ir.signal=n.signals as StrategyIR['signal'];notes.push(`自动规整状态条件:去掉${n.dropped.join('、')}`);}}
 // 事件型信号(穿越/背离/突破)只在某一根成立,两个事件 AND 在同一根几乎不可能 → 零交易;只保留用户先说的那个做入场,其余如实记录(2026-09-22 真模型实测把 ema_cross 和 macd_divergence 硬 AND 得 0 笔)
 const EVENT_SIGNALS=['ema_cross','macd_cross','macd_divergence','donchian_breakout','structure_bos','smc_bos','smc_fvg_fill','indicator_cross','indicator_divergence','double_bottom','head_and_shoulders_inverse','bullish_engulfing','pin_bar','fair_value_gap','inside_bar_breakout'];
 if(Array.isArray(ir.signal)){const events=(ir.signal as StrategyPrimitive[]).filter(x=>EVENT_SIGNALS.includes(x.primitive)&&!(x.primitive==='indicator_cross'&&['above','below'].includes(String(x.params?.direction))));if(events.length>1){const keep=events[0]!;ir.signal=(ir.signal as StrategyPrimitive[]).filter(x=>!EVENT_SIGNALS.includes(x.primitive)||x===keep) as StrategyIR['signal'];notes.push(`自动拆分:${events.map(x=>x.primitive).join(' 与 ')} 都是单根事件信号,要求同根同时成立几乎必然零交易;本版只用 ${keep.primitive} 做入场,${events.slice(1).map(x=>x.primitive).join('、')} 未纳入(要单独验证请分开提问或在设置里改规则)`);}}
 // 订单块带止盈(用户说了「止盈看布林上轨」之类)时,止损 + 多档止盈就是完整出场周期,不再补追踪止损(忠于用户,2026-09-23 WP-F)
 const tps=((ir.order as StrategyIR['order'])?.take_profits??[]) as {source?:StrategyPrimitive}[],tracked=exits.some(x=>['chandelier_trail','swing_structure_stop','trend_break','breakeven_after_r'].includes(x.primitive));
 // 结构口径:用户给的止盈若是图上结构(前高/流动性/结构阻力),某些根会算不出价位(创新高、上方没有结构)→ 同样补追踪止损兜底;指标线止盈(布林上轨)总有价位,不补(忠于用户)
 if(structure&&!userExit&&!ir.compatibility&&tps.length&&tps.some(t=>STRUCTURAL_TP.has(String(t.source?.primitive)))&&!tracked&&!NO_TRAIL_TEXT.test(text)){exits.push(node('chandelier_trail',{atr_period:22,multiple:3}));notes.push('自动补全:止盈取图上结构,图上没有目标的那几单由吊灯线 ATR(22)×3 追踪止损管(原话说不要追踪就不补)');}
 if(!userExit&&!ir.compatibility&&!(ir.order as StrategyIR['order'])?.take_profits?.length&&!tracked&&!(structure&&NO_TRAIL_TEXT.test(text))){exits.push(node('chandelier_trail',{atr_period:22,multiple:3}));notes.push('自动补全:未指定走势跟踪出场,按吊灯线 ATR(22)×3 追踪止损');}
 return {ir,notes};
}
/** 原话 → 订单块的确定性规则(WP-F,2026-09-23)。只认五类说法,命中才改,每处改动写一条说明;没命中任何一条时不碰 IR(不带 order 块的旧行为不变)。
 *  「限价/挂单」(+「回踩 EMA20」「回踩支撑」)→ entry.type=limit + 价位原语;「盈亏比至少 N」→ min_rr;「止盈看布林上轨/下轨/中轨」→ take_profits;
 *  「止损跌破 EMA50 / MA50」→ risk.stop=indicator_level;「做空」→ direction=short + perp;「永续/合约」→ perp,「N 倍」→ leverage。
 *  做空、多空双向、杠杆这类方向/市场语义之外,都不改 signal / regime / exit。 */
/** 研究回测的杠杆上限 */
export const MAX_RESEARCH_LEVERAGE=20;
export function applyOrderPhrases(text:string,raw:unknown):string[]{
 const notes:string[]=[];if(!text||!raw||typeof raw!=='object'||Array.isArray(raw))return notes;
 const ir=raw as Record<string,unknown>&{order?:Record<string,unknown>;risk?:Record<string,unknown>},t=text.replace(/\s+/g,' ');
 const ma=(k:string)=>/^ema$/i.test(k)?'ema':'sma';
 const limit=/限价|挂单|挂在/.test(t),pull=/回踩\s*(EMA|SMA|MA)\s*(\d{1,4})/i.exec(t),pullSupport=/(回踩|挂在?).{0,6}支撑/.test(t);
 // SMC(2026-09-23):「回踩订单块限价」→ 限价挂订单块上沿;「止损放在订单块下沿」→ smc_ob_level;「止盈看流动性/前高/等高点/溢价区」→ smc_liquidity_target
 const obEntry=limit&&/(回踩|挂在?).{0,8}(订单块|\bOB\b)|(订单块|\bOB\b).{0,6}(限价|挂单)/i.test(t),obStop=/止损.{0,10}(订单块|\bOB\b)/i.test(t),liq=/止盈.{0,12}?(流动性|前高|等高|溢价区|弱高)/.exec(t);
 const rr=/盈亏比\s*(?:至少|不低于|不小于|大于等于|>=|≥|要?在)?\s*(\d+(?:\.\d+)?)/.exec(t);
 const tp=/止盈.{0,8}?布林(?:带|线)?\s*(上轨|下轨|中轨)/.exec(t);
 const sl=/止损.{0,8}?(?:跌破|破位?|站上|突破|收在)\s*(EMA|SMA|MA)\s*(\d{1,4})/i.exec(t);
 // 「多空/双向」(2026-09-23 晚):direction=both + 永续(缺省 1 倍);short_signal 由模型给,缺了 orderIssues 会把原因回喂模型。「多空力量」是指标别名,不算
 const both=/多空(?!力量)|双向|\blong[\s/&_-]*(?:and\s*)?short\b/i.test(t),short=!both&&/做空|开空|空单|\bshort\b/i.test(t),perp=/永续|合约|\bperp|swap\b/i.test(t)||short||both;
 const lev=/(?<!盈亏比[^,，。;]{0,6})(\d+(?:\.\d+)?)\s*(?:倍|x\b|X\b)(?!\s*(?:ATR|均量|成交量|量|标准差|布林|R\b))/i.exec(t)??/杠杆\s*(\d+(?:\.\d+)?)/.exec(t);
 if(!(limit||rr||tp||sl||short||both||perp||lev||obStop||liq))return notes;
 if(!ir.order||typeof ir.order!=='object'){ir.order={direction:'long',market:'spot'};notes.push('按原话建订单周期块');}
 const o=ir.order,set=(k:string,v:unknown,why:string)=>{if(JSON.stringify(o[k])!==JSON.stringify(v)){o[k]=v;notes.push(why);}};
 // 「回踩 MA N 限价买」= 处于上升趋势时在 MA N 挂限价:信号改成「价格在 MA N 之上」的状态,去掉与之矛盾的「下穿 MA N」事件;
 // 止损若是更长的 MA M,再要求 MA N 在 MA M 之上,否则止损会落在入场价上方(2026-09-23 实测模型把信号写成「价格下穿 EMA20」,限价挂在价格上方、开盘即成交,46 个计划止损在错误一侧)
 if(limit&&pull&&!short){const k=ma(pull[1]!),n0=Number(pull[2]),same=(x:StrategyPrimitive)=>x.primitive==='indicator_cross'&&String(x.params.direction)==='cross_below'&&((x.params.compare_indicator===k&&Number((x.params.compare_args as {period?:unknown}|undefined)?.period)===n0)||(x.params.indicator===k&&Number((x.params.args as {period?:unknown}|undefined)?.period)===n0));
  const sig=(Array.isArray(ir.signal)?ir.signal:[]) as StrategyPrimitive[],kept=sig.filter(x=>!same(x)),above=node('indicator_cross',{indicator:'price',compare_to:'indicator',compare_indicator:k,compare_args:{period:n0},direction:'above'});
  const conds=[above,...(sl&&Number(sl[2])>n0?[node('indicator_cross',{indicator:ma(sl[1]!),args:{period:n0},compare_to:'indicator',compare_indicator:ma(sl[1]!),compare_args:{period:Number(sl[2])},direction:'above'})]:[])];
  const has=(c:StrategyPrimitive)=>kept.some(x=>JSON.stringify(x)===JSON.stringify(c));
  const next=[...conds.filter(c=>!has(c)),...kept];
  // 状态信号在趋势里每根都成立:未成交时每根按最新均线价重挂(replace),已成交后不再结转/加仓(ignore),否则每根都会 roll 一次
  if(!ir.order||typeof ir.order!=='object')ir.order={direction:'long',market:'spot'};const on=(ir.order as Record<string,unknown>).on_new_signal as Record<string,unknown>|undefined;if(!on||on.filled==='roll'){(ir.order as Record<string,unknown>).on_new_signal={unfilled:'replace',filled:'ignore'};notes.push('回踩挂单用状态信号:未成交按最新均线价重挂,已成交后忽略后续信号(不结转)');}
  if(JSON.stringify(next)!==JSON.stringify(sig)){ir.signal=next;notes.push(`原话「${pull[0]}」→ 入场条件改为「价格在 ${k.toUpperCase()}${n0} 之上${conds.length>1?`且 ${k.toUpperCase()}${n0} 在 ${ma(sl![1]!).toUpperCase()}${sl![2]} 之上`:''}」时在 ${k.toUpperCase()}${n0} 挂限价(回踩语义),去掉与之矛盾的穿越事件`);}}
 if(limit){const entry=(o.entry&&typeof o.entry==='object'?o.entry:{}) as Record<string,unknown>,obNode=(x:unknown)=>(x&&typeof x==='object'&&(x as StrategyPrimitive).primitive==='smc_ob_level'?x as StrategyPrimitive:null),price=pull?node('indicator_level',{indicator:ma(pull[1]!),args:{period:Number(pull[2])}}):obEntry?obNode(entry.price)??node('smc_ob_level',{}):pullSupport||!entry.price?node('structure_level',{swing_length:3}):entry.price;
  set('entry',{...entry,type:'limit',price},`原话「${pull?.[0]??(pullSupport?'回踩支撑':'限价')}」→ 限价入场,挂单价 ${(price as StrategyPrimitive).primitive}`);}
 if(obStop){if(!ir.risk||typeof ir.risk!=='object')ir.risk={};const ep=(o.entry as {price?:StrategyPrimitive}|undefined)?.price,cur=ir.risk.stop as StrategyPrimitive|undefined;if(cur?.primitive!=='smc_ob_level'){ir.risk.stop=ep?.primitive==='smc_ob_level'?node('smc_ob_level',{...ep.params}):node('smc_ob_level',{});notes.push('原话「止损…订单块」→ 止损 = 订单块下沿(smc_ob_level,空单为上沿)');}}
 if(liq){const src=liq[1]==='等高'?'equal':liq[1]==='溢价区'?'premium':'liquidity',tps=o.take_profits as {source?:StrategyPrimitive}[]|undefined;if(!tps?.some(x=>x.source?.primitive==='smc_liquidity_target'))set('take_profits',[{source:node('smc_liquidity_target',src==='liquidity'?{}:{source:src})}],`原话「${liq[0]}」→ 止盈 = SMC 流动性(${src==='equal'?'等高点':src==='premium'?'溢价区':'上方最近未被扫的摆动高点/等高点/区间顶'})`);}
 if(rr)set('min_rr',Number(rr[1]),`原话「${rr[0]}」→ 最小盈亏比 ${rr[1]}(放置时达不到不下单)`);
 if(tp){const output={上轨:'upper',下轨:'lower',中轨:'middle'}[tp[1] as '上轨'|'下轨'|'中轨'];set('take_profits',[{source:node('indicator_level',{indicator:'bbands',output})}],`原话「${tp[0]}」→ 止盈 = 布林${tp[1]}`);}
 if(sl){if(!ir.risk||typeof ir.risk!=='object')ir.risk={};const stop=node('indicator_level',{indicator:ma(sl[1]!),args:{period:Number(sl[2])}});if(JSON.stringify(ir.risk.stop)!==JSON.stringify(stop)){ir.risk.stop=stop;notes.push(`原话「${sl[0]}」→ 止损 = ${ma(sl[1]!).toUpperCase()}${sl[2]} 指标线`);}}
 if(short)set('direction','short','原话要做空 → direction=short');
 if(both)set('direction','both','原话要多空双向 → direction=both(signal=做多条件,short_signal=做空条件)');
 if(perp)set('market','perp',(short||both)&&!/永续|合约|perp|swap/i.test(t)?`${both?'多空双向':'做空'}只能在永续上做 → market=perp`:'原话要永续 → market=perp');
 // 杠杆上限 20 倍(2026-09-23 Jacky 认可):研究回测不模拟 20 倍以上(强平与分档误差太大);超过就钳到 20 并写明。永续不是默认市场,只有原话提到永续/合约/做空/杠杆才走永续
 if(lev&&(perp||o.market==='perp')){const want=Math.max(1,Number(lev[1])),x=Math.min(MAX_RESEARCH_LEVERAGE,want);set('leverage',x,want>x?`原话「${lev[0]}」超过研究回测上限,按 ${x} 倍`:`原话「${lev[0]}」→ 杠杆 ${x} 倍`);}
 if(o.market==='spot'&&o.direction!=='long'){o.market='perp';notes.push('做空只能在永续上做 → market=perp');}
 return notes;
}
/** 「波动率目标 / 按波动调仓位 / vol target」这类原话(2026-09-23 晚)。 */
export const VOL_TARGET_TEXT=/波动率?\s*目标|目标\s*(?:年化)?\s*波动率?|按\s*波动率?\s*(?:调整?|缩放|定|分配|控制)?\s*仓位|仓位\s*按\s*波动率?|vol(?:atility)?[\s_-]*target/i;
/** 原话里的目标值:「波动率目标 30%」「年化波动 40%」「vol target 0.6」;没给数返回 null(调用方用缺省 50%,与批量层同)。 */
export function volTargetValue(t:string):number|null{
  const m=/(?:波动率?\s*目标|目标\s*(?:年化)?\s*波动率?|年化\s*波动率?|vol(?:atility)?[\s_-]*target)\s*(?:为|是|设为|设成|=|:|:)?\s*(\d+(?:\.\d+)?)\s*(%|%)?/i.exec(t);if(!m)return null;
  const v=Number(m[1])/(m[2]||Number(m[1])>5?100:1);return v>=0.05&&v<=5?Math.round(v*10000)/10000:null;}
/** 仓位原话 → risk.sizing 的确定性规则:原话要波动率目标 → vol_target{target_vol};原话没提而模型写了 vol_target → 退回缺省 equal_notional(忠于原话,用户没说就不加)。每处改动写一条说明。 */
export function applySizingPhrases(text:string,raw:unknown):string[]{
  const notes:string[]=[];if(!raw||typeof raw!=='object'||Array.isArray(raw))return notes;
  const ir=raw as {risk?:Record<string,unknown>},t=(text??'').replace(/\s+/g,' '),cur=ir.risk&&typeof ir.risk==='object'?ir.risk.sizing as StrategyPrimitive|undefined:undefined;
  if(VOL_TARGET_TEXT.test(t)){
   const target=volTargetValue(t)??(cur?.primitive==='vol_target'&&Number(cur.params?.target_vol)>0?Number(cur.params.target_vol):0.5),keep=cur?.primitive==='vol_target'&&typeof cur.params?.lookback_bars==='number'?{lookback_bars:cur.params.lookback_bars}:{};
   const next=node('vol_target',{target_vol:target,...keep});
   if(JSON.stringify(cur)!==JSON.stringify(next)){if(!ir.risk||typeof ir.risk!=='object')ir.risk={};ir.risk.sizing=next;notes.push(`原话要波动率目标仓位 → vol_target 目标年化 ${Math.round(target*100)}%(每笔 100% 可用资金 × min(1, 目标/入场前实现波动),回看缺省 20 天)`);}
  }else if(cur?.primitive==='vol_target'){ir.risk!.sizing=node('equal_notional',{max_allocation:'1'});notes.push('自动更正:原话没有提波动率目标,仓位退回每笔 100% 可用资金(equal_notional)');}
  return notes;
}
/** 用户原话是否要求了 R 倍数止盈(「2R 止盈」「止盈 3 倍风险」「一半在 1.5R」)。「盈亏比至少 2」是门槛不是目标,不算。 */
export const R_TARGET_TEXT=/\d+(?:\.\d+)?\s*R(?![a-z])|R\s*倍数|(止盈|目标|盈利)[^,，。;；]{0,8}\d+(?:\.\d+)?\s*倍|\d+(?:\.\d+)?\s*倍[^,，。;；]{0,6}(止盈|目标|风险|止损距离)/i;
/** 结构口径:止盈不能是 R 倍数倒推的数(Jacky 09-23 / 几何实验室规则 3)。原话没要求 R 倍数止盈时,去掉模型自己加的 fixed_r_target(exit 与订单块止盈),每处写一条说明。 */
export function dropUnrequestedFixedR(text:string,raw:unknown):string[]{
 // compatibility(旧模板的无损映射,take_profit_r 是模板参数)不动;修订提示里带着冻结原规则且原规则就有 fixed_r_target 时,那是原策略的选择,不是模型加的
 const notes:string[]=[];if(!raw||typeof raw!=='object'||Array.isArray(raw)||R_TARGET_TEXT.test(text??'')||/fixed_r_target/.test(text??'')||'compatibility' in (raw as object))return notes;
 const ir=raw as {exit?:StrategyPrimitive[];order?:{take_profits?:{source?:StrategyPrimitive}[]}};
 if(Array.isArray(ir.exit)){const kept=ir.exit.filter(x=>x?.primitive!=='fixed_r_target');if(kept.length!==ir.exit.length){ir.exit=kept;notes.push('自动更正:原话没有要求 R 倍数止盈,去掉 fixed_r_target(止盈取图上结构,没有就交给追踪止损)');}}
 const tps=ir.order&&typeof ir.order==='object'?ir.order.take_profits:undefined;
 if(Array.isArray(tps)){const kept=tps.filter(t=>t?.source?.primitive!=='fixed_r_target');if(kept.length!==tps.length){if(kept.length)ir.order!.take_profits=kept;else delete ir.order!.take_profits;notes.push('自动更正:原话没有要求 R 倍数止盈,去掉订单块里的 fixed_r_target 止盈档');}}
 return notes;
}
/** 编译提示里的订单块约定(WP-F)。只描述映射规则,数值约束仍以策略规范为准。 */
export const ORDER_PROMPT='订单周期(order 块,可选):用户提到下单方式、盈亏比约束、做空、永续/杠杆、分批止盈、挂单时效、持仓周期、加仓/结转时写 order;都没提时不要写 order(旧行为)。映射:「限价回踩/挂在支撑/回踩 EMA20 再买」→ entry.type=limit,entry.price 用价位原语(structure_level 回踩支撑块上沿;indicator_level{indicator:ema,args:{period:20}};atr_offset_level{atr_period:14,multiple:0.5} 回撤半个 ATR;pct_offset_level{pct:0.01});「市价/直接进」→ entry.type=market;「挂单 N 根/小时内有效」→ entry.expiry_bars(换算成根数)。「盈亏比至少 2」→ min_rr:2(用户硬约束:放置时达不到就不下单;没说就不写,盈亏比只计算展示)。「止盈看布林上轨」→ take_profits:[{source:indicator_level{indicator:bbands,output:upper}}];「止盈看压力位」或没说 → 不写 take_profits,缺省由代码取图上最近未被扫的摆动高点(pivot_target),图上没有就不设止盈、由追踪止损管;「一半在 1.5R 一半在压力位」(用户原话给了 R 倍数)→ 两档 size_pct 0.5/0.5(fixed_r_target{r:1.5} + pivot_target);原话没说 R 倍数时不要用 fixed_r_target。「止损跌破 EMA50」→ risk.stop=indicator_level{indicator:ema,args:{period:50},buffer_atr 可选};「止损跌破支撑/前低」或没说 → 不写,缺省由代码取最近已确认摆动低点下方 0.1 ATR(pivot_stop);止损离入场不到 0.5 ATR 的信号不做,不要为了避开它把止损挪远。「做空」→ order.market=perp 且 direction=short,signal 写做空触发条件(如 indicator_cross direction=cross_below);「多空都做」→ direction=both,signal=做多条件,short_signal=做空条件;「永续 3 倍」→ market=perp,leverage=3;现货只能 long 且 leverage=1。「同一资产再出信号就加仓」→ on_new_signal.filled=add;「换成新计划」→ roll(缺省);「持有不超过 N 根」→ max_holding_bars;「第一档止盈后保本」→ breakeven_after_tp=true。止损、止盈、限价都是在信号那根收盘时由原语算出的价位,做空时结构/ATR 原语自动镜像到另一侧,不要自己写反向版本。SMC(聪明钱概念)说法:「摆动/内部结构看涨」→ regime=smc_trend{scope:swing|internal,direction:bullish};「BOS/CHoCH/结构突破」→ signal=smc_bos(事件型);「回踩看涨订单块限价买」→ signal=smc_bos{direction:bullish}(突破那根形成新订单块)+ entry.type=limit、entry.price=smc_ob_level;「止损放在订单块下沿」→ risk.stop=smc_ob_level(与入场同一 scope);「止盈看上方流动性/前高/等高点」→ take_profits:[{source:smc_liquidity_target}];「回补 FVG」→ smc_fvg_fill;「折价区买」→ smc_discount{zone:discount};「反向 CHoCH 离场」→ exit=smc_choch_exit。SMC 原语按 ctx.side 自己给多空两侧的价位。SMC 级别(scope):「摆动结构看涨/看跌」只写在 regime 的 smc_trend{scope:swing};触发信号 smc_bos、订单块 smc_ob_level/smc_ob_retest 缺省用内部级别(不写 scope 即 internal),只有原话明确说「摆动订单块/大级别订单块/摆动 BOS」才用 swing——摆动级别订单块离现价很远,限价几乎挂不到;流动性止盈 smc_liquidity_target 缺省 swing。';
export async function compileStrategy(raw:{text?:string;ir?:StrategyIR;timeframe:string;dataset_id?:string;execution?:ResearchExecution;order_gate?:OrderGateParams},brain?:Brain,dataset:ResearchDataset|null=null):Promise<StrategyCompileResult> {
 const gate=raw.order_gate??DEFAULT_ORDER_GATE;
 if(!raw.text){const checked=checkIR(raw.ir,raw.timeframe),constraints=compileConstraints(raw.timeframe,dataset,raw.execution,gate,checked.ir);return {...checked,constraints,spec:checkIRSpec(checked.ir,constraints),rules:checked.ir?rulesOf(checked.ir):[]};}
 if(!brain)throw new Error('compile_brain_required');
 const constraints=compileConstraints(raw.timeframe,dataset,raw.execution,gate),structureMode=isStructureGate(gate);
 const system=`将用户文本映射为下列原语组成的 StrategyIR，不生成或执行代码。只能输出一个 JSON 对象 {"ir":StrategyIR,"unmapped":[无法映射的原文片段及原因]}；未支持语义必须如实列出，不能默默宣称已实现。目录：${JSON.stringify(listPrimitives())}。IR schema：${JSON.stringify(schemas.research.$defs.StrategyIR)}。嵌套原语形状：${JSON.stringify(schemas.research.$defs.StrategyPrimitive)}。订单周期块 order 的形状：${JSON.stringify({StrategyOrder:schemas.research.$defs.StrategyOrder,StrategyOrderEntry:schemas.research.$defs.StrategyOrderEntry,StrategyOrderTakeProfit:schemas.research.$defs.StrategyOrderTakeProfit,StrategyOrderOnNewSignal:schemas.research.$defs.StrategyOrderOnNewSignal})}。${ORDER_PROMPT}语义约定：signal 数组内多个原语是 AND（同一根 bar 同时满足）；用户把两个入场想法并列（如「均线交叉 + MACD 底背离」）而没说必须同时满足时，选最主要的一个做 signal，另一个若有对应离场原语（顶背离→macd_divergence_exit）就放进 exit，其余如实写进 unmapped，不要把两个入场条件硬 AND 成零交易。与买入持有的对比、手续费/滑点扣除、样本外验证都由回测与 compare 步骤完成，不是原语，不要写进 unmapped。单资产策略不要写 universe(那是多资产筛选池),方向/趋势过滤用 regime。忠于用户:用户明确说了离场/止盈/止损规则时(如「死叉离场」「跌破 EMA50 离场」「顶背离离场」「持有 N 根」「止盈看布林上轨」「盈亏比至少 2」「不设止损」),exit 与 risk.stop 只放用户说的规则(信号离场用 indicator_cross_exit / trend_break / macd_divergence_exit / time_stop 等,价位用 levels 原语,不设止损用 no_stop),不要再额外加追踪出场、止盈或止损,否则回测的就不是用户的策略;${structureMode?'用户没说离场规则时才用默认(结构口径):止损=pivot_stop{swing_length:3}(最近已确认摆动低点下方 0.1 ATR),止盈=pivot_target{swing_length:3}(入场上方最近的未被扫的摆动高点/前高;图上没有就不设止盈),持仓用 chandelier_trail{atr_period:22,multiple:3} 追踪止损。止盈必须是图上有的价位,不要用 fixed_r_target 按 R 倍数倒推(用户原话要求 R 倍数除外);不生成到期出场(用户要求除外)。':'用户没说离场规则时才用默认:止盈=上方压力位 structure_target,止损=支撑破位(order_blocks / swing_low_stop),追踪出场可选。默认不生成固定 R 止盈或到期出场(用户要求除外)。追踪出场不替代止盈。'}仓位:用户没说就用 equal_notional max_allocation=1(每笔 100% 可用资金,现货不加杠杆),用户说了按风险比例才用 risk_fraction;用户说了「波动率目标 / 按波动调仓位 / vol target」才用 vol_target{target_vol:年化小数,缺省 0.5}(每笔仓位 × min(1, 目标/入场前实现波动)),没说不要加。止损与止盈必须按下面的策略规范设计，回测与实盘用同一份代码强制执行；编译结果会带 spec.violations，有 block 的策略不能发起实验：\n${specText(constraints,'compile')}\n${structureMode?`止损放在图上的结构位(pivot_stop / order_blocks / htf_structure),用 ATR 时倍数不得低于 ${constraints.min_stop_atr}(离入场不到 ${constraints.min_stop_atr}×ATR 的单子不做,代码不会替你挪远);止盈放在图上有的价位(pivot_target / structure_target / smc_liquidity_target / 用户指定的指标线),盈亏比只计算展示、不拦单(用户原话硬约束除外);`:'止损来源优先结构位（order_blocks / htf_structure），用 ATR 时倍数不得低于上面给出的 ATR 下限；止盈来源优先 structure_target（上方阻力块下沿），盈亏比达不到最小值的位置策略应主动放弃而不是靠事后拦截；'}建议加 htf_structure_regime 作为 regime，让日线结构决定方向。编译后用 precheck 验证；description 必须说明预期持有期和每 1000 根信号频率的量级，未测量时明确是待验证假设。固定目标/时间仅 optional。`;
 let user=raw.text;const ATTEMPTS=3;for(let attempt=0;attempt<ATTEMPTS;attempt++){
  const response=await brain.complete(system,user,{timeoutMs:120000});
  try{let parsed=extractJson(response.text) as {ir?:unknown;unmapped?:unknown};
   // 2026-09-22 联调:模型偶尔把 IR 再包一层 {ir:{ir:…}}、把 ir 写成 JSON 字符串、或直接输出 IR 本体(有 signal/entry 没有 ir 键);都按 IR 收,unmapped 缺失按空数组
   if(parsed&&typeof parsed==='object'&&typeof parsed.ir==='string'){try{parsed={...parsed,ir:JSON.parse(parsed.ir)};}catch{}}
   if(parsed&&typeof parsed==='object'&&parsed.ir&&typeof parsed.ir==='object'&&'ir' in (parsed.ir as Record<string,unknown>)&&!('signal' in (parsed.ir as Record<string,unknown>)))parsed={...parsed,ir:(parsed.ir as {ir:unknown}).ir};
   if(parsed&&typeof parsed==='object'&&!('ir' in parsed)&&'signal' in parsed&&'entry' in parsed)parsed={ir:parsed,unmapped:[]};
   if(parsed&&typeof parsed==='object'&&parsed.unmapped===undefined)parsed={...parsed,unmapped:[]};
   // 模型四次里三次把 unmapped 写成 [{fragment|text, reason}] 对象(2026-09-22 实测):折成字符串收下,不因此判死整次编译
   if(parsed&&typeof parsed==='object'&&Array.isArray(parsed.unmapped))parsed={...parsed,unmapped:parsed.unmapped.map(x=>typeof x==='string'?x:x&&typeof x==='object'?[(x as Record<string,unknown>)['fragment']??(x as Record<string,unknown>)['text']??(x as Record<string,unknown>)['原文']??'',(x as Record<string,unknown>)['reason']??(x as Record<string,unknown>)['原因']??''].filter(Boolean).map(String).join(':')||JSON.stringify(x):String(x))};
   // 模型爱给单资产策略塞一个空的 universe.screen:{},引擎会因此要求资产池(strategy_screen_requires_universe);空筛选等于没有筛选,剥掉
   if(parsed&&typeof parsed==='object'&&parsed.ir&&typeof parsed.ir==='object'){const u=(parsed.ir as {universe?:{screen?:Record<string,unknown>}}).universe;if(u&&(!u.screen||!Object.keys(u.screen).length))delete (parsed.ir as {universe?:unknown}).universe;}
   if(!parsed||!Array.isArray(parsed.unmapped)||parsed.unmapped.some(x=>typeof x!=='string'))throw new Error('unmapped_required');
   // 2026-09-21 真模型实测:模型会照着目录给自由策略贴上 compatibility:'donchian_close_long_v1',而它并不是无损的旧模板映射,
   // 会让 state_machine 判死。compatibility 只属于 policy → IR 的机械映射;文本路径一律剥掉,并在 unmapped 里如实记录。
   const notes=parsed.unmapped as string[];
   if(parsed.ir&&typeof parsed.ir==='object'&&'compatibility' in (parsed.ir as Record<string,unknown>)){let lossless=false;try{irToPolicy(parsed.ir as StrategyIR);lossless=true;}catch{}if(!lossless){delete (parsed.ir as Record<string,unknown>)['compatibility'];notes.push('模型误标 compatibility(不是旧模板的无损映射),已按新策略处理');}}
   // 确定性自动补全:止盈/追踪出场/仓位这类「规范要求但模型常漏」的槽位由代码补齐并写进 unmapped,用户拿到的是可回测的 IR 而不是一句「数据结构不符」
   // 用户原话里的订单语义(限价回踩/盈亏比/止盈看布林/止损跌破均线/做空/永续 N 倍)由代码确定性落进 order 块,不全靠模型理解;在 repairIR 之前做,补全才能看到用户给的止损止盈
   notes.push(...applyOrderPhrases(raw.text??'',parsed.ir));
   notes.push(...applySizingPhrases(raw.text??'',parsed.ir));
   if(isStructureGate(gate))notes.push(...dropUnrequestedFixedR(raw.text??'',parsed.ir));
   const repaired=repairIR(parsed.ir,constraints,raw.text??'');notes.push(...repaired.notes);
   // 用户没提永续/做空/杠杆/双向时,模型写的 perp/short/both 订单块一律退回现货单向做多(2026-09-23 实测「均线交叉」被编成「永续双向死叉做空」)
   {const o=(repaired.ir as {order?:Record<string,unknown>}|null)?.order;if(o&&(o.market==='perp'||o.direction!=='long'||Number(o.leverage??1)>1)&&!/永续|合约|perp|swap|做空|空单|开空|short|杠杆|倍|双向|多空/i.test(raw.text??'')){o.market='spot';o.direction='long';o.leverage=1;delete o.short_signal;delete o.short_regime;notes.push('自动更正:问题里没有提永续/做空/杠杆,订单块退回现货单向做多');}}
   const checked=checkIR(repaired.ir,raw.timeframe);if(!checked.ir)throw new Error('invalid_ir_json');
   const c=compileConstraints(raw.timeframe,dataset,raw.execution,gate,checked.ir),spec=checkIRSpec(checked.ir,c);
   if(!checked.ok||!spec.ok){const failed=[...checked.checks.filter(x=>!x.ok).map(x=>x.name+':'+x.message),...spec.violations.filter(v=>v.severity==='block').map(v=>v.code+':'+v.message)];
    console.error('[research.compile] attempt',attempt,'checks failed:',failed.join(' | '),'\nIR:',JSON.stringify(checked.ir).slice(0,3000));
    if(attempt<ATTEMPTS-1){user=raw.text+`\n上一次输出未通过检查：${failed.join('；')}。上一次 IR：${JSON.stringify(checked.ir)}。只修正违规的字段，其他保持不变；只能使用目录中的原语与参数；保留 unmapped。`;continue;}}
   return {...checked,unmapped:notes,constraints:c,spec,rules:rulesOf(checked.ir)};}
  catch(e){console.error('[research.compile] attempt',attempt,'parse/check error:',String(e),'\nRAW:',response.text.slice(0,3000));if(attempt===ATTEMPTS-1)return {...checkIR(null,raw.timeframe),unmapped:[`模型 ${ATTEMPTS} 次输出未能解析；未执行任何策略`],summary:String(e)};user=raw.text+`\n上一次输出格式错误：${String(e)}。修复 JSON，保留无法映射的语义。`;}
 }
 throw new Error('unreachable');
}
export type ResolvedRequest=ResearchRequest & {policy:ResearchPolicy};
export function resolveRequest(r:ResearchRequest):ResolvedRequest {
 if(r.policy)return {...r,policy:irToPolicy(policyToIR(r.policy))} as ResolvedRequest;
 const ir=r.strategy_ir!;let policy:ResearchPolicy;
 if(ir.compatibility)policy=irToPolicy(ir);else policy={label:ir.label,description:ir.description,interpretation:'donchian_close_long_v1',lookback:2,atr_period:2,stop_atr:2,take_profit_r:2,volume_multiple:1,holding_bars:10000};
 const sizing=ir.risk.sizing,value=registry.get(sizing.primitive)!.compute({bars:[],i:-1,timeframe_ms:3600000},sizing.params).sizing!;return {...r,policy,execution:{...r.execution,risk_fraction:value.risk_fraction??r.execution.risk_fraction,max_allocation:value.max_allocation,allocation:value.allocation}};
}
export function requestHorizon(r:ResearchRequest):number|null {if(r.policy)return r.policy.holding_bars;const times=r.strategy_ir?.exit.filter(x=>x.primitive==='time_stop').map(x=>Number(x.params.bars))??[];return times.length?Math.min(...times):null;}
export function irWarmup(ir:StrategyIR,base:number):number {return Math.max(...[...strategyNodes(ir),...orderNodes(ir)].map(({node})=>registry.get(node.primitive)!.warmup_bars(node.params,base)));}
/** 多周期原语(htf_ma_state、macd_divergence{htf})从整段已收盘 K 线计算,决策视图预热记 0;它们要的窗口前历史(执行周期根数,可超过 5000)在这里汇总,只给取数用。不用这些原语的 IR 恒为 0。 */
export function irHistoryBars(ir:StrategyIR,base:number):number {return Math.max(0,...[...strategyNodes(ir),...orderNodes(ir)].map(({node})=>{try{return registry.get(node.primitive)?.history_bars?.(node.params,base)??0;}catch{return 0;}}));}
export function passesUniverseScreen(ir:StrategyIR,ctx:Pick<PrimitiveContext,'screen'>):boolean {
 const screen=ir.universe?.screen;
 if(screen){const row=ctx.screen;if(!row||row.status!=='ok'||(screen.require_trend&&(row.trend.status!=='ok'||!screen.require_trend.includes(row.trend.state)))||(screen.min_residual_sharpe!==undefined&&(row.residual?.sharpe==null||row.residual.sharpe<screen.min_residual_sharpe))||(screen.max_beta!==undefined&&(row.beta===undefined||row.beta>screen.max_beta))||(screen.top_n!==undefined&&(!row.rank||row.rank.composite>screen.top_n)))return false;}
 return true;
}
export function irCandidate(ir:StrategyIR,ctx:PrimitiveContext,legacyTargetAnchor=false):{entry:Entry|null;reason:string} {
 if(!passesUniverseScreen(ir,ctx))return {entry:null,reason:'screen_filter'};
 if(ir.regime&&!registry.get(ir.regime.primitive)!.compute(ctx,ir.regime.params).pass)return {entry:null,reason:'regime_filter'};
 if(!ir.signal.every(x=>registry.get(x.primitive)!.compute(ctx,x.params).pass))return {entry:null,reason:'no_candidate'};
 const stop=registry.get(ir.risk.stop.primitive)!.compute(ctx,ir.risk.stop.params).stop,close=Number(ctx.bars[ctx.i]?.close);
 if(!(stop&&Number.isFinite(stop)&&stop>0&&stop<close))return {entry:null,reason:'invalid_stop'};
 const targets=ir.exit.filter(x=>x.primitive==='fixed_r_target').map(x=>Number(x.params.r)),structural=ir.exit.find(x=>x.primitive==='structure_target')??ir.exit.find(x=>x.primitive==='pivot_target'),target=targets.length?close+(close-stop)*Math.min(...targets):structural?(registry.get(structural.primitive)!.compute(ctx,structural.params).target??null):null;
 return {entry:{candidate_id:`candidate_${ctx.bars[ctx.i]!.close_time}`,stop:stop.toFixed(8),target:target?.toFixed(8)??null,...(targets.length&&!legacyTargetAnchor?{target_r:Math.min(...targets)}:{}),reason:'strategy_ir_signal'},reason:'strategy_ir_signal'};
}
export function irExit(ir:StrategyIR,ctx:PrimitiveContext,p:Position,legacy=false):{stop:bigint|null;reason:string|null;stop_reason?:import('@trading-swarm/contracts').ResearchTrade['reason']} {
 let stop:bigint|null=null,reason:string|null=null,stop_reason:import('@trading-swarm/contracts').ResearchTrade['reason']|undefined;
 for(const x of ir.exit){if(['fixed_r_target','structure_target','pivot_target'].includes(x.primitive))continue;const v=legacy&&x.primitive==='swing_structure_stop'?{stop:ctx.position?Math.min(...ctx.bars.slice(-Number(x.params.lookback)).map(b=>Number(b.low))):undefined}:registry.get(x.primitive)!.compute(ctx,x.params);if(v.exit)reason??=!legacy&&x.primitive==='time_stop'?'time':x.primitive;if(v.stop!==undefined&&Number.isFinite(v.stop)&&v.stop>0){const value=q(v.stop.toFixed(8));if(value>p.stop&&(stop===null||value>stop)){stop=value;stop_reason=legacy?undefined:x.primitive==='chandelier_trail'?'trail':x.primitive==='breakeven_after_r'?'breakeven':'structure';}}}
 return {stop,reason,stop_reason};
}
