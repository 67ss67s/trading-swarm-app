// 研究图表模板(charts.ts)与答案挑图:金额换算、分界线、柱标签、散点点数、挑图上限、模型只能调序与写说明
import { afterEach, describe, expect, it } from "vitest";
import type { BacktestAsset, BacktestReport, BacktestTrade } from "@trading-swarm/contracts";
import { openStateDb } from "../../../../src/state-db.js";
import { LoopStore, DEFAULT_BUDGET } from "../../../../src/demo/research/loop/store.js";
import { Budget } from "../../../../src/demo/research/loop/budget.js";
import { createToolRegistry, ensureCharts, type ToolContext } from "../../../../src/demo/research/loop/tools.js";
import { check } from "../../../../src/demo/research/loop/schema.js";
import {
  assetPnl, drawdownComparison, equityComparison, exitReasonPnl, monthlyHeatmap, pickCharts, strategiesEquity, tradeScatter,
  MAX_ANSWER_CHARTS, money, distinctLabels,
} from "../../../../src/demo/research/loop/charts.js";
import { metrics } from "../strategies/fixtures.js";
import { fakeMarket, fakeAnalyses } from "./fixtures.js";

const DAY = 86400000, T0 = Date.UTC(2022, 0, 1);
const clean: (() => void)[] = [];
afterEach(() => clean.splice(0).forEach((f) => f()));

function trades(n: number, splitAt: number): BacktestTrade[] {
  const reasons = ["stop", "trail", "target"];
  return Array.from({ length: n }, (_, i) => {
    const pnl = i % 3 === 0 ? -50 : 80 + i;
    return { id: `t${i}`, symbol: "BTCUSDT", side: "long", entry_at: T0 + i * 10 * DAY, entry_price: 100, exit_at: T0 + (i * 10 + 5) * DAY, exit_price: 101, qty: 1, pnl, return_pct: pnl / 5000, fees: 1, bars_held: 5, exit_reason: reasons[i % 3]!, segment: T0 + (i * 10 + 5) * DAY >= splitAt ? "out_of_sample" : "in_sample" } as BacktestTrade;
  });
}
function asset(key: string, label: string, kind: "single" | "basket", points: number, splitAt: number, o: Partial<BacktestAsset> = {}): BacktestAsset {
  const equity = Array.from({ length: points }, (_, i) => {
    const pnl_pct = 0.3 * Math.sin(i / 40) * (i / points), bench = i / points; // 持有一路涨到 +100%
    return { at: T0 + i * DAY, equity: 5000 * (1 + pnl_pct), pnl_pct, drawdown: Math.max(0, -pnl_pct) / 2, benchmark_pct: i === 3 ? null : bench, exposure: 0.5 };
  });
  const ts = trades(30, splitAt);
  return {
    key, label, kind, symbols: [key], status: "completed", error: null, metrics: metrics({ trades: ts.length, total_return: equity.at(-1)!.pnl_pct, max_drawdown: 0.12 }), segments: [], equity, trades: ts,
    monthly_returns: Array.from({ length: 14 }, (_, i) => ({ period: `${2022 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`, return: i % 2 ? 0.05 : -0.02, benchmark: null })),
    yearly_returns: [], data: null,
    trade_stats: { exit_reasons: { stop: 10, trail: 10, target: 10 }, holding_histogram: { bins: [], counts: [] }, return_histogram: { bins: [], counts: [] }, long_trades: 30, short_trades: 0, pnl_by_exit_reason: { stop: { count: 10, pnl: -500, avg_return: -0.01 }, trail: { count: 10, pnl: 1200, avg_return: 0.02 }, target: { count: 10, pnl: 900, avg_return: 0.02 } } },
    ...o,
  };
}
function fixtureReport(o: { id?: string; points?: number; basket?: boolean; title?: string; score?: number } = {}): BacktestReport {
  const points = o.points ?? 400, to = T0 + (points - 1) * DAY, split = T0 + Math.floor((to - T0) * 0.7);
  const assets = [asset("BTCUSDT", "BTC", "single", points, split), asset("ETHUSDT", "ETH", "single", points, split)];
  if (o.basket) assets.push(asset("BTC+ETH", "BTC+ETH", "basket", points, split, { per_symbol: [{ symbol: "BTCUSDT", trades: 28, pnl: 600, win_rate: 0.5, contribution: 0.06 }, { symbol: "ETHUSDT", trades: 12, pnl: -200, win_rate: 0.3, contribution: -0.02 }] }));
  return {
    id: o.id ?? "rep_1", created_at: 1, engine_version: "test", title: o.title ?? "20/50 均线金叉", description: "", strategy_ir_hash: "h", strategy_ir: {} as never, timeframe: "1d",
    window: { from_ms: T0, to_ms: to }, segments: [{ name: "in_sample", from_ms: T0, to_ms: split }, { name: "out_of_sample", from_ms: split + 1, to_ms: to }],
    execution: { initial_cash: 5000, fee_rate: 0.001, slippage_bps: 5, sizing_mode: "x", fill_model: "x", basket_weighting: "x", market: "spot", leverage: 1 },
    primary_key: o.basket ? "BTC+ETH" : "BTCUSDT", assets, score: { value: o.score ?? 50, label: "fair", confidence: "low", confidence_reason: "", components: [] },
    run_ids: [`run_${o.id ?? "1"}`], inquiry_id: null, session_id: null, strategy_id: null, strategy_version: null, warnings: [],
  };
}

