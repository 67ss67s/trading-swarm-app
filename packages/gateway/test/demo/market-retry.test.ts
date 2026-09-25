// market.ts getJson: one retry on network-level failures (socket reset / timeout), none on HTTP errors.
// Background: on the dev machine all "direct" fetches go through the Clash TUN + proxy node, which produces
// bursts of ECONNRESET / 8 s timeouts (2026-09-04 diagnosis); a single retry absorbs most of them.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

let server: http.Server;
let hits = 0;
let mode: 'reset_once' | 'http_500' | 'ok' = 'ok';
let fetchTicker24h: typeof import('../../src/demo/market.js').fetchTicker24h;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits++;
    if (mode === 'reset_once' && hits === 1) {
      req.socket.destroy();
      return;
    }
    if (mode === 'http_500') {
      res.writeHead(500);
      res.end('nope');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ priceChangePercent: '1.0', highPrice: '2', lowPrice: '1', quoteVolume: '3' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env['TG_DEMO_MARKET_BASE'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ({ fetchTicker24h } = await import('../../src/demo/market.js'));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  delete process.env['TG_DEMO_MARKET_BASE'];
});

describe('getJson retry policy', () => {
  it('retries once after a socket reset and succeeds', async () => {
    hits = 0;
    mode = 'reset_once';
    const t = await fetchTicker24h('BTCUSDT');
    expect(t.priceChangePercent).toBe('1.0');
    expect(hits).toBe(2);
  });

  it('does NOT retry HTTP errors (rate limits must not be hammered) and reports the status', async () => {
    hits = 0;
    mode = 'http_500';
    await expect(fetchTicker24h('BTCUSDT')).rejects.toThrow(/HTTP 500/);
    expect(hits).toBe(1);
  });

  it('a persistent network failure surfaces the cause code, not "fetch failed"', async () => {
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((r) => server.close(() => r()));
    await expect(fetchTicker24h('BTCUSDT')).rejects.toThrow(/网络错误 ECONNREFUSED/);
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  });
});
