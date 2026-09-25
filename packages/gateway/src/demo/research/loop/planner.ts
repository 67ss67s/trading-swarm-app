import type {
  LoopPlan,
  LoopContext,
  LoopPlanStep,
  LoopConcept,
} from "@trading-swarm/contracts";
import type { ToolContext, ToolRegistry } from "./tools.js";
import { check } from "./schema.js";
import { resolveConcepts, type ConceptResolution } from "./concepts.js";
import {
  buildModePlan,
  defaultParams,
  detectMode,
  modeViolation,
  type ModeDecision,
  type ModeParams,
} from "./modes.js";
import { inferTimeframe, parseWindowPhrase } from "./phrasing.js";
const DAY = 86400000;
/** 验证类问题至少要覆盖这么多根 K 线:预热(慢均线/背离 lookback)+ 开发/验证/保留三段 + 30 笔样本纪律;30 天 1h 只有 720 根,日线更只有 30 根。 */
export const MIN_VALIDATE_BARS = 2400;
const MAX_WINDOW_DAYS = 3000;
const TF_MS: Record<string, number> = { m: 60000, h: 3600000, d: DAY };
/** 验证类问题默认回看天数:日线要覆盖多轮牛熊;小周期受 K 线根数(拉取与回测耗时)约束。 */
export function validateDays(tf: string): number {
  const ms = timeframeMs(tf);
  if (!Number.isFinite(ms)) return 365;
  return ms >= DAY ? MAX_WINDOW_DAYS : ms >= 4 * 3600000 ? 2190 : ms >= 3600000 ? 730 : ms >= 30 * 60000 ? 365 : ms >= 15 * 60000 ? 180 : 60;
}
export function timeframeMs(tf: string): number {
  const m = /^(\d+)(m|h|d)$/.exec(tf);
  return m ? Number(m[1]) * TF_MS[m[2]!]! : NaN;
}
/** 用户明说的周期(英文代号或中文叫法;「日线 trigger / 15 分钟进出场」取执行周期),实现在 phrasing.ts。 */
export { inferTimeframe };
/** 把计划里所有等于旧值的 timeframe / window 字段整体替换(参数是内联复制的,不是引用)。 */
function rewrite(value: any, replace: (key: string, v: any) => any): any {
  if (Array.isArray(value)) return value.map((v) => rewrite(v, replace));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, replace(k, rewrite(v, replace))]),
    );
  return value;
}
/**
 * 模型和规则计划都过这一道:用户明说的周期优先;用户明说的区间(「只要2026年」「最近3个月」)原样采用、不拉长
 * (样本不足 30 笔由报告标「只作观察」);都没说时 validate 的窗口不足目标根数就向前拉长。
 */
export function normalizePlan(plan: LoopPlan, question: string, now = Date.now()): LoopPlan {
  let out = plan;
  const wanted = inferTimeframe(question);
  if (wanted && out.timeframe !== wanted) {
    const before = out.timeframe;
    out = { ...out, timeframe: wanted, plan: rewrite(out.plan, (k, v) => (k === "timeframe" && v === before ? wanted : v)) };
  }
  const ms = timeframeMs(out.timeframe);
  const explicit = parseWindowPhrase(question, now);
  if (explicit) {
    const before = out.window, window = { from_ms: explicit.from_ms, to_ms: explicit.to_ms };
    if (before.from_ms !== window.from_ms || before.to_ms !== window.to_ms)
      out = { ...out, window, plan: rewrite(out.plan, (k, v) => (k === "window" && v && typeof v === "object" && v.from_ms === before.from_ms && v.to_ms === before.to_ms ? { ...window } : v)) };
    return out;
  }
  // 形态频率统计和策略验证一样需要长样本(30 天日线只有 30 根,统计不出频率)
  if ((out.task_kind === "validate" || out.mode === "pattern_frequency") && Number.isFinite(ms) && !/([0-9]+)\s*(?:天|days?)/i.test(question)) {
    // 全窗口回测(2026-09-23):默认尽量拉长到该周期的目标天数(日线≈全历史),而不是只够 2400 根;数据层拉不到那么早就从上市首根开始
    const target = Math.max(MIN_VALIDATE_BARS * ms, validateDays(out.timeframe) * DAY);
    if (out.window.to_ms - out.window.from_ms < target) {
      const from_ms = Math.max(0, out.window.to_ms - Math.min(target, MAX_WINDOW_DAYS * DAY));
      const before = out.window, window = { from_ms, to_ms: out.window.to_ms };
      out = { ...out, window, plan: rewrite(out.plan, (k, v) => (k === "window" && v && typeof v === "object" && v.from_ms === before.from_ms && v.to_ms === before.to_ms ? { ...window } : v)) };
    }
  }
  return out;
}
export type { LoopPlanStep };
/**
 * 规则计划:概念解析 → 模式判定 → 代码模板。模型不可用、或模型输出不可信时用它。
 * 步骤 key 与形状保持不变(resolve/coverage/price/…/answer),旧的测试与前端都按这些 key 读。
 */
