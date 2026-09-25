/**
 * 研究模式与计划模板(§9.45)。
 *
 * 计划的形状由代码给死,模型只在模板里填参数(资产、周期、窗口、策略文本、形态参数)。
 * 以前「A 策略 + B 策略各排一组回测」只靠提示词约束,模型漏一组就静默退化成单策略;
 * 现在由 splitStrategies + validate_multi 模板保证,模型给的计划如果不满足模式不变量会被丢回模板。
 */
import type { LoopPlan, LoopPlanStep, LoopTaskKind, LoopContext } from "@trading-swarm/contracts";
import { matchLexicon } from "./lexicon.js";
import { registry as primitives } from "../primitives/index.js";
import { resolveConcepts, usableTargets, type ConceptResolution } from "./concepts.js";
import {
  DIRECTION_BOTH,
  SIGNAL_FREQUENCY_STRONG,
  STRATEGY_BUILD,
  TRADE_ACTION,
  multiTimeframeHint,
  parseWindowPhrase,
  stripTradeFrequency,
} from "./phrasing.js";

const DAY = 86400000;

export type ResearchMode =
  | "validate_single"
  | "validate_multi"
  | "compare_assets"
  | "market_leverage"
  | "diagnose"
  | "parameter_sweep"
  | "pattern_frequency";

export interface ModeDecision {
  mode: ResearchMode;
  task_kind: LoopTaskKind;
  reason: string;
}

export interface StrategySlot {
  /** 计划里的步骤后缀:a / b / c */
  key: string;
  label: string;
  text: string;
}

export interface PatternSlot {
  concept_id: string;
  primitive: string;
  params: Record<string, unknown>;
  horizon_bars: number;
}

export interface ModeParams {
  instruments: string[];
  window: { from_ms: number; to_ms: number };
  timeframe: string;
  market: "spot" | "perp";
  strategies: StrategySlot[];
  benchmark: string;
  pattern: PatternSlot | null;
  run_id: string | null;
  clarify: string | null;
}

/** pattern_frequency 能统计的信号原语及其默认参数(原语 schema 没有 default,统计口径必须写死在代码里)。 */
export const PATTERN_DEFAULTS: Record<string, Record<string, unknown>> = {
  ema_cross: { fast: 20, slow: 50 },
  macd_cross: { fast: 12, slow: 26, signal: 9 },
  macd_divergence: { fast: 12, slow: 26, signal: 9, swing_length: 3, lookback: 60, source: "histogram" },
  macd_divergence_exit: { fast: 12, slow: 26, signal: 9, swing_length: 3, lookback: 60, source: "histogram" },
  donchian_breakout: { lookback: 20, basis: "close" },
  volume_surge: { lookback: 20, multiple: 2 },
  rsi_threshold: { period: 14, threshold: 70, operator: "above" },
  higher_low_sequence: { count: 3 },
  structure_bos: { swing_length: 3 },
  trend_break: { ema_period: 50, htf: "1d" },
  // 形态与通用原语(2026-09-22 指标库落地后补;参数取各原语 schema 范围内的常用值)
  bullish_engulfing: { min_body_ratio: 1 },
  bearish_engulfing_exit: { min_body_ratio: 1 },
  double_bottom: { swing_length: 3, lookback: 60, tolerance_pct: 1.5 },
  double_top_exit: { swing_length: 3, lookback: 60, tolerance_pct: 1.5 },
  head_and_shoulders_inverse: { swing_length: 3, lookback: 90, tolerance_pct: 2 },
  pin_bar: { tail_ratio: 2, max_body_pct: 0.3, max_upper_pct: 0.2 },
  fair_value_gap: { min_gap_pct: 0.2 },
  inside_bar_breakout: { max_inside_bars: 3 },
  structure_pivots: { swing_length: 3 },
  indicator_divergence: { indicator: "rsi", args: { period: 14 }, swing_length: 3, lookback: 60 },
  indicator_cross: { indicator: "ema", args: { period: 20 }, compare_to: "indicator", compare_indicator: "ema", compare_args: { period: 50 }, direction: "cross_above" },
  indicator_threshold: { indicator: "rsi", args: { period: 14 }, operator: "cross_above", threshold: 30 },
};

// ── 模式判定 ─────────────────────────────────────────────────────────────

