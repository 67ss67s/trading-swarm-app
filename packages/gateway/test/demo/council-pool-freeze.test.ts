/**
 * §9.36 —— 内部评审记录 P1-06 / P1-11 的**每一条反例**转成用例。
 *
 * 这四条不是「加功能」,是 09-12 那一版接线没接上的洞:400 根被覆盖成 120、停用被 Radar 绕过、
 * 只钉主策略、同 ID 新版本没票。每个 it 的标题就是它对应的那条反例。
 */
import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_TF_BARS,
  effectivePoolIds,
  klinePlan,
  pinnedPoolFrom,
  poolGuard,
  poolHash,
  poolKeys,
  runCouncil,
  snapshotOf,
  type CouncilInputs,
  type CouncilSnapshot,
} from '../../src/demo/strategy-council.js';
import { evidenceGaps, evidencePlan, indicatorKey, renderIndicator } from '../../src/demo/evidence-plan.js';
import { indicatorSnapshot, indicatorWithParams } from '../../src/demo/indicators.js';
import type { StrategySpec, StrategyStatus } from '../../src/demo/strategies.js';
import type { Kline, MarketView } from '../../src/demo/types.js';

const NOW = 1_760_000_000_000;

function spec(id: string, over: Partial<StrategySpec> = {}): StrategySpec {
  return {
    id,
    version: 1,
    content_hash: `h-${id}-1`,
    name: id,
    family: 'trend_continuation',
    horizon: 'intraday',
    status: 'paper' as StrategyStatus,
    trigger: { kinds: ['breakout'], min_timeframe: '15m', cooldown_bars: 1 },
    checklist: { required: [], optional: [], min_bars: 60 },
    rules: { entry: [], invalidation: [], exit: [], sizing: [] },
    params: {},
    evidence: { indicators: [{ id: 'rsi', tf: '1h' }], events: [], info_topics: [] },
    eval_stats: { backtests: 0, trades: 0, win_rate: null, expectancy_r: null, total_r: 0, last_run_at: null },
    lab_stats: null,
    created_at: NOW,
    parent_version: null,
    ...over,
  } as unknown as StrategySpec;
}

const bars = (n: number): Kline[] =>
  Array.from({ length: n }, (_, i) => ({
    open_time: NOW - (n - i) * 60_000,
    close_time: NOW - (n - i - 1) * 60_000,
    open: '100',
    high: '101',
    low: '99',
    close: `${100 + (i % 5)}`,
    volume: '10',
  })) as unknown as Kline[];

