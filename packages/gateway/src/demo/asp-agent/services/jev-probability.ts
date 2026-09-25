/**
 * 服务「Jev 概率判断(按次)」:买方给标的 + 设定(周期、可选方向/入场/止损/目标、想问的模板),
 * 用 research/judge 的同一条路径(buildJudgeState → judgeCandidate,钉住的决策连接)问 Jev,返回每个问题的概率分布。
 *
 * 费用:每个 job 一个 AtomicCallBudget scope(`asp:jev_probability:<job_id>`),最多 JEV_MAX_CALLS_PER_JOB 次调用,
 * 单次上限不得高于 JUDGE_MAX_CALL_USD;同一 job 同一 K 线重试命中决策落库去重,不重复计费。
 * Jev 不可用 → validate 阶段(注入 judgeAvailable)就拒单;handle 阶段仍不可用/调用失败 → 抛错,不交付空结果。
 *
 * 本文件同时导出 plan_gate 复用的共享件:K 线整理、ATR(14)、加权盈亏比、候选快照、jevJudge(ServiceDeps.judge 工厂)。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ResearchBar } from '@trading-swarm/contracts';
import { hash } from '../../research/primitives.js';
import { judgeDecimal } from '../../research/judge/candidate.js';
import {
  AtomicCallBudget, JudgeDecisionStore, buildJudgeState, judgeCandidate, usdString, usdUnits,
  type BudgetView, type DecisionProvider, type FrozenModelProfile, type JudgeCandidateSnapshot, type JudgeResult, type JudgeStateV1,
} from '../../research/judge/index.js';
import { JUDGE_TEMPLATE_KEYS, JUDGE_TEMPLATES, templateJudge, type JudgeTemplateKey } from '../../research/judge/templates.js';
import { JUDGE_MAX_CALL_USD } from '../../model-connections.js';
import { freeText, jsonParams, marketIn, numberAfter, positive, sideIn, symbolList, symbolsIn, targetsIn, timeframeIn } from './params.js';
import { deliverable, num, pct } from './render.js';
import { ServiceInputError, type PerCallJob, type PerCallService, type ServiceDeps, type ServiceKey } from './types.js';

// ---------------------------------------------------------------- 共享件(plan_gate 也用)

export const JEV_TIMEFRAMES = ['15m', '1h', '4h', '1d'] as const;
export const TF_MS: Record<string, number> = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
/** 每个 job 的调用上限:一次正常调用 + 一次(K 线已前进后的)重试;之后预算闸拒绝 */
export const JEV_MAX_CALLS_PER_JOB = 2;
export const BARS_LIMIT = 150;

/** 钉住的 Jev 连接。runtime:`frozenDecision()` 的 profile + `fromDecisionClient(client, profile)` + `store.marketDb` */
export interface JevBinding { profile: FrozenModelProfile; provider: DecisionProvider; db: DatabaseSync }
export interface JevDeps extends ServiceDeps {
  /** 没绑定 / 不可用返回 null(handle 抛 jev_unavailable,不交付空结果) */
  jev?(): JevBinding | null;
}
export interface JevOptions { max_calls_per_job?: number; now?: () => number }

/** 只留已收盘(close_time < now)的 K 线,升序去重;as_of = 最后一根的 open_time + 周期 */
export function closedBars(bars: readonly ResearchBar[], timeframe_ms: number, now: number): { bars: ResearchBar[]; as_of: number } {
  const seen = new Map<number, ResearchBar>();
  for (const b of bars) if (b.close_time < now && b.open_time + timeframe_ms <= now) seen.set(b.open_time, b);
  const out = [...seen.values()].sort((a, b) => a.open_time - b.open_time);
  if (out.length < 50) throw new Error('bars_insufficient');
  const as_of = out.at(-1)!.open_time + timeframe_ms;
  if (now - as_of > 2 * timeframe_ms) throw new Error('bars_stale');
  return { bars: out, as_of };
}

