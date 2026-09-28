// threads.ts: StrategyThread lifecycle — newThread, reconcileThread (status re-derived from exchange
// facts every poll, 8794 lesson: never trust our own status as a second source of truth),
// reduceReview (what a review judgment is allowed to do per status), openingBlockers, threadClientPrefix.

import { describe, expect, it } from 'vitest';
import { ENTRY_MISS_SPACING_MS, newThread, openingBlockers, reconcileThread, reduceReview, threadClientPrefix, type ThreadFacts } from '../../src/demo/threads.js';
import type { Judgment, OpenOrderView, PositionView, StrategyThread, Workflow } from '../../src/demo/types.js';
import type { OrderStatusView } from '../../src/demo/execution.js';
import { DEFAULT_WORKFLOW } from '../../src/demo/workflow.js';

function mkThread(overrides: Partial<StrategyThread> = {}): StrategyThread {
  return {
    ...newThread({
      id: 'thr-abc123def456',
      symbol: 'BTCUSDT',
      side: 'long',
      source: 'agent',
      timeframe: '15m',
      thesis: 'test thesis',
      invalidation_text: null,
      watch_conditions: [],
      entry: { type: 'market', price: null, zone: null },
      stop_price: '49000',
      take_profits: ['52000'],
      qty: '0.1',
      margin_usdt: '500',
      leverage: 3,
      margin_mode: 'cross',
      now: 1000,
    }),
    ...overrides,
  };
}

function mkPosition(overrides: Partial<PositionView> = {}): PositionView {
  return { symbol: 'BTCUSDT', side: 'long', qty: '0.1', entry_price: '50000', mark_price: '50500', unrealized_pnl: '50', leverage: 3, ...overrides };
}

function mkOpenOrder(overrides: Partial<OpenOrderView> = {}): OpenOrderView {
  return { symbol: 'BTCUSDT', client_order_id: 'o1', type: 'STOP_MARKET', side: 'SELL', qty: '0', price: null, stop_price: '49000', reduce_only: true, status: 'NEW', ...overrides };
}

function mkFacts(overrides: Partial<ThreadFacts> = {}): ThreadFacts {
  return { now: 2000, position: null, entry_order: 'unqueried', open_orders: [], mark: '50000', ...overrides };
}

// ---------------------------------------------------------------- newThread

describe('newThread', () => {
  it('builds a pending_entry thread with version 1 and empty order-id fields', () => {
    const t = mkThread();
    expect(t.status).toBe('pending_entry');
    expect(t.version).toBe(1);
    expect(t.entry_client_order_id).toBeNull();
    expect(t.protection_client_order_ids).toEqual([]);
    expect(t.filled_avg_price).toBeNull();
    expect(t.realized_pnl).toBeNull();
    expect(t.close_reason).toBeNull();
    expect(t.attention).toBeNull();
    expect(t.opened_at).toBeNull();
    expect(t.closed_at).toBeNull();
    expect(t.created_at).toBe(1000);
    expect(t.updated_at).toBe(1000);
  });
});

// ---------------------------------------------------------------- reconcileThread

