// OKX 公共行情适配层的单测(docs/design/okx-atk-2026-09-20.md §3),打本地假 OKX 服务器。
//
// 这层的活全是「把 OKX 的口径翻成 Binance 的口径」:新→旧要反转、成交量要取 volCcy 而不是 vol(张)、
// 持仓量要取 oiCcy、涨跌幅 OKX 压根不给要自己算。每一条翻错了都不会报错,只会让策略拿到一份
// 静悄悄错掉的行情——所以这里逐条钉死。
//
// env 必须在 import 之前设:market.ts / market-okx.ts 的基址是每次调用现读没错,但模块图里
// 任何一条静态 import 边都可能先把它们拉进来(见 market-retry.test.ts 顶上的注释),动态 import 最省心。

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startFakeOkxServer, type FakeOkxServer } from './helpers/fake-okx-server.js';

let fake: FakeOkxServer;
let okx: typeof import('../../src/demo/market-okx.js');
let market: typeof import('../../src/demo/market.js');
let instruments: typeof import('../../src/demo/okx/instruments.js');

beforeAll(async () => {
  fake = await startFakeOkxServer();
  process.env['TG_OKX_REST_BASE'] = fake.url;
  process.env['TG_EXCHANGE'] = 'okx';
  okx = await import('../../src/demo/market-okx.js');
  market = await import('../../src/demo/market.js');
  instruments = await import('../../src/demo/okx/instruments.js');
});

afterAll(async () => {
  await fake.close();
  delete process.env['TG_OKX_REST_BASE'];
  delete process.env['TG_EXCHANGE'];
});

afterEach(() => {
  // 两个模块级缓存(合约表 10 分钟 / exchangeInfo 10 分钟)会把上一条用例的结果漏给下一条。
  instruments.resetInstruments();
  okx.resetOkxMarketCaches();
  fake.resetCalls();
});

