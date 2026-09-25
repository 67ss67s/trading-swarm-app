const VERIFIED_OOS = { oos_n: 40, oos_net_expectancy: 0.2, oos_ci: { status: 'sufficient' as const, lower: 0.05, upper: 0.3, iterations: 2000, block_size: 7 }, dsr: 0.1, max_dd_r: 1, regime: { trend: { n: 20, net_expectancy: 0.2 }, range: { n: 20, net_expectancy: 0.2 } } };
// 策略库(strategies.ts)、回归统计(reversion-stats.ts)、归因(attribution.ts)与它们在
// buildContext / 契约校验里的接线。docs/design/strategy-library-2026-09-05.md。
// 全程 stub / 假大脑,不调任何付费模型,不碰网络。

import { describe, expect, it } from 'vitest';
import { openStateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import {
  BUILTIN_IDS,
  BUILTIN_STRATEGIES,
  STATUS_ORDER,
  StrategyLibrary,
  strategyContentHash,
  strategyWakes,
  renderStrategies,
  fundingZScore,
  type StrategySpec,
} from '../../src/demo/strategies.js';
import { reversionStats } from '../../src/demo/reversion-stats.js';
import { attributionMemoryContent, parseAttribution, runAttribution, type AttributionPoint } from '../../src/demo/attribution.js';
import { buildContext, PROMPT_VERSION } from '../../src/demo/context.js';
import { validateJudgment } from '../../src/demo/schema.js';
import { tfFeatures } from '../../src/demo/market.js';
import { applyWorkflowPatch, DEFAULT_WORKFLOW } from '../../src/demo/workflow.js';
import { breakdownByStrategy, type BacktestRun, type BacktestStep, type BacktestTrade } from '../../src/demo/backtest.js';
import type { Brain } from '../../src/demo/brain.js';
import type { AccountView, Kline, MarketView } from '../../src/demo/types.js';

const NOW = 1_788_500_000_000;

function fresh(): DemoStore {
  return new DemoStore(openStateDb(':memory:'));
}

/**
 * 只 seed 内置策略、**不**生成 breakout_retest v2 草稿的库。DemoStore 的构造函数会顺手建 v2
 * (docs/research/zero-propose-funnel-2026-09-05.md §5),那对"内置初版长什么样"的断言是干扰项。
 */
function freshLib(): StrategyLibrary {
  const lib = new StrategyLibrary(openStateDb(':memory:').db);
  lib.seed();
  return lib;
}

// ---------------------------------------------------------------- 库:hash / 不可变 / 幂等 / 晋升门

describe('strategy library', () => {
  it('seeds the five built-ins once and is idempotent', () => {
    const store = fresh();
    // DemoStore 的构造函数已经 seed 过一次了。
    expect(store.strategies.list().map((s) => s.id).sort()).toEqual([...BUILTIN_IDS].sort());
    expect(store.strategies.seed()).toBe(0);
    expect(store.strategies.list()).toHaveLength(BUILTIN_IDS.length);
    // 今天在跑的那条(v1)是 paper,其余都是 backtest;head 是漏斗生成的 v2 草稿,停在 backtest。
    expect(store.strategies.version('breakout_retest', 1)!.status).toBe('paper');
    expect(store.strategies.head('breakout_retest')!.version).toBe(2);
    expect(store.strategies.head('breakout_retest')!.status).toBe('backtest');
    for (const id of BUILTIN_IDS.filter((x) => x !== 'breakout_retest')) expect(store.strategies.head(id)!.status).toBe('backtest');
  });

  it('content_hash covers params/rules but not status or eval_stats', () => {
    const s = BUILTIN_STRATEGIES[0]!;
    expect(strategyContentHash(s)).toBe(s.content_hash);
    expect(strategyContentHash({ ...s, status: 'retired', eval_stats: { ...s.eval_stats, trades: 99 } } as StrategySpec)).toBe(s.content_hash);
    const moved = { ...s, params: { ...s.params, chase_atr_max: { ...s.params['chase_atr_max']!, value: 2 } } };
    expect(strategyContentHash(moved)).not.toBe(s.content_hash);
  });

  it('a param change makes a NEW draft version; the old version is untouched', () => {
    const lib = freshLib();
    const before = lib.head('breakout_retest')!;
    const { spec, error } = lib.createVersion('breakout_retest', { params: { chase_atr_max: 2 } }, { now: NOW });
    expect(error).toBeNull();
    expect(spec!.version).toBe(2);
    expect(spec!.parent_version).toBe(1);
    expect(spec!.status).toBe('draft'); // 新版本一律从 draft 起步,不继承 paper
    expect(spec!.content_hash).not.toBe(before.content_hash);
    expect(spec!.params['chase_atr_max']!.value).toBe(2);
    // v1 还在,内容一个字没变 —— 旧成交永远指向它。
    const v1 = lib.version('breakout_retest', 1)!;
    expect(v1.content_hash).toBe(before.content_hash);
    expect(v1.params['chase_atr_max']!.value).toBe(1.5);
    expect(lib.versions('breakout_retest').map((v) => v.version)).toEqual([2, 1]);
  });

  it('refuses params out of range, unknown params, and a no-op change', () => {
    const lib = freshLib();
    expect(lib.createVersion('breakout_retest', { params: { chase_atr_max: 99 } }).error).toMatch(/超出范围/);
    expect(lib.createVersion('breakout_retest', { params: { nope: 1 } }).error).toMatch(/没有参数/);
    expect(lib.createVersion('breakout_retest', { params: { chase_atr_max: 1.5 } }).error).toMatch(/没有变化/);
    expect(lib.createVersion('no_such', { params: {} }).error).toMatch(/不存在/);
  });

  it('promotion moves exactly one step and only through the gates', () => {
    const lib = fresh().strategies;
    const id = 'mtf_alignment'; // status backtest

    expect(lib.promote(id, 'paper').error).toMatch(/一格一格/);
    expect(lib.promote(id, 'shadow').error).toMatch(/OOS 成交不足 30 笔/);

    lib.updateEvalStats(id, { trades: 12, win_rate: 0.5, expectancy_r: 0.3, mae_r_p50: -0.4, last_run_id: 'bt-1', noise_note: null });
    expect(lib.promote(id, 'shadow').error).toMatch(/OOS 成交不足 30 笔/);

    lib.updateEvalStats(id, { trades: 24, win_rate: 0.5, expectancy_r: -0.1, mae_r_p50: -0.4, last_run_id: 'bt-2', noise_note: null });
    expect(lib.head(id)!.eval_stats.backtests).toBe(2);
    expect(lib.promote(id, 'shadow').error).toMatch(/OOS/);
    lib.updateLabStats(id, lib.head(id)!.version, { ...VERIFIED_OOS, run_id: 'r', at: 1, symbols: 2, setups: 40, n: 40, win_rate: 0.5, expectancy_r: 0.2, total_r: 8, note: '' });
    expect(lib.promote(id, 'shadow').error).toBeNull();
    expect(lib.head(id)!.status).toBe('shadow');

    // shadow → paper 要期望 R 为正
    expect(lib.promote(id, 'paper').error).toMatch(/影子实盘/);
    lib.updateEvalStats(id, { trades: 24, win_rate: 0.55, expectancy_r: 0.42, mae_r_p50: -0.4, last_run_id: 'bt-3', noise_note: null });
    lib.updateShadowStats(id, lib.head(id)!.version, { n: 30, win_rate: 0.5, expectancy_r: 0.3, total_r: 9, max_drawdown_r: 1, first_at: 1, last_at: 2, net_expectancy_r: 0.2, net_max_drawdown_r: 1 });
    expect(lib.promote(id, 'paper').error).toBeNull();

    // paper → live_capped 必须人工确认
    expect(lib.promote(id, 'live_capped').error).toMatch(/人工确认/);
    expect(lib.promote(id, 'live_capped', { confirm: true }).error).toMatch(/30/);
    lib.updateEvalStats(id, { trades: 30, win_rate: 0.55, expectancy_r: 0.42, mae_r_p50: -0.4, last_run_id: 'bt-4', noise_note: null });
    expect(lib.promote(id, 'live_capped', { confirm: true }).error).toBeNull();
    expect(lib.head(id)!.status).toBe('live_capped');
    expect(lib.promote(id, 'live_capped', { confirm: true }).error).toMatch(/没有了|一格一格/);
  });

  it('retire is terminal for that head and drops it out of list()', () => {
    const lib = fresh().strategies;
    expect(lib.retire('funding_oi_extreme').error).toBeNull();
    expect(lib.list().map((s) => s.id)).not.toContain('funding_oi_extreme');
    expect(lib.list({ include_retired: true }).map((s) => s.id)).toContain('funding_oi_extreme');
    expect(lib.promote('funding_oi_extreme', 'shadow').error).toMatch(/已退役/);
  });

  it('resolve() keeps live judgments to status ≥ paper but lets backtests use anything', () => {
    const lib = fresh().strategies;
    const live = lib.resolve(['breakout_retest', 'mtf_alignment', 'ghost'], { allow_below_paper: false });
    expect(live.specs.map((s) => s.id)).toEqual(['breakout_retest']);
    expect(live.errors.join(';')).toMatch(/mtf_alignment 状态是 backtest/);
    expect(live.errors.join(';')).toMatch(/ghost 不在策略库里/);
    const bt = lib.resolve(['breakout_retest', 'mtf_alignment'], { allow_below_paper: true });
    expect(bt.specs.map((s) => s.id)).toEqual(['breakout_retest', 'mtf_alignment']);
  });

  it('strategyWakes only fires on the strategy’s own trigger kinds and timeframe floor', () => {
    const s = BUILTIN_STRATEGIES.find((x) => x.id === 'vol_compression_expansion')!;
    expect(strategyWakes(s, '15m', [{ kind: 'vol_spike' }])).toBe(true);
    expect(strategyWakes(s, '15m', [{ kind: 'funding' }])).toBe(false);
    expect(strategyWakes(s, '5m', [{ kind: 'vol_spike' }])).toBe(false); // 低于 min_timeframe
    expect(strategyWakes(s, '15m', [])).toBe(false);
  });

  it('workflow.active_strategies validates shape and caps the list', () => {
    const { next, errors } = applyWorkflowPatch(DEFAULT_WORKFLOW, { active_strategies: ['breakout_retest', 'mtf_alignment'] });
    expect(errors).toEqual([]);
    expect(next.active_strategies).toEqual(['breakout_retest', 'mtf_alignment']);
    expect(applyWorkflowPatch(DEFAULT_WORKFLOW, { active_strategies: ['Not An Id'] }).errors.join()).toMatch(/不是合法策略 id/);
    expect(applyWorkflowPatch(DEFAULT_WORKFLOW, { active_strategies: 'x' }).errors.join()).toMatch(/必须是数组/);
    expect(DEFAULT_WORKFLOW.active_strategies).toEqual(['breakout_retest']);
  });
});

// ---------------------------------------------------------------- 回归统计

function bars(count: number, price: (i: number) => number, t0 = NOW - count * 900_000): Kline[] {
  const out: Kline[] = [];
  for (let i = 0; i < count; i++) {
    const open = price(i);
    const close = price(i + 1);
    const openTime = t0 + i * 900_000;
    out.push({
      open_time: openTime,
      open: open.toFixed(2),
      high: (Math.max(open, close) + 1).toFixed(2),
      low: (Math.min(open, close) - 1).toFixed(2),
      close: close.toFixed(2),
      volume: '100',
      close_time: openTime + 899_999,
    });
  }
  return out;
}

describe('reversionStats', () => {
  it('a mean-reverting series reverts often; a trending one rarely', () => {
    // 均值回归:围绕 1000 的正弦,周期 20 根 —— 偏离必然被拉回来。
    const reverting = reversionStats(bars(900, (i) => 1000 + 40 * Math.sin((i / 20) * Math.PI * 2)), { tf: '15m' })!;
    // 趋势:单边爬升,EMA20 永远在价格下方,几乎不回。
    const trending = reversionStats(bars(900, (i) => 1000 + i * 6), { tf: '15m' })!;
    expect(reverting).not.toBeNull();
    expect(trending).not.toBeNull();

    const revCell = reverting.cells.find((c) => c.k === 2 && c.horizon === 12)!;
    const trendCell = trending.cells.find((c) => c.k === 2 && c.horizon === 12)!;
    expect(revCell.samples).toBeGreaterThan(20);
    expect(revCell.prob!).toBeGreaterThan(0.8);
    expect(revCell.median_bars!).toBeGreaterThan(0);
    // 趋势里要么根本达不到 2 ATR 的偏离(样本 0),要么达到了也不回。
    expect(trendCell.samples === 0 || trendCell.prob! < 0.3).toBe(true);
    expect(revCell.prob!).toBeGreaterThan(trendCell.prob ?? 0);
  });

  it('longer horizons never revert less often, and the text names its own caveats', () => {
    const s = reversionStats(bars(900, (i) => 1000 + 40 * Math.sin((i / 20) * Math.PI * 2)), { tf: '15m' })!;
    const at = (h: number): number => s.cells.find((c) => c.k === 1.5 && c.horizon === h)!.prob!;
    expect(at(24)).toBeGreaterThanOrEqual(at(12));
    expect(at(12)).toBeGreaterThanOrEqual(at(6));
    expect(s.text).toContain('样本重叠');
    expect(s.text).toContain('EMA20');
  });

  it('refuses to answer below 400 bars rather than guessing', () => {
    expect(reversionStats(bars(120, (i) => 1000 + i))).toBeNull();
  });
});

describe('fundingZScore', () => {
  it('is null without history and flags a genuine extreme', () => {
    expect(fundingZScore(undefined, 0.0006, NOW).z).toBeNull();
    const flat = Array.from({ length: 90 }, (_, i) => ({ at: NOW - (90 - i) * 8 * 3_600_000, rate: '0.0001' }));
    const noisy = flat.map((f, i) => ({ ...f, rate: (0.0001 + (i % 3) * 0.00001).toFixed(6) }));
    const z = fundingZScore(noisy, 0.0006, NOW).z!;
    expect(z).toBeGreaterThan(2);
  });
});

// ---------------------------------------------------------------- buildContext 接线 + 契约

const MARKET: MarketView = { symbol: 'BTCUSDT', last: '60000', mark: '60000', funding_rate: '0.0006', next_funding_at: NOW + 3_600_000, open_interest: '1000', as_of: NOW, klines_tf: '15m' };
const ACCOUNT: AccountView = { backend: 'paper', equity: '10000', available: '10000', unrealized_pnl: '0', positions: [], open_orders: [], as_of: NOW };

function ctxInputs(strategies: StrategySpec[], klines?: Record<string, Kline[]>): Parameters<typeof buildContext>[0] {
  const k15 = klines?.['15m'] ?? bars(600, (i) => 60000 + 40 * Math.sin((i / 20) * Math.PI * 2));
  return {
    now: NOW,
    symbol: 'BTCUSDT',
    trigger: { kind: 'breakout', detail: '测试触发' },
    mode: 'scan',
    thread: null,
    open_threads: [],
    account: ACCOUNT,
    market: MARKET,
    features: [tfFeatures('15m', k15), tfFeatures('1h', bars(200, (i) => 60000 + i)), tfFeatures('4h', bars(120, (i) => 60000 + i * 2))],
    oi_change_1h_pct: -2.4,
    ticker24h: { priceChangePercent: '1.0', highPrice: '61000', lowPrice: '59000', quoteVolume: '1000000' },
    market_state: null,
    playbook_text: '用户自己写的补充说明。',
    last_judgment_summary: null,
    halted: false,
    strategies,
    klines: { '15m': k15 },
  };
}

describe('buildContext × strategies', () => {
  it('is demo-playbook-v11.1-ohlc and, with no strategies, renders the playbook exactly like v4 did', () => {
    expect(PROMPT_VERSION).toBe('demo-playbook-v11.1-ohlc');
    const built = buildContext(ctxInputs([]));
    expect(built.strategy_ids).toEqual([]);
    expect(built.system_text).toContain(`Playbook(${PROMPT_VERSION})`);
    expect(built.system_text).not.toContain('可用策略:');
    expect(built.system_text).not.toContain('9. 这次允许使用的策略');
  });

  it('renders the active strategies’ rules, keeps playbook_text as 补充说明, and adds rule 9', () => {
    const lib = freshLib();
    const specs = [lib.head('breakout_retest')!, lib.head('range_mean_reversion')!];
    const built = buildContext(ctxInputs(specs));
    expect(built.strategy_ids).toEqual(['breakout_retest', 'range_mean_reversion']);
    expect(built.system_text).toContain('可用策略:');
    expect(built.system_text).toContain('breakout_retest·突破-回踩 v1');
    expect(built.system_text).toContain('range_mean_reversion·区间均值回归');
    expect(built.system_text).toContain('补充说明');
    expect(built.system_text).toContain('用户自己写的补充说明。');
    expect(built.system_text).toContain('"strategy_id"');
    // 提示词膨胀有预算:两条策略(这里挑的是最长的一对)加起来 ≈ 900 字,其中约 60 字是与条数无关的
    // 固定开销(规则 9 + 「可用策略:」表头)。每多一条策略只多它自己那一块。
    const base = buildContext(ctxInputs([])).system_text.length;
    const grew = built.system_text.length - base;
    expect(grew).toBeLessThan(1200);
    const one = buildContext(ctxInputs([specs[0]!])).system_text.length - base;
    expect(one).toBeLessThan(700);
    expect(grew - one).toBeLessThan(550); // 第二条的边际成本
  });

  it('turns each strategy’s checklist into registered, sourced evidence', () => {
    const lib = fresh().strategies;
    const built = buildContext(ctxInputs([lib.head('range_mean_reversion')!]));
    const rev = built.evidence.find((e) => e.label.includes('回归统计'))!;
    expect(rev).toBeDefined();
    expect(rev.kind).toBe('checklist');
    expect(rev.source).toBe('reversionStats()');
    expect(rev.value).toContain('回归');
    expect(built.evidence.some((e) => e.label.includes('偏离/震荡清单'))).toBe(true);
  });

  it('says "不可得" instead of inventing numbers when the inputs are missing', () => {
    const lib = fresh().strategies;
    const thin = bars(80, (i) => 60000 + i);
    const built = buildContext({ ...ctxInputs([lib.head('range_mean_reversion')!], { '15m': thin }), klines: { '15m': thin } });
    const rev = built.evidence.find((e) => e.label.includes('回归统计'))!;
    expect(rev.value).toContain('不足 400 根');
    expect(rev.value).toContain('不得按本策略 PROPOSE');
  });

  it('renderStrategies is short and stable', () => {
    const text = renderStrategies(BUILTIN_STRATEGIES.slice(0, 2));
    expect(text).toContain('入场:');
    expect(text).toContain('失效:');
    expect(text).toContain('离场:');
    expect(text).toContain('参数:');
  });
});

describe('judgment contract × strategy_id', () => {
  const refs = new Set(['E1']);
  const propose = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    action: 'PROPOSE', direction: 'long', confidence: 0.7, headline: '做多', thesis: '测试',
    reasons: ['理由 [E1]'], evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [],
    proposal: { direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: '59000', take_profits: ['62000'], rationale: '测试' },
    ...extra,
  });

  it('rejects an unknown strategy_id and a PROPOSE that names none', () => {
    const active = ['breakout_retest', 'mtf_alignment'];
    expect(validateJudgment(propose({ strategy_id: 'made_up' }), refs, { strategies: active }).errors.join()).toMatch(/not one of the active strategies/);
    expect(validateJudgment(propose(), refs, { strategies: active }).errors.join()).toMatch(/PROPOSE requires strategy_id/);
    const ok = validateJudgment(propose({ strategy_id: 'mtf_alignment' }), refs, { strategies: active });
    expect(ok.errors).toEqual([]);
    expect(ok.judgment!.strategy_id).toBe('mtf_alignment');
  });

  it('is unchanged when the context offered no strategies (recorded v2/v3 eval cases still validate)', () => {
    const r = validateJudgment(propose(), refs);
    expect(r.errors).toEqual([]);
    expect(r.judgment!.strategy_id).toBeNull();
  });

  it('WATCH / NO_TRADE never need a strategy_id', () => {
    const watch = { action: 'WATCH', direction: null, confidence: 0.3, headline: '观察', thesis: '测试', reasons: ['理由 [E1]'], evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: ['看回踩'], proposal: null };
    expect(validateJudgment(watch, refs, { strategies: ['breakout_retest'] }).errors).toEqual([]);
  });
});

