// Judgment graph (docs/design/graph-engineering-v2.md): the one declarative place that says, for each
// node (judgment mode × thread status), which edges the MODEL may pick, what each edge does, which
// guards (code gates) sit on it, and which EVENTS move a symbol into which node. context.ts (allowed
// action list), threads.ts (reduceReview) and runtime.ts (effect dispatch / episode.graph) all read
// this; eval computes illegal_edge_attempts / edge_coverage / guard_hit_distribution / path_replay_ok
// from it. Pure data + pure functions, no I/O.

import type { Action, GateResult, StrategyThread, ThreadStatus, TriggerKind } from './types.js';

export type NodeId = 'scan' | 'scan:halted' | 'scan:stale' | 'scan:watch_only' | 'review:pending_entry' | 'review:in_position' | 'review:closed';

/** What the runtime does after the model picked an edge (the reducer's `effect`, plus the scan-side ones). */
export type Effect = 'none' | 'watch' | 'open_thread' | 'cancel_entry' | 'close' | 'reduce_half';

export type GuardId =
  | 'halt'
  | 'paused'
  | 'fresh_evidence'
  | 'no_position'
  | 'daily_open_cap'
  | 'stop_side'
  | 'stop_distance'
  | 'tp_side'
  | 'confidence_floor'
  | 'thread_limits'
  | 'no_unknown_orders'
  | 'preflight'
  | 'no_add'
  | 'thread_still_open'
  | 'strategy_consensus'
  | 'entry_style';

export interface ModelEdge {
  id: string;
  from: NodeId;
  action: Action;
  effect: Effect;
  guards: GuardId[];
  description: string;
}

/** `from` is the thread status the symbol is in before the event ('none' = no open thread). */
export interface EventEdge {
  id: string;
  event: TriggerKind;
  from: ThreadStatus | 'none';
  to: NodeId;
  description: string;
}

export interface JudgmentGraph {
  version: string;
  nodes: Record<NodeId, { allowed_actions: Action[]; description: string }>;
  model_edges: ModelEdge[];
  event_edges: EventEdge[];
  guards: Record<GuardId, { gate_name: string; description: string }>;
}

export const GRAPH_VERSION = 'judgment-graph-v3'; // v3: scan:watch_only 节点(只观察不交易的币) // v2: scan:stale 节点(行情快照过期时 PROPOSE 不是合法边)

// Guard ids ↔ the human-readable gate names emitted by gates.ts / runtime.ts (those strings are what
// the UI shows and what episodes store; the ids are what eval/graph reason about).
const GUARDS: JudgmentGraph['guards'] = {
  halt: { gate_name: '紧急停止', description: '紧急停止中不允许开仓' },
  paused: { gate_name: '暂停', description: '暂停中不开新仓' },
  fresh_evidence: { gate_name: '证据新鲜度', description: '开仓判断不能引用 STALE 证据' },
  no_position: { gate_name: '无持仓才能开仓', description: '本币已有持仓则不开' },
  daily_open_cap: { gate_name: '每日开仓上限', description: '当日开仓次数上限' },
  stop_side: { gate_name: '止损在正确一侧', description: '做多止损低于入场、做空高于入场' },
  stop_distance: { gate_name: '止损距离', description: '止损距离在 min–max % 之间' },
  tp_side: { gate_name: '止盈在正确一侧', description: '止盈方向与持仓方向一致' },
  confidence_floor: { gate_name: '信心下限', description: '开仓信心 ≥ 0.40' },
  thread_limits: { gate_name: '线程/日内限制', description: '同币已有线程 / 线程数上限 / 日开仓上限 / 日亏停' },
  no_unknown_orders: { gate_name: '没有状态不明的订单', description: '有 unknown 意图时不开新仓' },
  preflight: { gate_name: '提交前重闸', description: '下单前用最新账户/线程集重查一遍' },
  no_add: { gate_name: '演示版不加仓', description: 'ADD 只记录不执行' },
  thread_still_open: { gate_name: '线程仍开放', description: '判断期间线程已结束则整条复查作废' },
  entry_style: { gate_name: '入场方式', description: 'prefer_limit:已追出 1 ATR 的市价开仓(含会立刻成交的限价)被拒,改挂限价等回踩;limit_only:市价一律拒,除非策略规则写了 entry_mode=market_ok。只拒不改价格' },
  strategy_consensus: { gate_name: '策略共识', description: '策略议会 require 模式:PROPOSE 必须有多条策略同向共识,方向一致且 strategy_id 是同意方(advise/off 永远通过)' },
};

