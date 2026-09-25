import { beforeAll, describe, expect, it } from 'vitest';
import { mechanicalFor, summarizeMechanical, type MechanicalRow, type MechanicalTrade } from '../src/mechanical.js';
import { simulateOutcome } from '../src/outcome.js';
import type { EvalCase } from '../src/types.js';
import { kl, synthCases } from './helpers/synthetic.js';

let base: EvalCase;
beforeAll(async () => { base = (await synthCases({ n: 1 })).find((c) => c.tags.includes('base'))!; });

function fixture(short = false): EvalCase {
  const c = structuredClone(base);
  const sign = short ? -1 : 1;
  c.visible.klines['1h'] = Array.from({ length: 60 }, (_, i) => {
    const price = 100 + sign * i;
    return kl(c.as_of - (60 - i) * 3_600_000, price, price + 1, price - 1, price, 100, 3_600_000);
  });
  // ATR = 4, prior 20-bar high/low = 102/98. Entry is 104/96, so risk is 5.2.
  c.visible.klines[c.timeframe] = Array.from({ length: 60 }, (_, i) => kl(c.as_of - (60 - i) * 900_000, 100, 102, 98, 100));
  c.hidden.future_klines = [kl(c.as_of, 100 + sign * 4, short ? 97 : 105, short ? 95 : 103, 100 + sign * 4)];
  return c;
}

describe('mechanical baseline', () => {
  it.each([false, true])('opens at the next bar, uses the 1h direction and swing ± 0.8 ATR (short=%s)', (short) => {
    const trade = mechanicalFor(fixture(short))!;
    expect(trade.direction).toBe(short ? 'short' : 'long');
    expect(trade.fill).toBe(short ? 96 : 104);
    expect(trade.stop).toBeCloseTo(short ? 101.2 : 98.8);
    expect(trade.tp).toBeCloseTo(short ? 88.2 : 111.8);
    expect(trade.r).toBeCloseTo(0);
    expect(trade.status).toBe('expired');
  });

  it('walks the entry bar, with stop first when both stop and TP are touched', () => {
    const c = fixture();
    c.hidden.future_klines = [kl(c.as_of, 104, 113, 98, 104)];
    expect(mechanicalFor(c)).toMatchObject({ status: 'stop', r: -1, bars_walked: 1 });
    c.hidden.future_klines = [kl(c.as_of, 104, 113, 100, 112)];
    expect(mechanicalFor(c)).toMatchObject({ status: 'tp', r: 1.5, bars_walked: 1 });
  });

  it('pays a gap through the stop at the open and caps the hidden horizon', () => {
    const c = fixture();
    c.hidden.future_klines.push(kl(c.as_of + 900_000, 93.6, 95, 92, 94));
    expect(mechanicalFor(c)).toMatchObject({ status: 'stop', r: -2, bars_walked: 2 });
    c.hidden.horizon_bars = 1;
    expect(mechanicalFor(c)).toMatchObject({ status: 'expired', r: 0, bars_walked: 1 });
    c.hidden.horizon_bars = 100;
    c.hidden.future_klines = Array.from({ length: 49 }, (_, i) => kl(c.as_of + i * 900_000, 104, i === 48 ? 200 : 105, 103, 104));
    expect(mechanicalFor(c)).toMatchObject({ status: 'expired', r: 0, bars_walked: 48 });
  });

  it('rejects review, flat/missing trend, insufficient history and absent future', () => {
    const c = fixture();
    expect(mechanicalFor({ ...c, mode: 'review' })).toBeNull();
    c.visible.klines['1h'] = c.visible.klines[c.timeframe]!;
    expect(mechanicalFor(c)).toBeNull();
    c.visible.klines['1h'] = fixture().visible.klines['1h']!.slice(-10);
    expect(mechanicalFor(c)).toBeNull();
    const noFuture = fixture();
    noFuture.hidden.future_klines = [];
    expect(mechanicalFor(noFuture)).toBeNull();
  });

  it('uses no unclosed visible candles and anchors at entry when the swing is on the wrong side', () => {
    const c = fixture();
    const before = mechanicalFor(c);
    c.visible.klines['1h']!.push(kl(c.as_of, 1, 2, 0.5, 1, 100, 3_600_000));
    c.visible.klines[c.timeframe]!.push(kl(c.as_of, 1000, 1001, 999, 1000));
    expect(mechanicalFor(c)).toEqual(before);
    c.hidden.future_klines = [kl(c.as_of, 100, 101, 99, 100)];
    expect(mechanicalFor(c)!.stop).toBeCloseTo(96.8);
  });

  it('reports always, skipped and PROPOSE groups, pairing agent and mechanical on identical cases', () => {
    const m = (r: number): MechanicalTrade => ({ case_id: 'x', direction: 'long', fill: 100, stop: 95, tp: 107.5, r, status: 'expired', bars_walked: 1 });
    const outcome = simulateOutcome({ direction: 'long', entry: 'market', limit_price: null, stop: 95, tp: 110, bars: [kl(base.as_of, 100, 106, 99, 105)] });
    const row = (action: string, r: number | null, o: MechanicalRow['outcome'] = null): MechanicalRow => ({ case_id: 'x', mode: 'scan', action, mechanical: r === null ? null : m(r), outcome: o });
    const s = summarizeMechanical([row('PROPOSE', -1, outcome), row('PROPOSE', 1.5), row('PROPOSE', null, { ...outcome, r: 50 }), row('WATCH', -1), row('NO_TRADE', 0.5)]);
    expect(s.always).toMatchObject({ n: 4, mean_r: 0 });
    expect(s.agent_propose).toMatchObject({ n: 3, agent_mean_r: 1, agent_n_resolved: 1, edge_r: 2, mechanical: { n: 2, mean_r: 0.25 }, paired_mechanical: { n: 1, mean_r: -1 } });
    expect(s.skipped).toMatchObject({ n: 2, mean_r: -0.25 });
    expect(s.selection_edge_r).toBe(0.25);
    expect(summarizeMechanical([row('WATCH', 1)]).agent_propose.edge_r).toBeNull();
    expect(summarizeMechanical([]).always.mean_r).toBeNull();
  });
});
