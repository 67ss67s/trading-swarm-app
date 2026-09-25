// OKX 资产全集 + 每日全市场扫描(universe-okx.ts / routes-universe.ts)。全程桩 fetch / 桩 K 线,不碰网络、不调模型。
import { afterEach, describe, expect, it } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import {
  OkxUniverseService,
  buildUniverseRows,
  currentDailyScan,
  currentUniverse,
  fetchUniverseRaw,
  lastDailyRefreshAt,
  latestUniverseScan,
  nextDailyRefreshAt,
  queryUniverse,
  resetUniverseSnapshot,
  runDailyScan,
  volume90d,
  type OkxGetFn,
  type UniverseRaw,
} from '../../src/demo/universe-okx.js';
import { registerUniverseRoutes, universeAutoEnabled } from '../../src/demo/routes-universe.js';
import { screenerRoutes } from '../../src/demo/routes-screener.js';
import { resolveUniverse } from '../../src/demo/screener.js';
import { DEFAULT_WORKFLOW } from '../../src/demo/workflow.js';
import type { RouteContext, RouteHandler } from '../../src/demo/http-extra.js';
import type { Kline, Workflow } from '../../src/demo/types.js';

const NOW = Date.UTC(2026, 8, 24, 6, 0);

const spotInst = (base: string, extra: Record<string, unknown> = {}) => ({ instId: `${base}-USDT`, instType: 'SPOT', baseCcy: base, quoteCcy: 'USDT', lotSz: '0.0001', minSz: '0.0001', tickSz: '0.01', state: 'live', listTime: '1500000000000', ...extra });
const swapInst = (base: string, extra: Record<string, unknown> = {}) => ({ instId: `${base}-USDT-SWAP`, instType: 'SWAP', instFamily: `${base}-USDT`, ctType: 'linear', settleCcy: 'USDT', ctVal: '1', ctValCcy: base, lotSz: '1', minSz: '1', tickSz: '0.01', state: 'live', listTime: '1600000000000', ...extra });

function fixture(): UniverseRaw {
  return {
    spot_instruments: [
      spotInst('BTC'),
      spotInst('ETH'),
      spotInst('USDC'), // 稳定币 → excluded
      spotInst('WBTC'), // 包装币 → excluded
      spotInst('PEPE'),
      { ...spotInst('SOL'), quoteCcy: 'USDC', instId: 'SOL-USDC' }, // 非 USDT → 不收
      spotInst('DEAD', { state: 'suspend' }), // 不在售 → 不收
    ],
    swap_instruments: [
      swapInst('BTC'),
      swapInst('ETH'),
      swapInst('DOGE'), // 只有永续
      { ...swapInst('BTC'), instId: 'BTC-USD-SWAP', instFamily: 'BTC-USD', ctType: 'inverse', settleCcy: 'BTC' }, // 币本位 → 不收
    ],
    spot_tickers: [
      { instId: 'BTC-USDT', last: '100000', open24h: '98000', volCcy24h: '5000000' },
      { instId: 'ETH-USDT', last: '4000', open24h: '4200', volCcy24h: '3000000' },
      { instId: 'USDC-USDT', last: '1', open24h: '1', volCcy24h: '90000000' },
      { instId: 'WBTC-USDT', last: '100000', open24h: '100000', volCcy24h: '100' },
      { instId: 'PEPE-USDT', last: '0.00001', open24h: '0.000008', volCcy24h: '200000' },
    ],
    swap_tickers: [
      { instId: 'BTC-USDT-SWAP', last: '100010', open24h: '98000', volCcy24h: '100' }, // 100 BTC × 100010
      { instId: 'ETH-USDT-SWAP', last: '4001', open24h: '4200', volCcy24h: '10' },
      { instId: 'DOGE-USDT-SWAP', last: '0.2', open24h: '0.25', volCcy24h: '50000000' }, // 1e7 U
    ],
    funding: [
      { instId: 'BTC-USDT-SWAP', fundingRate: '0.0001', fundingTime: '1790208000000' },
      { instId: 'DOGE-USDT-SWAP', fundingRate: '-0.0009', fundingTime: '1790208000000' },
    ],
  };
}

