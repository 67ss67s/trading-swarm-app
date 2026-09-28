import { resolveRequest } from './strategy.js';
/** Decision-level counterfactuals. These labels are created AFTER replay and never reach a decider. */
import type { ResearchDataset, ResearchRequest } from '@trade-gate/contracts';
import { candidateAt, type RunResult } from './engine.js';
import { SpotLedger } from './ledger.js';
import { bootstrapCI } from '../replay-stats.js';
export interface CandidateLabel {candidate_id:string;at:number;net_r:number|null;status:'settled'|'insufficient_future'|'unfilled';}
export function candidateLabels(d:ResearchDataset,raw:ResearchRequest):CandidateLabel[] {
  const r=resolveRequest(raw);
  const labels:CandidateLabel[]=[];const end=d.bars.findIndex(b=>b.close_time===r.to_ms);
  for(let i=0;i<end;i++) {
    const b=d.bars[i]!;if(b.close_time<r.from_ms)continue;
    const c=candidateAt(d.bars.slice(Math.max(0,i-4999),i+1),r.policy);if(!c)continue;
    const base={candidate_id:c.candidate_id,at:b.close_time,net_r:null};
    // Eligibility uses a fixed maximum label horizon, independent of whether a trade wins early.
    if(i+r.policy.holding_bars+1>end){labels.push({...base,status:'insufficient_future'});continue;}
    const l=new SpotLedger(r.execution);l.pending={action:'enter',entry:c};
    for(let j=i+1;j<=i+r.policy.holding_bars+1;j++) {
      l.step(d.bars[j]!);
      if(!l.position)break;
      if(l.position.bars_held>=r.policy.holding_bars)l.pending={action:'exit',reason:'horizon'};
    }
    labels.push({...base,net_r:l.trades[0]?.net_r??null,status:l.trades.length?'settled':'unfilled'});
  }
  return labels;
}
export function selectionEvaluation(d:ResearchDataset,r:ResearchRequest,result:RunResult) {
  const labels=candidateLabels(d,r),byId=new Map(labels.map(l=>[l.candidate_id,l]));
  const filterArms=result.arms.filter(a=>a.arm.startsWith('c_filter'));
  const controls=filterArms.map(arm=>{
    const rows=arm.decisions.filter(a=>a.candidate_id&&['follow','skip'].includes(a.action)).flatMap(a=>{const l=byId.get(a.candidate_id!);return l?.net_r!==null&&l?.net_r!==undefined?[{action:a.action,net_r:l.net_r,candidate_id:l.candidate_id}]:[];});
    const followed=rows.filter(a=>a.action==='follow'),skipped=rows.filter(a=>a.action==='skip');
    const avg=(v:{net_r:number}[])=>v.length?v.reduce((s,x)=>s+x.net_r,0)/v.length:null;
    const followedSum=followed.reduce((s,x)=>s+x.net_r,0);
    let seed=0x98765;const random=()=>{seed=(Math.imul(1664525,seed)+1013904223)>>>0;return seed/4294967296;};
    const nullSums:number[]=[];
    if(rows.length>=30&&followed.length>0&&skipped.length>0)for(let n=0;n<2000;n++){const v=rows.map(x=>x.net_r);for(let j=v.length-1;j>0;j--){const k=Math.floor(random()*(j+1));[v[j],v[k]]=[v[k]!,v[j]!];}nullSums.push(v.slice(0,followed.length).reduce((a,b)=>a+b,0));}
    nullSums.sort((a,b)=>a-b);
    return {arm:arm.arm,eligible_candidates:rows.length,followed:followed.length,skipped:skipped.length,follow_avg_net_r:avg(followed),skip_avg_net_r:avg(skipped),all_avg_net_r:avg(rows),follow_ci:bootstrapCI(followed.map(x=>x.net_r)),matched_participation:{status:nullSums.length?'exploratory':'insufficient',random_sum_r_p025:nullSums[Math.floor(nullSums.length*.025)]??null,random_sum_r_p975:nullSums[Math.floor(nullSums.length*.975)]??null,actual_follow_sum_r:followedSum,one_sided_tail_fraction:nullSums.length?(1+nullSums.filter(x=>x>=followedSum).length)/(1+nullSums.length):null},note:'Independent opportunity outcomes; same participation count; random control is not time/regime matched and is not portfolio PnL or causal proof.'};
  });
  const pairs=filterArms.slice(1).map(b=>{const a=new Map(filterArms[0]!.decisions.filter(x=>x.candidate_id).map(x=>[x.candidate_id,x.action]));let n=0,agree=0;for(const x of b.decisions){const y=x.candidate_id?a.get(x.candidate_id):undefined;if(y&&['follow','skip'].includes(y)&&['follow','skip'].includes(x.action)){n++;if(y===x.action)agree++;}}return {arm:b.arm,paired_candidates:n,agreement:n?agree/n:null};});
  return {labels,filter_controls:controls,repeat_agreement:pairs,scope:'post_run_candidate_labels_only',economic_evidence:d.venue==='synthetic'?'synthetic_only':'historical_simulation_not_forward_validation',model_weight_leakage:'not_eliminated_by_input_time_cutoff',promotion:'not_authorized',trial_count_note:'Study counts failed and cancelled trials; cross-study search remains user-declared.'};
}
