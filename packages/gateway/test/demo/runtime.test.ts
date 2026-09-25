const VERIFIED_OOS = { oos_n: 40, oos_net_expectancy: 0.2, oos_ci: { status: 'sufficient' as const, lower: 0.05, upper: 0.3, iterations: 2000, block_size: 7 }, dsr: 0.1, max_dd_r: 1, regime: { trend: { n: 20, net_expectancy: 0.2 }, range: { n: 20, net_expectancy: 0.2 } } };
// runtime.ts: DemoRuntime end-to-end against an in-memory sqlite store, PaperBackend, a scripted
// stub brain, and a local fake market server. TG_DEMO_MARKET_BASE is set BEFORE dynamic-importing
// runtime.ts (and everything it statically imports, including market.ts/info.ts, which read the
// env var as a module-level const).

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { stubBrain } from '../../src/demo/brain.js';
import { startFakeOkxServer } from './helpers/fake-okx-server.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';
import type { Judgment, Trigger } from '../../src/demo/types.js';

let server: FakeMarketServer;
let DemoRuntime: typeof import('../../src/demo/runtime.js').DemoRuntime;

beforeAll(async () => {
  server = await startFakeMarketServer(77000, 200);
  process.env['TG_DEMO_MARKET_BASE'] = server.url;
  ({ DemoRuntime } = await import('../../src/demo/runtime.js'));
});

afterAll(async () => {
  await server.close();
  delete process.env['TG_DEMO_MARKET_BASE'];
});

type RT = InstanceType<typeof DemoRuntime>;

