import { prepareRevision, runRevision, compareRuns, buildReport } from './revisions.js';
import type { StrategyCompileResult } from "@trading-swarm/contracts";
import type { Brain } from "../../brain.js";
import type {
  LoopTaskKind,
  LoopBlocks,
  LoopSpec,
  LoopArtifact,
  LoopConcept,
  LoopErrorCode,
  LoopResult,
  ResearchBar,
} from "@trading-swarm/contracts";
import type {
  MarketData,
  Coverage,
  SnapshotDraft,
  Instrument,
  Window,
} from "../data/index.js";
import * as analyses from "../data/analyses.js";
import { canonical } from "../primitives.js";
import { registry as primitives } from "../primitives/index.js";
import { registerDataTools } from "../data/loop-tools.js";
import { resolveDataConcept as catalogResolve } from "../data/catalog.js";
import { registerPineTools } from "../pine/loop-tools.js";
import { registerSweepTools } from "./sweep.js";
import { diagnoseReport } from "./diagnose.js";
import { reflectionPrompt } from "./skills.js";
import { diagnoseContextFor, reviewNotes, numberCorpus, groundText, EXECUTION_NARRATIVE } from "./reflection.js";
import { CHART_VERSION, STEP_TEMPLATES, buildChart, pickCharts, type AnswerKind } from "./charts.js";
import { getBacktestReport } from "../backtest-report.js";
import { centerStats, centerText } from "../analyzer.js";
import { pineCatalog } from "../pine/catalog.js";
import { setDataConceptResolver } from "./concepts.js";
import {
  acquireConcept,
  acquiredToConcept,
  type ConceptCategory,
} from "./concepts.js";
import { LoopStore, type LoopContext } from "./store.js";
import { check, schema, schemaDocument, validator, type JSONSchema } from "./schema.js";
import { Budget, bounded, type BudgetClass } from "./budget.js";
import type { BacktestBridge } from "./backtest.js";
export type TaskKind = LoopTaskKind;
export type ToolResult<O = unknown> = Omit<
  LoopResult,
  "output" | "coverage"
> & { output: O | null; coverage?: Coverage };
export interface ToolContext {
  deferCompletion?: (
    status: "cancelled" | "incomplete",
    run_id: string,
  ) => void;
  inquiry_id: string;
  step_id: string;
  signal: AbortSignal;
  store: LoopStore;
  budget: Budget;
  brain?: Brain;
  now(): number;
  market: MarketData;
  analyses?: typeof analyses;
  backtests?: BacktestBridge;
  context?: LoopContext;
  registry?: ToolRegistry;
  progress?: (summary: Record<string, unknown>) => void;
}
export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  version: string;
  task_kinds: TaskKind[];
  asset_classes: ("crypto" | "equity")[];
  access: "read" | "compute" | "create_run";
  budget_class: BudgetClass;
  timeout_ms: number;
  idempotent: boolean;
  cancellable: boolean;
  input: JSONSchema;
  output: JSONSchema;
  run(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}
export function result<O>(
  output: O,
  extra: Partial<ToolResult<O>> = {},
): ToolResult<O> {
  return {
    status: "ok",
    output,
    snapshot_refs: [],
    artifact_refs: [],
    warnings: [],
    latency_ms: 0,
    ...extra,
  };
}
export function failure(
  code: LoopErrorCode,
  note: string = code,
  retryable = false,
): ToolResult {
  return result(null, {
    status: "error",
    error_code: code,
    retryable,
    warnings: [note],
  });
}
function classify(e: unknown): ToolResult {
  const msg = e instanceof Error ? e.message : String(e);
  const known = [
    "UNSUPPORTED_ASSET",
    "DATA_MISSING",
    "DATA_STALE",
    "RATE_LIMIT",
    "BUDGET_EXHAUSTED",
    "SCHEMA_MISMATCH",
    "UNIT_MISMATCH",
    "NOT_COMPARABLE",
    "CANCELLED",
    "TIMEOUT",
    "PROVIDER_ERROR",
  ] as LoopErrorCode[];
  const code =
    known.find((c) => msg.includes(c)) ??
    (/429|rate.?limit/i.test(msg)
      ? "RATE_LIMIT"
      : /abort/i.test(msg)
        ? "CANCELLED"
        : "PROVIDER_ERROR");
  return failure(
    code,
    msg,
    code === "RATE_LIMIT" || code === "TIMEOUT" || code === "PROVIDER_ERROR",
  );
}
function live(ctx: ToolContext): void {
  if (ctx.signal.aborted) throw Error("CANCELLED");
}
function evidenceScope(ctx: ToolContext) {
  const current = ctx.store.inquiry(ctx.inquiry_id),
    snapshots = new Set(current.checkpoint.snapshot_refs),
    artifacts = new Set(current.checkpoint.artifact_refs);
  const selected = ctx.context?.selected_artifact_id
    ? ctx.store.artifact(ctx.context.selected_artifact_id).inquiry_id
    : ctx.context?.selected_inquiry_id;
  if (selected) {
    const parent = ctx.store.inquiry(selected);
    if (parent.session_id !== current.session_id)
      throw Error("SCHEMA_MISMATCH:foreign_inquiry");
    for (const id of parent.checkpoint.snapshot_refs) snapshots.add(id);
    for (const id of parent.checkpoint.artifact_refs) artifacts.add(id);
  }
  return { snapshots, artifacts, selected };
}
function checkEvidence(input: unknown, ctx: ToolContext): void {
  const scope = evidenceScope(ctx),
    args = input as Record<string, unknown>;
  for (const [key, value] of Object.entries(args)) {
    const ids =
      key === "snapshot_refs"
        ? (value as string[])
        : key.endsWith("_snapshot")
          ? [value as string]
          : [];
    for (const id of ids)
      if (!scope.snapshots.has(id))
        throw Error("SCHEMA_MISMATCH:unbound_snapshot");
    if (key === "artifact_ids")
      for (const id of value as string[])
        if (!scope.artifacts.has(id))
          throw Error("SCHEMA_MISMATCH:unbound_artifact");
  }
}
const clone = <T>(x: T): T => structuredClone(x);
export class ToolRegistry {
  private definitions = new Map<string, ToolDefinition<any, any>>();
  private cache = new Map<string, ToolResult>();
  private pending = new Map<string, Promise<ToolResult>>();
  register<I, O>(def: ToolDefinition<I, O>): this {
    if (this.definitions.has(def.name)) throw Error("duplicate_tool");
    validator(def.input);
    validator(def.output);
    this.definitions.set(def.name, def);
    return this;
  }
  get(name: string): ToolDefinition<any, any> | undefined {
    return this.definitions.get(name);
  }
  catalog() {
    return [...this.definitions.values()].map(({ run: _, ...d }) => ({
      ...d,
      input: schemaDocument(d.input),
      output: schemaDocument(d.output),
    }));
  }
  async call(
    name: string,
    input: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const def = this.get(name);
    if (!def) return failure("SCHEMA_MISMATCH", "unknown_tool");
    try {
      check("Json", input);
      if (!validator(def.input)(input))
        return failure("SCHEMA_MISMATCH", "invalid_tool_input");
      if (ctx.signal.aborted) return failure("CANCELLED");
      checkEvidence(input, ctx);
      if (!def.task_kinds.includes(ctx.store.inquiry(ctx.inquiry_id).task_kind))
        return failure("SCHEMA_MISMATCH", "tool_task_kind_mismatch");
    } catch (e) {
      return classify(e);
    }
    const canonicalInput = canonical(input),
      key = ctx.inquiry_id + ":" + name + ":" + canonicalInput;
    if (def.idempotent) {
      const prior =
        this.cache.get(key) ??
        ctx.store.cached(ctx.inquiry_id, name, canonicalInput);
      if (prior)
        return { ...clone(prior), warnings: [...prior.warnings, "cache_hit"] };
      const scope = evidenceScope(ctx);
      if (
        scope.selected &&
        ["resolve_instruments", "inspect_data_coverage"].includes(name)
      ) {
        const cached = ctx.store.cached(scope.selected, name, canonicalInput);
        if (cached)
          return {
            ...clone(cached),
            warnings: [...cached.warnings, "cache_hit", "snapshot reused"],
          };
      }
      const kinds: Record<string, SnapshotDraft["kind"]> = {
        get_price_history: "price",
        get_funding_history: "funding",
        get_open_interest: "open_interest",
        get_liquidations: "liquidations",
      };
      if (kinds[name]) {
        const snapshot = reuse(ctx, kinds[name]!, input as DataInput);
        if (snapshot) return snapshotResult(snapshot, true);
      }
      const pending = this.pending.get(key);
      if (pending) {
        const reused = await pending;
        return {
          ...clone(reused),
          warnings: [...reused.warnings, "cache_hit"],
        };
      }
    }
    const operation = this.execute(def, input, ctx).then((r) => {
      if (def.idempotent && r.status !== "error") this.cache.set(key, clone(r));
      return r;
    });
    this.pending.set(key, operation);
    try {
      return await operation;
    } finally {
      this.pending.delete(key);
    }
  }
  private async execute(
    def: ToolDefinition<any, any>,
    input: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const started = ctx.now(),
      errors = new Map<string, number>();
    let r: ToolResult = failure("PROVIDER_ERROR");
    // 数据调用按每次真实 provider 调用扣预算(重试也扣);回测只按「一次调用」扣:max_backtests=1 时第一次失败后重试若再扣,
    // 会把真实错误盖成 BUDGET_EXHAUSTED(2026-09-22 联调实测),而重试本身有幂等键、不会再起付费 run。
    // compose is guaranteed even after exhaustion; its budgeted brain falls back to a code template.
    if (def.budget_class === "backtest") {
      try {
        ctx.budget.take("backtest");
      } catch (e) {
        return { ...failure("BUDGET_EXHAUSTED"), latency_ms: ctx.now() - started, warnings: [String(e instanceof Error ? e.message : e)] };
      }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (!["compose_answer", "build_research_report"].includes(def.name) && def.budget_class !== "backtest") {
          try {
            ctx.budget.take(def.budget_class === "model_call" ? "none" : def.budget_class);
          } catch (e) {
            // 重试前预算用尽:保留上一次的真实错误,只补一条 warning,不把它改写成 BUDGET_EXHAUSTED
            if (attempt > 0) { r = { ...r, warnings: [...r.warnings, "retry_skipped:BUDGET_EXHAUSTED"] }; break; }
            throw e;
          }
        }
        const timeout = Math.min(def.timeout_ms, ctx.budget.remaining());
        const invoke = async (signal: AbortSignal) =>
          def.run(input, {
            ...ctx,
            signal,
            brain: ctx.budget.brain(ctx.brain, signal),
            registry: this,
          });
        r =
          ["compose_answer", "build_research_report"].includes(def.name)
            ? await def.run(input, {
                ...ctx,
                brain:
                  timeout <= 0
                    ? undefined
                    : ctx.budget.brain(ctx.brain, ctx.signal),
                registry: this,
              })
            : await bounded(
                (signal) =>
                  invoke(
                    def.cancellable
                      ? signal
                      : AbortSignal.any([ctx.signal, signal]),
                  ),
                timeout,
                def.cancellable ? ctx.signal : new AbortController().signal,
              );
        check("Result", r);
        if (r.output !== null && !validator(def.output)(r.output))
          r = failure("SCHEMA_MISMATCH", "invalid_tool_output");
      } catch (e) {
        r = classify(e);
      } finally {
        ctx.budget.record();
      }
      if (r.status !== "error" || !r.retryable) break;
      const code = r.error_code ?? "PROVIDER_ERROR",
        count = (errors.get(code) ?? 0) + 1;
      errors.set(code, count);
      if (count >= 2) break;
    }
    return { ...r, latency_ms: Math.max(0, Math.floor(ctx.now() - started)) };
  }
}
function def<I, O>(
  name: string,
  input: string,
  output: string,
  run: ToolDefinition<I, O>["run"],
  options: Partial<ToolDefinition<I, O>> = {},
): ToolDefinition<I, O> {
  return {
    name,
    version: "1",
    task_kinds: ["market", "compare", "validate", "diagnose"],
    asset_classes: ["crypto"],
    access: "compute",
    budget_class: "none",
    timeout_ms: 30000,
    idempotent: true,
    cancellable: true,
    input: schema(input),
    output: schema(output),
    run,
    ...options,
  };
}
type DataInput = {
  instrument: Instrument;
  window: Window;
  timeframe?: string;
  metric?: Parameters<MarketData["coverage"]>[1];
};
function referencedSnapshot(ctx: ToolContext, id: string): SnapshotDraft {
  return ctx.store.snapshot(id);
}
function reuse(
  ctx: ToolContext,
  kind: SnapshotDraft["kind"],
  input: DataInput,
): ReturnType<LoopStore["snapshot"]> | null {
  const selected = ctx.context?.selected_artifact_id
    ? ctx.store.artifact(ctx.context.selected_artifact_id)
    : null;
  const parent = ctx.context?.selected_inquiry_id
    ? ctx.store.inquiry(ctx.context.selected_inquiry_id)
    : null;
  const current = ctx.store.inquiry(ctx.inquiry_id);
  if (
    selected &&
    selected.inquiry_id &&
    ctx.store.inquiry(selected.inquiry_id).session_id !== current.session_id
  )
    throw Error("SCHEMA_MISMATCH:foreign_artifact");
  if (parent && parent.session_id !== current.session_id)
    throw Error("SCHEMA_MISMATCH:foreign_inquiry");
  const ids = selected?.snapshot_refs ?? parent?.checkpoint.snapshot_refs ?? [];
  return (
    ids
      .map((id) => ctx.store.snapshot(id))
      .find(
        (s) =>
          s.kind === kind &&
          s.instrument.canonical_id === input.instrument.canonical_id &&
          canonical(s.requested_window) === canonical(input.window) &&
          (!input.timeframe ||
            kind === "funding" ||
            kind === "liquidations" ||
            s.frequency === input.timeframe),
      ) ?? null
  );
}
function snapshotResult(
  s: ReturnType<LoopStore["snapshot"]>,
  cached = false,
): ToolResult {
  return result(
    { snapshot_id: s.id },
    {
      snapshot_refs: [s.id],
      status: s.coverage === "available" ? "ok" : s.coverage,
      coverage: { availability: s.coverage, note: s.quality_flags.join(";") },
      units: s.units,
      warnings: [
        ...s.quality_flags,
        ...(cached ? ["cache_hit", "snapshot reused"] : []),
      ],
    },
  );
}

