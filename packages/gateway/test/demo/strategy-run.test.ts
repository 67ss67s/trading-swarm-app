import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { ResearchStore } from '../../src/demo/research/store.js';
import { StrategyStore } from '../../src/demo/research/strategies/store.js';
import { StrategyService } from '../../src/demo/research/strategies/service.js';
import { orderIntents } from '../../src/demo/research/orders/intents.js';
import { orderGateFor } from '../../src/demo/research/order-gate.js';
import { generateRunCandidate, runScreenRows } from '../../src/demo/strategy-run-orders.js';
import { toResearchBars, type GenerateInput } from '../../src/demo/strategy-candidate.js';
import { policyToIR } from '../../src/demo/research/strategy.js';
import { SYNTH_POLICY } from '../../src/demo/strategy-candidate.js';
import { SIZING_SYSTEM } from '../../src/demo/sizing-agent.js';
import { StrategyRunner, nextRunScan, parseRunFilter, runOrigin, type RunEnvironment, type StrategyRunDeps } from '../../src/demo/strategy-run.js';
import { newThread } from '../../src/demo/threads.js';
import type { Kline, StrategyThread } from '../../src/demo/types.js';
import { MarketPublisher, renderDeliverable, type PublishEvent } from '../../src/demo/asp-agent/publisher.js';
import { normalizePublisherSettings } from '../../src/demo/asp-agent/settings.js';
import { MarketCli } from '../../src/demo/asp-agent/cli.js';
import { strategyRunRoutes } from '../../src/demo/routes-strategy-runs.js';
import type { RouteContext, RouteHandler } from '../../src/demo/http-extra.js';

const H = 3_600_000, T0 = Date.UTC(2026, 8, 1);
function bars(): Kline[] {
  const out = Array.from({ length: 100 }, (_, i) => ({ open_time: T0 + i * H, close_time: T0 + (i + 1) * H - 1, open: '100', high: '100.8', low: '99.2', close: i % 2 ? '100.3' : '99.7', volume: '10' }));
  out.push({ open_time: T0 + 100 * H, close_time: T0 + 101 * H - 1, open: '100.2', high: '103.2', low: '100.1', close: '103', volume: '30' }); return out;
}
const cleanups: (() => Promise<void>)[] = [];
/** 模拟「每笔确认」下线前就建好的运行:现在新建和修改都不接受 confirm,但老运行照常跑,这些用例测的是老运行的行为。 */
function allowLegacyConfirm(runner: StrategyRunner): void {
  const r = runner as unknown as { validate: (raw: unknown, create: boolean) => Record<string, unknown> };
  const orig = r.validate.bind(runner);
  r.validate = (raw, create) => { const b = raw as Record<string, unknown>; return b?.['mode'] === 'confirm' ? { ...orig({ ...b, mode: 'auto' }, create), mode: 'confirm' } : orig(raw, create); };
}

afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture(ir = policyToIR(SYNTH_POLICY), timeframe = '1h') {
  const state = openStateDb(':memory:'), store = new DemoStore(state); let now = T0 + 101 * H + 5000;
  const service = new StrategyService(new StrategyStore(state.db, () => now), new ResearchStore(state.db), null);
  const s = service.create({ name: '运行测试', symbol: 'BTCUSDT', timeframe, strategy_ir: ir });
  const threads: StrategyThread[] = [], published: PublishEvent[] = [];
  const environment: RunEnvironment = { execution: { backend: 'paper', profile: null, label: '纸面' }, execution_key: 'paper', watchlist: ['BTCUSDT', 'ETHUSDT'], risk_pct: 0.3, leverage_cap: 3, asp: { id: '42', identity: true, active: true, publisher_enabled: false } };
  const deps: StrategyRunDeps = { db: state.db, strategies: service, environment: () => environment, blocked: () => null, now: () => now,
    bars: vi.fn(async () => bars()), threads: id => threads.filter(t => t.origin === runOrigin(id)),
    open: vi.fn(async (run, c, approval) => {
      const t = newThread({ id: `thread_${threads.length}`, backend: 'paper', symbol: c.symbol, market: run.market, strategy_id: `${run.strategy_id}@${run.version}`, side: c.direction, source: 'agent', timeframe: run.timeframe, thesis: 'IR', invalidation_text: null, watch_conditions: [], entry: { type: 'market', price: String(c.entry_ref), zone: null }, stop_price: String(c.stop), take_profits: c.target === null ? [] : [String(c.target)], qty: '1', margin_usdt: '100', leverage: run.leverage, margin_mode: 'isolated', now });
      t.origin = runOrigin(run.id); t.strategy_version = run.version;
      if (approval === 'auto') { t.status = 'in_position'; t.opened_at = now; t.filled_avg_price = String(c.entry_ref); }
      threads.push(t); return { outcome: 'opened', reason: approval, thread_id: t.id };
    }),
    cancel: vi.fn(async t => { t.status = 'canceled'; t.closed_at = now; return { ok: true, detail: '已撤单' }; }),
    close: vi.fn(async t => { t.status = 'closed'; t.closed_at = now; }), filter: vi.fn(async () => ({ decision: 'skip', reason: '风险偏高,不做' })),
    publish: vi.fn(async e => { published.push(e); return { event_id: e.event_id }; }), emit: vi.fn(),
    pendingApproval: t => t.status === 'pending_entry', realizedR: t => t.status === 'closed' ? 1.5 : null };
  const runner = new StrategyRunner(deps); allowLegacyConfirm(runner); cleanups.push(async () => { await runner.stop(); state.close(); });
  const create = (patch = {}) => runner.create({ strategy_id: s.id, mode: 'auto', market: 'spot', symbols: ['BTCUSDT'], risk_pct: 0.3, max_open: 3, publish_asp: false, ...patch });
  return { state, store, service, s, deps, runner, environment, threads, published, create, time: (n: number) => { now = n; } };
}

