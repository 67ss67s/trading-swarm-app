// v3.11 (§9.20): the gateway verifies its own protective leg with a canary and unblocks itself — no env var, no restart.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend, type OpenWithProtectionReceipt, type OpenWithProtectionRequest, type ProtectionCapability } from '../../src/demo/execution.js';
import { newThread } from '../../src/demo/threads.js';
import { stubBrain } from '../../src/demo/brain.js';
import type { Backend } from '../../src/demo/types.js';
import { startFakeOkxServer } from './helpers/fake-okx-server.js';
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

/** Paper simulator wearing the agent_mcp hat: unverified until a canary passes; algo query/cancel are scriptable. */
class FakeAgentBackend extends PaperBackend {
  override readonly kind = 'agent_mcp' as Backend;
  algoSeen: boolean | null = true;
  cancelOk = true;
  protectionCapability(): ProtectionCapability {
    return 'unverified';
  }
  async openWithProtection(req: OpenWithProtectionRequest): Promise<OpenWithProtectionReceipt> {
    const entry = await this.placeEntry(req);
    const stop = await this.placeStop(req.symbol, req.direction, req.stop_price, req.stop_client_algo_id);
    return { entry: { ...entry, executed_qty: req.qty, order_id: '1' }, stop: { outcome: stop.outcome === 'failed' ? 'failed' : 'submitted', algo_id: '77', error: stop.error }, tp: { outcome: 'skipped', algo_id: null, error: null } };
  }
  async algoOrderExists(): Promise<boolean | null> {
    return this.algoSeen;
  }
  /** 残留条件单:纸面模拟器里就是这个币的挂单(金丝雀止损也在里面) */
  async listAlgoOrders(symbol: string): Promise<{ client_algo_id: string; algo_id: string | null }[] | null> {
    return (await this.account()).open_orders.filter((o) => o.symbol === symbol).map((o) => ({ client_algo_id: o.client_order_id, algo_id: null }));
  }
  async cancelAlgoOrder(symbol: string, id: string): Promise<{ ok: boolean; error: string | null }> {
    if (!this.cancelOk) return { ok: false, error: 'simulated cancel failure' };
    return this.cancelOrder(symbol, id);
  }
}

