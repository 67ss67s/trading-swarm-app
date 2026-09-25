import { afterEach, expect, it, vi } from "vitest";
import { openStateDb } from "../../../../src/state-db.js";
import { LoopStore, DEFAULT_BUDGET } from "../../../../src/demo/research/loop/store.js";
import { Budget } from "../../../../src/demo/research/loop/budget.js";
import { createToolRegistry, type ToolContext } from "../../../../src/demo/research/loop/tools.js";
import {
  buildModePlan,
  defaultParams,
  detectMode,
  modeViolation,
  splitStrategies,
} from "../../../../src/demo/research/loop/modes.js";
import { resolveConcepts } from "../../../../src/demo/research/loop/concepts.js";
import {
  fallbackPlan,
  inferTimeframe,
  makePlan,
  validatePlan,
} from "../../../../src/demo/research/loop/planner.js";
import { fakeMarket, NOW } from "./fixtures.js";

const clean: (() => void)[] = [];
afterEach(() => {
  clean.splice(0).forEach((f) => f());
  vi.restoreAllMocks();
});

const registry = createToolRegistry();

/** 代码模板的完整链路:概念解析 → 模式判定 → 默认参数 → 计划。 */
function plan(question: string, context = { instrument_refs: [] as string[] }) {
  const resolution = resolveConcepts(question);
  const decision = detectMode(question, context, resolution);
  const params = defaultParams(question, context, NOW, decision, resolution, inferTimeframe(question));
  return { decision, resolution, plan: buildModePlan({ question, decision, params, resolution, source: "fallback_rules" }) };
}
const tools = (p: { plan: { tool: string }[] }) => p.plan.map((s) => s.tool);
const keys = (p: { plan: { key: string }[] }) => p.plan.map((s) => s.key);

function setup(brain?: ToolContext["brain"], question = "问题") {
  const db = openStateDb(":memory:");
  clean.push(() => db.close());
  const store = new LoopStore(db.db, () => NOW),
    q = store.createInquiry(store.createSession().id, question, "one").inquiry;
  const ctx: ToolContext = {
    inquiry_id: q.id,
    step_id: "test",
    signal: new AbortController().signal,
    store,
    budget: new Budget(DEFAULT_BUDGET, () => NOW),
    brain,
    now: () => NOW,
    market: fakeMarket(),
  };
  return { ctx, store };
}
function brainReturning(text: string) {
  return { name: "mock", complete: vi.fn(async () => ({ text, model: "mock", latency_ms: 0, input_tokens: 0, output_tokens: 0 })) };
}

it("七种研究模式各自判得出来", () => {
  const none = { instrument_refs: [] as string[] };
  expect(detectMode("BTC 杠杆升温了吗", none).mode).toBe("market_leverage");
  expect(detectMode("BTC 与 ETH 谁更强", none).mode).toBe("compare_assets");
  expect(detectMode("BTC 日线 20/50 均线交叉策略扣费后和持有比", none).mode).toBe("validate_single");
  expect(detectMode("BTC 日线均线交叉 + MACD 底背离 两个策略各自回测", none).mode).toBe("validate_multi");
  expect(detectMode("同一个均线交叉策略换参数回测，哪组参数更好", none).mode).toBe("parameter_sweep");
  expect(detectMode("BTC 日线金叉多久出现一次，随后 10 根表现如何", none).mode).toBe("pattern_frequency");
  expect(detectMode("为什么这次回测亏了", { instrument_refs: [], selected_run_id: "r1" }).mode).toBe("diagnose");
  // task_kind 与旧路由保持一致,前端与 validatePlan 都按它判工具
  expect(detectMode("BTC 杠杆", none).task_kind).toBe("market");
  expect(detectMode("BTC 日线金叉多久出现一次", none).task_kind).toBe("market");
});

it("并列策略按显式分隔符拆,同一策略内部的「和」不拆", () => {
  expect(splitStrategies("BTC 日线 20/50 均线交叉 + MACD 底背离").map((s) => s.key)).toEqual(["a", "b"]);
  // 「顶背离和底背离」是一个策略的两条规则,不能拆成两个策略
  expect(splitStrategies("MACD 底背离入场和顶背离离场")).toHaveLength(1);
  // 一侧没有可识别信号时不拆
  expect(splitStrategies("BTC 均线交叉 + 手续费怎么算")).toHaveLength(1);
});

