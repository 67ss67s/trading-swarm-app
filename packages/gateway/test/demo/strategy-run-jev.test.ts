/**
 * §9.56 判断层:运行模式 jev(Jev 判断当真门)、confirm 下线、事件带结构化原因、预检核对执行层。
 * 全部用离线判断桩,不碰真实 Jev 和网络。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStateDb } from '../../src/state-db.js';
import { ResearchStore } from '../../src/demo/research/store.js';
import { StrategyStore } from '../../src/demo/research/strategies/store.js';
import { StrategyService } from '../../src/demo/research/strategies/service.js';
import { policyToIR } from '../../src/demo/research/strategy.js';
import { SYNTH_POLICY } from '../../src/demo/strategy-candidate.js';
import { StrategyRunner, runOrigin, type RunEnvironment, type StrategyRunDeps } from '../../src/demo/strategy-run.js';
import { newThread } from '../../src/demo/threads.js';
import type { Kline, StrategyThread } from '../../src/demo/types.js';
import { stubProvider } from '../../src/demo/research/judge/stubs.js';
import { jevShadowFactory, type JevShadowFactory } from '../../src/demo/judge-live.js';
import type { DecisionClient } from '../../src/demo/decisions.js';

const H = 3_600_000, T0 = Date.UTC(2026, 8, 1), NOW = T0 + 101 * H + 5000;
// 不同币给不同成交量:否则状态完全相同,Jev 请求按 request_hash 复用,调用次数对不上
const SYMBOL_VOLUME: Record<string, string> = { BTCUSDT: '30', ETHUSDT: '31', SOLUSDT: '32', BNBUSDT: '33' };
function bars(symbol = 'BTCUSDT'): Kline[] {
  const out = Array.from({ length: 100 }, (_, i) => ({ open_time: T0 + i * H, close_time: T0 + (i + 1) * H - 1, open: '100', high: '100.8', low: '99.2', close: i % 2 ? '100.3' : '99.7', volume: '10' }));
  out.push({ open_time: T0 + 100 * H, close_time: T0 + 101 * H - 1, open: '100.2', high: '103.2', low: '100.1', close: '103', volume: SYMBOL_VOLUME[symbol] ?? '30' }); return out;
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); vi.restoreAllMocks(); });

type Provider = ReturnType<typeof stubProvider>;
function fixture(opts: { ir?: ReturnType<typeof policyToIR>; provider?: Provider | null; shadow?: JevShadowFactory | null; max_calls?: number; micro?: StrategyRunDeps['microstructure'] } = {}) {
  const state = openStateDb(':memory:'); const now = NOW;
  const service = new StrategyService(new StrategyStore(state.db, () => now), new ResearchStore(state.db), null);
  const s = service.create({ name: '影子测试', symbol: 'BTCUSDT', timeframe: '1h', strategy_ir: opts.ir ?? policyToIR(SYNTH_POLICY) });
  const threads: StrategyThread[] = [], emitted: { event: string; payload: unknown }[] = [];
  const environment: RunEnvironment = { execution: { backend: 'paper', profile: null, label: '纸面' }, execution_key: 'paper', watchlist: ['BTCUSDT'], risk_pct: 0.3, leverage_cap: 3, asp: { id: null, identity: false, active: false, publisher_enabled: false } };
  const provider = opts.provider === undefined ? stubProvider('deterministic') : opts.provider;
  const shadow = opts.shadow === undefined
    ? jevShadowFactory({ db: state.db, frozen: () => provider ? { profile: provider.profile, client: provider as unknown as DecisionClient } : null, ...(opts.micro ? { microstructure: opts.micro } : {}), ...(opts.max_calls !== undefined ? { max_calls: opts.max_calls } : {}) })
    : opts.shadow;
  const deps: StrategyRunDeps = { db: state.db, strategies: service, environment: () => environment, blocked: () => null, now: () => now,
    bars: vi.fn(async (symbol: string) => bars(symbol)), threads: id => threads.filter(t => t.origin === runOrigin(id)),
    open: vi.fn(async (run, c, approval) => {
      const t = newThread({ id: `thread_${threads.length}`, backend: 'paper', symbol: c.symbol, market: run.market, strategy_id: `${run.strategy_id}@${run.version}`, side: c.direction, source: 'agent', timeframe: run.timeframe, thesis: 'IR', invalidation_text: null, watch_conditions: [], entry: { type: 'market', price: String(c.entry_ref), zone: null }, stop_price: String(c.stop), take_profits: c.target === null ? [] : [String(c.target)], qty: '1', margin_usdt: '100', leverage: run.leverage, margin_mode: 'isolated', now });
      t.origin = runOrigin(run.id); t.strategy_version = run.version;
      if (approval === 'auto') { t.status = 'in_position'; t.opened_at = now; t.filled_avg_price = String(c.entry_ref); }
      threads.push(t); return { outcome: 'opened', reason: approval, thread_id: t.id };
    }),
    close: vi.fn(async t => { t.status = 'closed'; t.closed_at = now; }), filter: vi.fn(async () => ({ decision: 'skip', reason: '不做' })),
    publish: vi.fn(async () => ({})), emit: vi.fn((event: string, payload: unknown) => { emitted.push({ event, payload }); }),
    ...(shadow ? { jevShadow: shadow } : {}), ...(opts.micro ? { microstructure: opts.micro } : {}) };
  const runner = new StrategyRunner(deps); cleanups.push(async () => { await runner.stop(); state.close(); });
  const create = (patch = {}) => runner.create({ strategy_id: s.id, mode: 'auto', market: 'spot', symbols: ['BTCUSDT'], risk_pct: 0.3, max_open: 3, publish_asp: false, ...patch });
  const live = () => emitted.filter(e => e.event === 'judge.live').map(e => e.payload);
  return { state, deps, runner, threads, create, live, provider, service, s };
}

describe('运行模式 jev', () => {
  it('Jev 说跳过就不下单,记 agent_skip(jev_skip),账本 mode=gate', async () => {
    const f = fixture({ provider: stubProvider('all_skip') });
    const a = await f.create({ mode: 'jev' });
    expect(f.deps.open).not.toHaveBeenCalled();
    const skip = a.scan.find(e => e.kind === 'agent_skip')!;
    expect(skip.data).toMatchObject({ layer: 'judge', code: 'jev_skip', judge: 'jev' });
    const rows = f.runner.judgeLedger.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode: 'gate', action: 'skip' });
  });

  it('决策模型没绑定时按跳过处理,写明原因,不下单', async () => {
    const f = fixture({ provider: null });
    const a = await f.create({ mode: 'jev' });
    expect(f.deps.open).not.toHaveBeenCalled();
    const skip = a.scan.find(e => e.kind === 'agent_skip')!;
    expect(skip.data).toMatchObject({ layer: 'judge', code: 'jev_unavailable' });
    expect(skip.message).toContain('decision_model_unbound');
  });

  it('没接 Jev 时同样按跳过处理', async () => {
    const f = fixture({ shadow: null });
    const a = await f.create({ mode: 'jev' });
    expect(f.deps.open).not.toHaveBeenCalled();
    expect(a.scan.find(e => e.kind === 'agent_skip')?.data).toMatchObject({ code: 'jev_unavailable' });
  });

  it('Jev 放行才开仓;jev 模式不再额外做影子判断', async () => {
    const f = fixture({ provider: stubProvider('deterministic') });
    const a = await f.create({ mode: 'jev' });
    await f.runner.settleShadows();
    const rows = f.runner.judgeLedger.list();
    expect(rows.map(r => r.mode)).toEqual(['gate']);
    const followed = rows[0]!.action === 'follow' && rows[0]!.status === 'ok';
    expect(f.deps.open).toHaveBeenCalledTimes(followed ? 1 : 0);
    expect(a.scan.some(e => e.kind === (followed ? 'agent_follow' : 'agent_skip'))).toBe(true);
  });

  it('Jev 迟迟不回按跳过处理(30 秒上限)', async () => {
    // 录制源一直不返回,判断就卡住;到 30 秒按不可用跳过,不下单
    const f = fixture({ provider: stubProvider('deterministic'), micro: () => new Promise(() => {}) });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = f.create({ mode: 'jev' });
      await vi.advanceTimersByTimeAsync(31_000);
      const a = await pending;
      expect(f.deps.open).not.toHaveBeenCalled();
      const skip = a.scan.find(e => e.kind === 'agent_skip')!;
      expect(skip.data).toMatchObject({ code: 'jev_unavailable' });
      expect(skip.message).toContain('jev_timeout');
    } finally { vi.useRealTimers(); }
  });
});

describe('confirm 下线与结构化事件', () => {
  it('新建和修改都不接受 confirm,错误码 mode_confirm_removed;jev 可以选', async () => {
    const f = fixture();
    expect(() => f.create({ mode: 'confirm' })).toThrow(expect.objectContaining({ code: 'mode_confirm_removed' }));
    const a = await f.create({ mode: 'signal_only' });
    expect(() => f.runner.patch(a.run.id, { mode: 'confirm' })).toThrow(expect.objectContaining({ code: 'mode_confirm_removed' }));
    expect((await f.runner.patch(a.run.id, { mode: 'jev' })).run.mode).toBe('jev');
  });

  it('执行层拒单写进 order_rejected,带层、原因码和原样闸结果', async () => {
    const f = fixture({ shadow: null });
    const gates = [{ name: '止损距离', passed: false, reason: '0.15%(允许 0.3%–5%)', code: 'stop_distance' }];
    f.deps.open = vi.fn(async () => ({ outcome: 'rejected', reason: '基础闸拒绝:止损距离:0.15%(允许 0.3%–5%)', layer: 'gate' as const, code: 'stop_distance', gates }));
    const a = await f.create();
    expect(a.scan.find(e => e.kind === 'order_rejected')?.data).toMatchObject({ layer: 'gate', code: 'stop_distance', gates });
  });

  it('ATR 预检缺少数据时保留自定义百分比下限', async () => {
    const f = fixture({ shadow: null });
    await f.create({ mode: 'signal_only' });
    const env = f.deps.environment() as RunEnvironment;
    env.execution_thresholds = { stop_floor_mode: 'atr', stop_floor_atr_tf: '4h', min_stop_pct: 4, max_stop_pct: 5, min_stop_atr: 1, min_net_rr: 1.5, round_trip_cost_bps: '12' };
    const p = f.runner.preflight(f.s.id);
    expect(p.warnings.find(w => w.code === 'execution_policy_mismatch')?.message).toContain('止损低于下限 1');
  });

  it('预检用同版本实盘候选核对执行层:被拒只提示不挡上线;没有样本提示无法核对', async () => {
    const f = fixture({ shadow: null });
    expect(f.runner.preflight(f.s.id).warnings.map(w => w.code)).toContain('execution_unverified');
    await f.create({ mode: 'signal_only' });
    const env = f.deps.environment() as RunEnvironment;
    // 这根候选止损 3.3%(103 → 99.59);把上限设成 3% 让它超出
    env.execution_thresholds = { min_stop_pct: 0.3, max_stop_pct: 3, min_stop_atr: 0.5, min_net_rr: 1.5, round_trip_cost_bps: '12' };
    const p = f.runner.preflight(f.s.id);
    expect(p.deployable).toBe(true);
    const w = p.warnings.find(x => x.code === 'execution_policy_mismatch')!;
    expect(w.message).toContain('实盘候选按当前执行层会被拒掉 100%');
    expect(w.message).toContain('止损过宽 1');
    expect(w.message).toContain('把止损收紧到 ≤3%');
    expect(w.message).not.toMatch(/调低|下调/);
  });
});
