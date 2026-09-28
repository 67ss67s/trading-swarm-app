import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend, type OrderStatusView } from '../../src/demo/execution.js';
import { AgentMcpBackend } from '../../src/demo/execution-agent.js';
import { DemoRuntime } from '../../src/demo/runtime.js';
import { newThread } from '../../src/demo/threads.js';
import { buildHoldingPlan, evaluateHoldingReview } from '../../src/demo/holding-policy.js';
import { stubBrain } from '../../src/demo/brain.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';
import type { TfFeatures } from '../../src/demo/market.js';

let state: StateDb | null;
afterEach(() => { try { state?.close(); } catch { /* already closed */ } state = undefined as unknown as StateDb; vi.restoreAllMocks(); });
async function setup() {
  state = openStateDb(':memory:');
  const store = new DemoStore(state), backend = new PaperBackend(10000);
  const rt = new DemoRuntime({ store, backend, brains: {} });
  backend.tick('BTCUSDT', '100');
  const t = newThread({ id: 'cancel-race', backend: 'paper', symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '1h', horizon: 'intraday', thesis: 'retest', invalidation_text: '80', watch_conditions: [], entry: { type: 'limit', price: '90', zone: null }, stop_price: '70', take_profits: ['150'], qty: '1', margin_usdt: '90', leverage: 1, margin_mode: 'cross', now: Date.now() - 10000 });
  t.holding_plan = buildHoldingPlan({ thread: t, features: [{ tf: '1h', atr14: 5 } as TfFeatures], now: t.created_at })!;
  expect(t.holding_plan).not.toBeNull();
  t.entry_client_order_id = 'owned-entry';
  t.entry_submitted_at = Date.now() - 5000;
  store.saveThread(t);
  store.saveIntent({ id: 'open-intent', episode_id: '', thread_id: t.id, principal: 'agent', at: t.created_at, kind: 'open', symbol: t.symbol, direction: t.side, quantity: t.qty, entry: 'limit', limit_price: '90', stop_price: '70', take_profit_price: '150', sizing: { equity: '10000', risk_pct: '1', risk_usdt: '100', stop_distance: '20', raw_qty: '1', step_size: '0.01', note: 'fixture' }, status: 'unknown', client_order_id: t.entry_client_order_id, backend: 'paper', receipts: [], error: null });
  await backend.placeEntry({ symbol: t.symbol, direction: t.side, qty: t.qty, entry: 'limit', limit_price: '90', client_order_id: t.entry_client_order_id });
  return { rt, store, backend, t };
}
const order = (status: string, executed_qty: string): OrderStatusView => ({ status, executed_qty, avg_price: executed_qty === '0' ? null : '90', raw: null });