async function drained(rt: RT): Promise<void> {
  const start = Date.now();
  for (;;) {
    const v = rt.queueView();
    if (v.pending === 0 && v.running === null) return;
    if (Date.now() - start > 5000) throw new Error('queue did not drain within 5s');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------- scripted stub brain

type Mode = 'no_trade' | 'propose' | 'hold' | 'exit' | 'invalidate' | 'reduce';

function noTradeJudgment(): Judgment {
  return { action: 'NO_TRADE', direction: null, confidence: 0.2, headline: '桩:不交易', thesis: '测试', reasons: ['测试 [E1]'], evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [], proposal: null };
}
function proposeJudgment(mark: number): Judgment {
  const stop = (mark * 0.99).toFixed(2);
  const tp = (mark * 1.02).toFixed(2);
  return {
    action: 'PROPOSE', direction: 'long', confidence: 0.75, headline: '桩:测试做多', thesis: '测试用提议,验证执行链路', strategy_id: 'breakout_retest',
    reasons: ['测试原因 [E1]'], evidence_refs: ['E1'], invalidation: '跌破止损', invalidation_price: stop, target_price: tp, watch_conditions: [],
    proposal: { direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: stop, take_profit_price: tp, take_profits: [tp], rationale: '测试' },
  };
}
function reviewJudgment(action: 'HOLD' | 'EXIT' | 'INVALIDATE' | 'REDUCE'): Judgment {
  return { action, direction: 'long', confidence: 0.6, headline: `桩:${action}`, thesis: '测试复查', reasons: ['测试原因 [E1]'], evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [], proposal: null };
}

function scriptFor(mode: Mode, user: string): string {
  const isReview = /## 复查的线程/.test(user);
  const markMatch = /mark (\d+(?:\.\d+)?)/.exec(user);
  const mark = markMatch ? Number(markMatch[1]) : 0;
  if (isReview) {
    if (mode === 'hold') return JSON.stringify(reviewJudgment('HOLD'));
    if (mode === 'exit') return JSON.stringify(reviewJudgment('EXIT'));
    if (mode === 'invalidate') return JSON.stringify(reviewJudgment('INVALIDATE'));
    if (mode === 'reduce') return JSON.stringify(reviewJudgment('REDUCE'));
    return JSON.stringify(reviewJudgment('HOLD'));
  }
  if (mode === 'propose') return JSON.stringify(proposeJudgment(mark));
  return JSON.stringify(noTradeJudgment());
}

function mkRuntime(sizingReply?: string, onSizing?: () => void): { rt: RT; store: DemoStore; state: StateDb; backend: PaperBackend; setMode: (m: Mode) => void } {
  const state = openStateDb(':memory:');
  const store = new DemoStore(state);
  const backend = new PaperBackend(10_000);
  let mode: Mode = 'no_trade';
  const brain = stubBrain((system, user) => {
    if (system.includes('Portfolio 仓位顾问')) { onSizing?.(); return sizingReply ?? 'garbage'; }
    return scriptFor(mode, user);
  });
  const rt = new DemoRuntime({ store, backend, brains: { stub: brain }, marketPollMs: 600_000, accountPollMs: 600_000 });
  return { rt, store, state, backend, setMode: (m) => (mode = m) };
}

let activeRt: RT | null = null;
let activeState: StateDb | null = null;

function useRuntime(): { rt: RT; store: DemoStore; backend: PaperBackend; setMode: (m: Mode) => void } {
  const r = mkRuntime();
  activeRt = r.rt;
  activeState = r.state;
  return r;
}

afterEach(async () => {
  if (activeRt) await activeRt.stop();
  if (activeState) activeState.close();
  activeRt = null;
  activeState = null;
});

const T = (detail: string): Trigger => ({ kind: 'manual', detail });

// ---------------------------------------------------------------- (a) scan → NO_TRADE

describe('scan(): NO_TRADE', () => {
  it('produces a done episode and opens no thread', async () => {
    const { rt, store, setMode } = useRuntime();
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'] });
    setMode('no_trade');

    expect(rt.scan('BTCUSDT', T('test scan'))).toBe(true);
    await drained(rt);

    expect(rt.openThreads()).toHaveLength(0);
    const eps = store.episodes(10).filter((e) => e.symbol === 'BTCUSDT');
    expect(eps).toHaveLength(1);
    expect(eps[0]!.status).toBe('done');
    expect(eps[0]!.action).toBe('NO_TRADE');
    expect(eps[0]!.has_intent).toBe(false);
    expect(eps[0]!.thread_id).toBeNull();
  });
});

// ---------------------------------------------------------------- (b) PROPOSE → in_position → HOLD → EXIT

describe('scan(): PROPOSE with auto_approve → in_position → review HOLD → review EXIT', () => {
  it('opens with protection, HOLD preserves it, unsupported EXIT is blocked, explicit close settles', async () => {
    const { rt, store, setMode } = useRuntime();
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'], auto_approve: true });
    setMode('propose');

    expect(rt.scan('BTCUSDT', T('scan'))).toBe(true);
    await drained(rt);

    let threads = rt.openThreads();
    expect(threads).toHaveLength(1);
    let thread = threads[0]!;
    expect(thread.status).toBe('in_position');
    expect(thread.protection_client_order_ids.length).toBeGreaterThan(0);
    expect(thread.entry_client_order_id).not.toBeNull();

    const account = await rt.backend.account();
    expect(account.positions.some((p) => p.symbol === 'BTCUSDT')).toBe(true);

    const ep = store.episodes(10).find((e) => e.symbol === 'BTCUSDT' && e.action === 'PROPOSE')!;
    expect(ep.thread_id).toBe(thread.id);

    const versionAfterOpen = thread.version;
    setMode('hold');
    expect(rt.reviewThread(thread.id, T('review 1'))).toBe(true);
    await drained(rt);
    thread = store.thread(thread.id)!;
    expect(thread.status).toBe('in_position');
    expect(thread.version).toBeGreaterThan(versionAfterOpen);

    setMode('exit');
    expect(rt.reviewThread(thread.id, T('review 2'))).toBe(true);
    await drained(rt);
    thread = store.thread(thread.id)!;
    expect(thread.status).toBe('in_position');
    expect(thread.holding_plan?.thesis).toBe('测试用提议,验证执行链路');
    await rt.closeThread(thread.id);
    thread = store.thread(thread.id)!;
    expect(thread.status).toBe('closed');
    expect(thread.realized_pnl).not.toBeNull();
  });
});

// ---------------------------------------------------------------- (c) auto_approve=false

describe('scan(): PROPOSE with auto_approve=false', () => {
  it('creates a pending_approval intent + pending_entry thread; reject cancels it; approving a fresh one opens it', async () => {
    const { rt, store, setMode } = useRuntime();
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'], auto_approve: false });
    setMode('propose');

    expect(rt.scan('BTCUSDT', T('scan 1'))).toBe(true);
    await drained(rt);

    let threads = rt.openThreads();
    expect(threads).toHaveLength(1);
    let thread = threads[0]!;
    expect(thread.status).toBe('pending_entry');
    expect(thread.entry_client_order_id).toBeNull();

    const intent = store.intents(10).find((i) => i.thread_id === thread.id)!;
    expect(intent.status).toBe('pending_approval');

    rt.rejectIntent(intent.id);
    thread = store.thread(thread.id)!;
    expect(thread.status).toBe('canceled');

    // a fresh proposal for the same symbol (the canceled thread doesn't block it)
    expect(rt.scan('BTCUSDT', T('scan 2'))).toBe(true);
    await drained(rt);
    const thread2 = rt.openThreads()[0]!;
    const intent2 = store.intents(10).find((i) => i.thread_id === thread2.id && i.status === 'pending_approval')!;
    expect(intent2).toBeDefined();

    // v3.10: approval needs a one-time confirm token (§9.19); without it nothing executes.
    await expect(rt.approveIntent(intent2.id)).rejects.toThrow(/token/);
    await rt.approveIntent(intent2.id, rt.issueIntentConfirmation(intent2.id).token.nonce);
    const finalThread = store.thread(thread2.id)!;
    expect(finalThread.status).toBe('in_position');
  });
});

// ---------------------------------------------------------------- (d) manual orders

describe('manualOrder()', () => {
  it('a market order with sl/tp opens a source=manual thread in_position; a far-away limit rests pending_entry; closing it cancels it', async () => {
    const { rt } = useRuntime();
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub' });

    const ethMark = Number(rt.markets.get('ETHUSDT')!.mark);
    const opened = await rt.manualOrder({ symbol: 'ETHUSDT', side: 'long', action: 'open', type: 'market', qty: '0.01', leverage: 5, sl: (ethMark * 0.95).toFixed(2), tp: (ethMark * 1.05).toFixed(2) });
    expect(opened.thread).not.toBeNull();
    expect(opened.thread!.source).toBe('manual');
    expect(opened.thread!.status).toBe('in_position');

    const solMark = Number(rt.markets.get('SOLUSDT')!.mark);
    const farLimit = (solMark * 0.3).toFixed(2); // long limit well below mark → rests instead of filling (and stays under the max-notional gate at qty=1, SOL's min step)
    const pending = await rt.manualOrder({ symbol: 'SOLUSDT', side: 'long', action: 'open', type: 'limit', price: farLimit, qty: '1', sl: (solMark * 0.2).toFixed(2) });
    expect(pending.thread).not.toBeNull();
    expect(pending.thread!.status).toBe('pending_entry');

    const closed = await rt.closeThread(pending.thread!.id);
    expect(closed.status).toBe('canceled');
  });
});

// ---------------------------------------------------------------- (e) openingBlockers via gates

describe('opening blockers respected via the code gates', () => {
  it('max_open_threads=1: the first PROPOSE actually opens the thread (regression for the preflightOpen self-count bug — it must exclude its own thread id), then a second symbol\'s PROPOSE is rejected by the 线程/日内限制 gate', async () => {
    const { rt, store, setMode } = useRuntime();
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT', 'ETHUSDT'], auto_approve: true, max_open_threads: 1 });
    setMode('propose');

    expect(rt.scan('BTCUSDT', T('t1'))).toBe(true);
    await drained(rt);
    const threads = rt.openThreads();
    expect(threads).toHaveLength(1);
    const thread = threads[0]!;
    expect(thread.symbol).toBe('BTCUSDT');
    expect(thread.status).toBe('in_position');
    expect(thread.entry_client_order_id).not.toBeNull();

    expect(rt.scan('ETHUSDT', T('t2'))).toBe(true);
    await drained(rt);
    expect(rt.openThreads().some((t) => t.symbol === 'ETHUSDT')).toBe(false);

    const epSummary = store.episodes(10).find((e) => e.symbol === 'ETHUSDT' && e.action === 'PROPOSE')!;
    expect(epSummary.reducer?.accepted).toBe(false);
    const ep = store.episode(epSummary.id)!;
    expect(ep.gates.some((g) => g.name === '线程/日内限制' && !g.passed && /上限/.test(g.reason))).toBe(true);
  });
});


// ---------------------------------------------------------------- (f) halt / resume

describe('halt() / resume()', () => {
  it('halt() closes every open thread and cancels orders; resume() requires confirm=RESUME', async () => {
    const { rt, store, setMode } = useRuntime();
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'], auto_approve: true });
    setMode('propose');
    expect(rt.scan('BTCUSDT', T('scan'))).toBe(true);
    await drained(rt);
    const thread = rt.openThreads()[0]!;
    expect(thread.status).toBe('in_position');

    await rt.halt();
    expect(rt.isHalted).toBe(true);
    const after = store.thread(thread.id)!;
    expect(after.status).toBe('closed');
    expect(after.close_reason).toBe('紧急停止');

    // halted: no new scans accepted
    expect(rt.scan('BTCUSDT', T('should be blocked'))).toBe(false);

    const noConfirm = rt.resume();
    expect(noConfirm.ok).toBe(false);
    expect(rt.isHalted).toBe(true);

    const confirmed = rt.resume('RESUME');
    expect(confirmed.ok).toBe(true);
    expect(rt.isHalted).toBe(false);
  });
});

// ---------------------------------------------------------------- (g) queue dedupe

describe('queue dedupe', () => {
  it('a second scan("BTCUSDT") issued while the first is in flight is rejected', async () => {
    const { rt, setMode } = useRuntime();
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'] });
    setMode('no_trade');

    const first = rt.scan('BTCUSDT', T('t'));
    const second = rt.scan('BTCUSDT', T('t'));
    expect(first).toBe(true);
    expect(second).toBe(false);
    await drained(rt);
  });
});


// ---------------------------------------------------------------- 09-12 P1-07
// entry_basis 以前直接抄扫描时那条建议(context.ts 按 breakout/第一条策略 + 趋势方向算的),
// 模型最后可能换了策略、换了方向 —— 发送前拿它测距等于量错了尺子。
describe('P1-07 entry_basis 按最终所选策略/方向重新冻结', () => {
  it('建线程时按最终策略周期 + 最终方向重算,不再照抄 ep.entry_advice', async () => {
    const r = mkRuntime();
    activeRt = r.rt; activeState = r.state;
    await r.rt.start();
    r.rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', sizing_agent: 'off', auto_approve: false, watchlist: ['BTCUSDT'] });
    r.setMode('no_trade');
    expect(r.rt.scan('BTCUSDT', T('freeze basis'))).toBe(true);
    await drained(r.rt);
    const ep = r.store.episodes(10).find((e) => e.symbol === 'BTCUSDT')!;
    const market = (r.rt as any).markets.get('BTCUSDT');
    // 扫描时那条建议:方向/周期都可能不是模型最后选的那条,数值故意给成认得出来的假值
    ep.gates = ep.gates ?? [];
    ep.entry_advice = { recommended: 'limit', zone: null, dist_to_break_atr: null, mark: 1, breakout_level: 123456, atr: 7, entry_mode: null, retest_confirmed: false, market_blocked: false, reason: '扫描时按首策略/趋势方向算的', text: '' } as never;
    const thread = await (r.rt as any).openThreadFromProposal(ep, proposeJudgment(Number(market.mark)), await r.backend.account(), market, 'agent');
    expect(thread.entry_basis).toBeTruthy();
    expect(thread.entry_basis.breakout_level).not.toBe(123456); // 修前:照抄
    expect(thread.entry_basis.atr).not.toBe(7);
    expect(thread.entry_basis.breakout_level).toBeGreaterThan(0);
    expect(thread.entry_basis.mark).toBeCloseTo(Number(market.mark), 0);
  });
});

describe('Portfolio sizing opinion runtime', () => {
  it.each(['off', 'advise', 'apply', 'garbage'] as const)('%s uses a stub and persists its sizing decision', async (mode) => {
    let calls = 0;
    const r = mkRuntime(mode === 'garbage' ? 'garbage' : JSON.stringify({ risk_multiplier: 0.5, allow_min_lot_overshoot: false, split_entries: 2, reason: '保留预算' }), () => calls++);
    activeRt = r.rt; activeState = r.state;
    await r.rt.start();
    r.rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', sizing_agent: mode === 'garbage' ? 'apply' : mode, watchlist: ['BTCUSDT'], auto_approve: false });
    r.setMode('propose');
    expect(r.rt.scan('BTCUSDT', T('sizing test'))).toBe(true);
    await drained(r.rt);
    const ep = r.store.episodes(10).find((e) => e.symbol === 'BTCUSDT')!;
    const detail = r.store.episode(ep.id)!;
    const intent = r.store.intents(10)[0]!;
    expect(intent).toBeDefined();
    expect(calls).toBe(mode === 'off' ? 0 : 1);
    expect(intent.sizing.risk_usdt).toBe(mode === 'apply' ? '25.00' : '50.00');
    expect(detail.sizing).toEqual(intent.sizing);
    if (mode === 'off') expect(intent.sizing.agent).toBeUndefined();
    else {
      expect(intent.sizing.agent?.applied).toBe(mode === 'apply');
      expect(intent.sizing.agent?.multiplier).toBe(mode === 'garbage' ? 1 : 0.5);
      expect(detail.sizing_evidence).toHaveProperty('capacity');
      expect(detail.intent?.sizing.agent).toEqual(intent.sizing.agent);
    }
    const result = await r.rt.approveIntent(intent.id, r.rt.issueIntentConfirmation(intent.id).token.nonce);
    expect(result.status).toBe('filled');
    expect((await r.backend.account()).positions[0]?.qty).toBe(intent.quantity);
    expect(calls).toBe(mode === 'off' ? 0 : 1);
  });
  it.each(['max_gross_ratio', 'max_net_ratio', 'max_cluster_ratio', 'max_stop_budget_ratio', 'max_quote_volume_pct'] as const)('rechecks %s on approval without changing the quantity', async (cap) => {
    const r = mkRuntime(JSON.stringify({ risk_multiplier: 2, allow_min_lot_overshoot: true, split_entries: 3, reason: '信心充足' }));
    activeRt = r.rt; activeState = r.state;
    await r.rt.start();
    r.rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', sizing_agent: 'apply', watchlist: ['BTCUSDT'], auto_approve: false });
    r.setMode('propose');
    r.rt.scan('BTCUSDT', T('cap test'));
    await drained(r.rt);
    const intent = r.store.intents(10)[0]!;
    expect(intent.status).toBe('pending_approval');
    const qty = intent.quantity;
    expect(r.rt.setPortfolioPolicy({ [cap]: cap === 'max_quote_volume_pct' ? 0.000001 : cap === 'max_stop_budget_ratio' ? 0.001 : 0.1 }).errors).toEqual([]);
    const result = await r.rt.approveIntent(intent.id, r.rt.issueIntentConfirmation(intent.id).token.nonce);
    expect(result.status).toBe('rejected');
    expect(result.quantity).toBe(qty);
    expect((await r.backend.account()).positions).toEqual([]);
  });
});


describe('model INVALIDATE cancellation with a constructed holding plan', () => {
  it('review → cancel → terminal partial fill keeps the owned quantity and places a stop', async () => {
    const { rt, store, backend, setMode } = useRuntime();
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['SOLUSDT'] });
    const mark = Number(rt.markets.get('SOLUSDT')!.mark);
    const opened = await rt.manualOrder({ symbol: 'SOLUSDT', side: 'long', action: 'open', type: 'limit', price: (mark * 0.3).toFixed(2), qty: '1', sl: (mark * 0.2).toFixed(2) });
    const t = store.thread(opened.thread!.id)!;
    const { buildHoldingPlan } = await import('../../src/demo/holding-policy.js');
    t.holding_plan = buildHoldingPlan({ thread: t, features: [{ tf: t.timeframe, atr14: mark * 0.02 } as import('../../src/demo/market.js').TfFeatures], now: t.created_at })!;
    expect(t.holding_plan).not.toBeNull(); store.saveThread(t);
    const query = vi.spyOn(backend, 'getOrder').mockImplementation(async (_symbol, cid) => cid === t.entry_client_order_id ? { status: 'CANCELED', executed_qty: '0.4', avg_price: t.entry.price, raw: null } : null);
    const stop = vi.spyOn(backend, 'placeStop');
    try {
      setMode('invalidate');
      expect(rt.reviewThread(t.id, T('cancel race'))).toBe(true); await drained(rt);
      const ep = store.episode(store.episodes(20).find(e => e.thread_id === t.id && e.action === 'INVALIDATE')!.id)!;
      expect(ep.holding_review!.reason).not.toBe('legacy_plan_unavailable');
      expect(ep.holding_review!.allowed_actions).toContain('INVALIDATE');
      expect(store.thread(t.id)!.status).toBe('in_position'); expect(store.thread(t.id)!.qty).toBe('0.4');
      expect(stop).toHaveBeenCalled(); expect(query).toHaveBeenCalledWith(t.symbol, t.entry_client_order_id, true, 'perp');
    } finally { query.mockRestore(); stop.mockRestore(); }
  });
});

