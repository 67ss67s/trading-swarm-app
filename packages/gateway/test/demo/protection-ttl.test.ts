// 09-12 §9.31:保护能力是**有期限的凭证**(通道 × 交易对),不是一次性标记。
// 三态:never_verified(阻断这个币的新开仓)/ verified_stale_or_probe_failed(warn + 自动重验)/ verified。
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend, type OpenWithProtectionReceipt, type OpenWithProtectionRequest, type ProtectionCapability } from '../../src/demo/execution.js';
import { stubBrain } from '../../src/demo/brain.js';
import { DAY_MS, legacyProtectionKey, ProtectionCredentials, PROTECTION_CREDENTIALS_KEY, verifyStopReceipt } from '../../src/demo/protection.js';
import { newThread } from '../../src/demo/threads.js';
import type { Backend } from '../../src/demo/types.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';

let fakeMarket: FakeMarketServer;
let DemoRuntime: typeof import('../../src/demo/runtime.js').DemoRuntime;
let createServer: typeof import('../../src/demo/http.js').createServer;
beforeAll(async () => {
  fakeMarket = await startFakeMarketServer();
  process.env['TG_DEMO_MARKET_BASE'] = fakeMarket.url;
  ({ DemoRuntime } = await import('../../src/demo/runtime.js'));
  ({ createServer } = await import('../../src/demo/http.js'));
});
afterAll(async () => {
  await fakeMarket.close();
  delete process.env['TG_DEMO_MARKET_BASE'];
});

/** 纸面模拟器戴 agent_mcp 的帽子:凭证说了算(protectionCapability 永远 unverified,不走 env 覆盖)。 */
class FakeAgentBackend extends PaperBackend {
  override readonly kind = 'agent_mcp' as Backend;
  protectionCapability(): ProtectionCapability {
    return 'unverified';
  }
  async openWithProtection(req: OpenWithProtectionRequest): Promise<OpenWithProtectionReceipt> {
    const entry = await this.placeEntry(req);
    const stop = await this.placeStop(req.symbol, req.direction, req.stop_price, req.stop_client_algo_id);
    return { entry: { ...entry, executed_qty: req.qty, order_id: '1' }, stop: { outcome: stop.outcome === 'failed' ? 'failed' : 'submitted', algo_id: '77', error: stop.error }, tp: { outcome: 'skipped', algo_id: null, error: null } };
  }
  async algoOrderExists(): Promise<boolean | null> {
    return true;
  }
  async listAlgoOrders(symbol: string): Promise<{ client_algo_id: string; algo_id: string | null }[] | null> {
    return (await this.account()).open_orders.filter((o) => o.symbol === symbol).map((o) => ({ client_algo_id: o.client_order_id, algo_id: null }));
  }
  async cancelAlgoOrder(symbol: string, id: string): Promise<{ ok: boolean; error: string | null }> {
    return this.cancelOrder(symbol, id);
  }
}

type RT = InstanceType<typeof DemoRuntime>;
let state: StateDb | null = null;
let rt: RT | null = null;
let server: http.Server | null = null;
let baseUrl = '';

async function setup(opts: { watchlist?: string[]; serve?: boolean } = {}): Promise<{ rt: RT; backend: FakeAgentBackend; store: DemoStore }> {
  state = openStateDb(':memory:');
  const store = new DemoStore(state);
  const backend = new FakeAgentBackend(10_000);
  rt = new DemoRuntime({ store, backend, brains: { stub: stubBrain() }, marketPollMs: 600_000, accountPollMs: 600_000 });
  await rt.start();
  rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: opts.watchlist ?? ['BTCUSDT', 'ETHUSDT'] });
  if (opts.serve) {
    server = createServer(rt, store);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  return { rt, backend, store };
}
afterEach(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server!.close(() => r()));
  }
  if (rt) await rt.stop();
  state?.close();
  server = null;
  rt = null;
  state = null;
  baseUrl = '';
});
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as unknown) : null };
}