describe('cancel entry facts, real holding plan and persisted intent', () => {
  it('paper zero-fill cancellation returns the daily slot exactly once', async () => {
    const { rt, store, backend, t } = await setup();
    const query = vi.spyOn(backend, 'getOrder');
    expect(store.threadOpensSince(0)).toBe(1);
    expect((await rt.closeThread(t.id)).status).toBe('canceled');
    expect(query).toHaveBeenCalledWith('BTCUSDT', 'owned-entry', true, 'perp');
    expect(store.intent('open-intent')!.status).toBe('failed');
    expect(store.threadOpensSince(0)).toBe(0);
    await expect(rt.closeThread(t.id)).rejects.toThrow('canceled');
    expect(store.threadOpensSince(0)).toBe(0);
  });
  it('stale account read (as_of before the cancel began) withholds the refund until a fresh read proves zero exposure', async () => {
    const { rt, store, backend, t } = await setup();
    vi.spyOn(backend, 'getOrder').mockResolvedValue(order('CANCELED', '0'));
    const staleSnapshot = { ...(await backend.account()), as_of: Date.now() - 100000 };
    const account = vi.spyOn(backend, 'account').mockResolvedValue(staleSnapshot);
    await (rt as any).cancelEntry(t, null, 'stale account read');
    let cur = store.thread(t.id)!;
    expect(cur.status).toBe('pending_entry'); // 账户读比撤单开始还旧,不算零敞口证据,不退
    expect(cur.entry_cancel_pending).toBe(true);
    expect(store.threadOpensSince(0)).toBe(1);
    account.mockRestore(); // 换回真实账户读(as_of = 本次调用的当下,必然比上面持久化的 updated_at 新)
    await (rt as any).cancelEntry(t, null, 'stale account read');
    cur = store.thread(t.id)!;
    expect(cur.status).toBe('canceled');
    expect(store.threadOpensSince(0)).toBe(0); // 新鲜读证明账户无仓,才退回一格
  });
  for (const status of ['CANCELED', 'EXPIRED', 'FILLED', 'PARTIALLY_FILLED']) it(`${status} cumulative fills stay owned and immediately protected`, async () => {
    const { rt, store, backend, t } = await setup();
    vi.spyOn(backend, 'getOrder').mockResolvedValue(order(status, '0.4'));
    const stop = vi.spyOn(backend, 'placeStop');
    const next = await rt.closeThread(t.id);
    expect(next.status).toBe('in_position'); expect(next.qty).toBe('0.4');
    expect(next.holding_plan).toEqual(t.holding_plan);
    expect(stop).toHaveBeenCalledWith('BTCUSDT', 'long', '70', expect.any(String), 'perp');
    expect(store.activity().some(a => a.kind === 'entry_partial_fill')).toBe(true);
    expect(store.threadOpensSince(0)).toBe(1);
    expect(store.intent('open-intent')!.status).toBe(status === 'PARTIALLY_FILLED' ? 'unknown' : 'filled');
  });
  for (const scenario of ['null', 'throw', 'missing_qty', 'NEW', 'transport']) it(`${scenario}: remains unknown, retry can later prove cancellation`, async () => {
    const { rt, store, backend, t } = await setup();
    if (scenario === 'transport') vi.spyOn(backend, 'cancelOrder').mockRejectedValue(new Error('transport interrupted'));
    const query = vi.spyOn(backend, 'getOrder');
    if (scenario === 'throw') query.mockRejectedValue(new Error('query failed'));
    else query.mockResolvedValue(scenario === 'null' || scenario === 'transport' ? null : order(scenario === 'NEW' ? 'NEW' : 'CANCELED', scenario === 'missing_qty' ? '' : '0'));
    expect((await rt.closeThread(t.id)).status).toBe('pending_entry');
    expect(store.intent('open-intent')!.status).toBe('unknown'); expect(store.threadOpensSince(0)).toBe(1);
    query.mockResolvedValue(order('CANCELED', '0'));
    await (rt as any).reconcileThreads(await backend.account());
    expect(store.thread(t.id)!.status).toBe('canceled'); expect(store.threadOpensSince(0)).toBe(0);
  });
  it('cancel unknown can recover a full fill on the existing inspection loop', async () => {
    const { rt, store, backend, t } = await setup();
    const query = vi.spyOn(backend, 'getOrder').mockResolvedValue(null);
    await rt.closeThread(t.id);
    query.mockResolvedValue(order('FILLED', '1'));
    const stop = vi.spyOn(backend, 'placeStop');
    await (rt as any).reconcileThreads(await backend.account());
    expect(store.thread(t.id)!.status).toBe('in_position'); expect(stop).toHaveBeenCalled();
    expect(store.intent('open-intent')!.status).toBe('filled');
  });
  it('zero terminal plus a conflicting position is not zero-exposure proof', async () => {
    const { rt, store, backend, t } = await setup();
    await backend.placeEntry({ symbol: t.symbol, direction: t.side, qty: '0.3', entry: 'market', limit_price: null, client_order_id: 'foreign' });
    expect((await rt.closeThread(t.id)).status).toBe('pending_entry');
    expect(store.intent('open-intent')!.status).toBe('unknown');
  });
  // codex-review #7:`swap close` 已经发出去了、20 秒没回来 —— 这是未知,不是失败。
  // 把意图写成 failed 等于宣称「没平掉」,而仓位可能已经平了。
  for (const [label, extra, want] of [['ambiguous', { ambiguous: true }, 'unknown'], ['definite', {}, 'failed']] as const) {
    it(`close ${label} transport error → intent ${want}`, async () => {
      const { rt, store, backend, t } = await setup();
      vi.spyOn(backend, 'getOrder').mockResolvedValue(order('FILLED', '1'));
      const cur = store.thread(t.id)!;
      store.saveThread({ ...cur, status: 'in_position', qty: '1', entry_cancel_pending: false, version: cur.version + 1 });
      const base = await backend.account();
      vi.spyOn(backend, 'account').mockResolvedValue({ ...base, positions: [{ symbol: 'BTCUSDT', side: 'long', qty: '1', entry_price: '90', mark_price: '100', unrealized_pnl: '10', leverage: 1 }] });
      vi.spyOn(backend, 'closePosition').mockResolvedValue({ closed: false, receipt: null, error: 'okx swap close 超时 20000ms', ...extra });
      await rt.closeThread(t.id);
      expect(store.thread(t.id)!.status).toBe('in_position'); // 线程不终结,等巡检按新鲜仓位收敛
      const closeIntent = store.intents(50).find((i) => i.kind === 'close')!;
      expect(closeIntent.status).toBe(want);
    });
  }
  it('a concurrent thread update is never overwritten by the cancel response', async () => {
    const { rt, store, backend, t } = await setup();
    vi.spyOn(backend, 'getOrder').mockImplementation(async () => {
      const cur = store.thread(t.id)!;
      store.saveThread({ ...cur, status: 'in_position', qty: '0.7', protection_client_order_ids: ['concurrent-stop'], version: cur.version + 1 });
      return order('CANCELED', '0');
    });
    const next = await rt.closeThread(t.id);
    expect(next.status).toBe('in_position'); expect(next.qty).toBe('0.7'); expect(next.protection_client_order_ids).toEqual(['concurrent-stop']);
  });
  it('definite stop rejection invokes compensation after a proven terminal fill', async () => {
    const { rt, store, backend, t } = await setup();
    vi.spyOn(backend, 'getOrder').mockResolvedValue(order('CANCELED', '0.4'));
    vi.spyOn(backend, 'placeStop').mockResolvedValue({ outcome: 'failed', error: 'rejected', receipt: null, avg_price: null });
    const close = vi.spyOn(backend, 'closePosition').mockResolvedValue({ closed: true, error: null });
    expect((await rt.closeThread(t.id)).status).toBe('closed'); expect(close).toHaveBeenCalled(); expect(store.threadOpensSince(0)).toBe(1);
  });
  it('unknown protection does not lose the still-live entry remainder', async () => {
    const { rt, store, backend, t } = await setup();
    const query = vi.spyOn(backend, 'getOrder').mockImplementation(async (_s, cid) => cid === 'owned-entry' ? order('PARTIALLY_FILLED', '0.4') : null);
    vi.spyOn(backend, 'placeStop').mockResolvedValue({ outcome: 'unknown', error: 'timeout', receipt: null, avg_price: null });
    const next = await rt.closeThread(t.id);
    expect(next.entry_cancel_pending).toBe(true); expect(next.status).toBe('in_position');
    query.mockImplementation(async (_s, cid) => cid === 'owned-entry' ? order('CANCELED', '0.6') : null);
    await (rt as any).reconcileThreads(await backend.account());
    expect(store.thread(t.id)!.qty).toBe('0.6'); expect(store.thread(t.id)!.entry_cancel_pending).toBe(false);
  });
  it('in-flight model cancellation queries only and does not finalize zero quantity', async () => {
    const { rt, store, backend, t } = await setup();
    store.saveThread({ ...t, entry_submitting_since: Date.now() });
    const cancel = vi.spyOn(backend, 'cancelOrder');
    vi.spyOn(backend, 'getOrder').mockResolvedValue(order('CANCELED', '0'));
    await (rt as any).cancelEntry(t, null, 'model invalidate');
    expect(cancel).not.toHaveBeenCalled(); expect(store.thread(t.id)!.status).toBe('pending_entry');
    expect(store.thread(t.id)!.entry_cancel_pending).toBe(true);
  });
  it('known exposure retries protection even when later entry queries fail', async () => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { rt, store, backend, t } = await setup();
    const query = vi.spyOn(backend, 'getOrder').mockImplementation(async (_s, cid) => cid === 'owned-entry' ? order('PARTIALLY_FILLED', '0.4') : null);
    const stop = vi.spyOn(backend, 'placeStop').mockResolvedValue({ outcome: 'unknown', error: 'timeout', receipt: null, avg_price: null });
    await rt.closeThread(t.id); expect(stop).toHaveBeenCalledTimes(1);
    now += 61000; query.mockRejectedValue(new Error('entry unavailable'));
    await (rt as any).reconcileThreads(await backend.account());
    expect(stop).toHaveBeenCalledTimes(2); expect(store.thread(t.id)!.entry_cancel_pending).toBe(true);
  });
  it('compensation with a live remainder preserves inspection and blocks premature manual closure', async () => {
    const { rt, store, backend, t } = await setup();
    vi.spyOn(backend, 'getOrder').mockResolvedValue(order('PARTIALLY_FILLED', '0.4'));
    vi.spyOn(backend, 'placeStop').mockResolvedValue({ outcome: 'failed', error: 'rejected', receipt: null, avg_price: null });
    const close = vi.spyOn(backend, 'closePosition').mockResolvedValue({ closed: true, error: null });
    await rt.closeThread(t.id);
    expect(store.thread(t.id)!.status).toBe('in_position'); expect(store.thread(t.id)!.entry_cancel_pending).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    await rt.closeThread(t.id);
    expect(close).toHaveBeenCalledTimes(1); expect(store.intent('open-intent')!.status).toBe('unknown');
  });
  it('late stop response preserves submit-phase completion and the next inspection can cancel', async () => {
    const { rt, store, backend, t } = await setup();
    store.saveThread({ ...t, entry_submitting_since: Date.now() });
    vi.spyOn(backend, 'getOrder').mockImplementation(async (_s, cid) => cid === 'owned-entry' ? order('PARTIALLY_FILLED', '0.4') : null);
    vi.spyOn(backend, 'placeStop').mockImplementation(async () => {
      const cur = store.thread(t.id)!;
      store.saveThread({ ...cur, entry_submitting_since: null, entry_submitted_at: Date.now(), version: cur.version + 1 });
      return { outcome: 'unknown', error: 'timeout', receipt: null, avg_price: null };
    });
    const cancel = vi.spyOn(backend, 'cancelOrder');
    await (rt as any).cancelEntry(t, null, 'model while submitting');
    expect(store.thread(t.id)!.entry_submitting_since).toBeNull(); expect(cancel).not.toHaveBeenCalled();
    await (rt as any).reconcileThreads(await backend.account()); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('real-plan stale market and legacy missing-plan exceptions fail closed', async () => {
    const { t } = await setup();
    const inp = { thread: t, now: Date.now(), market: { mark: '100', as_of: Date.now() - 300000 }, features: [], klines: {} };
    const stale = evaluateHoldingReview(inp);
    expect(stale.reason).toBe('market_stale_keep_protection'); expect(stale.allowed_actions).toEqual(['HOLD']);
    const legacy = evaluateHoldingReview({ ...inp, thread: { ...t, holding_plan: undefined } });
    expect(legacy.reason).toBe('legacy_plan_unavailable'); expect(legacy.allowed_actions).toEqual(['HOLD']);
  });
});

describe('unknown entry receipt owns whatever the CID actually filled', () => {
  it('executeOpen 回查 CANCELED + 有成交 → 归属持仓、意图 filled、补挂止损', async () => {
    state = openStateDb(':memory:');
    const store = new DemoStore(state), backend = new PaperBackend(10000);
    const rt = new DemoRuntime({ store, backend, brains: {} });
    backend.tick('BTCUSDT', '100');
    const t = newThread({ id: 'unknown-receipt', backend: 'paper', symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '1h', horizon: 'intraday', thesis: 'retest', invalidation_text: '80', watch_conditions: [], entry: { type: 'limit', price: '90', zone: null }, stop_price: '70', take_profits: ['150'], qty: '1', margin_usdt: '90', leverage: 1, margin_mode: 'cross', now: Date.now() - 10000 });
    t.holding_plan = buildHoldingPlan({ thread: t, features: [{ tf: '1h', atr14: 5 } as TfFeatures], now: t.created_at })!;
    store.saveThread(t);
    const intent = { id: 'open-unknown', episode_id: '', thread_id: t.id, principal: 'agent' as const, at: t.created_at, kind: 'open' as const, symbol: t.symbol, direction: t.side, quantity: t.qty, entry: 'limit' as const, limit_price: '90', stop_price: '70', take_profit_price: '150', sizing: { equity: '10000', risk_pct: '0', risk_usdt: '0', stop_distance: '20', raw_qty: '1', step_size: '0.01', note: 'fixture' }, status: 'pending_approval' as const, client_order_id: null, backend: 'paper' as const, receipts: [], error: null };
    store.saveIntent(intent);
    vi.spyOn(backend, 'placeEntry').mockResolvedValue({ outcome: 'unknown', receipt: null, avg_price: null, error: 'transport timeout' });
    vi.spyOn(backend, 'getOrder').mockResolvedValue(order('CANCELED', '0.4'));
    const stop = vi.spyOn(backend, 'placeStop');
    await (rt as any).executeOpen(t, store.intent(intent.id), null);
    const next = store.thread(t.id)!;
    expect(next.status).toBe('in_position'); expect(next.qty).toBe('0.4'); expect(next.entry_cancel_pending).toBe(false);
    expect(store.intent(intent.id)!.status).toBe('filled');
    expect(store.activity().some(a => a.kind === 'entry_partial_fill')).toBe(true);
    expect(stop).toHaveBeenCalledWith('BTCUSDT', 'long', '70', expect.any(String), 'perp');
  }, 20000);
});


describe('复查等行情期间的并发写不被旧快照回退', () => {
  let server: FakeMarketServer;
  beforeAll(async () => { server = await startFakeMarketServer(77000, 200); process.env['TG_DEMO_MARKET_BASE'] = server.url; });
  afterAll(async () => { await server.close(); delete process.env['TG_DEMO_MARKET_BASE']; });

  it('模型返回后等行情时线程被撤单链改写 → 本次复查作废,不覆盖新事实', async () => {
    state = openStateDb(':memory:');
    const store = new DemoStore(state), backend = new PaperBackend(10000);
    const rt = new DemoRuntime({ store, backend, brains: { stub: stubBrain(() => { brained = true; return JSON.stringify({ action: 'HOLD', direction: 'long', confidence: 0.5, headline: 'fixture', thesis: 'fixture', reasons: ['fixture [E1]'], evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [], proposal: null }); }) }, marketPollMs: 600000, accountPollMs: 600000 });
    let brained = false, raced = false, racedVersion = 0, armed = false, seen = 0;
    await rt.start();
    try {
      rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'], auto_approve: true });
      const t = { ...newThread({ id: 'review-race', backend: 'paper', symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '1h', horizon: 'intraday', thesis: 'fixture', invalidation_text: '50000', watch_conditions: [], entry: { type: 'limit', price: '77000', zone: null }, stop_price: '40000', take_profits: ['100000'], qty: '0.01', margin_usdt: '100', leverage: 1, margin_mode: 'cross', now: Date.now() - 3600000 }), status: 'in_position' as const, opened_at: Date.now() - 3600000, filled_avg_price: '77000', entry_client_order_id: 'owned-entry', entry_cancel_pending: true, attention: 'ENTRY_REMAINDER' as const };
      t.holding_plan = buildHoldingPlan({ thread: t, features: [{ tf: '1h', atr14: 500 } as TfFeatures], now: t.created_at })!;
      store.saveThread(t);
      const realFetch = globalThis.fetch;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        // 模型回来之后 runtime 会再拉一次行情:就在这个等待窗口里,让撤单链落一次新事实。
        // 09-23 短路①:HOLD-only 复查不再调模型,改用「本次复查第 2 次拉行情」(= 闸前重拉)定位同一个等待窗口。
        if (!raced && String(input).includes('/fapi/v1/premiumIndex') && (brained || (armed && ++seen === 2))) {
          raced = true;
          const cur = store.thread(t.id)!;
          racedVersion = cur.version + 1;
          store.saveThread({ ...cur, qty: '0.02', entry_cancel_pending: false, attention: null, protection_client_order_ids: ['race-stop'], version: racedVersion, updated_at: Date.now() });
        }
        return realFetch(input, init);
      });
      armed = true;
      expect(rt.reviewThread(t.id, { kind: 'manual', detail: 'review race' })).toBe(true);
      const start = Date.now();
      while (rt.queueView().pending || rt.queueView().running) { if (Date.now() - start > 15000) throw new Error('runtime did not drain'); await new Promise((r) => setTimeout(r, 10)); }
      expect(raced).toBe(true);
      const after = store.thread(t.id)!;
      expect(after.qty).toBe('0.02');
      expect(after.entry_cancel_pending).toBe(false);
      expect(after.protection_client_order_ids).toEqual(['race-stop']);
      expect(after.version).toBe(racedVersion); // 复查没有再写一版把并发事实盖掉
      const ep = store.episode(store.episodes(10).find((e) => e.thread_id === t.id)!.id)!;
      expect(ep.reducer!.accepted).toBe(false);
      expect(ep.reducer!.reason).toContain('本次复查作废');
    } finally { await rt.stop(); }
  }, 30000);
});

