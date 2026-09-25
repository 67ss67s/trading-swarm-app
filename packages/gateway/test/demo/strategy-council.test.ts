import { describe, expect, it } from 'vitest';
import { JUDGMENT_GRAPH } from '../../src/demo/graph.js';
import type { TfFeatures } from '../../src/demo/market.js';
import { BUILTIN_STRATEGIES, DEFAULT_SCAN_BARS, KLINE_FETCH_MARGIN, minBarsFor, type StrategySpec } from '../../src/demo/strategies.js';
import { codeVerdict, consensus, STRATEGY_VERDICT, consensusGate, councilReview, DEFAULT_COUNCIL_POLICY, mergeVerdict, narrowByCode, parseVerdict, runCouncil, snapshotOf, strategyFit, type StrategyVerdict } from '../../src/demo/strategy-council.js';
import type { MarketView } from '../../src/demo/types.js';
import { applyWorkflowPatch, DEFAULT_WORKFLOW } from '../../src/demo/workflow.js';

const spec = (id: string): StrategySpec => BUILTIN_STRATEGIES.find((s) => s.id === id)!;
const feat = (tf: string, up: boolean, extra: Partial<TfFeatures> = {}): TfFeatures =>
  ({ tf, last_close: 105, last_open_time: 0, ema20: up ? 100 : 110, ema50: up ? 95 : 115, atr14: 2, swing_high_20: 105, swing_low_20: 90, swing_high_20_prev: 103, swing_low_20_prev: 92, swing_high_50: 106, swing_low_50: 85, dist_to_high20_pct: 0, dist_to_low20_pct: 14, vol_ratio_20: 2.5, change_pct_last: 1, change_pct_5: 3, last_bars: '', ...extra }) as TfFeatures;
const market: MarketView = { symbol: 'XUSDT', last: '105', mark: '105', funding_rate: '0.0001', next_funding_at: 0, open_interest: '1', as_of: 1_000 } as MarketView;
const base = { now: 1_000, symbol: 'XUSDT', timeframe: '15m', klines: {}, market, oi_change_1h_pct: null, daily_regime: null, trigger_hits: [] };
const verdict = (id: string, stance: StrategyVerdict['stance'], confidence = 0.6, entry_timing: StrategyVerdict['entry_timing'] = stance === 'long' || stance === 'short' ? 'confirmed' : null): StrategyVerdict => ({ strategy_id: id, version: 1, content_hash: 'h', horizon: 'intraday', stance, confidence, entry_timing, source: 'code', fit: { score: null, parts: { radar: null, lab: null, eval: null, history: null }, note: '' }, checks: [], reasons: ['r'], at: 0 });

describe('strategy council · code verdicts', () => {
  it('breakout_retest votes long when trend agrees, retest confirmed and regime not against', () => {
    const { out } = codeVerdict(spec('breakout_retest'), { ...base, features: [feat('15m', true), feat('1h', true), feat('4h', true)], woken: true });
    expect(out.stance).toBe('long');
    expect(out.confidence).toBeGreaterThanOrEqual(0.55);
    expect(out.checks.find((c) => c.id === 'retest_confirmed')?.pass).toBe(true);
  });
  it('bear daily regime turns a long setup neutral; disagreeing timeframes are neutral; not-woken and unregistered strategies abstain', () => {
    const feats = [feat('15m', true), feat('1h', true), feat('4h', true)];
    const bear = codeVerdict(spec('breakout_retest'), { ...base, features: feats, woken: true, daily_regime: { regime: 'bear', text: '', as_of: 0, ema_stack: '', ret_20d_pct: 0, ret_5d_pct: 0, vol_pct_rank: 0, atr_pct: 0, dist_to_ema200_pct: null } });
    expect(bear.out.stance).toBe('neutral');
    expect(codeVerdict(spec('breakout_retest'), { ...base, features: [feat('15m', true), feat('1h', true), feat('4h', false)], woken: true }).out.stance).toBe('neutral');
    expect(codeVerdict(spec('breakout_retest'), { ...base, features: feats, woken: false }).out.stance).toBe('abstain');
    expect(codeVerdict(spec('range_mean_reversion'), { ...base, features: feats, woken: true }).out.stance).toBe('abstain');
  });
});

