/** Offline real-model paired audit. No trading backend, DB or exchange credentials. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const OUTPUT = process.env.TG_HOLDING_AB_OUT ?? '/Users/demo/Documents/ChatGPT/trade-gate-bot/research/trade-horizon/deployment/real-ab';
const CANDIDATE = process.env.TG_HOLDING_AB_CANDIDATE ?? '/private/tmp/trade-gate-real-ab-candidate';
const BASELINE = process.env.TG_HOLDING_AB_BASELINE ?? '/private/tmp/trade-gate-real-ab-baseline';
const CACHE = process.env.TG_HOLDING_KLINE_CACHE ?? '/Users/demo/.trade-gate/demo/klines';
const CUT = Date.parse('2026-09-07T08:00:00Z'), START = CUT - 30*86400000, SPLIT = START + 15*86400000;
const M15 = 900000, TF = { '15m': M15, '1h': 4*M15, '4h': 16*M15, '1d':96*M15 };
const SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','HYPEUSDT'];
export const COSTS = Object.freeze({ fee_per_side:0.0005, adverse_slippage_per_fill:0.0002, funding_cost_per_8h:0.0001, funding_assumption:'cost charged both directions; no synthetic funding credit', reduce_fraction:0.5 });
// Locked before any model call. A small diagnostic cannot approve profitability by construction.
export const PROMOTION = Object.freeze({ minimum_independent_holdout_review_cases:20, minimum_holdout_repeats:2, minimum_holdout_net_expectancy_r:0,
 minimum_paired_holdout_improvement_r:0, maximum_holdout_worst_trade_regression_r:0.1, maximum_schema_failure_rate:0.02,
 required_hard_stop_violations:0, required_future_leakage:0, note:'Small budget diagnostic: <20 independent holdout trajectories gives HOLD regardless of observed gains. No threshold tuning after outputs.' });
const hash = x => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const number = x => Number(x), sign = side => side==='long'?1:-1;
const dec = x => Number(x).toFixed(8), iso = x => new Date(x).toISOString();
const read = async p => JSON.parse(await fs.readFile(p,'utf8'));
const write = async (p,x) => { await fs.mkdir(path.dirname(p),{recursive:true}); await fs.writeFile(p,JSON.stringify(x,null,2)+'\n'); };
const gateway = async root => (await import(pathToFileURL(path.join(root,'packages/gateway/dist/index.js')).href)).demo;

export function aggregate(bars, tf) {
 const ms=TF[tf], groups=new Map();
 for(const b of bars){const at=Math.floor(b.open_time/ms)*ms;const g=groups.get(at)??[];g.push(b);groups.set(at,g);}
 const out=[];
 for(const [at,g] of groups){if(g.length!==ms/M15||g.some((b,i)=>b.open_time!==at+i*M15||b.close_time!==b.open_time+M15-1))continue;
 out.push({open_time:at,close_time:at+ms-1,open:g[0].open,high:dec(Math.max(...g.map(b=>number(b.high)))),low:dec(Math.min(...g.map(b=>number(b.low)))),close:g.at(-1).close,volume:dec(g.reduce((n,b)=>n+number(b.volume),0))});}
 return out;
}
export function priorATR(bars) {
 if(bars.length<15)return null;
 const a=bars.slice(-15); if(a.some((b,i)=>i&&b.open_time!==a[i-1].close_time+1))return null;
 return a.slice(1).reduce((s,b,i)=>s+Math.max(number(b.high)-number(b.low),Math.abs(number(b.high)-number(a[i].close)),Math.abs(number(b.low)-number(a[i].close))),0)/14;
}
async function series(){const out={};for(const symbol of SYMBOLS){const source=await read(path.join(CACHE,`${symbol}-15m.json`));
 const raw=source.bars.filter(b=>b.close_time<CUT&&b.open_time>=START-70*86400000).sort((a,b)=>a.open_time-b.open_time);
 if(new Set(raw.map(b=>b.open_time)).size!==raw.length)throw Error(`duplicate bars ${symbol}`);
 if(raw.some(b=>b.close_time!==b.open_time+M15-1||!['open','high','low','close'].every(k=>Number.isFinite(number(b[k]))&&number(b[k])>0)||number(b.high)<Math.max(number(b.open),number(b.close))||number(b.low)>Math.min(number(b.open),number(b.close))))throw Error(`invalid bars ${symbol}`);
 out[symbol]=Object.fromEntries(Object.keys(TF).map(tf=>[tf,aggregate(raw,tf)]));}return out;}
function history(all,at){return Object.fromEntries(Object.entries(all).map(([tf,bars])=>[tf,bars.filter(b=>b.close_time<=at).slice(-80)]));}
function makeSeed(all,at,side,horizon,kind){
 const thesis=horizon==='swing'?'4h':'1h', ms=TF[thesis], closed=all[thesis].filter(b=>b.close_time<=at);
 if(closed.length<30)return null;
 const opening=closed.at(-4).close_time+1, before=closed.filter(b=>b.close_time<opening), atr=priorATR(before);
 if(!atr||atr<=0)return null;
 const entry=number(before.at(-1).close), s=sign(side);
 const structure=side==='long'?Math.min(...before.slice(-5).map(b=>number(b.low))):Math.max(...before.slice(-5).map(b=>number(b.high)));
 const invalidation=structure, risk=Math.max(2*atr,s*(entry-structure)+atr), stop=entry-s*risk, target=entry+s*3*risk;
 if(stop<=0||target<=0||s*(entry-invalidation)<=0)return null;
 const pathBars=all['15m'].filter(b=>b.open_time>=opening&&b.close_time<=at);
 if(!pathBars.length||pathBars.some((b,i)=>i&&b.open_time!==pathBars[i-1].close_time+1))return null;
 const current=pathBars.at(-1), beforeCurrent=pathBars.slice(0,-1);
 const stopHit=b=>s*(number(s===1?b.low:b.high)-stop)<=0;
 const targetHit=b=>s*(number(s===1?b.high:b.low)-target)>=0;
 if(beforeCurrent.some(b=>stopHit(b)||targetHit(b)))return null;
 if(kind!=='hard_stop'&&(stopHit(current)||targetHit(current)))return null;
 if(kind==='hard_stop'&&!stopHit(current))return null;
 if(kind==='thesis_invalidation'){
  if(at!==closed.at(-1).close_time||!closed.slice(-2).every(b=>b.open_time>=opening&&s*(number(b.close)-invalidation)<-0.2*atr))return null;
 }
 if(kind==='wick'){
  const prev=all['15m'].filter(b=>b.close_time<current.open_time), a=priorATR(prev);if(!a)return null;
  const p=number(prev.at(-1).close),ext=number(s===1?current.low:current.high),exc=s*(p-ext),other=s===1?number(current.high)-p:p-number(current.low),wick=s===1?Math.min(number(current.open),number(current.close))-number(current.low):number(current.high)-Math.max(number(current.open),number(current.close));
  if(exc/a<1.5||other/a>=1.5||s*(number(current.close)-ext)/exc<.65||wick/(number(current.high)-number(current.low))<.5)return null;
 }
 return {opened_at:opening,entry:dec(entry),hard_stop:dec(stop),target:dec(target),invalidation:dec(invalidation),atr_at_entry:dec(atr),risk:dec(risk),thesis_tf:thesis,horizon,side,initial_units:dec(100/risk),review_at:[at,at+ms],end_at:at+2*ms};
}
export async function prepare(){
 const data=await series(), cases=[], missing=[];
 for(const [split,lo,hi] of [['discovery',START,SPLIT],['holdout',SPLIT,CUT]]){
  let index=0;
  for(const kind of ['wick','thesis_invalidation','hard_stop'])for(const side of ['long','short']){
   const horizon=(index+(split==='holdout'?1:0))%2?'swing':'intraday';const symbol=SYMBOLS[index%SYMBOLS.length];index++;
   const earliest=lo+86400000+(index-1)*12*3600000;
   let chosen=null;
   for(const b of data[symbol]['15m']){if(b.close_time<earliest||b.close_time>=hi-2*TF[horizon==='swing'?'4h':'1h'])continue;
    const seed=makeSeed(data[symbol],b.close_time,side,horizon,kind);if(seed){chosen={id:`${split}-${kind}-${side}-${horizon}-${symbol}`,split,kind,mode:'review',symbol,side,horizon,as_of:b.close_time,seed};break;}}
   if(chosen)cases.push(chosen);else missing.push({split,kind,side,horizon,symbol});
  }
  for(const side of ['long','short']){const symbol=side==='long'?'BTCUSDT':'ETHUSDT', horizon=side==='long'?'intraday':'swing',at=lo+3*86400000-1;cases.push({id:`${split}-scan-${side}-${symbol}`,split,kind:'scan_atr',mode:'scan',symbol,side,horizon,as_of:at,seed:null});}
 }
 // Freeze all relevant public input so running cache maintenance cannot change either arm.
 const manifest={version:1,created_from_fixed_cutoff:iso(CUT),discovery:[iso(START),iso(SPLIT)],holdout:[iso(SPLIT),iso(CUT)],selection:'first chronological qualifying closed bar; conditions use only history at event; entry/stop/target from pre-opening bars; missing scenarios never substituted after model outputs',
  costs:COSTS,promotion:PROMOTION,repeats:2,max_model_calls:112,source_hashes:Object.fromEntries(Object.entries(data).map(([s,d])=>[s,hash(d)])),cases,missing,limitations:['Seeded hypothetical positions, not an entry-strategy backtest.','Hard-stop diagnostics may already require protective exit before review; replay enforces it.','Only 6 independent holdout review cases targeted: insufficient for profitability promotion, regardless of repetitions.','Chronological split is fixed before any outputs; no news event inference from OHLC.']};
 await write(path.join(OUTPUT,'data.json'),data);await write(path.join(OUTPUT,'manifest.json'),manifest);console.log(JSON.stringify({cases:cases.length,missing,output:OUTPUT},null,2));
}
function makeThread(demo,c,at){const p=c.seed;const t=demo.newThread({id:c.id,backend:'paper',symbol:c.symbol,side:c.side,source:'agent',timeframe:'15m',horizon:c.horizon,strategy_id:'breakout_retest',thesis:'历史预设仓位：依照入场前结构建立论点；当前不是新开仓。',invalidation_text:p.invalidation,watch_conditions:[],entry:{type:'market',price:p.entry,zone:null},stop_price:p.hard_stop,take_profits:[p.target],qty:p.initial_units,margin_usdt:'1000',leverage:1,margin_mode:'cross',now:p.opened_at});
 return {...t,status:'in_position',opened_at:p.opened_at,filled_avg_price:p.entry,updated_at:at,strategy_version:1,strategy_content_hash:'audit-pinned-baseline'};
}
function inputFor(demo,c,data,at,thread,lastSummary){
 const klines=history(data[c.symbol],at),last=klines['15m'].at(-1),daily=klines['15m'].slice(-96),strategy=structuredClone(demo.BUILTIN_STRATEGIES.find(s=>s.id==='breakout_retest'));
 strategy.horizon=c.horizon;strategy.content_hash=demo.strategyContentHash(strategy);
 return {now:at,symbol:c.symbol,trigger:{kind:c.mode==='review'?'thread_review':'scan',detail:'离线历史判断；只使用截止时刻可见数据'},mode:c.mode,thread,open_threads:thread?[thread]:[],account:{backend:'paper',equity:'10000',available:'9000',unrealized_pnl:thread?dec(sign(c.side)*(number(last.close)-number(thread.filled_avg_price))*number(thread.qty)):'0',positions:[],open_orders:[],as_of:at},
 market:{symbol:c.symbol,last:last.close,mark:last.close,funding_rate:'',next_funding_at:at+8*3600000,open_interest:'',as_of:at,klines_tf:'15m'},features:Object.entries(klines).map(([tf,b])=>demo.tfFeatures(tf,b)),klines,strategies:[strategy],invalidation_confirm_bars:2,invalidation_buffer_atr:.2,
 oi_change_1h_pct:null,ticker24h:{priceChangePercent:dec((number(last.close)/number(daily[0].open)-1)*100),highPrice:dec(Math.max(...daily.map(b=>number(b.high)))),lowPrice:dec(Math.min(...daily.map(b=>number(b.low)))),quoteVolume:dec(daily.reduce((n,b)=>n+number(b.volume)*number(b.close),0))},market_state:null,playbook_text:demo.DEFAULT_PLAYBOOK,last_judgment_summary:lastSummary,halted:false};
}
// Engine accepts scheduled decisions; fills happen at following bar open, never at observed close.
export function replay(seed,bars,decisions,costs=COSTS){
 const s=sign(seed.side),entry=number(seed.entry),risk=number(seed.risk),stop=number(seed.hard_stop),target=number(seed.target);let fraction=1,gross=0,fees=entry*costs.fee_per_side,slippage=entry*costs.adverse_slippage_per_fill,funding=0,lastAt=seed.opened_at,closedAt=null;
 const fills=[],curve=[];const scheduled=new Map(decisions.map(d=>[d.at,d.action]));
 const fill=(at,price,q,why)=>{funding+=entry*fraction*costs.funding_cost_per_8h*Math.max(0,at-lastAt)/(8*3600000);lastAt=at;gross+=s*(price-entry)*q;fees+=price*q*costs.fee_per_side;slippage+=price*q*costs.adverse_slippage_per_fill;fraction-=q;fills.push({at,price:dec(price),fraction:q,reason:why});if(fraction<1e-9){fraction=0;closedAt=at;}};
 for(const b of bars){if(b.open_time<seed.opened_at||b.open_time>seed.end_at||!fraction)continue;
  funding+=entry*fraction*costs.funding_cost_per_8h*Math.max(0,b.open_time-lastAt)/(8*3600000);lastAt=b.open_time;
  const action=scheduled.get(b.open_time-1);const o=number(b.open),lo=number(b.low),hi=number(b.high);
  // Exchange gap stop is protective even if a discretionary exit was just scheduled.
  if(s*(o-stop)<=0){fill(b.open_time,o,fraction,'gap_stop');}
  else if(action==='EXIT'||action==='INVALIDATE'){fill(b.open_time,o,fraction,'model_exit');}
  else {if(action==='REDUCE')fill(b.open_time,o,fraction*costs.reduce_fraction,'model_reduce');
   if(fraction){const stopHit=s===1?lo<=stop:hi>=stop,targetHit=s===1?hi>=target:lo<=target;
    if(stopHit)fill(b.close_time,stop,fraction,'hard_stop');else if(targetHit)fill(b.close_time,target,fraction,'take_profit');}}
  curve.push({at:b.close_time,net_r:(gross+s*(number(b.close)-entry)*fraction-fees-slippage-funding)/risk});
 }
 if(fraction){const b=bars.filter(b=>b.close_time<=seed.end_at&&b.open_time>=seed.opened_at).at(-1);if(b)fill(b.close_time,number(b.close),fraction,'evaluation_expiry');}
 return {gross_r:gross/risk,net_r:(gross-fees-slippage-funding)/risk,fee_r:fees/risk,slippage_r:slippage/risk,funding_r:funding/risk,closed_at:closedAt,fills,curve,net_mae_r:Math.min(0,...curve.map(p=>p.net_r)),model_exits:fills.filter(f=>f.reason==='model_exit').length,model_reductions:fills.filter(f=>f.reason==='model_reduce').length};
}
async function call(demo,system,user,key,budget){
 const cache=path.join(OUTPUT,'model-cache',`${key}.json`);try{return await read(cache);}catch{}
 const ledgerName=process.argv[3]==='candidate'?'candidate-calls.json':'calls.json';
 const ledger=await read(path.join(OUTPUT,ledgerName)).catch(()=>[]);if(ledger.length>=56)throw Error('real model budget exhausted');
 const began={key,model:'pi:zai/glm-5.3',started_at:Date.now()};ledger.push(began);await write(path.join(OUTPUT,ledgerName),ledger);
 let response;try{response=await demo.piBrain({model:'zai/glm-5.3'}).complete(system,user,{timeoutMs:120000});}catch(e){response={text:'',model:'pi:zai/glm-5.3',error:String(e),latency_ms:Date.now()-began.started_at,input_tokens:0,output_tokens:0};}
 const result={...response,system,user,cache_key:key,request_started_at:began.started_at};await write(cache,result);return result;
}
export async function runArm(arm){
 if(!['baseline','candidate'].includes(arm))throw Error('arm must baseline or candidate');
 const manifest=await read(path.join(OUTPUT,'manifest.json')),data=await read(path.join(OUTPUT,'data.json')),demo=await gateway(arm==='baseline'?BASELINE:CANDIDATE);
 const episodes=[];
 for(let repetition=0;repetition<2;repetition++)for(const c of manifest.cases){
  const saved=path.join(OUTPUT,arm,`${c.id}-rep${repetition}.json`);try{episodes.push(await read(saved));continue;}catch{}
  const steps=[],decisions=[];let thread=c.seed?makeThread(demo,c,c.as_of):null,summary=null;
  for(const at of c.seed?c.seed.review_at:[c.as_of]){
   // Respect the realized path before a second review; do not ask a model to manage a closed position.
   if(steps.length&&c.seed){const interim=replay({...c.seed,end_at:at-1},data[c.symbol]['15m'].filter(b=>b.close_time<at),decisions);if(interim.fills.some(f=>f.reason!=='evaluation_expiry'&&f.at<at&&interim.fills.filter(z=>z.at<=f.at).reduce((n,z)=>n+z.fraction,0)>=.999999))break;
    const reduced=interim.fills.filter(f=>f.reason==='model_reduce').reduce((n,f)=>n+f.fraction,0);thread={...thread,qty:dec(number(c.seed.initial_units)*(1-reduced))};}
   let inp=inputFor(demo,c,data,at,thread,summary);
   if(thread){thread={...thread,strategy_id:inp.strategies[0].id,strategy_version:inp.strategies[0].version,strategy_content_hash:inp.strategies[0].content_hash};inp={...inp,thread,open_threads:[thread]};}
   if(arm==='candidate'&&thread){if(typeof demo.buildHoldingPlan!=='function')throw Error('candidate buildHoldingPlan export unavailable');
    // Candidate hook supplied by gateway integration, adapted in one location once its contract is finalized.
    thread=attachCandidatePlan(demo,thread,{...inp,_full_series:data[c.symbol]},c);inp={...inp,thread,open_threads:[thread]};}
   const built=demo.buildContext(inp);const key=hash({arm,repetition,case_id:c.id,at,context:built.context_hash,model:'pi:zai/glm-5.3'});
   const response=await call(demo,built.system_text,built.user_text,key);if(response.error)throw Error(`real model call failed; saved raw failure under ${key}: ${response.error}`);let judgment=null,errors=[];
   try{const parsed=demo.validateJudgment(demo.extractJson(response.text),new Set(built.evidence.map(e=>e.ref)),{strategies:built.strategy_ids});judgment=parsed.judgment;errors=parsed.errors;}catch(e){errors=[String(e)];}
   let action=judgment?.action??(c.mode==='review'?'HOLD':'NO_TRADE'),guard=null,reducer=null;
   if(thread){const reviewJudgment=judgment??{action:'HOLD',thesis:thread.thesis,invalidation:null,watch_conditions:[]};if(arm==='candidate'){guard=candidateGuard(demo,thread,reviewJudgment,inp,c);action=guard.action;}
    reducer=demo.reduceReview(thread,{...reviewJudgment,action});if(!reducer.accepted)action='HOLD';thread={...thread,...reducer.patch,...(guard?.last_closed_at?{last_policy_close_at:guard.last_closed_at}:{})};}
   decisions.push({at,action});summary=judgment?`${action}: ${judgment.thesis}`:'模型输出校验失败，保持保护并等待';
   steps.push({at,context_hash:built.context_hash,cache_key:key,model:response.model,model_error:response.error??null,schema_valid:!!judgment,schema_errors:errors,judgment,applied_action:action,guard,reducer,allowed_actions:built.allowed_actions,
    visible_max_close:Math.max(...Object.values(inp.klines).flat().map(b=>b.close_time)),future_leakage:Math.max(...Object.values(inp.klines).flat().map(b=>b.close_time))>at});
   console.log(JSON.stringify({arm,repetition,case:c.id,at,action,valid:!!judgment}));
  }
  const outcome=c.seed?replay(c.seed,data[c.symbol]['15m'],decisions):null;
  const ep={case_id:c.id,split:c.split,kind:c.kind,mode:c.mode,side:c.side,horizon:c.horizon,arm,repetition,steps,outcome};await write(saved,ep);episodes.push(ep);
 }
 await write(path.join(OUTPUT,`${arm}-episodes.json`),episodes);return episodes;
}
function attachCandidatePlan(demo,thread,input,c){
 if(thread.holding_plan)return thread;
 // Freeze the actual pre-opening visible features, not the post-shock ATR or trends.
 const past=Object.fromEntries(Object.entries(input._full_series??{}).map(([tf,b])=>[tf,b.filter(k=>k.close_time<c.seed.opened_at).slice(-80)]));
 if(!Object.keys(past).length)throw Error('missing pre-entry series for holding plan');
 const features=Object.entries(past).map(([tf,b])=>demo.tfFeatures(tf,b));
 const plan=demo.buildHoldingPlan({thread,features,strategy:input.strategies[0],now:c.seed.opened_at,origin:'entry',round_trip_cost_bps:'18',confirm_bars:2,invalidation_buffer_atr:.2});
 if(!plan)throw Error(`candidate plan unavailable ${c.id}`);
 return {...thread,holding_plan:plan};
}
function candidateGuard(demo,thread,judgment,input,c){
 const guard=demo.evaluateHoldingReview({thread,now:input.now,market:input.market,features:input.features,klines:input.klines});
 const action=guard.required_action??(guard.allowed_actions.includes(judgment.action)?judgment.action:'HOLD');
 return {...guard,proposed_action:judgment.action,action,accepted:guard.allowed_actions.includes(judgment.action)};
}
/** Revalidate saved real responses against the final candidate build; never calls a model. */
export async function revalidate(suffix=''){
 const manifest=await read(path.join(OUTPUT,'manifest.json')),data=await read(path.join(OUTPUT,'data.json')),original=await read(path.join(OUTPUT,'candidate-episodes.json')),demo=await gateway(ROOT);
 const rows=[],checks=[];
 for(const ep of original){const c=manifest.cases.find(c=>c.id===ep.case_id);let thread=c.seed?makeThread(demo,c,c.as_of):null,summary=null;const steps=[],decisions=[];
  for(const old of ep.steps){const at=old.at;
   if(steps.length&&thread){const interim=replay({...c.seed,end_at:at-1},data[c.symbol]['15m'].filter(b=>b.close_time<at),decisions);const reduced=interim.fills.filter(f=>f.reason==='model_reduce').reduce((n,f)=>n+f.fraction,0);thread={...thread,qty:dec(number(c.seed.initial_units)*(1-reduced))};}
   let inp=inputFor(demo,c,data,at,thread,summary);
   if(thread){thread={...thread,strategy_id:inp.strategies[0].id,strategy_version:inp.strategies[0].version,strategy_content_hash:inp.strategies[0].content_hash};thread=attachCandidatePlan(demo,thread,{...inp,_full_series:data[c.symbol]},c);inp={...inp,thread,open_threads:[thread]};}
   const built=demo.buildContext(inp),raw=await read(path.join(OUTPUT,'model-cache',`${old.cache_key}.json`));
   const exact=built.context_hash===old.context_hash&&raw.system===built.system_text&&raw.user===built.user_text;
   const keyValid=hash({arm:'candidate',repetition:ep.repetition,case_id:c.id,at,context:old.context_hash,model:'pi:zai/glm-5.3'})===old.cache_key;
   let action=old.judgment?.action??(thread?'HOLD':'NO_TRADE'),guard=null,reducer=null;
   if(thread){const j=old.judgment??{action:'HOLD',thesis:thread.thesis,invalidation:null,watch_conditions:[]};guard=candidateGuard(demo,thread,j,inp,c);action=guard.action;reducer=demo.reduceReview(thread,{...j,action});if(!reducer.accepted)action='HOLD';thread={...thread,...reducer.patch,...(guard?.last_closed_at?{last_policy_close_at:guard.last_closed_at}:{})};}
   checks.push({case_id:c.id,repetition:ep.repetition,at,prompt_exact_match:exact,cache_key_valid:keyValid,raw_model:raw.model,original_action:old.applied_action,revalidated_action:action,action_changed:action!==old.applied_action});
   steps.push({...old,applied_action:action,guard,reducer,revalidated_context_hash:built.context_hash,prompt_exact_match:exact});decisions.push({at,action});summary=old.judgment?`${action}: ${old.judgment.thesis}`:'模型输出校验失败，保持保护并等待';
  }
  rows.push({...ep,steps,outcome:c.seed?replay(c.seed,data[c.symbol]['15m'],decisions):null});
 }
 const hashes={};for(const name of ['holding-policy','context','threads','schema','strategies','market','brain'])hashes[`${name}.js`]=hash(await fs.readFile(path.join(ROOT,`packages/gateway/dist/demo/${name}.js`),'utf8'));
 const result={model_calls:0,steps:checks.length,prompt_mismatches:checks.filter(c=>!c.prompt_exact_match).length,invalid_cache_keys:checks.filter(c=>!c.cache_key_valid).length,changed_actions:checks.filter(c=>c.action_changed).length,final_build_hashes:hashes,checks};
 await write(path.join(OUTPUT,`candidate-revalidated-episodes${suffix}.json`),rows);await write(path.join(OUTPUT,`candidate-revalidation${suffix}.json`),result);console.log(JSON.stringify(result,null,2));return result;
}
/** Additional scan-only prompt revision: separate budget/results, no original call or report overwritten. */
export async function refreshScanRR(){
 const dest=path.join(OUTPUT,'scan-rr-refresh'),manifest=await read(path.join(OUTPUT,'manifest.json')),data=await read(path.join(OUTPUT,'data.json')),old=await read(path.join(OUTPUT,'candidate-episodes.json')),demo=await gateway(ROOT),rows=[];
 for(let repetition=0;repetition<2;repetition++)for(const c of manifest.cases.filter(c=>c.mode==='scan')){
  const inp=inputFor(demo,c,data,c.as_of,null,null),built=demo.buildContext(inp),key=hash({revision:'scan-rr-refresh',repetition,case_id:c.id,at:c.as_of,context:built.context_hash,model:'pi:zai/glm-5.3'}),file=path.join(dest,'cache',`${key}.json`);
  let raw;try{raw=await read(file);}catch{
   const calls=await read(path.join(dest,'calls.json')).catch(()=>[]);if(calls.length>=8)throw Error('scan RR refresh hard cap 8 reached');calls.push({key,case_id:c.id,repetition,started_at:Date.now()});await write(path.join(dest,'calls.json'),calls);
   const response=await demo.piBrain({model:'zai/glm-5.3'}).complete(built.system_text,built.user_text,{timeoutMs:120000});raw={...response,system:built.system_text,user:built.user_text,context_hash:built.context_hash,cache_key:key};await write(file,raw);
  }
  let judgment=null,errors=[];try{const p=demo.validateJudgment(demo.extractJson(raw.text),new Set(built.evidence.map(e=>e.ref)),{strategies:built.strategy_ids});judgment=p.judgment;errors=p.errors;}catch(e){errors=[String(e)];}
  let gates=[];if(judgment?.action==='PROPOSE'&&judgment.proposal){const p=judgment.proposal;const thread=demo.newThread({id:c.id,backend:'paper',symbol:c.symbol,side:p.direction,source:'agent',timeframe:'15m',horizon:c.horizon,thesis:judgment.thesis,invalidation_text:judgment.invalidation,watch_conditions:[],entry:{type:p.entry,price:p.limit_price??inp.market.mark,zone:p.entry_zone},stop_price:p.stop_price,take_profits:p.take_profits,qty:'1',margin_usdt:'100',leverage:1,margin_mode:'cross',now:c.as_of});
   const plan=demo.buildHoldingPlan({thread,features:inp.features,judgment,strategy:inp.strategies[0],now:c.as_of});gates=demo.holdingEntryGates(plan,thread);
  }
  const prior=old.find(e=>e.case_id===c.id&&e.repetition===repetition)?.steps[0];rows.push({case_id:c.id,split:c.split,repetition,context_hash:built.context_hash,old_context_hash:prior?.context_hash,old_action:prior?.applied_action,new_action:judgment?.action??'NO_TRADE',schema_valid:!!judgment,errors,judgment,risk_plan:judgment?.proposal?.risk_plan??null,entry_gates:gates,cache_key:key,model:raw.model,input_tokens_estimated:raw.input_tokens,output_tokens_estimated:raw.output_tokens});console.log(JSON.stringify({case:c.id,repetition,action:judgment?.action,valid:!!judgment}));
 }
 const calls=await read(path.join(dest,'calls.json')),hashes={};for(const f of ['rr-prompt','context','holding-policy','schema'])hashes[`${f}.js`]=hash(await fs.readFile(path.join(ROOT,`packages/gateway/dist/demo/${f}.js`),'utf8'));
 const result={kind:'additional_real_pi_scan_rr_prompt_check_not_profit_validation',model:'pi:zai/glm-5.3',calls:calls.length,max_calls:8,original_ab_calls:78,combined_calls:78+calls.length,total:rows.length,valid:rows.filter(r=>r.schema_valid).length,proposed:rows.filter(r=>r.new_action==='PROPOSE').length,risk_plan_selected:rows.filter(r=>r.risk_plan).length,code_gate_rejected_proposals:rows.filter(r=>r.entry_gates.some(g=>!g.passed)).length,action_changes:rows.filter(r=>r.new_action!==r.old_action).length,build_hashes:hashes,rows,note:'Original 78-call A/B used the previous scan prompt and remains untouched. This 8-call scan-only revision does not change holding profitability acceptance; no orders submitted.'};await write(path.join(dest,'report.json'),result);return result;
}
export async function report(){
 const manifest=await read(path.join(OUTPUT,'manifest.json')),a=await read(path.join(OUTPUT,'baseline-episodes.json')),b=await read(path.join(OUTPUT,'candidate-revalidated-episodes.json')).catch(()=>read(path.join(OUTPUT,'candidate-episodes.json')));
 const mean=a=>a.length?a.reduce((n,x)=>n+x,0)/a.length:null;
 const summaries={};for(const [arm,rows]of [['baseline',a],['candidate',b]])for(const split of ['discovery','holdout']){
  const rr=rows.filter(e=>e.split===split&&e.outcome),steps=rows.filter(e=>e.split===split).flatMap(e=>e.steps);summaries[`${arm}_${split}`]={episodes:rr.length,independent_review_cases:new Set(rr.map(e=>e.case_id)).size,net_expectancy_r:mean(rr.map(e=>e.outcome.net_r)),gross_expectancy_r:mean(rr.map(e=>e.outcome.gross_r)),worst_trade_r:Math.min(...rr.map(e=>e.outcome.net_r)),model_exits:rr.reduce((n,e)=>n+e.outcome.model_exits,0),model_reductions:rr.reduce((n,e)=>n+e.outcome.model_reductions,0),schema_failure_rate:steps.filter(s=>!s.schema_valid).length/steps.length,future_leakage:steps.filter(s=>s.future_leakage).length,actions:Object.fromEntries([...new Set(steps.map(s=>s.applied_action))].map(k=>[k,steps.filter(s=>s.applied_action===k).length]))};}
 const paired=b.filter(e=>e.outcome).map(e=>{const prev=a.find(x=>x.case_id===e.case_id&&x.repetition===e.repetition);return {case_id:e.case_id,split:e.split,repetition:e.repetition,delta_net_r:e.outcome.net_r-prev.outcome.net_r};});
 const hs=summaries.candidate_holdout,bs=summaries.baseline_holdout,delta=mean(paired.filter(p=>p.split==='holdout').map(p=>p.delta_net_r));
 const revalidation=await read(path.join(OUTPUT,'candidate-revalidation.json')).catch(()=>null);
 const gates={cache_and_final_build_parity:revalidation!==null&&revalidation.prompt_mismatches===0&&revalidation.invalid_cache_keys===0,sufficient_independent_holdout:hs.independent_review_cases>=PROMOTION.minimum_independent_holdout_review_cases,positive_net_holdout:hs.net_expectancy_r>0,positive_paired_holdout_improvement:delta>0,no_tail_regression:hs.worst_trade_r>=bs.worst_trade_r-PROMOTION.maximum_holdout_worst_trade_regression_r,schema_validity:hs.schema_failure_rate<=PROMOTION.maximum_schema_failure_rate,no_future_leakage:hs.future_leakage===0,
 two_repeats_per_case:manifest.cases.every(c=>[0,1].every(r=>a.some(e=>e.case_id===c.id&&e.repetition===r)&&b.some(e=>e.case_id===c.id&&e.repetition===r))),
 hard_stops_enforced:b.filter(e=>e.kind==='hard_stop').every(e=>e.outcome?.fills.some(f=>['hard_stop','gap_stop'].includes(f.reason)))};
 const calls=[...await read(path.join(OUTPUT,'calls.json')),...await read(path.join(OUTPUT,'candidate-calls.json'))];const raw=await Promise.all(calls.map(c=>read(path.join(OUTPUT,'model-cache',`${c.key}.json`))));
 const usage={cache_records:raw.length,unique_keys:new Set(calls.map(c=>c.key)).size,input_tokens_estimated:raw.reduce((n,r)=>n+r.input_tokens,0),output_tokens_estimated:raw.reduce((n,r)=>n+r.output_tokens,0),latency_ms:raw.reduce((n,r)=>n+r.latency_ms,0),pricing_note:'Adapter token counts are character estimates, not supplier usage. Cost comparison uses fixed 2 CNY input / 8 CNY output per million; not a bill.'};usage.estimated_cny=(usage.input_tokens_estimated*2+usage.output_tokens_estimated*8)/1000000;
 const scan_coverage=Object.fromEntries([['baseline',a],['candidate',b]].map(([arm,rows])=>[arm,{cases:rows.filter(e=>e.mode==='scan').length,proposed:rows.filter(e=>e.mode==='scan').flatMap(e=>e.steps).filter(s=>s.judgment?.action==='PROPOSE').length,risk_plan_selected:rows.filter(e=>e.mode==='scan').flatMap(e=>e.steps).filter(s=>s.judgment?.proposal?.risk_plan).length}]));
 const results={kind:'real_pi_paired_holding_exit_diagnostic_with_costs',model:'pi:zai/glm-5.3',usage,scan_coverage,revalidation,promotion:Object.values(gates).every(Boolean)?'PROMOTE_CANDIDATE':'HOLD',gates,locked_thresholds:PROMOTION,costs:COSTS,calls:calls.length,max_calls:112,summaries,paired,holdout_mean_delta_r:delta,manifest_hash:hash(manifest),limitations:manifest.limitations};
 await write(path.join(OUTPUT,'report.json'),results);console.log(JSON.stringify(results,null,2));return results;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const command=process.argv[2];if(command==='prepare')await prepare();else if(command==='run')await runArm(process.argv[3]);else if(command==='revalidate')await revalidate();else if(command==='revalidate-rr')await revalidate('-after-rr');else if(command==='scan-rr')await refreshScanRR();else if(command==='report')await report();else throw Error('usage: holding-ab.mjs prepare | run baseline|candidate | report');
}
