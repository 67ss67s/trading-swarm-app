/**
 * 盯盘参数 / 筛选页纯逻辑:代码归一、资产过滤排序、名额、合并去重、移除、上移下移、
 * 雷达候选归并、全市场扫描挑选、调用量估算、/api/universe 与 /api/symbols 的防御式归一。
 */
import { describe, expect, it } from 'vitest';
import type { ScreenRow, WatchCandidate } from '../src/api/types';
import type { UniverseItem } from '../src/api/universe';
import { adaptUniverse, baseOf, universeFromSymbols } from '../src/api/universe';
import {
  bestPerSymbol,
  estimateCallsPerHour,
  estimateDaily,
  filterUniverse,
  fmtChange,
  fmtCompact,
  fmtFunding,
  matchTier,
  mergeAdd,
  moveItem,
  normalizeSymbol,
  parseSymbolInput,
  pickMarketScan,
  pickerRows,
  quota,
  radarHits,
  removeSymbols,
  setTradable,
  sortUniverse,
  uniqueSymbols,
} from '../src/components/watch/watch-logic';

const item = (symbol: string, o: Partial<UniverseItem> = {}): UniverseItem => ({
  symbol,
  base: baseOf(symbol),
  markets: ['spot', 'perp'],
  last: 1,
  change_24h: 0,
  quote_volume_24h: 0,
  funding_rate: null,
  rank_by_volume: null,
  excluded: false,
  ...o,
});

const U: UniverseItem[] = [
  item('BTCUSDT', { quote_volume_24h: 9e9, change_24h: 1.2, funding_rate: 0.0001, rank_by_volume: 1 }),
  item('ETHUSDT', { quote_volume_24h: 5e9, change_24h: -2.5, funding_rate: -0.0003, rank_by_volume: 2 }),
  item('SOLUSDT', { quote_volume_24h: 2e9, change_24h: 8.1, funding_rate: 0.0006, rank_by_volume: 3 }),
  item('USDCUSDT', { quote_volume_24h: 3e9, excluded: true, markets: ['spot'], rank_by_volume: 4 }),
  item('OKBUSDT', { quote_volume_24h: null, change_24h: null, markets: ['spot'] }),
  item('BTCDOMUSDT', { quote_volume_24h: 1e6, markets: ['perp'], rank_by_volume: 90 }),
];

describe('代码归一', () => {
  it('normalizeSymbol 自动补 USDT、去掉横杠与 -SWAP', () => {
    expect(normalizeSymbol('btc')).toBe('BTCUSDT');
    expect(normalizeSymbol(' BTC-USDT-SWAP ')).toBe('BTCUSDT');
    expect(normalizeSymbol('eth-usdt')).toBe('ETHUSDT');
    expect(normalizeSymbol('')).toBe('');
    expect(normalizeSymbol('USDT')).toBe('USDTUSDT');
  });
  it('parseSymbolInput 多分隔符、去重保序', () => {
    expect(parseSymbolInput('btc, eth，sol  btc')).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(parseSymbolInput('  ')).toEqual([]);
  });
  it('baseOf', () => {
    expect(baseOf('BTCUSDT')).toBe('BTC');
    expect(baseOf('BTC-USDT-SWAP')).toBe('BTC');
    expect(baseOf('USDT')).toBe('USDT');
  });
});

