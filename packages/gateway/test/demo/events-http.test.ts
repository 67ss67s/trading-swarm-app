// 事件区路由(routes-events.ts,经 http-extra.ts 注册)+ event 触发器 + workflow 新字段。
// 走真实 createServer;大脑是 stub,不调任何付费模型,不连交易所。

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/demo/calendar-feed.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/demo/calendar-feed.js')>(),
  fetchCalendar: vi.fn(async () => ({ entries: [], warnings: [] })),
  publicText: vi.fn(async () => '官方公告摘录，仅用于研究测试'),
}));
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import type { Brain } from '../../src/demo/brain.js';
import * as calendarFeed from '../../src/demo/calendar-feed.js';
import { makeEvent } from '../../src/demo/events.js';
import type { StrategySpec } from '../../src/demo/strategies.js';
import type { TriggerHit } from '../../src/demo/types.js';
import { newThread } from '../../src/demo/threads.js';
import { detectEventTriggers } from '../../src/demo/triggers.js';
import { applyWorkflowPatch, DEFAULT_WORKFLOW } from '../../src/demo/workflow.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';

const H = 3_600_000;

let fakeMarket: FakeMarketServer;
let cacheDir = '';
let DemoRuntime: typeof import('../../src/demo/runtime.js').DemoRuntime;
let createServer: typeof import('../../src/demo/http.js').createServer;

beforeAll(async () => {
  fakeMarket = await startFakeMarketServer();
  cacheDir = mkdtempSync(join(tmpdir(), 'tg-events-http-'));
  process.env['TG_DEMO_MARKET_BASE'] = fakeMarket.url;
  process.env['TG_DEMO_KLINE_CACHE_DIR'] = cacheDir;
  ({ DemoRuntime } = await import('../../src/demo/runtime.js'));
  ({ createServer } = await import('../../src/demo/http.js'));
});

afterAll(async () => {
  await fakeMarket.close();
  rmSync(cacheDir, { recursive: true, force: true });
  delete process.env['TG_DEMO_MARKET_BASE'];
  delete process.env['TG_DEMO_KLINE_CACHE_DIR'];
});

const stubBrain: Brain = { name: 'stub', async complete(_system, user) {
  if (!user.trim().startsWith('{')) return { text: JSON.stringify({ action: 'NO_TRADE', direction: null, confidence: 0.2, headline: '事件判断测试', thesis: '背景证据', reasons: ['背景 [E1]'], evidence_refs: ['E1'], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [], proposal: null }), latency_ms: 1, model: 'stub' };
  const p = JSON.parse(user);
  const value = p.catalog ? { sources: [{ url: p.catalog[0], why: '确定性来源' }], questions: ['事件是什么？'] }
    : { findings: [{ claim: '一段简报', refs: [p.excerpts[0].id] }] };
  return { text: JSON.stringify(value), latency_ms: 1, model: 'stub', input_tokens: 10, output_tokens: 5 };
} };

let activeHttp: http.Server | null = null;
let activeRt: InstanceType<typeof DemoRuntime> | null = null;
let activeState: StateDb | null = null;
let baseUrl = '';
let store: DemoStore;

async function setup(): Promise<void> {
  const state = openStateDb(':memory:');
  store = new DemoStore(state);
  const rt = new DemoRuntime({ store, backend: new PaperBackend(10_000), brains: { stub: stubBrain }, marketPollMs: 600_000, accountPollMs: 600_000 });
  await rt.start();
  rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'], timeframe: '15m' });
  const server = createServer(rt, store);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  activeHttp = server;
  activeRt = rt;
  activeState = state;
}

