import { attributeRuns } from './attribution.js';
import { resolveRequest, compileConstraints, policyToIR } from './strategy.js';
import { specText } from './strategy-spec.js';
import { DEFAULT_ORDER_GATE } from './order-gate.js';
import type { Brain } from '../brain.js';
import type { ResearchRequest } from '@trading-swarm/contracts';
import { ADAPTER_VERSION, budgetBrain, makeDecider, timeframe } from './agent.js';
import { runReplay, StopRun, type RecordedDecision } from './engine.js';
import { hash, request } from './primitives.js';
import { ResearchStore, type RunRow, type Manifest } from './store.js';
import { runPortfolio } from './portfolio.js';
import { selectionEvaluation } from './evaluation.js';
import type { StrategySpec } from '../strategies.js';
export class ResearchService {
  private active:string|null=null;private cancelled=new Set<string>();
  constructor(readonly store:ResearchStore,private emit:(data:unknown)=>void=()=>{}){store.recover();}
  get active_run_id(){return this.active;}
  async estimate(raw:ResearchRequest) {
    const d=this.store.dataFor(raw);this.store.validateRequest(raw);timeframe(d.timeframe_ms);
    const bars=d.bars.filter(b=>b.close_time>=raw.from_ms&&b.close_time<=raw.to_ms).length;
    // Conservative all-bar bound includes one repair per decision and all repeats.
    return {bars,upper_model_calls:Math.max(0,bars-1)*(raw.universe_id?this.store.universe(raw.universe_id).members.length:1)*raw.arms.filter(a=>a!=='a_rules').length*raw.repeats*2,hard_model_call_cap:raw.max_model_calls,timeout_ms:raw.timeout_ms,price:null,price_note:'沿用已选 CLI/模型；未知订阅单价不虚构成本。预算耗尽标 incomplete，不当作完整业绩。'};
  }
  start(raw:ResearchRequest,brain:Brain,identity:Manifest['brain'],source:StrategySpec|null,playbook:string):RunRow {
    const prior=this.store.byKey(raw.idempotency_key,raw);if(prior)return prior;
    if(this.active)throw new Error(`research_busy:${this.active}`);
    timeframe(this.store.dataFor(raw).timeframe_ms);
    const row=this.store.create(raw,source,identity,playbook);this.active=row.id;
    // Claim synchronously before yielding, so two HTTP calls cannot start duplicate jobs.
    void this.execute(row,brain).catch(e=>{this.store.status(row.id,'failed');this.publish(row.id,'failed',{error:String(e)});}).finally(()=>{this.active=null;this.cancelled.delete(row.id);});
    return this.store.get(row.id)!;
  }
  cancel(id:string):RunRow {const row=this.store.get(id);if(!row)throw new Error('run_not_found');if(this.active===id){this.cancelled.add(id);this.store.status(id,'cancelling');this.publish(id,'cancelling',{note:'当前模型调用返回/超时后停止；不启动下一个调用'});}return this.store.get(id)!;}
  private publish(id:string,event:string,data:Record<string,unknown>){this.emit(this.store.event(id,event,data));}
  private async execute(row:RunRow,brain:Brain):Promise<void> {
    const r=row.manifest.request,d=this.store.dataFor(r),deadline=Date.now()+r.timeout_ms;
    this.store.status(row.id,'running');this.publish(row.id,'running',{engine:row.manifest.engine_version});
    const wrapped=budgetBrain(brain,{max_calls:r.max_model_calls,deadline,model_call_timeout_ms:r.model_call_timeout_ms,cancelled:()=>this.cancelled.has(row.id),save:t=>this.store.trace(row.id,t)});
    const runner=r.universe_id?runPortfolio.bind(null,this.store.portfolio(r.universe_id)):runReplay.bind(null,d);
    const resolved=resolveRequest(r),specs=r.spec_version?(()=>{const c=compileConstraints(timeframe(d.timeframe_ms),d,resolved.execution,r.order_gate??DEFAULT_ORDER_GATE,r.strategy_ir??policyToIR(resolved.policy,resolved.execution));return {b:specText(c,'b_agent'),c:specText(c,'c_filter')};})():undefined;
    const result=await runner(r,makeDecider(wrapped,resolved.execution,row.manifest.source_strategy,row.manifest.playbook,specs),{diagnostics:true,check:()=>{if(this.cancelled.has(row.id))throw new StopRun('cancelled','user_cancelled');if(Date.now()>deadline)throw new StopRun('budget_exhausted','wall_clock_budget');},event:(e,data)=>{if(e!=='decision')this.publish(row.id,e,data);}});
    if(result.status==='completed'&&!r.universe_id&&!r.strategy_ir)result.evaluation=selectionEvaluation(d,r,result);
    this.store.status(row.id,result.status,result);this.publish(row.id,result.status,{arms:result.arms.map(a=>({arm:a.arm,metrics:a.metrics})),error:result.error});
  }
  async attribution(id:string){const row=this.store.get(id);if(!row)throw new Error('run_not_found');const deadline=Date.now()+120000;return attributeRuns(this.store,row,()=>{if(Date.now()>deadline)throw new Error('attribution_time_budget');});}
  async replay(id:string) {
    const row=this.store.get(id);if(!row?.result||row.status!=='completed')throw new Error('completed_run_required');
    const recordings:RecordedDecision[]=row.result.recordings;
    const r=row.manifest.request,runner=r.universe_id?runPortfolio.bind(null,this.store.portfolio(r.universe_id)):runReplay.bind(null,this.store.dataFor(r));
    const options={replay:recordings,legacy:row.manifest.adapter_version!==ADAPTER_VERSION,diagnostics:row.result.arms.some(a=>!!a.diagnostics)};
    const expected=hash(row.result.arms);let result=await runner(r,async()=>{throw new Error('replay_must_not_call_model');},options),actual=hash(result.arms);
    // Earlier IR recordings predate target_r. Try their original signal-price anchor without models;
    // accept only a full frozen result hash match, including A-only runs with no recording evidence.
    if(actual!==expected&&r.strategy_ir?.exit.some(x=>x.primitive==='fixed_r_target')){const prior=await runner(r,async()=>{throw new Error('replay_must_not_call_model');},{...options,legacyTargetAnchor:true});const priorHash=hash(prior.arms);if(priorHash===expected){result=prior;actual=priorHash;}}
    return {run_id:id,verified:expected===actual,status:result.status,expected_hash:expected,actual_hash:actual,model_calls:0};
  }
}
export function runSummary(row:RunRow) {
  return {id:row.id,status:row.status,created_at:row.created_at,updated_at:row.updated_at,manifest:row.manifest,metrics:row.result?.arms.map(a=>({arm:a.arm,metrics:a.metrics}))??[],error:row.result?.error??null,result_ready:!!row.result};
}
