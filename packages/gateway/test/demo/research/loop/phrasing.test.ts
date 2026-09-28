/** 2026-09-23 晚:研究 loop 把「创建多空策略…日线 trigger 15 分钟进出场…可以高频率交易…只要2026年」判成形态频率统计的回归。 */
import { afterEach, describe, expect, it } from "vitest";
import type { StrategyIR } from "@trade-gate/contracts";
import { openStateDb } from "../../../../src/state-db.js";
import { LoopStore, DEFAULT_BUDGET } from "../../../../src/demo/research/loop/store.js";
import { Budget } from "../../../../src/demo/research/loop/budget.js";
import { createToolRegistry, type ToolContext } from "../../../../src/demo/research/loop/tools.js";
import { detectMode, defaultParams } from "../../../../src/demo/research/loop/modes.js";
import { resolveConcepts } from "../../../../src/demo/research/loop/concepts.js";
import { fallbackPlan, normalizePlan, validatePlan, inferTimeframe } from "../../../../src/demo/research/loop/planner.js";
import { maMention, multiTimeframe, multiTimeframeHint, parseWindowPhrase, stripTradeFrequency } from "../../../../src/demo/research/loop/phrasing.js";
import { applyOrderPhrases, checkIR, compileStrategy, node } from "../../../../src/demo/research/strategy.js";
import { ResearchStore } from "../../../../src/demo/research/store.js";
import { ResearchService } from "../../../../src/demo/research/service.js";
import { BacktestBridge, PERP_RUN_PREFIX } from "../../../../src/demo/research/loop/backtest.js";
import { policyToIR } from "../../../../src/demo/research/strategy.js";
import { fixture, params } from "../fixtures.js";
import { draft, fakeMarket, instrument } from "./fixtures.js";

const clean: (() => void)[] = [];
afterEach(() => clean.splice(0).forEach((f) => f()));

const NOW = Date.UTC(2026, 8, 23, 12);
const Q =
  "创建一个BTC的MA 60主导的多空策略，同时参考4小时级别的MACD顶背离/底背离，怎么进场怎么放策略由你主导，在日线级别trigger 在15分钟级别进出场，可以高频率交易，回测周期只要2026年";
const none = { instrument_refs: [] as string[] };
const mode = (q: string) => detectMode(q, none, resolveConcepts(q)).mode;

describe("模式判定:造策略/回测优先,交易频率不是信号频率", () => {
  it("原话回归:走 validate(编译 + 回测),永续、15m、只回测 2026 年", () => {
    const d = detectMode(Q, none, resolveConcepts(Q));
    expect(d).toMatchObject({ mode: "validate_single", task_kind: "validate" });
    const p = fallbackPlan(Q, undefined, NOW);
    const tools = p.plan.map((s) => s.tool);
    expect(tools).toContain("compile_strategy");
    expect(tools).toContain("run_backtest");
    expect(tools).not.toContain("analyze_pattern_frequency");
    expect(() => validatePlan(p, createToolRegistry())).not.toThrow();
    expect(p.instruments).toEqual(["okx:perp:BTC-USDT-SWAP"]);
    expect(p.timeframe).toBe("15m");
    expect(p.window).toEqual({ from_ms: Date.UTC(2026, 0, 1), to_ms: NOW });
    // 窗口一路透传:取数、回测步都用同一个 2026 年窗口,没有被拉长到全历史
    for (const s of p.plan) if ("window" in s.args) expect(s.args.window).toEqual(p.window);
    expect(p.plan.find((s) => s.tool === "run_backtest")!.args).toMatchObject({ timeframe: "15m", window: p.window });
  });

  it("正例:造策略/回测/进出场的问题都走验证", () => {
    for (const q of [
      "写一个 ETH 4小时 MACD 底背离策略,可以高频交易,回测一下",
      "BTC 15分钟均线金叉进场、死叉出场,交易频率高一点也没关系",
      "做一个 BTC 日线 MACD 底背离策略,看看信号出现频率和回测表现",
      "帮我设计一个 SOL 1h 布林下轨反弹策略,允许频繁交易",
    ])
      expect(["validate_single", "validate_multi"], q).toContain(mode(q));
  });

  it("反例:真正在问信号多久出现一次/出现频率的,仍走 pattern_frequency", () => {
    for (const q of [
      "BTC 日线金叉多久出现一次，随后 10 根表现如何",
      "ETH 4小时 MACD 底背离的出现频率是多少",
      "BTC 日线看涨吞没形态出现后,随后 5 根 K 线的收益分布是什么样?",
      "SOL 日线金叉一年出现几次",
    ])
      expect(mode(q), q).toBe("pattern_frequency");
  });

  it("交易节奏说法被剥掉,信号频率说法保留", () => {
    expect(stripTradeFrequency("可以高频率交易")).not.toMatch(/频率/);
    expect(stripTradeFrequency("交易频率高一点")).not.toMatch(/频率/);
    expect(stripTradeFrequency("底背离的出现频率")).toMatch(/频率/);
  });
});