/** 与 buildJudgeState 同口径:最近 14 根的真实波幅简单平均 */
export function atr14(bars: readonly ResearchBar[]): number {
  if (bars.length < 15) return NaN;
  const tail = bars.slice(-15);
  let s = 0;
  for (let i = 1; i < tail.length; i++) {
    const h = Number(tail[i]!.high), l = Number(tail[i]!.low), pc = Number(tail[i - 1]!.close);
    s += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return s / 14;
}

/** 与 candidate.ts intentSnapshot 同算法:只取方向正确的目标,按权重(缺省等权)加权的回报距离 ÷ 风险距离 */
export function weightedRR(side: 'long' | 'short', entry: number, stop: number, targets: readonly number[], weights?: readonly number[]): { rr: number | null; valid: number[] } {
  const dir = side === 'long' ? 1 : -1;
  const rows = targets.map((price, i) => ({ price, w: Math.max(0, weights?.[i] ?? 0) })).filter((t) => Number.isFinite(t.price) && (t.price - entry) * dir > 0).sort((a, b) => (a.price - b.price) * dir);
  const total = rows.reduce((s, t) => s + t.w, 0);
  const rr = rows.length && entry !== stop ? rows.reduce((s, t) => s + Math.abs(t.price - entry) * (total > 0 ? t.w / total : 1 / rows.length), 0) / Math.abs(entry - stop) : null;
  return { rr, valid: rows.map((t) => t.price) };
}

/** 服务侧候选快照(无 IR):身份 = 几何 + 时刻的哈希,同一 job 同一 K 线得到同一 id → 决策去重 */
export function serviceCandidate(x: { symbol: string; as_of: number; timeframe_ms: number; direction: 'long' | 'short'; entry: number; stop: number; target: number | null; reward_risk: number | null }): JudgeCandidateSnapshot {
  const body = { symbol: x.symbol, as_of: x.as_of, timeframe_ms: x.timeframe_ms, direction: x.direction, entry: judgeDecimal(x.entry), stop: judgeDecimal(x.stop), target: x.target === null ? null : judgeDecimal(x.target), reward_risk: x.reward_risk };
  return { id: hash({ source: 'asp_service', ...body }), ...body };
}

export interface JevRun { result: JudgeResult; state: JudgeStateV1; templates: JudgeTemplateKey[]; dropped: { template: JudgeTemplateKey; reason: string }[]; budget: BudgetView; profile: FrozenModelProfile }

/**
 * 一次 Jev 判断:模板问题 → state(缺摆动支撑/阻力的价位模板剔除并记下)→ 每 scope 一个原子预算 → judgeCandidate。
 * 预算闸失败、provider 失败都体现在 result.status==='error' + reason_codes,由调用方决定是否交付。
 */
export async function runJev(binding: JevBinding, candidate: JudgeCandidateSnapshot, bars: readonly ResearchBar[], templates: readonly JudgeTemplateKey[], scope: string, opts: JevOptions = {}): Promise<JevRun> {
  const { profile, provider, db } = binding;
  if (usdUnits(profile.max_call_usd) > usdUnits(JUDGE_MAX_CALL_USD)) throw new Error('jev_price_cap_exceeded');
  let keys = [...templates];
  const dropped: JevRun['dropped'] = [];
  let spec = templateJudge(profile.ref, { templates: keys }), state: JudgeStateV1;
  for (;;) {
    try { state = buildJudgeState(candidate, bars, spec); break; }
    catch (e) {
      const m = /^judge_field_unavailable:(.+)$/.exec((e as Error).message);
      if (!m) throw e;
      const field = m[1]!, out = keys.filter((k) => (JUDGE_TEMPLATES[k].state_fields as string[]).includes(field));
      if (!out.length || out.length === keys.length) throw new Error(`jev_state_unavailable:${field}`);
      for (const k of out) dropped.push({ template: k, reason: `state_field_unavailable:${field}` });
      keys = keys.filter((k) => !out.includes(k));
      spec = templateJudge(profile.ref, { templates: keys });
    }
  }
  const max_calls = opts.max_calls_per_job ?? JEV_MAX_CALLS_PER_JOB;
  const budget = AtomicCallBudget.create(db, scope, max_calls, usdString(usdUnits(profile.max_call_usd) * BigInt(max_calls)));
  const store = new JudgeDecisionStore(db, opts.now);
  const result = await judgeCandidate({
    candidate, state, spec, model_profile: profile, decision_key: `${scope}:${candidate.id}`,
    execution_spec_hash: hash({ service: 'asp_per_call', templates: keys, version: 1 }),
  }, { mode: 'request_once', provider, store, budget, ...(opts.now ? { now: opts.now } : {}) });
  return { result, state, templates: keys, dropped, budget: budget.view(), profile };
}

/** ServiceDeps.judge 的实现工厂(plan_gate 用):没绑定 → null;其余交给 runJev */
export function jevJudge(binding: () => JevBinding | null, templates: readonly JudgeTemplateKey[] = ['take', 'regime_fit'], opts: JevOptions = {}): NonNullable<ServiceDeps['judge']> {
  return async (candidate, bars, scope) => {
    const b = binding();
    return b ? (await runJev(b, candidate, bars, templates, scope, opts)).result : null;
  };
}

// ---------------------------------------------------------------- 输入解析(两个服务共用)

export interface PlanInput { symbol: string | null; side: 'long' | 'short' | null; entry: number | null; stop: number | null; targets: number[]; timeframe: string; market: 'spot' | 'perp' }

function priceField(p: Record<string, unknown>, key: string): number | null | undefined {
  const v = p[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = positive(v);
  if (n === null) throw new ServiceInputError(`${key}_invalid`, `${key} 必须是正数 / ${key} must be a positive number`);
  return n;
}
function targetsField(p: Record<string, unknown>): number[] | undefined {
  const v = p['targets'] ?? p['target'] ?? p['take_profits'];
  if (v === undefined || v === null || v === '') return undefined;
  const xs = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，/\s]+/).filter(Boolean) : [v];
  const out = xs.map((x) => positive(x));
  if (out.some((x) => x === null)) throw new ServiceInputError('targets_invalid', 'targets 必须是正数列表 / targets must be positive numbers');
  if (out.length > 5) throw new ServiceInputError('targets_too_many', 'targets 最多 5 个 / at most 5 targets');
  return [...new Set(out as number[])];
}

