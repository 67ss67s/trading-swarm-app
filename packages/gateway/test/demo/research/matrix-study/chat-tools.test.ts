// 批量验证 v2:真 HTTP 面(adopt-candidate / trials/:trial_id)+ 对话工具 get_matrix_study.paper_candidates / adopt_matrix_candidate。
// 服务换成合成 loader + 合成优势执行器,零网络、零模型。
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { openStateDb, type StateDb } from '../../../../src/state-db.js';
import { DemoStore } from '../../../../src/demo/store.js';
import { PaperBackend } from '../../../../src/demo/execution.js';
import { stubBrain } from '../../../../src/demo/brain.js';
import { startFakeMarketServer, type FakeMarketServer } from '../../helpers/fake-market-server.js';
import { matrixStudyService } from '../../../../src/demo/routes-matrix-study.js';
import { StrategyStore } from '../../../../src/demo/research/strategies/store.js';
import { baseSpec, edgeExecutor, loader } from './fixtures.js';

let fakeMarket: FakeMarketServer, server: http.Server, state: StateDb, base = '';
let rt: InstanceType<typeof import('../../../../src/demo/runtime.js').DemoRuntime>;
beforeAll(async () => {
  fakeMarket = await startFakeMarketServer();
  process.env['TG_DEMO_MARKET_BASE'] = fakeMarket.url;
  const { DemoRuntime } = await import('../../../../src/demo/runtime.js');
  const { createServer } = await import('../../../../src/demo/http.js');
  state = openStateDb(':memory:');
  const store = new DemoStore(state);
  rt = new DemoRuntime({ store, backend: new PaperBackend(10_000), brains: { stub: stubBrain() }, marketPollMs: 600_000, accountPollMs: 600_000 });
  await rt.start();
  server = createServer(rt, store);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  await rt?.stop();
  await new Promise<void>((r) => server.close(() => r()));
  state?.close();
  await fakeMarket.close();
  delete process.env['TG_DEMO_MARKET_BASE'];
});
const req = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5180' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};

it('HTTP adopt-candidate 的参数 / 权限 / 标记;trials/:trial_id 只带训练 / 选择段;对话工具列出候补并能存', async () => {
  const svc = matrixStudyService()!;
  const deps = svc.deps as unknown as { loader: unknown; executorFor: unknown };
  deps.loader = loader(); deps.executorFor = edgeExecutor();
  const row = svc.create({ spec: baseSpec({ families: ['breakout'], protocol: { block_days: 2, bootstrap_replicates: 299, min_trades: 100000 }, iterate: { top_k: 1, generations: 0, candidates_per_generation: 1, patience: 1 }, origin: { chat_session_id: 'cs-1' } }), idempotency_key: 'chat-cand' });
  await svc.idle();
  const view = (await req('GET', `/api/research/matrix-studies/${row.id}`)).json;
  const cand = view.cells.find((c: any) => c.result?.tier === 'paper_candidate');
  expect(cand).toBeTruthy();
  const tid = cand.result.tier_trial_id as string;

  // 明细:带 IR 与评分卡,不含留出
  const d = await req('GET', `/api/research/matrix-studies/${row.id}/trials/${tid}`);
  expect(d.status).toBe(200);
  expect(d.json).toMatchObject({ trial_id: tid, tier: 'paper_candidate', cell: { symbol: cand.symbol, timeframe: '4h', family: 'breakout' } });
  expect(d.json.ir).toBeTruthy();
  expect(JSON.stringify(d.json)).not.toMatch(/holdout/);
  expect((await req('GET', `/api/research/matrix-studies/${row.id}/trials/mt_nope`)).status).toBe(404);

  // 参数校验 / 不存在
  expect((await req('POST', `/api/research/matrix-studies/${row.id}/adopt-candidate`, {})).status).toBe(400);
  expect((await req('POST', `/api/research/matrix-studies/${row.id}/adopt-candidate`, { trial_id: tid, name: 3 })).status).toBe(400);
  expect((await req('POST', `/api/research/matrix-studies/${row.id}/adopt-candidate`, { trial_id: 'mt_nope' })).status).toBe(404);
  // 对话工具:get_matrix_study 列候补 + 提示;adopt_matrix_candidate 存成策略
  const tools = rt.chatTools('cs-1') as unknown as Record<string, (a: unknown) => Promise<any>>;
  const g = await tools['get_matrix_study']!({ id: row.id });
  expect(g.paper_candidates.length).toBeGreaterThan(0);
  expect(g.paper_candidates.map((x: any) => x.trial_id)).toContain(tid);
  expect(g.paper_candidate_note).toContain('adopt_matrix_candidate');
  expect(await tools['adopt_matrix_candidate']!({ study_id: row.id })).toMatchObject({ error: expect.any(String) });
  const a = await tools['adopt_matrix_candidate']!({ study_id: row.id, trial_id: tid });
  expect(a).toMatchObject({ kind: 'paper_candidate', final_validation: false, trial_id: tid });
  expect(a.link).toContain('#my-strategies?id=');
  expect(new StrategyStore(state.db).require(a.strategy_id).description).toMatch(/^\[批量验证候补 .* · 未经最终验收 · /);
  // HTTP 同一试验幂等返回同一策略
  const h = await req('POST', `/api/research/matrix-studies/${row.id}/adopt-candidate`, { trial_id: tid });
  expect(h.status).toBe(200);
  expect(h.json.strategy_id).toBe(a.strategy_id);
  // finalist 的 adopt 路径不变:没有 finalist 时 adopt 404
  expect((await req('POST', `/api/research/matrix-studies/${row.id}/adopt`, { finalist_id: tid })).status).toBe(404);
}, 240_000);
