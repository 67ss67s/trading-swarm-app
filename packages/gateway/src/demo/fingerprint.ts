/**
 * Heartbeat fingerprint (docs/research/scan-and-strategy-decision-2026-09-05.md §2 A).
 *
 * 2026-09-04 ledger: 590 of 668 judgments were routine kline-close/heartbeat asks that returned WATCH; the
 * market had not changed in any way the playbook cares about between consecutive asks. So before a heartbeat
 * scan spends a model call, the runtime compares this coarse fingerprint of "what the playbook looks at" with
 * the one recorded at the last model call for that symbol. Same fingerprint → skip, zero tokens. Any real
 * trigger (breakout / vol_spike / retest / fast_move …) still bypasses this and asks immediately.
 *
 * Buckets are deliberately coarse: the point is to detect regime/structure changes, not price wiggles.
 */

import type { TfFeatures } from './market.js';

export interface FingerprintInputs {
  horizon?: import('./horizon.js').StrategyHorizon;
  tf: TfFeatures;
  h1: TfFeatures | null;
  /** Information officer's latest market state id (changes when it re-summarises). */
  market_state_id: string | null;
  session: string;
  /** Daily regime label, when already known (no extra fetch is made for it). */
  regime: string | null;
}

const trend = (f: TfFeatures): string => (f.ema20 > f.ema50 ? 'up' : f.ema20 < f.ema50 ? 'dn' : 'flat');
const above = (f: TfFeatures): string => (f.last_close >= f.ema20 ? 'a' : 'b');
const atrBucket = (f: TfFeatures): string => {
  const pct = f.last_close > 0 ? (f.atr14 / f.last_close) * 100 : 0;
  return pct < 0.15 ? 'atr0' : pct < 0.4 ? 'atr1' : 'atr2';
};
/** Position relative to the 20-bar range in ATR: near high / near low / mid / beyond. */
const rangeBucket = (f: TfFeatures): string => {
  if (f.atr14 <= 0) return 'r?';
  const toHigh = (f.swing_high_20 - f.last_close) / f.atr14;
  const toLow = (f.last_close - f.swing_low_20) / f.atr14;
  if (toHigh < 0) return 'r>hi';
  if (toLow < 0) return 'r<lo';
  if (toHigh <= 1.5) return 'r~hi';
  if (toLow <= 1.5) return 'r~lo';
  return 'rmid';
};
const volBucket = (f: TfFeatures): string => (f.vol_ratio_20 >= 1.5 ? 'v2' : f.vol_ratio_20 >= 1 ? 'v1' : 'v0');

export function heartbeatFingerprint(i: FingerprintInputs): string {
  const parts = [
    `${i.tf.tf}:${trend(i.tf)}${above(i.tf)}:${atrBucket(i.tf)}:${rangeBucket(i.tf)}:${volBucket(i.tf)}`,
    i.h1 ? `1h:${trend(i.h1)}${above(i.h1)}` : '1h:?',
    `ms:${i.market_state_id ?? '-'}`,
    `s:${i.session}`,
    `rg:${i.regime ?? '-'}`,
  ];
  return (i.horizon ? [`horizon:${i.horizon}`, ...parts] : parts).join('|');
}
