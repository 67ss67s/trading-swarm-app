import { afterEach, expect, it, vi } from "vitest";
import { openStateDb } from "../../../../src/state-db.js";
import { LoopStore } from "../../../../src/demo/research/loop/store.js";
import { LoopService } from "../../../../src/demo/research/loop/service.js";
import { ResearchStore } from "../../../../src/demo/research/store.js";
import { ResearchService } from "../../../../src/demo/research/service.js";
import { BacktestBridge } from "../../../../src/demo/research/loop/backtest.js";
import { policyToIR } from "../../../../src/demo/research/strategy.js";
import { reportForRun } from "../../../../src/demo/research/backtest-report.js";
import { fixture, params } from "../fixtures.js";
import { fakeAnalyses, fakeMarket, draft, instrument } from "./fixtures.js";
const clean: (() => void)[] = [];
afterEach(() => clean.splice(0).forEach((f) => f()));
it("validate creates dataset, preregistered study, real A-only run, and same-window comparison; zero trades are explicit", async () => {
  const db = openStateDb(":memory:");
  clean.push(() => db.close());
  const store = new LoopStore(db.db),
    old = new ResearchStore(db.db),
    bridge = new BacktestBridge(old, new ResearchService(old));
  const market = fakeMarket(),
    bars = fixture().bars;
  const window = {
    from_ms: bars[0]!.open_time,
    to_ms: bars.at(-1)!.close_time,
  };
  vi.mocked(market.price).mockImplementation(async (i, _, w) => ({
    ...draft("price", i, w),
    rows: bars.map((b) => ({ ...b, ts: b.close_time })),
    actual_window: window,
    as_of: window.to_ms,
    checksum: "backtest-price",
  }));
  const policy = { ...params().policy!, volume_multiple: 5 },
    ir = policyToIR(policy);
  let plans = 0;
  const brain = {
    name: "fake",
    complete: async (system: string) => {
      if (system.includes("研究规划器")) {
        plans++;
        throw Error("offline planner");
      }
      return {
        text: JSON.stringify(
          system.includes("StrategyIR")
            ? { ir, unmapped: [] }
            : { blocks: [{ kind: "text", text: "胜率很高" }] },
        ),
        model: "fake",
        latency_ms: 0,
        input_tokens: 0,
        output_tokens: 0,
      };
    },
  };
  const svc = new LoopService(store, {
      market,
      brain,
      analyses: fakeAnalyses,
      backtests: bridge,
    }),
    session = store.createSession();
  const q = svc.ask(session.id, "BTC 现货策略回测扣费比持有", "validate-one", {
    selected_window: window,
  });
  await svc.wait(q.inquiry.id);
  const final = svc.inquiry(q.inquiry.id);
  expect(
    final.status,
    JSON.stringify(
      final.steps.map((s) => ({
        tool: s.tool,
        status: s.status,
        output: s.output_summary.result,
      })),
    ),
  ).toBe("completed");
  const runStep = final.steps.find((s) => s.tool === "run_backtest")!,
    runId = runStep.output_summary.run_id as string;
  expect(runId).toBeTruthy();
  const run = old.get(runId)!;
  expect(run.status).toBe("completed");
  expect(run.manifest.request.idempotency_key).toBe(q.inquiry.id + ":backtest");
  expect(run.result?.arms[0]?.metrics.closed_trades).toBe(0);
  expect(old.study(run.manifest.request.study_id)).not.toBeNull();
  const answer = store.messages(session.id).at(-1);
  expect(JSON.stringify(answer?.blocks)).toContain("没有交易");
  expect(JSON.stringify(answer?.blocks)).not.toContain("胜率");
  // 2026-09-23 全窗口:持有对比改读全窗口报告里的同窗口基准(不再按开发段现算),开发段 run 只留给修订链
  const report = reportForRun(old, runId)!;
  expect(report.run_ids).toContain(runId);
  expect(report.engine_version).toBe("research-spot-ir-v5"); // 09-23 结构口径:新 run 的 order_gate 带 min_stop_atr → v5
  expect(report.assets.map((a) => a.key)).toEqual(["BTCUSDT", "ETHUSDT", "BTC+ETH"]);
  expect(vi.mocked(fakeAnalyses.compareBuyAndHold)).not.toHaveBeenCalled();
  const compare = final.steps.find((s) => s.tool === "compare_buy_and_hold")!;
  const artifact = store.artifact((compare.output_summary.result as { artifact_refs: string[] }).artifact_refs[0]!);
  expect((artifact.content as { report_id?: string }).report_id).toBe(report.id);
  expect((runStep.output_summary.result as { output: { metrics: { report_id: string }[] } }).output.metrics[0]!.report_id).toBe(report.id);
  expect(
    svc.ask(session.id, q.inquiry.question, "validate-one").inquiry.id,
  ).toBe(q.inquiry.id);
  expect(old.list()).toHaveLength(1);
});
