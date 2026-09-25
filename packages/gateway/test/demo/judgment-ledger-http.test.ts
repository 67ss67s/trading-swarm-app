// 判断账本的 HTTP 路由(routes-judgment.ts,经 http-extra.ts 注册;契约 §9.29)。
// 走真实的 createServer;不调任何模型,不碰真实行情。
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import type { Brain } from '../../src/demo/brain.js';
import { JUDGMENT_LEDGER_VERSION, type JudgmentLedgerRow } from '../../src/demo/judgment-ledger.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';

let fakeMarket: FakeMarketServer;
let cacheDir = '';
let DemoRuntime: typeof import('../../src/demo/runtime.js').DemoRuntime;
let createServer: typeof import('../../src/demo/http.js').createServer;

beforeAll(async () => {
  fakeMarket = await startFakeMarketServer();
  cacheDir = mkdtempSync(join(tmpdir(), 'tg-ledger-http-'));
  process.env['TG_DEMO_MARKET_BASE'] = fakeMarket.url;
  process.env['TG_DEMO_KLINE_CACHE_DIR'] = cacheDir;
  ({ DemoRuntime } = await import('../../src/demo/runtime.js'));
  ({ createServer } = await import('../../src/demo/http.js'));
});

afterAll(async () => {
  await fakeMarket.close();
  rmSync(cacheDir, { recursive: true, force: true });
  delete process.env['TG_DEMO_MARKET_BASE'];
  delete process.env['TG_DEMO_KLINE_CACHE_DIR'];
});

let activeHttp: http.Server | null = null;
let activeRt: InstanceType<typeof DemoRuntime> | null = null;
let activeState: StateDb | null = null;
let baseUrl = '';
let store: DemoStore;

const stub: Brain = { name: 'stub', async complete() { return { text: '{}', latency_ms: 1, model: 'stub', input_tokens: 1, output_tokens: 1 }; } };

const NOW = 1_788_700_000_000;

function row(over: Partial<JudgmentLedgerRow>): JudgmentLedgerRow {
  const episode_id = over.episode_id ?? `ep-${Math.random().toString(36).slice(2, 9)}`;
  return {
    version: 'jl-v1', episode_id, cluster_id: over.cluster_id ?? episode_id, at: NOW, as_of: NOW, symbol: 'BTCUSDT',
    timeframe: '15m', mode: 'scan', thread_id: null, strategy_id: 'breakout_retest', model_action: 'PROPOSE',
    model_dir: 'long', model_stance: 'direction', council_dir: 'long', council_stance: 'direction', council_agree: true,
    mechanical_dir: 'long', mechanical_note: null,
    horizon_end_at: NOW + 43_200_000, outcome_r_model: 1, outcome_r_council: 0.5, outcome_r_mechanical: 0,
    outcome_source_model: 'counterfactual', regret_review: null, settled_at: NOW + 1, settle_note: null,
    settlement_status: null, realized: null,
    snapshot: null, review: null, legs: { model: null, council: null, mechanical: null }, regret: null,
    ...over,
  };
}

async function setup(): Promise<void> {
  const state = openStateDb(':memory:');
  store = new DemoStore(state);
  const rt = new DemoRuntime({ store, backend: new PaperBackend(10_000), brains: { stub }, marketPollMs: 600_000, accountPollMs: 600_000 });
  await rt.start();
  rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'], timeframe: '15m' });
  const server = createServer(rt, store);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  activeHttp = server;
  activeRt = rt;
  activeState = state;
}

