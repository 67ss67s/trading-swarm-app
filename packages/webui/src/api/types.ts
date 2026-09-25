// 领域对象:与 packages/gateway/src/demo/types.ts 逐字对齐(那是网关的权威 TS 源,
// 比 docs/demo/README.md + docs/demo/v2-agent-loop.md 的文字描述更精确——网关已经把
// thread.attention / workflow.daily_loss_stop_pct / proposal.entry_zone 这些字段实现出来了)。
// 不要在这里做任何"改进";如果契约变了,先改网关那边的 types.ts,再同步这里。
//
// v1(§ README.md §2)+ v2(§ v2-agent-loop.md §2)混在一个文件里,和网关一致。
// 金额/价格/数量一律十进制字符串;时间戳一律 unix 毫秒;字段 snake_case。

// ---------------------------------------------------------------------------
// v1 基础类型

export type StrategyState =
  | 'researching'
  | 'watching'
  | 'ready'
  | 'active'
  | 'managing'
  | 'closing'
  | 'closed'
  | 'invalidated';

export type Action = 'NO_TRADE' | 'WATCH' | 'PROPOSE' | 'HOLD' | 'ADD' | 'REDUCE' | 'EXIT' | 'INVALIDATE';

export type Direction = 'long' | 'short';

/**
 * 执行后端。v1 只有 paper/demo;v3.3 加了 cli(binance-cli 演示后端)与 agent_mcp
 * (每笔下单交给 claude/codex 子进程调币安 MCP)。老网关只会返回前两个,前端一律
 * 用 backendLabel() 兜底翻译,不做穷举 switch。
 *
 * okx(OKX ATK,2026-09-20):代码直接 spawn 官方 `okx` CLI(`--json`),不经过模型;
 * `TG_EXCHANGE=okx` 时只有 paper / okx 两条通道会被网关注册。
 */
export type Backend = 'paper' | 'demo' | 'cli' | 'agent_mcp' | 'mcp' | 'okx';

export interface Strategy {
  id: string;
  symbol: string;
  timeframe: string;
  state: StrategyState;
  version: number;
  direction: Direction | null;
  thesis: string;
  entry_plan: string | null;
  invalidation: string | null;
  invalidation_price: string | null;
  target_price: string | null;
  watch_conditions: string[];
  risk_budget_pct: string;
  updated_at: number;
  created_at: number;
}

export interface StrategyRevision {
  strategy_id: string;
  version: number;
  at: number;
  episode_id: string;
  from_state: StrategyState;
  to_state: StrategyState;
  action: Action;
  reason: string;
  snapshot: Strategy;
}

export interface Evidence {
  ref: string;
  kind: string;
  label: string;
  value: string;
  observed_at: number;
  source: string;
  stale: boolean;
  /** §9.34:哪几条启用策略点名要它;`[]` = 公共证据(行情/结构/记忆);老网关没有这个字段。 */
  required_by?: string[];
}

/** §9.34 证据装载明细的一行(`included=false` = 要了但没装上,`note` 写原因)。 */
export interface EvidencePlanItem {
  kind: 'indicator' | 'event' | 'news' | 'research' | 'checklist';
  key: string;
  label: string;
  required_by: string[];
  included: boolean;
  ref: string | null;
  source: string;
  note: string | null;
}

/** §9.34「模型这次看到了什么」。`hash` 只覆盖「要什么」,同一套启用策略的连续判断共用一个值。 */
export interface EvidencePlanDetail {
  version: string;
  hash: string;
  strategies: string[];
  requested: {
    indicators: { id: string; tf: string; required_by: string[] }[];
    events: string[];
    info_topics: string[];
  };
  items: EvidencePlanItem[];
  counts: { requested_indicators: number; included_indicators: number; events: number; news: number; research: number; checklist: number };
}

/** §9.34 `GET /api/judgments/:id`:一次判断的证据来源明细(只读,不重算)。 */
export interface JudgmentDetailResponse {
  episode_id: string;
  at: number;
  symbol: string;
  mode: 'scan' | 'review';
  prompt_version: string;
  context_hash: string;
  evidence_plan_hash: string | null;
  evidence_plan: EvidencePlanDetail | null;
  evidence: Evidence[];
  strategy_refs: { id: string; version: number; content_hash: string }[];
  cited_refs: string[];
  ledger: JudgmentLedgerRow | null;
  /** §9.37 结构化决策记录(代码允许 → 模型选 → 闸后执行);老 episode 为 null。 */
  decision_record?: DecisionRecord | null;
}

export interface Proposal {
  direction: Direction;
  entry: 'market' | 'limit';
  limit_price: string | null;
  entry_zone: [string, string] | null; // v2:限价挂在靠近现价的一端,记录整个区间
  stop_price: string;
  take_profit_price: string | null;
  take_profits: string[]; // v2:多 TP,第一个先挂,其余记录
  rationale: string;
}

// 模型输出契约(严格校验;失败 → 修一次 → 仍失败 fail-closed NO_TRADE)
export interface Judgment {
  action: Action;
  direction: Direction | null;
  confidence: number; // 0..1
  headline: string; // ≤ 40 字,一句人话
  thesis: string; // ≤ 200 字
  reasons: string[]; // 2-5 条,每条引用 evidence_refs
  evidence_refs: string[]; // ⊆ registry
  invalidation: string | null;
  invalidation_price: string | null;
  target_price: string | null;
  watch_conditions: string[];
  proposal: Proposal | null;
}

export type TriggerKind =
  | 'kline_close'
  | 'manual'
  | 'schedule'
  | 'monitor'
  | 'position_review'
  // v2:图循环新增的触发源
  | 'scan'
  | 'info_update'
  | 'order_filled'
  | 'tp_hit'
  | 'sl_hit'
  | 'thread_review'
  | 'chat'
  // v3:代码触发器(docs/demo/v3-ui-contract.md §7)
  | 'fast_move'
  | 'breakout'
  | 'ema_cross'
  | 'vol_spike'
  | 'retest'
  | 'session'
  | 'funding'
  | 'heartbeat'
  | 'event';

export interface Trigger {
  hits?: { kind: TriggerKind; detail: string; score: number; event_id?: string; event_subkind?: string; source_ref?: string; research_task_id?: string }[];
  kind: TriggerKind;
  detail: string;
}

export interface GateResult {
  name: string;
  passed: boolean;
  reason: string;
}

export interface SizingAgent {
  multiplier: number;
  overshoot: boolean;
  split: number;
  reason: string;
  applied: boolean;
}

export interface Sizing {
  agent?: SizingAgent;
  equity: string;
  risk_pct: string;
  risk_usdt: string;
  stop_distance: string;
  raw_qty: string;
  step_size: string;
  note: string;
}

/** §9.19:人批 = 一次性确认 token(120 秒)。意图与设置提议共用同一形状 */
export interface ConfirmToken<T = unknown> {
  nonce: string;
  expires_at: number;
  fingerprint: string;
  intent?: { id: string; kind: string; symbol: string; direction: Direction; quantity: string; entry: string; limit_price: string | null; stop_price: string | null; take_profit_price: string | null; backend: Backend };
  proposal?: T;
}

/** §9.19:对话里 set_workflow 改 watchlist/watch_only/timeframe/playbook_text/paused=false/brain* 只到提议;pending 超 30 分钟自动 expired */
export interface WorkflowProposal {
  id: string;
  created_at: number;
  expires_at: number;
  status: 'pending' | 'applied' | 'rejected' | 'expired';
  via: 'chat';
  session_id: string | null;
  patch: Record<string, unknown>;
  /** patch 各键的现值 / 预演值,diff 卡直接渲染这两个,别自己算 */
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  errors: string[];
  resolved_at: number | null;
}

export type IntentStatus = 'pending_approval' | 'approved' | 'rejected' | 'submitted' | 'filled' | 'failed' | 'unknown';

// 演示执行记录(不是 AGENTS.md 里的动钱六件套)
export interface DemoIntent {
  id: string;
  episode_id: string;
  thread_id: string | null; // v2
  principal: 'agent' | 'user'; // v2
  at: number;
  kind: 'open' | 'close' | 'reduce';
  symbol: string;
  direction: Direction;
  quantity: string;
  entry: 'market' | 'limit';
  limit_price: string | null;
  stop_price: string | null;
  take_profit_price: string | null;
  sizing: Sizing;
  status: IntentStatus;
  client_order_id: string | null;
  backend: Backend;
  receipts: unknown[];
  error: string | null;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  cost_estimate: string;
}

export interface Episode {
  sizing?: Sizing;
  sizing_evidence?: Record<string, unknown>;
  id: string;
  at: number;
  as_of: number;
  symbol: string; // v2
  thread_id: string | null; // v2
  trigger: Trigger;
  strategy_before: { state: StrategyState; version: number };
  evidence: Evidence[];
  /** §9.34 减黑盒:这次判断的证据装载计划;老网关/老 episode 没有。 */
  evidence_plan?: EvidencePlanDetail | null;
  evidence_plan_hash?: string | null;
  context_text: string; // 模型看到的全文
  context_hash: string;
  prompt_version: string;
  model: string;
  judgment: Judgment | null;
  judgment_raw: string | null;
  schema_errors: string[];
  reducer: { from: StrategyState; to: StrategyState; accepted: boolean; reason: string } | null;
  gates: GateResult[];
  intent: DemoIntent | null;
  usage: Usage | null;
  status: 'running' | 'done' | 'failed';
  error: string | null;
  strategy_after: { state: StrategyState; version: number } | null;
  /** v3:判断图上的位置(有则显示,无则忽略)。illegal_action 非空 = 模型第一次输出了该节点不允许的动作(之后被修正或 fail-closed,edge 是最终走的边)。 */
  graph?: { version: string; node: string; edge: string | null; guards: string[]; illegal_action?: string | null };
  /** v3.2:注入本次上下文的记忆 id 与判断实际引用的子集。 */
  memory?: { injected: string[]; cited: string[] };
}

// 列表/时间线用的精简形状——GET /api/episodes 和 episode.finished SSE 都是这个形状,
// 时间线卡片折叠态要显示的字段(reasons/reducer/schema_errors/error/intent)全带着,
// 不用逐条再拉一次 /api/episodes/:id。大字段(evidence 全量 / context_text / 完整
// judgment JSON)只有点开卡片才会去拉 GET /api/episodes/:id。
export interface EpisodeSummary {
  id: string;
  at: number;
  symbol: string;
  thread_id: string | null;
  trigger: Trigger;
  action: Action | null;
  direction: Direction | null;
  headline: string | null;
  confidence: number | null;
  reasons: string[];
  from_state: StrategyState;
  to_state: StrategyState | null;
  reducer: { from: StrategyState; to: StrategyState; accepted: boolean; reason: string } | null;
  schema_errors: string[];
  error: string | null;
  has_intent: boolean;
  intent: DemoIntent | null;
  /** 与 Episode.graph 相同,列表态就能显示「节点 → 边」徽章;老记录为 null。 */
  graph: Episode['graph'] | null;
  status: Episode['status'];
}

/** §9.40:市场维度。老网关/老数据没有该字段 → 按 'perp'。 */
export type Market = 'perp' | 'spot';
export const MARKETS: Market[] = ['perp', 'spot'];

export interface PositionView {
  symbol: string;
  /** §9.40;spot 持仓 side 恒 long、leverage 恒 1、mark = 现货最新价 */
  market?: Market;
  side: Direction;
  qty: string;
  entry_price: string;
  mark_price: string;
  unrealized_pnl: string;
  leverage: number;
}

export interface OpenOrderView {
  symbol: string;
  /** §9.40 */
  market?: Market; // v2:多币种以后,挂单要带 symbol 才能按线程/币种归属
  client_order_id: string;
  type: string;
  side: string;
  qty: string;
  price: string | null;
  stop_price: string | null;
  reduce_only: boolean;
  status: string;
}

export interface AccountView {
  backend: Backend;
  /** v3.11(§9.15):'unfunded' = 真读到的 0(币安子账户未入金),note 带入金链接;读失败不会产生 AccountView */
  quality?: 'ok' | 'unfunded';
  note?: string | null;
  equity: string;
  available: string;
  unrealized_pnl: string;
  positions: PositionView[];
  open_orders: OpenOrderView[];
  as_of: number;
}

export interface MarketView {
  symbol: string;
  /** §9.40;spot 下 funding_rate '0' / next_funding_at 0 / open_interest '0' */
  market?: Market;
  last: string;
  mark: string;
  funding_rate: string;
  next_funding_at: number;
  open_interest: string;
  as_of: number;
  klines_tf: string;
}

export interface LoopView {
  running: boolean;
  paused: boolean;
  halted: boolean;
  every_ms: number;
  next_at: number | null;
  last_episode_id: string | null;
  brain: string; // 判断/对话大脑名,形如 pi:zai/glm-5.3
  cheap_brain: string; // 信息员大脑名
  backend: Backend;
  auto_approve: boolean;
}

export interface LogEntry {
  at: number;
  level: 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  data?: unknown;
}

export interface Kline {
  open_time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  close_time: number;
}

// ---------------------------------------------------------------------------
// v2(docs/demo/v2-agent-loop.md §2)—— 信息员 / 扫描 / 策略线程 / 对话 / 工作流

export type BrainKind = 'pi' | 'claude' | 'codex' | 'stub';

/** GET /api/brains → { brains: BrainOption[], current: { brain, cheap_brain } } */
export interface BrainOption {
  kind: BrainKind;
  label: string;
  available: boolean; // 配置的启动命令能起得来(直接在 PATH 上,或登录 shell 认识这个词)
  models: string[]; // 推荐模型 id(仍可自由填写);pi 写成 provider/model
  default_model: string | null;
  note: string;
  /** 这个 CLI 的启动命令(Workflow.cli_commands);stub 为 null。老网关没有这个字段。 */
  command?: string | null;
  /** 这条命令怎么起、起不起得来。老网关没有这个字段。 */
  resolved?: CliResolved;
}

/** via: direct = 直接执行;shell = 经登录 shell(别名 / 环境变量前缀才用得上)。 */
export interface CliResolved {
  via: 'direct' | 'shell';
  ok: boolean;
  detail: string;
}

/** 每个 CLI 在这台机器上的启动命令。 */
export interface CliCommands {
  claude: string;
  codex: string;
  pi: string;
}

export interface BrainsResponse {
  brains: BrainOption[];
  current: { brain: string; cheap_brain: string };
  /** 老网关没有这个字段;以 GET /api/workflow 的 cli_commands 为准。 */
  cli_commands?: CliCommands;
}

/** POST /api/brains/test body { kind, model } → BrainTestResult(一次最短往返,可能要 5–60 秒) */
export interface BrainTestResult {
  ok: boolean;
  kind: BrainKind;
  model: string | null;
  name: string;
  latency_ms: number;
  text: string | null;
  error: string | null;
}

/** GET /api/graph → { graph: JudgmentGraph, mermaid: string }(docs/design/graph-engineering-v2.md) */
export interface JudgmentGraph {
  version: string;
  nodes: Record<string, { allowed_actions: Action[]; description: string }>;
  model_edges: { id: string; from: string; action: Action; effect: string; guards: string[]; description: string }[];
  event_edges: { id: string; event: TriggerKind; from: ThreadStatus | 'none'; to: string; description: string }[];
  guards: Record<string, { gate_name: string; description: string }>;
}

export interface GraphResponse {
  graph: JudgmentGraph;
  mermaid: string;
}