// ---------------------------------------------------------------- 每日判断预算:出队时再查一次

describe('daily_judgment_cap 在出队执行前复查', () => {
  it('批量入队不能越过上限:队列里排着的任务在真正开跑前被丢弃', async () => {
    const { rt, store, setMode } = useRuntime();
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'], daily_judgment_cap: 2 });
    setMode('no_trade');

    // 三个币同时入队:第一条马上开跑(此时用量还是 0),后两条在入队那一刻看到的用量也只有 1,
    // 都排得进去;修复前第三条排到自己时会照跑,总数变成 3。
    expect(rt.scan('BTCUSDT', T('batch'))).toBe(true);
    expect(rt.scan('ETHUSDT', T('batch'))).toBe(true);
    expect(rt.scan('SOLUSDT', T('batch'))).toBe(true);
    await drained(rt);

    expect(store.episodes(20)).toHaveLength(2);
    expect(rt.usageToday().judgments).toBe(2);
  });
});

// ---------------------------------------------------------------- §9.54 当前策略挡自由判断开仓

describe('§9.54 agent 当前策略', () => {
  it('有当前策略在运行时,自由判断线的 PROPOSE 被「当前策略」闸挡住,不开线程', async () => {
    const { rt, store, setMode } = useRuntime();
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'], auto_approve: true });
    setMode('propose');
    vi.spyOn(rt.agentStrategy(), 'blocksFreeOpens').mockReturnValue('当前策略「测试」在运行,自由判断只复查不开新仓');
    rt.scan('BTCUSDT', T('当前策略闸'));
    await drained(rt);
    expect(rt.openThreads()).toHaveLength(0);
    const ep = store.episode(store.episodes(10).find((e) => e.symbol === 'BTCUSDT')!.id)!;
    expect(ep.gates.find((g) => g.name === '当前策略')).toMatchObject({ passed: false });
  });

  it('没有当前策略:行为不变,照常开仓', async () => {
    const { rt, setMode } = useRuntime();
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'], auto_approve: true });
    setMode('propose');
    rt.scan('BTCUSDT', T('无当前策略'));
    await drained(rt);
    expect(rt.openThreads()).toHaveLength(1);
    expect(rt.agentStrategy().view().kind).toBe('free');
  });
});