describe('资产过滤', () => {
  it('默认隐藏打标排除的,按市场筛', () => {
    expect(filterUniverse(U, { market: 'all', q: '' }).map((x) => x.symbol)).not.toContain('USDCUSDT');
    expect(filterUniverse(U, { market: 'all', q: '', includeExcluded: true }).map((x) => x.symbol)).toContain('USDCUSDT');
    expect(filterUniverse(U, { market: 'perp', q: '' }).map((x) => x.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BTCDOMUSDT']);
    expect(filterUniverse(U, { market: 'spot', q: '' }).map((x) => x.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'OKBUSDT']);
  });
  it('搜索:相关度分层,base 相等 > 开头 > 包含', () => {
    expect(matchTier(U[0]!, 'btc')).toBe(0);
    expect(matchTier(U[5]!, 'btc')).toBe(1);
    expect(matchTier(U[0]!, 'tcu')).toBe(2);
    expect(matchTier(U[1]!, 'btc')).toBe(-1);
    expect(matchTier(U[0]!, '')).toBe(0);
    expect(filterUniverse(U, { market: 'all', q: 'bt' }).map((x) => x.symbol)).toEqual(['BTCUSDT', 'BTCDOMUSDT']);
  });
});

describe('资产排序', () => {
  it('成交额降序,空值垫底', () => {
    expect(sortUniverse(U, 'volume').map((x) => x.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'USDCUSDT', 'SOLUSDT', 'BTCDOMUSDT', 'OKBUSDT']);
  });
  it('涨跌升降', () => {
    expect(sortUniverse(U, 'change', 'desc')[0]!.symbol).toBe('SOLUSDT');
    const asc = sortUniverse(U, 'change', 'asc');
    expect(asc[0]!.symbol).toBe('ETHUSDT');
    expect(asc.at(-1)!.symbol).toBe('OKBUSDT'); // 空值升序也垫底
  });
  it('资金费:desc 最高在前,asc 最负在前', () => {
    expect(sortUniverse(U, 'funding', 'desc')[0]!.symbol).toBe('SOLUSDT');
    expect(sortUniverse(U, 'funding', 'asc')[0]!.symbol).toBe('ETHUSDT');
  });
  it('有搜索词时先按相关度再按排序键', () => {
    const rows = sortUniverse([item('XBTCUSDT', { quote_volume_24h: 1e12 }), ...U], 'volume', 'desc', 'btc');
    expect(rows.slice(0, 3).map((x) => x.symbol)).toEqual(['BTCUSDT', 'BTCDOMUSDT', 'XBTCUSDT']);
  });
  it('pickerRows 截断并报匹配总数', () => {
    const r = pickerRows(U, { market: 'all', q: '' }, 'volume', 'desc', 2);
    expect(r.rows.map((x) => x.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(r.matched).toBe(5);
  });
});

describe('名额与合并去重', () => {
  it('quota', () => {
    expect(quota(32, 60)).toEqual({ used: 32, max: 60, room: 28, full: false });
    expect(quota(60, 60).full).toBe(true);
    expect(quota(70, 60).room).toBe(0);
    expect(quota(0, 0).max).toBe(1);
  });
  it('mergeAdd:去重、保序、超上限的进 overflow', () => {
    const r = mergeAdd(['BTCUSDT', 'ETHUSDT'], ['ETHUSDT', 'solusdt', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'], 4);
    expect(r.next).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT']);
    expect(r.added).toEqual(['SOLUSDT', 'XRPUSDT']);
    expect(r.already).toEqual(['ETHUSDT']);
    expect(r.overflow).toEqual(['DOGEUSDT']);
  });
  it('mergeAdd:已满一个都加不进', () => {
    const r = mergeAdd(['A', 'B'], ['C'], 2);
    expect(r.next).toEqual(['A', 'B']);
    expect(r.overflow).toEqual(['C']);
  });
  it('removeSymbols 连带清 watch_only', () => {
    expect(removeSymbols({ watchlist: ['A', 'B', 'C'], watch_only: ['B', 'C'] }, ['B'])).toEqual({ watchlist: ['A', 'C'], watch_only: ['C'] });
  });
  it('setTradable 只对名单里的币生效、不重复', () => {
    const s = { watchlist: ['A', 'B'], watch_only: ['A'] };
    expect(setTradable(s, ['A', 'B', 'Z'], false).watch_only).toEqual(['A', 'B']);
    expect(setTradable(s, ['A'], true).watch_only).toEqual([]);
  });
  it('moveItem 上移下移与越界夹紧', () => {
    expect(moveItem(['A', 'B', 'C'], 2, 0)).toEqual(['C', 'A', 'B']);
    expect(moveItem(['A', 'B', 'C'], 0, 1)).toEqual(['B', 'A', 'C']);
    expect(moveItem(['A', 'B', 'C'], 0, 99)).toEqual(['B', 'C', 'A']);
    expect(moveItem(['A', 'B', 'C'], 1, -5)).toEqual(['B', 'A', 'C']);
    expect(moveItem(['A', 'B'], 5, 0)).toEqual(['A', 'B']);
  });
});

const NOW = 1_790_000_000_000;
const screen = (id: string, o: Partial<ScreenRow> = {}): ScreenRow => ({
  id,
  horizon: 'short',
  started_at: NOW - 3_600_000,
  finished_at: NOW - 3_000_000,
  status: 'done',
  universe: 'watchlist+whitelist',
  symbols: [],
  errors: [],
  run_id: null,
  handoff_id: null,
  proposal: null,
  brain: null,
  cost_cny: 0,
  error: null,
  ...o,
});
const cand = (symbol: string, rank: number, strategy_id = 's1'): WatchCandidate => ({ screen_id: 'x', horizon: 'short', symbol, strategy_id, fit_score: 1 - rank / 10, rank, reasons: [], card: {} as WatchCandidate['card'], ttl_at: 0, created_at: 0 });

describe('雷达候选与全市场扫描', () => {
  it('radarHits:取最靠前名次,过期 / 失败的筛选不算', () => {
    const m = radarHits(
      [
        { screen: screen('a'), candidates: [cand('BTCUSDT', 3), cand('ETHUSDT', 1)] },
        { screen: screen('b', { universe: 'okx_all' as ScreenRow['universe'] }), candidates: [cand('BTCUSDT', 1), cand('SOLUSDT', 2)] },
        { screen: screen('old', { finished_at: NOW - 2 * 86_400_000 }), candidates: [cand('XRPUSDT', 1)] },
        { screen: screen('bad', { status: 'failed' }), candidates: [cand('DOGEUSDT', 1)] },
        { screen: null, candidates: [cand('ADAUSDT', 1)] },
      ],
      NOW,
    );
    expect([...m.keys()].sort()).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(m.get('BTCUSDT')).toMatchObject({ rank: 1, screen_id: 'b', universe: 'okx_all' });
  });
  it('pickMarketScan:只挑 horizon=daily、universe=okx_all 且完成的,取最新(雷达自己的 okx_all 短周期不算)', () => {
    const daily = { universe: 'okx_all' as ScreenRow['universe'], horizon: 'daily' as ScreenRow['horizon'] };
    const s1 = screen('s1', { ...daily, finished_at: NOW - 5000 });
    const s2 = screen('s2', { ...daily, finished_at: NOW - 1000 });
    const run = screen('s3', { ...daily, status: 'running', finished_at: null, started_at: NOW });
    const radarOkx = screen('r', { universe: 'okx_all' as ScreenRow['universe'], finished_at: NOW });
    expect(pickMarketScan([s1, null, screen('w'), s2, run, radarOkx, undefined])?.id).toBe('s2');
    expect(pickMarketScan([screen('w')])).toBeNull();
  });
  it('uniqueSymbols / bestPerSymbol', () => {
    const cs = [cand('B', 3, 's2'), cand('A', 2), cand('B', 1)];
    expect(uniqueSymbols(cs)).toEqual(['B', 'A']);
    expect(bestPerSymbol(cs).map((c) => `${c.symbol}${c.rank}`)).toEqual(['B1', 'A2']);
  });
});

describe('调用量估算', () => {
  it('每根收盘:币数 × 每小时根数', () => {
    expect(estimateCallsPerHour({ watchlist: ['A', 'B'], timeframe: '15m', scan_mode: 'every_close', heartbeat_every_ms: 0 })).toEqual({ low: 8, high: 8 });
    expect(estimateCallsPerHour({ watchlist: ['A'], timeframe: '1h', scan_mode: 'every_close', heartbeat_every_ms: 0 })).toEqual({ low: 1, high: 1 });
  });
  it('触发器:心跳下限 ~ 心跳 + 每币 4 次', () => {
    expect(estimateCallsPerHour({ watchlist: ['A', 'B'], timeframe: '15m', scan_mode: 'triggered', heartbeat_every_ms: 30 * 60_000 })).toEqual({ low: 4, high: 12 });
  });
  it('每天估算按每日上限封顶', () => {
    const w = { watchlist: ['A', 'B'], timeframe: '15m', scan_mode: 'triggered' as const, heartbeat_every_ms: 30 * 60_000 };
    expect(estimateDaily(w)).toMatchObject({ low: 96, high: 288, capped: false });
    expect(estimateDaily(w, 100)).toMatchObject({ low: 96, high: 100, capped: true });
  });
});

describe('接口归一', () => {
  it('adaptUniverse:缺字段不崩、字符串数字转数、去重、非法市场丢掉', () => {
    const r = adaptUniverse({
      updated_at: '1790000000000',
      items: [
        { symbol: 'btcusdt', markets: ['spot', 'perp', 'margin'], last: '84000.5', change_24h: 1.5, quote_volume_24h: '9000000000', funding_rate: '0.0001', rank_by_volume: 1, excluded: false },
        { symbol: 'BTCUSDT', last: 1 },
        { symbol: '' },
        null,
        { symbol: 'USDCUSDT', excluded: true },
      ],
    });
    expect(r.fallback).toBe(false);
    expect(r.updated_at).toBe(1_790_000_000_000);
    expect(r.total).toBe(2);
    expect(r.items[0]).toMatchObject({ symbol: 'BTCUSDT', base: 'BTC', markets: ['spot', 'perp'], last: 84000.5, quote_volume_24h: 9e9, funding_rate: 0.0001 });
    expect(r.items[1]).toMatchObject({ symbol: 'USDCUSDT', markets: ['perp'], excluded: true, last: null });
    expect(adaptUniverse(null)).toEqual({ updated_at: null, total: 0, items: [], fallback: false });
  });
  it('universeFromSymbols:只留 TRADING,标 fallback', () => {
    const r = universeFromSymbols({ symbols: [{ symbol: 'BTCUSDT', status: 'TRADING' }, { symbol: 'LUNAUSDT', status: 'BREAK' }, { symbol: 'ETHUSDT' }, { symbol: 'BTCUSDT', status: 'TRADING' }] });
    expect(r.fallback).toBe(true);
    expect(r.items.map((x) => x.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(r.items[0]!.markets).toEqual(['perp']);
  });
});

describe('格式', () => {
  it('fmtCompact / fmtChange / fmtFunding', () => {
    expect(fmtCompact(1.234e9)).toBe('1.23B');
    expect(fmtCompact(null)).toBe('—');
    expect(fmtChange(3.2)).toBe('+3.20%');
    expect(fmtChange(-0.5)).toBe('-0.50%');
    expect(fmtFunding(0.0001)).toBe('0.0100%');
  });
});
