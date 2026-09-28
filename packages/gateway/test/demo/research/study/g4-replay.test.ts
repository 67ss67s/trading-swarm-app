import { afterEach,describe,expect,it,vi } from 'vitest';
import type { StrategyIR } from '@trade-gate/contracts';
import { generateRunCandidate } from '../../../../src/demo/strategy-run-orders.js';
import { StrategyRunner, type StrategyRunDeps } from '../../../../src/demo/strategy-run.js';
import { candidateSnapshot,judgeDecimal } from '../../../../src/demo/research/judge/candidate.js';
import { judgeWithBars,buildJudgeState } from '../../../../src/demo/research/judge/index.js';
import { runOrderPath,runOrderPathAsync } from '../../../../src/demo/research/orders/index.js';
import { sliceAsset,DAY } from '../../../../src/demo/research/batch/evaluate.js';
import { orderGateFor } from '../../../../src/demo/research/order-gate.js';
import { hash } from '../../../../src/demo/research/primitives.js';
import { ResearchStore } from '../../../../src/demo/research/store.js';
import { StrategyStore } from '../../../../src/demo/research/strategies/store.js';
import { StrategyService } from '../../../../src/demo/research/strategies/service.js';
import { EvalEnv } from '../../../../src/demo/research/improve/evaluate.js';
import { runWithJudge,type CandidateLog } from '../../../../src/demo/research/judge/filter.js';
import { viewBars,runReplay } from '../../../../src/demo/research/engine.js';
import { SYNTH_POLICY } from '../../../../src/demo/strategy-candidate.js';
import { ir,bars,judgeFixture,STEP,START } from './fixtures.js';
const clean:(()=>void|Promise<void>)[]=[];afterEach(async()=>{for(const f of clean.splice(0).reverse())await f();});
const fixture=()=>{const f=judgeFixture();clean.push(()=>f.state.close());return f;};
function generated(x:StrategyIR,data:ReturnType<typeof bars>,i:number,step=STEP){return generateRunCandidate({shadow:{strategy_id:'g4',version:1,ir_hash:hash(x),timeframe:step===STEP?'4h':'15m',ir:x,source:'research_strategy_version',label:'g4',unmapped:[],horizon_bars:4,pick_note:'offline'},symbol:'BTCUSDT',klines:{[step===STEP?'4h':'15m']:data.slice(Math.max(0,i-viewBars(x,SYNTH_POLICY,step)-1),i+1)},now:data[i]!.close_time+1});}
describe('G4 确定性与盲性（离线）',()=>{
 it('旧 spot replay 拒绝带 judge 的 IR，不能静默绕过过滤',async()=>{
  await expect(runReplay({} as never,{strategy_ir:ir(true)} as never,async()=>({action:'skip'} as never))).rejects.toThrow('ir_judge_requires_order_executor');
 });
 it.each(['long','short'] as const)('%s：orders 与运行器候选、judge、录制重放逐条一致',async side=>{
  const f=fixture(),x=ir(true,side),n=process.env.TG_G4_RELEASE==='1'?10400:1400,data=bars(n),logs:CandidateLog[]=[];
  const input={ir:x,bars:data,timeframe_ms:STEP,symbol:'BTCUSDT',from_index:300,to_index:n-1,initial_cash:10000,view_bars:viewBars(x,SYNTH_POLICY,STEP),fee_rate:'0',slippage_bps:'0',gate:orderGateFor(x),judge:f.runtime,on_candidate:(candidate:CandidateLog['candidate'],decision:CandidateLog['decision'])=>logs.push({candidate,decision})};
  const a=await runOrderPathAsync(input);expect(logs.length).toBeGreaterThan(process.env.TG_G4_RELEASE==='1'?1000:100);
  const online:CandidateLog[]=[];
  for(let i=300;i<n;i++){
   const c=generated(x,data,i).candidate;if(!c)continue;
   const snapshot=candidateSnapshot(x,{symbol:c.symbol,as_of:c.as_of,timeframe_ms:STEP,direction:c.direction,entry:judgeDecimal(c.entry_ref),stop:judgeDecimal(c.stop),target:c.target===null?null:judgeDecimal(c.target),reward_risk:c.rr});
   const decision=await judgeWithBars(x,snapshot,data.slice(Math.max(0,i-99),i+1),{...f.runtime,mode:'recorded_only',provider:undefined});online.push({candidate:snapshot,decision});
  }
  expect(online).toEqual(logs);const calls=f.provider.calls;
  const b=await runOrderPathAsync({...input,judge:{...f.runtime,mode:'recorded_only',provider:undefined},on_candidate:undefined});expect(b).toEqual(a);expect(f.provider.calls).toBe(calls);
 },120000);
 it('改变 as_of 后 OHLC 不改变历史候选、state hash 或请求',()=>{
  const f=fixture(),data=bars(500),x=ir(true),i=304;
  const c=generated(x,data,i).candidate!;expect(c).not.toBeNull();
  const poison=data.map((b,k)=>k>i?{...b,open:'99999',close:'99999',high:'100000',low:'1'}:b);
  expect(generated(x,poison,i)).toEqual(generated(x,data,i));
  const snapshot=candidateSnapshot(x,{symbol:c.symbol,as_of:c.as_of,timeframe_ms:STEP,direction:c.direction,entry:judgeDecimal(c.entry_ref),stop:judgeDecimal(c.stop),target:judgeDecimal(c.target!),reward_risk:c.rr});
  expect(hash(buildJudgeState(snapshot,data,f.spec))).toBe(hash(buildJudgeState(snapshot,poison,f.spec)));
 });
 it('无 judge 的 async 与 sync 成交完全一致；null limit 保留原 blocked 行为',async()=>{
  const x=ir(),data=bars(500),input={ir:x,bars:data,timeframe_ms:STEP,symbol:'BTCUSDT',from_index:300,to_index:499,initial_cash:10000};
  expect(await runOrderPathAsync(input)).toEqual(runOrderPath(input));
  const bad={...x,order:{...x.order!,entry:{type:'limit' as const,price:{primitive:'indicator_level',params:{indicator:'ema',args:{period:2000}}},expiry_bars:3}}};
  expect(await runOrderPathAsync({...input,ir:bad})).toEqual(runOrderPath({...input,ir:bad}));
 });
 it('runWithJudge 全 skip 仍保留全部候选，且不改变共享 env',async()=>{
  const f=judgeFixture('all_skip');clean.push(()=>f.state.close());const data=bars(700),x={...ir(true),judge:f.spec};
  const win={from_ms:data[300]!.close_time,to_ms:data[699]!.close_time},env=new EvalEnv({universe:['BTCUSDT'],timeframe:'4h',timeframe_ms:STEP,warmup_bars:300,assets:[{symbol:'BTCUSDT',dataset_id:'fixture',bars:data}],segments:{train:win,validation:win,holdout:win,folds:[]}});
  const result=await runWithJudge(env,x,hash(x),win,{runtime:f.runtime});expect(result.candidates.length).toBeGreaterThan(20);expect(result.candidates.every(c=>c.decision?.action==='skip')).toBe(true);expect(result.trades).toEqual([]);expect(env.judge).toBeUndefined();
 });
 it('实际 runPool 拒绝超出冻结 purge 的迭代变体',async()=>{
  const data=bars(700),win={from_ms:data[300]!.close_time,to_ms:data[600]!.close_time};
  const env=new EvalEnv({universe:['BTCUSDT'],timeframe:'4h',timeframe_ms:STEP,warmup_bars:300,assets:[{symbol:'BTCUSDT',dataset_id:'fixture',bars:data}],segments:{train:{from_ms:win.from_ms,to_ms:data[400]!.close_time},validation:{from_ms:data[408]!.close_time,to_ms:win.to_ms},holdout:{from_ms:-1,to_ms:-1},folds:[]}});
  const variant={...ir(),order:{...ir().order!,max_holding_bars:100}};
  await expect(runWithJudge(env,variant,hash(variant),win)).rejects.toThrow('purge_below_max_holding:102');
  expect(env.runs).toBe(0);
 });
 it('跨训练边界持仓按权益盯市，未来退出不得污染前段交易统计',()=>{
  const data=Array.from({length:10},(_,i)=>({at:i*DAY,equity:100+i,exposure:1,bench:100+i})),win={from_ms:2*DAY,to_ms:5*DAY};
  const trades=[{entry_at:3*DAY,exit_at:7*DAY,return_pct:99,fees:999},{entry_at:4*DAY,exit_at:5*DAY,return_pct:0.01,fees:1}];
  const a=sliceAsset('X',data,null,trades,win,0),b=sliceAsset('X',data.map(p=>p.at>win.to_ms?{...p,equity:99999}:p),null,[{...trades[0]!,return_pct:-99,fees:0},trades[1]!],win,0);
  expect(a).toEqual(b);expect(a.trade_returns).toEqual([0.01]);expect(a.eq.at(-1)).toBeCloseTo(105/101);
 });
});
describe('IR judge 与运行模式解耦',()=>{
 // 「每笔确认」已下线,不能再新建 confirm 运行;换成 jev:带 IR judge 块时 jev 模式也只按 judge 块判断,不再问一遍 Jev
 it.each(['auto','agent','jev','signal_only'] as const)('%s 都执行 judge；skip 不开单也不发布',async mode=>{
  const f=fixture(),x=ir(true),data=bars(305),service=new StrategyService(new StrategyStore(f.state.db),new ResearchStore(f.state.db),null),s=service.create({name:'g4',symbol:'BTCUSDT',timeframe:'4h',strategy_ir:x});
  const now=data.at(-1)!.close_time+5001;const deps:StrategyRunDeps={db:f.state.db,strategies:service,environment:()=>({execution:{backend:'paper',profile:null,label:'paper'},execution_key:'paper',watchlist:['BTCUSDT'],risk_pct:1,leverage_cap:1,asp:{id:'x',identity:true,active:true,publisher_enabled:false}}),blocked:()=>null,bars:async()=>data,threads:()=>[],open:vi.fn(async()=>({outcome:'opened',reason:'fixture'})),close:async()=>{},filter:vi.fn(async()=>({decision:'follow',reason:'legacy'})),publish:vi.fn(async()=>({event_id:'fixture'})),emit:vi.fn(),now:()=>now,judge:()=>f.runtime};
  // take=0 强制 skip，所有模式必须走同一调用/落库。
  const old=f.provider.decide;f.provider.decide=async(r,o)=>({...await old(r,o),answers:{take:{type:'noul',noul:0}}});
  const runner=new StrategyRunner(deps);clean.push(()=>runner.stop());const result=await runner.create({strategy_id:s.id,mode,publish_asp:true});
  expect(f.provider.calls).toBe(1);expect(deps.filter).not.toHaveBeenCalled();expect(deps.open).not.toHaveBeenCalled();expect(deps.publish).not.toHaveBeenCalled();expect(result.scan.some(e=>e.kind==='agent_skip')).toBe(true);
 });
});
