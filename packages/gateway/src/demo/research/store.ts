import { STRATEGY_SPEC_VERSION } from './strategy-spec.js';
import { DEFAULT_ORDER_GATE } from './order-gate.js';
import { requestHorizon } from './strategy.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ResearchDataset, ResearchRequest, ResearchStudy, ResearchEvent, ResearchPolicy, ResearchUniverse } from '@trading-swarm/contracts';
import type { StrategySpec } from '../strategies.js';
import type { BrainKind } from '../types.js';
import { assertContract, dataset, hash, clone, request, ENGINE_VERSION } from './primitives.js';
import { ADAPTER_VERSION, type ModelTrace } from './agent.js';
import type { RunResult } from './engine.js';
export interface Manifest {engine_version:string;adapter_version:string;request:ResearchRequest;dataset_hash:string;policy_hash:string;source_strategy:StrategySpec|null;brain:{kind:BrainKind;model:string|null;name:string;configuration_hash:string};playbook:string;trial_number:number;created_at:number;hash:string;}
export interface RunRow {id:string;status:string;created_at:number;updated_at:number;manifest:Manifest;result:RunResult|null;}
export class ResearchStore {
  constructor(readonly db:DatabaseSync){}
  putDataset(raw:unknown,allowGaps=false):{id:string;bars:number} {const d=dataset(raw,allowGaps),id=hash(d);this.db.prepare('INSERT OR IGNORE INTO research_datasets VALUES (?,?,?)').run(id,Date.now(),JSON.stringify(d));return {id,bars:d.bars.length};}
  putMarketDataset(raw:ResearchDataset,allowGaps=false) {
    const d=dataset(raw,allowGaps),{retrieved_at:_,...content}=d,key=hash(content);
    const prior=this.db.prepare('SELECT dataset_id FROM research_market_snapshots WHERE content_hash=?').get(key) as {dataset_id:string}|undefined;
    if(prior){const saved=this.dataset(prior.dataset_id);return {id:prior.dataset_id,bars:saved.bars.length};}
    // Reuse snapshots imported before the content index existed, preserving original provenance.
    const existing=this.db.prepare("SELECT id,json FROM research_datasets WHERE json_extract(json,'$.symbol')=? AND json_extract(json,'$.timeframe_ms')=?").all(d.symbol,d.timeframe_ms) as {id:string;json:string}[];
    const match=existing.find(row=>{const {retrieved_at:__,...old}=JSON.parse(row.json) as ResearchDataset;return hash(old)===key;});
    const put=match?{id:match.id,bars:d.bars.length}:this.putDataset(d,allowGaps);
    this.db.prepare('INSERT OR IGNORE INTO research_market_snapshots VALUES (?,?)').run(key,put.id);
    return put;
  }
  putUniverse(u:ResearchUniverse):ResearchUniverse {
    assertContract<ResearchUniverse>(u);
    this.db.prepare('INSERT OR IGNORE INTO research_universes VALUES (?,?,?)').run(u.id,Date.now(),JSON.stringify(u));
    return this.universe(u.id);
  }
  universe(id:string):ResearchUniverse {
    const row=this.db.prepare('SELECT json FROM research_universes WHERE id=?').get(id) as {json:string}|undefined;
    if(!row)throw new Error('universe_not_found');
    const u=JSON.parse(row.json) as ResearchUniverse;
    if(hash({members:u.members.map(m=>({symbol:m.symbol,dataset_id:m.dataset_id})),market_factor:u.market_factor,...(u.filter?{filter:u.filter,selection_as_of:u.selection_as_of,eligibility:u.eligibility}:{})})!==id)throw new Error('universe_hash_mismatch');
    return u;
  }
  universes() {
    return (this.db.prepare('SELECT id FROM research_universes ORDER BY created_at DESC LIMIT 100').all() as {id:string}[]).map(row=>{const {aligned_close_times:_,missing:__,...summary}=this.universe(row.id);return summary;});
  }
  draft(raw:unknown) {assertContract<ResearchPolicy>(raw);if(!('interpretation' in raw))throw new Error('expected_policy');const id=hash(raw);this.db.prepare('INSERT OR IGNORE INTO research_policy_drafts VALUES (?,?,?)').run(id,Date.now(),JSON.stringify(raw));return {id,policy:clone(raw),status:'draft',trading_enabled:false};}
  datasets(){return (this.db.prepare('SELECT id,created_at,json FROM research_datasets ORDER BY created_at DESC LIMIT 100').all() as {id:string;created_at:number;json:string}[]).map(x=>{const d=JSON.parse(x.json) as ResearchDataset;return {id:x.id,created_at:x.created_at,venue:d.venue,market:d.market,symbol:d.symbol,source:d.source,timeframe_ms:d.timeframe_ms,bars:d.bars.length,first_at:d.bars[0]?.close_time,last_at:d.bars.at(-1)?.close_time};});}
  dataset(id:string):ResearchDataset {const r=this.db.prepare('SELECT json FROM research_datasets WHERE id=?').get(id) as {json:string}|undefined;if(!r)throw new Error('dataset_not_found');const d=JSON.parse(r.json) as ResearchDataset;if(hash(d)!==id)throw new Error('dataset_hash_mismatch');return d;}
  dataFor(r:Pick<ResearchRequest,'dataset_id'|'universe_id'>):ResearchDataset {
    if(r.universe_id){const u=this.universe(r.universe_id),d=this.dataset(u.members[0]!.dataset_id),times=new Set(u.aligned_close_times);return {...d,bars:d.bars.filter(b=>times.has(b.close_time))};}
    if(!r.dataset_id)throw new Error('dataset_or_universe_required');return this.dataset(r.dataset_id);
  }
  portfolio(id:string){const universe=this.universe(id);return {universe,datasets:universe.members.map(m=>this.dataset(m.dataset_id))};}
  validateRequest(raw:ResearchRequest){return request(raw,this.dataFor(raw),!!raw.universe_id);}
  putStudy(raw:unknown):ResearchStudy {
    assertContract<ResearchStudy>(raw);if(!('purge_bars' in raw))throw new Error('expected_study');const s=raw;
    const isDataset=!!this.db.prepare('SELECT id FROM research_datasets WHERE id=?').get(s.dataset_id);
    const d=this.dataFor(isDataset?{dataset_id:s.dataset_id}:{universe_id:s.dataset_id});
    const ends=[s.from_ms,s.development_to_ms,s.validation_from_ms,s.validation_to_ms,s.holdout_from_ms,s.to_ms];
    if(ends.some((x,i)=>!d.bars.some(b=>b.close_time===x)||(i>0&&x<=ends[i-1]!)))throw new Error('study_windows_invalid');
    const indexes=ends.map(t=>d.bars.findIndex(b=>b.close_time===t));
    if(indexes[2]!-indexes[1]!<=s.purge_bars||indexes[4]!-indexes[3]!<=s.purge_bars)throw new Error('study_purge_gap_required');
    const gap=s.purge_bars*d.timeframe_ms;
    if(s.validation_from_ms-s.development_to_ms<=gap||s.holdout_from_ms-s.validation_to_ms<=gap)throw new Error('study_purge_gap_required');
    const prior=this.study(s.id);if(prior){if(hash(prior)!==hash(s))throw new Error('study_immutable');return prior;}
    this.db.prepare('INSERT INTO research_studies VALUES (?,?,?)').run(s.id,Date.now(),JSON.stringify(s));return clone(s);
  }
  study(id:string):ResearchStudy|null {const x=this.db.prepare('SELECT json FROM research_studies WHERE id=?').get(id) as {json:string}|undefined;return x?JSON.parse(x.json) as ResearchStudy:null;}
  hasStudyRuns(id:string):boolean{return !!this.db.prepare('SELECT 1 FROM research_runs WHERE study_id=? LIMIT 1').get(id);}
  sealed(id:string):boolean{return !!this.db.prepare("SELECT 1 FROM research_runs WHERE study_id=? AND json_extract(manifest_json,'$.request.purpose')='holdout' LIMIT 1").get(id);}
  summaries(){return (this.db.prepare('SELECT id,status,created_at,updated_at,manifest_json,summary_json FROM research_runs ORDER BY created_at DESC LIMIT 100').all() as {id:string;status:string;created_at:number;updated_at:number;manifest_json:string;summary_json:string|null}[]).map(x=>({id:x.id,status:x.status,created_at:x.created_at,updated_at:x.updated_at,manifest:JSON.parse(x.manifest_json) as Manifest,...(x.summary_json?JSON.parse(x.summary_json) as {metrics:unknown[];error:string|null;result_ready:boolean}:{metrics:[],error:null,result_ready:false})}));}
  studyRuns(id:string):RunRow[]{return (this.db.prepare('SELECT id FROM research_runs WHERE study_id=? ORDER BY created_at').all(id) as {id:string}[]).map(x=>this.get(x.id)!);}
  list():RunRow[]{return (this.db.prepare('SELECT id FROM research_runs ORDER BY created_at DESC LIMIT 100').all() as {id:string}[]).map(x=>this.get(x.id)!);}
  get(id:string):RunRow|null {const x=this.db.prepare('SELECT * FROM research_runs WHERE id=?').get(id) as {id:string;status:string;created_at:number;updated_at:number;manifest_json:string;result_json:string|null}|undefined;return x?{id:x.id,status:x.status,created_at:x.created_at,updated_at:x.updated_at,manifest:JSON.parse(x.manifest_json) as Manifest,result:x.result_json?JSON.parse(x.result_json) as RunResult:null}:null;}
  byKey(key:string,raw:ResearchRequest):RunRow|null {const x=this.db.prepare('SELECT id,request_hash FROM research_runs WHERE idempotency_key=?').get(key) as {id:string;request_hash:string}|undefined;if(!x)return null;if(x.request_hash!==hash(raw))throw new Error('idempotency_conflict');return this.get(x.id);}
  create(raw:unknown,source:StrategySpec|null,brain:Manifest['brain'],playbook:string):RunRow {
    if(!raw||typeof raw!=='object')throw new Error('expected_request');const r=this.validateRequest({spec_version:STRATEGY_SPEC_VERSION,...(raw as ResearchRequest)});
    const cached=this.byKey(r.idempotency_key,raw as ResearchRequest);if(cached)return cached;
    const study=this.study(r.study_id);if(!study||study.dataset_id!==(r.universe_id??r.dataset_id))throw new Error('study_missing_or_wrong_dataset');
    if((requestHorizon(r)??0)>study.purge_bars)throw new Error('holding_exceeds_preregistered_purge');
    const [lo,hi]=r.purpose==='development'?[study.from_ms,study.development_to_ms]:r.purpose==='validation'?[study.validation_from_ms,study.validation_to_ms]:[study.holdout_from_ms,study.to_ms];
    if(r.from_ms!==lo||r.to_ms!==hi)throw new Error('must_use_entire_preregistered_window');
    const all=(this.db.prepare('SELECT manifest_json FROM research_runs WHERE study_id=?').all(r.study_id) as {manifest_json:string}[]).map(x=>JSON.parse(x.manifest_json) as Manifest);
    if(all.some(x=>x.request.purpose==='holdout'))throw new Error('study_sealed_after_holdout');
    if(all.length>=study.max_trials)throw new Error('study_trial_budget_exhausted');
    if(all.length>0&&!r.acknowledge_adaptive_search)throw new Error('adaptive_search_ack_required');
    if(r.parent_run_id){const parent=this.get(r.parent_run_id);if(!parent||parent.manifest.request.study_id!==r.study_id||parent.status!=='completed'||parent.manifest.request.purpose==='holdout')throw new Error('invalid_parent');}
    r.execution={...r.execution,sizing_mode:r.execution.sizing_mode??'unit_notional'};r.order_gate??={...DEFAULT_ORDER_GATE};
    const created=Date.now();const base={engine_version:r.universe_id?'research-spot-portfolio-v3':r.strategy_ir?'research-spot-ir-v3':'research-spot-next-open-v3',adapter_version:ADAPTER_VERSION,request:r,dataset_hash:(r.universe_id??r.dataset_id)!,policy_hash:hash(r.strategy_ir??r.policy),source_strategy:source?clone(source):null,brain:clone(brain),playbook,trial_number:all.length+1,created_at:created};
    const manifest:Manifest={...base,hash:hash(base)},id=randomUUID();
    this.db.prepare('INSERT INTO research_runs(id,idempotency_key,request_hash,study_id,status,created_at,updated_at,manifest_json,result_json) VALUES (?,?,?,?,?,?,?,?,NULL)').run(id,r.idempotency_key,hash(raw),r.study_id,'queued',created,created,JSON.stringify(manifest));
    this.event(id,'queued',{manifest_hash:manifest.hash,trial_number:manifest.trial_number});return this.get(id)!;
  }
  status(id:string,status:string,result:RunResult|null=null):void {this.db.prepare('UPDATE research_runs SET status=?,updated_at=?,result_json=COALESCE(?,result_json),summary_json=COALESCE(?,summary_json) WHERE id=?').run(status,Date.now(),result?JSON.stringify(result):null,result?JSON.stringify({metrics:result.arms.map(a=>({arm:a.arm,metrics:a.metrics})),error:result.error,result_ready:true}):null,id);}
  event(id:string,event:string,data:Record<string,unknown>):ResearchEvent {const at=Date.now(),r=this.db.prepare('INSERT INTO research_events(run_id,at,event,json) VALUES (?,?,?,?)').run(id,at,event,JSON.stringify(data));return {seq:Number(r.lastInsertRowid),run_id:id,at,event,data};}
  events(id:string,after=0,limit=200):ResearchEvent[] {return (this.db.prepare('SELECT * FROM research_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?').all(id,after,Math.min(500,Math.max(1,limit))) as {seq:number;run_id:string;at:number;event:string;json:string}[]).map(x=>({seq:x.seq,run_id:x.run_id,at:x.at,event:x.event,data:JSON.parse(x.json) as Record<string,unknown>}));}
  trace(id:string,t:ModelTrace){this.db.prepare('INSERT INTO research_model_calls VALUES (?,?,?) ON CONFLICT(run_id,call_index) DO UPDATE SET json=excluded.json').run(id,t.index,JSON.stringify(t));}
  traces(id:string):ModelTrace[]{return (this.db.prepare('SELECT json FROM research_model_calls WHERE run_id=? ORDER BY call_index').all(id) as {json:string}[]).map(x=>JSON.parse(x.json) as ModelTrace);}
  recover():void {for(const x of this.db.prepare("SELECT id FROM research_runs WHERE status IN ('queued','running','cancelling')").all() as {id:string}[]){this.status(x.id,'interrupted');this.event(x.id,'interrupted',{reason:'process_restart_no_automatic_model_replay'});}}
  getChat(id:string){const row=this.db.prepare('SELECT json FROM research_chats WHERE id=?').get(id) as {json:string}|undefined;if(!row)throw Error('chat_not_found');return JSON.parse(row.json) as Record<string,unknown>;}
  artifact(id:string){const row=this.db.prepare('SELECT * FROM research_artifacts WHERE id=?').get(id) as {id:string;chat_id:string;run_id:string|null;kind:string;title:string;content_json:string;created_at:number}|undefined;if(!row)throw Error('artifact_not_found');const {content_json,...meta}=row;return {...meta,content:JSON.parse(content_json) as unknown};}
  putArtifact(chat_id:string,run_id:string|undefined,kind:string,title:string,content:unknown){if(!title||title.length>300)throw Error('invalid_artifact_title');const id=randomUUID(),created_at=Date.now();this.db.prepare('INSERT INTO research_artifacts VALUES (?,?,?,?,?,?,?)').run(id,chat_id,run_id??null,kind,title,JSON.stringify(content),created_at);return {id,kind,title};}
  chat(id:string,body:unknown){this.db.prepare('INSERT INTO research_chats VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(id,Date.now(),JSON.stringify(body));}
}
