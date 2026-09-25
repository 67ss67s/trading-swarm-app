import { it,expect } from 'vitest';
import { JevDecisionClient } from '../../../../src/demo/decisions.js';
import { judgeCandidate,normalizeAnswers,fromDecisionClient } from '../../../../src/demo/research/judge/index.js';
import { judgeFixture } from './fixtures.js';
import { judgeDiagnostics } from '../../../../src/demo/research/judge/diagnostics.js';
it('v1 不放宽；v2 接受 0.99/1.01 并归一，拒绝更大偏差',()=>{
 const f=judgeFixture();try {
 const spec={...f.spec,questions:[{key:'quality',type:'score' as const,instructions:'quality',criteria:['poor','good'],labels:['poor','good'],state_fields:['features.trend' as const]}]};
 for(const n of [0.79,0.81]){const raw={quality:{type:'score',score:1,confidence:0.8,probabilities:{0:0.2,1:n}}};expect(()=>normalizeAnswers(spec,raw)).toThrow('sum');const a=normalizeAnswers(spec,raw,'judge_answers_v2_rounding_001');expect(Object.values(a[0]!.probabilities).reduce((s,p)=>s+p,0)).toBeCloseTo(1,12);}
 expect(()=>normalizeAnswers(spec,{quality:{type:'score',score:1,confidence:0.8,probabilities:{0:0.2,1:0.82}}},'judge_answers_v2_rounding_001')).toThrow('sum');
 }finally{f.state.close();}
});
it.each([200,500])('HTTP %s 坏答案费用仍结算，原文与 request id 留存且不重复调用',async status=>{
 const f=judgeFixture();let calls=0;try{
 f.provider.profile.max_call_usd='0.001';
 const client=new JevDecisionClient({api_key:'redacted-test-key',model:f.provider.profile.model,maxRetries:0,fetchFn:async()=>{calls++;return new Response(JSON.stringify({id:'req_1',model:f.provider.profile.model,answers:{take:{type:'noul'}},usage:{cost:'0.000027',input_tokens:9}}),{status});}});
 const runtime={...f.runtime,provider:fromDecisionClient(client,f.provider.profile)};
 const result=await judgeCandidate(f.input,runtime);expect(result.status).toBe('error');expect(result.cost_usd).toBe('0.000027');expect(client.spentToday()).toBeCloseTo(0.000027);expect(result.raw_response_ref).toBeTruthy();expect(f.budget.view().reserved_usd).toBe('0');expect(f.store.response(result.request_hash)?.raw_json).toContain('req_1');expect(judgeDiagnostics(f.store).unknown_cost).toEqual([]);
 await judgeCandidate(f.input,runtime);expect(calls).toBe(1);
 }finally{f.state.close();}
});
it('偏差审计导出原始分布/ref并统计小偏差与大偏差，不先归一',()=>{
 const f=judgeFixture();try{
 for(const [i,p] of [0.79,0.81,0.9].entries()){
  const key=`audit_${i}`;f.store.claim(key,{},f.budget,'0');
  f.store.finish(key,{model:'stub',answers:{quality:{type:'score',score:1,confidence:p,probabilities:{'0':0.2,'1':p}}},usage:{input_tokens:1,cost_usd:0},latency_ms:0},null);
 }
 const report=judgeDiagnostics(f.store);expect(report.summary.count).toBe(3);expect(report.summary.within_001).toBe(2);expect(report.summary.max_deviation).toBeCloseTo(0.1);expect(report.distributions[0]).toMatchObject({raw_response_ref:'audit_0',probabilities:{'0':0.2,'1':0.79}});
 }finally{f.state.close();}
});
