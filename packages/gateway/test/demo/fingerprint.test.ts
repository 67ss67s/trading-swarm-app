import { describe, expect, it } from 'vitest';
import { heartbeatFingerprint } from '../../src/demo/fingerprint.js';
import type { TfFeatures } from '../../src/demo/market.js';

const base = (o: Partial<TfFeatures> = {}): TfFeatures => ({
  tf: '15m',
  last_close: 100,
  last_open_time: 0,
  ema20: 101,
  ema50: 99,
  atr14: 0.3,
  swing_high_20: 104,
  swing_low_20: 96,
  swing_high_50: 110,
  swing_low_50: 90,
  dist_to_high20_pct: 4,
  dist_to_low20_pct: 4,
  vol_ratio_20: 1.1,
  change_pct_last: 0.1,
  change_pct_5: 0.3,
  last_bars: '',
  ...o,
});

describe('heartbeatFingerprint', () => {
  it('ignores price wiggles that do not change any bucket', () => {
    const a = heartbeatFingerprint({ tf: base(), h1: base({ tf: '1h' }), market_state_id: 'ms1', session: 'asia', regime: 'trend_up' });
    const b = heartbeatFingerprint({ tf: base({ last_close: 100.4, change_pct_last: -0.2, vol_ratio_20: 1.2 }), h1: base({ tf: '1h' }), market_state_id: 'ms1', session: 'asia', regime: 'trend_up' });
    expect(a).toBe(b);
  });

  it('changes on trend flip, EMA side, ATR band, range position, volume band, market state, session', () => {
    const ref = { tf: base(), h1: base({ tf: '1h' }), market_state_id: 'ms1', session: 'asia', regime: 'trend_up' };
    const fp = heartbeatFingerprint(ref);
    expect(heartbeatFingerprint({ ...ref, tf: base({ ema20: 98 }) })).not.toBe(fp); // trend flip
    expect(heartbeatFingerprint({ ...ref, tf: base({ ema20: 99.5 }) })).not.toBe(fp); // price side of ema20 flips (ref is below)
    expect(heartbeatFingerprint({ ...ref, tf: base({ atr14: 0.05 }) })).not.toBe(fp); // atr band
    expect(heartbeatFingerprint({ ...ref, tf: base({ last_close: 103.8 }) })).not.toBe(fp); // near 20-bar high
    expect(heartbeatFingerprint({ ...ref, tf: base({ vol_ratio_20: 2 }) })).not.toBe(fp); // volume band
    expect(heartbeatFingerprint({ ...ref, market_state_id: 'ms2' })).not.toBe(fp);
    expect(heartbeatFingerprint({ ...ref, session: 'us' })).not.toBe(fp);
    expect(heartbeatFingerprint({ ...ref, h1: base({ tf: '1h', ema20: 90 }) })).not.toBe(fp);
  });
});
