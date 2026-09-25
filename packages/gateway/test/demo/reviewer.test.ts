// Reviewer(reviewer.ts / reviewer-agent.ts):复盘卡、批次触发、教训闸、与 runtime 的接线。假大脑,零网络。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { DemoRuntime } from '../../src/demo/runtime.js';
import { stubBrain } from '../../src/demo/brain.js';
import { BATCH_MAX_PER_DAY, batchKey, classifyExit, eligibleForBatch, parseLessons, reflectPromptV2, shouldRunBatch, tradeCard, lessonToProposal, type TradeCard } from '../../src/demo/reviewer.js';
import { presenceFor } from '../../src/demo/routes-bots.js';
import { newThread } from '../../src/demo/threads.js';
import type { StrategyThread } from '../../src/demo/types.js';

const NOW = 1_788_700_000_000;

function closedThread(over: Partial<StrategyThread>): StrategyThread {
  const t = newThread({ id: `thr-${Math.random().toString(36).slice(2, 8)}`, symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '15m', thesis: 't', invalidation_text: null, watch_conditions: [], entry: { type: 'market', price: null, zone: null }, stop_price: '99000', take_profits: ['102000'], qty: '0.1', margin_usdt: '2000', leverage: 5, margin_mode: 'cross', now: NOW - 3_600_000 } as Parameters<typeof newThread>[0]);
  return { ...t, status: 'closed', opened_at: NOW - 3_600_000, closed_at: NOW - 60_000, filled_avg_price: '100000', exit_price: '101500', realized_pnl: '150', close_reason: '止盈触发', protection_client_order_ids: ['sl-1'], version: 3, ...over };
}

describe('tradeCard', () => {
  it('computes R from pnl / initial risk, classifies the exit, flags missing protection', () => {
    const c = tradeCard(closedThread({}), 4);
    expect(c).toMatchObject({ filled: true, outcome: 'win', exit_class: 'take_profit', protection_ok: true, episode_count: 4 });
    expect(c.r_multiple).toBe(1.5); // 150 / (1000 × 0.1)
    expect(c.hold_ms).toBe(3_540_000);
    const loss = tradeCard(closedThread({ realized_pnl: '-100', exit_price: '99000', close_reason: '止损触发', protection_client_order_ids: [] }));
    expect(loss).toMatchObject({ outcome: 'loss', exit_class: 'stop', protection_ok: false, r_multiple: -1 });
    expect(loss.notes.join(' ')).toMatch(/保护腿/);
    const canceled = tradeCard(closedThread({ status: 'canceled', opened_at: null, filled_avg_price: null, realized_pnl: null, close_reason: '论点失效,撤单' }));
    expect(canceled).toMatchObject({ filled: false, outcome: 'unfilled', exit_class: 'canceled' });
    expect(eligibleForBatch(canceled)).toBe(false);
    expect(eligibleForBatch(c)).toBe(true);
    expect(classifyExit(closedThread({ close_reason: '用户确认平仓' }))).toBe('manual');
    expect(classifyExit(closedThread({ close_reason: '论点趋势翻转,离场' }))).toBe('model_exit');
  });
});

describe('shouldRunBatch', () => {
  const base = { last_batch_at: NOW - 3_600_000, runs_today: 0, paused: false, now: NOW };
  it('runs at ≥5 new, or ≥24h with ≥1 new; never when paused or over the daily cap', () => {
    expect(shouldRunBatch({ ...base, eligible_new: 5 }).run).toBe(true);
    expect(shouldRunBatch({ ...base, eligible_new: 2 }).run).toBe(false);
    expect(shouldRunBatch({ ...base, eligible_new: 2, last_batch_at: NOW - 25 * 3_600_000 }).run).toBe(true);
    expect(shouldRunBatch({ ...base, eligible_new: 1, last_batch_at: null, oldest_pending_at: NOW - 60_000 }).run).toBe(false);
    expect(shouldRunBatch({ ...base, eligible_new: 1, last_batch_at: null, oldest_pending_at: NOW - 25 * 3_600_000 }).run).toBe(true);
    expect(shouldRunBatch({ ...base, eligible_new: 0, last_batch_at: null }).run).toBe(false);
    expect(shouldRunBatch({ ...base, eligible_new: 9, paused: true }).run).toBe(false);
    expect(shouldRunBatch({ ...base, eligible_new: 9, runs_today: BATCH_MAX_PER_DAY }).run).toBe(false);
  });
});

