// §9.52 /api/models 端到端:真 DemoRuntime + createServer(内存库、桩大脑、假行情、注入 fetch)。
// 重点断言(F1):任何 API 响应、SSE 帧、日志里都不出现明文 key。
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { stubBrain } from '../../src/demo/brain.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';

const KEY = 'sk-or-v1-fedcba9876543210fedcba9876543210fedcba9876543210a1b2c3';
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

let server: http.Server | null = null;
let rt: InstanceType<typeof DemoRuntime> | null = null;
let state: StateDb | null = null;
let base = '';
const seen: string[] = []; // 所有响应体 + SSE 帧,最后统一查明文 key

afterEach(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server!.close(() => r()));
  }
  if (rt) await rt.stop();
  state?.close();
  server = null;
  rt = null;
  state = null;
  seen.length = 0;
  outbound.length = 0;
  upstream = 'ok';
});

let upstream: 'ok' | 'unauthorized' | 'redirect' = 'ok';
const outbound: { url: string; headers: Record<string, string>; redirect: RequestRedirect | undefined }[] = [];
const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  outbound.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, redirect: init?.redirect });
  if (upstream === 'redirect' && !url.startsWith('https://evil.example')) return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } });
  if (upstream === 'unauthorized') return new Response(JSON.stringify({ error: { message: `invalid key ${KEY}` } }), { status: 401 });
  if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
  if (url.endsWith('/alpha/decisions')) return new Response(JSON.stringify({ model: 'typesafe/jev', answers: { ok: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 5, cost: 0.000001 } }), { status: 200 });
  void init;
  return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 20, completion_tokens: 1, cost: 0.00001 } }), { status: 200 });
}) as typeof fetch;