describe('reconcileThread: pending_entry', () => {
  it('a matching position appearing moves it to in_position, using the order avg_price when present', () => {
    const t = mkThread({ entry_client_order_id: 'e1' });
    const order: OrderStatusView = { status: 'FILLED', avg_price: '50123.4', executed_qty: '0.1', raw: {} };
    const r = reconcileThread(t, mkFacts({ position: mkPosition(), entry_order: order }));
    expect(r.changed).toBe(true);
    expect(r.next.status).toBe('in_position');
    expect(r.next.opened_at).toBe(2000);
    expect(r.next.filled_avg_price).toBe('50123.4');
    expect(r.next.version).toBe(t.version + 1);
    expect(r.events).toEqual([{ kind: 'entry_filled', message: '入场成交 @ 50123.4' }]);
  });

  it('falls back to the position entry_price when the order is FILLED but recorded no avg_price', () => {
    const t = mkThread({ entry_client_order_id: 'e1' });
    const order: OrderStatusView = { status: 'FILLED', avg_price: null, executed_qty: '0.1', raw: {} };
    const r = reconcileThread(t, mkFacts({ position: mkPosition({ entry_price: '50000.5' }), entry_order: order }));
    expect(r.changed).toBe(true);
    expect(r.next.status).toBe('in_position');
    expect(r.next.filled_avg_price).toBe('50000.5');
  });

  it('a PARTIALLY_FILLED order moves to in_position, shrinks qty to executed_qty, and flags ENTRY_REMAINDER', () => {
    const t = mkThread({ entry_client_order_id: 'e1', qty: '1' });
    const order: OrderStatusView = { status: 'PARTIALLY_FILLED', avg_price: '50000', executed_qty: '0.4', raw: {} };
    const r = reconcileThread(t, mkFacts({ position: mkPosition({ qty: '0.4' }), entry_order: order }));
    expect(r.next.status).toBe('in_position');
    expect(r.next.qty).toBe('0.4');
    expect(r.next.attention).toBe('ENTRY_REMAINDER');
    expect(r.events[0]!.message).toMatch(/入场部分成交/);
  });

  it('an unqueried entry_order with a position already present is treated as foreign (EXTERNAL_POSITION), not silently claimed as ours', () => {
    const t = mkThread({ entry_client_order_id: 'e1', attention: null });
    const r = reconcileThread(t, mkFacts({ position: mkPosition(), entry_order: 'unqueried' }));
    expect(r.changed).toBe(true);
    expect(r.next.status).toBe('pending_entry'); // status is untouched, only attention is raised
    expect(r.next.attention).toBe('EXTERNAL_POSITION');
  });

  it('a position on the wrong side also raises EXTERNAL_POSITION, and does not re-fire once already flagged', () => {
    const t = mkThread({ side: 'long', entry_client_order_id: 'e1', attention: null });
    const r = reconcileThread(t, mkFacts({ position: mkPosition({ side: 'short' }), entry_order: 'unqueried' }));
    expect(r.changed).toBe(true);
    expect(r.next.attention).toBe('EXTERNAL_POSITION');

    const r2 = reconcileThread(r.next, mkFacts({ position: mkPosition({ side: 'short' }), entry_order: 'unqueried' }));
    expect(r2.changed).toBe(false);
  });

  it('entry order CANCELED with no position → canceled', () => {
    const t = mkThread({ entry_client_order_id: 'e1' });
    const order: OrderStatusView = { status: 'CANCELED', avg_price: null, executed_qty: '0', raw: {} };
    const r = reconcileThread(t, mkFacts({ position: null, entry_order: order }));
    expect(r.changed).toBe(true);
    expect(r.next.status).toBe('canceled');
    expect(r.next.close_reason).toBe('入场单 CANCELED');
    expect(r.events).toEqual([{ kind: 'canceled', message: '入场单 CANCELED' }]);
  });

  it('entry order GONE (null) never auto-cancels: it raises ORDER_UNKNOWN and keeps counting misses (null is not a negative fact)', () => {
    const t = mkThread({ entry_client_order_id: 'e1' });
    const r1 = reconcileThread(t, mkFacts({ position: null, entry_order: null }));
    expect(r1.changed).toBe(true);
    expect(r1.next.status).toBe('pending_entry');
    expect(r1.next.attention).toBe('ORDER_UNKNOWN');
    expect(r1.next.entry_lookup_misses).toBe(1);

    // 同一个 now(同一份缓存窗口)再查一次不重复计数(09-26 stuck-entry)
    expect(reconcileThread(r1.next, mkFacts({ position: null, entry_order: null })).changed).toBe(false);
    let cur = r1.next;
    for (let i = 1; i <= 6; i++) {
      const r = reconcileThread(cur, mkFacts({ now: 2000 + i * ENTRY_MISS_SPACING_MS, position: null, entry_order: null }));
      // 纯函数永远不写终态:次数与时长够了也只是 verify_absent(请求 runtime 做新鲜复核)
      expect(r.next.status).toBe('pending_entry');
      expect(r.next.attention).toBe('ORDER_UNKNOWN');
      cur = r.next;
    }
    expect(cur.entry_lookup_misses).toBe(7);
    expect(cur.version).toBeGreaterThan(t.version); // every miss is persisted with a version bump
  });

  it('ORDER_UNKNOWN clears once the entry order is found again (any status other than GONE/filled/canceled)', () => {
    const t = mkThread({ entry_client_order_id: 'e1', attention: 'ORDER_UNKNOWN' });
    const order: OrderStatusView = { status: 'NEW', avg_price: null, executed_qty: '0', raw: {} };
    const r = reconcileThread(t, mkFacts({ position: null, entry_order: order }));
    expect(r.changed).toBe(true);
    expect(r.next.attention).toBeNull();
  });

  it('no change while the order is still unqueried and there is no position yet', () => {
    const t = mkThread({ entry_client_order_id: null });
    const r = reconcileThread(t, mkFacts({ position: null, entry_order: 'unqueried' }));
    expect(r.changed).toBe(false);
    expect(r.next.status).toBe('pending_entry');
  });
});

