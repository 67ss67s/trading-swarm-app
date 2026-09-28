/**
 * 执行层(契约 §9.56):所有机会来源(AI 扫盘 / 策略运行 / 订阅信号)共用的一套代码阈值。
 *
 * 这里是**唯一**的阈值读取与几何判定入口:
 *  - `executionThresholds(workflow)`:止损距离上下限 / ATR 止损下限 / 净盈亏比 / 往返成本预算,
 *    实盘开仓闸(gates.ts)、持仓计划(holding-policy.ts)、策略运行净RR闸(runtime)、运行预检(strategy-run.ts)
 *    和研究回测(research/)都从这里读,不各自写死。
 *  - `stopGeometry` / `netRrCheck`:同一套判定,回测、预检、实盘发送前重闸三处算出同一个结论。
 *
 * 纯函数:只依赖十进制工具与类型,不做 I/O,研究引擎可以直接引用。
 */
import { capacityDecimal as D } from './capacity-decimal.js';
import type { Direction, GateResult, Workflow } from './types.js';

declare module './types.js' {
  interface Workflow {
    /** §9.56 执行层:止损底线按百分比(pct)还是按 ATR(atr)算。缺省 pct。 */
    stop_floor_mode?: StopFloorMode;
    /** §9.56 执行层:ATR 模式用哪个周期的 ATR14。缺省 1h。 */
    stop_floor_atr_tf?: StopFloorTf;
    /** §9.56 执行层:止损距离下限(% of 入场价),只在 pct 模式生效。缺省 1.0(09-27 起,原 0.3)。 */
    min_stop_pct?: number;
    /** §9.56 执行层:止损距离上限(%),两种模式都生效。缺省 5。 */
    max_stop_pct?: number;
    /** §9.56 执行层:止损至少 k × stop_floor_atr_tf 那根的 ATR14,只在 atr 模式生效;0 = 关闭。缺省 1.0。 */
    min_stop_atr?: number;
    /** §9.56 执行层:净盈亏比下限(扣往返成本)。缺省 1.5。 */
    min_net_rr?: number;
  }
  interface GateResult {
    /** §9.56 结构化原因码(漏斗 top_reasons 用);旧 episode 没有,读的时候回退按闸名归类。 */
    code?: string;
  }
}

export type StopFloorMode = 'pct' | 'atr';
export type StopFloorTf = '15m' | '1h' | '4h';
export const STOP_FLOOR_MODES: readonly StopFloorMode[] = ['pct', 'atr'];
export const STOP_FLOOR_ATR_TFS: readonly StopFloorTf[] = ['15m', '1h', '4h'];
const TF_MINUTES: Record<StopFloorTf, number> = { '15m': 15, '1h': 60, '4h': 240 };

export interface ExecutionThresholds {
  /**
   * 止损底线的算法。workflow 读出来的一定有;研究回测冻结的快照(契约 ExecutionGateThresholds)没有这个字段,
   * 按数值推断:min_stop_atr=0 → 只看百分比;min_stop_pct=0 → 只看 ATR;两个都 >0 → 09-27 之前的老快照,两条都判(逐字重放)。
   */
  stop_floor_mode?: StopFloorMode;
  /** ATR 模式用的周期;快照里没有(回测用的是信号周期的 ATR,见 researchThresholds)。 */
  stop_floor_atr_tf?: StopFloorTf;
  min_stop_pct: number;
  max_stop_pct: number;
  min_stop_atr: number;
  min_net_rr: number;
  /** 算净盈亏比时扣的来回手续费和滑点,单位 bps,十进制字符串。和持仓计划的 round_trip_cost_bps 是同一个数。 */
  round_trip_cost_bps: string;
}

/**
 * 09-27 调整(Jacky):参照带单员 72 笔开仓,止损中位 1.72%、一半在 1.3%–2.3%,约合 2.3×1h ATR / 1×4h ATR。
 * 原来 0.3% 的底线太窄,改成 1%;ATR 模式默认 1×1h ATR。
 */
export const DEFAULT_EXECUTION_THRESHOLDS: ExecutionThresholds = { stop_floor_mode: 'pct', stop_floor_atr_tf: '1h', min_stop_pct: 1, max_stop_pct: 5, min_stop_atr: 1, min_net_rr: 1.5, round_trip_cost_bps: '12' };
/** 旧默认值,只给一次性迁移认「没人改过」用。 */
export const LEGACY_EXECUTION_DEFAULTS = { min_stop_pct: 0.3, min_stop_atr: 0.5 } as const;

/**
 * 人工可调区间([min, max, step])与 agent 在模拟盘可直改的子区间。
 * 数值区间同时是 applyWorkflowPatch 的校验边界(workflow.ts 引用这里,不另写一份)。
 */
