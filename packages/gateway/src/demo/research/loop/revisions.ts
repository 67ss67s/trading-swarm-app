import { timeframe } from "../agent.js";
import type {
  LoopRevisionCommand,
  LoopPlan,
  ResearchRequest,
  StrategyIR,
} from "@trade-gate/contracts";
import { hash, canonical } from "../primitives.js";
import {
  compileStrategy,
  policyToIR,
  irWarmup,
  requestHorizon,
  rulesOf,
  resolveRequest,
} from "../strategy.js";
import { precheck } from "../precheck.js";
import type { BacktestBridge } from "./backtest.js";
import { check } from "./schema.js";
import { result, failure, type ToolContext, type ToolResult } from "./tools.js";

export function revisionContext(bridge: BacktestBridge, id: string) {
  const run = bridge.store.get(id);
  if (!run) throw Error("run_not_found");
  const request = run.manifest.request;
  const study = bridge.store.study(request.study_id);
  if (!study) throw Error("study_not_found");
  const history = bridge.store.studyRuns(study.id);
  const ir =
    request.strategy_ir ??
    (request.policy ? policyToIR(request.policy, request.execution) : null);
  const development_count = history.filter(
    (r) => r.manifest.request.purpose === "development",
  ).length;
  const remaining = Math.max(
    0,
    Math.min(study.max_trials - history.length, 3 - development_count),
  );
  const blocked =
    run.status !== "completed"
      ? "原版尚未完成"
      : request.purpose !== "development"
        ? "验证段和留出段不能作为优化起点"
        : bridge.store.sealed(study.id)
          ? "留出样本已使用，本研究已封存"
          : !ir
            ? "原版缺少可修改的规则"
            : !remaining
              ? "已用完登记的研究试验额度；仍可生成草稿和查看已有版本"
              : null;
  return {
    run_id: id,
    version: run.manifest.trial_number,
    parent_run_id: request.parent_run_id ?? null,
    manifest_hash: run.manifest.hash,
    status: run.status,
    ir,
    rules: ir ? rulesOf(ir) : [],
    execution: resolveRequest(request).execution,
    window: { from_ms: request.from_ms, to_ms: request.to_ms },
    study_id: study.id,
    purpose: request.purpose,
    dataset_id: request.dataset_id ?? null,
    timeframe: timeframe(bridge.store.dataFor(request).timeframe_ms),
    remaining_candidates: remaining,
    blocked,
    versions: history.map((r) => ({
      run_id: r.id,
      version: r.manifest.trial_number,
      parent_run_id: r.manifest.request.parent_run_id ?? null,
      status: r.status,
      purpose: r.manifest.request.purpose,
      metrics: r.result?.arms[0]?.metrics ?? null,
      created_at: r.created_at,
    })),
  };
}

export function commandPlan(
  command: LoopRevisionCommand,
  bridge: BacktestBridge,
): LoopPlan {
  const base = revisionContext(bridge, command.baseline_run_id);
  const plan: LoopPlan = {
    task_kind: "validate",
    instruments: [],
    timeframe: base.timeframe,
    window: base.window,
    source: "fallback_rules",
    command,
    plan: [],
  };
  for (let n = 1; n <= command.max_candidates; n++) {
    // A failed first candidate must not make the next one pretend to succeed.
    // The executor sequences candidates without making success of the prior a dependency.
    plan.plan.push({
      key: `draft_${n}`,
      title:
        command.mode === "rerun"
          ? "保留规则，检查新的验证条件"
          : `准备候选 ${n} 并记录规则变化`,
      tool: "revise_strategy",
      args: {
        baseline_run_id: command.baseline_run_id,
        instruction: command.instruction,
        candidate_index: n,
      },
      depends_on: [],
    });
    plan.plan.push({
      key: `run_${n}`,
      title: `运行候选 ${n} 的历史回测`,
      tool: "run_strategy_revision",
      args: {
        baseline_run_id: command.baseline_run_id,
        draft_artifact_id: `$draft_${n}.draft_artifact_id`,
      },
      depends_on: [`draft_${n}`],
    });
    plan.plan.push({
      key: `compare_${n}`,
      title: `对照原版与候选 ${n}`,
      tool: "compare_strategy_runs",
      args: {
        baseline_run_id: command.baseline_run_id,
        candidate_run_id: `$run_${n}.run_id`,
      },
      depends_on: [`run_${n}`],
    });
  }
  plan.plan.push({
    key: "report",
    title: "保存研究报告与全部候选记录",
    tool: "build_research_report",
    args: {},
    depends_on: plan.plan.map((s) => s.key),
  });
  plan.plan.push({
    key: "answer",
    title: "解释结果、取舍与停止原因",
    tool: "compose_answer",
    args: {
      question: command.instruction,
      steps: [],
      artifact_ids: [],
      metrics: {},
    },
    depends_on: plan.plan.map((s) => s.key),
  });
  return plan;
}

