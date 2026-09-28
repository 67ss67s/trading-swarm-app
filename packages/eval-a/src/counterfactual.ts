// review_counterfactual (docs/eval/results-2026-09-04.md「v5 全量结果」的两个待补指标之一):复查 case 的
// 「如果不这么判会怎样」。v5 把模糊地带一律判成 HOLD,零 PROPOSE 之下 outcome_R 是空的,所以复查侧唯一
// 能拿到的方向性证据就是:用 hidden K 线把「一直拿着」和「此刻走人」各结算一遍,和众数判断比。
//
// **这是单路径反事实,不是 P&L**:没有再入场、没有分批、没有滑点手续费、REDUCE 只按「一半拿一半走」的
// 线性近似算。它能回答「v5 的 EXIT→HOLD 翻转在这批数据上是赚了还是亏了」,不能回答「策略赚不赚钱」。
//
// 口径(全部用 outcome.ts 的同一套成交/止损/止盈语义,不另写一份):
//   in_position  hold_r      = 从线程成交价开仓,走 hidden 到止损/止盈;都没碰到就按 horizon 末根收盘 mark-to-market
//                exit_now_r  = 按 as_of 收盘价平掉(同一个 R 分母:|成交价 − 止损|)
//   pending_entry keep_r     = 挂单留着:hidden 内触及入场价才成交,然后走同一条路;整段没成交 = 0
//                invalidate_r = 0(撤单,什么也没发生)
// chosen = 该 case 的(众数)判断:HOLD→hold,REDUCE→半 hold 半 exit,EXIT/INVALIDATE→exit_now;
// 挂单侧 HOLD→keep,INVALIDATE/EXIT→0。best = argmax(平手算 HOLD),regret = best − chosen(≥ 0)。

import { demo } from '@trade-gate/gateway';
import { openTrade, simulateOutcome, stepTrade, tradeR } from './outcome.js';
import type { Action, Direction, EvalCase, Judgment } from './types.js';
import { mean, median, round } from './util.js';

/** Which side of the HOLD/EXIT boundary an action sits on; REDUCE is genuinely in between. */
export type CfSide = 'hold' | 'exit' | 'mixed';

export type CfBest = 'HOLD' | 'EXIT' | 'INVALIDATE';

export interface Counterfactual {
  case_id: string;
  thread_status: 'in_position' | 'pending_entry';
  side: Direction;
  /** R of leaving it alone: hold to stop/TP/horizon end (in_position) or let the order stand (pending_entry). */
  hold_r: number;
  /** R of getting out now: as_of close (in_position) or cancelling the order (pending_entry → 0). */
  exit_now_r: number;
  /** pending_entry only (mirrors hold_r / exit_now_r under the names the order case uses). */
  keep_r: number | null;
  invalidate_r: number | null;
  /** How the hold walk ended: stop / tp / expired (mark-to-market) / unfilled (order never triggered). */
  hold_status: 'stop' | 'tp' | 'expired' | 'unfilled';
  best_action: CfBest;
  best_r: number;
  chosen_action: Action;
  chosen_r: number;
  /** best_r − chosen_r, ≥ 0 by construction. */
  regret_r: number;
  judged_side: CfSide;
  better_side: 'hold' | 'exit';
  chose_best: boolean;
  note: string;
}

const EPS = 1e-9;

const sideOf = (a: Action): CfSide => (a === 'REDUCE' ? 'mixed' : a === 'EXIT' || a === 'INVALIDATE' ? 'exit' : 'hold');

/**
 * The counterfactual for one review case, or null when it is not scoreable (not a review case, no thread,
 * a closed thread, a missing/wrong-side stop, or no hidden bars).
 */
