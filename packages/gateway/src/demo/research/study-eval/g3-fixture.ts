import type { ResearchBar, FrozenModelProfile } from '@trade-gate/contracts';
import { templateJudge } from '../judge/templates.js';
import { buildJudgeState } from '../judge/pure.js';
import { hash } from '../primitives.js';
import type { G3CollectionManifest } from './g3-collect.js';
import type { G3Outcomes } from './g3-analyze.js';
const DAY=86400000,START=Date.UTC(2024,0,1);
export function g3OfflineFixture():{manifest:G3CollectionManifest;outcomes:G3Outcomes}{
 const profile=(ref:string,model:string,max_call_usd:string):FrozenModelProfile=>({ref,connection_id:ref,connection_revision:'frozen_v2',model,model_revision:model,routing:'offline_stub',parser_version:'judge_answers_v2_rounding_001',max_call_usd,retry_policy:'none'});
 const profiles={jev:profile('jev','typesafe/jev-1.13-20260917','0.00015'),deepseek:profile('deepseek','deepseek-chat','0.005')},judge=templateJudge('jev');
 const bars=(as_of:number,step:number):ResearchBar[]=>Array.from({length:100},(_,i)=>{const at=Math.floor(as_of/step)*step-(100-i)*step;return{open_time:at,close_time:at+step-1,available_at:at+step-1,open:String(100+i),close:String(101+i),high:String(102+i),low:String(99+i),volume:'100'};});
 const opportunities=Array.from({length:8},(_,i)=>{const as_of=START+i*DAY+14400000,candidate={id:`candidate_${i}`,symbol:'BTCUSDT',as_of,timeframe_ms:14400000,direction:'long' as const,entry:'200',stop:'190',target:'220',reward_risk:2};return{candidate,state:buildJudgeState(candidate,bars(as_of,14400000),judge),trend_1h:bars(as_of,3600000),trend_4h:bars(as_of,14400000)};});
 const manifest:G3CollectionManifest={version:'g3_collection_v2',synthetic:true,frozen_at:START-1,training_end_ms:START-DAY,profiles,
 finalists:[{id:'offline_finalist',judge,execution_spec_hash:'fixture_execution_v1',opportunities}],
 pricing:{deepseek_input_per_million:'0.28',deepseek_output_per_million:'0.42',deepseek_max_output_tokens:512,deepseek_max_request_bytes:12000},
 account:{initial_usd:'10000',risk_fraction:0.005,max_open:3,gross_cap:1},analysis:{block_days:5,max_holding_days:1,min_effect:0.0001,max_drawdown:0.35}};
 const outcomes:G3Outcomes={manifest_hash:hash(manifest),days:Array.from({length:10},(_,i)=>START+i*DAY),costs_included:true,execution_spec_hashes:{offline_finalist:'fixture_execution_v1'},finalists:{offline_finalist:opportunities.map((o,i)=>({candidate_id:o.candidate.id,entry_at:o.candidate.as_of,exit_at:o.candidate.as_of+3600000,marks:[{at:o.candidate.as_of+3600000,net_return:i%2?0.01:-0.01}]}))}};
 return {manifest,outcomes};
}
