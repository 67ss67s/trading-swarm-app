import { afterEach, expect, it } from "vitest";
import { openStateDb } from "../../../../src/state-db.js";
import { LoopStore } from "../../../../src/demo/research/loop/store.js";
const clean: (() => void)[] = [];
afterEach(() => clean.splice(0).forEach((f) => f()));
function setup() {
  const db = openStateDb(":memory:");
  clean.push(() => db.close());
  return new LoopStore(db.db);
}
it("atomically appends messages, enforces busy, reuses idempotency and preserves recovery", () => {
  const s = setup(),
    session = s.createSession();
  const a = s.createInquiry(session.id, "BTC", "one");
  expect(s.createInquiry(session.id, "BTC", "one")).toEqual(a);
  expect(() => s.createInquiry(session.id, "ETH", "two")).toThrow("busy");
  expect(() => s.createInquiry(session.id, "ETH", "one")).toThrow("conflict");
  s.recover();
  expect(s.inquiry(a.inquiry.id).status).toBe("incomplete");
  expect(s.inquiry(a.inquiry.id).error_code).toBe("interrupted");
  expect(s.events(a.inquiry.id)[0]?.event).toBe("inquiry.incomplete");
  s.createInquiry(session.id, "ETH", "two");
  expect(s.messages(session.id).map((m) => m.seq)).toEqual([1, 2]);
});
it("validates all JSON writes and does not leave partial messages", () => {
  const s = setup(),
    session = s.createSession();
  expect(() =>
    s.createInquiry(session.id, "BTC", "one", undefined, {
      max_data_calls: NaN,
    } as any),
  ).toThrow("SCHEMA_MISMATCH");
  expect(s.messages(session.id)).toHaveLength(0);
  expect(() =>
    s.updateSession(session.id, { context: { instrument_refs: [3] } as any }),
  ).toThrow("SCHEMA_MISMATCH");
  expect(() =>
    s.appendMessage(session.id, "assistant", [
      { kind: "chart_ref", artifact_id: 3 },
    ] as any),
  ).toThrow("SCHEMA_MISMATCH");
});
it("old artifact rows keep null extensions and session CRUD is independent", () => {
  const s = setup();
  s.db
    .prepare(
      "INSERT INTO research_artifacts(id,chat_id,kind,title,content_json,created_at) VALUES (?,?,?,?,?,?)",
    )
    .run("old", "old-chat", "table", "old", "{}", 1);
  expect(s.artifact("old")).toMatchObject({
    id: "old",
    legacy: true,
    inquiry_id: null,
    spec: null,
  });
  const session = s.createSession("title");
  expect(s.updateSession(session.id, { title: "new" }).title).toBe("new");
  s.deleteSession(session.id);
  expect(s.sessions()).toEqual([]);
  expect(s.artifact("old").id).toBe("old");
});