const RE = {
  // 诊断:追问选中回测的原因/可信度/改法(2026-09-23 复盘 skill 接入后补:「复盘一下」「可信吗」「怎么改」原先走不进诊断)
  diagnose: /为什么|亏|why|loss|复盘|归因|可信|靠谱|可靠|问题出在|问题在哪|怎么改|如何改进|改进|哪里不对|原因/i,
  validate: /策略|回测|持有|扣费|strategy|backtest|buy.and.hold/i,
  market: /杠杆|资金费|\bOI\b|清算|funding|leverage|liquidat/i,
  compare: /比|更强|大盘|compar|stronger/i,
  frequency: /频率|多久(?:出现|一次|才)|出现(?:过)?(?:多少|几)次|出现次数|出现(?:后|之后)|(?:随后|之后|接下来)\s*\d+\s*根|收益分布|表现分布|forward.return|how often|frequency/i,
  sweep: /不同参数|参数敏感|哪组参数|换参数|调参|参数扫描|sweep|参数对比/i,
  tradeIntent: /做多|做空|买入|卖出|入场|离场|开仓|平仓|止损|止盈|金叉|死叉|突破|跌破|抄底|哪组|哪个(?:更好|好)|胜率|收益/i,
  sweep2: /(\d{1,4})\s*[/／]\s*(\d{1,4}).{0,12}(?:和|与|vs|还是|或)\s*(\d{1,4})\s*[/／]\s*(\d{1,4})/i,
};

/**
 * 是否含一个能当入场信号用的概念。只认 category=signal 的原语:
 * 「MACD 底背离入场和顶背离离场」里的顶背离是 exit 原语,不能把它当成第二个策略。
 */
function hasSignalConcept(text: string): boolean {
  return matchLexicon(text).some(
    (m) =>
      m.entry.kind === "primitive" &&
      !!m.entry.target &&
      primitives.get(m.entry.target)?.category === "signal",
  );
}

/**
 * 把并列的多个策略拆开。显式分隔符(+ / vs / 、)优先;没有显式分隔符时才考虑「和 / 与 / 以及」,
 * 否则「顶背离和底背离」这类同一策略内部的并列会被误拆成两个策略。
 */
export function splitStrategies(question: string): StrategySlot[] {
  const single = (): StrategySlot[] => [{ key: "a", label: "策略", text: question }];
  const strong = /\s*(?:\+|＋|\bvs\.?\b|、)\s*/i;
  const weak = /\s*(?:和|与|以及|还有)\s*/;
  const separator = strong.test(question) ? strong : weak.test(question) ? weak : null;
  if (!separator) return single();
  const parts = question
    .split(separator)
    .map((p) => p.trim())
    .filter(Boolean);
  const usable = parts.filter(hasSignalConcept);
  if (usable.length < 2) return single();
  return usable
    .slice(0, 3)
    .map((text, i) => ({ key: "abc"[i]!, label: `策略 ${"ABC"[i]}`, text }));
}

export function detectMode(
  question: string,
  context: LoopContext = { instrument_refs: [] },
  resolution: ConceptResolution = resolveConcepts(question),
): ModeDecision {
  if (context.selected_run_id && RE.diagnose.test(question))
    return { mode: "diagnose", task_kind: "diagnose", reason: "选中了回测且在问原因,走诊断模式。" };
  // 频率统计在验证之前判:「这个形态多久出现一次」不需要也不应该下单回测。
  // 2026-09-23 晚:「可以高频率交易」说的是交易节奏,先剥掉再判;明说要造策略/回测的一律走验证,
  // 带进出场/止损等交易动作的,只有「多久出现一次/出现频率」这种强说法才仍算频率统计
  const freqText = stripTradeFrequency(question);
  const wantsStrategy =
    STRATEGY_BUILD.test(question) || (TRADE_ACTION.test(question) && !SIGNAL_FREQUENCY_STRONG.test(freqText));
  if (!wantsStrategy && RE.frequency.test(freqText) && usableTargets(resolution, "indicator").concat(usableTargets(resolution, "pattern"), usableTargets(resolution, "structure")).length)
    return { mode: "pattern_frequency", task_kind: "market", reason: "在问信号出现频率与随后表现,只统计不回测。" };
  // 有信号概念且在问参数组/交易动作,即使没说「回测/策略」也是验证类(2026-09-23 实测「均线交叉 20/50 和 10/30 哪组参数更好」被判成市场观察)
  const hasSignal = usableTargets(resolution, "indicator").concat(usableTargets(resolution, "pattern"), usableTargets(resolution, "structure")).length > 0;
  if (hasSignal && (RE.sweep.test(question) || RE.sweep2.test(question)))
    return { mode: "parameter_sweep", task_kind: "validate", reason: "同一策略要比多组参数,按参数组各回测一次。" };
  if (RE.validate.test(question) || (hasSignal && RE.tradeIntent.test(question))) {
    if (RE.sweep.test(question))
      return { mode: "parameter_sweep", task_kind: "validate", reason: "同一策略要比多组参数,按参数组各回测一次。" };
    const strategies = splitStrategies(question);
    if (strategies.length > 1)
      return { mode: "validate_multi", task_kind: "validate", reason: `问题里有 ${strategies.length} 个并列策略,各排一组编译/回测/持有对比。` };
    return { mode: "validate_single", task_kind: "validate", reason: "单个策略验证。" };
  }
  if (RE.market.test(question))
    return { mode: "market_leverage", task_kind: "market", reason: "市场观察:价格与杠杆相关数据。" };
  if (RE.compare.test(question))
    return { mode: "compare_assets", task_kind: "compare", reason: "多资产相对强弱比较。" };
  return { mode: "market_leverage", task_kind: "market", reason: "默认走市场观察。" };
}