export const EXECUTION_NUMERIC_BOUNDS = {
  risk_pct: { min: 0.1, max: 2, step: 0.05, agent_direct_min: 0.1, agent_direct_max: 2 },
  leverage: { min: 1, max: 10, step: 1, agent_direct_min: 1, agent_direct_max: 10 },
  min_stop_pct: { min: 0.2, max: 5, step: 0.05, agent_direct_min: 0.5, agent_direct_max: 3 },
  max_stop_pct: { min: 1, max: 15, step: 0.5, agent_direct_min: 2, agent_direct_max: 10 },
  min_stop_atr: { min: 0, max: 3, step: 0.1, agent_direct_min: 0.3, agent_direct_max: 2 },
  min_net_rr: { min: 0.5, max: 5, step: 0.1, agent_direct_min: 1.2, agent_direct_max: 3 },
  max_open_threads: { min: 1, max: 20, step: 1, agent_direct_min: 1, agent_direct_max: 10 },
  max_opens_per_day: { min: 1, max: 50, step: 1, agent_direct_min: 1, agent_direct_max: 20 },
  daily_loss_stop_pct: { min: 0.5, max: 20, step: 0.5, agent_direct_min: 1, agent_direct_max: 10 },
} as const;
export const EXECUTION_ENUM_BOUNDS = {
  margin_mode: { values: ['cross', 'isolated'], agent_direct_values: ['cross', 'isolated'] },
  sizing_agent: { values: ['off', 'advise', 'apply'], agent_direct_values: ['off', 'advise', 'apply'] },
  stop_floor_mode: { values: ['pct', 'atr'], agent_direct_values: ['pct', 'atr'] },
  stop_floor_atr_tf: { values: ['15m', '1h', '4h'], agent_direct_values: ['15m', '1h', '4h'] },
} as const;
export type ExecutionNumericKey = keyof typeof EXECUTION_NUMERIC_BOUNDS;
export type ExecutionEnumKey = keyof typeof EXECUTION_ENUM_BOUNDS;
export type ExecutionPolicyKey = ExecutionNumericKey | ExecutionEnumKey;
export const EXECUTION_POLICY_KEYS: ExecutionPolicyKey[] = ['risk_pct', 'leverage', 'margin_mode', 'stop_floor_mode', 'stop_floor_atr_tf', 'min_stop_pct', 'max_stop_pct', 'min_stop_atr', 'min_net_rr', 'max_open_threads', 'max_opens_per_day', 'daily_loss_stop_pct', 'sizing_agent'];
/** 整数键(杠杆、上限):非整数直接报错,不四舍五入。 */
const INTEGER_KEYS = new Set<ExecutionPolicyKey>(['leverage', 'max_open_threads', 'max_opens_per_day']);

const finiteIn = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** 读 workflow 的执行层阈值;缺字段 / 手改坏 / 越界 → 回缺省(不回一个更松的数)。 */
export function executionThresholds(w: Partial<Pick<Workflow, 'stop_floor_mode' | 'stop_floor_atr_tf' | 'min_stop_pct' | 'max_stop_pct' | 'min_stop_atr' | 'min_net_rr'>> | null | undefined): ExecutionThresholds {
  const b = EXECUTION_NUMERIC_BOUNDS, d = DEFAULT_EXECUTION_THRESHOLDS;
  const min = finiteIn(w?.min_stop_pct, b.min_stop_pct.min, b.min_stop_pct.max) ? w!.min_stop_pct! : d.min_stop_pct;
  const maxRaw = finiteIn(w?.max_stop_pct, b.max_stop_pct.min, b.max_stop_pct.max) ? w!.max_stop_pct! : d.max_stop_pct;
  return {
    stop_floor_mode: w?.stop_floor_mode === 'atr' ? 'atr' : 'pct',
    stop_floor_atr_tf: (STOP_FLOOR_ATR_TFS as readonly string[]).includes(String(w?.stop_floor_atr_tf)) ? w!.stop_floor_atr_tf! : d.stop_floor_atr_tf!,
    min_stop_pct: min,
    // 上下限颠倒(手改库)时按缺省上限,不能让一个区间把所有单都放过或都拒掉而没人知道为什么
    max_stop_pct: maxRaw > min ? maxRaw : Math.max(d.max_stop_pct, min * 2),
    min_stop_atr: finiteIn(w?.min_stop_atr, b.min_stop_atr.min, b.min_stop_atr.max) ? w!.min_stop_atr! : d.min_stop_atr,
    min_net_rr: finiteIn(w?.min_net_rr, b.min_net_rr.min, b.min_net_rr.max) ? w!.min_net_rr! : d.min_net_rr,
    round_trip_cost_bps: d.round_trip_cost_bps,
  };
}

/**
 * 持仓计划/净RR 闸用的下限:执行层是底线,旧策略库显式参数只能更严(取 max),不能把底线调低。
 * (§9.54 起旧策略库退出开仓,实际上只剩执行层这一个来源;保留这条是为了已存在的计划可复现。)
 */
export function effectiveMinNetRr(th: ExecutionThresholds, strategyParam: unknown): number {
  const s = Number(strategyParam);
  return strategyParam !== undefined && strategyParam !== null && Number.isFinite(s) && s > th.min_net_rr ? s : th.min_net_rr;
}

// ------------------------------------------------------------------ 几何判定(回测 / 预检 / 实盘同一套)

export type ExecutionBlock = 'stop_distance' | 'stop_atr' | 'stop_too_wide' | 'min_net_rr';
export const EXECUTION_BLOCKS: ExecutionBlock[] = ['stop_distance', 'stop_atr', 'stop_too_wide', 'min_net_rr'];

