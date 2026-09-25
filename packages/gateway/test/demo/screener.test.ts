// Radar 筛选器的接线(radar.ts + bots.ts + routes-screener/bots):角色边界、数字守卫、提案只改 watchlist、
// 暂停语义、bot_runs / handoff 记账、路由形状。runScreen 用假实现注入 —— 全程不打网络、不调模型。
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { DemoRuntime } from '../../src/demo/runtime.js';
import { createServer } from '../../src/demo/http.js';
import { stubBrain } from '../../src/demo/brain.js';
import { assertRoleBoundaries, validateRoleBoundaries, laneFor } from '../../src/demo/bots.js';
import { guardBrainLines, nextScreenAt, proposalPatch, HORIZON_SPECS, type OpportunityCard, type RunScreenDeps, type RunScreenResult, type ScreenHorizon, type WatchCandidate } from '../../src/demo/screener.js';
import { RECHECK_MS, WEEKLY_EVERY_MS } from '../../src/demo/radar.js';
import { presenceFor } from '../../src/demo/routes-bots.js';

// ------------------------------------------------------------ 纯函数

describe('role boundaries', () => {
  it('exactly executor may hold exchange.write; anyone else → boot assertion throws', () => {
    const ok = [
      { role: 'executor' as const, kind: 'protected_service', capabilities: ['exchange.write'] },
      { role: 'radar' as const, kind: 'llm_recipe', capabilities: ['market.read'] },
    ];
    expect(validateRoleBoundaries(ok)).toEqual([]);
    const bad = [...ok, { role: 'gate_captain' as const, kind: 'llm_session', capabilities: ['exchange.write'] }];
    expect(validateRoleBoundaries(bad).length).toBeGreaterThan(0);
    expect(() => assertRoleBoundaries(bad)).toThrow(/exchange\.write/);
    // 没有 executor 也不行:写者必须**恰好**是它。
    expect(validateRoleBoundaries([ok[1]!]).length).toBeGreaterThan(0);
  });
  it('lanes: judgment per symbol, execution per account', () => {
    expect(laneFor('trigger.hit', { symbol: 'BTCUSDT' })).toBe('judgment:BTCUSDT');
    expect(laneFor('execution.submitted', { account_id: 'a1' })).toBe('execution:a1');
  });
});

describe('guardBrainLines', () => {
  const known = new Map([['BTCUSDT', new Set(['breakout_retest'])], ['ETHUSDT', new Set(['mtf_alignment'])]]);
  const cardsText = 'BTCUSDT breakout_retest fit 0.75 ATR% 0.31 level 79304.9\nETHUSDT mtf_alignment fit 0.5';
  it('drops a line whose ≥3-digit number is not in the cards, keeps the rest', () => {
    const { kept, dropped } = guardBrainLines(
      [
        { symbol: 'BTCUSDT', strategy_id: 'breakout_retest', why: '接近 79304.9 突破位' },
        { symbol: 'ETHUSDT', strategy_id: 'mtf_alignment', why: '止损放 2243 下方' },
        { symbol: 'SOLUSDT', strategy_id: 'mtf_alignment', why: '不在卡里' },
        { symbol: 'BTCUSDT', strategy_id: 'nope', why: '策略不存在' },
      ],
      cardsText,
      known,
    );
    expect(kept.map((k) => k.symbol)).toEqual(['BTCUSDT']);
    expect(dropped.map((d) => d.reason)).toEqual([expect.stringContaining('2243'), expect.stringContaining('SOLUSDT'), expect.stringContaining('nope')]);
  });
});

