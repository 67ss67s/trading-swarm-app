/**
 * 回测诊断(零模型,2026-09-23):从全窗口报告里拆「收益为什么是这个样子」,对标 Horizon 的诊断回答
 * (它靠「按退出类型的盈亏、资金闲置时间、逐资产贡献、止损距离」找出止损过紧、资金一半时间闲置)。
 * 只陈述报告里算得出的事实,每条带数值;不下因果结论,样本不足时明说只作观察。
 *
 * v2(同日,复盘 skill `skills/research-reflection`):补上 skill 里有、这里原先没有的检查——
 *  - 核数:报告总收益 vs 已平仓逐笔连乘,差额是否来自期末持仓盯市;持仓期间平均仓位(1% 风险仓位 → 敞口 0.3% 的伪对比);
 *  - 忠实度:IR 里用户没提到的追踪 / 止盈 / 止损(对照原问题关键词)及它们打出的笔数;限价挂在信号价不利一侧;
 *    扫描变体入场与离场均线参数不一致;
 *  - 比较对象:同敞口持有(持有收益 × 平均敞口,粗算);
 *  - 订单周期:被拦计划的原因分布、止损被成本下限放宽的比例、限价成交率;
 *  - 噪声:同一策略已回测的变体数(单一变体挑选提示)。
 * v3(2026-09-23 晚):每笔平均收益旁边给中位数与截尾均值(两端各截 10%,笔数 <10 不截尾),按退出方式的平均也带中位/截尾;
 *   均值 > 0 而中位数或截尾均值 ≤ 0 时单列一条「均值靠少数几笔撑起」(几何实验室 8/19 一簇行情撑起整个平均值的教训)。
 */
import type { BacktestAsset, BacktestReport, StrategyIR, StrategyPrimitive } from "@trading-swarm/contracts";
import { centerStats, centerText, tailDriven } from "../analyzer.js";

export interface DiagnosisFinding { key: string; severity: "high" | "medium" | "info"; text: string }
export interface Diagnosis { report_id: string; asset: string; findings: DiagnosisFinding[]; observation: string; rows: Record<string, unknown>[]; method_version: string }
/** 诊断的外部上下文:用户原问题(忠实度比对用;没有就跳过忠实度检查)与同一策略已回测的变体数 */
export interface DiagnoseContext { question?: string | null; variants?: number | null }

export const DIAGNOSE_VERSION = "diagnose/v3";
const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);
const share = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;
const REASON: Record<string, string> = { stop: "止损", sl: "止损", trail: "追踪止损", target: "止盈", tp: "止盈", time: "到期", indicator_cross_exit: "信号离场", trend_break: "趋势破位", signal_exit: "信号离场", rolled: "结转", end_of_data: "期末", liquidation: "强平", breakeven: "保本", flipped: "反手" };
const BLOCK: Record<string, string> = { min_rr: "盈亏比不足", no_stop: "无有效止损", stop_side: "止损在错误一侧", target_side: "止盈在错误一侧", gap_invalidated: "跳空失效", opposite_signal: "反向信号撤单" };

// 忠实度:用户原话里的离场说法。命中任一词就认为用户提到了这一类离场。
const SAID = {
  trail: /追踪|跟踪止损|移动止损|吊灯|trail|chandelier|保本/i,
  target: /止盈|目标价?|take.?profit|\btp\b|盈亏比|\brr\b|压力|阻力|流动性|前高|上轨/i,
  stop: /止损|stop|\bsl\b|破位|跌破|失效|风控/i,
};
const EXIT_OF = { trail: ["trail"], target: ["target", "tp"], stop: ["stop", "sl"] } as const;
const isTrail = (p: string) => /trail|chandelier/i.test(p);
const isTarget = (p: string) => /target|take_profit|liquidity_target/i.test(p);

function exitCount(a: BacktestAsset, reasons: readonly string[]): number {
  const by = a.trade_stats?.pnl_by_exit_reason ?? {}, raw = a.trade_stats?.exit_reasons ?? {};
  let n = 0;
  for (const r of reasons) n += by[r]?.count ?? raw[r] ?? 0;
  if (!n && !Object.keys(by).length && !Object.keys(raw).length) n = a.trades.filter((t) => reasons.includes(t.exit_reason)).length;
  return n;
}

