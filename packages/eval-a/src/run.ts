// Runner (docs/eval/README.md §3): case → buildContext → brain (cached) → extract/validate (one repair,
// then fail-closed) → gates → thread reducer → runs/<id>/episodes/<case>.json. No network here except
// the model subprocess itself.

import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { demo } from '@trading-swarm/gateway';
import { cacheKey, ResponseCache } from './cache.js';
import { zaiApiBrain } from './api-brain.js';
import { citedMemoryIds } from './checks.js';
import { evaluateAllGates } from './gate-coverage.js';
import { buildCase } from './inputs.js';
import { evalStubBrain } from './stub.js';
import type { EpisodeRecord, EvalCase, Judgment, RunMeta, SampleRecord } from './types.js';
import { listJsonFiles, readJson, sha256, writeJson } from './util.js';

export type BrainKind = 'stub' | 'pi' | 'claude' | 'zai-api';

export interface RunOptions {
  casesDir: string;
  outDir: string;
  brain: BrainKind;
  model?: string;
  limit?: number | null;
  tags?: string[];
  resume?: boolean;
  concurrency?: number;
  cacheDir: string;
  timeoutMs?: number;
  /** Samples per case (same context, independent model calls); default 1. */
  samples?: number;
  /** Restrict the run to these case ids (`--only ids.txt` or `--only a,b`); empty/undefined = the whole set. */
  only?: string[];
  /** zai-api brain only. */
  temperature?: number;
}

/** Per-call price used for cost_estimate; unknown models report 0 with currency 'n/a'. */
export const PRICE_TABLE: Record<string, { per_call: number; currency: string }> = {
  'pi:zai/glm-5.3': { per_call: 0.006, currency: 'CNY' },
  stub: { per_call: 0, currency: 'CNY' },
};

export function priceFor(model: string): { per_call: number; currency: string } {
  return PRICE_TABLE[model] ?? (model.startsWith('pi:') ? { per_call: 0.006, currency: 'CNY' } : { per_call: 0, currency: 'n/a' });
}

export function makeBrain(kind: BrainKind, model?: string, temperature?: number): demo.Brain {
  if (kind === 'stub') return evalStubBrain();
  if (kind === 'pi') return demo.piBrain(model ? { model } : {});
  if (kind === 'zai-api') return zaiApiBrain({ ...(model ? { model } : {}), temperature: temperature ?? 0 });
  return demo.claudeBrain(model ? { model } : {});
}

/** Most frequent action wins; ties → the lowest k (deterministic, and k=0 is the sample old single-sample runs would have had). */
export function pickMode(samples: { k: number; judgment: Judgment }[]): { index: number; agreement: number; actions_seen: Record<string, number>; tie: boolean } {
  const counts: Record<string, number> = {};
  for (const s of samples) counts[s.judgment.action] = (counts[s.judgment.action] ?? 0) + 1;
  const best = Math.max(...Object.values(counts));
  const winners = Object.keys(counts).filter((a) => counts[a] === best);
  const tie = winners.length > 1;
  const index = samples.findIndex((s) => winners.includes(s.judgment.action));
  return { index, agreement: best / samples.length, actions_seen: counts, tie };
}

/**
 * `--only`: either a file (one case id per line, `#` comments and blanks ignored) or a comma-separated list.
 * Used to re-run just the unstable ids from a previous multi-sample run instead of the whole set.
 */
