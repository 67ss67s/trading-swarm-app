/**
 * 模型只决定入场(follow / skip),每个事件最多一次模型调用。
 *
 * 两种提示词:
 *  - prod(默认,生产 harness):system/user 就是 context.ts buildContext 的原文(scan 模式、无策略、workflow 默认 playbook);
 *    解析 = schema.ts validateJudgment + findMemoryNumberLeaks + 允许动作集,与 backtest.ts judgeOnce 同一套;
 *    follow = PROPOSE 且方向与事件一致且 gates.ts evaluateGates 全过。模型自己给的止损/止盈只记录、不使用。
 *    与生产的唯一差别:生产在契约错误时会追加一轮修复调用,这里为「每事件最多一次调用」不修复,
 *    契约错误直接记 model_error(按生产 fail-closed 语义当作不做)。
 *  - research(研究侧提示词,非生产 harness):user 用同一份生产证据登记,但任务换成「代码给出的事件做不做」,
 *    输出 {"decision":"follow|skip","reason":"…"}。产物里 prompt_mode=research 会被标成「research prompt,非生产 harness」。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { estimateCny, piBrain, priceFor, type Brain, type BrainResult } from '../../brain.js';
import { cliSpawnArgs, defaultCliCommand, stripShellNoise } from '../../cli-launch.js';
import { evaluateGates } from '../../gates.js';
import { extractJson, findMemoryNumberLeaks, validateJudgment } from '../../schema.js';
import type { Evidence, GateResult, Judgment, MarketView } from '../../types.js';
import { paperAccount } from './events.js';
import { RESEARCH_PROMPT_VERSION, type Dir, type Venue } from './types.js';

export type PromptMode = 'prod' | 'research';

export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** 冻结进库的每事件上下文:模型看到的全部文本 + 解析/闸门需要的登记信息。不含任何 as_of 之后的数据。 */
export interface FrozenPrompt {
  mode: PromptMode;
  system: string;
  user: string;
  allowed_actions: string[];
  strategy_ids: string[];
  evidence: Evidence[];
  market: MarketView;
}

/** 模型/桩能额外拿到的事件公开字段(都在 as_of 时刻已知)。真模型不用它,桩用它拼输出。 */
export interface PublicEvent {
  id: string;
  venue: Venue;
  symbol: string;
  as_of: number;
  direction: Dir;
  ref_close: number;
  stop: number;
  stop_atr: number;
}

export const RESEARCH_SYSTEM = [
  `你是交易判断模块(研究侧提示词 ${RESEARCH_PROMPT_VERSION},非生产 harness)。`,
  '代码在一根 1h K 线收盘时检测到一个带方向的候选事件(来源:生产触发器)。入场价 = 下一根开盘价;止损已由代码放在结构位;',
  '持仓与离场全部由代码管理(吊灯追踪止损 ATR22×3,最长 7 天),你不需要也不能给价位。',
  '你只决定这一笔做不做:只依据下面登记的证据判断,不要编造证据里没有的数字。没有把握就 skip,这是正常结果。',
  '只输出一个 JSON 对象:{"decision":"follow|skip","reason":"≤40 字一句话,引用证据编号如 [E3]"}',
].join('\n');

export function researchPrompt(prodUser: string, ev: PublicEvent): string {
  const cut = prodUser.indexOf('\n## 任务');
  const base = cut >= 0 ? prodUser.slice(0, cut) : prodUser;
  const dp = ev.ref_close > 100 ? 2 : ev.ref_close > 1 ? 4 : 6;
  return `${base}\n\n## 候选事件(代码给出)\n方向:${ev.direction === 'long' ? '做多' : '做空'};参考收盘 ${ev.ref_close.toFixed(dp)};结构止损 ${ev.stop.toFixed(dp)}(距 ${ev.stop_atr.toFixed(2)} ATR14)。\n\n## 任务\n这一笔做不做?只输出 JSON。`;
}