describe('strategy council · consensus', () => {
  it('needs min_agree same-direction votes above the floor; conflict blocks', () => {
    const p = { ...DEFAULT_COUNCIL_POLICY, mode: 'require' as const };
    expect(consensus([verdict('a', 'long'), verdict('b', 'long'), verdict('c', 'abstain')], p)).toMatchObject({ reached: true, direction: 'long', agreeing: ['a', 'b'], abstaining: ['c'], gate_effective: true });
    expect(consensus([verdict('a', 'long'), verdict('b', 'long', 0.2)], p)).toMatchObject({ reached: false, neutral: ['b'], required: 2 });
    expect(consensus([verdict('a', 'long'), verdict('b', 'short')], p)).toMatchObject({ reached: false, direction: null, dissenting: ['a', 'b'] });
    expect(consensus([verdict('a', 'abstain')], p).reached).toBe(false);
  });

  // 09-12 §B4:钳降改 fail closed
  it('min_agree 超过能投票的策略数时判「共识闸当前无效」,不再静默钳降', () => {
    const p = { ...DEFAULT_COUNCIL_POLICY, mode: 'require' as const, min_agree: 2 };
    const c = consensus([verdict('a', 'long'), verdict('b', 'abstain'), verdict('c', 'abstain')], p);
    expect(c).toMatchObject({ reached: false, gate_effective: false, required: 2, voting: ['a'] });
    expect(c.gate_reason).toContain('共识闸当前无效');
    expect(c.gate_reason).toContain('能投票的策略只有 1 条');
    // 真想只要一票,必须显式设 min_agree=1;但 require 模式下仍要求至少两条策略能投票
    const one = consensus([verdict('a', 'long'), verdict('b', 'abstain')], { ...p, min_agree: 1 });
    expect(one).toMatchObject({ reached: false, gate_effective: false });
    expect(one.gate_reason).toContain('require 模式至少 2 条');
    // advise 模式不做这条最低票池要求(它本来就不拦),min_agree=1 时一票即共识
    expect(consensus([verdict('a', 'long'), verdict('b', 'abstain')], { ...p, mode: 'advise', min_agree: 1 })).toMatchObject({ reached: true, gate_effective: true });
  });

  it('共识闸无效时 require 模式直接拒开仓,理由可读', () => {
    const r = runCouncil({ ...base, features: [feat('15m', true), feat('1h', true), feat('4h', true)], strategies: [spec('breakout_retest')], woken_ids: ['breakout_retest'], fit_for: () => ({ radar_fit: null, history: null }), policy: { mode: 'require', min_agree: 2, confidence_floor: 0.4 } });
    expect(r.consensus.gate_effective).toBe(false);
    expect(r.text).toContain('共识闸当前无效');
    const g = consensusGate({ action: 'PROPOSE', direction: 'long', strategy_id: 'breakout_retest', proposal: { entry: 'limit' } }, r, 'require');
    expect(g.passed).toBe(false);
    expect(g.reason).toContain('共识闸当前无效');
  });
  it('gate only bites in require mode: direction and strategy_id must match the consensus', () => {
    const r = runCouncil({ ...base, features: [feat('15m', true), feat('1h', true), feat('4h', true)], strategies: [spec('breakout_retest'), spec('mtf_alignment')], woken_ids: ['breakout_retest', 'mtf_alignment'], fit_for: () => ({ radar_fit: null, history: null }), policy: { mode: 'require', min_agree: 2, confidence_floor: 0.4 } });
    expect(r.consensus).toMatchObject({ reached: true, direction: 'long', agreeing: ['breakout_retest', 'mtf_alignment'] });
    expect(r.text).toContain('共识=是');
    expect(consensusGate({ action: 'PROPOSE', direction: 'long', strategy_id: 'breakout_retest' }, r, 'require').passed).toBe(true);
    expect(consensusGate({ action: 'PROPOSE', direction: 'short', strategy_id: 'breakout_retest' }, r, 'require').passed).toBe(false);
    expect(consensusGate({ action: 'PROPOSE', direction: 'long', strategy_id: 'range_mean_reversion' }, r, 'require').passed).toBe(false);
    expect(consensusGate({ action: 'WATCH', direction: null }, r, 'require').passed).toBe(true);
    expect(consensusGate({ action: 'PROPOSE', direction: 'short' }, r, 'advise').passed).toBe(true);
    expect(consensusGate({ action: 'PROPOSE', direction: 'long' }, null, 'require').passed).toBe(false);
    const snap = snapshotOf(r);
    expect(snap.agreeing).toEqual(['breakout_retest', 'mtf_alignment']);
    expect(snap.votes).toHaveLength(2);
  });
  it('review compares the opening snapshot with fresh verdicts', () => {
    const snap = { version: 'council-v1', at: 0, direction: 'long' as const, reached: true, agreeing: ['a', 'b', 'c'], dissenting: [], votes: [] };
    const rv = councilReview(snap, [verdict('a', 'long'), verdict('b', 'short'), verdict('c', 'neutral')], 'long');
    expect(rv).toMatchObject({ still_agree: ['a'], flipped: ['b'], gone_neutral: ['c'] });
    expect(rv.text).toContain('翻向 1');
  });
});

