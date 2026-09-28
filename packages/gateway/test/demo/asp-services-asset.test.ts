// ASP 按次服务「资产×周期推荐」服务层:可交易过滤、日线状态补取、强弱排序、英文正文(中文请求照常解析)。零网络,recommend/regime 全部注入。
import { describe, expect, it, vi } from 'vitest';
import { assetHorizonService, stockLike, usdAbbr, type AssetHorizonDeps } from '../../src/demo/asp-agent/services/asset-horizon.js';
import type { PerCallJob } from '../../src/demo/asp-agent/services/types.js';
import { BANNED_WORDS } from '../../src/demo/asp-agent/publisher.js';
import { STRUCTURED_HEADER } from '../../src/demo/asp-agent/services/render.js';

const human = (text: string) => text.split(`\n\n${STRUCTURED_HEADER}`)[0]!;
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
import type { AssetRecommendation, HorizonFit, RecommendationRow } from '../../src/demo/recommend.js';
import type { DailyRegime } from '../../src/demo/types.js';

const NOW = Date.UTC(2026, 8, 25, 9);
const job = (description: string, service_params: string | null = null): PerCallJob => ({ job_id: '0xasset1', service_key: 'asset_horizon', description, service_params });
const ok = (families: HorizonFit['families'] = ['breakout', 'ma_trend'], direction: HorizonFit['direction'] = 'long'): HorizonFit => ({ eligible: true, reason: null, direction, families, evidence: ['24h 永续成交额 1.0B'] });
const unknownOk = (): HorizonFit => ({ eligible: true, reason: null, direction: 'both', families: ['breakout', 'ma_trend', 'mean_reversion'], evidence: ['日线状态未知,族按趋势 + 回归各给一类'] });
const no = (reason: string, ev = '门槛不够'): HorizonFit => ({ eligible: false, reason, direction: null, families: [], evidence: [ev] });
const row = (symbol: string, o: Partial<RecommendationRow> & { mid?: HorizonFit; long?: HorizonFit }): RecommendationRow => ({
  symbol, market: 'perp', quote_vol_24h: 1e8, depth_usd_05: null, regime: 'bull', scan: null, radar: {},
  horizons: { short: no('not_requested'), mid: o.mid ?? ok(), long: o.long ?? ok() }, ...o,
});
const rec = (rows: RecommendationRow[]): AssetRecommendation => ({
  id: 'rec-t', as_of: NOW, warnings: [],
  source: { universe_scan_at: Date.UTC(2026, 8, 25, 0, 22), regime_at: Date.UTC(2026, 8, 24), radar_at: { mid: Date.UTC(2026, 8, 22), long: Date.UTC(2026, 8, 19) } },
  rows,
});
const regime = (r: DailyRegime['regime']): DailyRegime => ({ regime: r, ema_stack: '价>EMA20', ret_20d_pct: 3.2, ret_5d_pct: 1, vol_pct_rank: 0.4, atr_pct: 2, dist_to_ema200_pct: 5, text: '', as_of: NOW });

function deps(rows: RecommendationRow[], o: Partial<AssetHorizonDeps> = {}): AssetHorizonDeps {
  return { now: () => NOW, recommend: vi.fn(async () => rec(rows)), matrix: () => null, bars: async () => [], regime: vi.fn(async () => null), ...o };
}

