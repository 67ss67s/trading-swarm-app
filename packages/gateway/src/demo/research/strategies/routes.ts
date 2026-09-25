/**
 * 策略对象 HTTP 面(§9.46,研究域,零交易所写入):
 *   GET    /api/research/strategies?q=&filter=all|live|watchlist|alerts&sort=updated|return|sharpe|name  列表 + 四 tab 计数
 *   POST   /api/research/strategies                  新建(不给 IR 就是 Untitled 草稿)
 *   GET    /api/research/strategies/:id[?report=]    详情(报告默认取当前版本最新一份)
 *   PATCH  /api/research/strategies/:id              改名/描述/watchlist/alerts
 *   POST   /api/research/strategies/:id/transition   状态转移(非法 409;进 live 要 confirm='LIVE')
 *   POST   /api/research/strategies/:id/versions     加版本(同 IR 哈希不新建)
 *   POST   /api/research/strategies/:id/attach-session  绑定研究会话(origin.session_id 空或相同,否则 409)
 *   POST   /api/research/strategies/:id/backtest     跑全窗口回测报告(WP-A runBacktestReport)→ {report_id}
 *   DELETE /api/research/strategies/:id              归档
 *   GET    /api/research/strategies/:id/binding[?version=]  §9.47 StrategyBinding 只读编译结果(不落库、不下发)
 *   POST   /api/research/strategies/import-builtin   五条内置策略导入研究台(幂等,{backtest?, ids?});只写研究台表
 * 研究 loop 的回测报告经 onBacktestReport 自动挂链(见 service.attachReport)。
 * 路由先注册者先匹配:POST /strategies/compile、/strategies/precheck 在 routes-research.ts 里排在前面;
 * 这里的 :id 路由再显式排除这两个保留字,防止以后调整注册顺序时被吞。
 */
import type { IncomingMessage } from 'node:http';
import type { RouteContext, RouteHandler } from '../../http-extra.js';
import type { ResearchStore } from '../store.js';
import type { ResearchService } from '../service.js';
import { onBacktestReport } from '../hooks.js';
import { StrategyStore } from './store.js';
import { StrategyService } from './service.js';

const RESERVED=new Set(['compile','precheck','import-builtin']);
// 进程内只保留最新一次注册的监听器(测试里会反复建 server,旧 DB 关闭后不该再收报告)
let unsubscribe:(()=>void)|null=null;

export function registerStrategyRoutes(ctx:RouteContext,store:ResearchStore,svc:ResearchService,body:(req:IncomingMessage)=>Promise<unknown>):{service:StrategyService;dispose:()=>void}{
  const service=new StrategyService(new StrategyStore(ctx.store.marketDb),store,svc);
  unsubscribe?.();
  const off=onBacktestReport((report,meta)=>service.attachReport(report,meta));
  unsubscribe=off;
  const wrap=(handler:RouteHandler):RouteHandler=>async(req,res,url,p)=>{
    try{if(p['id']!==undefined&&RESERVED.has(p['id']))throw new Error('strategy_not_found');await handler(req,res,url,p);}
    catch(e){const message=e instanceof Error?e.message:String(e);ctx.fail(res,message.includes('not_found')?404:message.includes('not_implemented')?501:message.includes('conflict')?409:400,message,'research_strategy_error');}
  };
  const base='/api/research/strategies';
  ctx.route('GET',base,wrap(async(_req,res,url)=>ctx.json(res,200,service.list({q:url.searchParams.get('q'),filter:url.searchParams.get('filter'),sort:url.searchParams.get('sort')}))));
  ctx.route('POST',base,wrap(async(req,res)=>ctx.json(res,201,service.create(await body(req)))));
  ctx.route('POST',`${base}/import-builtin`,wrap(async(req,res)=>ctx.json(res,200,await service.importBuiltins(await body(req)))));
  ctx.route('GET',`${base}/:id`,wrap(async(_req,res,url,p)=>ctx.json(res,200,service.detail(p['id']!,url.searchParams.get('report')))));
  ctx.route('PATCH',`${base}/:id`,wrap(async(req,res,_url,p)=>ctx.json(res,200,service.patch(p['id']!,await body(req)))));
  ctx.route('DELETE',`${base}/:id`,wrap(async(_req,res,_url,p)=>ctx.json(res,200,service.archive(p['id']!))));
  // 状态转移后广播 strategy.transitioned {id, version, from, to}:swarm/ASP 侧的 apply 钩子只订阅这个事件,不改这里(见 docs/design/strategy-apply-spec-2026-09-23.md)
  ctx.route('POST',`${base}/:id/transition`,wrap(async(req,res,_url,p)=>{const before=service.detail(p['id']!).strategy.status;const out=service.transition(p['id']!,await body(req));ctx.emit('strategy.transitioned',{id:out.strategy.id,version:out.strategy.current_version,from:before,to:out.strategy.status});ctx.json(res,200,out);}));
  ctx.route('GET',`${base}/:id/binding`,wrap(async(_req,res,url,p)=>ctx.json(res,200,service.binding(p['id']!,url.searchParams.get('version')))));
  ctx.route('POST',`${base}/:id/versions`,wrap(async(req,res,_url,p)=>ctx.json(res,200,service.addVersion(p['id']!,await body(req)))));
  ctx.route('POST',`${base}/:id/attach-session`,wrap(async(req,res,_url,p)=>ctx.json(res,200,service.attachSession(p['id']!,await body(req)))));
  ctx.route('POST',`${base}/:id/backtest`,wrap(async(req,res,_url,p)=>ctx.json(res,200,await service.backtest(p['id']!,await body(req)))));
  return {service,dispose:()=>{off();if(unsubscribe===off)unsubscribe=null;}};
}