describe('strategy council · model votes, fit, workflow knobs', () => {
  it('merges code and model votes: 模型只能减权 —— 弃权不补票、中立不翻案、同向不加分', () => {
    const code = { stance: 'long' as const, confidence: 0.6, checks: [], reasons: ['c'] };
    expect(mergeVerdict({ ...code, stance: 'abstain', confidence: 0 }, { stance: 'short', confidence: 0.8, reasons: ['m'] })).toMatchObject({ source: 'code+model', out: { stance: 'abstain', confidence: 0 } });
    expect(mergeVerdict(code, { stance: 'short', confidence: 0.8, reasons: [] }).out.stance).toBe('neutral');
    // 同向:取均值但不超过代码票(模型 0.8 不能把 0.6 抬高)
    expect(mergeVerdict(code, { stance: 'long', confidence: 0.8, reasons: [] }).out.confidence).toBeCloseTo(0.6);
    expect(mergeVerdict(code, { stance: 'long', confidence: 0.2, reasons: [] }).out.confidence).toBeCloseTo(0.4);
    expect(mergeVerdict(code, { stance: 'neutral', confidence: 0.8, reasons: [] }).out.confidence).toBeCloseTo(0.42);
    // 代码中立(含硬条件失败)不能被模型票翻成可执行票
    const neutral = mergeVerdict({ stance: 'neutral', confidence: 0, checks: [], reasons: ['未过:retest_confirmed'] }, { stance: 'long', confidence: 0.9, reasons: ['看多'] });
    expect(neutral.out).toMatchObject({ stance: 'neutral', confidence: 0 });
    expect(neutral.out.reasons.join()).toContain('代码中立不由模型翻案');
    expect(parseVerdict('```json\n{"stance":"long","confidence":1.4,"reasons":["x [E1]"]}\n```')).toEqual({ stance: 'long', confidence: 1, reasons: ['x [E1]'] });
    expect(parseVerdict('{"stance":"maybe"}')).toBeNull();
    expect(parseVerdict('no json')).toBeNull();
  });
  it('fit averages only the parts that exist and never invents a score', () => {
    const s = spec('breakout_retest');
    expect(strategyFit(s, { radar_fit: null, history: null }).score).toBeNull();
    expect(strategyFit(s, { radar_fit: 0.8, history: null }).score).toBeCloseTo(0.8);
    const f = strategyFit(s, { radar_fit: 0.8, history: { n: 10, win_rate: 0.6, expectancy_r: 0.2 } });
    expect(f.parts.history).toBeCloseTo(0.7);
    expect(f.score).toBeCloseTo((0.8 * 0.3 + 0.7 * 0.4) / 0.7, 1);
  });
  it('workflow validates the three council knobs and the graph knows the consensus guard', () => {
    expect(DEFAULT_WORKFLOW.strategy_council).toBe('advise');
    const ok = applyWorkflowPatch(DEFAULT_WORKFLOW, { strategy_council: 'require', council_min_agree: 3, council_model: 'cheap' });
    expect(ok.errors).toEqual([]);
    expect(ok.next).toMatchObject({ strategy_council: 'require', council_min_agree: 3, council_model: 'cheap' });
    const bad = applyWorkflowPatch(DEFAULT_WORKFLOW, { strategy_council: 'always', council_min_agree: 9, council_model: 'gpt' });
    expect(bad.errors).toHaveLength(3);
    expect(JUDGMENT_GRAPH.guards.strategy_consensus.gate_name).toBe('策略共识');
    expect(JUDGMENT_GRAPH.model_edges.find((e) => e.id === 'scan.PROPOSE')!.guards).toContain('strategy_consensus');
  });
});

