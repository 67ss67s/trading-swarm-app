import { buildUniverse } from '../../../src/demo/research/universe.js';
import { runPortfolio } from '../../../src/demo/research/portfolio.js';
import { defaultIR,node } from '../../../src/demo/research/strategy.js';
import { describe,it,expect } from 'vitest';
import { validate } from '@trading-swarm/contracts';
import { fixture,params,study,STEP } from './fixtures.js';
import { runReplay } from '../../../src/demo/research/engine.js';
import { SpotLedger } from '../../../src/demo/research/ledger.js';
import { q } from '../../../src/demo/research/primitives.js';
import { ResearchStore } from '../../../src/demo/research/store.js';
import { ResearchService } from '../../../src/demo/research/service.js';
import { researchTool } from '../../../src/demo/research/tools.js';
import { openStateDb } from '../../../src/state-db.js';
const identity={kind:'stub' as const,model:null,name:'stub',configuration_hash:'stub'};
describe('diagnostics and immutable section attribution',()=>{
 it('adds excursion, costs, exits and histogram without altering the net equity ledger',async()=>{
  const r={...params(),arms:['a_rules'] as ['a_rules']},none=async()=>{throw new Error('no model');};
  const old=await runReplay(fixture(),r,none),out=await runReplay(fixture(),r,none,{diagnostics:true}),arm=out.arms[0]!,d=arm.diagnostics!;
  expect(arm.equity).toEqual(old.arms[0]!.equity);expect(arm.metrics).toEqual(old.arms[0]!.metrics);expect(arm.trades.every(t=>t.symbol===fixture().symbol&&t.mae_r!<=0&&t.mfe_r!>=0)).toBe(true);
  expect(d.r_histogram.counts.reduce((a,b)=>a+b,0)).toBe(arm.trades.filter(t=>t.net_r!==null).length);expect(d.exit_reasons.reduce((a,b)=>a+b.count,0)).toBe(arm.trades.length);expect(q(d.cost_share.gross_pnl)).toBe(q(arm.metrics.net_pnl)+q(arm.metrics.fees));expect(d.factor.status).toBe('insufficient');
 });
 it('never uses post-exit bar extremes for excursion and keeps original risk after reductions',()=>{
  const l=new SpotLedger({...params().execution,fee_rate:'0',slippage_bps:'0'},{symbol:'BTCUSDT',diagnostics:true});
  const bar=(i:number,o:string,h:string,low:string,c:string)=>({open_time:i*STEP,close_time:(i+1)*STEP-1,available_at:(i+1)*STEP-1,open:o,high:h,low,close:c,volume:'100'});
  l.pending={action:'enter',entry:{candidate_id:'x',stop:'90',target:null,reason:'test'}};l.step(bar(0,'100','105','95','103'));l.pending={action:'reduce',reason:'agent_reduce'};l.step(bar(1,'104','106','99','104'));l.step(bar(2,'100','1000','80','90'));
  expect(l.trades[0]!.mae_r).toBe(-.5);expect(l.trades[0]!.mfe_r).toBe(.5);expect(l.trades[1]!.mae_r).toBe(-1);expect(l.trades[1]!.mfe_r).toBe(.6);expect(l.trades[1]!.holding_bars).toBe(3);
 });
 it('computes zero-model parent/child ablations once and reuses the persisted result',async()=>{
  const state=openStateDb(':memory:');try{
   const store=new ResearchStore(state.db),svc=new ResearchService(store),id=store.putDataset(fixture()).id;store.putStudy(study(id));
   const a={...params(id),arms:['a_rules'] as ['a_rules']},parent=store.create(a,null,identity,'');store.status(parent.id,'completed',await runReplay(fixture(),a,async()=>{throw new Error('no model');}));
   const b={...a,idempotency_key:'child',parent_run_id:parent.id,policy:{...a.policy!,stop_atr:3}},child=store.create(b,null,identity,'');store.status(child.id,'completed',await runReplay(fixture(),b,async()=>{throw new Error('no model');}));
   const out=await svc.attribution(child.id);expect(validate('research',out).ok).toBe(true);expect(out.components.map(c=>c.section)).toEqual(['risk']);expect(out.interaction).toBeCloseTo(0,10);expect(await svc.attribution(child.id)).toEqual(out);expect(state.db.prepare('SELECT count(*) AS n FROM research_attributions').get()?.n).toBe(1);expect(store.traces(parent.id)).toHaveLength(0);expect(store.traces(child.id)).toHaveLength(0);
   const compare=await researchTool({tool:'runs.compare',args:{run_id:child.id}},svc,()=>{throw new Error('launch forbidden');}) as {attribution:unknown};expect(compare.attribution).toEqual(out);
  }finally{state.close();}
 });
 it('requires a completed parent/child and rejects cost or range changes',async()=>{
  const state=openStateDb(':memory:');try{const store=new ResearchStore(state.db),svc=new ResearchService(store),id=store.putDataset(fixture()).id;store.putStudy(study(id));const a={...params(id),arms:['a_rules'] as ['a_rules']},parent=store.create(a,null,identity,'');store.status(parent.id,'completed',await runReplay(fixture(),a,async()=>{throw new Error('no model');}));await expect(svc.attribution(parent.id)).rejects.toThrow('child_with_parent');
   const b={...a,idempotency_key:'changed-cost',parent_run_id:parent.id,execution:{...a.execution,fee_rate:'0.002'}},child=store.create(b,null,identity,'');store.status(child.id,'completed',await runReplay(fixture(),b,async()=>{throw new Error('no model');}));await expect(svc.attribution(child.id)).rejects.toThrow('same_data_range_execution');
  }finally{state.close();}
 });
 it('replays both old unadorned results and new diagnostics results without changing hashes',async()=>{
  const state=openStateDb(':memory:');try{const store=new ResearchStore(state.db),svc=new ResearchService(store),id=store.putDataset(fixture()).id;store.putStudy(study(id));for(const detailed of [false,true]){const r={...params(id),idempotency_key:String(detailed),arms:['a_rules'] as ['a_rules']},row=store.create(r,null,identity,'');store.db.prepare('UPDATE research_runs SET manifest_json=? WHERE id=?').run(JSON.stringify({...row.manifest,request:r}),row.id);store.status(row.id,'completed',await runReplay(fixture(),r,async()=>{throw new Error('no model');},{diagnostics:detailed}));expect((await svc.replay(row.id)).verified).toBe(true);}}finally{state.close();}
 });
});

