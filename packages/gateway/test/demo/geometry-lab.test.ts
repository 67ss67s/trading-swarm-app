// Geometry Lab (docs/research/geometry-lab-2026-09-23.md): the zero-model machinery that every arm shares.
// If any of these fail, the experiment's numbers are not trustworthy: leakage, arm A drift, a wrong level menu,
// a hallucination slipping through, or settlement semantics that differ from outcome.ts.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { piBrain, stubBrain } from '../../src/demo/brain.js';
import { structure } from '../../src/demo/research/primitives/structure.js';
import { armA, assertVisible, enumerateLevels, findCandidates, pivots, resolvePick, rng, settlePlan, settleTrail, stopRule, tfFeatures, viewAt, type ArmRow, type Bar, type Geometry, type View } from '../../src/demo/geometry-lab/core.js';
import { armB, armC, armD, BudgetExhausted, conservativeTokens, digest, groundedIn, newCnyBudget, runTool, type ModelCtx } from '../../src/demo/geometry-lab/model-arms.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);
const bar = (i: number, o: number, h: number, l: number, c: number, v = 100): Bar => ({ open_time: T0 + i * H, close_time: T0 + (i + 1) * H - 1, available_at: T0 + (i + 1) * H - 1, open: o.toFixed(6), high: h.toFixed(6), low: l.toFixed(6), close: c.toFixed(6), volume: v.toFixed(2) });

function walk(n: number, seed = 1, start = 100): Bar[] {
  const r = rng(seed);
  let c = start;
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const o = c;
    c = Math.max(1, c * (1 + (r() - 0.48) * 0.02));
    out.push(bar(i, o, Math.max(o, c) * (1 + r() * 0.004), Math.min(o, c) * (1 - r() * 0.004), c, 100 + r() * 60));
  }
  return out;
}

/** Same bars up to index `cut`, garbage afterwards. */
const poison = (bars: Bar[], cut: number): Bar[] => bars.map((b, i) => (i <= cut ? b : { ...b, open: '1', high: '99999', low: '0.5', close: '5000', volume: '1' }));

const ctxFor = (fn: (system: string, user: string) => string, prompts?: string[]): ModelCtx => ({
  brain: stubBrain((s, u) => {
    prompts?.push(s + '\n---\n' + u);
    return fn(s, u);
  }),
  budget: { used: 0, max: 100 },
  log: () => {},
});