function environment(ctx: ToolContext, baseline_id: string) {
  if (!ctx.backtests) throw Error("DATA_MISSING:backtest_service");
  const command = ctx.store.inquiry(ctx.inquiry_id).plan.command;
  if (!command || command.baseline_run_id !== baseline_id)
    throw Error("SCHEMA_MISMATCH:revision_requires_explicit_command");
  const parent = ctx.backtests.store.get(baseline_id);
  if (
    !parent ||
    parent.status !== "completed" ||
    parent.manifest.request.purpose !== "development"
  )
    throw Error("NOT_COMPARABLE:development_parent_required");
  return { bridge: ctx.backtests, command, parent };
}

export function ruleChanges(
  before: unknown,
  after: unknown,
  path = "",
): { field: string; before: unknown; after: unknown }[] {
  if (canonical(before ?? null) === canonical(after ?? null)) return [];
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object" &&
    Array.isArray(before) === Array.isArray(after)
  ) {
    return [
      ...new Set([...Object.keys(before), ...Object.keys(after)]),
    ].flatMap((key) =>
      ruleChanges(
        (before as any)[key],
        (after as any)[key],
        path ? `${path}.${key}` : key,
      ),
    );
  }
  return [{ field: path, before: before ?? null, after: after ?? null }];
}

