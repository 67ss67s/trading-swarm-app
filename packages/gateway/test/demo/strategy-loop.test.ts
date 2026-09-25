const VERIFIED_OOS = { oos_n: 40, oos_net_expectancy: 0.2, oos_ci: { status: 'sufficient' as const, lower: 0.05, upper: 0.3, iterations: 2000, block_size: 7 }, dsr: 0.1, max_dd_r: 1, regime: { trend: { n: 20, net_expectancy: 0.2 }, range: { n: 20, net_expectancy: 0.2 } } };
// 策略闭环 v2(strategy-loop.ts / strategy-hypothesis.ts / evidence-plan.ts + 切换校验)。
// 设计:docs/design/strategy-loop-v2-and-events-2026-09-12.md §1/§2/§4;契约 §9.27/§9.28。
// 全程内存库 + 合成 K 线,零模型、零网络。

import { afterEach, describe, expect, it } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { DemoRuntime } from '../../src/demo/runtime.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { stubBrain } from '../../src/demo/brain.js';
import { newThread } from '../../src/demo/threads.js';
import { buildContext } from '../../src/demo/context.js';
import { tfFeatures } from '../../src/demo/market.js';
import { consensus, DEFAULT_COUNCIL_POLICY, runCouncil, type StrategyVerdict } from '../../src/demo/strategy-council.js';
import { evidencePlan, renderIndicator } from '../../src/demo/evidence-plan.js';
import { parseHypotheses } from '../../src/demo/strategy-hypothesis.js';
import {
  DEGRADE_LOSS_STREAK,
  DEGRADE_WINDOW,
  degradeDecision,
  openShadowThread,
  realizedRFromThreads,
  runStrategyLoop,
  settleShadowThreads,
  settleShadowThread,
  shadowStatsOf,
  SHADOW_HORIZON_BARS,
} from '../../src/demo/strategy-loop.js';
import {
  DEFAULT_EVIDENCE,
  evidenceOf,
  shadowToPaperGate,
  strategyContentHash,
  strategyWakes,
  wakeKindsOf,
  type ShadowStats,
  type StrategySpec,
} from '../../src/demo/strategies.js';
import type { AccountView, Kline, MarketView, StrategyThread } from '../../src/demo/types.js';

const NOW = Math.floor(1_789_000_000_000 / 900000) * 900000;
const M15 = 15 * 60_000;

function fresh(): { state: StateDb; store: DemoStore } {
  const state = openStateDb(':memory:');
  return { state, store: new DemoStore(state) };
}

/** 单调上行的 15m 序列:做多必然吃到 1.5R 止盈,做空必然吃到止损。 */
function upBars(n: number, start: number, from = 100, step = 0.5): Kline[] {
  const out: Kline[] = [];
  let px = from;
  for (let i = 0; i < n; i++) {
    const o = px;
    const c = px + step;
    out.push({ open_time: start + i * M15, open: String(o), high: String(c + 0.1), low: String(o - 0.05), close: String(c), volume: '1000', close_time: start + (i + 1) * M15 - 1 } as unknown as Kline);
    px = c;
  }
  return out;
}

/**
 * 把一条策略推到 paper(走真正的门,不绕过):补 Lab 漏斗数据 → shadow,再补影子数据 → paper。
 * DemoStore 构造时会给 breakout_retest 建一个停在 backtest 的 v2 草稿当 head,所以「现成的 paper head」
 * 并不存在,测降级必须先自己把 head 推上去。
 */
function toPaper(store: DemoStore, id: string): StrategySpec {
  const lib = store.strategies;
  let head = lib.head(id)!;
  if (head.status === 'draft') head = lib.promote(id, 'backtest').spec ?? head;
  lib.updateLabStats(id, head.version, { ...VERIFIED_OOS, run_id: 'r', at: NOW, symbols: 2, setups: 40, n: 30, win_rate: 0.5, expectancy_r: 0.2, total_r: 6, note: '' });
  head = lib.promote(id, 'shadow').spec ?? lib.head(id)!;
  lib.updateShadowStats(id, head.version, { net_expectancy_r: 0.22, net_max_drawdown_r: 1, n: 25, win_rate: 0.55, expectancy_r: 0.22, total_r: 5.5, max_drawdown_r: 0.9, first_at: NOW, last_at: NOW });
  return lib.promote(id, 'paper').spec ?? lib.head(id)!;
}

const SNAP = { timeframe: '15m', last_close: 100, mark: 100, atr14: 1, swing_high_20: 100.5, swing_low_20: 99.5, ema20_1h: 100, ema50_1h: 99 };

// ---------------------------------------------------------------- 门

