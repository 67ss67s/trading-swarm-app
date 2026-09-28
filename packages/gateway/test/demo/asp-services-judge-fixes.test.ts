// 09-27 买方交付优化:计划把关总给修正建议、概率判断的模型 vs 历史解读与降级、资产×周期零合格时的最接近候选。零网络。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResearchBar } from '@trade-gate/contracts';
import { openStateDb } from '../../src/state-db.js';
import { stubProfile } from '../../src/demo/research/judge/stubs.js';
import type { DecisionProvider } from '../../src/demo/research/judge/types.js';
import { BANNED_WORDS } from '../../src/demo/asp-agent/publisher.js';
import { ServiceInputError, type PerCallJob } from '../../src/demo/asp-agent/services/types.js';
import { targetsIn } from '../../src/demo/asp-agent/services/params.js';
import { atr14, createJevProbabilityService, jevJudge, type JevBinding, type JevDeps } from '../../src/demo/asp-agent/services/jev-probability.js';
import { createPlanGateService, planGateService, type PlanGateDeps } from '../../src/demo/asp-agent/services/plan-gate.js';
import { assetHorizonService, type AssetHorizonDeps } from '../../src/demo/asp-agent/services/asset-horizon.js';
import { STRUCTURED_HEADER } from '../../src/demo/asp-agent/services/render.js';
import type { AssetRecommendation, HorizonFit, RecommendationRow } from '../../src/demo/recommend.js';
import type { DailyRegime } from '../../src/demo/types.js';

const H = 3_600_000, START = Date.UTC(2026, 8, 1);
function makeBars(n = 150): ResearchBar[] {
  let prev = 100;
  return Array.from({ length: n }, (_, i) => {
    const c = 100 + i * 0.05 + Math.sin(i * Math.PI / 4), o = prev; prev = c;
    const at = START + i * H;
    return { open_time: at, close_time: at + H - 1, available_at: at + H - 1, open: o.toFixed(6), high: (Math.max(o, c) + 0.5 + (i % 8 === 2 ? 0.4 : 0)).toFixed(6), low: (Math.min(o, c) - 0.5 - (i % 8 === 6 ? 0.4 : 0)).toFixed(6), close: c.toFixed(6), volume: '100' };
  });
}
const BARS = makeBars(600), LAST = Number(BARS.at(-1)!.close), ATR = atr14(BARS.slice(-150)), NOW = BARS.at(-1)!.close_time + 60_001;
const CJK = /[　-〿一-鿿＀-￯]/;
const ADVICE = /倾向值得|建议(买入|卖出|入场|开仓)|\brecommend|\bshould (buy|sell|enter|go long|go short)\b|worth entering|\bwe suggest\b/i;
const head = (t: string) => t.split(`\n\n${STRUCTURED_HEADER}`)[0]!;
const regime = (r: DailyRegime['regime'], extra: Partial<DailyRegime> = {}): DailyRegime => ({ regime: r, ema_stack: '价>EMA20, EMA20>EMA50', ret_20d_pct: 5, ret_5d_pct: 1, vol_pct_rank: 0.92, atr_pct: 4.6, dist_to_ema200_pct: null, text: r, as_of: NOW, ...extra });
const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((f) => f()));

function provider(p: Record<string, number> | 'throw'): DecisionProvider & { calls: number } {
  const profile = stubProfile('deterministic', 5);
  const prov = { profile, calls: 0, async decide(req: { questions: Record<string, unknown> }) {
    prov.calls++;
    if (p === 'throw') throw new Error('provider_timeout');
    return { model: profile.model, answers: Object.fromEntries(Object.keys(req.questions).map((k) => [k, { type: 'noul', noul: p[k] ?? 0.3 }])), usage: { input_tokens: 0, cost_usd: 0 }, latency_ms: 0 };
  } };
  return prov as unknown as DecisionProvider & { calls: number };
}
function deps(p: Record<string, number> | 'throw', o: { regime?: DailyRegime['regime'] } = {}): JevDeps & PlanGateDeps {
  const state = openStateDb(':memory:'); closers.push(() => state.close());
  const prov = provider(p), b: JevBinding = { profile: prov.profile, provider: prov, db: state.db };
  return {
    now: () => NOW, recommend: async () => { throw new Error('x'); }, matrix: () => null,
    bars: async (_s, _tf, limit) => BARS.slice(-limit), regime: async () => regime(o.regime ?? 'bull'),
    jev: () => b, judge: jevJudge(() => b, ['take', 'regime_fit']), quoteVolume24h: async () => 5e9,
  };
}
const pj = (x: Record<string, unknown>, id = 'job_fix_1'): PerCallJob => ({ job_id: id, service_key: 'plan_gate', description: 'check my plan', service_params: JSON.stringify({ symbol: 'BTC', side: 'long', timeframe: '1h', ...x }) });

