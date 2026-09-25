import { describe, expect, it } from 'vitest';
import { checkIR } from '../../../../src/demo/research/strategy.js';
import { validateJudge } from '../../../../src/demo/research/judge/pure.js';
import { buildManifest, estimate, manifestHash } from '../../../../src/demo/research/matrix-study/manifest.js';
import { defaultJudge, normalizeSpec, prefillFromRecommendation } from '../../../../src/demo/research/matrix-study/spec.js';
import { blockBootstrapP, holm, selectionGates, causeOf } from '../../../../src/demo/research/matrix-study/stats.js';
import { accountReplay } from '../../../../src/demo/research/matrix-study/portfolio.js';
import { DEFAULT_PROTOCOL } from '../../../../src/demo/research/matrix-study/spec.js';
import type { AssetRecommendation } from '../../../../src/demo/recommend.js';
import { PROFILE, TO_MS, baseSpec } from './fixtures.js';

const NOW = TO_MS + 86400000;
const fit = (eligible: boolean, direction: 'long' | 'short' | 'both' | null, families: string[], reason: string | null = null) => ({ eligible, reason, direction, families, evidence: [] });
const REC: AssetRecommendation = {
  id: 'rec_1', as_of: NOW, source: { universe_scan_at: NOW - 3600000, regime_at: NOW }, warnings: [],
  rows: [
    { symbol: 'BTCUSDT', market: 'perp', quote_vol_24h: 5e9, depth_usd_05: 5e7, regime: 'bull', scan: { rank: 1, score: 2, reasons: [] }, horizons: { short: fit(true, 'long', ['breakout']), mid: fit(true, 'long', ['breakout', 'pullback']), long: fit(true, 'long', ['ma_trend']) } },
    { symbol: 'DOGEUSDT', market: 'perp', quote_vol_24h: 1e8, depth_usd_05: null, regime: 'bull', scan: null, horizons: { short: fit(false, null, [], 'liquidity'), mid: fit(true, 'long', ['breakout']), long: fit(false, null, [], 'history') } },
  ],
} as unknown as AssetRecommendation;

