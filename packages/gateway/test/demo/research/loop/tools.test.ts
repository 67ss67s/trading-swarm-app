import { afterEach, expect, it, vi } from "vitest";
import { openStateDb } from "../../../../src/state-db.js";
import {
  LoopStore,
  DEFAULT_BUDGET,
} from "../../../../src/demo/research/loop/store.js";
import { Budget } from "../../../../src/demo/research/loop/budget.js";
import {
  createToolRegistry,
  materializeChart,
  ToolRegistry,
  result,
  type ToolContext,
} from "../../../../src/demo/research/loop/tools.js";
import { schema } from "../../../../src/demo/research/loop/schema.js";
import {
  fakeMarket,
  fakeAnalyses,
  instrument,
  draft,
  WINDOW,
} from "./fixtures.js";
const clean: (() => void)[] = [];
afterEach(() => {
  clean.splice(0).forEach((f) => f());
  vi.restoreAllMocks();
});
function setup() {
  const db = openStateDb(":memory:");
  clean.push(() => db.close());
  const store = new LoopStore(db.db),
    q = store.createInquiry(store.createSession().id, "BTC", "one").inquiry;
  const ctx: ToolContext = {
    inquiry_id: q.id,
    step_id: "test",
    signal: new AbortController().signal,
    store,
    budget: new Budget(DEFAULT_BUDGET),
    now: Date.now,
    market: fakeMarket(),
    analyses: fakeAnalyses,
  };
  return { ctx, registry: createToolRegistry() };
}
function bind(ctx: ToolContext, ids: string[]) {
  const q = ctx.store.inquiry(ctx.inquiry_id);
  ctx.store.updateInquiry(q.id, {
    checkpoint: { ...q.checkpoint, snapshot_refs: ids },
  });
}
it("validates input/output, canonical cache and concurrent deduplication", async () => {
  const { ctx, registry } = setup();
  expect((await registry.call("get_price_history", {}, ctx)).error_code).toBe(
    "SCHEMA_MISMATCH",
  );
  const input = { instrument: instrument(), window: WINDOW, timeframe: "1h" };
  const [a, b] = await Promise.all([
    registry.call("get_price_history", input, ctx),
    registry.call(
      "get_price_history",
      { timeframe: "1h", window: WINDOW, instrument: instrument() },
      ctx,
    ),
  ]);
  expect(a.snapshot_refs).toHaveLength(1);
  expect(b.warnings).toContain("cache_hit");
  expect(ctx.market.price).toHaveBeenCalledTimes(1);
  expect(ctx.store.putSnapshot(draft("price")).id).toBe(a.snapshot_refs[0]);
});
it("fixed missing liquidation estimates contain no invented rows", async () => {
  const { ctx, registry } = setup(),
    r = await registry.call(
      "get_liquidation_estimates",
      { instrument: instrument(), window: WINDOW },
      ctx,
    );
  expect(r.status).toBe("missing");
  expect(r.error_code).toBe("DATA_MISSING");
  expect(r.snapshot_refs).toEqual([]);
});
it("rejects nonexistent fields and incompatible units, accepts separate axes", async () => {
  const { ctx, registry } = setup(),
    a = ctx.store.putSnapshot(draft("price")),
    b = ctx.store.putSnapshot(draft("open_interest"));
  bind(ctx, [a.id, b.id]);
  const input = {
    kind: "chart",
    title: "test",
    question: "test",
    snapshot_refs: [a.id, b.id],
    spec: { type: "line", x: "ts", y: "missing" },
  };
  expect((await registry.call("render_artifact", input, ctx)).error_code).toBe(
    "SCHEMA_MISMATCH",
  );
  input.spec.y = ["close", "oi_value_usd"] as any;
  expect((await registry.call("render_artifact", input, ctx)).error_code).toBe(
    "UNIT_MISMATCH",
  );
  const r = await registry.call(
    "render_artifact",
    {
      ...input,
      spec: {
        ...input.spec,
        series: [
          { field: "close", axis: "price" },
          { field: "oi_value_usd", axis: "oi" },
        ],
      },
    },
    ctx,
  );
  expect(r.status).toBe("ok");
  expect(ctx.store.artifact(r.artifact_refs[0]!).snapshot_refs).toEqual([
    a.id,
    b.id,
  ]);
});
it("limits repeated errors to two charged attempts", async () => {
  const { ctx, registry } = setup();
  vi.mocked(ctx.market.price).mockRejectedValue(Error("RATE_LIMIT"));
  const r = await registry.call(
    "get_price_history",
    { instrument: instrument(), window: WINDOW, timeframe: "1h" },
    ctx,
  );
  expect(r.error_code).toBe("RATE_LIMIT");
  expect(ctx.market.price).toHaveBeenCalledTimes(2);
  expect(ctx.budget.usage.max_data_calls).toBe(2);
});
it("budget stops before data invocation", async () => {
  const { ctx, registry } = setup();
  ctx.budget = new Budget({ ...DEFAULT_BUDGET, max_data_calls: 0 });
  expect(
    (await registry.call("resolve_instruments", { query: "BTC" }, ctx))
      .error_code,
  ).toBe("BUDGET_EXHAUSTED");
  expect(ctx.market.resolve).not.toHaveBeenCalled();
});
it("times out ignored abort signals and rejects invalid provider output", async () => {
  const { ctx } = setup(),
    registry = new ToolRegistry();
  registry.register({
    name: "test",
    version: "1",
    task_kinds: ["market"],
    asset_classes: ["crypto"],
    access: "read",
    budget_class: "data_call",
    timeout_ms: 5,
    idempotent: true,
    cancellable: true,
    input: schema("Object"),
    output: schema("ResolveOutput"),
    run: async () => new Promise(() => {}),
  });
  expect((await registry.call("test", {}, ctx)).error_code).toBe("TIMEOUT");
  const def = registry.get("test")!;
  def.run = async () => result({ wrong: "shape" });
  expect((await registry.call("test", {}, ctx)).error_code).toBe(
    "SCHEMA_MISMATCH",
  );
});
it("cancellation propagates to provider and late resolution cannot persist snapshots", async () => {
  const { ctx, registry } = setup(),
    ctl = new AbortController();
  ctx.signal = ctl.signal;
  let finish!: (s: any) => void;
  vi.mocked(ctx.market.price).mockImplementation(
    async () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const call = registry.call(
    "get_price_history",
    { instrument: instrument(), window: WINDOW },
    ctx,
  );
  await new Promise((r) => setImmediate(r));
  ctl.abort();
  expect((await call).error_code).toBe("CANCELLED");
  finish(draft("price"));
  await new Promise((r) => setImmediate(r));
  expect(
    ctx.store.db.prepare("SELECT count(*) n FROM research_snapshots").get()!.n,
  ).toBe(0);
});
it("compose removes nonexistent references and model numbers; offline template preserves zero-trade truth", async () => {
  const { ctx, registry } = setup();
  ctx.brain = {
    name: "fake",
    complete: async () => ({
      text: JSON.stringify({
        blocks: [
          { kind: "chart_ref", artifact_id: "made-up" },
          { kind: "text", text: "胜率 100%" },
        ],
      }),
      latency_ms: 0,
      model: "fake",
      input_tokens: 0,
      output_tokens: 0,
    }),
  };
  const r = await registry.call(
    "compose_answer",
    {
      question: "回测",
      steps: [{ result: { closed_trades: 0 } }],
      artifact_ids: [],
      metrics: {},
    },
    ctx,
  );
  expect(r.warnings).toContain("invalid_answer_block_removed");
  expect(JSON.stringify(r.output)).toContain("没有交易");
  expect(JSON.stringify(r.output)).not.toContain("胜率");
});
it("compose survives model timeout at wall-clock limit and returns code template", async () => {
  const { ctx, registry } = setup();
  ctx.budget = new Budget({ ...DEFAULT_BUDGET, wall_clock_ms: 10 });
  ctx.brain = { name: "hung", complete: async () => new Promise(() => {}) };
  const r = await registry.call(
    "compose_answer",
    { question: "BTC", steps: [], artifact_ids: [], metrics: {} },
    ctx,
  );
  expect(r.status).toBe("ok");
  expect(r.warnings).toContain("template_fallback");
  expect(r.output).toMatchObject({ blocks: expect.any(Array) });
});
it("invalid deterministic metric output is rejected before artifact persistence", async () => {
  const { ctx, registry } = setup();
  const s = ctx.store.putSnapshot(draft("price"));
  bind(ctx, [s.id]);
  ctx.analyses = {
    ...fakeAnalyses,
    analyzeLeverage: () => ({
      ...fakeAnalyses.analyzeLeverage(draft("price"), null, null, null),
      price_change: { value: NaN, unit: "fraction", status: "ok" },
    }),
  };
  const r = await registry.call(
    "analyze_leverage",
    { price_snapshot: s.id },
    ctx,
  );
  expect(r.error_code).toBe("SCHEMA_MISMATCH");
  expect(
    ctx.store.artifacts(ctx.store.inquiry(ctx.inquiry_id).session_id),
  ).toHaveLength(0);
});
it("rejects direct snapshot references from another inquiry without selected evidence", async () => {
  const { ctx, registry } = setup();
  const other = ctx.store.createInquiry(
    ctx.store.createSession().id,
    "ETH",
    "other",
  ).inquiry;
  const snap = ctx.store.putSnapshot(draft("price"));
  ctx.store.updateInquiry(other.id, {
    checkpoint: {
      completed_step_keys: [],
      snapshot_refs: [snap.id],
      artifact_refs: [],
    },
  });
  const r = await registry.call(
    "render_artifact",
    {
      kind: "chart",
      title: "wrong evidence",
      question: "BTC",
      snapshot_refs: [snap.id],
      spec: { type: "line", x: "ts", y: "close" },
    },
    ctx,
  );
  expect(r.error_code).toBe("SCHEMA_MISMATCH");
  expect(
    ctx.store.artifacts(ctx.store.inquiry(ctx.inquiry_id).session_id),
  ).toHaveLength(0);
});
it("duplicate series cannot hide incompatible shared axes", async () => {
  const { ctx, registry } = setup(),
    a = ctx.store.putSnapshot(draft("price")),
    b = ctx.store.putSnapshot(draft("open_interest"));
  bind(ctx, [a.id, b.id]);
  const r = await registry.call(
    "render_artifact",
    {
      kind: "chart",
      title: "axis",
      question: "BTC",
      snapshot_refs: [a.id, b.id],
      spec: {
        type: "line",
        x: "ts",
        series: [
          { field: "close", axis: "price" },
          { field: "close", axis: "shared" },
          { field: "oi_value_usd", axis: "shared" },
        ],
      },
    },
    ctx,
  );
  expect(r.error_code).toBe("UNIT_MISMATCH");
});
it("model cannot inject numeric claims through Chinese numerals or data-gap notes", async () => {
  const { ctx, registry } = setup();
  ctx.brain = {
    name: "fake",
    complete: async () => ({
      text: JSON.stringify({
        blocks: [
          { kind: "text", text: "价格上涨百分之百" },
          {
            kind: "data_gap",
            metric: "funding",
            availability: "missing",
            note: "资金费率为999%",
          },
        ],
      }),
      latency_ms: 0,
      model: "fake",
      input_tokens: 0,
      output_tokens: 0,
    }),
  };
  const r = await registry.call(
    "compose_answer",
    { question: "BTC", steps: [], artifact_ids: [], metrics: {} },
    ctx,
  );
  expect(JSON.stringify(r.output)).not.toMatch(/百分之百|999/);
  expect(
    r.warnings.filter((w) => w === "invalid_answer_block_removed"),
  ).toHaveLength(2);
});
it("tool catalog exposes usable properties and referenced definitions", () => {
  const registry = createToolRegistry(),
    input = registry.catalog().find((t) => t.name === "get_price_history")!
      .input as any;
  expect(input.properties.instrument.$ref).toBe("#/$defs/LoopInstrument");
  expect(input.$defs.LoopInstrument.properties.canonical_id).toEqual({
    type: "string",
  });
});

it("chart preserves raw units, independent scales, sparse timestamps and explicit gaps", () => {
  const price = draft("price"), funding = draft("funding");
  price.rows = [{ ts: 20, close: "110" }, { ts: 10, close: "100" }, { ts: 30, close: null }];
  funding.rows = [{ ts: 15, rate: 0.00006 }];
  const chart = materializeChart({ type: "line", x: "ts", series: [{ field: "close", axis: "price" }, { field: "rate", axis: "funding" }] }, [price, funding]) as any;
  expect(chart.layout).toBe("panels");
  expect(chart.series[0]).toMatchObject({ unit: "USDT", transformed: false, points: [[10, 100], [20, 110], [30, null]] });
  expect(chart.series[1]).toMatchObject({ unit: "fraction_per_8h", transformed: false, points: [[15, 0.00006]] });
  expect(price.rows[0]).toEqual({ ts: 20, close: "110" });
});

it("price and notional OI remain separate even when both have USD units", () => {
  const price = draft("price"), oi = draft("open_interest");
  price.units.price = "USD";
  const chart = materializeChart({ type: "line", x: "ts", y: ["close", "oi_value_usd"] }, [price, oi]);
  expect(chart.layout).toBe("panels");
});

it("execution errors are not mislabeled as missing market data or exposed as schema dumps", async () => {
  const { ctx, registry } = setup();
  const failure = result({}, { status: "error", error_code: "SCHEMA_MISMATCH", warnings: ["invalid_contract: must NOT have additional properties"] });
  const r = await registry.call("compose_answer", {
    question: "验证想法", artifact_ids: [], metrics: {},
    steps: [{ tool: "compile_strategy", result: failure }, { tool: "get_liquidation_estimates", result: result({}, { status: "missing", error_code: "DATA_MISSING" }) }],
  }, ctx);
  const blocks = (r.output as any).blocks;
  expect(blocks.filter((b: any) => b.kind === "data_gap")).toHaveLength(1);
  expect(blocks.find((b: any) => b.kind === "data_gap").metric).toBe("get_liquidation_estimates");
  expect(JSON.stringify(blocks)).toContain("未完成的步骤:策略规则检查");
  expect(JSON.stringify(blocks)).not.toContain("must NOT");
  expect(failure.warnings[0]).toContain("must NOT");
});

it("completed backtest facts reach the model and stale execution suggestions cannot reach the user", async () => {
  const { ctx, registry } = setup();
  const complete = vi.fn(async () => ({ text: JSON.stringify({ blocks: [
    { kind: "text", text: "是否开始回测？" },
    { kind: "next_question", text: "确认运行回测" },
    { kind: "strategy_ref", run_id: "real-run" },
  ] }), latency_ms: 0, model: "fake", input_tokens: 0, output_tokens: 0 }));
  ctx.brain = { name: "fake", complete };
  const r = await registry.call("compose_answer", {
    question: "验证想法", artifact_ids: [], metrics: {},
    steps: [{ tool: "run_backtest", result: result({ run_id: "real-run", closed_trades: 0 }) }],
  }, ctx);
  const prompt = JSON.parse((complete.mock.calls[0] as any)[1]);
  expect(prompt.completed_backtest).toBe(true);
  expect(prompt.execution[0]).toEqual({ tool: "run_backtest", status: "ok", run_id: "real-run" });
  expect((r.output as any).blocks).toContainEqual({ kind: "strategy_ref", run_id: "real-run" });
  expect((r.output as any).blocks).toContainEqual({ kind: "next_question", text: "解释这次没有交易的原因" });
  expect(JSON.stringify(r.output)).not.toContain("确认运行");
  expect(JSON.stringify(r.output)).not.toContain("是否开始");
});


it("rejects a model claiming the completed backtest still needs approval", async () => {
  const { ctx, registry } = setup();
  ctx.brain = { name: "fake", complete: async () => ({ text: JSON.stringify({ blocks: [
    { kind: "text", text: "回测还没有执行，请批准。" },
  ] }), latency_ms: 0, model: "fake", input_tokens: 0, output_tokens: 0 }) };
  const r = await registry.call("compose_answer", {
    question: "验证想法", artifact_ids: [], metrics: {},
    steps: [{ tool: "run_backtest", result: result({ run_id: "real-run", closed_trades: 5 }) }],
  }, ctx);
  expect(JSON.stringify(r.output)).not.toContain("回测还没有执行");
  expect((r.output as any).blocks).toContainEqual({ kind: "strategy_ref", run_id: "real-run" });
});
