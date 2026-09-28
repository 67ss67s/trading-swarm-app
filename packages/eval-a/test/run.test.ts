import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { demo } from '@trade-gate/gateway';
import { buildReport, cacheKey, filterCases, loadOnlyIds, ResponseCache, runCases, runEpisode, writeJson, writeReport } from '../src/index.js';
import { synthCases } from './helpers/synthetic.js';

const HARD = ['evidence_valid', 'hallucinated_numbers', 'future_leakage', 'stale_trade', 'unauthorized_action', 'gate_reject_rate', 'illegal_edge_attempts', 'path_replay_ok'];

describe('offline stub run (CI gate)', () => {
  it('runs a small synthetic set, passes every hard invariant, and is byte-for-byte reproducible', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-a-'));
    const casesDir = join(root, 'cases');
    const cases = await synthCases({ n: 2 }, 3);
    for (const c of cases) writeJson(join(casesDir, `${c.id}.json`), c);
    const opts = { casesDir, brain: 'stub' as const, cacheDir: join(root, 'cache') };
    const m1 = await runCases({ ...opts, outDir: join(root, 'run1') });
    const m2 = await runCases({ ...opts, outDir: join(root, 'run2') });
    expect(m1.episodes).toBe(cases.length);
    for (const c of cases) expect(readFileSync(join(root, 'run1', 'episodes', `${c.id}.json`), 'utf8')).toBe(readFileSync(join(root, 'run2', 'episodes', `${c.id}.json`), 'utf8'));
    const r1 = writeReport(join(root, 'run1'));
    const r2 = buildReport(join(root, 'run2'));
    expect(JSON.stringify({ ...r1, run_id: '', cases_dir: '' })).toBe(JSON.stringify({ ...r2, run_id: '', cases_dir: '' }));
    for (const name of HARD) expect(r1.metrics.find((m) => m.name === name)!.status, name).toBe('PASS');
    expect(r1.metrics.find((m) => m.name === 'schema_valid_first')!.value).toBe(1);
    expect(r1.metrics.find((m) => m.name === 'side_symmetry')!.value).toBe(1);
    expect(r1.metrics.map((m) => m.name)).toContain('vs_mechanical');
    // regime_agreement is the only thing the case format cannot support (needs 1d bars — `gen --sample triggers` records them)
    expect(r1.metrics.filter((m) => m.status === 'NOT_IMPLEMENTED').map((m) => m.name)).toEqual(['regime_agreement']);
    expect(r1.rows.every((x) => !x.graph.backfilled)).toBe(true);
    expect(r1.metrics.find((m) => m.name === 'edge_coverage')!.value).toBeGreaterThan(0);
    expect(Object.keys(r1.action_mix).length).toBeGreaterThanOrEqual(2);
    expect(r1.verdict).toBe('PROMOTE_CANDIDATE');
  });

  it('filters by tags with any-of / exclusion semantics and a limit', async () => {
    const cases = await synthCases({ n: 2 });
    expect(filterCases(cases, ['stale']).every((c) => c.tags.includes('stale'))).toBe(true);
    expect(filterCases(cases, ['scan', '!mirror']).every((c) => c.mode === 'scan' && !c.tags.includes('mirror'))).toBe(true);
    expect(filterCases(cases, [], 3).length).toBe(3);
  });

  it('--only narrows to an explicit id list, from a file or a comma list', async () => {
    const cases = await synthCases({ n: 2 });
    const ids = cases.slice(0, 3).map((c) => c.id);
    expect(filterCases(cases, [], null, ids).map((c) => c.id)).toEqual(ids);
    // ids the set does not contain are simply absent (runCases logs them)
    expect(filterCases(cases, [], null, ['nope']).length).toBe(0);
    const root = mkdtempSync(join(tmpdir(), 'eval-a-only-'));
    for (const c of cases) writeJson(join(root, 'cases', `${c.id}.json`), c);
    const f = join(root, 'ids.txt');
    writeFileSync(f, `# comment\n${ids[0]}  # 备注\n\n${ids[1]}\n${ids[0]}\n`);
    expect(loadOnlyIds(f)).toEqual([ids[0], ids[1]]);
    expect(loadOnlyIds(`${ids[0]},${ids[1]}`)).toEqual([ids[0], ids[1]]);
    const meta = await runCases({ casesDir: join(root, 'cases'), outDir: join(root, 'run'), brain: 'stub', cacheDir: join(root, 'cache'), only: [ids[0]!] }, () => {}, undefined);
    expect(meta.episodes).toBe(1);
    expect(meta.only).toEqual([ids[0]]);
  });

  it('serves the second call from the response cache and fails closed on garbage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-a-cache-'));
    const c = (await synthCases({ n: 1 })).find((x) => x.tags.includes('base'))!;
    let calls = 0;
    const brain: demo.Brain = { name: 'fake:model', complete: async () => ({ text: JSON.stringify({ action: 'WATCH', direction: 'long', confidence: 0.4, headline: 'h', thesis: 't', reasons: ['r [E1]'], evidence_refs: ['E1'], watch_conditions: [] }), latency_ms: 5 + calls++, model: 'fake:model', input_tokens: 10, output_tokens: 5 }) };
    const cache = new ResponseCache(join(root, 'cache'));
    const e1 = await runEpisode(c, brain, cache);
    const e2 = await runEpisode(c, brain, cache);
    expect(calls).toBe(1);
    expect(JSON.stringify(e1)).toBe(JSON.stringify(e2));
    expect(cache.hits).toBe(1);
    expect(cache.get(cacheKey(e1.context_hash, 'fake:model', demo.PROMPT_VERSION))).not.toBeNull();

    const garbage: demo.Brain = { name: 'fake:garbage', complete: async () => ({ text: 'not json at all', latency_ms: 1, model: 'fake:garbage', input_tokens: 1, output_tokens: 1 }) };
    const e3 = await runEpisode(c, garbage, null);
    expect(e3.judgment_source).toBe('fail_closed');
    expect(e3.judgment.action).toBe('NO_TRADE');
    expect(e3.errors_first.length).toBeGreaterThan(0);
    expect(e3.errors_repair.length).toBeGreaterThan(0);
    expect(e3.usage.model_calls).toBe(2);
  });
});