describe('geometry lab: leakage guard', () => {
  const full = walk(700);
  const cut = 600;
  const asOf = full[cut]!.close_time;

  it('a view holds only bars that closed at or before as_of, capped at the lookback', () => {
    const v = viewAt('X', full, asOf);
    expect(v.bars.at(-1)!.close_time).toBe(asOf);
    expect(v.bars.every((b) => b.close_time <= asOf)).toBe(true);
    expect(v.bars.length).toBe(480);
    expect(Object.isFrozen(v.bars)).toBe(true);
  });

  it('every arm entry point refuses a view that contains a future bar', async () => {
    const leaky: View = { symbol: 'X', as_of: asOf, bars: full.slice(cut - 300, cut + 2) };
    expect(() => assertVisible(leaky)).toThrow(/future_bar_leak/);
    expect(() => armA(leaky)).toThrow(/future_bar_leak/);
    expect(() => enumerateLevels(leaky)).toThrow(/future_bar_leak/);
    expect(() => digest(leaky)).toThrow(/future_bar_leak/);
    expect(() => runTool(leaky, 'klines', { n: 5 })).toThrow(/future_bar_leak/);
    await expect(armB(leaky, ctxFor(() => '{}'))).rejects.toThrow(/future_bar_leak/);
    await expect(armC(leaky, ctxFor(() => '{}'))).rejects.toThrow(/future_bar_leak/);
    await expect(armD(leaky, ctxFor(() => '{}'))).rejects.toThrow(/future_bar_leak/);
  });

  it('poisoning every bar after as_of changes nothing any arm sees or returns', async () => {
    const a = viewAt('X', full, asOf);
    const b = viewAt('X', poison(full, cut), asOf);
    expect(armA(b)).toEqual(armA(a));
    expect(enumerateLevels(b)).toEqual(enumerateLevels(a));
    expect(digest(b)).toEqual(digest(a));
    for (const [tool, args] of [['klines', { n: 120 }], ['atr', { n: 14 }], ['swing_points', { left: 2, right: 5, n: 10 }], ['htf_levels', { tf: '4h' }], ['htf_levels', { tf: '1d' }], ['volume_profile', { n: 300, bins: 30 }]] as const) {
      expect(runTool(b, tool, args)).toEqual(runTool(a, tool, args));
    }
    // arm C end to end: identical prompts in, identical geometry out.
    const script = (turns: string[]) => {
      let k = 0;
      return () => turns[Math.min(k++, turns.length - 1)]!;
    };
    const turns = ['{"calls":[{"tool":"klines","args":{"n":120}},{"tool":"htf_levels","args":{"tf":"1d"}}]}', '{"final":{"stop":{"level":"1","from":"T1","buffer_atr":0},"target":null,"rationale":"x"}}'];
    const pa: string[] = [];
    const pb: string[] = [];
    const ra = await armC(a, ctxFor(script(turns), pa));
    const rb = await armC(b, ctxFor(script(turns), pb));
    expect(pb).toEqual(pa);
    expect(rb.g).toEqual(ra.g);
    // the newest kline a tool can show is the as_of bar itself
    const rows = JSON.parse(runTool(a, 'klines', { n: 120 }).text).rows as { age: number; c: string }[];
    expect(rows.at(-1)!.age).toBe(0);
    expect(Number(rows.at(-1)!.c)).toBeCloseTo(Number(full[cut]!.close), 3);
  });
});

describe('geometry lab: arm A', () => {
  const full = walk(900, 7);
  it('is deterministic and follows its stop / target rule on every as_of', () => {
    for (let i = 480; i < 880; i += 37) {
      const v = viewAt('X', full, full[i]!.close_time);
      const g = armA(v);
      expect(armA(v)).toEqual(g);
      const f = tfFeatures(v.bars);
      expect(g.stop).toBeCloseTo(Math.min(Math.max(f.ll10 - 0.1 * f.atr14, f.close - 2 * f.atr14), f.close - f.atr14), 10);
      expect(f.close - g.stop).toBeGreaterThanOrEqual(f.atr14 - 1e-9);
      if (g.target !== null) {
        const d = (g.target - f.close) / f.atr14;
        expect(d).toBeGreaterThanOrEqual(1);
        expect(d).toBeLessThanOrEqual(6);
        expect(pivots(v.bars, 3, 3).some((p) => p.kind === 'high' && p.price === g.target)).toBe(true);
      }
    }
  });
});

