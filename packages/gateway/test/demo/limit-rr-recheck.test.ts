// 09-26 SOL 事故回归:发送前持仓计划重闸(runtime.ts executeOpen)对限价单的净盈亏比复核。
// 语义(现行代码,entry-policy.ts classifyEntryOrder 判类):
//   - waiting_limit(做多限价 < 现价 / 做空限价 > 现价):只按挂单价复核 —— 它本来就等着价格回来,
//     拿现价考核会把「挂在回踩区等回来」的单在出生时就否掉。
//   - market / marketable_limit(会立刻成交) / unknown_limit:仍按 [现价, 挂单价] 两价全查 ——
//     它们成交在现价,现价穿止损或离止损太近都要挡,`entry='limit'` 不是免检通道。
// 只走 executeOpen 这条真实代码路径(与 cancel-chain.test.ts / events-http.test.ts 同一搭法),
// 不跑完整 scan() 管线,不调模型。

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { DemoRuntime } from '../../src/demo/runtime.js';
import { newThread } from '../../src/demo/threads.js';
import { buildHoldingPlan } from '../../src/demo/holding-policy.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';
import type { Judgment, TfFeatures } from '../../src/demo/types.js';

let state: StateDb | null = null;
afterEach(() => { try { state?.close(); } catch { /* already closed */ } state = null; vi.restoreAllMocks(); });

// sizing.risk_pct='0.5' 与 workflow 默认 risk_pct='0.5' 取 min = 0.5,equity(10000) → riskUsdt=50,
// qty 固定为 1 时 qty*stopDist 在三个用例里都远小于 50*1.05,数量硬闸稳定通过,不是本测试要考的东西。
const sizing = { equity: '10000', risk_pct: '0.5', risk_usdt: '50', stop_distance: '5', raw_qty: '1', step_size: '0.001', note: 'fixture' };

// ---------------------------------------------------------------- mark = 113(basePrice 63 + 50)

describe('发送前持仓计划重闸:waiting_limit 只按挂单价,market/marketable 两价全查(mark=113)', () => {
  let server: FakeMarketServer;
  beforeAll(async () => { server = await startFakeMarketServer(63); process.env['TG_DEMO_MARKET_BASE'] = server.url; });
  afterAll(async () => { await server.close(); delete process.env['TG_DEMO_MARKET_BASE']; });

  async function setup() {
    state = openStateDb(':memory:');
    const store = new DemoStore(state), backend = new PaperBackend(10_000);
    const rt = new DemoRuntime({ store, backend, brains: {} });
    return { rt, store, backend };
  }

  it('①限价挂在现价下方(waiting_limit):按现价 RR 不够、按挂单价 RR 够 → 应该发送(不 canceled)', async () => {
    const { rt, store, backend } = await setup();
    // 现价 113,离止盘 115 很近:按现价算净RR只有约0.1,远不够1.5;挂单价 100 才是真正等回踩的价,净RR约2.9。
    backend.tick('BTCUSDT', '113'); // 挂单价 100 < 113,不会立刻成交,单子应该老老实实挂着
    const t = newThread({ id: 'rr-waiting-limit', backend: 'paper', symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '1h', horizon: 'intraday', thesis: 'retest', invalidation_text: '95', watch_conditions: [], entry: { type: 'limit', price: '100', zone: null }, stop_price: '95', take_profits: ['115'], qty: '1', margin_usdt: '100', leverage: 1, margin_mode: 'cross', now: Date.now() });
    t.holding_plan = buildHoldingPlan({ thread: t, features: [{ tf: '1h', atr14: 5 } as TfFeatures], now: t.created_at })!;
    expect(t.holding_plan).not.toBeNull();
    store.saveThread(t);
    const intent = { id: 'i-waiting', episode_id: '', thread_id: t.id, principal: 'agent' as const, at: t.created_at, kind: 'open' as const, symbol: t.symbol, direction: t.side, quantity: t.qty, entry: 'limit' as const, limit_price: '100', stop_price: '95', take_profit_price: '115', sizing, status: 'approved' as const, client_order_id: null, backend: 'paper' as const, receipts: [], error: null };
    store.saveIntent(intent);
    const place = vi.spyOn(backend, 'placeEntry');
    await (rt as any).executeOpen(t, store.intent(intent.id), null);
    const next = store.thread(t.id)!;
    expect(next.status).not.toBe('canceled');
    expect(next.close_reason ?? '').not.toContain('发送前持仓计划重闸');
    expect(place).toHaveBeenCalledTimes(1);
    expect(store.intent(intent.id)!.status).not.toBe('rejected');
  });

  it('②市价单:按现价净RR不达标 → abort,close_reason 含「发送前持仓计划重闸」', async () => {
    const { rt, store, backend } = await setup();
    const t = newThread({ id: 'rr-market', backend: 'paper', symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '1h', horizon: 'intraday', thesis: 'retest', invalidation_text: '95', watch_conditions: [], entry: { type: 'market', price: null, zone: null }, stop_price: '95', take_profits: ['115'], qty: '1', margin_usdt: '100', leverage: 1, margin_mode: 'cross', now: Date.now() });
    // 市价单没有挂单价,借一个合成 judgment 只给 buildHoldingPlan 定入场价(100),不影响执行时按现价复核。
    const seed = { proposal: { limit_price: '100' } } as unknown as Judgment;
    t.holding_plan = buildHoldingPlan({ thread: t, judgment: seed, features: [{ tf: '1h', atr14: 5 } as TfFeatures], now: t.created_at })!;
    expect(t.holding_plan).not.toBeNull();
    store.saveThread(t);
    const intent = { id: 'i-market', episode_id: '', thread_id: t.id, principal: 'agent' as const, at: t.created_at, kind: 'open' as const, symbol: t.symbol, direction: t.side, quantity: t.qty, entry: 'market' as const, limit_price: null, stop_price: '95', take_profit_price: '115', sizing, status: 'approved' as const, client_order_id: null, backend: 'paper' as const, receipts: [], error: null };
    store.saveIntent(intent);
    const place = vi.spyOn(backend, 'placeEntry');
    await (rt as any).executeOpen(t, store.intent(intent.id), null);
    const next = store.thread(t.id)!;
    expect(next.status).toBe('canceled');
    expect(next.close_reason ?? '').toContain('发送前持仓计划重闸');
    expect(next.close_reason ?? '').toContain('净盈亏比');
    expect(place).not.toHaveBeenCalled();
    expect(store.intent(intent.id)!.status).toBe('rejected');
  });
});

