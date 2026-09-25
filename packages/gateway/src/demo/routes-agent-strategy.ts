/** §9.54 Agent 当前策略:GET 看、PUT 切换(自由判断 / 某条研究策略)。 */
import type { RouteModule } from './http-extra.js';

export const agentStrategyRoutes: RouteModule = ctx => {
  ctx.route('GET', '/api/agent/strategy', ctx.guarded(async (_req, res) => ctx.json(res, 200, ctx.rt.agentStrategy().view())));
  ctx.route('PUT', '/api/agent/strategy', async (req, res) => {
    try {
      const v = await ctx.rt.agentStrategy().put(await ctx.readBody(req));
      ctx.emit('agent.strategy', v);
      ctx.json(res, 200, v);
    } catch (e) {
      const err = e as Error & { status?: number };
      ctx.json(res, err.status ?? 400, { error: err.message, code: 'agent_strategy_error' });
    }
  });
};
