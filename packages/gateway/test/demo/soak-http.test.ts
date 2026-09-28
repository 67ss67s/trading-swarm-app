// 公网演示模式权限(public-gate.ts)与非公网入口鉴权(http-security.ts)。真实 HTTP 服务 + 临时库,运行时用最小替身。
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RouteModule } from '../../src/demo/http-extra.js';

vi.mock('../../src/demo/http-extra.js', () => {
  const testRoutes: RouteModule = ({ route, json }) => {
    route('POST', '/api/halt-test', async (_req, res) => json(res, 200, { ok: true }));
    route('POST', '/api/recommendations', async (_req, res) => json(res, 200, { ok: true, recommended: ['BTCUSDT'] }));
    route('GET', '/api/wallet', async (_req, res) => json(res, 200, { balance_usd: '123.45', address: '0xabc' }));
    route('GET', '/api/leaky', async (_req, res) => json(res, 200, { api_key: 'k', note: 'file at /Users/demo/.okx/config.toml token=abcdef', equity: '1000', input_tokens: 5 }));
    route('GET', '/api/judge/live/stream', async (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': judge.live\n\n'); });
  };
  return { extraRouteModules: [testRoutes] };
});

vi.mock('../../src/demo/agent-roster.js', () => ({
  agentCards: () => [{ role: 'captain', last_text: 'owner 私聊内容', message_count: 3 }],
  agentDetail: () => ({}),
}));

import { createServer } from '../../src/demo/http.js';
import { gatewaySecurity } from '../../src/demo/http-security.js';
import { DemoStore } from '../../src/demo/store.js';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import type { DemoRuntime } from '../../src/demo/runtime.js';

const OWNER = 'o'.repeat(40);
const INVITE = 'i'.repeat(40);
const cleanups: (() => void)[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const fn of cleanups.splice(0).reverse()) fn();
});

function fakeRuntime(store: DemoStore, brainCalls: string[]): DemoRuntime {
  const rt = Object.assign(new EventEmitter(), {
    store,
    workflow: { decision_daily_usd_cap: 2 },
    backend: { kind: 'paper' },
    usageToday: () => ({ judgments: 2, cap: 3, capped: false, input_tokens: 0, output_tokens: 0 }),
    brainForRole: () => ({ name: 'stub', complete: async (_s: string, user: string) => {
      brainCalls.push(user);
      const text = user.includes('推荐') && !user.includes('@@result') ? '@@tool {"name":"recommend_assets","args":{"top_n":2}}' : `答:${user.split('\n')[0]}`;
      return { text, model: 'stub', input_tokens: 1, output_tokens: 1, cost_usd: null };
    } }),
    chatTools: () => ({ recommend_assets: async () => ({ recommendation_id: 'rec-1', items: [{ symbol: 'BTCUSDT' }] }), get_screen: () => ({ screen: null }) }),
    loopView: () => ({}),
    queueView: () => ({}),
  });
  return rt as unknown as DemoRuntime;
}

async function start(publicMode: boolean) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tg-soak-http-'));
  vi.stubEnv('TG_PUBLIC_DEMO', publicMode ? '1' : '0');
  vi.stubEnv('TG_OWNER_TOKEN', OWNER);
  vi.stubEnv('TG_REVIEW_INVITE_TOKEN', INVITE);
  vi.stubEnv('TG_TRUST_LOOPBACK_PROXY', '1');
  vi.stubEnv('TG_DEMO_INSECURE_COOKIE', '1');
  const state: StateDb = openStateDb(path.join(dir, 'state.sqlite'));
  const store = new DemoStore(state);
  const brainCalls: string[] = [];
  const rt = fakeRuntime(store, brainCalls);
  const server = createServer(rt, store);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => {
    server.close();
    state.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (method: string, pathname: string, headers: Record<string, string> = {}, body?: unknown) => {
    const res = await fetch(base + pathname, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) as Record<string, unknown> : null, headers: res.headers };
  };
  return { call, store, brainCalls, server, base, rt };
}

