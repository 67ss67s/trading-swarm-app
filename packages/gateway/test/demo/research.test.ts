import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { EventStore, makeEvent, eventResearchSignalInput, type MarketEvent } from '../../src/demo/events.js';
import type { Brain } from '../../src/demo/brain.js';
import { allowedResearchUrl, ResearchStore, releaseActual, researchSources, runResearch, scheduleResearch, surprise, type ResearchTask } from '../../src/demo/research.js';

const now = Date.parse('2026-09-15T12:32:00Z');
let state: StateDb;
let events: EventStore;
let store: ResearchStore;
beforeEach(() => { state = openStateDb(':memory:'); events = new EventStore(state.db); store = events.research; });
afterEach(() => state.close());
function event(patch: Partial<MarketEvent> = {}): MarketEvent {
  return { ...makeEvent({ kind: 'scheduled', subkind: 'cpi', title: 'CPI y/y', expected_at: now - 120000, window_ms: 4 * 3600000, captured_at: now - 86400000, source: 'calendar', dedupe_key: 'research-cpi' }), consensus: '2.0%', ...patch };
}
function task(kind: ResearchTask['kind'] = 'topic', ev?: MarketEvent): ResearchTask {
  if (ev) events.save(ev);
  return store.create({ kind, ...(ev ? { event_id: ev.id } : {}), topic: ev?.title ?? '美国宏观研究', assigned_by: 'user', due_at: now }, now);
}
function brain(sourceCount = 1): Brain {
  return { name: 'stub', complete: vi.fn(async (_system, user) => {
    const p = JSON.parse(user);
    const output = p.catalog ? { sources: p.catalog.slice(0, sourceCount).map((url: string) => ({ url, why: '官方数据' })), questions: ['发生了什么？'] }
      : { findings: [{ claim: '已阅读来源中的事实', refs: [p.excerpts[0].id] }] };
    return { text: JSON.stringify(output), latency_ms: 1, model: 'stub', input_tokens: 10, output_tokens: 5 };
  }) };
}
function bls(seriesID = 'CUUR0000SA0', rows = [{ year: '2026', period: 'M08', value: '306' }, { year: '2025', period: 'M08', value: '300' }]): string {
  return JSON.stringify({ status: 'REQUEST_SUCCEEDED', Results: { series: [{ seriesID, data: rows }] } });
}

describe('research store, policy and scheduling', () => {
  it('persists tasks, excerpts, cancellation and duplicate automatic keys', () => {
    const input = { kind: 'topic' as const, topic: 't', assigned_by: 'agent' as const, due_at: now + 100 };
    const a = store.create(input, now, 'once');
    expect(store.create(input, now + 1, 'once').id).toBe(a.id);
    const fresh = new ResearchStore(state.db);
    expect(fresh.get(a.id)).toEqual(a);
    expect(fresh.due(now)).toEqual([]);
    expect(fresh.due(now + 100)).toHaveLength(1);
    const ref = fresh.excerpt(a.id, 'https://www.bls.gov/', 'source text', now);
    expect(fresh.excerpts(a.id)).toEqual([{ id: ref, url: 'https://www.bls.gov/', body: 'source text', at: now }]);
    expect(fresh.cancel(a.id, now + 200)?.status).toBe('cancelled');
    expect(fresh.due(now + 300)).toEqual([]);
    expect(fresh.cancel('missing')).toBeNull();
  });
  it('restricts exact/suffix domains, HTTPS, credentials, ports and Binance announcement paths', () => {
    for (const url of ['https://www.bls.gov/a', 'https://api.bls.gov/publicAPI/v2/timeseries/data/CUUR0000SA0', 'https://www.binance.com/en/support/announcement/test']) expect(allowedResearchUrl(url), url).toBe(true);
    for (const url of ['https://bls.gov.evil.test/', 'https://fakebls.gov/', 'https://bls.gov@evil.test/', 'https://u:p@bls.gov/', 'http://bls.gov/', 'https://bls.gov:8443/', 'https://127.0.0.1/', 'file:///etc/passwd', 'https://api.binance.com/api/v3/order', 'https://www.binance.com/en/support/announcement/../../trade', 'https://www.binance.com/en/support/announcement-evil']) expect(allowedResearchUrl(url), url).toBe(false);
  });
  it('creates T-24h prep and T+2m release once and omits dismissed/stale events', () => {
    const ev = event({ expected_at: now + 86400000 });
    expect(scheduleResearch(store, [ev], now - 1)).toEqual([]);
    const [prep] = scheduleResearch(store, [ev], now);
    expect(prep).toMatchObject({ kind: 'event_prep', due_at: now, assigned_by: 'agent' });
    expect(scheduleResearch(store, [ev], now + 1)[0]?.id).toBe(prep!.id);
    expect(scheduleResearch(store, [ev], ev.expected_at! + 119999)).toEqual([]);
    expect(scheduleResearch(store, [ev], ev.expected_at! + 120000)[0]?.kind).toBe('event_release');
    expect(store.list()).toHaveLength(2);
    expect(scheduleResearch(store, [event({ status: 'dismissed' }), event({ expected_at: now - 2 * 86400000 })], now)).toEqual([]);
  });
  it('reserves persistent daily caps and resets at UTC midnight', () => {
    const cap = { model_calls: 1, fetches: 2 };
    expect(store.reserve('model_calls', cap, now)).toBe(true);
    expect(new ResearchStore(state.db).reserve('model_calls', cap, now)).toBe(false);
    expect(store.reserve('fetches', cap, now)).toBe(true);
    expect(store.usage(now)).toEqual({ model_calls: 1, fetches: 1 });
    expect(store.usage(now + 86400000)).toEqual({ model_calls: 0, fetches: 0 });
  });
});

