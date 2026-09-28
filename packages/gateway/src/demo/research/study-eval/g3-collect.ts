import type { FrozenModelProfile, JudgeCandidateSnapshot, JudgeStateV1, StrategyJudge, ResearchBar } from '@trade-gate/contracts';
import type { DatabaseSync } from 'node:sqlite';
import { JevDecisionClient, DecisionError, type DecisionClient, type DecisionResult } from '../../decisions.js';
import { AtomicCallBudget, JudgeDecisionStore, fromDecisionClient, judgeCandidate, validateJudge, validateState, actualUsd, usdUnits } from '../judge/index.js';
import { hash } from '../primitives.js';
export const G3_ARMS=['code','cheap_trend','jev','deepseek'] as const;
export type G3Arm=typeof G3_ARMS[number];
export interface G3Opportunity { candidate:JudgeCandidateSnapshot; state:JudgeStateV1|null; unavailable_reason?:string; trend_1h:ResearchBar[]; trend_4h:ResearchBar[] }
export interface G3CollectionManifest {
 version:'g3_collection_v2'; frozen_at:number; training_end_ms:number;
 finalists:{id:string; training_end_ms?:number; judge:StrategyJudge; execution_spec_hash:string; opportunities:G3Opportunity[]}[];
 profiles:Record<'jev'|'deepseek',FrozenModelProfile>;
 pricing:{deepseek_input_per_million:string;deepseek_output_per_million:string;deepseek_max_output_tokens:number;deepseek_max_request_bytes:number};
 account:{initial_usd:string;risk_fraction:number;max_open:number;gross_cap:number};
 analysis:{block_days:number;max_holding_days:number;min_effect:number;max_drawdown:number};
 synthetic?:boolean;
}
/** 完整闭合且已可用的1h/4h bar，SMA20/50 方向同时与候选一致；不足不放行。 */
export function cheapTrend(o:G3Opportunity):boolean {
 return ([['trend_1h',3600000],['trend_4h',14400000]] as const).every(([key,step])=>{
  const b=o[key].filter(b=>b.close_time<o.candidate.as_of&&b.available_at<o.candidate.as_of&&b.open_time+step<=o.candidate.as_of).slice(-50);
  if(b.length!==50||o.candidate.as_of-(b.at(-1)!.open_time+step)>=step||b.some((x,i)=>x.close_time!==x.open_time+step-1||!Number.isFinite(Number(x.close))||Number(x.close)<=0||i>0&&x.open_time!==b[i-1]!.open_time+step))return false;
  const mean=(n:number)=>b.slice(-n).reduce((s,b)=>s+Number(b.close),0)/n;
  return o.candidate.direction==='long'?mean(20)>mean(50):mean(20)<mean(50);
 });
}
export function validateCollectionManifest(m:G3CollectionManifest):void {
 if(m.version!=='g3_collection_v2'||!Number.isSafeInteger(m.frozen_at)||!Number.isSafeInteger(m.training_end_ms)||m.training_end_ms>=m.frozen_at||!m.finalists.length||m.finalists.length>3||new Set(m.finalists.map(f=>f.id)).size!==m.finalists.length)throw Error('g3_freeze_invalid');
 if(m.profiles.jev.model!=='typesafe/jev-1.13-20260917'||m.profiles.deepseek.model!=='deepseek-chat'||Object.values(m.profiles).some(p=>p.retry_policy!=='none'||usdUnits(p.max_call_usd)<=0n))throw Error('g3_profile_invalid');
 for(const f of m.finalists){validateJudge(f.judge);if(!f.execution_spec_hash||!f.opportunities.length||new Set(f.opportunities.map(o=>o.candidate.id)).size!==f.opportunities.length)throw Error('g3_candidates_invalid');
  for(const o of f.opportunities){if(o.state)validateState(o.state,f.judge);else if(!o.unavailable_reason)throw Error('g3_missing_state_reason');if(o.state&&(o.state.as_of!==o.candidate.as_of||o.state.timeframe_ms!==o.candidate.timeframe_ms)||o.candidate.as_of<=(f.training_end_ms??m.training_end_ms))throw Error('g3_state_or_split_invalid');}
 }
 const a=m.account,p=m.pricing,g=m.analysis;
 if(usdUnits(a.initial_usd)<=0n||!(a.risk_fraction>0&&a.risk_fraction<=0.05)||!Number.isSafeInteger(a.max_open)||a.max_open<1||!(a.gross_cap>0&&a.gross_cap<=3))throw Error('g3_account_invalid');
 if(![p.deepseek_max_output_tokens,p.deepseek_max_request_bytes].every(v=>Number.isSafeInteger(v)&&v>0)||p.deepseek_max_output_tokens>4096||p.deepseek_max_request_bytes>100000||usdUnits(p.deepseek_input_per_million)<=0n||usdUnits(p.deepseek_output_per_million)<=0n)throw Error('g3_price_invalid');
 // 每个 UTF-8 byte 至多一个输入 token，另留1024 framing token；按冻结上界预留，供应商定价改变须新 manifest。
 const bound=(p.deepseek_max_request_bytes+1024)*Number(p.deepseek_input_per_million)/1e6+p.deepseek_max_output_tokens*Number(p.deepseek_output_per_million)/1e6;
 if(Number(m.profiles.deepseek.max_call_usd)+1e-12<bound)throw Error('g3_deepseek_reservation_below_bound');
 if(![g.block_days,g.max_holding_days].every(v=>Number.isSafeInteger(v)&&v>0)||g.block_days<g.max_holding_days||!Number.isFinite(g.min_effect)||g.min_effect<0||!(g.max_drawdown>0&&g.max_drawdown<=0.35))throw Error('g3_analysis_invalid');
}
/** 直连 DeepSeek；同一 state/questions/criteria，零重试，费用由 usage 或冻结 token 单价计算。 */
export function deepseekClient(key:string,pricing:G3CollectionManifest['pricing'],fetchFn:typeof fetch=globalThis.fetch):DecisionClient {
 return {name:'deepseek:deepseek-chat',async decide(req,opts){
  const started=Date.now();
  const body=JSON.stringify({model:'deepseek-chat',temperature:0,max_tokens:pricing.deepseek_max_output_tokens,response_format:{type:'json_object'},messages:[
   {role:'system',content:'Return only a JSON object {"answers":{question_key:answer}}. Evaluate the supplied state with exactly the supplied question instructions and criteria. noul answer: {"type":"noul","noul":probability_true}. score answer: {"type":"score","score":expected_zero_based_index,"confidence":max_probability,"probabilities":{"0":p0,...}}. choice answer: {"type":"choice","choice":label,"confidence":max_probability,"probabilities":{label:p,...}}. Include every label, probabilities in [0,1] summing to 1. Do not add fields or prose.'},
   {role:'user',content:JSON.stringify(req)}]});
  if(Buffer.byteLength(body)>pricing.deepseek_max_request_bytes)throw new DecisionError('g3_request_too_large','bad_request');
  const res=await fetchFn('https://api.deepseek.com/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`},body,redirect:'manual',signal:opts?.signal?AbortSignal.any([opts.signal,AbortSignal.timeout(opts.timeoutMs??30000)]):AbortSignal.timeout(opts?.timeoutMs??30000)});
  const text=(await res.text()).split(key).join('[REDACTED]');
  let j:Record<string,any>;try{j=JSON.parse(text);if(!j||typeof j!=='object'||Array.isArray(j))throw Error();}catch{throw new DecisionError('deepseek_non_json','bad_response',res.status,{model:'deepseek-chat',answers:{},usage:{input_tokens:0,cost_usd:null},latency_ms:Date.now()-started,raw_response:{body_text:text},response_error:'provider_non_json'});}
  const u=j.usage??{},input=u.prompt_tokens,output=u.completion_tokens;
  const tokenCost=Number.isSafeInteger(input)&&input>=0&&Number.isSafeInteger(output)&&output>=0?(input*Number(pricing.deepseek_input_per_million)+output*Number(pricing.deepseek_output_per_million))/1e6:null;
  const cost=typeof u.cost==='number'&&u.cost>=0&&Number.isFinite(u.cost)?u.cost:tokenCost;
  const result:DecisionResult={model:j.model??'deepseek-chat',answers:{},usage:{input_tokens:input??0,cost_usd:cost},latency_ms:Date.now()-started,provider_request_id:typeof j.id==='string'?j.id:undefined,
   raw_response:{id:j.id??null,model:j.model??null,choices:j.choices??null,usage:u,cost_basis:typeof u.cost==='number'?'provider_usage':'frozen_token_tariff'}};
  try{if(!res.ok)throw Error();const content=j.choices?.[0]?.message?.content;if(typeof content!=='string'||j.choices?.[0]?.finish_reason==='length')throw Error();result.answers=JSON.parse(content).answers;if(!result.answers)throw Error();return result;}
  catch{result.response_error=res.ok?'provider_bad_response':`provider_http_${res.status}`;throw new DecisionError(result.response_error,res.ok?'bad_response':'http',res.status,result);}
 }};
}
export interface G3DecisionRow {finalist_id:string;candidate_id:string;as_of:number;arm:G3Arm;action:'follow'|'skip';reason:string;request_hash:string|null;cost_usd:string|null;reserved_usd:string}
export interface G3Collection {version:'g3_collection_result_v2';manifest_hash:string;synthetic:boolean;complete:boolean;decisions:G3DecisionRow[];responses:unknown[];budget:ReturnType<AtomicCallBudget['view']>}
export async function collectG3(m:G3CollectionManifest,db:DatabaseSync,options:{max_usd:string;max_calls:number;clients?:Record<'jev'|'deepseek',DecisionClient>;stub?:boolean; recover_interrupted?:boolean}):Promise<G3Collection> {
 validateCollectionManifest(m);usdUnits(options.max_usd);
 if (m.synthetic && !options.stub) throw Error('g3_synthetic_mode_mismatch');
 if (!options.stub && Object.values(m.profiles).some(p=>p.routing==='offline_stub')) throw Error('g3_live_stub_profile');
 const manifest_hash=hash(m),id=`g3:${manifest_hash}`;
 // 一个账本只接收一个冻结 manifest，防止用换 manifest 绕过总预算。
 db.exec('CREATE TABLE IF NOT EXISTS g3_mode_lock (id INTEGER PRIMARY KEY CHECK(id=1), synthetic INTEGER NOT NULL)');
 db.prepare('INSERT OR IGNORE INTO g3_mode_lock VALUES(1,?)').run(options.stub?1:0);
 if(db.prepare('SELECT synthetic FROM g3_mode_lock WHERE id=1').get()!.synthetic!==(options.stub?1:0))throw Error('g3_ledger_mode_changed');
 db.exec('CREATE TABLE IF NOT EXISTS g3_manifest_lock (id INTEGER PRIMARY KEY CHECK(id=1), manifest_hash TEXT NOT NULL)');
 db.prepare('INSERT OR IGNORE INTO g3_manifest_lock VALUES(1,?)').run(manifest_hash);
 if(db.prepare('SELECT manifest_hash FROM g3_manifest_lock').get()!.manifest_hash!==manifest_hash)throw Error('g3_manifest_changed');
 const budget=AtomicCallBudget.create(db,id,options.max_calls,options.max_usd),store=new JudgeDecisionStore(db);
 if(options.recover_interrupted)store.interruptBudget(id); // CLI 独占锁确认没有旧 worker；未知请求不重发。
 const decisions:G3DecisionRow[]=[];let complete=true;
 for(const f of m.finalists)for(const o of f.opportunities){
  for(const arm of G3_ARMS){
   const base={finalist_id:f.id,candidate_id:o.candidate.id,as_of:o.candidate.as_of,arm};
   if(arm==='code'||arm==='cheap_trend'){const follow=arm==='code'||cheapTrend(o);decisions.push({...base,action:follow?'follow':'skip',reason:arm,request_hash:null,cost_usd:'0',reserved_usd:'0'});continue;}
   if(!o.state){decisions.push({...base,action:'skip',reason:o.unavailable_reason!,request_hash:null,cost_usd:'0',reserved_usd:'0'});continue;}
   const profile=m.profiles[arm];
   const client=options.stub?stubClient(profile):options.clients?.[arm];if(!client)throw Error('g3_client_missing');
   const spec={...f.judge,engine:arm==='jev'?'jev' as const:'llm' as const,model_profile_ref:profile.ref};
   const answer=await judgeCandidate({candidate:o.candidate,state:o.state,spec,execution_spec_hash:f.execution_spec_hash,model_profile:profile,decision_key:`${id}:${f.id}:${o.candidate.id}:${arm}`},{mode:'request_once',provider:fromDecisionClient(client,profile),store,budget});
   const why=answer.reason_codes.join(',');if(/budget_exhausted|provider_profile_unavailable/.test(why))complete=false;
   decisions.push({...base,action:answer.action,reason:why,request_hash:answer.request_hash||null,cost_usd:answer.cost_usd,reserved_usd:answer.cost_status==='unknown'?profile.max_call_usd:'0'});
  }
 }
 const responses=db.prepare('SELECT request_hash,raw_json,error_code,status FROM research_judge_responses ORDER BY request_hash').all().map(r=>({...r,raw_json:r.raw_json?JSON.parse(String(r.raw_json)):null}));
 return {version:'g3_collection_result_v2',manifest_hash,synthetic:!!options.stub||!!m.synthetic,complete,decisions,responses,budget:budget.view()};
}
export function environmentG3Clients(m:G3CollectionManifest):Record<'jev'|'deepseek',DecisionClient>{
 const jev=process.env.OPENROUTER_API_KEY,ds=process.env.DEEPSEEK_API_KEY;if(!jev||!ds)throw Error('g3_environment_keys_missing');
 return {jev:new JevDecisionClient({api_key:jev,model:m.profiles.jev.model,maxRetries:0,concurrency:1,dailyCapUsd:()=>2}),deepseek:deepseekClient(ds,m.pricing)};
}
function stubClient(profile:FrozenModelProfile):DecisionClient{return{name:'offline_g3',async decide(req){const answers=Object.fromEntries(Object.entries(req.questions).map(([k,q])=>[k,q.type==='noul'?{type:'noul',noul:k==='retreat_risk'?0.1:0.8}:q.type==='score'?{type:'score',score:2,confidence:0.7,probabilities:Object.fromEntries(q.criteria.map((_,i)=>[String(i),i===0?0.1:0.9/(q.criteria.length-1)]))}:{type:'choice',choice:Object.keys(q.criteria)[0],confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map((k,i)=>[k,i===0?1:0]))}]));return{model:profile.model,answers:answers as DecisionResult['answers'],usage:{input_tokens:100,cost_usd:Number(actualUsd(0.000027))},latency_ms:0,raw_response:{synthetic:true,answers}};}};}
