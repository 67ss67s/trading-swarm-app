import { demo } from '@trade-gate/gateway';
import { describe, expect, it } from 'vitest';
import { counterfactualFor, regimeAgreement, regimeRow, summarizeCounterfactual, type Counterfactual } from '../src/index.js';
import type { EvalCase, Judgment, Kline, StrategyThread } from '../src/index.js';
import { kl } from './helpers/synthetic.js';

const T = 1_700_000_000_000;
const bar = (i: number, o: number, h: number, l: number, c: number): Kline => kl(T + i * 900_000, o, h, l, c);

/** A long thread entered at 100 with a 5-wide stop and a take-profit 1.5 R away (107.5). */
function thread(over: Partial<StrategyThread> = {}): StrategyThread {
  const t = demo.newThread({
    id: 'thr-test',
    symbol: 'BTCUSDT',
    side: 'long',
    source: 'agent',
    timeframe: '15m',
    thesis: 'test',
    invalidation_text: null,
    watch_conditions: [],
    entry: { type: 'market', price: null, zone: null },
    stop_price: '95.00',
    take_profits: ['107.50'],
    qty: '1',
    margin_usdt: '100',
    leverage: 3,
    margin_mode: 'cross',
    now: T,
  });
  return { ...t, status: 'in_position', filled_avg_price: '100.00', ...over };
}

/** Minimal review case: only the fields the counterfactual reads are meaningful. */
function reviewCase(t: StrategyThread, asOfClose: number, future: Kline[], klines1d: Kline[] = []): EvalCase {
  const visibleKlines: Record<string, Kline[]> = { '15m': [bar(-1, asOfClose, asOfClose, asOfClose, asOfClose)] };
  if (klines1d.length) visibleKlines['1d'] = klines1d;
  return {
    id: 'case-1',
    set: 'test',
    tags: ['review'],
    symbol: 'BTCUSDT',
    timeframe: '15m',
    as_of: T,
    mode: 'review',
    thread: t,
    visible: {
      klines: visibleKlines,
      market: { symbol: 'BTCUSDT', last: asOfClose.toFixed(2), mark: asOfClose.toFixed(2), funding_rate: '0.0001', next_funding_at: T + 3_600_000, open_interest: '1000', as_of: T, klines_tf: '15m' },
      ticker24h: { priceChangePercent: '0', highPrice: '110', lowPrice: '90', quoteVolume: '1000' },
      oi_change_1h_pct: null,
      market_state: null,
      account: { backend: 'paper', equity: '10000.00', available: '10000.00', unrealized_pnl: '0.00', positions: [], open_orders: [], as_of: T },
      playbook_text: '',
      last_judgment_summary: null,
      halted: false,
      stale_all: false,
    },
    hidden: { future_klines: future, horizon_bars: future.length, rubric: null, mirror_of: null },
  };
}

const judge = (action: Judgment['action']): Judgment => ({ action, direction: null, confidence: 0.6, headline: '', thesis: '', reasons: [], evidence_refs: [], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [], proposal: null });

