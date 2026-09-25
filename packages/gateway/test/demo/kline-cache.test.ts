// The replay chart's history depth rests on two things: paging Binance's 1500-bar klines endpoint
// backwards until `from` is reached, and a disk cache that remembers which SPANS were already asked
// about (not just which bars came back) so a range with a hole in it is not re-paged forever.
//
// Everything here runs against a local fake fapi that counts requests — no network, no paid call.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kline } from '../../src/demo/types.js';

const TF = '15m';
const STEP = 15 * 60_000;
/** The fake exchange's whole history: 6000 bars ending an hour ago (so the last bar is closed). */
const BARS = 6000;
const LAST_CLOSE = Math.floor((Date.now() - 3_600_000) / STEP) * STEP - 1;
const FIRST_OPEN = LAST_CLOSE + 1 - BARS * STEP;

/** A gap the exchange itself has: bars 2000..2019 simply do not exist (downtime). */
const HOLE_FROM = FIRST_OPEN + 2000 * STEP;
const HOLE_TO = FIRST_OPEN + 2020 * STEP;

function build(): Kline[] {
  const out: Kline[] = [];
  for (let i = 0; i < BARS; i++) {
    const openTime = FIRST_OPEN + i * STEP;
    if (openTime >= HOLE_FROM && openTime < HOLE_TO) continue;
    const open = 70_000 + i;
    out.push({
      open_time: openTime,
      open: open.toFixed(1),
      high: (open + 5).toFixed(1),
      low: (open - 5).toFixed(1),
      close: (open + 1).toFixed(1),
      volume: '10',
      close_time: openTime + STEP - 1,
    });
  }
  return out;
}

const SERIES = build();

let market: http.Server;
let cacheDir = '';
/** endTime of every /fapi/v1/klines call, in order — the paging assertions read this. */
let calls: number[] = [];

beforeAll(async () => {
  market = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/fapi/v1/klines') {
      const limit = Math.min(1500, Number(url.searchParams.get('limit') ?? '500'));
      const endRaw = Number(url.searchParams.get('endTime') ?? '');
      const end = Number.isFinite(endRaw) && endRaw > 0 ? endRaw : Number.POSITIVE_INFINITY;
      calls.push(end);
      const page = SERIES.filter((k) => k.open_time <= end)
        .slice(-limit)
        .map((k) => [k.open_time, k.open, k.high, k.low, k.close, k.volume, k.close_time, '0', 0, '0', '0', '0']);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(page));
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise<void>((r) => market.listen(0, '127.0.0.1', r));
  cacheDir = mkdtempSync(join(tmpdir(), 'tg-kline-cache-'));
  process.env['TG_DEMO_MARKET_BASE'] = `http://127.0.0.1:${(market.address() as AddressInfo).port}`;
  process.env['TG_DEMO_KLINE_CACHE_DIR'] = cacheDir;
});

afterAll(async () => {
  await new Promise<void>((r) => market.close(() => r()));
  rmSync(cacheDir, { recursive: true, force: true });
  delete process.env['TG_DEMO_MARKET_BASE'];
  delete process.env['TG_DEMO_KLINE_CACHE_DIR'];
});

// backtest.ts reads both env vars as module-level consts → import AFTER they are set.
type BacktestModule = typeof import('../../src/demo/backtest.js');
let bt: BacktestModule;
beforeAll(async () => {
  bt = await import('../../src/demo/backtest.js');
});

// ---------------------------------------------------------------- pure span algebra

describe('span algebra', () => {
  it('mergeSpans coalesces overlapping and touching spans', () => {
    expect(bt.mergeSpans([{ from: 10, to: 20 }, { from: 15, to: 25 }])).toEqual([{ from: 10, to: 25 }]);
    expect(bt.mergeSpans([{ from: 10, to: 20 }, { from: 21, to: 30 }])).toEqual([{ from: 10, to: 30 }]);
    expect(bt.mergeSpans([{ from: 40, to: 50 }, { from: 10, to: 20 }])).toEqual([{ from: 10, to: 20 }, { from: 40, to: 50 }]);
    expect(bt.mergeSpans([{ from: 10, to: 20 }, { from: 30, to: 40 }])).toEqual([{ from: 10, to: 20 }, { from: 30, to: 40 }]);
    expect(bt.mergeSpans([{ from: 20, to: 10 }])).toEqual([]);
  });

  it('missingSpans subtracts coverage and drops sub-bar fragments', () => {
    const step = 100;
    expect(bt.missingSpans([], 0, 1000, step)).toEqual([{ from: 0, to: 1000 }]);
    expect(bt.missingSpans([{ from: 0, to: 1000 }], 0, 1000, step)).toEqual([]);
    // Extending backwards only asks for the new prefix.
    expect(bt.missingSpans([{ from: 500, to: 1000 }], 0, 1000, step)).toEqual([{ from: 0, to: 499 }]);
    // Extending forwards only asks for the new tail.
    expect(bt.missingSpans([{ from: 0, to: 500 }], 0, 1000, step)).toEqual([{ from: 501, to: 1000 }]);
    // A hole in the middle becomes one request, not two full-range ones.
    expect(bt.missingSpans([{ from: 0, to: 300 }, { from: 600, to: 1000 }], 0, 1000, step)).toEqual([{ from: 301, to: 599 }]);
    // Less than one bar wide → not worth a request.
    expect(bt.missingSpans([{ from: 0, to: 950 }], 0, 1000, step)).toEqual([]);
  });

  it('spansFromBars reads coverage out of a legacy cache file (no ranges field)', () => {
    const bars = SERIES.slice(0, 40);
    expect(bt.spansFromBars(bars, STEP)).toEqual([{ from: bars[0]!.open_time, to: bars[39]!.close_time }]);
    // A discontinuity splits the coverage in two.
    const holed = [...SERIES.slice(0, 10), ...SERIES.slice(20, 30)];
    const spans = bt.spansFromBars(holed, STEP);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.to).toBe(SERIES[9]!.close_time);
    expect(spans[1]!.from).toBe(SERIES[20]!.open_time);
  });

  it('mergeBars dedupes on open_time and keeps ascending order', () => {
    const merged = bt.mergeBars(SERIES.slice(10, 20), SERIES.slice(15, 25));
    expect(merged).toHaveLength(15);
    for (let i = 1; i < merged.length; i++) expect(merged[i]!.open_time).toBeGreaterThan(merged[i - 1]!.open_time);
  });
});

