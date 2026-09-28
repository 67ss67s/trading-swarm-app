import { describe,it,expect,vi } from 'vitest';
import { validate } from '@trade-gate/contracts';
import { fixture,params,study } from './fixtures.js';
import { runPortfolio } from '../../../src/demo/research/portfolio.js';
import { runReplay, StopRun, type AgentAction } from '../../../src/demo/research/engine.js';
import { hash } from '../../../src/demo/research/primitives.js';
import { buildUniverse } from '../../../src/demo/research/universe.js';
import { budgetBrain } from '../../../src/demo/research/agent.js';
import { ResearchStore } from '../../../src/demo/research/store.js';
import { openStateDb } from '../../../src/state-db.js';
const noTrade=():AgentAction=>({action:'no_trade',reason:'ok',gate_errors:[],evidence_refs:[]});
function input(){const datasets=['BTCUSDT','SOLUSDT'].map(symbol=>({...fixture(),symbol}));return {datasets,universe:buildUniverse({symbols:['BTCUSDT','SOLUSDT'],timeframe:'1h',from_ms:1,to_ms:2000000000000,market_factor:{kind:'btc',symbols:['BTCUSDT']}},datasets.map(data=>({id:hash(data),data})))};}
function request(){const r=params();const {dataset_id:_,...rest}=r;return {...rest,universe_id:input().universe.id,arms:['a_rules'] as ['a_rules'],execution:{...r.execution,max_positions:1}};}
describe('round 2 portfolio and model resilience',()=>{
 it('uses a shared capped cash ledger and records max_positions with deterministic order',async()=>{
  const data=input(),r=request(),out=await runPortfolio(data,r,async()=>{throw new Error('no model');});expect(out.status,out.error??'').toBe('completed');
  expect(out.arms[0]!.decisions.some(d=>d.action==='blocked'&&d.gate_errors.includes('max_positions'))).toBe(true);
  for(const row of out.arms[0]!.equity){const values=Object.values(row.by_symbol!).map(Number);expect(values.filter(v=>v>0).length).toBeLessThanOrEqual(1);expect(Number(row.cash)).toBeGreaterThanOrEqual(0);expect(Number(row.equity)).toBeCloseTo(Number(row.cash)+values.reduce((a,b)=>a+b,0),6);}
  expect(out.arms[0]!.trades.every(t=>!!t.symbol)).toBe(true);expect(out.arms[0]!.by_symbol!.reduce((a,b)=>a+Number(b.net_pnl),0)).toBeCloseTo(Number(out.arms[0]!.metrics.net_pnl),6);
 });
 it('equal_notional obeys portfolio allocation across simultaneous entries',async()=>{
  const data=input(),r={...request(),arms:['b_agent'] as ['b_agent'],execution:{...request().execution,max_positions:2,allocation:'equal_notional' as const}},first=r.from_ms;
  const out=await runPortfolio(data,r,async v=>v.at===first?{...noTrade(),action:'enter',entry:{candidate_id:v.symbol,stop:'1',target:'9999',reason:'test'}}:noTrade());
  const row=out.arms[0]!.equity[2]!;expect(Object.values(row.by_symbol!).every(v=>Number(v)>0)).toBe(true);expect(row.exposure).toBeLessThan(.26);
 });
 it('freezes per-symbol screen and independent B/C memory and replays without a model',async()=>{
  const data=input(),r={...request(),arms:['b_agent','c_filter'] as ['b_agent','c_filter'],repeats:1,to_ms:input().datasets[0]!.bars[50]!.close_time};
  const out=await runPortfolio(data,r,async v=>v.arm.startsWith('c_filter')?{...noTrade(),action:'skip'}:noTrade());
  expect(out.status).toBe('completed');expect(out.recordings.length).toBeGreaterThan(0);expect(out.recordings.every(x=>validate('research',x).ok)).toBe(true);expect(out.recordings.every(x=>x.input.screen&&x.input.trend&&x.input.screen.symbol===x.input.symbol)).toBe(true);
  expect(out.recordings.filter(x=>x.input.arm==='b_agent:0'&&x.input.at===r.from_ms).every(x=>x.input.previous_summary===null)).toBe(true);
  const replay=await runPortfolio(data,r,async()=>{throw new Error('model forbidden');},{replay:out.recordings});expect(hash(replay.arms)).toBe(hash(out.arms));
 });
 it('persists and validates a universe-backed study on aligned indices including purge',()=>{
  const state=openStateDb(':memory:');try{const store=new ResearchStore(state.db),data=input();for(const d of data.datasets)store.putDataset(d);store.putUniverse(data.universe);const s={...study(data.universe.id),dataset_id:data.universe.id};expect(store.putStudy(s)).toEqual(s);expect(store.validateRequest({...request(),study_id:s.id}).universe_id).toBe(data.universe.id);expect(()=>store.putStudy({...s,id:'bad',from_ms:s.from_ms+1})).toThrow('study_windows_invalid');
  expect(()=>store.create({...request(),universe_id:'wrong'},null,{kind:'stub',model:null,name:'stub',configuration_hash:'stub'},'')).toThrow('universe_not_found');}finally{state.close();}
 });
 it('records transient exceptions as model_error and continues after recovery',async()=>{
  let calls=0;const r={...params(),arms:['b_agent'] as ['b_agent'],repeats:1};const out=await runReplay(fixture(),r,async()=>{if(++calls<=4)throw new Error('pi timed out after 60000ms');return noTrade();});expect(out.status).toBe('completed');expect(out.recordings.slice(0,4).every(x=>x.output.action==='model_error')).toBe(true);expect(out.arms[0]!.decisions.filter(d=>d.action==='model_error')).toHaveLength(4);
  expect((await runReplay(fixture(),r,async()=>{throw new Error('no replay model');},{replay:out.recordings})).arms).toEqual(out.arms);
 });
 it('fails only after persisting the fifth consecutive model_error',async()=>{
  const r={...params(),arms:['b_agent'] as ['b_agent'],repeats:1};const out=await runReplay(fixture(),r,async()=>{throw new Error('timeout');});expect(out.status).toBe('failed');expect(out.error).toBe('consecutive_model_errors:5');expect(out.arms[0]!.decisions).toHaveLength(5);expect(out.recordings).toHaveLength(5);
 });
 it('does not convert cancellation or overall budget exhaustion into retryable model errors',async()=>{
  for(const status of ['cancelled','budget_exhausted'] as const){const out=await runReplay(fixture(),{...params(),arms:['b_agent'],repeats:1},async()=>{throw new StopRun(status,'stop');});expect(out.status).toBe(status);expect(out.recordings).toHaveLength(0);}
 });
 it('uses configured/default call timeout capped by the remaining overall deadline',async()=>{
  const complete=vi.fn(async()=>({text:'{}',latency_ms:1,model:'mock',input_tokens:1,output_tokens:1}));
  vi.spyOn(Date,'now').mockReturnValue(1000);try{
    for(const [timeout,remaining,want] of [[undefined,500000,120000],[250000,200000,200000],[300000,500000,300000]] as const){const brain=budgetBrain({name:'mock',complete},{max_calls:1,deadline:1000+remaining,model_call_timeout_ms:timeout,cancelled:()=>false,save:()=>{}});await brain.complete('s','u',{timeoutMs:60000});expect(complete.mock.lastCall?.[2]).toEqual({timeoutMs:want});}
  }finally{vi.restoreAllMocks();}
  expect(validate('research',{...params(),model_call_timeout_ms:300001}).ok).toBe(false);expect(validate('research',{...params(),universe_id:'both'}).ok).toBe(false);
 });
});

