// 09-26:评审期间 18811 要把执行通道从 okx 切到 paper。okx 上那条 BTC 空单线程(in_position,交易所挂着 OCO)
// 在切换当下、切换后的每轮轮询/对账、保护单自检/重挂、以 paper 重启时,都不许被平、被撤/重挂保护、被收成终态。
// 做法:线程 backend ≠ 当前执行通道 → 冻结全部自动与手动写动作(runtime.foreignBackend)。桩后端,不连交易所。

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend, type ExecBackend } from '../../src/demo/execution.js';
import { stubBrain } from '../../src/demo/brain.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';
import type { AccountView, StrategyThread } from '../../src/demo/types.js';

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

type RT = InstanceType<typeof DemoRuntime>;
let state: StateDb | null = null;
let rtActive: RT | null = null;
afterEach(async () => {
  if (rtActive) await rtActive.stop();
  rtActive = null;
  try { state?.close(); } catch { /* closed */ }
  state = null;
  vi.restoreAllMocks();
});

const WRITES = ['placeEntry', 'placeStop', 'placeTakeProfit', 'placePartialTakeProfit', 'closePosition', 'reducePosition', 'cancelAll', 'cancelOrder', 'cancelAlgoOrder', 'openWithProtection', 'setLeverage', 'setMarginType', 'moveStop', 'amendStop'] as const;
function spyWrites(b: ExecBackend): ReturnType<typeof vi.fn>[] {
  const out: ReturnType<typeof vi.fn>[] = [];
  for (const m of WRITES) if (typeof (b as unknown as Record<string, unknown>)[m] === 'function') out.push(vi.spyOn(b as never, m as never) as unknown as ReturnType<typeof vi.fn>);
  return out;
}
const noCalls = (spies: ReturnType<typeof vi.fn>[]): void => { for (const s of spies) expect(s).not.toHaveBeenCalled(); };

/** okx 通道的桩:纸面撮合 + kind=okx,账户里是 BTC 空单 + 交易所 OCO(SL 90000 / TP 81000)。 */
function okxStub(): ExecBackend {
  const b = new PaperBackend(100_000);
  Object.defineProperty(b, 'kind', { value: 'okx' });
  vi.spyOn(b, 'account').mockImplementation(async (): Promise<AccountView> => ({
    backend: 'okx', equity: '100000', available: '90000', unrealized_pnl: '10',
    positions: [{ symbol: 'BTCUSDT', market: 'perp', side: 'short', qty: '0.13', entry_price: '85948.8', mark_price: '85000', unrealized_pnl: '10', leverage: 3 }],
    open_orders: [{ symbol: 'BTCUSDT', market: 'perp', side: 'BUY', type: 'STOP_MARKET', qty: '0.13', price: null, stop_price: '90000', reduce_only: true, client_order_id: 'tgd-btc-s1' } as never],
    as_of: Date.now(),
  }));
  return b;
}

function btcThread(): StrategyThread {
  return {
    id: 'thr-btc-okx', backend: 'okx', market: 'perp', symbol: 'BTCUSDT', side: 'short', status: 'in_position', source: 'agent', timeframe: '1h', thesis: '自由判断',
    invalidation_text: '90000', watch_conditions: [], entry: { type: 'market', price: null, zone: null }, stop_price: '90000', take_profits: ['81000'], qty: '0.13',
    margin_usdt: null, leverage: 3, margin_mode: 'cross', entry_client_order_id: 'tgd-btc-e1', protection_client_order_ids: ['tgd-btc-s1', 'tgd-btc-t1'],
    filled_avg_price: '85948.8', realized_pnl: null, close_reason: null, attention: null, entry_lookup_misses: 0, leg_seq: 3, episode_ids: [], intent_ids: [],
    created_at: 1790075676121, updated_at: 1790075676121, opened_at: 1790075676121, closed_at: null, version: 7,
  } as StrategyThread;
}

