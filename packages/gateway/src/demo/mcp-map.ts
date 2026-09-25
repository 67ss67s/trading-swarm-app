/**
 * The tool map: how the gateway's 13 execution operations are wired onto Binance's Agentic MCP tools
 * (docs/design/execution-binance-mcp-2026-09-04.md §1 A, docs/demo/v3-ui-contract.md §9.6).
 *
 * Binance does not document the tool names/schemas anywhere we can read without a token, so nothing is
 * hard-coded: after the OAuth consent the gateway runs `tools/list` and this module *proposes* a map by
 * heuristics on the tool names / descriptions / inputSchema. The proposal is never active by itself —
 * a human reviews it (or edits the JSON), runs the read-only test, and confirms; only a `confirmed` map
 * lets {@link McpDirectBackend} start. No LLM is involved anywhere in this file.
 *
 * A mapping is `{ tool, args, result }`:
 *   args   — a template object; a string value that is exactly `${placeholder}` is replaced by the typed
 *            value for this call (a number stays a number), a placeholder inside a longer string is
 *            interpolated, and a placeholder with no value for this call drops the key entirely.
 *   result — jsonpath-lite ('orderId', 'data.orderId', 'data.orders.0.orderId') telling the backend where
 *            the receipt fields live. A single-segment path also falls back to a case/underscore
 *            insensitive recursive search, so 'orderId' still finds `{"data":{"order_id":…}}`.
 */

import type { McpTool } from './mcp-client.js';

export const MCP_TOOLS_KV_KEY = 'binance.mcp.tools';
export const MCP_MAP_KV_KEY = 'binance.mcp.map';
/** Bump when the shape below changes incompatibly; an older stored map is then discarded. */
export const MCP_MAP_VERSION = 1;

export const MCP_OPS = [
  'account',
  'positions',
  'open_orders',
  'place_market',
  'place_limit',
  'place_stop_market_close',
  'place_take_profit_close',
  'cancel_order',
  'cancel_all',
  'get_order',
  'set_leverage',
  'set_margin_type',
  'mark_price',
] as const;
export type McpOp = (typeof MCP_OPS)[number];

/** Ops that only ever read; `POST /api/binance/map/test` runs exactly these and nothing else. */
export const MCP_READ_OPS: McpOp[] = ['account', 'positions', 'open_orders', 'mark_price'];
/** Ops the backend can live without: mark_price falls back to the public REST premium index. */
export const MCP_OPTIONAL_OPS: McpOp[] = ['mark_price', 'positions', 'open_orders'];

export const MCP_PLACEHOLDERS = ['symbol', 'side', 'positionSide', 'qty', 'price', 'stopPrice', 'clientOrderId', 'leverage', 'marginMode', 'reduceOnly', 'closePosition'] as const;
export type McpPlaceholder = (typeof MCP_PLACEHOLDERS)[number];

export type ArgValue = string | number | boolean | null;
export type PlaceholderCtx = Partial<Record<McpPlaceholder, ArgValue | undefined>>;

export interface McpResultPaths {
  order_id?: string;
  avg_price?: string;
  status?: string;
  executed_qty?: string;
  /** Where the payload itself lives when the tool wraps it (e.g. 'data'); optional, read ops only. */
  root?: string;
}

export interface McpOpMapping {
  tool: string;
  args: Record<string, ArgValue>;
  result?: McpResultPaths;
  /** 0..1, heuristic only; a hand-edited mapping keeps whatever it was given. */
  confidence?: number;
  /** Parameters this op needs that the tool's inputSchema does not declare — the human must look. */
  missing?: string[];
  note?: string;
}

export interface McpToolMap {
  version: number;
  /** `proposed` never executes: McpDirectBackend refuses to start until a human confirms. */
  status: 'proposed' | 'confirmed';
  source: 'heuristic' | 'manual';
  updated_at: number;
  ops: Partial<Record<McpOp, McpOpMapping>>;
  notes: string[];
}

export interface StoredCatalogue {
  at: number;
  tools: McpTool[];
}

// ---------------------------------------------------------------- templates

export class TemplateError extends Error {}

