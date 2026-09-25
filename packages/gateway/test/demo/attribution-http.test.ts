// 归因报告的 HTTP 路由(routes-attribution.ts,经 http-extra.ts 注册;契约 §9.37)。
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
import type { StrategyThread } from '../../src/demo/types.js';
import { buildOriginResolver } from '../../src/demo/routes-attribution.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';

let fakeMarket: FakeMarketServer;
let cacheDir = '';
let DemoRuntime: typeof import('../../src/demo/runtime.js').DemoRuntime;
let createServer: typeof import('../../src/demo/http.js').createServer;

beforeAll(async () => {
  fakeMarket = await startFakeMarketServer();
  cacheDir = mkdtempSync(join(tmpdir(), 'tg-attr-http-'));
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
const HOUR = 3_600_000;

async function setup(): Promise<void> {
  const state = openStateDb(':memory:');
  store = new DemoStore(state);
  const rt = new DemoRuntime({ store, backend: new PaperBackend(10_000), brains: { stub }, marketPollMs: 600_000, accountPollMs: 600_000 });
  await rt.start();
  rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'], timeframe: '15m', execution: 'paper' });
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

function closedThread(i: number, over: Partial<StrategyThread> = {}): StrategyThread {
  const closedAt = NOW + (i + 1) * HOUR;
  return {
    id: `th-${i}`,
    symbol: 'BTCUSDT',
    side: i % 2 === 0 ? 'long' : 'short',
    status: 'closed',
    source: 'agent',
    backend: 'paper',
    strategy_id: 'breakout_retest',
    strategy_version: 1,
    timeframe: '15m',
    thesis: '',
    invalidation_text: null,
    watch_conditions: [],
    entry: { type: 'market', price: '100', zone: null },
    stop_price: '98',
    take_profits: ['104'],
    qty: '1',
    margin_usdt: null,
    leverage: 3,
    margin_mode: 'cross',
    entry_client_order_id: `cid-${i}`,
    protection_client_order_ids: [],
    filled_avg_price: '100',
    realized_pnl: '2',
    exit_price: '102',
    close_reason: i % 3 === 0 ? '止损触发 @ 98' : '止盈触发 @ 102',
    attention: null,
    entry_lookup_misses: 0,
    leg_seq: 1,
    episode_ids: [],
    intent_ids: [],
    created_at: NOW + i * HOUR,
    updated_at: closedAt,
    opened_at: NOW + i * HOUR,
    closed_at: closedAt,
    version: 1,
    settlement: { at: closedAt, realized_pnl: '2', commission: '0.1', funding: '-0.02', net_pnl: '1.88', exit_price: '102', trades: 2, window: [NOW + i * HOUR, closedAt], source: 'exchange', initial_risk_usdt: '2' },
    ...over,
  } as StrategyThread;
}

it('GET /api/attribution/summary:空库也 200,三层小计都在且全 insufficient', async () => {
  await setup();
  const r = await api('/api/attribution/summary');
  expect(r.status).toBe(200);
  expect(r.json.strategies).toEqual([]);
  expect(r.json.by_tier.map((t: { tier: string }) => t.tier)).toEqual(['short', 'mid', 'long']);
  expect(r.json.by_tier.every((t: { insufficient: boolean; n: number }) => t.insufficient && t.n === 0)).toBe(true);
});

it('GET /api/attribution/summary:按 (id, version, backend) 分组,五个维度都出来', async () => {
  await setup();
  for (let i = 0; i < 12; i++) store.saveThread(closedThread(i));
  const r = await api('/api/attribution/summary');
  expect(r.status).toBe(200);
  expect(r.json.strategies).toHaveLength(1);
  const rep = r.json.strategies[0];
  expect(rep).toMatchObject({ strategy_id: 'breakout_retest', strategy_version: 1, backend: 'paper', n: 12, insufficient: false });
  // 五个维度
  expect(rep.direction.long.n + rep.direction.short.n).toBe(12);
  expect(rep.exits.by_kind.length).toBeGreaterThan(0);
  expect(rep.period.replay_timeframe).toBeTruthy();
  expect(rep.screener.by_origin.length).toBeGreaterThan(0);
  expect(rep.frequency.opens).toBe(12);
  // 层小计
  const short = r.json.by_tier.find((t: { tier: string }) => t.tier === 'short');
  expect(short.n + r.json.by_tier.find((t: { tier: string }) => t.tier === 'mid').n + r.json.by_tier.find((t: { tier: string }) => t.tier === 'long').n).toBe(12);
});

it('GET /api/attribution/summary:结算不完整的线程一笔都不进统计', async () => {
  await setup();
  for (let i = 0; i < 12; i++) store.saveThread(closedThread(i));
  // 空壳结算(窗口内 0 笔成交)= partial,按 judgment-ledger 的铁律不进任何统计
  for (let i = 12; i < 20; i++) {
    store.saveThread(closedThread(i, { settlement: { at: NOW, realized_pnl: '0', commission: '0', funding: '0', net_pnl: '0', exit_price: null, trades: 0, window: [NOW, NOW], source: 'exchange', note: '没有这个币的成交', initial_risk_usdt: '2' } }));
  }
  const r = await api('/api/attribution/summary');
  expect(r.json.strategies[0].n).toBe(12);
});

it('GET /api/strategies/:id/attribution:不存在的策略 404,存在的给 versions + report', async () => {
  await setup();
  const missing = await api('/api/strategies/does_not_exist/attribution');
  expect(missing.status).toBe(404);

  for (let i = 0; i < 12; i++) store.saveThread(closedThread(i));
  const r = await api('/api/strategies/breakout_retest/attribution');
  expect(r.status).toBe(200);
  expect(r.json.strategy_id).toBe('breakout_retest');
  expect(r.json.versions).toHaveLength(1);
  expect(r.json.report.n).toBe(12);

  // 点名一个不存在的版本 → 那一版没有样本,report 为 null(不拿别的版本冒充)
  const other = await api('/api/strategies/breakout_retest/attribution?version=7');
  expect(other.json.versions).toEqual([]);
  expect(other.json.report).toBeNull();
});

it('window_days / since 收窄窗口', async () => {
  await setup();
  for (let i = 0; i < 12; i++) store.saveThread(closedThread(i));
  // 再塞 6 笔「一年前平的」
  for (let i = 12; i < 18; i++) {
    const old = NOW - 365 * 86_400_000;
    store.saveThread(closedThread(i, { created_at: old, opened_at: old, closed_at: old + HOUR, updated_at: old + HOUR }));
  }
  const all = await api(`/api/attribution/summary?since=1`);
  expect(all.json.strategies[0].n).toBe(18);
  const recent = await api(`/api/attribution/summary?since=${NOW - 86_400_000}`);
  expect(recent.json.strategies[0].n).toBe(12);
});

it('GET /api/judgments/:id 带出 decision_record;老 episode 是 null', async () => {
  await setup();
  const ep = { id: 'ep-old', at: NOW, as_of: NOW, symbol: 'BTCUSDT', thread_id: null, trigger: { kind: 'bar_close', detail: '' }, strategy_before: { state: 'researching', version: 0 }, evidence: [], context_text: '', context_hash: 'c', prompt_version: 'p', model: 'stub', judgment: null, judgment_raw: null, schema_errors: [], reducer: null, gates: [], intent: null, usage: null, status: 'done', error: null, strategy_after: null };
  store.saveEpisode(ep as unknown as Parameters<DemoStore['saveEpisode']>[0]);
  const r = await api('/api/judgments/ep-old');
  expect(r.status).toBe(200);
  expect(r.json.decision_record).toBeNull();
});

it('buildOriginResolver:手工 → Radar 候选 → 白名单 → 观察名单 → 已不在任何名单', async () => {
  await setup();
  const screen = { id: 'sc-1', horizon: 'short', started_at: NOW - HOUR, finished_at: NOW, status: 'done', universe: 'watchlist+whitelist', symbols: ['RADARUSDT'], errors: [], run_id: null, handoff_id: null, proposal: null, brain: null, cost_cny: 0, error: null };
  store.screens.saveScreen(screen as unknown as Parameters<typeof store.screens.saveScreen>[0]);
  store.screens.saveCandidates([{ screen_id: 'sc-1', horizon: 'short', symbol: 'RADARUSDT', strategy_id: 'breakout_retest', fit_score: 0.9, rank: 1, reasons: [], card: {} as never, ttl_at: NOW + 10 * HOUR, created_at: NOW - HOUR }]);

  const workflow = { ...activeRt!.workflow, screener_whitelist: ['WLUSDT'], watchlist: ['BTCUSDT'] };
  const originOf = buildOriginResolver(store, workflow);

  expect(originOf(closedThread(0, { source: 'manual' }))).toBe('manual');
  expect(originOf(closedThread(1, { source: 'chat' }))).toBe('manual');
  expect(originOf(closedThread(2, { symbol: 'RADARUSDT', opened_at: NOW }))).toBe('radar');
  // 候选有效期之外 → 不算 Radar 的功劳
  expect(originOf(closedThread(3, { symbol: 'RADARUSDT', opened_at: NOW + 99 * HOUR }))).not.toBe('radar');
  expect(originOf(closedThread(4, { symbol: 'WLUSDT' }))).toBe('whitelist');
  expect(originOf(closedThread(5, { symbol: 'BTCUSDT' }))).toBe('watchlist');
  expect(originOf(closedThread(6, { symbol: 'GONEUSDT' }))).toBe('unknown');
});
