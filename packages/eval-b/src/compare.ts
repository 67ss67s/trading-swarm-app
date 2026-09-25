import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { EvalEpisode, EvalReport, RunManifest } from './types.js';
import { readJson, round, writeJson } from './util.js';

function short(value: unknown): string {
  return JSON.stringify(value).replaceAll('|', '\\|');
}

export async function compareRuns(runA: string, runB: string, outDir?: string): Promise<{ json: string; markdown: string }> {
  const aDir = path.resolve(runA);
  const bDir = path.resolve(runB);
  const [a, b, aManifest, bManifest] = await Promise.all([
    readJson<EvalReport>(path.join(aDir, 'report.json')),
    readJson<EvalReport>(path.join(bDir, 'report.json')),
    readJson<RunManifest>(path.join(aDir, 'run.json')),
    readJson<RunManifest>(path.join(bDir, 'run.json')),
  ]);
  const names = [...new Set([...Object.keys(a.metrics), ...Object.keys(b.metrics)])].sort();
  const metrics = names.map((name) => {
    const av = a.metrics[name]?.value ?? null;
    const bv = b.metrics[name]?.value ?? null;
    const delta = typeof av === 'number' && typeof bv === 'number' ? round(bv - av) : null;
    return { metric: name, a: av, b: bv, delta, a_status: a.metrics[name]?.status ?? null, b_status: b.metrics[name]?.status ?? null };
  });
  const common = aManifest.case_ids.filter((id) => bManifest.case_ids.includes(id));
  const readEpisodes = async (dir: string, ids: string[]): Promise<Map<string, EvalEpisode>> =>
    new Map(await Promise.all(ids.map(async (id) => [id, await readJson<EvalEpisode>(path.join(dir, 'episodes', `${id}.json`))] as const)));
  const [aEpisodes, bEpisodes] = await Promise.all([readEpisodes(aDir, common), readEpisodes(bDir, common)]);
  const actionChanges = common.flatMap((id) => {
    const aa = aEpisodes.get(id)!.judgment;
    const bb = bEpisodes.get(id)!.judgment;
    return aa.action === bb.action && aa.direction === bb.direction ? [] : [{ case_id: id, a: `${aa.action}/${aa.direction}`, b: `${bb.action}/${bb.direction}` }];
  });
  const comparison = {
    version: 1,
    run_a: aDir,
    run_b: bDir,
    brain_a: a.brain,
    brain_b: b.brain,
    common_cases: common.length,
    metrics,
    action_changes: actionChanges,
  };
  const markdown = [
    `# Eval comparison — ${a.brain} vs ${b.brain}`,
    '',
    `Common cases: ${common.length}; action changes: ${actionChanges.length}`,
    '',
    '| Metric | A | B | Δ |',
    '|---|---|---|---:|',
    ...metrics.map((item) => `| ${item.metric} | ${item.a_status} ${short(item.a)} | ${item.b_status} ${short(item.b)} | ${item.delta ?? '—'} |`),
    '',
    '## Action changes',
    '',
    ...(actionChanges.length ? actionChanges.map((item) => `- \`${item.case_id}\`: ${item.a} → ${item.b}`) : ['- None']),
    '',
  ].join('\n');
  const target = path.resolve(outDir ?? path.join(bDir, `compare-vs-${path.basename(aDir)}`));
  await writeJson(`${target}.json`, comparison);
  await writeFile(`${target}.md`, markdown, 'utf8');
  return { json: `${target}.json`, markdown: `${target}.md` };
}