/** 入场 / 离场的均线周期对(两条线交叉型才有);取不到返回 null */
function periodsOf(p: StrategyPrimitive | undefined): [number, number] | null {
  if (!p) return null;
  const x = p.params as Record<string, unknown>, num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);
  const arg = (k: string) => num((x[k] as Record<string, unknown> | undefined)?.["period"]);
  const pair = /(?:ema|sma|ma)_cross/.test(p.primitive) ? [num(x["fast"]), num(x["slow"])] : [arg("args"), arg("compare_args")];
  return pair[0] !== null && pair[1] !== null ? [pair[0]!, pair[1]!] : null;
}

function faithfulness(ir: StrategyIR, a: BacktestAsset, question: string, add: (k: string, s: DiagnosisFinding["severity"], t: string) => void) {
  const exits = (ir.exit ?? []).map((e) => e.primitive);
  const has = {
    trail: exits.some(isTrail),
    target: exits.some(isTarget) || !!ir.order?.take_profits?.length,
    stop: !!ir.risk?.stop && ir.risk.stop.primitive !== "no_stop",
  };
  const total = a.metrics?.trades ?? a.trades.length;
  const label = { trail: "追踪止损", target: "止盈", stop: "止损" } as const;
  const which = { trail: exits.filter(isTrail).join("、"), target: [...exits.filter(isTarget), ...(ir.order?.take_profits?.length ? ["order.take_profits"] : [])].join("、"), stop: ir.risk?.stop?.primitive ?? "" };
  for (const kind of ["trail", "target", "stop"] as const) {
    if (!has[kind] || SAID[kind].test(question)) continue;
    const n = exitCount(a, EXIT_OF[kind]), s = total ? n / total : 0;
    const severity = s >= 0.3 ? (kind === "stop" ? "medium" : "high") : n > 0 ? "medium" : "info";
    const tail = s < 0.3 ? "" : kind === "stop" ? ":这部分离场来自编译补上的规则,和用户原意比较时要单独算" : ":这份报告测的不完全是用户说的策略,归因前先按原话重编再回测";
    add(`faithful_${kind}`, severity, `问题里没有提到${label[kind]},编译出的规则却带了${label[kind]}(${which[kind]});${a.label} ${total} 笔平仓里 ${n} 笔(${share(s)})由它离场${tail}`);
  }
  // 扫描变体:入场均线参数改了,离场还是旧参数
  const sig = periodsOf(ir.signal?.[0]), ex = periodsOf((ir.exit ?? []).find((e) => /cross_exit|indicator_cross/.test(e.primitive)));
  if (sig && ex && (sig[0] !== ex[0] || sig[1] !== ex[1])) add("param_mismatch", "medium", `入场信号用 ${sig[0]}/${sig[1]},离场仍用 ${ex[0]}/${ex[1]}:入场与离场参数不一致,和其他参数组比较时差别不纯`);
}