describe('Strategy Run 预检与生命周期', () => {
  it('未回测/无 ASP 仅 warning,无 IR 是 blocker,GET 不创建运行', () => {
    const f = fixture(); f.environment.asp.identity = false; f.environment.asp.id = null;
    const p = f.runner.preflight(f.s.id); expect(p.deployable).toBe(true); expect(p.requires_live_confirm).toBe(false);
    expect(p.warnings.map(w => w.code)).toEqual(expect.arrayContaining(['not_backtested', 'asp_identity_missing']));
    const empty = f.service.create({ name: '空策略' }); expect(f.runner.preflight(empty.id).blockers.map(b => b.code)).toContain('no_ir'); expect(f.runner.list()).toEqual([]);
  });
  it.each(['1m', '3m', '5m'])('%s blocker', tf => { const f = fixture(policyToIR(SYNTH_POLICY), tf); expect(f.runner.preflight(f.s.id).deployable).toBe(false); });
  it('做空/现货杠杆 blocker,追踪止损未接通也是 blocker', () => {
    const ir = policyToIR(SYNTH_POLICY); ir.order = { direction: 'short', market: 'perp', leverage: 2 };
    const f = fixture(ir); expect(f.runner.preflight(f.s.id, undefined, 'spot').blockers.map(b => b.code)).toEqual(expect.arrayContaining(['direction_not_long', 'spot_leverage']));
    const trail = policyToIR(SYNTH_POLICY); trail.exit.push({ primitive: 'chandelier_trail', params: { atr_period: 22, multiple: 3 } });
    const g = fixture(trail); expect(g.runner.preflight(g.s.id).blockers.map(w => w.code)).toContain('trailing_not_connected');
  });
  it('live 确认、同策略单个运行、归档同步停止', async () => {
    const f = fixture(); f.environment.execution = { backend: 'okx', profile: 'live', label: 'OKX 实盘' }; f.environment.execution_key = 'okx:live';
    await expect(f.create()).rejects.toMatchObject({ status: 409, code: 'live_requires_confirm' });
    const a = await f.create({ confirm: 'LIVE' }); expect(f.service.store.require(f.s.id).status).toBe('live');
    const b = await f.create({ confirm: 'LIVE', max_open: 4 }); expect(b.run.id).toBe(a.run.id); expect(b.run.max_open).toBe(4); expect(f.runner.list()).toHaveLength(1);
    f.service.archive(f.s.id); expect(f.runner.get(a.run.id).status).toBe('stopped');
  });
  it('草稿可直接运行,service 写 paper/published 与 listing', async () => {
    const f = fixture(); const a = await f.create({ publish_asp: true });
    expect(f.service.store.require(f.s.id)).toMatchObject({ status: 'published', published_listing_id: `asp:42:${a.run.id}` });
    expect(f.service.store.events(f.s.id).map(x => x.to)).toEqual(expect.arrayContaining(['paper', 'published']));
  });
  it('拒绝错误字段/边界参数', async () => {
    const f = fixture(); for (const b of [{ risk_pct: NaN }, { max_open: 0 }, { mode: 'fake' }, { symbols: [] }, { symbols: ['BTC-USDT'] }, { leverage: 12 }]) expect(() => f.create(b)).toThrow();
    const a = await f.create(); expect(() => f.runner.patch(a.run.id, { market: 'perp' })).toThrow();
  });
});

describe('扫描幂等与四种模式', () => {
  it('auto 生成线程,同收盘并发/双击只开一次,SSE 发事件', async () => {
    const f = fixture(); const a = await f.create(); await Promise.all([f.runner.scan(a.run.id), f.runner.scan(a.run.id)]);
    expect(f.deps.open).toHaveBeenCalledTimes(1); expect(f.threads).toHaveLength(1); expect(a.scan.map(e => e.kind)).toEqual(['scan', 'candidate', 'order_opened']);
    expect(f.runner.get(a.run.id).stats).toMatchObject({ orders: 1, candidates: 1, open_threads: 1 }); expect(f.deps.filter).not.toHaveBeenCalled();
    expect(f.deps.emit).toHaveBeenCalledWith('strategy_run.updated', expect.objectContaining({ id: a.run.id }));
    expect(f.deps.emit).toHaveBeenCalledWith('strategy_run.event', expect.objectContaining({ kind: 'candidate' }));
  });
  it('confirm 待批;agent skip 不下;follow 不改几何', async () => {
    const f = fixture(); const a = await f.create({ mode: 'confirm', publish_asp: true }); expect(f.published[0]?.traded).toBe(false); expect(f.threads[0]?.status).toBe('pending_entry'); expect(a.run.stats.pending_approval).toBe(1); expect(a.scan.map(e => e.kind)).toContain('order_pending');
    const g = fixture(); const b = await g.create({ mode: 'agent' }); expect(g.deps.open).not.toHaveBeenCalled(); expect(b.scan.map(e => e.kind)).toContain('agent_skip');
    const h = fixture(); h.deps.filter = vi.fn(async () => ({ decision: 'follow', reason: '同意' })); await h.create({ mode: 'agent' });
    expect(h.deps.open).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ entry_ref: 103, direction: 'long' }), 'auto');
    expect(() => parseRunFilter('{"decision":"follow","reason":"go","stop":1}')).toThrow();
  });
  it('agent 超时/解析失败 skip', async () => {
    const f = fixture(); f.deps.filter = vi.fn(async () => { throw new Error('timed out'); }); const a = await f.create({ mode: 'agent' });
    expect(f.deps.open).not.toHaveBeenCalled(); expect(a.scan.find(e => e.kind === 'agent_skip')?.message).toContain('timed out');
  });
  it('signal_only 只发布;无 ASP error 不停运行', async () => {
    const f = fixture(); const a = await f.create({ mode: 'signal_only', publish_asp: true }); expect(f.deps.open).not.toHaveBeenCalled();
    expect(f.published[0]).toMatchObject({ kind: 'strategy_signal', traded: false, valid_until: T0 + 102 * H, entry_type: 'next_open_market', strategy: { run_id: a.run.id, version: 1 } });
    const g = fixture(); g.environment.asp.identity = false; g.environment.asp.id = null; const b = await g.create({ publish_asp: true });
    expect(b.run.status).toBe('running'); expect(b.scan.some(e => e.kind === 'error' && e.message.includes('ASP'))).toBe(true); expect(g.deps.publish).not.toHaveBeenCalled();
  });
  it('max_open/已有同币跳过,仍发 traded=false', async () => {
    const f = fixture(); const a = await f.create({ max_open: 1, symbols: ['BTCUSDT', 'ETHUSDT'], publish_asp: true });
    expect(f.deps.open).toHaveBeenCalledTimes(1); expect(a.scan.find(e => e.kind === 'skip')?.message).toContain('max_open'); expect(f.published[1]?.traded).toBe(false);
    f.time(T0 + 102 * H + 5000); f.deps.bars = async () => bars().map(k => ({ ...k, open_time: k.open_time + H, close_time: k.close_time + H }));
    const b = await f.runner.scan(a.run.id); expect(b.scan.some(e => e.message.includes('already_open'))).toBe(true);
  });
  it('慢 IR >200ms error;行情缺最新根不占去重键', async () => {
    const f = fixture(); let tick = 0; f.deps.clock = () => (tick += 201); const a = await f.create(); expect(a.run.status).toBe('error'); expect(a.run.error).toContain('slow_ir'); expect(f.deps.open).not.toHaveBeenCalled();
    const g = fixture(); g.deps.bars = async () => bars().slice(0, -1); const b = await g.create(); expect(g.runner.store.seen(b.run.id, 'BTCUSDT', T0 + 101 * H)).toBe(false);
    g.deps.bars = async () => bars(); g.time(T0 + 101 * H + 20_000); await g.runner.tick(); expect(g.deps.open).toHaveBeenCalledTimes(1);
  });
  it('取行情期间 Executor 暂停不下单、不消费信号', async () => {
    const f = fixture(); let halted = false; f.deps.blocked = () => halted ? 'Executor 已暂停' : null; f.deps.bars = async () => { halted = true; return bars(); };
    const a = await f.create(); expect(f.deps.open).not.toHaveBeenCalled(); expect(f.runner.store.seen(a.run.id, 'BTCUSDT', T0 + 101 * H)).toBe(false);
  });
});

