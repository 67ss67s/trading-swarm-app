/** 研究 loop × 永续(WP-F):回测问题提到永续/做空/杠杆 → instruments 为 perp;「BTC 永续」解析成 okx:perp:BTC-USDT-SWAP;BacktestBridge 永续走全窗口报告、跳过开发段 run。 */
import { afterEach, expect, it } from "vitest";
import { openStateDb } from "../../../../src/state-db.js";
import { LoopStore, DEFAULT_BUDGET } from "../../../../src/demo/research/loop/store.js";
import { ResearchStore } from "../../../../src/demo/research/store.js";
import { ResearchService } from "../../../../src/demo/research/service.js";
import { BacktestBridge, PERP_RUN_PREFIX } from "../../../../src/demo/research/loop/backtest.js";
import { createToolRegistry, type ToolContext } from "../../../../src/demo/research/loop/tools.js";
import { Budget } from "../../../../src/demo/research/loop/budget.js";
import { detectMode, defaultParams, buildModePlan } from "../../../../src/demo/research/loop/modes.js";
import { resolveConcepts } from "../../../../src/demo/research/loop/concepts.js";
import { inferTimeframe } from "../../../../src/demo/research/loop/planner.js";
import { reportForRun } from "../../../../src/demo/research/backtest-report.js";
import { fakeMarket, instrument, NOW } from "./fixtures.js";
import { perpLoader, shortIR } from "../orders/perp-fixture.js";
const clean: (() => void)[] = [];
afterEach(() => clean.splice(0).forEach((f) => f()));
const Q = "BTC 永续 4小时 跌破 20 日低点做空,3 倍杠杆,止损在前高,盈亏比至少 2,回测";
it("回测问题提到永续/做空/杠杆:validate 的 instruments 也是 perp,resolve 步按永续解析", () => {
  for (const q of [Q, "ETH 做空回测:日线跌破布林下轨", "SOL 3 倍杠杆 均线金叉 回测"]) {
    const resolution = resolveConcepts(q), decision = detectMode(q, { instrument_refs: [] }, resolution);
    expect(decision.task_kind).toBe("validate");
    const params = defaultParams(q, { instrument_refs: [] }, NOW, decision, resolution, inferTimeframe(q));
    expect(params.instruments[0]).toMatch(/^okx:perp:[A-Z]+-USDT-SWAP$/);
    const plan = buildModePlan({ question: q, decision, params, resolution, source: "fallback_rules" });
    expect(plan.plan.find((s) => s.tool === "resolve_instruments")!.args).toMatchObject({ market: "perp" });
  }
  const spot = "ETH 日线 回踩 EMA20 限价买入,止损跌破 EMA50,止盈看布林上轨,盈亏比至少 2", r = resolveConcepts(spot), d = detectMode(spot, { instrument_refs: [] }, r);
  expect(defaultParams(spot, { instrument_refs: [] }, NOW, d, r, "1d").instruments).toEqual(["okx:spot:ETH-USDT"]);
});
function ctxOf(question = Q) {
  const db = openStateDb(":memory:"); clean.push(() => db.close());
  const store = new LoopStore(db.db, () => NOW), q = store.createInquiry(store.createSession().id, question, "perp").inquiry;
  const market = fakeMarket();
  const ctx: ToolContext = { inquiry_id: q.id, step_id: q.id + ":backtest", signal: new AbortController().signal, store, budget: new Budget(DEFAULT_BUDGET, () => NOW), now: () => NOW, market };
  return { db, ctx, market };
}
it("resolve_instruments:「BTC 永续」「BTC-USDT-SWAP」→ okx:perp:BTC-USDT-SWAP;标了现货的仍是现货", async () => {
  const { ctx, market } = ctxOf();
  (market.resolve as any).mockImplementation(async (input: { symbols?: string[]; market?: "spot" | "perp" }) => (input.symbols ?? []).flatMap((s) => (input.market ? [input.market] : ["spot", "perp"] as const).map((m) => instrument(s, m))));
  const reg = createToolRegistry();
  for (const s of ["BTC 永续", "BTC-USDT-SWAP", "okx:perp:BTC-USDT-SWAP"]) {
    const r = await reg.call("resolve_instruments", { symbols: [s] }, ctx);
    expect(r.status, JSON.stringify(r)).toBe("ok");
    expect((r.output as any).instruments[0].canonical_id, s).toBe("okx:perp:BTC-USDT-SWAP");
  }
  expect(((await reg.call("resolve_instruments", { symbols: ["BTC 现货"] }, ctx)).output as any).instruments[0].canonical_id).toBe("okx:spot:BTC-USDT");
});
it("BacktestBridge 永续:不建开发段 run,伪 run id 串起全窗口报告;对比/诊断读报告", { timeout: 120000 }, async () => {
  const { db, ctx } = ctxOf(), old = new ResearchStore(db.db), bridge = new BacktestBridge(old, new ResearchService(old));
  bridge.perpLoader = perpLoader();
  const notes: string[] = []; ctx.progress = (x: any) => { if (x.note) notes.push(x.note); };
  const r = await bridge.run({ instrument: instrument("BTC", "perp"), timeframe: "1d", window: { from_ms: Date.UTC(2022, 0, 1), to_ms: Date.UTC(2025, 1, 8) }, ir: shortIR() }, ctx);
  expect(r.status).toBe("ok");
  const out = r.output as any;
  expect(out.run_id).toBe(PERP_RUN_PREFIX + ctx.inquiry_id + ":backtest");
  expect(out.metrics[0]).toMatchObject({ scope: "full_window", market: "perp", leverage: 3, engine_version: "research-orders-v2" });
  expect(out.metrics[0].note).toMatch(/开发段/); expect(notes.join("\n")).toMatch(/开发段 run 只支持现货/);
  expect(out.metrics[0].plan_stats.filled).toBeGreaterThan(0);
  expect(old.db.prepare("SELECT count(*) AS n FROM research_runs").get()).toEqual({ n: 0 });
  const report = reportForRun(old, out.run_id)!; expect(report.execution.market).toBe("perp");
  const cmp = bridge.comparison({ run_id: out.run_id, arm: "a_rules" }); expect(cmp.report!.id).toBe(report.id);
  // 没写订单块的 IR 在永续资产上按永续做多 1 倍补一个
  const { ctx: c2 } = ctxOf("BTC 永续 均线金叉 回测"), long = shortIR(); delete (long as any).order; long.signal = [{ primitive: "ema_cross", params: { fast: 10, slow: 30 } }]; long.exit = [{ primitive: "chandelier_trail", params: { atr_period: 22, multiple: 3 } }, { primitive: "structure_target", params: { htf: "1d", swing_length: 3 } }];
  const r2 = await bridge.run({ instrument: instrument("BTC", "perp"), timeframe: "1d", window: { from_ms: Date.UTC(2022, 0, 1), to_ms: Date.UTC(2025, 1, 8) }, ir: long }, c2);
  expect(r2.status).toBe("ok"); expect((r2.output as any).metrics[0]).toMatchObject({ market: "perp", leverage: 1 });
});
