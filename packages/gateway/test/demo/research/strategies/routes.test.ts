import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validate, type BacktestReport } from '@trading-swarm/contracts';
import { openStateDb } from '../../../../src/state-db.js';
import type { DemoRuntime } from '../../../../src/demo/runtime.js';
import type { DemoStore } from '../../../../src/demo/store.js';
import { DEFAULT_WORKFLOW } from '../../../../src/demo/workflow.js';
import { emitBacktestReport } from '../../../../src/demo/research/hooks.js';
import { defaultIR, meta, report, variantIR } from './fixtures.js';

// WP-A 的回测报告服务还是占位:这里按签名 mock,落库 + emit 与真实实现同序(先 emit 拿挂链,再写回报告)
const bt=vi.hoisted(()=>({reports:new Map<string,BacktestReport>(),jobs:[] as unknown[]}));
vi.mock('../../../../src/demo/research/backtest-report.js',async()=>{
  const {emitBacktestReport:emit}=await import('../../../../src/demo/research/hooks.js');
  const {report:make}=await import('./fixtures.js');
  return {
    runBacktestReport:vi.fn(async(_deps:unknown,job:{strategy_ir:BacktestReport['strategy_ir'];title?:string;meta:Parameters<typeof emit>[1]})=>{
      bt.jobs.push(job);const r=make({ir:job.strategy_ir,title:job.title});const link=emit(r,job.meta);
      const saved={...r,strategy_id:link?.strategy_id??null,strategy_version:link?.strategy_version??null};bt.reports.set(r.id,saved);return saved;
    }),
    getBacktestReport:(_s:unknown,id:string)=>bt.reports.get(id)??null,
  };
});
vi.mock('node:child_process',()=>({spawn:vi.fn(()=>{throw new Error('real spawn forbidden');}),spawnSync:vi.fn(()=>{throw new Error('real spawn forbidden');})}));
vi.mock('../../../../src/demo/http-extra.js',async()=>({extraRouteModules:[(await import('../../../../src/demo/routes-research.js')).researchRoutes]}));
import { createServer } from '../../../../src/demo/http.js';

const clean:(()=>void)[]=[];
afterEach(()=>{for(const f of clean.splice(0))f();vi.restoreAllMocks();bt.reports.clear();bt.jobs.length=0;});
function app(){
  vi.spyOn(globalThis,'setInterval').mockReturnValue({unref(){}} as any);
  const state=openStateDb(':memory:');
  const brain={name:'fixture',complete:async()=>{throw new Error('no model');}};
  const rt=Object.assign(new EventEmitter(),{workflow:DEFAULT_WORKFLOW,brainFor:()=>brain,mainBrain:()=>brain,cliCommandFor:()=>null});
  const server=createServer(rt as unknown as DemoRuntime,{marketDb:state.db} as DemoStore);clean.push(()=>{server.close();state.close();});
  return async(method:string,path:string,body?:unknown)=>{
    let status=0,text='';
    const res={setHeader:()=>{},writeHead:(code:number)=>{status=code;},end:(v='')=>{text=v;}};
    const req=Object.assign(Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]),{url:path,method,headers:{origin:'http://127.0.0.1:5191'}});
    await server.listeners('request')[0]!(req as unknown as http.IncomingMessage,res as unknown as http.ServerResponse);
    return {status,json:text?JSON.parse(text):null};
  };
}
const ok=(v:unknown)=>expect(validate('research-strategy',v)).toEqual({ok:true});

