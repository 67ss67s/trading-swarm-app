// OKX v5 公共 REST 的本地替身(docs/design/okx-atk-2026-09-20.md §3)。
//
// 为什么要真起一个 node:http 服务而不是 mock fetch:market-okx.ts 里那些「分页、after 语义、
// 新→旧顺序、300 条上限」全是**协议行为**,用假 fetch 桩只会把我们自己的假设再写一遍;
// 真服务器能让 after/limit 这类边界被服务端真正执行一次(和 fake-market-server.ts 同思路)。
//
// 不是 OKX 的行为仿真,只把被测代码需要的形状喂足:外层统一 {"code":"0","msg":"","data":[...]},
// K 线/OI 历史/资金费历史一律**新→旧**,数字都由 ts 确定性推出来,所以翻 300 根以上可断言。

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeOkxRequest {
  path: string;
  query: Record<string, string>;
}

export interface FakeOkxServer {
  url: string;
  /** K 线锚点:最新一根的 open_time(周对齐,所以 1m~1w 每种 bar 都正好落格)。 */
  anchorTs: number;
  /** 每条 v5 路径被打了几次——分页断言靠它。 */
  calls: Record<string, number>;
  /** 收到的请求(含 query),断言 bar/limit/after 透传用。 */
  requests: FakeOkxRequest[];
  resetCalls(): void;
  close(): Promise<void>;
}

export interface FakeOkxOptions {
  /** 最新一根 K 线的 open_time;默认 1789603200000(可被 604800000 整除)。 */
  anchorTs?: number;
  /** 每种 bar 一共有多少根历史,默认 1000(够翻 700 根)。 */
  totalCandles?: number;
  /** BTC 基准价。 */
  basePrice?: number;
  candleWick?: number;
  /**
   * `/market/candles` 只回最近多少根(真 OKX 是 1440,再老只有 `/market/history-candles` 有);
   * 默认不限。设了之后超出窗口的页返回空数组——真 OKX 就是这么静默返空的。
   */
  candleWindow?: number;
  missingBasisSide?: 'spot' | 'perp';
}

/** 周对齐 → 1m/5m/15m/1H/4H/1Dutc/1Wutc 全部整除,K 线 ts 不会出现半格。 */
const DEFAULT_ANCHOR = 1_789_603_200_000;

const BAR_MS: Record<string, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1H': 3_600_000, '2H': 7_200_000, '4H': 14_400_000, '6H': 21_600_000, '12H': 43_200_000,
  '1Dutc': 86_400_000, '3Dutc': 259_200_000, '1Wutc': 604_800_000,
};

/** OKX 单次 candles 上限(超过它服务端自己截,被测代码必须自己分页)。 */
const CANDLE_PAGE_CAP = 300;
/** 归档端点 history-candles 的单页上限只有 100。 */
const HISTORY_PAGE_CAP = 100;
/** 资金费历史单页上限。 */
const FUNDING_PAGE_CAP = 100;

/** `/api/v5/public/instruments?instType=SWAP` 的行(字段名与真实返回一致,只留用得到的)。 */
interface FakeInstrument {
  instType: string;
  instId: string;
  instFamily: string;
  uly: string;
  ctType: string;
  ctVal: string;
  ctValCcy: string;
  lotSz: string;
  minSz: string;
  tickSz: string;
  settleCcy: string;
  state: string;
}

/** 真实取值(2026-09-20 从 www.okx.com 拉的)。后两行故意不合格,用来验 parseInstruments 的筛子。 */
export const FAKE_INSTRUMENTS: FakeInstrument[] = [
  { instType: 'SWAP', instId: 'BTC-USDT-SWAP', instFamily: 'BTC-USDT', uly: 'BTC-USDT', ctType: 'linear', ctVal: '0.01', ctValCcy: 'BTC', lotSz: '0.01', minSz: '0.01', tickSz: '0.1', settleCcy: 'USDT', state: 'live' },
  { instType: 'SWAP', instId: 'ETH-USDT-SWAP', instFamily: 'ETH-USDT', uly: 'ETH-USDT', ctType: 'linear', ctVal: '0.1', ctValCcy: 'ETH', lotSz: '0.01', minSz: '0.01', tickSz: '0.01', settleCcy: 'USDT', state: 'live' },
  { instType: 'SWAP', instId: 'XRP-USDT-SWAP', instFamily: 'XRP-USDT', uly: 'XRP-USDT', ctType: 'linear', ctVal: '100', ctValCcy: 'XRP', lotSz: '0.01', minSz: '0.01', tickSz: '0.0001', settleCcy: 'USDT', state: 'live' },
  // 反向合约:settleCcy=BTC、ctType=inverse —— 必须被过滤掉。
  { instType: 'SWAP', instId: 'BTC-USD-SWAP', instFamily: 'BTC-USD', uly: 'BTC-USD', ctType: 'inverse', ctVal: '100', ctValCcy: 'USD', lotSz: '0.1', minSz: '0.1', tickSz: '0.1', settleCcy: 'BTC', state: 'live' },
  // 下架中:state=suspend —— 必须被过滤掉。
  { instType: 'SWAP', instId: 'DOGE-USDT-SWAP', instFamily: 'DOGE-USDT', uly: 'DOGE-USDT', ctType: 'linear', ctVal: '1000', ctValCcy: 'DOGE', lotSz: '0.01', minSz: '0.01', tickSz: '0.00001', settleCcy: 'USDT', state: 'suspend' },
];

