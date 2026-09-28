import { describe, expect, it, vi } from 'vitest';
import { DirectAgentReads, isDirectRead, rustReadBridge, type ReadBridge } from '../../src/demo/direct-agent-reads.js';

import { AgentMcpBackend } from '../../src/demo/execution-agent.js';

const DAY = 86_400_000;
function fixture(now = 10 * DAY + 12 * 3_600_000) {
  let clock = now; let namespace = 'auth-one';
  const state = new Map<string, string>();
  const data = { account: { totalMarginBalance: '1000.00000001', availableBalance: '950', totalUnrealizedProfit: '-0.00000001' }, positions: [], orders: [], algos: [] };
  const bridge = vi.fn<ReadBridge>(async req => req.op === 'status' ? { namespace } : { namespace, observed_at: clock, data });
  const storage = { get: (key: string) => state.get(key) ?? null, set: (key: string, value: string) => { state.set(key, value); } };
  const reads = new DirectAgentReads(bridge, storage, () => clock);
  return { reads, bridge, storage, state, data, now: () => clock, advance: (ms: number) => { clock += ms; }, auth: (next: string) => { namespace = next; } };
}
function trade(id: number, time: number) { return { symbol: 'BTCUSDT', commissionAsset: 'USDT', id, orderId: 123, time, side: 'BUY', price: '123.456789123456789', qty: '0.01', realizedPnl: '-0.100000000000000001', commission: '0.0001', positionSide: 'BOTH' }; }

