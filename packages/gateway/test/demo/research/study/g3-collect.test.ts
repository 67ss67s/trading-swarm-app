import { it,expect } from 'vitest';
import { openStateDb } from '../../../../src/state-db.js';
import { collectG3,cheapTrend,deepseekClient,validateCollectionManifest } from '../../../../src/demo/research/study-eval/g3-collect.js';
import { analyzeG3 } from '../../../../src/demo/research/study-eval/g3-analyze.js';
import { g3OfflineFixture } from '../../../../src/demo/research/study-eval/g3-fixture.js';
import { DecisionError } from '../../../../src/demo/decisions.js';
import { hash } from '../../../../src/demo/research/primitives.js';
it('四臂离线采集、原文与费用、断点复用、账户分析诚实报功效不足',async()=>{
 const {manifest,outcomes}=g3OfflineFixture(),s=openStateDb(':memory:');try{
 const opts={stub:true,max_usd:'2',max_calls:12000};const c=await collectG3(manifest,s.db,opts),again=await collectG3(manifest,s.db,opts);
 expect(c.decisions).toHaveLength(32);expect(c.responses).toHaveLength(16);expect(c.budget.spent_usd).toBe('0.000432');expect(again.budget.calls).toBe(c.budget.calls);expect(again.decisions).toEqual(c.decisions);
 expect(()=>analyzeG3(manifest,{...c,synthetic:false},outcomes)).toThrow('mode_mismatch');const a=analyzeG3(manifest,c,outcomes);expect(a.results[0]!.status).toBe('insufficient_evidence');expect(a.records[0]!.daily_returns.jev[0]).toBeLessThan(a.records[0]!.daily_returns.code[0]!);
 await expect(collectG3(manifest,s.db,{...opts,stub:false})).rejects.toThrow('synthetic_mode');
 await expect(collectG3({...manifest,frozen_at:manifest.frozen_at-1},s.db,opts)).rejects.toThrow('manifest_changed');
 }finally{s.close();}
});
it('预算硬闸保留已完成行，未采齐不能得出账户结论；unknown 不重发',async()=>{
 const {manifest}=g3OfflineFixture(),s=openStateDb(':memory:');try{
 const c=await collectG3(manifest,s.db,{stub:true,max_usd:'0.00015',max_calls:100});expect(c.complete).toBe(false);expect(Number(c.budget.spent_usd)+Number(c.budget.reserved_usd)).toBeLessThanOrEqual(0.00015);const calls=c.budget.calls;expect((await collectG3(manifest,s.db,{stub:true,max_usd:'0.00015',max_calls:100})).budget.calls).toBe(calls);
 }finally{s.close();}
});
it('便宜过滤必须1h+4h同向且没有未来数据；DeepSeek上界拒绝低预留',()=>{
 const {manifest:m}=g3OfflineFixture(),o=m.finalists[0]!.opportunities[0]!;expect(cheapTrend(o)).toBe(true);expect(cheapTrend({...o,trend_4h:[]})).toBe(false);expect(cheapTrend({...o,trend_4h:o.trend_4h.map(b=>({...b,available_at:o.candidate.as_of+1}))})).toBe(false);
 m.profiles.deepseek.max_call_usd='0.000001';expect(()=>validateCollectionManifest(m)).toThrow('reservation_below_bound');
});
it('DeepSeek使用相同语义，直连端点，坏JSON保留token费用且没有重试',async()=>{
 const {manifest:m}=g3OfflineFixture();let calls=0;
 const client=deepseekClient('not-a-real-key',m.pricing,async(url,init)=>{calls++;expect(url).toBe('https://api.deepseek.com/chat/completions');expect(init?.redirect).toBe('manual');expect(JSON.parse(String(init?.body)).model).toBe('deepseek-chat');return new Response(JSON.stringify({id:'ds-1',model:'deepseek-chat',usage:{prompt_tokens:100,completion_tokens:10},choices:[{finish_reason:'stop',message:{content:'not json'}}]}));});
 try{await client.decide({state:{features:{}},questions:{take:{type:'noul',instructions:'same question',criteria:{true:'yes',false:'no'}}}});throw Error('expected failure');}catch(e){expect(e).toBeInstanceOf(DecisionError);expect((e as DecisionError).recorded_response?.usage.cost_usd).toBeCloseTo(0.0000322);expect((e as DecisionError).recorded_response?.raw_response).toBeTruthy();}expect(calls).toBe(1);
});
it('跨日必须有日尾净盯市；账户资本冲突不能独立相加机会收益',async()=>{
 const {manifest:m,outcomes:o}=g3OfflineFixture();const opp=m.finalists[0]!.opportunities[0]!;const duplicate={...structuredClone(opp),candidate:{...opp.candidate,id:'overlap'}};m.finalists[0]!.opportunities.push(duplicate);
 o.finalists.offline_finalist!.push({...structuredClone(o.finalists.offline_finalist![0]!),candidate_id:'overlap'});o.manifest_hash=hash(m);
 const s=openStateDb(':memory:');try{const c=await collectG3(m,s.db,{stub:true,max_usd:'2',max_calls:100});const a=analyzeG3(m,c,o);expect((a.accounts[0] as {capacity_skips:number}).capacity_skips).toBe(1);
 const filled=o.finalists.offline_finalist![0]!;if(filled.status==='not_filled')throw Error('fixture_must_be_filled');
 filled.exit_at+=86400000;filled.marks[0]!.at+=86400000;
 expect(()=>analyzeG3(m,c,o)).toThrow();
 }finally{s.close();}
});

it('未成交候选保留四臂记录和查询费用，不虚构成交或跟随次数',async()=>{
 const {manifest,outcomes}=g3OfflineFixture();
 outcomes.finalists.offline_finalist=manifest.finalists[0]!.opportunities.map(o=>({candidate_id:o.candidate.id,status:'not_filled' as const,reason:'expired' as const}));
 const s=openStateDb(':memory:');try{
  const c=await collectG3(manifest,s.db,{stub:true,max_usd:'2',max_calls:100}),a=analyzeG3(manifest,c,outcomes);
  expect(c.decisions).toHaveLength(32);expect(a.records[0]!.candidate_count).toBe(8);expect(a.records[0]!.follow_count).toBe(0);
  expect(a.records[0]!.daily_returns.code.every(r=>r===0)).toBe(true);expect(a.records[0]!.daily_returns.jev.some(r=>r<0)).toBe(true);
  expect(a.accounts[0]).toMatchObject({trades:0,no_fills:8});expect(a.results[0]!.status).toBe('insufficient_evidence');
  outcomes.finalists.offline_finalist[0]={...outcomes.finalists.offline_finalist[0]!,entry_at:0} as never;
  expect(()=>analyzeG3(manifest,c,outcomes)).toThrow('g3_unfilled_outcome_invalid');
 }finally{s.close();}
});