describe("图表模板", () => {
  it("权益曲线对比:$10k 起换算、持有缺口保留 null、样本外分界竖线、多资产叠加,内容过契约", () => {
    const r = fixtureReport();
    const d = equityComparison(r)!;
    expect(check("Chart", d.content)).toBeTruthy();
    expect(check("Spec", d.spec)).toBeTruthy();
    const [bench, strat, eth] = d.content.series;
    expect(bench!.role).toBe("benchmark");
    expect(strat!.role).toBe("strategy");
    expect(strat!.mode).toBe("line+markers");
    expect(eth!.name).toContain("ETH");
    // initial_cash 是 5000,仍按 $10k 本金:第一点 = 10000,持有末点 ≈ 10000×(1+399/400)
    expect(strat!.points[0]).toEqual([T0, 10000]);
    expect(bench!.points[3]![1]).toBeNull();
    expect(Number(bench!.points.at(-1)![1])).toBeCloseTo(10000 * (1 + 399 / 400), 1);
    expect(d.content.y_unit).toBe("$");
    expect(d.content.x_title).toBe("日期");
    expect(d.content.y_title).toBe("权益 ($)");
    expect(d.content.annotations).toEqual([{ type: "vline", x: r.segments[1]!.from_ms, label: "样本外 →", role: "split" }]);
    expect(d.content.report_id).toBe(r.id);
    expect(d.content.caption).toContain("$10k 起步");
    expect(d.spec.template).toBe("equity_comparison");
  });
  it("长序列抽稀到 ≤1200 点,首尾保留", () => {
    const r = fixtureReport({ points: 5000 });
    const s = equityComparison(r)!.content.series[1]!;
    expect(s.points.length).toBeLessThanOrEqual(1200);
    expect(s.points[0]![0]).toBe(T0);
    expect(s.points.at(-1)![0]).toBe(r.assets[0]!.equity.at(-1)!.at);
  });
  it("回撤对比:策略为负百分数,持有回撤从 benchmark_pct 现算", () => {
    const d = drawdownComparison(fixtureReport())!;
    expect(d.content.y_unit).toBe("%");
    for (const s of d.content.series) for (const [, y] of s.points) if (y !== null) expect(Number(y)).toBeLessThanOrEqual(0);
    // 持有单调上涨 → 回撤恒为 0
    expect(d.content.series[0]!.points.filter((p) => p[1] !== null).every((p) => p[1] === 0)).toBe(true);
    expect(d.content.annotations.some((a) => a.type === "hline" && a.y === 0)).toBe(true);
  });
  it("按退出类型的盈亏柱:按盈亏排序、金额×(10k/initial_cash)、柱顶标笔数、正负角色", () => {
    const d = exitReasonPnl(fixtureReport())!;
    const s = d.content.series[0]!;
    expect(d.content.type).toBe("bar");
    expect(s.points).toEqual([["追踪止损", 2400], ["止盈", 1800], ["止损", -1000]]);
    expect(s.labels).toEqual(["10 笔", "10 笔", "10 笔"]);
    expect(s.point_roles).toEqual(["positive", "positive", "negative"]);
    expect(d.spec.series).toEqual([expect.objectContaining({ text_field: "count_label" })]);
  });
  it("按资产的盈亏柱:篮子按 per_symbol 分腿、标「28T」;单资产报告用各资产结果", () => {
    const basket = assetPnl(fixtureReport({ basket: true }))!;
    expect(basket.content.series[0]!.points).toEqual([["BTC", 600], ["ETH", -200]]);
    expect(basket.content.series[0]!.labels).toEqual(["28T", "12T"]);
    const singles = assetPnl(fixtureReport())!;
    expect(singles.content.series[0]!.points.map((p) => p[0])).toEqual(expect.arrayContaining(["BTC", "ETH"]));
    expect(singles.content.series[0]!.labels).toEqual(["30T", "30T"]);
  });
  it("逐笔散点:点数 = 交易数、序号从 1、盈绿亏红、样本外竖线在第一笔样本外之前", () => {
    const r = fixtureReport();
    const d = tradeScatter(r)!;
    const s = d.content.series[0]!;
    expect(s.points).toHaveLength(30);
    expect(s.points[0]).toEqual([1, -100]);
    expect(s.point_roles![0]).toBe("negative");
    expect(s.point_roles![1]).toBe("positive");
    expect(s.hover![0]).toMatch(/^2022-01-06 · 止损/);
    const firstOos = [...r.assets[0]!.trades].sort((a, b) => a.exit_at - b.exit_at).findIndex((t) => t.segment === "out_of_sample") + 1;
    expect(d.content.annotations).toContainEqual({ type: "vline", x: firstOos - 0.5, label: "样本外 →", role: "split" });
    expect(d.content.x).toBe("linear");
  });
  it("月度热力图:年 × 12 月,缺月为 null", () => {
    const d = monthlyHeatmap(fixtureReport())!;
    expect(d.content.heatmap!.y).toEqual(["2022", "2023"]);
    expect(d.content.heatmap!.z[0]![0]).toBe(-2);
    expect(d.content.heatmap!.z[1]![5]).toBeNull();
  });
  it("多策略横比:每份报告一条 $10k 曲线 + 一条持有", () => {
    const d = strategiesEquity([fixtureReport({ id: "a", title: "A" }), fixtureReport({ id: "b", title: "B" })])!;
    expect(d.content.series.map((s) => s.role)).toEqual(["benchmark", "strategy", "alt"]);
    expect(d.content.report_ids).toEqual(["a", "b"]);
    expect(check("Chart", d.content)).toBeTruthy();
  });
  it("金额缩写", () => {
    expect(money(10000)).toBe("$10k");
    expect(money(9974.38)).toBe("$9.97k");
    expect(money(-1234567)).toBe("-$1.23M");
  });
});

