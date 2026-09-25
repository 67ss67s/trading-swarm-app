/**
 * 研究图表模板(2026-09-23):从全窗口回测报告**确定性**生成 Horizon 式研究图表(权益曲线对比、回撤对比、
 * 按退出类型/按资产的盈亏柱、逐笔盈亏散点、月度收益热力图、多策略横比)。
 *
 * 为什么由代码出图:Horizon 是 agent 在沙箱里写 Plotly;我们的模型写画图代码不稳定,所以图的数据与版式全部由这里
 * 从报告算出,模型只负责「挑哪几张、按什么顺序、写一句不带数字的说明」。每张图都带 report_id 溯源。
 *
 * 口径:
 * - 金额统一换算到 $10k 本金(BASE_CAPITAL):权益 = 10k × (1 + pnl_pct),持有 = 10k × (1 + benchmark_pct);
 *   逐笔/按类型/按资产的盈亏 = 报价币盈亏 × 10k / initial_cash(initial_cash 本就是 1 万时等于原值)。
 * - 百分数(y_unit=%)存的是已乘 100 的数,前端直接加 % 号。
 * - 缺失值保留 null(前端断线),不补零。
 */
import type {
  BacktestAsset,
  BacktestReport,
  BacktestTrade,
  LoopChart,
  LoopChartAnnotation,
  LoopChartSeries,
  LoopChartTemplate,
  LoopSpec,
} from "@trading-swarm/contracts";

export const CHART_VERSION = "research-chart/v1" as const;
export const BASE_CAPITAL = 10000;
/** 单条折线最多保留的点数(报告 equity 最多 5000 点;图上 1200 点已经超过像素宽度) */
const MAX_LINE_POINTS = 1200;
const MAX_SCATTER_POINTS = 3000;
/** 一次回答最多引用几张图 */
export const MAX_ANSWER_CHARTS = 4;

export interface ChartDraft {
  template: LoopChartTemplate;
  title: string;
  spec: LoopSpec;
  content: LoopChart;
}

/** 退出原因 → 中文(与 diagnose.ts 同口径,多几个引擎常见值) */
const EXIT_LABEL: Record<string, string> = {
  stop: "止损", sl: "止损", stop_loss: "止损", trail: "追踪止损", trailing_stop: "追踪止损", target: "止盈", tp: "止盈", take_profit: "止盈",
  time: "到期", time_exit: "到期", indicator_cross_exit: "信号离场", trend_break: "趋势破位", signal_exit: "信号离场", signal: "信号离场",
  rolled: "结转", end_of_data: "期末平仓", liquidation: "强平", reverse: "反手",
};
export const exitLabel = (reason: string) => EXIT_LABEL[reason] ?? reason;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
/** $ 缩写:10000 → $10k,9974.38 → $9.97k,1234567 → $1.23M */
export function money(v: number): string {
  const a = Math.abs(v), sign = v < 0 ? "-" : "";
  if (a >= 1e6) return `${sign}$${round(a / 1e6, 2)}M`;
  if (a >= 1e3) return `${sign}$${round(a / 1e3, 2)}k`;
  return `${sign}$${round(a, 0)}`;
}
const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);
const shortLabel = (s: string, n = 36) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
/** 横比图例:去掉各策略标题的公共前缀(参数扫描的标题都是「基准名 · 参数 10/30」),只留区分部分 */
export function distinctLabels(titles: string[]): string[] {
  if (titles.length < 2) return titles.map((t) => shortLabel(t, 30));
  let p = titles[0]!;
  for (const t of titles) while (p && !t.startsWith(p)) p = p.slice(0, -1);
  if (p.length < 4) return titles.map((t) => shortLabel(t, 30));
  return titles.map((t) => shortLabel(t.slice(p.length).replace(/^[\s·:：,,、-]+/, "").trim() || "基准", 30));
}

/** 主资产:primary_key 对应且有结果的那条;没有就取第一条有结果的 */
export function primaryAsset(report: BacktestReport): BacktestAsset | null {
  const ok = (a: BacktestAsset | undefined) => !!a && a.status === "completed" && !!a.metrics;
  const p = report.assets.find((a) => a.key === report.primary_key);
  return ok(p) ? p! : (report.assets.find(ok) ?? null);
}
const scaleOf = (report: BacktestReport) => {
  const cash = Number(report.execution?.initial_cash);
  return Number.isFinite(cash) && cash > 0 ? BASE_CAPITAL / cash : 1;
};

