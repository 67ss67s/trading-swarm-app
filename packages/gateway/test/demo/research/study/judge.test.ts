import { describe,it,expect,afterEach } from 'vitest';
import { validate, type StrategyJudge } from '@trading-swarm/contracts';
import { buildJudgeState,normalizeAnswers,evaluateJudgeRule,judgeCandidate,validateState,validateJudge } from '../../../../src/demo/research/judge/index.js';
import { requiredPurgeBars,assertPurge } from '../../../../src/demo/research/judge/filter.js';
import { hash } from '../../../../src/demo/research/primitives.js';
import { ir,judgeFixture,STEP } from './fixtures.js';
const clean:(()=>void)[]=[];afterEach(()=>clean.splice(0).forEach(f=>f()));
const fixture=()=>{const f=judgeFixture();clean.push(()=>f.state.close());return f;};
describe('judge IR / 纯函数',()=>{
 it('v1 哈希不变，v2 必须 judge，v1 禁止 judge，未知字段拒绝',()=>{
  const old=ir(),before=hash(old);expect(validate('research',old).ok).toBe(true);expect(hash(old)).toBe(before);
  expect(validate('research',{...old,version:2}).ok).toBe(false);expect(validate('research',{...old,judge:fixture().spec}).ok).toBe(false);
  expect(validate('research',ir(true)).ok).toBe(true);expect(validate('research',{...ir(true),judge:{...fixture().spec,script:'return true'}}).ok).toBe(false);
 });
 it('重复 question / label 引用 / criteria 不匹配拒绝',()=>{
  const {spec}=fixture();expect(()=>validateJudge({...spec,questions:[spec.questions[0]!,spec.questions[0]!]})).toThrow('duplicate');
  expect(()=>validateJudge({...spec,rule:{all:[{...spec.rule.all[0]!,label:'profit'}]}})).toThrow('reference');
  expect(()=>validateJudge({...spec,questions:[{...spec.questions[0]!,criteria:['one','two','three']}]})).toThrow('mismatch');
 });
 it('noul 和保守边距，灰区 skip',()=>{
  const {spec}=fixture();expect(evaluateJudgeRule(spec,normalizeAnswers(spec,{take:{type:'noul',noul:0.66}}))).toMatchObject({action:'follow',uncertain:false});
  expect(evaluateJudgeRule(spec,normalizeAnswers(spec,{take:{type:'noul',noul:0.62}}))).toMatchObject({action:'skip',uncertain:true});
  const low={...spec,rule:{all:[{...spec.rule.all[0]!,operator:'lte' as const,threshold:0.6,margin:0.05}]}};
  expect(evaluateJudgeRule(low,normalizeAnswers(low,{take:{type:'noul',noul:0.54}})).action).toBe('follow');
 });
 it.each([NaN,Infinity,-0.1,1.1,'0.8',null])('非法概率 %s 拒绝',value=>{const {spec}=fixture();expect(()=>normalizeAnswers(spec,{take:{type:'noul',noul:value}})).toThrow();});
 it('score 用有序分布标签，总和不为一拒绝',()=>{
  const {spec}=fixture();const score:StrategyJudge={...spec,questions:[{key:'quality',type:'score',instructions:'q',criteria:['poor','good'],labels:['poor','good'],state_fields:['features.trend']}],rule:{all:[{question_key:'quality',label:'good',operator:'gte',threshold:0.7,margin:0}]}};
  const ans=normalizeAnswers(score,{quality:{type:'score',score:0.8,confidence:0.8,probabilities:{0:0.2,1:0.8}}});expect(ans[0]?.probabilities).toEqual({poor:0.2,good:0.8});expect(evaluateJudgeRule(score,ans).action).toBe('follow');
  expect(()=>normalizeAnswers(score,{quality:{type:'score',score:0.8,confidence:0.8,probabilities:{0:0.2,1:0.9}}})).toThrow('sum');
 });
 it('未来行情不改变 state；未来字段/合法字段夹未来文本拒绝',()=>{
  const f=fixture(),base=buildJudgeState(f.candidate,f.data,f.spec),future={...f.data.at(-1)!,open_time:f.candidate.as_of,close_time:f.candidate.as_of+STEP-1,available_at:f.candidate.as_of+STEP-1,close:'99999'};
  expect(buildJudgeState(f.candidate,[...f.data,future],f.spec)).toEqual(base);
  expect(()=>buildJudgeState({...f.candidate,future_pnl:100} as never,f.data,f.spec)).toThrow('unknown');
  expect(()=>validateState({...base,features:{...base.features,future_pnl:1}},f.spec)).toThrow('field');
  expect(()=>validateState({...base,features:{...base.features,trend:'future profit is 10'}},f.spec)).toThrow('value');
 });
 it('缺历史/缺 bar/晚到数据/funding 缺失明确拒绝',()=>{
  const f=fixture();expect(()=>buildJudgeState(f.candidate,f.data.slice(-10),f.spec)).toThrow('history');expect(()=>buildJudgeState(f.candidate,f.data.filter((_,i)=>i!==100),f.spec)).toThrow('gap');
  expect(()=>buildJudgeState(f.candidate,f.data.map((b,i)=>i===119?{...b,available_at:f.candidate.as_of+1}:b),f.spec)).toThrow('history');
  const spec={...f.spec,questions:[{...f.spec.questions[0]!,state_fields:['features.funding']}]} as StrategyJudge;expect(()=>buildJudgeState(f.candidate,f.data,spec)).toThrow('unavailable');
 });
 it('purge 覆盖挂单与最大持仓，无界不放行',()=>{
  const x=ir();expect(requiredPurgeBars(x)).toBe(6);expect(()=>assertPurge(x,5,STEP,[])).toThrow('holding');
  const longer={...x,order:{...x.order!,max_holding_bars:100}};
  expect(requiredPurgeBars(longer)).toBe(102);expect(()=>assertPurge(longer,6,STEP,[])).toThrow('purge_below_max_holding:102');
  expect(()=>assertPurge(x,6,STEP,[{from_ms:0,to_ms:10*STEP},{from_ms:15*STEP,to_ms:20*STEP}])).toThrow('gap');
  expect(requiredPurgeBars({...x,exit:[],order:{...x.order!,max_holding_bars:undefined}})).toBeNull();
 });
});
describe('judgeCandidate 首次响应与去重',()=>{
 it('问题/choice 标签重排改变请求身份；不静默复用原回答',async()=>{
  const f=fixture(),q=f.spec.questions[0]!;
  const choice={key:'regime',type:'choice' as const,instructions:'regime',labels:['up','down'],criteria:['trend up','trend down'],state_fields:q.state_fields};
  const spec={...f.spec,questions:[q,choice]};
  await judgeCandidate({...f.input,spec},f.runtime);
  await judgeCandidate({...f.input,spec:{...spec,questions:[choice,q]}},f.runtime);
  await judgeCandidate({...f.input,spec:{...spec,questions:[q,{...choice,labels:['down','up'],criteria:['trend down','trend up']}]}},f.runtime);
  expect(f.provider.calls).toBe(3);
 });
 it('请求一次，recorded_only 逐位重放；不同状态不碰撞',async()=>{
  const f=fixture(),a=await judgeCandidate(f.input,f.runtime),b=await judgeCandidate(f.input,{...f.runtime,mode:'recorded_only',provider:undefined});expect(b).toEqual(a);expect(f.provider.calls).toBe(1);expect(f.store.response(a.request_hash)?.raw_json).toContain('answers');
  const changed={...f.input,state:{...f.input.state,features:{...f.input.state.features,volume_ratio:2}}};await expect(judgeCandidate(changed,f.runtime)).rejects.toThrow('conflict');await judgeCandidate({...changed,decision_key:'new'},f.runtime);expect(f.provider.calls).toBe(2);
 });
 it('阈值扫描复用原始回答，决策各自钉住',async()=>{
  const f=fixture();await judgeCandidate(f.input,f.runtime);await judgeCandidate({...f.input,spec:{...f.spec,rule:{all:[{...f.spec.rule.all[0]!,threshold:0.99}]}}},f.runtime);expect(f.provider.calls).toBe(1);expect(f.state.db.prepare('SELECT count(*) n FROM research_judge_decisions').get()?.n).toBe(2);
 });
 it('并发只调用一次，两结果等于串行重放',async()=>{
  const f=fixture(),old=f.provider.decide;f.provider.decide=async(r,o)=>{await new Promise(resolve=>setTimeout(resolve,15));return old(r,o);};
  const [a,b]=await Promise.all([judgeCandidate(f.input,f.runtime),judgeCandidate(f.input,f.runtime)]);expect(a).toEqual(b);expect(a.reason_codes).not.toContain('request_in_flight');expect(f.provider.calls).toBe(1);expect(await judgeCandidate(f.input,f.runtime)).toEqual(a);
 });
 it('recorded_only 缺响应不调用；原始响应无法覆盖',async()=>{
  const f=fixture();expect((await judgeCandidate(f.input,{...f.runtime,mode:'recorded_only'})).reason_codes).toEqual(['recorded_response_missing']);expect(f.provider.calls).toBe(0);
  const a=await judgeCandidate(f.input,f.runtime);expect(()=>f.state.db.prepare('UPDATE research_judge_responses SET raw_json=? WHERE request_hash=?').run('{}',a.request_hash)).toThrow('immutable');
 });
});