function make(boot: 'okx' | 'paper'): { rt: RT; store: DemoStore; okx: ExecBackend; paper: PaperBackend; before: StrategyThread } {
  state = openStateDb(':memory:');
  const store = new DemoStore(state);
  const okx = okxStub();
  const paper = new PaperBackend(10_000);
  const t = btcThread();
  store.saveThread(t);
  const rt = new DemoRuntime({ store, backend: boot === 'okx' ? okx : paper, backends: { okx: () => okx, paper: () => paper }, brains: { stub: stubBrain() }, marketPollMs: 600_000, accountPollMs: 600_000 });
  rtActive = rt;
  return { rt, store, okx, paper, before: store.thread(t.id)! };
}

const unchanged = (store: DemoStore, before: StrategyThread): void => {
  const cur = store.thread(before.id)!;
  expect(cur.status).toBe('in_position');
  expect(cur.version).toBe(before.version);
  expect(cur.protection_client_order_ids).toEqual(['tgd-btc-s1', 'tgd-btc-t1']);
  expect(cur.attention).toBeNull();
  expect(cur.closed_at).toBeNull();
  expect(cur.stop_price).toBe('90000');
};

describe('线程 backend ≠ 当前执行通道 → 冻结', () => {
  it('1) switchBackend(paper) 当下 + 2) 之后多轮账户轮询/对账:okx 线程不被判平、不被碰,两个通道都零写', async () => {
    const { rt, store, okx, paper, before } = make('okx');
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'] });
    const okxW = spyWrites(okx), paperW = spyWrites(paper);
    expect(await rt.switchBackend('paper')).toBeNull();
    expect(rt.backend.kind).toBe('paper');
    for (let i = 0; i < 3; i++) await (rt as any).pollAccount();
    await (rt as any).reconcileThreads(await paper.account());
    unchanged(store, before);
    noCalls(okxW); noCalls(paperW);
  }, 60_000);

  it('3) 保护单自检/重挂、平仓、减仓、撤单、复查:全部拒绝,线程不变,零写;手动平仓 409', async () => {
    const { rt, store, okx, paper, before } = make('paper');
    const okxW = spyWrites(okx), paperW = spyWrites(paper);
    const t = store.thread(before.id)!;
    await (rt as any).placeProtection(t, '测试');
    await (rt as any).placeProtectionOutsideStopMove(t, '测试');
    await (rt as any).protectKnownExposure(t.id, null, '测试');
    await (rt as any).closeThreadNow(t, null, '测试');
    await (rt as any).reduceHalf(t, null);
    await (rt as any).flattenKnownExposure(t, null, '测试');
    expect((await (rt as any).cancelEntry(t, null, '测试')).confirmed_zero_fill).toBe(false);
    expect(rt.reviewThread(t.id, { kind: 'manual', detail: '测试' })).toBe(false);
    await expect(rt.closeThread(t.id)).rejects.toMatchObject({ status: 409 });
    await rt.verifyProtection({ symbol: 'BTCUSDT' }).catch(() => undefined); // 纸面通道:与 okx 线程无关
    unchanged(store, before);
    noCalls(okxW); noCalls(paperW);
    expect(store.logs(100).some((l) => /已冻结\(只显示\)/.test(l.message))).toBe(true);
  }, 60_000);

  it('4) 以 paper 启动(TG_DEMO_BACKEND=paper 的等价):启动轮询 + 对账 + 紧急停止都不碰 okx 线程', async () => {
    const { rt, store, okx, paper, before } = make('paper');
    const okxW = spyWrites(okx), paperW = spyWrites(paper);
    await rt.start();
    await (rt as any).pollAccount();
    await rt.halt();
    await (rt as any).pollAccount();
    unchanged(store, before);
    noCalls(okxW);
    // 紧急停止只按纸面自己的线程/仓位动(这里纸面是空的),okx 线程不在其中
    for (const s of paperW) for (const call of s.mock.calls) expect(call[0]).not.toBe('BTCUSDT');
  }, 60_000);

  it('切回 okx 后照常管理(冻结只针对通道不符)', async () => {
    const { rt, store, okx, before } = make('paper');
    await rt.start();
    expect(await rt.switchBackend('okx')).toBeNull();
    expect(rt.foreignBackend(store.thread(before.id)!)).toBeNull();
    expect(rt.openThreads().map((t) => t.id)).toContain(before.id);
    void okx;
  }, 60_000);
});