/** 等距抽稀,首尾必留;时间点落在分界线附近的也留下,避免分界处断一截 */
function thin<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs;
  const step = (xs.length - 1) / (max - 1), out: T[] = [];
  for (let i = 0; i < max; i++) out.push(xs[Math.round(i * step)]!);
  return out;
}

function splitLine(report: BacktestReport): LoopChartAnnotation[] {
  const oos = report.segments.find((s) => s.name === "out_of_sample");
  return oos ? [{ type: "vline", x: oos.from_ms, label: "样本外 →", role: "split" }] : [];
}

function spec(template: LoopChartTemplate, c: LoopChart, fields: { x: string; series: { field: string; label: string; mode: LoopChartSeries["mode"]; role: LoopChartSeries["role"]; text_field?: string }[] }): LoopSpec {
  return {
    type: c.type === "heatmap" ? "heatmap" : c.type,
    x: fields.x,
    y: fields.series.map((s) => s.field),
    series: fields.series.map((s) => ({ field: s.field, label: s.label, mode: s.mode, role: s.role, ...(s.text_field ? { text_field: s.text_field } : {}) })),
    y_unit: c.y_unit,
    x_title: c.x_title,
    y_title: c.y_title,
    template,
    ...(c.report_id ? { report_id: c.report_id } : {}),
    ...(c.report_ids ? { report_ids: c.report_ids } : {}),
    annotations: c.annotations,
  };
}

function draft(template: LoopChartTemplate, content: Omit<LoopChart, "kind" | "version" | "template">, x: string, textField?: string): ChartDraft {
  const c: LoopChart = { kind: "chart", version: CHART_VERSION, template, ...content };
  return {
    template,
    title: c.title,
    content: c,
    spec: spec(template, c, { x, series: c.series.map((s, i) => ({ field: `s${i}`, label: s.name, mode: s.mode, role: s.role, ...(textField && s.labels ? { text_field: textField } : {}) })) }),
  };
}

// ---------------------------------------------------------------------------
// 单份报告的五类图

/** 权益曲线对比:策略 vs 同窗口持有,$10k 起;多资产时叠加其余资产的策略曲线;样本内/外分界竖线 */
export function equityComparison(report: BacktestReport): ChartDraft | null {
  const p = primaryAsset(report);
  if (!p || p.equity.length < 2) return null;
  const pts = thin(p.equity, MAX_LINE_POINTS);
  const series: LoopChartSeries[] = [];
  const hasBench = pts.some((e) => e.benchmark_pct !== null);
  if (hasBench) series.push({ name: `持有 ${p.label} ($10k)`, mode: "line", role: "benchmark", points: pts.map((e) => [e.at, e.benchmark_pct === null ? null : round(BASE_CAPITAL * (1 + e.benchmark_pct))]) });
  series.push({ name: `${shortLabel(report.title, 28)} · ${p.label} ($10k)`, mode: "line+markers", role: "strategy", points: pts.map((e) => [e.at, round(BASE_CAPITAL * (1 + e.pnl_pct))]) });
  // 多资产报告(BTC / ETH / BTC+ETH):其余资产的策略曲线也叠上,同样 $10k 起
  for (const a of report.assets.filter((x) => x.key !== p.key && x.status === "completed" && x.equity.length >= 2).slice(0, 2))
    series.push({ name: `策略 · ${a.label} ($10k)`, mode: "line", role: a.kind === "basket" ? "basket" : "asset", points: thin(a.equity, MAX_LINE_POINTS).map((e) => [e.at, round(BASE_CAPITAL * (1 + e.pnl_pct))]) });
  const last = p.equity.at(-1)!;
  const caption = `$10k 起步(${p.label},${report.timeframe},${day(p.equity[0]!.at)} → ${day(last.at)}):策略期末 ${money(BASE_CAPITAL * (1 + last.pnl_pct))}` +
    (last.benchmark_pct !== null ? `,同窗口一直持有 ${money(BASE_CAPITAL * (1 + last.benchmark_pct))}` : "") + (report.segments.some((s) => s.name === "out_of_sample") ? ";虚线右侧为样本外" : "");
  return draft("equity_comparison", {
    title: "权益曲线对比", type: "line", x: "time", x_title: "日期", y_title: "权益 ($)", y_unit: "$",
    series, annotations: splitLine(report), caption, report_id: report.id, asset: p.key, base_capital: BASE_CAPITAL,
    note: "同一窗口、同一费率滑点;持有 = 首个可成交开盘买入后一直拿着。",
  }, "at");
}

