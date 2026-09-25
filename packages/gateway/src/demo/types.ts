import type { BotRole } from './bots.js';

export type Market = 'perp' | 'spot';
export const MARKETS: readonly Market[] = ['perp', 'spot'];
export interface SpotHolding { ccy: string; total: string; available: string; usdt_value: string | null }
// Demo runtime domain types — docs/demo/README.md §2 (kept in sync by hand; the WebUI copies
// these verbatim). Amounts are decimal strings, timestamps unix ms.

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
 * Execution backend. `paper` = in-process simulator; `demo` = the Rust tswarm-demo-exec child;
 * `cli` = the official binance-cli (Agent OS channel); `agent_mcp` = an agent CLI driving Binance's
 * official MCP server (execution-agent.ts); `mcp` = the gateway itself calling that same MCP server
 * over its own OAuth token, through a human-confirmed tool map (execution-mcp.ts) — no model at all.
 */
export type Backend = 'paper' | 'demo' | 'cli' | 'agent_mcp' | 'mcp' | 'okx';

/** 交易所开关(docs/design/okx-atk-2026-09-20.md §1)。fork 默认 okx;binance 保留全部原有通道。 */
export type ExchangeKind = 'okx' | 'binance';

/** 执行页的 OKX 接入状态(§5);exchange !== 'okx' 时为 null。 */
export interface OkxStatusView {
  acct_lv: 1 | 2 | 3 | 4 | null;
  acct_lv_label: string | null;
  markets_available: Market[];
  spot_holdings: SpotHolding[];
  profiles: { name: string; demo: boolean; is_default: boolean }[];
  cli: string;
  profile: string | null;
  demo: boolean | null;
  available: boolean;
  note: string | null;
  version: string | null;
}

export const ACTIONS: readonly Action[] = ['NO_TRADE', 'WATCH', 'PROPOSE', 'HOLD', 'ADD', 'REDUCE', 'EXIT', 'INVALIDATE'];

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
  /**
   * 09-12 §4:**哪几条启用策略要这条证据**(自定义证据的可解释性)。
   * 空数组 = 没有策略点名要它(基础行情/结构/记忆这类公共证据),不是「没人用」。
   * 旧 episode 没有这个字段 → undefined。
   */
  required_by?: string[];
}

export interface Proposal {
  market?: Market;
  risk_plan?: { atr_timeframe: string; stop_atr_multiple: string };
  direction: Direction;
  entry: 'market' | 'limit';
  limit_price: string | null;
  entry_zone: [string, string] | null;
  stop_price: string | null;
  take_profit_price: string | null;
  take_profits: string[];
  rationale: string;
}

export interface Judgment {
  action: Action;
  direction: Direction | null;
  confidence: number;
  headline: string;
  thesis: string;
  reasons: string[];
  evidence_refs: string[];
  invalidation: string | null;
  invalidation_price: string | null;
  target_price: string | null;
  watch_conditions: string[];
  proposal: Proposal | null;
  /**
   * v3.5 strategy library: which strategy this judgment followed. Required on a PROPOSE whenever the context
   * listed active strategies (schema.ts validates it against that set); null/absent otherwise.
   */
  strategy_id?: string | null;
}

export type TriggerKind =
  | 'kline_close'
  | 'manual'
  | 'schedule'
  | 'monitor'
  | 'position_review'
  | 'scan'
  | 'info_update'
  | 'order_filled'
  | 'tp_hit'
  | 'sl_hit'
  | 'thread_review'
  | 'chat'
  // v3 code triggers (docs/demo/v3-ui-contract.md §0): the model is only woken when one of these fires or a heartbeat is due.
  | 'fast_move'
  | 'breakout'
  | 'ema_cross'
  | 'vol_spike'
  | 'retest'
  | 'session'
  | 'funding'
  | 'heartbeat'
  // 09-12 事件区(docs/design/strategy-loop-v2-and-events-2026-09-12.md §5):该资产正处在某条事件的影响窗口内。
  | 'event'
  // 09-12 跟单 session(docs/design/trader-follow-2026-09-12.md §1):bridge 拉到一条带单员开仓/加仓信号。
  // 它是**外部唤醒**,不是代码触发器算出来的行情事实 —— 所有策略都该有机会对它表态(strategies.wakeKindsOf)。
  | 'trader_signal';

