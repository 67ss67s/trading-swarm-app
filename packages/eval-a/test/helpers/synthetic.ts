// Offline, deterministic kline source for tests: a seeded random walk with slow waves so the stub
// sees trends, pullbacks and breakouts. Two decimals like Binance USDⓈ-M majors.

import { demo } from '@trade-gate/gateway';
import type { KlineSource } from '../../src/binance.js';
import type { EvalCase, GenOptions, Kline } from '../../src/index.js';
import { generateCases, seededRng } from '../../src/index.js';

export function syntheticSource(seed = 1): KlineSource {
  return {
    async range(symbol, tf, startMs, endMs) {
      const tfMs = demo.tfToMs(tf);
      const rng = seededRng(`${seed}:${symbol}:${tf}`);
      const first = Math.floor(startMs / tfMs) * tfMs;
      const out: Kline[] = [];
      let price = symbol.startsWith('ETH') ? 3000 : 60000;
      for (let t = first; t <= endMs; t += tfMs) {
        const wave = Math.sin(t / (tfMs * 37)) * 0.0025 + Math.sin(t / (tfMs * 173)) * 0.004;
        const ret = wave + (rng() - 0.5) * 0.005;
        const open = price;
        const close = price * (1 + ret);
        const hi = Math.max(open, close) * (1 + rng() * 0.002);
        const lo = Math.min(open, close) * (1 - rng() * 0.002);
        out.push({ open_time: t, open: open.toFixed(2), high: hi.toFixed(2), low: lo.toFixed(2), close: close.toFixed(2), volume: (100 + rng() * 120).toFixed(3), close_time: t + tfMs - 1 });
        price = close;
      }
      return out.filter((k) => k.open_time >= startMs && k.open_time <= endMs);
    },
  };
}

export const TEST_FROM = Date.UTC(2026, 0, 10);
export const TEST_TO = Date.UTC(2026, 0, 24);

export function genOpts(over: Partial<GenOptions> = {}): GenOptions {
  return { symbols: ['BTCUSDT'], tf: '15m', from: TEST_FROM, to: TEST_TO, n: 2, seed: 7, set: 'test', ...over };
}

export async function synthCases(over: Partial<GenOptions> = {}, seed = 1): Promise<EvalCase[]> {
  return generateCases(genOpts(over), syntheticSource(seed));
}

export const kl = (open_time: number, o: number, h: number, l: number, c: number, v = 100, tfMs = 900_000): Kline => ({ open_time, open: o.toFixed(2), high: h.toFixed(2), low: l.toFixed(2), close: c.toFixed(2), volume: v.toFixed(3), close_time: open_time + tfMs - 1 });
