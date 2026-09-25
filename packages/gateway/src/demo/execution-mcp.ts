import type { Market } from './types.js';
/**
 * `mcp` backend: the gateway talks to Binance's Agentic MCP server ITSELF — OAuth token from
 * binance-oauth.ts, JSON-RPC from mcp-client.ts, and a declarative tool map (mcp-map.ts) saying which
 * tool + arguments each operation is. **No model anywhere**: one order = one HTTP request, so it is
 * free, fast (sub-second) and the receipt is the exchange's own JSON — the opposite trade-off from its
 * sibling `agent_mcp`, where every write costs one CLI run (execution-agent.ts).
 *
 * Fail-closed by construction:
 *   * the map must be `confirmed` by a human, or start() refuses (a `proposed` map never trades);
 *   * an operation with no mapping returns outcome 'failed' with 「该操作未映射」 — it NEVER guesses a
 *     tool name or a parameter;
 *   * a call that may have reached the exchange (network error / timeout / HTTP error) is 'unknown',
 *     never 'failed' — the runtime's reconciliation picks those up.
 *
 * Reads are cheap here (plain HTTP), so account() is cached only 10 s and getOrder() 5 s, mostly to keep
 * one poll from fanning out into three identical calls. markPrice / symbols / symbolRules stay on the
 * public REST endpoints (market.ts) — no token needed, no rate-limit weight on the account.
 */

import type { AccountView, Backend, Direction, OpenOrderView, PositionView, SymbolInfo } from './types.js';
import type { SymbolRules } from './gates.js';
import type { EntryRequest, ExecBackend, OrderReceipt, OrderStatusView, PaperEvent } from './execution.js';
import { fetchExchangeInfo, fetchPremiumIndex } from './market.js';
import { McpAuthError, McpRpcError, type McpHttpClient, type McpToolResult } from './mcp-client.js';
import { extractPath, renderArgs, TemplateError, type McpOp, type McpOpMapping, type McpToolMap, type PlaceholderCtx } from './mcp-map.js';

export const UNMAPPED = '该操作未映射';

export interface McpDirectOptions {
  client: McpHttpClient;
  /** Read fresh every call so confirming/editing the map in the UI takes effect without a restart. */
  map: () => McpToolMap | null;
  log: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /** account() cache, default TG_BINANCE_MCP_ACCOUNT_TTL_MS or 10 s. */
  accountTtlMs?: number;
  /** getOrder() cache per client_order_id, default 5 s. */
  orderTtlMs?: number;
  /** Hedge mode: send positionSide LONG/SHORT instead of BOTH (TG_BINANCE_MCP_HEDGE=1). */
  hedge?: boolean;
  /** Tests / the read-only map test run without the human's confirmation. Never true in main.ts. */
  requireConfirmed?: boolean;
}

export interface ReadTestRow {
  op: McpOp;
  tool: string | null;
  ok: boolean;
  ms: number;
  args: Record<string, unknown> | null;
  /** A truncated JSON preview of what came back, so a human can see the field names. */
  sample: string | null;
  error: string | null;
}

const num = (payload: unknown, names: string[]): number | null => {
  for (const n of names) {
    const v = extractPath(payload, n);
    if (v === undefined || v === null || v === '') continue;
    const x = Number(v);
    if (Number.isFinite(x)) return x;
  }
  return null;
};
const str = (payload: unknown, names: string[]): string | null => {
  for (const n of names) {
    const v = extractPath(payload, n);
    if (v === undefined || v === null || v === '') continue;
    return String(v);
  }
  return null;
};
const normKey = (s: string): string => s.toLowerCase().replace(/[_\-\s]/g, '');

