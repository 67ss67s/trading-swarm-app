// Strategy threads (docs/demo/v2-agent-loop.md §2) — the agent's plan for one symbol, persisted, but
// with its STATUS re-derived from exchange facts on every poll (8794 lesson: never let our own status
// field become a second source of truth). Pure functions only; the runtime owns I/O.

import { createHash } from 'node:crypto';
import type { Direction, Judgment, OpenOrderView, PositionView, StrategyThread, ThreadSource, Workflow, Backend } from './types.js';
import type { OrderStatusView } from './execution.js';
import { allowedActions, edgeFor, nodeFor } from './graph.js';
import { toClOrdId } from './okx/instruments.js';

/** 移损经济字段只做十进制字符串比较，不经浮点或 tick 四舍五入。 */
export function stopMoveDecimal(value: string): string {
  if (typeof value !== 'string' || value.length > 128 || !/^\d+(?:\.\d+)?$/.test(value) || !/[1-9]/.test(value)) throw new Error('invalid_stop_move_decimal');
  const [whole = '0', fraction = ''] = value.split('.');
  const tail = fraction.replace(/0+$/, '');
  return `${whole.replace(/^0+(?=\d)/, '')}${tail ? `.${tail}` : ''}`;
}
export function compareStopPrices(a: string, b: string): number {
  const [ai = '', af = ''] = stopMoveDecimal(a).split('.'), [bi = '', bf = ''] = stopMoveDecimal(b).split('.');
  if (ai.length !== bi.length) return ai.length > bi.length ? 1 : -1;
  if (ai !== bi) return ai > bi ? 1 : -1;
  const n = Math.max(af.length, bf.length), x = af.padEnd(n, '0'), y = bf.padEnd(n, '0');
  return x === y ? 0 : x > y ? 1 : -1;
}

export function newThread(input: {
  id: string;
  market?: import('./types.js').Market;
  backend?: Backend | null;
  symbol: string;
  side: Direction;
  source: ThreadSource;
  timeframe: string;
  thesis: string;
  invalidation_text: string | null;
  watch_conditions: string[];
  entry: StrategyThread['entry'];
  stop_price: string | null;
  take_profits: string[];
  qty: string;
  margin_usdt: string | null;
  leverage: number;
  margin_mode: 'cross' | 'isolated';
  /** v3.5: the strategy library id the opening judgment named (null when the context had no strategies). */
  strategy_id?: string | null;
  horizon?: import('./horizon.js').StrategyHorizon;
  now: number;
}): StrategyThread {
  return {
    id: input.id,
    market: input.market ?? 'perp', pair_id: null,
    backend: input.backend ?? null,
    strategy_id: input.strategy_id ?? null,
    ...(input.horizon ? { horizon: input.horizon } : {}),
    symbol: input.symbol,
    side: input.side,
    status: 'pending_entry',
    source: input.source,
    timeframe: input.timeframe,
    thesis: input.thesis,
    invalidation_text: input.invalidation_text,
    watch_conditions: input.watch_conditions,
    entry: input.entry,
    stop_price: input.stop_price,
    take_profits: input.take_profits,
    qty: input.qty,
    margin_usdt: input.margin_usdt,
    leverage: input.market === 'spot' ? 1 : input.leverage,
    margin_mode: input.market === 'spot' ? 'cross' : input.margin_mode,
    entry_client_order_id: null,
    protection_client_order_ids: [],
    filled_avg_price: null,
    realized_pnl: null,
    close_reason: null,
    attention: null,
    entry_lookup_misses: 0,
    leg_seq: 0,
    episode_ids: [],
    intent_ids: [],
    created_at: input.now,
    updated_at: input.now,
    opened_at: null,
    closed_at: null,
    version: 1,
  };
}

export const OPEN_STATUSES: StrategyThread['status'][] = ['pending_entry', 'in_position'];
export const isOpen = (t: StrategyThread): boolean => OPEN_STATUSES.includes(t.status);

/** Facts gathered by the runtime for one reconciliation pass. */
export interface ThreadFacts {
  now: number;
  account_as_of?: number;
  position: PositionView | null; // exchange position for the thread's symbol (one-way account)
  entry_order: OrderStatusView | null | 'unqueried'; // status of entry_client_order_id
  open_orders: OpenOrderView[]; // all open orders for the symbol
  mark: string | null;
}

