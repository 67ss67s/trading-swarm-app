import { hash } from '../primitives.js';
import { actualUsd, usdUnits, usdString } from '../judge/store.js';
import { evaluateG3FourRecorded, type G3FourArmFinalist } from './g3.js';
import { G3_ARMS, validateCollectionManifest, type G3Arm, type G3Collection, type G3CollectionManifest, type G3Opportunity } from './g3-collect.js';
const DAY=86400000;
export interface G3FilledOutcome { candidate_id:string;status?:'filled';entry_at:number;exit_at:number;marks:{at:number;net_return:number}[] }
export interface G3UnfilledOutcome { candidate_id:string;status:'not_filled';reason:'expired'|'invalidated'|'execution_rejected' }
export type G3Outcome=G3FilledOutcome|G3UnfilledOutcome;
/** 独立执行器逐候选导出成交路径或明确未成交；每个仍持仓的 UTC 日尾必须有净盯市点。 */
export interface G3Outcomes {
 manifest_hash:string; days:number[]; costs_included:true; execution_spec_hashes:Record<string,string>;
 finalists:Record<string,G3Outcome[]>;
}
export function analyzeG3(m:G3CollectionManifest,c:G3Collection,out:G3Outcomes) {
 validateCollectionManifest(m);
 if(c.version!=='g3_collection_result_v2'||typeof c.synthetic!=='boolean'||!!m.synthetic&&!c.synthetic)throw Error('g3_collection_mode_mismatch');
 if(c.manifest_hash!==hash(m)||out.manifest_hash!==c.manifest_hash||!c.complete||out.costs_included!==true)throw Error('g3_audit_or_collection_incomplete');
 if(!out.days.length||out.days.some((d,i)=>!Number.isSafeInteger(d)||d<0||d%DAY!==0||i>0&&d!==out.days[i-1]!+DAY))throw Error('g3_days_invalid');
 const allKeys=new Set<string>();
 for(const d of c.decisions){const key=`${d.finalist_id}:${d.candidate_id}:${d.arm}`;if(allKeys.has(key)||!G3_ARMS.includes(d.arm)||!['follow','skip'].includes(d.action))throw Error('g3_decisions_invalid');allKeys.add(key);if(d.cost_usd!==null)usdUnits(d.cost_usd);usdUnits(d.reserved_usd);}
 const expected=m.finalists.reduce((n,f)=>n+f.opportunities.length*4,0);if(c.decisions.length!==expected)throw Error('g3_decisions_missing');
 for(const f of m.finalists)for(const o of f.opportunities)for(const arm of G3_ARMS)if(!c.decisions.some(d=>d.finalist_id===f.id&&d.candidate_id===o.candidate.id&&d.arm===arm&&d.as_of===o.candidate.as_of))throw Error('g3_decisions_missing');
 const unavailable=(out as G3Outcomes & {unavailable?:{finalist_id:string;candidate_id:string;reason:string}[]}).unavailable??[];
 if(unavailable.length){
  for(const f of m.finalists){
   if(out.execution_spec_hashes[f.id]!==f.execution_spec_hash)throw Error('g3_execution_mismatch');
   const ids=[...(out.finalists[f.id]??[]).map(o=>o.candidate_id),...unavailable.filter(o=>o.finalist_id===f.id).map(o=>o.candidate_id)];
   if(ids.length!==f.opportunities.length||new Set(ids).size!==ids.length||f.opportunities.some(o=>!ids.includes(o.candidate.id)))throw Error('g3_outcomes_missing');
  }
  return {version:'g3_analysis_v2',manifest_hash:c.manifest_hash,synthetic:c.synthetic,collection_hash:hash(c),outcomes_hash:hash(out),arms:G3_ARMS,
   results:m.finalists.map(f=>({id:f.id,status:'insufficient_evidence',evidence:'execution_data_unavailable'})),accounts:[] as unknown[],records:[] as G3FourArmFinalist[],unavailable};
 }
 const records:G3FourArmFinalist[]=[],accounts:unknown[]=[];
 const unknown=c.decisions.some(d=>d.cost_usd===null);
 for(const f of m.finalists){
  if(out.execution_spec_hashes[f.id]!==f.execution_spec_hash)throw Error('g3_execution_mismatch');
  const outcomes=out.finalists[f.id];if(!outcomes||outcomes.length!==f.opportunities.length||new Set(outcomes.map(t=>t.candidate_id)).size!==outcomes.length)throw Error('g3_outcomes_missing');
  const ds=c.decisions.filter(d=>d.finalist_id===f.id);
  for(const o of f.opportunities){
   if(o.candidate.as_of<out.days[0]!||o.candidate.as_of>=out.days.at(-1)!+DAY)throw Error('g3_candidate_outside_grid');
   for(const arm of G3_ARMS)if(!ds.some(d=>d.candidate_id===o.candidate.id&&d.arm===arm&&d.as_of===o.candidate.as_of))throw Error('g3_decisions_missing');
   const t=outcomes.find(t=>t.candidate_id===o.candidate.id)!;
   if(!t)throw Error('g3_outcomes_missing');
   if(t.status==='not_filled'){
    if(!['expired','invalidated','execution_rejected'].includes(t.reason)||Object.keys(t).some(k=>!['candidate_id','status','reason'].includes(k)))throw Error('g3_unfilled_outcome_invalid');
    continue;
   }
   if(t.status!==undefined&&t.status!=='filled')throw Error('g3_outcome_status_invalid');
   if(![t.entry_at,t.exit_at].every(Number.isSafeInteger)||t.entry_at<o.candidate.as_of||t.exit_at<t.entry_at||t.exit_at>=out.days.at(-1)!+DAY||t.exit_at-t.entry_at>m.analysis.max_holding_days*DAY)throw Error('g3_trade_time_invalid');
   if(!t.marks.length||t.marks.at(-1)!.at!==t.exit_at||t.marks.some((p,i)=>!Number.isSafeInteger(p.at)||p.at<t.entry_at||p.at>t.exit_at||!Number.isFinite(p.net_return)||p.net_return< -1||i>0&&p.at<=t.marks[i-1]!.at))throw Error('g3_marks_invalid');
   for(const day of out.days){const end=day+DAY-1;if(t.entry_at<=end&&t.exit_at>end&&!t.marks.some(p=>p.at===end))throw Error('g3_daily_mtm_missing');}
  }
  const daily_returns={} as Record<G3Arm,number[]>;const costTotals={jev:0n,deepseek:0n};let follows=0;
  for(const arm of G3_ARMS){
   const rows=ds.filter(d=>d.arm===arm),charged=new Set<string>();
   const charges=rows.map(d=>{
    if(!d.request_hash||charged.has(d.request_hash))return {at:d.as_of,usd:0};charged.add(d.request_hash);
    // 同一请求跨 finalist 共享费用按 finalist 数等分；各臂原始费用总和只记一次。
    const owners=new Set(c.decisions.filter(x=>x.arm===arm&&x.request_hash===d.request_hash).map(x=>x.finalist_id)).size;
    const units=usdUnits(d.cost_usd??d.reserved_usd);if(arm==='jev'||arm==='deepseek')costTotals[arm]+=units/BigInt(owners);
    return{at:d.as_of,usd:Number(usdString(units))/owners};
   });
   const selected=f.opportunities.filter(o=>rows.find(d=>d.candidate_id===o.candidate.id)!.action==='follow');if(arm==='jev')follows=selected.length;
   const replay=replayAccount(selected,outcomes,out.days,charges,m.account);
   if(arm==='jev')follows=replay.trades;
   daily_returns[arm]=replay.returns;accounts.push({finalist_id:f.id,arm,...replay});
  }
  records.push({id:f.id,candidate_count:f.opportunities.length,follow_count:follows,days:out.days,daily_returns,...m.analysis,costs_included:true,jev_cost_usd:usdString(costTotals.jev),deepseek_cost_usd:usdString(costTotals.deepseek)});
 }
 const results=evaluateG3FourRecorded(records).map(r=>({...r,status:c.synthetic||unknown||!!(m as G3CollectionManifest & {export_audit?:unknown}).export_audit?'insufficient_evidence':r.status,...(unknown?{cost_warning:'unknown_cost_charged_at_reservation'}:{}),...(c.synthetic?{evidence:'offline_stub_only'}:(m as G3CollectionManifest & {export_audit?:unknown}).export_audit?{evidence:'selection_historical_replay_not_independent'}:{})}));
 return {version:'g3_analysis_v2',manifest_hash:c.manifest_hash,collection_hash:hash(c),outcomes_hash:hash(out),arms:G3_ARMS,synthetic:c.synthetic,results,accounts,records,
  boundary:'四臂 v2；cash/matched_random 未采集；条件执行路径必须由相同冻结执行器生成，分析器不独立证明供应商数据或成交正确。'};
}
function replayAccount(opportunities:G3Opportunity[],outcomes:G3Outcomes['finalists'][string],days:number[],charges:{at:number;usd:number}[],config:G3CollectionManifest['account']) {
 let cash=Number(config.initial_usd),previous=cash,trades=0,capacity_skips=0;
 const open:{id:string;symbol:string;notional:number;exit_at:number;marks:{at:number;net_return:number}[]}[]=[],equity:{at:number;equity_usd:string}[]=[],returns:number[]=[];
 const selected=opportunities.map(o=>({o,t:outcomes.find(t=>t.candidate_id===o.candidate.id)!}));
 const no_fills=selected.filter(x=>x.t.status==='not_filled').length;
 const entries=selected.filter((x):x is {o:G3Opportunity;t:G3FilledOutcome}=>x.t.status!=='not_filled').sort((a,b)=>a.t.entry_at-b.t.entry_at||a.o.candidate.symbol.localeCompare(b.o.candidate.symbol)||a.o.candidate.id.localeCompare(b.o.candidate.id));
 let ei=0,ci=0;charges.sort((a,b)=>a.at-b.at);
 const settle=(at:number)=>{for(const p of [...open].sort((a,b)=>a.exit_at-b.exit_at))if(p.exit_at<=at){cash+=p.notional*p.marks.at(-1)!.net_return;open.splice(open.indexOf(p),1);}};
 for(const day of days){const end=day+DAY-1;
  while((entries[ei]?.t.entry_at??Infinity)<=end||(charges[ci]?.at??Infinity)<=end){
   const next=entries[ei],charge=charges[ci];
   if((charge?.at??Infinity)<=(next?.t.entry_at??Infinity)){settle(charge!.at);cash-=charge!.usd;ci++;continue;}
   settle(next!.t.entry_at);const {o,t}=next!;ei++;
   const entry=Number(o.candidate.entry),stop=Number(o.candidate.stop),distance=Math.abs(entry-stop)/entry;
   if(!(entry>0&&stop>0&&distance>0&&cash>0)) {capacity_skips++;continue;}
   const notional=Math.min(cash,cash*config.risk_fraction/distance);
   if(open.length>=config.max_open||open.some(p=>p.symbol===o.candidate.symbol)||open.reduce((s,p)=>s+p.notional,0)+notional>cash*config.gross_cap){capacity_skips++;continue;}
   open.push({id:o.candidate.id,symbol:o.candidate.symbol,notional,exit_at:t.exit_at,marks:t.marks});trades++;
  }
  settle(end);const eq=cash+open.reduce((s,p)=>s+p.notional*p.marks.find(p=>p.at===end)!.net_return,0);
  if(eq<0||!Number.isFinite(eq))throw Error('g3_account_insolvent');returns.push(previous>0?eq/previous-1:0);previous=eq;equity.push({at:end,equity_usd:actualUsd(eq)});
 }
 return {returns,equity,trades,capacity_skips,no_fills,sizing_basis:'realized_equity',valuation:'daily_net_mtm'};
}