describe('parseLessons guard', () => {
  const cards: TradeCard[] = [tradeCard(closedThread({ id: 'thr-a' })), tradeCard(closedThread({ id: 'thr-b', symbol: 'ETHUSDT', realized_pnl: '-100', exit_price: '99000', close_reason: '止损' }))];
  const good = { observation: '突破后回踩不确认就进场的多单连续止损', mechanism: '量比不足时突破多为假突破', falsifier: '后续 5 笔回踩确认的多单胜率不高于未确认的', confidence: 0.6, symbol: 'ETHUSDT', regime: 'bear', tags: ['breakout', 'retest'], source_refs: ['thr-b'] };
  it('keeps a well-formed lesson; drops missing fields, foreign refs, price-like numbers, >2 lessons, unknown symbol/regime → null', () => {
    const r = parseLessons(JSON.stringify([good, { ...good, source_refs: ['thr-zzz'] }, { ...good, falsifier: '' }, { ...good, observation: '在 99000 附近做多总是被打止损', source_refs: ['thr-a'] }, { ...good, symbol: 'SOLUSDT', regime: 'sideways', source_refs: ['thr-a'] }, { ...good, source_refs: ['thr-a'], observation: '第三条' }]), cards, false);
    expect(r.kept).toHaveLength(2);
    expect(r.kept[0]).toMatchObject({ symbol: 'ETHUSDT', regime: 'bear', confidence: 0.6 });
    expect(r.kept[1]).toMatchObject({ symbol: null, regime: null });
    expect(r.dropped.map((d) => d.reason)).toEqual([expect.stringContaining('source_refs'), expect.stringContaining('缺一'), expect.stringContaining('99000'), expect.stringContaining('超过每轮')]);
  });
  it('small sample caps confidence at 0.4; R-multiples and minute counts are not treated as prices', () => {
    const r = parseLessons(JSON.stringify([{ ...good, observation: '平均 1.5R 的止盈单持有 45 分钟以上', confidence: 0.8 }]), cards, true);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]!.confidence).toBe(0.4);
    expect(parseLessons('not json', cards, false).dropped[0]!.reason).toMatch(/JSON/);
  });
  it('prompt carries the cards and the small-sample rule; proposal is a proposed agent lesson tagged for eval', () => {
    const p = reflectPromptV2(cards, ['旧教训'], true);
    expect(p.system).toMatch(/样本少于 5 笔/);
    expect(p.user).toMatch(/thr-a BTCUSDT long/);
    expect(p.user).toMatch(/旧教训/);
    const prop = lessonToProposal(good, 'k1', NOW);
    expect(prop).toMatchObject({ kind: 'lesson', proposed_by: 'agent', scope: { symbol: 'ETHUSDT', regime: 'bear' } });
    expect(prop.tags).toEqual(expect.arrayContaining(['reviewer', 'batch:k1', 'eval:pending']));
    expect(prop.content).toMatch(/机制:.*推翻条件:/);
    expect(batchKey(cards)).toBe(batchKey([...cards].reverse()));
  });
});

