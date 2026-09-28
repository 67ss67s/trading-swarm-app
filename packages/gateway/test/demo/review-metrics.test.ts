// v4 boundary metrics: the numbers behind the two decisions the model kept flipping on
// (docs/eval/results-2026-09-04.md 「v4:边界规则化」). The point of these is that CODE decides them,
// so the tests pin the arithmetic and the two booleans the system rules key off.

import { describe, expect, it } from 'vitest';
import { parseInvalidationPrice, reviewMetrics, scanChecklist, trendAgreement } from '../../src/demo/review-metrics.js';
import { buildContext } from '../../src/demo/context.js';
import { PROMPT_VERSION } from '../../src/demo/context.js';
import { newThread } from '../../src/demo/threads.js';
import type { TfFeatures } from '../../src/demo/market.js';
import type { AccountView, MarketView, StrategyThread } from '../../src/demo/types.js';

const NOW = Date.UTC(2026, 7, 2, 23, 0);

function feat(tf: string, over: Partial<TfFeatures> = {}): TfFeatures {
  return {
    tf,
    last_close: 63500,
    last_open_time: NOW - 900_000,
    ema20: 63400,
    ema50: 63200,
    atr14: 100,
    swing_high_20: 63600,
    swing_low_20: 63000,
    swing_high_50: 63800,
    swing_low_50: 62800,
    dist_to_high20_pct: 0.16,
    dist_to_low20_pct: 0.79,
    vol_ratio_20: 0.8,
    change_pct_last: 0.1,
    change_pct_5: 0.4,
    last_bars: '…',
    ...over,
  };
}