afterEach(async () => {
  if (activeHttp) {
    activeHttp.closeAllConnections?.();
    await new Promise<void>((r) => activeHttp!.close(() => r()));
  }
  if (activeRt) await activeRt.stop();
  activeState?.close();
  activeHttp = null;
  activeRt = null;
  activeState = null;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe('GET /api/market-events', () => {
  it('列表带窗口派生字段、同类统计、日历元信息与闸开关', async () => {
    await setup();
    const now = Date.now();
    store.events.save(makeEvent({ kind: 'scheduled', subkind: 'fomc', title: 'FOMC 利率决议', assets: [], expected_at: now + 2 * H, window_ms: 4 * H, captured_at: now, source: 'calendar', confidence: 'confirmed', dedupe_key: 'k-fomc' }));
    const r = await api('GET', '/api/market-events');
    expect(r.status).toBe(200);
    expect(r.json.events).toHaveLength(1);
    const e = r.json.events[0];
    expect(e).toMatchObject({ kind: 'scheduled', subkind: 'fomc', status: 'captured', confidence: 'confirmed', in_window: false });
    expect(e.starts_at).toBe(now + 2 * H);
    expect(e.ends_at).toBe(now + 6 * H);
    expect(e.minutes_to_start).toBeGreaterThan(110);
    // 可为 null 的字段真的是 null,不是缺字段
    expect(e.impact).toBeNull();
    expect(e.brief).toBeNull();
    expect(r.json.stats.fomc).toMatchObject({ subkind: 'fomc', samples: 0, avg_abs_move_4h_pct: null, direction_agreement: null });
    expect(r.json.calendar.last_verified_at).toBeNull(); // 尚未成功动态核验
    expect(r.json.calendar.warnings).toEqual([]);
    expect(r.json.calendar.feeds).toBe(0); // 订阅源默认空
    expect(r.json.event_blackout_min).toBe(0);
    expect(r.json.brief_usage_today).toEqual({ calls: 0, input_tokens: 0, output_tokens: 0 });
    expect(r.json.subkinds).toContain('unclassified');
  });

  it('status / asset / since 筛选;非法 status 与 since 报 400', async () => {
    await setup();
    const now = Date.now();
    store.events.save({ ...makeEvent({ kind: 'news', subkind: 'hack', title: 'ETH 协议被攻击', assets: ['ETH'], window_ms: H, captured_at: now - 10 * H, source: 'x', dedupe_key: 'a' }), status: 'resolved' });
    store.events.save(makeEvent({ kind: 'news', subkind: 'listing', title: 'SOL 上线', assets: ['SOL'], window_ms: H, captured_at: now, source: 'x', dedupe_key: 'b' }));
    expect((await api('GET', '/api/market-events?status=resolved')).json.events.map((e: { subkind: string }) => e.subkind)).toEqual(['hack']);
    expect((await api('GET', '/api/market-events?asset=SOLUSDT')).json.events.map((e: { subkind: string }) => e.subkind)).toEqual(['listing']);
    expect((await api('GET', `/api/market-events?since=${now - H}`)).json.events.map((e: { subkind: string }) => e.subkind)).toEqual(['listing']);
    expect((await api('GET', '/api/market-events?status=nope')).status).toBe(400);
    expect((await api('GET', '/api/market-events?since=abc')).status).toBe(400);
  });
});

it('GET /api/market-events/:id 给详情 + 同类统计;未知 id 404', async () => {
  await setup();
  const e = makeEvent({ kind: 'news', subkind: 'cpi', title: 'CPI 数据', captured_at: Date.now(), window_ms: 2 * H, source: 'x', dedupe_key: 'c' });
  store.events.save(e);
  const r = await api('GET', `/api/market-events/${e.id}`);
  expect(r.status).toBe(200);
  expect(r.json.event.id).toBe(e.id);
  expect(r.json.stats.subkind).toBe('cpi');
  expect((await api('GET', '/api/market-events/ev-nope')).status).toBe(404);
});

describe('POST /api/market-events(手动补录)', () => {
  it('补一条预定事件:201 + 落库,subkind 以人填的为准', async () => {
    await setup();
    const at = Date.now() + 6 * H;
    const r = await api('POST', '/api/market-events', { title: '某交易所维护公告', subkind: 'listing', kind: 'scheduled', expected_at: at, assets: ['SOLUSDT'] });
    expect(r.status).toBe(201);
    expect(r.json.created).toBe(true);
    expect(r.json.event).toMatchObject({ subkind: 'listing', source: 'manual', confidence: 'confirmed', status: 'captured', expected_at: at });
    expect(r.json.event.assets).toEqual(['SOL']); // USDT 后缀被剥掉
    expect(store.events.list({}).length).toBe(1);
  });

  it('不填 subkind → unclassified;不填 expected_at → news,窗口从现在起算', async () => {
    await setup();
    const r = await api('POST', '/api/market-events', { title: '随便一件事' });
    expect(r.status).toBe(201);
    expect(r.json.event).toMatchObject({ subkind: 'unclassified', kind: 'news', expected_at: null });
    expect(r.json.event.in_window).toBe(true);
  });

  it('参数校验:title 必填,kind / confidence / expected_at 非法都 400', async () => {
    await setup();
    expect((await api('POST', '/api/market-events', { title: '  ' })).status).toBe(400);
    expect((await api('POST', '/api/market-events', { title: 'x', kind: 'wat' })).status).toBe(400);
    expect((await api('POST', '/api/market-events', { title: 'x', confidence: 'maybe' })).status).toBe(400);
    expect((await api('POST', '/api/market-events', { title: 'x', expected_at: 'soon' })).status).toBe(400);
  });

  it('同标题同时刻补两次 = 同一条(200 + created:false)', async () => {
    await setup();
    const at = Date.now() + H;
    expect((await api('POST', '/api/market-events', { title: '同一件事', expected_at: at })).json.created).toBe(true);
    const again = await api('POST', '/api/market-events', { title: '同一件事', expected_at: at });
    expect(again.status).toBe(200);
    expect(again.json.created).toBe(false);
    expect(store.events.list({}).length).toBe(1);
  });
});

it('POST /api/market-events/:id/dismiss 标记不算事件(幂等);未知 id 404', async () => {
  await setup();
  const e = makeEvent({ kind: 'news', subkind: 'unclassified', title: '噪音', captured_at: Date.now(), window_ms: H, source: 'x', dedupe_key: 'd' });
  store.events.save(e);
  const r = await api('POST', `/api/market-events/${e.id}/dismiss`);
  expect(r.status).toBe(200);
  expect(r.json.event.status).toBe('dismissed');
  expect(r.json.event.dismissed_at).toBeGreaterThan(0);
  expect((await api('POST', `/api/market-events/${e.id}/dismiss`)).json.event.status).toBe('dismissed');
  expect((await api('POST', '/api/market-events/ev-nope/dismiss')).status).toBe(404);
});

describe('detectEventTriggers', () => {
  const live = (p: Partial<Parameters<typeof detectEventTriggers>[0]['live_events'][number]> = {}) => ({ id: 'ev-1', subkind: 'fomc', title: 'FOMC', confidence: 'confirmed', expected_at: 1_000 * H, captured_at: 999 * H, assets: [], ...p });

  it('窗口内每条事件一个 kind:event 的 hit,confirmed 分最高', () => {
    const hits = detectEventTriggers({ now: 1_000 * H + 30 * 60_000, live_events: [live(), live({ id: 'ev-2', confidence: 'rumor', subkind: 'hack', assets: ['BTC'] })] });
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.kind === 'event')).toBe(true);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    expect(hits[0]!.detail).toMatch(/已开始 30 分钟/);
  });

  it('没有窗口内事件就没有 hit(不会凭空把模型叫醒)', () => {
    expect(detectEventTriggers({ now: 1, live_events: [] })).toEqual([]);
  });
});

