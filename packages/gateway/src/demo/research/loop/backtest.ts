import type { ResearchRequest, StrategyIR } from "@trading-swarm/contracts";
import { compileStrategy, irWarmup, requestHorizon } from "../strategy.js";
import { ResearchService } from "../service.js";
import { ResearchStore } from "../store.js";
import { importMarketDataset } from "../market-dataset.js";
import { precheck } from "../precheck.js";
import { prewarmPineSeries } from "../primitives/pine.js";
import { hash } from "../primitives.js";
import { FAST_ENGINE_MARK } from "../engine.js";
import { STRATEGY_SPEC_VERSION } from "../strategy-spec.js";
import { runBacktestReport, reportForRun, reportByKey, okxLoader, rowsToBars, mergeBars, normalizeSymbol, WARMUP_BARS, type BarsLoader, type LoadedBars } from "../backtest-report.js";
import type { BacktestReport } from "@trading-swarm/contracts";
import type { Instrument, Window, MarketData } from "../data/index.js";
import { failure, result, type ToolContext, type ToolResult } from "./tools.js";
const execution: ResearchRequest["execution"] = {
  initial_cash: "10000",
  risk_fraction: "0.01",
  max_allocation: "1",
  fee_rate: "0.001",
  slippage_bps: "5",
  qty_step: "0.00000001",
  min_notional: "5",
  max_opens_per_day: 10,
  sizing_mode: "unit_notional",
};
export class BacktestBridge {
  /** 同一 inquiry 里 A/B 多个回测共用同一份 K 线(同窗口、同预热借数),避免两次取数拿到不同的最后一根 */
  private bars = new Map<string, Promise<LoadedBars>>();
  /** 永续取数(缺省 okxPerpLoader,data/perp-market.ts);测试注入合成永续行情 */
  perpLoader: BarsLoader | null = null;
  constructor(
    readonly store: ResearchStore,
    readonly service: ResearchService,
  ) {}
  /** 研究 loop 的取数:主资产窗口内用计划里的价格快照(与其他步骤同一份),窗口前的预热与其他资产走同一数据层,按 inquiry 缓存。 */
  loader(ctx: ToolContext, primary: { symbol: string; snapshot_id: string | null; rows: Record<string, unknown>[] } | null): BarsLoader {
    const market: MarketData = ctx.market, base = okxLoader({ store: this.store, service: this.service, market });
    return (symbol, timeframe, window, signal) => {
      const key = [ctx.inquiry_id, symbol, timeframe, window.from_ms, window.to_ms].join(":");
      let p = this.bars.get(key);
      if (!p) {
        p = (async (): Promise<LoadedBars> => {
          const step = ({ m: 60000, h: 3600000, d: 86400000 } as Record<string, number>)[timeframe.at(-1)!]! * Number(timeframe.slice(0, -1));
          if (primary && primary.symbol === symbol) {
            const own = rowsToBars(primary.rows, step, window.to_ms);
            if (!own.length) return base(symbol, timeframe, window, signal);
            // 快照之前的预热向数据层借;借不到就按统一预热从快照首根起步(报告里 warmup_borrowed=false)
            const pre = own[0]!.open_time - step > window.from_ms ? await base(symbol, timeframe, { from_ms: window.from_ms, to_ms: own[0]!.open_time - 1 }, signal).then((x) => x.bars.filter((b) => b.close_time < own[0]!.open_time)).catch(() => []) : [];
            return { bars: mergeBars(pre, own), source: `okx:spot:${timeframe}:loop price snapshot${pre.length ? ` + ${pre.length} 根窗口前预热` : ""}`, snapshot_id: primary.snapshot_id };
          }
          return base(symbol, timeframe, window, signal);
        })();
        this.bars.set(key, p);
        p.catch(() => this.bars.delete(key));
      }
      return p;
    };
  }
  compile(input: Parameters<typeof compileStrategy>[0], ctx: ToolContext) {
    return compileStrategy(
      input,
      ctx.brain,
      input.dataset_id ? this.store.dataset(input.dataset_id) : null,
    );
  }
  async run(
    input: {
      instrument: Instrument;
      timeframe: string;
      window: Window;
      ir: StrategyIR;
      price_snapshot?: string;
    },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    if (input.instrument.market_type !== "spot" && input.instrument.market_type !== "perp")
      return failure("UNSUPPORTED_ASSET", "回测引擎只支持现货与 USDT 线性永续");
    // 永续(2026-09-23 WP-F):全窗口报告走订单执行核 + data/perp-market.ts(成交价/标记价 K 线、资金费、分档);
    // IR 没写订单块(或写成现货)时按永续单向做多、1 倍补一个,回测的市场与用户问的一致,并留痕
    const perp = input.instrument.market_type === "perp";
    if (perp && input.ir.order?.market !== "perp") {
      const order = { ...(input.ir.order ?? { direction: "long" as const }), market: "perp" as const, leverage: input.ir.order?.leverage ?? 1 };
      input = { ...input, ir: { ...input.ir, order } };
      ctx.progress?.({ note: `资产是永续,订单块按永续${order.direction === "long" ? "做多" : order.direction === "short" ? "做空" : "双向"} ${order.leverage} 倍回测` });
    }
    // 单资产回测没有资产池:空的 universe.screen 会让引擎报 strategy_screen_requires_universe,剥掉(有内容的筛选才是真需求,照旧报错)
    // 研究 loop 的回测永远是单资产、没有资产池:universe.screen 不管空不空都用不上(模型爱写 require_trend 之类,2026-09-22 实测撞 strategy_screen_requires_universe);
    // 剥掉并在结果里留痕,方向过滤请用 regime
    const droppedScreen = input.ir.universe?.screen && Object.keys(input.ir.universe.screen).length ? JSON.stringify(input.ir.universe.screen) : null;
    if (input.ir.universe) { const { universe: _u, ...rest } = input.ir; input = { ...input, ir: rest as StrategyIR }; }
    if (droppedScreen) ctx.progress?.({ note: `单资产回测没有资产池,已忽略 universe.screen ${droppedScreen};方向过滤请用 regime` });
    const key = ctx.inquiry_id + ":" + ctx.step_id.split(":").at(-1);
    // Consult the persisted key before any data/study work; never launch duplicate runs after timeout.
    const existing = this.store.db
      .prepare("SELECT id FROM research_runs WHERE idempotency_key=?")
      .get(key) as { id: string } | undefined;
    // 开发段 run(旧 service 路径,engine v4)只支持现货做多:永续不建开发段 run,用报告的伪 run id(report:<键>)串起后续对比/诊断步骤,主结论只看全窗口报告
    let run_id = existing?.id ?? (perp ? PERP_RUN_PREFIX + key : undefined);
    if (perp) ctx.progress?.({ note: "永续回测:开发段 run 只支持现货,已跳过;修订链不可用,主结论用全窗口多资产报告(订单执行核)" });
    let reportOnly = false;
    dev: if (!run_id) {
      const snapshot = input.price_snapshot
        ? ctx.store.snapshot(input.price_snapshot)
        : null;
      if (
        !snapshot ||
        snapshot.kind !== "price" ||
        snapshot.instrument.canonical_id !== input.instrument.canonical_id
      )
        throw Error("DATA_MISSING:price_snapshot_required");
      const timeframe_ms =
        ({ m: 60000, h: 3600000, d: 86400000 } as Record<string, number>)[
          input.timeframe.at(-1)!
        ]! * Number(input.timeframe.slice(0, -1));
      if (!Number.isSafeInteger(timeframe_ms) || timeframe_ms <= 0)
        throw Error("SCHEMA_MISMATCH:timeframe");
      const candles = snapshot.rows.map((row) => {
        const open_time = Number(row.open_time ?? row.ts);
        return {
          open_time,
          close_time: open_time + timeframe_ms - 1,
          open: String(row.open),
          high: String(row.high),
          low: String(row.low),
          close: String(row.close),
          volume: String(row.volume),
        };
      });
      const imported = await importMarketDataset(
        this.store,
        {
          symbol: input.instrument.base + input.instrument.quote,
          timeframe: input.timeframe,
          from_ms: input.window.from_ms,
          to_ms: input.window.to_ms,
        },
        false,
        { exchange: "okx", fetchKlines: async () => candles },
      );
      if (ctx.signal.aborted) throw Error("CANCELLED");
      const dataset = this.store.dataset(imported.id),
        warmup = irWarmup(input.ir, timeframe_ms),
        // ResearchStudy 契约 purge_bars ≥ 1;前端切段的约定是 max(holding_bars, 12),没有 time_stop 的 IR 也要留间隔
        purge = Math.max(
          12,
          requestHorizon({ strategy_ir: input.ir } as ResearchRequest) ?? 0,
        );
      const usable = dataset.bars.length - warmup - 2 * (purge + 1),
        segment = Math.floor(usable / 3);
      if (segment < 2) {
        // 用户显式给了短区间(「最近3个月」日线)时切不出开发/验证/保留三段:不建开发段 run,和永续一样只跑全窗口报告(2026-09-23 晚)
        run_id = PERP_RUN_PREFIX + key;
        reportOnly = true;
        ctx.progress?.({ note: "区间太短切不出开发/验证/保留三段,开发段 run 已跳过;修订链不可用,主结论用全窗口报告" });
        break dev;
      }
      const at = (i: number) => dataset.bars[i]!.close_time,
        development_to = warmup + segment - 1,
        validation_from = development_to + purge + 1,
        validation_to = validation_from + segment - 1,
        holdout_from = validation_to + purge + 1;
      const study = this.store.putStudy({
        // 一轮里可能有多个回测步(A 策略/B 策略),study 按步骤分开,否则第二次 putStudy 撞 study_immutable(2026-09-22 实测)
        id: "loop-" + key,
        dataset_id: imported.id,
        from_ms: at(warmup),
        development_to_ms: at(development_to),
        validation_from_ms: at(validation_from),
        validation_to_ms: at(validation_to),
        holdout_from_ms: at(holdout_from),
        to_ms: at(dataset.bars.length - 1),
        purge_bars: purge,
        max_trials: 5,
      });
      // 预检查只是零模型的提示(频率/预热/止损放宽率),不是回测前置条件:重 IR(Pine 序列 + 日线结构门,4h 六年)会超 15 秒预算,
      // 超时就记一条提示继续跑全窗口回测,不能让整步判失败(2026-09-23 实测 Coppock 4h 因此 PROVIDER_ERROR)
      // Pine 序列先异步算好(预检查和开发段 run 逐根取值时只读缓存,不走同步 HTTP 堵事件循环)
      await prewarmPineSeries(input.ir, dataset.bars, timeframe_ms).catch(() => undefined);
      let checks: Awaited<ReturnType<typeof precheck>> | { skipped: string };
      try {
        checks = await precheck({ ir: input.ir, dataset_id: imported.id, from_ms: study.from_ms, to_ms: study.development_to_ms, execution }, this.store);
      } catch (e) {
        if (!/precheck_time_budget/.test(String(e))) throw e;
        checks = { skipped: "precheck_time_budget" };
        ctx.progress?.({ note: "预检查超过时间预算已跳过(重指标/长窗口),直接跑全窗口回测" });
      }
      ctx.progress?.({ precheck: checks });
      if (ctx.signal.aborted) throw Error("CANCELLED");
      if (ctx.budget.remaining() < 1000) throw Error("BUDGET_EXHAUSTED");
      const brain = ctx.brain ?? {
        name: "research-rules-only",
        complete: async () => {
          throw Error("model_unavailable");
        },
      };
      const request: ResearchRequest = {
        idempotency_key: key,
        dataset_id: imported.id,
        strategy_ir: input.ir,
        execution,
        from_ms: study.from_ms,
        to_ms: study.development_to_ms,
        arms: ["a_rules"],
        repeats: 1,
        max_model_calls: 0,
        timeout_ms: Math.min(
          600000,
          Math.max(1000, Math.floor(ctx.budget.remaining())),
        ),
        study_id: study.id,
        purpose: "development",
        acknowledge_adaptive_search: false,
        // engine v4 快路径(见 engine.ts):开发段 run 只给修订/优化链用,主结论看全窗口报告
        spec_version: STRATEGY_SPEC_VERSION + FAST_ENGINE_MARK,
      };
      // 引擎同一时刻只跑一个 run;A/B 两个回测步会被执行器并行派发,后到的在这里排队等前一条跑完(2026-09-22 实测 research_busy)
      for (;;) {
        try {
          run_id = this.service.start(
            request,
            brain,
            {
              kind: "stub",
              model: null,
              name: brain.name,
              configuration_hash: hash({ name: brain.name, mode: "rules_only" }),
            },
            null,
            "",
          ).id;
          break;
        } catch (e) {
          if (!/research_busy/.test(String(e))) throw e;
          if (ctx.signal.aborted) throw Error("CANCELLED");
          if (ctx.budget.remaining() < 1000) throw Error("BUDGET_EXHAUSTED");
          ctx.progress?.({ note: "等待前一个回测完成" });
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(500, ctx.budget.remaining())));
        }
      }
    }
    // 全窗口多资产报告(主结论):与开发段 run 同时进行,run 在服务里异步跑
    const snapshot = input.price_snapshot ? ctx.store.snapshot(input.price_snapshot) : null;
    const symbol = normalizeSymbol(input.instrument.base + input.instrument.quote);
    let report: BacktestReport | null = reportByKey(this.store, key);
    if (!report) {
      const q = ctx.store.inquiry(ctx.inquiry_id);
      ctx.progress?.({ note: "全窗口多资产回测(主资产 + BTC + ETH + BTC/ETH 篮子)" });
      report = await runBacktestReport(
        { store: this.store, service: this.service, loader: this.loader(ctx, snapshot ? { symbol, snapshot_id: snapshot.id, rows: snapshot.rows as Record<string, unknown>[] } : null), ...(this.perpLoader ? { perpLoader: this.perpLoader } : {}) },
        { strategy_ir: input.ir, timeframe: input.timeframe, from_ms: input.window.from_ms, to_ms: input.window.to_ms, meta: { session_id: q.session_id, inquiry_id: ctx.inquiry_id, question: q.question, symbol }, idempotency_key: key, run_ids: [run_id], timeout_ms: Math.max(1000, Math.floor(ctx.budget.remaining())) },
        ctx.signal,
      );
    }
    ctx.progress?.({ report_id: report.id });
    if (perp) return result({ run_id, status: "completed", ...reportOutput(report, "永续回测没有开发段 run(旧引擎只支持现货),修订链不可用;指标来自全窗口订单执行核报告") });
    if (reportOnly) return result({ run_id, status: "completed", ...reportOutput(report, "区间太短没有开发段 run,修订链不可用;指标来自全窗口报告") });
    const r = await this.waitForRun(run_id, ctx);
    if (r.status !== "ok" || !r.output) return r;
    return { ...r, output: { ...(r.output as Record<string, unknown>), ...reportOutput(report) } };
  }
  report(id: string) { return reportForRun(this.store, id); }
  async waitForRun(run_id: string, ctx: ToolContext): Promise<ToolResult> {
    ctx.progress?.({ run_id });
    const cancel = () => this.service.cancel(run_id!);
    ctx.signal.addEventListener("abort", cancel, { once: true });
    try {
      for (;;) {
        const row = this.store.get(run_id)!;
        if (!["queued", "running", "cancelling"].includes(row.status))
          return result(
            {
              run_id,
              status: row.status,
              closed_trades: row.result?.arms[0]?.metrics.closed_trades ?? null,
              metrics:
                row.result?.arms.map((a) => ({
                  arm: a.arm,
                  metrics: a.metrics,
                })) ?? [],
            },
            {
              ...(row.status !== "completed"
                ? {
                    status: "error" as const,
                    error_code:
                      row.status === "cancelled" ? ("CANCELLED" as const)
                        : row.status === "budget_exhausted" || row.result?.status === "budget_exhausted" ? ("BUDGET_EXHAUSTED" as const)
                        : ("PROVIDER_ERROR" as const),
                  }
                : {}),
            },
          );
        if (ctx.signal.aborted) cancel();
        if (ctx.budget.remaining() <= 0) {
          cancel();
          return result(
            { run_id, status: row.status },
            { status: "error", error_code: "BUDGET_EXHAUSTED" },
          );
        }
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(25, ctx.budget.remaining())),
        );
      }
    } finally {
      ctx.signal.removeEventListener("abort", cancel);
    }
  }
  activeRun(inquiry_id: string) {
    const rows = this.store.db
      .prepare(
        "SELECT json_extract(output_summary_json,'$.run_id') AS run_id FROM research_steps WHERE inquiry_id=?",
      )
      .all(inquiry_id) as { run_id: string | null }[];
    for (const { run_id } of rows) {
      if (!run_id) continue;
      const run = this.store.get(run_id);
      if (run && ["queued", "running", "cancelling"].includes(run.status))
        return run;
    }
    return null;
  }
  comparison(input: {
    run_id: string;
    arm: "a_rules" | "b_agent" | "c_filter";
  }) {
    if (input.run_id.startsWith(PERP_RUN_PREFIX)) {
      // 永续的伪 run:只有全窗口报告,持有对比/诊断都读报告
      const report = reportForRun(this.store, input.run_id);
      if (!report) throw Error("NOT_COMPARABLE:no_full_window_report_for_run");
      const primary = report.assets.find((a) => a.key === report.primary_key);
      return { report, bars: [], window: report.window, fee_rate: String(report.execution.fee_rate), slippage_bps: String(report.execution.slippage_bps), strategy_net_return: primary?.metrics?.total_return ?? null, closed_trades: primary?.metrics?.trades ?? 0, snapshot_refs: this.snapshotRefs(input.run_id) };
    }
    const run = this.store.get(input.run_id);
    if (!run) throw Error("run_not_found");
    if (run.status !== "completed" || !run.result)
      throw Error("NOT_COMPARABLE:run_incomplete");
    const arm = run.result.arms.find(
      (a) => a.arm === input.arm || a.arm === input.arm + ":0",
    );
    if (!arm) throw Error("SCHEMA_MISMATCH:arm_not_found");
    const request = run.manifest.request;
    return {
      report: reportForRun(this.store, run.id),
      bars: this.store.dataFor(request).bars,
      window: { from_ms: request.from_ms, to_ms: request.to_ms },
      fee_rate: request.execution.fee_rate,
      slippage_bps: request.execution.slippage_bps,
      strategy_net_return: arm.metrics.net_return,
      closed_trades: arm.metrics.closed_trades,
      snapshot_refs: this.snapshotRefs(run.id),
    };
  }
  private snapshotRefs(run_id: string): string[] {
    const checkpoint = this.store.db
      .prepare(
        "SELECT checkpoint_json FROM research_inquiries WHERE id=(SELECT inquiry_id FROM research_steps WHERE json_extract(output_summary_json,'$.run_id')=? LIMIT 1)",
      )
      .get(run_id) as { checkpoint_json: string } | undefined;
    return checkpoint ? (JSON.parse(checkpoint.checkpoint_json) as { snapshot_refs: string[] }).snapshot_refs : [];
  }
}
/** 永续回测没有开发段 run,用 report:<幂等键> 作 run_id(报告的 run_ids / run_id 列同值),对比与诊断据此找报告 */
export const PERP_RUN_PREFIX = "report:";

/** run_backtest 工具输出:closed_trades / metrics 换成全窗口主资产口径(开发段 run 的指标只留在 run 里,给修订链用)。 */
export function reportOutput(report: BacktestReport, note?: string) {
  const primary = report.assets.find((a) => a.key === report.primary_key);
  return {
    closed_trades: primary?.metrics?.trades ?? null,
    metrics: [
      {
        arm: "a_rules",
        scope: "full_window",
        ...(note ? { note } : {}),
        market: report.execution.market,
        leverage: report.execution.leverage,
        plan_stats: primary?.plan_stats ?? null,
        report_id: report.id,
        engine_version: report.engine_version,
        window: report.window,
        segments: primary?.segments.map((s) => ({ name: s.name, from_ms: s.from_ms, to_ms: s.to_ms, metrics: s.metrics })) ?? [],
        metrics: primary?.metrics ?? null,
        score: report.score,
        assets: report.assets.map((a) => ({ key: a.key, status: a.status, error: a.error, total_return: a.metrics?.total_return ?? null, benchmark_return: a.metrics?.benchmark_return ?? null, trades: a.metrics?.trades ?? null })),
      },
    ],
  };
}
export { WARMUP_BARS };