it('agent missing-order response is unknown and post-cancel CID query bypasses cache', async () => {
  const prompts: string[] = [];
  const b = new AgentMcpBackend({ cli: 'claude', model: null, log: () => {}, spawnFn: async (_c, _a, p) => {
    prompts.push(p);
    const result = p.includes('"operation": "cancel_order"') || p.includes('"op": "cancel_order"') || p.includes('"task": "cancel_order"') ? { ok: true, outcome: 'filled', error: '-2011 Unknown order' } : { ok: true, order: order('CANCELED', '0.4') };
    return { stdout: JSON.stringify(result), stderr: '', code: 0, timedOut: false, spawnError: null };
  } });
  await b.start();
  try {
    await b.getOrder('BTCUSDT', 'cid');
    const r = await b.cancelOrder('BTCUSDT', 'cid');
    expect(r.ok).toBe(false);
    expect(await b.getOrder('BTCUSDT', 'cid', true)).toMatchObject({ executed_qty: '0.4' });
    expect(prompts).toHaveLength(3); expect(prompts[2]).toContain('futures_usds.queryOrder');
  } finally { await b.stop(); }
});

// ---------------------------------------------------------------- 09-12 P0-01
// 「旧保护 ID 非空 + 当前交易所上已经没有止损 + 入场单查询一直 unknown」:以前撤余量分支无条件 continue,
// 保护检查整轮饿死,人工平仓也因为余量 unknown 直接返回 —— 可以长期裸仓。
describe('P0-01 已成交仓位的保护与入场余量核对是两件独立的事', () => {
  async function knownExposureWithDeadStop() {
    state = openStateDb(':memory:');
    const store = new DemoStore(state), backend = new PaperBackend(10000);
    const rt = new DemoRuntime({ store, backend, brains: {} });
    backend.tick('BTCUSDT', '100');
    const t = newThread({ id: 'starved-protection', backend: 'paper', symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '1h', horizon: 'intraday', thesis: 'retest', invalidation_text: '80', watch_conditions: [], entry: { type: 'limit', price: '90', zone: null }, stop_price: '70', take_profits: [], qty: '0.4', margin_usdt: '36', leverage: 1, margin_mode: 'cross', now: Date.now() - 600000 });
    const opened: typeof t = { ...t, status: 'in_position', opened_at: Date.now() - 500000, filled_avg_price: '90', entry_client_order_id: 'owned-entry', entry_submitted_at: Date.now() - 500000,
      entry_cancel_pending: true, attention: 'ENTRY_REMAINDER', protection_client_order_ids: ['old-stop-no-longer-live'] };
    store.saveThread(opened);
    // 交易所上确实有这张仓,但一张挂单都没有(止损早就没了);入场 CID 查询持续 unknown。
    await backend.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.4', entry: 'market', limit_price: null, client_order_id: 'position-leg' });
    vi.spyOn(backend, 'getOrder').mockResolvedValue(null);
    return { rt, store, backend, t: opened };
  }

  it('旧保护 ID 非空 + 当前无止损 + 查单 unknown:巡检每轮都补挂止损,不再被撤余量分支跳过', async () => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { rt, store, backend, t } = await knownExposureWithDeadStop();
    // 止损只回 ACK、交易所上并没有真的出现这张单 → 每一轮都该重新判「现在有没有保护」并再补一次。
    const stop = vi.spyOn(backend, 'placeStop').mockResolvedValue({ outcome: 'submitted', receipt: null, avg_price: null, error: null });
    const acct = await backend.account();
    expect(acct.open_orders.filter((o) => o.symbol === 'BTCUSDT')).toHaveLength(0);
    await (rt as any).reconcileThreads(acct);
    expect(stop).toHaveBeenCalledWith('BTCUSDT', 'long', '70', expect.any(String), 'perp');
    const after = store.thread(t.id)!;
    expect(after.status).toBe('in_position');
    expect(after.entry_cancel_pending).toBe(true); // 余量仍在核对,没有被「平掉就算完」抹掉
    expect(after.protection_client_order_ids.some((x) => x !== 'old-stop-no-longer-live')).toBe(true); // 补了一张新的,不是拿旧 ID 当证明
    now += 61000;
    await (rt as any).reconcileThreads(await backend.account());
    expect(stop.mock.calls.length).toBeGreaterThanOrEqual(2); // 每轮都真的重判一次,不是一次性
  }, 20000);

  it('人工/硬止损退出:余量 unknown 也能 reduce-only 平掉已确认仓位,余量归属继续保留', async () => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { rt, store, backend, t } = await knownExposureWithDeadStop();
    await (rt as any).pollAccount();
    const close = vi.spyOn(backend, 'closePosition');
    await rt.closeThread(t.id, '人工平仓');
    expect(close).toHaveBeenCalledTimes(1);
    const after = store.thread(t.id)!;
    expect(after.exposure_flattened).toBe(true);
    expect(after.status).toBe('in_position');        // 线程非终态:入场单还可能成交
    expect(after.entry_cancel_pending).toBe(true);   // 余量核对继续
    expect((await backend.account()).positions.some((p) => p.symbol === 'BTCUSDT')).toBe(false);
    await rt.closeThread(t.id, '人工平仓');          // 不重复平
    expect(close).toHaveBeenCalledTimes(1);
    // 余量后来真的成交了 → 仍归属本线程,并立刻补保护
    now += 61000;
    vi.spyOn(backend, 'getOrder').mockResolvedValue(order('FILLED', '0.6'));
    const stop = vi.spyOn(backend, 'placeStop');
    await (rt as any).reconcileThreads(await backend.account());
    // 09-12 P0-01/P1-01:qty 是**还敞着的量** = 累计成交 0.6 − 已平 0.4(以前直接写 0.6,把平掉的又算回敞口)
    expect(store.thread(t.id)!.qty).toBe('0.2');
    expect(store.thread(t.id)!.exposure_flattened).toBe(false); // 有新成交越过水位 → 还能再平
    expect(stop).toHaveBeenCalled();
  }, 20000);

  // 09-12 P0-01(合并后复审回归):`exposure_flattened` 是一次性布尔 → 先平一次之后,同一张入场单
  // 迟到的成交再也平不掉(复审实测:追加 0.2 成交、账户已更新、CID 仍 unknown,再次人工平仓 closes 仍 1、仓位 0.2 仍在)。
  it('P0-01 已平一次之后又有迟到成交:人工平仓必须能再平一次(closes=2、仓位归零)', async () => {
    const { rt, store, backend, t } = await knownExposureWithDeadStop();
    await (rt as any).pollAccount();
    const closes = vi.spyOn(backend, 'closePosition');
    await rt.closeThread(t.id, '人工平仓');
    expect(closes).toHaveBeenCalledTimes(1);
    const first = store.thread(t.id)!;
    expect(first.exposure_flattened).toBe(true);
    expect(first.exposure_flattened_qty).toBe('0.4');
    expect(first.exposure_flattened_fill).toBe('0.4');
    expect((await backend.account()).positions.some((p) => p.symbol === 'BTCUSDT')).toBe(false);

    // 那张入场单又成交了 0.2,账户已经看得到,CID 仍然查不到终态
    await new Promise((r) => setTimeout(r, 2));
    await backend.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.2', entry: 'market', limit_price: null, client_order_id: 'late-fill' });
    (rt as any).account = await backend.account();
    await rt.closeThread(t.id, '人工平仓(迟到成交)');
    expect(closes).toHaveBeenCalledTimes(2);  // 修前:仍然 1
    expect((await backend.account()).positions.some((p) => p.symbol === 'BTCUSDT')).toBe(false); // 修前:0.2 还在
    expect(store.thread(t.id)!.exposure_flattened_at).toBeGreaterThan(first.exposure_flattened_at!);
  });

});

