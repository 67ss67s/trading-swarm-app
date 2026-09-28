// Code-side gates + sizing (docs/demo/README.md §5.6–5.7). The model never sees or sets these.

import { DEFAULT_EXECUTION_THRESHOLDS, stopGeometry, stopGeometryReason, type StopFloorMode, type StopFloorTf } from './execution-policy.js';
import { TIER_LABEL, type AccountView, type GateResult, type Judgment, type MarketView, type Sizing, type Tier, type TierPolicy } from './types.js';

export interface GateConfig {
  risk_pct: number; // % of equity at risk per trade
  max_notional_multiple: number; // notional ≤ equity × this
  max_opens_per_day: number;
  min_stop_pct: number;
  max_stop_pct: number;
  /** §9.56 ATR 止损下限(×stop_floor_atr_tf 那根的 ATR14),只在 atr 模式生效。实盘由 runtime 从 workflow 读(executionThresholds)。 */
  min_stop_atr?: number;
  /** §9.56 止损底线模式;不传时按数值推断(只给了 min_stop_pct = 百分比;两个都给 = 老配置,两条都判)。 */
  stop_floor_mode?: StopFloorMode;
  stop_floor_atr_tf?: StopFloorTf;
}

export const DEFAULT_GATES: GateConfig = {
  risk_pct: 0.5,
  max_notional_multiple: 3,
  max_opens_per_day: 2,
  // 止损距离的默认值取自 execution-policy.ts,和 workflow 的默认值是同一份;运行时用 workflow 里的当前值。
  min_stop_pct: DEFAULT_EXECUTION_THRESHOLDS.min_stop_pct,
  max_stop_pct: DEFAULT_EXECUTION_THRESHOLDS.max_stop_pct,
};

export interface GateContext {
  markets?: import('./types.js').Market[];
  halted: boolean;
  paused: boolean;
  account: AccountView;
  market: MarketView;
  opens_today: number;
  stale_refs: Set<string>;
  /** Judgment time; when given, an opening action is refused if the market snapshot itself is older than MARKET_STALE_MS. */
  now?: number;
  /**
   * 09-12 §2 分层闸(docs/design/attribution-and-tiers-2026-09-12.md §2.3)。
   * **不传 = 一行闸都不多**(旧调用与旧测试逐字不受影响);传了且是开仓动作才判。
   * `opens_today` / `open_threads` 是**本层**的计数,不是全局的。
   */
  tier?: { tier: Tier; opens_today: number; open_threads: number; policy: TierPolicy };
  /**
   * §9.56 stop_floor_atr_tf 那根的 ATR14(价格单位)。百分比模式只用来显示;ATR 模式没传或传 null =
   * 取不到 ATR,改按百分比判并在原因里写明。老配置(两条都判)下不传就不加「止损ATR下限」这一行。
   */
  atr?: number | null;
}

/**
 * 分层闸:每层独立的每日开仓 / 容量 / 入场方式。每个字段 `0` 或空数组 = 本层不额外限制,
 * 这一行就直接 `passed: true` 写「本层不限」——**闸的行数不随配置变化**,否则
 * 「今天为什么少了一行闸」会变成另一个黑盒。
 */
export function tierGates(j: Judgment, tier: NonNullable<GateContext['tier']>): GateResult[] {
  const label = TIER_LABEL[tier.tier];
  const p = tier.policy;
  const dailyCap = p.max_opens_per_day;
  const capCap = p.max_open_threads;
  const styles = p.entry_styles;
  const entry = j.proposal?.entry ?? null;
  return [
    {
      name: `${label}每日开仓上限`,
      passed: !(dailyCap > 0 && tier.opens_today >= dailyCap),
      reason: dailyCap > 0 ? `${label}今日已开 ${tier.opens_today}/${dailyCap}` : `${label}未设每日上限(继承全局)`,
    },
    {
      name: `${label}容量上限`,
      passed: !(capCap > 0 && tier.open_threads >= capCap),
      reason: capCap > 0 ? `${label}在手 ${tier.open_threads}/${capCap} 条线程` : `${label}未设容量上限(继承全局)`,
    },
    {
      name: `${label}入场方式`,
      passed: !(styles.length > 0 && entry !== null && !styles.includes(entry)),
      reason: styles.length === 0 ? `${label}不限入场方式` : entry === null ? '不适用' : `${label}只允许 ${styles.join('/')},这次是 ${entry}`,
    },
  ];
}

/** A mark/price snapshot older than this cannot back a new position (same window as context.ts STALE_MS). */
export const MARKET_STALE_MS = 3 * 60_000;

