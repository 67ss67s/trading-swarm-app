/**
 * OKX 资产全集路由(universe-okx.ts;docs/design/watch-screener-review-2026-09-24.md 二-1)。
 * 注册在 routes-research.ts 的 researchRoutes 里(http-extra.ts 有别的会话未提交改动,不动它)。
 *
 *   GET  /api/universe?market=spot|perp|all&q=&limit=&sort=volume|change|funding&order=desc|asc&include_excluded=0|1
 *        → { updated_at, total, items[], refreshing, scanning, last_refresh }   只读缓存,不打 OKX
 *   POST /api/universe/refresh  body 可带 { scan?: boolean }(默认 true:刷新成功后后台跑每日扫描)
 *        → { ok, updated_at, total, eligible, requests, duration_ms, error, notes, scan: 'started'|'skipped' }
 *   GET  /api/universe/scan?limit=  → { screen, candidates, running, progress }   最近一次每日全市场扫描
 *
 * 零模型;唯一的写操作是刷新公共行情缓存 + 存一次扫描,不碰 workflow / 风险 / 执行。
 */
import type { RouteContext } from './http-extra.js';
import { marketExchange } from './market.js';
import { OkxUniverseService, currentUniverse, queryUniverse, type UniverseSort } from './universe-okx.js';

/** 自动定时:vitest 里默认关(测试进程不许碰真实公共 REST);`TG_UNIVERSE_AUTO=0` 关;币安模式关。 */
export function universeAutoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['TG_UNIVERSE_AUTO'] === '1') return true;
  if (env['TG_UNIVERSE_AUTO'] === '0') return false;
  if (env['VITEST']) return false;
  return marketExchange() === 'okx';
}

export function registerUniverseRoutes(ctx: RouteContext): OkxUniverseService {
  const { route, guarded, json, fail, readBody } = ctx;
  const svc = new OkxUniverseService(ctx.store.marketDb, {
    library: () => ctx.store.strategies,
    log: (level, message) => ctx.rt.log(level, 'universe', message),
    emit: (event, data) => ctx.emit(event, data),
  });
  if (universeAutoEnabled()) svc.start();

  route('GET', '/api/universe', guarded(async (_req, res, url) => {
    const market = url.searchParams.get('market') ?? 'all';
    if (market !== 'spot' && market !== 'perp' && market !== 'all') return fail(res, 400, 'market 只能是 spot / perp / all', 'bad_market');
    const sort = url.searchParams.get('sort') ?? 'volume';
    if (sort !== 'volume' && sort !== 'change' && sort !== 'funding') return fail(res, 400, 'sort 只能是 volume / change / funding', 'bad_sort');
    const order = url.searchParams.get('order') ?? 'desc';
    if (order !== 'asc' && order !== 'desc') return fail(res, 400, 'order 只能是 asc / desc', 'bad_order');
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw === null ? 100 : Number(limitRaw);
    if (!Number.isFinite(limit) || limit < 1) return fail(res, 400, 'limit 需为 ≥1 的数(上限 5000,够返回全量)', 'bad_limit');
    const snap = currentUniverse();
    const r = queryUniverse(snap?.items ?? [], {
      market,
      q: url.searchParams.get('q') ?? '',
      limit,
      sort: sort as UniverseSort,
      order,
      include_excluded: url.searchParams.get('include_excluded') === '1',
    });
    const watched = new Set(ctx.rt.workflow.watchlist ?? []);
    json(res, 200, {
      updated_at: snap?.updated_at ?? null,
      total: r.total,
      items: r.items.map((a) => ({ ...a, watched: watched.has(a.symbol) })),
      refreshing: svc.isRefreshing,
      scanning: svc.isScanning,
      last_refresh: svc.store.lastRefresh(),
    });
  }));

  route('POST', '/api/universe/refresh', guarded(async (req, res) => {
    if (svc.isRefreshing) return fail(res, 409, 'OKX 资产全集正在刷新', 'already_running');
    const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
    const r = await svc.refresh('manual');
    if (!r.ok) return json(res, 502, { ...r, scan: 'skipped' });
    const wantScan = body['scan'] !== false && !svc.isScanning;
    // 不 await:扫 150 个币的 K 线要一两分钟;进度看 GET /api/universe/scan,完成时发 screener.changed。
    if (wantScan) void svc.scan('manual').catch(() => {});
    json(res, 200, { ...r, scan: wantScan ? 'started' : 'skipped' });
  }));

  route('GET', '/api/universe/scan', guarded(async (_req, res, url) => {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 200) || 200));
    const screen = svc.latestScan();
    json(res, 200, {
      screen,
      candidates: screen ? ctx.store.screens.candidates(screen.id, limit) : [],
      running: svc.isScanning,
      progress: svc.progress,
    });
  }));

  return svc;
}