export interface ReconcileResult {
  next: StrategyThread;
  changed: boolean;
  events: { kind: 'entry_filled' | 'closed' | 'attention' | 'attention_cleared' | 'canceled' | 'lookup_miss'; message: string }[];
  /**
   * 09-26 stuck-entry:入场单已连续 ENTRY_UNKNOWN_MAX_MISSES 次按 CID 查不到、且距提交超过 ENTRY_UNKNOWN_MIN_AGE_MS。
   * **这不是终态判定**:runtime 必须再做一次新鲜查单 + 新鲜账户复核(无同 CID 订单、无该币持仓)才能写 canceled。
   */
  verify_absent?: boolean;
}

/** 连续查不到几次(每次间隔 ≥ ENTRY_MISS_SPACING_MS)才进入终态复核。 */
export const ENTRY_UNKNOWN_MAX_MISSES = 3;
/** 距提交(调用返回或提交相位开始)至少这么久才可能判「未到交易所」。 */
export const ENTRY_UNKNOWN_MIN_AGE_MS = 10 * 60_000;
/** 两次计数的 miss 至少隔这么久:巡检 15 秒一轮、查单 30 秒缓存,同一份缓存的 null 不能连记三次。 */
export const ENTRY_MISS_SPACING_MS = 60_000;
/** 入场单「提交」的时刻:调用返回时刻优先,调用没返回(崩溃/抛错遗留的提交相位)退回相位开始时刻。 */
export function entrySubmitRef(t: StrategyThread): number | null {
  return typeof t.entry_submitted_at === 'number' ? t.entry_submitted_at : typeof t.entry_submitting_since === 'number' ? t.entry_submitting_since : null;
}
/**
 * 连续 `misses` 次查不到之后,是否满足「请求终态复核」的条件。
 * 提交时刻未知(旧版撤单链接管时把提交相位清空、又没记调用时刻)时不拿 created_at 顶替
 * (待批线程的 created_at 可以比真实发送早几个小时),改为要求连续查不到的次数本身跨过 T:
 * misses × ENTRY_MISS_SPACING_MS ≥ ENTRY_UNKNOWN_MIN_AGE_MS。
 */
export function entryUnknownVerifyDue(t: StrategyThread, misses: number, now: number): boolean {
  if (misses < ENTRY_UNKNOWN_MAX_MISSES) return false;
  const ref = entrySubmitRef(t);
  return ref !== null ? now - ref >= ENTRY_UNKNOWN_MIN_AGE_MS : misses >= Math.ceil(ENTRY_UNKNOWN_MIN_AGE_MS / ENTRY_MISS_SPACING_MS);
}

/**
 * Re-derives status from facts. Rules (mirroring 8794's order-sensitive chain, simplified for one-way):
 * - pending_entry: entry order FILLED → in_position; CANCELED/EXPIRED/REJECTED with no position → canceled;
 *   entry order gone (null) is unknown; cumulative fills remain owned even after cancellation.
 * - in_position: position gone → closed (realized pnl filled in by the runtime from receipts/income);
 *   protection legs missing → attention PROTECTION_MISSING (runtime tries to re-place).
 */
/** 入场调用返回后、交易所可见性/成交确认到达前的宽限(agent_mcp 每次调用 20–35 秒)。 */
export const ATTRIBUTION_GRACE_MS = 45_000;
function withinSubmitGrace(t: StrategyThread, now: number): boolean {
  return typeof t.entry_submitted_at === 'number' && now - t.entry_submitted_at >= 0 && now - t.entry_submitted_at < ATTRIBUTION_GRACE_MS;
}

/**
 * 交易所上此刻是否真的挂着这条线程的保护止损。认两种证据:是我们登记过的 client id,或触发价与计划止损相符。
 * **只看本轮读回的挂单**——`protection_client_order_ids` 非空只说明我们曾经挂过,不是现在还挂着(09-12 P0-01)。
 */