// ---------------------------------------------------------------- mark = 100(basePrice 50 + 50)

describe('发送前持仓计划重闸:marketable_limit 不享受 waiting_limit 的豁免(mark=100)', () => {
  let server: FakeMarketServer;
  beforeAll(async () => { server = await startFakeMarketServer(50); process.env['TG_DEMO_MARKET_BASE'] = server.url; });
  afterAll(async () => { await server.close(); delete process.env['TG_DEMO_MARKET_BASE']; });

  it('③限价挂在现价上方(marketable_limit,会立刻成交):现价已跌破硬止损 → 仍 abort', async () => {
    state = openStateDb(':memory:');
    const store = new DemoStore(state), backend = new PaperBackend(10_000);
    const rt = new DemoRuntime({ store, backend, brains: {} });
    // 挂单价 105(高于现价 100,long 限价 >= 现价 = marketable_limit,会立刻成交);
    // 但现价 100 已经在硬止损 101 之下 —— 拿挂单价单独复核会看不出这一点,必须查现价。
    const t = newThread({ id: 'rr-marketable-limit', backend: 'paper', symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '1h', horizon: 'intraday', thesis: 'retest', invalidation_text: '101', watch_conditions: [], entry: { type: 'limit', price: '105', zone: null }, stop_price: '101', take_profits: ['115'], qty: '1', margin_usdt: '100', leverage: 1, margin_mode: 'cross', now: Date.now() });
    t.holding_plan = buildHoldingPlan({ thread: t, features: [{ tf: '1h', atr14: 4 } as TfFeatures], now: t.created_at })!;
    expect(t.holding_plan).not.toBeNull();
    store.saveThread(t);
    const intent = { id: 'i-marketable', episode_id: '', thread_id: t.id, principal: 'agent' as const, at: t.created_at, kind: 'open' as const, symbol: t.symbol, direction: t.side, quantity: t.qty, entry: 'limit' as const, limit_price: '105', stop_price: '101', take_profit_price: '115', sizing, status: 'approved' as const, client_order_id: null, backend: 'paper' as const, receipts: [], error: null };
    store.saveIntent(intent);
    const place = vi.spyOn(backend, 'placeEntry');
    await (rt as any).executeOpen(t, store.intent(intent.id), null);
    const next = store.thread(t.id)!;
    expect(next.status).toBe('canceled');
    expect(next.close_reason ?? '').toContain('发送前持仓计划重闸');
    expect(next.close_reason ?? '').toContain('净盈亏比');
    expect(place).not.toHaveBeenCalled();
    expect(store.intent(intent.id)!.status).toBe('rejected');
  });
});