// ── 默认参数(规则版,模型不可用时就用它) ──────────────────────────────

function symbolsOf(question: string): string[] {
  const symbols = [
    ...new Set(
      (question.match(/\b(?:BTC|ETH|SOL|DOGE|XRP|BNB|ADA|AVAX|DOT|LINK|TON|SUI|HYPE|SPY|AAPL|QQQ)\b/gi) ?? []).map((s) => s.toUpperCase()),
    ),
  ];
  if (/比特币|大饼/.test(question) && !symbols.includes("BTC")) symbols.push("BTC");
  if (/以太坊|以太/.test(question) && !symbols.includes("ETH")) symbols.push("ETH");
  if (/索拉纳/.test(question) && !symbols.includes("SOL")) symbols.push("SOL");
  if (/狗狗币/.test(question) && !symbols.includes("DOGE")) symbols.push("DOGE");
  return symbols;
}

export function defaultParams(
  question: string,
  context: LoopContext,
  now: number,
  decision: ModeDecision,
  resolution: ConceptResolution,
  inferredTimeframe: string | null,
): ModeParams {
  const symbols = symbolsOf(question);
  const refs = context.instrument_refs.length && !symbols.length ? context.instrument_refs : symbols;
  const market: "spot" | "perp" = /现货|spot/i.test(question)
    ? "spot"
    : /永续|perp|杠杆|资金费|\bOI\b|清算|funding|leverage/i.test(question) && decision.task_kind === "market"
      ? "perp"
      : // 回测类问题提到永续/合约/做空/杠杆 → 永续(做空与杠杆只能在永续上回测;订单执行核 + data/perp-market.ts,2026-09-23 WP-F)
        // 「多空/双向」也只能在永续上回测(2026-09-23 晚:原先落到现货只做多,报告里事后声明)
        (/永续|合约|perp|swap|做空|开空|空单|杠杆|leverage/i.test(question) || DIRECTION_BOTH.test(question)) &&
          decision.task_kind === "validate"
        ? "perp"
        : "spot";
  const instruments = refs.map((s) =>
    s.startsWith("okx:") ? s : `okx:${market}:${s}-USDT${market === "perp" ? "-SWAP" : ""}`,
  );
  if (decision.mode === "compare_assets" && instruments.length && !instruments.includes("okx:spot:BTC-USDT"))
    instruments.push("okx:spot:BTC-USDT");
  const days = Number(/(\d+)\s*(?:天|days?)/i.exec(question)?.[1] ?? 30);
  // 用户显式给的区间(「只要2026年」「2024-2025」「最近3个月」…)优先于「N 天」、上一轮的窗口与缺省 30 天
  const explicit = parseWindowPhrase(question, now);
  const window = (explicit ? { from_ms: explicit.from_ms, to_ms: explicit.to_ms } : undefined) ??
    (/([0-9]+)\s*(?:天|days?)/i.test(question) ? undefined : context.selected_window) ?? {
    from_ms: Math.max(0, now - Math.min(Math.max(days, 1), 365) * DAY),
    to_ms: now,
  };
  const strategies =
    decision.mode === "validate_multi"
      ? splitStrategies(question)
      : decision.mode === "parameter_sweep"
        ? // 只编译一次基准;其余参数组由 derive_param_variants 从基准 IR 确定性派生(loop/sweep.ts),不再让模型按文字提示重编
          [{ key: "a", label: "基准参数", text: question }]
        : [{ key: "a", label: "策略", text: question }];
  const signal =
    usableTargets(resolution, "indicator")[0] ??
    usableTargets(resolution, "pattern")[0] ??
    usableTargets(resolution, "structure")[0] ??
    null;
  const pattern: PatternSlot | null =
    decision.mode === "pattern_frequency" && signal?.target
      ? {
          concept_id: signal.concept_id,
          primitive: signal.target,
          params: PATTERN_DEFAULTS[signal.target] ?? {},
          horizon_bars: Number(/(?:随后|之后|接下来)\s*(\d+)\s*根/.exec(question)?.[1] ?? 10),
        }
      : null;
  return {
    instruments,
    window,
    timeframe: inferredTimeframe ?? "1h",
    market,
    strategies,
    benchmark: "okx:spot:BTC-USDT",
    pattern,
    run_id: context.selected_run_id ?? null,
    clarify: null,
  };
}

