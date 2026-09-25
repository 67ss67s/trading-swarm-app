// 全窗口报告的分析产物:每笔收益平均旁边给中位数与截尾均值(报告层派生,不改 BacktestMetrics / 报告哈希)
import { describe, expect, it } from "vitest";
import { _analysisForTest } from "../../../../src/demo/research/loop/tools.js";
import { report } from "../strategies/fixtures.js";

describe("回测分析产物:平均 / 中位数 / 截尾均值", () => {
  it("观察句与 typed metrics 都带三个数,截尾口径写明;报告本身不被改动", () => {
    const r = report({ m: { trades: 20, expectancy: 0.052 } }), a = r.assets[0]!;
    const rets = [...Array(16).fill(-0.01), 0.3, 0.3, 0.3, 0.3];
    a.trades = rets.map((return_pct, i) => ({ id: `t${i}`, symbol: "BTCUSDT", side: "long", entry_at: i, entry_price: 100, exit_at: i + 1, exit_price: 100, qty: 1, pnl: return_pct * 100, return_pct, fees: 0, bars_held: 1, exit_reason: "trail", segment: "in_sample" }) as never);
    const before = JSON.stringify(r);
    const out = _analysisForTest.backtestAnalysis(r);
    expect(JSON.stringify(r)).toBe(before);
    expect(out.observation).toContain("每笔收益 均值 +5.20%、中位数 -1.00%、截尾均值 +2.88%(两端各截 2 笔(20 笔 × 10% 向下取整))");
    const row = out.rows[0] as Record<string, { value: number | null; unit: string; status: string }>;
    expect(row.trade_return_mean!.value).toBeCloseTo(0.052, 12);
    expect(row.trade_return_median!.value).toBeCloseTo(-0.01, 12);
    expect(row.trade_return_trimmed_mean!.value).toBeCloseTo((14 * -0.01 + 2 * 0.3) / 16, 12);
    expect(row.trade_return_median!.status).toBe("insufficient"); // < 30 笔
  });
  it("没有平仓就不写每笔收益;交易列表被截断时写明按保留的笔数算", () => {
    const none = _analysisForTest.backtestAnalysis(report({ m: { trades: 0 } }));
    expect(none.observation.split("\n")[1]).not.toContain("每笔收益"); // BTC 0 笔
    expect(none.observation).toContain("ETH:净收益 +900.00%,同窗口持有 —,最大回撤 -5.00%,10 笔平仓,胜率 50.0%;每笔收益均值 —(报告里没有逐笔交易,中位数/截尾均值不可算)");
    const r = report({ m: { trades: 50, expectancy: 0.01 } });
    r.assets[0]!.trades = [0.02, 0.01].map((return_pct, i) => ({ id: `t${i}`, symbol: "BTCUSDT", side: "long", entry_at: i, entry_price: 100, exit_at: i + 1, exit_price: 100, qty: 1, pnl: 1, return_pct, fees: 0, bars_held: 1, exit_reason: "trail", segment: "in_sample" }) as never);
    expect(_analysisForTest.backtestAnalysis(r).observation).toContain("每笔收益 均值 +1.00%、中位数 +1.50%");
    expect(_analysisForTest.backtestAnalysis(r).observation).toContain("按报告里保留的 2/50 笔");
  });
});
