import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { ResearchBar, ResearchDataset, ResearchExecution, ResearchRequest, ResearchStudy } from '@trading-swarm/contracts';
import { SpotLedger } from '../../../src/demo/research/ledger.js';
import { runReplay, type AgentAction, type DecisionView } from '../../../src/demo/research/engine.js';
import { budgetBrain, contextFor } from '../../../src/demo/research/agent.js';
import { clone, dataset, q } from '../../../src/demo/research/primitives.js';
import { ResearchStore } from '../../../src/demo/research/store.js';
import { ResearchService } from '../../../src/demo/research/service.js';
import { researchTool, researchChat } from '../../../src/demo/research/tools.js';
import type { Brain } from '../../../src/demo/brain.js';

const STEP=60_000;
const bar=(i:number,o='100',h='102',l='98',c='100'):ResearchBar=>({open_time:i*STEP,close_time:(i+1)*STEP-1,available_at:(i+1)*STEP-1,open:o,high:h,low:l,close:c,volume:'100'});
const execution:ResearchExecution={initial_cash:'10000',risk_fraction:'0.01',max_allocation:'1',fee_rate:'0.001',slippage_bps:'10',qty_step:'0.001',min_notional:'1',max_opens_per_day:100};
const policy:ResearchRequest['policy']={label:'audit',description:'deterministic breakout',interpretation:'donchian_close_long_v1',lookback:2,atr_period:2,stop_atr:1,take_profit_r:3,volume_multiple:1,holding_bars:2};
function data():ResearchDataset {return {venue:'synthetic',market:'spot',symbol:'AUDITUSDT',timeframe_ms:STEP,source:'adversarial offline fixture',retrieved_at:100*STEP,bars:Array.from({length:40},(_,i)=>bar(i))};}
function req(overrides:Partial<ResearchRequest>={}):ResearchRequest {return {idempotency_key:'audit1',study_id:'study1',dataset_id:'pending',policy:clone(policy),execution:clone(execution),from_ms:3*STEP-1,to_ms:9*STEP-1,arms:['a_rules'],repeats:1,max_model_calls:30,timeout_ms:10000,purpose:'development',acknowledge_adaptive_search:false,...overrides};}
const action=(kind:AgentAction['action'],reason='audit'):AgentAction=>({action:kind,reason,gate_errors:[],evidence_refs:[]});
const brain:Brain={name:'stub',complete:async()=>({text:'{}',model:'stub',input_tokens:1,output_tokens:1,latency_ms:1})};
const dbs:DatabaseSync[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();});
function stored() {
  const db=new DatabaseSync(':memory:');dbs.push(db);db.exec(readFileSync(new URL('../../../src/migrations/0025_research_workbench.sql',import.meta.url),'utf8'));
  const store=new ResearchStore(db),id=store.putDataset(data()).id;
  const study:ResearchStudy={id:'study1',dataset_id:id,from_ms:3*STEP-1,development_to_ms:9*STEP-1,validation_from_ms:13*STEP-1,validation_to_ms:20*STEP-1,holdout_from_ms:24*STEP-1,to_ms:35*STEP-1,purge_bars:2,max_trials:6};
  store.putStudy(study);
  const identity={kind:'stub' as const,model:null,name:'stub',configuration_hash:'offline-fixture'};
  return {store,study,id,identity};
}

