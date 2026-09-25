// 推荐资产(§9.53 A):流动性门、周期档、regime → 方向与族、深度、币名规范。纯函数 + 注入依赖,零网络。
import { describe, expect, it } from 'vitest';
import { depthWithin, familiesFor, recommendAssets, SHORT_MIN_QUOTE_VOL_USD, type RecommendDeps } from '../../src/demo/recommend.js';
import type { DailyRegime, DailyRegimeKind } from '../../src/demo/types.js';
import type { UniverseAsset } from '../../src/demo/universe-okx.js';

const NOW = Date.UTC(2026, 8, 25);
const DAY = 86_400_000;
const asset = (symbol: string, perpVol: number, listedDaysAgo = 2000, o: Partial<UniverseAsset> = {}): UniverseAsset => ({
  symbol, base: symbol.replace('USDT', ''), markets: ['spot', 'perp'], spot_inst_id: `${symbol.replace('USDT', '')}-USDT`, perp_inst_id: `${symbol.replace('USDT', '')}-USDT-SWAP`,
  last: '1', change_24h: '0', quote_volume_24h: String(perpVol * 1.5), spot_quote_volume_24h: String(perpVol / 2), perp_quote_volume_24h: String(perpVol),
  funding_rate: null, next_funding_at: null, listed_at: NOW - listedDaysAgo * DAY, rank_by_volume: 1, quote_volume_90d: null, rank_by_volume_90d: null,
  excluded: false, excluded_reason: null, updated_at: NOW, ...o,
});
const regime = (k: DailyRegimeKind): DailyRegime => ({ regime: k, ema_stack: 'ema20>ema50>ema200', ret_20d_pct: 12.3, ret_5d_pct: 2, vol_pct_rank: 50, atr_pct: 3, dist_to_ema200_pct: 10, text: '', as_of: NOW - 1000 });

function deps(o: { regimes?: Record<string, DailyRegimeKind>; depth?: Record<string, number>; radar?: Partial<Record<'short' | 'swing' | 'weekly', { at: number; candidates: { symbol: string; rank: number; fit_score: number; reasons: string[] }[] }>> } = {}): RecommendDeps {
  const items = [asset('BTCUSDT', 5e9), asset('ETHUSDT', 2e9), asset('SOLUSDT', 1e9), asset('PEPEUSDT', 4e7), asset('NEWUSDT', 2e7, 100), asset('USDCUSDT', 1e9, 2000, { excluded: true, excluded_reason: 'stable' })];
  return {
    now: () => NOW,
    universe: () => ({ updated_at: NOW, items }),
    scan: () => ({ ready: true, screen_id: 's1', scanned: 300, errors: 0, at: NOW - 3600_000, note: null, candidates: [{ symbol: 'ETHUSDT', score: 0.81, reasons: ['量能放大'], strategy_id: 'x', rank: 1 }, { symbol: 'PEPEUSDT', score: 0.7, reasons: [], strategy_id: 'x', rank: 2 }] }),
    regime: async (s) => (o.regimes?.[s] ? regime(o.regimes[s]!) : null),
    depth: o.depth ? async (s) => o.depth![s] ?? null : undefined,
    id: () => 'rec_1',
    radar: o.radar ? (tier) => o.radar![tier] ?? null : undefined,
  };
}