// ---------------------------------------------------------------- 解析 / 排除 / 排序

describe('buildUniverseRows', () => {
  const rows = buildUniverseRows(fixture(), NOW);
  const by = new Map(rows.map((r) => [r.symbol, r]));

  it('合并现货与永续,只收在售 USDT 现货 + USDT 本位线性永续', () => {
    expect([...by.keys()].sort()).toEqual(['BTCUSDT', 'DOGEUSDT', 'ETHUSDT', 'PEPEUSDT', 'USDCUSDT', 'WBTCUSDT']);
    expect(by.get('BTCUSDT')!.markets).toEqual(['spot', 'perp']);
    expect(by.get('DOGEUSDT')!.markets).toEqual(['perp']);
    expect(by.get('BTCUSDT')!.spot_inst_id).toBe('BTC-USDT');
    expect(by.get('BTCUSDT')!.perp_inst_id).toBe('BTC-USDT-SWAP');
    expect(by.get('BTCUSDT')!.listed_at).toBe(1500000000000);
  });

  it('成交额 = 现货 volCcy24h + 永续 volCcy24h×last;价格与涨跌优先现货', () => {
    const btc = by.get('BTCUSDT')!;
    expect(btc.spot_quote_volume_24h).toBe('5000000.00');
    expect(btc.perp_quote_volume_24h).toBe('10001000.00');
    expect(btc.quote_volume_24h).toBe('15001000.00');
    expect(btc.last).toBe('100000');
    expect(btc.change_24h).toBe('2.041');
    const doge = by.get('DOGEUSDT')!;
    expect(doge.last).toBe('0.2');
    expect(doge.change_24h).toBe('-20.000');
    expect(doge.funding_rate).toBe('-0.0009');
    expect(doge.next_funding_at).toBe(1790208000000);
    expect(by.get('ETHUSDT')!.funding_rate).toBeNull(); // 资金费表里没有 → 留空,不编 0
    expect(by.get('PEPEUSDT')!.funding_rate).toBeNull(); // 只有现货
  });

  it('稳定币 / 包装币打标排除,名次只在未排除里排', () => {
    expect(by.get('USDCUSDT')!.excluded).toBe(true);
    expect(by.get('USDCUSDT')!.excluded_reason).toBe('stable_or_wrapped');
    expect(by.get('USDCUSDT')!.rank_by_volume).toBeNull();
    expect(by.get('WBTCUSDT')!.excluded).toBe(true);
    // BTC 15.0M > DOGE 10M > ETH 3.04M > PEPE 2
    expect(['BTCUSDT', 'DOGEUSDT', 'ETHUSDT', 'PEPEUSDT'].map((s) => by.get(s)!.rank_by_volume)).toEqual([1, 2, 3, 4]);
  });

  it('资金费请求失败(null)时照样出表', () => {
    const r = buildUniverseRows({ ...fixture(), funding: null }, NOW);
    expect(r.find((x) => x.symbol === 'DOGEUSDT')!.funding_rate).toBeNull();
    expect(r).toHaveLength(6);
  });
});

