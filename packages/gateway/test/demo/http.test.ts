// http.ts: createServer(rt, store) — the HTTP + SSE control surface. Exercised end-to-end on an
// ephemeral port against a real DemoRuntime (in-memory sqlite, PaperBackend, stub brain, fake
// market server). TG_DEMO_MARKET_BASE is set BEFORE dynamic-importing runtime.js/http.js since
// market.ts reads it as a module-level const.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { stubBrain } from '../../src/demo/brain.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';
import { MemoryWriteDeniedError } from '../../src/demo/memory.js';
import { newThread } from '../../src/demo/threads.js';

let fakeMarket: FakeMarketServer;
let DemoRuntime: typeof import('../../src/demo/runtime.js').DemoRuntime;
let createServer: typeof import('../../src/demo/http.js').createServer;

beforeAll(async () => {
  fakeMarket = await startFakeMarketServer();
  process.env['TG_DEMO_MARKET_BASE'] = fakeMarket.url;
  ({ DemoRuntime } = await import('../../src/demo/runtime.js'));
  ({ createServer } = await import('../../src/demo/http.js'));
});

afterAll(async () => {
  await fakeMarket.close();
  delete process.env['TG_DEMO_MARKET_BASE'];
});

type RT = InstanceType<typeof DemoRuntime>;

let activeHttp: http.Server | null = null;
let activeRt: RT | null = null;
let activeState: StateDb | null = null;
let baseUrl = '';

async function setup(): Promise<{ rt: RT; store: DemoStore }> {
  const state = openStateDb(':memory:');
  const store = new DemoStore(state);
  const backend = new PaperBackend(10_000);
  const rt = new DemoRuntime({ store, backend, brains: { stub: stubBrain() }, marketPollMs: 600_000, accountPollMs: 600_000 });
  await rt.start();
  rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'] });
  const httpServer = createServer(rt, store);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;
  activeHttp = httpServer;
  activeRt = rt;
  activeState = state;
  baseUrl = `http://127.0.0.1:${port}`;
  return { rt, store };
}

afterEach(async () => {
  if (activeHttp) {
    activeHttp.closeAllConnections?.();
    await new Promise<void>((r) => activeHttp!.close(() => r()));
  }
  if (activeRt) await activeRt.stop();
  if (activeState) activeState.close();
  activeHttp = null;
  activeRt = null;
  activeState = null;
  baseUrl = '';
});

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: res.status, json };
}

describe('GET /api/overview', () => {
  it('returns workflow, threads, queue, and markets', async () => {
    await setup();
    const { status, json } = await api('GET', '/api/overview');
    expect(status).toBe(200);
    expect(json).toHaveProperty('workflow');
    expect(json.workflow.watchlist).toEqual(['BTCUSDT']);
    expect(json).toHaveProperty('threads');
    expect(Array.isArray(json.threads)).toBe(true);
    expect(json).toHaveProperty('queue');
    expect(json.queue).toMatchObject({ pending: 0, running: null });
    expect(json).toHaveProperty('markets');
    expect(json.markets).toHaveProperty('BTCUSDT');
  });
});

describe('POST /api/workflow', () => {
  it('a bad value is refused: 200 with {workflow, errors} so the UI can show the field error', async () => {
    await setup();
    const { status, json } = await api('POST', '/api/workflow', { leverage: 'not a number' });
    expect(status).toBe(200);
    expect(Array.isArray(json.errors)).toBe(true);
    expect(json.errors.some((e: string) => e.includes('leverage'))).toBe(true);
    expect(json.workflow.leverage).not.toBe('not a number');
  });

  it('a good value is applied and returned inside {workflow, errors: []}', async () => {
    await setup();
    const { status, json } = await api('POST', '/api/workflow', { leverage: 5 });
    expect(status).toBe(200);
    expect(json.errors).toEqual([]);
    expect(json.workflow.leverage).toBe(5);
  });
});

describe('GET/POST /api/threads/:id', () => {
  it('GET an unknown thread id 404s', async () => {
    await setup();
    const { status, json } = await api('GET', '/api/threads/thr-nonexistent');
    expect(status).toBe(404);
    expect(json.error.code).toBe('not_found');
  });

  it('POST .../close on an unknown thread id 404s', async () => {
    await setup();
    const { status, json } = await api('POST', '/api/threads/thr-nonexistent/close');
    expect(status).toBe(404);
    expect(json.error).toBeDefined();
  });
});

