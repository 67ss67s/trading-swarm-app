import type { IncomingMessage } from "node:http";
import type { StrategyIR } from "@trade-gate/contracts";
import type { RouteContext, RouteHandler } from "../http-extra.js";
import type { ResearchStore } from "./store.js";
import type { ResearchService } from "./service.js";
import { getBacktestReport, listBacktestReports, reportBars, runBacktestReport } from "./backtest-report.js";
import type { BacktestReplay } from "@trade-gate/contracts";
import { timeframeMillis } from "./strategy.js";
import { smcOverlay, smcParamsFromIR, type SmcOverlayOut } from "./primitives/smc.js";
/**
 * §9.46 回测报告路由:
 *   GET  /api/research/backtests/:id              → BacktestReport
 *   GET  /api/research/backtests/:id/replay?asset=&from_ms=&to_ms=&overlay=smc → BacktestReplay(overlay=smc 时多带 smc_overlay: SmcOverlay)
 *   GET  /api/research/backtests?strategy_id=&limit= → {reports: BacktestReportSummary[]}
 *   POST /api/research/backtests {strategy_ir,timeframe,symbols?,from_ms?,to_ms?,title?} → {report_id}(同步,算完才返回)
 * 错误约定同 routes-research.ts:含 not_found → 404,busy/conflict → 409,其余 400。
 */
export function registerBacktestRoutes(ctx: RouteContext, store: ResearchStore, svc: ResearchService, body: (req: IncomingMessage) => Promise<unknown>): void {
  const wrap = (handler: RouteHandler): RouteHandler => async (req, res, url, p) => {
    try { await handler(req, res, url, p); } catch (e) { const message = e instanceof Error ? e.message : String(e); ctx.fail(res, message.includes("not_found") ? 404 : /busy|conflict/.test(message) ? 409 : 400, message, "research_error"); }
  };
  ctx.route("GET", "/api/research/backtests", wrap(async (_req, res, url) => {
    const limit = Number(url.searchParams.get("limit") ?? 50);
    if (!Number.isFinite(limit) || limit < 1) throw Error("invalid_limit");
    ctx.json(res, 200, { reports: listBacktestReports(store, { strategy_id: url.searchParams.get("strategy_id"), limit }) });
  }));
  ctx.route("GET", "/api/research/backtests/:id", wrap(async (_req, res, _url, p) => {
    const r = getBacktestReport(store, p["id"]!);
    if (!r) throw Error("backtest_report_not_found");
    ctx.json(res, 200, r);
  }));
  // K 线回放:报告里某资产的整段 K 线(含预热)+ 逐笔计划(IR 带 order 块时由订单周期执行核给出;没有时 plans 为空,前端退回按成交画入场/出场点)。
  // 窗口缺省取交易窗口;最多 5000 根,超出按窗口尾部截断并标 truncated。
  ctx.route("GET", "/api/research/backtests/:id/replay", wrap(async (_req, res, url, p) => {
    const r = getBacktestReport(store, p["id"]!);
    if (!r) throw Error("backtest_report_not_found");
    const key = url.searchParams.get("asset") ?? r.primary_key, a = r.assets.find((x) => x.key === key);
    if (!a) throw Error("asset_not_found");
    if (a.kind === "basket") throw Error("basket_has_no_single_candles:pick_a_leg");
    const bars = reportBars(store, r, key);
    if (!bars) throw Error("replay_bars_not_found");
    const num = (k: string) => { const v = url.searchParams.get(k); if (v === null) return null; const n = Number(v); if (!Number.isSafeInteger(n)) throw Error(k + "_invalid"); return n; };
    const from = num("from_ms") ?? a.window?.from_ms ?? r.window.from_ms, to = num("to_ms") ?? a.window?.to_ms ?? r.window.to_ms;
    let inWin = bars.filter((b) => b.close_time >= from && b.open_time <= to);
    const truncated = inWin.length > 5000;
    if (truncated) inWin = inWin.slice(-5000);
    const lo = inWin[0]?.open_time ?? from, hi = inWin.at(-1)?.close_time ?? to;
    const overlay = url.searchParams.get("overlay");
    if (overlay !== null && overlay !== "smc") throw Error("overlay_invalid:only_smc");
    const out: BacktestReplay & { smc_overlay?: SmcOverlayOut } = {
      report_id: r.id, asset_key: key, symbol: a.symbols[0] ?? key, timeframe: r.timeframe, from_ms: lo, to_ms: hi, truncated,
      candles: inWin.map((b) => ({ t: b.open_time, o: Number(b.open), h: Number(b.high), l: Number(b.low), c: Number(b.close), v: Number(b.volume) })),
      plans: (a.plans ?? []).filter((pl) => (pl.exit?.at ?? pl.expires_at ?? pl.placed_at) >= lo && pl.placed_at <= hi),
    };
    // SMC 图层:整段 K 线(含预热)从头算,与回测逐根取值同一口径;参数取 IR 里第一个 smc_* 原语,没有就用缺省;只返回与窗口相交的对象
    if (overlay === "smc") out.smc_overlay = smcOverlay(bars, smcParamsFromIR(r.strategy_ir), { from_ms: lo, to_ms: hi });
    ctx.json(res, 200, out);
  }));
  ctx.route("POST", "/api/research/backtests", wrap(async (req, res) => {
    const raw = (await body(req)) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("expected_backtest_request");
    const { strategy_ir, timeframe, symbols, from_ms, to_ms, title } = raw;
    if (!strategy_ir || typeof strategy_ir !== "object") throw Error("strategy_ir_required");
    if (typeof timeframe !== "string") throw Error("timeframe_required");
    timeframeMillis(timeframe);
    if (symbols !== undefined && (!Array.isArray(symbols) || symbols.length > 8 || symbols.some((s) => typeof s !== "string" || !/^[A-Za-z0-9:+/_-]{2,40}$/.test(s)))) throw Error("symbols_invalid");
    for (const [k, v] of [["from_ms", from_ms], ["to_ms", to_ms]] as const) if (v !== undefined && !Number.isSafeInteger(v)) throw Error(k + "_invalid");
    if (title !== undefined && (typeof title !== "string" || title.length > 300)) throw Error("title_invalid");
    const list = symbols as string[] | undefined;
    const report = await runBacktestReport({ store, service: svc }, { strategy_ir: strategy_ir as StrategyIR, timeframe, ...(list?.length ? { symbols: list } : {}), ...(from_ms !== undefined ? { from_ms: from_ms as number } : {}), ...(to_ms !== undefined ? { to_ms: to_ms as number } : {}), ...(title ? { title: title as string } : {}), meta: { session_id: null, inquiry_id: null, question: (title as string | undefined) ?? null, symbol: list?.find((s) => s !== "BTC+ETH") ?? "BTCUSDT" } });
    ctx.json(res, 201, { report_id: report.id });
  }));
}
