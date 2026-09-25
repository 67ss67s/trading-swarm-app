// The deterministic execution path (docs/demo/v3-ui-contract.md §9.8): heuristic tool-map proposal
// (mcp-map.ts), the McpDirectBackend that executes through it (execution-mcp.ts), and the
// /api/binance/map* routes — all against a local fake of Binance's Agentic MCP server whose catalogue
// looks like the real one is expected to (futures_um_*), plus a couple of distractors that must never
// be picked (spot, withdraw).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openStateDb, type StateDb } from '../../src/state-db.js';
import { DemoStore } from '../../src/demo/store.js';
import { PaperBackend } from '../../src/demo/execution.js';
import { stubBrain } from '../../src/demo/brain.js';
import { BinanceOAuth, TOKEN_KV_KEY, type StoredToken } from '../../src/demo/binance-oauth.js';
import { McpHttpClient, type McpTool } from '../../src/demo/mcp-client.js';
import { loadToolMap, MCP_MAP_KV_KEY, MCP_OPS, proposeToolMap, renderArgs, extractPath, validateToolMap, mapReviewPrompt, type McpToolMap } from '../../src/demo/mcp-map.js';
import { McpDirectBackend, mcpAvailability } from '../../src/demo/execution-mcp.js';
import { startFakeMarketServer, type FakeMarketServer } from './helpers/fake-market-server.js';

// ---------------------------------------------------------------- the fake MCP server

const prop = (...names: string[]): Record<string, unknown> => Object.fromEntries(names.map((n) => [n, { type: 'string' }]));

const CATALOGUE: McpTool[] = [
  { name: 'futures_um_place_order', description: 'Send in a new order on USDⓈ-M futures.', inputSchema: { type: 'object', properties: prop('symbol', 'side', 'positionSide', 'type', 'quantity', 'price', 'stopPrice', 'closePosition', 'reduceOnly', 'timeInForce', 'workingType', 'newClientOrderId'), required: ['symbol', 'side', 'type'] } },
  { name: 'futures_um_cancel_order', description: 'Cancel an active order.', inputSchema: { type: 'object', properties: prop('symbol', 'orderId', 'origClientOrderId'), required: ['symbol'] } },
  { name: 'futures_um_cancel_all_open_orders', description: 'Cancel all open orders on a symbol.', inputSchema: { type: 'object', properties: prop('symbol'), required: ['symbol'] } },
  { name: 'futures_um_get_order', description: 'Check an order status.', inputSchema: { type: 'object', properties: prop('symbol', 'orderId', 'origClientOrderId'), required: ['symbol'] } },
  { name: 'futures_um_account', description: 'Get current account information: balances and totals.', inputSchema: { type: 'object', properties: {} } },
  { name: 'futures_um_position_risk', description: 'Get current position information.', inputSchema: { type: 'object', properties: prop('symbol') } },
  { name: 'futures_um_open_orders', description: 'Get all open orders on a symbol.', inputSchema: { type: 'object', properties: prop('symbol') } },
  { name: 'futures_um_change_leverage', description: 'Change user initial leverage.', inputSchema: { type: 'object', properties: prop('symbol', 'leverage'), required: ['symbol', 'leverage'] } },
  { name: 'futures_um_change_margin_type', description: 'Change margin type between isolated and crossed.', inputSchema: { type: 'object', properties: prop('symbol', 'marginType'), required: ['symbol', 'marginType'] } },
  { name: 'market_mark_price', description: 'Mark price and funding rate.', inputSchema: { type: 'object', properties: prop('symbol') } },
  // distractors: a spot order tool and a withdrawal tool must never win an op.
  { name: 'spot_place_order', description: 'Send in a new spot order.', inputSchema: { type: 'object', properties: prop('symbol', 'side', 'type', 'quantity', 'price', 'newClientOrderId'), required: ['symbol', 'side', 'type'] } },
  { name: 'wallet_withdraw', description: 'Withdraw funds from the wallet.', inputSchema: { type: 'object', properties: prop('coin', 'address', 'amount'), required: ['coin', 'address', 'amount'] } },
];