describe('DirectAgentReads', () => {
  it('normalizes positions and both order types without losing decimal precision', async () => {
    const f = fixture();
    Object.assign(f.data, {
      positions: [{ symbol: 'BTCUSDT', positionAmt: '-0.001', positionSide: 'BOTH', entryPrice: '123456.123456789', markPrice: '123457', unRealizedProfit: '-0.00000001', leverage: '3' }, { positionAmt: '0' }],
      orders: [{ symbol: 'BTCUSDT', clientOrderId: 'entry', type: 'LIMIT', side: 'BUY', origQty: '0.001', price: '123456.123456789', stopPrice: '0', reduceOnly: false, status: 'NEW' }],
      algos: [{ symbol: 'BTCUSDT', clientAlgoId: 'stop', orderType: 'STOP_MARKET', side: 'BUY', closePosition: true, triggerPrice: '124000', algoStatus: 'NEW' }],
    });
    const out = await f.reads.run({ op: 'account' });
    expect(out.account).toMatchObject({ equity: '1000.00000001', positions: [{ side: 'short', qty: '0.001', entry_price: '123456.123456789', leverage: 3 }], open_orders: [{ client_order_id: 'entry', price: '123456.123456789', stop_price: null }, { client_order_id: 'stop', qty: '0', reduce_only: true, stop_price: '124000' }] });
  });

  it('persists validated account cache and preserves observation time through restart and TTL', async () => {
    const f = fixture(); const original = await f.reads.run({ op: 'account' });
    f.advance(14_999);
    const restarted = new DirectAgentReads(f.bridge, f.storage, f.now);
    expect(await restarted.run({ op: 'account' })).toEqual(original);
    expect(f.bridge.mock.calls.filter(([r]) => r.op === 'account')).toHaveLength(1);
    f.advance(1); await restarted.run({ op: 'account' });
    expect(f.bridge.mock.calls.filter(([r]) => r.op === 'account')).toHaveLength(2);
  });

  it('isolates caches by current authorization and rejects auth rotation during a read', async () => {
    const f = fixture(); await f.reads.run({ op: 'account' });
    f.auth('auth-two'); await f.reads.run({ op: 'account' });
    expect(f.bridge.mock.calls.filter(([r]) => r.op === 'account')).toHaveLength(2);
    expect(f.state.size).toBe(2);
    f.auth('auth-three');
    f.bridge.mockImplementation(async r => r.op === 'status' ? { namespace: 'auth-three' } : { namespace: 'auth-four', observed_at: f.now(), data: f.data });
    await expect(f.reads.run({ op: 'account' })).rejects.toThrow(/授权发生变化/);
    expect(f.state.size).toBe(2);
  });

  it('coalesces concurrent reads while rejecting errors without caching or model fallback', async () => {
    const f = fixture(); let release!: () => void;
    const pending = new Promise<void>(r => { release = r; });
    f.bridge.mockImplementation(async r => {
      if (r.op === 'status') return { namespace: 'auth-one' };
      await pending; return { namespace: 'auth-one', observed_at: f.now(), data: f.data };
    });
    const a = f.reads.run({ op: 'account' }); const b = f.reads.run({ op: 'account' });
    await Promise.resolve(); release();
    expect(await a).toEqual(await b);
    expect(f.bridge.mock.calls.filter(([r]) => r.op === 'account')).toHaveLength(1);
    f.advance(15_000);
    f.bridge.mockImplementation(async r => { if (r.op === 'status') return { namespace: 'auth-one' }; throw new Error('auth_required'); });
    await expect(f.reads.run({ op: 'account' })).rejects.toThrow('auth_required');
    expect(f.bridge.mock.calls.every(([r]) => ['status', 'account'].includes(String(r.op)))).toBe(true);
    f.bridge.mockImplementation(async r => r.op === 'status' ? { namespace: 'auth-one' } : { namespace: 'auth-one', observed_at: f.now(), data: f.data });
    await expect(f.reads.run({ op: 'account' })).resolves.toHaveProperty('ok', true);
  });

  it.each(['positions', 'orders', 'algos'] as const)('rejects incomplete account %s without persistence', async missing => {
    const f = fixture(); delete (f.data as Record<string, unknown>)[missing];
    await expect(f.reads.run({ op: 'account' })).rejects.toThrow(/完整列表/);
    expect(f.state.size).toBe(0);
  });

  it('fetches inclusive day windows, filters boundaries, deduplicates IDs and sums exact funding', async () => {
    const f = fixture(); const start = 7 * DAY + 100; const end = 8 * DAY + 100;
    f.bridge.mockImplementation(async r => r.op === 'status' ? { namespace: 'auth-one' } : { namespace: 'auth-one', observed_at: f.now(), data: {
      trades: [trade(1, start - 1), trade(2, start), trade(2, start), trade(3, end), trade(4, end + 1)],
      funding: [{ symbol: 'BTCUSDT', incomeType: 'FUNDING_FEE', asset: 'USDT', tranId: 1, time: start, income: '0.100000000000000001' }, { symbol: 'BTCUSDT', incomeType: 'FUNDING_FEE', asset: 'USDT', tranId: 1, time: start, income: '0.100000000000000001' }, { symbol: 'BTCUSDT', incomeType: 'FUNDING_FEE', asset: 'USDT', tranId: 2, time: end, income: '-0.1' }],
    } });
    const out = await f.reads.run({ op: 'settlement', symbol: 'BTCUSDT', start_ms: start, end_ms: end });
    expect(f.bridge.mock.calls.filter(([r]) => r.op === 'settlement').map(([r]) => [r.start_ms, r.end_ms])).toEqual([[7 * DAY, 8 * DAY - 1], [8 * DAY, 9 * DAY - 1]]);
    expect((out.trades as unknown[])).toHaveLength(2); expect(out.funding_total).toBe('0.000000000000000001');
    expect((out.funding as unknown[])).toHaveLength(2);
    await f.reads.run({ op: 'settlement', symbol: 'BTCUSDT', start_ms: start + 1, end_ms: end - 1 });
    expect(f.bridge.mock.calls.filter(([r]) => r.op === 'settlement')).toHaveLength(2);
  });

  it('never caches an incomplete settlement response as an empty successful result', async () => {
    const f = fixture();
    f.bridge.mockImplementation(async r => r.op === 'status' ? { namespace: 'auth-one' } : { namespace: 'auth-one', observed_at: f.now(), data: { trades: [] } });
    await expect(f.reads.run({ op: 'settlement', symbol: 'BTCUSDT', start_ms: 7 * DAY, end_ms: 7 * DAY + 1 })).rejects.toThrow(/完整列表/);
    expect(f.state.size).toBe(0);
  });

  it('refetches current-day cache if the requested interval extends past its fetched coverage', async () => {
    const f = fixture(); let id = 0;
    f.bridge.mockImplementation(async r => r.op === 'status' ? { namespace: 'auth-one' } : { namespace: 'auth-one', observed_at: f.now(), data: { trades: [trade(++id, f.now())], funding: [] } });
    await f.reads.run({ op: 'settlement', symbol: 'BTCUSDT', start_ms: 10 * DAY, end_ms: f.now() });
    f.advance(60_000);
    const out = await f.reads.run({ op: 'settlement', symbol: 'BTCUSDT', start_ms: 10 * DAY, end_ms: f.now() });
    expect(f.bridge.mock.calls.filter(([r]) => r.op === 'settlement')).toHaveLength(2);
    expect(out.trades).toEqual([expect.objectContaining({ id: '2' })]);
  });

  it('does not coalesce a wider settlement window into an older in-flight window', async () => {
    const f = fixture(); let release!: () => void; let started!: () => void;
    const pending = new Promise<void>(r => { release = r; }); const firstStarted = new Promise<void>(r => { started = r; });
    let calls = 0;
    f.bridge.mockImplementation(async r => {
      if (r.op === 'status') return { namespace: 'auth-one' };
      const id = ++calls; const observed = f.now();
      if (id === 1) { started(); await pending; }
      return { namespace: 'auth-one', observed_at: observed, data: { trades: [trade(id, Number(r.end_ms))], funding: [] } };
    });
    const first = f.reads.run({ op: 'settlement', symbol: 'BTCUSDT', start_ms: 10 * DAY, end_ms: f.now() });
    await firstStarted; f.advance(60_000);
    const second = f.reads.run({ op: 'settlement', symbol: 'BTCUSDT', start_ms: 10 * DAY, end_ms: f.now() });
    await Promise.resolve(); release();
    await first; const out = await second;
    expect(calls).toBe(2); expect(out.trades).toEqual([expect.objectContaining({ id: '2' })]);
  });

  it('rejects writes before invoking the bridge and treats execution-sensitive reads as uncached', async () => {
    const f = fixture();
    expect(isDirectRead('place_order')).toBe(false);
    await expect(f.reads.run({ op: 'place_order' })).rejects.toThrow(/不允许/);
    expect(f.bridge).not.toHaveBeenCalled();
    f.bridge.mockImplementation(async r => r.op === 'status' ? { namespace: 'auth-one' } : { namespace: 'auth-one', observed_at: f.now(), data: { status: 'FILLED', executedQty: '0.1', avgPrice: '100' } });
    await f.reads.run({ op: 'get_order', symbol: 'BTCUSDT', client_order_id: 'entry' });
    await f.reads.run({ op: 'get_order', symbol: 'BTCUSDT', client_order_id: 'entry' });
    expect(f.bridge.mock.calls.filter(([r]) => r.op === 'get_order')).toHaveLength(2);
    expect(f.state.size).toBe(0);
  });

  it('rejects a settlement end in the future instead of claiming complete clipped coverage', async () => {
    const f = fixture();
    f.bridge.mockImplementation(async r => r.op === 'status' ? { namespace: 'auth-one' } : { namespace: 'auth-one', observed_at: f.now(), data: { trades: [], funding: [] } });
    await expect(f.reads.run({ op: 'settlement', symbol: 'BTCUSDT', start_ms: f.now() - 1000, end_ms: f.now() + 60_000 })).rejects.toThrow();
    expect(f.state.size).toBe(0);
  });

  it.each([{ leverage: '' }, { leverage: false }, { leverage: [] }])('rejects malformed integer leverage $leverage without caching', async ({ leverage }) => {
    const f = fixture();
    Object.assign(f.data, { positions: [{ symbol: 'BTCUSDT', positionAmt: '0.1', positionSide: 'LONG', entryPrice: '100', markPrice: '100', unRealizedProfit: '0', leverage }] });
    await expect(f.reads.run({ op: 'account' })).rejects.toThrow();
    expect(f.state.size).toBe(0);
  });

  it('missing Rust helper fails closed without launching a model', async () => {
    await expect(rustReadBridge('/nonexistent/trade-gate-test-direct-read-bin')({ op: 'account' })).rejects.toThrow(/不会回退到模型/);
  });
});


