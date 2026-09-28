// 闸覆盖(docs/eval/gate-coverage-2026-09-12.md)。
//
// 09-04 之前 eval 只跑 gates.ts 那一层闸,14→16 道闸里只有「证据新鲜度」被触发过 2 次,其余从没被触发过
// ——「没触发」不等于「有效」。这里做两件事:
//   1. `evaluateAllGates`:把 runtime 建仓路径上并列跑的那几道闸(线程/日内限制、没有状态不明的订单、
//      策略共识、入场方式、提交前重闸)也在 eval 里跑一遍。闸本身一行没改,全部从 `demo` 里读。
//   2. `gateCoverage`:闸 × 触发次数矩阵,任何一道闸 0 次就是 FAIL。
//
// 09-12 晚:新合并的三道闸/判定(§9.31 保护腿凭证、§9.30 事件封锁、§9.25 议会两条新判定)判断图的
// `guards` 表还没登记,按 `EXTENSION_GATE_INVENTORY` 单列一段,同样「每行必须有一个必然触发它的用例」。
//
// 向后兼容:只有 case 里写了 `visible.gate_env` 才会跑扩展的那几道闸;没写的 case(v1/v2/v3 全部)
// 与 09-12 之前逐字一致。

import { demo } from '@trade-gate/gateway';
// `eventBlackoutGate` 还没从 `demo/index.ts` 转出(本轮不动 gateway 源码),只能走 dist 深路径拿。
// gateway 那边补一行 export 之后,这两个 import 应当换回 `demo.*`。
import { eventBlackoutGate, EVENT_BLACKOUT_GATE } from '@trade-gate/gateway/dist/demo/events.js';
import type { MarketEvent } from '@trade-gate/gateway/dist/demo/events.js';
import type { EvalCase, GateResult, Judgment, StrategyThread } from './types.js';
import { featureTfs } from './inputs.js';

/**
 * 定向闸用例给 harness 的「运行时环境」。runtime 里这些值来自 workflow / store / 风控快照;
 * eval 里由 case 直接给,好让每道闸都有一个必然踩线的输入。字段全部 snake_case。
 */
export interface GateEnv {
  paused?: boolean;
  opens_today?: number;
  /** 有一笔 intent 状态不明(runtime: `store.intents().some(i => i.status === 'unknown')`)。 */
  unknown_intent?: boolean;
  daily_loss_hit?: boolean;
  /** 除本 case 线程之外的开放线程(线程/日内限制闸看的就是这批)。 */
  other_threads?: StrategyThread[];
  max_open_threads?: number;
  max_opens_per_day?: number;
  daily_loss_stop_pct?: string;
  entry_style?: demo.EntryStyle;
  council_mode?: demo.CouncilMode;
  /** require 模式下的议会结果;null = 议会没跑(闸会拒)。 */
  council?: demo.CouncilResult | null;
  /** 交易所 symbol 状态;'TRADING' 之外都不可交易,null = 拿不到,不拦。 */
  symbol_status?: string | null;
  /** 是否跑「提交前重闸」(runtime 里它在建线程前才跑)。 */
  preflight?: boolean;
  /** §9.31:本币在当前通道上的保护腿凭证状态;`never_verified` 在提交前重闸里按币阻断。 */
  protection_state?: string | null;
  /** 通道名,只进阻断文案。 */
  channel?: string;
  /** §9.30 事件封锁:> 0 才启闸(runtime 读 workflow.event_blackout_min)。 */
  event_blackout_min?: number;
  /** 事件封锁闸看的事件集(runtime 里是 `store.events.activeAt(now)`)。 */
  events?: MarketEvent[];
}

/** 闸清单:guard id → 它住在哪、eval 怎么给它造必然触发的用例。文档用同一份。 */
export interface GateSpec {
  guard: string;
  gate_name: string;
  where: string;
  how: string;
  /**
   * 扩展判定专用:这一行不是判断图 `guards` 表里的 guard(gateway 的图本轮不动),矩阵按
   * 「闸名 = gate_name」+「拒绝理由里含 reason_match」来认领。留空 = 只按闸名认领。
   */
  reason_match?: string;
}

