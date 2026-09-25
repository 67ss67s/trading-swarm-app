import type {ResearchPrecheckRequest,ResearchPrecheckResult,ResearchDataset} from '@trading-swarm/contracts';
import {checkIR,irCandidate,irWarmup} from './strategy.js';
import {registry} from './primitives/index.js';
import {evaluateOrderGate,DEFAULT_ORDER_GATE,riskCapApplies} from './order-gate.js';
import {fitCandidate,fixedTargetR} from './candidate-gate.js';
import {screenUniverse} from './screen.js';
import type {ResearchStore} from './store.js';
import {runReplay,viewBars} from './engine.js';
import {q,decimal,div,mul,min,SCALE,assertContract} from './primitives.js';
const median=(x:number[])=>{const a=x.filter(Number.isFinite).sort((a,b)=>a-b);return a.length?(a[Math.floor((a.length-1)/2)]!+a[Math.floor(a.length/2)]!)/2:null;};
/** Rule-only bounded sample. Candidate frequency is not a promise of realized trade count. */
export async function precheck(raw:ResearchPrecheckRequest,store:ResearchStore):Promise<ResearchPrecheckResult>{
 assertContract<ResearchPrecheckRequest>(raw);if(!('ir' in raw))throw Error('expected_precheck');
 const datasets=raw.universe_id?store.portfolio(raw.universe_id).datasets:[store.dataset(raw.dataset_id!)],base=datasets[0]!.timeframe_ms,checked=checkIR(raw.ir,`${base/60000}m`),gate=raw.order_gate??DEFAULT_ORDER_GATE;
 const sizing=registry.get(raw.ir.risk.sizing.primitive)?.compute({bars:[],i:-1,timeframe_ms:base},raw.ir.risk.sizing.params).sizing;const execution={...raw.execution,...(sizing?{risk_fraction:sizing.risk_fraction??raw.execution.risk_fraction,max_allocation:sizing.max_allocation,allocation:sizing.allocation}:{}),sizing_mode:raw.execution.sizing_mode??'unit_notional'};
 if(!checked.ok)return {ok:false,items:checked.checks.filter(c=>!c.ok).map(c=>({name:c.name,ok:false,value:null,note:c.message})),suggestions:['先修复编译检查中的止损/止盈来源与参数问题']};
 if(!Number.isSafeInteger(raw.from_ms)||!Number.isSafeInteger(raw.to_ms)||raw.from_ms>=raw.to_ms)throw Error('invalid_precheck_range');
 const total= datasets.reduce((sum,d)=>sum+d.bars.filter(b=>b.close_time>=raw.from_ms&&b.close_time<=raw.to_ms).length,0);if(total>100000)throw Error('precheck_bar_budget');
 const screens=new Map<number,ReturnType<typeof screenUniverse>>(),ratios:number[]=[],holds:number[]=[],blocks:Record<string,number>={};let candidates=0,passed=0,bars=0,regime=0,warmup=Infinity,widened=0,fallback=0;const rawStops:number[]=[];
 const deadline=Date.now()+15000;
 // 2026-09-23 全窗口:体检与 engine v4 同一视图长度(最近 W 根),内部 A 臂回放走 v4 快路径;只影响体检估计,不进任何 manifest
 const view=viewBars(raw.ir,{lookback:1,atr_period:1} as import('@trading-swarm/contracts').ResearchPolicy,base);
 for(const d of datasets){
  const first=d.bars.findIndex(b=>b.close_time>=raw.from_ms);warmup=Math.min(warmup,Math.max(0,first));
  for(let i=first;i<d.bars.length&&d.bars[i]!.close_time<=raw.to_ms;i++){
   if(i<0)break;if(Date.now()>deadline)throw Error('precheck_time_budget');const b=d.bars[i]!;bars++;
   let screen;
   if(raw.universe_id&&raw.ir.universe?.screen){let all=screens.get(b.close_time);if(!all){all=screenUniverse(store.universe(raw.universe_id),datasets,{as_of:b.close_time});screens.set(b.close_time,all);}screen=all.rows.find(r=>r.symbol===d.symbol);}
   const visible=d.bars.slice(Math.max(0,i-view+1),i+1),ctx={bars:visible,i:visible.length-1,timeframe_ms:base,screen,series:d.bars,series_i:i};
   if(!raw.ir.regime||registry.get(raw.ir.regime.primitive)!.compute(ctx,raw.ir.regime.params).pass)regime++;
   const signal=irCandidate(raw.ir,ctx);if(!signal.entry)continue;candidates++;
   const placed=gate.stop_floor!==undefined?fitCandidate(signal.entry,b.close,execution,gate,fixedTargetR(raw.ir,undefined)):signal.entry;if(placed.fit?.stop_source==='cost_floor')widened++;if(placed.fit?.target_source==='fallback_r')fallback++;rawStops.push(Number(q(b.close)-q(signal.entry.stop))/Number(q(b.close)));
   const e=q(b.close),stop=q(placed.stop),equity=q(execution.initial_cash),maxPositions=raw.universe_id?(execution.max_positions??3):1,unit=(execution.sizing_mode??'unit_notional')==='unit_notional';
   const notional=unit||execution.allocation==='equal_notional',cap=unit?equity/BigInt(maxPositions):mul(equity,q(execution.max_allocation))/BigInt(raw.universe_id&&notional?maxPositions:1),budget=mul(equity,q(execution.risk_fraction));
   const qty=min(notional?div(cap,e):div(budget,e-stop),div(cap,e),div(equity,mul(e,SCALE+q(execution.fee_rate))));
   const result=evaluateOrderGate({side:'long',entry:b.close,stop:placed.stop,target:placed.target,costs:execution,equity:execution.initial_cash,qty:riskCapApplies(gate,execution.sizing_mode)?decimal(qty):null,params:gate});ratios.push(result.stop_over_cost);if(result.ok)passed++;for(const key of result.blocked_by)blocks[key]=(blocks[key]??0)+1;
  }
  // Ungated A path estimates holding duration independently of how many candidates gates reject.
  if(first>0&&d.bars.some(b=>b.close_time===raw.from_ms)&&d.bars.some(b=>b.close_time===raw.to_ms)&&!raw.ir.universe?.screen){const result=await runReplay(d,{idempotency_key:'precheck',dataset_id:'precheck',study_id:'precheck',strategy_ir:raw.ir,execution:{...execution,sizing_mode:'risk_fraction'},from_ms:raw.from_ms,to_ms:raw.to_ms,arms:['a_rules'],repeats:1,max_model_calls:0,timeout_ms:15000,purpose:'development',acknowledge_adaptive_search:false},async()=>{throw Error('precheck_model_forbidden');},{diagnostics:true,fast:true,check:()=>{if(Date.now()>deadline)throw Error('precheck_time_budget');}});for(const t of result.arms[0]?.trades??[])if(t.holding_bars!==undefined)holds.push(t.holding_bars);}
 }
 const ratio=median(ratios),rawMedian=median(rawStops),cost=2*Number(execution.fee_rate)+2*Number(execution.slippage_bps)/1e4,maxFit=raw.thresholds?.max_stop_fit_rate??0.5,holding=median(holds),coverage=bars?regime/bars:0,passRate=candidates?passed/candidates:0,t=raw.thresholds??{},minTrades=t.min_trades??30,minPass=t.min_gate_pass_rate??0.5,minHold=t.min_holding_bars??2,minRegime=t.min_regime_coverage??0.05;
 const items:ResearchPrecheckResult['items']=[{name:'signal_frequency',ok:candidates>0,value:candidates,note:`窗口 ${bars} 根，约 ${candidates} 个候选（每 1000 根 ${bars?(1000*candidates/bars).toFixed(1):0} 个）；不是实际成交数`},{name:'min_trades',ok:candidates>=minTrades,value:candidates,threshold:minTrades},{name:'stop_over_cost',ok:ratio!==null&&ratio>=gate.min_stop_cost_multiple,value:ratio,threshold:gate.min_stop_cost_multiple,note:'中位止损距离/往返成本；无成本时返回有限的大数'},{name:'order_gate_pass_rate',ok:passRate>=minPass,value:passRate,threshold:minPass,note:JSON.stringify(blocks)},{name:'stop_fit_rate',ok:candidates===0||widened/candidates<=maxFit,value:candidates?widened/candidates:null,threshold:maxFit,note:`策略原始止损中位 ${rawMedian===null?'—':(rawMedian*100).toFixed(2)+'%'}，成本下限 ${(gate.min_stop_cost_multiple*cost*100).toFixed(2)}%；${widened} 个候选被放宽到下限，${fallback} 个用固定倍数补止盈。放宽比例高说明策略止损与周期/成本不匹配`},{name:'holding_vs_timeframe',ok:holding!==null&&holding>=minHold,value:holding,threshold:minHold,note:'未加 order-gate 的纯 A 历史中位持有根数；缺交易/组合过滤时未知'},{name:'warmup_coverage',ok:warmup>=irWarmup(raw.ir,base),value:Number.isFinite(warmup)?warmup:0,threshold:irWarmup(raw.ir,base)},{name:'regime_coverage',ok:coverage>=minRegime,value:coverage,threshold:minRegime}];
 const suggestions:string[]=[];if(blocks['stop_too_tight'])suggestions.push('止损窄于成本下限且 stop_floor=block：增加 ATR 止损倍数或采用确认结构位止损');if(candidates&&widened/candidates>maxFit)suggestions.push(`${Math.round(100*widened/candidates)}% 的候选止损被放宽到成本下限：策略自己的止损在本周期几乎不起作用，换更高周期或把止损放在结构位`);if(blocks['min_rr'])suggestions.push('结构目标离入场太近：候选出现的位置离上方阻力块没有空间，属于策略该放弃的位置');if(blocks['no_target'])suggestions.push('当前历史窗口没有可用阻力块；补充目标来源或扩大结构预热');if(blocks['risk_cap'])suggestions.push('固定名义仓位与止损距离超过风险上限：显式改用 risk_fraction，或由用户调整研究参数后重新体检');if(candidates<minTrades)suggestions.push('扩大历史窗口或核对信号频率；不要只挑未来赢家');if(!suggestions.length&&!items.every(i=>i.ok))suggestions.push('扩大预热/历史窗口并核对预期持有期');return {ok:items.every(i=>i.ok),items,suggestions};
}