describe("挑图", () => {
  it("验证:权益 → 回撤 → 退出类型 → 资产/散点,不超过上限", () => {
    const picks = pickCharts({ kind: "validate", question: "和持有比怎么样", reports: [fixtureReport()] });
    expect(picks.map((p) => p.template)).toEqual(["equity_comparison", "drawdown_comparison", "exit_reason_pnl", "asset_pnl"]);
  });
  it("诊断:退出类型打头", () => {
    const picks = pickCharts({ kind: "diagnose", question: "为什么跑输", reports: [fixtureReport()] });
    expect(picks[0]!.template).toBe("exit_reason_pnl");
    expect(picks.length).toBeLessThanOrEqual(MAX_ANSWER_CHARTS);
  });
  it("横比:多策略叠加,单图用最高分那份", () => {
    const picks = pickCharts({ kind: "compare", question: "哪组参数好,止损怎么样,每月表现", reports: [fixtureReport({ id: "a", score: 40 }), fixtureReport({ id: "b", score: 70 }), fixtureReport({ id: "c", score: 60 })] });
    expect(picks.map((p) => p.template)).toEqual(["strategies_equity", "strategies_drawdown", "exit_reason_pnl", "monthly_heatmap"]);
    expect(picks[2]!.report_ids).toEqual(["b"]);
    expect(picks[0]!.report_ids).toEqual(["a", "b", "c"]);
  });
  it("策略描述里的「死叉离场」不算问退出:参数扫描只出两张横比图", () => {
    const picks = pickCharts({ kind: "compare", question: "BTC 日线均线金叉做多、死叉离场,20/50 和 10/30 哪组参数更好", reports: [fixtureReport({ id: "a" }), fixtureReport({ id: "b" })] });
    expect(picks.map((p) => p.template)).toEqual(["strategies_equity", "strategies_drawdown"]);
  });
  it("横比图例去掉公共前缀", () => {
    expect(distinctLabels(["EMA20/50 金叉", "EMA20/50 金叉 · 参数 10/30", "EMA20/50 金叉 · 周期 ×0.5"])).toEqual(["基准", "参数 10/30", "周期 ×0.5"]);
    expect(distinctLabels(["A 策略", "B 策略"])).toEqual(["A 策略", "B 策略"]);
  });
  it("没有交易时不出退出类型与散点", () => {
    const r = fixtureReport();
    for (const a of r.assets) { a.trades = []; a.trade_stats = null; }
    expect(pickCharts({ kind: "validate", question: "", reports: [r] }).map((p) => p.template)).toEqual(["equity_comparison", "drawdown_comparison", "asset_pnl"]);
  });
});