/** 这套阈值实际按哪种算法判止损底线。'both' 只会出现在 09-27 之前冻结的回测快照里。 */
export function floorModeOf(th: ExecutionThresholds): StopFloorMode | 'both' {
  if (th.stop_floor_mode === 'pct' || th.stop_floor_mode === 'atr') return th.stop_floor_mode;
  if (th.min_stop_atr > 0 && th.min_stop_pct > 0) return 'both';
  return th.min_stop_atr > 0 ? 'atr' : 'pct';
}

/** ATR 模式下取不到 ATR 时改按的百分比:阈值里有就用它,没有(回测快照里是 0)就用默认 1%。 */
export function atrFallbackPct(th: ExecutionThresholds): number {
  return th.min_stop_pct > 0 ? th.min_stop_pct : DEFAULT_EXECUTION_THRESHOLDS.min_stop_pct;
}

export interface StopGeometry {
  /** 止损距离占参考价的百分比 */
  stop_pct: number;
  /** 止损距离是几个 ATR;没给 ATR = null */
  stop_atr: number | null;
  /** 实际生效的止损下限(折成百分比);ATR 模式关闭(k=0)时是 0 */
  effective_min_pct: number;
  mode: StopFloorMode | 'both';
  /** ATR 模式但这次没有 ATR,改按百分比判了 */
  atr_fallback: boolean;
  blocks: ExecutionBlock[];
}

/**
 * 止损底线判定。AI 扫盘开仓检查、策略运行、订阅信号、发送前复查、策略运行预检、研究回测都走这一个函数。
 * ref = 参考入场价(限价单用对自己更不利的那个价,由调用方决定);atr = stop_floor_atr_tf 那根的 ATR14,和 ref 同单位。
 *  - pct 模式:只看 min_stop_pct,ATR 只用来显示倍数;
 *  - atr 模式:只看 min_stop_atr × ATR,百分比下限不生效;ATR 取不到时改按百分比判(atr_fallback);
 *  - 老快照(两个都 >0):两条都判,和 09-27 之前一样;
 *  - max_stop_pct 任何模式都判。
 */
export function stopGeometry(ref: number, stop: number, atr: number | null | undefined, th: ExecutionThresholds): StopGeometry {
  const dist = Math.abs(ref - stop), pct = ref > 0 ? (dist / ref) * 100 : 0;
  const atrOk = typeof atr === 'number' && Number.isFinite(atr) && atr > 0 && ref > 0;
  const atrMult = atrOk ? dist / atr! : null;
  const atrPct = atrOk && th.min_stop_atr > 0 ? (th.min_stop_atr * atr! / ref) * 100 : 0;
  const mode = floorModeOf(th), blocks: ExecutionBlock[] = [];
  let floor = 0, fallback = false;
  // 1e-9 容差:浮点把「刚好等于下限」算成略小于,不能因此拒单
  if (mode === 'pct') {
    floor = th.min_stop_pct;
    if (pct + 1e-9 < floor) blocks.push('stop_distance');
  } else if (mode === 'atr') {
    if (th.min_stop_atr <= 0) floor = 0;
    else if (atrMult === null) {
      fallback = true;
      floor = atrFallbackPct(th);
      if (pct + 1e-9 < floor) blocks.push('stop_distance');
    } else {
      floor = atrPct;
      if (atrMult + 1e-9 < th.min_stop_atr) blocks.push('stop_atr');
    }
  } else {
    floor = Math.max(th.min_stop_pct, atrPct);
    if (pct + 1e-9 < th.min_stop_pct) blocks.push('stop_distance');
    if (atrMult !== null && th.min_stop_atr > 0 && atrMult + 1e-9 < th.min_stop_atr) blocks.push('stop_atr');
  }
  if (pct - 1e-9 > th.max_stop_pct) blocks.push('stop_too_wide');
  return { stop_pct: pct, stop_atr: atrMult, effective_min_pct: floor, mode, atr_fallback: fallback, blocks };
}

/** 某个币当前实际的最小止损百分比(stop_conversions / 提示词用)。ATR 模式没有 ATR 时返回 null。 */
export function stopFloorPct(th: ExecutionThresholds, atr: number | null | undefined, price: number): number | null {
  const mode = floorModeOf(th);
  if (mode === 'pct') return th.min_stop_pct;
  const atrPct = typeof atr === 'number' && Number.isFinite(atr) && atr > 0 && price > 0 ? (atr / price) * 100 : null;
  if (mode === 'atr') return th.min_stop_atr <= 0 ? 0 : atrPct === null ? null : th.min_stop_atr * atrPct;
  return Math.max(th.min_stop_pct, atrPct === null ? 0 : th.min_stop_atr * atrPct);
}

const fmtPct = (n: number) => `${n.toFixed(2)}%`;
const atrLabel = (th: ExecutionThresholds) => (th.stop_floor_atr_tf ? `${th.stop_floor_atr_tf} ATR` : 'ATR');

