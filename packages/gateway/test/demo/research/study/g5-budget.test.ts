import { afterEach,describe,expect,it,vi } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateDb } from '../../../../src/state-db.js';
import { AtomicCallBudget,JudgeDecisionStore,judgeCandidate,usdUnits,usdString } from '../../../../src/demo/research/judge/index.js';
import { judgeFixture } from './fixtures.js';
const clean:(()=>void)[]=[];afterEach(()=>{clean.splice(0).reverse().forEach(f=>f());vi.restoreAllMocks();});
function fixture(){const f=judgeFixture();clean.push(()=>f.state.close());return f;}
function paid(f:ReturnType<typeof fixture>,cost:number|null=0.000027){
 f.input.model_profile.max_call_usd='0.00005';const old=f.provider.decide;
 f.provider.decide=async(r,o)=>({...await old(r,o),usage:{input_tokens:10,cost_usd:cost},provider_request_id:'provider_req_123'});
}
describe('G5 记账故障注入（100 案例）',()=>{
 const cases=Array.from({length:100},(_,i)=>({i,kind:['http_429','timeout','bad_response','unknown_usage','crash_after_response'][i%5]!}));
 it.each(cases)('$kind #$i：一次调用、保留未知预留、不重抽',async({i,kind})=>{
  const f=fixture();paid(f,kind==='unknown_usage'?null:0.000027);f.input.decision_key=String(i);
  const old=f.provider.decide;
  if(kind==='http_429'||kind==='timeout')f.provider.decide=async()=>{f.provider.calls++;throw Error(kind);};
  if(kind==='bad_response')f.provider.decide=async(r,o)=>({...await old(r,o),answers:{take:{type:'noul',noul:2}}});
  if(kind==='crash_after_response'){const finish=f.store.finish.bind(f.store);let first=true;vi.spyOn(f.store,'finish').mockImplementation((...args)=>{if(first){first=false;throw Error('injected_before_commit');}return finish(...args);});}
  if(kind==='crash_after_response'){await expect(judgeCandidate(f.input,f.runtime)).rejects.toThrow('injected_before_commit');f.store.interruptBudget('study');}
  const a=await judgeCandidate(f.input,f.runtime),b=await judgeCandidate(f.input,{...f.runtime,mode:'recorded_only'});expect(b).toEqual(a);expect(f.provider.calls).toBe(1);
  const budget=f.budget.view();expect(budget.calls).toBe(1);
  if(kind==='bad_response'){expect(a.action).toBe('skip');expect(budget.spent_usd).toBe('0.000027');expect(budget.reserved_usd).toBe('0');}
  else{expect(budget.reserved_usd).toBe('0.00005');expect(a.cost_status).toBe('unknown');}
  expect(usdUnits(budget.spent_usd)+usdUnits(budget.reserved_usd)).toBeLessThanOrEqual(usdUnits(budget.max_usd));
  const attempt=f.state.db.prepare('SELECT * FROM research_call_attempts').get()!;expect(attempt.reservation_usd).toBe('0.00005');expect(attempt.finished_at).toBe(1000);
 });
 it('decimal 精确加减与非法金额',()=>{expect(usdString(usdUnits('0.1')+usdUnits('0.2'))).toBe('0.3');expect(()=>usdUnits('1e-5')).toThrow();expect(()=>usdUnits('-1')).toThrow();});
 it('跨两个 DB 连接并发预留最多五次，未知状态不会腾出预算',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'judge-budget-'));clean.push(()=>rmSync(dir,{recursive:true,force:true}));
  const a=openStateDb(join(dir,'state.sqlite')),b=openStateDb(join(dir,'state.sqlite'));clean.push(()=>a.close(),()=>b.close());
  const f=fixture();paid(f,null);const ba=AtomicCallBudget.create(a.db,'shared',100,'0.00025'),bb=AtomicCallBudget.create(b.db,'shared',100,'0.00025');
  await Promise.all(Array.from({length:20},(_,i)=>judgeCandidate({...f.input,decision_key:String(i),state:{...f.input.state,features:{...f.input.state.features,volume_ratio:i+1}}},{...f.runtime,store:new JudgeDecisionStore(i%2?a.db:b.db),budget:i%2?ba:bb})));
  expect(f.provider.calls).toBe(5);expect(ba.view()).toMatchObject({calls:5,reserved_usd:'0.00025',spent_usd:'0'});
  expect(a.db.prepare('SELECT count(*) n FROM research_call_attempts').get()?.n).toBe(5);
 });
 it('取消后无新调用，恢复不清账，完成项不重复收费',async()=>{
  const f=fixture();paid(f);const a=await judgeCandidate(f.input,f.runtime);f.budget.cancel();
  const next={...f.input,decision_key:'after_cancel',state:{...f.input.state,features:{...f.input.state.features,volume_ratio:99}}};
  expect((await judgeCandidate(next,f.runtime)).reason_codes).toContain('cancelled');expect(f.provider.calls).toBe(1);
  f.budget.resume();expect(await judgeCandidate(f.input,f.runtime)).toEqual(a);expect(f.provider.calls).toBe(1);expect(f.budget.view().spent_usd).toBe('0.000027');
  const resumed=await judgeCandidate(next,f.runtime);expect(resumed.reason_codes).not.toContain('cancelled');expect(f.provider.calls).toBe(2);
 });
 it('响应抵达时已取消：费用和首次响应照存，恢复不重抽也不永久卡在取消',async()=>{
  const f=fixture();paid(f);const old=f.provider.decide;
  f.provider.decide=async(r,o)=>{const raw=await old(r,o);f.budget.cancel();return raw;};
  const paused=await judgeCandidate(f.input,f.runtime);expect(paused.reason_codes).toContain('cancelled');expect(paused.raw_response_ref).not.toBeNull();
  f.budget.resume();const resumed=await judgeCandidate(f.input,{...f.runtime,mode:'recorded_only'});
  expect(resumed.reason_codes).not.toContain('cancelled');expect(resumed.status).not.toBe('error');expect(f.provider.calls).toBe(1);expect(f.budget.view().spent_usd).toBe('0.000027');
 });
 it('响应已钉住、decision 落库前中断，恢复使用同一原始响应',async()=>{
  const f=fixture();paid(f);const put=f.store.put.bind(f.store);let fail=true;
  vi.spyOn(f.store,'put').mockImplementation((...args)=>{if(fail){fail=false;throw Error('crash_before_decision');}return put(...args);});
  await expect(judgeCandidate(f.input,f.runtime)).rejects.toThrow('crash');const a=await judgeCandidate(f.input,{...f.runtime,mode:'recorded_only'});expect(a.raw_response_ref).not.toBeNull();expect(f.provider.calls).toBe(1);expect(f.budget.view().spent_usd).toBe('0.000027');
 });
 it('claim 事务故障传播；恢复后首次请求不被永久 skip 污染',async()=>{
  const f=fixture();paid(f);vi.spyOn(f.store,'claim').mockImplementationOnce(()=>{throw Error('database_busy');});
  await expect(judgeCandidate(f.input,f.runtime)).rejects.toThrow('database_busy');expect(f.provider.calls).toBe(0);expect(f.budget.view().calls).toBe(0);
  expect((await judgeCandidate(f.input,f.runtime)).reason_codes).not.toContain('database_busy');expect(f.provider.calls).toBe(1);
 });
 it('预算超额实际费用照实入账并封锁后续，未知价格不按0',async()=>{
  const f=fixture();paid(f,0.00006);const a=await judgeCandidate(f.input,f.runtime);expect(a.reason_codes).toContain('provider_cost_exceeds_reservation');expect(f.budget.view()).toMatchObject({blocked:1,spent_usd:'0.00006'});
  await judgeCandidate({...f.input,decision_key:'another',state:{...f.input.state,features:{...f.input.state.features,volume_ratio:22}}},f.runtime);expect(f.provider.calls).toBe(1);
  const g=fixture();g.input.model_profile.routing='paid';await expect(judgeCandidate(g.input,g.runtime)).rejects.toThrow('price_bound');
 });
 it('模型版本变化明确 skip；usage/request id 可对账',async()=>{
  const f=fixture();paid(f);const old=f.provider.decide;f.provider.decide=async(r,o)=>({...await old(r,o),model:'different'});
  const a=await judgeCandidate(f.input,f.runtime);expect(a.reason_codes).toContain('model_revision_mismatch');expect(f.state.db.prepare('SELECT provider_request_id,actual_usd FROM research_call_attempts').get()).toMatchObject({provider_request_id:'provider_req_123',actual_usd:'0.000027'});
 });
});