const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function resolve(name: string, ctx: PlaceholderCtx): ArgValue | undefined {
  if (!(MCP_PLACEHOLDERS as readonly string[]).includes(name)) throw new TemplateError(`未知占位符 \${${name}}(可用:${MCP_PLACEHOLDERS.join('/')})`);
  return ctx[name as McpPlaceholder];
}

/**
 * Fills an args template for one call. Keys whose placeholder has no value for this call are dropped
 * (that is how one `place_*` template serves both reduce-only and normal orders), as are literal nulls.
 */
export function renderArgs(template: Record<string, ArgValue>, ctx: PlaceholderCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(template)) {
    if (raw === null) continue;
    if (typeof raw !== 'string') {
      out[key] = raw;
      continue;
    }
    const whole = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw);
    if (whole) {
      const v = resolve(whole[1]!, ctx);
      if (v === undefined || v === null) continue;
      out[key] = v;
      continue;
    }
    if (!raw.includes('${')) {
      out[key] = raw;
      continue;
    }
    let dropped = false;
    const s = raw.replace(PLACEHOLDER_RE, (_m, name: string) => {
      const v = resolve(name, ctx);
      if (v === undefined || v === null) dropped = true;
      return v === undefined || v === null ? '' : String(v);
    });
    if (!dropped) out[key] = s;
  }
  return out;
}

// ---------------------------------------------------------------- result paths

const norm = (s: string): string => s.toLowerCase().replace(/[_\-\s]/g, '');

/** 'data.orders.0.orderId' → the value, or undefined. Exact segments only. */
function walk(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(seg);
      if (!Number.isInteger(i)) return undefined;
      cur = cur[i];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
    } else return undefined;
  }
  return cur;
}

/** Case/underscore-insensitive breadth-first search for one key name (depth-limited). */
function searchKey(value: unknown, key: string): unknown {
  const want = norm(key);
  const queue: unknown[] = [value];
  let depth = 0;
  while (queue.length && depth < 500) {
    const cur = queue.shift();
    depth++;
    if (Array.isArray(cur)) {
      for (const x of cur.slice(0, 20)) queue.push(x);
      continue;
    }
    if (!cur || typeof cur !== 'object') continue;
    for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
      if (norm(k) === want && v !== null && v !== undefined && typeof v !== 'object') return v;
    }
    for (const v of Object.values(cur as Record<string, unknown>)) if (v && typeof v === 'object') queue.push(v);
  }
  return undefined;
}

/**
 * Reads one field out of a tool result. Tries the exact path, then — for a single-segment path — a
 * tolerant recursive search, so 'orderId' also finds `{ data: { order_id: 7 } }`.
 */
export function extractPath(value: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  const exact = walk(value, path);
  if (exact !== undefined && exact !== null) return exact;
  const last = path.split('.').pop() ?? path;
  if (/^\d+$/.test(last)) return undefined;
  return searchKey(value, last);
}

// ---------------------------------------------------------------- heuristics

interface WordRule {
  any: string[];
  w: number;
  /** No match anywhere → this tool cannot serve this op at all. */
  req?: boolean;
}
interface ParamRule {
  cands: string[];
  w: number;
}
interface OpRule {
  op: McpOp;
  words: WordRule[];
  /** Substrings that disqualify a tool by NAME (descriptions cross-reference other tools too often). */
  deny: string[];
  params: ParamRule[];
  base: number;
  /** Words that mark the right market/domain on the tool name. */
  domain?: string[];
}

const FUTURES_WORDS = ['futures', 'future', 'um', 'usdm', 'usdt m', 'perp', 'perpetual', 'derivatives'];
const MARKET_WORDS = [...FUTURES_WORDS, 'market', 'ticker', 'price'];