describe('K 线', () => {
  it('新→旧反成旧→新,open/close_time 由 bar 跨度推,volume 取 volCcy(index 6)', async () => {
    const ks = await okx.fetchKlinesOkx('BTCUSDT', '1m', 5);
    expect(ks).toHaveLength(5);
    expect(ks[ks.length - 1]!.open_time).toBe(fake.anchorTs); // 最后一根是最新的
    for (let i = 1; i < ks.length; i++) expect(ks[i]!.open_time).toBeGreaterThan(ks[i - 1]!.open_time);
    for (const k of ks) expect(k.close_time).toBe(k.open_time + 60_000 - 1);
    // 假服务器里 vol(张) = 100 + age%37,volCcy = vol×0.01。取错 index 会得到 100 倍的量。
    const newest = ks[ks.length - 1]!;
    expect(newest.volume).toBe('1.0000');
    expect(Number(newest.volume)).toBeLessThan(10);
    expect(newest.open).toBe('81000.3');
    expect(newest.close).toBe('81000.0');
  });

  it('含当前未收盘那根(confirm 为 0 的不过滤,与 Binance klines 一致)', async () => {
    const ks = await okx.fetchKlinesOkx('BTCUSDT', '1m', 3);
    expect(ks.some((k) => k.open_time === fake.anchorTs)).toBe(true);
  });

  it('tf → bar:日线周线必须是 UTC 版', () => {
    expect(okx.tfToBar('1m')).toBe('1m');
    expect(okx.tfToBar('5m')).toBe('5m');
    expect(okx.tfToBar('15m')).toBe('15m');
    expect(okx.tfToBar('1h')).toBe('1H');
    expect(okx.tfToBar('4h')).toBe('4H');
    expect(okx.tfToBar('1d')).toBe('1Dutc');
    expect(okx.tfToBar('1w')).toBe('1Wutc');
    // codex-review #15:OKX 的 `6H`/`12H` 按 UTC+8 分桶,UTC 版要带后缀。
    expect(okx.tfToBar('6h')).toBe('6Hutc');
    expect(okx.tfToBar('12h')).toBe('12Hutc');
    expect(okx.tfToBar('3d')).toBe('3Dutc');
  });

  it('每个 tf 都真的用对应的 bar 请求,并按该跨度切 close_time', async () => {
    const cases: [string, string, number][] = [
      ['1m', '1m', 60_000],
      ['5m', '5m', 300_000],
      ['15m', '15m', 900_000],
      ['1h', '1H', 3_600_000],
      ['4h', '4H', 14_400_000],
      ['1d', '1Dutc', 86_400_000],
      ['1w', '1Wutc', 604_800_000],
    ];
    for (const [tf, bar, span] of cases) {
      fake.resetCalls();
      const ks = await okx.fetchKlinesOkx('BTCUSDT', tf, 3);
      const req = fake.requests.find((r) => r.path === '/api/v5/market/candles');
      expect(req?.query['bar']).toBe(bar);
      expect(req?.query['instId']).toBe('BTC-USDT-SWAP');
      expect(ks[0]!.close_time - ks[0]!.open_time).toBe(span - 1);
      expect(ks[1]!.open_time - ks[0]!.open_time).toBe(span);
    }
  });

  it('limit>300 时用 after 往更早翻页:700 根、严格递增、无重复、请求不止一次', async () => {
    const ks = await okx.fetchKlinesOkx('BTCUSDT', '1m', 700);
    expect(ks).toHaveLength(700);
    for (let i = 1; i < ks.length; i++) expect(ks[i]!.open_time).toBeGreaterThan(ks[i - 1]!.open_time);
    expect(new Set(ks.map((k) => k.open_time)).size).toBe(700);
    expect(fake.calls['/api/v5/market/candles']).toBeGreaterThan(1);
    expect(fake.calls['/api/v5/market/history-candles'] ?? 0).toBe(0); // 近窗够深就不该惊动归档端点
    // 第二页起必须带 after,且 after 恰好是上一页最老那根的 ts(严格小于语义)
    const reqs = fake.requests.filter((r) => r.path === '/api/v5/market/candles');
    expect(reqs[0]?.query['after']).toBeUndefined();
    expect(Number(reqs[1]?.query['after'])).toBe(fake.anchorTs - 299 * 60_000);
    expect(ks[0]!.open_time).toBe(fake.anchorTs - 699 * 60_000);
  });

  it('endTime:不返回比它更新的 K 线(after = endTime+1,含当根)', async () => {
    const endTime = fake.anchorTs - 10 * 60_000;
    const ks = await okx.fetchKlinesOkx('BTCUSDT', '1m', 5, endTime);
    expect(ks).toHaveLength(5);
    expect(Math.max(...ks.map((k) => k.open_time))).toBe(endTime);
    for (const k of ks) expect(k.open_time).toBeLessThanOrEqual(endTime);
    const req = fake.requests.find((r) => r.path === '/api/v5/market/candles');
    expect(Number(req?.query['after'])).toBe(endTime + 1);
  });
});

