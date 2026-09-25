// OKX 符号与数量换算的单测(docs/design/okx-atk-2026-09-20.md §2 / §4)。
//
// 这层是纯函数,但它算的是**要发给交易所的 sz**:一个 0.1+0.2 的浮点噪声就会被 OKX 当参数错拒单,
// 或者多下一张变成超额敞口。所以这里盯的不是「大概对」,是**精确到最后一位**和「向下取整」这条规则。

import { beforeEach, describe, expect, it } from 'vitest';
import {
  addDec,
  cachedInstruments,
  contractsToQty,
  negDec,
  decimalsOf,
  floorToStep,
  instrumentOf,
  instIdToSymbol,
  mulDec,
  numToDec,
  parseInstruments,
  qtyToContracts,
  resetInstruments,
  rulesOf,
  setInstruments,
  symbolInfoOf,
  symbolToInstId,
  toClOrdId,
  type OkxInstrument,
} from '../../src/demo/okx/instruments.js';
import { threadClientPrefix } from '../../src/demo/threads.js';
import { FAKE_INSTRUMENTS, QUALIFYING_INSTRUMENTS } from './helpers/fake-okx-server.js';

const BTC: OkxInstrument = { symbol: 'BTCUSDT', instId: 'BTC-USDT-SWAP', instFamily: 'BTC-USDT', ctVal: '0.01', ctValCcy: 'BTC', lotSz: '0.01', minSz: '0.01', tickSz: '0.1', state: 'live' };
const XRP: OkxInstrument = { symbol: 'XRPUSDT', instId: 'XRP-USDT-SWAP', instFamily: 'XRP-USDT', ctVal: '100', ctValCcy: 'XRP', lotSz: '0.01', minSz: '0.01', tickSz: '0.0001', state: 'live' };
const ETH: OkxInstrument = { symbol: 'ETHUSDT', instId: 'ETH-USDT-SWAP', instFamily: 'ETH-USDT', ctVal: '0.1', ctValCcy: 'ETH', lotSz: '0.01', minSz: '0.01', tickSz: '0.01', state: 'live' };

beforeEach(() => {
  resetInstruments(); // 模块级缓存表,用例之间必须清干净
});

describe('十进制小工具', () => {
  it('decimalsOf 按字符串位数算,不碰浮点', () => {
    expect(decimalsOf('0.001')).toBe(3);
    expect(decimalsOf('0.00001')).toBe(5);
    expect(decimalsOf('1')).toBe(0);
    expect(decimalsOf('100')).toBe(0);
    expect(decimalsOf('0.1')).toBe(1);
  });

  it('mulDec 精确乘并去尾零', () => {
    expect(mulDec('0.01', '0.01')).toBe('0.0001');
    expect(mulDec('100', '0.01')).toBe('1');
    expect(mulDec('0.1', '3')).toBe('0.3'); // 浮点会给 0.30000000000000004
    expect(mulDec('0.1', '0.2')).toBe('0.02');
    expect(mulDec('1.005', '1000')).toBe('1005');
  });

  it('floorToStep 是 BigInt 的整个理由:0.29/0.01 在浮点下是 28.999…', () => {
    expect(floorToStep('0.29', '0.01')).toBe('0.29');
    expect(floorToStep('1.005', '0.001')).toBe('1.005');
    expect(floorToStep('8.7', '0.1')).toBe('8.7');
    expect(floorToStep('0.299', '0.01')).toBe('0.29');
    expect(floorToStep('0.009', '0.01')).toBe('0');
    expect(floorToStep('7', '1')).toBe('7');
    // 负数要往下推一格(BigInt 除法向零截断)
    expect(floorToStep('-0.291', '0.01')).toBe('-0.3');
    // step 非正 → 原样(去尾零)
    expect(floorToStep('1.2300', '0')).toBe('1.23');
  });

  it('numToDec 把指数写法摊开(BigInt 解析不了 1e-7)', () => {
    expect(numToDec(1e-7)).toBe('0.0000001');
    expect(numToDec(0.013)).toBe('0.013');
    expect(numToDec(Number.NaN)).toBe('0');
  });
});