describe('reconcileThread: submit/attribution grace (2026-09-06 HYPE incident)', () => {
  const NOW = 1_800_000_000_000;
  it('own fill seen in the account before the order confirms: same side + fresh submit = pending attribution, no EXTERNAL_POSITION', () => {
    const t = mkThread({ status: 'pending_entry', side: 'long', entry_client_order_id: 'tgd-x-e1', entry_submitted_at: NOW - 10_000 });
    const r = reconcileThread(t, { now: NOW, position: mkPosition({ side: 'long' }), entry_order: null, open_orders: [], mark: null });
    expect(r.changed).toBe(false);
    expect(r.next.attention).toBeNull();
  });
  it('after the 45 s grace the same facts are foreign again', () => {
    const t = mkThread({ status: 'pending_entry', side: 'long', entry_client_order_id: 'tgd-x-e1', entry_submitted_at: NOW - 60_000 });
    const r = reconcileThread(t, { now: NOW, position: mkPosition({ side: 'long' }), entry_order: null, open_orders: [], mark: null });
    expect(r.next.attention).toBe('EXTERNAL_POSITION');
  });
  it('wrong side is foreign even inside the grace', () => {
    const t = mkThread({ status: 'pending_entry', side: 'long', entry_client_order_id: 'tgd-x-e1', entry_submitted_at: NOW - 10_000 });
    const r = reconcileThread(t, { now: NOW, position: mkPosition({ side: 'short' }), entry_order: null, open_orders: [], mark: null });
    expect(r.next.attention).toBe('EXTERNAL_POSITION');
  });
  it('order GONE inside the grace is not a miss and raises no ORDER_UNKNOWN; outside it does', () => {
    const inside = reconcileThread(mkThread({ status: 'pending_entry', entry_client_order_id: 'tgd-x-e1', entry_submitted_at: NOW - 5_000 }), { now: NOW, position: null, entry_order: null, open_orders: [], mark: null });
    expect(inside.changed).toBe(false);
    expect(inside.next.entry_lookup_misses).toBe(0);
    const outside = reconcileThread(mkThread({ status: 'pending_entry', entry_client_order_id: 'tgd-x-e1', entry_submitted_at: NOW - 50_000 }), { now: NOW, position: null, entry_order: null, open_orders: [], mark: null });
    expect(outside.next.attention).toBe('ORDER_UNKNOWN');
  });
});

