import type { ResearchRevisionCommand, ResearchRevisionContext } from './research-types';
import type { BacktestReplay, BacktestReport, BacktestReportSummary, ResearchStrategy, ResearchStrategyBacktestRequest, ResearchStrategyCreate, ResearchStrategyDetail, ResearchStrategyList, ResearchStrategyPatch, ResearchStrategyTransition, StrategyBindingResponse } from '@trading-swarm/contracts';
import { useEffect, useRef, useState } from 'react';
import type {
  AccountView,
  ActivityResponse,
  ApiError,
  ConfirmToken,
  WorkflowProposal,
  BacktestDetailResponse,
  BacktestEstimate,
  BacktestListResponse,
  BacktestStartResponse,
  BrainKind,
  BrainsResponse,
  BrainTestResult,
  ChatMessagesResponse,
  ChatSendResponse,
  BotRole,
  ChatSession,
  ChatSessionsResponse,
  DemoIntent,
  Episode,
  EpisodeSummary,
  BinanceMapResponse,
  BinanceMapTestResponse,
  ExecutionConnectResponse,
  ExecutionView,
  McpToolMap,
  GraphResponse,
  HistoryResponse,
  InfoEventsResponse,
  IndicatorsResponse,
  IndicatorSetsResponse,
  InfoRunNowResponse,
  InfoSourcesResponse,
  KlinesResponse,
  LogsResponse,
  LoopView,
  ManualOrderRequest,
  ManualOrderResponse,
  MarketState,
  MarketStateHistoryResponse,
  MemoryCreateRequest,
  MemoryDetailResponse,
  MemoryItem,
  MemoryListResponse,
  MemoryReflectResponse,
  MemorySearchResponse,
  MemoryStatus,
  Overview,
  RegimeResponse,
  ScanNowResponse,
  ServerEventMap,
  StrategyRun,
  StrategyRunEvent,
  StrategyRunPatch,
  StrategyRunPreflight,
  StrategyRunRequest,
  SettingsPayload,
  StrategyThread,
  AllocatorMode,
  AllocatorView,
  AllocatorModeResponse,
  AllocatorRunResponse,
  AllocatorRollbackResponse,
  NetCheckResult,
  StrategyWithRevisions,
  SymbolsResponse,
  Market,
  BasisView,
  ThreadDetailResponse,
  ThreadsResponse,
  KlinesHistoryResponse,
  Workflow,
  WorkflowPatchResponse,
  BacktestAttributeResponse,
  BacktestAttributionResponse,
  StrategiesResponse,
  StrategyActiveResponse,
  StrategyDetailResponse,
  StrategyEvidenceResponse,
  StrategyEvidenceSpec,
  JudgmentDetailResponse,
  StrategyMutationResponse,
  StrategyRetireResponse,
  StrategySpec,
  StrategyStatus,
  StrategyTimelineResponse,
  StrategyToggleResponse,
  BotHandoffAckResponse,
  BotHandoffsResponse,
  BotsResponse,
  HandoffStatus,
  ScreenerApplyResponse,
  ScreenerDetailResponse,
  ScreenerHistoryResponse,
  ScreenerLatestResponse,
  ScreenerRunResponse,
  ScreenHorizon,
  PortfolioSnapshotResponse,
  PortfolioCapacityResponse,
  RiskAlertRow,
  RiskAlertAction,
  ProtectionStatusView,
  RiskAlertsResponse,
  FollowOverview,
  FollowSignalsResponse,
  FollowSignalActionResponse,
  MarketSettings,
  MarketStatus,
  MarketSearchResponse,
  CatalogResponse,
  CatalogDetail,
  MarketAspDetail,
  MarketSubscribeRequest,
  MarketSubscribeResponse,
  MarketSubscriptionsResponse,
  MarketSubscriptionConfig,
  MarketInboxResponse,
  TraderSignal,
  MarketFundingNotice,
  MarketAsp,
  MarketRegisterForm,
  MarketValidateResponse,
  MarketRegisterResponse,
  MarketDeliveriesResponse,
  MarketDeliveryOut,
  MarketPreview,
  OkxAccountStatus,
  TraderSignalStatus,
  TraderAction,
  ReviewerBatchResponse,
  ReviewerCardsResponse,
  LabExperimentsResponse,
  CaptainBriefResponse,
  JudgmentLedgerResponse,
  LedgerSummary,
  MarketEventCreateRequest,
  MarketEventCreateResponse,
  MarketEventDetailResponse,
  MarketEventsResponse,
  AttributionSummaryResponse,
  StrategyAttributionResponse,
  OkxSetupRequest,
  OkxSetupResponse,
  OkxInstallResponse,
  WalletStatus,
  WalletAssets,
  WalletLoginInit,
  OkxMcpStatus,
  OkxStatus,
  MarketScorecard,
  ModelConnection,
  ModelConnectionInput,
  ModelConnectionPatch,
  ModelConnectionTest,
  ModelRole,
  ModelsView,
  RoleTestResult,
} from './types';

import { adaptAsp, adaptAspDetail, adaptDelivery, adaptFundingNotice, adaptInbox, adaptInboxStatus, adaptRegister, adaptSearch, adaptSettings, adaptStatus, adaptSubscriptions, composeOverview, list, obj, publisherToWire } from './market-adapt';

class ApiRequestError extends Error {
  code: string;
  status: number;
  /** 完整的错误响应体(§9.52 删除连接 409 还带 roles[]);老调用点不传就是 undefined。 */
  body?: unknown;
  constructor(status: number, code: string, message: string, body?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

const GATEWAY_DOWN_MESSAGE = '网关暂时连不上(多半在重启),恢复后自动刷新';

/** 网关没起来 / 正在重启 / 代理连不上:这类错误要自动重试,不该当成业务错误摆给用户。 */
export function isGatewayUnavailable(err: unknown): boolean {
  return err instanceof ApiRequestError && err.code === 'gateway_unavailable';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      // FormData(多部分上传)要让浏览器自己带 boundary,不能手写 content-type。
      headers: init?.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : undefined,
      ...init,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiRequestError(0, 'gateway_unavailable', GATEWAY_DOWN_MESSAGE);
  }
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const err = body && typeof body === 'object' ? (body as ApiError) : null;
    // 代理层的 502/504(网关自己不会回这两个)也按「网关不可用」处理。
    const down = !err?.error?.code && (res.status === 502 || res.status === 504);
    throw new ApiRequestError(
      res.status,
      err?.error?.code ?? (down ? 'gateway_unavailable' : 'unknown'),
      err?.error?.message ?? (down ? GATEWAY_DOWN_MESSAGE : res.statusText || `HTTP ${res.status}`),
      body,
    );
  }
  if (typeof body === 'string') throw new ApiRequestError(res.status, 'bad_response', `网关返回的不是 JSON:${body.slice(0, 80)}`, body);
  return body as T;
}

function post<T>(path: string, payload?: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: payload === undefined ? undefined : JSON.stringify(payload) });
}

/** 把可选查询参数拼成 `?a=1&b=2`;一个都没传就是空串(不留一个光秃秃的 `?`)。 */
function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** post() 的任意方法版(目前只有 PUT /api/binance/map 用得上)。 */
function send<T>(method: string, path: string, payload?: unknown): Promise<T> {
  return request<T>(path, { method, body: payload === undefined ? undefined : JSON.stringify(payload) });
}

