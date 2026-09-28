// vs_mechanical:agent 要赢的那枚硬币。
//
// zero-propose 漏斗(docs/research/zero-propose-funnel-2026-09-05.md §0)在 60 天 × 27 个代码上量过一条
// 「傻规则」的成绩:按 1h EMA20/50 的方向,在下一根开盘市价入场,止损放在突破位外 0.8 ATR,止盈 1.5R,
// 最多走 48 根 —— 期望 ≈ −0.02R、胜率 37–40%。那条规则不需要模型,一行代码就能跑。所以「agent 有没有用」
// 的最低门槛不是「outcome_R 为正」,而是「在同一批 case、同一个 as_of 上,比这枚硬币高多少 R」。
//
// 本文件在**每个 scan case 自己的 visible + hidden K 线**上重算这枚硬币,语义逐字取自
// packages/gateway/src/demo/funnel.ts 的 `scoreCandidate` + `OUTCOME_DEFAULTS`(stop_atr 0.8 / tp_r 1.5 /
// horizon_bars 48),成交与止损/止盈的走法全部复用同一份 `openTrade / stepTrade / tradeR`,不另写规则。
//
// **单路径**:不再入场、不分批、无手续费与滑点。和 counterfactual.ts 一样,它是方向性证据,不是 P&L。
//
// 纯函数:只吃 (case, 判断行),没有 I/O、没有时钟、没有网络。

import { demo } from '@trade-gate/gateway';
import { openTrade, stepTrade, tradeR, type Outcome } from './outcome.js';
import type { EvalCase } from './types.js';
import { mean, median, round } from './util.js';

/** funnel.ts `OUTCOME_DEFAULTS` 的三个数,原样复制(那边是 gateway 的常量,这里不改它、也不 import 私有值)。 */
export const MECHANICAL_STOP_ATR = 0.8;
export const MECHANICAL_TP_R = 1.5;
export const MECHANICAL_HORIZON_BARS = 48;

export interface MechanicalTrade {
  case_id: string;
  direction: 'long' | 'short';
  /** 下一根(hidden 的第 0 根)开盘价。 */
  fill: number;
  stop: number;
  tp: number;
  r: number;
  status: 'stop' | 'tp' | 'expired';
  /** 实际走过的 hidden K 线根数(≤ 48)。 */
  bars_walked: number;
}

/**
 * 一个 scan case 上的机械基线交易,不可结算时返回 null。
 * 不可结算的四种情况:review case、没有 1h/判断周期 K 线、1h EMA20 === EMA50(方向说不出来)、
 * 没有 hidden 未来 K 线(没有下一根开盘可成交)、以及止损落在成交价错误一侧导致 `openTrade` 开不了仓。
 */
export function mechanicalFor(c: EvalCase): MechanicalTrade | null {
  if (c.mode !== 'scan') return null;

  // 方向:1h 的 EMA20 vs EMA50(funnel.ts `dir_h1`)。持平/缺 K 线 = 说不出方向,不计分。
  const h1 = c.visible.klines['1h']?.filter((k) => k.close_time <= c.as_of);
  if (!h1 || h1.length < 50) return null;
  const f1 = demo.tfFeatures('1h', h1);
  if (!Number.isFinite(f1.ema20) || !Number.isFinite(f1.ema50) || f1.ema20 === f1.ema50) return null;
  const long = f1.ema20 > f1.ema50;
  const direction: 'long' | 'short' = long ? 'long' : 'short';

  // 突破位与 ATR:判断周期自己的 features;突破位用**前 20 根**口径(含当根的 swing_high_20 会让
  // 「收在突破位外侧」恒假,那正是 zero-propose 的根因),缺失时退回含当根的值。
  const tfBars = c.visible.klines[c.timeframe]?.filter((k) => k.close_time <= c.as_of);
  if (!tfBars || tfBars.length < 21) return null;
  const f = demo.tfFeatures(c.timeframe, tfBars);
  const level = long ? (f.swing_high_20_prev ?? f.swing_high_20) : (f.swing_low_20_prev ?? f.swing_low_20);
  const atr = f.atr14;
  if (!Number.isFinite(level) || !Number.isFinite(atr) || atr <= 0) return null;

  const bars = c.hidden.future_klines.filter((k) => k.open_time >= c.as_of);
  if (!bars.length) return null;
  const fill = Number(bars[0]!.open);
  if (!Number.isFinite(fill) || fill <= 0) return null;

  // funnel.ts:突破位落在成交价错误一侧时退化成「成交价 ∓ stop_atr·ATR」,否则开不了仓。
  const anchor = long ? Math.min(level, fill) : Math.max(level, fill);
  const stop = long ? anchor - MECHANICAL_STOP_ATR * atr : anchor + MECHANICAL_STOP_ATR * atr;
  const trade = openTrade(direction, fill, stop, null);
  if (!trade) return null;
  const tp = long ? fill + MECHANICAL_TP_R * trade.stop_distance : fill - MECHANICAL_TP_R * trade.stop_distance;
  trade.tp = tp;

  // funnel.ts 的 walk 是 `j = i+1 … i+horizon`,i+1 就是成交那根 —— 相对 hidden 数组即**从第 0 根开始**,
  // 所以一根直接跳空穿过止损的 K 线会被算成止损(fail-pessimistic),不会被跳过。
  const walk = bars.slice(0, Math.min(MECHANICAL_HORIZON_BARS, c.hidden.horizon_bars, bars.length));
  if (!walk.length) return null;
  let walked = 0;
  for (const bar of walk) {
    walked++;
    const step = stepTrade(trade, bar);
    if (!step.exit) continue;
    return { case_id: c.id, direction, fill, stop, tp, r: round(tradeR(trade, step.exit.price)), status: step.exit.status, bars_walked: walked };
  }
  // 没碰到止损也没碰到止盈:按最后一根收盘 mark-to-market(funnel.ts 的 `tradeR(t, bars[end].close)`)。
  return { case_id: c.id, direction, fill, stop, tp, r: round(tradeR(trade, Number(walk[walk.length - 1]!.close))), status: 'expired', bars_walked: walked };
}