describe('official release extraction', () => {
  it('requires current release month and success status, ignoring stale/annual rows', () => {
    expect(() => releaseActual(event(), bls('CUUR0000SA0', [{ year: '2026', period: 'M07', value: '305' }, { year: '2026', period: 'M13', value: '300' }]))).toThrow('release_not_available');
    expect(() => releaseActual(event(), '{"status":"REQUEST_FAILED"}')).toThrow('not successful');
  });
  it('computes comparable CPI yearly surprise but refuses NSA index versus monthly forecast', () => {
    expect(releaseActual(event(), bls())).toEqual({ actual: '2.0', surprise: '0', metric: 'yoy_pct' });
    expect(() => releaseActual(event({ title: 'CPI m/m', consensus: '0.2%' }), bls())).toThrow('release_not_available');
    expect(releaseActual(event({ title: 'CPI', consensus: '0.2%' }), bls())).toEqual({ actual: '306', surprise: null, metric: 'index_level' });
    expect(releaseActual(event({ title: 'CPI m/m', consensus: '0.2%' }), bls('CUSR0000SA0', [{ year: '2026', period: 'M08', value: '300.9' }, { year: '2026', period: 'M07', value: '300' }]))).toEqual({ actual: '0.3', surprise: '0.1', metric: 'mom_pct_sa' });
    expect(surprise('2.3', '2.0%')).toBe('0.3');
    expect(surprise('2', 'unavailable')).toBeNull();
  });
  it('computes nonfarm changes in thousands and handles January release year boundary', () => {
    const ev = event({ subkind: 'nfp', expected_at: Date.parse('2027-01-08T13:30:00Z'), consensus: '150K' });
    expect(releaseActual(ev, bls('CES0000000001', [{ year: '2026', period: 'M12', value: '159200' }, { year: '2026', period: 'M11', value: '159030' }]))).toEqual({ actual: '170', surprise: '20', metric: 'payroll_change_thousands' });
    expect(researchSources({ kind: 'event_release' }, ev)[0]).toContain('CES0000000001');
  });
  it('parses Fed fractional target upper bound and computes consensus delta', () => {
    expect(releaseActual(event({ subkind: 'fomc', consensus: '4.50%' }), '<p>maintain the target range for the federal funds rate at 4 to 4 1/4 percent</p>')).toEqual({ actual: '4.25', surprise: '-0.25', metric: 'target_upper_pct' });
  });
});

