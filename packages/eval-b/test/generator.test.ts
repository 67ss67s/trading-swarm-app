import { demo } from '@trading-swarm/gateway';
import { describe, expect, it } from 'vitest';

import { generateCasesFromData, type HistoricalData } from '../src/generator.js';
import { mirrorCase } from '../src/mirror.js';
import { syntheticKlines } from './helpers.js';

describe('case generator', () => {
  it('is deterministic for the same seed and data', () => {
    const start = Date.UTC(2025, 11, 1);
    const from = start + 25 * 86_400_000;
    const to = from + 4 * 86_400_000;
    const data: HistoricalData = {
      BTCUSDT: {
        '15m': syntheticKlines('15m', start, 3_500),
        '1h': syntheticKlines('1h', start, 900),
        '4h': syntheticKlines('4h', start, 300),
      },
    };
    const options = { symbols: ['BTCUSDT'], timeframe: '15m', from, to, count: 2, seed: 7, set: 'test' };
    expect(generateCasesFromData(options, data)).toEqual(generateCasesFromData(options, data));
    expect(generateCasesFromData({ ...options, seed: 8 }, data).filter((item) => item.tags.includes('base')).map((item) => item.as_of)).not.toEqual(
      generateCasesFromData(options, data).filter((item) => item.tags.includes('base')).map((item) => item.as_of),
    );
  });

  it('mirrors OHLC exactly, swaps high/low, and preserves time and volume', () => {
    const source = generateCasesFromData(
      { symbols: ['BTCUSDT'], timeframe: '15m', from: Date.UTC(2025, 11, 26), to: Date.UTC(2025, 11, 30), count: 1, seed: 7, set: 'test' },
      { BTCUSDT: { '15m': syntheticKlines('15m', Date.UTC(2025, 11, 1), 3_500), '1h': syntheticKlines('1h', Date.UTC(2025, 11, 1), 900), '4h': syntheticKlines('4h', Date.UTC(2025, 11, 1), 300) } },
    ).find((item) => item.tags.includes('base'))!;
    const mirrored = mirrorCase(source);
    const pivot = Number(source.visible.market.last);
    const original = source.visible.klines['15m']![10]!;
    const transformed = mirrored.visible.klines['15m']![10]!;
    expect(Number(transformed.open)).toBeCloseTo(2 * pivot - Number(original.open), 10);
    expect(Number(transformed.high)).toBeCloseTo(2 * pivot - Number(original.low), 10);
    expect(Number(transformed.low)).toBeCloseTo(2 * pivot - Number(original.high), 10);
    expect(Number(transformed.close)).toBeCloseTo(2 * pivot - Number(original.close), 10);
    expect(transformed.volume).toBe(original.volume);
    expect(transformed.open_time).toBe(original.open_time);
    expect(transformed.close_time).toBe(original.close_time);
    expect(mirrored.as_of).toBe(source.as_of);
    expect(demo.tfFeatures('15m', mirrored.visible.klines['15m']!).ema20 > demo.tfFeatures('15m', mirrored.visible.klines['15m']!).ema50).not.toBe(
      demo.tfFeatures('15m', source.visible.klines['15m']!).ema20 > demo.tfFeatures('15m', source.visible.klines['15m']!).ema50,
    );
  });
});