// ── 模板 ─────────────────────────────────────────────────────────────────

/** 参数扫描除基准外的派生组数 */
export const SWEEP_VARIANTS = 2;

function step(
  key: string,
  title: string,
  tool: string,
  args: Record<string, any>,
  depends_on: string[] = [],
): LoopPlanStep {
  return { key, title, tool, args, depends_on };
}

/** market 模式的多资产克隆:第 0 组之外按序号复制步骤并重写 $ 引用。 */
function cloneForInstrument(base: LoopPlanStep[], index: number, title: string): LoopPlanStep[] {
  const rename = (key: string) => (key === "resolve" ? key : key + "_" + index);
  const args = (v: any): any =>
    typeof v === "string" && v.startsWith("$")
      ? v.startsWith("$resolve.instruments.")
        ? "$resolve.instruments." + index
        : "$" + rename(v.slice(1).split(".")[0]!) + v.slice(v.indexOf("."))
      : Array.isArray(v)
        ? v.map(args)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, args(x)]))
          : v;
  return base.map((s) => ({
    ...s,
    key: rename(s.key),
    title: title + " · " + s.title,
    args: args(s.args),
    depends_on: s.depends_on.map(rename),
  }));
}

/** 所有模板共用的开头:确认资产 + 检查数据覆盖。 */
function head(params: ModeParams, metric: "price" | "funding", dataArgs: Record<string, unknown>): LoopPlanStep[] {
  return [
    step("resolve", "确认资产与交易市场", "resolve_instruments", {
      symbols: params.instruments,
      market: params.instruments[0]!.includes(":perp:") ? "perp" : "spot",
    }),
    step("coverage", "检查数据覆盖", "inspect_data_coverage", { ...dataArgs, metric }, ["resolve"]),
  ];
}

export interface BuildInput {
  question: string;
  decision: ModeDecision;
  params: ModeParams;
  resolution: ConceptResolution;
  source: LoopPlan["source"];
}

/**
 * 按模式生成完整计划。除了 compose_answer(永远在最后),这里不做任何模型调用,
 * 所以同样的参数一定得到同样的计划。
 */
