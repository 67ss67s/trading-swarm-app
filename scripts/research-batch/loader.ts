/** 从批量研究冻结的 JSON 给改进环 / 全窗口报告喂数据(不联网):现货直接给 K 线,永续另给资金费(标记价缺,1 倍不触发强平)。 */
import type { BarsLoader } from '../../packages/gateway/src/demo/research/backtest-report.ts';
import type { PerpMarket } from '../../packages/gateway/src/demo/research/data/perp-market.ts';
import { readFrozen } from './common.ts';

export function frozenLoader(market: 'spot' | 'perp'): BarsLoader {
  return async (symbol, tf, w) => {
    const f = readFrozen(symbol, tf, market); if (!f) throw Error(`DATA_MISSING:批量研究没有冻结 ${symbol} ${tf} ${market}`);
    const bars = f.bars.filter((b) => b.open_time >= w.from_ms && b.close_time <= w.to_ms);
    if (market === 'spot') return { bars, source: `batch-frozen:${f.source}` };
    const inst = symbol.replace(/USDT$/, '') + '-USDT-SWAP', funding = f.funding ?? { points: [], from_ms: w.from_ms, to_ms: w.from_ms - 1 };
    const perp = { inst_id: inst, timeframe: tf, bars, mark: bars.map(() => null), funding, funding_provenance: { coverage: funding.points.length ? 'complete' : 'missing', from_ms: null, to_ms: null, okx: null, proxy: null, proxy_until_ms: null, note: f.funding_note ?? '', notes: [], gaps: [], segments: [], okx_archive: { final: [], missing: [] }, deviation: null, deviation_note: '见批量研究取数' }, tiers: [], lever_tiers: [], max_lever: null, provenance: { source: f.source, version: 'batch-frozen', trade_coverage: null, mark_coverage: null, mark_missing_bars: bars.length, flags: ['mark_not_fetched'], notes: [], requests: 0 } } as unknown as PerpMarket;
    return { bars, source: `batch-frozen:${f.source}`, perp };
  };
}