export const FAKE_SPOT_INSTRUMENTS = ['BTC', 'ETH', 'XRP'].map(baseCcy => ({ instType: 'SPOT', instId: `${baseCcy}-USDT`, baseCcy, quoteCcy: 'USDT', lotSz: '0.00001', minSz: '0.0001', tickSz: '0.1', state: 'live' }));

/** 合格行数(测试断言用,改上面表不用改测试)。 */
export const QUALIFYING_INSTRUMENTS = FAKE_INSTRUMENTS.filter(
  (i) => i.instType === 'SWAP' && i.ctType === 'linear' && i.settleCcy === 'USDT' && i.state === 'live',
).length;

/** instId → 24h 行情的基准数;last/open24h 差值固定,涨跌幅可以在测试里手算。 */
const TICKER: Record<string, { last: string; open24h: string; high24h: string; low24h: string; volCcy24h: string; vol24h: string }> = {
  'BTC-USDT': { last: '81400', open24h: '81000', high24h: '81900', low24h: '80800', volCcy24h: '1000000', vol24h: '12' },
  'BTC-USDT-SWAP': { last: '81420.1', open24h: '81009.9', high24h: '81930', low24h: '80806.3', volCcy24h: '48910.5325', vol24h: '4891053.25' },
  'ETH-USDT-SWAP': { last: '3120.55', open24h: '3200.11', high24h: '3240.9', low24h: '3090.4', volCcy24h: '310250.7', vol24h: '3102507' },
  'XRP-USDT-SWAP': { last: '2.1234', open24h: '2.0011', high24h: '2.2', low24h: '1.99', volCcy24h: '91000000', vol24h: '910000' },
  'BTC-USD-SWAP': { last: '81430.2', open24h: '81020.1', high24h: '81940', low24h: '80810.2', volCcy24h: '1234.5', vol24h: '1005000' },
};

