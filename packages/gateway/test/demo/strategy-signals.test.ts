import { describe, it, expect } from 'vitest';
import { SIGNAL_REGISTRY, closedWeeks, measurable, nextSignalState, type SignalContext } from '../../src/demo/strategy-signals.js';
import { BUILTIN_STRATEGIES } from '../../src/demo/strategies.js';
import type { Kline } from '../../src/demo/types.js';
const bars = (slope = 0.1, scale = 1): Kline[] => Array.from({ length: 150 }, (_, i) => {
  const px = (100 + i * slope) * scale;
  return { open_time: i * 1000, close_time: i * 1000 + 999, open: String(px), close: String(px), high: String(px + scale), low: String(px - scale), volume: '100' };
});
function context(scale: number): SignalContext {
  const base = bars(0.1, scale); const end = base.at(-1)!;
  end.close = String(116 * scale); end.high = String(116.1 * scale); end.volume = '250';
  return { bars: { '15m': base, '1h': bars(0.2, scale), '4h': bars(0.3, scale) }, params: {}, derivatives: null, regime: 'bull', timeframe: '15m', confirmation: ['1h', '4h'], state: { compression_bars: 6, armed: true, last_at: 148999 } };
}
describe('五族确定性信号：价格尺度变化、反例与不可变输入', () => {
  for (const scale of [0.01, 1, 1000]) {
    for (const family of ['trend_continuation', 'mtf', 'volatility'] as const) {
      it(`${family} 正反例 scale=${scale}`, () => {
        const c = context(scale); const before = JSON.stringify(c);
        expect(SIGNAL_REGISTRY[family](c)?.direction).toBe('long');
        expect(JSON.stringify(c)).toBe(before);
        c.bars['15m']!.at(-1)!.close = String(114 * scale);
        expect(SIGNAL_REGISTRY[family](c)).toBeNull();
      });
    }
    it(`derivatives 正反例 scale=${scale}`, () => {
      const c = context(scale);
      c.bars['1h'] = bars(-0.1, scale);
      c.derivatives = { funding: Array.from({ length: 25 }, (_, i) => ({ at: i, rate: i === 24 ? '0.001' : i % 2 ? '0.0001' : '-0.0001' })), oi_change_pct: null };
      expect(SIGNAL_REGISTRY.derivatives(c)?.coverage).toBe('funding_only');
      c.derivatives.oi_change_pct = 2;
      expect(SIGNAL_REGISTRY.derivatives(c)).toBeNull();
    });
    it(`mean_reversion 正反例 scale=${scale}`, () => {
      const c = context(scale); c.regime = 'range'; c.bars['15m'] = bars(0, scale);
      Object.assign(c.bars['15m']!.at(-1)!, { low: String(98.9 * scale), close: String(99.1 * scale), volume: '50' });
      expect(SIGNAL_REGISTRY.mean_reversion(c)?.direction).toBe('long');
      c.regime = 'bull'; expect(SIGNAL_REGISTRY.mean_reversion(c)).toBeNull();
    });
  }
  it('压缩状态跨 episode 保留，首次释放后不重复发信号', () => {
    const c = context(1);
    expect(SIGNAL_REGISTRY.volatility(c)).not.toBeNull();
    const state = nextSignalState(c); expect(state.armed).toBe(false);
    expect(SIGNAL_REGISTRY.volatility({ ...c, state })).toBeNull();
    expect(nextSignalState({ ...c, state })).toEqual(state);
  });
  it('周线只输出完整 UTC 周；周内未来日线不改变历史结果', () => {
    const monday = Date.UTC(2026, 0, 5); const day = 86400000;
    const days = bars(0.1).slice(0, 14).map((b, i) => ({ ...b, open_time: monday + i * day, close_time: monday + (i + 1) * day - 1 }));
    expect(closedWeeks(days, monday + 6 * day)).toHaveLength(0);
    expect(closedWeeks(days, monday + 10 * day)).toHaveLength(1);
    expect(closedWeeks(days, monday + 14 * day)).toHaveLength(2);
    expect(closedWeeks(days, monday + 10 * day)).toEqual(closedWeeks(days.slice(0, 10), monday + 10 * day));
  });
  it('所有内置族可测；未知必需指标拒绝', () => {
    expect(BUILTIN_STRATEGIES.every(measurable)).toBe(true);
    const s = BUILTIN_STRATEGIES[0]!;
    expect(measurable({ ...s, checklist: { ...s.checklist, required: ['future_news'] } })).toBe(false);
  });
});
