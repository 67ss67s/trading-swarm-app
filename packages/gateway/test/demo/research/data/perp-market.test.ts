import { describe, it, expect } from 'vitest';
import { deflateRawSync, crc32 } from 'node:zlib';
import { readZipEntries, readZipText } from '../../../../src/demo/research/data/zip.js';
import { MarketCache, perpContext, syncCandles, loadFunding, loadTiers, loadPerpMarket, okxBar, symbolToInstId, binanceSymbolOf } from '../../../../src/demo/research/data/perp-market.js';

// ---------- 测试辅助:手工拼 zip ----------
function makeZip(files: { name: string; data: string | Buffer; store?: boolean }[]): Buffer {
  const locals: Buffer[] = [], cens: Buffer[] = []; let off = 0;
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data), comp = f.store ? data : deflateRawSync(data), name = Buffer.from(f.name), crc = crc32(data) >>> 0, method = f.store ? 0 : 8;
    const loc = Buffer.alloc(30); loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(method, 8); loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(data.length, 22); loc.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(method, 10); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(off, 42);
    locals.push(loc, name, comp); cens.push(cen, name); off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(cens), eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
// ---------- 假交易所 ----------
const H = 3600_000, DAY = 86_400_000, F8 = 8 * H, INST = 'BTC-USDT-SWAP';
const NOW = Date.UTC(2026, 8, 23, 10, 30); // 2026-09-23 10:30Z
const mIdx = (ts: number) => { const d = new Date(ts); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
const uStart = (m: number) => Date.UTC(Math.floor(m / 12), m % 12, 1), hkStart = (m: number) => uStart(m) - 8 * H;
const mk = (m: number) => `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`;
const M = (y: number, mo: number) => y * 12 + mo - 1;
const okxRate = (ts: number) => Number((0.0001 + 0.00005 * Math.sin(ts / 3e7)).toFixed(10));
const bnRate = (ts: number) => Number((okxRate(ts) + 0.00001).toFixed(10));
const ticks = (a: number, b: number) => { const out: number[] = []; for (let t = Math.ceil(a / F8) * F8; t < b; t += F8) out.push(t); return out; };
interface FakeOpts { lag?: boolean; listing?: number; markFrom?: number; okxMissing?: Set<number>; okxEmpty?: Set<number>; bnMissing?: Set<number>; restFrom?: number; now?: () => number }
function fakeExchange(o: FakeOpts = {}) {
  const calls: string[] = [], listing = o.listing ?? Date.UTC(2019, 11, 1), now = o.now ?? (() => NOW);
  const json = (data: unknown, code = '0') => new Response(JSON.stringify({ code, msg: '', data }), { status: 200, headers: { 'content-type': 'application/json' } });
  const candles = (u: URL, mark: boolean) => {
    const bar = u.searchParams.get('bar')!, step = ({ '1Dutc': DAY, '1H': H, '4H': 4 * H, '6Hutc': 6 * H } as Record<string, number>)[bar]; if (!step) return json([], '51000');
    const after = Number(u.searchParams.get('after') ?? now() + 1), cur = Math.floor(now() / step) * step, from = mark ? (o.markFrom ?? listing) : listing, rows: string[][] = [];
    for (let t = Math.min(cur, Math.ceil(after / step) * step - step); t >= from && rows.length < 100; t -= step) { if (t >= after) continue; const p = String(10000 + t / DAY), c = t === cur || (o.lag && t === cur - step) ? '0' : '1'; rows.push(mark ? [String(t), p, p, p, p, c] : [String(t), p, p, p, p, '100', '1', '10000', c]); }
    return json(rows);
  };
  const okxCsv = (m: number) => ['instrument_name,funding_rate,funding_time', ...ticks(hkStart(m), hkStart(m + 1)).flatMap((t) => [`${INST},${okxRate(t)},${t}`, `ETH-USDT-SWAP,0.5,${t}`])].join('\n');
  const bnCsv = (m: number) => ['calc_time,funding_interval_hours,last_funding_rate', ...ticks(uStart(m), uStart(m + 1)).map((t) => `${t},8,${bnRate(t)}`)].join('\n');
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input), u = new URL(url); calls.push(url);
    if (u.pathname === '/api/v5/market/history-candles') return candles(u, false);
    if (u.pathname === '/api/v5/market/history-mark-price-candles') return candles(u, true);
    if (u.pathname === '/api/v5/public/market-data-history') {
      const begin = Number(u.searchParams.get('begin')), end = Number(u.searchParams.get('end'));
      if (end - begin > 10 * 31 * DAY) return json([], '50077');
      const groupDetails = []; for (let m = mIdx(begin + 8 * H); m <= mIdx(end); m++) { if (m < M(2022, 1) || hkStart(m + 1) > now() || o.okxMissing?.has(m)) continue; groupDetails.push({ dateTs: String(hkStart(m)), filename: `${INST}-fundingrates-${mk(m)}.zip`, url: `https://static.okx.com/cdn/okex/traderecords/swaprates/monthly/${mk(m).replace('-', '')}/${INST}-fundingrates-${mk(m)}.zip?v=999` }); }
      return json([{ dateAggrType: 'monthly', details: [{ instFamily: 'BTC-USDT', groupDetails }] }]);
    }
    if (u.hostname === 'static.okx.com') { const [y, mo] = /fundingrates-(\d{4})-(\d{2})/.exec(u.pathname)!.slice(1).map(Number); const m = M(y!, mo!); return new Response(makeZip([{ name: `${INST}-fundingrates-${mk(m)}.csv`, data: o.okxEmpty?.has(m) ? 'instrument_name,funding_rate,funding_time\n' : okxCsv(m) }])); }
    if (u.hostname === 'data.binance.vision') { const [y, mo] = /fundingRate-(\d{4})-(\d{2})\.zip$/.exec(u.pathname)!.slice(1).map(Number); const m = M(y!, mo!); if (o.bnMissing?.has(m) || uStart(m + 1) > now()) return new Response('nf', { status: 404 }); return new Response(makeZip([{ name: `BTCUSDT-fundingRate-${mk(m)}.csv`, data: bnCsv(m) }])); }
    if (u.pathname === '/api/v5/public/funding-rate-history') {
      const after = Number(u.searchParams.get('after') ?? now() + 1), floor = o.restFrom ?? now() - 90 * DAY, rows = [];
      for (let t = Math.floor(Math.min(after - 1, now()) / F8) * F8; t >= floor && rows.length < 100; t -= F8) rows.push({ instId: INST, fundingTime: String(t), fundingRate: String(okxRate(t)), realizedRate: String(okxRate(t)) });
      return json(rows);
    }
    if (u.pathname === '/api/v5/public/instruments') return json([{ instId: INST, ctVal: '0.01', ctMult: '1', ctType: 'linear', listTime: '1573557408000' }]);
    if (u.pathname === '/api/v5/public/position-tiers') return json([{ tier: '2', minSz: '1000.01', maxSz: '5000', mmr: '0.005', imr: '0.015', maxLever: '66.66' }, { tier: '1', minSz: '0', maxSz: '1000', mmr: '0.004', imr: '0.01', maxLever: '100' }, { tier: '3', minSz: '5000.01', maxSz: '20000', mmr: '0.0075', imr: '0.02', maxLever: '50' }]);
    return new Response('?', { status: 404 });
  }) as typeof fetch;
  const count = (frag: string) => calls.filter((c) => c.includes(frag)).length;
  return { fetchFn, calls, count };
}
const noSleep = async () => {};
const setup = (o: FakeOpts = {}, now = () => NOW) => { const ex = fakeExchange({ now, ...o }), cache = new MarketCache(':memory:'); return { ex, cache, ctx: perpContext(cache, { fetchFn: ex.fetchFn, sleep: noSleep, now }) }; };