describe('workflow.event_blackout_min', () => {
  it('默认 0 = 关闭', () => {
    expect(DEFAULT_WORKFLOW.event_blackout_min).toBe(0);
  });
  it('0–360 之间的整数可改;越界 / 非整数报错而不是静默钳', () => {
    expect(applyWorkflowPatch(DEFAULT_WORKFLOW, { event_blackout_min: 45 })).toMatchObject({ next: { event_blackout_min: 45 }, errors: [] });
    expect(applyWorkflowPatch(DEFAULT_WORKFLOW, { event_blackout_min: 0 }).errors).toEqual([]);
    expect(applyWorkflowPatch(DEFAULT_WORKFLOW, { event_blackout_min: 999 }).errors[0]).toMatch(/0–360/);
    expect(applyWorkflowPatch(DEFAULT_WORKFLOW, { event_blackout_min: -1 }).errors[0]).toMatch(/0–360/);
    expect(applyWorkflowPatch(DEFAULT_WORKFLOW, { event_blackout_min: 1.5 }).errors[0]).toMatch(/0–360/);
  });
  it('PUT /api/workflow 能改,且出现在 /api/market-events 上', async () => {
    await setup();
    const r = await api('POST', '/api/workflow', { event_blackout_min: 30 });
    expect(r.status).toBe(200);
    expect((await api('GET', '/api/market-events')).json.event_blackout_min).toBe(30);
  });
});

