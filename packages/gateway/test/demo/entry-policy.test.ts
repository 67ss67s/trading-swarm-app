import { describe, expect, it } from 'vitest';
import { alignLimitPrice, classifyEntryOrder, distToBreakAtr, entryStyleAdvice, entryStyleGate, finalEntryCheck, freezeEntryBasis, FRESH_PRICE_MAX_AGE_MS, nearEntryZone, pendingEntryMetrics, pendingReviewDue, PENDING_REVIEW_MAX_MS } from '../../src/demo/entry-policy.js';
import { buildHoldingPlan } from '../../src/demo/holding-policy.js';
import { JUDGMENT_GRAPH } from '../../src/demo/graph.js';
import { evaluateHoldingReview } from '../../src/demo/holding-policy.js';
import type { TfFeatures } from '../../src/demo/market.js';
import type { ScanChecklist } from '../../src/demo/review-metrics.js';
import type { Kline, MarketView, StrategyThread } from '../../src/demo/types.js';
import { applyWorkflowPatch, DEFAULT_WORKFLOW } from '../../src/demo/workflow.js';

const chk = (over: Partial<ScanChecklist> = {}): ScanChecklist =>
  ({ tf: '15m', atr_pct: 1, atr_floor: 0.15, atr_ok: true, rsi14: 50, adx14: 20, trend_strength: 'moderate', bb_width_rank_90: 40, squeeze_on: false, squeeze_bars: 0, dist_to_vwap_atr: 0, indicators_text: '', trend_agree: 'long', trend_note: '', dist_to_break_atr: 0.2, within_chase: true, retest_confirmed: true, vol_ratio: 2, price_above_ema20: true, watch_eligible: false, text: '', ...over }) as ScanChecklist;
const base = (over: Partial<TfFeatures> = {}): TfFeatures =>
  ({ tf: '15m', last_close: 105, last_open_time: 0, ema20: 100, ema50: 95, atr14: 2, swing_high_20: 106, swing_low_20: 90, swing_high_20_prev: 104, swing_low_20_prev: 92, swing_high_50: 108, swing_low_50: 85, dist_to_high20_pct: 1, dist_to_low20_pct: 14, vol_ratio_20: 2, change_pct_last: 1, change_pct_5: 3, last_bars: '', ...over }) as TfFeatures;