// ---------------------------------------------------------------- 三条后补策略的裁决

const chk = (over: Partial<import('../../src/demo/review-metrics.js').ScanChecklist> = {}): import('../../src/demo/review-metrics.js').ScanChecklist =>
  ({ tf: '15m', atr_pct: 1, atr_floor: 0.15, atr_ok: true, rsi14: 50, adx14: 15, trend_strength: 'weak', bb_width_rank_90: 10, squeeze_on: true, squeeze_bars: 8, dist_to_vwap_atr: 0, indicators_text: '', trend_agree: 'long', trend_note: '', dist_to_break_atr: 0.5, within_chase: true, retest_confirmed: false, vol_ratio: 2.5, price_above_ema20: true, watch_eligible: true, text: '', ...over }) as import('../../src/demo/review-metrics.js').ScanChecklist;
const run = (id: string, inp: Partial<Parameters<typeof codeVerdict>[1]>, checklist: import('../../src/demo/review-metrics.js').ScanChecklist | null) =>
  STRATEGY_VERDICT[id]!(spec(id), { ...base, features: [feat('15m', true)], woken: true, ...inp } as Parameters<typeof codeVerdict>[1], [], checklist);

const kline = (count: number, price: (i: number) => number, vol = 100, t0 = 0): import('../../src/demo/types.js').Kline[] =>
  Array.from({ length: count }, (_, i) => {
    const open = price(i);
    const close = price(i + 1);
    return { open_time: t0 + i * 900_000, open: open.toFixed(2), high: (Math.max(open, close) + 1).toFixed(2), low: (Math.min(open, close) - 1).toFixed(2), close: close.toFixed(2), volume: String(vol), close_time: t0 + i * 900_000 + 899_999 };
  });

describe('strategy council · vol_compression_expansion', () => {
  it('votes with the breakout direction only after a real compression, and abstains without indicator data', () => {
    // 距本次突破位 (106-105)/2 = 0.5 ATR,在 chase_atr_max 1.5 以内
    const up = feat('15m', true, { last_close: 106, swing_high_20_prev: 105, swing_low_20_prev: 90 });
    expect(run('vol_compression_expansion', { features: [up] }, chk())).toMatchObject({ stance: 'long' });
    const down = feat('15m', false, { last_close: 89, swing_high_20_prev: 105, swing_low_20_prev: 90 });
    expect(run('vol_compression_expansion', { features: [down] }, chk({ trend_agree: 'short' })).stance).toBe('short');
    // 没压缩过 → 中立;压缩了但还没突破 → 中立(观望);量比不足 → 中立
    expect(run('vol_compression_expansion', { features: [up] }, chk({ bb_width_rank_90: 60, squeeze_bars: 0, squeeze_on: false })).stance).toBe('neutral');
    expect(run('vol_compression_expansion', { features: [feat('15m', true, { last_close: 100, swing_high_20_prev: 105, swing_low_20_prev: 90 })] }, chk()).stance).toBe('neutral');
    expect(run('vol_compression_expansion', { features: [up] }, chk({ vol_ratio: 1.1 })).stance).toBe('neutral');
    // 追单距离按**本次突破方向**重算,不借用清单里按趋势方向算的那个数:走出 2.5 ATR 就不追
    expect(run('vol_compression_expansion', { features: [feat('15m', true, { last_close: 110, swing_high_20_prev: 105, swing_low_20_prev: 90 })] }, chk()).stance).toBe('neutral');
    // 指标快照整体缺失 = 弃权,不是中立
    expect(run('vol_compression_expansion', { features: [up] }, chk({ bb_width_rank_90: null, squeeze_on: null, squeeze_bars: null })).stance).toBe('abstain');
    expect(run('vol_compression_expansion', { features: [up] }, null).stance).toBe('abstain');
  });
});

