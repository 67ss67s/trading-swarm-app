import { reserveCliModel } from './public-demo.js';
import { assertRealModelsAllowed } from './model-guard.js';
import { ReadCache } from './read-cache.js';
// Brain adapters (design §9 CliBrain): the model is a subprocess, never an SDK in-process — the
// gateway holds no model API keys. `pi` uses its own stored provider auth (zai/GLM by default),
// `claude` uses the Claude Code subscription, `codex` uses the Codex CLI's ChatGPT login.
// The kind + model pair is chosen in the workflow (UI) and can change at runtime; see brainFor().

import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliLaunchStatusView, cliSpawnArgs, defaultCliCommand, stripShellNoise, type CliName } from './cli-launch.js';
import type { BrainKind, BrainOption, BrainTestResult, CliCommandsView, CliResolvedView } from './types.js';

export interface BrainResult {
  text: string;
  latency_ms: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
}

export interface Brain {
  name: string;
  complete(system: string, user: string, opts?: { timeoutMs?: number }): Promise<BrainResult>;
}

/**
 * One CLI run. `command` is the user's configured launch line (bare name / path / env-prefixed / alias);
 * cliSpawnArgs decides whether that is a direct spawn or a trip through the login+interactive shell.
 */
function run(command: string, args: string[], stdin: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null }> {
  assertRealModelsAllowed(`cli ${command}`);
  // 公网演示:访客触发的 CLI 模型调用只允许无工具模式(pi --no-tools / claude --tools ''),并计入演示额度;后台与 owner 不受影响。
  reserveCliModel(args.includes('--no-tools') || (args.includes('--tools') && args[args.indexOf('--tools') + 1] === ''));
  return new Promise((resolve, reject) => {
    const launch = cliSpawnArgs(command, args);
    const cmd = command;
    const child = spawn(launch.file, launch.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...launch.env, ...env } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // A login shell can bracket the real output with session chatter (on stdout!) — drop it, or it
      // ends up inside the model's answer. Direct spawns are left byte-for-byte alone.
      const clean = (s: string): string => (launch.via === 'shell' ? stripShellNoise(s) : s);
      resolve({ stdout: clean(stdout), stderr: clean(stderr), code });
    });
    child.stdin.end(stdin);
  });
}

const approxTokens = (s: string): number => Math.ceil(s.length / 3);

export const DEFAULT_MODELS: Record<BrainKind, string | null> = {
  pi: `${process.env['TG_DEMO_PI_PROVIDER'] ?? 'zai'}/${process.env['TG_DEMO_PI_MODEL'] ?? 'glm-5.3'}`,
  claude: process.env['TG_DEMO_CLAUDE_MODEL'] ?? 'sonnet',
  codex: process.env['TG_DEMO_CODEX_MODEL'] ?? null,
  stub: null,
};

/** `pi -p` in text mode: prints only the assistant's final text. `model` is `provider/model` (pi's own pattern syntax). */
/**
 * `apiKey` is passed to pi as `--api-key` (pi prefers ~/.pi/agent/auth.json over env vars, so a per-run key has to
 * go on argv). It is scrubbed from every error message this adapter produces; callers must not log argv themselves.
 */
/** pi 连接被掐的报错(可安全重试);不含超时 */
export const PI_CONNECTION_DROP = /Connection error|terminated|ECONNRESET|socket hang up|fetch failed|EPIPE/i;

