/**
 * ASP 对外服务(按次 + 订阅频道)的本地面:上架 JSON、配置 serviceId 与价格、本地预览、推送/交付账本。
 * 零链上写入:上架/提审由人拿 listing.service_arg 去跑 `onchainos agent update`;预览不 deliver。
 *   GET  /api/asp-services                         → { listings, config, pushes, results, running }
 *   PUT  /api/asp-services/config                  { service_ids?, prices? } → config(serviceId 变更后重新注册 handler)
 *   POST /api/asp-services/preview/:listing        { description?, service_params?, allow_paid? } → Deliverable
 *   POST /api/asp-services/channels/:channel/preview → ChannelPush(欢迎包口径)
 *   GET  /api/asp-services/monitor[?lang=en&fresh=1] → AspMonitor(只读健康快照:上架/接单轮询/守护/录制器/网络/各服务/近期订单)
 *   GET  /api/asp-services/monitor/pushes?service_id=&hours= · GET …/monitor/tasks/:job_id · POST …/monitor/retry-pushes(见 asp-agent/monitor.ts)
 *   GET  /api/asp-services/provider-tasks · POST …/:job_id/reproduce(skipped 且从未投递)· POST …/:job_id/retry(交付失败/未知)
 *   GET  /api/asp-services/products                → ASP 身份条 + 新手清单 + 8 张产品卡(service-list 缓存 5 分钟)
 *   GET  /api/asp-services/products/:key/customers  → 订阅者(订阅类)或订单(按次类)
 *   POST /api/asp-services/products/:key/pause      { paused } → 暂停/恢复接单(kv asp_services.paused)
 *   POST /api/asp-services/products/:key/draft      { price?, description?: [3 段] } → { service_payload, validate, warns, diff },不写链
 *   POST /api/asp-services/products/:key/apply      { confirm: true, service_payload } → `agent update`(对外写,触发 OKX 重新审核)
 * 付费模型类服务(Jev)预览要显式 allow_paid:true,每次按 JUDGE_MAX_CALL_USD 计费。
 */
import type { RouteModule } from './http-extra.js';
import { aspServices } from './asp-agent/services/index.js';
import { LISTINGS, LISTING_KEYS } from './asp-agent/services/catalog.js';
import { buildAspMonitor, expediteFailedPushes, isStrategySignal, monitorPushes, monitorTask } from './asp-agent/monitor.js';
import { signalServiceId } from './asp-agent/agent.js';