describe("显式区间解析(纯函数)", () => {
  const Y = (y: number, m = 1, d = 1) => Date.UTC(y, m - 1, d);
  const w = (q: string) => {
    const r = parseWindowPhrase(q, NOW);
    return r && { from_ms: r.from_ms, to_ms: r.to_ms };
  };
  it("年份、年份区间、以来、年月到现在、最近 N 个月", () => {
    expect(w("回测周期只要2026年")).toEqual({ from_ms: Y(2026), to_ms: NOW });
    expect(w("用 2025年 的数据")).toEqual({ from_ms: Y(2025), to_ms: Y(2026) - 1 });
    expect(w("回测 2024-2025")).toEqual({ from_ms: Y(2024), to_ms: Y(2026) - 1 });
    expect(w("2024到2025年")).toEqual({ from_ms: Y(2024), to_ms: Y(2026) - 1 });
    expect(w("2026年以来")).toEqual({ from_ms: Y(2026), to_ms: NOW });
    expect(w("从2025年开始回测")).toEqual({ from_ms: Y(2025), to_ms: NOW });
    expect(w("从2026-03到现在")).toEqual({ from_ms: Y(2026, 3), to_ms: NOW });
    expect(w("2026年3月以来")).toEqual({ from_ms: Y(2026, 3), to_ms: NOW });
    expect(w("2025年3月到2025年6月")).toEqual({ from_ms: Y(2025, 3), to_ms: Y(2025, 7) - 1 });
    expect(w("只看2026年3月")).toEqual({ from_ms: Y(2026, 3), to_ms: Y(2026, 4) - 1 });
    expect(w("最近3个月")).toEqual({ from_ms: Date.UTC(2026, 5, 23, 12), to_ms: NOW });
    expect(w("近半年")).toEqual({ from_ms: Date.UTC(2026, 2, 23, 12), to_ms: NOW });
    expect(w("最近一年")).toEqual({ from_ms: Date.UTC(2025, 8, 23, 12), to_ms: NOW });
    expect(w("过去两年")).toEqual({ from_ms: Date.UTC(2024, 8, 23, 12), to_ms: NOW });
  });
  it("不是区间的数字不误判;未来年份返回 null", () => {
    for (const q of ["BTC 日线 20/50 均线交叉", "至少 2400 根 K 线", "BTC 日线策略最近 90 天回测", "BTC 杠杆", "最近的高点", "2030年"])
      expect(w(q), q).toBeNull();
  });
  it("用户给了区间就不拉长;没给时照旧拉长", () => {
    const short = fallbackPlan("BTC 日线均线交叉策略回测,最近3个月", undefined, NOW);
    expect(short.window).toEqual({ from_ms: Date.UTC(2026, 5, 23, 12), to_ms: NOW });
    const long = fallbackPlan("BTC 日线均线交叉策略回测", undefined, NOW);
    expect((long.window.to_ms - long.window.from_ms) / 86400000).toBeGreaterThan(2000);
    // 模型给的窗口也被原话区间纠正
    const fixed = normalizePlan(long, "BTC 日线均线交叉策略回测 2024-2025", NOW);
    expect(fixed.window).toEqual({ from_ms: Date.UTC(2024, 0, 1), to_ms: Date.UTC(2026, 0, 1) - 1 });
    expect(fixed.plan.every((s) => !("window" in s.args) || (s.args.window as { from_ms: number }).from_ms === Date.UTC(2024, 0, 1))).toBe(true);
    // 显式区间也优先于上一轮沿用的窗口
    const q = "BTC 日线均线交叉策略回测 2025年", r = resolveConcepts(q), d = detectMode(q, none, r);
    const p = defaultParams(q, { instrument_refs: [], selected_window: { from_ms: 1, to_ms: 2 } }, NOW, d, r, "1d");
    expect(p.window).toEqual({ from_ms: Date.UTC(2025, 0, 1), to_ms: Date.UTC(2026, 0, 1) - 1 });
  });
});