// 真 OKX 的 /market/candles 只服务最近约 1440 根,再往前它**返回空数组而不是报错**
// (2026-09-20 实测:after = now-5d 时 candles 返回 [],history-candles 返回正常数据)。
// 只靠 candles 的话深 limit 会静默少给、endTime 落在窗外直接空手而归,下游看起来像
// 「这个币历史很短」——所以近窗到头必须接着翻归档端点。这里用 candleWindow 把那道墙搬近来验。
describe('K 线跨近窗回落 history-candles', () => {
  const withNearWindow = async (fn: (near: FakeOkxServer) => Promise<void>): Promise<void> => {
    const near = await startFakeOkxServer({ candleWindow: 500 });
    const saved = process.env['TG_OKX_REST_BASE'];
    process.env['TG_OKX_REST_BASE'] = near.url;
    try {
      await fn(near);
    } finally {
      process.env['TG_OKX_REST_BASE'] = saved!;
      await near.close();
    }
  };

  it('近窗只有 500 根也能凑满 700:先 candles 后 history-candles,去重、严格递增', async () => {
    await withNearWindow(async (near) => {
      const ks = await okx.fetchKlinesOkx('BTCUSDT', '1m', 700);
      expect(ks).toHaveLength(700);
      for (let i = 1; i < ks.length; i++) expect(ks[i]!.open_time).toBeGreaterThan(ks[i - 1]!.open_time);
      expect(new Set(ks.map((k) => k.open_time)).size).toBe(700);
      expect(ks[ks.length - 1]!.open_time).toBe(near.anchorTs);
      expect(ks[0]!.open_time).toBe(near.anchorTs - 699 * 60_000);
      // 两个端点都被打到,且顺序是「先近窗、后归档」
      expect(near.calls['/api/v5/market/candles']).toBeGreaterThan(0);
      expect(near.calls['/api/v5/market/history-candles']).toBeGreaterThan(0);
      const order = near.requests.filter((r) => r.path.includes('candles')).map((r) => r.path);
      expect(order[0]).toBe('/api/v5/market/candles');
      expect(order[order.length - 1]).toBe('/api/v5/market/history-candles');
      // 切过去之后不再回头打近窗端点
      const firstHistory = order.indexOf('/api/v5/market/history-candles');
      expect(order.slice(firstHistory).every((p) => p.endsWith('history-candles'))).toBe(true);
    });
  });

  it('endTime 落在近窗之外照样出数据,且没有比 endTime 更新的', async () => {
    await withNearWindow(async (near) => {
      const endTime = near.anchorTs - 900 * 60_000; // 比 500 根的近窗还老
      const ks = await okx.fetchKlinesOkx('BTCUSDT', '1m', 10, endTime);
      expect(ks).toHaveLength(10);
      expect(Math.max(...ks.map((k) => k.open_time))).toBe(endTime);
      for (const k of ks) expect(k.open_time).toBeLessThanOrEqual(endTime);
      expect(new Set(ks.map((k) => k.open_time)).size).toBe(10);
      expect(near.calls['/api/v5/market/history-candles']).toBeGreaterThan(0);
    });
  });

  it('归档端点也翻到底就停(不会为了凑数死循环)', async () => {
    const tiny = await startFakeOkxServer({ candleWindow: 5, totalCandles: 40 });
    const saved = process.env['TG_OKX_REST_BASE'];
    process.env['TG_OKX_REST_BASE'] = tiny.url;
    try {
      const ks = await okx.fetchKlinesOkx('BTCUSDT', '1m', 500);
      expect(ks).toHaveLength(40); // 服务端总共就这么多
      expect(new Set(ks.map((k) => k.open_time)).size).toBe(40);
      expect(tiny.calls['/api/v5/market/history-candles']).toBeLessThan(10); // 远没到 200 页的守卫
    } finally {
      process.env['TG_OKX_REST_BASE'] = saved!;
      await tiny.close();
    }
  });
});

