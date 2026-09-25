// 09-08:平仓后的交易所结算。下单回执里没有 realizedPnl / 成交价,只有成交明细有;在结算回填之前
// 一笔交易的盈亏是「未知」,不是 0 —— 复盘的盈亏与出场价两列此前全空就是漏了这一步。
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend, type SettlementView } from '../../src/demo/execution.js';
import { stubBrain } from '../../src/demo/brain.js';
import { newThread } from '../../src/demo/threads.js';
import type { StrategyThread } from '../../src/demo/types.js';
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

const NOW = 1_788_700_000_000;

class SettlingBackend extends PaperBackend {
  calls: { symbol: string; start: number; end: number }[] = [];
  constructor(private readonly view: SettlementView | null) {
    super(10_000);
  }
  async settlement(symbol: string, startMs: number, endMs: number): Promise<SettlementView | null> {
    this.calls.push({ symbol, start: startMs, end: endMs });
    return this.view;
  }
}

let state: StateDb | null = null;
let rt: InstanceType<typeof DemoRuntime> | null = null;
afterEach(async () => {
  if (rt) await rt.stop();
  state?.close();
  rt = null;
  state = null;
});

async function setup(view: SettlementView | null) {
  state = openStateDb(':memory:');
  const store = new DemoStore(state);
  const backend = new SettlingBackend(view);
  rt = new DemoRuntime({ store, backend, brains: { stub: stubBrain() }, marketPollMs: 600_000, accountPollMs: 600_000 });
  await rt.start();
  return { rt, backend, store };
}

function closedThread(over: Partial<StrategyThread> = {}): StrategyThread {
  const t = newThread({
    id: 'thr-settle-1', backend: 'paper', symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '15m', thesis: 't',
    invalidation_text: null, watch_conditions: [], entry: { type: 'market', price: null, zone: null }, stop_price: '99000',
    take_profits: ['102000'], qty: '0.1', margin_usdt: '2000', leverage: 5, margin_mode: 'cross', now: NOW - 3_600_000,
  } as Parameters<typeof newThread>[0]);
  return { ...t, status: 'closed', opened_at: NOW - 3_600_000, closed_at: NOW - 60_000, filled_avg_price: '100000', realized_pnl: null, exit_price: null, close_reason: '复查离场', ...over };
}

/** settleThread 是私有的:测试按运行时行为直接调它(巡检与 closeThreadNow 都走这一个入口)。 */
const settle = (r: InstanceType<typeof DemoRuntime>, t: StrategyThread): Promise<boolean> =>
  (r as unknown as { settleThread(x: StrategyThread): Promise<boolean> }).settleThread(t);

describe('settleThread', () => {
  it('回填净盈亏(已实现 - 手续费 + 资金费)与量加权出场价', async () => {
    const view: SettlementView = {
      trades: [
        { time: NOW - 3_600_000, side: 'BUY', price: '100000', qty: '0.1', realized_pnl: '0', commission: '4' },
        { time: NOW - 120_000, side: 'SELL', price: '101000', qty: '0.06', realized_pnl: '60', commission: '2.4' },
        { time: NOW - 90_000, side: 'SELL', price: '100500', qty: '0.04', realized_pnl: '20', commission: '1.6' },
      ],
      funding: '-3',
    };
    const { rt, store, backend } = await setup(view);
    const t = closedThread();
    store.saveThread(t);
    expect(await settle(rt, t)).toBe(true);
    const saved = store.thread(t.id)!;
    // 80 已实现 - 8 手续费 - 3 资金费 = 69
    expect(Number(saved.realized_pnl)).toBeCloseTo(69, 6);
    expect(saved.settlement).toMatchObject({ realized_pnl: '80.00000000', commission: '8.00000000', funding: '-3.00000000', trades: 3, source: 'exchange' });
    // 出场价只看平仓腿(SELL):(101000×0.06 + 100500×0.04) / 0.1
    expect(Number(saved.exit_price)).toBeCloseTo(100800, 6);
    // 窗口从开仓前留宽限到平仓后留宽限
    expect(backend.calls[0]!.symbol).toBe('BTCUSDT');
    expect(backend.calls[0]!.start).toBeLessThan(t.opened_at!);
    expect(backend.calls[0]!.end).toBeGreaterThan(t.closed_at!);
  });

  it('窗口内没有成交 → 盈亏保持 null,不写成 0,但不再反复重试', async () => {
    const { rt, store } = await setup({ trades: [], funding: null });
    const t = closedThread();
    store.saveThread(t);
    expect(await settle(rt, t)).toBe(false);
    const saved = store.thread(t.id)!;
    expect(saved.realized_pnl).toBeNull();
    expect(saved.settlement?.note).toMatch(/没有这个币的成交/);
  });

  it('后端查不到(null)时什么都不写,留给下一轮重试', async () => {
    const { rt, store } = await setup(null);
    const t = closedThread();
    store.saveThread(t);
    expect(await settle(rt, t)).toBe(false);
    const saved = store.thread(t.id)!;
    expect(saved.realized_pnl).toBeNull();
    expect(saved.settlement ?? null).toBeNull();
  });

  it('复盘统计把未结算的这笔单列,不当 0 计入胜率', async () => {
    const { rt, store } = await setup(null);
    store.saveThread(closedThread({ id: 'thr-a', realized_pnl: '12' }));
    store.saveThread(closedThread({ id: 'thr-b' }));
    const h = rt.history(50);
    expect(h.stats.count).toBe(1);
    expect(h.stats.unsettled).toBe(1);
    expect(h.stats.wins).toBe(1);
    expect(h.stats.total_pnl).toBe('12.00');
    expect(h.threads.find((x) => x.id === 'thr-b')!.settled).toBe(false);
    expect(h.threads.find((x) => x.id === 'thr-b')!.r_multiple).toBeNull();
  });
});
