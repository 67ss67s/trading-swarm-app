/** G3 离线冻结：选择/抽样不读取留出或成交结果。IO 在 g3-export-db.ts。 */
import type { ResearchBar, StrategyIR, JudgeCandidateSnapshot, FrozenModelProfile } from '@trade-gate/contracts';
import type { MatrixManifest, CellResult, MatrixFinalist, MatrixVariantRef } from '../matrix-study/types.js';
import { hash } from '../primitives.js';
import { templateJudge } from '../judge/templates.js';
import { buildJudgeState } from '../judge/pure.js';
import { intentSnapshot } from '../judge/candidate.js';
import { usdUnits, usdString } from '../judge/store.js';
import { orderGateFor } from '../order-gate.js';
import { orderIntents, orderManager, orderExecOverrides, resolveOrder } from '../orders/intents.js';
import { simulateOrders, ORDERS_ENGINE_VERSION, ORDERS_ENGINE_VERSION_V2, toOrderBar } from '../orders/index.js';
import { viewBars } from '../engine.js';
import { executionFor } from '../improve/evaluate.js';
import type { FundingSeries, MmrTier } from '../orders/types.js';
import { validateCollectionManifest, type G3CollectionManifest, type G3Opportunity } from './g3-collect.js';
import type { G3Outcomes, G3Outcome } from './g3-analyze.js';
const DAY=86400000;
export interface ExportChoice {id:string;trial_id:string;cell_id:string;symbol:string;timeframe:string;ir:StrategyIR;selection_sharpe:number;dataset_id?:string;from_ms:number;to_ms:number;training_end_ms:number}
export interface ExportSnapshot {study_id:string;data_lock?:Record<string,{dataset_id:string}>;manifest:MatrixManifest;cells:Record<string,CellResult>;finalists:Pick<MatrixFinalist,'id'|'trial_id'|'cell_id'|'ir'|'selection'>[];trials:{trial_id:string;status:string;variant:MatrixVariantRef}[]}
export interface ExportData {bars:ResearchBar[];trend_1h:ResearchBar[];trend_4h:ResearchBar[];mark:ResearchBar[];funding:FundingSeries|null;tiers:MmrTier[];source_ids:string[]}
export interface FrozenExecution {version:'g3_conditional_v1';engine_version:string;ir:StrategyIR;timeframe_ms:number;window:{from_ms:number;to_ms:number};fee_rate:string;maker_fee_rate:string;slippage_bps:string;view_bars:number;initial_usd:string;margin_fraction:number;gate:ReturnType<typeof orderGateFor>;data_hash:string;policy:'isolated_entry_ignore_other_signals';max_holding_days:number}
export interface G3ExportManifest extends G3CollectionManifest {
 export_audit:{study_id:string;matrix_manifest_hash:string;selection_rule:string;evaluation_period:'selection_historical_replay';holdout_used:false;source_synthetic:boolean;
  choices:ExportChoice[];executions:Record<string,FrozenExecution>;data_sources:Record<string,string[]>;
  unavailable:{finalist_id:string;candidate_id:string|null;reason:string}[];
  sampling:{rule:string;before:number[];after:number[];max_usd:string;estimated_calls:number;cost_upper_usd:string;tariff_basis:string}};
}
/** finalist 只用封存身份和 selection 分数；开发 fallback 只用可见 cell best trial。 */
export function selectExportChoices(s:ExportSnapshot):{choices:ExportChoice[];rule:string}{
 const hasFinals=s.finalists.length>0;
 const rows=hasFinals?s.finalists.map(f=>({id:f.id,trial_id:f.trial_id,cell_id:f.cell_id,ir:f.ir,score:f.selection.sharpe})):Object.values(s.cells)
  .filter(c=>c.verdict==='pass'||c.verdict==='near').map(c=>{const t=s.trials.find(t=>t.trial_id===c.best_trial_id);return{id:c.best_trial_id!,trial_id:c.best_trial_id!,cell_id:c.cell_id,ir:t?.variant.ir,score:c.selection?.sharpe};});
 const choices=rows.filter(r=>r.ir&&Number.isFinite(r.score)&&s.trials.some(t=>t.trial_id===r.trial_id&&t.status==='evaluated')&&s.manifest.cells.some(c=>c.id===r.cell_id&&c.applicability==='applicable'))
  .sort((a,b)=>b.score!-a.score!||a.trial_id.localeCompare(b.trial_id)).slice(0,3).map(r=>{
   const c=s.manifest.cells.find(c=>c.id===r.cell_id)!,g=c.segments??s.manifest.segments[c.timeframe]!;
   return{id:r.id,trial_id:r.trial_id,cell_id:c.id,symbol:c.symbol,timeframe:c.timeframe,ir:structuredClone(r.ir!),selection_sharpe:r.score!,...(s.data_lock?.[`${c.timeframe}:${c.symbol}`]?{dataset_id:s.data_lock[`${c.timeframe}:${c.symbol}`]!.dataset_id}:{}),from_ms:g.selection.from_ms,to_ms:g.selection.to_ms,training_end_ms:g.train.to_ms};
  });
 if(!choices.length)throw Error('g3_no_eligible_development_candidate');
 return{choices,rule:`${hasFinals?'frozen_finalists':'development_cell_best_pass_or_near'}; selection.sharpe DESC, trial_id ASC; top 3; no holdout fields; selection historical replay (not independent evidence)`};
}
/** 每 finalist 等额轮转配额；按时间轴等距目标选最近且未用机会；不读收益/判断。 */
export function uniformTimeSample<T extends {candidate:{as_of:number;id:string}}>(rows:T[],count:number):T[]{
 const a=[...rows].sort((a,b)=>a.candidate.as_of-b.candidate.as_of||a.candidate.id.localeCompare(b.candidate.id));
 if(count>=a.length)return a;if(count<=0)return[];
 const used=new Set<number>(),lo=a[0]!.candidate.as_of,hi=a.at(-1)!.candidate.as_of;
 for(let k=0;k<count;k++){const target=count===1?(lo+hi)/2:lo+(hi-lo)*k/(count-1);let best=-1;
  for(let i=0;i<a.length;i++)if(!used.has(i)&&(best<0||Math.abs(a[i]!.candidate.as_of-target)<Math.abs(a[best]!.candidate.as_of-target)))best=i;
  used.add(best);
 }
 return a.filter((_,i)=>used.has(i));
}
function setup(c:ExportChoice,d:ExportData):FrozenExecution{
 const ir=structuredClone(c.ir);delete ir.judge;
 const step=c.timeframe==='1d'?DAY:c.timeframe==='4h'?14400000:c.timeframe==='15m'?900000:NaN;
 if(!ir.order||!Number.isFinite(step))throw Error('g3_order_executor_required');
 const gate=orderGateFor(ir),o=resolveOrder(ir,step,gate)!;
 // 加仓/滚动/跨信号替换不能用单机会条件路径线性缩放。拒绝，不改 IR。
 if(o.on_new_signal.filled!=='ignore'||o.direction==='both')throw Error('g3_path_dependent_new_signal_unsupported');
 if(!o.max_holding_bars)throw Error('g3_unbounded_holding_unsupported');
 const ex=executionFor(ir),perp=ir.order.market==='perp';
 return{version:'g3_conditional_v1',engine_version:gate?.min_stop_atr!==undefined?ORDERS_ENGINE_VERSION_V2:ORDERS_ENGINE_VERSION,ir,timeframe_ms:step,window:{from_ms:c.from_ms,to_ms:c.to_ms},fee_rate:perp?'0.0005':ex.fee_rate,maker_fee_rate:perp?'0.0002':ex.fee_rate,slippage_bps:ex.slippage_bps,view_bars:viewBars(ir,{lookback:1,atr_period:1} as never,step),initial_usd:'10000',margin_fraction:0.1,gate,data_hash:hash(d),policy:'isolated_entry_ignore_other_signals',max_holding_days:Math.ceil((o.max_holding_bars+2)*step/DAY)};
}
function intents(e:FrozenExecution,d:ExportData){
 const from=d.bars.findIndex(b=>b.close_time>=e.window.from_ms),to=d.bars.findLastIndex(b=>b.close_time<=e.window.to_ms);
 if(from<50||to<=from)throw Error('g3_execution_bars_missing');
 if(d.bars.some((b,i)=>b.close_time!==b.open_time+e.timeframe_ms-1||i>0&&b.open_time!==d.bars[i-1]!.open_time+e.timeframe_ms))throw Error('g3_execution_bars_gap');
 return{from,to,...orderIntents(e.ir,d.bars,e.timeframe_ms,{from_index:from,to_index:to,view:e.view_bars,fee_rate:e.fee_rate,slippage_bps:e.slippage_bps,gate:e.gate})};
}
const closed=(bars:ResearchBar[],at:number,step:number)=>bars.filter(b=>b.close_time<at&&b.available_at<at&&b.open_time+step<=at).slice(-50);
export function trendAvailable(bars:ResearchBar[],at:number,step:number){return bars.length===50&&at-(bars.at(-1)!.open_time+step)<step&&bars.every((b,i)=>b.close_time===b.open_time+step-1&&(!i||b.open_time===bars[i-1]!.open_time+step));}
export function exportManifest(s:ExportSnapshot,data:Record<string,ExportData>,options:{frozen_at:number;synthetic?:boolean;max_usd?:string}):G3ExportManifest{
 const {choices,rule}=selectExportChoices(s),max=options.max_usd??'2';if(usdUnits(max)<=0n||usdUnits(max)>usdUnits('2'))throw Error('g3_budget_invalid');
 const profile=(ref:string,model:string,cap:string,routing:string):FrozenModelProfile=>({ref,connection_id:ref,connection_revision:'g3_export_v1',model,model_revision:model,routing,parser_version:'judge_answers_v2_rounding_001',retry_policy:'none',max_call_usd:cap});
 const profiles={jev:profile('g3_jev','typesafe/jev-1.13-20260917','0.00015','openrouter'),deepseek:profile('g3_deepseek','deepseek-chat','0.005','deepseek_direct')};
 const audit:G3ExportManifest['export_audit']={study_id:s.study_id,matrix_manifest_hash:hash(s.manifest),selection_rule:rule,evaluation_period:'selection_historical_replay',holdout_used:false,source_synthetic:!!options.synthetic,choices,executions:{},data_sources:{},unavailable:[],sampling:{rule:'equal finalist round-robin quota; nearest unused to equally spaced timestamps incl endpoints; ties earlier timestamp/id; no outcomes read',before:[],after:[],max_usd:max,estimated_calls:0,cost_upper_usd:'0',tariff_basis:'offline frozen planning bounds; Claude must verify provider tariffs before paid execution; Jev 0.00015/call; DeepSeek UTF8 bytes+1024 framing and 512 output at 0.28/0.42 per million'}};
 const finalists=choices.map(c=>{
  const d=data[c.id]!;const e=setup(c,d);audit.executions[c.id]=e;audit.data_sources[c.id]=d.source_ids;
  const judge=c.ir.judge??templateJudge(profiles.jev.ref),xs=intents(e,d),opportunities:G3Opportunity[]=[];
  for(let i=0;i<xs.intents.length;i++){
   const it=xs.intents[i];if(!it)continue;
   const idx=xs.from+i,as_of=d.bars[idx]!.close_time+1;if(as_of>c.to_ms)continue;
   const candidate=intentSnapshot(e.ir,it,c.symbol,as_of,e.timeframe_ms);
   try{const state=buildJudgeState(candidate,d.bars.slice(Math.max(0,idx-99),idx+1),judge),trend_1h=closed(d.trend_1h,as_of,3600000),trend_4h=closed(d.trend_4h,as_of,14400000);
    opportunities.push({candidate,state,trend_1h,trend_4h});
    if(!trendAvailable(trend_1h,as_of,3600000)||!trendAvailable(trend_4h,as_of,14400000))audit.unavailable.push({finalist_id:c.id,candidate_id:candidate.id,reason:'cheap_trend_history_missing'});
   }catch(err){audit.unavailable.push({finalist_id:c.id,candidate_id:candidate.id,reason:String(err)});opportunities.push({candidate,state:null,unavailable_reason:String(err),trend_1h:closed(d.trend_1h,as_of,3600000),trend_4h:closed(d.trend_4h,as_of,14400000)});}
  }
  if(!opportunities.length)throw Error(`g3_no_evaluable_opportunities:${c.id}`);
  if(e.ir.order!.market==='perp'&&(!d.mark.length||!d.funding||!d.tiers.length))audit.unavailable.push({finalist_id:c.id,candidate_id:null,reason:'perp_mark_funding_or_tiers_missing'});
  return{id:c.id,judge,execution_spec_hash:hash(e),training_end_ms:c.training_end_ms,opportunities};
 });
 const unit=usdUnits(profiles.jev.max_call_usd)+usdUnits(profiles.deepseek.max_call_usd),capacity=Number(usdUnits(max)/unit),quotas=finalists.map(()=>0);
 audit.sampling.before=finalists.map(f=>f.opportunities.length);
 for(let n=0;n<capacity;){let added=false;for(let i=0;i<finalists.length&&n<capacity;i++)if(quotas[i]!<finalists[i]!.opportunities.length){quotas[i]!++;n++;added=true;}if(!added)break;}
 if(quotas.some(n=>n===0))throw Error('g3_budget_cannot_cover_finalists');
 finalists.forEach((f,i)=>{f.opportunities=uniformTimeSample(f.opportunities,quotas[i]!);});
 const count=quotas.reduce((a,b)=>a+b,0);audit.sampling.after=quotas;audit.sampling.estimated_calls=count*2;audit.sampling.cost_upper_usd=usdString(BigInt(count)*unit);
 const holding=Math.max(...Object.values(audit.executions).map(e=>e.max_holding_days));
 const m:G3ExportManifest={version:'g3_collection_v2',frozen_at:options.frozen_at,training_end_ms:Math.min(...choices.map(c=>c.training_end_ms)),synthetic:!!options.synthetic,finalists,profiles,
  pricing:{deepseek_input_per_million:'0.28',deepseek_output_per_million:'0.42',deepseek_max_output_tokens:512,deepseek_max_request_bytes:12000},
  account:{initial_usd:'10000',risk_fraction:s.manifest.spec.portfolio.risk_pct/100,max_open:s.manifest.spec.portfolio.max_open,gross_cap:s.manifest.spec.market==='perp'?3:1},
  analysis:{block_days:Math.max(s.manifest.spec.protocol.block_days,holding),max_holding_days:holding,min_effect:s.manifest.spec.protocol.min_effect,max_drawdown:Math.min(0.35,s.manifest.spec.protocol.max_drawdown)},export_audit:audit};
 validateCollectionManifest(m);return m;
}
export interface ExportedOutcomes extends G3Outcomes {unavailable:{finalist_id:string;candidate_id:string;reason:string}[];execution_audit:Record<string,unknown>}
/** 相同意图核/管理器/撮合核；每次只激活该机会，其他机会作为独立条件路径。 */
export function exportOutcomes(m:G3ExportManifest,data:Record<string,ExportData>):ExportedOutcomes{
 validateCollectionManifest(m);const from=Math.floor(Math.min(...m.export_audit.choices.map(c=>c.from_ms))/DAY)*DAY,to=Math.floor(Math.max(...m.export_audit.choices.map(c=>c.to_ms))/DAY)*DAY;
 const out:ExportedOutcomes={manifest_hash:hash(m),days:Array.from({length:(to-from)/DAY+1},(_,i)=>from+i*DAY),costs_included:true,execution_spec_hashes:{},finalists:{},unavailable:[],execution_audit:{}};
 for(const f of m.finalists){const e=m.export_audit.executions[f.id]!,d=data[f.id]!;
  if(hash(e)!==f.execution_spec_hash||hash(d)!==e.data_hash)throw Error('g3_frozen_execution_or_data_changed');
  out.execution_spec_hashes[f.id]=hash(e);out.finalists[f.id]=[];
  const xs=intents(e,d),all=xs.intents,step=e.timeframe_ms,bars=d.bars.slice(xs.from,xs.to+1),perp=e.ir.order!.market==='perp';
  const marks=new Map(d.mark.map(b=>[b.open_time,toOrderBar(b)]));
  for(const o of f.opportunities){try{
   const k=bars.findIndex(b=>b.close_time+1===o.candidate.as_of),it=all[k];if(!it||hash(intentSnapshot(e.ir,it,o.candidate.symbol,o.candidate.as_of,step))!==hash(o.candidate))throw Error('candidate_mismatch');
   if(perp&&(!d.funding||!d.tiers.length||bars.some(b=>!marks.has(b.open_time))))throw Error('perp_mark_funding_or_tiers_missing');
   const single=all.map((_,i)=>i===k?it:null),params={...orderExecOverrides(xs.order),symbol:o.candidate.symbol,timeframe_ms:step,initial_cash:Number(e.initial_usd),taker_fee_rate:Number(e.fee_rate),maker_fee_rate:Number(e.maker_fee_rate),slippage_bps:Number(e.slippage_bps),margin_fraction:e.margin_fraction,structure:e.gate?.min_stop_atr!==undefined,funding:d.funding,mark:perp?bars.map(b=>marks.get(b.open_time)!):undefined,maintenance_margin:d.tiers.length?d.tiers:undefined};
   const r=simulateOrders(bars.map(toOrderBar),single,params,orderManager(e.ir,d.bars,step,{offset:xs.from,view:e.view_bars,fee_rate:e.fee_rate}));
   if(r.engine_version!==e.engine_version)throw Error('execution_engine_version_changed');
   const p=r.plans[0];if(p?.status==='pending')throw Error('pending_at_selection_boundary');let result:G3Outcome;
   if(!p||p.filled_at===null){result={candidate_id:o.candidate.id,status:'not_filled',reason:p?.status==='no_fill'?'expired':p?.status==='replaced'||p?.blocked_reason==='gap_invalidated'?'invalidated':'execution_rejected'};}
   else{
    if(perp&&p.funding_status!=='complete')throw Error('funding_coverage_missing');
    if(!p.exit||p.exit.reason==='open')throw Error('position_open_at_selection_boundary');
    const entry=p.filled_at,exit=p.exit.at,notional=(p.fill_price??0)*(p.qty??0);if(!(notional>0))throw Error('notional_missing');
    const mtm:{at:number;net_return:number}[]=[];
    for(let day=Math.floor(entry/DAY)*DAY;day+DAY-1<exit;day+=DAY){const at=day+DAY-1,point=r.equity.find(p=>p.at===at);if(!point)throw Error('daily_mtm_missing');mtm.push({at,net_return:(point.equity-Number(e.initial_usd))/notional});}
    const trade=r.trades.find(t=>t.id===p.id);if(!trade)throw Error('closed_trade_missing');mtm.push({at:exit,net_return:trade.pnl/notional});
    result={candidate_id:o.candidate.id,status:'filled',entry_at:entry,exit_at:exit,marks:mtm};
    const fmt=(n:number)=>n.toFixed(12).replace(/\.?0+$/,'')||'0';
    out.execution_audit[`${f.id}:${o.candidate.id}`]={execution_spec_hash:hash(e),engine_version:r.engine_version,entry_price:fmt(trade.entry_price),exit_price:fmt(trade.exit_price),qty:fmt(trade.qty),fees_usd:fmt(trade.fees),funding_usd:fmt((p.funding_pct??0)*(p.margin??0)),slippage_bps:e.slippage_bps,net_pnl_usd:fmt(trade.pnl),normalization_notional_usd:fmt(notional),path_hash:hash(r),exit_reason:p.exit.reason};
   }
   out.finalists[f.id]!.push(result);
  }catch(err){out.unavailable.push({finalist_id:f.id,candidate_id:o.candidate.id,reason:err instanceof Error?err.message:String(err)});}}
 }
 return out;
}
