// backtest.ts — the blind backtester. Everything here runs on a synthetic kline series served by a
// local fake fapi and on stub brains: NO paid model is ever called.
//
// The test that matters most is the leak test: it captures the EpisodeInputs the brain actually saw
// (by parsing the context text back out) and asserts no bar after the judgment's own close was in it.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import type { Brain } from '../../src/demo/brain.js';
import type { Kline, Workflow } from '../../src/demo/types.js';
import { DEFAULT_WORKFLOW } from '../../src/demo/workflow.js';

// ---------------------------------------------------------------- synthetic market

const TF = '15m';
const TF_MS = 15 * 60_000;
/** Bar 0 opens here; everything in the suite is anchored to this so runs are deterministic. */
const T0 = Date.UTC(2026, 0, 5, 0, 0, 0);

interface Shape {
  /** close = open + drift, per bar index. */
  drift: (i: number) => number;
}

function series(count: number, base: number, shape: Shape, stepMs: number, t0: number): Kline[] {
  const bars: Kline[] = [];
  let price = base;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = open + shape.drift(i);
    const high = Math.max(open, close) + 2;
    const low = Math.min(open, close) - 2;
    const openTime = t0 + i * stepMs;
    bars.push({ open_time: openTime, open: open.toFixed(2), high: high.toFixed(2), low: low.toFixed(2), close: close.toFixed(2), volume: (100 + (i % 7) * 3).toFixed(3), close_time: openTime + stepMs - 1 });
    price = close;
  }
  return bars;
}

/** A slow grind up, then one sharp drop — enough structure for triggers to fire and stops to be hit. */
function shapeFor(tf: string): Shape {
  const scale = tf === '15m' ? 1 : tf === '1h' ? 4 : tf === '4h' ? 16 : 96;
  return { drift: (i) => (i % 23 === 22 ? -18 * scale : 3 * scale * (((i * 7) % 5) - 1.2)) };
}

const BAR_COUNT: Record<string, number> = { '15m': 900, '1h': 600, '4h': 400, '1d': 400 };
const STEP: Record<string, number> = { '15m': TF_MS, '1h': 3_600_000, '4h': 4 * 3_600_000, '1d': 86_400_000 };

const SERIES: Record<string, Kline[]> = {};
for (const tf of ['15m', '1h', '4h', '1d']) {
  const step = STEP[tf]!;
  const n = BAR_COUNT[tf]!;
  // Every series ends at the same instant so "visible up to T" lines up across timeframes.
  SERIES[tf] = series(n, 60_000, shapeFor(tf), step, T0 - (n - 1) * step + STEP['15m']! * 400);
}

/** from/to for the walk: a 120-bar window well inside the 15m series. */
const WALK_FROM = SERIES['15m']![600]!.close_time;
const WALK_TO = SERIES['15m']![720]!.close_time;

let market: http.Server;
let marketUrl = '';
let cacheDir = '';

beforeAll(async () => {
  market = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/fapi/v1/klines') {
      const tf = url.searchParams.get('interval') ?? '15m';
      const limit = Math.min(1500, Number(url.searchParams.get('limit') ?? '500'));
      const endTime = Number(url.searchParams.get('endTime') ?? '');
      const all = SERIES[tf] ?? [];
      const capped = Number.isFinite(endTime) && endTime > 0 ? all.filter((k) => k.open_time <= endTime) : all;
      const page = capped.slice(-limit).map((k) => [k.open_time, k.open, k.high, k.low, k.close, k.volume, k.close_time, '0', 0, '0', '0', '0']);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(page));
    }
    if (url.pathname === '/fapi/v1/fundingRate') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([]));
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise<void>((r) => market.listen(0, '127.0.0.1', r));
  marketUrl = `http://127.0.0.1:${(market.address() as AddressInfo).port}`;
  cacheDir = mkdtempSync(join(tmpdir(), 'tg-bt-cache-'));
  process.env['TG_DEMO_MARKET_BASE'] = marketUrl;
  process.env['TG_DEMO_KLINE_CACHE_DIR'] = cacheDir;
});

afterAll(async () => {
  await new Promise<void>((r) => market.close(() => r()));
  rmSync(cacheDir, { recursive: true, force: true });
  delete process.env['TG_DEMO_MARKET_BASE'];
  delete process.env['TG_DEMO_KLINE_CACHE_DIR'];
});