export function hasLiveStop(t: StrategyThread, openOrders: OpenOrderView[]): boolean {
  const want = Number(t.stop_price ?? '0');
  return openOrders.some(
    (o) =>
      o.symbol === t.symbol &&
      (o.market ?? 'perp') === (t.market ?? 'perp') &&
      (t.market !== 'spot' || (t.run_take_profit ? Number(o.qty) <= Number(t.qty) + Number(t.run_take_profit.step_size ?? '1e-12') * 1e-6 && Number(t.qty) - Number(o.qty) < Number(t.run_take_profit.step_size ?? '1e-12') * (1 - 1e-6) : Number(o.qty) >= Number(t.qty))) &&
      o.reduce_only &&
      (o.type === 'STOP_MARKET' || o.type === 'STOP') &&
      o.side === (t.side === 'long' ? 'SELL' : 'BUY') &&
      (t.protection_client_order_ids.some(cid => cid === o.client_order_id || t.backend === 'okx' && toClOrdId(cid) === o.client_order_id) || (want > 0 && o.stop_price !== null && Math.abs(Number(o.stop_price) - want) / want < 0.005)),
  );
}

export function reconcileThread(t: StrategyThread, f: ThreadFacts): ReconcileResult {
  const events: ReconcileResult['events'] = [];
  const next: StrategyThread = { ...t };
  const bump = (): void => {
    next.version = t.version + 1;
    next.updated_at = f.now;
  };
  const posMatches = f.position !== null && f.position.side === t.side;

  if (t.status === 'pending_entry') {
    const order = f.entry_order === 'unqueried' ? null : f.entry_order;
    const validQty = order !== null && /^\d+(?:\.\d+)?$/.test(order.executed_qty);
    const filled = validQty && /[1-9]/.test(order!.executed_qty);
    if (filled && order) {
      next.status = 'in_position';
      next.opened_at = f.now;
      next.filled_avg_price = order.avg_price ?? (posMatches ? f.position!.entry_price : null);
      next.qty = order.executed_qty;
      next.attention = ['FILLED', 'CANCELED', 'EXPIRED'].includes(order.status) ? null : 'ENTRY_REMAINDER';
      bump();
      events.push({ kind: 'entry_filled', message: `入场${order.status === 'PARTIALLY_FILLED' ? '部分' : ''}成交 @ ${next.filled_avg_price}` });
      return { next, changed: true, events };
    }
    if (!filled && f.position !== null && t.entry_client_order_id) {
      // Our own fill often shows up in the account read before the order query confirms it (20–35 s per
      // agent_mcp call): same side + fresh submit = pending attribution, not a foreign position. Wait.
      if (posMatches && withinSubmitGrace(t, f.now)) return { next, changed: false, events };
      // A position exists on this symbol but our entry did not fill: someone else's. Fail closed.
      if (t.attention !== 'EXTERNAL_POSITION') {
        next.attention = 'EXTERNAL_POSITION';
        bump();
        events.push({ kind: 'attention', message: '同币种出现不属于本线程的持仓,入场单保持但不会挂保护单;请人工处理' });
        return { next, changed: true, events };
      }
      return { next, changed: false, events };
    }
    if (f.entry_order !== 'unqueried' && t.entry_client_order_id) {
      const st = order?.status ?? 'GONE';
      if (['CANCELED', 'EXPIRED'].includes(st) && validQty && !filled && !posMatches) {
        next.status = 'canceled';
        next.closed_at = f.now;
        next.close_reason = t.close_reason ?? `入场单 ${st}`;
        next.attention = null;
        bump();
        events.push({ kind: 'canceled', message: next.close_reason });
        return { next, changed: true, events };
      }
      if (st === 'GONE') {
        // Just submitted: the exchange may not show the CID yet. Not a miss, not an alarm.
        if (withinSubmitGrace(t, f.now)) return { next, changed: false, events };
        // 同一份缓存的 null 不重复计数(查单有 30 秒缓存,巡检 15 秒一轮)。
        if (typeof t.entry_lookup_miss_at === 'number' && f.now - t.entry_lookup_miss_at < ENTRY_MISS_SPACING_MS) return { next, changed: false, events };
        // 单次 null 不是否定事实(传播延迟、查询盲区):计数 + ORDER_UNKNOWN,不重发、不自动撤。
        // 连续 N 次且距提交超过 T 才**请求** runtime 复核;终态只能由复核(新鲜查单 + 新鲜账户)写。
        const misses = (t.entry_lookup_misses ?? 0) + 1;
        next.entry_lookup_misses = misses;
        next.entry_lookup_miss_at = f.now;
        const verify = entryUnknownVerifyDue(t, misses, f.now);
        bump();
        if (t.attention !== 'ORDER_UNKNOWN') {
          next.attention = 'ORDER_UNKNOWN';
          events.push({ kind: 'attention', message: '入场单在交易所查不到,持续核对(不重发,不自动撤)' });
        }
        events.push({ kind: 'lookup_miss', message: `入场单按 clientOrderId 第 ${misses} 次查不到${verify ? ',已满足终态复核条件' : `(满 ${ENTRY_UNKNOWN_MAX_MISSES} 次且提交超过 ${ENTRY_UNKNOWN_MIN_AGE_MS / 60_000} 分钟才复核)`}` });
        return { next, changed: true, events, ...(verify ? { verify_absent: true } : {}) };
      }
      if (order && (t.attention === 'ORDER_UNKNOWN' || (t.entry_lookup_misses ?? 0) > 0)) {
        if (t.attention === 'ORDER_UNKNOWN') next.attention = null;
        next.entry_lookup_misses = 0;
        next.entry_lookup_miss_at = null;
        bump();
        if (t.attention === 'ORDER_UNKNOWN') events.push({ kind: 'attention_cleared', message: '入场单已查到' });
        return { next, changed: true, events };
      }
    }
    return { next, changed: false, events };
  }

  if (t.status === 'in_position') {
    if (!posMatches) {
      // 入场前/跨入场的缓存读不能证明平仓;给交易所传播留 45 秒,随后要求新的事实。
      const filledAt = Math.max(t.opened_at ?? 0, t.entry_submitted_at ?? 0);
      if (f.account_as_of !== undefined && (f.now - filledAt < ATTRIBUTION_GRACE_MS || f.account_as_of <= filledAt)) return { next, changed: false, events };
      // 入场余量还没以「同 CID 终态 + 累计成交」确认之前不许终结:那张单随时还能成交,成交要归属本线程。
      if (t.entry_cancel_pending) return { next, changed: next.version !== t.version, events };
      next.status = 'closed';
      next.closed_at = f.now;
      next.close_reason = next.close_reason ?? '持仓已在交易所侧平掉(止损/止盈触发或手动)';
      next.attention = null;
      bump();
      events.push({ kind: 'closed', message: next.close_reason });
      return { next, changed: true, events };
    }
    if (t.filled_avg_price === null && Number(f.position!.entry_price) > 0) {
      next.filled_avg_price = f.position!.entry_price;
      bump();
    }
    // 首档部分止盈后的余仓按同方向账户事实收敛;不可继续把已止盈数量算作敞口。
    if (t.run_take_profit?.client_order_id && Number(f.position!.qty) < Number(t.qty)) {
      next.qty = f.position!.qty;
      bump();
    }
    const hasStop = hasLiveStop(next, f.open_orders);
    if (hasStop && next.run_take_profit?.stop_pending) { next.run_take_profit = { ...next.run_take_profit, stop_pending: false }; bump(); }
    const wantStop = t.stop_price !== null;
    // 09-12 P0-01:「已成交仓位有没有保护」是独立于「入场余量核对」的事实,必须每轮按本轮挂单落盘,
    // 不能因为 attention 被 ENTRY_REMAINDER / CLOSE_FAILED 占着就整轮跳过——旧的保护单 ID 非空不是止损仍活着的证明。
    const missing = wantStop && !hasStop;
    if ((t.protection_missing ?? false) !== missing) {
      next.protection_missing = missing;
      bump();
    }
    if (t.attention === 'HALT_INCOMPLETE' || t.attention === 'ENTRY_REMAINDER' || t.attention === 'CLOSE_FAILED' || t.attention?.startsWith('STOP_MOVE_')) return { next, changed: next.version !== t.version, events }; // runtime owns these(成交价回填仍要落盘)
    const attention = missing ? 'PROTECTION_MISSING' : null;
    if (attention !== t.attention) {
      next.attention = attention;
      bump();
      events.push(attention ? { kind: 'attention', message: '止损单不在交易所上,需要补挂' } : { kind: 'attention_cleared', message: t.market === 'spot' && t.stop_price === null ? '现货,无止损(可选)' : '止损单已恢复' });
      return { next, changed: true, events };
    }
  }
  return { next, changed: next.version !== t.version, events };
}