export const api = {
  // ---- v1 --------------------------------------------------------------
  overview: () => request<Overview>('/api/overview'),
  episodes: (opts?: { limit?: number; before?: string }) => {
    const qs = new URLSearchParams();
    if (opts?.limit) qs.set('limit', String(opts.limit));
    if (opts?.before) qs.set('before', opts.before);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<EpisodeSummary[]>(`/api/episodes${suffix}`);
  },
  episode: (id: string) => request<Episode>(`/api/episodes/${encodeURIComponent(id)}`),
  strategy: () => request<StrategyWithRevisions>('/api/strategy'),
  intents: (limit = 50) => request<DemoIntent[]>(`/api/intents?limit=${limit}`),
  klines: (tf: string, limit = 300, symbol?: string, endTime?: number) =>
    request<KlinesResponse>(`/api/market/klines?tf=${tf}&limit=${limit}${symbol ? `&symbol=${symbol}` : ''}${endTime ? `&end_time=${endTime}` : ''}`),
  // 指标库(docs/demo/v3-ui-contract.md §9.10):set 留空就是网关的默认九条;
  // 只要一次请求就能同时拿到叠加线、副窗序列和快照文字,叠加层不用为每个指标各发一次。
  indicators: (symbol: string, interval: string, opts?: { limit?: number; set?: string[]; endTime?: number }) => {
    const qs = new URLSearchParams({ symbol, interval });
    if (opts?.limit) qs.set('limit', String(opts.limit));
    if (opts?.set?.length) qs.set('set', opts.set.join(','));
    if (opts?.endTime) qs.set('end_time', String(opts.endTime));
    return request<IndicatorsResponse>(`/api/market/indicators?${qs.toString()}`);
  },
  indicatorSets: () => request<IndicatorSetsResponse>('/api/market/indicators/sets'),
  logs: (limit = 200) => request<LogsResponse>(`/api/logs?limit=${limit}`),
  runNow: () => post<{ episode_id: string }>('/api/run-now'),
  pause: () => post<LoopView>('/api/pause'),
  resume: (confirm?: 'RESUME') => post<LoopView>('/api/resume', confirm ? { confirm } : undefined),
  halt: () => post<LoopView>('/api/halt', { confirm: 'HALT' }),
  settings: (payload: SettingsPayload) => post<LoopView>('/api/settings', payload),
  // §9.19:批准两步——先取一次性 token(120 秒),再带 nonce 批;缺 nonce 428 confirm_required,过期/用过/内容变了 409 confirm_expired|confirm_unknown|confirm_mismatch
  intentConfirmToken: (id: string) => post<ConfirmToken>(`/api/intents/${encodeURIComponent(id)}/confirm-token`),
  approveIntent: (id: string, nonce: string) => post<DemoIntent>(`/api/intents/${encodeURIComponent(id)}/approve`, { nonce }),
  rejectIntent: (id: string) => post<DemoIntent>(`/api/intents/${encodeURIComponent(id)}/reject`),

  // ---- v2:工作流 / 信息员 / 扫描 -----------------------------------------
  workflow: () => request<Workflow>('/api/workflow'),
  // §9.19 设置提议(对话改设置只到提议,人在界面上两步确认)
  workflowProposals: () => request<{ proposals: WorkflowProposal[] }>('/api/workflow/proposals'),
  proposalConfirmToken: (id: string) => post<ConfirmToken<WorkflowProposal>>(`/api/workflow/proposals/${encodeURIComponent(id)}/confirm-token`),
  applyProposal: (id: string, nonce: string) => post<{ proposal: WorkflowProposal; workflow: Workflow; errors: string[] }>(`/api/workflow/proposals/${encodeURIComponent(id)}/apply`, { nonce }),
  rejectProposal: (id: string) => post<{ proposal: WorkflowProposal }>(`/api/workflow/proposals/${encodeURIComponent(id)}/reject`),
  patchWorkflow: (patch: Partial<Workflow>) => post<WorkflowPatchResponse>('/api/workflow', patch),
  marketState: () => request<MarketState>('/api/market-state'),
  marketStateHistory: (limit = 20) => request<MarketStateHistoryResponse>(`/api/market-state/history?limit=${limit}`),
  infoRunNow: () => post<InfoRunNowResponse>('/api/info/run-now'),
  infoEvents: (limit = 100) => request<InfoEventsResponse>(`/api/info/events?limit=${limit}`),
  /** 信息源与采集状态(只读;网关未提供时 404,页面标「网关未提供来源状态」) */
  infoSources: () => request<InfoSourcesResponse>('/api/info/sources'),
  scanNow: (symbol?: string) => post<ScanNowResponse>('/api/scan-now', symbol ? { symbol } : undefined),

  // ---- v2:策略线程 -------------------------------------------------------
  threads: (status: 'open' | 'all' = 'open') => request<ThreadsResponse>(`/api/threads?status=${status}`),
  thread: (id: string) => request<ThreadDetailResponse>(`/api/threads/${encodeURIComponent(id)}`),
  closeThread: (id: string) => post<StrategyThread>(`/api/threads/${encodeURIComponent(id)}/close`),
  reviewThread: (id: string) => post<{ episode_id: string }>(`/api/threads/${encodeURIComponent(id)}/review`),

  // ---- v2:下单面板 / 账户 -------------------------------------------------
  placeOrder: (payload: ManualOrderRequest) => post<ManualOrderResponse>('/api/orders', payload),
  openOrders: () => request<AccountView['open_orders']>('/api/orders/open'),
  positions: () => request<AccountView['positions']>('/api/positions'),
  /** 09-07:网络自检,n 次只读调用,同步等结果(agent_mcp 约 n×25 s)。 */
  netCheck: (n = 5) => post<{ result: NetCheckResult }>('/api/execution/net-check', { n }),
  /** 09-07:把无主持仓交给 agent 管(建线程);没交易所止损时 stop_price 必填。 */
  adoptPosition: (symbol: string, body: { market?: Market; stop_price?: string | null; take_profit?: string | null }) => post<{ thread: StrategyThread }>(`/api/positions/${encodeURIComponent(symbol)}/adopt`, body),
  symbols: () => request<SymbolsResponse>('/api/symbols'),
  /** §9.40:按市场取可交易列表(perp 走原路径,老网关兼容) */
  symbolsFor: (market: Market) => request<SymbolsResponse>(market === 'spot' ? '/api/symbols?market=spot' : '/api/symbols'),
  /** §9.40:现货 vs 永续基差;任一侧拉不到 → 404 basis_unavailable */
  basis: (symbol: string) => request<BasisView>(`/api/market/basis?symbol=${encodeURIComponent(symbol)}`),

  // ---- v2:对话 -----------------------------------------------------------
  chatMessages: (limit = 100, kind: 'chat' | 'narration' | 'all' = 'all', session?: string) =>
    request<ChatMessagesResponse>(`/api/chat/messages?limit=${limit}&kind=${kind}${session ? `&session=${encodeURIComponent(session)}` : ''}`),
  sendChat: (text: string, session?: string) => post<ChatSendResponse>('/api/chat/messages', session ? { text, session } : { text }),
  resetChat: (session?: string) => post<void>('/api/chat/reset', session ? { session } : undefined),
  // ---- v3.8(§9.14)对话会话。default 不能删(409);can_execute 自 §9.19 起只是前端偏好(意图卡是否显示执行按钮),后端不据它放行任何东西。
  chatSessions: (archived = false) => request<ChatSessionsResponse>(`/api/chat/sessions${archived ? '?archived=1' : ''}`),
  createChatSession: (title?: string, role?: BotRole) => post<{ session: ChatSession }>('/api/chat/sessions', { ...(title ? { title } : {}), ...(role ? { role } : {}) }),
  updateChatSession: (id: string, patch: { title?: string; archived?: boolean; can_execute?: boolean }) => post<{ session: ChatSession }>(`/api/chat/sessions/${encodeURIComponent(id)}`, patch),
  deleteChatSession: (id: string) => request<void>(`/api/chat/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ---- v3(docs/demo/v3-ui-contract.md):复盘 / 活动流 / 行情状态 --------------
  history: (limit = 200) => request<HistoryResponse>(`/api/history?limit=${limit}`),
  activity: (limit = 200, before?: number) => request<ActivityResponse>(`/api/activity?limit=${limit}${before ? `&before=${before}` : ''}`),
  regime: (symbol: string) => request<RegimeResponse>(`/api/market/regime?symbol=${encodeURIComponent(symbol)}`),

  // ---- v3:大脑选择 / 判断图 --------------------------------------------------
  brains: (refresh?: boolean) => request<BrainsResponse>(`/api/brains${refresh ? '?refresh=1' : ''}`),
  testBrain: (kind: BrainKind, model: string | null) => post<BrainTestResult>('/api/brains/test', { kind, model }),
  graph: () => request<GraphResponse>('/api/graph'),

  // ---- v3.3:执行后端(操作台)------------------------------------------------
  // 网关可能还没接这几个路由(另一位 agent 并行实现中),调用方一律 retry:0 + 缺省兜底。
  execution: () => request<ExecutionView>('/api/execution'),
  // §9.20 止损保护验证:网关自己用最小仓跑一遍 开→挂止损→确认→撤→平;202 started / 409 busy
  executionProtection: () => request<{ protection: ProtectionStatusView }>('/api/execution/protection'),
  verifyProtection: (symbol?: string, market?: Market) =>
    post<{ started: boolean; protection: ProtectionStatusView }>('/api/execution/verify-protection', { confirm: true, ...(symbol ? { symbol } : {}), ...(market ? { market } : {}) }),
  /** §9.20 告警自带动作:按 method/path/body 原样调 */
  alertAction: (a: RiskAlertAction) => send<unknown>(a.method, a.path, a.method === 'GET' ? undefined : (a.body ?? {})),
  resetModelBudget: () => post<ExecutionView>('/api/execution/model-budget/reset'),
  resetSettlementRetries: () => post<{ ok: boolean }>('/api/execution/settlement-retries/reset'),
  executionCheck: () => post<ExecutionView>('/api/execution/check'),
  executionConnect: () => post<ExecutionConnectResponse>('/api/execution/connect'),
  /**
   * OKX 的保护腿(附带止损/止盈)没法让网关自己花钱验:按 §7 人工在模拟盘上跑一遍,
   * 再点这个把 KV `okx.protection.verified` 置 1,通道才从 unverified 变 verified。
   */
  okxMarkVerified: () => post<ExecutionView>('/api/execution/okx/verified', { confirm: true }),
  /** §9.40:用户在 OKX 网页切完账户模式后轮询这里(只读);非 okx 通道 409 */
  okxRefreshAccountLevel: () => post<ExecutionView>('/api/execution/okx/account-level/refresh', {}),
  /** §9.40:切 OKX 账户模式(网关签名直打 set-account-level);持仓/挂单未清 409 account_not_flat,OKX 拒绝 409 okx_<code> */
  okxSetAccountLevel: (acctLv: 1 | 2 | 3 | 4) => post<{ ok: boolean; acct_lv: number; execution: ExecutionView }>('/api/execution/okx/account-level', { acctLv }),

  // ---- v3.4:币安 MCP 直连的工具映射(§9.8)—— 推断 → 编辑 → 只读测试 → 确认 ------------
  binanceMap: () => request<BinanceMapResponse>('/api/binance/map'),
  binanceMapPropose: () => post<BinanceMapResponse>('/api/binance/map/propose'),
  binanceMapPut: (map: McpToolMap | Record<string, unknown>) => send<BinanceMapResponse>('PUT', '/api/binance/map', map),
  binanceMapConfirm: () => post<BinanceMapResponse>('/api/binance/map/confirm'),
  binanceMapTest: (symbol?: string) => post<BinanceMapTestResponse>('/api/binance/map/test', symbol ? { symbol } : undefined),

  // ---- v3.2:长期记忆(docs/demo/memory.md)—— 提案 → 人工批准 → 召回进证据 --------
  memoryList: (status?: MemoryStatus[] | string, symbol?: string, limit = 300) => {
    const qs = new URLSearchParams();
    const statusParam = Array.isArray(status) ? status.join(',') : status;
    if (statusParam) qs.set('status', statusParam);
    if (symbol) qs.set('symbol', symbol);
    if (limit) qs.set('limit', String(limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<MemoryListResponse>(`/api/memory${suffix}`);
  },
  memorySearch: (q: string, symbol?: string) => {
    const qs = new URLSearchParams({ q });
    if (symbol) qs.set('symbol', symbol);
    return request<MemorySearchResponse>(`/api/memory/search?${qs.toString()}`);
  },
  memoryDetail: (id: string) => request<MemoryDetailResponse>(`/api/memory/${encodeURIComponent(id)}`),
  memoryCreate: (body: MemoryCreateRequest) => post<{ item: MemoryItem }>('/api/memory', body),
  memoryAction: (id: string, action: 'approve' | 'reject' | 'forget', reason?: string) =>
    post<{ item: MemoryItem }>(`/api/memory/${encodeURIComponent(id)}/${action}`, reason ? { reason } : undefined),
  memoryReflect: (limit?: number) => post<MemoryReflectResponse>('/api/memory/reflect', limit ? { limit } : undefined),

  // ---- v3.4:回放与盲测(docs/demo/v3-ui-contract.md §9.8)------------------------
  // 花钱的只有 startBacktest;调它之前必须先 backtestEstimate() 并让用户在确认框里看到 ¥。
  klinesHistory: (symbol: string, interval: string, from: number, to: number) =>
    request<KlinesHistoryResponse>(`/api/market/klines/history?symbol=${encodeURIComponent(symbol)}&interval=${interval}&from=${from}&to=${to}`),
  backtestEstimate: (q: {
    symbol: string;
    timeframe: string;
    from: number;
    to: number;
    mode: string;
    max_judgments?: number;
    review_every_close?: boolean;
    /**
     * v3.5:策略选择。**故意不写进 query string** —— 网关的 query 解析器把每个参数原样当字符串
     * 交给 normalizeParams,而 strategy_ids 只认数组,收到字符串会直接 400 把估算打挂。
     * 所以估算这一步落回 workflow 的默认策略集(候选根数可能与真正开跑时略有出入);
     * POST /api/backtest 走 JSON,那边是准的。
     */
    strategy_ids?: string[];
  }) => {
    const qs = new URLSearchParams({ symbol: q.symbol, timeframe: q.timeframe, from: String(q.from), to: String(q.to), mode: q.mode });
    if (q.max_judgments) qs.set('max_judgments', String(q.max_judgments));
    if (q.review_every_close !== undefined) qs.set('review_every_close', String(q.review_every_close));
    return request<BacktestEstimate>(`/api/backtest/estimate?${qs.toString()}`);
  },
  backtests: (limit = 50) => request<BacktestListResponse>(`/api/backtest?limit=${limit}`),
  backtest: (id: string) => request<BacktestDetailResponse>(`/api/backtest/${encodeURIComponent(id)}`),
  startBacktest: (body: {
    symbol: string;
    timeframe: string;
    from: number;
    to: number;
    mode: string;
    max_judgments: number;
    review_every_close: boolean;
    /** v3.5:这次拿哪几条策略判断(最多 4 条);缺省 = workflow.active_strategies。 */
    strategy_ids?: string[];
    /** v3.5:跑完顺手做一遍便宜大脑归因(会花钱)。 */
    attribute?: boolean;
  }) => post<BacktestStartResponse>('/api/backtest', body),
  cancelBacktest: (id: string) => post<{ cancelled: boolean }>(`/api/backtest/${encodeURIComponent(id)}/cancel`),

  // ---- v3.5:策略库 + 回测归因(docs/design/strategy-library-2026-09-05.md)---------------
  // 红线:这里没有一条能直接改在跑的策略的数字。改参数 = proposeStrategyVersion 落一个 draft
  // 新版本,再一格一格 promoteStrategy;paper → live_capped 必须带 confirm:true。
  // runBacktestAttribution 调的是便宜大脑,**会花钱**,按钮上必须说清楚。
  strategies: (includeRetired = false) => request<StrategiesResponse>(`/api/strategies${includeRetired ? '?include_retired=1' : ''}`),
  strategyDetail: (id: string) => request<StrategyDetailResponse>(`/api/strategies/${encodeURIComponent(id)}`),
  setActiveStrategies: (ids: string[]) => post<StrategyActiveResponse>('/api/strategies/active', { ids }),
  // §9.27 晋升时间线(旧的在前,最多 500 行);§9.28 一键启用 / 停用(网关自己在现有集合上增删一个 id,
  // 前端不拼全集;状态不够格时 409 + errors)。
  strategyTimeline: (id: string) => request<StrategyTimelineResponse>(`/api/strategies/${encodeURIComponent(id)}/timeline`),
  activateStrategy: (id: string) => post<StrategyToggleResponse>(`/api/strategies/${encodeURIComponent(id)}/activate`),
  deactivateStrategy: (id: string) => post<StrategyToggleResponse>(`/api/strategies/${encodeURIComponent(id)}/deactivate`),
  proposeStrategyVersion: (
    id: string,
    body: { params?: Record<string, number>; rules?: Partial<StrategySpec['rules']>; name?: string; attribution_id?: string },
  ) => post<StrategyMutationResponse>(`/api/strategies/${encodeURIComponent(id)}/propose-version`, body),
  promoteStrategy: (id: string, to: StrategyStatus, confirm = false) =>
    post<StrategyMutationResponse>(`/api/strategies/${encodeURIComponent(id)}/promote`, confirm ? { to, confirm: true } : { to }),
  retireStrategy: (id: string) => post<StrategyRetireResponse>(`/api/strategies/${encodeURIComponent(id)}/retire`),

  // §9.35 策略自动轮换 allocator。红线:它只动 workflow.active_strategies 这一个数组,
  // 台账 who 只会是 code / human —— **模型没有任何一条路径能改票池**。
  // allocator() 里的 decision 是**预览**(不落库);要真落必须走 runAllocator。
  allocator: () => request<AllocatorView>('/api/strategies/allocator'),
  setAllocatorMode: (mode: AllocatorMode) => post<AllocatorModeResponse>('/api/strategies/allocator/mode', { mode }),
  /** manual 模式下只有 force=true 才落库,否则 applied=false 只回预览。 */
  runAllocator: (force = false) => post<AllocatorRunResponse>('/api/strategies/allocator/run', { force }),
  /** 一步换回上一票池(人的撤销键,不受最短驻留 / 冷却约束);没有上一票池时 409。 */
  rollbackAllocator: () => post<AllocatorRollbackResponse>('/api/strategies/allocator/rollback', {}),
  // §9.34 改证据集:evidence 进 content_hash,所以网关一定出一个新 draft(201),不改旧版本;
  // `evidence: null` = 清空回默认集;同一套证据再存一次是 409(内容没有变化)。
  putStrategyEvidence: (id: string, evidence: StrategyEvidenceSpec | null) =>
    send<StrategyEvidenceResponse>('PUT', `/api/strategies/${encodeURIComponent(id)}/evidence`, { evidence }),
  // §9.34 一次判断的证据来源明细(id = episode_id);老 episode 没有计划快照时 evidence_plan 为 null。
  judgmentDetail: (episodeId: string) => request<JudgmentDetailResponse>(`/api/judgments/${encodeURIComponent(episodeId)}`),
  // §9.37 归因报告(只读,零模型)。两条都支持 backend / since / window_days 收窄窗口。
  attributionSummary: (params: { backend?: string; window_days?: number } = {}) =>
    request<AttributionSummaryResponse>(`/api/attribution/summary${qs(params)}`),
  strategyAttribution: (id: string, params: { version?: number; backend?: string; window_days?: number } = {}) =>
    request<StrategyAttributionResponse>(`/api/strategies/${encodeURIComponent(id)}/attribution${qs(params)}`),
  backtestAttribution: (id: string) => request<BacktestAttributionResponse>(`/api/backtest/${encodeURIComponent(id)}/attribution`),
  runBacktestAttribution: (id: string) => post<BacktestAttributeResponse>(`/api/backtest/${encodeURIComponent(id)}/attribute`),

  // ---- v3.6:雷达 / 筛选器 + 机器人团队(网关 src/demo/screener.ts、bots.ts)-----------
  // runScreener 会花钱(可选的便宜大脑那一遍)且可能被 409 拒(该 horizon 正在跑 / 运行时暂停);
  // applyScreen 只改 workflow.watchlist 一个字段,调用前必须先给人看 before → after 的 diff。
  screenerLatest: (horizon: ScreenHorizon) => request<ScreenerLatestResponse>(`/api/screener/latest?horizon=${horizon}`),
  screenerHistory: (horizon: ScreenHorizon, limit = 20) =>
    request<ScreenerHistoryResponse>(`/api/screener/history?horizon=${horizon}&limit=${limit}`),
  screen: (id: string) => request<ScreenerDetailResponse>(`/api/screener/${encodeURIComponent(id)}`),
  runScreener: (horizon: ScreenHorizon) => post<ScreenerRunResponse>('/api/screener/run', { horizon }),
  /** watchlist = 用户勾选后的最终名单;不传就整包应用提案。 */
  applyScreen: (id: string, watchlist?: string[]) =>
    post<ScreenerApplyResponse>(`/api/screener/${encodeURIComponent(id)}/apply`, watchlist ? { watchlist } : {}),
  bots: () => request<BotsResponse>('/api/bots'),
  setBotEnabled: (role: BotRole | 'all', enabled: boolean) => post<Pick<BotsResponse, 'bots'>>(`/api/bots/${role}/enabled`, { enabled }),
  botHandoffs: (status?: HandoffStatus, limit = 20) => {
    const qs = new URLSearchParams();
    if (status) qs.set('status', status);
    if (limit) qs.set('limit', String(limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<BotHandoffsResponse>(`/api/bots/handoffs${suffix}`);
  },
  ackHandoff: (id: string) => post<BotHandoffAckResponse>(`/api/bots/handoffs/${encodeURIComponent(id)}/ack`),
  // ---- v3.7:Portfolio / Risk(gateway 65bb92a)。resolve 只对 recovery_ready 的 high/critical 生效,否则 409。
  portfolioSnapshot: () => request<PortfolioSnapshotResponse>('/api/portfolio/snapshot'),
  /** §9.18 组合容量:还能开几条、每币可做/要多少权益 */
  portfolioCapacity: () => request<PortfolioCapacityResponse>('/api/portfolio/capacity'),
  riskAlerts: (status: 'open' | 'resolved' | 'all' = 'open') => request<RiskAlertsResponse>(`/api/risk/alerts?status=${status}`),
  ackRiskAlert: (id: string) => post<{ alert: RiskAlertRow }>(`/api/risk/alerts/${encodeURIComponent(id)}/ack`),
  resolveRiskAlert: (id: string) => post<{ alert: RiskAlertRow }>(`/api/risk/alerts/${encodeURIComponent(id)}/resolve`),
  recoverAllRisk: () => post<{ resolved: RiskAlertRow[]; level: string }>('/api/risk/recover-all'),
  riskEvaluate: () => post<RiskAlertsResponse>('/api/risk/evaluate'),
  // ---- v3.8:Reviewer(gateway 7102cd3)。batch 会调便宜大脑(≤ 2 次/天),409 = 不该跑。
  reviewerCards: (limit = 20) => request<ReviewerCardsResponse>(`/api/reviewer/cards?limit=${limit}`),
  reviewerBatch: () => post<ReviewerBatchResponse>('/api/reviewer/batch'),
  // ---- v3.9:Strategy Lab / Gate Captain(gateway c19646d,零模型)。labRun 202 跑几十秒,同 manifest 24h 内返回上一次。
  labExperiments: (limit = 10) => request<LabExperimentsResponse>(`/api/lab/experiments?limit=${limit}`),
  labRun: () => post<{ run_id?: string; reason?: string }>('/api/lab/run'),
  captainBrief: () => request<CaptainBriefResponse>('/api/captain/brief'),
  captainBriefNow: () => post<CaptainBriefResponse>('/api/captain/brief'),

  // ---- v3.12 §9.29:判断准确度账本(只读,零模型)。summary 的 by_strategy 里
  // '(未指明策略)' 是前端不可用的查参数(网关按 strategy_id IS NULL 归进去的),
  // 要看它的行就不带 strategy_id 拉,再在前端筛 strategy_id === null。
  judgmentLedger: (opts?: { since?: number | null; strategyId?: string | null; limit?: number; offset?: number; cursor?: string | null }) => {
    const qs = new URLSearchParams();
    if (opts?.since) qs.set('since', String(opts.since));
    if (opts?.strategyId) qs.set('strategy_id', opts.strategyId);
    if (opts?.limit) qs.set('limit', String(opts.limit));
    if (opts?.offset) qs.set('offset', String(opts.offset));
    if (opts?.cursor) qs.set('cursor', opts.cursor);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<JudgmentLedgerResponse>(`/api/judgment-ledger${suffix}`);
  },
  judgmentLedgerSummary: (since?: number | null) => request<LedgerSummary>(`/api/judgment-ledger/summary${since ? `?since=${since}` : ''}`),

  // ---- v3.12 §9.30:事件区。**路径是 /api/market-events**,/api/events 是 SSE 长连接,别占。
  // 写操作只有补录和 dismiss,两个都不碰钱。
  marketEvents: (opts?: { status?: string; asset?: string; subkind?: string; since?: number; limit?: number }) => {
    const qs = new URLSearchParams();
    if (opts?.status) qs.set('status', opts.status);
    if (opts?.asset) qs.set('asset', opts.asset);
    if (opts?.subkind) qs.set('subkind', opts.subkind);
    if (opts?.since) qs.set('since', String(opts.since));
    if (opts?.limit) qs.set('limit', String(opts.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<MarketEventsResponse>(`/api/market-events${suffix}`);
  },
  marketEvent: (id: string) => request<MarketEventDetailResponse>(`/api/market-events/${encodeURIComponent(id)}`),
  createMarketEvent: (body: MarketEventCreateRequest) => post<MarketEventCreateResponse>('/api/market-events', body),
  dismissMarketEvent: (id: string) => post<{ event: MarketEventsResponse['events'][number] }>(`/api/market-events/${encodeURIComponent(id)}/dismiss`),

  // ---- 2026-09-20 信号市场(Signal Market · OKX.AI ASP;设计 docs/design/asp-market-2026-09-20.md,
  // 契约 §9.39)。跟单流水线(ingest → 判定 → 人工 apply/skip/reconcile)沿用 /api/follow/*,
  // 信号源只剩 OKX.AI 订阅投递;买 / 卖 / 账本 / 售后走 /api/market/*。
  // §9.39:GET/POST /api/follow 直接是 MarketSettings;待办与采集状态挂在 /api/follow/signals 上。
  // 页面仍然用 FollowOverview 这个组合视图,由 market-adapt.composeOverview 拼出来。
  follow: async (): Promise<FollowOverview> => {
    const [settings, sig] = await Promise.all([request<unknown>('/api/follow'), request<unknown>('/api/follow/signals?limit=1')]);
    return composeOverview(adaptSettings(settings), sig);
  },
  setFollow: async (body: { follow: Partial<MarketSettings> }): Promise<FollowOverview & { errors: string[] }> => {
    const { publisher, ...rest } = body.follow;
    const wire: Record<string, unknown> = { ...rest };
    if (publisher) wire['publisher'] = publisherToWire(publisher);
    const settings = await post<unknown>('/api/follow', wire);
    const sig = await request<unknown>('/api/follow/signals?limit=1');
    return { ...composeOverview(adaptSettings(settings), sig), errors: [] };
  },
  followSignals: async (opts?: { job_id?: string; symbol?: string; status?: TraderSignalStatus; action?: TraderAction; limit?: number }): Promise<FollowSignalsResponse> => {
    const r = await request<{ signals: TraderSignal[]; connection: unknown }>(`/api/follow/signals${qs({ job_id: opts?.job_id, symbol: opts?.symbol, status: opts?.status, action: opts?.action, limit: opts?.limit })}`);
    return { signals: r.signals, inbox: adaptInboxStatus(r.connection) };
  },
  // apply 是唯一真的会开仓的入口(既有手动开仓链路);管理动作的 review_only 行只给「跳过」。
  // force_stale:超龄信号要人显式确认一次才按旧价开;过了 valid_until 网关一律不给开。
  applyFollowSignal: (id: string, opts?: { force_stale?: boolean }) => post<FollowSignalActionResponse>(`/api/follow/signals/${encodeURIComponent(id)}/apply`, opts?.force_stale ? { force_stale: true } : {}),
  // `needs_reconcile` 是行上的独立标记;这个接口只清标记,不动钱、不改状态。
  reconcileFollowSignal: (id: string) => post<FollowSignalActionResponse>(`/api/follow/signals/${encodeURIComponent(id)}/reconcile`, {}),
  skipFollowSignal: (id: string, note?: string) => post<FollowSignalActionResponse>(`/api/follow/signals/${encodeURIComponent(id)}/skip`, note ? { note } : {}),

  // ---- /api/market/*:网关透传 OKX CLI 的 data 原样,这里过一遍 market-adapt 映射成视图类型 ----
  marketStatus: async (fresh?: boolean): Promise<MarketStatus> => {
    const [raw, settings] = await Promise.all([request<unknown>(`/api/market/status${fresh ? '?fresh=1' : ''}`), request<unknown>('/api/market/settings')]);
    return adaptStatus(raw, adaptSettings(settings));
  },
  marketSearch: (opts: { keywords?: string; after?: string; trial?: boolean; max_fee?: string }): Promise<MarketSearchResponse> =>
    request<unknown>(`/api/market/search${qs({ keywords: opts.keywords, after: opts.after, trial: opts.trial ? 1 : undefined, max_fee: opts.max_fee })}`).then(adaptSearch),
  marketCatalog: (opts: { category?: string; q?: string; monthly?: boolean; trial?: boolean; sort?: string; page?: number; page_size?: number; refresh?: boolean }) =>
    request<CatalogResponse>(`/api/market/catalog${qs({ category: opts.category, q: opts.q, monthly: opts.monthly ? 1 : undefined, trial: opts.trial ? 1 : undefined, sort: opts.sort, page: opts.page, page_size: opts.page_size, refresh: opts.refresh ? 1 : undefined })}`),
  marketCatalogRefresh: () => post<{ building: boolean }>('/api/market/catalog/refresh', {}),
  marketCatalogDetail: (agentId: string) => request<CatalogDetail>(`/api/market/catalog/${encodeURIComponent(agentId)}`),
  /** 按 ASP 列它在 CLI 里的全部服务(订阅要用 serviceId uuid / feeToken 地址,只有 service-match 给)。 */
  marketServicesOf: (aspAgentId: string): Promise<MarketSearchResponse> => request<unknown>(`/api/market/search${qs({ asp_agent_id: aspAgentId })}`).then(adaptSearch),
  marketAspDetail: (agentId: string): Promise<MarketAspDetail> => request<unknown>(`/api/market/asp/${encodeURIComponent(agentId)}`).then(adaptAspDetail),
  marketSubscribe: async (body: MarketSubscribeRequest): Promise<MarketSubscribeResponse> => {
    const r = await post<{ jobId: string | null; funding_notice: unknown; configured?: boolean; error?: string }>('/api/market/subscribe', body);
    return { ok: !!r.jobId, job_id: r.jobId ?? null, funding_notice: adaptFundingNotice(r.funding_notice), message: r.error ?? null, device_added: r.configured === true };
  },
  marketScorecard: (jobId: string, force = false): Promise<MarketScorecard> => request<MarketScorecard>(`/api/market/subscriptions/${encodeURIComponent(jobId)}/scorecard${force ? '?force=1' : ''}`),
  marketSubscriptions: (): Promise<MarketSubscriptionsResponse> => request<unknown>('/api/market/subscriptions').then(adaptSubscriptions),
  marketPatchSubscription: async (jobId: string, body: Partial<MarketSubscriptionConfig> & { this_device_receives?: boolean }): Promise<MarketSubscriptionsResponse> => {
    await send<unknown>('PATCH', `/api/market/subscriptions/${encodeURIComponent(jobId)}`, body);
    return request<unknown>('/api/market/subscriptions').then(adaptSubscriptions);
  },
  marketCancelSubscription: async (jobId: string): Promise<MarketSubscriptionsResponse> => {
    await post<unknown>(`/api/market/subscriptions/${encodeURIComponent(jobId)}/cancel`, {});
    return request<unknown>('/api/market/subscriptions').then(adaptSubscriptions);
  },
  marketRejectSubscription: async (jobId: string, reason: string): Promise<MarketSubscriptionsResponse> => {
    await post<unknown>(`/api/market/subscriptions/${encodeURIComponent(jobId)}/reject`, { reason });
    return request<unknown>('/api/market/subscriptions').then(adaptSubscriptions);
  },
  marketAutorenewSubscription: async (jobId: string): Promise<MarketSubscriptionsResponse> => {
    await post<unknown>(`/api/market/subscriptions/${encodeURIComponent(jobId)}/autorenew`, {});
    return request<unknown>('/api/market/subscriptions').then(adaptSubscriptions);
  },
  marketInbox: (opts?: { job_id?: string; status?: string; limit?: number }): Promise<MarketInboxResponse> => {
    // 页面的 parse_status 名 → 网关的(ingested→order,bad→invalid)。
    const wire = opts?.status === 'ingested' ? 'order' : opts?.status === 'bad' ? 'invalid' : opts?.status;
    return request<unknown>(`/api/market/inbox${qs({ job_id: opts?.job_id, status: wire, limit: opts?.limit })}`).then(adaptInbox);
  },
  marketInboxPoll: () => post<{ pulled: number; handled: number; skipped_analysis: number; bad_rows: number; error: string | null }>('/api/market/inbox/poll', {}),
  marketSettings: (): Promise<MarketSettings> => request<unknown>('/api/market/settings').then(adaptSettings),
  setMarketSettings: async (body: Partial<MarketSettings>): Promise<MarketSettings & { errors?: string[] }> => {
    const { publisher, ...rest } = body;
    const wire: Record<string, unknown> = { ...rest };
    if (publisher) wire['publisher'] = publisherToWire(publisher);
    return adaptSettings(await post<unknown>('/api/market/settings', wire));
  },
  marketWalletDepositNotice: (): Promise<MarketFundingNotice> => post<unknown>('/api/market/wallet/deposit-notice', {}).then((r) => adaptFundingNotice(r) ?? { deposit_address: null, currency: 'USDT', shortfall: null, qr_png_base64: null, text: null }),
  marketAsp: async (): Promise<MarketAsp> => {
    const [raw, settings, deliveries] = await Promise.all([request<unknown>('/api/market/asp'), request<unknown>('/api/market/settings'), request<unknown>('/api/market/asp/deliveries?limit=200').catch(() => ({ deliveries: [] }))]);
    return adaptAsp(raw, adaptSettings(settings).publisher, list(obj(deliveries)['deliveries']).map(adaptDelivery));
  },
  marketAspValidate: (form: MarketRegisterForm) => post<MarketValidateResponse>('/api/market/asp/validate', { name: form.name, description: form.description, service_name: form.service_name, service_description: form.service_description, pricing: form.pricing, fee: form.fee }),
  marketAspRegister: (form: MarketRegisterForm, avatar: File): Promise<MarketRegisterResponse> => {
    const fd = new FormData();
    for (const k of ['name', 'description', 'service_name', 'service_description', 'pricing', 'fee'] as const) fd.append(k, String(form[k]));
    fd.append('avatar', avatar);
    return request<unknown>('/api/market/asp/register', { method: 'POST', body: fd }).then(adaptRegister);
  },
  marketAspActivate: async (): Promise<MarketAsp> => {
    await post<unknown>('/api/market/asp/activate', {});
    return api.marketAsp();
  },
  marketAspDeactivate: async (): Promise<MarketAsp> => {
    await post<unknown>('/api/market/asp/deactivate', {});
    return api.marketAsp();
  },
  marketAspClaim: async (): Promise<MarketAsp> => {
    await post<unknown>('/api/market/asp/claim', {});
    return api.marketAsp();
  },
  marketAspAftersale: async (jobId: string, body: { decision: 'agree_refund' | 'dispute'; reason?: string }): Promise<MarketAsp> => {
    await post<unknown>(`/api/market/asp/aftersales/${encodeURIComponent(jobId)}`, body);
    return api.marketAsp();
  },
  marketAspDeliveries: (limit = 100): Promise<MarketDeliveriesResponse> => request<unknown>(`/api/market/asp/deliveries?limit=${limit}`).then((r) => ({ deliveries: list(obj(r)['deliveries']).map(adaptDelivery) })),
  marketAspRetryDelivery: (eventId: string, jobId?: string): Promise<MarketDeliveryOut> => post<unknown>(`/api/market/asp/deliveries/${encodeURIComponent(eventId)}/retry`, jobId ? { job_id: jobId } : {}).then(adaptDelivery),
  marketAspPreview: (): Promise<MarketPreview> => post<{ payload: Record<string, unknown>; text: string }>('/api/market/asp/preview', {}).then((r) => ({ text: r.text, payload: r.payload, blocked_reason: null })),

  /** 三盏灯:钱包 / A2A 守护 / Trade Kit。网关缓存 30s,`fresh` 强刷。 */
  okxAccount: (fresh?: boolean) => request<OkxAccountStatus>(`/api/okx/account${fresh ? '?fresh=1' : ''}`),
  // ---- 2026-09-20 一键接入:凭证经网关转交 okx CLI 一次,不落盘;钱包只做登录态 + 登录/登出 ----
  okxSetup: (body: OkxSetupRequest) => post<OkxSetupResponse>('/api/execution/okx/setup', body),
  okxInstall: () => post<OkxInstallResponse>('/api/execution/okx/install', {}),
  okxUse: (profile: string) => post<OkxStatus>('/api/execution/okx/use', { profile }),
  okxRemove: (profile: string) => post<OkxStatus>('/api/execution/okx/remove', { profile }),
  wallet: (fresh?: boolean) => request<WalletStatus>(`/api/wallet${fresh ? '?refresh=1' : ''}`),
  walletAssets: (fresh?: boolean) => request<WalletAssets>(`/api/wallet/assets${fresh ? '?refresh=1' : ''}`),
  walletLogin: () => post<WalletLoginInit>('/api/wallet/login', {}),
  walletLoginPoll: (session_id: string) => post<WalletStatus>('/api/wallet/login/poll', { session_id }),
  walletLogout: () => post<WalletStatus>('/api/wallet/logout', {}),
  okxMcp: () => request<OkxMcpStatus>('/api/execution/okx/mcp'),
  okxMcpRegister: () => post<OkxMcpStatus>('/api/execution/okx/mcp/register', {}),

  // ---- §9.52 模型连接与角色底层(pages/models.tsx)---------------------------------
  // key 只上行不下行:响应里永远只有 key_masked。老网关没这组路由,调用方 retry:0 + 缺省兜底。
  models: () => request<ModelsView>('/api/models'),
  createModelConnection: (body: ModelConnectionInput) => post<ModelConnection>('/api/models/connections', body),
  /** api_key 缺省 / 空串 = 不改 */
  patchModelConnection: (id: string, body: ModelConnectionPatch) => send<ModelConnection>('PATCH', `/api/models/connections/${encodeURIComponent(id)}`, body),
  /** 有角色绑定时 409 connection_in_use,ApiRequestError.body.roles 列出占用的角色 */
  deleteModelConnection: (id: string) => send<{ ok: true }>('DELETE', `/api/models/connections/${encodeURIComponent(id)}`),
  /** 可能要几秒到几十秒(CLI 最长 ~90s) */
  testModelConnection: (id: string, model?: string | null) => post<ModelConnectionTest>(`/api/models/connections/${encodeURIComponent(id)}/test`, model ? { model } : {}),
  putModelBinding: (role: ModelRole, connection_id: string | null, model: string | null) => send<ModelsView>('PUT', `/api/models/bindings/${encodeURIComponent(role)}`, { connection_id, model }),
  /** 按角色测试(#models 每张 agent 卡的「测试连接」);CLI 可能要一分多钟 */
  testModelRole: (role: ModelRole) => post<RoleTestResult>(`/api/models/bindings/${encodeURIComponent(role)}/test`, {}),
};

export { ApiRequestError };

type EventHandlers = Partial<{ [K in keyof ServerEventMap]: (data: ServerEventMap[K]) => void }>;

const EVENT_NAMES: (keyof ServerEventMap)[] = [
  'market_event',
  'research_task',
  'loop.state',
  'episode.started',
  'episode.finished',
  'strategy.changed',
  'intent.changed',
  'account.updated',
  'market.tick',
  'log',
  'market_state.updated',
  'thread.changed',
  'chat.message',
  'queue.state',
  'workflow.changed',
  'activity',
  'memory.changed',
  'execution.changed',
  'backtest.progress',
  'backtest.changed',
  // v3.6
  'screener.changed',
  'bots.changed',
  // v3.7
  'portfolio.changed',
  'risk.changed',
  // v3.13
  'trader_signal',
  // 2026-09-20 信号市场
  'market_delivery',
  'market_publish',
  'market_subscription',
  'market_aftersale',
  // §9.51 策略一键运行
  'strategy_run.updated',
  'strategy_run.event',
  // §9.52 模型连接 / 角色绑定变了(data = ModelsView)
  'models.changed',
];

/**
 * 订阅 GET /api/events(SSE)。按 event 名分别注册 handler。
 * 自己管连接生命周期(不依赖浏览器 EventSource 的原生重连),1s 起指数退避到 30s 封顶,
 * 一连上就把退避计数清零。
 *
 * 整个页面只开**一条** SSE 连接:所有 useLiveEvents 调用共享它(引用计数,最后一个卸载才关)。
 * 以前每个调用点各开一条,事件页一挂载就把 market.tick / log 这些高频事件整份收两遍,
 * 每条都打一次 query 缓存,是页面卡顿的主因之一。
 */
type Subscriber = { handlers: { current: EventHandlers }; connected: { current: (ok: boolean) => void } };
const sseSubscribers = new Set<Subscriber>();
let sseSource: EventSource | null = null;
let sseRetryTimer: number | undefined;
let sseRetryMs = 1000;
let sseOpen = false;

function sseConnect(): void {
  if (sseSource || sseSubscribers.size === 0) return;
  const es = new EventSource('/api/events');
  sseSource = es;
  for (const name of EVENT_NAMES) {
    es.addEventListener(name, ((ev: MessageEvent) => {
      let data: unknown;
      try {
        data = JSON.parse(ev.data);
      } catch (err) {
        console.error(`[sse] 解析 ${name} 事件失败`, err);
        return;
      }
      for (const sub of sseSubscribers) {
        const handler = sub.handlers.current[name];
        if (!handler) continue;
        try {
          (handler as (d: unknown) => void)(data);
        } catch (err) {
          console.error(`[sse] 处理 ${name} 事件失败`, err);
        }
      }
    }) as EventListener);
  }
  es.addEventListener('open', () => {
    sseRetryMs = 1000;
    sseOpen = true;
    for (const sub of sseSubscribers) sub.connected.current(true);
  });
  es.addEventListener('error', () => {
    sseOpen = false;
    for (const sub of sseSubscribers) sub.connected.current(false);
    es.close();
    if (sseSource === es) sseSource = null;
    if (sseSubscribers.size === 0) return;
    sseRetryTimer = window.setTimeout(sseConnect, sseRetryMs);
    // 本机网关重启通常几十秒到几分钟,封顶 5s 让恢复后尽快重连(重连会触发整页刷新)。
    sseRetryMs = Math.min(5_000, sseRetryMs * 2);
  });
}

function sseDisconnectIfIdle(): void {
  if (sseSubscribers.size > 0) return;
  if (sseRetryTimer) window.clearTimeout(sseRetryTimer);
  sseRetryTimer = undefined;
  sseSource?.close();
  sseSource = null;
  sseOpen = false;
}

export function useLiveEvents(handlers: EventHandlers, connected: (ok: boolean) => void = () => {}): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const connectedRef = useRef(connected);
  connectedRef.current = connected;

  useEffect(() => {
    const sub: Subscriber = { handlers: handlersRef, connected: connectedRef };
    sseSubscribers.add(sub);
    sseConnect();
    // 连接早就开着:新订阅者也要知道当前状态
    if (sseOpen) connectedRef.current(true);
    return () => {
      sseSubscribers.delete(sub);
      sseDisconnectIfIdle();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** 简单的 fetch-once hook,给静态/一次性加载的数据用。 */
export function useFetch<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fn()
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading };
}

// ---------------------------------------------------------------------------
// 研究工作台(docs/research/claude-frontend-handoff.md §3):/api/research/*。
// 只读 + 发起实验;没有任何交易所写入口。react-query key 前缀 ['research', ...]。
import type {
  ResearchArtifact,
  ResearchAttributionResponse,
  ResearchChatDetail,
  ResearchPrecheckResponse,
  ResearchCapabilities,
  ResearchChatResponse,
  ResearchCompileResponse,
  ResearchPrimitive,
  ResearchScreenResponse,
  ResearchUniverse,
  StrategyIR,
  ResearchDatasetFromMarketResponse,
  ResearchDatasetSummary,
  ResearchEstimate,
  ResearchEvent,
  ResearchEvidenceResponse,
  ResearchExecution,
  OrderGateParams,
  ResearchReplayResponse,
  ResearchRequest,
  ResearchResultResponse,
  ResearchRunSummary,
  ResearchStudy,
  // §9.44 研究会话
  ResearchInquiry,
  ResearchInquiryEventsResponse,
  ResearchMessageSendResponse,
  ResearchSession,
  ResearchSessionContext,
  ResearchSessionDetail,
  ResearchSessionsResponse,
  ResearchSnapshot,
  ResearchToolsResponse,
} from './research-types';

export const researchApi = {
  capabilities: () => request<ResearchCapabilities>('/api/research/capabilities'),
  datasets: () => request<{ items: ResearchDatasetSummary[] }>('/api/research/datasets'),
  datasetFromMarket: (body: { symbol: string; timeframe: string; from_ms: number; to_ms: number }) => post<ResearchDatasetFromMarketResponse>('/api/research/datasets/from-market', body),
  importDataset: (dataset: unknown) => post<{ id: string; bars: number }>('/api/research/datasets', dataset),
  study: (id: string) => request<ResearchStudy>(`/api/research/studies/${encodeURIComponent(id)}`),
  createStudy: (study: ResearchStudy) => post<ResearchStudy>('/api/research/studies', study),
  estimate: (req: ResearchRequest) => post<ResearchEstimate>('/api/research/estimate', req),
  startRun: (req: ResearchRequest) => post<ResearchRunSummary>('/api/research/runs', req),
  runs: () => request<{ items: ResearchRunSummary[] }>('/api/research/runs'),
  run: (id: string) => request<ResearchRunSummary>(`/api/research/runs/${encodeURIComponent(id)}`),
  result: (id: string) => request<ResearchResultResponse>(`/api/research/runs/${encodeURIComponent(id)}/result`),
  events: (id: string, after = 0) => request<{ items: ResearchEvent[]; next_cursor: number }>(`/api/research/runs/${encodeURIComponent(id)}/events?after=${after}`),
  evidence: (id: string, offset = 0) => request<ResearchEvidenceResponse>(`/api/research/runs/${encodeURIComponent(id)}/evidence?offset=${offset}`),
  exportRun: (id: string) => request<unknown>(`/api/research/runs/${encodeURIComponent(id)}/export`),
  cancel: (id: string) => post<ResearchRunSummary>(`/api/research/runs/${encodeURIComponent(id)}/cancel`, {}),
  replay: (id: string) => post<ResearchReplayResponse>(`/api/research/runs/${encodeURIComponent(id)}/replay`, {}),
  chat: (message: string, run_id: string | undefined, max_rounds = 6) => post<ResearchChatResponse>('/api/research/chat', { message, ...(run_id ? { run_id } : {}), max_rounds }),
  // ---- 第二轮(research round 2):资产池 / screen / 原语 / IR 编译 / 归因
  universes: () => request<{ items: ResearchUniverse[] }>('/api/research/universes'),
  universe: (id: string) => request<ResearchUniverse>(`/api/research/universes/${encodeURIComponent(id)}`),
  createUniverse: (body: { symbols: string[]; timeframe: string; from_ms: number; to_ms: number; market_factor: { kind: string; symbols: string[] } }) => post<ResearchUniverse>('/api/research/universes', body),
  screen: (id: string, opts: { window_bars?: number; as_of?: number; lookback_bars?: number } = {}) => request<ResearchScreenResponse>(`/api/research/universes/${encodeURIComponent(id)}/screen${qs(opts)}`),
  primitives: () => request<{ items: ResearchPrimitive[] }>('/api/research/primitives'),
  compileStrategy: (body: { text?: string; ir?: StrategyIR; timeframe: string; dataset_id?: string; execution?: ResearchExecution; order_gate?: OrderGateParams }) => post<ResearchCompileResponse>('/api/research/strategies/compile', body),
  attribution: (runId: string) => request<ResearchAttributionResponse>(`/api/research/runs/${encodeURIComponent(runId)}/attribution`),
  // ---- 第三轮(research round 3):研究沙箱产物、chat 详情、策略体检
  artifact: (id: string) => request<ResearchArtifact>(`/api/research/artifacts/${encodeURIComponent(id)}`),
  chatDetail: (id: string) => request<ResearchChatDetail>(`/api/research/chats/${encodeURIComponent(id)}`),
  chatWithRounds: (message: string, run_id: string | undefined, max_rounds = 16) => post<ResearchChatResponse>('/api/research/chat', { message, ...(run_id ? { run_id } : {}), max_rounds }),
  precheck: (body: Record<string, unknown>) => post<ResearchPrecheckResponse>('/api/research/strategies/precheck', body),
  /**
   * 第四轮:不带 text 的 compile = 零模型调用,只做规范校验并翻出可读规则卡。
   * 给任意 run 的 strategy_ir 要 rules / spec / constraints 时走这条;缓存 key ['research','rules', hash]。
   */
  strategyRules: (body: { ir: StrategyIR; timeframe: string; dataset_id?: string; execution?: ResearchExecution; order_gate?: OrderGateParams }) =>
    post<ResearchCompileResponse>('/api/research/strategies/compile', body),

  // ---- §9.44 研究会话与研究 loop(contract docs/demo/v3-ui-contract.md §9.44)
  // 恢复历史只靠 session(id);刷新不重发消息、不产生新调用。接口未就绪时一律 404 → 页面走空态。
  sessions: (limit = 40) => request<ResearchSessionsResponse>(`/api/research/sessions?limit=${limit}`),
  createSession: (title?: string) => post<ResearchSession>('/api/research/sessions', title ? { title } : {}),
  session: (id: string) => request<ResearchSessionDetail>(`/api/research/sessions/${encodeURIComponent(id)}`),
  patchSessionContext: (id: string, context: ResearchSessionContext) =>
    send<ResearchSession>('PATCH', `/api/research/sessions/${encodeURIComponent(id)}/context`, context),
  /** 202 {message, inquiry};同 idempotency_key 重发返回同一 inquiry(不重跑),会话忙 → 409 research_session_busy */
  sendSessionMessage: (id: string, body: { text: string; idempotency_key: string; context?: ResearchSessionContext }) =>
    post<ResearchMessageSendResponse>(`/api/research/sessions/${encodeURIComponent(id)}/messages`, body),
  revisionContext: (id: string) => request<ResearchRevisionContext>(`/api/research/runs/${encodeURIComponent(id)}/revision-context`),
  researchCommand: (id: string, body: { command: ResearchRevisionCommand; idempotency_key: string }) => post<ResearchMessageSendResponse>(`/api/research/sessions/${encodeURIComponent(id)}/commands`, body),
  inquiry: (id: string) => request<ResearchInquiry>(`/api/research/inquiries/${encodeURIComponent(id)}`),
  answerInquiry: (id: string, text: string) => post<ResearchInquiry>(`/api/research/inquiries/${encodeURIComponent(id)}/answer`, { text }),
  cancelInquiry: (id: string) => post<{ status: string }>(`/api/research/inquiries/${encodeURIComponent(id)}/cancel`, {}),
  /** 断线补发:按 seq 去重后合进 ['research','inquiry-live',id] */
  inquiryEvents: (id: string, after = 0) => request<ResearchInquiryEventsResponse>(`/api/research/inquiries/${encodeURIComponent(id)}/events?after=${after}`),
  /** rows=0 只要元信息(来源/窗口/单位/覆盖),不拉行 */
  snapshot: (id: string, rows = 0) => request<ResearchSnapshot>(`/api/research/snapshots/${encodeURIComponent(id)}?rows=${rows}`),
  tools: () => request<ResearchToolsResponse>('/api/research/tools'),

  // ---- §9.46 回测报告(全窗口 + BTC/ETH/BTC+ETH)与策略对象生命周期(contract §9.46,schema research-backtest.json / research-strategy.json)
  // react-query key:['research','backtest',id] / ['research','my-strategies',filter...] / ['research','my-strategy',id]
  backtest: (id: string) => request<BacktestReport>(`/api/research/backtests/${encodeURIComponent(id)}`),
  /** 某份报告某资产的 K 线 + 逐笔计划(订单周期回放,schema research-orders.json);candles ≤5000,truncated 表示窗口被截 */
  backtestReplay: (id: string, asset: string, from_ms?: number, to_ms?: number) => request<BacktestReplay>(`/api/research/backtests/${encodeURIComponent(id)}/replay${qs({ asset, from_ms, to_ms })}`),
  backtests: (opts: { strategy_id?: string; limit?: number } = {}) => request<{ reports: BacktestReportSummary[] }>(`/api/research/backtests${qs(opts)}`),
  runBacktest: (body: { strategy_ir: StrategyIR; timeframe: string; symbols?: string[]; from_ms?: number; to_ms?: number; title?: string }) => post<{ report_id: string }>('/api/research/backtests', body),
  myStrategies: (opts: { q?: string; filter?: 'all' | 'live' | 'watchlist' | 'alerts'; sort?: 'updated' | 'return' | 'sharpe' | 'name' } = {}) => request<ResearchStrategyList>(`/api/research/strategies${qs(opts)}`),
  myStrategy: (id: string, report?: string) => request<ResearchStrategyDetail>(`/api/research/strategies/${encodeURIComponent(id)}${qs({ report })}`),
  createMyStrategy: (body: ResearchStrategyCreate) => post<ResearchStrategy>('/api/research/strategies', body),
  patchMyStrategy: (id: string, body: ResearchStrategyPatch) => send<ResearchStrategy>('PATCH', `/api/research/strategies/${encodeURIComponent(id)}`, body),
  transitionMyStrategy: (id: string, body: ResearchStrategyTransition) => post<ResearchStrategyDetail>(`/api/research/strategies/${encodeURIComponent(id)}/transition`, body),
  backtestMyStrategy: (id: string, body: ResearchStrategyBacktestRequest = {}) => post<{ report_id: string }>(`/api/research/strategies/${encodeURIComponent(id)}/backtest`, body),
  addMyStrategyVersion: (id: string, body: { strategy_ir: StrategyIR; note?: string }) => post<ResearchStrategyDetail>(`/api/research/strategies/${encodeURIComponent(id)}/versions`, body),
  /** 把「新建策略」的草稿绑到研究会话:之后这个会话里的回测报告自动挂到这条策略 */
  attachMyStrategySession: (id: string, session_id: string) => post<ResearchStrategy>(`/api/research/strategies/${encodeURIComponent(id)}/attach-session`, { session_id }),
  archiveMyStrategy: (id: string) => send<ResearchStrategy>('DELETE', `/api/research/strategies/${encodeURIComponent(id)}`),
  /** §9.47 某版本 IR 编译出的 StrategyBinding(只读,不下发);react-query key ['research','my-strategy-binding',id,version] */
  myStrategyBinding: (id: string, version?: number) => request<StrategyBindingResponse>(`/api/research/strategies/${encodeURIComponent(id)}/binding${qs({ version })}`),
};

/** §9.51 策略一键运行(docs/design/strategy-run-2026-09-24.md) */
export const strategyRunsApi = {
  list: () => request<{ runs: StrategyRun[] }>('/api/strategy-runs'),
  preflight: (strategyId: string, version?: number) => request<StrategyRunPreflight>(`/api/strategy-runs/preflight${qs({ strategy_id: strategyId, version })}`),
  start: (body: StrategyRunRequest) => post<{ run: StrategyRun; scan: StrategyRunEvent[] }>('/api/strategy-runs', body),
  patch: (id: string, body: StrategyRunPatch) => send<{ run: StrategyRun }>('PATCH', `/api/strategy-runs/${encodeURIComponent(id)}`, body),
  scan: (id: string) => post<{ run: StrategyRun; scan: StrategyRunEvent[] }>(`/api/strategy-runs/${encodeURIComponent(id)}/scan`),
  events: (id: string, limit = 50, cursor?: string) => request<{ rows: StrategyRunEvent[]; next_cursor: string | null }>(`/api/strategy-runs/${encodeURIComponent(id)}/events${qs({ limit, cursor })}`),
};
