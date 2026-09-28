// 公网演示的 HTTP 闸门 —— 「公网演示模式权限表」的唯一定义处(报告照此列出)。http.ts 只在入口调 publicGate、
// 在分发处调 runWithDemoContext、在 json()/SSE 处调 publicBody / publicSseFrame。
//
//   owner      :全部接口,与本机开发同权(live 通道在公网部署里根本不注册,见 main.ts)。
//   invited    :同 anonymous,但限频/日次数/日花费更高。
//   anonymous  :所有 GET 可读(OWNER_ONLY_READS 返回「仅所有者可见」占位,/api/logs 只给时间与级别,
//                agent 名册去掉 owner 私聊预览 last_text;judge-live 列表/汇总/流是只读判断账本,放行,流计入 SSE 并发);
//                写接口只放行 PLAY_ROUTES(不碰机密的可玩写操作),其余一律 403 judge_locked(英文 message)。
import type http from 'node:http';
import {
  assertHeavyAvailable,
  claimSlot,
  DemoDenied,
  demoContext,
  exchangeSessionCookie,
  identify,
  limitDemoAction,
  limitRequest,
  publicDemo,
  visitorContext,
  type DemoContext,
} from './public-demo.js';
import { publicView } from './public-view.js';
import { englishDeep } from './public-en.js';
import { aspSnapshotEnabled } from './asp-snapshot.js';
import { envInt } from './ops-config.js';
import { ownsDemoSession } from './public-routes.js';
import type { DemoStore } from './store.js';

export type PlayKind = 'chat' | 'light' | 'heavy';

export interface PlayContext {
  params: Record<string, string>;
  backendKind: string;
  store: DemoStore;
}

export interface PlayRoute {
  method: 'POST' | 'PUT' | 'PATCH';
  pattern: RegExp;
  kind: PlayKind;
  title: string;
  /** 只在 paper 通道开放(交易写与策略运行)。 */
  paperOnly?: boolean;
  /** 路由级附加检查(URL 参数、当前状态);不过就抛 DemoDenied。 */
  check?: (x: PlayContext) => void;
  /** 请求体检查:闸门先读出请求体检查,再交给 http.ts 的 readBody(takePrereadBody)。 */
  body?: (body: Record<string, unknown>) => void;
}

const locked = (reason: string): DemoDenied => new DemoDenied(`Locked in the review demo: ${reason}`);

/** 评审版可勾选的观察币(锁定范围)。TG_DEMO_WATCHLIST_ALLOWED 逗号分隔覆盖。 */
export function demoWatchlistAllowed(): string[] {
  const raw = process.env['TG_DEMO_WATCHLIST_ALLOWED'] || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,HYPEUSDT,XAUUSDT,NVDAUSDT,TSLAUSDT';
  return raw.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw locked(`${what} may only change ${allowed.join(', ')} (got ${extra.join(', ')}).`);
}

/**
 * 访客可调用的写接口(演示可玩类)。不碰机密:钱包、凭证、模型连接、执行通道、ASP 写、live、紧急停止都不在表里。
 * 不在表里的 POST/PUT/PATCH/DELETE 一律 403 judge_locked。每一项都计入限频与每日次数;模型调用计入日花费上限;
 * heavy 类占全局并发 1 的重计算槽。
 */
