import { registerLoopRoutes } from './research/loop/routes.js';
import { registerPineRoutes } from './research/pine/routes.js';
import { pineEngineHealth } from './research/pine/client.js';
import { registerBacktestRoutes } from './research/backtest-routes.js';
import { registerStrategyRoutes } from './research/strategies/routes.js';
import { registerImproveRoutes } from './research/improve/routes.js';
import { registerEvolutionRoutes } from './routes-evolution.js';
import { registerUniverseRoutes } from './routes-universe.js';
import {CcxtMarket,publicExchange,selectAssets} from './research/market-ccxt.js';
import {precheck} from './research/precheck.js';
import { compileStrategy } from './research/strategy.js';
import { listPrimitives } from './research/primitives/index.js';
/** Horizon-style workbench: research-only API. No execution, wallet, or live strategy writes. */
import type { IncomingMessage } from 'node:http';
import { schemas, type ResearchRequest, type ResearchChatRequest, type ResearchToolCall, type ResearchUniverseRequest } from '@trading-swarm/contracts';
import type { RouteModule, RouteHandler } from './http-extra.js';
import { resolveRunStrategies } from './backtest.js';
import { ResearchStore } from './research/store.js';
import { ResearchService, runSummary } from './research/service.js';
import { researchChat, researchTool, RESEARCH_TOOLS } from './research/tools.js';
import { assertContract, hash } from './research/primitives.js';
import { importMarketDataset } from './research/market-dataset.js';
import { buildUniverse, factorDefinition } from './research/universe.js';
import { screenUniverse } from './research/screen.js';
export const researchRoutes:RouteModule=ctx=>{
  const store=new ResearchStore(ctx.store.marketDb),svc=new ResearchService(store,event=>ctx.emit('research.workbench',event));
  // Pine 脚本目录 + 准入 + 即席运行(2026-09-22);传 store 让回测窗口还原成整段数据,一个数据集只跑一次引擎
  registerPineRoutes(ctx,store);
  const wrap=(handler:RouteHandler):RouteHandler=>async(req,res,url,p)=>{try{await handler(req,res,url,p);}catch(e){const message=e instanceof Error?e.message:String(e);ctx.fail(res,message.includes('not_found')?404:message.includes('busy')||message.includes('conflict')||message.includes('sealed')?409:400,message,'research_error');}};
  async function body(req:IncomingMessage):Promise<unknown>{const chunks:Buffer[]=[];let bytes=0;for await(const c of req){const b=Buffer.from(c as Buffer);bytes+=b.length;if(bytes>20*1024*1024)throw new Error('body_too_large');chunks.push(b);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  function launch(r:ResearchRequest) {
    assertContract<ResearchRequest>(r);if(!('execution' in r))throw new Error('expected_request');
    const w=ctx.rt.workflow;
    const parent=r.parent_run_id?store.get(r.parent_run_id):null;
    const kind=parent?.manifest.brain.kind??w.brain, model=parent?parent.manifest.brain.model:w.brain_model;
    const configuration_hash=hash({brain:kind,model,cli_command:ctx.rt.cliCommandFor(kind)});
    if(parent&&configuration_hash!==parent.manifest.brain.configuration_hash)throw new Error('parent_model_configuration_changed');
    const brain=ctx.rt.brainFor(kind,model);
    let source=null;
    if(r.source_strategy_ref){if(!/@\d+$/.test(r.source_strategy_ref))throw new Error('explicit_strategy_version_required');source=resolveRunStrategies([r.source_strategy_ref],ctx.store.strategies)[0]??null;if(!source)throw new Error('strategy_version_not_found');}
    const row=svc.start(r,brain,{kind,model,name:brain.name,configuration_hash},parent?.manifest.source_strategy??source,parent?.manifest.playbook??w.playbook_text);
    return runSummary(row);
  }
  ctx.route('GET','/api/research/capabilities',wrap(async(_req,res)=>ctx.json(res,200,{version:'v1',status:'research_only',limits:{walk_bars:10000,recording_bytes:33554432},active_run_id:svc.active_run_id,markets:['spot'],directions:['long'],interpreters:['donchian_close_long_v1','strategy_ir_v1'],decision_arms:['a_rules','b_agent','c_filter'],execution:{entry:'next_open_market',exit:'next_open_market',protective:'gap_then_stop_first',accounting:'fixed_point_8_decimal',position_limit:1,portfolio_position_limit:30,default_max_positions:3},unsupported:['perp','funding','liquidation','short','limit_entry','add','live_automation','external_news_history'],tools:RESEARCH_TOOLS,source_strategy_note:'source_strategy_ref 是 B 的原策略全文；A/C 使用明确的机械解释，不能默认语义相同。',eval_status:'engineering_tests_only_until_real_model_and_oos_trials',pine:pineEngineHealth(),pine_admission:'pine_admission_v2'})));
  ctx.route('POST','/api/research/strategies/precheck',wrap(async(req,res)=>ctx.json(res,200,await precheck(await body(req) as import('@trading-swarm/contracts').ResearchPrecheckRequest,store))));
  ctx.route('GET','/api/research/primitives',wrap(async(_req,res)=>ctx.json(res,200,listPrimitives())));
  ctx.route('POST','/api/research/strategies/compile',wrap(async(req,res)=>{const raw=await body(req);assertContract<import('@trading-swarm/contracts').StrategyCompileRequest>(raw);if(!('timeframe' in raw))throw new Error('expected_compile_request');ctx.json(res,200,await compileStrategy(raw,ctx.rt.brainForRole('research'),raw.dataset_id?store.dataset(raw.dataset_id):null));}));
  ctx.route('GET','/api/research/schema',wrap(async(_req,res)=>ctx.json(res,200,schemas.research)));
  ctx.route('GET','/api/research/datasets',wrap(async(_req,res)=>ctx.json(res,200,{items:store.datasets()})));
  // 外部上传的数据集只收现货:market=perp 的数据集只由永续回测报告(data/perp-market.ts)落库,旧引擎按现货做多跑,不能拿来直接实验
  ctx.route('POST','/api/research/datasets',wrap(async(req,res)=>{const raw=await body(req);if(raw&&typeof raw==='object'&&(raw as {market?:unknown}).market!=='spot')throw Error('unsupported_market:only_spot_datasets_accepted');ctx.json(res,201,store.putDataset(raw));}));
  ctx.route('POST','/api/research/datasets/from-market',wrap(async(req,res)=>ctx.json(res,201,await importMarketDataset(store,await body(req) as Parameters<typeof importMarketDataset>[1]))));
  ctx.route('GET','/api/research/assets',wrap(async(_req,res,url)=>{const exchange=url.searchParams.get('exchange')??'okx',client=await publicExchange(exchange);try{ctx.json(res,200,await new CcxtMarket(exchange,client).assets(url.searchParams.get('quote')??'USDT'));}finally{await client.close?.();}}));
  ctx.route('POST','/api/research/universes',wrap(async(req,res)=>{
    const raw=await body(req);assertContract<ResearchUniverseRequest>(raw);
    if(!('market_factor' in raw)||!('from_ms' in raw))throw new Error('expected_universe_request');
    let provider:CcxtMarket|undefined,selection:Awaited<ReturnType<CcxtMarket['assets']>>|undefined,note='';
    try {
     if(raw.filter){provider=new CcxtMarket(raw.filter.exchange,await publicExchange(raw.filter.exchange));selection=await provider.assets(raw.filter.quote,raw.from_ms-1);const picked=selectAssets(selection.items,raw.filter,raw.market_factor.kind==='btc_eth_capw'?498:raw.market_factor.kind==='btc'?499:500);if(!picked.items.length)throw Error('empty_asset_pool');raw.symbols=picked.items.map(a=>a.symbol) as [string,...string[]];note=picked.note+'；'+selection.note;if(raw.market_factor.kind==='equal_weight_universe')raw.market_factor.symbols=raw.symbols as [string,...string[]];}
     const factor=factorDefinition(raw),members=[];
     for(const symbol of [...new Set([...(raw.symbols??[]),...factor.symbols])].sort()){
      const saved=await importMarketDataset(store,{...raw,symbol},true,provider?{exchange:provider.exchange,fetchKlines:provider.fetchKlines.bind(provider)}:undefined);members.push({id:saved.id,data:store.dataset(saved.id)});
     }
     const universe=buildUniverse(raw,members);
     if(raw.filter&&selection){universe.filter=raw.filter;universe.selection_as_of=raw.from_ms-1;universe.selection_note=note;universe.eligibility=Object.fromEntries(universe.members.map(m=>{const listed=selection!.items.find(a=>a.symbol===m.symbol)?.first_available_at??null;return [m.symbol,{listed_at:listed,eligible_close_times:listed===null?[]:store.dataset(m.dataset_id).bars.filter(b=>b.open_time>=listed).map(b=>b.close_time)}];}));universe.id=hash({members:universe.members.map(m=>({symbol:m.symbol,dataset_id:m.dataset_id})),market_factor:universe.market_factor,filter:universe.filter,selection_as_of:universe.selection_as_of,eligibility:universe.eligibility});}
     ctx.json(res,201,store.putUniverse(universe));
    }finally{await provider?.client.close?.();}
  }));
  ctx.route('GET','/api/research/universes',wrap(async(_req,res)=>ctx.json(res,200,{items:store.universes()})));
  ctx.route('GET','/api/research/universes/:id',wrap(async(_req,res,_url,p)=>ctx.json(res,200,store.universe(p['id']!))));
  ctx.route('GET','/api/research/universes/:id/screen',wrap(async(_req,res,url,p)=>{
    const u=store.universe(p['id']!),opts:Parameters<typeof screenUniverse>[2]={};
    for(const name of ['as_of','window_bars','lookback_bars','top_n'] as const)if(url.searchParams.has(name))opts[name]=Number(url.searchParams.get(name));
    ctx.json(res,200,screenUniverse(u,u.members.map(m=>store.dataset(m.dataset_id)),opts));
  }));
  ctx.route('POST','/api/research/studies',wrap(async(req,res)=>ctx.json(res,201,store.putStudy(await body(req)))));
  ctx.route('GET','/api/research/studies/:id',wrap(async(_req,res,_url,p)=>{const s=store.study(p['id']!);if(!s)throw new Error('study_not_found');ctx.json(res,200,s);}));
  ctx.route('POST','/api/research/estimate',wrap(async(req,res)=>{const raw=await body(req);assertContract<ResearchRequest>(raw);if(!('execution' in raw))throw new Error('expected_request');ctx.json(res,200,await svc.estimate(raw));}));
  ctx.route('POST','/api/research/runs',wrap(async(req,res)=>ctx.json(res,202,launch(await body(req) as ResearchRequest))));
  ctx.route('GET','/api/research/runs',wrap(async(_req,res)=>ctx.json(res,200,{items:store.summaries()})));
  ctx.route('GET','/api/research/runs/:id',wrap(async(_req,res,_url,p)=>{const r=store.get(p['id']!);if(!r)throw new Error('run_not_found');ctx.json(res,200,runSummary(r));}));
  ctx.route('GET','/api/research/runs/:id/result',wrap(async(_req,res,_url,p)=>{const r=store.get(p['id']!);if(!r)throw new Error('run_not_found');ctx.json(res,200,{run_id:r.id,status:r.status,result:r.result?{...r.result,recordings:undefined}:null});}));
  ctx.route('GET','/api/research/runs/:id/export',wrap(async(_req,res,_url,p)=>{const r=store.get(p['id']!);if(!r)throw new Error('run_not_found');ctx.json(res,200,{run:r,dataset:store.dataFor(r.manifest.request),...(r.manifest.request.universe_id?{universe:store.universe(r.manifest.request.universe_id),datasets:store.portfolio(r.manifest.request.universe_id).datasets}:{}),model_calls:store.traces(r.id)});}));
  ctx.route('GET','/api/research/runs/:id/events',wrap(async(_req,res,url,p)=>{const after=Number(url.searchParams.get('after')??0);if(!Number.isSafeInteger(after)||after<0)throw new Error('invalid_cursor');if(!store.get(p['id']!))throw new Error('run_not_found');const events=store.events(p['id']!,after);ctx.json(res,200,{items:events,next_cursor:events.at(-1)?.seq??after});}));
  ctx.route('GET','/api/research/runs/:id/evidence',wrap(async(_req,res,url,p)=>{const row=store.get(p['id']!);if(!row)throw new Error('run_not_found');const offset=Number(url.searchParams.get('offset')??0);if(!Number.isSafeInteger(offset)||offset<0)throw new Error('invalid_cursor');const recordings=row.result?.recordings??[];ctx.json(res,200,{recordings:recordings.slice(offset,offset+5),total:recordings.length,model_calls:store.traces(row.id).slice(offset,offset+5),note:'recordings 与 model_calls 是不同集合；repair 可能额外占一次调用'});}));
  ctx.route('GET','/api/research/runs/:id/attribution',wrap(async(_req,res,_url,p)=>ctx.json(res,200,await svc.attribution(p['id']!))));
  ctx.route('POST','/api/research/runs/:id/cancel',wrap(async(_req,res,_url,p)=>ctx.json(res,200,runSummary(svc.cancel(p['id']!)))));
  ctx.route('POST','/api/research/runs/:id/replay',wrap(async(_req,res,_url,p)=>ctx.json(res,200,await svc.replay(p['id']!))));
  ctx.route('POST','/api/research/tools',wrap(async(req,res)=>ctx.json(res,200,await researchTool(await body(req) as ResearchToolCall,svc,launch,ctx.rt.brainForRole('research')))));
  registerLoopRoutes(ctx,store,svc,body);
  // §9.46 全窗口多资产回测报告 + 策略对象生命周期(策略路由靠 onBacktestReport 订阅回测报告挂链)
  registerBacktestRoutes(ctx,store,svc,body);
  registerStrategyRoutes(ctx,store,svc,body);
  registerImproveRoutes(ctx,body);// 策略自动改进与复验环(worker 线程跑,进度广播 research.improve)
  registerEvolutionRoutes(ctx);// 进化页只读聚合(docs/design/evolution-floor-2026-09-23.md)
  registerUniverseRoutes(ctx);// OKX 资产全集 + 每日全市场扫描(docs/design/watch-screener-review-2026-09-24.md 二-1)
  ctx.route('GET','/api/research/artifacts/:id',wrap(async(_req,res,_url,p)=>ctx.json(res,200,store.artifact(p['id']!))));
  ctx.route('GET','/api/research/chats/:id',wrap(async(_req,res,_url,p)=>ctx.json(res,200,store.getChat(p['id']!))));
  ctx.route('POST','/api/research/chat',wrap(async(req,res)=>ctx.json(res,200,await researchChat(await body(req) as ResearchChatRequest,svc,ctx.rt.brainForRole('research'),launch,{emit:event=>ctx.emit('research.chat',event)}))));
};
