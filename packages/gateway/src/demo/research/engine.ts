import {candidateGate as evaluateCandidate,fitCandidate,fixedTargetR} from './candidate-gate.js';
import {htfStructure} from './primitives/structure.js';
import { evaluateOrderGate, LEGACY_ORDER_GATE, isStructureGate } from './order-gate.js';
import { ExecutionTally } from './execution-gate.js';
import { atrSeries } from './primitives/indicators.js';
import { checkProposalSpec } from './strategy-spec.js';
import { diagnostics } from './diagnostics.js';
import { resolveRequest,irCandidate,irExit,irWarmup,strategyNodes } from './strategy.js';
import { volTargetOf,volTargetWeight } from './primitives/sizing.js';
import { createHash } from 'node:crypto';
import { trendState } from './primitives/trend-state.js';
import type {ResearchEntry, ResearchDataset, ResearchRequest, ResearchBar, ResearchDecision, ResearchArmResult, ResearchMetrics, ResearchScreenRow, ResearchTrend, ResearchPolicy, StrategyIR } from '@trade-gate/contracts';
import { SpotLedger, type Entry } from './ledger.js';
import { clone, hash, decimal, q, mul, ENGINE_VERSION } from './primitives.js';
import { sharpe, bootstrapCI } from '../replay-stats.js';
export type DecisionView = import('@trade-gate/contracts').ResearchDecisionView;
export type AgentAction = import('@trade-gate/contracts').ResearchAgentAction;
export type Decider=(v:DecisionView)=>Promise<AgentAction>;
export type RecordedDecision = import('@trade-gate/contracts').ResearchRecordedDecision;
export interface RunResult { evaluation?:ReturnType<typeof import('./evaluation.js').selectionEvaluation>; engine_version:string;status:'completed'|'cancelled'|'budget_exhausted'|'failed'; error:string|null; arms:ResearchArmResult[]; recordings:RecordedDecision[]; comparison:ReturnType<typeof compareArms>; }
export class StopRun extends Error {constructor(readonly status:'cancelled'|'budget_exhausted',message:string){super(message);}}
export async function safeDecision(decide:Decider,v:DecisionView):Promise<AgentAction> {
  try{return await decide(clone(v));}catch(e){if(e instanceof StopRun)throw e;return {action:'model_error',reason:e instanceof Error?e.message:String(e),gate_errors:['model_call_failed'],evidence_refs:[]};}
}
export function candidateAt(bars:ResearchBar[],p:ResearchPolicy):Entry|null {
  if(bars.length<=Math.max(p.lookback,p.atr_period))return null;
  const last=bars.at(-1)!, prior=bars.slice(-p.lookback-1,-1);
  const edge=Math.max(...prior.map(b=>Number(b.high))),vol=prior.reduce((a,b)=>a+Number(b.volume),0)/prior.length;
  if(Number(last.close)<=edge || vol<=0 || Number(last.volume)<vol*p.volume_multiple)return null;
  let sum=0;
  for(let i=bars.length-p.atr_period;i<bars.length;i++) {const b=bars[i]!,prev=Number(bars[i-1]!.close);sum+=Math.max(Number(b.high)-Number(b.low),Math.abs(Number(b.high)-prev),Math.abs(Number(b.low)-prev));}
  const distance=sum/p.atr_period*p.stop_atr, stop=Number(last.close)-distance,target=Number(last.close)+distance*p.take_profit_r;
  if(!(stop>0 && distance>0))return null;
  return {candidate_id:`candidate_${last.close_time}`,stop:stop.toFixed(8),target:target.toFixed(8),reason:`close > previous ${p.lookback} highs; volume >= ${p.volume_multiple}x; ATR(${p.atr_period})`};
}
export function metrics(l:SpotLedger,openIds=new Set(l.position?[l.position.id]:[])):ResearchMetrics {
  const groups=new Map<string,{net_pnl:string;initial_risk:string;notional:string}>();
  for(const t of l.trades){if(openIds.has(t.position_id))continue;const old=groups.get(t.position_id);groups.set(t.position_id,{notional:decimal(q(old?.notional??'0')+mul(q(t.entry_price),q(t.qty))),net_pnl:decimal(q(old?.net_pnl??'0')+q(t.net_pnl)),initial_risk:decimal(q(old?.initial_risk??'0')+q(t.initial_risk))});}
  const closed=[...groups.values()];
  const initial=q(l.config.initial_cash),last=l.equity.at(-1),wins=closed.filter(t=>q(t.net_pnl)>0n),loss=closed.filter(t=>q(t.net_pnl)<0n);
  const gain=wins.reduce((a,t)=>a+Number(t.net_pnl),0),lost=-loss.reduce((a,t)=>a+Number(t.net_pnl),0);
  const days=new Map<number,number>(); for(const m of l.equity)days.set(Math.floor(m.at/86400000),Number(m.equity));
  // First/last UTC day may be partial; only complete interior day returns enter annualization.
  const closes=[...days.values()],returns=closes.slice(2,-1).map((v,i)=>v/closes[i+1]!-1),sr=returns.length>=30?sharpe(returns):null;
  const equity=last?q(last.equity):initial;
  // 契约口径:比例一律小数(0.0143 = 1.43%)。2026-09-22 之前这里乘了 100,前端再乘 100 就显示成「每笔期望 -143.15%」;bins 同步改小数。
  const pct=closed.map(t=>Number(t.net_pnl)/Number(t.notional)).sort((a,b)=>a-b),avg=pct.length?pct.reduce((a,b)=>a+b,0)/pct.length:null;
  const bins=[-0.2,-0.1,-0.05,-0.02,0,0.02,0.05,0.1,0.2],counts=Array<number>(bins.length-1).fill(0);
  for(const value of pct){let i=bins.findIndex((edge,j)=>j>0&&value<edge)-1;if(i<0)i=value<bins[0]!?0:counts.length-1;counts[i]=counts[i]!+1;}
  const pctMetrics=l.config.sizing_mode?{per_trade_return_pct:{avg,median:pct.length?(pct[Math.floor((pct.length-1)/2)]!+pct[Math.floor(pct.length/2)]!)/2:null,std:avg===null?null:Math.sqrt(pct.reduce((a,b)=>a+(b-avg)**2,0)/pct.length),best:pct.at(-1)??null,worst:pct[0]??null},expectancy_pct:avg,trade_return_histogram:{bins,counts}}:{};
  // Win rate counts fully closed positions, not individual reduction fills.
  return {...pctMetrics,net_return:Number(equity-initial)/Number(initial),max_drawdown:Math.max(0,...l.equity.map(m=>m.drawdown)),avg_exposure:l.equity.length?l.equity.reduce((a,m)=>a+m.exposure,0)/l.equity.length:0,turnover:Number(l.turnover)/Number(initial),closed_trades:closed.length,win_rate:closed.length?wins.length/closed.length:null,profit_factor:lost>0?gain/lost:null,net_pnl:decimal(equity-initial),fees:decimal(l.fees),open_position:!!l.position,daily_sharpe:sr===null?null:sr*Math.sqrt(365),sharpe_status:sr===null?'insufficient':'estimated',avg_net_r:closed.length?closed.reduce((a,t)=>a+(q(t.initial_risk)>0n?Number(t.net_pnl)/Number(t.initial_risk):0),0)/closed.length:null};
}
export function compareArms(arms:ResearchArmResult[]) {
  const a=arms.find(x=>x.arm==='a_rules:0');
  return arms.filter(x=>x.arm!=='a_rules:0').map(b=>{
    const am=new Map(a?.decisions.map(d=>[`${d.at}:${d.symbol??''}`,d])??[]);
    const comparable=(action:string)=>action==='follow'?'enter':action;
    const differences=b.decisions.flatMap(d=>{const x=am.get(`${d.at}:${d.symbol??''}`);return x&&comparable(x.action)!==comparable(d.action)?[{at:d.at,candidate_id:d.candidate_id,a_action:x.action,b_action:d.action,arm:b.arm,reason:d.reason}]:[];});
    const av=new Map(a?.equity.map((e,i)=>[e.at,i>0?Number(e.equity)/Number(a.equity[i-1]!.equity)-1:0])??[]);
    const deltas=b.equity.slice(1).filter(e=>av.has(e.at)).map((e,i)=>Number(e.equity)/Number(b.equity[i]!.equity)-1-av.get(e.at)!);
    return {arm:b.arm,net_return_delta:a?b.metrics.net_return-a.metrics.net_return:null,exposure_delta:a?b.metrics.avg_exposure-a.metrics.avg_exposure:null,paired_bar_return_ci:bootstrapCI(deltas),differences,note:'CI is exploratory, block length sqrt(n); overlapping trades / adaptive trials / partial runs are not promotion evidence'};
  });
}