describe('凭证三态', () => {
  it('从没验过 = never_verified 并按币阻断开新仓;验过 = verified;过期或真挂失败 = 第二态(不挡)', async () => {
    const { rt, backend } = await setup();
    const now = Date.now();
    expect(rt.protectionState('BTCUSDT')).toBe('never_verified');
    const acct = await backend.account();
    // never_verified 不再阻断开新仓
    expect(rt['preflightOpen']('BTCUSDT', acct).join(';')).not.toMatch(/从没验证过能挂止损/);
    rt.protectionCreds.recordVerified('agent_mcp', 'ETHUSDT', now, 7);
    expect(rt.protectionState('ETHUSDT')).toBe('verified');
    expect(rt['preflightOpen']('ETHUSDT', acct).join(';')).not.toMatch(/从没验证过/);
    // 一个月前验过的 ≠ 昨天验过的:7 天前的凭证就是过期态
    rt.protectionCreds.recordVerified('agent_mcp', 'ETHUSDT', now - 8 * DAY_MS, 7);
    expect(rt.protectionState('ETHUSDT')).toBe('verified_stale_or_probe_failed');
    expect(rt['preflightOpen']('ETHUSDT', acct).join(';')).not.toMatch(/从没验证过/); // 第二态 warn 不挡
    // ttl 是现算的:调到 30 天,同一条凭证又活了
    rt.setWorkflow({ protection_ttl_days: 30 });
    expect(rt.protectionState('ETHUSDT')).toBe('verified');
    // 最近一次真挂止损失败 → 第二态(和「从没验过」不再是同一个处理)
    rt.markProtectionProbe('ETHUSDT', false, '-4130');
    expect(rt.protectionState('ETHUSDT')).toBe('verified_stale_or_probe_failed');
    expect(rt.protectionState('BTCUSDT')).toBe('never_verified');
  });

  it('真挂止损失败只降这个币,不作废整条通道(通道级凭证与其它币的凭证不受影响)', async () => {
    const { rt } = await setup();
    const now = Date.now();
    rt.protectionCreds.recordVerified('agent_mcp', 'ETHUSDT', now, 7);
    rt.store.kvSet(legacyProtectionKey('agent_mcp'), JSON.stringify({ at: now, symbol: 'SOLUSDT' }));
    expect(rt.protectionState('BTCUSDT')).toBe('verified'); // 通道级兜底
    rt.markProtectionProbe('BTCUSDT', false, '线上挂止损失败:-2021');
    expect(rt.protectionState('BTCUSDT')).toBe('verified_stale_or_probe_failed');
    expect(rt.protectionCreds.get('agent_mcp', 'BTCUSDT')).toMatchObject({ last_probe_ok: false, last_error: '线上挂止损失败:-2021' });
    // 通道级凭证与 ETH 的凭证都还在
    expect(rt.protectionCreds.get('agent_mcp', null)?.last_probe_ok).toBe(true);
    expect(rt.protectionState('ETHUSDT')).toBe('verified');
  });

  it('真挂止损成功 = 比金丝雀更硬的证据,凭证顺手续期', async () => {
    const { rt } = await setup();
    rt.protectionCreds.recordVerified('agent_mcp', 'BTCUSDT', Date.now() - 6 * DAY_MS, 7);
    rt.markProtectionProbe('BTCUSDT', true, null);
    const c = rt.protectionCreds.get('agent_mcp', 'BTCUSDT')!;
    expect(c.last_probe_ok).toBe(true);
    expect(Date.now() - c.verified_at).toBeLessThan(5_000);
  });
});

