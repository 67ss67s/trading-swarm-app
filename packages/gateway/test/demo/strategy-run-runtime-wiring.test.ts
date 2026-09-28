import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { ResearchStore } from '../../src/demo/research/store.js';
import { StrategyStore } from '../../src/demo/research/strategies/store.js';
import { StrategyService } from '../../src/demo/research/strategies/service.js';
import { policyToIR } from '../../src/demo/research/strategy.js';
import { SYNTH_POLICY } from '../../src/demo/strategy-candidate.js';
import { sizeRunOrder, type RunCandidate } from '../../src/demo/strategy-run-orders.js';
import { runOrigin, type StrategyRun } from '../../src/demo/strategy-run.js';
import { SIZING_SYSTEM } from '../../src/demo/sizing-agent.js';
import type { Kline } from '../../src/demo/types.js';

// R14/R19 runtime 接线:只用 PaperBackend 与进程内行情桩,不起定时器/端口,不碰真实交易所或付费模型。
const H = 3_600_000, T0 = Date.UTC(2026, 8, 1);
function bars(): Kline[] {
  const out = Array.from({ length: 100 }, (_, i) => ({ open_time: T0 + i * H, close_time: T0 + (i + 1) * H - 1, open: '100', high: '100.8', low: '99.2', close: i % 2 ? '100.3' : '99.7', volume: '10' }));
  out.push({ open_time: T0 + 100 * H, close_time: T0 + 101 * H - 1, open: '100.2', high: '103.2', low: '100.1', close: '103', volume: '30' }); return out;
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); vi.restoreAllMocks(); });

async function setup(opts: { risk_pct?: number; customize?: (ir: ReturnType<typeof policyToIR>) => void; sizing_agent?: 'off' | 'advise' | 'apply' } = {}) {
  const market = await import('../../src/demo/market.js');
  vi.spyOn(Date, 'now').mockReturnValue(T0 + 101 * H + 5000);
  vi.spyOn(market, 'fetchKlines').mockImplementation(async (_symbol, tf) => {
    const ms = market.tfToMs(tf), end = Math.floor(Date.now() / ms) * ms;
    return bars().map((k, i, a) => ({ ...k, open_time: end - (a.length - i) * ms, close_time: end - (a.length - i - 1) * ms - 1 }));
  });
  vi.spyOn(market, 'fetchMarketView').mockImplementation(async (symbol, tf, m) => ({ symbol, market: m ?? 'perp', mark: '103', last: '103', as_of: Date.now(), klines_tf: tf, funding_rate: '0', next_funding_at: 0, open_interest: '0' }));
  vi.spyOn(market, 'fetchTicker24h').mockResolvedValue({ symbol: 'BTCUSDT', quoteVolume: '1000000000' } as never);
  const { DemoRuntime } = await import('../../src/demo/runtime.js'); const { PaperBackend } = await import('../../src/demo/execution.js'); const { stubBrain } = await import('../../src/demo/brain.js');
  const state = openStateDb(':memory:'), store = new DemoStore(state);
  const ir = policyToIR(SYNTH_POLICY); ir.order = { direction: 'long', market: 'perp', leverage: 2 }; opts.customize?.(ir);
  const service = new StrategyService(new StrategyStore(state.db, () => Date.now()), new ResearchStore(state.db), null);
  const s = service.create({ name: '接线测试', symbol: 'BTCUSDT', timeframe: '1h', strategy_ir: ir });
  const backend = new PaperBackend(10000), calls = vi.fn(() => '{"decision":"follow","reason":"x"}');
  const rt = new DemoRuntime({ store, backend, brains: { stub: stubBrain(calls) } });
  rt.workflow = { ...rt.workflow, brain: 'stub', cheap_brain: 'stub', timeframe: '1h', watchlist: ['BTCUSDT'], markets: ['spot', 'perp'], auto_approve: false, risk_pct: '0.1', leverage: 3, sizing_agent: opts.sizing_agent ?? 'apply', strategy_council: 'off', entry_style: 'free' };
  rt.markets.set('BTCUSDT', await market.fetchMarketView('BTCUSDT', '1h', 'perp'));
  const runner = rt.strategyRuns();
  cleanups.push(async () => { await rt.stop(); state.close(); });
  // signal_only:建运行时首轮扫描不下单,下面直接调 deps 验证开仓链。
  const { run } = await runner.create({ strategy_id: s.id, mode: 'signal_only', market: 'perp', symbols: ['BTCUSDT'], risk_pct: opts.risk_pct ?? 1, max_open: 3, publish_asp: false });
  // 直接调 deps 时要求运行处于 running(发送前授权);signal_only 模式只影响扫描,不影响 deps。
  return { rt, runner, backend, store, run: runner.store.require(run.id), calls };
}
function candidate(run: StrategyRun, patch: Partial<RunCandidate> = {}): RunCandidate {
  return { id: 'cand_1', version_tag: 'x', at: Date.now(), as_of: T0 + 101 * H, symbol: 'BTCUSDT', timeframe: '1h', strategy_id: run.strategy_id, version: run.version, ir_hash: run.ir_hash,
    ir_source: 'research_strategy_version', origin: 'online', direction: 'long', entry_type: 'next_open_market', entry_ref: 103, stop: 101, target: 107, target_source: null,
    take_profits: [{ price: 107, size_pct: 1 }], rr: 2, invalidation: 101, horizon_bars: 48, reason: '接线测试', unmapped: [], view_bars: 50, status: 'open', model: null, settlement: null,
    size_weight: 0.1, size_note: 'vt', ...patch } as unknown as RunCandidate;
}