describe('P1-06 第 1 条:K 线深度按 tf 聚合取 max,不再后写覆盖前写', () => {
  it('主周期正好是 1h 时,400 根的策略不会被基线 120 覆盖', () => {
    const deep = spec('range', { checklist: { required: [], optional: [], min_bars: 400 } } as Partial<StrategySpec>);
    const plan = klinePlan({ primary_tf: '1h', pool: [deep] });
    expect(plan['1h']).toBeGreaterThanOrEqual(400);
  });

  it('主周期正好是 4h 时同理(旧代码会覆盖成 80)', () => {
    const deep = spec('range', { checklist: { required: [], optional: [], min_bars: 400 } } as Partial<StrategySpec>);
    const plan = klinePlan({ primary_tf: '4h', pool: [deep] });
    expect(plan['4h']).toBeGreaterThanOrEqual(400);
  });

  it('tf=15m 时三个周期各自独立,谁也不覆盖谁', () => {
    const deep = spec('range', { checklist: { required: [], optional: [], min_bars: 400 } } as Partial<StrategySpec>);
    const plan = klinePlan({ primary_tf: '15m', pool: [deep] });
    expect(plan['15m']).toBeGreaterThanOrEqual(400);
    expect(plan['1h']).toBeGreaterThanOrEqual(120);
    expect(plan['4h']).toBeGreaterThanOrEqual(80);
  });

  it('深度规划纳入 shadow / pinned / 候选(调用方把全票池传进来即可)', () => {
    const shallow = spec('a');
    const deepShadow = spec('vol', { status: 'shadow' as StrategyStatus, checklist: { required: [], optional: [], min_bars: 600 } } as Partial<StrategySpec>);
    const plan = klinePlan({ primary_tf: '15m', pool: [shallow, deepShadow] });
    expect(plan['15m']).toBeGreaterThanOrEqual(600);
  });

  it('evidence 点名的周期会被补齐,深度够算 EMA200 这类长窗口指标', () => {
    const s = spec('mfi', { evidence: { indicators: [{ id: 'mfi', tf: '30m' }], events: [], info_topics: [] } } as Partial<StrategySpec>);
    const plan = klinePlan({ primary_tf: '15m', pool: [s] });
    expect(plan['30m']).toBe(EVIDENCE_TF_BARS);
  });

  it('同一个 tf 只有一个数字(取 max),不会出现两条冲突的深度', () => {
    const plan = klinePlan({ primary_tf: '1h', pool: [spec('a')], extra: [{ tf: '1h', bars: 900 }, { tf: '1h', bars: 300 }] });
    expect(plan['1h']).toBe(900);
  });
});

  it('确认周期的深度不低于策略自己的 min_bars(不再 round(depth/2) 砍半)', () => {
    const deep = spec('range', { horizon: 'intraday', checklist: { required: [], optional: [], timeframes: ['4h'], min_bars: 400 } } as Partial<StrategySpec>);
    const plan = klinePlan({ primary_tf: '15m', pool: [deep] });
    const hpConfirm = plan['1h'] ?? 0; // intraday 的 confirm 周期
    expect(hpConfirm).toBeGreaterThanOrEqual(400);
    expect(plan['4h']).toBeGreaterThanOrEqual(400); // checklist 点名的周期同样要够深
  });

  it('冻结票池里的辅助票,它点名的 evidence 周期会被一起规划(取回要在拉数之前)', () => {
    const aux = spec('aux', { evidence: { indicators: [{ id: 'rsi', tf: '30m' }], events: [], info_topics: [] } } as Partial<StrategySpec>);
    const plan = klinePlan({ primary_tf: '15m', pool: [spec('main'), aux] });
    expect(plan['30m']).toBeGreaterThanOrEqual(EVIDENCE_TF_BARS);
  });

describe('P1-06 第 2 条:停用对 Radar 也有硬效力', () => {
  it('已从 active 停掉的策略,Radar 候选也塞不回正式票池', () => {
    expect(effectivePoolIds(['a', 'b'], 'ghost')).toEqual(['a', 'b']);
  });

  it('候选本来就在 active 里 → 只把它排到最前(优先),不改变集合', () => {
    expect(effectivePoolIds(['a', 'b'], 'b')).toEqual(['b', 'a']);
  });

  it('没有候选时原样返回并去重', () => {
    expect(effectivePoolIds(['a', 'a', 'b'], null)).toEqual(['a', 'b']);
  });
});