describe('queryUniverse', () => {
  const rows = buildUniverseRows(fixture(), NOW);
  it('默认去掉 excluded、按成交额降序', () => {
    const r = queryUniverse(rows, {});
    expect(r.total).toBe(4);
    expect(r.items.map((x) => x.symbol)).toEqual(['BTCUSDT', 'DOGEUSDT', 'ETHUSDT', 'PEPEUSDT']);
    expect(queryUniverse(rows, { include_excluded: true }).total).toBe(6);
  });
  it('market 过滤 + limit', () => {
    expect(queryUniverse(rows, { market: 'spot' }).items.map((x) => x.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'PEPEUSDT']);
    const perp = queryUniverse(rows, { market: 'perp', limit: 1 });
    expect(perp.total).toBe(3);
    expect(perp.items.map((x) => x.symbol)).toEqual(['BTCUSDT']);
  });
  it('sort=change / funding,缺值沉底;order=asc', () => {
    expect(queryUniverse(rows, { sort: 'change' }).items.map((x) => x.symbol)).toEqual(['PEPEUSDT', 'BTCUSDT', 'ETHUSDT', 'DOGEUSDT']);
    expect(queryUniverse(rows, { sort: 'change', order: 'asc' }).items[0]!.symbol).toBe('DOGEUSDT');
    expect(queryUniverse(rows, { sort: 'funding' }).items.map((x) => x.symbol)).toEqual(['BTCUSDT', 'DOGEUSDT', 'ETHUSDT', 'PEPEUSDT']);
    expect(queryUniverse(rows, { sort: 'funding', order: 'asc' }).items.slice(0, 2).map((x) => x.symbol)).toEqual(['DOGEUSDT', 'BTCUSDT']);
  });
  it('q 联想:大小写不敏感,前缀命中排前面', () => {
    expect(queryUniverse(rows, { q: 'e' }).items.map((x) => x.symbol)).toEqual(['ETHUSDT', 'DOGEUSDT', 'PEPEUSDT']); // ETH 前缀命中在前,其余按成交额
    expect(queryUniverse(rows, { q: 'pe' }).items.map((x) => x.symbol)).toEqual(['PEPEUSDT']);
    expect(queryUniverse(rows, { q: 'btc-usdt' }).items.map((x) => x.symbol)).toEqual(['BTCUSDT']);
  });
});

describe('每日时刻', () => {
  it('UTC 00:10', () => {
    expect(nextDailyRefreshAt(Date.UTC(2026, 8, 24, 0, 5))).toBe(Date.UTC(2026, 8, 24, 0, 10));
    expect(nextDailyRefreshAt(Date.UTC(2026, 8, 24, 0, 10))).toBe(Date.UTC(2026, 8, 25, 0, 10));
    expect(lastDailyRefreshAt(Date.UTC(2026, 8, 24, 6))).toBe(Date.UTC(2026, 8, 24, 0, 10));
  });
});

// ---------------------------------------------------------------- 取数:重试 / 请求数

describe('fetchUniverseRaw', () => {
  const f = fixture();
  const table: Record<string, unknown[]> = {
    '/api/v5/public/instruments?instType=SPOT': f.spot_instruments,
    '/api/v5/public/instruments?instType=SWAP': f.swap_instruments,
    '/api/v5/market/tickers?instType=SPOT': f.spot_tickers,
    '/api/v5/market/tickers?instType=SWAP': f.swap_tickers,
    '/api/v5/public/funding-rate?instId=ANY': f.funding!,
  };
  it('5 个请求;失败会重试', async () => {
    let flaky = 2;
    const get = (async (path: string) => {
      if (path.includes('tickers?instType=SPOT') && flaky-- > 0) throw new Error('HTTP 429');
      return table[path];
    }) as OkxGetFn;
    const r = await fetchUniverseRaw({ get, retry_delay_ms: 0, pause_ms: 0 });
    expect(r.requests).toBe(7); // 5 + 2 次重试
    expect(r.raw.spot_tickers).toHaveLength(5);
    expect(r.notes).toEqual([]);
  });
  it('资金费失败不致命;必需请求最终失败 → 抛', async () => {
    const noFunding = (async (path: string) => {
      if (path.includes('funding-rate')) throw new Error('boom');
      return table[path];
    }) as OkxGetFn;
    const r = await fetchUniverseRaw({ get: noFunding, retry_delay_ms: 0, pause_ms: 0 });
    expect(r.raw.funding).toBeNull();
    expect(r.notes[0]).toMatch(/资金费/);
    const dead = (async (path: string) => {
      if (path.includes('instruments?instType=SWAP')) throw new Error('down');
      return table[path];
    }) as OkxGetFn;
    await expect(fetchUniverseRaw({ get: dead, retry_delay_ms: 0, pause_ms: 0, attempts: 2 })).rejects.toThrow(/down/);
  });
});

// ---------------------------------------------------------------- 服务:缓存 / 过期 / 失败保留 / 每日扫描

let state: StateDb | null = null;
afterEach(() => {
  state?.close();
  state = null;
  resetUniverseSnapshot();
});

