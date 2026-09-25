// Multi-sample runs (docs/eval/denoise-plan-2026-09-04.md, merged with the external review): mode selection,
// pairwise-disagreement noise floor, 4/5 stability rule, per-sample hard invariants vs stable-only action metrics,
// and --resume redoing single-sample episodes.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { demo } from '@trading-swarm/gateway';
import { loadCases, pickMode, runCases } from '../src/run.js';
import { boundaryPairs, buildReport, loadEpisodes, isStable, pairwiseDisagreement, summarizeSampling } from '../src/report.js';
import type { EpisodeRecord } from '../src/types.js';

const J = (action: string) => ({ action, direction: null, confidence: 0.5, headline: 'h', thesis: 't', reasons: ['r [E1]'], evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [], proposal: null }) as unknown as demo.Judgment;

describe('pickMode / pairwiseDisagreement / isStable', () => {
  it('mode wins, ties go to the lowest k, agreement = votes / N', () => {
    const r = pickMode([J('WATCH'), J('NO_TRADE'), J('WATCH')].map((judgment, k) => ({ k, judgment })));
    expect(r).toMatchObject({ index: 0, agreement: 2 / 3, tie: false, actions_seen: { WATCH: 2, NO_TRADE: 1 } });
    const t = pickMode([J('NO_TRADE'), J('WATCH')].map((judgment, k) => ({ k, judgment })));
    expect(t.tie).toBe(true);
    expect(t.index).toBe(0);
  });

  it('pairwise disagreement: all same → 0, 3:2 split → 0.6, 2:2:1 → 0.8', () => {
    expect(pairwiseDisagreement(['A', 'A', 'A'])).toBe(0);
    expect(pairwiseDisagreement(['A', 'A', 'A', 'B', 'B'])).toBeCloseTo(0.6);
    expect(pairwiseDisagreement(['A', 'A', 'B', 'B', 'C'])).toBeCloseTo(0.8);
    expect(pairwiseDisagreement(['A'])).toBeNull();
  });

  it('stability = unique mode with ≥ ceil(0.8·N) votes; single-sample → null', () => {
    const ep = (seen: Record<string, number>, N: number): EpisodeRecord => ({ samples: Array.from({ length: N }, (_, k) => ({ k })), actions_seen: seen }) as unknown as EpisodeRecord;
    expect(isStable(ep({ HOLD: 5 }, 5))).toBe(true);
    expect(isStable(ep({ HOLD: 4, EXIT: 1 }, 5))).toBe(true);
    expect(isStable(ep({ HOLD: 3, EXIT: 2 }, 5))).toBe(false);
    expect(isStable(ep({ HOLD: 3 }, 3))).toBe(true);
    expect(isStable(ep({ HOLD: 2, EXIT: 1 }, 3))).toBe(false); // N=3 needs 3/3
    expect(isStable({ actions_seen: { HOLD: 1 } } as unknown as EpisodeRecord)).toBeNull();
  });

  it('summarizeSampling: noise floor excludes brain-error cases, N=1 run reports N/A', () => {
    const mk = (actions: string[], err = false): EpisodeRecord =>
      ({ case_id: actions.join('-'), mode: 'scan', judgment: J(actions[0]!), agreement: Math.max(...Object.values(count(actions))) / actions.length, actions_seen: count(actions), samples: actions.map((a, k) => ({ k, judgment: J(a), brain_error: err && k === 0 ? 'boom' : null })) }) as unknown as EpisodeRecord;
    const count = (xs: string[]): Record<string, number> => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
    const s = summarizeSampling([mk(['A', 'A', 'A', 'A', 'A']), mk(['A', 'A', 'A', 'B', 'B']), mk(['A', 'B', 'A', 'B', 'A'], true)], new Map());
    expect(s.samples_per_case).toBe(5);
    expect(s.noise_floor).toBeCloseTo(0.3); // (0 + 0.6) / 2, error case excluded
    expect(s.self_consistency).toBeCloseTo(0.7);
    expect(s.stable_cases).toBe(1);
    expect(s.unstable_cases).toBe(2);
    expect(s.cases_with_brain_error).toBe(1);
    expect(summarizeSampling([{ case_id: 'x', mode: 'scan', judgment: J('A') } as unknown as EpisodeRecord], new Map()).noise_floor).toBeNull();
  });
});