/** The first array in `payload` whose elements look like the rows we want (BFS, depth-limited). */
function findRows(payload: unknown, hints: string[], root?: string): Record<string, unknown>[] {
  const start = root ? (extractPath(payload, root) ?? payload) : payload;
  const want = hints.map(normKey);
  const looksRight = (arr: unknown[]): boolean => {
    const first = arr.find((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (!first) return false;
    const keys = Object.keys(first as Record<string, unknown>).map(normKey);
    return want.some((w) => keys.includes(w));
  };
  const queue: unknown[] = [start];
  let steps = 0;
  while (queue.length && steps < 200) {
    const cur = queue.shift();
    steps++;
    if (Array.isArray(cur)) {
      if (looksRight(cur)) return cur.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x));
      continue;
    }
    if (!cur || typeof cur !== 'object') continue;
    for (const v of Object.values(cur as Record<string, unknown>)) if (v && typeof v === 'object') queue.push(v);
  }
  return [];
}

const POSITION_HINTS = ['positionAmt', 'positionAmount', 'entryPrice', 'positionSide', 'unRealizedProfit'];
const ORDER_HINTS = ['clientOrderId', 'orderId', 'origQty', 'stopPrice'];

export class McpDirectBackend implements ExecBackend {
  marketsSupported(): Market[] { return ['perp']; }
  readonly kind: Backend = 'mcp';
  private readonly client: McpHttpClient;
  private readonly accountTtlMs: number;
  private readonly orderTtlMs: number;
  private readonly hedge: boolean;
  private readonly requireConfirmed: boolean;
  private accountCache: { at: number; view: AccountView } | null = null;
  private accountInFlight: Promise<AccountView> | null = null;
  private orderCache = new Map<string, { at: number; view: OrderStatusView | null }>();
  private rulesCache = new Map<string, SymbolRules>();
  private symbolsCache: SymbolInfo[] | null = null;
  private symbolsFetchedAt = 0;
  private calls = 0;

  constructor(private readonly opts: McpDirectOptions) {
    this.client = opts.client;
    this.accountTtlMs = opts.accountTtlMs ?? Number(process.env['TG_BINANCE_MCP_ACCOUNT_TTL_MS'] ?? '10000');
    this.orderTtlMs = opts.orderTtlMs ?? 5_000;
    this.hedge = opts.hedge ?? process.env['TG_BINANCE_MCP_HEDGE'] === '1';
    this.requireConfirmed = opts.requireConfirmed !== false;
  }

  /** How many MCP tool calls this backend has made since start (cost is zero, but rate limits are not). */
  get callCount(): number {
    return this.calls;
  }

  async start(): Promise<void> {
    const map = this.opts.map();
    if (!map) throw new Error('币安 MCP 还没有工具映射:先完成授权(连接币安),网关会自动抓工具清单并给出映射草案,再在执行卡片里确认');
    if (this.requireConfirmed && map.status !== 'confirmed') throw new Error('币安 MCP 工具映射还没确认(当前 proposed):先在执行卡片里跑「只读测试」核对,再点「确认映射」');
    const mapped = Object.keys(map.ops).length;
    this.opts.log('info', `执行后端 mcp 就绪:直连 ${this.client.url},${mapped}/13 个操作已映射,账户缓存 ${this.accountTtlMs} ms,不经过任何模型`);
  }

  async stop(): Promise<void> {
    this.accountCache = null;
    this.orderCache.clear();
  }

  // ------------------------------------------------------------ the one tool call

  private mapping(op: McpOp): McpOpMapping | null {
    return this.opts.map()?.ops[op] ?? null;
  }

  private ctx(extra: PlaceholderCtx): PlaceholderCtx {
    return { reduceOnly: false, closePosition: false, ...extra };
  }

  private posSide(direction: Direction | null): string {
    if (!this.hedge || !direction) return 'BOTH';
    return direction === 'long' ? 'LONG' : 'SHORT';
  }

