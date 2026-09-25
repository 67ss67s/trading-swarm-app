// §9.52 DecisionClient:结构化决策(OpenRouter Decisions API,Jev 等),给 §9.53 判断要素用。
// 只回概率/档位,没有文本、没有推理;便宜到可以在回测里对每个候选都问一遍(设计 §1:一次三问 ≈ $0.00003)。
// 闸门三道:并发闸(缺省 8)、429 退避、日花费闸 workflow.decision_daily_usd_cap(超了抛 decision_budget_exhausted)。
// 密钥只进请求头,错误文本一律 redactKeyText。

import { configureOkxProxy } from './okx-proxy.js';
import { isRedirectResponse, redactKeyText } from './brain-http.js';

export type DecisionQuestion =
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export type DecisionAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number> };

export interface DecisionResult {
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: { input_tokens: number; cost_usd: number | null };
  latency_ms: number;
}

export interface DecisionRequest {
  state: Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
}

export interface DecisionClient {
  /** 'openrouter:~typesafe/jev-latest' */
  name: string;
  decide(req: DecisionRequest, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<DecisionResult>;
}

export const DEFAULT_DECISION_MODEL = '~typesafe/jev-latest';
export const DEFAULT_DECISION_BASE = 'https://openrouter.ai/api';
export const DEFAULT_DECISION_DAILY_USD_CAP = 2;

/** 当日花费账本(UTC 日);runtime 接 demo_kv,测试用内存版。 */
export interface DecisionSpendLedger {
  spent(day: string): number;
  add(day: string, usd: number): void;
}

export function memorySpendLedger(): DecisionSpendLedger {
  const m = new Map<string, number>();
  return { spent: (d) => m.get(d) ?? 0, add: (d, usd) => void m.set(d, (m.get(d) ?? 0) + usd) };
}

export class DecisionError extends Error {
  constructor(message: string, readonly code: 'decision_budget_exhausted' | 'auth' | 'network' | 'timeout' | 'http' | 'bad_response' | 'bad_request', readonly status: number | null = null) {
    super(message);
    this.name = 'DecisionError';
  }
}

export interface JevClientOptions {
  api_key: string;
  model?: string;
  /** 缺省 https://openrouter.ai/api(请求打到 {base}/alpha/decisions)。 */
  base_url?: string;
  concurrency?: number;
  /** 每次调用前读,改 workflow 立即生效。 */
  dailyCapUsd?: () => number;
  ledger?: DecisionSpendLedger;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 429/5xx 的最多重试次数(缺省 3)。 */
  maxRetries?: number;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** 请求前的形状检查:问题 key 与类型不对就别花钱。 */
export function validateDecisionRequest(req: DecisionRequest): string | null {
  if (!req || typeof req.state !== 'object' || req.state === null || Array.isArray(req.state)) return 'state 必须是对象';
  const entries = Object.entries(req.questions ?? {});
  if (!entries.length) return 'questions 不能为空';
  for (const [k, q] of entries) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(k)) return `问题 key 只能是字母数字下划线:${k}`;
    if (!q || typeof q.instructions !== 'string' || !q.instructions.trim()) return `${k}.instructions 必填`;
    if (q.type === 'noul') {
      if (typeof q.criteria?.true !== 'string' || typeof q.criteria?.false !== 'string') return `${k}.criteria 需要 {true,false}`;
    } else if (q.type === 'choice') {
      if (!q.criteria || typeof q.criteria !== 'object' || Array.isArray(q.criteria) || Object.keys(q.criteria).length < 2) return `${k}.criteria 至少两个选项`;
    } else if (q.type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2) return `${k}.criteria 至少两档`;
    } else return `${k}.type 只能是 noul/choice/score`;
  }
  return null;
}

/** 响应里的一个答案 → DecisionAnswer;缺字段的直接判坏响应(宁可报错,不猜)。 */
function normalizeAnswer(key: string, q: DecisionQuestion | undefined, raw: unknown): DecisionAnswer {
  const a = (raw ?? {}) as Record<string, unknown>;
  const type = (a['type'] as string | undefined) ?? q?.type;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const probs = (v: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (v && typeof v === 'object') for (const [k, p] of Object.entries(v as Record<string, unknown>)) if (num(p) !== null) out[k] = p as number;
    return out;
  };
  if (type === 'noul') {
    const n = num(a['noul']);
    if (n === null) throw new DecisionError(`答案 ${key} 缺 noul`, 'bad_response');
    return { type: 'noul', noul: n };
  }
  if (type === 'choice') {
    if (typeof a['choice'] !== 'string') throw new DecisionError(`答案 ${key} 缺 choice`, 'bad_response');
    return { type: 'choice', choice: a['choice'], confidence: num(a['confidence']) ?? 0, probabilities: probs(a['probabilities']) };
  }
  if (type === 'score') {
    const s = num(a['score']);
    if (s === null) throw new DecisionError(`答案 ${key} 缺 score`, 'bad_response');
    return { type: 'score', score: s, confidence: num(a['confidence']) ?? 0, probabilities: probs(a['probabilities']) };
  }
  throw new DecisionError(`答案 ${key} 类型不认识`, 'bad_response');
}

