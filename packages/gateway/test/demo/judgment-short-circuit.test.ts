// 09-23 判断链短路①:持仓复查时持仓动作闸(代码)只允许 HOLD → 不调模型,直接落 HOLD;计入判断次数,不占模型额度。
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { stubBrain } from '../../src/demo/brain.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';
import type { Episode, Judgment } from '../../src/demo/types.js';

let server: FakeMarketServer, DemoRuntime: typeof import('../../src/demo/runtime.js').DemoRuntime;
let rt: InstanceType<typeof DemoRuntime> | null = null, state: StateDb | null = null;
beforeAll(async () => { server = await startFakeMarketServer(77000, 200); process.env.TG_DEMO_MARKET_BASE = server.url; ({ DemoRuntime } = await import('../../src/demo/runtime.js')); });
afterAll(async () => { await server.close(); delete process.env.TG_DEMO_MARKET_BASE; });
afterEach(async () => { if (rt) await rt.stop(); state?.close(); rt = null; state = null; vi.restoreAllMocks(); });

const answer = (action: Judgment['action']): string => JSON.stringify({ action, direction: action === 'NO_TRADE' ? null : 'long', confidence: 0.6, headline: 'stub', thesis: 'stub thesis', reasons: ['fixture [E1]'], evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [], proposal: null });

async function drain() { const start = performance.now(); while (rt!.queueView().pending || rt!.queueView().running) { if (performance.now() - start > 10000) throw Error('runtime did not drain'); await new Promise((r) => setTimeout(r, 10)); } }

/** 主判断调用计数(不含 sizing 顾问等副调用)。 */
async function setup(action: Judgment['action'], cap = 0) {
  state = openStateDb(':memory:');
  const store = new DemoStore(state), backend = new PaperBackend(10000);
  const calls = { main: 0 };
  rt = new DemoRuntime({ store, backend, brains: { stub: stubBrain((system) => { if (!system.includes('Portfolio 仓位顾问')) calls.main++; return answer(action); }) }, marketPollMs: 600000, accountPollMs: 600000 });
  await rt.start();
  rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'], auto_approve: true, daily_judgment_cap: cap });
  return { store, backend, calls };
}

async function seed(store: DemoStore) {
  const { newThread } = await import('../../src/demo/threads.js');
  const t = { ...newThread({ id: 'short-circuit', backend: 'paper', symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '15m', horizon: 'intraday', thesis: 'stable thesis', invalidation_text: '50000', watch_conditions: [], entry: { type: 'market', price: '77050', zone: null }, stop_price: '40000', take_profits: ['100000'], qty: '0.01', margin_usdt: '100', leverage: 1, margin_mode: 'cross', now: Date.now() - 8 * 3600000 }), status: 'in_position' as const, opened_at: Date.now() - 8 * 3600000, filled_avg_price: '77050' };
  store.saveThread(t);
  return t;
}

const reviewEp = (store: DemoStore, threadId: string): Episode & { skipped_model?: boolean } => store.episode(store.episodes(10).find((e) => e.thread_id === threadId)!.id)!;

describe('09-23 判断链短路①:HOLD-only 复查不调模型', () => {
  it('HOLD-only 复查:主脑调用 0 次,决定 HOLD,episode 标 skipped_model,线程照常记账', async () => {
    const { store, backend, calls } = await setup('EXIT');
    const t = await seed(store);
    const close = vi.spyOn(backend, 'closePosition'), reduce = vi.spyOn(backend, 'reducePosition');
    expect(rt!.reviewThread(t.id, { kind: 'manual', detail: 'hold-only' })).toBe(true);
    await drain();
    expect(calls.main).toBe(0);
    const ep = reviewEp(store, t.id);
    expect(ep.status).toBe('done');
    expect(ep.holding_review!.allowed_actions).toEqual(['HOLD']);
    expect(ep.skipped_model).toBe(true);
    expect(ep.model).toBe(DemoRuntime.SKIPPED_MODEL);
    expect(ep.judgment_raw).toBeNull();
    expect(ep.judgment!.action).toBe('HOLD');
    expect(ep.judgment!.headline).toContain('跳过模型');
    expect(ep.usage).toMatchObject({ input_tokens: 0, output_tokens: 0 });
    expect(ep.reducer!.accepted).toBe(true);
    expect(ep.gates).toEqual([expect.objectContaining({ name: '持仓动作闸', passed: true })]);
    expect(ep.decision_record).toBeTruthy();
    expect(close).not.toHaveBeenCalled();
    expect(reduce).not.toHaveBeenCalled();
    const after = store.thread(t.id)!;
    expect(after.status).toBe('in_position');
    expect(after.episode_ids).toContain(ep.id);
    expect(after.last_policy_review?.reason).toBe(ep.holding_review!.reason);
  });

  it('复查允许多个动作(人工核实利空事件)时照常调用主脑', async () => {
    const { store, calls } = await setup('REDUCE');
    const t = await seed(store);
    expect(rt!.setVerifiedEvent(t.id, { adverse_side: 'long', note: '交易所公告下架该合约' }).review_queued).toBe(true);
    await drain();
    expect(calls.main).toBeGreaterThan(0);
    const ep = reviewEp(store, t.id);
    expect(ep.holding_review!.allowed_actions.length).toBeGreaterThan(1);
    expect(ep.skipped_model).toBeUndefined();
    expect(ep.model).not.toBe(DemoRuntime.SKIPPED_MODEL);
    expect(ep.judgment!.action).toBe('REDUCE');
  });

  it('额度:跳过的复查计入判断次数、不占 daily_judgment_cap', async () => {
    const { store, calls } = await setup('NO_TRADE', 1);
    const t = await seed(store);
    expect(rt!.reviewThread(t.id, { kind: 'manual', detail: 'hold-only 1' })).toBe(true);
    await drain();
    expect(calls.main).toBe(0);
    expect(rt!.judgmentsToday()).toBe(1);
    expect(rt!.modelJudgmentsToday()).toBe(0);
    expect(rt!.usageToday()).toMatchObject({ judgments: 1, cap: 1, capped: false });
    // 模型额度还在:第二次 HOLD-only 复查照样能排进来(否则 cap=1 时第一次跳过就把复查全堵死了)。
    expect(rt!.reviewThread(t.id, { kind: 'manual', detail: 'hold-only 2' })).toBe(true);
    await drain();
    expect(rt!.judgmentsToday()).toBe(2);
    expect(rt!.modelJudgmentsToday()).toBe(0);
    expect(calls.main).toBe(0);
    // 真调一次模型(人工核实利空 → 多动作复查)后 cap=1 才算用完。
    rt!.setVerifiedEvent(t.id, { adverse_side: 'long', note: 'material' });
    await drain();
    expect(calls.main).toBeGreaterThan(0);
    expect(rt!.modelJudgmentsToday()).toBe(1);
    expect(rt!.usageToday().capped).toBe(true);
    expect(rt!.reviewThread(t.id, { kind: 'manual', detail: 'after cap' })).toBe(false);
  });
});