const ACCOUNT_PAYLOAD = { totalWalletBalance: '10000.00', totalUnrealizedProfit: '12.50', totalMarginBalance: '10012.50', availableBalance: '9500.00' };
const POSITIONS_PAYLOAD = [
  { symbol: 'BTCUSDT', positionAmt: '0.010', entryPrice: '77000', markPrice: '78250', unRealizedProfit: '12.5', leverage: '10', positionSide: 'BOTH' },
  { symbol: 'ETHUSDT', positionAmt: '0', entryPrice: '0', markPrice: '3000', unRealizedProfit: '0', leverage: '5', positionSide: 'BOTH' },
];
const ORDERS_PAYLOAD = [{ symbol: 'BTCUSDT', clientOrderId: 'tg-sl-1', orderId: 991, type: 'STOP_MARKET', side: 'SELL', origQty: '0', price: '0', stopPrice: '75000', reduceOnly: false, closePosition: true, status: 'NEW' }];

let mcpServer: http.Server;
let mcpBase = '';
let calls: { name: string; args: Record<string, unknown> }[] = [];
/** Tool names the fake should answer with isError instead of a payload. */
let failing = new Set<string>();

function toolResult(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'futures_um_place_order': {
      const market = String(args['type'] ?? '') === 'MARKET';
      return { orderId: 5001, symbol: args['symbol'], clientOrderId: args['newClientOrderId'], status: market ? 'FILLED' : 'NEW', avgPrice: market ? '77012.30' : '0', executedQty: market ? String(args['quantity'] ?? '0') : '0' };
    }
    case 'futures_um_cancel_order':
      return { orderId: 5001, symbol: args['symbol'], origClientOrderId: args['origClientOrderId'], status: 'CANCELED' };
    case 'futures_um_cancel_all_open_orders':
      return { code: 200, msg: 'The operation of cancel all open order is done.' };
    case 'futures_um_get_order':
      return { orderId: 5001, symbol: args['symbol'], status: 'FILLED', avgPrice: '77012.30', executedQty: '0.01' };
    case 'futures_um_account':
      return ACCOUNT_PAYLOAD;
    case 'futures_um_position_risk':
      return POSITIONS_PAYLOAD;
    case 'futures_um_open_orders':
      return ORDERS_PAYLOAD;
    case 'futures_um_change_leverage':
      return { symbol: args['symbol'], leverage: args['leverage'], maxNotionalValue: '1000000' };
    case 'futures_um_change_margin_type':
      return { code: 200, msg: 'success' };
    case 'market_mark_price':
      return { symbol: args['symbol'], markPrice: '78250.10', lastFundingRate: '0.0001' };
    default:
      return { echo: name, args };
  }
}

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((r) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => r(s));
  });

beforeAll(async () => {
  // 这整份测试测的是币安专属通道(/api/binance/*、mcp 后端)。fork 默认 TG_EXCHANGE=okx 时这些路由
  // 根本不注册(docs/design/okx-atk-2026-09-20.md §5),所以这里显式切回 binance。
  process.env['TG_EXCHANGE'] = 'binance';
  mcpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/mcp') {
      res.writeHead(404);
      return res.end();
    }
    if (req.headers['authorization'] !== 'Bearer tok-live') {
      res.writeHead(401);
      return res.end();
    }
    const msg = JSON.parse(await readBody(req)) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (msg.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake-binance-agentic' }, capabilities: {} } }));
    }
    if (msg.method === 'notifications/initialized') {
      res.writeHead(202);
      return res.end();
    }
    let result: unknown = {};
    if (msg.method === 'tools/list') result = { tools: CATALOGUE };
    else if (msg.method === 'tools/call') {
      const name = String(msg.params?.name ?? '');
      const args = msg.params?.arguments ?? {};
      calls.push({ name, args });
      result = failing.has(name)
        ? { content: [{ type: 'text', text: `{"code":-2013,"msg":"Order does not exist."}` }], isError: true }
        : { content: [{ type: 'text', text: JSON.stringify(toolResult(name, args)) }], isError: false };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  await new Promise<void>((r) => mcpServer.listen(0, '127.0.0.1', r));
  mcpBase = `http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}`;
});
afterAll(() => {
  delete process.env['TG_EXCHANGE'];
  mcpServer.close();
});

