import { demo } from '@trade-gate/gateway';

import type { EvalCase } from '../src/types.js';

export function syntheticKlines(timeframe: string, start: number, count: number, invert = false): demo.Kline[] {
  const interval = demo.tfToMs(timeframe);
  const values: demo.Kline[] = [];
  let previous = timeframe === '4h' ? 40_000 : timeframe === '1h' ? 42_000 : 43_000;
  for (let index = 0; index < count; index++) {
    const drift = (invert ? -1 : 1) * (8 + Math.sin(index / 5) * 25);
    const open = previous;
    const close = open + drift;
    const high = Math.max(open, close) + 35;
    const low = Math.min(open, close) - 30;
    values.push({
      open_time: start + index * interval,
      open: open.toFixed(2),
      high: high.toFixed(2),
      low: low.toFixed(2),
      close: close.toFixed(2),
      volume: (100 + (index % 17) * 7).toFixed(2),
      close_time: start + (index + 1) * interval - 1,
    });
    previous = close;
  }
  return values;
}

export function minimalCase(): EvalCase {
  const asOf = Date.UTC(2026, 0, 2, 0, 0, 0) - 1;
  const history = syntheticKlines('15m', asOf - 70 * demo.tfToMs('15m') + 1, 70).filter((kline) => kline.close_time <= asOf).slice(-60);
  const last = history.at(-1)!;
  return {
    id: 'minimal',
    set: 'test',
    tags: ['scan', 'base'],
    symbol: 'BTCUSDT',
    timeframe: '15m',
    as_of: asOf,
    mode: 'scan',
    thread: null,
    visible: {
      klines: { '15m': history, '1h': syntheticKlines('1h', asOf - 130 * demo.tfToMs('1h') + 1, 130).filter((kline) => kline.close_time <= asOf).slice(-120), '4h': syntheticKlines('4h', asOf - 90 * demo.tfToMs('4h') + 1, 90).filter((kline) => kline.close_time <= asOf).slice(-80) },
      market: { symbol: 'BTCUSDT', last: last.close, mark: last.close, funding_rate: '0.0001', next_funding_at: asOf + 1, open_interest: '85000', as_of: asOf, klines_tf: '15m' },
      ticker24h: { priceChangePercent: '1.25', highPrice: last.high, lowPrice: history[0]!.low, quoteVolume: '123000000' },
      oi_change_1h_pct: 1.2,
      market_state: null,
      account: { backend: 'paper', equity: '10000', available: '10000', unrealized_pnl: '0', positions: [], open_orders: [], as_of: asOf },
      playbook_text: demo.DEFAULT_PLAYBOOK,
      last_judgment_summary: null,
      halted: false,
      stale_all: false,
    },
    hidden: { future_klines: [], horizon_bars: 48, rubric: null, mirror_of: null },
  };
}