let state: StateDb | null = null;
let rt: InstanceType<typeof DemoRuntime> | null = null;
async function setup(): Promise<{ rt: InstanceType<typeof DemoRuntime>; backend: FakeAgentBackend; store: DemoStore }> {
  state = openStateDb(':memory:');
  const store = new DemoStore(state);
  const backend = new FakeAgentBackend(10_000);
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

describe('verifyProtection', () => {
  it('starts unverified (alert carries a clickable action), passes the canary, persists the record, unblocks', async () => {
    const { rt, store } = await setup();
    expect(rt.protectionStatus().status).toBe('unverified');
    expect(rt.protectionOk()).toBe(true);
    const acct = await rt['backend'].account();
    rt.evaluateTeamRisk(acct);
    // never_verified 不再产生 protection_never_verified 风险告警
    const alert = store.risk.open().find((a) => a.kind === 'protection_never_verified' && a.scope.startsWith('channel:'));
    expect(alert).toBeFalsy();
    const st = await rt.verifyProtection({ symbol: 'BTCUSDT' });
    expect(st.status).toBe('verified');
    expect(st.source).toBe('record');
    expect(st.steps.every((s) => s.ok)).toBe(true);
    expect(st.steps.map((s) => s.name)).toEqual(['账户读取', '清旧条件单', '算最小仓', '市价开最小仓', '挂 closePosition 止损', '交易所确认止损挂着', '撤止损', '平仓', '确认已平']);
    expect(rt.protectionCreds.get('agent_mcp', 'BTCUSDT')).toMatchObject({ symbol: 'BTCUSDT', last_probe_ok: true });
    expect(rt.protectionOk()).toBe(true);
    expect(rt.protectionState('BTCUSDT')).toBe('verified');
    const after = await rt['backend'].account();
    expect(after.positions).toEqual([]);
    expect(after.open_orders).toEqual([]);
    rt.evaluateTeamRisk(after);
    // 09-20:合并成按通道一条后,观察列表里别的币还没验时这条仍会开着,但 BTCUSDT 必须已经不在里面
    expect(store.risk.open().some((a) => a.kind === 'protection_never_verified' && a.refs.includes('BTCUSDT'))).toBe(false);
  });

  it('a stop the exchange cannot see fails the canary, cleans up (cancel + close), stays blocked with the reason; a live stop failure later invalidates the record', async () => {
    const { rt, backend, store } = await setup();
    backend.algoSeen = false;
    const st = await rt.verifyProtection({ symbol: 'BTCUSDT' });
    expect(st.status).toBe('failed');
    expect(st.last_error).toMatch(/查不到/);
    expect(st.steps.find((s) => s.name === '善后平仓')?.ok).toBe(true);
    expect(rt.protectionOk()).toBe(true);
    expect((await backend.account()).positions).toEqual([]);
    backend.algoSeen = true;
    expect((await rt.verifyProtection({ symbol: 'BTCUSDT' })).status).toBe('verified');
    // 线上真挂止损失败只把这个币降到第二态(warn 不挡 + 自动重验),不作废整条通道
    rt.markProtectionProbe('BTCUSDT', false, '线上挂止损失败:schema');
    expect(rt.protectionState('BTCUSDT')).toBe('verified_stale_or_probe_failed');
    expect(rt.protectionStatus().status).toBe('failed');
    expect(rt.protectionCreds.get('agent_mcp', 'BTCUSDT')).toMatchObject({ last_probe_ok: false, last_error: '线上挂止损失败:schema' });
    expect(store.risk.list({ status: 'all' }).length).toBeGreaterThanOrEqual(0);
  });

  it('adopts an ownerless position (e.g. a canary orphaned by a restart) instead of refusing: skips the entry, verifies the stop, closes it', async () => {
    const { rt, backend, store } = await setup();
    // 裸仓:直接在后端开一张,不经过任何线程 —— 就是 09-06 网关重启留下的那种
    const e = await backend.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.001', entry: 'market', limit_price: null, client_order_id: 'orphan-1' });
    expect(e.outcome).toBe('filled');
    // 上次金丝雀残留的止损也还挂着(真实事故里交易所因此拒了新止损 -4130)
    expect((await backend.placeStop('BTCUSDT', 'long', '1', 'tgd-vfy-old-s')).outcome).toBe('submitted');
    expect((await backend.account()).positions.map((p) => p.symbol)).toEqual(['BTCUSDT']);
    const st = await rt.verifyProtection({ symbol: 'BTCUSDT' });
    expect(st.status).toBe('verified');
    expect(st.steps.find((s) => s.name === '账户读取')?.detail).toMatch(/无主持仓/);
    expect(st.steps.find((s) => s.name === '清旧条件单')?.detail).toMatch(/tgd-vfy-old-s/);
    expect(st.steps.find((s) => s.name === '市价开最小仓')?.detail).toMatch(/跳过/);
    expect(st.steps.every((s) => s.ok)).toBe(true);
    expect(rt.protectionCreds.get('agent_mcp', 'BTCUSDT')).toMatchObject({ symbol: 'BTCUSDT', last_probe_ok: true });
    expect((await backend.account()).positions).toEqual([]);
  });
});


describe('unknown stop recovery', () => {
  it.each([
    { seen: true, retry: 'submitted', error: null, closed: false, invalidated: false },
    { seen: false, retry: 'submitted', error: null, closed: false, invalidated: false },
    { seen: false, retry: 'failed', error: '-4111', closed: false, invalidated: false },
    { seen: null, retry: 'submitted', error: null, closed: false, invalidated: false },
    { seen: false, retry: 'unknown', error: 'timed out', closed: true, invalidated: false },
    { seen: false, retry: 'failed', error: 'fetch failed', closed: true, invalidated: false },
    { seen: false, retry: 'failed', error: '-2021 Order would immediately trigger.', closed: true, invalidated: true },
    { seen: false, retry: 'failed', error: '-2022 ReduceOnly', closed: true, invalidated: false },
  ] as const)('exists=$seen retry=$retry error=$error', async ({ seen, retry, error, closed, invalidated }) => {
    const { rt, backend, store } = await setup();
    expect((await rt.verifyProtection({ symbol: 'BTCUSDT' })).status).toBe('verified');
    const thread = { ...newThread({ id: 'thr-transport', backend: 'agent_mcp', symbol: 'BTCUSDT', side: 'long', source: 'manual', timeframe: '15m', thesis: 'test', invalidation_text: null, watch_conditions: [], entry: { type: 'market', price: null, zone: null }, stop_price: '1', take_profits: [], qty: '0.001', margin_usdt: null, leverage: 3, margin_mode: 'cross', now: Date.now() }), status: 'in_position' as const };
    store.saveThread(thread);
    backend.algoSeen = seen;
    const query = vi.spyOn(backend, 'algoOrderExists');
    const plain = vi.spyOn(backend, 'getOrder');
    const resend = vi.spyOn(backend, 'placeStop').mockResolvedValue({ outcome: retry, error, receipt: null, avg_price: null });
    const close = vi.spyOn(backend, 'closePosition').mockResolvedValue({ closed: true, error: null });
    const probe = vi.spyOn(rt, 'markProtectionProbe');
    await rt['placeProtection'](thread, 'test', { stop: { id: 'tgd-transport-s1', receipt: { outcome: 'unknown', error: 'Socket connection closed unexpectedly before a response was received; result not confirmed.', receipt: null, avg_price: null } } });
    expect(query).toHaveBeenCalledWith('BTCUSDT', 'tgd-transport-s1', 'perp');
    expect(plain).not.toHaveBeenCalled();
    expect(resend).toHaveBeenCalledTimes(seen === false ? 1 : 0);
    if (seen === false) expect(resend).toHaveBeenCalledWith('BTCUSDT', 'long', '1', 'tgd-transport-s1', 'perp');
    expect(close).toHaveBeenCalledTimes(closed ? 1 : 0);
    // 09-12:真挂失败只降这个币的凭证(last_probe_ok=false),不作废整条通道
    expect(probe.mock.calls.filter((c) => c[1] === false).length).toBe(invalidated ? 1 : 0);
    expect(rt.protectionCreds.get('agent_mcp', 'BTCUSDT')?.last_probe_ok).toBe(invalidated ? false : true);
    expect(rt.protectionState('BTCUSDT')).toBe(invalidated ? 'verified_stale_or_probe_failed' : 'verified');
    expect(store.thread(thread.id)?.status).toBe(closed ? 'closed' : 'in_position');
    expect(store.thread(thread.id)?.attention).toBe(seen === null ? 'PROTECTION_MISSING' : null);
    if (!closed && seen !== null) expect(store.thread(thread.id)?.protection_client_order_ids).toContain('tgd-transport-s1');
  });
});

describe('简单模式永续前置拒绝', () => {
  it('手工与保护金丝雀均在下单前拒绝,没有 CLI/下单副作用', async () => {
    const { rt, backend, store } = await setup();
    Object.defineProperty(backend, 'kind', { value: 'okx' });
    vi.spyOn(backend, 'marketsSupported').mockReturnValue(['spot']);
    const entry = vi.spyOn(backend, 'placeEntry');
    const protectedEntry = vi.spyOn(backend, 'openWithProtection');
    await expect(rt.manualOrder({ symbol: 'BTCUSDT', market: 'perp', side: 'long', action: 'open', type: 'market', qty: '0.001', sl: '75000' })).rejects.toThrow('perp_unavailable_account_mode');
    await expect(rt.verifyProtection({ symbol: 'BTCUSDT', market: 'perp' })).rejects.toThrow('perp_unavailable_account_mode');
    expect(entry).not.toHaveBeenCalled(); expect(protectedEntry).not.toHaveBeenCalled();
    expect(store.threads()).toHaveLength(0);
  });
});


describe('spot protection canary', () => {
  it('最小买入→条件止损→确认→撤单→卖回,凭据不放行 perp', async () => {
    const fakeSpot = await startFakeOkxServer();
    process.env['TG_EXCHANGE'] = 'okx'; process.env['TG_OKX_REST_BASE'] = fakeSpot.url;
    state = openStateDb(':memory:');
    const store = new DemoStore(state);
    const backend = Object.assign(new PaperBackend(), {
      protectionCapability: (): ProtectionCapability => 'unverified',
      algoOrderExists: async (symbol: string, id: string, market = 'perp') => (await backend.account()).open_orders.some(o => o.symbol === symbol && o.market === market && o.client_order_id === id),
    });
    Object.defineProperty(backend, 'kind', { value: 'okx' });
    rt = new DemoRuntime({ store, backend, brains: { stub: stubBrain() }, marketPollMs: 600000, accountPollMs: 600000 });
    rt.setWorkflow({ markets: ['perp', 'spot'], watchlist: ['BTCUSDT'] });
    try {
      await rt.start();
      const entry = vi.spyOn(backend, 'placeEntry'); const stop = vi.spyOn(backend, 'placeStop');
      const cancel = vi.spyOn(backend, 'cancelOrder'); const close = vi.spyOn(backend, 'closePosition');
      const leverage = vi.spyOn(backend, 'setLeverage');
      await rt.verifyProtection({ symbol: 'BTCUSDT', market: 'spot' });
      expect(entry).toHaveBeenCalledWith(expect.objectContaining({ market: 'spot', direction: 'long' }));
      expect(stop).toHaveBeenCalledWith('BTCUSDT', 'long', expect.any(String), expect.any(String), 'spot');
      expect(cancel).toHaveBeenCalledWith('BTCUSDT', expect.any(String), 'spot');
      expect(close).toHaveBeenCalledWith('BTCUSDT', expect.any(String), 'spot');
      expect(leverage).not.toHaveBeenCalled();
      expect(rt.protectionCreds.get('okx', 'BTCUSDT', 'spot')).toMatchObject({ market: 'spot', last_probe_ok: true });
      expect(rt.protectionState('BTCUSDT', 'spot')).toBe('not_needed');
      expect(rt.protectionStatus().credentials).toContainEqual(expect.objectContaining({ symbol: 'BTCUSDT', market: 'spot', state: 'verified' }));
      expect(rt.protectionState('BTCUSDT', 'perp')).toBe('never_verified');
      expect((await backend.account()).positions).toHaveLength(0);
    } finally { await rt.stop(); rt = null; delete process.env['TG_EXCHANGE']; delete process.env['TG_OKX_REST_BASE']; await fakeSpot.close(); }
  });
});