/** 模型/规划器常写的别名 → 快照真实字段名;找不到就原样返回,让 validateSpec 报 unknown_field。 */
const FIELD_ALIASES: Record<string, string> = { open_interest: "oi_value_usd", oi: "oi_value_usd", openinterest: "oi_value_usd", open_interest_usd: "oi_value_usd", funding: "rate", funding_rate: "rate", fundingrate: "rate", price: "close", time: "ts", timestamp: "ts", date: "ts" };
function humanizeGap(tool: unknown, r: ToolResult): string | null {
  const trunc = r.warnings.map((w) => /^truncated_to_recent_(\d+)$/.exec(w)).find(Boolean);
  if (tool === "get_liquidations" && trunc) return `OKX 公共接口只提供最近 ${trunc[1]} 条强平记录,窗口未完整覆盖;窗口内已记录的部分是真实成交`;
  if (tool === "get_liquidation_estimates") return "潜在清算区域(估计热图):估计数据源尚未接入;不用 K 线或成交量伪造";
  if (tool === "render_artifact" && r.error_code === "SCHEMA_MISMATCH") return "图表字段与数据不匹配,这张图没有生成;其余产物不受影响";
  if (r.status === "not_applicable" && r.coverage?.note) return r.coverage.note;
  return null;
}
export function normalizeSpecFields(spec: LoopSpec, rows: Record<string, unknown>[]): LoopSpec {
  const has = (f: string) => rows.some((r) => Object.hasOwn(r, f));
  const fix = (f: string): string => { if (has(f)) return f; const a = FIELD_ALIASES[f.toLowerCase()]; if (a && has(a)) return a; if ((f === "ts" || f === "time") && has("close_time")) return "close_time"; if (f === "close_time" && has("ts")) return "ts"; return f; };
  const out: LoopSpec = { ...spec };
  if (out.x) out.x = fix(out.x);
  if (typeof out.y === "string") out.y = fix(out.y); else if (Array.isArray(out.y)) out.y = out.y.map(fix);
  if (typeof out.series === "string") out.series = fix(out.series); else if (Array.isArray(out.series)) out.series = out.series.map((x) => ({ ...x, field: fix(x.field) }));
  return out;
}
/** Keep measured values in their original units. Independent axes share the time window. */
export function materializeChart(spec: LoopSpec, snapshots: SnapshotDraft[], rowsOverride?: Record<string, unknown>[]): Record<string, unknown> {
  const rows = rowsOverride ?? snapshots.flatMap((s) => s.rows as Record<string, unknown>[]);
  const x = spec.x ?? "ts";
  const ys = typeof spec.y === "string" ? [spec.y] : (spec.y ?? []);
  const series = typeof spec.series === "string" ? [{ field: spec.series } as { field: string; axis?: string; label?: string }] : (spec.series ?? []);
  const fields = [...new Set([...series.map((q) => q.field), ...ys])].filter((f) => f !== x);
  const unitOf = (f: string) => snapshots.find((q) => q.units[f])?.units[f] ?? (["open", "high", "low", "close"].includes(f) ? snapshots.find((q) => q.units["price"])?.units["price"] : undefined) ?? (f === "rate" || f === "funding_rate" ? "fraction_per_8h" : f === "oi_value_usd" ? "USD" : "");
  const units = fields.map(unitOf);
  const out = fields.map((field, i) => {
    const entry = series.find((q) => q.field === field);
    // A row from another snapshot is absent, not a missing observation. An explicit null is a gap.
    const points = rows.filter((r) => Object.hasOwn(r, field) && r[x] != null && r[x] !== "" && Number.isFinite(Number(r[x])))
      .map((r) => [Number(r[x]), r[field] == null || r[field] === "" || !Number.isFinite(Number(r[field])) ? null : Number(r[field])] as [number, number | null])
      .sort((a, b) => a[0] - b[0]);
    return { name: entry?.label ?? field, field, unit: units[i], axis: entry?.axis ?? "y", points, transformed: false };
  });
  const panels = new Set(out.map((s) => s.axis)).size > 1 || new Set(units.filter(Boolean)).size > 1 || (fields.includes("close") && fields.includes("oi_value_usd"));
  return {
    kind: "chart", type: spec.type === "bar" ? "bar" : "line", x: "time",
    layout: panels ? "panels" : "overlay", series: out, y_label: panels ? "" : (units[0] ?? ""),
    note: panels ? "各图保留原始单位，使用独立纵轴和同一时间范围；缺失观测不补零。" : "",
    rows: rows.slice(0, 5000),
  };
}
export function validateSpec(spec: LoopSpec, snapshots: SnapshotDraft[]): void {
  check("Spec", spec);
  if (
    !["table", "comparison"].includes(spec.type) &&
    (!spec.x || (!spec.y && !spec.series))
  )
    throw Error("SCHEMA_MISMATCH:chart_fields_required");
  const rows = snapshots.flatMap((s) => s.rows);
  if (!rows.length) throw Error("DATA_MISSING:no_rows");
  const ys = typeof spec.y === "string" ? [spec.y] : (spec.y ?? []);
  const series =
    typeof spec.series === "string"
      ? [{ field: spec.series, axis: "y" }]
      : (spec.series ?? []);
  const fields = [
    ...(spec.x ? [spec.x] : []),
    ...ys,
    ...series.map((s) => s.field),
    ...(spec.type === "candlestick" ? ["open", "high", "low", "close"] : []),
  ];
  for (const field of fields)
    if (!rows.some((row) => Object.hasOwn(row, field)))
      throw Error(`SCHEMA_MISMATCH:unknown_field:${field}`);
  const axes = new Map<string, string>();
  for (const entry of [
    ...series,
    ...ys
      .filter((field) => !series.some((s) => s.field === field))
      .map((field) => ({ field, axis: "y" })),
  ]) {
    const field = entry.field;
    const units = new Set(
      snapshots
        .filter((s) => s.rows.some((row) => Object.hasOwn(row, field)))
        .map(
          (s) =>
            s.units[field] ??
            (["open", "high", "low", "close"].includes(field)
              ? s.units.price
              : undefined),
        )
        .filter((x): x is string => !!x),
    );
    if (units.size > 1) throw Error("UNIT_MISMATCH:field_units");
    const unit = [...units][0];
    if (!unit) continue;
    const axis = entry.axis ?? "y";
    const prior = axes.get(axis);
    if (prior && prior !== unit) throw Error("UNIT_MISMATCH:shared_axis");
    if (spec.axis_units?.[axis] && spec.axis_units[axis] !== unit)
      throw Error("UNIT_MISMATCH:declared_axis");
    axes.set(axis, unit);
  }
}
function metricsIn(value: unknown, path = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (
      "value" in o &&
      typeof o.unit === "string" &&
      typeof o.status === "string"
    )
      out[path] = o;
    else
      for (const [key, child] of Object.entries(o))
        Object.assign(out, metricsIn(child, path ? path + "." + key : key));
  }
  return out;
}
function analysisArtifact(
  ctx: ToolContext,
  title: string,
  output: unknown,
  refs: string[],
  run_id?: string,
  extra?: Record<string, unknown>,
): ToolResult {
  live(ctx);
  check("Object", output);
  const q = ctx.store.inquiry(ctx.inquiry_id);
  const metrics = metricsIn(output);
  check("Metrics", metrics);
  const table = ctx.store.putArtifact({
    inquiry_id: ctx.inquiry_id,
    kind: "table",
    title,
    question: q.question,
    snapshot_refs: refs,
    data_kind: "derived",
    availability: Object.values(metrics).some((m: any) => m.status !== "ok")
      ? "partial"
      : "available",
    spec: { type: "table" },
    caption: "确定性分析；数值来自引用快照或不可变回测。",
    content: check("Object", {
      kind: "table",
      columns: ["指标", "值", "单位", "状态"],
      rows: Object.entries(metrics).map(([id, m]) => {
        const metric = m as {
          value: number | null;
          unit: string;
          status: string;
        };
        const matched = /^rows\.(\d+)\.(.+)$/.exec(id);
        const label = matched
          ? String(
              (output as any).rows?.[Number(matched[1])]?.canonical_id ??
                matched[1],
            ) +
            ":" +
            matched[2]
          : id;
        return [label, metric.value, metric.unit, metric.status];
      }),
      analysis: output,
      metrics,
      ...(extra ?? {}),
    }),
    ...(run_id ? { run_id } : {}),
  });
  return result(
    {
      analysis: output,
      metrics: Object.fromEntries(
        Object.entries(metrics).map(([k, v]) => [table.id + ":" + k, v]),
      ),
    },
    { artifact_refs: [table.id], snapshot_refs: refs },
  );
}
/**
 * 编译出的 IR 若引用了目录里不存在/未准入的 Pine 脚本(模型爱凭空造 script_id,2026-09-22 实测 coppock_curve),
 * 就地让 pine_author 按 unmapped 里的描述写脚本并跑准入,通过后把真实 script_id/output/warmup 写回 IR 再重检;
 * 写不出来就把编译判失败并说明原因,不让它带着假引用进回测。
 */