export function piBrain(opts: { provider?: string; model?: string; command?: string | null; apiKey?: string } = {}): Brain {
  const command = opts.command?.trim() || defaultCliCommand('pi');
  let provider = opts.provider ?? process.env['TG_DEMO_PI_PROVIDER'] ?? 'zai';
  let model = opts.model ?? process.env['TG_DEMO_PI_MODEL'] ?? 'glm-5.3';
  const slash = model.indexOf('/');
  if (slash > 0) {
    provider = model.slice(0, slash);
    model = model.slice(slash + 1);
  }
  const name = `pi:${provider}/${model}`;
  return {
    name,
    async complete(system, user, o) {
      const started = Date.now();
      const args = [
        '-p',
        '--no-tools',
        '--no-session',
        '--no-extensions',
        '--no-skills',
        '--no-context-files',
        '--no-prompt-templates',
        '--thinking',
        'off',
        '--mode',
        'text',
        '--provider',
        provider,
        '--model',
        model,
        '--system-prompt',
        system,
      ];
      const key = opts.apiKey?.trim();
      if (key) args.push('--api-key', key);
      const redact = (t: string): string => (key ? t.split(key).join('[redacted]') : t);
      const budget = o?.timeoutMs ?? 120_000;
      let r: Awaited<ReturnType<typeof run>>;
      // 本机经 Clash 出网,到模型服务的连接偶发被掐(pi 报 Connection error / terminated)。这类失败模型还没产出,
      // 重试不会重复计费:隔 2s 最多再试 2 次,且不超过原超时预算。超时(Request timed out)不重试。
      for (let attempt = 1; ; attempt++) {
        try {
          r = await run(command, args, user, Math.max(5_000, budget - (Date.now() - started)));
        } catch (e) {
          throw new Error(redact(e instanceof Error ? e.message : String(e)));
        }
        const dropped = r.code !== 0 && !r.stdout.trim() && PI_CONNECTION_DROP.test(r.stderr);
        if (!dropped || attempt >= 3 || Date.now() - started + 2_000 >= budget) break;
        await new Promise((res) => setTimeout(res, 2_000));
      }
      if (r.code !== 0 && !r.stdout.trim()) throw new Error(redact(`pi exit ${r.code}: ${r.stderr.slice(-400)}`));
      return { text: redact(r.stdout.trim()), latency_ms: Date.now() - started, model: name, input_tokens: approxTokens(system + user), output_tokens: approxTokens(r.stdout) };
    },
  };
}

/** `claude -p --output-format json`: uses the Claude Code subscription; system goes via --append-system-prompt. */
export function claudeBrain(opts: { model?: string; command?: string | null } = {}): Brain {
  const model = opts.model ?? process.env['TG_DEMO_CLAUDE_MODEL'] ?? 'sonnet';
  const command = opts.command?.trim() || defaultCliCommand('claude');
  const name = `claude:${model}`;
  return {
    name,
    async complete(system, user, o) {
      const started = Date.now();
      const args = ['-p', '--output-format', 'json', '--model', model, '--max-turns', '1', '--tools', '', '--append-system-prompt', system];
      const r = await run(command, args, user, o?.timeoutMs ?? 180_000, { CLAUDECODE: '' });
      let text = r.stdout.trim();
      let input = approxTokens(system + user);
      let output = approxTokens(text);
      try {
        const parsed = JSON.parse(text) as { result?: string; usage?: { input_tokens?: number; output_tokens?: number } };
        if (typeof parsed.result === 'string') text = parsed.result;
        if (parsed.usage?.input_tokens) input = parsed.usage.input_tokens;
        if (parsed.usage?.output_tokens) output = parsed.usage.output_tokens;
      } catch {
        // stdout was not the JSON envelope; treat it as the text itself
      }
      if (!text) throw new Error(`claude exit ${r.code}: ${r.stderr.slice(-400)}`);
      return { text, latency_ms: Date.now() - started, model: name, input_tokens: input, output_tokens: output };
    },
  };
}

/**
 * `codex exec` non-interactive: prompt on stdin, final message written to a temp file (-o). Codex has no
 * system-prompt flag, so system + user are concatenated; sandbox read-only, ephemeral (no session on disk).
 */