const OPEN_GUARDS: GuardId[] = ['halt', 'paused', 'fresh_evidence', 'no_position', 'daily_open_cap', 'stop_side', 'stop_distance', 'tp_side', 'confidence_floor', 'thread_limits', 'no_unknown_orders', 'strategy_consensus', 'entry_style', 'preflight'];

const MODEL_EDGES: ModelEdge[] = [
  { id: 'scan.NO_TRADE', from: 'scan', action: 'NO_TRADE', effect: 'none', guards: [], description: '没有优势,不建线程' },
  { id: 'scan.WATCH', from: 'scan', action: 'WATCH', effect: 'watch', guards: [], description: '有苗头,记为观察(不建线程)' },
  { id: 'scan.PROPOSE', from: 'scan', action: 'PROPOSE', effect: 'open_thread', guards: OPEN_GUARDS, description: '提议开仓;过全部闸才建线程并下单' },
  { id: 'halted.NO_TRADE', from: 'scan:halted', action: 'NO_TRADE', effect: 'none', guards: ['halt'], description: '紧急停止中唯一允许的输出' },
  { id: 'stale.NO_TRADE', from: 'scan:stale', action: 'NO_TRADE', effect: 'none', guards: [], description: '行情快照过期:不开仓' },
  { id: 'stale.WATCH', from: 'scan:stale', action: 'WATCH', effect: 'watch', guards: [], description: '行情快照过期:只能记观察条件,等新鲜行情再判' },
  { id: 'watch_only.NO_TRADE', from: 'scan:watch_only', action: 'NO_TRADE', effect: 'none', guards: [], description: '只观察的币:不开仓' },
  { id: 'watch_only.WATCH', from: 'scan:watch_only', action: 'WATCH', effect: 'watch', guards: [], description: '只观察的币:记观察条件' },
  { id: 'pending.HOLD', from: 'review:pending_entry', action: 'HOLD', effect: 'none', guards: ['thread_still_open'], description: '挂单继续等' },
  { id: 'pending.INVALIDATE', from: 'review:pending_entry', action: 'INVALIDATE', effect: 'cancel_entry', guards: ['thread_still_open'], description: '论点失效,撤入场单' },
  { id: 'position.HOLD', from: 'review:in_position', action: 'HOLD', effect: 'none', guards: ['thread_still_open'], description: '论点仍成立,继续持有' },
  { id: 'position.REDUCE', from: 'review:in_position', action: 'REDUCE', effect: 'reduce_half', guards: ['thread_still_open'], description: '减半' },
  { id: 'position.EXIT', from: 'review:in_position', action: 'EXIT', effect: 'close', guards: ['thread_still_open'], description: '复查决定离场' },
  { id: 'position.INVALIDATE', from: 'review:in_position', action: 'INVALIDATE', effect: 'close', guards: ['thread_still_open'], description: '论点失效,平仓' },
];

const SCAN_EVENTS: TriggerKind[] = ['kline_close', 'scan', 'manual', 'chat', 'heartbeat', 'breakout', 'ema_cross', 'vol_spike', 'retest', 'fast_move', 'session', 'funding', 'schedule'];
const REVIEW_EVENTS: TriggerKind[] = ['kline_close', 'manual', 'chat', 'heartbeat', 'info_update', 'order_filled', 'tp_hit', 'sl_hit', 'thread_review', 'position_review', 'fast_move', 'breakout', 'ema_cross', 'vol_spike', 'retest', 'session', 'funding', 'monitor'];

const EVENT_EDGES: EventEdge[] = [
  ...SCAN_EVENTS.map((event): EventEdge => ({ id: `none.${event}`, event, from: 'none', to: 'scan', description: `无线程的币被 ${event} 唤醒 → 扫描` })),
  ...REVIEW_EVENTS.map((event): EventEdge => ({ id: `pending_entry.${event}`, event, from: 'pending_entry', to: 'review:pending_entry', description: `挂单中的线程被 ${event} 唤醒 → 复查` })),
  ...REVIEW_EVENTS.map((event): EventEdge => ({ id: `in_position.${event}`, event, from: 'in_position', to: 'review:in_position', description: `持仓中的线程被 ${event} 唤醒 → 复查` })),
];

