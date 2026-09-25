/** 真运行器逐根管理 → runtime 队列 → 移损账本 → PaperBackend → 线程；全程无端口/行情网络。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { DemoRuntime } from '../../src/demo/runtime.js';
import { stubBrain } from '../../src/demo/brain.js';
import { ResearchStore } from '../../src/demo/research/store.js';
import { StrategyStore } from '../../src/demo/research/strategies/store.js';
import { StrategyService } from '../../src/demo/research/strategies/service.js';
import { node, policyToIR } from '../../src/demo/research/strategy.js';
import { SYNTH_POLICY } from '../../src/demo/strategy-candidate.js';
import { runOrigin } from '../../src/demo/strategy-run.js';
import { newThread } from '../../src/demo/threads.js';
import type { Kline, Market } from '../../src/demo/types.js';

const H = 3600000, T = Date.UTC(2026, 8, 1), cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); vi.restoreAllMocks(); });
async function fixture(primitive: string, market: Market = 'perp', timeStop = false) {
  let now = T + 100 * H + 5000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const state = openStateDb(':memory:'), store = new DemoStore(state), backend = new PaperBackend();
  const model = vi.fn(() => { throw new Error('model must not run'); });
  const rt = new DemoRuntime({ store, backend, brains: { stub: stubBrain(model) } });
  cleanup.push(async () => { await rt.stop(); state.close(); });
  rt.workflow = { ...rt.workflow, brain: 'stub', cheap_brain: 'stub', markets: ['perp', 'spot'], watchlist: ['BTCUSDT'], paused: false, leverage: 3 };
  const ir = policyToIR(SYNTH_POLICY); delete ir.compatibility;
  ir.exit = [node(primitive, primitive === 'chandelier_trail' ? { atr_period: 22, multiple: 3 } : primitive === 'breakeven_after_r' ? { r: 1 } : { lookback: 3 })];
  if (timeStop) ir.exit.push(node('time_stop', { bars: 3 }));
  ir.order = { market, direction: 'long', on_new_signal: { unfilled: 'replace', filled: 'ignore' }, take_profits: [{ source: node('fixed_r_target', { r: 50 }) }] };
  const service = new StrategyService(new StrategyStore(state.db), new ResearchStore(state.db), null);
  const strategy = service.create({ name: '移损端到端', symbol: 'BTCUSDT', timeframe: '1h', strategy_ir: ir });
  const runner = rt.strategyRuns();
  const history: Kline[] = Array.from({ length: 165 }, (_, i) => {
    const px = 100 + Math.max(0, i - 99) * 0.3 + Math.sin(i / 3) * 0.4;
    return { open_time: T + i * H, close_time: T + (i + 1) * H - 1, open: String(px), high: String(px + 1), low: String(px - 1), close: String(px), volume: '100' };
  });
  runner.deps.bars = async (_s, _tf, limit, end) => history.filter(k => k.close_time <= end).slice(-limit);
  runner.deps.generate = x => ({ candidate: null, as_of: x.now, reason: 'test: no entries', view_bars: 100 });
  runner.deps.clock = () => 0;
  const { run } = await runner.create({ strategy_id: strategy.id, market, mode: 'signal_only', symbols: ['BTCUSDT'], publish_asp: false });
  await runner.patch(run.id, { status: 'paused' });
  const t = newThread({ id: 'runtime-stop', backend: 'paper', market, symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '1h', thesis: '', invalidation_text: null, watch_conditions: [],
    entry: { type: 'market', price: '100', zone: null }, stop_price: '90', take_profits: [], qty: '1', margin_usdt: '100', leverage: 1, margin_mode: 'cross', now });
  t.status = 'in_position'; t.opened_at = now; t.filled_avg_price = history[100]!.open; t.strategy_id = `${strategy.id}@1`; t.strategy_version = 1;
  t.origin = runOrigin(run.id); t.protection_client_order_ids = ['original-stop']; store.saveThread(t);
  backend.setMark(t.symbol, t.filled_avg_price, market);
  await backend.placeEntry({ symbol: t.symbol, market, direction: t.side, qty: '1', entry: 'market', limit_price: null, client_order_id: 'entry' });
  await backend.placeStop(t.symbol, t.side, '90', 'original-stop', market);
  return { rt, runner, run, store, state, backend, t, model, step: (n: number) => { now = T + n * H + 5000; } };
}

describe('runtime安全移损接线', () => {
  it.each(['chandelier_trail', 'breakeven_after_r', 'swing_structure_stop'])('%s逐根确认并更新线程与纸面保护', async primitive => {
    const f = await fixture(primitive), write = vi.spyOn(f.backend, 'replacePaperStop');
    f.step(160); await f.runner.scan(f.run.id);
    expect(write.mock.calls.length).toBeGreaterThan(0);
    const latest = f.store.thread(f.t.id)!;
    expect(Number(latest.stop_price)).toBeGreaterThan(90); expect(latest.status).toBe('in_position');
    expect((await f.backend.account()).open_orders.filter(o => o.type === 'STOP_MARKET')).toMatchObject([{ stop_price: latest.stop_price }]);
    const rows = f.state.db.prepare('SELECT phase,run_id FROM demo_stop_moves').all();
    expect(rows).toHaveLength(write.mock.calls.length); expect(rows.every(r => r.phase === 'replaced' && r.run_id === f.run.id)).toBe(true);
    const count = write.mock.calls.length; await f.runner.scan(f.run.id); expect(write).toHaveBeenCalledTimes(count);
    expect(f.model).not.toHaveBeenCalled();
  });

  it('现货使用同一运行器接线，纸面止损真正触发平仓', async () => {
    const f = await fixture('breakeven_after_r', 'spot'); f.step(150); await f.runner.scan(f.run.id);
    const t = f.store.thread(f.t.id)!; expect(Number(t.stop_price)).toBeGreaterThan(90);
    const events = f.backend.tick(t.symbol, t.stop_price!, 'spot');
    expect(events.some(e => e.kind === 'sl_hit')).toBe(true); expect((await f.backend.account()).positions).toHaveLength(0);
  });

  it('移损unknown保留目标/CID，stop_move_unconfirmed且机械时间离场继续', async () => {
    const f = await fixture('chandelier_trail', 'perp', true);
    const write = vi.spyOn(f.backend, 'replacePaperStop').mockResolvedValue({ outcome: 'unknown', receipt: null, avg_price: null, error: 'timeout' });
    const close = vi.spyOn(f.rt, 'followClose').mockImplementation(async id => {
      await f.backend.closePosition('BTCUSDT', 'mechanical-exit');
      f.store.saveThread({ ...f.store.thread(id)!, status: 'closed' }); return { ok: true, detail: 'closed' };
    });
    f.step(104); const result = await f.runner.scan(f.run.id);
    expect(write).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
    expect(result.scan.some(e => e.data?.code === 'stop_move_unconfirmed')).toBe(true);
    expect(f.store.thread(f.t.id)!.status).toBe('closed'); expect(f.model).not.toHaveBeenCalled();
  });
  it('移损unknown时旧保护补挂入口被账本阻断，不补发也不补偿平仓', async () => {
    const f = await fixture('chandelier_trail');
    vi.spyOn(f.backend, 'replacePaperStop').mockResolvedValue({ outcome: 'unknown', receipt: null, avg_price: null, error: 'timeout' });
    await f.runner.deps.moveStop!(f.t, '95', 'trail');
    const send = vi.spyOn(f.backend, 'placeStop'), close = vi.spyOn(f.backend, 'closePosition');
    const internal = f.rt as unknown as { placeProtectionOutsideStopMove: (t: typeof f.t, reason: string) => Promise<void> };
    await internal.placeProtectionOutsideStopMove(f.store.thread(f.t.id)!, '巡检');
    expect(send).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  });
  it('旧保护缺失导致planned零写失败，不永久挡住原保护修复', async () => {
    const f = await fixture('chandelier_trail'); await f.backend.cancelOrder('BTCUSDT', 'original-stop');
    expect((await f.runner.deps.moveStop!(f.t, '95', 'trail')).ok).toBe(false);
    expect(f.state.db.prepare('SELECT phase FROM demo_stop_moves').get()!.phase).toBe('failed');
    const internal = f.rt as unknown as { placeProtectionOutsideStopMove: (t: typeof f.t, reason: string) => Promise<void>; placeProtection: () => Promise<void> };
    const repair = vi.spyOn(internal, 'placeProtection').mockResolvedValue();
    await internal.placeProtectionOutsideStopMove(f.store.thread(f.t.id)!, '修复'); expect(repair).toHaveBeenCalledOnce();
  });
  it('先进入的旧保护异步链与移损互斥，零写拒绝后可安全重试', async () => {
    const f = await fixture('chandelier_trail');
    const internal = f.rt as unknown as { placeProtectionOutsideStopMove: (t: typeof f.t, reason: string) => Promise<void>; placeProtection: () => Promise<void> };
    const releases: (() => void)[] = [];
    vi.spyOn(internal, 'placeProtection').mockImplementation(() => new Promise<void>(resolve => { releases.push(resolve); }));
    const running = internal.placeProtectionOutsideStopMove(f.t, '旧保护');
    const overlapping = internal.placeProtectionOutsideStopMove(f.t, '另一次旧保护');
    const move = vi.spyOn(f.backend, 'replacePaperStop');
    expect((await f.runner.deps.moveStop!(f.t, '95', 'trail')).ok).toBe(false); expect(move).not.toHaveBeenCalled();
    expect(f.state.db.prepare('SELECT COUNT(*) AS n FROM demo_stop_moves').get()!.n).toBe(0);
    releases[0]!(); await running;
    expect((await f.runner.deps.moveStop!(f.t, '95', 'trail')).ok).toBe(false); expect(move).not.toHaveBeenCalled();
    releases[1]!(); await overlapping;
    expect((await f.runner.deps.moveStop!(f.t, '95', 'trail')).ok).toBe(true);
  });
});