const P = {
  symbol: ['symbol', 'pair', 'instrument', 'instrumentid', 'contract'],
  side: ['side', 'orderside', 'direction'],
  positionSide: ['positionside', 'posside'],
  type: ['type', 'ordertype'],
  qty: ['quantity', 'qty', 'amount', 'size', 'origqty', 'volume'],
  price: ['price', 'limitprice', 'orderprice'],
  stopPrice: ['stopprice', 'triggerprice', 'activationprice', 'stoppx'],
  timeInForce: ['timeinforce', 'tif'],
  workingType: ['workingtype', 'triggertype', 'stoppricetype', 'pricetype'],
  reduceOnly: ['reduceonly'],
  closePosition: ['closeposition'],
  clientOrderId: ['newclientorderid', 'clientorderid', 'newclientorderidstr', 'clientoid', 'clientid'],
  orderRef: ['origclientorderid', 'clientorderid', 'newclientorderid', 'orderid'],
  leverage: ['leverage', 'initialleverage'],
  marginType: ['margintype', 'marginmode', 'margin'],
} as const;

const RULES: OpRule[] = [
  {
    op: 'account',
    base: 0.2,
    words: [{ any: ['account', 'balance', 'wallet', 'equity'], w: 0.45, req: true }],
    deny: ['position', 'order', 'transfer', 'withdraw', 'history', 'trade', 'trades', 'income', 'commission', 'config'],
    params: [],
  },
  {
    op: 'positions',
    base: 0.2,
    words: [{ any: ['position', 'positions', 'position risk'], w: 0.45, req: true }],
    deny: ['close', 'order', 'history', 'mode', 'margin', 'leverage', 'adjust', 'change', 'set', 'side'],
    params: [],
  },
  {
    op: 'open_orders',
    base: 0.1,
    words: [
      { any: ['open orders', 'open order', 'pending orders', 'active orders', 'current orders', 'open'], w: 0.5, req: true },
      { any: ['order', 'orders'], w: 0.15 },
    ],
    deny: ['cancel', 'place', 'create', 'new', 'history', 'all orders'],
    params: [{ cands: [...P.symbol], w: 0.1 }],
  },
  {
    op: 'place_market',
    base: 0,
    words: [
      { any: ['order', 'orders'], w: 0.3, req: true },
      { any: ['place', 'create', 'new', 'submit', 'post', 'send'], w: 0.25, req: true },
    ],
    deny: ['cancel', 'query', 'get', 'history', 'status', 'list', 'all', 'batch', 'modify', 'amend', 'test', 'open'],
    params: [
      { cands: [...P.symbol], w: 0.1 },
      { cands: [...P.side], w: 0.1 },
      { cands: [...P.qty], w: 0.1 },
      { cands: [...P.type], w: 0.1 },
    ],
  },
  {
    op: 'cancel_order',
    base: 0,
    words: [
      { any: ['cancel', 'delete', 'revoke'], w: 0.35, req: true },
      { any: ['order'], w: 0.2, req: true },
    ],
    deny: ['all', 'batch', 'place', 'create', 'open orders', 'multiple'],
    params: [
      { cands: [...P.symbol], w: 0.1 },
      { cands: [...P.orderRef], w: 0.2 },
    ],
  },
  {
    op: 'cancel_all',
    base: 0,
    words: [
      { any: ['cancel', 'delete', 'revoke'], w: 0.3, req: true },
      { any: ['all', 'batch', 'open orders', 'multiple', 'every'], w: 0.35, req: true },
    ],
    deny: ['place', 'create'],
    params: [{ cands: [...P.symbol], w: 0.15 }],
  },
  {
    op: 'get_order',
    base: 0,
    words: [
      { any: ['order'], w: 0.25, req: true },
      { any: ['get', 'query', 'fetch', 'read', 'status', 'detail', 'info', 'lookup'], w: 0.25, req: true },
    ],
    deny: ['place', 'create', 'new', 'cancel', 'open', 'all', 'batch', 'history', 'trades'],
    params: [
      { cands: [...P.symbol], w: 0.1 },
      { cands: [...P.orderRef], w: 0.2 },
    ],
  },
  {
    op: 'set_leverage',
    base: 0,
    words: [
      { any: ['leverage'], w: 0.5, req: true },
      { any: ['change', 'set', 'update', 'adjust', 'initial'], w: 0.2 },
    ],
    deny: ['bracket', 'brackets', 'tier', 'notional'],
    params: [
      { cands: [...P.leverage], w: 0.2 },
      { cands: [...P.symbol], w: 0.1 },
    ],
  },
  {
    op: 'set_margin_type',
    base: 0,
    words: [
      { any: ['margin'], w: 0.35, req: true },
      { any: ['type', 'mode'], w: 0.25, req: true },
      { any: ['change', 'set', 'update', 'switch'], w: 0.15 },
    ],
    deny: ['isolated position', 'history', 'call'],
    params: [
      { cands: [...P.marginType], w: 0.15 },
      { cands: [...P.symbol], w: 0.05 },
    ],
  },
  {
    op: 'mark_price',
    base: 0,
    domain: MARKET_WORDS,
    words: [
      { any: ['mark price', 'markprice', 'premium index', 'premiumindex'], w: 0.5, req: true },
      { any: ['price', 'ticker', 'index'], w: 0.1 },
    ],
    deny: ['history', 'kline', 'candle', 'funding rate history'],
    params: [{ cands: [...P.symbol], w: 0.1 }],
  },
];
// The four place_* ops share one rule (they are the same tool with a different `type` literal).
for (const op of ['place_limit', 'place_stop_market_close', 'place_take_profit_close'] as const) {
  const base = RULES.find((r) => r.op === 'place_market')!;
  RULES.push({ ...base, op });
}

