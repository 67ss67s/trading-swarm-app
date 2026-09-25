/** OKX 只注入 spawn 桩，不启动CLI、不读配置、不请求交易所。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { OkxCliBackend, type OkxRunResult } from '../../src/demo/execution-okx.js';
import { StopMover } from '../../src/demo/execution-stop.js';
import { hasLiveStop, newThread } from '../../src/demo/threads.js';
import { resetInstruments, setInstruments, toClOrdId } from '../../src/demo/okx/instruments.js';
import type { Market } from '../../src/demo/types.js';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(f => f()); resetInstruments(); vi.restoreAllMocks(); });
function fixture(market: Market = 'perp', oco = false) {
  setInstruments([{ symbol: 'BTCUSDT', instId: 'BTC-USDT-SWAP', instFamily: 'BTC-USDT', ctVal: '0.01', ctValCcy: 'BTC', lotSz: '0.01', minSz: '0.01', tickSz: '0.1', state: 'live' }]);
  setInstruments([{ symbol: 'BTCUSDT', instId: 'BTC-USDT', instFamily: 'BTC-USDT', ctVal: '1', ctValCcy: 'BTC', lotSz: '0.00001', minSz: '0.0001', tickSz: '0.1', state: 'live' }], Date.now(), 'spot');
  const state = openStateDb(':memory:'), store = new DemoStore(state); cleanup.push(() => state.close());
  const t = newThread({ id: 'okx-thread', backend: 'okx', market, symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '1h', thesis: '', invalidation_text: null, watch_conditions: [],
    entry: { type: 'market', price: '80000', zone: null }, stop_price: '78000', take_profits: oco ? ['85000'] : [], qty: '0.13', margin_usdt: '1000', leverage: 3, margin_mode: 'cross', now: 1 });
  t.status = 'in_position'; t.protection_client_order_ids = oco ? ['tgd-old-s1', 'tgd-old-t2'] : ['tgd-old-s1']; store.saveThread(t);
  const kv = new Map<string, string>();
  if (oco) for (const cid of t.protection_client_order_ids) kv.set(`okx.algo.v1:${market === 'spot' ? 'spot:' : ''}${toClOrdId(cid)}`, 'A1');
  let raw: Record<string, unknown> = { instId: market === 'spot' ? 'BTC-USDT' : 'BTC-USDT-SWAP', algoId: 'A1', algoClOrdId: oco ? '' : 'tgdolds1',
    state: 'live', ordType: oco ? 'oco' : 'conditional', side: 'sell', sz: market === 'spot' ? '0.13' : '13', slTriggerPx: '78000', slOrdPx: '-1',
    slTriggerPxType: market === 'spot' ? 'last' : 'mark', tpTriggerPx: oco ? '85000' : '', reduceOnly: oco ? undefined : 'true', posSide: 'net' };
  let written = false, visible = true, blocked = false, reads = 0;
  let writeResult: OkxRunResult = { code: 0, stdout: '[{"algoId":"A1","sCode":"0"}]', stderr: '' };
  const calls: string[][] = [];
  const backend = new OkxCliBackend({ bin: '/nonexistent/okx', profile: 'stub', demo: true, live: false, kv: { get: k => kv.get(k) ?? null, set: (k, v) => { kv.set(k, v); } }, log: () => {},
    spawnFn: async (_bin, args) => {
      calls.push(args);
      if (args.includes('amend')) {
        const row = mover.get(t.id, '79000');
        expect(row).toMatchObject({ phase: 'submitted', old_cid: 'tgd-old-s1', old_algo_id: 'A1', new_cid: expect.any(String) });
        expect(store.thread(t.id)!.stop_price).toBe('78000');
        written = true; return writeResult;
      }
      if (args.includes('orders') && args.includes('algo')) {
        reads++;
        if (!visible) return { code: 0, stdout: '[]', stderr: '' };
        const rows = args.includes(String(raw.ordType)) ? [{ ...raw, slTriggerPx: written && writeResult.code === 0 ? '79000' : raw.slTriggerPx }] : [];
        return { code: 0, stdout: JSON.stringify(rows), stderr: '' };
      }
      throw new Error(`unexpected stub call:${args.join(' ')}`);
    } });
  const deps = { store, backend: () => backend, executionKey: () => 'okx:stub:demo', blocked: () => blocked ? 'blocked' : null };
  const mover = new StopMover(deps);
  return { backend, mover, store, t, calls, state, deps, getReads: () => reads,
    setRaw: (patch: Record<string, unknown>) => { raw = { ...raw, ...patch }; }, hide: () => { visible = false; }, show: () => { visible = true; }, block: () => { blocked = true; },
    setResult: (result: OkxRunResult) => { writeResult = result; } };
}
describe('OKX 移损桩', () => {
  it.each([['perp', false], ['perp', true], ['spot', false], ['spot', true]] as const)('%s OCO=%s:只amend原algo触发价，查询确认后才更新线程', async (market, oco) => {
    const f = fixture(market, oco);
    expect((await f.mover.move(f.t.id, '79000', 'trail')).ok).toBe(true);
    expect(f.store.thread(f.t.id)!.stop_price).toBe('79000'); expect(f.mover.get(f.t.id, '79000')!.phase).toBe('replaced');
    expect(f.calls.filter(c => c.includes('amend'))).toHaveLength(1);
    const call = f.calls.find(c => c.includes('amend'))!;
    expect(call).toContain(market === 'spot' ? 'spot' : 'swap'); expect(call).toContain('--demo');
    expect(call.slice(call.indexOf('--algoId'))).toEqual(['--algoId', 'A1', '--newSlTriggerPx', '79000']);
    expect(f.calls.some(c => c.includes('place') || c.includes('cancel'))).toBe(false);
    expect((await f.mover.move(f.t.id, '79000.0', 'retry')).ok).toBe(true); expect(f.calls.filter(c => c.includes('amend'))).toHaveLength(1);
    if (oco) expect(f.store.thread(f.t.id)!.protection_client_order_ids).toContain('tgd-old-t2');
  });

  it.each(['timeout', '50004', 'throw'] as const)('%s:unknown仅查询原algo，查不到不发新目标，恢复可见后收敛', async failure => {
    const f = fixture();
    f.setResult(failure === '50004' ? { code: 1, stdout: '{"code":"50004","msg":"timeout","data":[]}', stderr: '' } : { code: 124, stdout: '', stderr: '', timedOut: true });
    if (failure === 'throw') vi.spyOn(f.backend, 'amendStop').mockRejectedValue(new Error('connection lost'));
    expect((await f.mover.move(f.t.id, '79000', 'trail')).ok).toBe(false);
    expect(f.mover.get(f.t.id, '79000')!.phase).toBe('unknown'); f.hide();
    const resumed = new StopMover(f.deps);
    await resumed.move(f.t.id, '79000', 'retry'); await resumed.move(f.t.id, '79500', 'new target');
    expect(f.mover.get(f.t.id, '79500')).toBeNull(); expect(f.calls.filter(c => c.includes('amend'))).toHaveLength(failure === 'throw' ? 0 : 1);
    f.show(); f.setRaw({ slTriggerPx: '79000' });
    expect((await resumed.move(f.t.id, '79000', 'late read')).ok).toBe(true);
  });

  it('明确amend拒单保留原保护且不降级挂新撤旧', async () => {
    const f = fixture(); f.setResult({ code: 0, stdout: '[{"algoId":"A1","sCode":"51538","sMsg":"reject"}]', stderr: '' });
    expect((await f.mover.move(f.t.id, '79000', 'trail')).ok).toBe(false);
    expect(f.mover.get(f.t.id, '79000')!.phase).toBe('failed'); expect(f.store.thread(f.t.id)!.stop_price).toBe('78000');
    expect(f.calls.some(c => c.includes('place') || c.includes('cancel'))).toBe(false);
  });

  it.each([
    { state: 'effective' }, { instId: 'ETH-USDT-SWAP' }, { side: 'buy' }, { sz: '12' }, { algoClOrdId: 'foreign' },
    { slOrdPx: '77900' }, { slTriggerPx: '78100' }, { reduceOnly: 'false' }, { posSide: 'long' }, { algoId: '' },
  ])('旧保护字段不符%j:零写调用', async patch => {
    const f = fixture(); f.setRaw(patch);
    expect((await f.mover.move(f.t.id, '79000', 'trail')).ok).toBe(false);
    expect(f.calls.some(c => c.includes('amend'))).toBe(false);
  });

  it('ACK成功但目标查询失败不能报ok', async () => {
    const f = fixture(), amend = f.backend.amendStop.bind(f.backend);
    vi.spyOn(f.backend, 'amendStop').mockImplementation(async (...args) => { const r = await amend(...args); f.hide(); return r; });
    expect((await f.mover.move(f.t.id, '79000', 'trail')).ok).toBe(false);
    expect(f.store.thread(f.t.id)!.stop_price).toBe('78000'); expect(f.mover.get(f.t.id, '79000')!.phase).toBe('unknown');
  });
  it('附带OCO的KV归属不能覆盖显式reduceOnly=false', async () => {
    const f = fixture('perp', true); f.setRaw({ reduceOnly: 'false' });
    expect((await f.mover.move(f.t.id, '79000', 'trail')).ok).toBe(false);
    expect(f.calls.some(c => c.includes('amend'))).toBe(false);
  });
  it('现货止损数量大于余仓也必须拒绝，不能靠移损改数量', async () => {
    const f = fixture('spot'); f.store.saveThread({ ...f.t, qty: '0.05' });
    expect((await f.mover.move(f.t.id, '79000', 'trail')).ok).toBe(false);
    expect(f.calls.some(c => c.includes('amend'))).toBe(false);
  });
  it('后端最后一次读取期间授权改变，发送前拒绝', async () => {
    const f = fixture(), query = f.backend.getStopProtection.bind(f.backend); let n = 0;
    vi.spyOn(f.backend, 'getStopProtection').mockImplementation(async (...args) => { const p = await query(...args); if (++n === 2) f.block(); return p; });
    expect((await f.mover.move(f.t.id, '79000', 'trail')).ok).toBe(false); expect(f.calls.some(c => c.includes('amend'))).toBe(false);
  });
  it('amend新价已生效但未更新线程：规范化CID证明原保护仍存在', () => {
    const f = fixture();
    expect(hasLiveStop(f.t, [{ symbol: 'BTCUSDT', market: 'perp', client_order_id: 'tgdolds1', type: 'STOP_MARKET', side: 'SELL', qty: '0.13', stop_price: '79000', price: null, reduce_only: true, status: 'live' }])).toBe(true);
  });
});
