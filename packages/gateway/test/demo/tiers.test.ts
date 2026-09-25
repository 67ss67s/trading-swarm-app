/**
 * 短 / 中 / 长分层(契约 §9.37;设计 docs/design/attribution-and-tiers-2026-09-12.md §2)。
 *
 * 最重要的一条不是「配额生效」,而是**「默认什么也不改」** —— 分层是一套新闸,
 * 新闸的默认必须和上线之前逐字同一个行为,否则这次发布会在用户没按任何按钮的情况下改掉钱的行为。
 */
import { describe, expect, it } from 'vitest';
import { evaluateGates, tierGates, DEFAULT_GATES } from '../../src/demo/gates.js';
import {
  applyWorkflowPatch,
  DEFAULT_TIER_POLICY,
  DEFAULT_WORKFLOW,
  loadWorkflow,
  normalizeTierPolicies,
  tierPolicyOf,
  tierSlotsOf,
} from '../../src/demo/workflow.js';
import { allocatorDecide, type AllocatorInputs } from '../../src/demo/strategy-allocator.js';
import { TIER_OF, tierOf, tierOfTimeframe } from '../../src/demo/types.js';
import type { AccountView, Judgment, MarketView, TierPolicy } from '../../src/demo/types.js';
import type { StrategyFamily, StrategySpec } from '../../src/demo/strategies.js';
import type { StrategyHorizon } from '../../src/demo/horizon.js';

const NOW = 1_760_000_000_000;
const DAY = 24 * 3_600_000;

// ---------------------------------------------------------------- 映射

describe('horizon → tier 映射', () => {
  it('scalp/intraday = 短线,swing = 中线,position = 长线', () => {
    expect(TIER_OF).toEqual({ scalp: 'short', intraday: 'short', swing: 'mid', position: 'long' });
  });

  it('没有 horizon 的东西按周期推,口径与 inferHorizon 一致', () => {
    expect(tierOfTimeframe('5m')).toBe('short');
    expect(tierOfTimeframe('1h')).toBe('short');
    expect(tierOfTimeframe('4h')).toBe('mid');
    expect(tierOfTimeframe('1d')).toBe('long');
    expect(tierOf({ horizon: 'swing', timeframe: '15m' })).toBe('mid'); // horizon 优先于周期
    expect(tierOf({ timeframe: '4h' })).toBe('mid');
    expect(tierOf(null)).toBeNull();
    expect(tierOf({})).toBeNull();
  });
});

// ---------------------------------------------------------------- workflow