  /** One MCP tool call for `op`. Throws {@link UnmappedError} when the op has no mapping. */
  private async invoke(op: McpOp, ctx: PlaceholderCtx): Promise<{ result: McpToolResult; payload: unknown; mapping: McpOpMapping; args: Record<string, unknown> }> {
    const mapping = this.mapping(op);
    if (!mapping) throw new UnmappedError(op);
    const args = renderArgs(mapping.args, this.ctx(ctx));
    // Schema templates may contain literal false; Binance hedge-mode forbids the parameter itself.
    if ((op === 'place_market' || op === 'place_limit') && ctx['reduceOnly'] !== true) { delete args['reduceOnly']; delete args['closePosition']; }
    if (this.hedge) delete args['reduceOnly'];
    if (args['closePosition'] === true || args['closePosition'] === 'true') { delete args['quantity']; delete args['reduceOnly']; }
    this.calls++;
    const result = await this.client.callTool(mapping.tool, args);
    if (result.isError) throw new ToolError(op, mapping.tool, (result.text || '工具返回 isError').slice(0, 400));
    const payload = mapping.result?.root ? (extractPath(result.structured ?? {}, mapping.result.root) ?? result.structured) : (result.structured ?? {});
    return { result, payload, mapping, args };
  }

  /** Maps one write call onto OrderReceipt semantics; anything that may have landed becomes 'unknown'. */
  private async writeOp(op: McpOp, ctx: PlaceholderCtx): Promise<OrderReceipt> {
    if (!this.mapping(op)) return { outcome: 'failed', receipt: null, avg_price: null, error: `${UNMAPPED}:${op}` };
    this.invalidateAccount();
    try {
      const { result, payload, mapping } = await this.invoke(op, ctx);
      const status = (str(payload, [mapping.result?.status ?? 'status']) ?? '').toUpperCase();
      const avg = num(payload, [mapping.result?.avg_price ?? 'avgPrice']);
      const receipt = (result.structured ?? { text: result.text }) as unknown;
      this.opts.log('info', `mcp ${op} → ${mapping.tool}: ${status || 'ok'}`, { order_id: extractPath(payload, mapping.result?.order_id ?? 'orderId') ?? null });
      // REJECTED / EXPIRED came back from the exchange as a definitive no; everything else is at least submitted.
      if (status === 'REJECTED' || status === 'EXPIRED') return { outcome: 'failed', receipt, avg_price: null, error: `交易所回执状态 ${status}` };
      return { outcome: status === 'FILLED' ? 'filled' : 'submitted', receipt, avg_price: avg && avg > 0 ? String(avg) : null, error: null };
    } catch (e) {
      return this.writeError(op, e);
    }
  }

  /** Classifies a thrown error: nothing-was-sent → 'failed'; the exchange answered no → 'failed'; else 'unknown'. */
  private writeError(op: McpOp, e: unknown): OrderReceipt {
    const message = (e as Error).message;
    if (e instanceof UnmappedError) return { outcome: 'failed', receipt: null, avg_price: null, error: message };
    if (e instanceof TemplateError) return { outcome: 'failed', receipt: null, avg_price: null, error: `${op} 参数模板有问题:${message}` };
    // No token / expired token: the request never left the gateway.
    if (e instanceof McpAuthError) return { outcome: 'failed', receipt: null, avg_price: null, error: message };
    // The server processed the call and answered with an error (JSON-RPC error / isError content).
    if (e instanceof McpRpcError || e instanceof ToolError) {
      this.opts.log('warn', `mcp ${op} 被拒绝:${message}`);
      return { outcome: 'failed', receipt: { error: message }, avg_price: null, error: message };
    }
    this.opts.log('warn', `mcp ${op} 结果不明(可能已到交易所):${message}`);
    return { outcome: 'unknown', receipt: null, avg_price: null, error: message };
  }

  private okFrom(r: OrderReceipt): { ok: boolean; error: string | null } {
    return { ok: r.outcome === 'filled' || r.outcome === 'submitted', error: r.error ?? (r.outcome === 'unknown' ? '结果不明' : null) };
  }

  // ------------------------------------------------------------ write ops