// market.ts / backtest.ts read the base URL as a module-level const → import AFTER the env is set.
type BacktestModule = typeof import('../../src/demo/backtest.js');
let bt: BacktestModule;
beforeAll(async () => {
  bt = await import('../../src/demo/backtest.js');
});

// ---------------------------------------------------------------- harness

let state: StateDb | null = null;

afterEach(() => {
  state?.close();
  state = null;
});

interface SeenCall {
  system: string;
  user: string;
}

function recordingBrain(reply: (user: string, n: number) => string, seen: SeenCall[]): Brain {
  let n = 0;
  return {
    name: 'pi:zai/glm-5.3', // a priced model, so the cost accounting is exercised
    async complete(system, user) {
      seen.push({ system, user });
      const text = reply(user, n++);
      return { text, latency_ms: 1, model: 'pi:zai/glm-5.3', input_tokens: 1600, output_tokens: 400 };
    },
  };
}

const NO_TRADE = JSON.stringify({
  action: 'NO_TRADE', direction: null, confidence: 0.2, headline: '桩:不交易', thesis: '测试固定输出',
  reasons: ['测试 [E1]'], evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [], proposal: null,
});
const HOLD = JSON.stringify({
  action: 'HOLD', direction: null, confidence: 0.5, headline: '桩:继续持有', thesis: '测试固定输出',
  reasons: ['测试 [E1]'], evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [], proposal: null,
});

/** PROPOSE a long at market from the mark in the context, stop 1% below, tp 2% above. */
function proposeLong(user: string): string {
  const m = /mark (\d+(?:\.\d+)?)/.exec(user);
  const mark = m ? Number(m[1]) : 0;
  return JSON.stringify({
    action: 'PROPOSE', direction: 'long', confidence: 0.7, headline: '桩:测试做多', thesis: '测试提议',
    reasons: ['测试 [E1]'], evidence_refs: ['E1'], invalidation: '跌破止损', invalidation_price: (mark * 0.99).toFixed(2), target_price: (mark * 1.02).toFixed(2),
    watch_conditions: [], proposal: { direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: (mark * 0.99).toFixed(2), take_profits: [(mark * 1.02).toFixed(2)], rationale: '测试' },
  });
}

function harness(brain: Brain): { manager: InstanceType<BacktestModule['BacktestManager']>; store: DemoStore; events: { event: string; data: unknown }[]; workflow: Workflow } {
  state = openStateDb(':memory:');
  const store = new DemoStore(state);
  const events: { event: string; data: unknown }[] = [];
  const workflow: Workflow = { ...DEFAULT_WORKFLOW, timeframe: TF, watchlist: ['BTCUSDT'], updated_at: Date.now() };
  const manager = new bt.BacktestManager({ store, brainFor: () => brain, workflow: () => workflow, emit: (event, data) => events.push({ event, data }) });
  return { manager, store, events, workflow };
}

function params(over: Partial<import('../../src/demo/backtest.js').BacktestParams> = {}): import('../../src/demo/backtest.js').BacktestParams {
  return {
    symbol: 'BTCUSDT', timeframe: TF, from: WALK_FROM, to: WALK_TO, mode: 'every_close',
    max_judgments: 12, review_every_close: true, brain: 'stub', brain_model: null,
    horizon_bars: 24, risk_pct: 0.5, max_opens_per_day: 10, ...over,
  };
}

/** Every `O<num> H<num> L<num> C<num>` timestamp printed into the context's "最近 4 根" evidence line. */
function barTimesInContext(user: string): number[] {
  const out: number[] = [];
  for (const m of user.matchAll(/(\d{2})-(\d{2}) (\d{2}):(\d{2}) O/g)) {
    const [, mo, d, h, mi] = m;
    out.push(Date.UTC(2026, Number(mo) - 1, Number(d), Number(h), Number(mi)));
  }
  return out;
}

// ---------------------------------------------------------------- tests