// ---------------------------------------------------------------- Radar 候选不替换议会票池

describe('Radar 候选只是优先项,不是票池', () => {
  it('§9.54 旧库退出:有候选时议会也不再对 active_strategies 投票', async () => {
    const { rt, store, setMode } = useRuntime();
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'], strategy_council: 'advise', active_strategies: ['breakout_retest'] });
    setMode('no_trade');

    // 一条 Radar 候选:它推荐的策略还在 backtest(达不到 paper),修复前它会**替换**整个票池,
    // 于是议会一票都投不出来(active.specs 为空);现在它只是排在最前的提示。
    const now = Date.now();
    store.screens.saveCandidates([
      { screen_id: 'scr-1', horizon: 'intraday', symbol: 'BTCUSDT', strategy_id: 'mtf_alignment', fit_score: 0.9, rank: 1, reasons: ['测试'], card: {} as never, ttl_at: now + 3_600_000, created_at: now },
    ]);
    store.kvSet('radar.applied_screen', 'scr-1');

    rt.scan('BTCUSDT', T('候选扫描'));
    await drained(rt);

    const ep = store.episodes(10).find((e) => e.symbol === 'BTCUSDT')!;
    const full = store.episode(ep.id)!;
    // §9.54(09-25):旧策略库退出开仓票池 —— active_strategies 不再进议会,只在当前策略视图里回显为已忽略。
    expect((full.strategy_council?.verdicts ?? []).map((v) => v.strategy_id)).not.toContain('breakout_retest');
    expect(rt.agentStrategy().view()).toMatchObject({ kind: 'free', legacy_pool_ignored: ['breakout_retest'] });
  });
});