describe('params.targetsIn', () => {
  it('周期不被当成目标(上架示例原句)', () => {
    expect(targetsIn('BTC long, entry 84300, stop 83100, target 86500, 1h')).toEqual([86500]);
    expect(targetsIn('targets: 65000, 66000, 12h')).toEqual([65000, 66000]);
    expect(targetsIn('target 86500,15m')).toEqual([86500]);
    expect(targetsIn('TP1 65000 TP2 66000, 4h')).toEqual([65000, 66000]);
    expect(targetsIn('止盈 65000 / 66000')).toEqual([65000, 66000]);
    expect(targetsIn('目标65500，周期1小时')).toEqual([65500]);
    expect(planGateService.validate({ job_id: 'x', service_key: 'plan_gate', description: 'BTC long, entry 84300, stop 83100, target 86500, 1h', service_params: null })).toMatchObject({ targets: [86500], timeframe: '1h' });
  });
});

describe('plan_gate 修正建议', () => {
  const good = { entry: +LAST.toFixed(4), stop: +(LAST - 1.5 * ATR).toFixed(4), targets: [+(LAST + 3 * ATR).toFixed(4)] };
  it('PASS / UNCERTAIN / FAIL 都带「Suggested fixes」一节,含结构止损、入场、历史备选几何、仓位算术;英文、无建议腔', async () => {
    for (const [p, plan, want, rg] of [
      [{ take: 0.85, regime_fit: 0.8 }, good, 'pass', 'bull'],
      // r2 改动:AI 不再决定结论 —— 同一计划 AI 只给 17% 也是 PASS(代码证据:600 根历史清楚高于盈亏平衡、无软门槛)
      [{ take: 0.17, regime_fit: 0.14 }, good, 'pass', 'bull'],
      // UNCERTAIN 改由代码证据触发:日线空头 → 做多逆势(软门槛)
      [{ take: 0.85, regime_fit: 0.8 }, good, 'uncertain', 'bear'],
      [{ take: 0.85 }, { ...good, targets: [good.entry + ATR] }, 'fail', 'bull'],
    ] as const) {
      const d = await planGateService.handle(pj(plan), planGateService.validate(pj(plan)), deps(p as Record<string, number>, { regime: rg }));
      expect(d.payload['verdict']).toBe(want);
      const h = head(d.text);
      expect(h).toMatch(/\nSuggested fixes \/ what would make it stronger[^\n]*:\n→ /);
      expect(h).toMatch(/→ Stop vs structure: /);
      expect(h).toMatch(/→ Sizing: the stop is [\d.]+% from entry, so risking 1% of equity means a notional of ~[\d.]+× equity/);
      expect(h).not.toMatch(CJK);
      expect(ADVICE.test(h)).toBe(false);
      expect(BANNED_WORDS.test(d.text)).toBe(false);
      const fixes = d.payload['fixes'] as { suggestions: string[]; sizing: unknown; alternatives: unknown[] };
      expect(fixes.suggestions.length).toBeGreaterThanOrEqual(3);
      expect(fixes.sizing).not.toBeNull();
      if (want === 'fail') { expect(d.payload['verdict_detail']).toBe('fixable'); expect(h).toContain('the failed gates are fixable'); expect(h).toMatch(/→ Reward\/risk [\d.]+: target 1 needs to be at least/); }
      else expect(d.payload['verdict_detail']).toBeNull();
    }
  });
  it('AI 一行写明局限;同一历史备选几何带期望值', async () => {
    const d = await planGateService.handle(pj(good), planGateService.validate(pj(good)), deps({ take: 0.17, regime_fit: 0.14 }));
    expect(head(d.text)).toContain('Limits: an uncalibrated model reference, consulted only after all hard gates pass');
    const alts = (d.payload['fixes'] as { alternatives: { label: string; expectancy_r: number }[] }).alternatives;
    expect(alts[0]!.label).toBe('current plan');
    expect(head(d.text)).toMatch(/→ Same-history check \(last 600 closed bars, unconditional, before fees\): current plan: target 1 first \d+% → [+-]\d\.\d\dR\/trade/);
  });
  it('止损在结构里面 → 给结构止损价;旧价格 → 按现价重锚', async () => {
    const inside = { entry: good.entry, stop: +(LAST - 0.6 * ATR).toFixed(4), targets: [+(LAST + 3 * ATR).toFixed(4)] };
    const d = await planGateService.handle(pj(inside), planGateService.validate(pj(inside)), deps({ take: 0.8 }));
    const sug = (d.payload['fixes'] as { suggestions: string[] }).suggestions.join('\n');
    expect(sug).toMatch(/Stop vs structure: (the stop [\d.,]+ sits above the nearest swing low|the stop [\d.,]+ sits just beyond|the stop is [\d.]+ ATR beyond)/);
    const stale = { entry: +(LAST * 0.8).toFixed(4), stop: +(LAST * 0.79).toFixed(4), targets: [+(LAST * 0.82).toFixed(4)] };
    const s = await planGateService.handle(pj(stale, 'job_fix_stale'), planGateService.validate(pj(stale)), deps({ take: 0.8 }));
    expect(s.payload['verdict_detail']).toBe('invalidated');
    expect(head(s.text)).toMatch(/→ Re-anchor: the plan does not hold at the last price [\d.,]+; the same distances from there put the stop at [\d.,]+ and target 1 at [\d.,]+/);
  });
  it('createPlanGateService:tradable=false → 接单前拒单(symbol_unknown);不注入时与原服务一致', () => {
    const svc = createPlanGateService({ tradable: (s) => s !== 'FOOUSDT' });
    const j = { job_id: 'x', service_key: 'plan_gate' as const, description: 'FOO long entry 1 stop 0.9 target 1.3', service_params: null };
    try { svc.validate(j); throw new Error('no'); } catch (e) { expect((e as ServiceInputError).code).toBe('symbol_unknown'); expect((e as Error).message).toMatch(/^FOOUSDT has no tradable OKX USDT perpetual market/); }
    expect(createPlanGateService().validate(pj(good))).toEqual(planGateService.validate(pj(good)));
  });
});