describe('visible window / blind edge', () => {
  it('lastClosedIndex + visibleWindow never return a bar closing after the boundary', () => {
    const bars = SERIES['15m']!;
    const boundary = bars[300]!.close_time;
    const win = bt.visibleWindow(bars, boundary, 60);
    expect(win).toHaveLength(60);
    expect(win[win.length - 1]!.close_time).toBe(boundary);
    for (const k of win) expect(k.close_time).toBeLessThanOrEqual(boundary);
    // A boundary in the middle of a bar sees only the previous close.
    const mid = bars[300]!.open_time + 1000;
    expect(bt.visibleWindow(bars, mid, 1)[0]!.close_time).toBe(bars[299]!.close_time);
  });

  it('ticker24hFromBars is built from visible bars only', () => {
    const bars = SERIES['15m']!;
    const boundary = bars[300]!.close_time;
    const t = bt.ticker24hFromBars(bars, boundary, TF);
    const win = bt.visibleWindow(bars, boundary, 96);
    const hi = Math.max(...win.map((k) => Number(k.high)));
    expect(Number(t.highPrice)).toBeCloseTo(hi, 2);
  });
});

describe('estimate', () => {
  it('counts trigger candidates without calling the model, and prices them from the table', async () => {
    const seen: SeenCall[] = [];
    const brain = recordingBrain(() => NO_TRADE, seen);
    const { workflow } = harness(brain);
    const est = await bt.estimateBacktest(params({ mode: 'triggers' }), workflow, 'pi:zai/glm-5.3');
    expect(seen).toHaveLength(0); // the estimate is free
    expect(est.bars).toBeGreaterThan(100);
    expect(est.candidates).toBeGreaterThan(0);
    expect(est.candidates).toBeLessThanOrEqual(est.bars);
    expect(est.per_judgment_cny).toBeGreaterThan(0);
    expect(est.est_cny).toBeCloseTo((est.per_judgment_cny ?? 0) * Math.min(est.candidates, 12), 6);
    // every_close: every bar in the window is a candidate
    const all = await bt.estimateBacktest(params({ mode: 'every_close' }), workflow, 'pi:zai/glm-5.3');
    expect(all.candidates).toBe(all.bars);
  });

  it('subscription brains have no per-token price → null instead of ¥0', async () => {
    const { workflow } = harness(recordingBrain(() => NO_TRADE, []));
    const est = await bt.estimateBacktest(params(), workflow, 'claude:sonnet');
    expect(est.per_judgment_cny).toBeNull();
    expect(est.est_cny).toBeNull();
  });
});