beforeEach(() => {
  calls = [];
  failing = new Set();
});

const client = (token = 'tok-live'): McpHttpClient => new McpHttpClient({ url: `${mcpBase}/mcp`, token: async () => token });
const silent = (): ((l: 'info' | 'warn' | 'error', m: string, d?: unknown) => void) => () => undefined;

// ---------------------------------------------------------------- heuristics

describe('proposeToolMap', () => {
  it('maps all 13 ops onto the futures tools with confidence >= 0.6', () => {
    const map = proposeToolMap(CATALOGUE);
    expect(map.status).toBe('proposed');
    expect(map.source).toBe('heuristic');
    for (const op of MCP_OPS) {
      const m = map.ops[op];
      expect(m, `${op} 应该有候选工具`).toBeTruthy();
      expect(m!.confidence ?? 0, `${op} 置信度`).toBeGreaterThanOrEqual(0.6);
    }
    expect(map.ops.account!.tool).toBe('futures_um_account');
    expect(map.ops.positions!.tool).toBe('futures_um_position_risk');
    expect(map.ops.open_orders!.tool).toBe('futures_um_open_orders');
    expect(map.ops.place_market!.tool).toBe('futures_um_place_order');
    expect(map.ops.place_limit!.tool).toBe('futures_um_place_order');
    expect(map.ops.place_stop_market_close!.tool).toBe('futures_um_place_order');
    expect(map.ops.place_take_profit_close!.tool).toBe('futures_um_place_order');
    expect(map.ops.cancel_order!.tool).toBe('futures_um_cancel_order');
    expect(map.ops.cancel_all!.tool).toBe('futures_um_cancel_all_open_orders');
    expect(map.ops.get_order!.tool).toBe('futures_um_get_order');
    expect(map.ops.set_leverage!.tool).toBe('futures_um_change_leverage');
    expect(map.ops.set_margin_type!.tool).toBe('futures_um_change_margin_type');
    expect(map.ops.mark_price!.tool).toBe('market_mark_price');
    // The spot / withdraw distractors never win anything.
    expect(Object.values(map.ops).map((m) => m.tool)).not.toContain('spot_place_order');
    expect(Object.values(map.ops).map((m) => m.tool)).not.toContain('wallet_withdraw');
  });

  it('builds order type / trigger / close-position literals per op and never invents a parameter', () => {
    const map = proposeToolMap(CATALOGUE);
    expect(map.ops.place_market!.args).toMatchObject({ symbol: '${symbol}', side: '${side}', type: 'MARKET', quantity: '${qty}', newClientOrderId: '${clientOrderId}', reduceOnly: '${reduceOnly}' });
    expect(map.ops.place_market!.args).not.toHaveProperty('price');
    expect(map.ops.place_limit!.args).toMatchObject({ type: 'LIMIT', price: '${price}', timeInForce: 'GTC' });
    expect(map.ops.place_stop_market_close!.args).toMatchObject({ type: 'STOP_MARKET', stopPrice: '${stopPrice}', closePosition: '${closePosition}', workingType: 'MARK_PRICE' });
    expect(map.ops.place_stop_market_close!.args).not.toHaveProperty('quantity');
    expect(map.ops.place_stop_market_close!.args).not.toHaveProperty('reduceOnly');
    expect(map.ops.place_take_profit_close!.args).toMatchObject({ type: 'TAKE_PROFIT_MARKET' });
    expect(map.ops.cancel_order!.args).toEqual({ symbol: '${symbol}', origClientOrderId: '${clientOrderId}' });
    expect(map.ops.set_margin_type!.args).toEqual({ symbol: '${symbol}', marginType: '${marginMode}' });
    // account/positions/open_orders take no symbol: the account view needs every row.
    expect(map.ops.account!.args).toEqual({});
    expect(map.ops.positions!.args).toEqual({});
    expect(map.ops.open_orders!.args).toEqual({});
    expect(map.ops.place_market!.missing ?? []).toEqual([]);
  });

  it('leaves an op unmapped (and says so) rather than guessing when nothing fits', () => {
    const map = proposeToolMap(CATALOGUE.filter((t) => t.name !== 'market_mark_price' && t.name !== 'futures_um_change_leverage'));
    expect(map.ops.mark_price).toBeUndefined();
    expect(map.ops.set_leverage).toBeUndefined();
    expect(map.notes.join(' ')).toMatch(/set_leverage/);
    expect(map.notes.join(' ')).toMatch(/mark_price/);
  });

  it('mapReviewPrompt carries the catalogue and the proposal', () => {
    const p = mapReviewPrompt(CATALOGUE, proposeToolMap(CATALOGUE));
    expect(p).toMatch(/futures_um_place_order/);
    expect(p).toMatch(/place_stop_market_close/);
    expect(p).toMatch(/symbol\*/); // required params are starred
  });
});