/** 阈值的一句话说明,预检/回测警告里用。 */
export function thresholdsText(th: ExecutionThresholds): string {
  const mode = floorModeOf(th);
  const floor = mode === 'pct' ? `止损 ${th.min_stop_pct}%–${th.max_stop_pct}%`
    : mode === 'atr' ? (th.min_stop_atr > 0 ? `止损 ≥${th.min_stop_atr}×${atrLabel(th)} 且 ≤${th.max_stop_pct}%` : `止损 ≤${th.max_stop_pct}%(ATR 下限已关闭)`)
      : `止损 ${th.min_stop_pct}%–${th.max_stop_pct}%、≥${th.min_stop_atr}×ATR`;
  return `${floor}、净RR≥${th.min_net_rr}`;
}

/**
 * 研究回测要冻结的阈值快照。契约 ExecutionGateThresholds 只有 5 个数,没有模式和周期字段,所以按数值表达模式:
 *  - pct 模式 → min_stop_atr 记 0;
 *  - atr 模式 → min_stop_pct 记 0,min_stop_atr 换算到回测周期:回测只有信号周期的 ATR,
 *    按波动随时间开根号放大的经验关系折算(1×1h ATR ≈ 2×15m ATR,≈ 0.5×4h ATR),保留计算精度,避免把正数下限舍入成 0。
 * 已经是快照(没有 stop_floor_mode)的原样返回 5 个字段。
 */
export function researchThresholds(th: ExecutionThresholds, timeframeMs: number | null | undefined) {
  const base = { min_stop_pct: th.min_stop_pct, max_stop_pct: th.max_stop_pct, min_stop_atr: th.min_stop_atr, min_net_rr: th.min_net_rr, round_trip_cost_bps: th.round_trip_cost_bps };
  if (!th.stop_floor_mode) return base;
  if (th.stop_floor_mode === 'pct') return { ...base, min_stop_atr: 0 };
  const floorMin = TF_MINUTES[th.stop_floor_atr_tf ?? '1h'] ?? 60, tfMin = timeframeMs && timeframeMs > 0 ? timeframeMs / 60_000 : floorMin;
  const k = th.min_stop_atr > 0 ? th.min_stop_atr * Math.sqrt(floorMin / tfMin) : 0;
  return { ...base, min_stop_pct: 0, min_stop_atr: Math.min(100, k) };
}

/** 给模型看的止损底线(规则 5 和计划证据里用)。atrPct = 本币 stop_floor_atr_tf 的 ATR 占价格的百分比。 */
export function renderStopFloor(th: ExecutionThresholds, atrPct: number | null, symbol?: string): string {
  const mode = floorModeOf(th), coin = symbol ? symbol.replace(/USDT$/, '') : '本币';
  if (mode === 'atr' && th.min_stop_atr > 0) {
    const now = atrPct !== null && atrPct > 0 ? `当前 ${coin}≈${fmtPct(th.min_stop_atr * atrPct)}` : `${coin} 的 ${atrLabel(th)} 暂时取不到,代码会改按 ${fmtPct(atrFallbackPct(th))} 判`;
    return `止损至少 ${th.min_stop_atr}×${atrLabel(th)}(${now}),不超过 ${th.max_stop_pct}%`;
  }
  if (mode === 'atr') return `止损不超过 ${th.max_stop_pct}%(ATR 下限已关闭)`;
  return `止损至少 ${fmtPct(th.min_stop_pct)},不超过 ${th.max_stop_pct}%`;
}

/** 净盈亏比:扣往返成本后的 reward/risk。十进制有理数计算(与持仓计划同一实现)。 */
export function holdingEconomics(side: Direction, entry: string, stop: string, target: string | null, costBps = '12') {
  const price = (v: unknown): v is string => typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) && D(v).cmp(D('0')) > 0;
  if (![entry, stop].every(price) || !target || !price(target) || !/^\d+(\.\d+)?$/.test(costBps)) return null;
  const e = D(entry), s = D(stop), tp = D(target), risk = side === 'long' ? e.sub(s) : s.sub(e), reward = side === 'long' ? tp.sub(e) : e.sub(tp);
  if (risk.cmp(D('0')) <= 0 || reward.cmp(D('0')) <= 0) return null;
  const costs = e.max(tp).mul(D(costBps)).div(D('10000'));
  const netReward = reward.sub(costs), netRisk = risk.add(costs);
  return { gross_rr: reward.div(risk).text(), net_rr: netReward.cmp(D('0')) > 0 ? netReward.div(netRisk).text() : '0', cost_per_unit: costs.text(), net_risk_per_unit: netRisk.text() };
}

/** 数字 → 十进制字符串(给 holdingEconomics 用;科学计数法/非有限数 → null)。 */
export function decimalText(n: number | string | null | undefined): string | null {
  if (n === null || n === undefined) return null;
  if (typeof n === 'string') return /^\d+(\.\d+)?$/.test(n) ? n : null;
  if (!Number.isFinite(n) || n <= 0) return null;
  const s = n.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  return /^\d+(\.\d+)?$/.test(s) ? s : null;
}

/**
 * 净RR 判定。没有止盈目标 = 不适用(不拒:只有信号/时间离场的策略没有可算的盈亏比),返回 applicable=false。
 * 目标在错误一侧或扣完成本没有正收益 → net_rr='0',按不足拒。
 */
