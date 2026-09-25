// The backtest routes on the real HTTP surface (docs/demo/v3-ui-contract.md §9.8), against the shared
// fake fapi and a stub brain. Kept out of http.test.ts so the two files can move independently.

import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { stubBrain } from '../../src/demo/brain.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';

let fakeMarket: FakeMarketServer;
let cacheDir = '';
let DemoRuntime: typeof import('../../src/demo/runtime.js').DemoRuntime;
let createServer: typeof import('../../src/demo/http.js').createServer;

beforeAll(async () => {
  fakeMarket = await startFakeMarketServer();
  cacheDir = mkdtempSync(join(tmpdir(), 'tg-bt-http-'));
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

async function setup(): Promise<void> {
  const state = openStateDb(':memory:');
  const store = new DemoStore(state);
  const rt = new DemoRuntime({ store, backend: new PaperBackend(10_000), brains: { stub: stubBrain() }, marketPollMs: 600_000, accountPollMs: 600_000 });
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

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const HOUR = 3_600_000;

it('GET /api/backtest/estimate prices the run without calling the model', async () => {
  await setup();
  const to = Math.floor(Date.now() / (15 * 60_000)) * (15 * 60_000) - 1;
  const from = to - 6 * HOUR;
  const r = await api('GET', `/api/backtest/estimate?symbol=BTCUSDT&timeframe=15m&from=${from}&to=${to}&mode=every_close&max_judgments=10`);
  expect(r.status).toBe(200);
  expect(r.json.bars).toBeGreaterThan(0);
  expect(r.json.candidates).toBe(r.json.bars);
  expect(r.json.model).toBe('stub');
  // the stub brain is not in the price table → no ¥ figure, and the UI must say "订阅额度/不计费"
  expect(r.json.est_cny).toBeNull();
  expect(typeof r.json.note).toBe('string');
});

it('GET /api/backtest/estimate rejects a bad range with 400 + errors[]', async () => {
  await setup();
  const r = await api('GET', '/api/backtest/estimate?symbol=BTCUSDT&timeframe=15m&from=2&to=1&mode=triggers');
  expect(r.status).toBe(400);
  expect(r.json.errors.join()).toContain('to > from');
});

it('POST /api/backtest runs, GET /:id returns run+steps+trades, and the list shows it', async () => {
  await setup();
  const to = Math.floor(Date.now() / (15 * 60_000)) * (15 * 60_000) - 1;
  const from = to - 3 * HOUR;
  const start = await api('POST', '/api/backtest', { symbol: 'BTCUSDT', timeframe: '15m', from, to, mode: 'every_close', max_judgments: 3, review_every_close: false });
  expect(start.status).toBe(202);
  const id = start.json.run.id as string;
  expect(start.json.run.prompt_version).toBeTruthy();

  let detail = await api('GET', `/api/backtest/${id}`);
  for (let i = 0; i < 200 && detail.json.run.status !== 'done' && detail.json.run.status !== 'failed'; i++) {
    await new Promise((r) => setTimeout(r, 25));
    detail = await api('GET', `/api/backtest/${id}`);
  }
  expect(detail.json.run.status).toBe('done');
  expect(detail.json.run.summary.judgments).toBe(3);
  expect(detail.json.steps).toHaveLength(3);
  expect(detail.json.steps[0].visible_upto_ms).toBe(detail.json.steps[0].at_ms);
  expect(detail.json.steps[0].action).toBe('NO_TRADE'); // the stub brain
  expect(Array.isArray(detail.json.trades)).toBe(true);

  const list = await api('GET', '/api/backtest');
  expect(list.json.runs[0].id).toBe(id);
  expect(list.json.running).toBeNull();
});

it('POST /api/backtest/:id/cancel answers even for an unknown / finished run', async () => {
  await setup();
  const r = await api('POST', '/api/backtest/bt-nope/cancel');
  expect(r.status).toBe(200);
  expect(r.json.cancelled).toBe(false);
});

it('GET /api/market/klines/history pages the replay chart and caches to disk', async () => {
  await setup();
  const to = Date.now();
  const from = to - 12 * HOUR;
  const r = await api('GET', `/api/market/klines/history?symbol=BTCUSDT&interval=15m&from=${from}&to=${to}`);
  expect(r.status).toBe(200);
  expect(r.json.symbol).toBe('BTCUSDT');
  expect(r.json.interval).toBe('15m');
  expect(r.json.klines.length).toBeGreaterThan(0);
  expect(r.json.complete).toBe(true);
  expect(r.json.from).toBe(from);
  for (const k of r.json.klines) expect(k.open_time).toBeGreaterThanOrEqual(from - 15 * 60_000);
  const bad = await api('GET', '/api/market/klines/history?symbol=BTCUSDT&interval=15m&from=9&to=8');
  expect(bad.status).toBe(400);
});

it('GET /api/market/klines/history truncates at the 20000-bar cap instead of paging forever', async () => {
  await setup();
  const to = Date.now();
  const step = 15 * 60_000;
  const from = to - 30_000 * step; // deeper than the cap
  const r = await api('GET', `/api/market/klines/history?symbol=BTCUSDT&interval=15m&from=${from}&to=${to}`);
  expect(r.status).toBe(200);
  expect(r.json.complete).toBe(false);
  expect(r.json.max_bars).toBe(20_000);
  expect(r.json.from).toBe(to - 20_000 * step);
  expect(r.json.requested_from).toBe(from);
});