/** 合成 K 线:缓慢上行 + 周期波动,够 buildCard 算指标。 */
function synthKlines(tf: string, n: number, now: number, base: number): Kline[] {
  const step = tf === '4h' ? 14_400_000 : 86_400_000;
  const lastOpen = Math.floor(now / step) * step - step; // 最后一根已收盘
  const out: Kline[] = [];
  for (let i = 0; i < n; i++) {
    const t = lastOpen - (n - 1 - i) * step;
    const c = base * (1 + i * 0.001 + 0.02 * Math.sin(i / 5));
    out.push({ open_time: t, open: String(c * 0.998), high: String(c * 1.01), low: String(c * 0.99), close: String(c), volume: String(1000 + (i % 7) * 100), close_time: t + step - 1 });
  }
  return out;
}

function mkService(opts: { now: () => number; fail?: () => boolean; klineCalls?: string[] }) {
  state = openStateDb(':memory:');
  const store = new DemoStore(state);
  store.strategies.seed(NOW);
  let fetches = 0;
  const svc = new OkxUniverseService(state.db, {
    now: opts.now,
    library: () => store.strategies,
    fetchRaw: async () => {
      fetches++;
      if (opts.fail?.()) throw new Error('OKX 挂了');
      return { raw: fixture(), requests: 5, notes: [] };
    },
    fetchKlines: async (symbol, tf, limit, _end, market) => {
      opts.klineCalls?.push(`${symbol}:${tf}:${market}`);
      return synthKlines(tf, limit, opts.now(), symbol.startsWith('BTC') ? 100000 : 1);
    },
    scan_pause_ms: 0,
    retry_ms: 60_000,
  });
  return { svc, store, fetches: () => fetches };
}