describe('闭环 v2 · 晋升与降级的门', () => {
  const withShadow = (s: Partial<ShadowStats>, lab?: number | null): StrategySpec => {
    const shadow = { n: 25, win_rate: 0.5, expectancy_r: 0.2, total_r: 5, max_drawdown_r: 1, first_at: NOW, last_at: NOW, net_expectancy_r: s.expectancy_r ?? 0.2, net_max_drawdown_r: s.max_drawdown_r ?? 1, ...s };
    return { family: 'trend_continuation', lab_stats: { ...VERIFIED_OOS, oos_net_expectancy: lab === undefined ? 0.2 : lab, run_id: 'r', at: NOW, symbols: 1, setups: 1, n: 30, win_rate: 0.5, expectancy_r: lab === undefined ? 0.2 : lab, total_r: 6, note: '', shadow } } as unknown as StrategySpec;
  };

  it('shadow→paper 四条门各自拦得住:笔数 / 期望 / 与 Lab 的差 / 回撤', () => {
    expect(shadowToPaperGate(withShadow({}))).toBeNull();
    expect(shadowToPaperGate({ lab_stats: null } as unknown as StrategySpec)).toMatch(/还没有影子实盘数据/);
    expect(shadowToPaperGate(withShadow({ n: 19 }))).toMatch(/不足 20 笔/);
    expect(shadowToPaperGate(withShadow({ expectancy_r: 0.05 }))).toMatch(/0\.05R < 0\.1R/);
    expect(shadowToPaperGate(withShadow({ max_drawdown_r: 3.5 }))).toMatch(/最大回撤.*3\.50R > 3R/);
    // 与 Lab 期望差 0.4R > 0.3R
    expect(shadowToPaperGate(withShadow({ expectancy_r: 0.6 }, 0.2))).toMatch(/两套口径不一致/);
    // Lab 没有数字时不因为「没对照面」把门焊死
    expect(shadowToPaperGate(withShadow({ expectancy_r: 0.6 }, null))).toMatch(/缺 Lab OOS/);
  });

  it('promoteGate:影子数据够格就能自动过 paper 门;不够格时仍要回放期望为正', () => {
    const { state, store } = fresh();
    try {
      const lib = store.strategies;
      const head = lib.head('mtf_alignment')!;
      lib.updateShadowStats(head.id, head.version, { net_expectancy_r: 0.22, net_max_drawdown_r: 1, n: 25, win_rate: 0.5, expectancy_r: 0.2, total_r: 5, max_drawdown_r: 1, first_at: NOW, last_at: NOW });
      const withData = lib.head(head.id)!;
      // 没有影子数据、也没有回放期望 → 拦
      const bare = { ...head, status: 'shadow' as const };
      expect(lib.promoteGate(bare, 'paper')).toMatch(/影子实盘/);
      expect(lib.promoteGate({ ...withData, status: 'shadow' }, 'paper')).toMatch(/缺 Lab OOS/);
    } finally {
      state.close();
    }
  });

  it('degradeDecision:最近 30 笔期望 < −0.1R 或连亏 10 笔才降级,样本不足只看连亏', () => {
    expect(degradeDecision([]).degrade).toBe(false);
    expect(degradeDecision(Array(5).fill(-1)).degrade).toBe(false); // 连亏 5 笔:不够
    expect(degradeDecision(Array(DEGRADE_LOSS_STREAK).fill(-1))).toMatchObject({ degrade: true, loss_streak: DEGRADE_LOSS_STREAK });
    // 连亏被一笔赢打断就不算
    expect(degradeDecision([...Array(9).fill(-1), 1]).degrade).toBe(false);
    // 30 笔期望 −0.2R → 降级
    expect(degradeDecision(Array(DEGRADE_WINDOW).fill(-0.2))).toMatchObject({ degrade: true, expectancy_r: -0.2 });
    // 30 笔期望 −0.05R(高于门槛)、且没有连亏 → 不降级
    expect(degradeDecision(Array.from({ length: DEGRADE_WINDOW }, (_, i) => (i % 2 ? -0.15 : 0.05)))).toMatchObject({ degrade: false, expectancy_r: -0.05 });
    // 只看最近 30 笔:更早的大赢不能救它
    expect(degradeDecision([...Array(50).fill(3), ...Array(DEGRADE_WINDOW).fill(-0.5)]).degrade).toBe(true);
  });

  it('降级是退回 backtest 而不是 retired,并落一行台账 + 要求移出启用列表', () => {
    const { state, store } = fresh();
    try {
      const lib = store.strategies;
      toPaper(store, 'breakout_retest');
      expect(lib.head('breakout_retest')!.status).toBe('paper');
      const r = runStrategyLoop(store, { now: NOW, realizedR: (id) => (id === 'breakout_retest' ? Array(DEGRADE_LOSS_STREAK).fill(-1) : []) });
      expect(r.actions).toHaveLength(1);
      expect(r.actions[0]).toMatchObject({ strategy_id: 'breakout_retest', kind: 'demote', from: 'paper', to: 'backtest' });
      expect(r.deactivate).toEqual(['breakout_retest']);
      expect(lib.head('breakout_retest')!.status).toBe('backtest'); // **不是** retired
      const tl = store.strategyEvents.timeline('breakout_retest').filter(e => e.kind !== 'gate_check');
      expect(tl).toHaveLength(1);
      expect(tl[0]).toMatchObject({ who: 'code', kind: 'demote', from_status: 'paper', to_status: 'backtest' });
      expect(tl[0]!.evidence['loss_streak']).toBe(DEGRADE_LOSS_STREAK);
      expect(lib.head('breakout_retest')!.status).not.toBe('retired');
      // demote 只能往回走,不能当晋升后门
      expect(lib.demote('breakout_retest', 'paper').error).toMatch(/不能「降级」/);
    } finally {
      state.close();
    }
  });

  it('影子数据够格时状态机自动把 shadow 推到 paper,并记下用到的数字', () => {
    const { state, store } = fresh();
    try {
      const lib = store.strategies;
      const head = lib.head('mtf_alignment')!;
      lib.promote(head.id, 'backtest');
      lib.updateLabStats(head.id, head.version, { ...VERIFIED_OOS, run_id: 'r', at: NOW, symbols: 2, setups: 40, n: 30, win_rate: 0.5, expectancy_r: 0.2, total_r: 6, note: '' });
      lib.promote(head.id, 'shadow');
      expect(lib.head(head.id)!.status).toBe('shadow');
      // 影子还没数据 → 状态机不动它
      expect(runStrategyLoop(store, { now: NOW, realizedR: () => [] }).actions).toHaveLength(0);
      lib.updateShadowStats(head.id, head.version, { net_expectancy_r: 0.22, net_max_drawdown_r: 1, n: 22, win_rate: 0.55, expectancy_r: 0.25, total_r: 5.5, max_drawdown_r: 0.8, first_at: NOW, last_at: NOW });
      const r = runStrategyLoop(store, { now: NOW, realizedR: () => [] });
      expect(r.actions[0]).toMatchObject({ strategy_id: head.id, kind: 'promote', from: 'shadow', to: 'paper' });
      expect(lib.head(head.id)!.status).toBe('paper');
      const ev = store.strategyEvents.timeline(head.id).filter(e => e.kind === 'promote').at(-1)!;
      expect(ev.evidence).toMatchObject({ shadow_n: 22, shadow_expectancy_r: 0.25, shadow_max_drawdown_r: 0.8 });
    } finally {
      state.close();
    }
  });
});