/** Words of a string, punctuation → spaces, padded so `' word '` matching also handles phrases. */
function hay(s: string): string {
  return ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}
function hasWord(h: string, w: string): boolean {
  return h.includes(` ${w} `);
}

interface SchemaParams {
  props: Record<string, string>;
  required: Set<string>;
}

/** inputSchema.properties keyed by their normalized name → the original name. */
export function schemaParams(tool: McpTool): SchemaParams {
  const props: Record<string, string> = {};
  const required = new Set<string>();
  const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: unknown } | undefined;
  if (schema && typeof schema === 'object') {
    for (const name of Object.keys(schema.properties ?? {})) props[norm(name)] = name;
    if (Array.isArray(schema.required)) for (const r of schema.required) required.add(norm(String(r)));
  }
  return { props, required };
}

function pick(sp: SchemaParams, cands: readonly string[]): string | null {
  for (const c of cands) {
    const hit = sp.props[norm(c)];
    if (hit) return hit;
  }
  return null;
}

function scoreTool(rule: OpRule, tool: McpTool, sp: SchemaParams): number | null {
  const nameHay = hay(tool.name);
  const descHay = hay(tool.description ?? '');
  for (const d of rule.deny) if (hasWord(nameHay, d) || nameHay.includes(` ${d} `)) return null;
  let score = rule.base;
  for (const w of rule.words) {
    const inName = w.any.some((x) => hasWord(nameHay, x));
    const inDesc = w.any.some((x) => hasWord(descHay, x));
    if (inName) score += w.w;
    else if (inDesc) score += w.w * 0.5;
    else if (w.req) return null;
  }
  for (const p of rule.params) if (pick(sp, p.cands)) score += p.w;
  const domain = rule.domain ?? FUTURES_WORDS;
  if (domain.some((d) => hasWord(nameHay, d))) score += 0.15;
  else if (domain.some((d) => hasWord(descHay, d))) score += 0.05;
  if (hasWord(nameHay, 'spot') || hasWord(nameHay, 'option') || hasWord(nameHay, 'earn') || hasWord(nameHay, 'staking')) score -= 0.5;
  return score;
}

/** Below this a candidate is not offered at all: the op stays unmapped and lands in `notes`. */
const FLOOR = 0.4;

const PLACE_SHAPES: Record<'place_market' | 'place_limit' | 'place_stop_market_close' | 'place_take_profit_close', { type: string; needs: (keyof typeof P)[] }> = {
  place_market: { type: 'MARKET', needs: ['symbol', 'side', 'qty'] },
  place_limit: { type: 'LIMIT', needs: ['symbol', 'side', 'qty', 'price'] },
  place_stop_market_close: { type: 'STOP_MARKET', needs: ['symbol', 'side', 'stopPrice'] },
  place_take_profit_close: { type: 'TAKE_PROFIT_MARKET', needs: ['symbol', 'side', 'stopPrice'] },
};