export function startFakeOkxServer(opts: FakeOkxOptions = {}): Promise<FakeOkxServer> {
  const anchorTs = opts.anchorTs ?? DEFAULT_ANCHOR;
  const total = opts.totalCandles ?? 1000;
  const basePrice = opts.basePrice ?? 81_000;
  const calls: Record<string, number> = {};
  const requests: FakeOkxRequest[] = [];

  /**
   * 第 age 根(0 = 最新)的一行 candle:`[ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm]`。
   * 全部由 age 推出来,所以同一个 ts 无论出现在第几页,值都一样(能验重复/漏页)。
   * vol(张)与 volCcy(币)刻意差 100 倍(BTC ctVal=0.01),这样「取 index 6 而不是 5」是可证的。
   */
  const candle = (age: number, ts: number): string[] => {
    const close = basePrice - age * 0.5;
    const open = close + 0.3;
    const high = Math.max(open, close) + (opts.candleWick ?? 1.2);
    const low = Math.min(open, close) - (opts.candleWick ?? 1.2);
    const vol = 100 + (age % 37); // 张
    const volCcy = vol * 0.01; // 币
    return [
      String(ts), open.toFixed(1), high.toFixed(1), low.toFixed(1), close.toFixed(1),
      vol.toFixed(2), volCcy.toFixed(4), (volCcy * close).toFixed(4), age === 0 ? '0' : '1',
    ];
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const send = (data: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: '0', msg: '', data }));
      };
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const q = Object.fromEntries(url.searchParams.entries());
        const path = url.pathname;
        calls[path] = (calls[path] ?? 0) + 1;
        requests.push({ path, query: q });
        const instId = q['instId'] ?? 'BTC-USDT-SWAP';
        const now = anchorTs + 30_000;

        if (path === '/api/v5/market/candles' || path === '/api/v5/market/history-candles') {
          const ms = BAR_MS[q['bar'] ?? '1m'] ?? 60_000;
          const history = path.endsWith('history-candles');
          const limit = Math.min(history ? HISTORY_PAGE_CAP : CANDLE_PAGE_CAP, Math.max(1, Number(q['limit'] ?? '100')));
          const after = q['after'] ? Number(q['after']) : null;
          // 归档端点服务全量序列;candles 超出 candleWindow 就静默返空(真 OKX 行为)。
          const depth = history ? total : Math.min(total, opts.candleWindow ?? total);
          const rows: string[][] = [];
          for (let age = 0; age < depth && rows.length < limit; age++) {
            const ts = anchorTs - age * ms;
            if (after !== null && ts >= after) continue; // OKX:after 是严格小于
            rows.push(candle(age, ts));
          }
          return send(rows); // 新→旧
        }

        if (path === '/api/v5/public/mark-price') {
          if (opts.missingBasisSide === 'perp') return send([]);
          return send([{ instType: 'SWAP', instId, markPx: '81423.5', ts: String(now) }]);
        }

        if (path === '/api/v5/public/funding-rate') {
          return send([{
            instType: 'SWAP', instId, fundingRate: '0.0001', realizedRate: '0.0001',
            fundingTime: String(anchorTs + 3_600_000), nextFundingTime: String(anchorTs + 32_400_000),
            method: 'current_period', settState: 'settled', ts: String(now),
          }]);
        }

        if (path === '/api/v5/market/index-tickers') {
          // 批量(quoteCcy=USDT,无 instId)按 family 返回;单查按 instId
          return send([{ instId: q['instId'] ?? 'BTC-USDT', idxPx: '81455', high24h: '81950.9', low24h: '80845.6', open24h: '81044.8', ts: String(now) }]);
        }

        if (path === '/api/v5/public/open-interest') {
          // oi = 张,oiCcy = 币,oiUsd = U;被测代码必须取 oiCcy。
          return send([{ instType: 'SWAP', instId, oi: '3092131.7', oiCcy: '30921.317', oiUsd: '2517724946.88', ts: String(now) }]);
        }

        if (path === '/api/v5/rubik/stat/contracts/open-interest-history') {
          const period = q['period'] ?? '5m';
          const ms = BAR_MS[period] ?? 300_000;
          const limit = Math.min(100, Math.max(1, Number(q['limit'] ?? '100')));
          const rows: string[][] = [];
          for (let age = 0; age < limit; age++) {
            const ts = anchorTs - age * ms;
            const oi = 3_092_000 + age; // 张
            rows.push([String(ts), String(oi), (oi / 100).toFixed(4), (oi * 814.2).toFixed(2)]);
          }
          return send(rows); // [ts, oi, oiCcy, oiUsd],新→旧
        }

        if (path === '/api/v5/public/funding-rate-history') {
          const limit = Math.min(FUNDING_PAGE_CAP, Math.max(1, Number(q['limit'] ?? '100')));
          const after = q['after'] ? Number(q['after']) : null;
          const rows: Record<string, string>[] = [];
          for (let age = 0; age < 400 && rows.length < limit; age++) {
            const ts = anchorTs - age * 28_800_000; // 8h 一结
            if (after !== null && ts >= after) continue;
            rows.push({
              instType: 'SWAP', instId, fundingTime: String(ts),
              // realizedRate 与 fundingRate 刻意不同:被测代码必须优先用 realizedRate。
              fundingRate: '0.0001',
              realizedRate: (0.00005 + age * 0.0000001).toFixed(8),
              method: 'current_period',
            });
          }
          return send(rows); // 新→旧
        }

        if (path === '/api/v5/market/ticker') {
          if (opts.missingBasisSide === 'spot' && !instId.endsWith('-SWAP')) return send([]);
          const t = TICKER[instId] ?? TICKER['BTC-USDT-SWAP']!;
          return send([{ instType: instId.endsWith('-SWAP') ? 'SWAP' : 'SPOT', instId, ...t, ts: String(now) }]);
        }

        if (path === '/api/v5/market/tickers') {
          if (q['instType'] === 'SPOT') return send(FAKE_SPOT_INSTRUMENTS.map(i => ({ instType: 'SPOT', instId: i.instId, ...(TICKER[i.instId] ?? TICKER['BTC-USDT']!), ts: String(now) })));
          return send(FAKE_INSTRUMENTS.map((i) => ({ instType: 'SWAP', instId: i.instId, ...(TICKER[i.instId] ?? TICKER['BTC-USDT-SWAP']!), ts: String(now) })));
        }

        if (path === '/api/v5/public/instruments') {
          if (q['instType'] === 'SPOT') return send(FAKE_SPOT_INSTRUMENTS);
          if (q['instType'] !== 'SWAP') return send([]);
          return send(FAKE_INSTRUMENTS);
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ code: '51001', msg: `no fake route for ${req.url}`, data: [] }));
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        anchorTs,
        calls,
        requests,
        resetCalls: () => {
          for (const k of Object.keys(calls)) delete calls[k];
          requests.length = 0;
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