describe('OkxUniverseService', () => {
  it('刷新落库 + 内存快照;失败保留上一次缓存', async () => {
    let now = NOW;
    let fail = false;
    const { svc, fetches } = mkService({ now: () => now, fail: () => fail });
    expect(svc.due()).toEqual({ refresh: true, scan: true });
    const ok = await svc.refresh('manual');
    expect(ok).toMatchObject({ ok: true, total: 6, eligible: 4, requests: 5, updated_at: NOW });
    expect(currentUniverse()!.items).toHaveLength(6);
    expect(svc.store.all().find((r) => r.symbol === 'BTCUSDT')!.markets).toEqual(['spot', 'perp']);
    expect(svc.store.lastRefresh()).toMatchObject({ status: 'done', total: 6, requests: 5, reason: 'manual' });

    now += 3_600_000;
    fail = true;
    const bad = await svc.refresh('timer');
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/OKX 挂了/);
    expect(bad.updated_at).toBe(NOW); // 还是上一次的
    expect(svc.store.all()).toHaveLength(6);
    expect(currentUniverse()!.items).toHaveLength(6);
    expect(svc.store.lastRefresh()).toMatchObject({ status: 'failed' });
    expect(fetches()).toBe(2);
  });

  it('缓存过期判定:超过 24h 才刷;今天(UTC 00:10 后)没扫过才扫', async () => {
    let now = NOW;
    const { svc, fetches } = mkService({ now: () => now });
    await svc.tick('boot'); // 从没刷过 → 刷 + 扫
    expect(fetches()).toBe(1);
    expect(svc.latestScan()).not.toBeNull();
    expect(svc.due()).toEqual({ refresh: false, scan: false });
    now = NOW + 20 * 3_600_000; // 次日 02:00:过了 00:10,该扫;缓存 20h,不用刷
    expect(svc.due()).toEqual({ refresh: false, scan: true });
    now = NOW + 25 * 3_600_000;
    expect(svc.due().refresh).toBe(true);
    svc.stop();
  });

  it('开机刷新失败 → 不扫、挂重试;旧缓存不动', async () => {
    const { svc } = mkService({ now: () => NOW, fail: () => true });
    await svc.tick('boot');
    expect(svc.latestScan()).toBeNull();
    expect(currentUniverse()!.items).toEqual([]);
    svc.stop();
  });

  it('每日扫描:只对前 N 拉 K 线(永续优先),存成 horizon=daily / universe=okx_all 的 screen + 候选,写回 90 天成交额', async () => {
    const calls: string[] = [];
    const { svc, store } = mkService({ now: () => NOW, klineCalls: calls });
    await svc.refresh('manual');
    // top_n 默认 150 > 4 个可交易 → 全拉;每币 2 个请求
    const r = await svc.scan('manual');
    expect(r).not.toBeNull();
    expect(r!.requests).toBe(8);
    expect(calls).toContain('BTCUSDT:4h:perp');
    expect(calls).toContain('PEPEUSDT:1d:spot'); // 只有现货的用现货 K 线
    expect(calls.some((c) => c.startsWith('USDCUSDT'))).toBe(false); // 排除的不拉
    const screen = svc.latestScan()!;
    expect(screen.horizon).toBe('daily');
    expect(screen.universe).toBe('okx_all');
    expect(screen.status).toBe('done');
    expect(screen.symbols).toEqual(['BTCUSDT', 'DOGEUSDT', 'ETHUSDT', 'PEPEUSDT']);
    expect(screen.proposal!.note).toMatch(/每日全市场扫描/);
    const cands = store.screens.candidates(screen.id);
    expect(cands.length).toBeGreaterThan(0);
    expect(cands[0]!.reasons[0]).toMatch(/^OKX (永续|现货),24h 成交额第 \d+ \/ 4$/);
    expect(currentDailyScan()!.symbols.length).toBe(cands.length);
    const btc = svc.store.all().find((a) => a.symbol === 'BTCUSDT')!;
    expect(Number(btc.quote_volume_90d)).toBeGreaterThan(0);
    expect(btc.rank_by_volume_90d).toBe(1);
    // radar 的周期表不受影响:它按 short/swing/weekly 查,看不到 daily
    expect(store.screens.latest('short')).toBeNull();

    const sum = latestUniverseScan(state!.db, { limit: 2 });
    expect(sum).toMatchObject({ ready: true, screen_id: screen.id, scanned: 4, errors: 0 });
    expect(sum.candidates.length).toBeLessThanOrEqual(2);
    expect(Object.keys(sum.candidates[0]!).sort()).toEqual(['rank', 'reasons', 'score', 'strategy_id', 'symbol']);

    // 90 天成交额跨刷新保留
    await svc.refresh('manual');
    expect(svc.store.all().find((a) => a.symbol === 'BTCUSDT')!.rank_by_volume_90d).toBe(1);
  });

  it('top_n 限制 K 线请求量', async () => {
    const assets = buildUniverseRows(fixture(), NOW);
    const calls: string[] = [];
    const r = await runDailyScan({ assets, strategies: [], now: NOW, top_n: 2, pause_ms: 0, fetch_klines: async (s, tf, limit, _e, m) => { calls.push(`${s}:${tf}:${m}`); return synthKlines(tf, limit, NOW, 1); } });
    expect(calls).toEqual(['BTCUSDT:4h:perp', 'BTCUSDT:1d:perp', 'DOGEUSDT:4h:perp', 'DOGEUSDT:1d:perp']);
    expect(r.screen.symbols).toHaveLength(4);
    expect(r.screen.proposal!.note).toMatch(/其余 2 个只按 24h 成交额排序/);
  });

  it('K 线失败先补第二遍,仍失败才记进 errors,不中断整次扫描', async () => {
    const assets = buildUniverseRows(fixture(), NOW);
    let dogeFlaky = 4; // DOGE 第一遍两条 K 线各失败两次(klinesWithRetry 2 次都挂)→ 第二遍补回
    const r = await runDailyScan({ assets, strategies: [], now: NOW, pause_ms: 0, second_pass_pause_ms: 0, fetch_klines: async (s, tf, limit) => {
      if (s === 'ETHUSDT') throw new Error('HTTP 429');
      if (s === 'DOGEUSDT' && dogeFlaky-- > 0) throw new Error('ECONNRESET');
      return synthKlines(tf, limit, NOW, 1);
    } });
    expect(r.screen.errors.map((e) => e.symbol)).toEqual(['ETHUSDT']);
    expect(r.cards.map((c) => c.symbol).sort()).toEqual(['BTCUSDT', 'DOGEUSDT', 'PEPEUSDT']);
  });

  it('volume90d 只算完整 UTC 日,最多 90 根', () => {
    const d1 = synthKlines('1d', 120, NOW, 1);
    const v = volume90d(d1, NOW)!;
    expect(v.days).toBe(90);
    expect(volume90d([], NOW)).toBeNull();
  });

  it('radar okx_all:每日扫描候选优先,再按成交额补齐,只取有永续的', async () => {
    const { svc } = mkService({ now: () => NOW });
    await svc.refresh('manual');
    await svc.scan('manual');
    const w = { ...DEFAULT_WORKFLOW, screener_universe: 'okx_all', screener_max_symbols: 10 } as Workflow;
    const r = await resolveUniverse(w, null);
    expect(r.universe).toBe('okx_all');
    expect(r.symbols.sort()).toEqual(['BTCUSDT', 'DOGEUSDT', 'ETHUSDT']); // PEPE 只有现货,USDC/WBTC 排除
    expect(r.note).toMatch(/OKX 全市场/);
  });
});