  placeEntry(req: EntryRequest): Promise<OrderReceipt> {
    if (req.market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    const ctx: PlaceholderCtx = {
      symbol: req.symbol,
      side: req.direction === 'long' ? 'BUY' : 'SELL',
      positionSide: this.posSide(req.direction),
      qty: req.qty,
      clientOrderId: req.client_order_id,
      reduceOnly: false,
    };
    if (req.entry === 'market') return this.writeOp('place_market', ctx);
    return this.writeOp('place_limit', { ...ctx, price: req.limit_price });
  }

  placeStop(symbol: string, position: Direction, stop_price: string, client_order_id: string, market: Market = 'perp'): Promise<OrderReceipt> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    return this.writeOp('place_stop_market_close', this.protectiveCtx(symbol, position, stop_price, client_order_id));
  }

  placeTakeProfit(symbol: string, position: Direction, tp_price: string, client_order_id: string, market: Market = 'perp'): Promise<OrderReceipt> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    return this.writeOp('place_take_profit_close', this.protectiveCtx(symbol, position, tp_price, client_order_id));
  }

  /** Protective orders close the whole position: closePosition=true and NO quantity (Binance rejects both). */
  private protectiveCtx(symbol: string, position: Direction, trigger: string, id: string): PlaceholderCtx {
    return {
      symbol,
      side: position === 'long' ? 'SELL' : 'BUY',
      positionSide: this.posSide(position),
      stopPrice: trigger,
      clientOrderId: id,
      closePosition: true,
      // reduceOnly must NOT travel with closePosition=true; leaving it undefined drops the key.
      reduceOnly: undefined,
      qty: undefined,
    };
  }

  async closePosition(symbol: string, client_order_id: string, market: Market = 'perp'): Promise<{ closed: boolean; receipt: unknown; error: string | null }> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    let position: PositionView | undefined;
    try {
      position = (await this.account()).positions.find((p) => p.symbol === symbol);
    } catch (e) {
      return { closed: false, receipt: null, error: `读取持仓失败:${(e as Error).message}` };
    }
    if (!position) return { closed: true, receipt: { note: 'no position' }, error: null };
    const r = await this.writeOp('place_market', {
      symbol,
      side: position.side === 'long' ? 'SELL' : 'BUY',
      positionSide: this.posSide(position.side),
      qty: position.qty,
      clientOrderId: client_order_id,
      reduceOnly: true,
    });
    if (r.outcome === 'filled' || r.outcome === 'submitted') return { closed: true, receipt: r.receipt, error: null };
    return { closed: false, receipt: r.receipt, error: r.error ?? `平仓结果 ${r.outcome}` };
  }

  async reducePosition(symbol: string, qty: string, client_order_id: string, market: Market = 'perp'): Promise<OrderReceipt> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    const position = (await this.account()).positions.find((p) => p.symbol === symbol);
    if (!position) return { outcome: 'failed', receipt: null, avg_price: null, error: 'no position' };
    return this.writeOp('place_market', {
      symbol,
      side: position.side === 'long' ? 'SELL' : 'BUY',
      positionSide: this.posSide(position.side),
      qty,
      clientOrderId: client_order_id,
      reduceOnly: true,
    });
  }

  async cancelAll(symbol: string, market: Market = 'perp'): Promise<{ ok: boolean; error: string | null }> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    return this.okFrom(await this.writeOp('cancel_all', { symbol }));
  }

  async cancelOrder(symbol: string, client_order_id: string, market: Market = 'perp'): Promise<{ ok: boolean; error: string | null }> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    const r = await this.writeOp('cancel_order', { symbol, clientOrderId: client_order_id });
    this.orderCache.delete(client_order_id);
    return this.okFrom(r);
  }

  async setLeverage(symbol: string, leverage: number): Promise<{ ok: boolean; error: string | null }> {
    return this.okFrom(await this.writeOp('set_leverage', { symbol, leverage }));
  }

  async setMarginType(symbol: string, mode: 'cross' | 'isolated'): Promise<{ ok: boolean; error: string | null }> {
    return this.okFrom(await this.writeOp('set_margin_type', { symbol, marginMode: mode === 'cross' ? 'CROSSED' : 'ISOLATED' }));
  }

  // ------------------------------------------------------------ read ops

  /** Public REST — no token, no map entry needed; the mapped tool wins when there is one. */
  async markPrice(symbol: string, market: Market = 'perp'): Promise<string> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    if (this.mapping('mark_price')) {
      try {
        const { payload, mapping } = await this.invoke('mark_price', { symbol });
        const v = num(payload, [mapping.result?.avg_price ?? 'markPrice', 'markPrice', 'price', 'indexPrice']);
        if (v && v > 0) return String(v);
      } catch (e) {
        this.opts.log('warn', `mcp mark_price 失败,回退公开 REST:${(e as Error).message}`);
      }
    }
    const pi = await fetchPremiumIndex(symbol);
    return Number(pi.markPrice).toString();
  }

  /** Public REST — same shape as the other backends. */
  async symbols(market: Market = 'perp'): Promise<SymbolInfo[]> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    if (this.symbolsCache && Date.now() - this.symbolsFetchedAt < 10 * 60_000) return this.symbolsCache;
    const rows = await fetchExchangeInfo();
    if (rows.length) {
      this.symbolsCache = rows;
      this.symbolsFetchedAt = Date.now();
      for (const r of rows) this.rulesCache.set(r.symbol, { step_size: r.step_size, tick_size: r.tick_size, min_qty: r.min_qty, min_notional: r.min_notional });
    }
    return this.symbolsCache ?? [];
  }

  async symbolRules(symbol: string, market: Market = 'perp'): Promise<SymbolRules> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    const cached = this.rulesCache.get(symbol);
    if (cached) return cached;
    await this.symbols();
    return this.rulesCache.get(symbol) ?? { step_size: '0.001', tick_size: '0.1', min_qty: '0.001', min_notional: '5' };
  }

  invalidateAccount(): void {
    this.accountCache = null;
  }

  account(): Promise<AccountView> {
    const cached = this.accountCache;
    if (cached && Date.now() - cached.at < this.accountTtlMs) return Promise.resolve(cached.view);
    if (this.accountInFlight) return this.accountInFlight;
    this.accountInFlight = this.accountInner().finally(() => {
      this.accountInFlight = null;
    });
    return this.accountInFlight;
  }

  private async accountInner(): Promise<AccountView> {
    if (!this.mapping('account')) throw new Error(`${UNMAPPED}:account`);
    const [acct, pos, ord] = await Promise.all([
      this.invoke('account', {}),
      this.mapping('positions') ? this.invoke('positions', {}).catch((e: unknown) => e as Error) : null,
      this.mapping('open_orders') ? this.invoke('open_orders', {}).catch((e: unknown) => e as Error) : null,
    ]);
    const posPayload = pos && !(pos instanceof Error) ? pos.payload : acct.payload;
    const ordPayload = ord && !(ord instanceof Error) ? ord.payload : acct.payload;
    if (pos instanceof Error) this.opts.log('warn', `mcp positions 读取失败,回退账户返回里的持仓:${pos.message}`);
    if (ord instanceof Error) this.opts.log('warn', `mcp open_orders 读取失败,回退账户返回里的挂单:${ord.message}`);

    const positions = this.toPositions(posPayload, pos && !(pos instanceof Error) ? pos.mapping : undefined);
    const open_orders = this.toOrders(ordPayload, ord && !(ord instanceof Error) ? ord.mapping : undefined);
    const upnlFromRows = positions.reduce((s, p) => s + Number(p.unrealized_pnl), 0);
    const upnl = num(acct.payload, ['totalUnrealizedProfit', 'totalUnrealizedPnl', 'unrealizedProfit', 'totalCrossUnPnl']) ?? upnlFromRows;
    const wallet = num(acct.payload, ['totalWalletBalance', 'walletBalance', 'totalBalance', 'balance']);
    const marginBalance = num(acct.payload, ['totalMarginBalance', 'marginBalance', 'equity', 'totalEquity']);
    const equity = marginBalance ?? (wallet === null ? 0 : wallet + upnl);
    const available = num(acct.payload, ['availableBalance', 'available', 'maxWithdrawAmount', 'free']) ?? equity;
    const view: AccountView = {
      backend: this.kind,
      equity: equity.toFixed(2),
      available: available.toFixed(2),
      unrealized_pnl: upnl.toFixed(2),
      positions,
      open_orders,
      as_of: Date.now(),
    };
    this.accountCache = { at: Date.now(), view };
    return view;
  }

  private toPositions(payload: unknown, mapping?: McpOpMapping): PositionView[] {
    const out: PositionView[] = [];
    for (const p of findRows(payload, POSITION_HINTS, mapping?.result?.root)) {
      const symbol = str(p, ['symbol', 'pair', 'instrument']) ?? '';
      const amt = num(p, ['positionAmt', 'positionAmount', 'positionQty', 'qty', 'quantity', 'size']);
      if (!symbol || amt === null || amt === 0) continue;
      const declared = (str(p, ['positionSide', 'side', 'direction']) ?? '').toUpperCase();
      const side: Direction = declared === 'SHORT' || declared === 'SELL' ? 'short' : declared === 'LONG' || declared === 'BUY' ? 'long' : amt > 0 ? 'long' : 'short';
      out.push({
        market: 'perp', symbol,
        side,
        qty: Math.abs(amt).toString(),
        entry_price: (num(p, ['entryPrice', 'avgEntryPrice', 'avgPrice', 'openPrice']) ?? 0).toString(),
        mark_price: (num(p, ['markPrice', 'lastPrice', 'price']) ?? 0).toString(),
        unrealized_pnl: (num(p, ['unRealizedProfit', 'unrealizedProfit', 'unrealizedPnl', 'pnl']) ?? 0).toFixed(2),
        leverage: num(p, ['leverage']) ?? 0,
      });
    }
    return out;
  }

  private toOrders(payload: unknown, mapping?: McpOpMapping): OpenOrderView[] {
    const out: OpenOrderView[] = [];
    for (const o of findRows(payload, ORDER_HINTS, mapping?.result?.root)) {
      const symbol = str(o, ['symbol', 'pair', 'instrument']) ?? '';
      if (!symbol) continue;
      const price = num(o, ['price', 'limitPrice']);
      const stop = num(o, ['stopPrice', 'triggerPrice', 'activationPrice']);
      out.push({
        market: 'perp', symbol,
        client_order_id: str(o, ['clientOrderId', 'newClientOrderId', 'origClientOrderId', 'orderId']) ?? '',
        type: str(o, ['type', 'orderType']) ?? '',
        side: str(o, ['side']) ?? '',
        qty: (num(o, ['origQty', 'quantity', 'qty', 'size']) ?? 0).toString(),
        price: price && price > 0 ? String(price) : null,
        stop_price: stop && stop > 0 ? String(stop) : null,
        reduce_only: Boolean(extractPath(o, 'reduceOnly')) || Boolean(extractPath(o, 'closePosition')),
        status: str(o, ['status', 'orderStatus']) ?? 'NEW',
      });
    }
    return out;
  }

  async getOrder(symbol: string, client_order_id: string, fresh = false, market: Market = 'perp'): Promise<OrderStatusView | null> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    const hit = this.orderCache.get(client_order_id);
    if (!fresh && hit && Date.now() - hit.at < this.orderTtlMs) return hit.view;
    if (!this.mapping('get_order')) throw new Error(`${UNMAPPED}:get_order`);
    let payload: unknown;
    let mapping: McpOpMapping;
    try {
      const r = await this.invoke('get_order', { symbol, clientOrderId: client_order_id });
      payload = r.payload;
      mapping = r.mapping;
    } catch (e) {
      // "Order does not exist" (-2013) is an answer, not a failure: the order is simply gone.
      if ((e instanceof ToolError || e instanceof McpRpcError) && /-2013|does not exist|not found|unknown order/i.test((e as Error).message)) {
        this.orderCache.set(client_order_id, { at: Date.now(), view: null });
        return null;
      }
      throw e;
    }
    const status = str(payload, [mapping.result?.status ?? 'status', 'status']);
    if (!status) {
      this.orderCache.set(client_order_id, { at: Date.now(), view: null });
      return null;
    }
    const avg = num(payload, [mapping.result?.avg_price ?? 'avgPrice', 'avgPrice', 'averagePrice']);
    const view: OrderStatusView = {
      status: status.toUpperCase(),
      avg_price: avg && avg > 0 ? String(avg) : null,
      executed_qty: str(payload, [mapping.result?.executed_qty ?? 'executedQty', 'executedQty', 'filledQty']) ?? '',
      raw: payload,
    };
    this.orderCache.set(client_order_id, { at: Date.now(), view });
    return view;
  }

  /** Not a simulator. */
  tick(): PaperEvent[] {
    return [];
  }

  // ------------------------------------------------------------ read-only map test

  /**
   * Runs ONLY the read ops through the map and reports each one — the button a human presses before
   * confirming. It never places, cancels or changes anything, and works on a `proposed` map.
   */
  async readTest(symbol: string): Promise<ReadTestRow[]> {
    const rows: ReadTestRow[] = [];
    for (const op of ['account', 'positions', 'open_orders', 'mark_price'] as const) {
      const mapping = this.mapping(op);
      const started = Date.now();
      if (!mapping) {
        rows.push({ op, tool: null, ok: false, ms: 0, args: null, sample: null, error: `${UNMAPPED}:${op}` });
        continue;
      }
      try {
        const { result, args } = await this.invoke(op, { symbol });
        const text = result.structured !== null && result.structured !== undefined ? JSON.stringify(result.structured) : result.text;
        rows.push({ op, tool: mapping.tool, ok: true, ms: Date.now() - started, args, sample: (text ?? '').slice(0, 600), error: null });
      } catch (e) {
        rows.push({ op, tool: mapping.tool, ok: false, ms: Date.now() - started, args: null, sample: null, error: (e as Error).message });
      }
    }
    return rows;
  }
}