describe('strategy council · funding_oi_extreme', () => {
  const history = (rate: number, n = 60) => Array.from({ length: n }, (_, i) => ({ at: 1_000 - (i + 1) * 3_600_000, rate: (rate + (i % 2 ? 0.000005 : -0.000005)).toFixed(8) }));
  const mkt = (rate: string, minsToFunding = 120): MarketView => ({ ...market, funding_rate: rate, next_funding_at: 1_000 + minsToFunding * 60_000 });

  it('fades the crowded side when open interest is unwinding, follows only with trend when it is not', () => {
    const inp = { market: mkt('0.0008'), oi_change_1h_pct: -3, funding_history: history(0.0001) };
    expect(run('funding_oi_extreme', inp, chk())).toMatchObject({ stance: 'short' });
    expect(run('funding_oi_extreme', { ...inp, market: mkt('-0.0008') }, chk()).stance).toBe('long');
    // OI 仍在升 → 不 fade,只顺势(信心压低);趋势不同向 → 中立
    expect(run('funding_oi_extreme', { ...inp, oi_change_1h_pct: 3 }, chk())).toMatchObject({ stance: 'long', confidence: 0.45 });
    expect(run('funding_oi_extreme', { ...inp, oi_change_1h_pct: 3 }, chk({ trend_agree: null })).stance).toBe('neutral');
  });

  it('needs a real extreme, a live OI read and room before settlement; missing history abstains', () => {
    const hist = history(0.0001);
    expect(run('funding_oi_extreme', { market: mkt('0.0002'), oi_change_1h_pct: -3, funding_history: hist }, chk()).stance).toBe('neutral');
    expect(run('funding_oi_extreme', { market: mkt('0.0008', 10), oi_change_1h_pct: -3, funding_history: hist }, chk()).reasons[0]).toContain('距结算');
    // OI 读不到 = 看不见,弃权(不是投中立票)
    expect(run('funding_oi_extreme', { market: mkt('0.0008'), oi_change_1h_pct: null, funding_history: hist }, chk())).toMatchObject({ stance: 'abstain', abstain_reason: 'data' });
    expect(run('funding_oi_extreme', { market: mkt('0.0008'), oi_change_1h_pct: -3 }, chk()).stance).toBe('abstain');
    expect(run('funding_oi_extreme', { market: mkt(''), oi_change_1h_pct: -3, funding_history: hist }, chk()).stance).toBe('abstain');
  });
});

describe('strategy council · range_mean_reversion', () => {
  const wave = kline(900, (i) => 1000 + 40 * Math.sin((i / 20) * Math.PI * 2));
  const featOf = (close: number, ema20: number): TfFeatures => feat('15m', true, { last_close: close, ema20, ema50: ema20, atr14: 10 });

  it('fades the deviation in a range when history says it reverts, and abstains without 400 bars', () => {
    const long = codeVerdict(spec('range_mean_reversion'), { ...base, features: [featOf(960, 1000)], klines: { '15m': wave }, daily_regime: { regime: 'range', text: '', as_of: 0, ema_stack: '', ret_20d_pct: 0, ret_5d_pct: 0, vol_pct_rank: 0, atr_pct: 0, dist_to_ema200_pct: null }, woken: true });
    expect(long.out.stance).toBe('long');
    expect(long.out.checks.find((c) => c.id === 'reversion_prob')?.pass).toBe(true);
    const short = codeVerdict(spec('range_mean_reversion'), { ...base, features: [featOf(1040, 1000)], klines: { '15m': wave }, daily_regime: { regime: 'range', text: '', as_of: 0, ema_stack: '', ret_20d_pct: 0, ret_5d_pct: 0, vol_pct_rank: 0, atr_pct: 0, dist_to_ema200_pct: null }, woken: true });
    expect(short.out.stance).toBe('short');
    // 偏离不够 → 中立;趋势日线 + 高 ADX → 中立;K 线不足 400 根 → 弃权
    expect(codeVerdict(spec('range_mean_reversion'), { ...base, features: [featOf(1005, 1000)], klines: { '15m': wave }, daily_regime: { regime: 'range', text: '', as_of: 0, ema_stack: '', ret_20d_pct: 0, ret_5d_pct: 0, vol_pct_rank: 0, atr_pct: 0, dist_to_ema200_pct: null }, woken: true }).out.stance).toBe('neutral');
    expect(codeVerdict(spec('range_mean_reversion'), { ...base, features: [featOf(1040, 1000)], klines: { '15m': kline(900, (i) => 1000 + i * 6) }, daily_regime: { regime: 'bull', text: '', as_of: 0, ema_stack: '', ret_20d_pct: 0, ret_5d_pct: 0, vol_pct_rank: 0, atr_pct: 0, dist_to_ema200_pct: null }, woken: true }).out.stance).toBe('neutral');
    expect(codeVerdict(spec('range_mean_reversion'), { ...base, features: [featOf(960, 1000)], klines: { '15m': wave.slice(0, 100) }, woken: true }).out.stance).toBe('abstain');
  });
});