describe('符号映射', () => {
  it('instId / family → 规范符号,去掉 -SWAP 与全部连字符', () => {
    expect(instIdToSymbol('BTC-USDT-SWAP')).toBe('BTCUSDT');
    expect(instIdToSymbol('BTC-USDT')).toBe('BTCUSDT');
    expect(instIdToSymbol('1000PEPE-USDT-SWAP')).toBe('1000PEPEUSDT');
    // 多段(交割合约那种 family)也一路拼平
    expect(instIdToSymbol('BTC-USDT-251226')).toBe('BTCUSDT251226');
  });

  it('符号 → instId:表为空时走 <BASE>-USDT-SWAP 的硬拼兜底', () => {
    expect(cachedInstruments()).toHaveLength(0);
    expect(symbolToInstId('BTCUSDT')).toBe('BTC-USDT-SWAP');
    expect(symbolToInstId('1000PEPEUSDT')).toBe('1000PEPE-USDT-SWAP');
    // 不带 USDT 后缀时不乱切
    expect(symbolToInstId('BTC')).toBe('BTC-USDT-SWAP');
  });

  it('表里有就以表为准(硬拼规则猜不到的命名只能靠表)', () => {
    const odd: OkxInstrument = { ...XRP, symbol: 'NEIROUSDT', instId: 'NEIROETH-USDT-SWAP', instFamily: 'NEIROETH-USDT' };
    setInstruments([BTC, odd]);
    expect(symbolToInstId('NEIROUSDT')).toBe('NEIROETH-USDT-SWAP');
    expect(symbolToInstId('BTCUSDT')).toBe('BTC-USDT-SWAP');
    // instrumentOf 两边都能查(符号或 instId)
    expect(instrumentOf('BTCUSDT')?.instId).toBe('BTC-USDT-SWAP');
    expect(instrumentOf('BTC-USDT-SWAP')?.symbol).toBe('BTCUSDT');
    expect(instrumentOf('NOPEUSDT')).toBeNull();
  });
});

describe('币 ↔ 张数', () => {
  it('0.013 BTC / ctVal 0.01 = 1.3 张(lotSz 0.01)', () => {
    expect(qtyToContracts('0.013', BTC)).toBe('1.3');
    expect(qtyToContracts(0.013, BTC)).toBe('1.3');
  });

  it('向下取整,不四舍五入:多一张是超敞口,少一张只是少赚', () => {
    expect(qtyToContracts('0.0139999', BTC)).toBe('1.39');
    expect(qtyToContracts('0.29', BTC)).toBe('29'); // 浮点会给 28
  });

  it('不足一手直接归零(调用方自己去撞 min_qty 闸)', () => {
    expect(qtyToContracts('0.00005', BTC)).toBe('0');
    expect(qtyToContracts('0', BTC)).toBe('0');
    expect(qtyToContracts('0.5', XRP)).toBe('0'); // ctVal 100:半个 XRP 连 0.01 张都不到
  });

  it('张 → 币是精确乘 ctVal', () => {
    expect(contractsToQty('1.3', BTC)).toBe('0.013');
    expect(contractsToQty(3, XRP)).toBe('300');
    expect(contractsToQty('0.01', XRP)).toBe('1');
    expect(contractsToQty('12.34', ETH)).toBe('1.234');
  });

  it('往返:qty → 张 → qty 回到 step 的整数倍', () => {
    for (const [inst, qty, back] of [
      [BTC, '0.013', '0.013'],
      [BTC, '1.2345', '1.2345'],
      [BTC, '0.0139999', '0.0139'],
      [XRP, '12345', '12345'], // step = 100×0.01 = 1 → 整数个 XRP 原样回来
      [XRP, '12345.6', '12345'], // 不足一个 step 的尾巴被砍掉
      [ETH, '0.55', '0.55'],
    ] as const) {
      const sz = qtyToContracts(qty, inst);
      const q2 = contractsToQty(sz, inst);
      expect(Number(q2)).toBeLessThanOrEqual(Number(qty));
      expect(q2).toBe(back);
    }
  });
});