export const PLAY_ROUTES: readonly PlayRoute[] = [
  { method: 'POST', pattern: /^\/api\/chat\/messages$/, kind: 'chat', title: '和 agent 对话(带只读工具:推荐资产、Radar 筛选、我的策略、回测报告、Jev 实盘判断;访客只看得到自己的会话)' },
  { method: 'POST', pattern: /^\/api\/chat\/sessions$/, kind: 'light', title: '新建自己的对话会话' },
  { method: 'POST', pattern: /^\/api\/recommendations$/, kind: 'light', title: '推荐资产(纯代码计算,零模型)' },
  { method: 'POST', pattern: /^\/api\/research\/(?:estimate|strategies\/precheck)$/, kind: 'light', title: '研究估算 / 策略预检' },
  { method: 'POST', pattern: /^\/api\/research\/(?:chat|strategies\/compile)$/, kind: 'light', title: '研究问答 / 策略编译(模型调用计入演示花费)' },
  { method: 'POST', pattern: /^\/api\/research\/datasets(?:\/from-market)?$/, kind: 'light', title: '导入研究数据集(受数据集容量上限约束)' },
  { method: 'POST', pattern: /^\/api\/research\/matrix-studies\/estimate$/, kind: 'light', title: '矩阵研究估算' },
  { method: 'POST', pattern: /^\/api\/backtest$/, kind: 'heavy', title: '跑回测' },
  { method: 'POST', pattern: /^\/api\/research\/(?:runs|studies|backtests)$/, kind: 'heavy', title: '跑研究 / 研究回测' },
  { method: 'POST', pattern: /^\/api\/research\/sessions\/[^/]+\/commands$/, kind: 'heavy', title: '自然语言研究 loop' },
  { method: 'POST', pattern: /^\/api\/research\/pine\/run$/, kind: 'heavy', title: 'Pine 脚本试跑' },
  { method: 'POST', pattern: /^\/api\/screener\/run$/, kind: 'heavy', title: '筛选器试跑(不改观察列表)' },
  { method: 'POST', pattern: /^\/api\/(?:run-now|scan-now)$/, kind: 'light', title: '手动触发一次判断 / 扫描(模型调用计入演示花费)' },
  { method: 'POST', pattern: /^\/api\/orders$/, kind: 'light', paperOnly: true, title: 'paper 模拟下单' },
  {
    method: 'POST', pattern: /^\/api\/threads\/([^/]+)\/close$/, kind: 'light', paperOnly: true, title: 'paper 模拟平仓/撤单',
    check: ({ params, store }) => {
      const thread = store.thread(params['id'] ?? '');
      if (thread && thread.backend !== 'paper') throw locked('only paper positions can be closed from the demo.');
    },
  },
  {
    method: 'PUT', pattern: /^\/api\/agent\/strategy$/, kind: 'light', paperOnly: true, title: '把示例策略设为 agent 当前策略(仅 paper)',
  },
  {
    method: 'POST', pattern: /^\/api\/strategy-runs$/, kind: 'light', paperOnly: true, title: '启动策略运行(仅 paper,不发布到 ASP)',
    body: (b) => {
      if (b['publish_asp'] === true) throw locked('publishing signals to OKX.AI (ASP) is owner-only.');
      if ('confirm' in b) throw locked('live confirmation is not available in the demo.');
    },
  },
  {
    method: 'PATCH', pattern: /^\/api\/strategy-runs\/[^/]+$/, kind: 'light', paperOnly: true, title: '暂停/恢复/停止策略运行、改判断方式(仅 paper)',
    body: (b) => {
      onlyKeys(b, ['status', 'mode'], 'Strategy runs');
      // 09-27 Jacky:评审可以自己切判断方式,包括 Jev(每次判断约 $0.00002,只在出候选时调用)
      if ('mode' in b && !['auto', 'agent', 'jev', 'signal_only'].includes(String(b['mode']))) throw locked('the decision mode must be auto, agent, jev or signal_only.');
    },
  },
  {
    // AI 扫盘的暂停是全站共用的:访客暂停会让所有人的 AI 扫盘停下,所以访客只能恢复
    method: 'PATCH', pattern: /^\/api\/trading\/sources\/ai_scan$/, kind: 'light', title: '恢复 AI 扫盘(访客不能暂停)',
    body: (b) => {
      onlyKeys(b, ['paused'], 'AI Scan');
      if (b['paused'] !== false) throw locked('Pausing AI Scan is turned off in the public demo so it keeps running for everyone.');
    },
  },
  { method: 'POST', pattern: /^\/api\/strategy-runs\/[^/]+\/scan$/, kind: 'light', paperOnly: true, title: '让策略运行立即扫描一次(仅 paper)' },
  {
    method: 'POST', pattern: /^\/api\/workflow$/, kind: 'light', title: '在锁定的 10 个币里勾选观察列表',
    body: (b) => {
      onlyKeys(b, ['watchlist'], 'Settings');
      const list = b['watchlist'];
      const allowed = demoWatchlistAllowed();
      if (!Array.isArray(list) || list.length === 0 || list.some((x) => typeof x !== 'string' || !allowed.includes(x.toUpperCase()))) {
        throw locked(`the watchlist must be a non-empty subset of ${allowed.join(', ')}.`);
      }
    },
  },
];