describe('runtime.eventsTick 生命周期', () => {
  it('T−24h 创建研究并产出带refs简报,预算独立于usage_today', async () => {
    await setup();
    const now = Date.now();
    const e = makeEvent({ kind: 'scheduled', subkind: 'fomc', title: 'FOMC 利率决议', assets: [], expected_at: now + 30 * 60_000, window_ms: 4 * H, captured_at: now - H, source: 'calendar', confidence: 'confirmed', dedupe_key: 'tick-1' });
    store.events.save(e);
    await activeRt!.eventsTick(now);
    const after = store.events.get(e.id)!;
    expect(after.status).toBe('briefed');
    expect(after.brief_count).toBe(1);
    expect(after.brief!.lead_minutes).toBe(1440);
    expect(after.brief!.text).toContain('一段简报');
    expect(after.brief!.source).toBe('research');
    expect(after.brief!.refs.length).toBeGreaterThan(0);
    expect(store.events.research.list()[0]).toMatchObject({ kind: 'event_prep', status: 'done' });
    expect(store.events.research.usage(now)).toMatchObject({ model_calls: 2, fetches: 1 });
    expect(activeRt!.usageToday().judgments).toBe(0); // 简报不是 episode
  });

  it('暂停时一次模型都不叫', async () => {
    await setup();
    const now = Date.now();
    activeRt!.setWorkflow({ paused: true });
    const e = makeEvent({ kind: 'scheduled', subkind: 'cpi', title: 'CPI', assets: [], expected_at: now + 30 * 60_000, window_ms: 2 * H, captured_at: now - H, source: 'calendar', confidence: 'confirmed', dedupe_key: 'tick-2' });
    store.events.save(e);
    await activeRt!.eventsTick(now);
    expect(store.events.get(e.id)!.brief_count).toBe(0);
    expect(store.events.get(e.id)!.status).toBe('captured');
    expect(activeRt!.eventBriefUsageToday(now).calls).toBe(0);
  });

  it('窗口内 → live;窗口结束后代码回填 impact 并推到 retro_done', async () => {
    await setup();
    const now = Date.now();
    const liveEv = makeEvent({ kind: 'scheduled', subkind: 'nfp', title: '非农', assets: [], expected_at: now - H, window_ms: 4 * H, captured_at: now - 5 * H, source: 'calendar', confidence: 'confirmed', dedupe_key: 'tick-3' });
    store.events.save(liveEv);
    await activeRt!.eventsTick(now);
    expect(store.events.get(liveEv.id)!.status).toBe('live');

    // 30 小时前的事件:窗口早过完,1h K 线也够算 1h/4h/24h
    const oldEv = makeEvent({ kind: 'scheduled', subkind: 'nfp', title: '上个月非农', assets: [], expected_at: now - 30 * H, window_ms: 4 * H, captured_at: now - 40 * H, source: 'calendar', confidence: 'confirmed', dedupe_key: 'tick-4' });
    store.events.save(oldEv);
    await activeRt!.eventsTick(now);
    const done = store.events.get(oldEv.id)!;
    expect(done.status).toBe('retro_done');
    expect(done.impact).not.toBeNull();
    expect(done.impact!.symbol).toBe('BTCUSDT'); // 宏观事件用 BTC 代表大盘
    expect(done.impact!.base_price).toBeGreaterThan(0);
    expect(typeof done.impact!.move_4h_pct).toBe('number');
    // 复盘完的进了同 subkind 统计
    expect(store.events.stats('nfp').samples).toBe(1);
  });
});

