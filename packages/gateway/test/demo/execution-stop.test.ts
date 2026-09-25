import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend, type OrderReceipt } from '../../src/demo/execution.js';
import { StopMover } from '../../src/demo/execution-stop.js';
import { compareStopPrices, hasLiveStop, newThread, reconcileThread, stopMoveDecimal } from '../../src/demo/threads.js';
import type { Direction } from '../../src/demo/types.js';

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(f => f()); vi.restoreAllMocks(); });
const failed: OrderReceipt = { outcome: 'failed', receipt: null, avg_price: null, error: 'rejected -4130' };
async function fixture(mode: 'paper' | 'replace' = 'paper', side: Direction = 'long') {
  const state = openStateDb(':memory:'), store = new DemoStore(state), backend = new PaperBackend();
  cleanups.push(() => state.close());
  if (mode === 'replace') Object.defineProperty(backend, 'stopMoveMode', { value: 'replace' });
  backend.setMark('BTCUSDT', '100');
  await backend.placeEntry({ symbol: 'BTCUSDT', direction: side, qty: '1', entry: 'market', limit_price: null, client_order_id: 'entry' });
  const t = newThread({ id: 'thread', backend: 'paper', symbol: 'BTCUSDT', side, source: 'agent', timeframe: '1h', thesis: '', invalidation_text: null, watch_conditions: [],
    entry: { type: 'market', price: '100', zone: null }, stop_price: side === 'long' ? '90' : '110', take_profits: ['120'], qty: '1', margin_usdt: '100', leverage: 1, margin_mode: 'cross', now: 1 });
  t.status = 'in_position'; t.protection_client_order_ids = ['old-stop']; store.saveThread(t);
  await backend.placeStop(t.symbol, side, t.stop_price!, 'old-stop');
  await backend.placeTakeProfit(t.symbol, side, '120', 'tp');
  let key = 'paper', blocked: string | null = null;
  const events = vi.fn(), deps = { store, backend: () => backend, executionKey: () => key, blocked: () => blocked, event: events };
  const mover = new StopMover(deps);
  return { state, store, backend, t, mover, events, restart: () => new StopMover(deps), setKey: (k: string) => { key = k; }, block: () => { blocked = 'halt'; } };
}