// ---------------------------------------------------------------- 影子线程

describe('闭环 v2 · 影子实盘的虚拟线程', () => {
  it('建 → 按真实 K 线结算 R → 汇总成 shadow 统计(最大回撤是累计曲线的峰谷)', () => {
    const t = openShadowThread({ spec: { id: 'x', version: 1, content_hash: 'h' }, symbol: 'BTCUSDT', timeframe: '15m', side: 'long', at: NOW, snapshot: SNAP });
    expect(t.kind).toBe('shadow');
    expect(t.horizon_end_at).toBe(NOW + SHADOW_HORIZON_BARS * M15);
    const settled = settleShadowThread(t, upBars(60, NOW + M15), NOW + 100 * M15);
    expect(settled.status).toBe('settled');
    expect(settled.r).toBeGreaterThan(1.4); // 单边上行:做多吃到 1.5R 止盈
    // 没有 K 线 → unscoreable,R 留 null(NULL 不是 0)
    const blind = settleShadowThread(t, [], NOW);
    expect(blind.status).toBe('open');
    expect(blind.r).toBeNull();

    const mk = (r: number | null, at: number): typeof t => ({ ...t, id: `s${at}`, opened_at: at * 4 * 3600000, exit_at: at * 4 * 3600000 + 1, score_kind: 'full_strategy', status: r === null ? 'unscoreable' : 'settled', r });
    const stats = shadowStatsOf([mk(1, 1), mk(-1, 2), mk(-1, 3), mk(2, 4), mk(null, 5)]);
    expect(stats).toMatchObject({ n: 4, total_r: 1, expectancy_r: 0.25, win_rate: 0.5, max_drawdown_r: 2 });
    expect(shadowStatsOf([]).n).toBe(0);
  });

  it('虚拟线程不进 demo_threads:不占容量、不进风控、不进历史胜率', () => {
    const { state, store } = fresh();
    try {
      const t = openShadowThread({ spec: { id: 'mtf_alignment', version: 1, content_hash: 'h' }, symbol: 'BTCUSDT', timeframe: '15m', side: 'long', at: NOW, snapshot: SNAP });
      store.shadowThreads.save(t);
      expect(store.shadowThreads.count('mtf_alignment', 1)).toBe(1);
      // 真线程表完全没动:openThreads / closedThreads / 历史都看不到它
      expect(store.threads({ limit: 50 })).toHaveLength(0);
      expect(store.closedThreads(50)).toHaveLength(0);
      // 同一 (策略版本, 币) 只许一条开着
      expect(store.shadowThreads.openFor('mtf_alignment', 1, 'BTCUSDT')?.id).toBe(t.id);
      expect(() => store.shadowThreads.save({ ...t, id: 'other' })).toThrow();
    } finally {
      state.close();
    }
  });

  it('巡检结算把 R 写回 lab_stats.shadow(零模型,只读公共 K 线)', async () => {
    const { state, store } = fresh();
    try {
      const head = store.strategies.head('mtf_alignment')!;
      for (let i = 0; i < 3; i++) {
        store.shadowThreads.save(openShadowThread({ spec: head, symbol: `SYM${i}USDT`, timeframe: '15m', side: 'long', at: NOW + i, snapshot: SNAP }));
      }
      const r = await settleShadowThreads(store, { now: NOW + 100 * M15, fetchKlines: async () => upBars(80, NOW - 10 * M15) });
      expect(r.settled).toBe(3);
      expect(r.updated).toHaveLength(1);
      const stats = store.strategies.head('mtf_alignment')!.lab_stats!.shadow!;
      expect(stats.n).toBe(0);
      expect(stats.direction_proxy?.n).toBe(1);
      expect(stats.direction_proxy?.expectancy_r).toBeGreaterThan(1.4);
    } finally {
      state.close();
    }
  });

  it('议会里影子票只表态、不计共识', () => {
    const v = (id: string, stance: StrategyVerdict['stance'], advisory?: boolean): StrategyVerdict =>
      ({ strategy_id: id, version: 1, content_hash: 'h', horizon: 'intraday', stance, confidence: 0.9, entry_timing: 'confirmed', source: 'code', fit: { score: null, parts: { radar: null, lab: null, eval: null, history: null }, note: '' }, checks: [], reasons: [], at: NOW, ...(advisory ? { advisory: true } : {}) }) as StrategyVerdict;
    // 两条正式票同向 → 有共识;影子票不进任何集合
    const c = consensus([v('a', 'long'), v('b', 'long'), v('shadow_one', 'short', true)], DEFAULT_COUNCIL_POLICY);
    expect(c.reached).toBe(true);
    expect(c.direction).toBe('long');
    expect(c.voting).toEqual(['a', 'b']);
    expect([...c.agreeing, ...c.dissenting, ...c.neutral, ...c.abstaining]).not.toContain('shadow_one');
    // 只有影子票时共识闸无效(而不是「一条影子策略自己放行」)
    expect(consensus([v('shadow_one', 'long', true)], DEFAULT_COUNCIL_POLICY)).toMatchObject({ gate_effective: false, reached: false });
  });
});