describe('恢复与机械退出', () => {
  it('重建恢复 running 不重复单,+5秒按策略周期调度', async () => {
    const f = fixture(); const a = await f.create({ mode: 'signal_only' }); await f.runner.stop(); const restored = new StrategyRunner(f.deps); cleanups.push(() => restored.stop());
    expect(restored.get(a.run.id).status).toBe('running'); await restored.scan(a.run.id); expect(restored.get(a.run.id).stats.candidates).toBe(1);
    expect(nextRunScan(T0 + 102 * H + 4999, '1h')).toBe(T0 + 102 * H + 5000); expect(nextRunScan(T0 + 102 * H + 5000, '1h')).toBe(T0 + 103 * H + 5000);
    f.time(T0 + 102 * H + 5000); f.deps.bars = async () => bars().map(k => ({ ...k, open_time: k.open_time + H, close_time: k.close_time + H })); await restored.tick(); expect(restored.get(a.run.id).stats.candidates).toBe(2);
  });
  it('升级版本后旧仓仍按旧 IR irExit 时间止损,暂停继续管仓', async () => {
    const f = fixture(policyToIR({ ...SYNTH_POLICY, holding_bars: 1 })); const a = await f.create(); f.service.addVersion(f.s.id, { strategy_ir: policyToIR({ ...SYNTH_POLICY, holding_bars: 48 }) });
    expect(f.runner.get(a.run.id)).toMatchObject({ version: 1, latest_version: 2 }); await f.runner.patch(a.run.id, { version: 2 }); await f.runner.patch(a.run.id, { status: 'paused' });
    f.time(T0 + 102 * H + 5000); f.deps.bars = async () => bars().map(k => ({ ...k, open_time: k.open_time + H, close_time: k.close_time + H }));
    const b = await f.runner.scan(a.run.id); expect(f.deps.close).toHaveBeenCalledTimes(1); expect(b.scan.find(e => e.kind === 'exit')?.data?.['reason']).toBe('time'); expect(f.runner.get(a.run.id).stats).toMatchObject({ closed: 1, realized_r: 1.5 });
  });
  it('暂停/停止的持仓慢 IR 也持久锁住,重启或暂停不能绕过', async () => {
    const f = fixture(); const a = await f.create(); await f.runner.patch(a.run.id, { status: 'paused' });
    f.time(T0 + 102 * H + 5000); f.deps.bars = async () => bars().map(k => ({ ...k, open_time: k.open_time + H, close_time: k.close_time + H }));
    let ticks = 0; f.deps.clock = () => (ticks += 201); await f.runner.scan(a.run.id);
    expect(f.runner.get(a.run.id).error).toContain('slow_ir:'); const before = ticks;
    await f.runner.tick(); expect(ticks).toBe(before);
    await f.runner.patch(a.run.id, { status: 'stopped' }); await f.runner.scan(a.run.id); expect(ticks).toBe(before);
    await f.runner.stop(); const restored = new StrategyRunner(f.deps); cleanups.push(() => restored.stop());
    await restored.scan(a.run.id); expect(ticks).toBe(before);
  });
  it('通道切换暂停,恢复实盘需要 LIVE', async () => {
    const f = fixture(); const a = await f.create({ mode: 'signal_only' }); f.environment.execution = { backend: 'okx', profile: 'live', label: 'OKX 实盘' }; f.environment.execution_key = 'okx:live'; await f.runner.scan(a.run.id);
    expect(f.runner.get(a.run.id).status).toBe('paused'); await expect(f.runner.patch(a.run.id, { status: 'running' })).rejects.toMatchObject({ code: 'live_requires_confirm' });
  });
  it('事件分页去重,全部六条路由使用小写参数', async () => {
    const f = fixture(); const a = await f.create(); const first = f.runner.store.events(a.run.id, 2), second = f.runner.store.events(a.run.id, 2, first.next_cursor);
    expect(first.next_cursor).not.toBeNull(); expect(new Set([...first.rows, ...second.rows].map(e => e.id)).size).toBe(4);
    const routes: { method: string; path: string; fn: RouteHandler }[] = [], response = vi.fn();
    strategyRunRoutes({ rt: { strategyRuns: () => f.runner }, route: (method: string, path: string, fn: RouteHandler) => routes.push({ method, path, fn }), json: response, readBody: async () => ({ status: 'paused' }) } as unknown as RouteContext);
    expect(routes).toHaveLength(6); expect(routes.every(r => !r.path.includes(':') || /:[a-z_]+(?:\/|$)/.test(r.path))).toBe(true);
    await routes.find(r => r.method === 'PATCH')!.fn({} as never, {} as never, new URL('http://localhost'), { id: a.run.id }); expect(response).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({ run: expect.objectContaining({ status: 'paused' }) }));
  });
});

