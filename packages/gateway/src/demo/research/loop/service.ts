import type { LoopRevisionCommand } from '@trading-swarm/contracts';
import { commandPlan, revisionContext } from './revisions.js';
import type { Brain } from "../../brain.js";
import type { MarketData } from "../data/index.js";
import type * as Analyses from "../data/analyses.js";
import {
  LoopStore,
  TERMINAL,
  DEFAULT_BUDGET,
  type LoopContext,
  type LoopBudget,
} from "./store.js";
import { Budget } from "./budget.js";
import { check } from "./schema.js";
import { canonical } from "../primitives.js";
function mergeContext(
  base: LoopContext,
  patch: Partial<LoopContext> = {},
): LoopContext {
  const next: Record<string, unknown> = { ...base, ...patch };
  for (const [k, v] of Object.entries(next)) if (v === null) delete next[k];
  next.instrument_refs ??= [];
  return check("Context", next);
}
import {
  createToolRegistry,
  type ToolContext,
  type ToolRegistry,
} from "./tools.js";
import { makePlan } from "./planner.js";
import { executePlan, publish, type Emit } from "./executor.js";
import type { BacktestBridge } from "./backtest.js";
export interface LoopOptions {
  market: MarketData;
  brain?: Brain | (() => Brain | undefined);
  analyses?: typeof Analyses;
  backtests?: BacktestBridge;
  registry?: ToolRegistry;
  emit?: Emit;
  budget?: LoopBudget;
  now?: () => number;
  recover?: boolean;
}
export class LoopService {
  readonly registry: ToolRegistry;
  private stopping = new Map<
    string,
    { target: "cancelled" | "incomplete"; promise: Promise<void> }
  >();
  private jobs = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  constructor(
    readonly store: LoopStore,
    readonly options: LoopOptions,
  ) {
    this.registry = options.registry ?? createToolRegistry();
    if (options.recover !== false) store.recover();
  }
  private validateContext(session_id: string, context: LoopContext): void {
    if (
      context.selected_inquiry_id &&
      this.store.inquiry(context.selected_inquiry_id).session_id !== session_id
    )
      throw Error("context_inquiry_conflict");
    if (context.selected_artifact_id) {
      const a = this.store.artifact(context.selected_artifact_id);
      if (
        !a.inquiry_id ||
        this.store.inquiry(a.inquiry_id).session_id !== session_id
      )
        throw Error("context_artifact_conflict");
    }
  }
  context(id: string, patch: Partial<LoopContext>) {
    const context = mergeContext(this.store.session(id).context, patch);
    this.validateContext(id, context);
    return this.store.updateSession(id, { context });
  }
  ask(
    session_id: string,
    text: string,
    idempotency_key: string,
    context?: Partial<LoopContext>,
  ) {
    const prior = this.store.byKey(idempotency_key);
    if (prior)
      return this.store.createInquiry(session_id, text, idempotency_key);
    const selectedRun = context?.selected_run_id ?? this.store.session(session_id).context.selected_run_id;
    if (selectedRun && /^(?:请)?(?:优化(?:一下)?|修改|调整|把.+改成|将.+改为)/.test(text.trim())) {
      return this.command(session_id, { mode: text.includes("优化") ? "optimize" : "revise", baseline_run_id: selectedRun, instruction: text, max_candidates: 1 }, idempotency_key);
    }
    let merged = mergeContext(this.store.session(session_id).context, context);
    this.validateContext(session_id, merged);
    // Explicit selected evidence pins follow-up windows/instruments to that immutable inquiry.
    const selected = merged.selected_artifact_id
      ? this.store.artifact(merged.selected_artifact_id).inquiry_id
      : merged.selected_inquiry_id;
    if (selected) {
      const parent = this.store.inquiry(selected);
      merged = {
        ...merged,
        selected_inquiry_id: selected,
        instrument_refs: merged.instrument_refs.length
          ? merged.instrument_refs
          : parent.plan.instruments,
        selected_window: merged.selected_window ?? parent.plan.window,
      };
    }
    const response = this.store.createInquiry(
      session_id,
      text,
      idempotency_key,
      merged,
      this.options.budget ?? DEFAULT_BUDGET,
    );
    const emit = this.options.emit ?? (() => {});
    try {
      emit(this.store.event(response.inquiry.id, "inquiry.queued"));
    } catch {}
    this.launch(response.inquiry.id, text);
    return response;
  }
  command(session_id: string, raw: unknown, idempotency_key: string) {
    const command = check<LoopRevisionCommand>("RevisionCommand", raw);
    if (command.mode !== "optimize" && command.max_candidates !== 1) throw Error("invalid_candidate_limit");
    if (command.mode !== "rerun" && command.execution_overrides && Object.keys(command.execution_overrides).length) throw Error("invalid_execution_override");
    const prior = this.store.byKey(idempotency_key);
    if (prior) {
      if (prior.session_id !== session_id || canonical(prior.plan.command) !== canonical(command)) throw Error("idempotency_conflict");
      return this.store.createInquiry(session_id, prior.question, idempotency_key);
    }
    if (!this.options.backtests) throw Error("backtest_service_unavailable");
    revisionContext(this.options.backtests, command.baseline_run_id);
    const plan = commandPlan(command, this.options.backtests);
    const budget = { ...(this.options.budget ?? DEFAULT_BUDGET), max_backtests: Math.min(command.max_candidates, this.options.budget?.max_backtests ?? 2) };
    const context = { ...this.store.session(session_id).context, selected_run_id: command.baseline_run_id };
    const response = this.store.createInquiry(session_id, command.instruction, idempotency_key, context, budget);
    this.store.updateInquiry(response.inquiry.id, { plan, task_kind: "validate" });
    try { this.options.emit?.(this.store.event(response.inquiry.id, "inquiry.queued")); } catch { /* Persisted state remains authoritative. */ }
    this.launch(response.inquiry.id, command.instruction);
    return { ...response, inquiry: this.store.inquiry(response.inquiry.id) };
  }
  answer(id: string, text: string) {
    const q = this.store.inquiry(id);
    if (q.status !== "awaiting_input")
      throw Error("inquiry_not_awaiting_input");
    if (typeof text !== "string" || !text.trim() || text.length > 20000)
      throw Error("invalid_message");
    this.store.appendMessage(
      q.session_id,
      "user",
      [{ kind: "text", text }],
      id,
    );
    this.store.updateInquiry(id, { status: "planning" });
    this.launch(id, q.question + "\n用户补充：" + text);
    return this.inquiry(id);
  }
  cancel(id: string) {
    const q = this.store.inquiry(id);
    if (TERMINAL.has(q.status)) return { status: q.status };
    if (q.status !== "cancelling")
      this.store.updateInquiry(id, { status: "cancelling" });
    const job = this.jobs.get(id);
    if (job) job.controller.abort();
    else if (this.stopping.has(id)) {
      this.stopping.get(id)!.target = "cancelled";
    } else {
      this.store.updateInquiry(id, { status: "cancelled" });
      try {
        this.options.emit?.(this.store.event(id, "inquiry.cancelled"));
      } catch {}
    }
    return { status: "cancelling" as const };
  }
  inquiry(id: string) {
    return { ...this.store.inquiry(id), steps: this.store.steps(id) };
  }
  session(id: string) {
    return {
      session: this.store.session(id),
      messages: this.store.messages(id),
      inquiries: this.store.inquiries(id).map((q) => this.inquiry(q.id)),
      artifacts: this.store.artifacts(id),
    };
  }
  async wait(id: string): Promise<void> {
    await this.jobs.get(id)?.promise;
    await this.stopping.get(id)?.promise;
  }
  private trackStopping(
    id: string,
    target: "cancelled" | "incomplete",
    run_id: string,
  ): void {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
      }),
      state = { target, promise };
    this.stopping.set(id, state);
    const poll = () => {
      try {
        const q = this.store.inquiry(id);
        if (TERMINAL.has(q.status)) {
          this.stopping.delete(id);
          resolve();
          return;
        }
        const active = this.options.backtests?.activeRun(id);
        if (active) {
          const timer = setTimeout(poll, 50);
          timer.unref();
          return;
        }
        this.store.updateInquiry(id, {
          status: state.target,
          error_code: state.target === "incomplete" ? "BUDGET_EXHAUSTED" : null,
        });
        try {
          this.options.emit?.(
            this.store.event(id, "inquiry." + state.target, {
              run_id,
              external_run_stopped: true,
            }),
          );
        } catch {}
        this.stopping.delete(id);
        resolve();
      } catch {
        this.stopping.delete(id);
        resolve();
      }
    };
    const timer = setTimeout(poll, 0);
    timer.unref();
  }
  private launch(id: string, question: string): void {
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => this.run(id, question, controller.signal))
      .finally(() => {
        this.jobs.delete(id);
      });
    this.jobs.set(id, { controller, promise });
  }
  private async run(
    id: string,
    question: string,
    signal: AbortSignal,
  ): Promise<void> {
    const q = this.store.inquiry(id),
      now = this.options.now ?? this.store.now,
      emit = this.options.emit ?? (() => {});
    const budget = new Budget(q.budget, now, q.usage, (usage) => {
      this.store.updateInquiry(id, { usage });
      try {
        emit(this.store.event(id, "usage.updated", { usage }));
      } catch {}
    });
    let brain: Brain | undefined;
    try {
      brain =
        typeof this.options.brain === "function"
          ? this.options.brain()
          : this.options.brain;
    } catch {
      /* Offline planner and answer remain usable. */
    }
    const ctx: ToolContext = {
      inquiry_id: id,
      deferCompletion: (status, run_id) =>
        this.trackStopping(id, status, run_id),
      step_id: "planning",
      signal,
      store: this.store,
      budget,
      brain,
      market: this.options.market,
      analyses: this.options.analyses,
      backtests: this.options.backtests,
      now,
      context: this.store.session(q.session_id).context,
    };
    try {
      if (signal.aborted) throw Error("CANCELLED");
      if (q.status === "queued")
        this.store.updateInquiry(id, { status: "planning" });
      publish(ctx, emit, "inquiry.planning");
      const plan = q.plan.command ? q.plan : await makePlan(question, ctx.context!, this.registry, ctx);
      if (!plan.clarify && !plan.plan.some((s) => s.tool === "build_research_report")) {
        let key = 'saved_report';
        while (plan.plan.some((s) => s.key === key)) key += '_';
        plan.plan.splice(Math.max(0, plan.plan.findIndex((s) => s.tool === 'compose_answer')), 0, { key, title: '整理证据与研究报告', tool: 'build_research_report', args: {}, depends_on: plan.plan.filter((s) => s.tool !== 'compose_answer').map((s) => s.key) });
      }
      // 预算在建 inquiry 时就定了(默认 1 次回测),而「A 策略 + B 策略」的计划要跑两次;按计划里的回测步数放宽,上限 4
      const backtests = plan.plan.filter((s) => s.tool === "run_backtest").length;
      if (backtests > budget.limits.max_backtests) {
        budget.limits.max_backtests = Math.min(4, backtests);
        this.store.updateInquiry(id, { budget: { ...budget.limits } });
      }
      if (signal.aborted) throw Error("CANCELLED");
      this.store.updateInquiry(id, { plan, task_kind: plan.task_kind });
      publish(
        ctx,
        emit,
        "inquiry.plan",
        plan as unknown as Record<string, unknown>,
      );
      this.store.appendMessage(
        q.session_id,
        "assistant",
        [
          {
            kind: "plan",
            task_kind: plan.task_kind,
            steps: plan.plan.map((s) => ({
              key: s.key,
              title: s.title,
              tool: s.tool,
              status: "pending",
            })),
          },
        ],
        id,
      );
      if (plan.clarify) {
        this.store.updateInquiry(id, { status: "awaiting_input" });
        this.store.appendMessage(
          q.session_id,
          "assistant",
          [{ kind: "text", text: plan.clarify }],
          id,
        );
        publish(ctx, emit, "inquiry.awaiting_input", { clarify: plan.clarify });
        return;
      }
      this.store.updateInquiry(id, { status: "running" });
      await executePlan(plan, this.registry, ctx, emit);
      // Next ordinary follow-up reuses these immutable references, without an extra data call on refresh.
      if (!signal.aborted && TERMINAL.has(this.store.inquiry(id).status)) {
        const latest = this.store.session(q.session_id).context;
        if (canonical(latest) === canonical(ctx.context))
          this.store.updateSession(q.session_id, {
            context: {
              ...latest,
              ...(!plan.command ? (() => {
                const run = this.store.steps(id).find((s) => s.tool === "run_backtest" && s.status === "succeeded");
                const runId = (run?.output_summary.result as any)?.output?.run_id;
                return typeof runId === "string" ? { selected_run_id: runId } : {};
              })() : {}),
              selected_inquiry_id: id,
              instrument_refs: plan.instruments.length ? plan.instruments : latest.instrument_refs,
              selected_window: plan.window,
            },
          });
      }
    } catch (e) {
      const current = this.store.inquiry(id);
      if (TERMINAL.has(current.status)) return;
      if (signal.aborted) {
        if (current.status !== "cancelling")
          this.store.updateInquiry(id, { status: "cancelling" });
        this.store.updateInquiry(id, { status: "cancelled" });
        publish(ctx, emit, "inquiry.cancelled");
      } else {
        const exhausted = String(e).includes("BUDGET_EXHAUSTED");
        this.store.updateInquiry(id, {
          status: exhausted ? "incomplete" : "failed",
          error_code: exhausted ? "BUDGET_EXHAUSTED" : "LOOP_ERROR",
          error: String(e),
        });
        publish(
          ctx,
          emit,
          exhausted ? "inquiry.incomplete" : "inquiry.failed",
          { error: String(e) },
        );
      }
    }
  }
}