export function netRrCheck(side: Direction, entry: number | string, stop: number | string, target: number | string | null, th: ExecutionThresholds, minNetRr = th.min_net_rr): { applicable: boolean; net_rr: string | null; ok: boolean } {
  const e = decimalText(entry), s = decimalText(stop), t = decimalText(target);
  if (!t) return { applicable: false, net_rr: null, ok: true };
  if (!e || !s) return { applicable: true, net_rr: null, ok: false };
  const econ = holdingEconomics(side, e, s, t, th.round_trip_cost_bps);
  const net = econ?.net_rr ?? '0';
  return { applicable: true, net_rr: net, ok: D(net).cmp(D(decimalText(minNetRr) ?? '0')) >= 0 };
}

/**
 * 止损判定的一句话(开仓检查 / 发送前复查 / 回测拒绝样例共用)。按模式写:
 *  - pct / ATR 取不到改按百分比:「1.23%(允许 1%–5%)」,原因码 stop_distance / stop_too_wide;
 *  - atr:「0.85×ATR(下限 1×1h ATR ≈ 0.60%;距离 0.51%,上限 5%)」,原因码 stop_atr / stop_too_wide。
 */
export function stopGeometryReason(g: StopGeometry, th: ExecutionThresholds): string {
  if (g.mode === 'atr' && !g.atr_fallback && g.stop_atr !== null && th.min_stop_atr > 0)
    return `${g.stop_atr.toFixed(2)}×ATR(下限 ${th.min_stop_atr}×${atrLabel(th)} ≈ ${fmtPct(g.effective_min_pct)};距离 ${fmtPct(g.stop_pct)},上限 ${th.max_stop_pct}%)`;
  if (g.mode === 'atr' && !g.atr_fallback) return `${fmtPct(g.stop_pct)}(允许 0%–${th.max_stop_pct}%,ATR 下限已关闭)`;
  if (g.atr_fallback) return `ATR 不可用,改按百分比:${fmtPct(g.stop_pct)}(允许 ${g.effective_min_pct}%–${th.max_stop_pct}%)`;
  const atr = g.mode === 'both' && g.stop_atr !== null ? `,${g.stop_atr.toFixed(2)}×ATR(下限 ${th.min_stop_atr}×ATR)` : '';
  return `${fmtPct(g.stop_pct)}(允许 ${th.min_stop_pct}%–${th.max_stop_pct}%)${atr}`;
}

// ------------------------------------------------------------------ 原因归类(漏斗 top_reasons)

export type ReasonLayer = 'judge' | 'strategy' | 'gate' | 'execution';
export interface ReasonCode { layer: ReasonLayer; code: string }

/** 检查项名称对应的原因码。检查项自己带 code 时用它的;这张表只给旧记录和没带 code 的检查项用。 */
const GATE_NAME_CODE: Record<string, string> = {
  紧急停止: 'halted', 暂停: 'paused', 证据新鲜度: 'stale', 无持仓才能开仓: 'position_exists', 每日开仓上限: 'max_opens_per_day',
  止损在正确一侧: 'stop_side', 止损距离: 'stop_distance', 止损ATR下限: 'stop_atr', 止盈在正确一侧: 'tp_side', 信心下限: 'confidence',
  spot_no_short: 'spot_no_short', market_not_enabled: 'market_not_enabled', 当前策略: 'current_strategy', 没有状态不明的订单: 'unknown_order',
  策略共识: 'council', 入场方式: 'entry_style', 事件封锁: 'event_blackout', 组合限额: 'portfolio_limit', 风控哨兵: 'risk_sentinel',
  策略ATR尺度: 'holding_atr', 净盈亏比: 'min_net_rr', 结构失效价: 'invalidation', 持仓计划: 'holding_plan', 演示版不加仓: 'no_add',
};

