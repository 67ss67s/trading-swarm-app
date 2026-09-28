import { demo } from '@trade-gate/gateway';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DAILY_BARS, SCORED_TRIGGER_KINDS, triggerTags } from '../src/index.js';
import { loadCases } from '../src/run.js';
import { synthCases } from './helpers/synthetic.js';

describe('generator', () => {
  it('is deterministic for a seed and changes with the seed', async () => {
    const a = await synthCases({ seed: 7 });
    const b = await synthCases({ seed: 7 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = await synthCases({ seed: 8 });
    expect(c.filter((x) => x.tags.includes('base')).map((x) => x.as_of)).not.toEqual(a.filter((x) => x.tags.includes('base')).map((x) => x.as_of));
  });

  it('derives stale / halted / mirror variants and 2–3 step review chains per base case', async () => {
    const cases = await synthCases({ n: 2 });
    const has = (t: string): number => cases.filter((c) => c.tags.includes(t)).length;
    expect(has('base')).toBe(2);
    expect(has('stale')).toBe(2);
    expect(has('halted')).toBe(2);
    expect(cases.filter((c) => c.mode === 'scan' && c.tags.includes('mirror')).length).toBe(2);
    const chains = new Map<string, number>();
    for (const c of cases) {
      const t = c.tags.find((x) => x.startsWith('chain:'));
      if (t) chains.set(t.split(':')[1]!, (chains.get(t.split(':')[1]!) ?? 0) + 1);
    }
    expect(chains.size).toBe(4); // base + mirror chain per base case
    for (const n of chains.values()) expect(n === 2 || n === 3).toBe(true);
    const ids = new Set(cases.map((c) => c.id));
    for (const c of cases) if (c.hidden.mirror_of) expect(ids.has(c.hidden.mirror_of)).toBe(true);
    for (const c of cases.filter((x) => x.mode === 'review')) {
      expect(c.thread).not.toBeNull();
      expect(c.tags).toContain(c.thread!.side);
      expect(c.tags).toContain(c.thread!.status);
    }
  });

  it('never shows a bar closing after as_of and hides exactly the horizon after it', async () => {
    for (const c of await synthCases({ n: 2 })) {
      for (const ks of Object.values(c.visible.klines)) for (const k of ks) expect(k.close_time).toBeLessThanOrEqual(c.as_of);
      expect(c.visible.klines['15m']!.length).toBe(60);
      expect(c.visible.klines['1h']!.length).toBe(120);
      expect(c.visible.klines['4h']!.length).toBe(80);
      expect(c.hidden.future_klines.length).toBe(48);
      for (const k of c.hidden.future_klines) expect(k.open_time).toBeGreaterThanOrEqual(c.as_of);
      expect(c.visible.market.last).toBe(c.visible.klines['15m']![59]!.close);
      expect(c.visible.market.as_of).toBe(c.visible.stale_all ? c.as_of - 600_000 : c.as_of);
    }
  });

  it('stale variant pushes market/account observed_at back 10 minutes and halted sets the flag', async () => {
    const cases = await synthCases({ n: 1 });
    const base = cases.find((c) => c.tags.includes('base'))!;
    const stale = cases.find((c) => c.id === `${base.id}-stale`)!;
    const halted = cases.find((c) => c.id === `${base.id}-halted`)!;
    expect(stale.visible.market.as_of).toBe(base.as_of - 600_000);
    expect(stale.visible.account.as_of).toBe(base.as_of - 600_000);
    expect(stale.visible.stale_all).toBe(true);
    expect(halted.visible.halted).toBe(true);
    expect(JSON.stringify(halted.visible.klines)).toBe(JSON.stringify(base.visible.klines));
  });
});

describe('generator — trigger sampling (`--sample triggers`, cases/v2)', () => {
  it('only picks bars where a scoreable rule fires, keeps them apart, and records 1d klines', async () => {
    const spacing = 8;
    const cases = await synthCases({ n: 4, sample: 'triggers', min_spacing_bars: spacing });
    const scans = cases.filter((c) => c.tags.includes('base') || (c.mode === 'scan' && c.tags.includes('mirror')));
    expect(scans.length).toBeGreaterThan(0);
    for (const c of scans) {
      // The tag the generator wrote and the rules replayed on the case agree, and both are non-empty.
      const replayed = triggerTags(c);
      expect(replayed.length).toBeGreaterThan(0);
      expect(c.tags.filter((t) => t.startsWith('trig:')).sort()).toEqual([...replayed].sort());
      for (const t of c.tags.filter((x) => x.startsWith('trig:'))) expect(SCORED_TRIGGER_KINDS).toContain(t.slice('trig:'.length));
    }
    // Minimum spacing between the as_of moments picked for one symbol.
    const bases = cases.filter((c) => c.tags.includes('base'));
    const bySymbol = new Map<string, number[]>();
    for (const c of bases) bySymbol.set(c.symbol, [...(bySymbol.get(c.symbol) ?? []), c.as_of].sort((a, b) => a - b));
    for (const list of bySymbol.values()) for (let i = 1; i < list.length; i++) expect(list[i]! - list[i - 1]!).toBeGreaterThanOrEqual(spacing * demo.tfToMs('15m'));
    // Every case (scan and review, base and mirror) carries the daily series dailyRegime needs.
    for (const c of cases) {
      expect(c.visible.klines['1d']!.length).toBe(DEFAULT_DAILY_BARS);
      for (const k of c.visible.klines['1d']!) expect(k.close_time).toBeLessThanOrEqual(c.as_of);
      expect(demo.dailyRegime(c.visible.klines['1d']!, c.as_of)).not.toBeNull();
      expect(c.visible.market.klines_tf).toBe('15m');
      expect(c.visible.market.last).toBe(c.visible.klines['15m']!.at(-1)!.close);
    }
  });

  it('leaves the uniform default alone: no 1d klines, no trigger tags', async () => {
    for (const c of await synthCases({ n: 2 })) {
      expect(c.visible.klines['1d']).toBeUndefined();
      expect(c.tags.some((t) => t.startsWith('trig:'))).toBe(false);
    }
  });
});

// v6 regression-test protocol (docs/eval/README.md §2「cases/v3-design 与 cases/v3-holdout」): the eval is
// only a regression test if the set a rule was designed on and the set it is checked on are disjoint.
// The split is by ASSET first (BTC/ETH vs everything else) and by TIME second (August vs September).
describe('generator — design / holdout split (cases/v3-*)', () => {
  it('stamps the set on every case and keeps two runs of the generator disjoint in time', async () => {
    const design = await synthCases({ symbols: ['BTCUSDT'], set: 'design', from: Date.UTC(2026, 0, 10), to: Date.UTC(2026, 0, 17), n: 2, sample: 'triggers' });
    const holdout = await synthCases({ symbols: ['ETHUSDT'], set: 'holdout', from: Date.UTC(2026, 0, 18), to: Date.UTC(2026, 0, 24), n: 2, sample: 'triggers' });
    expect(design.length).toBeGreaterThan(0);
    expect(holdout.length).toBeGreaterThan(0);
    for (const c of design) { expect(c.set).toBe('design'); expect(c.meta?.set).toBe('design'); }
    for (const c of holdout) { expect(c.set).toBe('holdout'); expect(c.meta?.set).toBe('holdout'); }
    // Disjoint assets AND disjoint as_of windows — a case can never appear in both sets.
    expect(new Set(design.map((c) => c.symbol))).toEqual(new Set(['BTCUSDT']));
    expect(new Set(holdout.map((c) => c.symbol))).toEqual(new Set(['ETHUSDT']));
    expect(Math.max(...design.map((c) => c.as_of))).toBeLessThan(Math.min(...holdout.map((c) => c.as_of)));
    expect([...new Set(design.map((c) => c.id))].some((id) => holdout.some((c) => c.id === id))).toBe(false);
  });

  it('the committed cases/v3-design and cases/v3-holdout are a real asset split with the v1/v2 variant mix', () => {
    const design = loadCases('cases/v3-design');
    const holdout = loadCases('cases/v3-holdout');
    expect(design.length).toBeGreaterThan(100);
    expect(holdout.length).toBeGreaterThan(100);
    for (const c of design) { expect(c.set).toBe('design'); expect(c.meta?.set).toBe('design'); }
    for (const c of holdout) { expect(c.set).toBe('holdout'); expect(c.meta?.set).toBe('holdout'); }

    // Assets: design is the BTC/ETH baseline the rules were written on; holdout is everything else,
    // including at least one TRADIFI perp (XAUUSDT / TSLAUSDT) so the rules are not crypto-only.
    const dSym = new Set(design.map((c) => c.symbol));
    const hSym = new Set(holdout.map((c) => c.symbol));
    expect(dSym).toEqual(new Set(['BTCUSDT', 'ETHUSDT']));
    for (const s of dSym) expect(hSym.has(s)).toBe(false);
    expect(hSym).toEqual(new Set(['SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'HYPEUSDT', 'TSLAUSDT', 'NVDAUSDT', 'XAUUSDT']));
    expect([...hSym].some((s) => s === 'XAUUSDT' || s === 'TSLAUSDT')).toBe(true);

    // Time: design is August, holdout is September — disjoint windows on top of the asset split.
    expect(Math.max(...design.map((c) => c.as_of))).toBeLessThan(Date.UTC(2026, 8, 1));
    expect(Math.min(...holdout.map((c) => c.as_of))).toBeGreaterThanOrEqual(Date.UTC(2026, 8, 1));

    // Same variant mix as v1/v2: base + stale + halted + mirror scans, plus chained review cases.
    for (const set of [design, holdout]) {
      const has = (t: string): number => set.filter((c) => c.tags.includes(t)).length;
      const bases = set === design ? 14 : 16;
      expect(has('base')).toBe(bases);
      expect(has('stale')).toBe(bases);
      expect(has('halted')).toBe(bases);
      expect(set.filter((c) => c.mode === 'scan' && c.tags.includes('mirror')).length).toBeGreaterThanOrEqual(13);
      expect(set.filter((c) => c.mode === 'review').length).toBeGreaterThan(50);
      const chains = new Set(set.map((c) => c.tags.find((t) => t.startsWith('chain:'))).filter(Boolean));
      expect(chains.size).toBeGreaterThan(20);
      // trigger sampling + 1d bars are on, so trigger_precision and regime_agreement have a denominator.
      for (const c of set) {
        expect((c.visible.klines['1d'] ?? []).length).toBe(c.symbol === 'NVDAUSDT' ? 150 : c.set === 'design' ? 220 : 210);
        for (const bars of Object.values(c.visible.klines)) expect(bars.every((k) => k.close_time <= c.as_of)).toBe(true);
        expect(c.hidden.future_klines.every((k) => k.open_time >= c.as_of)).toBe(true);
      }
      expect(set.filter((c) => c.tags.some((t) => t.startsWith('trig:'))).length).toBeGreaterThan(0);
    }
  });
});