describe('jev_probability 解读', () => {
  const jj = (x: Record<string, unknown> | null, description = 'probability check please', id = 'job_jev_fix'): PerCallJob => ({ job_id: id, service_key: 'jev_probability', description, service_params: x ? JSON.stringify(x) : null });
  it('模型 vs 历史逐题差值 + 解释;模型各题答案挤在一起而历史频率拉得开 → 标区分度低,给代码结论', async () => {
    const svc = createJevProbabilityService();
    const d = await svc.handle(jj({ symbol: 'BTC' }), svc.validate(jj({ symbol: 'BTC' })), deps({ take: 0.3, support_holds: 0.3, resistance_breaks: 0.3, retreat_risk: 0.3 }));
    const h = head(d.text);
    expect(h).toMatch(/Model vs history: support holds model 30% vs history \d+% \([+−]\d+ pts\)/);
    expect(h).toContain('Why they differ: the historical rate counts every past window');
    expect(h).toMatch(/Model informativeness: low — its answers sit all at 30% across 4 different questions while the historical rates range/);
    expect(h).toMatch(/Bottom line \(history \+ code features\): entry setup — at these distances target 1 came before the stop \d+% of the time vs 33% breakeven/);
    expect(d.payload['model_status']).toMatchObject({ answered: true, informative: false });
    expect(h).not.toMatch(CJK);
    expect(ADVICE.test(h)).toBe(false);
  });
  it('没写币种:仍默认 BTCUSDT,首行标注假设,Assumption 行紧随其后', async () => {
    const svc = createJevProbabilityService();
    const j = jj(null, 'Crypto Entry Setup Review: will support hold?');
    const d = await svc.handle(j, svc.validate(j), deps({ take: 0.4 }));
    const lines = head(d.text).split('\n');
    expect(lines[1]).toMatch(/^Conclusion: BTCUSDT 1h \[symbol assumed, none given\] long/);
    expect(lines[2]).toMatch(/^Assumption: No symbol was given, so this check uses BTCUSDT 1h/);
    expect(d.payload['assumptions']).toHaveLength(1);
  });
  it('模型调用失败(非预算)→ 不抛错,降级为只用历史频率 + 代码特征的交付,写明模型未参与,不用 AI 免责', async () => {
    const svc = createJevProbabilityService();
    const d = await svc.handle(jj({ symbol: 'BTC' }), svc.validate(jj({ symbol: 'BTC' })), deps('throw'));
    const h = head(d.text);
    expect(d.summary).toMatch(/^Conclusion: BTCUSDT 1h long \(at last price\) — AI model did not answer for this order; code-only reading: /);
    expect(h).toContain('AI model: did not return an answer for this order (model call failed)');
    expect(h).toMatch(/Bottom line \(history \+ code features only\)/);
    expect(h).toContain('model not available');
    expect(h).not.toContain('Contains AI-generated');
    expect(d.payload['model_status']).toMatchObject({ answered: false });
    expect(h).not.toMatch(/provider_timeout|stub/i);
  });
  it('tradable=false → validate 拒单 symbol_unknown(不再接单后拉 K 线失败 3 次)', () => {
    const svc = createJevProbabilityService({ tradable: (s) => s !== 'FOOUSDT' });
    try { svc.validate(jj({ symbol: 'FOO' })); throw new Error('no'); } catch (e) { expect((e as ServiceInputError).code).toBe('symbol_unknown'); }
    expect(svc.validate(jj({ symbol: 'ETH' }))).toMatchObject({ symbol: 'ETHUSDT' });
  });
});