export interface Trigger {
  /** 入队时冻结的触发事实，供判断记录追溯。 */
  hits?: TriggerHit[];
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

export type IntentStatus = 'pending_approval' | 'approved' | 'rejected' | 'submitted' | 'filled' | 'failed' | 'unknown';

export interface DemoIntent {
  market?: Market;
  id: string;
  episode_id: string;
  thread_id: string | null;
  principal: 'agent' | 'user';
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
  book_shadow?: import('./book-policy.js').BookDecision;
  holding_review?: import('./holding-policy.js').HoldingReview;
  holding_plan?: import('./holding-policy.js').HoldingPlan;
  strategy_refs?: { id: string; version: number; content_hash: string }[];
  /** 09-09 策略议会:每条策略对本资产的独立表态 + 共识(docs/design/strategy-council-2026-09-09.md);off 时缺省。 */
  strategy_council?: import('./strategy-council.js').CouncilResult | null;
  /** 09-09 复查时的议会复核(当初同意的现在还同不同意);只有持仓/挂单复查且线程带 council 快照时才有。 */
  council_review?: import('./strategy-council.js').CouncilReview | null;
  /** 09-09 入场方式建议(扫描时代码算);`entry_style` 闸读的就是它。 */
  entry_advice?: import('./entry-policy.js').EntryStyleAdvice | null;
  /** 09-09 挂单耐心度量(挂单复查时代码算)。 */
  pending_entry?: import('./entry-policy.js').PendingEntryMetrics | null;
  sizing?: Sizing;
  sizing_evidence?: Record<string, unknown>;
  /**
   * 09-12 跟单:这次判断是谁叫起来的 —— `trader:<带单员名>`。归因报表按 origin 多一维。
   * 自己的盯盘循环叫起来的 episode 没有这个字段(undefined,不是空串)。
   */
  origin?: string;
  id: string;
  at: number;
  as_of: number;
  symbol: string;
  thread_id: string | null;
  trigger: Trigger;
  strategy_before: { state: StrategyState; version: number };
  evidence: Evidence[];
  /**
   * 09-12 §5 减黑盒:这次判断的证据装载计划(哪些指标/事件/新闻/研究进了 prompt、各自 required_by、
   * 来源 kind,以及**要了没装上**的那几条和原因)。旧 episode 没有 → undefined。
   */
  evidence_plan?: import('./context.js').EvidencePlanDetail;
  /** 计划哈希(只覆盖「要什么」);同一套启用策略的连续判断共用一个值。 */
  evidence_plan_hash?: string;
  context_text: string;
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
  /**
   * Judgment-graph position (docs/design/graph-engineering-v2.md); absent on episodes written before v3.
   * `edge` = model edge id finally taken (null only if even the fail-closed action has no edge, which the graph forbids);
   * `illegal_action` = the FIRST action the model output when it was not an allowed edge at `node` (repaired or
   * fail-closed afterwards), null when the first output was legal; `guards` = guard ids evaluated on that edge.
   */
  graph?: { version: string; node: string; edge: string | null; guards: string[]; illegal_action?: string | null };
  /** v3.2: memory ids injected into this context (as 记忆 evidence) and the subset the judgment actually cited. */
  memory?: { injected: string[]; cited: string[] };
  /**
   * 09-12 §3 减黑盒:这次判断的**结构化决策记录**(代码允许 → 模型选 → 闸后执行,理由全是枚举)。
   * 与 episode 严格 1:1,所以和 `evidence_plan` 一样挂在 episode JSON 上,不另立表。
   * 早于这一版的 episode 没有 → undefined,前端显示「这次判断早于决策记录」。
   */
  decision_record?: DecisionRecord;
}

export interface EpisodeSummary {
  /** 见 {@link Episode.origin}。 */
  origin?: string;
  id: string;
  at: number;
  symbol: string;
  thread_id: string | null;
  trigger: Trigger;
  action: Action | null;
  direction: Direction | null;
  headline: string | null;
  confidence: number | null;
  from_state: StrategyState;
  to_state: StrategyState | null;
  has_intent: boolean;
  status: Episode['status'];
  // Always-visible card content (so the timeline needn't fetch every episode's detail).
  reasons: string[];
  reducer: Episode['reducer'];
  schema_errors: string[];
  error: string | null;
  intent: DemoIntent | null;
  /** Judgment-graph position (same as Episode.graph) so the timeline can badge node → edge without fetching detail. */
  graph: Episode['graph'] | null;
  /**
   * 09-09 议会与入场方式的**摘要**(时间线用,不用逐条拉详情);议会关闭 / 非扫描时为 null。
   * `required` 是钳过之后真正生效的票数门槛,不是用户设的 `council_min_agree`。
   */
  council: { reached: boolean; direction: Direction | null; agreeing: number; required: number; abstaining: number; gate_effective: boolean; entry_timing: 'confirmed' | 'pending' | 'failed' | null } | null;
  entry: { recommended: 'market' | 'limit'; market_blocked: boolean } | null;
}

export interface PositionView {
  market: Market;
  symbol: string;
  side: Direction;
  qty: string;
  entry_price: string;
  mark_price: string;
  unrealized_pnl: string;
  leverage: number;
}

export interface OpenOrderView {
  market: Market;
  symbol: string;
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
  equity: string;
  available: string;
  unrealized_pnl: string;
  positions: PositionView[];
  open_orders: OpenOrderView[];
  as_of: number;
  /** v3.8:读取成功但账户没钱(权益 0、无持仓)→ 'unfunded';其余 'ok'。读取失败不会产生 AccountView(runtime 保留上一份并记 account_read_error)。 */
  quality?: 'ok' | 'unfunded';
  note?: string | null;
}

export interface MarketView {
  market: Market;
  symbol: string;
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
  brain: string;
  /** Information officer's brain name (kind:model). */
  cheap_brain: string;
  backend: Backend;
  auto_approve: boolean;
}

export interface LogLine {
  market?: Market | null;
  observed_count?: number;
  first_seen_at?: number;
  last_seen_at?: number;
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

export function summarize(ep: Episode): EpisodeSummary {
  return {
    ...(ep.origin ? { origin: ep.origin } : {}),
    id: ep.id,
    at: ep.at,
    symbol: ep.symbol,
    thread_id: ep.thread_id,
    trigger: ep.trigger,
    action: ep.judgment?.action ?? null,
    direction: ep.judgment?.direction ?? null,
    headline: ep.judgment?.headline ?? null,
    confidence: ep.judgment?.confidence ?? null,
    from_state: ep.strategy_before.state,
    to_state: ep.strategy_after?.state ?? null,
    has_intent: ep.intent !== null,
    status: ep.status,
    reasons: ep.judgment?.reasons ?? [],
    reducer: ep.reducer,
    schema_errors: ep.schema_errors,
    error: ep.error,
    intent: ep.intent,
    graph: ep.graph ?? null,
    council: ep.strategy_council
      ? { reached: ep.strategy_council.consensus.reached, direction: ep.strategy_council.consensus.direction, agreeing: ep.strategy_council.consensus.agreeing.length, required: ep.strategy_council.consensus.required, abstaining: ep.strategy_council.consensus.abstaining.length, gate_effective: ep.strategy_council.consensus.gate_effective, entry_timing: ep.strategy_council.consensus.entry_timing }
      : null,
    entry: ep.entry_advice ? { recommended: ep.entry_advice.recommended, market_blocked: ep.entry_advice.market_blocked } : null,
  };
}

// ---------------------------------------------------------------- v2 (docs/demo/v2-agent-loop.md)

/** Which CLI the model runs behind (design §9: always a subprocess, the gateway holds no model keys). */
export type BrainKind = 'pi' | 'claude' | 'codex' | 'stub';

/** One selectable brain for the UI (`GET /api/brains`). */
export interface BrainOption {
  kind: BrainKind;
  label: string;
  /** CLI found on PATH (stub is always available). */
  available: boolean;
  /** Suggested model ids for this kind (free text is still accepted). pi uses `provider/model`. */
  models: string[];
  default_model: string | null;
  note: string;
  /** The configured launch command for this CLI (`Workflow.cli_commands`); null for the stub. */
  command: string | null;
  /** How that command would be started and whether it resolves at all. */
  resolved: CliResolvedView;
}

/** `via` 'direct' = spawned as-is; 'shell' = run through the user's login+interactive shell (aliases). */
export interface CliResolvedView {
  via: 'direct' | 'shell';
  ok: boolean;
  detail: string;
}

/** Per-CLI launch command (bare name, path, env-prefixed line, or an interactive-shell alias). */
export interface CliCommandsView {
  claude: string;
  codex: string;
  pi: string;
}

export interface BrainTestResult {
  ok: boolean;
  kind: BrainKind;
  model: string | null;
  name: string;
  latency_ms: number;
  text: string | null;
  error: string | null;
}

export interface Workflow {
  /** §9.54 Agent 当前策略;null/缺省 = 自由判断。只由 agentStrategy() 写,不走工作流 patch。 */
  current_strategy?: { strategy_id: string; version: number; run_id: string; since: number } | null;
  markets: Market[];
  default_market: Market;
  sizing_agent: 'off' | 'advise' | 'apply';
  watchlist: string[];
  timeframe: string;
  info_every_ms: number;
  risk_pct: string;
  leverage: number;
  margin_mode: 'cross' | 'isolated';
  max_open_threads: number;
  max_opens_per_day: number;
  /** Stop opening new threads for the UTC day once realized+unrealized loss since 00:00 UTC exceeds this % of start-of-day equity. */
  daily_loss_stop_pct: string;
  auto_approve: boolean;
  brain: BrainKind;
  cheap_brain: BrainKind;
  /** Model id for `brain` (pi: `provider/model`, claude: alias or id, codex: model id); null = that CLI's default / env. */
  brain_model: string | null;
  /** Model id for `cheap_brain` (information officer); null = default. */
  cheap_brain_model: string | null;
  playbook_text: string;
  paused: boolean;
  /** Agent posts a one-line plain-language note into the chat after each judgment / thread event / info update. */
  narrate: boolean;
  /** v3.10.1:对话里 agent 批准/执行意图是否需要人在界面上点一次性 token(默认 false = agent 自批)。扫描自动路径与此无关(那是 auto_approve)。 */
  chat_requires_approval: boolean;
  /** 'triggered' = code triggers + heartbeat decide when the model is called; 'every_close' = every kline close (demo). */
  scan_mode: 'triggered' | 'every_close';
  /** In triggered mode: longest gap between two model calls for one symbol. */
  heartbeat_every_ms: number;
  /**
   * v3.9:只观察不交易的币(watchlist 的子集)。在这些币上判断模块进 scan:watch_only 节点,PROPOSE 不是合法边,
   * 只能 NO_TRADE / WATCH;从名单里去掉即可交易。一个界面里每个币一个「观察/交易」开关。
   */
  watch_only: string[];
  /** v7 失效确认:连续多少根已收盘 K 线越过失效价才算「失效确认=是」(默认 2;1 = 一根就算)。 */
  invalidation_confirm_bars: number;
  /** v7 失效缓冲:越过深度不足这么多 ATR 不算越过(默认 0.2;0 = 贴线就算)。 */
  invalidation_buffer_atr: number;
  /** A ≥ this % move within 5 minutes wakes the agent immediately (decimal string). */
  fast_move_pct: string;
  /** Open threads: review on every close of their timeframe (true) or only on events/triggers/heartbeat (false). */
  review_every_close: boolean;
  /** Which execution backend the runtime is on right now (v3.3); switching is refused while a thread is open. */
  execution: Backend;
  /** Which agent CLI drives the Binance MCP server when `execution === 'agent_mcp'`. */
  exec_agent_cli: AgentCliKind;
  /** Model id for that CLI; null = 'sonnet' for claude / the Codex CLI's own default. */
  exec_agent_model: string | null;
  /** Max model judgments (episodes) per local day; 0 = unlimited. Chat replies are never capped. */
  daily_judgment_cap: number;
  /**
   * 09-07 Strategy Lab 自动闭环:实验结果写回版本的 lab_stats;参数探针明显更好时自动建 draft 版本并交接;
   * draft→backtest→shadow 两步数据态晋升过闸自动走。paper 及以上永远人批。false = Lab 只出研究记录(旧行为)。
   */
  lab_autopilot: boolean;
  /** 09-12 §1.1:每周 ≤1 次的策略假设生成(便宜大脑一次调用);默认 false。 */
  strategy_discovery?: boolean;
  /** Radar screener (screener.ts, docs/design/screener-radar-2026-09-05.md). WIP: fields exist so the module compiles; the routine is wired separately. */
  screener_enabled: boolean;
  screener_short_every_ms: number;
  screener_swing_every_ms: number;
  /** okx_all = OKX 全市场(每日全市场扫描候选 + 成交额补齐;universe-okx.ts)。 */
  screener_universe: 'watchlist+whitelist' | 'top_volume' | 'explicit' | 'okx_all';
  screener_symbols: string[];
  /** 「观察列表 + 白名单」范围里的白名单;可在筛选设置里改,空 = 只筛观察列表。 */
  screener_whitelist: string[];
  screener_max_symbols: number;
  screener_use_brain: boolean;
  screener_apply: 'propose' | 'auto';
  screener_expectancy: boolean;
  /** Mirror of WORKFLOW_BOUNDS.watchlist_max so consumers (screener proposal size) read one place. */
  watchlist_max: number;
  /**
   * How each CLI is actually launched on THIS machine. May be a bare name on PATH, a path, a line with
   * env prefixes (`HTTP_PROXY=… claude`), or a shell alias that only exists in the interactive shell
   * (`claudeproxy`) — see cli-launch.ts. Used by every spawn: brains, agent_mcp execution, MCP probe,
   * and the login terminal.
   */
  cli_commands: CliCommandsView;
  /**
   * v3.5: which strategies from the library the live loop may use (docs/design/strategy-library-2026-09-05.md).
   * Only status ≥ paper may actually be active live; backtest/shadow are allowed in backtests only.
   */
  active_strategies: string[];
  /**
   * 09-12 §9.35 策略自动轮换:`manual` = 票池只有人改(默认,今天的行为);
   * `auto` = allocator 每天一次用代码决策票池(`strategy-allocator.ts`)。**模型没有任何一条路径能改它。**
   */
  active_mode?: import('./strategy-allocator.js').ActiveMode;
  /**
   * 09-09 策略议会(docs/design/strategy-council-2026-09-09.md):off = 旧行为;advise = 每条策略先各自表态,共识只当证据;
   * require = PROPOSE 必须有 ≥ council_min_agree 条策略同向共识(代码闸「策略共识」)。
   */
  strategy_council: import('./strategy-council.js').CouncilMode;
  /** 共识需要几条策略同向(会被钳到能投票的策略数)。 */
  council_min_agree: number;
  /** off = 只用代码裁决(零模型);cheap/main = 每条被唤醒的策略再各问一次副脑/主脑(每策略一次调用)。 */
  council_model: import('./strategy-council.js').CouncilModelMode;
  /**
   * 09-09 入场方式(docs/design/limit-entry-and-patience-2026-09-09.md):`free` = 模型自己选市价/限价;
   * `prefer_limit` = 回踩未确认或已追出 0.5 ATR 的**市价**开仓被代码闸拒,只能挂限价等回踩(闸只拒不改价)。
   */
  entry_style: import('./entry-policy.js').EntryStyle;
  /**
   * 09-12 §2 短/中/长分层配额:每层独立的容量/每日开仓/入场方式/议会门槛/allocator 名额。
   * **默认全 0 / 空 = 与分层上线之前逐字同一个行为**(见 {@link TierPolicy})。
   * 老库缺这个字段 → `loadWorkflow` 补默认;手改坏了也 fail-closed 回默认。
   */
  tier_policy: Record<Tier, TierPolicy>;
  /** 限价单等这么多根(策略 horizon 的复查周期)还没成交,代码就认为入场窗口过去了,建议撤单。 */
  entry_max_wait_bars: number;
  /**
   * 09-12 事件区闸 `event_blackout`(docs/design/strategy-loop-v2-and-events-2026-09-12.md §5):
   * 事件开始前多少分钟起、直到影响窗口结束,这个币不开新仓。**0 = 关闭(默认)**。
   * 只拦开仓;平仓/减仓/撤单永远放行,事件封锁不能把人困在仓位里。
   */
  event_blackout_min: number;
  /**
   * 09-12 保护腿凭证有效期(天,1–30,默认 7,§9.31):通道 × 交易对验证过挂止损之后,凭证只在这段时间内有效;
   * 过期后巡检自动重跑金丝雀续期。只有人能改(对话里属于拒绝档)。
   */
  protection_ttl_days: number;
  /**
   * 09-12 P1-04:**自动**金丝雀续期(定时真钱写路径)每天允许的最大次数,按当前执行通道整账户算,默认 `0`。
   * `0` = 没有额度(A 阶段默认):过期凭证只发告警,不自动下真实订单。人点的「用最小仓验证止损」不受它约束
   * (那是一次显式人类动作)。AGENTS.md 第 5 条:金丝雀额度未定之前不跑自动真钱。
   */
  protection_auto_verify_per_day: number;
  /**
   * 09-12 跟单 session(docs/design/trader-follow-2026-09-12.md §3):带单员信号当触发器。
   * `enabled=false`(默认)= 整条链路不拉不跑;每个带单员一份 `{mode, manual_weight, enabled}`,
   * 名册里没有的带单员 = 不跟(只留痕)。凭证**不在这里**(env 或 kv `follow.credentials`)。
   */
  follow: import('./trader-follow.js').FollowSettings;
  updated_at: number;
}

/** Which agent CLI drives the Binance MCP execution backend. */
export type AgentCliKind = 'claude' | 'codex';

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
  /** v3.9:`event_id` 是 InformationEvent.id(稳定),`url` 是原文链接(source_ref);旧快照读出来时按 info_refs 回填。 */
  news: { ref: string; event_id?: string | null; url?: string | null; title: string; source: string; /** v3.9:给人看的来源名(info.ts sourceLabel);旧快照读出时回填 */ source_label?: string; published_at: number; relevance: 'high' | 'medium' | 'low'; digest: string }[];
  candidates: { symbol: string; direction: Direction; why: string }[];
  risk_events: string[];
  info_refs: string[];
  usage: Usage | null;
  error: string | null;
}

export type ThreadStatus = 'pending_entry' | 'in_position' | 'closed' | 'canceled' | 'invalidated';
export type ThreadSource = 'agent' | 'manual' | 'chat' | 'trader';

/**
 * 09-08:一笔线程的交易所口径结算。平仓成交只有在 accountTradeList / income 里才有真实盈亏,
 * 下单回执没有 realizedPnl(所以在这之前 realized_pnl 一直是 null,复盘看到的是空白)。
 * `net_pnl` = 已实现盈亏 - 手续费 + 资金费(资金费本身是负数=支出),也就是这笔真正落到余额上的钱。
 */
export interface ThreadSettlement {
  status?: 'pending' | 'partial' | 'complete';
  initial_risk_usdt?: string;
  at: number;
  /** 交易所 realizedPnl 合计(不含费)。 */
  realized_pnl: string;
  /** 手续费合计,正数 = 支出。 */
  commission: string;
  /** 资金费合计,负数 = 支出。 */
  funding: string | null;
  /** realized - commission + funding。thread.realized_pnl 存的就是它。 */
  net_pnl: string;
  /** 平仓腿的量加权均价;只有开仓腿没有平仓腿时为 null。 */
  exit_price: string | null;
  trades: number;
  /** 取数窗口 [开仓, 平仓+宽限]。 */
  window: [number, number];
  source: 'exchange';
  note?: string;
}

export interface StrategyThread {
  market: Market;
  pair_id: string | null;
  holding_plan?: import('./holding-policy.js').HoldingPlan;
  last_policy_close_at?: number;
  last_policy_review?: import('./holding-policy.js').HoldingReview;
  /**
   * 09-23 §9.49:人工核实的利空事件(`POST /api/threads/:id/verified-event`)。复查时原样喂给 holding-policy 的
   * `event`,命中 `verified_material_event` 分支(持仓放开 REDUCE/EXIT,挂单放开 INVALIDATE;180s 内有效)。
   * 信息员的自由文本 risk_events 未核实,**不**写这里。null/缺省 = 无。
   */
  verified_event?: { id: string; material: true; verified_by: 'user' | 'risk_service'; adverse_side: Direction; observed_at: number; note: string } | null;
  scale_out?: { state: 'submitting' | 'unknown' | 'done'; client_order_id: string; qty: string; at: number };
  horizon?: import('./horizon.js').StrategyHorizon;
  strategy_version?: number;
  strategy_content_hash?: string;
  last_review_at?: number;
  /** 09-09:开仓那一刻的策略议会快照(谁同意、谁反对);复查时 councilReview() 对照。旧线程/off 模式为空。 */
  council?: import('./strategy-council.js').CouncilSnapshot | null;
  /** 09-12 P1-07:提议那一刻**冻结**的入场基准(突破位/ATR/可执行价),发送前重测距用它,不现算。 */
  entry_basis?: { breakout_level: number | null; atr: number | null; mark: number; at: number } | null;
  /** 09-12 跟单:这条线程是谁开的 —— `trader:<带单员名>`;自己开的线程没有这个字段。 */
  origin?: string;
  /** 09-12 跟单:开这条线程的那条带单员信号 `signal_id`(管理动作按它 / trader+symbol 关联回来)。 */
  trader_signal_id?: string;
  /**
   * 09-13 跟单首发范围:信号给了**多档**止盈,但本实现只挂得了第一档(分档减仓未实现)。
   * 非空 = 交易所上只有 `placed` 这一档,`dropped` 里的档位**没有挂**。
   * 前端必须显示出来 —— 不然「信号说 110 平 30%、120 平 70%」会被读成已经照做了。
   */
  /** 运行器只挂首档的原生数量止盈;client_order_id 在调用前持久化,有记录就不另起一档。 */
  run_take_profit?: { price: string; size_pct: number; qty: string; client_order_id?: string; state?: 'sending' | 'submitted' | 'unknown' | 'failed'; resize_stop?: boolean; stop_client_order_id?: string; stop_pending?: boolean; step_size?: string };
  /** 钉住研究核的完整目标,供发送前加权 RR 重闸和审计(后续档位不挂)。 */
  run_targets?: { price: string; size_pct: number }[];
  tp_partial_unsupported?: { placed: string; dropped: { price: string; percent: number }[]; note: string };
  /**
   * 09-13 跟单:入场腿的有效期(unix 毫秒,来自信号 `valid_until`)。
   * 到点还没成交 → 巡检撤掉余量:带单员那一单的窗口已经过去,再成交就是在追一个失效的点位。
   */
  entry_expires_at?: number;
  id: string;
  /** v3.8:开仓时的执行通道;列表/复查/历史都按当前通道过滤(切通道 = 切账户上下文)。旧行迁移为 'paper'。 */
  backend?: Backend | null;
  /** v3.5: the strategy library id the opening judgment named (null for threads opened before the library). */
  strategy_id?: string | null;
  /** Average exit price when known (paper SL/TP hit price, or the close receipt); absent on older rows. */
  exit_price?: string | null;
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
  take_profits: string[];
  qty: string;
  margin_usdt: string | null;
  leverage: number;
  margin_mode: 'cross' | 'isolated';
  entry_client_order_id: string | null;
  protection_client_order_ids: string[];
  filled_avg_price: string | null;
  /** 净盈亏(交易所结算口径,含手续费与资金费);null = 还没结算成功,不等于 0。 */
  realized_pnl: string | null;
  /** 09-08:结算明细;缺失 = 这笔还没从交易所拉到成交(复盘要显示「结算中」而不是 0)。 */
  settlement?: ThreadSettlement | null;
  close_reason: string | null;
  /** Machine-readable "needs a human" flag, e.g. PROTECTION_MISSING / ORDER_UNKNOWN / EXTERNAL_ACTIVITY; null when fine. */
  attention: string | null;
  /** Consecutive `getOrder === null` for the entry order (propagation delay is not a negative fact). */
  entry_lookup_misses: number;
  /** 入场调用进行中(CID 已持久化、请求可能还没到交易所):巡检在宽限内不查此 CID,不报 ORDER_UNKNOWN。调用返回即清空。 */
  /** 撤单请求尚未以同 CID 终态与累计成交量确认；独立于保护 attention。 */
  entry_cancel_pending?: boolean;
  /**
   * 09-12 P0-01:已成交仓位当前**缺**活动止损(按本轮交易所挂单判)。和 `entry_cancel_pending`(入场余量核对)
   * 是两件独立持久化的事:余量还在核对时保护检查照跑,巡检每轮都按已知敞口重判一次。
   */
  protection_missing?: boolean;
  /**
   * 09-12 P0-01:余量 unknown 期间已对**已确认**仓位做过 reduce-only 平仓。
   * **这不是一次性布尔**:它绑定下面三个水位字段。后续入场单又有新成交(累计成交 > 已平)、
   * 或账户读比上次平仓更新且仍看得到仓位时,人工平仓 / 硬止损必须还能再平一次。
   */
  exposure_flattened?: boolean;
  /** 上次减风险平仓平掉的数量(十进制字符串)。 */
  exposure_flattened_qty?: string | null;
  /** 上次平仓时这条入场单的**累计成交**水位;之后累计成交超过它 = 有新敞口。 */
  exposure_flattened_fill?: string | null;
  /** 上次平仓被证实的时刻(unix ms);账户快照不比它新 = 看到的是平仓前的旧事实。 */
  exposure_flattened_at?: number | null;
  entry_submitting_since?: number | null;
  /** 09-12 P1-01:开这次提交相位的进程 epoch。与当前进程不符 = 崩溃遗留的相位,撤单链可以接管。 */
  entry_submit_epoch?: string | null;
  /** 入场调用返回的时刻:之后 45 秒内同币同向出现的持仓先算「待归属」,不报 EXTERNAL_POSITION;查不到单也不报 ORDER_UNKNOWN。 */
  entry_submitted_at?: number | null;
  /** Monotonic per-thread leg counter used to mint unique clientOrderIds. */
  leg_seq: number;
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
  /** 'narration' = the agent's own one-liners about what it just did; 'chat' = the conversation. */
  kind: 'chat' | 'narration';
  /** v3.8:所属会话(旁白为 null)。 */
  session_id?: string | null;
}

export interface ChatSession {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  archived: boolean;
  /** 本会话允许 agent 直接批准/否决待批 intent(用户在会话头上开,默认关)。 */
  can_execute: boolean;
  /** v3.8:对着哪个角色说(楼层桌子进来的会话);null = 主会话,由 Gate Captain 路由。 */
  role: string | null;
  message_count: number;
  last_text: string | null;
}

export type EpisodeStep = 'fetching' | 'context' | 'thinking' | 'validating' | 'gating' | 'executing' | 'done';

export interface QueueView {
  pending: number;
  running: { kind: string; symbol: string | null; step?: EpisodeStep | null; episode_id?: string | null } | null;
}

export interface ManualOrderRequest {
  market?: Market;
  symbol: string;
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

// ---------------------------------------------------------------- v3 (docs/demo/v3-ui-contract.md)

export type ActivityKind =
  | 'proposal'
  | 'proposal_blocked'
  | 'approval_needed'
  | 'approved'
  | 'rejected'
  | 'thread_opened'
  | 'entry_filled'
  | 'entry_partial_fill'
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
  | 'cap_reached'
  | 'execution_changed'
  | 'heartbeat_skipped'
  | 'screen_done'
  | 'screen_failed'
  | 'risk_alert'
  | 'risk_cleared'
  /** 09-12 §9.35:allocator 换了票池(info;`data = {from,to,add,remove,mode,regime}`)。 */
  | 'active_set_changed'
  | 'brief';

/** One prominent line for the activity timeline (the logs page's top half). Raw LogLine stays for debugging. */
export interface ActivityItem {
  market?: Market | null;
  observed_count?: number;
  first_seen_at?: number;
  last_seen_at?: number;
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

export type DailyRegimeKind = 'bull' | 'bear' | 'range' | 'volatile';

/** Code-computed daily-timeframe state (no model involved). */
export interface DailyRegime {
  regime: DailyRegimeKind;
  ema_stack: string;
  ret_20d_pct: number;
  ret_5d_pct: number;
  vol_pct_rank: number;
  atr_pct: number;
  dist_to_ema200_pct: number | null;
  text: string;
  as_of: number;
}

export type SessionName = 'us_open_window' | 'us_close_window' | 'us' | 'london' | 'asia' | 'weekend' | 'off';

export interface SessionInfo {
  name: SessionName;
  text: string;
  minutes_to_us_open: number | null;
  minutes_to_us_close: number | null;
  weekend: boolean;
}

export interface RegimeView {
  symbol: string;
  as_of: number;
  daily: DailyRegime | null;
  session: SessionInfo;
}

export interface TriggerHit {
  event_id?: string;
  event_subkind?: string;
  source_ref?: string;
  research_task_id?: string;
  kind: TriggerKind;
  detail: string;
  /** 0-1, how strongly the rule fired (for ordering / evidence text only). */
  score: number;
}

export interface EquityPoint {
  at: number;
  equity: number;
  unrealized: number;
  /** v3.8:所属执行通道(曲线按通道画,不同通道的权益不接在一起)。 */
  backend?: Backend;
}

export interface HistoryThreadRow extends StrategyThread {
  hold_ms: number;
  /** false = 盈亏还没从交易所结算回来(pnl_num 不可信,统计里不计入)。 */
  settled: boolean;
  pnl_num: number;
  exit_price: string | null;
  episode_count: number;
  r_multiple: number | null;
}

export interface HistoryStats {
  /** 已结算并计入统计的笔数。 */
  count: number;
  /** 已平仓但还没拿到交易所结算的笔数(不计入 count/胜率/总盈亏)。 */
  unsettled: number;
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
  by_symbol: { symbol: string; count: number; wins: number; pnl: string }[];
  by_source: { source: ThreadSource; count: number; pnl: string }[];
  by_close_reason: { reason: string; count: number; pnl: string }[];
}

export interface HistoryResponse {
  stats: HistoryStats;
  threads: HistoryThreadRow[];
  equity: EquityPoint[];
}

// ---------------------------------------------------------------- v3.2 memory (docs/demo/memory.md, design §11 L3 "B7-lite")

export type MemoryKind = 'lesson' | 'preference' | 'fact' | 'calibration';
/** proposed → active (human approved) | rejected; active → superseded (a newer item replaced it) | forgotten (tombstone). */
export type MemoryStatus = 'proposed' | 'active' | 'rejected' | 'superseded' | 'forgotten';
export type MemoryProposer = 'agent' | 'user' | 'system';

/**
 * 09-23 记忆分域(docs/design/self-evolution-2026-09-23.md §5.2):一条记忆属于且只属于一个 layer。
 * global = 全体可读的通用教训;role = 某个角色自己的方法记忆(配 `role`);strategy = 某条策略的教训(配 `strategy_id`);
 * symbol = 某个币的教训/事实(配 `symbol`);thread = 某条线程私有(配 `thread_id`,目前只有 reviewer/captain 读)。
 */
export type MemoryLayer = 'global' | 'role' | 'strategy' | 'symbol' | 'thread';
export const MEMORY_LAYERS: readonly MemoryLayer[] = ['global', 'role', 'strategy', 'symbol', 'thread'];

export interface MemoryScope {
  /**
   * 09-23 §5.2。旧行迁移时回填:symbol 非空 → 'symbol',否则 'global'。
   * 四个新字段在类型上可选只为兼容旧的构造点(eval-a gen-memory 等);gateway 读出/写入的 item 一律四个都带(缺省按 layerOf 推断、其余 null)。
   */
  layer?: MemoryLayer;
  /** layer='role' 时必填:这条记忆属于哪个角色;其它 layer 为 null。 */
  role?: BotRole | null;
  /** layer='strategy' 时必填;其它 layer 可带(仅作标注,不参与读权)。 */
  strategy_id?: string | null;
  /** null = applies to every symbol. layer='symbol' 时必填。 */
  symbol: string | null;
  timeframe: string | null;
  /** Daily regime the lesson was learnt in (bull/bear/range/volatile) or null. */
  regime: string | null;
  /** layer='thread' 时必填。 */
  thread_id?: string | null;
}

/** 09-23 §2.2 记忆后果回写的聚合(由 demo_memory_events kind='outcome' 现算,不落 json)。NULL 不是 0:没有可算的 R 时为 null。 */
export interface MemoryStats {
  cited_n: number;
  mean_r_when_cited: number | null;
  mean_regret_when_cited: number | null;
}

/**
 * One durable, human-approved memory. Rules (design §11): memory never overrides L1 live truth; the judgment may
 * cite a memory (it is registered as evidence `E#` labelled 记忆) but numbers inside a memory are never market
 * numbers; 30 days without use → decays out of recall; writes are proposals until approved.
 */
export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  scope: MemoryScope;
  /** ≤ 300 chars, plain language, one idea. */
  content: string;
  /** Episode / thread ids the memory was distilled from. */
  source_refs: string[];
  /** Free tags used for structured recall: trigger kinds, close reasons, 'win'/'loss', strategy names… */
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
  /** sha256 of normalised content, exact-duplicate guard. */
  content_hash: string;
  /** 09-23 §2.2:`get`/`list` 读出时现算附上;写库时剥掉。 */
  memory_stats?: MemoryStats;
}

export interface MemoryEvent {
  id: number;
  memory_id: string;
  at: number;
  /** 09-23:`write_denied`(写权矩阵拒绝,memory_id 为 '-',detail 是 JSON)与 `outcome`(被引用后结算回写,detail 是 JSON)。 */
  kind: 'proposed' | 'approved' | 'rejected' | 'forgotten' | 'superseded' | 'used' | 'expired' | 'dedup_hit' | 'write_denied' | 'outcome';
  detail: string | null;
}

/** Structured recall request (what the runtime asks before building a context). */
export interface MemoryRecallQuery {
  symbol: string | null;
  /** 09-23 §5.2 读权矩阵:谁在读。缺省 'thread_manager'(判断前召回是现存最主要的调用点)。 */
  reader_role?: BotRole;
  /** 当前线程/判断跟的策略;thread_manager 只读这一条策略的 strategy 层记忆,缺省则不读 strategy 层。 */
  strategy_id?: string | null;
  timeframe?: string | null;
  regime?: string | null;
  tags?: string[];
  /** Free text (chat `recall`) — FTS5 trigram match on content + tags. */
  text?: string | null;
  limit?: number;
  /** Total content characters allowed in the result (≈ 300 tokens by default). */
  char_budget?: number;
  now?: number;
}

export interface MemoryRecallHit {
  item: MemoryItem;
  score: number;
  why: string[];
}

// ---------------------------------------------------------------- v3.3 execution backend + cost control

export type McpConnectionStatusKind = 'connected' | 'needs_auth' | 'unavailable' | 'unknown';

export interface ExecutionOption {
  kind: Backend;
  label: string;
  /** Selectable right now (factory registered and, for agent_mcp, the chosen CLI on PATH). */
  available: boolean;
  note: string;
  /** 09-07:推荐通道(官方 binance-cli):UI 排最前、打「推荐」标;不可用时把 setup 顶到最上面让用户先看到。 */
  recommended?: boolean;
  /** 不可用时的接入步骤(多行);可用时 null。 */
  setup?: string | null;
}

/** 09-12(§9.31):一条通道 × 交易对的保护腿凭证在界面上的样子。symbol=null 是 v3.11 迁移来的通道级兜底凭证。 */
export interface ProtectionCredentialView {
  market: Market;
  channel: string;
  symbol: string | null;
  state: import('./protection.js').ProtectionState;
  verified_at: number | null;
  /** 按**当前** protection_ttl_days 现算 */
  expires_at: number | null;
  last_probe_at: number | null;
  last_probe_ok: boolean | null;
  last_error: string | null;
  last_auto_at: number | null;
  /** 凭证来源:这个交易对自己的 / 通道级兜底 / 没有凭证 */
  source: 'symbol' | 'channel' | null;
}

/**
 * v3.11:通道保护腿自验证状态(§9.20)。用户在界面上点「用最小仓验证」,网关自己跑金丝雀并落库,不需要环境变量/重启。
 * 09-12(§9.31)起是**有期限的凭证**,按通道 × 交易对存;`status` 保留给旧前端(never_verified → unverified,
 * probe 失败 → failed),新前端看 `state` 与 `credentials`。
 */
export interface ProtectionStatusView {
  status: 'not_needed' | 'verified' | 'unverified' | 'verifying' | 'failed';
  /** 09-12 三态(当前通道的汇总:watchlist 里最差的那个) */
  state: import('./protection.js').ProtectionState;
  /** 当前生效的凭证有效期(天) */
  ttl_days: number;
  /** 当前通道 × watchlist 的凭证(没有凭证的交易对也会出现,state=never_verified) */
  credentials: ProtectionCredentialView[];
  /** 自动重验这轮为什么没跑(暂停 / 没资金 / 节流…);跑得动时为 null */
  auto_note: string | null;
  verified_at: number | null;
  /** 当前汇总凭证的过期时刻(按当前 ttl 现算;多个币取最早的那个) */
  expires_at: number | null;
  last_run_at: number | null;
  last_error: string | null;
  /** 最近一次验证的分步结果(名称/是否通过/说明) */
  steps: { name: string; ok: boolean; detail: string }[];
  /** 给按钮旁的提示:大概花多少钱、多久 */
  cost_note: string;
  /** 验证记录来自哪里:env(开发者覆盖)/ record(落库的金丝雀)/ null */
  source: 'env' | 'record' | null;
}

/**
 * 09-07:执行通道最近一段时间的传输健康——连接被掐/超时/无响应这类「回执丢了但交易所可能已执行」的次数。
 * 通道无关:任何后端都可以报;null = 该后端不统计。用于告诉用户「是你的网络在掐连接,不是交易所拒单」。
 */
export interface TransportHealth {
  window_ms: number;
  runs: number;
  transport_errors: number;
  last_error: string | null;
  last_at: number | null;
}

/** 09-07:网络自检——连续 N 次只读账户调用,统计几次连接被掐/超时、平均耗时,给用户判断代理/网络该不该调。 */
export interface NetCheckResult {
  backend: Backend;
  started_at: number;
  finished_at: number;
  runs: { ms: number; ok: boolean; transport_error: boolean; error: string | null }[];
  ok: number;
  transport_errors: number;
  other_errors: number;
  avg_ms: number | null;
  /** 一句话结论 + 建议 */
  verdict: string;
}

export interface ExecutionView {
  markets_supported: Market[];
  /** 当前交易所(§5):前端据此隐藏 Binance 专属的块与文案。 */
  exchange: ExchangeKind;
  /** OKX 接入状态;非 okx 交易所为 null。 */
  okx: OkxStatusView | null;
  cost_control?: { read_mode: string; model_runs: number; direct_calls: number; cache_hits: number; model_budget: { blocked: boolean; blocked_at: number | null; reason: string | null } } | null;
  backend: Backend;
  /** v3.11 */
  protection: ProtectionStatusView;
  /** 09-07:传输健康;null = 后端不统计 */
  transport: TransportHealth | null;
  options: ExecutionOption[];
  /** `model` is what the CLI will actually be run with (claude falls back to sonnet, the cheap one). */
  agent: { cli: AgentCliKind; model: string | null; model_note: string | null; server_name: string; url: string; command: string; resolved: CliResolvedView };
  connection: { status: McpConnectionStatusKind; checked_at: number | null; detail: string };
  /** v3.8:最近一次账户读取失败(读成功后清空)。UI 据此显示「执行通道账户不可读」而不是权益 0。 */
  account_read_error: { at: number; message: string } | null;
  /** v3.8:当前通道账户是否入金(读成功且权益 0、无持仓 → false;没读到过 → null)。 */
  account_funded: boolean | null;
  can_switch: boolean;
  switch_blocker: string | null;
}

/** Today's model spend (local day), for GET /api/overview. `est_cny` is null when no priced model was used. */
export interface UsageToday {
  judgments: number;
  input_tokens: number;
  output_tokens: number;
  est_cny: number | null;
  cap: number;
  capped: boolean;
}

// ---------------------------------------------------------------- 短/中/长分层(09-12 §2)

/**
 * 持有周期分层。四个 `StrategyHorizon` 压进三层:`intraday`(当日了结)按定义归 short,
 * 它和 `scalp` 在容量/频率上的差别远小于它们与 `swing`(持有几天)的差别。
 * 设计:docs/design/attribution-and-tiers-2026-09-12.md §2.1。
 */
export type Tier = 'short' | 'mid' | 'long';
export const TIERS: readonly Tier[] = ['short', 'mid', 'long'];
export const TIER_LABEL: Record<Tier, string> = { short: '短线', mid: '中线', long: '长线' };

export const TIER_OF: Record<import('./horizon.js').StrategyHorizon, Tier> = {
  scalp: 'short',
  intraday: 'short',
  swing: 'mid',
  position: 'long',
};

/** 没有 horizon 的东西(手工线程 / 老数据)按周期推:与 `horizon.inferHorizon` 同一套口径。 */
export function tierOfTimeframe(tf: string): Tier {
  if (tf === '1d' || tf === '1w') return 'long';
  if (tf === '4h') return 'mid';
  return 'short';
}

export function tierOf(x: { horizon?: import('./horizon.js').StrategyHorizon | null; timeframe?: string | null } | null | undefined): Tier | null {
  if (!x) return null;
  if (x.horizon) return TIER_OF[x.horizon];
  return x.timeframe ? tierOfTimeframe(x.timeframe) : null;
}

/**
 * 每层独立的配额。**每个数字字段 `0` = 继承全局 / 不额外限制,`entry_styles` 空数组 = 不限。**
 * 这是有意的默认:分层是一套新闸,新闸默认必须「什么也不改」,否则这次上线会在用户没按
 * 任何按钮的情况下改掉钱的行为。填上数字,分层才真正生效。
 */
export interface TierPolicy {
  /** 本层同时在手线程上限(pending_entry + in_position);0 = 只受全局 `max_open_threads` 约束。 */
  max_open_threads: number;
  /** 本层每日开仓上限;0 = 只受全局 `max_opens_per_day` 约束。 */
  max_opens_per_day: number;
  /** 本层允许的入场方式;空 = 不限(仍受全局 `entry_style` 约束)。 */
  entry_styles: ('market' | 'limit')[];
  /** 本层议会票数门槛;0 = 继承 `council_min_agree`。 */
  council_min_agree: number;
  /** allocator 给本层的名额;0 = 不限(仍受 `active_strategies_max` 约束)。 */
  allocator_slots: number;
}

// ---------------------------------------------------------------- 决策记录(09-12 §3 减黑盒)

/**
 * 一步决策的**理由码**。是枚举,不是自由文本 —— 「黑盒」的具体形态就是「理由是一句人写的话,
 * 没法聚合、没法对拍、没法当统计维度」。换成枚举之后,归因报告里「被闸拒的分布」才画得出来。
 */
export const DECISION_REASON_CODES = [
  // 一、代码给的允许集
  'code_graph_edges',
  'code_council_consensus',
  'code_council_no_consensus',
  'code_council_off',
  'code_entry_free',
  'code_entry_prefer_limit',
  'code_entry_limit_only',
  'code_no_strategy',
  // 二、模型选了什么
  'model_within_allowed',
  'model_illegal_repaired',
  'model_failclosed',
  'model_no_output',
  // 三、闸之后真的执行了什么
  'gate_pass',
  'gate_blocked',
  'gate_not_applicable',
  'gate_tier_daily_cap',
  'gate_tier_capacity',
  'gate_tier_entry_style',
  'exec_intent',
  'exec_awaiting_approval',
  'exec_none',
  // 四、跟单 session(docs/design/trader-follow-2026-09-12.md §3):一条带单员信号最终怎么处置。
  // 「没跟」的那些码和「跟了」的一样重要 —— 不然跟单腿的成绩没法和不跟的反事实对账。
  'trader_follow_copy',
  'trader_follow_book',
  'trader_follow_book_pending',
  'trader_follow_agent_agree',
  'trader_follow_agent_disagree',
  'trader_follow_agent_flat',
  'trader_signal_stale',
  'trader_signal_no_stop',
  'trader_gate_blocked',
  'trader_reverse_exposure',
  'trader_duplicate_open',
  'trader_add_manual',
  'trader_mgmt_orphan',
] as const;

export type DecisionReasonCode = (typeof DECISION_REASON_CODES)[number];

export function isDecisionReasonCode(v: unknown): v is DecisionReasonCode {
  return typeof v === 'string' && (DECISION_REASON_CODES as readonly string[]).includes(v);
}

export const DECISION_RECORD_VERSION = 'dr-v1';

/**
 * 一次判断的结构化决策记录(与 episode 严格 1:1,所以挂在 Episode JSON 上,不另立表)。
 * 三栏:**代码允许 → 模型选 → 闸后执行**。三栏之间不一致的地方就是「黑盒在哪里」的答案。
 */
export interface DecisionRecord {
  version: string;
  at: number;
  tier: Tier | null;
  /** 一:模型看到题面之前代码就已经定好的允许集。 */
  allowed: {
    /** 判断图在这个节点给出的合法动作(没有图快照时 = 全集)。 */
    actions: Action[];
    /** `entry_style` 闸允许的入场方式。 */
    entry_styles: ('market' | 'limit')[];
    council: { reached: boolean; direction: Direction | null; agreeing: number; required: number } | null;
    strategies: { id: string; version: number; content_hash: string }[];
    codes: DecisionReasonCode[];
  };
  /** 二:模型选了什么。 */
  model: {
    action: Action | null;
    direction: Direction | null;
    entry: 'market' | 'limit' | null;
    confidence: number | null;
    /** 模型第一次输出的非法动作(之后被修复/fail-closed);null = 第一次就合法。 */
    illegal_action: string | null;
    codes: DecisionReasonCode[];
  };
  /** 三:闸之后真的执行了什么。 */
  executed: {
    action: Action | null;
    passed: boolean;
    /** 没过的闸名(`GateResult.name`,不是自由文本)。 */
    blocked_by: string[];
    intent_id: string | null;
    codes: DecisionReasonCode[];
  };
  evidence_plan_hash: string | null;
  /** sha1(排序后的 `id@version@content_hash`):这次判断用的是哪一套策略版本。 */
  strategy_version_hash: string | null;
}
