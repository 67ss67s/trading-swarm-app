#!/usr/bin/env node
// `npm run eval --workspace packages/eval-a -- <gen|run|report|compare> …` (docs/eval/README.md §5).
// Paths are relative to the package directory (npm runs scripts there).

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { binanceSource } from './binance.js';
import { writeComparison } from './compare.js';
import { DEFAULT_MIN_SPACING_BARS, generateCases } from './gen.js';
import { deriveMemoryCases } from './gen-memory.js';
import { writeGateReport, writeReport } from './report.js';
import { GATE_SET, generateGateCases } from './gen-gates.js';
import { loadCases, loadOnlyIds, runCases, type BrainKind } from './run.js';
import { parseDateArg, readJson, stamp, writeJson, writeText } from './util.js';

const USAGE = `用法:
  eval gen     --symbols BTCUSDT,ETHUSDT --tf 15m --from 2026-08-01 --to 2026-09-01 --n 12 --seed 7 --out cases/v1 [--set v1] [--data data] [--step-bars 4] [--horizon 48]
               [--sample uniform|triggers] [--daily-bars 220] [--min-spacing-bars 8]   # triggers: as_of 只落在 detectTriggers 命中的那根,并录 1d K 线
  eval gen-memory --from cases/v1 --out cases/v1-mem --seed 7 [--set v1-mem]
  eval run     --cases cases/v1 --brain stub|pi|claude|zai-api --out runs/<id> [--model …] [--samples N] [--temperature t] [--limit N] [--tags scan,!mirror] [--only ids.txt|a,b] [--resume] [--concurrency 1-4] [--cache cache] [--timeout ms]
  eval report  <runDir> [--cases cases/v1] [--out other/report.md]
  eval compare <runA> <runB> [--out file.md] [--cases cases/v1]
  eval gen-gates  [--out cases/v4-gates]                      # 定向闸/边覆盖集(纯合成,不碰网络)
  eval gates      [--cases cases/v4-gates] [--out runs/gates] # 桩大脑跑一遍 + 闸×触发次数矩阵(零成本)
`;

interface Args {
  cmd: string;
  pos: string[];
  flags: Record<string, string | true>;
}

function parse(argv: string[]): Args {
  const [cmd = '', ...rest] = argv;
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else pos.push(a);
  }
  return { cmd, pos, flags };
}

const str = (f: Record<string, string | true>, k: string, d?: string): string => {
  const v = f[k];
  if (v === undefined || v === true) {
    if (d !== undefined) return d;
    throw new Error(`缺少 --${k}\n${USAGE}`);
  }
  return v;
};

const log = (s: string): void => console.error(s);