describe('strategyRuns() R14/R19 依赖接线', () => {
  it('radarSymbols:最新 done 轮按 rank 去重取前 N,未完成/没有轮次返回 []', async () => {
    const f = await setup();
    expect(await f.runner.deps.radarSymbols!('swing', 3)).toEqual([]);
    const screen = (id: string, status: string, started_at: number) => ({ id, horizon: 'swing', started_at, finished_at: status === 'done' ? started_at + 1 : null, status, universe: 'explicit', symbols: [], errors: [], run_id: null, handoff_id: null, proposal: null, brain: null, cost_cny: 0, error: null });
    const cand = (screen_id: string, symbol: string, rank: number, strategy_id = 's1') => ({ screen_id, horizon: 'swing', symbol, strategy_id, fit_score: 1, rank, reasons: [], card: {}, ttl_at: 0, created_at: 0 });
    f.store.screens.saveScreen(screen('sc_old', 'done', 1) as never);
    f.store.screens.saveCandidates([cand('sc_old', 'XRPUSDT', 1)] as never);
    f.store.screens.saveScreen(screen('sc_new', 'done', 2) as never);
    f.store.screens.saveCandidates([cand('sc_new', 'SOLUSDT', 2), cand('sc_new', 'ETHUSDT', 1), cand('sc_new', 'ETHUSDT', 3, 's2'), cand('sc_new', 'BNBUSDT', 4), cand('sc_new', 'DOGEUSDT', 5)] as never);
    f.store.screens.saveScreen(screen('sc_running', 'running', 3) as never);
    expect(await f.runner.deps.radarSymbols!('swing', 3)).toEqual(['ETHUSDT', 'SOLUSDT', 'BNBUSDT']);
    expect(await f.runner.deps.radarSymbols!('weekly', 3)).toEqual([]);
  });

  it('openSized:数量 = sizeRunOrder,走组合经理/发送前重闸并真实成交', async () => {
    const f = await setup({ risk_pct: 1 });
    f.run.status = 'running'; f.runner.store.save(f.run);
    const c = candidate(f.run), rules = await f.backend.symbolRules('BTCUSDT', 'perp'), account = await f.backend.account();
    const want = sizeRunOrder(f.run, c, f.runner.store.ir(f.run.id), { equity: account.equity, cash: account.available, price: '103', fee_rate: '0.0005', step_size: rules.step_size, leverage_cap: 3 })!;
    const send = vi.spyOn(f.backend, 'placeEntry');
    const result = await f.runner.deps.openSized!(f.run, c, 'auto');
    expect(result.outcome).toBe('opened');
    const t = f.store.thread(result.thread_id!)!;
    expect(t.qty).toBe(want.qty);
    expect(Number(t.qty)).toBeGreaterThan(19); // 10000×0.1×2/103 ≈ 19.4,远大于 fixed_risk(1% / 2 = 50 → 按风险算会是 ~50)
    expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0]![0].qty).toBe(want.qty);
    expect(t).toMatchObject({ status: 'in_position', origin: runOrigin(f.run.id), leverage: 2 });
    const intent = f.store.intentsForThread(t.id).find(i => i.kind === 'open')!;
    expect(intent.quantity).toBe(want.qty); expect(intent.sizing.note).toContain('波动率目标');
  });

  it('openSized:单笔止损风险超过 run.risk_pct 只拒不改,不退回 fixed_risk,不发单', async () => {
    const f = await setup({ risk_pct: 0.1 });
    f.run.status = 'running'; f.runner.store.save(f.run);
    const send = vi.spyOn(f.backend, 'placeEntry');
    const result = await f.runner.deps.openSized!(f.run, candidate(f.run), 'auto');
    expect(result.outcome).toBe('rejected'); expect(result.reason).toContain('数量不可用');
    expect(send).not.toHaveBeenCalled(); expect(f.backend.snapshot().positions).toHaveLength(0);
  });

  it('open/openSized 互不退回;候选与运行版本不一致拒绝', async () => {
    const f = await setup();
    f.run.status = 'running'; f.runner.store.save(f.run);
    const send = vi.spyOn(f.backend, 'placeEntry');
    expect((await f.runner.deps.open(f.run, candidate(f.run), 'auto')).reason).toMatch(/^vol_target_not_connected/);
    expect((await f.runner.deps.openSized!(f.run, candidate(f.run, { size_weight: undefined }), 'auto')).reason).toMatch(/^vol_target_sizing_unavailable/);
    const r = await f.runner.deps.openSized!(f.run, candidate(f.run, { ir_hash: 'other' }), 'auto');
    expect(r.outcome).toBe('rejected'); expect(r.reason).toContain('vol_target_sizing_rejected');
    expect(send).not.toHaveBeenCalled(); expect(f.store.threads()).toHaveLength(0);
  });

  it('moveStop 已接独立安全移损链；其余未接依赖保持显式缺失', async () => {
    const f = await setup({ customize: ir => { ir.exit.push({ primitive: 'chandelier_trail', params: { atr_period: 22, mult: 3 } } as never); } });
    expect(f.runner.deps.moveStop).toBeTypeOf('function');
    expect(f.runner.deps.add).toBeUndefined(); expect(f.runner.deps.flip).toBeUndefined(); expect(f.runner.deps.positionState).toBeUndefined();
    expect(f.runner.preflight(f.run.strategy_id).warnings.map(w => w.code)).not.toContain('trailing_not_connected');
  });

  it('reconcileOpen:只认落库事实;unknown/无线程保持等待,成交=opened,确认零成交终态=rejected', async () => {
    const f = await setup();
    f.run.status = 'running'; f.runner.store.save(f.run);
    const reconcile = f.runner.deps.reconcileOpen!;
    expect(await reconcile(f.run, 'cand_1', null)).toBeNull();
    expect(await reconcile(f.run, 'cand_1', 'thr_missing')).toBeNull();
    const opened = await f.runner.deps.openSized!(f.run, candidate(f.run), 'auto');
    const t = f.store.thread(opened.thread_id!)!, intent = f.store.intentsForThread(t.id).find(i => i.kind === 'open')!;
    expect((await reconcile(f.run, 'cand_1', t.id))?.outcome).toBe('opened');
    f.store.saveIntent({ ...intent, status: 'unknown' });
    expect(await reconcile(f.run, 'cand_1', t.id)).toBeNull();
    f.store.saveIntent({ ...intent, status: 'failed' });
    f.store.saveThread({ ...t, status: 'canceled', opened_at: null, filled_avg_price: null });
    expect((await reconcile(f.run, 'cand_1', t.id))?.outcome).toBe('rejected');
    f.store.saveThread({ ...t, status: 'canceled', opened_at: null, filled_avg_price: null, attention: 'ENTRY_REMAINDER' });
    expect(await reconcile(f.run, 'cand_1', t.id)).toBeNull();
    f.store.saveThread({ ...t, origin: 'strategy_run:other' });
    expect(await reconcile(f.run, 'cand_1', t.id)).toBeNull();
  });
});