describe("多周期:X 级别 trigger / Y 级别进出场", () => {
  it("执行周期取较小周期,方向门取 trigger 周期,其余周期记为近似", () => {
    expect(multiTimeframe(Q)).toEqual({ base: "15m", direction: "1d", others: ["4h"] });
    expect(inferTimeframe(Q)).toBe("15m");
    expect(multiTimeframe("日线定方向,1h 入场")).toEqual({ base: "1h", direction: "1d", others: [] });
    expect(inferTimeframe("4小时趋势过滤,在15分钟上执行")).toBe("15m");
    // 单周期与没有执行说法的多周期说法保持旧优先级
    expect(inferTimeframe("BTC 日线 20/50 均线交叉")).toBe("1d");
    expect(inferTimeframe("4小时级别突破,日线过滤")).toBe("1d");
    expect(multiTimeframe("15分钟")).toBeNull();
  });
  it("编译提示写进 compile 文本:MA60 → htf_ma_state 日线上下、4h 背离 → macd_divergence{htf},且不触发订单原话规则", () => {
    const hint = multiTimeframeHint(Q)!;
    expect(hint).toContain('regime=htf_ma_state{htf:"1d",period:60,ma:"sma",side:"above"}');
    expect(hint).toContain('order.short_regime=htf_ma_state{htf:"1d",period:60,ma:"sma",side:"below"}');
    expect(hint).toContain('signal:[macd_divergence{htf:"4h"}]');
    expect(hint).toContain('order.short_signal:[macd_divergence{htf:"4h",direction:"bearish"}]');
    // 新原语覆盖的部分不再有「均线周期缩到 51 / 参数 × 16」近似;只有没有高周期参数的其他指标仍按倍数近似
    expect(hint).not.toContain("ema_slow 最多");
    expect(hint.split("\n").find((l) => l.includes("MACD 背离"))).not.toMatch(/乘以/);
    expect(hint).toMatch(/其余指标原语没有高周期参数.*乘以 16/);
    const p = fallbackPlan(Q, undefined, NOW);
    expect(String(p.plan.find((s) => s.tool === "compile_strategy")!.args.text)).toContain(hint);
    // 提示本身不含任何订单说法:单独过原话规则什么都不改
    for (const h of [multiTimeframeHint("日线定方向,15分钟进场")!, hint]) {
      const ir: Record<string, unknown> = {};
      expect(applyOrderPhrases(h, ir)).toEqual([]);
      expect(ir.order).toBeUndefined();
    }
    // 没给均线:htf_ma_state 占位 + trend_state 兜底(后者仍受预热上限)
    expect(multiTimeframeHint("日线定方向,15分钟进场")).toMatch(/htf_ma_state\{htf:"1d",period:N.*trend_state\{htf:"1d"\}.*ema_slow 受预热上限约束最多 51/);
    expect(multiTimeframeHint("BTC 日线均线交叉")).toBeNull();
    expect(maMention("MA 60主导")).toEqual({ ma: "sma", period: 60, phrase: "MA 60" });
    expect(maMention("站上EMA21")).toMatchObject({ ma: "ema", period: 21 });
    expect(maMention("60日均线之上")).toMatchObject({ ma: "sma", period: 60 });
    expect(maMention("MACD 背离")).toBeNull();
  });
  it("新原语精确表达 base=15m + 日线 SMA60 上下定方向 + 4h 背离多空;trend_state 的日线 EMA60 仍超预热上限", () => {
    const div = { fast: 12, slow: 26, signal: 9, swing_length: 3, lookback: 60, source: "histogram" };
    const ir: StrategyIR = {
      version: 1, label: "t", description: "t",
      signal: [node("macd_divergence", { ...div, htf: "4h" })],
      entry: node("next_open_market", {}),
      risk: { stop: node("pivot_stop", { swing_length: 3 }), sizing: node("equal_notional", { max_allocation: "1" }) },
      exit: [node("chandelier_trail", { atr_period: 22, multiple: 3 })],
      regime: node("htf_ma_state", { htf: "1d", period: 60, ma: "sma", side: "above" }),
      order: { direction: "both", market: "perp", leverage: 1, short_signal: [node("macd_divergence", { ...div, htf: "4h", direction: "bearish" })], short_regime: node("htf_ma_state", { htf: "1d", period: 60, ma: "sma", side: "below" }) },
    };
    const ok = checkIR(ir, "15m");
    expect(ok.ok, JSON.stringify(ok.checks)).toBe(true);
    const { order: _o, ...noOrder } = ir;
    const trend = (slow: number): StrategyIR => ({ ...noOrder, signal: [node("macd_divergence", div)], regime: node("trend_state", { adx_period: 14, adx_min: 20, ema_fast: 20, ema_slow: slow, htf: "1d" }) });
    expect(checkIR(trend(51), "15m").ok).toBe(true);
    const over = checkIR(trend(60), "15m");
    expect(over.ok).toBe(false);
    expect(over.checks.find((c) => c.name === "warmup")!.ok).toBe(false);
  });
});

describe("多空 → 永续", () => {
  it("「多空/双向/long short」→ direction=both、market=perp;「多空力量」与没说做空的不动", () => {
    for (const t of ["BTC 多空策略", "ETH 双向交易", "BTC long/short strategy"]) {
      const ir: Record<string, any> = {};
      applyOrderPhrases(t, ir);
      expect(ir.order, t).toMatchObject({ direction: "both", market: "perp" });
      expect(ir.order.leverage, t).toBeUndefined(); // 缺省 1 倍
    }
    const elder: Record<string, any> = {};
    expect(applyOrderPhrases("BTC 艾达多空力量指标策略", elder)).toEqual([]);
    const plain: Record<string, any> = {};
    expect(applyOrderPhrases("BTC 日线均线金叉做多", plain)).toEqual([]);
  });
  it("回测资产:原话多空 → 永续;没说 → 现货", () => {
    const params = (q: string) => { const r = resolveConcepts(q), d = detectMode(q, none, r); return defaultParams(q, none, NOW, d, r, inferTimeframe(q)); };
    expect(params("BTC 日线均线多空策略回测").instruments).toEqual(["okx:perp:BTC-USDT-SWAP"]);
    expect(params("BTC 日线均线金叉策略回测").instruments).toEqual(["okx:spot:BTC-USDT"]);
  });
  it("compileStrategy:模型给了做空条件时编成永续双向;漏了做空条件时把原因回喂模型", async () => {
    const base = { version: 1, label: "t", description: "持有数天,每 1000 根约数十个信号", signal: [node("ema_cross", { fast: 20, slow: 50 })], entry: node("next_open_market", {}), risk: { stop: node("pivot_stop", { swing_length: 3 }), sizing: node("equal_notional", { max_allocation: "1" }) }, exit: [node("chandelier_trail", { atr_period: 22, multiple: 3 })] };
    const calls: string[] = [];
    const brain = (ir: unknown) => ({ name: "stub", complete: async (_s: string, user: string) => { calls.push(user); return { text: JSON.stringify({ ir, unmapped: [] }), latency_ms: 0, model: "stub", input_tokens: 0, output_tokens: 0 }; } });
    const ok = await compileStrategy({ text: "BTC 1h 均线多空策略", timeframe: "1h" }, brain({ ...base, order: { direction: "both", market: "spot", short_signal: [node("indicator_cross", { indicator: "ema", args: { period: 20 }, compare_to: "indicator", compare_indicator: "ema", compare_args: { period: 50 }, direction: "cross_below" })] } }));
    expect(ok.ok).toBe(true);
    expect(ok.ir!.order).toMatchObject({ direction: "both", market: "perp" });
    calls.length = 0;
    const missing = await compileStrategy({ text: "BTC 1h 均线多空策略", timeframe: "1h" }, brain(base));
    expect(missing.ok).toBe(false);
    expect(calls.length).toBe(3);
    expect(calls[1]).toMatch(/short_signal/);
  });
});

describe("区间太短切不出三段", () => {
  it("BacktestBridge 不再判 DATA_MISSING:跳过开发段 run,只跑全窗口报告", { timeout: 60000 }, async () => {
    const db = openStateDb(":memory:");
    clean.push(() => db.close());
    const store = new LoopStore(db.db, () => NOW), q = store.createInquiry(store.createSession().id, "BTC 策略回测 最近3个月", "short").inquiry;
    const old = new ResearchStore(db.db), bridge = new BacktestBridge(old, new ResearchService(old));
    const market = fakeMarket(), bars = fixture().bars.slice(0, 30);
    const window = { from_ms: bars[0]!.open_time, to_ms: bars.at(-1)!.close_time };
    const btc = instrument("BTC", "spot");
    const snapshot = store.putSnapshot({ ...draft("price", btc, window), rows: bars.map((b) => ({ ...b, ts: b.close_time })), actual_window: window, as_of: window.to_ms, checksum: "short" } as never);
    const notes: string[] = [];
    const ctx: ToolContext = { inquiry_id: q.id, step_id: q.id + ":backtest", signal: new AbortController().signal, store, budget: new Budget(DEFAULT_BUDGET, () => NOW), now: () => NOW, market, progress: (x: any) => { if (x.note) notes.push(x.note); } } as ToolContext;
    const r = await bridge.run({ instrument: btc, timeframe: "1h", window, ir: policyToIR(params().policy!), price_snapshot: snapshot.id }, ctx);
    expect(r.status, JSON.stringify(r)).toBe("ok");
    expect((r.output as any).run_id).toBe(PERP_RUN_PREFIX + q.id + ":backtest");
    expect(notes.join("\n")).toMatch(/切不出开发\/验证\/保留三段/);
    expect(old.db.prepare("SELECT count(*) AS n FROM research_runs").get()).toEqual({ n: 0 });
    expect(bridge.comparison({ run_id: (r.output as any).run_id, arm: "a_rules" }).report).toBeTruthy();
  });
});