async function main(): Promise<void> {
  const { cmd, pos, flags } = parse(process.argv.slice(2));
  if (cmd === 'gen') {
    const out = resolve(str(flags, 'out', 'cases/v1'));
    const opts = {
      symbols: str(flags, 'symbols').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
      tf: str(flags, 'tf', '15m'),
      from: parseDateArg(str(flags, 'from')),
      to: parseDateArg(str(flags, 'to')),
      n: Number(str(flags, 'n', '12')),
      seed: str(flags, 'seed', '7'),
      set: str(flags, 'set', out.split('/').pop() ?? 'v1'),
      chain_step_bars: Number(str(flags, 'step-bars', '4')),
      horizon_bars: Number(str(flags, 'horizon', '48')),
      sample: str(flags, 'sample', 'uniform') as 'uniform' | 'triggers',
      daily_bars: flags['daily-bars'] === undefined ? undefined : Number(str(flags, 'daily-bars')),
      min_spacing_bars: Number(str(flags, 'min-spacing-bars', String(DEFAULT_MIN_SPACING_BARS))),
    };
    if (opts.sample !== 'uniform' && opts.sample !== 'triggers') throw new Error('--sample 只能是 uniform|triggers');
    const cases = await generateCases(opts, binanceSource(resolve(str(flags, 'data', 'data')), log), log);
    // Separate batches let newer assets use shorter daily histories without truncating every symbol.
    const manifestPath = `${out}/_manifest.json`;
    const previous = existsSync(manifestPath) ? readJson<{ generated_with: typeof opts; generation_batches?: typeof opts[] }>(manifestPath) : null;
    const batches = previous?.generation_batches ?? (previous ? [previous.generated_with] : []);
    const batchKey = (o: typeof opts): string => JSON.stringify([o.set, o.symbols]);
    const generation_batches = [...batches.filter((o) => batchKey(o) !== batchKey(opts)), opts];
    for (const c of cases) writeJson(`${out}/${c.id}.json`, c);
    const allCases = loadCases(out);
    const counts: Record<string, number> = {};
    for (const c of allCases) for (const t of c.tags) if (!t.startsWith('chain:') && !t.startsWith('trigger:')) counts[t] = (counts[t] ?? 0) + 1;
    writeJson(manifestPath, { generated_with: opts, generation_batches, cases: allCases.length, tag_counts: counts });
    log(`wrote ${cases.length} cases to ${out}: ${JSON.stringify(counts)}`);
    return;
  }
  if (cmd === 'gen-memory') {
    // Derives long-term-memory variants from an existing case set — no network, no new market data.
    const from = resolve(str(flags, 'from', 'cases/v1'));
    const out = resolve(str(flags, 'out', 'cases/v1-mem'));
    const seed = str(flags, 'seed', '7');
    const set = str(flags, 'set', out.split('/').pop() ?? 'v1-mem');
    const bases = loadCases(from);
    if (!bases.length) throw new Error(`no cases in ${from}`);
    const cases = deriveMemoryCases(bases, { seed, set });
    for (const c of cases) writeJson(`${out}/${c.id}.json`, c);
    const counts: Record<string, number> = {};
    for (const c of cases) for (const t of c.tags) if (!t.startsWith('chain:') && !t.startsWith('trigger:')) counts[t] = (counts[t] ?? 0) + 1;
    writeJson(`${out}/_manifest.json`, { generated_with: { from, seed, set, source_cases: bases.length }, cases: cases.length, tag_counts: counts });
    log(`wrote ${cases.length} cases to ${out} (from ${bases.length} source cases): ${JSON.stringify(counts)}`);
    return;
  }
  if (cmd === 'run') {
    const brain = str(flags, 'brain', 'stub') as BrainKind;
    if (!['stub', 'pi', 'claude', 'zai-api'].includes(brain)) throw new Error(`--brain 只能是 stub|pi|claude|zai-api`);
    const out = resolve(str(flags, 'out', `runs/${brain}-${stamp(Date.now())}`));
    const meta = await runCases(
      {
        casesDir: resolve(str(flags, 'cases', 'cases/v1')),
        outDir: out,
        brain,
        model: flags['model'] === undefined || flags['model'] === true ? undefined : String(flags['model']),
        limit: flags['limit'] === undefined ? null : Number(str(flags, 'limit')),
        tags: flags['tags'] === undefined ? [] : str(flags, 'tags').split(',').map((s) => s.trim()).filter(Boolean),
        only: flags['only'] === undefined ? [] : loadOnlyIds(resolve(str(flags, 'only'))),
        resume: flags['resume'] === true,
        concurrency: Number(str(flags, 'concurrency', '2')),
        cacheDir: resolve(str(flags, 'cache', 'cache')),
        timeoutMs: Number(str(flags, 'timeout', '180000')),
        samples: Number(str(flags, 'samples', '1')),
        temperature: flags['temperature'] === undefined ? undefined : Number(str(flags, 'temperature')),
      },
      log,
    );
    log(`done: ${meta.episodes} episodes in ${(meta.wall_ms / 1000).toFixed(1)} s, cache ${meta.cache_hits} hit / ${meta.cache_misses} miss, brain errors ${meta.brain_errors} → ${out}`);
    const r = writeReport(out);
    log(`report: ${out}/report.md — ${r.verdict}`);
    return;
  }
  if (cmd === 'report') {
    const dir = pos[0];
    if (!dir) throw new Error(USAGE);
    const outMd = flags['out'] === undefined ? undefined : resolve(str(flags, 'out'));
    const r = writeReport(resolve(dir), flags['cases'] === undefined ? undefined : resolve(str(flags, 'cases')), outMd);
    for (const m of r.metrics) log(`${m.status.padEnd(16)} ${m.name.padEnd(26)} ${m.display}`);
    log(`verdict: ${r.verdict}${r.verdict_reasons.length ? ` (${r.verdict_reasons.join('; ')})` : ''} → ${outMd ?? `${resolve(dir)}/report.md`}`);
    return;
  }
  if (cmd === 'gen-gates') {
    const out = resolve(str(flags, 'out', `cases/${GATE_SET}`));
    const cases = generateGateCases();
    // 合成 case 里 K 线占绝大部分体积:紧凑序列化(它们是生成物,不用人读 diff)。
    for (const c of cases) writeText(`${out}/${c.id}.json`, JSON.stringify(c) + '\n');
    const counts: Record<string, number> = {};
    for (const c of cases) for (const t of c.hidden.covers ?? []) counts[t.split(':')[0]!] = (counts[t.split(':')[0]!] ?? 0) + 1;
    writeJson(`${out}/_manifest.json`, { generated_with: { generator: 'gen-gates', graph: '判断图见 packages/gateway/src/demo/graph.ts' }, cases: cases.length, covers: counts });
    log(`wrote ${cases.length} gate cases to ${out}: ${JSON.stringify(counts)}`);
    return;
  }
  if (cmd === 'gates') {
    // 零成本:桩大脑 + 合成 K 线,不碰网络也不调模型。
    const casesDir = resolve(str(flags, 'cases', `cases/${GATE_SET}`));
    const out = resolve(str(flags, 'out', 'runs/gates'));
    const meta = await runCases({ casesDir, outDir: out, brain: 'stub', limit: null, tags: [], only: [], resume: false, concurrency: 4, cacheDir: resolve(str(flags, 'cache', 'cache')), samples: 1 }, log);
    const r = writeGateReport(out, casesDir, flags['out-md'] === undefined ? undefined : resolve(str(flags, 'out-md')));
    for (const row of r.coverage.rows) log(`${(row.rejections === 0 ? 'MISS' : 'HIT ').padEnd(6)} ${row.guard.padEnd(20)} ${row.rejections}`);
    log(`边覆盖: 模型 ${r.edges.model_covered.length}/${r.edges.model_covered.length + r.edges.model_missing.length}, 事件 ${r.edges.event_covered.length}/${r.edges.event_covered.length + r.edges.event_missing.length}`);
    log(`gate coverage: ${r.verdict}${r.problems.length ? ` — ${r.problems.join('; ')}` : ''} → ${r.path} (${meta.episodes} episodes, ${(meta.wall_ms / 1000).toFixed(1)} s)`);
    if (r.verdict === 'FAIL') process.exit(2);
    return;
  }
  if (cmd === 'compare') {
    const [a, b] = pos;
    if (!a || !b) throw new Error(USAGE);
    const { markdown, path } = writeComparison(resolve(a), resolve(b), flags['out'] === undefined ? undefined : resolve(str(flags, 'out')), flags['cases'] === undefined ? undefined : resolve(str(flags, 'cases')));
    console.log(markdown);
    log(`→ ${path}`);
    return;
  }
  console.error(USAGE);
  process.exit(cmd ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
