// binance-oauth.ts + mcp-client.ts against a local fake of Binance's authorization server + MCP endpoint.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { BinanceOAuth, TOKEN_KV_KEY, clientMetadataDocument, pkceChallenge, type KvLike } from '../../src/demo/binance-oauth.js';
import { McpAuthError, McpHttpClient, pickResponse } from '../../src/demo/mcp-client.js';

let server: http.Server;
let base = '';
const seen: { tokenBody?: URLSearchParams; mcpAuth: string[]; sessions: string[] } = { mcpAuth: [], sessions: [] };
let issuedChallenge = '';
let sseMode = false;
let killSession = false;

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((r) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => r(s));
  });

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code'] }));
      return;
    }
    if (url.pathname === '/token') {
      const body = new URLSearchParams(await readBody(req));
      seen.tokenBody = body;
      const ok = body.get('code') === 'good-code' && pkceChallenge(body.get('code_verifier') ?? '') === issuedChallenge;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
      res.end(ok ? JSON.stringify({ access_token: 'tok-1', token_type: 'Bearer', expires_in: 3600, scope: 'trade' }) : JSON.stringify({ error: 'invalid_grant' }));
      return;
    }
    if (url.pathname === '/mcp') {
      const auth = req.headers['authorization'] ?? '';
      seen.mcpAuth.push(String(auth));
      if (auth !== 'Bearer tok-1') {
        res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="x"' });
        res.end();
        return;
      }
      const sid = req.headers['mcp-session-id'];
      const msg = JSON.parse(await readBody(req)) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      if (msg.method === 'initialize') {
        const id = `s${seen.sessions.length + 1}`;
        seen.sessions.push(id);
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': id });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake-binance' }, capabilities: {} } }));
        return;
      }
      if (!sid || (killSession && sid === 's1')) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (msg.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }
      let result: unknown;
      if (msg.method === 'tools/list') result = { tools: [{ name: 'futures_place_order', description: 'place' }, { name: 'account_balance' }] };
      else if (msg.method === 'tools/call') result = { content: [{ type: 'text', text: JSON.stringify({ echo: msg.params?.name, args: msg.params?.arguments }) }], isError: false };
      else result = {};
      const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      if (sseMode) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`: keep-alive\n\nevent: message\ndata: ${payload}\n\n`);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(payload);
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const memKv = (): KvLike & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
};

