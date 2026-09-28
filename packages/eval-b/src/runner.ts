import { demo } from '@trade-gate/gateway';
import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { buildEvalContext } from './context.js';
import { deterministicStubBrain } from './stub.js';
import type { EvalCase, EvalEpisode, RunManifest, ValidationAttempt } from './types.js';
import { errorMessage, mapConcurrent, readJson, sha256, stableJson, writeJson } from './util.js';

export interface RunOptions {
  casesDir: string;
  outDir: string;
  cacheDir: string;
  brainKind: 'stub' | 'pi' | 'claude';
  limit: number | null;
  tags: string[];
  resume: boolean;
  concurrency: number;
}

interface CachedBrainResult extends demo.BrainResult {
  cache_key: string;
}

function isBrainResult(value: unknown): value is CachedBrainResult {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['text'] === 'string' &&
    typeof record['model'] === 'string' &&
    typeof record['latency_ms'] === 'number' &&
    typeof record['input_tokens'] === 'number' &&
    typeof record['output_tokens'] === 'number' &&
    typeof record['cache_key'] === 'string'
  );
}

async function completeCached(
  brain: demo.Brain,
  system: string,
  user: string,
  cacheDir: string,
  cacheKey: string,
): Promise<{ result: CachedBrainResult; hit: boolean }> {
  const file = path.join(cacheDir, `${cacheKey}.json`);
  try {
    const cached = await readJson<unknown>(file);
    if (!isBrainResult(cached) || cached.cache_key !== cacheKey) throw new Error(`invalid response cache entry ${file}`);
    return { result: cached, hit: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const response = await brain.complete(system, user);
  const result: CachedBrainResult = { ...response, cache_key: cacheKey };
  await writeJson(file, result);
  return { result, hit: false };
}

function validateRaw(raw: string, evidence: demo.Evidence[], strategyIds: string[]): { judgment: demo.Judgment | null; errors: string[] } {
  try {
    const extracted = demo.extractJson(raw);
    return demo.validateJudgment(extracted, new Set(evidence.map((item) => item.ref)), { strategies: strategyIds });
  } catch (error) {
    return { judgment: null, errors: [errorMessage(error)] };
  }
}

function failedBrainAttempt(error: unknown, brain: demo.Brain): ValidationAttempt {
  const message = `brain error: ${errorMessage(error)}`;
  return {
    raw: '',
    errors: [message],
    valid: false,
    cache_hit: false,
    usage: { text: '', latency_ms: 0, model: brain.name, input_tokens: 0, output_tokens: 0 },
  };
}

async function brainAttempt(
  brain: demo.Brain,
  system: string,
  user: string,
  cacheDir: string,
  cacheKey: string,
  evidence: demo.Evidence[],
  strategyIds: string[],
): Promise<{ attempt: ValidationAttempt; judgment: demo.Judgment | null }> {
  try {
    const response = await completeCached(brain, system, user, cacheDir, cacheKey);
    const validated = validateRaw(response.result.text, evidence, strategyIds);
    return {
      attempt: {
        raw: response.result.text,
        errors: validated.errors,
        valid: validated.judgment !== null,
        cache_hit: response.hit,
        usage: response.result,
      },
      judgment: validated.judgment,
    };
  } catch (error) {
    return { attempt: failedBrainAttempt(error, brain), judgment: null };
  }
}

function failClosed(evalCase: EvalCase): demo.Judgment {
  return {
    action: evalCase.mode === 'scan' ? 'NO_TRADE' : 'HOLD',
    direction: evalCase.mode === 'review' ? evalCase.thread?.side ?? null : null,
    confidence: 0,
    headline: '输出无效，安全关闭',
    thesis: '模型输出未通过契约校验，本次不扩大风险',
    reasons: ['输出未通过契约校验，采用安全动作 [E1]'],
    evidence_refs: ['E1'],
    invalidation: null,
    invalidation_price: null,
    target_price: null,
    watch_conditions: ['等待下一次有效判断'],
    proposal: null,
  };
}

function estimatedCost(model: string, inputTokens: number, outputTokens: number): number {
  if (model === 'stub') return 0;
  // Declared comparison estimate, not a billing claim. See README for assumptions.
  const rates = model.startsWith('claude:') ? { input: 3, output: 15 } : { input: 1, output: 3 };
  return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
}

function chooseBrain(kind: RunOptions['brainKind']): demo.Brain {
  if (kind === 'stub') return deterministicStubBrain();
  if (kind === 'pi') return demo.piBrain();
  return demo.claudeBrain();
}

function repairPrompt(userText: string, raw: string, errors: string[]): string {
  return [
    userText,
    '',
    '## 契约修复',
    `上一次输出:\n${raw || '(空输出)'}`,
    `校验错误:\n${errors.map((error) => `- ${error}`).join('\n')}`,
    '请只返回修复后的单个 JSON 对象。不得引入未登记的证据或数字。',
  ].join('\n');
}

export async function evaluateCase(evalCase: EvalCase, caseFile: string, brain: demo.Brain, cacheDir: string): Promise<EvalEpisode> {
  const built = buildEvalContext(evalCase);
  const primaryKey = sha256(built.context_hash + brain.name + demo.PROMPT_VERSION);
  const primary = await brainAttempt(brain, built.system_text, built.user_text, cacheDir, primaryKey, built.evidence, built.strategy_ids);
  let judgment = primary.judgment;
  let repair: Awaited<ReturnType<typeof brainAttempt>> | null = null;
  if (!judgment) {
    const user = repairPrompt(built.user_text, primary.attempt.raw, primary.attempt.errors);
    const repairContextHash = sha256(built.context_hash + user);
    const repairKey = sha256(repairContextHash + brain.name + demo.PROMPT_VERSION);
    repair = await brainAttempt(brain, built.system_text, user, cacheDir, repairKey, built.evidence, built.strategy_ids);
    judgment = repair.judgment;
  }
  const failClosedUsed = judgment === null;
  const finalJudgment = judgment ?? failClosed(evalCase);
  const staleRefs = new Set(built.evidence.filter((item) => item.stale).map((item) => item.ref));
  const gates = demo.evaluateGates(finalJudgment, {
    halted: evalCase.visible.halted,
    paused: false,
    account: evalCase.visible.account,
    market: evalCase.visible.market,
    opens_today: 0,
    stale_refs: staleRefs,
  });
  const reducer = evalCase.mode === 'review' && evalCase.thread ? demo.reduceReview(evalCase.thread, finalJudgment) : null;
  const attempts = [primary.attempt, ...(repair ? [repair.attempt] : [])];
  const inputTokens = attempts.reduce((sum, attempt) => sum + attempt.usage.input_tokens, 0);
  const outputTokens = attempts.reduce((sum, attempt) => sum + attempt.usage.output_tokens, 0);
  const latency = attempts.reduce((sum, attempt) => sum + attempt.usage.latency_ms, 0);
  const model = attempts.find((attempt) => attempt.usage.model)?.usage.model ?? brain.name;
  return {
    version: 1,
    case_id: evalCase.id,
    case_hash: sha256(stableJson(evalCase)),
    case_file: caseFile,
    tags: evalCase.tags,
    mode: evalCase.mode,
    symbol: evalCase.symbol,
    timeframe: evalCase.timeframe,
    as_of: evalCase.as_of,
    context_text: built.context_text,
    context_hash: built.context_hash,
    prompt_version: demo.PROMPT_VERSION,
    evidence: built.evidence,
    allowed_actions: built.allowed_actions,
    brain: brain.name,
    model,
    raw: repair?.attempt.raw ?? primary.attempt.raw,
    judgment: finalJudgment,
    first_attempt: primary.attempt,
    repair_attempt: repair?.attempt ?? null,
    schema_valid_first: primary.judgment !== null,
    schema_valid_after_repair: finalJudgment !== null && !failClosedUsed,
    fail_closed: failClosedUsed,
    errors: [...primary.attempt.errors, ...(repair?.attempt.errors ?? [])],
    gates,
    reducer,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      latency_ms: latency,
      estimated_cost_usd: estimatedCost(model, inputTokens, outputTokens),
      cache_hits: attempts.filter((attempt) => attempt.cache_hit).length,
      calls: attempts.length,
    },
  };
}

async function walkJson(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkJson(target, base)));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path.relative(base, target));
  }
  return files;
}

