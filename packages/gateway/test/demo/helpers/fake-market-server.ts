// A local stand-in for Binance USDⓈ-M futures' public endpoints, for runtime.test.ts /
// http.test.ts / info.test.ts. Serves the paths market.ts calls (symbol-scoped, single object) and
// the paths info.ts's collectInfo() calls (no symbol param → array of all symbols, plus the
// sentiment/ratio endpoints and a stand-in for alternative.me's fear & greed JSON). Not a mock of
// Binance's actual behavior — just enough shape for the code under test to run against, with no
// real network call.

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeMarketServer {
  url: string;
  /** URL to hand to TG_DEMO_FNG_URL — info.ts's fear & greed source is a separate host in prod. */
  fngUrl: string;
  close(): Promise<void>;
}

const WATCHLIST_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];

function fx(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

function tfToMsLocal(tf: string): number {
  const m = /^(\d+)([mhd])$/.exec(tf);
  if (!m) return 60_000;
  const n = Number(m[1]);
  const unit = m[2];
  return unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n * 86_400_000;
}

export function startFakeMarketServer(basePrice = 77000, wickRange = 5): Promise<FakeMarketServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const send = (body: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const now = Date.now();

        if (url.pathname === '/fapi/v1/klines') {
          const tf = url.searchParams.get('interval') ?? '15m';
          const limit = Number(url.searchParams.get('limit') ?? '60');
          const ms = tfToMsLocal(tf);
          const rows: unknown[] = [];
          for (let i = 0; i < limit; i++) {
            const idxFromEnd = limit - 1 - i; // 0 = most recent (the still-open candle)
            const openTime = Math.floor(now / ms) * ms - idxFromEnd * ms;
            const drift = i * 1.5; // gentle uptrend so EMA20/EMA50 ordering is unambiguous
            const wobble = ((i * 37) % 11) - 5; // deterministic, bounded wobble
            const open = basePrice + drift + wobble;
            const close = open + ((i % 3) - 1) * 3;
            const high = Math.max(open, close) + wickRange;
            const low = Math.min(open, close) - wickRange;
            const volume = 100 + ((i * 13) % 50);
            // Every candle but the very last is fully closed (close_time in the past); the last
            // one is still forming (close_time in the future) — this is what real klines look like.
            const closeTime = openTime + ms - 1;
            rows.push([openTime, fx(open), fx(high), fx(low), fx(close), fx(volume, 3), closeTime, '0', 0, '0', '0', '0']);
          }
          return send(rows);
        }

        if (url.pathname === '/fapi/v1/premiumIndex') {
          if (url.searchParams.has('symbol')) {
            return send({ markPrice: fx(basePrice + 50), indexPrice: fx(basePrice + 40), lastFundingRate: '0.00010000', nextFundingTime: now + 3_600_000, time: now });
          }
          // info.ts's collectInfo() calls this with no symbol → whole-market array.
          return send(
            WATCHLIST_SYMBOLS.map((symbol, i) => ({
              symbol,
              markPrice: fx(basePrice + 50 + i),
              indexPrice: fx(basePrice + 40 + i),
              lastFundingRate: (0.0001 * (i + 1)).toFixed(8),
              nextFundingTime: now + 3_600_000,
              time: now,
            })),
          );
        }

        if (url.pathname === '/fapi/v1/openInterest') {
          return send({ openInterest: '12345.678', time: now });
        }

        if (url.pathname === '/futures/data/openInterestHist') {
          return send([
            { sumOpenInterest: '12000.000', sumOpenInterestValue: '900000000', timestamp: now - 3_600_000 },
            { sumOpenInterest: '12345.678', sumOpenInterestValue: '950000000', timestamp: now },
          ]);
        }

        if (url.pathname === '/futures/data/globalLongShortAccountRatio') {
          return send([{ symbol: url.searchParams.get('symbol') ?? 'BTCUSDT', longShortRatio: '1.2345', longAccount: '0.5525', shortAccount: '0.4475', timestamp: now }]);
        }

        if (url.pathname === '/futures/data/takerlongshortRatio') {
          return send([{ buySellRatio: '1.0567', buyVol: '10567', sellVol: '10000', timestamp: now }]);
        }

        if (url.pathname === '/fapi/v1/ticker/24hr') {
          if (url.searchParams.has('symbol')) {
            return send({ lastPrice: fx(basePrice + 30), priceChangePercent: '1.23', quoteVolume: '987654321', highPrice: fx(basePrice + 500), lowPrice: fx(basePrice - 500) });
          }
          // info.ts's collectInfo() calls this with no symbol → whole-market array. Include the
          // watchlist plus a couple of high-volume non-watchlist symbols so top_movers has candidates.
          const rows = WATCHLIST_SYMBOLS.map((symbol, i) => ({ symbol, lastPrice: fx(basePrice + 30 + i), priceChangePercent: (1.23 + i).toFixed(2), quoteVolume: '987654321' }));
          rows.push({ symbol: 'DOGEUSDT', lastPrice: '0.15', priceChangePercent: '9.50', quoteVolume: '500000000' });
          rows.push({ symbol: 'XRPUSDT', lastPrice: '0.55', priceChangePercent: '-7.10', quoteVolume: '400000000' });
          return send(rows);
        }

        if (url.pathname === '/fng') {
          return send({ data: [{ value: '42', value_classification: 'Fear' }] });
        }

        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `no fake route for ${req.url}` }));
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}`;
      resolve({
        url,
        fngUrl: `${url}/fng`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