describe('research HTTP API persists user assignments', () => {
  it('creates topic task and returns list/detail/excerpts from SQLite', async () => {
    await setup();
    const due = Date.now() + H;
    const created = await api('POST', '/api/research', { topic: '  美国就业背景  ', due_at: due });
    expect(created.status).toBe(201);
    const t = created.json.task;
    expect(t).toMatchObject({ kind: 'topic', topic: '美国就业背景', event_id: null, assigned_by: 'user', status: 'planned', due_at: due });
    expect(store.events.research.get(t.id)).toEqual(t);
    const excerptId = store.events.research.excerpt(t.id, 'https://www.bls.gov/', '持久化摘录', Date.now());
    const listed = await api('GET', '/api/research?limit=1');
    expect(listed.status).toBe(200);
    expect(listed.json.tasks).toEqual([t]);
    expect(listed.json.usage).toEqual({ model_calls: 0, fetches: 0 });
    expect(listed.json.daily_cap).toEqual(DEFAULT_WORKFLOW.research_daily_cap);
    const detail = await api('GET', `/api/research/${t.id}`);
    expect(detail.json.task).toEqual(t);
    expect(detail.json.excerpts[0]).toMatchObject({ id: excerptId, body: '持久化摘录', url: 'https://www.bls.gov/' });
  });

  it('links event prep and delays release until T+2min, defaulting topic to event title', async () => {
    await setup();
    const at = Date.now() + H;
    const e = makeEvent({ kind: 'scheduled', subkind: 'cpi', title: 'CPI 发布', expected_at: at, captured_at: Date.now(), window_ms: H, source: 'manual', dedupe_key: 'api-research-event' });
    store.events.save(e);
    const prep = await api('POST', '/api/research', { kind: 'event_prep', event_id: e.id });
    expect(prep.status).toBe(201);
    expect(prep.json.task).toMatchObject({ event_id: e.id, kind: 'event_prep', topic: e.title });
    const release = await api('POST', '/api/research', { kind: 'event_release', event_id: e.id, due_at: Date.now() });
    expect(release.status).toBe(201);
    expect(release.json.task.due_at).toBe(at + 120000);
    const listing = await api('GET', '/api/market-events');
    expect(listing.json.events.find((x: { id: string }) => x.id === e.id).research_status).toBe('planned');
    expect(store.events.research.list()).toHaveLength(2);
  });

  it('rejects bad kind, topic, time, event association and list limits without inserting', async () => {
    await setup();
    const bodies = [
      {}, { topic: '  ' }, { topic: 42 }, { topic: 'x'.repeat(1001) },
      { topic: 'x', kind: 'calendar_refresh' }, { topic: 'x', kind: 'write_money' },
      { topic: 'x', due_at: 'tomorrow' }, { topic: 'x', due_at: -1 },
      { topic: 'x', due_at: 1.5 }, { topic: 'x', due_at: Date.now() + 366 * 86400000 },
      { topic: 'x', event_id: 3 }, { topic: 'x', kind: 'event_prep' },
    ];
    for (const body of bodies) expect((await api('POST', '/api/research', body)).status, JSON.stringify(body)).toBe(400);
    expect((await api('POST', '/api/research', { topic: 'x', event_id: 'missing' })).status).toBe(404);
    const news = makeEvent({ kind: 'news', subkind: 'unclassified', title: '新闻', captured_at: Date.now(), window_ms: H, source: 'manual', dedupe_key: 'api-news' });
    store.events.save(news);
    expect((await api('POST', '/api/research', { kind: 'event_release', event_id: news.id })).status).toBe(400);
    store.events.dismiss(news.id);
    expect((await api('POST', '/api/research', { event_id: news.id })).status).toBe(409);
    for (const limit of ['0', '501', '1.5', 'bad']) expect((await api('GET', `/api/research?limit=${limit}`)).status).toBe(400);
    expect((await api('GET', '/api/research/missing')).status).toBe(404);
    expect(store.events.research.list()).toEqual([]);
  });

  it('cancel is idempotent and cannot rewrite completed or failed terminal tasks', async () => {
    await setup();
    const created = await api('POST', '/api/research', { topic: '取消研究' });
    const id = created.json.task.id;
    const first = await api('POST', `/api/research/${id}/cancel`);
    expect(first.status).toBe(200);
    expect(first.json.task.status).toBe('cancelled');
    expect((await api('POST', `/api/research/${id}/cancel`)).json.task).toEqual(first.json.task);
    expect(store.events.research.get(id)).toEqual(first.json.task);
    for (const status of ['done', 'failed'] as const) {
      const t = store.events.research.create({ kind: 'topic', topic: status, assigned_by: 'user', due_at: Date.now() });
      t.status = status; t.finished_at = Date.now(); store.events.research.save(t);
      expect((await api('POST', `/api/research/${t.id}/cancel`)).json.task).toEqual(t);
    }
    expect((await api('POST', '/api/research/missing/cancel')).status).toBe(404);
  });
});


it('SSE /api/events publishes market_event and research_task after HTTP mutations', async () => {
  await setup();
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let stream = '';
  const readUntil = async (needle: string) => {
    while (!stream.includes(needle)) {
      const next = await reader.read();
      if (next.done) throw new Error('SSE closed before expected event');
      stream += decoder.decode(next.value, { stream: true });
    }
  };
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    await readUntil('event: loop.state');
    const event = await api('POST', '/api/market-events', { title: 'SSE研究关联事件' });
    await readUntil('event: market_event');
    expect(stream).toContain(event.json.event.id);
    const research = await api('POST', '/api/research', { topic: 'SSE研究请求' });
    await readUntil('event: research_task');
    expect(stream).toContain(research.json.task.id);
    expect(store.events.research.get(research.json.task.id)).not.toBeNull();
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader.cancel().catch(() => {});
  }
});


it('new news, configured feed and derived captures each emit market_event', async () => {
  await setup();
  const now = Date.now(); const published: { kind: string; source: string }[] = [];
  activeRt!.on('market_event', e => published.push(e));
  const runtime = activeRt as unknown as {
    captureNewsEvents(news: unknown[], now: number): void;
    captureCalendarEvents(now: number): Promise<void>;
    applyEventZone(hits: Map<string, unknown[]>, now: number): void;
  };
  runtime.captureNewsEvents([{ id: 'rss-test', kind: 'news', source: 'coindesk', source_ref: 'https://coindesk.com/item', title: 'US CPI comes in hot', digest: 'news', occurred_at: now, observed_at: now, ingested_at: now, assets: [], dedupe_key: 'rss-test' }], now);
  runtime.applyEventZone(new Map([['BTCUSDT', [{ kind: 'funding', detail: 'extreme', score: 90 }]]]), now);
  vi.stubEnv('TG_DEMO_EVENT_FEEDS', JSON.stringify([{ name: 'testfeed', kind: 'onchain', url: 'https://bls.gov/test-feed', format: 'json' }]));
  vi.mocked(calendarFeed.publicText).mockResolvedValueOnce(JSON.stringify([{ title: 'ARB token unlock', at: now, url: 'https://bls.gov/item' }]));
  try { await runtime.captureCalendarEvents(now); }
  finally { vi.unstubAllEnvs(); }
  expect(published).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'news', source: 'coindesk' }), expect.objectContaining({ kind: 'derived', source: 'triggers' }), expect.objectContaining({ kind: 'onchain', source: 'testfeed' })]));
});