// ---------------------------------------------------------------- 台账

describe('闭环 v2 · strategy_events 台账', () => {
  it('时间线按时间正序,who/from/to/evidence 都落下来', () => {
    const { state, store } = fresh();
    try {
      store.strategyEvents.append({ strategy_id: 'a', version: 1, at: NOW + 10, who: 'lab', kind: 'promote', from_status: 'draft', to_status: 'backtest', reason: 'x', evidence: { lab_n: 30 } });
      store.strategyEvents.append({ strategy_id: 'a', version: 1, at: NOW, who: 'human', kind: 'version_created', from_status: null, to_status: 'draft', reason: 'y', evidence: {} });
      store.strategyEvents.append({ strategy_id: 'b', version: 2, at: NOW + 5, who: 'attribution', kind: 'version_created', from_status: null, to_status: 'draft', reason: 'z', evidence: { probe_expectancy_r: 0.3 } });
      const tl = store.strategyEvents.timeline('a');
      expect(tl.map((e) => e.kind)).toEqual(['version_created', 'promote']);
      expect(tl[1]!.evidence).toEqual({ lab_n: 30 });
      expect(store.strategyEvents.recent(5).filter(e => e.kind !== 'gate_check').map((e) => e.strategy_id)).toEqual(['a', 'b', 'a']);
    } finally {
      state.close();
    }
  });
});

// ---------------------------------------------------------------- 假设校验

describe('闭环 v2 · 假设生成的硬约束', () => {
  const ok = {
    id: 'pullback_squeeze',
    name: '压缩回踩',
    family: 'volatility',
    horizon: 'intraday',
    trigger: { kinds: ['breakout'], min_timeframe: '15m', cooldown_bars: 4 },
    checklist: { required: ['scan_checklist'], timeframes: ['15m', '1h'] },
    rules: { entry: ['收在突破位之上'], invalidation: ['收回突破位之下'], exit: ['触及 EMA20 离场'] },
    params: { chase_atr_max: { value: 1.2, min: 0.5, max: 3 } },
    evidence: { indicators: [{ id: 'ema20', tf: '1h' }], events: ['breakout'], info_topics: [] },
  };
  const parse = (arr: unknown[], ctx?: { existingHashes?: Set<string>; existingIds?: Set<string> }) =>
    parseHypotheses(JSON.stringify(arr), { existingHashes: ctx?.existingHashes ?? new Set(), existingIds: ctx?.existingIds ?? new Set() });

  it('事件 subkind 假设保留订阅而非丢成空数组', () => {
    const r = parse([{ ...ok, evidence: { ...ok.evidence, events: ['fomc'] } }]);
    expect(r.dropped).toEqual([]);
    expect(r.drafts[0]?.evidence?.events).toEqual(['fomc']);
  });

  it('合格的一条能落成草稿', () => {
    const r = parse([ok]);
    expect(r.dropped).toEqual([]);
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0]!.evidence!.indicators).toEqual([{ id: 'ema20', tf: '1h' }]);
  });

  it('不合格的一律丢掉并写明原因,绝不进库', () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ...ok, id: 'X' }, /id 不合法/],
      [{ ...ok, family: 'astrology' }, /family/],
      [{ ...ok, horizon: 'forever' }, /horizon/],
      [{ ...ok, trigger: { ...ok.trigger, kinds: ['vibes'] } }, /trigger\.kinds/],
      [{ ...ok, trigger: { ...ok.trigger, min_timeframe: '7s' } }, /min_timeframe/],
      [{ ...ok, checklist: { ...ok.checklist, required: ['gut_feel'] } }, /不是代码算得出来的判据/],
      [{ ...ok, rules: { ...ok.rules, exit: [] } }, /rules/],
      [{ ...ok, params: { chase_atr_max: { value: 9, min: 0.5, max: 3 } } }, /不在 \[0\.5, 3\] 内/],
      [{ ...ok, params: {} }, /params 为空/],
      [{ ...ok, evidence: { ...ok.evidence, indicators: [{ id: 'moon_phase', tf: '1h' }] } }, /不在指标库里/],
      [{ ...ok, evidence: { ...ok.evidence, events: ['funding'] } }, /交集为空/],
    ];
    for (const [body, re] of cases) {
      const r = parse([body]);
      expect(r.drafts, JSON.stringify(body).slice(0, 80)).toHaveLength(0);
      expect(r.dropped[0]!.reason).toMatch(re);
    }
    expect(parse([], {}).drafts).toHaveLength(0);
    expect(parseHypotheses('没有 JSON', { existingHashes: new Set(), existingIds: new Set() }).dropped[0]!.reason).toMatch(/没有 JSON 数组/);
  });

  it('均值回归族由注册表执行器接纳', () => {
    expect(parse([{ ...ok, family: 'mean_reversion', params: { dev_atr_min: { value: 2, min: 1, max: 4 } } }]).drafts).toHaveLength(1);
  });

  it('判重:id 撞了、或内容哈希撞了都丢;一次最多收 3 条', () => {
    expect(parse([ok], { existingIds: new Set(['pullback_squeeze']) }).dropped[0]!.reason).toMatch(/id 已存在/);
    const hash = strategyContentHash(parse([ok]).drafts[0]!);
    expect(parse([ok], { existingHashes: new Set([hash]) }).dropped[0]!.reason).toMatch(/内容哈希/);
    // id 不进 content_hash,所以只改 id 的四条是同一份内容 —— 判重先把后三条挡了
    expect(parse([1, 2, 3, 4].map((i) => ({ ...ok, id: `hyp_${i}` }))).drafts).toHaveLength(1);
    const many = [1, 2, 3, 4].map((i) => ({ ...ok, id: `hyp_${i}`, params: { chase_atr_max: { value: 1 + i * 0.1, min: 0.5, max: 3 } } }));
    expect(parse(many).drafts).toHaveLength(3);
  });

  it('createDraft 强制 draft + 清空统计,重复 id / 重复内容都拒', () => {
    const { state, store } = fresh();
    try {
      const draft = parse([ok]).drafts[0]!;
      const r = store.strategies.createDraft(draft, { now: NOW });
      expect(r.spec).toMatchObject({ status: 'draft', version: 1, lab_stats: null });
      expect(r.spec!.eval_stats.trades).toBe(0);
      expect(store.strategies.createDraft(draft, { now: NOW }).error).toMatch(/已存在/);
      expect(store.strategies.createDraft({ ...draft, id: 'another_id' }, { now: NOW }).error).toMatch(/内容与已有策略/);
    } finally {
      state.close();
    }
  });
});