describe('templates and result paths', () => {
  it('injects typed values, interpolates, and drops keys with no value', () => {
    const out = renderArgs({ symbol: '${symbol}', leverage: '${leverage}', reduceOnly: '${reduceOnly}', tag: 'gate-${symbol}', price: '${price}', type: 'MARKET', dead: null }, { symbol: 'BTCUSDT', leverage: 10, reduceOnly: false });
    expect(out).toEqual({ symbol: 'BTCUSDT', leverage: 10, reduceOnly: false, tag: 'gate-BTCUSDT', type: 'MARKET' });
  });
  it('rejects an unknown placeholder', () => {
    expect(() => renderArgs({ x: '${nope}' }, {})).toThrow(/未知占位符/);
  });
  it('extractPath walks a path and falls back to a fuzzy key search', () => {
    expect(extractPath({ data: { orderId: 7 } }, 'data.orderId')).toBe(7);
    expect(extractPath({ data: { order_id: 7 } }, 'orderId')).toBe(7);
    expect(extractPath({ data: { orders: [{ orderId: 9 }] } }, 'data.orders.0.orderId')).toBe(9);
    expect(extractPath({ a: 1 }, 'nothing')).toBeUndefined();
  });
});

describe('validateToolMap / loadToolMap', () => {
  it('accepts a hand-written map and defaults it to proposed', () => {
    const { map, errors } = validateToolMap({ ops: { place_market: { tool: 't', args: { symbol: '${symbol}' }, result: { order_id: 'data.orderId' } } } });
    expect(errors).toEqual([]);
    expect(map!.status).toBe('proposed');
    expect(map!.source).toBe('manual');
    expect(map!.ops.place_market!.result!.order_id).toBe('data.orderId');
  });
  it('rejects unknown ops, bad arg types, unknown placeholders and bad result keys', () => {
    expect(validateToolMap({ ops: { nope: { tool: 't', args: {} } } }).errors.join()).toMatch(/未知操作/);
    expect(validateToolMap({ ops: { account: { tool: 't', args: { x: { deep: 1 } } } } }).errors.join()).toMatch(/只能是字符串/);
    expect(validateToolMap({ ops: { account: { tool: 't', args: { x: '${wat}' } } } }).errors.join()).toMatch(/未知占位符/);
    expect(validateToolMap({ ops: { account: { tool: '', args: {} } } }).errors.join()).toMatch(/tool 必填/);
    expect(validateToolMap({ ops: { account: { tool: 't', args: {}, result: { bogus: 'x' } } } }).errors.join()).toMatch(/only|order_id/i);
  });
  it('loadToolMap discards junk and a stale version', () => {
    expect(loadToolMap(null)).toBeNull();
    expect(loadToolMap('not json')).toBeNull();
    expect(loadToolMap(JSON.stringify({ version: 99, ops: {} }))).toBeNull();
    const good = JSON.stringify({ ...proposeToolMap(CATALOGUE), status: 'confirmed' });
    expect(loadToolMap(good)!.status).toBe('confirmed');
  });
});