// ---------------------------------------------------------------- 回测按策略拆 + 归因

function trade(over: Partial<BacktestTrade>): BacktestTrade {
  return {
    step_idx: 0, strategy_id: null, direction: 'long', entry: 'market', limit_price: null, proposed_at: NOW, fill_at: NOW, fill_price: 60000,
    stop: 59000, tp: 62000, exit_at: NOW + 3_600_000, exit_price: 61000, status: 'tp', close_reason: '止盈', r: 1, mae_r: -0.3, mfe_r: 1.2,
    bars_held: 8, reduced_fraction: 0, reduced_r: null, ...over,
  };
}
function step(over: Partial<BacktestStep>): BacktestStep {
  return {
    run_id: 'bt-1', idx: 0, at_ms: NOW, kind: 'scan', trigger: 'breakout:测试', visible_upto_ms: NOW, judgment: null,
    action: 'PROPOSE', direction: 'long', confidence: 0.7, gates: [], outcome: null, cost: null, strategy_id: null, error: null, ...over,
  };
}

describe('per-strategy breakdown', () => {
  it('splits trades by strategy_id and buckets the unlabelled ones', () => {
    const trades = [
      trade({ step_idx: 0, strategy_id: 'breakout_retest', r: 2, mae_r: -0.2 }),
      trade({ step_idx: 1, strategy_id: 'breakout_retest', r: -1, mae_r: -1 }),
      trade({ step_idx: 2, strategy_id: 'mtf_alignment', r: 0.5, mae_r: -0.6 }),
      trade({ step_idx: 3, strategy_id: null, r: -1, mae_r: -1 }),
    ];
    const steps = [step({ idx: 0, strategy_id: 'breakout_retest' }), step({ idx: 1, strategy_id: 'breakout_retest' }), step({ idx: 2, strategy_id: 'mtf_alignment' }), step({ idx: 3 })];
    const by = breakdownByStrategy(trades, steps);
    expect(by['breakout_retest']).toMatchObject({ trades: 2, wins: 1, losses: 1, win_rate: 0.5, expectancy_r: 0.5, proposals: 2 });
    expect(by['breakout_retest']!.mae_r_p50).toBeCloseTo(-0.6, 5);
    expect(by['mtf_alignment']).toMatchObject({ trades: 1, wins: 1, expectancy_r: 0.5 });
    expect(by['unattributed']).toMatchObject({ trades: 1, losses: 1 });
  });
});