describe('reconcileThread: in_position', () => {
  it('position gone → closed', () => {
    const t = mkThread({ status: 'in_position', opened_at: 1500 });
    const r = reconcileThread(t, mkFacts({ position: null }));
    expect(r.changed).toBe(true);
    expect(r.next.status).toBe('closed');
    expect(r.next.closed_at).toBe(2000);
    expect(r.events).toEqual([{ kind: 'closed', message: r.next.close_reason }]);
  });

  it('no STOP_MARKET reduce-only order on the closing side raises PROTECTION_MISSING attention', () => {
    const t = mkThread({ status: 'in_position', stop_price: '49000', attention: null });
    const r = reconcileThread(t, mkFacts({ position: mkPosition(), open_orders: [] }));
    expect(r.changed).toBe(true);
    expect(r.next.attention).toBe('PROTECTION_MISSING');
    expect(r.events).toEqual([{ kind: 'attention', message: '止损单不在交易所上,需要补挂' }]);
  });

  it('attention does not re-fire on the next poll while still missing (already PROTECTION_MISSING)', () => {
    // 09-12 P0-01:第一次会把 protection_missing 落盘(一次 version bump),之后同样的事实不再写、也不再发事件。
    const t = mkThread({ status: 'in_position', stop_price: '49000', attention: 'PROTECTION_MISSING', filled_avg_price: '50000' });
    const first = reconcileThread(t, mkFacts({ position: mkPosition(), open_orders: [] }));
    expect(first.events).toEqual([]);
    expect(first.next.protection_missing).toBe(true);
    const again = reconcileThread(first.next, mkFacts({ position: mkPosition(), open_orders: [] }));
    expect(again.changed).toBe(false);
    expect(again.events).toEqual([]);
  });

  it('attention clears once a matching STOP_MARKET reduce-only order reappears', () => {
    const t = mkThread({ status: 'in_position', side: 'long', stop_price: '49000', attention: 'PROTECTION_MISSING' });
    const r = reconcileThread(t, mkFacts({ position: mkPosition(), open_orders: [mkOpenOrder({ type: 'STOP_MARKET', side: 'SELL', reduce_only: true })] }));
    expect(r.changed).toBe(true);
    expect(r.next.attention).toBeNull();
    expect(r.events).toEqual([{ kind: 'attention_cleared', message: '止损单已恢复' }]);
  });

  it('a stop order on the wrong side (e.g. a short-position stop while long) still counts as missing', () => {
    const t = mkThread({ status: 'in_position', side: 'long', stop_price: '49000', attention: null });
    const r = reconcileThread(t, mkFacts({ position: mkPosition(), open_orders: [mkOpenOrder({ side: 'BUY' })] }));
    expect(r.next.attention).toBe('PROTECTION_MISSING');
  });

  it('no stop_price wanted (stop_price null) means no attention even with no stop order', () => {
    const t = mkThread({ status: 'in_position', stop_price: null, attention: null, filled_avg_price: '50000' });
    const r = reconcileThread(t, mkFacts({ position: mkPosition(), open_orders: [] }));
    expect(r.changed).toBe(false);
    expect(r.next.attention).toBeNull();
  });

  it('no change when the position matches and protection is already fine', () => {
    const t = mkThread({ status: 'in_position', stop_price: '49000', attention: null, filled_avg_price: '50000' });
    const r = reconcileThread(t, mkFacts({ position: mkPosition(), open_orders: [mkOpenOrder()] }));
    expect(r.changed).toBe(false);
  });

  // 09-07 SKHYNIX:回执缺均价时 runtime 不再拿标记价冒充成交价;交易所的 entry_price 回填一次就够,之后不再抖动。
  it('backfills a missing filled_avg_price from the exchange position once, then stops changing', () => {
    const t = mkThread({ status: 'in_position', stop_price: '49000', attention: null, filled_avg_price: null });
    const first = reconcileThread(t, mkFacts({ position: mkPosition({ entry_price: '50123.4' }), open_orders: [mkOpenOrder()] }));
    expect(first.changed).toBe(true);
    expect(first.next.filled_avg_price).toBe('50123.4');
    expect(first.events).toEqual([]);
    expect(first.next.attention).toBeNull();
    const second = reconcileThread(first.next, mkFacts({ position: mkPosition({ entry_price: '50123.4' }), open_orders: [mkOpenOrder()] }));
    expect(second.changed).toBe(false);
  });

  // 回填不能吃掉保护缺失:同一轮里既补价又要报 PROTECTION_MISSING。
  it('the backfill does not swallow the PROTECTION_MISSING attention in the same pass', () => {
    const t = mkThread({ status: 'in_position', stop_price: '49000', attention: null, filled_avg_price: null });
    const r = reconcileThread(t, mkFacts({ position: mkPosition(), open_orders: [] }));
    expect(r.changed).toBe(true);
    expect(r.next.attention).toBe('PROTECTION_MISSING');
    expect(r.next.filled_avg_price).toBe('50000');
    expect(r.events).toEqual([{ kind: 'attention', message: '止损单不在交易所上,需要补挂' }]);
  });
});