describe('workflow.tier_policy', () => {
  it('出厂值三层全 0 / 空 = 不额外限制', () => {
    for (const tier of ['short', 'mid', 'long'] as const) {
      expect(DEFAULT_WORKFLOW.tier_policy[tier]).toEqual(DEFAULT_TIER_POLICY);
    }
    expect(tierSlotsOf(DEFAULT_WORKFLOW)).toEqual({}); // 没有一层设名额 = allocator 不限
  });

  it('部分合并:只传一层一个字段,其它格不动', () => {
    const { next, errors } = applyWorkflowPatch(DEFAULT_WORKFLOW, { tier_policy: { short: { max_opens_per_day: 2 } } });
    expect(errors).toEqual([]);
    expect(next.tier_policy.short.max_opens_per_day).toBe(2);
    expect(next.tier_policy.short.max_open_threads).toBe(0);
    expect(next.tier_policy.mid).toEqual(DEFAULT_TIER_POLICY);
    expect(next.tier_policy.long).toEqual(DEFAULT_TIER_POLICY);
  });

  it('越界 / 不认识的层 / 非法 entry_styles 报错而不是静默钳', () => {
    const bad = applyWorkflowPatch(DEFAULT_WORKFLOW, { tier_policy: { short: { max_opens_per_day: 99 } } });
    expect(bad.errors.join()).toContain('tier_policy.short.max_opens_per_day');
    expect(bad.next.tier_policy.short.max_opens_per_day).toBe(0); // 没写进去

    const unknownTier = applyWorkflowPatch(DEFAULT_WORKFLOW, { tier_policy: { huge: { max_opens_per_day: 1 } } });
    expect(unknownTier.errors.join()).toContain('不认识');

    const badStyle = applyWorkflowPatch(DEFAULT_WORKFLOW, { tier_policy: { mid: { entry_styles: ['teleport'] } } });
    expect(badStyle.errors.join()).toContain('entry_styles');
    expect(badStyle.next.tier_policy.mid.entry_styles).toEqual([]);
  });

  it('entry_styles 去重并保留顺序', () => {
    const { next, errors } = applyWorkflowPatch(DEFAULT_WORKFLOW, { tier_policy: { long: { entry_styles: ['limit', 'limit', 'market'] } } });
    expect(errors).toEqual([]);
    expect(next.tier_policy.long.entry_styles).toEqual(['limit', 'market']);
  });

  it('老库缺字段 / 手改坏 → fail-closed 回默认(= 不限),不回一个乱数', () => {
    const old = loadWorkflow(JSON.stringify({ ...DEFAULT_WORKFLOW, tier_policy: undefined }));
    expect(old.tier_policy.short).toEqual(DEFAULT_TIER_POLICY);

    const broken = loadWorkflow(JSON.stringify({ ...DEFAULT_WORKFLOW, tier_policy: { short: { max_opens_per_day: 'two', allocator_slots: -3 }, mid: 'nope' } }));
    expect(broken.tier_policy.short).toEqual(DEFAULT_TIER_POLICY);
    expect(broken.tier_policy.mid).toEqual(DEFAULT_TIER_POLICY);

    expect(normalizeTierPolicies(null).long).toEqual(DEFAULT_TIER_POLICY);
    expect(normalizeTierPolicies([1, 2, 3]).long).toEqual(DEFAULT_TIER_POLICY);
  });

  it('tierSlotsOf 只收 > 0 的层', () => {
    const { next } = applyWorkflowPatch(DEFAULT_WORKFLOW, { tier_policy: { short: { allocator_slots: 1 }, long: { allocator_slots: 2 } } });
    expect(tierSlotsOf(next)).toEqual({ short: 1, long: 2 });
    expect(tierPolicyOf(next, 'short').allocator_slots).toBe(1);
  });
});

// ---------------------------------------------------------------- 分层闸

const account: AccountView = { equity: '10000', available: '10000', unrealized_pnl: '0', positions: [], as_of: NOW } as unknown as AccountView;
const market: MarketView = { symbol: 'BTCUSDT', mark: '100', as_of: NOW } as unknown as MarketView;

function judgment(over: Partial<Judgment> = {}): Judgment {
  return {
    action: 'PROPOSE',
    direction: 'long',
    confidence: 0.7,
    headline: 'x',
    thesis: 'x',
    reasons: [],
    evidence_refs: [],
    watch_conditions: [],
    invalidation: null,
    proposal: { direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: '98', take_profit_price: '104' },
    ...over,
  } as unknown as Judgment;
}

function policy(over: Partial<TierPolicy> = {}): TierPolicy {
  return { ...DEFAULT_TIER_POLICY, ...over };
}