export function buildModePlan(input: BuildInput): LoopPlan {
  const { decision, params, question } = input;
  const plan: LoopPlan = {
    task_kind: decision.task_kind,
    mode: decision.mode,
    instruments: params.instruments,
    window: params.window,
    timeframe: params.timeframe,
    plan: [],
    source: input.source,
  };
  if (params.clarify) return { ...plan, clarify: params.clarify };
  const dataArgs = { instrument: "$resolve.instruments.0", window: params.window, timeframe: params.timeframe };
  if (decision.mode === "diagnose") {
    if (!params.run_id) return { ...plan, clarify: "请先选中一次回测,再问它为什么是这个结果。" };
    plan.plan.push(step("compare", "核对选中回测与持有", "compare_buy_and_hold", { run_id: params.run_id, arm: "a_rules" }));
    plan.plan.push(step("diagnose", "拆解收益差的来源", "diagnose_backtest", { run_id: params.run_id, arm: "a_rules" }));
  } else if (!params.instruments.length) {
    return { ...plan, clarify: "请指定要研究的资产，以及现货或永续市场。" };
  } else if (decision.mode === "market_leverage") {
    plan.plan.push(...head(params, "funding", dataArgs));
    for (const [key, title, tool] of [
      ["price", "读取价格与成交量", "get_price_history"],
      ["funding", "读取已结算资金费率", "get_funding_history"],
      ["oi", "读取持仓量", "get_open_interest"],
      ["liquidations", "读取真实清算记录", "get_liquidations"],
    ])
      plan.plan.push(step(key!, title!, tool!, dataArgs, ["resolve", "coverage"]));
    plan.plan.push(step("estimates", "确认清算估计数据缺口", "get_liquidation_estimates", dataArgs, ["resolve"]));
    plan.plan.push(
      step(
        "analyze",
        "分析价格与杠杆变化",
        "analyze_leverage",
        {
          price_snapshot: "$price.snapshot_id",
          funding_snapshot: "$funding.snapshot_id",
          oi_snapshot: "$oi.snapshot_id",
          liquidations_snapshot: "$liquidations.snapshot_id",
        },
        ["price", "funding", "oi", "liquidations"],
      ),
    );
    plan.plan.push(
      step(
        "render",
        "生成价格证据图",
        "render_artifact",
        { kind: "chart", spec: { type: "line", x: "close_time", y: "close" }, snapshot_refs: ["$price.snapshot_id"], title: "价格历史", question },
        ["price"],
      ),
    );
    if (params.instruments.length > 1) {
      const base = plan.plan.filter((s) => s.key !== "resolve");
      for (let i = 1; i < params.instruments.length; i++)
        plan.plan.push(...cloneForInstrument(base, i, params.instruments[i]!));
    }
  } else if (decision.mode === "compare_assets") {
    plan.plan.push(...head(params, "price", dataArgs));
    params.instruments.forEach((_, i) =>
      plan.plan.push(
        step("price_" + i, "读取资产价格", "get_price_history", { ...dataArgs, instrument: "$resolve.instruments." + i }, ["resolve", "coverage"]),
      ),
    );
    plan.plan.push(
      step(
        "analyze",
        "比较相对表现",
        "analyze_relative_strength",
        {
          instruments: params.instruments,
          benchmark: params.benchmark,
          timeframe: params.timeframe,
          window: params.window,
          snapshot_refs: params.instruments.map((_, i) => "$price_" + i + ".snapshot_id"),
        },
        params.instruments.map((_, i) => "price_" + i),
      ),
    );
  } else if (decision.mode === "pattern_frequency") {
    if (!params.pattern)
      return { ...plan, clarify: "请说明要统计哪个信号或形态；目前只能统计已有原语的信号。" };
    plan.plan.push(...head(params, "price", dataArgs));
    plan.plan.push(step("price", "读取统计用价格历史", "get_price_history", dataArgs, ["resolve", "coverage"]));
    plan.plan.push(
      step(
        "pattern",
        `统计 ${params.pattern.concept_id} 的出现频率与随后表现`,
        "analyze_pattern_frequency",
        {
          price_snapshot: "$price.snapshot_id",
          primitive: params.pattern.primitive,
          params: params.pattern.params,
          horizon_bars: params.pattern.horizon_bars,
          label: params.pattern.concept_id,
        },
        ["price"],
      ),
    );
    plan.plan.push(
      step(
        "render",
        "生成价格证据图",
        "render_artifact",
        { kind: "chart", spec: { type: "line", x: "close_time", y: "close" }, snapshot_refs: ["$price.snapshot_id"], title: "价格历史", question },
        ["price"],
      ),
    );
  } else {
    // validate_single / validate_multi / parameter_sweep:同一条数据线,按策略数复制编译-回测-对比三件套
    plan.plan.push(...head(params, "price", dataArgs));
    plan.plan.push(step("price", "读取回测历史价格", "get_price_history", dataArgs, ["resolve", "coverage"]));
    // 未映射的指标/形态先走获取子 loop(词典→模型定义→Pine 写脚本并准入),编译步等它们;拿不到也不阻塞,编译会把它记进 unmapped
    const unmapped = input.resolution.unmapped.filter((c) => ["indicator", "pattern", "structure"].includes(c.category)).slice(0, 4);
    const acquireKeys = unmapped.map((c, i) => {
      plan.plan.push(step(`acquire_${i}`, `获取概念:${c.term}`, "acquire_concept", { concept: c.term, category: c.category, question }, ["resolve"]));
      return `acquire_${i}`;
    });
    // 目录里已有的 Pine 脚本(概念解析判为 acquired)直接作为已获取概念带给编译,不再跑获取子 loop
    const fromCatalog = input.resolution.concepts.filter((c) => c.status === "acquired" && c.target).map((c) => ({ concept: c.term, definition: c.note, implementation: { kind: "pine", target: c.target, params: { script_id: c.target } } }));
    const multi = params.strategies.length > 1;
    // 「日线 trigger / 15 分钟进出场」这类多周期说法:执行周期定为较小周期,方向门与其余周期的表达方式写进编译文本
    const mtHint = multiTimeframeHint(question);
    for (const s of params.strategies) {
      const suffix = multi ? "_" + s.key : "";
      plan.plan.push(
        step(`compile${suffix}`, `${s.label}:把策略想法编译为规则`, "compile_strategy", { text: mtHint ? s.text + "\n\n" + mtHint : s.text, timeframe: params.timeframe, ...(acquireKeys.length || fromCatalog.length ? { acquired: [...acquireKeys.map((k) => "$" + k), ...fromCatalog] } : {}) }, ["price", ...acquireKeys]),
      );
      plan.plan.push(
        step(
          `backtest${suffix}`,
          `${s.label}:预检查与回测`,
          "run_backtest",
          { ...dataArgs, ir: `$compile${suffix}.ir`, price_snapshot: "$price.snapshot_id" },
          ["resolve", `compile${suffix}`, "price"],
        ),
      );
      plan.plan.push(
        step(`compare${suffix}`, `${s.label}:同窗口对比持有`, "compare_buy_and_hold", { run_id: `$backtest${suffix}.run_id`, arm: "a_rules" }, [`backtest${suffix}`]),
      );
    }
    if (decision.mode === "parameter_sweep") {
      // 两组派生参数:问题里写了取值按取值,没写做周期 ×0.5 / ×2 敏感性;每组同窗口回测 + 对比持有。
      // 派生组的回测排在基准回测之后:基准先建出策略对象,派生组按「基准标题 · 参数」挂成它的新版本
      plan.plan.push(step("variants", "派生对照参数组", "derive_param_variants", { ir: "$compile.ir", question, timeframe: params.timeframe, count: SWEEP_VARIANTS }, ["compile"]));
      for (let i = 0; i < SWEEP_VARIANTS; i++) {
        const k = "_v" + i;
        plan.plan.push(step(`backtest${k}`, `参数组 ${i + 2}:预检查与回测`, "run_backtest", { ...dataArgs, ir: `$variants.variants.${i}.ir`, price_snapshot: "$price.snapshot_id" }, ["resolve", "variants", "price", "backtest"]));
        plan.plan.push(step(`compare${k}`, `参数组 ${i + 2}:同窗口对比持有`, "compare_buy_and_hold", { run_id: `$backtest${k}.run_id`, arm: "a_rules" }, [`backtest${k}`]));
      }
    }
  }
  plan.plan.push(
    step("answer", "整理结论与来源", "compose_answer", { question, steps: [], artifact_ids: [], metrics: {} }, plan.plan.map((s) => s.key)),
  );
  return plan;
}