describe('ASP strategy_signal', () => {
  function event(over: Partial<PublishEvent> = {}): PublishEvent { return { event_id: 'signal1', kind: 'strategy_signal', signal_time: T0, symbol: 'BTCUSDT', direction: 'long', price: '100', stop_loss: '95', take_profit: ['110'], reason: '规则命中', thread_id: null, realized_r: null, backend: 'paper', paper: true, strategy: { id: 'rs_test', name: '测试', version: 1, timeframe: '1h', run_id: 'run_test' }, market: 'spot', leverage: 1, traded: false, entry_type: 'next_open_market', valid_until: T0 + H, ...over }; }
  it('paper analysis;signal_only/demo/live order;线程事件带策略归属', () => {
    const settings = normalizePublisherSettings({}); expect(renderDeliverable(event(), settings).payload).toMatchObject({ signal_type: 'analysis', action: 'LONG', market: 'spot', leverage: 1, traded: false, valid_until: T0 + H });
    for (const over of [{ signal_only: true }, { backend: 'okx', paper: false }, { backend: 'binance', paper: false }]) expect(renderDeliverable(event(over), settings).payload.signal_type).toBe('order');
    expect(renderDeliverable(event({ kind: 'thread_closed', traded: true }), settings).payload).toMatchObject({ action: 'CLOSE', strategy: { run_id: 'run_test' }, traded: true });
  });
  it('显式运行发布绕过总开关,仍需 ASP 身份,外部来源不转发', async () => {
    const f = fixture(), cli = new MarketCli(); const calls = vi.spyOn(cli, 'call').mockResolvedValue({ data: [] }); const aspId = vi.fn(async () => '42');
    const p = new MarketPublisher({ store: f.store, cli, aspId, settings: () => normalizePublisherSettings({ enabled: false }), emit: () => {} }); expect(await p.publish(event())).toBeNull();
    expect(await p.publish(event(), { strategy_run: true })).toMatchObject({ refusal: null }); expect(aspId).toHaveBeenCalledOnce(); expect(calls).toHaveBeenCalledWith('subscribe-active', ['--agent-id', '42']);
    expect(await p.publish(event({ event_id: 'external', transport: 'okx_asp' }), { strategy_run: true })).toBeNull(); await p.stop();
  });
});