// ---------------------------------------------------------------- 切换(§9.28)

describe('策略切换 §9.28', () => {
  let state: StateDb | null = null;
  afterEach(() => state?.close());

  const runtime = (store: DemoStore): DemoRuntime =>
    new DemoRuntime({ store, backend: new PaperBackend(10_000), brains: { stub: stubBrain(() => '{}') }, marketPollMs: 600_000, accountPollMs: 600_000, radar: { runScreen: async () => { throw new Error('no'); } } });

  it('只有 paper / live_capped 能进 active_strategies', () => {
    const f = fresh();
    state = f.state;
    const rt = runtime(f.store);
    const r = rt.setWorkflow({ active_strategies: ['breakout_retest', 'mtf_alignment', 'no_such_strategy'] });
    expect(r.workflow.active_strategies).toEqual(['breakout_retest']); // 只有它是 paper
    expect(r.errors.join(';')).toMatch(/mtf_alignment 状态是 backtest/);
    expect(r.errors.join(';')).toMatch(/no_such_strategy 不在策略库里/);
  });

  it('状态退化 → 自动移出启用列表,并推一条带「查看」action 的 warn', () => {
    const f = fresh();
    state = f.state;
    const rt = runtime(f.store);
    expect(rt.workflow.active_strategies).toEqual(['breakout_retest']);
    toPaper(f.store, 'breakout_retest');
    const loop = runStrategyLoop(f.store, { now: NOW, realizedR: (id) => (id === 'breakout_retest' ? Array(DEGRADE_LOSS_STREAK).fill(-1) : []) });
    rt.applyStrategyLoop(loop);
    expect(rt.workflow.active_strategies).toEqual([]);
    const act = f.store.activity(10).find((a) => a.title.includes('降级'))!;
    expect(act.level).toBe('warn');
    expect(act.data['action']).toMatchObject({ label: '查看', method: 'GET', path: '/api/strategies/breakout_retest' });
    expect(f.store.strategyEvents.timeline('breakout_retest').some((e) => e.kind === 'deactivated')).toBe(true);
  });

  it('realizedRFromThreads 只数本策略的已结算线程,按时间从旧到新', () => {
    const f = fresh();
    state = f.state;
    const mk = (id: string, strategy: string | null, pnl: string, closedAt: number): StrategyThread => {
      const t = newThread({ id, symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '15m', thesis: 't', invalidation_text: null, watch_conditions: [], entry: { type: 'market', price: null, zone: null }, stop_price: '90', take_profits: ['120'], qty: '1', margin_usdt: '100', leverage: 3, margin_mode: 'cross', now: closedAt - 1000 } as Parameters<typeof newThread>[0]);
      return { ...t, strategy_id: strategy, strategy_version: 1, backend: 'paper', settlement: { status: 'complete', at: closedAt, realized_pnl: pnl, commission: '0', funding: '0', net_pnl: pnl, exit_price: '110', trades: 2, window: [closedAt - 1000, closedAt], source: 'exchange' }, status: 'closed', opened_at: closedAt - 1000, closed_at: closedAt, updated_at: closedAt, filled_avg_price: '100', exit_price: '110', realized_pnl: pnl, close_reason: 'tp' };
    };
    f.store.saveThread(mk('t2', 'breakout_retest', '5', NOW + 2000));
    f.store.saveThread(mk('t1', 'breakout_retest', '-10', NOW + 1000));
    f.store.saveThread(mk('t3', 'mtf_alignment', '20', NOW + 3000));
    expect(realizedRFromThreads(f.store, 'breakout_retest', 1, 'paper')).toEqual([-1, 0.5]); // 风险 = |100-90|×1 = 10
    expect(realizedRFromThreads(f.store, 'mtf_alignment', 1, 'paper')).toEqual([2]);
  });

  // 09-12 复审 P1-13 / allocator 缺口 3:生产端 settleThread 不写 settlement.status,
  // 旧口径「必须 status==='complete'」会把标准线程全部排空,降级与轮换同时失去健康数据。
  it('realizedRFromThreads:没有 settlement.status 的生产线程按 settlementCompleteness 判,不被排空', () => {
    const f = fresh();
    state = f.state;
    const base = newThread({ id: 'p1', symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '15m', thesis: 't', invalidation_text: null, watch_conditions: [], entry: { type: 'market', price: null, zone: null }, stop_price: '90', take_profits: ['120'], qty: '1', margin_usdt: '100', leverage: 3, margin_mode: 'cross', now: NOW } as Parameters<typeof newThread>[0]);
    const settlement = { at: NOW + 1000, realized_pnl: '5', commission: '0', funding: '0', net_pnl: '5', exit_price: '110', trades: 2, window: [NOW, NOW + 1000] as [number, number], source: 'exchange' as const };
    // (a) 没有 status 字段 + 没有 strategy_version(默认种子线程)
    f.store.saveThread({ ...base, strategy_id: 'breakout_retest', backend: 'paper', settlement, status: 'closed', opened_at: NOW, closed_at: NOW + 1000, updated_at: NOW + 1000, filled_avg_price: '100', exit_price: '110', realized_pnl: '5', close_reason: 'tp' } as StrategyThread);
    expect(realizedRFromThreads(f.store, 'breakout_retest', 1, 'paper')).toEqual([0.5]);

    // (b) 结算明显不完整(窗口内 0 笔成交)的不算数
    f.store.saveThread({ ...base, id: 'p2', strategy_id: 'breakout_retest', strategy_version: 1, backend: 'paper', settlement: { ...settlement, trades: 0, note: '没有这个币的成交' }, status: 'closed', opened_at: NOW, closed_at: NOW + 2000, updated_at: NOW + 2000, filled_avg_price: '100', exit_price: '110', realized_pnl: '5', close_reason: 'tp' } as StrategyThread);
    expect(realizedRFromThreads(f.store, 'breakout_retest', 1, 'paper')).toEqual([0.5]);

    // (c) 明确记了别的版本的行仍然按版本排除
    f.store.saveThread({ ...base, id: 'p3', strategy_id: 'breakout_retest', strategy_version: 9, backend: 'paper', settlement, status: 'closed', opened_at: NOW, closed_at: NOW + 3000, updated_at: NOW + 3000, filled_avg_price: '100', exit_price: '110', realized_pnl: '5', close_reason: 'tp' } as StrategyThread);
    expect(realizedRFromThreads(f.store, 'breakout_retest', 1, 'paper')).toEqual([0.5]);
  });
});

