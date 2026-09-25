// Strategy Lab(strategy-lab.ts)+ Gate Captain(captain.ts)+ 编排(team-agents.ts)。零模型、零网络(K 线用合成序列注入)。
import { afterEach, describe, expect, it } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { DemoRuntime } from '../../src/demo/runtime.js';
import { stubBrain } from '../../src/demo/brain.js';
import { registerManifest, runExperiment, rungFor, LAB_MIN_NEW_CLOSED } from '../../src/demo/strategy-lab.js';
import { buildDailyBrief, briefDue } from '../../src/demo/captain.js';
import { presenceFor } from '../../src/demo/routes-bots.js';
import { newThread } from '../../src/demo/threads.js';
import type { Kline, StrategyThread } from '../../src/demo/types.js';
import type { SeriesBundle } from '../../src/demo/funnel.js';

const NOW = 1_788_800_000_000;

/** 压缩→放量突破→延续的合成 15m 序列(和 screener 测试同款思路),配 1h/4h/1d 聚合。 */
function synthBars(n: number, tf: number, start: number): Kline[] {
  const out: Kline[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const phase = i % 60;
    const drift = phase < 40 ? 0 : phase === 40 ? 3 : 0.4;
    const o = px;
    const c = px + drift + (phase < 40 ? (i % 2 ? 0.1 : -0.1) : 0);
    const h = Math.max(o, c) + (phase < 40 ? 0.15 : 0.6);
    const l = Math.min(o, c) - (phase < 40 ? 0.15 : 0.3);
    out.push({ open_time: start + i * tf, open: String(o), high: String(h), low: String(l), close: String(c), volume: String(phase === 40 ? 5000 : 1000), close_time: start + (i + 1) * tf - 1 } as unknown as Kline);
    px = c;
  }
  return out;
}
function series(from: number, to: number): SeriesBundle {
  const m15 = 15 * 60_000;
  return { base: synthBars(Math.ceil((to - from) / m15) + 60, m15, from - 60 * m15), h1: synthBars(Math.ceil((to - from) / 3_600_000) + 120, 3_600_000, from - 120 * 3_600_000), h4: synthBars(Math.ceil((to - from) / 14_400_000) + 80, 14_400_000, from - 80 * 14_400_000), d1: synthBars(Math.ceil((to - from) / 86_400_000) + 300, 86_400_000, from - 300 * 86_400_000), funding: [] } as unknown as SeriesBundle;
}

function closedThread(id: string, closedAt: number): StrategyThread {
  const t = newThread({ id, symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '15m', thesis: 't', invalidation_text: null, watch_conditions: [], entry: { type: 'market', price: null, zone: null }, stop_price: '99000', take_profits: ['102000'], qty: '0.1', margin_usdt: '2000', leverage: 5, margin_mode: 'cross', now: closedAt - 3_600_000 } as Parameters<typeof newThread>[0]);
  return { ...t, status: 'closed', opened_at: closedAt - 3_600_000, closed_at: closedAt, updated_at: closedAt, filled_avg_price: '100000', exit_price: '101500', realized_pnl: '150', close_reason: '止盈触发', protection_client_order_ids: ['sl'], version: 3 };
}