describe('移损账本与替换', () => {
  it('paper:CID先落库、同目标规范化/并发幂等、直接替换且保留TP', async () => {
    const f = await fixture(), original = f.backend.replacePaperStop.bind(f.backend), send = vi.spyOn(f.backend, 'replacePaperStop');
    send.mockImplementation(async r => {
      expect(f.mover.get('thread', r.target_stop)).toMatchObject({ phase: 'submitted', new_cid: r.new_cid, old_cid: 'old-stop', old_stop: '90' });
      expect(f.store.thread('thread')!.protection_client_order_ids).toContain(r.new_cid);
      expect(f.store.thread('thread')!.stop_price).toBe('90');
      return original(r);
    });
    const results = await Promise.all([f.mover.move('thread', '095.000', 'trail'), f.mover.move('thread', '95', 'retry')]);
    expect(results.every(r => r.ok)).toBe(true); expect(send).toHaveBeenCalledTimes(1);
    expect(f.store.thread('thread')!.stop_price).toBe('95');
    const orders = (await f.backend.account()).open_orders;
    expect(orders).toHaveLength(2); expect(orders.some(o => o.client_order_id === 'tp')).toBe(true);
    expect(orders.some(o => o.client_order_id === 'old-stop')).toBe(false);
    expect(f.state.db.prepare('SELECT phase FROM demo_stop_move_events ORDER BY id').all().map(r => r.phase)).toEqual(['planned', 'submitted', 'confirmed', 'replaced']);
    expect(f.mover.get('thread', '95')!.reason).toBe('trail');
  });

  it.each(['paper', 'replace'] as const)('%s:新保护失败保留原止损、不补偿平仓、不重试失败目标', async mode => {
    const f = await fixture(mode), close = vi.spyOn(f.backend, 'closePosition'), cancel = vi.spyOn(f.backend, 'cancelOrder');
    const write = mode === 'paper' ? vi.spyOn(f.backend, 'replacePaperStop').mockResolvedValue(failed) : vi.spyOn(f.backend, 'placeStop').mockResolvedValue(failed);
    expect((await f.mover.move('thread', '95', 'trail')).ok).toBe(false);
    expect((await f.mover.move('thread', '95.0', 'retry')).ok).toBe(false);
    expect(write).toHaveBeenCalledTimes(1); expect(close).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
    expect(await f.backend.getStopProtection('BTCUSDT', 'old-stop', 'perp')).toMatchObject({ stop_price: '90' });
    expect(f.store.thread('thread')!.stop_price).toBe('90'); expect(f.mover.get('thread', '95')!.phase).toBe('failed');
  });

  it('submitted/unknown跨实例重启仅按原CID查询；查不到不重发也不换目标', async () => {
    const f = await fixture(), write = vi.spyOn(f.backend, 'replacePaperStop').mockResolvedValue({ ...failed, outcome: 'unknown', error: 'timeout' });
    expect((await f.mover.move('thread', '95', 'trail')).ok).toBe(false);
    const row = f.mover.get('thread', '95')!, restarted = f.restart();
    expect(row.phase).toBe('unknown');
    await restarted.move('thread', '95', 'retry'); await restarted.move('thread', '96', 'new');
    expect(write).toHaveBeenCalledTimes(1); expect(f.mover.get('thread', '96')).toBeNull();
    // 模拟交易所迟到可见的写结果，未知账本没有重新发单。
    write.mockRestore();
    await f.backend.replacePaperStop({ symbol: 'BTCUSDT', market: 'perp', side: 'long', qty: '1', old_stop: '90', target_stop: '95', new_cid: row.new_cid, old_cid: 'old-stop', old_algo_id: null });
    expect((await restarted.move('thread', '95', 'reconcile')).ok).toBe(true);
    expect(f.store.thread('thread')!.stop_price).toBe('95');
  });

  it('模拟写后崩溃:submitted恢复且巡检认识待核新CID，不把新保护当缺失', async () => {
    const f = await fixture(), original = f.backend.getStopProtection.bind(f.backend), query = vi.spyOn(f.backend, 'getStopProtection');
    query.mockImplementation(async (s, cid, m) => cid === 'old-stop' ? original(s, cid, m) : null);
    await f.mover.move('thread', '98', 'trail');
    f.state.db.prepare("UPDATE demo_stop_moves SET phase='submitted' WHERE thread_id='thread'").run();
    expect(hasLiveStop(f.store.thread('thread')!, (await f.backend.account()).open_orders)).toBe(true);
    query.mockRestore(); const write = vi.spyOn(f.backend, 'replacePaperStop');
    expect((await f.restart().move('thread', '98', 'restart')).ok).toBe(true); expect(write).not.toHaveBeenCalled();
  });

  it('仅CID存在不足：目标价不符不得确认', async () => {
    const f = await fixture();
    vi.spyOn(f.backend, 'replacePaperStop').mockImplementation(async r => f.backend.placeStop(r.symbol, r.side, '94', r.new_cid, r.market));
    expect((await f.mover.move('thread', '95', 'trail')).ok).toBe(false);
    expect(f.mover.get('thread', '95')!.phase).toBe('unknown'); expect(f.store.thread('thread')!.stop_price).toBe('90');
  });

  it('挂新确认后才撤旧；撤旧失败保留两单、ok:true、持久attention及事件', async () => {
    const f = await fixture('replace');
    const cancel = vi.spyOn(f.backend, 'cancelOrder').mockImplementation(async () => {
      expect(f.mover.get('thread', '95')!.phase).toBe('confirmed'); expect(f.store.thread('thread')!.stop_price).toBe('95');
      return { ok: false, error: 'cancel timeout' };
    });
    expect((await f.mover.move('thread', '95', 'trail')).ok).toBe(true);
    expect(f.mover.get('thread', '95')).toMatchObject({ phase: 'confirmed', attention: 'STOP_MOVE_OLD_CANCEL_FAILED' });
    expect((await f.backend.account()).open_orders.filter(o => o.type === 'STOP_MARKET')).toHaveLength(2);
    const account = await f.backend.account(), t = f.store.thread('thread')!;
    const reconciled = reconcileThread(t, { now: Date.now(), position: account.positions[0]!, entry_order: null, open_orders: account.open_orders, mark: '100' });
    expect(reconciled.next.attention).toBe('STOP_MOVE_OLD_CANCEL_FAILED');
    expect(f.events.mock.calls.at(-1)![0].detail).toContain('两张保护');
    expect((await f.restart().move('thread', '95', 'retry')).ok).toBe(true); expect(cancel).toHaveBeenCalledTimes(1);
    expect((await f.mover.move('thread', '96', 'next')).ok).toBe(false);
  });

  it('撤旧ACK成功但仍可见也要attention', async () => {
    const f = await fixture('replace'); vi.spyOn(f.backend, 'cancelOrder').mockResolvedValue({ ok: true, error: null });
    expect((await f.mover.move('thread', '95', 'trail')).ok).toBe(true);
    expect(f.mover.get('thread', '95')!.attention).toBe('STOP_MOVE_OLD_CANCEL_FAILED');
  });

  it('撤旧超时但同CID已确认撤销可完成替换', async () => {
    const f = await fixture('replace'), cancel = f.backend.cancelOrder.bind(f.backend);
    vi.spyOn(f.backend, 'cancelOrder').mockImplementation(async (...args) => { await cancel(...args); return { ok: false, error: 'lost ack' }; });
    expect((await f.mover.move('thread', '95', 'trail')).ok).toBe(true);
    expect(f.mover.get('thread', '95')!.phase).toBe('replaced');
  });
  it('撤旧后新保护丢失：unknown，不伪报成功；只读恢复后不重复撤单', async () => {
    const f = await fixture('replace'), cancel = f.backend.cancelOrder.bind(f.backend), query = f.backend.getStopProtection.bind(f.backend);
    let invisible = false;
    const canceled = vi.spyOn(f.backend, 'cancelOrder').mockImplementation(async (...args) => { const result = await cancel(...args); invisible = true; return result; });
    vi.spyOn(f.backend, 'getStopProtection').mockImplementation(async (...args) => invisible ? null : query(...args));
    expect((await f.mover.move('thread', '95', 'trail')).ok).toBe(false);
    expect(f.mover.get('thread', '95')).toMatchObject({ phase: 'unknown', attention: 'STOP_MOVE_NEW_UNCONFIRMED' });
    expect(f.store.thread('thread')).toMatchObject({ stop_price: '95', protection_missing: true });
    invisible = false;
    expect((await f.restart().move('thread', '95', 'reconcile')).ok).toBe(true); expect(canceled).toHaveBeenCalledTimes(1);
    expect(f.store.thread('thread')).toMatchObject({ stop_price: '95', protection_missing: false, attention: null });
  });

  it.each([true, false])('撤旧期间巡检更新closed/qty不被旧对象覆盖(cancel=%s)', async ok => {
    const f = await fixture('replace'), cancel = f.backend.cancelOrder.bind(f.backend);
    vi.spyOn(f.backend, 'cancelOrder').mockImplementation(async (...args) => {
      f.store.saveThread({ ...f.store.thread('thread')!, status: 'closed', qty: '0.5', closed_at: 123, version: 30 });
      return ok ? cancel(...args) : { ok: false, error: 'timeout' };
    });
    await f.mover.move('thread', '95', 'trail');
    expect(f.store.thread('thread')).toMatchObject({ status: 'closed', qty: '0.5', closed_at: 123 });
  });

  it.each([['long', '89'], ['long', '90'], ['short', '111'], ['short', '110']] as const)('%s拒绝放宽或等价目标%s', async (side, target) => {
    const f = await fixture('paper', side), write = vi.spyOn(f.backend, 'replacePaperStop');
    expect((await f.mover.move('thread', target, 'bad')).ok).toBe(false); expect(write).not.toHaveBeenCalled();
  });
  it('short可收紧', async () => { const f = await fixture('paper', 'short'); expect((await f.mover.move('thread', '105', 'trail')).ok).toBe(true); });
  it('两个编排实例并发读取planned，提交CAS保证只发送一次', async () => {
    const f = await fixture(), write = vi.spyOn(f.backend, 'replacePaperStop');
    await Promise.all([f.mover.move('thread', '95', 'one'), f.restart().move('thread', '95', 'two')]);
    expect(write).toHaveBeenCalledTimes(1); expect(f.mover.get('thread', '95')!.phase).toBe('replaced');
  });
  it('移损后纸面重启仍只有新止损；存盘异常不得报告确认', async () => {
    let snapshot: string | null = null, reject = false;
    const persist = { load: () => snapshot, save: (json: string) => { if (reject) throw new Error('disk full'); snapshot = json; } };
    const backend = new PaperBackend(10000, { persist }); backend.setMark('BTCUSDT', '100');
    await backend.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '1', entry: 'market', limit_price: null, client_order_id: 'entry' });
    await backend.placeStop('BTCUSDT', 'long', '90', 'old');
    const req = { symbol: 'BTCUSDT', market: 'perp' as const, side: 'long' as const, qty: '1', old_stop: '90', target_stop: '95', old_cid: 'old', old_algo_id: null, new_cid: 'new' };
    reject = true; expect((await backend.replacePaperStop(req)).outcome).toBe('unknown');
    expect(await backend.getStopProtection('BTCUSDT', 'old', 'perp')).not.toBeNull();
    expect(await backend.getStopProtection('BTCUSDT', 'new', 'perp')).toBeNull();
    reject = false; expect((await backend.replacePaperStop(req)).outcome).toBe('submitted');
    const restored = new PaperBackend(10000, { persist });
    expect(await restored.getStopProtection('BTCUSDT', 'new', 'perp')).toMatchObject({ stop_price: '95' });
    expect(await restored.getStopProtection('BTCUSDT', 'old', 'perp')).toBeNull();
  });
  it.each(['NaN', '1e2', '-1', '0', 'Infinity'])('拒绝非法十进制%s', async target => {
    const f = await fixture(); expect((await f.mover.move('thread', target, 'bad')).ok).toBe(false);
  });
  it('十进制比较不丢失浮点精度', () => {
    expect(compareStopPrices('9007199254740992.0000000001', '9007199254740992')).toBe(1);
    expect(stopMoveDecimal('00090.000')).toBe('90');
  });

  it.each(['key', 'halt', 'stop', 'qty'] as const)('读旧保护后%s改变：发送前只拒、不修改目标', async change => {
    const f = await fixture(), query = f.backend.getStopProtection.bind(f.backend), write = vi.spyOn(f.backend, 'replacePaperStop');
    vi.spyOn(f.backend, 'getStopProtection').mockImplementation(async (...args) => {
      const p = await query(...args);
      if (change === 'key') f.setKey('other'); else if (change === 'halt') f.block();
      else f.store.saveThread({ ...f.store.thread('thread')!, ...(change === 'stop' ? { stop_price: '96' } : { qty: '0.5' }) });
      return p;
    });
    expect((await f.mover.move('thread', '95', 'trail')).ok).toBe(false); expect(write).not.toHaveBeenCalled();
    expect(f.mover.get('thread', '95')!.target_stop).toBe('95');
  });

  it('OCO无amend能力时拒绝，不能撤掉TP', async () => {
    const f = await fixture('replace'), query = f.backend.getStopProtection.bind(f.backend), write = vi.spyOn(f.backend, 'placeStop');
    vi.spyOn(f.backend, 'getStopProtection').mockImplementation(async (...args) => { const p = await query(...args); return p && { ...p, take_profit_price: '120' }; });
    expect((await f.mover.move('thread', '95', 'trail')).ok).toBe(false); expect(write).not.toHaveBeenCalled();
  });
});