// ---------------------------------------------------------------- 09-12 P1-01
// unknown 的收敛必须只有一条出口:终态 + 累计成交 + 新鲜账户一致性。executeOpen 的零成交旁路、
// halt 旁路与 orphan 收敛以前各有各的口径,崩溃留下的提交相位还能把撤单永久卡住。
describe('P1-01 unknown 收敛统一到撤单链的事实判定', () => {
  it('executeOpen 回查零成交终态但账户上仍有同币持仓 → 不终结,交给撤单链继续核对', async () => {
    state = openStateDb(':memory:');
    const store = new DemoStore(state), backend = new PaperBackend(10000);
    const rt = new DemoRuntime({ store, backend, brains: {} });
    backend.tick('BTCUSDT', '100');
    const t = newThread({ id: 'zero-bypass', backend: 'paper', symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '1h', horizon: 'intraday', thesis: 'x', invalidation_text: '80', watch_conditions: [], entry: { type: 'limit', price: '90', zone: null }, stop_price: '70', take_profits: [], qty: '1', margin_usdt: '90', leverage: 1, margin_mode: 'cross', now: Date.now() - 10000 });
    store.saveThread(t);
    const intent = { id: 'open-zero', episode_id: '', thread_id: t.id, principal: 'agent' as const, at: t.created_at, kind: 'open' as const, symbol: t.symbol, direction: t.side, quantity: t.qty, entry: 'limit' as const, limit_price: '90', stop_price: '70', take_profit_price: null, sizing: { equity: '10000', risk_pct: '0', risk_usdt: '0', stop_distance: '20', raw_qty: '1', step_size: '0.01', note: 'fixture' }, status: 'pending_approval' as const, client_order_id: null, backend: 'paper' as const, receipts: [], error: null };
    store.saveIntent(intent);
    // 入场调用回 unknown,同时账户上出现了这个币的持仓(很可能就是这张单成交了、查单还没同步):
    // 「零成交终态」与账户事实矛盾,不能据此终结线程。
    const realPlace = backend.placeEntry.bind(backend);
    vi.spyOn(backend, 'placeEntry').mockImplementation(async () => {
      await realPlace({ symbol: 'BTCUSDT', direction: 'long', qty: '0.5', entry: 'market', limit_price: null, client_order_id: 'other-leg' });
      return { outcome: 'unknown', receipt: null, avg_price: null, error: 'transport timeout' };
    });
    vi.spyOn(backend, 'getOrder').mockResolvedValue(order('CANCELED', '0'));
    await (rt as any).executeOpen(t, store.intent(intent.id), null);
    const after = store.thread(t.id)!;
    expect(after.status).toBe('pending_entry');            // 没有像旧旁路那样直接 failed/canceled
    expect(after.entry_cancel_pending).toBe(true);          // 留在撤单链里继续核对
    expect(store.intent(intent.id)!.status).toBe('unknown');
  }, 20000);

  it('halt 旁路:撤单 ok + 账户无仓,但入场单还是 NEW → 不写终态', async () => {
    const { rt, store, backend, t } = await setup();
    vi.spyOn(backend, 'getOrder').mockResolvedValue(order('NEW', '0'));
    await (rt as any).retryHalt(t, false);
    const after = store.thread(t.id)!;
    expect(after.status).toBe('pending_entry');
    expect(after.entry_cancel_pending).toBe(true);
  });

  it('halt 旁路:入场单回查发现成交 → 归属持仓而不是「紧急停止已完成」', async () => {
    const { rt, store, backend, t } = await setup();
    vi.spyOn(backend, 'getOrder').mockResolvedValue(order('CANCELED', '0.4'));
    await (rt as any).retryHalt(t, false);
    const after = store.thread(t.id)!;
    expect(after.status).toBe('in_position');
    expect(after.qty).toBe('0.4');
  });

  it('P1-01 撤单归属写的是「累计成交 − 已平量」,不是累计入场量', async () => {
    const { rt, store, backend, t } = await setup();
    store.saveThread({ ...t, status: 'in_position', qty: '0.4', entry_cancel_pending: true, attention: 'ENTRY_REMAINDER', exposure_flattened: true, exposure_flattened_qty: '0.4', exposure_flattened_fill: '0.4', exposure_flattened_at: Date.now() - 1000, version: t.version + 1 });
    vi.spyOn(backend, 'getOrder').mockResolvedValue(order('CANCELED', '0.6'));
    await (rt as any).cancelEntry(store.thread(t.id)!, null, '撤余量');
    const after = store.thread(t.id)!;
    expect(after.qty).toBe('0.2');                 // 修前:0.6(把已平的 0.4 又算回敞口)
    expect(after.exposure_flattened).toBe(false);  // 累计成交越过水位 = 有新敞口,一次性标志解开
  });

  it('P1-01 已平干净 + 入场单终态 → 线程写终态,不卡在 in_position', async () => {
    const { rt, store, backend, t } = await setup();
    store.saveThread({ ...t, status: 'in_position', qty: '0.4', entry_cancel_pending: true, attention: 'ENTRY_REMAINDER', exposure_flattened: true, exposure_flattened_qty: '0.4', exposure_flattened_fill: '0.4', exposure_flattened_at: Date.now() - 1000, version: t.version + 1 });
    vi.spyOn(backend, 'getOrder').mockResolvedValue(order('CANCELED', '0.4'));
    const stop = vi.spyOn(backend, 'placeStop');
    await (rt as any).cancelEntry(store.thread(t.id)!, null, '撤余量');
    const after = store.thread(t.id)!;
    expect(after.status).toBe('closed');
    expect(after.qty).toBe('0.0');
    expect(stop).not.toHaveBeenCalled();  // 没有敞口就不该再挂保护
  });

  // 09-12 P1-01:halt 旁路以前只在「attention=HALT_INCOMPLETE 或 有仓 或 有挂单」时才收敛,
  // 于是已经平掉、入场单也已终态的线程永远卡在 in_position(没有任何一轮会再看它)。
  it('P1-01 halt:已平且入场单已终态的线程要写终态,不卡在 in_position', async () => {
    const { rt, store, backend, t } = await setup();
    await backend.cancelOrder('BTCUSDT', 'owned-entry'); // 交易所上无仓、无挂单
    store.saveThread({ ...t, status: 'in_position', qty: '0.0', entry_cancel_pending: true, attention: 'ENTRY_REMAINDER',
      exposure_flattened: true, exposure_flattened_qty: '0.4', exposure_flattened_fill: '0.4', exposure_flattened_at: Date.now() - 1000, version: t.version + 1 });
    vi.spyOn(backend, 'getOrder').mockResolvedValue(order('CANCELED', '0.4'));
    const log = vi.spyOn(rt as any, 'log');
    (rt as any).halted = true;
    const acct = await backend.account();
    expect(acct.open_orders.filter((o) => o.symbol === 'BTCUSDT')).toHaveLength(0);
    await (rt as any).reconcileThreads(acct);
    expect(store.thread(t.id)!.status).toBe('closed'); // 修前:in_position,没有任何一轮会再看它
    // 正累计成交转交主撤单链后主链已收敛 = 完成,不再报「紧急停止重试未完成」
    expect(log.mock.calls.some((c) => c[0] === 'error' && String(c[2]).includes('紧急停止重试未完成'))).toBe(false);
  });

  it('resolveOrphanIntents 认 entry_cancel_pending 防线:撤单未闭环的线程不许把意图按终态收敛', async () => {
    const { rt, store, t } = await setup();
    store.saveThread({ ...t, status: 'canceled', closed_at: Date.now(), entry_cancel_pending: true, version: t.version + 1 });
    (rt as any).resolveOrphanIntents();
    expect(store.intent('open-intent')!.status).toBe('unknown');
    store.saveThread({ ...store.thread(t.id)!, entry_cancel_pending: false, version: t.version + 2 });
    (rt as any).resolveOrphanIntents();
    expect(store.intent('open-intent')!.status).toBe('failed');
  });

  for (const phase of ['过期', '上个进程']) it(`崩溃留下的提交相位(${phase})不再卡住撤单`, async () => {
    const { rt, store, backend, t } = await setup();
    store.saveThread({ ...t, ...(phase === '过期' ? { entry_submitting_since: Date.now() - 86400000 } : { entry_submitting_since: Date.now(), entry_submit_epoch: 'epoch-of-a-dead-process' }), version: t.version + 1 });
    const cancel = vi.spyOn(backend, 'cancelOrder');
    vi.spyOn(backend, 'getOrder').mockResolvedValue(order('NEW', '0'));
    await (rt as any).cancelEntry(store.thread(t.id)!, null, '撤单');
    expect(cancel).toHaveBeenCalledTimes(1);                        // 以前是 0:相位 truthy 就不撤
    expect(store.thread(t.id)!.entry_submitting_since).toBeNull();  // 死相位被清掉,不再挡后续巡检
    expect(store.thread(t.id)!.entry_cancel_pending).toBe(true);
  });

  it('本进程刚开的提交相位仍然挡住撤单(租约没过期)', async () => {
    const { rt, store, backend, t } = await setup();
    const cancel = vi.spyOn(backend, 'cancelOrder');
    vi.spyOn(backend, 'getOrder').mockResolvedValue(order('NEW', '0'));
    store.saveThread({ ...t, entry_submitting_since: Date.now(), entry_submit_epoch: (rt as any).submitEpoch, version: t.version + 1 });
    await (rt as any).cancelEntry(store.thread(t.id)!, null, '撤单');
    expect(cancel).not.toHaveBeenCalled();
    expect(store.thread(t.id)!.entry_submitting_since).not.toBeNull();
  });
});