async function ensurePineScripts(output: StrategyCompileResult, input: { timeframe: string; text?: string }, ctx: ToolContext, registry: ToolRegistry): Promise<StrategyCompileResult> {
  const ir = output.ir as any;
  if (!ir || !ctx.backtests || !registry.get("pine_author")) return output;
  const nodes: any[] = [...(ir.signal ?? []), ...(ir.exit ?? []), ...(ir.regime ? [ir.regime] : []), ...(ir.risk?.stop ? [ir.risk.stop] : [])];
  const refs = nodes.filter((n) => typeof n?.primitive === "string" && n.primitive.startsWith("pine_series") && n.params && typeof n.params.script_id === "string");
  if (!refs.length) return output;
  const catalog = pineCatalog();
  const notes = [...(output.unmapped ?? [])];
  let changed = false;
  for (const node of refs) {
    const id = String(node.params.script_id);
    const found = catalog?.find(id);
    if (found?.admitted) { if (found.id !== id) { node.params.script_id = found.id; changed = true; } continue; }
    const reuse = catalog?.search(id.replace(/[_-]+/g, " "), { limit: 1, admitted: true })?.[0];
    if (reuse) { node.params.script_id = reuse.id; if (!reuse.outputs?.includes(String(node.params.output))) node.params.output = reuse.outputs?.[0] ?? node.params.output; node.params.warmup_bars = Math.max(Number(node.params.warmup_bars) || 1, reuse.admission_report?.warmup_bars ?? 1); notes.push(`自动匹配:${id} 对应目录里已准入的脚本 ${reuse.name}(script_id=${reuse.id})`); changed = true; continue; }
    const hint = notes.find((n) => n.includes(id)) ?? `${id}:${JSON.stringify(node.params)}`;
    const concept = `${hint}\n用户原话:${input.text ?? ""}\n要求输出名为 ${node.params.output}`;
    const authored = await registry.call("pine_author", { concept, name: id, timeframe: input.timeframe }, ctx);
    const out = authored.output as { script_id?: string | null; admitted?: boolean; outputs?: string[]; warmup_bars?: number; reason?: string } | null;
    if (authored.status === "ok" && out?.script_id && out.admitted) {
      node.params.script_id = out.script_id;
      if (!out.outputs?.includes(String(node.params.output))) node.params.output = out.outputs?.[0] ?? node.params.output;
      node.params.warmup_bars = Math.max(Number(node.params.warmup_bars) || 1, Number(out.warmup_bars) || 1);
      notes.push(`自动获取:${id} 不在 Pine 目录里,已由 pine_author 写成脚本并通过准入(script_id=${out.script_id},output=${node.params.output})`);
      changed = true;
    } else {
      const why = authored.status === "ok" ? `准入未通过:${out?.reason ?? "unknown"}` : (authored.warnings[0] ?? authored.error_code ?? "pine_author_failed");
      notes.push(`Pine 脚本 ${id} 不在目录且未能自动生成:${why}`);
      return { ...output, ok: false, unmapped: notes, checks: [...output.checks, { name: "pine_script_ready", ok: false, message: `引用的 Pine 脚本 ${id} 不存在且未能自动生成:${why}` }] };
    }
  }
  if (!changed) return output;
  const rechecked = await ctx.backtests.compile({ ir, timeframe: input.timeframe }, ctx);
  return { ...rechecked, unmapped: notes };
}
export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    def(
      "resolve_instruments",
      "ResolveInput",
      "ResolveOutput",
      async (input: Parameters<MarketData["resolve"]>[0], ctx) => {
        const wanted = input.symbols ?? [];
        // 「BTC 永续」「BTC-USDT-SWAP」「okx:perp:BTC-USDT-SWAP」都解析成永续;「现货」/okx:spot: 解析成现货;都没写按 input.market,再没有就现货优先(2026-09-23 WP-F)
        const parse = (s: string) => {
          const perp = /:perp:|-SWAP\b|永续|合约|\bperp\b|\bswap\b/i.test(s), spot = /:spot:|现货|\bspot\b/i.test(s);
          const base = s.replace(/^okx:(spot|perp):/i, "").replace(/永续|合约|现货|\bperp\b|\bswap\b|\bspot\b/gi, " ").trim().toUpperCase().replace(/[-/:_\s].*$/, "").replace(/USDT$/, "");
          return { base, market: perp && !spot ? ("perp" as const) : spot && !perp ? ("spot" as const) : (input.market ?? null) };
        };
        const asked = wanted.map(parse), markets = new Set(asked.map((a) => a.market));
        const found = await ctx.market.resolve(
          {
            ...input,
            ...(wanted.length ? { symbols: asked.map((a) => a.base) } : {}),
            ...(wanted.length && (markets.size > 1 || markets.has(null)) ? { market: undefined } : wanted.length ? { market: [...markets][0]! } : {}),
          },
          ctx.signal,
        );
        if (!found.length)
          return failure("UNSUPPORTED_ASSET", "未找到受支持的在售资产");
        const instruments = wanted.length
          ? wanted
              .map((s, k) =>
                found.find((i) => i.canonical_id === s) ??
                found.find((i) => i.base === asked[k]!.base && (!asked[k]!.market || i.market_type === asked[k]!.market)),
              )
              .filter((i): i is Instrument => !!i)
          : found;
        if (wanted.length && instruments.length !== wanted.length)
          return failure("UNSUPPORTED_ASSET", "部分资产不受支持");
        return result({ instruments });
      },
      { access: "read", budget_class: "data_call" },
    ),
  );
  for (const [name, kind] of [
    ["get_price_history", "price"],
    ["get_funding_history", "funding"],
    ["get_open_interest", "open_interest"],
    ["get_liquidations", "liquidations"],
  ] as const) {
    registry.register(
      def(
        name,
        "DataInput",
        "SnapshotOutput",
        async (input: DataInput, ctx) => {
          const cached = reuse(ctx, kind, input);
          if (cached) return snapshotResult(cached, true);
          const d =
            kind === "price"
              ? await ctx.market.price(
                  input.instrument,
                  input.timeframe ?? "1h",
                  input.window,
                  ctx.signal,
                )
              : kind === "funding"
                ? await ctx.market.funding(
                    input.instrument,
                    input.window,
                    ctx.signal,
                  )
                : kind === "open_interest"
                  ? await ctx.market.openInterest(
                      input.instrument,
                      input.timeframe ?? "1h",
                      input.window,
                      ctx.signal,
                    )
                  : await ctx.market.liquidations(
                      input.instrument,
                      input.window,
                      ctx.signal,
                    );
          live(ctx);
          return snapshotResult(ctx.store.putSnapshot(d));
        },
        // 全窗口回测后价格历史动辄上万根(4h 六年约 1.3 万根,首次拉取约 70 秒),30 秒默认会超时
        { access: "read", budget_class: "data_call", ...(kind === "price" ? { timeout_ms: 240000 } : {}) },
      ),
    );
  }
  registry.register(
    def(
      "get_liquidation_estimates",
      "DataInput",
      "Object",
      async () =>
        result(
          { note: "估计数据源尚未接入" },
          {
            status: "missing",
            error_code: "DATA_MISSING",
            coverage: { availability: "missing", note: "估计数据源尚未接入" },
          },
        ),
      { access: "read" },
    ),
  );
  registry.register(
    def(
      "analyze_leverage",
      "LeverageInput",
      "AnalysisOutput",
      async (
        input: {
          price_snapshot: string;
          funding_snapshot?: string;
          oi_snapshot?: string;
          liquidations_snapshot?: string;
        },
        ctx,
      ) => {
        const refs = [
            input.price_snapshot,
            input.funding_snapshot,
            input.oi_snapshot,
            input.liquidations_snapshot,
          ].filter((x): x is string => !!x),
          snapshots = refs.map((id) => referencedSnapshot(ctx, id));
        const output = (ctx.analyses ?? analyses).analyzeLeverage(
          snapshots[0]!,
          input.funding_snapshot
            ? referencedSnapshot(ctx, input.funding_snapshot)
            : null,
          input.oi_snapshot ? referencedSnapshot(ctx, input.oi_snapshot) : null,
          input.liquidations_snapshot
            ? referencedSnapshot(ctx, input.liquidations_snapshot)
            : null,
        );
        const r = analysisArtifact(ctx, "价格与杠杆观察", output, refs);
        const fields = ["close", "oi_value_usd", "rate"].filter((field) =>
          snapshots.some((s) => s.rows.some((row) => field in row)),
        );
        if (
          fields.length &&
          snapshots.some((s) => s.rows.some((row) => "ts" in row))
        ) {
          const spec: LoopSpec = {
            type: "line",
            x: "ts",
            y: fields,
            series: fields.map((field) => ({ field, axis: field })),
          };
          validateSpec(spec, snapshots);
          live(ctx);
          const chart = ctx.store.putArtifact({
            inquiry_id: ctx.inquiry_id,
            kind: "chart",
            title: "价格、持仓量与资金费率",
            question: ctx.store.inquiry(ctx.inquiry_id).question,
            snapshot_refs: refs,
            data_kind: "derived",
            availability: r.artifact_refs.length
              ? ctx.store.artifact(r.artifact_refs[0]!).availability
              : "partial",
            spec,
            caption: "独立单位轴；缺失值保持空值。",
            content: check("Object", {
              ...materializeChart(spec, snapshots), title: "价格、持仓量与资金费率",
              metrics: (r.output as any).metrics,
            }),
          });
          r.artifact_refs.push(chart.id);
        }
        return r;
      },
    ),
  );
  registry.register(
    def(
      "analyze_relative_strength",
      "StrengthInput",
      "AnalysisOutput",
      async (
        input: {
          instruments: string[];
          benchmark: string;
          timeframe: string;
          window: Window;
          snapshot_refs?: string[];
        },
        ctx,
      ) => {
        const refs =
          input.snapshot_refs ??
          ctx.store.inquiry(ctx.inquiry_id).checkpoint.snapshot_refs;
        const prices = refs
          .map((id) => ctx.store.snapshot(id))
          .filter(
            (s) =>
              s.kind === "price" &&
              input.instruments.includes(s.instrument.canonical_id),
          );
        const benchmark = refs
          .map((id) => ctx.store.snapshot(id))
          .find(
            (s) =>
              s.kind === "price" &&
              s.instrument.canonical_id === input.benchmark,
          );
        if (!benchmark || !prices.length)
          throw Error("DATA_MISSING:price_snapshots_required");
        return analysisArtifact(
          ctx,
          "相对强弱比较",
          (ctx.analyses ?? analyses).analyzeRelativeStrength(prices, benchmark),
          [...new Set([...prices.map((s) => s.id), benchmark.id])],
        );
      },
      { task_kinds: ["compare"] },
    ),
  );
  registry.register(
    def(
      "compile_strategy",
      "CompileInput",
      "CompileOutput",
      async (input: any, ctx) => {
        if (!ctx.backtests) throw Error("DATA_MISSING:backtest_service");
        // 获取子 loop 的产物(定义 + 实现方式 + 已准入的 script_id)拼进编译文本,模型优先用它们而不是凭空造名字
        const acquired: any[] = Array.isArray(input.acquired) ? input.acquired.filter((a: unknown) => a && typeof a === "object") : [];
        const { acquired: _acquired, ...rest } = input;
        const text = rest.text && acquired.length
          ? rest.text + "\n\n已获取的概念(优先使用这些实现;implementation.kind=pine 且带 script_id 的用 pine_series 原语引用,output 用其 params.output):\n" +
            acquired.map((a) => `- ${a.concept}:${a.definition ?? ""} → ${JSON.stringify(a.implementation)}`).join("\n")
          : rest.text;
        let output = await ctx.backtests.compile({ ...rest, ...(text ? { text } : {}) }, ctx);
        live(ctx);
        output = await ensurePineScripts(output, rest, ctx, registry);
        if (!output.ok) {
          // 把真实原因带出去(哪项检查没过 / 模型输出没解析 / 规范 block),不能只说「需要澄清规则」
          const why = [
            ...output.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.message ?? ""}`),
            ...(output.ir ? [] : [`模型输出未能解析: ${output.summary.slice(0, 300)}`]),
            ...(output.unmapped ?? []).slice(0, 3),
          ];
          console.error("[research.loop] compile_strategy failed:", why.join(" | "));
          return { ...failure("SCHEMA_MISMATCH", "策略规则未能编译:" + why.join(";")), output, warnings: why } as ToolResult<StrategyCompileResult>;
        }
        return result(output);
      },
      {
        task_kinds: ["validate"],
        budget_class: "model_call",
        timeout_ms: 90000,
      },
    ),
  );
  registry.register(
    def(
      "run_backtest",
      "BacktestInput",
      "BacktestOutput",
      async (input: any, ctx) => {
        if (!ctx.backtests) throw Error("DATA_MISSING:backtest_service");
        const r = await ctx.backtests.run(input, ctx);
        const report_id = (r.output as { metrics?: { report_id?: string }[] } | null)?.metrics?.[0]?.report_id;
        const report = r.status === "ok" && report_id ? ctx.backtests.report((r.output as { run_id: string }).run_id) : null;
        if (!report) return r;
        // 全窗口报告挂成 table 产物(content.view=backtest_report + report_id),前端据此跳 Horizon 式面板;observation 进研究报告与答案
        const a = analysisArtifact(ctx, `${input.ir?.label ?? "策略"}:全窗口回测报告`, backtestAnalysis(report), input.price_snapshot ? [input.price_snapshot] : [], (r.output as { run_id: string }).run_id, { view: "backtest_report", report_id: report.id });
        // 研究图表(charts.ts,确定性):回测步只出权益曲线对比,其余由答案按问题现挑现算,避免一次回测刷出一串图
        const charts = ensureCharts(ctx, [report], STEP_TEMPLATES.run_backtest, input.price_snapshot ? [input.price_snapshot] : [], (r.output as { run_id: string }).run_id);
        return { ...r, artifact_refs: [...r.artifact_refs, ...a.artifact_refs, ...charts] };
      },
      {
        task_kinds: ["validate"],
        access: "create_run",
        budget_class: "backtest",
        timeout_ms: 600000,
        cancellable: false,
      },
    ),
  );
  // 诊断(零模型):从选中回测的全窗口报告里拆收益差的来源(敞口/退出方式/集中度/样本内外/成本/资产),每条带数值
  registry.register(
    def(
      "diagnose_backtest",
      "CompareInput",
      "AnalysisOutput",
      async (input: { run_id: string; arm: "a_rules" | "b_agent" | "c_filter" }, ctx) => {
        if (!ctx.backtests) throw Error("DATA_MISSING:backtest_service");
        const data = ctx.backtests.comparison({ run_id: input.run_id, arm: input.arm ?? "a_rules" });
        if (!data.report) throw Error("NOT_COMPARABLE:no_full_window_report_for_run");
        // 诊断 v2 要用户原话(忠实度比对)与同一策略的变体数(单一变体挑选提示),见 skills/research-reflection
        const dctx = diagnoseContextFor(data.report, ctx.store, ctx.inquiry_id, ctx.backtests.store);
        const a = analysisArtifact(ctx, "回测诊断", diagnoseReport(data.report, dctx), data.snapshot_refs, input.run_id, { view: "backtest_report", report_id: data.report.id });
        return { ...a, artifact_refs: [...a.artifact_refs, ...ensureCharts(ctx, [data.report], STEP_TEMPLATES.diagnose_backtest, data.snapshot_refs, input.run_id)] };
      },
      { task_kinds: ["diagnose", "validate"] },
    ),
  );
  registry.register(
    def(
      "compare_buy_and_hold",
      "CompareInput",
      "AnalysisOutput",
      async (
        input: { run_id: string; arm: "a_rules" | "b_agent" | "c_filter" },
        ctx,
      ) => {
        if (!ctx.backtests) throw Error("DATA_MISSING:backtest_service");
        const data = ctx.backtests.comparison(input);
        // 有全窗口报告时读报告里的同窗口持有基准:同一 inquiry 的 A/B 共用窗口与基准,不再各按开发段自己算
        if (data.report) {
          const a = analysisArtifact(ctx, "策略与持有比较(全窗口)", holdComparison(data.report), data.snapshot_refs, input.run_id, { view: "backtest_report", report_id: data.report.id });
          return { ...a, artifact_refs: [...a.artifact_refs, ...ensureCharts(ctx, [data.report], STEP_TEMPLATES.compare_buy_and_hold, data.snapshot_refs, input.run_id)] };
        }
        const output = (ctx.analyses ?? analyses).compareBuyAndHold(
          data.bars,
          data.window,
          data.fee_rate,
          data.slippage_bps,
          data.strategy_net_return,
        );
        return analysisArtifact(
          ctx,
          "策略与持有比较",
          { ...output, closed_trades: data.closed_trades },
          data.snapshot_refs,
          input.run_id,
        );
      },
      { task_kinds: ["validate", "diagnose"] },
    ),
  );
  registry.register(
    def(
      "render_artifact",
      "RenderInput",
      "RenderOutput",
      async (
        input: {
          kind: "chart" | "table";
          spec: LoopSpec;
          snapshot_refs: string[];
          title: string;
          question: string;
        },
        ctx,
      ) => {
        const snapshots = input.snapshot_refs.map((id) =>
          ctx.store.snapshot(id),
        );
        input = { ...input, spec: normalizeSpecFields(input.spec, snapshots.flatMap((q) => q.rows as Record<string, unknown>[])) };
        validateSpec(input.spec, snapshots);
        live(ctx);
        const allRows = snapshots.flatMap((q) => q.rows as Record<string, unknown>[]);
        const tableFields = [...new Set([input.spec.x ?? "ts", ...(typeof input.spec.y === "string" ? [input.spec.y] : (input.spec.y ?? [])), ...(typeof input.spec.series === "string" ? [input.spec.series] : (input.spec.series ?? []).map((q) => q.field))])];
        const a = ctx.store.putArtifact({
          ...input,
          inquiry_id: ctx.inquiry_id,
          data_kind: "observed",
          availability: snapshots.some((s) => s.coverage !== "available")
            ? "partial"
            : "available",
          caption: "来源与窗口见不可变快照。",
          content: check("Object", input.kind === "chart" ? { ...materializeChart(input.spec, snapshots), title: input.title, snapshot_refs: input.snapshot_refs } : { kind: "table", columns: tableFields, rows: allRows.slice(0, 2000).map((r) => tableFields.map((f) => (r[f] ?? null) as number | string | null)), snapshot_refs: input.snapshot_refs }),
        });
        return result(
          { artifact_id: a.id },
          { artifact_refs: [a.id], snapshot_refs: input.snapshot_refs },
        );
      },
    ),
  );
  registry.register(
    def(
      "analyze_pattern_frequency",
      "PatternInput",
      "AnalysisOutput",
      async (
        input: {
          price_snapshot: string;
          primitive: string;
          params?: Record<string, unknown>;
          horizon_bars: number;
          label?: string;
        },
        ctx,
      ) => {
        const snapshot = referencedSnapshot(ctx, input.price_snapshot);
        if (snapshot.kind !== "price")
          return failure("UNIT_MISMATCH", "频率统计需要价格快照");
        const primitive = primitives.get(input.primitive);
        if (!primitive)
          return failure("DATA_MISSING", `原语 ${input.primitive} 不在目录里,无法统计`);
        const params = input.params ?? {};
        // 快照行 → ResearchBar。只统计已收盘 bar;原语内部再切到 i 为止,不会看到未来。
        // 全历史(2026-09-23):不再截前 5000 根;每根只给原语最近 W 根视图(W=clamp(6×预热,500,5000),与 engine v4 同口径),O(n·W) 而不是 O(n²)
        const bars: ResearchBar[] = snapshot.rows.slice(-50000).map((r) => {
          const open_time = Number(r.open_time ?? r.ts ?? 0),
            close_time = Number(r.close_time ?? r.ts ?? 0);
          return {
            open_time,
            close_time,
            available_at: close_time,
            open: String(r.open ?? r.close ?? "0"),
            high: String(r.high ?? r.close ?? "0"),
            low: String(r.low ?? r.close ?? "0"),
            close: String(r.close ?? "0"),
            volume: String(r.volume ?? "0"),
          };
        });
        const tfMatch = /^(\d+)(m|h|d)$/.exec(snapshot.frequency ?? "1h");
        const timeframe_ms = tfMatch
          ? Number(tfMatch[1]) * { m: 60000, h: 3600000, d: 86400000 }[tfMatch[2] as "m" | "h" | "d"]!
          : 3600000;
        const warmup = Math.max(1, Number(primitive.warmup_bars(params)) || 1);
        const horizon = input.horizon_bars;
        const hits: number[] = [];
        const view = Math.min(5000, Math.max(500, 6 * warmup));
        for (let i = warmup; i < bars.length; i++) {
          if (i % 256 === 0) live(ctx);
          let pass = false;
          try {
            const from = Math.max(0, i - view + 1);
            pass = !!primitive.compute({ bars: bars.slice(from, i + 1), i: i - from, timeframe_ms }, params).pass;
          } catch {
            // 参数不合法时原语会抛;整段统计判死比逐根吞掉更诚实
            return failure("SCHEMA_MISMATCH", `原语 ${input.primitive} 的参数不被接受`);
          }
          if (pass) hits.push(i);
        }
        const forward = hits
          .filter((i) => i + horizon < bars.length)
          .map((i) => (Number(bars[i + horizon]!.close) - Number(bars[i]!.close)) / Number(bars[i]!.close));
        const sorted = [...forward].sort((a, b) => a - b);
        const mean = forward.length ? forward.reduce((a, b) => a + b, 0) / forward.length : null;
        const median = sorted.length
          ? sorted.length % 2
            ? sorted[(sorted.length - 1) / 2]!
            : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2
          : null;
        const wins = forward.filter((x) => x > 0).length;
        // 样本纪律:不足 30 笔的分布只当观察,状态标 insufficient,答案里不会被当成有效性结论
        const enough = forward.length >= 30 ? ("ok" as const) : ("insufficient" as const);
        const label = input.label ?? input.primitive;
        const output = {
          concept: label,
          primitive: input.primitive,
          params,
          horizon_bars: horizon,
          bars_scanned: bars.length,
          warmup_bars: warmup,
          occurrences: { value: hits.length, unit: "count", status: "ok" as const },
          per_1000_bars: {
            value: bars.length > warmup ? (hits.length * 1000) / (bars.length - warmup) : null,
            unit: "count_per_1000_bars",
            status: bars.length > warmup ? ("ok" as const) : ("insufficient" as const),
          },
          forward_samples: { value: forward.length, unit: "count", status: "ok" as const },
          forward_return_mean: { value: mean, unit: "fraction", status: forward.length ? enough : ("insufficient" as const) },
          forward_return_median: { value: median, unit: "fraction", status: forward.length ? enough : ("insufficient" as const) },
          forward_win_rate: { value: forward.length ? wins / forward.length : null, unit: "fraction", status: enough },
          forward_return_worst: { value: sorted.length ? sorted[0]! : null, unit: "fraction", status: forward.length ? enough : ("insufficient" as const) },
          forward_return_best: { value: sorted.length ? sorted.at(-1)! : null, unit: "fraction", status: forward.length ? enough : ("insufficient" as const) },
          observation: `${label} 在 ${bars.length} 根中触发 ${hits.length} 次；可计算随后 ${horizon} 根收益的有 ${forward.length} 次${forward.length ? `，中位数 ${((median ?? 0) * 100).toFixed(2)}%` : ""}。${forward.length < 30 ? "样本不足 30 次，只作观察不作有效性结论。" : ""}`,
          method_version: "pattern-frequency/v2",
          window: bars.length ? { from_ms: bars[0]!.open_time, to_ms: bars.at(-1)!.close_time } : null,
          warnings: snapshot.rows.length > 50000 ? ["只统计了最近 50000 根"] : [],
        };
        return analysisArtifact(ctx, `${label} 出现频率与随后 ${horizon} 根收益`, output, [input.price_snapshot]);
      },
        { task_kinds: ["market", "compare", "validate", "diagnose"] },
    ),
  );
  registry.register(
    def(
      "acquire_concept",
      "AcquireInput",
      "AcquireOutput",
      async (
        input: { concept: string; category?: ConceptCategory; question?: string },
        ctx,
      ) => {
        const { result: acquired, tried, offline } = await acquireConcept(input.concept, {
          brain: ctx.brain,
          signal: ctx.signal,
          now: () => ctx.now(),
        });
        // 闭环:模型判定「必须写 Pine 才能表达」时,直接让 pine_author 写脚本并跑准入;通过就把 script_id 记进 implementation.target,
        // 概念从「pine 候选」变成真正可引用(pine_series 原语);引擎没起或准入失败则保留候选并把原因写进 note,不假装可用
        const warnings: string[] = [];
        // indicator_row(指标表加一行)是代码改动,运行时做不到,同样交给 pine_author 写成脚本
        if ((acquired.implementation.kind === "pine" || acquired.implementation.kind === "indicator_row") && !(acquired.implementation.params as { script_id?: string } | null)?.script_id && registry.get("pine_author")) {
          // 目录里已有同名/同义且已准入的脚本就直接复用,不每次重写一份(2026-09-22 实测同一概念连问三次生成了三个脚本)
          const existing = pineCatalog()?.search(acquired.concept, { limit: 3, admitted: true }) ?? [];
          const reuse = existing.find((s) => s.name.toLowerCase() === acquired.concept.toLowerCase() || s.aliases?.some((a) => a.toLowerCase() === acquired.concept.toLowerCase())) ?? existing[0];
          const authored = reuse
            ? { status: "ok" as const, output: { script_id: reuse.id, admitted: true, outputs: reuse.outputs, warmup_bars: reuse.admission_report?.warmup_bars ?? 1 }, warnings: [] as string[], error_code: undefined }
            : await registry.call(
            "pine_author",
            { concept: [acquired.definition, acquired.implementation.expression, acquired.implementation.note].filter(Boolean).join("\n"), name: acquired.concept, timeframe: (ctx.context as { selected_timeframe?: string } | undefined)?.selected_timeframe ?? "1h" },
            ctx,
          );
          const out = authored.output as { script_id?: string | null; admitted?: boolean; outputs?: string[]; warmup_bars?: number; reason?: string } | null;
          if (authored.status === "ok" && out?.script_id && out.admitted) {
            acquired.implementation.target = out.script_id;
            acquired.implementation.params = { script_id: out.script_id, output: out.outputs?.[0] ?? null, warmup_bars: out.warmup_bars ?? null };
            acquired.implementation.note = `${acquired.implementation.note ?? ""}(已由 pine_author 写成脚本并通过准入,script_id=${out.script_id})`.trim();
          } else {
            const why = authored.status === "ok" ? `准入未通过:${out?.reason ?? "unknown"}` : (authored.warnings[0] ?? authored.error_code ?? "pine_author_failed");
            acquired.implementation.note = `${acquired.implementation.note ?? ""}(Pine 脚本未能自动生成:${why})`.trim();
            warnings.push("pine_author:" + why);
          }
        }
        const status = acquiredToConcept(acquired, input.category ?? "pattern");
        // 记进 checkpoint:报告的「概念覆盖」段与答案的 data_gap 都从这里读
        const checkpoint = ctx.store.inquiry(ctx.inquiry_id).checkpoint;
        ctx.store.updateInquiry(ctx.inquiry_id, {
          checkpoint: {
            ...checkpoint,
            concepts: [
              ...(checkpoint.concepts ?? []).filter((c) => c.concept_id !== status.concept_id),
              status as LoopConcept,
            ],
          },
        });
        return result(
          {
            concept: acquired.concept,
            definition: acquired.definition,
            implementation: acquired.implementation,
            provenance: acquired.provenance,
            concept_status: status,
            tried_sources: tried,
            offline_sources: offline,
          },
          { warnings: [...warnings, ...(offline.length ? ["knowledge_source_unavailable:" + offline.join(",")] : [])] },
        );
      },
      { budget_class: "model_call", timeout_ms: 360000 },
    ),
  );
  registry.register(def("revise_strategy", "RevisionCompileInput", "Object", prepareRevision, { task_kinds: ["validate"], budget_class: "model_call", timeout_ms: 120000 }));
  registry.register(def("run_strategy_revision", "RevisionRunInput", "Object", runRevision, { task_kinds: ["validate"], access: "create_run", budget_class: "backtest", timeout_ms: 600000 }));
  registry.register(def("compare_strategy_runs", "RunPairInput", "Object", async (input: { baseline_run_id: string; candidate_run_id: string }, ctx) => compareRuns(input, ctx), { task_kinds: ["validate", "diagnose"] }));
  registry.register(def("build_research_report", "Object", "Object", async (input, ctx) => buildReport(input, ctx)));
  registry.register(
    def("compose_answer", "ComposeInput", "ComposeOutput", composeAnswer, {
      budget_class: "model_call",
      idempotent: false,
      timeout_ms: 35000,
    }),
  );
  // 2026-09-22 接线:数据工具(走 adapter 目录的 inspect_data_coverage + find_data_source)、Pine 目录工具(pine_lookup / pine_author);
  // 概念解析的数据钩子也指向目录(用永续 BTC 作探针,只问「这个指标有没有来源」,not_connected 按 missing 报)
  registerDataTools(registry, def);
  registerPineTools(registry, def);
  // 参数扫描的对照组由代码从基准 IR 派生(loop/sweep.ts)
  registerSweepTools(registry, def);
  setDataConceptResolver((metric) => {
    try {
      const r = catalogResolve(metric as Parameters<typeof catalogResolve>[0], "okx:perp:BTC-USDT-SWAP");
      return { metric, availability: r.availability === "not_connected" ? "missing" : r.availability, note: r.note };
    } catch {
      return null;
    }
  });
  return registry;
}
/**
 * 研究图表产物(charts.ts 模板,确定性):同一 inquiry 里同一报告同一模板只落一次(回测步与持有对比步共用一张权益曲线)。
 * 返回产物 id;模板对这份报告不适用(比如没有交易就没有退出类型图)时跳过。
 */
export function ensureCharts(ctx: ToolContext, reports: import("@trading-swarm/contracts").BacktestReport[], templates: readonly import("@trading-swarm/contracts").LoopChartTemplate[], snapshot_refs: string[] = [], run_id?: string): string[] {
  if (!reports.length) return [];
  const q = ctx.store.inquiry(ctx.inquiry_id);
  const key = (template: string, ids: string[]) => template + "|" + [...ids].sort().join(",");
  const existing = new Map<string, string>();
  for (const a of ctx.store.artifacts(q.session_id)) {
    const c = a.content as { version?: string; template?: string; report_id?: string; report_ids?: string[] } | null;
    if (a.inquiry_id === q.id && a.kind === "chart" && c?.version === CHART_VERSION && c.template) existing.set(key(c.template, c.report_ids ?? (c.report_id ? [c.report_id] : [])), a.id);
  }
  const out: string[] = [];
  for (const template of templates) {
    const d = buildChart(template, reports);
    if (!d) continue;
    const ids = d.content.report_ids ?? (d.content.report_id ? [d.content.report_id] : []);
    const prior = existing.get(key(template, ids));
    if (prior) { out.push(prior); continue; }
    live(ctx);
    const primary = reports[0]!;
    const a = ctx.store.putArtifact({
      inquiry_id: q.id,
      kind: "chart",
      title: d.title,
      question: q.question,
      snapshot_refs,
      data_kind: "derived",
      availability: primary.assets.some((x) => x.status !== "completed") ? "partial" : "available",
      spec: d.spec,
      // 产物说明写溯源(图下已显示代码算出的数值说明,不重复)
      caption: `由全窗口回测报告 ${reports.map((r) => r.id.slice(0, 8)).join("、")} 按模板 ${template} 确定性生成;金额按 $10k 本金换算。`,
      content: check("Object", check("Chart", d.content)),
      ...(run_id ?? primary.run_ids[0] ? { run_id: run_id ?? primary.run_ids[0]! } : {}),
    });
    existing.set(key(template, ids), a.id);
    out.push(a.id);
  }
  return out;
}
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const pctText = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`);
const lm = (value: number | null | undefined, unit: string, enough = true) => ({ value: value ?? null, unit, status: value === null || value === undefined ? ("not_applicable" as const) : enough ? ("ok" as const) : ("insufficient" as const) });
/** 全窗口报告 → 研究 loop 的分析产物(typed metrics + 代码生成的观察句,含窗口起止日期与样本内/外表现)。 */
function backtestAnalysis(report: import("@trading-swarm/contracts").BacktestReport) {
  const lines: string[] = [], rows: Record<string, unknown>[] = [];
  const is = report.segments.find((s) => s.name === "in_sample"), oos = report.segments.find((s) => s.name === "out_of_sample");
  lines.push(`全窗口回测 ${day(report.window.from_ms)} → ${day(report.window.to_ms)}(${report.timeframe},预热之后到最后一根已收盘 K 线;样本内 ${is ? day(is.to_ms) : "—"} 之前、样本外之后,按 70/30 标注)`);
  for (const a of report.assets) {
    if (a.status !== "completed" || !a.metrics) { lines.push(`${a.label}:${a.status === "data_missing" ? "行情缺失" : "回测失败"}(${a.error ?? ""})`); rows.push({ canonical_id: a.key, status: a.status }); continue; }
    const m = a.metrics, sIs = a.segments.find((s) => s.name === "in_sample")?.metrics, sOos = a.segments.find((s) => s.name === "out_of_sample")?.metrics, enough = m.trades >= 30;
    // 每笔收益:平均旁边必给中位数与截尾均值(两端各截 10%;报告层从逐笔交易派生,不进报告指标)
    const c = centerStats(a.trades.map((t) => t.return_pct)), full = a.trades.length === m.trades;
    const center = !m.trades ? "" : !c.n ? `;每笔收益均值 ${pctText(m.expectancy)}(报告里没有逐笔交易,中位数/截尾均值不可算)` : `;每笔收益 ${centerText({ ...c, mean: full ? c.mean : m.expectancy }, pctText)}${full ? "" : `,中位数/截尾按报告里保留的 ${a.trades.length}/${m.trades} 笔`}`;
    lines.push(`${a.label}:净收益 ${pctText(m.total_return)},同窗口持有 ${pctText(m.benchmark_return)},最大回撤 ${(m.max_drawdown * 100).toFixed(2)}%,${m.trades} 笔平仓${m.win_rate === null ? "" : `,胜率 ${(m.win_rate * 100).toFixed(1)}%`}${center};样本内 ${pctText(sIs?.total_return)}(持有 ${pctText(sIs?.benchmark_return)}),样本外 ${pctText(sOos?.total_return)}(持有 ${pctText(sOos?.benchmark_return)})`);
    rows.push({ canonical_id: a.key, total_return: lm(m.total_return, "fraction", enough), benchmark_return: lm(m.benchmark_return, "fraction"), max_drawdown: lm(m.max_drawdown, "fraction", enough), sharpe: lm(m.sharpe, "ratio", enough), win_rate: lm(m.win_rate, "fraction", enough), trades: lm(m.trades, "count"), trade_return_mean: lm(m.expectancy, "fraction", enough), trade_return_median: lm(c.median, "fraction", enough), trade_return_trimmed_mean: lm(c.trimmed_mean, "fraction", enough), in_sample_return: lm(sIs?.total_return, "fraction", enough), out_of_sample_return: lm(sOos?.total_return, "fraction", enough) });
  }
  lines.push(`评分 ${report.score.value}/100(${report.score.label},${report.score.confidence_reason})${(report.assets.find((a) => a.key === report.primary_key)?.metrics?.trades ?? 0) < 30 ? ";平仓不足 30 笔,只作观察不作有效性结论" : ""}`);
  return { report_id: report.id, engine_version: report.engine_version, window: report.window, segments: report.segments, score: { value: report.score.value, unit: "score_0_100", status: "ok" as const }, rows, observation: lines.join("。\n"), method_version: "backtest-report/v1" };
}
/** 持有对比:读报告里同窗口的买入持有(同费率同滑点),A/B 同一窗口同一基准。 */
function holdComparison(report: import("@trading-swarm/contracts").BacktestReport) {
  const p = report.assets.find((a) => a.key === report.primary_key), m = p?.metrics ?? null;
  const comparable = !!m && m.benchmark_return !== null;
  return {
    report_id: report.id, window: report.window,
    buy_and_hold_return: lm(m?.benchmark_return, "fraction"), strategy_net_return: lm(m?.total_return, "fraction"), excess_return: lm(m?.excess_return, "fraction"),
    closed_trades: m?.trades ?? null, comparable,
    rows: report.assets.filter((a) => a.metrics).map((a) => ({ canonical_id: a.key, strategy_net_return: lm(a.metrics!.total_return, "fraction"), buy_and_hold_return: lm(a.metrics!.benchmark_return, "fraction") })),
    note: "同一全窗口、同一交易起点、同一费率滑点;持有 = 首个可成交 open 买入、按收盘清算价盯市;同一问题里的多个策略共用这个基准",
    observation: comparable ? `观察:${day(report.window.from_ms)} → ${day(report.window.to_ms)} 同窗口一直持有 ${p!.label}(扣同样费用)收益 ${pctText(m!.benchmark_return)},策略扣费后净收益 ${pctText(m!.total_return)},差 ${pctText(m!.excess_return)};这只是这一段历史上的对比,样本少时不说明策略好坏` : `观察:主资产没有可比较的回测结果`,
    method_version: "backtest-report/v1",
  };
}
export async function composeAnswer(
  input: {
    question: string;
    steps: Record<string, unknown>[];
    artifact_ids: string[];
    metrics: Record<string, unknown>;
  },
  ctx: ToolContext,
): Promise<ToolResult<{ blocks: LoopBlocks }>> {
  const q = ctx.store.inquiry(ctx.inquiry_id),
    artifacts = input.artifact_ids
      .map((id) => ctx.store.artifact(id))
      .filter(
        (a) =>
          a.inquiry_id === q.id ||
          ctx.store.inquiry(a.inquiry_id).session_id === q.session_id,
      );
  const knownMetrics = new Set(
    artifacts.flatMap((a) =>
      Object.keys((a.content as any).metrics ?? {}).flatMap((k) => [
        k,
        a.id + ":" + k,
      ]),
    ),
  );
  const metrics: Record<string, unknown> = {};
  for (const a of artifacts)
    for (const [id, value] of Object.entries((a.content as any).metrics ?? {}))
      metrics[id.includes(":") ? id : a.id + ":" + id] = value;
  const gaps: LoopBlocks = [];
  const failed: string[] = [];
  for (const s of input.steps) {
    const r = s.result as ToolResult | undefined;
    if (!r) continue;
    if (r.status === "error") {
      const task = s.tool === "revise_strategy" ? "修订规则检查" : s.tool === "run_strategy_revision" ? "候选版本回测" : s.tool === "compare_strategy_runs" ? "版本对照" : s.tool === "build_research_report" ? "研究报告" : s.tool === "compile_strategy" ? "策略规则检查" : s.tool === "run_backtest" ? "历史回测" : s.tool === "render_artifact" ? "图表生成" : s.tool === "compare_buy_and_hold" ? "持有基准比较" : "研究步骤";
      const reason = r.error_code === "SCHEMA_MISMATCH" ? "执行参数未通过检查" : r.error_code === "TIMEOUT" ? "处理超时" : r.error_code === "BUDGET_EXHAUSTED" ? "本轮预算已用完" : "执行遇到错误";
      failed.push(`${task}(${reason})`);
      continue;
    }
    if (["missing", "not_applicable", "partial", "stale"].includes(r.status)) {
      gaps.push({
        kind: "data_gap", metric: String(s.tool ?? "research"),
        availability: r.status as "missing" | "not_applicable" | "partial" | "stale",
        note: humanizeGap(s.tool, r) || r.coverage?.note || r.warnings.join(";") || r.error_code || "数据不完整",
      });
    }
  }
  // 失败步骤合成一行(旧口径每个被跳过的下游步骤各报一句「未完成」,一次失败能刷出五六行)
  const failures: LoopBlocks = failed.length ? [{ kind: "text", text: `未完成的步骤:${[...new Set(failed)].join("、")}。已产出的结果仍可查看,具体原因见研究过程。` }] : [];
  // 概念覆盖:问题里没能映射到实现的词也是一种缺口,和数据缺口一样如实写进答案
  for (const c of (q.checkpoint.concepts ?? []).filter((c) => c.status === "unmapped"))
    gaps.push({
      kind: "data_gap",
      metric: c.term,
      availability: "missing",
      note: c.note || "本仓库没有这个概念的实现。",
    });
  const noTrades =
    input.steps.some((s) =>
      JSON.stringify(s.result ?? {}).includes('"closed_trades":0'),
    ) ||
    artifacts.some((a) => (a.content as any).analysis?.closed_trades === 0);
  const observations: LoopBlocks = artifacts
    .filter(
      (a) =>
        a.kind === "table" &&
        typeof (a.content as any).analysis?.observation === "string",
    )
    .map((a) => ({
      kind: "text",
      text: (a.content as any).analysis.observation,
    }));
  // 多个回测(A/B、参数扫描)时给一段横比:同窗口、同资产口径下各策略主资产的关键指标,按评分排序(2026-09-23 实测参数扫描答案只是三份结果首尾相接)
  // 回测步与持有对比步各有一个指向同一报告的产物,按报告 id 去重
  const reportIds = [...new Set(artifacts.filter((a) => (a.content as { view?: string }).view === "backtest_report").map((a) => String((a.content as { report_id?: string }).report_id)))];
  const reports = ctx.backtests ? reportIds.map((id) => getBacktestReport(ctx.backtests!.store, id)).filter((r): r is NonNullable<typeof r> => !!r) : [];
  // 研究图表:模板按问题类型挑 ≤4 张(缺的现算),步骤里其余的回测图不进答案(仍可在步骤详情里看)
  const kind: AnswerKind = input.steps.some((s) => s.tool === "diagnose_backtest") || q.task_kind === "diagnose" ? "diagnose" : reports.length >= 2 ? "compare" : "validate";
  const picks = pickCharts({ kind, question: input.question, reports });
  const byId = new Map(reports.map((r) => [r.id, r]));
  const pickedCharts: string[] = [];
  for (const pick of picks) {
    try {
      const src = pick.report_ids.map((id) => byId.get(id)!).filter(Boolean);
      pickedCharts.push(...ensureCharts(ctx, src, [pick.template], [], src[0]?.run_ids[0]));
    } catch { /* 单张图失败不影响答案 */ }
  }
  const isTemplateChart = (a: { kind: string; content: unknown }) => a.kind === "chart" && (a.content as { version?: string } | null)?.version === CHART_VERSION;
  for (const id of pickedCharts) if (!artifacts.some((a) => a.id === id)) artifacts.push(ctx.store.artifact(id));
  // 答案里引用的产物:非模板图全留;模板图只留挑中的
  const shown = artifacts.filter((a) => !isTemplateChart(a) || pickedCharts.includes(a.id));
  const chartBlocks: LoopBlocks = pickedCharts.map((artifact_id) => ({ kind: "chart_ref" as const, artifact_id }));
  const comparison: LoopBlocks = [];
  if (reports.length >= 2) {
    const rowsOf = reports.map((r) => { const a = r.assets.find((x) => x.key === r.primary_key), m = a?.metrics, oos = a?.segments.find((s) => s.name === "out_of_sample")?.metrics; return { r, a, m, oos }; }).filter((x) => x.m);
    rowsOf.sort((x, y) => y.r.score.value - x.r.score.value || (y.m!.sharpe ?? -9) - (x.m!.sharpe ?? -9));
    const few = rowsOf.some((x) => x.m!.trades < 30);
    comparison.push({ kind: "text", text: `同窗口横比(${rowsOf[0]?.a?.label ?? ""},按评分排序):\n` + rowsOf.map((x, i) => `${i + 1}. ${x.r.title}:净收益 ${pctText(x.m!.total_return)},最大回撤 ${(x.m!.max_drawdown * 100).toFixed(1)}%,夏普 ${x.m!.sharpe === null ? "—" : x.m!.sharpe.toFixed(2)},样本外 ${pctText(x.oos?.total_return)},${x.m!.trades} 笔,评分 ${x.r.score.value}`).join("\n") + (few ? "\n有的组平仓不足 30 笔,排序只作观察;参数间差异可能来自少数几笔交易。" : "") });
  }
  // 复盘 skill(skills/research-reflection,2026-09-23):诊断 / 验证 / 横比回答按问题类型只注入相关段落;
  // 验证与横比没有诊断步,由代码从报告现算「复盘提示」(严重项 + 横比时的参数不一致与变体数),答案里可见,模型只能引用它
  const reflection = reports.length ? reflectionPrompt(kind, input.question) : null;
  const diagFindings = artifacts.flatMap((a) => { const an = (a.content as { analysis?: { findings?: unknown; method_version?: unknown } }).analysis; return Array.isArray(an?.findings) && String(an?.method_version ?? "").startsWith("diagnose/") ? (an!.findings as Record<string, unknown>[]) : []; });
  const review: LoopBlocks = [];
  let reviewFindings: Record<string, unknown>[] = [];
  if (kind !== "diagnose" && reports.length) {
    const notes = reviewNotes(reports, (r) => diagnoseContextFor(r, ctx.store, ctx.inquiry_id, ctx.backtests?.store));
    if (notes) { review.push({ kind: "text", text: notes.text }); reviewFindings = notes.findings.map((f) => ({ ...f })); }
  }
  // 回测 run 是可点开的产物(旧实验页七个 tab 全在):从步骤结果里把 run_id 挑出来挂 strategy_ref
  const runRefs: LoopBlocks = [...new Set(input.steps.map((s) => (s.result as { output?: { run_id?: unknown } } | undefined)?.output?.run_id).filter((x): x is string => typeof x === 'string' && !x.startsWith('report:')))].map((run_id) => ({ kind: 'strategy_ref', run_id }));  // 永续的伪 run(report:<键>)没有 run 页,不挂
  const completedBacktest = input.steps.some((s) => ["run_backtest", "run_strategy_revision"].includes(String(s.tool)) && (s.result as ToolResult | undefined)?.status === "ok" && typeof (s.result as ToolResult<{ run_id?: string }>).output?.run_id === "string");
  const followUps: LoopBlocks = completedBacktest ? [{ kind: "next_question", text: noTrades ? "解释这次没有交易的原因" : "这次回测结果有哪些局限？" }] : [];
  const template: LoopBlocks = [
    {
      kind: "text",
      text: noTrades
        ? "这次回测没有交易，无法据此评价策略有效性。"
        : completedBacktest
          ? "回测已完成，结果见下方实验记录。"
          : artifacts.length
          ? "研究已整理为下列可追溯产物；结论范围限于快照覆盖窗口。"
          : "当前没有足够数据形成研究结论。",
    },
    ...comparison,
    ...observations,
    ...review,
    ...chartBlocks,
    ...runRefs,
    ...shown.filter((a) => !pickedCharts.includes(a.id)).map(refOf),
    ...gaps,
    ...failures,
    ...followUps,
  ];
  const warnings: string[] = [];
  let blocks = template;
  const chartTemplateOf = (id: string) => (ctx.store.artifact(id).content as { template?: string }).template;
  if (ctx.brain && !ctx.signal.aborted) {
    try {
      const numberRule = reflection
        ? "text 块里的数字只能原样照抄 findings / observations / comparison / review 里出现过的数字(问题原文与报告标题里的参数也可以),对不上的句子会被删除;不要换算、不要四舍五入、不要自己算。因果只能写成假设(可能 / 待验证),不宣称有效。"
        : "数值只能由系统产物展示，不在 text 中重新编写数字。不解释因果或宣称有效。";
      const response = await ctx.brain.complete(
        "只输出 JSON {blocks:[]}。blocks 遵循合同。引用 artifact_id/metric_id 必须在提供目录中。" + numberRule + "零交易必须说“没有交易”。execution 是已执行的事实；不得把已完成的回测说成尚待执行，不得再次请求确认执行。" +
          "图表只能从 charts 里选(系统已按问题挑好,最多 " + pickedCharts.length + " 张):可以调整 chart_ref 的先后顺序,每个 chart_ref 可带一句 caption 说明这张图看什么(不含任何数字),不能引用 charts 以外的图。" +
          JSON.stringify(schemaDocument(schema("Blocks"))) +
          (reflection ? "\n\n" + reflection.text : ""),
        JSON.stringify({
          question: input.question,
          artifacts: shown.filter((a) => !pickedCharts.includes(a.id)).map((a) => ({
            id: a.id,
            title: a.title,
            kind: a.kind,
          })),
          charts: pickedCharts.map((id) => ({ id, title: ctx.store.artifact(id).title, template: chartTemplateOf(id) })),
          metrics,
          gaps,
          no_trades: noTrades,
          execution: input.steps.map((s) => ({ tool: s.tool, status: (s.result as ToolResult | undefined)?.status, run_id: (s.result as ToolResult<{ run_id?: string }> | undefined)?.output?.run_id })),
          completed_backtest: completedBacktest,
          ...(reflection ? {
            findings: diagFindings.length ? diagFindings : reviewFindings,
            observations: observations.map((b) => (b as { text: string }).text),
            comparison: comparison.map((b) => (b as { text: string }).text),
            review: review.map((b) => (b as { text: string }).text),
          } : {}),
        }),
        // 带 skill 的复盘提示更长,弱模型要多给时间;超时仍回落代码模板
        { timeoutMs: reflection ? 60000 : 30000 },
      );
      const raw = JSON.parse(
        response.text.replace(/^```(?:json)?\s*|\s*```$/g, ""),
      );
      const candidate: LoopBlocks = [];
      // 复盘模式:模型文本里的数字逐句和可信文本核对(观察句、诊断、横比、复盘提示、问题原文、报告标题)
      const corpus = reflection ? numberCorpus([input.question, ...reports.map((r) => r.title), ...[...comparison, ...observations, ...review].map((b) => (b as { text?: string }).text), ...diagFindings.map((f) => String(f["text"] ?? ""))]) : null;
      for (const block of Array.isArray(raw.blocks) ? raw.blocks : []) {
        try {
          if (block.metric_id && !knownMetrics.has(block.metric_id))
            throw Error("invalid_metric_ref");
          check("Blocks", [block]);
          if (["data_gap", "plan", "run_status"].includes(block.kind))
            throw Error("code_owned_block");
          if (
            block.artifact_id &&
            !shown.some((a) => a.id === block.artifact_id)
          )
            throw Error("invalid_artifact_ref");
          if (block.kind === "chart_ref" && isTemplateChart(ctx.store.artifact(block.artifact_id)) && !pickedCharts.includes(block.artifact_id))
            throw Error("unpicked_chart");
          if (block.caption !== undefined && (block.kind !== "chart_ref" || /[\d零〇一二两三四五六七八九十百千万亿%％$]/.test(block.caption)))
            throw Error("unverified_caption");
          if (block.run_id && !artifacts.some((a) => a.run_id === block.run_id) && !runRefs.some((r) => r.kind === "strategy_ref" && r.run_id === block.run_id))
            throw Error("invalid_run_ref");
          if (
            block.step_id &&
            !ctx.store.steps(q.id).some((s) => s.id === block.step_id)
          )
            throw Error("invalid_step_ref");
          if (block.inquiry_id && block.inquiry_id !== q.id)
            throw Error("invalid_inquiry_ref");
          const reflective = !!corpus && block.kind === "text" && typeof block.text === "string";
          if (block.text && (noTrades || !artifacts.length) && /胜率|win.?rate/i.test(block.text))
            throw Error("unverified_numeric_or_zero_trade_claim");
          if (reflective) {
            // 复盘文本:执行状态仍归代码;数字对不上的句子整句剥掉,剥完为空就整块丢
            if (EXECUTION_NARRATIVE.test(block.text)) throw Error("code_owned_execution_narrative");
            const g = groundText(block.text, corpus!);
            if (g.dropped) warnings.push("ungrounded_sentence_removed");
            if (!g.text) throw Error("unverified_numeric_or_zero_trade_claim");
            block.text = g.text;
          } else if (block.text && /[\d零〇一二两三四五六七八九十百千万亿%％]/.test(block.text))
            throw Error("unverified_numeric_or_zero_trade_claim");
          // Execution facts are code-owned. Arbitrary model paraphrases cannot safely assert whether a run happened.
          if (completedBacktest && ["text", "next_question"].includes(block.kind) && !reflective)
            throw Error("code_owned_execution_narrative");
          candidate.push(block);
        } catch {
          warnings.push("invalid_answer_block_removed");
        }
      }
      if (candidate.length) {
        // 模型只能调整挑中图表的顺序与说明:它给的 chart_ref 先排,没提到的挑中图按模板顺序补在后面;同一张图只出现一次
        const modelCharts: LoopBlocks = [];
        for (const b of candidate as any[]) if (b.kind === "chart_ref" && pickedCharts.includes(b.artifact_id) && !modelCharts.some((x: any) => x.artifact_id === b.artifact_id)) modelCharts.push(b);
        const charts = [...modelCharts, ...chartBlocks.filter((c: any) => !modelCharts.some((x: any) => x.artifact_id === c.artifact_id))];
        const rest = candidate.filter((b: any) => !(b.kind === "chart_ref" && pickedCharts.includes(b.artifact_id)));
        const refs = shown.filter((a) => !pickedCharts.includes(a.id) && !rest.some((b: any) => b.artifact_id === a.id)).map(refOf);
        // 观察句是代码从 typed metrics 生成的(带数字),是可信文本;模型文本只能补叙述,不能替代它。
        blocks = [...comparison, ...observations, ...review, ...rest, ...charts, ...refs, ...runRefs.filter((r: any) => !candidate.some((b: any) => b.run_id === r.run_id)), ...gaps, ...failures, ...((noTrades || completedBacktest) ? [template[0]!] : []), ...followUps];
      }
      else warnings.push("template_fallback");
    } catch {
      warnings.push("template_fallback");
    }
  } else warnings.push("template_fallback");
  return result(
    { blocks },
    { artifact_refs: artifacts.map((a) => a.id), warnings },
  );
}
function refOf(a: { id: string; kind: string; content: unknown }): LoopBlocks[number] {
  return {
    kind: a.kind === "chart" ? "chart_ref" : a.kind === "markdown" ? "report_ref" : (a.content as { view?: string } | null)?.view === "run_comparison" ? "comparison_ref" : "table_ref",
    artifact_id: a.id,
  };
}

/** 测试用:全窗口报告 → 分析产物(纯函数,无副作用) */
export const _analysisForTest = { backtestAnalysis };