describe('scanChecklist (NO_TRADE ↔ WATCH boundary)', () => {
  it('watch_eligible = 1h/4h agree AND ≤ 1.5 ATR from the level AND retest not confirmed', () => {
    // 1h/4h both bullish, close 63500 is 1 ATR under the 20-bar high 63600, no breakout yet → WATCH is allowed.
    const ok = scanChecklist([feat('15m'), feat('1h'), feat('4h')])!;
    expect(ok.trend_agree).toBe('long');
    expect(ok.dist_to_break_atr).toBeCloseTo(1);
    expect(ok.retest_confirmed).toBe(false);
    expect(ok.watch_eligible).toBe(true);
    expect(ok.text).toContain('watch_eligible=是');

    // 4h pointing the other way → no agreement → NO_TRADE.
    const split = scanChecklist([feat('15m'), feat('1h'), feat('4h', { ema20: 63100, ema50: 63400 })])!;
    expect(split.trend_agree).toBeNull();
    expect(split.watch_eligible).toBe(false);

    // Same trend but the level is 3 ATR away → out of range → NO_TRADE.
    const far = scanChecklist([feat('15m', { swing_high_20: 63800 }), feat('1h'), feat('4h')])!;
    expect(far.dist_to_break_atr).toBeCloseTo(3);
    expect(far.within_chase).toBe(false);
    expect(far.watch_eligible).toBe(false);

    // Already closed above the level on volume → retest confirmed → the PROPOSE branch, not WATCH.
    const done = scanChecklist([feat('15m', { last_close: 63700, vol_ratio_20: 1.4 }), feat('1h'), feat('4h')])!;
    expect(done.retest_confirmed).toBe(true);
    expect(done.watch_eligible).toBe(false);
  });

  it('chase distance is measured to the 20-bar extreme BEFORE the last bar, same level as the breakout test (09-27)', () => {
    // Breakout bar: prior-20 high 63400, this bar spiked to 63750 and closed 63700 on thin volume.
    // Old (inclusive) level = 63750 → distance 0.5 ATR, "in range" → WATCH. Now: 63700 − 63400 = 3 ATR → out of range.
    const brk = scanChecklist([feat('15m', { last_close: 63700, swing_high_20: 63750, swing_high_20_prev: 63400, vol_ratio_20: 0.6 }), feat('1h'), feat('4h')])!;
    expect(brk.dist_to_break_atr).toBeCloseTo(3);
    expect(brk.within_chase).toBe(false);
    expect(brk.retest_confirmed).toBe(false); // broke out, but volume below the retest floor
    expect(brk.watch_eligible).toBe(false);
    expect(brk.text).toContain('突破位(前 20 根高,不含当根) 63400');
    // Same bar on volume: retest confirmed, but the distance still reads 3 ATR (used to be 0.5).
    const confirmed = scanChecklist([feat('15m', { last_close: 63700, swing_high_20: 63750, swing_high_20_prev: 63400, vol_ratio_20: 1.4 }), feat('1h'), feat('4h')])!;
    expect(confirmed.retest_confirmed).toBe(true);
    expect(confirmed.dist_to_break_atr).toBeCloseTo(3);
    expect(confirmed.within_chase).toBe(false);
    // Wick above the prior high but closed back below it: distance to the prior high, not to the wick.
    const wick = scanChecklist([feat('15m', { last_close: 63500, swing_high_20: 63900, swing_high_20_prev: 63600 }), feat('1h'), feat('4h')])!;
    expect(wick.dist_to_break_atr).toBeCloseTo(1);
    expect(wick.within_chase).toBe(true);
    expect(wick.watch_eligible).toBe(true);
    // Short side mirrors it.
    const down = { ema20: 63200, ema50: 63400 };
    const shortBrk = scanChecklist([feat('15m', { ...down, last_close: 63000, swing_low_20: 62950, swing_low_20_prev: 63300, vol_ratio_20: 0.6 }), feat('1h', down), feat('4h', down)])!;
    expect(shortBrk.trend_agree).toBe('short');
    expect(shortBrk.dist_to_break_atr).toBeCloseTo(3);
    expect(shortBrk.within_chase).toBe(false);
    // Features recorded before `_prev` existed fall back to the inclusive field (the 'far' case above relies on it).
    const legacy = scanChecklist([feat('15m', { swing_high_20: 63650 }), feat('1h'), feat('4h')])!;
    expect(legacy.dist_to_break_atr).toBeCloseTo(1.5);
  });

  it('reports the ATR% floor as a checked box, not as part of watch_eligible', () => {
    // The floor is per timeframe now (ATR_PCT_FLOOR): 0.15 % on 15m, 0.6 % on 4h. 0.157 % clears the
    // 15m bar and misses the 4h one — the whole point of dropping the single 0.4 % number.
    const low = scanChecklist([feat('15m', { atr14: 80 }), feat('1h'), feat('4h')])!;
    expect(low.atr_pct).toBeCloseTo(0.126, 3);
    expect(low.atr_floor).toBe(0.15);
    expect(low.atr_ok).toBe(false);
    expect(low.text).toContain('门槛 0.15% → 不足');
    const hi = scanChecklist([feat('15m', { atr14: 400 }), feat('1h'), feat('4h')])!;
    expect(hi.atr_ok).toBe(true);
    const sameOn4h = scanChecklist([feat('4h', { atr14: 100 }), feat('1h'), feat('4h')])!;
    expect(sameOn4h.atr_floor).toBe(0.6);
    expect(sameOn4h.atr_ok).toBe(false);
    const okOn15m = scanChecklist([feat('15m', { atr14: 100 }), feat('1h'), feat('4h')])!;
    expect(okOn15m.atr_ok).toBe(true);
  });

  it('trendAgreement needs both 1h and 4h present', () => {
    expect(trendAgreement([feat('15m'), feat('1h')])).toBeNull();
    expect(trendAgreement([feat('15m'), feat('1h'), feat('4h')])).toBe('long');
  });
});

