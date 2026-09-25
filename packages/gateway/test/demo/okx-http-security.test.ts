import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type http from 'node:http';
import type { DemoRuntime } from '../../src/demo/runtime.js';
import type { DemoStore } from '../../src/demo/store.js';

// No sockets, real CLI, or user configuration: dispatch through the real server
// Origin guard and JSON writer with injected route services.
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => { throw new Error('real spawn forbidden'); }), spawnSync: vi.fn(() => { throw new Error('real spawn forbidden'); }) }));
vi.mock('../../src/demo/http-extra.js', () => ({ extraRouteModules: [({ route, json }: any) => {
  for (const path of ['/api/wallet', '/api/execution/okx/mcp']) route('GET', path, async (_req: any, res: any) => json(res, 200, { fake: true }));
}] }));
import { createServer } from '../../src/demo/http.js';

afterEach(() => vi.restoreAllMocks());
async function request(path: string, origin?: string, method = 'GET') {
  vi.spyOn(globalThis, 'setInterval').mockReturnValue({ unref() {} } as any);
  const rt = Object.assign(new EventEmitter(), { checkExecutionConnection: async () => ({ fake: true }) });
  const server = createServer(rt as unknown as DemoRuntime, {} as DemoStore);
  const headers: Record<string, unknown> = {};
  let status = 0;
  let body = '';
  const res = { setHeader: (key: string, value: unknown) => { headers[key] = value; },
    writeHead: (code: number, values: object) => { status = code; Object.assign(headers, values); },
    end: (value = '') => { body = value; } };
  const handler = server.listeners('request')[0]!;
  await handler({ url: path, method, headers: origin ? { origin } : {} } as http.IncomingMessage, res as unknown as http.ServerResponse);
  server.close();
  return { status, headers, body };
}

describe('private OKX/wallet CORS', () => {
  it.each(['/api/wallet', '/api/wallet?refresh=1', '/api/execution/okx/mcp', '/api/execution'])('rejects hostile GET %s before route dispatch', async path => {
    const result = await request(path, 'https://hostile.test');
    expect(result.status).toBe(403);
    expect(result.headers['access-control-allow-origin']).toBeUndefined();
    expect(result.body).not.toContain('fake');
  });
  it.each(['5180', '5181', '5191', '5195', '18800', '18801', '18805', '18811', '18900'])('permits both localhost dev hosts on %s', async port => {
    for (const host of ['localhost', '127.0.0.1']) {
      const origin = `http://${host}:${port}`;
      for (const path of ['/api/wallet', '/api/execution/okx/mcp', '/api/execution']) {
        const result = await request(path, origin);
        expect(result.status).toBe(200);
        expect(result.headers['access-control-allow-origin']).toBe(origin);
        expect(result.headers.vary).toBe('Origin');
      }
    }
  });
  it('allows local callers without wildcard and validates preflights', async () => {
    expect((await request('/api/wallet')).headers['access-control-allow-origin']).toBeUndefined();
    expect((await request('/api/wallet', 'https://hostile.test', 'OPTIONS')).status).toBe(403);
    const result = await request('/api/wallet', 'http://localhost:5191', 'OPTIONS');
    expect(result.status).toBe(204);
    expect(result.headers['access-control-allow-origin']).toBe('http://localhost:5191');
  });
});
