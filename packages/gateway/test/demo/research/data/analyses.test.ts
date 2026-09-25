import { describe, it, expect } from 'vitest';
import { analyzeLeverage, analyzeRelativeStrength, compareBuyAndHold } from '../../../../src/demo/research/data/analyses.js';
import { okxMarketData } from '../../../../src/demo/research/data/okx.js';
import type { Instrument, SnapshotDraft } from '../../../../src/demo/research/data/index.js';
const H = 3600_000, T0 = Date.UTC(2026, 0, 1);
const inst = (market_type: 'spot' | 'perp', base = 'BTC'): Instrument => ({ canonical_id: `okx:${market_type}:${base}-USDT${market_type === 'perp' ? '-SWAP' : ''}`, asset_class: 'crypto', venue: 'okx', market_type, base, quote: 'USDT', timezone: 'UTC', ccxt_symbol: market_type === 'perp' ? `${base}/USDT:USDT` : `${base}/USDT`, display: '' });
const snap = (kind: SnapshotDraft['kind'], instrument: Instrument, rows: SnapshotDraft['rows'], frequency: string | null = '1h', coverage: SnapshotDraft['coverage'] = 'available'): SnapshotDraft => ({ kind, provider: 'okx', instrument, requested_window: { from_ms: T0, to_ms: T0 + 200 * H }, actual_window: null, as_of: T0, fetched_at: T0, frequency, units: {}, coverage, quality_flags: [], rows, method_version: 'test', checksum: 'x' });
const prices = (instrument: Instrument, f: (i: number) => number, n = 200) => snap('price', instrument, Array.from({ length: n }, (_, i) => ({ open_time: T0 + i * H, close_time: T0 + (i + 1) * H - 1, open: f(i).toFixed(2), high: '0', low: '0', close: f(i).toFixed(2), volume: '1' })));
describe('analyzeLeverage', () => {
  it('reports rising OI + high funding as a leverage observation, not a direction call', () => {
    const p = prices(inst('perp'), (i) => 100 + i * 0.5);
    const oi = snap('open_interest', inst('perp'), Array.from({ length: 200 }, (_, i) => ({ ts: T0 + i * H, oi_contracts: null, oi_value_usd: 1e9 + i * 5e6 })));
    const f = snap('funding', inst('perp'), Array.from({ length: 25 }, (_, i) => ({ ts: T0 + i * 8 * H, rate: 0.0003, interval_ms: 8 * H, kind: 'settled' })), '8h');
    const r = analyzeLeverage(p, f, oi, null);
    expect(r.price_change.status).toBe('ok'); expect(r.oi_change.value!).toBeGreaterThan(0); expect(r.funding_avg.value).toBeCloseTo(0.0003, 6);
    expect(r.observation).toContain('杠杆多头拥挤'); expect(r.observation).toContain('不是方向判断'); expect(r.liquidation_count.status).toBe('not_applicable');
    expect(r.aligned.length).toBe(200); expect(r.aligned.filter((a) => a.funding_rate !== null).length).toBe(25);
  });
  it('spot instrument yields not_applicable for funding / OI instead of zeros', () => {
    const p = prices(inst('spot'), (i) => 100 + i);
    const r = analyzeLeverage(p, snap('funding', inst('spot'), [], '8h', 'not_applicable'), snap('open_interest', inst('spot'), [], '1h', 'not_applicable'), null);
    expect(r.oi_change.status).toBe('not_applicable'); expect(r.funding_avg.status).toBe('not_applicable'); expect(r.oi_change.value).toBeNull();
  });
});
describe('analyzeRelativeStrength', () => {
  it('beta ~1 for an asset that tracks the benchmark; short samples are insufficient not zero', () => {
    const b = prices(inst('spot', 'BTC'), (i) => 100 * Math.exp(Math.sin(i / 7) * 0.05 + i * 0.001));
    const twin = prices(inst('spot', 'ETH'), (i) => 50 * Math.exp(Math.sin(i / 7) * 0.05 + i * 0.001));
    const short = prices(inst('spot', 'SOL'), (i) => 10 + i, 20);
    const r = analyzeRelativeStrength([twin, short], b);
    expect(r.rows[0]!.beta.value!).toBeCloseTo(1, 2); expect(r.rows[0]!.return.status).toBe('ok');
    expect(r.rows[1]!.beta.status).toBe('insufficient'); expect(r.rows[1]!.beta.value).toBeNull(); expect(r.warnings.length).toBeGreaterThan(0);
  });
});
describe('compareBuyAndHold', () => {
  it('charges the same round-trip cost and refuses to compare without a strategy return', () => {
    const bars = Array.from({ length: 10 }, (_, i) => ({ close_time: T0 + (i + 1) * H - 1, open: String(100 + i), close: String(101 + i) }));
    const r = compareBuyAndHold(bars, { from_ms: T0, to_ms: T0 + 10 * H }, '0.001', '5', -0.0425);
    expect(r.comparable).toBe(true); expect(r.buy_and_hold_return.value!).toBeCloseTo((110 / 100) * (1 - 0.0015) / (1 + 0.0015) - 1, 6);
    expect(compareBuyAndHold(bars, { from_ms: T0, to_ms: T0 + 10 * H }, '0.001', '5', null).comparable).toBe(false);
    expect(compareBuyAndHold([], { from_ms: T0, to_ms: T0 + H }, '0.001', '5', 0.1).buy_and_hold_return.status).toBe('insufficient');
  });
});
describe('okxMarketData (fake client, no network)', () => {
  const markets = { 'BTC/USDT': { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true }, 'BTC/USDT:USDT': { symbol: 'BTC/USDT:USDT', base: 'BTC', quote: 'USDT', swap: true, linear: true, active: true }, 'ETH/USDT': { symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', spot: true, active: true } };
  const client = { loadMarkets: async () => markets, fetchOHLCV: async (_s: string, _tf: string, since = 0) => Array.from({ length: 100 }, (_, i) => [since + i * H, 1, 2, 0.5, 1.5, 10]), fetchFundingRateHistory: async (_s: string, since = 0) => Array.from({ length: 30 }, (_, i) => ({ timestamp: since + i * 8 * H, fundingRate: 0.0001 })), fetchOpenInterestHistory: async (_s: string, _tf: string, since = 0) => Array.from({ length: 100 }, (_, i) => ({ timestamp: since + i * H, openInterestValue: 1e9 })), fetch: async (url: string) => ({ code: '0', data: [{ details: url.includes('after=') ? [] : Array.from({ length: 100 }, (_, i) => ({ ts: String(Date.now() - i * 60_000), side: 'sell', posSide: 'long', sz: '1', bkPx: '100' })) }] }) };
  const md = okxMarketData({ client: client as never });
  it('resolves bases from a Chinese question and gives spot before perp', async () => {
    const r = await md.resolve({ query: '比特币这轮上涨有没有伴随杠杆升温?' });
    expect(r.map((i) => i.canonical_id)).toEqual(['okx:spot:BTC-USDT', 'okx:perp:BTC-USDT-SWAP']);
    expect((await md.resolve({ symbols: ['ETHUSDT'], market: 'spot' }))[0]!.ccxt_symbol).toBe('ETH/USDT');
  });
  it('funding on spot is not_applicable; perp snapshots carry units, windows and checksums', async () => {
    const [spot, perp] = await md.resolve({ symbols: ['BTC'] });
    const w = { from_ms: T0, to_ms: T0 + 100 * H };
    expect((await md.funding(spot!, w)).coverage).toBe('not_applicable');
    const f = await md.funding(perp!, w); expect(f.units.rate).toBe('fraction_per_8h'); expect(f.rows.length).toBe(13); expect(f.checksum).toHaveLength(64);
    const liq = await md.liquidations(perp!, { from_ms: T0, to_ms: Date.now() }); expect(liq.coverage).toBe('partial'); expect(liq.quality_flags[0]).toMatch(/truncated_to_recent/);
    const same = await md.funding(perp!, w); expect(same.checksum).toBe(f.checksum);
  });
});