// ---------------------------------------------------------------- 取数按策略声明的 min_bars

describe('扫描取数按启用策略的 max(min_bars)', () => {
  it('§9.54 旧库退出:paper 级旧库策略也不进开仓票池', async () => {
    const { rt, store, setMode } = useRuntime();
    await rt.start();
    // backtest → shadow → paper(两格各自过统计门)
    expect(store.strategies.updateEvalStats('range_mean_reversion', { trades: 30, win_rate: 0.6, expectancy_r: 0.5, avg_r: 0.5, max_dd_r: 1, note: '测试' } as never)).not.toBeNull();
    store.strategies.updateLabStats('range_mean_reversion', 1, { ...VERIFIED_OOS, run_id: 'r', at: 1, symbols: 2, setups: 40, n: 40, win_rate: 0.5, expectancy_r: 0.2, total_r: 8, note: '', shadow: { n: 30, win_rate: 0.5, expectancy_r: 0.3, total_r: 9, max_drawdown_r: 1, first_at: 1, last_at: 2, net_expectancy_r: 0.2, net_max_drawdown_r: 1 } });
    expect(store.strategies.promote('range_mean_reversion', 'shadow').error).toBeNull();
    store.strategies.updateShadowStats('range_mean_reversion', 1, { n: 30, win_rate: 0.5, expectancy_r: 0.3, total_r: 9, max_drawdown_r: 1, first_at: 1, last_at: 2, net_expectancy_r: 0.2, net_max_drawdown_r: 1 });
    expect(store.strategies.promote('range_mean_reversion', 'paper').error).toBeNull();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'], strategy_council: 'advise', active_strategies: ['breakout_retest', 'range_mean_reversion'] });
    setMode('no_trade');

    rt.scan('BTCUSDT', T('min_bars 扫描'));
    await drained(rt);

    // §9.54(09-25):旧库策略即使到了 paper 也不再进开仓票池;研究台策略走 StrategyRun 自己取数。
    const ep = store.episode(store.episodes(10).find((e) => e.symbol === 'BTCUSDT')!.id)!;
    expect((ep.strategy_council?.verdicts ?? []).find((x) => x.strategy_id === 'range_mean_reversion')).toBeUndefined();
    expect(rt.agentStrategy().view().legacy_pool_ignored).toEqual(['breakout_retest', 'range_mean_reversion']);
  });
});