export async function prepareRevision(
  input: {
    baseline_run_id: string;
    instruction: string;
    candidate_index: number;
  },
  ctx: ToolContext,
): Promise<ToolResult> {
  const { bridge, command, parent } = environment(ctx, input.baseline_run_id);
  if (
    input.candidate_index > command.max_candidates ||
    input.instruction !== command.instruction
  )
    throw Error("SCHEMA_MISMATCH:command_mismatch");
  if (bridge.store.sealed(parent.manifest.request.study_id))
    throw Error("NOT_COMPARABLE:study_sealed_after_holdout");
  const request = parent.manifest.request;
  const original =
    request.strategy_ir ??
    (request.policy ? policyToIR(request.policy, request.execution) : null);
  if (!original || !request.dataset_id || request.universe_id)
    throw Error("UNSUPPORTED_ASSET:single_asset_rules_required");
  const dataset = bridge.store.dataset(request.dataset_id);
  // Only development and earlier warmup may influence a candidate. Never send later partitions to the model.
  const development = {
    ...dataset,
    bars: dataset.bars.filter((b) => b.close_time <= request.to_ms),
  };
  const execution = {
    ...resolveRequest(request).execution,
    ...(command.mode === "rerun" ? command.execution_overrides : {}),
  };
  const rerunIR = structuredClone(original);
  if (command.mode === "rerun") {
    const overrides = command.execution_overrides ?? {};
    if (overrides.risk_fraction !== undefined) {
      if (rerunIR.risk.sizing.primitive !== "risk_fraction")
        throw Error("SCHEMA_MISMATCH:risk_fraction_not_applicable");
      rerunIR.risk.sizing.params.fraction = overrides.risk_fraction;
    }
    if (overrides.max_allocation !== undefined)
      rerunIR.risk.sizing.params.max_allocation = overrides.max_allocation;
  }
  const previous =
    input.candidate_index > 1
      ? ctx.store
          .artifacts(ctx.store.inquiry(ctx.inquiry_id).session_id)
          .filter(
            (a) =>
              a.inquiry_id === ctx.inquiry_id &&
              ["strategy_draft", "run_comparison"].includes(
                String((a.content as any).view),
              ),
          )
          .map((a) => {
            const c = a.content as any;
            return {
              title: a.title,
              rules: c.ir ?? null,
              valid: c.valid ?? null,
              changes: c.changes ?? [],
              observation: c.analysis?.observation ?? null,
              notes: c.notes ?? [],
            };
          })
      : [];
  const compiled = await compileStrategy(
    command.mode === "rerun"
      ? {
          ir: rerunIR,
          timeframe: timeframe(dataset.timeframe_ms),
          execution,
          order_gate: request.order_gate,
        }
      : {
          text: `在下面冻结规则上按用户要求作最小修改。只改策略规则，不改变数据、窗口或成本。保留未要求修改的规则。候选编号 ${input.candidate_index}；${input.candidate_index === 2 ? "使用与第一个候选不同的简洁假设，优先改变不同参数。" : ""}\n用户要求：${command.instruction}\n原规则：${JSON.stringify(original)}\n本轮此前候选与真实观察（仅供提出下一条小幅修改；没有观察时不得猜测结果）：${JSON.stringify(previous)}`,
          timeframe: timeframe(dataset.timeframe_ms),
          execution,
          order_gate: request.order_gate,
        },
    ctx.brain,
    development,
  );
  if (ctx.signal.aborted) throw Error("CANCELLED");
  const changes =
    command.mode === "rerun"
      ? [
          ...ruleChanges(
            resolveRequest(request).execution,
            execution,
            "execution",
          ),
          ...ruleChanges(original, compiled.ir, "rules"),
        ]
      : ruleChanges(original, compiled.ir);
  const economic = changes.filter(
    (c) => !["label", "description"].includes(c.field),
  );
  const duplicate = ctx.store
    .artifacts(ctx.store.inquiry(ctx.inquiry_id).session_id)
    .some(
      (a) =>
        a.inquiry_id === ctx.inquiry_id &&
        (a.content as any).view === "strategy_draft" &&
        compiled.ir &&
        canonical((a.content as any).ir) === canonical(compiled.ir),
    );
  const valid =
    compiled.ok &&
    compiled.spec?.ok !== false &&
    !compiled.unmapped?.length &&
    (command.mode === "rerun" || economic.length > 0) &&
    (command.mode !== "optimize" || economic.length <= 2) &&
    !duplicate;
  const notes = [
    !economic.length && command.mode !== "rerun" ? "候选没有改变经济规则" : "",
    command.mode === "optimize" && economic.length > 2
      ? "优化候选最多改变两个规则参数"
      : "",
    duplicate ? "候选与本轮已有草稿重复" : "",
  ].filter(Boolean);
  const draft = ctx.store.putArtifact({
    inquiry_id: ctx.inquiry_id,
    kind: "table",
    title: `候选 ${input.candidate_index} · ${valid ? "规则与变化" : "规则检查未通过"}`,
    question: command.instruction,
    snapshot_refs: [],
    data_kind: "derived",
    availability: valid ? "available" : "partial",
    spec: { type: "table" },
    caption: "草稿尚未代表回测结果；未修改原版。",
    content: check("Object", {
      view: "strategy_draft",
      columns: ["改动项", "原版", "候选"],
      rows: changes.map((c) => [
        c.field,
        JSON.stringify(c.before),
        JSON.stringify(c.after),
      ]),
      ir: compiled.ir ?? null,
      rules: compiled.rules ?? [],
      checks: compiled.checks,
      summary: compiled.summary,
      baseline_run_id: parent.id,
      baseline_hash: parent.manifest.hash,
      command_hash: hash(command),
      execution,
      candidate_index: input.candidate_index,
      valid,
      changes,
      spec: compiled.spec ?? null,
      unmapped: compiled.unmapped ?? [],
      notes,
    }),
  });
  return result(
    { draft_artifact_id: draft.id },
    {
      artifact_refs: [draft.id],
      ...(valid
        ? {}
        : {
            status: "error" as const,
            error_code: "SCHEMA_MISMATCH" as const,
            warnings: ["候选规则未通过检查，草稿与原因已保存"],
          }),
    },
  );
}