describe('P1-06 第 3 条:冻结的是全票池,不只主策略', () => {
  const council: CouncilInputs = {
    now: NOW,
    symbol: 'BTCUSDT',
    timeframe: '15m',
    features: [],
    klines: {},
    market: { mark: '100', last: '100', funding_rate: '', next_funding_at: 0, open_interest: '', as_of: NOW } as unknown as MarketView,
    oi_change_1h_pct: null,
    daily_regime: null,
    trigger_hits: [],
    strategies: [spec('a'), spec('b'), spec('c')],
    woken_ids: [],
    fit_for: () => ({}) as never,
    policy: { mode: 'advise', min_agree: 2, confidence_floor: 0.4 },
  };

  it('快照里有全票池 + pool_hash,votes 带 content_hash', () => {
    const snap = snapshotOf(runCouncil(council));
    expect(snap.pool?.map((p) => p.strategy_id).sort()).toEqual(['a', 'b', 'c']);
    expect(snap.pool_hash).toBe(poolHash([...snap.pool!].map((p) => ({ id: p.strategy_id, version: p.version, content_hash: p.content_hash }))));
    expect(snap.votes.every((v) => typeof v.content_hash === 'string')).toBe(true);
  });

  it('复查按快照版本取回:停用不会让辅助票消失,升级也换不掉它的规则', () => {
    const snap: CouncilSnapshot = {
      version: 'council-v1',
      at: NOW,
      direction: 'long',
      reached: true,
      agreeing: ['a'],
      dissenting: [],
      pool: [
        { strategy_id: 'a', version: 1, content_hash: 'h-a-1' },
        { strategy_id: 'b', version: 1, content_hash: 'h-b-1' },
      ],
      votes: [],
    };
    const v1 = { a: spec('a'), b: spec('b') };
    // 现在 a 已经升到 v2、b 已经从 active 停掉(head 仍在库里)。
    const r = pinnedPoolFrom(
      snap,
      (id, v) => (v === 1 ? (v1 as Record<string, StrategySpec>)[id] ?? null : null),
      (id) => spec(id, { version: 2, content_hash: `h-${id}-2` }),
    );
    expect(r.specs.map((s) => `${s.id}@${s.version}`)).toEqual(['a@1', 'b@1']);
    expect(r.missing).toEqual([]);
  });

  it('冻结版本取不到 → 这一票弃权,不拿 head 代投(09-12 复审 §2)', () => {
    const snap = { pool: [{ strategy_id: 'a', version: 7, content_hash: 'x' }], votes: [], agreeing: ['a'] } as unknown as CouncilSnapshot;
    const r = pinnedPoolFrom(snap, () => null, (id) => spec(id, { version: 9 }));
    expect(r.specs).toEqual([]);
    expect(r.abstained).toEqual(['a@7']);
    expect(r.missing[0]).toContain('a v7');
  });

  it('版本号对得上但 content_hash 对不上,也算取不到(同一版被覆盖写过)', () => {
    const snap = { pool: [{ strategy_id: 'a', version: 1, content_hash: 'h-a-1' }], votes: [], agreeing: ['a'] } as unknown as CouncilSnapshot;
    const r = pinnedPoolFrom(snap, (id) => spec(id, { content_hash: 'h-a-CHANGED' }), (id) => spec(id));
    expect(r.specs).toEqual([]);
    expect(r.abstained).toEqual(['a@1']);
    expect(r.missing[0]).toContain('hash 对不上');
  });

  it('旧快照(没有 pool 字段)退回 votes / agreeing,不报错', () => {
    const snap = { votes: [{ strategy_id: 'a', version: 3, stance: 'long', confidence: 1, fit: null }], agreeing: ['a'] } as unknown as CouncilSnapshot;
    const r = pinnedPoolFrom(snap, (id, v) => (v === 3 ? spec(id, { version: 3 }) : null), () => null);
    expect(r.specs.map((s) => s.version)).toEqual([3]);
  });
});

describe('P1-06 第 4 条:同 ID 双版本', () => {
  it('v1 是正式票时,v2 的 shadow 仍然拿到自己的 advisory 票', () => {
    const v1 = spec('bo', { version: 1, content_hash: 'h-bo-1' });
    const v2 = spec('bo', { version: 2, content_hash: 'h-bo-2', status: 'shadow' as StrategyStatus });
    const r = runCouncil({
      now: NOW,
      symbol: 'BTCUSDT',
      timeframe: '15m',
      features: [],
      klines: {},
      market: { mark: '100', last: '100', funding_rate: '', next_funding_at: 0, open_interest: '', as_of: NOW } as unknown as MarketView,
      oi_change_1h_pct: null,
      daily_regime: null,
      trigger_hits: [],
      strategies: [v1],
      advisory_strategies: [v2],
      woken_ids: [],
      fit_for: () => ({}) as never,
      policy: { mode: 'advise', min_agree: 2, confidence_floor: 0.4 },
    });
    expect(r.verdicts.map((v) => `${v.strategy_id}@${v.version}${v.advisory ? ':advisory' : ''}`)).toEqual(['bo@1', 'bo@2:advisory']);
  });

  it('同 ID 同版本仍然去重(不重复表态)', () => {
    const v1 = spec('bo', { version: 1 });
    const r = runCouncil({
      now: NOW,
      symbol: 'BTCUSDT',
      timeframe: '15m',
      features: [],
      klines: {},
      market: { mark: '100', last: '100', funding_rate: '', next_funding_at: 0, open_interest: '', as_of: NOW } as unknown as MarketView,
      oi_change_1h_pct: null,
      daily_regime: null,
      trigger_hits: [],
      strategies: [v1],
      advisory_strategies: [spec('bo', { version: 1 })],
      woken_ids: [],
      fit_for: () => ({}) as never,
      policy: { mode: 'advise', min_agree: 2, confidence_floor: 0.4 },
    });
    expect(r.verdicts).toHaveLength(1);
  });
});