describe('公网演示模式权限表', () => {
  it('匿名:GET 可读、敏感读取遮蔽、管理类 403、演示可玩类可用', async () => {
    const { call } = await start(true);
    const ip = { 'x-real-ip': '203.0.113.7' };
    expect((await call('GET', '/api/chat/sessions', ip)).status).toBe(200);
    const wallet = await call('GET', '/api/wallet', ip);
    expect(wallet.status).toBe(403);
    expect(wallet.json).toMatchObject({ error: { code: 'judge_locked' }, locked: true });
    expect(wallet.text).not.toContain('123.45');
    const halt = await call('POST', '/api/halt-test', ip, {});
    expect(halt.status).toBe(403);
    expect(halt.json).toMatchObject({ error: { code: 'judge_locked', message: expect.stringMatching(/^Locked in the review demo/) }, locked: true });
    expect((await call('PUT', '/api/asp-services/config', ip, {})).status).toBe(403);
    expect((await call('POST', '/api/recommendations', ip, {})).json).toMatchObject({ ok: true });
  });

  it('匿名响应去掉凭证字段并抹掉服务器路径;owner 原样', async () => {
    const { call } = await start(true);
    const anon = await call('GET', '/api/leaky', { 'x-real-ip': '203.0.113.8' });
    expect(anon.json).toMatchObject({ equity: '1000', input_tokens: 5 });
    expect(anon.text).not.toMatch(/api_key|\/Users\/demo|abcdef/);
    const owner = await call('GET', '/api/leaky', { 'x-owner-token': OWNER });
    expect(owner.json).toMatchObject({ api_key: 'k' });
  });

  it('owner:请求头或 ?owner= 换来的 cookie 都能做管理操作;错误令牌仍是访客', async () => {
    const { call } = await start(true);
    expect((await call('POST', '/api/halt-test', { authorization: `Bearer ${OWNER}` }, {})).status).toBe(200);
    expect((await call('POST', '/api/halt-test', { 'x-owner-token': 'x'.repeat(40) }, {})).status).toBe(403);
    const exchange = await call('GET', `/api/demo/session?owner=${OWNER}`);
    expect(exchange.status).toBe(303);
    const cookie = exchange.headers.get('set-cookie')!.split(';')[0]!;
    expect(exchange.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect((await call('GET', '/api/demo/whoami', { cookie })).json).toMatchObject({ role: 'owner', read_only: false });
    expect((await call('POST', '/api/halt-test', { cookie }, {})).status).toBe(200);
    // 篡改签名的 cookie 不被承认
    expect((await call('GET', '/api/demo/whoami', { cookie: cookie.slice(0, -2) + 'xx' })).json).toMatchObject({ role: 'anonymous' });
  });

  it('invite:换 cookie 得到 invited 身份;无效 invite 也回首页只读浏览', async () => {
    const { call } = await start(true);
    const bad = await call('GET', '/api/demo/session?invite=wrong');
    expect(bad.status).toBe(303);
    expect(bad.headers.get('set-cookie')).toBeNull();
    const good = await call('GET', `/api/demo/session?invite=${INVITE}`);
    const cookie = good.headers.get('set-cookie')!.split(';')[0]!;
    expect((await call('GET', '/api/demo/whoami', { cookie })).json).toMatchObject({ role: 'invited', read_only: true });
    expect((await call('POST', '/api/halt-test', { cookie }, {})).status).toBe(403);
  });

  it('可玩写操作免 invite:paper 下单、手动扫描、策略运行、观察列表(锁定 10 币内);其余 403 judge_locked', async () => {
    const { call, rt } = await start(true);
    const ip = { 'x-real-ip': '203.0.113.9' };
    const passed = async (m: string, p: string, body: unknown = {}): Promise<boolean> => (await call(m, p, ip, body)).status !== 403;
    expect(await passed('POST', '/api/orders')).toBe(true);
    expect(await passed('POST', '/api/threads/t1/close')).toBe(true);
    expect(await passed('POST', '/api/run-now')).toBe(true);
    expect(await passed('POST', '/api/scan-now', { symbol: 'BTCUSDT' })).toBe(true);
    expect(await passed('PUT', '/api/agent/strategy', { kind: 'free' })).toBe(true);
    expect(await passed('POST', '/api/strategy-runs', { strategy_id: 's1' })).toBe(true);
    expect(await passed('PATCH', '/api/strategy-runs/run_x', { status: 'paused' })).toBe(true);
    // 09-27:访客可以切判断方式(含 Jev),AI 扫盘只能恢复
    expect(await passed('PATCH', '/api/strategy-runs/run_x', { mode: 'jev' })).toBe(true);
    expect(await passed('PATCH', '/api/strategy-runs/run_x', { status: 'running', mode: 'auto' })).toBe(true);
    expect(await passed('PATCH', '/api/trading/sources/ai_scan', { paused: false })).toBe(true);
    expect(await passed('POST', '/api/workflow', { watchlist: ['BTCUSDT', 'ETHUSDT'] })).toBe(true);
    const locked = async (m: string, p: string, body: unknown = {}): Promise<void> => {
      const r = await call(m, p, ip, body);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.json).toMatchObject({ error: { code: 'judge_locked', message: expect.stringMatching(/^Locked in the review demo: /) }, locked: true });
    };
    await locked('POST', '/api/workflow', { watchlist: ['PEPEUSDT'] });
    await locked('POST', '/api/workflow', { watchlist: ['BTCUSDT'], auto_approve: true });
    await locked('POST', '/api/strategy-runs', { strategy_id: 's1', publish_asp: true });
    await locked('PATCH', '/api/strategy-runs/run_x', { status: 'running', risk_pct: 5 });
    // 09-27 交易页三层:执行层参数和仓位倍率只归 owner;判断方式访客可改,但只能是四档之一
    await locked('PATCH', '/api/strategy-runs/run_x', { mode: 'confirm' });
    await locked('PATCH', '/api/trading/sources/ai_scan', { paused: true });
    await locked('PATCH', '/api/trading/sources/ai_scan', { paused: false, extra: 1 });
    await locked('PATCH', '/api/execution-policy', { sizing_agent: 'apply' });
    await locked('PUT', '/api/execution-policy', {});
    await locked('POST', '/api/workflow', { sizing_agent: 'off' });
    await locked('POST', '/api/halt', { confirm: 'HALT' });
    await locked('POST', '/api/execution/okx/setup', {});
    await locked('POST', '/api/models/connections', {});
    await locked('POST', '/api/market/subscribe', {});
    await locked('POST', '/api/wallet/login', {});
    await locked('POST', '/api/positions/BTCUSDT/adopt', {});
    // 执行通道不是 paper 时,交易写与策略运行一律锁
    (rt as unknown as { backend: { kind: string } }).backend.kind = 'okx';
    await locked('POST', '/api/orders', {});
    await locked('POST', '/api/threads/t1/close', {});
    await locked('PUT', '/api/agent/strategy', { kind: 'free' });
  });

  it('匿名每日演示操作次数有上限,且按访客分开计', async () => {
    const { call } = await start(true);
    vi.stubEnv('TG_DEMO_ANON_DAILY_ACTIONS', '2');
    const a = { 'x-real-ip': '198.51.100.1' };
    expect((await call('POST', '/api/recommendations', a, {})).status).toBe(200);
    expect((await call('POST', '/api/recommendations', a, {})).status).toBe(200);
    const third = await call('POST', '/api/recommendations', a, {});
    expect(third.status).toBe(429);
    expect(third.json).toMatchObject({ error: { code: 'demo_budget_exhausted' } });
    expect((await call('POST', '/api/recommendations', { 'x-real-ip': '198.51.100.2' }, {})).status).toBe(200);
  });

  it('访客对话:独立会话、别人看不到;不能读别人的会话', async () => {
    const { call, brainCalls } = await start(true);
    const alice = { 'x-real-ip': '192.0.2.1' };
    const bob = { 'x-real-ip': '192.0.2.2' };
    const sent = await call('POST', '/api/chat/messages', alice, { text: '你们怎么控制风险?' });
    expect(sent.status).toBe(200);
    expect(brainCalls).toHaveLength(1);
    expect(brainCalls[0]).toContain('你们怎么控制风险?');
    const session = String(sent.json!['session']);
    expect(((await call('GET', '/api/chat/sessions', alice)).json!['sessions'] as unknown[]).length).toBe(1);
    expect(((await call('GET', '/api/chat/sessions', bob)).json!['sessions'] as unknown[]).length).toBe(0);
    expect((await call('GET', `/api/chat/messages?session=${session}`, bob)).json).toMatchObject({ messages: [] });
    expect(((await call('GET', `/api/chat/messages?session=${session}`, alice)).json!['messages'] as unknown[]).length).toBe(2);
    expect((await call('POST', '/api/chat/messages', bob, { text: 'hi', session })).status).toBe(403);
  });

  it('访客对话带只读工具:「推荐几个币」调 recommend_assets,工具结果进 tool_calls(前端出推荐卡),计入花费', async () => {
    const { call, store } = await start(true);
    const ip = { 'x-real-ip': '192.0.2.5' };
    const sent = await call('POST', '/api/chat/messages', ip, { text: '推荐几个币' });
    expect(sent.status).toBe(200);
    const messages = (await call('GET', `/api/chat/messages?session=${String(sent.json!['session'])}`, ip)).json!['messages'] as { role: string; tool_calls: { name: string; result: unknown }[] }[];
    const agent = messages.find((m) => m.role === 'agent')!;
    expect(agent.tool_calls[0]).toMatchObject({ name: 'recommend_assets', ok: true, result: { recommendation_id: 'rec-1' } });
    const spent = store.marketDb.prepare("SELECT reserved_microusd n FROM ops_demo_usage WHERE subject = 'visitors'").get() as { n: number };
    expect(spent.n).toBeGreaterThan(0);
  });

  it('agent 名册对访客去掉 owner 私聊预览;judge-live 流单访客最多 8 条(TG_DEMO_STREAMS_PER_VISITOR)', async () => {
    const { call, base } = await start(true);
    const ip = { 'x-real-ip': '192.0.2.9' };
    const anon = await call('GET', '/api/agents', ip);
    expect(anon.json).toMatchObject({ agents: [{ role: 'captain', message_count: 3 }] });
    expect(anon.text).not.toContain('owner 私聊内容');
    expect((await call('GET', '/api/agents', { 'x-owner-token': OWNER })).text).toContain('owner 私聊内容');
    const controllers: AbortController[] = [];
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) {
      const c = new AbortController();
      controllers.push(c);
      statuses.push((await fetch(`${base}/api/judge/live/stream`, { headers: ip, signal: c.signal })).status);
    }
    for (const c of controllers) c.abort();
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 429]);
  });

  it('访客日志只给时间与级别;健康接口对访客只给状态', async () => {
    const { call, store } = await start(true);
    store.log({ at: Date.now(), level: 'warn', scope: 'exec', message: 'secret detail /home/tradegate/x' });
    const logs = await call('GET', '/api/logs', { 'x-real-ip': '192.0.2.3' });
    expect(logs.text).not.toContain('secret detail');
    const health = await call('GET', '/api/health', { 'x-real-ip': '192.0.2.3' });
    expect(Object.keys(health.json!).sort()).toEqual(['dependencies', 'status', 'uptime_seconds']);
    const full = await call('GET', '/api/health', { 'x-owner-token': OWNER });
    expect(full.json).toHaveProperty('budget.judgments', 2);
  });

  it('不信任代理头时,伪造 X-Real-IP 不能绕开单访客限额', async () => {
    const { call } = await start(true);
    vi.stubEnv('TG_TRUST_LOOPBACK_PROXY', '0');
    vi.stubEnv('TG_DEMO_ANON_DAILY_ACTIONS', '1');
    expect((await call('POST', '/api/recommendations', { 'x-real-ip': '1.1.1.1' }, {})).status).toBe(200);
    expect((await call('POST', '/api/recommendations', { 'x-real-ip': '2.2.2.2' }, {})).status).toBe(429);
  });
});