export function loadOnlyIds(arg: string): string[] {
  const raw = existsSync(arg) ? readFileSync(arg, 'utf8').split('\n') : arg.split(',');
  return [...new Set(raw.map((s) => s.replace(/#.*$/, '').trim()).filter(Boolean))];
}

export function loadCases(dir: string): EvalCase[] {
  return listJsonFiles(dir)
    .filter((f) => !basename(f).startsWith('_'))
    .map((f) => readJson<EvalCase>(f))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** `--tags a,b,!c`: keep cases having any of the plain tags (or all cases when none given) and none of the `!` tags; `--only` then narrows to an explicit id list. */
export function filterCases(cases: EvalCase[], tags: string[] = [], limit: number | null = null, only: string[] = []): EvalCase[] {
  const include = tags.filter((t) => !t.startsWith('!'));
  const exclude = tags.filter((t) => t.startsWith('!')).map((t) => t.slice(1));
  let out = cases.filter((c) => (include.length === 0 || include.some((t) => c.tags.includes(t))) && !exclude.some((t) => c.tags.includes(t)));
  if (only && only.length) {
    const want = new Set(only);
    out = out.filter((c) => want.has(c.id));
  }
  if (limit !== null && limit >= 0) out = out.slice(0, limit);
  return out;
}

function failClosed(mode: 'scan' | 'review', why: string): Judgment {
  return {
    action: mode === 'scan' ? 'NO_TRADE' : 'HOLD',
    direction: null,
    confidence: 0,
    headline: '模型输出不合契约,按安全默认处理',
    thesis: `模型两次输出均未通过契约校验(${why}),harness 按 fail-closed 规则给出 ${mode === 'scan' ? 'NO_TRADE' : 'HOLD'}。`,
    reasons: ['输出校验失败,采用安全默认 [E1]'],
    evidence_refs: ['E1'],
    invalidation: null,
    invalidation_price: null,
    target_price: null,
    watch_conditions: [],
    proposal: null,
  };
}

async function complete(brain: demo.Brain, cache: ResponseCache | null, key: string, system: string, user: string, timeoutMs: number, meta: { context_hash: string; extra: string }): Promise<demo.BrainResult> {
  const hit = cache?.get(key);
  if (hit) return { text: hit.text, latency_ms: hit.latency_ms, model: hit.model, input_tokens: hit.input_tokens, output_tokens: hit.output_tokens };
  let last: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await brain.complete(system, user, { timeoutMs });
      cache?.put(key, { text: r.text, model: r.model, latency_ms: r.latency_ms, input_tokens: r.input_tokens, output_tokens: r.output_tokens, cached_at: Date.now(), context_hash: meta.context_hash, prompt_version: demo.PROMPT_VERSION, extra: meta.extra });
      return r;
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

function repairPrompt(user: string, raw: string, errors: string[]): string {
  return `${user}\n\n## 修正\n你上一次的输出没有通过契约校验,错误如下:\n${errors.map((e) => `- ${e}`).join('\n')}\n上一次输出(节选):\n${raw.slice(0, 1500)}\n请修正后只输出一个 JSON 对象,不要任何解释。`;
}

interface SampleOut {
  raw: string;
  rawRepair: string | null;
  errorsFirst: string[];
  errorsRepair: string[];
  source: EpisodeRecord['judgment_source'];
  judgment: Judgment;
  brainError: string | null;
  usage: { input_tokens: number; output_tokens: number; latency_ms: number };
  calls: number;
  model: string;
}

/** One independent sample of the model on a built context. `k` > 0 gets its own cache slot (`|sample|k`); k=0 is the legacy key. */
async function sampleOnce(c: EvalCase, built: ReturnType<typeof buildCase>['built'], refs: Set<string>, brain: demo.Brain, cache: ResponseCache | null, timeoutMs: number, k: number): Promise<SampleOut> {
  let raw = '';
  let rawRepair: string | null = null;
  let errorsFirst: string[] = [];
  let errorsRepair: string[] = [];
  let source: EpisodeRecord['judgment_source'] = 'first';
  let judgment: Judgment | null = null;
  let brainError: string | null = null;
  let calls = 0;
  const usage = { input_tokens: 0, output_tokens: 0, latency_ms: 0 };
  let model = brain.name;
  const absorb = (r: demo.BrainResult): void => {
    calls++;
    usage.input_tokens += r.input_tokens;
    usage.output_tokens += r.output_tokens;
    usage.latency_ms += r.latency_ms;
    model = r.model;
  };
  const tryParse = (text: string): { judgment: Judgment | null; errors: string[] } => {
    try {
      const v = demo.validateJudgment(demo.extractJson(text), refs);
      if (v.judgment) {
        const leaks = demo.findMemoryNumberLeaks(v.judgment, built.evidence);
        if (leaks.length) return { judgment: null, errors: [...v.errors, ...leaks] };
      }
      return { judgment: v.judgment, errors: v.errors };
    } catch (e) {
      return { judgment: null, errors: [e instanceof Error ? e.message : String(e)] };
    }
  };
  const sampleExtra = k === 0 ? '' : `|sample|${k}`;
  try {
    const r1 = await complete(brain, cache, cacheKey(built.context_hash, brain.name, demo.PROMPT_VERSION, sampleExtra), built.system_text, built.user_text, timeoutMs, { context_hash: built.context_hash, extra: sampleExtra });
    absorb(r1);
    raw = r1.text;
    const p1 = tryParse(raw);
    judgment = p1.judgment;
    errorsFirst = p1.errors;
    if (!judgment) {
      const user2 = repairPrompt(built.user_text, raw, errorsFirst);
      const extra = `${sampleExtra}|repair|${sha256(user2)}`;
      const r2 = await complete(brain, cache, cacheKey(built.context_hash, brain.name, demo.PROMPT_VERSION, extra), built.system_text, user2, timeoutMs, { context_hash: built.context_hash, extra });
      absorb(r2);
      rawRepair = r2.text;
      const p2 = tryParse(rawRepair);
      judgment = p2.judgment;
      errorsRepair = p2.errors;
      source = judgment ? 'repair' : 'fail_closed';
    }
  } catch (e) {
    brainError = e instanceof Error ? e.message : String(e);
    if (!errorsFirst.length) errorsFirst = [`brain error: ${brainError}`];
    else errorsRepair = [`brain error: ${brainError}`];
    source = 'fail_closed';
  }
  if (!judgment) judgment = failClosed(c.mode, brainError ?? errorsRepair.join('; ') ?? errorsFirst.join('; '));
  return { raw, rawRepair, errorsFirst, errorsRepair, source, judgment, brainError, usage, calls, model };
}

export async function runEpisode(c: EvalCase, brain: demo.Brain, cache: ResponseCache | null, timeoutMs = 180_000, samplesN = 1): Promise<EpisodeRecord> {
  const { inputs, built, stale_refs } = buildCase(c);
  const refs = new Set(built.evidence.map((e) => e.ref));
  const price = priceFor(brain.name);
  const N = Math.max(1, Math.floor(samplesN));
  const outs: SampleOut[] = [];
  for (let k = 0; k < N; k++) outs.push(await sampleOnce(c, built, refs, brain, cache, timeoutMs, k));
  const mode = pickMode(outs.map((o, k) => ({ k, judgment: o.judgment })));
  const chosen = outs[mode.index]!;
  const usage = outs.reduce((a, o) => ({ input_tokens: a.input_tokens + o.usage.input_tokens, output_tokens: a.output_tokens + o.usage.output_tokens, latency_ms: a.latency_ms + o.usage.latency_ms }), { input_tokens: 0, output_tokens: 0, latency_ms: 0 });
  const calls = outs.reduce((a, o) => a + o.calls, 0);
  const model = chosen.model;
  const raw = chosen.raw;
  const rawRepair = chosen.rawRepair;
  const errorsFirst = chosen.errorsFirst;
  const errorsRepair = chosen.errorsRepair;
  const source = chosen.source;
  const judgment = chosen.judgment;
  const brainError = chosen.brainError;
  const samples: SampleRecord[] | undefined =
    N > 1
      ? outs.map((o, k) => ({ k, raw: o.raw, raw_repair: o.rawRepair, errors_first: o.errorsFirst, errors_repair: o.errorsRepair, judgment_source: o.source, judgment: o.judgment, brain_error: o.brainError, usage: { ...o.usage, model_calls: o.calls, cost_estimate: (o.calls * price.per_call).toFixed(4), currency: price.currency }, memory_cited: citedMemoryIds(o.judgment, built.evidence) }))
      : undefined;
  const review = c.mode === 'review' && c.thread ? demo.reduceReview(c.thread, judgment) : null;
  // 09-12:`visible.gate_env` 缺席时这就是原来的 `demo.evaluateGates(...)` 一句;写了 gate_env 的定向
  // 用例才会额外跑 runtime 建仓路径上并列的那几道闸(docs/eval/gate-coverage-2026-09-12.md)。
  const gates = evaluateAllGates(c, judgment, stale_refs, inputs.now, review);
  // Judgment-graph position (docs/design/graph-engineering-v2.md §2): the node buildContext used, the edge
  // the model's action takes there (the reducer already resolved it in review mode), the guards evaluated,
  // and the action itself when it has no edge at all. eval reads this back in the four graph metrics.
  const modelEdge = demo.edgeFor(built.node, judgment.action);
  const graph = {
    version: demo.GRAPH_VERSION,
    node: built.node,
    edge: review ? review.edge : (modelEdge?.id ?? null),
    // Same convention as the runtime: review episodes never run the opening gates, their edge carries
    // `thread_still_open`; scan episodes record the guard ids of the gates actually evaluated.
    guards: review ? (modelEdge?.guards ?? []) : demo.guardsFromGates(gates),
    illegal_action: modelEdge ? null : judgment.action,
  };
  return {
    case_id: c.id,
    set: c.set,
    tags: c.tags,
    symbol: c.symbol,
    timeframe: c.timeframe,
    as_of: c.as_of,
    mode: c.mode,
    brain: brain.name.split(':')[0]!,
    model,
    prompt_version: demo.PROMPT_VERSION,
    trigger: inputs.trigger,
    context_text: built.context_text,
    context_hash: built.context_hash,
    evidence: built.evidence,
    allowed_actions: built.allowed_actions,
    stale_refs,
    raw,
    raw_repair: rawRepair,
    errors_first: errorsFirst,
    errors_repair: errorsRepair,
    judgment_source: source,
    judgment,
    strategy_id: judgment.strategy_id ?? null,
    gates,
    gates_passed: gates.every((g) => g.passed),
    review: review ? { accepted: review.accepted, reason: review.reason, effect: review.effect } : null,
    graph,
    // Long-term memory: what was put in front of the model, and which of those the judgment leaned on
    // (evidence_refs + the [E<n>] markers in reasons). Empty arrays on a case without memories.
    memory: { injected: (c.visible.memories ?? []).map((m) => m.id), cited: citedMemoryIds(judgment, built.evidence) },
    usage: { ...usage, model_calls: calls, cost_estimate: (calls * price.per_call).toFixed(4), currency: price.currency },
    brain_error: brainError,
    ...(samples ? { samples, agreement: mode.agreement, actions_seen: mode.actions_seen, mode_tie: mode.tie } : {}),
  };
}

export async function runCases(opts: RunOptions, log: (s: string) => void = () => {}, brainOverride?: demo.Brain): Promise<RunMeta> {
  const started = Date.now();
  const cases = filterCases(loadCases(opts.casesDir), opts.tags ?? [], opts.limit ?? null, opts.only ?? []);
  if (!cases.length) throw new Error(`no cases in ${opts.casesDir} match`);
  if (opts.only?.length) {
    const got = new Set(cases.map((c) => c.id));
    const missing = opts.only.filter((id) => !got.has(id));
    if (missing.length) log(`--only: ${missing.length} 个 id 在 case 集里不存在(${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''})`);
  }
  const brain = brainOverride ?? makeBrain(opts.brain, opts.model, opts.temperature);
  const cache = opts.brain === 'stub' && !brainOverride ? null : new ResponseCache(opts.cacheDir);
  const outDir = resolve(opts.outDir);
  const epDir = join(outDir, 'episodes');
  const wantN = Math.max(1, Math.floor(opts.samples ?? 1));
  // --resume: an existing episode only counts as done when it carries at least the requested number of samples
  // (old single-sample runs are redone; their k=0 sample is served from cache).
  const isDone = (id: string): boolean => {
    const f = join(epDir, `${id}.json`);
    if (!existsSync(f)) return false;
    try {
      const rec = readJson<EpisodeRecord>(f);
      return (rec.samples?.length ?? 1) >= wantN;
    } catch {
      return false;
    }
  };
  const todo = cases.filter((c) => !(opts.resume && isDone(c.id)));
  log(`run ${basename(outDir)}: ${cases.length} cases (${cases.length - todo.length} already done), brain ${brain.name}`);
  const concurrency = Math.max(1, Math.min(4, opts.concurrency ?? 2));
  let next = 0;
  let done = 0;
  let brainErrors = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length) {
      const c = todo[next++]!;
      const t0 = Date.now();
      const rec = await runEpisode(c, brain, cache, opts.timeoutMs, opts.samples ?? 1);
      if (rec.brain_error || rec.samples?.some((x) => x.brain_error)) brainErrors++;
      writeJson(join(epDir, `${c.id}.json`), rec);
      done++;
      log(`[${done}/${todo.length}] ${c.id} → ${rec.judgment.action}${rec.judgment.direction ? `/${rec.judgment.direction}` : ''} (${rec.judgment_source}${rec.agreement !== undefined ? `, 一致 ${Math.round(rec.agreement * 100)}%` : ''}, ${Date.now() - t0} ms${rec.brain_error ? `, ERROR ${rec.brain_error}` : ''})`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const meta: RunMeta = {
    run_id: basename(outDir),
    brain: opts.brain,
    model: brain.name,
    prompt_version: demo.PROMPT_VERSION,
    cases_dir: resolve(opts.casesDir),
    set: cases[0]!.set,
    limit: opts.limit ?? null,
    tags: opts.tags ?? [],
    ...(opts.only?.length ? { only: opts.only } : {}),
    concurrency,
    started_at: started,
    finished_at: Date.now(),
    wall_ms: Date.now() - started,
    episodes: cases.length,
    cache_hits: cache?.hits ?? 0,
    cache_misses: cache?.misses ?? 0,
    brain_errors: brainErrors,
  };
  writeJson(join(outDir, 'run.json'), meta);
  return meta;
}