// ---------------------------------------------------------------- 路由形状

describe('routes-universe', () => {
  function harness() {
    state = openStateDb(':memory:');
    const store = new DemoStore(state);
    const routes = new Map<string, RouteHandler>();
    let out: { status: number; body: any } = { status: 0, body: null };
    const ctx = {
      route: (method: string, path: string, handler: RouteHandler) => routes.set(`${method} ${path}`, handler),
      guarded: (fn: RouteHandler) => fn,
      json: (_res: unknown, status: number, body: unknown) => { out = { status, body }; },
      fail: (_res: unknown, status: number, message: string, code?: string) => { out = { status, body: { error: message, code } }; },
      readBody: async () => ({ scan: false }),
      rt: { workflow: { watchlist: ['DOGEUSDT'], watchlist_max: 60 }, log: () => undefined, radar: { schedule: () => [], isRunning: () => false } } as never,
      store,
      oauth: null,
      emit: () => undefined,
    } as unknown as RouteContext;
    // 先按真实写法落一次缓存,再注册路由(服务构造时从库里装快照)
    const seed = new OkxUniverseService(state.db, { fetchRaw: async () => ({ raw: fixture(), requests: 5, notes: [] }) });
    const svc = registerUniverseRoutes(ctx);
    screenerRoutes(ctx);
    return {
      seed, svc, store,
      call: async (method: string, path: string) => {
        const url = new URL(`http://x${path}`);
        await routes.get(`${method} ${url.pathname}`)!({} as never, {} as never, url, {});
        return out;
      },
    };
  }

  it('测试进程里不自动挂定时器', () => {
    expect(universeAutoEnabled()).toBe(false);
    expect(universeAutoEnabled({ TG_UNIVERSE_AUTO: '1' })).toBe(true);
  });

  it('GET /api/universe 形状、过滤、watched 标记、参数校验', async () => {
    const h = harness();
    const empty = await h.call('GET', '/api/universe');
    expect(empty).toMatchObject({ status: 200, body: { updated_at: null, total: 0, items: [] } });
    await h.seed.refresh('manual');
    const r = await h.call('GET', '/api/universe?market=perp&sort=funding&limit=2');
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(['items', 'last_refresh', 'refreshing', 'scanning', 'total', 'updated_at']);
    expect(r.body.total).toBe(3);
    expect(r.body.items.map((x: { symbol: string }) => x.symbol)).toEqual(['BTCUSDT', 'DOGEUSDT']);
    expect(r.body.items[1].watched).toBe(true);
    expect(r.body.items[0].watched).toBe(false);
    expect(Object.keys(r.body.items[0]).sort()).toEqual([
      'base', 'change_24h', 'excluded', 'excluded_reason', 'funding_rate', 'last', 'listed_at', 'markets', 'next_funding_at', 'perp_inst_id',
      'perp_quote_volume_24h', 'quote_volume_24h', 'quote_volume_90d', 'rank_by_volume', 'rank_by_volume_90d', 'spot_inst_id', 'spot_quote_volume_24h',
      'symbol', 'updated_at', 'watched',
    ]);
    expect((await h.call('GET', '/api/universe?q=pe')).body.items.map((x: { symbol: string }) => x.symbol)).toEqual(['PEPEUSDT']);
    expect((await h.call('GET', '/api/universe?market=x')).status).toBe(400);
    expect((await h.call('GET', '/api/universe?sort=x')).status).toBe(400);
    expect((await h.call('GET', '/api/universe?limit=0')).status).toBe(400);
  });

  it('POST /api/universe/refresh 走 OKX 公共接口(桩 fetch),返回刷新摘要;失败 502 且保留旧表', async () => {
    const h = harness();
    const f = fixture();
    const table: Record<string, unknown[]> = {
      '/api/v5/public/instruments?instType=SPOT': f.spot_instruments,
      '/api/v5/public/instruments?instType=SWAP': f.swap_instruments,
      '/api/v5/market/tickers?instType=SPOT': f.spot_tickers,
      '/api/v5/market/tickers?instType=SWAP': f.swap_tickers,
      '/api/v5/public/funding-rate?instId=ANY': f.funding!,
    };
    const original = globalThis.fetch;
    const savedBase = process.env['TG_OKX_REST_BASE'];
    process.env['TG_OKX_REST_BASE'] = 'http://okx.fake';
    let down = false;
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = String(input);
      urls.push(u);
      if (down) return new Response('busy', { status: 503 });
      const path = u.slice('http://okx.fake'.length);
      return new Response(JSON.stringify({ code: '0', msg: '', data: table[path] ?? [] }), { status: 200 });
    }) as typeof fetch;
    try {
      const r = await h.call('POST', '/api/universe/refresh');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, total: 6, eligible: 4, requests: 5, error: null, scan: 'skipped' });
      expect(urls.every((u) => u.startsWith('http://okx.fake/api/v5/'))).toBe(true);
      expect((await h.call('GET', '/api/universe')).body.total).toBe(4);
      down = true;
      (h.svc as unknown as { opts: { fetchOptions: unknown } }).opts.fetchOptions = { retry_delay_ms: 0, pause_ms: 0 };
      const bad = await h.call('POST', '/api/universe/refresh');
      expect(bad.status).toBe(502);
      expect(bad.body.ok).toBe(false);
      expect((await h.call('GET', '/api/universe')).body.total).toBe(4);
    } finally {
      globalThis.fetch = original;
      if (savedBase === undefined) delete process.env['TG_OKX_REST_BASE'];
      else process.env['TG_OKX_REST_BASE'] = savedBase;
    }
  });

  it('limit 能取全量(上限 5000);每日扫描经 /api/screener/latest?horizon=daily 与 history 取得到', async () => {
    const h = harness();
    await h.seed.refresh('manual');
    const all = await h.call('GET', '/api/universe?market=all&limit=5000&sort=volume');
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(4);
    // 用一次桩 K 线的扫描落库(与真实写法同一个 ScreenStore)
    const scanSvc = new OkxUniverseService(state!.db, { library: () => h.store.strategies, fetchKlines: async (_s, tf, limit) => synthKlines(tf, limit, NOW, 1), scan_pause_ms: 0 });
    await scanSvc.scan('manual');
    const latest = await h.call('GET', '/api/screener/latest?horizon=daily');
    expect(latest.status).toBe(200);
    expect(latest.body.screen).toMatchObject({ horizon: 'daily', universe: 'okx_all', status: 'done' });
    expect(latest.body.screen.symbols).toHaveLength(4);
    const hist = await h.call('GET', '/api/screener/history');
    expect(hist.body.screens.some((x: { universe: string }) => x.universe === 'okx_all')).toBe(true);
    expect((await h.call('GET', '/api/screener/latest?horizon=nope')).status).toBe(400);
    const scan = await h.call('GET', '/api/universe/scan');
    expect(scan.body.screen.id).toBe(latest.body.screen.id);
  });

  it('GET /api/universe/scan 没扫过时返回空', async () => {
    const h = harness();
    const r = await h.call('GET', '/api/universe/scan');
    expect(r).toMatchObject({ status: 200, body: { screen: null, candidates: [], running: false, progress: null } });
  });
});