export function codexBrain(opts: { model?: string | null; command?: string | null } = {}): Brain {
  const model = opts.model ?? process.env['TG_DEMO_CODEX_MODEL'] ?? null;
  const command = opts.command?.trim() || defaultCliCommand('codex');
  const name = `codex:${model ?? 'default'}`;
  return {
    name,
    async complete(system, user, o) {
      const started = Date.now();
      const dir = mkdtempSync(join(tmpdir(), 'tgate-codex-'));
      const outFile = join(dir, 'last.txt');
      try {
        const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-C', dir, '-o', outFile, '--color', 'never'];
        if (model) args.push('-m', model);
        const prompt = `<system>\n${system}\n</system>\n\n${user}`;
        const r = await run(command, args, prompt, o?.timeoutMs ?? 180_000);
        let text = '';
        try {
          text = readFileSync(outFile, 'utf8').trim();
        } catch {
          text = '';
        }
        if (!text) throw new Error(`codex exit ${r.code}: ${(r.stderr || r.stdout).slice(-400)}`);
        return { text, latency_ms: Date.now() - started, model: name, input_tokens: approxTokens(prompt), output_tokens: approxTokens(text) };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

// ---------------------------------------------------------------- cost estimation (v3.3)

/**
 * Rough CNY per 1M tokens, keyed by brain name (`kind:model`, i.e. what lands in `Episode.model`).
 * ESTIMATES only — list prices, no cache discounts, no per-request minimums. Subscription CLIs
 * (claude / codex) have no per-token price at all, so they are absent and contribute nothing.
 */
export const BRAIN_PRICES_CNY: Record<string, { input: number; output: number }> = {
  'pi:zai/glm-5.3': { input: 2, output: 8 },
  'pi:zai/glm-5-turbo': { input: 2, output: 8 },
  'pi:deepseek/deepseek-v4-flash': { input: 1, output: 2 },
};

export function priceFor(brainName: string): { input: number; output: number } | null {
  return BRAIN_PRICES_CNY[brainName] ?? null;
}

/**
 * Estimated CNY for a day's episodes. `null` when nothing priced was used (pure claude/codex
 * subscription days, or no episodes at all) — the UI shows "订阅额度,不计费" instead of ¥0.
 */
export function estimateCny(rows: { model: string; input_tokens: number; output_tokens: number }[]): number | null {
  let total = 0;
  let priced = 0;
  for (const r of rows) {
    const p = priceFor(r.model);
    if (!p) continue;
    priced++;
    total += (r.input_tokens / 1_000_000) * p.input + (r.output_tokens / 1_000_000) * p.output;
  }
  return priced ? Math.round(total * 1000) / 1000 : null;
}

/** Deterministic brain for tests / offline demo: always NO_TRADE citing E1. */
export function stubBrain(fn?: (system: string, user: string) => string): Brain {
  return {
    name: 'stub',
    async complete(system, user) {
      const text =
        fn?.(system, user) ??
        JSON.stringify({
          action: 'NO_TRADE',
          direction: null,
          confidence: 0.2,
          headline: '桩大脑:不交易',
          thesis: '测试用固定输出',
          reasons: ['测试 [E1]'],
          evidence_refs: ['E1'],
          invalidation: null,
          invalidation_price: null,
          target_price: null,
          watch_conditions: ['无'],
          proposal: null,
        });
      return { text, latency_ms: 1, model: 'stub', input_tokens: 0, output_tokens: 0 };
    },
  };
}

/** Test brain: proposes a long at market with stop 1% below / target 2% above the mark it finds in the context. */
function proposeFromContext(_system: string, user: string): string {
  const m = /mark (\d+(?:\.\d+)?)/.exec(user);
  const mark = m ? Number(m[1]) : 0;
  const hasPosition = /持仓: (多|空)/.test(user);
  if (hasPosition || !mark) {
    return JSON.stringify({ action: 'HOLD', direction: 'long', confidence: 0.6, headline: '桩大脑:继续持有', thesis: '测试持仓复查', reasons: ['测试 [E1]'], evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [], proposal: null });
  }
  return JSON.stringify({
    action: 'PROPOSE', direction: 'long', confidence: 0.7, headline: '桩大脑:测试做多', thesis: '测试用提议,验证执行链路',
    reasons: ['测试 [E1]', '测试 [E5]'], evidence_refs: ['E1', 'E5'], invalidation: '跌破止损', invalidation_price: (mark * 0.99).toFixed(1), target_price: (mark * 1.02).toFixed(1),
    watch_conditions: ['止损/止盈'], proposal: { direction: 'long', entry: 'market', limit_price: null, stop_price: (mark * 0.99).toFixed(1), take_profit_price: (mark * 1.02).toFixed(1), rationale: '测试' },
  });
}

/**
 * Builds a brain for (kind, model). `model` null → that kind's default (env or CLI default).
 * `opts.command` is the machine-specific launch command for that CLI (Workflow.cli_commands); omit it
 * and the boot default (TG_DEMO_CLI_* or the bare name) is used.
 */
export function makeBrain(kind: BrainKind, model: string | null = null, opts: { command?: string | null } = {}): Brain {
  const command = opts.command ?? null;
  switch (kind) {
    case 'claude':
      return claudeBrain({ ...(model ? { model } : {}), command });
    case 'codex':
      return codexBrain({ model, command });
    case 'stub':
      return stubBrain();
    default:
      return piBrain({ ...(model ? { model } : {}), command });
  }
}

export function brainFromEnv(): Brain {
  const kind = process.env['TG_DEMO_BRAIN'] ?? 'pi';
  if (kind === 'stub-propose') return stubBrain(proposeFromContext);
  return makeBrain((['pi', 'claude', 'codex', 'stub'] as string[]).includes(kind) ? (kind as BrainKind) : 'pi');
}

/** `pi --list-models` → `provider/model` ids (best effort; empty when pi is missing or slow). */
const piModelsCache = new Map<string, ReadCache<string[]>>();
export function piModelIds(timeoutMs = 4000, command = defaultCliCommand('pi')): string[] {
  let cache = piModelsCache.get(command);
  if (!cache) { if (piModelsCache.size >= 32) piModelsCache.delete(piModelsCache.keys().next().value!); cache = new ReadCache(60_000); piModelsCache.set(command, cache); }
  return cache.read(() => new Promise<string[]>((resolve, reject) => {
    const launch = cliSpawnArgs(command, ['--list-models']);
    execFile(launch.file, launch.args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { ...process.env, ...launch.env } }, (error, stdout) => {
      if (error) { reject(error); return; }
      const out: string[] = [];
      for (const line of String(stdout).split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length >= 2 && cols[0] && cols[1] && /^[a-z0-9-]+$/.test(cols[0])) out.push(`${cols[0]}/${cols[1]}`);
      }
      resolve(out);
    });
  }), []).value;
}

/** The launch command for one brain kind; `stub` never spawns anything. */
export function commandForKind(kind: BrainKind, commands?: Partial<CliCommandsView> | null): string | null {
  if (kind === 'stub') return null;
  const configured = commands?.[kind as CliName];
  return (typeof configured === 'string' && configured.trim() ? configured.trim() : null) ?? defaultCliCommand(kind as CliName);
}

const STUB_RESOLVED: CliResolvedView = { via: 'direct', ok: true, detail: '内置桩,不启动任何进程' };

/**
 * The selectable brains for the UI. `available` = the CONFIGURED launch command resolves: a direct
 * command must be on PATH, a shell one (alias / env prefix) must be a word the login shell knows.
 * Cached per command set (a shell probe starts a real interactive shell); `refresh` re-probes.
 */

export function brainCatalog(refresh = false, commands?: Partial<CliCommandsView> | null): BrainOption[] {
  const cmd = (k: BrainKind): string | null => commandForKind(k, commands);
  const resolved = (k: BrainKind): CliResolvedView => {
    const c = cmd(k);
    return c === null ? STUB_RESOLVED : cliLaunchStatusView(c, { refresh });
  };
  const piCmd = cmd('pi')!;
  const piResolved = resolved('pi');
  const piModels = piResolved.ok ? piModelIds(4000, piCmd) : [];
  const claudeResolved = resolved('claude');
  const codexResolved = resolved('codex');
  const options: BrainOption[] = [
    { kind: 'pi', label: 'pi(多家 API,默认智谱 GLM)', available: piResolved.ok, models: piModels.length ? piModels : ['zai/glm-5.3', 'zai/glm-5-turbo', 'deepseek/deepseek-v4-flash'], default_model: DEFAULT_MODELS.pi, note: '按 token 计费(GLM-5.3 ≈ ¥0.006/次判断);模型写成 provider/model', command: piCmd, resolved: piResolved },
    { kind: 'claude', label: 'Claude Code CLI(订阅)', available: claudeResolved.ok, models: ['sonnet', 'opus', 'haiku'], default_model: DEFAULT_MODELS.claude, note: '走 Claude Code 订阅额度;别名 sonnet/opus/haiku 或完整模型 id', command: cmd('claude')!, resolved: claudeResolved },
    { kind: 'codex', label: 'Codex CLI(ChatGPT 登录)', available: codexResolved.ok, models: ['gpt-5.4', 'gpt-5.4-mini'], default_model: DEFAULT_MODELS.codex, note: '走 ChatGPT 订阅;留空用 Codex 自己的默认模型', command: cmd('codex')!, resolved: codexResolved },
    { kind: 'stub', label: '桩(离线,固定 NO_TRADE)', available: true, models: [], default_model: null, note: '测试用,不调任何模型', command: null, resolved: STUB_RESOLVED },
  ];
  return options;
}

/** One short round-trip to prove a (kind, model) pair actually answers. */
export async function testBrain(kind: BrainKind, model: string | null, timeoutMs = 90_000, commands?: Partial<CliCommandsView> | null): Promise<BrainTestResult> {
  const brain = makeBrain(kind, model, { command: commandForKind(kind, commands) });
  const started = Date.now();
  try {
    const r = await brain.complete('你是连通性测试。只回复一个词:ok', 'ping', { timeoutMs });
    return { ok: r.text.trim().length > 0, kind, model, name: brain.name, latency_ms: Date.now() - started, text: r.text.slice(0, 200), error: null };
  } catch (e) {
    return { ok: false, kind, model, name: brain.name, latency_ms: Date.now() - started, text: null, error: (e as Error).message.slice(0, 400) };
  }
}
