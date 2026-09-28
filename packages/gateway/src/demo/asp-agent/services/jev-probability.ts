/**
 * 服务「AI 概率判断(按次)」:买方给标的 + 设定(周期、可选方向/入场/止损/目标、想问的模板),
 * 用 research/judge 的同一条路径(buildJudgeState → judgeCandidate,钉住的决策连接)问 AI 决策模型,返回每个问题的概率分布。
 *
 * 交付口径(对外):
 * - 「是否值得入场」(take)固定必答,买方问到的支撑/阻力/回落问题追加在后面;都没问到就答默认四题。
 * - 价位类问题的时长跟随买方周期:未来 horizon_bars 根 K 线(默认 4 根,1h → 未来 4 小时)。
 *   判断层模板里写的是 15 分钟,这里克隆 spec 后改写问题文本;改写失败(模板变了)就如实写「按 15 分钟」。
 * - 每个价位问题先给历史基准率(最近约 1000 根已收盘 K 线里同距离事件的发生频率,正文写不重叠的独立窗口数),
 *   再给模型概率(标为参考);两者相差 > 25 个百分点时标「分歧大」。K 线一次拉齐(deps.bars 1000 根),
 *   模型输入与特征只用最近 150 根;取不到 1000 根就用实际根数并在正文写明。
 * - take 对外叫「入场设定是否合理」,只写「模型估计 合理 X%」与参考阈值的相对位置,不写「倾向值得」这类建议腔。
 * - 固定算一组特征值(EMA 排列、RSI14、ATR%、距支撑/阻力 ATR 倍数、24h 涨跌、量比)写进正文与 payload。
 * - 对外只称「AI 决策模型」:不写上游模型名/版本、路由、成本、预算、decision_id/request_hash 等内部字段。
 *
 * 费用:每个 job 一个 AtomicCallBudget scope(`asp:jev_probability:<job_id>`),最多 JEV_MAX_CALLS_PER_JOB 次调用,
 * 单次上限不得高于 JUDGE_MAX_CALL_USD;同一 job 同一 K 线重试命中决策落库去重,不重复计费。
 * 模型不可用 → validate 阶段(注入 judgeAvailable)就拒单;handle 阶段仍不可用/调用失败 → 抛错,不交付空结果。
 *
 * 本文件同时导出 plan_gate 复用的共享件:K 线整理、ATR(14)、加权盈亏比、候选快照、jevJudge(ServiceDeps.judge 工厂)、数字格式化。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ResearchBar, StrategyJudge } from '@trade-gate/contracts';
import { hash } from '../../research/primitives.js';
import { judgeDecimal } from '../../research/judge/candidate.js';
import {
  AtomicCallBudget, JudgeDecisionStore, buildJudgeState, judgeCandidate, usdString, usdUnits,
  type BudgetView, type DecisionProvider, type FrozenModelProfile, type JudgeCandidateSnapshot, type JudgeResult, type JudgeStateV1,
} from '../../research/judge/index.js';
import { JUDGE_TEMPLATE_KEYS, JUDGE_TEMPLATES, templateJudge, type JudgeTemplateKey } from '../../research/judge/templates.js';
import { JUDGE_MAX_CALL_USD } from '../../model-connections.js';
import { freeText, jsonParams, marketIn, numberAfter, positive, sideIn, symbolList, symbolsIn, targetsIn, timeframeIn } from './params.js';
import { deliverable, pct } from './render.js';
import { ServiceInputError, type PerCallJob, type PerCallService, type ServiceDeps } from './types.js';

// ---------------------------------------------------------------- 共享件(plan_gate 也用)

export const JEV_TIMEFRAMES = ['15m', '1h', '4h', '1d'] as const;
export const TF_MS: Record<string, number> = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
/** 每个 job 的调用上限:一次正常调用 + 一次(K 线已前进后的)重试;之后预算闸拒绝 */
export const JEV_MAX_CALLS_PER_JOB = 2;
export const BARS_LIMIT = 150;
/** 历史基准率 / 代码对照用的 K 线根数(一次拉齐;模型输入仍只用最近 BARS_LIMIT 根) */
export const BASE_RATE_BARS = 1000;
/** 独立样本少于这个数就在正文提示「样本少」 */
export const MIN_INDEPENDENT_SAMPLES = 30;

/** 钉住的模型连接。runtime:`frozenDecision()` 的 profile + `fromDecisionClient(client, profile)` + `store.marketDb` */
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

// ---------------------------------------------------------------- 数字格式化(交付文本 / payload 共用)

/** 价格精度:最近 30 根 K 线报价里出现过的最多小数位(去尾零),上限 8 */
export function priceDigits(bars: readonly ResearchBar[]): number {
  let d = 0;
  for (const b of bars.slice(-30)) for (const s of [b.open, b.high, b.low, b.close]) {
    const m = /\.(\d*?)0*$/.exec(String(s));
    if (m) d = Math.max(d, m[1]!.length);
  }
  return Math.min(d, 8);
}
/** 价格按精度取整(payload 用) */
export const roundPrice = (x: number, digits: number): number => Number(x.toFixed(digits));
/** 比值 / 概率类取 4 位(payload 用) */
export const r4 = (x: number | null | undefined): number | null => x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4;
/** 价格显示:千分位 + 精度内去尾零(84,384.6) */
export const fmtPrice = (x: number | null | undefined, digits: number): string =>
  x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