describe('v3.11 旧记录迁移', () => {
  it('protection_verified:<channel> → 通道级(无 symbol)凭证,verified_at = 当初写入时间,按 7 天算过期', async () => {
    const { rt, store } = await setup();
    const wrote = Date.now() - 30 * DAY_MS;
    store.kvSet(legacyProtectionKey('agent_mcp'), JSON.stringify({ at: wrote, symbol: 'HYPEUSDT', qty: '1', algo_id: 'x' }));
    // 首次读到:一个月前验的凭证按 7 天 ttl 就是过期态(不是 verified,也不是 never_verified)
    expect(rt.protectionState('BTCUSDT')).toBe('verified_stale_or_probe_failed');
    const c = rt.protectionCreds.get('agent_mcp', null)!;
    expect(c).toMatchObject({ symbol: null, verified_at: wrote, last_probe_ok: true });
    expect(c.expires_at).toBe(wrote + 7 * DAY_MS);
    // 旧键置空,只迁一次(再写一条新的旧键才会再迁)
    expect(store.kvGet(legacyProtectionKey('agent_mcp'))).toBe('');
    expect(rt.protectionCreds.list('agent_mcp').length).toBe(1);
    expect(rt.protectionStatus().state).toBe('verified_stale_or_probe_failed');
  });

  it('迁移来的通道级凭证在 ttl 内 = 所有币都放行(不会因为没有 symbol 凭证就全被阻断)', async () => {
    const { rt, store } = await setup();
    store.kvSet(legacyProtectionKey('agent_mcp'), JSON.stringify({ at: Date.now() - 3600_000, symbol: 'HYPEUSDT' }));
    expect(rt.protectionState('BTCUSDT')).toBe('verified');
    expect(rt.protectionState('ETHUSDT')).toBe('verified');
  });

  it('坏掉的旧记录(空串 / 不是 JSON)不会变成凭证或炸掉判定', async () => {
    const { rt, store } = await setup();
    store.kvSet(legacyProtectionKey('agent_mcp'), '');
    expect(rt.protectionState('BTCUSDT')).toBe('never_verified');
    store.kvSet(PROTECTION_CREDENTIALS_KEY, 'not json');
    expect(new ProtectionCredentials(store).list()).toEqual([]);
    expect(rt.protectionState('BTCUSDT')).toBe('never_verified');
  });
});