export class JevDecisionClient implements DecisionClient {
  readonly name: string;
  private readonly model: string;
  private readonly url: string;
  private readonly key: string;
  private readonly concurrency: number;
  private readonly ledger: DecisionSpendLedger;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly opts: JevClientOptions) {
    this.model = opts.model?.trim() || DEFAULT_DECISION_MODEL;
    this.name = `openrouter:${this.model}`;
    this.url = `${(opts.base_url ?? DEFAULT_DECISION_BASE).replace(/\/+$/, '').replace(/\/v1$/, '')}/alpha/decisions`;
    this.key = opts.api_key.trim();
    this.concurrency = Math.max(1, opts.concurrency ?? 8);
    this.ledger = opts.ledger ?? memorySpendLedger();
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /** 今天已花(美元)。 */
  spentToday(): number {
    return this.ledger.spent(utcDay(this.now()));
  }

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
  }
  private release(): void {
    this.active--;
    this.waiters.shift()?.();
  }

  async decide(req: DecisionRequest, o?: { timeoutMs?: number; signal?: AbortSignal }): Promise<DecisionResult> {
    const bad = validateDecisionRequest(req);
    if (bad) throw new DecisionError(bad, 'bad_request');
    const cap = this.opts.dailyCapUsd?.() ?? DEFAULT_DECISION_DAILY_USD_CAP;
    const day = utcDay(this.now());
    if (this.ledger.spent(day) >= cap) throw new DecisionError(`decision_budget_exhausted:今日判断要素花费已达 $${cap}`, 'decision_budget_exhausted');
    await this.acquire();
    try {
      return await this.send(req, o, day);
    } finally {
      this.release();
    }
  }

  private async send(req: DecisionRequest, o: { timeoutMs?: number; signal?: AbortSignal } | undefined, day: string): Promise<DecisionResult> {
    const started = this.now();
    const budget = o?.timeoutMs ?? 30_000;
    const maxRetries = this.opts.maxRetries ?? 3;
    const fetchFn = this.opts.fetchFn ?? (configureOkxProxy(), globalThis.fetch.bind(globalThis));
    const redact = (t: string): string => redactKeyText(t, [this.key]);
    const body = JSON.stringify({ model: this.model, state: req.state, questions: req.questions });
    let last: DecisionError | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const left = budget - (this.now() - started);
      if (left <= 0) break;
      const signal = o?.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(left)]) : AbortSignal.timeout(left);
      let res: Response | null = null;
      try {
        // 不跟随重定向:跟随会把 Authorization 带到新地址。
        res = await fetchFn(this.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` }, body, signal, redirect: 'manual' });
      } catch (e) {
        const err = e as Error & { cause?: { message?: string } };
        if (o?.signal?.aborted) throw new DecisionError('已取消', 'timeout');
        if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new DecisionError(`请求超时(${budget}ms)`, 'timeout');
        last = new DecisionError(redact(`连不上 openrouter.ai:${err.cause?.message ?? err.message}`), 'network');
      }
      let wait = 500 * 2 ** attempt;
      if (res && isRedirectResponse(res)) {
        await res.body?.cancel().catch(() => undefined);
        throw new DecisionError(`${res.status} 服务端要求重定向,已拒绝跟随(不把凭证发往新地址)`, 'http', res.status);
      }
      if (res) {
        const text = await res.text().catch(() => '');
        if (res.ok) return this.parse(text, req, started, day);
        let detail = text.slice(0, 300);
        try {
          const j = JSON.parse(text) as { error?: { message?: string } | string };
          detail = (typeof j.error === 'string' ? j.error : j.error?.message) ?? detail;
        } catch {
          /* 原文 */
        }
        detail = redact(`${res.status} ${detail}`.trim());
        if (res.status === 401 || res.status === 403) throw new DecisionError(detail, 'auth', res.status);
        last = new DecisionError(detail, 'http', res.status);
        if (res.status !== 429 && res.status < 500) throw last;
        const ra = Number(res.headers.get('retry-after'));
        if (Number.isFinite(ra) && ra > 0) wait = Math.min(10_000, ra * 1000);
      }
      if (attempt >= maxRetries || this.now() - started + wait >= budget) break;
      await this.sleep(wait);
    }
    throw last ?? new DecisionError(`请求超时(${budget}ms)`, 'timeout');
  }

  private parse(text: string, req: DecisionRequest, started: number, day: string): DecisionResult {
    let j: { model?: string; answers?: Record<string, unknown>; usage?: { input_tokens?: number; output_tokens?: number; cost?: number } };
    try {
      j = JSON.parse(text) as typeof j;
    } catch {
      throw new DecisionError('响应不是 JSON', 'bad_response');
    }
    if (!j.answers || typeof j.answers !== 'object') throw new DecisionError('响应缺 answers', 'bad_response');
    const cost = typeof j.usage?.cost === 'number' && Number.isFinite(j.usage.cost) ? j.usage.cost : null;
    // 先记账再校验答案:服务端已经收了钱,坏答案也照样算花费。
    if (cost !== null && cost > 0) this.ledger.add(day, cost);
    const answers: Record<string, DecisionAnswer> = {};
    for (const key of Object.keys(req.questions)) {
      if (!(key in j.answers)) throw new DecisionError(`响应缺答案 ${key}`, 'bad_response');
      answers[key] = normalizeAnswer(key, req.questions[key], j.answers[key]);
    }
    return { model: j.model ?? this.model, answers, usage: { input_tokens: Number(j.usage?.input_tokens ?? 0), cost_usd: cost }, latency_ms: this.now() - started };
  }
}
