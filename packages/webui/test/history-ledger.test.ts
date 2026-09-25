/**
 * 复盘页纯逻辑:centerStats 口径(对齐网关 analyzer.centerStats)、分层键、簇均值 alpha、
 * regret 拆「该走没走 / 不该走走了」、观察门槛、策略深链、候选腿统计。
 */
import { describe, expect, it } from 'vitest';
import type { CandidateRow, LedgerRowV2 } from '../src/api/ledger-v2';
import { alphaCenter, candidateLegStats, centerStats, groupRows, isObservation, ledgerKeyOf, regretExitOf, regretHoldOf, regretSplit, rowEligible, strategyHref, UNNAMED_STRATEGY } from '../src/components/history/ledger-stats';

function row(p: Partial<LedgerRowV2>): LedgerRowV2 {
  return {
    version: 'jl-v2',
    episode_id: p.episode_id ?? `ep-${Math.random().toString(36).slice(2)}`,
    at: 1,
    as_of: 1,
    symbol: 'BTCUSDT',
    timeframe: '15m',
    mode: 'scan',
    thread_id: null,
    strategy_id: null,
    model_action: 'PROPOSE',
    model_dir: null,
    council_dir: null,
    council_agree: null,
    mechanical_dir: null,
    mechanical_note: null,
    horizon_end_at: 2,
    outcome_r_model: null,
    outcome_r_council: null,
    outcome_r_mechanical: null,
    outcome_source_model: null,
    regret_review: null,
    settled_at: null,
    settle_note: null,
    snapshot: null,
    review: null,
    legs: { model: null, council: null, mechanical: null },
    regret: null,
    ...p,
  } as LedgerRowV2;
}

const regret = (hold_r: number, exit_now_r: number, extra: Record<string, number | null> = {}) => ({ hold_r, exit_now_r, chosen_r: 0, best_r: 0, regret_r: 0, hold_status: 'expired', note: '', ...extra });

describe('centerStats(对齐网关 analyzer.centerStats)', () => {
  it('空样本全 null', () => {
    expect(centerStats([])).toMatchObject({ n: 0, mean: null, median: null, trimmed_mean: null, trimmed_each_side: 0 });
  });
  it('n < 10 不截尾,截尾均值 = 均值;偶数个中位数取中间两个均值', () => {
    const c = centerStats([4, 1, 3, 2]);
    expect(c.trimmed_each_side).toBe(0);
    expect(c.mean).toBe(2.5);
    expect(c.trimmed_mean).toBe(2.5);
    expect(c.median).toBe(2.5);
  });
  it('n = 10 两端各截 1;极端值被截掉', () => {
    const c = centerStats([1, 1, 1, 1, 1, 1, 1, 1, 1, 100]);
    expect(c.trimmed_each_side).toBe(1);
    expect(c.mean).toBeCloseTo(10.9);
    expect(c.median).toBe(1);
    expect(c.trimmed_mean).toBe(1);
  });
  it('n = 33 → floor(3.3) = 3;非有限值不进', () => {
    const xs = Array.from({ length: 33 }, (_, i) => i);
    expect(centerStats([...xs, Number.NaN, Number.POSITIVE_INFINITY]).trimmed_each_side).toBe(3);
    expect(centerStats([...xs, Number.NaN]).n).toBe(33);
  });
});

describe('分层键与过滤', () => {
  it('旧行缺键记 unknown;扫描行的持仓原因记 (scan);没策略记 (未指明策略)', () => {
    const scan = row({ mode: 'scan' });
    expect(ledgerKeyOf(scan, 'trigger_kind')).toBe('unknown');
    expect(ledgerKeyOf(scan, 'prompt_version')).toBe('unknown');
    expect(ledgerKeyOf(scan, 'holding_reason')).toBe('(scan)');
    expect(ledgerKeyOf(scan, 'strategy')).toBe(UNNAMED_STRATEGY);
    const rev = row({ mode: 'review', holding_reason: 'thesis_intact', trigger_kind: 'event', prompt_version: 'v11' });
    expect(ledgerKeyOf(rev, 'holding_reason')).toBe('thesis_intact');
    expect(ledgerKeyOf(rev, 'trigger_kind')).toBe('event');
  });
  it('holding_reason 分组只收复查行', () => {
    const g = groupRows([row({ mode: 'scan' }), row({ mode: 'review', holding_reason: 'a' }), row({ mode: 'review' })], 'holding_reason');
    expect([...g.keys()].sort()).toEqual(['a', 'unknown']);
  });
  it('结算不完整的行不合格', () => {
    expect(rowEligible(row({ settlement_status: 'partial' }))).toBe(false);
    expect(rowEligible(row({ settlement_status: 'complete' }))).toBe(true);
    expect(rowEligible(row({}))).toBe(true);
  });
});