export interface Decision {
  /** ok = 拿到可解析输出;model_error = 超时 / 进程失败 / 契约错误 */
  status: 'ok' | 'model_error';
  follow: boolean;
  action: string | null;
  direction: Dir | null;
  confidence: number | null;
  /** prod 模式:PROPOSE 时的闸门结果 */
  gates_failed: string[];
  /** 模型自己给的止损(只记录,不使用) */
  model_stop: string | null;
  reason: string;
  errors: string[];
}

const errDecision = (errors: string[]): Decision => ({ status: 'model_error', follow: false, action: null, direction: null, confidence: null, gates_failed: [], model_stop: null, reason: '', errors });

/** prod 模式解析:与 backtest.ts judgeOnce 的单轮解析逐条一致(不做修复轮)。 */
export function decideProd(text: string, p: FrozenPrompt, ev: Pick<PublicEvent, 'direction' | 'as_of'>): Decision {
  const validRefs = new Set(p.evidence.map((e) => e.ref));
  let judgment: Judgment | null = null;
  let errors: string[] = [];
  try {
    const v = validateJudgment(extractJson(text), validRefs, { strategies: p.strategy_ids });
    judgment = v.judgment;
    errors = v.errors;
    if (judgment) {
      const leaks = findMemoryNumberLeaks(judgment, p.evidence);
      if (leaks.length) {
        errors = [...errors, ...leaks];
        judgment = null;
      }
    }
  } catch (e) {
    errors = [(e as Error).message];
  }
  if (judgment && !p.allowed_actions.includes(judgment.action)) {
    errors = [`action ${judgment.action} 不在允许范围 ${p.allowed_actions.join('/')}`];
    judgment = null;
  }
  if (!judgment) return errDecision(errors.slice(0, 5));
  const j: Judgment = judgment;
  let gates: GateResult[] = [];
  if (j.action === 'PROPOSE') {
    const staleRefs = new Set(p.evidence.filter((e) => e.stale).map((e) => e.ref));
    gates = evaluateGates(j, { halted: false, paused: false, account: paperAccount(ev.as_of), market: p.market, opens_today: 0, stale_refs: staleRefs, now: ev.as_of });
  }
  const gates_failed = gates.filter((g) => !g.passed).map((g) => `${g.name}:${g.reason}`);
  const dir = j.action === 'PROPOSE' ? (j.proposal?.direction ?? j.direction) : j.direction;
  const follow = j.action === 'PROPOSE' && dir === ev.direction && gates_failed.length === 0;
  return { status: 'ok', follow, action: j.action, direction: dir ?? null, confidence: j.confidence, gates_failed, model_stop: j.proposal?.stop_price ?? null, reason: j.headline, errors: [] };
}

/** research 模式解析。 */
export function decideResearch(text: string): Decision {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (e) {
    return errDecision([(e as Error).message]);
  }
  const o = raw as { decision?: unknown; reason?: unknown } | null;
  if (!o || (o.decision !== 'follow' && o.decision !== 'skip')) return errDecision(['decision must be follow|skip']);
  return { status: 'ok', follow: o.decision === 'follow', action: o.decision, direction: null, confidence: null, gates_failed: [], model_stop: null, reason: typeof o.reason === 'string' ? o.reason.slice(0, 200) : '', errors: [] };
}

export function decide(mode: PromptMode, text: string, p: FrozenPrompt, ev: Pick<PublicEvent, 'direction' | 'as_of'>): Decision {
  return mode === 'prod' ? decideProd(text, p, ev) : decideResearch(text);
}

// ─────────────────────────────── 模型客户端 ───────────────────────────────

export interface ModelClient {
  /** 价格表的键(brain.ts BRAIN_PRICES_CNY),也是 manifest 里记录的模型标识 */
  name: string;
  /** 只写标记,绝不写 key 本身 */
  key_note: string;
  stub: boolean;
  complete(system: string, user: string, pub: PublicEvent, o: { timeoutMs: number }): Promise<BrainResult>;
}