describe('entry policy · 市价还是限价', () => {
  it('回踩确认且离突破位近 → 市价;未确认或追太远 → 限价,并在 prefer_limit 下挡住市价单', () => {
    const near = entryStyleAdvice({ side: 'long', horizon: 'intraday', checklist: chk(), base: base(), mark: 105, style: 'prefer_limit' });
    expect(near.recommended).toBe('market');
    expect(near.market_blocked).toBe(false);

    // 回踩没确认但价就贴在突破位上(105 vs 前高 104,ATR 2 → 0.5 ATR):建议限价,但**不拦**市价
    const notRetested = entryStyleAdvice({ side: 'long', horizon: 'intraday', checklist: chk({ retest_confirmed: false }), base: base(), mark: 105, style: 'prefer_limit' });
    expect(notRetested.recommended).toBe('limit');
    expect(notRetested.market_blocked).toBe(false);
    expect(notRetested.text).toContain('更该挂限价');

    // 已经走出前高 104 三个 ATR:回踩确认也照拦
    const far = base({ last_close: 110, swing_high_20: 111, swing_high_20_prev: 104 });
    const chased = entryStyleAdvice({ side: 'long', horizon: 'intraday', checklist: chk(), base: far, mark: 110, style: 'prefer_limit' });
    expect(chased.dist_to_break_atr).toBe(3);
    expect(chased.recommended).toBe('limit');
    expect(chased.market_blocked).toBe(true);
    expect(chased.reason).toContain('追单成本过高');
    // **距离必须量到「这根之前」的高点**:清单里那个含当根的数(刚突破时恒为 0)不能拿来当追单判据
    expect(distToBreakAtr(far, 'long')).toBe(3);
    expect(entryStyleAdvice({ side: 'long', horizon: 'intraday', checklist: chk({ dist_to_break_atr: 0 }), base: far, mark: 110, style: 'prefer_limit' }).market_blocked).toBe(true);
    // 特征缺失 → 退回清单的数;两个都没有 → 只建议不拦
    expect(entryStyleAdvice({ side: 'long', horizon: 'intraday', checklist: chk({ dist_to_break_atr: 2 }), base: undefined, mark: 105, style: 'prefer_limit' }).market_blocked).toBe(true);
    expect(entryStyleAdvice({ side: 'long', horizon: 'intraday', checklist: chk({ dist_to_break_atr: null, retest_confirmed: false }), base: undefined, mark: 105, style: 'prefer_limit' }).market_blocked).toBe(false);

    // free 模式只给建议,不挡
    expect(entryStyleAdvice({ side: 'long', horizon: 'intraday', checklist: chk({ retest_confirmed: false }), base: base(), mark: 105, style: 'free' }).market_blocked).toBe(false);
    // 清单不可得 → 建议限价,但没有区间也不硬拦形状
    const blind = entryStyleAdvice({ side: null, horizon: null, checklist: null, base: undefined, mark: 105, style: 'prefer_limit' });
    expect(blind.recommended).toBe('limit');
    expect(blind.zone).toBeNull();
  });

  it('参考挂单区落在现价的不利侧,做多在下方、做空在上方', () => {
    const long = entryStyleAdvice({ side: 'long', horizon: 'intraday', checklist: chk({ retest_confirmed: false }), base: base(), mark: 105, style: 'prefer_limit' }).zone!;
    expect(Number(long[1])).toBeLessThanOrEqual(105);
    expect(Number(long[0])).toBeLessThan(Number(long[1]));
    const short = entryStyleAdvice({ side: 'short', horizon: 'intraday', checklist: chk({ trend_agree: 'short', retest_confirmed: false }), base: base({ last_close: 95, ema20: 100, ema50: 105 }), mark: 95, style: 'prefer_limit' }).zone!;
    expect(Number(short[0])).toBeGreaterThanOrEqual(95);
  });

  it('闸只拒市价单,限价、非开仓、free 模式一律放行', () => {
    const advice = entryStyleAdvice({ side: 'long', horizon: 'intraday', checklist: chk({ retest_confirmed: false }), base: base({ last_close: 110, swing_high_20_prev: 104 }), mark: 110, style: 'prefer_limit' });
    expect(entryStyleGate({ action: 'PROPOSE', proposal: { entry: 'market' } }, advice, 'prefer_limit').passed).toBe(false);
    expect(entryStyleGate({ action: 'PROPOSE', proposal: { entry: 'limit' } }, advice, 'prefer_limit').passed).toBe(true);
    expect(entryStyleGate({ action: 'PROPOSE', proposal: { entry: 'market' } }, advice, 'free').passed).toBe(true);
    expect(entryStyleGate({ action: 'WATCH', proposal: null }, advice, 'prefer_limit').passed).toBe(true);
    expect(entryStyleGate({ action: 'PROPOSE', proposal: { entry: 'market' } }, null, 'prefer_limit').passed).toBe(true);
    expect(JUDGMENT_GRAPH.guards.entry_style.gate_name).toBe('入场方式');
    expect(JUDGMENT_GRAPH.model_edges.find((e) => e.id === 'scan.PROPOSE')!.guards).toContain('entry_style');
  });

  it('限价落到交易所价格网格上:做多向下取、做空向上取,tick 不可用时原样返回', () => {
    expect(alignLimitPrice('1234.567', '0.1', 'long')).toBe('1234.5');
    expect(alignLimitPrice('1234.567', '0.1', 'short')).toBe('1234.6');
    expect(alignLimitPrice('0.0123456', '0.0001', 'long')).toBe('0.0123');
    expect(alignLimitPrice('100', '0.1', 'long')).toBe('100.0');
    expect(alignLimitPrice('1234.5', '0', 'long')).toBe('1234.5');
    expect(alignLimitPrice('abc', '0.1', 'long')).toBe('abc');
  });

  // 09-12 §B1:改成 tick 小数位上的整数运算,极端价 / 极小 tick 不再退错一格
  it('对齐用十进制整数运算:极端价格与 1e-8 tick 都落在网格上', () => {
    // 旧浮点实现:1234567890.1 / 0.1 = 12345678900.999998 → 做多退掉一整个 tick
    expect(alignLimitPrice('1234567890.1', '0.1', 'long')).toBe('1234567890.1');
    expect(alignLimitPrice('1234567890.15', '0.1', 'long')).toBe('1234567890.1');
    expect(alignLimitPrice('1234567890.15', '0.1', 'short')).toBe('1234567890.2');
    expect(alignLimitPrice('123456.7', '0.1', 'long')).toBe('123456.7');
    expect(alignLimitPrice('123456.7', '0.1', 'short')).toBe('123456.7');
    // 极小 tick:本来就在网格上的价一个单位都不能动
    expect(alignLimitPrice('0.00001234', '0.00000001', 'long')).toBe('0.00001234');
    expect(alignLimitPrice('0.00001234', '0.00000001', 'short')).toBe('0.00001234');
    expect(alignLimitPrice('0.000012345', '0.00000001', 'long')).toBe('0.00001234');
    expect(alignLimitPrice('0.000012345', '0.00000001', 'short')).toBe('0.00001235');
    // 半个 tick:做多取不到正价格 → 原样返回(由价格闸/交易所 filter 处理),做空进一格
    expect(alignLimitPrice('0.000000005', '0.00000001', 'long')).toBe('0.000000005');
    expect(alignLimitPrice('0.000000005', '0.00000001', 'short')).toBe('0.00000001');
    // tick 带尾零 / 负价 / 零价
    expect(alignLimitPrice('1234.567', '0.100', 'long')).toBe('1234.5');
    expect(alignLimitPrice('-1', '0.1', 'long')).toBe('-1');
    expect(alignLimitPrice('0', '0.1', 'long')).toBe('0');
    expect(alignLimitPrice('100', '1', 'short')).toBe('100');
  });
});

