import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { generateCasesFromData, type HistoricalData, writeCases } from '../src/generator.js';
import { buildReport } from '../src/report.js';
import { evaluateCase, runEvaluation } from '../src/runner.js';
import { minimalCase, syntheticKlines } from './helpers.js';

describe('offline stub gate', () => {
  it('runs a small case set with all hard invariants passing and no market network', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'trade-gate-eval-b-'));
    const start = Date.UTC(2025, 11, 1);
    const from = start + 25 * 86_400_000;
    const data: HistoricalData = {
      BTCUSDT: {
        '15m': syntheticKlines('15m', start, 3_500),
        '1h': syntheticKlines('1h', start, 900),
        '4h': syntheticKlines('4h', start, 300),
      },
    };
    const cases = generateCasesFromData({ symbols: ['BTCUSDT'], timeframe: '15m', from, to: from + 3 * 86_400_000, count: 1, seed: 7, set: 'test' }, data);
    const casesDir = path.join(root, 'cases');
    await writeCases(cases, casesDir);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error('network access is forbidden during run');
    };
    try {
      const result = await runEvaluation({ casesDir, outDir: path.join(root, 'run'), cacheDir: path.join(root, 'cache'), brainKind: 'stub', limit: null, tags: [], resume: false, concurrency: 2 });
      const report = buildReport(path.join(root, 'run'), result.manifest, result.episodes, new Map(cases.map((item) => [item.id, item])));
      for (const name of ['evidence_valid', 'hallucinated_numbers', 'future_leakage', 'stale_trade', 'unauthorized_action']) {
        expect(report.metrics[name]?.status, name).toBe('PASS');
      }
      expect((report.metrics['gate_reject_rate']?.value as { rejected: number }).rejected).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('repairs one invalid model response and records both attempts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'trade-gate-eval-b-repair-'));
    let calls = 0;
    const brain = {
      name: 'repair-test',
      async complete() {
        calls++;
        const text = calls === 1
          ? '{}'
          : JSON.stringify({ action: 'NO_TRADE', direction: null, confidence: 0.2, headline: '修复完成', thesis: '证据不足', reasons: ['证据不足 [E1]'], evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [], proposal: null });
        return { text, latency_ms: 1, model: 'repair-test', input_tokens: 10, output_tokens: 5 };
      },
    };
    const episode = await evaluateCase(minimalCase(), 'minimal.json', brain, path.join(root, 'cache'));
    expect(episode.schema_valid_first).toBe(false);
    expect(episode.schema_valid_after_repair).toBe(true);
    expect(episode.repair_attempt?.valid).toBe(true);
    expect(episode.fail_closed).toBe(false);
    expect(calls).toBe(2);
  });
});