/** engine v4 口径(2026-09-23,全窗口多资产回测报告):只在显式开启时使用,旧 manifest 永远走下面的 v2/v3 分支,重放哈希不变。
 * 与 v3 的差异:① 决策视图是最近 W 根(W=clamp(6×预热,500,5000))而不是固定 5000 根,且 A 臂不跨 decider 边界时不深拷贝;
 * ② input_hash 改成「决策当根 + 截至当根 K 线链式摘要 + 账户/持仓/候选」的小对象哈希,不再对整段视图做 canonical;
 * ③ A 臂持仓期间不再算入场候选(A 臂持仓时只 hold/exit,候选本来就用不上);④ 止损/止盈同根触发按 Nautilus bar 路径(ledger bar_path=adaptive);
 * ⑤ 候选/出场信号按 (数据集, IR, bar, 持仓状态) 记忆,篮子腿与单资产同一数据复用。因果性不变:视图只含 ≤ i 的 bar。 */
export const FAST_ENGINE_VERSION='research-spot-ir-v4';
/** v4 快路径 + 结构口径 order_gate(min_stop_atr,2026-09-23):决策时刻止损 <k×ATR(14) 不做、不按盈亏比拦、不放宽止损、不按 R 补止盈。
 * 口径由冻结的 order_gate 决定,旧 manifest(没有 min_stop_atr)仍记 v4 且逐字重放。 */
