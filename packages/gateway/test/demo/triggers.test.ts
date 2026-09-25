// triggers.ts: pure rules that decide when the model is called (docs/demo/v3-ui-contract.md §0).

import { describe, expect, it } from 'vitest';
import { detectTriggers, sessionInfo, windowMovePct, type TriggerInputs } from '../../src/demo/triggers.js';
import type { TfFeatures } from '../../src/demo/market.js';
import type { SessionInfo } from '../../src/demo/types.js';

function feat(p: Partial<TfFeatures> = {}): TfFeatures {
  return {
    tf: '15m',
    last_close: 100,
    last_open_time: 1_000_000,
    ema20: 99,
    ema50: 98,
    atr14: 1,
    swing_high_20: 101,
    swing_low_20: 97,
    swing_high_50: 103,
    swing_low_50: 95,
    dist_to_high20_pct: 1,
    dist_to_low20_pct: 3,
    vol_ratio_20: 1,
    change_pct_last: 0.1,
    change_pct_5: 0.2,
    last_bars: '',
    ...p,
  };
}
const quiet: SessionInfo = { name: 'asia', text: '亚洲盘中', minutes_to_us_open: 300, minutes_to_us_close: 690, weekend: false };
function inputs(p: Partial<TriggerInputs> = {}): TriggerInputs {
  return { symbol: 'BTCUSDT', now_tf: feat(), prev_tf: feat({ last_open_time: 900_000 }), h1: feat({ tf: '1h' }), market: null, session: quiet, fast_move_pct: null, fast_move_threshold_pct: 0.8, prev_session: 'asia', ...p };
}

describe('detectTriggers', () => {
  it('a calm bar fires nothing (the model is NOT called on every close)', () => {
    expect(detectTriggers(inputs())).toEqual([]);
  });

  it('breakout: close beyond the previous window 20-bar high', () => {
    const hits = detectTriggers(inputs({ now_tf: feat({ last_close: 102, swing_high_20: 102 }) }));
    expect(hits.map((h) => h.kind)).toContain('breakout');
    expect(hits.find((h) => h.kind === 'breakout')!.detail).toMatch(/突破前 20 根高点 101/);
  });

  it('breakdown: close below the previous window 20-bar low', () => {
    const hits = detectTriggers(inputs({ now_tf: feat({ last_close: 96, swing_low_20: 96 }) }));
    expect(hits[0]!.kind).toBe('breakout');
    expect(hits[0]!.detail).toMatch(/跌破/);
  });

  it('ema_cross only when EMA20/EMA50 ordering flipped since the previous close', () => {
    const flipped = detectTriggers(inputs({ now_tf: feat({ ema20: 97, ema50: 98 }) }));
    expect(flipped.map((h) => h.kind)).toContain('ema_cross');
    const same = detectTriggers(inputs({ now_tf: feat({ ema20: 99.5, ema50: 98 }) }));
    expect(same.map((h) => h.kind)).not.toContain('ema_cross');
  });

  it('vol_spike needs both volume ≥ 2x and a body ≥ 0.6 ATR', () => {
    expect(detectTriggers(inputs({ now_tf: feat({ vol_ratio_20: 2.5, change_pct_last: 0.9 }) })).map((h) => h.kind)).toContain('vol_spike');
    expect(detectTriggers(inputs({ now_tf: feat({ vol_ratio_20: 2.5, change_pct_last: 0.1 }) })).map((h) => h.kind)).not.toContain('vol_spike');
    expect(detectTriggers(inputs({ now_tf: feat({ vol_ratio_20: 1.2, change_pct_last: 2 }) })).map((h) => h.kind)).not.toContain('vol_spike');
  });

  it('retest: back at EMA20 after a ≥1 ATR excursion, with a defined 1h trend', () => {
    const hits = detectTriggers(inputs({ now_tf: feat({ last_close: 99.1, ema20: 99, change_pct_5: -1.5 }) }));
    expect(hits.map((h) => h.kind)).toContain('retest');
    const noTrend = detectTriggers(inputs({ now_tf: feat({ last_close: 99.1, ema20: 99, change_pct_5: -1.5 }), h1: feat({ tf: '1h', ema20: 50, ema50: 50 }) }));
    expect(noTrend.map((h) => h.kind)).not.toContain('retest');
  });

  it('fast_move fires from the 5-minute mark move, independent of the bar', () => {
    const hits = detectTriggers(inputs({ fast_move_pct: -1.2 }));
    expect(hits[0]!.kind).toBe('fast_move');
    expect(hits[0]!.detail).toMatch(/急跌 1.20%/);
    expect(detectTriggers(inputs({ fast_move_pct: 0.5 })).map((h) => h.kind)).not.toContain('fast_move');
  });

  it('funding: |rate| ≥ 0.05%', () => {
    const market = { symbol: 'BTCUSDT', last: '100', mark: '100', funding_rate: '0.0008', next_funding_at: 0, open_interest: '1', as_of: 0, klines_tf: '15m' };
    expect(detectTriggers(inputs({ market })).map((h) => h.kind)).toContain('funding');
    expect(detectTriggers(inputs({ market: { ...market, funding_rate: '0.0001' } })).map((h) => h.kind)).not.toContain('funding');
  });

  it('session window is announced once (not on every close inside it)', () => {
    const win: SessionInfo = { name: 'us_open_window', text: '美股刚开盘 3 分钟', minutes_to_us_open: -3, minutes_to_us_close: 387, weekend: false };
    expect(detectTriggers(inputs({ session: win, prev_session: 'london' })).map((h) => h.kind)).toContain('session');
    expect(detectTriggers(inputs({ session: win, prev_session: 'us_open_window' })).map((h) => h.kind)).not.toContain('session');
  });

  it('first pass (no previous features) still recognises a close on the 20-bar high', () => {
    const hits = detectTriggers(inputs({ prev_tf: null, now_tf: feat({ dist_to_high20_pct: 0, change_pct_last: 0.5 }) }));
    expect(hits.map((h) => h.kind)).toContain('breakout');
  });

  it('hits are sorted strongest first', () => {
    const hits = detectTriggers(inputs({ fast_move_pct: 3, now_tf: feat({ ema20: 97, ema50: 98 }) }));
    expect(hits[0]!.kind).toBe('fast_move');
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
  });
});