/** 访客 GET 时返回占位:这些读取要么含账户/钱包/模型配置,要么每次会 spawn 外部 CLI(公开即 DoS 面)。 */
export const OWNER_ONLY_READS: readonly RegExp[] = [
  /^\/api\/wallet(?:\/|$)/,
  /^\/api\/models(?:\/|$)/,
  /^\/api\/brains(?:\/|$)/,
  /^\/api\/execution(?:\/|$)/,
  /^\/api\/okx\/account$/,
  /^\/api\/market\/(?:status|identity|subscriptions|devices|search|asp|wallet|inbox)(?:\/|$)/,
  /^\/api\/asp-services\/provider-tasks(?:\/|$)/,
];

/** 快照模式(TG_PUBLIC_ASP_SNAPSHOT)下这些读取由已脱敏的快照回答,不碰钱包/CLI,访客可见(评审版 OKX.AI 页)。 */
export const SNAPSHOT_PUBLIC_READS: readonly RegExp[] = [/^\/api\/market(?:\/|$)/, /^\/api\/asp-services(?:\/|$)/];
export const ownerOnlyRead = (pathname: string): boolean =>
  OWNER_ONLY_READS.some((p) => p.test(pathname)) && !(aspSnapshotEnabled() && SNAPSHOT_PUBLIC_READS.some((p) => p.test(pathname)));

/** 访客 GET 时要占重计算槽:CPU/外部分页成本可被查询参数放大。 */
export const HEAVY_READS: readonly RegExp[] = [
  /\/funnel$/,
  /\/screen$/,
  /\/attribution$/,
  /\/replay$/,
  /\/scorecard$/,
  /^\/api\/backtest\/estimate$/,
  /^\/api\/market\/klines\/history$/,
  /^\/api\/research\/assets$/,
];

/** 长连接(SSE):访客按单访客/全站并发计数,断开即释放。 */
export const STREAM_ROUTES: readonly RegExp[] = [/^\/api\/events$/, /^\/api\/judge\/live\/stream$/];

/** 访客读取时去掉的字段(按路径):agent 名册里的 last_text 是 owner 与九个 agent 私聊的最后一句。 */
const VISITOR_STRIP_FIELDS: readonly { path: RegExp; fields: readonly string[] }[] = [
  { path: /^\/api\/agents(?:\/|$)/, fields: ['last_text'] },
];

/** 访客的 SSE 不推这些事件(与 OWNER_ONLY_READS 对应)。 */
const VISITOR_HIDDEN_EVENTS = new Set(['log', 'models.changed', 'execution.changed', 'market_subscription', 'market_delivery', 'market_aftersale', 'memory.changed']);

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const responseContext = new WeakMap<http.ServerResponse, { ctx: DemoContext; pathname: string }>();

const openStreams = new Map<string, number>();
let openStreamTotal = 0;

/** 访客打开 SSE:超过单访客 TG_DEMO_STREAMS_PER_VISITOR(默认 8;一个标签页最多 2 条:/api/events + Jev 判断流,开几个标签页也够)或全站 TG_DEMO_MAX_STREAMS(默认 200)条就拒绝;连接关闭时释放。 */
function claimStream(ctx: DemoContext, res: http.ServerResponse): void {
  const mine = openStreams.get(ctx.visitor) ?? 0;
  if (mine >= envInt('TG_DEMO_STREAMS_PER_VISITOR', 8) || openStreamTotal >= envInt('TG_DEMO_MAX_STREAMS', 200)) throw new DemoDenied('Too many live connections from this visitor. Close other tabs and retry.', 'demo_rate_limited', 429);
  openStreams.set(ctx.visitor, mine + 1);
  openStreamTotal++;
  res.once('close', () => {
    const left = (openStreams.get(ctx.visitor) ?? 1) - 1;
    if (left > 0) openStreams.set(ctx.visitor, left);
    else openStreams.delete(ctx.visitor);
    openStreamTotal--;
  });
}