describe('spot runtime end-to-end', () => {
  it('现金开仓跳过杠杆设置,保护和平仓不会碰同币 perp', async () => {
    const { rt, backend, store } = useRuntime();
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', markets: ['perp', 'spot'], watchlist: ['BTCUSDT'], max_open_threads: 4 });
    const mark = Number(rt.markets.get('BTCUSDT')!.mark);
    const perp = await rt.manualOrder({ symbol: 'BTCUSDT', market: 'perp', side: 'long', action: 'open', type: 'market', qty: '0.001', sl: String(mark * 0.95) });
    expect(perp.thread?.status).toBe('in_position');
    const lev = vi.spyOn(backend, 'setLeverage');
    const margin = vi.spyOn(backend, 'setMarginType');
    const fakeSpot = await startFakeOkxServer();
    process.env['TG_EXCHANGE'] = 'okx'; process.env['TG_OKX_REST_BASE'] = fakeSpot.url;
    try {
    const spot = await rt.manualOrder({ symbol: 'BTCUSDT', market: 'spot', side: 'long', action: 'open', type: 'market', qty: '0.002', sl: String(mark * 0.95), leverage: 99, margin_mode: 'isolated' });
    expect(spot.thread).toMatchObject({ market: 'spot', side: 'long', leverage: 1, margin_mode: 'cross', status: 'in_position' });
    expect(Number(spot.thread!.margin_usdt)).toBeCloseTo(81400 * 0.002, 2);
    expect(lev).not.toHaveBeenCalled(); expect(margin).not.toHaveBeenCalled();
    expect(rt.markets.get('BTCUSDT')?.market).toBe('perp');
    expect(Number(rt.markets.get('BTCUSDT')?.mark)).toBe(mark);
    expect(rt.markets.get('spot:BTCUSDT')).toMatchObject({ market: 'spot', mark: '81400' });
    const account = await backend.account();
    expect(account.positions.map(p => p.market).sort()).toEqual(['perp', 'spot']);
    expect(account.open_orders.map(o => o.market).sort()).toEqual(['perp', 'spot']);
    // 立即减仓:旧止损刚挂不到60秒,不能被保护重试cooldown挡住补挂。
    await rt.manualOrder({ symbol: 'BTCUSDT', market: 'spot', side: 'long', action: 'close', type: 'market', qty: '0.001' });
    const reduced = await backend.account();
    expect(reduced.positions.find(p => p.market === 'spot')?.qty).toBe('0.001');
    expect(reduced.open_orders.filter(o => o.market === 'spot')).toMatchObject([{ type: 'STOP_MARKET', side: 'SELL' }]);
    expect(reduced.open_orders.filter(o => o.market === 'perp')).toHaveLength(1);
    await rt.closeThread(spot.thread!.id);
    expect(store.thread(spot.thread!.id)).toMatchObject({ market: 'spot', status: 'closed' });
    const after = await backend.account();
    expect(after.positions).toMatchObject([{ market: 'perp' }]);
    expect(after.open_orders).toMatchObject([{ market: 'perp' }]);
    expect(store.thread(perp.thread!.id)?.status).toBe('in_position');
    } finally { delete process.env['TG_EXCHANGE']; delete process.env['TG_OKX_REST_BASE']; await fakeSpot.close(); }
  });
});


describe('spot agent proposal market persistence', () => {
  it('agent现货提案生成spot待批线程与intent,保证金占用全额名义', async () => {
    const { rt, store, backend, setMode } = useRuntime();
    await rt.start();
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', sizing_agent: 'off', auto_approve: false, markets: ['perp', 'spot'], watchlist: ['BTCUSDT'], risk_pct: 0.1 });
    setMode('no_trade'); rt.scan('BTCUSDT', T('prepare spot episode')); await drained(rt);
    const ep = store.episode(store.episodes(10)[0]!.id)!;
    const fakeSpot = await startFakeOkxServer({ candleWick: 200 });
    process.env['TG_EXCHANGE'] = 'okx'; process.env['TG_OKX_REST_BASE'] = fakeSpot.url;
    try {
      const judgment = proposeJudgment(81400); judgment.proposal!.market = 'spot';
      const thread = await (rt as any).openThreadFromProposal(ep, judgment, await backend.account(), rt.markets.get('BTCUSDT'), 'agent', { forceApproval: true });
      expect(thread).toMatchObject({ market: 'spot', status: 'pending_entry', leverage: 1, side: 'long', pair_id: null });
      expect(store.thread(thread.id)).toMatchObject({ market: 'spot' });
      const intent = store.intents(20).find(i => i.thread_id === thread.id)!;
      expect(intent).toMatchObject({ market: 'spot', status: 'pending_approval' });
      expect(Number(thread.margin_usdt)).toBeCloseTo(Number(thread.qty) * 81400, 2);
      expect((await backend.account()).positions).toHaveLength(0);
    } finally { delete process.env['TG_EXCHANGE']; delete process.env['TG_OKX_REST_BASE']; await fakeSpot.close(); }
  });
});


