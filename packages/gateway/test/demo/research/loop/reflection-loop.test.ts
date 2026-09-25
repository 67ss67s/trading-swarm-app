// 复盘 skill 接进研究 loop:诊断工具带原问题与变体数;compose_answer 按问题类型注入 skill 段落,
// 模型复盘文本逐句核数字(对不上的句子剥掉)、执行状态叙述仍归代码;验证回答由代码亮出复盘提示。
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { BacktestReport } from "@trading-swarm/contracts";
import { openStateDb } from "../../../../src/state-db.js";
import { LoopStore, DEFAULT_BUDGET } from "../../../../src/demo/research/loop/store.js";
import { Budget } from "../../../../src/demo/research/loop/budget.js";
import { createToolRegistry, type ToolContext } from "../../../../src/demo/research/loop/tools.js";
import { groundText, numberCorpus } from "../../../../src/demo/research/loop/reflection.js";
import { fakeMarket, fakeAnalyses } from "./fixtures.js";

const CASES: { short: string; question: string; report: BacktestReport }[] = JSON.parse(readFileSync(new URL("./fixtures/reflection-reports.json", import.meta.url), "utf8"));
const clean: (() => void)[] = [];
afterEach(() => clean.splice(0).forEach((f) => f()));

function setup(short: string, followUp: string | null) {
  const c = CASES.find((x) => x.short === short)!;
  const db = openStateDb(":memory:");
  clean.push(() => db.close());
  const store = new LoopStore(db.db), session = store.createSession().id;
  // 原问题放在另一个会话里(同会话同时只能有一个进行中的 inquiry);诊断按报告的 inquiry_id 找回原话
  const origin = followUp ? store.createInquiry(store.createSession().id, c.question, "origin").inquiry : store.createInquiry(session, c.question, "origin").inquiry;
  const report: BacktestReport = { ...c.report, inquiry_id: origin.id, strategy_id: "rs_x", run_ids: ["run_x"] };
  let q = followUp ? store.createInquiry(session, followUp, "follow").inquiry : origin;
  if (followUp) q = store.updateInquiry(q.id, { task_kind: "diagnose" });
  // 同一策略下 3 个不同 IR 哈希的版本(变体数提示)
  const summaries = ["h1", "h2", "h3"].map((h) => ({ summary_json: JSON.stringify({ id: h, strategy_ir_hash: h, strategy_id: "rs_x" }) }));
  const research = { db: { prepare: () => ({ get: (id: string) => (id === report.id ? { report_json: JSON.stringify(report) } : undefined), all: () => summaries }) } };
  const ctx: ToolContext = {
    inquiry_id: q.id, step_id: "t", signal: new AbortController().signal, store, budget: new Budget(DEFAULT_BUDGET), now: Date.now,
    market: fakeMarket(), analyses: fakeAnalyses,
    backtests: { store: research, comparison: () => ({ report, snapshot_refs: [] }) } as never,
  };
  const bind = (ids: string[]) => store.updateInquiry(q.id, { checkpoint: { ...store.inquiry(q.id).checkpoint, artifact_refs: ids } });
  return { ctx, store, report, q, bind, registry: createToolRegistry() };
}
const brainReturning = (blocks: unknown[], seen: { system?: string; user?: string }) => ({
  name: "fake",
  complete: async (system: string, user: string) => { seen.system = system; seen.user = user; return { text: JSON.stringify({ blocks }), latency_ms: 0, model: "fake", input_tokens: 0, output_tokens: 0 }; },
});
const texts = (out: unknown) => ((out as { blocks: { kind: string; text?: string }[] }).blocks).filter((b) => b.kind === "text").map((b) => b.text!);

describe("诊断追问:skill 注入与数字核对", () => {
  it("diagnose_backtest 读报告所属 inquiry 的原话做忠实度比对,并带上同策略变体数", async () => {
    const s = setup("4d23af81", "为什么比持有差这么多");
    const r = await s.registry.call("diagnose_backtest", { run_id: "run_x", arm: "a_rules" }, s.ctx);
    expect(r.status, JSON.stringify(r)).toBe("ok");
    const findings = (r.output as { analysis: { findings: { key: string; text: string }[]; method_version: string } }).analysis;
    expect(findings.method_version).toBe("diagnose/v3");
    expect(findings.findings.find((f) => f.key === "faithful_trail")!.text).toContain("22 笔平仓里 17 笔");
    expect(findings.findings.find((f) => f.key === "variants")!.text).toContain("3 个变体");
  });

  it("compose(diagnose):系统提示带诊断全套段落,模型拿到 findings;有据的句子保留,编的数字整句剥掉,执行叙述整块丢", async () => {
    const s = setup("4d23af81", "为什么比持有差这么多");
    const d = await s.registry.call("diagnose_backtest", { run_id: "run_x", arm: "a_rules" }, s.ctx);
    s.bind(d.artifact_refs);
    const seen: { system?: string; user?: string } = {};
    s.ctx.brain = brainReturning([
      { kind: "text", text: "观察:22 笔平仓里 17 笔由追踪止损离场,用户没有提到追踪止损。这份报告胜率高达 99%。" },
      { kind: "text", text: "假设:可能是编译补上的追踪止损提前离场;验证:按原话去掉追踪止损后同窗口重跑。" },
      { kind: "text", text: "回测尚未执行,请确认后再跑。" },
    ], seen);
    const r = await s.registry.call("compose_answer", { question: "为什么比持有差这么多", steps: [{ tool: "diagnose_backtest", result: d }], artifact_ids: d.artifact_refs, metrics: {} }, s.ctx);
    expect(seen.system).toContain("复盘方法");
    expect(seen.system).toContain("第 4 步 拆来源");
    expect(seen.system).toContain("第 6 步 提出下一步");
    expect(JSON.parse(seen.user!).findings.some((f: { key: string }) => f.key === "faithful_trail")).toBe(true);
    const t = texts(r.output);
    expect(t.some((x) => x.startsWith("观察:22 笔平仓里 17 笔由追踪止损离场"))).toBe(true);
    expect(t.join("\n")).not.toContain("99%");
    expect(t.some((x) => x.startsWith("假设:"))).toBe(true);
    expect(t.join("\n")).not.toContain("尚未执行");
    expect(r.warnings).toEqual(expect.arrayContaining(["ungrounded_sentence_removed", "invalid_answer_block_removed"]));
    // 代码的诊断观察句仍在,且排在模型文本之前
    const all = t.join("\n");
    expect(all.indexOf("诊断(")).toBeLessThan(all.indexOf("观察:"));
  });
});