export function fromBrain(b: Brain, keyNote = 'pi 默认凭证'): ModelClient {
  return { name: b.name, key_note: keyNote, stub: false, complete: (s, u, _p, o) => b.complete(s, u, o) };
}

/** GLM:生产适配器 brain.ts piBrain(pi:zai/glm-5.3,pi 自带凭证)。 */
export function glmClient(): ModelClient {
  return fromBrain(piBrain({ model: 'zai/glm-5.3' }));
}

/** 从 KEY=VALUE 文件读一个变量;读不到返回 null。值不打印、不落盘。 */
export function readEnvFileVar(path: string, key: string): string | null {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && m[1] === key) return m[2]!.replace(/^['"]|['"]$/g, '') || null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * DeepSeek:与 piBrain 同一组参数,另加 `--api-key`(pi 的 auth.json 里另有一把 deepseek key 且优先于环境变量,
 * 只设 DEEPSEEK_API_KEY 不生效,必须显式传参)。key 只在内存里,错误信息里出现就抹掉。
 */
export function deepseekClient(apiKey: string, model = 'deepseek-v4-flash'): ModelClient {
  const name = `pi:deepseek/${model}`;
  const scrub = (s: string): string => s.split(apiKey).join('***');
  return {
    name,
    key_note: 'dedicated key(~/.trading-swarm-okx/secrets/deepseek.env,不入库)',
    stub: false,
    complete(system, user, _pub, o) {
      const started = Date.now();
      const args = ['-p', '--no-tools', '--no-session', '--no-extensions', '--no-skills', '--no-context-files', '--no-prompt-templates', '--thinking', 'off', '--mode', 'text', '--provider', 'deepseek', '--model', model, '--api-key', apiKey, '--system-prompt', system];
      const launch = cliSpawnArgs(defaultCliCommand('pi'), args);
      return new Promise<BrainResult>((resolve, reject) => {
        const child = spawn(launch.file, launch.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...launch.env } });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`pi timed out after ${o.timeoutMs}ms`));
        }, o.timeoutMs);
        child.stdout.on('data', (d) => (stdout += String(d)));
        child.stderr.on('data', (d) => (stderr += String(d)));
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(new Error(scrub(e.message)));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          const out = launch.via === 'shell' ? stripShellNoise(stdout) : stdout;
          if (code !== 0 && !out.trim()) return reject(new Error(scrub(`pi exit ${code}: ${stderr.slice(-400)}`)));
          resolve({ text: out.trim(), latency_ms: Date.now() - started, model: name, input_tokens: Math.ceil((system + user).length / 3), output_tokens: Math.ceil(out.length / 3) });
        });
        child.stdin.end(user);
      });
    },
  };
}

const rand01 = (s: string): number => parseInt(sha(s).slice(0, 8), 16) / 0x1_0000_0000;

function stubJudgmentText(follow: boolean, pub: PublicEvent): string {
  if (!follow) return JSON.stringify({ action: 'NO_TRADE', direction: null, confidence: 0.2, headline: '桩模型:不做', thesis: '桩模型固定输出', reasons: ['桩规则判定不做 [E1]'], evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: ['无'], strategy_id: null, proposal: null });
  const k = pub.direction === 'long' ? 1 : -1;
  const px = (x: number): string => x.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  return JSON.stringify({
    action: 'PROPOSE',
    direction: pub.direction,
    confidence: 0.6,
    headline: '桩模型:跟随',
    thesis: '桩模型固定输出',
    reasons: ['桩规则判定跟随 [E1]'],
    evidence_refs: ['E1'],
    invalidation: '跌破止损',
    invalidation_price: null,
    target_price: null,
    watch_conditions: ['止损'],
    strategy_id: null,
    proposal: { direction: pub.direction, entry: 'market', limit_price: null, entry_zone: null, stop_price: px(pub.ref_close * (1 - k * 0.01)), take_profits: [px(pub.ref_close * (1 + k * 0.02))], rationale: '桩' },
  });
}