describe('research adversarial: execution and net cash',()=>{
  it('a close-based entry and agent exit both fill at the NEXT open',async()=>{
    const d=data();d.bars[3]=bar(3,'105','106','103','104');d.bars[4]=bar(4,'111','112','109','110');
    const r=req({arms:['b_agent'],policy:{...policy,holding_bars:20}});
    const result=await runReplay(d,r,async v=>v.at===r.from_ms?{...action('enter'),entry:{candidate_id:'b',stop:'90',target:'200',reason:'audit'}}:v.position?action('exit'):action('no_trade'));
    expect(result.status).toBe('completed');const t=result.arms[0]!.trades[0]!;
    expect(t.entry_at).toBe(d.bars[3]!.open_time);expect(t.exit_at).toBe(d.bars[4]!.open_time);
    expect(t.entry_price).toBe('105.10500000');expect(t.exit_price).toBe('110.88900000');
  });
  it('gap stop wins over pending agent exit and executes at open with adverse slippage',()=>{
    const l=new SpotLedger(execution);l.pending={action:'enter',entry:{candidate_id:'x',stop:'95',target:'130',reason:'audit'}};l.step(bar(0));
    l.pending={action:'exit',reason:'agent_exit'};l.step(bar(1,'90','93','88','91'));
    expect(l.trades).toHaveLength(1);expect(l.trades[0]).toMatchObject({reason:'stop',timing:'open',exit_price:'89.91000000'});
    expect(l.cash-q(execution.initial_cash)).toBe(q(l.trades[0]!.net_pnl));
  });
  it('same-bar stop/target collision always chooses the stop',()=>{
    const l=new SpotLedger(execution);l.pending={action:'enter',entry:{candidate_id:'x',stop:'95',target:'110',reason:'audit'}};l.step(bar(0,'100','120','90','100'));
    expect(l.trades[0]!.reason).toBe('stop');expect(l.trades[0]!.timing).toBe('intrabar_unknown');
  });
  it('cash and fee ledger reconcile after partial reduction and final exit',()=>{
    const l=new SpotLedger({...execution,qty_step:'0.000001'});l.pending={action:'enter',entry:{candidate_id:'x',stop:'90',target:'200',reason:'audit'}};l.step(bar(0));
    l.pending={action:'reduce',reason:'agent_reduce'};l.step(bar(1,'110','112','108','111'));
    l.pending={action:'exit',reason:'agent_exit'};l.step(bar(2,'105','108','104','106'));
    expect(l.position).toBeNull();expect(l.trades).toHaveLength(2);
    expect(l.trades.reduce((a,t)=>a+q(t.net_pnl),0n)).toBe(l.cash-q(execution.initial_cash));
    expect(l.trades.reduce((a,t)=>a+q(t.fees),0n)).toBe(l.fees);
  });
  it('fees cannot create negative cash even at 100% allocation',()=>{
    const l=new SpotLedger({...execution,risk_fraction:'0.1',max_allocation:'1',fee_rate:'0.05',qty_step:'0.00000001'});l.pending={action:'enter',entry:{candidate_id:'x',stop:'99',target:'200',reason:'audit'}};l.step(bar(0,'100','101','99.5','100'));
    expect(l.cash).toBeGreaterThanOrEqual(0n);expect(l.equity.at(-1)!.equity).not.toBe(execution.initial_cash);
  });
  it('fractional entry basis is conserved to the last fixed-point unit across partial exits',()=>{
    const l=new SpotLedger({...execution,slippage_bps:'0',qty_step:'0.00000001'});
    l.pending={action:'enter',entry:{candidate_id:'x',stop:'90',target:'200',reason:'audit'}};
    l.step(bar(0,'100.12345678','102','98','100'));
    l.pending={action:'reduce',reason:'agent_reduce'};l.step(bar(1,'110.12345678','112','108','111'));
    l.pending={action:'exit',reason:'agent_exit'};l.step(bar(2,'105.12345678','108','104','106'));
    expect(l.trades.reduce((a,t)=>a+q(t.net_pnl),0n)).toBe(l.cash-q(execution.initial_cash));
  });
});

describe('research adversarial: decider boundary and isolation',()=>{
  it('future suffix never reaches adapter; mutations cannot affect later repeats or dataset',async()=>{
    const d=data(),before=clone(d);const firsts:DecisionView[]=[];
    const out=await runReplay(d,req({arms:['b_agent'],repeats:2}),async v=>{
      expect(v.bars.every(b=>b.close_time<=v.at&&b.available_at<=v.at)).toBe(true);
      if(v.at===3*STEP-1)firsts.push(clone(v));v.bars[0]!.close='999999';v.account.cash='0';
      return action('no_trade','private-memory');
    });
    expect(out.status).toBe('completed');expect(d).toEqual(before);expect(firsts).toHaveLength(2);
    for(const v of firsts){expect(v.previous_summary).toBeNull();expect(v.account.cash).toBe('10000.00000000');}
    expect(out.arms[0]!.equity).toEqual(out.arms[1]!.equity);
  });
  it('C ignores a malicious FOLLOW payload changing stop and target',async()=>{
    const d=data();d.bars[2]=bar(2,'100','106','99','105');
    const result=await runReplay(d,req({arms:['a_rules','c_filter']}),async()=>({...action('follow'),entry:{candidate_id:'evil',stop:'1',target:'999999',reason:'attack'}}));
    expect(result.status).toBe('completed');expect(result.arms[1]!.trades).toEqual(result.arms[0]!.trades);
    expect(result.arms[1]!.equity).toEqual(result.arms[0]!.equity);
  });
  it('C rejects injected enter/exit actions rather than changing account state',async()=>{
    const d=data();d.bars[2]=bar(2,'100','106','99','105');
    const result=await runReplay(d,req({arms:['c_filter']}),async()=>({...action('enter'),entry:{candidate_id:'evil',stop:'90',target:'200',reason:'attack'}}));
    expect(result.status).toBe('completed');expect(result.arms[0]!.trades).toHaveLength(0);
    expect(result.arms[0]!.decisions.some(x=>x.action==='model_error'&&x.gate_errors.includes('filter_only_follow_skip'))).toBe(true);
  });
  it('recorded replay needs no model and reproduces all arm results',async()=>{
    const d=data(),r=req({arms:['b_agent'],repeats:2});const initial=await runReplay(d,r,async()=>action('no_trade'));
    const replay=await runReplay(d,r,async()=>{throw new Error('model must not run');},{replay:initial.recordings});
    expect(replay.status).toBe('completed');expect(replay.arms).toEqual(initial.arms);
    const changed=clone(initial.recordings);changed[0]!.input.account.cash='1';
    const tampered=await runReplay(d,r,async()=>action('no_trade'),{replay:changed});expect(tampered.status).toBe('failed');
  });
  it('dataset import rejects missing and incomplete bars before any replay',()=>{
    const gap=data();gap.bars.splice(3,1);expect(()=>dataset(gap)).toThrow('gap');
    const future=data();future.bars[4]!.available_at++;expect(()=>dataset(future)).toThrow('requires_close_available');
  });
  it('context builder rejects an explicitly injected future candle',()=>{
    const v:DecisionView={at:STEP-1,arm:'b_agent:0',symbol:'AUDITUSDT',timeframe_ms:STEP,bars:[bar(0),bar(1)],policy,candidate:null,account:{cash:'10000',equity:'10000'},position:null,previous_summary:null,opens_today:0};
    expect(()=>contextFor(v,null,'')).toThrow('future_input');
  });
});