/** Which actions a review judgment may take for a thread in its current status (read from the judgment graph). */
export function allowedReviewActions(t: StrategyThread): Judgment['action'][] {
  return allowedActions(nodeFor(t, false));
}

export interface ReviewDecision {
  accepted: boolean;
  reason: string;
  effect: 'none' | 'cancel_entry' | 'reduce_half' | 'close';
  patch: Partial<StrategyThread>;
  /** Graph edge taken (null = illegal edge attempt, rejected). */
  edge: string | null;
}

/** Applies the model's review action by looking the edge up in the judgment graph; the effect comes from the graph, the wording from here. */
export function reduceReview(t: StrategyThread, j: Judgment): ReviewDecision {
  const node = nodeFor(t, false);
  const edge = edgeFor(node, j.action);
  const patch: Partial<StrategyThread> = {
    thesis: t.holding_plan?.thesis ?? (j.thesis || t.thesis),
    invalidation_text: t.holding_plan ? t.holding_plan.invalidation_text : j.invalidation ?? t.invalidation_text,
    watch_conditions: j.watch_conditions.length ? j.watch_conditions : t.watch_conditions,
  };
  if (!edge) return { accepted: false, reason: `线程状态 ${t.status} 不接受 ${j.action}`, effect: 'none', patch: {}, edge: null };
  switch (edge.effect) {
    case 'none':
      return { accepted: true, reason: t.status === 'pending_entry' ? '继续等入场' : '论点仍成立,继续持有', effect: 'none', patch, edge: edge.id };
    case 'cancel_entry':
      return { accepted: true, reason: '论点失效,撤入场单', effect: 'cancel_entry', patch: { ...patch, close_reason: '论点失效(复查)' }, edge: edge.id };
    case 'close':
      return j.action === 'INVALIDATE'
        ? { accepted: true, reason: '论点失效,平仓', effect: 'close', patch: { ...patch, close_reason: '论点失效(复查)' }, edge: edge.id }
        : { accepted: true, reason: '复查决定离场', effect: 'close', patch: { ...patch, close_reason: '复查离场' }, edge: edge.id };
    case 'reduce_half':
      return { accepted: true, reason: '复查决定减半', effect: 'reduce_half', patch, edge: edge.id };
    default:
      return { accepted: false, reason: `图上的边 ${edge.id} 效果 ${edge.effect} 不属于复查`, effect: 'none', patch: {}, edge: edge.id };
  }
}