describe('proposalPatch / nextScreenAt', () => {
  it('only ever produces watchlist, capped by max (and by 8)', () => {
    const p = { symbols: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'], active_strategies: {}, k: 10, note: '' };
    expect(Object.keys(proposalPatch(p, 3))).toEqual(['watchlist']);
    expect(proposalPatch(p, 3).watchlist).toEqual(['A', 'B', 'C']);
    expect(proposalPatch(p, 50).watchlist).toHaveLength(10);
    expect(proposalPatch(p, 30).watchlist).toHaveLength(10);
    expect(proposalPatch(p, 30, ['B', 'ZZ', 'KEEP'], ['KEEP']).watchlist).toEqual(['B', 'KEEP']);
  });
  it('never run → due now; otherwise last + cadence', () => {
    expect(nextScreenAt(0, 1000, 5000)).toBe(5000);
    expect(nextScreenAt(4000, 1000, 5000)).toBe(5000);
    expect(WEEKLY_EVERY_MS).toBe(7 * 86_400_000);
    expect(RECHECK_MS).toBeLessThan(HORIZON_SPECS.short.ttl_ms);
  });
});

// ------------------------------------------------------------ Radar 编排(假 runScreen)

function fakeCard(symbol: string, fit: number, horizon: ScreenHorizon): OpportunityCard {
  return {
    symbol,
    horizon,
    timeframe: HORIZON_SPECS[horizon].timeframe,
    confirm_timeframe: HORIZON_SPECS[horizon].confirm_timeframe,
    as_of: 1,
    bars: 100,
    last_close: 100,
    trend: { base_dir: 'long', confirm_dir: 'long', agree: 'long', adx_base: 25, adx_confirm: 22, note: '' },
    atr_pct: 0.3,
    atr_pct_rank_90: 0.5,
    bb_width_rank_90: 0.2,
    squeeze_on: true,
    squeeze_bars: 6,
    breakout: { level_long: 101, level_short: 99, dist_long_atr: 0.5, dist_short_atr: 2, bars_since_up: 3, bars_since_down: 30, vol_ratio: 1.2 },
    funding: { rate_pct: 0.01, z_30d: 0.2, samples: 90 },
    reversion: null,
    daily_regime: 'bull',
    volume: { quote_24h: 1e9, rank: 1, of: 1 },
    strategies: [{ strategy_id: 'breakout_retest', name: '突破回踩', version: 1, status: 'paper', fit_score: fit, passed: 3, near: 0, total: 4, direction: 'long', conditions: [], reasons: [], expectancy: null, expectancy_note: null }],
    best: { strategy_id: 'breakout_retest', fit_score: fit },
    note: null,
  };
}

interface FakeScreen {
  calls: { horizon: ScreenHorizon; brain: boolean; deps: RunScreenDeps }[];
  fail: boolean;
  symbols: string[];
  impl: (horizon: ScreenHorizon, deps: RunScreenDeps) => Promise<RunScreenResult>;
}

function fakeRunScreen(symbols = ['SOLUSDT', 'BTCUSDT', 'ETHUSDT']): FakeScreen {
  const f: FakeScreen = {
    calls: [],
    fail: false,
    symbols,
    impl: async (horizon, deps) => {
      f.calls.push({ horizon, brain: deps.brain !== null, deps });
      if (f.fail) throw new Error('假网络故障');
      const now = deps.now ?? Date.now();
      const id = `scr-test-${horizon}-${f.calls.length}`;
      const cards = f.symbols.map((s, i) => fakeCard(s, 0.9 - i * 0.1, horizon));
      deps.onProgress?.(f.symbols[0]!, 1, f.symbols.length);
      const candidates: WatchCandidate[] = cards.map((c, i) => ({ screen_id: id, horizon, symbol: c.symbol, strategy_id: 'breakout_retest', fit_score: c.best!.fit_score, rank: i + 1, reasons: ['契合 0.9'], card: c, ttl_at: now + HORIZON_SPECS[horizon].ttl_ms, created_at: now }));
      const k = Math.max(1, deps.workflow.watchlist_max ?? 60);
      const proposal = { symbols: candidates.slice(0, k).map((c) => c.symbol), active_strategies: {}, k, note: '测试提案' };
      return {
        screen: { id, horizon, started_at: now, finished_at: now + 10, status: 'done', universe: deps.workflow.screener_universe, symbols: f.symbols, errors: [], run_id: null, handoff_id: null, proposal, brain: deps.brain ? { used: true, model: 'stub', cost_cny: 0.004, error: null, ranked: [], dropped_lines: 0 } : null, cost_cny: deps.brain ? 0.004 : 0, error: null },
        cards,
        candidates,
        proposal,
        brain: null,
      };
    },
  };
  return f;
}

let activeRt: DemoRuntime | null = null;
let activeState: StateDb | null = null;
let activeHttp: http.Server | null = null;

async function mkRuntime(fake: FakeScreen, start = false): Promise<{ rt: DemoRuntime; store: DemoStore }> {
  const state = openStateDb(':memory:');
  const store = new DemoStore(state);
  const brain = stubBrain(() => '{}');
  const rt = new DemoRuntime({ store, backend: new PaperBackend(10_000), brains: { stub: brain }, marketPollMs: 600_000, accountPollMs: 600_000, radar: { runScreen: fake.impl } });
  if (start) await rt.start();
  rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'], timeframe: '15m', paused: false });
  activeRt = rt;
  activeState = state;
  return { rt, store };
}

afterEach(async () => {
  if (activeHttp) {
    activeHttp.closeAllConnections?.();
    await new Promise<void>((r) => activeHttp!.close(() => r()));
  }
  if (activeRt) await activeRt.stop();
  activeState?.close();
  activeRt = null;
  activeState = null;
  activeHttp = null;
});

describe('Radar', () => {
  it('seeds the 9 roles on store construction with radar/thread_manager/executor enabled and executor the only writer', async () => {
    const { store } = await mkRuntime(fakeRunScreen());
    const bots = store.bots.profiles();
    expect(bots).toHaveLength(9);
    expect(bots.filter((b) => b.enabled).map((b) => b.role).sort()).toEqual(['asp_agent', 'executor', 'gate_captain', 'portfolio_manager', 'radar', 'reviewer', 'risk_sentinel', 'strategy_lab', 'thread_manager']);
    expect(bots.filter((b) => b.capabilities.includes('exchange.write')).map((b) => b.role)).toEqual(['executor']);
  });

  it('a run books a bot_run, writes the screen + candidates, hands off to gate_captain, and emits activity', async () => {
    const fake = fakeRunScreen();
    const { rt, store } = await mkRuntime(fake);
    const events: string[] = [];
    rt.on('screener.changed', (d: { status: string }) => events.push(`screener:${d.status}`));
    rt.on('bots.changed', () => events.push('bots'));
    const screen = await rt.radar.run('short', 'manual');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.brain).toBe(true);
    expect(screen.status).toBe('done');
    expect(store.screens.latest('short')?.id).toBe(screen.id);
    expect(store.screens.candidates(screen.id).map((c) => c.symbol)).toEqual(['SOLUSDT', 'BTCUSDT', 'ETHUSDT']);
    const runs = store.bots.runs({ role: 'radar' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ routine: 'screen:short', status: 'done', cost_cny: 0.004 });
    const handoffs = store.bots.handoffs({ status: 'pending', to_role: 'gate_captain' });
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]).toMatchObject({ from_role: 'radar', kind: 'result', subject: { type: 'screen', id: screen.id } });
    expect(handoffs[0]!.payload?.['proposal']).toMatchObject({ symbols: ['SOLUSDT', 'BTCUSDT', 'ETHUSDT'] });
    expect(screen.handoff_id).toBe(handoffs[0]!.handoff_id);
    expect(events).toContain('screener:running');
    expect(events).toContain('screener:done');
    expect(store.activity(10).some((a) => a.kind === 'screen_done')).toBe(true);
    // 同一提案重跑不会重复交接(幂等键)。
    expect(store.bots.handoff({ ...handoffs[0]!, handoff_id: 'hof-dup' }).handoff_id).toBe(handoffs[0]!.handoff_id);
  });

  it('paused: manual run still works but without a brain; timer path is skipped and booked as skipped', async () => {
    const fake = fakeRunScreen();
    const { rt, store } = await mkRuntime(fake);
    rt.setWorkflow({ paused: true });
    await rt.radar.run('swing', 'manual');
    expect(fake.calls[0]!.brain).toBe(false);
    expect(store.screens.latest('swing')?.cost_cny).toBe(0);
    // 定时路径(私有 onTimer)在暂停时不跑筛选,只记一条 skipped。
    await (rt.radar as unknown as { onTimer: (h: ScreenHorizon) => Promise<void> }).onTimer('weekly');
    expect(fake.calls.map((c) => c.horizon)).toEqual(['swing']);
    const skipped = store.bots.runs({ role: 'radar', routine: 'screen:weekly' });
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ status: 'skipped' });
  });

  it('concurrent runs of one horizon share a promise; different horizons run independently', async () => {
    const fake = fakeRunScreen();
    const { rt } = await mkRuntime(fake);
    const [a, b, c] = await Promise.all([rt.radar.run('short', 'manual'), rt.radar.run('short', 'manual'), rt.radar.run('swing', 'manual')]);
    expect(a.id).toBe(b.id);
    expect(c.id).not.toBe(a.id);
    expect(fake.calls).toHaveLength(2);
  });

  it('apply changes only watchlist (capped by watchlist_max), acks the handoff, leaves risk fields alone', async () => {
    // watchlist_max 可调 1–300;这里压到 8 验证截断:十个候选只能落八个。
    const ten = ['SOLUSDT', 'BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT', 'TRXUSDT'];
    const fake = fakeRunScreen(ten);
    const { rt, store } = await mkRuntime(fake);
    expect(rt.setWorkflow({ watchlist_max: 999 }).errors[0]).toMatch(/1–300/);
    expect(rt.setWorkflow({ watchlist_max: 8 }).errors).toEqual([]);
    const before = { ...rt.workflow };
    const screen = await rt.radar.run('short', 'manual');
    const r = rt.radar.apply(screen.id, 'user');
    expect(r.before).toEqual(['BTCUSDT']);
    expect(r.after).toEqual(ten.slice(0, 8));
    expect(rt.workflow.watchlist).toEqual(ten.slice(0, 8));
    for (const k of Object.keys(before) as (keyof typeof before)[]) {
      if (k === 'watchlist' || k === 'updated_at') continue;
      expect(rt.workflow[k]).toEqual(before[k]);
    }
    expect(store.bots.handoffById(screen.handoff_id!)?.status).toBe('acked');
    expect(() => rt.radar.apply('scr-nope', 'user')).toThrow(/没有筛选/);
  });

  it('apply with a user pick keeps only proposal/current symbols, in the picked order', async () => {
    const fake = fakeRunScreen(['SOLUSDT', 'ETHUSDT', 'XRPUSDT']);
    const { rt } = await mkRuntime(fake);
    const screen = await rt.radar.run('short', 'manual');
    // 保留原名单 BTC、只要提案里的 SOL、去掉 ETH/XRP;LINK 不在提案也不在名单 → 丢掉
    const r = rt.radar.apply(screen.id, 'user', ['BTCUSDT', 'SOLUSDT', 'LINKUSDT']);
    expect(r.after).toEqual(['BTCUSDT', 'SOLUSDT']);
    expect(rt.workflow.watchlist).toEqual(['BTCUSDT', 'SOLUSDT']);
  });

  it('screener_apply=auto applies right after the run', async () => {
    const fake = fakeRunScreen(['SOLUSDT']);
    const { rt } = await mkRuntime(fake);
    rt.setWorkflow({ screener_apply: 'auto' });
    await rt.radar.run('short', 'manual');
    expect(rt.workflow.watchlist).toEqual(['SOLUSDT']);
  });

  it('a failing screen is booked as failed on both the screen and the bot_run, with a screen_failed activity', async () => {
    const fake = fakeRunScreen();
    fake.fail = true;
    const { rt, store } = await mkRuntime(fake);
    await expect(rt.radar.run('short', 'manual')).rejects.toThrow(/假网络故障/);
    expect(store.screens.latest('short')).toBeNull(); // latest = 上次**成功**的
    expect(store.screens.screens({ horizon: 'short', limit: 1 })[0]?.status).toBe('failed');
    expect(store.bots.runs({ role: 'radar' })[0]).toMatchObject({ status: 'failed', error: '假网络故障' });
    expect(store.activity(10).some((a) => a.kind === 'screen_failed')).toBe(true);
    // 失败不算「上次成功」,下一次仍然是「现在就该跑」。
    expect(rt.radar.lastAt('short')).toBeNull();
  });

  it('schedule: cadence from workflow, weekly fixed, next_at = last + every, disabled → null', async () => {
    const fake = fakeRunScreen();
    const { rt } = await mkRuntime(fake);
    rt.setWorkflow({ screener_short_every_ms: 6 * 3_600_000 });
    const screen = await rt.radar.run('short', 'manual');
    const s = rt.radar.schedule();
    const short = s.find((x) => x.horizon === 'short')!;
    expect(short.every_ms).toBe(6 * 3_600_000);
    expect(short.last_at).toBe(screen.finished_at);
    expect(short.next_at).toBe(screen.finished_at! + 6 * 3_600_000);
    expect(s.find((x) => x.horizon === 'weekly')!.every_ms).toBe(WEEKLY_EVERY_MS);
    rt.setWorkflow({ screener_enabled: false });
    expect(rt.radar.schedule().every((x) => x.next_at === null && !x.enabled)).toBe(true);
  });

  it('presence is derived from runtime state, never stored', async () => {
    const fake = fakeRunScreen();
    const { rt } = await mkRuntime(fake);
    expect(presenceFor('strategy_lab', rt, false).state).toBe('off');
    expect(presenceFor('radar', rt, true).state).toBe('idle');
    rt.setWorkflow({ paused: true });
    expect(presenceFor('radar', rt, true).state).toBe('waiting');
    rt.setWorkflow({ paused: false });
    await rt.radar.run('short', 'manual');
    expect(presenceFor('gate_captain', rt, true)).toMatchObject({ state: 'waiting', action: '1 条交接待阅' });
  });
});