export function counterfactualFor(c: EvalCase, j: Judgment): Counterfactual | null {
  const t = c.thread;
  if (c.mode !== 'review' || !t) return null;
  if (t.status !== 'in_position' && t.status !== 'pending_entry') return null;
  if (t.stop_price === null) return null;
  const bars = c.hidden.future_klines.slice(0, c.hidden.horizon_bars);
  if (!bars.length) return null;
  const stop = Number(t.stop_price);
  const tpRaw = t.take_profits[0];
  const tp = tpRaw === undefined ? null : Number(tpRaw);
  const side = t.side as Direction;
  if (!Number.isFinite(stop)) return null;

  let hold_r: number;
  let exit_now_r: number;
  let hold_status: Counterfactual['hold_status'];
  let note: string;

  if (t.status === 'in_position') {
    const fillStr = t.filled_avg_price ?? t.entry.price ?? c.visible.market.last;
    const fill = Number(fillStr);
    const trade = openTrade(side, fill, stop, tp);
    if (!trade) return null;
    let exitPx: number | null = null;
    let status: 'stop' | 'tp' | null = null;
    for (const bar of bars) {
      const step = stepTrade(trade, bar);
      if (!step.exit) continue;
      exitPx = step.exit.price;
      status = step.exit.status;
      break;
    }
    if (exitPx === null) {
      exitPx = Number(bars[bars.length - 1]!.close);
      hold_status = 'expired';
      note = `HOLD 到 horizon 末根收盘 ${exitPx}(止损/止盈都没碰到,按 mark-to-market 计)`;
    } else {
      hold_status = status!;
      note = `HOLD 走到${status === 'stop' ? '止损' : '止盈'} ${exitPx}`;
    }
    hold_r = tradeR(trade, exitPx);
    exit_now_r = tradeR(trade, Number(c.visible.market.last));
  } else {
    // pending_entry: the order either fills inside the horizon and then walks the same rules, or it never does.
    const o = simulateOutcome({
      direction: side,
      entry: t.entry.type,
      limit_price: t.entry.price === null ? null : Number(t.entry.price),
      stop,
      tp,
      bars,
    });
    if (o.status === 'invalid') return null;
    hold_r = o.r ?? 0;
    exit_now_r = 0;
    hold_status = o.status === 'unfilled' ? 'unfilled' : o.status;
    note = o.status === 'unfilled' ? '挂单在 horizon 内没成交,留着与撤掉等价(0R)' : `挂单成交后${o.status === 'stop' ? '走到止损' : o.status === 'tp' ? '走到止盈' : '到期按收盘'} ${o.exit_price}`;
  }

  const pending = t.status === 'pending_entry';
  const holdName: CfBest = 'HOLD';
  const exitName: CfBest = pending ? 'INVALIDATE' : 'EXIT';
  const better_side: 'hold' | 'exit' = hold_r > exit_now_r + EPS ? 'hold' : hold_r < exit_now_r - EPS ? 'exit' : 'hold';
  const best_r = Math.max(hold_r, exit_now_r);
  const best_action: CfBest = better_side === 'hold' ? holdName : exitName;

  const a = j.action;
  const chosen_r = a === 'REDUCE' ? (hold_r + exit_now_r) / 2 : a === 'EXIT' || a === 'INVALIDATE' ? exit_now_r : hold_r;
  const regret_r = best_r - chosen_r;

  return {
    case_id: c.id,
    thread_status: t.status,
    side,
    hold_r: round(hold_r),
    exit_now_r: round(exit_now_r),
    keep_r: pending ? round(hold_r) : null,
    invalidate_r: pending ? 0 : null,
    hold_status,
    best_action,
    best_r: round(best_r),
    chosen_action: a,
    chosen_r: round(chosen_r),
    regret_r: round(Math.max(0, regret_r)),
    judged_side: sideOf(a),
    better_side,
    chose_best: regret_r <= EPS,
    note,
  };
}

export interface CfActionStat {
  n: number;
  mean_regret_r: number | null;
  mean_chosen_r: number | null;
  mean_best_r: number | null;
  chose_best: number;
}