// ---------------------------------------------------------------- 挂单耐心

const thread = (over: Partial<StrategyThread> = {}): StrategyThread =>
  ({ id: 'thr-1', symbol: 'XUSDT', side: 'long', status: 'pending_entry', source: 'agent', timeframe: '15m', horizon: 'intraday', thesis: '', invalidation_text: null, watch_conditions: [], entry: { type: 'limit', price: '100', zone: ['99', '101'] }, stop_price: '95', take_profits: ['110'], qty: '1', margin_usdt: '10', leverage: 4, margin_mode: 'cross', entry_client_order_id: 'cid', protection_client_order_ids: [], filled_avg_price: null, realized_pnl: null, close_reason: null, attention: null, entry_lookup_misses: 0, leg_seq: 1, episode_ids: [], intent_ids: [], created_at: 0, updated_at: 0, opened_at: null, closed_at: null, version: 1, ...over }) as StrategyThread;
const bars = (n: number, close: number, vol: number | ((i: number) => number)): Kline[] =>
  Array.from({ length: n }, (_, i) => ({ open_time: i * 3_600_000, open: String(close), high: String(close + 1), low: String(close - 1), close: String(close), volume: String(typeof vol === 'function' ? vol(i) : vol), close_time: i * 3_600_000 + 3_599_999 }));