export function fallbackPlan(
  question: string,
  context: LoopContext = { instrument_refs: [] },
  now = Date.now(),
): LoopPlan {
  const resolution = resolveConcepts(question);
  const decision = detectMode(question, context, resolution);
  const params = defaultParams(question, context, now, decision, resolution, inferTimeframe(question));
  return normalizePlan(
    buildModePlan({ question, decision, params, resolution, source: "fallback_rules" }),
    question,
    now,
  );
}
export function validatePlan(raw: unknown, registry: ToolRegistry): LoopPlan {
  const plan = check<LoopPlan>("Plan", raw);
  if (
    plan.window.from_ms >= plan.window.to_ms ||
    plan.plan.length > 40 ||
    !/^\d+(m|h|d)$/.test(plan.timeframe)
  )
    throw Error("SCHEMA_MISMATCH:plan_range");
  const previous = new Set<string>();
  let composeCount = 0;
  for (const s of plan.plan) {
    if (previous.has(s.key) || s.depends_on.some((k) => !previous.has(k)))
      throw Error("SCHEMA_MISMATCH:dependency_order");
    const tool = registry.get(s.tool);
    if (!tool || !tool.task_kinds.includes(plan.task_kind))
      throw Error("SCHEMA_MISMATCH:task_tool");
    if (
      (plan.task_kind === "market" || plan.task_kind === "compare") &&
      (s.tool === "compile_strategy" || s.tool === "run_backtest")
    )
      throw Error("SCHEMA_MISMATCH:market_backtest");
    if (s.tool === "compose_answer") {
      composeCount++;
      if (s !== plan.plan.at(-1))
        throw Error("SCHEMA_MISMATCH:answer_must_be_last");
    }
    previous.add(s.key);
  }
  if (!plan.clarify && composeCount !== 1)
    throw Error("SCHEMA_MISMATCH:one_final_answer_required");
  return plan;
}
/** 模型只填这些槽位;计划骨架由 modes.ts 给。 */
interface PlanSlots {
  instruments?: string[];
  timeframe?: string;
  window?: { from_ms: number; to_ms: number };
  strategies?: { label?: string; text: string }[];
  pattern?: { primitive: string; params?: Record<string, unknown>; horizon_bars?: number };
  benchmark?: string;
  clarify?: string;
}
const SLOT_KEYS = ["instruments", "timeframe", "window", "strategies", "pattern", "benchmark", "clarify"] as const;
/** 模型给的槽位必须至少有一项能用,否则视为无效输出并重试(空对象不能悄悄当成「同意默认值」)。 */
function parseSlots(raw: unknown): PlanSlots {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("SCHEMA_MISMATCH:slots");
  const o = raw as Record<string, unknown>;
  const slots: PlanSlots = {};
  if (Array.isArray(o.instruments) && o.instruments.every((x) => typeof x === "string") && o.instruments.length)
    slots.instruments = o.instruments as string[];
  if (typeof o.timeframe === "string" && /^\d+(m|h|d)$/.test(o.timeframe)) slots.timeframe = o.timeframe;
  const w = o.window as { from_ms?: unknown; to_ms?: unknown } | undefined;
  if (w && typeof w.from_ms === "number" && typeof w.to_ms === "number" && w.from_ms < w.to_ms)
    slots.window = { from_ms: Math.max(0, Math.floor(w.from_ms)), to_ms: Math.floor(w.to_ms) };
  if (Array.isArray(o.strategies)) {
    const list = o.strategies
      .filter((s): s is { label?: string; text: string } => !!s && typeof s === "object" && typeof (s as any).text === "string" && (s as any).text.trim().length > 0)
      .slice(0, 3);
    if (list.length) slots.strategies = list;
  }
  const p = o.pattern as { primitive?: unknown; params?: unknown; horizon_bars?: unknown } | undefined;
  if (p && typeof p.primitive === "string")
    slots.pattern = {
      primitive: p.primitive,
      ...(p.params && typeof p.params === "object" && !Array.isArray(p.params) ? { params: p.params as Record<string, unknown> } : {}),
      ...(typeof p.horizon_bars === "number" && p.horizon_bars > 0 ? { horizon_bars: Math.floor(p.horizon_bars) } : {}),
    };
  if (typeof o.benchmark === "string" && o.benchmark) slots.benchmark = o.benchmark;
  if (typeof o.clarify === "string" && o.clarify.trim()) slots.clarify = o.clarify.trim();
  if (!SLOT_KEYS.some((k) => slots[k] !== undefined)) throw Error("SCHEMA_MISMATCH:empty_slots");
  return slots;
}
function mergeParams(defaults: ModeParams, slots: PlanSlots, decision: ModeDecision): ModeParams {
  const params: ModeParams = { ...defaults };
  if (slots.instruments) params.instruments = slots.instruments;
  if (slots.timeframe) params.timeframe = slots.timeframe;
  if (slots.window) params.window = slots.window;
  if (slots.benchmark) params.benchmark = slots.benchmark;
  if (slots.clarify) params.clarify = slots.clarify;
  // 策略条数由模式决定:多策略模式至少两条,不够就沿用代码拆出来的
  if (slots.strategies) {
    const list = slots.strategies.map((s, i) => ({ key: "abc"[i] ?? String(i), label: s.label?.slice(0, 40) || `策略 ${"ABC"[i] ?? i}`, text: s.text }));
    // 参数扫描只要一条基准策略(对照组由 derive_param_variants 派生),模型给多条也只取第一条
    if (decision.mode === "parameter_sweep") params.strategies = list.slice(0, 1).map((s) => ({ ...s, key: "a" }));
    else if (decision.mode !== "validate_multi" || list.length >= 2) params.strategies = list;
  }
  if (slots.pattern && params.pattern)
    params.pattern = {
      ...params.pattern,
      primitive: slots.pattern.primitive,
      params: slots.pattern.params ?? params.pattern.params,
      horizon_bars: slots.pattern.horizon_bars ?? params.pattern.horizon_bars,
    };
  return params;
}
const SLOT_SYSTEM =
  "你是研究计划的参数填充器。计划骨架由代码按研究模式给定，你不能增删步骤，只输出参数 JSON：" +
  '{"instruments":["okx:spot:BTC-USDT"],"timeframe":"1d","window":{"from_ms":0,"to_ms":0},"strategies":[{"label":"策略 A","text":"只写这个策略自己的规则"}],"pattern":{"primitive":"ema_cross","params":{},"horizon_bars":10},"benchmark":"okx:spot:BTC-USDT","clarify":"资产缺失时才填"}。' +
  "只填你有把握的字段，其余省略；不要输出 plan / task_kind / 步骤；不得生成行情数字。" +
  "timeframe 按用户提到的周期（日线=1d、4小时=4h、小时=1h、15分钟=15m），没提就省略；用户说「X 级别触发/定方向、Y 级别进出场」时填较小的执行周期 Y。" +
  "用户明说了区间（某年、某年到某年、最近 N 个月）时 window 按原话，不要自行拉长。" +
  "strategies 只在用户并列多个策略或多组参数时给，每条 text 只写该策略自己的规则，不要把两个入场条件塞进同一条。" +
  "资产无法确定时只填 clarify。";
