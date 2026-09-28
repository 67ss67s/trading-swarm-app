/**
 * Minimal MCP client over Streamable HTTP (spec 2025-06-18): initialize → notifications/initialized →
 * tools/list / tools/call. Handles the `mcp-session-id` header, JSON or SSE-framed responses, 401 (auth) and
 * 404 (session gone → re-initialize once). No LLM anywhere: this is how the gateway calls Binance's MCP
 * tools deterministically once it holds a bearer token (binance-oauth.ts).
 */

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpToolResult {
  /** Text parts of `result.content` joined; structuredContent when the server gives it. */
  text: string;
  structured: unknown;
  isError: boolean;
  raw: unknown;
}

export class McpAuthError extends Error {
  constructor(message = 'MCP 需要重新授权(401)') {
    super(message);
    this.name = 'McpAuthError';
  }
}

/** The server answered with a JSON-RPC error — it processed the call and said no (not a transport failure). */
export class McpRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'McpRpcError';
  }
}

export interface McpClientOptions {
  url: string;
  token: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  clientName?: string;
  timeoutMs?: number;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export class McpHttpClient {
  private sessionId: string | null = null;
  private initialized: Promise<void> | null = null;
  private nextId = 1;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  readonly url: string;
  private readonly token: () => Promise<string | null>;
  private readonly clientName: string;
  serverInfo: unknown = null;

  constructor(opts: McpClientOptions) {
    this.url = opts.url;
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.clientName = opts.clientName ?? 'trade-gate';
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** Drops the session so the next call re-initializes (e.g. after a new token). */
  reset(): void {
    this.sessionId = null;
    this.initialized = null;
  }

  async listTools(): Promise<McpTool[]> {
    const r = (await this.request('tools/list', {})) as { tools?: McpTool[] };
    return r.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const raw = (await this.request('tools/call', { name, arguments: args })) as {
      content?: { type: string; text?: string }[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    const text = (raw.content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text as string).join('\n');
    let structured: unknown = raw.structuredContent ?? null;
    if (structured === null && text) {
      try {
        structured = JSON.parse(text);
      } catch {
        structured = null;
      }
    }
    return { text, structured, isError: !!raw.isError, raw };
  }

  private ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.doInitialize().catch((e) => {
        this.initialized = null;
        throw e;
      });
    }
    return this.initialized;
  }

  private async doInitialize(): Promise<void> {
    const { body, headers } = await this.post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: this.clientName, version: '0.1' } },
    });
    const sid = headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const resp = pickResponse(body);
    if (resp?.error) throw new Error(`MCP initialize 失败: ${resp.error.message}`);
    this.serverInfo = (resp?.result as { serverInfo?: unknown } | undefined)?.serverInfo ?? null;
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, true);
  }

  private async request(method: string, params: unknown, retried = false): Promise<unknown> {
    await this.ensureInitialized();
    const id = this.nextId++;
    let out: { body: string; headers: Headers; status: number };
    try {
      out = await this.post({ jsonrpc: '2.0', id, method, params });
    } catch (e) {
      if (!retried && e instanceof SessionGoneError) {
        this.reset();
        return this.request(method, params, true);
      }
      throw e;
    }
    const resp = pickResponse(out.body, id);
    if (!resp) throw new Error(`MCP ${method}: 响应里没有 id=${id} 的结果`);
    if (resp.error) throw new McpRpcError(method, resp.error.code, `MCP ${method} 错误 ${resp.error.code}: ${resp.error.message}`, resp.error.data);
    return resp.result;
  }

  private async post(payload: unknown, notification = false): Promise<{ body: string; headers: Headers; status: number }> {
    const tok = await this.token();
    if (!tok) throw new McpAuthError('没有可用的币安授权 token,请先连接');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tok}`,
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      };
      if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
      const res = await this.fetchImpl(this.url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
      if (res.status === 401) throw new McpAuthError();
      if (res.status === 404 && this.sessionId) throw new SessionGoneError();
      const body = await res.text();
      if (notification) return { body, headers: res.headers, status: res.status };
      if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${body.slice(0, 300)}`);
      return { body, headers: res.headers, status: res.status };
    } finally {
      clearTimeout(timer);
    }
  }
}

class SessionGoneError extends Error {}

/** Accepts a plain JSON body or an SSE stream; returns the JSON-RPC response (matching `id` when given). */
export function pickResponse(body: string, id?: number): JsonRpcResponse | null {
  const candidates: JsonRpcResponse[] = [];
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const j = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcResponse[];
    for (const x of Array.isArray(j) ? j : [j]) candidates.push(x);
  } else {
    let data = '';
    for (const line of trimmed.split(/\r?\n/)) {
      if (line.startsWith('data:')) data += line.slice(5).trim();
      else if (line === '' && data) {
        pushJson(candidates, data);
        data = '';
      }
    }
    if (data) pushJson(candidates, data);
  }
  if (id === undefined) return candidates.find((c) => 'result' in c || 'error' in c) ?? null;
  return candidates.find((c) => c.id === id) ?? null;
}

function pushJson(into: JsonRpcResponse[], data: string): void {
  try {
    const j = JSON.parse(data) as JsonRpcResponse | JsonRpcResponse[];
    for (const x of Array.isArray(j) ? j : [j]) into.push(x);
  } catch {
    /* keep-alive or partial frame */
  }
}