describe('geometry lab: level enumeration (arm D menu)', () => {
  const full = walk(900, 3);
  it('pivots() equals structure() pivots for a symmetric window', () => {
    const bars = full.slice(0, 400);
    const mine = pivots(bars, 3, 3).map((p) => `${p.kind}:${p.index}:${p.price}`).sort();
    const ref = structure(bars, 3).pivots.map((p) => `${p.kind}:${p.index}:${Number(p.price)}`).sort();
    expect(mine).toEqual(ref);
  });

  it('≤ 8 options per side, stops below / targets above, deduped, R targets resolved from the chosen stop', () => {
    for (let i = 500; i < 880; i += 41) {
      const v = viewAt('X', full, full[i]!.close_time);
      const m = enumerateLevels(v);
      expect(m.stops.length).toBeGreaterThan(0);
      expect(m.stops.length).toBeLessThanOrEqual(8);
      expect(m.targets.length).toBeLessThanOrEqual(8);
      m.stops.forEach((s, k) => {
        expect(s.idx).toBe(k);
        expect(s.price!).toBeLessThan(m.close);
        expect(s.dist_atr!).toBeGreaterThanOrEqual(0.25);
        for (const o of m.stops) if (o !== s) expect(Math.abs(o.price! - s.price!)).toBeGreaterThanOrEqual(0.15 * m.atr14);
      });
      for (const t of m.targets) if (t.price !== null) expect(t.price).toBeGreaterThan(m.close);
      const r2 = m.targets.find((t) => t.r_multiple === 2)!;
      const g = resolvePick(m, 0, r2.idx);
      expect(g.stop).toBe(m.stops[0]!.price);
      expect(g.target!).toBeCloseTo(m.close + 2 * (m.close - g.stop), 9);
      expect(() => resolvePick(m, m.stops.length, null)).toThrow(/out_of_range/);
      expect(() => resolvePick(m, 0, 99)).toThrow(/out_of_range/);
    }
  });

  it('arm D turns indices into prices and never takes a number from the model', async () => {
    const v = viewAt('X', full, full[700]!.close_time);
    const m = enumerateLevels(v);
    const r = await armD(v, ctxFor(() => `{"stop_idx":${m.stops.length - 1},"target_idx":null,"reason":"x","stop":"123"}`));
    expect(r.g.stop).toBe(m.stops.at(-1)!.price);
    expect(r.g.target).toBeNull();
    const bad = await armD(v, ctxFor(() => '{"stop_idx":42,"target_idx":null}'));
    expect(bad.g.flags).toEqual(expect.arrayContaining(['fallback_a', 'invalid_output']));
    expect(bad.meter.calls).toBe(2);
  });
});

describe('geometry lab: hallucination detector (arm C)', () => {
  const full = walk(800, 11);
  const v = viewAt('X', full, full[650]!.close_time);
  const f = tfFeatures(v.bars);
  const sw = runTool(v, 'swing_points', { left: 3, right: 3, n: 8 });
  const low = (JSON.parse(sw.text).lows as { price: string; side: string }[]).find((x) => x.side === 'below')!;
  const turns = (final: string) => {
    let k = 0;
    return () => (k++ === 0 ? '{"calls":[{"tool":"swing_points","args":{"left":3,"right":3,"n":8}}]}' : final);
  };

  it('groundedIn uses a ±0.05% relative band', () => {
    expect(groundedIn(100.049, [100])).toBe(true);
    expect(groundedIn(100.06, [100])).toBe(false);
    expect(groundedIn(NaN, [100])).toBe(false);
  });

  it('a level copied from a tool output is accepted; stop = level − buffer × ATR14', async () => {
    const r = await armC(v, ctxFor(turns(`{"final":{"stop":{"level":"${low.price}","from":"T1","buffer_atr":0.2},"target":null,"rationale":"x"}}`)));
    expect(r.g.flags).not.toContain('hallucinated');
    expect(r.g.stop).toBeCloseTo(Number(low.price) - 0.2 * f.atr14, 9);
    expect(r.tool_calls).toBe(1);
  });

  it('a real level cited to the wrong output is kept but flagged miscited', async () => {
    const r = await armC(v, ctxFor(turns(`{"final":{"stop":{"level":"${low.price}","from":"T0","buffer_atr":0},"target":null,"rationale":"x"}}`)));
    const inDigest = groundedIn(Number(low.price), digest(v).prices);
    expect(r.g.flags.includes('miscited')).toBe(!inDigest);
    expect(r.g.flags).not.toContain('hallucinated');
  });

  it('an invented level falls back to arm A with a flag', async () => {
    const seen = [...digest(v).prices, ...sw.prices];
    let invented = f.close * 0.9713;
    while (groundedIn(invented, seen)) invented *= 0.9991;
    const r = await armC(v, ctxFor(turns(`{"final":{"stop":{"level":"${invented}","from":"T1","buffer_atr":0},"target":null,"rationale":"x"}}`)));
    expect(r.g.flags).toEqual(expect.arrayContaining(['hallucinated', 'fallback_a']));
    expect(r.g.stop).toBe(armA(v).stop);
    expect(r.g.target).toBe(armA(v).target);
  });

  it('stops after the turn cap and falls back when no valid final arrives', async () => {
    const r = await armC(v, ctxFor(() => '{"calls":[{"tool":"klines","args":{"n":5}},{"tool":"atr","args":{"n":14}},{"tool":"klines","args":{"n":6}}]}'));
    expect(r.meter.calls).toBe(5);
    expect(r.tool_calls).toBe(6);
    expect(r.g.flags).toEqual(expect.arrayContaining(['fallback_a', 'no_final']));
  });
});

