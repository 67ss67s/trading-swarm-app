// 策略库 + 归因的 HTTP 路由(routes-strategies.ts,经 http-extra.ts 注册)。
// 走真实的 createServer;大脑是 stub,不调任何付费模型。

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
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';

let fakeMarket: FakeMarketServer;
let cacheDir = '';
let DemoRuntime: typeof import('../../src/demo/runtime.js').DemoRuntime;
let createServer: typeof import('../../src/demo/http.js').createServer;

beforeAll(async () => {
  fakeMarket = await startFakeMarketServer();
  cacheDir = mkdtempSync(join(tmpdir(), 'tg-strat-http-'));
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

/** A brain that always answers with the attribution JSON (the归因 route calls the CHEAP brain). */
function scriptedBrain(text: string): Brain {
  return { name: 'stub', async complete() { return { text, latency_ms: 1, model: 'stub', input_tokens: 10, output_tokens: 5 }; } };
}

const ATTR_JSON = JSON.stringify([
  {
    title: '追单太远',
    strategy_id: 'breakout_retest',
    symbol: 'BTCUSDT',
    evidence_said: '清单写着距突破位 1.4 ATR',
    rule_said: '1.5 ATR 以内可以追',
    actual: '入场后立刻回抽打止损',
    proposal: { kind: 'param', strategy_id: 'breakout_retest', param: 'chase_atr_max', value: 1, text: '' },
  },
]);

async function setup(brainText = ATTR_JSON): Promise<void> {
  const state = openStateDb(':memory:');
  store = new DemoStore(state);
  const rt = new DemoRuntime({ store, backend: new PaperBackend(10_000), brains: { stub: scriptedBrain(brainText) }, marketPollMs: 600_000, accountPollMs: 600_000 });
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
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

it('GET /api/strategies lists the seeded built-ins with their gate state', async () => {
  await setup();
  const r = await api('GET', '/api/strategies');
  expect(r.status).toBe(200);
  // 5 条原生 + horizon 变体 swing_breakout_retest / position_breakout_retest(中线/周线扫描要有对应 horizon 的策略)
  expect(r.json.strategies).toHaveLength(7);
  expect(r.json.strategies.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining(['swing_breakout_retest', 'position_breakout_retest']));
  expect(r.json.strategies.find((s: { id: string }) => s.id === 'swing_breakout_retest')).toMatchObject({ horizon: 'swing', status: 'backtest', active: false });
  expect(r.json.active).toEqual(['breakout_retest']);
  expect(r.json.statuses).toEqual(['draft', 'backtest', 'shadow', 'paper', 'live_capped']);
  // head 是漏斗给的 v2 草稿(backtest),v1 仍然是 paper —— 实盘照旧跑 v1。
  const bo = r.json.strategies.find((s: { id: string }) => s.id === 'breakout_retest');
  expect(bo).toMatchObject({ version: 2, status: 'backtest', active: true, next_status: 'shadow', family_label: '趋势延续' });
  expect(bo.promote_blocked).toMatch(/OOS 成交不足 30 笔/);
  const mtf = r.json.strategies.find((s: { id: string }) => s.id === 'mtf_alignment');
  expect(mtf).toMatchObject({ status: 'backtest', active: false, next_status: 'shadow' });
  expect(mtf.promote_blocked).toMatch(/OOS 成交不足 30 笔/);
});

it('GET /api/strategies/:id returns versions; 404 for an unknown id', async () => {
  await setup();
  const r = await api('GET', '/api/strategies/breakout_retest');
  expect(r.status).toBe(200);
  expect(r.json.strategy.id).toBe('breakout_retest');
  expect(r.json.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  expect(r.json.attributions).toEqual([]);
  expect((await api('GET', '/api/strategies/nope')).status).toBe(404);
});

it('POST /api/strategies/active refuses anything below paper and writes the workflow otherwise', async () => {
  await setup();
  const bad = await api('POST', '/api/strategies/active', { ids: ['mtf_alignment'] });
  expect(bad.status).toBe(400);
  expect(bad.json.error.message).toMatch(/未到 paper/);
  expect((await api('POST', '/api/strategies/active', { ids: ['ghost'] })).status).toBe(400);

  const ok = await api('POST', '/api/strategies/active', { ids: ['breakout_retest'] });
  expect(ok.status).toBe(200);
  expect(ok.json.active).toEqual(['breakout_retest']);
  expect(ok.json.workflow.active_strategies).toEqual(['breakout_retest']);
});

it('propose-version makes a draft; promote respects the ladder and the live confirm', async () => {
  await setup();
  const v2 = await api('POST', '/api/strategies/breakout_retest/propose-version', { params: { chase_atr_max: 1.2 } });
  expect(v2.status).toBe(201);
  expect(v2.json.strategy).toMatchObject({ version: 3, status: 'draft', parent_version: 2 });
  expect(v2.json.strategy.params.chase_atr_max.value).toBe(1.2);

  const bad = await api('POST', '/api/strategies/breakout_retest/propose-version', { params: { chase_atr_max: 42 } });
  expect(bad.status).toBe(400);
  expect(bad.json.error.message).toMatch(/超出范围/);

  // head 现在是 draft:只能往 backtest 走一格。
  expect((await api('POST', '/api/strategies/breakout_retest/promote', { to: 'paper' })).status).toBe(409);
  expect((await api('POST', '/api/strategies/breakout_retest/promote', { to: 'backtest' })).json.strategy.status).toBe('backtest');
  expect((await api('POST', '/api/strategies/breakout_retest/promote', { to: 'retired' })).status).toBe(400);
});

it('retire drops the strategy out of the live active list', async () => {
  await setup();
  const r = await api('POST', '/api/strategies/breakout_retest/retire');
  expect(r.status).toBe(200);
  expect(r.json.strategy.status).toBe('retired');
  expect(r.json.active).toEqual([]);
  expect((await api('GET', '/api/strategies')).json.active).toEqual([]);
});

it('POST /api/backtest/:id/attribute needs a finished run, then proposes memories and changes nothing', async () => {
  await setup();
  expect((await api('POST', '/api/backtest/nope/attribute')).status).toBe(404);

  const now = Date.now();
  store.saveBacktestRun({
    id: 'bt-x', created_at: now, symbol: 'BTCUSDT', timeframe: '15m', from_ms: now - 86_400_000, to_ms: now, mode: 'triggers', status: 'running',
    params: { symbol: 'BTCUSDT', timeframe: '15m', from: now - 86_400_000, to: now, mode: 'triggers', max_judgments: 10, review_every_close: false, brain: 'stub', brain_model: null, horizon_bars: 24, risk_pct: 0.5, max_opens_per_day: 4, strategy_ids: ['breakout_retest'], attribute: false },
    brain: 'stub', prompt_version: 'demo-playbook-v5', progress: null, summary: null, error: null,
  });
  expect((await api('POST', '/api/backtest/bt-x/attribute')).status).toBe(409);

  const run = store.backtestRun('bt-x')!;
  store.saveBacktestRun({
    ...run,
    status: 'done',
    summary: {
      judgments: 4, scans: 4, reviews: 0, actions: { PROPOSE: 1 }, trades: 1, wins: 0, losses: 1, flat: 0, win_rate: 0, avg_r: -1, sum_r: -1, max_drawdown_r: 1,
      avg_hold_bars: 5, cost: { input_tokens: 10, output_tokens: 5, cny: 0 }, model: 'stub', missed_move: null, bars: 20, candidates: 4, capped: false,
      trade_rows: [{ step_idx: 0, strategy_id: 'breakout_retest', direction: 'long', entry: 'market', limit_price: null, proposed_at: now, fill_at: now, fill_price: 100, stop: 99, tp: 102, exit_at: now, exit_price: 99, status: 'stop', close_reason: '止损', r: -1, mae_r: -1, mfe_r: 0.2, bars_held: 5, reduced_fraction: 0, reduced_r: null }],
      strategies: [{ id: 'breakout_retest', version: 1, content_hash: 'x', status: 'paper' }],
      by_strategy: { breakout_retest: { trades: 1, wins: 0, losses: 1, win_rate: 0, expectancy_r: -1, sum_r: -1, mae_r_p50: -1, proposals: 1 } },
    },
  });

  const r = await api('POST', '/api/backtest/bt-x/attribute');
  expect(r.status).toBe(200);
  expect(r.json.cached).toBe(false);
  expect(r.json.points).toHaveLength(1);
  expect(r.json.points[0]).toMatchObject({ kind: 'param', strategy_id: 'breakout_retest', applied_version: null });

  // 一条 proposed 记忆,零 active;策略本体一个字没动。
  expect(store.memory.counts()).toMatchObject({ proposed: 1, active: 0 });
  expect(store.strategies.head('breakout_retest')!.version).toBe(2); // 开机建的 v2 草稿,归因没再动它
  expect(store.strategies.head('breakout_retest')!.params['chase_atr_max']!.value).toBe(1.5);

  // 第二次调用命中已有结果,不再花钱。
  const again = await api('POST', '/api/backtest/bt-x/attribute');
  expect(again.json.cached).toBe(true);
  expect(store.memory.counts().proposed).toBe(1);

  expect((await api('GET', '/api/backtest/bt-x/attribution')).json.points).toHaveLength(1);

  // 人点「采纳」→ 新 draft 版本,并回填 applied_version。
  const adopted = await api('POST', '/api/strategies/breakout_retest/propose-version', { attribution_id: r.json.points[0].id });
  expect(adopted.status).toBe(201);
  expect(adopted.json.strategy).toMatchObject({ version: 3, status: 'draft' });
  expect(adopted.json.strategy.params.chase_atr_max.value).toBe(1);
  expect((await api('GET', '/api/backtest/bt-x/attribution')).json.points[0].applied_version).toBe(3);
});

// ---------------------------------------------------------------- PUT /api/strategies/:id/evidence (§9.34)

it('PUT /api/strategies/:id/evidence validates the spec and always spins a new draft version', async () => {
  await setup();

  // 缺 evidence 键 → 400
  const missing = await api('PUT', '/api/strategies/breakout_retest/evidence', {});
  expect(missing.status).toBe(400);
  expect(missing.json.error.message).toMatch(/evidence 必填/);

  // 非法指标 id
  const badIndicator = await api('PUT', '/api/strategies/breakout_retest/evidence', { evidence: { indicators: [{ id: 'nope_indicator', tf: '1h' }], events: [] } });
  expect(badIndicator.status).toBe(400);
  expect(badIndicator.json.error.message).toMatch(/指标库里没有/);

  // 非法周期
  const badTf = await api('PUT', '/api/strategies/breakout_retest/evidence', { evidence: { indicators: [{ id: 'rsi', tf: '7m' }], events: [] } });
  expect(badTf.status).toBe(400);
  expect(badTf.json.error.message).toMatch(/无效周期/);

  // 非法触发种类
  const badEvent = await api('PUT', '/api/strategies/breakout_retest/evidence', { evidence: { indicators: [], events: ['not_a_kind'] } });
  expect(badEvent.status).toBe(400);
  expect(badEvent.json.error.message).toMatch(/无效触发种类/);

  // 404:不存在的策略
  expect((await api('PUT', '/api/strategies/nope/evidence', { evidence: null })).status).toBe(404);

  // head 是 v2(漏斗草稿);合法证据集 → 201,新版本 = 旧 version+1、status='draft'、content_hash 变了、
  // evidence 已规范化(排序 + 去重),effective_evidence 等于它。
  const before = (await api('GET', '/api/strategies/breakout_retest')).json.strategy;
  const ok = await api('PUT', '/api/strategies/breakout_retest/evidence', {
    evidence: { indicators: [{ id: 'macd', tf: '4h' }, { id: 'rsi', tf: '1h' }, { id: 'rsi', tf: '1h' }], events: ['breakout', 'ema_cross'] },
  });
  expect(ok.status).toBe(201);
  expect(ok.json.from_version).toBe(before.version);
  const strat = ok.json.strategy;
  expect(strat.version).toBe(before.version + 1);
  expect(strat.status).toBe('draft');
  expect(strat.content_hash).not.toBe(before.content_hash);
  // 规范化:按 id/tf 排序,(rsi,1h) 去重成一条。
  expect(strat.evidence.indicators).toEqual([{ id: 'macd', tf: '4h' }, { id: 'rsi', tf: '1h' }]);
  expect(strat.evidence.events).toEqual(['breakout', 'ema_cross']);
  expect(strat.effective_evidence).toEqual(strat.evidence);

  // GET 详情:旧版本那一行(before.version)的 content_hash 与 evidence 一个字都没变。
  const detail = await api('GET', '/api/strategies/breakout_retest');
  const oldRow = detail.json.versions.find((v: { version: number }) => v.version === before.version);
  expect(oldRow).toBeDefined();
  expect(oldRow.content_hash).toBe(before.content_hash);
  expect(oldRow.evidence ?? null).toEqual(before.evidence ?? null);

  // 再 PUT 同一套证据 → 409(内容没有变化)
  const dup = await api('PUT', '/api/strategies/breakout_retest/evidence', {
    evidence: { indicators: [{ id: 'rsi', tf: '1h' }, { id: 'macd', tf: '4h' }], events: ['ema_cross', 'breakout'] },
  });
  expect(dup.status).toBe(409);
  expect(dup.json.error.message).toMatch(/内容没有变化/);

  // { evidence: null } 在有自定义证据的策略上 → 201,新版本 evidence 为 null,effective_evidence 回到默认集。
  const cleared = await api('PUT', '/api/strategies/breakout_retest/evidence', { evidence: null });
  expect(cleared.status).toBe(201);
  expect(cleared.json.strategy.version).toBe(strat.version + 1);
  expect(cleared.json.strategy.evidence).toBeNull();
  expect(cleared.json.strategy.effective_evidence).toEqual({
    indicators: [{ id: 'ema20', tf: '1h' }, { id: 'ema50', tf: '1h' }, { id: 'atr', tf: '1h' }, { id: 'rsi', tf: '1h' }],
    events: [],
    info_topics: [],
  });

  // 台账:一条 kind='version_created'、who='human'、reason 含「人工改证据集」。
  const timeline = await api('GET', '/api/strategies/breakout_retest/timeline');
  expect(timeline.status).toBe(200);
  const evidenceEvents = timeline.json.events.filter((e: { kind: string; reason: string }) => e.kind === 'version_created' && e.reason.includes('人工改证据集'));
  expect(evidenceEvents.length).toBeGreaterThanOrEqual(2); // 一次写入 + 一次清空
  expect(evidenceEvents.every((e: { who: string }) => e.who === 'human')).toBe(true);
});