describe('portfolio review regressions',()=>{
 it('fails incomplete rather than assume protection survived a missing held bar',async()=>{
  const data=input(),r={...request(),arms:['b_agent'] as ['b_agent'],repeats:1};data.datasets[1]!.bars.splice(32,1);data.universe=buildUniverse({symbols:['BTCUSDT','SOLUSDT'],timeframe:'1h',from_ms:1,to_ms:2000000000000,market_factor:{kind:'btc',symbols:['BTCUSDT']}},data.datasets.map(data=>({data,id:hash(data)})));
  const out=await runPortfolio(data,r,async v=>v.symbol==='SOLUSDT'&&v.at===r.from_ms?{...noTrade(),action:'enter',entry:{candidate_id:'test',stop:'1',target:'99999',reason:'test'}}:noTrade());expect(out.status).toBe('failed');expect(out.error).toContain('missing_position_bar:SOLUSDT');
 });
 it('reserves capacity after all full exits, even if the entering symbol ranks first',async()=>{
  const data=input(),r={...request(),arms:['b_agent'] as ['b_agent'],repeats:1},next=data.datasets[0]!.bars[31]!.close_time;
  const out=await runPortfolio(data,r,async v=>v.at===r.from_ms&&v.symbol==='SOLUSDT'||v.at===next&&v.symbol==='BTCUSDT'?{...noTrade(),action:'enter',entry:{candidate_id:v.symbol,stop:'1',target:'99999',reason:'test'}}:v.at===next&&v.symbol==='SOLUSDT'?{...noTrade(),action:'exit'}:noTrade());expect(out.status).toBe('completed');expect(out.arms[0]!.decisions.find(d=>d.at===next&&d.symbol==='BTCUSDT')?.action).toBe('enter');expect(Number(out.arms[0]!.equity[3]!.by_symbol!.BTCUSDT)).toBeGreaterThan(0);
 });
 it('counts C illegal actions as failures after normalization',async()=>{
  const out=await runReplay(fixture(),{...params(),arms:['c_filter'],repeats:1},async()=>({...noTrade(),action:'enter'}));expect(out.status).toBe('failed');expect(out.error).toBe('consecutive_model_errors:5');expect(out.arms[0]!.decisions.filter(d=>d.action==='model_error')).toHaveLength(5);
 });
});