describe('geometry lab: settlement on synthetic bars', () => {
  const g = (stop: number, target: number | null): Geometry => ({ stop, target, rationale: '', source_levels: [], flags: [] });
  const flat = (from: number, n: number, px = 100) => Array.from({ length: n }, (_, k) => bar(from + k, px, px + 0.5, px - 0.5, px));

  it('plan: stop, target, same-bar tie → stop, 48-bar expiry, gap through stop → invalid', () => {
    const stop = settlePlan(g(98, 104), [bar(1, 100, 100.5, 97, 97.5)], 1);
    expect(stop.status).toBe('stop');
    expect(stop.gross_r).toBe(-1);
    expect(stop.net_r!).toBeLessThan(-1);
    const tp = settlePlan(g(98, 104), [bar(1, 100, 105, 99.5, 104.5)], 1);
    expect(tp.status).toBe('tp');
    expect(tp.gross_r).toBe(2);
    expect(settlePlan(g(98, 104), [bar(1, 100, 105, 97, 100)], 1).status).toBe('stop');
    const exp = settlePlan(g(98, 104), [bar(1, 100, 101.5, 99.5, 101), ...flat(2, 47, 101), bar(49, 101, 101, 50, 50)], 1);
    expect(exp.status).toBe('expired');
    expect(exp.bars_held).toBe(48);
    expect(exp.gross_r).toBe(0.5);
    expect(settlePlan(g(98, 104), [bar(1, 97, 97.5, 96, 97)], 1).status).toBe('invalid');
  });

  it('trail: chandelier ratchets up from the fill, exits as trail with the R base fixed at the initial stop', () => {
    const history = flat(0, 30);
    const up = Array.from({ length: 20 }, (_, k) => bar(30 + k, 100 + k, 101 + k + 0.5, 100 + k - 0.5, 101 + k));
    const drop = bar(50, 120, 120.2, 105, 106);
    const t = settleTrail(g(98, null), history, [...up, drop], 1);
    expect(t.status).toBe('trail');
    expect(t.gross_r!).toBeGreaterThan(5);
    expect(t.net_r!).toBeLessThan(t.gross_r!);
    const s = settleTrail(g(98, null), history, [bar(30, 100, 100.2, 97, 97.5)], 1);
    expect(s.status).toBe('stop');
    expect(s.gross_r).toBe(-1);
  });
});