describe('walking the series', () => {
  it('a NO_TRADE brain produces judgments, zero trades, and a costed summary', async () => {
    const seen: SeenCall[] = [];
    const { manager, store } = harness(recordingBrain(() => NO_TRADE, seen));
    const run = await manager.runToCompletion(params({ max_judgments: 8 }));
    expect(run.status).toBe('done');
    const s = run.summary!;
    expect(s.judgments).toBe(8);
    expect(s.trades).toBe(0);
    expect(s.sum_r).toBe(0);
    expect(s.win_rate).toBeNull();
    expect(s.actions['NO_TRADE']).toBe(8);
    expect(s.capped).toBe(true);
    expect(s.cost.input_tokens).toBe(8 * 1600);
    expect(s.cost.cny).toBeGreaterThan(0);
    // missed_move is only meaningful when the agent stood aside — it did, 8 times.
    expect(s.missed_move?.samples).toBe(8);
    // steps landed in sqlite and read back with their blind boundary
    const steps = store.backtestSteps(run.id);
    expect(steps).toHaveLength(8);
    for (const st of steps) {
      expect(st.action).toBe('NO_TRADE');
      expect(st.visible_upto_ms).toBe(st.at_ms);
      expect(st.kind).toBe('scan');
    }
  });

  it('NO FUTURE DATA: no context ever contains a bar that closes after the judgment', async () => {
    const seen: SeenCall[] = [];
    const { manager, store } = harness(recordingBrain(() => NO_TRADE, seen));
    const run = await manager.runToCompletion(params({ max_judgments: 6 }));
    const steps = store.backtestSteps(run.id);
    expect(steps.length).toBeGreaterThan(0);
    expect(seen.length).toBe(steps.length);
    for (const [i, call] of seen.entries()) {
      const boundary = steps[i]!.at_ms;
      // the "最近 4 根" evidence line prints real bar open times: none may open at/after the boundary's bar close
      const times = barTimesInContext(call.user);
      expect(times.length).toBeGreaterThan(0);
      for (const t of times) expect(t + TF_MS - 1).toBeLessThanOrEqual(boundary);
      // and the price the model is shown is the close of the boundary bar, not a later one
      const bar = SERIES['15m']!.find((k) => k.close_time === boundary)!;
      expect(call.user).toContain(`mark ${bar.close}`);
      const later = SERIES['15m']!.find((k) => k.open_time > boundary)!;
      expect(call.user).not.toContain(`O${Number(later.open).toFixed(0)} H${Number(later.high).toFixed(0)}`);
    }
  });

  it('a PROPOSE brain opens exactly one simulated trade, fills it at the next open and scores it in R', async () => {
    const seen: SeenCall[] = [];
    // first call proposes, everything after holds → the trade is resolved by stop/tp, not by a review
    const { manager, store } = harness(recordingBrain((user, n) => (n === 0 ? proposeLong(user) : HOLD), seen));
    const run = await manager.runToCompletion(params({ max_judgments: 10, review_every_close: true }));
    expect(run.status).toBe('done');
    const s = run.summary!;
    expect(s.trades).toBe(1);
    const trade = s.trade_rows[0]!;
    expect(trade.direction).toBe('long');
    expect(trade.entry).toBe('market');

    // the fill is the OPEN of the bar after the proposal — the core no-lookahead rule
    const steps = store.backtestSteps(run.id);
    const proposalStep = steps.find((st) => st.action === 'PROPOSE')!;
    const proposalBarIdx = SERIES['15m']!.findIndex((k) => k.close_time === proposalStep.at_ms);
    const nextBar = SERIES['15m']![proposalBarIdx + 1]!;
    expect(trade.fill_price).toBeCloseTo(Number(nextBar.open), 6);

    // R is signed P&L over the initial stop distance, and the exit is consistent with the status
    expect(trade.r).not.toBeNull();
    const dist = trade.fill_price! - trade.stop;
    expect(dist).toBeGreaterThan(0);
    expect(trade.r!).toBeCloseTo((trade.exit_price! - trade.fill_price!) / dist, 6);
    if (trade.status === 'stop') expect(trade.r!).toBeLessThanOrEqual(0.001);
    if (trade.status === 'tp') expect(trade.r!).toBeGreaterThan(0.5);
    expect(trade.mae_r!).toBeLessThanOrEqual(0);
    expect(trade.mfe_r!).toBeGreaterThanOrEqual(0);
    expect(s.sum_r).toBeCloseTo(trade.r!, 6);
    expect(s.wins + s.losses + s.flat).toBe(1);
    expect(s.max_drawdown_r).toBeGreaterThanOrEqual(0);

    // once a thread is open the episodes are reviews, and the review context carries the thread
    const reviews = steps.filter((st) => st.kind === 'review');
    expect(reviews.length).toBeGreaterThan(0);
    expect(seen.some((c) => c.user.includes('## 复查的线程'))).toBe(true);
  });

  it('a review that says EXIT closes the trade at that bar close', async () => {
    const seen: SeenCall[] = [];
    const EXIT = JSON.stringify({
      action: 'EXIT', direction: null, confidence: 0.6, headline: '桩:离场', thesis: '测试离场',
      reasons: ['测试 [E1]'], evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [], proposal: null,
    });
    const { manager, store } = harness(recordingBrain((user, n) => (n === 0 ? proposeLong(user) : n === 1 ? HOLD : EXIT), seen));
    const run = await manager.runToCompletion(params({ max_judgments: 6, review_every_close: true }));
    const s = run.summary!;
    expect(s.trades).toBe(1);
    const trade = s.trade_rows[0]!;
    // it may have been stopped out before the third call; if it survived, the EXIT must be what closed it
    if (trade.status === 'review_exit') {
      const steps = store.backtestSteps(run.id);
      const exitStep = steps.find((st) => st.action === 'EXIT')!;
      const bar = SERIES['15m']!.find((k) => k.close_time === exitStep.at_ms)!;
      expect(trade.exit_price).toBeCloseTo(Number(bar.close), 6);
      expect(trade.exit_at).toBe(exitStep.at_ms);
    } else {
      expect(['stop', 'tp']).toContain(trade.status);
    }
  });

  it('gates still apply: a stop 20% away is rejected and no trade is opened', async () => {
    const wideStop = (user: string): string => {
      const m = /mark (\d+(?:\.\d+)?)/.exec(user);
      const mark = m ? Number(m[1]) : 0;
      return JSON.stringify({
        action: 'PROPOSE', direction: 'long', confidence: 0.7, headline: '桩:止损太远', thesis: '测试闸',
        reasons: ['测试 [E1]'], evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [],
        proposal: { direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: (mark * 0.8).toFixed(2), take_profits: [(mark * 1.2).toFixed(2)], rationale: '测试' },
      });
    };
    const { manager, store } = harness(recordingBrain((user) => wideStop(user), []));
    const run = await manager.runToCompletion(params({ max_judgments: 3 }));
    expect(run.summary!.trades).toBe(0);
    const step = store.backtestSteps(run.id)[0]!;
    expect(step.outcome?.kind).toBe('blocked');
    expect(step.gates.some((g) => g.name === '止损距离' && !g.passed)).toBe(true);
  });

  it('a brain that never satisfies the contract fails closed to NO_TRADE after one repair round', async () => {
    const seen: SeenCall[] = [];
    const { manager, store } = harness(recordingBrain(() => 'not json at all', seen));
    const run = await manager.runToCompletion(params({ max_judgments: 2 }));
    expect(run.status).toBe('done');
    expect(run.summary!.actions['NO_TRADE']).toBe(2);
    expect(seen).toHaveLength(4); // two judgments × (first attempt + repair)
    expect(store.backtestSteps(run.id)[0]!.error).toBeTruthy();
  });

  it('emits backtest.changed / backtest.progress and records the run row', async () => {
    const { manager, events, store } = harness(recordingBrain(() => NO_TRADE, []));
    const run = await manager.runToCompletion(params({ max_judgments: 3 }));
    const progress = events.filter((e) => e.event === 'backtest.progress');
    expect(progress).toHaveLength(3);
    expect((progress[0]!.data as { run_id: string; last_action: string }).run_id).toBe(run.id);
    expect((progress[2]!.data as { done: number }).done).toBe(3);
    expect(events.filter((e) => e.event === 'backtest.changed').length).toBeGreaterThanOrEqual(3); // queued → running → done
    const listed = store.backtestRuns(10);
    expect(listed[0]!.id).toBe(run.id);
    expect(listed[0]!.status).toBe('done');
    expect(listed[0]!.prompt_version).toBeTruthy();
  });
});