describe('/api/events 心跳(公网访客 SSE 名额释放)', () => {
  it('按 TG_SSE_HEARTBEAT_MS 给访客的事件流写心跳', async () => {
    vi.stubEnv('TG_SSE_HEARTBEAT_MS', '1000');
    const { base } = await start(true);
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/events`, { headers: { 'x-real-ip': '203.0.113.60' }, signal: ctrl.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const started = Date.now();
    let text = '';
    while (!text.includes(': ping') && Date.now() - started < 4000) text += new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());
    ctrl.abort();
    expect(text).toContain(': ping');
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('非公网部署入口', () => {
  const tokenFile = (): string => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tg-token-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'token');
    writeFileSync(file, 'a'.repeat(40), { mode: 0o600 });
    return file;
  };

  it('非回环监听没有令牌也不是公网演示时拒绝启动', () => {
    vi.stubEnv('TG_DEMO_HOST', '0.0.0.0');
    vi.stubEnv('TG_PUBLIC_DEMO', '0');
    expect(() => gatewaySecurity()).toThrow(/非回环/);
  });

  it('配置令牌后所有接口都要 bearer,健康接口除外', async () => {
    vi.stubEnv('TG_GATEWAY_TOKEN_FILE', tokenFile());
    const { call } = await start(false);
    expect((await call('POST', '/api/halt-test', {}, {})).status).toBe(401);
    expect((await call('GET', '/api/overview')).status).toBe(401);
    expect((await call('POST', '/api/halt-test', { authorization: `Bearer ${'a'.repeat(40)}` }, {})).status).toBe(200);
    const health = await call('GET', '/api/health');
    expect(health.status).toBe(200);
    expect(health.text).not.toContain('a'.repeat(40));
  });

  it('配置 Origin 后已认证请求也不能跨站写', async () => {
    vi.stubEnv('TG_GATEWAY_TOKEN_FILE', tokenFile());
    vi.stubEnv('TG_ALLOWED_ORIGINS', 'https://trade.example.com');
    const { call } = await start(false);
    const auth = `Bearer ${'a'.repeat(40)}`;
    expect((await call('POST', '/api/halt-test', { authorization: auth, origin: 'https://hostile.test' }, {})).status).toBe(403);
    expect((await call('POST', '/api/halt-test', { authorization: auth, origin: 'https://trade.example.com' }, {})).status).toBe(200);
  });

  it('畸形 URL 解码回 400,不会变成未处理 rejection', async () => {
    const { call } = await start(false);
    expect((await call('GET', '/api/episodes/%E0%A4%A')).status).toBe(400);
  });
});