function slotPrompt(
  question: string,
  decision: ModeDecision,
  defaults: ModeParams,
  resolution: ConceptResolution,
  ctx: ToolContext,
  attempt: number,
): [string, string] {
  return [
    SLOT_SYSTEM,
    JSON.stringify({
      question,
      now: ctx.now(),
      attempt,
      mode: decision.mode,
      mode_reason: decision.reason,
      task_kind: decision.task_kind,
      default_params: defaults,
      concepts: resolution.concepts.map((c) => ({ term: c.term, status: c.status, target: c.target })),
      unmapped: resolution.unmapped.map((c) => c.term),
      recent_messages: ctx.store
        .messages(ctx.store.inquiry(ctx.inquiry_id).session_id)
        .slice(-8)
        .map((m) => ({
          role: m.role,
          inquiry_id: m.inquiry_id,
          blocks: m.blocks.map((b) => (b.kind === "text" ? { kind: b.kind, text: b.text.slice(0, 1500) } : b)).slice(0, 8),
        })),
    }),
  ];
}
/** 概念解析结果落进 checkpoint,报告的「概念覆盖」段与答案的 data_gap 都从这里读。 */
export function recordConcepts(ctx: ToolContext, concepts: LoopConcept[]): void {
  const current = ctx.store.inquiry(ctx.inquiry_id).checkpoint;
  ctx.store.updateInquiry(ctx.inquiry_id, {
    checkpoint: check("Checkpoint", { ...current, concepts }),
  });
}
/**
 * 三段式:概念解析 → 模式判定 → 模板填空。
 * 模型只填参数;若模型仍然给回了完整 plan 数组(旧路径),必须满足该模式的结构不变量才会被采用。
 */