function fakeRun(): BacktestRun {
  return {
    id: 'bt-attr-1', created_at: NOW, symbol: 'BTCUSDT', timeframe: '15m', from_ms: NOW - 86_400_000, to_ms: NOW, mode: 'triggers',
    status: 'done',
    params: { symbol: 'BTCUSDT', timeframe: '15m', from: NOW - 86_400_000, to: NOW, mode: 'triggers', max_judgments: 20, review_every_close: false, brain: 'stub', brain_model: null, horizon_bars: 24, risk_pct: 0.5, max_opens_per_day: 4, strategy_ids: ['breakout_retest'], attribute: false },
    brain: 'stub', prompt_version: PROMPT_VERSION, progress: null,
    summary: {
      judgments: 8, scans: 6, reviews: 2, actions: { PROPOSE: 2, NO_TRADE: 6 }, trades: 2, wins: 0, losses: 2, flat: 0, win_rate: 0, avg_r: -1, sum_r: -2,
      max_drawdown_r: 2, avg_hold_bars: 6, cost: { input_tokens: 100, output_tokens: 20, cny: 0.01 }, model: 'stub', missed_move: null, bars: 96, candidates: 8, capped: false,
      trade_rows: [trade({ step_idx: 0, strategy_id: 'breakout_retest', r: -1, status: 'stop', close_reason: '止损' }), trade({ step_idx: 1, strategy_id: 'breakout_retest', r: -1, status: 'stop', close_reason: '止损' })],
      strategies: [{ id: 'breakout_retest', version: 1, content_hash: 'abc', status: 'paper' }],
      by_strategy: { breakout_retest: { trades: 2, wins: 0, losses: 2, win_rate: 0, expectancy_r: -1, sum_r: -2, mae_r_p50: -1, proposals: 2 } },
    },
    error: null,
  };
}