export const GATE_INVENTORY: GateSpec[] = [
  { guard: 'halt', gate_name: '紧急停止', where: 'gates.ts evaluateGates', how: 'visible.halted = true + 判断输出 PROPOSE' },
  { guard: 'paused', gate_name: '暂停', where: 'gates.ts evaluateGates', how: 'gate_env.paused = true + PROPOSE' },
  { guard: 'fresh_evidence', gate_name: '证据新鲜度', where: 'gates.ts evaluateGates', how: 'market.as_of 比 as_of 早 10 分钟(快照过期)或判断引用了 STALE 证据' },
  { guard: 'no_position', gate_name: '无持仓才能开仓', where: 'gates.ts evaluateGates', how: 'account.positions 非空 + PROPOSE' },
  { guard: 'daily_open_cap', gate_name: '每日开仓上限', where: 'gates.ts evaluateGates', how: 'gate_env.opens_today ≥ DEFAULT_GATES.max_opens_per_day(2)' },
  { guard: 'stop_side', gate_name: '止损在正确一侧', where: 'gates.ts evaluateGates', how: '做多提议给一个高于标记价的止损' },
  { guard: 'stop_distance', gate_name: '止损距离', where: 'gates.ts evaluateGates', how: '止损距离 < 0.3%(或 > 5%)' },
  { guard: 'tp_side', gate_name: '止盈在正确一侧', where: 'gates.ts evaluateGates', how: '做多提议给一个低于标记价的 take_profit_price' },
  { guard: 'confidence_floor', gate_name: '信心下限', where: 'gates.ts evaluateGates', how: 'PROPOSE 的 confidence < 0.40' },
  { guard: 'no_add', gate_name: '演示版不加仓', where: 'gates.ts evaluateGates', how: '判断输出 action=ADD' },
  { guard: 'thread_limits', gate_name: '线程/日内限制', where: 'threads.ts openingBlockers', how: 'gate_env.other_threads 里已有同币线程' },
  { guard: 'no_unknown_orders', gate_name: '没有状态不明的订单', where: 'gates.ts unknownOrderGate(09-12 从 runtime 抽出的纯函数)', how: 'gate_env.unknown_intent = true' },
  { guard: 'strategy_consensus', gate_name: '策略共识', where: 'strategy-council.ts consensusGate', how: 'gate_env.council_mode = require 且 council = null' },
  { guard: 'entry_style', gate_name: '入场方式', where: 'entry-policy.ts entryStyleGate', how: 'gate_env.entry_style = prefer_limit + 价已追出 1 ATR 的市价 PROPOSE' },
  { guard: 'preflight', gate_name: '提交前重闸', where: 'threads.ts preflightBlockers(09-12 从 runtime 抽出的纯函数)', how: 'gate_env.preflight = true + 本币已有外部持仓' },
  { guard: 'thread_still_open', gate_name: '线程仍开放', where: 'threads.ts reduceReview', how: '复查一条 status=closed 的线程(review:closed 节点没有任何合法边)' },
];

/**
 * **扩展判定**:09-12 之后合并进来的闸 / 判定,判断图的 `guards` 表还没登记它们(graph.ts 属 gateway,
 * 本轮不动)。它们要么是一道闸内部的一条独立判定(`提交前重闸` 里的保护腿凭证、`策略共识` 里的两条新判定),
 * 要么是一道图外的新闸(`事件封锁`)。矩阵按「闸名 + 理由关键词」认领,与 `GATE_INVENTORY` 同规矩:
 * 每一行必须有一个必然踩线的定向用例,0 次触发即 FAIL。
 */
export const EXTENSION_GATE_INVENTORY: GateSpec[] = [
  {
    guard: 'protection_never_verified',
    gate_name: '提交前重闸',
    where: 'threads.ts preflightBlockers(§9.31)',
    how: 'gate_env.preflight = true + protection_state = never_verified(本币在这条通道上从没验证过能挂止损)',
    reason_match: '从没验证过能挂止损',
  },
  {
    guard: 'event_blackout',
    gate_name: EVENT_BLACKOUT_GATE,
    where: 'events.ts eventBlackoutGate(§9.30)',
    how: 'gate_env.event_blackout_min > 0 + events 里有一条覆盖 as_of 的事件 + PROPOSE(平仓/减仓永远放行)',
  },
  {
    guard: 'council_gate_effective',
    gate_name: '策略共识',
    where: 'strategy-council.ts consensusGate(§9.25 补正三)',
    how: 'council_mode = require + council.consensus.gate_effective = false(min_agree 超过能投票的策略数)',
    reason_match: '共识闸当前无效',
  },
  {
    guard: 'council_entry_timing',
    gate_name: '策略共识',
    where: 'strategy-council.ts consensusGate(§9.25b)',
    how: 'council_mode = require + 共识成立但 entry_timing = pending + 提议是市价(同一议会结果换成限价则放行)',
    reason_match: '入场时机未确认',
  },
];