// ---------------------------------------------------------------- the backend

const confirmed = (): McpToolMap => ({ ...proposeToolMap(CATALOGUE), status: 'confirmed' });

function backend(map: McpToolMap | null = confirmed(), opts: { requireConfirmed?: boolean } = {}): McpDirectBackend {
  return new McpDirectBackend({ client: client(), map: () => map, log: silent(), ...opts });
}

describe('McpDirectBackend', () => {
  it('refuses to start without a map, and with a map that is only proposed', async () => {
    await expect(backend(null).start()).rejects.toThrow(/还没有工具映射/);
    await expect(backend(proposeToolMap(CATALOGUE)).start()).rejects.toThrow(/还没确认/);
    await expect(backend(confirmed()).start()).resolves.toBeUndefined();
  });

  it('placeEntry(market) sends the right arguments and parses the receipt', async () => {
    const b = backend();
    await b.start();
    const r = await b.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.01', entry: 'market', limit_price: null, client_order_id: 'tg-e1' });
    expect(r.outcome).toBe('filled');
    expect(r.avg_price).toBe('77012.3');
    expect(r.error).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('futures_um_place_order');
    // -1106「参数不该传」:开仓单不带 reduceOnly / closePosition(false 也不行),MARKET 也不带 timeInForce。
    expect(calls[0]!.args).toEqual({ symbol: 'BTCUSDT', side: 'BUY', positionSide: 'BOTH', type: 'MARKET', quantity: '0.01', newClientOrderId: 'tg-e1' });
    expect(calls[0]!.args).not.toHaveProperty('reduceOnly');
    expect(calls[0]!.args).not.toHaveProperty('closePosition');
    expect(calls[0]!.args).not.toHaveProperty('timeInForce');
  });

  it('placeEntry(limit) carries price + GTC and reports submitted', async () => {
    const b = backend();
    const r = await b.placeEntry({ symbol: 'ETHUSDT', direction: 'short', qty: '0.5', entry: 'limit', limit_price: '3050.5', client_order_id: 'tg-e2' });
    expect(r.outcome).toBe('submitted');
    expect(calls[0]!.args).toMatchObject({ side: 'SELL', type: 'LIMIT', price: '3050.5', timeInForce: 'GTC', quantity: '0.5' });
  });

  it('placeStop/placeTakeProfit close the whole position: closePosition=true, no quantity, no reduceOnly', async () => {
    const b = backend();
    await b.placeStop('BTCUSDT', 'long', '75000', 'tg-sl');
    await b.placeTakeProfit('BTCUSDT', 'long', '81000', 'tg-tp');
    expect(calls[0]!.args).toEqual({ symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', type: 'STOP_MARKET', stopPrice: '75000', closePosition: true, workingType: 'MARK_PRICE', newClientOrderId: 'tg-sl' });
    expect(calls[1]!.args).toMatchObject({ type: 'TAKE_PROFIT_MARKET', stopPrice: '81000', closePosition: true });
    expect(calls[0]!.args).not.toHaveProperty('quantity');
    expect(calls[0]!.args).not.toHaveProperty('reduceOnly');
  });

  it('account() normalizes the three payloads and caches for the TTL', async () => {
    const b = new McpDirectBackend({ client: client(), map: () => confirmed(), log: silent(), accountTtlMs: 60_000 });
    const a = await b.account();
    expect(a.backend).toBe('mcp');
    expect(a.equity).toBe('10012.50');
    expect(a.available).toBe('9500.00');
    expect(a.unrealized_pnl).toBe('12.50');
    expect(a.positions).toEqual([{ market: 'perp', symbol: 'BTCUSDT', side: 'long', qty: '0.01', entry_price: '77000', mark_price: '78250', unrealized_pnl: '12.50', leverage: 10 }]);
    expect(a.open_orders).toEqual([{ market: 'perp', symbol: 'BTCUSDT', client_order_id: 'tg-sl-1', type: 'STOP_MARKET', side: 'SELL', qty: '0', price: null, stop_price: '75000', reduce_only: true, status: 'NEW' }]);
    const before = calls.length;
    await b.account();
    expect(calls.length).toBe(before); // served from cache
    b.invalidateAccount();
    await b.account();
    expect(calls.length).toBeGreaterThan(before);
  });

  it('closePosition reads the position first, then sends a reduce-only market order', async () => {
    const b = backend();
    const r = await b.closePosition('BTCUSDT', 'tg-close');
    expect(r.closed).toBe(true);
    const order = calls.find((c) => c.name === 'futures_um_place_order')!;
    expect(order.args).toEqual({ symbol: 'BTCUSDT', side: 'SELL', positionSide: 'BOTH', type: 'MARKET', quantity: '0.01', reduceOnly: true, newClientOrderId: 'tg-close' });
  });

  it('closePosition on a flat symbol is a no-op, not a failure', async () => {
    const b = backend();
    const r = await b.closePosition('SOLUSDT', 'tg-close-2');
    expect(r.closed).toBe(true);
    expect(calls.some((c) => c.name === 'futures_um_place_order')).toBe(false);
  });

  it('cancelOrder / setLeverage / setMarginType go through their own tools', async () => {
    const b = backend();
    expect(await b.cancelOrder('BTCUSDT', 'tg-sl-1')).toEqual({ ok: true, error: null });
    expect(await b.setLeverage('BTCUSDT', 10)).toEqual({ ok: true, error: null });
    expect(await b.setMarginType('BTCUSDT', 'isolated')).toEqual({ ok: true, error: null });
    expect(calls.map((c) => c.name)).toEqual(['futures_um_cancel_order', 'futures_um_change_leverage', 'futures_um_change_margin_type']);
    expect(calls[0]!.args).toEqual({ symbol: 'BTCUSDT', origClientOrderId: 'tg-sl-1' });
    expect(calls[1]!.args).toEqual({ symbol: 'BTCUSDT', leverage: 10 });
    expect(calls[2]!.args).toEqual({ symbol: 'BTCUSDT', marginType: 'ISOLATED' });
  });

  it('getOrder parses the status and turns "order does not exist" into null', async () => {
    const b = backend();
    const view = await b.getOrder('BTCUSDT', 'tg-e1');
    expect(view).toEqual({ status: 'FILLED', avg_price: '77012.3', executed_qty: '0.01', raw: expect.anything() });
    failing.add('futures_um_get_order');
    expect(await b.getOrder('BTCUSDT', 'gone-1')).toBeNull();
  });

  it('an unmapped op fails closed and never guesses a tool', async () => {
    const map = confirmed();
    delete map.ops.cancel_all;
    delete map.ops.place_limit;
    const b = backend(map);
    const cancel = await b.cancelAll('BTCUSDT');
    expect(cancel.ok).toBe(false);
    expect(cancel.error).toMatch(/该操作未映射/);
    const limit = await b.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.01', entry: 'limit', limit_price: '70000', client_order_id: 'tg-x' });
    expect(limit.outcome).toBe('failed');
    expect(limit.error).toMatch(/该操作未映射/);
    expect(calls).toHaveLength(0); // nothing was sent
  });

  it('a rejected tool call is failed (definitive), a transport failure is unknown (may have landed)', async () => {
    failing.add('futures_um_place_order');
    const rejected = await backend().placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.01', entry: 'market', limit_price: null, client_order_id: 'tg-r' });
    expect(rejected.outcome).toBe('failed');
    const offline = new McpDirectBackend({ client: new McpHttpClient({ url: 'http://127.0.0.1:1/mcp', token: async () => 'tok-live', timeoutMs: 500 }), map: () => confirmed(), log: silent() });
    const lost = await offline.placeEntry({ symbol: 'BTCUSDT', direction: 'long', qty: '0.01', entry: 'market', limit_price: null, client_order_id: 'tg-u' });
    expect(lost.outcome).toBe('unknown');
  });

  it('markPrice uses the mapped tool, and readTest only touches the read ops', async () => {
    const b = backend();
    expect(await b.markPrice('BTCUSDT')).toBe('78250.1');
    calls = [];
    const rows = await b.readTest('BTCUSDT');
    expect(rows.map((r) => r.op)).toEqual(['account', 'positions', 'open_orders', 'mark_price']);
    expect(rows.every((r) => r.ok)).toBe(true);
    expect(rows[0]!.sample).toMatch(/totalWalletBalance/);
    expect(calls.map((c) => c.name)).toEqual(['futures_um_account', 'futures_um_position_risk', 'futures_um_open_orders', 'market_mark_price']);
  });
});

describe('mcpAvailability', () => {
  it('explains every reason the mcp option is not selectable', () => {
    // 没有自己的 token(不管配没配 client id)= 3346001 那堵墙,一律指回 agent_mcp
    expect(mcpAvailability({ configured: false, connected: false, map: null }).note).toMatch(/3346001/);
    expect(mcpAvailability({ configured: true, connected: false, map: null }).note).toMatch(/3346001/);
    expect(mcpAvailability({ configured: true, connected: true, map: null }).note).toMatch(/还没有工具映射/);
    expect(mcpAvailability({ configured: true, connected: true, map: proposeToolMap(CATALOGUE) })).toMatchObject({ available: false });
    expect(mcpAvailability({ configured: true, connected: true, map: confirmed() }).available).toBe(true);
  });
});

// ---------------------------------------------------------------- HTTP round-trip

let fakeMarket: FakeMarketServer;
let DemoRuntime: typeof import('../../src/demo/runtime.js').DemoRuntime;
let createServer: typeof import('../../src/demo/http.js').createServer;

let activeHttp: http.Server | null = null;
let activeRt: InstanceType<typeof DemoRuntime> | null = null;
let activeState: StateDb | null = null;
let baseUrl = '';

async function setup(): Promise<{ store: DemoStore }> {
  const state = openStateDb(':memory:');
  const store = new DemoStore(state);
  const token: StoredToken = { access_token: 'tok-live', token_type: 'Bearer', scope: null, refresh_token: null, obtained_at: Date.now(), expires_at: Date.now() + 3_600_000 };
  store.kvSet(TOKEN_KV_KEY, JSON.stringify(token));
  const oauth = new BinanceOAuth({ clientId: 'https://h/c.json', redirectUri: 'http://127.0.0.1:1/cb', resource: `${mcpBase}/mcp`, issuer: mcpBase, kv: { get: (k) => store.kvGet(k), set: (k, v) => store.kvSet(k, v) } });
  const rt = new DemoRuntime({ store, backend: new PaperBackend(10_000), brains: { stub: stubBrain() }, marketPollMs: 600_000, accountPollMs: 600_000 });
  await rt.start();
  rt.setWorkflow({ brain: 'stub', cheap_brain: 'stub', watchlist: ['BTCUSDT'] });
  const server = createServer(rt, store, { oauth });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  activeHttp = server;
  activeRt = rt;
  activeState = state;
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { store };
}

const get = (p: string) => fetch(`${baseUrl}${p}`);
const send = (method: string, p: string, body?: unknown) => fetch(`${baseUrl}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

describe('/api/binance/map routes', () => {
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

  it('propose → edit → confirm → read-only test', async () => {
    const { store } = await setup();

    // 1. nothing yet
    const empty = (await (await get('/api/binance/map')).json()) as { map: unknown; tools_count: number; ops: string[]; placeholders: string[] };
    expect(empty.map).toBeNull();
    expect(empty.tools_count).toBe(0);
    expect(empty.ops).toEqual([...MCP_OPS]);
    expect(empty.placeholders).toContain('stopPrice');

    // 2. propose: pulls tools/list and stores both the catalogue and the proposal
    const proposed = (await (await send('POST', '/api/binance/map/propose')).json()) as { map: McpToolMap; tools_count: number; refreshed: boolean; review_prompt: string };
    expect(proposed.refreshed).toBe(true);
    expect(proposed.tools_count).toBe(CATALOGUE.length);
    expect(proposed.map.status).toBe('proposed');
    expect(proposed.map.ops.place_market!.tool).toBe('futures_um_place_order');
    expect(proposed.review_prompt).toMatch(/futures_um_account/);
    expect(loadToolMap(store.kvGet(MCP_MAP_KV_KEY))!.status).toBe('proposed');

    // 3. confirming refuses while a required op is missing
    const holed = structuredClone(proposed.map);
    delete holed.ops.cancel_all;
    expect((await send('PUT', '/api/binance/map', holed)).status).toBe(200);
    const refused = await send('POST', '/api/binance/map/confirm');
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(/cancel_all/);

    // 4. a bad edit is rejected with reasons, and does not overwrite what is stored
    const bad = await send('PUT', '/api/binance/map', { ops: { account: { tool: 'x', args: { a: '${nope}' } } } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { errors: string[] }).errors.join()).toMatch(/未知占位符/);

    // 5. a good edit lands as `proposed` even though the body said nothing about status
    const edited = structuredClone(proposed.map);
    edited.ops.place_market!.args['newClientOrderId'] = '${clientOrderId}';
    edited.ops.place_market!.args['positionSide'] = 'BOTH';
    const put = (await (await send('PUT', '/api/binance/map', { map: edited })).json()) as { map: McpToolMap };
    expect(put.map.status).toBe('proposed');
    expect(put.map.source).toBe('manual');
    expect(put.map.ops.place_market!.args['positionSide']).toBe('BOTH');

    // 6. read-only test: exactly the four read ops, nothing written
    calls = [];
    const tested = (await (await send('POST', '/api/binance/map/test', { symbol: 'BTCUSDT' })).json()) as { symbol: string; ok_count: number; total: number; results: { op: string; ok: boolean }[] };
    expect(tested.symbol).toBe('BTCUSDT');
    expect(tested.total).toBe(4);
    expect(tested.ok_count).toBe(4);
    expect(calls.every((c) => ['futures_um_account', 'futures_um_position_risk', 'futures_um_open_orders', 'market_mark_price'].includes(c.name))).toBe(true);

    // 7. confirm
    const confirmedRes = (await (await send('POST', '/api/binance/map/confirm')).json()) as { map: McpToolMap; unmapped_required: string[] };
    expect(confirmedRes.map.status).toBe('confirmed');
    expect(confirmedRes.unmapped_required).toEqual([]);
    expect(loadToolMap(store.kvGet(MCP_MAP_KV_KEY))!.status).toBe('confirmed');

    // 8. re-running propose after a confirm hands back a fresh proposal (the human confirms again)
    const again = (await (await send('POST', '/api/binance/map/propose')).json()) as { map: McpToolMap };
    expect(again.map.status).toBe('proposed');
  });

  it('GET /api/binance/tools keeps a confirmed map instead of clobbering it', async () => {
    await setup();
    await send('POST', '/api/binance/map/propose');
    await send('POST', '/api/binance/map/confirm');
    const tools = (await (await get('/api/binance/tools')).json()) as { count: number; map_kept: boolean; map: McpToolMap };
    expect(tools.count).toBe(CATALOGUE.length);
    expect(tools.map_kept).toBe(true);
    expect(tools.map.status).toBe('confirmed');
  });

  it('map/test and map/confirm refuse politely when there is no map at all', async () => {
    await setup();
    expect((await send('POST', '/api/binance/map/test')).status).toBe(409);
    expect((await send('POST', '/api/binance/map/confirm')).status).toBe(409);
  });
});