describe('P1-11:evidence plan 的键含 params;缺证据 fail closed', () => {
  it('同一个 RSI 不同参数**不折叠**(以前永远只渲染 RSI14)', () => {
    const a = spec('a', { evidence: { indicators: [{ id: 'rsi', tf: '1h', params: { length: 14 } }], events: [], info_topics: [] } } as Partial<StrategySpec>);
    const b = spec('b', { evidence: { indicators: [{ id: 'rsi', tf: '1h', params: { length: 7 } }], events: [], info_topics: [] } } as Partial<StrategySpec>);
    const plan = evidencePlan([a, b]);
    expect(plan.indicators).toHaveLength(2);
    expect(new Set(plan.indicators.map(indicatorKey)).size).toBe(2);
    expect(plan.indicators.map((i) => i.required_by)).toEqual([['a'], ['b']]);
  });

  it('同 (id, tf) 且参数一样的两条策略仍然合并成一条,required_by 两个都记', () => {
    const a = spec('a', { evidence: { indicators: [{ id: 'rsi', tf: '1h' }], events: [], info_topics: [] } } as Partial<StrategySpec>);
    const b = spec('b', { evidence: { indicators: [{ id: 'rsi', tf: '1h' }], events: [], info_topics: [] } } as Partial<StrategySpec>);
    const plan = evidencePlan([a, b]);
    expect(plan.indicators).toHaveLength(1);
    expect(plan.indicators[0]!.required_by).toEqual(['a', 'b']);
  });

  it('evidenceGaps:K 线不够的周期 → 那条策略这轮有缺口', () => {
    const s = spec('mfi', { evidence: { indicators: [{ id: 'mfi', tf: '30m' }], events: [], info_topics: [] } } as Partial<StrategySpec>);
    const gaps = evidenceGaps([s], { '30m': bars(10) });
    expect(Object.keys(gaps)).toEqual(['mfi@1']); // 键带版本:同 ID 两个版本不共用缺口
    expect(gaps['mfi@1']![0]).toContain('30m mfi');
    expect(gaps['mfi@1']![0]).toContain('只有 10 根');
  });

  it('evidenceGaps:整个周期根本没拉到也算缺口(以前是 silently skip)', () => {
    const s = spec('mfi', { evidence: { indicators: [{ id: 'mfi', tf: '30m' }], events: [], info_topics: [] } } as Partial<StrategySpec>);
    expect(evidenceGaps([s], {})['mfi@1']).toHaveLength(1);
  });

  it('SMA20/50/200 现在真的渲染得出来(P1-11:以前 renderIndicator 一律返回 null = 永远「装不上」)', () => {
    const s = spec('sma', { evidence: { indicators: [{ id: 'sma20', tf: '1h' }, { id: 'sma50', tf: '1h' }, { id: 'sma200', tf: '1h' }], events: [], info_topics: [] } } as Partial<StrategySpec>);
    expect(evidenceGaps([s], { '1h': bars(260) })['sma@1']).toBeUndefined();
  });

  it('renderIndicator 按 params 真算:RSI7 与 RSI21 的数字不一样,标签也跟着窗口走', () => {
    const ks = bars(260);
    const base = indicatorSnapshot(ks, '1h')!;
    const r7 = renderIndicator('rsi', indicatorWithParams('rsi', ks, base, { period: 7 })!, { period: 7 })!;
    const r21 = renderIndicator('rsi', indicatorWithParams('rsi', ks, base, { period: 21 })!, { period: 21 })!;
    expect(r7).toContain('RSI7');
    expect(r21).toContain('RSI21');
    expect(r7).not.toBe(r21.replace('RSI21', 'RSI7'));
    // 默认窗口原样走老路径
    expect(renderIndicator('rsi', base)).toContain('RSI14');
  });

  it('不支持自定义参数的指标 fail closed:算不了就是缺口,不把默认窗口的数贴上自定义标签', () => {
    const s = spec('ichi', { evidence: { indicators: [{ id: 'ichimoku', tf: '1h', params: { period: 9 } }], events: [], info_topics: [] } } as Partial<StrategySpec>);
    expect(evidenceGaps([s], { '1h': bars(260) })['ichi@1']![0]).toContain('不支持自定义参数');
  });

  it('缺口的根数门按自定义窗口算:200 窗口的 RSI,60 根不算「够了」', () => {
    const s = spec('deep', { evidence: { indicators: [{ id: 'rsi', tf: '1h', params: { period: 200 } }], events: [], info_topics: [] } } as Partial<StrategySpec>);
    expect(evidenceGaps([s], { '1h': bars(60) })['deep@1']![0]).toContain('要 210 根');
  });

  it('klinePlan 的证据深度按自定义窗口算,不是固定 220', () => {
    const wide = spec('wide', { evidence: { indicators: [{ id: 'rsi', tf: '2h', params: { period: 300 } }], events: [], info_topics: [] } } as Partial<StrategySpec>);
    expect(klinePlan({ primary_tf: '15m', pool: [wide] })['2h']).toBe(650);
    const small = spec('small', { evidence: { indicators: [{ id: 'rsi', tf: '2h', params: { period: 7 } }], events: [], info_topics: [] } } as Partial<StrategySpec>);
    expect(klinePlan({ primary_tf: '15m', pool: [small] })['2h']).toBe(120);
  });

  it('版本隔离:同 ID 新版 shadow 缺证据,不能让正式旧版跟着弃权(复审反例)', () => {
    const v1 = spec('breakout_retest'); // paper、要 1h rsi、数据够
    const v99 = spec('breakout_retest', { version: 99, content_hash: 'h-breakout-99', status: 'shadow' as StrategyStatus, evidence: { indicators: [{ id: 'rsi', tf: '30m' }], events: [], info_topics: [] } } as Partial<StrategySpec>);
    const klines = { '1h': bars(200) }; // 30m 一根都没拉到
    const gaps = evidenceGaps([v1, v99], klines);
    expect(Object.keys(gaps)).toEqual(['breakout_retest@99']);

    const r = runCouncil({
      now: NOW,
      symbol: 'BTCUSDT',
      timeframe: '15m',
      features: [],
      klines,
      market: { mark: '100', last: '100', funding_rate: '', next_funding_at: 0, open_interest: '', as_of: NOW } as unknown as MarketView,
      oi_change_1h_pct: null,
      daily_regime: null,
      trigger_hits: [],
      strategies: [v1],
      advisory_strategies: [v99],
      woken_ids: ['breakout_retest@1', 'breakout_retest@99'],
      fit_for: () => ({}) as never,
      policy: { mode: 'advise', min_agree: 2, confidence_floor: 0.4 },
      evidence_gaps: gaps,
    });
    const official = r.verdicts.find((v) => v.version === 1)!;
    const shadow = r.verdicts.find((v) => v.version === 99)!;
    // 正式票可以因为别的原因弃权,但**不能**是被影子票的 30m 缺口带走的。
    expect(official.reasons.join(';')).not.toContain('30m');
    expect(official.reasons.join(';')).not.toContain('没装上');
    expect(shadow.stance).toBe('abstain');
    expect(shadow.reasons.join(';')).toContain('30m rsi');
  });

  it('唤醒键也按 id@version:只唤醒新版时,旧版不被一起叫醒', () => {
    const v1 = spec('a');
    const v2 = spec('a', { version: 2, content_hash: 'h-a-2' } as Partial<StrategySpec>);
    const r = runCouncil({
      now: NOW,
      symbol: 'BTCUSDT',
      timeframe: '15m',
      features: [],
      klines: { '1h': bars(200) },
      market: { mark: '100', last: '100', funding_rate: '', next_funding_at: 0, open_interest: '', as_of: NOW } as unknown as MarketView,
      oi_change_1h_pct: null,
      daily_regime: null,
      trigger_hits: [],
      strategies: [v1, v2],
      woken_ids: ['a@2'],
      fit_for: () => ({}) as never,
      policy: { mode: 'advise', min_agree: 2, confidence_floor: 0.4 },
    });
    const r1 = r.verdicts.find((v) => v.version === 1)!;
    expect(r1.stance).toBe('abstain');
    expect(r1.reasons.join(';')).toContain('唤醒');
  });

  it('有缺口的策略在议会里直接弃权,理由说得出缺的是什么', () => {
    const s = spec('a');
    const r = runCouncil({
      now: NOW,
      symbol: 'BTCUSDT',
      timeframe: '15m',
      features: [],
      klines: {},
      market: { mark: '100', last: '100', funding_rate: '', next_funding_at: 0, open_interest: '', as_of: NOW } as unknown as MarketView,
      oi_change_1h_pct: null,
      daily_regime: null,
      trigger_hits: [],
      strategies: [s],
      woken_ids: ['a'],
      fit_for: () => ({}) as never,
      policy: { mode: 'advise', min_agree: 2, confidence_floor: 0.4 },
      evidence_gaps: { a: ['1h rsi(只有 3 根 K 线,要 30 根)'] },
      model_votes: { a: { stance: 'long', confidence: 0.95, reasons: ['模型很有把握'] } },
    });
    expect(r.verdicts[0]!.stance).toBe('abstain');
    expect(r.verdicts[0]!.confidence).toBe(0);
    // 模型票也补不上:缺证据的策略不许靠模型翻成一票。
    expect(r.verdicts[0]!.source).toBe('code');
    expect(r.verdicts[0]!.reasons[0]).toContain('1h rsi');
    expect(r.consensus.abstaining).toEqual(['a']);
  });
});