// ---------------------------------------------------------------- 自定义证据(§4)

describe('自定义证据 §4', () => {
  it('没写 evidence 的旧策略走显式的默认集;写了就按并集装,每条带 required_by', () => {
    const { state, store } = fresh();
    try {
      const legacy = store.strategies.head('breakout_retest')!;
      expect(legacy.evidence ?? null).toBeNull();
      expect(evidenceOf(legacy)).toEqual(DEFAULT_EVIDENCE);

      const a = { ...legacy, id: 'a', evidence: { indicators: [{ id: 'rsi', tf: '1h' }, { id: 'adx', tf: '1h' }], events: [] } } as StrategySpec;
      const b = { ...legacy, id: 'b', evidence: { indicators: [{ id: 'rsi', tf: '1h' }, { id: 'macd', tf: '15m' }], events: [], info_topics: ['ETF'] } } as StrategySpec;
      const plan = evidencePlan([a, b]);
      expect(plan.indicators.map((i) => `${i.tf}:${i.id}`)).toEqual(['15m:macd', '1h:adx', '1h:rsi']);
      expect(plan.indicators.find((i) => i.id === 'rsi')!.required_by).toEqual(['a', 'b']);
      expect(plan.indicators.find((i) => i.id === 'adx')!.required_by).toEqual(['a']);
      expect(plan.info_topics).toEqual(['etf']);
      // 指标库里没有的 id 被忽略
      expect(evidencePlan([{ ...a, evidence: { indicators: [{ id: 'moon', tf: '1h' }], events: [] } } as StrategySpec]).indicators).toEqual([]);
    } finally {
      state.close();
    }
  });

  it('buildContext:只装启用策略要的指标,每条带 required_by;没人要的不进 prompt', () => {
    const { state, store } = fresh();
    try {
      const base = store.strategies.head('breakout_retest')!;
      const bars = upBars(120, NOW - 120 * M15);
      const klines = { '15m': bars, '1h': bars, '4h': bars };
      const features = [tfFeatures('15m', bars), tfFeatures('1h', bars), tfFeatures('4h', bars)];
      const market = { last: '100', mark: '100', funding_rate: '0.0001', next_funding_at: NOW + 3_600_000, open_interest: '1000', as_of: NOW } as unknown as MarketView;
      const account = { equity: '10000', available: '10000', positions: [], as_of: NOW } as unknown as AccountView;
      const build = (specs: StrategySpec[]) =>
        buildContext({
          now: NOW, symbol: 'BTCUSDT', trigger: { kind: 'breakout', detail: 'x' }, mode: 'scan', thread: null, open_threads: [],
          account, market, features, oi_change_1h_pct: 0.5, ticker24h: { priceChangePercent: '1', highPrice: '110', lowPrice: '90', quoteVolume: '1000000' },
          market_state: null, playbook_text: 'p', last_judgment_summary: null, halted: false, strategies: specs, klines,
        });

      // 只要 RSI
      const only = build([{ ...base, evidence: { indicators: [{ id: 'rsi', tf: '1h' }], events: [] } } as StrategySpec]);
      const inds = only.evidence.filter((e) => e.kind === 'indicator');
      expect(inds).toHaveLength(1);
      expect(inds[0]!.label).toBe('1h rsi');
      expect(inds[0]!.required_by).toEqual(['breakout_retest']);
      expect(only.context_text).toContain('RSI14');
      expect(only.context_text).not.toContain('MACD 柱'); // 没有策略要 MACD → 不进 prompt

      // 旧策略(没写 evidence)走默认集
      const legacy = build([base]);
      expect(legacy.evidence.filter((e) => e.kind === 'indicator').map((e) => e.label).sort()).toEqual(['1h atr', '1h ema20', '1h ema50', '1h rsi']);
      // 策略自己的清单行带 required_by
      const chk = build([store.strategies.head('vol_compression_expansion')!]).evidence.find((e) => e.label.startsWith('vol_compression_expansion·'));
      expect(chk?.required_by).toEqual(['vol_compression_expansion']);
    } finally {
      state.close();
    }
  });

  it('evidence.events 与 trigger.kinds 取交集决定唤醒;空 = 沿用 trigger.kinds', () => {
    const { state, store } = fresh();
    try {
      const base = store.strategies.head('breakout_retest')!;
      // trader_signal 是外部唤醒,永远在唤醒集里(跟单 session,契约 §9.38);其余仍是交集口径。
      expect(wakeKindsOf(base)).toEqual([...base.trigger.kinds, 'trader_signal']);
      const narrowed = { ...base, evidence: { indicators: [], events: ['retest' as const, 'funding' as const] } } as StrategySpec;
      expect(wakeKindsOf(narrowed)).toEqual(['retest', 'trader_signal']); // funding 不在 trigger.kinds 里
      expect(strategyWakes(narrowed, '15m', [{ kind: 'breakout' }])).toBe(false);
      expect(strategyWakes(narrowed, '15m', [{ kind: 'retest' }])).toBe(true);
      expect(strategyWakes(narrowed, '15m', [{ kind: 'trader_signal' }])).toBe(true);
      expect(strategyWakes(base, '15m', [{ kind: 'breakout' }])).toBe(true);
    } finally {
      state.close();
    }
  });

  it('evidence 进 content_hash(换一套证据 = 新版本),但没写 evidence 的旧版本 hash 一个字不变', () => {
    const { state, store } = fresh();
    try {
      const head = store.strategies.head('breakout_retest')!;
      expect(strategyContentHash(head)).toBe(head.content_hash); // 不写 evidence:hash 不变
      const withEv = { ...head, evidence: { indicators: [{ id: 'rsi', tf: '1h' }], events: [] } } as StrategySpec;
      expect(strategyContentHash(withEv)).not.toBe(head.content_hash);
      const r = store.strategies.createVersion('breakout_retest', { evidence: { indicators: [{ id: 'rsi', tf: '1h' }], events: [] } }, { now: NOW });
      expect(r.spec).toMatchObject({ status: 'draft', version: head.version + 1 });
      expect(r.spec!.evidence!.indicators).toEqual([{ id: 'rsi', tf: '1h' }]);
      // 书写顺序不影响 hash
      expect(strategyContentHash({ ...head, evidence: { indicators: [{ id: 'a', tf: '1h' }, { id: 'b', tf: '1h' }], events: ['retest', 'breakout'] } } as StrategySpec))
        .toBe(strategyContentHash({ ...head, evidence: { indicators: [{ id: 'b', tf: '1h' }, { id: 'a', tf: '1h' }], events: ['breakout', 'retest'] } } as StrategySpec));
    } finally {
      state.close();
    }
  });

  it('renderIndicator 算不出来时返回 null(不写 0)', () => {
    const snap = { tf: '1h', last_close: 100, ema20: null, rsi14: 55.5, macd: null, atr14: null } as never;
    expect(renderIndicator('ema20', snap)).toBeNull();
    expect(renderIndicator('rsi', snap)).toBe('RSI14 55.5');
    expect(renderIndicator('macd', snap)).toBeNull();
  });
});