export function parsePlan(job: PerCallJob, opts: { inferSide?: boolean } = {}): PlanInput {
  const p = jsonParams(job) ?? {}, text = freeText(job);
  let symbol: string | null = null;
  if (p['symbol'] !== undefined && p['symbol'] !== null && p['symbol'] !== '') {
    const xs = symbolList(p['symbol'], 1);
    symbol = xs?.[0] ?? null;
  } else {
    const xs = symbolsIn(text, 3);
    if (xs.length > 1) throw new ServiceInputError('symbol_ambiguous', `只能判断一个标的,文本里出现了 ${xs.join('、')} / exactly one symbol per job`);
    symbol = xs[0] ?? null;
  }
  const entry = priceField(p, 'entry') ?? numberAfter(text, '入场|进场|开仓|\\bentry\\b');
  const stop = priceField(p, 'stop') ?? priceField(p, 'stop_loss') ?? numberAfter(text, '止损|\\bstop(?:[\\s-]*loss)?\\b|\\bsl\\b');
  const targets = targetsField(p) ?? targetsIn(text);
  const market = marketIn(p['market'], text);
  let side = sideIn(p['side'], text);
  if (!side && opts.inferSide !== false && entry !== null && stop !== null && entry !== stop) side = stop < entry ? 'long' : 'short';
  if (side === 'short' && market === 'spot') throw new ServiceInputError('side_invalid', '现货不能做空 / spot cannot short');
  if (entry !== null && stop !== null && entry === stop) throw new ServiceInputError('stop_invalid', '止损不能等于入场 / stop must differ from entry');
  return { symbol, side, entry, stop, targets, timeframe: timeframeIn(p['timeframe'], text, JEV_TIMEFRAMES, '1h'), market };
}

// ---------------------------------------------------------------- 服务本体

export const JEV_DEFAULT_TEMPLATES: JudgeTemplateKey[] = ['take', 'support_holds', 'resistance_breaks', 'retreat_risk'];
export const TEMPLATE_TEXT: Record<JudgeTemplateKey, string> = {
  take: '按给定入场/止损/目标此刻开仓是否合理',
  quality: '候选整体质量',
  support_holds: '未来15分钟最低价不低于最近支撑',
  resistance_breaks: '未来15分钟期末价高于最近阻力',
  retreat_risk: '未来15分钟内触及止损',
  regime_fit: '当前趋势/波动/量能与方向和风险几何相容',
};