describe('entry policy · 挂单要不要继续放着', () => {
  const feats = [base({ tf: '1h', last_close: 100, ema20: 99, swing_high_20_prev: 98 })];
  const inputs = { tf: '1h', tf_ms: 3_600_000, features: feats, klines: { '1h': bars(25, 100, 100) }, max_wait_bars: 8 };

  it('还在区间里、结构还在 → 代码意见是继续挂着', () => {
    const m = pendingEntryMetrics({ now: 3 * 3_600_000, thread: thread(), mark: 100, ...inputs })!;
    expect(m).toMatchObject({ in_zone: true, dist_to_zone_atr: 0, ran_away: false, cancel_warranted: false, bars_waited: 3 });
    expect(m.text).toContain('继续挂着仍然合理');
  });

  it('等超上限 / 价格跑掉 / 结构没了,任一成立就建议撤单,并给出具体理由', () => {
    expect(pendingEntryMetrics({ now: 9 * 3_600_000, thread: thread(), mark: 100, ...inputs })!.reasons[0]).toContain('超过上限');
    const away = pendingEntryMetrics({ now: 3_600_000, thread: thread(), mark: 105, ...inputs })!;
    expect(away).toMatchObject({ ran_away: true, cancel_warranted: true });
    expect(away.dist_to_zone_atr).toBe(2);
    const broken = pendingEntryMetrics({ now: 3_600_000, thread: thread(), mark: 100, ...inputs, klines: { '1h': bars(25, 90, 100) } })!;
    expect(broken.structure_gone).toBe(true);
    expect(broken.cancel_warranted).toBe(true);
    // 做空方向对称:价格跌穿区间下沿并离开
    const short = pendingEntryMetrics({ now: 3_600_000, thread: thread({ side: 'short' }), mark: 95, ...inputs })!;
    expect(short.ran_away).toBe(true);
  });

  it('量能枯竭只是提示,不单独构成撤单理由;非挂单线程不出度量', () => {
    const dry = pendingEntryMetrics({ now: 25 * 3_600_000, thread: thread(), mark: 100, ...inputs, max_wait_bars: 48, klines: { '1h': bars(24, 100, (i) => (i >= 21 ? 10 : 100)) } })!;
    expect(dry.volume_dry).toBe(true);
    expect(dry.cancel_warranted).toBe(false);
    expect(pendingEntryMetrics({ now: 0, thread: thread({ status: 'in_position' }), mark: 100, ...inputs })).toBeNull();
    expect(pendingEntryMetrics({ now: 0, thread: thread(), mark: 0, ...inputs })).toBeNull();
    // 市价单停在 pending 是「还没查到成交」,不归耐心管;调用还在飞时也不出度量(撤了必然失败)
    expect(pendingEntryMetrics({ now: 0, thread: thread({ entry: { type: 'market', price: null, zone: null } }), mark: 100, ...inputs })).toBeNull();
    expect(pendingEntryMetrics({ now: 0, thread: thread({ entry_submitting_since: 1 }), mark: 100, ...inputs })).toBeNull();
  });

  it('P1-07 耐心从挂单真的有 CID 起算,不是线程创建时间', () => {
    const inputs2 = { tf: '1h', tf_ms: 3_600_000, features: feats, klines: { '1h': bars(25, 100, 100) }, max_wait_bars: 8 };
    // 线程 3 小时前建的,但单子是 1 小时前才发出去的 → 等了 1 根,不是 3 根
    const late = pendingEntryMetrics({ now: 3 * 3_600_000, thread: thread({ entry_submitted_at: 2 * 3_600_000 }), mark: 100, ...inputs2 })!;
    expect(late.bars_waited).toBe(1);
    // 提议到发送之间排队 9 小时,不该直接判「超过上限」
    expect(pendingEntryMetrics({ now: 9 * 3_600_000, thread: thread({ entry_submitted_at: 9 * 3_600_000 }), mark: 100, ...inputs2 })!.cancel_warranted).toBe(false);
    // 还没有 CID = 根本没在交易所上等,不出度量
    expect(pendingEntryMetrics({ now: 9 * 3_600_000, thread: thread({ entry_client_order_id: null }), mark: 100, ...inputs2 })).toBeNull();
  });

  it('挂单复查最慢一小时一次,不跟着 swing/position 的持有周期走;价格靠近或离开入场区会叫醒', () => {
    const swing = thread({ horizon: 'swing' });
    expect(pendingReviewDue(swing, PENDING_REVIEW_MAX_MS - 1, 0)).toBe(false);
    expect(pendingReviewDue(swing, PENDING_REVIEW_MAX_MS, 0)).toBe(true);
    expect(pendingReviewDue(thread({ horizon: 'scalp' }), 1, 0)).toBe(true);
    expect(pendingReviewDue(thread({ status: 'in_position' }), PENDING_REVIEW_MAX_MS * 10, 0)).toBe(false);
    expect(nearEntryZone(thread(), 100, 2)).toContain('入场区附近');
    expect(nearEntryZone(thread(), 105, 2)).toContain('已越过入场区');
    expect(nearEntryZone(thread(), 101.5, 2)).toContain('入场区附近');
    expect(nearEntryZone(thread({ status: 'in_position' }), 100, 2)).toBeNull();
  });
});

