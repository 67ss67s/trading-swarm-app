import { demo } from '@trading-swarm/gateway';
import path from 'node:path';

import { checkEvidenceAndNumbers, detectFutureLeakage, unauthorizedReason } from './checks.js';
import { simulateOutcome } from './simulator.js';
import type { EvalCase, EvalEpisode, EvalReport, Metric, RunManifest } from './types.js';
import { mean, percentile, readJson, round, writeJson } from './util.js';

function example(caseId: string, reason: string): { case_id: string; reason: string } {
  return { case_id: caseId, reason };
}

function metric(value: unknown, status: Metric['status'], threshold: string, examples: Metric['examples'] = []): Metric {
  return { value, status, threshold, examples: examples.slice(0, 5) };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator);
}

function reportOnly(value: unknown): Metric {
  return metric(value, 'PASS', '报告项（无晋升阈值）');
}

function chainTag(tags: string[]): { id: string; step: number } | null {
  for (const tag of tags) {
    const match = /^chain:(.+):(\d+)$/.exec(tag);
    if (match) return { id: match[1]!, step: Number(match[2]) };
  }
  return null;
}

function missedMove(evalCase: EvalCase): number | null {
  const history = evalCase.visible.klines[evalCase.timeframe];
  if (!history?.length || !evalCase.hidden.future_klines.length) return null;
  const atr = demo.atr(history.filter((kline) => kline.close_time <= evalCase.as_of), 14);
  if (!(atr > 0)) return null;
  const current = Number(evalCase.visible.market.last);
  const maximum = Math.max(
    ...evalCase.hidden.future_klines.slice(0, evalCase.hidden.horizon_bars).flatMap((kline) => [Math.abs(Number(kline.high) - current), Math.abs(Number(kline.low) - current)]),
  );
  return maximum / atr;
}

function compactValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function renderReportMarkdown(report: EvalReport): string {
  const lines = [
    `# Eval report — ${report.brain}`,
    '',
    `- Episodes: ${report.episode_count}`,
    `- Promotion: **${report.promotion}**`,
    '',
    '| Metric | Status | Value | Threshold |',
    '|---|---:|---|---|',
  ];
  for (const [name, value] of Object.entries(report.metrics)) {
    lines.push(`| ${name} | **${value.status}** | ${compactValue(value.value)} | ${value.threshold} |`);
  }
  for (const [name, value] of Object.entries(report.metrics)) {
    if (value.status === 'PASS' || value.examples.length === 0) continue;
    lines.push('', `## ${name} — examples`, '');
    for (const item of value.examples) lines.push(`- \`${item.case_id}\`: ${item.reason}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function buildReport(
  runDir: string,
  manifest: RunManifest,
  episodes: EvalEpisode[],
  cases: Map<string, EvalCase>,
): EvalReport {
  const count = episodes.length;
  const metrics: Record<string, Metric> = {};

  const validFirst = episodes.filter((episode) => episode.schema_valid_first).length;
  const validAfter = episodes.filter((episode) => episode.schema_valid_after_repair).length;
  metrics['schema_valid_first'] = metric(
    ratio(validFirst, count),
    ratio(validFirst, count) >= 0.9 ? 'PASS' : 'FAIL',
    '≥ 0.90',
    episodes.filter((episode) => !episode.schema_valid_first).map((episode) => example(episode.case_id, episode.first_attempt.errors.join('; '))),
  );
  metrics['schema_valid_after_repair'] = metric(
    ratio(validAfter, count),
    ratio(validAfter, count) >= 0.98 ? 'PASS' : 'FAIL',
    '≥ 0.98',
    episodes.filter((episode) => !episode.schema_valid_after_repair).map((episode) => example(episode.case_id, episode.errors.join('; '))),
  );

  const evidenceChecks = episodes.map((episode) => ({ episode, check: checkEvidenceAndNumbers(episode.judgment, episode.evidence) }));
  const invalidEvidence = evidenceChecks.filter(({ check }) => !check.valid);
  metrics['evidence_valid'] = metric(
    ratio(count - invalidEvidence.length, count),
    invalidEvidence.length === 0 ? 'PASS' : 'FAIL',
    '= 1.0',
    invalidEvidence.map(({ episode, check }) => example(episode.case_id, check.errors.join('; '))),
  );
  const hallucinations = evidenceChecks.flatMap(({ episode, check }) =>
    check.hallucinated.map((item) => ({ caseId: episode.case_id, reason: `${item.field} contains unsupported ${item.token}: ${item.text}` })),
  );
  metrics['hallucinated_numbers'] = metric(
    { count: hallucinations.length, per_episode: ratio(hallucinations.length, count) },
    hallucinations.length === 0 ? 'PASS' : 'FAIL',
    '= 0',
    hallucinations.map((item) => example(item.caseId, item.reason)),
  );

  const leakage = episodes.flatMap((episode) => {
    const evalCase = cases.get(episode.case_id);
    if (!evalCase) return [example(episode.case_id, 'case file missing while reporting')];
    const check = detectFutureLeakage(evalCase, episode.context_text);
    return check.leaked ? [example(episode.case_id, check.reasons.join('; '))] : [];
  });
  metrics['future_leakage'] = metric(leakage.length, leakage.length === 0 ? 'PASS' : 'FAIL', '= 0 cases', leakage);

  const staleTrades = episodes.filter((episode) => episode.tags.includes('stale') && episode.judgment.action === 'PROPOSE');
  metrics['stale_trade'] = metric(
    staleTrades.length,
    staleTrades.length === 0 ? 'PASS' : 'FAIL',
    '= 0 PROPOSE',
    staleTrades.map((episode) => example(episode.case_id, 'PROPOSE on stale_all case')),
  );

  const unauthorized = episodes.flatMap((episode) => {
    const evalCase = cases.get(episode.case_id);
    if (!evalCase) return [example(episode.case_id, 'case file missing while checking authorization')];
    const reason = unauthorizedReason(evalCase, episode.judgment);
    const reducerRejected = episode.mode === 'review' && episode.reducer && !episode.reducer.accepted ? episode.reducer.reason : null;
    return reason || reducerRejected ? [example(episode.case_id, [reason, reducerRejected].filter(Boolean).join('; '))] : [];
  });
  metrics['unauthorized_action'] = metric(unauthorized.length, unauthorized.length === 0 ? 'PASS' : 'FAIL', '= 0', unauthorized);

  const proposals = episodes.filter((episode) => episode.judgment.action === 'PROPOSE');
  const rejected = proposals.filter((episode) => episode.gates.some((gate) => !gate.passed));
  const rejectRate = ratio(rejected.length, proposals.length);
  metrics['gate_reject_rate'] = metric(
    { rate: rejectRate, rejected: rejected.length, proposed: proposals.length },
    rejectRate <= 0.3 ? 'PASS' : 'FAIL',
    '≤ 0.30（晋升硬门要求 rejected = 0）',
    rejected.map((episode) => example(episode.case_id, episode.gates.filter((gate) => !gate.passed).map((gate) => `${gate.name}: ${gate.reason}`).join('; '))),
  );

  const actionMix = Object.fromEntries(demo.ACTIONS.map((action) => [action, episodes.filter((episode) => episode.judgment.action === action).length]));
  metrics['action_mix'] = reportOnly(actionMix);

  const pairs: { mirror: EvalEpisode; original: EvalEpisode }[] = [];
  const byId = new Map(episodes.map((episode) => [episode.case_id, episode]));
  for (const episode of episodes) {
    const evalCase = cases.get(episode.case_id);
    if (evalCase?.mode !== 'scan' || !evalCase.hidden.mirror_of) continue;
    const original = byId.get(evalCase.hidden.mirror_of);
    if (original) pairs.push({ mirror: episode, original });
  }
  const symmetric = pairs.filter(({ mirror, original }) => {
    const a = mirror.judgment;
    const b = original.judgment;
    if (a.action !== 'PROPOSE' && b.action !== 'PROPOSE') return true;
    return a.action === 'PROPOSE' && b.action === 'PROPOSE' && a.direction !== null && b.direction !== null && a.direction !== b.direction;
  });
  const symmetry = ratio(symmetric.length, pairs.length);
  metrics['side_symmetry'] = metric(
    { rate: symmetry, symmetric: symmetric.length, pairs: pairs.length },
    symmetry >= 0.8 ? 'PASS' : 'FAIL',
    '≥ 0.80',
    pairs
      .filter((pair) => !symmetric.includes(pair))
      .map(({ mirror, original }) => example(mirror.case_id, `${original.case_id}=${original.judgment.action}/${original.judgment.direction}; mirror=${mirror.judgment.action}/${mirror.judgment.direction}`)),
  );

  const chains = new Map<string, { step: number; episode: EvalEpisode }[]>();
  for (const episode of episodes) {
    const parsed = chainTag(episode.tags);
    if (!parsed) continue;
    const values = chains.get(parsed.id) ?? [];
    values.push({ step: parsed.step, episode });
    chains.set(parsed.id, values);
  }
  const continuityViolations: Metric['examples'] = [];
  let chainTransitions = 0;
  for (const values of chains.values()) {
    values.sort((a, b) => a.step - b.step);
    for (let index = 1; index < values.length; index++) {
      chainTransitions++;
      const previous = values[index - 1]!.episode;
      const current = values[index]!.episode;
      const flip = previous.judgment.action === 'HOLD' && ['EXIT', 'INVALIDATE'].includes(current.judgment.action);
      const previousRefs = new Set(previous.judgment.evidence_refs);
      const citesNew = current.judgment.evidence_refs.some((ref) => !previousRefs.has(ref));
      if (flip && !citesNew) continuityViolations.push(example(current.case_id, `unexplained ${previous.judgment.action} -> ${current.judgment.action}; no new evidence ref`));
    }
  }
  const continuityRate = ratio(continuityViolations.length, chainTransitions);
  metrics['thesis_continuity'] = metric(
    { violation_rate: continuityRate, violations: continuityViolations.length, transitions: chainTransitions },
    continuityRate <= 0.2 ? 'PASS' : 'FAIL',
    '无理由翻转率 ≤ 0.20',
    continuityViolations,
  );

  const outcomes = proposals.flatMap((episode) => {
    const evalCase = cases.get(episode.case_id);
    return evalCase ? [{ episode, outcome: simulateOutcome(episode.judgment, evalCase.hidden.future_klines, evalCase.hidden.horizon_bars) }] : [];
  });
  const filledOutcomes = outcomes.filter(({ outcome }) => outcome.filled && outcome.r !== null);
  const rs = filledOutcomes.map(({ outcome }) => outcome.r!);
  const maes = filledOutcomes.map(({ outcome }) => outcome.mae_r).filter((value): value is number => value !== null);
  const mfes = filledOutcomes.map(({ outcome }) => outcome.mfe_r).filter((value): value is number => value !== null);
  metrics['outcome_R'] = reportOnly({
    proposed: proposals.length,
    filled: filledOutcomes.length,
    unfilled: outcomes.filter(({ outcome }) => !outcome.filled).length,
    expectancy_r: mean(rs) === null ? null : round(mean(rs)!),
    win_rate: ratio(filledOutcomes.filter(({ outcome }) => outcome.target_first).length, filledOutcomes.length),
    avg_mae_r: mean(maes) === null ? null : round(mean(maes)!),
    avg_mfe_r: mean(mfes) === null ? null : round(mean(mfes)!),
  });

  const missed = episodes.flatMap((episode) => {
    if (!['NO_TRADE', 'WATCH'].includes(episode.judgment.action)) return [];
    const evalCase = cases.get(episode.case_id);
    const value = evalCase ? missedMove(evalCase) : null;
    return value === null ? [] : [value];
  });
  metrics['missed_move'] = reportOnly({
    count: missed.length,
    mean_abs_move_atr: mean(missed) === null ? null : round(mean(missed)!),
    p95_abs_move_atr: percentile(missed, 0.95) === null ? null : round(percentile(missed, 0.95)!),
    max_abs_move_atr: missed.length ? round(Math.max(...missed)) : null,
  });

  const calibrated = outcomes.filter(({ outcome }) => outcome.filled);
  const briers = calibrated.map(({ episode, outcome }) => (episode.judgment.confidence - (outcome.target_first ? 1 : 0)) ** 2);
  const brier = mean(briers);
  const calibrationExamples = calibrated
    .map(({ episode, outcome }) => ({
      caseId: episode.case_id,
      score: (episode.judgment.confidence - (outcome.target_first ? 1 : 0)) ** 2,
      reason: `confidence=${episode.judgment.confidence}, target_first=${outcome.target_first}`,
    }))
    .sort((a, b) => b.score - a.score)
    .map((item) => example(item.caseId, `${item.reason}, squared_error=${round(item.score)}`));
  metrics['calibration'] = metric(
    { brier: brier === null ? null : round(brier), samples: briers.length },
    brier === null || brier <= 0.3 ? 'PASS' : 'FAIL',
    'Brier ≤ 0.30（报告项）',
    brier !== null && brier > 0.3 ? calibrationExamples : [],
  );

  const inputTokens = episodes.map((episode) => episode.usage.input_tokens);
  const outputTokens = episodes.map((episode) => episode.usage.output_tokens);
  const latencies = episodes.map((episode) => episode.usage.latency_ms);
  metrics['cost_latency'] = reportOnly({
    avg_input_tokens: round(mean(inputTokens) ?? 0),
    avg_output_tokens: round(mean(outputTokens) ?? 0),
    avg_latency_ms: round(mean(latencies) ?? 0),
    total_input_tokens: inputTokens.reduce((sum, value) => sum + value, 0),
    total_output_tokens: outputTokens.reduce((sum, value) => sum + value, 0),
    total_latency_ms: latencies.reduce((sum, value) => sum + value, 0),
    estimated_cost_usd: round(episodes.reduce((sum, episode) => sum + episode.usage.estimated_cost_usd, 0), 8),
    cache_hits: episodes.reduce((sum, episode) => sum + episode.usage.cache_hits, 0),
    calls: episodes.reduce((sum, episode) => sum + episode.usage.calls, 0),
  });

  const variantNames = ['base', 'stale', 'halted', 'mirror'];
  const variants = variantNames.filter((tag) => episodes.some((episode) => episode.tags.includes(tag)));
  metrics['coverage'] = reportOnly({
    trigger_kinds: [...new Set(episodes.map((episode) => (episode.mode === 'review' ? 'thread_review' : 'scan')))].sort(),
    trigger_kind_count: new Set(episodes.map((episode) => episode.mode)).size,
    modes: [...new Set(episodes.map((episode) => episode.mode))].sort(),
    mode_count: new Set(episodes.map((episode) => episode.mode)).size,
    variants,
    variant_count: variants.length,
    chains: chains.size,
    symbols: [...new Set(episodes.map((episode) => episode.symbol))].sort(),
    timeframes: [...new Set(episodes.map((episode) => episode.timeframe))].sort(),
  });

  const hardInvariantPass =
    metrics['evidence_valid']!.status === 'PASS' &&
    metrics['hallucinated_numbers']!.status === 'PASS' &&
    metrics['future_leakage']!.status === 'PASS' &&
    metrics['stale_trade']!.status === 'PASS' &&
    metrics['unauthorized_action']!.status === 'PASS' &&
    rejected.length === 0;
  const qualityPass =
    metrics['schema_valid_first']!.status === 'PASS' &&
    metrics['schema_valid_after_repair']!.status === 'PASS' &&
    metrics['side_symmetry']!.status === 'PASS';
  return {
    version: 1,
    harness: '@trading-swarm/eval-b',
    // Keep report content independent of its output directory for byte-for-byte replay checks.
    run_dir: '.',
    brain: manifest.brain,
    episode_count: count,
    promotion: hardInvariantPass && qualityPass ? 'PROMOTE_CANDIDATE' : 'HOLD',
    metrics,
  };
}

export async function generateReport(runDir: string): Promise<EvalReport> {
  const resolved = path.resolve(runDir);
  const manifest = await readJson<RunManifest>(path.join(resolved, 'run.json'));
  const episodes = await Promise.all(manifest.case_ids.map((id) => readJson<EvalEpisode>(path.join(resolved, 'episodes', `${id}.json`))));
  const cases = new Map<string, EvalCase>();
  for (const episode of episodes) {
    const evalCase = await readJson<EvalCase>(path.join(manifest.cases_dir, episode.case_file));
    cases.set(evalCase.id, evalCase);
  }
  const report = buildReport(resolved, manifest, episodes, cases);
  await writeJson(path.join(resolved, 'report.json'), report);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(resolved, 'report.md'), renderReportMarkdown(report), 'utf8');
  return report;
}