// ---------------------------------------------------------------- paging + cache

describe('fetchKlineSpan / loadKlines', () => {
  it('pages backwards in 1500-bar chunks until `from` is reached', async () => {
    calls = [];
    const from = LAST_CLOSE - 3500 * STEP;
    const got = await bt.fetchKlineSpan('PAGEUSDT', TF, from, LAST_CLOSE);
    expect(got.reached_start).toBe(true);
    // 3500 bars at 1500/page = 3 requests; each cursor strictly older than the last.
    expect(calls).toHaveLength(3);
    for (let i = 1; i < calls.length; i++) expect(calls[i]!).toBeLessThan(calls[i - 1]!);
    expect(got.bars.length).toBeGreaterThanOrEqual(3500);
    for (let i = 1; i < got.bars.length; i++) expect(got.bars[i]!.open_time).toBeGreaterThan(got.bars[i - 1]!.open_time);
  });

  it('stops at the start of history instead of paging into the void', async () => {
    calls = [];
    const got = await bt.fetchKlineSpan('EDGEUSDT', TF, FIRST_OPEN - 500 * STEP, LAST_CLOSE);
    expect(got.reached_start).toBe(true);
    expect(got.bars[0]!.open_time).toBe(FIRST_OPEN);
    // 6000 bars → 4 pages, then one page that cannot move the cursor any further back.
    expect(calls.length).toBeLessThanOrEqual(6);
  });

  it('serves a repeat request entirely from disk', async () => {
    const from = LAST_CLOSE - 400 * STEP;
    calls = [];
    const first = await bt.loadKlines('CACHEUSDT', TF, from, LAST_CLOSE);
    expect(calls.length).toBeGreaterThan(0);
    expect(first.length).toBe(401);
    calls = [];
    const second = await bt.loadKlines('CACHEUSDT', TF, from, LAST_CLOSE);
    expect(calls).toHaveLength(0);
    expect(second.map((k) => k.open_time)).toEqual(first.map((k) => k.open_time));
  });

  it('extending backwards fetches only the new prefix', async () => {
    const near = LAST_CLOSE - 200 * STEP;
    await bt.loadKlines('EXTUSDT', TF, near, LAST_CLOSE);
    calls = [];
    const deep = LAST_CLOSE - 2000 * STEP;
    const wide = await bt.loadKlines('EXTUSDT', TF, deep, LAST_CLOSE);
    expect(calls.length).toBeGreaterThan(0);
    // Every page asked for is older than the part we already had — the cached tail is never refetched.
    for (const end of calls) expect(end).toBeLessThan(near);
    expect(wide.length).toBe(2001);
    calls = [];
    await bt.loadKlines('EXTUSDT', TF, deep, LAST_CLOSE);
    expect(calls).toHaveLength(0);
  });

  it('a hole the exchange itself has stays covered, so it is asked about only once', async () => {
    const from = HOLE_FROM - 50 * STEP;
    const to = HOLE_TO + 50 * STEP;
    calls = [];
    const first = await bt.loadKlines('HOLEUSDT', TF, from, to);
    expect(calls.length).toBeGreaterThan(0);
    // The hole really is missing from the data — this is not a caching artefact.
    expect(first.some((k) => k.open_time >= HOLE_FROM && k.open_time < HOLE_TO)).toBe(false);
    calls = [];
    const second = await bt.loadKlines('HOLEUSDT', TF, from, to);
    expect(calls).toHaveLength(0);
    expect(second).toHaveLength(first.length);
  });
});
