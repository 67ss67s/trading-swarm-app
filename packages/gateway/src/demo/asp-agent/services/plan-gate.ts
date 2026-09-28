/**
 * 服务「交易计划把关」(plan_gate):买方给一笔计划(symbol/side/entry/stop/targets/timeframe/market),
 * 先过确定性代码门槛,全部硬门槛通过才问 AI 模型(deps.judge,钉住的决策连接 + 每 job 原子预算;只作参考旁注),
 * 结论只有 通过 / 不通过 / 存疑(pass / fail / uncertain)+ 每条门槛数值 + 一句人话原因。只给分析与依据,不下指令、不碰交易所。
 * 交付正文英文(OKX.AI 国际买方);中文计划文本照常解析(parsePlan 中英关键词都认)。
 *
 * 硬门槛(不过 = 不通过,且不花模型的钱):止损方向、加权盈亏比 ≥1.5、止损距离 0.5–4 ATR(14)、入场离最新收盘 ≤3 ATR 且计划未失效。
 * 入场价偏离现价 > 10 ATR 或 > 10% 时最优先提示「可能是旧价格或笔误」;盈亏比 / 止损距离不达标时给出「目标需 ≥ X」这类纯算术修正提示。
 * 软门槛(不过 = 最多存疑):日线状态顺势、24h 成交额(可选依赖)。
 * 结论只由代码证据决定(09-27 负责人拍板;模型概率几乎恒定 15–35%、未校准):硬门槛不过 = 不通过;全过时,
 * 同距离历史「目标先于止损」频率比盈亏平衡高出 ≥5 个百分点、独立样本 ≥30、没有软门槛提示、没有未检查项 = 通过,否则存疑并写明哪条。
 * AI 模型只在硬门槛全过后调用,作为「AI reference (uncalibrated)」旁注展示,明写不改变结论。对外不写模型名/版本/成本。
 * 代码对照:同一批 K 线(一次拉约 1000 根;门槛与模型输入只用最近 150 根)按同样的止损/第一目标百分比距离,
 * 统计目标先于止损触达的频率与盈亏平衡胜率 —— 这是硬门槛全过后决定 通过 / 存疑 的主证据。
 */
import {
  atr14, BARS_LIMIT, BASE_RATE_BARS, closedBars, fmtBig, fmtPrice, fx, JEV_TIMEFRAMES, LABEL_TEXT, marketFeatures, MARKET_TEXT, MIN_INDEPENDENT_SAMPLES, parsePlan,
  priceDigits, r4, roundPrice, serviceCandidate, SIDE_TEXT, swingLevels, targetFirstRate, TEMPLATE_NAME, TF_MS, utcText, weightedRR, type TargetFirstRate,
} from './jev-probability.js';
import type { ResearchBar } from '@trade-gate/contracts';
import { deliverable, pct } from './render.js';
import { ServiceInputError, type PerCallService, type ServiceDeps } from './types.js';
import type { JudgeResult } from '../../research/judge/types.js';

export interface PlanGateParams { symbol: string; side: 'long' | 'short'; entry: number; stop: number; targets: number[]; timeframe: string; market: 'spot' | 'perp' }
export interface PlanGateDeps extends ServiceDeps {
  /** 可选:24h 成交额(USDT);取不到返回 null → 流动性门槛记为 n/a */
  quoteVolume24h?(symbol: string, market: 'spot' | 'perp'): Promise<number | null>;
}
export const PLAN_GATE_LIMITS = { min_rr: 1.5, stop_atr_min: 0.5, stop_atr_max: 4, max_entry_drift_atr: 3, min_quote_vol_24h: 2_000_000, stale_drift_atr: 10, stale_drift_pct: 0.1 } as const;

export type GateStatus = 'pass' | 'fail' | 'warn' | 'n/a';
export interface GateRow { key: string; label: string; hard: boolean; status: GateStatus; value: number | string | null; value_text: string; threshold: string; note: string }
export type PlanVerdict = 'pass' | 'fail' | 'uncertain';

export const VERDICT_TEXT: Record<PlanVerdict, string> = { pass: 'PASS', fail: 'FAIL', uncertain: 'UNCERTAIN' };
const STATUS_MARK: Record<GateStatus, string> = { pass: '✓', fail: '✗', warn: '!', 'n/a': '—' };
const AI_LABEL = LABEL_TEXT as Record<string, Record<string, string>>;
const AI_NAME = TEMPLATE_NAME as Record<string, string>;
/** 两个不同问题的模型概率相差不超过这个值 → 提示「区分度有限」 */
const AI_SAME_ANSWER = 0.03;
const EMA_STACK_TEXT = { bull: 'bullish stack', bear: 'bearish stack', mixed: 'mixed' } as const;
const REASON_TEXT: Record<string, string> = { judge_budget_exhausted: 'model call quota for this order used up', judge_timeout_or_cancelled: 'timed out', cancelled: 'cancelled' };
const REGIME_TEXT: Record<string, string> = { bull: 'uptrend', bear: 'downtrend', range: 'range', volatile: 'high volatility' };