/** Opening gates that depend on the thread set + workflow (the per-proposal gates live in gates.ts). */
export function openingBlockers(threads: StrategyThread[], workflow: Workflow, symbol: string, opensToday: number, dailyLossHit: boolean, market: import('./types.js').Market = 'perp'): string[] {
  const open = threads.filter(isOpen);
  const out: string[] = [];
  if (open.some((t) => t.symbol === symbol && (t.market ?? 'perp') === market)) out.push(`${symbol} 已有线程`);
  if (open.length >= workflow.max_open_threads) out.push(`同时线程数已到上限 ${workflow.max_open_threads}`);
  if (opensToday >= workflow.max_opens_per_day) out.push(`今日开仓已到上限 ${workflow.max_opens_per_day}`);
  if (dailyLossHit) out.push(`今日亏损已触及 ${workflow.daily_loss_stop_pct}% 日亏停`);
  return out;
}

export interface PreflightInputs {
  market?: import('./types.js').Market;
  halted: boolean;
  paused: boolean;
  symbol: string;
  /** 最新账户快照(判断「本币已有持仓」用)。 */
  account: { positions: { symbol: string; market?: import('./types.js').Market }[] };
  /** 除了正在开的这条之外的开放线程。 */
  other_threads: StrategyThread[];
  workflow: Workflow;
  opens_today: number;
  daily_loss_hit: boolean;
  /** 交易所 symbol 状态('TRADING' 之外都不可交易);拿不到时传 null,不拦。 */
  symbol_status: string | null;
  /** 09-12 §9.31:这个币在当前通道上的保护腿凭证状态;`never_verified` 按币阻断。不传 = 不判(paper 等不需要保护验证的通道)。 */
  protection_state?: string | null;
  /** 通道名,只用于阻断文案。 */
  channel?: string;
}