describe('review counterfactual R', () => {
  it('HOLD into the stop is −1R; exiting at the as_of close is the smaller loss', () => {
    // as_of close 99 (−0.2R), then the next bars take out the 95 stop.
    const c = reviewCase(thread(), 99, [bar(0, 99, 100, 94, 96), bar(1, 96, 97, 93, 94)]);
    const cf = counterfactualFor(c, judge('HOLD'))!;
    expect(cf.hold_r).toBe(-1);
    expect(cf.hold_status).toBe('stop');
    expect(cf.exit_now_r).toBeCloseTo(-0.2, 6);
    expect(cf.chosen_r).toBe(-1);
    expect(cf.best_action).toBe('EXIT');
    expect(cf.best_r).toBeCloseTo(-0.2, 6);
    expect(cf.regret_r).toBeCloseTo(0.8, 6);
    expect(cf.better_side).toBe('exit');
    expect(cf.chose_best).toBe(false);
  });

  it('HOLD into the take-profit pays the TP distance in R (107.5 over a 5-wide stop = +1.5R)', () => {
    const c = reviewCase(thread(), 101, [bar(0, 101, 104, 100, 103), bar(1, 103, 108, 102, 107)]);
    const cf = counterfactualFor(c, judge('HOLD'))!;
    expect(cf.hold_r).toBeCloseTo(1.5, 6);
    expect(cf.hold_status).toBe('tp');
    expect(cf.exit_now_r).toBeCloseTo(0.2, 6);
    expect(cf.best_action).toBe('HOLD');
    expect(cf.regret_r).toBe(0);
    expect(cf.chose_best).toBe(true);
  });

  it('neither side touched → mark-to-market at the horizon end, and EXIT/REDUCE are priced off the same R', () => {
    const c = reviewCase(thread(), 99, [bar(0, 99, 101, 98, 100), bar(1, 100, 103, 99, 102.5)]);
    const hold = counterfactualFor(c, judge('HOLD'))!;
    expect(hold.hold_status).toBe('expired');
    expect(hold.hold_r).toBeCloseTo(0.5, 6); // (102.5 − 100) / 5
    expect(hold.exit_now_r).toBeCloseTo(-0.2, 6);
    const exit = counterfactualFor(c, judge('EXIT'))!;
    expect(exit.chosen_r).toBeCloseTo(-0.2, 6);
    expect(exit.regret_r).toBeCloseTo(0.7, 6);
    expect(exit.judged_side).toBe('exit');
    const reduce = counterfactualFor(c, judge('REDUCE'))!;
    expect(reduce.chosen_r).toBeCloseTo(0.15, 6); // half hold, half exit
    expect(reduce.judged_side).toBe('mixed');
    expect(reduce.regret_r).toBeCloseTo(0.35, 6);
  });

  it('a pending order that never fills is 0R either way; one that fills walks the same rules', () => {
    const pending = thread({ status: 'pending_entry', filled_avg_price: null, entry: { type: 'limit', price: '100.00', zone: null } });
    const never = reviewCase(pending, 105, [bar(0, 105, 107, 104, 106), bar(1, 106, 108, 105, 107)]);
    const keep = counterfactualFor(never, judge('HOLD'))!;
    expect(keep.thread_status).toBe('pending_entry');
    expect(keep.hold_status).toBe('unfilled');
    expect(keep.keep_r).toBe(0);
    expect(keep.invalidate_r).toBe(0);
    expect(keep.regret_r).toBe(0);
    expect(counterfactualFor(never, judge('INVALIDATE'))!.regret_r).toBe(0);

    const filled = reviewCase(pending, 105, [bar(0, 104, 105, 99, 100), bar(1, 100, 108, 99.5, 107.6)]);
    const kept = counterfactualFor(filled, judge('HOLD'))!;
    expect(kept.hold_status).toBe('tp');
    expect(kept.keep_r).toBeCloseTo(1.5, 6);
    expect(kept.best_action).toBe('HOLD');
    const cancelled = counterfactualFor(filled, judge('INVALIDATE'))!;
    expect(cancelled.chosen_r).toBe(0);
    expect(cancelled.regret_r).toBeCloseTo(1.5, 6);
    expect(cancelled.best_action).toBe('HOLD');
  });

  it('is not scoreable on scan cases, closed threads or a thread without a stop', () => {
    const c = reviewCase(thread(), 99, [bar(0, 99, 100, 98, 99)]);
    expect(counterfactualFor({ ...c, mode: 'scan', thread: null }, judge('NO_TRADE'))).toBeNull();
    expect(counterfactualFor({ ...c, thread: { ...c.thread!, status: 'closed' } }, judge('HOLD'))).toBeNull();
    expect(counterfactualFor({ ...c, thread: { ...c.thread!, stop_price: null } }, judge('HOLD'))).toBeNull();
    expect(counterfactualFor({ ...c, hidden: { ...c.hidden, future_klines: [] } }, judge('HOLD'))).toBeNull();
  });
});