export interface JevProbabilityParams {
  symbol: string; timeframe: string; market: 'spot' | 'perp';
  side: 'long' | 'short'; entry: number | null; stop: number | null; targets: number[];
  templates: JudgeTemplateKey[];
}

function templatesIn(v: unknown, text: string): JudgeTemplateKey[] {
  if (v !== undefined && v !== null && v !== '') {
    const xs = (Array.isArray(v) ? v : String(v).split(/[,，\s]+/)).map((x) => String(x).trim()).filter(Boolean);
    if (!xs.length || xs.length > JUDGE_TEMPLATE_KEYS.length || xs.some((x) => !(JUDGE_TEMPLATE_KEYS as readonly string[]).includes(x))) {
      throw new ServiceInputError('templates_invalid', `templates 只能是 ${JUDGE_TEMPLATE_KEYS.join(' / ')}`);
    }
    return [...new Set(xs)] as JudgeTemplateKey[];
  }
  const out: JudgeTemplateKey[] = [];
  if (/开仓合理|能不能开|值不值得|\btake\b/i.test(text)) out.push('take');
  if (/质量|\bquality\b/i.test(text)) out.push('quality');
  if (/支撑|\bsupport/i.test(text)) out.push('support_holds');
  if (/阻力|压力位|\bresistance|\bbreakout/i.test(text)) out.push('resistance_breaks');
  if (/回撤风险|打止损|触及止损|扫损|\bretreat/i.test(text)) out.push('retreat_risk');
  if (/顺势|状态匹配|\bregime/i.test(text)) out.push('regime_fit');
  return out.length ? out : [...JEV_DEFAULT_TEMPLATES];
}