it("validate_multi 由代码保证两组 compile/backtest/compare,而不是靠提示词", () => {
  const p = plan("BTC 日线 20/50 均线交叉 + MACD 底背离，各自扣费后和一直持有相比如何");
  expect(p.decision.mode).toBe("validate_multi");
  expect(keys(p.plan)).toEqual([
    "resolve", "coverage", "price",
    "compile_a", "backtest_a", "compare_a",
    "compile_b", "backtest_b", "compare_b",
    "answer",
  ]);
  // 每个 compile 的 text 只写它自己的规则
  const a = p.plan.plan.find((s) => s.key === "compile_a")!.args as { text: string };
  const b = p.plan.plan.find((s) => s.key === "compile_b")!.args as { text: string };
  expect(a.text).toContain("均线交叉");
  expect(a.text).not.toContain("底背离");
  expect(b.text).toContain("底背离");
  expect(validatePlan(p.plan, registry).plan).toHaveLength(10);
  expect(p.plan.mode).toBe("validate_multi");
});

it("parameter_sweep 只编译一次基准,两组对照参数由代码派生,各自同窗口回测", () => {
  const p = plan("BTC 日线均线交叉策略换参数回测，哪组参数更好");
  expect(p.decision.mode).toBe("parameter_sweep");
  expect(tools(p.plan).filter((t) => t === "compile_strategy")).toHaveLength(1);
  expect(tools(p.plan).filter((t) => t === "derive_param_variants")).toHaveLength(1);
  expect(tools(p.plan).filter((t) => t === "run_backtest")).toHaveLength(3);
  expect((p.plan.plan.find((s) => s.key === "backtest_v1")!.args as { ir: string }).ir).toBe("$variants.variants.1.ir");
  expect(() => validatePlan(p.plan, registry)).not.toThrow();
});

it("pattern_frequency 只统计不下单,带原语与随后 N 根", () => {
  const p = plan("BTC 日线金叉多久出现一次，随后 10 根表现如何");
  expect(p.decision.mode).toBe("pattern_frequency");
  expect(tools(p.plan)).toContain("analyze_pattern_frequency");
  expect(tools(p.plan)).not.toContain("run_backtest");
  expect(tools(p.plan)).not.toContain("compile_strategy");
  const args = p.plan.plan.find((s) => s.tool === "analyze_pattern_frequency")!.args as {
    primitive: string;
    horizon_bars: number;
    params: Record<string, unknown>;
  };
  expect(args).toMatchObject({ primitive: "ema_cross", horizon_bars: 10 });
  expect(args.params).toMatchObject({ fast: 20, slow: 50 });
  expect(p.plan.timeframe).toBe("1d");
  expect(() => validatePlan(p.plan, registry)).not.toThrow();
  // 认不出信号时只能问清楚,不能假装统计
  expect(plan("这个形态多久出现一次").plan.clarify).toBeTruthy();
});

it("未映射的概念只记账,不阻塞计划", () => {
  const q = "BTC 日线 20/50 均线交叉策略，加一个杯柄形态和斐波那契回撤位过滤，扣费后和持有比";
  const p = plan(q);
  expect(p.resolution.unmapped.map((c) => c.concept_id)).toEqual(expect.arrayContaining(["fibonacci"]));
  expect(p.resolution.unmapped.some((c) => c.term.includes("杯柄"))).toBe(true);
  // 计划照排,能映射的部分继续跑
  expect(p.plan.clarify).toBeUndefined();
  expect(tools(p.plan)).toContain("run_backtest");
  expect(() => validatePlan(p.plan, registry)).not.toThrow();
});

it("模式不变量挡住退化的模型计划", () => {
  const multi = plan("BTC 日线均线交叉 + MACD 底背离，各自回测");
  expect(modeViolation(multi.plan, multi.decision)).toBeNull();
  const degraded = { ...multi.plan, plan: multi.plan.plan.filter((s) => !s.key.endsWith("_b")) };
  expect(modeViolation(degraded, multi.decision)).toBe("validate_multi_needs_two_backtests");
  const frequency = plan("BTC 日线金叉多久出现一次");
  expect(modeViolation({ ...frequency.plan, task_kind: "validate" }, frequency.decision)).toBe("task_kind_mismatch");
});

it("市场模板与旧计划的步骤 key 保持一致(前端与恢复都按 key 读)", () => {
  const p = fallbackPlan("BTC 杠杆", undefined, NOW);
  expect(keys(p)).toEqual([
    "resolve", "coverage", "price", "funding", "oi", "liquidations", "estimates", "analyze", "render", "answer",
  ]);
  expect(p.source).toBe("fallback_rules");
  expect(p.mode).toBe("market_leverage");
  expect(fallbackPlan("BTC 策略回测", undefined, NOW).mode).toBe("validate_single");
});