describe('common missing bars in the universe clock',()=>{
 for(const held of [false,true])it(held?'fails before mutation when every asset misses a held bar':'cancels a pending entry at a common missing bar instead of delaying its fill',async()=>{
  const data=input(),r={...request(),arms:['b_agent'] as ['b_agent'],repeats:1},index=held?32:31,missing=data.datasets[0]!.bars[index]!.close_time;
  for(const d of data.datasets)d.bars.splice(index,1);
  data.universe=buildUniverse({symbols:['BTCUSDT','SOLUSDT'],timeframe:'1h',from_ms:1,to_ms:2000000000000,market_factor:{kind:'btc',symbols:['BTCUSDT']}},data.datasets.map(data=>({data,id:hash(data)})));
  const out=await runPortfolio(data,r,async v=>v.symbol==='BTCUSDT'&&v.at===r.from_ms?{...noTrade(),action:'enter',entry:{candidate_id:'common-gap',stop:'1',target:'99999',reason:'test'}}:noTrade());
  expect(out.status).toBe(held?'failed':'completed');expect(out.arms[0]!.decisions.find(d=>d.at===missing&&d.symbol==='BTCUSDT')?.gate_errors).toContain(held?'missing_position_bar':'missing_next_bar_cancelled');
  if(!held){expect(out.arms[0]!.trades).toHaveLength(0);expect(out.arms[0]!.metrics.open_position).toBe(false);}else expect(out.error).toContain('missing_position_bar');
 });
});

it('shortlist is frozen at the segment start, A stays full pool and future data cannot select members',async()=>{
 const data=input(),r={...request(),arms:['a_rules','b_agent','c_filter'] as ['a_rules','b_agent','c_filter'],repeats:1,shortlist:{top_n:1,by:'composite' as const}},calls:string[]=[];
 // Insufficient history deliberately produces an empty shortlist rather than ranking on future bars.
 const out=await runPortfolio(data,r,async v=>{calls.push(v.symbol);return noTrade();});
 expect(out.status).toBe('completed');expect(calls).toHaveLength(0);expect(out.arms[0]!.decisions.some(x=>x.symbol==='SOLUSDT')).toBe(true);expect(out.arms[1]!.decisions.some(x=>x.reason==='outside_shortlist')).toBe(true);
 const poison={...data,datasets:data.datasets.map(d=>({...d,bars:d.bars.map(b=>b.close_time>r.to_ms?{...b,close:'999999999'}:b)}))};
 expect((await runPortfolio(poison,r,async()=>{throw Error('future shortlist');})).arms).toEqual(out.arms);
});

it('unit notional allocates equity/max_positions to each portfolio slot',async()=>{
 const data=input(),r={...request(),arms:['b_agent'] as ['b_agent'],repeats:1,execution:{...request().execution,sizing_mode:'unit_notional' as const,max_positions:2}},first=r.from_ms;
 const out=await runPortfolio(data,r,async v=>v.at===first?{...noTrade(),action:'enter',entry:{candidate_id:v.symbol,stop:'1',target:'9999',reason:'test'}}:noTrade());
 const row=out.arms[0]!.equity[2]!;expect(Object.values(row.by_symbol!).every(v=>Number(v)>4900)).toBe(true);expect(row.exposure).toBeGreaterThan(.98);expect(Number(row.cash)).toBeGreaterThanOrEqual(0);
});

it('a valid top-one shortlist limits model symbols while A retains both assets',async()=>{
 const source=fixture(),datasets=['BTCUSDT','SOLUSDT'].map(symbol=>({...source,symbol,bars:Array.from({length:1520},(_,i)=>({...source.bars[i%source.bars.length]!,open_time:source.bars[0]!.open_time+i*source.timeframe_ms,close_time:source.bars[0]!.open_time+(i+1)*source.timeframe_ms-1,available_at:source.bars[0]!.open_time+(i+1)*source.timeframe_ms-1})),retrieved_at:source.bars[0]!.open_time+1520*source.timeframe_ms}));
 const universe=buildUniverse({symbols:['BTCUSDT','SOLUSDT'],timeframe:'1h',from_ms:1,to_ms:2000000000000,market_factor:{kind:'btc',symbols:['BTCUSDT']}},datasets.map(data=>({id:hash(data),data}))),seen=new Set<string>();
 const r={...request(),universe_id:universe.id,from_ms:datasets[0]!.bars[1490]!.close_time,to_ms:datasets[0]!.bars[1500]!.close_time,arms:['a_rules','b_agent'] as ['a_rules','b_agent'],repeats:1,shortlist:{top_n:1,by:'residual_sharpe' as const}};
 const out=await runPortfolio({universe,datasets},r,async v=>{seen.add(v.symbol);return noTrade();});expect(out.status,out.error??'').toBe('completed');expect([...seen]).toEqual(['BTCUSDT']);expect(new Set(out.arms[0]!.decisions.map(d=>d.symbol)).size).toBe(2);
});
