import { describe, it, expect } from 'vitest';
import { openStateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { openShadowThread, settleShadowThread, shadowStatsOf } from '../../src/demo/strategy-loop.js';
import { summarizeReplay, DAY } from '../../src/demo/replay-stats.js';
import type { Kline } from '../../src/demo/types.js';

describe('P1b 反例', () => {
  it('P1-08 缺口与未闭合 K 线不能结算，策略 horizon 优先', () => {
    const db = openStateDb(':memory:'); const store = new DemoStore(db);
    try {
      const spec = store.strategies.head('breakout_retest')!;
      spec.params.horizon_bars = { value: 2, min: 1, max: 100 };
      const t = openShadowThread({ spec, symbol: 'BTCUSDT', timeframe: '15m', side: 'long', at: 899999, snapshot: { timeframe: '15m', last_close: 100, mark: 100, atr14: 2, swing_high_20: 110, swing_low_20: 90, ema20_1h: 100, ema50_1h: 99 } });
      expect(t.horizon_end_at).toBe(2699999);
      const bars: Kline[] = Array.from({ length: 48 }, (_, i) => ({ open_time: (i + 1) * 900000, close_time: (i + 2) * 900000 - 1, open: '100', high: '101', low: '99', close: '100', volume: '1' }));
      expect(settleShadowThread(t, [], 50000000).status).not.toBe('settled');
      expect(settleShadowThread(t, [bars[0]!, ...bars.slice(2)], 50000000).status).not.toBe('settled');
      expect(settleShadowThread(t, bars, 1800000).status).not.toBe('settled');
      expect(settleShadowThread(t, bars, 50000000).status).toBe('settled');
    } finally { db.close(); }
  });
  it('同 4h 桶的 40 币只有一个有效样本，OOS CI 不足', () => {
    const samples = Array.from({ length: 40 }, (_, i) => ({ at: 65 * DAY, exit_at: 65 * DAY + 1000, horizon_end_at: 66 * DAY, gross_r: 1, net_r: 0.9, regime: 'range' as const, symbol: `S${i}` }));
    const s = summarizeReplay(samples, [{ train_from: 0, train_to: 60 * DAY, test_from: 61 * DAY, test_to: 81 * DAY }], 1);
    expect(s.oos_n).toBe(1); expect(s.oos_ci.status).toBe('insufficient');
  });
  it('P1-09 人工确认不能绕过 live eval 样本门', () => {
    const db = openStateDb(':memory:'); const store = new DemoStore(db);
    try { const s = { ...store.strategies.head('breakout_retest')!, status: 'paper' as const }; expect(store.strategies.promoteGate(s, 'live_capped', { confirm: true })).toMatch(/30/); } finally { db.close(); }
  });
});

import { registerManifest, runExperiment } from '../../src/demo/strategy-lab.js';
import { BUILTIN_STRATEGIES, EMPTY_EVAL_STATS } from '../../src/demo/strategies.js';
import { equityDrawdown } from '../../src/demo/replay-stats.js';
import { runStrategyLoop } from '../../src/demo/strategy-loop.js';

describe('P1b 审计与版本隔离', () => {
  it('P1-10 加载失败 100% 必须报告覆盖率阻断与失败明细', async () => {
    const m = registerManifest({ strategies: [BUILTIN_STRATEGIES[0]!], symbols: ['A', 'B'], timeframe: '15m', days: 90, now: 100 * DAY });
    const r = await runExperiment(m, { specs: [BUILTIN_STRATEGIES[0]!], loadSeries: async () => { throw new Error('missing'); } });
    expect(r.errors).toHaveLength(2);
    expect(r.by_strategy).toEqual([]);
    expect(r.note).toMatch(/20%/);
  });
  it('权益回撤按并发仓位同刻估值合并，包含未平仓浮亏', () => {
    expect(equityDrawdown([
      { exit_at: 10, net_r: 1, equity_marks: [{ at: 5, r: -3 }] },
      { exit_at: 10, net_r: -1, equity_marks: [{ at: 5, r: 1 }] },
    ])).toBe(2);
  });
  it('P1-09 有效旧版本降级，draft head 不被写，backend 不串账', () => {
    const db = openStateDb(':memory:'); const store = new DemoStore(db);
    try {
      const old = store.strategies.resolve(['breakout_retest']).specs[0]!;
      expect(old).toBeDefined();
      (store.strategies as unknown as { write: (s: unknown) => void }).write({ ...old, health_by_backend: { paper: { status: 'paper', generation: 0, window_from: 0 }, agent_mcp: { status: 'paper', generation: 0, window_from: 0 } } });
      const head = store.strategies.head(old.id)!;
      const draft = store.strategies.createVersion(old.id, { params: { chase_atr_max: head.params.chase_atr_max!.value + 0.1 } }).spec!;
      const result = runStrategyLoop(store, { backend: 'paper', active_ids: [old.id], now: 1000, realizedR: (_id, version, backend) => version === old.version && backend === 'paper' ? Array(10).fill(-1) : [] });
      expect(result.actions[0]?.version).toBe(old.version);
      expect(store.strategies.head(old.id)!.version).toBe(draft.version);
      expect(store.strategies.resolve([old.id], { backend: 'paper' }).specs).toEqual([]);
      expect(store.strategies.resolve([old.id], { backend: 'agent_mcp' }).specs[0]?.version).toBe(old.version);
      const updated = store.strategies.version(old.id, old.version)!;
      expect(updated.shadow_generation).toBe(1);
      expect(updated.lab_stats?.shadow ?? null).toBeNull();
    } finally { db.close(); }
  });
  it('eval 精确 hash 写回旧版本，错误 hash 不更新 head', () => {
    const db = openStateDb(':memory:'); const store = new DemoStore(db);
    try {
      const old = store.strategies.head('breakout_retest')!;
      const draft = store.strategies.createVersion(old.id, { params: { chase_atr_max: old.params.chase_atr_max!.value + 0.1 } }).spec!;
      const stats = { ...EMPTY_EVAL_STATS, trades: 40, expectancy_r: 0.3 };
      expect(store.strategies.updateEvalStatsExact(old.id, old.version, 'wrong', stats)).toBeNull();
      store.strategies.updateEvalStatsExact(old.id, old.version, old.content_hash, stats);
      expect(store.strategies.version(old.id, old.version)!.eval_stats.trades).toBe(40);
      expect(store.strategies.version(old.id, draft.version)!.eval_stats.trades).toBe(0);
    } finally { db.close(); }
  });
});

import { sampleShadow } from '../../src/demo/shadow-scheduler.js';
import { tfToMs } from '../../src/demo/market.js';

describe('独立 shadow 调度', () => {
  it('不依赖 paper/model/council，自己的周期与 horizon，去重及缺口拒绝', async () => {
    const db = openStateDb(':memory:'); const store = new DemoStore(db);
    try {
      const spec = { ...store.strategies.head('mtf_alignment')!, status: 'shadow' as const };
      spec.params.horizon_bars = { value: 7, min: 1, max: 100 };
      (store.strategies as unknown as { write: (s: typeof spec) => void }).write(spec);
      const now = 400 * DAY;
      const fetchKlines = async (_symbol: string, tf: string, depth: number) => Array.from({ length: depth }, (_, i) => ({ open_time: now - (depth-i)*tfToMs(tf), close_time: now - (depth-i-1)*tfToMs(tf)-1, open: '100', high: '101', low: '99', close: '100', volume: '1' }));
      const signal = () => ({ at: now-1, direction: 'long' as const, entry: 'market' as const, reference_price: '100', atr: 1, stop_distance: '1', tp_r: 2, invalidation: [], coverage: 'ohlcv' as const });
      expect(await sampleShadow(store, { symbols: ['A'], now, backend: 'paper', fetchKlines, signal })).toBe(1);
      const t = store.shadowThreads.forVersion(spec.id, spec.version)[0]!;
      expect(t).toMatchObject({ timeframe: spec.trigger.min_timeframe, horizon_bars: 7, score_kind: 'full_strategy', episode_id: null });
      expect(t.horizon_end_at).toBe(now-1+7*tfToMs(spec.trigger.min_timeframe));
      expect(await sampleShadow(store, { symbols: ['A'], now, backend: 'paper', fetchKlines, signal })).toBe(0);
      expect(await sampleShadow(store, { symbols: ['B'], now, backend: 'paper', fetchKlines: async (...args) => (await fetchKlines(...args)).slice(0,-1), signal })).toBe(0);
      expect(store.threads({ limit: 20 })).toEqual([]);
    } finally { db.close(); }
  });
});

describe('重新验证与证据冻结', () => {
  it('新版本不继承旧版的 backend paper 资格', () => {
    const db = openStateDb(':memory:'); const store = new DemoStore(db);
    try {
      const h = store.strategies.head('mtf_alignment')!;
      (store.strategies as unknown as { write: (s: unknown) => void }).write({ ...h, health_by_backend: { paper: { status: 'paper', generation: 3, window_from: 100 } } });
      const v = store.strategies.createVersion(h.id, { params: { chase_atr_max: h.params.chase_atr_max!.value + 0.1 } }).spec!;
      expect(v.health_by_backend).toEqual({}); expect(v.shadow_generation).toBe(0);
      expect(store.strategies.resolve([h.id], { backend: 'paper' }).specs[0]?.version).toBe(h.version);
    } finally { db.close(); }
  });
  it('完整策略与方向代理分账，相关多币不能改变簇期望权重', () => {
    const db = openStateDb(':memory:'); const store = new DemoStore(db);
    try {
      const spec = store.strategies.head('mtf_alignment')!;
      const base = openShadowThread({ spec, symbol: 'A', timeframe: '1h', side: 'long', at: 0, snapshot: { timeframe: '1h', last_close: 100, mark: 100, atr14: 1, swing_high_20: 100, swing_low_20: 100, ema20_1h: null, ema50_1h: null } });
      const rows = Array.from({ length: 40 }, (_,i) => ({ ...base, id: `x${i}`, opened_at: 1, status: 'settled' as const, score_kind: 'full_strategy' as const, r: 1, net_r: 1 }));
      const s = shadowStatsOf([...rows, { ...rows[0]!, opened_at: 4*3600000, r: -1, net_r: -1 }, { ...rows[0]!, score_kind: 'direction_proxy', r: 99, net_r: 99 }]);
      expect(s.n).toBe(2); expect(s.net_expectancy_r).toBe(0);
      expect(s.direction_proxy?.n).toBe(1); expect(s.direction_proxy?.net_expectancy_r).toBe(99);
    } finally { db.close(); }
  });
});

import { BacktestManager, type BacktestRun } from '../../src/demo/backtest.js';
import { newThread } from '../../src/demo/threads.js';
import { realizedRFromThreads } from '../../src/demo/strategy-loop.js';

describe('eval 与真实结算拒绝旁路', () => {
  it('cancelled、capped 和未平仓 run 均不写精确版本成绩，完整 run 写回', () => {
    const db = openStateDb(':memory:'); const store = new DemoStore(db);
    try {
      const spec = store.strategies.head('mtf_alignment')!;
      const manager = new BacktestManager({ store, workflow: () => ({} as never), emit: () => {} });
      const run = { id: 'test', status: 'done', summary: { capped: false, strategies: [spec], by_strategy: { [spec.id]: { trades: 1, win_rate: 1, net: { expectancy_r: 1, total_r: 1 }, mae_r_p50: 0 } }, trade_rows: [{ strategy_id: spec.id, status: 'tp', fill_at: 1, exit_at: 2, net_r: 1 }] } } as unknown as BacktestRun;
      const record = (r: BacktestRun) => (manager as unknown as { recordEvalStats: (r: BacktestRun) => void }).recordEvalStats(r);
      record({ ...run, status: 'cancelled' });
      record({ ...run, summary: { ...run.summary!, capped: true } });
      record({ ...run, summary: { ...run.summary!, trade_rows: [{ ...run.summary!.trade_rows[0]!, status: 'open' }] } });
      expect(store.strategies.version(spec.id, spec.version)!.eval_stats.backtests).toBe(0);
      record({ ...run, summary: { ...run.summary!, trade_rows: [...run.summary!.trade_rows, { ...run.summary!.trade_rows[0]!, status: 'unfilled', fill_at: null, exit_at: null, net_r: null }] } });
      expect(store.strategies.version(spec.id, spec.version)!.eval_stats).toMatchObject({ trades: 1, expectancy_r: 1, backtests: 1 });
    } finally { db.close(); }
  });
  it('realizedR 只取同 version/backend 的 complete 净结算，排除旧窗口', () => {
    const db = openStateDb(':memory:'); const store = new DemoStore(db);
    try {
      const t = newThread({ id: 'complete', symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '15m', thesis: 'x', entry: { type: 'market', price: null, zone: null }, stop_price: '90', take_profits: [], qty: '1', margin_usdt: '100', leverage: 1, margin_mode: 'cross', now: 1 } as Parameters<typeof newThread>[0]);
      const row = { ...t, strategy_id: 'mtf_alignment', strategy_version: 1, backend: 'paper' as const, status: 'closed' as const, filled_avg_price: '100', closed_at: 100, settlement: { status: 'complete' as const, initial_risk_usdt: '10', at: 100, realized_pnl: '20', commission: '1', funding: '-1', net_pnl: '18', exit_price: '120', trades: 2, window: [1,100] as [number,number], source: 'exchange' as const } };
      store.saveThread(row);
      store.saveThread({ ...row, id: 'partial', settlement: { ...row.settlement, status: 'partial' } });
      store.saveThread({ ...row, id: 'other-version', strategy_version: 2 });
      store.saveThread({ ...row, id: 'other-backend', backend: 'agent_mcp' });
      expect(realizedRFromThreads(store, 'mtf_alignment', 1, 'paper')).toEqual([1.8]);
    } finally { db.close(); }
  });
});

describe('P1-10 覆盖率边界与内容身份', () => {
  it('20% 可保留观测、超过 20% 阻断；未选币原始内容也绑定 manifest', async () => {
    const spec = BUILTIN_STRATEGIES[0]!;
    const symbols = ['A','B','C','D','E'];
    const m = registerManifest({ strategies: [spec], symbols, timeframe: '15m', days: 90, now: 200*DAY });
    const load = (failed: string[], delta = 0) => async (symbol: string) => {
      if (failed.includes(symbol)) throw new Error('missing');
      const d1 = Array.from({ length: 150 }, (_,i) => ({ open_time: (50+i)*DAY, close_time: (51+i)*DAY-1, open: '100', high: '101', low: '99', close: '100', volume: String(symbol === 'E' ? 1+delta : 10) }));
      return { base: d1, h1: d1, h4: d1, d1, funding: [] };
    };
    const ok = await runExperiment(m, { specs: [spec], loadSeries: load(['A']), top_n: 1 });
    expect(ok.execution_manifest?.load_failure_ratio).toBe(0.2);
    expect(ok.note).not.toMatch(/阻断/);
    const blocked = await runExperiment(m, { specs: [spec], loadSeries: load(['A','B']), top_n: 1 });
    expect(blocked.note).toMatch(/20%/); expect(blocked.by_strategy).toEqual([]);
    const changed = await runExperiment(m, { specs: [spec], loadSeries: load(['A'], 1), top_n: 1 });
    expect(changed.execution_manifest?.symbols).toEqual(ok.execution_manifest?.symbols);
    expect(changed.manifest_hash).not.toBe(ok.manifest_hash);
    expect(ok.execution_manifest?.universe_details?.find(x => x.symbol === 'A')?.status).toBe('load_failed');
  });
});

import { settleShadowThreads } from '../../src/demo/strategy-loop.js';
import { strategyForBackend } from '../../src/demo/strategies.js';
describe('对抗复审反例', () => {
  it('paper 证据的人工晋升不能给另一 backend 发资格', () => {
    const db = openStateDb(':memory:'); const store = new DemoStore(db);
    try {
      const h = store.strategies.head('mtf_alignment')!;
      const sh = { n: 30, win_rate: 0.6, expectancy_r: 0.3, total_r: 9, max_drawdown_r: 1, first_at: 1, last_at: 2, net_expectancy_r: 0.3, net_max_drawdown_r: 1 };
      (store.strategies as unknown as { write: (s: unknown) => void }).write({ ...h, status: 'shadow', lab_stats: { shadow: sh, shadow_by_backend: { paper: sh }, oos_net_expectancy: 0.3 } });
      expect(store.strategies.promote(h.id, 'paper', { backend: 'paper' }).error).toBeNull();
      expect(store.strategies.resolve([h.id], { backend: 'agent_mcp' }).specs).toEqual([]);
      expect(strategyForBackend(store.strategies.head(h.id)!, 'paper').status).toBe('paper');
    } finally { db.close(); }
  });
  it('缺口退避让后续完整线程得到结算机会', async () => {
    const db = openStateDb(':memory:'); const store = new DemoStore(db);
    try {
      const spec = store.strategies.head('mtf_alignment')!;
      spec.params.horizon_bars = { value: 2, min: 1, max: 100 };
      for (const [i,symbol] of ['GAP','GOOD'].entries()) store.shadowThreads.save(openShadowThread({ spec, symbol, timeframe: '15m', side: 'long', at: (i+1)*900000-1, snapshot: { timeframe: '15m', last_close: 100, mark: 100, atr14: 1, swing_high_20: 100, swing_low_20: 100, ema20_1h: null, ema50_1h: null } }));
      const seen: string[] = [];
      const deps = { now: 10*900000, limit: 1, fetchKlines: async (symbol: string) => { seen.push(symbol); return symbol === 'GAP' ? [] : Array.from({ length: 2 }, (_,i) => ({ open_time: (i+2)*900000, close_time: (i+3)*900000-1, open: '100', high: '101', low: '99', close: '100', volume: '1' })); } };
      await settleShadowThreads(store, deps); await settleShadowThreads(store, deps);
      expect(seen).toEqual(['GAP','GOOD']);
      expect(store.shadowThreads.forVersion(spec.id, spec.version).find(t => t.symbol === 'GOOD')?.status).toBe('settled');
    } finally { db.close(); }
  });
});

import { vi } from 'vitest';
import * as shadowScheduler from '../../src/demo/shadow-scheduler.js';
import { DemoRuntime } from '../../src/demo/runtime.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { stubBrain } from '../../src/demo/brain.js';
describe('shadow 生命周期', () => {
  it('stop 等待在途任务并阻止继续写入，同一时刻只有一个调度', async () => {
    const db = openStateDb(':memory:'); const store = new DemoStore(db);
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(shadowScheduler, 'sampleShadow').mockImplementation(async (_store, deps) => { await wait; expect(deps.shouldStop?.()).toBe(true); return 0; });
    const rt = new DemoRuntime({ store, backend: new PaperBackend(10000), brains: { stub: stubBrain(() => { throw new Error('shadow 不得用模型'); }) } });
    try {
      const running = rt.shadowTick();
      expect(rt.shadowTick()).toBe(running);
      const stopping = rt.stop(); let stopped = false; void stopping.then(() => { stopped = true; });
      await Promise.resolve(); expect(stopped).toBe(false);
      release(); await stopping; await running;
      expect(spy).toHaveBeenCalledTimes(1);
      await rt.shadowTick(); expect(spy).toHaveBeenCalledTimes(1);
    } finally { release(); await rt.stop(); spy.mockRestore(); db.close(); }
  });
});

it('入选币加载失败率不被未入选候选稀释', async () => {
  const spec = { ...BUILTIN_STRATEGIES[0]!, trigger: { ...BUILTIN_STRATEGIES[0]!.trigger, min_timeframe: '1h' } };
  const symbols = Array.from({length:10},(_,i) => `S${i}`);
  const m = registerManifest({ strategies: [spec], symbols: symbols.slice(0,2), timeframe: '15m', days: 90, now: 200*DAY });
  const r = await runExperiment(m, { specs: [spec], universe_candidates: symbols, top_n: 2, loadSeries: async (symbol, tf) => {
    if (symbol === 'S0' && tf === '1h') throw new Error('selected tf failed');
    const d1 = Array.from({length:150},(_,i) => ({ open_time:(50+i)*DAY, close_time:(51+i)*DAY-1, open:'100', high:'101', low:'99', close:'100', volume: String(100-Number(symbol.slice(1))) }));
    return { base:d1, h1:d1, h4:d1, d1, funding:[] };
  } });
  expect(r.execution_manifest?.load_failure_ratio).toBe(0.1);
  expect(r.execution_manifest?.selected_load_failure_ratio).toBe(0.5);
  expect(r.by_strategy).toEqual([]); expect(r.note).toMatch(/20%/);
});

it('每周定时 Lab 只观测固定版本，不重测候选参数择优', async () => {
  const db = openStateDb(':memory:'); const store = new DemoStore(db);
  let probeCount = -1; let extras: unknown;
  const rt = new DemoRuntime({ store, backend: new PaperBackend(10000), brains: { stub: stubBrain(() => '{}') }, team: { runExperiment: async (m, deps) => { probeCount = deps.probe?.size ?? 0; extras = deps.probe_values; return { manifest_hash: m.manifest_hash, by_strategy: [], cells: [], errors: [], unmeasured: [], note: '' }; } } });
  try {
    store.labProbes.enqueue({ strategy_id: 'mtf_alignment', param: 'chase_atr_max', value: 1.25, source: 'human' });
    await rt.team.runLab('timer');
    expect(probeCount).toBe(0); expect(extras).toBeUndefined(); expect(store.labProbes.queued()).toHaveLength(1);
  } finally { await rt.stop(); db.close(); }
});

it('backend 降级后 Lab 可恢复旧 effective 版本到 shadow，并从新代际重新观察', async () => {
  const db = openStateDb(':memory:'); const store = new DemoStore(db);
  const rt = new DemoRuntime({ store, backend: new PaperBackend(10000), brains: { stub: stubBrain(() => '{}') } });
  try {
    const old = store.strategies.resolve(['breakout_retest']).specs[0]!;
    store.strategies.demote(old.id, 'backtest', { version: old.version, backend: 'paper', now: 100 });
    const replay = { oos_n: 40, oos_net_expectancy: 0.2, oos_ci: { status: 'sufficient', lower: 0.05, upper: 0.3, iterations: 2000, block_size: 7 }, dsr: 0.1, max_dd_r: 1, regime: { trend: { n: 20, net_expectancy: 0.2 }, range: { n: 20, net_expectancy: 0.2 } } };
    (rt.team as unknown as { labAutopilot: (id: string, result: unknown, now: number) => unknown }).labAutopilot('fresh', { by_strategy: [{ strategy_id: old.id, version: old.version, symbols: 2, setups: 40, n: 40, win_rate: 0.5, expectancy_r: 0.2, total_r: 8, replay }], probes: [] }, 200);
    const current = store.strategies.version(old.id, old.version)!;
    expect(strategyForBackend(current, 'paper').status).toBe('shadow');
    expect(current.health_by_backend?.paper).toMatchObject({ generation: 1, window_from: 100 });
    expect(current.lab_stats?.shadow_by_backend?.paper?.n ?? 0).toBe(0);
  } finally { await rt.stop(); db.close(); }
});