describe('reviewMetrics (HOLD ↔ EXIT boundary)', () => {
  const base = {
    now: NOW,
    side: 'short' as const,
    status: 'in_position' as const,
    mark: '63515.00',
    entry: '63571.20',
    entry_zone: null,
    stop: '63820.86',
    take_profits: ['63071.88'],
    invalidation_text: '15m 收盘升破止损 63820.86',
    opened_at: NOW - 4 * 900_000,
    created_at: NOW - 4 * 900_000,
    tf_ms: 900_000,
    features: [feat('15m'), feat('1h'), feat('4h')],
  };

  it('computes R, distances, holding time and the closed-candle triggers', () => {
    const m = reviewMetrics(base)!;
    expect(m.risk_per_unit).toBeCloseTo(249.66, 2);
    expect(m.unrealized_r).toBeCloseTo((63571.2 - 63515) / 249.66, 4);
    expect(m.dist_to_stop_r).toBeCloseTo((63820.86 - 63515) / 249.66, 4);
    expect(m.dist_to_stop_pct).toBeCloseTo(((63820.86 - 63515) / 63515) * 100, 4);
    expect(m.tp1_from_entry_r).toBeCloseTo(2, 2);
    expect(m.bars_held).toBe(4);
    expect(m.minutes_held).toBe(60);
    // Last closed candle at 63500 is still under the short's stop → no EXIT trigger.
    expect(m.closed_beyond_stop).toBe(false);
    expect(m.invalidation_price).toBeCloseTo(63820.86, 2);
    expect(m.closed_beyond_invalidation).toBe(false);
    // The exact R unit must be quotable: it is the number the model used to invent (249.66).
    expect(m.text).toContain('249.66');
  });

  it('flags a close beyond the stop (the ① EXIT trigger)', () => {
    const m = reviewMetrics({ ...base, features: [feat('15m', { last_close: 63900 }), feat('1h'), feat('4h')] })!;
    expect(m.closed_beyond_stop).toBe(true);
    expect(m.closed_beyond_invalidation).toBe(true);
    expect(m.text).toContain('已越过止损');
  });

  it('v7: invalidation crossing is counted in consecutive closed bars and ATR depth; confirmation follows the workflow/default 口径', () => {
    // short thread, invalidation 63820.86, ATR 100. One close 10 above the line → beyond but 0.10 ATR deep, 1 bar → not confirmed (default 2 bars / 0.2 ATR).
    const k = (c: number) => ({ close: String(c), close_time: NOW - 1 }) as unknown as import('../../src/demo/types.js').Kline;
    const one = reviewMetrics({ ...base, features: [feat('15m', { last_close: 63830.86 }), feat('1h'), feat('4h')], klines: [k(63500), k(63700), k(63830.86)] })!;
    expect(one.closed_beyond_invalidation).toBe(true);
    expect(one.bars_beyond_invalidation).toBe(1);
    expect(one.invalidation_depth_atr).toBeCloseTo(0.1, 4);
    expect(one.invalidation_confirmed).toBe(false);
    expect(one.text).toContain('失效确认=否');
    expect(one.text).toContain('连续 1 根');
    // Two consecutive closes 30 above → 2 bars, 0.30 ATR → confirmed.
    const two = reviewMetrics({ ...base, features: [feat('15m', { last_close: 63850.86 }), feat('1h'), feat('4h')], klines: [k(63500), k(63840), k(63850.86)] })!;
    expect(two.bars_beyond_invalidation).toBe(2);
    expect(two.invalidation_confirmed).toBe(true);
    expect(two.text).toContain('失效确认=是');
    // The workflow can demand 3 bars → the same data is not confirmed; buffer 0 with 1 bar → confirmed.
    expect(reviewMetrics({ ...base, features: [feat('15m', { last_close: 63850.86 }), feat('1h'), feat('4h')], klines: [k(63500), k(63840), k(63850.86)], invalidation_confirm_bars: 3 })!.invalidation_confirmed).toBe(false);
    expect(reviewMetrics({ ...base, features: [feat('15m', { last_close: 63830.86 }), feat('1h'), feat('4h')], klines: [k(63830.86)], invalidation_confirm_bars: 1, invalidation_buffer_atr: 0 })!.invalidation_confirmed).toBe(true);
    // No klines → falls back to the last close only (1 bar at most).
    const noK = reviewMetrics({ ...base, features: [feat('15m', { last_close: 63900 }), feat('1h'), feat('4h')] })!;
    expect(noK.bars_beyond_invalidation).toBe(1);
    // Distance from entry to the invalidation line is quoted in ATR and R so the model can see a line sitting inside one bar's noise.
    expect(one.text).toMatch(/距入场 2\.50 ATR=1\.00R/);
  });

  it('signs unrealized R by side and marks structure turning against the thread', () => {
    const long = reviewMetrics({ ...base, side: 'long', mark: '63200.00', entry: '63500.00', stop: '63250.00', take_profits: ['64000'] })!;
    expect(long.unrealized_r).toBeCloseTo((63200 - 63500) / 250, 4);
    expect(long.dist_to_stop_r).toBeCloseTo((63200 - 63250) / 250, 4);
    expect(long.structure_against).toBe(false); // 1h/4h bullish, close above EMA20
    const against = reviewMetrics({ ...base, side: 'long', features: [feat('15m', { last_close: 63300 }), feat('1h', { ema20: 63100, ema50: 63400 }), feat('4h', { ema20: 63100, ema50: 63400 })] })!;
    expect(against.structure_against).toBe(true);
    expect(against.text).toContain('结构转弱=是');
  });

  it('pending entries report the zone instead of unrealized R', () => {
    const m = reviewMetrics({ ...base, status: 'pending_entry', opened_at: null, entry: '63400.00', entry_zone: ['63400.00', '63600.00'] })!;
    expect(m.in_entry_zone).toBe(true);
    expect(m.text).toContain('挂单未成交');
    expect(m.text).toContain('现价在入场区');
    const outside = reviewMetrics({ ...base, status: 'pending_entry', opened_at: null, mark: '62000.00', entry: '63400.00', entry_zone: ['63400.00', '63600.00'] })!;
    expect(outside.in_entry_zone).toBe(false);
  });

  it('parseInvalidationPrice only accepts a level near the entry', () => {
    expect(parseInvalidationPrice('15m 收盘升破 63820.86', 63571)).toBeCloseTo(63820.86, 2);
    expect(parseInvalidationPrice('连续 3 根收在 EMA20 下', 63571)).toBeNull();
    expect(parseInvalidationPrice(null, 63571)).toBeNull();
    expect(parseInvalidationPrice('跌破 100', 63571)).toBeNull();
  });
});