/** 一条拒绝文本(openingBlockers / preflight / 旧事件消息)→ 原因码;认不出 = null。 */
export function codeFromText(text: string): ReasonCode | null {
  const t = String(text ?? '');
  const rules: [RegExp, ReasonLayer, string][] = [
    [/止损ATR下限|×ATR\(下限/, 'gate', 'stop_atr'],
    [/止损过宽/, 'gate', 'stop_too_wide'],
    [/止损距离[^;]*?(\d+(\.\d+)?)%\(允许/, 'gate', 'stop_distance'],
    [/净盈亏比|净RR/, 'gate', 'min_net_rr'],
    [/同时线程数已到上限/, 'gate', 'max_open_threads'],
    [/今日开仓已到上限|每日开仓上限/, 'gate', 'max_opens_per_day'],
    [/日亏停/, 'gate', 'daily_loss_stop'],
    [/已有线程|已有持仓/, 'gate', 'symbol_open'],
    [/紧急停止/, 'gate', 'halted'],
    [/AI 扫盘已暂停/, 'gate', 'ai_scan_paused'],
    [/已暂停|工作流已暂停|Executor 已暂停/, 'gate', 'paused'],
    [/组合限额|组合\/风控闸/, 'gate', 'portfolio_limit'],
    [/风控哨兵/, 'gate', 'risk_sentinel'],
    [/数量不可用|最小下单量|最小名义/, 'gate', 'sizing'],
    [/事件封锁/, 'gate', 'event_blackout'],
    [/错误一侧/, 'gate', 'stop_side'],
    [/^already_open|已有该币持仓/, 'strategy', 'already_open'],
    [/^max_open/, 'strategy', 'max_open'],
    [/^ambiguous_position/, 'strategy', 'ambiguous_position'],
    [/^min_rr/, 'strategy', 'min_rr'],
    [/^position_unsettled|^position_version_mismatch/, 'strategy', 'position_unsettled'],
    [/^new_signal|^replace_|^flip_/, 'strategy', 'new_signal'],
    [/筛选条件未通过|^screen_filter/, 'strategy', 'screen_filter'],
    [/^ir_judge_skip|^judge_runtime_missing/, 'judge', 'ir_judge_skip'],
    [/^jev_unavailable/, 'judge', 'jev_unavailable'],
    [/^jev_skip/, 'judge', 'jev_skip'],
    [/行情尚未返回最新收盘|缺最新收盘行情/, 'strategy', 'bars_pending'],
    [/限价挂单已过期/, 'strategy', 'entry_expired'],
    // 顺序要紧:发送前复查的报错是「发送前持仓计划重闸: 策略ATR尺度;…」,本身带「持仓计划」,具体的检查名要排在前面
    [/策略ATR尺度/, 'gate', 'holding_atr'],
    [/结构失效价/, 'gate', 'invalidation'],
    [/持仓计划/, 'gate', 'holding_plan'],
    [/临时失败|网络或交易所限流|HTTP 429|ETIMEDOUT|ECONNRESET/, 'execution', 'transient'],
    [/回执未知|execution_unknown/, 'execution', 'execution_unknown'],
  ];
  for (const [re, layer, code] of rules) if (re.test(t)) return { layer, code };
  return null;
}

/** 一条闸结果 → 原因码(闸层);失败的闸才有意义。 */
export function gateReasonCode(g: GateResult): string {
  if (g.code) return g.code;
  const byName = GATE_NAME_CODE[g.name];
  if (byName === 'stop_distance' && /%\(允许/.test(g.reason)) {
    const m = /^(\d+(\.\d+)?)%\(允许 (\d+(\.\d+)?)%–(\d+(\.\d+)?)%\)/.exec(g.reason);
    if (m && Number(m[1]) > Number(m[5])) return 'stop_too_wide';
  }
  if (byName) return byName;
  if (/每日开仓上限$|容量上限$|入场方式$/.test(g.name)) return 'tier_limit';
  if (g.name === '线程/日内限制' || g.name === '提交前重闸') return codeFromText(g.reason)?.code ?? 'preflight';
  return 'other_gate';
}

/** 原因码的中文标签(漏斗展示用;前端可直接用 label)。 */
export const REASON_LABELS: Record<string, string> = {
  stop_distance: '止损距离低于下限', stop_atr: '止损小于 ATR 下限', stop_too_wide: '止损距离超过上限', min_net_rr: '净盈亏比不足',
  max_open_threads: '同时持仓已满', max_opens_per_day: '今日开仓次数已满', daily_loss_stop: '触及日亏停', symbol_open: '同币已有线程/持仓',
  halted: '紧急停止', paused: '已暂停', portfolio_limit: '组合限额', risk_sentinel: '风控哨兵告警', sizing: '数量不可用', event_blackout: '事件封锁',
  stop_side: '止损方向错误', tp_side: '止盈方向错误', stale: '证据/行情过期', position_exists: '本币已有持仓', confidence: '信心不足',
  spot_no_short: '现货不能做空', market_not_enabled: '市场未启用', current_strategy: '当前策略接管开仓', unknown_order: '有状态不明的订单',
  council: '策略共识未通过', entry_style: '入场方式不允许', holding_atr: '持仓计划 ATR 尺度', invalidation: '结构失效价不合法', holding_plan: '持仓计划缺失',
  tier_limit: '分层配额', preflight: '提交前重闸', other_gate: '其他代码闸', no_add: '不允许加仓',
  already_open: '本运行已有该币持仓', max_open: '本运行持仓已满', ambiguous_position: '同币多条线程待对账', min_rr: '候选盈亏比低于策略要求',
  position_unsettled: '同币线程待对账', new_signal: '新信号待续接', screen_filter: '筛选未通过',
  ir_judge_skip: '策略判断要素跳过', jev_skip: 'Jev 判断跳过', jev_unavailable: 'Jev 不可用(按跳过)', agent_skip: 'LLM 判断跳过',
  no_trade: '模型判断不交易', bars_pending: '行情还没到', entry_expired: '限价单过期未成交', ai_scan_paused: 'AI 扫盘已暂停', watch: '模型判断观察', model_failed: '模型调用失败',
  transient: '临时失败(已重试)', execution_unknown: '回执未知', execution_error: '执行错误', unknown: '未归类',
};
export const reasonLabel = (code: string): string => REASON_LABELS[code] ?? code;

/**
 * 这些原因不算「被挡」:模型本来就没想做、系统整体停着、临时重试、行情没到、筛选没过、挂单自然过期。
 * 漏斗把它们放在 not_taken,top_reasons 只放真正被某一层拦下的。
 */
export const NOT_TAKEN_CODES = new Set(['no_trade', 'watch', 'halted', 'paused', 'ai_scan_paused', 'transient', 'screen_filter', 'bars_pending', 'entry_expired', 'entry_unknown_not_found']);

/** 旧事件没有原因码时,把消息里的数字去掉,当作分组的依据。 */
export function normalizeReasonText(text: string): string {
  return String(text ?? '').replace(/-?\d+(\.\d+)?(e[-+]?\d+)?/gi, '#').replace(/\s+/g, ' ').trim().slice(0, 80) || 'unknown';
}

// ------------------------------------------------------------------ execution-policy 读写

export interface ExecutionPolicyValues {
  risk_pct: number; leverage: number; margin_mode: 'cross' | 'isolated';
  stop_floor_mode: StopFloorMode; stop_floor_atr_tf: StopFloorTf;
  min_stop_pct: number; max_stop_pct: number; min_stop_atr: number; min_net_rr: number;
  max_open_threads: number; max_opens_per_day: number; daily_loss_stop_pct: number;
  sizing_agent: 'off' | 'advise' | 'apply';
}

export function executionPolicyValues(w: Workflow): ExecutionPolicyValues {
  const th = executionThresholds(w);
  return {
    risk_pct: Number(w.risk_pct), leverage: w.leverage, margin_mode: w.margin_mode,
    stop_floor_mode: th.stop_floor_mode!, stop_floor_atr_tf: th.stop_floor_atr_tf!,
    min_stop_pct: th.min_stop_pct, max_stop_pct: th.max_stop_pct, min_stop_atr: th.min_stop_atr, min_net_rr: th.min_net_rr,
    max_open_threads: w.max_open_threads, max_opens_per_day: w.max_opens_per_day, daily_loss_stop_pct: Number(w.daily_loss_stop_pct),
    sizing_agent: w.sizing_agent,
  };
}

export function executionPolicyBounds(): Record<ExecutionPolicyKey, Record<string, unknown>> {
  const out = {} as Record<ExecutionPolicyKey, Record<string, unknown>>;
  for (const [k, v] of Object.entries(EXECUTION_NUMERIC_BOUNDS)) out[k as ExecutionPolicyKey] = { ...v, integer: INTEGER_KEYS.has(k as ExecutionPolicyKey) };
  for (const [k, v] of Object.entries(EXECUTION_ENUM_BOUNDS)) out[k as ExecutionPolicyKey] = { values: [...v.values], agent_direct_values: [...v.agent_direct_values] };
  return out;
}

export interface PolicyPatchCheck {
  /** 通过校验的键值(已转成 workflow 存储形态:risk_pct / daily_loss_stop_pct 是字符串) */
  patch: Record<string, unknown>;
  errors: { key: string; code: 'unknown_key' | 'invalid_type' | 'out_of_bounds' | 'not_integer' | 'invalid_range'; message: string }[];
  /** 每个键是否在 agent 直改区间内 */
  outside_agent_direct: string[];
}

/** 严格校验一份执行层 patch(越界报错,不静默钳)。`current` 用于跨键校验(min_stop_pct < max_stop_pct)。 */
export function checkPolicyPatch(raw: unknown, current: Workflow): PolicyPatchCheck {
  const errors: PolicyPatchCheck['errors'] = [], patch: Record<string, unknown> = {}, outside: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { patch, errors: [{ key: '*', code: 'invalid_type', message: '请求体必须是对象,如 {"min_stop_pct":0.5}' }], outside_agent_direct: outside };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(EXECUTION_POLICY_KEYS as string[]).includes(k)) { errors.push({ key: k, code: 'unknown_key', message: `${k} 不是执行层参数,只能是 ${EXECUTION_POLICY_KEYS.join('/')}` }); continue; }
    const key = k as ExecutionPolicyKey;
    if (key in EXECUTION_ENUM_BOUNDS) {
      const e = EXECUTION_ENUM_BOUNDS[key as ExecutionEnumKey];
      if (typeof v !== 'string' || !(e.values as readonly string[]).includes(v)) { errors.push({ key, code: 'invalid_type', message: `${key} 只能是 ${e.values.join('/')}` }); continue; }
      if (!(e.agent_direct_values as readonly string[]).includes(v)) outside.push(key);
      patch[key] = v;
      continue;
    }
    const b = EXECUTION_NUMERIC_BOUNDS[key as ExecutionNumericKey];
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n)) { errors.push({ key, code: 'invalid_type', message: `${key} 必须是数字` }); continue; }
    if (INTEGER_KEYS.has(key) && !Number.isInteger(n)) { errors.push({ key, code: 'not_integer', message: `${key} 必须是整数` }); continue; }
    if (n < b.min || n > b.max) { errors.push({ key, code: 'out_of_bounds', message: `${key} 需在 ${b.min}–${b.max}${key === 'min_stop_atr' ? '(0 = 关闭)' : ''}` }); continue; }
    if (n < b.agent_direct_min || n > b.agent_direct_max) outside.push(key);
    patch[key] = key === 'risk_pct' ? String(Math.round(n * 100) / 100) : key === 'daily_loss_stop_pct' ? String(Math.round(n * 10) / 10) : n;
  }
  const th = executionThresholds(current);
  const min = Number(patch['min_stop_pct'] ?? th.min_stop_pct), max = Number(patch['max_stop_pct'] ?? th.max_stop_pct);
  if (('min_stop_pct' in patch || 'max_stop_pct' in patch) && !(min < max)) errors.push({ key: 'min_stop_pct', code: 'invalid_range', message: `min_stop_pct(${min})必须小于 max_stop_pct(${max})` });
  return { patch, errors, outside_agent_direct: outside };
}