describe("研究 loop 接入", () => {
  function setup(reports: BacktestReport[]) {
    const db = openStateDb(":memory:");
    clean.push(() => db.close());
    const store = new LoopStore(db.db), q = store.createInquiry(store.createSession().id, "BTC 均线和持有比", "k1").inquiry;
    const byId = new Map(reports.map((r) => [r.id, r]));
    const fakeResearchStore = { db: { prepare: () => ({ get: (id: string) => (byId.has(id) ? { report_json: JSON.stringify(byId.get(id)) } : undefined) }) } };
    const ctx: ToolContext = { inquiry_id: q.id, step_id: "t", signal: new AbortController().signal, store, budget: new Budget(DEFAULT_BUDGET), now: Date.now, market: fakeMarket(), analyses: fakeAnalyses, backtests: { store: fakeResearchStore } as never };
    // 模拟回测步:报告表格产物 + 步骤出的图
    const tables = reports.map((r) => store.putArtifact({ inquiry_id: q.id, kind: "table", title: r.title, question: q.question, snapshot_refs: [], data_kind: "derived", availability: "available", spec: { type: "table" }, caption: "", content: { kind: "table", columns: [], rows: [], view: "backtest_report", report_id: r.id, analysis: { observation: "观察" }, metrics: {} } }).id);
    const stepCharts = reports.flatMap((r) => ensureCharts(ctx, [r], ["equity_comparison", "trade_scatter"], [], r.run_ids[0]));
    const ids = [...tables, ...stepCharts];
    store.updateInquiry(q.id, { checkpoint: { ...store.inquiry(q.id).checkpoint, artifact_refs: ids } });
    return { ctx, store, ids, registry: createToolRegistry() };
  }
  const compose = (s: ReturnType<typeof setup>, steps: Record<string, unknown>[] = []) => s.registry.call("compose_answer", { question: "BTC 均线和持有比", steps, artifact_ids: s.ids, metrics: {} }, s.ctx);

  it("同一 inquiry 同一报告同一模板只落一次", () => {
    const s = setup([fixtureReport()]);
    const again = ensureCharts(s.ctx, [fixtureReport()], ["equity_comparison"]);
    expect(s.ids).toContain(again[0]);
    const chart = s.store.artifact(again[0]!);
    expect(chart.kind).toBe("chart");
    expect(chart.run_id).toBe("run_1");
    expect((chart.spec as { report_id?: string }).report_id).toBe("rep_1");
  });
  it("模板兜底(无模型):答案里只有 ≤4 张挑中的图,缺的现算,步骤里多出的散点不进答案", async () => {
    const s = setup([fixtureReport()]);
    const r = await compose(s);
    const blocks = (r.output as { blocks: { kind: string; artifact_id?: string }[] }).blocks;
    const charts = blocks.filter((b) => b.kind === "chart_ref").map((b) => (s.store.artifact(b.artifact_id!).content as { template: string }).template);
    expect(charts).toEqual(["equity_comparison", "drawdown_comparison", "exit_reason_pnl", "asset_pnl"]);
    expect(charts).not.toContain("trade_scatter");
    expect(r.artifact_refs.length).toBeGreaterThan(s.ids.length); // 现算的图也登记成本步产物
  });
  it("横比时答案最多 4 张,首张是多策略权益叠加", async () => {
    const s = setup([fixtureReport({ id: "a" }), fixtureReport({ id: "b" }), fixtureReport({ id: "c" })]);
    const r = await compose(s);
    const charts = (r.output as { blocks: { kind: string; artifact_id?: string }[] }).blocks.filter((b) => b.kind === "chart_ref");
    expect(charts.length).toBeLessThanOrEqual(MAX_ANSWER_CHARTS);
    expect((s.store.artifact(charts[0]!.artifact_id!).content as { template: string }).template).toBe("strategies_equity");
  });
  it("模型只能调序与写不带数字的说明:未挑中的图、带数字的说明被剔除", async () => {
    const s = setup([fixtureReport()]);
    const first = await compose(s);
    const picked = (first.output as { blocks: { kind: string; artifact_id?: string }[] }).blocks.filter((b) => b.kind === "chart_ref").map((b) => b.artifact_id!);
    const scatter = s.ids.find((id) => (s.store.artifact(id).content as { template?: string }).template === "trade_scatter")!;
    s.ctx.brain = { name: "fake", complete: async () => ({ text: JSON.stringify({ blocks: [
      { kind: "chart_ref", artifact_id: picked[2], caption: "先看哪类出场在亏钱" },
      { kind: "chart_ref", artifact_id: scatter, caption: "逐笔" },
      { kind: "chart_ref", artifact_id: picked[0], caption: "策略跑输持有 30%" },
    ] }), latency_ms: 0, model: "fake", input_tokens: 0, output_tokens: 0 }) };
    const r = await compose(s);
    const charts = (r.output as { blocks: { kind: string; artifact_id?: string; caption?: string }[] }).blocks.filter((b) => b.kind === "chart_ref");
    expect(charts.map((b) => b.artifact_id)).toEqual([picked[2], picked[0], picked[1], picked[3]].filter((x, i, a) => a.indexOf(x) === i));
    expect(charts[0]!.caption).toBe("先看哪类出场在亏钱");
    expect(charts.some((b) => b.artifact_id === scatter)).toBe(false);
    expect(JSON.stringify(charts)).not.toContain("30%");
    expect(r.warnings).toContain("invalid_answer_block_removed");
  });
});
