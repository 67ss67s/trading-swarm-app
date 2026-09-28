import { publicDemo, configureDemo, visitorContext } from './public-demo.js';
import { publicGate, runWithDemoContext, publicBody, publicSseFrame, isVisitorRequest, takePrereadBody } from './public-gate.js';
import { publicChat, newDemoSession, demoSessions, ownsDemoSession } from './public-routes.js';
import { gatewaySecurity } from './http-security.js';
import { serveAspSnapshot } from './asp-snapshot.js';
import { healthView, publicHealthView } from './routes-ops.js';
import { OpsMonitor } from './ops-monitor.js';
import { agentCards, agentDetail } from './agent-roster.js';
import { isBotRole } from './agent-registry.js';
import { fetchBasis } from './market.js';
import { setAccountLevel, explainAccountLevelError, ACCT_LV_LABEL, type AcctLv } from './okx-account-mode.js';
import type { Market } from './types.js';
import { HOLDING_POLICY_VERSION } from './holding-policy.js';
// HTTP + SSE control surface (docs/demo/README.md §3 + v2-agent-loop.md §3). node:http only.

import { BOT_ROLES, type BotRole } from './bots.js';
import { infoSourcesView } from './info.js';
import http from 'node:http';
import type { DemoRuntime } from './runtime.js';
import type { DemoStore } from './store.js';
import { exchange, fetchKlines, tfToMs } from './market.js';
import { BacktestManager, estimateBacktest, loadKlines, normalizeParams as normalizeBacktestParams } from './backtest.js';
import type { BrainKind, ManualOrderRequest, MemoryKind, MemoryLayer, MemoryStatus, ThreadStatus } from './types.js';
import { brainCatalog, testBrain } from './brain.js';
import { claudeLoginCommand, CODEX_MCP_BLOCKED_DETAIL, claudeLoginInstructions, codexLoginInstructions, DEFAULT_MCP_NAME, DEFAULT_MCP_URL, openTerminalWith, type TerminalOpener } from './execution-agent.js';
import { clientMetadataDocument, type BinanceOAuth } from './binance-oauth.js';
import { extraRouteModules } from './http-extra.js';
import { McpAuthError, McpHttpClient, type McpTool } from './mcp-client.js';
import { loadCatalogue, loadToolMap, mapReviewPrompt, MCP_MAP_KV_KEY, MCP_OPS, MCP_PLACEHOLDERS, MCP_TOOLS_KV_KEY, proposeToolMap, requiredOpsMissing, validateToolMap, type McpToolMap } from './mcp-map.js';
import { McpDirectBackend } from './execution-mcp.js';
import { BRAINS, MODEL_ID_RE } from './workflow.js';
import { redactDeep } from './trader-feed.js';
import { JUDGMENT_GRAPH, toMermaid } from './graph.js';
import { sseHeartbeatMs } from './ops-config.js';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, params: Record<string, string>) => Promise<void>;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(publicBody(res, body)));
}
function fail(res: http.ServerResponse, status: number, message: string, code = 'error'): void {
  json(res, status, { error: { code, message } });
}
function errStatus(e: unknown): number {
  return (e as { status?: number }).status ?? 500;
}
async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const preread = takePrereadBody(req); // 公网演示闸门为检查访客请求体已先读过(public-gate.ts)
  if (preread) return preread;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += Buffer.byteLength(c as Buffer);
    if (size > 4 * 1024 * 1024) throw Object.assign(new Error('请求体超过 4MiB'), { status: 413 });
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

const EVENTS = ['strategy_run.updated', 'strategy_run.event', 'research.inquiry', 'research.improve', 'research.matrix_study', 'strategy.transitioned', 'research.workbench', 'market_event', 'research_task', 'loop.state', 'episode.started', 'episode.progress', 'episode.finished', 'strategy.changed', 'intent.changed', 'account.updated', 'market.tick', 'log', 'market_state.updated', 'thread.changed', 'chat.message', 'chat.status', 'queue.state', 'workflow.changed', 'activity', 'memory.changed', 'execution.changed', 'backtest.progress', 'backtest.changed', 'screener.changed', 'bots.changed', 'portfolio.changed', 'risk.changed', 'workflow.proposal', 'trader_signal', 'market_delivery', 'market_publish', 'market_subscription', 'market_aftersale', 'models.changed', 'agent.strategy'] as const;

export interface ServerOptions {
  ops?: OpsMonitor;
  /** Gate-native Binance OAuth client (docs/design/execution-binance-mcp-2026-09-04.md path A); absent in tests. */
  oauth?: BinanceOAuth;
  /** The MCP client the `mcp` backend uses; shared so both reuse one session. Built on demand when absent. */
  mcp?: McpHttpClient;
  /** How `/api/execution/connect` pops the interactive `claude` login; injectable so tests open nothing. */
  openTerminal?: TerminalOpener;
}

