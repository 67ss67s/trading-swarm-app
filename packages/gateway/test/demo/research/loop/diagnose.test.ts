import { describe, expect, it } from "vitest";
import { diagnoseReport } from "../../../../src/demo/research/loop/diagnose.js";
import { report, metrics, defaultIR } from "../strategies/fixtures.js";

describe("回测诊断(零模型)", () => {
  it("空仓时间长 + 止损过紧 + 样本外转负 都被点名,且带数值", () => {
    const r = report({ m: { trades: 20, benchmark_return: 12, total_return: 0.3, time_in_market: 0.2, fees: 300, net_pnl: 3000 } });
    const a = r.assets[0]!;
    a.trade_stats = { exit_reasons: { stop: 12, trail: 8 }, holding_histogram: { bins: [], counts: [] }, return_histogram: { bins: [], counts: [] }, long_trades: 20, short_trades: 0, pnl_by_exit_reason: { stop: { count: 12, pnl: -4950, avg_return: -0.04 }, trail: { count: 8, pnl: 7950, avg_return: 0.08 } } } as never;
    a.segments = [{ name: "in_sample", from_ms: 0, to_ms: 1, metrics: metrics({ total_return: 0.5, benchmark_return: 8 }) }, { name: "out_of_sample", from_ms: 1, to_ms: 2, metrics: metrics({ total_return: -0.1, benchmark_return: 0.4 }) }];
    const d = diagnoseReport(r);
    const keys = d.findings.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["exposure", "stop_tight", "decay", "fees", "sample"]));
    expect(d.findings.filter((f) => f.severity === "high").map((f) => f.key)).toEqual(expect.arrayContaining(["exposure", "stop_tight", "decay"]));
    expect(d.observation).toContain("60%");
    expect(d.observation).toContain("-4950");
  });
  it("没有 metrics 时如实说没有可诊断结果", () => {
    const d = diagnoseReport(report({ status: "failed" }));
    expect(d.findings[0]!.key).toBe("no_metrics");
  });
});

describe("诊断 v2:skill 检查项(合成报告)", () => {
  const withTrades = (reasons: string[], o: Parameters<typeof report>[0] = {}) => {
    const r = report(o), a = r.assets[0]!;
    a.trades = reasons.map((exit_reason, i) => ({ id: `t${i}`, symbol: "BTCUSDT", side: "long", entry_at: i, entry_price: 100, exit_at: i + 1, exit_price: 101, qty: 1, pnl: 10, return_pct: 0.01, fees: 0, bars_held: 1, exit_reason, segment: "in_sample" }) as never);
    a.metrics!.trades = reasons.length;
    a.trade_stats = { exit_reasons: reasons.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {}), holding_histogram: { bins: [], counts: [] }, return_histogram: { bins: [], counts: [] }, long_trades: reasons.length, short_trades: 0 } as never;
    return r;
  };
  const trailIR = () => { const ir = defaultIR(); ir.exit = [{ primitive: "indicator_cross_exit", params: { indicator: "ema", args: { period: 20 }, compare_to: "indicator", compare_indicator: "ema", compare_args: { period: 50 }, direction: "cross_below" } }, { primitive: "chandelier_trail", params: { atr_period: 22, multiple: 3 } }]; ir.signal = [{ primitive: "ema_cross", params: { fast: 10, slow: 30 } }] as never; return ir; };
  it("忠实度:用户没提追踪却有追踪 → 按笔数判级;提到了就不报;没有原问题就跳过", () => {
    const r = withTrades(["trail", "trail", "trail", "indicator_cross_exit"], { ir: trailIR(), m: { exposure: 0.3, time_in_market: 0.3 } });
    r.assets[0]!.metrics!.total_return = 1.01 ** 4 - 1;
    const d = diagnoseReport(r, { question: "日线 10/30 均线金叉做多、死叉离场" });
    const f = d.findings.find((x) => x.key === "faithful_trail")!;
    expect(f.severity).toBe("high");
    expect(f.text).toContain("4 笔平仓里 3 笔(75%)");
    expect(diagnoseReport(r, { question: "金叉做多、死叉离场,吊灯追踪止损" }).findings.some((x) => x.key === "faithful_trail")).toBe(false);
    expect(diagnoseReport(r).findings.some((x) => x.key.startsWith("faithful_"))).toBe(false);
  });
  it("参数不一致:入场 10/30、离场 20/50;变体数 ≥2 才提示", () => {
    const r = withTrades(["indicator_cross_exit"], { ir: trailIR() });
    const d = diagnoseReport(r, { question: "均线", variants: 4 });
    expect(d.findings.find((x) => x.key === "param_mismatch")!.text).toContain("10/30");
    expect(d.findings.find((x) => x.key === "variants")!.text).toContain("4 个变体");
    expect(diagnoseReport(r, { question: "均线", variants: 1 }).findings.some((x) => x.key === "variants")).toBe(false);
  });
  it("核数:满仓口径下连乘对不上、又没有期末持仓说明 → high", () => {
    const r = withTrades(["stop", "stop"], { m: { total_return: 0.5, exposure: 0.4, time_in_market: 0.4 } });
    const f = diagnoseReport(r).findings.find((x) => x.key === "reconcile")!;
    expect(f.severity).toBe("high");
    expect(f.text).toContain("+2.0%");
    r.warnings = ["BTCUSDT 期末仍有持仓,按最后收盘价盯市计入净值,不计入已平仓统计"];
    expect(diagnoseReport(r).findings.find((x) => x.key === "reconcile")!.severity).toBe("medium");
  });
  it("订单计划:做空限价挂在信号价下方也算挂错边;被拦原因与止损放宽按计划逐条统计", () => {
    const r = withTrades(["sl"], { m: { exposure: 0.1, time_in_market: 0.1 } });
    const plan = (o: Record<string, unknown>) => ({ side: "short", status: "filled", blocked_reason: null, entry_type: "limit", entry_price: 99, reference_price: 100, stop: { price: 102, note: "pivot" }, ...o });
    r.assets[0]!.plans = [plan({}), plan({}), plan({ status: "blocked", blocked_reason: "min_rr", stop: { price: 103, note: "pivot;cost_floor 放宽到 2.40%" } }), plan({ status: "blocked", blocked_reason: "stop_side", entry_price: 101 })] as never;
    const d = diagnoseReport(r, { question: "BTC 反弹做空" });
    expect(d.findings.find((x) => x.key === "limit_wrong_side")!.text).toContain("4 个限价计划里 3 个(75%)");
    expect(d.findings.find((x) => x.key === "blocked")!.text).toContain("被拦 2(50%:盈亏比不足 1、止损在错误一侧 1)");
    expect(d.findings.find((x) => x.key === "stop_widened")!.text).toContain("4 个带止损的计划里 1 个(25%)的止损被放宽到成本下限 2.40%");
  });
});

