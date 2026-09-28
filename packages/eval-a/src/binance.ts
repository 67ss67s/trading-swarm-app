// Historical USDⓈ-M klines for `gen` only (docs/eval/README.md §2). The gateway's `demo.fetchKlines`
// has no endTime parameter, so this is the one place the eval talks to the network. Every raw pull
// is cached bit-for-bit under data/ keyed by its exact request, so a second `gen` is offline.
//
// Binance semantics: `endTime` is inclusive and the response contains the bar that *contains*
// endTime (i.e. possibly a bar whose close_time > endTime). Callers slice by close_time ≤ as_of.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { demo } from '@trade-gate/gateway';
import type { Kline } from './types.js';
import { readJson, writeJson } from './util.js';

export interface KlineSource {
  /** All bars with open_time in [startMs, endMs], ascending, deduplicated. */
  range(symbol: string, tf: string, startMs: number, endMs: number): Promise<Kline[]>;
}

type RawKline = [number, string, string, string, string, string, number, ...unknown[]];

const FAPI = process.env['TG_EVAL_FAPI_BASE'] ?? process.env['TG_DEMO_MARKET_BASE'] ?? 'https://fapi.binance.com';
const PAGE = 1500;

function toKline(k: RawKline): Kline {
  return { open_time: k[0], open: k[1], high: k[2], low: k[3], close: k[4], volume: k[5], close_time: k[6] };
}

async function getRaw(path: string, timeoutMs = 15_000): Promise<RawKline[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${FAPI}${path}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return (await res.json()) as RawKline[];
  } finally {
    clearTimeout(t);
  }
}

/** Network-backed source with a raw-pull cache in `dataDir/klines/`. */
export function binanceSource(dataDir: string, log: (s: string) => void = () => {}): KlineSource {
  return {
    async range(symbol, tf, startMs, endMs) {
      const tfMs = demo.tfToMs(tf);
      const out = new Map<number, Kline>();
      // Page backwards with endTime; each page's key is its exact request so re-runs are offline.
      let endTime = Math.floor(endMs / tfMs) * tfMs + tfMs - 1;
      let guard = 0;
      while (endTime >= startMs && guard++ < 200) {
        const file = join(dataDir, 'klines', `${symbol}_${tf}_end${endTime}_n${PAGE}.json`);
        let raw: RawKline[];
        if (existsSync(file)) raw = readJson<RawKline[]>(file);
        else {
          raw = await getRaw(`/fapi/v1/klines?symbol=${symbol}&interval=${tf}&endTime=${endTime}&limit=${PAGE}`);
          writeJson(file, raw);
          log(`pulled ${symbol} ${tf} endTime=${endTime} → ${raw.length} bars (cached ${file})`);
        }
        if (!raw.length) break;
        for (const r of raw) {
          const k = toKline(r);
          if (k.close_time > endTime) continue; // the bar containing endTime is still open at endTime
          if (k.open_time >= startMs && k.open_time <= endMs) out.set(k.open_time, k);
        }
        const first = raw[0]!;
        endTime = first[0] - 1;
        if (raw.length < PAGE) break;
      }
      return [...out.values()].sort((a, b) => a.open_time - b.open_time);
    },
  };
}