describe('asset_horizon 零合格', () => {
  const no = (reason: string): HorizonFit => ({ eligible: false, reason, direction: null, families: [], evidence: [] });
  const row = (symbol: string, o: Partial<RecommendationRow>): RecommendationRow => ({ symbol, market: 'perp', quote_vol_24h: 1e8, depth_usd_05: null, regime: 'volatile', scan: null, radar: {}, horizons: { short: no('not_requested'), mid: no('regime'), long: no('not_requested') }, ...o });
  it('某档一个都不合格 → 按强弱列最接近候选,写具体门槛与合格水平;同样原因只写一行', async () => {
    const rows = [
      row('SOLUSDT', { radar: { mid: { rank: 1, fit: 1, reasons: [] } }, scan: { rank: 30, score: 0.5, reasons: [] }, quote_vol_24h: 1.8e9 }),
      row('SUIUSDT', { scan: { rank: 2, score: 0.5, reasons: [] } }),
      row('WLDUSDT', { scan: { rank: 4, score: 0.5, reasons: [] } }),
      row('OPUSDT', { scan: { rank: 6, score: 0.5, reasons: [] } }),
      row('TINYUSDT', { regime: 'bull', scan: { rank: 3, score: 0.5, reasons: [] }, quote_vol_24h: 1e6, horizons: { short: no('not_requested'), mid: no('liquidity'), long: no('not_requested') } }),
    ];
    const rec: AssetRecommendation = { id: 'r', as_of: NOW, warnings: [], source: { universe_scan_at: NOW, regime_at: NOW, radar_at: {} }, rows };
    const regimeFn = vi.fn(async (s: string) => regime('volatile', s === 'SUIUSDT' ? { ema_stack: '价<EMA20, EMA20<EMA50', ret_20d_pct: -8 } : {}));
    const d: AssetHorizonDeps = { now: () => NOW, recommend: async () => rec, matrix: () => null, bars: async () => [], regime: regimeFn };
    const out = await assetHorizonService.handle({ job_id: 'a', service_key: 'asset_horizon', description: 'mid', service_params: '{"horizons":["mid"]}' }, { horizons: ['mid'], market: 'perp', top_n: 8 }, d);
    const h = head(out.text);
    expect(out.summary).toBe('Asset × horizon picks (USDT perpetual): Mid-term none qualified (closest: SOL, SUI, TINY)');
    expect(h).toContain('Closest candidates for mid-term');
    expect(h).toContain('1. SOLUSDT (Radar swing tier #1; market scan #30; 24h volume 1.80B) — blocked by daily volatility gate: 20d realized volatility at p92 of the last 100 days (daily ATR 4.6%); qualifies at 20d realized volatility below p85; the daily EMA stack is bullish, so once volatility eases it would read as an uptrend (long bias, trend families)');
    expect(h).toMatch(/2\. SUIUSDT .*would read as a downtrend \(short bias/);
    expect(h).toMatch(/3\. TINYUSDT .*blocked by 24h volume 1\.0M; qualifies at 24h volume ≥ 5\.0M \(5\.0× current\)/);
    expect(h).toContain('· SOL, OP, SUI, WLD (4 coins, Daily high volatility) — Mid-term: High daily volatility; frequent false breakouts on shorter horizons, excluded for now');
    expect(h.match(/High daily volatility; frequent false breakouts/g)).toHaveLength(1);
    expect((out.payload['closest'] as Record<string, { symbol: string }[]>)['mid']!.map((c) => c.symbol)).toEqual(['SOLUSDT', 'SUIUSDT', 'TINYUSDT', 'WLDUSDT', 'OPUSDT']);
    expect(h).not.toMatch(CJK);
    expect(ADVICE.test(h)).toBe(false);
    expect(BANNED_WORDS.test(out.text)).toBe(false);
  });
});
