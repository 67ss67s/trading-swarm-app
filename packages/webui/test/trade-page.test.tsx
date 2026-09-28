/**
 * 交易页改版(components/trade/*):卡住的挂单识别、来源解析、分组、Jev / ASP 联动、行渲染、英文词条。
 * 夹具取自 09-25 LINKUSDT 线程:市价单提交超时(okx spot orders 超时 15000ms),entry_submitted_at 一直为空。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PositionView, StrategyRun, StrategyRunEvent, StrategyThread } from '../src/api/types';
import type { JudgeLiveItem } from '../src/api/judge-live';
import { SUBMIT_PHASE_MAX_MS, activeRuns, aspForThread, groupThreads, judgeForThread, matchesOriginFilter, originCounts, sameOriginFilter, strategyRef, threadForOrder, threadHealth, threadOrigin, unknownEntries } from '../src/components/trade/logic';
import { ThreadRow } from '../src/components/trade/thread-row';
import { TRADE_EN } from '../src/components/trade/i18n-en';
import { EN } from '../src/lib/i18n-en';

const NOW = Date.UTC(2026, 8, 25, 16);
const SINCE = NOW - 13 * 3_600_000; // 03:03 起卡了十几个小时

function thread(over: Partial<StrategyThread> & Record<string, unknown> = {}): StrategyThread {
  return {
    id: 'thr-link',
    symbol: 'LINKUSDT',
    side: 'long',
    status: 'pending_entry',
    source: 'agent',
    timeframe: '15m',
    thesis: '',
    invalidation_text: null,
    watch_conditions: [],
    entry: { type: 'market', price: null, zone: null },
    stop_price: '12.8',
    take_profits: [],
    qty: '372.7',
    margin_usdt: '4981.88',
    leverage: 1,
    margin_mode: 'cross',
    market: 'perp',
    entry_client_order_id: 'tgd-972ecea3153c-e1',
    protection_client_order_ids: [],
    filled_avg_price: null,
    realized_pnl: null,
    close_reason: null,
    attention: null,
    episode_ids: [],
    intent_ids: [],
    created_at: SINCE - 2_000,
    updated_at: SINCE,
    opened_at: null,
    closed_at: null,
    version: 2,
    origin: 'strategy_run:run_a',
    strategy_id: 'rs_aa7@1',
    entry_submitting_since: SINCE,
    entry_submitted_at: null,
    ...over,
  } as StrategyThread;
}

const run = (over: Partial<StrategyRun> = {}): StrategyRun =>
  ({
    id: 'run_a', strategy_id: 'rs_aa7', strategy_name: '多周期对齐', version: 1, latest_version: 1, ir_hash: 'x', timeframe: '15m', mode: 'auto', market: 'perp', direction: 'long', leverage: 1,
    symbols: ['LINKUSDT'], risk_pct: 0.5, max_open: 3, publish_asp: true, status: 'running', error: null, execution: { backend: 'okx', profile: 'demo', label: 'OKX 模拟盘' },
    created_at: NOW - 86_400_000, updated_at: NOW, last_scan_at: NOW, next_scan_at: NOW + 900_000,
    stats: { scans: 161, candidates: 16, orders: 1, pending_approval: 0, skipped: 9, rejected: 1, open_threads: 1, closed: 1, realized_r: -0.22, published: 5, today_orders: 1 },
    ...over,
  }) as StrategyRun;

const pos = (symbol: string): PositionView => ({ symbol, market: 'perp', side: 'long', qty: '1', entry_price: '1', mark_price: '1', unrealized_pnl: '0', leverage: 1 }) as PositionView;

describe('threadHealth', () => {
  it('提交相位过期且没有 entry_submitted_at = 提交结果未知,并写出交易所上有没有仓位', () => {
    const h = threadHealth(thread(), NOW, [pos('BTCUSDT')]);
    expect(h.kind).toBe('submit_unknown');
    expect(h.tone).toBe('danger');
    expect(h.stuckMs).toBe(13 * 3_600_000);
    expect(h.detail).toContain('交易所上没有 LINKUSDT 仓位');
    expect(threadHealth(thread(), NOW, [pos('LINKUSDT')]).detail).toContain('可能是这笔成交了');
    expect(threadHealth(thread(), NOW).detail).not.toContain('仓位');
  });
  it('相位还在上限内 = 提交中;拿到回执 = 正常挂单', () => {
    expect(threadHealth(thread({ entry_submitting_since: NOW - SUBMIT_PHASE_MAX_MS + 1_000 }), NOW).kind).toBe('submitting');
    expect(threadHealth(thread({ entry_submitting_since: null, entry_submitted_at: NOW - 60_000 }), NOW).kind).toBe('ok');
  });
  it('持仓中的线程不看提交相位;attention 码按严重程度上色', () => {
    expect(threadHealth(thread({ status: 'in_position' }), NOW).kind).toBe('ok');
    const a = threadHealth(thread({ entry_submitting_since: null, attention: 'PROTECTION_MISSING' }), NOW);
    expect([a.kind, a.tone, a.label]).toEqual(['attention', 'danger', '止损没挂上']);
    expect(threadHealth(thread({ entry_submitting_since: null, attention: 'ENTRY_EXPIRED' }), NOW).tone).toBe('warn');
    expect(threadHealth(thread({ entry_submitting_since: null, attention: 'SOMETHING_NEW' }), NOW).label).toBe('SOMETHING_NEW');
  });
});

describe('来源与分组', () => {
  it('origin 解析:策略运行 / 跟单 / 手动 / AI Scan;strategy_id 带版本', () => {
    expect(threadOrigin(thread(), [run()])).toMatchObject({ kind: 'run', runId: 'run_a', label: '多周期对齐' });
    expect(threadOrigin(thread(), [])).toMatchObject({ kind: 'run', run: null, label: '策略运行' });
    expect(threadOrigin(thread({ origin: 'trader:老王' }), [])).toMatchObject({ kind: 'trader', label: '跟单 老王' });
    expect(threadOrigin(thread({ origin: undefined, source: 'manual' }), []).kind).toBe('manual');
    expect(threadOrigin(thread({ origin: undefined, source: 'agent' }), [])).toMatchObject({ kind: 'ai_scan', label: 'AI Scan' });
    expect(strategyRef(thread())).toEqual({ id: 'rs_aa7', version: 1 });
    expect(strategyRef(thread({ strategy_id: null }))).toBeNull();
  });
  it('卡住的挂单归到「需要处理」,不和正常待入场混在一起', () => {
    const normal = thread({ id: 'thr-ok', symbol: 'ETHUSDT', entry_submitting_since: null, entry_submitted_at: NOW - 60_000 });
    const holding = thread({ id: 'thr-pos', symbol: 'BTCUSDT', status: 'in_position', entry_submitting_since: null });
    const g = groupThreads([normal, thread(), holding], NOW, []);
    expect(g.action.map((r) => r.thread.id)).toEqual(['thr-link']);
    expect(g.pending.map((r) => r.thread.id)).toEqual(['thr-ok']);
    expect(g.holding.map((r) => r.thread.id)).toEqual(['thr-pos']);
    expect(unknownEntries([normal, thread(), holding], NOW).map((r) => r.thread.id)).toEqual(['thr-link']);
  });
  it('挂单归属按 clientOrderId 对到入场腿或保护腿', () => {
    const th = thread({ protection_client_order_ids: ['tgd-x-s2'] });
    expect(threadForOrder({ client_order_id: 'tgd-x-s2' } as never, [th])?.id).toBe('thr-link');
    expect(threadForOrder({ client_order_id: 'other' } as never, [th])).toBeNull();
  });
  it('顶部条只放没停的运行,运行中在前', () => {
    expect(activeRuns([run({ id: 'b', status: 'paused' }), run({ id: 'c', status: 'stopped' }), run({ id: 'a' })]).map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('Jev / ASP 联动', () => {
  it('Jev 判断先按 outcome.thread_id 对,对不上再按同运行 + 同币同向 + 15 分钟窗对(影子判断常常没回填 outcome)', () => {
    const th = thread();
    const j = (id: string, over: Record<string, unknown> = {}) => ({ id, run_id: 'run_a', symbol: 'LINKUSDT', candidate: { direction: 'long' }, created_at: th.created_at - 30_000, outcome: null, ...over });
    const items = [j('near'), j('direct', { outcome: { thread_id: 'thr-link' }, run_id: 'other' })] as unknown as JudgeLiveItem[];
    expect(judgeForThread(th, items)?.id).toBe('direct');
    expect(judgeForThread(th, [j('near'), j('far', { created_at: th.created_at - 5_000 })] as unknown as JudgeLiveItem[])?.id).toBe('far');
    expect(judgeForThread(th, [j('x', { run_id: 'run_b' }), j('y', { candidate: { direction: 'short' } }), j('z', { created_at: th.created_at - 3_600_000 })] as unknown as JudgeLiveItem[])).toBeNull();
    expect(judgeForThread(th, [j('taken', { outcome: { thread_id: 'thr-other' } })] as unknown as JudgeLiveItem[])).toBeNull();
    expect(judgeForThread(thread({ origin: undefined }), [j('near')] as unknown as JudgeLiveItem[])).toBeNull();
  });
  it('来源筛选:AI Scan / 手动(含对话)/ 某一个运行;跟单只在全部里', () => {
    const manual = thread({ id: 'm', origin: undefined, source: 'manual' });
    const chat = thread({ id: 'c', origin: undefined, source: 'chat' });
    const ai = thread({ id: 'a', origin: undefined, source: 'agent' });
    const trader = thread({ id: 't', origin: 'trader:老王', source: 'agent' });
    const runA = thread();
    const pick = (f: Parameters<typeof matchesOriginFilter>[1]) => [manual, chat, ai, trader, runA].filter((x) => matchesOriginFilter(x, f)).map((x) => x.id);
    expect(pick(null)).toEqual(['m', 'c', 'a', 't', 'thr-link']);
    expect(pick('ai_scan')).toEqual(['a']);
    expect(pick('manual')).toEqual(['m', 'c']);
    expect(pick({ runId: 'run_a' })).toEqual(['thr-link']);
    expect(pick({ runId: 'run_b' })).toEqual([]);
    expect(originCounts([manual, chat, ai, trader, runA])).toEqual({ all: 5, ai_scan: 1, manual: 2, runs: { run_a: 1 } });
    expect(sameOriginFilter({ runId: 'x' }, { runId: 'x' })).toBe(true);
    expect(sameOriginFilter({ runId: 'x' }, 'ai_scan')).toBe(false);
    expect(sameOriginFilter(null, null)).toBe(true);
  });
  it('ASP:同币、时间窗内有 published 事件 = 已发;运行没开 = off;开了但没查到 = not_found', () => {
    const ev = (at: number, symbol = 'LINKUSDT'): StrategyRunEvent => ({ id: `e${at}`, run_id: 'run_a', at, kind: 'published', symbol, message: '', data: null });
    const th = thread();
    expect(aspForThread(th, run(), [ev(th.created_at + 60_000)]).kind).toBe('published');
    expect(aspForThread(th, run(), [ev(th.created_at + 60_000, 'BTCUSDT')]).kind).toBe('not_found');
    expect(aspForThread(th, run(), [ev(th.created_at + 3_600_000)]).kind).toBe('not_found');
    expect(aspForThread(th, run({ publish_asp: false }), []).kind).toBe('off');
    expect(aspForThread(th, run(), undefined).kind).toBe('unknown');
    expect(aspForThread(th, null, []).kind).toBe('unknown');
  });
});

describe('渲染与词条', () => {
  it('卡住的线程行:红色「提交结果未知」+ 「撤单并核对」,来源写策略名', () => {
    const th = thread();
    const html = renderToStaticMarkup(<ThreadRow thread={th} health={threadHealth(th, NOW, [])} origin={threadOrigin(th, [run()])} judge={null} selected={false} onSelect={() => {}} onClose={() => {}} />);
    expect(html).toContain('trade-thread-stuck');
    expect(html).toContain('提交结果未知');
    expect(html).toContain('撤单并核对');
    expect(html).toContain('多周期对齐');
  });
  it('新文案都有英文,并已并进全局词典', () => {
    const src = ['logic.ts', 'context-bar.tsx', 'thread-row.tsx', 'thread-detail.tsx', 'sources-logic.ts', 'source-card.tsx', 'sources-column.tsx', 'risk-panel.tsx', 'write-lock.ts'].map((f) => readFileSync(new URL(`../src/components/trade/${f}`, import.meta.url), 'utf8')).join('\n');
    const keys = [...src.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]!);
    const missing = [...new Set(keys)].filter((k) => !(k in EN));
    expect(missing).toEqual([]);
    for (const k of Object.keys(TRADE_EN)) expect(EN[k]).toBeTruthy();
  });
});