const ORDER_RESULT: McpResultPaths = { order_id: 'orderId', avg_price: 'avgPrice', status: 'status', executed_qty: 'executedQty' };

function buildArgs(op: McpOp, sp: SchemaParams): { args: Record<string, ArgValue>; missing: string[] } {
  const args: Record<string, ArgValue> = {};
  const missing: string[] = [];
  const put = (cands: readonly string[], value: ArgValue, need = false, label = ''): void => {
    const name = pick(sp, cands);
    if (name) args[name] = value;
    else if (need) missing.push(label || String(cands[0]));
  };
  if (op === 'place_market' || op === 'place_limit' || op === 'place_stop_market_close' || op === 'place_take_profit_close') {
    const shape = PLACE_SHAPES[op];
    const need = (k: keyof typeof P): boolean => shape.needs.includes(k);
    put(P.symbol, '${symbol}', need('symbol'), 'symbol');
    put(P.side, '${side}', need('side'), 'side');
    put(P.type, shape.type);
    put(P.positionSide, '${positionSide}');
    if (op === 'place_market' || op === 'place_limit') {
      put(P.qty, '${qty}', true, 'quantity');
      put(P.reduceOnly, '${reduceOnly}');
    } else {
      put(P.stopPrice, '${stopPrice}', true, 'stopPrice');
      put(P.closePosition, '${closePosition}');
      put(P.workingType, 'MARK_PRICE');
    }
    if (op === 'place_limit') {
      put(P.price, '${price}', true, 'price');
      put(P.timeInForce, 'GTC');
    }
    put(P.clientOrderId, '${clientOrderId}', true, 'clientOrderId');
    return { args, missing };
  }
  switch (op) {
    case 'cancel_order':
    case 'get_order':
      put(P.symbol, '${symbol}', true, 'symbol');
      // These address an existing order, so `origClientOrderId` counts too (P.orderRef, not P.clientOrderId).
      put(P.orderRef, '${clientOrderId}', true, 'clientOrderId');
      return { args, missing };
    case 'cancel_all':
    case 'mark_price':
      put(P.symbol, '${symbol}', true, 'symbol');
      return { args, missing };
    case 'set_leverage':
      put(P.symbol, '${symbol}', true, 'symbol');
      put(P.leverage, '${leverage}', true, 'leverage');
      return { args, missing };
    case 'set_margin_type':
      put(P.symbol, '${symbol}', true, 'symbol');
      put(P.marginType, '${marginMode}', true, 'marginType');
      return { args, missing };
    case 'account':
      return { args, missing };
    case 'positions':
    case 'open_orders': {
      // Only pass a symbol when the tool demands one: the account view needs EVERY position/order.
      const name = pick(sp, P.symbol);
      if (name && sp.required.has(norm(name))) {
        args[name] = '${symbol}';
        missing.push(`${name}(该工具要求必传 symbol,账户总览会拿不到全部)`);
      }
      return { args, missing };
    }
    default:
      return { args, missing };
  }
}

function resultFor(op: McpOp): McpResultPaths | undefined {
  if (op.startsWith('place_') || op === 'get_order') return { ...ORDER_RESULT };
  if (op === 'cancel_order' || op === 'cancel_all') return { order_id: 'orderId', status: 'status' };
  if (op === 'mark_price') return { avg_price: 'markPrice' };
  return undefined;
}

/**
 * Proposes a whole map from a `tools/list` catalogue. Pure function, no network, no model: every op
 * picks its best-scoring tool above {@link FLOOR}; anything it cannot map is listed in `notes` instead
 * of being guessed. The result is always `status: 'proposed'`.
 */
