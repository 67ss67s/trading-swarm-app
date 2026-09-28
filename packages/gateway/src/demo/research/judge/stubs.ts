/** 离线评测用四类判断桩，无凭证、无网络。名称不可冒充真实 Jev。 */
import type { StrategyJudge } from '@trade-gate/contracts';
import type { DecisionAnswer } from '../../decisions.js';
import { hash } from '../primitives.js';
import type { DecisionProvider, FrozenModelProfile } from './types.js';
export type JudgeStubKind = 'deterministic' | 'random' | 'all_skip' | 'boundary_drift';
export function stubProfile(kind: JudgeStubKind, seed = 1): FrozenModelProfile {
  return {ref:`stub:${kind}:${seed}`,connection_id:'offline_stub',connection_revision:'v1',model:`stub/${kind}`,model_revision:`stub_v1_seed_${seed}`,routing:'offline_stub',parser_version:'judge_answers_v1',max_call_usd:'0',retry_policy:'none'};
}
export function stubJudgeSpec(profile = stubProfile('deterministic')): StrategyJudge {
  return {version:1,engine:'jev',model_profile_ref:profile.ref,state_schema_version:'judge_state_v1',questions:[{key:'take',type:'noul',instructions:'按已知趋势和风险几何判断是否跟随；不预测未来标签。',criteria:['候选与趋势一致','风险或趋势不适合'],state_fields:['candidate.direction','candidate.stop_distance_atr','candidate.reward_risk','features.trend','features.volatility','features.volume_ratio']}],rule:{all:[{question_key:'take',label:'yes',operator:'gte',threshold:0.6,margin:0.05}]},on_uncertain:'skip',on_error:'skip',timeout_ms:1000,max_attempts:1};
}
export function stubProvider(kind: JudgeStubKind, seed = 1): DecisionProvider & { calls: number; requests: unknown[] } {
  const profile=stubProfile(kind,seed);
  const provider: DecisionProvider & {calls:number;requests:unknown[]} = {profile,calls:0,requests:[],async decide(req) {
    provider.calls++; provider.requests.push(structuredClone(req));
    const u=parseInt(hash({state:req.state,seed}).slice(0,8),16)/2**32;
    const c=req.state.candidate as {direction?:string}|undefined, f=req.state.features as {trend?:string}|undefined;
    const p=kind==='all_skip'?0:kind==='random'?u:kind==='boundary_drift'?0.6+(provider.calls%2?0.02:-0.02):(c?.direction==='long'?f?.trend==='up':f?.trend==='down')?0.85:0.1;
    const answers:Record<string,DecisionAnswer>={};
    for (const [key,q] of Object.entries(req.questions)) {
      if(q.type==='noul') answers[key]={type:'noul',noul:p};
      else { const labels=q.type==='score'?q.criteria.map((_,i)=>String(i)):Object.keys(q.criteria), probabilities=Object.fromEntries(labels.map((l,i)=>[l,i===0?p:(1-p)/(labels.length-1)]));
        answers[key]=q.type==='choice'?{type:'choice',choice:labels[0]!,confidence:p,probabilities}:{type:'score',score:0,confidence:p,probabilities}; }
    }
    return {model:profile.model,answers,usage:{input_tokens:0,cost_usd:0},latency_ms:0,provider_request_id:`stub_${provider.calls}`};
  }};
  return provider;
}