describe('§9.56 执行层接到策略运行', () => {
  const pm = (system: string) => system === SIZING_SYSTEM ? '{"risk_multiplier":0.5,"allow_min_lot_overshoot":false,"reason":"同簇仓位偏多"}' : '{"decision":"follow","reason":"x"}';

  it('固定风险的运行也按组合经理倍率算仓位;波动率目标不问', async () => {
    const off = await setup({ risk_pct: 1, sizing_agent: 'off' });
    off.run.status = 'running'; off.runner.store.save(off.run);
    const base = await off.runner.deps.open(off.run, candidate(off.run, { size_weight: undefined }), 'auto');
    expect(base.outcome).toBe('opened');
    const baseQty = Number(off.store.thread(base.thread_id!)!.qty);

    const on = await setup({ risk_pct: 1, sizing_agent: 'apply' });
    on.calls.mockImplementation(pm as never);
    on.run.status = 'running'; on.runner.store.save(on.run);
    const half = await on.runner.deps.open(on.run, candidate(on.run, { size_weight: undefined }), 'auto');
    expect(half.outcome).toBe('opened');
    const t = on.store.thread(half.thread_id!)!;
    expect(Number(t.qty)).toBeCloseTo(baseQty / 2, 1);
    const intent = on.store.intentsForThread(t.id).find(i => i.kind === 'open')!;
    expect(intent.sizing.agent).toMatchObject({ multiplier: 0.5, applied: true });
    // 仓位意见看到的是这条运行自己的 risk_pct
    expect(on.store.episode(intent.episode_id)?.sizing_evidence?.['risk_pct']).toBe('1');

    const sized = await setup({ risk_pct: 1, sizing_agent: 'apply' });
    sized.calls.mockImplementation(pm as never);
    sized.run.status = 'running'; sized.runner.store.save(sized.run);
    expect((await sized.runner.deps.openSized!(sized.run, candidate(sized.run), 'auto')).outcome).toBe('opened');
    expect(sized.calls.mock.calls.some(args => (args as unknown[])[0] === SIZING_SYSTEM)).toBe(false);
  });

  it('止损太近被执行层拒单,结果带层、原因码和原样闸结果,不发单', async () => {
    const f = await setup({ sizing_agent: 'off' });
    f.run.status = 'running'; f.runner.store.save(f.run);
    const send = vi.spyOn(f.backend, 'placeEntry');
    // 103 的入场、102.85 的止损 = 0.15%,和 09-26 SOL 那四个候选一样
    const r = await f.runner.deps.open(f.run, candidate(f.run, { size_weight: undefined, stop: 102.85, target: 103.6, take_profits: [{ price: 103.6, size_pct: 1 }] }), 'auto');
    expect(r).toMatchObject({ outcome: 'rejected', layer: 'gate', code: 'stop_distance' });
    // 百分比模式(默认)只有一行止损距离,不出 ATR 那一行
    expect((r as { gates?: { name: string; code?: string }[] }).gates?.map(g => g.code)).toEqual(['stop_distance']);
    expect(r.reason).toContain('允许 1%–5%');
    expect(send).not.toHaveBeenCalled();
  });

  // 行情桩:1h 每根高低差 1.6,ATR14 ≈ 1.7(约 1.65% of 103)
  it('ATR 模式:按 stop_floor_atr_tf 那根的 ATR 判,原因码 stop_atr;百分比底线不再生效', async () => {
    const f = await setup({ sizing_agent: 'off' });
    f.run.status = 'running'; f.runner.store.save(f.run);
    f.rt.setWorkflow({ stop_floor_mode: 'atr', stop_floor_atr_tf: '1h', min_stop_atr: 1 });
    // 103 → 102.2 = 0.78%,不到 0.5×ATR
    const tight = await f.runner.deps.open(f.run, candidate(f.run, { size_weight: undefined, stop: 102.2, target: 105, take_profits: [{ price: 105, size_pct: 1 }] }), 'auto');
    expect(tight).toMatchObject({ outcome: 'rejected', layer: 'gate', code: 'stop_atr' });
    expect(tight.reason).toMatch(/×ATR\(下限 1×1h ATR/);
    // 0.97% 在百分比模式会被 1% 挡;ATR 模式把倍数降到 0.5 就放行,说明百分比底线没在判
    f.rt.setWorkflow({ min_stop_atr: 0.5 });
    const ok = await f.runner.deps.open(f.run, candidate(f.run, { size_weight: undefined, stop: 102, target: 106, take_profits: [{ price: 106, size_pct: 1 }] }), 'auto');
    expect(ok.outcome).toBe('opened');
  });

  it('ATR 模式但 K 线取不到:改按百分比判,原因里写明', async () => {
    const f = await setup({ sizing_agent: 'off' });
    f.run.status = 'running'; f.runner.store.save(f.run);
    f.rt.setWorkflow({ stop_floor_mode: 'atr', stop_floor_atr_tf: '4h', min_stop_atr: 1 });
    const market = await import('../../src/demo/market.js');
    vi.mocked(market.fetchKlines).mockRejectedValue(new Error('网络断了'));
    const r = await f.runner.deps.open(f.run, candidate(f.run, { size_weight: undefined, stop: 102.2, target: 105, take_profits: [{ price: 105, size_pct: 1 }] }), 'auto');
    expect(r).toMatchObject({ outcome: 'rejected', layer: 'gate', code: 'stop_distance' });
    expect(r.reason).toContain('ATR 不可用,改按百分比');
  });

  it('净盈亏比不够被执行层拒单;没有止盈目标的候选不判净盈亏比', async () => {
    const f = await setup({ sizing_agent: 'off' });
    f.run.status = 'running'; f.runner.store.save(f.run);
    const r = await f.runner.deps.open(f.run, candidate(f.run, { size_weight: undefined, target: 104, take_profits: [{ price: 104, size_pct: 1 }] }), 'auto');
    expect(r).toMatchObject({ outcome: 'rejected', code: 'min_net_rr' });
    const noTarget = await f.runner.deps.open(f.run, candidate(f.run, { size_weight: undefined, target: null, take_profits: undefined, symbol: 'BTCUSDT' }), 'auto');
    expect(noTarget.outcome).toBe('opened');
  });

  it('执行层下限跟着 workflow 走', async () => {
    const f = await setup({ sizing_agent: 'off' });
    f.run.status = 'running'; f.runner.store.save(f.run);
    f.rt.setWorkflow({ min_stop_pct: 2 });
    const r = await f.runner.deps.open(f.run, candidate(f.run, { size_weight: undefined }), 'auto');
    expect(r).toMatchObject({ outcome: 'rejected', code: 'stop_distance' });
    expect(r.reason).toContain('允许 2%–5%');
  });
});