async function setup(): Promise<void> {
  state = openStateDb(':memory:');
  const store = new DemoStore(state);
  rt = new DemoRuntime({ store, backend: new PaperBackend(10_000), brains: { stub: stubBrain() }, marketPollMs: 600_000, accountPollMs: 600_000, models: { fetchFn, detectCli: () => true, cliModels: () => [], importEnvPath: null } });
  await rt.start();
  rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'] });
  rt.on('models.changed', (v) => seen.push(JSON.stringify(v)));
  server = createServer(rt, store);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function api(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${p}`, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  seen.push(text);
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe('/api/models', () => {
  it('connection lifecycle, role binding takes effect immediately, failures are explicit, key never leaves the server', async () => {
    await setup();
    const empty = await api('GET', '/api/models');
    expect(empty.status).toBe(200);
    expect(empty.json.connections).toEqual([]);
    expect(empty.json.effective.judge).toEqual({ source: 'fallback_main', name: 'stub' });

    const created = await api('POST', '/api/models/connections', { kind: 'openrouter', api_key: KEY });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    expect(created.json.key_masked).toBe('sk-or-…a1b2c3');

    const tested = await api('POST', `/api/models/connections/${id}/test`, {});
    expect(tested.json).toMatchObject({ ok: true });
    const decisionTest = await api('POST', `/api/models/connections/${id}/test`, { model: '~typesafe/jev-latest' });
    expect(decisionTest.json.ok).toBe(true);

    expect((await api('PUT', '/api/models/bindings/chat', { connection_id: id, model: '~typesafe/jev-latest' })).json.error.code).toBe('decision_only_model');
    const bound = await api('PUT', '/api/models/bindings/judge', { connection_id: id, model: 'deepseek/deepseek-v4.1-flash' });
    expect(bound.json.effective.judge).toEqual({ source: 'binding', name: 'openrouter:deepseek/deepseek-v4.1-flash' });
    // 立即生效:runtime 的判断大脑就是这条连接;没绑的 chat 仍回退主脑
    expect(rt!.brainForRole('judge').name).toBe('openrouter:deepseek/deepseek-v4.1-flash');
    expect(rt!.brainForRole('chat').name).toBe('stub');
    await api('PUT', '/api/models/bindings/decision', { connection_id: id, model: null });
    expect(rt!.decisionClient()?.name).toBe('openrouter:~typesafe/jev-latest');

    const busy = await api('DELETE', `/api/models/connections/${id}`);
    expect(busy.status).toBe(409);
    expect(busy.json.error.code).toBe('connection_in_use');
    expect(busy.json.roles.sort()).toEqual(['decision', 'judge']);

    // 连接失效:判断明确报错,不回退主脑;连接标 error;日志里也没有明文
    upstream = 'unauthorized';
    await expect(rt!.brainForRole('judge').complete('s', 'u')).rejects.toThrow(/^model_connection_failed:judge:401/);
    await expect(rt!.decisionClient()!.decide({ state: {}, questions: { ok: { type: 'noul', instructions: 'x', criteria: { true: 'a', false: 'b' } } } })).rejects.toThrow(/^model_connection_failed:decision:/);
    upstream = 'ok';
    const after = await api('GET', '/api/models');
    expect(after.json.connections[0].status).toBe('error');

    const patched = await api('PATCH', `/api/models/connections/${id}`, { label: '我的 OR' });
    expect(patched.json).toMatchObject({ label: '我的 OR', key_masked: 'sk-or-…a1b2c3' });

    await api('PUT', '/api/models/bindings/judge', { connection_id: null, model: null });
    await api('PUT', '/api/models/bindings/decision', { connection_id: null, model: null });
    expect((await api('DELETE', `/api/models/connections/${id}`)).json).toEqual({ ok: true });

    const logs = rt!.store.logs(500).map((l) => `${l.message} ${JSON.stringify(l.data ?? null)}`).join('\n');
    expect(logs).toContain('调用失败');
    for (const text of [...seen, logs]) expect(text).not.toContain(KEY);
  });

  it('SSRF guard: base_url only for openai_compatible, private/metadata/userinfo/http+key rejected, 3xx not followed, short key rejected', async () => {
    await setup();
    const post = (body: Record<string, unknown>) => api('POST', '/api/models/connections', body);
    // 内置 provider 不许带 / 改 base_url
    expect((await post({ kind: 'openrouter', api_key: KEY, base_url: 'https://evil.example/api/v1' })).json.error.code).toBe('base_url_not_allowed');
    const created = await post({ kind: 'openrouter', api_key: KEY });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    const moved = await api('PATCH', `/api/models/connections/${id}`, { base_url: 'https://evil.example/api/v1' });
    expect(moved.status).toBe(400);
    expect(moved.json.error.code).toBe('base_url_not_allowed');
    // openai_compatible:私网 / 元数据 / userinfo / http+key 一律 400
    const cases: [Record<string, unknown>, string][] = [
      [{ base_url: 'https://169.254.169.254/v1' }, 'base_url_blocked'],
      [{ base_url: 'https://10.0.0.8/v1', api_key: KEY }, 'base_url_blocked'],
      [{ base_url: 'https://[fd00:ec2::254]/v1' }, 'base_url_blocked'],
      [{ base_url: 'https://user:pass@8.8.8.8/v1' }, 'bad_request'],
      [{ base_url: 'https://8.8.8.8/v1#x' }, 'bad_request'],
      [{ base_url: 'http://127.0.0.1:11434/v1', api_key: KEY }, 'base_url_insecure'],
      [{ base_url: 'http://8.8.8.8/v1' }, 'base_url_insecure'],
    ];
    for (const [body, code] of cases) {
      const r = await post({ kind: 'openai_compatible', ...body });
      expect([body, r.status, r.json.error?.code]).toEqual([body, 400, code]);
    }
    // localhost 无 key 允许
    const local = await post({ kind: 'openai_compatible', base_url: 'http://localhost:11434/v1' });
    expect(local.status).toBe(201);
    expect(local.json.base_url).toBe('http://localhost:11434/v1');
    // 短 key / 带空白的 key
    expect((await post({ kind: 'deepseek', api_key: 'sk-short' })).json.error.code).toBe('api_key_invalid');
    expect((await api('PATCH', `/api/models/connections/${id}`, { api_key: 'abc def ghi jkl mno' })).json.error.code).toBe('api_key_invalid');

    // 3xx:当失败,不跟随,Authorization 不去 Location
    upstream = 'redirect';
    outbound.length = 0;
    const tested = await api('POST', `/api/models/connections/${id}/test`, {});
    expect(tested.json.ok).toBe(false);
    expect(tested.json.detail).toMatch(/重定向/);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({ url: 'https://openrouter.ai/api/v1/chat/completions', redirect: 'manual' });
    expect(outbound.some((o) => o.url.includes('evil.example'))).toBe(false);
    upstream = 'ok';

    const view = await api('GET', '/api/models');
    expect(view.json.connections.find((c: { id: string }) => c.id === id).base_url).toBeNull();
    const logs = rt!.store.logs(500).map((l) => `${l.message} ${JSON.stringify(l.data ?? null)}`).join('\n');
    for (const text of [...seen, logs]) expect(text).not.toContain(KEY);
  });
});