export function proposeToolMap(tools: McpTool[], now = Date.now()): McpToolMap {
  const ops: Partial<Record<McpOp, McpOpMapping>> = {};
  const notes: string[] = [];
  const params = new Map<string, SchemaParams>();
  for (const t of tools) params.set(t.name, schemaParams(t));
  for (const op of MCP_OPS) {
    const rule = RULES.find((r) => r.op === op);
    if (!rule) continue;
    let best: { tool: McpTool; score: number } | null = null;
    for (const t of tools) {
      const s = scoreTool(rule, t, params.get(t.name)!);
      if (s === null || s < FLOOR) continue;
      if (!best || s > best.score) best = { tool: t, score: s };
    }
    if (!best) {
      notes.push(`${op}:工具清单里没找到合适的工具(${MCP_OPTIONAL_OPS.includes(op) ? '可选,会退回公开 REST 或留空' : '必需,请手动指定'})`);
      continue;
    }
    const sp = params.get(best.tool.name)!;
    const { args, missing } = buildArgs(op, sp);
    const confidence = Math.max(0, Math.min(1, best.score)) * (missing.length ? 0.6 : 1);
    const mapping: McpOpMapping = { tool: best.tool.name, args, confidence: Number(confidence.toFixed(2)) };
    const result = resultFor(op);
    if (result) mapping.result = result;
    if (missing.length) {
      mapping.missing = missing;
      notes.push(`${op} → ${best.tool.name}:缺参数 ${missing.join('、')},请核对后手工补上`);
    }
    ops[op] = mapping;
  }
  if (!notes.length) notes.push('全部 13 个操作都有候选工具;请逐条核对参数名再确认。');
  return { version: MCP_MAP_VERSION, status: 'proposed', source: 'heuristic', updated_at: now, ops, notes };
}

// ---------------------------------------------------------------- validation / persistence

