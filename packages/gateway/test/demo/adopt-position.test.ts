// 09-07:无主持仓交给 agent(adoptPosition)+ 入场单发送中不许撤(closeThread 409)。
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { stubBrain } from '../../src/demo/brain.js';
import { computeSnapshot, DEFAULT_PORTFOLIO_POLICY } from '../../src/demo/portfolio.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';

let fakeMarket: FakeMarketServer;
let DemoRuntime: typeof import('../../src/demo/runtime.js').DemoRuntime;
beforeAll(async () => {
  fakeMarket = await startFakeMarketServer();
  process.env['TG_DEMO_MARKET_BASE'] = fakeMarket.url;
  ({ DemoRuntime } = await import('../../src/demo/runtime.js'));
});
afterAll(async () => {
  await fakeMarket.close();
  delete process.env['TG_DEMO_MARKET_BASE'];
});

let state: StateDb | null = null;
let rt: InstanceType<typeof DemoRuntime> | null = null;
async function setup() {
  state = openStateDb(':memory:');
  const store = new DemoStore(state);
  const backend = new PaperBackend(10_000);
  rt = new DemoRuntime({ store, backend, brains: { stub: stubBrain() }, marketPollMs: 600_000, accountPollMs: 600_000 });
  await rt.start();
  return { rt, backend, store };
}
afterEach(async () => {
  if (rt) await rt.stop();
  state?.close();
  rt = null;
  state = null;
});

describe('adoptPosition', () => {
  it('turns an ownerless position into an in_position thread and places the stop when the exchange has none', async () => {
    const { rt, backend, store } = await setup();
    const e = await backend.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.002', entry: 'market', limit_price: null, client_order_id: 'orphan-1' });
    expect(e.outcome).toBe('filled');
    await expect(rt.adoptPosition('BTCUSDT')).rejects.toThrow(/必须给一个止损价/);
    await expect(rt.adoptPosition('BTCUSDT', { stop_price: '999999' })).rejects.toThrow(/标记价下方/);
    const t = await rt.adoptPosition('BTCUSDT', { stop_price: '1' });
    expect(t.status).toBe('in_position');
    expect(t.source).toBe('manual');
    expect(t.qty).toBe('0.002');
    expect(t.stop_price).toBe('1');
    expect(t.protection_client_order_ids.length).toBe(1);
    const acct = await backend.account();
    expect(acct.open_orders.some((o) => o.symbol === 'BTCUSDT' && o.stop_price === '1')).toBe(true);
    expect(rt.openThreads().map((x) => x.id)).toEqual([t.id]);
    // 再接管一次 → 已有线程,拒
    await expect(rt.adoptPosition('BTCUSDT', { stop_price: '1' })).rejects.toThrow(/已经有线程/);
    // 没仓的币 → 拒
    await expect(rt.adoptPosition('ETHUSDT', { stop_price: '1' })).rejects.toThrow(/没有持仓/);
    expect(store.thread(t.id)?.status).toBe('in_position');
  });

  it('reuses an exchange stop when one is already there (no duplicate leg) and the portfolio counts it as protected even before adoption', async () => {
    const { rt, backend } = await setup();
    await backend.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.002', entry: 'market', limit_price: null, client_order_id: 'orphan-2' });
    expect((await backend.placeStop('BTCUSDT', 'long', '5', 'ext-stop-1')).outcome).toBe('submitted');
    const acct = await backend.account();
    // 无线程 + 交易所有止损:组合快照不再报「缺止损」
    const snap = computeSnapshot({ account: acct, markets: new Map(), threads: [], intents: [], now: Date.now(), policy: DEFAULT_PORTFOLIO_POLICY });
    expect(snap.unprotected_symbols).toEqual([]);
    const t = await rt.adoptPosition('BTCUSDT');
    expect(t.stop_price).toBe('5');
    expect(t.protection_client_order_ids).toEqual(['ext-stop-1']);
    const after = await backend.account();
    expect(after.open_orders.filter((o) => o.symbol === 'BTCUSDT' && o.stop_price === '5')).toHaveLength(1);
  });
});

describe('closeThread while the entry is in flight', () => {
  it('refuses with 409 instead of marking the thread canceled', async () => {
    const { rt, store } = await setup();
    const t = await rt.adoptPosition('BTCUSDT', { stop_price: '1' }).catch(() => null);
    expect(t).toBeNull(); // 没仓,只是确认接口在
    // 手工造一条发送中的线程
    const { newThread } = await import('../../src/demo/threads.js');
    const th = newThread({ id: 'thr-inflight', backend: 'paper', symbol: 'ETHUSDT', side: 'long', source: 'manual', timeframe: '15m', thesis: 't', invalidation_text: null, watch_conditions: [], entry: { type: 'market', price: null, zone: null }, stop_price: '1', take_profits: [], qty: '0.1', margin_usdt: null, leverage: 3, margin_mode: 'cross', now: Date.now() });
    rt.saveThread({ ...th, entry_client_order_id: 'tgd-x-e1', entry_submitting_since: Date.now() - 5_000 });
    await expect(rt.closeThread('thr-inflight', '界面上手动平仓/撤单')).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/正在发送中/) });
    expect(store.thread('thr-inflight')?.status).toBe('pending_entry');
  });
});
