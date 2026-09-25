import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { DemoRuntime } from '../../src/demo/runtime.js';
import { PaperBackend, type SettlementView } from '../../src/demo/execution.js';
import { newThread } from '../../src/demo/threads.js';
import type { StrategyThread } from '../../src/demo/types.js';

const states: StateDb[] = []; const runtimes: DemoRuntime[] = []; const dirs: string[] = [];
function setup(path = ':memory:') {
  const state = openStateDb(path); states.push(state);
  const store = new DemoStore(state); const backend = new PaperBackend(10000);
  const settlement = vi.fn<(...args: unknown[]) => Promise<SettlementView | null>>(async () => null);
  Object.assign(backend, { settlement });
  const rt = new DemoRuntime({ store, backend, brains: {} }); rt.radar.stop(); runtimes.push(rt);
  const internal = rt as unknown as { settlePending(): Promise<void>; settleThread(t: StrategyThread): Promise<boolean> };
  return { state, store, rt, settlement, internal };
}
function closed(store: DemoStore, closedAt = Date.now() - 180000) {
  const t = newThread({ id: 'settlement-test', backend: 'paper', symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '1h', thesis: 'test', invalidation_text: null, watch_conditions: [], entry: { type: 'market', price: null, zone: null }, stop_price: '90', take_profits: [], qty: '1', margin_usdt: '100', leverage: 1, margin_mode: 'cross', now: Date.now() - 7200000 });
  const out = { ...t, status: 'closed' as const, opened_at: Date.now() - 7000000, closed_at: closedAt, filled_avg_price: '100' }; store.saveThread(out); return out;
}
afterEach(async () => { for (const r of runtimes.splice(0)) await r.stop(); for (const s of states.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('persisted settlement retry limit', () => {
  it('keeps retry count/backoff across database reopen, caps at 3, and explicit reset permits another attempt', async () => {
    let now = 1800000000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const dir = mkdtempSync(join(tmpdir(), 'tg-settlement-test-')); dirs.push(dir); const path = join(dir, 'state.sqlite');
    const first = setup(path); closed(first.store);
    await first.internal.settlePending(); await first.internal.settlePending();
    expect(first.settlement).toHaveBeenCalledTimes(1); expect(first.settlement.mock.calls[0]![3]).toBe(false);
    now += 60000; await first.internal.settlePending(); expect(first.settlement).toHaveBeenCalledTimes(2);
    expect(first.settlement.mock.calls[1]![3]).toBe(true);
    await first.rt.stop(); runtimes.splice(runtimes.indexOf(first.rt), 1); first.state.close(); states.splice(states.indexOf(first.state), 1);
    const next = setup(path); await next.internal.settlePending(); expect(next.settlement).not.toHaveBeenCalled();
    now += 120000; await next.internal.settlePending(); expect(next.settlement).toHaveBeenCalledOnce(); expect(next.settlement.mock.calls[0]![3]).toBe(true);
    now += 86400000; await next.internal.settlePending(); expect(next.settlement).toHaveBeenCalledOnce();
    next.rt.resetSettlementRetries(); await next.internal.settlePending(); expect(next.settlement).toHaveBeenCalledTimes(2);
  });

  it.each([{ label: 'empty trades', view: { trades: [], funding: '0' } }, { label: 'missing funding', view: { trades: [], funding: null } }])('counts $label as failure without known realized PnL', async ({ view }) => {
    let now = 1800000000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = setup(); const t = closed(f.store); f.settlement.mockResolvedValue(view);
    for (let n = 0; n < 4; n++) { await f.internal.settlePending(); now += 180000; }
    expect(f.settlement).toHaveBeenCalledTimes(3);
    expect(f.store.thread(t.id)!.realized_pnl).toBeNull();
    expect(JSON.parse(f.store.kvGet(`settlement-retry:v1:paper:${t.id}`)!)).toMatchObject({ tries: 3 });
  });

  it('waiting for future grace consumes no attempt and a complete result resets failure state', async () => {
    let now = 1800000000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = setup(); const t = closed(f.store, now - 1000);
    await f.internal.settlePending(); expect(f.settlement).not.toHaveBeenCalled(); expect(f.store.kvGet(`settlement-retry:v1:paper:${t.id}`)).toBeNull();
    now += 120000; await f.internal.settlePending(); expect(f.settlement).toHaveBeenCalledOnce();
    now += 60000;
    f.settlement.mockResolvedValue({ trades: [{ time: t.closed_at!, side: 'SELL', price: '110', qty: '1', realized_pnl: '10', commission: '0.1' }], funding: '0' });
    await f.internal.settlePending();
    expect(f.store.thread(t.id)!.realized_pnl).toBe('9.90000000');
    expect(JSON.parse(f.store.kvGet(`settlement-retry:v1:paper:${t.id}`)!)).toMatchObject({ tries: 0 });
    now += 60000; await f.internal.settlePending(); expect(f.settlement).toHaveBeenCalledTimes(2);
  });
});
