// 09-26 stuck-entry(thr-mufwh4lue43720 LINKUSDT 卡 pending_entry 20 小时):
// 「已提交、结果未知」的入场单要有周期对账 —— 按 clientOrderId 查,查到成交推进持仓+保护,查到挂单保持,
// 连续 N 次查不到且距提交超过 T 才**复核**(新鲜查单 + 新鲜账户)后写 canceled(entry_unknown_not_found);
// 查询本身失败不计数;全程不重发入场单。夹具风格同 cancel-chain.test.ts(真 DemoRuntime + PaperBackend + spy)。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend, type OrderStatusView } from '../../src/demo/execution.js';
import { DemoRuntime } from '../../src/demo/runtime.js';
import { ENTRY_MISS_SPACING_MS, ENTRY_UNKNOWN_MAX_MISSES, newThread, reconcileThread } from '../../src/demo/threads.js';
import type { Market, StrategyThread } from '../../src/demo/types.js';

let state: StateDb | null = null;
afterEach(() => {
  try { state?.close(); } catch { /* already closed */ }
  state = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const HOUR = 3_600_000;
const order = (status: string, executed_qty: string): OrderStatusView => ({ status, executed_qty, avg_price: executed_qty === '0' ? null : '13.4', raw: null });

/**
 * 复刻现网那条线程:CID 已落库、提交相位属于上一个进程且 20 小时前开始、调用从没返回(entry_submitted_at=null)、
 * 开仓意图停在 approved、lookup_misses=0。
 */
function setup(opts: { market?: Market; submittedAgoMs?: number; stalePhase?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-26T00:00:00Z'));
  state = openStateDb(':memory:');
  const market = opts.market ?? 'perp';
  const store = new DemoStore(state), backend = new PaperBackend(100000);
  const rt = new DemoRuntime({ store, backend, brains: {} });
  backend.tick('LINKUSDT', '13.4', market);
  const ago = opts.submittedAgoMs ?? 20 * HOUR;
  const t: StrategyThread = newThread({ id: 'stuck-entry', backend: 'paper', market, symbol: 'LINKUSDT', side: 'long', source: 'agent', timeframe: '15m', horizon: 'intraday', thesis: 'ir', invalidation_text: 'stop', watch_conditions: [], entry: { type: 'market', price: null, zone: null }, stop_price: '12.8', take_profits: [], qty: '372.7', margin_usdt: '5000', leverage: 1, margin_mode: 'cross', now: Date.now() - ago - 2000 });
  t.entry_client_order_id = 'tgd-972ecea3153c-e1';
  t.leg_seq = 1;
  if (opts.stalePhase === false) {
    t.entry_submitted_at = Date.now() - ago;
    t.entry_submitting_since = null;
  } else {
    t.entry_submitting_since = Date.now() - ago;
    t.entry_submit_epoch = 'epoch-of-a-dead-process';
    t.entry_submitted_at = null;
  }
  t.version = 2;
  store.saveThread(t);
  store.saveIntent({ id: 'open-intent', episode_id: '', thread_id: t.id, principal: 'agent', at: t.created_at, kind: 'open', symbol: t.symbol, market, direction: 'long', quantity: t.qty, entry: 'market', limit_price: null, stop_price: '12.8', take_profit_price: null, sizing: { equity: '100000', risk_pct: '0.2', risk_usdt: '200', stop_distance: '0.56', raw_qty: '372.7', step_size: '0.1', note: 'fixture' }, status: 'approved', client_order_id: t.entry_client_order_id, backend: 'paper', receipts: [], error: null });
  const place = vi.spyOn(backend, 'placeEntry');
  const sweep = async (): Promise<void> => { await (rt as any).reconcileThreads(await backend.account()); };
  const advance = (ms: number): void => { vi.setSystemTime(Date.now() + ms); };
  const noResend = (): void => { expect(place).not.toHaveBeenCalled(); };
  return { rt, store, backend, t, sweep, advance, noResend };
}

describe('stuck-entry:已提交、结果未知的入场单周期对账', () => {
  it('多次查不到 + 超过 T → 复核后转 canceled(entry_unknown_not_found),释放占位,不重发', async () => {
    const { store, backend, sweep, advance, noResend, t } = setup();
    const query = vi.spyOn(backend, 'getOrder');
    await sweep();
    let cur = store.thread(t.id)!;
    expect(cur.status).toBe('pending_entry');
    expect(cur.entry_lookup_misses).toBe(1);
    expect(cur.attention).toBe('ORDER_UNKNOWN');
    // 同一轮缓存窗口内再扫一次:不重复计数
    advance(15_000);
    await sweep();
    expect(store.thread(t.id)!.entry_lookup_misses).toBe(1);
    for (let n = 2; n <= ENTRY_UNKNOWN_MAX_MISSES; n++) {
      advance(ENTRY_MISS_SPACING_MS);
      await sweep();
    }
    cur = store.thread(t.id)!;
    expect(cur.status).toBe('canceled');
    expect(cur.close_reason).toMatch(/^entry_unknown_not_found:/);
    expect(cur.entry_submitting_since).toBeNull();
    expect(cur.attention).toBeNull();
    expect(store.intent('open-intent')!.status).toBe('failed');
    expect(store.intent('open-intent')!.error).toMatch(/entry_unknown_not_found/);
    // 复核用的是 fresh 查单
    expect(query).toHaveBeenCalledWith('LINKUSDT', 'tgd-972ecea3153c-e1', true, 'perp');
    // 每一次迁移都有事件
    const logs = store.logs(200).map((l) => l.message).join('\n');
    expect(logs).toMatch(/入场单在交易所查不到,持续核对/); // ORDER_UNKNOWN 迁移
    expect(logs).toMatch(/第 2 次查不到/); // 日志层把只差数字的相邻行折叠成 ×N,第 1 次并进这一行
    expect(logs).toMatch(/第 3 次查不到,已满足终态复核条件/);
    expect(logs).toMatch(/entry_unknown_not_found/);
    expect(store.activity().some((a) => a.kind === 'thread_canceled' && a.thread_id === t.id)).toBe(true);
    noResend();
  });

  it('查询本身失败(超时/限流)不计 miss,也不收终态', async () => {
    const { store, backend, sweep, advance, noResend, t } = setup();
    vi.spyOn(backend, 'getOrder').mockRejectedValue(new Error('okx swap get 超时 15000ms'));
    for (let n = 0; n < 5; n++) { await sweep(); advance(ENTRY_MISS_SPACING_MS); }
    const cur = store.thread(t.id)!;
    expect(cur.status).toBe('pending_entry');
    expect(cur.entry_lookup_misses).toBe(0);
    noResend();
  });

  it('复核时查单失败 → 不写终态,miss 已计的不回退,下一次再复核', async () => {
    const { store, backend, sweep, advance, noResend, t } = setup();
    const query = vi.spyOn(backend, 'getOrder').mockImplementation(async (_s, _c, fresh) => {
      if (fresh) throw new Error('HTTP 429 Too Many Requests');
      return null;
    });
    for (let n = 0; n < ENTRY_UNKNOWN_MAX_MISSES; n++) { await sweep(); advance(ENTRY_MISS_SPACING_MS); }
    expect(store.thread(t.id)!.status).toBe('pending_entry');
    expect(store.logs(200).some((l) => /终态复核未通过\(复核查单失败/.test(l.message))).toBe(true);
    query.mockResolvedValue(null);
    await sweep();
    expect(store.thread(t.id)!.status).toBe('canceled');
    noResend();
  });

  it('次数够了但距提交不到 T → 只计数不复核', async () => {
    const { store, backend, sweep, advance, noResend, t } = setup({ submittedAgoMs: 2 * 60_000, stalePhase: false });
    vi.spyOn(backend, 'getOrder').mockResolvedValue(null);
    for (let n = 0; n < ENTRY_UNKNOWN_MAX_MISSES; n++) { await sweep(); advance(ENTRY_MISS_SPACING_MS); }
    expect(store.thread(t.id)!.entry_lookup_misses).toBe(ENTRY_UNKNOWN_MAX_MISSES);
    expect(store.thread(t.id)!.status).toBe('pending_entry');
    noResend();
  });

  it('复核时账户上有该币持仓 → 无法证明没成交,保持 pending_entry', async () => {
    const { store, backend, sweep, advance, noResend, t } = setup();
    const base = await backend.account();
    vi.spyOn(backend, 'account').mockImplementation(async () => ({ ...base, as_of: Date.now(), positions: [{ symbol: 'LINKUSDT', side: 'short', qty: '10', entry_price: '13.5', mark_price: '13.4', unrealized_pnl: '1', leverage: 1 }] }));
    vi.spyOn(backend, 'getOrder').mockResolvedValue(null);
    for (let n = 0; n < ENTRY_UNKNOWN_MAX_MISSES + 1; n++) { await sweep(); advance(ENTRY_MISS_SPACING_MS); }
    expect(store.thread(t.id)!.status).toBe('pending_entry');
    expect(store.logs(200).some((l) => /账户上有持仓/.test(l.message))).toBe(true);
    noResend();
  });

  it('复核时账户上有同 CID 挂单 → 不写终态', async () => {
    const { store, backend, sweep, advance, noResend, t } = setup();
    const base = await backend.account();
    vi.spyOn(backend, 'account').mockImplementation(async () => ({ ...base, as_of: Date.now(), open_orders: [{ symbol: 'LINKUSDT', market: 'perp', side: 'BUY', type: 'LIMIT', qty: '372.7', price: '13', stop_price: null, reduce_only: false, client_order_id: 'tgd-972ecea3153c-e1' }] as never }));
    vi.spyOn(backend, 'getOrder').mockResolvedValue(null);
    for (let n = 0; n < ENTRY_UNKNOWN_MAX_MISSES; n++) { await sweep(); advance(ENTRY_MISS_SPACING_MS); }
    expect(store.thread(t.id)!.status).toBe('pending_entry');
    noResend();
  });

  it('未知后查到已成交 → in_position + 挂保护单,提交相位收起,意图 filled', async () => {
    const { store, backend, sweep, noResend, t } = setup();
    vi.spyOn(backend, 'getOrder').mockResolvedValue(order('FILLED', '372.7'));
    const stop = vi.spyOn(backend, 'placeStop');
    await sweep();
    const cur = store.thread(t.id)!;
    expect(cur.status).toBe('in_position');
    expect(cur.entry_submitting_since).toBeNull();
    expect(stop).toHaveBeenCalledWith('LINKUSDT', 'long', '12.8', expect.any(String), 'perp');
    expect(store.intent('open-intent')!.status).toBe('filled');
    noResend();
  });

  it('查到挂单中 → 保持 pending_entry,收起过期相位,意图 submitted,miss 清零', async () => {
    const { store, backend, sweep, advance, noResend, t } = setup();
    const query = vi.spyOn(backend, 'getOrder').mockResolvedValue(null);
    await sweep();
    expect(store.thread(t.id)!.entry_lookup_misses).toBe(1);
    advance(ENTRY_MISS_SPACING_MS);
    query.mockResolvedValue(order('NEW', '0'));
    await sweep();
    const cur = store.thread(t.id)!;
    expect(cur.status).toBe('pending_entry');
    expect(cur.entry_submitting_since).toBeNull();
    expect(cur.entry_lookup_misses).toBe(0);
    expect(cur.attention).toBeNull();
    expect(store.intent('open-intent')!.status).toBe('submitted');
    noResend();
  });

  for (const market of ['perp', 'spot'] as const) it(`${market} 线程按 ${market} 接口查`, async () => {
    const { backend, sweep, t } = setup({ market });
    const query = vi.spyOn(backend, 'getOrder').mockResolvedValue(null);
    await sweep();
    expect(query).toHaveBeenCalledWith('LINKUSDT', t.entry_client_order_id, false, market);
    expect(query.mock.calls.every((c) => c[3] === market)).toBe(true);
  });
});

describe('stuck-entry:executeOpen 在 CID 落库后抛错', () => {
  function ready() {
    state = openStateDb(':memory:');
    const store = new DemoStore(state), backend = new PaperBackend(100000);
    const rt = new DemoRuntime({ store, backend, brains: {} });
    backend.tick('LINKUSDT', '13.4');
    const t = newThread({ id: 'throws', backend: 'paper', symbol: 'LINKUSDT', side: 'long', source: 'agent', timeframe: '15m', thesis: 'x', invalidation_text: 'x', watch_conditions: [], entry: { type: 'market', price: null, zone: null }, stop_price: '12.8', take_profits: [], qty: '10', margin_usdt: '134', leverage: 1, margin_mode: 'cross', now: Date.now() });
    store.saveThread(t);
    store.saveIntent({ id: 'i1', episode_id: '', thread_id: t.id, principal: 'agent', at: Date.now(), kind: 'open', symbol: t.symbol, direction: 'long', quantity: '10', entry: 'market', limit_price: null, stop_price: '12.8', take_profit_price: null, sizing: { equity: '100000', risk_pct: '0', risk_usdt: '0', stop_distance: '0.6', raw_qty: '10', step_size: '0.1', note: 'fixture' }, status: 'approved', client_order_id: null, backend: 'paper', receipts: [], error: null });
    return { rt, store, backend, t };
  }

  it('发送前账户读超时(现网 okx spot orders 超时)→ 确定未发送,线程 canceled、意图 rejected、相位清掉', async () => {
    const { rt, store, backend, t } = ready();
    vi.spyOn(backend, 'account').mockRejectedValue(new Error('okx spot orders 超时 15000ms'));
    const place = vi.spyOn(backend, 'placeEntry');
    const fact = await (rt as any).executeOpen(t, store.intent('i1'), null);
    expect(fact).toMatchObject({ sent: false, receipt: 'rejected' });
    const cur = store.thread(t.id)!;
    expect(cur.status).toBe('canceled');
    expect(cur.entry_client_order_id).toBeNull();
    expect(cur.entry_submitting_since).toBeNull();
    expect(cur.close_reason).toMatch(/发送前异常,入场单未发送:okx spot orders 超时/);
    expect(store.intent('i1')!.status).toBe('rejected');
    expect(place).not.toHaveBeenCalled();
  });

  it('入场接口调用中抛错 → unknown + ORDER_UNKNOWN,相位收起交周期对账,不重发', async () => {
    const { rt, store, backend, t } = ready();
    const place = vi.spyOn(backend, 'placeEntry').mockRejectedValue(new Error('socket hang up'));
    const fact = await (rt as any).executeOpen(t, store.intent('i1'), null);
    expect(fact).toMatchObject({ sent: true, receipt: 'unknown' });
    const cur = store.thread(t.id)!;
    expect(cur.status).toBe('pending_entry');
    expect(cur.entry_client_order_id).not.toBeNull();
    expect(cur.entry_submitting_since).toBeNull();
    expect(typeof cur.entry_submitted_at).toBe('number');
    expect(cur.attention).toBe('ORDER_UNKNOWN');
    expect(store.intent('i1')!.status).toBe('unknown');
    expect(place).toHaveBeenCalledTimes(1); // 只有那一次调用,没有重发
  });
});

describe('reconcileThread:GONE 计数(纯函数)', () => {
  it('间隔内不重复计数;查到单清零', () => {
    const now = 1_790_000_000_000;
    const t = newThread({ id: 'p', backend: 'okx', symbol: 'LINKUSDT', side: 'long', source: 'agent', timeframe: '15m', thesis: 'x', invalidation_text: 'x', watch_conditions: [], entry: { type: 'market', price: null, zone: null }, stop_price: '12.8', take_profits: [], qty: '1', margin_usdt: '1', leverage: 1, margin_mode: 'cross', now: now - HOUR });
    t.entry_client_order_id = 'cid-e1';
    t.entry_submitted_at = now - HOUR;
    const facts = { position: null, open_orders: [], mark: null };
    const a = reconcileThread(t, { ...facts, now, entry_order: null });
    expect(a.next.entry_lookup_misses).toBe(1);
    expect(a.events.map((e) => e.kind)).toEqual(['attention', 'lookup_miss']);
    const b = reconcileThread(a.next, { ...facts, now: now + 10_000, entry_order: null });
    expect(b.changed).toBe(false);
    const c = reconcileThread(a.next, { ...facts, now: now + ENTRY_MISS_SPACING_MS, entry_order: null });
    expect(c.next.entry_lookup_misses).toBe(2);
    expect(c.verify_absent).toBeUndefined();
    const d = reconcileThread(c.next, { ...facts, now: now + 2 * ENTRY_MISS_SPACING_MS, entry_order: null });
    expect(d.verify_absent).toBe(true);
    const e = reconcileThread(d.next, { ...facts, now: now + 3 * ENTRY_MISS_SPACING_MS, entry_order: order('NEW', '0') });
    expect(e.next.entry_lookup_misses).toBe(0);
    expect(e.next.attention).toBeNull();
  });
});

// 09-26 部署后第二个现场:01:42 界面「撤单并核对」走 closeThread → cancelEntry 接管了过期提交相位,
// 线程变成 CANCEL_UNKNOWN + entry_cancel_pending,巡检从此每轮进撤单链,GONE 计数永远走不到。
// 撤单链里「明确查不到」必须和「查询失败」分开,并复用同一套只读复核收口。
describe('stuck-entry:撤单链接管后查不到入场单', () => {
  const noWrites = (backend: PaperBackend) => ({
    place: vi.spyOn(backend, 'placeEntry'),
    stop: vi.spyOn(backend, 'placeStop'),
    tp: vi.spyOn(backend, 'placeTakeProfit'),
    close: vi.spyOn(backend, 'closePosition'),
    reduce: vi.spyOn(backend, 'reducePosition'),
  });
  const assertNoWrites = (w: ReturnType<typeof noWrites>): void => {
    for (const spy of Object.values(w)) expect(spy).not.toHaveBeenCalled();
  };

  it('界面撤单接管过期相位 → 撤单链连续查不到 → 复核通过收成 canceled(entry_unknown_not_found),意图 failed,不下单', async () => {
    const { rt, store, backend, sweep, advance, t } = setup();
    const w = noWrites(backend);
    const query = vi.spyOn(backend, 'getOrder').mockResolvedValue(null);
    await rt.closeThread(t.id, '界面上手动平仓/撤单');
    let cur = store.thread(t.id)!;
    expect(cur.status).toBe('pending_entry');
    expect(cur.attention).toBe('CANCEL_UNKNOWN');
    expect(cur.entry_cancel_pending).toBe(true);
    expect(cur.entry_submitting_since).toBeNull();
    expect(cur.entry_submitted_at).toBe(t.entry_submitting_since); // 接管时保留提交时刻
    expect(cur.entry_lookup_misses).toBe(1);
    advance(15_000);
    await sweep(); // 60 秒窗口内不重复计数
    expect(store.thread(t.id)!.entry_lookup_misses).toBe(1);
    advance(ENTRY_MISS_SPACING_MS); await sweep();
    advance(ENTRY_MISS_SPACING_MS); await sweep();
    cur = store.thread(t.id)!;
    expect(cur.status).toBe('canceled');
    expect(cur.close_reason).toMatch(/^entry_unknown_not_found:.*撤单链复核.*原撤单原因:界面上手动平仓\/撤单/);
    expect(cur.entry_cancel_pending).toBe(false);
    expect(cur.attention).toBeNull();
    expect(store.intent('open-intent')!.status).toBe('failed');
    expect(query.mock.calls.every((c) => c[2] === true)).toBe(true); // 撤单链与复核都用 fresh 查单
    expect(store.logs(300).some((l) => /撤单链按 clientOrderId 第 3 次查不到入场单.*已满足终态复核条件/.test(l.message))).toBe(true);
    expect(store.activity().some((a) => a.kind === 'thread_canceled' && a.thread_id === t.id)).toBe(true);
    assertNoWrites(w);
  });

  it('现网形态:旧版接管已把两个提交时刻都清空 → 需要连续 miss 跨过 T(10 次)才复核,之后收掉', async () => {
    const { store, backend, sweep, advance, t } = setup();
    const w = noWrites(backend);
    store.saveThread({ ...store.thread(t.id)!, entry_submitting_since: null, entry_submit_epoch: null, entry_submitted_at: null, entry_cancel_pending: true, attention: 'CANCEL_UNKNOWN', close_reason: '界面上手动平仓/撤单', version: 3 });
    vi.spyOn(backend, 'getOrder').mockResolvedValue(null);
    for (let n = 1; n <= 9; n++) { await sweep(); advance(ENTRY_MISS_SPACING_MS); }
    expect(store.thread(t.id)!.status).toBe('pending_entry');
    expect(store.thread(t.id)!.entry_lookup_misses).toBe(9);
    await sweep();
    expect(store.thread(t.id)!.status).toBe('canceled');
    expect(store.thread(t.id)!.close_reason).toMatch(/entry_unknown_not_found:.*提交时刻未留存/);
    assertNoWrites(w);
  });

  it('查不到但账户上有同币仓位 → 拒绝收掉,写 verify_blocked,保持 CANCEL_UNKNOWN', async () => {
    const { rt, store, backend, sweep, advance, t } = setup();
    const w = noWrites(backend);
    const base = await backend.account();
    vi.spyOn(backend, 'account').mockImplementation(async () => ({ ...base, as_of: Date.now(), positions: [{ symbol: 'LINKUSDT', side: 'long', qty: '372.7', entry_price: '13.4', mark_price: '13.4', unrealized_pnl: '0', leverage: 1 }] }));
    vi.spyOn(backend, 'getOrder').mockResolvedValue(null);
    await rt.closeThread(t.id, '界面上手动平仓/撤单');
    for (let n = 0; n < 4; n++) { advance(ENTRY_MISS_SPACING_MS); await sweep(); }
    const cur = store.thread(t.id)!;
    expect(cur.status).toBe('pending_entry');
    expect(cur.entry_cancel_pending).toBe(true);
    expect(cur.attention).toBe('CANCEL_UNKNOWN');
    expect(store.logs(300).some((l) => /终态复核未通过\(LINKUSDT 账户上有持仓/.test(l.message))).toBe(true);
    expect(store.intent('open-intent')!.status).toBe('unknown');
    assertNoWrites(w);
  });

  it('撤单链查单失败(超时/限流)→ 不计 miss,不收掉', async () => {
    const { rt, store, backend, sweep, advance, t } = setup();
    const w = noWrites(backend);
    vi.spyOn(backend, 'getOrder').mockRejectedValue(new Error('okx swap get 超时 15000ms'));
    await rt.closeThread(t.id, '界面上手动平仓/撤单');
    for (let n = 0; n < 5; n++) { advance(ENTRY_MISS_SPACING_MS); await sweep(); }
    const cur = store.thread(t.id)!;
    expect(cur.status).toBe('pending_entry');
    expect(cur.entry_lookup_misses).toBe(0);
    expect(cur.attention).toBe('CANCEL_UNKNOWN');
    assertNoWrites(w);
  });

  it('撤单链复核那一次查单失败 → 不收掉,下一次计数再复核', async () => {
    const { rt, store, backend, sweep, advance, t } = setup();
    vi.spyOn(backend, 'getOrder').mockResolvedValue(null);
    await rt.closeThread(t.id, '界面上手动平仓/撤单');
    advance(ENTRY_MISS_SPACING_MS); await sweep();
    advance(ENTRY_MISS_SPACING_MS);
    // 第 3 次撤单链查单返回 null(计数),紧接着的复核查单失败
    let calls = 0;
    vi.spyOn(backend, 'getOrder').mockImplementation(async () => { calls++; if (calls === 2) throw new Error('HTTP 429'); return null; });
    await sweep();
    expect(store.thread(t.id)!.status).toBe('pending_entry');
    expect(store.logs(300).some((l) => /终态复核未通过\(复核查单失败/.test(l.message))).toBe(true);
    advance(ENTRY_MISS_SPACING_MS); await sweep();
    expect(store.thread(t.id)!.status).toBe('canceled');
  });
});