describe('cancellation', () => {
  it('cancel() between steps stops the walk and marks the run cancelled', async () => {
    let manager: InstanceType<BacktestModule['BacktestManager']> | null = null;
    let runId = '';
    const brain: Brain = {
      name: 'pi:zai/glm-5.3',
      async complete() {
        if (manager && runId) manager.cancel(runId); // cancel from inside the first judgment
        return { text: NO_TRADE, latency_ms: 1, model: 'pi:zai/glm-5.3', input_tokens: 10, output_tokens: 5 };
      },
    };
    const h = harness(brain);
    manager = h.manager;
    const started = h.manager.start(params({ max_judgments: 50 }));
    runId = started.run.id;
    const done = await (async () => {
      for (let i = 0; i < 2000 && h.manager.isRunning(); i++) await new Promise((r) => setTimeout(r, 5));
      return h.store.backtestRun(runId)!;
    })();
    expect(done.status).toBe('cancelled');
    expect(done.summary!.judgments).toBeLessThan(50);
  });

  it('a second run is refused while one is in flight', async () => {
    const { manager } = harness(recordingBrain(() => NO_TRADE, []));
    const first = manager.start(params({ max_judgments: 4 }));
    expect(first.error).toBeNull();
    const second = manager.start(params({ max_judgments: 4 }));
    expect(second.error).toContain('已有回测在跑');
    expect(second.run.status).toBe('failed');
    await manager.runToCompletion(params({ max_judgments: 1 })); // drains the first via the shared promise
  });
});

describe('param validation', () => {
  it('rejects a backwards range and an over-long one', () => {
    const workflow: Workflow = { ...DEFAULT_WORKFLOW, timeframe: TF, updated_at: Date.now() };
    expect(bt.normalizeParams({ symbol: 'BTCUSDT', from: 2, to: 1 }, workflow).errors.join()).toContain('to > from');
    const long = bt.normalizeParams({ symbol: 'BTCUSDT', timeframe: '15m', from: T0 - 400 * 86_400_000, to: T0 }, workflow);
    expect(long.errors.join()).toContain('区间太长');
    const ok = bt.normalizeParams({ symbol: 'btcusdt', timeframe: '15m', from: WALK_FROM, to: WALK_TO, mode: 'every_close', max_judgments: 5000 }, workflow);
    expect(ok.errors).toHaveLength(0);
    expect(ok.params.symbol).toBe('BTCUSDT');
    expect(ok.params.max_judgments).toBe(500); // clamped to the hard limit
    expect(ok.params.mode).toBe('every_close');
  });
});