// 不启动 runtime 定时器、不建端口;市场函数全部用进程内桩,执行仅 PaperBackend。
describe('runtime 机械开仓接线', () => {
  async function runtimeFixture(mode: 'auto' | 'confirm' | 'agent' = 'auto', tradeMarket: 'spot' | 'perp' = 'spot', customize?: (ir: ReturnType<typeof policyToIR>) => void, setupBackend?: (backend: import('../../src/demo/execution.js').PaperBackend) => void) {
    const market = await import('../../src/demo/market.js');
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 101 * H + 5000);
    vi.spyOn(market, 'fetchKlines').mockImplementation(async (_symbol, tf) => {
      const ms = market.tfToMs(tf), end = Math.floor(Date.now() / ms) * ms;
      return bars().map((k, i, a) => ({ ...k, open_time: end - (a.length - i) * ms, close_time: end - (a.length - i - 1) * ms - 1 }));
    });
    vi.spyOn(market, 'fetchMarketView').mockImplementation(async (symbol, tf, m) => ({ symbol, market: m ?? 'perp', mark: '103', last: '103', as_of: Date.now(), klines_tf: tf, funding_rate: '0', next_funding_at: 0, open_interest: '0' }));
    vi.spyOn(market, 'fetchTicker24h').mockResolvedValue({ symbol: 'BTCUSDT', quoteVolume: '1000000000' } as never);
    const { DemoRuntime } = await import('../../src/demo/runtime.js'); const { PaperBackend } = await import('../../src/demo/execution.js'); const { stubBrain } = await import('../../src/demo/brain.js');
    const ir = policyToIR(SYNTH_POLICY); if (tradeMarket === 'perp') ir.order = { direction: 'long', market: 'perp', leverage: 5 };
    customize?.(ir);
    const f = fixture(ir), backend = new PaperBackend(10000), calls = vi.fn(() => '{"decision":"follow","reason":"代码几何符合规则"}');
    setupBackend?.(backend);
    const rt = new DemoRuntime({ store: f.store, backend, brains: { stub: stubBrain(calls) } });
    rt.workflow = { ...rt.workflow, brain: 'stub', cheap_brain: 'stub', timeframe: '1h', watchlist: ['BTCUSDT'], markets: ['spot', 'perp'], auto_approve: false, risk_pct: '0.1', sizing_agent: 'apply', strategy_council: 'off', entry_style: 'free' };
    rt.markets.set('BTCUSDT', await market.fetchMarketView('BTCUSDT', '1h', 'perp'));
    rt.markets.set('spot:BTCUSDT', await market.fetchMarketView('BTCUSDT', '1h', 'spot'));
    const runner = rt.strategyRuns(); allowLegacyConfirm(runner);
    cleanups.push(async () => { await rt.stop(); });
    const result = await runner.create({ strategy_id: f.s.id, mode, market: tradeMarket, symbols: ['BTCUSDT'], risk_pct: 0.3, max_open: 3, publish_asp: false });
    // 组合经理倍率现在也作用于固定风险的策略运行:sizing_agent=apply 时开仓前会问一次仓位意见。
    // 这里「没有模型调用」指的是没有判断类调用,仓位意见单独数。
    const modelCalls = () => calls.mock.calls.filter((args) => (args as unknown[])[0] !== SIZING_SYSTEM);
    return { ...f, rt, backend, runner, result, calls, modelCalls };
  }
  it('IR 限价保持挂单价,过期在暂停时撤单并记 skip', async () => {
    const f = await runtimeFixture('auto', 'spot', ir => { ir.order = { direction: 'long', market: 'spot', entry: { type: 'limit', price: { primitive: 'pct_offset_level', params: { pct: 0.02 } }, expiry_bars: 2 } }; });
    const t = f.store.threads()[0]!;
    expect(t).toMatchObject({ status: 'pending_entry', entry: { type: 'limit', price: '100.9' }, entry_expires_at: T0 + 103 * H });
    expect(f.backend.snapshot().orders.find(o => !o.reduce_only)?.price).toBe('100.9');
    await f.runner.patch(f.result.run.id, { status: 'paused' });
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 103 * H); await f.runner.tick();
    expect(f.store.thread(t.id)?.status).toBe('canceled');
    expect(f.backend.snapshot().orders.some(o => !o.reduce_only)).toBe(false);
    expect(f.runner.store.events(f.result.run.id).rows.some(e => e.kind === 'skip' && e.data?.['code'] === 'entry_expired')).toBe(true);
    expect(f.modelCalls()).toHaveLength(0);
  });
  it('限价待审批过期后不能发送', async () => {
    const f = await runtimeFixture('confirm', 'spot', ir => { ir.order = { direction: 'long', market: 'spot', entry: { type: 'limit', price: { primitive: 'pct_offset_level', params: { pct: 0.02 } }, expiry_bars: 1 } }; });
    const t = f.store.threads()[0]!, intent = f.store.intentsForThread(t.id).find(i => i.kind === 'open')!;
    vi.spyOn(Date, 'now').mockReturnValue(T0 + 102 * H); const send = vi.spyOn(f.backend, 'placeEntry');
    await f.rt.approveIntent(intent.id, f.rt.issueIntentConfirmation(intent.id).token.nonce);
    expect(send).not.toHaveBeenCalled(); expect(f.store.thread(t.id)?.status).toBe('canceled');
  });
  it('永续空头走组合经理,几何正确,spot 预检拒绝', async () => {
    const f = await runtimeFixture('auto', 'perp', ir => { ir.order = { direction: 'short', market: 'perp', leverage: 2 }; });
    const t = f.store.threads()[0]!;
    expect(f.result.run.direction).toBe('short'); expect(t).toMatchObject({ status: 'in_position', side: 'short', leverage: 2 });
    expect(Number(t.stop_price)).toBeGreaterThan(103); expect(Number(t.take_profits[0])).toBeLessThan(103);
    expect(f.runner.preflight(f.s.id, undefined, 'spot').blockers.find(x => x.code === 'direction_not_long')?.message).toContain('请把市场选永续');
    expect(f.modelCalls()).toHaveLength(0);
  });
  it.each(['spot', 'perp'] as const)('%s 首档按 30%% 减仓,余仓止损仍在且不重复 TP', async market => {
    const f = await runtimeFixture('auto', market, ir => { ir.order = { direction: 'long', market, take_profits: [{ source: { primitive: 'fixed_r_target', params: { r: 1 } }, size_pct: 0.3 }, { source: { primitive: 'fixed_r_target', params: { r: 3 } }, size_pct: 0.7 }] }; });
    const t = f.store.threads()[0]!, partial = t.run_take_profit!;
    expect(t.tp_partial_unsupported?.dropped[0]?.percent).toBe(70);
    expect(Number(partial.qty)).toBeCloseTo(Number(t.qty) * 0.3, 2);
    expect(f.backend.snapshot().orders.find(o => o.type === 'TAKE_PROFIT_MARKET')!.qty).toBe(partial.qty);
    const events = f.backend.tick(t.symbol, partial.price, market);
    (f.rt as unknown as { pendingPaperEvents: typeof events }).pendingPaperEvents.push(...events);
    await f.rt.pollAccount();
    const remainder = f.backend.snapshot().positions[0]!.qty;
    expect(remainder).toBeCloseTo(Number(t.qty) - Number(partial.qty), 8);
    expect(Number(f.store.thread(t.id)!.qty)).toBeCloseTo(remainder, 8);
    expect(f.backend.snapshot().orders.filter(o => o.type === 'STOP_MARKET')).toHaveLength(1);
    if (market === 'spot') expect(Number(f.backend.snapshot().orders.find(o => o.type === 'STOP_MARKET')!.qty)).toBeCloseTo(remainder, 8);
    expect(f.backend.snapshot().orders.filter(o => o.type === 'TAKE_PROFIT_MARKET')).toHaveLength(0);
    await f.rt.pollAccount(); expect(f.backend.snapshot().orders.filter(o => o.type === 'TAKE_PROFIT_MARKET')).toHaveLength(0);
    expect(f.backend.tick(t.symbol, t.stop_price!, market).map(e => e.kind)).toContain('sl_hit'); expect(f.backend.snapshot().positions).toHaveLength(0);
  });
  it('TP 回执未知与重启不另造 CID,保持止损并报告 error', async () => {
    let submit = vi.fn();
    // 两档原来是 1R/2R 各一半,加权 1.5R,扣手续费后净盈亏比不到 1.5,现在会被执行层拒单;这条用例测的是回执未知,所以改成 1.5R/3R
    const f = await runtimeFixture('auto', 'perp', ir => { ir.order = { direction: 'short', market: 'perp', take_profits: [{ source: { primitive: 'fixed_r_target', params: { r: 1.5 } }, size_pct: 0.5 }, { source: { primitive: 'fixed_r_target', params: { r: 3 } }, size_pct: 0.5 }] }; }, backend => { submit = vi.spyOn(backend, 'placePartialTakeProfit').mockResolvedValue({ outcome: 'unknown', error: 'timeout', receipt: null, avg_price: null }); });
    const t = f.store.threads()[0]!; expect(t.run_take_profit?.state).toBe('unknown'); expect(submit).toHaveBeenCalledOnce();
    const cid = t.run_take_profit!.client_order_id; expect(cid).toBeTruthy();
    const reload = f.store.thread(t.id)!;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    await (f.rt as unknown as { placeProtection: (t: StrategyThread, why: string) => Promise<void> }).placeProtection(reload, '恢复对账');
    expect(submit).toHaveBeenCalledOnce(); expect(f.store.thread(t.id)!.run_take_profit?.client_order_id).toBe(cid);
    expect(f.runner.store.events(f.result.run.id).rows.some(e => e.kind === 'error' && e.message.includes('回执未知'))).toBe(true);
  });
  it('同次巡检之前先部分 TP 再 SL,累计完整盈亏且按末次止损记终结', async () => {
    const f = await runtimeFixture('auto', 'perp', ir => { ir.order = { direction: 'long', market: 'perp', take_profits: [{ source: { primitive: 'fixed_r_target', params: { r: 1 } }, size_pct: 0.3 }, { source: { primitive: 'fixed_r_target', params: { r: 3 } }, size_pct: 0.7 }] }; });
    const t = f.store.threads()[0]!;
    const events = [...f.backend.tick(t.symbol, t.run_take_profit!.price, 'perp'), ...f.backend.tick(t.symbol, t.stop_price!, 'perp')];
    expect(events.map(e => e.kind)).toEqual(['tp_hit', 'sl_hit']);
    (f.rt as unknown as { pendingPaperEvents: typeof events }).pendingPaperEvents.push(...events);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000); await f.rt.pollAccount();
    const closed = f.store.thread(t.id)!;
    expect(closed.status).toBe('closed'); expect(closed.close_reason).toContain('止损触发'); expect(closed.exit_price).toBe(t.stop_price);
    expect(Number(closed.realized_pnl)).toBeCloseTo(events.reduce((sum, e) => sum + Number(e.realized_pnl), 0), 6);
  });
  it('现货部分 TP 后撤旧保护未知时保留恢复标记,下轮按余仓重挂且不再挂 TP', async () => {
    const f = await runtimeFixture('auto', 'spot', ir => { ir.order = { direction: 'long', market: 'spot', take_profits: [{ source: { primitive: 'fixed_r_target', params: { r: 1 } }, size_pct: 0.3 }, { source: { primitive: 'fixed_r_target', params: { r: 3 } }, size_pct: 0.7 }] }; });
    const t = f.store.threads()[0]!, cancel = vi.spyOn(f.backend, 'cancelOrder').mockResolvedValueOnce({ ok: false, error: 'timeout' });
    f.backend.tick(t.symbol, t.run_take_profit!.price, 'spot'); await f.rt.pollAccount();
    expect(f.store.thread(t.id)?.run_take_profit?.resize_stop).toBe(true); expect(f.store.thread(t.id)?.protection_missing).toBe(true);
    await f.rt.pollAccount(); expect(cancel).toHaveBeenCalledTimes(2);
    const current = f.store.thread(t.id)!; expect(current.run_take_profit?.resize_stop).toBe(false);
    expect(f.backend.snapshot().orders.filter(o => o.type === 'STOP_MARKET').map(o => Number(o.qty))).toEqual([Number(current.qty)]);
    expect(f.backend.snapshot().orders.some(o => o.type === 'TAKE_PROFIT_MARKET')).toBe(false);
  });
  it('现货撤旧 SL 成功、新 SL 调用异常后,下轮使用持久 CID 恢复余仓保护', async () => {
    const f = await runtimeFixture('auto', 'spot', ir => { ir.order = { direction: 'long', market: 'spot', take_profits: [{ source: { primitive: 'fixed_r_target', params: { r: 1 } }, size_pct: 0.3 }, { source: { primitive: 'fixed_r_target', params: { r: 3 } }, size_pct: 0.7 }] }; });
    const t = f.store.threads()[0]!, stop = vi.spyOn(f.backend, 'placeStop').mockRejectedValueOnce(new Error('中断新止损发送'));
    f.backend.tick(t.symbol, t.run_take_profit!.price, 'spot'); await f.rt.pollAccount().catch(() => {});
    const persisted = f.store.thread(t.id)!;
    expect(persisted.protection_missing).toBe(true); expect(persisted.run_take_profit?.stop_pending).toBe(true);
    expect(f.backend.snapshot().orders.filter(o => o.type === 'STOP_MARKET')).toHaveLength(0);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000); await f.rt.pollAccount();
    expect(stop.mock.calls.map(call => call[3])).toEqual([persisted.run_take_profit!.stop_client_order_id, persisted.run_take_profit!.stop_client_order_id]);
    expect(f.backend.snapshot().orders.filter(o => o.type === 'STOP_MARKET').map(o => Number(o.qty))).toEqual([Number(persisted.qty)]);
  });
  it('auto 忽略 workflow.auto_approve=false,真实组合路径入场且无任何模型调用', async () => {
    const f = await runtimeFixture(); const t = f.store.threads()[0];
    expect(f.result.scan.map(e => [e.kind, e.message])).toEqual(expect.arrayContaining([['order_opened', '组合经理过闸,已交执行']]));
    expect(t).toMatchObject({ origin: `strategy_run:${f.result.run.id}`, strategy_id: `${f.s.id}@1`, strategy_version: 1, timeframe: '1h', market: 'spot', status: 'in_position', leverage: 1 });
    const intent = f.store.intentsForThread(t!.id).find(i => i.kind === 'open')!;
    expect(Number(intent.sizing.risk_pct)).toBe(0.3); expect(Number(intent.quantity) * Number(intent.sizing.stop_distance)).toBeLessThanOrEqual(30.1);
    expect(f.modelCalls()).toHaveLength(0); expect(f.rt.reviewThread(t!.id, { kind: 'manual', detail: '不得调用模型复查' })).toBe(false);
    expect(t!.entry_client_order_id).toBeTruthy(); expect(t!.filled_avg_price).toBe('103');
  });
  it('confirm 待批意图、agent 一次短调用和额度记账', async () => {
    const f = await runtimeFixture('confirm'); expect(f.store.threads()[0]?.status).toBe('pending_entry'); expect(f.store.intents(10)[0]?.status).toBe('pending_approval'); expect(f.modelCalls()).toHaveLength(0);
    const g = await runtimeFixture('agent'); expect(g.modelCalls()).toHaveLength(1); expect(g.rt.modelJudgmentsToday()).toBe(1); expect(g.store.threads()[0]?.status).toBe('in_position');
  });
  it('perp 杠杆取 IR 与工作流较小值;发送前暂停在最终闸拒绝', async () => {
    const f = await runtimeFixture('confirm', 'perp');
    const t = f.store.threads()[0]!; expect(t.leverage).toBe(3);
    const intent = f.store.intentsForThread(t.id).find(i => i.kind === 'open')!;
    const send = vi.spyOn(f.backend, 'placeEntry');
    vi.spyOn(f.backend, 'setMarginType').mockImplementation(async () => {
      await f.runner.patch(f.result.run.id, { status: 'paused' }); return { ok: true, error: null };
    });
    await f.rt.approveIntent(intent.id, f.rt.issueIntentConfirmation(intent.id).token.nonce);
    expect(send).not.toHaveBeenCalled(); expect(f.store.thread(t.id)?.status).toBe('canceled');
    expect(f.store.intentsForThread(t.id).find(i => i.kind === 'open')?.error).toContain('策略运行已暂停');
  });
  it('运行发布在线程入场时即带策略块,平仓更新运行结算行', async () => {
    const f = await runtimeFixture('confirm');
    f.store.kvSet('market.asp_identity', JSON.stringify({ at: Date.now(), value: { asp: { agentId: '42', active: true } } }));
    await f.runner.patch(f.result.run.id, { publish_asp: true });
    const publisher = vi.spyOn(f.rt.marketAgent().publisher, 'publish').mockResolvedValue({ event_id: 'fake' });
    const t = f.store.threads()[0]!, intent = f.store.intentsForThread(t.id).find(i => i.kind === 'open')!;
    await f.rt.approveIntent(intent.id, f.rt.issueIntentConfirmation(intent.id).token.nonce);
    expect(publisher).toHaveBeenCalledWith(expect.objectContaining({ kind: 'entry_filled', strategy: { id: f.s.id, name: '运行测试', version: 1, timeframe: '1h', run_id: f.result.run.id }, traded: true }), { strategy_run: true });
    await f.rt.closeThread(t.id, '测试机械平仓');
    const events = f.runner.store.events(f.result.run.id).rows.filter(e => e.data?.['closed']); expect(events).toHaveLength(1); expect(events[0]?.data?.['reason']).toBe('测试机械平仓');
    expect(f.runner.get(f.result.run.id).stats.closed).toBe(1);
  });

  it('批准时按旧版本 IR min_rr 复查,涨过经济边界只拒不改', async () => {
    const f = await runtimeFixture('confirm', 'spot', ir => { ir.order = { direction: 'long', market: 'spot', min_rr: 1.8 }; });
    const t = f.store.threads()[0]!, intent = f.store.intentsForThread(t.id).find(i => i.kind === 'open')!;
    const market = await import('../../src/demo/market.js');
    vi.mocked(market.fetchMarketView).mockImplementation(async (symbol, tf, m) => ({ symbol, market: m ?? 'perp', mark: '104', last: '104', as_of: Date.now(), klines_tf: tf, funding_rate: '0', next_funding_at: 0, open_interest: '0' }));
    const send = vi.spyOn(f.backend, 'placeEntry'); await f.rt.approveIntent(intent.id, f.rt.issueIntentConfirmation(intent.id).token.nonce);
    expect(send).not.toHaveBeenCalled(); expect(f.store.thread(t.id)?.stop_price).toBe(t.stop_price);
    // 冻结数量的风险闸可能先于 RR 闸拒绝;两者都只能拒,不能重算量价。
    expect(f.store.intentsForThread(t.id).find(i => i.kind === 'open')?.status).toBe('rejected');
  });
  it('只有信号退出、无价位止盈的 IR 也可开仓;irExit 走现有平仓', async () => {
    const f = await runtimeFixture('auto', 'spot', ir => { ir.exit = [{ primitive: 'trend_break', params: { ema_period: 20, htf: '4h' } }]; });
    const t = f.store.threads()[0]!; expect(t.status).toBe('in_position'); expect(t.take_profits).toEqual([]);
    const market = await import('../../src/demo/market.js'); vi.spyOn(Date, 'now').mockReturnValue(T0 + 102 * H + 5000);
    vi.mocked(market.fetchKlines).mockImplementation(async (_s, tf) => {
      const ms = market.tfToMs(tf), end = Math.floor(Date.now() / ms) * ms;
      return bars().map((k, i, a) => ({ ...k, ...(i === a.length - 1 ? { close: '90', low: '89' } : {}), open_time: end - (a.length - i) * ms, close_time: end - (a.length - i - 1) * ms - 1 }));
    });
    await f.runner.patch(f.result.run.id, { status: 'paused' }); const result = await f.runner.scan(f.result.run.id);
    expect(result.scan.some(e => e.kind === 'exit' && e.data?.['reason'] === 'trend_break')).toBe(true); expect(f.store.thread(t.id)?.status).toBe('closed'); expect(f.modelCalls()).toHaveLength(0);
  });

});