describe('溢价 / 资金费 / 持仓量', () => {
  it('premiumIndex:mark、index(取 index-tickers 的 family)、fundingRate、nextFundingTime', async () => {
    const p = await okx.fetchPremiumIndexOkx('BTCUSDT');
    expect(p.markPrice).toBe('81423.5');
    expect(p.indexPrice).toBe('81455');
    expect(p.lastFundingRate).toBe('0.0001');
    expect(p.nextFundingTime).toBe(fake.anchorTs + 3_600_000);
    expect(p.time).toBeGreaterThan(0);
    // 指数价走批量接口(quoteCcy=USDT),按去掉 -SWAP 的 family 取
    expect(fake.requests.find((r) => r.path === '/api/v5/market/index-tickers')?.query['quoteCcy']).toBe('USDT');
  });

  it('行情走全市场批量接口:并发多次取同一 instType 只打一次请求(防 429)', async () => {
    okx.resetOkxMarketCaches();
    const before = fake.requests.filter((r) => r.path === '/api/v5/public/mark-price').length;
    await Promise.all([1, 2, 3, 4, 5].map(() => okx.fetchPremiumIndexOkx('BTCUSDT')));
    await okx.fetchPremiumIndexOkx('BTCUSDT');
    const marks = fake.requests.filter((r) => r.path === '/api/v5/public/mark-price').slice(before);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.query['instId']).toBeUndefined();
    expect(marks[0]!.query['instType']).toBe('SWAP');
  });

  it('openInterest 取 oiCcy(币),不是 oi(张)', async () => {
    const oi = await okx.fetchOpenInterestOkx('BTCUSDT');
    expect(oi.openInterest).toBe('30921.317');
    expect(oi.time).toBeGreaterThan(0);
  });

  it('OI 历史反成旧→新,sumOpenInterest=oiCcy、sumOpenInterestValue=oiUsd', async () => {
    const rows = await okx.fetchOpenInterestHistOkx('BTCUSDT', '1h', 6);
    expect(rows).toHaveLength(6);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.timestamp).toBeGreaterThan(rows[i - 1]!.timestamp);
    const newest = rows[rows.length - 1]!;
    expect(newest.timestamp).toBe(fake.anchorTs);
    expect(newest.sumOpenInterest).toBe('30920.0000'); // oiCcy = oi/100
    expect(newest.sumOpenInterestValue).toBe('2517506400.00'); // oiUsd
    // period 走 Binance→rubik 的映射
    expect(fake.requests.find((r) => r.path.endsWith('open-interest-history'))?.query['period']).toBe('1H');
  });

  it('OI 历史 limit 钳到 100(rubik 的真实上限,再多它也只给 100)', async () => {
    await okx.fetchOpenInterestHistOkx('BTCUSDT', '5m', 300);
    expect(fake.requests.find((r) => r.path.endsWith('open-interest-history'))?.query['limit']).toBe('100');
  });

  it('period 映射:OKX 没有 30m/2h/6h/12h 档,向下靠', () => {
    expect(okx.periodToOkx('5m')).toBe('5m');
    expect(okx.periodToOkx('30m')).toBe('15m');
    expect(okx.periodToOkx('1h')).toBe('1H');
    expect(okx.periodToOkx('12h')).toBe('4H');
    expect(okx.periodToOkx('1d')).toBe('1D');
  });

  it('资金费历史:升序、优先 realizedRate、单页 100 所以 120 条要翻两次', async () => {
    const rows = await okx.fetchFundingRateHistoryOkx('BTCUSDT', 120);
    expect(rows).toHaveLength(120);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.at).toBeGreaterThan(rows[i - 1]!.at);
    expect(rows[rows.length - 1]!.at).toBe(fake.anchorTs);
    expect(rows[rows.length - 1]!.rate).toBe('0.00005000'); // realizedRate,不是 fundingRate 的 0.0001
    expect(rows.every((r) => r.rate !== '0.0001')).toBe(true);
    expect(fake.calls['/api/v5/public/funding-rate-history']).toBe(2);
  });

  it('资金费历史 startTime 截断', async () => {
    const start = fake.anchorTs - 5 * 28_800_000;
    const rows = await okx.fetchFundingRateHistoryOkx('BTCUSDT', 120, start);
    expect(rows.every((r) => r.at >= start)).toBe(true);
    expect(rows).toHaveLength(6);
  });
});

describe('24h ticker', () => {
  it('涨跌幅自己算(OKX 不给),quoteVolume = volCcy24h × last', async () => {
    const t = await okx.fetchTicker24hOkx('BTCUSDT');
    const last = 81420.1;
    const open = 81009.9;
    expect(t.lastPrice).toBe('81420.1');
    expect(t.priceChangePercent).toBe((((last - open) / open) * 100).toFixed(3));
    expect(t.quoteVolume).toBe((48910.5325 * last).toFixed(2));
    expect(t.highPrice).toBe('81930');
    expect(t.lowPrice).toBe('80806.3');
  });

  it('下跌时是负号(不是取绝对值)', async () => {
    const t = await okx.fetchTicker24hOkx('ETHUSDT');
    expect(Number(t.priceChangePercent)).toBeLessThan(0);
    expect(t.priceChangePercent).toBe((((3120.55 - 3200.11) / 3200.11) * 100).toFixed(3));
  });
});

