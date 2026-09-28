import { describe, it, expect, vi } from 'vitest';
import { marketRoutes } from '../../src/demo/asp-agent/routes-market.js';
import type { RouteContext } from '../../src/demo/http-extra.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
// 远端永不完成也必须快速响应；同一 GET 不能积压更多 CLI 刷新。
it('市场首屏不等待任何远端调用，目录订阅未知不能伪装成未订阅', async () => {
  const routes = new Map<string, Function>(); const json = vi.fn();
  const never = vi.fn(() => new Promise<any>(() => {}));
  const agent = { wallet: { status: never }, identity: { mine: never }, cli: { call: never }, inbox: { status: () => ({}) }, asp: never, subscriptions: never, subscribedByProvider: never,
    catalog: { get: () => ({ agents: [], fetched_at: 1, building: false, categories: [], total_site: 0, errors: [] }) } };
  marketRoutes({ route: (method, path, handler) => routes.set(`${method} ${path}`, handler), guarded: fn => fn, json,
    rt: { marketAgent: () => agent, okxAccountLights: never, on: () => {} } } as unknown as RouteContext);
  const req = { method: 'GET' } as IncomingMessage;
  for (const path of ['/api/market/status', '/api/market/asp', '/api/market/subscriptions', '/api/market/catalog']) {
    const handler = routes.get(`GET ${path}`)!;
    await handler(req, {} as ServerResponse, new URL('http://localhost'+path), {});
    const result = json.mock.calls.at(-1)!;
    expect(result[1]).toBe(200); expect(result[2]).toMatchObject({ cache: { fetched_at: null, state: 'loading', refreshing: true } });
    if (path.endsWith('catalog')) expect(result[2].subscriptions_known).toBe(false);
  }
  const calls = never.mock.calls.length;
  await routes.get('GET /api/market/status')!(req, {}, new URL('http://localhost/api/market/status'), {});
  expect(never).toHaveBeenCalledTimes(calls);
});