describe('external spot partial close protection', () => {
  it('无线程现货已有止损,部分卖出接管并恢复剩余数量的保护', async () => {
    const { rt, backend, store } = useRuntime();
    await rt.start(); rt.setWorkflow({ markets: ['perp', 'spot'], watchlist: ['BTCUSDT'] });
    const fakeSpot = await startFakeOkxServer();
    process.env['TG_EXCHANGE'] = 'okx'; process.env['TG_OKX_REST_BASE'] = fakeSpot.url;
    try {
      backend.setMark('BTCUSDT', '81400', 'spot');
      await backend.placeEntry({ symbol: 'BTCUSDT', market: 'spot', direction: 'long', qty: '0.004', entry: 'market', limit_price: null, client_order_id: 'outside-entry' });
      await backend.placeStop('BTCUSDT', 'long', '78000', 'outside-stop', 'spot');
      expect(store.threads()).toHaveLength(0);
      await (rt as any).pollAccount();
      const result = await rt.manualOrder({ symbol: 'BTCUSDT', market: 'spot', side: 'long', action: 'close', type: 'market', qty: '0.002' });
      expect(result.thread).toMatchObject({ market: 'spot', status: 'in_position', qty: '0.002' });
      const account = await backend.account();
      expect(account.positions).toMatchObject([{ market: 'spot', qty: '0.002' }]);
      expect(account.open_orders).toHaveLength(1);
      expect(account.open_orders[0]).toMatchObject({ market: 'spot', type: 'STOP_MARKET', side: 'SELL', stop_price: '78000', qty: '0.002' });
    } finally { delete process.env['TG_EXCHANGE']; delete process.env['TG_OKX_REST_BASE']; await fakeSpot.close(); }
  });
});

