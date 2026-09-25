/**
 * CandidateV0 影子候选的 HTTP 路由(契约 docs/demo/v3-ui-contract.md §9.50;实现 strategy-candidate.ts)。
 * 两条只读路由,零模型:一条分页列表(新的在前),一条汇总(覆盖率 / 几何 / 计划腿 vs 吊灯腿 / 候选 × 模型配对)。
 * 注册:http-extra.ts 的 extraRouteModules 加一行 `candidateRoutes`(由主线程落,见 docs/research/candidate-v0-2026-09-23.md)。
 */
import type { RouteContext, RouteModule } from './http-extra.js';
import { listCandidates, summarizeCandidates } from './strategy-candidate.js';

function sinceOf(url: URL): number | null {
  const n = Number(url.searchParams.get('since') ?? '');
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const candidateRoutes: RouteModule = (ctx: RouteContext) => {
  const { route, guarded, json, store } = ctx;

  /** `?limit=`(1–500,默认 100)`&cursor=`(上一页的 next_cursor)`&symbol=&strategy_id=`。 */
  route('GET', '/api/candidates', guarded(async (_req, res, url) => {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? '100') || 100));
    const page = listCandidates(store.marketDb, {
      limit,
      cursor: url.searchParams.get('cursor'),
      symbol: url.searchParams.get('symbol'),
      strategy_id: url.searchParams.get('strategy_id'),
    });
    json(res, 200, { rows: page.rows, next_cursor: page.next_cursor, limit });
  }));

  /** `?since=`(毫秒,按 as_of 过滤)。 */
  route('GET', '/api/candidates/summary', guarded(async (_req, res, url) => {
    json(res, 200, summarizeCandidates(store.marketDb, { since: sinceOf(url) }));
  }));
};
