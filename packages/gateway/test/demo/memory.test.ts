// memory.ts (B7-lite, docs/demo/memory.md): lifecycle propose → approve/reject → forget, exact dedupe, supersede,
// structured recall (scope isolation, expiry, decay, budget), FTS5 trigram text recall (Chinese), templated trade
// facts, reflect parsing, and the context builder injecting memories as 记忆 evidence that the judgment can cite.

import { describe, expect, it } from 'vitest';
import { openStateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { MEMORY_LIMITS, MemoryStore, contentHash, parseReflectOutput, scoreMemory, tradeFactCandidate } from '../../src/demo/memory.js';
import { buildContext } from '../../src/demo/context.js';
import { findMemoryNumberLeaks } from '../../src/demo/schema.js';
import { newThread } from '../../src/demo/threads.js';
import type { Judgment, MemoryItem, StrategyThread } from '../../src/demo/types.js';

const NOW = 1_788_500_000_000;

function fresh(): MemoryStore {
  return new DemoStore(openStateDb(':memory:')).memory;
}

function active(store: MemoryStore, content: string, extra: Partial<Parameters<MemoryStore['propose']>[0]> = {}): MemoryItem {
  const { item } = store.propose({ kind: 'lesson', content, proposed_by: 'agent', now: NOW, ...extra });
  return store.approve(item.id, extra.now ?? NOW)!;
}

describe('memory lifecycle', () => {
  it('propose → approve → active, with events; reject and forget are terminal', () => {
    const s = fresh();
    const { item, created } = s.propose({ kind: 'lesson', content: 'bear 日线里做多突破容易被扫止损', proposed_by: 'agent', now: NOW });
    expect(created).toBe(true);
    expect(item.status).toBe('proposed');
    expect(s.counts().proposed).toBe(1);
    const ok = s.approve(item.id, NOW + 1)!;
    expect(ok.status).toBe('active');
    expect(ok.decided_at).toBe(NOW + 1);
    expect(s.events(item.id).map((e) => e.kind)).toEqual(['approved', 'proposed']);
    expect(() => s.approve(item.id)).toThrow(/只能批准 proposed/);
    const gone = s.forget(item.id, '过时', NOW + 2)!;
    expect(gone.status).toBe('forgotten');
    expect(s.recall({ symbol: null, now: NOW + 3 })).toEqual([]);
    const { item: r } = s.propose({ kind: 'fact', content: '另一条', proposed_by: 'system', now: NOW });
    expect(s.reject(r.id, '没用', NOW)!.status).toBe('rejected');
    expect(s.list({ status: ['rejected'] }).map((m) => m.id)).toEqual([r.id]);
  });

  it('exact duplicates (after whitespace/case normalisation) are folded into the existing item', () => {
    const s = fresh();
    const a = s.propose({ kind: 'preference', content: '不做 DOGE', proposed_by: 'user', activate: true, now: NOW });
    const b = s.propose({ kind: 'preference', content: '  不做   doge ', proposed_by: 'agent', now: NOW });
    expect(b.created).toBe(false);
    expect(b.item.id).toBe(a.item.id);
    expect(contentHash('不做 DOGE')).toBe(contentHash('不做   doge'));
    expect(s.events(a.item.id).some((e) => e.kind === 'dedup_hit')).toBe(true);
    expect(s.counts().active).toBe(1);
  });

  it('user-typed memories activate immediately; agent proposals wait', () => {
    const s = fresh();
    expect(s.propose({ kind: 'preference', content: '周末不开新仓', proposed_by: 'user', activate: true, now: NOW }).item.status).toBe('active');
    expect(s.propose({ kind: 'lesson', content: 'x y z', proposed_by: 'agent', now: NOW }).item.status).toBe('proposed');
  });

  it('supersede: approving a replacement retires the old item', () => {
    const s = fresh();
    const old = active(s, '风险 0.5% 太小,用 1%');
    const { item: nu } = s.propose({ kind: 'calibration', content: '风险 1% 回撤太大,回到 0.5%', proposed_by: 'agent', supersedes: old.id, now: NOW });
    s.approve(nu.id, NOW);
    expect(s.get(old.id)!.status).toBe('superseded');
    expect(s.get(old.id)!.superseded_by).toBe(nu.id);
    expect(s.recall({ symbol: null, now: NOW }).map((h) => h.item.id)).toEqual([nu.id]);
  });
});

describe('memory recall', () => {
  it('symbol-scoped memories never leak to another symbol; global ones reach everyone', () => {
    const s = fresh();
    const btc = active(s, 'BTC 在美股开盘窗口假突破多', { scope: { symbol: 'BTCUSDT' } });
    const glob = active(s, '周末只做回踩确认的入场');
    const eth = active(s, 'ETH 资金费率极端时反向', { scope: { symbol: 'ETHUSDT' } });
    const forBtc = s.recall({ symbol: 'BTCUSDT', now: NOW }).map((h) => h.item.id);
    expect(forBtc).toContain(btc.id);
    expect(forBtc).toContain(glob.id);
    expect(forBtc).not.toContain(eth.id);
    // no symbol context → only global
    expect(s.recall({ symbol: null, now: NOW }).map((h) => h.item.id)).toEqual([glob.id]);
  });

  it('expired items are skipped; unused items decay after 30 days but still surface behind fresh ones', () => {
    const s = fresh();
    const expired = active(s, '本周 CPI 前不开仓', { expires_at: NOW - 1 });
    const old = active(s, '老教训', { now: NOW - 40 * 86_400_000 });
    const freshItem = active(s, '新教训');
    const hits = s.recall({ symbol: null, now: NOW });
    expect(hits.map((h) => h.item.id)).not.toContain(expired.id);
    expect(hits[0]!.item.id).toBe(freshItem.id);
    const oldHit = hits.find((h) => h.item.id === old.id)!;
    expect(oldHit.why.join(' ')).toMatch(/衰减/);
    expect(oldHit.score).toBeLessThan(hits[0]!.score);
  });

  it('regime and tag matches rank higher; result respects limit and character budget', () => {
    const s = fresh();
    const bear = active(s, 'bear 里做多突破 3 次 2 亏', { scope: { symbol: 'BTCUSDT', regime: 'bear' }, tags: ['breakout', 'loss'] });
    const bull = active(s, 'bull 里回踩 EMA20 胜率高', { scope: { symbol: 'BTCUSDT', regime: 'bull' }, tags: ['retest', 'win'] });
    for (let i = 0; i < 8; i++) active(s, `填充记忆 ${i} ` + '字'.repeat(120), { scope: { symbol: 'BTCUSDT' } });
    const hits = s.recall({ symbol: 'BTCUSDT', regime: 'bear', tags: ['breakout'], now: NOW });
    expect(hits[0]!.item.id).toBe(bear.id);
    expect(hits[0]!.why.join(' ')).toMatch(/regime bear/);
    expect(hits[0]!.why.join(' ')).toMatch(/标签 breakout/);
    expect(hits.length).toBeLessThanOrEqual(MEMORY_LIMITS.recall_limit);
    expect(hits.reduce((n, h) => n + h.item.content.length, 0)).toBeLessThanOrEqual(MEMORY_LIMITS.recall_char_budget + 130); // first item always fits
    expect(hits.map((h) => h.item.id)).toContain(bull.id);
  });

  it('free-text recall uses FTS5 trigram (Chinese substrings work) and ignores forgotten/proposed rows', () => {
    const s = fresh();
    const a = active(s, '周末流动性差,只做回踩确认过的入场');
    const b = active(s, '资金费率超过 0.05% 时降低信心');
    s.propose({ kind: 'lesson', content: '流动性相关但还没批准', proposed_by: 'agent', now: NOW });
    const c = active(s, '流动性差的时候别追单');
    s.forget(c.id, null, NOW);
    const hits = s.recall({ symbol: null, text: '流动性', now: NOW });
    expect(hits.map((h) => h.item.id)).toEqual([a.id]);
    expect(hits[0]!.why.join(' ')).toMatch(/文本/);
    expect(s.recall({ symbol: null, text: '资金费率', now: NOW }).map((h) => h.item.id)).toEqual([b.id]);
    // shorter than a trigram → structured recall, not text
    expect(s.recall({ symbol: null, text: '费', now: NOW }).length).toBe(2);
  });

  it('markUsed bumps use_count / last_used_at and only touches active items', () => {
    const s = fresh();
    const a = active(s, '用过的');
    const { item: p } = s.propose({ kind: 'lesson', content: '没批的', proposed_by: 'agent', now: NOW });
    s.markUsed([a.id, p.id, 'mem-nope'], NOW + 5);
    expect(s.get(a.id)!.use_count).toBe(1);
    expect(s.get(a.id)!.last_used_at).toBe(NOW + 5);
    expect(s.get(p.id)!.use_count).toBe(0);
  });

  it('scoreMemory is deterministic and bounded', () => {
    const item: MemoryItem = { id: 'mem-1', kind: 'lesson', scope: { symbol: 'BTCUSDT', timeframe: '15m', regime: 'bear' }, content: 'x', source_refs: [], tags: ['breakout'], confidence: 1, status: 'active', proposed_by: 'agent', supersedes: null, superseded_by: null, created_at: NOW, decided_at: NOW, last_used_at: NOW, use_count: 0, expires_at: null, content_hash: 'h' };
    const full = scoreMemory(item, { symbol: 'BTCUSDT', timeframe: '15m', regime: 'bear', tags: ['breakout'] }, NOW, 1);
    expect(full.score).toBe(1.4);
    expect(scoreMemory(item, { symbol: 'ETHUSDT' }, NOW).score).toBe(0.2);
  });
});

describe('candidate generation', () => {
  const closed = (over: Partial<StrategyThread> = {}): StrategyThread => ({
    ...newThread({ id: 'thr-1', symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '15m', thesis: 't', invalidation_text: null, watch_conditions: [], entry: { type: 'market', price: null, zone: null }, stop_price: '99000', take_profits: ['103000'], qty: '0.1', margin_usdt: null, leverage: 3, margin_mode: 'cross', now: NOW }),
    status: 'closed',
    filled_avg_price: '100000',
    exit_price: '99000',
    realized_pnl: '-100',
    close_reason: '止损触发 @ 99000',
    opened_at: NOW,
    closed_at: NOW + 90 * 60_000,
    episode_ids: ['ep-a', 'ep-b'],
    ...over,
  });

  it('tradeFactCandidate: deterministic fact with R multiple, tags and scope; null for open threads', () => {
    const c = tradeFactCandidate(closed(), { regime: 'bear', trigger: 'breakout', now: NOW })!;
    expect(c.kind).toBe('fact');
    expect(c.proposed_by).toBe('system');
    expect(c.content).toMatch(/BTCUSDT 做多\(agent,15m,日线 bear,触发 breakout\)→ 亏损 -1\.0R,持有 90 分钟/);
    expect(c.tags).toEqual(expect.arrayContaining(['btcusdt', 'long', 'bear', 'breakout', 'loss', 'stopped_out']));
    expect(c.scope).toEqual({ symbol: 'BTCUSDT', timeframe: '15m', regime: 'bear' });
    expect(c.source_refs).toEqual(['thr-1', 'ep-a', 'ep-b']);
    expect(tradeFactCandidate(closed({ status: 'in_position' }), { regime: null, trigger: null })).toBeNull();
    const win = tradeFactCandidate(closed({ exit_price: '103000', realized_pnl: '300', close_reason: '止盈触发' }), { regime: null, trigger: null })!;
    expect(win.content).toMatch(/盈利 \+3\.0R/);
    expect(win.tags).toContain('win');
  });

  it('parseReflectOutput: keeps ≤ 3 well-formed lessons, drops unknown source refs and junk', () => {
    const text = '好的,这是结果:\n[{"content":"bear 里别做多突破","confidence":0.7,"symbol":"BTCUSDT","regime":"bear","tags":["breakout","loss"],"source_refs":["thr-1","thr-zzz"]},{"content":""},{"content":"第二条","confidence":"x"},{"content":"第三条"},{"content":"第四条"}]';
    const out = parseReflectOutput(text, new Set(['thr-1']));
    expect(out.map((o) => o.content)).toEqual(['bear 里别做多突破', '第二条', '第三条']);
    expect(out[0]!.source_refs).toEqual(['thr-1']);
    expect(out[0]!.scope).toEqual({ symbol: 'BTCUSDT', regime: 'bear' });
    expect(out[1]!.confidence).toBe(0.5);
    expect(out.every((o) => o.kind === 'lesson' && o.proposed_by === 'agent')).toBe(true);
    expect(parseReflectOutput('没有规律', new Set())).toEqual([]);
  });
});

describe('memory in the judgment context', () => {
  it('each recalled memory becomes one 记忆 evidence line; the system prompt forbids using its numbers as market data', () => {
    const s = fresh();
    const m = active(s, 'BTC 在 bear 里做多突破 3 次 2 亏,止损常被扫', { scope: { symbol: 'BTCUSDT', regime: 'bear' }, tags: ['breakout'] });
    const built = buildContext({
      now: NOW,
      symbol: 'BTCUSDT',
      trigger: { kind: 'breakout', detail: 'x' },
      mode: 'scan',
      thread: null,
      open_threads: [],
      account: { backend: 'paper', equity: '10000', available: '10000', unrealized_pnl: '0', positions: [], open_orders: [], as_of: NOW },
      market: { symbol: 'BTCUSDT', last: '100', mark: '100', funding_rate: '0', next_funding_at: 0, open_interest: '0', as_of: NOW, klines_tf: '15m' },
      features: [],
      oi_change_1h_pct: null,
      ticker24h: { priceChangePercent: '0', highPrice: '1', lowPrice: '1', quoteVolume: '1' },
      market_state: null,
      playbook_text: 'p',
      last_judgment_summary: null,
      halted: false,
      memories: [m],
    });
    const ev = built.evidence.find((e) => e.kind === 'memory')!;
    expect(ev.label).toBe(`记忆 ${m.id}·教训`);
    expect(ev.value).toContain('止损常被扫');
    expect(ev.value).toContain('范围 BTCUSDT/bear');
    expect(ev.stale).toBe(false);
    expect(built.system_text).toContain('4b.');
    expect(built.user_text).toContain(`${ev.ref} [记忆 ${m.id}·教训]`);
  });

  it('a memory holding a stale price must not be mistaken for market evidence (kind stays memory, source says 长期记忆)', () => {
    const s = fresh();
    const m = active(s, 'BTC 支撑在 95000(上周的观察)', { scope: { symbol: 'BTCUSDT' } });
    const built = buildContext({
      now: NOW,
      symbol: 'BTCUSDT',
      trigger: { kind: 'kline_close', detail: 'x' },
      mode: 'scan',
      thread: null,
      open_threads: [],
      account: { backend: 'paper', equity: '10000', available: '10000', unrealized_pnl: '0', positions: [], open_orders: [], as_of: NOW },
      market: { symbol: 'BTCUSDT', last: '100000', mark: '100000', funding_rate: '0', next_funding_at: 0, open_interest: '0', as_of: NOW, klines_tf: '15m' },
      features: [],
      oi_change_1h_pct: null,
      ticker24h: { priceChangePercent: '0', highPrice: '1', lowPrice: '1', quoteVolume: '1' },
      market_state: null,
      playbook_text: 'p',
      last_judgment_summary: null,
      halted: false,
      memories: [m],
    });
    const marketRefs = built.evidence.filter((e) => e.kind === 'market').map((e) => e.value).join(' ');
    expect(marketRefs).not.toContain('95000');
    const mem = built.evidence.find((e) => e.kind === 'memory')!;
    expect(mem.source).toMatch(/长期记忆/);
  });
});

describe('memory number leak guard (rule 4b, runtime twin of eval memory_number_leak)', () => {
  const ev = (kind: string, value: string) => ({ ref: 'E1', kind, label: 'x', value, observed_at: NOW, source: 's', stale: false });
  const j = (reasons: string[], thesis = 't'): Judgment => ({ action: 'WATCH', direction: null, confidence: 0.5, headline: 'h', thesis, reasons, evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [], proposal: null });
  const evidence = [ev('market', 'last 77202, mark 77205'), ev('structure', '收 77202; EMA20 77212 EMA50 76192'), ev('memory', 'BTC 关键支撑 69470(上周观察)(范围 BTCUSDT,信心 0.70,来源 0 条)')];

  it('flags a number that exists only in memory evidence', () => {
    const leaks = findMemoryNumberLeaks(j(['关键支撑 69470 未破,倾向偏多 [E1]']), evidence);
    expect(leaks).toHaveLength(1);
    expect(leaks[0]).toMatch(/69470/);
  });

  it('does not flag numbers also present in live evidence, nor when no memory was injected', () => {
    expect(findMemoryNumberLeaks(j(['价格 77202 低于 EMA20 77212 [E1]']), evidence)).toEqual([]);
    expect(findMemoryNumberLeaks(j(['支撑 69470 [E1]']), evidence.filter((e) => e.kind !== 'memory'))).toEqual([]);
    // memory confidence "0.70" is < 3 digits before the point and is not a market number anyway
    expect(findMemoryNumberLeaks(j(['信心 0.70 的记忆 [E1]']), evidence)).toEqual([]);
  });

  it('also checks the thesis', () => {
    expect(findMemoryNumberLeaks(j(['ok [E1]'], '只要 69470 不破就偏多'), evidence)).toHaveLength(1);
  });
});