afterEach(async () => {
  if (activeHttp) {
    activeHttp.closeAllConnections?.();
    await new Promise<void>((r) => activeHttp!.close(() => r()));
  }
  if (activeRt) await activeRt.stop();
  activeState?.close();
  activeHttp = null;
  activeRt = null;
  activeState = null;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

it('GET /api/judgment-ledger 分页 + since / strategy_id 过滤', async () => {
  await setup();
  const empty = await api('/api/judgment-ledger');
  expect(empty.status).toBe(200);
  expect(empty.json).toMatchObject({ rows: [], total: 0, limit: 100, offset: 0 });

  for (let i = 0; i < 3; i++) store.judgments.save(row({ at: NOW + i }));
  store.judgments.save(row({ strategy_id: 'mtf_alignment', at: NOW - 10 * 86_400_000 }));

  const all = await api('/api/judgment-ledger');
  expect(all.json.total).toBe(4);
  expect(all.json.rows).toHaveLength(4);
  expect(all.json.rows[0].at).toBe(NOW + 2); // 新的在前

  const paged = await api('/api/judgment-ledger?limit=2&offset=1');
  expect(paged.json.rows).toHaveLength(2);
  expect(paged.json).toMatchObject({ total: 4, limit: 2, offset: 1 });

  const filtered = await api(`/api/judgment-ledger?strategy_id=mtf_alignment`);
  expect(filtered.json.total).toBe(1);
  expect(filtered.json.rows[0].strategy_id).toBe('mtf_alignment');

  const recent = await api(`/api/judgment-ledger?since=${NOW - 86_400_000}`);
  expect(recent.json.total).toBe(3);
});

it('GET /api/judgment-ledger 游标分页(?limit&cursor):翻完不重不漏,cursor 用完 next_cursor 仍给但没有下一页可翻', async () => {
  await setup();
  for (let i = 0; i < 5; i++) store.judgments.save(row({ at: NOW + i }));

  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page++) {
    const q = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : '?limit=2';
    const r = await api(`/api/judgment-ledger${q}`);
    expect(r.status).toBe(200);
    if (r.json.rows.length === 0) break;
    for (const row of r.json.rows) seen.push(row.episode_id);
    cursor = r.json.next_cursor;
  }
  expect(seen).toHaveLength(5);
  expect(new Set(seen).size).toBe(5); // 不重
  const all = await api('/api/judgment-ledger');
  expect(seen).toEqual(all.json.rows.map((r: { episode_id: string }) => r.episode_id)); // 顺序、集合都对得上 offset 分页

  const empty = await api('/api/judgment-ledger?limit=2');
  expect(typeof empty.json.next_cursor === 'string' || empty.json.next_cursor === null).toBe(true);
});

it('GET /api/judgment-ledger/summary 结算不完整的行不进统计,只报排除数', async () => {
  await setup();
  for (let i = 0; i < 10; i++) store.judgments.save(row({ at: NOW + i, outcome_r_model: 1, outcome_r_council: 0 }));
  for (let i = 0; i < 4; i++) store.judgments.save(row({ at: NOW + 100 + i, settlement_status: 'partial', outcome_r_model: -9, outcome_r_council: 0 }));

  const r = await api('/api/judgment-ledger/summary');
  expect(r.json.excluded_incomplete).toBe(4);
  expect(r.json.overall).toMatchObject({ alpha_n: 10, judgment_alpha: 1, excluded_incomplete: 4 });
});

it('GET /api/judgment-ledger/summary 出分层与结论口径;样本不足标 insufficient', async () => {
  await setup();
  for (let i = 0; i < 12; i++) store.judgments.save(row({ at: NOW + i, outcome_r_model: 1, outcome_r_council: 0.5, outcome_r_mechanical: 0 }));
  store.judgments.save(row({ strategy_id: 'mtf_alignment', at: NOW + 99, outcome_r_model: -1, outcome_r_council: 1 }));

  const r = await api('/api/judgment-ledger/summary');
  expect(r.status).toBe(200);
  expect(r.json).toMatchObject({ version: JUDGMENT_LEDGER_VERSION, n: 13, settled: 13, unsettled: 0, min_sample: 10 });
  expect(r.json.conclusion).toMatch(/override_alpha/);
  expect(r.json.overall).toMatchObject({ strategy_id: null, n: 13 });
  const bo = r.json.by_strategy.find((s: { strategy_id: string }) => s.strategy_id === 'breakout_retest');
  expect(bo).toMatchObject({ n: 12, insufficient: false, judgment_alpha: 0.5, alpha_vs_mechanical: 1, verdict: 'model_adds', override_rate: 0 });
  const mtf = r.json.by_strategy.find((s: { strategy_id: string }) => s.strategy_id === 'mtf_alignment');
  expect(mtf).toMatchObject({ n: 1, insufficient: true, verdict: 'insufficient' });
  // §9.29 新口径:行动覆盖率 / 独立簇数 / 双方都表态时的对照 / 因结算不完整被排除的行数
  expect(bo).toMatchObject({ alpha_clusters: 12, model_direction_rate: 1, council_direction_rate: 1, alpha_both_dir_n: 12 });
  expect(r.json.excluded_incomplete).toBe(0);

  const windowed = await api(`/api/judgment-ledger/summary?since=${NOW + 50}`);
  expect(windowed.json.n).toBe(1);
  expect(windowed.json.since).toBe(NOW + 50);
});

it('GET /api/judgment-ledger(/summary) ?source=backfill 只看回填行;默认 online 看不见它们(09-23 P0-1)', async () => {
  await setup();
  store.judgments.save(row({ episode_id: 'ep-online' }));
  const regret = { hold_r: 1, exit_now_r: -0.2, chosen_r: -0.2, best_r: 1, regret_r: 1.2, regret_hold: null, regret_exit: 1.2, hold_status: 'tp' as const, note: '' };
  store.judgments.save(row({ episode_id: 'ep-bf', mode: 'review', model_action: 'EXIT', trigger_kind: 'heartbeat', holding_reason: 'unknown', prompt_version: 'demo-playbook-v8', regret, regret_review: 1.2, source: 'backfill' }));
  // backfill 的 source 列没有触发器(迁移不在这一包的改动范围里),脚本直接写列;测试照做。
  activeState!.db.prepare("UPDATE demo_judgment_ledger SET source = 'backfill' WHERE episode_id = 'ep-bf'").run();

  const dflt = await api('/api/judgment-ledger');
  expect(dflt.json.rows.map((r: { episode_id: string }) => r.episode_id)).toEqual(['ep-online']);
  const bf = await api('/api/judgment-ledger?source=backfill');
  expect(bf.json).toMatchObject({ total: 1 });
  expect(bf.json.rows[0]).toMatchObject({ episode_id: 'ep-bf', trigger_kind: 'heartbeat' });
  const sum = await api('/api/judgment-ledger/summary?source=backfill');
  expect(sum.json.by_decision).toEqual([expect.objectContaining({ model_action: 'EXIT', holding_reason: 'unknown', trigger_kind: 'heartbeat', prompt_version: 'demo-playbook-v8', n: 1, mean_regret: 1.2, exit_regret_gt_half_share: 1 })]);
});