describe('zip', () => {
  it('解出 deflate 与 stored 条目并校验 CRC', () => {
    const z = makeZip([{ name: 'a.csv', data: 'x,y\n1,2\n'.repeat(50) }, { name: 'dir/b.txt', data: 'hello', store: true }]);
    const e = readZipEntries(z); expect(e.map((x) => [x.name, x.method])).toEqual([['a.csv', 8], ['dir/b.txt', 0]]);
    expect(e[1]!.data.toString()).toBe('hello'); expect(readZipText(z).text.startsWith('x,y\n1,2')).toBe(true);
    const bad = Buffer.from(z); bad[bad.indexOf('hello')] = 0x48; expect(() => readZipEntries(bad)).toThrow(/crc_mismatch/);
    expect(() => readZipEntries(Buffer.from('not a zip at all, definitely not'))).toThrow(/no_eocd/);
  });
});
describe('符号与周期', () => {
  it('symbolToInstId 只认 USDT 线性永续', () => {
    for (const s of ['BTCUSDT', 'BTC-USDT', 'BTC/USDT:USDT', 'btc-usdt-swap', 'BTC_USDT']) expect(symbolToInstId(s)).toBe('BTC-USDT-SWAP');
    expect(() => symbolToInstId('BTC-USD-SWAP')).toThrow(/UNSUPPORTED/); expect(() => symbolToInstId('BTC/USDC:USDC')).toThrow(/UNSUPPORTED/);
    expect(binanceSymbolOf('ETH-USDT-SWAP')).toBe('ETHUSDT');
  });
  it('6h/12h/1d 用 UTC 对齐 bar 码', () => {
    expect(['1m', '15m', '1h', '4h', '6h', '12h', '1d'].map(okxBar)).toEqual(['1m', '15m', '1H', '4H', '6Hutc', '12Hutc', '1Dutc']);
    expect(() => okxBar('8h')).toThrow(/timeframe_unsupported/);
  });
});
describe('K 线', () => {
  it('分页拉取、UTC bar 码、未收盘过滤、增量只补缺口', async () => {
    const { ex, cache, ctx } = setup();
    const w = { from_ms: Date.UTC(2025, 0, 1), to_ms: Date.UTC(2025, 9, 1) - 1 }; // 273 天 → 3 页
    await syncCandles(ctx, INST, 'trade', '1d', w);
    expect(ex.calls.every((c) => c.includes('bar=1Dutc'))).toBe(true); const first = ex.count('history-candles'); expect(first).toBe(3);
    expect(cache.candles(INST, 'trade', '1d', w.from_ms, w.to_ms)).toHaveLength(273);
    await syncCandles(ctx, INST, 'trade', '1d', w); expect(ex.count('history-candles')).toBe(first); // 已缓存区段不再请求
    // 延伸到当前:只补尾部;当天未收盘那根不入库
    await syncCandles(ctx, INST, 'trade', '1d', { from_ms: w.from_ms, to_ms: NOW + DAY });
    const tail = ex.calls.slice(first).filter((c) => c.includes('history-candles')); expect(tail.length).toBe(4);
    expect(Number(new URL(tail[0]!).searchParams.get('after'))).toBe(Date.UTC(2026, 8, 22) + 1);
    const today = Date.UTC(2026, 8, 23); expect(cache.candles(INST, 'trade', '1d', today - DAY, today + DAY).map((r) => r.open_time)).toEqual([today - DAY]);
    // 再往前延伸到上市之前:补头部,接口返回空 = 上市起点,之后不再重试
    const before = ex.count('history-candles');
    await syncCandles(ctx, INST, 'trade', '1d', { from_ms: Date.UTC(2019, 0, 1), to_ms: w.to_ms });
    const head = ex.count('history-candles') - before; expect(head).toBeGreaterThan(0);
    expect(cache.log(`candles_floor:${INST}:trade:1d`)?.status).toBe('floor');
    expect(cache.candles(INST, 'trade', '1d', 0, Date.UTC(2019, 11, 2))[0]!.open_time).toBe(Date.UTC(2019, 11, 1));
    await syncCandles(ctx, INST, 'trade', '1d', { from_ms: Date.UTC(2018, 0, 1), to_ms: w.to_ms }); expect(ex.count('history-candles') - before).toBe(head);
  });
  it('标记价走 mark 接口,volume 记 0;最新一根还没 confirm 的不入库,下次再补', async () => {
    let now = NOW; const { ex, cache, ctx } = setup({ lag: true }, () => now), cur = Math.floor(NOW / H) * H, inWin = () => cache.candles(INST, 'mark', '1h', cur - 4 * H, cur + 2 * H);
    await syncCandles(ctx, INST, 'mark', '1h', { from_ms: NOW - 5 * H, to_ms: NOW });
    expect(ex.count('history-mark-price-candles')).toBe(1);
    expect(inWin().map((r) => r.open_time)).toEqual([4, 3, 2].map((k) => cur - k * H)); expect(inWin().every((r) => r.v === 0)).toBe(true);
    now += H; await syncCandles(ctx, INST, 'mark', '1h', { from_ms: NOW - 5 * H, to_ms: now }); expect(ex.count('history-mark-price-candles')).toBe(2);
    expect(inWin().map((r) => r.open_time)).toEqual([4, 3, 2, 1].map((k) => cur - k * H));
  });
});
describe('资金费', () => {
  it('2022-01 前用币安代理,同 ts 优先 OKX,deviation 按同 ts 配对', async () => {
    const { ex, cache, ctx } = setup();
    const w = { from_ms: Date.UTC(2021, 9, 1), to_ms: Date.UTC(2022, 2, 1) };
    const { series, provenance: p } = await loadFunding(ctx, INST, w);
    const okxStart = Date.UTC(2021, 11, 31, 16);
    expect(series.points.filter((x) => x.ts < okxStart).every((x) => x.source === 'binance_proxy')).toBe(true);
    expect(series.points.filter((x) => x.ts >= okxStart).every((x) => x.source === 'okx')).toBe(true);
    const dup = series.points.filter((x) => x.ts === okxStart); expect(dup).toHaveLength(1); expect(dup[0]!.rate).toBe(okxRate(okxStart));
    expect(series.points).toHaveLength(ticks(w.from_ms, w.to_ms + 1).length); // 每 8h 一期,无缺无重
    expect(p.coverage).toBe('complete'); expect(series.from_ms).toBe(w.from_ms); expect(series.to_ms).toBe(w.to_ms);
    expect(p.proxy_until_ms).toBe(Date.UTC(2021, 11, 31, 8)); expect(p.note).toContain('2022-01 前资金费为币安 BTCUSDT 代理');
    expect(p.okx_archive.final).toEqual(['2022-01', '2022-02', '2022-03']);
    // 币安只拉 2021-10..12 + 偏差用的最近 3 个完整月;2022 年的月份 OKX 已覆盖不拉
    const bn = ex.calls.filter((c) => c.includes('binance.vision')).map((c) => /fundingRate-(\d{4}-\d{2})/.exec(c)![1]);
    expect(bn).toEqual(['2021-10', '2021-11', '2021-12', '2026-06', '2026-07', '2026-08']);
    expect(p.deviation!.months).toEqual(['2026-06', '2026-07', '2026-08']); expect(p.deviation!.n).toBeGreaterThan(250);
    expect(p.deviation!.mean_diff).toBeCloseTo(-0.00001, 9); expect(p.deviation!.corr!).toBeGreaterThan(0.999);
    expect(p.deviation!.cum_diff).toBeCloseTo(-0.00001 * p.deviation!.n, 7);
    expect(ex.count('funding-rate-history')).toBe(0); // 窗口全在归档期,不打 REST
    // 第二次:全部命中缓存
    const n = ex.calls.length; await loadFunding(ctx, INST, w); expect(ex.calls.length).toBe(n);
    void cache;
  });
  it('归档列表按 ≤10 个月分段;缺月记 missing 并由币安补洞,7 天后才重试;空月份也记 final', async () => {
    let now = NOW; const { ex, cache, ctx } = setup({ okxMissing: new Set([M(2023, 5)]), okxEmpty: new Set([M(2023, 8)]) }, () => now);
    const w = { from_ms: Date.UTC(2023, 0, 1), to_ms: Date.UTC(2024, 5, 30) };
    const { series, provenance: p } = await loadFunding(ctx, INST, w);
    const lists = ex.calls.filter((c) => c.includes('market-data-history')).map((c) => new URL(c).searchParams);
    expect(lists.length).toBe(3); for (const s of lists) expect(Number(s.get('end')) - Number(s.get('begin'))).toBeLessThanOrEqual(10 * 30 * DAY);
    expect(cache.log(`okx_funding_archive:${INST}:2023-05`)?.status).toBe('missing');
    expect(cache.log(`okx_funding_archive:${INST}:2023-08`)).toMatchObject({ status: 'final', note: 'rows=0' });
    expect(p.okx_archive.missing).toEqual(['2023-05']);
    const proxy = series.points.filter((x) => x.source === 'binance_proxy').map((x) => mk(mIdx(x.ts)));
    expect(new Set(proxy)).toEqual(new Set(['2023-04', '2023-05', '2023-07', '2023-08'])); // 洞两端跨 UTC/UTC+8 月界的那一期也由代理补
    expect(p.note).toContain('OKX 缺失由币安代理补'); expect(p.coverage).toBe('complete');
    const listCalls = () => ex.count('market-data-history');
    const c0 = listCalls(); now = NOW + 3 * DAY; await loadFunding(ctx, INST, w); expect(listCalls()).toBe(c0); // missing 7 天内不重试
    now = NOW + 8 * DAY; await loadFunding(ctx, INST, w);
    expect(ex.calls.slice(-40).filter((c) => c.includes('market-data-history')).some((c) => Number(new URL(c).searchParams.get('begin')) === hkStart(M(2023, 5)))).toBe(true);
    expect(cache.log(`okx_funding_archive:${INST}:2023-05`)?.fetched_at).toBe(now);
  });
  it('近期走 REST,增量只补尾部;覆盖区间如实给出', async () => {
    let now = NOW; const { ex, ctx } = setup({}, () => now);
    const w = { from_ms: NOW - 3 * DAY, to_ms: NOW };
    const { series, provenance: p } = await loadFunding(ctx, INST, w);
    expect(ex.count('funding-rate-history')).toBeGreaterThan(0); expect(series.points.every((x) => x.source === 'okx')).toBe(true);
    expect(series.points).toHaveLength(9); expect(p.coverage).toBe('complete'); expect(series.to_ms).toBe(Math.floor(NOW / F8) * F8);
    const r0 = ex.count('funding-rate-history'); now = NOW + 8 * H;
    const again = await loadFunding(ctx, INST, { from_ms: w.from_ms, to_ms: now });
    expect(ex.count('funding-rate-history')).toBe(r0 + 1); expect(again.series.points).toHaveLength(10);
  });
  it('什么都拉不到 → missing,序列区间为空', async () => {
    const { ctx } = setup({ bnMissing: new Set(Array.from({ length: 12 }, (_, i) => M(2019, i + 1))) });
    const { series, provenance: p } = await loadFunding(ctx, INST, { from_ms: Date.UTC(2019, 2, 1), to_ms: Date.UTC(2019, 4, 1) });
    expect(p.coverage).toBe('missing'); expect(series.points).toEqual([]); expect(series.to_ms).toBeLessThan(series.from_ms);
  });
});
describe('维持保证金分档', () => {
  it('张数 × ctVal 换成 base 数量,升序;7 天缓存', async () => {
    let now = NOW; const { ex, ctx } = setup({}, () => now);
    const t = await loadTiers(ctx, INST);
    expect(t.tiers).toEqual([{ max_qty: 10, mmr: 0.004 }, { max_qty: 50, mmr: 0.005 }, { max_qty: 200, mmr: 0.0075 }]);
    expect(t.max_lever).toBe(100); expect(t.lever_tiers.map((x) => x.max_lever)).toEqual([100, 66.66, 50]); expect(t.ct_val).toBe(0.01);
    const n = ex.calls.length; now = NOW + 6 * DAY; await loadTiers(ctx, INST); expect(ex.calls.length).toBe(n);
    now = NOW + 7 * DAY + 1; await loadTiers(ctx, INST); expect(ex.calls.length).toBe(n + 2);
  });
});
describe('loadPerpMarket', () => {
  it('bars/mark 下标对齐,缺失标记价为 null,溯源齐全', async () => {
    const ex = fakeExchange({ markFrom: Date.UTC(2025, 0, 10) }), cache = new MarketCache(':memory:');
    const r = await loadPerpMarket({ inst_id: 'BTCUSDT', timeframe: '1d', from_ms: Date.UTC(2025, 0, 1), to_ms: Date.UTC(2025, 1, 1) - 1 }, { cache, fetchFn: ex.fetchFn, sleep: noSleep, now: () => NOW });
    expect(r.bars).toHaveLength(31); expect(r.mark).toHaveLength(31); expect(r.mark.slice(0, 9).every((m) => m === null)).toBe(true); expect(r.mark[9]!.open_time).toBe(r.bars[9]!.open_time);
    expect(r.bars[0]).toMatchObject({ open_time: Date.UTC(2025, 0, 1), close_time: Date.UTC(2025, 0, 2) - 1, available_at: Date.UTC(2025, 0, 2) - 1, volume: '1.00000000' });
    expect(r.provenance.mark_missing_bars).toBe(9); expect(r.provenance.flags).toEqual(expect.arrayContaining(['tiers_current_not_historical', 'mark_fallback_bars']));
    expect(r.funding_provenance.coverage).toBe('complete'); expect(r.tiers).toHaveLength(3); expect(r.max_lever).toBe(100);
    expect(r.provenance.trade_coverage).toEqual({ from_ms: Date.UTC(2025, 0, 1), to_ms: Date.UTC(2025, 1, 1) - 1 });
    cache.close();
  });
  it('节流:请求之间按 throttleMs 调 sleep', async () => {
    const ex = fakeExchange(), cache = new MarketCache(':memory:'), waits: number[] = [];
    await syncCandles(perpContext(cache, { fetchFn: ex.fetchFn, now: () => NOW, sleep: async (ms) => { waits.push(ms); }, throttleMs: 10_000 }), INST, 'trade', '1d', { from_ms: Date.UTC(2025, 0, 1), to_ms: Date.UTC(2025, 9, 1) - 1 });
    expect(waits.length).toBe(2); expect(waits.every((w) => w > 9_000)).toBe(true);
  });
});