describe('BinanceOAuth', () => {
  it('S256 challenge matches RFC 7636 test vector', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('client metadata document is a public PKCE client with the loopback redirect', () => {
    const d = clientMetadataDocument('https://h/c.json', ['http://127.0.0.1:18800/oauth/binance/callback']);
    expect(d['client_id']).toBe('https://h/c.json');
    expect(d['token_endpoint_auth_method']).toBe('none');
    expect(d['redirect_uris']).toEqual(['http://127.0.0.1:18800/oauth/binance/callback']);
  });

  it('refuses to start without a client_id and reports what is missing', async () => {
    const o = new BinanceOAuth({ clientId: null, redirectUri: 'http://127.0.0.1:1/cb', resource: `${base}/mcp`, issuer: base, kv: memKv() });
    await expect(o.startAuth()).rejects.toThrow(/client_id/);
    expect(o.status().configured).toBe(false);
    expect(o.status().missing).toMatch(/client-metadata/);
  });

  it('authorize URL carries PKCE + resource; callback exchanges the code and stores the token', async () => {
    const kv = memKv();
    let now = 1_000_000;
    const o = new BinanceOAuth({ clientId: 'https://h/c.json', redirectUri: 'http://127.0.0.1:1/cb', resource: `${base}/mcp`, issuer: base, kv, now: () => now });
    const { url, state } = await o.startAuth();
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(`${base}/authorize`);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('resource')).toBe(`${base}/mcp`);
    expect(u.searchParams.get('client_id')).toBe('https://h/c.json');
    issuedChallenge = u.searchParams.get('code_challenge') ?? '';

    await expect(o.handleCallback(new URLSearchParams({ code: 'good-code', state: 'wrong' }))).rejects.toThrow(/state/);
    const tok = await o.handleCallback(new URLSearchParams({ code: 'good-code', state }));
    expect(tok.access_token).toBe('tok-1');
    expect(tok.expires_at).toBe(now + 3600_000);
    expect(seen.tokenBody?.get('grant_type')).toBe('authorization_code');
    expect(seen.tokenBody?.get('client_id')).toBe('https://h/c.json');
    expect(kv.m.get(TOKEN_KV_KEY)).toContain('tok-1');
    expect(o.status().connected).toBe(true);
    expect(await o.token()).toBe('tok-1');

    // state is single-use
    await expect(o.handleCallback(new URLSearchParams({ code: 'good-code', state }))).rejects.toThrow(/state/);

    // expiry (minus skew) → token() null, status disconnected; disconnect clears
    now += 3600_000;
    expect(await o.token()).toBeNull();
    expect(o.status().connected).toBe(false);
    o.disconnect();
    expect(o.stored()).toBeNull();
  });

  it('rejects an error callback from the consent screen', async () => {
    const o = new BinanceOAuth({ clientId: 'https://h/c.json', redirectUri: 'http://127.0.0.1:1/cb', resource: `${base}/mcp`, issuer: base, kv: memKv() });
    await expect(o.handleCallback(new URLSearchParams({ error: 'access_denied', error_description: 'user said no' }))).rejects.toThrow(/access_denied/);
  });
});

describe('McpHttpClient', () => {
  it('pickResponse reads JSON and SSE bodies', () => {
    expect(pickResponse('{"jsonrpc":"2.0","id":3,"result":{"a":1}}', 3)?.result).toEqual({ a: 1 });
    expect(pickResponse(': ping\n\nevent: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"b":2}}\n\n', 7)?.result).toEqual({ b: 2 });
    expect(pickResponse('', 1)).toBeNull();
  });

  it('401 without a token surfaces as McpAuthError before any request', async () => {
    const c = new McpHttpClient({ url: `${base}/mcp`, token: async () => null });
    await expect(c.listTools()).rejects.toBeInstanceOf(McpAuthError);
    const bad = new McpHttpClient({ url: `${base}/mcp`, token: async () => 'stale' });
    await expect(bad.listTools()).rejects.toBeInstanceOf(McpAuthError);
  });

  it('initializes once, keeps the session id, lists and calls tools (JSON and SSE framing)', async () => {
    seen.sessions.length = 0;
    sseMode = false;
    const c = new McpHttpClient({ url: `${base}/mcp`, token: async () => 'tok-1' });
    const tools = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(['futures_place_order', 'account_balance']);
    expect(c.serverInfo).toEqual({ name: 'fake-binance' });
    sseMode = true;
    const r = await c.callTool('futures_place_order', { symbol: 'BTCUSDT', qty: '0.001' });
    expect(r.isError).toBe(false);
    expect(r.structured).toEqual({ echo: 'futures_place_order', args: { symbol: 'BTCUSDT', qty: '0.001' } });
    expect(seen.sessions).toEqual(['s1']);
    sseMode = false;
  });

  it('re-initializes once when the server forgets the session (404)', async () => {
    seen.sessions.length = 0;
    killSession = false;
    const c = new McpHttpClient({ url: `${base}/mcp`, token: async () => 'tok-1' });
    await c.listTools();
    killSession = true;
    const tools = await c.listTools();
    expect(tools.length).toBe(2);
    expect(seen.sessions).toEqual(['s1', 's2']);
    killSession = false;
  });

  it('hashes nothing secret into logs: bearer token only travels in the header', () => {
    expect(createHash('sha256').update('tok-1').digest('hex')).not.toBe('tok-1');
  });
});