describe('matrix study:规格 / manifest / 统计(纯函数)', () => {
  it('推荐预填只取 eligible 格子;1h/12h 不在首版周期里写 notes;按推荐冻结每格可研究性', () => {
    const p = prefillFromRecommendation(REC);
    expect(p.spec.symbols).toEqual(['BTCUSDT', 'DOGEUSDT']);
    expect(p.spec.timeframes).toEqual(['3m', '5m', '15m', '4h', '1d']);
    expect(p.spec.families!.sort()).toEqual(['breakout', 'ma_trend', 'pullback']);
    expect(p.spec.sides).toEqual(['long']);
    expect(p.notes.join()).toMatch(/1h/);
    const spec = normalizeSpec({ recommendation_id: 'rec_1', to_ms: TO_MS }, { now: NOW, recommendation: REC, model_profile: PROFILE });
    const m = buildManifest(spec, REC, NOW);
    const c = (id: string) => m.cells.find((x) => x.id === id)!;
    expect(c('BTCUSDT|3m|breakout|long|code').applicability).toBe('research_only');
    expect(c('DOGEUSDT|15m|breakout|long|code')).toMatchObject({ applicability: 'not_applicable', reason: 'recommendation:liquidity' });
    expect(c('DOGEUSDT|1d|breakout|long|code')).toMatchObject({ applicability: 'not_applicable', reason: 'recommendation:history' });
    expect(c('DOGEUSDT|4h|breakout|long|code').applicability).toBe('applicable');
    // research_only / not_applicable 不填零:没有变体、没有成绩
    expect(m.cells.filter((x) => x.applicability !== 'applicable').every((x) => x.variants.length === 0)).toBe(true);
    expect(spec.origin).toEqual({ chat_session_id: null });
    expect(spec.auto_finalize).toBe(true);
  });

  it('组合族 / 现货做空 / smc 空头 / 没有判断配置的 code_judge 臂都标 not_applicable', () => {
    const spec = normalizeSpec({ ...baseSpec(), families: ['xsmom', 'smc', 'breakout'], market: 'perp', sides: ['long', 'short'], arms: ['code', 'code_judge'] }, { now: NOW });
    const m = buildManifest(spec, null, NOW), r = (id: string) => m.cells.find((x) => x.id === id)!;
    expect(r('BTCUSDT|4h|xsmom|long|code').reason).toBe('portfolio_family_separate_study');
    expect(r('BTCUSDT|4h|smc|short|code').reason).toBe('family_side_unavailable');
    expect(r('BTCUSDT|4h|breakout|long|code_judge').reason).toBe('judge_runtime_unavailable');
    const spot = buildManifest(normalizeSpec({ ...baseSpec(), sides: ['long', 'short'] }, { now: NOW }), null, NOW);
    expect(spot.cells.find((x) => x.side === 'short')!.reason).toBe('spot_cannot_short');
  });

  it('code_judge 臂:缺省判断要素合法,IR 升 v2 带 judge 仍过 checkIR;manifest 哈希稳定', () => {
    validateJudge(defaultJudge(PROFILE.ref));
    const spec = normalizeSpec({ ...baseSpec(), arms: ['code', 'code_judge'], model_profile: PROFILE }, { now: NOW });
    expect(spec.judge?.model_profile_ref).toBe(PROFILE.ref);
    const m = buildManifest(spec, null, NOW), cj = m.cells.find((x) => x.arm === 'code_judge' && x.applicability === 'applicable')!;
    for (const v of cj.variants) { expect(v.ir.version).toBe(2); const r = checkIR(v.ir, '4h'); expect(r.checks.filter((x) => !x.ok).map((x) => x.name)).toEqual([]); }
    expect(manifestHash(m)).toBe(manifestHash(buildManifest(spec, null, NOW)));
    // 段间 purge 空档、留出在最后
    const g = m.segments['4h']!;
    expect(g.selection.from_ms - g.train.to_ms).toBe((spec.purge_bars + 1) * 4 * 3600000);
    expect(g.holdout.from_ms).toBeGreaterThan(g.selection.to_ms);
    expect(g.holdout.to_ms).toBe(TO_MS);
    const e = estimate(m);
    expect(e.matrix_trials).toBe(16); // 2 资产 × ema_cross 4 组参数 × 2 臂
    expect(e.judge_calls).toBeGreaterThan(0);
    expect(e.judge_usd).toMatch(/^\d+(\.\d+)?$/);
  });

  it('规格校验:未知字段、预算超限、协议不能放宽到门槛以下', () => {
    expect(() => normalizeSpec({ ...baseSpec(), foo: 1 }, { now: NOW })).toThrow('unknown_fields:foo');
    expect(() => normalizeSpec({ ...baseSpec(), protocol: { min_trades: 10 } }, { now: NOW })).toThrow('protocol.min_trades_invalid');
    expect(() => normalizeSpec({ ...baseSpec(), budget: { max_judge_usd: 1 } }, { now: NOW })).toThrow();
    const big = normalizeSpec({ ...baseSpec(), families: ['breakout', 'ma_trend', 'ema_cross', 'pullback', 'mean_reversion', 'smc'], market: 'perp', sides: ['long', 'short'], symbols: ['BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'BNB'], budget: { max_variants: 50 } }, { now: NOW });
    expect(estimate(buildManifest(big, null, NOW)).within_budget).toBe(false);
  });

  it('Holm:逐步下降、遇到第一个不拒绝即停;p=null 不拒绝', () => {
    expect(holm([0.001, 0.02, 0.2], 0.05).map((x) => x.rejected)).toEqual([true, true, false]);
    expect(holm([0.03, 0.001], 0.05).map((x) => x.rejected)).toEqual([true, true]);
    expect(holm([0.04, 0.03], 0.05).map((x) => x.rejected)).toEqual([false, false]);
    expect(holm([null, 0.001], 0.05).map((x) => x.rejected)).toEqual([false, true]);
  });

  it('块 bootstrap:强正收益显著,零均值不显著,块数不够给 null(证据不足)', () => {
    const P = { ...DEFAULT_PROTOCOL, bootstrap_replicates: 499, block_days: 3 };
    const pos = Array.from({ length: 120 }, (_, i) => 0.004 + (i % 5 === 0 ? -0.006 : 0.001));
    const zero = Array.from({ length: 120 }, (_, i) => (i % 2 ? 0.01 : -0.01));
    expect(blockBootstrapP(pos, P).p!).toBeLessThan(0.01);
    expect(blockBootstrapP(zero, P).p!).toBeGreaterThan(0.2);
    expect(blockBootstrapP(pos.slice(0, 30), P).p).toBeNull();
  });

  it('选择段门槛与主因:样本不足优先;毛收益为正而扣费后为负 → cost_dominated', () => {
    const s = { members: ['X'], trades: 40, total_return: -0.02, sharpe: -0.5, period_sharpe: -0.03, days: 150, skew: 0, kurtosis: 3, max_drawdown: 0.1, exposure: 0.5, expectancy: -0.0005, win_rate: 0.5, stressed_return: -0.05, hold_return: 0.1, exposure_matched_hold: 0.05, btc_hold_return: null };
    const g = selectionGates(s, 0.2, DEFAULT_PROTOCOL);
    expect(causeOf(s, 0.03, g)).toBe('cost_dominated');
    expect(causeOf(s, -0.01, g)).toBe('underperform_hold');
    expect(causeOf({ ...s, trades: 5 }, 0.03, selectionGates({ ...s, trades: 5 }, 0.2, DEFAULT_PROTOCOL))).toBe('insufficient_evidence');
    expect(causeOf(null, null, [])).toBe('unsupported_execution');
  });

  it('账户级回放:每笔风险定名义、同时持仓上限跳过、判断跳过单独计数', () => {
    const t = (sym: string, a: number, b: number, r: number) => ({ symbol: sym, entry_at: a, exit_at: b, return_pct: r });
    const c = (sym: string, at: number, action: 'follow' | 'skip' | null = null) => ({ symbol: sym, as_of: at, entry: '100', stop: '98', action });
    const out = accountReplay([t('A', 10, 50, 0.02), t('B', 11, 50, 0.02), t('C', 12, 50, 0.02), t('D', 13, 50, 0.02)], [c('A', 9), c('B', 10), c('C', 11), c('D', 12), c('E', 12, 'skip')], { risk_pct: 0.005, max_open: 3, gross_cap: 1 });
    expect(out.trades).toBe(3);
    expect(out.skipped_by_capacity).toBe(1);
    expect(out.skipped_by_judge).toBe(1);
    // 名义 = 1 万 × 0.5% ÷ 2% = 2500,收益 2% → 每笔 +50
    expect(out.total_return).toBeCloseTo(150 / 10000, 6);
  });
});
