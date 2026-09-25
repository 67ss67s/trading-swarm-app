/**
 * 进化页只读接口(docs/design/evolution-floor-2026-09-23.md §四,零模型、只读):
 *   GET /api/evolution/daily?from=YYYY-MM-DD&to=YYYY-MM-DD   缺省最近 90 天(UTC 日)
 *   GET /api/evolution/day?role=thread_manager&date=YYYY-MM-DD
 * 注册在 routes-research.ts 的 researchRoutes 里(http-extra.ts 有别的会话未提交改动,不动它)。
 * 错误:invalid_* / range_too_long → 400。
 */
import type { RouteContext, RouteHandler } from './http-extra.js';
import { evolutionDaily, evolutionDay } from './evolution.js';

export function registerEvolutionRoutes(ctx: RouteContext): void {
  const wrap = (handler: RouteHandler): RouteHandler => async (req, res, url, p) => {
    try { await handler(req, res, url, p); } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.fail(res, /^(invalid_|range_too_long)/.test(message) ? 400 : 500, message, 'evolution_error');
    }
  };
  ctx.route('GET', '/api/evolution/daily', wrap(async (_req, res, url) => {
    const w = ctx.rt.workflow as { daily_judgment_cap?: number; active_strategies?: string[] } | undefined;
    ctx.json(res, 200, evolutionDaily(ctx.store.marketDb, {
      from: url.searchParams.get('from'), to: url.searchParams.get('to'),
      workflow: w ? { daily_judgment_cap: w.daily_judgment_cap ?? null, active_strategies: w.active_strategies ?? [] } : null,
    }));
  }));
  ctx.route('GET', '/api/evolution/day', wrap(async (_req, res, url) => {
    ctx.json(res, 200, evolutionDay(ctx.store.marketDb, { role: url.searchParams.get('role') ?? '', date: url.searchParams.get('date') }));
  }));
}