describe('POST /api/orders', () => {
  it('missing required fields returns 400', async () => {
    await setup();
    const { status, json } = await api('POST', '/api/orders', { symbol: 'BTCUSDT' });
    expect(status).toBe(400);
    expect(json.error.message).toMatch(/必填/);
  });

  it('an invalid side/action/type is also rejected with 400', async () => {
    await setup();
    const { status } = await api('POST', '/api/orders', { symbol: 'BTCUSDT', side: 'sideways', action: 'open', type: 'market' });
    expect(status).toBe(400);
  });
});

describe('POST /api/chat/messages', () => {
  it('empty text returns 400', async () => {
    await setup();
    const { status, json } = await api('POST', '/api/chat/messages', { text: '' });
    expect(status).toBe(400);
    expect(json.error.message).toMatch(/必填/);
  });

  it('non-empty text is accepted with 202', async () => {
    await setup();
    const { status, json } = await api('POST', '/api/chat/messages', { text: '你好' });
    expect(status).toBe(202);
    expect(json).toHaveProperty('queued');
  });
});

describe('POST /api/halt', () => {
  it('without confirm=HALT returns 400', async () => {
    await setup();
    const { status, json } = await api('POST', '/api/halt', {});
    expect(status).toBe(400);
    expect(json.error.code).toBe('confirm_required');
  });

  it('with confirm=HALT actually halts', async () => {
    const { rt } = await setup();
    const { status } = await api('POST', '/api/halt', { confirm: 'HALT' });
    expect(status).toBe(200);
    expect(rt.isHalted).toBe(true);
  });
});