describe('recommendAssets', () => {
  it('短线只给高流动性永续;小市值短线被流动性门挡住,中线仍可做', async () => {
    const r = await recommendAssets(deps({ regimes: { BTCUSDT: 'bull', PEPEUSDT: 'bull' } }), { symbols: ['btc', 'PEPE-USDT-SWAP'] });
    const [btc, pepe] = r.rows;
    expect(btc!.symbol).toBe('BTCUSDT');
    expect(btc!.horizons.short).toMatchObject({ eligible: true, direction: 'long' });
    expect(btc!.horizons.short.families).toEqual(['breakout', 'ema_cross']);
    expect(pepe!.symbol).toBe('PEPEUSDT');
    expect(pepe!.horizons.short).toMatchObject({ eligible: false, reason: 'liquidity' });
    expect(pepe!.horizons.mid.eligible).toBe(true);
    expect(pepe!.horizons.mid.evidence.some((e) => e.includes('全市场扫描第 2 名'))).toBe(true);
  });

  it('上市不满一年:长线档写 history,不进矩阵', async () => {
    const r = await recommendAssets(deps({ regimes: { NEWUSDT: 'range' } }), { symbols: ['NEWUSDT'] });
    expect(r.rows[0]!.horizons.long).toMatchObject({ eligible: false, reason: 'history' });
    expect(r.rows[0]!.horizons.mid).toMatchObject({ eligible: true, direction: 'both', families: ['mean_reversion', 'smc'] });
  });

  it('日线空头:永续给空头趋势族,现货写不适合', async () => {
    const perp = await recommendAssets(deps({ regimes: { ETHUSDT: 'bear' } }), { symbols: ['ETHUSDT'] });
    expect(perp.rows[0]!.horizons.mid).toMatchObject({ eligible: true, direction: 'short' });
    const spot = await recommendAssets(deps({ regimes: { ETHUSDT: 'bear' } }), { symbols: ['ETHUSDT'], market: 'spot' });
    expect(spot.rows[0]!.horizons.mid).toMatchObject({ eligible: false, reason: 'regime' });
    expect(spot.rows[0]!.horizons.short).toMatchObject({ eligible: false, reason: 'liquidity' });
  });

  it('深度不足时短线被挡,并写出深度证据', async () => {
    const r = await recommendAssets(deps({ regimes: { ETHUSDT: 'bull' }, depth: { ETHUSDT: 500_000 } }), { symbols: ['ETHUSDT'] });
    const s = r.rows[0]!.horizons.short;
    expect(s).toMatchObject({ eligible: false, reason: 'liquidity' });
    expect(s.evidence.join(' ')).toContain('±0.5%');
    expect(r.rows[0]!.depth_usd_05).toBe(500_000);
  });

  it('不给 symbols 取扫描前 top_n;排除资产与未知币如实标注', async () => {
    const r = await recommendAssets(deps(), { top_n: 1 });
    expect(r.rows.map((x) => x.symbol)).toEqual(['ETHUSDT']);
    const x = await recommendAssets(deps(), { symbols: ['USDC', 'NOPE'], horizons: ['mid'] });
    expect(x.rows[0]!.horizons.mid.reason).toBe('excluded');
    expect(x.rows[1]!.horizons.mid.reason).toBe('unknown_asset');
    expect(x.rows[0]!.horizons.short.reason).toBe('not_requested');
    expect(x.id).toBe('rec_1');
  });

  it('regime 未知:趋势 + 回归各给,并说明原因', () => {
    expect(familiesFor(null, 'mid', 'perp')).toMatchObject({ direction: 'both', families: ['breakout', 'ma_trend', 'mean_reversion'] });
    expect(familiesFor('volatile', 'short', 'perp').families).toEqual([]);
    expect(SHORT_MIN_QUOTE_VOL_USD).toBe(300_000_000);
  });
});

describe('雷达三档 = 短/中/长线信息来源', () => {
  it('不给币:雷达各档前 3 排在扫描前面;证据写雷达名次;source 带各档时间', async () => {
    const r = await recommendAssets(deps({
      regimes: { SOLUSDT: 'bull', ETHUSDT: 'bull' },
      radar: { weekly: { at: NOW - 5000, candidates: [{ symbol: 'SOLUSDT', rank: 1, fit_score: 0.88, reasons: ['周线趋势'] }] } },
    }), { top_n: 1 });
    expect(r.rows.map((x) => x.symbol)).toEqual(['SOLUSDT', 'ETHUSDT']);
    expect(r.rows[0]!.radar.long).toMatchObject({ rank: 1, fit: 0.88 });
    expect(r.rows[0]!.horizons.long.evidence[0]).toContain('雷达周线档第 1 名');
    expect(r.source.radar_at).toEqual({ long: NOW - 5000 });
  });
  it('雷达三档都没跑过:给出提示,不影响推荐', async () => {
    const r = await recommendAssets(deps({ radar: {} }), { symbols: ['ETH'] });
    expect(r.warnings.join()).toContain('雷达三档还没跑过');
  });
});

describe('depthWithin', () => {
  it('只累计近价 ±pct 内的挂单名义额', () => {
    const bids: [string, string][] = [['100', '10'], ['99.6', '5'], ['99', '100']];
    const asks: [string, string][] = [['100.2', '10'], ['100.5', '2'], ['101', '100']];
    // mid 100.1,±0.5% → [99.5995, 100.6005]
    expect(depthWithin(bids, asks, 0.005)).toBeCloseTo(100 * 10 + 99.6 * 5 + 100.2 * 10 + 100.5 * 2, 6);
    expect(depthWithin([], asks, 0.005)).toBeNull();
  });
});
