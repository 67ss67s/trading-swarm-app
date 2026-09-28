/**
 * 策略构建的数据集下拉框:从海选带进来一组时,选同一个币的数据集;本地没有就返回 null(界面明说),不拿别的币顶上。
 * 旧 bug:带入 BTC 4h,下拉框显示列表第一条 ETH-USDT-SWAP。
 */
import { describe, expect, it } from 'vitest';
import type { ResearchDatasetSummary } from '../src/api/research-types';
import { matchSeedDataset, normalizeSymbol } from '../src/components/research-workbench/seed-dataset';

const H4 = 14_400_000, H1 = 3_600_000;
const ds = (id: string, symbol: string, timeframe_ms: number, market: string = 'spot'): ResearchDatasetSummary =>
  ({ id, created_at: 0, venue: 'okx', market, symbol, source: '', timeframe_ms, bars: 100 }) as unknown as ResearchDatasetSummary;

describe('normalizeSymbol', () => {
  it('treats OKX instIds and plain symbols the same', () => {
    expect(normalizeSymbol('BTC-USDT-SWAP')).toBe('BTCUSDT');
    expect(normalizeSymbol('btc/usdt')).toBe('BTCUSDT');
    expect(normalizeSymbol('BTCUSDT')).toBe('BTCUSDT');
  });
});

describe('matchSeedDataset', () => {
  it('picks the brought-in coin, not the first dataset in the list', () => {
    const list = [ds('eth', 'ETH-USDT-SWAP', H4, 'perp'), ds('btc', 'BTC-USDT-SWAP', H4, 'perp')];
    expect(matchSeedDataset(list, { symbol: 'BTCUSDT', timeframe: '4h', market: 'perp' })?.id).toBe('btc');
  });
  it('prefers the same timeframe, then the same market', () => {
    const list = [ds('btc-1h-perp', 'BTC-USDT-SWAP', H1, 'perp'), ds('btc-4h-spot', 'BTCUSDT', H4), ds('btc-4h-perp', 'BTC-USDT-SWAP', H4, 'perp')];
    expect(matchSeedDataset(list, { symbol: 'BTCUSDT', timeframe: '4h', market: 'perp' })?.id).toBe('btc-4h-perp');
    expect(matchSeedDataset(list, { symbol: 'BTCUSDT', timeframe: '4h', market: 'spot' })?.id).toBe('btc-4h-spot');
    expect(matchSeedDataset(list, { symbol: 'BTCUSDT', timeframe: '1d', market: 'perp' })?.id).toBe('btc-1h-perp');
  });
  it('returns null when there is no dataset for that coin', () => {
    expect(matchSeedDataset([ds('eth', 'ETH-USDT-SWAP', H4, 'perp')], { symbol: 'BTCUSDT', timeframe: '4h', market: 'perp' })).toBeNull();
    expect(matchSeedDataset([], { symbol: 'BTCUSDT', timeframe: '4h', market: 'perp' })).toBeNull();
  });
});