it('calendar refresh retains verified cache on fallback and never merges manual events', async () => {
  await setup();
  const now = Date.now(); const at = now + 3 * 86400000;
  const observation: calendarFeed.CalendarObservation = { subkind: 'cpi', metric: 'mom_pct_sa', title: 'CPI m/m', expected_at: at, source_ref: 'https://bls.gov/calendar', consensus: '0.2%', previous: '0.1%', importance: 'high', calendar_status: 'confirmed', observations: [], verified_at: now - H, fallback: false };
  const cached = { ...makeEvent({ kind: 'scheduled', subkind: 'cpi', title: 'CPI m/m', expected_at: at, source: 'calendar', captured_at: now, dedupe_key: 'verified-cache' }), calendar: observation, consensus: '0.2%' };
  store.events.save(cached);
  const runtime = activeRt as unknown as { captureCalendarEvents(now: number): Promise<void> };
  store.kvSet('events.calendar_refresh', '0');
  vi.mocked(calendarFeed.fetchCalendar).mockResolvedValueOnce({ entries: [{ ...observation, fallback: true, calendar_status: 'reported', consensus: null }], warnings: ['network unavailable'] });
  await runtime.captureCalendarEvents(now);
  expect(store.events.get(cached.id)).toEqual(cached);
  const manual = makeEvent({ kind: 'scheduled', subkind: 'ppi', title: '人工PPI事件', expected_at: at, source: 'manual', captured_at: now, dedupe_key: 'manual-retained' });
  store.events.save(manual);
  store.kvSet('events.calendar_refresh', '0');
  vi.mocked(calendarFeed.fetchCalendar).mockResolvedValueOnce({ entries: [{ ...observation, subkind: 'ppi', title: 'PPI m/m' }], warnings: [] });
  await runtime.captureCalendarEvents(now);
  expect(store.events.get(manual.id)).toEqual(manual);
  expect(store.events.list({ subkind: 'ppi' })).toHaveLength(2);
});

it('generic official refresh cannot overwrite a generic-ID event later enriched with metric research', async () => {
  await setup();
  const now = Date.now(); const at = now + 3 * 86400000;
  const generic: calendarFeed.CalendarObservation = { subkind: 'cpi', title: 'Consumer Price Index', expected_at: at, source_ref: 'https://bls.gov/calendar', consensus: null, previous: null, importance: 'high', calendar_status: 'reported', observations: [], verified_at: now, fallback: false };
  const runtime = activeRt as unknown as { captureCalendarEvents(now: number): Promise<void> };
  const refresh = async (entry: calendarFeed.CalendarObservation, time: number) => {
    store.kvSet('events.calendar_refresh', '0');
    vi.mocked(calendarFeed.fetchCalendar).mockResolvedValueOnce({ entries: [entry], warnings: [] });
    await runtime.captureCalendarEvents(time);
  };
  await refresh(generic, now);
  const originalId = store.events.list({ subkind: 'cpi' })[0]!.id;
  await refresh({ ...generic, metric: 'mom_pct_sa', title: 'CPI m/m', consensus: '0.2%', previous: '0.1%' }, now + 1);
  const enriched = store.events.get(originalId)!;
  expect(enriched.calendar?.metric).toBe('mom_pct_sa');
  const brief = { at: now, text: '发布研究', refs: ['actual-proof'], source: 'research' as const, task_id: 'research-done', lead_minutes: null };
  store.events.save({ ...enriched, actual: '0.3', actual_metric: 'mom_pct_sa', actual_refs: ['actual-proof'], surprise: '0.1', brief, briefs: [brief], brief_count: 1 });
  await refresh({ ...generic, verified_at: now + 2 }, now + 2);
  expect(store.events.list({ subkind: 'cpi' })).toHaveLength(1);
  expect(store.events.get(originalId)).toMatchObject({ consensus: '0.2%', previous: '0.1%', actual: '0.3', actual_refs: ['actual-proof'], surprise: '0.1', brief, brief_count: 1, calendar: { metric: 'mom_pct_sa' } });
});