/** 矩阵的全部行:图里登记的 16 道闸 + 扩展判定。 */
export const ALL_GATE_ROWS: GateSpec[] = [...GATE_INVENTORY, ...EXTENSION_GATE_INVENTORY];

function workflowFor(env: GateEnv): demo.Workflow {
  return {
    ...demo.DEFAULT_WORKFLOW,
    paused: env.paused ?? false,
    max_open_threads: env.max_open_threads ?? demo.DEFAULT_WORKFLOW.max_open_threads,
    max_opens_per_day: env.max_opens_per_day ?? demo.DEFAULT_WORKFLOW.max_opens_per_day,
    daily_loss_stop_pct: env.daily_loss_stop_pct ?? demo.DEFAULT_WORKFLOW.daily_loss_stop_pct,
    entry_style: env.entry_style ?? 'free',
    updated_at: 0,
  };
}

/**
 * 一个 episode 的全部闸。`gate_env` 缺席时只跑 `demo.evaluateGates`(09-12 之前的行为,逐字不变);
 * 写了 `gate_env` 的定向用例才会继续跑 runtime 建仓路径上那几道并列的闸。
 *
 * 注意这里一道闸的判定与文案都不自己写:全部调 gateway 的导出函数,eval 只负责喂输入、收 GateResult。
 */
export function evaluateAllGates(c: EvalCase, j: Judgment, staleRefs: string[], now: number, review: demo.ReviewDecision | null): GateResult[] {
  const env = c.visible.gate_env;
  const out = demo.evaluateGates(j, {
    halted: c.visible.halted,
    paused: env?.paused ?? false,
    account: c.visible.account,
    market: c.visible.market,
    opens_today: env?.opens_today ?? 0,
    stale_refs: new Set(staleRefs),
    now,
  });
  if (!env) return out;
  const wf = workflowFor(env);
  if (j.action === 'PROPOSE') {
    // runtime.ts 只把「被挡住的」线程/日内限制 push 进 gates(通过时不留行),这里同口径。
    for (const b of demo.openingBlockers(env.other_threads ?? [], wf, c.symbol, env.opens_today ?? 0, env.daily_loss_hit ?? false)) {
      out.push({ name: '线程/日内限制', passed: false, reason: b });
    }
    out.push(demo.unknownOrderGate(env.unknown_intent ?? false));
    const mode = env.council_mode ?? 'off';
    if (mode !== 'off') {
      const cg = demo.consensusGate(j, env.council ?? null, mode);
      out.push({ name: '策略共识', passed: cg.passed, reason: cg.reason });
    }
    const tf = c.timeframe;
    const base = c.visible.klines[tf] ? demo.tfFeatures(tf, c.visible.klines[tf]!) : undefined;
    const advice = demo.entryStyleAdvice({ side: j.proposal?.direction ?? j.direction, horizon: null, checklist: null, base, mark: Number(c.visible.market.mark), style: wf.entry_style ?? 'free' });
    const eg = demo.entryStyleGate(j, advice, wf.entry_style ?? 'free');
    out.push({ name: '入场方式', passed: eg.passed, reason: eg.reason });
    if (env.preflight) {
      const blockers = demo.preflightBlockers({
        halted: c.visible.halted,
        paused: env.paused ?? false,
        symbol: c.symbol,
        account: c.visible.account,
        other_threads: env.other_threads ?? [],
        workflow: wf,
        opens_today: env.opens_today ?? 0,
        daily_loss_hit: env.daily_loss_hit ?? false,
        symbol_status: env.symbol_status ?? null,
        protection_state: env.protection_state ?? null,
        ...(env.channel ? { channel: env.channel } : {}),
      });
      if (blockers.length) out.push({ name: '提交前重闸', passed: false, reason: blockers.join(';') });
    }
  }
  // §9.30 事件封锁:runtime 在全部闸之后追这一行,`opening = PROPOSE | ADD`;平仓/减仓/撤单永远 passed
  // (「只拦开仓」是这道闸的语义,不能把人困在仓位里)。只有写了 event_blackout_min / events 的定向 case
  // 才跑,其余 case 的闸条目逐字不变。
  if (env.event_blackout_min !== undefined || env.events) {
    out.push(eventBlackoutGate(env.events ?? [], c.symbol, now, env.event_blackout_min ?? 0, j.action === 'PROPOSE' || j.action === 'ADD'));
  }
  // 「线程仍开放」住在 reduceReview 里:线程已结束时整条复查作废。它不产 GateResult,这里把 reducer
  // 的拒绝原文照抄成一条闸记录,好让闸矩阵能数到它。
  if (review && !review.accepted) out.push({ name: '线程仍开放', passed: false, reason: review.reason });
  return out;
}

