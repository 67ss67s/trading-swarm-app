import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { DemoRuntime } from '../../src/demo/runtime.js';
import { newThread } from '../../src/demo/threads.js';
import * as marketApi from '../../src/demo/market.js';
import type { MarketView } from '../../src/demo/types.js';

let state: StateDb | null = null;
afterEach(() => { state?.close(); state = null; vi.restoreAllMocks(); });
const sizing = { equity: '10000', risk_pct: '0.5', risk_usdt: '50', stop_distance: '2', raw_qty: '1', step_size: '0.001', note: 'fixture' };

describe('发送前止损复查', () => {
  it.each([
    ['long', '90', '88', 1, true], ['short', '110', '112', 1, true],
    ['long', '99', '97.5', 2, false],
  ] as const)('发送前止损:%s 限价 %s 止损 %s 当前下限 %s%%', async (side, price, stop, floor, sent) => {
    state = openStateDb(':memory:');
    const store = new DemoStore(state), backend = new PaperBackend(10_000);
    const rt = new DemoRuntime({ store, backend, brains: {} });
    backend.tick('BTCUSDT', '100');
    vi.spyOn(marketApi, 'fetchMarketView').mockResolvedValue({ symbol: 'BTCUSDT', mark: '100', as_of: Date.now() } as MarketView);
    vi.spyOn(marketApi, 'fetchTicker24h').mockResolvedValue({ quoteVolume: '100000000' } as Awaited<ReturnType<typeof marketApi.fetchTicker24h>>);
    // 前两笔按挂单价约 2%,按现价却超过 5%;第三笔待批时下限从 1% 提到 2%。
    const t = newThread({ id: 'stop-waiting', backend: 'paper', symbol: 'BTCUSDT', side, source: 'agent', timeframe: '1h', thesis: '回踩', invalidation_text: null, watch_conditions: [], entry: { type: 'limit', price, zone: null }, stop_price: stop, take_profits: [], qty: '1', margin_usdt: '100', leverage: 1, margin_mode: 'cross', now: Date.now() });
    store.saveThread(t);
    const intent = { id: 'i-stop-waiting', episode_id: '', thread_id: t.id, principal: 'agent' as const, at: t.created_at, kind: 'open' as const, symbol: t.symbol, direction: side, quantity: t.qty, entry: 'limit' as const, limit_price: price, stop_price: stop, take_profit_price: null, sizing, status: 'pending_approval' as const, client_order_id: null, backend: 'paper' as const, receipts: [], error: null };
    store.saveIntent(intent);
    rt.setWorkflow({ min_stop_pct: floor });
    const place = vi.spyOn(backend, 'placeEntry');
    await (rt as any).executeOpen(t, store.intent(intent.id), null);
    expect(place).toHaveBeenCalledTimes(sent ? 1 : 0);
    if (sent) expect(store.thread(t.id)!.status).not.toBe('canceled');
    else expect(store.thread(t.id)!.close_reason).toContain('发送前止损复查');
  });

});
