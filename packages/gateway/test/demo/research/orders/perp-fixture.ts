/** 永续回测测试共用:合成行情(几何随机游走)+ 合成永续取数(标记价 = 成交价,可加尖刺;每 8h 正费率资金费,2022 前标为币安代理)+ 跌破低点做空 3 倍 IR。只做工程验证。 */
import type { ResearchBar, StrategyIR } from '@trade-gate/contracts';
import type { BarsLoader } from '../../../../src/demo/research/backtest-report.js';
import type { PerpMarket } from '../../../../src/demo/research/data/perp-market.js';
import { toOrderBar } from '../../../../src/demo/research/orders/index.js';
import { node } from '../../../../src/demo/research/strategy.js';
import { synthBars } from '../backtest-report-fixtures.js';
const DAY = 86400000, H8 = 8 * 3600000;
export const data: Record<string, ResearchBar[]> = { BTCUSDT: synthBars(1500, DAY, 7, Date.UTC(2021, 0, 1)), ETHUSDT: synthBars(1500, DAY, 99, Date.UTC(2021, 0, 1), 50) };
/** 合成永续:成交价 = 合成 K 线;标记价 = 成交价(可在 spike 处把标记价高点拉高);资金费每 8h 一期,正费率(多付空收);两档分档 */
export function perpLoader(opts: { spikeAt?: number; rate?: number; calls?: string[] } = {}): BarsLoader {
  return async (symbol, tf, w) => {
    opts.calls?.push(symbol);
    const src = data[symbol]; if (!src) throw Error('DATA_MISSING');
    const bars = src.filter((x) => x.open_time >= w.from_ms && x.close_time <= w.to_ms);
    const mark = bars.map((b, i) => { const m = toOrderBar(b); return opts.spikeAt !== undefined && i === bars.length - opts.spikeAt ? { ...m, high: m.high * 1.6 } : m; });
    const points: { ts: number; rate: number; source: string }[] = []; for (let t = bars[0]!.open_time; t <= bars.at(-1)!.close_time; t += H8) points.push({ ts: t, rate: opts.rate ?? 0.0001, source: t < Date.UTC(2022, 0, 1) ? 'binance_proxy' : 'okx' });
    const split = points.findIndex((p) => p.source === 'okx');
    const inst = symbol.replace(/USDT$/, '') + '-USDT-SWAP';
    const m: PerpMarket = { inst_id: inst, timeframe: tf, bars, mark, funding: { points, from_ms: points[0]!.ts - H8 + 1, to_ms: points.at(-1)!.ts }, funding_provenance: { coverage: 'complete', from_ms: points[0]!.ts, to_ms: points.at(-1)!.ts, okx: { points: points.length - split, from_ms: points[split]!.ts, to_ms: points.at(-1)!.ts }, proxy: { points: split, from_ms: points[0]!.ts, to_ms: points[split - 1]!.ts, symbol }, proxy_until_ms: points[split - 1]!.ts, note: '2022-01 前资金费为币安代理', notes: [], gaps: [], segments: [{ source: 'binance_proxy', from_ms: points[0]!.ts, to_ms: points[split - 1]!.ts, points: split }, { source: 'okx_archive', from_ms: points[split]!.ts, to_ms: points.at(-1)!.ts, points: points.length - split }], okx_archive: { final: [], missing: [] }, deviation: null, deviation_note: '合成数据未计算' }, tiers: [{ max_qty: 1e9, mmr: 0.004 }], lever_tiers: [], max_lever: 100, provenance: { source: 'synthetic perp', version: 'test', trade_coverage: null, mark_coverage: null, mark_missing_bars: 0, flags: [], notes: [], requests: 0 } };
    return { bars, source: `okx:perp:${inst}:synthetic`, perp: m };
  };
}
export function shortIR(extra: Partial<NonNullable<StrategyIR['order']>> = {}): StrategyIR {
  return { version: 1, label: '跌破低点做空', description: '收盘跌破 20 根低点做空 3 倍;持有数天,每 1000 根约数十个信号', signal: [node('donchian_breakout', { lookback: 20, basis: 'close', direction: 'down' })], entry: node('next_open_market', {}), risk: { stop: node('swing_low_stop', { lookback: 10 }), sizing: node('equal_notional', { max_allocation: '1' }) }, exit: [], order: { direction: 'short', market: 'perp', leverage: 3, take_profits: [{ source: node('fixed_r_target', { r: 2 }) }], min_rr: 2, ...extra } };
}