/** judged HOLD/EXIT × better HOLD/EXIT; REDUCE sits outside the 2×2 and is counted on its own. */
export interface CfMatrix {
  hold_hold: number;
  hold_exit: number;
  exit_hold: number;
  exit_exit: number;
  mixed: number;
}

export interface CounterfactualSummary {
  n: number;
  in_position: number;
  pending_entry: number;
  mean_regret_r: number | null;
  median_regret_r: number | null;
  chose_best_share: number | null;
  mean_hold_r: number | null;
  mean_exit_now_r: number | null;
  by_action: Record<string, CfActionStat>;
  matrix: CfMatrix;
  /** Judged EXIT/INVALIDATE: mean (hold_r − exit_now_r) — what holding instead would have made (+) or lost (−). */
  hold_instead_of_exit_r: number | null;
  /** Judged HOLD: mean (exit_now_r − hold_r) — what exiting instead would have made (+) or lost (−). */
  exit_instead_of_hold_r: number | null;
  hold_status_counts: Record<string, number>;
  /** Worst regrets first, for the report's example list. */
  worst: { case_id: string; chosen: Action; chosen_r: number; best: CfBest; best_r: number; regret_r: number; note: string }[];
}

const meanR = (xs: number[]): number | null => {
  const m = mean(xs);
  return m === null ? null : round(m);
};

export function summarizeCounterfactual(cfs: Counterfactual[]): CounterfactualSummary {
  const by_action: Record<string, CfActionStat> = {};
  for (const a of [...new Set(cfs.map((x) => x.chosen_action))].sort()) {
    const g = cfs.filter((x) => x.chosen_action === a);
    by_action[a] = { n: g.length, mean_regret_r: meanR(g.map((x) => x.regret_r)), mean_chosen_r: meanR(g.map((x) => x.chosen_r)), mean_best_r: meanR(g.map((x) => x.best_r)), chose_best: g.filter((x) => x.chose_best).length };
  }
  const matrix: CfMatrix = { hold_hold: 0, hold_exit: 0, exit_hold: 0, exit_exit: 0, mixed: 0 };
  for (const x of cfs) {
    if (x.judged_side === 'mixed') matrix.mixed++;
    else if (x.judged_side === 'hold') x.better_side === 'hold' ? matrix.hold_hold++ : matrix.hold_exit++;
    else x.better_side === 'hold' ? matrix.exit_hold++ : matrix.exit_exit++;
  }
  const judgedExit = cfs.filter((x) => x.judged_side === 'exit');
  const judgedHold = cfs.filter((x) => x.judged_side === 'hold');
  const counts: Record<string, number> = {};
  for (const x of cfs) counts[x.hold_status] = (counts[x.hold_status] ?? 0) + 1;
  return {
    n: cfs.length,
    in_position: cfs.filter((x) => x.thread_status === 'in_position').length,
    pending_entry: cfs.filter((x) => x.thread_status === 'pending_entry').length,
    mean_regret_r: meanR(cfs.map((x) => x.regret_r)),
    median_regret_r: cfs.length ? round(median(cfs.map((x) => x.regret_r))!) : null,
    chose_best_share: cfs.length ? round(cfs.filter((x) => x.chose_best).length / cfs.length) : null,
    mean_hold_r: meanR(cfs.map((x) => x.hold_r)),
    mean_exit_now_r: meanR(cfs.map((x) => x.exit_now_r)),
    by_action,
    matrix,
    hold_instead_of_exit_r: meanR(judgedExit.map((x) => x.hold_r - x.exit_now_r)),
    exit_instead_of_hold_r: meanR(judgedHold.map((x) => x.exit_now_r - x.hold_r)),
    hold_status_counts: Object.fromEntries(Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]))),
    worst: [...cfs]
      .sort((a, b) => b.regret_r - a.regret_r || a.case_id.localeCompare(b.case_id))
      .slice(0, 10)
      .map((x) => ({ case_id: x.case_id, chosen: x.chosen_action, chosen_r: x.chosen_r, best: x.best_action, best_r: x.best_r, regret_r: x.regret_r, note: x.note })),
  };
}