export const JUDGMENT_GRAPH: JudgmentGraph = {
  version: GRAPH_VERSION,
  nodes: {
    scan: { allowed_actions: ['NO_TRADE', 'WATCH', 'PROPOSE'], description: '本币无线程,判断有没有符合 playbook 的机会' },
    'scan:halted': { allowed_actions: ['NO_TRADE'], description: '紧急停止中:只能 NO_TRADE(契约要求必须输出一个 action,给显式集合而不是空集)' },
    'scan:watch_only': { allowed_actions: ['NO_TRADE', 'WATCH'], description: '用户把这个币标成「只观察」:PROPOSE 不是合法边,判断照常记录以便日后看它值不值得开放交易' },
    'scan:stale': { allowed_actions: ['NO_TRADE', 'WATCH'], description: '行情快照(最新价/标记价)已过期:PROPOSE 不是合法边——过期开仓从「模型自觉遵守规则 4」提到图层,模型输出 PROPOSE 直接算非法边(eval v6:GLM 在 4/30 个 stale case 上无视规则 4,全靠闸兜底)' },
    'review:pending_entry': { allowed_actions: ['HOLD', 'INVALIDATE'], description: '挂单未成交的线程复查' },
    'review:in_position': { allowed_actions: ['HOLD', 'REDUCE', 'EXIT', 'INVALIDATE'], description: '持仓中的线程复查' },
    'review:closed': { allowed_actions: [], description: '线程已结束,复查作废' },
  },
  model_edges: MODEL_EDGES,
  event_edges: EVENT_EDGES,
  guards: GUARDS,
};

/** Which node a symbol is judged at. `thread` = the thread under review (review mode) or null (scan). */
export function nodeFor(thread: StrategyThread | null, halted: boolean, marketStale = false, watchOnly = false): NodeId {
  if (thread) {
    if (thread.status === 'pending_entry') return 'review:pending_entry';
    if (thread.status === 'in_position') return 'review:in_position';
    return 'review:closed';
  }
  if (halted) return 'scan:halted';
  if (marketStale) return 'scan:stale';
  return watchOnly ? 'scan:watch_only' : 'scan';
}

export function allowedActions(node: NodeId, g: JudgmentGraph = JUDGMENT_GRAPH): Action[] {
  return [...g.nodes[node].allowed_actions];
}

/** The model edge for (node, action), or null when the action is not allowed there (an illegal edge attempt). */
export function edgeFor(node: NodeId, action: Action, g: JudgmentGraph = JUDGMENT_GRAPH): ModelEdge | null {
  return g.model_edges.find((e) => e.from === node && e.action === action) ?? null;
}

/** The event edge that wakes a symbol in status `from` on `event`, or null when that event never leads to a judgment there. */
export function eventEdgeFor(event: TriggerKind, from: ThreadStatus | 'none', g: JudgmentGraph = JUDGMENT_GRAPH): EventEdge | null {
  return g.event_edges.find((e) => e.event === event && e.from === from) ?? null;
}

export function guardIdForGate(gateName: string, g: JudgmentGraph = JUDGMENT_GRAPH): GuardId | null {
  for (const [id, v] of Object.entries(g.guards) as [GuardId, { gate_name: string }][]) if (v.gate_name === gateName) return id;
  return null;
}

/** Guard ids from a list of evaluated gates (unknown gate names are kept verbatim so nothing is lost). */
export function guardsFromGates(gates: GateResult[], g: JudgmentGraph = JUDGMENT_GRAPH): string[] {
  return gates.map((x) => guardIdForGate(x.name, g) ?? x.name);
}

/** Structural sanity: every allowed action has exactly one edge and vice versa; guards referenced exist. */
export function validateGraph(g: JudgmentGraph = JUDGMENT_GRAPH): string[] {
  const errors: string[] = [];
  for (const [node, spec] of Object.entries(g.nodes) as [NodeId, JudgmentGraph['nodes'][NodeId]][]) {
    const edges = g.model_edges.filter((e) => e.from === node);
    for (const a of spec.allowed_actions) if (edges.filter((e) => e.action === a).length !== 1) errors.push(`${node}: action ${a} must have exactly one edge`);
    for (const e of edges) if (!spec.allowed_actions.includes(e.action)) errors.push(`${node}: edge ${e.id} uses action ${e.action} not in allowed_actions`);
  }
  const ids = new Set<string>();
  for (const e of [...g.model_edges.map((e) => e.id), ...g.event_edges.map((e) => e.id)]) {
    if (ids.has(e)) errors.push(`duplicate edge id ${e}`);
    ids.add(e);
  }
  for (const e of g.model_edges) for (const gd of e.guards) if (!(gd in g.guards)) errors.push(`edge ${e.id} references unknown guard ${gd}`);
  for (const e of g.event_edges) if (!(e.to in g.nodes)) errors.push(`event edge ${e.id} points to unknown node ${e.to}`);
  return errors;
}