describe('counterfactual aggregation', () => {
  const cf = (over: Partial<Counterfactual>): Counterfactual => ({
    case_id: 'x',
    thread_status: 'in_position',
    side: 'long',
    hold_r: 0,
    exit_now_r: 0,
    keep_r: null,
    invalidate_r: null,
    hold_status: 'expired',
    best_action: 'HOLD',
    best_r: 0,
    chosen_action: 'HOLD',
    chosen_r: 0,
    regret_r: 0,
    judged_side: 'hold',
    better_side: 'hold',
    chose_best: true,
    note: '',
    ...over,
  });

  it('means regret, fills the 2×2 and prices the road not taken', () => {
    const rows = [
      // judged HOLD, holding was right (+2 vs 0)
      cf({ case_id: 'a', hold_r: 2, exit_now_r: 0, best_r: 2, chosen_r: 2, regret_r: 0, better_side: 'hold', chose_best: true }),
      // judged HOLD, exiting was right (−1 vs 0)
      cf({ case_id: 'b', hold_r: -1, exit_now_r: 0, best_action: 'EXIT', best_r: 0, chosen_r: -1, regret_r: 1, better_side: 'exit', chose_best: false }),
      // judged EXIT, exiting was right
      cf({ case_id: 'c', chosen_action: 'EXIT', judged_side: 'exit', hold_r: -2, exit_now_r: -0.5, best_action: 'EXIT', best_r: -0.5, chosen_r: -0.5, regret_r: 0, better_side: 'exit', chose_best: true }),
      // judged EXIT, holding was right
      cf({ case_id: 'd', chosen_action: 'EXIT', judged_side: 'exit', hold_r: 1, exit_now_r: 0.5, best_action: 'HOLD', best_r: 1, chosen_r: 0.5, regret_r: 0.5, better_side: 'hold', chose_best: false }),
      // REDUCE sits outside the 2×2
      cf({ case_id: 'e', chosen_action: 'REDUCE', judged_side: 'mixed', hold_r: 1, exit_now_r: 0, best_r: 1, chosen_r: 0.5, regret_r: 0.5, chose_best: false }),
    ];
    const s = summarizeCounterfactual(rows);
    expect(s.n).toBe(5);
    expect(s.mean_regret_r).toBeCloseTo(0.4, 6);
    expect(s.median_regret_r).toBeCloseTo(0.5, 6);
    expect(s.chose_best_share).toBeCloseTo(0.4, 6);
    expect(s.matrix).toEqual({ hold_hold: 1, hold_exit: 1, exit_hold: 1, exit_exit: 1, mixed: 1 });
    // judged EXIT: mean(hold − exit_now) over c and d = ((−2 − −0.5) + (1 − 0.5)) / 2 = −0.5
    expect(s.hold_instead_of_exit_r).toBeCloseTo(-0.5, 6);
    // judged HOLD: mean(exit_now − hold) over a and b = ((0 − 2) + (0 − −1)) / 2 = −0.5
    expect(s.exit_instead_of_hold_r).toBeCloseTo(-0.5, 6);
    expect(s.by_action['HOLD']).toEqual({ n: 2, mean_regret_r: 0.5, mean_chosen_r: 0.5, mean_best_r: 1, chose_best: 1 });
    expect(s.worst[0]!.case_id).toBe('b');
  });

  it('is empty-safe', () => {
    const s = summarizeCounterfactual([]);
    expect(s.n).toBe(0);
    expect(s.mean_regret_r).toBeNull();
    expect(s.chose_best_share).toBeNull();
    expect(s.matrix).toEqual({ hold_hold: 0, hold_exit: 0, exit_hold: 0, exit_exit: 0, mixed: 0 });
  });
});

describe('regime_agreement', () => {
  /**
   * Daily bars that make `demo.dailyRegime` stack the EMAs and call a trend: a choppy first stretch (so the
   * recent 20-day realized vol is NOT the highest window — otherwise the regime comes out `volatile`) and
   * then a steady march in the wanted direction.
   */
  const daily = (up: boolean): Kline[] => {
    const closes: number[] = [];
    for (let i = 0; i < 50; i++) closes.push(i < 12 ? 260 + (i % 2 ? 1 : -1) * 14 : 260 + (up ? 2 : -2) * (i - 12));
    return closes.map((p, i) => ({ open_time: T - (closes.length - i) * 86_400_000, open: p.toFixed(2), high: (p * 1.01).toFixed(2), low: (p * 0.99).toFixed(2), close: p.toFixed(2), volume: '100', close_time: T - (closes.length - i) * 86_400_000 + 86_399_999 }));
  };

  it('scores a directional judgment against the daily bias and skips what it cannot score', () => {
    const bull = reviewCase(thread(), 99, [bar(0, 99, 100, 98, 99)], daily(true));
    expect(demo.dailyRegime(bull.visible.klines['1d']!, bull.as_of)!.regime).toBe('bull');
    const agreeing = regimeRow(bull, { ...judge('HOLD'), direction: 'long' });
    expect(agreeing).toMatchObject({ regime: 'bull', bias: 'long', stance: 'long', stance_from: 'judgment', agree: true });
    expect(regimeRow(bull, { ...judge('HOLD'), direction: 'short' }).agree).toBe(false);

    // No direction on a HOLD → the stance row records the thread side, but it is NOT scored: the thread's
    // side was chosen by the case generator, scoring it measured the generator (pi-v6r-design-s1, 0/14).
    const fromThread = regimeRow(bull, judge('HOLD'));
    expect(fromThread).toMatchObject({ stance: 'long', stance_from: 'thread', agree: null });
    // EXIT expresses no stance, so it is counted but not scored.
    expect(regimeRow(bull, judge('EXIT')).agree).toBeNull();
    // No 1d klines at all → nothing to compare against.
    expect(regimeRow(reviewCase(thread(), 99, [bar(0, 99, 100, 98, 99)]), judge('HOLD')).regime).toBeNull();

    const bear = reviewCase({ ...thread(), side: 'short' }, 99, [bar(0, 99, 100, 98, 99)], daily(false));
    expect(regimeRow(bear, { ...judge('HOLD'), direction: 'short' }).agree).toBe(true);

    const summary = regimeAgreement([agreeing, regimeRow(bull, { ...judge('HOLD'), direction: 'short' }), regimeRow(bull, judge('EXIT'))], 3);
    expect(summary.scored).toBe(2);
    expect(summary.agree).toBe(1);
    expect(summary.agreement).toBeCloseTo(0.5, 6);
    expect(summary.by_regime['bull']).toEqual({ n: 3, scored: 2, agree: 1 });
    expect(summary.unscored_reason.no_stance).toBe(1);
  });
});
