import { afterEach, expect, it, vi } from "vitest";
import { openStateDb } from "../../../../src/state-db.js";
import { LoopStore, DEFAULT_BUDGET } from "../../../../src/demo/research/loop/store.js";
import { Budget } from "../../../../src/demo/research/loop/budget.js";
import { createToolRegistry, type ToolContext } from "../../../../src/demo/research/loop/tools.js";
import {
  acquireConcept,
  acquiredToConcept,
  brainKnowledgeSource,
  extractConcepts,
  lexiconKnowledgeSource,
  resolveConcepts,
  resolveDataConcept,
  setDataConceptResolver,
  webKnowledgeSource,
} from "../../../../src/demo/research/loop/concepts.js";
import { LEXICON, matchLexicon } from "../../../../src/demo/research/loop/lexicon.js";
import { fakeMarket, NOW } from "./fixtures.js";

const clean: (() => void)[] = [];
afterEach(() => {
  clean.splice(0).forEach((f) => f());
  setDataConceptResolver(null);
  vi.restoreAllMocks();
});

function setup(brain?: ToolContext["brain"]) {
  const db = openStateDb(":memory:");
  clean.push(() => db.close());
  const store = new LoopStore(db.db, () => NOW),
    q = store.createInquiry(store.createSession().id, "概念", "one").inquiry;
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
  return { ctx, store, registry: createToolRegistry() };
}

function brainReturning(text: string): ToolContext["brain"] {
  return {
    name: "mock",
    complete: vi.fn(async () => ({ text, model: "mock", latency_ms: 0, input_tokens: 0, output_tokens: 0 })),
  };
}

it("词典是可维护的纯数据:至少 60 条,别名不重复,指向的原语必须真的存在", async () => {
  expect(LEXICON.length).toBeGreaterThanOrEqual(60);
  const { listPrimitives } = await import("../../../../src/demo/research/primitives/index.js");
  const names = new Set(listPrimitives().items.map((p) => p.name));
  for (const entry of LEXICON) {
    expect(entry.terms.length, entry.id).toBeGreaterThan(0);
    expect(entry.note.length, entry.id).toBeGreaterThan(0);
    if (entry.kind === "primitive") expect(names.has(entry.target!), entry.id + "→" + entry.target).toBe(true);
    if (entry.kind === "unsupported") expect(entry.target, entry.id).toBe(null);
  }
  // 长词优先:顶背离不能被背离吃掉
  expect(matchLexicon("顶背离").map((m) => m.entry.id)).toEqual(["bearish_divergence"]);
  // ASCII 词要求单词边界
  expect(matchLexicon("rsix 不是 rsi 指标").map((m) => m.entry.id)).toContain("rsi");
});

it("中文问题抽概念:指标、形态、数据指标、比较方式、周期、资产各归各位", () => {
  const q = "BTC 日线 20/50 均线交叉 + MACD 顶背离，扣费后和一直持有相比如何";
  const terms = extractConcepts(q).map((c) => c.term);
  expect(terms).toEqual(expect.arrayContaining(["日线", "均线交叉", "MACD", "顶背离", "一直持有", "BTC"]));
  const r = resolveConcepts(q);
  const byId = Object.fromEntries(r.concepts.map((c) => [c.concept_id, c]));
  expect(byId.ema_cross).toMatchObject({ status: "mapped", source: "primitive_registry", target: "ema_cross", category: "indicator" });
  expect(byId.bearish_divergence).toMatchObject({ status: "mapped", target: "macd_divergence_exit" });
  expect(byId.tf_1d).toMatchObject({ status: "mapped", category: "timeframe", target: "1d" });
  expect(byId.buy_and_hold).toMatchObject({ status: "mapped", category: "comparison" });
  expect(byId.BTC).toMatchObject({ status: "mapped", category: "asset" });
  expect(r.unmapped).toHaveLength(0);
});

it("近似映射标 proxy，词典里没有实现的标 unmapped 并说明原因", () => {
  const r = resolveConcepts("死叉离场，顺便看看布林带和订单块，再画条趋势线，再加一个杯柄形态");
  const byId = Object.fromEntries(r.concepts.map((c) => [c.concept_id, c]));
  expect(byId.ema_death_cross).toMatchObject({ status: "proxy", target: "trend_break" });
  expect(byId.ema_death_cross!.note).toContain("近似");
  expect(byId.order_blocks).toMatchObject({ status: "mapped", target: "order_blocks" });
  // 指标表落地后布林带是「通用穿越原语 + bbands 行」,不再是未支持
  expect(byId.bollinger).toMatchObject({ status: "mapped", target: "indicator_cross" });
  expect(byId.trendline).toMatchObject({ status: "unmapped", target: null });
  expect(byId.trendline!.note).toContain("画线");
  // 词典完全不认识的词也要被抓出来,而不是静默丢掉
  const unknown = r.unmapped.find((c) => c.term.includes("杯柄"));
  expect(unknown).toBeTruthy();
  expect(unknown!.source).toBe("none");
});

it("数据概念走 adapter 钩子:覆盖不全算代理、缺失算未映射,钩子可替换", () => {
  expect(resolveDataConcept("liquidation_estimates")).toMatchObject({ availability: "missing" });
  const before = resolveConcepts("清算热图怎么看").concepts[0];
  expect(before).toMatchObject({ concept_id: "liquidation_heatmap", status: "unmapped" });
  expect(resolveConcepts("最近的强平多不多").concepts[0]).toMatchObject({ concept_id: "liquidations", status: "proxy" });
  // data/catalog.ts 就绪后按这个签名接线
  setDataConceptResolver((metric) => ({ metric, availability: "available", note: "catalog v1" }));
  expect(resolveConcepts("清算热图怎么看").concepts[0]).toMatchObject({ status: "mapped", note: "catalog v1" });
});