describe('资产×周期推荐 · 服务层', () => {
  it('平台审核原句:短/中/长三档、永续、全市场扫描', () => {
    expect(assetHorizonService.validate(job('请根据全市场流动性和日线状态,推荐适合短线、中线和长线投资的币种及策略方向。'))).toEqual({ horizons: ['short', 'mid', 'long'], market: 'perp', top_n: 8 });
  });

  it('股票代币/杠杆 ETF 恒剔除;tradable=false 的剔除;写进已剔除', async () => {
    expect(stockLike('SOXSUSDT')).toBe(true);
    expect(stockLike('SNDKUSDT')).toBe(true);
    expect(stockLike('BTC3LUSDT')).toBe(true);
    expect(stockLike('STXUSDT')).toBe(false);
    expect(stockLike('ETHUSDT')).toBe(false);
    const d = deps([row('SNDKUSDT', { radar: { mid: { rank: 1, fit: 1, reasons: [] } } }), row('SOXSUSDT', { regime: 'bear' }), row('FOOUSDT', {}), row('BTCUSDT', { scan: { rank: 1, score: 0.9, reasons: [] } })], { tradable: (s) => s !== 'FOOUSDT' });
    const p = assetHorizonService.validate(job('中线长线永续推荐', '{"horizons":["mid","long"],"market":"perp"}'));
    const out = await assetHorizonService.handle(job('x'), p, d);
    expect(out.payload['picks']).toEqual({ mid: ['BTCUSDT'], long: ['BTCUSDT'] });
    expect(out.text).toContain('Excluded: SNDK, SOXS (stock token / leveraged ETF); FOO (no tradable USDT perpetual on OKX)');
    expect(out.payload['excluded']).toEqual([
      { symbol: 'SNDKUSDT', reason: 'stock_like', reason_text: 'Stock token / leveraged ETF' },
      { symbol: 'SOXSUSDT', reason: 'stock_like', reason_text: 'Stock token / leveraged ETF' },
      { symbol: 'FOOUSDT', reason: 'not_tradable', reason_text: 'Not tradable on OKX right now' },
    ]);
  });

  it('日线状态缺失:重试一次;仍缺 → 不合格不给方向;取到 → 按日线状态重算方向与策略族', async () => {
    const regimeFn = vi.fn(async (s: string) => (s === 'LDOUSDT' ? regime('bull') : s === 'ONDOUSDT' ? regime('volatile') : null));
    const d = deps([
      row('XPLUSDT', { regime: null, mid: unknownOk(), long: no('history', '上市 200 天') }),
      row('LDOUSDT', { regime: null, mid: unknownOk(), long: unknownOk() }),
      row('ONDOUSDT', { regime: null, mid: unknownOk(), long: unknownOk() }),
    ], { regime: regimeFn });
    const out = await assetHorizonService.handle(job('x'), { horizons: ['mid', 'long'], market: 'perp', top_n: 8 }, d);
    expect(regimeFn).toHaveBeenCalledTimes(3);
    const rows = out.payload['rows'] as { symbol: string; regime: string | null; horizons: Record<string, { eligible: boolean; direction: string | null; families: string[]; reason: string | null }> }[];
    const by = Object.fromEntries(rows.map((r) => [r.symbol, r]));
    expect(by['XPLUSDT']!.horizons['mid']).toMatchObject({ eligible: false, reason: 'regime_unavailable', direction: null });
    expect(by['XPLUSDT']!.horizons['long']).toMatchObject({ eligible: false, reason: 'history' });
    expect(by['LDOUSDT']).toMatchObject({ regime: 'bull', horizons: { mid: { eligible: true, direction: 'long', families: ['breakout', 'ma_trend', 'ema_cross', 'pullback'] } } });
    // 高波动:中线不做,长线只给突破、双向
    expect(by['ONDOUSDT']!.horizons['mid']).toMatchObject({ eligible: false, reason: 'regime' });
    expect(by['ONDOUSDT']!.horizons['long']).toMatchObject({ eligible: true, direction: 'both', families: ['breakout'] });
    expect(out.text).toContain('XPLUSDT (Daily regime unknown) — Mid-term: Daily regime unknown (still unavailable after one retry); no direction given; Long-term: Listed for less than 1 year');
    expect(out.text).toContain('ONDOUSDT (Daily high volatility) — Mid-term: High daily volatility; frequent false breakouts on shorter horizons, excluded for now');
    expect(human(out.text)).not.toMatch(CJK);
  });

  it('按强弱排序(雷达/扫描名次取较好者,再比成交额);正文英文、成交额缩写、数据时点与周期含义', async () => {
    const d = deps([
      row('XPLUSDT', { regime: 'range', quote_vol_24h: 2e8, mid: ok(['mean_reversion', 'smc'], 'both'), radar: { mid: { rank: 5, fit: 0.8, reasons: [] } } }),
      row('ETHUSDT', { quote_vol_24h: 3.1e9, scan: { rank: 2, score: 0.8, reasons: [] } }),
      row('BTCUSDT', { quote_vol_24h: 7_832_158_483.28, scan: { rank: 1, score: 0.9, reasons: [] } }),
      row('DOGEUSDT', { quote_vol_24h: 9e8 }),
    ]);
    const out = await assetHorizonService.handle(job('x'), { horizons: ['mid'], market: 'perp', top_n: 8 }, d);
    expect(out.payload['picks']).toEqual({ mid: ['BTCUSDT', 'ETHUSDT', 'XPLUSDT', 'DOGEUSDT'] });
    expect(out.summary).toContain('Mid-term BTC, ETH, XPL, DOGE');
    expect(out.text).toContain('1. BTCUSDT · Daily uptrend · Long bias · Fits: Channel breakout, MA trend · Basis: market scan #1 (score 0.90); 24h volume 7.83B');
    expect(out.text).toContain('3. XPLUSDT · Daily range · Both directions · Fits: Mean reversion, SMC structure break · Basis: Radar swing tier #5');
    expect(out.text).toMatch(/Data as of: market scan 09-25 00:22 UTC · daily regime 09-24 · radar swing 09-22/);
    expect(out.text).toContain('Mid-term ≈ 1h/4h bars, held days to weeks');
    const h = human(out.text);
    expect(h).not.toMatch(/\bma_trend\b|\bmean_reversion\b|\bema_cross\b|\bregime_unavailable\b|\bstock_like\b|\{"service"/);
    expect(h).not.toMatch(CJK);
    expect(h).not.toMatch(/\brecommend|\bshould (buy|sell|enter)\b|worth entering/i);
    expect(BANNED_WORDS.test(out.text)).toBe(false);
  });

  it('中文审核原句端到端:正文纯英文(不转述中文原话、recommend 的中文提示与证据不进正文),payload 仍保留原始代码', async () => {
    const j = job('请根据全市场流动性和日线状态,推荐适合短线、中线和长线投资的币种及策略方向。');
    const r = { ...rec([
      row('BTCUSDT', { scan: { rank: 1, score: 0.9, reasons: [] }, horizons: { short: ok(), mid: ok(), long: ok() } }),
      row('PEPEUSDT', { quote_vol_24h: 4e7, regime: 'volatile', horizons: { short: no('liquidity', '短线要求永续成交额 ≥ 300.0M(小市值短线扣费后基本必负)'), mid: no('regime', '日线高波动,中短线假突破多,先不做'), long: ok(['breakout'], 'both') } }),
    ]), warnings: ['雷达三档还没跑过,短/中/长线只按全市场扫描与日线状态推荐', '雷达波段档的结果是 5 天前的,已过期,中线推荐参考价值下降', '某个没见过的中文提示'] };
    const d = deps([], { recommend: vi.fn(async () => r) });
    const out = await assetHorizonService.handle(j, assetHorizonService.validate(j), d);
    const h = human(out.text);
    expect(h).not.toMatch(CJK);
    expect(h).toContain('PEPEUSDT (Daily high volatility) — Short-term: 24h volume 40.0M is below the short-term minimum of 300.0M');
    expect(h).toContain('Notes: Radar tiers have not run yet; horizons rely on the market scan and daily regime only; Radar swing tier results are stale; lower reference value for that horizon; Data-source note (see warnings in the JSON)');
    expect(h.split('\n')[1]).toMatch(/^Asset × horizon picks \(USDT perpetual\): Short-term BTC · Mid-term BTC · Long-term BTC, PEPE$/);
    expect(out.payload['warnings']).toEqual(r.warnings);
    expect(BANNED_WORDS.test(out.text)).toBe(false);
  });

  it('usdAbbr:B/M/K', () => {
    expect(usdAbbr(7_832_158_483.28)).toBe('7.83B');
    expect(usdAbbr(911_188_823)).toBe('911.2M');
    expect(usdAbbr(530_000)).toBe('530K');
    expect(usdAbbr(null)).toBe('—');
  });
});
