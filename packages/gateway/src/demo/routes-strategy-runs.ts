/** §9.51。路径参数只用小写 id,与 http.ts 的路由编译规则一致。 */
import type { RouteModule, RouteHandler } from './http-extra.js';
export const strategyRunRoutes: RouteModule = ctx => {
  const runner = () => ctx.rt.strategyRuns();
  const wrap = (fn: RouteHandler): RouteHandler => async (req, res, url, p) => {
    try { await fn(req, res, url, p); }
    catch (e) {
      const err = e as Error & { status?: number; code?: string };
      ctx.json(res, err.status ?? (err.message.includes('not_found') ? 404 : 400), { error: err.message, code: err.code ?? 'strategy_run_error' });
    }
  };
  const base = '/api/strategy-runs';
  ctx.route('GET', base, wrap(async (_req, res) => ctx.json(res, 200, { runs: runner().list() })));
  ctx.route('GET', `${base}/preflight`, wrap(async (_req, res, url) => {
    const v = url.searchParams.get('version');
    if (v !== null && (!/^\d+$/.test(v) || Number(v) < 1)) throw new Error('invalid_version');
    await ctx.rt.refreshAspIdentity();
    ctx.json(res, 200, runner().preflight(url.searchParams.get('strategy_id') ?? '', v === null ? undefined : Number(v)));
  }));
  ctx.route('POST', base, wrap(async (req, res) => { await ctx.rt.refreshAspIdentity(); ctx.json(res, 200, await runner().create(await ctx.readBody(req))); }));
  ctx.route('PATCH', `${base}/:id`, wrap(async (req, res, _url, p) => ctx.json(res, 200, await runner().patch(p['id']!, await ctx.readBody(req)))));
  ctx.route('POST', `${base}/:id/scan`, wrap(async (_req, res, _url, p) => { await ctx.rt.refreshAspIdentity(); ctx.json(res, 200, await runner().scan(p['id']!)); }));
  ctx.route('GET', `${base}/:id/events`, wrap(async (_req, res, url, p) => ctx.json(res, 200, runner().store.events(p['id']!, Number(url.searchParams.get('limit') ?? 50), url.searchParams.get('cursor')))));
};
