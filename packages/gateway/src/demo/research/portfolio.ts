import {candidateGate as evaluateCandidate,fitCandidate,fixedTargetR} from './candidate-gate.js';
import {htfStructure} from './primitives/structure.js';
import { evaluateOrderGate } from './order-gate.js';
import { ExecutionTally } from './execution-gate.js';
import { atrSeries } from './primitives/indicators.js';
import { diagnostics } from './diagnostics.js';
import { resolveRequest,irCandidate,irExit } from './strategy.js';
import type { ResearchEntry, ResearchBar, ResearchDataset, ResearchRequest, ResearchUniverse, ResearchArmResult, ResearchDecision } from '@trade-gate/contracts';
import { SpotLedger } from './ledger.js';
import { candidateAt, compareArms, metrics, safeDecision, StopRun, type Decider, type DecisionView, type RecordedDecision, type RunResult } from './engine.js';
import { clone, decimal, hash, min, mul, q } from './primitives.js';
import { screenUniverse } from './screen.js';
export const PORTFOLIO_ENGINE_VERSION='research-spot-portfolio-v2';
export interface PortfolioInput {universe:ResearchUniverse;datasets:ResearchDataset[]}
export async function runPortfolio(input:PortfolioInput,raw:ResearchRequest,decide:Decider,opts:{legacy?:boolean;legacyTargetAnchor?:boolean;diagnostics?:boolean;check?:()=>void;event?:(event:string,data:Record<string,unknown>)=>void;replay?:RecordedDecision[]}={}):Promise<RunResult> {
  const r=resolveRequest(raw),ir=r.strategy_ir;
  const {universe:u,datasets}=input,symbols=u.members.map(m=>m.symbol),maps=new Map(datasets.map(d=>[d.symbol,new Map(d.bars.map(b=>[b.close_time,b]))]));
  const timeline=Array.from({length:Math.floor((r.to_ms-r.from_ms)/u.timeframe_ms)+1},(_,i)=>r.from_ms+i*u.timeframe_ms),aligned=new Set(u.aligned_close_times);
  const screens=new Map<number,ReturnType<typeof screenUniverse>>(),recordings:RecordedDecision[]=[],arms:ResearchArmResult[]=[],cache=opts.replay?new Map(opts.replay.map(v=>[v.input_hash,v])):null;
  const shortlistRows=r.shortlist?screenUniverse(u,datasets,{as_of:r.from_ms}).rows.filter(row=>row.rank).sort((a,b)=>a.rank![r.shortlist!.by]-b.rank![r.shortlist!.by]||a.symbol.localeCompare(b.symbol)).slice(0,r.shortlist.top_n):null,shortlist=shortlistRows?new Set(shortlistRows.map(row=>row.symbol)):null;
  let bytes=0,status:RunResult['status']='completed',error:string|null=null;
  // 执行层(冻结了 execution_thresholds 才有):决策时刻 ATR(14,Wilder)按数据集整段一次算好、按 close_time 取(只依赖 ≤ 当根的 bar)。
  // 只在有阈值时给 atr:旧 manifest(含结构口径)这里从来没传过 atr,传了会让 stop_too_close 开始生效、重放哈希变。
  const execTh=r.order_gate?.execution_thresholds??null,atrBy=execTh?new Map(datasets.map(d=>{const s=atrSeries(d.bars,14);return [d.symbol,new Map(d.bars.map((b,i)=>[b.close_time,s[i]]))] as const;})):null;
  const atrOf=(s:string,at:number):[number|null]|[]=>{if(!atrBy)return [];const x=atrBy.get(s)?.get(at);return [x!==undefined&&Number.isFinite(x)?x:null];};
  for(const arm of r.arms.flatMap(a=>Array.from({length:a==='a_rules'?1:r.repeats},(_,i)=>`${a}:${i}`))){
    const gateStats={evaluated:0,passed:0,adjusted:{stop_widened:0,target_fallback:0},blocked_by:{} as Record<string,number>};const trackGate=(gate:ReturnType<typeof evaluateOrderGate>)=>{gateStats.evaluated++;if(gate.ok)gateStats.passed++;for(const key of gate.blocked_by)gateStats.blocked_by[key]=(gateStats.blocked_by[key]??0)+1;return gate;};const trackFit=(e:ResearchEntry)=>{if(e.fit?.stop_source==='cost_floor')gateStats.adjusted.stop_widened++;if(e.fit?.target_source==='fallback_r')gateStats.adjusted.target_fallback++;return e;};
    const fitEnabled=!!r.order_gate&&r.order_gate.stop_floor!==undefined,fixedR=fixedTargetR(ir,r.policy);const ledgers=new Map(symbols.map(s=>[s,new SpotLedger(r.execution,{symbol:s,diagnostics:opts.diagnostics,order_gate:r.order_gate,fit:fitEnabled,onGate:trackGate})])),account=new SpotLedger(r.execution),decisions:ResearchDecision[]=[],summaries=new Map<string,string>(),ranks=new Map<string,number>(),days=new Map<number,number>();
    let failures=0;const tally=execTh?new ExecutionTally(execTh):null;
    const trackExec=(gate:ReturnType<typeof evaluateOrderGate>,s:string,at:number)=>{if(tally&&gate.execution)tally.add(s,at,gate.execution);return gate;};
    const count=()=>[...ledgers.values()].filter(l=>l.position).length;
    const holdings=(at:number,field:'open'|'close')=>Object.fromEntries(symbols.map(s=>{const p=ledgers.get(s)!.position,b=maps.get(s)!.get(at);if(p&&!b)throw new Error(`missing_position_mark:${s}:${at}`);return [s,p?mul(p.qty,q(b![field])):0n];}));
    const mark=(at:number,initial=false)=>{const by=initial?Object.fromEntries(symbols.map(s=>[s,0n])):holdings(at,'close'),held=Object.values(by).reduce((a,b)=>a+b,0n),value=account.cash+held;account.peak=account.peak>value?account.peak:value;account.equity.push({at,cash:decimal(account.cash),holdings:decimal(held),equity:decimal(value),exposure:value>0n?Number(held)/Number(value):0,drawdown:1-Number(value)/Number(account.peak),by_symbol:Object.fromEntries(Object.entries(by).map(([s,v])=>[s,decimal(v)]))});};
    mark(r.from_ms-1,true);
    try{for(const at of timeline){
      opts.check?.();
      const missingDecision=(symbol:string,reason:string,candidate_id:string|null)=>{const input_hash=hash({at,arm,symbol,missing:true,reason});decisions.push({id:`${arm}_${symbol}_${at}_missing`,at,arm,symbol,candidate_id,action:'blocked',reason,input_hash,decision_hash:hash({action:'blocked',reason}),gate_errors:[reason],evidence_refs:[]});};
      // Preflight the whole clock tick before any asset can mutate cash or fill an order.
      for(const s of symbols)if(ledgers.get(s)!.position&&!maps.get(s)!.has(at)){missingDecision(s,'missing_position_bar',ledgers.get(s)!.position!.candidate_id);throw new Error(`missing_position_bar:${s}:${at}`);}
      const notices=new Map(symbols.map(s=>[s,[] as string[]]));
      const saved=new Map([...ledgers].map(([s,l])=>[s,l.pending]));
      // All protective open gaps, then active exits, then ranked entries, then all intrabar ranges.
      for(const s of symbols){const l=ledgers.get(s)!,b=maps.get(s)!.get(at);l.pending=null;if(!b){const pending=saved.get(s);if(pending){notices.get(s)!.push('missing_next_bar_cancelled');missingDecision(s,'missing_next_bar_cancelled',pending.action==='enter'?pending.entry.candidate_id:null);}saved.set(s,null);continue;}l.cash=account.cash;l.stepOpen(b);account.cash=l.cash;}
      for(const s of symbols){const l=ledgers.get(s)!,b=maps.get(s)!.get(at),pending=saved.get(s);if(b&&pending&&pending.action!=='enter'){l.cash=account.cash;l.pending=pending;l.stepOpen(b);account.cash=l.cash;}}
      for(const s of [...symbols].sort((a,b)=>(ranks.get(a)??Infinity)-(ranks.get(b)??Infinity)||a.localeCompare(b))){
        const l=ledgers.get(s)!,b=maps.get(s)!.get(at),pending=saved.get(s);if(!b||pending?.action!=='enter')continue;
        if(count()>=(r.execution.max_positions??3)){notices.get(s)!.push('max_positions');continue;}
        const by=holdings(at,'open'),held=Object.values(by).reduce((a,b)=>a+b,0n),equity=account.cash+held,max=r.execution.sizing_mode==='unit_notional'?equity:mul(equity,q(r.execution.max_allocation)),remaining=max>held?max-held:0n;
        const cap=(r.execution.sizing_mode==='unit_notional'||r.execution.allocation==='equal_notional')?min(remaining,max/BigInt(r.execution.max_positions??3)):remaining;
        const budget=r.execution.allocation==='equal_notional'?equity:mul(equity,q(r.execution.risk_fraction));
        const day=Math.floor(b.open_time/86400000);l.opens_by_day.set(day,days.get(day)??0);l.cash=account.cash;l.pending=pending;
        notices.get(s)!.push(...l.stepOpen(b,{risk_budget:budget,notional_cap:cap,equity}));account.cash=l.cash;days.set(day,l.opens_by_day.get(day)??0);
        if(l.position&&!l.position.id.startsWith(`${s}_`))l.position.id=`${s}_${l.position.id}`;
      }
      for(const s of symbols){const l=ledgers.get(s)!,b=maps.get(s)!.get(at);if(b){l.cash=account.cash;l.stepIntrabar(b);account.cash=l.cash;}}
      // Every held asset has a real mark here; an absent unheld asset contributes exactly zero.
      mark(at);
      if(!aligned.has(at))continue;
      let screen=screens.get(at);if(!screen){screen=screenUniverse(u,datasets,{as_of:at,legacy:opts.legacy});screens.set(at,screen);}
      for(const row of screen.rows)ranks.set(row.symbol,row.rank?.composite??Infinity);
      const entries:{symbol:string;entry:import('./ledger.js').Entry|null;action:import('./engine.js').AgentAction;index:number}[]=[];
      for(const s of [...symbols].sort((a,b)=>ranks.get(a)!-ranks.get(b)!||a.localeCompare(b))){
        const l=ledgers.get(s)!,d=datasets.find(d=>d.symbol===s)!,b=maps.get(s)!.get(at)!,screenRow=screen.rows.find(row=>row.symbol===s)!;
        let bars=d.bars.filter(b=>b.close_time<=at&&b.available_at<=at).slice(-5000);let gap=0;for(let i=1;i<bars.length;i++)if(bars[i]!.open_time!==bars[i-1]!.open_time+u.timeframe_ms)gap=i;bars=bars.slice(gap);
        const ictx={bars,i:bars.length-1,timeframe_ms:u.timeframe_ms,screen:screenRow},signal=ir&&!ir.compatibility?irCandidate(ir,ictx,opts.legacyTargetAnchor):null,base=signal?signal.entry:candidateAt(bars,r.policy),fitted=base&&fitEnabled&&!l.position?trackFit(fitCandidate(base,b.close,r.execution,r.order_gate!,fixedR)):base,candidate=fitted?{...fitted,candidate_id:`${s}_${fitted.candidate_id}`,screen_rank:screenRow.rank?.composite??null}:null,p=l.position;
        const v:DecisionView={at,arm,symbol:s,timeframe_ms:u.timeframe_ms,bars:clone(bars),policy:clone(r.policy),candidate,account:{cash:decimal(account.cash),equity:account.equity.at(-1)!.equity},position:p?{entry_at:p.entry_at,entry_price:decimal(p.entry_price),qty:decimal(p.qty),stop:decimal(p.stop),target:p.target===null?null:decimal(p.target),bars_held:p.bars_held}:null,previous_summary:summaries.get(s)??null,opens_today:days.get(Math.floor(at/86400000))??0,screen:screenRow,trend:screenRow.trend,portfolio:Object.entries(account.equity.at(-1)!.by_symbol!).map(([symbol,holdings])=>({symbol,holdings}))};
        if(ir){v.strategy_ir=ir;if(!opts.legacy)v.htf_structure=htfStructure(ictx,ir.exit.find(x=>x.primitive==='structure_target')?.params??ir.risk.stop.params);}
        const exit=ir&&p&&!ir.compatibility?irExit(ir,{...ictx,position:{entry_at:p.entry_at,entry_price:Number(decimal(p.entry_price)),initial_distance:Number(decimal(p.initial_risk))/Number(decimal(p.qty)),bars_held:p.bars_held,high_water:Number(decimal(p.high_water??p.entry_price))},fee_rate:Number(r.execution.fee_rate)},p,opts.legacy):null;
        if(exit?.stop){p!.stop=exit.stop;p!.stop_reason=exit.stop_reason;if(v.position)v.position.stop=decimal(exit.stop);}
        let action={action:'no_trade',reason:signal?.reason??'no_candidate',gate_errors:notices.get(s)!,evidence_refs:[]} as Awaited<ReturnType<Decider>>;
        const candidateGate=candidate&&r.order_gate&&!p?trackGate(trackExec(evaluateCandidate(candidate,b.close,v.account.cash,v.account.equity,r.execution,r.order_gate,true,...atrOf(s,at)),s,at)):null;
        if(at===r.to_ms)action.reason='terminal_mark_no_new_decision';
        else if(!p&&u.eligibility&&!u.eligibility[s]?.eligible_close_times.includes(at))action={...action,action:'blocked',reason:'not_listed_at_bar',gate_errors:['not_listed_at_bar']};
        else if(!p&&!arm.startsWith('a_rules')&&shortlist&&!shortlist.has(s))action={...action,reason:'outside_shortlist'};
        else if(notices.get(s)!.some(x=>['min_rr','stop_too_tight','no_target','risk_cap','stop_side'].includes(x)))action={...action,action:'blocked',reason:'fill_order_gate',gate_errors:notices.get(s)!};
        else if(candidateGate&&!candidateGate.ok)action={...action,action:'blocked',reason:'order_gate',gate_errors:candidateGate.blocked_by};
        else if(exit?.reason)action={...action,action:'exit',reason:exit.reason};
        else if(p&&(!ir||ir.compatibility)&&p.bars_held>=r.policy.holding_bars)action={...action,action:'exit',reason:'holding_horizon'};
        else if(arm.startsWith('a_rules'))action=p?{...action,action:'hold',reason:'fixed_protection'}:candidate?{...action,action:'enter',reason:candidate.reason,entry:candidate}:action;
        else if((p||!signal||!['regime_filter','screen_filter'].includes(signal.reason))&&(arm.startsWith('b_agent')||candidate)){
          const ih=hash(v);if(cache){const old=cache.get(ih);if(!old||hash(old.input)!==ih)throw new Error('recorded_decision_missing_or_tampered');action=clone(old.output);}else action=await safeDecision(decide,v);
          const record={input:clone(v),input_hash:ih,output:clone(action)};bytes+=Buffer.byteLength(JSON.stringify(record));if(bytes>33554432)throw new StopRun('budget_exhausted','recording_byte_budget');recordings.push(record);
          summaries.set(s,action.reason.slice(0,1200));
          if(arm.startsWith('c_filter'))action=['follow','skip','model_error'].includes(action.action)?{...action,entry:undefined}:{action:'model_error',reason:'filter_contract_violation',gate_errors:['filter_only_follow_skip'],evidence_refs:[]};
        }
        if(!arm.startsWith('a_rules')&&(arm.startsWith('b_agent')||candidate)&&at!==r.to_ms&&!(p&&p.bars_held>=r.policy.holding_bars))failures=action.action==='model_error'?failures+1:0;
        if(action.action==='enter'||action.action==='follow'){
          const entry=arm.startsWith('c_filter')?candidate:action.entry&&fitEnabled&&!action.entry.fit?trackFit(fitCandidate(action.entry,b.close,r.execution,r.order_gate!)):action.entry;
          const gate=entry&&r.order_gate?trackGate(trackExec(evaluateCandidate(entry,b.close,v.account.cash,v.account.equity,r.execution,r.order_gate,true,...atrOf(s,at)),s,at)):null;
          if(gate&&!gate.ok)action={...action,action:'blocked',reason:'order_gate',gate_errors:gate.blocked_by};
          else entries.push({symbol:s,entry:entry??null,action:clone(action),index:decisions.length});
        }else if(p&&(action.action==='exit'||action.action==='reduce'))l.pending={action:action.action,reason:exit?.reason?exit.reason as import('@trade-gate/contracts').ResearchTrade['reason']:action.reason==='holding_horizon'?(r.execution.sizing_mode?'time':'horizon'):action.action==='reduce'?'agent_reduce':'agent_exit'};
        decisions.push({id:`${arm}_${s}_${at}`,at,arm,symbol:s,screen_rank:screenRow.rank?.composite??null,candidate_id:candidate?.candidate_id??null,action:action.action,reason:action.reason,input_hash:hash(v),decision_hash:hash({...action,entry:action.entry??null}),gate_errors:action.gate_errors,evidence_refs:action.evidence_refs,...((action.entry??candidate)?.fit?{fit:(action.entry??candidate)!.fit}:{})});
        if(failures>=5)throw new Error('consecutive_model_errors:5');
      }
      for(const item of entries){
        const l=ledgers.get(item.symbol)!,reserved=[...ledgers.values()].filter(x=>(x.position&&x.pending?.action!=='exit')||x.pending?.action==='enter').length;
        let gate:string|null=null;
        if(l.position||reserved>=(r.execution.max_positions??3))gate='max_positions';else if(!item.entry)gate='missing_entry';
        if(gate){const row=decisions[item.index]!,action={...item.action,action:'blocked' as const,gate_errors:[...item.action.gate_errors,gate]};row.action=action.action;row.gate_errors=action.gate_errors;row.decision_hash=hash({...action,entry:action.entry??null});}
        else l.pending={action:'enter',entry:clone(item.entry!)};
      }
      if(decisions.length%(symbols.length*50)===0){opts.event?.('progress',{arm,done:timeline.indexOf(at)+1,total:timeline.length,equity:account.equity.at(-1)!.equity});await new Promise<void>(resolve=>setImmediate(resolve));}
    }}catch(e){status=e instanceof StopRun?e.status:'failed';error=e instanceof Error?e.message:String(e);}
    for(const [s,l]of ledgers){account.trades.push(...l.trades.map(t=>({...t,symbol:s})));account.turnover+=l.turnover;account.fees+=l.fees;account.slippage+=l.slippage;}
    const openIds=new Set([...ledgers.values()].flatMap(l=>l.position?[l.position.id]:[]));account.position=[...ledgers.values()].find(l=>l.position)?.position??null;
    const resultMetrics=metrics(account,openIds),last=account.equity.at(-1)!;
    const by_symbol=symbols.map(s=>{const l=ledgers.get(s)!,realized=l.trades.reduce((a,t)=>a+q(t.net_pnl),0n),p=l.position,unrealized=p?q(last.by_symbol![s]!)-p.entry_notional-p.entry_fee:0n,net=realized+unrealized,m=metrics(l);return {symbol:s,closed_trades:m.closed_trades,net_pnl:decimal(net),win_rate:m.win_rate,avg_net_r:m.avg_net_r,contribution:q(resultMetrics.net_pnl)!==0n?Number(net)/Number(q(resultMetrics.net_pnl)):null};});
    const armResult={arm,metrics:resultMetrics,decisions,trades:account.trades,equity:account.equity,pending_at_end:[...ledgers.values()].some(l=>!!l.pending),by_symbol,...(tally?{execution_gate:tally.stats()}:{})};
    arms.push(opts.diagnostics?{...armResult,diagnostics:diagnostics(armResult,datasets,u,account.slippage,r.order_gate?gateStats:undefined)}:armResult);if(status!=='completed')break;
  }
  return {engine_version:r.execution.sizing_mode||r.order_gate?'research-spot-portfolio-v3':PORTFOLIO_ENGINE_VERSION,status,error,arms,recordings,comparison:status==='completed'?compareArms(arms):[]};
}