export class UnmappedError extends Error {
  constructor(readonly op: McpOp) {
    super(`${UNMAPPED}:${op}`);
    this.name = 'UnmappedError';
  }
}

export class ToolError extends Error {
  constructor(
    readonly op: McpOp,
    readonly tool: string,
    detail: string,
  ) {
    super(`${tool} 执行失败:${detail}`);
    this.name = 'ToolError';
  }
}

/**
 * Why the gate-native channel is dormant (2026-09-05): Binance's consent page refuses the gateway's own
 * client with "The AI Agent you are using is not currently supported (3346001)" — client_ids are
 * whitelisted by Binance, and Claude Code is on that list while we are not. Nothing in the OAuth/CIMD
 * code is wrong; it simply cannot be used until we are whitelisted.
 */
export const BINANCE_CLIENT_REJECTED_NOTE = '币安未把网关列为受支持的 Agent(3346001),直连不可用;用 agent_mcp(Claude)';

/** Why the `mcp` option is (not) selectable in GET /api/execution — main.ts feeds this to the runtime. */
export function mcpAvailability(input: { configured: boolean; connected: boolean; map: McpToolMap | null }): { available: boolean; note: string } {
  // No token of our own = the 3346001 wall, whether or not a client id is configured.
  if (!input.configured || !input.connected) return { available: false, note: BINANCE_CLIENT_REJECTED_NOTE };
  if (!input.map) return { available: false, note: '还没有工具映射:授权成功后网关会自动抓工具清单并给出草案' };
  if (input.map.status !== 'confirmed') return { available: false, note: '工具映射还没确认:先跑「只读测试」核对,再点「确认映射」' };
  return { available: true, note: '网关直连币安官方 MCP 下单,不经过任何模型:一笔单 = 一次 HTTP,回执就是交易所原文;读账户缓存 10 秒,行情走公开 REST。' };
}
