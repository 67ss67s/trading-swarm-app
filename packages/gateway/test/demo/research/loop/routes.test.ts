import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { openStateDb } from "../../../../src/state-db.js";
import { DEFAULT_WORKFLOW } from "../../../../src/demo/workflow.js";
import type { DemoRuntime } from "../../../../src/demo/runtime.js";
import type { DemoStore } from "../../../../src/demo/store.js";
import { fakeMarket, fakeAnalyses } from "./fixtures.js";
vi.mock("../../../../src/demo/research/data/index.js", () => ({
  okxMarketData: () => fakeMarket(),
}));
vi.mock("../../../../src/demo/research/data/analyses.js", () => fakeAnalyses);
vi.mock("../../../../src/demo/http-extra.js", async () => ({
  extraRouteModules: [
    (await import("../../../../src/demo/routes-research.js")).researchRoutes,
  ],
}));
import { createServer } from "../../../../src/demo/http.js";
const clean: (() => void)[] = [];
afterEach(() => {
  clean.splice(0).forEach((f) => f());
  vi.restoreAllMocks();
});
function app() {
  vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref() {} } as any);
  const state = openStateDb(":memory:");
  const brain = {
      name: "offline",
      complete: async () => {
        throw Error("offline");
      },
    },
    rt = Object.assign(new EventEmitter(), {
      workflow: DEFAULT_WORKFLOW,
      brainFor: () => brain,
      mainBrain: () => brain,
      cliCommandFor: () => null,
    });
  const server = createServer(
    rt as unknown as DemoRuntime,
    { marketDb: state.db } as DemoStore,
  );
  clean.push(() => {
    server.close();
    state.close();
  });
  const events: any[] = [];
  rt.on("research.inquiry", (e) => events.push(e));
  return {
    state,
    events,
    call: async (method: string, path: string, body?: unknown) => {
      let status = 0,
        text = "";
      const res = {
        setHeader() {},
        writeHead(code: number) {
          status = code;
        },
        end(v = "") {
          text = v;
        },
      };
      const req = Object.assign(
        Readable.from(
          body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
        ),
        { url: path, method, headers: { origin: "http://127.0.0.1:5191" } },
      );
      await server.listeners("request")[0]!(
        req as unknown as http.IncomingMessage,
        res as unknown as http.ServerResponse,
      );
      return { status, json: text ? JSON.parse(text) : null };
    },
  };
}
it("HTTP create/ask/events/snapshot/artifact/session restore works before old routes without socket", async () => {
  const { call, events } = app();
  const session = await call("POST", "/api/research/sessions", {
    title: "研究",
  });
  expect(session.status).toBe(201);
  const id = session.json.id;
  expect((await call("GET", "/api/research/sessions")).json.items[0].id).toBe(
    id,
  );
  const ask = await call("POST", `/api/research/sessions/${id}/messages`, {
    text: "BTC 杠杆",
    idempotency_key: "http-one",
  });
  expect(ask.status).toBe(202);
  const inquiry = ask.json.inquiry.id;
  let detail: any;
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setImmediate(r));
    detail = await call("GET", `/api/research/sessions/${id}`);
    if (
      ["completed", "incomplete", "failed"].includes(
        detail.json.inquiries[0]?.status,
      )
    )
      break;
  }
  expect(detail.json.inquiries[0]?.status, JSON.stringify(detail.json)).toBe(
    "completed",
  );
  const snap = detail.json.inquiries[0].checkpoint.snapshot_refs[0];
  expect(
    (await call("GET", `/api/research/snapshots/${snap}`)).json.rows.length,
  ).toBeGreaterThan(0);
  expect(
    (await call("GET", `/api/research/snapshots/${snap}?rows=0`)).json.rows,
  ).toBeUndefined();
  const artifact = detail.json.artifacts[0];
  expect(
    (await call("GET", `/api/research/artifacts/${artifact.id}`)).json,
  ).toEqual(artifact);
  const stream = await call("GET", `/api/research/inquiries/${inquiry}/events`);
  expect(stream.json.items).toEqual(events);
  expect(
    (
      await call(
        "GET",
        `/api/research/inquiries/${inquiry}/events?after=${stream.json.next_cursor}`,
      )
    ).json.items,
  ).toEqual([]);
  const catalog = (await call("GET", "/api/research/tools")).json.items;
  expect(catalog).toHaveLength(25);
  expect(catalog.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining([
    "revise_strategy", "run_strategy_revision", "compare_strategy_runs", "build_research_report",
    "analyze_pattern_frequency", "acquire_concept",
  ]));
  expect(
    (
      await call("PATCH", `/api/research/sessions/${id}/context`, {
        selected_artifact_id: artifact.id,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call("PATCH", `/api/research/sessions/${id}/context`, {
        selected_artifact_id: null,
      })
    ).json.context.selected_artifact_id,
  ).toBeUndefined();
  expect(
    (
      await call("POST", `/api/research/sessions/${id}/messages`, {
        text: "BTC 杠杆",
        idempotency_key: "http-one",
      })
    ).json.inquiry.id,
  ).toBe(inquiry);
});
it("HTTP validates bodies, conflicts, cursors, clarification and old artifact compatibility reads", async () => {
  const { call, state } = app();
  expect((await call("POST", "/api/research/sessions", null)).status).toBe(400);
  expect((await call("GET", "/api/research/sessions/missing")).status).toBe(
    404,
  );
  const session = (await call("POST", "/api/research/sessions", {})).json.id;
  const q = (
    await call("POST", `/api/research/sessions/${session}/messages`, {
      text: "看看杠杆",
      idempotency_key: "clarify",
    })
  ).json.inquiry.id;
  await new Promise((r) => setImmediate(r));
  expect(
    await call("POST", `/api/research/sessions/${session}/messages`, {
      text: "ETH",
      idempotency_key: "two",
    }),
  ).toMatchObject({
    status: 409,
    json: { error: { code: "research_session_busy" } },
  });
  expect(
    (await call("GET", `/api/research/inquiries/${q}/events?after=NaN`)).status,
  ).toBe(400);
  expect(
    (await call("POST", `/api/research/inquiries/${q}/answer`, { text: "" }))
      .status,
  ).toBe(400);
  expect(
    (await call("POST", `/api/research/inquiries/${q}/cancel`)).status,
  ).toBe(200);
  expect((await call("GET", `/api/research/inquiries/${q}`)).json.status).toBe(
    "cancelled",
  );
  state.db
    .prepare(
      "INSERT INTO research_artifacts(id,chat_id,kind,title,content_json,created_at) VALUES (?,?,?,?,?,?)",
    )
    .run("legacy", "chat", "table", "old", "{}", 1);
  expect(
    (await call("GET", "/api/research/artifacts/legacy")).json,
  ).toMatchObject({ id: "legacy", legacy: true, inquiry_id: null });
});