// ---------------------------------------------------------------- 矩阵

export interface GateCoverageRow {
  guard: string;
  gate_name: string;
  where: string;
  how: string;
  /** true = 扩展判定(判断图 guards 表里没登记),矩阵按闸名 + 理由关键词认领。 */
  extension: boolean;
  /** 这个闸拒绝了多少个 episode。 */
  rejections: number;
  cases: string[];
  /** 拒绝理由样例(去重,最多 3 条)。 */
  reasons: string[];
}

export interface GateCoverage {
  rows: GateCoverageRow[];
  covered: number;
  total: number;
  ratio: number;
  missing: string[];
  /** 图里有、但清单里没写的 guard(图加了闸而清单没跟上时报出来)。 */
  unlisted_guards: string[];
}

export interface GateHitInput {
  case_id: string;
  /** gate name → reason,只含 passed=false 的。 */
  rejected: { name: string; reason: string }[];
}

/**
 * 一条拒绝记录是否属于清单里的这一行。
 * - 图里登记的闸:按 guard id(闸名 → `demo.guardIdForGate`)认领,与 09-12 的口径逐字一致。
 * - 扩展判定:图的 guards 表没有它们,按「闸名 + 理由关键词」认领;一条拒绝可以同时被基础行和扩展行
 *   认领(`提交前重闸` 里的保护腿凭证就是这样),这是有意的——扩展行数的是「这条判定」的触发次数。
 */
function claims(spec: GateSpec, r: { name: string; reason: string }, extension: boolean): boolean {
  if (!extension) return (demo.guardIdForGate(r.name) ?? r.name) === spec.guard;
  if (r.name !== spec.gate_name) return false;
  return spec.reason_match ? r.reason.includes(spec.reason_match) : true;
}

/** 闸 × 触发次数。基础 16 行的 guard id 来自 `demo.JUDGMENT_GRAPH.guards`,扩展判定见 `EXTENSION_GATE_INVENTORY`。 */
export function gateCoverage(hits: GateHitInput[]): GateCoverage {
  const rowFor = (g: GateSpec, extension: boolean): GateCoverageRow => {
    const cases: string[] = [];
    const reasons = new Set<string>();
    for (const h of hits) {
      let claimed = false;
      for (const r of h.rejected) {
        if (!claims(g, r, extension)) continue;
        claimed = true;
        reasons.add(r.reason);
      }
      if (claimed) cases.push(h.case_id);
    }
    return { guard: g.guard, gate_name: g.gate_name, where: g.where, how: g.how, extension, rejections: cases.length, cases, reasons: [...reasons].slice(0, 3) };
  };
  const rows = [...GATE_INVENTORY.map((g) => rowFor(g, false)), ...EXTENSION_GATE_INVENTORY.map((g) => rowFor(g, true))];
  const listed = new Set(GATE_INVENTORY.map((g) => g.guard));
  const covered = rows.filter((r) => r.rejections > 0).length;
  return {
    rows,
    covered,
    total: rows.length,
    ratio: rows.length ? covered / rows.length : 0,
    missing: rows.filter((r) => r.rejections === 0).map((r) => r.guard),
    unlisted_guards: Object.keys(demo.JUDGMENT_GRAPH.guards).filter((id) => !listed.has(id)),
  };
}