describe('strategy council · 模型票不能凭空造票', () => {
  it('代码弃权时模型的方向票只记录不计入共识(数据缺与没实现都不补票)', () => {
    const dataGap = { stance: 'abstain' as const, confidence: 0, checks: [], reasons: ['压缩证据不可得,不投票'], abstain_reason: 'data' as const };
    const merged = mergeVerdict(dataGap, { stance: 'long', confidence: 0.9, reasons: ['看起来要涨'] });
    expect(merged.out.stance).toBe('abstain');
    expect(merged.out.reasons.join()).toContain('不计票');
    // 「还没实现」也不能由模型补票:那条策略的硬前置检查根本没人跑过
    const noImpl = { stance: 'abstain' as const, confidence: 0, checks: [], reasons: ['该策略还没有代码裁决实现(待填)'], abstain_reason: 'unimplemented' as const };
    expect(mergeVerdict(noImpl, { stance: 'long', confidence: 0.9, reasons: [] }).out.stance).toBe('abstain');
    // 数据缺的弃权进共识仍然是弃权 → 不构成一票
    expect(consensus([{ ...verdict('a', 'abstain'), stance: 'abstain' }, verdict('b', 'long')], { ...DEFAULT_COUNCIL_POLICY, mode: 'advise', min_agree: 1 })).toMatchObject({ agreeing: ['b'], abstaining: ['a'], voting: ['b'] });
  });
});

// ---------------------------------------------------------------- 09-12:方向裁决 × 入场时机裁决

describe('strategy council · 方向成立与入场时机是两个裁决', () => {
  const feats = [feat('15m', true), feat('1h', true), feat('4h', true)];

  it('回踩未确认时方向照样成立,时机 pending;确认了才是 confirmed', () => {
    const pending = run('breakout_retest', { features: feats }, chk({ retest_confirmed: false, watch_eligible: true }));
    expect(pending).toMatchObject({ stance: 'long', entry_timing: 'pending' });
    expect(pending.confidence).toBeGreaterThanOrEqual(0.4);
    expect(run('breakout_retest', { features: feats }, chk({ retest_confirmed: true })).entry_timing).toBe('confirmed');
    // 不是「还没到」而是「别的判据坏了」→ 不投方向票
    expect(run('breakout_retest', { features: feats }, chk({ retest_confirmed: false, watch_eligible: false, within_chase: false })).stance).toBe('neutral');
  });

  it('共识取同意方里最保守的时机,pending 时只许限价、市价被拒', () => {
    const r = runCouncil({ ...base, features: feats, klines: {}, strategies: [spec('breakout_retest'), spec('mtf_alignment')], woken_ids: ['breakout_retest', 'mtf_alignment'], fit_for: () => ({ radar_fit: null, history: null }), policy: { mode: 'require', min_agree: 2, confidence_floor: 0.4 } });
    expect(r.consensus).toMatchObject({ reached: true, direction: 'long', entry_timing: 'confirmed' });
    // 手工造一份 pending 共识:方向成立,但同意方里有一条说回踩没确认
    const pendingConsensus = { ...r, consensus: { ...r.consensus, entry_timing: 'pending' as const } };
    expect(consensusGate({ action: 'PROPOSE', direction: 'long', strategy_id: 'breakout_retest', proposal: { entry: 'market' } }, pendingConsensus, 'require').passed).toBe(false);
    expect(consensusGate({ action: 'PROPOSE', direction: 'long', strategy_id: 'breakout_retest', proposal: { entry: 'market' } }, pendingConsensus, 'require').reason).toContain('只许限价');
    expect(consensusGate({ action: 'PROPOSE', direction: 'long', strategy_id: 'breakout_retest', proposal: { entry: 'limit' } }, pendingConsensus, 'require').passed).toBe(true);
    expect(consensus([verdict('a', 'long', 0.6, 'pending'), verdict('b', 'long')], { ...DEFAULT_COUNCIL_POLICY, mode: 'require' }).entry_timing).toBe('pending');
  });
});