/** 持有的回撤从 benchmark_pct 现算(报告只存了策略自己的 drawdown) */
function benchDrawdown(points: { benchmark_pct: number | null }[]): (number | null)[] {
  let peak = -Infinity;
  return points.map((e) => {
    if (e.benchmark_pct === null) return null;
    const v = 1 + e.benchmark_pct;
    peak = Math.max(peak, v);
    return peak > 0 ? round((v / peak - 1) * 100) : 0;
  });
}

/** 回撤对比(%,负数向下):策略 vs 持有 */
export function drawdownComparison(report: BacktestReport): ChartDraft | null {
  const p = primaryAsset(report);
  if (!p || p.equity.length < 2) return null;
  const full = benchDrawdown(p.equity);
  const idx = thin(p.equity.map((_, i) => i), MAX_LINE_POINTS);
  const series: LoopChartSeries[] = [];
  if (full.some((v) => v !== null)) series.push({ name: `持有 ${p.label}`, mode: "line", role: "benchmark", points: idx.map((i) => [p.equity[i]!.at, full[i]!]) });
  series.push({ name: `${shortLabel(report.title, 28)} · ${p.label}`, mode: "line", role: "strategy", points: idx.map((i) => [p.equity[i]!.at, round(-Math.abs(p.equity[i]!.drawdown) * 100)]) });
  const worstBench = Math.min(...full.filter((v): v is number => v !== null), 0);
  const caption = `最大回撤:策略 ${(Math.abs(p.metrics!.max_drawdown) * 100).toFixed(1)}%` + (full.some((v) => v !== null) ? `,同窗口持有 ${Math.abs(worstBench).toFixed(1)}%` : "");
  return draft("drawdown_comparison", {
    title: "回撤对比", type: "line", x: "time", x_title: "日期", y_title: "回撤 (%)", y_unit: "%",
    series, annotations: [...splitLine(report), { type: "hline", y: 0 }], caption, report_id: report.id, asset: p.key,
  }, "at");
}

/** 逐笔 → 按退出原因汇总(报告没带 pnl_by_exit_reason 时的兜底) */
function byExit(p: BacktestAsset): { reason: string; count: number; pnl: number }[] {
  const pre = p.trade_stats?.pnl_by_exit_reason;
  if (pre && Object.keys(pre).length) return Object.entries(pre).map(([reason, v]) => ({ reason, count: v.count, pnl: v.pnl }));
  const m = new Map<string, { count: number; pnl: number }>();
  for (const t of p.trades) { const x = m.get(t.exit_reason) ?? { count: 0, pnl: 0 }; x.count++; x.pnl += t.pnl; m.set(t.exit_reason, x); }
  return [...m.entries()].map(([reason, v]) => ({ reason, ...v }));
}

/** 按退出类型的盈亏柱,柱顶标笔数 */
export function exitReasonPnl(report: BacktestReport): ChartDraft | null {
  const p = primaryAsset(report);
  if (!p) return null;
  const rows = byExit(p).filter((r) => r.count > 0).sort((a, b) => b.pnl - a.pnl);
  if (!rows.length) return null;
  const k = scaleOf(report);
  const worst = rows.at(-1)!, best = rows[0]!;
  const caption = `按退出方式(${p.label},共 ${rows.reduce((s, r) => s + r.count, 0)} 笔):` +
    `${exitLabel(best.reason)} ${best.count} 笔合计 ${money(best.pnl * k)}` + (rows.length > 1 ? `,${exitLabel(worst.reason)} ${worst.count} 笔合计 ${money(worst.pnl * k)}` : "") + "(按 $10k 本金)";
  return draft("exit_reason_pnl", {
    title: "按退出类型的盈亏", type: "bar", x: "category", x_title: "退出类型", y_title: "盈亏 ($)", y_unit: "$",
    series: [{ name: "净盈亏 ($10k 本金)", mode: "bar", role: "neutral", points: rows.map((r) => [exitLabel(r.reason), round(r.pnl * k)]), labels: rows.map((r) => `${r.count} 笔`), point_roles: rows.map((r) => (r.pnl >= 0 ? "positive" : "negative")) }],
    annotations: [{ type: "hline", y: 0 }], caption, report_id: report.id, asset: p.key, base_capital: BASE_CAPITAL,
  }, "exit_reason", "count_label");
}