describe('symbolInfoOf / rulesOf', () => {
  it('step=ctVal×lotSz,min_qty=ctVal×minSz,tick=tickSz,精度由小数位推', () => {
    const info = symbolInfoOf(BTC, '81420.1');
    expect(info.symbol).toBe('BTCUSDT');
    expect(info.status).toBe('TRADING');
    expect(info.step_size).toBe('0.0001'); // 0.01 × 0.01
    expect(info.min_qty).toBe('0.0001');
    expect(info.tick_size).toBe('0.1');
    expect(info.price_precision).toBe(1); // decimalsOf('0.1')
    expect(info.qty_precision).toBe(4); // decimalsOf('0.0001')
    // min_notional = min_qty × 最新价,保留十进制精度
    expect(info.min_notional).toBe('8.14201');
  });

  it('ctVal 大的合约:XRP step = 100×0.01 = 1', () => {
    const info = symbolInfoOf(XRP, '2.1234');
    expect(info.step_size).toBe('1');
    expect(info.min_qty).toBe('1');
    expect(info.qty_precision).toBe(0);
    expect(info.price_precision).toBe(4);
    expect(info.min_notional).toBe('2.1234');
  });

  it('拿不到价、价为 0、或算出来是 0 → 退回 5', () => {
    expect(symbolInfoOf(BTC).min_notional).toBe('5');
    expect(symbolInfoOf(BTC, null).min_notional).toBe('5');
    expect(symbolInfoOf(BTC, '0').min_notional).toBe('5');
    expect(symbolInfoOf(BTC, '0.0001').min_notional).toBe('0.00000001'); // 0.0001×0.0001 → '0.00' → 兜底
  });

  it('非 live 的 state 原样透出去(不伪装成 TRADING)', () => {
    expect(symbolInfoOf({ ...BTC, state: 'suspend' }, '81420.1').status).toBe('suspend');
  });

  it('rulesOf 就是 SymbolInfo 的四件套', () => {
    expect(rulesOf(BTC, '81420.1')).toEqual({ step_size: '0.0001', tick_size: '0.1', min_qty: '0.0001', min_notional: '8.14201' });
  });
});

describe('parseInstruments 筛子', () => {
  it('只收 SWAP + linear + USDT 结算 + live', () => {
    const rows = parseInstruments(FAKE_INSTRUMENTS);
    expect(rows).toHaveLength(QUALIFYING_INSTRUMENTS);
    const ids = rows.map((r) => r.instId);
    expect(ids).toContain('BTC-USDT-SWAP');
    expect(ids).toContain('XRP-USDT-SWAP');
    expect(ids).not.toContain('BTC-USD-SWAP'); // inverse / settleCcy=BTC
    expect(ids).not.toContain('DOGE-USDT-SWAP'); // state=suspend
    expect(rows.map((r) => r.symbol)).toEqual(expect.arrayContaining(['BTCUSDT', 'ETHUSDT', 'XRPUSDT']));
  });

  it('逐条筛:换掉任一必要条件就出局', () => {
    const base = FAKE_INSTRUMENTS[0]!;
    expect(parseInstruments([{ ...base, instType: 'FUTURES' }])).toHaveLength(0);
    expect(parseInstruments([{ ...base, ctType: 'inverse' }])).toHaveLength(0);
    expect(parseInstruments([{ ...base, settleCcy: 'USDC' }])).toHaveLength(0);
    expect(parseInstruments([{ ...base, state: 'preopen' }])).toHaveLength(0);
    expect(parseInstruments([{ ...base, instId: '' }])).toHaveLength(0);
    expect(parseInstruments([base])).toHaveLength(1);
  });

  it('非数组 / 缺字段不炸:缺 instFamily 就从 instId 推', () => {
    expect(parseInstruments(null)).toEqual([]);
    expect(parseInstruments({ nope: 1 })).toEqual([]);
    const [row] = parseInstruments([{ instType: 'SWAP', ctType: 'linear', settleCcy: 'USDT', state: 'live', instId: 'SOL-USDT-SWAP' }]);
    expect(row?.symbol).toBe('SOLUSDT');
    expect(row?.instFamily).toBe('SOL-USDT');
    expect(row?.ctVal).toBe('1'); // 缺省
    expect(row?.lotSz).toBe('1');
  });
});