describe('strategy council · 缺数据一律给明确的弃权原因', () => {
  it('每条策略在关键判据算不出来时都 abstain 并说明,而不是投中立票', () => {
    const feats = [feat('15m', true), feat('1h', true), feat('4h', true)];
    expect(run('breakout_retest', { features: feats }, chk({ atr_pct: null }))).toMatchObject({ stance: 'abstain', abstain_reason: 'data' });
    expect(run('mtf_alignment', { features: feats }, chk({ price_above_ema20: null }))).toMatchObject({ stance: 'abstain', abstain_reason: 'data' });
    expect(run('vol_compression_expansion', { features: feats }, chk({ vol_ratio: null }))).toMatchObject({ stance: 'abstain', abstain_reason: 'data' });
    const rev = codeVerdict(spec('range_mean_reversion'), { ...base, features: feats, klines: { '15m': [] }, woken: true });
    expect(rev.out).toMatchObject({ stance: 'abstain', abstain_reason: 'data' });
    expect(rev.out.reasons.join()).toContain('数据不足 0/400');
  });

  it('策略自己声明需要多少根 K 线,取数按启用策略的 max(min_bars)', () => {
    expect(spec('range_mean_reversion').checklist.min_bars).toBe(400);
    expect(spec('breakout_retest').checklist.min_bars).toBeUndefined();
    expect(minBarsFor([spec('breakout_retest')])).toBe(DEFAULT_SCAN_BARS);
    expect(minBarsFor([spec('breakout_retest'), spec('range_mean_reversion')])).toBe(400 + KLINE_FETCH_MARGIN); // 余量:还在走的那根会被切掉
    expect(minBarsFor([])).toBe(DEFAULT_SCAN_BARS);
  });
});

// ---------------------------------------------------------------- P1-05:总决策对纯代码允许集单调收窄

/** 把一张票还原成 mergeVerdict 的输入(codeVerdict 的输出形状)。 */
const asOut = (v: StrategyVerdict) => ({ stance: v.stance, confidence: v.confidence, entry_timing: v.entry_timing, checks: [], reasons: v.reasons });
/** 代码票 × 模型票 → 合并后的票(与 runCouncil 里同一条路径)。 */
const merged = (v: StrategyVerdict, vote: Parameters<typeof mergeVerdict>[1]): StrategyVerdict => {
  const { out, source } = mergeVerdict(asOut(v), vote);
  return { ...v, stance: out.stance, confidence: Math.round(out.confidence * 100) / 100, entry_timing: out.entry_timing ?? (out.stance === 'long' || out.stance === 'short' ? 'confirmed' : null), source };
};
const timingRank = { confirmed: 0, pending: 1, failed: 2 } as const;