/** 按资产的盈亏柱(柱顶「28 笔」):篮子用 per_symbol 分腿;否则用报告里各单资产的结果(各自 $10k 本金) */
export function assetPnl(report: BacktestReport): ChartDraft | null {
  const p = primaryAsset(report);
  const legs = p?.per_symbol ?? [];
  let rows: { label: string; pnl: number; trades: number }[];
  let basis: string;
  if (legs.length >= 2) {
    rows = legs.map((l) => ({ label: l.symbol.replace(/-?USDT(-SWAP)?$/i, ""), pnl: l.contribution * BASE_CAPITAL, trades: l.trades }));
    basis = `${p!.label} 篮子各腿对 $10k 本金的贡献`;
  } else {
    rows = report.assets.filter((a) => a.status === "completed" && a.metrics).map((a) => ({ label: a.label, pnl: a.metrics!.total_return * BASE_CAPITAL, trades: a.metrics!.trades }));
    basis = "各资产各自用 $10k 本金跑同一策略";
  }
  if (rows.length < 2) return null;
  rows.sort((a, b) => b.pnl - a.pnl);
  const caption = `${basis}:` + rows.map((r) => `${r.label} ${money(r.pnl)}(${r.trades} 笔)`).join(",");
  return draft("asset_pnl", {
    title: "按资产的盈亏", type: "bar", x: "category", x_title: "资产", y_title: "盈亏 ($)", y_unit: "$",
    series: [{ name: "净盈亏 ($10k 本金)", mode: "bar", role: "neutral", points: rows.map((r) => [r.label, round(r.pnl)]), labels: rows.map((r) => `${r.trades}T`), point_roles: rows.map((r) => (r.pnl >= 0 ? "positive" : "negative")) }],
    annotations: [{ type: "hline", y: 0 }], caption, report_id: report.id, ...(p ? { asset: p.key } : {}), base_capital: BASE_CAPITAL,
  }, "asset", "count_label");
}

/** 逐笔盈亏散点(Trade # vs P&L,盈绿亏红);样本外第一笔处画竖线 */
export function tradeScatter(report: BacktestReport): ChartDraft | null {
  const p = primaryAsset(report);
  if (!p || !p.trades.length) return null;
  const k = scaleOf(report);
  const trades: (BacktestTrade & { n: number })[] = [...p.trades].sort((a, b) => a.exit_at - b.exit_at).map((t, i) => ({ ...t, n: i + 1 }));
  const shown = thin(trades, MAX_SCATTER_POINTS);
  const firstOos = trades.find((t) => t.segment === "out_of_sample");
  const wins = trades.filter((t) => t.pnl > 0).length;
  const caption = `${p.label} 共 ${trades.length} 笔:盈利 ${wins} 笔、亏损 ${trades.length - wins} 笔;最好 ${money(Math.max(...trades.map((t) => t.pnl)) * k)},最差 ${money(Math.min(...trades.map((t) => t.pnl)) * k)}(按 $10k 本金)`;
  return draft("trade_scatter", {
    title: "逐笔盈亏", type: "scatter", x: "linear", x_title: "交易序号", y_title: "盈亏 ($)", y_unit: "$",
    series: [{
      name: "单笔净盈亏", mode: "scatter", role: "neutral",
      points: shown.map((t) => [t.n, round(t.pnl * k)]),
      point_roles: shown.map((t) => (t.pnl >= 0 ? "positive" : "negative")),
      hover: shown.map((t) => `${day(t.exit_at)} · ${exitLabel(t.exit_reason)} · ${pct(t.return_pct, 2)}`),
    }],
    annotations: [{ type: "hline", y: 0 }, ...(firstOos && firstOos.n > 1 ? [{ type: "vline" as const, x: firstOos.n - 0.5, label: "样本外 →", role: "split" as const }] : [])],
    caption, report_id: report.id, asset: p.key, base_capital: BASE_CAPITAL,
    ...(shown.length < trades.length ? { note: `交易太多,图上等距抽取 ${shown.length} 笔;统计口径仍是全部 ${trades.length} 笔。` } : {}),
  }, "trade_no");
}