describe('sessionInfo', () => {
  // 2026-09-02 is a Wednesday. 13:30 UTC = 09:30 New York (EDT).
  const wedUtc = (h: number, m: number): number => Date.UTC(2026, 8, 2, h, m);

  it('US open window: from 30 minutes before to 15 minutes after 09:30 ET', () => {
    expect(sessionInfo(wedUtc(13, 10)).name).toBe('us_open_window');
    expect(sessionInfo(wedUtc(13, 40)).name).toBe('us_open_window');
    expect(sessionInfo(wedUtc(13, 10)).minutes_to_us_open).toBe(20);
  });

  it('US close window around 16:00 ET, plain "us" in between', () => {
    expect(sessionInfo(wedUtc(15, 0)).name).toBe('us');
    expect(sessionInfo(wedUtc(19, 40)).name).toBe('us_close_window');
  });

  it('weekend is flagged and has no US open countdown', () => {
    const sat = Date.UTC(2026, 8, 5, 14, 0);
    const s = sessionInfo(sat);
    expect(s.name).toBe('weekend');
    expect(s.weekend).toBe(true);
    expect(s.minutes_to_us_open).toBeNull();
  });

  it('Asia session in the Singapore morning', () => {
    expect(sessionInfo(Date.UTC(2026, 8, 2, 2, 0)).name).toBe('asia');
  });
});

describe('windowMovePct', () => {
  it('null with fewer than two samples or too little span', () => {
    expect(windowMovePct([], 10_000, 5000)).toBeNull();
    expect(windowMovePct([{ at: 9000, mark: 100 }, { at: 9500, mark: 101 }], 10_000, 5000)).toBeNull();
  });
  it('signed move from the oldest in-window sample to the newest', () => {
    const s = [{ at: 4000, mark: 100 }, { at: 7000, mark: 100.5 }, { at: 10_000, mark: 102 }];
    expect(windowMovePct(s, 10_000, 5000)).toBeCloseTo(1.49, 2); // window starts at 5000 → oldest is the 7000 sample
    expect(windowMovePct(s, 10_000, 8000)).toBeCloseTo(2, 5);
  });
});