describe('策略对象 HTTP(§9.46),零 socket / 零模型 / 零交易所',()=>{
  it('建 → 加版本(去重)→ 回测 → 详情带报告 → 状态机 → PATCH → 归档不列',async()=>{
    const call=app();
    const draft=await call('POST','/api/research/strategies',{name:'Untitled'});expect(draft.status).toBe(201);expect(draft.json).toMatchObject({status:'draft',current_version:0});
    const id=draft.json.id as string;
    expect((await call('POST',`/api/research/strategies/${id}/backtest`,{})).status).toBe(409);// 还没有版本
    const v1=await call('POST',`/api/research/strategies/${id}/versions`,{strategy_ir:defaultIR(),note:'v1'});expect(v1.status).toBe(200);ok(v1.json);
    expect((await call('POST',`/api/research/strategies/${id}/versions`,{strategy_ir:defaultIR()})).json.versions).toHaveLength(1);
    expect((await call('POST',`/api/research/strategies/${id}/versions`,{strategy_ir:{bad:1}})).status).toBe(400);
    const run=await call('POST',`/api/research/strategies/${id}/backtest`,{timeframe:'4h',symbols:['BTCUSDT']});
    expect(run.status,JSON.stringify(run.json)).toBe(200);const rid=run.json.report_id as string;
    expect(bt.jobs[0]).toMatchObject({timeframe:'4h',symbols:['BTCUSDT'],title:'Untitled',meta:{symbol:'BTCUSDT'}});
    expect(bt.reports.get(rid)).toMatchObject({strategy_id:id,strategy_version:1});// 监听器返回值被写回报告
    const d=await call('GET',`/api/research/strategies/${id}`);ok(d.json);
    expect(d.json.strategy.status).toBe('backtested');expect(d.json.report.id).toBe(rid);expect(d.json.reports.map((r:{id:string})=>r.id)).toEqual([rid]);
    expect(d.json.allowed_transitions).toEqual(['paper','published','archived']);
    expect((await call('GET',`/api/research/strategies/${id}?report=${rid}`)).json.report.id).toBe(rid);
    expect((await call('GET',`/api/research/strategies/${id}?report=nope`)).status).toBe(404);
    expect((await call('POST',`/api/research/strategies/${id}/transition`,{to:'live',confirm:'LIVE'})).status).toBe(409);
    expect((await call('POST',`/api/research/strategies/${id}/transition`,{to:'paper'})).json.strategy.status).toBe('paper');
    const noConfirm=await call('POST',`/api/research/strategies/${id}/transition`,{to:'live'});expect(noConfirm.status).toBe(409);expect(noConfirm.json.error.message).toContain('live_requires_confirm');
    expect((await call('POST',`/api/research/strategies/${id}/transition`,{to:'live',confirm:'LIVE'})).json.strategy.status).toBe('live');
    const p=await call('PATCH',`/api/research/strategies/${id}`,{name:'BTC 突破',watchlist:true});expect(p.json.strategy).toMatchObject({name:'BTC 突破',watchlist:true});
    const list=await call('GET','/api/research/strategies?filter=live');ok(list.json);expect(list.json.strategies.map((s:{id:string})=>s.id)).toEqual([id]);expect(list.json.counts).toMatchObject({all:1,live:1,watchlist:1});
    expect((await call('GET','/api/research/strategies?q=%E7%AA%81%E7%A0%B4')).json.strategies).toHaveLength(1);
    expect((await call('GET','/api/research/strategies?sort=bogus')).status).toBe(400);
    const del=await call('DELETE',`/api/research/strategies/${id}`);expect(del.json.strategy.status).toBe('archived');
    expect((await call('GET','/api/research/strategies')).json).toEqual({strategies:[],counts:{all:0,live:0,watchlist:0,alerts:0,draft:0}});
    expect((await call('GET','/api/research/strategies?filter=archived')).json.strategies).toHaveLength(1);
    expect((await call('GET','/api/research/strategies/missing')).status).toBe(404);
  });
  it('研究 loop 的报告经 onBacktestReport 自动建策略,再来同会话同名报告加新版本',async()=>{
    const call=app();
    const a=emitBacktestReport(report({title:'ETH 回调买入'}),meta('sess','ETH 回调'));expect(a).toMatchObject({strategy_version:1});
    const b=emitBacktestReport(report({title:'ETH 回调买入',ir:variantIR(15)}),meta('sess'));expect(b).toEqual({strategy_id:a!.strategy_id,strategy_version:2});
    const list=await call('GET','/api/research/strategies');expect(list.json.strategies).toHaveLength(1);expect(list.json.strategies[0]).toMatchObject({name:'ETH 回调买入',status:'backtested',current_version:2,origin:{source:'research_loop',session_id:'sess'}});
    expect(list.json.strategies[0].summary.sparkline.length).toBeLessThanOrEqual(120);
  });
  it('attach-session 路由:绑定、冲突 409、之后该会话的报告挂到这条草稿',async()=>{
    const call=app(),id=(await call('POST','/api/research/strategies',{name:'Untitled'})).json.id as string;
    const r=await call('POST',`/api/research/strategies/${id}/attach-session`,{session_id:'s-new'});expect(r.status).toBe(200);ok(r.json);expect(r.json.strategy.session_bound).toBe(true);
    expect((await call('POST',`/api/research/strategies/${id}/attach-session`,{session_id:'s-other'})).status).toBe(409);
    expect((await call('POST',`/api/research/strategies/${id}/attach-session`,{})).status).toBe(400);
    expect((await call('POST','/api/research/strategies/missing/attach-session',{session_id:'s'})).status).toBe(404);
    expect(emitBacktestReport(report({title:'BTC 趋势'}),meta('s-new'))).toEqual({strategy_id:id,strategy_version:1});
    expect((await call('GET',`/api/research/strategies/${id}`)).json.strategy).toMatchObject({name:'BTC 趋势',status:'backtested',current_version:1});
  });
  it('不吞已有的 /strategies/compile 与 /strategies/precheck;:id 路由排除这两个保留字',async()=>{
    const call=app();
    const compile=await call('POST','/api/research/strategies/compile',{});expect(compile.status).toBe(400);expect(compile.json.error.code).toBe('research_error');
    const pre=await call('POST','/api/research/strategies/precheck',{});expect(pre.json?.error?.code).not.toBe('research_strategy_error');
    for(const word of ['compile','precheck']){
      const g=await call('GET',`/api/research/strategies/${word}`);expect(g.status).toBe(404);expect(g.json.error.code).toBe('research_strategy_error');
      expect((await call('PATCH',`/api/research/strategies/${word}`,{name:'x'})).status).toBe(404);
      expect((await call('DELETE',`/api/research/strategies/${word}`)).status).toBe(404);
    }
  });
  it('§9.47 内置导入(幂等 + 回测挂链)与 binding 只读编译', async()=>{
    const call=app();
    const a=await call('POST','/api/research/strategies/import-builtin',{backtest:true,ids:['breakout_retest','funding_oi_extreme']});
    expect(a.status,JSON.stringify(a.json)).toBe(200);expect(validate('research-binding',a.json)).toEqual({ok:true});
    const [br,fu]=a.json.items as {strategy_id:string;report_id:string|null;created:boolean}[];
    expect(br!.report_id).toBeTruthy();expect(fu!.report_id).toBeNull();expect(bt.jobs).toHaveLength(1);
    const again=await call('POST','/api/research/strategies/import-builtin',{backtest:true,ids:['breakout_retest']});
    expect(again.json.items[0]).toMatchObject({strategy_id:br!.strategy_id,created:false,report_id:br!.report_id});expect(bt.jobs).toHaveLength(1);
    const b=await call('GET',`/api/research/strategies/${br!.strategy_id}/binding`);
    expect(b.status).toBe(200);expect(validate('research-binding',b.json)).toEqual({ok:true});
    expect(b.json.binding.roles.map((r:{role:string})=>r.role)).toEqual(['radar','judge','geometry','risk','holding','execution']);
    expect(b.json.binding.evidence_refs.report_ids).toEqual([br!.report_id]);
    expect((await call('GET',`/api/research/strategies/${fu!.strategy_id}/binding`)).json.binding).toBeNull();
    expect((await call('GET',`/api/research/strategies/${br!.strategy_id}/binding?version=9`)).status).toBe(404);
    expect((await call('POST','/api/research/strategies/import-builtin',{ids:['nope']})).status).toBe(400);
    expect((await call('GET','/api/research/strategies/import-builtin')).status).toBe(404);
  });
});