describe('strategy council · 模型只能收窄总决策(P1-05)', () => {
  const p = { mode: 'require' as const, min_agree: 2, confidence_floor: 0.4 };

  it('反例一:模型把反向票压成中立,不能因此解除代码层的方向冲突', () => {
    const code = [verdict('a', 'long', 0.7), verdict('b', 'long', 0.7), verdict('c', 'short', 0.7)];
    // 模型给 C 一张 long 票 → mergeVerdict 把 C 降成 neutral(单票只减权),冲突消失
    const after = [code[0]!, code[1]!, merged(code[2]!, { stance: 'long', confidence: 0.9, reasons: [] })];
    expect(consensus(after, p).reached).toBe(true); // 合并后的裸共识确实被放行(这就是缺陷)
    const codeC = consensus(code, p);
    expect(codeC.reached).toBe(false);
    const final = narrowByCode(codeC, consensus(after, p));
    expect(final).toMatchObject({ reached: false, direction: null, agreeing: [] });
    expect(final.reason).toContain('代码裁决不允许');
  });

  it('反例二:模型把 pending 的那张票压到信心线以下,不能把整体时机变成 confirmed', () => {
    const code = [verdict('a', 'long', 0.7), verdict('b', 'long', 0.7), verdict('c', 'long', 0.45, 'pending')];
    expect(consensus(code, p).entry_timing).toBe('pending');
    // 模型给 C 中立 → 0.45×0.7 = 0.315 掉出 strong,整体 timing 变 confirmed(市价获准)
    const after = [code[0]!, code[1]!, merged(code[2]!, { stance: 'neutral', confidence: 0.9, reasons: [] })];
    expect(consensus(after, p).entry_timing).toBe('confirmed');
    const final = narrowByCode(consensus(code, p), consensus(after, p));
    expect(final).toMatchObject({ reached: true, direction: 'long', entry_timing: 'pending' });
    // 闸口径:pending 时市价仍被拒
    const r = { version: 'council-v1', at: 0, symbol: 'XUSDT', mode: 'require' as const, verdicts: after, consensus: final, text: '' };
    expect(consensusGate({ action: 'PROPOSE', direction: 'long', strategy_id: 'a', proposal: { entry: 'market' } }, r, 'require').passed).toBe(false);
    expect(consensusGate({ action: 'PROPOSE', direction: 'long', strategy_id: 'a', proposal: { entry: 'limit' } }, r, 'require').passed).toBe(true);
  });

  it('模型不能把代码没同意的策略塞进同意方(同意方取交集)', () => {
    const code = [verdict('a', 'long', 0.7), verdict('b', 'long', 0.7), verdict('c', 'neutral', 0)];
    const after = [code[0]!, code[1]!, { ...code[2]!, stance: 'long' as const, confidence: 0.9, entry_timing: 'confirmed' as const }];
    const final = narrowByCode(consensus(code, p), consensus(after, p));
    expect(final.agreeing).toEqual(['a', 'b']);
    expect(final.reached).toBe(true);
  });

  it('性质测试:随机模型票 × 代码裁决 → 最终允许集 ⊆ 代码允许集', () => {
    // 固定种子的 LCG:同一份用例每次跑出同一批随机票,失败可复现。
    let seed = 20260912;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const stances = ['long', 'short', 'neutral', 'abstain'] as const;
    const timings = ['confirmed', 'pending', 'failed'] as const;
    const policies = [
      { mode: 'require' as const, min_agree: 2, confidence_floor: 0.4 },
      { mode: 'require' as const, min_agree: 1, confidence_floor: 0.4 },
      { mode: 'advise' as const, min_agree: 2, confidence_floor: 0.5 },
    ];
    for (let iter = 0; iter < 2_000; iter++) {
      const policy = pick(policies);
      const n = 2 + Math.floor(rnd() * 3);
      const code: StrategyVerdict[] = [];
      const after: StrategyVerdict[] = [];
      for (let i = 0; i < n; i++) {
        const st = pick(stances);
        const v = verdict(`s${i}`, st, Math.round(rnd() * 100) / 100, st === 'long' || st === 'short' ? pick(timings) : null);
        code.push(v);
        after.push(rnd() < 0.3 ? v : merged(v, { stance: pick(stances), confidence: Math.round(rnd() * 100) / 100, reasons: [] }));
      }
      const codeC = consensus(code, policy);
      const final = narrowByCode(codeC, consensus(after, policy));
      const where = `iter=${iter} code=${code.map((v) => `${v.stance}${v.confidence}${v.entry_timing ?? ''}`).join(',')}`;
      // 1. 模型不能把「不可执行」变成可执行
      if (final.reached) expect(codeC.reached, where).toBe(true);
      if (final.gate_effective) expect(codeC.gate_effective, where).toBe(true);
      // 2. 方向只能是代码的那个方向(或没有方向)
      if (final.direction !== null) expect(final.direction, where).toBe(codeC.direction);
      // 3. 同意方 ⊆ 代码同意方
      for (const id of final.agreeing) expect(codeC.agreeing, where).toContain(id);
      // 4. 入场方式允许集 ⊆ 代码允许集(pending 只许限价,不能被放宽成 confirmed)
      if (final.entry_timing) expect(timingRank[final.entry_timing] >= timingRank[codeC.entry_timing ?? 'confirmed'], where).toBe(true);
    }
  });
});