function stripFields(value: unknown, fields: readonly string[], depth = 0): unknown {
  if (depth > 20) return value;
  if (Array.isArray(value)) return value.map((item) => stripFields(item, fields, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) if (!fields.includes(key)) out[key] = stripFields(item, fields, depth + 1);
    return out;
  }
  return value;
}

export interface GateDeps {
  store: DemoStore;
  backendKind: () => string;
  respond: (res: http.ServerResponse, status: number, body: unknown) => void;
  readBody: (req: http.IncomingMessage) => Promise<Record<string, unknown>>;
}

export interface GateOutcome {
  /** 闸门已经写好响应(拒绝、占位、换 cookie),调用方直接 return。 */
  handled: boolean;
  /** 公网演示下的访问身份;非公网部署为 null。 */
  ctx: DemoContext | null;
}

function denyBody(e: DemoDenied): { error: { code: string; message: string }; locked: boolean } {
  return { error: { code: e.code, message: e.message }, locked: e.code === 'judge_locked' };
}

export function findPlayRoute(method: string, pathname: string): PlayRoute | undefined {
  return PLAY_ROUTES.find((r) => r.method === method && r.pattern.test(pathname));
}

export async function publicGate(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: GateDeps): Promise<GateOutcome> {
  if (!publicDemo()) return { handled: false, ctx: null };
  const method = req.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/api/demo/session') {
    // 评审链接 `/?invite=` 由 nginx 转到这里;无效也照样回首页只读浏览,不给报错页。
    const issued = exchangeSessionCookie(url);
    const headers: http.OutgoingHttpHeaders = { location: '/', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' };
    if (issued) headers['set-cookie'] = issued.cookie;
    res.writeHead(303, headers);
    res.end();
    return { handled: true, ctx: null };
  }

  const ctx = identify(req);
  try {
    limitRequest(ctx);
  } catch (e) {
    if (!(e instanceof DemoDenied)) throw e;
    deps.respond(res, e.status, denyBody(e));
    return { handled: true, ctx };
  }
  responseContext.set(res, { ctx, pathname: url.pathname });

  if (method === 'GET' && url.pathname === '/api/demo/whoami') {
    deps.respond(res, 200, { public_demo: true, role: ctx.role, read_only: !ctx.owner });
    return { handled: true, ctx };
  }
  if (ctx.owner) return { handled: false, ctx };

  if (READ_METHODS.has(method)) {
    if (method === 'GET' && STREAM_ROUTES.some((p) => p.test(url.pathname))) {
      try {
        claimStream(ctx, res);
      } catch (e) {
        if (!(e instanceof DemoDenied)) throw e;
        deps.respond(res, e.status, denyBody(e));
        return { handled: true, ctx };
      }
    }
    if (method !== 'OPTIONS' && ownerOnlyRead(url.pathname)) {
      // 403 + 标准错误体:前端 request() 按错误走各页已有的「没数据」路径。回 200 占位会被当成真数据解构(09-26 全站黑屏)。
      deps.respond(res, 403, { error: { code: 'judge_locked', message: 'Locked in the review demo: account, wallet, model and execution details are owner-only.' }, locked: true });
      return { handled: true, ctx };
    }
    if (method === 'GET' && url.pathname === '/api/logs') {
      const logs = deps.store.logs(100).map((r) => ({ at: r.at, level: r.level, scope: r.scope, message: 'Log details are owner-only in the review demo.' }));
      deps.respond(res, 200, { logs, next_before_id: null });
      return { handled: true, ctx };
    }
    return { handled: false, ctx };
  }

  try {
    const play = findPlayRoute(method, url.pathname);
    if (!play) throw locked('this action is owner-only (wallet, credentials, models, execution channel, ASP writes, live trading and emergency stop stay locked).');
    const backendKind = deps.backendKind();
    if (play.paperOnly && backendKind !== 'paper') throw locked('trading actions are only open on the paper channel, and the current channel is not paper.');
    play.check?.({ params: routeParams(play, url.pathname), backendKind, store: deps.store });
    if (play.body) {
      const body = await deps.readBody(req);
      play.body(body);
      prereadBodies.set(req, body);
    }
    if (play.kind === 'heavy') assertHeavyAvailable();
    limitDemoAction(ctx);
  } catch (e) {
    if (!(e instanceof DemoDenied)) throw e;
    deps.respond(res, e.status, denyBody(e));
    return { handled: true, ctx };
  }
  return { handled: false, ctx };
}