describe('harness limits and resumability', () => {
  it('completes plan/fetch/extract/verify/brief with registered refs and event writeback', async () => {
    const ev = event(); const t = task('event_release', ev); const b = brain();
    const result = await runResearch(t.id, { store, events, brain: b, now: () => now, fetchText: async () => bls() });
    expect(result).toMatchObject({ status: 'done', phase: 'brief', cost: { model_calls: 2, fetches: 1, input_tokens: 20, output_tokens: 10 } });
    expect(result.findings[0]).toMatchObject({ confidence: 'confirmed', value: '2.0' });
    expect(events.get(ev.id)).toMatchObject({ actual: '2.0', surprise: '0', research_status: 'done', brief_count: 1, brief: { source: 'research', task_id: t.id } });
    expect(store.excerpts(t.id)).toHaveLength(1);
    await runResearch(t.id, { store, events, brain: b });
    expect(b.complete).toHaveBeenCalledTimes(2);
  });
  it('concurrent calls for one task share one execution and one budget reservation', async () => {
    const t = task(); const b = brain(); const fetchText = vi.fn(async () => 'fact');
    const deps = { store, events, brain: b, fetchText, now: () => now };
    const results = await Promise.all([runResearch(t.id, deps), runResearch(t.id, deps)]);
    expect(results.map(r => r.status)).toEqual(['done', 'done']);
    expect(b.complete).toHaveBeenCalledTimes(2);
    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(store.usage(now)).toEqual({ model_calls: 2, fetches: 1 });
  });
  it('official actual survives an extraction-model failure', async () => {
    const ev = event(); const t = task('event_release', ev); const b = brain();
    const original = b.complete;
    b.complete = async (...args) => { if (args[0].includes('提炼员')) throw new Error('model offline'); return original(...args); };
    const result = await runResearch(t.id, { store, events, brain: b, now: () => now, fetchText: async () => bls() });
    expect(result.status).toBe('planned');
    const actualEvent = events.get(ev.id)!;
    expect(actualEvent).toMatchObject({ actual: '2.0', surprise: '0' });
    expect(actualEvent.actual_refs).toHaveLength(1);
    expect(eventResearchSignalInput(actualEvent).refs).toEqual(actualEvent.actual_refs);
    const retried = await runResearch(t.id, { store, events, brain: b, now: () => now + 60000, fetchText: async () => bls() });
    expect(retried.status).toBe('done');
    expect(retried.brief).toContain('代码摘录；模型提炼失败');
    expect(retried.cost.model_calls).toBe(2);
  });
  it('release harness fetches mandatory seasonal series even if planner selects only NSA', async () => {
    const ev = event({ title: 'CPI m/m', consensus: '0.2%' });
    const t = task('event_release', ev);
    const result = await runResearch(t.id, { store, events, brain: brain(), now: () => now,
      fetchText: async (url) => url.includes('CUSR') ? bls('CUSR0000SA0', [{ year: '2026', period: 'M08', value: '300.9' }, { year: '2026', period: 'M07', value: '300' }]) : bls() });
    expect(result.status).toBe('done');
    expect(events.get(ev.id)).toMatchObject({ actual: '0.3', surprise: '0.1', actual_metric: 'mom_pct_sa' });
  });
  it('planner cannot introduce its own URL even on an allowed domain', async () => {
    const b: Brain = { name: 'stub', async complete() { return { text: '{"sources":[{"url":"https://bls.gov/model-invented","why":"x"}],"questions":[]}', latency_ms: 0, model: 'stub', input_tokens: 1, output_tokens: 1 }; } };
    const fetchText = vi.fn(async (_url: string) => 'never');
    const t = task();
    const deps = { store, events, brain: b, fetchText, now: () => now };
    expect((await runResearch(t.id, deps)).status).toBe('planned');
    expect(fetchText).not.toHaveBeenCalled();
    expect((await runResearch(t.id, deps))).toMatchObject({ status: 'failed', cost: { model_calls: 2, fetches: 3 } });
    expect(fetchText.mock.calls.every(([url]) => !String(url).includes('model-invented'))).toBe(true);
  });
  it('pauses at a depleted fetch budget and resumes next day without re-planning', async () => {
    const t = task(); const b = brain(); const deps = { store, events, brain: b, fetchText: async () => 'public fact', cap: { model_calls: 20, fetches: 1 } };
    store.reserve('fetches', deps.cap, now);
    const pending = await runResearch(t.id, { ...deps, now: () => now });
    expect(pending).toMatchObject({ status: 'planned', attempts: 0, error: 'daily_budget: 排队到次日UTC', cost: { model_calls: 1, fetches: 0 } });
    const result = await runResearch(t.id, { ...deps, now: () => now + 86400000 });
    expect(result.status).toBe('done');
    expect(result.cost.model_calls).toBe(2);
    expect(store.usage(now + 86400000)).toEqual({ model_calls: 1, fetches: 1 });
  });
  it('retries a total transport failure once, capped at six fetches and two model calls', async () => {
    const t = task(); const b = brain(3); const fetchText = vi.fn(async () => { throw new Error('offline'); });
    const deps = { store, events, brain: b, fetchText, now: () => now };
    expect((await runResearch(t.id, deps)).status).toBe('planned');
    const result = await runResearch(t.id, deps);
    expect(result).toMatchObject({ status: 'failed', attempts: 2, cost: { fetches: 6, model_calls: 1 } });
    await runResearch(t.id, deps);
    expect(fetchText).toHaveBeenCalledTimes(6);
  });
  it('rejects oversized successful bodies and unregistered extraction refs', async () => {
    const a = task();
    const oversized = await runResearch(a.id, { store, events, brain: brain(), now: () => now, fetchText: async () => 'x'.repeat(200 * 1024 + 1) });
    expect(oversized.fetches[0]).toMatchObject({ ok: false, error: 'body exceeds 200KB' });
    expect(store.excerpts(a.id)).toEqual([]);
    const b = brain(); const original = b.complete;
    b.complete = async (...args) => args[0].includes('提炼员') ? { text: '{"findings":[{"claim":"fake","refs":["invented"]}]}', input_tokens: 1, output_tokens: 1, latency_ms: 0, model: 'stub' } : original(...args);
    const result = await runResearch(task().id, { store, events, brain: b, now: () => now, fetchText: async () => 'fact' });
    expect(result).toMatchObject({ status: 'planned', error: 'no verifiable references' });
  });
  it('re-fetches stale BLS on the one retry so new actuals can arrive', async () => {
    const ev = event(); const t = task('event_release', ev); const b = brain();
    const fetchText = vi.fn().mockResolvedValueOnce(bls('CUUR0000SA0', [{ year: '2026', period: 'M07', value: '305' }])).mockResolvedValueOnce(bls());
    const deps = { store, events, brain: b, fetchText, now: () => now };
    expect((await runResearch(t.id, deps)).status).toBe('planned');
    expect((await runResearch(t.id, deps)).status).toBe('done');
    expect(fetchText).toHaveBeenCalledTimes(2);
  });
  it('cancellation while awaiting model does not save its returned plan or begin fetch', async () => {
    const t = task();
    let resolve!: (value: Awaited<ReturnType<Brain['complete']>>) => void;
    const waiting = new Promise<Awaited<ReturnType<Brain['complete']>>>(r => { resolve = r; });
    const b: Brain = { name: 'stub', complete: async () => waiting };
    const fetchText = vi.fn(async (_url: string) => 'never');
    const pending = runResearch(t.id, { store, events, brain: b, fetchText, now: () => now });
    store.cancel(t.id, now + 1);
    resolve({ text: JSON.stringify({ sources: [{ url: researchSources(t)[0], why: 'x' }], questions: [] }), latency_ms: 0, model: 'stub', input_tokens: 1, output_tokens: 1 });
    expect(await pending).toMatchObject({ status: 'cancelled', plan: null });
    expect(fetchText).not.toHaveBeenCalled();
  });
  it('cancellation while awaiting fetch leaves task cancelled and writes no excerpt/brief/event', async () => {
    const ev = event(); const t = task('event_release', ev);
    let release!: (s: string) => void;
    const fetched = new Promise<string>(r => { release = r; });
    let started!: () => void; const ready = new Promise<void>(r => { started = r; });
    const pending = runResearch(t.id, { store, events, brain: brain(), now: () => now, fetchText: () => { started(); return fetched; } });
    await ready;
    store.cancel(t.id, now + 1); release(bls());
    expect((await pending).status).toBe('cancelled');
    expect(store.excerpts(t.id)).toEqual([]);
    expect(events.get(ev.id)?.actual).toBe(ev.actual);
    expect(events.get(ev.id)?.brief).toBeNull();
  });
});