export function createServer(rt: DemoRuntime, store: DemoStore, options: ServerOptions = {}): http.Server {
  const security = gatewaySecurity();
  if (publicDemo()) configureDemo(store.marketDb);
  const ops = options.ops ?? new OpsMonitor(store.marketDb);
  const oauth = options.oauth ?? null;
  const openTerminal = options.openTerminal ?? openTerminalWith;
  let mcp: McpHttpClient | null = options.mcp ?? null;
  const mcpClient = (): McpHttpClient => {
    if (!oauth) throw Object.assign(new Error('网关未配置币安 OAuth'), { status: 409 });
    mcp ??= new McpHttpClient({ url: oauth.resource, token: () => oauth.token() });
    return mcp;
  };
  const sse = new Set<http.ServerResponse>();
  const broadcast = (event: string, data: unknown): void => {
    for (const res of sse) {
      const frame = publicSseFrame(res, store, event, data);
      // 慢连接(写缓冲满)直接断开,不在内存里无限排队。
      if (frame !== null && !res.write(frame)) { sse.delete(res); res.destroy(); }
    }
  };
  const listeners = EVENTS.map((ev) => {
    const fn = (data: unknown): void => broadcast(ev, data);
    rt.on(ev, fn);
    return { ev, fn };
  });
  const heartbeat = setInterval(() => {
    for (const res of sse) if (!res.write(': ping\n\n')) { sse.delete(res); res.destroy(); }
  }, sseHeartbeatMs()).unref();

  const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
  const route = (method: string, path: string, handler: Handler): void => {
    const keys: string[] = [];
    const pattern = new RegExp(`^${path.replace(/:([a-z_]+)/g, (_m, k: string) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, pattern, keys, handler });
  };
  const guarded = (fn: Handler): Handler => async (req, res, url, p) => {
    try {
      await fn(req, res, url, p);
    } catch (e) {
      if (!res.headersSent && ['spot_no_short','market_not_enabled','market_unsupported','perp_unavailable_account_mode','invalid_market'].includes((e as Error).message)) {
        json(res,400,{error:(e as Error).message,kind:'local_reject'}); return;
      }
      if (!res.headersSent) fail(res, errStatus(e), (e as Error).message, typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : 'error');
    }
  };

  // ---- overview / episodes / logs
  route('GET', '/api/overview', async (_req, res) => {
    json(res, 200, {
      holding_policy: { version: HOLDING_POLICY_VERSION, book_mode: 'shadow', entry_gate: true, review_gate: true, target_mode: 'single' },
      loop: rt.loopView(),
      workflow: rt.workflow,
      account: rt.account,
      markets: Object.fromEntries(rt.markets),
      market: rt.markets.get(rt.workflow.watchlist[0] ?? 'BTCUSDT') ?? null,
      market_state: rt.marketState,
      threads: rt.openThreads(),
      queue: rt.queueView(),
      daily_loss_pct: rt.dailyLossPct().toFixed(2),
      usage_today: rt.usageToday(),
      recent_episodes: store.episodes(20),
    });
  });
  route('GET', '/api/episodes', async (_req, res, url) => {
    const limit = Math.min(200, Number(url.searchParams.get('limit') ?? '50'));
    const before = url.searchParams.get('before');
    const symbol = url.searchParams.get('symbol');
    const beforeAt = before ? store.episode(before)?.at : undefined;
    let rows = store.episodes(symbol ? limit * 4 : limit, beforeAt);
    if (symbol) rows = rows.filter((e) => e.symbol === symbol).slice(0, limit);
    json(res, 200, rows);
  });
  route('GET', '/api/episodes/:id', async (_req, res, _url, p) => {
    const ep = store.episode(p['id']!);
    if (!ep) return fail(res, 404, 'episode not found', 'not_found');
    json(res, 200, ep);
  });
  route('GET', '/api/intents', async (_req, res, url) => json(res, 200, store.intents(Math.min(200, Number(url.searchParams.get('limit') ?? '50')))));
  // 历史日志的读取出口也过一遍递归脱敏(六审 R6-02):`runtime.log` 现在在入口清,
  // 但库里可能还留着更早版本落下的、没清过的行 —— 读出来时再清一次才算闭环。
  route('GET', '/api/logs', async (_req, res, url) =>
    json(res, 200, redactDeep(store.logPage(Math.max(1, Math.min(1000, Number(url.searchParams.get('limit') ?? '200') || 200)), Number(url.searchParams.get('before_id')) || undefined), rt.followCredentials())));
  route('GET', '/api/market/klines', async (_req, res, url) => {
    const symbol = (url.searchParams.get('symbol') ?? rt.workflow.watchlist[0] ?? 'BTCUSDT').toUpperCase();
    const tf = url.searchParams.get('tf') ?? '1h';
    const limit = Math.min(1000, Number(url.searchParams.get('limit') ?? '300'));
    const endRaw = Number(url.searchParams.get('end_time') ?? '');
    const endTime = Number.isFinite(endRaw) && endRaw > 0 ? endRaw : undefined;
    json(res, 200, { symbol, tf, klines: await fetchKlines(symbol, tf, limit, endTime, (url.searchParams.get('market') ?? 'perp') as Market) });
  });
  route('GET', '/api/market/regime', guarded(async (_req, res, url) => json(res, 200, await rt.regime((url.searchParams.get('symbol') ?? rt.workflow.watchlist[0] ?? 'BTCUSDT').toUpperCase()))));

  // ---- v3: history + activity (docs/demo/v3-ui-contract.md §2-3)
  route('GET', '/api/history', async (_req, res, url) => json(res, 200, rt.history(Math.min(500, Number(url.searchParams.get('limit') ?? '200')))));
  route('GET', '/api/activity', async (_req, res, url) => {
    const before = Number(url.searchParams.get('before') ?? '');
    const threadId = url.searchParams.get('thread_id') ?? undefined;
    json(res, 200, store.activityPage(Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? '200') || 200)), Number.isFinite(before) && before > 0 ? before : undefined, threadId, url.searchParams.get('before_id') ?? undefined));
  });
  route('GET', '/api/symbols', guarded(async (_req, res, url) => {
    const market = url.searchParams.get('market') ?? 'perp';
    if (market !== 'spot' && market !== 'perp') return fail(res,400,'invalid_market','invalid_market');
    json(res, 200, { symbols: await rt.symbols(market) });
  }));
  route('GET', '/api/market/basis', guarded(async (_req, res, url) => {
    const symbol = (url.searchParams.get('symbol') ?? 'BTCUSDT').toUpperCase();
    try { json(res,200,await fetchBasis(symbol)); } catch(e) {
      if ((e as {missing?:string}).missing) return json(res,404,{error:'basis_unavailable',missing:(e as {missing:string}).missing});
      throw e;
    }
  }));

  // ---- loop controls
  route('POST', '/api/run-now', async (_req, res) => {
    const n = rt.scanAll({ kind: 'manual', detail: '界面上点了「立即扫描」' });
    json(res, 202, { queued: n });
  });
  route('POST', '/api/scan-now', async (req, res) => {
    const body = await readBody(req);
    const symbol = typeof body['symbol'] === 'string' ? body['symbol'].toUpperCase() : null;
    const queued = symbol ? (rt.scan(symbol, { kind: 'manual', detail: '界面上要求扫描' }) ? 1 : 0) : rt.scanAll({ kind: 'manual', detail: '界面上点了「立即扫描」' });
    json(res, 202, { queued, job_ids: Array.from({ length: queued }, (_v, i) => `scan-${Date.now().toString(36)}-${i}`) });
  });
  route('POST', '/api/info/run-now', async (_req, res) => {
    const queued = rt.runInfoNow('界面');
    json(res, 202, { queued, job_id: `info-${Date.now().toString(36)}` });
  });
  route('POST', '/api/pause', async (_req, res) => {
    rt.pause();
    json(res, 200, rt.loopView());
  });
  route('POST', '/api/resume', async (req, res) => {
    const body = await readBody(req);
    const r = rt.resume(typeof body['confirm'] === 'string' ? body['confirm'] : undefined);
    if (!r.ok) return fail(res, 400, r.message, 'confirm_required');
    json(res, 200, rt.loopView());
  });
  route('POST', '/api/halt', async (req, res) => {
    const body = await readBody(req);
    if (body['confirm'] !== 'HALT') return fail(res, 400, 'body.confirm must be "HALT"', 'confirm_required');
    await rt.halt();
    json(res, 200, rt.loopView());
  });
  route('POST', '/api/settings', async (req, res) => {
    const body = await readBody(req);
    const r = await rt.applyWorkflow(body);
    if (r.errors.length) return json(res, 400, { error: { code: 'invalid', message: r.errors.join('; ') }, errors: r.errors });
    json(res, 200, rt.loopView());
  });

  // ---- workflow
  route('GET', '/api/workflow', async (_req, res) => json(res, 200, rt.workflow));
  // ---- brains (which CLI/model the judgment and the information officer run on)
  route('GET', '/api/brains', async (_req, res, url) =>
    json(res, 200, {
      brains: brainCatalog(url.searchParams.get('refresh') === '1', rt.workflow.cli_commands),
      current: { brain: rt.mainBrain().name, cheap_brain: rt.cheapBrain().name },
      cli_commands: rt.workflow.cli_commands,
    }),
  );
  route('POST', '/api/brains/test', async (req, res) => {
    const body = await readBody(req);
    const kind = body['kind'];
    if (typeof kind !== 'string' || !(BRAINS as string[]).includes(kind)) return fail(res, 400, `kind 只能是 ${BRAINS.join('/')}`, 'bad_request');
    const model = body['model'] === undefined || body['model'] === null || body['model'] === '' ? null : String(body['model']).trim();
    if (model !== null && !MODEL_ID_RE.test(model)) return fail(res, 400, 'model 只能是模型 id(字母数字 . _ : / -)', 'bad_request');
    json(res, 200, await testBrain(kind as BrainKind, model, undefined, rt.workflow.cli_commands));
  });
  // ---- long-term memory (docs/demo/memory.md): list / search / propose / approve / reject / forget / reflect
  route('GET', '/api/memory', async (_req, res, url) => {
    const st = (url.searchParams.get('status') ?? '').split(',').filter(Boolean) as MemoryStatus[];
    const symbol = url.searchParams.get('symbol');
    json(res, 200, { items: store.memory.list({ status: st.length ? st : undefined, symbol: symbol ? symbol.toUpperCase() : undefined, layer: (url.searchParams.get('layer') as MemoryLayer | null) ?? undefined, role: (url.searchParams.get('role') as BotRole | null) ?? undefined, strategy_id: url.searchParams.get('strategy_id') ?? undefined, limit: Math.min(500, Number(url.searchParams.get('limit') ?? '200')) }), counts: store.memory.counts() });
  });
  route('GET', '/api/memory/search', async (_req, res, url) => json(res, 200, { hits: store.memory.recall({ symbol: url.searchParams.get('symbol')?.toUpperCase() ?? null, text: url.searchParams.get('q'), regime: url.searchParams.get('regime'), tags: (url.searchParams.get('tags') ?? '').split(',').filter(Boolean), limit: Math.min(50, Number(url.searchParams.get('limit') ?? '10')), char_budget: 5000, reader_role: (url.searchParams.get('reader_role') as BotRole | null) ?? 'gate_captain', strategy_id: url.searchParams.get('strategy_id') }) }));
  route('GET', '/api/memory/:id', async (_req, res, _url, p) => {
    const m = store.memory.get(p['id']!);
    if (!m) return fail(res, 404, 'no such memory', 'not_found');
    json(res, 200, { item: m, events: store.memory.events(m.id) });
  });
  route('POST', '/api/memory', guarded(async (req, res) => {
    const b = await readBody(req);
    if (typeof b['content'] !== 'string' || !b['content'].trim()) return fail(res, 400, 'content 必填', 'bad_request');
    const str = (k: string): string | undefined => (typeof b[k] === 'string' && b[k] ? (b[k] as string) : undefined);
    // §9.48:layer / role / strategy_id / thread_id 透传进 scope(proposed_by='user',写任何层都允许;不一致的组合 400)。
    const scope = { layer: str('layer') as MemoryLayer | undefined, role: str('role') as BotRole | undefined, strategy_id: str('strategy_id'), thread_id: str('thread_id') };
    const item = rt.rememberFromUser({ content: b['content'], kind: b['kind'] as MemoryKind | undefined, symbol: typeof b['symbol'] === 'string' && b['symbol'] ? b['symbol'] : null, regime: typeof b['regime'] === 'string' ? b['regime'] : null, tags: Array.isArray(b['tags']) ? (b['tags'] as unknown[]).map(String) : [], via: 'ui', scope: Object.fromEntries(Object.entries(scope).filter(([, v]) => v !== undefined)) });
    json(res, 201, { item });
  }));
  route('POST', '/api/memory/reflect', guarded(async (req, res) => {
    const b = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
    json(res, 200, await rt.reflect(Math.min(50, Number(b['limit'] ?? 20))));
  }));
  for (const action of ['approve', 'reject', 'forget'] as const) {
    route('POST', `/api/memory/:id/${action}`, guarded(async (req, res, _url, p) => {
      const b = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
      const reason = typeof b['reason'] === 'string' ? b['reason'] : null;
      const m = action === 'approve' ? store.memory.approve(p['id']!) : action === 'reject' ? store.memory.reject(p['id']!, reason) : store.memory.forget(p['id']!, reason);
      if (!m) return fail(res, 404, 'no such memory', 'not_found');
      rt.emit('memory.changed', { id: m.id, status: m.status });
      json(res, 200, { item: m });
    }));
  }
  // ---- judgment graph (docs/design/graph-engineering-v2.md): the same table the runtime and eval read
  route('GET', '/api/graph', async (_req, res) => json(res, 200, { graph: JUDGMENT_GRAPH, mermaid: toMermaid(JUDGMENT_GRAPH) }));
  route('POST', '/api/workflow', async (req, res) => {
    const body = await readBody(req);
    // `execution` is applied by actually switching the backend; a refused switch leaves the field
    // unchanged and lands in `errors` (docs/demo/v3-ui-contract.md §9.6).
    const r = await rt.applyWorkflow(body);
    // Always 200 with {workflow, errors}: the UI shows the errors inline next to the fields.
    json(res, r.errors.includes('default_market_not_enabled') ? 400 : 200, { workflow: r.workflow, errors: r.errors, ...(r.errors.includes('default_market_not_enabled') ? {error:'default_market_not_enabled'} : {}) });
  });

  // ---- execution backend + Binance MCP connection (docs/demo/v3-ui-contract.md §9.6)
  route('GET', '/api/execution', guarded(async (_req, res) => json(res, 200, { ...(await rt.checkExecutionConnection(false)), oauth: oauth?.status() ?? null })));
  route('POST', '/api/execution/model-budget/reset', guarded(async (_req, res) => { rt.resetModelBudget(); json(res, 200, rt.executionView()); }));
  route('POST', '/api/execution/settlement-retries/reset', guarded(async (_req, res) => { rt.resetSettlementRetries(); json(res, 200, { ok: true }); }));
  route('POST', '/api/execution/check', guarded(async (_req, res) => json(res, 200, await rt.checkExecutionConnection(true))));
  route('POST', '/api/execution/connect', guarded(async (_req, res) => {
    // Path A (the gateway as its own OAuth client) is DEAD until Binance whitelists us: its consent page
    // answers "The AI Agent you are using is not currently supported (3346001)" — the client_id allowlist
    // is Binance's, not something PKCE/CIMD can work around. Claude Code IS on that list, so connecting
    // goes through the claude CLI's own MCP session. TG_BINANCE_OAUTH_FORCE=1 re-opens path A for a retest.
    if (process.env['TG_BINANCE_OAUTH_FORCE'] === '1' && oauth?.clientId) {
      const { url } = await oauth.startAuth();
      return json(res, 200, { started: true, url, instructions: '已打开币安授权页;完成后回到这里点「检查连接」' });
    }
    const cli = rt.workflow.exec_agent_cli;
    // codex: `codex mcp login` is dead upstream (dynamic client registration vs Binance's CIMD), so
    // never spawn it — say so instead.
    if (cli === 'codex') return json(res, 200, { started: false, instructions: codexLoginInstructions(DEFAULT_MCP_NAME), detail: CODEX_MCP_BLOCKED_DETAIL });
    // The user's own launch command (alias / env prefix), so the terminal runs what actually works here.
    const loginCommand = claudeLoginCommand(rt.cliCommandFor('claude'));
    // claude has no headless MCP login, so pop a Terminal window with the interactive one. We read no
    // credential of any kind: the human authenticates in that window and the CLI keeps the token.
    const opened = openTerminal(loginCommand);
    if (opened.ok) return json(res, 200, { started: true, instructions: '已弹出终端:在里面选 binance-mcp-server → Authenticate,浏览器里同意后回来点「检查连接」', detail: loginCommand });
    json(res, 200, { started: false, instructions: claudeLoginInstructions(DEFAULT_MCP_NAME, rt.cliCommandFor('claude')), detail: opened.error });
  }));

  // ---- gate-native Binance OAuth + direct MCP (docs/design/execution-binance-mcp-2026-09-04.md §1 A)
  // okx 模式下这一整块不注册(§5):没有币安通道,留着这些路由只会让前端以为还能连。
  const binanceRoute = (method: string, path: string, handler: Handler): void => {
    if (exchange() !== 'okx') route(method, path, handler);
  };
  binanceRoute('GET', '/oauth/binance/client-metadata.json', async (req, res) => {
    const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
    const redirect = oauth?.redirectUri ?? `${origin}/oauth/binance/callback`;
    json(res, 200, clientMetadataDocument(oauth?.clientId ?? `${origin}/oauth/binance/client-metadata.json`, [redirect]));
  });
  binanceRoute('GET', '/oauth/binance/callback', async (_req, res, url) => {
    const page = (ok: boolean, msg: string): void => {
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>trade-gate</title><body style="font-family:system-ui;padding:2rem"><h2>${ok ? '币安已授权' : '授权失败'}</h2><p>${msg}</p><p>可以关闭这个页面,回到 trade-gate 点「检查连接」。</p>`);
    };
    if (!oauth) return page(false, '网关未配置币安 OAuth(TG_BINANCE_OAUTH_CLIENT_ID)');
    try {
      const tok = await oauth.handleCallback(url.searchParams);
      mcp?.reset();
      // First thing after consent: snapshot the (undocumented) tool catalogue and propose a map, so the
      // UI already shows something to review. Best effort — a failure here must not break the callback.
      let discovered = '';
      try {
        const d = await discoverAndPropose();
        discovered = d.kept ? `;已有确认过的工具映射(${Object.keys(d.map.ops).length} 条)继续可用` : `;已抓到 ${d.tools.length} 个工具并生成映射草案,回到 trade-gate 里核对后确认`;
      } catch (e) {
        discovered = `;工具清单还没抓到(${(e as Error).message}),回到 trade-gate 点「重新推断」`;
        mapLog('warn', `授权后抓工具清单失败:${(e as Error).message}`);
      }
      rt.emit('execution.changed', { ...rt.executionView(), oauth: oauth.status() });
      page(true, `${tok.expires_at ? `token 有效期到 ${new Date(tok.expires_at).toLocaleString('zh-CN')}(币安不提供续期,过期后重新连接)` : 'token 已保存'}${discovered}`);
    } catch (e) {
      page(false, (e as Error).message);
    }
  });
  binanceRoute('GET', '/api/binance/status', async (_req, res) => json(res, 200, oauth ? oauth.status() : { configured: false, connected: false, missing: '网关未配置币安 OAuth' }));
  binanceRoute('POST', '/api/binance/disconnect', async (_req, res) => {
    oauth?.disconnect();
    mcp?.reset();
    rt.emit('execution.changed', { ...rt.executionView(), oauth: oauth?.status() ?? null });
    json(res, 200, { ok: true });
  });
  // First thing to run after a successful consent: the tool catalogue is undocumented, so we snapshot it
  // and (unless a confirmed map already covers it) propose the op → tool map from it.
  binanceRoute('GET', '/api/binance/tools', guarded(async (_req, res) => {
    try {
      const { tools, map, kept } = await discoverAndPropose();
      json(res, 200, { tools, count: tools.length, server: mcpClient().serverInfo, url: oauth?.resource ?? DEFAULT_MCP_URL, map, map_kept: kept });
    } catch (e) {
      if (e instanceof McpAuthError) return fail(res, 401, e.message);
      throw e;
    }
  }));
  binanceRoute('POST', '/api/binance/tools/call', guarded(async (req, res) => {
    // Manual, read-only exploration from the UI/curl; the runtime never routes orders through here.
    const b = await readBody(req);
    const name = typeof b['name'] === 'string' ? b['name'] : '';
    if (!name) return fail(res, 400, 'name 必填');
    const args = (b['arguments'] && typeof b['arguments'] === 'object' ? b['arguments'] : {}) as Record<string, unknown>;
    try {
      json(res, 200, await mcpClient().callTool(name, args));
    } catch (e) {
      if (e instanceof McpAuthError) return fail(res, 401, e.message);
      throw e;
    }
  }));

  // ---- the tool map: op → MCP tool (mcp-map.ts). Proposed by heuristics, confirmed by a human, and
  // only then usable by the `mcp` execution backend (docs/demo/v3-ui-contract.md §9.6).
  const readCatalogue = () => loadCatalogue(store.kvGet(MCP_TOOLS_KV_KEY));
  const readMap = () => loadToolMap(store.kvGet(MCP_MAP_KV_KEY));
  const writeMap = (m: McpToolMap): void => store.kvSet(MCP_MAP_KV_KEY, JSON.stringify(m));
  const mapLog = (level: 'info' | 'warn' | 'error', message: string, data?: unknown): void => void store.log({ at: Date.now(), level, scope: 'binance-mcp', message, ...(data === undefined ? {} : { data }) });
  const emitExecution = (): void => {
    rt.emit('execution.changed', { ...rt.executionView(), oauth: oauth?.status() ?? null });
  };
  const mapPayload = (map: McpToolMap | null, tools: McpTool[] | null) => {
    const cat = readCatalogue();
    return {
      map,
      tools_count: cat?.tools.length ?? 0,
      tools_at: cat?.at ?? null,
      proposal_notes: map?.notes ?? [],
      unmapped_required: map ? requiredOpsMissing(map) : [...MCP_OPS],
      ops: [...MCP_OPS],
      placeholders: [...MCP_PLACEHOLDERS],
      review_prompt: map && (tools ?? cat?.tools) ? mapReviewPrompt((tools ?? cat?.tools)!, map) : null,
    };
  };
  /**
   * tools/list → snapshot the catalogue → propose a map. A map a human already CONFIRMED survives as
   * long as every tool it names still exists (re-authorizing must not throw away that work); otherwise
   * it is replaced by a fresh proposal that has to be confirmed again.
   */
  const discoverAndPropose = async (): Promise<{ tools: McpTool[]; map: McpToolMap; kept: boolean }> => {
    const tools = await mcpClient().listTools();
    store.kvSet(MCP_TOOLS_KV_KEY, JSON.stringify({ at: Date.now(), tools }));
    const prev = readMap();
    const names = new Set(tools.map((t) => t.name));
    if (prev && prev.status === 'confirmed' && Object.values(prev.ops).every((m) => names.has(m.tool))) return { tools, map: prev, kept: true };
    const map = proposeToolMap(tools);
    if (prev?.status === 'confirmed') map.notes.unshift('之前确认过的映射里有工具在新清单里不存在了,已重新生成草案,请重新确认。');
    writeMap(map);
    return { tools, map, kept: false };
  };

  binanceRoute('GET', '/api/binance/map', async (_req, res) => json(res, 200, mapPayload(readMap(), null)));
  binanceRoute('POST', '/api/binance/map/propose', guarded(async (_req, res) => {
    // Refresh the catalogue when we can reach the server; otherwise re-run the heuristics on the snapshot.
    let tools: McpTool[] | null = null;
    let refreshed = false;
    try {
      const r = await mcpClient().listTools();
      store.kvSet(MCP_TOOLS_KV_KEY, JSON.stringify({ at: Date.now(), tools: r }));
      tools = r;
      refreshed = true;
    } catch (e) {
      tools = readCatalogue()?.tools ?? null;
      if (!tools) return fail(res, e instanceof McpAuthError ? 401 : 409, `拿不到工具清单:${(e as Error).message}`);
      mapLog('warn', `重新抓工具清单失败,用上次的快照重推:${(e as Error).message}`);
    }
    const map = proposeToolMap(tools);
    writeMap(map);
    mapLog('info', `重新推断币安 MCP 工具映射:${Object.keys(map.ops).length}/${MCP_OPS.length} 个操作有候选`);
    emitExecution();
    json(res, 200, { ...mapPayload(map, tools), refreshed });
  }));
  binanceRoute('PUT', '/api/binance/map', guarded(async (req, res) => {
    // Full replacement with the human's JSON. Absent `status` means `proposed`: an edit must be
    // re-confirmed before it can trade.
    const body = await readBody(req);
    const raw = body['map'] && typeof body['map'] === 'object' ? body['map'] : body;
    const { map, errors } = validateToolMap(raw);
    if (!map) return json(res, 400, { error: { code: 'invalid', message: errors.join('; ') }, errors });
    writeMap(map);
    mapLog('info', `币安 MCP 工具映射已手工替换(${Object.keys(map.ops).length} 条,status=${map.status})`);
    emitExecution();
    json(res, 200, { ...mapPayload(map, null), errors: [] });
  }));
  binanceRoute('POST', '/api/binance/map/confirm', guarded(async (_req, res) => {
    const map = readMap();
    if (!map) return fail(res, 409, '还没有映射可确认:先完成授权并「重新推断」', 'conflict');
    const missing = requiredOpsMissing(map);
    if (missing.length) return fail(res, 400, `还有必需操作没映射:${missing.join('、')}`, 'invalid');
    map.status = 'confirmed';
    map.updated_at = Date.now();
    writeMap(map);
    mapLog('warn', `币安 MCP 工具映射已确认,mcp 执行后端可用(${Object.keys(map.ops).length} 条)`);
    emitExecution();
    json(res, 200, mapPayload(map, null));
  }));
  binanceRoute('POST', '/api/binance/map/test', guarded(async (req, res) => {
    // READ ONLY, always: account / positions / open_orders / mark_price and nothing else.
    const body = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
    const symbol = (typeof body['symbol'] === 'string' && body['symbol'] ? body['symbol'] : (rt.workflow.watchlist[0] ?? 'BTCUSDT')).toUpperCase();
    const map = readMap();
    if (!map) return fail(res, 409, '还没有映射可测试:先完成授权并「重新推断」', 'conflict');
    const probe = new McpDirectBackend({ client: mcpClient(), map: () => map, log: mapLog, requireConfirmed: false });
    const results = await probe.readTest(symbol);
    json(res, 200, { symbol, results, ok_count: results.filter((r) => r.ok).length, total: results.length });
  }));

  // ---- information officer
  route('GET', '/api/market-state', async (_req, res) => json(res, 200, rt.marketState));
  route('GET', '/api/market-state/history', async (_req, res, url) => {
    const summary = url.searchParams.get('view') === 'summary';
    const rows = store.marketStates(Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? '20') || 20)), summary);
    json(res, 200, { history: summary ? rows.map(({ id, as_of, bias, regime, summary, error }) => ({ id, as_of, bias, regime, summary, error })) : rows });
  });
  route('GET', '/api/info/sources', async (_req, res) => json(res, 200, { sources: infoSourcesView() }));
  route('GET', '/api/info/events', async (_req, res, url) => json(res, 200, { events: store.infoEvents(Math.min(500, Number(url.searchParams.get('limit') ?? '100'))) }));

  // ---- threads
  route('GET', '/api/threads', async (_req, res, url) => {
    const status = url.searchParams.get('status') ?? 'open';
    const statuses: ThreadStatus[] | undefined = status === 'open' ? ['pending_entry', 'in_position'] : status === 'all' ? undefined : (status.split(',') as ThreadStatus[]);
    const be = url.searchParams.get('backend');
    json(res, 200, { threads: store.threads({ ...(statuses ? { statuses } : {}), limit: Math.min(500, Number(url.searchParams.get('limit') ?? '100')), backend: be === 'all' ? null : be || rt.backend.kind }), backend: be === 'all' ? 'all' : be || rt.backend.kind });
  });
  route('GET', '/api/threads/:id', async (_req, res, _url, p) => {
    const t = store.thread(p['id']!);
    if (!t) return fail(res, 404, 'thread not found', 'not_found');
    json(res, 200, { thread: t, episodes: store.episodesForThread(t.id), intents: store.intentsForThread(t.id) });
  });
  route('POST', '/api/threads/:id/close', guarded(async (_req, res, _url, p) => json(res, 200, await rt.closeThread(p['id']!, '界面上手动平仓/撤单'))));
  // 09-07:把无主持仓交给 agent(建 in_position 线程;body {stop_price?, take_profit?},没交易所止损时 stop_price 必填)
  route('POST', '/api/positions/:symbol/adopt', guarded(async (req, res, _url, p) => {
    const body = await readBody(req);
    const thread = await rt.adoptPosition(p['symbol']!, { market: (body['market'] ?? 'perp') as Market, stop_price: typeof body['stop_price'] === 'string' ? body['stop_price'] : null, take_profit: typeof body['take_profit'] === 'string' ? body['take_profit'] : null });
    json(res, 200, { thread });
  }));
  route('POST', '/api/threads/:id/review', async (_req, res, _url, p) => json(res, 202, { queued: rt.reviewThread(p['id']!, { kind: 'manual', detail: '界面上点了「复查」' }) }));
  // 09-23 §9.49:人工核实利空事件 → holding-policy verified_material_event(持仓放开 REDUCE/EXIT)。body {adverse_side, note}
  route('POST', '/api/threads/:id/verified-event', guarded(async (req, res, _url, p) => {
    const b = await readBody(req);
    const side = b['adverse_side'];
    if (side !== 'long' && side !== 'short') return fail(res, 400, 'adverse_side 只能是 long/short', 'bad_request');
    const note = typeof b['note'] === 'string' ? b['note'].trim() : '';
    if (!note) return fail(res, 400, 'note 必填(核实了什么事件)', 'bad_request');
    json(res, 200, rt.setVerifiedEvent(p['id']!, { adverse_side: side, note: note.slice(0, 500) }));
  }));
  route('DELETE', '/api/threads/:id/verified-event', guarded(async (_req, res, _url, p) => json(res, 200, rt.clearVerifiedEvent(p['id']!))));

  // ---- manual orders / positions
  route('POST', '/api/orders', guarded(async (req, res) => {
    const body = (await readBody(req)) as unknown as ManualOrderRequest;
    if (!body.symbol || (body.side !== 'long' && body.side !== 'short') || (body.action !== 'open' && body.action !== 'close') || (body.type !== 'market' && body.type !== 'limit')) return fail(res, 400, 'symbol/side/action/type 必填', 'invalid');
    json(res, 200, await rt.manualOrder(body));
  }));
  route('GET', '/api/orders/open', async (_req, res) => json(res, 200, rt.account?.open_orders ?? []));
  route('GET', '/api/positions', async (_req, res) => json(res, 200, rt.account?.positions ?? []));
  // v3.11 保护腿自验证(§9.20):用户点按钮,网关自己跑金丝雀;202 立即返回,进度走 SSE execution.changed 的 protection 字段。
  route('POST', '/api/execution/verify-protection', guarded(async (req, res) => {
    const body = await readBody(req);
    const market = (body['market'] ?? 'perp') as Market;
    rt.assertMarket(market, false);
    const symbol = typeof body['symbol'] === 'string' ? body['symbol'] : undefined;
    // 09-20:symbols[] = 逐个顺序验(楼层那条合并告警的按钮);一个失败不影响后面的,每个币各自记结果
    const symbols = Array.isArray(body['symbols']) ? (body['symbols'] as unknown[]).filter((x): x is string => typeof x === 'string' && /^[A-Z0-9]{2,20}$/i.test(x)).map((x) => x.toUpperCase()) : symbol ? [symbol] : [];
    if (symbols.length > 10) return fail(res, 400, '一次最多验 10 个币', 'too_many');
    const st = rt.protectionStatus();
    if (st.status === 'verifying') return fail(res, 409, '验证正在进行', 'busy');
    void (async () => {
      if (!symbols.length) { await rt.verifyProtection({ market }).catch(() => {}); return; }
      for (const sym of symbols) await rt.verifyProtection({ symbol: sym, market }).catch(() => {});
    })();
    json(res, 202, { started: true, symbols, protection: rt.protectionStatus() });
  }));
  route('GET', '/api/execution/protection', async (_req, res) => json(res, 200, { protection: rt.protectionStatus() }));
  // §7.7:人工在模拟盘上跑完保护腿验证清单后,把 KV 置 1,okx 通道的 protectionCapability 才变 verified。
  // 刻意是个「人按的按钮」而不是自动推断:这条闸控着「未验证通道不许新开仓」,不能由代码自己解锁。
  route('POST', '/api/execution/okx/verified', guarded(async (req, res) => {
    const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
    const on = body['verified'] !== false;
    store.kvSet('okx.protection.verified', on ? '1' : '0');
    json(res, 200, { ok: true, verified: on, execution: rt.executionView() });
  }));
  // §9.40:刷新 OKX 账户模式(用户在网页切完模式后前端轮询;只读)。非 okx 通道 409。
  route('POST', '/api/execution/okx/account-level/refresh', guarded(async (_req, res) => {
    try {
      const view = await rt.refreshOkxAccountLevel();
      if (!view) return fail(res, 409, '当前执行后端不是 okx', 'not_applicable');
      json(res, 200, view);
    } catch (e) {
      fail(res, 502, `读取 OKX 账户模式失败:${e instanceof Error ? e.message : String(e)}`, 'okx_config_unreadable');
    }
  }));
  // §9.40:切 OKX 账户模式(1 简单 / 2 单币种 / 3 跨币种 / 4 组合)。网关自己签名直打 set-account-level
  // (okx CLI 没封装)——「不读 key」边界的第二个例外,见 okx-account-mode.ts 头注释。切之前先查持仓/挂单。
  route('POST', '/api/execution/okx/account-level', guarded(async (req, res) => {
    if (rt.backend.kind !== 'okx') return fail(res, 409, '当前执行后端不是 okx', 'not_applicable');
    const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
    const lv = Number(body['acctLv'] ?? body['acct_lv']);
    if (!(lv === 1 || lv === 2 || lv === 3 || lv === 4)) return fail(res, 400, 'acctLv 必须是 1/2/3/4', 'bad_acct_lv');
    const acct = rt.account;
    const blockers: string[] = [];
    // OKX 的「没有持仓」指衍生品仓位/借币;现货持币不算(实测带着 BTC/ETH 现货切 3 成功)
    const perpPos = (acct?.positions ?? []).filter((x) => x.market !== 'spot');
    if (perpPos.length) blockers.push(`有 ${perpPos.length} 笔永续持仓(${perpPos.map((x) => x.symbol).join('/')})`);
    if (acct?.open_orders.length) blockers.push(`有 ${acct.open_orders.length} 张挂单`);
    if (blockers.length && body['force'] !== true) return fail(res, 409, `OKX 要求切换时没有持仓、挂单、借币:${blockers.join(';')}。先平掉/撤掉再切`, 'account_not_flat');
    let r: Awaited<ReturnType<typeof setAccountLevel>>;
    try {
      r = await setAccountLevel(lv as AcctLv, rt.okxProfile?.() ?? null);
    } catch (e) {
      return fail(res, 502, `切换账户模式失败:${e instanceof Error ? e.message : String(e)}`, 'okx_config_unreadable');
    }
    rt.log(r.ok ? 'info' : 'warn', 'exec', `OKX 账户模式切换 → ${lv}(${ACCT_LV_LABEL[lv as AcctLv]}):${r.ok ? 'ok' : `${r.code} ${r.msg}`}`);
    const view = await rt.refreshOkxAccountLevel().catch(() => rt.executionView());
    if (!r.ok) return fail(res, 409, explainAccountLevelError(r.code, r.msg), `okx_${r.code}`);
    json(res, 200, { ok: true, acct_lv: r.acct_lv ?? lv, execution: view });
  }));
  // 09-07:网络自检(只读,n 次账户调用,每次一个子进程;agent_mcp 约 20–30 s/次)。同步等结果,n 钳 1–10。
  route('POST', '/api/execution/net-check', guarded(async (req, res) => {
    const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
    const n = Number(body['n'] ?? 5);
    const r = await rt.netCheck(Number.isFinite(n) ? n : 5);
    if (!r) return fail(res, 409, '当前执行后端没有网络可测(纸面/本地)', 'not_applicable');
    json(res, 200, { result: r });
  }));
  // v3.10 人批(§9.19):先取一次性 confirm token(绑定意图内容指纹,120 s),再带 nonce 批准;缺 nonce → 428 confirm_required。
  route('POST', '/api/intents/:id/confirm-token', guarded(async (_req, res, _url, p) => {
    const r = rt.issueIntentConfirmation(p['id']!);
    json(res, 200, { nonce: r.token.nonce, expires_at: r.token.expires_at, fingerprint: r.token.fingerprint, intent: { id: r.intent.id, kind: r.intent.kind, symbol: r.intent.symbol, direction: r.intent.direction, quantity: r.intent.quantity, entry: r.intent.entry, limit_price: r.intent.limit_price, stop_price: r.intent.stop_price, take_profit_price: r.intent.take_profit_price, backend: r.intent.backend } });
  }));
  route('POST', '/api/intents/:id/approve', guarded(async (req, res, _url, p) => {
    const body = await readBody(req);
    json(res, 200, await rt.approveIntent(p['id']!, typeof body['nonce'] === 'string' ? body['nonce'] : null));
  }));
  route('POST', '/api/intents/:id/reject', guarded(async (_req, res, _url, p) => json(res, 200, rt.rejectIntent(p['id']!))));
  // v3.10 设置提议(对话里改高风险设置只到提议,人取 token 后 apply)
  route('GET', '/api/workflow/proposals', async (_req, res) => json(res, 200, { proposals: rt.workflowProposals() }));
  route('POST', '/api/workflow/proposals/:id/confirm-token', guarded(async (_req, res, _url, p) => {
    const r = rt.issueProposalConfirmation(p['id']!);
    json(res, 200, { nonce: r.token.nonce, expires_at: r.token.expires_at, fingerprint: r.token.fingerprint, proposal: r.proposal });
  }));
  route('POST', '/api/workflow/proposals/:id/apply', guarded(async (req, res, _url, p) => {
    const body = await readBody(req);
    json(res, 200, rt.applyWorkflowProposal(p['id']!, typeof body['nonce'] === 'string' ? body['nonce'] : null));
  }));
  route('POST', '/api/workflow/proposals/:id/reject', guarded(async (_req, res, _url, p) => json(res, 200, { proposal: rt.rejectWorkflowProposal(p['id']!) })));

  // ---- 九个 Agent 的名册与循环(§9.55)
  route('GET', '/api/agents', guarded(async (_req, res) => json(res, 200, { agents: agentCards(rt) })));
  route('GET', '/api/agents/:role', guarded(async (_req, res, _url, p) => {
    if (!isBotRole(p['role'])) return fail(res, 404, '未知 Agent', 'unknown_role');
    json(res, 200, agentDetail(rt, p['role']));
  }));

  // ---- chat
  route('GET', '/api/chat/messages', async (_req, res, url) => {
    const session = url.searchParams.get('session');
    if (isVisitorRequest() && (!session || !ownsDemoSession(store, session, visitorContext()!.visitor))) return json(res, 200, { messages: [], session: null });
    json(res, 200, { messages: store.chat(Math.min(500, Number(url.searchParams.get('limit') ?? '100')), (['chat', 'narration', 'all'].includes(url.searchParams.get('kind') ?? '') ? url.searchParams.get('kind') : 'all') as 'chat' | 'narration' | 'all', session), session: session ? store.chatSession(session) : null });
  });
  route('POST', '/api/chat/messages', async (req, res) => {
    const body = await readBody(req);
    if (isVisitorRequest()) return json(res, 200, await publicChat(rt, store, body));
    const text = typeof body['text'] === 'string' ? body['text'].trim() : '';
    if (!text) return fail(res, 400, 'text 必填', 'invalid');
    const session = typeof body['session'] === 'string' && body['session'] ? body['session'] : 'default';
    if (!store.chatSession(session)) return fail(res, 404, `没有会话 ${session}`, 'not_found');
    const r = rt.sendChat(text.slice(0, 4000), session);
    json(res, 202, { accepted: r.queued, queued: r.queued, session });
  });
  route('POST', '/api/chat/reset', async (req, res) => {
    const body = await readBody(req).catch(() => ({}) as Record<string, unknown>);
    store.clearChat(typeof body['session'] === 'string' ? body['session'] : undefined);
    json(res, 200, { ok: true });
  });
  // ---- v3.8 会话列表(docs/demo/v3-ui-contract.md §9.14)
  route('GET', '/api/chat/sessions', async (_req, res, url) => json(res, 200, { sessions: isVisitorRequest() ? demoSessions(store) : store.chatSessions({ include_archived: url.searchParams.get('archived') === '1' }) }));
  route('POST', '/api/chat/sessions', async (req, res) => {
    const body = await readBody(req);
    if (isVisitorRequest()) return json(res, 201, { session: newDemoSession(store, typeof body['title'] === 'string' ? body['title'] : '评审对话') });
    if (body['role'] !== undefined && body['role'] !== null && !isBotRole(body['role'])) return fail(res, 404, '未知 Agent', 'unknown_role');
    const role = isBotRole(body['role']) ? body['role'] : null;
    const prof = role ? store.bots.profile(role) : null;
    json(res, 201, { session: store.createChatSession(typeof body['title'] === 'string' && body['title'] ? body['title'] : prof ? `@${prof.name.split(' / ')[0]}` : '新会话', Date.now(), role) });
  });
  route('POST', '/api/chat/sessions/:id', guarded(async (req, res, _url, p) => {
    const body = await readBody(req);
    const patch: { title?: string; archived?: boolean; can_execute?: boolean } = {};
    if (typeof body['title'] === 'string') patch.title = body['title'];
    if (typeof body['archived'] === 'boolean') patch.archived = body['archived'];
    if (typeof body['can_execute'] === 'boolean') patch.can_execute = body['can_execute'];
    const s = store.updateChatSession(p['id']!, patch);
    if (!s) return fail(res, 404, `没有会话 ${p['id']}`, 'not_found');
    if (patch.can_execute !== undefined) rt.log('warn', 'chat', `会话 ${s.id}「${s.title}」允许执行 = ${s.can_execute ? '开' : '关'}`);
    json(res, 200, { session: s });
  }));
  route('DELETE', '/api/chat/sessions/:id', guarded(async (_req, res, _url, p) => {
    if (!store.deleteChatSession(p['id']!)) return fail(res, 409, p['id'] === 'default' ? '默认会话不能删,只能清空' : '没有这个会话', 'cannot_delete');
    json(res, 200, { ok: true });
  }));

  // ---- backtest / replay(docs/demo/v3-ui-contract.md §9.8;docs/design/blind-backtest-2026-09-05.md)
  // 盲测:每根 K 线只喂当时可见的数据给同一套 buildContext + 契约 + 闸。花钱的动作(POST /api/backtest)
  // 前端必须先拿 estimate 给用户看 ¥ 再确认;回测不受每日判断上限约束,但花费单独在 summary 里算。
  const backtests = new BacktestManager({
    store,
    brainFor: (kind, model) => rt.brainFor(kind, model),
    workflow: () => rt.workflow,
    emit: (event, data) => rt.emit(event, data),
    log: (level, message) => rt.log(level, 'backtest', message),
  });
  const backtestParams = (raw: Record<string, unknown>): { params: ReturnType<typeof normalizeBacktestParams>['params']; errors: string[] } => normalizeBacktestParams(raw, rt.workflow);
  const paramsFromQuery = (url: URL): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of url.searchParams) out[k] = k === 'from' || k === 'to' || k === 'max_judgments' || k === 'horizon_bars' ? Number(v) : v === 'true' ? true : v === 'false' ? false : v;
    return out;
  };
  route('GET', '/api/backtest/estimate', guarded(async (_req, res, url) => {
    const { params, errors } = backtestParams(paramsFromQuery(url));
    if (errors.length) return json(res, 400, { error: { code: 'invalid', message: errors.join('; ') }, errors });
    json(res, 200, await estimateBacktest(params, rt.workflow, backtests.brainName(params)));
  }));
  route('GET', '/api/backtest', async (_req, res, url) => json(res, 200, { runs: backtests.list(Math.min(200, Number(url.searchParams.get('limit') ?? '50'))), running: backtests.isRunning() }));
  route('POST', '/api/backtest', guarded(async (req, res) => {
    const { params, errors } = backtestParams(await readBody(req));
    if (errors.length) return json(res, 400, { error: { code: 'invalid', message: errors.join('; ') }, errors });
    const { run, error } = backtests.start(params);
    json(res, error ? 409 : 202, { run, error });
  }));
  route('GET', '/api/backtest/:id', async (_req, res, _url, p) => {
    const found = backtests.get(p['id']!);
    if (!found) return fail(res, 404, 'no such backtest', 'not_found');
    json(res, 200, found);
  });
  route('POST', '/api/backtest/:id/cancel', async (_req, res, _url, p) => json(res, 200, { cancelled: backtests.cancel(p['id']!) }));
  /**
   * Deep historical klines for the replay chart. Binance's /fapi/v1/klines caps a single call at 1500
   * bars, so loadKlines pages backwards for us and keeps a disk cache of both the bars and the spans it
   * has already asked about — scrubbing or re-opening a range costs nothing after the first call.
   * `complete:false` means the request was truncated at the bar cap and `from` is the earliest bar
   * actually returned, so the UI knows there is more to ask for further back.
   */
  const HISTORY_MAX_BARS = 20_000;
  route('GET', '/api/market/klines/history', guarded(async (_req, res, url) => {
    const symbol = (url.searchParams.get('symbol') ?? rt.workflow.watchlist[0] ?? 'BTCUSDT').toUpperCase();
    const interval = url.searchParams.get('interval') ?? url.searchParams.get('tf') ?? '15m';
    const step = tfToMs(interval);
    const to = Number(url.searchParams.get('to') ?? Date.now());
    const from = Number(url.searchParams.get('from') ?? to - 500 * step);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return fail(res, 400, 'from/to 必须是毫秒时间戳且 to > from', 'bad_request');
    const earliest = Math.max(from, to - HISTORY_MAX_BARS * step);
    const klines = await loadKlines(symbol, interval, earliest, to);
    json(res, 200, { symbol, interval, from: earliest, to, requested_from: from, klines, complete: earliest <= from, max_bars: HISTORY_MAX_BARS });
  }));

  // ---- extension modules (http-extra.ts: one file per feature, one registration line)
  for (const mod of extraRouteModules) mod({ route: (m, p, h) => route(m, p, h), guarded, json, fail, readBody, rt, store, oauth, emit: (ev, data) => void rt.emit(ev, data) });

  // ---- SSE
  route('GET', '/api/events', async (_req, res) => {
    if (sse.size >= 100) return fail(res, 503, 'SSE 连接数已达上限', 'capacity');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: loop.state\ndata: ${JSON.stringify(rt.loopView())}\n\n`);
    res.write(`event: queue.state\ndata: ${JSON.stringify(rt.queueView())}\n\n`);
    sse.add(res);
    res.on('close', () => sse.delete(res));
  });

  const ports = ['5180', '5181', '5191', '5195', '18800', '18801', '18805', '18811', '18900', process.env['TG_DEMO_PORT'], process.env['TG_UI_PORT']].filter(Boolean);
  const ALLOWED_ORIGINS = new Set(process.env['TG_ALLOWED_ORIGINS'] ? process.env['TG_ALLOWED_ORIGINS'].split(',').map(v => v.trim()) : ports.flatMap(port => ['127.0.0.1', 'localhost'].map(host => `http://${host}:${port}`)));
  if (ALLOWED_ORIGINS.has('*')) throw new Error('TG_ALLOWED_ORIGINS 不允许通配符');
  const server = http.createServer(async (req, res) => {
    try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // 公网演示闸门(public-gate.ts):身份、限频、只读/可玩/owner 分类;非公网部署直接放过。
    const gate = await publicGate(req, res, url, { store, backendKind: () => rt.backend.kind, respond: json, readBody });
    if (gate.handled) return;
    if (serveAspSnapshot(req, res, url)) return; // 信号市场只读快照模式(TG_PUBLIC_ASP_SNAPSHOT)
    if (req.method === 'GET' && url.pathname === '/api/health') {
      const view = healthView(rt, ops);
      return json(res, view.status === 'ok' ? 200 : 503, gate.ctx && !gate.ctx.owner ? publicHealthView(view) : view);
    }
    if (!gate.ctx && !security.authorize(req, res)) return;
    // Browser requests must come from our own UI; non-browser callers (no Origin) are local tools.
    const origin = req.headers.origin;
    const privateApi = url.pathname.startsWith('/api/research') || url.pathname === '/api/events' || url.pathname.startsWith('/api/wallet') || url.pathname.startsWith('/api/execution/okx') || url.pathname === '/api/execution';
    res.setHeader('vary', 'Origin');
    if (origin && ALLOWED_ORIGINS.has(origin)) res.setHeader('access-control-allow-origin', origin);
    else if (!privateApi && req.method === 'GET') res.setHeader('access-control-allow-origin', '*');
    if (origin && !ALLOWED_ORIGINS.has(origin) && (req.method !== 'GET' || privateApi)) return fail(res, 403, `origin ${origin} not allowed`, 'forbidden');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,authorization' });
      return res.end();
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      try {
        await runWithDemoContext(gate.ctx, req.method ?? 'GET', url.pathname, () => r.handler(req, res, url, params));
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        if (!res.headersSent) fail(res, errStatus(e), (e as Error).message, typeof code === 'string' && (code.startsWith('demo_') || code === 'judge_locked') ? code : 'internal');
      }
      return;
    }
    fail(res, 404, `no route ${req.method} ${url.pathname}`, 'not_found');
    } catch (e) {
      // 畸形 URL / 请求体等入口错误;带 status 的(413 等)照原样回。
      if (res.headersSent) res.destroy();
      else fail(res, errStatus(e) === 500 ? 400 : errStatus(e), (e as { status?: number }).status ? (e as Error).message : '请求格式错误', 'bad_request');
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.on('close', () => {
    clearInterval(heartbeat);
    for (const { ev, fn } of listeners) rt.off(ev, fn);
    for (const res of sse) res.destroy();
    sse.clear();
    if (!options.ops) void ops.stop();
  });
  return server;
}