export interface Workflow {
  sizing_agent: 'off' | 'advise' | 'apply';
  watchlist: string[]; // 默认 ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT']
  /** §9.16(14e57a3):watchlist 的子集 = 只观察不交易(判断只能 NO_TRADE/WATCH) */
  watch_only: string[];
  /** §9.16:观察名单上限 1–24(默认 8);每多一个币 = 多一份心跳/收盘判断的模型费 */
  watchlist_max: number;
  timeframe: string; // 扫描/复查用的 K 线周期,默认 '15m'
  info_every_ms: number; // 信息员周期,默认 30 分钟
  risk_pct: string; // 单笔风险 % 权益,默认 '0.5'
  leverage: number; // 默认 3
  margin_mode: 'cross' | 'isolated'; // 默认 cross
  /** §9.40:允许交易的市场(默认 ['perp']);spot 不在里面时 spot 提案/手工单都被拒 */
  markets?: Market[];
  /** §9.40:交易页初始选中的市场(默认 'perp'),必须在 markets 内 */
  default_market?: Market;
  max_open_threads: number; // 默认 3
  max_opens_per_day: number; // 默认 4
  /** 达到当日权益的这个百分比亏损后停止新开仓,默认 '3'(网关侧字段,docs 未列出但已实现)。 */
  daily_loss_stop_pct: string;
  auto_approve: boolean; // agent 的 PROPOSE 是否免确认
  /** §9.19 v3.10.1:对话执行需我确认。默认 false = agent 在对话里 approve_intent 直接批(仍过全部代码闸);true = 只推确认卡走两步 token。只能人改,与 auto_approve 无关。老网关没有 */
  chat_requires_approval?: boolean;
  brain: BrainKind; // 判断/对话用哪家 CLI
  cheap_brain: BrainKind; // 信息员用哪家 CLI
  brain_model: string | null; // 判断/对话模型 id(pi: provider/model;claude: sonnet/opus/haiku 或完整 id;codex: 模型 id);null = 该 CLI 默认
  cheap_brain_model: string | null; // 信息员模型 id;null = 默认
  playbook_text: string; // 可编辑的 playbook 段落
  paused: boolean;
  /** agent 旁白开关(判断结束 / 成交 / 平仓 / 信息员更新时在对话里说一句)。 */
  narrate: boolean;
  // ---- v3(docs/demo/v3-ui-contract.md §1):代码出触发器,模型做判断 ----
  /** triggered = 触发器命中或到心跳才叫模型;every_close = 每根收盘都问(演示用)。 */
  scan_mode: 'triggered' | 'every_close';
  /** 触发器模式下,每个币最久多久问一次模型(5 分钟–4 小时)。 */
  heartbeat_every_ms: number;
  /** 5 分钟内涨跌超过此百分比立刻唤醒(十进制字符串,0.2–5)。 */
  fast_move_pct: string;
  /** 有持仓/挂单的线程是否每根收盘都复查。 */
  review_every_close: boolean;
  // ---- v3.10(gateway 9354d7e,prompt v7):失效确认——失效价越过不再必须离场,只有止损是硬线
  /** 失效价要被连续几根已收盘 K 线越过才算「失效确认」(整数 1–5,默认 2);模型不能改 */
  invalidation_confirm_bars: number;
  /** 越过深度不足这么多 ATR 不算(0–1,默认 0.2);模型不能改 */
  invalidation_buffer_atr: number;
  // ---- v3.3:执行后端 + 每日判断上限(操作台面板 / 费用表)----
  /** 每天最多调多少次判断模型,0 = 不限;到上限后当天不再调模型(聊天不受限)。 */
  daily_judgment_cap: number;
  /** 下单走哪个执行后端;老网关没有这个字段时为 undefined。 */
  execution?: Backend;
  /** execution=agent_mcp 时用哪个 CLI 子进程调币安 MCP。 */
  exec_agent_cli?: 'claude' | 'codex';
  /** execution=agent_mcp 时子进程用的模型;null = 该 CLI 默认。 */
  exec_agent_model?: string | null;
  /**
   * 每个 CLI 在这台机器上怎么启动:裸命令名、路径、带环境变量前缀的一行,或只有交互式 shell 里
   * 才存在的别名(如 claudeproxy)。网关的每一次子进程调用都用它。老网关没有这个字段。
   */
  cli_commands?: CliCommands;
  /** §9.30 事件封锁:事件 starts_at−N 分钟起到 ends_at 为止不开新仓(只拦开仓,不拦平仓)。整数 0–360,0 = 关;老网关没有这个字段。 */
  event_blackout_min?: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// v3.3:执行后端(操作台)—— GET /api/execution、POST /api/execution/check|connect

export type ExecutionBackend = Backend;

export interface ExecutionOption {
  kind: ExecutionBackend;
  label: string;
  available: boolean;
  note: string;
  /** 09-07:推荐通道(官方 binance-cli);老网关没有 */
  recommended?: boolean;
  /** 不可用时的接入步骤(多行);老网关没有 */
  setup?: string | null;
}

export interface ExecutionAgentView {
  cli: 'claude' | 'codex';
  /** CLI 真正会用的模型(claude 留空时网关按 sonnet 跑),不是「用户填了什么」。 */
  model: string | null;
  /** 老网关没有这个字段:一句话解释这个默认值(如「默认 sonnet,便宜」)。 */
  model_note?: string | null;
  server_name: string;
  url: string;
  /** 这台机器上真正会被执行的启动命令(老网关没有这个字段)。 */
  command?: string;
  resolved?: CliResolved;
}

export type ExecutionConnectionStatus = 'connected' | 'needs_auth' | 'unavailable' | 'unknown';

export interface ExecutionConnection {
  status: ExecutionConnectionStatus;
  checked_at: number | null;
  detail: string;
}

/**
 * 网关自己那套币安 OAuth 的状态(GET /api/execution 的 `oauth` 字段、GET /api/binance/status)。
 * 币安不发 refresh_token,`expires_at` 到了就得重新点一次「连接币安」。
 */
export interface BinanceOauthStatus {
  /** 配了 TG_BINANCE_OAUTH_CLIENT_ID(托管 client-metadata.json 的 https 地址)才为 true。 */
  configured: boolean;
  connected: boolean;
  client_id: string | null;
  redirect_uri?: string;
  resource?: string;
  expires_at: number | null;
  scope?: string | null;
  /** configured 为 false 时的原因。 */
  missing: string | null;
}

/** GET /api/execution、POST /api/execution/check 同形。 */
/** §9.20:agent_mcp 通道的止损保护验证状态(产品自己验证自己解锁,不再有环境变量) */
export interface NetCheckResult {
  backend: string;
  started_at: number;
  finished_at: number;
  runs: { ms: number; ok: boolean; transport_error: boolean; error: string | null }[];
  ok: number;
  transport_errors: number;
  other_errors: number;
  avg_ms: number | null;
  verdict: string;
}

export interface TransportHealth {
  window_ms: number;
  runs: number;
  transport_errors: number;
  last_error: string | null;
  last_at: number | null;
}

export interface ProtectionStatusView {
  status: 'not_needed' | 'verified' | 'unverified' | 'verifying' | 'failed';
  verified_at: number | null;
  last_run_at: number | null;
  last_error: string | null;
  steps: { name: string; ok: boolean; detail: string | null }[];
  cost_note: string;
  source: 'env' | 'record' | null;
}

/**
 * OKX 执行通道(`okx` 后端)的接入状态。网关只看二进制在不在、profile 解析得出来不,
 * **永远不读 key**(key 只在 ~/.okx/config.toml 里)。老网关 / Binance 模式下是 null。
 */
/** 本机已配的 OKX profile(`okx config list-profile`)。 */
export interface OkxProfileInfo {
  name: string;
  demo: boolean;
  is_default: boolean;
}

export interface OkxStatus {
  /** 老网关没有这个字段;有了就能画「模拟盘 / 实盘」两个槽位。 */
  profiles?: OkxProfileInfo[];
  /** 网关真正会 spawn 的二进制路径(TG_OKX_CLI → ~/.local/bin/okx → PATH)。 */
  cli: string;
  /** `--profile` 传的名字;null = 配置里读不到。 */
  profile: string | null;
  /** profile 的 demo 字段:true = 模拟盘,false = 实盘,null = 不知道(配置没解析出来)。 */
  demo: boolean | null;
  available: boolean;
  /** 不可用的原因,或可用时的一句话备注。 */
  note: string | null;
  /** `okx --version`;探不到为 null。 */
  version: string | null;
  /** §9.40:账户模式 1 简单 / 2 单币种保证金 / 3 跨币种 / 4 组合保证金;读不到 null。1 = 永续不可用(51010) */
  acct_lv?: 1 | 2 | 3 | 4 | null;
  acct_lv_label?: string | null;
  markets_available?: Market[];
  /** §9.40:现货持币(仅 okx 通道) */
  spot_holdings?: { ccy: string; total: string; available: string; usdt_value: string | null }[];
}

export interface ExecutionView {
  /**
   * 这台网关连的是哪个交易所(TG_EXCHANGE)。老网关没有这个字段 → 按 'binance' 处理,
   * 所有交易所相关文案都走 lib/exchange.ts 的 exchangeInfo(),不在组件里写死。
   */
  exchange?: 'okx' | 'binance';
  /** exchange==='okx' 时的接入状态;binance 模式 / 老网关为 null。 */
  okx?: OkxStatus | null;
  /** §9.40:当前通道支持的市场;老网关没有 → ['perp'] */
  markets_supported?: Market[];
  cost_control?: { read_mode: string; model_runs: number; direct_calls: number; cache_hits: number; model_budget: { blocked: boolean; blocked_at: number | null; reason: string | null } } | null;
  backend: ExecutionBackend;
  /** §9.20;老网关没有 */
  protection?: ProtectionStatusView | null;
  /** 09-07:执行通道传输健康(连接被掐/超时次数,30 分钟窗口);老网关没有;null = 后端不统计 */
  transport?: TransportHealth | null;
  options: ExecutionOption[];
  agent: ExecutionAgentView;
  connection: ExecutionConnection;
  can_switch: boolean;
  switch_blocker: string | null;
  /** 老网关没有这个字段;null = 网关没配 OAuth(只能走 agent_mcp 那条路)。 */
  oauth?: BinanceOauthStatus | null;
  /** v3.11:上次账户读取失败(读成功后清空);非空 → 「执行通道账户不可读」 */
  account_read_error?: { at: number; message: string } | null;
  /** v3.11:false → 「币安子账户未入金」;null = 未知 */
  account_funded?: boolean | null;
}

/**
 * POST /api/execution/connect。
 * - `url` 有值 = 网关自己的 OAuth 授权页;币安 3346001 之后这条路默认关掉了(只有
 *   TG_BINANCE_OAUTH_FORCE=1 才会再出现),前端仍然兼容;
 * - started=true = 网关已经弹了一个终端窗口跑交互式 `claude "/mcp"`,用户在里面选
 *   binance-mcp-server → Authenticate;
 * - started=false = 弹不出来(非 macOS 等),把 instructions 显示给用户自己去终端跑。
 */
export interface ExecutionConnectResponse {
  started: boolean;
  instructions: string;
  url?: string;
}

// ---------------------------------------------------------------------------
// v3.4:币安 MCP 直连(mcp 后端)的工具映射 —— /api/binance/map*(v3-ui-contract §9.8)
// 网关拿到 OAuth token 后自己跑 tools/list,按启发式给出「操作 → 工具」草案;人核对(可改 JSON)、
// 跑只读测试、确认之后,mcp 后端才可选。没映射到的操作一律拒绝执行,不猜工具名。

export type McpOp =
  | 'account'
  | 'positions'
  | 'open_orders'
  | 'place_market'
  | 'place_limit'
  | 'place_stop_market_close'
  | 'place_take_profit_close'
  | 'cancel_order'
  | 'cancel_all'
  | 'get_order'
  | 'set_leverage'
  | 'set_margin_type'
  | 'mark_price';

/** args 是模板:值恰好是 ${x} 时按类型注入,本次没有该值的键会被丢掉。 */
export interface McpOpMapping {
  tool: string;
  args: Record<string, string | number | boolean | null>;
  result?: { order_id?: string; avg_price?: string; status?: string; executed_qty?: string; root?: string };
  /** 启发式置信度 0–1;手工改过的映射可能没有。 */
  confidence?: number;
  /** 这个操作需要、但该工具的 inputSchema 里没有的参数名。 */
  missing?: string[];
  note?: string;
}

export interface McpToolMap {
  version: number;
  /** proposed 永远不会真的下单:mcp 后端只认 confirmed。 */
  status: 'proposed' | 'confirmed';
  source: 'heuristic' | 'manual';
  updated_at: number;
  ops: Partial<Record<McpOp, McpOpMapping>>;
  notes: string[];
}

/** GET /api/binance/map、PUT /api/binance/map、POST /api/binance/map/propose|confirm 同形。 */
export interface BinanceMapResponse {
  map: McpToolMap | null;
  tools_count: number;
  tools_at: number | null;
  proposal_notes: string[];
  /** 还没映射的必需操作;非空时 confirm 会被拒。 */
  unmapped_required: McpOp[];
  ops: McpOp[];
  placeholders: string[];
  /** 可直接交给人(或订阅制 CLI)校对的提示词。 */
  review_prompt: string | null;
  /** propose 专有:true = 这次真的重新抓了工具清单。 */
  refreshed?: boolean;
  errors?: string[];
}

export interface McpReadTestRow {
  op: McpOp;
  tool: string | null;
  ok: boolean;
  ms: number;
  args: Record<string, unknown> | null;
  /** 回包 JSON 的前 600 字符,用来核对字段名。 */
  sample: string | null;
  error: string | null;
}

/** POST /api/binance/map/test —— 只跑 account/positions/open_orders/mark_price,永远不写。 */
export interface BinanceMapTestResponse {
  symbol: string;
  results: McpReadTestRow[];
  ok_count: number;
  total: number;
}

/** GET /api/overview 的 usage_today:今日判断次数 / token / 估算花费 / 上限。 */
export interface UsageToday {
  judgments: number;
  input_tokens: number;
  output_tokens: number;
  est_cny: number | null;
  cap: number;
  capped: boolean;
}

export interface InformationEvent {
  id: string;
  kind: 'news' | 'market_snapshot' | 'sentiment';
  source: string;
  source_ref: string;
  occurred_at: number;
  observed_at: number;
  ingested_at: number;
  dedupe_key: string;
  title: string;
  digest: string;
  assets: string[];
}

export type Regime = 'trend_up' | 'trend_down' | 'range' | 'volatile' | 'unclear';

export interface MarketState {
  id: string;
  as_of: number;
  model: string;
  regime: Regime;
  bias: 'long' | 'short' | 'neutral';
  summary: string;
  key_points: string[];
  majors: {
    symbol: string;
    last: string;
    change_24h_pct: string;
    funding_rate: string;
    oi_change_1h_pct: string | null;
    long_short_ratio: string | null;
    taker_buy_sell_ratio: string | null;
  }[];
  sentiment: { fng: number | null; fng_label: string | null };
  top_movers: { symbol: string; change_24h_pct: string; quote_volume: string }[];
  /** 4916e8a:event_id = InformationEvent.id;url = 原文链接(非 http 或非 news 事件为 null);ref 只是引用编号 */
  /** e737564:source_label 给人看(如 PANews),旧快照网关读出时按 source 回填,未知源 = source */
  news: { ref: string; event_id?: string | null; url?: string | null; title: string; source: string; source_label?: string; published_at: number; relevance: 'high' | 'medium' | 'low'; digest: string }[];
  candidates: { symbol: string; direction: Direction; why: string }[];
  risk_events: string[];
  info_refs: string[];
  usage: Usage | null;
  error: string | null;
}

export type ThreadStatus = 'pending_entry' | 'in_position' | 'closed' | 'canceled' | 'invalidated';
export type ThreadSource = 'agent' | 'manual' | 'chat';

export interface StrategyThread {
  holding_plan?: { policy_version: string; origin: 'entry' | 'legacy_snapshot'; horizon: string; thesis_timeframe: string; confirm_timeframe: string; atr_timeframe: string; atr_multiple: string; net_rr: string | null; round_trip_cost_bps: string; target_mode: 'single' | 'scale_out' };
  last_policy_review?: { reason: string; allowed_actions: string[]; attention: boolean };
  /** 09-12 跟单:这条线程是谁开的——`trader:<带单员名>`;自己开的线程没有这个字段。 */
  origin?: string;
  /** 09-12 跟单:开这条线程的那条带单员信号 signal_id。 */
  trader_signal_id?: string;
  /**
   * 09-13 跟单首发范围:信号给了多档止盈,但本实现只挂得了第一档(分档减仓未实现)。
   * 非空 = 交易所上只有 `placed` 这一档,`dropped` 里的档位**没有挂**——前端必须显示出来,
   * 不然「信号说 110 平 30%、120 平 70%」会被读成已经照做了。
   */
  tp_partial_unsupported?: { placed: string; dropped: { price: string; percent: number }[]; note: string };
  /** 09-13 跟单:入场腿有效期(unix 毫秒,来自信号 valid_until);到点未成交由巡检撤掉余量。 */
  entry_expires_at?: number;
  id: string;
  symbol: string;
  side: Direction;
  status: ThreadStatus;
  source: ThreadSource;
  timeframe: string;
  thesis: string;
  invalidation_text: string | null;
  watch_conditions: string[];
  entry: { type: 'market' | 'limit'; price: string | null; zone: [string, string] | null };
  stop_price: string | null;
  take_profits: string[]; // 多 TP:第一个先挂,其余记录
  qty: string;
  margin_usdt: string | null;
  leverage: number;
  margin_mode: 'cross' | 'isolated';
  /** §9.40:spot 线程 side 恒 long、leverage 恒 1、margin_usdt = 花费 USDT;老网关没有 → perp */
  market?: Market;
  /** §9.40:期现套利配对 id(本轮恒 null,留给 spot 腿 + perp 腿绑对) */
  pair_id?: string | null;
  entry_client_order_id: string | null;
  protection_client_order_ids: string[];
  filled_avg_price: string | null;
  realized_pnl: string | null;
  close_reason: string | null;
  /** 机器可读的"需要人看一眼"标记,如 PROTECTION_MISSING / ORDER_UNKNOWN / EXTERNAL_ACTIVITY;正常为 null。 */
  attention: string | null;
  episode_ids: string[];
  intent_ids: string[];
  created_at: number;
  updated_at: number;
  opened_at: number | null;
  closed_at: number | null;
  version: number;
}

export interface ChatToolCall {
  name: string;
  args: unknown;
  result: unknown;
  ok: boolean;
}

export interface ChatMessage {
  id: string;
  at: number;
  role: 'user' | 'agent' | 'tool' | 'system';
  text: string;
  tool_calls: ChatToolCall[];
  episode_id: string | null;
  /** v3:chat = 对话;narration = agent 旁白(动态)。旧数据可能没有,前端按 `旁白 · ` 前缀兜底。 */
  kind?: 'chat' | 'narration';
  /** v3.8:属于哪个会话;旁白没有 */
  session_id?: string | null;
}

export type EpisodeStep = 'fetching' | 'context' | 'thinking' | 'validating' | 'gating' | 'executing' | 'done';

export interface QueueView {
  pending: number;
  running: { kind: string; symbol: string | null; step?: EpisodeStep | null; episode_id?: string | null } | null;
}

export interface ManualOrderRequest {
  symbol: string;
  /** §9.40:缺省 perp;spot 时 side 必须 long,action close = 卖出,margin_usdt = 花费 USDT,leverage/margin_mode 忽略 */
  market?: Market;
  side: Direction;
  action: 'open' | 'close';
  type: 'market' | 'limit';
  price?: string | null;
  margin_usdt?: string | null;
  leverage?: number | null;
  qty?: string | null;
  tp?: string | null;
  sl?: string | null;
  margin_mode?: 'cross' | 'isolated' | null;
}

export interface SymbolInfo {
  symbol: string;
  status: string;
  price_precision: number;
  qty_precision: number;
  step_size: string;
  tick_size: string;
  min_qty: string;
  min_notional: string;
}

// ---------------------------------------------------------------------------
// 下面这些是纯前端的"响应信封"形状:v1/v2 文档只描述了字段列表或散在端点描述里,
// 没有逐字给出 wrapper 的样子。网关那边尚未接线 v2 HTTP 路由(2026-09-03 现状),
// 这里按 v2-agent-loop.md §3 的端点表 + 网关 types.ts 已有的领域对象自己拼的合理形状,
// 已经在 mock/server.mjs 里对应实现。如果网关落地时形状不一样,回来改这个文件
// (对齐面板会用注释标出"这是我们定的,不是网关确认的")。

export interface Overview {
  loop: LoopView;
  strategy: Strategy;
  /** 账户读失败(agent_mcp 未就绪等)时网关给 null,不是 unfunded */
  account: AccountView | null;
  /** OKX 模式 / 还没拉到任何行情时为 null(2026-09-20 交易页因此崩过一次)。 */
  market: MarketView | null;
  recent_episodes: EpisodeSummary[];
  // v2 增量(README v2 §3):workflow / market_state(最新) / threads(非终态) /
  // markets(watchlist 逐个 MarketView) / queue。
  workflow: Workflow;
  market_state: MarketState | null;
  threads: StrategyThread[];
  markets: Record<string, MarketView>;
  queue: QueueView;
  /** v3.3:今日模型用量与花费(老网关没有这个字段,前端按缺省处理)。 */
  usage_today?: UsageToday;
}

export type StrategyWithRevisions = Strategy & { revisions: StrategyRevision[] };

export interface KlinesResponse {
  symbol?: string;
  tf: string;
  klines: Kline[];
}

/**
 * GET /api/market/indicators(docs/demo/v3-ui-contract.md §9.10)。
 *
 * 每条 series 的点都带 `t`(该根 K 线的开盘时间,**毫秒**,不是 lightweight-charts 要的秒),
 * 其余字段随指标而异:标量指标是 `v`,布林是 mid/upper/lower/width_pct,唐奇安是 upper/lower/mid,
 * 超级趋势是 value + dir(1/-1),MACD 是 macd/signal/hist,ADX 是 adx/plus_di/minus_di,KD 是 k/d。
 * 网关只发"已经算出来的"点(预热期的 NaN 直接不发),所以各条 series 的长度可以不一样,
 * 前端必须按 t 对齐,不能按下标对齐。
 */
export type IndicatorPoint = { t: number } & Record<string, number | boolean>;

/** 指标快照:最后一根已收盘 K 线上的所有指标值。字段全是可选的——网关侧预热不够时给 null。 */
export interface IndicatorSnapshot {
  tf: string;
  bars: number;
  last_open_time: number;
  last_close: number;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  macd: { macd: number; signal: number; hist: number } | null;
  bb: { mid: number; upper: number; lower: number; width_pct: number } | null;
  atr14: number | null;
  atr_pct: number | null;
  atr_pct_rank_90: number | null;
  bb_width_rank_90: number | null;
  adx14: { adx: number; plus_di: number; minus_di: number } | null;
  vwap_day: number | null;
  dist_to_vwap_atr: number | null;
  squeeze: { on: boolean; bars_on: number } | null;
  supertrend: { value: number; dir: 1 | -1 } | null;
  trend: 'up' | 'down' | 'flat';
  trend_strength: 'none' | 'weak' | 'moderate' | 'strong';
  /** 其余 20 多个指标(stoch / cci / mfi / aroon / ichimoku …)按名取,形状见 docs/demo/indicators.md。 */
  [key: string]: unknown;
}

export interface IndicatorsResponse {
  symbol: string;
  interval: string;
  bars: number;
  klines_from: number;
  klines_to: number;
  sets: string[];
  /** 请求里写错的 set 名会原样回来,而不是被静默丢掉。 */
  unknown_sets: string[];
  /** sets 里该画在主图价格轴上的那些(其余的要单独一个副窗)。 */
  overlay: string[];
  series: Record<string, IndicatorPoint[]>;
  snapshot: IndicatorSnapshot | null;
  /** describeIndicators() 的一行中文摘要,可直接展示。 */
  text: string;
  volume_profile: { poc: number; vah: number; val: number } | null;
}

/** GET /api/market/indicators/sets:让 UI 不用把指标名写死。 */
export interface IndicatorSetsResponse {
  sets: string[];
  overlay: string[];
  defaults: string[];
}

export interface LogsResponse {
  logs: LogEntry[];
}

export interface ApiError {
  error: { code: string; message: string };
}

export interface SettingsPayload {
  auto_approve?: boolean;
  every_ms?: number;
}

// POST /api/workflow 是"应用后返回"(网关 applyWorkflowPatch 会把越界值 clamp 到合法
// 区间,不是硬拒绝),所以带 errors 让 UI 显示"这些字段被自动纠正了",而不是 4xx。
// 我们定的形状:GET 返回裸 Workflow,POST 返回 { workflow, errors }。
export interface WorkflowPatchResponse {
  workflow: Workflow;
  errors: string[];
}

export interface InfoRunNowResponse {
  job_id: string;
}

export interface InfoEventsResponse {
  events: InformationEvent[];
}

export interface MarketStateHistoryResponse {
  history: MarketState[];
}

/**
 * 信息源采集状态(v3-ui-contract §9.17,gateway a1c2eca+09438cd):固定五源、只读、无增删改。
 * name = MarketState.news[].source;进程重启后信息员没跑过时四个可空字段全是 null(状态在进程内)。
 */
export interface InfoSource {
  name: string;
  label: string;
  url: string;
  lang: 'en' | 'zh';
  /** 媒体 6,美联储 72 */
  max_age_hours: number;
  last_fetch_at: number | null;
  last_status: 'ok' | 'error' | null;
  /** 只有 error 时有值 */
  last_error: string | null;
  /** 抓到的原始条数(时效窗内、去重前);失败时 null;周末英文媒体常常 ok 但 0 条,不是失败 */
  item_count: number | null;
  /** e737564:跨源去重 + 总量 25 之后真正进入本轮登记的条数;没跑过或失败 → null */
  used_count: number | null;
}

export interface InfoSourcesResponse {
  sources: InfoSource[];
}

export interface ScanNowRequest {
  symbol?: string;
}

export interface ScanNowResponse {
  job_ids: string[];
}

export interface ThreadsResponse {
  threads: StrategyThread[];
}

export interface ThreadDetailResponse {
  thread: StrategyThread;
  episodes: EpisodeSummary[];
  intents: DemoIntent[];
}

export interface ManualOrderResponse {
  thread: StrategyThread;
  intent: DemoIntent;
}

export interface OpenOrdersResponse {
  open_orders: OpenOrderView[];
  as_of: number;
}

export interface PositionsResponse {
  positions: PositionView[];
  as_of: number;
}

export interface SymbolsResponse {
  symbols: SymbolInfo[];
}

/** §9.40 GET /api/market/basis?symbol= :现货 vs 永续基差 + 资金费年化(期现套利地基)。 */
export interface BasisView {
  symbol: string;
  spot_last: string;
  perp_mark: string;
  perp_last: string;
  basis: string;
  basis_pct: string;
  funding_rate: string;
  funding_interval_ms: number;
  funding_annualized_pct: string;
  next_funding_at: number;
  as_of: number;
}

export interface ChatMessagesResponse {
  messages: ChatMessage[];
  /** v3.8:传了 session 参数时回显 */
  session?: string;
}

/** v3.8(v3-ui-contract §9.14):对话会话。default 不能删只能清空;can_execute 默认关,只有用户在会话头上开 */
export interface ChatSession {
  id: string;
  title: string;
  /** v3.12(12c5c82):对着某个角色的会话,agent 以该角色口径回答;null = 主会话 */
  role?: BotRole | null;
  created_at: number;
  updated_at: number;
  archived: boolean;
  can_execute: boolean;
  message_count: number;
  last_text: string | null;
}

export interface ChatSessionsResponse {
  sessions: ChatSession[];
}

export interface ChatSendResponse {
  accepted: boolean;
}

// ---------------------------------------------------------------------------
// v3(docs/demo/v3-ui-contract.md):活动流 / 交易历史 / 行情状态

export type ActivityKind =
  | 'proposal'
  | 'proposal_blocked'
  | 'approval_needed'
  | 'approved'
  | 'rejected'
  | 'thread_opened'
  | 'entry_filled'
  | 'protection_placed'
  | 'tp_hit'
  | 'sl_hit'
  | 'thread_closed'
  | 'thread_canceled'
  | 'thread_invalidated'
  | 'attention'
  | 'attention_cleared'
  | 'manual_order'
  | 'chat_action'
  | 'trigger'
  | 'info_update'
  | 'brain_error'
  | 'halt'
  | 'resume'
  | 'paused'
  | 'resumed'
  | 'workflow_changed'
  // v3.6:雷达筛选(docs/design 见网关 src/demo/screener.ts)
  | 'screen_done'
  | 'screen_failed'
  // v3.7:风控哨兵(gateway risk.ts)
  | 'risk_alert'
  | 'risk_cleared'
  // v3.9:Gate Captain 值班简报
  | 'brief';

export interface ActivityItem {
  id: string;
  at: number;
  kind: ActivityKind;
  level: 'info' | 'success' | 'warn' | 'danger';
  symbol: string | null;
  thread_id: string | null;
  episode_id: string | null;
  title: string;
  detail: string | null;
  data: Record<string, unknown>;
}

export interface ActivityResponse {
  activity: ActivityItem[];
}

export interface HistoryStatsBucket {
  count: number;
  wins?: number;
  pnl: string;
}

export interface HistoryStats {
  /** 已结算并计入统计的笔数。 */
  count: number;
  /** 已平仓但盈亏还没从交易所结算回来的笔数(不计入下面任何统计)。 */
  unsettled?: number;
  wins: number;
  losses: number;
  flat: number;
  win_rate: number;
  total_pnl: string;
  avg_pnl: string;
  avg_hold_ms: number;
  profit_factor: number | null;
  best: { thread_id: string; symbol: string; pnl: string } | null;
  worst: { thread_id: string; symbol: string; pnl: string } | null;
  by_symbol: ({ symbol: string } & HistoryStatsBucket)[];
  by_source: ({ source: ThreadSource } & HistoryStatsBucket)[];
  by_close_reason: ({ reason: string } & HistoryStatsBucket)[];
}

export type HistoryThread = StrategyThread & {
  hold_ms: number;
  /** false = 盈亏还在结算中(realized_pnl 为 null,不能当 0 看)。 */
  settled?: boolean;
  pnl_num: number;
  exit_price: string | null;
  episode_count: number;
  r_multiple: number | null;
};

export interface EquityPoint {
  at: number;
  equity: number;
  unrealized: number;
  /** fc86c0b:所属执行通道;GET /api/history 默认只回当前通道 */
  backend?: Backend;
}

export interface HistoryResponse {
  stats: HistoryStats;
  threads: HistoryThread[];
  equity: EquityPoint[];
}

export type DailyRegime = 'bull' | 'bear' | 'range' | 'volatile';
export type SessionName = 'us_open_window' | 'us' | 'london' | 'asia' | 'weekend' | 'off';

export interface RegimeResponse {
  symbol: string;
  as_of: number;
  daily: {
    regime: DailyRegime;
    ema_stack: string;
    ret_20d_pct: number;
    vol_pct_rank: number;
    atr_pct: number;
    text: string;
    /** 日线还没拉到(新实例 / OKX 冷启动)时为 null。 */
  } | null;
  session: {
    name: SessionName;
    text: string;
    minutes_to_us_open: number | null;
  };
}

// SSE event → payload 类型映射,给 client.ts 的订阅器用
export interface ServerEventMap {
  market_event: MarketEvent;
  research_task: import('../components/research/research').ResearchTask;

