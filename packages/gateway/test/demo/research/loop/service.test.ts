import { afterEach, expect, it, vi } from "vitest";
import { openStateDb } from "../../../../src/state-db.js";
import {
  LoopStore,
  DEFAULT_BUDGET,
} from "../../../../src/demo/research/loop/store.js";
import {
  LoopService,
  type LoopOptions,
} from "../../../../src/demo/research/loop/service.js";
import {
  fallbackPlan,
  validatePlan,
} from "../../../../src/demo/research/loop/planner.js";
import { createToolRegistry } from "../../../../src/demo/research/loop/tools.js";
import { fakeMarket, fakeAnalyses, NOW } from "./fixtures.js";
const clean: (() => void)[] = [];
afterEach(() => {
  clean.splice(0).forEach((f) => f());
  vi.clearAllMocks();
});
function setup(options: Partial<LoopOptions> = {}) {
  const db = openStateDb(":memory:");
  clean.push(() => db.close());
  const store = new LoopStore(db.db, () => NOW),
    market = fakeMarket(),
    emit = vi.fn();
  const svc = new LoopService(store, {
      market,
      analyses: fakeAnalyses,
      emit,
      ...options,
    }),
    session = store.createSession();
  return { store, svc, session, market, emit };
}
it("market question completes through four data tools, snapshots, analysis, charts, answer and monotonic events", async () => {
  const { store, svc, session, emit } = setup();
  const { inquiry } = svc.ask(
    session.id,
    "BTC 这轮上涨有没有伴随杠杆升温?",
    "one",
  );
  await svc.wait(inquiry.id);
  const q = svc.inquiry(inquiry.id);
  expect(q.status, JSON.stringify(q)).toBe("completed");
  expect(
    q.plan.plan.filter((s) =>
      /^get_(price|funding|open_interest|liquidations)/.test(s.tool),
    ),
  ).toHaveLength(4);
  expect(q.checkpoint.snapshot_refs).toHaveLength(4);
  expect(q.checkpoint.artifact_refs.length).toBeGreaterThanOrEqual(2);
  expect(q.steps.every((s) => s.status === "succeeded")).toBe(true);
  const events = store.events(q.id);
  expect(events.map((e) => e.seq)).toEqual(
    [...new Set(events.map((e) => e.seq))].sort((a, b) => a - b),
  );
  expect(events[0]?.event).toBe("inquiry.queued");
  expect(events.at(-1)?.event).toBe("inquiry.completed");
  expect(events.filter((e) => e.event === "step.started")).toHaveLength(
    q.steps.length,
  );
  expect(events.filter((e) => e.event === "step.completed")).toHaveLength(
    q.steps.length,
  );
  expect(emit).toHaveBeenCalledTimes(events.length);
  expect(JSON.stringify(store.messages(session.id).at(-1)?.blocks)).toContain(
    "chart_ref",
  );
  expect(JSON.stringify(store.messages(session.id).at(-1)?.blocks)).toContain(
    "估计数据源尚未接入",
  );
});
it("follow-up pins the prior snapshots and refreshing session is read-only", async () => {
  const { svc, session, market } = setup();
  const a = svc.ask(session.id, "BTC 杠杆", "one");
  await svc.wait(a.inquiry.id);
  const before = svc.session(session.id),
    b = svc.ask(session.id, "这段 OI 变化怎么解释", "two");
  await svc.wait(b.inquiry.id);
  expect(svc.inquiry(b.inquiry.id).status).toBe("completed");
  expect(market.price).toHaveBeenCalledTimes(1);
  expect(market.funding).toHaveBeenCalledTimes(1);
  expect(market.openInterest).toHaveBeenCalledTimes(1);
  expect(market.liquidations).toHaveBeenCalledTimes(1);
  expect(svc.inquiry(b.inquiry.id).checkpoint.snapshot_refs.sort()).toEqual(
    before.inquiries[0]!.checkpoint.snapshot_refs.sort(),
  );
  expect(
    svc.inquiry(b.inquiry.id).steps.find((s) => s.tool === "get_open_interest")
      ?.output_summary.result,
  ).toMatchObject({ warnings: expect.arrayContaining(["cache_hit"]) });
  expect(svc.session(session.id)).toEqual(svc.session(session.id));
});
it("spot funding yields not_applicable blocks, never fabricated zeros", async () => {
  const { svc, session } = setup();
  const q = svc.ask(session.id, "BTC 现货资金费", "one");
  await svc.wait(q.inquiry.id);
  expect(svc.inquiry(q.inquiry.id).status).toBe("completed");
  const restored = svc.session(session.id);
  expect(restored.messages.at(-1)?.blocks).toContainEqual(
    expect.objectContaining({
      kind: "data_gap",
      availability: "not_applicable",
    }),
  );
  const funding = restored.inquiries[0]!.steps.find(
    (s) => s.tool === "get_funding_history",
  );
  expect(funding?.output_summary.result).toMatchObject({
    status: "not_applicable",
  });
});
it("budget exhaustion after a chart preserves its readable artifact and composes an incomplete answer", async () => {
  const registry = createToolRegistry(),
    p = fallbackPlan("BTC 杠杆", undefined, NOW);
  p.plan = p.plan.filter((s) =>
    ["resolve", "price", "render", "funding", "answer"].includes(s.key),
  );
  p.plan.find((s) => s.key === "price")!.depends_on = ["resolve"];
  p.plan.find((s) => s.key === "funding")!.depends_on = ["resolve", "render"];
  p.plan.sort(
    (a, b) =>
      ["resolve", "price", "render", "funding", "answer"].indexOf(a.key) -
      ["resolve", "price", "render", "funding", "answer"].indexOf(b.key),
  );
  p.plan.at(-1)!.depends_on = ["resolve", "price", "render", "funding"];
  const brain = {
    name: "plan",
    complete: async () => ({
      text: JSON.stringify(p),
      latency_ms: 0,
      model: "plan",
      input_tokens: 0,
      output_tokens: 0,
    }),
  };
  const { svc, store, session } = setup({
    registry,
    brain,
    budget: { ...DEFAULT_BUDGET, max_data_calls: 2 },
  });
  const q = svc.ask(session.id, "BTC 杠杆", "one");
  await svc.wait(q.inquiry.id);
  const restored = svc.session(session.id);
  expect(restored.inquiries[0]?.status).toBe("incomplete");
  expect(restored.artifacts).toHaveLength(2);
  expect(restored.artifacts.find((a) => a.kind === "markdown")?.availability).toBe("partial");
  expect(store.artifact(restored.artifacts[0]!.id).kind).toBe("chart");
  expect(restored.messages.at(-1)?.blocks).toContainEqual(
    expect.objectContaining({ kind: "text", text: expect.stringContaining("本轮预算已用完") }),
  );
  expect(restored.messages.at(-1)?.blocks.some((b) => b.kind === "data_gap")).toBe(false);
});
it("cancels in flight, retains completed steps and ignores late data", async () => {
  const { svc, session, market } = setup();
  let release!: (x: any) => void;
  vi.mocked(market.openInterest).mockImplementation(
    async () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const q = svc.ask(session.id, "BTC 杠杆", "one");
  for (
    let i = 0;
    i < 100 &&
    !svc
      .inquiry(q.inquiry.id)
      .steps.some(
        (s) => s.tool === "get_price_history" && s.status === "succeeded",
      );
    i++
  )
    await new Promise((r) => setImmediate(r));
  expect(svc.cancel(q.inquiry.id)).toEqual({ status: "cancelling" });
  await svc.wait(q.inquiry.id);
  expect(svc.inquiry(q.inquiry.id).status).toBe("cancelled");
  expect(
    svc.inquiry(q.inquiry.id).steps.find((s) => s.tool === "get_price_history")
      ?.status,
  ).toBe("succeeded");
  release?.(null);
});
it("duplicate keys never spawn another inquiry or rerun and session busy returns conflict", async () => {
  const { svc, session } = setup();
  const a = svc.ask(session.id, "BTC 杠杆", "one"),
    b = svc.ask(session.id, "BTC 杠杆", "one");
  expect(a.inquiry.id).toBe(b.inquiry.id);
  expect(() => svc.ask(session.id, "ETH", "two")).toThrow("busy");
  await svc.wait(a.inquiry.id);
  expect(svc.ask(session.id, "BTC 杠杆", "one").inquiry.id).toBe(a.inquiry.id);
  expect(svc.session(session.id).inquiries).toHaveLength(1);
});
it("brain unavailable uses fallback rules and template while completing research", async () => {
  const { svc, session } = setup({
    brain: {
      name: "offline",
      complete: async () => {
        throw Error("offline");
      },
    },
  });
  const q = svc.ask(session.id, "BTC 杠杆", "one");
  await svc.wait(q.inquiry.id);
  expect(svc.inquiry(q.inquiry.id)).toMatchObject({
    status: "completed",
    plan: { source: "fallback_rules" },
  });
  expect(
    svc.inquiry(q.inquiry.id).steps.at(-1)?.output_summary.result,
  ).toMatchObject({ warnings: expect.arrayContaining(["template_fallback"]) });
});
it("clarification pauses before data, then answer resumes same inquiry", async () => {
  const { svc, session, market } = setup();
  const q = svc.ask(session.id, "看看资金费", "one");
  await svc.wait(q.inquiry.id);
  expect(svc.inquiry(q.inquiry.id).status).toBe("awaiting_input");
  expect(market.resolve).not.toHaveBeenCalled();
  svc.answer(q.inquiry.id, "BTC 永续");
  await svc.wait(q.inquiry.id);
  expect(svc.inquiry(q.inquiry.id).status).toBe("completed");
  expect(svc.session(session.id).inquiries).toHaveLength(1);
});
it("restart marks queued and awaiting_input incomplete without relaunching", async () => {
  const { store, svc, session, market } = setup();
  const q = svc.ask(session.id, "看看资金费", "one");
  await svc.wait(q.inquiry.id);
  new LoopService(store, { market, analyses: fakeAnalyses });
  expect(store.inquiry(q.inquiry.id)).toMatchObject({
    status: "incomplete",
    error_code: "interrupted",
  });
  expect(market.resolve).not.toHaveBeenCalled();
});
it("validates dependency order, tools and task boundaries", () => {
  const r = createToolRegistry();
  for (const edit of [
    (p: any) => (p.plan[0].depends_on = ["answer"]),
    (p: any) => (p.plan[0].tool = "run_backtest"),
    (p: any) => (p.plan[0].tool = "invented"),
    (p: any) => (p.plan[1].key = p.plan[0].key),
  ]) {
    const p = fallbackPlan("BTC 杠杆", undefined, NOW);
    edit(p);
    expect(() => validatePlan(p, r)).toThrow("SCHEMA_MISMATCH");
  }
  expect(fallbackPlan("BTC 与 ETH 谁更强").task_kind).toBe("compare");
  expect(fallbackPlan("BTC 策略回测").task_kind).toBe("validate");
  expect(
    fallbackPlan("为什么亏", { instrument_refs: [], selected_run_id: "a" })
      .task_kind,
  ).toBe("diagnose");
});
it("failed step skips descendants, independent render and final answer still run", async () => {
  const { svc, session, market } = setup();
  vi.mocked(market.funding).mockRejectedValue(Error("SCHEMA_MISMATCH"));
  const q = svc.ask(session.id, "BTC 杠杆", "one");
  await svc.wait(q.inquiry.id);
  const final = svc.inquiry(q.inquiry.id);
  expect(final.status).toBe("incomplete");
  expect(final.steps.find((s) => s.tool === "analyze_leverage")?.status).toBe(
    "skipped",
  );
  expect(final.steps.find((s) => s.tool === "render_artifact")?.status).toBe(
    "succeeded",
  );
  expect(final.steps.at(-1)?.status).toBe("succeeded");
  expect(svc.session(session.id).artifacts.length).toBeGreaterThan(0);
});
it("untrusted model plan rejected twice then falls back; cross-session references rejected", async () => {
  let calls = 0;
  const { svc, store, session } = setup({
    brain: {
      name: "invalid",
      complete: async () => {
        calls++;
        return {
          text: "{}",
          model: "invalid",
          latency_ms: 0,
          input_tokens: 0,
          output_tokens: 0,
        };
      },
    },
  });
  const q = svc.ask(session.id, "BTC 杠杆", "one");
  await svc.wait(q.inquiry.id);
  expect(svc.inquiry(q.inquiry.id).plan.source).toBe("fallback_rules");
  expect(calls).toBe(3);
  const other = store.createSession();
  expect(() =>
    svc.ask(other.id, "解释", "two", { selected_inquiry_id: q.inquiry.id }),
  ).toThrow("context_inquiry_conflict");
});
it("compare preserves instrument identity when provider sorts its results", async () => {
  const { svc, session, market } = setup();
  const resolve = market.resolve;
  vi.mocked(market.resolve).mockImplementation(async (input, signal) =>
    (await fakeMarket().resolve(input, signal)).reverse(),
  );
  const q = svc.ask(session.id, "SOL 比 ETH 大盘谁更强", "compare");
  await svc.wait(q.inquiry.id);
  const final = svc.inquiry(q.inquiry.id);
  expect(final.status).toBe("completed");
  expect(
    final.checkpoint.snapshot_refs.map(
      (id) => svc.store.snapshot(id).instrument.base,
    ),
  ).toEqual(expect.arrayContaining(["SOL", "ETH", "BTC"]));
  expect(fakeAnalyses.analyzeRelativeStrength).toHaveBeenCalled();
});
it("scheduler never exceeds three concurrent independent provider calls", async () => {
  const { svc, session, market } = setup();
  let running = 0,
    peak = 0;
  const releases: (() => void)[] = [];
  for (const name of [
    "price",
    "funding",
    "openInterest",
    "liquidations",
  ] as const) {
    const original = market[name];
    vi.mocked(market[name]).mockImplementation(async (...args: any[]) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => releases.push(resolve));
      running--;
      return (original as any).getMockImplementation === undefined
        ? null
        : (fakeMarket()[name] as any)(...args);
    });
  }
  const q = svc.ask(session.id, "BTC 杠杆", "concurrent");
  for (
    let i = 0;
    i < 100 &&
    !["completed", "failed", "incomplete"].includes(
      svc.inquiry(q.inquiry.id).status,
    );
    i++
  ) {
    await new Promise((r) => setImmediate(r));
    releases.splice(0).forEach((r) => r());
  }
  await svc.wait(q.inquiry.id);
  expect(peak).toBe(3);
  expect(svc.inquiry(q.inquiry.id).status).toBe("completed");
});
it("cached follow-up makes zero provider calls and consumes zero data-call budget", async () => {
  const { svc, session, market } = setup();
  const a = svc.ask(session.id, "BTC 杠杆", "first");
  await svc.wait(a.inquiry.id);
  for (const fn of Object.values(market)) vi.mocked(fn).mockClear();
  svc.options.budget = { ...DEFAULT_BUDGET, max_data_calls: 0 };
  const b = svc.ask(session.id, "这段 OI 怎么解释", "follow");
  await svc.wait(b.inquiry.id);
  expect(svc.inquiry(b.inquiry.id).status).toBe("completed");
  expect(svc.inquiry(b.inquiry.id).usage.max_data_calls).toBe(0);
  for (const fn of Object.values(market)) expect(fn).not.toHaveBeenCalled();
});
it("explicit new time window replaces persisted selection and fetches new snapshots", async () => {
  const { svc, session, market } = setup();
  const a = svc.ask(session.id, "BTC 杠杆", "first");
  await svc.wait(a.inquiry.id);
  const b = svc.ask(session.id, "BTC 最近 7 天杠杆", "week");
  await svc.wait(b.inquiry.id);
  expect(svc.inquiry(b.inquiry.id).plan.window).toEqual({
    from_ms: NOW - 7 * 86400000,
    to_ms: NOW,
  });
  expect(market.price).toHaveBeenCalledTimes(2);
  expect(svc.inquiry(b.inquiry.id).status).toBe("completed");
});
it("multi-asset funding question researches both named assets", async () => {
  const { svc, session, market } = setup();
  const q = svc.ask(session.id, "比较 BTC 和 ETH 的资金费率", "multi");
  await svc.wait(q.inquiry.id);
  expect(svc.inquiry(q.inquiry.id).status).toBe("completed");
  expect(vi.mocked(market.funding).mock.calls.map((c) => c[0].base)).toEqual(
    expect.arrayContaining(["BTC", "ETH"]),
  );
  expect(svc.inquiry(q.inquiry.id).checkpoint.snapshot_refs).toHaveLength(8);
});
it.each(["incomplete", "cancelled"] as const)(
  "pending external backtest stays cancelling until observed terminal, then %s",
  async (target) => {
    const registry = createToolRegistry();
    let active = true;
    registry.get("run_backtest")!.run = async (_input, ctx) => {
      ctx.progress?.({ run_id: "pending-run" });
      return {
        status: "error",
        output: { run_id: "pending-run", status: "cancelling" },
        error_code: "BUDGET_EXHAUSTED",
        snapshot_refs: [],
        artifact_refs: [],
        warnings: [],
        latency_ms: 0,
      };
    };
    const { instrument, WINDOW } = await import("./fixtures.js");
    const plan = {
      task_kind: "validate",
      instruments: [],
      window: WINDOW,
      timeframe: "1h",
      plan: [
        {
          key: "run",
          title: "回测",
          tool: "run_backtest",
          args: {
            instrument: instrument("BTC", "spot"),
            window: WINDOW,
            timeframe: "1h",
            ir: {},
          },
          depends_on: [],
        },
        {
          key: "answer",
          title: "回答",
          tool: "compose_answer",
          args: { question: "回测", steps: [], artifact_ids: [], metrics: {} },
          depends_on: ["run"],
        },
      ],
    };
    const { svc, session, store } = setup({
      registry,
      backtests: {
        activeRun: () => (active ? { id: "pending-run" } : null),
      } as any,
      brain: {
        name: "plan",
        complete: async () => ({
          text: JSON.stringify(plan),
          model: "plan",
          latency_ms: 0,
          input_tokens: 0,
          output_tokens: 0,
        }),
      },
    });
    const q = svc.ask(session.id, "BTC 回测", "pending");
    for (
      let i = 0;
      i < 100 && svc.inquiry(q.inquiry.id).status !== "cancelling";
      i++
    )
      await new Promise((r) => setImmediate(r));
    expect(svc.inquiry(q.inquiry.id).status).toBe("cancelling");
    if (target === "cancelled") {
      svc.cancel(q.inquiry.id);
      await new Promise((r) => setImmediate(r));
      expect(svc.inquiry(q.inquiry.id).status).toBe("cancelling");
    }
    expect(
      store.events(q.inquiry.id).some((e) => e.event === "inquiry." + target),
    ).toBe(false);
    active = false;
    await svc.wait(q.inquiry.id);
    expect(svc.inquiry(q.inquiry.id).status).toBe(target);
    expect(store.events(q.inquiry.id).at(-1)?.data.external_run_stopped).toBe(
      true,
    );
  },
);
it("synchronous last computation crossing wall clock cannot mark inquiry completed", async () => {
  let now = NOW;
  const registry = createToolRegistry(),
    render = registry.get("render_artifact")!.run;
  registry.get("render_artifact")!.run = async (input, ctx) => {
    const output = await render(input, ctx);
    now += DEFAULT_BUDGET.wall_clock_ms + 1;
    return output;
  };
  const p = fallbackPlan("BTC 杠杆", undefined, NOW);
  p.plan = p.plan.filter((s) =>
    ["resolve", "price", "render", "answer"].includes(s.key),
  );
  p.plan.find((s) => s.key === "price")!.depends_on = ["resolve"];
  p.plan.at(-1)!.depends_on = ["resolve", "price", "render"];
  const { svc, session } = setup({
    registry,
    now: () => now,
    brain: {
      name: "plan",
      complete: async () => ({
        text: JSON.stringify(p),
        model: "plan",
        latency_ms: 0,
        input_tokens: 0,
        output_tokens: 0,
      }),
    },
  });
  const q = svc.ask(session.id, "BTC 杠杆", "clock");
  await svc.wait(q.inquiry.id);
  expect(svc.inquiry(q.inquiry.id).status).toBe("incomplete");
  const artifacts = svc.session(session.id).artifacts;
  expect(artifacts).toHaveLength(2);
  const report = artifacts.find((a) => a.kind === "markdown");
  expect(report?.availability).toBe("partial");
  expect((report?.content as any).stop_reason).toMatch(/预算|超时|时限/);
  expect(svc.session(session.id).messages.at(-1)?.blocks).toContainEqual(
    expect.objectContaining({ kind: "chart_ref" }),
  );
});