/** 月度收益热力图(年 × 月,%) */
export function monthlyHeatmap(report: BacktestReport): ChartDraft | null {
  const p = primaryAsset(report);
  const months = (p?.monthly_returns ?? []).filter((m) => /^\d{4}-\d{2}$/.test(m.period));
  if (!p || months.length < 3) return null;
  const years = [...new Set(months.map((m) => m.period.slice(0, 4)))].sort().slice(-64);
  const z = years.map((y) => Array.from({ length: 12 }, (_, i) => { const m = months.find((x) => x.period === `${y}-${String(i + 1).padStart(2, "0")}`); return m ? round(m.return * 100) : null; }));
  const flat = months.map((m) => m.return), up = flat.filter((r) => r > 0).length;
  return draft("monthly_heatmap", {
    title: "月度收益热力图", type: "heatmap", x: "category", x_title: "月份", y_title: "年份", y_unit: "%",
    series: [], annotations: [], heatmap: { x: Array.from({ length: 12 }, (_, i) => `${i + 1}月`), y: years, z },
    caption: `${p.label} 共 ${flat.length} 个月:上涨 ${up} 个月、下跌 ${flat.length - up} 个月`, report_id: report.id, asset: p.key,
  }, "month");
}

// ---------------------------------------------------------------------------
// 多策略横比(参数扫描 / A-B)

/** 多策略权益曲线叠加($10k 起)+ 同窗口持有 */
export function strategiesEquity(reports: BacktestReport[]): ChartDraft | null {
  const rows = reports.map((r) => ({ r, p: primaryAsset(r) })).filter((x) => x.p && x.p.equity.length >= 2).slice(0, 6);
  if (rows.length < 2) return null;
  const series: LoopChartSeries[] = [];
  const bench = rows[0]!.p!;
  if (bench.equity.some((e) => e.benchmark_pct !== null)) series.push({ name: `持有 ${bench.label} ($10k)`, mode: "line", role: "benchmark", points: thin(bench.equity, MAX_LINE_POINTS).map((e) => [e.at, e.benchmark_pct === null ? null : round(BASE_CAPITAL * (1 + e.benchmark_pct))]) });
  const names = distinctLabels(rows.map((x) => x.r.title));
  rows.forEach(({ p }, i) => series.push({ name: `${names[i]} ($10k)`, mode: i === 0 ? "line+markers" : "line", role: i === 0 ? "strategy" : "alt", points: thin(p!.equity, MAX_LINE_POINTS).map((e) => [e.at, round(BASE_CAPITAL * (1 + e.pnl_pct))]) }));
  const caption = "$10k 起步期末:" + rows.map(({ p }, i) => `${names[i]} ${money(BASE_CAPITAL * (1 + p!.equity.at(-1)!.pnl_pct))}`).join(",") +
    (bench.equity.at(-1)!.benchmark_pct !== null ? `;持有 ${money(BASE_CAPITAL * (1 + bench.equity.at(-1)!.benchmark_pct!))}` : "");
  return draft("strategies_equity", {
    title: "策略权益曲线横比", type: "line", x: "time", x_title: "日期", y_title: "权益 ($)", y_unit: "$",
    series, annotations: splitLine(rows[0]!.r), caption, report_ids: rows.map((x) => x.r.id), asset: bench.key, base_capital: BASE_CAPITAL,
    note: "同一窗口、同一资产、同一费率滑点;各策略都从 $10k 起。",
  }, "at");
}

/** 多策略回撤叠加 */
export function strategiesDrawdown(reports: BacktestReport[]): ChartDraft | null {
  const rows = reports.map((r) => ({ r, p: primaryAsset(r) })).filter((x) => x.p && x.p.equity.length >= 2).slice(0, 6);
  if (rows.length < 2) return null;
  const names = distinctLabels(rows.map((x) => x.r.title));
  const series: LoopChartSeries[] = rows.map(({ p }, i) => ({ name: names[i]!, mode: "line", role: i === 0 ? "strategy" : "alt", points: thin(p!.equity, MAX_LINE_POINTS).map((e) => [e.at, round(-Math.abs(e.drawdown) * 100)]) }));
  return draft("strategies_drawdown", {
    title: "策略回撤横比", type: "line", x: "time", x_title: "日期", y_title: "回撤 (%)", y_unit: "%",
    series, annotations: [...splitLine(rows[0]!.r), { type: "hline", y: 0 }],
    caption: "最大回撤:" + rows.map(({ p }, i) => `${names[i]} ${(Math.abs(p!.metrics!.max_drawdown) * 100).toFixed(1)}%`).join(","),
    report_ids: rows.map((x) => x.r.id), asset: rows[0]!.p!.key,
  }, "at");
}