describe('entry policy · 挂单的 INVALIDATE 是常开的边', () => {
  const market: MarketView = { symbol: 'XUSDT', last: '100', mark: '100', funding_rate: '0.0001', next_funding_at: 0, open_interest: '1', as_of: 5_000 } as MarketView;
  const H = 3_600_000;
  const planned = (over: Partial<StrategyThread> = {}): StrategyThread => {
    const feats = [base({ tf: '4h', last_close: 110, ema20: 100, ema50: 95, atr14: 5 }), base({ tf: '1d', last_close: 110, ema20: 100, ema50: 95, atr14: 5 })];
    const t = thread({ symbol: 'BTCUSDT', horizon: 'swing', entry: { type: 'limit', price: '100', zone: ['99', '101'] }, stop_price: '80', take_profits: ['150'], created_at: 1, ...over });
    return { ...t, holding_plan: buildHoldingPlan({ thread: t, features: feats, now: 1 })! };
  };
  const freshMarket = { ...market, mark: '100', as_of: 48 * H + 99 };
  const planInput = { now: 48 * H + 100, market: freshMarket, features: [base({ tf: '4h', last_open_time: 44 * H, last_close: 110, ema20: 100, ema50: 95, atr14: 5 }), base({ tf: '1d', last_open_time: 24 * H, last_close: 110, ema20: 100, ema50: 95, atr14: 5 })], klines: { '4h': [{ open_time: 44 * H, close_time: 48 * H - 1, open: '100', high: '100', low: '100', close: '100', volume: '1' }], '1d': [{ open_time: 24 * H, close_time: 48 * H - 1, open: '100', high: '100', low: '100', close: '100', volume: '1' }] } };

  it('论点完好(thesis_intact)时挂单可撤,持仓仍只能 HOLD', () => {
    const pending = evaluateHoldingReview({ ...planInput, thread: planned() });
    expect(pending.reason).toBe('thesis_intact');
    expect(pending.allowed_actions).toContain('INVALIDATE');
    expect(pending.required_action).toBeNull();
    const held = evaluateHoldingReview({ ...planInput, thread: planned({ status: 'in_position', opened_at: 1, filled_avg_price: '100' }) });
    expect(held.allowed_actions).toEqual(['HOLD']);
  });

  it('看不见行情、或根本没有持仓计划时,挂单也不放开撤单(两条 fail-closed 路径)', () => {
    const stale = evaluateHoldingReview({ ...planInput, thread: planned(), market: { ...market, mark: '100', as_of: 1 } });
    expect(stale.reason).toBe('market_stale_keep_protection');
    expect(stale.allowed_actions).toEqual(['HOLD']);
    const noPlan = evaluateHoldingReview({ ...planInput, thread: thread({ created_at: 1 }) });
    expect(noPlan.reason).toBe('legacy_plan_unavailable');
    expect(noPlan.allowed_actions).toEqual(['HOLD']);
  });
  it('两个开关进 workflow 并被校验', () => {
    expect(DEFAULT_WORKFLOW.entry_style).toBe('prefer_limit');
    expect(DEFAULT_WORKFLOW.entry_max_wait_bars).toBe(8);
    const ok = applyWorkflowPatch(DEFAULT_WORKFLOW, { entry_style: 'free', entry_max_wait_bars: 12 });
    expect(ok.errors).toEqual([]);
    expect(ok.next).toMatchObject({ entry_style: 'free', entry_max_wait_bars: 12 });
    expect(applyWorkflowPatch(DEFAULT_WORKFLOW, { entry_style: 'always_market', entry_max_wait_bars: 100 }).errors).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- P1-07:发送前按最终方向/冻结突破位/新鲜价重测距

describe('entry policy · 限价枚举不是免检通道(P1-07)', () => {
  it('classifyEntryOrder 分得出「立刻成交的限价」与「等待型限价」', () => {
    expect(classifyEntryOrder('market', null, 100, 'long')).toBe('market');
    expect(classifyEntryOrder('limit', '101', 100, 'long')).toBe('marketable_limit');
    expect(classifyEntryOrder('limit', '100', 100, 'long')).toBe('marketable_limit'); // 贴盘口就是吃单
    expect(classifyEntryOrder('limit', '99', 100, 'long')).toBe('waiting_limit');
    expect(classifyEntryOrder('limit', '99', 100, 'short')).toBe('marketable_limit');
    expect(classifyEntryOrder('limit', '101', 100, 'short')).toBe('waiting_limit');
    expect(classifyEntryOrder('limit', null, 100, 'long')).toBe('unknown_limit');
    expect(classifyEntryOrder('limit', '101', 0, 'long')).toBe('unknown_limit');
  });

  it('复审反例:long mark=100 limit=101 在 pending 下必须被拒(限价枚举绕过市价闸)', () => {
    const inp = { side: 'long' as const, entry: 'limit' as const, limit_price: '101', mark: 100, breakout_level: 99, atr: 2, entry_timing: 'pending' as const, style: 'free' as const };
    const r = finalEntryCheck(inp);
    expect(r).toMatchObject({ passed: false, kind: 'marketable_limit', code: 'marketable_limit_under_pending' });
    // 同样的价挂在不利侧就放行
    expect(finalEntryCheck({ ...inp, limit_price: '99.5' })).toMatchObject({ passed: true, kind: 'waiting_limit' });
    // 市价照旧被拒
    expect(finalEntryCheck({ ...inp, entry: 'market', limit_price: null }).code).toBe('market_under_pending');
  });

  it('pending 下身份证明不了的限价 fail closed:没给限价、或可执行价不新鲜', () => {
    const inp = { side: 'long' as const, entry: 'limit' as const, limit_price: null, mark: 100, breakout_level: 99, atr: 2, entry_timing: 'pending' as const, style: 'free' as const };
    expect(finalEntryCheck(inp)).toMatchObject({ passed: false, code: 'unproven_limit_under_pending' });
    const stale = finalEntryCheck({ ...inp, limit_price: '99', mark_at: 1_000, now: 1_000 + FRESH_PRICE_MAX_AGE_MS + 1 });
    expect(stale).toMatchObject({ passed: false, kind: 'unknown_limit', code: 'unproven_limit_under_pending' });
    expect(finalEntryCheck({ ...inp, limit_price: '99', mark_at: 1_000, now: 1_000 + 5_000 })).toMatchObject({ passed: true, kind: 'waiting_limit' });
  });

  it('P1-07 confirmed 的市价单也要求可执行价新鲜(复审反例 mark_at=1、now=600000)', () => {
    const inp = { side: 'long' as const, entry: 'market' as const, limit_price: null, mark: 100, breakout_level: 99, atr: 2, entry_timing: 'confirmed' as const, style: 'prefer_limit' as const };
    expect(finalEntryCheck({ ...inp, mark_at: 1, now: 600_000 })).toMatchObject({ passed: false, code: 'stale_mark' }); // 修前:passed=true
    expect(finalEntryCheck({ ...inp, mark_at: 600_000 - 5_000, now: 600_000 })).toMatchObject({ passed: true });
    expect(finalEntryCheck({ ...inp, mark_at: 600_000 - FRESH_PRICE_MAX_AGE_MS, now: 600_000 }).passed).toBe(true); // 边界:正好 30s 仍算新鲜
    // 取价时刻不可得时不拿新鲜度拒单(证据缺失不是拒单理由)
    expect(finalEntryCheck(inp).passed).toBe(true);
  });

  it('P1-07 freezeEntryBasis 按最终方向取结构位(做多取前高、做空取前低)', () => {
    const f = base({ tf: '1h', atr14: 2, swing_high_20_prev: 110, swing_low_20_prev: 90 });
    expect(freezeEntryBasis(f, 'long', 100, 7)).toEqual({ breakout_level: 110, atr: 2, mark: 100, at: 7 });
    expect(freezeEntryBasis(f, 'short', 100, 7)).toEqual({ breakout_level: 90, atr: 2, mark: 100, at: 7 });
    expect(freezeEntryBasis(f, null, 100, 7)).toBeNull();
    expect(freezeEntryBasis(undefined, 'long', 100, 7)).toBeNull();
  });

  it('测距按最终方向与冻结突破位重算:市价/marketable 用现价,等待型限价用挂单价,两者分开处理', () => {
    const far = { side: 'long' as const, mark: 110, breakout_level: 100, atr: 2, entry_timing: 'confirmed' as const, style: 'prefer_limit' as const };
    expect(finalEntryCheck({ ...far, entry: 'market', limit_price: null })).toMatchObject({ passed: false, code: 'chase_too_far', dist_atr: 5 });
    expect(finalEntryCheck({ ...far, entry: 'limit', limit_price: '111' })).toMatchObject({ passed: false, code: 'chase_too_far', kind: 'marketable_limit' });
    // 等待型限价也要自己过测距:挂在 109 仍然是在追(距突破位 4.5 ATR)
    expect(finalEntryCheck({ ...far, entry: 'limit', limit_price: '109' })).toMatchObject({ passed: false, code: 'waiting_limit_too_far', kind: 'waiting_limit', dist_atr: 4.5 });
    // 挂回结构位附近就放行
    expect(finalEntryCheck({ ...far, entry: 'limit', limit_price: '101' })).toMatchObject({ passed: true, kind: 'waiting_limit' });
    // 方向反过来(模型最后选了做空):测距基准跟着最终方向走
    expect(finalEntryCheck({ side: 'short', entry: 'market', limit_price: null, mark: 110, breakout_level: 109, atr: 2, entry_timing: 'confirmed', style: 'prefer_limit' })).toMatchObject({ passed: true, dist_atr: 0.5 });
    // free 模式不拿距离拒单;时机判据坏掉则一律拒
    expect(finalEntryCheck({ ...far, style: 'free', entry: 'market', limit_price: null }).passed).toBe(true);
    expect(finalEntryCheck({ ...far, entry: 'limit', limit_price: '101', entry_timing: 'failed' }).code).toBe('timing_failed');
    // 距离算不出来不拒单(证据缺失不是拒单理由)
    expect(finalEntryCheck({ ...far, entry: 'market', limit_price: null, breakout_level: null, atr: null })).toMatchObject({ passed: true, dist_atr: null });
  });

  it('entryStyleGate:市价被闸拒时,立刻成交的限价同样被拒,等待型限价放行', () => {
    const advice = entryStyleAdvice({ side: 'long', horizon: 'intraday', checklist: chk({ retest_confirmed: false }), base: base({ last_close: 110, swing_high_20_prev: 104 }), mark: 110, style: 'prefer_limit' });
    expect(advice.market_blocked).toBe(true);
    expect(advice.mark).toBe(110);
    expect(advice.breakout_level).toBe(104);
    expect(entryStyleGate({ action: 'PROPOSE', direction: 'long', proposal: { entry: 'market', limit_price: null } }, advice, 'prefer_limit').passed).toBe(false);
    const marketable = entryStyleGate({ action: 'PROPOSE', direction: 'long', proposal: { entry: 'limit', limit_price: '111' } }, advice, 'prefer_limit');
    expect(marketable.passed).toBe(false);
    expect(marketable.reason).toContain('会立刻成交');
    expect(entryStyleGate({ action: 'PROPOSE', direction: 'long', proposal: { entry: 'limit', limit_price: '105' } }, advice, 'prefer_limit').passed).toBe(true);
    // 没给限价 → 身份未证明,距离闸不拦(pending 的 fail closed 由 finalEntryCheck 管)
    expect(entryStyleGate({ action: 'PROPOSE', direction: 'long', proposal: { entry: 'limit', limit_price: null } }, advice, 'prefer_limit').passed).toBe(true);
    expect(entryStyleGate({ action: 'PROPOSE', direction: 'long', proposal: { entry: 'limit', limit_price: '111' } }, advice, 'free').passed).toBe(true);
  });
});

// ---------------------------------------------------------------- entry_style 第三档:limit_only

describe('entry policy · limit_only(市价一律拒,除非策略写了 market_ok)', () => {
  const advice = (style: 'free' | 'prefer_limit' | 'limit_only', entry_mode: 'market_ok' | null = null) =>
    entryStyleAdvice({ side: 'long', horizon: 'intraday', checklist: chk(), base: base(), mark: 105, style, entry_mode });

  it('limit_only 下市价被拒、限价放行,且不看追单距离', () => {
    // chk() 是「回踩已确认 + 距突破位 0.2 ATR」,prefer_limit 下市价本来是放行的
    expect(advice('prefer_limit').market_blocked).toBe(false);
    const a = advice('limit_only');
    expect(a).toMatchObject({ recommended: 'limit', market_blocked: true });
    expect(a.text).toContain('limit_only');
    const rejected = entryStyleGate({ action: 'PROPOSE', direction: 'long', proposal: { entry: 'market', limit_price: null } }, a, 'limit_only');
    expect(rejected.passed).toBe(false);
    expect(rejected.reason).toContain('市价开仓一律拒');
    expect(entryStyleGate({ action: 'PROPOSE', direction: 'long', proposal: { entry: 'limit', limit_price: '104' } }, a, 'limit_only').passed).toBe(true);
    // 没有建议证据也照拒:这一档不依赖距离证据
    expect(entryStyleGate({ action: 'PROPOSE', direction: 'long', proposal: { entry: 'market', limit_price: null } }, null, 'limit_only').passed).toBe(false);
    // 非开仓动作不拦
    expect(entryStyleGate({ action: 'WATCH', proposal: null }, a, 'limit_only').passed).toBe(true);
  });

  it('策略规则写了 entry_mode=market_ok 时,limit_only 下市价放行', () => {
    const ok = advice('limit_only', 'market_ok');
    expect(ok.market_blocked).toBe(false);
    expect(entryStyleGate({ action: 'PROPOSE', direction: 'long', proposal: { entry: 'market', limit_price: null } }, ok, 'limit_only').passed).toBe(true);
    // 闸参数里显式传 entry_mode 优先于建议里的那份(最终策略可能不是扫描时那条)
    expect(entryStyleGate({ action: 'PROPOSE', direction: 'long', proposal: { entry: 'market', limit_price: null } }, advice('limit_only'), 'limit_only', { entry_mode: 'market_ok' }).passed).toBe(true);
    expect(entryStyleGate({ action: 'PROPOSE', direction: 'long', proposal: { entry: 'market', limit_price: null } }, ok, 'limit_only', { entry_mode: null }).passed).toBe(false);
  });

  it('finalEntryCheck 在 limit_only 下同样拒市价与 marketable limit,等待型限价照过', () => {
    const inp = { side: 'long' as const, mark: 100, breakout_level: 99.8, atr: 2, entry_timing: 'confirmed' as const, style: 'limit_only' as const };
    expect(finalEntryCheck({ ...inp, entry: 'market', limit_price: null })).toMatchObject({ passed: false, code: 'market_not_allowed' });
    expect(finalEntryCheck({ ...inp, entry: 'limit', limit_price: '101' })).toMatchObject({ passed: false, code: 'market_not_allowed', kind: 'marketable_limit' });
    expect(finalEntryCheck({ ...inp, entry: 'limit', limit_price: '99' })).toMatchObject({ passed: true, kind: 'waiting_limit' });
    expect(finalEntryCheck({ ...inp, entry: 'market', limit_price: null, entry_mode: 'market_ok' })).toMatchObject({ passed: true });
  });

  it('workflow 认这三档,默认仍是 prefer_limit', () => {
    expect(DEFAULT_WORKFLOW.entry_style).toBe('prefer_limit');
    expect(applyWorkflowPatch(DEFAULT_WORKFLOW, { entry_style: 'limit_only' })).toMatchObject({ errors: [], next: { entry_style: 'limit_only' } });
    expect(applyWorkflowPatch(DEFAULT_WORKFLOW, { entry_style: 'free' }).errors).toEqual([]);
    expect(applyWorkflowPatch(DEFAULT_WORKFLOW, { entry_style: 'limit' }).errors[0]).toContain('limit_only');
  });
});