export function evaluateGates(j: Judgment, ctx: GateContext, cfg: GateConfig = DEFAULT_GATES): GateResult[] {
  const out: GateResult[] = [];
  const opening = j.action === 'PROPOSE' || j.action === 'ADD';
  if (opening && j.proposal?.market === 'spot') out.push({name:'spot_no_short',passed:j.proposal.direction === 'long',reason:j.proposal.direction === 'long' ? '现货买入' : 'spot_no_short'});
  if (opening && ctx.markets) out.push({name:'market_not_enabled',passed:ctx.markets.includes(j.proposal?.market ?? 'perp'),reason:ctx.markets.includes(j.proposal?.market ?? 'perp') ? '市场已启用' : 'market_not_enabled'});
  out.push({ name: '紧急停止', passed: !(ctx.halted && opening), reason: ctx.halted ? '系统紧急停止中,不允许开仓' : '未触发' });
  out.push({ name: '暂停', passed: !(ctx.paused && opening), reason: ctx.paused ? '已暂停,不开新仓' : '运行中' });
  // Two ways to be stale: the judgment cites an evidence line marked STALE, or the market snapshot the
  // sizing/entry would use is itself old (eval's stale variants showed a PROPOSE can cite only kline
  // evidence and slip past a citation-only check — 2026-09-05 holdout run).
  const snapshotAge = ctx.now !== undefined ? ctx.now - ctx.market.as_of : 0;
  const snapshotStale = snapshotAge > MARKET_STALE_MS;
  const citesStale = j.evidence_refs.some((r) => ctx.stale_refs.has(r));
  out.push({
    name: '证据新鲜度',
    passed: !(opening && (citesStale || snapshotStale)),
    reason: !opening ? '不适用' : snapshotStale ? `行情快照已过期 ${Math.round(snapshotAge / 1000)} 秒,开仓不能用旧价` : citesStale ? '开仓判断不能引用过期证据' : '证据与行情都新鲜',
  });
  if (j.action === 'PROPOSE') {
    out.push({ name: '无持仓才能开仓', passed: ctx.account.positions.length === 0, reason: ctx.account.positions.length ? '已有持仓' : '当前无持仓' });
    out.push({ name: '每日开仓上限', passed: ctx.opens_today < cfg.max_opens_per_day, reason: `今日已开 ${ctx.opens_today}/${cfg.max_opens_per_day}` });
    const p = j.proposal;
    if (p) {
      const mark = Number(ctx.market.mark);
      const optionalStop = p.market === 'spot' && p.stop_price === null;
      const stop = Number(p.stop_price);
      // A marketable limit fills near mark, so judge the stop against the worse of the two prices.
      const lim = p.entry === 'limit' && p.limit_price ? Number(p.limit_price) : null;
      const ref = lim === null ? mark : p.direction === 'long' ? Math.min(lim, mark) : Math.max(lim, mark);
      const sideOk = p.direction === 'long' ? stop < ref : stop > ref;
      // 止损底线走执行层同一个判定(回测 / 预检 / 发送前复查同一套,execution-policy.ts);ctx.atr 是 stop_floor_atr_tf 那根的 ATR
      const th = { ...DEFAULT_EXECUTION_THRESHOLDS, stop_floor_mode: cfg.stop_floor_mode, stop_floor_atr_tf: cfg.stop_floor_atr_tf, min_stop_pct: cfg.min_stop_pct, max_stop_pct: cfg.max_stop_pct, min_stop_atr: cfg.min_stop_atr ?? 0 };
      const geo = stopGeometry(ref, stop, ctx.atr ?? null, th);
      out.push({ name: '止损在正确一侧', passed: optionalStop || sideOk, reason: optionalStop ? '现货,无止损(可选)' : sideOk ? `${p.direction === 'long' ? '做多止损低于' : '做空止损高于'}入场价` : `止损 ${p.stop_price} 在入场价 ${ref.toFixed(1)} 的错误一侧`, code: 'stop_side' });
      const floorBlock = geo.blocks.find((b) => b === 'stop_distance' || b === 'stop_atr');
      const wide = geo.blocks.includes('stop_too_wide');
      if (geo.mode === 'atr') {
        // ATR 模式:底线一行(stop_atr;ATR 取不到改按百分比时记 stop_distance),上限另一行
        out.push({ name: geo.atr_fallback ? '止损距离' : '止损ATR下限', passed: optionalStop || !floorBlock, reason: optionalStop ? '现货,无止损(可选)' : stopGeometryReason(geo, th), code: geo.atr_fallback ? 'stop_distance' : 'stop_atr' });
        if (!geo.atr_fallback) out.push({ name: '止损距离', passed: optionalStop || !wide, reason: optionalStop ? '现货,无止损(可选)' : `${geo.stop_pct.toFixed(2)}%(上限 ${cfg.max_stop_pct}%)`, code: 'stop_too_wide' });
        else if (wide) out.push({ name: '止损距离', passed: optionalStop, reason: optionalStop ? '现货,无止损(可选)' : `${geo.stop_pct.toFixed(2)}%(上限 ${cfg.max_stop_pct}%)`, code: 'stop_too_wide' });
      } else {
        const pctBlock = geo.blocks.find((b) => b === 'stop_distance' || b === 'stop_too_wide');
        out.push({ name: '止损距离', passed: optionalStop || !pctBlock, reason: optionalStop ? '现货,无止损(可选)' : `${geo.stop_pct.toFixed(2)}%(允许 ${cfg.min_stop_pct}%–${cfg.max_stop_pct}%)`, code: pctBlock ?? 'stop_distance' });
        // 老配置(百分比和 ATR 两条都判)才有这一行
        if (geo.mode === 'both' && ctx.atr !== undefined) {
          const k = cfg.min_stop_atr ?? 0, atrOk = optionalStop || !geo.blocks.includes('stop_atr');
          out.push({ name: '止损ATR下限', passed: atrOk, code: 'stop_atr',
            reason: optionalStop ? '现货,无止损(可选)' : geo.stop_atr === null ? `ATR 不可用,不判(百分比下限 ${cfg.min_stop_pct}% 仍生效)` : `止损 ${geo.stop_atr.toFixed(2)}×ATR(需 ≥ ${k}×ATR ≈ ${(k * ctx.atr! / ref * 100).toFixed(2)}%)` });
        }
      }
      if (p.take_profit_price) {
        const tp = Number(p.take_profit_price);
        const tpOk = p.direction === 'long' ? tp > ref : tp < ref;
        out.push({ name: '止盈在正确一侧', passed: tpOk, reason: tpOk ? '通过' : `止盈 ${p.take_profit_price} 方向不对` });
      }
    }
    out.push({ name: '信心下限', passed: j.confidence >= 0.4, reason: `信心 ${j.confidence.toFixed(2)}(需 ≥ 0.40)` });
    // 分层闸只在开仓提议上判;不传 tier 上下文 = 这套闸没接线,一行都不加。
    if (ctx.tier) out.push(...tierGates(j, ctx.tier));
  }
  if (j.action === 'ADD') out.push({ name: '演示版不加仓', passed: false, reason: '演示版只记录 ADD 建议,不执行' });
  return out;
}