/**
 * 「提交前重闸」:下单前用最新账户 / 线程集重查一遍。原本是 DemoRuntime.preflightOpen 的函数体,
 * 抽成纯函数只为让 eval 能给它造用例(docs/eval/gate-coverage-2026-09-12.md);判定与文案一字未改。
 */
export function preflightBlockers(inp: PreflightInputs): string[] {
  const out: string[] = [];
  if (!(inp.workflow.markets ?? ['perp']).includes(inp.market ?? 'perp')) out.push('market_not_enabled');
  if (inp.halted) out.push('紧急停止中');
  if (inp.paused) out.push('已暂停');
  // 09-06 Jacky 拍板:通道「验过但过期 / 上次真挂失败」不挡自动开仓(只发 warn 告警),真挂不上由「持仓缺止损保护」high 告警兜底。
  // 09-12(§9.31):但「这个币在这条通道上**从没**证明过能挂止损」是另一回事 —— 那是拿真钱赌一个没验过的保护腿,按币阻断。
  // 09-22 Jacky 拍板:never_verified 不再阻断开仓。真挂不上由「持仓缺止损保护」high 告警 + runtime 重试兜底;最小仓验证保留为执行页的可选工具。
  if (inp.account.positions.some((p) => p.symbol === inp.symbol && (p.market ?? 'perp') === (inp.market ?? 'perp'))) out.push(`${inp.symbol} 已有持仓(可能是外部的)`);
  out.push(...openingBlockers(inp.other_threads, inp.workflow, inp.symbol, inp.opens_today, inp.daily_loss_hit, inp.market));
  if (inp.symbol_status !== null && inp.symbol_status !== 'TRADING') out.push(`${inp.symbol} 当前状态 ${inp.symbol_status},不可交易`);
  return out;
}

/**
 * 十进制数量相减(全程 BigInt,不过二进制浮点),结果不小于 0;任一边不是十进制数量时返回 `a` 原样。
 * 09-12 P0-01/P1-01:「累计成交 − 已平数量 = 现在还敞着的量」,撤单归属与减风险平仓共用这一条口径。
 */
export function subQty(a: string | null | undefined, b: string | null | undefined): string {
  const re = /^\d+(?:\.(\d+))?$/;
  const ma = re.exec(String(a ?? ''));
  const mb = re.exec(String(b ?? ''));
  if (!ma) return String(a ?? '0');
  if (!mb) return String(a);
  const scale = Math.max(ma[1]?.length ?? 0, mb[1]?.length ?? 0);
  const toInt = (m: RegExpExecArray): bigint => BigInt(m[0].replace('.', '').padEnd((m[0].split('.')[0]!.length) + scale, '0'));
  const diff = toInt(ma) - toInt(mb);
  if (diff <= 0n) return scale > 0 ? `0.${'0'.repeat(scale)}` : '0';
  const text = diff.toString().padStart(scale + 1, '0');
  return scale === 0 ? text : `${text.slice(0, -scale)}.${text.slice(-scale)}`;
}

/** `a > b`(十进制比较,不过浮点);任一边非法时 false。 */
export function qtyGreater(a: string | null | undefined, b: string | null | undefined): boolean {
  const re = /^\d+(?:\.\d+)?$/;
  if (!re.test(String(a ?? '')) || !re.test(String(b ?? ''))) return false;
  return Number(subQty(a, b)) > 0;
}

/** Stable, collision-resistant prefix for a thread's client order ids: `tgd-<sha1(thread id)[0..12]>`. */
export function threadClientPrefix(threadId: string): string {
  return `tgd-${createHash('sha1').update(threadId).digest('hex').slice(0, 12)}`;
}

/** Mints the next unique client order id for a leg (`e` entry, `s` stop, `t` tp, `x` close, `r` reduce) and bumps `leg_seq`. */
export function nextLegCid(t: StrategyThread, leg: 'e' | 's' | 't' | 'x' | 'r'): { cid: string; next: StrategyThread } {
  const seq = (t.leg_seq ?? 0) + 1;
  return { cid: `${threadClientPrefix(t.id)}-${leg}${seq}`, next: { ...t, leg_seq: seq } };
}