describe('research adversarial: identity, seal and tool permissions',()=>{
  it('same idempotency key returns exactly the frozen run, changed payload conflicts',()=>{
    const {store,id,identity}=stored();const r=req({dataset_id:id}),a=store.create(r,null,identity,'old');
    expect(store.create(r,null,identity,'new')).toEqual(a);
    expect(()=>store.create({...r,policy:{...policy,stop_atr:2}},null,identity,'')).toThrow('idempotency_conflict');
    expect(store.list()).toHaveLength(1);
  });
  it('holdout creation seals subsequent trials while identical retries remain idempotent',()=>{
    const {store,id,identity,study}=stored();const r=req({dataset_id:id,purpose:'holdout',from_ms:study.holdout_from_ms,to_ms:study.to_ms});
    const sealed=store.create(r,null,identity,'');expect(store.create(r,null,identity,'').id).toBe(sealed.id);
    expect(()=>store.create(req({dataset_id:id,idempotency_key:'later',acknowledge_adaptive_search:true}),null,identity,'')).toThrow('study_sealed_after_holdout');
  });
  it('study is immutable and cannot weaken its purge after registration',()=>{
    const {store,study}=stored();expect(()=>store.putStudy({...study,purge_bars:1})).toThrow('study_immutable');
  });
  it('unregistered exchange/shell tools fail schema validation without calling launch',async()=>{
    const {store}=stored(),svc=new ResearchService(store),launch=vi.fn();
    await expect(researchTool({tool:'execd.place_order',args:{}} as never,svc,launch)).rejects.toThrow('invalid_contract');expect(launch).not.toHaveBeenCalled();
  });
  it('candidate tool cannot use a holdout parent',async()=>{
    const {store,id,study,identity}=stored();const row=store.create(req({dataset_id:id,purpose:'holdout',from_ms:study.holdout_from_ms,to_ms:study.to_ms}),null,identity,'');store.status(row.id,'completed');
    const svc=new ResearchService(store),launch=vi.fn();
    await expect(researchTool({tool:'experiments.run_candidate',args:{parent_run_id:row.id,policy:{...policy,stop_atr:2}}},svc,launch)).rejects.toThrow('completed_development_parent_required');expect(launch).not.toHaveBeenCalled();
  });
  it('candidate tool preserves execution, model budget, data and development window',async()=>{
    const {store,id,identity}=stored(),r=req({dataset_id:id});const row=store.create(r,null,identity,'');store.status(row.id,'completed');
    const svc=new ResearchService(store),launch=vi.fn();
    await researchTool({tool:'experiments.run_candidate',args:{parent_run_id:row.id,policy:{...policy,stop_atr:2},execution:{initial_cash:'99999999'},max_model_calls:99999,purpose:'holdout'}},svc,launch);
    expect(launch).toHaveBeenCalledTimes(1);const passed=launch.mock.calls[0]![0] as ResearchRequest;
    expect(passed.execution).toEqual(row.manifest.request.execution);expect(passed.max_model_calls).toBe(r.max_model_calls);expect(passed.dataset_id).toBe(r.dataset_id);
    expect([passed.purpose,passed.from_ms,passed.to_ms]).toEqual([r.purpose,r.from_ms,r.to_ms]);
  });
  it('candidate tool enforces the advertised two-economic-parameter change budget',async()=>{
    const {store,id,identity}=stored();const row=store.create(req({dataset_id:id}),null,identity,'');store.status(row.id,'completed');
    const svc=new ResearchService(store),launch=vi.fn();
    await expect(researchTool({tool:'experiments.run_candidate',args:{parent_run_id:row.id,policy:{...policy,stop_atr:2,take_profit_r:4,volume_multiple:2}}},svc,launch)).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
  });
  it('the second repair call cannot exceed the hard model budget',async()=>{
    const calls=vi.fn(brain.complete),traces:unknown[]=[];
    const wrapped=budgetBrain({...brain,complete:calls},{max_calls:1,deadline:Date.now()+10000,cancelled:()=>false,save:t=>traces.push(t)});
    await wrapped.complete('s','u');await expect(wrapped.complete('s','repair')).rejects.toThrow('model_or_time_budget');
    expect(calls).toHaveBeenCalledTimes(1);expect(traces).toHaveLength(2);
  });
  it('cancelled run cannot initiate a model call',async()=>{
    const calls=vi.fn(brain.complete);const wrapped=budgetBrain({...brain,complete:calls},{max_calls:2,deadline:Date.now()+10000,cancelled:()=>true,save:()=>{}});
    await expect(wrapped.complete('s','u')).rejects.toThrow('cancelled');expect(calls).not.toHaveBeenCalled();
  });
  it('research chat never claims a rejected experiment was successfully started',async()=>{
    const {store}=stored(),svc=new ResearchService(store),launch=vi.fn();
    const scripted:Brain={...brain,complete:async()=>({...await brain.complete('',''),text:JSON.stringify({tool:'experiments.run_candidate',args:{parent_run_id:'missing',policy:{...policy,stop_atr:2}}})})};
    const response=await researchChat({message:'优化这个策略',max_rounds:1},svc,scripted,launch,{root:'/tmp/research-r3-chat-tests'});
    expect(launch).not.toHaveBeenCalled();expect(response.final).not.toContain('已发起');
    expect(response.trace[0]!.result).toHaveProperty('error');
  });
  it('first-experiment tool cannot autonomously open a holdout window',async()=>{
    const {store,id,study}=stored(),svc=new ResearchService(store),launch=vi.fn();
    await expect(researchTool({tool:'experiments.start',args:{request:req({dataset_id:id,purpose:'holdout',from_ms:study.holdout_from_ms,to_ms:study.to_ms})}},svc,launch)).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
  });
  it('first-experiment tool cannot bypass candidate constraints on an existing study',async()=>{
    const {store,id,identity}=stored();const prior=store.create(req({dataset_id:id}),null,identity,'');store.status(prior.id,'completed');
    const svc=new ResearchService(store),launch=vi.fn();
    const attack=req({dataset_id:id,idempotency_key:'bypass',acknowledge_adaptive_search:true,max_model_calls:5000,policy:{...policy,stop_atr:2,take_profit_r:4,volume_multiple:2}});
    await expect(researchTool({tool:'experiments.start',args:{request:attack}},svc,launch)).rejects.toThrow();expect(launch).not.toHaveBeenCalled();
  });
  it('first-experiment permission check is not defeated by 100 newer runs',async()=>{
    const {store,id,identity,study}=stored();const old=store.create(req({dataset_id:id}),null,identity,'');store.status(old.id,'completed');
    store.db.prepare('UPDATE research_runs SET created_at=0 WHERE id=?').run(old.id);
    for(let i=0;i<100;i++) {
      const studyId=`other_${i}`;store.putStudy({...study,id:studyId});
      const r=store.create(req({dataset_id:id,study_id:studyId,idempotency_key:`other_key_${i}`}),null,identity,'');store.status(r.id,'completed');
    }
    expect(store.list().some(x=>x.id===old.id)).toBe(false);
    const svc=new ResearchService(store),launch=vi.fn();
    await expect(researchTool({tool:'experiments.start',args:{request:req({dataset_id:id,idempotency_key:'overflow-bypass',acknowledge_adaptive_search:true})}},svc,launch)).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
  });
  it('model failure after a tool round does not leave a permanently running chat',async()=>{
    const {store}=stored(),svc=new ResearchService(store);let calls=0;
    const scripted:Brain={...brain,complete:async()=>{
      if(calls++>0)throw new Error('offline_model_failure');
      return {...await brain.complete('',''),text:JSON.stringify({tool:'runs.list',args:{}})};
    }};
    await researchChat({message:'诊断',max_rounds:2},svc,scripted,()=>null,{root:'/tmp/research-r3-chat-tests'}).catch(()=>undefined);
    const rows=store.db.prepare('SELECT json FROM research_chats').all() as {json:string}[];
    expect(rows).toHaveLength(1);expect(JSON.parse(rows[0]!.json).status).toBe('failed');
  });
});
