// Judgment-graph metrics (docs/design/graph-engineering-v2.md §3): illegal_edge_attempts,
// edge_coverage, guard_hit_distribution, path_replay_ok. Pure functions over (case, episode) — the
// graph itself is never redefined here, it is read from `demo.JUDGMENT_GRAPH` through
// nodeFor / edgeFor / eventEdgeFor / guardsFromGates so eval and runtime can never drift apart.

import { demo } from '@trading-swarm/gateway';
import type { Action, EpisodeRecord, EvalCase } from './types.js';

/** What `run` writes into every episode; older runs (pi-v1, pi-v3) have no such field and get it back-filled. */
export interface EpisodeGraph {
  version: string;
  node: string;
  edge: string | null;
  guards: string[];
  illegal_action: string | null;
}

const ACTIONS: readonly string[] = ['NO_TRADE', 'WATCH', 'PROPOSE', 'HOLD', 'ADD', 'REDUCE', 'EXIT', 'INVALIDATE'];

export const isNodeId = (n: string): n is demo.NodeId => n in demo.JUDGMENT_GRAPH.nodes;

/** `edgeFor` with a string node: unknown node ids (a graph version we cannot read) yield null. */
export function edgeIdFor(node: string, action: Action): string | null {
  if (!isNodeId(node)) return null;
  return demo.edgeFor(node, action)?.id ?? null;
}

export function effectFor(node: string, action: Action): demo.Effect | null {
  if (!isNodeId(node)) return null;
  return demo.edgeFor(node, action)?.effect ?? null;
}

/** The node a case is judged at, from the case alone (`buildContext` computes the same thing). */
export function nodeForCase(c: EvalCase): demo.NodeId {
  return demo.nodeFor(c.mode === 'review' ? c.thread : null, c.visible.halted);
}

/**
 * The action the model *first* produced. fail-closed and repair rounds overwrite an illegal action with
 * a legal default, so an episode with a raw first output is judged on that raw action; only when the raw
 * text has no readable `action` do we fall back to the final judgment.
 */
export function firstAction(ep: EpisodeRecord): { action: Action; from: 'raw' | 'judgment' } {
  if (ep.raw) {
    try {
      const obj = demo.extractJson(ep.raw) as Record<string, unknown>;
      const a = obj['action'];
      if (typeof a === 'string' && ACTIONS.includes(a)) return { action: a as Action, from: 'raw' };
    } catch {
      /* unreadable first output: nothing to judge, fall through */
    }
  }
  return { action: ep.judgment.action, from: 'judgment' };
}

/**
 * The episode's graph record. Runs made before the graph landed carry none, so it is re-derived from
 * (mode, thread, halted) + the final judgment + the recorded gates; `backfilled` says which happened,
 * and the report prints that so nobody reads a back-filled path_replay_ok as a real replay.
 */
/**
 * Guard ids an episode should carry, same convention as the runtime: review episodes never run the opening
 * gates, so they carry the guards declared on the edge they took (`thread_still_open`); scan episodes carry
 * the guard ids of the gates actually evaluated.
 */
export function expectedGuards(node: string, action: string, gates: EpisodeRecord['gates']): string[] {
  if (node.startsWith('review')) return demo.edgeFor(node as demo.NodeId, action as demo.Action)?.guards ?? [];
  return demo.guardsFromGates(gates);
}

export function graphOf(c: EvalCase, ep: EpisodeRecord): { graph: EpisodeGraph; backfilled: boolean } {
  if (ep.graph) return { graph: { ...ep.graph, illegal_action: ep.graph.illegal_action ?? null }, backfilled: false };
  const node = nodeForCase(c);
  const edge = edgeIdFor(node, ep.judgment.action);
  return {
    graph: { version: demo.GRAPH_VERSION, node, edge, guards: expectedGuards(node, ep.judgment.action, ep.gates), illegal_action: edge ? null : ep.judgment.action },
    backfilled: true,
  };
}

/** The event edge this case entered its node through (`trigger.kind` × the thread status before the event). */
export function eventEdgeIdFor(c: EvalCase, ep: EpisodeRecord): string | null {
  const from = c.mode === 'review' && c.thread ? c.thread.status : 'none';
  return demo.eventEdgeFor(ep.trigger.kind, from)?.id ?? null;
}

export interface GraphRow {
  case_id: string;
  node: string;
  /** Edge as recorded by the run (or back-filled from the final judgment). */
  edge: string | null;
  guards: string[];
  backfilled: boolean;
  /** Action the model first emitted (pre-repair, pre-fail-closed) and where it came from. */
  first_action: Action;
  first_action_from: 'raw' | 'judgment';
  final_action: Action;
  /** Non-null when the first action has no edge at this node. */
  illegal: { action: Action; node: string; allowed: string[]; from: 'raw' | 'judgment' } | null;
  event_edge: string | null;
  /** Guard ids that rejected (gates with passed=false, gate name → guard id). */
  guards_rejected: string[];
  replay: { ok: boolean; problems: string[]; effect: demo.Effect | null; reducer_effect: string | null };
}