// ---------------------------------------------------------------- reduceReview

function mkJudgment(action: Judgment['action'], overrides: Partial<Judgment> = {}): Judgment {
  return {
    action,
    direction: 'long',
    confidence: 0.6,
    headline: 'h',
    thesis: 'updated thesis',
    reasons: ['r [E1]'],
    evidence_refs: ['E1'],
    invalidation: 'inval text',
    invalidation_price: null,
    target_price: null,
    watch_conditions: ['w1'],
    proposal: null,
    ...overrides,
  };
}

describe('reduceReview: pending_entry', () => {
  it('HOLD is accepted with effect none', () => {
    const d = reduceReview(mkThread({ status: 'pending_entry' }), mkJudgment('HOLD'));
    expect(d).toMatchObject({ accepted: true, effect: 'none' });
  });

  it('INVALIDATE is accepted with effect cancel_entry and a close_reason patch', () => {
    const d = reduceReview(mkThread({ status: 'pending_entry' }), mkJudgment('INVALIDATE'));
    expect(d).toMatchObject({ accepted: true, effect: 'cancel_entry' });
    expect(d.patch.close_reason).toBe('论点失效(复查)');
  });

  it('REDUCE is rejected (not an allowed action for pending_entry)', () => {
    const d = reduceReview(mkThread({ status: 'pending_entry' }), mkJudgment('REDUCE'));
    expect(d.accepted).toBe(false);
    expect(d.effect).toBe('none');
    expect(d.reason).toMatch(/pending_entry 不接受 REDUCE/);
  });

  it('EXIT is rejected for pending_entry', () => {
    const d = reduceReview(mkThread({ status: 'pending_entry' }), mkJudgment('EXIT'));
    expect(d.accepted).toBe(false);
  });
});

describe('reduceReview: in_position', () => {
  it('HOLD is accepted with effect none', () => {
    const d = reduceReview(mkThread({ status: 'in_position' }), mkJudgment('HOLD'));
    expect(d).toMatchObject({ accepted: true, effect: 'none' });
  });

  it('REDUCE is accepted with effect reduce_half', () => {
    const d = reduceReview(mkThread({ status: 'in_position' }), mkJudgment('REDUCE'));
    expect(d).toMatchObject({ accepted: true, effect: 'reduce_half' });
  });

  it('EXIT is accepted with effect close and close_reason 复查离场', () => {
    const d = reduceReview(mkThread({ status: 'in_position' }), mkJudgment('EXIT'));
    expect(d).toMatchObject({ accepted: true, effect: 'close' });
    expect(d.patch.close_reason).toBe('复查离场');
  });

  it('INVALIDATE is accepted with effect close and close_reason 论点失效(复查)', () => {
    const d = reduceReview(mkThread({ status: 'in_position' }), mkJudgment('INVALIDATE'));
    expect(d).toMatchObject({ accepted: true, effect: 'close' });
    expect(d.patch.close_reason).toBe('论点失效(复查)');
  });

  it('PROPOSE (an opening-only action) is rejected for in_position', () => {
    const d = reduceReview(mkThread({ status: 'in_position' }), mkJudgment('PROPOSE'));
    expect(d.accepted).toBe(false);
    expect(d.patch).toEqual({});
  });

  it('the accepted patch always carries the judgment thesis/invalidation/watch_conditions through', () => {
    const d = reduceReview(mkThread({ status: 'in_position' }), mkJudgment('HOLD', { thesis: 'new thesis', invalidation: 'new inval', watch_conditions: ['a', 'b'] }));
    expect(d.patch).toMatchObject({ thesis: 'new thesis', invalidation_text: 'new inval', watch_conditions: ['a', 'b'] });
  });
});

describe('reduceReview: terminal statuses accept nothing', () => {
  it('a closed thread rejects HOLD too (allowedReviewActions is empty)', () => {
    const d = reduceReview(mkThread({ status: 'closed' }), mkJudgment('HOLD'));
    expect(d.accepted).toBe(false);
  });
});