const isArgValue = (v: unknown): v is ArgValue => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** Validates a user-supplied map (PUT /api/binance/map). Returns the normalized map plus every problem. */
export function validateToolMap(raw: unknown, now = Date.now()): { map: McpToolMap | null; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { map: null, errors: ['映射必须是一个 JSON 对象'] };
  const r = raw as Record<string, unknown>;
  const opsRaw = (r['ops'] ?? {}) as Record<string, unknown>;
  if (!opsRaw || typeof opsRaw !== 'object' || Array.isArray(opsRaw)) return { map: null, errors: ['ops 必须是对象'] };
  const ops: Partial<Record<McpOp, McpOpMapping>> = {};
  for (const [key, value] of Object.entries(opsRaw)) {
    if (!(MCP_OPS as readonly string[]).includes(key)) {
      errors.push(`未知操作 ${key}(只能是 ${MCP_OPS.join('/')})`);
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${key}: 必须是 { tool, args, result } 对象`);
      continue;
    }
    const m = value as Record<string, unknown>;
    const tool = typeof m['tool'] === 'string' ? m['tool'].trim() : '';
    if (!tool) {
      errors.push(`${key}: tool 必填`);
      continue;
    }
    const argsRaw = m['args'] ?? {};
    if (!argsRaw || typeof argsRaw !== 'object' || Array.isArray(argsRaw)) {
      errors.push(`${key}: args 必须是对象`);
      continue;
    }
    const args: Record<string, ArgValue> = {};
    let bad = false;
    for (const [k, v] of Object.entries(argsRaw as Record<string, unknown>)) {
      if (!isArgValue(v)) {
        errors.push(`${key}.args.${k}: 只能是字符串/数字/布尔/null`);
        bad = true;
        continue;
      }
      args[k] = v;
    }
    if (!bad) {
      try {
        renderArgs(args, {});
      } catch (e) {
        errors.push(`${key}.args: ${(e as Error).message}`);
        bad = true;
      }
    }
    if (bad) continue;
    const mapping: McpOpMapping = { tool, args };
    const resRaw = m['result'];
    if (resRaw !== undefined && resRaw !== null) {
      if (typeof resRaw !== 'object' || Array.isArray(resRaw)) {
        errors.push(`${key}.result: 必须是对象`);
        continue;
      }
      const result: McpResultPaths = {};
      for (const [k, v] of Object.entries(resRaw as Record<string, unknown>)) {
        if (!['order_id', 'avg_price', 'status', 'executed_qty', 'root'].includes(k)) {
          errors.push(`${key}.result.${k}: 只能是 order_id/avg_price/status/executed_qty/root`);
          continue;
        }
        if (typeof v !== 'string' || !v.trim()) {
          errors.push(`${key}.result.${k}: 必须是非空取值路径`);
          continue;
        }
        (result as Record<string, string>)[k] = v.trim();
      }
      if (Object.keys(result).length) mapping.result = result;
    }
    if (typeof m['confidence'] === 'number' && Number.isFinite(m['confidence'])) mapping.confidence = Math.max(0, Math.min(1, m['confidence']));
    if (Array.isArray(m['missing'])) mapping.missing = (m['missing'] as unknown[]).map(String);
    if (typeof m['note'] === 'string') mapping.note = m['note'];
    ops[key as McpOp] = mapping;
  }
  if (errors.length) return { map: null, errors };
  const status = r['status'] === 'confirmed' ? 'confirmed' : 'proposed';
  const notes = Array.isArray(r['notes']) ? (r['notes'] as unknown[]).map(String) : [];
  return { map: { version: MCP_MAP_VERSION, status, source: 'manual', updated_at: now, ops, notes }, errors: [] };
}

/** Reads a stored map; a missing / unparsable / stale-version blob is simply "no map". */
export function loadToolMap(json: string | null | undefined): McpToolMap | null {
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== MCP_MAP_VERSION) return null;
  const { map } = validateToolMap(parsed);
  if (!map) return null;
  map.status = (parsed as { status?: unknown }).status === 'confirmed' ? 'confirmed' : 'proposed';
  map.source = (parsed as { source?: unknown }).source === 'heuristic' ? 'heuristic' : 'manual';
  const at = (parsed as { updated_at?: unknown }).updated_at;
  if (typeof at === 'number' && Number.isFinite(at)) map.updated_at = at;
  return map;
}

export function loadCatalogue(json: string | null | undefined): StoredCatalogue | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json) as StoredCatalogue;
    return Array.isArray(p?.tools) ? { at: Number(p.at) || 0, tools: p.tools } : null;
  } catch {
    return null;
  }
}

/** Ops that must be mapped for the backend to be usable at all. */
export function requiredOpsMissing(map: McpToolMap): McpOp[] {
  return MCP_OPS.filter((op) => !MCP_OPTIONAL_OPS.includes(op) && !map.ops[op]);
}

// ---------------------------------------------------------------- human (or CLI) review

/**
 * A self-contained review request: the catalogue, the proposal, and what a correction must look like.
 * Handed to a human in the UI, or piped to a subscription CLI (`claude -p` / `codex exec`) — the
 * gateway itself never calls a model for this.
 */
export function mapReviewPrompt(tools: McpTool[], proposal: McpToolMap): string {
  const catalogue = tools
    .map((t) => {
      const sp = schemaParams(t);
      const params = Object.values(sp.props)
        .map((n) => (sp.required.has(norm(n)) ? `${n}*` : n))
        .join(', ');
      return `- ${t.name}(${params || '无参数'})${t.description ? ` — ${t.description.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
    })
    .join('\n');
  const rows = MCP_OPS.map((op) => {
    const m = proposal.ops[op];
    if (!m) return `- ${op}: 未映射`;
    return `- ${op}: ${m.tool} conf=${m.confidence ?? '?'}${m.missing?.length ? ` 缺 ${m.missing.join('/')}` : ''} args=${JSON.stringify(m.args)}`;
  }).join('\n');
  return [
    '你在校对一份「操作 → 币安 MCP 工具」的映射表。这是纯确定性执行用的配置,没有模型参与下单。',
    '',
    `## 工具清单(${tools.length} 个,带 * 的是必填参数)`,
    catalogue || '(空)',
    '',
    '## 待校对的映射(启发式生成)',
    rows,
    '',
    '## 规则',
    `1. 市场是 USDⓈ-M 永续合约;凡是现货/杠杆/期权的工具都不能用。`,
    `2. args 是模板:值恰好是 \${x} 时按类型注入,可用占位符 ${MCP_PLACEHOLDERS.join('/')};没有值的键会被丢掉。`,
    '3. result 指出回执字段的取值路径(如 "orderId" 或 "data.orderId")。',
    '4. 宁可留空也不要猜:留空时该操作会被拒绝执行,猜错会下错单。',
    '',
    '只回一个 JSON 对象:{"ops":{"<op>":{"tool":…,"args":{…},"result":{…}}},"notes":[…]},不要解释。',
  ].join('\n');
}
