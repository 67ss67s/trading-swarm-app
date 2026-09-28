import { describe, expect, it } from 'vitest';
import { demo } from '@trade-gate/gateway';
import { analyzeRow, computeMetrics, edgeCoverage, firstAction, graphOf, graphRow, guardHits, runEpisode, triggerPrecision, type EpisodeRecord, type EvalCase, type GraphRow } from '../src/index.js';
import { synthCases } from './helpers/synthetic.js';

const judgment = (action: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ action, direction: null, confidence: 0.3, headline: '测试', thesis: '测试论点', reasons: ['理由 [E1]'], evidence_refs: ['E1'], watch_conditions: [], ...extra });

const brainSaying = (obj: Record<string, unknown>): demo.Brain => ({ name: 'fake:graph', complete: async () => ({ text: JSON.stringify(obj), latency_ms: 1, model: 'fake:graph', input_tokens: 1, output_tokens: 1 }) });

async function reviewCase(): Promise<EvalCase> {
  const cases = await synthCases({ n: 2 }, 3);
  const c = cases.find((x) => x.mode === 'review' && x.thread);
  if (!c) throw new Error('synthetic set has no review case');
  return c;
}

function rowsFor(pairs: [EvalCase, EpisodeRecord][]): { rows: ReturnType<typeof analyzeRow>[]; cases: Map<string, EvalCase> } {
  return { rows: pairs.map(([c, ep]) => analyzeRow(c, ep)), cases: new Map(pairs.map(([c]) => [c.id, c])) };
}