describe('现货止损可选 runtime 回归', () => {
  async function spotRuntime() {
    const r = useRuntime();
    await r.rt.start();
    r.rt.setWorkflow({ markets: ['perp', 'spot'], watchlist: ['BTCUSDT'], brain: 'stub', cheap_brain: 'stub', sizing_agent: 'off', risk_pct: 1 });
    const fakeSpot = await startFakeOkxServer({ candleWick: 200 });
    process.env['TG_EXCHANGE'] = 'okx'; process.env['TG_OKX_REST_BASE'] = fakeSpot.url;
    return { ...r, cleanup: async () => { delete process.env['TG_EXCHANGE']; delete process.env['TG_OKX_REST_BASE']; await fakeSpot.close(); } };
  }

  it('手工按现金金额买入无止损现货,轮询后无保护 attention/告警/自动挂单', async () => {
    const { rt, backend, store, cleanup } = await spotRuntime();
    try {
      const stop = vi.spyOn(backend, 'placeStop');
      const result = await rt.manualOrder({ symbol: 'BTCUSDT', market: 'spot', side: 'long', action: 'open', type: 'market', margin_usdt: '200' });
      expect(result.thread).toMatchObject({ market: 'spot', status: 'in_position', stop_price: null, attention: null, protection_client_order_ids: [] });
      expect(Number(result.thread!.qty) * 81400).toBeLessThanOrEqual(200);
      expect(Number(result.thread!.qty) * 81400).toBeGreaterThan(200 - 81400 * 0.001);
      await (rt as any).pollAccount();
      const t = store.thread(result.thread!.id)!;
      expect(t.attention).toBeNull(); expect(t.protection_missing).not.toBe(true);
      expect(stop).not.toHaveBeenCalled();
      expect(rt.portfolioSnapshot?.unprotected_notional).toBe(0);
      expect(rt.riskOpen.filter(a => a.kind === 'protection_missing' || a.kind === 'thread_attention')).toEqual([]);
    } finally { await cleanup(); }
  });

  it('无止损但指定止盈时仍挂现货止盈单,不制造缺止损 attention', async () => {
    const { rt, backend, store, cleanup } = await spotRuntime();
    try {
      const stop = vi.spyOn(backend, 'placeStop');
      const result = await rt.manualOrder({ symbol: 'BTCUSDT', market: 'spot', side: 'long', action: 'open', type: 'market', qty: '0.002', tp: '90000' });
      await (rt as any).pollAccount();
      expect(stop).not.toHaveBeenCalled();
      expect(store.thread(result.thread!.id)).toMatchObject({ status: 'in_position', stop_price: null, attention: null });
      expect((await backend.account()).open_orders).toMatchObject([{ market: 'spot', type: 'TAKE_PROFIT_MARKET', stop_price: '90000' }]);
    } finally { await cleanup(); }
  });

  it('无止损现货部分减仓撤掉旧TP后,按剩余数量重新挂指定TP', async () => {
    const { rt, backend, store, cleanup } = await spotRuntime();
    try {
      const opened = await rt.manualOrder({ symbol: 'BTCUSDT', market: 'spot', side: 'long', action: 'open', type: 'market', qty: '0.004', tp: '90000' });
      const oldTp = (await backend.account()).open_orders[0]!;
      const reduce = backend.reducePosition.bind(backend);
      vi.spyOn(backend, 'reducePosition').mockImplementation(async (symbol, qty, cid, market) => {
        // 模拟交易所减仓路径先撤掉现货条件单;Paper 默认保留旧 TP。
        await backend.cancelAll(symbol, market);
        return reduce(symbol, qty, cid, market);
      });
      const stop = vi.spyOn(backend, 'placeStop');
      await rt.manualOrder({ symbol: 'BTCUSDT', market: 'spot', side: 'long', action: 'close', type: 'market', qty: '0.002' });
      const account = await backend.account();
      expect(account.positions).toMatchObject([{ market: 'spot', qty: '0.002' }]);
      expect(account.open_orders).toHaveLength(1);
      expect(account.open_orders[0]).toMatchObject({ market: 'spot', type: 'TAKE_PROFIT_MARKET', stop_price: '90000', qty: '0.002' });
      expect(account.open_orders[0]!.client_order_id).not.toBe(oldTp.client_order_id);
      expect(store.thread(opened.thread!.id)).toMatchObject({ stop_price: null, attention: null, qty: '0.002' });
      expect(stop).not.toHaveBeenCalled();
    } finally { await cleanup(); }
  });

  it('无主现货没有保护告警并可无止损接管', async () => {
    const { rt, backend, cleanup } = await spotRuntime();
    try {
      backend.setMark('BTCUSDT', '81400', 'spot');
      await backend.placeEntry({ symbol: 'BTCUSDT', market: 'spot', direction: 'long', qty: '0.002', entry: 'market', limit_price: null, client_order_id: 'optional-orphan' });
      await (rt as any).pollAccount();
      expect(rt.portfolioSnapshot?.unprotected_notional).toBe(0);
      expect(rt.portfolioSnapshot?.unprotected_symbols).toEqual([]);
      expect(rt.riskOpen.some(a => a.kind === 'protection_missing')).toBe(false);
      const stop = vi.spyOn(backend, 'placeStop');
      const t = await rt.adoptPosition('BTCUSDT', { market: 'spot', stop_price: null });
      expect(t).toMatchObject({ market: 'spot', stop_price: null, attention: null, status: 'in_position', protection_client_order_ids: [] });
      expect(t.protection_missing).not.toBe(true);
      expect(stop).not.toHaveBeenCalled();
    } finally { await cleanup(); }
  });

  it('现货显式止损仍挂保护,保护失败仍报 attention', async () => {
    const { rt, backend, store, cleanup } = await spotRuntime();
    try {
      const result = await rt.manualOrder({ symbol: 'BTCUSDT', market: 'spot', side: 'long', action: 'open', type: 'market', qty: '0.002', sl: '78000' });
      const original = (await backend.account()).open_orders.find(o => o.market === 'spot')!;
      expect(original).toMatchObject({ type: 'STOP_MARKET', stop_price: '78000' });
      await backend.cancelOrder('BTCUSDT', original.client_order_id, 'spot');
      vi.spyOn(backend, 'placeStop').mockResolvedValue({ outcome: 'failed', error: 'fake protection failed' });
      await (rt as any).pollAccount();
      expect(store.thread(result.thread!.id)).toMatchObject({ stop_price: '78000', attention: 'PROTECTION_MISSING', protection_missing: true });
      expect(rt.riskOpen.some(a => a.kind === 'protection_missing' || a.kind === 'thread_attention')).toBe(true);
    } finally { await cleanup(); }
  });

  it('null stop 提案按整笔名义风险定量,进入待批意图', async () => {
    const { rt, backend, store, cleanup } = await spotRuntime();
    try {
      rt.scan('BTCUSDT', T('prepare optional stop proposal')); await drained(rt);
      const ep = store.episode(store.episodes(10)[0]!.id)!;
      const j = proposeJudgment(81400); j.proposal!.market = 'spot'; j.proposal!.stop_price = null; j.proposal!.take_profit_price = null; j.proposal!.take_profits = [];
      const t = await (rt as any).openThreadFromProposal(ep, j, await backend.account(), rt.markets.get('BTCUSDT'), 'agent', { forceApproval: true });
      expect(t).toMatchObject({ market: 'spot', stop_price: null, status: 'pending_entry', leverage: 1 });
      expect(Number(t.qty) * 81400).toBeLessThanOrEqual(100);
      expect(Number(t.qty) * 81400).toBeGreaterThan(0);
      expect(store.intents(10).find(i => i.thread_id === t.id)).toMatchObject({ market: 'spot', status: 'pending_approval' });
      const intent = store.intents(10).find(i => i.thread_id === t.id)!;
      await rt.approveIntent(intent.id, rt.issueIntentConfirmation(intent.id).token.nonce);
      expect(store.thread(t.id)).toMatchObject({ status: 'in_position', stop_price: null, attention: null });
      expect((await backend.account()).open_orders).toEqual([]);
    } finally { await cleanup(); }
  });

  it('book 跟单保留 market_type spot,无止损也生成待批线程', async () => {
    const { rt, store, cleanup } = await spotRuntime();
    try {
      const result = await (rt as any).bookOpenFromSignal(
        { symbol: 'BTCUSDT', market_type: 'spot', side: 'long', trader: 'fake', action: 'open', signal_id: 'optional-stop', subscription_job_id: 'fake-job' },
        { ok: true, entry: 'limit', intent: 'limit', price: '81400', legs: [], stop: null, take_profits: [], unsupported: null, reason: 'fake spot signal' },
        { weight: { weight: 1 }, episode_id: null, approval: 'manual' });
      expect(result).toMatchObject({ outcome: 'opened' });
      expect(store.thread(result.thread_id)).toMatchObject({ market: 'spot', stop_price: null, status: 'pending_entry', source: 'trader' });
      expect(store.intents(10).find(i => i.thread_id === result.thread_id)).toMatchObject({ market: 'spot', status: 'pending_approval' });
    } finally { await cleanup(); }
  });
});