describe('buildContext v4 wiring', () => {
  const market: MarketView = { symbol: 'BTCUSDT', last: '63515.0', mark: '63515.0', funding_rate: '0.0001', next_funding_at: NOW + 3_600_000, open_interest: '1000', as_of: NOW } as unknown as MarketView;
  const account: AccountView = { equity: '10000', available: '9000', unrealized_pnl: '0', positions: [], open_orders: [], as_of: NOW, backend: 'demo' } as unknown as AccountView;
  const inputs = {
    now: NOW,
    symbol: 'BTCUSDT',
    trigger: { kind: 'kline_close' as const, detail: '15m 收盘' },
    open_threads: [],
    account,
    market,
    features: [feat('15m'), feat('1h'), feat('4h')],
    oi_change_1h_pct: 0.5,
    ticker24h: { priceChangePercent: '1.2', highPrice: '64000', lowPrice: '62000', quoteVolume: '1000000000' },
    market_state: null,
    playbook_text: 'pb',
    last_judgment_summary: null,
    halted: false,
  };

  it('is version demo-playbook-v11.2-stopfloor and states the asymmetric rule 8 + the fixed breakout wording', () => {
    expect(PROMPT_VERSION).toBe('demo-playbook-v11.2-stopfloor');
    const built = buildContext({ ...inputs, mode: 'scan', thread: null });
    expect(built.system_text).toContain('watch_eligible=是');
    // v10:派生数字必须带**公式**来源标注(规则 2b/2c),代码按字段级引用复算(09-12 P1-16:只给编号不再算数)。
    expect(built.system_text).toContain('(由 <公式> 算出)');
    expect(built.system_text).toContain('E<编号>.<字段名>');
    expect(built.system_text).toContain('(由 E3,E7 算出)');
    expect(built.system_text).toContain('(只给编号、不给公式)不再算复算通过');
    expect(built.system_text).toContain('带符号');
    // v6 rule 8 is asymmetric: a hard FLOOR (must exit) and an allowance, never a numeric ceiling.
    expect(built.system_text).toContain('不对称');
    expect(built.system_text).toContain('必须 EXIT');
    expect(built.system_text).toContain('可以 EXIT');
    expect(built.system_text).toContain('论点趋势翻转=是');
    // v7: the invalidation line is no longer a hard exit; only the stop is.
    expect(built.system_text).toContain('止损是唯一的硬离场线');
    expect(built.system_text).toContain('失效确认=是');
    expect(built.system_text).not.toMatch(/或失效价「已越过」。此时无条件离场/);
    expect(built.system_text).toContain('不设必须先亏到某个 R 才准离场的门槛');
    expect(built.system_text).toContain('+1R');
    expect(built.system_text).toContain('INVALIDATE 只用于挂单未成交的线程');
    // v5's numeric exit threshold is gone — that is the change v6 is making (−6.4R on 42 cases).
    expect(built.system_text).not.toMatch(/[−-]0\.8R/);
    expect(built.system_text).toContain('浮盈 ≤ 0R');
    expect(built.system_text).toContain('符合条件才给出 proposal');
    // rule 7 keeps the WATCH gate but now points at the FIXED breakout 口径 and demands a PROPOSE decision.
    expect(built.system_text).toContain('前 20 根(不含当根)');
    expect(built.system_text).toContain('回踩确认=是');
  });

  it('registers the scan checklist on scan and the position metrics on review', () => {
    const scan = buildContext({ ...inputs, mode: 'scan', thread: null });
    const chk = scan.evidence.filter((e) => e.kind === 'checklist');
    expect(chk).toHaveLength(1);
    expect(chk[0]!.value).toContain('watch_eligible=');
    expect(scan.evidence.some((e) => e.kind === 'position')).toBe(false);

    const thread: StrategyThread = {
      ...newThread({ id: 't1', symbol: 'BTCUSDT', side: 'short', source: 'agent', timeframe: '15m', thesis: 'x', invalidation_text: '15m 收盘升破 63820.86', watch_conditions: [], entry: { type: 'market', price: null, zone: null }, stop_price: '63820.86', take_profits: ['63071.88'], qty: '0.2', margin_usdt: null, leverage: 3, margin_mode: 'cross', now: NOW - 3_600_000 }),
      status: 'in_position',
      filled_avg_price: '63571.20',
      opened_at: NOW - 3_600_000,
    };
    const review = buildContext({ ...inputs, mode: 'review', thread, open_threads: [thread] });
    const pos = review.evidence.filter((e) => e.label === '持仓度量(代码计算)');
    expect(pos).toHaveLength(1);
    expect(pos[0]!.label).toBe('持仓度量(代码计算)');
    expect(pos[0]!.value).toContain('249.66');
    expect(review.evidence.some((e) => e.kind === 'checklist')).toBe(false);
    expect(review.user_text).not.toContain('INVALIDATE(失效即平)');
  });
});