function fakeBrain(text: string): Brain {
  return { name: 'stub', async complete() { return { text, latency_ms: 1, model: 'stub', input_tokens: 10, output_tokens: 5 }; } };
}

const ATTR_JSON = JSON.stringify([
  { title: '追单太远', strategy_id: 'breakout_retest', symbol: 'BTCUSDT', evidence_said: '清单写着距突破位 1.4 ATR', rule_said: '1.5 ATR 以内可以追', actual: '两笔都在入场后立刻回抽打止损', proposal: { kind: 'param', strategy_id: 'breakout_retest', param: 'chase_atr_max', value: 1, text: '' } },
  { title: '失效条件不可判定', strategy_id: 'breakout_retest', symbol: 'BTCUSDT', evidence_said: '收盘价在突破位下方', rule_said: '"结构坏了"没有价位', actual: '复查判 HOLD 一直拖到止损', proposal: { kind: 'rule_wording', strategy_id: 'breakout_retest', text: '失效改为:15m 收盘回到突破位下方即离场' } },
  { title: '越界参数(应当被丢掉)', strategy_id: 'breakout_retest', evidence_said: 'x', rule_said: 'y', actual: 'z', proposal: { kind: 'param', strategy_id: 'breakout_retest', param: 'chase_atr_max', value: 99, text: '' } },
]);

