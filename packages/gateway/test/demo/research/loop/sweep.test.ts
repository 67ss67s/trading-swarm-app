import { describe, expect, it } from "vitest";
import type { StrategyIR } from "@trading-swarm/contracts";
import { candidateVariants, explicitGroups, sweepVariants } from "../../../../src/demo/research/loop/sweep.js";

const ir = {
  version: 1, label: "均线交叉", description: "",
  signal: [{ primitive: "ema_cross", params: { fast: 20, slow: 50 } }],
  entry: { primitive: "next_open", params: {} },
  risk: { stop: { primitive: "atr_stop", params: { period: 14, multiple: 2.5 } }, sizing: { primitive: "risk_fraction", params: {} } },
  exit: [{ primitive: "chandelier_trail", params: { period: 22, multiple: 3 } }],
} as unknown as StrategyIR;

describe("参数扫描派生", () => {
  it("显式参数组同步改到离场里嵌套的同值周期(死叉离场跟着变)", () => {
    const x = structuredClone(ir) as any;
    x.exit = [{ primitive: "indicator_cross_exit", params: { indicator: "ema", args: { period: 20 }, compare_to: "indicator", compare_indicator: "ema", compare_args: { period: 50 }, direction: "cross_below" } }];
    const v = candidateVariants(x, "均线 20/50 和 10/30 比较")[0]!;
    expect(v.label).toBe("参数 10/30");
    expect((v.ir.exit[0] as any).params.args.period).toBe(10);
    expect((v.ir.exit[0] as any).params.compare_args.period).toBe(30);
  });
  it("解析问题里的显式参数组", () => {
    expect(explicitGroups("20/50 和 10/30 哪个好")).toEqual([[20, 50], [10, 30]]);
    expect(explicitGroups("RSI 周期 7、14、21 比较")).toEqual([[7], [14], [21]]);
    expect(explicitGroups("换参数看看")).toEqual([]);
  });
  it("显式取值映射到信号段,和基准相同的组被去重", () => {
    const v = candidateVariants(ir, "均线 20/50 和 10/30 比较");
    expect(v[0]!.label).toBe("参数 10/30");
    expect(v[0]!.changes).toEqual([{ path: "signal.0.params.fast", from: 20, to: 10 }, { path: "signal.0.params.slow", from: 50, to: 30 }]);
    expect((v[0]!.ir.risk.stop.params as { multiple: number }).multiple).toBe(2.5);
  });
  it("没给取值就做周期敏感性,倍数类参数不动", () => {
    const v = candidateVariants(ir, "参数敏感吗");
    expect(v[0]!.label).toBe("周期 ×0.5");
    expect(v[0]!.ir.signal[0].params).toEqual({ fast: 10, slow: 25 });
    expect(v[0]!.ir.exit[0].params).toEqual({ period: 11, multiple: 3 });
    expect(v[1]!.label).toBe("周期 ×2");
  });
  it("编译不过的变体被跳过并记录原因", async () => {
    let n = 0;
    const ctx = { backtests: { compile: async (x: { ir: StrategyIR }) => (n++ === 0 ? { ok: false, ir: null, checks: [{ name: "params", ok: false, message: "fast out of range" }] } : { ok: true, ir: x.ir, checks: [] }) } } as never;
    const out = await sweepVariants({ ir, question: "参数敏感吗", timeframe: "1d" }, ctx);
    expect(out.variants.map((v) => v.label)).toEqual(["周期 ×2", "周期 ×1.5"]);
    expect(out.rejected[0]!.reason).toContain("fast out of range");
  });
});