describe('strategy-lab pure', () => {
  let state: StateDb;
  afterEach(() => state?.close());
  it('manifest hash is deterministic within a day and changes with the strategy set; experiment runs every version as a variant', async () => {
    state = openStateDb(':memory:');
    const store = new DemoStore(state);
    const specs = store.strategies.list().flatMap((s) => store.strategies.versions(s.id));
    const a = registerManifest({ strategies: specs, symbols: ['BTCUSDT', 'ETHUSDT'], timeframe: '15m', days: 30, now: NOW });
    const b = registerManifest({ strategies: [...specs].reverse(), symbols: ['ETHUSDT', 'BTCUSDT'], timeframe: '15m', days: 30, now: NOW + 3_600_000 });
    expect(a.manifest_hash).toBe(b.manifest_hash);
    expect(registerManifest({ strategies: specs.slice(1), symbols: ['BTCUSDT', 'ETHUSDT'], timeframe: '15m', days: 30, now: NOW }).manifest_hash).not.toBe(a.manifest_hash);
    expect(a.strategies.length).toBeGreaterThanOrEqual(6); // 5 builtins + breakout_retest v2
    expect(rungFor(specs[0]!).patch.breakout_level).toBe('prior');
    const loads: string[] = [];
    const r = await runExperiment(a, { specs, loadSeries: async (sym, _tf, from, to) => { loads.push(sym); return series(from, to); } });
    expect(loads.filter(s => s === 'BTCUSDT')).toHaveLength(new Set(['15m', ...specs.map(s => s.trigger.min_timeframe)]).size);
    expect(r.unmeasured).toEqual([]);
    const measurable = a.strategies.length - r.unmeasured.length;
    expect(r.cells.length).toBe(measurable * 2);
    expect(r.by_strategy.length).toBe(measurable);
    expect(r.by_strategy.every((s) => s.symbols === 2)).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.note).toMatch(/不等于/);
  });
  it('执行 hash 绑定候选集和 trial 快照，版本 hash 不符拒绝', async () => {
    state = openStateDb(':memory:'); const store = new DemoStore(state);
    const spec = store.strategies.head('breakout_retest')!;
    const m = registerManifest({ strategies: [spec], symbols: ['BTCUSDT'], timeframe: '15m', days: 90, now: NOW });
    const loadSeries = async () => ({ base: [], h1: [], h4: [], d1: [], funding: [] });
    const a = await runExperiment(m, { specs: [spec], loadSeries, record_trials: () => 1 });
    const b = await runExperiment(m, { specs: [spec], loadSeries, record_trials: () => 9 });
    const c = await runExperiment(m, { specs: [spec], loadSeries, record_trials: () => 1, probe: new Set([`${spec.id}@${spec.version}`]) });
    expect(a.manifest_hash).not.toBe(b.manifest_hash); expect(a.manifest_hash).not.toBe(c.manifest_hash);
    const mismatch = await runExperiment(m, { specs: [{ ...spec, content_hash: 'different' }], loadSeries });
    expect(mismatch.unmeasured[0]!.reason).toContain('content_hash');
  });

});

describe('captain pure', () => {
  it('daily brief numbers come straight from the ledger; briefDue is once per local day', () => {
    const state = openStateDb(':memory:');
    const store = new DemoStore(state);
    store.bots.finishRun(store.bots.startRun({ id: 'r1', role: 'radar', routine: 'screen:short', started_at: NOW - 1000, budget: {} }).id, { status: 'done', cost_cny: 0.007, finished_at: NOW });
    store.bots.finishRun(store.bots.startRun({ id: 'r2', role: 'reviewer', routine: 'trade_card', started_at: NOW - 1000, budget: {} }).id, { status: 'failed', error: 'x', finished_at: NOW });
    store.bots.startRun({ id: 'r0', role: 'radar', routine: 'screen:short', started_at: NOW - 2 * 86_400_000, budget: {} }); // outside 24h
    store.bots.handoff({ handoff_id: 'h1', run_id: 'r1', from_role: 'radar', to_role: 'gate_captain', kind: 'result', subject: { type: 'screen', id: 's' }, summary: 's', evidence_refs: [], artifact_refs: [], requested_output_schema: null, priority: 1, deadline_at: null, idempotency_key: 'k1', payload: null });
    const b = buildDailyBrief({ bots: store.bots, alerts: [], level: 'none', snapshot: null, cards: [], now: NOW });
    expect(b.runs_by_role).toEqual({ radar: { runs: 1, done: 1, failed: 0, skipped: 0, cost_cny: 0.007 }, reviewer: { runs: 1, done: 0, failed: 1, skipped: 0, cost_cny: 0 } });
    expect(b.total_cost_cny).toBe(0.007);
    expect(b.pending_handoffs).toEqual({ count: 1, by_from: { radar: 1 } });
    expect(b.headline).toMatch(/2 次角色任务.*1 条待阅.*风控无告警.*无平仓.*无账户快照/);
    const brief = store.bots.startRun({ id: 'b1', role: 'gate_captain', routine: 'daily_brief', started_at: NOW, budget: {} });
    expect(briefDue(brief, NOW + 60_000)).toBe(false);
    expect(briefDue(brief, NOW + 86_400_000)).toBe(true);
    expect(briefDue(null, NOW)).toBe(true);
    state.close();
  });
});