describe('toClOrdId', () => {
  it('只留字母数字', () => {
    expect(toClOrdId('tgd-0123456789ab-e1')).toBe('tgd0123456789abe1');
    expect(toClOrdId('a_b.c-d/e f')).toBe('abcdef');
  });

  it('截到 32 位', () => {
    const long = 'tgd-' + 'a'.repeat(40) + '-e1';
    const out = toClOrdId(long);
    expect(out).toHaveLength(32);
    expect(out).toBe('tgd' + 'a'.repeat(29));
  });

  it('结果永远是 OKX 允许的字符集且 ≤32', () => {
    for (const cid of ['tgd-0123456789ab-e1', 'tgd-ffffffffffff-r128', 'tg-x-y-z', 'x'.repeat(100)]) {
      const out = toClOrdId(cid);
      expect(out).toMatch(/^[A-Za-z0-9]*$/);
      expect(out.length).toBeLessThanOrEqual(32);
    }
  });

  // 这条是 §4 点名要证的:去掉连字符之后两个不同的内部 CID 不能撞到同一个 clOrdId。
  // 内部 CID 的唯一来源是 threads.ts 的 nextLegCid:`tgd-<12 位 hex>-<leg><seq>`,
  // 三段定长/定位(前缀 3 + hex 12 恒定,leg 单字符),所以映射在这个字符集内是单射。
  it('在 nextLegCid 的字符集内是单射(大样本反证)', () => {
    const legs = ['e', 's', 't', 'x', 'r'] as const;
    const seen = new Map<string, string>();
    let n = 0;
    for (let i = 0; i < 400; i++) {
      const prefix = threadClientPrefix(`thread-${i}-${i * 7919}`);
      expect(prefix).toMatch(/^tgd-[0-9a-f]{12}$/); // 前提:前缀确实是定长 hex
      for (const leg of legs) {
        for (const seq of [1, 2, 9, 10, 37, 128, 999]) {
          const cid = `${prefix}-${leg}${seq}`;
          const out = toClOrdId(cid);
          expect(out.length).toBeLessThanOrEqual(32); // 定长前缀 15 + 1 + seq,永不触顶
          const prev = seen.get(out);
          expect(prev === undefined || prev === cid).toBe(true);
          seen.set(out, cid);
          n++;
        }
      }
    }
    expect(seen.size).toBe(n); // 无碰撞
  });

  it('同一个内部 CID 算两次结果相同(getOrder/cancelOrder 靠正算而不是反解)', () => {
    const cid = `${threadClientPrefix('t-42')}-s3`;
    expect(toClOrdId(cid)).toBe(toClOrdId(cid));
  });
});

// review #12:结算的手续费/资金费用十进制字符串算,不走浮点。
describe('十进制加法与取负', () => {
  it('addDec 不引入浮点噪声', () => {
    expect(addDec('0.1', '0.2')).toBe('0.3');
    expect(addDec('-0.12', '-0.08')).toBe('-0.2');
    expect(addDec('0', '-7')).toBe('-7');
    expect(addDec('1.00000001', '2')).toBe('3.00000001');
  });

  it('negDec 保号:负 fee(扣费)→ 正 commission,正 fee(返佣)→ 负 commission', () => {
    expect(negDec('-0.42')).toBe('0.42');
    expect(negDec('0.02')).toBe('-0.02');
    expect(negDec('0')).toBe('0');
    expect(negDec('-0.00000001')).toBe('0.00000001');
  });
});