describe('instruments / exchangeInfo', () => {
  it('抓一次表就进缓存,并发调用合并成一个请求', async () => {
    const [a, b] = await Promise.all([okx.loadOkxInstruments(), okx.loadOkxInstruments()]);
    expect(a).toEqual(b);
    expect(fake.calls['/api/v5/public/instruments']).toBe(1);
    // 表进了 instruments.ts 的缓存,符号映射不再走硬拼兜底
    expect(instruments.instrumentOf('XRPUSDT')?.ctVal).toBe('100');
    await okx.loadOkxInstruments();
    expect(fake.calls['/api/v5/public/instruments']).toBe(1); // 10 分钟内不再抓
  });

  it('okxInstrument 查不到就抛(带上 instId,方便一眼看出是符号没对上)', async () => {
    await expect(okx.okxInstrument('NOPEUSDT')).rejects.toThrow(/NOPE-USDT-SWAP/);
  });

  it('contractsToQtySync:表里没有就原样返回,不吞数字', async () => {
    expect(okx.contractsToQtySync('1.3', 'BTCUSDT')).toBe('1.3');
    await okx.loadOkxInstruments();
    expect(okx.contractsToQtySync('1.3', 'BTCUSDT')).toBe('0.013');
  });

  it('fetchExchangeInfo 经 market.ts 分发到 OKX:已过滤、min_notional 用 tickers 的最新价', async () => {
    const rows = await market.fetchExchangeInfo();
    const symbols = rows.map((r) => r.symbol);
    expect(symbols).toEqual(['BTCUSDT', 'ETHUSDT', 'XRPUSDT']); // 已按 status/symbol 排序
    expect(symbols).not.toContain('BTCUSD'); // inverse 被筛掉
    expect(symbols).not.toContain('DOGEUSDT'); // suspend 被筛掉
    const btc = rows.find((r) => r.symbol === 'BTCUSDT')!;
    expect(btc.status).toBe('TRADING');
    expect(btc.step_size).toBe('0.0001');
    expect(btc.tick_size).toBe('0.1');
    expect(btc.min_qty).toBe('0.0001');
    expect(btc.min_notional).toBe('8.14201'); // 0.0001 × 81420.1
    const xrp = rows.find((r) => r.symbol === 'XRPUSDT')!;
    expect(xrp.step_size).toBe('1');
    expect(xrp.min_notional).toBe('2.1234');
  });

  it('exchangeInfo 有 10 分钟缓存', async () => {
    await market.fetchExchangeInfo();
    const n = fake.calls['/api/v5/public/instruments'];
    await market.fetchExchangeInfo();
    expect(fake.calls['/api/v5/public/instruments']).toBe(n);
  });
});

describe('market.ts 分发', () => {
  it('K 线/ticker 经 market.ts 出来的和直接调 OKX 实现一致', async () => {
    const viaDispatch = await market.fetchKlines('BTCUSDT', '15m', 4);
    fake.resetCalls();
    const direct = await okx.fetchKlinesOkx('BTCUSDT', '15m', 4);
    expect(viaDispatch).toEqual(direct);
    expect(await market.fetchTicker24h('BTCUSDT')).toEqual(await okx.fetchTicker24hOkx('BTCUSDT'));
    expect(await market.fetchOpenInterest('BTCUSDT')).toEqual(await okx.fetchOpenInterestOkx('BTCUSDT'));
  });

  it('TG_DEMO_MARKET_BASE 被设且 TG_EXCHANGE 未设 → 行情走 binance(那是币安形状的假服务器)', () => {
    const savedExchange = process.env['TG_EXCHANGE'];
    delete process.env['TG_EXCHANGE'];
    process.env['TG_DEMO_MARKET_BASE'] = 'http://127.0.0.1:1';
    try {
      expect(market.marketExchange()).toBe('binance');
      expect(market.exchange()).toBe('okx'); // 交易所本身默认仍是 okx,只有行情实现被让路
      process.env['TG_EXCHANGE'] = 'okx';
      expect(market.marketExchange()).toBe('okx'); // 显式 okx 压过基址推断
      process.env['TG_EXCHANGE'] = 'binance';
      expect(market.marketExchange()).toBe('binance');
      expect(market.exchange()).toBe('binance');
    } finally {
      delete process.env['TG_DEMO_MARKET_BASE'];
      if (savedExchange === undefined) delete process.env['TG_EXCHANGE'];
      else process.env['TG_EXCHANGE'] = savedExchange;
    }
  });

  it('两条基址都没设时默认 okx', () => {
    const saved = process.env['TG_EXCHANGE'];
    delete process.env['TG_EXCHANGE'];
    try {
      expect(market.marketExchange()).toBe('okx');
    } finally {
      if (saved === undefined) delete process.env['TG_EXCHANGE'];
      else process.env['TG_EXCHANGE'] = saved;
    }
  });
});

describe('okxGet 错误处理', () => {
  it('OKX code 非 0 当业务错误抛,不重试', async () => {
    fake.resetCalls();
    await expect(okx.okxGet('/api/v5/nope/route')).rejects.toThrow(/OKX 51001/);
    expect(fake.calls['/api/v5/nope/route']).toBe(1);
  });
});

