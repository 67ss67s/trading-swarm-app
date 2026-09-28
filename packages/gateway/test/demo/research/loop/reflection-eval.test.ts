// 复盘 skill 零成本离线评测:09-23 的 5 份真实回测报告(裁剪后夹具,见 fixtures/build-reflection-reports.mjs)
// 跑诊断 v2,确认 skill 里的检查项都能触发、数值与从报告独立算出的一致。零模型调用。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BacktestReport } from "@trade-gate/contracts";
import { diagnoseReport, type Diagnosis } from "../../../../src/demo/research/loop/diagnose.js";

interface Case { short: string; question: string | null; variants: number | null; report: BacktestReport }
const CASES: Case[] = JSON.parse(readFileSync(new URL("./fixtures/reflection-reports.json", import.meta.url), "utf8"));
const byShort = (s: string) => CASES.find((c) => c.short === s)!;
const run = (s: string): Diagnosis => { const c = byShort(s); return diagnoseReport(c.report, { question: c.question, variants: c.variants }); };
const find = (d: Diagnosis, key: string) => d.findings.find((f) => f.key === key);
const primary = (r: BacktestReport) => r.assets.find((a) => a.key === r.primary_key)!;
const pct1 = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

describe("复盘评测:真实报告触发 skill 检查项", () => {
  it("夹具是 5 份真实报告,且都带原问题", () => {
    expect(CASES.map((c) => c.short)).toEqual(["c7b8d3c1", "4d23af81", "7689ff1b", "7be99184", "7f53fe31"]);
    for (const c of CASES) expect(c.question, c.short).toBeTruthy();
  });

  it("1% 风险仓位(c7b8d3c1):仓位口径失真排第一档,不再说「空仓是首要来源」,也不拿逐笔连乘核数", () => {
    const d = run("c7b8d3c1"), a = primary(byShort("c7b8d3c1").report), m = a.metrics!;
    const held = m.exposure / m.time_in_market;
    const sizing = find(d, "sizing")!;
    expect(sizing.severity).toBe("high");
    expect(sizing.text).toContain(`${(held * 100).toFixed(1)}%`);
    expect(sizing.text).toContain("risk_fraction");
    expect(sizing.text).toContain(pct1(m.total_return));
    expect(sizing.text).toContain(pct1(m.benchmark_return!));
    expect(find(d, "reconcile")).toBeUndefined();
    expect(find(d, "exposure")!.text).toContain("仓位口径失真");
    expect(find(d, "exposure")!.severity).not.toBe("high");
    expect(find(d, "faithful_trail")!.text).toContain("16 笔平仓里 12 笔(75%)");
  });

  it("死叉离场被塞追踪(4d23af81):17/22 笔由追踪离场,判高;止盈、止损各 2 笔;核数一致", () => {
    const d = run("4d23af81"), a = primary(byShort("4d23af81").report);
    const trail = find(d, "faithful_trail")!;
    expect(trail.severity).toBe("high");
    expect(trail.text).toContain("22 笔平仓里 17 笔(77%)");
    expect(trail.text).toContain("chandelier_trail");
    expect(find(d, "faithful_target")!.text).toContain("22 笔平仓里 2 笔");
    expect(find(d, "faithful_stop")!.text).toContain("22 笔平仓里 2 笔");
    const prod = a.trades.reduce((s, t) => s * (1 + t.return_pct), 1) - 1;
    const rec = find(d, "reconcile")!;
    expect(rec.severity).toBe("info");
    expect(rec.text).toContain(pct1(a.metrics!.total_return));
    expect(rec.text).toContain(pct1(prod));
    expect(rec.text).toContain("一致");
    // 同敞口持有 = 持有 × 平均敞口
    expect(find(d, "exposure")!.text).toContain(pct1(a.metrics!.benchmark_return! * (a.capital_usage?.avg_exposure ?? a.metrics!.exposure)));
  });

  it("10/30 变体(7689ff1b):期末持仓解释核数差额、入场离场参数不一致、同策略 3 个变体", () => {
    const d = run("7689ff1b"), a = primary(byShort("7689ff1b").report), m = a.metrics!;
    const prod = a.trades.reduce((s, t) => s * (1 + t.return_pct), 1) - 1;
    const rec = find(d, "reconcile")!;
    expect(rec.severity).toBe("medium");
    expect(rec.text).toContain(pct1(prod));
    expect(rec.text).toContain(pct1((1 + m.total_return) / (1 + prod) - 1));
    expect(rec.text).toContain("期末未平仓");
    expect(find(d, "param_mismatch")!.text).toContain("入场信号用 10/30,离场仍用 20/50");
    expect(find(d, "variants")!.text).toContain("3 个变体");
    expect(find(d, "faithful_trail")).toBeUndefined(); // 这份 IR 没有追踪
    expect(find(d, "faithful_stop")!.text).toContain("25 笔平仓里 9 笔(36%)");
  });

  it("SMC(7be99184):止损放宽比例与被拦原因分布,数值与计划逐条统计一致;问题说了止损止盈,不报忠实度", () => {
    const d = run("7be99184"), a = primary(byShort("7be99184").report);
    const plans = a.plans!, withStop = plans.filter((p) => p.stop), widened = withStop.filter((p) => p.stop!.note.includes("cost_floor"));
    const w = find(d, "stop_widened")!;
    expect(w.severity).toBe("high");
    expect(w.text).toContain(`${withStop.length} 个带止损的计划里 ${widened.length} 个(${Math.round((widened.length / withStop.length) * 100)}%)`);
    expect(w.text).toContain("2.40%");
    const blocked = plans.filter((p) => p.status === "blocked").length;
    expect(find(d, "blocked")!.text).toContain(`被拦 ${blocked}`);
    expect(find(d, "blocked")!.text).toContain(`盈亏比不足 ${blocked}`);
    expect(find(d, "stop_tight")!.text).toContain("成本下限");
    expect(d.findings.some((f) => f.key.startsWith("faithful_"))).toBe(false);
    expect(find(d, "limit_wrong_side")).toBeUndefined();
  });

  it("ETH 回踩(7f53fe31):限价全部挂在信号价上方,点名「回踩」没被表达;被拦 115 = 盈亏比 69 + 止损错边 46", () => {
    const d = run("7f53fe31"), a = primary(byShort("7f53fe31").report);
    const lim = a.plans!.filter((p) => p.entry_type === "limit"), above = lim.filter((p) => p.entry_price! > p.reference_price).length;
    const w = find(d, "limit_wrong_side")!;
    expect(w.severity).toBe("high");
    expect(w.text).toContain(`${lim.length} 个限价计划里 ${above} 个(100%)`);
    expect(w.text).toContain("回踩");
    const b = find(d, "blocked")!;
    expect(b.severity).toBe("high");
    expect(b.text).toContain("被拦 115");
    expect(b.text).toContain("盈亏比不足 69");
    expect(b.text).toContain("止损在错误一侧 46");
    expect(b.text).toContain("跳空失效 14");
  });

  it("每条 finding 都带数值(纯提示类除外),且严重项排在前面", () => {
    for (const c of CASES) {
      const d = run(c.short), order = { high: 0, medium: 1, info: 2 } as const;
      for (const f of d.findings) expect(/\d/.test(f.text), `${c.short}:${f.key}`).toBe(true);
      const ranks = d.findings.map((f) => order[f.severity]);
      expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
      expect(d.method_version).toBe("diagnose/v3");
    }
  });
});