describe('分层闸(gates.ts)', () => {
  it('不传 tier 上下文 = 一行闸都不多(旧调用逐字不受影响)', () => {
    const withoutTier = evaluateGates(judgment(), { halted: false, paused: false, account, market, opens_today: 0, stale_refs: new Set(), now: NOW });
    const withTier = evaluateGates(judgment(), { halted: false, paused: false, account, market, opens_today: 0, stale_refs: new Set(), now: NOW, tier: { tier: 'short', opens_today: 0, open_threads: 0, policy: policy() } });
    expect(withTier.length).toBe(withoutTier.length + 3);
    expect(withoutTier.some((g) => g.name.includes('短线'))).toBe(false);
  });

  it('配额全 0 时三行闸都在、都通过(闸的行数不随配置变化,否则「今天为什么少了一行闸」又是黑盒)', () => {
    const rows = tierGates(judgment(), { tier: 'short', opens_today: 9, open_threads: 9, policy: policy() });
    expect(rows.map((g) => g.name)).toEqual(['短线每日开仓上限', '短线容量上限', '短线入场方式']);
    expect(rows.every((g) => g.passed)).toBe(true);
    expect(rows[0]!.reason).toContain('继承全局');
  });

  it('本层每日开仓上限 1、今天已开 1 → 拒;还没开 → 过', () => {
    const blocked = tierGates(judgment(), { tier: 'short', opens_today: 1, open_threads: 0, policy: policy({ max_opens_per_day: 1 }) });
    expect(blocked[0]).toMatchObject({ passed: false });
    expect(blocked[0]!.reason).toContain('1/1');
    const ok = tierGates(judgment(), { tier: 'short', opens_today: 0, open_threads: 0, policy: policy({ max_opens_per_day: 1 }) });
    expect(ok[0]!.passed).toBe(true);
  });

  it('本层容量上限按在手线程数判', () => {
    const blocked = tierGates(judgment(), { tier: 'mid', opens_today: 0, open_threads: 2, policy: policy({ max_open_threads: 2 }) });
    expect(blocked[1]).toMatchObject({ name: '中线容量上限', passed: false });
    expect(blocked[1]!.reason).toContain('2/2');
  });

  it('本层入场方式:只允许 limit 时市价提议被拒,限价提议放行', () => {
    const p = policy({ entry_styles: ['limit'] });
    const marketProposal = tierGates(judgment(), { tier: 'long', opens_today: 0, open_threads: 0, policy: p });
    expect(marketProposal[2]).toMatchObject({ name: '长线入场方式', passed: false });
    const limitProposal = tierGates(judgment({ proposal: { direction: 'long', entry: 'limit', limit_price: '99', entry_zone: null, stop_price: '98', take_profit_price: '104' } as Judgment['proposal'] }), { tier: 'long', opens_today: 0, open_threads: 0, policy: p });
    expect(limitProposal[2]!.passed).toBe(true);
  });

  it('没有 proposal(NO_TRADE 之类)时入场方式闸不适用,也不会误拒', () => {
    const rows = tierGates(judgment({ proposal: null }), { tier: 'short', opens_today: 0, open_threads: 0, policy: policy({ entry_styles: ['limit'] }) });
    expect(rows[2]).toMatchObject({ passed: true, reason: '不适用' });
  });

  it('分层闸只在 PROPOSE 上判:EXIT 不会因为本层满了而被拦住', () => {
    const rows = evaluateGates(judgment({ action: 'EXIT', proposal: null }), {
      halted: false, paused: false, account, market, opens_today: 0, stale_refs: new Set(), now: NOW,
      tier: { tier: 'short', opens_today: 99, open_threads: 99, policy: policy({ max_opens_per_day: 1, max_open_threads: 1 }) },
    });
    expect(rows.some((g) => g.name.includes('短线'))).toBe(false);
    expect(rows.every((g) => g.passed)).toBe(true);
  });

  it('全局每日上限与分层每日上限各判各的(严的那个先拦住)', () => {
    const rows = evaluateGates(judgment(), {
      halted: false, paused: false, account, market, opens_today: 0, stale_refs: new Set(), now: NOW,
      tier: { tier: 'short', opens_today: 3, open_threads: 0, policy: policy({ max_opens_per_day: 3 }) },
    }, { ...DEFAULT_GATES, max_opens_per_day: 10 });
    expect(rows.find((g) => g.name === '每日开仓上限')!.passed).toBe(true);
    expect(rows.find((g) => g.name === '短线每日开仓上限')!.passed).toBe(false);
  });
});

// ---------------------------------------------------------------- allocator 按层名额

