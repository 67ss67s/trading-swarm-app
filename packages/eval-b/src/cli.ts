#!/usr/bin/env node
import path from 'node:path';

import { compareRuns } from './compare.js';
import { generateCases, generationOptionsFromStrings } from './generator.js';
import { generateReport } from './report.js';
import { runEvaluation } from './runner.js';
import { errorMessage } from './util.js';

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(values: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const equal = value.indexOf('=');
    if (equal > 2) {
      flags.set(value.slice(2, equal), value.slice(equal + 1));
      continue;
    }
    const name = value.slice(2);
    const next = values[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      index++;
    } else {
      flags.set(name, true);
    }
  }
  return { positional, flags };
}

function stringFlag(args: ParsedArgs, name: string, fallback?: string): string {
  const value = args.flags.get(name) ?? fallback;
  if (typeof value !== 'string') throw new Error(`--${name} requires a value`);
  return value;
}

function optionalNumber(args: ParsedArgs, name: string): number | null {
  const value = args.flags.get(name);
  if (value === undefined) return null;
  if (typeof value !== 'string' || !Number.isInteger(Number(value)) || Number(value) < 1) throw new Error(`--${name} must be a positive integer`);
  return Number(value);
}

function printHelp(): void {
  process.stdout.write(
    [
      'trade-gate eval-b',
      '',
      'gen --symbols BTCUSDT,ETHUSDT --tf 15m --from YYYY-MM-DD --to YYYY-MM-DD --n 12 --seed 7 --out cases/v1',
      'run --cases cases/v1 --brain stub|pi|claude --out runs/name [--limit N] [--tags a,b,!c] [--resume]',
      'report runs/name',
      'compare runs/a runs/b [--out runs/comparison]',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const command = parsed.positional[0];
  if (!command || command === 'help' || parsed.flags.has('help')) {
    printHelp();
    return;
  }
  if (command === 'gen') {
    const out = stringFlag(parsed, 'out', 'cases/v1');
    const options = generationOptionsFromStrings({
      symbols: stringFlag(parsed, 'symbols'),
      timeframe: stringFlag(parsed, 'tf'),
      from: stringFlag(parsed, 'from'),
      to: stringFlag(parsed, 'to'),
      count: stringFlag(parsed, 'n', '30'),
      seed: stringFlag(parsed, 'seed', '7'),
      set: path.basename(out),
    });
    const cases = await generateCases(options, stringFlag(parsed, 'data', 'data'), out);
    process.stdout.write(`${JSON.stringify({ command, out: path.resolve(out), cases: cases.length, base_scan_cases: options.count })}\n`);
    return;
  }
  if (command === 'run') {
    const brain = stringFlag(parsed, 'brain', 'stub');
    if (brain !== 'stub' && brain !== 'pi' && brain !== 'claude') throw new Error('--brain must be stub, pi, or claude');
    const result = await runEvaluation({
      casesDir: stringFlag(parsed, 'cases'),
      outDir: stringFlag(parsed, 'out'),
      cacheDir: stringFlag(parsed, 'cache', 'cache'),
      brainKind: brain,
      limit: optionalNumber(parsed, 'limit'),
      tags: stringFlag(parsed, 'tags', '').split(',').map((tag) => tag.trim()).filter(Boolean),
      resume: parsed.flags.has('resume'),
      concurrency: optionalNumber(parsed, 'concurrency') ?? 2,
    });
    process.stdout.write(`${JSON.stringify({ command, out: path.resolve(stringFlag(parsed, 'out')), episodes: result.episodes.length, brain: result.manifest.brain })}\n`);
    return;
  }
  if (command === 'report') {
    const runDir = parsed.positional[1];
    if (!runDir) throw new Error('report requires a run directory');
    const report = await generateReport(runDir);
    process.stdout.write(`${JSON.stringify({ command, run: path.resolve(runDir), episodes: report.episode_count, promotion: report.promotion })}\n`);
    return;
  }
  if (command === 'compare') {
    const runA = parsed.positional[1];
    const runB = parsed.positional[2];
    if (!runA || !runB) throw new Error('compare requires two run directories');
    const output = await compareRuns(runA, runB, parsed.flags.has('out') ? stringFlag(parsed, 'out') : undefined);
    process.stdout.write(`${JSON.stringify({ command, ...output })}\n`);
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`eval-b: ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