describe('GET /api/events (SSE)', () => {
  it('sends loop.state then queue.state as the first two frames', async () => {
    await setup();
    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/api/events`, { signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 5000;
    while ((buf.match(/\n\n/g) ?? []).length < 2 && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
    }
    const frames = buf.split('\n\n').filter((f) => f.trim().length > 0);
    expect(frames[0]).toMatch(/^event: loop\.state/);
    expect(frames[1]).toMatch(/^event: queue\.state/);
    ac.abort();
  });
});

// ---------------------------------------------------------------- v3 routes (docs/demo/v3-ui-contract.md)

describe('v3: workflow partial apply', () => {
  it('applies the valid fields of a mixed patch and reports the invalid ones', async () => {
    await setup();
    const { status, json } = await api('POST', '/api/workflow', { leverage: 4, scan_mode: 'weird', narrate: false });
    expect(status).toBe(200);
    expect(json.workflow.leverage).toBe(4);
    expect(json.workflow.narrate).toBe(false);
    expect(json.errors).toEqual(['scan_mode 只能是 triggered/every_close']);
  });
});

describe('v3: history / activity / regime / chat kinds', () => {
  it('GET /api/history returns empty stats on a fresh runtime', async () => {
    await setup();
    const { status, json } = await api('GET', '/api/history');
    expect(status).toBe(200);
    expect(json.stats).toMatchObject({ count: 0, wins: 0, losses: 0, win_rate: 0, total_pnl: '0.00', profit_factor: null, best: null });
    expect(json.threads).toEqual([]);
    expect(Array.isArray(json.equity)).toBe(true);
  });

  it('GET /api/activity lists what the runtime recorded (a workflow change is an activity)', async () => {
    const { rt } = await setup();
    rt.setWorkflow({ leverage: 2 });
    const { json } = await api('GET', '/api/activity?limit=10');
    expect(json.activity[0]).toMatchObject({ kind: 'workflow_changed', level: 'info' });
    expect(json.activity[0].title).toMatch(/leverage/);
  });

  it('GET /api/market/regime returns a code-computed daily regime plus the session', async () => {
    await setup();
    const { status, json } = await api('GET', '/api/market/regime?symbol=BTCUSDT');
    expect(status).toBe(200);
    expect(json.symbol).toBe('BTCUSDT');
    expect(['bull', 'bear', 'range', 'volatile']).toContain(json.daily.regime);
    expect(typeof json.session.text).toBe('string');
  });

  it('GET /api/chat/messages?kind=chat hides narration; kind=narration shows only it', async () => {
    const { rt } = await setup();
    rt.narrate('测试旁白');
    const all = await api('GET', '/api/chat/messages?kind=all');
    expect(all.json.messages.some((m: { kind: string }) => m.kind === 'narration')).toBe(true);
    const chat = await api('GET', '/api/chat/messages?kind=chat');
    expect(chat.json.messages.every((m: { kind: string }) => m.kind === 'chat')).toBe(true);
    const narr = await api('GET', '/api/chat/messages?kind=narration');
    expect(narr.json.messages.length).toBeGreaterThan(0);
    expect(narr.json.messages.every((m: { kind: string }) => m.kind === 'narration')).toBe(true);
  });

  it('GET /api/market/klines honours end_time', async () => {
    await setup();
    const { status, json } = await api('GET', '/api/market/klines?symbol=BTCUSDT&tf=15m&limit=5&end_time=1700000000000');
    expect(status).toBe(200);
    expect(json.klines).toHaveLength(5);
  });
});

describe('brains + graph', () => {
  it('GET /api/brains lists the four kinds with availability and the current selection', async () => {
    await setup();
    const { status, json } = await api('GET', '/api/brains');
    expect(status).toBe(200);
    expect(json.brains.map((b: { kind: string }) => b.kind)).toEqual(['pi', 'claude', 'codex', 'stub']);
    expect(json.brains.find((b: { kind: string }) => b.kind === 'stub').available).toBe(true);
    expect(typeof json.current.brain).toBe('string');
    expect(typeof json.current.cheap_brain).toBe('string');
  });

  it('GET /api/brains reports each CLI 的启动命令与解析结果(直接 / 经 shell / 找不到)', async () => {
    const { rt } = await setup();
    rt.setWorkflow({ cli_commands: { claude: 'claudeproxy' } });
    const { status, json } = await api('GET', '/api/brains?refresh=1');
    expect(status).toBe(200);
    expect(json.cli_commands).toEqual({ claude: 'claudeproxy', codex: 'codex', pi: 'pi' });
    const claude = json.brains.find((b: { kind: string }) => b.kind === 'claude') as { command: string; available: boolean; resolved: { via: string; ok: boolean; detail: string } };
    expect(claude.command).toBe('claudeproxy');
    expect(['direct', 'shell']).toContain(claude.resolved.via);
    expect(typeof claude.resolved.ok).toBe('boolean');
    expect(claude.available).toBe(claude.resolved.ok);
    expect(typeof claude.resolved.detail).toBe('string');
    const stub = json.brains.find((b: { kind: string }) => b.kind === 'stub') as { command: string | null; resolved: { ok: boolean } };
    expect(stub.command).toBeNull();
    expect(stub.resolved.ok).toBe(true);
  });

  it('POST /api/workflow 收 cli_commands 的半截对象,拒绝空/换行', async () => {
    await setup();
    const ok = await api('POST', '/api/workflow', { cli_commands: { pi: 'HTTP_PROXY=http://127.0.0.1:7897 pi' } });
    expect(ok.json.errors).toEqual([]);
    expect(ok.json.workflow.cli_commands).toEqual({ claude: 'claude', codex: 'codex', pi: 'HTTP_PROXY=http://127.0.0.1:7897 pi' });
    const bad = await api('POST', '/api/workflow', { cli_commands: { pi: 'a\nb' } });
    expect(bad.json.errors[0]).toMatch(/cli_commands\.pi/);
    expect(bad.json.workflow.cli_commands.pi).toBe('HTTP_PROXY=http://127.0.0.1:7897 pi');
  });

  it('POST /api/brains/test round-trips the stub and rejects bad kinds / model ids', async () => {
    await setup();
    const ok = await api('POST', '/api/brains/test', { kind: 'stub', model: null });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, kind: 'stub', name: 'stub' });
    expect((await api('POST', '/api/brains/test', { kind: 'gpt' })).status).toBe(400);
    expect((await api('POST', '/api/brains/test', { kind: 'pi', model: 'bad model;rm' })).status).toBe(400);
  });

  it('workflow accepts brain_model / cheap_brain_model and the loop view reflects the new brain name', async () => {
    const { rt } = await setup();
    const r = await api('POST', '/api/workflow', { brain: 'pi', brain_model: 'zai/glm-5-turbo', cheap_brain_model: '' });
    expect(r.status).toBe(200);
    expect(r.json.errors).toEqual([]);
    expect(r.json.workflow.brain_model).toBe('zai/glm-5-turbo');
    expect(r.json.workflow.cheap_brain_model).toBeNull();
    // The test runtime injects a stub for 'stub' only; 'pi' resolves through makeBrain → name carries the model.
    expect(rt.brainFor('pi', 'zai/glm-5-turbo').name).toBe('pi:zai/glm-5-turbo');
    const bad = await api('POST', '/api/workflow', { brain_model: 'has space' });
    expect(bad.json.errors.length).toBe(1);
  });

  it('GET /api/graph returns the declarative judgment graph and mermaid', async () => {
    await setup();
    const { status, json } = await api('GET', '/api/graph');
    expect(status).toBe(200);
    expect(json.graph.version).toBe('judgment-graph-v3');
    expect(json.graph.nodes.scan.allowed_actions).toEqual(['NO_TRADE', 'WATCH', 'PROPOSE']);
    expect(json.mermaid.startsWith('flowchart LR')).toBe(true);
  });
});

describe('memory routes (v3.2)', () => {
  it('user-created memory is active at once, listed, searchable, then forgotten', async () => {
    await setup();
    const created = await api('POST', '/api/memory', { content: '周末只做回踩确认过的入场', kind: 'preference', tags: ['weekend'] });
    expect(created.status).toBe(201);
    expect(created.json.item.status).toBe('active');
    expect(created.json.item.proposed_by).toBe('user');
    const list = await api('GET', '/api/memory?status=active');
    expect(list.json.items.map((m: { id: string }) => m.id)).toContain(created.json.item.id);
    expect(list.json.counts.active).toBe(1);
    const search = await api('GET', '/api/memory/search?q=回踩确认');
    expect(search.json.hits[0].item.id).toBe(created.json.item.id);
    const detail = await api('GET', `/api/memory/${created.json.item.id}`);
    expect(detail.json.events.map((e: { kind: string }) => e.kind)).toEqual(['approved', 'proposed']);
    const gone = await api('POST', `/api/memory/${created.json.item.id}/forget`, { reason: '测试' });
    expect(gone.json.item.status).toBe('forgotten');
    expect((await api('GET', '/api/memory/search?q=回踩确认')).json.hits).toEqual([]);
    expect((await api('POST', '/api/memory', {})).status).toBe(400);
    expect((await api('GET', '/api/memory/mem-nope')).status).toBe(404);
  });

  it('09-23 §9.48: POST passes scope, GET filters by layer, search reads by reader_role/strategy_id, denied write → 403', async () => {
    const { rt } = await setup();
    const g = (await api('POST', '/api/memory', { content: '分域测试 全局一条' })).json.item;
    const s = await api('POST', '/api/memory', { content: '分域测试 策略 s1 一条', layer: 'strategy', strategy_id: 's1' });
    expect(s.status).toBe(201);
    expect(s.json.item.scope).toMatchObject({ layer: 'strategy', strategy_id: 's1' });
    const r = await api('POST', '/api/memory', { content: '分域测试 radar 角色一条', layer: 'role', role: 'radar' });
    expect(r.json.item.scope).toMatchObject({ layer: 'role', role: 'radar' });
    expect((await api('POST', '/api/memory', { content: '缺 strategy_id', layer: 'strategy' })).status).toBe(400);
    expect((await api('GET', '/api/memory?layer=strategy')).json.items.map((m: { id: string }) => m.id)).toEqual([s.json.item.id]);
    expect((await api('GET', '/api/memory?layer=role&role=radar')).json.items.map((m: { id: string }) => m.id)).toEqual([r.json.item.id]);
    const ids = async (qs: string): Promise<string[]> => (await api('GET', `/api/memory/search${qs}`)).json.hits.map((h: { item: { id: string } }) => h.item.id);
    expect((await ids('')).sort()).toEqual([g.id, s.json.item.id, r.json.item.id].sort()); // 缺省 gate_captain 读全部
    expect(await ids('?reader_role=radar')).toEqual([g.id]);
    expect((await ids('?reader_role=thread_manager&strategy_id=s1')).sort()).toEqual([g.id, s.json.item.id].sort());
    expect(await ids('?reader_role=thread_manager&strategy_id=s2')).toEqual([g.id]);
    const spy = vi.spyOn(rt, 'rememberFromUser').mockImplementation(() => { throw new MemoryWriteDeniedError('radar', 'strategy', null); });
    const denied = await api('POST', '/api/memory', { content: 'x' });
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe('memory_write_denied');
    spy.mockRestore();
  });

  it('agent proposals need approval; approve/reject are one-shot; reflect refuses while paused', async () => {
    const { rt, store } = await setup();
    const { item } = store.memory.propose({ kind: 'lesson', content: 'bear 里别做多突破', proposed_by: 'agent' });
    expect((await api('GET', '/api/memory?status=proposed')).json.items).toHaveLength(1);
    const ok = await api('POST', `/api/memory/${item.id}/approve`);
    expect(ok.json.item.status).toBe('active');
    expect((await api('POST', `/api/memory/${item.id}/reject`)).status).toBe(409);
    rt.setWorkflow({ paused: true });
    expect((await api('POST', '/api/memory/reflect', { limit: 5 })).status).toBe(409);
  });
});

describe('09-23 §9.49 POST/DELETE /api/threads/:id/verified-event', () => {
  it('validates, stores the human-verified event on the thread, logs activity, queues a review, clears', async () => {
    const { store } = await setup();
    const t = { ...newThread({ id: 'thr-vevt', backend: 'paper', symbol: 'BTCUSDT', side: 'long', source: 'agent', timeframe: '15m', horizon: 'intraday', thesis: 'x', invalidation_text: '50000', watch_conditions: [], entry: { type: 'market', price: '77050', zone: null }, stop_price: '40000', take_profits: ['100000'], qty: '0.01', margin_usdt: '100', leverage: 1, margin_mode: 'cross', now: Date.now() - 3600000 }), status: 'in_position' as const, opened_at: Date.now() - 3600000, filled_avg_price: '77050' };
    store.saveThread(t);
    expect((await api('POST', '/api/threads/thr-nope/verified-event', { adverse_side: 'long', note: 'n' })).status).toBe(404);
    expect((await api('POST', `/api/threads/${t.id}/verified-event`, { adverse_side: 'up', note: 'n' })).status).toBe(400);
    expect((await api('POST', `/api/threads/${t.id}/verified-event`, { adverse_side: 'long' })).status).toBe(400);
    const wrong = await api('POST', `/api/threads/${t.id}/verified-event`, { adverse_side: 'short', note: '利好' });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error.code).toBe('side_mismatch');
    const ok = await api('POST', `/api/threads/${t.id}/verified-event`, { adverse_side: 'long', note: '交易所公告下架该合约' });
    expect(ok.status).toBe(200);
    expect(ok.json.review_queued).toBe(true);
    expect(ok.json.thread.verified_event).toMatchObject({ material: true, verified_by: 'user', adverse_side: 'long', note: '交易所公告下架该合约' });
    expect(store.thread(t.id)!.verified_event!.id).toBe(ok.json.thread.verified_event.id);
    expect((await api('GET', '/api/activity?limit=20')).json.activity.some((a: { title: string }) => a.title.includes('人工核实利空事件'))).toBe(true);
    const cleared = await api('DELETE', `/api/threads/${t.id}/verified-event`);
    expect(cleared.status).toBe(200);
    expect(cleared.json.thread.verified_event).toBeNull();
    expect(store.thread(t.id)!.verified_event).toBeNull();
  });
});

describe('market contract validation', () => {
  it('default_market 必须属于 markets,错误为 400 default_market_not_enabled', async () => {
    await setup();
    expect(await api('POST', '/api/workflow', { markets: ['perp'], default_market: 'spot' })).toMatchObject({ status: 400, json: { error: 'default_market_not_enabled' } });
    const valid = await api('POST', '/api/workflow', { markets: ['perp', 'spot'], default_market: 'spot' });
    expect(valid.status).toBe(200);
    expect(valid.json.workflow).toMatchObject({ markets: ['perp', 'spot'], default_market: 'spot' });
  });

  it('手工 spot 做空返回 400 spot_no_short,没有产生线程', async () => {
    const { store } = await setup();
    await api('POST', '/api/workflow', { markets: ['perp', 'spot'] });
    expect(await api('POST', '/api/orders', { symbol: 'BTCUSDT', market: 'spot', side: 'short', action: 'open', type: 'market', margin_usdt: '10' })).toMatchObject({ status: 400, json: { error: 'spot_no_short' } });
    expect(store.threads()).toHaveLength(0);
  });
});