it("acquire_concept 先走词典:能落到原语的直接 acquired,词典标未支持的仍是 unmapped 但带原因", async () => {
  const { ctx } = setup();
  const hit = await acquireConcept("金叉", { now: () => NOW });
  expect(hit.result.provenance.source).toBe("lexicon");
  expect(hit.result.implementation).toMatchObject({ kind: "primitive", target: "ema_cross" });
  expect(acquiredToConcept(hit.result, "indicator")).toMatchObject({ status: "acquired", target: "ema_cross" });
  const row = await acquireConcept("布林带", { now: () => NOW });
  expect(row.result.implementation).toMatchObject({ kind: "primitive", target: "indicator_cross" });
  // 词典明确标成「没有实现」的概念,获取后仍然是 unmapped,但带上了定义与原因
  const none = await acquireConcept("趋势线", { now: () => NOW });
  expect(none.result.implementation.kind).toBe("unsupported");
  expect(acquiredToConcept(none.result).status).toBe("unmapped");
  // 词典命中就短路,不再去问后面的源
  expect(hit.tried).toEqual(["lexicon"]);
  expect(webKnowledgeSource.available({ now: () => NOW })).toBe(false);
  expect(ctx.inquiry_id).toBeTruthy();
});

it("词典没有时由模型兜底,模型编的原语名会被降级而不是假装能跑", async () => {
  const good = brainReturning(
    JSON.stringify({
      definition: "价格创新高后回调形成柄部，突破柄部高点触发。",
      implementation: { kind: "primitive", target: "donchian_breakout", params: { lookback: 20, basis: "close" }, note: "用通道突破近似柄部突破" },
    }),
  );
  const ok = await acquireConcept("杯柄形态", { brain: good, now: () => NOW });
  expect(ok.result.provenance.source).toBe("brain");
  expect(ok.tried).toEqual(["lexicon", "brain"]);
  expect(acquiredToConcept(ok.result)).toMatchObject({ status: "acquired", target: "donchian_breakout" });

  const hallucinating = brainReturning(
    JSON.stringify({ definition: "三根 K 线的未成交区间。", implementation: { kind: "primitive", target: "fvg_zone", note: "" } }),
  );
  const bad = await acquireConcept("公允价值缺口 X", { brain: hallucinating, now: () => NOW });
  expect(bad.result.implementation).toMatchObject({ kind: "unsupported", target: null });
  expect(bad.result.implementation.note).toContain("不在目录里");
  expect(acquiredToConcept(bad.result).status).toBe("unmapped");

  // 模型也给不出定义时仍返回结构化结果,不抛错
  const empty = await acquireConcept("某个生造的词", { brain: brainReturning("{}"), now: () => NOW });
  expect(empty.result.implementation.kind).toBe("unsupported");
  expect(empty.result.definition).toBe("");
});

it("模型不可用时只剩词典,brain 源被标成 offline", async () => {
  expect(brainKnowledgeSource.available({ now: () => NOW })).toBe(false);
  expect(lexiconKnowledgeSource.available({ now: () => NOW })).toBe(true);
  const r = await acquireConcept("生造的形态", { now: () => NOW });
  expect(r.tried).toEqual(["lexicon"]);
  expect(r.offline).toEqual(["brain", "web"]);
});

it("acquire_concept 工具把结果写进 checkpoint，供报告与答案读取", async () => {
  const { ctx, store, registry } = setup(
    brainReturning(JSON.stringify({ definition: "d", implementation: { kind: "pine", target: null, note: "需要脚本" } })),
  );
  const first = await registry.call("acquire_concept", { concept: "顶背离", category: "indicator" }, ctx);
  expect(first.status).toBe("ok");
  expect((first.output as any).implementation.target).toBe("macd_divergence_exit");
  const second = await registry.call("acquire_concept", { concept: "缠论三买", category: "pattern" }, ctx);
  expect((second.output as any).implementation.kind).toBe("pine");
  const concepts = store.inquiry(ctx.inquiry_id).checkpoint.concepts ?? [];
  expect(concepts.map((c) => c.concept_id)).toEqual(["顶背离", "缠论三买"]);
  expect(concepts[0]).toMatchObject({ status: "acquired", source: "acquired" });
  expect(concepts[1]).toMatchObject({ status: "unmapped" });
  expect(concepts[1]!.note).toContain("Pine");
});

it("acquiredToConcept:pine 候选带 script_id 才算 acquired,没有就还是 unmapped", () => {
    const base = { concept: "三重顶", definition: "三个等高 pivot high", provenance: { source: "brain", at: 0 } } as any;
    const pending = acquiredToConcept({ ...base, implementation: { kind: "pine", target: null, params: null, expression: null, note: "" } });
    expect(pending.status).toBe("unmapped");
    const done = acquiredToConcept({ ...base, implementation: { kind: "pine", target: "ps_1", params: { script_id: "ps_1", output: "triple_top" }, expression: null, note: "" } });
    expect(done.status).toBe("acquired"); expect(done.target).toBe("ps_1"); expect(done.note).toContain("pine_series");
});
