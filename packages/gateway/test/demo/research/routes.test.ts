import { defaultIR,node } from '../../../src/demo/research/strategy.js';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type http from 'node:http';
import { afterEach,describe,it,expect,vi } from 'vitest';
import { openStateDb } from '../../../src/state-db.js';
import type { DemoRuntime } from '../../../src/demo/runtime.js';
import type { DemoStore } from '../../../src/demo/store.js';
import { DEFAULT_WORKFLOW } from '../../../src/demo/workflow.js';
import { fixture,params,study } from './fixtures.js';
vi.mock('../../../src/demo/market.js',async importOriginal=>({...await importOriginal<typeof import('../../../src/demo/market.js')>(),marketExchange:()=> 'okx',fetchKlines:vi.fn(async()=>fixture().bars)}));
vi.mock('node:child_process',()=>({spawn:vi.fn(()=>{throw new Error('real spawn forbidden');}),spawnSync:vi.fn(()=>{throw new Error('real spawn forbidden');})}));
vi.mock('../../../src/demo/http-extra.js',async()=>({extraRouteModules:[(await import('../../../src/demo/routes-research.js')).researchRoutes]}));
import { createServer } from '../../../src/demo/http.js';
const clean:(()=>void)[]=[];
afterEach(()=>{for(const f of clean.splice(0))f();vi.restoreAllMocks();});
function app(){
 vi.spyOn(globalThis,'setInterval').mockReturnValue({unref(){}} as any);
 const state=openStateDb(':memory:');
 const brain={name:'fixture',complete:async()=>{throw new Error('A must not call model');}};
 const rt=Object.assign(new EventEmitter(),{workflow:DEFAULT_WORKFLOW,brainFor:()=>brain,brainForRole:()=>brain,mainBrain:()=>brain,cliCommandFor:()=>null});
 const store={marketDb:state.db};const server=createServer(rt as unknown as DemoRuntime,store as DemoStore);clean.push(()=>{server.close();state.close();});
 return async(path:string,body?:unknown,origin='http://127.0.0.1:5191')=>{
  const headers:Record<string,unknown>={};let status=0,text='';
  const res={setHeader:(k:string,v:unknown)=>{headers[k]=v;},writeHead:(code:number,h:object)=>{status=code;Object.assign(headers,h);},end:(v='')=>{text=v;}};
  const req=Object.assign(Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]),{url:path,method:body===undefined?'GET':'POST',headers:{origin}});
  await server.listeners('request')[0]!(req as unknown as http.IncomingMessage,res as unknown as http.ServerResponse);
  return {status,json:text?JSON.parse(text):null,headers};
 };
}
describe('研究 HTTP 集成，零socket/零模型',()=>{
 it('imports snapshot, preregisters study, runs A, exports and replays deterministically',async()=>{
  const call=app();expect((await call('/api/research/capabilities')).json.markets).toEqual(['spot']);
  const data=await call('/api/research/datasets',fixture());expect(data.status).toBe(201);const id=data.json.id;
  expect((await call('/api/research/studies',study(id))).status).toBe(201);
  const p={...params(id),execution:{...params(id).execution,sizing_mode:'risk_fraction'},arms:['a_rules']};const started=await call('/api/research/runs',p);expect(started.status,JSON.stringify(started.json)).toBe(202);
  const runId=started.json.id;let result;
  for(let i=0;i<100;i++){await new Promise<void>(resolve=>setImmediate(resolve));result=await call(`/api/research/runs/${runId}`);if(result.json.status==='completed')break;}
  expect(result?.json.status).toBe('completed');expect(result?.json.metrics[0].metrics.closed_trades).toBeGreaterThan(0);
  const replay=await call(`/api/research/runs/${runId}/replay`,{});expect(replay.json.verified).toBe(true);expect(replay.json.model_calls).toBe(0);
  expect((await call('/api/research/runs',p)).json.id).toBe(runId);
  expect((await call('/api/research/runs',{...p,max_model_calls:999})).status).toBe(409);
  const exported=await call(`/api/research/runs/${runId}/export`);expect(exported.json.dataset).toEqual(fixture());expect(exported.json.run.manifest.dataset_hash).toBe(id);
  const events=await call(`/api/research/runs/${runId}/events`);expect(events.json.items.at(-1).event).toBe('completed');
 });
 it('protects raw research prompts and SSE from foreign web origins',async()=>{const call=app();for(const path of ['/api/research/datasets','/api/research/runs/a/evidence','/api/events']){const r=await call(path,undefined,'https://hostile.test');expect(r.status).toBe(403);expect(r.headers['access-control-allow-origin']).toBeUndefined();}});
 it('rejects unsupported market and wrong request shapes before starting jobs',async()=>{const call=app();expect((await call('/api/research/datasets',{...fixture(),market:'perp'})).status).toBe(400);expect((await call('/api/research/runs',{tool:'runs.list',args:{}})).status).toBe(400);});
});