function matchesTags(evalCase: EvalCase, selectors: string[]): boolean {
  const positives = selectors.filter((tag) => !tag.startsWith('!'));
  const negatives = selectors.filter((tag) => tag.startsWith('!')).map((tag) => tag.slice(1));
  return positives.every((tag) => evalCase.tags.includes(tag)) && negatives.every((tag) => !evalCase.tags.includes(tag));
}

export async function loadCases(casesDir: string): Promise<{ evalCase: EvalCase; file: string }[]> {
  const files = await walkJson(casesDir);
  const loaded = await Promise.all(files.map(async (file) => ({ evalCase: await readJson<EvalCase>(path.join(casesDir, file)), file })));
  for (const { evalCase, file } of loaded) {
    if (!evalCase.id || !evalCase.visible || !evalCase.hidden) throw new Error(`invalid eval case: ${file}`);
  }
  return loaded.sort((a, b) => a.evalCase.id.localeCompare(b.evalCase.id));
}

export async function runEvaluation(options: RunOptions): Promise<{ manifest: RunManifest; episodes: EvalEpisode[] }> {
  if (options.concurrency < 1 || options.concurrency > 2) throw new Error('--concurrency must be between 1 and 2');
  const casesDir = path.resolve(options.casesDir);
  const outDir = path.resolve(options.outDir);
  const cacheDir = path.resolve(options.cacheDir);
  await stat(casesDir);
  await mkdir(path.join(outDir, 'episodes'), { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  let selected = (await loadCases(casesDir)).filter(({ evalCase }) => matchesTags(evalCase, options.tags));
  if (options.limit !== null) selected = selected.slice(0, options.limit);
  if (selected.length === 0) throw new Error('no cases matched the requested filters');
  const brain = chooseBrain(options.brainKind);
  const episodes = await mapConcurrent(selected, options.concurrency, async ({ evalCase, file }) => {
    const episodeFile = path.join(outDir, 'episodes', `${evalCase.id}.json`);
    if (options.resume) {
      try {
        const existing = await readJson<EvalEpisode>(episodeFile);
        if (existing.case_hash === sha256(stableJson(evalCase)) && existing.brain === brain.name) return existing;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const episode = await evaluateCase(evalCase, file, brain, cacheDir);
    await writeJson(episodeFile, episode);
    return episode;
  });
  const manifest: RunManifest = {
    version: 1,
    harness: '@trade-gate/eval-b',
    cases_dir: casesDir,
    brain: brain.name,
    prompt_version: demo.PROMPT_VERSION,
    selected_tags: options.tags,
    limit: options.limit,
    case_ids: episodes.map((episode) => episode.case_id),
    episode_count: episodes.length,
  };
  await writeJson(path.join(outDir, 'run.json'), manifest);
  return { manifest, episodes };
}