/**
 * 模式不变量:模型给的计划必须仍然满足这个模式的最低结构,否则丢回代码模板。
 * 只查结构,不查参数 —— 参数本来就是留给模型填的。
 */
export function modeViolation(plan: LoopPlan, decision: ModeDecision): string | null {
  const tools = plan.plan.map((s) => s.tool);
  const count = (tool: string) => tools.filter((t) => t === tool).length;
  if (plan.task_kind !== decision.task_kind) return "task_kind_mismatch";
  switch (decision.mode) {
    case "validate_multi":
      return count("compile_strategy") >= 2 && count("run_backtest") >= 2
        ? null
        : "validate_multi_needs_two_backtests";
    case "parameter_sweep":
      return count("run_backtest") >= 2 && count("derive_param_variants") >= 1 ? null : "parameter_sweep_needs_derived_variants";
    case "validate_single":
      return count("run_backtest") >= 1 ? null : "validate_needs_backtest";
    case "compare_assets":
      return count("analyze_relative_strength") >= 1 ? null : "compare_needs_relative_strength";
    case "pattern_frequency":
      return count("run_backtest") === 0 ? null : "pattern_frequency_must_not_backtest";
    case "diagnose":
      return count("compare_buy_and_hold") >= 1 ? null : "diagnose_needs_comparison";
    default:
      return null;
  }
}