describe('Reviewer agent', () => {
  let rt: DemoRuntime | null = null;
  let state: StateDb | null = null;
  afterEach(async () => {
    if (rt) await rt.stop();
    state?.close();
    rt = null;
    state = null;
    vi.restoreAllMocks();
  });
  it('thread end → trade_card run; 5 eligible closes → one batch → proposed lessons + handoff; cap 2/day; paused skips', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    state = openStateDb(':memory:');
    const store = new DemoStore(state);
    let calls = 0;
    rt = new DemoRuntime({
      store,
      backend: new PaperBackend(10_000),
      brains: { stub: stubBrain(() => '{}') },
      marketPollMs: 600_000,
      accountPollMs: 600_000,
      radar: { runScreen: async () => { throw new Error('no'); } },
      reviewer: {
        reflect: async (_b, cards) => {
          calls++;
          return { kept: [{ observation: '止损单都在开仓后一小时内触发', mechanism: '入场追得太远', falsifier: '后续回踩入场的止损时间不变', confidence: 0.5, symbol: null, regime: null, tags: ['chase'], source_refs: [cards[0]!.thread_id] }], dropped: [{ raw: null, reason: '含价位' }], raw: '[]', input_tokens: 1000, output_tokens: 200, latency_ms: 10, model: 'fake' };
        },
      },
    });
    rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', paused: false });
    expect(store.bots.profile('reviewer')!.enabled).toBe(true);
    expect(presenceFor('reviewer', rt, true)).toMatchObject({ state: 'idle' });
    // 4 closes: cards only, no batch yet
    for (let i = 0; i < 4; i++) {
      const t = closedThread({ id: `thr-c${i}` });
      store.saveThread(t);
      rt.reviewer.onThreadEnded(t);
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(store.bots.runs({ role: 'reviewer', routine: 'trade_card' })).toHaveLength(4);
    expect(calls).toBe(0);
    expect(presenceFor('reviewer', rt, true)).toMatchObject({ state: 'waiting' });
    // 5th close triggers the batch
    const t5 = closedThread({ id: 'thr-c4' });
    store.saveThread(t5);
    rt.reviewer.onThreadEnded(t5);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(1);
    const batches = store.bots.runs({ role: 'reviewer', routine: 'review_batch' });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ status: 'done' });
    expect(batches[0]!.result?.['proposed_memory_ids']).toHaveLength(1);
    expect(batches[0]!.input?.['thread_ids']).toHaveLength(5);
    const proposed = store.memory.list({ status: ['proposed'], kind: 'lesson' });
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.tags).toContain('eval:pending');
    expect(store.bots.handoffs({ to_role: 'gate_captain', status: 'pending' }).map((h) => h.kind)).toEqual(['review']);
    // those 5 are now "seen": nothing pending, manual batch refuses
    expect(rt.reviewer.decision().pending).toBe(0);
    expect((await rt.reviewer.maybeBatch('manual')).ran).toBe(false);
    // 5 more → second batch; 5 more → cap reached, skipped
    for (let i = 5; i < 10; i++) store.saveThread(closedThread({ id: `thr-c${i}` }));
    expect((await rt.reviewer.maybeBatch('manual')).ran).toBe(true);
    for (let i = 10; i < 15; i++) store.saveThread(closedThread({ id: `thr-c${i}` }));
    const third = await rt.reviewer.maybeBatch('manual');
    expect(third.ran).toBe(false);
    expect(third.reason).toMatch(/今日已跑/);
    expect(calls).toBe(2);
    // paused → no model
    rt.setWorkflow({ paused: true });
    expect((await rt.reviewer.maybeBatch('manual')).reason).toMatch(/暂停/);
    expect(presenceFor('reviewer', rt, true).action).toMatch(/已暂停/);
  });
});

 describe('现货复盘标签', () => {
  it('无止损现货复盘使用可选标签,不误报保护缺失', () => {
    const c = tradeCard(closedThread({ market: 'spot', stop_price: null, protection_client_order_ids: [] }));
    expect(c.protection_ok).toBe(true);
    expect(c.notes).toContain('现货,无止损(可选)');
    expect(reflectPromptV2([c], [], true).user).not.toContain('保护缺失');
  });
});
