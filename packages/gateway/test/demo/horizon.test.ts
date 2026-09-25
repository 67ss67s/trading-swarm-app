import { describe, expect, it } from 'vitest';
import { HORIZON_POLICY, reviewDue, reviewTimeframe } from '../../src/demo/horizon.js';
import { reviewMetrics } from '../../src/demo/review-metrics.js';
import { BUILTIN_STRATEGIES, strategyContentHash } from '../../src/demo/strategies.js';
import type { TfFeatures } from '../../src/demo/market.js';

const feature = (tf: string, up: boolean): TfFeatures => ({ tf, last_close: up ? 110 : 90, ema20: 100, ema50: up ? 95 : 105, atr14: 5 } as TfFeatures);
describe('horizon-aware patience', () => {
  it('scalp keeps its fast path; swing waits for 4h closes, position for daily closes and survives restart', () => {
    const t = { timeframe: '15m', created_at: 0, opened_at: 1_000, horizon: 'swing' as const };
    expect(reviewTimeframe(t)).toBe('4h');
    expect(reviewDue(t, 900_000, 0)).toBe(false);
    expect(reviewDue(t, 14_400_000, 0)).toBe(true);
    expect(reviewDue(t, 15_300_000, 14_400_000)).toBe(false);
    expect(reviewDue({ ...t, horizon: 'position' }, 14_400_000, 0)).toBe(false);
    expect(reviewDue({ ...t, horizon: 'position' }, 86_400_000, 0)).toBe(true);
    expect(reviewDue({ ...t, timeframe: '5m', horizon: 'scalp' }, 1_001, 1_000)).toBe(true);
  });
  it('lower-timeframe reversals cannot flip a swing thesis; closed 4h evidence can', () => {
    const input = { now: 20_000_000, side: 'long' as const, status: 'in_position' as const, mark: '110', entry: '100', stop: '80', take_profits: ['140'], entry_zone: null, invalidation_text: null, opened_at: 1_000, created_at: 0, tf_ms: 14_400_000, horizon: 'swing' as const };
    const calm = reviewMetrics({ ...input, features: [feature('15m',false), feature('1h',false), feature('4h',true), feature('1d',true)] })!;
    expect(calm.thesis_trend_flipped).toBe(false);
    expect(calm.structure_against).toBe(false);
    expect(calm.text).toContain('论点趋势:4h');
    expect(reviewMetrics({ ...input, features: [feature('15m',true), feature('1h',true), feature('4h',false), feature('1d',true)] })!.thesis_trend_flipped).toBe(true);
    expect(reviewMetrics({ ...input, features: [feature('15m',false), feature('1h',false)] })!.thesis_trend_flipped).toBe(false);
  });
  it('every strategy has a hashed horizon and long variants stay below paper until promoted', () => {
    for (const s of BUILTIN_STRATEGIES) expect(HORIZON_POLICY[s.horizon]).toBeDefined();
    const s = BUILTIN_STRATEGIES[0]!;
    expect(strategyContentHash(s)).not.toBe(strategyContentHash({ ...s, horizon: 'position' }));
    expect(BUILTIN_STRATEGIES.find((s) => s.id === 'swing_breakout_retest')).toMatchObject({ horizon: 'swing', status: 'backtest' });
    expect(BUILTIN_STRATEGIES.find((s) => s.id === 'position_breakout_retest')).toMatchObject({ horizon: 'position', status: 'backtest' });
  });
});
