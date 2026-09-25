// funnel / screener 按交易所分流(docs/design/watch-screener-review-2026-09-24.md 二-1):
// TG_EXCHANGE=okx 时存在性、24h 成交额、资金费、资金费历史全走 OKX,一个请求都不发给 fapi.binance.com。
// 全程假 fetch,不碰网络。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listTradableSymbols, runFunnel, venueLabel } from '../../src/demo/funnel.js';
import { fetchNextFundingMap, fetchTickerMap, resolveUniverse } from '../../src/demo/screener.js';
import { resetOkxMarketCaches } from '../../src/demo/market-okx.js';
import { setInstruments } from '../../src/demo/okx/instruments.js';
import { resetUniverseSnapshot } from '../../src/demo/universe-okx.js';
import { DEFAULT_WORKFLOW } from '../../src/demo/workflow.js';
import type { Workflow } from '../../src/demo/types.js';

const OKX = 'http://okx.fake';
const swapInst = (base: string) => ({ instId: `${base}-USDT-SWAP`, instType: 'SWAP', instFamily: `${base}-USDT`, ctType: 'linear', settleCcy: 'USDT', ctVal: '0.01', ctValCcy: base, lotSz: '1', minSz: '1', tickSz: '0.1', state: 'live', listTime: '1600000000000' });

let urls: string[] = [];
const saved: Record<string, string | undefined> = {};
const original = globalThis.fetch;
let cacheDir = '';

beforeAll(() => {
  for (const k of ['TG_EXCHANGE', 'TG_OKX_REST_BASE', 'TG_DEMO_KLINE_CACHE_DIR', 'TG_DEMO_MARKET_BASE']) saved[k] = process.env[k];
  cacheDir = mkdtempSync(join(tmpdir(), 'funnel-okx-'));
  process.env['TG_EXCHANGE'] = 'okx';
  process.env['TG_OKX_REST_BASE'] = OKX;
  process.env['TG_DEMO_KLINE_CACHE_DIR'] = cacheDir;
  delete process.env['TG_DEMO_MARKET_BASE'];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const u = String(input);
    urls.push(u);
    const ok = (data: unknown) => new Response(JSON.stringify({ code: '0', msg: '', data }), { status: 200 });
    if (u.includes('/api/v5/public/instruments?instType=SWAP')) return ok([swapInst('BTC'), swapInst('ETH'), { ...swapInst('OLD'), state: 'suspend' }]);
    if (u.includes('/api/v5/market/tickers?instType=SWAP')) {
      return ok([
        { instId: 'BTC-USDT-SWAP', last: '100', open24h: '80', volCcy24h: '10' },
        { instId: 'ETH-USDT-SWAP', last: '10', open24h: '10', volCcy24h: '500' },
        { instId: 'BTC-USD-SWAP', last: '100', open24h: '100', volCcy24h: '999999' },
      ]);
    }
    if (u.includes('/api/v5/public/funding-rate?instId=ANY')) return ok([{ instId: 'BTC-USDT-SWAP', fundingRate: '0.0001', fundingTime: '1790193600000' }]);
    if (u.includes('/api/v5/public/funding-rate-history')) return ok([]);
    if (u.includes('/api/v5/market/')) return ok([]); // candles / history-candles:空
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = original;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(cacheDir, { recursive: true, force: true });
});

beforeEach(() => {
  urls = [];
  resetOkxMarketCaches();
  setInstruments([], 0, 'perp');
  resetUniverseSnapshot();
});

const noBinance = () => expect(urls.filter((u) => u.includes('binance'))).toEqual([]);

describe('funnel 按交易所分流(okx)', () => {
  it('listTradableSymbols 用 OKX 在售永续判存在性', async () => {
    const r = await listTradableSymbols(['BTCUSDT', 'OLDUSDT', 'NOPEUSDT']);
    expect(r.existing).toEqual([{ symbol: 'BTCUSDT', contract_type: 'SWAP', onboard: 0 }]);
    expect(r.missing).toEqual(['OLDUSDT', 'NOPEUSDT']);
    expect(venueLabel()).toBe('OKX');
    expect(urls.every((u) => u.startsWith(OKX))).toBe(true);
    noBinance();
  });

  it('runFunnel 全程不请求 fapi.binance.com(K 线、资金费历史都走 OKX)', async () => {
    const report = await runFunnel(['BTCUSDT', 'NOPEUSDT'], { days: 3 });
    expect(report.missing).toEqual(['NOPEUSDT']);
    expect(report.listed.map((l) => l.symbol)).toEqual(['BTCUSDT']);
    expect(urls.some((u) => u.includes('/api/v5/market/candles'))).toBe(true);
    expect(urls.some((u) => u.includes('/api/v5/public/funding-rate-history'))).toBe(true);
    noBinance();
  });

  it('fetchTickerMap / fetchNextFundingMap 走 OKX,只收 USDT 本位永续', async () => {
    const t = await fetchTickerMap();
    expect([...t.keys()].sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(t.get('BTCUSDT')).toEqual({ symbol: 'BTCUSDT', quoteVolume: 1000, priceChangePercent: 25 });
    expect(t.get('ETHUSDT')!.quoteVolume).toBe(5000);
    const f = await fetchNextFundingMap();
    expect(f.get('BTCUSDT')).toBe(1790193600000);
    noBinance();
  });

  it('resolveUniverse 文案按交易所:「OKX 上没有」', async () => {
    const w = { ...DEFAULT_WORKFLOW, watchlist: ['BTCUSDT', 'NOPEUSDT'], screener_whitelist: [], screener_universe: 'watchlist+whitelist' } as Workflow;
    const r = await resolveUniverse(w, null);
    expect(r.symbols).toEqual(['BTCUSDT']);
    expect(r.note).toBe('OKX 上没有(已跳过):NOPEUSDT');
    noBinance();
  });

  it('okx_all 在资产全集没刷过时退回永续 24h 成交额排序', async () => {
    const w = { ...DEFAULT_WORKFLOW, screener_universe: 'okx_all', screener_max_symbols: 5 } as Workflow;
    const r = await resolveUniverse(w, await fetchTickerMap());
    expect(r.universe).toBe('okx_all');
    expect(r.symbols).toEqual(['ETHUSDT', 'BTCUSDT']);
    expect(r.note).toMatch(/还没刷新过/);
  });
});