describe('attribution', () => {
  it('parses ≤ 3 points, drops out-of-range param proposals, keeps typed proposals', () => {
    const lib = fresh().strategies;
    const points = parseAttribution(ATTR_JSON, fakeRun(), [lib.head('breakout_retest')!], NOW);
    expect(points).toHaveLength(2);
    expect(points[0]!.proposal).toMatchObject({ kind: 'param', param: 'chase_atr_max', value: 1 });
    expect(points[0]!.proposal.text).toContain('1.5ATR → 1ATR');
    expect(points[1]!.proposal.kind).toBe('rule_wording');
    expect(points.every((p) => p.evidence_said && p.rule_said && p.actual)).toBe(true);
    expect(parseAttribution('这不是 JSON', fakeRun(), [])).toEqual([]);
  });

  it('runAttribution writes rows AND proposed memories, and applies nothing', async () => {
    const store = fresh();
    const run = fakeRun();
    store.saveBacktestRun(run);
    const before = store.strategies.head('breakout_retest')!;
    const saved: AttributionPoint[] = [];
    const r = await runAttribution(run, [], run.summary!.trade_rows, [before], {
      brain: fakeBrain(ATTR_JSON),
      memory: store.memory,
      save: (a) => {
        saved.push(a);
        store.saveAttribution(a);
      },
      now: NOW,
    });
    expect(r.error).toBeNull();
    expect(r.points).toHaveLength(2);
    expect(saved).toHaveLength(2);
    expect(store.attributions(run.id)).toHaveLength(2);

    // 每条都留下一条 proposed 记忆,一条都没被批准。
    const mems = store.memory.list({ status: ['proposed'] });
    expect(mems).toHaveLength(2);
    expect(store.memory.counts().active).toBe(0);
    expect(mems.map((m) => m.kind).sort()).toEqual(['calibration', 'lesson']);
    for (const m of mems) {
      expect(m.source_refs).toContain(run.id);
      expect(m.tags).toContain('breakout_retest');
      expect(m.tags).toContain('backtest_attribution');
      expect(m.proposed_by).toBe('agent');
    }
    expect(attributionMemoryContent(r.points[0]!)).toContain('噪声底');

    // 策略本身一个字都没动:同一 head、同一 hash、同一版本、同一参数。
    const after = store.strategies.head('breakout_retest')!;
    expect(after.version).toBe(before.version);
    expect(after.content_hash).toBe(before.content_hash);
    expect(after.params['chase_atr_max']!.value).toBe(1.5);
    expect(store.strategies.versions('breakout_retest').map((v) => v.version)).toEqual([2, 1]); // v2 是开机建的草稿,归因没再加版本
  });

  it('a brain failure yields no points and no memories, not an exception', async () => {
    const store = fresh();
    const run = fakeRun();
    const broken: Brain = { name: 'stub', async complete() { throw new Error('大脑挂了'); } };
    const r = await runAttribution(run, [], [], [], { brain: broken, memory: store.memory, save: () => {}, now: NOW });
    expect(r.error).toMatch(/大脑挂了/);
    expect(r.points).toEqual([]);
    expect(store.memory.counts().proposed).toBe(0);
  });

  it('adopting a param proposal creates a draft version with exactly that value', () => {
    const store = fresh();
    const lib = store.strategies;
    const head = lib.head('breakout_retest')!;
    const points = parseAttribution(ATTR_JSON, fakeRun(), [head], NOW);
    const param = points.find((p) => p.proposal.kind === 'param')!;
    const { spec, error } = lib.createVersion('breakout_retest', { params: { [param.proposal.param!]: param.proposal.value! } }, { now: NOW });
    expect(error).toBeNull();
    expect(spec!.status).toBe('draft');
    expect(spec!.params['chase_atr_max']!.value).toBe(1);
    expect(spec!.version).toBe(head.version + 1);
    store.saveAttribution({ ...param, applied_version: spec!.version });
    expect(store.attribution(param.id)!.applied_version).toBe(head.version + 1);
  });
});