/** Daily-regime side implied by `demo.dailyRegime`; range/volatile point nowhere. */
export function regimeBias(r: demo.DailyRegime | null): Direction | null {
  if (!r) return null;
  return r.regime === 'bull' ? 'long' : r.regime === 'bear' ? 'short' : null;
}

/**
 * The directional stance a judgment expresses: its own `direction` when it has one, else — on a review that
 * keeps the position — the side of the thread it is keeping. EXIT/INVALIDATE express no stance.
 */
export function judgmentStance(c: EvalCase, j: Judgment): { stance: Direction | null; from: 'judgment' | 'thread' | 'none' } {
  // EXIT/INVALIDATE express no stance even when the model echoes the thread side into `direction`
  // (GLM does, on every review) — scoring those measured the case generator's thread side, not the model.
  if (j.action === 'EXIT' || j.action === 'INVALIDATE') return { stance: null, from: 'none' };
  if (j.direction) return { stance: j.direction, from: 'judgment' };
  if (c.mode === 'review' && c.thread && (j.action === 'HOLD' || j.action === 'ADD' || j.action === 'REDUCE')) return { stance: c.thread.side as Direction, from: 'thread' };
  return { stance: null, from: 'none' };
}

export interface RegimeRow {
  case_id: string;
  regime: demo.DailyRegime['regime'] | null;
  bias: Direction | null;
  stance: Direction | null;
  stance_from: 'judgment' | 'thread' | 'none';
  agree: boolean | null;
}

/** null bias or null stance = not scoreable (counted, not scored). */
export function regimeRow(c: EvalCase, j: Judgment): RegimeRow {
  const daily = c.visible.klines['1d'];
  const regime = daily && daily.length >= 30 ? demo.dailyRegime(daily, c.as_of) : null;
  const bias = regimeBias(regime);
  const { stance, from } = judgmentStance(c, j);
  // Only the model's OWN direction is scored. A review thread's side was chosen by the case generator (the v3
  // sets deliberately open threads against the daily regime), so scoring HOLD-by-thread-side measured the
  // generator, not the model (pi-v6r-design-s1: 0/14, all of them thread stances). Kept as a row for the table.
  const scoreable = from === 'judgment' && bias !== null && stance !== null;
  return { case_id: c.id, regime: regime?.regime ?? null, bias, stance, stance_from: from, agree: scoreable ? bias === stance : null };
}

export interface RegimeAgreement {
  cases_with_daily: number;
  scored: number;
  agree: number;
  agreement: number | null;
  by_regime: Record<string, { n: number; scored: number; agree: number }>;
  unscored_reason: { no_daily_klines: number; no_regime_bias: number; no_stance: number };
}

export function regimeAgreement(rows: RegimeRow[], casesWithDaily: number): RegimeAgreement {
  const scored = rows.filter((r) => r.agree !== null);
  const by_regime: RegimeAgreement['by_regime'] = {};
  for (const r of rows) {
    const key = r.regime ?? 'none';
    const b = (by_regime[key] ??= { n: 0, scored: 0, agree: 0 });
    b.n++;
    if (r.agree !== null) {
      b.scored++;
      if (r.agree) b.agree++;
    }
  }
  return {
    cases_with_daily: casesWithDaily,
    scored: scored.length,
    agree: scored.filter((r) => r.agree).length,
    agreement: scored.length ? round(scored.filter((r) => r.agree).length / scored.length) : null,
    by_regime: Object.fromEntries(Object.entries(by_regime).sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))),
    unscored_reason: {
      no_daily_klines: rows.filter((r) => r.regime === null).length,
      no_regime_bias: rows.filter((r) => r.regime !== null && r.bias === null).length,
      no_stance: rows.filter((r) => r.bias !== null && r.stance === null).length,
    },
  };
}