function runInput(ir = policyToIR(SYNTH_POLICY), ks = bars()): GenerateInput {
  return { shadow: { strategy_id: 'rs_test', version: 1, ir_hash: 'hash', timeframe: '1h', ir, source: 'research_strategy_version', label: '测试', unmapped: [], horizon_bars: 48, pick_note: 'test' }, symbol: 'BTCUSDT', klines: { '1h': ks }, now: ks.at(-1)!.open_time + H };
}
describe('研究订单与筛选池同口径', () => {
  it.each(['long', 'short'] as const)('%s 限价/目标价格比例与 orders 核一致', side => {
    const ir = policyToIR(SYNTH_POLICY); ir.order = { direction: side, market: 'perp', entry: { type: 'limit', price: { primitive: 'pct_offset_level', params: { pct: 0.01 } }, expiry_bars: 3 }, take_profits: [{ source: { primitive: 'fixed_r_target', params: { r: 1.5 } }, size_pct: 0.3 }, { source: { primitive: 'fixed_r_target', params: { r: 3 } }, size_pct: 0.7 }] };
    const inp = runInput(ir), research = toResearchBars(bars(), H, inp.now), expected = orderIntents(ir, research, H, { from_index: research.length - 1, fee_rate: '0', slippage_bps: '0', gate: orderGateFor(ir) }).intents[0]!;
    const actual = generateRunCandidate(inp).candidate!;
    expect(actual).toMatchObject({ direction: side, entry_type: 'limit', entry_ref: expected.entry.price, stop: expected.stop!.price, entry_expires_at: inp.now + 3 * H });
    expect(actual.take_profits).toEqual(expected.take_profits.map(t => ({ price: t.price, size_pct: t.size_pct })));
    const f = fixture(ir); expect(f.runner.preflight(f.s.id).deployable).toBe(true); expect(f.runner.preflight(f.s.id).warnings.map(w => w.code)).toContain('targets_partial');
  });
  it('both 冲突不下单,独立 short_signal 生成空头,持续信号不重发', () => {
    const ir = policyToIR(SYNTH_POLICY); ir.order = { direction: 'both', market: 'perp', short_signal: structuredClone(ir.signal) };
    expect(generateRunCandidate(runInput(ir)).reason).toContain('direction_conflict');
    ir.signal = [{ primitive: 'volume_surge', params: { lookback: 20, multiple: 1000 } }];
    expect(generateRunCandidate(runInput(ir)).candidate?.direction).toBe('short');
    const ks = bars(); ks.push({ ...ks.at(-1)!, open_time: T0 + 101 * H, close_time: T0 + 102 * H - 1, high: '106.2', close: '106' });
    expect(generateRunCandidate(runInput(ir, ks)).candidate).toBeNull();
  });
  it('空头信号退出使用 orderManager 镜像口径', async () => {
    const ir = policyToIR(SYNTH_POLICY); ir.order = { direction: 'short', market: 'perp' }; ir.exit = [{ primitive: 'trend_break', params: { ema_period: 20, htf: '4h' } }];
    const f = fixture(ir); const a = await f.create({ market: 'perp' }); expect(f.threads[0]!.side).toBe('short');
    f.time(T0 + 102 * H + 5000); f.deps.bars = async () => bars().map(k => ({ ...k, open_time: k.open_time + H, close_time: k.close_time + H }));
    const b = await f.runner.scan(a.run.id); expect(b.scan.find(e => e.kind === 'exit')?.data?.['reason']).toBe('trend_break');
  });
  it('每根先筛后候选,历史不足 skip,未收盘数据不参与', async () => {
    const ir = policyToIR(SYNTH_POLICY); ir.universe = { screen: { top_n: 1 } }; const f = fixture(ir);
    const ks = Array.from({ length: 1800 }, (_, i) => ({ ...bars()[i % 100]!, open_time: T0 + (i - 1700) * H, close_time: T0 + (i - 1699) * H - 1 })); ks.push(bars().at(-1)!);
    f.deps.bars = async () => ks;
    const rows = runScreenRows(new Map([['BTCUSDT', ks], ['ETHUSDT', ks]]), H, T0 + 101 * H, 'spot');
    expect(rows.filter(r => r.rank?.composite === 1)).toHaveLength(1); expect(f.runner.preflight(f.s.id).deployable).toBe(true);
    const a = await f.create({ symbols: ['BTCUSDT', 'ETHUSDT'] }); expect(f.deps.open).toHaveBeenCalledTimes(1); expect(a.scan.some(e => e.data?.['code'] === 'screen_filter')).toBe(true);
    const g = fixture(ir); const b = await g.create(); expect(g.deps.open).not.toHaveBeenCalled(); expect(b.scan.some(e => e.message.includes('历史不足'))).toBe(true);
    const future = { ...ks.at(-1)!, open_time: T0 + 101 * H, close_time: T0 + 102 * H - 1, close: '1000000' };
    expect(runScreenRows(new Map([['BTCUSDT', [...ks, future]], ['ETHUSDT', ks]]), H, T0 + 101 * H, 'spot')).toEqual(rows);
  });
  it('筛选池缺最新根整池重试,不消费去重键', async () => {
    const ir = policyToIR(SYNTH_POLICY); ir.universe = { screen: { top_n: 1 } }; const f = fixture(ir);
    f.deps.bars = async symbol => symbol === 'ETHUSDT' ? bars().slice(0, -1) : bars();
    const a = await f.create({ symbols: ['BTCUSDT', 'ETHUSDT'] }); expect(a.run.status).toBe('running');
    expect(f.runner.store.seen(a.run.id, 'BTCUSDT', T0 + 101 * H)).toBe(false); expect(f.deps.open).not.toHaveBeenCalled();
  });
  it('撤单未知不伪报 skip,确认后记过期,恢复不重复', async () => {
    const f = fixture(); const a = await f.create({ mode: 'confirm' }); const t = f.threads[0]!; t.entry_expires_at = T0 + 101 * H;
    f.deps.cancel = vi.fn(async () => ({ ok: false, detail: '撤单回执未知' })); await f.runner.scan(a.run.id);
    expect(f.runner.store.events(a.run.id).rows.some(e => e.data?.['code'] === 'entry_expired')).toBe(false);
    f.deps.cancel = vi.fn(async () => { t.status = 'canceled'; return { ok: true, detail: '确认已撤' }; }); await f.runner.tick();
    expect(f.runner.store.events(a.run.id).rows.filter(e => e.data?.['code'] === 'entry_expired')).toHaveLength(1);
    await f.runner.stop(); const restored = new StrategyRunner(f.deps); cleanups.push(() => restored.stop()); await restored.tick();
    expect(f.runner.store.events(a.run.id).rows.filter(e => e.data?.['code'] === 'entry_expired')).toHaveLength(1);
  });
});