describe('第二轮 universe HTTP，mock 行情，无 socket',()=>{
 it('creates/lists/reads/screens an immutable universe through the shared market import',async()=>{
  const call=app(),d=fixture(),raw={symbols:['BTCUSDT','SOLUSDT'],timeframe:'1h',from_ms:d.bars[0]!.open_time,to_ms:d.bars.at(-1)!.close_time,market_factor:{kind:'btc',symbols:['BTCUSDT']}};
  const a=await call('/api/research/universes',raw),b=await call('/api/research/universes',raw);
  expect(a.status,JSON.stringify(a.json)).toBe(201);expect(b.json).toEqual(a.json);expect(a.json.members).toHaveLength(2);
  expect((await call('/api/research/universes')).json.items[0].id).toBe(a.json.id);
  expect((await call(`/api/research/universes/${a.json.id}`)).json).toEqual(a.json);
  const screen=await call(`/api/research/universes/${a.json.id}/screen?window_bars=50&lookback_bars=300&as_of=${d.bars[300]!.close_time}`);
  expect(screen.status,JSON.stringify(screen.json)).toBe(200);expect(screen.json.rows).toHaveLength(2);expect(screen.json.rows.every((r:any)=>r.status==='ok')).toBe(true);
  const old=await call('/api/research/datasets/from-market',{symbol:'BTCUSDT',timeframe:'1h',from_ms:raw.from_ms,to_ms:raw.to_ms});
  expect(old.status).toBe(201);expect(old.json.id).toBe(a.json.members[0].dataset_id);
 });
 it('rejects malformed factor/timeframe/query and reports absent universes',async()=>{
  const call=app();expect((await call('/api/research/universes/missing')).status).toBe(404);
  expect((await call('/api/research/universes',{symbols:['BTCUSDT']})).status).toBe(400);
  expect((await call('/api/research/datasets/from-market',{symbol:'BTCUSDT',timeframe:'bogus'})).status).toBe(400);
  const d=fixture(),u=await call('/api/research/universes',{symbols:['BTCUSDT'],timeframe:'1h',from_ms:d.bars[0]!.open_time,to_ms:d.bars.at(-1)!.close_time,market_factor:{kind:'btc',symbols:['BTCUSDT']}});
  expect((await call(`/api/research/universes/${u.json.id}/screen?as_of=NaN`)).status).toBe(400);
 });
});

describe('第二轮完整 HTTP 路径：IR / universe / diagnostics / attribution',()=>{
 it('compiles IR, runs a universe-backed study and fetches cached child attribution',async()=>{
  const call=app(),d=fixture(),created=await call('/api/research/universes',{symbols:['BTCUSDT','SOLUSDT'],timeframe:'1h',from_ms:d.bars[0]!.open_time,to_ms:d.bars.at(-1)!.close_time,market_factor:{kind:'btc',symbols:['BTCUSDT']}}),id=created.json.id;
  expect((await call('/api/research/studies',study(id))).status).toBe(201);
  const ir=defaultIR();delete ir.regime;ir.signal=[node('volume_surge',{lookback:5,multiple:0})];ir.exit=[node('chandelier_trail',{atr_period:5,multiple:2}),node('fixed_r_target',{r:2},true)];
  const compiled=await call('/api/research/strategies/compile',{ir,timeframe:'1h'});expect(compiled.status).toBe(200);expect(compiled.json.ok).toBe(true);expect((await call("/api/research/primitives")).json.items).toHaveLength(63);
  const {dataset_id:_,policy:__,...base}=params(id),request={...base,universe_id:id,strategy_ir:ir,arms:['a_rules'],repeats:1};
  const parent=await call('/api/research/runs',request);expect(parent.status,JSON.stringify(parent.json)).toBe(202);
  const wait=async(runId:string)=>{let result;for(let i=0;i<500;i++){await new Promise<void>(resolve=>setImmediate(resolve));result=await call(`/api/research/runs/${runId}/result`);if(result.json.status!=='running'&&result.json.status!=='queued')return result;}throw new Error('run did not finish');};
  const a=await wait(parent.json.id);expect(a.json.status).toBe('completed');expect(a.json.result.arms[0].diagnostics).toBeDefined();expect(a.json.result.arms[0].by_symbol).toHaveLength(2);
  expect((await call(`/api/research/runs/${parent.json.id}/replay`,{})).json.verified).toBe(true);
  const child=await call('/api/research/runs',{...request,idempotency_key:'ir-child-http',parent_run_id:parent.json.id,strategy_ir:{...ir,exit:[node('chandelier_trail',{atr_period:5,multiple:3}),node('fixed_r_target',{r:2},true)]}});expect(child.status,JSON.stringify(child.json)).toBe(202);expect((await wait(child.json.id)).json.status).toBe('completed');
  const attribution=await call(`/api/research/runs/${child.json.id}/attribution`);expect(attribution.status,JSON.stringify(attribution.json)).toBe(200);expect(attribution.json.components.map((x:any)=>x.section)).toEqual(['exit']);expect((await call(`/api/research/runs/${child.json.id}/attribution`)).json).toEqual(attribution.json);
  const exported=await call(`/api/research/runs/${child.json.id}/export`);expect(exported.json.datasets).toHaveLength(2);expect(exported.json.universe.id).toBe(id);
 });
});

it('precheck is reachable through HTTP with zero model calls and invalid bodies are rejected',async()=>{const call=app(),d=fixture(),data=await call('/api/research/datasets',d),r=params(data.json.id);const {policyToIR}=await import('../../../src/demo/research/strategy.js');const result=await call('/api/research/strategies/precheck',{ir:policyToIR(r.policy!),dataset_id:data.json.id,from_ms:r.from_ms,to_ms:r.to_ms,execution:r.execution});expect(result.status,JSON.stringify(result.json)).toBe(200);expect(result.json.items).toHaveLength(8);expect((await call('/api/research/strategies/precheck',{ir:{}})).status).toBe(400);expect((await call('/api/research/chats/missing')).status).toBe(404);expect((await call('/api/research/artifacts/missing')).status).toBe(404);});