// ---------------------------------------------------------------- 议会 advisory 的端到端

describe('闭环 v2 · runCouncil 的影子票', () => {
  it('advisory_strategies 只加票不改共识,快照里也不留它们', () => {
    const { state, store } = fresh();
    try {
      const paper = store.strategies.head('breakout_retest')!;
      const shadow = { ...store.strategies.head('mtf_alignment')!, status: 'shadow' as const };
      const bars = upBars(120, NOW - 120 * M15);
      const r = runCouncil({
        now: NOW, symbol: 'BTCUSDT', timeframe: '15m',
        features: [tfFeatures('15m', bars), tfFeatures('1h', bars), tfFeatures('4h', bars)],
        klines: { '15m': bars, '1h': bars, '4h': bars },
        market: { last: '100', mark: '100', funding_rate: '0.0001', next_funding_at: NOW + 3_600_000, open_interest: '1', as_of: NOW } as unknown as MarketView,
        oi_change_1h_pct: null, daily_regime: null, trigger_hits: [{ kind: 'breakout', detail: 'x' }],
        strategies: [paper], advisory_strategies: [shadow], woken_ids: [paper.id, shadow.id],
        fit_for: () => ({ radar_fit: null, history: null }), policy: DEFAULT_COUNCIL_POLICY,
      });
      expect(r.verdicts.map((v) => v.strategy_id).sort()).toEqual(['breakout_retest', 'mtf_alignment']);
      expect(r.verdicts.find((v) => v.strategy_id === 'mtf_alignment')!.advisory).toBe(true);
      expect(r.consensus.voting).not.toContain('mtf_alignment');
      expect(r.text).toContain('影子,不计票');
    } finally {
      state.close();
    }
  });
});