describe('alphaCenter:簇均值后的判断增量分布', () => {
  it('同一簇多行先平均,未结算 / 缺腿 / 不完整不进', () => {
    const rows = [
      row({ cluster_id: 'a', settled_at: 1, outcome_r_model: 1, outcome_r_council: 0 }),
      row({ cluster_id: 'a', settled_at: 1, outcome_r_model: 3, outcome_r_council: 0 }), // 簇 a 均值 2
      row({ cluster_id: 'b', settled_at: 1, outcome_r_model: -1, outcome_r_council: 0 }), // 簇 b -1
      row({ cluster_id: 'c', settled_at: null, outcome_r_model: 5, outcome_r_council: 0 }),
      row({ cluster_id: 'd', settled_at: 1, outcome_r_model: 5, outcome_r_council: null }),
      row({ cluster_id: 'e', settled_at: 1, outcome_r_model: 5, outcome_r_council: 0, settlement_status: 'missing' }),
    ];
    const a = alphaCenter(rows);
    expect(a.pairs).toBe(3);
    expect(a.n).toBe(2);
    expect(a.mean).toBe(0.5);
    expect(a.median).toBe(0.5);
  });
});

describe('regret 拆分', () => {
  it('HOLD 进「该走没走」、EXIT 进「不该走走了」,旧行按公式回推', () => {
    const hold = row({ mode: 'review', model_action: 'HOLD', settled_at: 1, regret: regret(-1, 0.5, { regret_hold: 1.5, regret_exit: null }) as never });
    const holdOld = row({ mode: 'review', model_action: 'ADD', settled_at: 1, regret: regret(0.2, 1) as never });
    const exit = row({ mode: 'review', model_action: 'EXIT', settled_at: 1, regret: regret(2, 0, { regret_hold: null, regret_exit: 2 }) as never });
    const exitOld = row({ mode: 'review', model_action: 'INVALIDATE', settled_at: 1, regret: regret(-1, 0) as never });
    expect(regretHoldOf(hold)).toBe(1.5);
    expect(regretHoldOf(holdOld)).toBeCloseTo(0.8);
    expect(regretHoldOf(exit)).toBeNull();
    expect(regretExitOf(exit)).toBe(2);
    expect(regretExitOf(exitOld)).toBe(0);
    const s = regretSplit([hold, holdOld, exit, exitOld, row({ mode: 'review', model_action: 'HOLD' }), row({ mode: 'scan' })]);
    expect(s.reviews).toBe(5);
    expect(s.scored).toBe(4);
    expect(s.hold.n).toBe(2);
    expect(s.hold.over_half_share).toBe(1);
    expect(s.exit.n).toBe(2);
    expect(s.exit.over_half_share).toBe(0.5);
  });
});

describe('观察门槛与深链', () => {
  it('< 30 为观察', () => {
    expect(isObservation(29)).toBe(true);
    expect(isObservation(30)).toBe(false);
  });
  it('rs_ 直接链、内置名经 lab_strategy_id 反查、合成/未指明/变体不链', () => {
    const idx = [{ id: 'rs_1', name: 'x', lab_strategy_id: 'breakout_retest' }];
    expect(strategyHref('rs_1', idx)).toBe('#my-strategies?id=rs_1');
    expect(strategyHref('breakout_retest', idx)).toBe('#my-strategies?id=rs_1');
    expect(strategyHref('breakout_retest_v3', idx)).toBeNull();
    expect(strategyHref('synth:donchian_close_long_v1:1h', idx)).toBeNull();
    expect(strategyHref(UNNAMED_STRATEGY, idx)).toBeNull();
    expect(strategyHref(null, idx)).toBeNull();
  });
});

describe('候选腿统计', () => {
  it('只收 plan_walk,缺值跳过', () => {
    const c = (source: string, plan: number | null, trail: number | null, net: number | null = null) =>
      ({ settlement: { source, settled_at: 1, bars_seen: 1, note: '', plan: { status: 'x', r: plan, net_r: net, fill_price: null, exit_price: null, bars_held: null }, trail: trail === null ? null : { status: 'x', r: trail, fill_price: null, exit_price: null, bars_held: null } } }) as unknown as CandidateRow;
    const s = candidateLegStats([c('plan_walk', 2, 1, 1.9), c('plan_walk', -1, null), c('invalid', 5, 5), { settlement: null } as unknown as CandidateRow]);
    expect(s.plan.n).toBe(2);
    expect(s.plan.mean).toBe(0.5);
    expect(s.trail.n).toBe(1);
    expect(s.net.n).toBe(1);
  });
});