describe('boundary pairs (where the noise sits)', () => {
  const ep = (id: string, mode: 'scan' | 'review', actions: string[]): EpisodeRecord => {
    const counts = actions.reduce<Record<string, number>>((m, a) => ((m[a] = (m[a] ?? 0) + 1), m), {});
    return { case_id: id, mode, judgment: J(actions[0]!), agreement: Math.max(...Object.values(counts)) / actions.length, actions_seen: counts, samples: actions.map((a, k) => ({ k, judgment: J(a) })) } as unknown as EpisodeRecord;
  };

  it('groups flipping cases by the action set and counts the unstable ones', () => {
    const eps = [
      ep('a', 'scan', ['NO_TRADE', 'WATCH', 'WATCH', 'WATCH', 'WATCH']), // flips but stable (4/5)
      ep('b', 'scan', ['NO_TRADE', 'NO_TRADE', 'WATCH', 'WATCH', 'WATCH']), // unstable
      ep('c', 'review', ['HOLD', 'HOLD', 'EXIT', 'EXIT', 'EXIT']),
      ep('d', 'review', ['HOLD', 'HOLD', 'HOLD', 'HOLD', 'HOLD']), // no flip at all
    ];
    const pairs = boundaryPairs(eps, (e) => (e.mode === 'review' ? 'review' : 'scan'));
    expect(pairs.map((p) => p.pair)).toEqual(['NO_TRADE↔WATCH', 'EXIT↔HOLD']);
    expect(pairs[0]).toMatchObject({ cases: 2, unstable: 1, scan: 2, review: 0 });
    expect(pairs[1]).toMatchObject({ cases: 1, unstable: 1, scan: 0, review: 1 });
    expect(pairs[0]!.mean_disagreement).toBeCloseTo((0.4 + 0.6) / 2);
  });

  it('summarizeSampling carries the pairs and the report renders them', () => {
    const s = summarizeSampling([ep('b', 'scan', ['NO_TRADE', 'NO_TRADE', 'WATCH', 'WATCH', 'WATCH'])], new Map());
    expect(s.boundary_pairs).toHaveLength(1);
    expect(s.boundary_pairs[0]!.pair).toBe('NO_TRADE↔WATCH');
    expect(summarizeSampling([{ case_id: 'x', mode: 'scan', judgment: J('A') } as unknown as EpisodeRecord], new Map()).boundary_pairs).toEqual([]);
  });
});

/** A brain whose action depends on how many times it has been asked about a given context: A, A, B, A, B … */
function flakyBrain(): demo.Brain {
  const seen = new Map<string, number>();
  return {
    name: 'fake:flaky',
    async complete(_s, user) {
      const key = user.slice(0, 400);
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      const review = /## 复查的线程/.test(user);
      const seq = review ? ['HOLD', 'HOLD', 'EXIT', 'HOLD', 'EXIT'] : ['NO_TRADE', 'NO_TRADE', 'WATCH', 'NO_TRADE', 'NO_TRADE'];
      const action = seq[(n - 1) % seq.length]!;
      return { text: JSON.stringify(J(action)), latency_ms: 1, model: 'fake:flaky', input_tokens: 1, output_tokens: 1 };
    },
  };
}

describe('multi-sample run → report', () => {
  it('records samples, hard metrics count every sample, action metrics use only stable cases, resume redoes N=1 episodes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-s5-'));
    try {
      const cases = loadCases('cases/v1').filter((c) => !c.tags.includes('mirror')).slice(0, 4);
      const casesDir = join(dir, 'cases');
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(casesDir);
      for (const c of cases) writeFileSync(join(casesDir, `${c.id}.json`), JSON.stringify(c));
      const brain = flakyBrain();
      const { makeBrain } = await import('../src/run.js');
      void makeBrain;
      // run N=1 first, then resume with N=5: every episode must be redone (samples < requested)
      const out = join(dir, 'run');
      const one = await runCases({ casesDir, outDir: out, brain: 'stub', limit: null, tags: [], resume: false, concurrency: 1, cacheDir: join(dir, 'cache'), timeoutMs: 5000, samples: 1 }, () => {}, brain);
      expect(one.episodes).toBe(4);
      const five = await runCases({ casesDir, outDir: out, brain: 'stub', limit: null, tags: [], resume: true, concurrency: 1, cacheDir: join(dir, 'cache'), timeoutMs: 5000, samples: 5 }, () => {}, brain);
      expect(five.episodes).toBe(4);
      const rep = buildReport(out, casesDir);
      expect(rep.sampling.samples_per_case).toBe(5);
      // flaky sequence: scan cases 4:1 → stable; review cases 3:2 → unstable
      const scanRows = rep.rows.filter((r) => r.mode === 'scan');
      const reviewRows = rep.rows.filter((r) => r.mode === 'review');
      for (const r of scanRows) expect(r.stable).toBe(true);
      for (const r of reviewRows) expect(r.stable).toBe(false);
      expect(rep.sampling.noise_floor).not.toBeNull();
      const nf = rep.metrics.find((m) => m.name === 'noise_floor')!;
      expect(nf.value).toBeCloseTo(rep.sampling.noise_floor!);
      // action_mix only counts stable cases
      const mix = rep.metrics.find((m) => m.name === 'action_mix')!;
      expect(mix.n).toBe(scanRows.length);
      // hard metrics are per sample: n = cases × 5
      const ev = rep.metrics.find((m) => m.name === 'evidence_valid')!;
      expect(ev.n).toBe(4 * 5);
      expect(ev.note).toMatch(/按样本统计/);
      const fl = rep.metrics.find((m) => m.name === 'future_leakage')!;
      expect(fl.n).toBe(4);
      const mechanical = rep.metrics.find((m) => m.name === 'vs_mechanical')!;
      // Flip scan stability without changing any market data. Mechanical-always must not move.
      for (const ep of loadEpisodes(out).filter((e) => e.mode === 'scan')) {
        ep.actions_seen = { NO_TRADE: 3, WATCH: 2 };
        ep.agreement = 3 / 5;
        ep.samples!.forEach((sample, i) => { sample.judgment = J(i < 3 ? 'NO_TRADE' : 'WATCH'); });
        writeFileSync(join(out, 'episodes', `${ep.case_id}.json`), JSON.stringify(ep));
      }
      const changed = buildReport(out, casesDir).metrics.find((m) => m.name === 'vs_mechanical')!;
      expect(changed.details['always']).toEqual(mechanical.details['always']);
      expect(changed.n).toBe(mechanical.n);
      expect(changed.details['skipped']).toMatchObject({ n: 0, mean_r: null });
      expect(changed.details['unstable']).toMatchObject({ n: mechanical.n });

    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
