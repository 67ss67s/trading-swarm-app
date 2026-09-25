// 路由面:按 RouteContext 形状挂到假服务器上直接调 handler(不起进程、零网络)。
import { describe, expect, it } from 'vitest';
import { openStateDb } from '../../../../src/state-db.js';
import { matrixStudyRoutes, matrixStudyService } from '../../../../src/demo/routes-matrix-study.js';
import { RecommendationStore, type AssetRecommendation } from '../../../../src/demo/recommend.js';
import type { RouteContext, RouteHandler } from '../../../../src/demo/http-extra.js';
import { TO_MS, loader, protocol } from './fixtures.js';

function harness() {
  const db = openStateDb(':memory:').db, routes: { method: string; re: RegExp; keys: string[]; h: RouteHandler }[] = [], emitted: unknown[] = [];
  const ctx = {
    route: (method: string, path: string, h: RouteHandler) => { const keys: string[] = []; const re = new RegExp('^' + path.replace(/:([a-z_]+)/g, (_m, k) => { keys.push(k); return '([^/]+)'; }) + '$'); routes.push({ method, re, keys, h }); },
    guarded: (f: RouteHandler) => f, readBody: async (req: { body?: Record<string, unknown> }) => req.body ?? {},
    json: (res: { status?: number; body?: unknown }, status: number, body: unknown) => { res.status = status; res.body = body; },
    fail: (res: { status?: number; body?: unknown }, status: number, message: string) => { res.status = status; res.body = { error: message }; },
    emit: (_e: string, d: unknown) => emitted.push(d), rt: {}, store: { marketDb: db }, oauth: null,
  } as unknown as RouteContext;
  matrixStudyRoutes(ctx);
  const call = async (method: string, path: string, body?: Record<string, unknown>) => {
    const url = new URL('http://x' + path);
    for (const r of routes) { if (r.method !== method) continue; const m = r.re.exec(url.pathname); if (!m) continue; const p: Record<string, string> = {}; r.keys.forEach((k, i) => (p[k] = m[i + 1]!)); const res: { status?: number; body?: any } = {}; await r.h({ body } as never, res as never, url, p); return res; }
    return { status: 404, body: { error: 'no_route' } };
  };
  return { db, call, emitted };
}

describe('matrix study 路由', () => {
  it('推荐预填 → 估算 → 创建 → 列表 / 详情 / 事件;错误码映射', async () => {
    const { db, call, emitted } = harness();
    const fit = (eligible: boolean, reason: string | null = null) => ({ eligible, reason, direction: eligible ? 'long' : null, families: eligible ? ['ema_cross'] : [], evidence: [] });
    const rec = { id: 'rec_r', as_of: TO_MS, source: { universe_scan_at: TO_MS - 1000, regime_at: TO_MS }, warnings: [], rows: [{ symbol: 'BTCUSDT', market: 'spot', quote_vol_24h: 1e9, depth_usd_05: null, regime: 'bull', scan: null, horizons: { short: fit(false, 'liquidity'), mid: fit(true), long: fit(false, 'not_requested') } }] } as unknown as AssetRecommendation;
    new RecommendationStore(db).put(rec);
    const pre = await call('GET', '/api/research/matrix-studies/prefill?recommendation_id=rec_r');
    expect(pre.status).toBe(200);
    expect(pre.body.spec).toMatchObject({ symbols: ['BTCUSDT'], timeframes: ['4h'], families: ['ema_cross'], sides: ['long'], market: 'spot', recommendation_id: 'rec_r' });
    expect((await call('GET', '/api/research/matrix-studies/prefill?recommendation_id=nope')).status).toBe(404);
    const body = { recommendation_id: 'rec_r', spec: { window_days: { '4h': 400 }, to_ms: TO_MS, arms: ['code'], protocol, iterate: { top_k: 1, generations: 0, candidates_per_generation: 1, patience: 1 } } };
    const est = await call('POST', '/api/research/matrix-studies/estimate', body);
    expect(est.status).toBe(200);
    expect(est.body.estimate.matrix_trials).toBe(4);
    expect((await call('POST', '/api/research/matrix-studies/estimate', { spec: { symbols: ['BTC'], bogus: 1 } })).status).toBe(400);
    // 创建:服务用合成 loader(路由默认 loader 会联网,测试里换掉)
    (matrixStudyService() as unknown as { deps: { loader: unknown } }).deps.loader = loader();
    const created = await call('POST', '/api/research/matrix-studies', { ...body, idempotency_key: 'r1' });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(created.body.cells.length).toBe(1);
    await matrixStudyService()!.idle();
    const got = await call('GET', `/api/research/matrix-studies/${id}`);
    expect(got.body.status).toBe('completed');
    expect(got.body.finalists.every((f: { source: { recommendation_id: string; radar_tier: string; universe_scan_at: number } }) => f.source.recommendation_id === 'rec_r' && f.source.radar_tier === 'swing' && f.source.universe_scan_at === TO_MS - 1000)).toBe(true);
    expect((await call('GET', '/api/research/matrix-studies?limit=5')).body.items[0].id).toBe(id);
    const ev = await call('GET', `/api/research/matrix-studies/${id}/events?after_seq=0`);
    expect(ev.body.items.length).toBeGreaterThan(0);
    expect(emitted.length).toBe(ev.body.items.length);
    expect((await call('GET', '/api/research/matrix-studies/ms_nope')).status).toBe(404);
    expect((await call('POST', `/api/research/matrix-studies/${id}/cancel`)).status).toBe(409);
    expect((await call('POST', `/api/research/matrix-studies/${id}/finalize`, { expected_manifest_hash: 'x' })).status).toBe(409);
    expect((await call('POST', `/api/research/matrix-studies/${id}/adopt`, {})).status).toBe(400);
  }, 120_000);
});