describe('全局暂停与极短筛选历史', () => {
  it.each(['工作流已暂停', 'Executor 已暂停', '紧急停止中'])('%s 仍撤掉已过期限价', async blocked => {
    const f = fixture(); const a = await f.create({ mode: 'confirm' }); f.threads[0]!.entry_expires_at = T0 + 101 * H;
    f.deps.blocked = () => blocked; await f.runner.tick(); expect(f.deps.cancel).toHaveBeenCalledOnce();
    expect(f.threads[0]!.status).toBe('canceled'); expect(f.deps.open).toHaveBeenCalledOnce();
    expect(f.runner.store.events(a.run.id).rows.some(e => e.data?.['code'] === 'entry_expired')).toBe(true);
  });
  it('币池共同历史只有一根也保持 running,明确跳过', async () => {
    const ir = policyToIR(SYNTH_POLICY); ir.universe = { screen: { top_n: 1 } }; const f = fixture(ir);
    f.deps.bars = async symbol => symbol === 'BTCUSDT' ? bars().filter((_, i) => i % 2 === 0) : bars().filter((_, i) => i % 2 === 1 || i === 100);
    const a = await f.create({ symbols: ['BTCUSDT', 'ETHUSDT'] }); expect(a.run.status).toBe('running'); expect(f.deps.open).not.toHaveBeenCalled();
    expect(a.scan.filter(e => e.data?.['code'] === 'screen_filter')).toHaveLength(2);
  });
});