// ---------------------------------------------------------------- 归因 → Lab 探针队列(§1.3)

describe('闭环 v2 · attribution 的 param 提案走 Lab 验证', () => {
  let state: StateDb | null = null;
  afterEach(() => state?.close());

  it('入队去重;下一轮 Lab 达标才落成 draft,不达标只关掉队列项', async () => {
    const f = fresh();
    state = f.state;
    const store = f.store;
    const head = store.strategies.head('breakout_retest')!;
    const target = Math.min(head.params['chase_atr_max']!.max, head.params['chase_atr_max']!.value + 0.5);
    expect(store.labProbes.enqueue({ strategy_id: 'breakout_retest', param: 'chase_atr_max', value: target, source: 'attribution', source_ref: 'attr-1', now: NOW })).not.toBeNull();
    expect(store.labProbes.enqueue({ strategy_id: 'breakout_retest', param: 'chase_atr_max', value: target, source: 'attribution', source_ref: 'attr-1', now: NOW })).toBeNull(); // 同一提案不重复入队
    expect(store.labProbes.queued()).toHaveLength(1);

    const base = { strategy_id: 'breakout_retest', version: head.version, symbols: 2, setups: 80, n: 50, win_rate: 0.45, expectancy_r: 0.05, total_r: 2.5 };
    const probeCell = { ...base, selected_folds: 1, replay: { oos_n: 40, dsr: 0.2, oos_ci: { status: 'sufficient' as const, lower: 0.1, upper: 0.7, iterations: 2000, block_size: 7 } }, param: 'chase_atr_max', value: target, expectancy_r: 0.4, total_r: 20 };
    let asked: Record<string, { param: string; value: number }[]> | undefined;
    const rt = new DemoRuntime({
      store, backend: new PaperBackend(10_000), brains: { stub: stubBrain(() => '{}') }, marketPollMs: 600_000, accountPollMs: 600_000,
      radar: { runScreen: async () => { throw new Error('no'); } },
      team: {
        runExperiment: async (m, deps) => {
          asked = deps.probe_values;
          return { manifest_hash: m.manifest_hash, unmeasured: [], cells: [], by_strategy: [base], probes: [probeCell], errors: [], note: 'n' };
        },
      },
    });
    await rt.team.runLab('manual');
    // 队列里的候选值被点名跑了
    expect(asked?.[`breakout_retest@${head.version}`]).toEqual([{ param: 'chase_atr_max', value: target }]);
    const done = store.labProbes.list().find((q) => q.param === 'chase_atr_max')!;
    expect(done.status).toBe('verified');
    const created = store.strategies.head('breakout_retest')!;
    expect(created.version).toBe(head.version + 1);
    expect(created.status).toBe('draft');
    expect(created.params['chase_atr_max']!.value).toBe(target);
    expect(store.strategyEvents.timeline('breakout_retest').some((e) => e.who === 'attribution' && e.kind === 'version_created')).toBe(true);
  });

  it('缺训练选中与 OOS 证据 → 关掉队列项,绝不建版本', async () => {
    const f = fresh();
    state = f.state;
    const store = f.store;
    const head = store.strategies.head('breakout_retest')!;
    const target = Math.min(head.params['chase_atr_max']!.max, head.params['chase_atr_max']!.value + 0.5);
    store.labProbes.enqueue({ strategy_id: 'breakout_retest', param: 'chase_atr_max', value: target, source: 'attribution', now: NOW });
    const base = { strategy_id: 'breakout_retest', version: head.version, symbols: 2, setups: 80, n: 50, win_rate: 0.45, expectancy_r: 0.3, total_r: 15 };
    const rt = new DemoRuntime({
      store, backend: new PaperBackend(10_000), brains: { stub: stubBrain(() => '{}') }, marketPollMs: 600_000, accountPollMs: 600_000,
      radar: { runScreen: async () => { throw new Error('no'); } },
      team: { runExperiment: async (m) => ({ manifest_hash: m.manifest_hash, unmeasured: [], cells: [], by_strategy: [base], probes: [{ ...base, param: 'chase_atr_max', value: target, expectancy_r: 0.32 }], errors: [], note: 'n' }) },
    });
    await rt.team.runLab('manual');
    expect(store.labProbes.list()[0]).toMatchObject({ status: 'rejected' });
    expect(store.labProbes.list()[0]!.note).toMatch(/样本不足/);
    expect(store.strategies.head('breakout_retest')!.version).toBe(head.version);
  });
});