function orderPlans(a: BacktestAsset, question: string, add: (k: string, s: DiagnosisFinding["severity"], t: string) => void) {
  const plans = a.plans ?? [];
  if (!plans.length) return;
  const n = plans.length, by = (s: string) => plans.filter((p) => p.status === s).length;
  const blocked = plans.filter((p) => p.status === "blocked"), cancelled = plans.filter((p) => p.status === "cancelled");
  const reasons = (list: typeof plans) => Object.entries(list.reduce<Record<string, number>>((m, p) => ((m[p.blocked_reason ?? "unknown"] = (m[p.blocked_reason ?? "unknown"] ?? 0) + 1), m), {})).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${BLOCK[k] ?? k} ${v}`).join("、");
  const b = blocked.length;
  add("blocked", b / n > 0.5 ? "high" : b / n > 0.2 ? "medium" : "info", `${a.label} 共 ${n} 个订单计划:成交 ${by("filled")}、未成交 ${by("no_fill")}、被替换 ${by("replaced")}、被拦 ${b}(${share(b / n)}${b ? ":" + reasons(blocked) : ""})、撤单 ${cancelled.length}${cancelled.length ? "(" + reasons(cancelled) + ")" : ""}${b / n > 0.5 ? ";过半信号在放置前就被拦,信号出现的位置与止损/目标的几何不匹配" : ""}`);
  // 止损被成本下限放宽
  const withStop = plans.filter((p) => p.stop), widened = withStop.filter((p) => (p.stop!.note ?? "").includes("cost_floor"));
  if (widened.length) {
    const filled = withStop.filter((p) => p.status === "filled"), wf = filled.filter((p) => (p.stop!.note ?? "").includes("cost_floor")).length;
    const floor = /放宽到\s*([\d.]+%)/.exec(widened[0]!.stop!.note ?? "")?.[1];
    const s = widened.length / withStop.length;
    add("stop_widened", s > 0.5 ? "high" : s > 0.2 ? "medium" : "info", `${a.label} ${withStop.length} 个带止损的计划里 ${widened.length} 个(${share(s)})的止损被放宽到成本下限${floor ? " " + floor : ""}${filled.length ? `,已成交的 ${filled.length} 个里 ${wf} 个` : ""}${s > 0.5 ? ":策略自己的止损在这个周期上多数不起作用" : ""}`);
  }
  // 限价挂在信号价不利一侧(做多挂在上方 = 追价)
  const limits = plans.filter((p) => p.entry_type === "limit" && p.entry_price !== null && Number.isFinite(p.reference_price));
  if (limits.length) {
    const wrong = limits.filter((p) => (p.entry_price! - p.reference_price) * (p.side === "short" ? -1 : 1) > 0).length, s = wrong / limits.length;
    if (s > 0.1) add("limit_wrong_side", s >= 0.5 ? "high" : "medium", `${a.label} ${limits.length} 个限价计划里 ${wrong} 个(${share(s)})挂在信号收盘价的不利一侧(做多挂在上方),下一根开盘就会按更优价成交,等于追价市价单${/回踩|回调|回撤|pullback|retest/i.test(question) ? ";问题里的「回踩」没有被表达出来" : ""}`);
    const st = a.plan_stats;
    if (st && st.fill_rate !== null && st.fill_rate !== undefined) add("fill", st.fill_rate < 0.3 ? "medium" : "info", `${a.label} 限价成交率 ${share(st.fill_rate)}(成交 ${st.filled}、到期未成交 ${st.no_fill})${st.fill_rate < 0.3 ? ":多数计划没成交,收益只来自少数成交,样本比计划数小得多" : ""}`);
  }
}

export function diagnoseReport(report: BacktestReport, ctx: DiagnoseContext = {}): Diagnosis {
  const a = report.assets.find((x) => x.key === report.primary_key) ?? report.assets[0]!;
  const m = a.metrics, findings: DiagnosisFinding[] = [];
  const add = (key: string, severity: DiagnosisFinding["severity"], text: string) => findings.push({ key, severity, text });
  if (!m) return { report_id: report.id, asset: a.key, findings: [{ key: "no_metrics", severity: "high", text: `${a.label} 没有可诊断的回测结果(${a.error ?? a.status})` }], observation: "", rows: [], method_version: DIAGNOSE_VERSION };
  const question = (ctx.question ?? "").trim();
  const usage = a.capital_usage, inMarket = usage?.time_in_market ?? m.time_in_market ?? null, exposure = usage?.avg_exposure ?? m.exposure ?? null;
  // 0a. 仓位口径:持仓期间平均仓位 = 平均敞口 / 在场时间;远低于满仓时,和满仓持有的对比不成立
  const heldSize = inMarket && exposure !== null && inMarket > 0 ? exposure / inMarket : null;
  if (heldSize !== null && heldSize < 0.5 && a.trades.length) {
    add("sizing", "high", `持仓期间平均仓位只占权益的 ${share(heldSize, 1)}(平均敞口 ${share(exposure!, 1)},在场时间 ${share(inMarket!, 1)};仓位口径:${report.execution.sizing_mode.split("(")[0]}):总收益 ${pct(m.total_return)} 与满仓持有 ${pct(m.benchmark_return)} 不可比,先按满仓口径重跑或和同敞口持有比`);
  }
  // 0b. 核数:满仓口径下,已平仓逐笔 (1+收益) 连乘应≈ 总收益;差额看是不是期末持仓盯市
  if (a.kind === "single" && a.trades.length && (heldSize === null || heldSize >= 0.5)) {
    const prod = a.trades.reduce((s, t) => s * (1 + t.return_pct), 1) - 1;
    const gap = (1 + m.total_return) / (1 + prod) - 1;
    const open = (report.warnings ?? []).some((w) => w.includes(a.key) && w.includes("期末仍有持仓"));
    if (Math.abs(gap) <= 0.05) add("reconcile", "info", `核数:报告总收益 ${pct(m.total_return)},${a.trades.length} 笔已平仓逐笔连乘 ${pct(prod)},一致`);
    else if (open) add("reconcile", "medium", `核数:报告总收益 ${pct(m.total_return)},${a.trades.length} 笔已平仓逐笔连乘 ${pct(prod)};差额(按净值约 ${pct(gap)})来自期末未平仓的持仓按最后收盘价盯市,它不在已平仓统计里`);
    else add("reconcile", "high", `核数:报告总收益 ${pct(m.total_return)},${a.trades.length} 笔已平仓逐笔连乘 ${pct(prod)},按净值差约 ${pct(gap)},报告里没有说明原因:先查报告再做归因`);
  }
  // 0c. 忠实度(需要用户原话)
  if (question) faithfulness(report.strategy_ir, a, question, add);
  // 1. 敞口:持有一直 100% 在场,策略大部分时间空仓时,牛市里天然大幅落后;同敞口持有 = 持有 × 平均敞口(粗算)
  if (inMarket !== null && m.benchmark_return !== null) {
    const sameExp = exposure !== null ? m.benchmark_return * exposure : null;
    const behind = sameExp !== null && m.total_return < sameExp;
    const idle = inMarket < 0.5 && m.benchmark_return > 0.5, sized = findings.some((f) => f.key === "sizing");
    add("exposure", idle && !sized ? "high" : behind || idle ? "medium" : "info", `在场时间 ${pct(inMarket, 0).replace("+", "")},空仓 ${pct(1 - inMarket, 0).replace("+", "")};同窗口持有始终满仓(${pct(m.benchmark_return)})${sameExp !== null ? `;按平均敞口 ${share(exposure!, 1)} 折算的同敞口持有(粗算)约 ${pct(sameExp)},策略 ${pct(m.total_return)},${behind ? "跑输" : "跑赢"}同敞口持有` : ""}。${idle ? (sized ? "仓位口径失真,先看仓位那条,再谈空仓时间。" : "单边上涨段里空仓时间是落后持有的首要来源。") : ""}`);
  }
  // 2. 退出方式盈亏:哪类出场在亏钱
  const byExit = a.trade_stats?.pnl_by_exit_reason ?? {};
  const exits = Object.entries(byExit).map(([reason, v]) => ({ reason, ...v })).sort((x, y) => x.pnl - y.pnl);
  if (exits.length) {
    // 平均旁边给中位 / 截尾:逐笔收益从 a.trades 按退出原因取(报告交易列表被截断、笔数对不上时只给平均)
    const robust = (reason: string, count: number) => { const g = a.trades.filter((t) => t.exit_reason === reason); if (g.length !== count) return ""; const c = centerStats(g.map((t) => t.return_pct)); return `(中位 ${pct(c.median)},截尾 ${pct(c.trimmed_mean)})`; };
    add("exit_mix", "info", "按退出方式:" + exits.map((e) => `${REASON[e.reason] ?? e.reason} ${e.count} 笔、合计 ${e.pnl >= 0 ? "+" : ""}${e.pnl.toFixed(0)}、平均 ${pct(e.avg_return)}${robust(e.reason, e.count)}`).join(";"));
    const stop = exits.find((e) => ["stop", "sl"].includes(e.reason)), total = exits.reduce((s, e) => s + e.count, 0);
    const withStop = (a.plans ?? []).filter((p) => p.stop), floored = withStop.length ? withStop.filter((p) => (p.stop!.note ?? "").includes("cost_floor")).length / withStop.length : 0;
    if (stop && total && stop.count / total > 0.4 && stop.pnl < 0) add("stop_tight", "high", `${((stop.count / total) * 100).toFixed(0)}% 的交易被止损打出、合计亏损 ${stop.pnl.toFixed(0)}:${floored > 0.5 ? "多数止损是被放宽后的成本下限而不是策略原来的止损,问题在止损来源与周期不匹配" : "止损可能过紧,或入场点离结构位太远"}`);
    const worst = exits[0]!;
    if (worst.pnl < 0 && !(stop && worst.reason === stop.reason)) add("worst_exit", "medium", `亏损主要来自「${REASON[worst.reason] ?? worst.reason}」出场(${worst.count} 笔,合计 ${worst.pnl.toFixed(0)})`);
  }
  // 2b. 每笔收益的稳健中心:平均 / 中位数 / 截尾均值(两端各截 10%)
  if (a.trades.length) {
    const c = centerStats(a.trades.map((t) => t.return_pct)), tail = tailDriven(c);
    const cut = a.trades.length < m.trades ? `(按报告里保留的 ${a.trades.length}/${m.trades} 笔算)` : "";
    add("trade_center", tail ? "medium" : "info", `每笔收益:${centerText(c, (v) => pct(v, 2))}${cut}${tail === "up" ? ":平均为正但中位数或截尾均值不为正,平均值靠少数几笔大赚撑起,去掉两端后没有边" : tail === "down" ? ":平均为负但中位数与截尾均值都为正,亏损集中在少数几笔大亏" : ""}`);
  }
  // 3. 收益集中度:少数几笔撑起全部利润
  const pnls = a.trades.map((t) => t.pnl).sort((x, y) => y - x), gross = pnls.filter((p) => p > 0).reduce((s, p) => s + p, 0);
  if (pnls.length >= 5 && gross > 0) {
    const top = pnls.slice(0, Math.max(1, Math.ceil(pnls.length * 0.2))).filter((p) => p > 0).reduce((s, p) => s + p, 0), net = pnls.reduce((s, p) => s + p, 0);
    add("concentration", top > Math.abs(net) && net > 0 ? "medium" : "info", `前 20% 的交易贡献盈利 ${top.toFixed(0)},全部交易净 ${net.toFixed(0)}${top > net && net > 0 ? ":利润集中在少数几笔,其余交易整体在亏" : ""}`);
  }
  // 4. 样本内外
  const isM = a.segments.find((s) => s.name === "in_sample")?.metrics, oosM = a.segments.find((s) => s.name === "out_of_sample")?.metrics;
  if (isM && oosM) add("decay", (isM.total_return > 0 && oosM.total_return < 0) ? "high" : "info", `样本内 ${pct(isM.total_return)}(持有 ${pct(isM.benchmark_return)}),样本外 ${pct(oosM.total_return)}(持有 ${pct(oosM.benchmark_return)})${isM.total_return > 0 && oosM.total_return < 0 ? ":样本外转负,规则可能只适配前段行情" : ""}`);
  // 5. 成本拖累
  if (m.fees > 0 && m.net_pnl !== 0) add("fees", Math.abs(m.fees / (m.net_pnl + m.fees)) > 0.3 ? "medium" : "info", `手续费+滑点合计 ${m.fees.toFixed(0)},约占毛盈亏的 ${(Math.abs(m.fees / (m.net_pnl + m.fees)) * 100).toFixed(0)}%(${m.trades} 笔)`);
  // 6. 订单周期:被拦原因、止损放宽、限价挂错边、成交率
  orderPlans(a, question, add);
  // 7. 资产差异
  const singles = report.assets.filter((x) => x.kind === "single" && x.metrics);
  if (singles.length >= 2) add("assets", "info", "分资产:" + singles.map((x) => `${x.label} ${pct(x.metrics!.total_return)}(持有 ${pct(x.metrics!.benchmark_return)},${x.metrics!.trades} 笔)`).join(";"));
  // 8. 样本量与试验次数
  if (m.trades < 30) add("sample", "medium", `只有 ${m.trades} 笔平仓,低于 30 笔纪律线,以上都只作观察`);
  if (ctx.variants && ctx.variants >= 2) add("variants", "medium", `同一策略已回测 ${ctx.variants} 个变体,这份是其中之一:若从 ${ctx.variants} 个里挑表现最好的采用,优势要按试验次数打折;报告里没有随机入场基线,也没有做试验次数折算`);
  const order = { high: 0, medium: 1, info: 2 };
  findings.sort((x, y) => order[x.severity] - order[y.severity]);
  return {
    report_id: report.id, asset: a.key, findings,
    observation: `诊断(${a.label},${report.timeframe},全窗口):\n` + findings.map((f, i) => `${i + 1}. ${f.text}`).join("\n"),
    rows: findings.map((f) => ({ key: f.key, severity: f.severity, finding: f.text })),
    method_version: DIAGNOSE_VERSION,
  };
}
