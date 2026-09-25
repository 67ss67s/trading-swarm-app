/**
 * 事件区路由(契约 docs/demo/v3-ui-contract.md §9.30)。在 http-extra.ts 里一行注册。
 *
 * **路径是 `/api/market-events` 不是 `/api/events`**:`GET /api/events` 早就被 SSE 事件流占了(http.ts 末尾),
 * 那是浏览器订阅 loop.state/episode.* 的长连接。事件区用表名同款的 `market-events`,别改回去。
 *
 * 写操作只有两个,都不碰钱:`POST /api/market-events`(手动补录一条事件)和 `POST /api/market-events/:id/dismiss`
 * (人工判定「这不算事件」)。没有任何一条路由能下单、改风控、改仓位——事件区对执行链是只读的。
 */
import type { RouteContext, RouteModule } from './http-extra.js';
import { calendarMeta, eventStartAt, eventEndAt, isWithinWindow, makeEvent, windowMsFor, type EventConfidence, type EventKind, type EventStatus, type MarketEvent } from './events.js';
import { CLASSIFY_RULES } from './events.js';
import { RESEARCH_DAILY_CAP } from './research.js';
import { createHash } from 'node:crypto';

const KINDS: EventKind[] = ['scheduled', 'news', 'exchange', 'onchain', 'derived'];
const STATUSES: EventStatus[] = ['captured', 'briefed', 'live', 'resolved', 'retro_done', 'dismissed'];
const CONFIDENCES: EventConfidence[] = ['confirmed', 'reported', 'rumor'];

/** 列表里每条事件带上前端要用的派生字段,免得前端自己算窗口。 */
function view(e: MarketEvent, now: number): Record<string, unknown> {
  const starts_at = eventStartAt(e);
  return {
    ...e,
    starts_at,
    ends_at: eventEndAt(e),
    in_window: isWithinWindow(e, now),
    minutes_to_start: Math.round((starts_at - now) / 60_000),
  };
}