describe('thesis_trend_flipped (v6 rule 8「论点已破」)', () => {
  const base = {
    now: NOW,
    status: 'in_position' as const,
    mark: '63500',
    entry: '63400',
    entry_zone: null,
    stop: '63300',
    take_profits: ['63700'],
    invalidation_text: null,
    opened_at: NOW - 3_600_000,
    created_at: NOW - 3_600_000,
    tf_ms: 900_000,
  };
  // feat() is bullish by default (ema20 63400 > ema50 63200); this is the bearish mirror of it.
  const bear = (tf: string): TfFeatures => feat(tf, { ema20: 63200, ema50: 63400 });

  it('is false while the entry timeframe and 1h still point with the position', () => {
    const m = reviewMetrics({ ...base, side: 'long', features: [feat('15m'), feat('1h'), feat('4h')] })!;
    expect(m.trend_now_15m).toBe('long');
    expect(m.trend_now_h1).toBe('long');
    expect(m.thesis_trend_flipped).toBe(false);
    expect(m.text).toContain('论点趋势翻转=否');
  });

  it('is true when the entry timeframe flipped against a long', () => {
    const m = reviewMetrics({ ...base, side: 'long', features: [bear('15m'), feat('1h'), feat('4h')] })!;
    expect(m.trend_now_15m).toBe('short');
    expect(m.thesis_trend_flipped).toBe(true);
    expect(m.text).toContain('论点趋势翻转=是');
  });

  it('is true when only 1h flipped against a long, and symmetric for a short', () => {
    const onlyH1 = reviewMetrics({ ...base, side: 'long', features: [feat('15m'), bear('1h'), feat('4h')] })!;
    expect(onlyH1.thesis_trend_flipped).toBe(true);
    // A short whose timeframes are all bullish is the mirror case.
    const short = reviewMetrics({ ...base, side: 'short', features: [feat('15m'), feat('1h'), feat('4h')] })!;
    expect(short.thesis_trend_flipped).toBe(true);
    const shortOk = reviewMetrics({ ...base, side: 'short', features: [bear('15m'), bear('1h'), bear('4h')] })!;
    expect(shortOk.thesis_trend_flipped).toBe(false);
  });

  it('uses 15m and 1h by name, regardless of feature order or a different judged timeframe', () => {
    const m = reviewMetrics({ ...base, side: 'long', features: [feat('5m'), feat('4h'), feat('1h'), bear('15m')] })!;
    expect(m.thesis_trend_flipped).toBe(true);
    const unrelated = reviewMetrics({ ...base, side: 'long', features: [bear('5m'), bear('4h')] })!;
    expect(unrelated.thesis_trend_flipped).toBe(false);
    expect(unrelated.trend_now_15m).toBeNull();
    expect(unrelated.trend_now_h1).toBeNull();
  });

  it('a flat EMA read never fires the flag (null direction is not "against")', () => {
    const flat = (tf: string): TfFeatures => feat(tf, { ema20: 63300, ema50: 63300 });
    const m = reviewMetrics({ ...base, side: 'long', features: [flat('15m'), flat('1h'), flat('4h')] })!;
    expect(m.trend_now_15m).toBeNull();
    expect(m.thesis_trend_flipped).toBe(false);
  });

  it('the review evidence line carries the flag so rule 8 can point at it', () => {
    const m = reviewMetrics({ ...base, side: 'long', features: [bear('15m'), bear('1h'), feat('4h')] })!;
    expect(m.text).toContain('论点趋势:15m');
    expect(m.text).toContain('论点趋势翻转=是');
  });
});