describe('过期自动重验(每通道 × 交易对每天最多一次)', () => {
  it('过期的凭证由巡检自动重跑金丝雀续期,同一天不会跑第二次', async () => {
    const { rt, backend } = await setup({ watchlist: ['BTCUSDT'] });
    rt.account = await backend.account();
    rt.setWorkflow({ protection_auto_verify_per_day: 1 }); // P1-04:自动真钱路径要有额度才跑
    rt.protectionCreds.recordVerified('agent_mcp', 'BTCUSDT', Date.now() - 9 * DAY_MS, 7);
    const spy = vi.spyOn(rt, 'verifyProtection');
    await rt['autoReverifyProtection']();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ symbol: 'BTCUSDT', auto: true });
    expect(rt.protectionState('BTCUSDT')).toBe('verified'); // 成功续期
    // 再让它过期:今天已经自动跑过一次,不再跑,原因写进 auto_note
    rt.protectionCreds.recordVerified('agent_mcp', 'BTCUSDT', Date.now() - 9 * DAY_MS, 7);
    await rt['autoReverifyProtection']();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(rt.protectionStatus().auto_note).toMatch(/今天已经自动重验过一次/);
    // 把上次自动时刻推到一天前 → 又可以跑
    rt.protectionCreds.markAutoAttempt('agent_mcp', 'BTCUSDT', Date.now() - DAY_MS - 1000);
    await rt['autoReverifyProtection']();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('暂停 / 没资金 / 有活线程占着这个币时不跑,原因记进 auto_note', async () => {
    const { rt, backend, store } = await setup({ watchlist: ['BTCUSDT'] });
    const spy = vi.spyOn(rt, 'verifyProtection');
    rt.protectionCreds.recordVerified('agent_mcp', 'BTCUSDT', Date.now() - 9 * DAY_MS, 7);

    rt.account = null;
    await rt['autoReverifyProtection']();
    expect(rt.protectionStatus().auto_note).toMatch(/还没有账户快照/);

    rt.account = { ...(await backend.account()), quality: 'unfunded' };
    await rt['autoReverifyProtection']();
    expect(rt.protectionStatus().auto_note).toMatch(/没有资金/);

    rt.account = await backend.account();
    rt.setWorkflow({ paused: true });
    await rt['autoReverifyProtection']();
    expect(rt.protectionStatus().auto_note).toMatch(/已暂停/);
    rt.setWorkflow({ paused: false });

    store.saveThread({ ...newThread({ id: 'thr-busy', backend: 'agent_mcp', symbol: 'BTCUSDT', side: 'long', source: 'manual', timeframe: '15m', thesis: 't', invalidation_text: null, watch_conditions: [], entry: { type: 'market', price: null, zone: null }, stop_price: '1', take_profits: [], qty: '0.001', margin_usdt: null, leverage: 3, margin_mode: 'cross', now: Date.now() }), status: 'in_position' });
    await rt['autoReverifyProtection']();
    expect(rt.protectionStatus().auto_note).toMatch(/活线程/);

    expect(spy).not.toHaveBeenCalled();
    // 从没验过的币永远不自动跑:第一次花真钱必须是人点的
    rt.setWorkflow({ watchlist: ['ETHUSDT'] });
    rt.account = await backend.account();
    await rt['autoReverifyProtection']();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('路由与设置', () => {
  it('GET /api/execution/protection 返回三态 + 通道 × 交易对的凭证;POST verify-protection 可以按币跑', async () => {
    const { rt } = await setup({ watchlist: ['BTCUSDT', 'ETHUSDT'], serve: true });
    const before = await api('GET', '/api/execution/protection');
    expect(before.status).toBe(200);
    expect(before.json.protection).toMatchObject({ state: 'never_verified', status: 'unverified', ttl_days: 7 });
    expect(before.json.protection.credentials.filter((c: any) => c.market === 'perp').map((c: any) => [c.symbol, c.state])).toEqual([
      ['BTCUSDT', 'never_verified'],
      ['ETHUSDT', 'never_verified'],
    ]);

    const started = await api('POST', '/api/execution/verify-protection', { confirm: true, symbol: 'BTCUSDT' });
    expect(started.status).toBe(202);
    await vi.waitFor(() => expect(rt.protectionState('BTCUSDT')).toBe('verified'), { timeout: 5_000 });
    const after = await api('GET', '/api/execution/protection');
    const btc = after.json.protection.credentials.find((c: any) => c.symbol === 'BTCUSDT');
    expect(btc).toMatchObject({ channel: 'agent_mcp', state: 'verified', source: 'symbol', last_probe_ok: true });
    expect(btc.expires_at - btc.verified_at).toBe(7 * DAY_MS);
    // 通道汇总取最好的那条凭证,单个币的阻断仍看 credentials
    expect(after.json.protection.state).toBe('verified');
    expect(after.json.protection.credentials.find((c: any) => c.symbol === 'ETHUSDT').state).toBe('never_verified');

    expect((await api('POST', '/api/execution/verify-protection', {})).status).toBe(202);
  });

  it('protection_ttl_days 只收 1–30 的整数,改小了立刻让旧凭证过期', async () => {
    const { rt } = await setup({ watchlist: ['BTCUSDT'], serve: true });
    rt.protectionCreds.recordVerified('agent_mcp', 'BTCUSDT', Date.now() - 3 * DAY_MS, 7);
    expect(rt.protectionState('BTCUSDT')).toBe('verified');
    const bad = await api('POST', '/api/workflow', { protection_ttl_days: 40 });
    expect(bad.json.errors.join(';')).toMatch(/protection_ttl_days/);
    const ok = await api('POST', '/api/workflow', { protection_ttl_days: 2 });
    expect(ok.json.workflow.protection_ttl_days).toBe(2);
    expect(rt.protectionState('BTCUSDT')).toBe('verified_stale_or_probe_failed');
  });
});

// 09-12 P1-02:`verifying` 是展示态,不是许可态。以前任何币在跑金丝雀,protectionState 对**所有**币返回
// verifying,而 preflight 只拒 never_verified —— 从没验过的币在这个窗口里能开仓。
describe('P1-02 verifying 不跨币放行', () => {
  it('BTC 正在验证时,从没验过的 ETH 仍然是 never_verified 并被发送前重闸拒绝', async () => {
    const { rt, backend } = await setup();
    const acct = await backend.account();
    rt['protectionRun'] = { running: true, symbol: 'BTCUSDT', last_run_at: Date.now(), last_error: null, steps: [] };
    expect(rt.protectionState('ETHUSDT')).toBe('never_verified');
    expect(rt['preflightOpen']('ETHUSDT', acct).join(';')).not.toMatch(/从没验证过能挂止损/);
    // 正在验证的那个币本身也不因为「在验证」就放行(它同样没有凭证),但 never_verified 已不阻断
    expect(rt.protectionState('BTCUSDT')).toBe('never_verified');
    expect(rt['preflightOpen']('BTCUSDT', acct).join(';')).not.toMatch(/从没验证过能挂止损/);
  });

  it('只有正在验证的那个币、且它本来就有凭证时才显示 verifying;别的币按自己的凭证判', async () => {
    const { rt } = await setup();
    rt.protectionCreds.recordVerified('agent_mcp', 'BTCUSDT', Date.now() - 8 * DAY_MS, 7);
    rt.protectionCreds.recordVerified('agent_mcp', 'ETHUSDT', Date.now(), 7);
    rt['protectionRun'] = { running: true, symbol: 'BTCUSDT', last_run_at: Date.now(), last_error: null, steps: [] };
    expect(rt.protectionState('BTCUSDT')).toBe('verifying');
    expect(rt.protectionState('ETHUSDT')).toBe('verified'); // 不再被别人的验证窗口盖掉
  });
});

// 09-12 P1-03:线上「成功续期」必须是**原始活动止损单**的事实。-4130 冲突、重复 ID 拒绝、已触发的保护腿
// 都会被按「已挂」处理(不补挂是对的),但它们不是保护腿能力的证明,不许续 TTL。
describe('P1-03 续期只认原始活动止损', () => {
  async function inPosition(rt: any, store: DemoStore, backend: FakeAgentBackend) {
    backend.tick('BTCUSDT', '100');
    const t = newThread({ id: 'renew-proof', backend: 'agent_mcp', symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '1h', thesis: 'x', invalidation_text: '80', watch_conditions: [], entry: { type: 'market', price: null, zone: null }, stop_price: '70', take_profits: [], qty: '1', margin_usdt: '100', leverage: 1, margin_mode: 'cross', now: Date.now() });
    store.saveThread({ ...t, status: 'in_position', opened_at: Date.now(), filled_avg_price: '100' });
    return store.thread(t.id)!;
  }

  it('-4130「同向止损已存在」被按已挂处理,但凭证不续期', async () => {
    const { rt, store, backend } = await setup();
    const verifiedAt = Date.now() - 6 * DAY_MS;
    rt.protectionCreds.recordVerified('agent_mcp', 'BTCUSDT', verifiedAt, 7);
    const t = await inPosition(rt, store, backend);
    vi.spyOn(backend, 'placeStop').mockResolvedValue({ outcome: 'failed', receipt: null, avg_price: null, error: 'APIError(code=-4130): Order would immediately trigger.' });
    await rt['placeProtection'](t, '测试');
    expect(rt.protectionCreds.get('agent_mcp', 'BTCUSDT')!.verified_at).toBe(verifiedAt); // 没被续期
    expect(store.thread(t.id)!.status).toBe('in_position'); // 但也没有触发补偿平仓
    // 09-12 P1-03:-4130 也不清「保护缺失」——那张「已存在」的单参数一个都没核过,留给巡检下一轮按挂单再判
    expect(store.thread(t.id)!.protection_missing).toBe(true);
  });

  it('P1-03 回执 submitted 但参数与请求不符(方向/触发价)→ 不算证明:不续期、保护缺失标志保持', async () => {
    const { rt, store, backend } = await setup();
    const verifiedAt = Date.now() - 6 * DAY_MS;
    rt.protectionCreds.recordVerified('agent_mcp', 'BTCUSDT', verifiedAt, 7);
    const t = await inPosition(rt, store, backend);
    // 交易所收下的是一张**买入、触发价 999** 的单:回执照样 submitted,但它不是我们要的那张止损
    vi.spyOn(backend, 'placeStop').mockResolvedValue({ outcome: 'submitted', receipt: { side: 'BUY', stopPrice: '999', closePosition: 'true', clientOrderId: 'someone-else' }, avg_price: null, error: null });
    await rt['placeProtection'](t, '测试');
    expect(rt.protectionCreds.get('agent_mcp', 'BTCUSDT')!.verified_at).toBe(verifiedAt); // 修前:ACK 就续期
    expect(store.thread(t.id)!.protection_missing).toBe(true);
  });

  it('P1-03 回执里没有任何可核验的订单参数(只回了 ok/order_id)→ 也不算证明', async () => {
    const { rt, store, backend } = await setup();
    const verifiedAt = Date.now() - 6 * DAY_MS;
    rt.protectionCreds.recordVerified('agent_mcp', 'BTCUSDT', verifiedAt, 7);
    const t = await inPosition(rt, store, backend);
    vi.spyOn(backend, 'placeStop').mockResolvedValue({ outcome: 'submitted', receipt: { ok: true, outcome: 'submitted', order_id: '42' }, avg_price: null, error: null });
    await rt['placeProtection'](t, '测试');
    expect(rt.protectionCreds.get('agent_mcp', 'BTCUSDT')!.verified_at).toBe(verifiedAt);
    expect(store.thread(t.id)!.protection_missing).toBe(true);
  });

  it('P1-03 verifyStopReceipt:方向/触发价/closePosition/CID 全对才算证明', () => {
    const want = { side: 'SELL' as const, stop_price: '70', client_order_id: 'tgd-abc-s1' };
    expect(verifyStopReceipt({ side: 'SELL', stopPrice: '70', closePosition: 'true', clientOrderId: 'tgd-abc-s1', type: 'STOP_MARKET' }, want).proved).toBe(true);
    expect(verifyStopReceipt({ raw: { side: 'SELL', triggerPrice: 70, closePosition: true, clientAlgoId: 'tgd-abc-s1' } }, want).proved).toBe(true); // 嵌在 raw 里也认
    expect(verifyStopReceipt({ side: 'BUY', stopPrice: '70' }, want).proved).toBe(false);
    expect(verifyStopReceipt({ side: 'SELL', stopPrice: '71' }, want).proved).toBe(false);
    expect(verifyStopReceipt({ side: 'SELL', stopPrice: '70', closePosition: false, reduceOnly: false }, want).proved).toBe(false);
    expect(verifyStopReceipt({ side: 'SELL', stopPrice: '70', clientOrderId: 'other' }, want).proved).toBe(false);
    expect(verifyStopReceipt({ ok: true }, want).proved).toBe(false);
    expect(verifyStopReceipt(null, want).proved).toBe(false);
  });

  it('重发收到重复 ID 拒绝 → 不补挂,也不续期', async () => {
    const { rt, store, backend } = await setup();
    const verifiedAt = Date.now() - 6 * DAY_MS;
    rt.protectionCreds.recordVerified('agent_mcp', 'BTCUSDT', verifiedAt, 7);
    const t = await inPosition(rt, store, backend);
    vi.spyOn(backend, 'algoOrderExists').mockResolvedValue(false);
    let call = 0;
    vi.spyOn(backend, 'placeStop').mockImplementation(async () => (++call === 1
      ? { outcome: 'unknown', receipt: null, avg_price: null, error: 'socket closed' }
      : { outcome: 'failed', receipt: null, avg_price: null, error: 'Duplicate order id' }));
    await rt['placeProtection'](t, '测试');
    expect(rt.protectionCreds.get('agent_mcp', 'BTCUSDT')!.verified_at).toBe(verifiedAt);
  });

  it('回执 submitted / 交易所按同一 id 查到 → 才续期', async () => {
    const { rt, store, backend } = await setup();
    const verifiedAt = Date.now() - 6 * DAY_MS;
    rt.protectionCreds.recordVerified('agent_mcp', 'BTCUSDT', verifiedAt, 7);
    const t = await inPosition(rt, store, backend);
    await rt['placeProtection'](t, '测试');
    expect(rt.protectionCreds.get('agent_mcp', 'BTCUSDT')!.verified_at).toBeGreaterThan(verifiedAt);
  });
});

// 09-12 P1-04:自动续期是**定时真钱写路径**(市价开最小仓 → 挂止损 → 撤 → 平)。A 阶段默认没有金丝雀额度:
// 只告警,不下真实订单;有额度时每次尝试前先落一条可恢复的操作记录。
describe('P1-04 自动金丝雀受额度约束并留可恢复记录', () => {
  it('额度 0(默认)= 只告警不下单', async () => {
    const { rt, backend } = await setup({ watchlist: ['BTCUSDT'] });
    rt.account = await backend.account();
    expect(rt.workflow.protection_auto_verify_per_day).toBe(0);
    rt.protectionCreds.recordVerified('agent_mcp', 'BTCUSDT', Date.now() - 9 * DAY_MS, 7);
    const spy = vi.spyOn(rt, 'verifyProtection');
    await rt['autoReverifyProtection']();
    expect(spy).not.toHaveBeenCalled();
    expect(rt.protectionStatus().auto_note).toMatch(/自动金丝雀额度是 0/);
    expect(rt.store.intents(50).filter((i) => i.symbol === 'BTCUSDT')).toHaveLength(0);
  });

  it('额度用满之后当天不再跑,原因写进 auto_note', async () => {
    const { rt, backend } = await setup({ watchlist: ['BTCUSDT', 'ETHUSDT'] });
    rt.account = await backend.account();
    rt.setWorkflow({ protection_auto_verify_per_day: 1 });
    rt.protectionCreds.recordVerified('agent_mcp', 'BTCUSDT', Date.now() - 9 * DAY_MS, 7);
    rt.protectionCreds.recordVerified('agent_mcp', 'ETHUSDT', Date.now() - 9 * DAY_MS, 7);
    const spy = vi.spyOn(rt, 'verifyProtection');
    await rt['autoReverifyProtection']();
    expect(spy).toHaveBeenCalledTimes(1);
    // 第二个币今天还没自己跑过,但整账户的当日额度已经用掉了
    await rt['autoReverifyProtection']();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(rt.protectionStatus().auto_note).toMatch(/已用满 1\/1/);
  });

  it('真的要跑之前先落一条可恢复的操作记录(意图),跑完写终态', async () => {
    const { rt, backend } = await setup({ watchlist: ['BTCUSDT'] });
    rt.account = await backend.account();
    rt.setWorkflow({ protection_auto_verify_per_day: 1 });
    rt.protectionCreds.recordVerified('agent_mcp', 'BTCUSDT', Date.now() - 9 * DAY_MS, 7);
    vi.spyOn(rt, 'verifyProtection').mockImplementation(async () => {
      // 调用进行中就应该已经能在库里看到「这个币上正在花钱」
      const live = rt.store.intents(50).find((i) => i.symbol === 'BTCUSDT');
      expect(live).toBeTruthy();
      expect(live!.sizing.note).toMatch(/自动保护腿金丝雀/);
      throw new Error('金丝雀中途崩了');
    });
    await rt['autoReverifyProtection']();
    const rec = rt.store.intents(50).find((i) => i.symbol === 'BTCUSDT')!;
    expect(rec.status).toBe('failed');
    expect(rec.error).toMatch(/崩了/);
  });
});

 describe('现货保护凭证可选', () => {
  it('spot 无凭证也不挡 preflight,perp 仍挡;现货凭证保留展示但不影响汇总', async () => {
    const { rt, backend } = await setup({ watchlist: ['BTCUSDT'] });
    rt.setWorkflow({ markets: ['perp', 'spot'] });
    expect(rt.protectionState('BTCUSDT', 'spot')).toBe('not_needed');
    expect(rt['preflightOpen']('BTCUSDT', await backend.account(), null, 'spot').join(';')).not.toMatch(/从没验证过/);
    expect(rt['preflightOpen']('BTCUSDT', await backend.account(), null, 'perp').join(';')).not.toMatch(/从没验证过/);
    expect(rt.protectionStatus().credentials.filter(c => c.market === 'spot')).toEqual([]);
    rt.protectionCreds.recordVerified('agent_mcp', 'BTCUSDT', Date.now(), 7, 'spot');
    expect(rt.protectionStatus().credentials).toContainEqual(expect.objectContaining({ market: 'spot', state: 'verified' }));
    expect(rt.protectionStatus().state).toBe('never_verified');
    rt.protectionCreds.markProbe('agent_mcp', 'BTCUSDT', false, 'fake spot failure', Date.now(), 7, 'spot');
    (rt as any).protectionRun.market = 'spot';
    (rt as any).protectionRun.last_error = 'fake spot failure';
    expect(rt.protectionStatus()).toMatchObject({ state: 'never_verified', status: 'unverified' });
    expect(rt.protectionStatus().credentials).toContainEqual(expect.objectContaining({ market: 'spot', state: 'verified_stale_or_probe_failed' }));
    rt.setWorkflow({ markets: ['spot'], default_market: 'spot' });
    vi.spyOn(backend, 'marketsSupported').mockReturnValue(['spot']);
    expect(rt['protectionRiskInput']()?.never_verified).toEqual([]);
    expect(rt.protectionStatus().state).toBe('not_needed');
    // 丢弃启动时仅启用 perp 产生的历史告警,验证现货不会新建告警。
    rt.store.risk.resolveKind('protection_never_verified', Date.now());
    rt.evaluateTeamRisk(await backend.account());
    expect(rt.riskOpen.some(a => a.kind === 'protection_never_verified')).toBe(false);
  });
});

 describe('现货 probe 错误隔离', () => {
  it('spot probe 失败不会污染默认 perp 汇总的共享 last_error', async () => {
    const { rt } = await setup({ watchlist: ['BTCUSDT'] });
    rt.setWorkflow({ markets: ['perp', 'spot'] });
    expect((rt as any).protectionRun.market ?? 'perp').toBe('perp');
    rt.protectionCreds.recordVerified('agent_mcp', 'BTCUSDT', Date.now(), 7, 'spot');
    rt.markProtectionProbe('BTCUSDT', false, 'fake spot stop failure', 'spot');
    expect((rt as any).protectionRun.last_error).toBeNull();
    expect(rt.protectionStatus()).toMatchObject({ state: 'never_verified', status: 'unverified' });
    expect(rt.protectionStatus().credentials).toContainEqual(expect.objectContaining({ market: 'spot', state: 'verified_stale_or_probe_failed', last_error: 'fake spot stop failure' }));
  });
});