describe('spot market / basis', () => {
  it('spot K线使用现货 instId,资金费和 OI 为零且不联网', async () => {
    await okx.fetchKlinesOkx('BTCUSDT', '1m', 3, undefined, 'spot');
    expect(fake.requests.find(r => r.path.endsWith('/candles'))?.query['instId']).toBe('BTC-USDT');
    fake.resetCalls();
    expect(await okx.fetchPremiumIndexOkx('BTCUSDT', 'spot')).toMatchObject({ lastFundingRate: '0', nextFundingTime: 0 });
    expect(await okx.fetchOpenInterestOkx('BTCUSDT', 'spot')).toMatchObject({ openInterest: '0' });
    expect(fake.requests).toHaveLength(0);
  });

  it('基差与年化使用现货 last / 永续 mark,缓存 10 秒', async () => {
    const basis = await okx.fetchBasis('BTCUSDT');
    expect(basis).toMatchObject({ symbol: 'BTCUSDT', spot_last: '81400', perp_mark: '81423.5', perp_last: '81420.1', basis: '23.5', funding_interval_ms: 28800000 });
    expect(Number(basis.funding_annualized_pct)).toBeCloseTo(10.95);
    const count = fake.requests.length;
    expect(await okx.fetchBasis('BTCUSDT')).toEqual(basis);
    expect(fake.requests).toHaveLength(count);
  });
});

describe('spot symbols rules cache isolation', () => {
  it('同币 spot/perp 规则各自缓存,spot minSz/lotSz 是币数量', async () => {
    const perp = await market.fetchExchangeInfo('perp');
    const spot = await market.fetchExchangeInfo('spot');
    expect(spot.find(s => s.symbol === 'BTCUSDT')).toMatchObject({ step_size: '0.00001', min_qty: '0.0001', min_notional: '8.14' });
    expect(perp.find(s => s.symbol === 'BTCUSDT')).toMatchObject({ step_size: '0.0001', min_notional: '8.14201' });
    const queries = fake.requests.filter(r => r.path.endsWith('/instruments')).map(r => r.query['instType']);
    expect(queries).toContain('SPOT'); expect(queries).toContain('SWAP');
  });
});

describe('K 线缓存与 429 熔断(评审版公网访客多标签页轮询)', () => {
  it('同一 (币, 周期, 根数) 在 TTL 内只出网一次;并发请求合并成一个(single-flight);返回的是拷贝', async () => {
    const [a, b] = await Promise.all([okx.fetchKlinesOkx('BTCUSDT', '1m', 5), okx.fetchKlinesOkx('BTCUSDT', '1m', 5)]);
    expect(fake.calls['/api/v5/market/candles']).toBe(1);
    expect(a).toEqual(b);
    const c = await okx.fetchKlinesOkx('BTCUSDT', '1m', 5);
    expect(fake.calls['/api/v5/market/candles']).toBe(1);
    c[0]!.close = 'mutated';
    const d = await okx.fetchKlinesOkx('BTCUSDT', '1m', 5);
    expect(d[0]!.close).not.toBe('mutated');
    // 不同根数 / 周期是不同的键
    await okx.fetchKlinesOkx('BTCUSDT', '1m', 6);
    await okx.fetchKlinesOkx('BTCUSDT', '5m', 5);
    expect(fake.calls['/api/v5/market/candles']).toBe(3);
  });

  it('TTL 过了重新出网;TG_OKX_KLINE_TTL_MS=0 关缓存', async () => {
    process.env['TG_OKX_KLINE_TTL_MS'] = '0';
    try {
      await okx.fetchKlinesOkx('ETHUSDT', '1m', 3);
      await okx.fetchKlinesOkx('ETHUSDT', '1m', 3);
      expect(fake.calls['/api/v5/market/candles']).toBe(2);
    } finally {
      delete process.env['TG_OKX_KLINE_TTL_MS'];
    }
  });

  it('429 之后同一端点熔断:窗口内不再出网;有旧 K 线就沿用,没有就报限频', async () => {
    process.env['TG_OKX_KLINE_TTL_MS'] = '0'; // 让每次都想出网,才能看出熔断
    try {
      const fresh = await okx.fetchKlinesOkx('BTCUSDT', '1m', 5);
      fake.failStatus['/api/v5/market/candles'] = 429;
      // 第一次撞 429:有 60s 内的旧数据 → 沿用
      expect(await okx.fetchKlinesOkx('BTCUSDT', '1m', 5)).toEqual(fresh);
      expect(fake.calls['/api/v5/market/candles']).toBe(2);
      // 熔断中:别的币也不出网,没有旧数据 → 报限频
      await expect(okx.fetchKlinesOkx('ETHUSDT', '1m', 5)).rejects.toThrow(/429/);
      expect(fake.calls['/api/v5/market/candles']).toBe(2);
      // 已有旧数据的照样沿用
      expect(await okx.fetchKlinesOkx('BTCUSDT', '1m', 5)).toEqual(fresh);
      expect(fake.calls['/api/v5/market/candles']).toBe(2);
      // 其它端点不受这个端点的熔断影响
      await okx.fetchTicker24hOkx('BTCUSDT');
      expect(fake.calls['/api/v5/market/tickers']).toBe(1);
    } finally {
      delete process.env['TG_OKX_KLINE_TTL_MS'];
    }
  });

  it('熔断到期后恢复出网', async () => {
    process.env['TG_OKX_KLINE_TTL_MS'] = '0';
    process.env['TG_OKX_429_COOLDOWN_MS'] = '50';
    try {
      fake.failStatus['/api/v5/market/candles'] = 429;
      await expect(okx.fetchKlinesOkx('SOLUSDT', '1m', 3)).rejects.toThrow(/429/);
      delete fake.failStatus['/api/v5/market/candles'];
      await new Promise((r) => setTimeout(r, 80));
      expect(await okx.fetchKlinesOkx('SOLUSDT', '1m', 3)).toHaveLength(3);
      expect(fake.calls['/api/v5/market/candles']).toBe(2);
    } finally {
      delete process.env['TG_OKX_KLINE_TTL_MS'];
      delete process.env['TG_OKX_429_COOLDOWN_MS'];
    }
  });
});