/**
 * 「没有状态不明的订单」闸。原本是 runtime 里的一行内联判断,抽成纯函数只为让 eval 能给它造用例
 * (docs/eval/gate-coverage-2026-09-12.md);判定与文案一字未改。
 */
export function unknownOrderGate(hasUnknownIntent: boolean): GateResult {
  return { name: '没有状态不明的订单', passed: !hasUnknownIntent, reason: hasUnknownIntent ? '有一笔订单状态不明,先核对再开新仓' : '通过' };
}

export interface SymbolRules {
  step_size: string;
  tick_size: string;
  min_qty: string;
  min_notional: string;
}

function floorToStep(qty: number, step: string): string {
  const s = Number(step);
  if (!(s > 0)) return qty.toString();
  const decimals = Math.max(0, (step.split('.')[1] ?? '').replace(/0+$/, '').length);
  const floored = Math.floor(qty / s + 1e-9) * s;
  return floored.toFixed(decimals);
}

export function computeSizing(j: Judgment, account: AccountView, market: MarketView, rules: SymbolRules, cfg: GateConfig = DEFAULT_GATES, options: { agent?: Sizing['agent']; liquidity_notional_cap?: number; fixed_qty?: string } = {}): { qty: string; sizing: Sizing; ok: boolean } {
  const p = j.proposal!;
  const equity = Number(account.equity);
  const lim = p.entry === 'limit' && p.limit_price ? Number(p.limit_price) : null;
  const mark = Number(market.mark);
  const ref = lim === null ? mark : p.direction === 'long' ? Math.max(lim, mark) : Math.min(lim, mark);
  const notionalRef = lim === null ? mark : Math.max(lim, mark);
  const minimumRef = lim === null ? mark : Math.min(lim, mark);
  // 无止损现货按整仓本金承担风险，不虚构止损价格。
  const stopDist = p.market === 'spot' && p.stop_price === null ? ref : Math.abs(ref - Number(p.stop_price));
  const agent = options.agent;
  const multiplier = agent?.applied && Number.isFinite(agent.multiplier) && agent.multiplier >= 0.25 && agent.multiplier <= 2 ? agent.multiplier : 1;
  const overshoot = agent?.applied === true && agent.overshoot === true;
  const riskUsdt = (equity * cfg.risk_pct * multiplier) / 100;
  let rawQty = stopDist > 0 ? riskUsdt / stopDist : 0;
  const notes: string[] = [];
  const maxNotional = equity * cfg.max_notional_multiple;
  if (rawQty * notionalRef > maxNotional) {
    rawQty = maxNotional / notionalRef;
    notes.push(`名义超过权益×${cfg.max_notional_multiple},按上限钳制`);
  }
  const minNotional = Number(rules.min_notional || '0');
  if (minNotional > 0 && rawQty * minimumRef < minNotional) {
    rawQty = (minNotional * 1.02) / minimumRef;
    notes.push(`低于交易所最小名义 ${minNotional} USDT,抬到最小名义(实际风险 ${(rawQty * stopDist).toFixed(2)} USDT)`);
  }
  const liquidityCap = options.liquidity_notional_cap ?? Infinity;
  if (rawQty * notionalRef > liquidityCap) {
    rawQty = Math.max(0, liquidityCap) / notionalRef;
    notes.push('按24h成交量流动性上限钳制');
  }
  if (overshoot) {
    const step = Number(rules.step_size);
    const minimum = Math.ceil(Math.max(Number(rules.min_qty), minNotional / minimumRef) / step - 1e-9) * step;
    rawQty = Math.max(Math.min(rawQty, riskUsdt / stopDist), minimum);
  }
  let qty = floorToStep(rawQty, rules.step_size);
  // Flooring can drop the notional back under the exchange minimum; step up once if so.
  if (minNotional > 0 && Number(qty) * minimumRef < minNotional) {
    const step = Number(rules.step_size) || 0;
    const decimals = Math.max(0, (rules.step_size.split('.')[1] ?? '').replace(/0+$/, '').length);
    qty = (Number(qty) + step).toFixed(decimals);
  }
  if (options.fixed_qty !== undefined) qty = options.fixed_qty;
  const minLot = Math.ceil(Math.max(Number(rules.min_qty), minNotional / minimumRef) / Number(rules.step_size) - 1e-9) * Number(rules.step_size);
  const riskTolerance = overshoot && Number(qty) <= minLot + 1e-9 ? 2 : 1.05;
  let ok = Number(qty) >= Number(rules.min_qty || '0') && Number(qty) > 0;
  if (!ok) notes.push('数量低于交易所最小下单量');
  if (ok && Number(qty) * minimumRef < minNotional) { ok = false; notes.push('低于交易所最小名义，拒单'); }
  if (ok && Number(qty) * notionalRef > maxNotional * 1.0001) {
    ok = false;
    notes.push(`交易所最小名义 ${minNotional} 高于本地名义上限 ${maxNotional.toFixed(2)},拒单`);
  }
  if (ok && (!Number.isFinite(Number(qty)) || !Number.isFinite(riskUsdt) || !(equity > 0) || !(stopDist > 0) || !(ref > 0) || !(liquidityCap > 0) || Number(qty) * notionalRef > liquidityCap)) {
    ok = false;
    notes.push('流动性上限或 sizing 数据不可用，拒单');
  }
  if (ok && Number(qty) * stopDist > riskUsdt * riskTolerance + 1e-9) {
    ok = false;
    const actualRisk = Number(qty) * stopDist;
    const neededEquity = Math.ceil((actualRisk * 100 / (cfg.risk_pct * multiplier)) * 100 - 1e-9) / 100;
    notes.push(`最小下单量风险 ${actualRisk.toFixed(2)} U > 预算 ${riskUsdt.toFixed(2)} U;要 ${neededEquity} U 权益才能按 ${cfg.risk_pct}% 做 ${market.symbol}(容差 ${riskTolerance === 2 ? '100%' : '5%'},拒单)`);
  }
  return {
    qty,
    ok,
    sizing: {
      ...(agent ? { agent } : {}),
      equity: equity.toFixed(2),
      risk_pct: cfg.risk_pct.toString(),
      risk_usdt: riskUsdt.toFixed(2),
      stop_distance: stopDist.toFixed(2),
      raw_qty: rawQty.toFixed(6),
      step_size: rules.step_size,
      note: notes.join(';') || (p.market === 'spot' && p.stop_price === null
        ? `现货,无止损(可选);整仓预算 ${riskUsdt.toFixed(2)} USDT ÷ 单价 ${ref.toFixed(2)} = ${rawQty.toFixed(4)}`
        : `风险 ${riskUsdt.toFixed(2)} USDT ÷ 止损距离 ${stopDist.toFixed(2)} = ${rawQty.toFixed(4)}`),
    },
  };
}
