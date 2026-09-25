import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  LoopContext,
  LoopPlan,
  LoopBudget,
  LoopUsage,
  LoopCheckpoint,
  LoopStatus,
  LoopTaskKind,
  LoopBlocks,
  LoopArtifact,
  LoopResult,
} from "@trading-swarm/contracts";
import type { SnapshotDraft } from "../data/index.js";
import { check, encode } from "./schema.js";
export type {
  LoopContext,
  LoopPlan,
  LoopBudget,
  LoopUsage,
  LoopCheckpoint,
  LoopBlocks,
};
export const TERMINAL = new Set<LoopStatus>([
  "completed",
  "failed",
  "incomplete",
  "cancelled",
]);
export const DEFAULT_BUDGET: LoopBudget = {
  max_model_calls: 6,
  max_data_calls: 12,
  max_backtests: 1,
  wall_clock_ms: 600000,
};
export const emptyUsage = (): LoopUsage => ({
  max_model_calls: 0,
  max_data_calls: 0,
  max_backtests: 0,
  wall_clock_ms: 0,
  unknown_cost: true,
});
export const emptyCheckpoint = (): LoopCheckpoint => ({
  completed_step_keys: [],
  snapshot_refs: [],
  artifact_refs: [],
});
export interface Session {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  context: LoopContext;
}
export interface Message {
  id: string;
  session_id: string;
  seq: number;
  role: "user" | "assistant";
  created_at: number;
  blocks: LoopBlocks;
  inquiry_id: string | null;
}
export interface Inquiry {
  id: string;
  session_id: string;
  user_message_id: string;
  task_kind: LoopTaskKind;
  status: LoopStatus;
  question: string;
  plan: LoopPlan;
  budget: LoopBudget;
  usage: LoopUsage;
  checkpoint: LoopCheckpoint;
  error_code: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  idempotency_key: string;
}
export interface Step {
  id: string;
  inquiry_id: string;
  seq: number;
  parent_id: string | null;
  title: string;
  tool: string;
  tool_version: string;
  status:
    "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
  input: Record<string, unknown>;
  output_summary: Record<string, unknown>;
  snapshot_refs: string[];
  artifact_refs: string[];
  error_code: string | null;
  retryable: boolean;
  started_at: number | null;
  ended_at: number | null;
  usage: LoopUsage;
}
export interface InquiryEvent {
  seq: number;
  inquiry_id: string;
  session_id: string;
  at: number;
  event: string;
  data: Record<string, unknown>;
}
export type Snapshot = SnapshotDraft & { id: string };
const jsonFields: Record<string, string> = {
  context: "Context",
  blocks: "Blocks",
  plan: "Plan",
  budget: "Budget",
  usage: "Usage",
  checkpoint: "Checkpoint",
  input: "Object",
  output_summary: "Object",
  snapshot_refs: "Refs",
  artifact_refs: "Refs",
  instrument: "Instrument",
  requested_window: "Window",
  actual_window: "Json",
  units: "Units",
  quality_flags: "Refs",
  rows: "Rows",
  spec: "Spec",
  content: "Json",
  data: "Object",
};
function decode<T>(row: unknown): T {
  const out: Record<string, unknown> = { ...(row as object) };
  for (const [field, type] of Object.entries(jsonFields)) {
    const key = field + "_json";
    if (key in out) {
      out[field] =
        out[key] === null ? null : check(type, JSON.parse(String(out[key])));
      delete out[key];
    }
  }
  if ("retryable" in out) out.retryable = !!out.retryable;
  return out as T;
}
export class LoopStore {
  constructor(
    readonly db: DatabaseSync,
    readonly now: () => number = Date.now,
  ) {}
  transaction<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT research_loop");
    try {
      const result = fn();
      this.db.exec("RELEASE research_loop");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK TO research_loop");
      this.db.exec("RELEASE research_loop");
      throw e;
    }
  }
  createSession(
    title = "新研究",
    context: LoopContext = { instrument_refs: [] },
  ): Session {
    if (typeof title !== "string" || !title.trim() || title.length > 300)
      throw Error("invalid_title");
    const id = randomUUID(),
      now = this.now();
    this.db
      .prepare("INSERT INTO research_sessions VALUES (?,?,?,?,?)")
      .run(id, title, now, now, encode("Context", context));
    return this.session(id);
  }
  session(id: string): Session {
    const r = this.db
      .prepare("SELECT * FROM research_sessions WHERE id=?")
      .get(id);
    if (!r) throw Error("session_not_found");
    return decode(r);
  }
  sessions(limit = 100): Session[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw Error("invalid_limit");
    return this.db
      .prepare(
        "SELECT * FROM research_sessions ORDER BY updated_at DESC,id LIMIT ?",
      )
      .all(Math.min(500, limit))
      .map((r) => decode<Session>(r));
  }
  updateSession(
    id: string,
    patch: { title?: string; context?: LoopContext },
  ): Session {
    const old = this.session(id);
    const title = patch.title ?? old.title;
    if (!title.trim() || title.length > 300) throw Error("invalid_title");
    this.db
      .prepare(
        "UPDATE research_sessions SET title=?,context_json=?,updated_at=? WHERE id=?",
      )
      .run(
        title,
        encode("Context", patch.context ?? old.context),
        this.now(),
        id,
      );
    return this.session(id);
  }
  deleteSession(id: string): void {
    this.session(id);
    if (this.active(id)) throw Error("research_session_busy");
    this.transaction(() => {
      for (const q of this.inquiries(id)) {
        for (const table of [
          "research_steps",
          "research_inquiry_events",
          "research_artifacts",
        ])
          this.db.prepare(`DELETE FROM ${table} WHERE inquiry_id=?`).run(q.id);
      }
      this.db
        .prepare("DELETE FROM research_inquiries WHERE session_id=?")
        .run(id);
      this.db
        .prepare("DELETE FROM research_messages WHERE session_id=?")
        .run(id);
      this.db.prepare("DELETE FROM research_sessions WHERE id=?").run(id);
    });
  }
  appendMessage(
    session_id: string,
    role: Message["role"],
    blocks: LoopBlocks,
    inquiry_id: string | null = null,
  ): Message {
    this.session(session_id);
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO research_messages SELECT ?,?,COALESCE(MAX(seq),0)+1,?,?,?,? FROM research_messages WHERE session_id=?",
      )
      .run(
        id,
        session_id,
        role,
        this.now(),
        encode("Blocks", blocks),
        inquiry_id,
        session_id,
      );
    this.db
      .prepare("UPDATE research_sessions SET updated_at=? WHERE id=?")
      .run(this.now(), session_id);
    return this.messages(session_id).find((m) => m.id === id)!;
  }
  messages(id: string): Message[] {
    return this.db
      .prepare(
        "SELECT * FROM research_messages WHERE session_id=? ORDER BY seq",
      )
      .all(id)
      .map((r) => decode<Message>(r));
  }
  byKey(key: string): Inquiry | null {
    const r = this.db
      .prepare("SELECT * FROM research_inquiries WHERE idempotency_key=?")
      .get(key);
    return r ? decode(r) : null;
  }
  active(id: string): Inquiry | null {
    return this.inquiries(id).find((q) => !TERMINAL.has(q.status)) ?? null;
  }
  createInquiry(
    session_id: string,
    text: string,
    key: string,
    context?: LoopContext,
    budget: LoopBudget = DEFAULT_BUDGET,
  ): { message: Message; inquiry: Inquiry } {
    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 20000 ||
      typeof key !== "string" ||
      !key.trim() ||
      key.length > 300
    )
      throw Error("invalid_message");
    return this.transaction(() => {
      const prior = this.byKey(key);
      if (prior) {
        if (prior.session_id !== session_id || prior.question !== text)
          throw Error("idempotency_conflict");
        return {
          message: this.messages(session_id).find(
            (m) => m.id === prior.user_message_id,
          )!,
          inquiry: prior,
        };
      }
      if (this.active(session_id)) throw Error("research_session_busy");
      if (context) this.updateSession(session_id, { context });
      const id = randomUUID(),
        now = this.now(),
        message = this.appendMessage(
          session_id,
          "user",
          [{ kind: "text", text }],
          id,
        );
      const plan: LoopPlan = {
        task_kind: "market",
        instruments: [],
        window: { from_ms: Math.max(0, now - 30 * 86400000), to_ms: now },
        timeframe: "1h",
        plan: [],
      };
      this.db
        .prepare(
          "INSERT INTO research_inquiries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          session_id,
          message.id,
          "market",
          "queued",
          text,
          encode("Plan", plan),
          encode("Budget", budget),
          encode("Usage", emptyUsage()),
          encode("Checkpoint", emptyCheckpoint()),
          null,
          null,
          now,
          now,
          key,
        );
      return { message, inquiry: this.inquiry(id) };
    });
  }
  inquiry(id: string): Inquiry {
    const r = this.db
      .prepare("SELECT * FROM research_inquiries WHERE id=?")
      .get(id);
    if (!r) throw Error("inquiry_not_found");
    return decode(r);
  }
  inquiries(id: string): Inquiry[] {
    return this.db
      .prepare(
        "SELECT * FROM research_inquiries WHERE session_id=? ORDER BY created_at,rowid",
      )
      .all(id)
      .map((r) => decode<Inquiry>(r));
  }
  updateInquiry(
    id: string,
    patch: Partial<
      Pick<
        Inquiry,
        | "status"
        | "task_kind"
        | "plan"
        | "usage"
        | "checkpoint"
        | "budget"
        | "error_code"
        | "error"
      >
    >,
  ): Inquiry {
    const old = this.inquiry(id);
    if (patch.status) {
      check("Status", patch.status);
      if (TERMINAL.has(old.status) && old.status !== patch.status)
        throw Error("inquiry_terminal");
      const transitions: Record<string, string[]> = {
        queued: ["planning", "cancelling", "incomplete", "failed"],
        planning: [
          "running",
          "awaiting_input",
          "cancelling",
          "incomplete",
          "failed",
        ],
        awaiting_input: ["planning", "cancelling", "incomplete", "failed"],
        running: ["validating", "cancelling", "incomplete", "failed"],
        validating: ["completed", "incomplete", "failed", "cancelling"],
        cancelling: ["cancelled", "incomplete"],
      };
      if (
        old.status !== patch.status &&
        !transitions[old.status]?.includes(patch.status)
      )
        throw Error("invalid_inquiry_transition");
    }
    if (patch.task_kind) check("TaskKind", patch.task_kind);
    const set = ["updated_at=?"],
      values: SQLInputValue[] = [this.now()];
    for (const [key, value] of Object.entries(patch)) {
      set.push(`${key in jsonFields ? key + "_json" : key}=?`);
      values.push(
        key in jsonFields
          ? encode(jsonFields[key]!, value)
          : (value as SQLInputValue),
      );
    }
    values.push(id);
    this.db
      .prepare(`UPDATE research_inquiries SET ${set.join(",")} WHERE id=?`)
      .run(...values);
    this.db
      .prepare("UPDATE research_sessions SET updated_at=? WHERE id=?")
      .run(this.now(), old.session_id);
    return this.inquiry(id);
  }
  upsertStep(s: Step): Step {
    this.inquiry(s.inquiry_id);
    const old = this.steps(s.inquiry_id).find((row) => row.id === s.id);
    if (
      old &&
      old.status !== s.status &&
      !(
        (old.status === "pending" &&
          ["running", "skipped", "cancelled"].includes(s.status)) ||
        (old.status === "running" &&
          ["succeeded", "failed", "cancelled"].includes(s.status))
      )
    )
      throw Error("invalid_step_transition");
    this.db
      .prepare(
        `INSERT INTO research_steps VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,input_json=excluded.input_json,output_summary_json=excluded.output_summary_json,snapshot_refs_json=excluded.snapshot_refs_json,artifact_refs_json=excluded.artifact_refs_json,error_code=excluded.error_code,retryable=excluded.retryable,started_at=excluded.started_at,ended_at=excluded.ended_at,usage_json=excluded.usage_json`,
      )
      .run(
        s.id,
        s.inquiry_id,
        s.seq,
        s.parent_id,
        s.title,
        s.tool,
        s.tool_version,
        s.status,
        encode("Object", s.input),
        encode("Object", s.output_summary),
        encode("Refs", s.snapshot_refs),
        encode("Refs", s.artifact_refs),
        s.error_code,
        s.retryable ? 1 : 0,
        s.started_at,
        s.ended_at,
        encode("Usage", s.usage),
      );
    return this.steps(s.inquiry_id).find((x) => x.id === s.id)!;
  }
  steps(id: string): Step[] {
    return this.db
      .prepare("SELECT * FROM research_steps WHERE inquiry_id=? ORDER BY seq")
      .all(id)
      .map((r) => decode<Step>(r));
  }
  event(
    id: string,
    event: string,
    data: Record<string, unknown> = {},
  ): InquiryEvent {
    const q = this.inquiry(id),
      at = this.now();
    const r = this.db
      .prepare(
        "INSERT INTO research_inquiry_events(inquiry_id,at,event,data_json) VALUES (?,?,?,?)",
      )
      .run(id, at, event, encode("Object", data));
    return {
      seq: Number(r.lastInsertRowid),
      inquiry_id: id,
      session_id: q.session_id,
      at,
      event,
      data,
    };
  }
  events(id: string, after = 0): InquiryEvent[] {
    this.inquiry(id);
    if (!Number.isSafeInteger(after) || after < 0)
      throw Error("invalid_cursor");
    return this.db
      .prepare(
        "SELECT e.*,q.session_id FROM research_inquiry_events e JOIN research_inquiries q ON q.id=e.inquiry_id WHERE inquiry_id=? AND seq>? ORDER BY seq",
      )
      .all(id, after)
      .map((r) => decode<InquiryEvent>(r));
  }
  putSnapshot(d: SnapshotDraft): Snapshot {
    check("Snapshot", d);
    const prior = this.db
      .prepare("SELECT id FROM research_snapshots WHERE checksum=?")
      .get(d.checksum) as { id: string } | undefined;
    if (prior) return this.snapshot(prior.id);
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO research_snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        d.kind,
        d.provider,
        encode("Instrument", d.instrument),
        encode("Window", d.requested_window),
        encode("Json", d.actual_window),
        d.as_of,
        d.fetched_at,
        d.frequency,
        encode("Units", d.units),
        d.coverage,
        encode("Refs", d.quality_flags),
        encode("Rows", d.rows),
        d.checksum,
        d.method_version,
      );
    return this.snapshot(id);
  }
  snapshot(id: string): Snapshot {
    const r = this.db
      .prepare("SELECT * FROM research_snapshots WHERE id=?")
      .get(id);
    if (!r) throw Error("snapshot_not_found");
    const out = decode<Snapshot>(r),
      { id: _, ...draft } = out;
    check("Snapshot", draft);
    return out;
  }
  putArtifact(a: LoopArtifact): ReturnType<LoopStore["artifact"]> {
    check("Artifact", a);
    const q = this.inquiry(a.inquiry_id);
    for (const id of a.snapshot_refs) this.snapshot(id);
    const id = randomUUID();
    const { content, ...metadata } = a;
    this.db
      .prepare(
        "INSERT INTO research_artifacts(id,chat_id,run_id,kind,title,content_json,created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        id,
        q.session_id,
        a.run_id ?? null,
        a.kind,
        a.title,
        encode("Object", { __research_loop_v1: metadata, payload: content }),
        this.now(),
      );
    return this.artifact(id);
  }
  artifact(
    id: string,
  ): LoopArtifact & { id: string; created_at: number; legacy?: boolean } {
    const r = this.db
      .prepare("SELECT * FROM research_artifacts WHERE id=?")
      .get(id);
    if (!r) throw Error("artifact_not_found");
    const a = decode<LoopArtifact & { id: string; created_at: number }>(r);
    if (a.inquiry_id) {
      const envelope = check<Record<string, unknown>>("Object", a.content);
      a.content = check("Object", envelope.payload);
    }
    return { ...a, ...(!a.inquiry_id ? { legacy: true } : {}) };
  }
  artifacts(id: string): ReturnType<LoopStore["artifact"]>[] {
    return (
      this.db
        .prepare(
          "SELECT a.id FROM research_artifacts a JOIN research_inquiries q ON q.id=a.inquiry_id WHERE q.session_id=? ORDER BY a.created_at,a.rowid",
        )
        .all(id) as { id: string }[]
    ).map((r) => this.artifact(r.id));
  }
  cached(inquiry_id: string, tool: string, input: string): LoopResult | null {
    for (const s of this.steps(inquiry_id)) {
      if (
        s.tool === tool &&
        s.status === "succeeded" &&
        s.output_summary.canonical_input === input &&
        s.output_summary.result
      )
        return check<LoopResult>("Result", s.output_summary.result);
    }
    return null;
  }
  recover(): void {
    const rows = this.db
      .prepare(
        "SELECT id FROM research_inquiries WHERE status NOT IN ('completed','cancelled','failed','incomplete')",
      )
      .all() as { id: string }[];
    this.transaction(() => {
      for (const { id } of rows) {
        this.updateInquiry(id, {
          status: "incomplete",
          error_code: "interrupted",
          error: "进程中断；保留已有产物，不自动重跑",
        });
        for (const s of this.steps(id))
          if (s.status === "running" || s.status === "pending")
            this.upsertStep({
              ...s,
              status: "cancelled",
              error_code: "interrupted",
              ended_at: this.now(),
            });
        this.event(id, "inquiry.incomplete", { error_code: "interrupted" });
      }
    });
  }
}