export const FAST_ENGINE_VERSION_STRUCTURE='research-spot-ir-v5';
/** 研究请求契约里没有 engine 字段;新口径的 run 用 spec_version 后缀标记(旧 manifest 没有这个后缀)。主线程加正式字段前的过渡写法。 */
export const FAST_ENGINE_MARK=';engine=v4';// spec_version 上限 40 字符:'strategy-spec/v1;engine=v4'
export const isFastRequest=(r:ResearchRequest)=>!!r.spec_version?.endsWith(FAST_ENGINE_MARK);
export type SignalCache=Map<string,unknown>;
const chains=new WeakMap<ResearchBar[],string[]>(),numerics=new WeakMap<ResearchBar[],ResearchBar[]>();
/** 截至第 i 根的 K 线链式摘要:H_i=sha256(H_{i-1}‖canonical(bar_i));一次 O(n),每根决策 O(1) 取用。 */
export function barChain(bars:ResearchBar[]):string[]{let c=chains.get(bars);if(!c){c=[];let h='';for(const b of bars){h=createHash('sha256').update(h+canonicalBar(b)).digest('hex');c.push(h);}chains.set(bars,c);}return c;}
const canonicalBar=(b:ResearchBar)=>`${b.open_time},${b.close_time},${b.available_at},${b.open},${b.high},${b.low},${b.close},${b.volume}`;
/** 原语只用 Number() 读 OHLCV:预先转成数字能省掉每根重复解析;引用 Pine 脚本的 IR 不用(Pine 运行时按字符串比对还原整段数据)。 */
export function numericBars(bars:ResearchBar[]):ResearchBar[]{let n=numerics.get(bars);if(!n){n=bars.map(b=>({...b,open:Number(b.open),high:Number(b.high),low:Number(b.low),close:Number(b.close),volume:Number(b.volume)}) as unknown as ResearchBar);numerics.set(bars,n);}return n;}
export function viewBars(ir:StrategyIR|undefined,policy:ResearchPolicy,timeframe_ms:number):number{let w:number;try{w=ir?irWarmup(ir,timeframe_ms):Math.max(policy.lookback,policy.atr_period)+1;}catch{w=5000;}return Math.min(5000,Math.max(500,6*w));}
const usesPine=(ir:StrategyIR|undefined)=>!!ir&&strategyNodes(ir).some(x=>x.node.primitive.startsWith('pine_'));
export async function runReplay(d:ResearchDataset,raw:ResearchRequest,decide:Decider,opts:{legacy?:boolean;legacyTargetAnchor?:boolean;diagnostics?:boolean;check?:()=>void;event?:(event:string,data:Record<string,unknown>)=>void;replay?:RecordedDecision[];fast?:boolean;cache?:SignalCache}={}):Promise<RunResult> {
  if(raw.strategy_ir?.judge)throw Error('ir_judge_requires_order_executor');
  const r=resolveRequest(raw),ir=r.strategy_ir,vt=ir?volTargetOf(ir):null;
  // 快路径只给纯 A 臂(零模型):B/C 要把完整视图交给 decider,仍走 v3
  const fast=(opts.fast??isFastRequest(raw))&&r.arms.every(a=>a==='a_rules'),W=fast?viewBars(ir,r.policy,d.timeframe_ms):5000,src=fast&&!usesPine(ir)?numericBars(d.bars):d.bars,chain=fast?barChain(d.bars):[],memo=fast?(opts.cache??new Map()):null;
  const recordings:RecordedDecision[]=[];const arms:ResearchArmResult[]=[];let recording_bytes=0;
  const cache=opts.replay?new Map(opts.replay.map(v=>[v.input_hash,v])):null;
  let status:RunResult['status']='completed',error:string|null=null;
  const start=d.bars.findIndex(b=>b.close_time===r.from_ms),end=d.bars.findIndex(b=>b.close_time===r.to_ms);
  const first={...d.bars[start]!,close_time:r.from_ms-1};
  let lastYield=performance.now();
  const legNames=r.arms.flatMap(a=>Array.from({length:a==='a_rules'?1:r.repeats},(_,i)=>`${a}:${i}`));
  for(const arm of legNames) {
    const gateStats={evaluated:0,passed:0,adjusted:{stop_widened:0,target_fallback:0},blocked_by:{} as Record<string,number>};const trackGate=(gate:ReturnType<typeof evaluateOrderGate>)=>{gateStats.evaluated++;if(gate.ok)gateStats.passed++;for(const key of gate.blocked_by)gateStats.blocked_by[key]=(gateStats.blocked_by[key]??0)+1;return gate;};const trackFit=(e:ResearchEntry)=>{if(e.fit?.stop_source==='cost_floor')gateStats.adjusted.stop_widened++;if(e.fit?.target_source==='fallback_r')gateStats.adjusted.target_fallback++;return e;};
    // Fit (place-then-judge) only exists for requests whose frozen order_gate carries stop_floor; older manifests replay with the block-only gate they were recorded under.
    const fitEnabled=!!r.order_gate&&r.order_gate.stop_floor!==undefined,fixedR=fixedTargetR(ir,r.policy);
    // 结构口径:决策时刻的 ATR(14,Wilder,整段数据一次算好;第 i 根只依赖 ≤ i 的 bar,因果不变)给「止损太近不做」用;
    // 冻结了执行层阈值(execution_thresholds)时也算,给执行层的 ATR 止损下限用;两者都没有(旧口径)不算
    const execTh=r.order_gate?.execution_thresholds??null,tally=execTh?new ExecutionTally(execTh):null;
    const trackExec=(gate:ReturnType<typeof evaluateOrderGate>,at:number)=>{if(tally&&gate.execution)tally.add(d.symbol,at,gate.execution);return gate;};
    const atrAt=isStructureGate(r.order_gate)||execTh?(()=>{const s=atrSeries(d.bars,14);return (i:number)=>{const x=s[i];return x!==undefined&&Number.isFinite(x)?x:null;};})():null;
    const l=new SpotLedger(r.execution,{symbol:d.symbol,diagnostics:opts.diagnostics,order_gate:r.order_gate,fit:fitEnabled,onGate:trackGate,...(fast?{bar_path:'adaptive' as const}:{})}),decisions:ResearchDecision[]=[];let summary:string|null=null;let failures=0;
    l.mark(first);
    try {
      for(let i=start;i<=end;i++) {
        opts.check?.();const b=d.bars[i]!; const notices=l.step(b);
        // Pass only a fresh prefix across the decider boundary; future suffix never escapes.
        const bars=fast?src.slice(Math.max(0,i-W+1),i+1):clone(d.bars.slice(Math.max(0,i-4999),i+1));const ictx={bars,i:bars.length-1,timeframe_ms:d.timeframe_ms,series:src,series_i:i};
        // v4:A 臂持仓时不算候选(用不上);候选只依赖 ≤ i 的 bar,按 i 记忆给篮子腿复用
        const skip=fast&&!!l.position,signal=skip?null:ir&&!ir.compatibility?(memo?(memo.get('c'+i) as ReturnType<typeof irCandidate>|undefined)??(()=>{const x=irCandidate(ir,ictx,opts.legacyTargetAnchor);memo.set('c'+i,x);return x;})():irCandidate(ir,ictx,opts.legacyTargetAnchor)):null,rawCandidate=skip?null:signal?signal.entry:candidateAt(bars,r.policy),candidate=rawCandidate&&fitEnabled&&!l.position?trackFit(fitCandidate(rawCandidate,b.close,r.execution,r.order_gate!,fixedR)):rawCandidate;
        const p=l.position;
        const v:DecisionView={at:b.close_time,arm,symbol:d.symbol,timeframe_ms:d.timeframe_ms,bars:fast?[]:bars,policy:fast?r.policy:clone(r.policy),candidate:fast?candidate:clone(candidate),account:{cash:decimal(l.cash),equity:decimal(l.value(b.close))},position:p?{entry_at:p.entry_at,entry_price:decimal(p.entry_price),qty:decimal(p.qty),stop:decimal(p.stop),target:p.target===null?null:decimal(p.target),bars_held:p.bars_held}:null,previous_summary:summary,opens_today:l.opens_by_day.get(Math.floor(b.close_time/86400000))??0};
        if(ir&&!fast){v.strategy_ir=ir;if(!opts.legacy)v.htf_structure=htfStructure(ictx,ir.exit.find(x=>x.primitive==='structure_target')?.params??ir.risk.stop.params);v.trend=trendState(ictx,{...(ir.regime?.params??{}),htf:String(ir.regime?.params.htf??(d.timeframe_ms>14400000?`${d.timeframe_ms/60000}m`:'4h'))});}
        const pctx=p?{entry_at:p.entry_at,entry_price:Number(decimal(p.entry_price)),initial_distance:Number(decimal(p.initial_risk))/Number(decimal(p.qty)),bars_held:p.bars_held,high_water:Number(decimal(p.high_water??p.entry_price))}:null;
        const exitKey=memo&&p?`x${i}:${pctx!.entry_at}:${pctx!.entry_price}:${pctx!.initial_distance}:${pctx!.bars_held}:${pctx!.high_water}:${p.stop}`:'';
        const exit=ir&&p&&!ir.compatibility?(memo?.get(exitKey) as ReturnType<typeof irExit>|undefined)??(()=>{const x=irExit(ir,{...ictx,position:pctx!,fee_rate:Number(r.execution.fee_rate)},p,opts.legacy);memo?.set(exitKey,x);return x;})():null;
        if(exit?.stop){p!.stop=exit.stop;p!.stop_reason=exit.stop_reason;if(v.position)v.position.stop=decimal(exit.stop);}
        let action:AgentAction={action:'no_trade',reason:signal?.reason??'no_candidate',gate_errors:notices,evidence_refs:[]};
        const candidateGate=candidate&&r.order_gate&&!p?trackGate(trackExec(evaluateCandidate(candidate,b.close,v.account.cash,v.account.equity,r.execution,r.order_gate,false,...(atrAt?[atrAt(i)]:[])),b.close_time)):null;
        const last=i===end;
        if(last) action={...action,reason:'terminal_mark_no_new_decision'};
        else if(notices.some(x=>['min_rr','stop_too_tight','no_target','risk_cap','stop_side'].includes(x)))action={...action,action:'blocked',reason:'fill_order_gate',gate_errors:notices};
        else if(candidateGate&&!candidateGate.ok)action={...action,action:'blocked',reason:'order_gate',gate_errors:candidateGate.blocked_by};
        else if(exit?.reason)action={...action,action:'exit',reason:exit.reason};
        else if(p && (!ir||ir.compatibility) && p.bars_held>=r.policy.holding_bars) action={...action,action:'exit',reason:'holding_horizon'};
        else if(arm.startsWith('a_rules')) action=p?{...action,action:'hold',reason:'fixed_protection'}:candidate?{...action,action:'enter',reason:candidate.reason,entry:candidate}:action;
        else if((p||!signal||!['regime_filter','screen_filter'].includes(signal.reason))&&(arm.startsWith('b_agent') || candidate)) {
          const ih=hash(v); let out:AgentAction;
          if(cache){const recorded=cache.get(ih);if(!recorded || hash(recorded.input)!==ih)throw new Error('recorded_decision_missing_or_tampered');out=clone(recorded.output);}
          else out=await safeDecision(decide,v);

          const recording={input:clone(v),input_hash:ih,output:clone(out)};recording_bytes+=Buffer.byteLength(JSON.stringify(recording));
          if(recording_bytes>32*1024*1024)throw new StopRun('budget_exhausted','recording_byte_budget');
          recordings.push(recording);
          action=out;
          if(arm.startsWith('c_filter')) {
            // C's economic fields are unconditionally discarded, even for injected adapters.
            if(!['follow','skip','model_error'].includes(out.action)) action={action:'model_error',reason:'filter_contract_violation',gate_errors:['filter_only_follow_skip'],evidence_refs:[]};
            else action={...out,entry:undefined};
          }
          failures=action.action==='model_error'?failures+1:0;
          summary=out.reason.slice(0,1200);
        } else if(p) action={...action,action:'hold',reason:'fixed_protection'};
        const inputHash=fast?hash({at:v.at,arm,symbol:d.symbol,bars_digest:chain[i]!,view_from:bars[0]!.open_time,account:v.account,position:v.position,candidate:v.candidate??null,opens_today:v.opens_today}):hash(v);
        if(action.action==='enter' || action.action==='follow') {
          if(l.position){action={...action,gate_errors:[...action.gate_errors,'position_capacity']};}
          else {
            let entry=arm.startsWith('c_filter')?candidate:action.entry;
            if(entry){if(fitEnabled&&!entry.fit)entry=trackFit(fitCandidate(entry,b.close,r.execution,r.order_gate!));const gate=r.order_gate?trackGate(trackExec(evaluateCandidate(entry,b.close,v.account.cash,v.account.equity,r.execution,r.order_gate,false,...(atrAt?[atrAt(i)]:[])),b.close_time)):null;if(gate&&!gate.ok)action={...action,action:'blocked',reason:'order_gate',gate_errors:gate.blocked_by};else l.pending={action:'enter',entry:clone(entry),...(vt?{size_weight:volTargetWeight(d.bars,i,d.timeframe_ms,vt).weight.toFixed(8)}:{})};}
            else action={...action,action:'blocked',gate_errors:[...action.gate_errors,'missing_entry']};
          }
        } else if((action.action==='exit'||action.action==='reduce') && l.position) l.pending={action:action.action,reason:exit?.reason?exit.reason as import('@trade-gate/contracts').ResearchTrade['reason']:action.reason==='holding_horizon'?(r.execution.sizing_mode?'time':'horizon'):action.action==='reduce'?'agent_reduce':'agent_exit'};
        const row:ResearchDecision={id:`${arm}_${i}`,at:b.close_time,arm,candidate_id:candidate?.candidate_id??null,action:action.action,reason:action.reason,input_hash:inputHash,decision_hash:hash({...action,entry:action.entry??null}),evidence_refs:action.evidence_refs,gate_errors:action.gate_errors,...((action.entry??candidate)?.fit?{fit:(action.entry??candidate)!.fit}:{})};
        // 策略规范:B 臂 proposal(放置前的原始止损/止盈)违反了哪些条款;只对冻结了 spec_version 的 run 记录,旧 manifest 重放哈希不变。
        // 没冻结 order_gate 的只可能是旧 manifest(新 run 由 store 补缺省):按旧口径判,不随新缺省漂移。
        if(r.spec_version&&arm.startsWith('b_agent')&&action.entry)row.spec_violations=(checkProposalSpec(action.entry.fit?{stop:action.entry.fit.strategy_stop,target:action.entry.fit.strategy_target}:action.entry,b.close,r.execution,r.order_gate??LEGACY_ORDER_GATE).slice(0,20) as ResearchDecision['spec_violations']);
        decisions.push(row);
        if(failures>=5)throw new Error('consecutive_model_errors:5');
        opts.event?.('decision',{arm,at:b.close_time,action:row.action,candidate_id:row.candidate_id});
        // 按时间让出事件循环(每 20ms 至少一次):研究回测和交易同进程,重 IR(Pine/高周期结构)逐根很慢时不能堵住网关(2026-09-23 实测堵了 8 分钟,风控报组件过期 508 秒)
        if((i-start)%(fast?500:50)===0)opts.event?.('progress',{arm,done:i-start+1,total:end-start+1,equity:l.equity.at(-1)?.equity});
        if((i-start)%(fast?500:50)===0||performance.now()-lastYield>20){await new Promise<void>(resolve=>setImmediate(resolve));lastYield=performance.now();}
      }
    }catch(e){status=e instanceof StopRun?e.status:'failed';error=e instanceof Error?e.message:String(e);}
    // 执行层统计只在冻结了阈值时出现(条件展开):旧 manifest 的臂结果与结果哈希不变
    const armResult={arm,metrics:metrics(l),decisions,trades:l.trades,equity:l.equity,pending_at_end:!!l.pending,...(tally?{execution_gate:tally.stats()}:{})};
    arms.push(opts.diagnostics?{...armResult,diagnostics:diagnostics(armResult,[d],undefined,l.slippage,r.order_gate?gateStats:undefined)}:armResult);
    if(status!=='completed')break;
  }
  return {engine_version:fast?(isStructureGate(r.order_gate)?FAST_ENGINE_VERSION_STRUCTURE:FAST_ENGINE_VERSION):r.execution.sizing_mode||r.order_gate?(ir?'research-spot-ir-v3':'research-spot-next-open-v3'):ir?'research-spot-ir-v2':ENGINE_VERSION,status,error,arms,recordings,comparison:status==='completed'?compareArms(arms):[]};
}