/**
 * path_replay_ok for one episode: from (node, final action, gates) alone, rebuild the edge and its
 * effect and require them to agree with everything the run recorded — the edge id, the guard list, and,
 * for review episodes, the reducer's own `effect` / `accepted`. An illegal action replays fine (edge
 * null on both sides, reducer refused): legality is `illegal_edge_attempts`' job, not this one.
 */
export function replayEpisode(g: EpisodeGraph, ep: EpisodeRecord): GraphRow['replay'] {
  const problems: string[] = [];
  const node = g.node;
  if (!isNodeId(node)) problems.push(`记录的节点 ${node} 不在图 ${demo.GRAPH_VERSION} 里`);
  const action = ep.judgment.action;
  const matches = isNodeId(node) ? demo.JUDGMENT_GRAPH.model_edges.filter((e) => e.from === node && e.action === action) : [];
  if (matches.length > 1) problems.push(`节点 ${node} 上 ${action} 有 ${matches.length} 条边,重建有歧义`);
  const rebuilt = matches[0] ?? null;
  const rebuiltId = rebuilt?.id ?? null;
  if (rebuiltId !== g.edge) problems.push(`重建的边 ${rebuiltId ?? 'null'} ≠ 记录的边 ${g.edge ?? 'null'}`);
  const rebuiltGuards = expectedGuards(node, action, ep.gates);
  if (g.guards.length && rebuiltGuards.join(',') !== g.guards.join(',')) problems.push(`重建的闸 [${rebuiltGuards.join(',')}] ≠ 记录的闸 [${g.guards.join(',')}]`);
  const effect = rebuilt?.effect ?? null;
  const reducerEffect = ep.review ? ep.review.effect : null;
  if (ep.review) {
    if (rebuilt === null && ep.review.accepted) problems.push(`图上没有 ${node} + ${action} 这条边,reducer 却接受了`);
    if (rebuilt !== null && !ep.review.accepted) problems.push(`图上有边 ${rebuilt.id}(效果 ${rebuilt.effect}),reducer 却拒绝了`);
    if (rebuilt !== null && ep.review.accepted && ep.review.effect !== rebuilt.effect) problems.push(`重建的效果 ${rebuilt.effect} ≠ reducer 记录的 ${ep.review.effect}`);
  }
  return { ok: problems.length === 0, problems, effect, reducer_effect: reducerEffect };
}

export function graphRow(c: EvalCase, ep: EpisodeRecord): GraphRow {
  const { graph, backfilled } = graphOf(c, ep);
  const first = firstAction(ep);
  const firstEdge = edgeIdFor(graph.node, first.action);
  const allowed = isNodeId(graph.node) ? demo.allowedActions(graph.node) : [];
  return {
    case_id: c.id,
    node: graph.node,
    edge: graph.edge,
    guards: graph.guards,
    backfilled,
    first_action: first.action,
    first_action_from: first.from,
    final_action: ep.judgment.action,
    illegal: firstEdge ? null : { action: first.action, node: graph.node, allowed, from: first.from },
    event_edge: eventEdgeIdFor(c, ep),
    guards_rejected: ep.gates.filter((x) => !x.passed).map((x) => demo.guardIdForGate(x.name) ?? x.name),
    replay: replayEpisode(graph, ep),
  };
}

export interface EdgeCoverage {
  model_covered: string[];
  model_missing: string[];
  model_ratio: number;
  event_covered: string[];
  event_missing: string[];
  event_ratio: number;
}

export function edgeCoverage(rows: GraphRow[]): EdgeCoverage {
  const g = demo.JUDGMENT_GRAPH;
  const model = new Set(rows.map((r) => r.edge).filter((x): x is string => x !== null));
  const event = new Set(rows.map((r) => r.event_edge).filter((x): x is string => x !== null));
  const modelIds = g.model_edges.map((e) => e.id);
  const eventIds = g.event_edges.map((e) => e.id);
  return {
    model_covered: modelIds.filter((id) => model.has(id)),
    model_missing: modelIds.filter((id) => !model.has(id)),
    model_ratio: modelIds.length ? modelIds.filter((id) => model.has(id)).length / modelIds.length : 0,
    event_covered: eventIds.filter((id) => event.has(id)),
    event_missing: eventIds.filter((id) => !event.has(id)),
    event_ratio: eventIds.length ? eventIds.filter((id) => event.has(id)).length / eventIds.length : 0,
  };
}

/** guard id → how many episodes it rejected, biggest first; guards that never rejected are listed too. */
export function guardHits(rows: GraphRow[]): { rejections: Record<string, number>; never_rejected: string[]; episodes_with_rejection: number } {
  const counts: Record<string, number> = {};
  let episodes = 0;
  for (const r of rows) {
    if (r.guards_rejected.length) episodes++;
    for (const id of r.guards_rejected) counts[id] = (counts[id] ?? 0) + 1;
  }
  const sorted = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  const never = Object.keys(demo.JUDGMENT_GRAPH.guards).filter((id) => !(id in counts));
  return { rejections: sorted, never_rejected: never, episodes_with_rejection: episodes };
}
