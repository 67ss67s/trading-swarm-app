/** §9.53 A:推荐资产。POST 现算一份并落库(代码计算、零模型;给外部 agent / skills/strategy-loop 用),GET 按 id 取(推荐卡用)。 */
import type { RouteModule } from './http-extra.js';
import { HORIZONS, RecommendationStore, type Horizon, type RecommendArgs } from './recommend.js';

function argsOf(b: Record<string, unknown>): RecommendArgs {
  const out: RecommendArgs = {};
  if (b['symbols'] !== undefined) {
    if (!Array.isArray(b['symbols']) || b['symbols'].some((s) => typeof s !== 'string')) throw new Error('symbols 必须是字符串数组');
    out.symbols = (b['symbols'] as string[]).slice(0, 12);
  }
  if (b['horizons'] !== undefined) {
    if (!Array.isArray(b['horizons']) || b['horizons'].some((h) => !HORIZONS.includes(h as Horizon))) throw new Error('horizons 只能是 short / mid / long');
    out.horizons = b['horizons'] as Horizon[];
  }
  if (b['market'] !== undefined) {
    if (b['market'] !== 'spot' && b['market'] !== 'perp') throw new Error('market 只能是 spot / perp');
    out.market = b['market'];
  }
  if (b['top_n'] !== undefined) {
    if (typeof b['top_n'] !== 'number' || !Number.isFinite(b['top_n'])) throw new Error('top_n 必须是数字');
    out.top_n = b['top_n'];
  }
  return out;
}

export const recommendationRoutes: RouteModule = ctx => {
  ctx.route('POST', '/api/recommendations', async (req, res) => {
    try { ctx.json(res, 200, await ctx.rt.recommend(argsOf(await ctx.readBody(req)))); }
    catch (e) { ctx.fail(res, 400, (e as Error).message, 'recommendation_invalid'); }
  });
  ctx.route('GET', '/api/recommendations/:id', ctx.guarded(async (_req, res, _url, p) => {
    const r = new RecommendationStore(ctx.store.marketDb).get(p['id'] ?? '');
    if (!r) return ctx.fail(res, 404, '推荐结果不存在', 'recommendation_not_found');
    ctx.json(res, 200, r);
  }));
};
