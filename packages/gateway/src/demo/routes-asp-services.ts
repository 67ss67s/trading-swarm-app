/**
 * ASP 对外服务(按次 + 订阅频道)的本地面:上架 JSON、配置 serviceId 与价格、本地预览、推送/交付账本。
 * 零链上写入:上架/提审由人拿 listing.service_arg 去跑 `onchainos agent update`;预览不 deliver。
 *   GET  /api/asp-services                         → { listings, config, pushes, results, running }
 *   PUT  /api/asp-services/config                  { service_ids?, prices? } → config(serviceId 变更后重新注册 handler)
 *   POST /api/asp-services/preview/:listing        { description?, service_params?, allow_paid? } → Deliverable
 *   POST /api/asp-services/channels/:channel/preview → ChannelPush(欢迎包口径)
 * 付费模型类服务(Jev)预览要显式 allow_paid:true,每次按 JUDGE_MAX_CALL_USD 计费。
 */
import type { RouteModule } from './http-extra.js';
import { aspServices } from './asp-agent/services/index.js';

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
  ctx.route('POST', '/api/asp-services/channels/:channel/preview', async (_req, res, _url, p) => {
    try { ctx.json(res, 200, await hub().previewChannel(p['channel'] ?? '')); } catch (e) { fail(res, e); }
  });
};
