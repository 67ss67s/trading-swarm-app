/**
 * 实盘 Jev 判断(docs/design/jev-live-2026-09-25.md):影子判断不挡单、失败隔离、预算上限、开关;
 * judge 块挡单语义不变且进账本。全部用离线判断桩,不碰真实 Jev / 网络。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStateDb } from '../../../../src/state-db.js';
import { ResearchStore } from '../../../../src/demo/research/store.js';
import { StrategyStore } from '../../../../src/demo/research/strategies/store.js';
import { StrategyService } from '../../../../src/demo/research/strategies/service.js';
import { policyToIR } from '../../../../src/demo/research/strategy.js';
import { SYNTH_POLICY } from '../../../../src/demo/strategy-candidate.js';
import { StrategyRunner, runOrigin, type RunEnvironment, type StrategyRunDeps } from '../../../../src/demo/strategy-run.js';
import { newThread } from '../../../../src/demo/threads.js';
import type { Kline, StrategyThread } from '../../../../src/demo/types.js';
import { AtomicCallBudget, JudgeDecisionStore, type JudgeRuntime } from '../../../../src/demo/research/judge/index.js';
import { stubJudgeSpec, stubProfile, stubProvider } from '../../../../src/demo/research/judge/stubs.js';
import { JEV_SHADOW_MAX_USD, JEV_SHADOW_MAX_CALLS, jevShadowFactory, type JevShadowFactory } from '../../../../src/demo/judge-live.js';
import { JUDGE_MAX_CALL_USD } from '../../../../src/demo/model-connections.js';
import { usdString, usdUnits } from '../../../../src/demo/research/judge/store.js';
import type { DecisionClient } from '../../../../src/demo/decisions.js';
import type { MicrostructureSnapshot } from '../../../../src/demo/research/judge/microstructure.js';

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

describe('Jev 影子判断', () => {
  it('无 judge 块:下单照常,影子判断事后落账本并推 judge.live,事件流不变', async () => {
    const f = fixture();
    const a = await f.create();
    expect(a.scan.map(e => e.kind)).toEqual(['scan', 'candidate', 'order_opened']);
    expect(f.deps.open).toHaveBeenCalledTimes(1);
    expect(a.run.jev_shadow).toBe(true);
    await f.runner.settleShadows();
    const rows = f.runner.judgeLedger.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ run_id: a.run.id, symbol: 'BTCUSDT', mode: 'shadow', as_of: T0 + 101 * H, candidate: { direction: 'long', entry: '103' } });
    expect(['ok', 'uncertain']).toContain(rows[0]!.status);
    expect(['follow', 'skip']).toContain(rows[0]!.action);
    expect(rows[0]!.questions.map(q => q.key)).toEqual(['take', 'quality']);
    expect(rows[0]!.answers.map(x => x.question_key)).toEqual(['take', 'quality']);
    expect(rows[0]!.state?.micro).toMatchObject({ used: false, book: false, liquidations: false });
    expect(f.provider!.calls).toBe(1);
    // decision_key 以 live: 开头,和回测(matrix:)/ASP(asp:)分开
    const key = f.state.db.prepare('SELECT decision_key FROM research_judge_decisions').get()!['decision_key'];
    expect(String(key).startsWith(`live:shadow:${a.run.id}:`)).toBe(true);
    expect(f.live()).toHaveLength(1);
    // 影子判断不写运行事件、不改运行统计
    expect(f.runner.get(a.run.id).stats).toMatchObject({ orders: 1, skipped: 0 });
  });

  it('不阻塞下单:判断一直不回,扫描照样返回并下单;stop 中止在途判断', async () => {
    const hang = stubProvider('deterministic'); let started = 0;
    hang.decide = (_req, o) => new Promise((_res, reject) => { started++; o?.signal?.addEventListener('abort', () => reject(new Error('aborted'))); });
    const f = fixture({ provider: hang });
    const a = await f.create();
    expect(a.scan.map(e => e.kind)).toEqual(['scan', 'candidate', 'order_opened']);
    expect(f.deps.open).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(started).toBe(1));
    expect(f.runner.judgeLedger.list()).toHaveLength(0);
    await f.runner.stop();
    expect(f.runner.get(a.run.id).status).toBe('running');
  });

  it('失败隔离:工厂抛错 / 模型抛错 / 账本写坏,运行不报错、单照下', async () => {
    const boom = fixture({ shadow: () => { throw new Error('factory boom'); } });
    const a = await boom.create(); await boom.runner.settleShadows();
    expect(a.run.status).toBe('running'); expect(a.scan.map(e => e.kind)).toEqual(['scan', 'candidate', 'order_opened']);
    expect(boom.runner.judgeLedger.list()[0]).toMatchObject({ status: 'error', mode: 'shadow' });

    const bad = stubProvider('deterministic'); bad.decide = async () => { throw new Error('provider down'); };
    const g = fixture({ provider: bad });
    const b = await g.create(); await g.runner.settleShadows();
    expect(b.run.status).toBe('running'); expect(g.deps.open).toHaveBeenCalledTimes(1);
    expect(g.runner.judgeLedger.list()[0]).toMatchObject({ status: 'error', action: 'skip' });

    const h = fixture();
    h.state.db.exec('DROP TABLE judge_live_decisions');
    const c = await h.create(); await h.runner.settleShadows();
    expect(c.run.status).toBe('running'); expect(c.scan.map(e => e.kind)).toEqual(['scan', 'candidate', 'order_opened']);
    expect(h.runner.get(c.run.id).error).toBeNull();
  });

  it('决策模型没绑定:静默跳过,每运行每天只记一条 skip 原因', async () => {
    const f = fixture({ provider: null });
    const a = await f.create({ symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] }); await f.runner.settleShadows();
    expect(f.deps.open).toHaveBeenCalledTimes(3);
    const rows = f.runner.judgeLedger.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ run_id: a.run.id, status: 'skipped', action: null, reason_codes: ['decision_model_unbound'], cost_usd: '0' });
  });

  it('预算上限:超过每日次数后不再调模型,只记一条 shadow_budget_exhausted', async () => {
    const f = fixture({ max_calls: 2 });
    await f.create({ symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'], max_open: 5 }); await f.runner.settleShadows();
    expect(f.provider!.calls).toBe(2);
    const rows = f.runner.judgeLedger.list();
    expect(rows.filter(r => r.status !== 'skipped')).toHaveLength(2);
    expect(rows.filter(r => r.status === 'skipped').map(r => r.reason_codes[0])).toEqual(['shadow_budget_exhausted']);
    expect(f.deps.open).toHaveBeenCalledTimes(4);
  });

  it('默认上限:每日 200 次、美元上限 = 200 × JUDGE_MAX_CALL_USD', () => {
    expect(JEV_SHADOW_MAX_CALLS).toBe(200);
    expect(JEV_SHADOW_MAX_USD).toBe(usdString(usdUnits(JUDGE_MAX_CALL_USD) * 200n));
  });

  it('jev_shadow=false 关掉;PATCH 能改回来;非布尔拒绝', async () => {
    const f = fixture();
    const a = await f.create({ jev_shadow: false }); await f.runner.settleShadows();
    expect(a.run.jev_shadow).toBe(false); expect(f.provider!.calls).toBe(0); expect(f.runner.judgeLedger.list()).toHaveLength(0);
    expect(f.deps.open).toHaveBeenCalledTimes(1);
    const p = await f.runner.patch(a.run.id, { jev_shadow: true }); expect(p.run.jev_shadow).toBe(true);
    const q = await f.runner.patch(a.run.id, { max_open: 4 }); expect(q.run.jev_shadow).toBe(true);
    await f.runner.patch(a.run.id, { jev_shadow: false }); expect((await f.runner.patch(a.run.id, { max_open: 5 })).run.jev_shadow).toBe(false);
    expect(() => f.runner.patch(a.run.id, { jev_shadow: 'no' })).toThrow('jev_shadow');
  });

  it('盘口/清算录制齐全时带进问题,账本标出可用', async () => {
    const as_of = T0 + 101 * H;
    const micro = async (symbol: string): Promise<MicrostructureSnapshot> => ({ symbol, book: { at: as_of - 1000, available_at: as_of - 500, bids: [['102.9', '10'], ['102.8', '5']], asks: [['103.1', '8'], ['103.2', '20']] },
      liquidations: [], liquidation_coverage: { from_ms: as_of - 400_000, to_ms: as_of, available_at: as_of } });
    const f = fixture({ micro });
    await f.create(); await f.runner.settleShadows();
    const row = f.runner.judgeLedger.list()[0]!;
    expect(row.state?.micro).toMatchObject({ requested: true, book: true, liquidations: true, used: true });
    expect(Object.keys(row.state!.features)).toEqual(expect.arrayContaining(['ob_imbalance_05', 'spread_bps', 'liq_long_5m']));
  });
});

describe('judge 块挡单语义不变', () => {
  // 契约:带 judge 块的 IR 必须 version≥2 且有 order 块
  function withJudge(judge: ReturnType<typeof stubJudgeSpec>) { const ir = policyToIR(SYNTH_POLICY); Object.assign(ir, { version: 2, order: { direction: 'long', market: 'spot', leverage: 1 }, judge }); return ir; }
  function judgeIr() { return withJudge(stubJudgeSpec(stubProfile('all_skip'))); }
  function gateRuntime(db: import('node:sqlite').DatabaseSync, kind: 'all_skip' | 'deterministic', run_id: string): JudgeRuntime {
    return { mode: 'request_once', scope: `live:gate:${run_id}:1`, provider: stubProvider(kind), model_profile: stubProfile(kind), execution_spec_hash: 'x', store: new JudgeDecisionStore(db), budget: AtomicCallBudget.create(db, `live:gate:${run_id}:1`, 10, '0') };
  }
  it('judge 说 skip → 不下单(ir_judge_skip),不做影子判断,账本记一条 gate', async () => {
    const f = fixture({ ir: judgeIr() });
    f.deps.judge = (run) => gateRuntime(f.state.db, 'all_skip', run.id);
    const a = await f.create(); await f.runner.settleShadows();
    expect(f.deps.open).not.toHaveBeenCalled();
    expect(a.scan.map(e => e.kind)).toEqual(['scan', 'candidate', 'agent_skip', 'skip']);
    expect(a.scan.find(e => e.kind === 'skip')?.message).toBe('ir_judge_skip');
    expect(f.provider!.calls).toBe(0);
    const rows = f.runner.judgeLedger.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode: 'gate', action: 'skip', status: 'ok', questions: [{ key: 'take' }] });
    expect(rows[0]!.answers[0]).toMatchObject({ question_key: 'take', probabilities: { yes: 0, no: 1 } });
    expect(f.live()).toHaveLength(1);
  });
  it('没有 judge 运行时 → 照旧 fail closed,账本记 skipped', async () => {
    const f = fixture({ ir: judgeIr() });
    f.deps.judge = () => null;
    const a = await f.create();
    expect(f.deps.open).not.toHaveBeenCalled();
    expect(a.scan.find(e => e.kind === 'agent_skip')?.message).toBe('judge_runtime_missing');
    expect(f.runner.judgeLedger.list()[0]).toMatchObject({ mode: 'gate', status: 'skipped', action: 'skip', error: 'judge_runtime_missing' });
  });
  it('judge 说 follow → 下单,账本 action=follow', async () => {
    const follow = stubProvider('deterministic');
    follow.decide = async (req) => ({ model: follow.profile.model, answers: Object.fromEntries(Object.keys(req.questions).map(k => [k, { type: 'noul', noul: 0.95 }])), usage: { input_tokens: 0, cost_usd: 0 }, latency_ms: 12 });
    const f = fixture({ ir: withJudge(stubJudgeSpec(follow.profile)) });
    f.deps.judge = (run) => ({ ...gateRuntime(f.state.db, 'deterministic', run.id), provider: follow });
    const a = await f.create();
    expect(f.deps.open).toHaveBeenCalledTimes(1);
    expect(a.scan.map(e => e.kind)).toEqual(['scan', 'candidate', 'agent_follow', 'order_opened']);
    expect(f.runner.judgeLedger.list()[0]).toMatchObject({ mode: 'gate', action: 'follow', status: 'ok', latency_ms: 12, cost_usd: '0' });
  });
  it('账本写坏不影响挡单结果', async () => {
    const f = fixture({ ir: judgeIr() });
    f.deps.judge = (run) => gateRuntime(f.state.db, 'all_skip', run.id);
    f.state.db.exec('DROP TABLE judge_live_decisions');
    const a = await f.create();
    expect(a.run.status).toBe('running'); expect(f.deps.open).not.toHaveBeenCalled();
    expect(a.scan.find(e => e.kind === 'skip')?.message).toBe('ir_judge_skip');
  });
});