describe('adversarial regressions', () => {
  it('January yearly requests include December two calendar years before release', () => {
    const sources = researchSources({ kind: 'event_release' }, event({ expected_at: Date.parse('2027-01-12T13:30:00Z') }));
    expect(sources[0]).toContain('startyear=2025&endyear=2026');
  });
  it('rechecks postponed release clock before spending any budget', async () => {
    const ev = event(); const t = task('event_release', ev);
    events.save({ ...ev, expected_at: now + 86400000 });
    const b = brain(); const fetchText = vi.fn(async () => bls());
    const result = await runResearch(t.id, { store, events, brain: b, fetchText, now: () => now });
    expect(result).toMatchObject({ status: 'planned', due_at: now + 86400000 + 120000, cost: { model_calls: 0, fetches: 0 } });
    expect(b.complete).not.toHaveBeenCalled(); expect(fetchText).not.toHaveBeenCalled();
  });
  it.each(['pce', 'gdp', 'claims', 'retail'])('unsupported %s release cannot masquerade as done', async subkind => {
    const t = task('event_release', event({ subkind })); const b = brain();
    const deps = { store, events, brain: b, now: () => now, fetchText: vi.fn(async () => 'fact') };
    expect(await runResearch(t.id, deps)).toMatchObject({ status: 'planned', error: expect.stringContaining('unsupported_release_parser') });
    expect(await runResearch(t.id, deps)).toMatchObject({ status: 'failed', cost: { model_calls: 0, fetches: 0 } });
    expect(b.complete).not.toHaveBeenCalled(); expect(deps.fetchText).not.toHaveBeenCalled();
  });
  it('rejected pending model cannot resurrect a cancelled task', async () => {
    const t = task(); let reject!: (e: Error) => void;
    const waiting = new Promise<never>((_resolve, r) => { reject = r; });
    const b: Brain = { name: 'stub', complete: async () => waiting };
    const pending = runResearch(t.id, { store, events, brain: b, now: () => now });
    store.cancel(t.id, now + 1); reject(new Error('provider timeout after cancellation'));
    expect(await pending).toMatchObject({ status: 'cancelled', attempts: 0, finished_at: now + 1 });
    expect(store.due(now + 86400000)).toEqual([]);
  });
  it('failed planning retries with fixed catalog and spends remaining model call on extraction', async () => {
    const t = task(); const b = brain(); const original = b.complete;
    b.complete = vi.fn(async (...args) => { if (JSON.parse(args[1]).catalog) throw new Error('plan provider offline'); return original(...args); });
    const deps = { store, events, brain: b, now: () => now, fetchText: async () => 'official fact' };
    expect((await runResearch(t.id, deps)).status).toBe('planned');
    const result = await runResearch(t.id, deps);
    expect(result.status).toBe('done');
    expect(result.plan?.sources[0]?.why).toContain('固定来源目录');
    expect(result.cost).toMatchObject({ model_calls: 2, fetches: 3 });
    expect(result.cost.fetches).toBeLessThanOrEqual(6);
  });
});