/** 结论只由代码证据决定;AI 概率与结论并排时必须写明这一句(避免「PASS 旁边一个低 AI 数字」看着矛盾) */
export const AI_DOES_NOT_DECIDE = 'AI probability is shown for reference and does not change the verdict.';
/** 历史证据门槛:目标先于止损的频率要比盈亏平衡高出 edge_margin(5 个百分点)才算「清楚高于」;独立样本数下限沿用 MIN_INDEPENDENT_SAMPLES */
export const PLAN_EVIDENCE = { edge_margin: 0.05 } as const;
/** 硬门槛全过时判 UNCERTAIN 的代码原因 */
export type UncertainKey = 'no_history' | 'small_sample' | 'near_breakeven' | 'below_breakeven' | 'soft_warning' | 'not_checked';
/** 同距离历史频率 → 证据判读:key 为 null = 清楚高于盈亏平衡且样本够(可 PASS);text 为人话(英文) */
export function historyEvidence(ref: TargetFirstRate | null): { key: UncertainKey | null; text: string; edge: number | null } {
  if (!ref) return { key: 'no_history', text: 'no same-distance history resolved in the lookback, so the geometry has no historical check', edge: null };
  const edge = ref.target_first - ref.breakeven, pts = Math.round(Math.abs(edge) * 100);
  const cmp = `target 1 came before the stop ${pct(ref.target_first, 0)} of the time vs ${pct(ref.breakeven, 0)} breakeven`;
  const signed = `${edge >= 0 ? '+' : '−'}${pts} pts`;
  if (ref.independent < MIN_INDEPENDENT_SAMPLES) return { key: 'small_sample', text: `the same-distance history has only ~${ref.independent} independent samples (a firm read needs ${MIN_INDEPENDENT_SAMPLES}); ${cmp}`, edge };
  if (Math.abs(edge) < PLAN_EVIDENCE.edge_margin - 1e-9) return { key: 'near_breakeven', text: `the history is within ${PLAN_EVIDENCE.edge_margin * 100} pts of breakeven (${cmp}, ${signed}, ~${ref.independent} samples)`, edge };
  if (edge < 0) return { key: 'below_breakeven', text: `the history is below breakeven (${cmp}, ${signed}, ~${ref.independent} samples)`, edge };
  return { key: null, text: `${cmp} (${signed}, ~${ref.independent} samples)`, edge };
}

/** 结构止损在摆动低点 / 高点外侧留的缓冲(ATR 倍数) */
export const STRUCTURE_BUFFER_ATR = 0.25;
/** 仓位示例:单笔风险占权益比例、示例权益(USDT) */
export const SIZING_EXAMPLE = { risk_frac: 0.01, equity: 10_000 } as const;

export interface PlanFixes { lines: string[]; structure_stop: number | null; alternatives: { label: string; stop: number; target: number; reward_risk: number; target_first: number; expectancy_r: number; independent: number }[]; sizing: { stop_pct: number; notional_x_equity: number; example_qty: number; example_notional: number } | null }

/**
 * 「怎么改更好」:不论结论如何都给(复审 09-26:PASS / UNCERTAIN 没有任何修正建议)。纯代码、纯算术,依据是同一批 K 线:
 * 止损相对结构(最近已确认摆动低/高点)与 ATR、目标路径上的阻力/支撑、入场相对现价、同距离历史频率下的备选几何、按 1% 风险算的仓位,
 * 以及软门槛(逆势 / 高波动 / 流动性)对应的处理。只写事实与算术,不写买卖指令。
 */