describe('geometry lab: candidate signal and the 止血 rule', () => {
  it('Donchian-20 close breakout needs volume ≥ 1.1× and respects the cooldown', () => {
    const bars: Bar[] = Array.from({ length: 700 }, (_, i) => bar(i, 100, 100.5, 99.5, 100, 100));
    bars[520] = bar(520, 100, 101.2, 99.8, 101, 200);
    bars[530] = bar(530, 100, 102.2, 99.8, 102, 200); // breakout inside the 24-bar cooldown
    bars[560] = bar(560, 100, 101.2, 99.8, 101, 200);
    bars[600] = bar(600, 100, 101.2, 99.8, 101, 100); // breakout without volume
    const c = findCandidates('X', bars, { donchian: 20, vol_mult: 1.1, cooldown: 24, warmup: 480, forward: 48 });
    expect(c.map((x) => x.signal_index)).toEqual([520, 560]);
    expect(c[0]!.as_of).toBe(bars[520]!.close_time);
    expect(c[0]!.ref_close).toBe(101);
  });

  it('stopRule rejects stops closer than k×ATR and prices a rejection as giving up that trade', () => {
    const row = (id: string, stopAtr: number, r: number): ArmRow => {
      const s = { variant: 'plan' as const, status: 'stop', fill: 100, exit_price: 99, bars_held: 1, gross_r: r, net_r: r, mfe_r: 0, mae_r: 0, note: '' };
      return { id, arm: 'X', ref_close: 100, atr14: 1, g: g0(100 - stopAtr), plan: s, trail: { ...s, variant: 'trail' }, calls: 0, in_tok: 0, out_tok: 0, latency_ms: 0, cost_cny: 0 };
    };
    const g0 = (stop: number): Geometry => ({ stop, target: null, rationale: '', source_levels: [], flags: [] });
    const rows = [row('a', 0.4, -1), row('b', 0.8, 1), row('c', 2, 0.5), row('d', 1, -0.2)];
    const s = stopRule('X', rows, 1);
    expect(s.rejected_share).toBe(0.5);
    expect(s.rejected_plan).toBe(0);
    expect(s.kept_plan).toBeCloseTo(0.15, 9);
    expect(s.delta_plan.mean).toBeCloseTo((1 - 1) / 4, 9);
    expect(stopRule('X', rows, 0.5).delta_plan.mean).toBeCloseTo(0.25, 9);
  });
});

describe('geometry lab: spend guards (双模型全量复跑)', () => {
  const bars = walk(700, 7);
  const v = viewAt('X', bars, bars[600]!.close_time);
  const close = tfFeatures(v.bars).close;
  const answer = () => JSON.stringify({ stop: +(close * 0.97).toFixed(4), target: null, rationale: '结构位下方', source_levels: [] });
  const priced = (): ModelCtx['brain'] => ({ ...stubBrain(answer), name: 'pi:deepseek/deepseek-v4-flash' });

  it('conservativeTokens counts a CJK char as a whole token and never undercuts the chars/3 meter', () => {
    expect(conservativeTokens('中文ab')).toBe(3);
    for (const s of ['abcdefghij', '止损放在结构位下方 0.1 ATR', digest(v).text]) expect(conservativeTokens(s)).toBeGreaterThanOrEqual(Math.ceil(s.length / 3));
  });

  it('--max-cny: no call starts once spent + in-flight reserve would pass the cap', async () => {
    const tiny = newCnyBudget(1e-9);
    await expect(armB(v, { brain: priced(), budget: { used: 0, max: 100, cny: tiny }, log: () => {} })).rejects.toBeInstanceOf(BudgetExhausted);
    expect(tiny.spent).toBe(0);
    const cb = newCnyBudget(0.02, 0.000001);
    const ctx: ModelCtx = { brain: priced(), budget: { used: 0, max: 1000, cny: cb }, log: () => {} };
    let done = 0;
    await expect(
      (async () => {
        for (;;) {
          await armB(v, ctx);
          done++;
        }
      })(),
    ).rejects.toBeInstanceOf(BudgetExhausted);
    expect(done).toBeGreaterThan(0);
    expect(cb.spent).toBeLessThanOrEqual(cb.max);
    expect(cb.spent).toBeGreaterThanOrEqual(cb.spent_meter);
    expect(cb.inflight).toBe(0);
    expect(cb.reserved).toBeCloseTo(0, 12);
    await expect(armB(v, { brain: stubBrain(answer), budget: { used: 0, max: 10, cny: newCnyBudget(1) }, log: () => {} })).rejects.toThrow(/priced brain/);
  });

  it('piBrain passes apiKey as --api-key and scrubs it from errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'geo-lab-pi-'));
    const fake = join(dir, 'fake-pi');
    writeFileSync(fake, '#!/bin/sh\necho "argv: $@" >&2\nexit 3\n');
    chmodSync(fake, 0o755);
    const key = 'sk-test-DO-NOT-LEAK-123';
    const err = await piBrain({ command: fake, provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: key })
      .complete('s', 'u')
      .then(() => null, (e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(err).toContain('--api-key [redacted]');
    expect(err).not.toContain(key);
  });
});
