import { describe, expect, it } from 'vitest';
import { JUDGMENT_GRAPH, allowedActions, edgeFor, eventEdgeFor, guardIdForGate, guardsFromGates, nodeFor, toMermaid, validateGraph, graphMarkdown } from '../../src/demo/graph.js';
import { allowedReviewActions, newThread, reduceReview } from '../../src/demo/threads.js';
import { buildContext } from '../../src/demo/context.js';
import type { Judgment, StrategyThread } from '../../src/demo/types.js';
import { evaluateGates } from '../../src/demo/gates.js';

const thread = (status: StrategyThread['status']): StrategyThread => ({
  ...newThread({ id: 't1', symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '15m', thesis: 'x', invalidation_text: null, watch_conditions: [], entry: { type: 'market', price: null, zone: null }, stop_price: '90', take_profits: ['120'], qty: '1', margin_usdt: null, leverage: 3, margin_mode: 'cross', now: 1 }),
  status,
});

const judgment = (action: Judgment['action']): Judgment => ({ action, direction: 'long', confidence: 0.6, headline: 'h', thesis: 't', reasons: ['r [E1]'], evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [], proposal: null });

describe('judgment graph', () => {
  it('is structurally consistent', () => {
    expect(validateGraph()).toEqual([]);
  });

  it('maps thread status / halt to nodes', () => {
    expect(nodeFor(null, false)).toBe('scan');
    expect(nodeFor(null, true)).toBe('scan:halted');
    expect(nodeFor(null, false, true)).toBe('scan:stale');
    expect(nodeFor(null, true, true)).toBe('scan:halted'); // halted 优先于 stale
    expect(nodeFor(null, false, false, true)).toBe('scan:watch_only');
    expect(nodeFor(null, false, true, true)).toBe('scan:stale'); // stale 优先于 watch_only
    expect(nodeFor(thread('pending_entry'), false)).toBe('review:pending_entry');
    expect(nodeFor(thread('in_position'), true)).toBe('review:in_position');
    expect(nodeFor(thread('closed'), false)).toBe('review:closed');
  });

  it('allowed actions match what threads.ts used to hard-code', () => {
    expect(allowedActions('scan')).toEqual(['NO_TRADE', 'WATCH', 'PROPOSE']);
    expect(allowedActions('scan:halted')).toEqual(['NO_TRADE']);
    expect(allowedActions('scan:stale')).toEqual(['NO_TRADE', 'WATCH']); // graph v2:过期行情下 PROPOSE 不是合法边
    expect(allowedActions('scan:watch_only')).toEqual(['NO_TRADE', 'WATCH']); // graph v3:只观察的币
    expect(allowedReviewActions(thread('pending_entry'))).toEqual(['HOLD', 'INVALIDATE']);
    expect(allowedReviewActions(thread('in_position'))).toEqual(['HOLD', 'REDUCE', 'EXIT', 'INVALIDATE']);
    expect(allowedReviewActions(thread('closed'))).toEqual([]);
  });

  it('edgeFor returns null for illegal edges and the reducer rejects them with edge=null', () => {
    expect(edgeFor('scan', 'HOLD')).toBeNull();
    expect(edgeFor('review:pending_entry', 'REDUCE')).toBeNull();
    expect(edgeFor('review:in_position', 'PROPOSE')).toBeNull();
    const d = reduceReview(thread('pending_entry'), judgment('EXIT'));
    expect(d.accepted).toBe(false);
    expect(d.edge).toBeNull();
    expect(d.effect).toBe('none');
  });

  it('reducer effects come from the graph', () => {
    expect(reduceReview(thread('pending_entry'), judgment('INVALIDATE'))).toMatchObject({ accepted: true, effect: 'cancel_entry', edge: 'pending.INVALIDATE' });
    expect(reduceReview(thread('in_position'), judgment('INVALIDATE'))).toMatchObject({ accepted: true, effect: 'close', edge: 'position.INVALIDATE', patch: { close_reason: '论点失效(复查)' } });
    expect(reduceReview(thread('in_position'), judgment('EXIT'))).toMatchObject({ accepted: true, effect: 'close', edge: 'position.EXIT', patch: { close_reason: '复查离场' } });
    expect(reduceReview(thread('in_position'), judgment('REDUCE'))).toMatchObject({ accepted: true, effect: 'reduce_half', edge: 'position.REDUCE' });
    expect(reduceReview(thread('in_position'), judgment('HOLD'))).toMatchObject({ accepted: true, effect: 'none', edge: 'position.HOLD' });
  });

  it('event edges: no thread → scan, open thread → review, closed thread → nothing', () => {
    expect(eventEdgeFor('kline_close', 'none')?.to).toBe('scan');
    expect(eventEdgeFor('order_filled', 'in_position')?.to).toBe('review:in_position');
    expect(eventEdgeFor('order_filled', 'none')).toBeNull();
    expect(eventEdgeFor('kline_close', 'closed')).toBeNull();
  });

  it('every gate name gates.ts emits maps to a guard id', () => {
    const j: Judgment = { ...judgment('PROPOSE'), proposal: { direction: 'long', entry: 'market', limit_price: null, entry_zone: null, stop_price: '99', take_profit_price: '103', take_profits: ['103'], rationale: 'r' } };
    const gates = evaluateGates(j, { halted: false, paused: false, account: { backend: 'paper', equity: '10000', available: '10000', unrealized_pnl: '0', positions: [], open_orders: [], as_of: 1 }, market: { symbol: 'BTCUSDT', last: '100', mark: '100', funding_rate: '0', next_funding_at: 0, open_interest: '0', as_of: 1, klines_tf: '15m' }, opens_today: 0, stale_refs: new Set() });
    for (const g of gates) expect(guardIdForGate(g.name), g.name).not.toBeNull();
    const ids = guardsFromGates(gates);
    for (const id of ids) expect(id in JUDGMENT_GRAPH.guards).toBe(true);
    expect(guardIdForGate('线程/日内限制')).toBe('thread_limits');
    expect(guardIdForGate('没有状态不明的订单')).toBe('no_unknown_orders');
    expect(guardIdForGate('提交前重闸')).toBe('preflight');
  });

  it('all PROPOSE guards are declared on the scan.PROPOSE edge', () => {
    const e = edgeFor('scan', 'PROPOSE')!;
    for (const g of ['halt', 'paused', 'fresh_evidence', 'stop_side', 'stop_distance', 'confidence_floor', 'thread_limits', 'no_unknown_orders', 'preflight']) expect(e.guards).toContain(g);
  });

  it('buildContext reports the node and the graph-derived allowed list', () => {
    const base = {
      now: 1_700_000_000_000,
      symbol: 'BTCUSDT',
      trigger: { kind: 'kline_close' as const, detail: 'x' },
      open_threads: [],
      account: { backend: 'paper' as const, equity: '10000', available: '10000', unrealized_pnl: '0', positions: [], open_orders: [], as_of: 1_700_000_000_000 },
      market: { symbol: 'BTCUSDT', last: '100', mark: '100', funding_rate: '0', next_funding_at: 0, open_interest: '0', as_of: 1_700_000_000_000, klines_tf: '15m' },
      features: [],
      oi_change_1h_pct: null,
      ticker24h: { priceChangePercent: '0', highPrice: '1', lowPrice: '1', quoteVolume: '1' },
      market_state: null,
      playbook_text: 'p',
      last_judgment_summary: null,
    };
    expect(buildContext({ ...base, mode: 'scan', thread: null, halted: false })).toMatchObject({ node: 'scan', allowed_actions: ['NO_TRADE', 'WATCH', 'PROPOSE'] });
    expect(buildContext({ ...base, mode: 'scan', thread: null, halted: true })).toMatchObject({ node: 'scan:halted', allowed_actions: ['NO_TRADE'] });
    // 行情快照比 now 旧 10 分钟(> 3 分钟阈值)→ scan:stale,PROPOSE 不在允许集里;halted 仍然压过 stale。
    const staleMarket = { ...base.market, as_of: base.now - 10 * 60_000 };
    expect(buildContext({ ...base, market: staleMarket, mode: 'scan', thread: null, halted: false })).toMatchObject({ node: 'scan:stale', allowed_actions: ['NO_TRADE', 'WATCH'] });
    expect(buildContext({ ...base, market: staleMarket, mode: 'scan', thread: null, halted: true })).toMatchObject({ node: 'scan:halted' });
    expect(buildContext({ ...base, mode: 'review', thread: thread('in_position'), halted: false })).toMatchObject({ node: 'review:in_position', allowed_actions: ['HOLD', 'REDUCE', 'EXIT', 'INVALIDATE'] });
  });

  it('renders mermaid + markdown', () => {
    const m = toMermaid();
    expect(m.startsWith('flowchart LR')).toBe(true);
    expect(m).toContain('PROPOSE');
    expect(graphMarkdown()).toContain('| scan.PROPOSE |');
  });
});