export const aspServiceRoutes: RouteModule = (ctx) => {
  const hub = () => { const h = aspServices(); if (!h) throw Object.assign(new Error('ASP 服务未初始化'), { status: 503 }); return h; };
  const fail = (res: Parameters<typeof ctx.fail>[0], e: unknown) => {
    const err = e as Error & { status?: number; code?: string };
    ctx.fail(res, err.status ?? (err.code ? 400 : 500), err.message, err.code ?? 'asp_services_error');
  };
  ctx.route('GET', '/api/asp-services', async (_req, res) => { try { ctx.json(res, 200, hub().overview()); } catch (e) { fail(res, e); } });
  ctx.route('PUT', '/api/asp-services/config', async (req, res) => { try { ctx.json(res, 200, hub().saveConfig(await ctx.readBody(req))); } catch (e) { fail(res, e); } });
  ctx.route('POST', '/api/asp-services/preview/:listing', async (req, res, _url, p) => {
    try { ctx.json(res, 200, await hub().preview(p['listing'] ?? '', await ctx.readBody(req))); } catch (e) { fail(res, e); }
  });
  // 接单账本(provider-tasks.ts):查看、重跑被本地校验跳过的交付、重发失败交付
  const poller = () => ctx.rt.marketAgent().providerTasks;
  const monitorDeps = (url: URL) => {
    const agent = ctx.rt.marketAgent(), ids = hub().config().service_ids;
    return {
      db: ctx.rt.store.marketDb, cli: agent.cli, now: () => Date.now(),
      lang: url.searchParams.get('lang') === 'en' ? 'en' as const : 'zh' as const, fresh: url.searchParams.get('fresh') === '1',
      // ASP 身份几乎不变:先读 kv 缓存(不看 60 秒 TTL),没有才去查 CLI 且最多等 10 秒 —— 重启后 CLI 队列忙时监视接口不被拖住
      aspId: async () => {
        try { const v = JSON.parse(ctx.rt.store.kvGet('market.asp_identity') ?? '{}')?.value?.asp; const id = v?.agentId ?? v?.aspAgentId ?? v?.id; if (id) return String(id); } catch { /* 走 CLI */ }
        const timeout = new Promise<null>((r) => { const t = setTimeout(() => r(null), 10_000); t.unref?.(); });
        try { return await Promise.race([agent.identity.aspId(), timeout]); } catch { return null; }
      },
      poller: () => agent.providerTasks.status(),
      services: () => [
        { service_id: signalServiceId(ctx.rt.store), name: 'Strategy Signals', kind: 'subscription' as const },
        ...LISTING_KEYS.filter((k) => ids[k]).map((k) => ({ service_id: ids[k]!, name: LISTINGS[k].name, kind: LISTINGS[k].kind })),
      ],
      strategyRuns: () => { try { return ctx.rt.strategyRuns().store.list(); } catch { return []; } },
    };
  };
  ctx.route('GET', '/api/asp-services/monitor', async (_req, res, url) => {
    try { ctx.json(res, 200, await buildAspMonitor(monitorDeps(url))); } catch (e) { fail(res, e); }
  });
  ctx.route('GET', '/api/asp-services/monitor/pushes', async (_req, res, url) => {
    try {
      const sid = url.searchParams.get('service_id') ?? '';
      if (!sid) throw Object.assign(new Error('service_id is required'), { status: 400 });
      const strategy = sid === signalServiceId(ctx.rt.store) || isStrategySignal(url.searchParams.get('name') ?? '');
      ctx.json(res, 200, monitorPushes(ctx.rt.store.marketDb, sid, { now: Date.now(), hours: Number(url.searchParams.get('hours') ?? 24), strategy, lang: url.searchParams.get('lang') === 'en' ? 'en' : 'zh' }));
    } catch (e) { fail(res, e); }
  });
  ctx.route('GET', '/api/asp-services/monitor/tasks/:job_id', async (_req, res, url, p) => {
    try {
      const row = monitorTask(ctx.rt.store.marketDb, p['job_id']!, url.searchParams.get('lang') === 'en' ? 'en' : 'zh');
      if (!row) throw Object.assign(new Error('task not found'), { status: 404 });
      ctx.json(res, 200, row);
    } catch (e) { fail(res, e); }
  });
  ctx.route('POST', '/api/asp-services/monitor/retry-pushes', async (_req, res) => {
    try { const n = expediteFailedPushes(ctx.rt.store.marketDb, Date.now()); void hub().broadcaster.tick(); ctx.json(res, 200, { expedited: n }); } catch (e) { fail(res, e); }
  });
  ctx.route('GET', '/api/asp-services/provider-tasks', async (_req, res) => {
    try { const p = poller(); ctx.json(res, 200, { status: p.status(), items: p.rows(100).map((r) => ({ ...r, event: p.event(r.job_id) })) }); } catch (e) { fail(res, e); }
  });
  ctx.route('POST', '/api/asp-services/provider-tasks/:job_id/reproduce', async (_req, res, _url, p) => {
    try { ctx.json(res, 200, await poller().reproduce(p['job_id'] ?? '')); } catch (e) { fail(res, e); }
  });
  ctx.route('POST', '/api/asp-services/provider-tasks/:job_id/retry', async (_req, res, url, p) => {
    try { ctx.json(res, 200, await poller().retryDeliver(p['job_id'] ?? '', { fresh: url.searchParams.get('fresh') === '1' })); } catch (e) { fail(res, e); }
  });
  // 我的产品(卖方视图)
  ctx.route('GET', '/api/asp-services/products', async (_req, res) => { try { ctx.json(res, 200, await hub().products()); } catch (e) { fail(res, e); } });
  ctx.route('GET', '/api/asp-services/products/:key/customers', async (_req, res, _url, p) => {
    try { ctx.json(res, 200, await hub().customers(p['key'] ?? '')); } catch (e) { fail(res, e); }
  });
  ctx.route('POST', '/api/asp-services/products/:key/pause', async (req, res, _url, p) => {
    try { ctx.json(res, 200, hub().setPaused(p['key'] ?? '', await ctx.readBody(req))); } catch (e) { fail(res, e); }
  });
  ctx.route('POST', '/api/asp-services/products/:key/draft', async (req, res, _url, p) => {
    try { ctx.json(res, 200, await hub().draft(p['key'] ?? '', await ctx.readBody(req))); } catch (e) { fail(res, e); }
  });
  ctx.route('POST', '/api/asp-services/products/:key/apply', async (req, res, _url, p) => {
    try { ctx.json(res, 200, await hub().apply(p['key'] ?? '', await ctx.readBody(req))); } catch (e) { fail(res, e); }
  });
  ctx.route('POST', '/api/asp-services/channels/:channel/preview', async (_req, res, _url, p) => {
    try { ctx.json(res, 200, await hub().previewChannel(p['channel'] ?? '')); } catch (e) { fail(res, e); }
  });
};
