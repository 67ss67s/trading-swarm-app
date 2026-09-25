import type { LoopBlocks, LoopPlan, LoopPlanStep } from "@trading-swarm/contracts";
import { canonical } from "../primitives.js";
import { emptyUsage, type Step, type InquiryEvent } from "./store.js";
import {
  failure,
  type ToolContext,
  type ToolRegistry,
  type ToolResult,
} from "./tools.js";
import { check } from "./schema.js";
export type Emit = (event: InquiryEvent) => void;
export function publish(
  ctx: ToolContext,
  emit: Emit,
  event: string,
  data: Record<string, unknown> = {},
): void {
  const saved = ctx.store.event(ctx.inquiry_id, event, data);
  try {
    emit(saved);
  } catch {
    /* Persisted events remain replayable when an SSE listener disconnects. */
  }
}
export function resolveArgs(
  value: unknown,
  results: Map<string, ToolResult>,
  dependencies: string[],
): any {
  if (typeof value === "string" && value.startsWith("$")) {
    const [key, ...path] = value.slice(1).split(".");
    if (!key || !dependencies.includes(key))
      throw Error("SCHEMA_MISMATCH:undeclared_reference");
    let item: unknown = results.get(key)?.output;
    for (const part of path) {
      if (
        item === null ||
        typeof item !== "object" ||
        !Object.hasOwn(item, part)
      )
        throw Error("SCHEMA_MISMATCH:unresolved_reference");
      item = (item as Record<string, unknown>)[part];
    }
    return item;
  }
  if (Array.isArray(value))
    return value.map((v) => resolveArgs(v, results, dependencies));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        resolveArgs(v, results, dependencies),
      ]),
    );
  return value;
}
export async function executePlan(
  plan: LoopPlan,
  registry: ToolRegistry,
  ctx: ToolContext,
  emit: Emit,
): Promise<void> {
  const { store, inquiry_id } = ctx;
  const results = new Map<string, ToolResult>(),
    states = new Map<string, Step>();
  let failed = false,
    budgetExhausted = false;
  const completed = new Set<string>(),
    snapshots = new Set(store.inquiry(inquiry_id).checkpoint.snapshot_refs),
    artifacts = new Set(store.inquiry(inquiry_id).checkpoint.artifact_refs);
  for (const [seq, s] of plan.plan.entries()) {
    const row: Step = {
      id: inquiry_id + ":" + s.key,
      inquiry_id,
      seq,
      parent_id: s.depends_on[0] ? inquiry_id + ":" + s.depends_on[0] : null,
      title: s.title,
      tool: s.tool,
      tool_version: registry.get(s.tool)!.version,
      status: "pending",
      input: s.args,
      output_summary: {},
      snapshot_refs: [],
      artifact_refs: [],
      error_code: null,
      retryable: false,
      started_at: null,
      ended_at: null,
      usage: emptyUsage(),
    };
    states.set(s.key, store.upsertStep(row));
  }
  // 概念覆盖是计划阶段(和 acquire_concept 子 loop)写进 checkpoint 的,每次存点都要原样带回去,不能被步骤进度覆盖掉
  const saveCheckpoint = () => {
    const concepts = store.inquiry(inquiry_id).checkpoint.concepts;
    store.updateInquiry(inquiry_id, {
      checkpoint: {
        completed_step_keys: [...completed],
        snapshot_refs: [...snapshots],
        artifact_refs: [...artifacts],
        ...(concepts ? { concepts } : {}),
      },
    });
  };
  const finish = (s: LoopPlanStep, r: ToolResult, status: Step["status"]) => {
    const row = states.get(s.key)!;
    row.status = status;
    row.ended_at = ctx.now();
    row.error_code = r.error_code ?? null;
    row.retryable = r.retryable ?? false;
    row.snapshot_refs = r.snapshot_refs;
    row.artifact_refs = r.artifact_refs;
    row.output_summary = { ...row.output_summary, result: check("Json", r) };
    row.usage = { ...ctx.budget.usage };
    store.upsertStep(row);
    results.set(s.key, r);
    completed.add(s.key);
    for (const id of r.snapshot_refs) snapshots.add(id);
    for (const id of r.artifact_refs) {
      if (!artifacts.has(id))
        publish(
          ctx,
          emit,
          "artifact.created",
          check("Object", store.artifact(id)),
        );
      artifacts.add(id);
    }
    saveCheckpoint();
    publish(ctx, emit, "step.completed", {
      step_id: row.id,
      key: s.key,
      tool: s.tool,
      status,
      snapshot_refs: r.snapshot_refs,
      artifact_refs: r.artifact_refs,
      summary: row.output_summary,
    });
  };
  const run = async (s: LoopPlanStep) => {
    const row = states.get(s.key)!;
    row.status = "running";
    row.started_at = ctx.now();
    store.upsertStep(row);
    publish(ctx, emit, "step.started", {
      step_id: row.id,
      key: s.key,
      title: s.title,
      tool: s.tool,
    });
    let r: ToolResult;
    try {
      let input: unknown;
      if (s.tool === "compose_answer") {
        const metrics: Record<string, unknown> = {};
        for (const r of results.values())
          if (r.output && typeof r.output === "object" && "metrics" in r.output)
            Object.assign(metrics, r.output.metrics);
        input = {
          question: store.inquiry(inquiry_id).question,
          steps: [...states.values()]
            .filter((s) => !["compose_answer", "build_research_report"].includes(s.tool))
            .map((s) => ({
              tool: s.tool,
              status: s.status,
              result: s.output_summary.result ?? null,
            })),
          artifact_ids: [...artifacts],
          metrics,
        };
      } else input = resolveArgs(s.args, results, s.depends_on);
      row.input = check("Object", input);
      row.output_summary.canonical_input = canonical(input);
      store.upsertStep(row);
      r = await registry.call(s.tool, input, {
        ...ctx,
        step_id: row.id,
        progress: (summary) => {
          if (ctx.signal.aborted) return;
          row.output_summary = { ...row.output_summary, ...summary };
          store.upsertStep(row);
          publish(ctx, emit, "step.progress", { step_id: row.id, ...summary });
        },
      });
    } catch (e) {
      const message = String(e);
      r = failure(
        message.includes("CANCELLED")
          ? "CANCELLED"
          : message.includes("BUDGET_EXHAUSTED")
            ? "BUDGET_EXHAUSTED"
            : "SCHEMA_MISMATCH",
        message,
      );
    }
    // 只有墙钟用完才算整轮耗尽;某一类(回测/模型/数据)次数用完只让这一步失败、依赖它的步骤跳过,其他分支照跑
    if (r.error_code === "BUDGET_EXHAUSTED" && ctx.budget.remaining() <= 0) budgetExhausted = true;
    const status =
      r.error_code === "CANCELLED"
        ? "cancelled"
        : r.status === "error"
          ? "failed"
          : "succeeded";
    if (status === "failed") failed = true;
    finish(s, r, status);
    if (
      s.tool === "compose_answer" &&
      r.output &&
      typeof r.output === "object" &&
      "blocks" in r.output
    )
      store.appendMessage(
        store.inquiry(inquiry_id).session_id,
        "assistant",
        check<LoopBlocks>("Blocks", r.output.blocks),
        inquiry_id,
      );
  };
  const ordinary = plan.plan.filter((s) => !["compose_answer", "build_research_report"].includes(s.tool));
  const inFlight = new Map<string, Promise<void>>();
  while (completed.size < ordinary.length) {
    for (const s of ordinary) {
      if (completed.has(s.key) || inFlight.has(s.key)) continue;
      if (ctx.signal.aborted) {
        finish(s, failure("CANCELLED"), "cancelled");
        continue;
      }
      if (budgetExhausted || ctx.budget.remaining() <= 0) {
        budgetExhausted = true;
        finish(s, failure("BUDGET_EXHAUSTED"), "skipped");
        continue;
      }
      if (!s.depends_on.every((k) => completed.has(k))) continue;
      if (s.depends_on.some((k) => states.get(k)?.status !== "succeeded")) {
        failed = true;
        finish(s, failure("DATA_MISSING", "dependency_failed"), "skipped");
        continue;
      }
      const command = plan.command;
      const candidateNumber = /^draft_(\d+)$/.exec(s.key)?.[1];
      if (command && candidateNumber && Number(candidateNumber) > 1 && !completed.has(`compare_${Number(candidateNumber) - 1}`)) continue;
      if (inFlight.size < 3) {
        const job = run(s).finally(() => inFlight.delete(s.key));
        inFlight.set(s.key, job);
      }
    }
    if (inFlight.size) await Promise.race(inFlight.values());
    else if (completed.size < ordinary.length) {
      failed = true;
      for (const s of ordinary)
        if (!completed.has(s.key))
          finish(
            s,
            failure("SCHEMA_MISMATCH", "unresolved_dependency"),
            "skipped",
          );
    }
  }
  await Promise.all(inFlight.values());
  const defer = (status: "cancelled" | "incomplete") => {
    const run = ctx.backtests?.activeRun(inquiry_id);
    if (!run) return false;
    if (store.inquiry(inquiry_id).status !== "cancelling")
      store.updateInquiry(inquiry_id, { status: "cancelling" });
    publish(ctx, emit, "step.progress", {
      run_id: run.id,
      status: "cancelling",
      note: "回测仍在停止；仅后台查询状态，不启动后续计算",
    });
    ctx.deferCompletion?.(status, run.id);
    return true;
  };
  if (ctx.signal.aborted) {
    const old = store.inquiry(inquiry_id);
    if (old.status !== "cancelling")
      store.updateInquiry(inquiry_id, { status: "cancelling" });
    for (const s of plan.plan.filter((s) => ["compose_answer", "build_research_report"].includes(s.tool)))
      finish(s, failure("CANCELLED"), "cancelled");
    if (defer("cancelled")) return;
    store.updateInquiry(inquiry_id, { status: "cancelled" });
    publish(ctx, emit, "inquiry.cancelled");
    return;
  }
  if (ctx.budget.remaining() <= 0) budgetExhausted = true;
  store.updateInquiry(inquiry_id, { status: "validating" });
  const report = plan.plan.find((s) => s.tool === "build_research_report");
  if (report) await run(report);
  const answer = plan.plan.find((s) => s.tool === "compose_answer");
  if (answer) await run(answer);
  if (ctx.signal.aborted) {
    if (store.inquiry(inquiry_id).status !== "cancelling")
      store.updateInquiry(inquiry_id, { status: "cancelling" });
    if (defer("cancelled")) return;
    store.updateInquiry(inquiry_id, { status: "cancelled" });
    publish(ctx, emit, "inquiry.cancelled");
    return;
  }
  if (ctx.budget.remaining() <= 0) budgetExhausted = true;
  const status = failed || budgetExhausted ? "incomplete" : "completed";
  if (defer("incomplete")) return;
  store.updateInquiry(inquiry_id, {
    status,
    error_code: budgetExhausted
      ? "BUDGET_EXHAUSTED"
      : failed
        ? "STEP_FAILED"
        : null,
  });
  publish(ctx, emit, "inquiry." + status, {
    artifact_refs: [...artifacts],
    snapshot_refs: [...snapshots],
  });
}