it('Fed hyphenated fractions and HTML fraction entities parse the actual target bound', () => {
  expect(releaseActual(event({ subkind: 'fomc', consensus: '3.75%' }), '<p>target range for the federal funds rate at 3-1/2 to 3-3/4 percent</p>')).toEqual({ actual: '3.75', surprise: '0', metric: 'target_upper_pct' });
  expect(releaseActual(event({ subkind: 'fomc', consensus: '3.75%' }), '<p>target range for the federal funds rate at 3&frac12; to 3&frac34; percent</p>')).toEqual({ actual: '3.75', surprise: '0', metric: 'target_upper_pct' });
});

it('FOMC release resuming from budget wait refreshes the persisted source URL after a date change', async () => {
  const ev = event({ subkind: 'fomc', title: 'FOMC', consensus: '3.75%' }); const t = task('event_release', ev); const b = brain();
  const cap = { model_calls: 20, fetches: 1 };
  store.reserve('fetches', cap, now);
  const fetchText = vi.fn(async (_url: string) => 'target range for the federal funds rate at 3-1/2 to 3-3/4 percent');
  const deps = { store, events, brain: b, cap, fetchText };
  const paused = await runResearch(t.id, { ...deps, now: () => now });
  expect(paused.error).toContain('daily_budget');
  expect(paused.plan?.sources[0]?.url).toContain('20260915');
  events.save({ ...ev, expected_at: ev.expected_at! + 86400000 });
  const resumed = await runResearch(t.id, { ...deps, now: () => now + 86400000 });
  expect(resumed.status).toBe('done');
  expect(resumed.plan?.sources[0]?.url).toContain('20260916');
  expect(fetchText).toHaveBeenCalledTimes(1);
  expect(fetchText.mock.calls[0]![0]).toContain('20260916');
  expect(resumed.cost.model_calls).toBe(2);
});

it('automatic release postponed then brought forward updates the same due task and can run', async () => {
  const ev = event(); events.save(ev);
  const initial = scheduleResearch(store, [ev], now).find(t => t.kind === 'event_release')!;
  const delayed = { ...ev, expected_at: now + 86400000 }; events.save(delayed);
  const deps = { store, events, brain: brain(), fetchText: async () => bls() };
  const postponed = await runResearch(initial.id, { ...deps, now: () => now });
  expect(postponed.due_at).toBe(now + 86400000 + 120000);
  events.save(ev);
  const [moved] = scheduleResearch(store, [ev], now + 3600000);
  expect(moved!.id).toBe(initial.id);
  expect(store.due(now + 3600000).map(t => t.id)).toContain(initial.id);
  expect((await runResearch(initial.id, { ...deps, now: () => now + 3600000 })).status).toBe('done');
});