export async function makePlan(
  question: string,
  context: LoopContext,
  registry: ToolRegistry,
  ctx: ToolContext,
): Promise<LoopPlan> {
  const resolution = resolveConcepts(question);
  const decision = detectMode(question, context, resolution);
  const defaults = defaultParams(question, context, ctx.now(), decision, resolution, inferTimeframe(question));
  try {
    recordConcepts(ctx, resolution.concepts as unknown as LoopConcept[]);
  } catch {
    /* 概念只是旁注,写不进去也不该挡住计划 */
  }
  const fallback = normalizePlan(buildModePlan({ question, decision, params: defaults, resolution, source: "fallback_rules" }), question, ctx.now());
  const brain = ctx.budget.brain(ctx.brain, ctx.signal);
  if (brain)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const [system, user] = slotPrompt(question, decision, defaults, resolution, ctx, attempt);
        const response = await brain.complete(system, user, { timeoutMs: 30000 });
        const raw = JSON.parse(response.text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
        // 旧路径:模型直接给完整计划。只有满足模式不变量才采用,否则按槽位处理。
        if (raw && typeof raw === "object" && Array.isArray(raw.plan)) {
          const direct = normalizePlan(check<LoopPlan>("Plan", { ...raw, mode: raw.mode ?? decision.mode, source: "model" }), question, ctx.now());
          const violation = modeViolation(direct, decision);
          if (violation) throw Error("SCHEMA_MISMATCH:" + violation);
          return validatePlan(direct, registry);
        }
        const params = mergeParams(defaults, parseSlots(raw), decision);
        const plan = normalizePlan(buildModePlan({ question, decision, params, resolution, source: "model" }), question, ctx.now());
        return validatePlan(plan, registry);
      } catch (e) {
        if (ctx.signal.aborted) throw Error("CANCELLED");
        if (String(e).includes("BUDGET_EXHAUSTED")) break;
      }
    }
  return validatePlan(fallback, registry);
}
