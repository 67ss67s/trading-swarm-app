import { Readable } from 'node:stream';
import type http from 'node:http';
import { describe, expect, it } from 'vitest';
import { validate } from '@trading-swarm/contracts';
import { openStateDb } from '../../../../src/state-db.js';
import type { RouteContext, RouteHandler } from '../../../../src/demo/http-extra.js';
import { registerImproveRoutes } from '../../../../src/demo/research/improve/routes.js';
import { StrategyStore } from '../../../../src/demo/research/strategies/store.js';
import { StrategyService } from '../../../../src/demo/research/strategies/service.js';
import { ResearchStore } from '../../../../src/demo/research/store.js';
import type { ResearchService } from '../../../../src/demo/research/service.js';
import { emaIR, loaderOf, universeBars, H4, START, SYMS } from './fixtures.js';

/** 最小路由桩:只实现 registerImproveRoutes 用到的 route/json/fail/emit/store.marketDb。 */
function harness() {
  const state = openStateDb(':memory:'), routes: { m: string; re: RegExp; keys: string[]; h: RouteHandler }[] = [], emitted: { event: string; data: unknown }[] = [];
  const ctx = {
    route: (m: string, path: string, h: RouteHandler) => { const keys: string[] = []; const re = new RegExp('^' + path.replace(/:(\w+)/g, (_s, k: string) => { keys.push(k); return '([^/]+)'; }) + '$'); routes.push({ m, re, keys, h }); },
    json: (res: { status: number; body: unknown }, status: number, body: unknown) => { res.status = status; res.body = JSON.parse(JSON.stringify(body)); },
    fail: (res: { status: number; body: unknown }, status: number, message: string) => { res.status = status; res.body = { error: message }; },
    emit: (event: string, data: unknown) => emitted.push({ event, data }),
    store: { marketDb: state.db },
  } as unknown as RouteContext;
  const body = async (req: http.IncomingMessage) => { const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c as Buffer)); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; };
  const manager = registerImproveRoutes(ctx, body, { inline: true, runner: { loader: loaderOf(universeBars(2100)) } });
  const call = async (m: string, path: string, b?: unknown) => {
    const url = new URL(path, 'http://x'), r = routes.find((x) => x.m === m && x.re.test(url.pathname))!;
    const p = Object.fromEntries(r.keys.map((k, i) => [k, url.pathname.match(r.re)![i + 1]!]));
    const res = { status: 0, body: null as unknown };
    await r.h(Readable.from(b === undefined ? [] : [Buffer.from(JSON.stringify(b))]) as unknown as http.IncomingMessage, res as unknown as http.ServerResponse, url, p);
    return res as { status: number; body: Record<string, unknown> };
  };
  return { state, manager, call, emitted };
}
const req = (o: Record<string, unknown> = {}) => ({ strategy_ir: emaIR(3, 8), timeframe: '4h', universe: SYMS, from_ms: START + 300 * H4, to_ms: START + 2100 * H4, objective: { min_trades_per_fold: 0, min_trades_total: 0, max_drawdown: 1, require_stress_positive: false, require_beats_exposure_matched_hold: false, plateau_ratio: 0 }, budget: { generations: 2, candidates_per_generation: 3, promote_per_generation: 1 }, random_entry_runs: 2, ...o });

describe('改进环 HTTP(进程内桩,零模型)', () => {
  it('POST 202 → 进度广播 research.improve → GET 详情(谱系/排行榜/账本/留出段)过契约 → 列表按 strategy_id 过滤', async () => {
    const { state, manager, call, emitted } = harness();
    const svc = new StrategyService(new StrategyStore(state.db), new ResearchStore(state.db), null as unknown as ResearchService);
    const s = svc.create({ name: '3/8', strategy_ir: emaIR(3, 8), timeframe: '4h' });
    const r = await call('POST', '/api/research/improve', { ...req(), strategy_ir: undefined, strategy_id: s.id });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(validate('research-improve', r.body)).toEqual({ ok: true });
    const id = r.body.job_id as string;
    expect((await call('POST', '/api/research/improve', req())).status).toBe(409);// 同时只跑一个
    await manager.wait(id);
    const d = await call('GET', `/api/research/improve/${id}`);
    expect(d.status).toBe(200);
    expect(validate('research-improve', d.body)).toEqual({ ok: true });
    expect(d.body).toMatchObject({ job: { status: 'completed', strategy_id: s.id, strategy_version: 1 }, spec: { budget: { generations: 2, model_calls: 0 } } });
    expect((d.body.lineage as unknown[]).length).toBeGreaterThan(3);
    expect((d.body.leaderboard as unknown[]).length).toBeGreaterThan(0);
    expect((d.body.result as { holdout: unknown }).holdout).toBeTruthy();
    expect(emitted.every((e) => e.event === 'research.improve')).toBe(true);
    expect(emitted.at(-1)!.data).toMatchObject({ job_id: id, status: 'completed' });
    const list = await call('GET', `/api/research/improve?strategy_id=${s.id}`);
    expect(validate('research-improve', list.body)).toEqual({ ok: true });
    expect((list.body.jobs as { id: string }[]).map((j) => j.id)).toEqual([id]);
    expect(((await call('GET', '/api/research/improve?strategy_id=nope')).body.jobs as unknown[])).toEqual([]);
    expect((await call('GET', '/api/research/improve/imp_missing')).status).toBe(404);
    state.close();
  }, 180000);
  it('请求校验:未知字段 / 窗口太短 / 模型预算非 0 / 生成器名不对 → 400;取消 → cancelled', async () => {
    const { state, manager, call } = harness();
    expect((await call('POST', '/api/research/improve', { ...req(), foo: 1 })).body).toMatchObject({ error: 'unknown_fields:foo' });
    expect((await call('POST', '/api/research/improve', req({ from_ms: START + 2000 * H4 }))).status).toBe(400);
    expect((await call('POST', '/api/research/improve', req({ budget: { model_calls: 5 } }))).body).toMatchObject({ error: 'budget.model_calls_invalid' });
    expect((await call('POST', '/api/research/improve', req({ generators: ['magic'] }))).body).toMatchObject({ error: 'generators_invalid' });
    expect((await call('POST', '/api/research/improve', { timeframe: '4h' })).body).toMatchObject({ error: 'strategy_id_or_strategy_ir_required' });
    const r = await call('POST', '/api/research/improve', req());
    const c = await call('POST', `/api/research/improve/${r.body.job_id}/cancel`);
    expect(c.status).toBe(200);
    const done = await manager.wait(r.body.job_id as string);
    expect(done.status).toBe('cancelled');
    state.close();
  }, 60000);
});