describe('临时失败不打断运行', () => {
  it('拉行情遇到 ECONNRESET / 429:运行保持 running,30 秒后重试', async () => {
    const f = fixture(); const a = await f.create();
    f.time(T0 + 102 * H + 5000);
    f.deps.bars = vi.fn(async () => { throw new Error('/api/v5/market/candles?instId=BTC-USDT-SWAP -> HTTP 429'); });
    await f.runner.scan(a.run.id);
    const r = f.runner.get(a.run.id);
    expect(r.status).toBe('running');
    expect(r.error).toBeNull();
    expect(r.next_scan_at).toBeGreaterThan(T0 + 102 * H + 5000);
  });
  it('标记价取不到(没发单):放回这根 K 线,恢复后同一根能下单', async () => {
    const f = fixture();
    const realOpen = f.deps.open;
    f.deps.open = vi.fn(async () => ({ outcome: 'rejected' as const, reason: '标记价不可用' }));
    const a = await f.create();
    expect(f.threads.filter(t => t.origin === runOrigin(a.run.id))).toHaveLength(0);
    expect(f.runner.get(a.run.id).status).toBe('running');
    f.deps.open = realOpen;
    await f.runner.scan(a.run.id);
    expect(f.threads.filter(t => t.origin === runOrigin(a.run.id))).toHaveLength(1);
  });
  it('真正的闸拒(非临时)仍消费这根 K 线', async () => {
    const f = fixture();
    f.deps.open = vi.fn(async () => ({ outcome: 'rejected' as const, reason: '基础闸拒绝:max_opens_per_day' }));
    const a = await f.create();
    await f.runner.scan(a.run.id);
    expect(f.deps.open).toHaveBeenCalledTimes(1);
  });
});