describe("验证回答:代码复盘提示 + 验证段落", () => {
  it("1% 风险仓位的验证回答里亮出仓位口径与追踪止损;系统提示只带验证相关段;回测已完成时仍允许有据的复盘文本", async () => {
    const s = setup("c7b8d3c1", null);
    const table = s.store.putArtifact({ inquiry_id: s.q.id, kind: "table", title: s.report.title, question: s.q.question, snapshot_refs: [], data_kind: "derived", availability: "available", spec: { type: "table" }, caption: "", content: { kind: "table", columns: [], rows: [], view: "backtest_report", report_id: s.report.id, analysis: { observation: "BTC:净收益 -1.32%,同窗口持有 +1212.94%" }, metrics: {} }, run_id: "run_x" }).id;
    s.bind([table]);
    const seen: { system?: string; user?: string } = {};
    s.ctx.brain = brainReturning([{ kind: "text", text: "观察:持仓期间平均仓位只占权益的 5.4%,和满仓持有不可比。" }], seen);
    const steps = [{ tool: "run_backtest", result: { status: "ok", output: { run_id: "run_x" }, snapshot_refs: [], artifact_refs: [table], warnings: [], latency_ms: 0 } }];
    const r = await s.registry.call("compose_answer", { question: s.q.question, steps, artifact_ids: [table], metrics: {} }, s.ctx);
    expect(r.status, JSON.stringify(r)).toBe("ok");
    const t = texts(r.output).join("\n");
    expect(t).toContain("复盘提示");
    expect(t).toContain("持仓期间平均仓位只占权益的");
    expect(t).toContain("16 笔平仓里 12 笔");
    expect(t).toContain("观察:持仓期间平均仓位只占权益的 5.4%");
    expect(seen.system).toContain("第 2 步 忠实度");
    expect(seen.system).not.toContain("第 6 步 提出下一步");
  });
  it("没有回测报告的回答不注入 skill,文本仍不许带数字", async () => {
    const s = setup("c7b8d3c1", null);
    const seen: { system?: string; user?: string } = {};
    s.ctx.brain = brainReturning([{ kind: "text", text: "资金费 3 期为正" }], seen);
    const r = await s.registry.call("compose_answer", { question: "BTC 资金费", steps: [], artifact_ids: [], metrics: {} }, s.ctx);
    expect(seen.system).not.toContain("复盘方法");
    expect(texts(r.output).join("\n")).not.toContain("3 期");
  });
});

describe("逐句核数字", () => {
  it("数字要在可信文本里出现过;中文数字加量词一律剥掉;保留其余句子", () => {
    const corpus = numberCorpus(["在场时间 12%,持有 +1212.9%", "BTC 日线 20/50 均线"]);
    expect(groundText("在场时间 12%。持有 +1212.9%。", corpus)).toEqual({ text: "在场时间 12%。持有 +1212.9%。", dropped: 0 });
    expect(groundText("20/50 均线在场只有 12%。跑输持有 1200 个百分点。", corpus)).toEqual({ text: "20/50 均线在场只有 12%。", dropped: 1 });
    expect(groundText("三十笔交易里多数亏损。止损偏紧", corpus)).toEqual({ text: "止损偏紧", dropped: 1 });
    expect(groundText("12.0% 与 12% 同值", corpus).dropped).toBe(0);
  });
});

describe("逐句核数字:09-23 GLM 基线里的误剥", () => {
  const corpus = numberCorpus(["ETH 161 个限价计划里 161 个(100%)", "69% 的交易被止损打出"]);
  it("列表序号不是数据;「两个基准」「同一成本」「第一步」不是中文数字", () => {
    expect(groundText("验证:(1) 首先按原话重编,同一窗口、同一成本重测。(2) 再只改一个条件。", corpus).dropped).toBe(0);
    expect(groundText("验证:第一步重编,再对照买入持有和同敞口持有两个基准;这一步排在最前。", corpus).dropped).toBe(0);
    expect(groundText("1. 限价 161 个全在上方。2、止损 69%。", corpus).dropped).toBe(0);
    expect(groundText("八成计划被拦。", corpus).dropped).toBe(1);
  });
  it("段名所在的首句被剥掉时,把「验证:」补回剩下的文本", () => {
    expect(groundText("验证:跑 3 个参数。然后对照持有。", corpus)).toEqual({ text: "验证:然后对照持有。", dropped: 1 });
  });
});