export const eventRoutes: RouteModule = (ctx: RouteContext) => {
  const { route, guarded, json, fail, readBody, rt, store } = ctx;

  route('POST', '/api/research', guarded(async (req, res) => {
    const body = await readBody(req);
    const kind = body['kind'] ?? 'topic';
    if (!['topic', 'event_prep', 'event_release'].includes(String(kind))) return fail(res, 400, 'kind 必须是 topic/event_prep/event_release', 'bad_kind');
    const eventId = body['event_id'];
    if (eventId !== undefined && typeof eventId !== 'string') return fail(res, 400, 'event_id 必须是字符串', 'bad_event');
    const event = typeof eventId === 'string' ? store.events.get(eventId) : null;
    if (eventId !== undefined && !event) return fail(res, 404, '事件不存在', 'not_found');
    if (kind !== 'topic' && (!event || event.kind !== 'scheduled' || event.expected_at === null)) return fail(res, 400, '事件研究需要 scheduled event_id', 'bad_event');
    if (event?.status === 'dismissed') return fail(res, 409, '事件已忽略', 'event_dismissed');
    const topic = typeof body['topic'] === 'string' ? body['topic'].trim() : event?.title ?? '';
    if (!topic || topic.length > 1000) return fail(res, 400, 'topic 长度须为 1–1000', 'bad_topic');
    const now = Date.now();
    const due = body['due_at'] ?? now;
    if (typeof due !== 'number' || !Number.isSafeInteger(due) || due < 0 || due > now + 365 * 86400000) return fail(res, 400, 'due_at 必须是未来一年内的 unix 毫秒整数', 'bad_due_at');
    const due_at = kind === 'event_release' && event ? Math.max(due, event.expected_at! + 120000) : due;
    const task = store.events.research.create({ kind: kind as 'topic'|'event_prep'|'event_release', topic, ...(event ? { event_id: event.id } : {}), assigned_by: 'user', due_at }, now);
    ctx.emit('research_task', task);
    json(res, 201, { task });
  }));
  route('GET', '/api/research', guarded(async (_req, res, url) => {
    const limit = Number(url.searchParams.get('limit') ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return fail(res, 400, 'limit 须为1–500整数', 'bad_limit');
    json(res, 200, { tasks: store.events.research.list(limit), usage: store.events.research.usage(), daily_cap: rt.workflow.research_daily_cap ?? RESEARCH_DAILY_CAP });
  }));
  route('GET', '/api/research/:id', guarded(async (_req, res, _url, p) => {
    const task = store.events.research.get(p['id']!);
    if (!task) return fail(res, 404, '研究任务不存在', 'not_found');
    json(res, 200, { task, excerpts: store.events.research.excerpts(task.id) });
  }));
  route('POST', '/api/research/:id/cancel', guarded(async (_req, res, _url, p) => {
    const task = store.events.research.cancel(p['id']!);
    if (!task) return fail(res, 404, '研究任务不存在', 'not_found');
    ctx.emit('research_task', task);
    json(res, 200, { task });
  }));

  route('GET', '/api/market-events', guarded(async (_req, res, url) => {
    const now = Date.now();
    const status = url.searchParams.get('status');
    if (status && !STATUSES.includes(status as EventStatus)) return fail(res, 400, `status 只能是 ${STATUSES.join('/')}`, 'bad_status');
    const since = url.searchParams.get('since');
    if (since !== null && !Number.isFinite(Number(since))) return fail(res, 400, 'since 必须是 unix 毫秒', 'bad_since');
    const asset = url.searchParams.get('asset');
    const subkind = url.searchParams.get('subkind');
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100));
    const events = store.events.list({
      ...(status ? { status: status as EventStatus } : {}),
      ...(asset ? { asset } : {}),
      ...(subkind ? { subkind } : {}),
      ...(since !== null ? { since: Number(since) } : {}),
      limit,
    });
    const tasks = store.events.research.list(500);
    // 列表里出现过的 subkind 的历史聚合,一次给全,前端不用逐条再问。
    const stats: Record<string, unknown> = {};
    for (const e of events) stats[e.subkind] ??= store.events.stats(e.subkind);
    json(res, 200, {
      as_of: now,
      events: events.map((e) => ({ ...view(e, now), research_status: tasks.find(t => t.event_id === e.id)?.status ?? null })),
      stats,
      calendar: { ...calendarMeta(), last_verified_at: Number(store.kvGet('events.calendar_refresh') ?? 0) || null, warnings: JSON.parse(store.kvGet('events.calendar_warnings') ?? '[]'), entries: events.filter(e => e.kind === 'scheduled').length },
      event_blackout_min: rt.workflow.event_blackout_min ?? 0,
      brief_usage_today: rt.eventBriefUsageToday(now),
      subkinds: [...new Set([...CLASSIFY_RULES.map((r) => r.subkind), 'funding_extreme', 'vol_spike', 'unclassified'])],
    });
  }));

  route('GET', '/api/market-events/:id', guarded(async (_req, res, _url, p) => {
    const e = store.events.get(p['id']!);
    if (!e) return fail(res, 404, `没有事件 ${p['id']}`, 'not_found');
    const now = Date.now();
    json(res, 200, { as_of: now, event: view(e, now), stats: store.events.stats(e.subkind) });
  }));

  /**
   * 手动补录。刻意**不**跑关键词分类器:人既然手填了,就以人填的 subkind 为准(留空才 unclassified)。
   * 补录的事件 `source: 'manual'`,`confidence` 默认 confirmed(人看过了)。
   */
  route('POST', '/api/market-events', guarded(async (req, res) => {
    const body = await readBody(req);
    const title = typeof body['title'] === 'string' ? body['title'].trim() : '';
    if (!title) return fail(res, 400, 'title 必填', 'bad_title');
    const kind = body['kind'];
    if (kind !== undefined && !KINDS.includes(kind as EventKind)) return fail(res, 400, `kind 只能是 ${KINDS.join('/')}`, 'bad_kind');
    const confidence = body['confidence'];
    if (confidence !== undefined && !CONFIDENCES.includes(confidence as EventConfidence)) return fail(res, 400, `confidence 只能是 ${CONFIDENCES.join('/')}`, 'bad_confidence');
    const expectedRaw = body['expected_at'];
    let expected_at: number | null = null;
    if (expectedRaw !== undefined && expectedRaw !== null && expectedRaw !== '') {
      const n = Number(expectedRaw);
      if (!Number.isFinite(n)) return fail(res, 400, 'expected_at 必须是 unix 毫秒或 null', 'bad_expected_at');
      expected_at = Math.round(n);
    }
    const subkind = typeof body['subkind'] === 'string' && body['subkind'].trim() ? body['subkind'].trim().toLowerCase() : 'unclassified';
    const assets = Array.isArray(body['assets']) ? (body['assets'] as unknown[]).filter((x): x is string => typeof x === 'string').map((a) => a.toUpperCase().replace(/USDT$/, '')) : [];
    const windowRaw = Number(body['window_ms']);
    const window_ms = Number.isFinite(windowRaw) && windowRaw > 0 ? Math.round(windowRaw) : windowMsFor(subkind);
    const now = Date.now();
    const resolvedKind: EventKind = (kind as EventKind | undefined) ?? (expected_at === null ? 'news' : 'scheduled');
    const ev = makeEvent({
      kind: resolvedKind,
      subkind,
      title,
      assets,
      expected_at,
      window_ms,
      captured_at: now,
      source: 'manual',
      source_ref: typeof body['source_ref'] === 'string' ? body['source_ref'] : '',
      confidence: (confidence as EventConfidence | undefined) ?? 'confirmed',
      // 手动补录允许同一件事补两次(标题不同就是两条);带上时间戳防止误判成重复。
      dedupe_key: `manual:${createHash('sha256').update(`${title}|${expected_at ?? now}`).digest('hex').slice(0, 32)}`,
    });
    const r = store.events.capture(ev);
    ctx.emit('market_event', r.event);
    json(res, r.created ? 201 : 200, { created: r.created, event: view(r.event, now) });
  }));

  route('POST', '/api/market-events/:id/dismiss', guarded(async (_req, res, _url, p) => {
    const e = store.events.dismiss(p['id']!);
    if (!e) return fail(res, 404, `没有事件 ${p['id']}`, 'not_found');
    for (const task of store.events.research.list(500).filter(t => t.event_id === e.id && ['planned','running'].includes(t.status))) {
      const cancelled = store.events.research.cancel(task.id);
      if (cancelled) ctx.emit('research_task', cancelled);
    }
    ctx.emit('market_event', e);
    json(res, 200, { event: view(e, Date.now()) });
  }));
};