describe('judgment graph metrics', () => {
  it('records node / edge / guards on every episode a run writes', async () => {
    const c = await reviewCase();
    const ep = await runEpisode(c, brainSaying(judgment('HOLD')), null);
    expect(ep.graph).toBeDefined();
    expect(ep.graph!.version).toBe(demo.GRAPH_VERSION);
    expect(ep.graph!.node).toBe(c.thread!.status === 'pending_entry' ? 'review:pending_entry' : 'review:in_position');
    expect(ep.graph!.edge).toBe(c.thread!.status === 'pending_entry' ? 'pending.HOLD' : 'position.HOLD');
    expect(ep.graph!.illegal_action).toBeNull();
    expect(ep.graph!.edge).toBe(demo.reduceReview(c.thread!, ep.judgment).edge); // review edges come from the reducer
    expect(ep.graph!.guards).toEqual(demo.edgeFor(ep.graph!.node as demo.NodeId, ep.judgment.action)!.guards); // review: the edge's guards, never the opening gates
    expect(graphOf(c, ep).backfilled).toBe(false);
  });

  it('counts an action with no edge at its node as an illegal edge attempt (and the reducer refuses it)', async () => {
    const c = await reviewCase();
    const ep = await runEpisode(c, brainSaying(judgment('NO_TRADE')), null); // scan-only action inside a review
    expect(ep.judgment.action).toBe('NO_TRADE');
    expect(ep.graph!.edge).toBeNull();
    expect(ep.graph!.illegal_action).toBe('NO_TRADE');
    expect(ep.review!.accepted).toBe(false);

    const { rows, cases } = rowsFor([[c, ep]]);
    expect(rows[0]!.graph.illegal).toMatchObject({ action: 'NO_TRADE', from: 'raw' });
    const m = computeMetrics(rows, cases).metrics;
    const illegal = m.find((x) => x.name === 'illegal_edge_attempts')!;
    expect(illegal.value).toBe(1);
    expect(illegal.status).toBe('FAIL');
    // an illegal action is still replayable: no edge on either side, reducer refused
    expect(m.find((x) => x.name === 'path_replay_ok')!.value).toBe(1);
  });

  it('judges the FIRST raw output, not the fail-closed / repaired action that overwrote it', async () => {
    const c = await reviewCase();
    const ep = await runEpisode(c, brainSaying(judgment('HOLD')), null);
    // simulate: model first said REDUCE (illegal on a pending_entry thread), harness fell back to HOLD
    const masked: EpisodeRecord = { ...ep, raw: JSON.stringify(judgment('REDUCE')), judgment_source: 'fail_closed', graph: { ...ep.graph!, node: 'review:pending_entry', edge: 'pending.HOLD' }, judgment: { ...ep.judgment, action: 'HOLD' }, review: { accepted: true, reason: '继续等入场', effect: 'none' } };
    expect(firstAction(masked)).toEqual({ action: 'REDUCE', from: 'raw' });
    const row = graphRow(c, masked);
    expect(row.illegal).toMatchObject({ action: 'REDUCE', node: 'review:pending_entry', from: 'raw' });
    expect(row.final_action).toBe('HOLD');
    expect(row.replay.ok).toBe(true); // the *recorded* path (HOLD → pending.HOLD → none) still replays

    // unreadable first output → fall back to the final judgment
    expect(firstAction({ ...masked, raw: 'not json' })).toEqual({ action: 'HOLD', from: 'judgment' });
  });

  it('back-fills the graph field for runs made before the graph existed', async () => {
    const c = await reviewCase();
    const ep = await runEpisode(c, brainSaying(judgment('HOLD')), null);
    const old: EpisodeRecord = { ...ep };
    delete old.graph;
    const { graph, backfilled } = graphOf(c, old);
    expect(backfilled).toBe(true);
    expect(graph.node).toBe(ep.graph!.node);
    expect(graph.edge).toBe(ep.graph!.edge);
    expect(graph.version).toBe(demo.GRAPH_VERSION);

    const { rows, cases } = rowsFor([[c, old]]);
    const m = computeMetrics(rows, cases).metrics;
    expect(m.find((x) => x.name === 'illegal_edge_attempts')!.note).toContain('回填');
    expect(m.find((x) => x.name === 'path_replay_ok')!.value).toBe(1);
  });

  it('fails path_replay_ok when the recorded edge or the reducer effect cannot be rebuilt', async () => {
    const c = await reviewCase();
    const ep = await runEpisode(c, brainSaying(judgment('HOLD')), null);

    const wrongEdge: EpisodeRecord = { ...ep, graph: { ...ep.graph!, edge: 'position.EXIT' } };
    expect(graphRow(c, wrongEdge).replay.ok).toBe(false);
    expect(graphRow(c, wrongEdge).replay.problems.join(' ')).toContain('≠ 记录的边');

    const wrongEffect: EpisodeRecord = { ...ep, review: { accepted: true, reason: 'x', effect: 'close' } };
    expect(graphRow(c, wrongEffect).replay.problems.join(' ')).toContain('重建的效果');

    const wrongNode: EpisodeRecord = { ...ep, graph: { ...ep.graph!, node: 'review:atlantis' } };
    expect(graphRow(c, wrongNode).replay.ok).toBe(false);

    const { rows, cases } = rowsFor([[c, wrongEdge]]);
    const replay = computeMetrics(rows, cases).metrics.find((x) => x.name === 'path_replay_ok')!;
    expect(replay.value).toBe(0);
    expect(replay.status).toBe('FAIL');
  });

  it('reports edge coverage against the whole graph, with the edges nobody walked', () => {
    const g = demo.JUDGMENT_GRAPH;
    const row = (edge: string | null, event: string | null): GraphRow => ({ case_id: 'x', node: 'scan', edge, guards: [], backfilled: false, first_action: 'NO_TRADE', first_action_from: 'raw', final_action: 'NO_TRADE', illegal: null, event_edge: event, guards_rejected: [], replay: { ok: true, problems: [], effect: 'none', reducer_effect: null } });
    const cov = edgeCoverage([row('scan.NO_TRADE', 'none.kline_close'), row('scan.WATCH', 'none.kline_close'), row(null, null)]);
    expect(cov.model_covered).toEqual(['scan.NO_TRADE', 'scan.WATCH']);
    expect(cov.model_missing).toContain('scan.PROPOSE');
    expect(cov.model_covered.length + cov.model_missing.length).toBe(g.model_edges.length);
    expect(cov.model_ratio).toBeCloseTo(2 / g.model_edges.length);
    expect(cov.event_covered).toEqual(['none.kline_close']);
    expect(cov.event_ratio).toBeCloseTo(1 / g.event_edges.length);
  });

  it('groups gate rejections under their guard id, biggest first', () => {
    const row = (rejected: string[]): GraphRow => ({ case_id: 'x', node: 'scan', edge: 'scan.PROPOSE', guards: [], backfilled: false, first_action: 'PROPOSE', first_action_from: 'raw', final_action: 'PROPOSE', illegal: null, event_edge: null, guards_rejected: rejected, replay: { ok: true, problems: [], effect: 'open_thread', reducer_effect: null } });
    const hits = guardHits([row(['stop_distance']), row(['stop_distance', 'confidence_floor']), row([])]);
    expect(Object.keys(hits.rejections)).toEqual(['stop_distance', 'confidence_floor']);
    expect(hits.rejections['stop_distance']).toBe(2);
    expect(hits.episodes_with_rejection).toBe(2);
    expect(hits.never_rejected).toContain('halt');
    expect(demo.guardIdForGate('止损距离')).toBe('stop_distance');
  });

  it('scores triggers by kind and leaves the report honest about what it could not compute', async () => {
    const cases = await synthCases({ n: 2 }, 3);
    const tp = triggerPrecision(cases);
    expect(tp.summary.cases).toBe(cases.filter((c) => c.mode === 'scan' && !c.tags.includes('stale') && !c.tags.includes('halted')).length);
    for (const t of tp.checks) {
      if (t.valid !== null) expect(t.direction === 'long' || t.direction === 'short').toBe(true);
      if (t.direction === null) expect(t.valid).toBeNull();
    }
    // the in-sample supplement always has something to say on a 60-bar window
    expect(tp.in_sample.hits).toBeGreaterThan(0);
    for (const [, v] of Object.entries(tp.in_sample.by_kind)) expect(v.precision).toBe(Math.round((v.valid / v.n) * 10000) / 10000);
    expect(tp.in_sample.precision).toBeGreaterThanOrEqual(0);

    const c = cases.find((x) => x.mode === 'scan')!;
    const ep = await runEpisode(c, brainSaying(judgment('WATCH', { direction: 'long' })), null);
    const { rows, cases: map } = rowsFor([[c, ep]]);
    const metrics = computeMetrics(rows, map).metrics;
    const regime = metrics.find((m) => m.name === 'regime_agreement')!;
    expect(regime.status).toBe('NOT_IMPLEMENTED');
    expect(regime.note).toContain("visible.klines['1d']");
    expect(metrics.find((m) => m.name === 'trigger_precision')!.status).toBe('INFO');
  });
});
