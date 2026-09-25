/**
 * Radar 筛选器的路由(screener.ts + radar.ts)。在 http-extra.ts 里一行注册。
 *
 * 写操作只有两个:`run`(跑一次筛选,只读行情 + 至多一次便宜模型调用)和 `apply`(把提案落到
 * workflow.watchlist —— 只有这一个字段)。风险/杠杆/执行后端/策略启用没有任何一条路由能碰。
 */
import type { RouteContext, RouteModule } from './http-extra.js';
import { HORIZON_LABEL, SCREEN_HORIZONS, type ScreenHorizon } from './screener.js';
import { DAILY_SCAN_HORIZON } from './universe-okx.js';

function isHorizon(v: unknown): v is ScreenHorizon {
  return typeof v === 'string' && (SCREEN_HORIZONS as string[]).includes(v);
}
/** 只读路由额外认 `daily` = OKX 每日全市场扫描(universe-okx.ts,universe='okx_all');run 仍只认 radar 的三个周期。 */
function isReadHorizon(v: unknown): v is ScreenHorizon {
  return isHorizon(v) || v === DAILY_SCAN_HORIZON;
}
const READ_HORIZONS = [...SCREEN_HORIZONS, DAILY_SCAN_HORIZON].join('/');

export const screenerRoutes: RouteModule = (ctx: RouteContext) => {
  const { route, guarded, json, fail, readBody, rt, store } = ctx;
  const radar = rt.radar;
  const horizons = SCREEN_HORIZONS.map((id) => ({ id, label: HORIZON_LABEL[id] }));

  route('GET', '/api/screener/latest', guarded(async (_req, res, url) => {
    const h = url.searchParams.get('horizon') ?? 'short';
    if (!isReadHorizon(h)) return fail(res, 400, `horizon 只能是 ${READ_HORIZONS}`, 'bad_horizon');
    const screen = store.screens.latest(h);
    json(res, 200, {
      horizon: h,
      screen,
      candidates: screen ? store.screens.candidates(screen.id) : [],
      schedule: radar.schedule(),
      watchlist: rt.workflow.watchlist,
      watchlist_max: rt.workflow.watchlist_max,
      horizons,
    });
  }));

  route('GET', '/api/screener/history', guarded(async (_req, res, url) => {
    const h = url.searchParams.get('horizon');
    if (h && !isReadHorizon(h)) return fail(res, 400, `horizon 只能是 ${READ_HORIZONS}`, 'bad_horizon');
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20));
    json(res, 200, { screens: store.screens.screens({ ...(h ? { horizon: h as ScreenHorizon } : {}), limit }) });
  }));

  route('POST', '/api/screener/run', guarded(async (req, res) => {
    const body = await readBody(req);
    const h = body['horizon'] ?? 'short';
    if (!isHorizon(h)) return fail(res, 400, `horizon 只能是 ${SCREEN_HORIZONS.join('/')}`, 'bad_horizon');
    if (radar.isRunning(h)) return fail(res, 409, `${HORIZON_LABEL[h]} 筛选正在进行`, 'already_running');
    // 不 await:筛 60 个币要几十秒,进度走 SSE screener.changed。暂停时允许手动跑,但不调模型(radar.ts)。
    void radar.run(h, 'manual').catch(() => {});
    json(res, 202, { horizon: h, paused_note: rt.workflow.paused ? '已暂停:这次筛选不调模型,只用确定性排名' : null });
  }));

  route('GET', '/api/screener/:id', guarded(async (_req, res, _url, p) => {
    const screen = store.screens.screen(p['id']!);
    if (!screen) return fail(res, 404, `没有筛选 ${p['id']}`, 'not_found');
    json(res, 200, { screen, candidates: store.screens.candidates(screen.id) });
  }));

  // body 可带 { watchlist: string[] } = 用户勾选后的最终名单;不带就整包应用提案。
  route('POST', '/api/screener/:id/apply', guarded(async (req, res, _url, p) => {
    const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
    const raw = body['watchlist'];
    const pick = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : null;
    try {
      const r = radar.apply(p['id']!, 'user', pick);
      json(res, 200, r);
    } catch (e) {
      fail(res, 409, (e as Error).message, 'apply_rejected');
    }
  }));
};