/**
 * 桩模型(零成本、不起进程):
 *  - stub-rule:只看 user 文本里「## 触发」那一行 —— 触发器是 breakout / retest 才跟;
 *  - stub-random:user 文本 + 种子的哈希 < p 才跟(p 默认 0.4)。
 * 两者的决定都只是模型可见文本的函数,所以「投毒未来 K 线后决定不变」可以直接断言。
 * `name` 可以改成带价的名字(测试人民币上限用),仍然不起进程。
 */
export function stubClient(kind: 'stub-rule' | 'stub-random', opts: { mode?: PromptMode; seed?: number; p?: number; name?: string; seen?: (user: string, pub: PublicEvent) => void } = {}): ModelClient {
  const mode = opts.mode ?? 'prod';
  return {
    name: opts.name ?? kind,
    key_note: '桩模型,无凭证',
    stub: true,
    async complete(system, user, pub) {
      opts.seen?.(user, pub);
      const trig = /## 触发\n([a-z_]+):/.exec(user)?.[1] ?? '';
      const follow = kind === 'stub-rule' ? trig === 'breakout' || trig === 'retest' : rand01(`${user}|${opts.seed ?? 1}`) < (opts.p ?? 0.4);
      const text = mode === 'prod' ? stubJudgmentText(follow, pub) : JSON.stringify({ decision: follow ? 'follow' : 'skip', reason: `桩:${trig || '?'} [E1]` });
      return { text, latency_ms: 0, model: opts.name ?? kind, input_tokens: Math.ceil((system + user).length / 3), output_tokens: Math.ceil(text.length / 3) };
    },
  };
}

// ─────────────────────────────── 预算 ───────────────────────────────

export class BudgetExhausted extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'BudgetExhausted';
  }
}

/** 调用数与人民币双上限;cny 用 brain.ts 价格表 × 字符数/3 估的 token(与 brain.ts 计量同口径)。 */
export class Budget {
  constructor(
    readonly model: string,
    readonly max_calls: number,
    readonly max_cny: number,
    public calls = 0,
    public cny = 0,
  ) {}

  static costOf(model: string, inTok: number, outTok: number): number {
    return priceFor(model) ? (estimateCny([{ model, input_tokens: inTok, output_tokens: outTok }]) ?? 0) : 0;
  }

  /** 调用前:按这一次的预估(输入字符/3 + 预计输出)判断会不会越线;越线抛 BudgetExhausted,不发调用。 */
  reserve(system: string, user: string, expectedOutTok: number): void {
    if (this.calls + 1 > this.max_calls) throw new BudgetExhausted(`调用数上限 ${this.max_calls} 已到`);
    const est = Budget.costOf(this.model, Math.ceil((system + user).length / 3), expectedOutTok);
    if (this.cny + est > this.max_cny + 1e-12) throw new BudgetExhausted(`人民币上限 ¥${this.max_cny} 将被突破(已用 ¥${this.cny.toFixed(4)},本次预估 ¥${est.toFixed(4)})`);
    this.calls++;
    this.cny += est;
  }

  /** 调用后:把预估换成实测(失败的调用保留预估,按已计费处理)。 */
  settle(system: string, user: string, expectedOutTok: number, actual: { input_tokens: number; output_tokens: number } | null): number {
    const est = Budget.costOf(this.model, Math.ceil((system + user).length / 3), expectedOutTok);
    if (!actual) return est;
    const real = Budget.costOf(this.model, actual.input_tokens, actual.output_tokens);
    this.cny += real - est;
    return real;
  }
}

/** 每次调用预计输出 token(估价与预留用):prod 取 backtest.ts 的估价口径 400,research 取 60。 */
export const EXPECTED_OUT_TOK: Record<PromptMode, number> = { prod: 400, research: 60 };
