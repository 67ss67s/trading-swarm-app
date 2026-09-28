import { exchange } from './market.js';
import { loadOkxInstruments } from './market-okx.js';
/** watchlist 没有 market 维度，先用官方 instrument 类型过滤；不影响既有持仓/线程对账。 */
export async function spotWatchlist(symbols: string[]): Promise<Set<string>> {
  if (exchange() !== 'okx') return new Set(symbols);
  const available = new Set((await loadOkxInstruments(false, 'spot')).map(row => row.symbol));
  return new Set(symbols.filter(symbol => available.has(symbol)));
}