describe('AgentMcpBackend direct-read integration', () => {
  it('does not fall back to model spawning on deterministic read/auth failure', async () => {
    const f = fixture(); const spawn = vi.fn(async () => { throw new Error('model must not run'); });
    f.bridge.mockRejectedValue(new Error('auth_required'));
    const backend = new AgentMcpBackend({ cli: 'claude', model: 'sonnet', reads: f.reads, spawnFn: spawn, log: () => {} });
    await expect(backend.account()).rejects.toThrow('auth_required');
    expect(spawn).not.toHaveBeenCalled(); expect(backend.runCount).toBe(0);
  });

  it('does not hide authorization changes behind the legacy account cache', async () => {
    const f = fixture(); const spawn = vi.fn(async () => { throw new Error('model must not run'); });
    const backend = new AgentMcpBackend({ cli: 'claude', model: 'sonnet', reads: f.reads, spawnFn: spawn, log: () => {} });
    await backend.account(); f.auth('auth-new-account'); f.data.account.totalMarginBalance = '2000';
    expect((await backend.account()).equity).toBe('2000.00'); expect(spawn).not.toHaveBeenCalled();
  });

  it('invalidating account after a write invalidates both account cache layers', async () => {
    const f = fixture(); const spawn = vi.fn(async () => { throw new Error('model must not run'); });
    const backend = new AgentMcpBackend({ cli: 'claude', model: 'sonnet', reads: f.reads, spawnFn: spawn, log: () => {} });
    await backend.account(); f.data.account.totalMarginBalance = '999';
    backend.invalidateAccount();
    expect((await backend.account()).equity).toBe('999.00'); expect(spawn).not.toHaveBeenCalled();
  });
});