export function planFixes(x: {
  side: 'long' | 'short'; entry: number; stop: number; targets: number[]; valid: number[]; rr: number | null; last: number; atr: number;
  bars: readonly ResearchBar[]; refBars: readonly ResearchBar[]; market: 'spot' | 'perp'; symbol: string; digits: number;
  sideOk: boolean; stale: boolean; invalidated: string; gates: GateRow[];
}): PlanFixes {
  const { side, entry, stop, valid, last, atr } = x, dir = side === 'long' ? 1 : -1, L = PLAN_GATE_LIMITS;
  const P = (v: number | null | undefined) => fmtPrice(v, x.digits), RP = (v: number) => roundPrice(v, x.digits);
  const risk = Math.abs(entry - stop), lines: string[] = [];
  const lowHigh = side === 'long' ? 'swing low' : 'swing high', belowAbove = side === 'long' ? 'below' : 'above';
  let structure_stop: number | null = null;
  const alternatives: PlanFixes['alternatives'] = [];

  // ---- 失效 / 旧价格:先把计划挪回现价(保持同样的百分比距离)
  if (x.stale || x.invalidated) {
    const rf = risk / entry, tf = valid.length ? Math.abs(valid[0]! - entry) / entry : null;
    lines.push(`Re-anchor: the plan does not hold at the last price ${P(last)}; the same distances from there put the stop at ${P(last * (1 - dir * rf))}${tf !== null ? ` and target 1 at ${P(last * (1 + dir * tf))}` : ''} — re-check against the chart before reusing them.`);
  }
  // ---- 止损方向
  if (!x.sideOk) lines.push(`Stop side: for a ${side} the stop belongs ${belowAbove} the entry; a 1.5 ATR stop would sit at ${P(entry - dir * 1.5 * atr)}.`);

  // ---- 止损相对结构
  const sw = swingLevels(x.bars), lvl = side === 'long' ? sw.support : sw.resistance;
  if (x.sideOk && !x.stale) {
    if (lvl !== null && (entry - lvl) * dir > 0) {
      const sStop = lvl - dir * STRUCTURE_BUFFER_ATR * atr, sAtr = Math.abs(entry - sStop) / atr, inBand = sAtr >= L.stop_atr_min && sAtr <= L.stop_atr_max;
      const sRR = weightedRR(side, entry, sStop, valid).rr;
      const beyond = (lvl - stop) * dir; // >0 = 止损在结构外侧
      if (beyond <= 0) {
        structure_stop = inBand ? RP(sStop) : null;
        lines.push(`Stop vs structure: the stop ${P(stop)} sits ${side === 'long' ? 'above' : 'below'} the nearest ${lowHigh} ${P(lvl)}, i.e. inside the structure — a retest of ${P(lvl)} would take it out. `
          + (inBand ? `A structure stop at ${P(sStop)} (${STRUCTURE_BUFFER_ATR} ATR beyond it, ${fx(sAtr)} ATR from entry) avoids that${sRR !== null ? `; reward/risk with the same targets becomes ${fx(sRR)}` : ''}.` : `A stop beyond it would be ${fx(sAtr)} ATR from entry, outside the ${L.stop_atr_min}–${L.stop_atr_max} ATR band, so this entry is far from structure.`));
      } else if (beyond > atr && inBand && sAtr * atr < risk) {
        structure_stop = RP(sStop);
        lines.push(`Stop vs structure: the stop is ${fx(beyond / atr)} ATR beyond the nearest ${lowHigh} ${P(lvl)}; a structure stop at ${P(sStop)} cuts risk by ${Math.round((1 - sAtr * atr / risk) * 100)}%${sRR !== null ? ` and lifts reward/risk to ${fx(sRR)}` : ''}.`);
      } else if (beyond > atr) {
        const a15 = entry - dir * 1.5 * atr, a2 = entry - dir * 2 * atr, rr15 = weightedRR(side, entry, a15, valid).rr;
        lines.push(`Stop vs structure: the stop is ${fx(beyond / atr)} ATR beyond the nearest ${lowHigh} ${P(lvl)}, which is only ${fx(Math.abs(entry - lvl) / atr)} ATR from the entry — too close for a structure stop inside the ${L.stop_atr_min}–${L.stop_atr_max} ATR band; `
          + `an ATR stop at 1.5–2 ATR sits at ${P(a15)}–${P(a2)}${rr15 !== null ? ` (reward/risk ${fx(rr15)} at 1.5 ATR with the same targets)` : ''}.`);
      } else lines.push(`Stop vs structure: the stop ${P(stop)} sits just beyond the nearest ${lowHigh} ${P(lvl)} (${fx(Math.abs(entry - stop) / atr)} ATR from entry) — structure-based placement.`);
    } else lines.push(`Stop vs structure: no confirmed ${lowHigh} ${belowAbove} the entry in the last 100 bars, so the stop is judged on ATR only (${fx(risk / atr)} ATR; the gate band is ${L.stop_atr_min}–${L.stop_atr_max} ATR).`);
  }

  // ---- 盈亏比 / 目标路径
  const rrOk = x.rr !== null && x.rr >= L.min_rr;
  if (x.sideOk && !x.stale) {
    const obstacle = side === 'long' ? sw.resistance : sw.support;
    if (!x.targets.length) lines.push(`Targets: none given; ${L.min_rr}R would be ${P(entry + dir * L.min_rr * risk)} and 2R ${P(entry + dir * 2 * risk)}.`);
    else if (!rrOk) lines.push(`Reward/risk ${fx(x.rr)}: target 1 needs to be at least ${P(entry + dir * L.min_rr * risk)} for ${L.min_rr}R, or the stop tighter at the same target.`);
    else if (obstacle !== null && valid.length && (obstacle - entry) * dir > 0 && (valid[0]! - obstacle) * dir > 0) {
      const rObs = Math.abs(obstacle - entry) / risk;
      lines.push(`Target path: target 1 ${P(valid[0]!)} lies beyond the nearest ${side === 'long' ? 'swing high' : 'swing low'} ${P(obstacle)} (${fx(Math.abs(obstacle - entry) / atr, 1)} ATR from entry); price has to clear it first — a partial exit there would lock ${fx(rObs)}R on that portion.`);
    } else lines.push(`Reward/risk ${fx(x.rr)} clears the ${L.min_rr} minimum and target 1 has no confirmed swing level in the way.`);
  }

  // ---- 入场相对现价
  if (x.sideOk && !x.stale && !x.invalidated) {
    const gap = (entry - last) / atr, mRR = (last - stop) * dir > 0 ? weightedRR(side, last, stop, valid).rr : null;
    if (Math.abs(gap) <= 0.25) lines.push(`Entry: at the market (within 0.25 ATR of the last price ${P(last)}).`);
    else if (gap * dir < 0) lines.push(`Entry: ${P(entry)} is ${fx(Math.abs(gap), 1)} ATR ${side === 'long' ? 'below' : 'above'} the last price ${P(last)} — a resting limit that fills only on a pullback; at the market now the same stop and targets give reward/risk ${fx(mRR)}${mRR !== null ? ` (stop ${fx(Math.abs(last - stop) / atr)} ATR away)` : ''}.`);
    else lines.push(`Entry: ${P(entry)} is ${fx(Math.abs(gap), 1)} ATR ${side === 'long' ? 'above' : 'below'} the last price ${P(last)} — breakout-style, it needs a stop-entry trigger; at the market now reward/risk would be ${fx(mRR)}.`);
  }

  // ---- 同一批 K 线上的备选几何(无条件、样本内、未计手续费)
  if (x.sideOk && !x.stale && valid.length && risk > 0) {
    const geo = (label: string, s: number, t: number) => {
      const rf = Math.abs(entry - s) / entry, tf = Math.abs(t - entry) / entry, r = targetFirstRate(x.refBars, side, rf, tf);
      if (!r || r.independent < 10) return;
      const R = tf / rf;
      alternatives.push({ label, stop: RP(s), target: RP(t), reward_risk: r4(R)!, target_first: r4(r.target_first)!, expectancy_r: r4(r.target_first * R - (1 - r.target_first))!, independent: r.independent });
    };
    geo('current plan', stop, valid[0]!);
    for (const k of [1.5, 2, 3]) { const t = entry + dir * k * risk; if (Math.abs(Math.abs(t - entry) / risk - Math.abs(valid[0]! - entry) / risk) > 0.2) geo(`target at ${k}R`, stop, t); }
    if (structure_stop !== null) geo('structure stop, same target 1', structure_stop, valid[0]!);
    if (alternatives.length) {
      const cur = alternatives[0]!, best = [...alternatives].sort((a, b) => b.expectancy_r - a.expectancy_r)[0]!;
      const er = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`;
      lines.push(`Same-history check (last ${x.refBars.length} closed bars, unconditional, before fees): ${alternatives.map((a) => `${a.label}: target 1 first ${pct(a.target_first, 0)} → ${er(a.expectancy_r)}/trade (~${a.independent} samples)`).join('; ')}`
        + (best !== cur && best.expectancy_r - cur.expectancy_r >= 0.05 ? `. Historically the stronger geometry was "${best.label}".` : '. The current geometry is as good as the tested alternatives.'));
    }
  }

  // ---- 仓位算术
  let sizing: PlanFixes['sizing'] = null;
  if (x.sideOk && risk > 0) {
    const stopPct = risk / entry, nx = SIZING_EXAMPLE.risk_frac / stopPct, notional = SIZING_EXAMPLE.equity * nx, qty = notional / entry;
    sizing = { stop_pct: r4(stopPct * 100)!, notional_x_equity: r4(nx)!, example_qty: Number(qty.toPrecision(4)), example_notional: Math.round(notional) };
    const base = x.symbol.replace(/USDT$/, '');
    lines.push(`Sizing: the stop is ${fx(stopPct * 100)}% from entry, so risking ${SIZING_EXAMPLE.risk_frac * 100}% of equity means a notional of ~${fx(nx, 1)}× equity (${fmtBig(SIZING_EXAMPLE.equity)} USDT equity → ~${qty.toPrecision(3)} ${base} ≈ ${fmtBig(notional)} USDT)`
      + (x.market === 'spot' && nx > 1 ? `; spot caps notional at 1× equity, so the most this stop can risk is ${fx(stopPct * 100)}% of equity.` : nx > 10 ? `, which implies more than 10× leverage — a wider stop with smaller size keeps the same account risk at lower leverage.` : '.'));
  }

  // ---- 软门槛
  for (const g of x.gates.filter((g) => g.status === 'warn')) {
    if (g.key === 'regime' && /counter-trend/.test(g.note)) lines.push(`Daily trend: this ${side} is ${g.note.replace(/^.*so this \w+ is /, '')} (${g.value_text}); counter-trend plans usually carry smaller size or wait for the daily EMA stack to turn.`);
    else if (g.key === 'regime') lines.push(`Daily volatility is high: stops are hit more often; a wider stop with proportionally smaller size keeps the same account risk.`);
    else if (g.key === 'liquidity') lines.push(`Liquidity: 24h volume ${g.value_text} is thin; limit orders and smaller size reduce slippage.`);
  }
  return { lines, structure_stop, alternatives, sizing };
}

export interface PlanGateOptions {
  /** 可选:OKX 上有没有这个标的(同步、不发网络;运行时 = AspServices.tradable)。false → 接单前拒单退款 */
  tradable?: (symbol: string, market: 'spot' | 'perp') => boolean;
}
export function createPlanGateService(opts: PlanGateOptions = {}): PerCallService<PlanGateParams> {
  const base = planGateService;
  return {
    ...base,
    validate(job) {
      const v = base.validate(job);
      let listed = true;
      try { listed = opts.tradable ? opts.tradable(v.symbol, v.market) : true; } catch { listed = true; }
      if (!listed) throw new ServiceInputError('symbol_unknown', `${v.symbol} has no tradable OKX ${v.market === 'perp' ? 'USDT perpetual' : 'spot'} market; name a coin listed on OKX (e.g. BTC, ETH, SOL)`);
      return v;
    },
  };
}

export const planGateService: PerCallService<PlanGateParams> = {
  key: 'plan_gate',
  validate(job) {
    const p = parsePlan(job, { inferSide: false });
    if (!p.symbol) throw new ServiceInputError('symbol_missing', 'A symbol is required (e.g. "BTC long, entry 84300, stop 83100, target 86500, 1h")');
    if (!p.side) throw new ServiceInputError('side_missing', 'A side is required (long / short)');
    if (p.entry === null) throw new ServiceInputError('entry_missing', 'An entry price is required');
    if (p.stop === null) throw new ServiceInputError('stop_missing', 'A stop price is required');
    if (!(JEV_TIMEFRAMES as readonly string[]).includes(p.timeframe)) throw new ServiceInputError('timeframe_invalid', `timeframe must be one of ${JEV_TIMEFRAMES.join(' / ')}`);
    return { symbol: p.symbol, side: p.side, entry: p.entry, stop: p.stop, targets: p.targets, timeframe: p.timeframe, market: p.market };
  },
  async handle(job, params, deps: PlanGateDeps) {
    const tf_ms = TF_MS[params.timeframe]!;
    // 一次拉齐:代码对照用全部(目标 1000 根);门槛、ATR、模型输入只用最近 BARS_LIMIT 根(与之前同口径)
    const { bars: refBars, as_of } = closedBars(await deps.bars(params.symbol, params.timeframe, BASE_RATE_BARS, params.market), tf_ms, deps.now());
    const bars = refBars.slice(-BARS_LIMIT);
    const last = Number(bars.at(-1)!.close), atr = atr14(bars), dir = params.side === 'long' ? 1 : -1;
    if (!(atr > 0)) throw new Error('atr_unavailable');
    const d = priceDigits(bars), P = (x: number | null | undefined) => fmtPrice(x, d), RP = (x: number) => roundPrice(x, d);
    const { entry, stop } = params, risk = Math.abs(entry - stop);
    const { rr, valid } = weightedRR(params.side, entry, stop, params.targets);
    const L = PLAN_GATE_LIMITS, gates: GateRow[] = [];
    const side = SIDE_TEXT[params.side];

    // ---- 止损方向
    const sideOk = (entry - stop) * dir > 0;
    gates.push({
      key: 'stop_side', label: 'Stop side', hard: true, status: sideOk ? 'pass' : 'fail', value: RP(stop), value_text: P(stop),
      threshold: params.side === 'long' ? 'stop below entry' : 'stop above entry',
      note: sideOk ? '' : `for a ${side} the stop should be ${params.side === 'long' ? 'below' : 'above'} the entry ${P(entry)}; it is ${P(stop)}`,
    });

    // ---- 加权盈亏比(不达标给出目标至少多少才到 1.5;纯算术)
    const needTarget = entry + dir * L.min_rr * risk;
    const rrFix = sideOk && needTarget > 0 ? `with a stop distance of ${P(risk)}, reaching ${L.min_rr} reward/risk needs ${valid.length > 1 ? 'an average target' : 'a target'} of at least ${P(needTarget)}` : '';
    const rrPass = rr !== null && rr >= L.min_rr;
    gates.push({
      key: 'reward_risk', label: 'Weighted reward/risk', hard: true, status: rrPass ? 'pass' : 'fail', value: r4(rr), value_text: fx(rr),
      threshold: `≥ ${L.min_rr}`,
      note: [
        !params.targets.length ? 'no targets given, reward/risk cannot be computed' : valid.length < params.targets.length ? `${params.targets.length - valid.length} target${params.targets.length - valid.length === 1 ? '' : 's'} on the wrong side, ignored` : valid.length > 1 ? 'multiple targets weighted equally' : '',
        rrPass ? '' : rrFix,
      ].filter(Boolean).join('; '),
    });

    // ---- 止损距离(ATR 倍数)
    const stopAtr = risk / atr;
    const minStop = entry - dir * L.stop_atr_min * atr, maxStop = entry - dir * L.stop_atr_max * atr;
    gates.push({
      key: 'stop_atr', label: 'Stop distance', hard: true, status: stopAtr >= L.stop_atr_min && stopAtr <= L.stop_atr_max ? 'pass' : 'fail', value: r4(stopAtr), value_text: `${fx(stopAtr)} ATR`,
      threshold: `${L.stop_atr_min}–${L.stop_atr_max} ATR`,
      note: stopAtr < L.stop_atr_min ? `only ${fx(stopAtr)} ATR, normal noise can hit it; ${L.stop_atr_min} ATR corresponds to a stop at ${P(minStop)}`
        : stopAtr > L.stop_atr_max ? `${fx(stopAtr)} ATR, single-trade risk is too large; staying within ${L.stop_atr_max} ATR means a stop ${params.side === 'long' ? 'above' : 'below'} ${P(maxStop)}` : '',
    });

    // ---- 计划时效:大幅偏离(旧价格 / 笔误)最优先,其次越过止损 / 已到目标,再其次 > 3 ATR
    const drift = Math.abs(entry - last) / atr, driftPct = (entry - last) / last;
    const stale = drift > L.stale_drift_atr || Math.abs(driftPct) > L.stale_drift_pct;
    const staleText = `entry ${P(entry)} is ${(Math.abs(driftPct) * 100).toFixed(1)}% ${driftPct < 0 ? 'below' : 'above'} the last price ${P(last)} (${fx(drift, 1)} ATR), possibly a stale price or an input error; the plan does not hold at the current price`;
    const invalidated = stale ? staleText
      : (last - stop) * dir <= 0 ? `the last price ${P(last)} has already crossed the stop ${P(stop)}; the plan is invalidated`
        : valid.length && (last - valid[0]!) * dir >= 0 ? `the last price ${P(last)} has already reached target 1 at ${P(valid[0]!)}; the move this plan was aiming for has already happened`
          : '';
    gates.push({
      key: 'entry_fresh', label: 'Plan freshness', hard: true, status: !invalidated && drift <= L.max_entry_drift_atr ? 'pass' : 'fail', value: r4(drift), value_text: `entry ${fx(drift, 1)} ATR from last price`,
      threshold: `≤ ${L.max_entry_drift_atr} ATR, stop/target not crossed`,
      note: invalidated || (drift > L.max_entry_drift_atr ? `entry is more than ${L.max_entry_drift_atr} ATR from the last price, so the plan may be stale; it does not hold until price returns near the entry` : ''),
    });

    // ---- 日线状态(软)
    const regime = await deps.regime(params.symbol).catch(() => null);
    const aligned = regime && (regime.regime === 'bull' && params.side === 'long' || regime.regime === 'bear' && params.side === 'short');
    const counter = regime && (regime.regime === 'bull' && params.side === 'short' || regime.regime === 'bear' && params.side === 'long');
    gates.push({
      key: 'regime', label: 'Daily trend alignment', hard: false,
      status: !regime ? 'n/a' : aligned || regime.regime === 'range' ? 'pass' : 'warn', value: regime?.regime ?? null, value_text: regime ? `daily ${REGIME_TEXT[regime.regime] ?? regime.regime}` : '—',
      threshold: 'with trend or ranging',
      note: !regime ? 'daily regime unavailable, not checked' : counter ? `daily ${REGIME_TEXT[regime.regime]}, so this ${side} is counter-trend` : regime.regime === 'volatile' ? 'daily volatility is high; stops get hit more easily' : regime.regime === 'range' ? 'ranging market, direction-neutral' : 'with the trend',
    });

    // ---- 流动性(软)
    const qv = deps.quoteVolume24h ? await deps.quoteVolume24h(params.symbol, params.market).catch(() => null) : null;
    gates.push({
      key: 'liquidity', label: '24h volume', hard: false, status: qv === null ? 'n/a' : qv >= L.min_quote_vol_24h ? 'pass' : 'warn', value: qv === null ? null : Math.round(qv), value_text: qv === null ? '—' : `${fmtBig(qv)} USDT`,
      threshold: `≥ ${fmtBig(L.min_quote_vol_24h)} USDT`, note: qv === null ? 'not checked' : qv < L.min_quote_vol_24h ? 'low volume, higher slippage risk' : '',
    });

    const hardFail = gates.filter((g) => g.hard && g.status === 'fail');
    const warns = gates.filter((g) => g.status === 'warn');

    // ---- AI 模型:硬门槛全过才问(省钱);没绑定 / 失败 → 只看代码门槛
    let ai: JudgeResult | null = null, aiNote = '';
    if (hardFail.length) aiNote = 'hard gates failed, AI model not called';
    else if (!deps.judge) aiNote = 'AI model not connected';
    else {
      try {
        const candidate = serviceCandidate({ symbol: params.symbol, as_of, timeframe_ms: tf_ms, direction: params.side, entry, stop, target: valid[0] ?? null, reward_risk: rr });
        ai = await deps.judge(candidate, bars, `asp:plan_gate:${job.job_id}`);
        if (!ai) aiNote = 'AI model temporarily unavailable';
        else if (ai.status === 'error') aiNote = `AI model call failed (${ai.reason_codes.map((c) => REASON_TEXT[c] ?? 'call error').join(', ')})`;
      } catch { ai = null; aiNote = 'AI model call failed (call error)'; }
    }
    const aiUsed = !!ai && ai.status !== 'error';
    const yesOf = (k: string) => aiUsed ? ai!.answers.find((a) => a.question_key === k)?.probabilities['yes'] ?? null : null;
    const take = yesOf('take');

    // ---- 代码对照:同样止损 / 第一目标百分比距离,历史上目标先于止损的频率(与模型无关)
    const ref: TargetFirstRate | null = sideOk && valid.length ? targetFirstRate(refBars, params.side, risk / entry, Math.abs(valid[0]! - entry) / entry) : null;
    const feat = marketFeatures(bars, tf_ms);
    const refShort = refBars.length < BASE_RATE_BARS;
    const refText = ref
      ? `at the same distances, target 1 was hit before the stop ${pct(ref.target_first, 0)} of the time historically (breakeven needs ${pct(ref.breakeven, 0)}; ~${ref.independent} independent samples${ref.independent < MIN_INDEPENDENT_SAMPLES ? ', small sample' : ''})`
      : 'historical same-distance frequency unavailable (not enough samples)';
    const refLine = `Code reference: last ${refBars.length} closed ${params.timeframe} bars${refShort ? ` (target ${BASE_RATE_BARS}, only ${refBars.length} available)` : ''}, simulating from every close with a ${fx(risk / entry * 100)}% stop / ${valid.length ? fx(Math.abs(valid[0]! - entry) / entry * 100) : '—'}% target 1: ${refText}; `
      + `EMA ${EMA_STACK_TEXT[feat.ema_stack]} · RSI14 ${fx(feat.rsi14, 1)} · ATR ${fx(feat.atr_pct)}% (unconditional frequency across all regimes; reference only)`;

    // ---- AI 旁注(只作参考,不改结论):日线门槛过了、AI 却判状态不相容;各题答案挤在一起
    const regimeGate = gates.find((g) => g.key === 'regime')!;
    const naGates = gates.filter((g) => g.status === 'n/a');
    const regimeFit = yesOf('regime_fit');
    const regimeClash = regimeGate.status === 'pass' && regimeFit !== null && regimeFit < 0.5
      ? `the daily trend gate passed (${regimeGate.value_text}), yet the AI rates the regime incompatible at ${pct(1 - regimeFit, 0)}` : '';
    const ys = aiUsed ? ai!.answers.map((a) => a.probabilities['yes']).filter((x): x is number => x !== undefined) : [];
    const sameAnswer = ys.length > 1 && Math.max(...ys) - Math.min(...ys) <= AI_SAME_ANSWER
      ? `the AI gave nearly identical probabilities to ${ys.length} different questions, so its discrimination is limited` : '';

    // ---- 结论只由代码证据决定(09-27 负责人拍板:模型概率几乎恒定 15–35%、未校准,不再参与结论):
    // 硬门槛不过 → FAIL;全过 → 同距离历史「目标先于止损」相对盈亏平衡的余量 + 软门槛 + 未检查项决定 PASS / UNCERTAIN
    const hist = historyEvidence(ref);
    const why: { key: UncertainKey; text: string }[] = [];
    if (hist.key) why.push({ key: hist.key, text: hist.text });
    for (const g of warns) why.push({ key: 'soft_warning', text: `${g.label.toLowerCase()} flagged: ${g.note || g.value_text}` });
    for (const g of naGates) why.push({ key: 'not_checked', text: `${g.label.toLowerCase()} not checked (${g.note || 'data unavailable'})` });
    let verdict: PlanVerdict, basis: string, headline: string;
    if (hardFail.length) {
      verdict = 'fail'; basis = `hard gates failed: ${hardFail.map((g) => `${g.label}${g.note ? ` (${g.note})` : ''}`).join('; ')}`;
      headline = stale ? `entry ${P(entry)} is ${(Math.abs(driftPct) * 100).toFixed(1)}% ${driftPct < 0 ? 'below' : 'above'} the last price ${P(last)}, possibly a stale price or a typo` : `${hardFail[0]!.label}: ${hardFail[0]!.note || 'not met'}`;
    } else if (why.length) {
      verdict = 'uncertain';
      headline = `hard gates passed, but ${why.map((w) => w.text).join('; ')}`;
      basis = `hard gates passed (reward/risk ${fx(rr)}, stop ${fx(stopAtr)} ATR); code reference: ${refText}; UNCERTAIN because of the code evidence listed above, not because of the AI probability`;
    } else {
      verdict = 'pass';
      headline = `all hard gates passed and the history clears breakeven: ${hist.text}; no soft warnings`;
      basis = `all hard gates passed (reward/risk ${fx(rr)}, stop ${fx(stopAtr)} ATR); code reference: ${refText}; verdict from code evidence only`;
    }
    if (!aiUsed) basis += `; AI reference not available (${aiNote})`;
    const uncertainReasons = verdict === 'uncertain' ? why.map((w) => w.key) : [];
    // AI 与代码证据方向相反(只做标注,不改结论):代码偏正 = 无软门槛提示且历史不低于盈亏平衡;偏负 = 有软门槛提示或历史低于盈亏平衡
    const codeLeansPositive = !warns.length && hist.edge !== null && hist.edge >= 0;
    const conflict = aiUsed && verdict !== 'fail' && (ai!.action === 'follow') !== codeLeansPositive;

    // ---- 修正建议(不论结论都给)
    const fx_ = planFixes({ side: params.side, entry, stop, targets: params.targets, valid, rr, last, atr, bars, refBars, market: params.market, symbol: params.symbol, digits: d, sideOk, stale, invalidated, gates });
    const verdictDetail: 'fixable' | 'invalidated' | null = verdict !== 'fail' ? null : stale || invalidated ? 'invalidated' : 'fixable';
    const fixHead = verdict === 'fail'
      ? verdictDetail === 'invalidated' ? 'Suggested fixes / what would make it stronger (price has moved past this plan, so it needs new levels):' : 'Suggested fixes / what would make it stronger (the failed gates are fixable with the adjustments below):'
      : 'Suggested fixes / what would make it stronger:';

    // 第一行:结论 + 最该知道的一句原因(偏离过大优先)
    const summary = `Verdict: ${VERDICT_TEXT[verdict]} — ${headline} (${params.symbol} ${side} ${params.timeframe})`;
    const aiNotes = [regimeClash, sameAnswer].filter(Boolean);
    const aiLine = aiUsed
      ? `AI reference (uncalibrated, generated content): ${ai!.answers.map((a) => `${AI_NAME[a.question_key] ?? a.question_key}: ${Object.entries(a.probabilities).map(([l, p]) => `${AI_LABEL[a.question_key]?.[l] ?? l} ${pct(p, 0)}`).join(' / ')}`).join(' · ')}${aiNotes.length ? ` (${aiNotes.join('; ')})` : ''}. ${AI_DOES_NOT_DECIDE} Limits: an uncalibrated model reference, consulted only after all hard gates pass; the gate values, the same-distance history and the fixes above are the evidence`
      : `AI model not involved: ${aiNote}`;
    const lines = [
      `Last price ${P(last)} (close as of ${utcText(as_of)}) · ATR14 ${P(atr)} (${fx(atr / last * 100)}%)`,
      `Plan: ${side}, entry ${P(entry)}, stop ${P(stop)}, targets ${params.targets.length ? params.targets.map(P).join(' / ') : '—'} · ${MARKET_TEXT[params.market]} ${params.timeframe}`,
      ...gates.map((g) => `${STATUS_MARK[g.status]} ${g.label}: ${g.value_text} (required ${g.threshold})${g.note ? ` — ${g.note}` : ''}`),
      fixHead,
      ...fx_.lines.map((l) => `→ ${l}`),
      aiLine,
      refLine,
      // 依据与第一行相同就不重复
      ...(basis === headline ? [] : [`Basis: ${basis}`]),
    ];
    return deliverable(job, 'plan_gate', '[Trade Plan Gate] Trading Swarm', summary, lines, {
      verdict, verdict_text: VERDICT_TEXT[verdict], verdict_detail: verdictDetail, basis,
      verdict_evidence: {
        decided_by: 'code', uncertain_reasons: uncertainReasons, reasons_text: verdict === 'uncertain' ? why.map((w) => w.text) : [],
        history_edge_pts: hist.edge === null ? null : r4(hist.edge * 100), edge_margin_pts: PLAN_EVIDENCE.edge_margin * 100, min_independent_samples: MIN_INDEPENDENT_SAMPLES,
      }, as_of, as_of_text: utcText(as_of),
      plan: { symbol: params.symbol, side: params.side, entry: RP(entry), stop: RP(stop), targets: params.targets.map(RP), valid_targets: valid.map(RP), timeframe: params.timeframe, market: params.market },
      market_state: {
        last_close: RP(last), atr14: r4(atr), entry_drift_pct: r4(driftPct * 100), entry_drift_atr: r4(drift), stale_price_suspected: stale,
        regime: regime ? { regime: regime.regime, text: `daily ${REGIME_TEXT[regime.regime] ?? regime.regime}`, as_of: regime.as_of } : null, quote_vol_24h: qv === null ? null : Math.round(qv),
      },
      gates,
      fixes: {
        target_for_min_rr: rrPass || !sideOk || !(needTarget > 0) ? null : RP(needTarget),
        stop_at_min_atr: stopAtr < L.stop_atr_min ? RP(minStop) : null,
        stop_at_max_atr: stopAtr > L.stop_atr_max ? RP(maxStop) : null,
        structure_stop: fx_.structure_stop, suggestions: fx_.lines, alternatives: fx_.alternatives, sizing: fx_.sizing ? { ...fx_.sizing, risk_frac: SIZING_EXAMPLE.risk_frac, example_equity: SIZING_EXAMPLE.equity } : null,
      },
      code_reference: {
        bars: refBars.length, bars_target: BASE_RATE_BARS,
        target_first: ref ? { rate: r4(ref.target_first), breakeven: r4(ref.breakeven), target_hits: ref.target, stop_hits: ref.stop, timeouts: ref.timeouts, independent_samples: ref.independent, risk_pct: r4(ref.risk_pct), reward_pct: r4(ref.reward_pct), max_bars: ref.max_bars } : null,
        ema_stack: feat.ema_stack, rsi14: r4(feat.rsi14), atr_pct: r4(feat.atr_pct),
        note: 'Historical frequency of target 1 being hit before the stop at the same percentage distances; unconditional across regimes, reference only',
      },
      limits: L,
      ai_model: aiUsed
        ? { involved: true, name: 'AI model', calibrated: false, affects_verdict: false, note: AI_DOES_NOT_DECIDE, status: ai!.status, supported: ai!.action === 'follow', conflict_with_code: conflict, take_yes: r4(take), answers: ai!.answers.map((a) => ({ question_key: a.question_key, name: AI_NAME[a.question_key] ?? a.question_key, probabilities: Object.fromEntries(Object.entries(a.probabilities).map(([l, p]) => [l, r4(p)])) })) }
        : { involved: false, affects_verdict: false, note: aiNote, reason_codes: ai?.reason_codes ?? [] },
      method: `Deterministic code gates (stop side / weighted reward-risk / ATR stop distance / plan freshness / daily regime / liquidity). Any failed hard gate yields FAIL. When all hard gates pass, the verdict comes from code evidence only: PASS when the historical same-distance rate of target 1 before the stop clears breakeven by at least ${PLAN_EVIDENCE.edge_margin * 100} points on at least ${MIN_INDEPENDENT_SAMPLES} independent samples with no soft warning and no unchecked gate; otherwise UNCERTAIN with the reasons listed. The AI model is consulted only after all hard gates pass, is uncalibrated, and never changes the verdict`,
    }, { ai: aiUsed });
  },
};