/** Mermaid for docs/demo/graph.md (generated by `npm run graph:md --workspace packages/gateway`). */
export function toMermaid(g: JudgmentGraph = JUDGMENT_GRAPH): string {
  const nid = (n: string): string => n.replace(/[^a-zA-Z0-9]/g, '_');
  const lines: string[] = ['flowchart LR'];
  lines.push('  subgraph status[线程状态]');
  lines.push('    none[无线程]');
  lines.push('    pending_entry[pending_entry 挂单中]');
  lines.push('    in_position[in_position 持仓中]');
  lines.push('  end');
  lines.push('  subgraph nodes[判断节点]');
  for (const [node, spec] of Object.entries(g.nodes)) lines.push(`    ${nid(node)}["${node}<br/>${spec.allowed_actions.join(' / ') || '(无)'}"]`);
  lines.push('  end');
  const byTarget = new Map<string, string[]>();
  for (const e of g.event_edges) {
    const k = `${e.from}->${e.to}`;
    byTarget.set(k, [...(byTarget.get(k) ?? []), e.event]);
  }
  for (const [k, events] of byTarget) {
    const [from, to] = k.split('->') as [string, string];
    lines.push(`  ${nid(from)} -. "${events.join(', ')}" .-> ${nid(to)}`);
  }
  const effectNode: Record<Effect, string> = { none: 'effect_none[不动]', watch: 'effect_watch[记为观察]', open_thread: 'effect_open[建线程 + 下单]', cancel_entry: 'effect_cancel[撤入场单]', close: 'effect_close[平仓]', reduce_half: 'effect_reduce[减半]' };
  const used = new Set<Effect>();
  for (const e of g.model_edges) {
    used.add(e.effect);
    const target = effectNode[e.effect].split('[')[0]!;
    lines.push(`  ${nid(e.from)} -- "${e.action}${e.guards.length ? ` ⛩${e.guards.length}` : ''}" --> ${target}`);
  }
  for (const eff of used) lines.push(`  ${effectNode[eff]}`);
  return lines.join('\n');
}

export function graphMarkdown(g: JudgmentGraph = JUDGMENT_GRAPH): string {
  const out: string[] = [`# 判断图(${g.version};由 \`graph.ts\` 生成,不要手改)`, '', '```mermaid', toMermaid(g), '```', '', '## 节点', '', '| 节点 | 允许的 action | 说明 |', '|---|---|---|'];
  for (const [node, spec] of Object.entries(g.nodes)) out.push(`| ${node} | ${spec.allowed_actions.join(' / ') || '(无)'} | ${spec.description} |`);
  out.push('', '## 模型边', '', '| id | 节点 | action | 效果 | 闸 | 说明 |', '|---|---|---|---|---|---|');
  for (const e of g.model_edges) out.push(`| ${e.id} | ${e.from} | ${e.action} | ${e.effect} | ${e.guards.join(', ') || '—'} | ${e.description} |`);
  out.push('', '## 闸', '', '| id | 界面名 | 说明 |', '|---|---|---|');
  for (const [id, v] of Object.entries(g.guards)) out.push(`| ${id} | ${v.gate_name} | ${v.description} |`);
  out.push('', '## 事件边', '', '| 线程状态 | 事件 | 目标节点 |', '|---|---|---|');
  const grouped = new Map<string, string[]>();
  for (const e of g.event_edges) grouped.set(`${e.from}|${e.to}`, [...(grouped.get(`${e.from}|${e.to}`) ?? []), e.event]);
  for (const [k, events] of grouped) {
    const [from, to] = k.split('|');
    out.push(`| ${from} | ${events.join(', ')} | ${to} |`);
  }
  return out.join('\n') + '\n';
}