it('post-write account refresh does not join an obsolete in-flight read or retain its stale cache', async () => {
  const f = fixture(); let release!: () => void; let started!: () => void;
  const pending = new Promise<void>(r => { release = r; }); const firstStarted = new Promise<void>(r => { started = r; });
  let calls = 0;
  f.bridge.mockImplementation(async r => {
    if (r.op === 'status') return { namespace: 'auth-one' };
    const id = ++calls; const data = structuredClone(f.data); data.account.totalMarginBalance = id === 1 ? '1000' : '999';
    if (id === 1) { started(); await pending; }
    return { namespace: 'auth-one', observed_at: f.now(), data };
  });
  const backend = new AgentMcpBackend({ cli: 'claude', model: 'sonnet', reads: f.reads, log: () => {}, spawnFn: async () => { throw new Error('model must not run'); } });
  const old = backend.account(); await firstStarted; backend.invalidateAccount();
  const fresh = await backend.account(); expect(fresh.equity).toBe('999.00'); expect(calls).toBe(2);
  release(); expect((await old).equity).toBe('1000.00');
  expect((await backend.account()).equity).toBe('999.00'); expect(calls).toBe(2);
});

it('backend quota latch prevents repeated model spawns across restart while direct reads work until manual reset', async () => {
  const f = fixture();
  const spawn = vi.fn(async () => ({ stdout: '', stderr: "You've hit your limit · resets 7pm", code: 1, timedOut: false, spawnError: null }));
  const opts = { cli: 'claude' as const, model: 'sonnet', reads: f.reads, state: f.storage, log: () => {}, scratchDir: '/tmp', spawnFn: spawn };
  const first = new AgentMcpBackend(opts);
  await first.cancelAll('BTCUSDT'); expect(spawn).toHaveBeenCalledOnce();
  await first.cancelAll('BTCUSDT'); expect(spawn).toHaveBeenCalledOnce();
  const restarted = new AgentMcpBackend(opts);
  await restarted.cancelAll('BTCUSDT'); expect(spawn).toHaveBeenCalledOnce();
  expect((await restarted.account()).equity).toBe('1000.00'); expect(spawn).toHaveBeenCalledOnce();
  restarted.resetModelBudget(); await restarted.cancelAll('BTCUSDT'); expect(spawn).toHaveBeenCalledTimes(2);
});