export const SINGLE_TEMPLATES = {
  equity_comparison: equityComparison,
  drawdown_comparison: drawdownComparison,
  exit_reason_pnl: exitReasonPnl,
  asset_pnl: assetPnl,
  trade_scatter: tradeScatter,
  monthly_heatmap: monthlyHeatmap,
} as const satisfies Partial<Record<LoopChartTemplate, (r: BacktestReport) => ChartDraft | null>>;
export const MULTI_TEMPLATES = {
  strategies_equity: strategiesEquity,
  strategies_drawdown: strategiesDrawdown,
} as const satisfies Partial<Record<LoopChartTemplate, (r: BacktestReport[]) => ChartDraft | null>>;
export type SingleTemplate = keyof typeof SINGLE_TEMPLATES;
export type MultiTemplate = keyof typeof MULTI_TEMPLATES;

export function buildChart(template: LoopChartTemplate, reports: BacktestReport[]): ChartDraft | null {
  if (template in MULTI_TEMPLATES) return MULTI_TEMPLATES[template as MultiTemplate](reports);
  return reports[0] ? SINGLE_TEMPLATES[template as SingleTemplate](reports[0]) : null;
}

// ---------------------------------------------------------------------------
// 答案挑图:模板决定挑哪几张(≤ MAX_ANSWER_CHARTS),模型只能在这些里面调整顺序、写一句说明

export type AnswerKind = "validate" | "diagnose" | "compare";
export interface ChartPick { template: LoopChartTemplate; report_ids: string[] }

export function pickCharts(input: { kind: AnswerKind; question: string; reports: BacktestReport[] }): ChartPick[] {
  const { reports, question } = input;
  if (!reports.length) return [];
  const multiAsset = (r: BacktestReport) => (primaryAsset(r)?.per_symbol?.length ?? 0) >= 2 || r.assets.filter((a) => a.status === "completed" && a.metrics).length >= 2;
  const wantsMonthly = /月度|每月|月份|哪个月|季节|monthly/i.test(question);
  // 只认「问退出效果」的说法;策略描述里的「死叉离场」「止损放在…」不算
  const wantsExit = /退出类型|退出方式|按退出|哪类(退出|出场|离场)|(退出|离场|出场|止损|止盈)[^,,。;;]{0,6}(怎么样|如何|效果|表现|拖累|太紧|过紧|太松|分布|占比)|exit reason/i.test(question);
  let order: { template: LoopChartTemplate; multi?: boolean }[];
  if (reports.length >= 2) {
    // 横比:多策略叠加两张;问到退出/月度时补一张最高分策略的对应单图
    order = [{ template: "strategies_equity", multi: true }, { template: "strategies_drawdown", multi: true }];
    if (wantsExit) order.push({ template: "exit_reason_pnl" });
    if (wantsMonthly) order.push({ template: "monthly_heatmap" });
  } else {
    const r = reports[0]!;
    const fourth: LoopChartTemplate = multiAsset(r) ? "asset_pnl" : "trade_scatter";
    order = input.kind === "diagnose"
      ? [{ template: "exit_reason_pnl" }, { template: fourth }, { template: "equity_comparison" }, { template: "drawdown_comparison" }, { template: fourth === "asset_pnl" ? "trade_scatter" : "asset_pnl" }]
      : [{ template: "equity_comparison" }, { template: "drawdown_comparison" }, { template: "exit_reason_pnl" }, { template: fourth }, { template: "trade_scatter" }];
    if (wantsMonthly) order.splice(input.kind === "diagnose" ? 2 : 1, 0, { template: "monthly_heatmap" });
  }
  // 横比时单图用评分最高的那份报告
  const best = [...reports].sort((a, b) => b.score.value - a.score.value)[0]!;
  const out: ChartPick[] = [];
  for (const o of order) {
    if (out.length >= MAX_ANSWER_CHARTS) break;
    if (out.some((x) => x.template === o.template)) continue;
    const ids = o.multi ? reports.map((r) => r.id) : [best.id];
    const src = o.multi ? reports : [best];
    if (buildChart(o.template, src)) out.push({ template: o.template, report_ids: ids });
  }
  return out;
}

/** 回测步骤各自产出哪几张(答案再从中挑;缺的由 compose 现算) */
export const STEP_TEMPLATES: Record<"run_backtest" | "compare_buy_and_hold" | "diagnose_backtest", SingleTemplate[]> = {
  run_backtest: ["equity_comparison"],
  compare_buy_and_hold: ["equity_comparison", "drawdown_comparison"],
  diagnose_backtest: ["exit_reason_pnl", "asset_pnl", "trade_scatter"],
};