// ---------------------------------------------------------------- STATUS_ORDER 与 index 导出的稳定性

describe('status order', () => {
  it('is the promotion ladder the routes and the UI both read', () => {
    expect(STATUS_ORDER).toEqual(['draft', 'backtest', 'shadow', 'paper', 'live_capped']);
  });
});


it('event subkind subscriptions wake only matching structured hits and preserve the timeframe floor', () => {
  const base = BUILTIN_STRATEGIES.find(s => s.id === 'breakout_retest')!;
  const s = { ...base, evidence: { indicators: [], events: ['cpi' as const, 'unlock' as const] } };
  expect(strategyWakes(s, '15m', [{ kind: 'event', event_subkind: 'cpi' }])).toBe(true);
  expect(strategyWakes(s, '15m', [{ kind: 'event', event_subkind: 'unlock' }])).toBe(true);
  expect(strategyWakes(s, '15m', [{ kind: 'event', event_subkind: 'fomc' }])).toBe(false);
  expect(strategyWakes(s, '15m', [{ kind: 'event' }])).toBe(false);
  expect(strategyWakes(s, '5m', [{ kind: 'event', event_subkind: 'cpi' }])).toBe(false);
  expect(strategyWakes(s, '15m', [{ kind: 'breakout' }])).toBe(false);
});
