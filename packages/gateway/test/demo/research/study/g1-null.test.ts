import { describe,it,expect } from 'vitest';
import { aggregatePanel,correlatedWalk,signFlipBlocks,syntheticDevelopment,aggregate } from '../../../../src/demo/research/study-eval/nulls.js';
import { clopperPearsonUpper,holm,pairedBlockBootstrap,g1Verdict } from '../../../../src/demo/research/study-eval/statistics.js';
import { runG1 } from '../../../../src/demo/research/study-eval/g1.js';
import { stubProvider,stubJudgeSpec } from '../../../../src/demo/research/judge/stubs.js';
import { normalizeAnswers,evaluateJudgeRule } from '../../../../src/demo/research/judge/pure.js';
describe('G1 零假设数据与释放门槛（CI 只证明流程）',()=>{
 it('N1 可重现，共享细网格生成合法 15m/4h/1d OHLC',()=>{
  const p=correlatedWalk({seed:17,bars:960});expect(correlatedWalk({seed:17,bars:960})).toEqual(p);const all=aggregatePanel(p);
  expect(all['1d']?.BTCUSDT).toHaveLength(10);expect(all['4h']?.BTCUSDT).toHaveLength(60);
  for(const rows of Object.values(all))for(const bars of Object.values(rows))for(const b of bars){expect(Number(b.high)).toBeGreaterThanOrEqual(Math.max(Number(b.open),Number(b.close)));expect(Number(b.low)).toBeLessThanOrEqual(Math.min(Number(b.open),Number(b.close)));expect(Number(b.low)).toBeGreaterThan(0);expect(b.available_at).toBe(b.close_time);}
  expect(p.funding).toBe('zero');
 });
 it('N2 同步块重抽和符号翻转；拒绝包含留出期的来源',()=>{
  const dev=syntheticDevelopment(11),p=signFlipBlocks({seed:3,bars:960},dev);expect(signFlipBlocks({seed:3,bars:960},dev)).toEqual(p);
  expect(()=>signFlipBlocks({seed:3,bars:960},{...dev,development_to_ms:0})).toThrow('development_only');
  expect(aggregatePanel(p)['1d']?.SOLUSDT).toHaveLength(10);
 });
 it('CP 上界 n=1000 时36通过、37失败；零错误小样本仍证据不足',()=>{
  expect(clopperPearsonUpper(36,1000)).toBeLessThanOrEqual(0.05);expect(clopperPearsonUpper(37,1000)).toBeGreaterThan(0.05);expect(clopperPearsonUpper(0,10)).toBeGreaterThan(0.05);
  expect(g1Verdict([{null_kind:'n1',studies:1000,false_releases:0,upper_975:0.01},{null_kind:'n2',studies:1000,false_releases:0,upper_975:0.01}],{studies:100,detected:79},'release')).toBe('failed');
 });
 it('Holm 同时校正全部 finalist；配对块 CI 与样本门槛',()=>{
  expect(holm([0.001,0.02,0.04],0.025).map(x=>x.rejected)).toEqual([true,false,false]);
  const a=Array.from({length:200},(_,i)=>0.01+Math.sin(i)*0.001),b=a.map(()=>0);expect(pairedBlockBootstrap(a,b,{block_size:5,replicates:199,seed:1}).ci![0]).toBeGreaterThan(0);
  expect(pairedBlockBootstrap(a.slice(0,20),b.slice(0,20),{block_size:5,replicates:199,seed:1}).status).toBe('insufficient_evidence');
 });
 it.each(['deterministic','random','all_skip','boundary_drift'] as const)('%s 判断桩：概率合法且 margin 保守',async kind=>{
  const provider=stubProvider(kind),spec=stubJudgeSpec(provider.profile),request={state:{candidate:{direction:'long'},features:{trend:'up'}},questions:{take:{type:'noul' as const,instructions:'q',criteria:{true:'yes',false:'no'}}}};
  const actions=[];for(let i=0;i<5;i++){const raw=await provider.decide(request);actions.push(evaluateJudgeRule(spec,normalizeAnswers(spec,raw.answers)).action);}
  if(kind==='all_skip'||kind==='boundary_drift')expect(actions).toEqual(Array(5).fill('skip'));if(kind==='deterministic')expect(actions).toEqual(Array(5).fill('follow'));
 });
 it('小 replicate 遍历两种零假设及四类桩，绝不声明统计通过',async()=>{
  const calls:string[]=[];const result=await runG1(async input=>{calls.push(input.panel.null_kind+':'+input.judge_kind);return{passed:input.panel.null_kind==='positive_control',attempt_count:2,trial_count:2,finalist_count:1,judge_calls:1};},{profile:'ci',null_replicates:2,positive_replicates:1,fine_bars:192,seed:1});
  expect(result.status).toBe('insufficient_evidence');expect(result.groups.map(g=>g.studies)).toEqual([2,2]);expect(calls).toHaveLength(19);expect(result.positive.detected).toBe(1);
 });
});