// ------------------------------------------------------------------ 预检:历史/回测样本对执行层的通过率

export interface GeometrySample { side: Direction; ref: number; stop: number; target: number | null; atr: number | null }
export interface PolicyFit {
  checked: number;
  rejected: number;
  rejected_by_execution: Record<ExecutionBlock, number>;
  /** 样本止损距离中位数(%) */
  median_stop_pct: number | null;
  /** 样本 ATR 占价格的中位数(%);没有 ATR 的样本不计 */
  median_atr_pct: number | null;
}
const median = (xs: number[]): number | null => { if (!xs.length) return null; const v = [...xs].sort((a, b) => a - b), m = Math.floor(v.length / 2); return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2; };

/** 一批候选几何在当前执行层下会被拒掉多少(与实盘开仓闸同一个 stopGeometry / netRrCheck)。 */
export function policyFit(samples: GeometrySample[], th: ExecutionThresholds): PolicyFit {
  const by: Record<ExecutionBlock, number> = { stop_distance: 0, stop_atr: 0, stop_too_wide: 0, min_net_rr: 0 };
  let rejected = 0;
  const pcts: number[] = [], atrs: number[] = [];
  for (const s of samples) {
    if (!(s.ref > 0) || !(s.stop > 0)) continue;
    const g = stopGeometry(s.ref, s.stop, s.atr, th), blocks = [...g.blocks];
    const rr = netRrCheck(s.side, s.ref, s.stop, s.target, th);
    if (rr.applicable && !rr.ok) blocks.push('min_net_rr');
    for (const b of blocks) by[b]++;
    if (blocks.length) rejected++;
    pcts.push(g.stop_pct);
    if (s.atr && s.atr > 0) atrs.push((s.atr / s.ref) * 100);
  }
  return { checked: pcts.length, rejected, rejected_by_execution: by, median_stop_pct: median(pcts), median_atr_pct: median(atrs) };
}