it("makePlan 只让模型填参数:模型漏掉第二个策略也照样排两组", async () => {
  const question = "BTC 日线 20/50 均线交叉 + MACD 底背离，各自扣费后和一直持有相比如何";
  const brain = brainReturning(JSON.stringify({ timeframe: "1d", strategies: [{ label: "只给了一个", text: "20/50 均线交叉" }] }));
  const { ctx, store } = setup(brain, question);
  const p = await makePlan(question, { instrument_refs: [] }, registry, ctx);
  expect(p.source).toBe("model");
  expect(p.mode).toBe("validate_multi");
  expect(tools(p).filter((t) => t === "run_backtest")).toHaveLength(2);
  expect(brain.complete).toHaveBeenCalledTimes(1);
  // 模型给的是参数不是步骤:提示词里不再塞工具目录
  expect(String(brain.complete.mock.calls[0]![0])).toContain("参数填充器");
  // 概念解析结果落进 checkpoint,报告与答案从这里读
  const concepts = store.inquiry(ctx.inquiry_id).checkpoint.concepts ?? [];
  expect(concepts.map((c) => c.concept_id)).toEqual(expect.arrayContaining(["ema_cross", "bullish_divergence"]));
});

it("模型给空槽位时重试两次后退回规则模板", async () => {
  const brain = brainReturning("{}");
  const { ctx } = setup(brain, "BTC 杠杆");
  const p = await makePlan("BTC 杠杆", { instrument_refs: [] }, registry, ctx);
  expect(p.source).toBe("fallback_rules");
  expect(brain.complete).toHaveBeenCalledTimes(2);
});

it("模型仍然给整份计划时,只有满足模式不变量才采用", async () => {
  const question = "BTC 日线均线交叉 + MACD 底背离，各自回测";
  const single = plan("BTC 日线均线交叉策略回测").plan;
  const { ctx } = setup(brainReturning(JSON.stringify(single)), question);
  // 单组回测不满足 validate_multi,退回代码模板
  const p = await makePlan(question, { instrument_refs: [] }, registry, ctx);
  expect(p.source).toBe("fallback_rules");
  expect(tools(p).filter((t) => t === "run_backtest")).toHaveLength(2);
});

it("2026-09-22 验证模板:未映射的英文指标先排 acquire_concept,编译步等它并带 acquired 引用", async () => {
  const { detectMode, buildModePlan, defaultParams } = await import("../../../../src/demo/research/loop/modes.js");
  const { resolveConcepts, extractConcepts } = await import("../../../../src/demo/research/loop/concepts.js");
  const q = "验证 BTC 现货 4小时 Coppock 曲线由负转正做多的策略,扣除成本后比持有如何?";
  const terms = extractConcepts(q).map((c) => c.term);
  expect(terms.some((t) => /coppock/i.test(t))).toBe(true);
  const resolution = resolveConcepts(q);
  expect(resolution.unmapped.some((c) => /coppock/i.test(c.term))).toBe(true);
  const decision = detectMode(q, { instrument_refs: [] }, resolution);
  expect(decision.mode).toBe("validate_single");
  const params = defaultParams(q, { instrument_refs: [] }, Date.UTC(2026, 8, 22), decision, resolution, "4h");
  const plan = buildModePlan({ question: q, decision, params, resolution, source: "fallback_rules" });
  const acquire = plan.plan.find((s) => s.tool === "acquire_concept");
  expect(acquire).toBeDefined();
  const compile = plan.plan.find((s) => s.tool === "compile_strategy")!;
  expect(compile.depends_on).toContain(acquire!.key);
  expect(compile.args.acquired).toEqual(["$" + acquire!.key]);
});

it("2026-09-22 「形态出现后随后 N 根收益分布」走 pattern_frequency,而不是市场观察", async () => {
  const { detectMode } = await import("../../../../src/demo/research/loop/modes.js");
  const { resolveConcepts } = await import("../../../../src/demo/research/loop/concepts.js");
  const q = "BTC 日线看涨吞没形态出现后,随后 5 根 K 线的收益分布是什么样?";
  const d = detectMode(q, { instrument_refs: [] }, resolveConcepts(q));
  expect(d.mode).toBe("pattern_frequency");
});

it("选中回测时「复盘一下 / 可信吗 / 怎么改」进诊断模式", () => {
  for (const q of ["复盘一下这个回测", "这个结果可信吗", "这个策略怎么改"])
    expect(detectMode(q, { instrument_refs: [], selected_run_id: "run_x" }).mode).toBe("diagnose");
});