/** 大数显示:7.83B / 2M */
export function fmtBig(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  const a = Math.abs(x), trim = (v: number) => String(Number(v.toFixed(2)));
  return a >= 1e9 ? `${trim(x / 1e9)}B` : a >= 1e6 ? `${trim(x / 1e6)}M` : a >= 1e3 ? `${trim(x / 1e3)}K` : trim(x);
}
/** 固定小数位显示(比值 / ATR 倍数) */
export const fx = (x: number | null | undefined, digits = 2): string => x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(digits);
/** 带符号百分比显示(输入是百分数,不是比例) */
export const signedPct = (x: number | null | undefined, digits = 2): string => x === null || x === undefined || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(digits)}%`;
/** 2026-09-25 09:00 UTC */
export const utcText = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
/** 递归去浮点噪声(84384.600000000006 → 84384.6) */
export function tidy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, x) => typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1e8) / 1e8 : x)) as T;
}
export const SIDE_TEXT = { long: 'long', short: 'short' } as const;
export const MARKET_TEXT = { perp: 'perpetual', spot: 'spot' } as const;

// ---------------------------------------------------------------- 特征值与历史基准率(纯代码、同一批 K 线)

const avg = (a: readonly number[]) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
function ema(xs: readonly number[], n: number): number {
  if (xs.length < n) return NaN;
  let e = avg(xs.slice(0, n));
  const k = 2 / (n + 1);
  for (let i = n; i < xs.length; i++) e = xs[i]! * k + e * (1 - k);
  return e;
}
/** Wilder RSI */
function rsi(xs: readonly number[], n = 14): number {
  if (xs.length < n + 1) return NaN;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = xs[i]! - xs[i - 1]!; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < xs.length; i++) { const d = xs[i]! - xs[i - 1]!; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
/** 与 buildJudgeState 同口径:最近 100 根里最近一个已确认 2+2 摆动低点 / 高点 */
export function swingLevels(bars: readonly ResearchBar[]): { support: number | null; resistance: number | null } {
  const xs = bars.slice(-100);
  let support: number | null = null, resistance: number | null = null;
  for (let i = 2; i < xs.length - 2; i++) {
    const b = xs[i]!, adj = [xs[i - 2]!, xs[i - 1]!, xs[i + 1]!, xs[i + 2]!];
    if (adj.every((a) => Number(a.low) > Number(b.low))) support = Number(b.low);
    if (adj.every((a) => Number(a.high) < Number(b.high))) resistance = Number(b.high);
  }
  return { support, resistance };
}

export interface MarketFeatures {
  last: number; ema20: number; ema50: number; ema_stack: 'bull' | 'bear' | 'mixed'; rsi14: number;
  atr14: number; atr_pct: number; change_24h_pct: number | null; volume_ratio: number;
  support: number | null; resistance: number | null; support_dist_atr: number | null; resistance_dist_atr: number | null;
}
export function marketFeatures(bars: readonly ResearchBar[], timeframe_ms: number): MarketFeatures {
  const closes = bars.map((b) => Number(b.close)), last = closes.at(-1)!, atr = atr14(bars);
  const ema20 = ema(closes, 20), ema50 = ema(closes, 50);
  const ema_stack = last > ema20 && ema20 > ema50 ? 'bull' : last < ema20 && ema20 < ema50 ? 'bear' : 'mixed';
  const k = Math.round(86_400_000 / timeframe_ms);
  const change_24h_pct = closes.length > k ? (last / closes[closes.length - 1 - k]! - 1) * 100 : null;
  const vols = bars.slice(-20).map((b) => Number(b.volume));
  const { support, resistance } = swingLevels(bars);
  return {
    last, ema20, ema50, ema_stack, rsi14: rsi(closes), atr14: atr, atr_pct: atr / last * 100, change_24h_pct,
    volume_ratio: Number(bars.at(-1)!.volume) / (avg(vols) || 1),
    support, resistance,
    support_dist_atr: support === null ? null : (last - support) / atr,
    resistance_dist_atr: resistance === null ? null : (resistance - last) / atr,
  };
}
const EMA_STACK_TEXT = { bull: 'bullish stack', bear: 'bearish stack', mixed: 'mixed' } as const;

/** yes = 频率(按全部重叠窗口统计);windows = 重叠窗口数;independent = 互不重叠的窗口数(对外报这个) */
export interface BaseRate { yes: number; windows: number; independent: number; distance_pct: number }
/**
 * 历史基准率:已收盘 K 线里,每根收盘后未来 H 根内「同样百分比距离」的事件发生频率。
 * 频率按每根都起一个窗口统计(方差更小);窗口互相重叠,独立样本数 = 不重叠窗口数 ≈ 窗口数 ÷ H。
 * 支撑守住 = 未来 H 根最低价不低于 收盘×(1−d);阻力突破 = 第 H 根收盘高于 收盘×(1+d);触及止损 = 未来 H 根触到同距离止损。
 */
export function baseRates(bars: readonly ResearchBar[], H: number, side: 'long' | 'short', levels: { support: number | null; resistance: number | null; stop: number }): Partial<Record<JudgeTemplateKey, BaseRate>> {
  const n = bars.length, last = Number(bars.at(-1)!.close), out: Partial<Record<JudgeTemplateKey, BaseRate>> = {};
  if (!(H >= 1) || n - H < 20) return out;
  const tally = (d: number, hit: (c: number, fut: readonly ResearchBar[]) => boolean): BaseRate => {
    let yes = 0, windows = 0;
    for (let i = 0; i + H < n; i++) { windows++; if (hit(Number(bars[i]!.close), bars.slice(i + 1, i + 1 + H))) yes++; }
    return { yes: yes / windows, windows, independent: Math.ceil(windows / H), distance_pct: d * 100 };
  };
  if (levels.support !== null) {
    const d = (last - levels.support) / last;
    out.support_holds = tally(d, (c, fut) => Math.min(...fut.map((b) => Number(b.low))) >= c * (1 - d));
  }
  if (levels.resistance !== null) {
    const d = (levels.resistance - last) / last;
    out.resistance_breaks = tally(d, (c, fut) => Number(fut.at(-1)!.close) > c * (1 + d));
  }
  const d = side === 'long' ? (last - levels.stop) / last : (levels.stop - last) / last;
  out.retreat_risk = tally(d, (c, fut) => side === 'long' ? Math.min(...fut.map((b) => Number(b.low))) <= c * (1 - d) : Math.max(...fut.map((b) => Number(b.high))) >= c * (1 + d));
  return out;
}
/**
 * 代码对照(plan_gate 用):同一批 K 线里,每根收盘按同样百分比的止损 / 目标距离模拟一笔,max_bars 根内谁先触达。
 * 同一根 K 线里止损和目标都碰到 → 记止损(保守)。target_first = 目标先到 ÷(目标先到 + 止损先到),超时不计入分母。
 * independent = 按时间顺序一笔结束再开下一笔(互不重叠)得到的已决样本数。breakeven = 该盈亏比下的盈亏平衡胜率。
 * 不分行情状态的无条件频率,只作参照。
 */
export interface TargetFirstRate { target_first: number; target: number; stop: number; timeouts: number; independent: number; risk_pct: number; reward_pct: number; max_bars: number; breakeven: number }
export const TARGET_FIRST_MAX_BARS = 100;
export function targetFirstRate(bars: readonly ResearchBar[], side: 'long' | 'short', risk_frac: number, reward_frac: number, max_bars = TARGET_FIRST_MAX_BARS): TargetFirstRate | null {
  if (!(risk_frac > 0) || !(reward_frac > 0) || !(max_bars >= 1)) return null;
  const n = bars.length, long = side === 'long';
  const walk = (i: number): { kind: 'target' | 'stop' | 'timeout' | 'open'; end: number } => {
    const c = Number(bars[i]!.close);
    const stopPx = long ? c * (1 - risk_frac) : c * (1 + risk_frac), tgtPx = long ? c * (1 + reward_frac) : c * (1 - reward_frac);
    for (let j = i + 1; j < n && j <= i + max_bars; j++) {
      const h = Number(bars[j]!.high), l = Number(bars[j]!.low);
      if (long ? l <= stopPx : h >= stopPx) return { kind: 'stop', end: j };
      if (long ? h >= tgtPx : l <= tgtPx) return { kind: 'target', end: j };
    }
    return i + max_bars < n ? { kind: 'timeout', end: i + max_bars } : { kind: 'open', end: n };
  };
  let target = 0, stop = 0, timeouts = 0;
  for (let i = 0; i < n - 1; i++) {
    const o = walk(i);
    if (o.kind === 'target') target++; else if (o.kind === 'stop') stop++; else if (o.kind === 'timeout') timeouts++;
  }
  let independent = 0;
  for (let i = 0; i < n - 1;) {
    const o = walk(i);
    if (o.kind === 'open') break;
    if (o.kind !== 'timeout') independent++;
    i = o.end;
  }
  if (target + stop === 0) return null;
  return { target_first: target / (target + stop), target, stop, timeouts, independent, risk_pct: risk_frac * 100, reward_pct: reward_frac * 100, max_bars, breakeven: risk_frac / (risk_frac + reward_frac) };
}

/** 模型概率与历史频率相差超过这个值(比例)就标「分歧大」 */
export const BASE_RATE_DIVERGENCE = 0.25;
/** 模型各题「是」概率的极差不超过这个值、且历史频率的极差至少再大这么多 → 判为区分度低 */
export const MODEL_FLAT_SPREAD = 0.15;

// ---------------------------------------------------------------- 模型调用

/** 价位类模板(问题文本带时长) */
export const LEVEL_TEMPLATES: readonly JudgeTemplateKey[] = ['support_holds', 'resistance_breaks', 'retreat_risk'];
/** 判断层模板里写死的时长字样;服务层按买方周期替换 */
const TEMPLATE_HORIZON = '15分钟';

/** 发给模型的时长文字(判断层模板是中文,替换进问题文本):4小时 / 1小时 / 4天 / 45分钟。不进交付正文。 */
export function horizonLabel(ms: number): string {
  return ms % 86_400_000 === 0 ? `${ms / 86_400_000}天` : ms % 3_600_000 === 0 ? `${ms / 3_600_000}小时` : `${Math.round(ms / 60_000)}分钟`;
}
/** 交付正文 / payload 用的英文时长:4 hours / 1 hour / 4 days / 45 minutes */
export function horizonText(ms: number): string {
  const [n, unit] = ms % 86_400_000 === 0 ? [ms / 86_400_000, 'day'] : ms % 3_600_000 === 0 ? [ms / 3_600_000, 'hour'] : [Math.round(ms / 60_000), 'minute'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}
/** 克隆 spec,把价位类问题里的「15分钟」换成 label;模板里找不到该字样 → applied=false(如实按 15 分钟交付) */
function withHorizon(spec: StrategyJudge, label: string): { spec: StrategyJudge; applied: boolean } {
  if (label === TEMPLATE_HORIZON) return { spec, applied: true };
  const s = structuredClone(spec);
  let applied = true;
  for (const q of s.questions) {
    if (!(LEVEL_TEMPLATES as readonly string[]).includes(q.key)) continue;
    if (!q.instructions.includes(TEMPLATE_HORIZON)) { applied = false; break; }
    q.instructions = q.instructions.replaceAll(TEMPLATE_HORIZON, label);
    q.criteria = q.criteria.map((c) => c.replaceAll(TEMPLATE_HORIZON, label)) as typeof q.criteria;
  }
  return applied ? { spec: s, applied } : { spec, applied };
}

export interface JevRun { result: JudgeResult; state: JudgeStateV1; spec: StrategyJudge; templates: JudgeTemplateKey[]; dropped: { template: JudgeTemplateKey; reason: string }[]; budget: BudgetView; profile: FrozenModelProfile; horizon_applied: boolean }

/**
 * 一次模型判断:模板问题 → (可选)价位题时长改写 → state(缺摆动支撑/阻力的价位模板剔除并记下)→ 每 scope 一个原子预算 → judgeCandidate。
 * 预算闸失败、provider 失败都体现在 result.status==='error' + reason_codes,由调用方决定是否交付。
 */
export async function runJev(binding: JevBinding, candidate: JudgeCandidateSnapshot, bars: readonly ResearchBar[], templates: readonly JudgeTemplateKey[], scope: string, opts: JevOptions = {}, horizon?: string): Promise<JevRun> {
  const { profile, provider, db } = binding;
  if (usdUnits(profile.max_call_usd) > usdUnits(JUDGE_MAX_CALL_USD)) throw new Error('jev_price_cap_exceeded');
  let keys = [...templates];
  const dropped: JevRun['dropped'] = [];
  const specFor = (ks: JudgeTemplateKey[]) => { const base = templateJudge(profile.ref, { templates: ks }); return horizon ? withHorizon(base, horizon) : { spec: base, applied: true }; };
  let built = specFor(keys), state: JudgeStateV1;
  for (;;) {
    try { state = buildJudgeState(candidate, bars, built.spec); break; }
    catch (e) {
      const m = /^judge_field_unavailable:(.+)$/.exec((e as Error).message);
      if (!m) throw e;
      const field = m[1]!, out = keys.filter((k) => (JUDGE_TEMPLATES[k].state_fields as string[]).includes(field));
      if (!out.length || out.length === keys.length) throw new Error(`jev_state_unavailable:${field}`);
      for (const k of out) dropped.push({ template: k, reason: `state_field_unavailable:${field}` });
      keys = keys.filter((k) => !out.includes(k));
      built = specFor(keys);
    }
  }
  const spec = built.spec;
  const max_calls = opts.max_calls_per_job ?? JEV_MAX_CALLS_PER_JOB;
  const budget = AtomicCallBudget.create(db, scope, max_calls, usdString(usdUnits(profile.max_call_usd) * BigInt(max_calls)));
  const store = new JudgeDecisionStore(db, opts.now);
  const result = await judgeCandidate({
    candidate, state, spec, model_profile: profile, decision_key: `${scope}:${candidate.id}`,
    execution_spec_hash: hash({ service: 'asp_per_call', templates: keys, version: 1, ...(horizon && built.applied ? { horizon } : {}) }),
  }, { mode: 'request_once', provider, store, budget, ...(opts.now ? { now: opts.now } : {}) });
  return { result, state, spec, templates: keys, dropped, budget: budget.view(), profile, horizon_applied: built.applied };
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
  if (n === null) throw new ServiceInputError(`${key}_invalid`, `${key} must be a positive number`);
  return n;
}
function targetsField(p: Record<string, unknown>): number[] | undefined {
  const v = p['targets'] ?? p['target'] ?? p['take_profits'];
  if (v === undefined || v === null || v === '') return undefined;
  const xs = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，/\s]+/).filter(Boolean) : [v];
  const out = xs.map((x) => positive(x));
  if (out.some((x) => x === null)) throw new ServiceInputError('targets_invalid', 'targets must be a list of positive numbers');
  if (out.length > 5) throw new ServiceInputError('targets_too_many', 'At most 5 targets');
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
    if (xs.length > 1) throw new ServiceInputError('symbol_ambiguous', `Exactly one symbol per order; the request mentions ${xs.join(', ')}`);
    symbol = xs[0] ?? null;
  }
  const entry = priceField(p, 'entry') ?? numberAfter(text, '入场|进场|开仓|\\bentry\\b');
  const stop = priceField(p, 'stop') ?? priceField(p, 'stop_loss') ?? numberAfter(text, '止损|\\bstop(?:[\\s-]*loss)?\\b|\\bsl\\b');
  const targets = targetsField(p) ?? targetsIn(text);
  const market = marketIn(p['market'], text);
  let side = sideIn(p['side'], text);
  if (!side && opts.inferSide !== false && entry !== null && stop !== null && entry !== stop) side = stop < entry ? 'long' : 'short';
  if (side === 'short' && market === 'spot') throw new ServiceInputError('side_invalid', 'Spot cannot be shorted');
  if (entry !== null && stop !== null && entry === stop) throw new ServiceInputError('stop_invalid', 'The stop must differ from the entry');
  return { symbol, side, entry, stop, targets, timeframe: timeframeIn(p['timeframe'], text, JEV_TIMEFRAMES, '1h'), market };
}

// ---------------------------------------------------------------- 服务本体

export const JEV_DEFAULT_TEMPLATES: JudgeTemplateKey[] = ['take', 'support_holds', 'resistance_breaks', 'retreat_risk'];
/** 价位类问题默认看未来几根 K 线 */
export const DEFAULT_HORIZON_BARS = 4;
export const MAX_HORIZON_BARS = 24;

/** 买方看到的问题短名(英文;发给模型的问题文本在 research/judge/templates.ts,不改) */
export const TEMPLATE_NAME: Record<JudgeTemplateKey, string> = {
  take: 'Entry setup', quality: 'Candidate quality', support_holds: 'Support holds', resistance_breaks: 'Resistance break', retreat_risk: 'Pullback to stop', regime_fit: 'Regime fit',
};
/** 标签(noul 的 yes/no、quality 的档位) */
export const LABEL_TEXT: Record<JudgeTemplateKey, Record<string, string>> = {
  take: { yes: 'reasonable', no: 'not reasonable' },
  quality: { poor: 'poor', fair: 'fair', good: 'good', excellent: 'excellent' },
  support_holds: { yes: 'holds', no: 'breaks' },
  resistance_breaks: { yes: 'breaks', no: 'does not break' },
  retreat_risk: { yes: 'hits stop', no: 'does not hit stop' },
  regime_fit: { yes: 'compatible', no: 'incompatible' },
};
/** 买方看到的问题描述(价位题带时长与价位) */
export function questionText(k: JudgeTemplateKey, horizon: string, x: { support?: string; resistance?: string; stop?: string } = {}): string {
  switch (k) {
    case 'take': return 'is the setup reasonable right now, given the entry, stop and targets';
    case 'quality': return 'overall quality of this candidate';
    case 'support_holds': return `the low over the next ${horizon} stays above the nearest support${x.support ? ` ${x.support}` : ''}`;
    case 'resistance_breaks': return `the close at the end of the next ${horizon} is above the nearest resistance${x.resistance ? ` ${x.resistance}` : ''}`;
    case 'retreat_risk': return `price touches the stop${x.stop ? ` ${x.stop}` : ''} within the next ${horizon}`;
    case 'regime_fit': return 'current trend, volatility and volume are compatible with the direction and risk geometry';
  }
}
const DROP_TEXT: Record<string, string> = {
  'candidate.support': 'no confirmed swing support in the last 100 bars',
  'candidate.resistance': 'no confirmed swing resistance in the last 100 bars',
};
const DROP_FALLBACK = 'required data unavailable';

export interface JevProbabilityParams {
  symbol: string; timeframe: string; market: 'spot' | 'perp';
  side: 'long' | 'short'; entry: number | null; stop: number | null; targets: number[];
  /** 实际要问的模板(take 固定在第一位) */
  templates: JudgeTemplateKey[];
  /** 买方明确问到的模板(用于结论行排序;没问到任何 = 空) */
  asked: JudgeTemplateKey[];
  /** 买方没给、由服务代填的假设(写进交付首行) */
  assumed?: string[];
  /** 价位类问题看未来几根 K 线 */
  horizon_bars: number;
}

const ASK_RE: [JudgeTemplateKey, RegExp][] = [
  ['take', /值得|值不值|入场|进场|开仓|能不能(?:开|进|买|上车)|可以(?:开|进|买)|should\s*i|worth|\benter|\bentry\b|\btake\b/i],
  ['quality', /质量|\bquality\b/i],
  ['support_holds', /支撑|守住|守得住|跌破|\bsupport/i],
  ['resistance_breaks', /阻力|压力位|突破|\bresistance|\bbreakout/i],
  ['retreat_risk', /回落|回撤|回调|打止损|触及止损|扫损|\bretreat|\bpullback|stop[\s-]*out/i],
  ['regime_fit', /顺势|状态匹配|\bregime/i],
];

/** take 固定必答;明确给了 templates 就 take + 这些;自由文本命中的非 take 问题追加在 take 后,一个都没命中 → 默认四题 */
export function templatesIn(v: unknown, text: string): { templates: JudgeTemplateKey[]; asked: JudgeTemplateKey[] } {
  if (v !== undefined && v !== null && v !== '') {
    // 上架描述是用英文句子写的问题,买方常照着拼成 entry_setup_reasonable / support_hold / pullback_risk 这类 key;
    // 认不出原 key 就按问题关键词对上,一个都对不上才退回默认四题,不拒单
    const xs = (Array.isArray(v) ? v : String(v).split(/[,，\s]+/)).map((x) => String(x).trim()).filter(Boolean);
    const keyOf = (x: string): JudgeTemplateKey | null => (JUDGE_TEMPLATE_KEYS as readonly string[]).includes(x) ? x as JudgeTemplateKey
      : ASK_RE.find(([, re]) => re.test(x.replace(/[_-]+/g, ' ')))?.[0] ?? null;
    const asked = [...new Set(xs.map(keyOf).filter((k): k is JudgeTemplateKey => k !== null))];
    if (!asked.length) return { templates: [...JEV_DEFAULT_TEMPLATES], asked };
    return { templates: ['take', ...asked.filter((k) => k !== 'take')], asked };
  }
  const asked = ASK_RE.filter(([, re]) => re.test(text)).map(([k]) => k);
  const extra = asked.filter((k) => k !== 'take');
  return { templates: extra.length ? ['take', ...extra] : [...JEV_DEFAULT_TEMPLATES], asked };
}
function horizonBarsIn(v: unknown): number {
  if (v === undefined || v === null || v === '') return DEFAULT_HORIZON_BARS;
  // 「12」「12 bars」都认
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+\s*(?:bars?|candles?|根)?\s*$/i.test(v) ? parseInt(v, 10) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_HORIZON_BARS) throw new ServiceInputError('horizon_invalid', `horizon_bars must be an integer from 1 to ${MAX_HORIZON_BARS}`);
  return n;
}

export function createJevProbabilityService(opts: JevOptions & {
  /** 接单前的本地可用性检查(连接已绑定、钥匙在库、钉住版本一致);返回原因字符串 = 不可用。不得发网络请求 */
  judgeAvailable?: () => string | null;
  /** 可选:OKX 上有没有这个标的(同步、不发网络;运行时 = AspServices.tradable)。false → 接单前拒单退款,而不是接单后拉 K 线失败 3 次再交付失败说明 */
  tradable?: (symbol: string, market: 'spot' | 'perp') => boolean;
} = {}): PerCallService<JevProbabilityParams> {
  return {
    key: 'jev_probability',
    validate(job) {
      const plan = parsePlan(job), p = jsonParams(job) ?? {};
      // 没写币种不拒单(复审 09-26:买方只贴了服务描述就被拒):默认 BTCUSDT,交付里写明假设
      const assumed: string[] = [];
      if (!plan.symbol) { plan.symbol = 'BTCUSDT'; assumed.push(`No symbol was given, so this check uses BTCUSDT ${plan.timeframe} (the most liquid OKX perpetual); for another coin, place a new order naming the symbol and timeframe, e.g. "ETH 4h long, entry 2500, stop 2440"`); }
      const side = plan.side ?? 'long';
      if (side === 'short' && plan.market === 'spot') throw new ServiceInputError('side_invalid', 'Spot cannot be shorted');
      const dir = side === 'long' ? 1 : -1;
      if (plan.entry !== null && plan.stop !== null && (plan.entry - plan.stop) * dir <= 0) throw new ServiceInputError('stop_side', 'The stop is on the wrong side of the entry');
      if (plan.entry !== null && plan.targets.length && plan.targets.every((t) => (t - plan.entry!) * dir <= 0)) throw new ServiceInputError('targets_side', 'All targets are on the wrong side of the entry');
      const { templates, asked } = templatesIn(p['templates'] ?? p['questions'], freeText(job));
      const horizon_bars = horizonBarsIn(p['horizon_bars']);
      let listed = true;
      try { listed = opts.tradable ? opts.tradable(plan.symbol, plan.market) : true; } catch { listed = true; }
      if (!listed) throw new ServiceInputError('symbol_unknown', `${plan.symbol} has no tradable OKX ${plan.market === 'perp' ? 'USDT perpetual' : 'spot'} market; name a coin listed on OKX (e.g. BTC, ETH, SOL) and a timeframe (15m / 1h / 4h / 1d)`);
      const why = opts.judgeAvailable?.();
      if (why) throw new ServiceInputError('jev_unavailable', 'The AI decision model is temporarily unavailable; the order cannot be accepted');
      return { symbol: plan.symbol, timeframe: plan.timeframe, market: plan.market, side, entry: plan.entry, stop: plan.stop, targets: plan.targets, templates, asked, horizon_bars, ...(assumed.length ? { assumed } : {}) };
    },
    async handle(job, params, deps: JevDeps) {
      const binding = deps.jev?.() ?? null;
      if (!binding) throw new Error('jev_unavailable');
      const tf_ms = TF_MS[params.timeframe]!;
      // 一次拉齐:基准率用全部(目标 1000 根),模型输入 / 特征只用最近 BARS_LIMIT 根
      const { bars: refBars, as_of } = closedBars(await deps.bars(params.symbol, params.timeframe, BASE_RATE_BARS, params.market), tf_ms, deps.now());
      const bars = refBars.slice(-BARS_LIMIT);
      const last = Number(bars.at(-1)!.close), atr = atr14(bars), dir = params.side === 'long' ? 1 : -1;
      if (!(atr > 0)) throw new Error('atr_unavailable');
      const entry = params.entry ?? last;
      const stop = params.stop ?? entry - dir * 1.5 * atr;
      if ((entry - stop) * dir <= 0 || stop <= 0) throw new Error('stop_wrong_side_vs_market');
      const targets = params.targets.length ? params.targets : [entry + dir * 2 * Math.abs(entry - stop)];
      const { rr, valid } = weightedRR(params.side, entry, stop, targets);
      if (!valid.length) throw new Error('targets_wrong_side_vs_market');
      const candidate = serviceCandidate({ symbol: params.symbol, as_of, timeframe_ms: tf_ms, direction: params.side, entry, stop, target: valid[0]!, reward_risk: rr });

      const H = params.horizon_bars, wanted = horizonLabel(H * tf_ms);
      const run = await runJev(binding, candidate, bars, params.templates, `asp:jev_probability:${job.job_id}`, { ...opts, now: opts.now ?? deps.now }, wanted);
      const r = run.result;
      // 预算闸(同一 job 已用完调用额度)仍抛错;其余模型失败(超时 / 解析失败等)落库后同一 K 线重试也是同一个错误,
      // 与其重试 3 次再交付「无法完成」,不如降级成只用历史基准率 + 代码特征、仍然回答买方问题的交付(写明模型未参与)
      const failed = r.status === 'error' || !r.answers.length;
      if (failed && (r.reason_codes.some((c) => /budget|price/.test(c)) || !r.reason_codes.length && r.status !== 'error')) throw new Error(`jev_failed:${r.reason_codes.join(',') || 'no_answers'}`);
      const modelOk = !failed;

      // ---- 口径:时长、价位、特征、基准率
      // wanted(中文)只发给模型;买方看到的时长用英文
      const horizon = run.horizon_applied ? horizonText(H * tf_ms) : '15 minutes';
      const horizonBars = run.horizon_applied ? H : 900_000 / tf_ms; // 没改写成功 → 实际是 15 分钟(非 15m 周期时不是整数根,不算基准率)
      const d = priceDigits(bars), P = (x: number | null | undefined) => fmtPrice(x, d), RP = (x: number) => roundPrice(x, d);
      const f = marketFeatures(bars, tf_ms);
      const stateLevel = (k: 'support' | 'resistance') => { const v = run.state.candidate[k]; return typeof v === 'string' ? Number(v) : null; };
      const support = stateLevel('support') ?? f.support, resistance = stateLevel('resistance') ?? f.resistance;
      const base = Number.isInteger(horizonBars) ? baseRates(refBars, horizonBars, params.side, { support, resistance, stop }) : {};
      const baseN = refBars.length, baseShort = baseN < BASE_RATE_BARS;
      // take 的代码对照:同样止损 / 第一目标百分比距离下,历史上目标先于止损的频率(与模型无关)
      const takeRef = targetFirstRate(refBars, params.side, Math.abs(entry - stop) / entry, Math.abs(valid[0]! - entry) / entry);
      const levelText = { support: support === null ? undefined : P(support), resistance: resistance === null ? undefined : P(resistance), stop: P(stop) };

      const geometry = { entry: params.entry === null ? 'last_close' : 'buyer', stop: params.stop === null ? 'atr_1.5' : 'buyer', targets: params.targets.length ? 'buyer' : 'rr_2' };
      const geoText = { entry: params.entry === null ? 'at last price' : 'buyer-given', stop: params.stop === null ? '1.5 ATR' : 'buyer-given', targets: params.targets.length ? 'buyer-given' : '2R' };
      const rule = (k: string) => run.spec.rule.all.find((p) => p.question_key === k);
      const rawAnswers: { question_key: string; probabilities: Record<string, number> }[] = modelOk ? r.answers : run.templates.map((k) => ({ question_key: k, probabilities: {} }));
      const answers = rawAnswers.map((a) => {
        const k = a.question_key as JudgeTemplateKey, br = base[k] ?? null, yes = a.probabilities['yes'];
        const divergence = br !== null && yes !== undefined && Math.abs(yes - br.yes) > BASE_RATE_DIVERGENCE;
        return {
          question_key: k, name: TEMPLATE_NAME[k] ?? k, question: questionText(k, horizon, levelText),
          labels: LABEL_TEXT[k] ?? {}, probabilities: Object.fromEntries(Object.entries(a.probabilities).map(([l, p]) => [l, r4(p)])) as Record<string, number>,
          base_rate: br ? { yes: r4(br.yes), independent_windows: br.independent, overlapping_windows: br.windows, bars: baseN, distance_pct: r4(br.distance_pct) } : null, divergence,
        };
      });
      const lbl = (k: JudgeTemplateKey, l: string) => LABEL_TEXT[k]?.[l] ?? l;
      const dist = (k: JudgeTemplateKey) => Object.entries(answers.find((a) => a.question_key === k)!.probabilities).map(([l, p]) => `${lbl(k, l)} ${pct(p, 0)}`).join(' / ');

      // ---- 第一行:中文结论(take 在前,其余按买方问到的顺序)
      const take = rawAnswers.find((a) => a.question_key === 'take');
      const takePred = r.predicates.find((p) => p.question_key === 'take'), takeRule = rule('take');
      const takeYes = take?.probabilities['yes'] ?? null;
      // 只描述模型概率相对服务参考阈值的位置,不写「倾向值得」这类建议腔
      const takeBand: 'above' | 'edge' | 'below' | null = !takePred || takeYes === null ? null : takePred.passed ? 'above' : takeRule && (takeRule.operator === 'gte' ? takeYes >= takeRule.threshold : takeYes <= takeRule.threshold) ? 'edge' : 'below';
      const BAND_TEXT = { above: 'above', edge: 'near', below: 'below' } as const;
      const takeThr = takeBand && takeRule ? `; service reference threshold ${pct(takeRule.threshold, 0)}, ${BAND_TEXT[takeBand]} the threshold` : '';
      const order = [...params.asked.filter((k) => k !== 'take'), ...run.templates.filter((k) => k !== 'take' && !params.asked.includes(k))];
      const brief = (k: JudgeTemplateKey) => {
        const a = answers.find((x) => x.question_key === k);
        if (!a) return null;
        const yes = a.probabilities['yes'];
        if (!modelOk && !a.base_rate) return null;
        if (yes === undefined && modelOk) { const [l, p] = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0]!; return `${a.name}: ${lbl(k, l)} ${pct(p, 0)}`; }
        const what = k === 'support_holds' ? `support ${levelText.support ?? ''} holds over the next ${horizon}`
          : k === 'resistance_breaks' ? `resistance ${levelText.resistance ?? ''} breaks by the end of the next ${horizon}`
            : k === 'retreat_risk' ? `stop ${levelText.stop} is hit within the next ${horizon}`
              : `${a.name} ${lbl(k, 'yes')}`;
        // 历史基准率在前,模型概率作参考
        if (!modelOk) return a.base_rate ? `${what}: historical same-distance ${pct(a.base_rate.yes, 0)}` : null;
        return `${what}: ${a.base_rate ? `historical same-distance ${pct(a.base_rate.yes, 0)}, ` : ''}model ${pct(yes, 0)}${a.divergence ? ' (large divergence)' : ''}`;
      };
      const setupText = `${SIDE_TEXT[params.side]}${params.entry === null ? ' (at last price)' : ` (entry ${P(entry)})`}`;
      const assumedTag = params.assumed?.length ? ' [symbol assumed, none given]' : '';
      const edge = takeRef ? takeRef.target_first - takeRef.breakeven : null;
      const geoWord = edge === null ? 'no historical same-distance sample' : edge >= 0.05 ? 'historically favorable geometry' : edge <= -0.05 ? 'historically unfavorable geometry' : 'geometry near historical breakeven';
      const summary = [
        modelOk
          ? `Conclusion: ${params.symbol} ${params.timeframe}${assumedTag} ${setupText} — the model puts the probability that the entry setup is "reasonable" at ${pct(takeYes, 0)} (model-generated reference${takeThr})`
          : `Conclusion: ${params.symbol} ${params.timeframe}${assumedTag} ${setupText} — AI model did not answer for this order; code-only reading: ${geoWord}${takeRef ? ` (target 1 before stop ${pct(takeRef.target_first, 0)} vs ${pct(takeRef.breakeven, 0)} breakeven)` : ''}`,
        ...order.map(brief).filter((x): x is string => !!x),
      ].join('; ');

      const small = (n: number) => n < MIN_INDEPENDENT_SAMPLES ? ', small sample' : '';
      // ---- 模型 vs 历史:逐题差值 + 为什么会差;模型区分度低(各题答案挤在一起、历史频率却拉得开)就明说,结论靠历史频率 + 代码特征
      const withBoth = answers.filter((a) => a.base_rate && a.probabilities['yes'] !== undefined);
      const ys = answers.map((a) => a.probabilities['yes']).filter((x): x is number => x !== undefined);
      const bs = answers.map((a) => a.base_rate?.yes).filter((x): x is number => x !== null && x !== undefined);
      const spread = (xs: number[]) => xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
      const flat = modelOk && ys.length >= 2 && spread(ys) <= MODEL_FLAT_SPREAD && (bs.length < 2 || spread(bs) >= spread(ys) + MODEL_FLAT_SPREAD);
      const pts = (x: number) => `${x >= 0 ? '+' : '−'}${Math.round(Math.abs(x) * 100)} pts`;
      const against = (params.side === 'long' && f.ema_stack === 'bear') || (params.side === 'short' && f.ema_stack === 'bull');
      const withTrend = (params.side === 'long' && f.ema_stack === 'bull') || (params.side === 'short' && f.ema_stack === 'bear');
      const stretched = params.side === 'long' && f.rsi14 >= 70 ? `RSI14 ${fx(f.rsi14, 1)} is stretched for a long` : params.side === 'short' && f.rsi14 <= 30 ? `RSI14 ${fx(f.rsi14, 1)} is stretched for a short` : `RSI14 ${fx(f.rsi14, 1)} is not at an extreme`;
      const context = `${withTrend ? `the ${params.side} runs with` : against ? `the ${params.side} runs against` : 'direction-neutral versus'} the ${params.timeframe} EMA stack (${EMA_STACK_TEXT[f.ema_stack]}); ${stretched}; volume ratio ${fx(f.volume_ratio)}`;
      const readingLines: string[] = [];
      if (modelOk && withBoth.length) {
        readingLines.push(`Model vs history: ${withBoth.map((a) => `${a.name.toLowerCase()} model ${pct(a.probabilities['yes'], 0)} vs history ${pct(a.base_rate!.yes, 0)} (${pts(a.probabilities['yes']! - (a.base_rate!.yes ?? 0))})`).join('; ')}. `
          + `Why they differ: the historical rate counts every past window at the same distance regardless of conditions, while the model conditions on the current features (${EMA_STACK_TEXT[f.ema_stack]}, RSI14 ${fx(f.rsi14, 1)}, volume ratio ${fx(f.volume_ratio)}); gaps under ~10 pts are within noise, larger gaps are the model's conditional view, not a measured edge.`);
      }
      if (flat) readingLines.push(`Model informativeness: low — its answers sit ${spread(ys) < 0.005 ? `all at ${pct(ys[0], 0)}` : `within ${pct(Math.min(...ys), 0)}–${pct(Math.max(...ys), 0)}`} across ${ys.length} different questions${bs.length >= 2 ? ` while the historical rates range ${pct(Math.min(...bs), 0)}–${pct(Math.max(...bs), 0)}` : ''}, so it adds little question-specific information here; the bottom line below leans on the historical rates and code features.`);
      if (!modelOk) readingLines.push(`AI model: did not return an answer for this order (model call failed); every question below is answered from the historical same-distance rates and code features only.`);
      const bottom = [
        takeRef ? `entry setup — at these distances target 1 came before the stop ${pct(takeRef.target_first, 0)} of the time vs ${pct(takeRef.breakeven, 0)} breakeven (${pts(edge!)}, ~${takeRef.independent} samples${small(takeRef.independent)}): ${geoWord}; ${context}` : `entry setup — ${context}`,
        ...answers.filter((a) => a.base_rate && a.question_key !== 'take').map((a) => `${a.name.toLowerCase()} — ${pct(a.base_rate!.yes, 0)} historically${a.base_rate!.independent_windows < MIN_INDEPENDENT_SAMPLES ? ' (small sample)' : ''}`),
      ];
      readingLines.push(`Bottom line (history + code features${modelOk ? '' : ' only'}): ${bottom.join('; ')}.`);
      const lines = [
        ...(params.assumed ?? []).map((x) => `Assumption: ${x}`),
        `Last price ${P(last)} (close as of ${utcText(as_of)}) · Setup: ${SIDE_TEXT[params.side]}, entry ${P(entry)} (${geoText.entry}), stop ${P(stop)} (${geoText.stop}), targets ${valid.map(P).join(' / ')} (${geoText.targets}) · reward/risk ${fx(rr)}`,
        ...answers.map((a) => `· ${a.name} (${a.question}): ${a.base_rate ? `historical same-distance ${lbl(a.question_key, 'yes')} ${pct(a.base_rate.yes, 0)} (~${a.base_rate.independent_windows} independent windows${small(a.base_rate.independent_windows)}) · model ` : 'model '}${modelOk ? dist(a.question_key) : 'not available'}${a.divergence ? ' · model and historical frequency diverge widely' : ''}${a.question_key === 'take' && takeRef ? ` · code reference: at the same distances, target 1 was hit before the stop ${pct(takeRef.target_first, 0)} of the time historically (breakeven needs ${pct(takeRef.breakeven, 0)}; ~${takeRef.independent} independent samples${small(takeRef.independent)})` : ''}`),
        ...(run.dropped.length ? [`Not asked: ${run.dropped.map((x) => `${TEMPLATE_NAME[x.template]} (${DROP_TEXT[x.reason.replace(/^state_field_unavailable:/, '')] ?? DROP_FALLBACK})`).join(', ')}`] : []),
        ...readingLines,
        `Features: EMA ${EMA_STACK_TEXT[f.ema_stack]} (EMA20 ${P(f.ema20)} / EMA50 ${P(f.ema50)}) · RSI14 ${fx(f.rsi14, 1)} · ATR14 ${P(f.atr14)} (${fx(f.atr_pct)}%) · to support ${fx(f.support_dist_atr, 1)} ATR · to resistance ${fx(f.resistance_dist_atr, 1)} ATR · 24h ${signedPct(f.change_24h_pct)} · volume ratio ${fx(f.volume_ratio)}`,
        `Method: rules extract features and support/resistance from the last 100 closed ${params.timeframe} bars and pass them to the AI decision model, which returns probabilities for fixed questions (model probabilities are generated references, not separately calibrated for the chosen horizon); level questions look at the next ${horizon}${run.horizon_applied ? ` (${H} × ${params.timeframe} bar${H === 1 ? '' : 's'})` : ' (the judge layer currently supports a 15-minute window only; not adjusted to the chosen timeframe)'}`
          + `; historical same-distance = how often an event at the same distance occurred over the last ${baseN} closed ${params.timeframe} bars${baseShort ? ` (target ${BASE_RATE_BARS} bars; only ${baseN} available for this symbol)` : ''}, independent windows = non-overlapping windows, unconditional across regimes, reference only. Probabilities describe the listed events, not the chance of profit.`,
      ];

      // 模型看到的输入;价位是十进制字符串(judgeDecimal 带 12 位小数噪声),对外按价格精度取整成数字
      const modelInputs = tidy(Object.fromEntries(Object.entries({ ...run.state.candidate, ...run.state.features })
        .map(([k, v]) => [k, typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? RP(Number(v)) : v])));
      return deliverable(job, 'jev_probability', '[AI Probability Assessment] Trading Swarm', summary, lines, {
        symbol: params.symbol, timeframe: params.timeframe, market: params.market, as_of, as_of_text: utcText(as_of), last_price: RP(last),
        horizon: { bars: run.horizon_applied ? H : null, text: horizon, applied: run.horizon_applied, applies_to: LEVEL_TEMPLATES.filter((k) => run.templates.includes(k)) },
        setup: { side: params.side, entry: RP(entry), stop: RP(stop), targets: valid.map(RP), reward_risk: r4(rr), geometry, atr14: r4(atr) },
        templates: run.templates, asked: params.asked,
        dropped_templates: run.dropped.map((x) => ({ ...x, reason_text: DROP_TEXT[x.reason.replace(/^state_field_unavailable:/, '')] ?? DROP_FALLBACK })),
        conclusion: { take_yes: r4(takeYes), take_reference_threshold: takeRule?.threshold ?? null, take_vs_threshold: takeBand, code_edge_pts: edge === null ? null : Math.round(edge * 100), code_reading: geoWord },
        model_status: { answered: modelOk, informative: modelOk ? !flat : false, answer_spread: r4(spread(ys)), base_rate_spread: r4(spread(bs)) },
        ...(params.assumed?.length ? { assumptions: params.assumed } : {}),
        base_rate_bars: { used: baseN, target: BASE_RATE_BARS },
        take_code_reference: takeRef ? { target_first: r4(takeRef.target_first), breakeven: r4(takeRef.breakeven), independent_samples: takeRef.independent, risk_pct: r4(takeRef.risk_pct), reward_pct: r4(takeRef.reward_pct), max_bars: takeRef.max_bars } : null,
        answers,
        features: {
          ema_stack: f.ema_stack, ema20: RP(f.ema20), ema50: RP(f.ema50), rsi14: r4(f.rsi14), atr14: r4(f.atr14), atr_pct: r4(f.atr_pct),
          support: support === null ? null : RP(support), resistance: resistance === null ? null : RP(resistance),
          support_dist_atr: r4(f.support_dist_atr), resistance_dist_atr: r4(f.resistance_dist_atr),
          change_24h_pct: r4(f.change_24h_pct), volume_ratio: r4(f.volume_ratio),
        },
        model_inputs: modelInputs,
        reference_rule: {
          note: 'Service default thresholds, reference only',
          predicates: r.predicates.map((p) => { const ru = rule(p.question_key); return { question_key: p.question_key, label: p.label, probability: r4(p.probability), operator: ru?.operator ?? null, threshold: ru?.threshold ?? null, passed: p.passed }; }),
        },
        model: { name: 'AI decision model', revision_tag: hash(r.model_revision ?? run.profile.model_revision).slice(0, 10), ...(modelOk ? {} : { answered: false }) },
        method: 'Rules extract features and support/resistance from the last 100 closed bars → the AI decision model returns probabilities for fixed question templates (pinned model version, no retries); historical base rates come from the last ~1000 closed bars, with sample counts as non-overlapping windows',
      }, { ai: modelOk });
    },
  };
}

export const jevProbabilityService = createJevProbabilityService();