describe("诊断 v3:每笔收益平均旁边给中位数与截尾均值", () => {
  const withReturns = (rets: number[], reason = "stop") => {
    const r = report({ m: { trades: rets.length, exposure: 0.9, time_in_market: 0.9 } }), a = r.assets[0]!;
    a.trades = rets.map((return_pct, i) => ({ id: `t${i}`, symbol: "BTCUSDT", side: "long", entry_at: i, entry_price: 100, exit_at: i + 1, exit_price: 100 * (1 + return_pct), qty: 1, pnl: 100 * return_pct, return_pct, fees: 0, bars_held: 1, exit_reason: reason, segment: "in_sample" }) as never);
    a.trade_stats = { exit_reasons: { [reason]: rets.length }, holding_histogram: { bins: [], counts: [] }, return_histogram: { bins: [], counts: [] }, long_trades: rets.length, short_trades: 0, pnl_by_exit_reason: { [reason]: { count: rets.length, pnl: rets.reduce((s, x) => s + 100 * x, 0), avg_return: rets.reduce((s, x) => s + x, 0) / rets.length } } } as never;
    return r;
  };
  it("一簇大赚撑起平均:均值为正、中位与截尾不为正 → medium,文字带三个数和截尾口径", () => {
    const d = diagnoseReport(withReturns([...Array(16).fill(-0.01), 0.3, 0.3, 0.3, 0.3], "trail"));
    const f = d.findings.find((x) => x.key === "trade_center")!;
    expect(f.severity).toBe("medium");
    expect(f.text).toContain("均值 +5.20%");
    expect(f.text).toContain("中位数 -1.00%");
    expect(f.text).toContain("截尾均值 +2.88%");
    expect(f.text).toContain("两端各截 2 笔");
    expect(f.text).toContain("平均值靠少数几笔大赚撑起");
    // 按退出方式的平均也带中位 / 截尾
    expect(d.findings.find((x) => x.key === "exit_mix")!.text).toContain("平均 +5.2%(中位 -1.0%,截尾 +2.9%)");
  });
  it("方向一致时只是 info;不足 10 笔写明不截尾", () => {
    const d = diagnoseReport(withReturns([0.01, 0.02, 0.03]));
    const f = d.findings.find((x) => x.key === "trade_center")!;
    expect(f.severity).toBe("info");
    expect(f.text).toContain("笔数 3 < 10,不截尾");
    expect(d.method_version).toBe("diagnose/v3");
  });
});