// ---------------------------------------------------------------- openingBlockers

function mkWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return { ...DEFAULT_WORKFLOW, ...overrides };
}

describe('openingBlockers', () => {
  it('no blockers when everything is under the limits and the symbol is free', () => {
    const out = openingBlockers([], mkWorkflow(), 'BTCUSDT', 0, false);
    expect(out).toEqual([]);
  });

  it('blocks when the symbol already has an open thread', () => {
    const existing = mkThread({ symbol: 'BTCUSDT', status: 'pending_entry' });
    const out = openingBlockers([existing], mkWorkflow(), 'BTCUSDT', 0, false);
    expect(out).toContain('BTCUSDT 已有线程');
  });

  it('does not block on a different symbol', () => {
    const existing = mkThread({ symbol: 'ETHUSDT', status: 'pending_entry' });
    const out = openingBlockers([existing], mkWorkflow(), 'BTCUSDT', 0, false);
    expect(out).toEqual([]);
  });

  it('ignores closed/canceled threads when checking the symbol-already-open rule', () => {
    const closed = mkThread({ symbol: 'BTCUSDT', status: 'closed' });
    const out = openingBlockers([closed], mkWorkflow(), 'BTCUSDT', 0, false);
    expect(out).toEqual([]);
  });

  it('blocks at max_open_threads', () => {
    const workflow = mkWorkflow({ max_open_threads: 1 });
    const existing = mkThread({ symbol: 'ETHUSDT', status: 'in_position' });
    const out = openingBlockers([existing], workflow, 'BTCUSDT', 0, false);
    expect(out).toContain(`同时线程数已到上限 1`);
  });

  it('blocks at max_opens_per_day', () => {
    const workflow = mkWorkflow({ max_opens_per_day: 2 });
    const out = openingBlockers([], workflow, 'BTCUSDT', 2, false);
    expect(out).toContain('今日开仓已到上限 2');
  });

  it('blocks when the daily loss stop has been hit', () => {
    const workflow = mkWorkflow({ daily_loss_stop_pct: '3' });
    const out = openingBlockers([], workflow, 'BTCUSDT', 0, true);
    expect(out).toContain('今日亏损已触及 3% 日亏停');
  });

  it('accumulates multiple blockers at once', () => {
    const workflow = mkWorkflow({ max_open_threads: 1, max_opens_per_day: 1 });
    const existing = mkThread({ symbol: 'BTCUSDT', status: 'in_position' });
    const out = openingBlockers([existing], workflow, 'BTCUSDT', 1, true);
    expect(out.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------- threadClientPrefix

describe('threadClientPrefix', () => {
  it('is tgd- plus 12 hex chars of sha1(thread id) — collision-resistant and ≤ 36 chars with any leg suffix', () => {
    const p = threadClientPrefix('thr-abc123def456ghi');
    expect(p).toMatch(/^tgd-[0-9a-f]{12}$/);
    expect(p).not.toBe(threadClientPrefix('thr-abc123def456ghj')); // one char different → different prefix
  });

  it('works on an id with no thr- prefix', () => {
    expect(threadClientPrefix('abc123')).toMatch(/^tgd-[0-9a-f]{12}$/);
  });

  it('is stable/deterministic for the same input', () => {
    expect(threadClientPrefix('thr-xyz')).toBe(threadClientPrefix('thr-xyz'));
  });
});

it('SKHYNIX: a pre-fill or cross-fill account read cannot close a real fill; later fresh flat can', () => {
  const t = mkThread({ symbol: 'SKHYNIXUSDT', status: 'in_position', opened_at: 100_000, entry_submitted_at: 100_000 });
  expect(reconcileThread(t, mkFacts({ now: 104_596, account_as_of: 78_000 })).changed).toBe(false);
  expect(reconcileThread(t, mkFacts({ now: 160_000, account_as_of: 78_000 })).changed).toBe(false);
  expect(reconcileThread(t, mkFacts({ now: 160_000, account_as_of: 155_000 })).next.status).toBe('closed');
});