describe('出网令牌桶(事件触发同一毫秒对十来个币拉 K 线)', () => {
  it('突发请求排队等令牌、全部成功,不会撞 429;节流按端点计', async () => {
    process.env['TG_OKX_KLINE_TTL_MS'] = '0';
    process.env['TG_OKX_RATE_CANDLES'] = '20'; // 突发容量 20、之后 20/s
    try {
      const syms = ['BTCUSDT', 'ETHUSDT'];
      const started = Date.now();
      // 26 个并发请求:前 20 个立刻出网,后 6 个按 50ms 间隔排队 → 总耗时 ≥ ~300ms
      const jobs = Array.from({ length: 26 }, (_, i) => okx.fetchKlinesOkx(syms[i % 2]!, '1m', 2 + i));
      const out = await Promise.all(jobs);
      const elapsed = Date.now() - started;
      expect(out.every((ks) => ks.length > 0)).toBe(true);
      expect(fake.calls['/api/v5/market/candles']).toBe(26);
      expect(elapsed).toBeGreaterThanOrEqual(250);
    } finally {
      delete process.env['TG_OKX_KLINE_TTL_MS'];
      delete process.env['TG_OKX_RATE_CANDLES'];
    }
  });

  it('预计排队超过上限就直接按限频失败,不出网', async () => {
    process.env['TG_OKX_KLINE_TTL_MS'] = '0';
    process.env['TG_OKX_RATE_CANDLES'] = '1';
    process.env['TG_OKX_RATE_MAX_WAIT_MS'] = '100';
    try {
      await okx.fetchKlinesOkx('BTCUSDT', '1m', 2); // 用掉唯一的令牌
      await expect(okx.fetchKlinesOkx('ETHUSDT', '1m', 2)).rejects.toThrow(/本机节流/);
      expect(fake.calls['/api/v5/market/candles']).toBe(1);
    } finally {
      delete process.env['TG_OKX_KLINE_TTL_MS'];
      delete process.env['TG_OKX_RATE_CANDLES'];
      delete process.env['TG_OKX_RATE_MAX_WAIT_MS'];
    }
  });

  it('TG_OKX_RATE_CANDLES=0 不节流', async () => {
    process.env['TG_OKX_KLINE_TTL_MS'] = '0';
    process.env['TG_OKX_RATE_CANDLES'] = '0';
    try {
      const started = Date.now();
      await Promise.all(Array.from({ length: 30 }, (_, i) => okx.fetchKlinesOkx('BTCUSDT', '1m', 2 + i)));
      expect(fake.calls['/api/v5/market/candles']).toBe(30);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      delete process.env['TG_OKX_KLINE_TTL_MS'];
      delete process.env['TG_OKX_RATE_CANDLES'];
    }
  });
});
