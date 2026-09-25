import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { compareRuns, HARD, runCases, writeJson } from '../src/index.js';
import { synthCases } from './helpers/synthetic.js';

it('compares design and holdout on their own cases, while same-set runs use the intersection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'eval-a-compare-'));
  for (const [set, symbol] of [['design', 'BTCUSDT'], ['holdout', 'ETHUSDT']]) {
    const casesDir = join(root, set!);
    for (const c of await synthCases({ n: 1, set, symbols: [symbol!] })) writeJson(join(casesDir, `${c.id}.json`), c);
    await runCases({ casesDir, outDir: join(root, `run-${set}`), brain: 'stub' });
  }
  const a = join(root, 'run-design');
  const b = join(root, 'run-holdout');
  const cross = compareRuns(a, b);
  expect(cross.comparison).toMatchObject({ cross_set: true, set_a: 'design', set_b: 'holdout', common_cases: 0, agreement: null, action_diffs: [] });
  for (const r of cross.reports) {
    expect(r.rows.length).toBeGreaterThan(0);
    for (const name of HARD) expect(r.metrics.find((m) => m.name === name)!.status, name).toBe('PASS');
    expect(r.metrics.find((m) => m.name === 'vs_mechanical')!.n).toBeGreaterThan(0);
  }
  expect(cross.markdown).toContain('A (set design)');
  expect(cross.markdown).toContain('B (set holdout)');
  expect(cross.markdown).toContain('review_counterfactual');
  const same = compareRuns(a, a);
  expect(same.comparison).toMatchObject({ cross_set: false, agreement: 1, action_diffs: [] });
  expect(same.comparison.common_cases).toBe(same.reports[0].rows.length);
});