// ------------------------------------------------------------ 路由

describe('routes', () => {
  async function serve(fake: FakeScreen): Promise<(method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>> {
    const { rt, store } = await mkRuntime(fake, true);
    const server = createServer(rt, store);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    activeHttp = server;
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return async (method, path, body) => {
      const res = await fetch(`${base}${path}`, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    };
  }

  it('GET /api/bots has 9 roles with presence, runs, handoffs; ack works', async () => {
    const fake = fakeRunScreen();
    const api = await serve(fake);
    const before = await api('GET', '/api/bots');
    expect(before.status).toBe(200);
    expect(before.json.bots).toHaveLength(9);
    expect(before.json.bots.find((b: { role: string }) => b.role === 'radar').presence.state).toBe('idle');
    await activeRt!.radar.run('short', 'manual');
    const after = await api('GET', '/api/bots');
    expect(after.json.runs).toHaveLength(1);
    expect(after.json.handoffs).toHaveLength(1);
    expect(after.json.handoffs[0].payload.proposal.symbols).toEqual(['SOLUSDT', 'BTCUSDT', 'ETHUSDT']);
    const id = after.json.handoffs[0].handoff_id;
    expect((await api('GET', '/api/bots/handoffs?status=pending')).json.handoffs).toHaveLength(1);
    expect((await api('POST', `/api/bots/handoffs/${id}/ack`)).json.handoff.status).toBe('acked');
    expect((await api('GET', '/api/bots/handoffs?status=pending')).json.handoffs).toHaveLength(0);
    expect((await api('GET', '/api/bots/handoffs?status=weird')).status).toBe(400);
  });

  it('screener routes: latest empty → run 202 → latest filled → history → detail → apply 200 → 409s', async () => {
    const fake = fakeRunScreen();
    const api = await serve(fake);
    const empty = await api('GET', '/api/screener/latest?horizon=short');
    expect(empty.status).toBe(200);
    expect(empty.json.screen).toBeNull();
    expect(empty.json.schedule).toHaveLength(3);
    expect(empty.json.horizons.map((h: { id: string }) => h.id)).toEqual(['short', 'swing', 'weekly']);
    expect((await api('GET', '/api/screener/latest?horizon=nope')).status).toBe(400);

    const run = await api('POST', '/api/screener/run', { horizon: 'short' });
    expect(run.status).toBe(202);
    // 假实现是同步完成的,等一个 tick。
    await new Promise((r) => setTimeout(r, 20));
    const latest = await api('GET', '/api/screener/latest?horizon=short');
    expect(latest.json.screen.status).toBe('done');
    expect(latest.json.candidates).toHaveLength(3);
    expect(latest.json.watchlist).toEqual(['BTCUSDT']);
    const id = latest.json.screen.id;
    expect((await api('GET', '/api/screener/history?horizon=short')).json.screens.map((s: { id: string }) => s.id)).toEqual([id]);
    expect((await api('GET', `/api/screener/${id}`)).json.candidates).toHaveLength(3);
    expect((await api('GET', '/api/screener/scr-nope')).status).toBe(404);

    const applied = await api('POST', `/api/screener/${id}/apply`);
    expect(applied.status).toBe(200);
    expect(applied.json.after).toEqual(['SOLUSDT', 'BTCUSDT', 'ETHUSDT']);
    expect(activeRt!.workflow.watchlist).toEqual(['SOLUSDT', 'BTCUSDT', 'ETHUSDT']);
    expect((await api('POST', '/api/screener/scr-nope/apply')).status).toBe(409);
  });
});