export async function runRevision(
  input: { baseline_run_id: string; draft_artifact_id: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const { bridge, command, parent } = environment(ctx, input.baseline_run_id);
  const artifact = ctx.store.artifact(input.draft_artifact_id),
    draft = artifact.content as any;
  if (
    artifact.inquiry_id !== ctx.inquiry_id ||
    draft.view !== "strategy_draft" ||
    !draft.valid ||
    draft.baseline_hash !== parent.manifest.hash ||
    draft.command_hash !== hash(command)
  )
    throw Error("SCHEMA_MISMATCH:draft_identity_mismatch");
  const key = `${ctx.inquiry_id}:revision:${input.draft_artifact_id}`;
  const existing = bridge.store.db
    .prepare("SELECT id FROM research_runs WHERE idempotency_key=?")
    .get(key) as { id: string } | undefined;
  if (existing) return bridge.waitForRun(existing.id, ctx);
  if (bridge.store.sealed(parent.manifest.request.study_id))
    throw Error("NOT_COMPARABLE:study_sealed_after_holdout");
  const request = parent.manifest.request,
    study = bridge.store.study(request.study_id)!;
  if (!revisionContext(bridge, parent.id).remaining_candidates)
    return failure(
      "BUDGET_EXHAUSTED",
      "已用完登记的研究试验额度；修订草稿保留，本次未创建回测",
    );
  const ir = draft.ir as StrategyIR;
  const candidateRequest = { ...request, strategy_ir: ir };
  delete candidateRequest.policy;
  const horizon = requestHorizon(candidateRequest);
  const originalHorizon = requestHorizon(request);
  if (
    (originalHorizon !== null && horizon === null) ||
    (horizon ?? 0) > study.purge_bars
  )
    throw Error("SCHEMA_MISMATCH:holding_exceeds_preregistered_purge");
  const data = bridge.store.dataFor(request);
  if (
    irWarmup(ir, data.timeframe_ms) >
    data.bars.findIndex((b) => b.close_time === request.from_ms)
  )
    throw Error("SCHEMA_MISMATCH:revision_warmup_insufficient");
  const next: ResearchRequest = {
    ...request,
    idempotency_key: key,
    strategy_ir: ir,
    execution: draft.execution,
    parent_run_id: parent.id,
    acknowledge_adaptive_search: true,
    arms: ["a_rules"],
    repeats: 1,
    max_model_calls: 0,
    timeout_ms: Math.min(
      600000,
      Math.max(1000, Math.floor(ctx.budget.remaining())),
    ),
  };
  delete next.policy;
  delete next.source_strategy_ref;
  // Drop inherited overrides: the new rules must pass the same engine's checks themselves.
  delete next.precheck_overrides;
  const checks = await precheck(
    {
      ir,
      dataset_id: request.dataset_id,
      from_ms: request.from_ms,
      to_ms: request.to_ms,
      execution: next.execution,
      order_gate: request.order_gate,
    },
    bridge.store,
  );
  ctx.progress?.({ precheck: checks, draft_artifact_id: artifact.id });
  if (ctx.signal.aborted) throw Error("CANCELLED");
  if (ctx.budget.remaining() < 1000) throw Error("BUDGET_EXHAUSTED");
  const retryRun = bridge.store.db
    .prepare("SELECT id FROM research_runs WHERE idempotency_key=?")
    .get(key) as { id: string } | undefined;
  if (retryRun) return bridge.waitForRun(retryRun.id, ctx);
  if (bridge.store.sealed(request.study_id))
    throw Error("NOT_COMPARABLE:study_sealed_after_holdout");
  if (!revisionContext(bridge, parent.id).remaining_candidates)
    return failure("BUDGET_EXHAUSTED", "登记的试验额度已用完，草稿保留");
  const brain = ctx.brain ?? {
    name: "rules-only",
    complete: async () => {
      throw Error("model_forbidden");
    },
  };
  const row = bridge.service.start(
    next,
    brain,
    {
      kind: "stub",
      model: null,
      name: brain.name,
      configuration_hash: hash({ mode: "rules_only" }),
    },
    null,
    "",
  );
  return bridge.waitForRun(row.id, ctx);
}

export function compareRuns(
  input: { baseline_run_id: string; candidate_run_id: string },
  ctx: ToolContext,
): ToolResult {
  if (!ctx.backtests) throw Error("DATA_MISSING:backtest_service");
  const a = ctx.backtests.store.get(input.baseline_run_id),
    b = ctx.backtests.store.get(input.candidate_run_id);
  if (
    !a ||
    !b ||
    a.status !== "completed" ||
    b.status !== "completed" ||
    !a.result ||
    !b.result
  )
    throw Error("NOT_COMPARABLE:run_incomplete");
  const condition = (r: typeof a) => {
    const q = r.manifest.request;
    return {
      dataset_hash: r.manifest.dataset_hash,
      study_id: q.study_id,
      from_ms: q.from_ms,
      to_ms: q.to_ms,
      purpose: q.purpose,
      execution: resolveRequest(q).execution,
      order_gate: q.order_gate,
      arms: q.arms,
      repeats: q.repeats,
      engine_version: r.manifest.engine_version,
      spec_version: q.spec_version,
    };
  };
  const differences = ruleChanges(condition(a), condition(b));
  const comparable = !differences.length;
  const am = a.result.arms.find(
    (x) => x.arm === "a_rules" || x.arm === "a_rules:0",
  )?.metrics;
  const bm = b.result.arms.find(
    (x) => x.arm === "a_rules" || x.arm === "a_rules:0",
  )?.metrics;
  if (!am || !bm) throw Error("NOT_COMPARABLE:rules_arm_required");
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  const enough = am.closed_trades >= 30 && bm.closed_trades >= 30;
  const observation =
    `原版收益 ${pct(am.net_return)}，候选收益 ${pct(bm.net_return)}；最大回撤 ${pct(am.max_drawdown)} → ${pct(bm.max_drawdown)}；交易数 ${am.closed_trades} → ${bm.closed_trades}。` +
    (!comparable
      ? "验证条件不同，仅并列展示，不计算策略改善幅度。"
      : !enough
        ? "样本不足，不能据此判定候选更有效。"
        : bm.net_return > am.net_return && bm.max_drawdown <= am.max_drawdown
          ? "候选在本开发窗口的收益与回撤均未变差，仍需预留验证段检验。"
          : "收益与风险存在取舍或没有改善，保留原版供选择。");
  const artifact = ctx.store.putArtifact({
    inquiry_id: ctx.inquiry_id,
    kind: "table",
    title: `V${a.manifest.trial_number} 与 V${b.manifest.trial_number} 对照`,
    question: ctx.store.inquiry(ctx.inquiry_id).question,
    snapshot_refs: [],
    data_kind: "derived",
    availability: comparable ? "available" : "partial",
    spec: { type: "comparison" },
    caption:
      "只读冻结结果；没有为比较执行额外回测。开发段观察不等于样本外验证。",
    run_id: b.id,
    content: check("Object", {
      view: "run_comparison",
      columns: [
        "指标",
        `原版 V${a.manifest.trial_number}`,
        `候选 V${b.manifest.trial_number}`,
      ],
      rows: [
        ["扣费后收益", pct(am.net_return), pct(bm.net_return)],
        ["最大回撤", pct(am.max_drawdown), pct(bm.max_drawdown)],
        ["交易数", am.closed_trades, bm.closed_trades],
        ["手续费", am.fees, bm.fees],
      ],
      baseline_run_id: a.id,
      candidate_run_id: b.id,
      baseline_hash: a.manifest.hash,
      candidate_hash: b.manifest.hash,
      comparable,
      condition_differences: differences,
      changes: ruleChanges(
        a.manifest.request.strategy_ir,
        b.manifest.request.strategy_ir,
      ),
      analysis: { observation },
      adopted: false,
      selection_note: "候选已保存，尚未替换原版。",
    }),
  });
  const series = [a, b].map((row, index) => {
    const arm = row.result!.arms.find(
      (x) => x.arm === "a_rules" || x.arm === "a_rules:0",
    );
    const initial = Number(row.manifest.request.execution.initial_cash);
    return {
      name: `${index === 0 ? "原版" : "候选"} V${row.manifest.trial_number}`,
      unit: "%",
      points: (arm?.equity ?? []).map((point) => [
        point.at,
        initial > 0 && Number.isFinite(Number(point.equity))
          ? (Number(point.equity) / initial - 1) * 100
          : null,
      ]),
    };
  });
  const chart = ctx.store.putArtifact({
    inquiry_id: ctx.inquiry_id,
    kind: "chart",
    title: "原版与候选 · 累计收益",
    question: ctx.store.inquiry(ctx.inquiry_id).question,
    snapshot_refs: [],
    data_kind: "derived",
    availability: comparable ? "available" : "partial",
    run_id: b.id,
    spec: { type: "line" },
    caption: comparable
      ? "来自两次已保存的回测结果；相同开发窗口，未重新计算。"
      : "两次验证条件不同，仅展示各自轨迹。",
    content: check("Object", {
      kind: "chart",
      type: "line",
      x: "time",
      title: "累计收益",
      y_label: "%",
      layout: "overlay",
      series,
      baseline_run_id: a.id,
      candidate_run_id: b.id,
      comparable,
    }),
  });
  return result(
    { comparison_artifact_id: artifact.id, comparable, observation },
    { artifact_refs: [artifact.id, chart.id] },
  );
}

export function buildReport(_: unknown, ctx: ToolContext): ToolResult {
  const inquiry = ctx.store.inquiry(ctx.inquiry_id);
  const steps = ctx.store
    .steps(inquiry.id)
    .filter(
      (s) => !["build_research_report", "compose_answer"].includes(s.tool),
    );
  const artifacts = [...new Set(steps.flatMap((s) => s.artifact_refs))].map(
    (id) => ctx.store.artifact(id),
  );
  const run_ids = [
    ...new Set(
      steps
        .map(
          (s) =>
            (s.output_summary.result as any)?.output?.run_id ??
            s.output_summary.run_id,
        )
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  const refs = [...new Set(steps.flatMap((s) => s.snapshot_refs))];
  const observations = artifacts
    .map((a) => (a.content as any).analysis?.observation)
    .filter((x): x is string => typeof x === "string");
  const exhausted =
    ctx.budget.remaining() <= 0 ||
    steps.some((s) => s.error_code === "BUDGET_EXHAUSTED");
  const incomplete =
    exhausted ||
    steps.some((s) => s.status !== "succeeded") ||
    artifacts.some((a) => a.availability !== "available");
  const reason = exhausted
    ? "本轮预算已耗尽，停止继续计算；已完成的证据保留。"
    : incomplete
      ? "部分步骤未完成；已有证据与失败记录保留。"
      : inquiry.plan.command
        ? `已达到本轮最多 ${inquiry.plan.command.max_candidates} 个候选的上限，停止继续探索。`
        : "本轮计划已执行结束。";
  const concepts = inquiry.checkpoint.concepts ?? [];
  const line = (c: (typeof concepts)[number]) =>
    `- ${c.term}${c.target ? `（${c.target}）` : ""}：${c.note}`;
  const group = (status: string) => concepts.filter((c) => c.status === status);
  // 概念覆盖是固定段落:映射了哪些、用什么代理、哪些没支持及原因。知识来源目前只有本地词典与模型,未联网。
  const coverage = concepts.length
    ? [
        `映射到已有实现（${group("mapped").length + group("acquired").length} 个）：`,
        [...group("mapped"), ...group("acquired")].map(line).join("\n") || "- 无",
        `\n用近似实现代理（${group("proxy").length} 个，语义有差异）：`,
        group("proxy").map(line).join("\n") || "- 无",
        `\n没有支持（${group("unmapped").length} 个）：`,
        group("unmapped").map(line).join("\n") || "- 无",
        "\n知识来源：本地词典与模型定义；未联网检索。",
      ].join("\n")
    : "本轮没有需要解析的指标/形态概念。";
  const text = `# 研究报告\n\n${inquiry.question}\n\n## 本轮观察\n\n${observations.length ? observations.join("\n\n") : "本轮没有足够的已计算证据形成结论。"}\n\n## 概念覆盖\n\n${coverage}\n\n## 停止原因\n\n${reason}\n\n## 使用范围\n\n${inquiry.plan.window.from_ms} → ${inquiry.plan.window.to_ms}（UTC Unix 毫秒）。结论限于引用的数据与历史区间。研究结果不代表后续表现。`;
  const report = ctx.store.putArtifact({
    inquiry_id: inquiry.id,
    kind: "markdown",
    title: "本轮研究报告",
    question: inquiry.question,
    snapshot_refs: refs,
    data_kind: "derived",
    availability: incomplete ? "partial" : "available",
    spec: { type: "table" },
    caption: "由已保存的步骤和计算结果生成；不重新取数或调用模型。",
    content: check("Object", {
      view: "research_report",
      text,
      artifact_refs: artifacts.map((a) => ({
        id: a.id,
        title: a.title,
        kind: a.kind,
      })),
      run_ids,
      steps: steps.map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        error_code: s.error_code,
      })),
      stop_reason: reason,
      concepts,
      command: inquiry.plan.command ?? null,
    }),
  });
  return result(
    { report_artifact_id: report.id },
    { artifact_refs: [report.id], snapshot_refs: refs },
  );
}