/**
 * 预检文案:只建议改策略(放宽止损倍数 / 收紧止损 / 放远止盈),不建议调低执行层下限。
 * 需要的 ATR 倍数 k 按模式:pct = min_stop_pct ÷ ATR%;atr = min_stop_atr;老快照取两者更大的。向上取到 0.1。
 */
export function policyFitAdvice(fit: PolicyFit, th: ExecutionThresholds): string {
  const parts: string[] = [], by = fit.rejected_by_execution, mode = floorModeOf(th);
  if (by.stop_distance || by.stop_atr) {
    if (fit.median_atr_pct && fit.median_atr_pct > 0) {
      const byPct = mode === 'atr' ? 0 : th.min_stop_pct / fit.median_atr_pct, byAtr = mode === 'pct' ? 0 : th.min_stop_atr;
      const k = Math.ceil(Math.max(byPct, byAtr, by.stop_distance && mode === 'atr' ? atrFallbackPct(th) / fit.median_atr_pct : 0) * 10 - 1e-9) / 10;
      parts.push(`把策略止损倍数放宽到 ≥${k}×ATR(按样本 ATR 中位 ${fit.median_atr_pct.toFixed(2)}%,约 ${(k * fit.median_atr_pct).toFixed(2)}%)`);
    } else parts.push(mode === 'pct' ? `把策略止损放宽到 ≥${th.min_stop_pct}%` : mode === 'atr' ? `把策略止损放宽到 ≥${th.min_stop_atr}×ATR(没有 ATR 时按 ${atrFallbackPct(th)}% 判)` : `把策略止损放宽到 ≥${th.min_stop_pct}% 且 ≥${th.min_stop_atr}×ATR`);
  }
  if (by.stop_too_wide) parts.push(`把止损收紧到 ≤${th.max_stop_pct}%`);
  if (by.min_net_rr) parts.push(`止盈目标放到扣成本后 ≥${th.min_net_rr}R(或去掉不合理的近目标)`);
  return parts.join(';');
}

/**
 * 净RR 用的目标价:单目标就是它;分档止盈(30% 在 1R、70% 在 3R)按仓位比例加权成一个等效目标。
 * 只拿首档算会把合理的分批止盈判成「盈亏比不足」。size 缺失/全 0 → 退回首档。实盘、预检、回测都用这一个。
 */
export function blendedTarget(targets: readonly { price: number | string; size: number | null | undefined }[]): number | null {
  const rows = targets.map((t) => ({ p: Number(t.price), w: Number(t.size ?? 0) })).filter((t) => Number.isFinite(t.p) && t.p > 0);
  if (!rows.length) return null;
  const w = rows.reduce((a, t) => a + (t.w > 0 ? t.w : 0), 0);
  return w > 0 ? rows.reduce((a, t) => a + t.p * (t.w > 0 ? t.w : 0), 0) / w : rows[0]!.p;
}