function routeParams(play: PlayRoute, pathname: string): Record<string, string> {
  const m = play.pattern.exec(pathname);
  return m?.[1] ? { id: decodeURIComponent(m[1]) } : {};
}

const prereadBodies = new WeakMap<http.IncomingMessage, Record<string, unknown>>();

/** http.ts 的 readBody 先取闸门已读过的请求体(请求流只能读一次)。 */
export function takePrereadBody(req: http.IncomingMessage): Record<string, unknown> | undefined {
  const body = prereadBodies.get(req);
  prereadBodies.delete(req);
  return body;
}

/** 路由分发:访客请求在访客上下文里跑(模型计费、写闸门都靠它),重读取占重计算槽;owner 与非公网部署原样执行。 */
export async function runWithDemoContext(ctx: DemoContext | null, method: string, pathname: string, fn: () => Promise<void>): Promise<void> {
  if (!ctx || ctx.owner) return fn();
  const release = method === 'GET' && HEAVY_READS.some((p) => p.test(pathname)) ? claimSlot('heavy') : () => undefined;
  try {
    await demoContext.run(ctx, fn);
  } finally {
    release();
  }
}

/**
 * 自己跑的实例(不是公网演示)设 TG_PUBLIC_LANG=en 时,本人看到的响应也走英文层:只翻中文文本,不脱敏、不删字段。
 * 公网演示里 owner 仍看原文。
 */
const ownerEnglish = (): boolean => process.env['TG_PUBLIC_LANG'] === 'en' && process.env['TG_PUBLIC_DEMO'] !== '1';

/** json() 用:访客响应走公开投影。 */
export function publicBody(res: http.ServerResponse, body: unknown): unknown {
  const entry = responseContext.get(res);
  if (!entry || entry.ctx.owner) return ownerEnglish() ? englishDeep(body) : body;
  const strip = VISITOR_STRIP_FIELDS.filter((r) => r.path.test(entry.pathname)).flatMap((r) => r.fields);
  return publicView(strip.length ? stripFields(body, strip) : body);
}

/** SSE 用:返回 null 表示这条不推给这个连接。 */
export function publicSseFrame(res: http.ServerResponse, store: DemoStore, event: string, data: unknown): string | null {
  const ctx = responseContext.get(res)?.ctx;
  if (!ctx || ctx.owner) return `event: ${event}\ndata: ${JSON.stringify(ownerEnglish() ? englishDeep(data) : data)}\n\n`;
  if (VISITOR_HIDDEN_EVENTS.has(event)) return null;
  if (event === 'chat.message') {
    const session = (data as { session_id?: unknown } | null)?.session_id;
    if (typeof session !== 'string' || !ownsDemoSession(store, session, ctx.visitor)) return null;
  }
  return `event: ${event}\ndata: ${JSON.stringify(publicView(data))}\n\n`;
}

/** http.ts 里判断当前请求是否访客(聊天路由分流用)。 */
export const isVisitorRequest = (): boolean => visitorContext() !== null;