// ---------------------------------------------------------------- 09-12 P1-07(发送前)
// 扫描时的入场方式建议用的是「模型之前的方向 + 那一刻的价」。模型可能改了策略/方向,价也走了,
// 所以发送前要按最终方向 + **冻结**突破位 + 新鲜可执行价重测一次;pending 时 marketable limit 与市价同拒。
describe('P1-07 发送前最终入场重闸', () => {
  async function readyToSend(entryPrice: string, over: Record<string, unknown> = {}, wf: Record<string, unknown> = {}) {
    state = openStateDb(':memory:');
    const store = new DemoStore(state), backend = new PaperBackend(10000);
    const rt = new DemoRuntime({ store, backend, brains: {} });
    backend.tick('BTCUSDT', '100');
    rt.setWorkflow({ entry_style: 'prefer_limit', strategy_council: 'require', ...wf });
    rt['markets'].set('BTCUSDT', { symbol: 'BTCUSDT', last: '100', mark: '100', funding_rate: '0', next_funding_at: 0, open_interest: '0', as_of: Date.now(), klines_tf: '1h' });
    const t = newThread({ id: 'final-entry', backend: 'paper', symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '1h', thesis: 'x', invalidation_text: '80', watch_conditions: [], entry: { type: 'limit', price: entryPrice, zone: null }, stop_price: '70', take_profits: [], qty: '1', margin_usdt: '100', leverage: 1, margin_mode: 'cross', now: Date.now() });
    t.council = { version: 'v1', at: Date.now(), direction: 'long', reached: true, agreeing: ['s1'], dissenting: [], gate_effective: true, entry_timing: 'pending', votes: [] };
    t.entry_basis = { breakout_level: 99, atr: 2, mark: 100, at: Date.now() };
    Object.assign(t, over);
    store.saveThread(t);
    const intent = { id: 'final-intent', episode_id: '', thread_id: t.id, principal: 'agent' as const, at: Date.now(), kind: 'open' as const, symbol: 'BTCUSDT', direction: 'long' as const, quantity: '1', entry: t.entry.type, limit_price: t.entry.price, stop_price: '70', take_profit_price: null, sizing: { equity: '10000', risk_pct: '0', risk_usdt: '0', stop_distance: '30', raw_qty: '1', step_size: '0.01', note: 'fixture' }, status: 'approved' as const, client_order_id: null, backend: 'paper' as const, receipts: [], error: null };
    store.saveIntent(intent);
    return { rt, store, backend, t, intent };
  }

  it('回踩未确认 + 限价挂在现价之上(marketable limit)→ 发送前拒,一张单都不发', async () => {
    const { rt, store, backend, t, intent } = await readyToSend('101');
    const place = vi.spyOn(backend, 'placeEntry');
    await (rt as any).executeOpen(t, store.intent(intent.id), null);
    expect(place).not.toHaveBeenCalled();
    expect(store.thread(t.id)!.close_reason).toMatch(/发送前入场方式重闸/);
    expect(store.intent(intent.id)!.status).toBe('rejected');
  });

  // 复审回归:发送前那次重闸不传 `entry_mode`,于是规则写了 `entry_mode=market_ok` 的策略在
  // limit_only 下也被当成「市价一律拒」,而扫描闸又只看扫描时那条策略的字段。
  it('P1-07 limit_only:最终策略 rules.entry_mode=market_ok 时市价放行,没写的仍拒', async () => {
    const market = { entry: { type: 'market' as const, price: null, zone: null } };
    const timing = { council: { version: 'v1', at: Date.now(), direction: 'long' as const, reached: true, agreeing: ['s1'], dissenting: [], gate_effective: true, entry_timing: 'confirmed' as const, votes: [] } };
    const blocked = await readyToSend('100', { ...market, ...timing, strategy_id: 'breakout_retest' }, { entry_style: 'limit_only' });
    const noPlace = vi.spyOn(blocked.backend, 'placeEntry');
    await (blocked.rt as any).executeOpen(blocked.t, blocked.store.intent('final-intent'), null);
    expect(noPlace).not.toHaveBeenCalled();
    expect(blocked.store.thread(blocked.t.id)!.close_reason).toMatch(/limit_only/);

    const ok = await readyToSend('100', { ...market, ...timing, strategy_id: 'breakout_retest' }, { entry_style: 'limit_only' });
    // entry_mode 不进 content_hash(给老版本补它不该造新版本),所以直接改存着的那一行
    const head = ok.store.strategies.head('breakout_retest')!;
    (ok.store.strategies as any).write({ ...head, rules: { ...head.rules, entry_mode: 'market_ok' } });
    expect(ok.store.strategies.head('breakout_retest')!.rules.entry_mode).toBe('market_ok');
    const place = vi.spyOn(ok.backend, 'placeEntry');
    await (ok.rt as any).executeOpen(ok.t, ok.store.intent('final-intent'), null);
    expect(place).toHaveBeenCalled(); // 修前:最终策略写了 market_ok 也照拒
  });

  it('P1-07 时机 confirmed 的市价单,可执行价不新鲜也要拒', async () => {
    const { rt, store, backend, t, intent } = await readyToSend('100', {
      entry: { type: 'market', price: null, zone: null },
      council: { version: 'v1', at: Date.now(), direction: 'long', reached: true, agreeing: ['s1'], dissenting: [], gate_effective: true, entry_timing: 'confirmed', votes: [] },
    });
    rt['markets'].set('BTCUSDT', { symbol: 'BTCUSDT', last: '100', mark: '100', funding_rate: '0', next_funding_at: 0, open_interest: '0', as_of: Date.now() - 600_000, klines_tf: '1h' });
    const place = vi.spyOn(backend, 'placeEntry');
    await (rt as any).executeOpen(t, store.intent(intent.id), null);
    expect(place).not.toHaveBeenCalled(); // 修前:confirmed + 旧价 passed=true
    expect(store.thread(t.id)!.close_reason).toMatch(/新鲜/);
  });

  it('挂在现价不利侧等回踩、且在追单上限内 → 照常发出去', async () => {
    const { rt, store, backend, t, intent } = await readyToSend('99');
    const place = vi.spyOn(backend, 'placeEntry');
    await (rt as any).executeOpen(t, store.intent(intent.id), null);
    expect(place).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- 09-12 P1-13
describe('P1-13 空壳结算不算完成', () => {
  it('trades=0 的结算不再被当已完成:巡检继续补,策略适配也不吃它', async () => {
    state = openStateDb(':memory:');
    const store = new DemoStore(state), backend = new PaperBackend(10000);
    const rt = new DemoRuntime({ store, backend, brains: {} });
    const base = newThread({ id: 'shell-settle', backend: 'paper', symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '1h', thesis: 'x', invalidation_text: null, watch_conditions: [], entry: { type: 'market', price: null, zone: null }, stop_price: '70', take_profits: [], qty: '1', margin_usdt: '100', leverage: 1, margin_mode: 'cross', now: Date.now() - 7200000 });
    store.saveThread({ ...base, strategy_id: 'breakout_retest', status: 'closed', opened_at: Date.now() - 7000000, closed_at: Date.now() - 60000, realized_pnl: '0', filled_avg_price: '100',
      settlement: { at: Date.now(), realized_pnl: '0', commission: '0', funding: '0', net_pnl: '0', exit_price: null, trades: 0, note: '窗口内没有成交' } as any });
    const settleOne = vi.spyOn(rt as any, 'settleThread').mockResolvedValue(true);
    (backend as any).settlement = async () => ({ trades: [], funding: null });
    await (rt as any).settlePending();
    expect(settleOne).toHaveBeenCalledTimes(1); // 以前:有 settlement 对象就不再补
    expect(rt.fitInputsFor('BTCUSDT', { id: 'breakout_retest' } as any, null).history).toBeNull(); // 空壳结算不进策略适配
    // 同一条线程换成完整结算之后才进反馈
    const cur = store.thread('shell-settle')!;
    store.saveThread({ ...cur, settlement: { ...cur.settlement!, trades: 2, exit_price: '110', note: null }, realized_pnl: '10' });
    expect(rt.fitInputsFor('BTCUSDT', { id: 'breakout_retest' } as any, null).history).toMatchObject({ n: 1 });
  });
});