// ---------------------------------------------------------------- v3.5:按策略跑、按策略拆、跑完归因

describe('strategies in a backtest', () => {
  /** PROPOSE naming a strategy — what the v5 contract requires when the context lists any. */
  function proposeLongWith(user: string, strategyId: string): string {
    return JSON.stringify({ ...JSON.parse(proposeLong(user)), strategy_id: strategyId });
  }

  it('renders only the named strategies, tags steps/trades with strategy_id, and breaks the summary down', async () => {
    const seen: SeenCall[] = [];
    const h = harness(
      recordingBrain((user, n) => {
        if (/## 复查的线程/.test(user)) return HOLD;
        return n % 2 === 0 ? proposeLongWith(user, 'mtf_alignment') : NO_TRADE;
      }, seen),
    );
    const run = await h.manager.runToCompletion(params({ max_judgments: 8, strategy_ids: ['mtf_alignment'] }));
    expect(run.status).toBe('done');

    // 上下文里只有点名的那条,而且旧的 playbook 变成了「补充说明」。
    const scan = seen.find((c) => !/## 复查的线程/.test(c.user))!;
    expect(scan.system).toContain('可用策略:');
    expect(scan.system).toContain('mtf_alignment·多周期对齐');
    expect(scan.system).not.toContain('breakout_retest·');
    expect(scan.system).toContain('补充说明');

    const steps = h.store.backtestSteps(run.id);
    const proposals = steps.filter((s) => s.action === 'PROPOSE');
    expect(proposals.length).toBeGreaterThan(0);
    for (const s of proposals) expect(s.strategy_id).toBe('mtf_alignment');

    const sm = run.summary!;
    expect(sm.strategies).toEqual([{ id: 'mtf_alignment', version: 1, content_hash: expect.any(String), status: 'backtest' }]);
    expect(sm.by_strategy['mtf_alignment']!.proposals).toBe(proposals.length);
    if (sm.trades > 0) {
      expect(sm.trade_rows.every((t) => t.strategy_id === 'mtf_alignment')).toBe(true);
      expect(sm.by_strategy['mtf_alignment']!.trades).toBe(sm.trades);
      expect(sm.by_strategy['unattributed']).toBeUndefined();
    }

    // 成绩回写到策略的 eval_stats(backtest 状态的策略也算,回测就是为它跑的)。
    const spec = h.store.strategies.head('mtf_alignment')!;
    expect(sm.capped).toBe(true);
    expect(spec.eval_stats.backtests).toBe(0); // 截断 run 不写成绩
    expect(spec.eval_stats.last_run_id).toBeNull();
    // 回写的是统计,不是内容:版本与 hash 一个字没变。
    expect(spec.version).toBe(1);
    expect(spec.content_hash).toBe(h.store.strategies.version('mtf_alignment', 1)!.content_hash);
  });

  it('a PROPOSE that names no strategy fails the contract and falls back to NO_TRADE', async () => {
    const seen: SeenCall[] = [];
    const h = harness(recordingBrain((user) => (/## 复查的线程/.test(user) ? HOLD : proposeLong(user)), seen));
    const run = await h.manager.runToCompletion(params({ max_judgments: 4, strategy_ids: ['breakout_retest'] }));
    // 一次修复轮之后仍然没有 strategy_id → fail-closed,零成交。
    expect(run.summary!.trades).toBe(0);
    expect(run.summary!.actions['PROPOSE'] ?? 0).toBe(0);
    expect(seen.some((c) => /strategy_id/.test(c.user))).toBe(true); // 修复轮把错误念回去了
  });

  it('runs with no strategies at all exactly like v4 (recorded eval cases keep working)', async () => {
    const seen: SeenCall[] = [];
    const h = harness(recordingBrain((user) => (/## 复查的线程/.test(user) ? HOLD : proposeLong(user)), seen));
    const run = await h.manager.runToCompletion(params({ max_judgments: 4, strategy_ids: [] }));
    expect(run.status).toBe('done');
    expect(seen[0]!.system).toContain('Playbook(');
    expect(seen[0]!.system).not.toContain('可用策略:');
    expect(run.summary!.strategies).toEqual([]);
  });

  it('attribute:true runs the cheap-brain pass at the end and only proposes', async () => {
    const attrJson = JSON.stringify([
      { title: '止损太紧', strategy_id: 'breakout_retest', symbol: 'BTCUSDT', evidence_said: 'ATR 1.2%', rule_said: '止损 ≥ 0.8 ATR', actual: '连续被扫', proposal: { kind: 'param', strategy_id: 'breakout_retest', param: 'chase_atr_max', value: 1, text: '' } },
    ]);
    // 判断用 PROPOSE,归因那一次调用会拿到不含「## 触发」的 prompt,用它区分。
    const h = harness(
      recordingBrain((user) => {
        if (/问题点位/.test(user) || /## 这次回测/.test(user)) return attrJson;
        if (/## 复查的线程/.test(user)) return HOLD;
        return JSON.stringify({ ...JSON.parse(proposeLong(user)), strategy_id: 'breakout_retest' });
      }, []),
    );
    const run = await h.manager.runToCompletion(params({ max_judgments: 6, strategy_ids: ['breakout_retest'], attribute: true }));
    expect(run.status).toBe('done');
    const points = h.store.attributions(run.id);
    expect(points).toHaveLength(1);
    expect(points[0]!.proposal).toMatchObject({ kind: 'param', param: 'chase_atr_max', value: 1 });
    // 记忆是提案,不是批准;策略参数没变。
    expect(h.store.memory.counts()).toMatchObject({ proposed: 1, active: 0 });
    expect(h.store.strategies.head('breakout_retest')!.params['chase_atr_max']!.value).toBe(1.5);
  });

  it('estimate counts candidates per strategy trigger set without calling the model', async () => {
    const seen: SeenCall[] = [];
    const h = harness(recordingBrain(() => NO_TRADE, seen));
    const est = await bt.estimateBacktest(params({ mode: 'triggers', strategy_ids: ['breakout_retest', 'funding_oi_extreme'] }), h.workflow, 'stub', h.store.strategies);
    expect(seen).toHaveLength(0);
    expect(Object.keys(est.candidates_by_strategy).sort()).toEqual(['breakout_retest', 'funding_oi_extreme']);
    for (const n of Object.values(est.candidates_by_strategy)) {
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(est.candidates);
    }
  });
});

describe('判断回放三腿', () => {
  it('council/mechanical 零大脑调用，写 replay source 并完整结算同一窗口', async () => {
    const seen: SeenCall[] = [];
    const { store, workflow } = harness(recordingBrain(() => { throw new Error('不许调用模型'); }, seen));
    const manager = new bt.BacktestManager({ store, workflow: () => workflow, emit: () => {}, brainFor: () => { throw new Error('零模型腿不许创建大脑'); } });
    const run = await manager.runToCompletion(params({ legs: ['council', 'mechanical'], strategy_ids: ['breakout_retest'], max_judgments: 4 }));
    expect(run.error).toBeNull(); expect(run.status).toBe('done'); expect(seen).toEqual([]);
    expect(run.summary!.cost.cny).toBe(0);
    expect(run.progress.done).toBe(4);
    const rows = store.judgments.list({ limit: 10, source: 'replay' }); expect(rows).toHaveLength(4);
    expect(rows.every(r => r.episode_id.startsWith(`replay:${run.id}:`) && r.outcome_r_model === null && r.settled_at !== null)).toBe(true);
    expect(state!.db.prepare("SELECT count(*) AS n FROM demo_judgment_ledger WHERE source = 'replay'").get()).toMatchObject({ n: 4 });
    expect(rows.every(r => r.horizon_end_at === r.as_of + 24 * TF_MS)).toBe(true);
    const estimate = await bt.estimateBacktest(params({ legs: ['council', 'mechanical'] }), workflow, 'pi:zai/glm-5.3');
    expect(estimate.est_cny).toBe(0);
  });
  it('选择 model 才调用 judgeOnce，三腿同一 ledger 行，未选腿保持 null', async () => {
    const seen: SeenCall[] = [];
    const { manager, store } = harness(recordingBrain(() => NO_TRADE, seen));
    const run = await manager.runToCompletion(params({ legs: ['model', 'mechanical'], max_judgments: 2 }));
    expect(run.error).toBeNull(); expect(seen).toHaveLength(2);
    const rows = store.judgments.list({ limit: 10, source: 'replay' });
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.outcome_r_model === 0 && r.outcome_r_council === null && r.legs.mechanical !== null)).toBe(true);
  });
});