export interface MechanicalGroup {
  n: number;
  mean_r: number | null;
  median_r: number | null;
  total_r: number;
  win_rate: number | null;
  by_status: Record<string, number>;
}

const EMPTY_GROUP: MechanicalGroup = { n: 0, mean_r: null, median_r: null, total_r: 0, win_rate: null, by_status: {} };

function groupOf(ts: MechanicalTrade[]): MechanicalGroup {
  if (!ts.length) return { ...EMPTY_GROUP };
  const rs = ts.map((t) => t.r);
  const by_status: Record<string, number> = {};
  for (const t of ts) by_status[t.status] = (by_status[t.status] ?? 0) + 1;
  return {
    n: ts.length,
    mean_r: round(mean(rs)!),
    median_r: round(median(rs)!),
    total_r: round(rs.reduce((a, b) => a + b, 0)),
    win_rate: round(rs.filter((r) => r > 0).length / rs.length),
    by_status: Object.fromEntries(Object.entries(by_status).sort((a, b) => a[0].localeCompare(b[0]))),
  };
}

export interface MechanicalSummary {
  /** 本次 run 里的 scan case 数。 */
  scan_cases: number;
  /** 其中机械基线可结算的。 */
  scored: number;
  /** (i) 所有可结算 scan case 上的机械基线 —— 这就是那枚硬币本身。 */
  always: MechanicalGroup;
  /** (ii) agent 说 PROPOSE 的那些 case:agent 自己那笔 vs 同一批 case 上的硬币。 */
  agent_propose: {
    n: number;
    /** 取自 row 自己的 `outcome`(agent 的提案单),只算已结算的。 */
    agent_mean_r: number | null;
    agent_n_resolved: number;
    /** All mechanically scoreable PROPOSE cases, including proposals without a resolved agent outcome. */
    mechanical: MechanicalGroup;
    /** Exactly the cases contributing to agent_mean_r. Never compare different denominators. */
    paired_mechanical: MechanicalGroup;
    /** agent_mean_r − paired_mechanical.mean_r;没有配对样本时为 null。 */
    edge_r: number | null;
  };
  /** (iii) agent 跳过(NO_TRADE / WATCH)的 case 上,硬币本来会拿到多少 R。 */
  skipped: MechanicalGroup;
  /** scan case 上的其它动作(罕见,比如 fail-closed 出别的动作);留着让三组加起来等于 scored。 */
  other_actions: MechanicalGroup;
  /** Mechanically scoreable cases whose model samples are unstable; excluded from action groups. */
  unstable: MechanicalGroup;
  /**
   * agent 的**选择**值多少 R = `always.mean_r − skipped.mean_r`。
   * 符号约定:**为正 = agent 跳过的那些 case 比全体平均更差,跳过是赚的**;为负 = 它跳掉了比平均更好的机会。
   */
  selection_edge_r: number | null;
}

export interface MechanicalRow {
  case_id: string;
  mode: 'scan' | 'review';
  action: string;
  outcome: Outcome | null;
  mechanical: MechanicalTrade | null;
  stable?: boolean | null;
}

const SKIP_ACTIONS = new Set(['NO_TRADE', 'WATCH']);

export function summarizeMechanical(rows: MechanicalRow[]): MechanicalSummary {
  const scan = rows.filter((r) => r.mode === 'scan');
  const scoredRows = scan.filter((r) => r.mechanical !== null);
  const stable = scan.filter((r) => r.stable !== false);
  const mech = (rs: MechanicalRow[]): MechanicalTrade[] => rs.map((r) => r.mechanical).filter((m): m is MechanicalTrade => m !== null);

  const proposeRows = stable.filter((r) => r.action === 'PROPOSE');
  const pairedRows = proposeRows.filter((r) => r.mechanical !== null && r.outcome?.r != null && Number.isFinite(r.outcome.r));
  const agentRs = pairedRows.map((r) => r.outcome!.r!);
  const agentMean = agentRs.length ? round(mean(agentRs)!) : null;
  const proposeMech = groupOf(mech(proposeRows));
  const pairedMech = groupOf(mech(pairedRows));

  const skipped = groupOf(mech(stable.filter((r) => SKIP_ACTIONS.has(r.action))));
  const other = groupOf(mech(stable.filter((r) => r.action !== 'PROPOSE' && !SKIP_ACTIONS.has(r.action))));
  const unstable = groupOf(mech(scan.filter((r) => r.stable === false)));
  const always = groupOf(mech(scoredRows));

  // 选择性 edge:硬币在**全体**上的均值 − 硬币在 agent 放掉的那批上的均值。正 = 放掉的那批更差 = 跳对了。
  const selection = always.mean_r === null || skipped.mean_r === null ? null : round(always.mean_r - skipped.mean_r);

  return {
    scan_cases: scan.length,
    scored: scoredRows.length,
    always,
    agent_propose: {
      n: proposeRows.length,
      agent_mean_r: agentMean,
      agent_n_resolved: agentRs.length,
      mechanical: proposeMech,
      paired_mechanical: pairedMech,
      edge_r: agentMean === null || pairedMech.mean_r === null ? null : round(agentMean - pairedMech.mean_r),
    },
    skipped,
    other_actions: other,
    unstable,
    selection_edge_r: selection,
  };
}