it('event zone → research task → matching strategy → persisted judgment, excluding stale and legacy evidence', async () => {
  await setup();
  const rt = activeRt!;
  const now = Date.now();
  const e = makeEvent({ kind: 'scheduled', subkind: 'fomc', title: '官方利率日程', assets: [], expected_at: now + 600000, captured_at: now - H, source: 'calendar', source_ref: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', confidence: 'confirmed', dedupe_key: 'p5b-wake' });
  store.events.save(e);
  await rt.eventsTick(now);
  const researched = store.events.get(e.id)!;
  const taskId = researched.brief!.task_id!;
  expect(store.events.research.get(taskId)?.status).toBe('done');
  expect((await api('GET', `/api/research/${taskId}`)).json.excerpts.length).toBeGreaterThan(0);
  store.events.save({ ...researched, expected_at: now - 1000 });
  const lib = store.strategies as unknown as { write(s: StrategySpec): void };
  lib.write({ ...store.strategies.head('breakout_retest')!, status: 'paper', evidence: { indicators: [], events: ['fomc'] } });
  lib.write({ ...store.strategies.head('mtf_alignment')!, status: 'paper', evidence: { indicators: [], events: ['unlock'] } });
  rt.setWorkflow({ active_strategies: ['breakout_retest', 'mtf_alignment'], council_model: 'off' });
  const hitsBySymbol = new Map<string, TriggerHit[]>();
  (rt as unknown as { applyEventZone(h: Map<string, TriggerHit[]>, now: number): void }).applyEventZone(hitsBySymbol, now);
  const hits = hitsBySymbol.get('BTCUSDT')!;
  expect(hits).toEqual([expect.objectContaining({ kind: 'event', event_id: e.id, event_subkind: 'fomc', research_task_id: taskId, source_ref: e.source_ref })]);
  const scan = async (manual = false, emptyEvents = false) => {
    expect(rt.scan('BTCUSDT', manual ? { kind: 'manual', detail: '手动复核' } : { kind: 'event', detail: '事件窗口', hits: emptyEvents ? [] : hits })).toBe(true);
    await vi.waitFor(() => expect(rt.queueView()).toMatchObject({ pending: 0, running: null }), { timeout: 10000 });
    const row = store.episodes(1)[0]!;
    const ep = store.episode(row.id)!;
    expect(ep.status).toBe('done');
    return ep;
  };
  const ep = await scan();
  // §9.54(09-25):旧策略库退出开仓票池,事件窗口不再把旧库策略带进判断;其余链路(事件 → 研究任务 → 判断落库)不变
  expect(ep.strategy_refs?.map(s => s.id) ?? []).toEqual([]);
  expect(ep.trigger.hits).toEqual(hits);
  expect(ep.context_text).toContain(`event_id=${e.id}`);
  expect(ep.context_text).toContain(`task_id=${taskId}`);
  expect(ep.context_text).toContain('一手研究简报');
  expect(ep.context_text).toContain(researched.brief!.refs[0]);
  (rt as unknown as { lastTriggerHits: Map<string, TriggerHit[]> }).lastTriggerHits.set('BTCUSDT', hits);
  const manual = await scan(true);
  expect(manual.strategy_refs?.map(s => s.id) ?? []).toEqual([]);
  expect(manual.trigger.hits).toEqual([]);
  const empty = await scan(false, true);
  expect(empty.trigger.hits).toEqual([]);
  expect(empty.strategy_refs).toEqual([]);
  store.events.save({ ...store.events.get(e.id)!, brief: { at: now, text: '旧统计假装一手', refs: ['https://example.com'] } });
  const legacy = await scan();
  expect(legacy.context_text).not.toContain('旧统计假装一手');
  expect(legacy.context_text).toContain('暂无 research 任务简报');
  store.events.save({ ...store.events.get(e.id)!, expected_at: now - 10 * H });
  const expired = await scan();
  expect(expired.trigger.hits).toEqual([]);
  expect(expired.strategy_refs).toEqual([]);
  store.events.save({ ...store.events.get(e.id)!, expected_at: now - 1000 });
  store.events.dismiss(e.id, now);
  const dismissed = await scan();
  expect(dismissed.trigger.hits).toEqual([]);
  expect(dismissed.strategy_refs).toEqual([]);
});


it('scanAll freezes each symbol’s trigger hits without mutating the shared caller object', async () => {
  await setup();
  const rt = activeRt!;
  rt.setWorkflow({ watchlist: ['BTCUSDT', 'ETHUSDT'] });
  const btc: TriggerHit = { kind: 'breakout', detail: 'BTC 独立来源', score: 0.6 };
  const eth: TriggerHit = { kind: 'ema_cross', detail: 'ETH 独立来源', score: 0.5 };
  const cache = (rt as unknown as { lastTriggerHits: Map<string, TriggerHit[]> }).lastTriggerHits;
  cache.set('BTCUSDT', [btc]);
  cache.set('ETHUSDT', [eth]);
  const trigger = { kind: 'manual' as const, detail: '批量扫描' };
  expect(rt.scanAll(trigger)).toBe(2);
  // 队列运行后再有缓存变化，也不能改写已经排队的 ETH 事实。
  cache.set('ETHUSDT', [btc]);
  await vi.waitFor(() => expect(rt.queueView()).toMatchObject({ pending: 0, running: null }), { timeout: 10000 });
  const eps = store.episodes(10).map(row => store.episode(row.id)!);
  expect(eps.find(ep => ep.symbol === 'BTCUSDT')?.trigger.hits).toEqual([btc]);
  expect(eps.find(ep => ep.symbol === 'ETHUSDT')?.trigger.hits).toEqual([eth]);
  expect(trigger).toEqual({ kind: 'manual', detail: '批量扫描' });
});
// 09-12 P1-14:blackout 以前只在模型刚返回后的 scan 里评一次。审批等待/重新取数/发送前那一段没有它 ——
// 事件前 61 分钟通过、等人批 2 分钟后就跨进封锁区,照样提交。
describe('P1-14 事件封锁在发送前复查一次', () => {
  it('审批等待期间事件走进封锁区 → 发送前重闸拒绝,经济字段一个字没改', async () => {
    await setup();
    const rt = activeRt!;
    rt.setWorkflow({ event_blackout_min: 60 });
    const acct = await rt['backend'].account();
    const at = Date.now() + 61 * 60_000;
    // 还差 61 分钟:此刻放行
    store.events.save(makeEvent({ kind: 'calendar', subkind: 'fomc', title: 'FOMC', assets: [], expected_at: at, captured_at: Date.now(), source: 'calendar', dedupe_key: 'p114-fomc' }));
    expect(rt['preflightOpen']('BTCUSDT', acct).join(';')).not.toMatch(/事件/);
    // 人批了 2 分钟之后(等价于事件又近了 2 分钟):同一笔单在发送前被这道只拒不改的闸拦下
    store.events.save(makeEvent({ kind: 'calendar', subkind: 'fomc', title: 'FOMC', assets: [], expected_at: Date.now() + 59 * 60_000, captured_at: Date.now(), source: 'calendar', dedupe_key: 'p114-fomc' }));
    const blockers = rt['preflightOpen']('BTCUSDT', acct);
    expect(blockers.join(';')).toMatch(/不开新仓/);
    // 只拦开仓:别的币不受这条宏观之外的影响,关掉闸就放行
    rt.setWorkflow({ event_blackout_min: 0 });
    expect(rt['preflightOpen']('BTCUSDT', acct).join(';')).not.toMatch(/不开新仓/);
  });

  it('真的走 executeOpen:封锁区里一张单都发不出去', async () => {
    await setup();
    const rt = activeRt!;
    rt.setWorkflow({ event_blackout_min: 60 });
    store.events.save(makeEvent({ kind: 'calendar', subkind: 'fomc', title: 'FOMC', assets: [], expected_at: Date.now() + 30 * 60_000, captured_at: Date.now(), source: 'calendar', dedupe_key: 'p114-send' }));
    const t = newThread({ id: 'p114-thread', backend: 'paper', symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '15m', thesis: 'x', invalidation_text: null, watch_conditions: [], entry: { type: 'market', price: null, zone: null }, stop_price: '70', take_profits: [], qty: '1', margin_usdt: '100', leverage: 1, margin_mode: 'cross', now: Date.now() });
    store.saveThread(t);
    const intent = { id: 'p114-intent', episode_id: '', thread_id: t.id, principal: 'agent' as const, at: Date.now(), kind: 'open' as const, symbol: 'BTCUSDT', direction: 'long' as const, quantity: '1', entry: 'market' as const, limit_price: null, stop_price: '70', take_profit_price: null, sizing: { equity: '10000', risk_pct: '0', risk_usdt: '0', stop_distance: '30', raw_qty: '1', step_size: '0.01', note: 'fixture' }, status: 'approved' as const, client_order_id: null, backend: 'paper' as const, receipts: [], error: null };
    store.saveIntent(intent);
    const place = vi.spyOn(rt['backend'], 'placeEntry');
    await rt['executeOpen'](t, store.intent(intent.id), null);
    expect(place).not.toHaveBeenCalled();
    expect(store.thread(t.id)!.status).toBe('canceled');
    expect(store.thread(t.id)!.close_reason).toMatch(/不开新仓/);
    expect(store.intent(intent.id)!.status).toBe('rejected');
    vi.restoreAllMocks();
  });
});