  /** v3.2:记忆状态变化(提案/批准/拒绝/遗忘),前端只用来失效 ['memory'] 前缀。 */
  'memory.changed': { id: string; status: MemoryStatus };
  'loop.state': LoopView;
  'episode.started': { id: string; trigger: Trigger };
  'episode.progress': { step: EpisodeStep; episode_id: string | null; at: number };
  'episode.finished': EpisodeSummary;
  'strategy.changed': Strategy;
  'intent.changed': DemoIntent;
  'account.updated': AccountView;
  'market.tick': MarketView;
  log: LogEntry;
  // v2
  'market_state.updated': MarketState;
  'thread.changed': StrategyThread;
  'chat.message': ChatMessage;
  'queue.state': QueueView;
  'workflow.changed': Workflow;
  /** §9.19 设置提议状态变化 */
  'workflow.proposal': { id: string; status: WorkflowProposal['status']; keys: string[] };
  // v3
  activity: ActivityItem;
  // v3.3:执行后端 / MCP 连接状态变了(切后端、检查连接、OAuth 回调),前端失效 ['execution']
  'execution.changed': Partial<ExecutionView>;
}

// ---------------------------------------------------------------------------
// v3.2 长期记忆(docs/demo/memory.md)—— 提案 → 人工批准 → 召回进证据

export type MemoryKind = 'lesson' | 'preference' | 'fact' | 'calibration';
export type MemoryStatus = 'proposed' | 'active' | 'rejected' | 'superseded' | 'forgotten';
export type MemoryProposer = 'agent' | 'user' | 'system';

export interface MemoryScope {
  symbol: string | null; // null = 全局
  timeframe: string | null;
  regime: string | null;
}

export interface MemoryItem {
  id: string; // mem-…
  kind: MemoryKind;
  scope: MemoryScope;
  content: string; // ≤ 300 字
  source_refs: string[]; // 来源 episode/thread id
  tags: string[];
  confidence: number;
  status: MemoryStatus;
  proposed_by: MemoryProposer;
  supersedes: string | null;
  superseded_by: string | null;
  created_at: number;
  decided_at: number | null;
  last_used_at: number | null;
  use_count: number;
  expires_at: number | null;
  content_hash: string;
}

export interface MemoryEvent {
  id: number;
  memory_id: string;
  at: number;
  kind: 'proposed' | 'approved' | 'rejected' | 'forgotten' | 'superseded' | 'used' | 'expired' | 'dedup_hit';
  detail: string | null;
}

/** GET /api/memory?status=proposed,active&symbol=&limit= */
export interface MemoryListResponse {
  items: MemoryItem[];
  counts: Record<MemoryStatus, number>;
}

/** GET /api/memory/search?q=&symbol=&regime=&tags=&limit= */
export interface MemoryRecallHit {
  item: MemoryItem;
  score: number;
  why: string[];
}
export interface MemorySearchResponse {
  hits: MemoryRecallHit[];
}

/** GET /api/memory/:id */
export interface MemoryDetailResponse {
  item: MemoryItem;
  events: MemoryEvent[];
}

/** POST /api/memory body(用户手写,直接 active)→ 201 { item } */
export interface MemoryCreateRequest {
  content: string;
  kind?: MemoryKind;
  symbol?: string | null;
  regime?: string | null;
  tags?: string[];
}

/** POST /api/memory/:id/approve | reject | forget(body 可带 reason)→ { item } */
/** POST /api/memory/reflect body { limit? } → 复盘提炼(调信息员大脑,暂停时 409) */
export interface MemoryReflectResponse {
  proposed: MemoryItem[];
  skipped: number;
  considered: number;
}

// ---------------------------------------------------------------------------
// v3.4 回放与盲测(docs/demo/v3-ui-contract.md §9.8;docs/design/blind-backtest-2026-09-05.md)
//
// 盲测 = 逐根 K 线重放历史,每次判断只喂当时可见的数据(close_time ≤ 该根收盘)给线上同一套
// buildContext + 契约 + 代码闸。判断要花钱(GLM-5.3 ≈ ¥0.006/次),所以前端**必须**先 estimate、
// 弹确认框把 ¥ 念一遍,再 POST /api/backtest。

export type BacktestMode = 'triggers' | 'every_close';
export type BacktestStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface BacktestParams {
  symbol: string;
  timeframe: string;
  from: number;
  to: number;
  mode: BacktestMode;
  max_judgments: number;
  review_every_close: boolean;
  brain: BrainKind;
  brain_model: string | null;
  horizon_bars: number;
  risk_pct: number;
  max_opens_per_day: number;
}

export interface BacktestProgress {
  done: number;
  total: number;
  last_action: string | null;
  at: number;
}

export interface BacktestCost {
  input_tokens: number;
  output_tokens: number;
  /** 订阅制大脑(claude/codex)没有单价 → null,前端显示「订阅额度,不计费」。 */
  cny: number | null;
}

export interface BacktestTrade {
  step_idx: number;
  direction: Direction;
  entry: 'market' | 'limit';
  limit_price: number | null;
  proposed_at: number;
  fill_at: number | null;
  fill_price: number | null;
  stop: number;
  tp: number | null;
  exit_at: number | null;
  exit_price: number | null;
  status: 'stop' | 'tp' | 'review_exit' | 'expired' | 'unfilled' | 'open';
  close_reason: string;
  r: number | null;
  mae_r: number | null;
  mfe_r: number | null;
  bars_held: number | null;
  reduced_fraction: number;
  reduced_r: number | null;
}

export interface BacktestSummary {
  judgments: number;
  scans: number;
  reviews: number;
  actions: Record<string, number>;
  trades: number;
  wins: number;
  losses: number;
  flat: number;
  win_rate: number | null;
  avg_r: number | null;
  sum_r: number;
  max_drawdown_r: number;
  avg_hold_bars: number | null;
  cost: BacktestCost;
  model: string;
  missed_move: { samples: number; avg_atr: number; max_atr: number } | null;
  bars: number;
  candidates: number;
  capped: boolean;
  trade_rows: BacktestTrade[];
}

export interface BacktestRun {
  id: string;
  created_at: number;
  symbol: string;
  timeframe: string;
  from_ms: number;
  to_ms: number;
  mode: BacktestMode;
  status: BacktestStatus;
  params: BacktestParams;
  brain: string;
  prompt_version: string;
  progress: BacktestProgress | null;
  summary: BacktestSummary | null;
  error: string | null;
}

export interface BacktestStepOutcome {
  kind: 'opened' | 'blocked' | 'closed' | 'reduced' | 'none';
  detail: string;
  trade_step_idx?: number;
  r?: number | null;
  missed_move_atr?: number | null;
}

export interface BacktestStep {
  run_id: string;
  idx: number;
  /** 判断发生在这根 K 线的收盘时刻。 */
  at_ms: number;
  kind: 'scan' | 'review';
  trigger: string | null;
  /** 盲测边界:上下文里没有任何 close_time 大于它的 K 线。 */
  visible_upto_ms: number;
  judgment: Judgment | null;
  action: string | null;
  direction: Direction | null;
  confidence: number | null;
  gates: GateResult[];
  outcome: BacktestStepOutcome | null;
  cost: BacktestCost | null;
  error: string | null;
}

/** GET /api/backtest/estimate?symbol&timeframe&from&to&mode&max_judgments */
export interface BacktestEstimate {
  symbol: string;
  timeframe: string;
  from: number;
  to: number;
  mode: BacktestMode;
  bars: number;
  candidates: number;
  per_judgment_cny: number | null;
  est_cny: number | null;
  max_cny: number | null;
  model: string;
  note: string;
}

/** GET /api/backtest */
export interface BacktestListResponse {
  runs: BacktestRun[];
  running: string | null;
}

/** GET /api/backtest/:id */
export interface BacktestDetailResponse {
  run: BacktestRun;
  steps: BacktestStep[];
  trades: BacktestTrade[];
}

/** POST /api/backtest → 202 { run, error }(已有回测在跑时 409 + error 文案) */
export interface BacktestStartResponse {
  run: BacktestRun;
  error: string | null;
}

/** GET /api/market/klines/history?symbol&interval&from&to(单页 ≤ 1500 根,磁盘缓存) */
export interface KlinesHistoryResponse {
  symbol: string;
  interval: string;
  /** 实际返回的最早时刻——请求超过 max_bars 时会被网关往回截。 */
  from: number;
  to: number;
  /** 前端原本要的 from(未截断)。 */
  requested_from: number;
  klines: Kline[];
  /** false = 撞到单次上限,还能继续往前要。 */
  complete: boolean;
  max_bars: number;
}

/**
 * SSE 补两个事件(接口合并进上面的 ServerEventMap,不动原声明):
 * `backtest.progress` 走进度条,`backtest.changed` 失效 ['backtest'] 与 ['backtest', id]。
 */
export interface ServerEventMap {
  'backtest.progress': { run_id: string; done: number; total: number; last_action: string | null; at: number };
  'backtest.changed': BacktestRun;
}

// ---------------------------------------------------------------------------
// v3.5 策略库 + 回测归因(docs/design/strategy-library-2026-09-05.md)
//
// 一条策略是**不可变的版本化对象**:触发(哪些事件才唤醒它)+ 清单(代码必须能算出来的证据)+
// 规则(模型只能在这些边里选)+ 参数(带范围,改一个就是新版本 + 新 hash)+ 评测统计。
// 红线:界面上没有「直接改一个在跑的策略的数字」这条路——改参数 = 生成一个 draft 新版本;
// 上线 = 一格一格晋升,而且 paper → live_capped 必须人工输入确认。归因只提议,永不自动落地。

/** 晋升只能沿 draft → backtest → shadow → paper → live_capped 一格一格走;retired 随时可去,不可回。 */
export type StrategyStatus = 'draft' | 'backtest' | 'shadow' | 'paper' | 'live_capped' | 'retired';

export type StrategyFamily = 'trend_continuation' | 'mtf' | 'volatility' | 'derivatives' | 'mean_reversion';

/** 一个可调参数:值 + 允许区间;新值必须落在 [min,max] 内,否则网关拒。 */
export interface StrategyParam {
  value: number;
  min: number;
  max: number;
  unit?: string;
  note?: string;
}

export interface StrategyEvalStats {
  /** 跑过多少次回测。 */
  backtests: number;
  trades: number;
  win_rate: number | null;
  /** 每笔期望 R(平均 R)。 */
  expectancy_r: number | null;
  /** 最大不利偏移的中位数,单位 R(负数)。 */
  mae_r_p50: number | null;
  last_run_id: string | null;
  /** 单次回测的噪声提示(一两笔亏损说明不了问题),有就原样显示。 */
  noise_note: string | null;
}

export interface StrategySpec {
  id: string;
  version: number;
  /** sha256(name|family|trigger|checklist|rules|params);status 与 eval_stats 不进 hash。 */
  content_hash: string;
  name: string;
  family: StrategyFamily;
  status: StrategyStatus;
  trigger: {
    /** 只有这些触发种类才唤醒这条策略。 */
    kinds: string[];
    /** 低于这个周期不跑(避免 1m 噪声)。 */
    min_timeframe: string;
    /** 同一策略两次开仓之间至少隔多少根。 */
    cooldown_bars: number;
  };
  checklist: {
    /** 代码必须能算出来的证据 id(算不出来就不该让模型按这条策略开仓)。 */
    required: string[];
    timeframes: string[];
  };
  rules: {
    entry: string[];
    invalidation: string[];
    exit: string[];
    sizing_note?: string;
  };
  params: Record<string, StrategyParam>;
  eval_stats: StrategyEvalStats;
  created_at: number;
  parent_version?: number | null;
}

/** GET /api/strategies 与 /api/strategies/:id 返回的是加了这几个展示字段的 spec。 */
export interface StrategyView extends StrategySpec {
  family_label: string;
  status_label: string;
  /** 下一格状态;null = 已经在最高状态或已退役。 */
  next_status: StrategyStatus | null;
  /** null = 可以晋升;非 null = 为什么还不能(直接显示这句中文)。 */
  promote_blocked: string | null;
  /** 是否挂在 workflow.active_strategies 里(实盘启用)。 */
  active: boolean;
}

/** GET /api/strategies?include_retired=1 */
export interface StrategiesResponse {
  strategies: StrategyView[];
  active: string[];
  statuses: StrategyStatus[];
  status_labels: Record<StrategyStatus, string>;
  family_labels: Record<StrategyFamily, string>;
}

/** GET /api/strategies/:id */
export interface StrategyDetailResponse {
  strategy: StrategyView;
  versions: StrategySpec[];
  attributions: AttributionPoint[];
}

/** POST /api/strategies/active { ids } —— 只有 ≥ paper 的能进实盘,否则 400。 */
export interface StrategyActiveResponse {
  active: string[];
  workflow: Workflow;
}

/** POST /api/strategies/:id/propose-version → 201;/promote → 200(闸不过是 409);/retire → 200 */
export interface StrategyMutationResponse {
  strategy: StrategyView;
}

export interface StrategyRetireResponse {
  strategy: StrategyView;
  active: string[];
}

export type AttributionKind = 'rule_wording' | 'param' | 'checklist_item';

export interface AttributionProposal {
  kind: AttributionKind;
  strategy_id: string | null;
  /** kind='param' 时:参数名与提议值(必须落在该参数的 [min,max] 内)。 */
  param?: string | null;
  value?: number | null;
  /** kind='rule_wording' / 'checklist_item' 时:提议的新措辞 / 新清单项。 */
  text: string;
}

/** 一个「问题点位」:证据当时显示了什么、规则当时说了什么、实际发生了什么、提议怎么改。 */
export interface AttributionPoint {
  id: string;
  run_id: string;
  at: number;
  strategy_id: string | null;
  symbol: string | null;
  kind: AttributionKind;
  title: string;
  evidence_said: string;
  rule_said: string;
  actual: string;
  proposal: AttributionProposal;
  /** 对应的长期记忆提案 id(status=proposed,要人批准才进上下文)。 */
  memory_id: string | null;
  /** 人点了「采纳为新版本」后落在哪个版本上;null = 还没采纳。 */
  applied_version: number | null;
}

/** GET /api/backtest/:id/attribution */
export interface BacktestAttributionResponse {
  points: AttributionPoint[];
}

/** POST /api/backtest/:id/attribute —— 调便宜大脑,**会花钱**;回测没跑完是 409。 */
export interface BacktestAttributeResponse {
  points: AttributionPoint[];
  error: string | null;
  /** true = 之前已经跑过,这次直接给旧结果,没再花钱。 */
  cached: boolean;
}

/** 按 strategy_id 拆开的成交统计;key `unattributed` 收模型没标注策略的那些成交。 */
export interface StrategyBreakdown {
  trades: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  expectancy_r: number | null;
  sum_r: number;
  /** MAE 中位数,单位 R(负数);没有成交报过就是 null。 */
  mae_r_p50: number | null;
  /** 这条策略被点名的判断次数(不管有没有 PROPOSE)。 */
  proposals: number;
}

/**
 * v3.5 给回测契约补的字段(接口合并进上面的原声明,不动原声明):
 * 汇总多了「这次用哪几条策略」与按策略拆的战绩,估算多了按策略拆的候选数,
 * 成交/步骤各多一个 strategy_id(模型判断时点的名,可能为 null)。
 */
export interface BacktestSummary {
  /** 这次回测用的策略(id@version + hash,所以一份汇总永远说得清它测的是哪份内容)。 */
  strategies: { id: string; version: number; content_hash: string; status: string }[];
  by_strategy: Record<string, StrategyBreakdown>;
}

export interface BacktestEstimate {
  /** 每条策略自己的触发集合会唤醒多少根候选 K 线。 */
  candidates_by_strategy: Record<string, number>;
}

export interface BacktestParams {
  /** 这次回测拿哪几条策略去判断;缺省 = workflow.active_strategies。回测**允许**点名 backtest/shadow 状态的策略。 */
  strategy_ids: string[];
  /** 走完之后顺手跑一遍便宜大脑归因。 */
  attribute: boolean;
}

export interface BacktestTrade {
  /** 开这笔的那次判断点的策略名;null = 回测没带策略 / 模型没标。 */
  strategy_id: string | null;
}

export interface BacktestStep {
  /** 这次判断点名的策略(实践中只有 PROPOSE 会有)。 */
  strategy_id: string | null;
}

// ---------------------------------------------------------------------------
// v3.6 雷达 / 筛选器(逐字对齐网关 packages/gateway/src/demo/screener.ts 与 bots.ts;
// 契约变了先改网关那边,再同步这里)。
//
// 一次筛选 = 一行 ScreenRow(状态机 running → done/failed)+ 若干张 WatchCandidate
// (每张里嵌一整张 OpportunityCard)。提案只改 workflow.watchlist 一个字段,
// 而且默认是 propose:界面必须先给出 before → after 的 diff 再让人确认。

export type ScreenHorizon = 'short' | 'swing' | 'weekly';
export type ScreenUniverse = 'watchlist+whitelist' | 'top_volume' | 'explicit';
export type ScreenApplyMode = 'propose' | 'auto';
export type ScreenStatus = 'running' | 'done' | 'failed';

export interface FitCondition {
  key: string;
  label: string;
  pass: boolean;
  /** 差一点点就过(阈值放宽 ~25% 就成立);算半分。 */
  near: boolean;
  detail: string;
}

export interface FitExpectancy {
  days: number;
  setups: number;
  per_week: number;
  n: number;
  win_rate: number | null;
  expectancy_r: number | null;
}

export interface StrategyFit {
  strategy_id: string;
  name: string;
  version: number;
  status: string;
  /** 0..1:通过的条件数 +(差一点的 × 0.5)÷ 条件总数。纯代码。 */
  fit_score: number;
  passed: number;
  near: number;
  total: number;
  direction: Direction | null;
  conditions: FitCondition[];
  reasons: string[];
  expectancy: FitExpectancy | null;
  expectancy_note: string | null;
}

export interface OpportunityCard {
  symbol: string;
  horizon: ScreenHorizon;
  timeframe: string;
  confirm_timeframe: string;
  as_of: number;
  bars: number;
  last_close: number | null;
  trend: {
    base_dir: Direction | null;
    confirm_dir: Direction | null;
    agree: Direction | null;
    adx_base: number | null;
    adx_confirm: number | null;
    note: string;
  };
  atr_pct: number | null;
  atr_pct_rank_90: number | null;
  bb_width_rank_90: number | null;
  squeeze_on: boolean | null;
  squeeze_bars: number | null;
  breakout: {
    level_long: number | null;
    level_short: number | null;
    dist_long_atr: number | null;
    dist_short_atr: number | null;
    bars_since_up: number;
    bars_since_down: number;
    vol_ratio: number | null;
  };
  funding: { rate_pct: number | null; z_30d: number | null; samples: number };
  reversion: { text: string; best_prob: number | null; best_k: number | null; best_horizon: number | null } | null;
  daily_regime: string | null;
  volume: { quote_24h: number | null; rank: number | null; of: number };
  strategies: StrategyFit[];
  best: { strategy_id: string; fit_score: number } | null;
  note: string | null;
}

export interface WatchCandidate {
  screen_id: string;
  horizon: ScreenHorizon;
  symbol: string;
  strategy_id: string;
  fit_score: number;
  rank: number;
  /** 一行行的理由;以「模型:」开头的那条是**不可信的模型自由文本**,界面上必须标出来。 */
  reasons: string[];
  card: OpportunityCard;
  ttl_at: number;
  created_at: number;
}

export interface WatchlistProposal {
  /** 建议观察的币,已按名次截到 K 个。 */
  symbols: string[];
  /** 每个币建议启用哪几条策略(仅供参考:应用时不写 active_strategies)。 */
  active_strategies: Record<string, string[]>;
  k: number;
  note: string;
}

export interface BrainLine {
  symbol: string;
  strategy_id: string;
  why: string;
}

export interface ScreenBrainPass {
  used: boolean;
  model: string | null;
  cost_cny: number | null;
  error: string | null;
  ranked: BrainLine[];
  dropped_lines: number;
}

export interface ScreenRow {
  id: string;
  horizon: ScreenHorizon;
  started_at: number;
  finished_at: number | null;
  status: ScreenStatus;
  universe: ScreenUniverse;
  symbols: string[];
  errors: { symbol: string; error: string }[];
  run_id: string | null;
  handoff_id: string | null;
  proposal: WatchlistProposal | null;
  brain: ScreenBrainPass | null;
  cost_cny: number;
  error: string | null;
}

export interface ScreenSchedule {
  horizon: ScreenHorizon;
  label: string;
  every_ms: number;
  last_at: number | null;
  next_at: number | null;
  running: boolean;
  enabled: boolean;
}

/** GET /api/screener/latest?horizon= */
export interface ScreenerLatestResponse {
  horizon: ScreenHorizon;
  screen: ScreenRow | null;
  candidates: WatchCandidate[];
  schedule: ScreenSchedule[];
  watchlist: string[];
  watchlist_max: number;
  horizons: { id: ScreenHorizon; label: string }[];
}

/** GET /api/screener/history?horizon=&limit= */
export interface ScreenerHistoryResponse {
  screens: ScreenRow[];
}

/** GET /api/screener/:id */
export interface ScreenerDetailResponse {
  screen: ScreenRow;
  candidates: WatchCandidate[];
}

/** POST /api/screener/run → 202 */
export interface ScreenerRunResponse {
  screen_id: string;
  horizon: ScreenHorizon;
}

/** POST /api/screener/:id/apply —— 只动 workflow.watchlist 一个字段。 */
export interface ScreenerApplyResponse {
  workflow: Workflow;
  before: string[];
  after: string[];
}

// ---- 机器人团队(packages/gateway/src/demo/bots.ts)----------------------------

export type BotRole =
  | 'gate_captain'
  | 'radar'
  | 'thread_manager'
  | 'strategy_lab'
  | 'portfolio_manager'
  | 'risk_sentinel'
  | 'reviewer'
  | 'executor'
  | 'asp_agent';

export interface BotProfile {
  role: BotRole;
  name: string;
  /** llm_ 开头 = 能自由调工具的 LLM;deterministic / hybrid = 代码;protected_service = 执行面。 */
  kind: string;
  description: string;
  model_pin: string | null;
  capabilities: string[];
  memory_scope: string;
  approval_boundary: string;
  /** false = 占位,还没有真实实现;界面画灰,note 里写差什么。 */
  enabled: boolean;
  note: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export type BotRunStatus = 'running' | 'done' | 'failed' | 'skipped';

export interface BotRun {
  id: string;
  role: BotRole;
  routine: string;
  started_at: number;
  finished_at: number | null;
  status: BotRunStatus;
  budget: Record<string, unknown>;
  cost_cny: number;
  summary: string | null;
  error: string | null;
  /** v3.8:routine 的输入/产物(trade_card 的 result = TradeCard;review_batch 的 result = { batch_key, proposed_memory_ids, dropped, model, latency_ms }) */
  input?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
}

export type HandoffKind = 'request' | 'result' | 'review' | 'alert' | 'blocked';
export type HandoffStatus = 'pending' | 'acked';

export interface BotHandoff {
  handoff_id: string;
  run_id: string | null;
  from_role: BotRole;
  to_role: BotRole;
  kind: HandoffKind;
  subject: { type: string; id: string };
  summary: string;
  evidence_refs: string[];
  artifact_refs: string[];
  requested_output_schema: string | null;
  priority: number;
  deadline_at: number | null;
  idempotency_key: string;
  status: HandoffStatus;
  created_at: number;
  acked_at: number | null;
  payload: Record<string, unknown> | null;
}

/** GET /api/bots */
export interface BotsResponse {
  bots: BotProfile[];
  runs: BotRun[];
  handoffs: BotHandoff[];
}

/** GET /api/bots/handoffs?status=&limit= */
export interface BotHandoffsResponse {
  handoffs: BotHandoff[];
}

/** POST /api/bots/handoffs/:id/ack */
export interface BotHandoffAckResponse {
  handoff: BotHandoff;
}

/**
 * v3.6 的 workflow 新字段。老网关没有这些字段时全是 undefined,界面按默认值兜底
 * (和 v3.3 的 execution?/cli_commands? 同一套写法)。周线周期固定 7d,不是字段。
 */
export interface Workflow {
  /** 09-07:Strategy Lab 自动闭环(写回 lab_stats / 自动提 draft / 数据态自动晋升);老网关没有 */
  lab_autopilot?: boolean;
  screener_enabled?: boolean;
  screener_short_every_ms?: number;
  screener_swing_every_ms?: number;
  screener_universe?: ScreenUniverse;
  screener_symbols?: string[];
  /** 「观察列表 + 白名单」里的白名单,可编辑;老网关没有这个字段。 */
  screener_whitelist?: string[];
  /** 1–300。 */
  screener_max_symbols?: number;
  screener_use_brain?: boolean;
  screener_apply?: ScreenApplyMode;
  screener_expectancy?: boolean;
}

/** v3.6 SSE(合并进上面的 ServerEventMap,不动原声明)。 */
export interface ServerEventMap {
  'screener.changed': { screen_id: string; horizon: ScreenHorizon; status: ScreenStatus; done?: number; total?: number };
  /** v3.9:strategy_lab 实验跑动时每币一条带 progress,结束那条没有 progress */
  'bots.changed': { role?: BotRole; run_id?: string; progress?: { symbol: string; done: number; total: number } } & Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// v3.7:Portfolio(账户敞口,纯代码)与 Risk Sentinel(指纹告警)—— gateway 65bb92a

export interface GroupExposure {
  gross: number;
  long: number;
  short: number;
  net: number;
  /** quality≠ok 时网关不算比率 → null */
  gross_ratio: number | null;
}

export type PortfolioQuality = 'ok' | 'stale' | 'inconsistent' | 'incomplete';
export type RiskCluster = 'crypto_major' | 'crypto_beta' | 'equity_linked' | 'metal' | 'unknown';

export interface ExposureLeg {
  symbol: string;
  side: Direction;
  notional: number;
  cluster: RiskCluster;
  kind?: string;
  [k: string]: unknown;
}

export interface PortfolioSnapshot {
  snapshot_id: string;
  observed_at: number;
  oldest_component_at: number;
  quality: PortfolioQuality;
  quality_note: string | null;
  equity: number;
  available: number;
  positions: GroupExposure;
  /** 含挂单 + 待批预留 */
  projected: GroupExposure;
  worst_net_ratio: { low: number | null; high: number | null };
  by_symbol: Record<string, GroupExposure>;
  by_cluster: Partial<Record<RiskCluster, GroupExposure>>;
  stop_budget_usdt: number;
  stop_budget_ratio: number | null;
  unprotected_notional: number;
  unprotected_symbols: string[];
  legs: ExposureLeg[];
  economic_fingerprint: string;
}

/** GET /api/portfolio/snapshot */
/** §9.18 组合容量(Portfolio Manager 纯代码估算,不是执行授权)。金额一律十进制字符串,算不出的字段显式 null,别 toFixed */
export type CapacityConstraint = 'thread_slots' | 'margin_budget' | 'available_margin' | 'min_size_risk' | 'rules_unknown' | 'market_unavailable' | 'watchlist' | 'snapshot_unavailable';
export type CapacityVerdict = 'ok' | 'needs_equity' | 'rules_unknown' | 'unavailable';
export interface CapacitySymbol {
  symbol: string;
  verdict: CapacityVerdict;
  watch_only: boolean;
  occupied: boolean;
  price: string | null;
  rules_source: 'exchange' | 'paper' | null;
  rules_observed_at: number | null;
  stop_distance_pct: string | null;
  stop_source: 'atr' | 'default' | null;
  min_qty: string | null;
  min_viable_notional: string | null;
  min_size_risk: string | null;
  required_equity: string | null;
  equity_shortfall: string | null;
  margin_per_thread: string | null;
  risk_budget: string | null;
  budget_margin_per_thread: string | null;
}
export interface DemoPortfolioCapacity {
  schema_version?: number;
  snapshot_id?: string | null;
  computed_at?: number;
  equity: string | null;
  available: string | null;
  risk_pct: string;
  leverage: number;
  default_stop_distance_pct: string;
  slots_total: number;
  slots_used: number;
  slots_free: number;
  margin_budget: {
    max_margin_ratio: number;
    limit_usdt: string | null;
    committed_usdt: string | null;
    reserved_usdt: string | null;
    free_usdt: string | null;
    required_for_free_slots_usdt: string | null;
    slots_supported: number | null;
    witness_symbols: string[];
  };
  binding_constraint: CapacityConstraint;
  by_symbol: CapacitySymbol[];
}
export interface PortfolioCapacityResponse {
  capacity: DemoPortfolioCapacity | null;
  snapshot_id: string | null;
}

export interface PortfolioSnapshotResponse {
  snapshot: PortfolioSnapshot | null;
  /** §9.18:同 GET /api/portfolio/capacity 的 capacity;老网关没有 */
  capacity?: DemoPortfolioCapacity | null;
  policy: Record<string, unknown>;
  default_policy: Record<string, unknown>;
  cluster_map_version: string;
  watchlist_clusters: Record<string, RiskCluster>;
}

export type RiskSeverity = 'info' | 'warn' | 'high' | 'critical';
export type RiskLevel = 'none' | 'warn' | 'high' | 'critical';

export interface RiskAlertAction {
  kind: 'verify_protection' | 'confirm_recovery' | 'open_settings' | 'switch_backend';
  label: string;
  method: 'POST' | 'GET';
  path: string;
  body?: Record<string, unknown>;
  /** 按钮旁小字,如费用/耗时 */
  note?: string | null;
}

export interface RiskAlertRow {
  id: string;
  fingerprint: string;
  kind: string;
  severity: RiskSeverity;
  scope: string;
  title: string;
  detail: string;
  value: number | null;
  threshold: number | null;
  refs: string[];
  auto_action: 'none' | 'block_new_risk';
  first_seen_at: number;
  last_seen_at: number;
  observed_count: number;
  resolved_at: number | null;
  acked_at: number | null;
  clean_streak: number;
  /** 只有 true 的 high/critical 才能「确认恢复」;warn 连续 3 轮干净自动解除 */
  /** §9.20:阻断类告警必须带用户可点的动作(不允许「设环境变量/重启」文案);按 method/path/body 调,成功靠 SSE 刷新 */
  action?: RiskAlertAction | null;
  recovery_ready: boolean;
}

/** GET /api/risk/alerts?status= */
export interface RiskAlertsResponse {
  alerts: RiskAlertRow[];
  level: RiskLevel;
  blocks_new_risk: boolean;
}

export interface ServerEventMap {
  'portfolio.changed': { snapshot_id: string; quality: PortfolioQuality; gross_ratio: number };
  'risk.changed': { open: number; opened: string[]; resolved: string[]; recovery_ready: string[] };
}

// ---------------------------------------------------------------------------
// v3.8:Reviewer(平仓复盘卡 + 批量提炼教训)—— gateway 7102cd3

export type TradeExitClass = 'stop' | 'take_profit' | 'model_exit' | 'invalidated' | 'canceled' | 'manual' | 'halt' | 'other';
export type TradeOutcome = 'win' | 'loss' | 'scratch' | 'unfilled' | 'unknown';

export interface TradeCard {
  thread_id: string;
  symbol: string;
  side: Direction;
  source: string;
  strategy_id: string | null;
  status: string;
  filled: boolean;
  entry_price: string | null;
  exit_price: string | null;
  stop_price: string | null;
  qty: string | null;
  realized_pnl: string | null;
  r_multiple: number | null;
  hold_ms: number;
  ended_at: number | null;
  exit_class: TradeExitClass;
  close_reason: string | null;
  outcome: TradeOutcome;
  protection_ok: boolean;
  episode_count: number;
  notes: string[];
}

/** GET /api/reviewer/cards?limit= */
export interface ReviewerCardsResponse {
  cards: TradeCard[];
  decision: { run: boolean; reason: string; pending: number; runs_today: number; last_batch_at: number | null };
  batches: BotRun[];
}

/** POST /api/reviewer/batch:200 跑了;409 不该跑(暂停 / 没新平仓 / 今日已 2 次) */
export interface ReviewerBatchResponse {
  ran: boolean;
  reason: string;
  run_id?: string;
}

// ---------------------------------------------------------------------------
// v3.9:Strategy Lab(机械前瞻期望实验)与 Gate Captain(值班简报)—— gateway c19646d,两者零模型

export interface ExperimentManifest {
  manifest_hash: string;
  code_version: string;
  timeframe: string;
  days: number;
  from: number;
  to: number;
  symbols: string[];
  strategies: { id: string; version: number; content_hash: string; status: string }[];
  outcome: string;
  cooldown_bars: number;
}

export interface ExperimentCell {
  strategy_id: string;
  version: number;
  symbol: string;
  setups: number;
  per_week: number;
  n: number;
  win_rate: number;
  expectancy_r: number;
  total_r: number;
}

/** 机械前瞻期望,不是策略成绩(result.note 会说明);UI 别写「已验证」 */
export interface ExperimentResult {
  manifest_hash: string;
  cells: ExperimentCell[];
  by_strategy: { strategy_id: string; version: number; symbols: string[]; setups: number; n: number; win_rate: number; expectancy_r: number; total_r: number }[];
  errors: unknown[];
  note: string;
  /** 49a0994:funnel 量不出的策略族(资金费率极值 / 区间均值回归),不给数字 */
  unmeasured?: { strategy_id: string; version: number; reason: string }[];
}

/** GET /api/lab/experiments?limit= (experiments[].input = ExperimentManifest, .result = ExperimentResult) */
export interface LabExperimentsResponse {
  experiments: BotRun[];
  decision: { run: boolean; reason: string; last_at: number | null; new_closed: number };
  running: boolean;
}

export interface DailyBrief {
  from: number;
  to: number;
  runs_by_role: Partial<Record<BotRole, { runs: number; done: number; failed: number; skipped: number; cost_cny: number }>>;
  total_cost_cny: number;
  pending_handoffs: { count: number; by_from: Partial<Record<BotRole, number>> };
  risk: { level: RiskLevel; open: number; blocks_new_risk: boolean; titles: string[] };
  portfolio: { quality: PortfolioQuality; equity: number; gross_ratio: number | null; clusters: number } | null;
  trades: { closed: number; wins: number; losses: number; total_r: number; unprotected: number };
  headline: string;
}

/** GET /api/captain/brief;POST 立即出一份 */
export interface CaptainBriefResponse {
  brief: DailyBrief | null;
  due: boolean;
  briefs: BotRun[];
}

// ---------------------------------------------------------------------------
// 09-12 策略闭环 v2 / 议会票面 / 保护腿凭证
// 契约:docs/demo/v3-ui-contract.md §9.25 补正三、§9.25b、§9.27、§9.28、§9.31
//
// 这一段刻意**只加不改**:所有对已有形状的扩展都走 interface 合并(同一模块里重复声明
// 同名 interface,TS 自动并集),新字段一律 optional —— 老网关没有时就是 undefined,
// 界面按「—」兜底,不 toFixed 黑屏。

/** §9.27 台账。`who` 里**没有模型**:模型没有任何晋升权。 */
export type StrategyEventActor = 'code' | 'human' | 'lab' | 'attribution';
export type StrategyEventKind = 'version_created' | 'promote' | 'demote' | 'retire' | 'activated' | 'deactivated';

export interface StrategyEvent {
  id: number;
  strategy_id: string;
  version: number;
  at: number;
  who: StrategyEventActor;
  kind: StrategyEventKind;
  from_status: StrategyStatus | null;
  to_status: StrategyStatus | null;
  reason: string;
  /** 判这一步用到的**数字**(lab_n / shadow_expectancy_r / loss_streak …);不写形容词,可为 null。 */
  evidence: Record<string, number | null>;
}

/** GET /api/strategies/:id/timeline —— **旧的在前**(时间线从上往下画),最多 500 行。 */
export interface StrategyTimelineResponse {
  strategy_id: string;
  events: StrategyEvent[];
}

/** §9.27 影子实盘成绩(虚拟线程按真实 K 线结算);n=0 时每个数都是 null,不编数。 */
export interface ShadowStats {
  direction_proxy?: ShadowStats;
  full_strategy?: ShadowStats;
  net_expectancy_r?: number | null;
  net_max_drawdown_r?: number | null;
  n: number;
  win_rate: number | null;
  expectancy_r: number | null;
  total_r: number;
  /** 累计 R 曲线的峰谷回撤(正数,单位 R)。 */
  max_drawdown_r: number;
  first_at: number | null;
  last_at: number | null;
}

export type ShadowThreadStatus = 'open' | 'settled' | 'unscoreable';

/** §9.27 虚拟线程:不下单、不占容量、不进风控、不进胜率。`r=null` 不进任何统计。 */
export interface ShadowThread {
  id: string;
  kind: 'shadow';
  strategy_id: string;
  version: number;
  content_hash: string;
  symbol: string;
  timeframe: string;
  side: Direction;
  opened_at: number;
  horizon_end_at: number;
  status: ShadowThreadStatus;
  r: number | null;
  settled_at: number | null;
  episode_id: string | null;
  note: string;
}

/** §9.27 降级实时判据(用来显示「离降级还有多远」)。 */
export interface DegradeDecision {
  degrade: boolean;
  reason: string;
  n: number;
  expectancy_r: number | null;
  loss_streak: number;
}

/** §9.27 归因 → Lab 探针队列。 */
export interface LabProbeItem {
  id: string;
  strategy_id: string;
  param: string;
  value: number;
  source: 'attribution' | 'human';
  source_ref: string | null;
  queued_at: number;
  status: 'queued' | 'verified' | 'rejected';
  checked_at: number | null;
  note: string | null;
}

/** §9.34 `PUT /api/strategies/:id/evidence` 的响应:新 draft + 它是从哪个版本分出来的。 */
export interface StrategyEvidenceResponse {
  strategy: StrategyView;
  from_version: number;
}

/** §9.27 自定义证据。进 content_hash;没写的老版本 hash 一个字不变。 */
export interface StrategyEvidenceSpec {
  indicators: { id: string; tf: string; params?: Record<string, number> }[];
  events: string[];
  info_topics?: string[];
}

/** Strategy Lab 的机械前瞻成绩(零模型);`shadow` 是影子实盘成绩,是它的对照面。 */
export interface LabStats {
  run_id: string;
  at: number;
  symbols: number;
  setups: number;
  n: number;
  win_rate: number | null;
  expectancy_r: number | null;
  total_r: number;
  note: string;
  shadow?: ShadowStats | null;
}

export interface StrategySpec {
  /** 判断视野(intraday / swing …);老网关没有。 */
  horizon?: string;
  /** 09-07 Lab 写回的机械成绩;老网关没有。 */
  lab_stats?: LabStats | null;
  /** §9.27 自定义证据;null / undefined = 用默认集(看 StrategyView.effective_evidence)。 */
  evidence?: StrategyEvidenceSpec | null;
}

export interface StrategyView {
  /** §9.28:有没有 ≥ paper 的版本。UI 用它决定「启用」能不能点,不自己推状态。 */
  activatable?: boolean;
  /** §9.27:shadow 状态时离 paper 还差什么;非 shadow 或已够格时 null。 */
  shadow_blocked?: string | null;
  /** §9.27:生效证据集(没写 evidence 时就是默认集 DEFAULT_EVIDENCE)。 */
  effective_evidence?: StrategyEvidenceSpec | null;
  /** §9.27:普通触发交集，加上 evidence.events 中事件 subkind 订阅对应的 event 入口。 */
  wake_kinds?: string[];
  horizon_label?: string;
}

export interface StrategyDetailResponse {
  /** §9.27:最多 200 行,旧的在前。 */
  timeline?: StrategyEvent[];
  /** §9.27:head 版本的影子线程,最多 50。 */
  shadow_threads?: ShadowThread[];
  degrade?: DegradeDecision | null;
  probe_queue?: LabProbeItem[];
}

/** POST /api/strategies/:id/activate|deactivate —— 被状态闸拒时 409 + errors。 */
export interface StrategyToggleResponse {
  active: string[];
  workflow: Workflow;
  strategy: StrategyView;
}

// ---- §9.25 / §9.25b 策略议会 -------------------------------------------------

export type CouncilMode = 'off' | 'advise' | 'require';
export type CouncilModelMode = 'off' | 'cheap' | 'main';
export type VerdictStance = 'long' | 'short' | 'neutral' | 'abstain';
/** confirmed = 市价可用;pending = 方向成立但只许限价挂回踩区;failed = 时机判据坏了。 */
export type EntryTiming = 'confirmed' | 'pending' | 'failed';

export interface VerdictCheck {
  id: string;
  /** null = 这项算不出来(数据缺)。 */
  pass: boolean | null;
  note: string;
}

export interface StrategyFit {
  /** 0–1;null = 一个来源都没有(不编数)。 */
  score: number | null;
  parts: { radar: number | null; lab: number | null; eval: number | null; history: number | null };
  note: string;
}

export interface StrategyVerdict {
  strategy_id: string;
  version: number;
  content_hash: string;
  horizon: string;
  stance: VerdictStance;
  /** 0–1;abstain 时 0。 */
  confidence: number;
  entry_timing: EntryTiming | null;
  source: 'code' | 'model' | 'code+model';
  /** §9.27 影子实盘票:只表态、不计共识。旧快照没有这个字段。 */
  advisory?: boolean;
  fit: StrategyFit;
  checks: VerdictCheck[];
  reasons: string[];
  at: number;
}

export interface CouncilConsensus {
  reached: boolean;
  direction: Direction | null;
  agreeing: string[];
  dissenting: string[];
  neutral: string[];
  abstaining: string[];
  /** 用户设的 council_min_agree **原样**(09-12 起不再钳降);显示它就是真门槛。 */
  required: number;
  /** 这次真正能投票(非弃权)的策略 id。 */
  voting: string[];
  /** false = 这条闸这次**根本没生效**(与「无共识」含义不同,前端要红标)。 */
  gate_effective: boolean;
  gate_reason: string;
  /** 同意方里最保守的那个;没有方向票时 null。 */
  entry_timing: EntryTiming | null;
  reason: string;
}

export interface StrategyCouncil {
  version: string;
  at: number;
  symbol: string;
  mode: CouncilMode;
  verdicts: StrategyVerdict[];
  consensus: CouncilConsensus;
  /** 进 prompt 的那一行代码汇总,UI 可以直接显示。 */
  text: string;
}

/** 复查 episode 的票面复核(票池被缩小成开仓时同意的那几条)。 */
export interface CouncilReview {
  still_agree: string[];
  flipped: string[];
  gone_neutral: string[];
  text: string;
}

/** §9.26 入场方式建议(扫描时有,复查为 null)。zone 永远落在现价的不利侧。 */
export interface EntryAdvice {
  recommended: 'market' | 'limit';
  zone: [string, string] | null;
  dist_to_break_atr: number | null;
  retest_confirmed: boolean;
  market_blocked: boolean;
  reason: string;
  text: string;
}

/** §9.26 已挂在交易所的限价单复查时才有。 */
export interface PendingEntryView {
  bars_waited: number;
  minutes_waited: number;
  max_wait_bars: number;
  in_zone: boolean;
  dist_to_zone_atr: number | null;
  ran_away: boolean;
  structure_gone: boolean | null;
  volume_dry: boolean | null;
  cancel_warranted: boolean;
  reasons: string[];
  text: string;
}

export interface Episode {
  /** §9.25;off 模式缺省,可为 null。 */
  strategy_council?: StrategyCouncil | null;
  council_review?: CouncilReview | null;
  entry_advice?: EntryAdvice | null;
  pending_entry?: PendingEntryView | null;
}

export interface EpisodeSummary {
  /** §9.26 列表摘要:议会关闭时 null。 */
  council?: {
    reached: boolean;
    direction: Direction | null;
    agreeing: number;
    required: number;
    abstaining: number;
    gate_effective: boolean;
    entry_timing: EntryTiming | null;
  } | null;
  /** 非扫描 episode 为 null。 */
  entry?: { recommended: 'market' | 'limit'; market_blocked: boolean } | null;
}

// ---- §9.31 保护腿凭证 --------------------------------------------------------

/** 通道汇总取**最好**的那条凭证;阻断是按 credentials[].state 逐币判的,不看汇总。 */
export type ProtectionState = 'not_needed' | 'verifying' | 'verified' | 'verified_stale_or_probe_failed' | 'never_verified';

export interface ProtectionCredential {
  channel: string;
  /** §9.40:凭证按 (channel, symbol, market) 记;老网关没有 → perp */
  market?: Market;
  /** null = v3.11 迁移来的通道级兜底凭证。 */
  symbol: string | null;
  state: ProtectionState;
  verified_at: number | null;
  expires_at: number | null;
  last_probe_at: number | null;
  last_probe_ok: boolean | null;
  last_error: string | null;
  last_auto_at: number | null;
  /** 'symbol' = 这个币自己的凭证;'channel' = 通道级兜底;null = 没有。 */
  source: 'symbol' | 'channel' | null;
}

export interface ProtectionStatusView {
  /** 新前端看这个(旧 `status` 只是兼容字段)。 */
  state?: ProtectionState;
  /** 当前生效的有效期(天,1–30)。 */
  ttl_days?: number;
  /** 汇总凭证的过期时刻(按当前 ttl 现算)。 */
  expires_at?: number | null;
  /** 自动重验这轮为什么没跑。 */
  auto_note?: string | null;
  credentials?: ProtectionCredential[];
}

export interface Workflow {
  /** §9.28:只有 paper / live_capped 的策略能进这里。 */
  active_strategies?: string[];
  /**
   * §9.35 票池谁来改:`manual`(默认)= 只有人改,allocator 只算预览不落库;
   * `auto` = allocator 每天一次用**代码**决策票池。模型没有任何一条路径能改票池。
   */
  active_mode?: AllocatorMode;
  /** §9.25 三个开关(只有人能改)。 */
  strategy_council?: CouncilMode;
  council_min_agree?: number;
  council_model?: CouncilModelMode;
  /** §9.26 限价入场与挂单耐心。 */
  entry_style?: 'free' | 'prefer_limit' | 'limit_only';
  entry_max_wait_bars?: number;
  /** §9.27 假设生成(便宜大脑,每周 ≤ 1 次)。 */
  strategy_discovery?: boolean;
  /** §9.31 止损验证凭证多久要重验一次(整数 1–30,默认 7)。 */
  protection_ttl_days?: number;
}

// ---- §9.35 策略自动轮换 allocator ------------------------------------------
// 红线:allocator 只动 `active_strategies` 这一个数组,不碰任何经济字段;
// 台账 `who` 只会是 'code'(自动决策 / 回滚)或 'human'(手点启用停用),**永远没有模型**。

export type AllocatorMode = 'manual' | 'auto';

/**
 * 排序用的期望取自哪一档(降级顺序见契约 §9.35 决策规则第 2 条:
 * regime 桶 net → 全样本 net → 样本外 net → lab 毛值)。
 * `lab_gross` 是**毛值**——前端必须标出来,不能让用户当净值看。
 *
 * 前四个是网关 `strategy-allocator.ts` 的 `ExpectancySource` 实际取值;后面四个是契约 §9.35
 * 正文里按 lab_stats 字段名写的那一套别名,两套都认,免得口径一变界面就掉成原始 key。
 */
export type AllocatorExpectancySource =
  | 'regime_net'
  | 'net'
  | 'oos_net'
  | 'lab_gross'
  | 'none'
  | 'regime_net_expectancy_r'
  | 'net_expectancy_r'
  | 'oos_net_expectancy'
  | 'lab_expectancy_r';

/** 为什么没进票池;null = 在池里或本轮没有被任何一条闸拦住。 */
export type AllocatorBlockedBy = 'status' | 'health' | 'family_taken' | 'correlated' | 'cooldown' | 'rank' | null;

export interface AllocatorCandidate {
  id: string;
  name: string;
  family: StrategyFamily;
  family_label: string;
  version: number;
  status: StrategyStatus;
  in_pool: boolean;
  eligible: boolean;
  /** 排序用的期望;null = 没有成绩,排最后。 */
  expectancy_r: number | null;
  expectancy_source: AllocatorExpectancySource;
  n: number | null;
  healthy: boolean;
  /** 不健康时那一句;健康时网关给空串。 */
  health_reason: string | null;
  correlation_key: string;
  blocked_by: AllocatorBlockedBy;
  /** 一句话「为什么在 / 不在票池」,直接显示。 */
  reason: string;
}

export interface AllocatorMove {
  id: string;
  reason: string;
}

/** GET 里的 decision 是**预览**(不落库);POST /run 回的是这次真跑的结果。 */
export interface AllocatorDecision {
  version: string;
  at: number;
  mode: AllocatorMode;
  regime: DailyRegime | null;
  changed: boolean;
  from: string[];
  to: string[];
  add: AllocatorMove[];
  remove: AllocatorMove[];
  keep: AllocatorMove[];
  reason: string;
}

/** GET /api/strategies/allocator */
export interface AllocatorView {
  mode: AllocatorMode;
  max: number;
  active: string[];
  regime: DailyRegime | null;
  /** 现在跑一遍会怎么动(预览,不落库);null = 算不出来。 */
  decision: AllocatorDecision | null;
  candidates: AllocatorCandidate[];
  last_run_at: number | null;
  last_change_at: number | null;
  last_reason: string | null;
  /** 可回滚到的上一票池;null = 没得回滚(按钮禁用)。 */
  previous: string[] | null;
  /** 最近 20 条 activated / deactivated 台账。 */
  events: StrategyEvent[];
}

/** POST /api/strategies/allocator/mode { mode } —— mode 非法是 400。 */
export interface AllocatorModeResponse {
  mode: AllocatorMode;
  workflow: Workflow;
}

/** POST /api/strategies/allocator/run { force? } —— manual 下只有 force=true 才落库。 */
export interface AllocatorRunResponse {
  decision: AllocatorDecision;
  active: string[];
  applied: boolean;
}

/** POST /api/strategies/allocator/rollback —— 没有上一票池时 409。 */
export interface AllocatorRollbackResponse {
  active: string[];
  previous: string[] | null;
  restored: boolean;
}

// §9.29 判断准确度账本(GET /api/judgment-ledger、/api/judgment-ledger/summary)
// 三条腿在同一 horizon、同一批 K 线上各结算一次 R:模型 / 议会 / 机械基线。
// 全部字段可能为 null(落行时三条腿都是 null,结算是异步的);null ≠ 0,UI 一律显示「—」。

export type LedgerLegStatus = 'stop' | 'tp' | 'expired' | 'flat' | 'unscoreable';
export type LedgerOutcomeSource = 'thread_settlement' | 'counterfactual' | 'flat' | 'unscoreable';
export type LedgerVerdict = 'insufficient' | 'no_edge' | 'model_adds' | 'model_hurts' | 'unclear';

export interface LedgerLeg {
  direction: Direction | null;
  /** flat = 0;unscoreable = null。 */
  r: number | null;
  status: LedgerLegStatus;
  fill: number | null;
  stop: number | null;
  tp: number | null;
  bars_walked: number;
  note: string;
}

export interface LedgerSnapshot {
  timeframe: string;
  last_close: number;
  mark: number | null;
  atr14: number;
  swing_high_20: number;
  swing_low_20: number;
  ema20_1h: number | null;
  ema50_1h: number | null;
}

export interface LedgerReviewSnapshot {
  status: 'in_position' | 'pending_entry';
  side: Direction;
  entry_type: 'market' | 'limit';
  entry_price: number | null;
  fill: number | null;
  stop: number;
  tp: number | null;
}

export interface LedgerRegret {
  hold_r: number;
  exit_now_r: number;
  chosen_r: number;
  best_r: number;
  /** best_r − chosen_r,按构造 ≥ 0。 */
  regret_r: number;
  hold_status: 'stop' | 'tp' | 'expired' | 'unfilled';
  note: string;
}

export interface JudgmentLedgerRow {
  version: string;
  episode_id: string;
  at: number;
  as_of: number;
  symbol: string;
  /** 判断周期;没有结构证据时 null,该行永远结算不出 R。 */
  timeframe: string | null;
  mode: 'scan' | 'review';
  thread_id: string | null;
  strategy_id: string | null;
  model_action: string | null;
  /** null = 不表态(NO_TRADE / WATCH / EXIT / INVALIDATE)。 */
  model_dir: Direction | null;
  council_dir: Direction | null;
  /** null = 这次没有议会;false 才是没达成共识。 */
  council_agree: boolean | null;
  mechanical_dir: Direction | null;
  mechanical_note: string | null;
  horizon_end_at: number;
  outcome_r_model: number | null;
  outcome_r_council: number | null;
  outcome_r_mechanical: number | null;
  /** null = 还没结算;thread_settlement = 交易所净 R。 */
  outcome_source_model: LedgerOutcomeSource | null;
  regret_review: number | null;
  settled_at: number | null;
  settle_note: string | null;
  snapshot: LedgerSnapshot | null;
  review: LedgerReviewSnapshot | null;
  legs: { model: LedgerLeg | null; council: LedgerLeg | null; mechanical: LedgerLeg | null };
  regret: LedgerRegret | null;
}

export interface LedgerStratum {
  /** null = 全体那一层;分层里没指明策略的归到 '(未指明策略)'(这个值不能当 strategy_id 查参数用)。 */
  strategy_id: string | null;
  n: number;
  /** n < min_sample:数字照算,不下结论。 */
  insufficient: boolean;
  judgment_alpha: number | null;
  alpha_n: number;
  alpha_vs_mechanical: number | null;
  alpha_mech_n: number;
  override_rate: number | null;
  override_n: number;
  override_alpha: number | null;
  review_regret: number | null;
  review_n: number;
  verdict: LedgerVerdict;
}

export interface LedgerSummary {
  version: string;
  since: number | null;
  n: number;
  settled: number;
  unsettled: number;
  overall: LedgerStratum;
  by_strategy: LedgerStratum[];
  min_sample: number;
  /** 写死在网关代码里的结论口径,UI 原样显示,不让模型改写。 */
  conclusion: string;
}

export interface JudgmentLedgerResponse {
  rows: JudgmentLedgerRow[];
  total: number;
  limit: number;
  offset: number;
  since: number | null;
  strategy_id: string | null;
  /** 游标分页:这一页最后一行的游标,传给下一次请求的 `cursor` 接着翻;`rows` 为空时是 null。 */
  next_cursor: string | null;
}

// ---------------------------------------------------------------------------
// §9.30 事件区(GET/POST /api/market-events)——**路径是 market-events,/api/events 是 SSE**

export type MarketEventKind = 'scheduled' | 'news' | 'exchange' | 'onchain' | 'derived';
export type MarketEventStatus = 'captured' | 'briefed' | 'live' | 'resolved' | 'retro_done' | 'dismissed';
export type MarketEventConfidence = 'confirmed' | 'reported' | 'rumor';

export interface MarketEventBrief {
  source?: 'research';
  task_id?: string;
  at: number;
  text: string;
  refs: string[];
  /** 出简报时距事件开始还有几分钟(T−60 / T−10);算不出为 null。 */
  lead_minutes: number | null;
}

export interface MarketEventImpact {
  /** 这四个数每一个都可能单独是 null(K 线还没到那么远就是 null,不编)。 */
  move_1h_pct: number | null;
  move_4h_pct: number | null;
  move_24h_pct: number | null;
  realized_vol_ratio: number | null;
  symbol: string;
  base_price: number;
  computed_at: number;
}

export interface MarketEvent {
  id: string;
  kind: MarketEventKind;
  subkind: string;
  /** 基础资产,不带 USDT 后缀;**空数组 = 宏观事件**。 */
  assets: string[];
  /** 只有 scheduled 有;其余 null,窗口从 captured_at 起算。 */
  expected_at: number | null;
  window_ms: number;
  captured_at: number;
  updated_at: number;
  source: string;
  /** 可能是空字符串(手动补录不填);外部链接,按不可信内容渲染。 */
  source_ref: string;
  confidence: MarketEventConfidence;
  status: MarketEventStatus;
  /** 最近一份简报;没出过为 null。 */
  brief: MarketEventBrief | null;
  /** 简报历史(最多 2 份:T−60m / T−10m)。 */
  briefs: MarketEventBrief[];
  /** 已经为这条事件调过几次便宜大脑,硬上限 2。 */
  brief_count: number;
  impact: MarketEventImpact | null;
  /** 引用过这条事件的 episode id(最多最近 50 条)。 */
  used_by: string[];
  /** 已 sanitize 的标题,前端仍按不可信内容渲染。 */
  title: string;
  dedupe_key: string;
  resolved_at: number | null;
  dismissed_at: number | null;
  // 派生字段(网关算好的,前端别自己算窗口)
  starts_at: number;
  ends_at: number;
  in_window: boolean;
  /** 已开始为负数。 */
  minutes_to_start: number;
}

export interface EventStats {
  subkind: string;
  samples: number;
  /** samples = 0 时后四个字段全是 null,UI 要写「样本不足」而不是 0。 */
  avg_abs_move_4h_pct: number | null;
  avg_move_4h_pct: number | null;
  direction_agreement: number | null;
  dominant_direction: 'up' | 'down' | null;
}

export interface MarketEventsResponse {
  as_of: number;
  events: MarketEvent[];
  /** subkind → EventStats,只含列表里出现过的 subkind。 */
  stats: Record<string, EventStats>;
  calendar: { last_verified_at: number | null; entries: number; feeds: number };
  event_blackout_min: number;
  brief_usage_today: { calls: number; input_tokens: number; output_tokens: number };
  /** 分类器认得的全集,给筛选下拉用。 */
  subkinds: string[];
}

export interface MarketEventDetailResponse {
  as_of: number;
  event: MarketEvent;
  stats: EventStats;
}

export interface MarketEventCreateRequest {
  title: string;
  kind?: MarketEventKind;
  subkind?: string;
  assets?: string[];
  expected_at?: number | null;
  window_ms?: number;
  source_ref?: string;
  confidence?: MarketEventConfidence;
}

export interface MarketEventCreateResponse {
  created: boolean;
  event: MarketEvent;
}

// ---- §9.37 策略归因 + 短中长分层 + 决策记录 ---------------------------------
// 与 packages/gateway/src/demo/{types,attribution}.ts 逐字对齐;不要在这里「改进」。

export type Tier = 'short' | 'mid' | 'long';
export const TIERS: readonly Tier[] = ['short', 'mid', 'long'];
export const TIER_LABEL: Record<Tier, string> = { short: '短线', mid: '中线', long: '长线' };
/** horizon → tier。四个 horizon 压进三层,intraday(当日了结)按定义归 short。 */
export const TIER_OF: Record<string, Tier> = { scalp: 'short', intraday: 'short', swing: 'mid', position: 'long' };

/** 每个数字字段 0 = 继承全局 / 不额外限制;`entry_styles` 空数组 = 不限。 */
export interface TierPolicy {
  max_open_threads: number;
  max_opens_per_day: number;
  entry_styles: ('market' | 'limit')[];
  council_min_agree: number;
  allocator_slots: number;
}

export interface Workflow {
  /** §9.37 分层配额;老网关没有这个字段 → 设置页那一区不渲染。 */
  tier_policy?: Record<Tier, TierPolicy>;
}

export interface AllocatorCandidate {
  /** §9.37:这条策略属于哪一层。 */
  tier?: Tier;
}

// ---- 归因报告 ---------------------------------------------------------------

export type ExitKind = 'stop' | 'take_profit' | 'expiry' | 'invalidation' | 'manual' | 'other';
export type SymbolOrigin = 'radar' | 'whitelist' | 'watchlist' | 'manual' | 'unknown';

export interface AttributionDirectionBucket {
  n: number;
  net_r_sum: number;
  expectancy_r: number | null;
  win_rate: number | null;
}

export interface AttributionReport {
  version: string;
  strategy_id: string;
  strategy_name: string | null;
  strategy_version: number;
  backend: string;
  tier: Tier | null;
  horizon: string | null;
  n: number;
  expectancy_r: number | null;
  win_rate: number | null;
  net_r_sum: number;
  /** 整块样本不足(n < min_sample):推断量全 null,计数量仍在。 */
  insufficient: boolean;
  min_sample: number;
  window: [number, number] | null;
  /** 有几笔只能用价格算 R(没有交易所净额)。 */
  price_only_n: number;
  direction: {
    insufficient: boolean;
    n: number;
    long: AttributionDirectionBucket;
    short: AttributionDirectionBucket;
    /** long 期望 − short 期望;正 = 这条策略只有多头能赚。 */
    skew: number | null;
  };
  frequency: {
    insufficient: boolean;
    window_days: number | null;
    opens: number;
    opens_per_week: number | null;
    opportunities: number | null;
    opportunities_per_week: number | null;
    conversion: number | null;
    /** gate 是 GateResult.name,不是自由文本。 */
    blocked: { gate: string; n: number }[];
    coverage_from: number | null;
    note: string;
  };
  exits: {
    insufficient: boolean;
    n: number;
    by_kind: { kind: ExitKind; label: string; n: number; share: number; expectancy_r: number | null }[];
    mae_r_p50: number | null;
    mfe_r_p50: number | null;
    stop_distance_pct_p50: number | null;
    /** 费 / 初始风险。> 0.2 基本等于「策略在给交易所打工」。 */
    cost_over_risk_p50: number | null;
    note: string;
  };
  period: {
    insufficient: boolean;
    online_timeframes: { tf: string; n: number }[];
    replay_timeframe: string;
    consistent: boolean;
    mismatch: { tf: string; n: number }[];
    live_net_expectancy_r: number | null;
    replay_oos_net_expectancy_r: number | null;
    /** 线上 − 回放 OOS:「回放说的」和「真的发生的」之间的距离。 */
    gap: number | null;
  };
  screener: {
    insufficient: boolean;
    n: number;
    by_origin: { origin: SymbolOrigin; label: string; n: number; share: number; expectancy_r: number | null }[];
  };
}

/** GET /api/attribution/summary */
export interface AttributionSummaryResponse {
  backend: string;
  since: number | null;
  generated_at: number;
  min_sample: number;
  by_tier: { tier: Tier; strategies: number; n: number; net_r_sum: number; expectancy_r: number | null; insufficient: boolean }[];
  strategies: AttributionReport[];
}

/** GET /api/strategies/:id/attribution */
export interface StrategyAttributionResponse {
  strategy_id: string;
  backend: string;
  since: number | null;
  generated_at: number;
  versions: AttributionReport[];
  report: AttributionReport | null;
}

// ---- 决策记录(减黑盒) -----------------------------------------------------

export const DECISION_REASON_CODES = [
  'code_graph_edges', 'code_council_consensus', 'code_council_no_consensus', 'code_council_off',
  'code_entry_free', 'code_entry_prefer_limit', 'code_entry_limit_only', 'code_no_strategy',
  'model_within_allowed', 'model_illegal_repaired', 'model_failclosed', 'model_no_output',
  'gate_pass', 'gate_blocked', 'gate_not_applicable',
  'gate_tier_daily_cap', 'gate_tier_capacity', 'gate_tier_entry_style',
  'exec_intent', 'exec_awaiting_approval', 'exec_none',
  // 四、跟单(v3.13 §9.38):trader-follow.ts 的判定码
  'trader_follow_copy', 'trader_follow_book', 'trader_follow_book_pending', 'trader_follow_agent_agree', 'trader_follow_agent_disagree', 'trader_follow_agent_flat',
  'trader_signal_stale', 'trader_signal_no_stop', 'trader_gate_blocked', 'trader_reverse_exposure',
  'trader_duplicate_open', 'trader_add_manual', 'trader_mgmt_orphan',
] as const;

export type DecisionReasonCode = (typeof DECISION_REASON_CODES)[number];

/** 后端只发 code;中文在这里。认不出的 code 原样显示(不吞掉新增的枚举值)。 */
export const DECISION_REASON_LABEL: Record<DecisionReasonCode, string> = {
  code_graph_edges: '判断图给出合法动作',
  code_council_consensus: '议会已达成共识',
  code_council_no_consensus: '议会没有共识',
  code_council_off: '议会已关闭',
  code_entry_free: '入场方式不限',
  code_entry_prefer_limit: '优先限价',
  code_entry_limit_only: '只允许限价',
  code_no_strategy: '没有生效策略',
  model_within_allowed: '模型选在允许集内',
  model_illegal_repaired: '模型选了允许集外的,已修复',
  model_failclosed: '模型输出不合法,fail-closed',
  model_no_output: '模型没有输出',
  gate_pass: '全闸通过',
  gate_blocked: '被代码闸拒绝',
  gate_not_applicable: '这次不涉及开仓闸',
  gate_tier_daily_cap: '本层每日开仓已满',
  gate_tier_capacity: '本层容量已满',
  gate_tier_entry_style: '本层不允许这种入场方式',
  exec_intent: '已落意图',
  exec_awaiting_approval: '等人批准',
  exec_none: '没有动作',
  trader_follow_copy: '按 copy 直接跟',
  trader_follow_book: '组合经理接管',
  trader_follow_book_pending: '开仓意图等确认',
  trader_follow_agent_agree: 'agent 同向',
  trader_follow_agent_disagree: 'agent 反向,不跟',
  trader_follow_agent_flat: 'agent 不表态,不跟',
  trader_signal_stale: '信号超龄/补拉,只留痕',
  trader_signal_no_stop: '没有止损,降级留痕',
  trader_gate_blocked: '被交易闸拒绝',
  trader_reverse_exposure: '已有反向敞口,拒绝',
  trader_duplicate_open: '同币已有活线程,重复开仓',
  trader_add_manual: '加仓信号,留人工处理',
  trader_mgmt_orphan: '管理动作找不到关联线程',
};

export interface DecisionRecord {
  version: string;
  at: number;
  tier: Tier | null;
  allowed: {
    actions: string[];
    entry_styles: ('market' | 'limit')[];
    council: { reached: boolean; direction: 'long' | 'short' | null; agreeing: number; required: number } | null;
    strategies: { id: string; version: number; content_hash: string }[];
    codes: DecisionReasonCode[];
  };
  model: {
    action: string | null;
    direction: 'long' | 'short' | null;
    entry: 'market' | 'limit' | null;
    confidence: number | null;
    illegal_action: string | null;
    codes: DecisionReasonCode[];
  };
  executed: {
    action: string | null;
    passed: boolean;
    blocked_by: string[];
    intent_id: string | null;
    codes: DecisionReasonCode[];
  };
  evidence_plan_hash: string | null;
  strategy_version_hash: string | null;
}

// ---------------------------------------------------------------------------
// v3.13:跟单 session(Trader Follow,契约 §9.38;设计 docs/design/trader-follow-2026-09-12.md)

/** 2026-09-20 晚改道:`book` = 组合经理接管(不问模型),`copy` 旧名由网关映射成 book。 */
export type FollowMode = 'book' | 'gated' | 'evidence';
export const FOLLOW_MODES: readonly FollowMode[] = ['book', 'gated', 'evidence'];
export type FollowApproval = 'manual' | 'auto';

export const FOLLOW_MODE_LABEL: Record<FollowMode, string> = {
  book: '组合经理接管',
  gated: 'agent 把关',
  evidence: '只留证据',
};

export type TraderAction =
  | 'open' | 'add' | 'reduce' | 'close' | 'cancel'
  | 'stop_loss_update' | 'take_profit_update' | 'stopped_out' | 'analysis_only' | 'unknown';

export const TRADER_ACTIONS: readonly TraderAction[] = [
  'open', 'add', 'reduce', 'close', 'cancel', 'stop_loss_update', 'take_profit_update', 'stopped_out', 'analysis_only', 'unknown',
];

export const TRADER_ACTION_LABEL: Record<TraderAction, string> = {
  open: '开仓',
  add: '加仓',
  reduce: '减仓',
  close: '平仓',
  cancel: '撤单',
  stop_loss_update: '移损',
  take_profit_update: '改止盈',
  stopped_out: '止损出场',
  analysis_only: '仅分析',
  unknown: '未知动作',
};

export type TraderEntryKind = 'market' | 'limit' | 'zone' | 'ladder' | 'unknown';

export type TraderSignalStatus =
  | 'new' | 'triggered' | 'applying' | 'applied' | 'apply_failed'
  | 'skipped' | 'evidence' | 'review_only' | 'expired' | 'dead' | 'mgmt_applied' | 'mgmt_orphan';

export const TRADER_SIGNAL_STATUSES: readonly TraderSignalStatus[] = [
  'new', 'triggered', 'applying', 'applied', 'apply_failed',
  'skipped', 'evidence', 'review_only', 'expired', 'dead', 'mgmt_applied', 'mgmt_orphan',
];

/** 唯一的「可执行前态」(设计 §7):只有这一档的行给 apply/skip 按钮(服务端也这么认,不只是前端隐藏)。 */
export const FOLLOW_EXECUTABLE_STATUS: TraderSignalStatus = 'review_only';

export const TRADER_SIGNAL_STATUS_LABEL: Record<TraderSignalStatus, string> = {
  // new/triggered 是在途(落库了还没处置完/正在判断),统一显示「处理中」,不给按钮。
  new: '处理中',
  triggered: '处理中',
  // 09-13 四审:apply 点下去到真正落线程之间的领取窗口,按钮禁用,只读。
  applying: '开仓请求处理中',
  // 09-13 四审:apply 开出的是普通手动线程,由既有系统正常管理,不再叫「跟」。
  applied: '已手动开仓(开线程)',
  // R4-03:明确失败(不是不确定),允许人再点一次重试;`needs_reconcile` 不是状态,是行上的独立标记。
  apply_failed: '开仓失败(可重试)',
  skipped: '已跳过',
  evidence: '只留证据',
  review_only: '待人工拍板',
  expired: '已过期',
  dead: '已失效',
  mgmt_applied: '管理动作已执行',
  mgmt_orphan: '孤儿管理动作',
};

export interface TraderTakeProfit {
  price: string;
  pct: number | null;
}

/** gated 那次 agent 判断的结论(首发用途是**给人的依据**,不是执行许可)。copy/evidence 没有。 */
export interface TraderAgentVerdict {
  stance: 'agree' | 'disagree' | 'flat';
  action: string | null;
  direction: Direction | null;
  /** agent 自己那套几何里的止损,人工执行时可参考「更紧的那个」。 */
  stop: string | null;
  /** 那次判断被哪些闸拒了;空 = 全过。 */
  blocked: string[];
}

/** 人工执行这条信号要用的几何(`review_only` 才有)。**计划值**,不是交易所已挂成功的证明。 */
export interface TraderExecutionPlan {
  entry: string;
  intent: 'limit' | 'market';
  stop: string;
  take_profits: string[];
  reason: string;
}

export interface TraderDecision {
  codes: DecisionReasonCode[];
  note: string;
  episode_id?: string | null;
  weight?: number | null;
  /** gated 的 agent 结论;copy / evidence 为 null。 */
  agent?: TraderAgentVerdict | null;
  /** 人工执行几何(review_only 才有);copy/gated 之外为 null。 */
  plan?: TraderExecutionPlan | null;
  at: number;
}

export interface TraderSignal {
  id: string;
  signal_id: string;
  record_id: number | null;
  trader: string;
  symbol: string;
  side: Direction | null;
  action: TraderAction;
  entry_kind: TraderEntryKind;
  entry_prices: string[];
  stop: string | null;
  tps: TraderTakeProfit[];
  size_pct: string | null;
  valid_until: number | null;
  published_at: number;
  ingested_at: number;
  raw_text: string;
  ref_order: string | null;
  order_end_state: string | null;
  market_type: string;
  /** §9.40:套利信号(仅记录,不产生意图);普通信号没有该字段 */
  kind?: 'arbitrage' | string;
  arbitrage?: { symbol: string; spot_side: 'long'; perp_side: 'short'; basis_pct: string | null; expected_apr: string | null } | null;
  /** 信号从哪条链路进来的;bridge 之外 2026-09-20 起多了 `'okx_asp'`(OKX.AI 订阅投递)。 */
  transport: string;
  backfill: boolean;
  /** R4-04:哪个 follow 会话拉进来的;跨会话的旧行按历史信号处理(等同 backfill)。 */
  session: string | null;
  /**
   * R4-03/R5-01:这条信号处在「我们不知道交易所那边到底怎么样」的状态,需要人去对账。
   * **独立的布尔标记,不是状态值**——`apply`/`skip` 撞到 `true` 都会 409,要先点「已人工核对」
   * (`POST /api/follow/signals/:id/reconcile`,只清标记不动钱)才放行。
   */
  needs_reconcile: boolean;
  /** R5-01 领取身份三件套,`applying` 期间非空;前端不需要用它,只读透传。 */
  claim_id: string | null;
  claim_owner: string | null;
  claim_at: number | null;
  /**
   * `valid_until` 在场但不可信(解析不出 / 早于 `published_at`,含倒挂)。
   * 这种信号**不许进入可执行状态**——标红,前端别当成「没有期限」。
   */
  invalid_validity: boolean;
  status: TraderSignalStatus;
  mode_applied: FollowMode | null;
  thread_id: string | null;
  decision: TraderDecision | null;
  created_at: number;
  updated_at: number;
}

export interface FollowSignalsResponse {
  signals: TraderSignal[];
  inbox: MarketInboxStatus;
}

export interface FollowSignalActionResponse {
  signal: TraderSignal;
}

// ---------------------------------------------------------------------------
// 2026-09-20 信号市场(Signal Market · OKX.AI ASP;设计 docs/design/asp-market-2026-09-20.md,
// 契约 §9.39)。取代跟单页的 bridge / 8794 那套:信号源只剩 OKX.AI 的 ASP 订阅投递,
// 卖方侧多了 ASP 身份 / 发布器 / 售后。价格金额是十进制字符串,时间是 unix 毫秒。

export type MarketTransport = 'queue' | 'watch';

export interface MarketSubscriptionConfig {
  mode: FollowMode;
  /** book 模式:manual = 组合经理过闸后生成待批意图,交易页点确认;auto = 直接交执行。默认 manual。 */
  approval: FollowApproval;
  /** 0–1,乘 workflow.risk_pct;没有外部统计源,纯人工。 */
  weight: number;
  /** 只影响是否进流,不影响 OKX 侧的订阅状态。 */
  enabled: boolean;
  label?: string | null;
}

export interface MarketPublisherSettings {
  enabled: boolean;
  publish_orders: boolean;
  publish_analysis: boolean;
  /** 空 = 全部币种。 */
  symbols: string[];
  include_realized_pnl: boolean;
  /** 纸面线程只能以 analysis 发出且标 paper:true;这里控制是否允许。 */
  allow_paper_analysis: boolean;
  backend_filter: string[];
}

export interface MarketSettings {
  enabled: boolean;
  /** 永远 false 且改不动(首发范围收缩,同跟单时代)。 */
  auto_manage: boolean;
  transport: MarketTransport;
  /** queue 轮询间隔,默认 3000,下限 1000。 */
  poll_ms: number;
  /** live 信号超过这个岁数只能 evidence。 */
  freshness_s: number;
  default_mode: FollowMode;
  /** 每个订阅每天最多产生几次开仓触发;0 = 不限。 */
  max_signals_per_subscription_per_day: number;
  subscriptions: Record<string, MarketSubscriptionConfig>;
  publisher: MarketPublisherSettings;
}

/** 一盏灯:`detail` 是人看的那句话(邮箱 / pid / profile),灭灯时可能为 null。 */
export interface OkxAccountLight {
  ok: boolean;
  detail: string | null;
}

/** GET /api/okx/account(缓存 30s,`?fresh=1` 强刷)。 */
export interface OkxAccountStatus {
  wallet: OkxAccountLight;
  a2a: OkxAccountLight;
  trade_kit: OkxAccountLight;
  checked_at: number;
}

/** 一个 ERC-8004 身份(买家 User 或卖家 ASP)。 */
export interface MarketIdentity {
  agent_id: string;
  name: string;
  role: 'user' | 'asp' | string;
  status: string;
  approval: string | null;
  rating: string | null;
  sold_count: number;
  avatar: string | null;
  description?: string | null;
}

export interface MarketInboxStatus {
  transport: MarketTransport;
  /** 队列库探得到且打得开 / watch 子进程活着;否则轮询退避。 */
  available: boolean;
  db_path: string | null;
  last_poll_at: number | null;
  last_error: string | null;
  failures: number;
  next_attempt_at: number | null;
  /** 耐久账本总行数(不是去重集合)。 */
  ledger_total: number;
  ingested: number;
  skipped_analysis: number;
  bad_rows: number;
  cursor: number;
  dlq_count: number;
}

/** Agentic Wallet:订阅费从它扣、身份挂它名下、卖信号收入领回它(设计 §2.6)。 */
export interface MarketWallet {
  logged_in: boolean;
  email: string | null;
  account_name: string | null;
  address: string | null;
  chain: string;
  /** XLayer 上的 USDT 余额,十进制字符串;拿不到为 null。 */
  balance_usdt: string | null;
  deposit_address: string | null;
  error: string | null;
}

export interface MarketStatus {
  lights: OkxAccountStatus;
  wallet: MarketWallet;
  buyer: MarketIdentity | null;
  asp: MarketIdentity | null;
  this_device: { id: string; name: string } | null;
  monthly_cost: { amount: string | null; currency: string; count: number };
  inbox: MarketInboxStatus;
  settings: MarketSettings;
  checked_at: number;
}

export interface MarketAspSummary {
  asp_agent_id: string;
  asp_name: string;
  /** CLI 已经换算成星级字符串(如 `★ 4.28`),别再自己算。 */
  rating: string | null;
  security_rate: number | null;
  feedback_rate: number | null;
  sold_count: number;
  online: boolean;
}

export interface MarketServiceSubscription {
  interval: string;
  fee: string;
}

export interface MarketService {
  service_id: string;
  sid: number | null;
  service_name: string;
  service_description: string;
  service_type: 'A2A' | 'A2MCP' | string;
  fee_amount: string | null;
  fee_token_symbol: string;
  fee_token_address: string | null;
  subscription: MarketServiceSubscription[];
  support_trial: boolean;
  /** 试用时长(小时),没有为 null。 */
  free_trial: string | null;
  is_subscribing: boolean;
  endpoint: string | null;
  asp: MarketAspSummary;
}


/** okx.ai 网页目录(网关从 SSR 页面扒的,只读;`services` 只有抓过详情的才有)。 */
export interface CatalogService {
  service_id: number | null;
  name: string;
  price: string | null;
  price_interval: string | null;
  description: string;
  free_trial: boolean;
  free_trial_hours: number | null;
  service_type: string | null;
}
export interface CatalogAgent {
  agent_id: string;
  name: string;
  avatar: string | null;
  description: string;
  score: string | null;
  approval_rate: string | null;
  usage_count: number;
  starting_price: string | null;
  price_interval: string | null;
  symbol: string;
  categories: string[];
  /** MONTHLY / ONETIME / FREETRY */
  tags: string[];
  online: boolean;
  services: CatalogService[];
  detail_at: number | null;
  /** 我方在这个 ASP 名下的订阅(有就标「试用中/已订阅/等接单」)。 */
  subscription: { job_id: string; status_name: string; trial: boolean } | null;
}
export interface CatalogResponse {
  fetched_at: number | null;
  building: boolean;
  total_site: number | null;
  categories: { id: string; name: string }[];
  total: number;
  page: number;
  page_size: number;
  agents: CatalogAgent[];
  errors: string[];
}
export interface CatalogDetail {
  agent: CatalogAgent;
  overview: Record<string, unknown>;
  services: CatalogService[];
  reviews: { total_score: string | null; total_count: number; distribution: Record<string, number>; list: { reviewer: string | null; time: number | null; content: string; rating: string | null }[] };
  similar: CatalogAgent[];
  fetched_at: number;
}

export interface MarketSearchResponse {
  services: MarketService[];
  search_after: string | null;
  has_more: boolean;
  unmatch_reason: string | null;
}

export interface MarketFeedback {
  /** 0.00–5.00,CLI 已换算。 */
  score: number | null;
  reviewer: string | null;
  role: string | null;
  date: string | null;
  description: string | null;
}

export interface MarketAspDetail {
  profile: MarketIdentity & { online: boolean; feedback_rate: number | null };
  services: MarketService[];
  feedback: MarketFeedback[];
  feedback_error?: string | null;
}

export interface MarketSubscribeRequest {
  service_id: string;
  provider_agent_id: string;
  fee_amount: string;
  fee_token_address: string;
  use_trial: boolean;
  auto_renew: boolean;
  title?: string;
  description?: string;
  mode: FollowMode;
  approval: FollowApproval;
  weight: number;
}

/** 余额不够时 CLI 给的充值提示(网关跑 funding-notice 渲染)。 */
export interface MarketFundingNotice {
  deposit_address: string | null;
  currency: string | null;
  shortfall: string | null;
  qr_png_base64: string | null;
  text: string | null;
}

export interface MarketSubscribeResponse {
  ok: boolean;
  job_id: string | null;
  funding_notice: MarketFundingNotice | null;
  message: string | null;
  device_added: boolean;
}

export interface MarketSubscriptionStats {
  received: number;
  orders: number;
  analysis: number;
  applied: number;
  skipped: number;
  review_only: number;
  agent_judged: number;
  /** null = 没有样本,不是 0。 */
  agent_agree_rate: number | null;
  /** null = 没有结算完整的线程,不是 0。 */
  realized_r: number | null;
  settling: number;
}

export interface MarketSubscriptionView {
  job_id: string;
  title: string;
  service_name: string;
  service_id: string | null;
  provider_agent_id: string | null;
  provider_name: string;
  /** 网页目录里的 ASP 头像/服务名(CLI 订阅行没有);目录没抓到就 null。 */
  asp_avatar: string | null;
  asp_service_name: string | null;
  /** ACTIVE / REJECTED / DISPUTED / COMPLETED / CLOSED / FAILED / INIT。 */
  status_name: string;
  /** 1 = 试用中。 */
  trial_type: number | null;
  period_index: number | null;
  auto_renew: boolean;
  sub_end_time: number | null;
  trial_end_time: number | null;
  fee_amount: string | null;
  this_device_receives: boolean;
  device_list: string[] | null;
  config: MarketSubscriptionConfig;
  stats: MarketSubscriptionStats;
  last_delivery_at: number | null;
}

export interface MarketScorecardOutcome { signal_id: string; symbol: string; side: 'long' | 'short' | null; published_at: number; entry: string | null; stop: string | null; tps: string[]; status: 'pending_entry' | 'open' | 'stopped' | 'tp_hit' | 'expired' | 'unscorable'; r: number | null; mfe_r: number | null; mae_r: number | null; entry_at: number | null; exit_at: number | null; note: string | null; }
/** 订阅信号事后回测(网关 scorecard.ts):零下单,按 15m K 线检验入场/止损/止盈。 */
export interface MarketScorecard { job_id: string; n_signals: number; n_scored: number; wins: number; losses: number; win_rate: number | null; avg_r: number | null; sum_r: number | null; profit_factor: number | null; avg_rr_planned: number | null; outcomes: MarketScorecardOutcome[]; computed_at: number; }
export interface MarketSubscriptionsResponse {
  subscriptions: MarketSubscriptionView[];
  this_device: { id: string; name: string } | null;
  error: string | null;
}

export type MarketInboxParseStatus = 'ingested' | 'analysis' | 'bad' | 'duplicate' | 'expired' | 'system';

export interface MarketInboxRow {
  delivery_id: string;
  job_id: string | null;
  message_id: string | null;
  received_at: number;
  signal_type: string | null;
  parse_status: MarketInboxParseStatus;
  signal_id: string | null;
  note: string | null;
  /** 原投递全文(≤ 4000 字),不可信文本,原样展示。 */
  raw: string;
}

export interface MarketInboxResponse {
  rows: MarketInboxRow[];
  total: number;
}

export interface MarketSubscriber {
  job_id: string;
  buyer_agent_id: string;
  buyer_name: string | null;
  status_name: string;
  period_index: number | null;
  sub_start_time: number | null;
  sub_end_time: number | null;
  fee_amount: string | null;
  /** 在 subscribe-active 的扇出集合里。 */
  active: boolean;
}

export type MarketAftersaleStatus = 'received' | 'pending' | 'processing' | 'agreed_refund' | 'disputed' | 'failed' | 'expired';

export interface MarketAftersale {
  id: string;
  job_id: string;
  kind: 'sub_user_reject' | string;
  buyer_agent_id: string | null;
  period_index: number | null;
  reason: string | null;
  deadline_at: number | null;
  status: MarketAftersaleStatus;
  decided_at: number | null;
  created_at: number;
}

export interface MarketTrackRecord {
  window_days: number;
  orders: number;
  closes: number;
  wins: number;
  realized_r_sum: number | null;
}

export interface MarketPublisherState {
  last_publish_at: number | null;
  events: number;
  delivered: number;
  failed: number;
  blocked: number;
}

export interface MarketAsp {
  identity: MarketIdentity | null;
  services: MarketService[];
  subscribers: MarketSubscriber[];
  active_count: number;
  claimable: { amount: string | null; currency: string; error: string | null };
  aftersales: MarketAftersale[];
  publisher: MarketPublisherSettings;
  track_record: MarketTrackRecord;
  publisher_state: MarketPublisherState;
  error: string | null;
}

export type MarketPricing = 'per_call' | 'monthly' | 'monthly_trial';

export interface MarketRegisterForm {
  name: string;
  description: string;
  service_name: string;
  service_type: 'A2A';
  pricing: MarketPricing;
  /** 字符串数字,USDT,≤ 6 位小数,0 = 免费。 */
  fee: string;
  service_description: string;
}

export interface MarketValidateFinding {
  field: string;
  code: string;
  severity: 'block' | 'suggest' | string;
  message: string;
}

export interface MarketValidateResponse {
  pass: boolean;
  findings: MarketValidateFinding[];
}

export interface MarketRegisterResponse {
  ok: boolean;
  agent_id: string | null;
  message: string | null;
  findings?: MarketValidateFinding[];
}

export interface MarketDeliveryJob {
  job_id: string;
  buyer_agent_id?: string | null;
  status: 'pending' | 'delivered' | 'failed';
  attempt: number;
  error: string | null;
  delivered_at: number | null;
}

export interface MarketDeliveryOut {
  event_id: string;
  created_at: number;
  signal_type: 'order' | 'analysis';
  action: string;
  symbol: string;
  thread_id: string | null;
  text: string;
  payload: Record<string, unknown>;
  /** 敏感词 / 纸面 order 等被本地拦下时的原因;非空 = 一户都没发。 */
  blocked_reason: string | null;
  jobs: MarketDeliveryJob[];
}

export interface MarketDeliveriesResponse {
  deliveries: MarketDeliveryOut[];
}

export interface MarketPreview {
  text: string;
  payload: Record<string, unknown>;
  blocked_reason: string | null;
}

/**
 * 09-13 首发范围(二审收缩后):哪些动作自动执行、哪些一律人工。前端按它画说明,别自己硬编码。
 * 信号市场沿用:`auto_execution` 在 copy 模式下只对 open 生效且仍过全部闸;管理动作永远人工。
 */
export interface FollowScope {
  auto_execution: boolean;
  human_actions: ('apply' | 'skip' | 'reconcile')[];
  auto_actions_when_enabled: TraderAction[];
  manual_only_actions: TraderAction[];
  auto_manage: false;
  tp_tiers: 'first_only';
  ladder_entry: 'manual_only';
}

/**
 * GET /api/follow:设置(MarketSettings)+ 入站状态 + 待办。人工待办**从库里查**
 * (`status IN ('review_only','apply_failed')`),有上限,超过要显示「还有 N 条未显示」。
 */
export interface FollowOverview {
  follow: MarketSettings;
  inbox: MarketInboxStatus;
  pending_review: TraderSignal[];
  pending_review_total: number;
  pending_review_limit: number;
  scope: FollowScope;
  signals_total: number;
  modes: readonly FollowMode[];
  statuses: readonly TraderSignalStatus[];
  errors?: string[];
}

export interface ServerEventMap {
  /** 每条信号发两次:收到时(`status:new`)与处置完(终态);前端按 `signal_id` 覆盖同一行。 */
  trader_signal: TraderSignal;
  /** 信号市场(§9.39):新投递落账本 / 发布器扇出结果 / 订阅状态变化 / 售后待办。 */
  market_delivery: { delivery_id: string; job_id: string | null; parse_status: string; signal_id: string | null };
  market_publish: Record<string, unknown>;
  market_subscription: { job_id: string | null; action?: string };
  market_aftersale: Record<string, unknown>;
}

// ---- 2026-09-20 一键接入(账户菜单):OKX 凭证写入 / CLI 安装 / Agentic 钱包 / MCP ----

/** POST /api/execution/okx/setup:凭证只经手一次,交给 `okx config add-profile`,网关不落盘不回显。 */
export interface OkxSetupRequest {
  api_key: string;
  secret_key: string;
  passphrase: string;
  demo: boolean;
  site?: 'global' | 'eea' | 'us' | 'tr';
  name?: string;
}
export interface OkxSetupResponse {
  ok: boolean;
  profile: string;
  demo: boolean;
  credentials_ok: boolean;
  error?: string;
  okx: OkxStatus;
}
export interface OkxInstallResponse {
  ok: boolean;
  cli: string | null;
  version: string | null;
  log_tail?: string;
}

/** GET /api/wallet:onchainos 登录态(只读,永不触链)。 */
export interface WalletStatus {
  installed: boolean;
  cli: string | null;
  logged_in: boolean;
  email: string | null;
  login_type: string | null;
  account_name: string | null;
  account_id: string | null;
  addresses?: { chain: string; address: string }[];
  checked_at: number;
}
/** GET /api/wallet/assets:地址按「一把私钥一行」归并(EVM 全链同地址),余额是 OKX 后端聚合的估值。 */
export interface WalletAddressRow { family: string; address: string; chains: string[] }
export interface WalletAsset { chain: string | null; symbol: string; balance: string; value_usd: string | null }
export interface WalletAssets {
  logged_in: boolean;
  addresses: WalletAddressRow[];
  total_value_usd: string | null;
  assets: WalletAsset[];
  updated_at: number | null;
  checked_at: number;
}
export interface WalletLoginInit {
  url: string;
  session_id: string;
}

/** GET /api/execution/okx/mcp:okx CLI 自带的 MCP server 有没有挂到 Claude Code 上。 */
export interface OkxMcpStatus {
  cli_available: boolean;
  mcp_command: string | null;
  registered_in_claude: boolean;
  checked_at: number;
}

// ---------------------------------------------------------------------------
// 研究工作台(docs/research/claude-frontend-handoff.md §3):SSE `research.workbench`,前端按 run_id 过滤。
export interface ServerEventMap {
  'research.workbench': import('./research-types').ResearchEvent;
  /** 第三轮:研究对话执行期间的任务树 / 工具 / 产物 / 结论事件,前端按 chat_id 归组。 */
  'research.chat': import('./research-types').ResearchChatEvent;
  /** §9.44:研究会话里一次提问(inquiry)的计划 / 步骤 / 产物 / 终态事件,前端按 seq 去重。 */
  'research.inquiry': import('./research-types').ResearchInquiryEvent;
}

// ---------------------------------------------------------------------------
// §9.51 策略一键运行 Strategy Run(docs/design/strategy-run-2026-09-24.md)
// ---------------------------------------------------------------------------

export type StrategyRunMode = 'auto' | 'agent' | 'confirm' | 'signal_only';
export type StrategyRunStatus = 'running' | 'paused' | 'stopped' | 'error';
export interface StrategyRunExecution {
  backend: 'paper' | 'okx' | 'binance';
  profile: 'demo' | 'live' | null;
  label: string;
}
export interface StrategyRun {
  id: string;
  strategy_id: string;
  strategy_name: string;
  version: number;
  latest_version: number;
  ir_hash: string;
  timeframe: string;
  mode: StrategyRunMode;
  market: 'spot' | 'perp';
  direction: 'long' | 'short' | 'both';
  leverage: number;
  symbols: string[];
  risk_pct: number;
  max_open: number;
  publish_asp: boolean;
  status: StrategyRunStatus;
  error: string | null;
  execution: StrategyRunExecution;
  created_at: number;
  updated_at: number;
  last_scan_at: number | null;
  next_scan_at: number | null;
  stats: {
    scans: number;
    candidates: number;
    orders: number;
    pending_approval: number;
    skipped: number;
    rejected: number;
    open_threads: number;
    closed: number;
    realized_r: number | null;
    published: number;
    today_orders: number;
  };
}
export type StrategyRunEventKind = 'scan' | 'candidate' | 'agent_follow' | 'agent_skip' | 'skip' | 'order_opened' | 'order_pending' | 'order_rejected' | 'exit' | 'published' | 'error' | 'status';
export interface StrategyRunEvent {
  id: string;
  run_id: string;
  at: number;
  kind: StrategyRunEventKind;
  symbol: string | null;
  message: string;
  data: Record<string, unknown> | null;
}
export interface StrategyRunPreflight {
  strategy_id: string;
  version: number;
  timeframe: string;
  deployable: boolean;
  blockers: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
  defaults: { mode: StrategyRunMode; market: 'spot' | 'perp'; leverage: number; symbols: string[]; risk_pct: number; max_open: number; publish_asp: boolean };
  watchlist: string[];
  execution: StrategyRunExecution;
  requires_live_confirm: boolean;
  asp: { identity: boolean; active: boolean; publisher_enabled: boolean };
  existing_run: StrategyRun | null;
}
export interface StrategyRunRequest {
  strategy_id: string;
  version?: number;
  mode: StrategyRunMode;
  market: 'spot' | 'perp';
  symbols: string[];
  risk_pct: number;
  max_open: number;
  publish_asp: boolean;
  confirm?: string;
}
export type StrategyRunPatch = Partial<Pick<StrategyRun, 'status' | 'mode' | 'symbols' | 'risk_pct' | 'max_open' | 'publish_asp' | 'version'>> & { confirm?: string };

export interface ServerEventMap {
  'strategy_run.updated': StrategyRun;
  'strategy_run.event': StrategyRunEvent;
}

// ---------------------------------------------------------------------------
// §9.52 模型连接与角色底层(docs/demo/v3-ui-contract.md §9.52)
//
// 「底层」= 连接(API key / 本机 CLI)+ 角色绑定;两个旧槽位(workflow.brain / cheap_brain)
// 保留为未绑定角色的回退。字段名与契约一字不差,别改。

export type ConnectionKind = 'openrouter' | 'anthropic' | 'deepseek' | 'zai' | 'openai' | 'openai_compatible' | 'cli';
export type CliTool = 'pi' | 'claude' | 'codex';
export interface ModelConnection {
  id: string; // 'mc_xxx'
  kind: ConnectionKind;
  label: string; // 用户起的名字,缺省按 kind
  base_url: string | null; // openai_compatible 必填;其余用内置缺省
  cli: CliTool | null; // kind='cli' 时必填
  key_masked: string | null; // 'sk-or-…c6a5e9';明文永不回传
  status: 'untested' | 'ok' | 'error';
  last_test: { at: number; ok: boolean; latency_ms: number | null; detail: string } | null;
  models_hint: string[]; // 连接可用模型的常用列表
  created_at: number;
  updated_at: number;
}
/** POST /api/models/connections/:id/test 的返回 = 一条 last_test */
export type ModelConnectionTest = NonNullable<ModelConnection['last_test']>;
export type ModelRole = 'chat' | 'judge' | 'research' | 'filter' | 'reviewer' | 'utility' | 'decision';
/** connection_id / model 为 null = 回退旧槽位 */
export interface RoleBinding {
  role: ModelRole;
  connection_id: string | null;
  model: string | null;
}
export type EffectiveSource = 'binding' | 'fallback_main' | 'fallback_cheap' | 'unset';
export interface ModelsView {
  connections: ModelConnection[];
  bindings: RoleBinding[]; // 7 个角色都返回,顺序 chat, judge, research, filter, reviewer, utility, decision
  effective: Record<ModelRole, { source: EffectiveSource; name: string }>; // decision 未绑定 = 'unset'
  cli_detected: { tool: CliTool; command: string | null; ok: boolean }[];
}
/** POST /api/models/connections body;PATCH 同字段(api_key 缺省或空串 = 不改) */
export interface ModelConnectionInput {
  kind: ConnectionKind;
  label?: string;
  base_url?: string;
  cli?: CliTool;
  api_key?: string;
}
export type ModelConnectionPatch = Partial<Omit<ModelConnectionInput, 'kind'>>;

export interface ServerEventMap {
  'models.changed': ModelsView;
}