function spec(id: string, opts: { horizon?: StrategyHorizon; family?: StrategyFamily; expectancy?: number } = {}): StrategySpec {
  return {
    id,
    version: 1,
    content_hash: `h-${id}`,
    name: id,
    family: opts.family ?? 'trend_continuation',
    horizon: opts.horizon ?? 'intraday',
    status: 'paper',
    trigger: { kinds: ['breakout'], min_timeframe: '15m', cooldown_bars: 1 },
    checklist: { required: [], optional: [], min_bars: 60 },
    rules: { entry: [], invalidation: [], exit: [], sizing: [] },
    params: {},
    evidence: { indicators: [{ id: `ind-${id}`, tf: '1h' }], events: [], info_topics: [] },
    eval_stats: { backtests: 0, trades: 0, win_rate: null, expectancy_r: null, total_r: 0, last_run_at: null },
    lab_stats: { run_id: 'r', at: NOW, symbols: 5, setups: 50, n: 60, effective_n: 60, win_rate: 0.5, expectancy_r: opts.expectancy ?? 1, net: { expectancy_r: opts.expectancy ?? 1, total_r: 0 }, total_r: 0, note: '' },
    created_at: NOW - 30 * DAY,
    parent_version: null,
  } as unknown as StrategySpec;
}

function inputs(over: Partial<AllocatorInputs> & Pick<AllocatorInputs, 'specs'>): AllocatorInputs {
  return {
    now: NOW,
    mode: 'auto',
    active: [],
    max: 4,
    regime: null,
    realized_r: () => [],
    entered_at: () => NOW - 30 * DAY,
    removed_at: () => null,
    ...over,
  };
}

describe('allocator 按层名额(§9.37)', () => {
  it('short 名额 1、两条 short 候选 → 期望低的那条 blocked_by=tier_slot', () => {
    const { decision, candidates } = allocatorDecide(inputs({
      specs: [
        spec('a', { horizon: 'scalp', family: 'trend_continuation', expectancy: 2 }),
        spec('b', { horizon: 'intraday', family: 'volatility', expectancy: 1 }),
      ],
      tier_slots: { short: 1 },
    }));
    expect(decision.to).toEqual(['a']);
    const b = candidates.find((c) => c.id === 'b')!;
    expect(b.blocked_by).toBe('tier_slot');
    expect(b.reason).toContain('短线层名额 1 个已被 a 占满');
    expect(b.tier).toBe('short');
  });

  it('名额是按层独立的:short 满了不影响 mid / long', () => {
    const { decision, candidates } = allocatorDecide(inputs({
      specs: [
        spec('a', { horizon: 'scalp', family: 'trend_continuation', expectancy: 3 }),
        spec('b', { horizon: 'intraday', family: 'volatility', expectancy: 2 }),
        spec('c', { horizon: 'swing', family: 'mtf_alignment', expectancy: 1 }),
        spec('d', { horizon: 'position', family: 'mean_reversion', expectancy: 0.5 }),
      ],
      tier_slots: { short: 1 },
    }));
    expect(decision.to).toEqual(['a', 'c', 'd']);
    expect(candidates.find((c) => c.id === 'c')!.tier).toBe('mid');
    expect(candidates.find((c) => c.id === 'd')!.tier).toBe('long');
  });

  it('不传 tier_slots / 某层为 0 = 该层不限(默认行为逐字不变)', () => {
    const specs = [
      spec('a', { horizon: 'scalp', family: 'trend_continuation', expectancy: 2 }),
      spec('b', { horizon: 'intraday', family: 'volatility', expectancy: 1 }),
    ];
    expect(allocatorDecide(inputs({ specs })).decision.to).toEqual(['a', 'b']);
    expect(allocatorDecide(inputs({ specs, tier_slots: { short: 0 } })).decision.to).toEqual(['a', 'b']);
  });

  it('层名额判在「每族 1 条」之后:同族先去重,剩下的才争层名额', () => {
    const { candidates } = allocatorDecide(inputs({
      specs: [
        spec('a', { horizon: 'scalp', family: 'trend_continuation', expectancy: 3 }),
        spec('b', { horizon: 'scalp', family: 'trend_continuation', expectancy: 2 }), // 同族,先被 family_taken 挡
        spec('c', { horizon: 'intraday', family: 'volatility', expectancy: 1 }),
      ],
      tier_slots: { short: 1 },
    }));
    expect(candidates.find((c) => c.id === 'b')!.blocked_by).toBe('family_taken');
    expect(candidates.find((c) => c.id === 'c')!.blocked_by).toBe('tier_slot');
  });
});