describe('出队 strategyGuard 与正式执行池同口径(09-12 复审 §2)', () => {
  const keys = (...specs: StrategySpec[]): string[] => poolKeys(specs);

  it('票池没变 → 放行', () => {
    const k = keys(spec('a'));
    expect(poolGuard({ enqueued: k, current: k, mode: 'advise', min_agree: 2 }).drop).toBe(false);
  });

  it('同 ID 换了一版(版本/hash 变了)= 整池被换掉,丢弃', () => {
    const before = keys(spec('a'));
    const after = keys(spec('a', { version: 2, content_hash: 'h-a-2' } as Partial<StrategySpec>));
    const g = poolGuard({ enqueued: before, current: after, mode: 'advise', min_agree: 2 });
    expect(g.drop).toBe(true);
    expect(g.reason).toContain('整体换成');
  });

  it('require 模式人数不够(共识闸必然 fail closed)→ 丢弃,不只在票池为空时才拦', () => {
    const k = keys(spec('a'));
    expect(poolGuard({ enqueued: k, current: k, mode: 'require', min_agree: 2 }).drop).toBe(true);
    expect(poolGuard({ enqueued: k, current: k, mode: 'require', min_agree: 1 }).drop).toBe(true); // REQUIRE_MIN_VOTERS = 2
    const two = keys(spec('a'), spec('b'));
    expect(poolGuard({ enqueued: two, current: two, mode: 'require', min_agree: 2 }).drop).toBe(false);
  });

  it('advise 模式下只有一条策略照样跑(不拿 require 的人数门去拦)', () => {
    const k = keys(spec('a'));
    expect(poolGuard({ enqueued: k, current: k, mode: 'advise', min_agree: 2 }).drop).toBe(false);
  });
});