export function createJevProbabilityService(opts: JevOptions & {
  /** 接单前的本地可用性检查(连接已绑定、钥匙在库、钉住版本一致);返回原因字符串 = 不可用。不得发网络请求 */
  judgeAvailable?: () => string | null;
} = {}): PerCallService<JevProbabilityParams> {
  return {
    key: 'jev_probability',
    validate(job) {
      const plan = parsePlan(job), p = jsonParams(job) ?? {};
      if (!plan.symbol) throw new ServiceInputError('symbol_missing', '缺少标的 / symbol is required');
      const side = plan.side ?? 'long';
      if (side === 'short' && plan.market === 'spot') throw new ServiceInputError('side_invalid', '现货不能做空 / spot cannot short');
      const dir = side === 'long' ? 1 : -1;
      if (plan.entry !== null && plan.stop !== null && (plan.entry - plan.stop) * dir <= 0) throw new ServiceInputError('stop_side', '止损在入场的错误一侧 / stop is on the wrong side of entry');
      if (plan.entry !== null && plan.targets.length && plan.targets.every((t) => (t - plan.entry!) * dir <= 0)) throw new ServiceInputError('targets_side', '目标都在入场的错误一侧 / all targets are on the wrong side');
      const templates = templatesIn(p['templates'] ?? p['questions'], freeText(job));
      const why = opts.judgeAvailable?.();
      if (why) throw new ServiceInputError('jev_unavailable', `Jev 暂不可用,不接单 / Jev unavailable: ${why}`);
      return { symbol: plan.symbol, timeframe: plan.timeframe, market: plan.market, side, entry: plan.entry, stop: plan.stop, targets: plan.targets, templates };
    },
    async handle(job, params, deps: JevDeps) {
      const binding = deps.jev?.() ?? null;
      if (!binding) throw new Error('jev_unavailable');
      const tf_ms = TF_MS[params.timeframe]!;
      const { bars, as_of } = closedBars(await deps.bars(params.symbol, params.timeframe, BARS_LIMIT, params.market), tf_ms, deps.now());
      const last = Number(bars.at(-1)!.close), atr = atr14(bars), dir = params.side === 'long' ? 1 : -1;
      if (!(atr > 0)) throw new Error('atr_unavailable');
      const entry = params.entry ?? last;
      const stop = params.stop ?? entry - dir * 1.5 * atr;
      if ((entry - stop) * dir <= 0 || stop <= 0) throw new Error('stop_wrong_side_vs_market');
      const targets = params.targets.length ? params.targets : [entry + dir * 2 * Math.abs(entry - stop)];
      const { rr, valid } = weightedRR(params.side, entry, stop, targets);
      if (!valid.length) throw new Error('targets_wrong_side_vs_market');
      const candidate = serviceCandidate({ symbol: params.symbol, as_of, timeframe_ms: tf_ms, direction: params.side, entry, stop, target: valid[0]!, reward_risk: rr });
      const run = await runJev(binding, candidate, bars, params.templates, `asp:jev_probability:${job.job_id}`, { ...opts, now: opts.now ?? deps.now });
      const r = run.result;
      if (r.status === 'error' || !r.answers.length) throw new Error(`jev_failed:${r.reason_codes.join(',') || 'no_answers'}`);

      const geometry = { entry: params.entry === null ? 'last_close' : 'buyer', stop: params.stop === null ? 'atr_1.5' : 'buyer', targets: params.targets.length ? 'buyer' : 'rr_2' };
      const head = (k: string) => { const a = r.answers.find((x) => x.question_key === k)!; const [l, p] = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0]!; return `${k} ${l} ${pct(p, 0)}`; };
      const summary = `${params.symbol} ${params.timeframe} 模型概率 / model probabilities: ${run.templates.map(head).join(' · ')}`;
      const lines = [
        `设定 / setup: ${params.side} 入场 ${num(entry, 6)}(${geometry.entry}) 止损 ${num(stop, 6)}(${geometry.stop}) 目标 ${valid.map((t) => num(t, 6)).join('/')}(${geometry.targets}) 盈亏比 RR ${num(rr)}`,
        ...r.answers.map((a) => `· ${a.question_key}(${TEMPLATE_TEXT[a.question_key as JudgeTemplateKey] ?? a.question_key}): ${Object.entries(a.probabilities).map(([l, p]) => `${l} ${pct(p)}`).join(' / ')}`),
        ...(run.dropped.length ? [`未问 / skipped: ${run.dropped.map((d) => `${d.template}(${d.reason})`).join('、')}`] : []),
        `特征 / features: ${Object.entries({ ...run.state.candidate, ...run.state.features }).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' ')}`,
        `模型 / model: ${r.model_revision ?? run.profile.model} · 状态 ${r.status} · 成本 cost ${r.cost_usd === null ? '未知 unknown' : `$${r.cost_usd}`}(${r.cost_status})`,
        '注:以上概率由 AI 模型生成,是对事前条件的判断,不是盈利概率;价位类问题固定看 as_of 起未来 15 分钟,与所选周期无关 / AI-model-generated judgements, not profit odds; level questions look 15 minutes ahead.',
      ];
      return deliverable(job, 'jev_probability', '【AI 概率判断 / AI Probability】 Trading Swarm', summary, lines, {
        symbol: params.symbol, timeframe: params.timeframe, market: params.market, as_of,
        setup: { side: params.side, entry, stop, targets: valid, reward_risk: rr, geometry, atr14: atr, last_close: last },
        templates: run.templates, dropped_templates: run.dropped,
        answers: r.answers.map((a) => ({ ...a, question: TEMPLATE_TEXT[a.question_key as JudgeTemplateKey] ?? null, instructions: JUDGE_TEMPLATES[a.question_key as JudgeTemplateKey]?.instructions ?? null })),
        reference_rule: { note: '服务默认阈值对照,仅供参考 / default thresholds, reference only', action: r.action, status: r.status, predicates: r.predicates },
        model: { model: run.profile.model, model_revision: r.model_revision, routing: run.profile.routing, parser_version: run.profile.parser_version },
        state: run.state,
        cost: { cost_usd: r.cost_usd, cost_status: r.cost_status, max_call_usd: run.profile.max_call_usd, budget: { max_calls: run.budget.max_calls, calls: run.budget.calls, max_usd: run.budget.max_usd, spent_usd: run.budget.spent_usd } },
        decision_id: r.decision_id, request_hash: r.request_hash, reason_codes: r.reason_codes,
        method: 'research/judge 同一路径:buildJudgeState(最近 100 根已收盘 K 线)→ judgeCandidate(钉住模型版本、不重试、原子预算)',
      });
    },
  };
}

export const jevProbabilityService = createJevProbabilityService();