describe('final compatibility and IR attribution coverage',()=>{
 it('replays a legacy portfolio result without adding diagnostics fields',async()=>{
  const state=openStateDb(':memory:');try{const store=new ResearchStore(state.db),svc=new ResearchService(store),datasets=['BTCUSDT','SOLUSDT'].map(symbol=>({...fixture(),symbol})),members=datasets.map(data=>({data,id:store.putDataset(data).id})),universe=buildUniverse({symbols:['BTCUSDT','SOLUSDT'],timeframe:'1h',from_ms:1,to_ms:2000000000000,market_factor:{kind:'btc',symbols:['BTCUSDT']}},members);store.putUniverse(universe);store.putStudy(study(universe.id));
   const {dataset_id:_,...base}=params(),r={...base,universe_id:universe.id,arms:['a_rules'] as ['a_rules']},row=store.create(r,null,identity,''),out=await runPortfolio({universe,datasets},r,async()=>{throw new Error('no model');},{diagnostics:false});expect(out.arms[0]).not.toHaveProperty('diagnostics');expect(out.arms[0]!.trades[0]).not.toHaveProperty('mae_r');store.db.prepare('UPDATE research_runs SET manifest_json=? WHERE id=?').run(JSON.stringify({...row.manifest,request:r}),row.id);store.status(row.id,'completed',out);expect((await svc.replay(row.id)).verified).toBe(true);
  }finally{state.close();}
 });
 it('separates stop risk and sizing ablations and enforces the two-leaf draft budget',async()=>{
  const state=openStateDb(':memory:');try{const store=new ResearchStore(state.db),svc=new ResearchService(store),id=store.putDataset(fixture()).id;store.putStudy(study(id));const {policy:_,...base}=params(id),ir=defaultIR();delete ir.regime;ir.signal=[node('volume_surge',{lookback:5,multiple:0})];ir.exit=[node('chandelier_trail',{atr_period:5,multiple:2}),node('fixed_r_target',{r:2},true)];const a={...base,strategy_ir:ir,arms:['a_rules'] as ['a_rules']},parent=store.create(a,null,identity,'');store.status(parent.id,'completed',await runReplay(fixture(),a,async()=>{throw new Error('no model');}));
   const changed=structuredClone(ir);changed.risk.stop.params.multiple=3;changed.risk.sizing.params.fraction='0.02';
   const draft=await researchTool({tool:'policy.draft',args:{parent_run_id:parent.id,strategy_ir:changed}},svc,()=>{throw new Error('no launch');}) as {changes:unknown[];request_template:typeof a};expect(draft.changes).toHaveLength(2);
   const b=draft.request_template,child=store.create(b,null,identity,'');store.status(child.id,'completed',await runReplay(fixture(),b,async()=>{throw new Error('no model');}));const result=await svc.attribution(child.id);expect(result.components.map(c=>c.section)).toEqual(['risk','sizing']);expect(result.interaction+result.components.reduce((s,c)=>s+c.delta,0)).toBeCloseTo(result.child_net_return-result.base_net_return,12);
   changed.exit[0]!.params.multiple=4;await expect(researchTool({tool:'policy.draft',args:{parent_run_id:parent.id,strategy_ir:changed}},svc,()=>{})).rejects.toThrow('max_two_economic_changes');
  }finally{state.close();}
 });
});

it('replays pre-round3 IR recordings with no added structure evidence or changed trailing reason',async()=>{
 const state=openStateDb(':memory:');try{
  const store=new ResearchStore(state.db),svc=new ResearchService(store),data=fixture(),id=store.putDataset(data).id;store.putStudy(study(id));
  const ir=defaultIR();delete ir.regime;ir.signal=[node('volume_surge',{lookback:5,multiple:0})];ir.exit=[node('chandelier_trail',{atr_period:5,multiple:2}),node('fixed_r_target',{r:2},true)];
  const {policy:_,...base}=params(id),raw={...base,strategy_ir:ir,arms:['b_agent'] as ['b_agent'],repeats:1},row=store.create(raw,null,identity,'');
  const result=await runReplay(data,raw,async()=>({action:'no_trade',reason:'frozen old reply',gate_errors:[],evidence_refs:[]}),{legacy:true});
  expect(result.recordings[0]!.input).not.toHaveProperty('htf_structure');
  store.db.prepare('UPDATE research_runs SET manifest_json=? WHERE id=?').run(JSON.stringify({...row.manifest,adapter_version:'spot-research-v1/old',request:raw}),row.id);store.status(row.id,'completed',result);
  expect((await svc.replay(row.id)).verified).toBe(true);
 }finally{state.close();}
});