describe('TeamAgents wiring', () => {
  let rt: DemoRuntime | null = null;
  let state: StateDb | null = null;
  afterEach(async () => {
    if (rt) await rt.stop();
    state?.close();
    rt = null;
    state = null;
  });
  it('all eight roles enabled; lab runs once (dedup within 24h), books run + handoff, decision flips on new closes; brief once per day', async () => {
    state = openStateDb(':memory:');
    const store = new DemoStore(state);
    expect(store.bots.profiles().every((b) => b.enabled)).toBe(true);
    let runs = 0;
    rt = new DemoRuntime({
      store,
      backend: new PaperBackend(10_000),
      brains: { stub: stubBrain(() => '{}') },
      marketPollMs: 600_000,
      accountPollMs: 600_000,
      radar: { runScreen: async () => { throw new Error('no'); } },
      team: { runExperiment: async (m) => { runs++; return { manifest_hash: m.manifest_hash, unmeasured: [], cells: [], by_strategy: [{ strategy_id: 'breakout_retest', version: 1, symbols: 6, setups: 12, n: 10, win_rate: 0.4, expectancy_r: -0.02, total_r: -0.2 }], errors: [], note: 'n' }; } },
    });
    expect(rt.team.labDecision()).toMatchObject({ run: true, reason: '从没跑过实验' });
    expect(presenceFor('strategy_lab', rt, true).state).toBe('waiting');
    const first = await rt.team.runLab('manual');
    expect(runs).toBe(1);
    expect(first.skipped).toBeNull();
    const again = await rt.team.runLab('manual');
    expect(runs).toBe(1);
    expect(again.skipped).toMatch(/24h/);
    expect(again.run_id).toBe(first.run_id);
    expect(store.bots.runs({ role: 'strategy_lab' })).toHaveLength(1);
    expect(store.bots.runs({ role: 'strategy_lab' })[0]!.input?.['manifest_hash']).toBe(first.manifest.manifest_hash);
    expect(store.bots.handoffs({ to_role: 'gate_captain' }).map((h) => h.subject.type)).toEqual(['strategy_experiment']);
    expect(rt.team.labDecision().run).toBe(false);
    expect(presenceFor('strategy_lab', rt, true).state).toBe('idle');
    for (let i = 0; i < LAB_MIN_NEW_CLOSED; i++) store.saveThread(closedThread(`thr-${i}`, Date.now() + 1000 + i));
    expect(rt.team.labDecision()).toMatchObject({ run: true, new_closed: LAB_MIN_NEW_CLOSED });
    // brief
    expect(rt.team.briefDue()).toBe(true);
    const b = rt.team.brief('manual');
    expect(b.runs_by_role['strategy_lab']).toMatchObject({ runs: 1, done: 1 });
    expect(b.pending_handoffs.count).toBe(1);
    expect(rt.team.briefDue()).toBe(false);
    expect(rt.team.latestBrief()?.headline).toBe(b.headline);
    expect(store.activity(5).some((a) => a.kind === 'brief')).toBe(true);
    expect(presenceFor('gate_captain', rt, true)).toMatchObject({ state: 'waiting', action: '1 条交接待阅' });
  });

  it('lab autopilot (09-07): writes lab_stats per exact version, proposes a draft from a clearly better probe (deduped), auto-promotes draft→backtest→shadow, never touches paper+', async () => {
    state = openStateDb(':memory:');
    const store = new DemoStore(state);
    rt = new DemoRuntime({ store, backend: new PaperBackend(10_000), brains: { stub: stubBrain(() => '{}') }, marketPollMs: 600_000, accountPollMs: 600_000, radar: { runScreen: async () => { throw new Error('no'); } } });
    const lib = store.strategies;
    const paperHead = lib.head('breakout_retest')!; // 种子 head(seed 时晋到 backtest);这里只当「原 head」用
    const originalStatus = paperHead.status;
    // 一个 draft 版本作为 head(人工拨过参数的那种)
    const v = lib.createVersion('breakout_retest', { params: { chase_atr_max: paperHead.params['chase_atr_max']!.value + 0.25 } }, { now: NOW }).spec!;
    expect(v.status).toBe('draft');
    const probeVal = Math.round((v.params['retest_vol_min']!.value + 0.2) * 100) / 100;
    const result = {
      manifest_hash: 'm1', unmeasured: [], cells: [], errors: [], note: '',
      by_strategy: [
        { strategy_id: 'breakout_retest', version: v.version, symbols: 6, setups: 60, n: 40, win_rate: 0.45, expectancy_r: 0.3, total_r: 12 },
        { strategy_id: 'breakout_retest', version: paperHead.version, symbols: 6, setups: 50, n: 35, win_rate: 0.4, expectancy_r: 0.1, total_r: 3.5 },
      ],
      probes: [
        { strategy_id: 'breakout_retest', version: v.version, param: 'retest_vol_min', value: probeVal, selected_folds: 1, replay: { oos_n: 36, dsr: 0.2, oos_ci: { status: 'sufficient' as const, lower: 0.1, upper: 0.7, iterations: 2000, block_size: 6 } }, symbols: 6, setups: 50, n: 36, win_rate: 0.5, expectancy_r: 0.6, total_r: 21.6 },
        { strategy_id: 'breakout_retest', version: v.version, param: 'chase_atr_max', value: 1, symbols: 6, setups: 20, n: 12, win_rate: 0.9, expectancy_r: 2, total_r: 24 }, // 样本不够,不许提
      ],
    };
    const actions = (rt.team as unknown as { labAutopilot: (id: string, r: typeof result, now: number) => string[] }).labAutopilot('run-1', result, NOW);
    // 1. lab_stats 按精确版本写回(paper 那版也写,但状态不动)
    expect(lib.version('breakout_retest', v.version)!.lab_stats).toMatchObject({ run_id: 'run-1', n: 40, expectancy_r: 0.3 });
    expect(lib.version('breakout_retest', paperHead.version)!.lab_stats).toMatchObject({ n: 35 });
    expect(lib.version('breakout_retest', paperHead.version)!.status).toBe(originalStatus);
    // 2. 探针 → 新 draft(retest_vol_min 拨一档),样本不够的 chase_atr_max 没被提
    const head = lib.head('breakout_retest')!;
    expect(head.version).toBe(v.version + 1);
    expect(head.params['retest_vol_min']!.value).toBe(probeVal);
    expect(head.parent_version).toBe(v.version);
    expect(actions.some((a) => a.startsWith('提案 breakout_retest'))).toBe(true);
    expect(store.bots.handoffs({ to_role: 'gate_captain' }).some((h) => h.subject.type === 'strategy_version')).toBe(true);
    // 3. 数据态晋升:v(draft,有 lab_stats)→ backtest 在 head 变成 v+1 之前已经不是 head 了,所以不动;新 head(v+1,draft,无 lab_stats)保持 draft
    expect(head.status).toBe('draft');
    expect(lib.version('breakout_retest', v.version)!.status).toBe('draft');
    // 再跑一次同样结果:同内容不重复提;新 head(v+1)拿到 lab_stats 后 draft → backtest
    const result2 = { ...result, by_strategy: [{ strategy_id: 'breakout_retest', version: head.version, symbols: 6, setups: 60, n: 40, win_rate: 0.5, expectancy_r: 0.6, total_r: 24 }], probes: [] };
    const actions2 = (rt.team as unknown as { labAutopilot: (id: string, r: typeof result2, now: number) => string[] }).labAutopilot('run-2', result2, NOW + 1);
    expect(lib.head('breakout_retest')!.version).toBe(head.version);
    expect(lib.head('breakout_retest')!.status).toBe('backtest');
    expect(actions2.some((a) => a.includes('draft → backtest'))).toBe(true);
    // 第三次:backtest + lab n≥20 期望>0 → shadow;再往上(paper)不自动
    const actions3 = (rt.team as unknown as { labAutopilot: (id: string, r: typeof result2, now: number) => string[] }).labAutopilot('run-3', result2, NOW + 2);
    expect(lib.head('breakout_retest')!.status).toBe('backtest');
    expect(actions3.some((a) => a.includes('backtest → shadow'))).toBe(false); // 旧毛收益报告不能通过新门
    const actions4 = (rt.team as unknown as { labAutopilot: (id: string, r: typeof result2, now: number) => string[] }).labAutopilot('run-4', result2, NOW + 3);
    expect(lib.head('breakout_retest')!.status).toBe('backtest');
    expect(actions4.some((a) => a.includes('→ paper'))).toBe(false);
    // 关掉 autopilot 的开关是 workflow 字段
    expect(rt.setWorkflow({ lab_autopilot: false }).errors).toEqual([]);
    expect(rt.workflow.lab_autopilot).toBe(false);
  });
});
