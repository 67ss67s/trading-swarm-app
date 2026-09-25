/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source of truth: packages/contracts/{schema,transitions,tables}/*.json
 * Regenerate: `npm run generate` in packages/contracts (`npm run generate:check` verifies in CI).
 * Changing schema/transitions/tables is a main-line-only change — see docs/contracts/README.md §10.
 */

export type SchemaVersion = 1;
/**
 * main=主账户(用户,REST);sub=Agentic 子账户(agent,MCP)
 */
export type AccountRef = "main" | "sub";
export type Channel = "rest" | "mcp";
/**
 * unix 毫秒;上限为 JS 安全整数
 */
export type TimestampMs = number;
export type Consistency = "consistent" | "inconsistent" | "unavailable";
/**
 * sha256 小写 hex
 */
export type Hash256 = string;
export type Completeness = "complete" | "partial" | "missing";
export type ObservationSource = "rest" | "ws" | "mcp" | "cache";
export type ErrorKind =
  | "invalid_params"
  | "not_found"
  | "forbidden"
  | "halted"
  | "stale"
  | "unavailable"
  | "conflict"
  | "expired"
  | "invalid_transition"
  | "gate_rejected"
  | "exchange_rejected"
  | "unauthorized"
  | "rate_limited"
  | "transport_ambiguous"
  | "internal";
export type Asset = string;
export type Wallet = "spot" | "usdm_futures";
/**
 * 十进制字符串;不用 float,便于两种语言得到相同的 canonical JSON 与哈希
 */
export type Decimal = string;
/**
 * 交易所符号,如 BTCUSDT
 */
export type Symbol = string;
/**
 * v1:USDⓈ-M 永续可交易;spot 只读
 */
export type Product = "usdm_perp" | "spot";
export type PositionSide = "both" | "long" | "short";
export type UnsignedDecimal = string;
export type MarginType = "isolated" | "cross";
/**
 * Binance 允许的 clientOrderId 字符集与长度;本仓库生成的以 tg- 开头
 */
export type ClientOrderId = string;
export type Side = "buy" | "sell";
export type OrderType =
  | "market"
  | "limit"
  | "stop_market"
  | "stop_limit"
  | "take_profit_market"
  | "take_profit_limit"
  | "trailing_stop_market";
export type ExchangeOrderStatus = "new" | "partially_filled" | "filled" | "canceled" | "expired" | "rejected";
export type TimeInForce = "gtc" | "ioc" | "fok" | "gtx";
/**
 * 条件单触发价来源:mark=标记价,contract=最新成交价
 */
export type WorkingType = "mark_price" | "contract_price";
/**
 * 按 clientOrderId 前缀判定:tg- 为本机;其他(含 8794 的 ts_)为外部
 */
export type OrderOrigin = "local" | "foreign" | "unknown";
export type PositionMode = "one_way" | "hedge";
/**
 * 小写 UUID(v4 为主)
 */
export type Uuid = string;
/**
 * 一个 intent 可能产生多条腿;每条腿各自有 ExecutionAttempt
 */
export type Leg = "entry" | "stop" | "take_profit" | "cancel" | "close" | "transfer";
/**
 * 崩溃边界:clientOrderId 在 before_submit 时已持久化;submitted 后不知结果即 unknown
 */
export type AttemptStage = "before_submit" | "submitted" | "result_persisted";
export type AttemptResult = "pending" | "acked" | "rejected" | "unknown" | "not_received";
/**
 * ActorContext.principal(设计 §6.1)
 */
export type Principal = "user" | "model" | "cron" | "scheduler" | "mcp_client";
export type Surface = "rpc" | "model" | "mcp" | "internal";
export type AuthorizationStatus = "active" | "consumed" | "expired" | "invalidated" | "revoked";
export type IntentKind = "open" | "close" | "cancel_order" | "protect" | "transfer";
/**
 * 设计 §5.1 状态图;终态 rejected/recorded/completed/canceled/expired;execution_unknown 非终态
 */
export type IntentStatus =
  | "proposed"
  | "rejected"
  | "awaiting_approval"
  | "authorized"
  | "recorded"
  | "dispatching"
  | "execution_unknown"
  | "executing"
  | "completed"
  | "canceled"
  | "expired";
export type EffectStatus = "pending" | "satisfied" | "failed";
export type PolicyMode = "run" | "stop_opening" | "flatten_only" | "halt_all";
export type Authority = "observe" | "draft" | "paper" | "live_capped";
export type DemoCapacityConstraint =
  | "thread_slots"
  | "margin_budget"
  | "available_margin"
  | "min_size_risk"
  | "rules_unknown"
  | "market_unavailable"
  | "watchlist"
  | "snapshot_unavailable";
export type EventName =
  | "intent.created"
  | "intent.rejected"
  | "intent.awaiting_approval"
  | "intent.authorized"
  | "intent.recorded"
  | "intent.dispatching"
  | "intent.executing"
  | "intent.execution_unknown"
  | "intent.completed"
  | "intent.canceled"
  | "intent.expired"
  | "plan.materialized"
  | "authorization.granted"
  | "authorization.consumed"
  | "authorization.invalidated"
  | "authorization.expired"
  | "authorization.revoked"
  | "attempt.submitting"
  | "attempt.submitted"
  | "attempt.resolved"
  | "order.observed"
  | "fill.observed"
  | "effect.evaluated"
  | "protection.confirmed"
  | "protection.missing"
  | "protection.compensated"
  | "account.updated"
  | "account.stale"
  | "account.inconsistent"
  | "foreign_activity.detected"
  | "exchange.auth.expiring"
  | "exchange.auth.expired"
  | "exchange.auth.revoked"
  | "exchange.auth.refreshed"
  | "exchange.tools.drift"
  | "exchange.channel.degraded"
  | "exchange.channel.recovered"
  | "policy.changed"
  | "halt.changed"
  | "writer.fenced"
  | "corruption.detected"
  | "health";
export type IntentParams = OpenParams | CloseParams | CancelOrderParams | ProtectParams | TransferParams;
export type SizeSpec =
  | {
      mode: "hint";
      /**
       * 模型只给档位;qty 由代码按止损距离与风险预算反推
       */
      hint: "full" | "half" | "quarter";
    }
  | {
      mode: "qty";
      qty: UnsignedDecimal;
    }
  | {
      mode: "notional";
      notional: UnsignedDecimal;
    };
export type EntrySpec =
  | {
      type: "market";
      max_slippage_bps?: number;
    }
  | {
      type: "limit";
      price: UnsignedDecimal;
      time_in_force?: TimeInForce;
      post_only?: boolean;
    };
export type PlanEconomics = OrderEconomics | ProtectEconomics | CancelEconomics | TransferEconomics;
export type CancelEconomics = CancelEconomics1 & CancelEconomics2;
export type CancelEconomics1 = {
  [k: string]: unknown;
};
export type ResearchBacktest = BacktestReport | BacktestReportSummary;
export type StrategyIR = StrategyIR1;
export type JudgeQuestion = JudgeQuestion1;
export type JudgeStateField =
  | "candidate.direction"
  | "candidate.stop_distance_atr"
  | "candidate.reward_risk"
  | "features.trend"
  | "features.volatility"
  | "features.volume_ratio"
  | "features.funding"
  | "features.market_regime"
  | "features.ob_imbalance_05"
  | "features.ob_wall_up"
  | "features.ob_wall_down"
  | "features.spread_bps"
  | "features.liq_long_5m"
  | "features.liq_short_5m"
  | "candidate.reference"
  | "candidate.support"
  | "candidate.resistance"
  | "candidate.stop"
  | "candidate.target";
export type BacktestSegmentName = "in_sample" | "out_of_sample";
export type OrderMarket = "spot" | "perp";
export type BacktestAssetKind = "single" | "basket";
export type BacktestAssetStatus = "completed" | "failed" | "data_missing";
export type OrderSide = "long" | "short";
export type OrderEntryType = "market" | "limit";
/**
 * pending=挂单中(数据末仍在时效内);filled=已成交(看 exit);no_fill=时效内未触价;replaced=成交前被同向新计划整体替换(8794 v8);cancelled=成交前被反向计划撤销或跳空使止损/止盈失效;blocked=放置前盈亏比低于 min_rr 或无有效止损,没下单(只进统计与回放,不影响净值)
 */
export type OrderPlanStatus = "pending" | "filled" | "no_fill" | "replaced" | "cancelled" | "blocked";
export type OrderLevelSource =
  "structure_support" | "structure_resistance" | "atr" | "rr" | "indicator" | "fixed_pct" | "user" | "trail";
export type OrderExitReason =
  | "tp"
  | "sl"
  | "trail"
  | "signal_exit"
  | "time"
  | "rolled"
  | "flipped"
  | "liquidation"
  | "breakeven"
  | "end_of_data"
  | "open";
export type BacktestPlanEventKind =
  | "placed"
  | "filled"
  | "no_fill"
  | "replaced"
  | "stop_moved"
  | "tp_moved"
  | "tp_hit"
  | "sl_hit"
  | "rolled_in"
  | "rolled_out"
  | "added"
  | "flipped"
  | "liquidated"
  | "funding"
  | "closed"
  | "cancelled"
  | "blocked";
export type BacktestScoreLabel = "excellent" | "good" | "fair" | "needs_work" | "poor";
export type BacktestConfidence = "low" | "medium" | "high";
/**
 * 批量策略研究(docs/research/batch-study-2026-09-23.md)用的组合级原语:横截面动量调仓(portfolio_xsmom)、永续资金费套利两腿(portfolio_carry)。它们作用在资产池上,不是单资产 StrategyIR 的一段,所以不进 research.json 的原语表;实现见 packages/gateway/src/demo/research/primitives/portfolio-*.ts。
 */
export type ResearchBatchPortfolioPrimitive = PortfolioXsmomNode | PortfolioCarryNode;
/**
 * §9.47 StrategyBinding:研究台策略版本(StrategyIR,唯一真源)编译出来的实盘绑定(只读编译产物)。字段对齐 docs/design/strategy-apply-spec-2026-09-23.md §3 与 复审修订;实盘侧(radar / 候选生成 / holding-policy / gates)按这些字段消费,字段名保持稳定。部署模式、仓位 cap 不在这里(属于部署,由实盘注册表管)。
 */
export type ResearchStrategyBinding = StrategyBindingResponse | BuiltinImportResult;
/**
 * 规则拆给哪个角色:radar 唤醒 / judge 入场过滤(模型)/ geometry 止损止盈放置 / risk 仓位与杠杆 / holding 持仓管理 / execution 下单方式
 */
export type BindingRole = "radar" | "judge" | "geometry" | "risk" | "holding" | "execution";
/**
 * 这条规则由谁执行:code = 代码逐根算/挂单/改单,不叫模型;model = 模型判断(只在 judge 切片出现,且只决定做/不做)
 */
export type BindingExecutor = "code" | "model";
/**
 * 策略自动改进与复验环(Improver)第一阶段:POST/GET /api/research/improve 的请求与响应,SSE 事件 research.improve。设计见 docs/research/improver-design-2026-09-23.md。
 */
export type ResearchImproveObject =
  ImproveJobDetail | ImproveJobList | ImproveAccepted | ImproveJobSummary | ImproveEvent;
export type ResearchLoop = LoopPlan | LoopSnapshot | LoopArtifact;
export type LoopTaskKind = "market" | "compare" | "validate" | "diagnose";
export type LoopResearchMode =
  | "validate_single"
  | "validate_multi"
  | "compare_assets"
  | "market_leverage"
  | "diagnose"
  | "parameter_sweep"
  | "pattern_frequency";
export type LoopJson =
  | null
  | boolean
  | string
  | number
  | LoopJson[]
  | {
      [k: string]: LoopJson;
    };
export type LoopAvailability = "available" | "partial" | "missing" | "not_applicable" | "stale";
export type LoopRows = {
  [k: string]: number | string | null;
}[];
/**
 * 序列画法:折线 / 带点折线 / 柱 / 散点
 */
export type LoopSeriesMode = "line" | "line+markers" | "bar" | "scatter";
/**
 * 颜色角色:前端按角色取色(策略=主色、持有=蓝、正=绿、负=红…),不在数据里写死颜色
 */
export type LoopSeriesRole =
  "strategy" | "benchmark" | "asset" | "basket" | "alt" | "positive" | "negative" | "neutral" | "split";
/**
 * 纵轴数值单位:$ 按 $10k/9.97k 缩写,% 为已乘 100 的百分数
 */
export type LoopYUnit = "$" | "%" | "count" | "ratio" | "none";
/**
 * 研究图表模板(research/loop/charts.ts):由回测报告确定性生成
 */
export type LoopChartTemplate =
  | "equity_comparison"
  | "drawdown_comparison"
  | "exit_reason_pnl"
  | "asset_pnl"
  | "trade_scatter"
  | "monthly_heatmap"
  | "strategies_equity"
  | "strategies_drawdown";
export type LoopRefs = string[];
export type LoopConceptStatus = "mapped" | "acquired" | "proxy" | "unmapped";
export type LoopConceptCategory =
  "indicator" | "pattern" | "structure" | "data_metric" | "comparison" | "timeframe" | "asset" | "risk";
export type LoopConceptSource = "primitive_registry" | "lexicon" | "data_catalog" | "acquired" | "none";
export type LoopStatus =
  | "queued"
  | "planning"
  | "running"
  | "validating"
  | "completed"
  | "awaiting_input"
  | "cancelling"
  | "cancelled"
  | "failed"
  | "incomplete";
export type LoopBlocks = (
  | {
      kind: "text";
      text: string;
    }
  | {
      kind: "next_question";
      text: string;
    }
  | {
      kind: "chart_ref" | "table_ref" | "report_ref" | "comparison_ref";
      artifact_id: string;
      /**
       * 这张图的一句说明(模型写的不得含数字;模板写的由代码从报告算出)
       */
      caption?: string;
    }
  | {
      kind: "step_ref";
      step_id: string;
    }
  | {
      kind: "strategy_ref";
      run_id: string;
    }
  | {
      kind: "data_gap";
      metric: string;
      availability: LoopAvailability;
      note: string;
    }
  | {
      kind: "run_status";
      inquiry_id: string;
      status: LoopStatus;
    }
  | {
      kind: "plan";
      task_kind: LoopTaskKind;
      steps: {
        key: string;
        title: string;
        tool: string;
        status: "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
      }[];
    }
)[];
export type LoopErrorCode =
  | "UNSUPPORTED_ASSET"
  | "DATA_MISSING"
  | "DATA_STALE"
  | "RATE_LIMIT"
  | "BUDGET_EXHAUSTED"
  | "PROVIDER_ERROR"
  | "SCHEMA_MISMATCH"
  | "UNIT_MISMATCH"
  | "NOT_COMPARABLE"
  | "CANCELLED"
  | "TIMEOUT";
export type ResearchOrders = BacktestReplay | BacktestPlan;
export type ResearchStrategyObject = ResearchStrategyList | ResearchStrategyDetail;
export type ResearchStrategyStatus = "draft" | "backtested" | "paper" | "live" | "published" | "archived";
export type ResearchStrategyEventKind =
  | "created"
  | "version_added"
  | "backtested"
  | "transition"
  | "renamed"
  | "flag_changed"
  | "archived"
  | "session_attached";
/**
 *  IR v1 不加字段、不改哈希；v2 必须含 judge，只有订单执行核支持 judge。
 */
export type ResearchContract =
  | ResearchRequest
  | ResearchDataset
  | ResearchFilterDecision
  | ResearchChatRequest
  | ResearchToolCall
  | ResearchStudy
  | ResearchPolicy
  | ResearchUniverseRequest
  | ResearchUniverse
  | ResearchScreen
  | ResearchFactorResult
  | ResearchTrend
  | StrategyIR
  | StrategyCompileRequest
  | StrategyCompileResult
  | ResearchAttribution
  | ResearchRecordedDecision
  | ResearchPrecheckRequest;
export type ResearchRequest = {
  [k: string]: unknown;
} & ResearchRequest1;
export type ResearchUniverseRequest = ResearchUniverseRequest1 & ResearchUniverseRequest2;
export type ResearchUniverseRequest1 = {
  [k: string]: unknown;
};
export type StrategyCompileRequest = StrategyCompileRequest1 & StrategyCompileRequest2;
export type StrategyCompileRequest1 = {
  [k: string]: unknown;
};
export type ResearchPrecheckRequest = ResearchPrecheckRequest1 & ResearchPrecheckRequest2;
export type ResearchPrecheckRequest1 = {
  [k: string]: unknown;
};
/**
 * gateway ↔ execd 的 UDS 契约:JSON-RPC 2.0,每帧一行(newline-delimited,UTF-8,单帧 ≤ 4 MiB)。execd 监听 ~/.trading-swarm/run/execd.sock(0600)。请求方法见 Method;execd → gateway 的通知只有 exec.event。错误码映射见 tables/error_codes.json。
 */
export type ExecutionServiceRpc = RpcRequest | RpcSuccess | RpcFailure | RpcNotification;
export type RpcId = string | number;
export type Method =
  | "exec.health"
  | "exec.intent.propose"
  | "exec.intent.get"
  | "exec.intent.list"
  | "exec.intent.authorize"
  | "exec.intent.reject"
  | "exec.account.snapshot"
  | "exec.exchange.status"
  | "exec.policy.get"
  | "exec.policy.set"
  | "exec.emergency_stop"
  | "exec.events.subscribe"
  | "exec.oauth.start"
  | "exec.oauth.status"
  | "exec.oauth.revoke"
  | "exec.credentials.public_key"
  | "exec.credentials.set"
  | "exec.credentials.status";
export type OauthState = "missing" | "fresh" | "expiring" | "expired" | "revoked";

/**
 * 账户真相(设计 §6.2 account.truth / external review #6):每个组件各自 observed_at、取数区间、completeness;经济组件哈希 = account_version;组件缺失或跨度过大 → inconsistent(gate 拒开仓);不可得 → unavailable。
 */
export interface AccountSnapshot {
  schema_version: SchemaVersion;
  account: AccountRef;
  channel: Channel;
  computed_at: TimestampMs;
  consistency: Consistency;
  consistency_reason?: string;
  account_version?: Hash256;
  /**
   * 各必需组件 observed_at 的最大差
   */
  span_ms?: number;
  components: {
    balances: BalancesComponent;
    positions: PositionsComponent;
    open_orders: OrdersComponent;
    position_mode: PositionModeComponent;
    recent_fills?: FillsComponent;
    order_history?: OrdersComponent;
    margin?: MarginComponent;
  };
  summary?: AccountSummary;
}
export interface BalancesComponent {
  observed_at: TimestampMs;
  fetched_from: TimestampMs;
  fetched_to: TimestampMs;
  completeness: Completeness;
  source: ObservationSource;
  error?: ErrorInfo;
  data?: BalanceRow[];
}
export interface ErrorInfo {
  kind: ErrorKind;
  message: string;
  retryable: boolean;
  /**
   * 交易所错误码(如 Binance -2021),有则带
   */
  exchange_code?: number;
  http_status?: number;
}
export interface BalanceRow {
  asset: Asset;
  wallet: Wallet;
  wallet_balance: Decimal;
  available: Decimal;
  unrealized_pnl?: Decimal;
}
export interface PositionsComponent {
  observed_at: TimestampMs;
  fetched_from: TimestampMs;
  fetched_to: TimestampMs;
  completeness: Completeness;
  source: ObservationSource;
  error?: ErrorInfo;
  data?: PositionRow[];
}
export interface PositionRow {
  symbol: Symbol;
  product: Product;
  position_side: PositionSide;
  qty: Decimal;
  entry_price: UnsignedDecimal;
  mark_price?: UnsignedDecimal;
  unrealized_pnl?: Decimal;
  leverage?: number;
  margin_type?: MarginType;
  isolated_margin?: Decimal;
  liquidation_price?: UnsignedDecimal;
  notional?: Decimal;
  exchange_update_time?: TimestampMs;
}
export interface OrdersComponent {
  observed_at: TimestampMs;
  fetched_from: TimestampMs;
  fetched_to: TimestampMs;
  completeness: Completeness;
  source: ObservationSource;
  error?: ErrorInfo;
  data?: OrderRow[];
}
export interface OrderRow {
  exchange_order_id: string;
  client_order_id?: ClientOrderId;
  symbol: Symbol;
  product: Product;
  side: Side;
  position_side: PositionSide;
  order_type: OrderType;
  status: ExchangeOrderStatus;
  orig_qty: UnsignedDecimal;
  executed_qty: UnsignedDecimal;
  avg_price?: UnsignedDecimal;
  price?: UnsignedDecimal;
  stop_price?: UnsignedDecimal;
  reduce_only: boolean;
  close_position?: boolean;
  time_in_force?: TimeInForce;
  working_type?: WorkingType;
  origin: OrderOrigin;
  exchange_update_time?: TimestampMs;
  exchange_create_time?: TimestampMs;
}
export interface PositionModeComponent {
  observed_at: TimestampMs;
  fetched_from: TimestampMs;
  fetched_to: TimestampMs;
  completeness: Completeness;
  source: ObservationSource;
  error?: ErrorInfo;
  data?: {
    mode: PositionMode;
  };
}
export interface FillsComponent {
  observed_at: TimestampMs;
  fetched_from: TimestampMs;
  fetched_to: TimestampMs;
  completeness: Completeness;
  source: ObservationSource;
  error?: ErrorInfo;
  data?: FillRow[];
}
export interface FillRow {
  trade_id: string;
  exchange_order_id: string;
  client_order_id?: ClientOrderId;
  symbol: Symbol;
  product: Product;
  side: Side;
  position_side?: PositionSide;
  qty: UnsignedDecimal;
  price: UnsignedDecimal;
  quote_qty?: UnsignedDecimal;
  commission?: Decimal;
  commission_asset?: Asset;
  realized_pnl?: Decimal;
  is_maker?: boolean;
  trade_time: TimestampMs;
}
export interface MarginComponent {
  observed_at: TimestampMs;
  fetched_from: TimestampMs;
  fetched_to: TimestampMs;
  completeness: Completeness;
  source: ObservationSource;
  error?: ErrorInfo;
  data?: MarginInfo;
}
export interface MarginInfo {
  margin_ratio?: UnsignedDecimal;
  maintenance_margin?: UnsignedDecimal;
  margin_balance?: Decimal;
  available_balance?: Decimal;
}
export interface AccountSummary {
  quote_asset: Asset;
  wallet_balance: Decimal;
  margin_balance?: Decimal;
  available_balance: Decimal;
  unrealized_pnl: Decimal;
  today_realized_pnl?: Decimal;
  open_position_count: number;
  open_order_count: number;
}
/**
 * 一次对交易所的写调用(设计 §5.1)。clientOrderId 与完整订单指纹在调用前持久化(stage=before_submit);同 id 重发必须是交易所级幂等,否则不重发;结果 unknown 非终态,由 reconciler 按 clientOrderId 收敛。
 */
export interface ExecutionAttempt {
  schema_version: SchemaVersion;
  attempt_id: Uuid;
  intent_id: Uuid;
  plan_id: Uuid;
  plan_hash: Hash256;
  attempt_no: number;
  leg: Leg;
  /**
   * 同类腿的序号,如第 2 个止盈腿
   */
  leg_index: number;
  account: AccountRef;
  channel: Channel;
  client_order_id: ClientOrderId;
  /**
   * canonical_json(实际发送给交易所的参数,脱敏)——对账时与交易所回显逐字比对
   */
  order_fingerprint: string;
  writer_instance_id: string;
  lease_epoch: number;
  fencing_token: string;
  stage: AttemptStage;
  result: AttemptResult;
  created_at: TimestampMs;
  submitted_at?: TimestampMs;
  deadline_at: TimestampMs;
  result_at?: TimestampMs;
  exchange_order_id?: string;
  /**
   * 非订单类效果的交易所引用,如 transfer 的 tranId
   */
  exchange_ref?: string;
  error?: ErrorInfo;
  /**
   * MCP 通道:实际调用的工具名(来自钉版快照)
   */
  tool_name?: string;
  tools_hash?: Hash256;
}
/**
 * 对某个 plan_hash 的授权(设计 §5.1)。by=user 需要 confirm_echo(结构化确认:审批面逐字回填关键字段,execd 与 plan 派生的 confirm_fields 逐字比对);by=policy 只在 LiveCapped 且上限内出现(v1 feature-gate 关闭)。
 */
export interface Authorization {
  schema_version: SchemaVersion;
  authorization_id: Uuid;
  intent_id: Uuid;
  plan_id: Uuid;
  plan_hash: Hash256;
  by: "user" | "policy";
  principal?: Principal;
  surface?: Surface;
  /**
   * 谁批的:设备/会话/RPC 连接标识;by=policy 时为 policy 版本
   */
  actor_ref?: string;
  status: AuthorizationStatus;
  status_reason?: string;
  /**
   * 审批面回填的字段(见 docs/contracts/README.md「confirm_fields」);by=user 必填
   */
  confirm_echo?: {
    [k: string]: string;
  };
  granted_at: TimestampMs;
  expires_at: TimestampMs;
  consumed_at?: TimestampMs;
  consumed_by_attempt_id?: Uuid;
}
export interface GateRejection {
  /**
   * 闸名,如 policy.mode / freshness.account / risk.max_leverage
   */
  gate: string;
  /**
   * 被拒时的实际值(字符串化)
   */
  value?: string;
  /**
   * 阈值(字符串化)
   */
  limit?: string;
  message: string;
}
/**
 * Portfolio Manager 典型止损容量估算；不是执行授权。金额为十进制字符串，不能计算的字段显式 null。
 */
export interface DemoPortfolioCapacity {
  schema_version: 1;
  snapshot_id: string;
  computed_at: number;
  basis: "typical_stop_estimate";
  snapshot_quality: "ok" | "stale" | "inconsistent" | "incomplete";
  equity: string | null;
  available: string | null;
  risk_pct: string;
  leverage: number;
  default_stop_distance_pct: string;
  slots_total: number;
  slots_used: number;
  slots_free: number;
  margin_budget: DemoCapacityMargin;
  binding_constraint: DemoCapacityConstraint;
  by_symbol: DemoSymbolCapacity[];
}
export interface DemoCapacityMargin {
  max_margin_ratio: number;
  limit_usdt: string | null;
  committed_usdt: string | null;
  reserved_usdt: string | null;
  free_usdt: string | null;
  required_for_free_slots_usdt: string | null;
  slots_supported: number | null;
  witness_symbols: string[];
}
export interface DemoSymbolCapacity {
  symbol: string;
  verdict: "ok" | "needs_equity" | "rules_unknown" | "unavailable";
  watch_only: boolean;
  occupied: boolean;
  price: string | null;
  rules_source: "exchange" | "paper" | null;
  rules_observed_at: number | null;
  stop_distance_pct: string | null;
  stop_source: "atr" | "default" | null;
  min_qty: string | null;
  min_viable_notional: string | null;
  min_size_risk: string | null;
  required_equity: string | null;
  equity_shortfall: string | null;
  margin_per_thread: string | null;
  risk_budget: string | null;
  budget_margin_per_thread: string | null;
}
/**
 * execd 发出的事件(UDS 通知 exec.event,同时落 exec.sqlite events 表,seq 单调,支持 since_seq 回放)。gateway 把它桥接到自己的事件总线与 events 表——'事件即审计'口径(设计 §4)。
 */
export interface ExecEvent {
  schema_version: SchemaVersion;
  seq: number;
  event: EventName;
  at: TimestampMs;
  account?: AccountRef;
  intent_id?: Uuid;
  plan_id?: Uuid;
  attempt_id?: Uuid;
  symbol?: Symbol;
  /**
   * 事件专属载荷(通常是对应记录本身或其差分)
   */
  payload: {};
}
/**
 * 交易所订单的观察值(设计 §5.1):不可变、按 observed_at 追加;订单状态从最新观察派生。同一 exchange_order_id 的观察序列必须满足 transitions/exchange_order_status.json 的单调性,否则标 ORDER_STATE_UNKNOWN。
 */
export interface ExchangeOrderObservation {
  schema_version: SchemaVersion;
  observation_id: Uuid;
  account: AccountRef;
  channel: Channel;
  source: ObservationSource;
  product: Product;
  symbol: Symbol;
  exchange_order_id: string;
  client_order_id?: ClientOrderId;
  status: ExchangeOrderStatus;
  side: Side;
  position_side: PositionSide;
  order_type: OrderType;
  orig_qty: UnsignedDecimal;
  executed_qty: UnsignedDecimal;
  avg_price?: UnsignedDecimal;
  price?: UnsignedDecimal;
  stop_price?: UnsignedDecimal;
  cum_quote?: UnsignedDecimal;
  reduce_only: boolean;
  close_position?: boolean;
  time_in_force?: TimeInForce;
  working_type?: WorkingType;
  origin: OrderOrigin;
  attempt_id?: Uuid;
  exchange_update_time?: TimestampMs;
  exchange_create_time?: TimestampMs;
  observed_at: TimestampMs;
  raw_hash?: Hash256;
}
/**
 * 成交观察值(设计 §5.1),不可变;(account, exchange_order_id, trade_id) 唯一。
 */
export interface Fill {
  schema_version: SchemaVersion;
  fill_id: Uuid;
  account: AccountRef;
  channel: Channel;
  source: ObservationSource;
  product: Product;
  symbol: Symbol;
  exchange_order_id: string;
  trade_id: string;
  client_order_id?: ClientOrderId;
  attempt_id?: Uuid;
  side: Side;
  position_side?: PositionSide;
  qty: UnsignedDecimal;
  price: UnsignedDecimal;
  quote_qty?: UnsignedDecimal;
  commission?: Decimal;
  commission_asset?: Asset;
  realized_pnl?: Decimal;
  is_maker?: boolean;
  trade_time: TimestampMs;
  observed_at: TimestampMs;
}
/**
 * 动钱的唯一提议记录(设计 §5.1)。模型/UI/Exit DSL 只能提议;经济字段在 ExecutableOrderPlan 里物化并哈希;状态只按 transitions/intent_status.json 迁移。
 */
export interface Intent {
  schema_version: SchemaVersion;
  intent_id: Uuid;
  account: AccountRef;
  principal: Principal;
  surface: Surface;
  session_id?: string;
  run_id?: string;
  /**
   * 来源说明,如 recipe:w4-judgment / ui:trade-page / exit-dsl:thread-42
   */
  origin?: string;
  /**
   * 提议方幂等键;execd 按 (principal, idempotency_key) 去重,同键不同内容 = corruption
   */
  idempotency_key?: string;
  params: IntentParams;
  status: IntentStatus;
  status_reason?: string;
  /**
   * 每次闸拒都追加,不覆盖
   */
  gate_rejections: GateRejection[];
  current_plan_id?: Uuid;
  authorization_id?: Uuid;
  /**
   * 提议有效期;到期未进入 authorized 即 expired
   */
  ttl_seconds: number;
  created_at: TimestampMs;
  updated_at: TimestampMs;
  expires_at?: TimestampMs;
  terminal_at?: TimestampMs;
}
export interface OpenParams {
  kind: "open";
  product: Product;
  symbol: Symbol;
  side: Side;
  position_side?: PositionSide;
  size: SizeSpec;
  entry: EntrySpec;
  stop: StopRef;
  /**
   * @maxItems 4
   */
  take_profits?:
    | []
    | [TakeProfitSpec]
    | [TakeProfitSpec, TakeProfitSpec]
    | [TakeProfitSpec, TakeProfitSpec, TakeProfitSpec]
    | [TakeProfitSpec, TakeProfitSpec, TakeProfitSpec, TakeProfitSpec];
  leverage?: number;
  margin_type?: MarginType;
  thesis?: string;
  /**
   * 必须 ⊆ 本轮/上一轮 evidence registry(设计 §7.3);用户手动单可为空数组
   */
  evidence_refs: string[];
  invalidation?: string;
}
export interface StopRef {
  price: UnsignedDecimal;
  trigger: WorkingType;
}
export interface TakeProfitSpec {
  price: UnsignedDecimal;
  pct: UnsignedDecimal;
  trigger?: WorkingType;
}
export interface CloseParams {
  kind: "close";
  product: Product;
  symbol: Symbol;
  position_side?: PositionSide;
  pct: UnsignedDecimal;
  order: EntrySpec;
  reason?: string;
  evidence_refs?: string[];
}
export interface CancelOrderParams {
  kind: "cancel_order";
  product: Product;
  symbol: Symbol;
  order_ref: OrderRef;
  reason?: string;
}
export interface OrderRef {
  exchange_order_id?: string;
  client_order_id?: ClientOrderId;
}
export interface ProtectParams {
  kind: "protect";
  product: Product;
  symbol: Symbol;
  position_side?: PositionSide;
  stop?: StopRef;
  /**
   * @maxItems 4
   */
  take_profits?:
    | []
    | [TakeProfitSpec]
    | [TakeProfitSpec, TakeProfitSpec]
    | [TakeProfitSpec, TakeProfitSpec, TakeProfitSpec]
    | [TakeProfitSpec, TakeProfitSpec, TakeProfitSpec, TakeProfitSpec];
  /**
   * true=撤掉本机已有保护腿后重挂;false=只补缺
   */
  replace: boolean;
  reason?: string;
}
/**
 * 只允许 principal=user 且 surface=rpc;agent 没有任何划转工具(设计 §3.5)。提币不在 v1 契约内(§16 Q7,延后到 Jacky 拍板 + IP 白名单)。
 */
export interface TransferParams {
  kind: "transfer";
  asset: Asset;
  amount: UnsignedDecimal;
  from_account: AccountRef;
  from_wallet: Wallet;
  to_account: AccountRef;
  to_wallet: Wallet;
  reason?: string;
}
/**
 * 审批前物化的可执行计划(设计 §5.1)。审批绑定的是 plan_hash = sha256(canonical_json(economic));basis 不进哈希。重闸只能拒绝,不能改 economic;经济字段实质变化 → 新 plan(version+1)+ 作废旧授权。
 */
export interface ExecutableOrderPlan {
  schema_version: SchemaVersion;
  plan_id: Uuid;
  intent_id: Uuid;
  version: number;
  plan_hash: Hash256;
  account: AccountRef;
  channel: Channel;
  economic: PlanEconomics;
  basis: PlanBasis;
  /**
   * 授权有效期:市价 30s / 限价 120s(设计 §10.3)
   */
  authorization_ttl_seconds: number;
  created_at: TimestampMs;
  expires_at: TimestampMs;
}
/**
 * open / close 两类 intent 的计划;close 时 reduce_only=true 且 protection 为空
 */
export interface OrderEconomics {
  kind: "order";
  product: Product;
  symbol: Symbol;
  side: Side;
  position_side: PositionSide;
  position_mode: PositionMode;
  order_type: OrderType;
  qty: UnsignedDecimal;
  price?: UnsignedDecimal;
  time_in_force?: TimeInForce;
  reduce_only: boolean;
  close_position: boolean;
  leverage?: number;
  margin_type?: MarginType;
  trigger_price?: UnsignedDecimal;
  working_type?: WorkingType;
  protection: Protection;
  /**
   * 首笔成交后保护腿必须在此秒数内确认在交易所,否则补偿平仓(设计 §5.4,默认 20)
   */
  max_naked_seconds: number;
}
export interface Protection {
  stop?: ProtectionLeg;
  /**
   * @maxItems 4
   */
  take_profits:
    | []
    | [ProtectionLeg]
    | [ProtectionLeg, ProtectionLeg]
    | [ProtectionLeg, ProtectionLeg, ProtectionLeg]
    | [ProtectionLeg, ProtectionLeg, ProtectionLeg, ProtectionLeg];
}
/**
 * 交易所原生保护腿;永远 reduce-only(执行层强制,不作为字段)
 */
export interface ProtectionLeg {
  order_type: "stop_market" | "stop_limit" | "take_profit_market" | "take_profit_limit";
  trigger_price: UnsignedDecimal;
  price?: UnsignedDecimal;
  qty?: UnsignedDecimal;
  working_type: WorkingType;
  close_position: boolean;
}
export interface ProtectEconomics {
  kind: "protect";
  product: Product;
  symbol: Symbol;
  position_side: PositionSide;
  /**
   * @minItems 1
   * @maxItems 5
   */
  legs:
    | [ProtectionLeg]
    | [ProtectionLeg, ProtectionLeg]
    | [ProtectionLeg, ProtectionLeg, ProtectionLeg]
    | [ProtectionLeg, ProtectionLeg, ProtectionLeg, ProtectionLeg]
    | [ProtectionLeg, ProtectionLeg, ProtectionLeg, ProtectionLeg, ProtectionLeg];
  /**
   * 先撤再挂的本机保护单 exchange_order_id 列表(replace=false 时为空)
   */
  replace_order_ids: string[];
}
export interface CancelEconomics2 {
  kind: "cancel";
  product: Product;
  symbol: Symbol;
  exchange_order_id?: string;
  client_order_id?: ClientOrderId;
}
export interface TransferEconomics {
  kind: "transfer";
  asset: Asset;
  amount: UnsignedDecimal;
  from_account: AccountRef;
  from_wallet: Wallet;
  to_account: AccountRef;
  to_wallet: Wallet;
}
/**
 * 物化依据,给 UI/审计看;不进 plan_hash
 */
export interface PlanBasis {
  filters?: SymbolFilters;
  sizing?: SizingBasis;
  account_version?: Hash256;
  market_ref?: MarketRef;
  position_mode_observed?: PositionMode;
  policy_version?: number;
  notes: string[];
}
export interface SymbolFilters {
  tick_size: UnsignedDecimal;
  step_size: UnsignedDecimal;
  min_qty: UnsignedDecimal;
  max_qty?: UnsignedDecimal;
  min_notional: UnsignedDecimal;
  price_precision?: number;
  qty_precision?: number;
  observed_at: TimestampMs;
}
export interface SizingBasis {
  method: "risk_pct_by_stop_distance" | "explicit_qty" | "explicit_notional" | "pct_of_position";
  equity?: UnsignedDecimal;
  risk_pct?: UnsignedDecimal;
  stop_distance?: UnsignedDecimal;
  reference_price?: UnsignedDecimal;
  position_qty_before?: Decimal;
  raw_qty: UnsignedDecimal;
  rounding: "down";
}
export interface MarketRef {
  mark_price?: UnsignedDecimal;
  last_price?: UnsignedDecimal;
  observed_at: TimestampMs;
}
/**
 * execd 持有的 policy 子集(设计 §10):模式、authority、上限。gateway 的 gate v2 与 execd 的重闸读同一份;改动需 policy.set + confirm 回填。金丝雀期默认值取评审建议的保守值(§17.2),向导里显式输入。
 */
export interface ExecPolicy {
  schema_version: SchemaVersion;
  version: number;
  updated_at: TimestampMs;
  mode: PolicyMode;
  authority: Authority;
  emergency_stop: boolean;
  /**
   * feature gate;v1 保持 false,延后到 §16 Q6(Binance 对 standing authorization 的书面口径)解决
   */
  live_capped_enabled: boolean;
  symbol_allowlist: Symbol[];
  product_allowlist: Product[];
  caps: Caps;
  main_account: MainAccountPolicy;
  canary: CanaryPolicy;
}
export interface Caps {
  max_leverage: number;
  risk_pct_per_trade: UnsignedDecimal;
  max_order_notional: UnsignedDecimal;
  max_position_notional: UnsignedDecimal;
  /**
   * 金丝雀期默认 2,之后 6
   */
  max_daily_opens: number;
  daily_loss_stop_pct: UnsignedDecimal;
  /**
   * 默认 3600
   */
  symbol_cooldown_seconds: number;
  /**
   * 默认 20
   */
  max_naked_seconds: number;
  /**
   * 默认 15000
   */
  account_truth_max_age_ms: number;
  /**
   * 默认 5000
   */
  market_max_age_ms: number;
  /**
   * 默认 30
   */
  authorization_ttl_market_seconds: number;
  /**
   * 默认 120
   */
  authorization_ttl_limit_seconds: number;
  /**
   * 下单价 vs 现价偏离上限
   */
  max_price_deviation_bps: number;
  /**
   * 默认 2000:超过禁新增风险
   */
  ntp_drift_block_ms: number;
  /**
   * 默认 10000:超过 HALT
   */
  ntp_drift_halt_ms: number;
}
export interface MainAccountPolicy {
  manual_trading_enabled: boolean;
  /**
   * main↔sub 划转(A1 验证可行后才开)
   */
  transfers_enabled: boolean;
  /**
   * v1 恒 false(§16 Q7 默认不勾提币;提币走 Binance UI 深链)
   */
  withdraw_enabled: false;
}
export interface CanaryPolicy {
  enabled: boolean;
  max_loss_quote?: UnsignedDecimal;
  max_notional_quote?: UnsignedDecimal;
  max_leverage?: number;
  funded_balance_quote?: UnsignedDecimal;
}
/**
 * intent 的经济完成定义(设计 §5.1):开仓=目标数量成交且剩余已撤且保护腿已确认在交易所;平仓=数量核实;保护=腿存在;撤单=订单终态;划转=交易所回执可查。由 reconciler 按读派生并落库,intent 只在 status=satisfied 时才 completed。
 */
export interface PositionEffect {
  schema_version: SchemaVersion;
  effect_id: Uuid;
  intent_id: Uuid;
  plan_id: Uuid;
  kind: IntentKind;
  account: AccountRef;
  symbol?: Symbol;
  status: EffectStatus;
  target_qty?: UnsignedDecimal;
  filled_qty: UnsignedDecimal;
  remaining_qty: UnsignedDecimal;
  /**
   * 未成交部分是否已确认撤销(或本就无剩余)
   */
  remaining_canceled: boolean;
  avg_fill_price?: UnsignedDecimal;
  first_fill_at?: TimestampMs;
  protection_required: boolean;
  protection_confirmed: boolean;
  protection_confirmed_at?: TimestampMs;
  protection_order_ids: string[];
  /**
   * 首笔成交到保护腿确认(或到现在)的秒数
   */
  naked_seconds?: number;
  compensation_close_attempt_id?: Uuid;
  position_qty_after?: Decimal;
  exchange_ref?: string;
  failure_reason?: string;
  evaluated_at: TimestampMs;
}
export interface BacktestReport {
  id: string;
  created_at: number;
  engine_version: string;
  title: string;
  description: string;
  strategy_ir_hash: string;
  strategy_ir: StrategyIR;
  timeframe: string;
  window: {
    from_ms: number;
    to_ms: number;
  };
  /**
   * @maxItems 8
   */
  segments:
    | []
    | [BacktestSegment]
    | [BacktestSegment, BacktestSegment]
    | [BacktestSegment, BacktestSegment, BacktestSegment]
    | [BacktestSegment, BacktestSegment, BacktestSegment, BacktestSegment]
    | [BacktestSegment, BacktestSegment, BacktestSegment, BacktestSegment, BacktestSegment]
    | [BacktestSegment, BacktestSegment, BacktestSegment, BacktestSegment, BacktestSegment, BacktestSegment]
    | [
        BacktestSegment,
        BacktestSegment,
        BacktestSegment,
        BacktestSegment,
        BacktestSegment,
        BacktestSegment,
        BacktestSegment
      ]
    | [
        BacktestSegment,
        BacktestSegment,
        BacktestSegment,
        BacktestSegment,
        BacktestSegment,
        BacktestSegment,
        BacktestSegment,
        BacktestSegment
      ];
  execution: BacktestExecution;
  primary_key: string;
  /**
   * @maxItems 16
   */
  assets:
    | []
    | [BacktestAsset]
    | [BacktestAsset, BacktestAsset]
    | [BacktestAsset, BacktestAsset, BacktestAsset]
    | [BacktestAsset, BacktestAsset, BacktestAsset, BacktestAsset]
    | [BacktestAsset, BacktestAsset, BacktestAsset, BacktestAsset, BacktestAsset]
    | [BacktestAsset, BacktestAsset, BacktestAsset, BacktestAsset, BacktestAsset, BacktestAsset]
    | [BacktestAsset, BacktestAsset, BacktestAsset, BacktestAsset, BacktestAsset, BacktestAsset, BacktestAsset]
    | [
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset
      ]
    | [
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset
      ]
    | [
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset
      ]
    | [
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset
      ]
    | [
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset
      ]
    | [
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset
      ]
    | [
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset
      ]
    | [
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset
      ]
    | [
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset,
        BacktestAsset
      ];
  score: BacktestScore;
  /**
   * @maxItems 32
   */
  run_ids: string[];
  inquiry_id: string | null;
  session_id: string | null;
  strategy_id: string | null;
  strategy_version: number | null;
  /**
   * @maxItems 64
   */
  warnings: string[];
}
export interface StrategyIR1 {
  version: 1 | 2;
  label: string;
  description: string;
  universe?: {
    screen: {
      /**
       * @maxItems 30
       */
      require_trend?: ("up" | "down" | "range")[];
      min_residual_sharpe?: number;
      max_beta?: number;
      top_n?: number;
    };
  };
  /**
   * @minItems 1
   * @maxItems 30
   */
  signal: [StrategyPrimitive, ...StrategyPrimitive[]];
  entry: StrategyPrimitive;
  risk: {
    stop: StrategyPrimitive;
    sizing: StrategyPrimitive;
  };
  /**
   * 带 order 块且给了止盈(order.take_profits)时可以为空:止损 + 多档止盈就是完整出场周期;不带 order 块时 checkIR 的 state_machine 仍要求走势跟踪出场或信号离场
   *
   * @minItems 0
   * @maxItems 30
   */
  exit: StrategyPrimitive[];
  regime?: StrategyPrimitive;
  compatibility?: "donchian_close_long_v1";
  order?: StrategyOrder;
  judge?: StrategyJudge;
}
export interface StrategyPrimitive {
  primitive: string;
  params: {
    [k: string]: unknown;
  };
  optional?: boolean;
}
/**
 * 可选的订单周期块。有它时回测按「计划 → 限价/市价 → 止损 + 多档止盈 → 结转/加仓/反手」逐单模拟,并出 K 线回放;没有它时行为与旧 IR 完全相同。止损仍用 risk.stop(做空时同一原语镜像到上方),止盈缺省=结构阻力(structure_target)单档
 */
export interface StrategyOrder {
  /**
   * short/both 仅限 market=perp;short 时 signal 就是做空条件;both 时 signal 做多、short_signal 做空
   */
  direction: "long" | "short" | "both";
  /**
   * spot 禁止做空与杠杆;perp 计资金费(8h 真实序列)与逐仓强平
   */
  market: "spot" | "perp";
  /**
   * 杠杆倍数,缺省 1;spot 必须为 1
   */
  leverage?: number;
  entry?: StrategyOrderEntry;
  /**
   * @minItems 1
   * @maxItems 5
   */
  take_profits?:
    | [StrategyOrderTakeProfit]
    | [StrategyOrderTakeProfit, StrategyOrderTakeProfit]
    | [StrategyOrderTakeProfit, StrategyOrderTakeProfit, StrategyOrderTakeProfit]
    | [StrategyOrderTakeProfit, StrategyOrderTakeProfit, StrategyOrderTakeProfit, StrategyOrderTakeProfit]
    | [
        StrategyOrderTakeProfit,
        StrategyOrderTakeProfit,
        StrategyOrderTakeProfit,
        StrategyOrderTakeProfit,
        StrategyOrderTakeProfit
      ];
  /**
   * 用户硬约束盈亏比:放置时加权止盈距离/止损距离低于它就不下单(计入 blocked 统计);缺省用策略规范的最小盈亏比
   */
  min_rr?: number;
  on_new_signal?: StrategyOrderOnNewSignal;
  /**
   * filled=add 时最多加仓腿数;每腿等权,首腿只占 1/(max_adds+1) 的仓位额度。缺省 2
   */
  max_adds?: number;
  /**
   * 周期上限:持仓满这么多根后下一根 open 按 time 出场;缺省取 exit 里 time_stop 的 bars
   */
  max_holding_bars?: number;
  /**
   * 首档止盈成交后把剩余仓位止损移到入场均价(8794 breakeven 口径),缺省 false
   */
  breakeven_after_tp?: boolean;
  /**
   * direction=both 时的做空条件(同一根 AND,按原文在真实 K 线上判定)
   *
   * @minItems 1
   * @maxItems 30
   */
  short_signal?: [StrategyPrimitive, ...StrategyPrimitive[]];
  short_regime?: StrategyPrimitive;
}
/**
 * 入场单:market=信号下一根 open 市价成交;limit=在 expiry_bars 根内触价才成交(开盘已越过按 open,钳制到当根),否则 no_fill
 */
export interface StrategyOrderEntry {
  type: "market" | "limit";
  price?: StrategyPrimitive;
  /**
   * 挂单时效(根);缺省按周期分档:≤1h 24 小时、≤3h 48 小时、≥4h 72 小时(对齐 8794)
   */
  expiry_bars?: number;
}
/**
 * 一档止盈:限价单,跳空按更优 open 成交
 */
export interface StrategyOrderTakeProfit {
  source: StrategyPrimitive;
  /**
   * 该档平掉的仓位比例,小数;各档缺省等权,合计不为 1 时按比例归一
   */
  size_pct?: number;
}
/**
 * 同一资产同向新信号到来时:unfilled=前一计划尚未成交(replace 整体替换 / keep 保留旧单);filled=已成交(roll 旧计划按下一根 open 结转、新计划的止损止盈接管仓位 / add 等权加仓腿 / ignore 忽略)。缺省 replace / roll(8794 v7/v8)
 */
export interface StrategyOrderOnNewSignal {
  unfilled?: "replace" | "keep";
  filled?: "roll" | "add" | "ignore";
}
export interface StrategyJudge {
  version: 1;
  engine: "jev" | "llm";
  model_profile_ref: string;
  state_schema_version: "judge_state_v1";
  /**
   * @minItems 1
   * @maxItems 8
   */
  questions:
    | [JudgeQuestion]
    | [JudgeQuestion, JudgeQuestion]
    | [JudgeQuestion, JudgeQuestion, JudgeQuestion]
    | [JudgeQuestion, JudgeQuestion, JudgeQuestion, JudgeQuestion]
    | [JudgeQuestion, JudgeQuestion, JudgeQuestion, JudgeQuestion, JudgeQuestion]
    | [JudgeQuestion, JudgeQuestion, JudgeQuestion, JudgeQuestion, JudgeQuestion, JudgeQuestion]
    | [JudgeQuestion, JudgeQuestion, JudgeQuestion, JudgeQuestion, JudgeQuestion, JudgeQuestion, JudgeQuestion]
    | [
        JudgeQuestion,
        JudgeQuestion,
        JudgeQuestion,
        JudgeQuestion,
        JudgeQuestion,
        JudgeQuestion,
        JudgeQuestion,
        JudgeQuestion
      ];
  rule: JudgeAllRule;
  on_uncertain: "skip";
  on_error: "skip";
  timeout_ms: number;
  max_attempts: 1;
}
export interface JudgeQuestion1 {
  key: string;
  type: "noul" | "choice" | "score";
  instructions: string;
  /**
   * @minItems 2
   * @maxItems 16
   */
  criteria:
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
  /**
   * @minItems 1
   * @maxItems 19
   */
  state_fields:
    | [JudgeStateField]
    | [JudgeStateField, JudgeStateField]
    | [JudgeStateField, JudgeStateField, JudgeStateField]
    | [JudgeStateField, JudgeStateField, JudgeStateField, JudgeStateField]
    | [JudgeStateField, JudgeStateField, JudgeStateField, JudgeStateField, JudgeStateField]
    | [JudgeStateField, JudgeStateField, JudgeStateField, JudgeStateField, JudgeStateField, JudgeStateField]
    | [
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField
      ]
    | [
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField
      ]
    | [
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField
      ]
    | [
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField
      ]
    | [
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField
      ]
    | [
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField
      ]
    | [
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField
      ]
    | [
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField
      ]
    | [
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField
      ]
    | [
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField
      ]
    | [
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField
      ]
    | [
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField
      ]
    | [
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField,
        JudgeStateField
      ];
  /**
   * @minItems 2
   * @maxItems 16
   */
  labels?:
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
}
export interface JudgeAllRule {
  /**
   * @minItems 1
   * @maxItems 16
   */
  all:
    | [JudgePredicate]
    | [JudgePredicate, JudgePredicate]
    | [JudgePredicate, JudgePredicate, JudgePredicate]
    | [JudgePredicate, JudgePredicate, JudgePredicate, JudgePredicate]
    | [JudgePredicate, JudgePredicate, JudgePredicate, JudgePredicate, JudgePredicate]
    | [JudgePredicate, JudgePredicate, JudgePredicate, JudgePredicate, JudgePredicate, JudgePredicate]
    | [JudgePredicate, JudgePredicate, JudgePredicate, JudgePredicate, JudgePredicate, JudgePredicate, JudgePredicate]
    | [
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate
      ]
    | [
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate
      ]
    | [
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate
      ]
    | [
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate
      ]
    | [
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate
      ]
    | [
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate
      ]
    | [
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate
      ]
    | [
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate
      ]
    | [
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate,
        JudgePredicate
      ];
}
export interface JudgePredicate {
  question_key: string;
  label: string;
  operator: "gte" | "lte";
  threshold: number;
  margin: number;
}
export interface BacktestSegment {
  name: BacktestSegmentName;
  from_ms: number;
  to_ms: number;
}
export interface BacktestExecution {
  initial_cash: number;
  fee_rate: number;
  slippage_bps: number;
  sizing_mode: string;
  fill_model: string;
  basket_weighting: string;
  market: OrderMarket;
  leverage: number;
  /**
   * 每根决策可见的历史长度口径
   */
  view_bars?: string;
}
export interface BacktestAsset {
  key: string;
  label: string;
  kind: BacktestAssetKind;
  /**
   * @maxItems 16
   */
  symbols:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
  status: BacktestAssetStatus;
  error: string | null;
  metrics: BacktestMetrics | null;
  /**
   * @maxItems 8
   */
  segments:
    | []
    | [BacktestSegmentMetrics]
    | [BacktestSegmentMetrics, BacktestSegmentMetrics]
    | [BacktestSegmentMetrics, BacktestSegmentMetrics, BacktestSegmentMetrics]
    | [BacktestSegmentMetrics, BacktestSegmentMetrics, BacktestSegmentMetrics, BacktestSegmentMetrics]
    | [
        BacktestSegmentMetrics,
        BacktestSegmentMetrics,
        BacktestSegmentMetrics,
        BacktestSegmentMetrics,
        BacktestSegmentMetrics
      ]
    | [
        BacktestSegmentMetrics,
        BacktestSegmentMetrics,
        BacktestSegmentMetrics,
        BacktestSegmentMetrics,
        BacktestSegmentMetrics,
        BacktestSegmentMetrics
      ]
    | [
        BacktestSegmentMetrics,
        BacktestSegmentMetrics,
        BacktestSegmentMetrics,
        BacktestSegmentMetrics,
        BacktestSegmentMetrics,
        BacktestSegmentMetrics,
        BacktestSegmentMetrics
      ]
    | [
        BacktestSegmentMetrics,
        BacktestSegmentMetrics,
        BacktestSegmentMetrics,
        BacktestSegmentMetrics,
        BacktestSegmentMetrics,
        BacktestSegmentMetrics,
        BacktestSegmentMetrics,
        BacktestSegmentMetrics
      ];
  /**
   * @maxItems 5000
   */
  equity: BacktestEquityPoint[];
  /**
   * @maxItems 20000
   */
  trades: BacktestTrade[];
  /**
   * @maxItems 2000
   */
  monthly_returns: BacktestPeriodReturn[];
  /**
   * @maxItems 200
   */
  yearly_returns: BacktestPeriodReturn[];
  trade_stats: BacktestTradeStats | null;
  data: BacktestDataProvenance | null;
  /**
   * 该资产的交易窗口(预热之后的首根决策 bar 收盘 → 最后一根已收盘 bar)
   */
  window?: {
    from_ms: number;
    to_ms: number;
  } | null;
  /**
   * 订单周期执行核(WP-F)产出的订单计划;默认执行器不产出
   *
   * @maxItems 20000
   */
  plans?: BacktestPlan[];
  plan_stats?: BacktestPlanStats | null;
  /**
   * 该资产执行器的口径版本
   */
  engine_version?: string;
  side_breakdown?: {
    long: BacktestSideStats;
    short: BacktestSideStats;
  };
  /**
   * @maxItems 16
   */
  per_symbol?:
    | []
    | [BacktestSymbolContribution]
    | [BacktestSymbolContribution, BacktestSymbolContribution]
    | [BacktestSymbolContribution, BacktestSymbolContribution, BacktestSymbolContribution]
    | [BacktestSymbolContribution, BacktestSymbolContribution, BacktestSymbolContribution, BacktestSymbolContribution]
    | [
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution
      ]
    | [
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution
      ]
    | [
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution
      ]
    | [
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution
      ]
    | [
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution
      ]
    | [
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution
      ]
    | [
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution
      ]
    | [
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution
      ]
    | [
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution
      ]
    | [
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution
      ]
    | [
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution
      ]
    | [
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution,
        BacktestSymbolContribution
      ];
  /**
   * UTC 日净值收益(最近 ≤3000 天)
   *
   * @maxItems 3000
   */
  daily_pnl?: BacktestDailyPnl[];
  capital_usage?: BacktestCapitalUsage | null;
  strategy_capacity?: BacktestCapacity | null;
}
export interface BacktestMetrics {
  /**
   * 窗口总收益,小数
   */
  total_return: number;
  /**
   * 年化复合收益(365 天),窗口<30 天为 null
   */
  cagr: number | null;
  /**
   * 最大回撤,正数小数
   */
  max_drawdown: number;
  /**
   * 日收益 Sharpe×√365,rf=0;日收益<30 为 null
   */
  sharpe: number | null;
  /**
   * 下行偏差 sqrt(Σmin(r,0)²/N) 口径
   */
  sortino: number | null;
  /**
   * cagr / max_drawdown
   */
  calmar: number | null;
  /**
   * 日收益标准差×√365
   */
  volatility: number | null;
  /**
   * 已平仓位胜率
   */
  win_rate: number | null;
  /**
   * 盈利合计/|亏损合计|,无亏损为 null
   */
  profit_factor: number | null;
  /**
   * 盈利仓位平均单笔收益(净盈亏/入场名义),小数
   */
  avg_win: number | null;
  /**
   * 亏损仓位平均单笔收益,负数小数
   */
  avg_loss: number | null;
  /**
   * avg_win/|avg_loss|
   */
  risk_reward: number | null;
  /**
   * 全部仓位平均单笔收益,小数
   */
  expectancy: number | null;
  max_win_streak: number;
  max_loss_streak: number;
  /**
   * 净值低于前高的时间占比
   */
  time_in_drawdown: number;
  /**
   * 前高到收复(或窗口末)的最长时长
   */
  max_drawdown_duration_ms: number;
  /**
   * 已平仓位数(同一仓位多次减仓合并)
   */
  trades: number;
  /**
   * 持仓市值/净值 的逐根均值
   */
  exposure: number;
  /**
   * 平均持仓时长
   */
  avg_holding_ms: number | null;
  /**
   * 最好单笔收益,小数
   */
  best_trade: number | null;
  /**
   * 最差单笔收益,小数
   */
  worst_trade: number | null;
  /**
   * 净盈亏,报价币(USDT)
   */
  net_pnl: number;
  /**
   * 实付手续费,报价币
   */
  fees: number;
  /**
   * 同窗口买入持有收益(含同样费用与滑点)
   */
  benchmark_return: number | null;
  /**
   * total_return - benchmark_return
   */
  excess_return: number | null;
  /**
   * 对基准日收益 OLS 截距×365
   */
  alpha: number | null;
  /**
   * 对基准日收益 OLS 斜率
   */
  beta: number | null;
  /**
   * 有持仓的 bar 占比
   */
  time_in_market: number;
}
export interface BacktestSegmentMetrics {
  name: BacktestSegmentName;
  from_ms: number;
  to_ms: number;
  metrics: BacktestMetrics;
}
export interface BacktestEquityPoint {
  at: number;
  equity: number;
  pnl_pct: number;
  drawdown: number;
  benchmark_pct: number | null;
  exposure: number;
}
export interface BacktestTrade {
  id: string;
  symbol: string;
  side: "long" | "short";
  entry_at: number;
  entry_price: number;
  exit_at: number;
  exit_price: number;
  qty: number;
  pnl: number;
  return_pct: number;
  fees: number;
  bars_held: number;
  exit_reason: string;
  segment: BacktestSegmentName;
}
export interface BacktestPeriodReturn {
  period: string;
  return: number;
  benchmark: number | null;
}
export interface BacktestTradeStats {
  exit_reasons: {
    [k: string]: number;
  };
  holding_histogram: {
    /**
     * @maxItems 64
     */
    bins: number[];
    /**
     * @maxItems 64
     */
    counts: number[];
  };
  return_histogram: {
    /**
     * @maxItems 64
     */
    bins: number[];
    /**
     * @maxItems 64
     */
    counts: number[];
  };
  long_trades: number;
  short_trades: number;
  pnl_by_exit_reason?: {
    [k: string]: BacktestExitReasonPnl;
  };
}
export interface BacktestExitReasonPnl {
  count: number;
  /**
   * 该退出原因的净盈亏合计,报价币
   */
  pnl: number;
  avg_return: number | null;
}
export interface BacktestDataProvenance {
  source: string;
  first_at: number;
  last_at: number;
  bars: number;
  timeframe: string;
  /**
   * research_datasets 里保存的整段 K 线(含预热),回放 candles 从这里取
   */
  dataset_id: string | null;
  /**
   * 研究 loop 价格快照 id(如果来自 loop)
   */
  snapshot_id: string | null;
  warmup_bars: number;
  /**
   * 预热是否向窗口之前的数据借
   */
  warmup_borrowed: boolean;
  trading_from_ms: number;
  market?: OrderMarket;
  /**
   * market=perp 时的永续溯源
   */
  perp?: BacktestPerpProvenance | null;
}
/**
 * 永续回测的数据溯源(WP-F):成交价/标记价 K 线覆盖、资金费分界与重叠期偏差、维持保证金分档
 */
export interface BacktestPerpProvenance {
  /**
   * OKX instId,如 BTC-USDT-SWAP
   */
  instrument: string;
  source: string;
  mark_coverage: {
    from_ms: number;
    to_ms: number;
  } | null;
  /**
   * 没有标记价的根数(强平退回成交价)
   */
  mark_missing_bars: number;
  funding_coverage: "complete" | "partial" | "missing";
  /**
   * 资金费来源分界的一句话(哪段 OKX 官方 / OKX 归档 / 币安代理)
   */
  funding_note: string;
  /**
   * @maxItems 200
   */
  funding_segments: BacktestFundingSegment[];
  /**
   * @maxItems 200
   */
  funding_gaps?: {
    from_ms: number;
    to_ms: number;
  }[];
  /**
   * 币安代理用到哪一期(null=没用代理)
   */
  proxy_until_ms: number | null;
  /**
   * OKX 与币安同期资金费对照(相关、平均差、累计差)
   */
  deviation_note: string;
  max_lever: number | null;
  /**
   * 维持保证金分档口径(当前值,不是历史值)
   */
  maintenance_margin: string;
  /**
   * @maxItems 50
   */
  flags: string[];
  /**
   * @maxItems 50
   */
  notes: string[];
}
/**
 * 资金费序列里连续同源的一段
 */
export interface BacktestFundingSegment {
  /**
   * okx_archive=OKX 月度归档(UTC+8 月);okx_rest=OKX 资金费 REST(近约 3 个月);binance_proxy=币安 U 本位同名合约代理(OKX 官方覆盖不到的时段)
   */
  source: "okx_archive" | "okx_rest" | "binance_proxy";
  from_ms: number;
  to_ms: number;
  points: number;
}
export interface BacktestPlan {
  id: string;
  symbol: string;
  side: OrderSide;
  market: OrderMarket;
  leverage: number;
  placed_at: number;
  reason: string;
  entry_type: OrderEntryType;
  /**
   * 限价单的挂单价;市价单为 null
   */
  entry_price: number | null;
  /**
   * 信号那根的收盘价
   */
  reference_price: number;
  expires_at: number | null;
  status: OrderPlanStatus;
  filled_at: number | null;
  /**
   * 首腿成交价(含滑点);rolled_in 计划为结转价(下一根 open)
   */
  fill_price: number | null;
  fill_gap: boolean;
  /**
   * 入场腿;qty_frac 为相对首腿的数量比例(等权加仓=1)
   *
   * @maxItems 50
   */
  legs: BacktestPlanLeg[];
  /**
   * 初始止损(放置时);移动见 stop_path
   */
  stop: BacktestPlanLevel | null;
  /**
   * @maxItems 10
   */
  take_profits:
    | []
    | [BacktestPlanLevel]
    | [BacktestPlanLevel, BacktestPlanLevel]
    | [BacktestPlanLevel, BacktestPlanLevel, BacktestPlanLevel]
    | [BacktestPlanLevel, BacktestPlanLevel, BacktestPlanLevel, BacktestPlanLevel]
    | [BacktestPlanLevel, BacktestPlanLevel, BacktestPlanLevel, BacktestPlanLevel, BacktestPlanLevel]
    | [BacktestPlanLevel, BacktestPlanLevel, BacktestPlanLevel, BacktestPlanLevel, BacktestPlanLevel, BacktestPlanLevel]
    | [
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel
      ]
    | [
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel
      ]
    | [
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel
      ]
    | [
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel,
        BacktestPlanLevel
      ];
  /**
   * @maxItems 5000
   */
  stop_path: BacktestPricePoint[];
  /**
   * 放置时:按档位加权的止盈距离 / 止损距离,以限价(市价单用信号收盘价)为锚
   */
  planned_rr: number | null;
  /**
   * 本计划适用的最小盈亏比(用户硬约束优先,否则规范默认);planned_rr 低于它 → status=blocked
   */
  min_rr: number | null;
  exit: BacktestPlanExit | null;
  /**
   * 净收益 / 计划占用保证金,小数(0.0143=1.43%);含杠杆、手续费、已知资金费。现货杠杆 1 时即名义收益
   */
  pnl_pct: number | null;
  /**
   * 8794 口径:(加权出场价-均价)×方向 / |均价-初始止损|,毛价格 R,不含费用与杠杆;无止损为 null
   */
  r_multiple: number | null;
  /**
   * 8794 v11 口径:成交根到出场根(含)逐根恰好计一次,锚定最终均价,不含杠杆,小数,恒 ≥0
   */
  mfe_pct: number | null;
  /**
   * 同 mfe_pct,恒 ≤0
   */
  mae_pct: number | null;
  /**
   * 资金费对本计划的净影响 / 保证金,小数,正=收到、负=支付;现货或资金费序列缺失时为 null(不当 0)
   */
  funding_pct: number | null;
  /**
   * 手续费合计 / 保证金,小数,恒 ≥0;rolled 结转不重复收费
   */
  fees_pct: number;
  /**
   * 成交根到出场根的根数差
   */
  bars_held: number;
  rolled_from: string | null;
  rolled_to: string | null;
  replaced_by: string | null;
  segment: BacktestSegmentName;
  /**
   * @maxItems 500
   */
  events: BacktestPlanEvent[];
  /**
   * 不含杠杆与费用的价格变动:(加权出场价-均价)×方向/均价,小数;与 8794 的 pnl_pct(÷100)同口径
   */
  price_move_pct?: number | null;
  /**
   * 毛收益 / 保证金(含杠杆,不含费用与资金费),小数
   */
  gross_pct?: number | null;
  /**
   * 本计划持仓区间的资金费覆盖:complete=序列覆盖整段;partial=只覆盖一部分(已知期已计入);missing=没有序列(funding_pct=null);not_applicable=现货
   */
  funding_status?: "complete" | "partial" | "missing" | "not_applicable";
  /**
   * 已计入的资金费期数
   */
  funding_periods?: number;
  /**
   * 逐仓强平价(按均价、杠杆与维持保证金率);现货为 null
   */
  liquidation_price?: number | null;
  /**
   * 合计成交数量(base)
   */
  qty?: number;
  /**
   * 计划占用保证金(报价币),pnl_pct 的分母
   */
  margin?: number;
  /**
   * 限价来源;市价单为 null
   */
  entry_source?: OrderLevelSource | null;
  /**
   * status=blocked/cancelled 的原因代码(min_rr/no_target/no_stop/stop_side/stop_too_close/target_side/gap_invalidated/opposite_signal);stop_too_close=止损离入场不到 min_stop_atr×ATR(14)(结构口径)
   */
  blocked_reason?: string | null;
}
export interface BacktestPlanLeg {
  at: number;
  price: number;
  qty_frac: number;
}
export interface BacktestPlanLevel {
  price: number;
  /**
   * 该档占计划仓位的比例,小数(0.5=50%);止损档恒为 1
   */
  size_pct: number;
  source: OrderLevelSource;
  note: string;
  filled_at: number | null;
  fill_price: number | null;
}
export interface BacktestPricePoint {
  at: number;
  price: number;
}
export interface BacktestPlanExit {
  at: number;
  price: number;
  reason: OrderExitReason;
}
export interface BacktestPlanEvent {
  at: number;
  kind: BacktestPlanEventKind;
  price: number | null;
  note: string;
}
export interface BacktestPlanStats {
  /**
   * 真正挂出的计划数(不含 blocked)
   */
  placed: number;
  filled: number;
  no_fill: number;
  replaced: number;
  rolled: number;
  /**
   * 成交的加仓腿数
   */
  added: number;
  flipped: number;
  liquidated: number;
  /**
   * filled / (filled + no_fill):只算走完时效的计划;replaced/cancelled/blocked/pending 不进分母
   */
  fill_rate: number | null;
  avg_planned_rr: number | null;
  avg_realized_r: number | null;
  /**
   * 已结算计划中至少命中一档止盈的比例
   */
  tp_hit_rate: number | null;
  /**
   * 已结算计划中以止损(含 trail/breakeven 之外的初始或移动止损)离场的比例
   */
  sl_hit_rate: number | null;
  /**
   * 放置前被 min_rr / 无止损拦下的计划数
   */
  blocked?: number;
  /**
   * 被拦计划按原因计数(research-orders-v2 起;含超出行数上限只计数的部分)
   */
  blocked_by?: {
    [k: string]: number;
  };
  /**
   * 已成交时同向新信号按 ignore(或加仓已满)丢弃的次数
   */
  ignored?: number;
  /**
   * 成交前被撤销(反向信号/跳空失效)
   */
  cancelled?: number;
  /**
   * 数据末仍挂着的计划数
   */
  pending?: number;
  /**
   * 保本离场数
   */
  breakeven?: number;
  /**
   * 永续计划里资金费缺失或部分缺失的计划数
   */
  funding_missing?: number;
  /**
   * 永续计划资金费现金合计(报价币),正=收到、负=支付;现货或资金费全缺时为 null
   */
  funding_pnl?: number | null;
  /**
   * 永续计划计入的资金费期数合计
   */
  funding_periods?: number;
  /**
   * 强平计划的净亏损合计(报价币,≤0);没有强平为 null
   */
  liquidation_loss?: number | null;
}
export interface BacktestSideStats {
  trades: number;
  /**
   * 报价币
   */
  total_pnl: number;
  win_rate: number | null;
  /**
   * 平均单笔收益,小数
   */
  avg_return: number | null;
}
export interface BacktestSymbolContribution {
  symbol: string;
  trades: number;
  /**
   * 该腿净值变化(含期末未平仓盯市),报价币
   */
  pnl: number;
  win_rate: number | null;
  /**
   * pnl / 篮子初始资金;各腿之和 = 篮子 total_return
   */
  contribution: number;
}
export interface BacktestDailyPnl {
  day: string;
  pnl_pct: number;
}
/**
 * 资金使用:avg/max_exposure = 持仓市值/净值;time_in_market = 有持仓的 bar 占比;avg_concurrent_positions = 逐根同时持仓数均值;idle_fraction = 没有任何持仓的 bar 占比
 */
export interface BacktestCapitalUsage {
  avg_exposure: number;
  max_exposure: number;
  time_in_market: number;
  avg_concurrent_positions: number;
  idle_fraction: number;
}
/**
 * 策略容量粗估:单笔入场名义不超过窗口内 bar 成交额中位数 × 参与率 ⇒ 可容纳资金 ≈ 中位成交额 × 参与率 / 平均单笔入场占净值比例
 */
export interface BacktestCapacity {
  capacity_usd: number | null;
  participation_rate: number;
  median_bar_quote_volume: number | null;
  avg_entry_fraction: number | null;
  method: string;
}
export interface BacktestScore {
  value: number;
  label: BacktestScoreLabel;
  confidence: BacktestConfidence;
  confidence_reason: string;
  /**
   * @maxItems 16
   */
  components:
    | []
    | [BacktestScoreComponent]
    | [BacktestScoreComponent, BacktestScoreComponent]
    | [BacktestScoreComponent, BacktestScoreComponent, BacktestScoreComponent]
    | [BacktestScoreComponent, BacktestScoreComponent, BacktestScoreComponent, BacktestScoreComponent]
    | [
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent
      ]
    | [
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent
      ]
    | [
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent
      ]
    | [
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent
      ]
    | [
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent
      ]
    | [
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent
      ]
    | [
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent
      ]
    | [
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent
      ]
    | [
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent
      ]
    | [
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent
      ]
    | [
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent
      ]
    | [
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent,
        BacktestScoreComponent
      ];
}
export interface BacktestScoreComponent {
  key: string;
  value: number;
  weight: number;
  note: string;
}
export interface BacktestReportSummary {
  id: string;
  created_at: number;
  title: string;
  timeframe: string;
  primary_key: string;
  strategy_ir_hash: string;
  strategy_id: string | null;
  strategy_version: number | null;
  score: BacktestScore;
  metrics: BacktestMetrics | null;
  /**
   * @maxItems 200
   */
  sparkline: number[];
}
export interface PortfolioXsmomNode {
  primitive: "portfolio_xsmom";
  params: PortfolioXsmomParams;
}
/**
 * 横截面动量:每个调仓时刻按过去 lookback_days 天收益给资产池排名,等权持有前 top_k(long_short 时另做空后 top_k,多空各占一半权益);调仓时刻收盘排名、下一根开盘成交,成本按换手额 ×(手续费 + 滑点)。只用调仓时刻及以前已收盘的 K 线。
 */
export interface PortfolioXsmomParams {
  /**
   * 排名用的回看天数(按日历时间,取正好 lookback_days 天前那根收盘)
   */
  lookback_days: number;
  /**
   * 持有名数;可排名资产不足时按实际数
   */
  top_k: number;
  /**
   * weekly = 每周一 00:00 UTC 开盘调仓(周日最后一根收盘排名);daily = 每个 UTC 日开盘调仓
   */
  rebalance: "weekly" | "daily";
  /**
   * 绝对动量过滤:回看收益 ≤ 0 的名额留现金(做空一侧对称:回看收益 ≥ 0 的不做空)。缺省 false
   */
  abs_filter?: boolean;
  /**
   * long_only(现货)/ long_short(永续:多前 top_k、空后 top_k,计资金费)。缺省 long_only
   */
  side?: "long_only" | "long_short";
  /**
   * random = 随机入场基线:同调仓时刻、同名数,随机挑资产(固定种子)。缺省 momentum
   */
  select?: "momentum" | "random";
  /**
   * select=random 时的种子
   */
  seed?: number;
}
export interface PortfolioCarryNode {
  primitive: "portfolio_carry";
  params: PortfolioCarryParams;
}
/**
 * 永续资金费套利(最小可用版):每个资产现货多 + 永续空等名义,资金 50/50 分给现货与永续保证金(1 倍);每个资金费结算时刻看最近 window 期(按 8h 等效折算)平均费率,高于 min_rate 就持有、否则空仓;进出场各付两腿吃单费 + 滑点;持仓中两腿名义偏离权益一半超过 rebalance_band 就调回;收益 = 收到的资金费 + 基差变化 − 成本。
 */
export interface PortfolioCarryParams {
  /**
   * 平均的资金费期数(含当期刚结算的一期)
   */
  window: number;
  /**
   * 8h 等效费率门槛(小数,0.0001 = 1bp/8h ≈ 年化 11%);严格大于才持有
   */
  min_rate: number;
  /**
   * 现货吃单费率,缺省 0.001
   */
  spot_fee_rate?: number;
  /**
   * 永续吃单费率,缺省 0.0005
   */
  perp_fee_rate?: number;
  /**
   * 每腿每次成交的不利滑点,缺省 5
   */
  slippage_bps?: number;
  /**
   * 持仓期间两腿名义偏离「权益的一半」超过这个比例就调回(按吃单费 + 滑点计成本),缺省 0.2;等价于把现货浮盈划给永续保证金,1 倍空头不会被强平
   */
  rebalance_band?: number;
}
/**
 * GET /api/research/strategies/:id/binding[?version=] 只读编译结果;策略还没有 IR(规则未编码的草稿)时 binding=null,unmapped 说明缺什么
 */
export interface StrategyBindingResponse {
  strategy_id: string;
  version: number | null;
  lab_strategy_id: string | null;
  binding: StrategyBinding | null;
  /**
   * @maxItems 100
   */
  unmapped: BindingUnmapped[];
}
export interface StrategyBinding {
  schema_version: "strategy-binding/v1";
  compiler_version: string;
  strategy_id: string;
  version: number;
  ir_hash: string;
  /**
   * 绑定内容哈希(不含 compiled_at 与 content_hash 本身);同 IR + 同编译器/库版本 → 同哈希
   */
  content_hash: string;
  compiled_at: number;
  /**
   * 编译时的原语库/订单门口径/策略规范/周期策略版本;任一变化都可能让同一 IR 产出不同候选
   */
  libs: {
    primitive_registry: string;
    order_gate: "structure" | "legacy";
    strategy_spec: string;
    horizon_policy: string;
  };
  /**
   * 从 IR 主周期推;1m/3m/5m(scalp)不接受,为 null 并在 unmapped 里 block
   */
  horizon: "intraday" | "swing" | "position" | null;
  timeframe: string;
  confirm_timeframe: string | null;
  symbol: string;
  market: "spot" | "perp";
  direction: "long" | "short" | "both";
  trigger: {
    /**
     * @maxItems 30
     */
    primitives: StrategyPrimitive[];
    regime: StrategyPrimitive | null;
    /**
     * @maxItems 30
     */
    short_primitives: StrategyPrimitive[];
    short_regime: StrategyPrimitive | null;
    eval_on: "bar_close";
    /**
     * IR 没有冷却字段:null = 不另设冷却,同向新信号按 entry.on_new_signal 处理
     */
    cooldown_bars: number | null;
  };
  evidence_plan: BindingEvidencePlan;
  entry: {
    type: "market" | "limit";
    price: StrategyPrimitive | null;
    expiry_bars: number | null;
    on_new_signal: {
      unfilled: "replace" | "keep";
      filled: "roll" | "add" | "ignore";
    };
    max_adds: number;
    chase_atr_max: number | null;
  };
  stop: {
    primitive: StrategyPrimitive;
    buffer_atr: number | null;
    /**
     * 一条线:硬止损 = 失效线(+ buffer)
     */
    is_invalidation: true;
    /**
     * 结构口径:止损离入场不到 k×ATR(14) 的单子不做(不把止损挪远);旧口径为 null
     */
    min_stop_atr: number | null;
  };
  /**
   * 最多 5 档(order.take_profits 上限)
   */
  targets: BindingTarget[];
  /**
   * chart = 图上价位止盈,算不出就不设、交给追踪止损;user_r = 用户原话要求的 R 倍数;signal_exit = 止盈由用户的信号离场决定,不补价位;trail_only = 只有追踪止损
   */
  target_policy: "chart" | "user_r" | "signal_exit" | "trail_only";
  trail: StrategyPrimitive | null;
  breakeven_after_tp: boolean;
  breakeven_after_r: number | null;
  max_holding_bars: number | null;
  /**
   * @maxItems 30
   */
  signal_exits: StrategyPrimitive[];
  /**
   * 只有用户硬约束(order.min_rr)才有值、才拦单;结构口径下盈亏比只计算展示
   */
  min_rr: number | null;
  risk: {
    sizing: StrategyPrimitive;
    leverage: number;
    /**
     * 实盘杠杆上限(研究侧 MAX_RESEARCH_LEVERAGE);IR 超过它编译 block
     */
    leverage_cap: number;
    /**
     * 单笔初始风险占权益上限(订单门 max_risk_fraction,小数字符串)
     */
    max_risk_fraction: string;
  };
  /**
   * 模型在这条策略里的角色(复审:agent_mode 拆成 entry_filter / exit_discretion)。缺省 entry_filter=on、exit_discretion=off:模型只决定做/不做,不改任何价位,持仓期零模型调用;最终取值由 A/C 臂配对证据定,属于部署决定
   */
  model: {
    entry_filter: "on" | "off";
    exit_discretion: "on" | "off";
    /**
     * @maxItems 10
     */
    outputs:
      | []
      | [string]
      | [string, string]
      | [string, string, string]
      | [string, string, string, string]
      | [string, string, string, string, string]
      | [string, string, string, string, string, string]
      | [string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string];
    /**
     * @maxItems 20
     */
    forbidden:
      | []
      | [string]
      | [string, string]
      | [string, string, string]
      | [string, string, string, string]
      | [string, string, string, string, string]
      | [string, string, string, string, string, string]
      | [string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string
        ];
  };
  /**
   * 固定六片,顺序 radar / judge / geometry / risk / holding / execution
   */
  roles: BindingRoleSlice[];
  /**
   * @maxItems 100
   */
  unmapped: BindingUnmapped[];
  /**
   * unmapped 里没有 block;false = 编译失败,不能下发
   */
  deployable: boolean;
  /**
   * evidence 会变,不嵌进绑定:只存这版的回测报告 id
   */
  evidence_refs: {
    /**
     * @maxItems 500
     */
    report_ids: string[];
  };
}
/**
 * 模型做入场过滤时看的证据:全部由 IR 原语的输入推导,不手填
 */
export interface BindingEvidencePlan {
  /**
   * @maxItems 60
   */
  indicators: BindingEvidenceIndicator[];
  /**
   * 结构证据:swing_pivots / order_blocks / htf_structure@<tf> / volume_ratio 等
   *
   * @maxItems 30
   */
  structure: string[];
  /**
   * @maxItems 12
   */
  info_topics:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string];
}
export interface BindingEvidenceIndicator {
  /**
   * 规范化 id:<indicator>(<args>)[.<output>]@<timeframe>,同一条线去重
   */
  id: string;
  indicator: string;
  args: {
    [k: string]: number;
  };
  output: string | null;
  timeframe: string;
  /**
   * 由哪些 IR 位置推导出来
   *
   * @maxItems 30
   */
  from: string[];
}
export interface BindingTarget {
  source: StrategyPrimitive;
  size_pct: number;
  /**
   * chart = 图上价位(前高/摆动高点/结构阻力);indicator = 用户指定的指标线;r_multiple = 用户原话要求的 R 倍数
   */
  kind: "chart" | "indicator" | "r_multiple";
}
export interface BindingRoleSlice {
  role: BindingRole;
  title: string;
  summary: string;
  /**
   * @maxItems 60
   */
  rules: BindingRule[];
}
export interface BindingRule {
  text: string;
  executor: BindingExecutor;
  /**
   * 来自 IR 的哪个位置(如 signal[0]、order.entry.price、risk.stop);编译器补的缺省规则为 null
   */
  ref: string | null;
  primitive: string | null;
}
export interface BindingUnmapped {
  code: string;
  path: string | null;
  /**
   * block = 编译失败、不能下发(不近似);warn = 能下发,但语义有损或需要实盘侧补能力
   */
  severity: "block" | "warn";
  message: string;
  /**
   * compiler = IR 里实盘不支持的原语/字段;import = 内置策略译成 IR 时丢掉的原规则语义
   */
  source: "compiler" | "import";
}
/**
 * POST /api/research/strategies/import-builtin {backtest?, ids?} 的结果;按 origin.source='import' + lab_strategy_id=<内置 id> 幂等
 */
export interface BuiltinImportResult {
  /**
   * @maxItems 50
   */
  items: BuiltinImportItem[];
}
export interface BuiltinImportItem {
  builtin_id: string;
  strategy_id: string;
  /**
   * true = 本次新建;false = 已存在(幂等,不重复建)
   */
  created: boolean;
  version: number | null;
  /**
   * full = 整条译成 IR;partial = 部分可译,其余进 unmapped;none = 规则未编码(缺原语),只建草稿
   */
  translation: "full" | "partial" | "none";
  report_id: string | null;
  error: string | null;
}
export interface ImproveJobDetail {
  job: ImproveJobSummary;
  spec: ImproveSpec;
  frozen: ImproveFrozen | null;
  progress: ImproveProgress | null;
  ledger: ImproveLedger | null;
  result: ImproveResult | null;
  /**
   * @maxItems 500
   */
  lineage: ImproveCandidate[];
  /**
   * @maxItems 50
   */
  leaderboard: ImproveLeaderboardRow[];
  /**
   * @maxItems 10
   */
  generators_available:
    | []
    | ["baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model"]
    | [
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model"
      ]
    | [
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model"
      ]
    | [
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model"
      ]
    | [
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model"
      ]
    | [
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model"
      ]
    | [
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model"
      ]
    | [
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model"
      ]
    | [
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model"
      ]
    | [
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model"
      ];
}
export interface ImproveJobSummary {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  strategy_id: string | null;
  strategy_version: number | null;
  label: string;
  timeframe: string;
  /**
   * @maxItems 30
   */
  universe: string[];
  created_at: number;
  updated_at: number;
  finished_at: number | null;
  phase: string | null;
  message: string | null;
  generation: number;
  trials: number;
  champion_id: string | null;
  summary: string | null;
  error: string | null;
}
export interface ImproveSpec {
  strategy_id: string | null;
  strategy_version: number | null;
  strategy_ir: StrategyIR;
  timeframe: string;
  /**
   * @maxItems 30
   */
  universe: string[];
  from_ms: number;
  to_ms: number;
  objective: ImproveObjective;
  budget: ImproveBudget;
  /**
   * @maxItems 5
   */
  generators:
    | []
    | ["baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model"]
    | [
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model"
      ]
    | [
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model"
      ]
    | [
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model"
      ]
    | [
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model"
      ];
  dataset_ids: {
    [k: string]: string;
  } | null;
  random_entry_runs: number;
  seed: number;
  write_version: boolean;
}
export interface ImproveObjective {
  min_trades_per_fold: number;
  min_trades_total: number;
  max_drawdown: number;
  require_stress_positive: boolean;
  require_beats_exposure_matched_hold: boolean;
  plateau_ratio: number;
  stability_penalty?: number;
}
export interface ImproveBudget {
  generations: number;
  candidates_per_generation: number;
  promote_per_generation: number;
  wall_clock_ms: number;
  model_calls: number;
  patience?: number;
  /**
   * 多步搜索(缺省 true):没有 promote 的代,训练目标高于父策略的最好候选(门槛没过也行)作下一代父策略;冠军只从门槛全过且验证段优于基线的候选里选
   */
  allow_explore?: boolean;
}
export interface ImproveFrozen {
  /**
   * @maxItems 30
   */
  universe: string[];
  timeframe: string;
  timeframe_ms: number;
  warmup_bars: number;
  segments: {
    /**
     * @maxItems 20
     */
    folds:
      | []
      | [
          {
            from_ms: number;
            to_ms: number;
          }
        ]
      | [
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          }
        ]
      | [
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          }
        ]
      | [
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          }
        ]
      | [
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          }
        ]
      | [
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          }
        ]
      | [
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          }
        ]
      | [
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          }
        ]
      | [
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          }
        ]
      | [
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          }
        ]
      | [
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          }
        ]
      | [
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          }
        ]
      | [
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          }
        ]
      | [
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          }
        ]
      | [
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          }
        ]
      | [
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          }
        ]
      | [
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          }
        ]
      | [
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          }
        ]
      | [
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          }
        ]
      | [
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          },
          {
            from_ms: number;
            to_ms: number;
          }
        ];
    train: {
      from_ms: number;
      to_ms: number;
    };
    validation: {
      from_ms: number;
      to_ms: number;
    };
    holdout: {
      from_ms: number;
      to_ms: number;
    };
  };
  dataset_ids: {
    [k: string]: string;
  };
  bars: {
    [k: string]: number;
  };
  market?: "spot" | "perp";
}
export interface ImproveProgress {
  phase: string;
  message: string;
  generation: number;
  /**
   * @maxItems 20
   */
  generations:
    | []
    | [ImproveGenerationProgress]
    | [ImproveGenerationProgress, ImproveGenerationProgress]
    | [ImproveGenerationProgress, ImproveGenerationProgress, ImproveGenerationProgress]
    | [ImproveGenerationProgress, ImproveGenerationProgress, ImproveGenerationProgress, ImproveGenerationProgress]
    | [
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress
      ]
    | [
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress
      ]
    | [
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress
      ]
    | [
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress
      ]
    | [
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress
      ]
    | [
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress
      ]
    | [
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress
      ]
    | [
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress
      ]
    | [
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress
      ]
    | [
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress
      ]
    | [
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress
      ]
    | [
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress
      ]
    | [
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress
      ]
    | [
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress
      ]
    | [
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress
      ]
    | [
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress,
        ImproveGenerationProgress
      ];
  trials: number;
  single_runs: number;
  started_at: number | null;
  elapsed_ms: number;
  stop_reason: string | null;
  /**
   * @maxItems 200
   */
  notes: string[];
}
export interface ImproveGenerationProgress {
  generation: number;
  parent_id: string;
  candidates: number;
  evaluated: number;
  passed: number;
  /**
   * @maxItems 20
   */
  promoted:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
  improved: boolean;
  best_candidate_id: string | null;
  best_objective: number | null;
  note: string;
  /**
   * 这一代怎么选出下一代父策略:promote=门槛全过且验证段优于冠军;explore=训练目标更高的多步搜索父策略(不能当冠军);null=都没有
   */
  mode?: "promote" | "explore" | null;
  /**
   * 这一代结束时的冠军
   */
  champion_id?: string;
}
export interface ImproveLedger {
  trials: number;
  deflated_sharpe: number | null;
  pbo: number | null;
  random_entry_baseline: ImproveSegmentScore | null;
  /**
   * @maxItems 50
   */
  notes: string[];
  deflated_inputs?: {
    sharpe: number;
    sharpe_variance: number;
    expected_max_sharpe: number;
    days: number;
    skew: number;
    kurtosis: number;
  } | null;
  plateau_checks?: number;
  random_entry?: ImproveRandomEntry | null;
}
export interface ImproveSegmentScore {
  segment: string;
  trades: number;
  total_return: number;
  sharpe: number | null;
  max_drawdown: number;
  exposure: number;
  exposure_matched_hold: number | null;
  stressed_return: number | null;
  from_ms?: number;
  to_ms?: number;
  hold_return?: number | null;
  btc_hold_return?: number | null;
  daily_sharpe?: number | null;
  days?: number;
  win_rate?: number | null;
  profit_factor?: number | null;
  fees?: number;
  /**
   * @maxItems 50
   */
  per_asset?: {
    symbol: string;
    total_return: number;
    trades: number;
    hold_return: number | null;
    status: string;
  }[];
}
export interface ImproveRandomEntry {
  runs: number;
  seed: number;
  segment: string;
  /**
   * @maxItems 200
   */
  returns: number[];
  /**
   * @maxItems 200
   */
  trades: number[];
  /**
   * @maxItems 200
   */
  sharpes: (number | null)[];
  median_return: number | null;
  champion_return: number;
  champion_percentile: number | null;
  note: string;
}
export interface ImproveResult {
  champion_id: string | null;
  baseline_id: string | null;
  champion_is_baseline: boolean;
  holdout: ImproveSegmentScore | null;
  baseline_validation: ImproveSegmentScore | null;
  strategy_version_written: number | null;
  stop_reason: string | null;
  summary: string;
}
export interface ImproveCandidate {
  id: string;
  parent_id: string | null;
  generation: number;
  generator: "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model";
  status:
    "rejected" | "evaluated" | "gated_out" | "plateau_failed" | "validated" | "parent" | "explore_parent" | "champion";
  ir_hash: string;
  strategy_ir: StrategyIR;
  /**
   * @maxItems 50
   */
  diff: ImproveDiff[];
  rationale: string;
  evidence: {} | null;
  evaluation: ImproveEvaluation | null;
}
export interface ImproveDiff {
  path: string;
  from: unknown;
  to: unknown;
}
export interface ImproveEvaluation {
  candidate_id: string;
  /**
   * @maxItems 20
   */
  folds:
    | []
    | [ImproveSegmentScore]
    | [ImproveSegmentScore, ImproveSegmentScore]
    | [ImproveSegmentScore, ImproveSegmentScore, ImproveSegmentScore]
    | [ImproveSegmentScore, ImproveSegmentScore, ImproveSegmentScore, ImproveSegmentScore]
    | [ImproveSegmentScore, ImproveSegmentScore, ImproveSegmentScore, ImproveSegmentScore, ImproveSegmentScore]
    | [
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore
      ]
    | [
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore
      ]
    | [
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore
      ]
    | [
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore
      ]
    | [
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore
      ]
    | [
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore
      ]
    | [
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore
      ]
    | [
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore
      ]
    | [
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore
      ]
    | [
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore
      ]
    | [
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore
      ]
    | [
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore
      ]
    | [
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore
      ]
    | [
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore
      ]
    | [
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore,
        ImproveSegmentScore
      ];
  train?: ImproveSegmentScore;
  validation?: ImproveSegmentScore;
  holdout?: ImproveSegmentScore;
  objective: number | null;
  /**
   * @maxItems 20
   */
  gates:
    | []
    | [ImproveGateResult]
    | [ImproveGateResult, ImproveGateResult]
    | [ImproveGateResult, ImproveGateResult, ImproveGateResult]
    | [ImproveGateResult, ImproveGateResult, ImproveGateResult, ImproveGateResult]
    | [ImproveGateResult, ImproveGateResult, ImproveGateResult, ImproveGateResult, ImproveGateResult]
    | [ImproveGateResult, ImproveGateResult, ImproveGateResult, ImproveGateResult, ImproveGateResult, ImproveGateResult]
    | [
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult
      ]
    | [
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult
      ]
    | [
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult
      ]
    | [
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult
      ]
    | [
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult
      ]
    | [
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult
      ]
    | [
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult
      ]
    | [
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult
      ]
    | [
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult
      ]
    | [
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult
      ]
    | [
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult
      ]
    | [
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult
      ]
    | [
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult
      ]
    | [
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult,
        ImproveGateResult
      ];
  passed: boolean;
}
export interface ImproveGateResult {
  name: string;
  ok: boolean;
  value: number | null;
  threshold: number | null;
  note?: string;
}
export interface ImproveLeaderboardRow {
  id: string;
  generation: number;
  generator: "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model";
  status:
    "rejected" | "evaluated" | "gated_out" | "plateau_failed" | "validated" | "parent" | "explore_parent" | "champion";
  objective: number | null;
  passed: boolean;
  /**
   * @maxItems 20
   */
  failed_gates:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
  train_return: number | null;
  train_sharpe: number | null;
  train_trades: number | null;
  validation_return: number | null;
  validation_sharpe: number | null;
  holdout_return: number | null;
}
export interface ImproveJobList {
  /**
   * @maxItems 200
   */
  jobs: ImproveJobSummary[];
}
export interface ImproveAccepted {
  job_id: string;
}
export interface ImproveEvent {
  job_id: string;
  phase: string;
  generation: number;
  message: string;
  trials: number;
  status?: string;
  candidate?: {
    id: string;
    generator: "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model";
    objective: number | null;
    passed: boolean;
    status:
      | "rejected"
      | "evaluated"
      | "gated_out"
      | "plateau_failed"
      | "validated"
      | "parent"
      | "explore_parent"
      | "champion";
  };
}
export interface ImproveRequest {
  strategy_id?: string;
  strategy_version?: number;
  strategy_ir?: StrategyIR;
  timeframe?: string;
  /**
   * @minItems 1
   * @maxItems 30
   */
  universe?: [string, ...string[]];
  from_ms?: number;
  to_ms?: number;
  objective?: {
    min_trades_per_fold?: number;
    min_trades_total?: number;
    max_drawdown?: number;
    require_stress_positive?: boolean;
    require_beats_exposure_matched_hold?: boolean;
    plateau_ratio?: number;
    stability_penalty?: number;
  };
  budget?: {
    generations?: number;
    candidates_per_generation?: number;
    promote_per_generation?: number;
    wall_clock_ms?: number;
    model_calls?: number;
    patience?: number;
  };
  /**
   * @minItems 1
   * @maxItems 5
   */
  generators?:
    | ["baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model"]
    | [
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model"
      ]
    | [
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model"
      ]
    | [
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model"
      ]
    | [
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model",
        "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model"
      ];
  dataset_ids?: {
    [k: string]: string;
  };
  random_entry_runs?: number;
  seed?: number;
  write_version?: boolean;
}
export interface LoopPlan {
  task_kind: LoopTaskKind;
  mode?: LoopResearchMode;
  instruments: string[];
  window: LoopWindow;
  timeframe: string;
  plan: LoopPlanStep[];
  clarify?: string;
  source?: "model" | "fallback_rules";
  command?: LoopRevisionCommand;
}
export interface LoopWindow {
  from_ms: number;
  to_ms: number;
}
export interface LoopPlanStep {
  key: string;
  title: string;
  tool: string;
  args: LoopObject;
  depends_on: string[];
}
export interface LoopObject {
  [k: string]: LoopJson;
}
export interface LoopRevisionCommand {
  mode: "revise" | "optimize" | "rerun";
  baseline_run_id: string;
  instruction: string;
  max_candidates: number;
  execution_overrides?: {
    initial_cash?: string;
    fee_rate?: string;
    slippage_bps?: string;
    risk_fraction?: string;
    max_allocation?: string;
  };
}
export interface LoopSnapshot {
  kind: "price" | "funding" | "open_interest" | "liquidations";
  provider: "okx";
  instrument: LoopInstrument;
  requested_window: LoopWindow;
  actual_window: LoopWindow | null;
  as_of: number;
  fetched_at: number;
  frequency: string | null;
  units: LoopUnits;
  coverage: LoopAvailability;
  quality_flags: string[];
  rows: LoopRows;
  checksum: string;
  method_version: string;
}
export interface LoopInstrument {
  canonical_id: string;
  asset_class: "crypto";
  venue: "okx";
  market_type: "spot" | "perp";
  base: string;
  quote: string;
  timezone: "UTC";
  ccxt_symbol: string;
  display: string;
}
export interface LoopUnits {
  [k: string]: string;
}
export interface LoopArtifact {
  inquiry_id: string;
  snapshot_refs: string[];
  data_kind: "observed" | "derived" | "estimated" | "synthetic";
  availability: LoopAvailability;
  question: string;
  spec: LoopSpec;
  caption: string;
  kind: "chart" | "table" | "markdown";
  title: string;
  content: LoopObject;
  run_id?: string;
}
export interface LoopSpec {
  type: "line" | "bar" | "candlestick" | "table" | "comparison" | "scatter" | "heatmap";
  x?: string;
  y?: string | string[];
  series?:
    | string
    | {
        field: string;
        axis?: string;
        label?: string;
        mode?: LoopSeriesMode;
        role?: LoopSeriesRole;
        /**
         * 柱顶/点旁文字标签取自哪个字段(如「28T」笔数标签)
         */
        text_field?: string;
      }[];
  axis_units?: LoopUnits;
  y_unit?: LoopYUnit;
  x_title?: string;
  y_title?: string;
  template?: LoopChartTemplate;
  /**
   * 图表由哪份全窗口回测报告确定性生成(溯源)
   */
  report_id?: string;
  /**
   * 多策略横比图引用的报告
   *
   * @maxItems 32
   */
  report_ids?: string[];
  encoding?: LoopObject;
  legend?: LoopJson;
  annotations?: (LoopChartAnnotation | LoopObject)[];
  interaction?: LoopObject;
}
/**
 * x 分界竖线(vline,如样本内/外)或 y 参考横线(hline,如 0 线)
 */
export interface LoopChartAnnotation {
  type: "vline" | "hline";
  x?: number | string;
  y?: number;
  label?: string;
  role?: LoopSeriesRole;
}
export interface LoopContext {
  instrument_refs: string[];
  selected_artifact_id?: string;
  selected_inquiry_id?: string;
  selected_run_id?: string;
  selected_window?: LoopWindow;
}
export interface LoopConcept {
  term: string;
  concept_id: string;
  category: LoopConceptCategory;
  status: LoopConceptStatus;
  source: LoopConceptSource;
  target: string | null;
  note: string;
}
export interface LoopBudget {
  max_model_calls: number;
  max_data_calls: number;
  max_backtests: number;
  wall_clock_ms: number;
}
export interface LoopUsage {
  max_model_calls: number;
  max_data_calls: number;
  max_backtests: number;
  wall_clock_ms: number;
  unknown_cost: boolean;
}
export interface LoopCheckpoint {
  completed_step_keys: string[];
  snapshot_refs: string[];
  artifact_refs: string[];
  /**
   * @maxItems 200
   */
  concepts?: LoopConcept[];
}
export interface LoopCoverage {
  availability: LoopAvailability;
  earliest?: number | null;
  latest?: number | null;
  note: string;
}
export interface LoopChartSeries {
  name: string;
  mode: LoopSeriesMode;
  role: LoopSeriesRole;
  /**
   * @maxItems 5000
   */
  points: [number | string | null, number | string | null][];
  /**
   * 与 points 对齐的文字标签(柱顶笔数等)
   *
   * @maxItems 5000
   */
  labels?: (string | null)[];
  /**
   * 逐点颜色角色(散点盈绿亏红、柱正负)
   *
   * @maxItems 5000
   */
  point_roles?: ("positive" | "negative" | "neutral")[];
  /**
   * 与 points 对齐的悬停附注(如交易日期)
   *
   * @maxItems 5000
   */
  hover?: (string | null)[];
}
/**
 * 研究图表产物的内容(artifact.content):由模板从回测报告确定性生成,前端按 Horizon 风格渲染(统一悬停、底部图例、坐标轴标题、分界线、柱顶标签)
 */
export interface LoopChart {
  kind: "chart";
  version: "research-chart/v1";
  template: LoopChartTemplate;
  title: string;
  type: "line" | "bar" | "scatter" | "heatmap";
  /**
   * time=毫秒时间戳;category=等距类目;linear=数值(如 Trade #)
   */
  x: "time" | "category" | "linear";
  x_title: string;
  y_title: string;
  y_unit: LoopYUnit;
  /**
   * @maxItems 24
   */
  series: LoopChartSeries[];
  /**
   * @maxItems 24
   */
  annotations: LoopChartAnnotation[];
  heatmap?: {
    /**
     * @maxItems 24
     */
    x: string[];
    /**
     * @maxItems 64
     */
    y: string[];
    /**
     * @maxItems 64
     */
    z: (number | null)[][];
  };
  /**
   * 代码生成的一句说明(带数值)
   */
  caption?: string;
  note?: string;
  report_id?: string;
  /**
   * @maxItems 32
   */
  report_ids?: string[];
  asset?: string;
  /**
   * 金额换算基数(统一按 $10k 本金)
   */
  base_capital?: number;
}
export interface LoopResult {
  status: "ok" | "partial" | "missing" | "not_applicable" | "stale" | "error";
  output: LoopJson;
  snapshot_refs: string[];
  artifact_refs: string[];
  coverage?: LoopCoverage;
  warnings: string[];
  units?: LoopUnits;
  error_code?: LoopErrorCode;
  retryable?: boolean;
  latency_ms: number;
}
export interface LoopResolveInput {
  query?: string;
  symbols?: string[];
  market?: "spot" | "perp";
}
export interface LoopResolveOutput {
  instruments: LoopInstrument[];
}
export interface LoopDataInput {
  instrument: LoopInstrument;
  window: LoopWindow;
  timeframe?: string;
  metric?: "price" | "funding" | "open_interest" | "liquidations" | "liquidation_estimates" | "orderbook";
}
export interface LoopSnapshotOutput {
  snapshot_id: string;
}
export interface LoopLeverageInput {
  price_snapshot: string;
  funding_snapshot?: string;
  oi_snapshot?: string;
  liquidations_snapshot?: string;
}
export interface LoopStrengthInput {
  instruments: string[];
  benchmark: string;
  timeframe: string;
  window: LoopWindow;
  snapshot_refs?: string[];
}
export interface LoopCompareInput {
  run_id: string;
  arm: "a_rules" | "b_agent" | "c_filter";
}
export interface LoopCompileInput {
  text?: string;
  ir?: LoopObject;
  timeframe: string;
  dataset_id?: string;
  /**
   * @maxItems 8
   */
  acquired?:
    | []
    | [LoopObject]
    | [LoopObject, LoopObject]
    | [LoopObject, LoopObject, LoopObject]
    | [LoopObject, LoopObject, LoopObject, LoopObject]
    | [LoopObject, LoopObject, LoopObject, LoopObject, LoopObject]
    | [LoopObject, LoopObject, LoopObject, LoopObject, LoopObject, LoopObject]
    | [LoopObject, LoopObject, LoopObject, LoopObject, LoopObject, LoopObject, LoopObject]
    | [LoopObject, LoopObject, LoopObject, LoopObject, LoopObject, LoopObject, LoopObject, LoopObject];
}
export interface LoopBacktestInput {
  instrument: LoopInstrument;
  window: LoopWindow;
  timeframe: string;
  ir: LoopObject;
  price_snapshot?: string;
}
export interface LoopRenderInput {
  kind: "chart" | "table";
  spec: LoopSpec;
  /**
   * @minItems 1
   */
  snapshot_refs: [string, ...string[]];
  title: string;
  question: string;
}
export interface LoopComposeInput {
  question: string;
  steps: LoopObject[];
  artifact_ids: string[];
  metrics: LoopObject;
}
export interface LoopComposeOutput {
  blocks: LoopBlocks;
}
export interface LoopMetric {
  value: number | null;
  unit: string;
  status: "ok" | "insufficient" | "not_applicable";
  note?: string;
}
export interface LoopMetrics {
  [k: string]: LoopMetric;
}
export interface LoopAnalysisOutput {
  analysis: LoopObject;
  metrics: LoopMetrics;
}
export interface LoopCompileOutput {
  ok: boolean;
  ir: {} | null;
  checks: LoopObject[];
  [k: string]: LoopJson | boolean | {} | null | LoopObject[];
}
export interface LoopBacktestOutput {
  run_id: string;
  status: string;
  closed_trades?: number | null;
  metrics?: LoopObject[];
}
export interface LoopRenderOutput {
  artifact_id: string;
}
export interface LoopRunInput {
  run_id: string;
}
export interface LoopRevisionCompileInput {
  baseline_run_id: string;
  instruction: string;
  candidate_index: number;
}
export interface LoopRevisionRunInput {
  baseline_run_id: string;
  draft_artifact_id: string;
}
export interface LoopRunPairInput {
  baseline_run_id: string;
  candidate_run_id: string;
}
export interface LoopAcquireInput {
  concept: string;
  category?: LoopConceptCategory;
  question?: string;
}
export interface LoopAcquireOutput {
  concept: string;
  definition: string;
  implementation: {
    kind: "primitive" | "indicator_row" | "pine" | "unsupported";
    target: string | null;
    params: LoopObject | null;
    expression: string | null;
    note: string;
  };
  provenance: {
    source: "lexicon" | "brain" | "web";
    detail: string;
    retrieved_at: number;
  };
  concept_status: LoopConcept;
  /**
   * @maxItems 10
   */
  tried_sources:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string];
  /**
   * @maxItems 10
   */
  offline_sources:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string];
}
export interface LoopPatternInput {
  price_snapshot: string;
  primitive: string;
  params?: LoopObject;
  horizon_bars: number;
  label?: string;
}
export interface BacktestReplay {
  report_id: string;
  asset_key: string;
  symbol: string;
  timeframe: string;
  from_ms: number;
  to_ms: number;
  truncated: boolean;
  /**
   * @maxItems 20000
   */
  candles: BacktestCandle[];
  /**
   * @maxItems 20000
   */
  plans: BacktestPlan[];
}
export interface BacktestCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
export interface ResearchStrategyList {
  /**
   * @maxItems 5000
   */
  strategies: ResearchStrategy[];
  counts: ResearchStrategyCounts;
}
export interface ResearchStrategy {
  id: string;
  name: string;
  description: string;
  status: ResearchStrategyStatus;
  symbol: string;
  timeframe: string;
  watchlist: boolean;
  alerts: boolean;
  current_version: number;
  created_at: number;
  updated_at: number;
  origin: ResearchStrategyOrigin;
  summary: ResearchStrategySummary | null;
  lab_strategy_id: string | null;
  published_listing_id: string | null;
  /**
   * 经 attach-session 绑定到研究会话:该会话后续回测报告都挂到这条策略
   */
  session_bound?: boolean;
}
export interface ResearchStrategyOrigin {
  session_id: string | null;
  inquiry_id: string | null;
  source: "research_loop" | "manual" | "import";
}
export interface ResearchStrategySummary {
  total_return: number | null;
  sharpe: number | null;
  max_drawdown: number | null;
  win_rate: number | null;
  trades: number | null;
  score: number | null;
  score_label: BacktestScoreLabel | null;
  /**
   * @maxItems 200
   */
  sparkline: number[];
  report_id: string | null;
  backtested_at: number | null;
}
export interface ResearchStrategyCounts {
  all: number;
  live: number;
  watchlist: number;
  alerts: number;
  draft: number;
}
export interface ResearchStrategyDetail {
  strategy: ResearchStrategy;
  /**
   * @maxItems 1000
   */
  versions: ResearchStrategyVersion[];
  report: BacktestReport | null;
  /**
   * @maxItems 500
   */
  reports: BacktestReportSummary[];
  /**
   * @maxItems 2000
   */
  events: ResearchStrategyEvent[];
  /**
   * @maxItems 8
   */
  allowed_transitions:
    | []
    | [ResearchStrategyStatus]
    | [ResearchStrategyStatus, ResearchStrategyStatus]
    | [ResearchStrategyStatus, ResearchStrategyStatus, ResearchStrategyStatus]
    | [ResearchStrategyStatus, ResearchStrategyStatus, ResearchStrategyStatus, ResearchStrategyStatus]
    | [
        ResearchStrategyStatus,
        ResearchStrategyStatus,
        ResearchStrategyStatus,
        ResearchStrategyStatus,
        ResearchStrategyStatus
      ]
    | [
        ResearchStrategyStatus,
        ResearchStrategyStatus,
        ResearchStrategyStatus,
        ResearchStrategyStatus,
        ResearchStrategyStatus,
        ResearchStrategyStatus
      ]
    | [
        ResearchStrategyStatus,
        ResearchStrategyStatus,
        ResearchStrategyStatus,
        ResearchStrategyStatus,
        ResearchStrategyStatus,
        ResearchStrategyStatus,
        ResearchStrategyStatus
      ]
    | [
        ResearchStrategyStatus,
        ResearchStrategyStatus,
        ResearchStrategyStatus,
        ResearchStrategyStatus,
        ResearchStrategyStatus,
        ResearchStrategyStatus,
        ResearchStrategyStatus,
        ResearchStrategyStatus
      ];
}
export interface ResearchStrategyVersion {
  strategy_id: string;
  version: number;
  ir_hash: string;
  strategy_ir: StrategyIR | null;
  note: string;
  created_at: number;
  /**
   * @maxItems 500
   */
  report_ids: string[];
  /**
   * 「策略 → 版本 → run」链:该版本回测报告引用的 research_runs.id,以及 manifest.request.strategy_ir 同哈希的 run
   *
   * @maxItems 500
   */
  run_ids?: string[];
  /**
   * 研究 loop 修订草稿(research_artifacts 里 view=strategy_draft 且 IR 同哈希)的 artifact id
   *
   * @maxItems 200
   */
  revision_refs?: string[];
  /**
   * 该版本所用 run 的 source_strategy(交易侧 lab 策略库 id@version),只读留痕
   */
  lab_strategy_ref?: string | null;
}
export interface ResearchStrategyEvent {
  at: number;
  kind: ResearchStrategyEventKind;
  from: ResearchStrategyStatus | null;
  to: ResearchStrategyStatus | null;
  version: number | null;
  note: string;
}
export interface ResearchStrategyCreate {
  name: string;
  description?: string;
  symbol?: string;
  timeframe?: string;
  strategy_ir?: StrategyIR;
}
export interface ResearchStrategyPatch {
  name?: string;
  description?: string;
  watchlist?: boolean;
  alerts?: boolean;
}
export interface ResearchStrategyTransition {
  to: ResearchStrategyStatus;
  confirm?: string;
  note?: string;
}
export interface ResearchStrategyBacktestRequest {
  version?: number;
  /**
   * @maxItems 8
   */
  symbols?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string];
  timeframe?: string;
  from_ms?: number;
  to_ms?: number;
}
export interface ResearchStrategyAttachSession {
  session_id: string;
}
export interface ResearchRequest1 {
  idempotency_key: string;
  dataset_id?: string;
  source_strategy_ref?: string;
  policy?: ResearchPolicy;
  execution: ResearchExecution;
  from_ms: number;
  to_ms: number;
  /**
   * @minItems 1
   * @maxItems 3
   */
  arms:
    | ["a_rules" | "b_agent" | "c_filter"]
    | ["a_rules" | "b_agent" | "c_filter", "a_rules" | "b_agent" | "c_filter"]
    | ["a_rules" | "b_agent" | "c_filter", "a_rules" | "b_agent" | "c_filter", "a_rules" | "b_agent" | "c_filter"];
  repeats: number;
  max_model_calls: number;
  timeout_ms: number;
  purpose: "development" | "validation" | "holdout";
  study_id: string;
  parent_run_id?: string;
  acknowledge_adaptive_search: boolean;
  universe_id?: string;
  model_call_timeout_ms?: number;
  strategy_ir?: StrategyIR;
  order_gate?: OrderGateParams;
  /**
   * @maxItems 20
   */
  precheck_overrides?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
  shortlist?: {
    top_n: number;
    by: "composite" | "residual_sharpe";
  };
  spec_version?: string;
}
export interface ResearchPolicy {
  label: string;
  description: string;
  interpretation: "donchian_close_long_v1";
  lookback: number;
  atr_period: number;
  stop_atr: number;
  take_profit_r: number;
  volume_multiple: number;
  holding_bars: number;
}
export interface ResearchExecution {
  initial_cash: string;
  risk_fraction: string;
  max_allocation: string;
  fee_rate: string;
  slippage_bps: string;
  qty_step: string;
  min_notional: string;
  max_opens_per_day: number;
  max_positions?: number;
  allocation?: "equal_risk" | "equal_notional";
  sizing_mode?: "unit_notional" | "risk_fraction";
}
export interface OrderGateParams {
  min_rr: number;
  min_stop_cost_multiple: number;
  max_risk_fraction: string;
  require_target: boolean;
  /**
   * 策略止损窄于成本下限时:widen=把止损放宽到 min_stop_cost_multiple×往返成本(旧缺省),block=直接拦,none=成本下限只作展示、不放宽也不拦(2026-09-23 结构口径缺省)
   */
  stop_floor?: "widen" | "block" | "none";
  /**
   * 策略没给出止盈(结构上方无阻力块)时,用止损距离的固定倍数补止盈;null=不补,直接 no_target
   */
  target_fallback_r?: number | null;
  /**
   * 单笔风险上限适用范围:默认只对 risk_fraction 仓位法;unit_notional 已剔除仓位因素不套
   */
  risk_cap_sizing?: "risk_fraction_only" | "all";
  /**
   * 结构口径(2026-09-23):止损离入场(市价=信号收盘价,限价=挂单价)不到 min_stop_atr×ATR(14,Wilder) 的单子直接不做(blocked stop_too_close),代码不会把止损挪远;缺省 0.5。字段存在(非 null)即启用结构口径:不再用盈亏比拦单(只认 IR 的 order.min_rr)、不放宽止损、不按 R 倍数补止盈
   */
  min_stop_atr?: number | null;
}
export interface ResearchDataset {
  venue: string;
  /**
   * perp = OKX USDT 线性永续成交价 K 线(研究回测永续路径,symbol 用 BTC-USDT-SWAP 形式,不与现货数据集混用)
   */
  market: "spot" | "perp";
  symbol: string;
  timeframe_ms: number;
  source: string;
  retrieved_at: number;
  /**
   * @maxItems 50000
   */
  bars: ResearchBar[];
  calendar?: "crypto_24_7" | "us_equity_rth";
  adjusted?: boolean;
  risk_free_per_bar?: string;
}
export interface ResearchBar {
  open_time: number;
  close_time: number;
  available_at: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}
export interface ResearchFilterDecision {
  action: "follow" | "skip";
  reason: string;
  /**
   * @minItems 1
   * @maxItems 30
   */
  evidence_refs: [string, ...string[]];
}
export interface ResearchChatRequest {
  message: string;
  run_id?: string;
  max_rounds: number;
}
export interface ResearchToolCall {
  tool:
    | "runs.list"
    | "runs.metrics"
    | "runs.trades"
    | "runs.decisions"
    | "runs.compare"
    | "policy.draft"
    | "experiments.run_candidate"
    | "datasets.list"
    | "studies.get"
    | "policies.create"
    | "experiments.start"
    | "strategies.compile"
    | "primitives.list"
    | "research.write_file"
    | "research.execute"
    | "research.read_file"
    | "research.list_files"
    | "research.register_artifact"
    | "strategies.precheck";
  args: {
    [k: string]: unknown;
  };
  task?: string;
  parent_task_id?: string | null;
}
export interface ResearchStudy {
  id: string;
  dataset_id: string;
  from_ms: number;
  development_to_ms: number;
  validation_from_ms: number;
  validation_to_ms: number;
  holdout_from_ms: number;
  to_ms: number;
  purge_bars: number;
  max_trials: number;
}
export interface ResearchUniverseRequest2 {
  /**
   * @minItems 1
   * @maxItems 500
   */
  symbols?: [string, ...string[]];
  timeframe: "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "6h" | "12h" | "1d";
  from_ms: number;
  to_ms: number;
  market_factor: {
    kind: "btc" | "btc_eth_capw" | "equal_weight_universe";
    /**
     * @minItems 1
     * @maxItems 500
     */
    symbols: [string, ...string[]];
  };
  filter?: {
    exchange: string;
    quote: string;
    min_quote_volume_30d: string;
    listed_before_ms: number;
    /**
     * @maxItems 500
     */
    exclude: string[];
  };
}
export interface ResearchUniverse {
  id: string;
  timeframe_ms: number;
  /**
   * @maxItems 500
   */
  members: ResearchUniverseMember[];
  market_factor: ResearchFactorDefinition;
  aligned_bars: number;
  first_at: number;
  last_at: number;
  retrieved_at: number;
  aligned_close_times: number[];
  missing: {
    [k: string]: number[];
  };
  selection_as_of?: number;
  selection_note?: string;
  filter?: {
    exchange: string;
    quote: string;
    min_quote_volume_30d: string;
    listed_before_ms: number;
    /**
     * @maxItems 500
     */
    exclude: string[];
  };
  eligibility?: {
    [k: string]: {
      listed_at: number | null;
      eligible_close_times: number[];
    };
  };
}
export interface ResearchUniverseMember {
  symbol: string;
  dataset_id: string;
  bars: number;
  first_at: number;
  last_at: number;
}
export interface ResearchFactorDefinition {
  kind: "btc" | "btc_eth_capw" | "equal_weight_universe";
  /**
   * @minItems 1
   * @maxItems 500
   */
  symbols: [string, ...string[]];
  weights: {
    [k: string]: string;
  };
  note?: string;
}
export interface ResearchScreen {
  universe_id: string;
  as_of: number;
  window_bars: number;
  lookback_bars: number;
  market_factor: ResearchFactorDefinition;
  rows: ResearchScreenRow[];
  note: string;
}
export interface ResearchScreenRow {
  symbol: string;
  bars: number;
  status: "ok" | "insufficient";
  beta?: number;
  alpha_annualized?: number;
  r2?: number;
  raw?: ResearchFactorMetrics;
  residual?: ResearchFactorMetrics;
  alpha_share?: number | null;
  beta_share?: number | null;
  trend: ResearchTrend;
  momentum_12_1: number | null;
  rank?: {
    residual_sharpe: number;
    alpha_share: number;
    composite: number;
  };
  htf_structure?: ResearchStructure;
}
export interface ResearchFactorMetrics {
  total_return: number;
  max_drawdown: number;
  drawdown_area: number;
  ulcer_index: number;
  sharpe: number | null;
  sortino: number | null;
  information_ratio: number | null;
  volatility: number;
}
export interface ResearchTrend {
  state: "up" | "down" | "range";
  adx: number;
  ema_slope: number;
  donchian_pos: number;
  htf_state: "up" | "down" | "range";
  status: "ok" | "insufficient";
}
export interface ResearchStructure {
  as_of: number | null;
  status: "ok" | "insufficient";
  support: {
    lower: string;
    upper: string;
    formed_at: number;
  } | null;
  resistance: {
    lower: string;
    upper: string;
    formed_at: number;
  } | null;
  position: number | null;
  bos_direction: "up" | "down" | null;
  pivot_low: string | null;
}
export interface ResearchFactorResult {
  status: "ok" | "insufficient";
  beta?: number;
  alpha_per_bar?: number;
  alpha_annualized?: number;
  r2?: number;
  residual_returns?: number[];
  raw?: ResearchFactorMetrics;
  residual?: ResearchFactorMetrics;
  alpha_share?: number | null;
  beta_share?: number | null;
  rolling?: {
    at_index: number;
    beta: number;
    alpha_annualized: number;
    r2: number;
  }[];
  note: string;
}
export interface StrategyCompileRequest2 {
  text?: string;
  ir?: StrategyIR;
  timeframe: string;
  dataset_id?: string;
  execution?: ResearchExecution;
  order_gate?: OrderGateParams;
}
export interface StrategyCompileResult {
  ir: StrategyIR | null;
  /**
   * @maxItems 30
   */
  checks: {
    name: string;
    ok: boolean;
    message?: string;
  }[];
  ok: boolean;
  hash: string | null;
  summary: string;
  /**
   * @maxItems 30
   */
  unmapped: string[];
  constraints?: {
    symbol: string | null;
    timeframe: string;
    round_trip_cost_pct: number;
    stop_floor_pct: number;
    min_rr: number;
    atr_pct_median: number | null;
    min_atr_multiple: number | null;
    strategy_stop_pct_median: number | null;
    stop_fit_rate: number | null;
    note: string;
    /**
     * 结构口径:止损离入场不得小于该倍数×ATR(14),更近的单子不做;null/缺省=旧口径(成本下限+最小盈亏比)
     */
    min_stop_atr?: number | null;
    /**
     * 结构口径:本策略原始止损离收盘不到 min_stop_atr×ATR(14) 的信号比例(这些信号不做)
     */
    stop_too_close_rate?: number | null;
  };
  spec?: StrategySpecReport;
  /**
   * @maxItems 40
   */
  rules?: {
    category: "signal" | "entry" | "stop" | "sizing" | "exit" | "regime";
    primitive: string;
    text: string;
    optional?: boolean;
  }[];
}
export interface StrategySpecReport {
  version: string;
  ok: boolean;
  /**
   * @maxItems 40
   */
  violations: {
    code: string;
    severity: "block" | "warn";
    message: string;
    field?: string;
  }[];
  text: string;
}
export interface ResearchAttribution {
  parent_run_id: string;
  child_run_id: string;
  base_net_return: number;
  child_net_return: number;
  components: {
    section: "signal" | "entry" | "risk" | "exit" | "sizing" | "regime" | "screen";
    changed: boolean;
    solo_net_return: number;
    delta: number;
  }[];
  interaction: number;
  note: string;
}
export interface ResearchRecordedDecision {
  input: ResearchDecisionView;
  input_hash: string;
  output: ResearchAgentAction;
}
export interface ResearchDecisionView {
  at: number;
  arm: string;
  symbol: string;
  timeframe_ms: number;
  bars: ResearchBar[];
  policy: ResearchPolicy;
  candidate: ResearchEntry | null;
  account: {
    cash: string;
    equity: string;
  };
  position: {
    entry_at: number;
    entry_price: string;
    qty: string;
    stop: string;
    target: string | null;
    bars_held: number;
  } | null;
  strategy_ir?: StrategyIR;
  screen?: ResearchScreenRow;
  trend?: ResearchTrend;
  portfolio?: {
    symbol: string;
    holdings: string;
  }[];
  previous_summary: string | null;
  opens_today: number;
  htf_structure?: ResearchStructure;
}
export interface ResearchEntry {
  candidate_id: string;
  stop: string;
  target: string | null;
  target_r?: number;
  screen_rank?: number | null;
  reason: string;
  fit?: Fit;
}
export interface Fit {
  stop_source: "strategy" | "cost_floor";
  target_source: "strategy" | "fallback_r" | "none";
  strategy_stop: string;
  strategy_target: string | null;
  stop_pct: number;
  target_pct: number | null;
  rr: number | null;
  floor_pct: number;
}
export interface ResearchAgentAction {
  action: "enter" | "follow" | "skip" | "hold" | "exit" | "reduce" | "no_trade" | "blocked" | "model_error";
  reason: string;
  gate_errors: string[];
  evidence_refs: string[];
  entry?: ResearchEntry;
}
export interface ResearchPrecheckRequest2 {
  ir: StrategyIR;
  dataset_id?: string;
  universe_id?: string;
  from_ms: number;
  to_ms: number;
  execution: ResearchExecution;
  order_gate?: OrderGateParams;
  thresholds?: {
    min_trades?: number;
    min_gate_pass_rate?: number;
    min_holding_bars?: number;
    min_regime_coverage?: number;
    max_stop_fit_rate?: number;
  };
}
export interface ResearchEquity {
  at: number;
  cash: string;
  holdings: string;
  equity: string;
  exposure: number;
  drawdown: number;
  by_symbol?: {
    [k: string]: string;
  };
}
export interface ResearchTrade {
  id: string;
  candidate_id: string;
  entry_at: number;
  exit_at: number;
  entry_price: string;
  exit_price: string;
  qty: string;
  gross_pnl: string;
  fees: string;
  net_pnl: string;
  initial_risk: string;
  net_r: number | null;
  reason:
    | "stop"
    | "target"
    | "agent_exit"
    | "agent_reduce"
    | "horizon"
    | "trend_break"
    | "time_stop"
    | "fixed_r_target"
    | "chandelier_trail"
    | "swing_structure_stop"
    | "breakeven_after_r"
    | "trail"
    | "structure"
    | "breakeven"
    | "time";
  timing: "open" | "intrabar_unknown";
  position_id: string;
  symbol?: string;
  mae_r?: number | null;
  mfe_r?: number | null;
  holding_bars?: number;
  slippage_est?: string;
  capped?: boolean;
  return_pct?: number;
  fit?: Fit;
  stop?: string;
  target?: string | null;
}
export interface ResearchDecision {
  id: string;
  at: number;
  arm: string;
  candidate_id: string | null;
  action: "enter" | "follow" | "skip" | "hold" | "exit" | "reduce" | "no_trade" | "blocked" | "model_error";
  reason: string;
  input_hash: string;
  decision_hash: string;
  /**
   * @maxItems 100
   */
  evidence_refs: string[];
  /**
   * @maxItems 100
   */
  gate_errors: string[];
  symbol?: string;
  screen_rank?: number | null;
  fit?: Fit;
  /**
   * @maxItems 20
   */
  spec_violations?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
}
export interface ResearchMetrics {
  net_return: number;
  max_drawdown: number;
  avg_exposure: number;
  turnover: number;
  closed_trades: number;
  win_rate: number | null;
  profit_factor: number | null;
  net_pnl: string;
  fees: string;
  open_position: boolean;
  daily_sharpe: number | null;
  sharpe_status: "insufficient" | "estimated";
  avg_net_r: number | null;
  per_trade_return_pct?: {
    avg: number | null;
    median: number | null;
    std: number | null;
    best: number | null;
    worst: number | null;
  };
  expectancy_pct?: number | null;
  trade_return_histogram?: {
    bins: number[];
    counts: number[];
  };
}
export interface ResearchArmResult {
  arm: string;
  metrics: ResearchMetrics;
  /**
   * @maxItems 100000
   */
  decisions: ResearchDecision[];
  /**
   * @maxItems 100000
   */
  trades: ResearchTrade[];
  /**
   * @maxItems 100000
   */
  equity: ResearchEquity[];
  pending_at_end: boolean;
  by_symbol?: ResearchSymbolResult[];
  diagnostics?: ResearchDiagnostics;
}
export interface ResearchSymbolResult {
  symbol: string;
  closed_trades: number;
  net_pnl: string;
  win_rate: number | null;
  avg_net_r: number | null;
  contribution: number | null;
}
export interface ResearchDiagnostics {
  exit_reasons: {
    reason: string;
    count: number;
    avg_net_r: number | null;
    net_pnl: string;
  }[];
  r_histogram: {
    bins: number[];
    counts: number[];
  };
  mae_mfe: {
    avg_mae_r: number | null;
    avg_mfe_r: number | null;
    winners_avg_mfe_r: number | null;
    losers_avg_mfe_r: number | null;
  };
  cost_share: {
    fees: string;
    slippage_est: string;
    gross_pnl: string;
    cost_over_gross_abs: number | null;
  };
  factor: {
    status: "ok" | "insufficient";
    beta?: number | null;
    alpha_annualized?: number | null;
    alpha_share?: number | null;
    beta_share?: number | null;
    residual_max_dd?: number | null;
    residual_sharpe?: number | null;
    r2?: number | null;
  };
  holding_bars: {
    avg: number | null;
    median: number | null;
    max: number | null;
  };
  note?: string;
  gate_stats?: {
    evaluated: number;
    blocked_by: {
      [k: string]: number;
    };
    passed?: number;
    adjusted?: {
      stop_widened: number;
      target_fallback: number;
    };
  };
}
export interface ResearchEvent {
  seq: number;
  run_id: string;
  at: number;
  event: string;
  data: {
    [k: string]: unknown;
  };
}
export interface ResearchPrimitiveDescription {
  name: string;
  category: "signal" | "entry" | "stop" | "sizing" | "exit" | "regime" | "screen";
  params_schema: {
    [k: string]: unknown;
  };
  description: string;
  warmup_note: string;
}
export interface PrimitiveParamsDonchianBreakout {
  lookback: number;
  basis: "close" | "high";
  /**
   * up(缺省)=收盘/最高价突破此前 lookback 根最高价;down=收盘/最低价跌破此前 lookback 根最低价(做空触发,如「跌破 20 日低点」);basis=high 时向下用最低价
   */
  direction?: "up" | "down";
}
export interface PrimitiveParamsVolumeSurge {
  lookback: number;
  multiple: number;
}
export interface PrimitiveParamsEmaCross {
  fast: number;
  slow: number;
}
export interface PrimitiveParamsRsiThreshold {
  period: number;
  threshold: number;
  operator: "above" | "below";
}
export interface PrimitiveParamsHigherLowSequence {
  count: number;
}
export interface PrimitiveParamsMacdCross {
  fast: number;
  slow: number;
  signal: number;
}
export interface PrimitiveParamsMacdDivergence {
  fast: number;
  slow: number;
  signal: number;
  swing_length: number;
  lookback: number;
  source?: "histogram" | "macd";
  /**
   * 可选(2026-09-23 夜):在高周期上判背离。按 htf 把已收盘的执行周期 K 线分桶聚成完整高周期 K 线(未收完的桶不用),背离在高周期 K 线上判,确认那根高周期 K 线收盘的执行周期 K 线当根触发;不受决策视图 5000 根上限约束。缺省 = 在执行周期上判(旧口径)
   */
  htf?: string;
  /**
   * 可选(2026-09-23 夜):bullish(缺省)=底背离(价格更低的已确认 pivot low、MACD 抬高),做多触发;bearish=顶背离(价格更高的已确认 pivot high、MACD 走低),可作 short_signal 做空触发
   */
  direction?: "bullish" | "bearish";
}
export interface PrimitiveParamsMacdDivergenceExit {
  fast: number;
  slow: number;
  signal: number;
  swing_length: number;
  lookback: number;
  source?: "histogram" | "macd";
  /**
   * 可选(2026-09-23 夜):在高周期上判背离。按 htf 把已收盘的执行周期 K 线分桶聚成完整高周期 K 线(未收完的桶不用),背离在高周期 K 线上判,确认那根高周期 K 线收盘的执行周期 K 线当根触发;不受决策视图 5000 根上限约束。缺省 = 在执行周期上判(旧口径)
   */
  htf?: string;
}
export interface PrimitiveParamsPineSeries {
  script_id: string;
  /**
   * @maxItems 16
   */
  inputs?:
    | []
    | [
        {
          name: string;
          value: unknown;
        }
      ]
    | [
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        }
      ]
    | [
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        }
      ]
    | [
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        }
      ]
    | [
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        }
      ]
    | [
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        }
      ]
    | [
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        }
      ]
    | [
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        }
      ]
    | [
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        }
      ]
    | [
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        }
      ]
    | [
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        }
      ]
    | [
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        }
      ]
    | [
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        }
      ]
    | [
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        }
      ]
    | [
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        }
      ]
    | [
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        },
        {
          name: string;
          value: unknown;
        }
      ];
  output: string;
  operator: "above" | "below" | "cross_above" | "cross_below";
  threshold?: number;
  compare_to?: "close" | "zero" | "threshold" | "output";
  compare_output?: string;
  warmup_bars: number;
}
export interface PrimitiveParamsIndicatorCross {
  /**
   * 指标规范名。多输出指标用 output 选线:macd(macd/signal/hist)、adx(adx/plus_di/minus_di)、stoch 与 stochrsi(k/d)、bbands(middle/upper/lower/bandwidth/percent_b)、keltner 与 donchian(middle/upper/lower)、ichimoku(conversion/base/span_a/span_b/lagging/lagging_ref)、supertrend 与 psar(supertrend|psar/direction)、aroon(oscillator/up/down)、vortex(plus/minus)、trix(trix/signal)、elder_ray(bull/bear);其余为单输出,output 省略即可。
   */
  indicator:
    | "ad"
    | "adx"
    | "ao"
    | "aroon"
    | "atr"
    | "bbands"
    | "cci"
    | "chaikin"
    | "chop"
    | "cmf"
    | "dema"
    | "donchian"
    | "elder_ray"
    | "ema"
    | "hma"
    | "ichimoku"
    | "kama"
    | "keltner"
    | "macd"
    | "mfi"
    | "momentum"
    | "natr"
    | "obv"
    | "price"
    | "psar"
    | "roc"
    | "rsi"
    | "sma"
    | "smma"
    | "stdev"
    | "stoch"
    | "stochrsi"
    | "supertrend"
    | "tema"
    | "trix"
    | "uo"
    | "volume_ratio"
    | "vortex"
    | "vwap"
    | "vwma"
    | "willr"
    | "wma";
  /**
   * 指标参数,省略则用目录默认值。各指标用到的键:period 通用周期;period_2/period_3 第二、三周期(KD 的两次平滑、StochRSI 的取值窗口、一目的基准与先行 B、肯特纳的 ATR 周期);fast/slow/signal(MACD、KAMA、AO、Chaikin、UO、TRIX);multiple(布林标准差倍数、肯特纳与超级趋势的 ATR 倍数);step/max_step(抛物线 SAR)。
   */
  args?: {
    period?: number;
    period_2?: number;
    period_3?: number;
    fast?: number;
    slow?: number;
    signal?: number;
    multiple?: number;
    step?: number;
    max_step?: number;
  };
  /**
   * 指标输出线名;省略或不认识时回落到该指标的主输出。
   */
  output?: string;
  /**
   * 被穿越的对象:另一个指标、价格序列或固定常数。
   */
  compare_to: "indicator" | "price" | "constant";
  /**
   * compare_to=indicator 时的第二个指标;省略则复用同一个指标(用 compare_args 换参数,如 SMA50 穿 SMA200)。
   */
  compare_indicator?:
    | "ad"
    | "adx"
    | "ao"
    | "aroon"
    | "atr"
    | "bbands"
    | "cci"
    | "chaikin"
    | "chop"
    | "cmf"
    | "dema"
    | "donchian"
    | "elder_ray"
    | "ema"
    | "hma"
    | "ichimoku"
    | "kama"
    | "keltner"
    | "macd"
    | "mfi"
    | "momentum"
    | "natr"
    | "obv"
    | "price"
    | "psar"
    | "roc"
    | "rsi"
    | "sma"
    | "smma"
    | "stdev"
    | "stoch"
    | "stochrsi"
    | "supertrend"
    | "tema"
    | "trix"
    | "uo"
    | "volume_ratio"
    | "vortex"
    | "vwap"
    | "vwma"
    | "willr"
    | "wma";
  /**
   * 第二条线的指标参数,键同 args。
   */
  compare_args?: {
    period?: number;
    period_2?: number;
    period_3?: number;
    fast?: number;
    slow?: number;
    signal?: number;
    multiple?: number;
    step?: number;
    max_step?: number;
  };
  /**
   * 指标输出线名;省略或不认识时回落到该指标的主输出。
   */
  compare_output?: string;
  /**
   * compare_to=price 时用哪个价格,默认 close。
   */
  compare_price?: "close" | "open" | "high" | "low" | "hl2" | "hlc3" | "ohlc4";
  /**
   * compare_to=constant 时的常数,默认 0(如 MACD 柱上穿 0 轴)。
   */
  constant?: number;
  /**
   * cross_above/cross_below 是单根穿越事件;above/below 是状态(这一根主线在比较线上方/下方即成立),用于「回踩均线挂限价」这类要求持续处于趋势中的入场
   */
  direction: "cross_above" | "cross_below" | "above" | "below";
}
export interface PrimitiveParamsIndicatorCrossExit {
  /**
   * 指标规范名。多输出指标用 output 选线:macd(macd/signal/hist)、adx(adx/plus_di/minus_di)、stoch 与 stochrsi(k/d)、bbands(middle/upper/lower/bandwidth/percent_b)、keltner 与 donchian(middle/upper/lower)、ichimoku(conversion/base/span_a/span_b/lagging/lagging_ref)、supertrend 与 psar(supertrend|psar/direction)、aroon(oscillator/up/down)、vortex(plus/minus)、trix(trix/signal)、elder_ray(bull/bear);其余为单输出,output 省略即可。
   */
  indicator:
    | "ad"
    | "adx"
    | "ao"
    | "aroon"
    | "atr"
    | "bbands"
    | "cci"
    | "chaikin"
    | "chop"
    | "cmf"
    | "dema"
    | "donchian"
    | "elder_ray"
    | "ema"
    | "hma"
    | "ichimoku"
    | "kama"
    | "keltner"
    | "macd"
    | "mfi"
    | "momentum"
    | "natr"
    | "obv"
    | "price"
    | "psar"
    | "roc"
    | "rsi"
    | "sma"
    | "smma"
    | "stdev"
    | "stoch"
    | "stochrsi"
    | "supertrend"
    | "tema"
    | "trix"
    | "uo"
    | "volume_ratio"
    | "vortex"
    | "vwap"
    | "vwma"
    | "willr"
    | "wma";
  /**
   * 指标参数,省略则用目录默认值。各指标用到的键:period 通用周期;period_2/period_3 第二、三周期(KD 的两次平滑、StochRSI 的取值窗口、一目的基准与先行 B、肯特纳的 ATR 周期);fast/slow/signal(MACD、KAMA、AO、Chaikin、UO、TRIX);multiple(布林标准差倍数、肯特纳与超级趋势的 ATR 倍数);step/max_step(抛物线 SAR)。
   */
  args?: {
    period?: number;
    period_2?: number;
    period_3?: number;
    fast?: number;
    slow?: number;
    signal?: number;
    multiple?: number;
    step?: number;
    max_step?: number;
  };
  /**
   * 指标输出线名;省略或不认识时回落到该指标的主输出。
   */
  output?: string;
  /**
   * 被穿越的对象:另一个指标、价格序列或固定常数。
   */
  compare_to: "indicator" | "price" | "constant";
  /**
   * compare_to=indicator 时的第二个指标;省略则复用同一个指标(用 compare_args 换参数,如 SMA50 穿 SMA200)。
   */
  compare_indicator?:
    | "ad"
    | "adx"
    | "ao"
    | "aroon"
    | "atr"
    | "bbands"
    | "cci"
    | "chaikin"
    | "chop"
    | "cmf"
    | "dema"
    | "donchian"
    | "elder_ray"
    | "ema"
    | "hma"
    | "ichimoku"
    | "kama"
    | "keltner"
    | "macd"
    | "mfi"
    | "momentum"
    | "natr"
    | "obv"
    | "price"
    | "psar"
    | "roc"
    | "rsi"
    | "sma"
    | "smma"
    | "stdev"
    | "stoch"
    | "stochrsi"
    | "supertrend"
    | "tema"
    | "trix"
    | "uo"
    | "volume_ratio"
    | "vortex"
    | "vwap"
    | "vwma"
    | "willr"
    | "wma";
  /**
   * 第二条线的指标参数,键同 args。
   */
  compare_args?: {
    period?: number;
    period_2?: number;
    period_3?: number;
    fast?: number;
    slow?: number;
    signal?: number;
    multiple?: number;
    step?: number;
    max_step?: number;
  };
  /**
   * 指标输出线名;省略或不认识时回落到该指标的主输出。
   */
  compare_output?: string;
  /**
   * compare_to=price 时用哪个价格,默认 close。
   */
  compare_price?: "close" | "open" | "high" | "low" | "hl2" | "hlc3" | "ohlc4";
  /**
   * compare_to=constant 时的常数,默认 0(如 MACD 柱上穿 0 轴)。
   */
  constant?: number;
  direction: "cross_above" | "cross_below";
}
export interface PrimitiveParamsIndicatorThreshold {
  /**
   * 指标规范名。多输出指标用 output 选线:macd(macd/signal/hist)、adx(adx/plus_di/minus_di)、stoch 与 stochrsi(k/d)、bbands(middle/upper/lower/bandwidth/percent_b)、keltner 与 donchian(middle/upper/lower)、ichimoku(conversion/base/span_a/span_b/lagging/lagging_ref)、supertrend 与 psar(supertrend|psar/direction)、aroon(oscillator/up/down)、vortex(plus/minus)、trix(trix/signal)、elder_ray(bull/bear);其余为单输出,output 省略即可。
   */
  indicator:
    | "ad"
    | "adx"
    | "ao"
    | "aroon"
    | "atr"
    | "bbands"
    | "cci"
    | "chaikin"
    | "chop"
    | "cmf"
    | "dema"
    | "donchian"
    | "elder_ray"
    | "ema"
    | "hma"
    | "ichimoku"
    | "kama"
    | "keltner"
    | "macd"
    | "mfi"
    | "momentum"
    | "natr"
    | "obv"
    | "price"
    | "psar"
    | "roc"
    | "rsi"
    | "sma"
    | "smma"
    | "stdev"
    | "stoch"
    | "stochrsi"
    | "supertrend"
    | "tema"
    | "trix"
    | "uo"
    | "volume_ratio"
    | "vortex"
    | "vwap"
    | "vwma"
    | "willr"
    | "wma";
  /**
   * 指标参数,省略则用目录默认值。各指标用到的键:period 通用周期;period_2/period_3 第二、三周期(KD 的两次平滑、StochRSI 的取值窗口、一目的基准与先行 B、肯特纳的 ATR 周期);fast/slow/signal(MACD、KAMA、AO、Chaikin、UO、TRIX);multiple(布林标准差倍数、肯特纳与超级趋势的 ATR 倍数);step/max_step(抛物线 SAR)。
   */
  args?: {
    period?: number;
    period_2?: number;
    period_3?: number;
    fast?: number;
    slow?: number;
    signal?: number;
    multiple?: number;
    step?: number;
    max_step?: number;
  };
  /**
   * 指标输出线名;省略或不认识时回落到该指标的主输出。
   */
  output?: string;
  /**
   * above/below 是状态(每根都可能成立),cross_* 是单根事件。
   */
  operator: "above" | "below" | "cross_above" | "cross_below";
  threshold: number;
}
export interface PrimitiveParamsIndicatorThresholdExit {
  /**
   * 指标规范名。多输出指标用 output 选线:macd(macd/signal/hist)、adx(adx/plus_di/minus_di)、stoch 与 stochrsi(k/d)、bbands(middle/upper/lower/bandwidth/percent_b)、keltner 与 donchian(middle/upper/lower)、ichimoku(conversion/base/span_a/span_b/lagging/lagging_ref)、supertrend 与 psar(supertrend|psar/direction)、aroon(oscillator/up/down)、vortex(plus/minus)、trix(trix/signal)、elder_ray(bull/bear);其余为单输出,output 省略即可。
   */
  indicator:
    | "ad"
    | "adx"
    | "ao"
    | "aroon"
    | "atr"
    | "bbands"
    | "cci"
    | "chaikin"
    | "chop"
    | "cmf"
    | "dema"
    | "donchian"
    | "elder_ray"
    | "ema"
    | "hma"
    | "ichimoku"
    | "kama"
    | "keltner"
    | "macd"
    | "mfi"
    | "momentum"
    | "natr"
    | "obv"
    | "price"
    | "psar"
    | "roc"
    | "rsi"
    | "sma"
    | "smma"
    | "stdev"
    | "stoch"
    | "stochrsi"
    | "supertrend"
    | "tema"
    | "trix"
    | "uo"
    | "volume_ratio"
    | "vortex"
    | "vwap"
    | "vwma"
    | "willr"
    | "wma";
  /**
   * 指标参数,省略则用目录默认值。各指标用到的键:period 通用周期;period_2/period_3 第二、三周期(KD 的两次平滑、StochRSI 的取值窗口、一目的基准与先行 B、肯特纳的 ATR 周期);fast/slow/signal(MACD、KAMA、AO、Chaikin、UO、TRIX);multiple(布林标准差倍数、肯特纳与超级趋势的 ATR 倍数);step/max_step(抛物线 SAR)。
   */
  args?: {
    period?: number;
    period_2?: number;
    period_3?: number;
    fast?: number;
    slow?: number;
    signal?: number;
    multiple?: number;
    step?: number;
    max_step?: number;
  };
  /**
   * 指标输出线名;省略或不认识时回落到该指标的主输出。
   */
  output?: string;
  /**
   * above/below 是状态(每根都可能成立),cross_* 是单根事件。
   */
  operator: "above" | "below" | "cross_above" | "cross_below";
  threshold: number;
}
export interface PrimitiveParamsIndicatorDivergence {
  /**
   * 指标规范名。多输出指标用 output 选线:macd(macd/signal/hist)、adx(adx/plus_di/minus_di)、stoch 与 stochrsi(k/d)、bbands(middle/upper/lower/bandwidth/percent_b)、keltner 与 donchian(middle/upper/lower)、ichimoku(conversion/base/span_a/span_b/lagging/lagging_ref)、supertrend 与 psar(supertrend|psar/direction)、aroon(oscillator/up/down)、vortex(plus/minus)、trix(trix/signal)、elder_ray(bull/bear);其余为单输出,output 省略即可。
   */
  indicator:
    | "ad"
    | "adx"
    | "ao"
    | "aroon"
    | "atr"
    | "bbands"
    | "cci"
    | "chaikin"
    | "chop"
    | "cmf"
    | "dema"
    | "donchian"
    | "elder_ray"
    | "ema"
    | "hma"
    | "ichimoku"
    | "kama"
    | "keltner"
    | "macd"
    | "mfi"
    | "momentum"
    | "natr"
    | "obv"
    | "price"
    | "psar"
    | "roc"
    | "rsi"
    | "sma"
    | "smma"
    | "stdev"
    | "stoch"
    | "stochrsi"
    | "supertrend"
    | "tema"
    | "trix"
    | "uo"
    | "volume_ratio"
    | "vortex"
    | "vwap"
    | "vwma"
    | "willr"
    | "wma";
  /**
   * 指标参数,省略则用目录默认值。各指标用到的键:period 通用周期;period_2/period_3 第二、三周期(KD 的两次平滑、StochRSI 的取值窗口、一目的基准与先行 B、肯特纳的 ATR 周期);fast/slow/signal(MACD、KAMA、AO、Chaikin、UO、TRIX);multiple(布林标准差倍数、肯特纳与超级趋势的 ATR 倍数);step/max_step(抛物线 SAR)。
   */
  args?: {
    period?: number;
    period_2?: number;
    period_3?: number;
    fast?: number;
    slow?: number;
    signal?: number;
    multiple?: number;
    step?: number;
    max_step?: number;
  };
  /**
   * 指标输出线名;省略或不认识时回落到该指标的主输出。
   */
  output?: string;
  swing_length: number;
  lookback: number;
}
export interface PrimitiveParamsIndicatorDivergenceExit {
  /**
   * 指标规范名。多输出指标用 output 选线:macd(macd/signal/hist)、adx(adx/plus_di/minus_di)、stoch 与 stochrsi(k/d)、bbands(middle/upper/lower/bandwidth/percent_b)、keltner 与 donchian(middle/upper/lower)、ichimoku(conversion/base/span_a/span_b/lagging/lagging_ref)、supertrend 与 psar(supertrend|psar/direction)、aroon(oscillator/up/down)、vortex(plus/minus)、trix(trix/signal)、elder_ray(bull/bear);其余为单输出,output 省略即可。
   */
  indicator:
    | "ad"
    | "adx"
    | "ao"
    | "aroon"
    | "atr"
    | "bbands"
    | "cci"
    | "chaikin"
    | "chop"
    | "cmf"
    | "dema"
    | "donchian"
    | "elder_ray"
    | "ema"
    | "hma"
    | "ichimoku"
    | "kama"
    | "keltner"
    | "macd"
    | "mfi"
    | "momentum"
    | "natr"
    | "obv"
    | "price"
    | "psar"
    | "roc"
    | "rsi"
    | "sma"
    | "smma"
    | "stdev"
    | "stoch"
    | "stochrsi"
    | "supertrend"
    | "tema"
    | "trix"
    | "uo"
    | "volume_ratio"
    | "vortex"
    | "vwap"
    | "vwma"
    | "willr"
    | "wma";
  /**
   * 指标参数,省略则用目录默认值。各指标用到的键:period 通用周期;period_2/period_3 第二、三周期(KD 的两次平滑、StochRSI 的取值窗口、一目的基准与先行 B、肯特纳的 ATR 周期);fast/slow/signal(MACD、KAMA、AO、Chaikin、UO、TRIX);multiple(布林标准差倍数、肯特纳与超级趋势的 ATR 倍数);step/max_step(抛物线 SAR)。
   */
  args?: {
    period?: number;
    period_2?: number;
    period_3?: number;
    fast?: number;
    slow?: number;
    signal?: number;
    multiple?: number;
    step?: number;
    max_step?: number;
  };
  /**
   * 指标输出线名;省略或不认识时回落到该指标的主输出。
   */
  output?: string;
  swing_length: number;
  lookback: number;
}
export interface PrimitiveParamsDoubleBottom {
  swing_length: number;
  lookback: number;
  /**
   * 两个对称极值之间允许的价格偏差百分比。
   */
  tolerance_pct: number;
}
export interface PrimitiveParamsDoubleTopExit {
  swing_length: number;
  lookback: number;
  /**
   * 两个对称极值之间允许的价格偏差百分比。
   */
  tolerance_pct: number;
}
export interface PrimitiveParamsHeadAndShouldersInverse {
  swing_length: number;
  lookback: number;
  /**
   * 两个对称极值之间允许的价格偏差百分比。
   */
  tolerance_pct: number;
}
export interface PrimitiveParamsBullishEngulfing {
  /**
   * 当根实体至少是前一根实体的多少倍。
   */
  min_body_ratio: number;
}
export interface PrimitiveParamsBearishEngulfingExit {
  /**
   * 当根实体至少是前一根实体的多少倍。
   */
  min_body_ratio: number;
}
export interface PrimitiveParamsPinBar {
  /**
   * 下影至少是实体的多少倍。
   */
  tail_ratio: number;
  /**
   * 实体占整根振幅的上限。
   */
  max_body_pct: number;
  /**
   * 上影占整根振幅的上限。
   */
  max_upper_pct: number;
}
export interface PrimitiveParamsFairValueGap {
  /**
   * 缺口宽度相对收盘价的百分比下限。
   */
  min_gap_pct: number;
}
export interface PrimitiveParamsInsideBarBreakout {
  /**
   * 母线之后最多回溯多少根内包线。
   */
  max_inside_bars: number;
}
export interface PrimitiveParamsNextOpenMarket {}
export interface PrimitiveParamsAtrStop {
  atr_period: number;
  multiple: number;
}
export interface PrimitiveParamsSwingLowStop {
  lookback: number;
}
export interface PrimitiveParamsChandelierTrail {
  atr_period: number;
  multiple: number;
}
export interface PrimitiveParamsSwingStructureStop {
  lookback: number;
}
export interface PrimitiveParamsTrendBreak {
  ema_period: number;
  htf: string;
}
export interface PrimitiveParamsBreakevenAfterR {
  r: number;
}
export interface PrimitiveParamsTimeStop {
  bars: number;
}
export interface PrimitiveParamsFixedRTarget {
  r: number;
}
export interface PrimitiveParamsRiskFraction {
  fraction: string;
  max_allocation: string;
}
export interface PrimitiveParamsEqualNotional {
  max_allocation: string;
}
/**
 * 波动率目标仓位(2026-09-23):每笔 100% 可用资金 × min(1, target_vol / 入场前已收盘 K 线的实现年化波动);lookback_bars 缺省 = 20 天折算根数
 */
export interface PrimitiveParamsVolTarget {
  target_vol: number;
  lookback_bars?: number;
}
export interface PrimitiveParamsResidualSharpeMin {
  minimum: number;
}
export interface PrimitiveParamsBetaMax {
  maximum: number;
}
export interface PrimitiveParamsTrendRequired {
  /**
   * @maxItems 30
   */
  states: ("up" | "down" | "range")[];
}
export interface PrimitiveParamsTrendState {
  adx_period: number;
  adx_min: number;
  ema_fast: number;
  ema_slow: number;
  htf: string;
}
/**
 * 高周期均线状态(2026-09-23 夜,regime):最近一根已收盘的 htf K 线收盘价在其 MA(period) 之上(side=above)/之下(side=below)。高周期 K 线由已收盘的执行周期 K 线按 htf 分桶聚成,只用完整的桶;从整段已收盘 K 线计算,不受决策视图 5000 根上限约束。可作 regime(做多)与 order.short_regime(做空)
 */
export interface PrimitiveParamsHtfMaState {
  /**
   * 高周期,必须 ≥ 执行周期且可整除,如 1d / 4h
   */
  htf: string;
  /**
   * 均线周期(高周期根数),如 60 = 日线 MA60
   */
  period: number;
  /**
   * 缺省 sma
   */
  ma?: "sma" | "ema";
  /**
   * 缺省 above;做空方向门用 below
   */
  side?: "above" | "below";
}
export interface PrimitiveParamsStructurePivots {
  swing_length: number;
  confirmation?: "close" | "wick";
  zone?: "body" | "wick";
}
export interface PrimitiveParamsStructureBos {
  swing_length: number;
  confirmation?: "close" | "wick";
  zone?: "body" | "wick";
}
export interface PrimitiveParamsOrderBlocks {
  swing_length: number;
  confirmation?: "close" | "wick";
  zone?: "body" | "wick";
}
export interface PrimitiveParamsHtfStructure {
  swing_length: number;
  confirmation?: "close" | "wick";
  zone?: "body" | "wick";
  htf?: string;
}
export interface PrimitiveParamsStructureTarget {
  swing_length: number;
  confirmation?: "close" | "wick";
  zone?: "body" | "wick";
  htf?: string;
}
export interface PrimitiveParamsPivotTarget {
  /**
   * 确认 pivot 左右各几根(与几何实验室 pivots(L=R) 同定义,最右等值为准)
   */
  swing_length: number;
  /**
   * 在最近多少根里找摆动高点,缺省 480(与几何实验室视图一致)
   */
  lookback?: number;
  /**
   * 目标离入场至少几倍 ATR(14),缺省 1
   */
  min_atr?: number;
  /**
   * 目标离入场至多几倍 ATR(14),缺省 6;更远视为图上没有近端目标,不设止盈
   */
  max_atr?: number;
  /**
   * 只取之后没被扫过(没有更高的高点越过)的摆动高点,缺省 true;false 时与几何实验室 arm A 的目标同一规则
   */
  unswept?: boolean;
  /**
   * ATR 周期,缺省 14(Wilder)
   */
  atr_period?: number;
}
export interface PrimitiveParamsPivotStop {
  /**
   * 确认 pivot 左右各几根(与几何实验室 pivots(L=R) 同定义)
   */
  swing_length: number;
  /**
   * recent(缺省)=按时间最近的一个摆动低点(上一个更高低点);nearest=价格最接近收盘的摆动低点(= 几何实验室 D 臂菜单 1h swing low #1)
   */
  pick?: "recent" | "nearest";
  /**
   * 在最近多少根里找摆动低点,缺省 480
   */
  lookback?: number;
  /**
   * 摆动低点下方再让出几倍 ATR(14),缺省 0.1(几何实验室同口径)
   */
  buffer_atr?: number;
  /**
   * 视图里没有低于现价的已确认摆动低点时,退回最近 N 根最低价(再减缓冲),缺省 10
   */
  fallback_lookback?: number;
  /**
   * ATR 周期,缺省 14(Wilder)
   */
  atr_period?: number;
}
export interface ResearchPrecheckResult {
  ok: boolean;
  items: {
    name: string;
    ok: boolean;
    value: number | null;
    threshold?: number;
    note?: string;
  }[];
  suggestions: string[];
}
export interface ResearchAsset {
  symbol: string;
  exchange: string;
  ccxt_symbol: string;
  quote: string;
  first_available_at: number | null;
  quote_volume_30d: string | null;
  volume_bars: number;
  status: "ok" | "unavailable";
  note?: string;
}
export interface ResearchArtifactSummary {
  id: string;
  kind: "chart" | "table" | "markdown";
  title: string;
}
export interface ResearchArtifact {
  id: string;
  chat_id: string;
  run_id: string | null;
  kind: "chart" | "table" | "markdown";
  title: string;
  content: unknown;
  created_at: number;
}
export interface ResearchChatTask {
  id: string;
  parent_id: string | null;
  title: string;
  status: "running" | "done" | "failed";
  detail: string;
}
export interface ResearchChatEvent {
  chat_id: string;
  seq: number;
  at: number;
  event: "task" | "tool" | "artifact" | "final" | "error";
  data: unknown;
}
export interface PrimitiveParamsHtfStructureRegime {
  htf: string;
  swing_length: number;
  confirmation?: "close" | "wick";
  zone?: "body" | "wick";
  /**
   * 当前价在高周期支撑块上沿到阻力块下沿之间的位置上限(0=贴支撑,1=贴阻力);高于此值离阻力太近不做多
   */
  max_position?: number;
  /**
   * 是否要求高周期最近一次结构突破向上(BOS up / CHoCH up)
   */
  require_bos?: boolean;
}
export interface PrimitiveParamsIndicatorLevel {
  /**
   * 指标规范名。多输出指标用 output 选线:macd(macd/signal/hist)、adx(adx/plus_di/minus_di)、stoch 与 stochrsi(k/d)、bbands(middle/upper/lower/bandwidth/percent_b)、keltner 与 donchian(middle/upper/lower)、ichimoku(conversion/base/span_a/span_b/lagging/lagging_ref)、supertrend 与 psar(supertrend|psar/direction)、aroon(oscillator/up/down)、vortex(plus/minus)、trix(trix/signal)、elder_ray(bull/bear);其余为单输出,output 省略即可。
   */
  indicator:
    | "ad"
    | "adx"
    | "ao"
    | "aroon"
    | "atr"
    | "bbands"
    | "cci"
    | "chaikin"
    | "chop"
    | "cmf"
    | "dema"
    | "donchian"
    | "elder_ray"
    | "ema"
    | "hma"
    | "ichimoku"
    | "kama"
    | "keltner"
    | "macd"
    | "mfi"
    | "momentum"
    | "natr"
    | "obv"
    | "price"
    | "psar"
    | "roc"
    | "rsi"
    | "sma"
    | "smma"
    | "stdev"
    | "stoch"
    | "stochrsi"
    | "supertrend"
    | "tema"
    | "trix"
    | "uo"
    | "volume_ratio"
    | "vortex"
    | "vwap"
    | "vwma"
    | "willr"
    | "wma";
  /**
   * 指标参数,省略则用目录默认值。各指标用到的键:period 通用周期;period_2/period_3 第二、三周期(KD 的两次平滑、StochRSI 的取值窗口、一目的基准与先行 B、肯特纳的 ATR 周期);fast/slow/signal(MACD、KAMA、AO、Chaikin、UO、TRIX);multiple(布林标准差倍数、肯特纳与超级趋势的 ATR 倍数);step/max_step(抛物线 SAR)。
   */
  args?: {
    period?: number;
    period_2?: number;
    period_3?: number;
    fast?: number;
    slow?: number;
    signal?: number;
    multiple?: number;
    step?: number;
    max_step?: number;
  };
  /**
   * 指标输出线名;省略或不认识时回落到该指标的主输出。
   */
  output?: string;
  /**
   * 止损角色时向外让出的 ATR 倍数(多单往下、空单往上),缺省 0
   */
  buffer_atr?: number;
  /**
   * buffer_atr 用的 ATR 周期,缺省 14
   */
  atr_period?: number;
}
export interface PrimitiveParamsStructureLevel {
  swing_length: number;
  confirmation?: "close" | "wick";
  zone?: "body" | "wick";
  /**
   * 结构所在周期,缺省为基础周期
   */
  htf?: string;
  /**
   * 止损角色时向外让出的 ATR 倍数(多单往下、空单往上),缺省 0
   */
  buffer_atr?: number;
  /**
   * buffer_atr 用的 ATR 周期,缺省 14
   */
  atr_period?: number;
}
export interface PrimitiveParamsAtrOffsetLevel {
  atr_period: number;
  multiple: number;
}
export interface PrimitiveParamsPctOffsetLevel {
  /**
   * 相对收盘价的比例,小数(0.02=2%)
   */
  pct: number;
}
/**
 * 用户明确说不设止损时用;止损价放在收盘价的 0.01%(等于不触发),风险 R 不再有意义
 */
export interface PrimitiveParamsNoStop {}
export interface PrimitiveParamsSmcBos {
  /**
   * 结构级别:internal 内部结构 / swing 摆动结构,缺省 internal
   */
  scope?: "internal" | "swing";
  /**
   * 方向:bullish 看涨(缺省)/ bearish 看跌
   */
  direction?: "bullish" | "bearish";
  /**
   * bos 顺势突破 / choch 反转突破 / any 都算(缺省)
   */
  kind?: "bos" | "choch" | "any";
  /**
   * 内部结构 pivot 左右各几根,缺省 5
   */
  internal_length?: number;
  /**
   * 摆动结构 pivot 左右各几根,缺省 50
   */
  swing_length?: number;
  /**
   * 结构突破确认口径:收盘(缺省)或影线
   */
  confirmation?: "close" | "wick";
  /**
   * 订单块失效口径:影线穿过远端(缺省)或收盘穿过
   */
  mitigation?: "close" | "wick";
  /**
   * 挑订单块 K 线时剔除高波动 K 线:振幅 ≥ 2×ATR(缺省)/ ≥ 2×累计平均振幅 / 不过滤
   */
  ob_filter?: "atr" | "range" | "none";
  /**
   * 高波动过滤、等高等低容差与止损缓冲用的 ATR 周期,缺省 200
   */
  atr_period?: number;
  /**
   * 等高等低 pivot 左右各几根,缺省 3
   */
  eq_length?: number;
  /**
   * 等高等低容差 = eq_threshold × ATR,缺省 0.1
   */
  eq_threshold?: number;
  /**
   * FVG 自动阈值:缺口幅度不小于迄今平均缺口幅度才保留,缺省 true
   */
  fvg_auto?: boolean;
}
export interface PrimitiveParamsSmcObRetest {
  /**
   * 结构级别:internal 内部结构 / swing 摆动结构,缺省 internal
   */
  scope?: "internal" | "swing";
  /**
   * 方向:bullish 看涨(缺省)/ bearish 看跌
   */
  direction?: "bullish" | "bearish";
  /**
   * 内部结构 pivot 左右各几根,缺省 5
   */
  internal_length?: number;
  /**
   * 摆动结构 pivot 左右各几根,缺省 50
   */
  swing_length?: number;
  /**
   * 结构突破确认口径:收盘(缺省)或影线
   */
  confirmation?: "close" | "wick";
  /**
   * 订单块失效口径:影线穿过远端(缺省)或收盘穿过
   */
  mitigation?: "close" | "wick";
  /**
   * 挑订单块 K 线时剔除高波动 K 线:振幅 ≥ 2×ATR(缺省)/ ≥ 2×累计平均振幅 / 不过滤
   */
  ob_filter?: "atr" | "range" | "none";
  /**
   * 高波动过滤、等高等低容差与止损缓冲用的 ATR 周期,缺省 200
   */
  atr_period?: number;
  /**
   * 等高等低 pivot 左右各几根,缺省 3
   */
  eq_length?: number;
  /**
   * 等高等低容差 = eq_threshold × ATR,缺省 0.1
   */
  eq_threshold?: number;
  /**
   * FVG 自动阈值:缺口幅度不小于迄今平均缺口幅度才保留,缺省 true
   */
  fvg_auto?: boolean;
}
export interface PrimitiveParamsSmcFvgFill {
  /**
   * 方向:bullish 看涨(缺省)/ bearish 看跌
   */
  direction?: "bullish" | "bearish";
  /**
   * touch 首次触及缺口(缺省)/ fill 完全回补到缺口远端
   */
  mode?: "touch" | "fill";
  /**
   * 内部结构 pivot 左右各几根,缺省 5
   */
  internal_length?: number;
  /**
   * 摆动结构 pivot 左右各几根,缺省 50
   */
  swing_length?: number;
  /**
   * 结构突破确认口径:收盘(缺省)或影线
   */
  confirmation?: "close" | "wick";
  /**
   * 订单块失效口径:影线穿过远端(缺省)或收盘穿过
   */
  mitigation?: "close" | "wick";
  /**
   * 挑订单块 K 线时剔除高波动 K 线:振幅 ≥ 2×ATR(缺省)/ ≥ 2×累计平均振幅 / 不过滤
   */
  ob_filter?: "atr" | "range" | "none";
  /**
   * 高波动过滤、等高等低容差与止损缓冲用的 ATR 周期,缺省 200
   */
  atr_period?: number;
  /**
   * 等高等低 pivot 左右各几根,缺省 3
   */
  eq_length?: number;
  /**
   * 等高等低容差 = eq_threshold × ATR,缺省 0.1
   */
  eq_threshold?: number;
  /**
   * FVG 自动阈值:缺口幅度不小于迄今平均缺口幅度才保留,缺省 true
   */
  fvg_auto?: boolean;
}
export interface PrimitiveParamsSmcDiscount {
  /**
   * discount 折价区(区间下半,缺省)/ premium 溢价区(上半)/ equilibrium 均衡区(中线 ±2.5%)
   */
  zone?: "discount" | "premium" | "equilibrium";
  /**
   * 内部结构 pivot 左右各几根,缺省 5
   */
  internal_length?: number;
  /**
   * 摆动结构 pivot 左右各几根,缺省 50
   */
  swing_length?: number;
  /**
   * 结构突破确认口径:收盘(缺省)或影线
   */
  confirmation?: "close" | "wick";
  /**
   * 订单块失效口径:影线穿过远端(缺省)或收盘穿过
   */
  mitigation?: "close" | "wick";
  /**
   * 挑订单块 K 线时剔除高波动 K 线:振幅 ≥ 2×ATR(缺省)/ ≥ 2×累计平均振幅 / 不过滤
   */
  ob_filter?: "atr" | "range" | "none";
  /**
   * 高波动过滤、等高等低容差与止损缓冲用的 ATR 周期,缺省 200
   */
  atr_period?: number;
  /**
   * 等高等低 pivot 左右各几根,缺省 3
   */
  eq_length?: number;
  /**
   * 等高等低容差 = eq_threshold × ATR,缺省 0.1
   */
  eq_threshold?: number;
  /**
   * FVG 自动阈值:缺口幅度不小于迄今平均缺口幅度才保留,缺省 true
   */
  fvg_auto?: boolean;
}
export interface PrimitiveParamsSmcTrend {
  /**
   * 结构级别:internal 内部结构 / swing 摆动结构,缺省 swing
   */
  scope?: "internal" | "swing";
  /**
   * 方向:bullish 看涨(缺省)/ bearish 看跌
   */
  direction?: "bullish" | "bearish";
  /**
   * 内部结构 pivot 左右各几根,缺省 5
   */
  internal_length?: number;
  /**
   * 摆动结构 pivot 左右各几根,缺省 50
   */
  swing_length?: number;
  /**
   * 结构突破确认口径:收盘(缺省)或影线
   */
  confirmation?: "close" | "wick";
  /**
   * 订单块失效口径:影线穿过远端(缺省)或收盘穿过
   */
  mitigation?: "close" | "wick";
  /**
   * 挑订单块 K 线时剔除高波动 K 线:振幅 ≥ 2×ATR(缺省)/ ≥ 2×累计平均振幅 / 不过滤
   */
  ob_filter?: "atr" | "range" | "none";
  /**
   * 高波动过滤、等高等低容差与止损缓冲用的 ATR 周期,缺省 200
   */
  atr_period?: number;
  /**
   * 等高等低 pivot 左右各几根,缺省 3
   */
  eq_length?: number;
  /**
   * 等高等低容差 = eq_threshold × ATR,缺省 0.1
   */
  eq_threshold?: number;
  /**
   * FVG 自动阈值:缺口幅度不小于迄今平均缺口幅度才保留,缺省 true
   */
  fvg_auto?: boolean;
}
export interface PrimitiveParamsSmcObLevel {
  /**
   * 结构级别:internal 内部结构 / swing 摆动结构,缺省 internal
   */
  scope?: "internal" | "swing";
  /**
   * 止损角色向外让出的 ATR 倍数,缺省 0
   */
  buffer_atr?: number;
  /**
   * 内部结构 pivot 左右各几根,缺省 5
   */
  internal_length?: number;
  /**
   * 摆动结构 pivot 左右各几根,缺省 50
   */
  swing_length?: number;
  /**
   * 结构突破确认口径:收盘(缺省)或影线
   */
  confirmation?: "close" | "wick";
  /**
   * 订单块失效口径:影线穿过远端(缺省)或收盘穿过
   */
  mitigation?: "close" | "wick";
  /**
   * 挑订单块 K 线时剔除高波动 K 线:振幅 ≥ 2×ATR(缺省)/ ≥ 2×累计平均振幅 / 不过滤
   */
  ob_filter?: "atr" | "range" | "none";
  /**
   * 高波动过滤、等高等低容差与止损缓冲用的 ATR 周期,缺省 200
   */
  atr_period?: number;
  /**
   * 等高等低 pivot 左右各几根,缺省 3
   */
  eq_length?: number;
  /**
   * 等高等低容差 = eq_threshold × ATR,缺省 0.1
   */
  eq_threshold?: number;
  /**
   * FVG 自动阈值:缺口幅度不小于迄今平均缺口幅度才保留,缺省 true
   */
  fvg_auto?: boolean;
}
export interface PrimitiveParamsSmcLiquidityTarget {
  /**
   * 结构级别:internal 内部结构 / swing 摆动结构,缺省 swing
   */
  scope?: "internal" | "swing";
  /**
   * 止盈来源:liquidity 最近的流动性(未扫 pivot/等高点/区间顶取最近,缺省)/ swing 未扫 pivot / equal 等高(低)点 / premium 溢价区(空单为折价区)/ prev_day 前日高(低)/ prev_week 前周高(低)
   */
  source?: "liquidity" | "swing" | "equal" | "premium" | "prev_day" | "prev_week";
  /**
   * 内部结构 pivot 左右各几根,缺省 5
   */
  internal_length?: number;
  /**
   * 摆动结构 pivot 左右各几根,缺省 50
   */
  swing_length?: number;
  /**
   * 结构突破确认口径:收盘(缺省)或影线
   */
  confirmation?: "close" | "wick";
  /**
   * 订单块失效口径:影线穿过远端(缺省)或收盘穿过
   */
  mitigation?: "close" | "wick";
  /**
   * 挑订单块 K 线时剔除高波动 K 线:振幅 ≥ 2×ATR(缺省)/ ≥ 2×累计平均振幅 / 不过滤
   */
  ob_filter?: "atr" | "range" | "none";
  /**
   * 高波动过滤、等高等低容差与止损缓冲用的 ATR 周期,缺省 200
   */
  atr_period?: number;
  /**
   * 等高等低 pivot 左右各几根,缺省 3
   */
  eq_length?: number;
  /**
   * 等高等低容差 = eq_threshold × ATR,缺省 0.1
   */
  eq_threshold?: number;
  /**
   * FVG 自动阈值:缺口幅度不小于迄今平均缺口幅度才保留,缺省 true
   */
  fvg_auto?: boolean;
}
export interface PrimitiveParamsSmcChochExit {
  /**
   * 结构级别:internal 内部结构 / swing 摆动结构,缺省 internal
   */
  scope?: "internal" | "swing";
  /**
   * choch 只认反向 CHoCH(缺省)/ any 反向 BOS 也离场
   */
  kind?: "choch" | "any";
  /**
   * 内部结构 pivot 左右各几根,缺省 5
   */
  internal_length?: number;
  /**
   * 摆动结构 pivot 左右各几根,缺省 50
   */
  swing_length?: number;
  /**
   * 结构突破确认口径:收盘(缺省)或影线
   */
  confirmation?: "close" | "wick";
  /**
   * 订单块失效口径:影线穿过远端(缺省)或收盘穿过
   */
  mitigation?: "close" | "wick";
  /**
   * 挑订单块 K 线时剔除高波动 K 线:振幅 ≥ 2×ATR(缺省)/ ≥ 2×累计平均振幅 / 不过滤
   */
  ob_filter?: "atr" | "range" | "none";
  /**
   * 高波动过滤、等高等低容差与止损缓冲用的 ATR 周期,缺省 200
   */
  atr_period?: number;
  /**
   * 等高等低 pivot 左右各几根,缺省 3
   */
  eq_length?: number;
  /**
   * 等高等低容差 = eq_threshold × ATR,缺省 0.1
   */
  eq_threshold?: number;
  /**
   * FVG 自动阈值:缺口幅度不小于迄今平均缺口幅度才保留,缺省 true
   */
  fvg_auto?: boolean;
}
/**
 * 回放图层(GET /api/research/backtests/:id/replay?overlay=smc 的 smc_overlay 字段):时间一律为 K 线 open_time(ms)
 */
export interface SmcOverlay {
  params: {
    [k: string]: unknown;
  };
  structures: {
    at: number;
    from: number;
    level: number;
    kind: "BOS" | "CHoCH";
    scope: "internal" | "swing";
    dir: "bullish" | "bearish";
  }[];
  order_blocks: {
    from: number;
    formed_at: number;
    to: number | null;
    top: number;
    bottom: number;
    dir: "bullish" | "bearish";
    scope: "internal" | "swing";
    mitigated_at: number | null;
  }[];
  fvgs: {
    from: number;
    formed_at: number;
    top: number;
    bottom: number;
    dir: "bullish" | "bearish";
    touched_at: number | null;
    filled_at: number | null;
  }[];
  eq: {
    kind: "EQH" | "EQL";
    from: number;
    to: number;
    level: number;
    confirmed_at: number;
    swept_at: number | null;
  }[];
  zones: {
    from: number;
    to: number;
    premium: {
      top: number;
      bottom: number;
    };
    equilibrium: {
      top: number;
      bottom: number;
    };
    discount: {
      top: number;
      bottom: number;
    };
    strong_high: boolean;
    strong_low: boolean;
  } | null;
  htf_levels: {
    kind: "PDH" | "PDL" | "PWH" | "PWL";
    from: number;
    to: number;
    level: number;
  }[];
  trend: {
    internal: ("bullish" | "bearish") | null;
    swing: ("bullish" | "bearish") | null;
  };
}
export interface FrozenModelProfile {
  ref: string;
  connection_id: string;
  connection_revision: string;
  model: string;
  model_revision: string;
  routing: string;
  /**
   * v1: sum tolerance 1e-6 unchanged. v2: |sum-1| <= 0.01 (+1e-12 numeric epsilon), normalize by sum; explicit opt-in only after raw diagnostics.
   */
  parser_version: "judge_answers_v1" | "judge_answers_v2_rounding_001";
  max_call_usd: string;
  retry_policy: "none";
}
export interface JudgeCandidateSnapshot {
  id: string;
  symbol: string;
  as_of: number;
  timeframe_ms: number;
  direction: "long" | "short";
  entry: string;
  stop: string;
  target: string | null;
  reward_risk: number | null;
}
export interface JudgeStateV1 {
  version: "judge_state_v1";
  as_of: number;
  timeframe_ms: number;
  candidate: {
    direction?: "long" | "short";
    stop_distance_atr?: number;
    reward_risk?: number;
    reference?: string;
    support?: string;
    resistance?: string;
    stop?: string;
    target?: string;
  };
  features: {
    trend?: "up" | "down";
    volatility?: number;
    volume_ratio?: number;
    funding?: number;
    market_regime?: "up" | "down" | "volatile";
    /**
     * live_only: requires as-of recorded coverage; unavailable is not zero.
     */
    ob_imbalance_05?: number;
    /**
     * live_only: requires as-of recorded coverage; unavailable is not zero.
     */
    ob_wall_up?: {
      price: string;
      notional: string;
    };
    /**
     * live_only: requires as-of recorded coverage; unavailable is not zero.
     */
    ob_wall_down?: {
      price: string;
      notional: string;
    };
    /**
     * live_only: requires as-of recorded coverage; unavailable is not zero.
     */
    spread_bps?: number;
    /**
     * live_only: requires as-of recorded coverage; unavailable is not zero.
     */
    liq_long_5m?: string;
    /**
     * live_only: requires as-of recorded coverage; unavailable is not zero.
     */
    liq_short_5m?: string;
  };
}
export interface NormalizedAnswer {
  question_key: string;
  probabilities: {
    [k: string]: number;
  };
}
export interface PredicateEvaluation {
  question_key: string;
  label: string;
  probability: number;
  conservative: number;
  passed: boolean;
}
export interface JudgeResult {
  status: "ok" | "uncertain" | "error";
  action: "follow" | "skip";
  decision_id: string;
  state_hash: string;
  request_hash: string;
  raw_response_ref: string | null;
  answers: NormalizedAnswer[];
  predicates: PredicateEvaluation[];
  model_revision: string | null;
  latency_ms: number;
  cost_usd: string | null;
  cost_status: "actual" | "estimated" | "unknown";
  reason_codes: string[];
}
export interface RpcRequest {
  jsonrpc: "2.0";
  id: RpcId;
  method: Method;
  params: {};
}
export interface RpcSuccess {
  jsonrpc: "2.0";
  id: RpcId;
  result: {};
}
export interface RpcFailure {
  jsonrpc: "2.0";
  id: RpcId | null;
  error: RpcError;
}
export interface RpcError {
  code: number;
  message: string;
  data: RpcErrorData;
}
export interface RpcErrorData {
  kind: ErrorKind;
  retryable: boolean;
  details?: {};
}
export interface RpcNotification {
  jsonrpc: "2.0";
  method: "exec.event";
  params: ExecEvent;
}
export interface ChannelHealth {
  state: "ok" | "degraded" | "down" | "unconfigured";
  detail?: string;
  last_ok_at?: TimestampMs;
}
export interface HealthParams {}
export interface HealthResult {
  ok: boolean;
  version: string;
  writer_instance_id: string;
  lease_epoch: number;
  started_at: TimestampMs;
  now: TimestampMs;
  db_ok: boolean;
  mode: PolicyMode;
  halted: boolean;
  open_intents: number;
  unknown_attempts: number;
  channels: {
    main: ChannelHealth;
    sub: ChannelHealth;
  };
}
export interface IntentProposeParams {
  account: AccountRef;
  principal: Principal;
  surface: Surface;
  session_id?: string;
  run_id?: string;
  origin?: string;
  idempotency_key?: string;
  params: IntentParams;
  ttl_seconds?: number;
}
export interface IntentProposeResult {
  intent: Intent;
  plan?: ExecutableOrderPlan;
  gate_rejections: GateRejection[];
}
export interface IntentGetParams {
  intent_id: Uuid;
}
export interface IntentBundle {
  intent: Intent;
  plan?: ExecutableOrderPlan;
  authorization?: Authorization;
  attempts: ExecutionAttempt[];
  orders: ExchangeOrderObservation[];
  fills: Fill[];
  effect?: PositionEffect;
}
export interface IntentListParams {
  status?: IntentStatus[];
  account?: AccountRef;
  kind?: IntentKind;
  since?: TimestampMs;
  limit?: number;
}
export interface IntentListResult {
  intents: Intent[];
}
/**
 * 只接受 principal=user;plan_hash 或 confirm_echo 与当前 plan 不符 → conflict
 */
export interface IntentAuthorizeParams {
  intent_id: Uuid;
  plan_hash: Hash256;
  principal: Principal;
  surface: Surface;
  actor_ref?: string;
  confirm_echo: {
    [k: string]: string;
  };
}
export interface IntentAuthorizeResult {
  intent: Intent;
  authorization: Authorization;
}
export interface IntentRejectParams {
  intent_id: Uuid;
  reason: string;
  principal: Principal;
  surface: Surface;
}
export interface IntentRejectResult {
  intent: Intent;
}
export interface AccountSnapshotParams {
  account: AccountRef;
  max_age_ms?: number;
  force_refresh?: boolean;
}
export interface AccountSnapshotResult {
  snapshot: AccountSnapshot;
}
export interface OauthStatus {
  state: OauthState;
  expires_at?: TimestampMs;
  has_refresh: boolean;
  scopes?: string[];
  client_id?: string;
  obtained_at?: TimestampMs;
}
export interface MainKeyPermissions {
  reading?: boolean;
  spot_margin_trading?: boolean;
  futures?: boolean;
  universal_transfer?: boolean;
  withdrawals?: boolean;
  ip_restricted?: boolean;
}
export interface MainChannelStatus {
  configured: boolean;
  /**
   * sha256(api_key) 前 16 hex,只用于识别不是密钥
   */
  key_fingerprint?: string;
  permissions?: MainKeyPermissions;
  user_stream: "connected" | "stale" | "disconnected" | "unconfigured";
  time_offset_ms?: number;
  rest_gate: "ready" | "wait" | "banned" | "unconfigured";
  last_verified_at?: TimestampMs;
}
export interface SubChannelStatus {
  configured: boolean;
  oauth: OauthStatus;
  mcp_session: "active" | "none" | "lost";
  tools_hash?: Hash256;
  tools_pinned_hash?: Hash256;
  tools_count?: number;
  /**
   * tools_hash != tools_pinned_hash → 写路径 HALT
   */
  drift: boolean;
  /**
   * Agentic 子账户稳定标识(A1 实测 MCP 是否暴露)
   */
  subaccount_ref?: string;
}
export interface ExchangeStatusParams {}
export interface ExchangeStatusResult {
  main: MainChannelStatus;
  sub: SubChannelStatus;
  writer: {
    instance_id: string;
    lease_epoch: number;
    since: TimestampMs;
  };
}
export interface PolicyGetParams {}
export interface PolicyGetResult {
  policy: ExecPolicy;
}
export interface PolicySetParams {
  policy: ExecPolicy;
  /**
   * 逐字回填新 policy 的 mode/authority(设计 §10.4)
   */
  confirm: {
    mode: string;
    authority: string;
  };
  principal: Principal;
  surface: Surface;
}
export interface PolicySetResult {
  policy: ExecPolicy;
}
/**
 * 只能收紧;放松要走 policy.set + confirm
 */
export interface EmergencyStopParams {
  mode: "stop_opening" | "flatten_only" | "halt_all";
  reason: string;
  principal: Principal;
  surface: Surface;
}
export interface EmergencyStopResult {
  policy: ExecPolicy;
}
export interface EventsSubscribeParams {
  since_seq?: number;
}
export interface EventsSubscribeResult {
  ok: boolean;
  current_seq: number;
}
export interface OauthStartParams {
  scopes?: string[];
  open_browser?: boolean;
}
/**
 * 回调由 execd 自己在回环端口接收;code/verifier 不经过 gateway
 */
export interface OauthStartResult {
  authorize_url: string;
  state: string;
  expires_at: TimestampMs;
}
export interface OauthStatusParams {}
export interface OauthStatusResult {
  oauth: OauthStatus;
}
export interface OauthRevokeParams {
  principal: Principal;
  surface: Surface;
}
export interface OauthRevokeResult {
  ok: boolean;
}
/**
 * 浏览器用 execd 的 P-256 公钥做 ECDH → HKDF-SHA256(salt 空, info 'trading-swarm/credentials/v1') → AES-256-GCM;gateway 只转发密文,TS 进程永远拿不到明文(AGENTS.md 规矩 1)
 */
export interface SealedSecret {
  alg: "ecdh-p256-hkdf-sha256-aes256gcm";
  /**
   * base64,65 字节未压缩点
   */
  ephemeral_public_key: string;
  /**
   * base64,12 字节
   */
  iv: string;
  /**
   * base64;明文是 UTF-8 JSON {api_key, api_secret}
   */
  ciphertext: string;
}
export interface CredentialsPublicKeyParams {}
export interface CredentialsPublicKeyResult {
  alg: "ecdh-p256-hkdf-sha256-aes256gcm";
  public_key: string;
  expires_at: TimestampMs;
}
export interface CredentialsSetParams {
  kind: "main_api_key";
  sealed: SealedSecret;
  principal: Principal;
  surface: Surface;
}
export interface CredentialsSetResult {
  ok: boolean;
  key_fingerprint?: string;
  permissions?: MainKeyPermissions;
}
export interface CredentialsStatusParams {}
export interface CredentialsStatusResult {
  main_api_key: {
    present: boolean;
    key_fingerprint?: string;
    permissions?: MainKeyPermissions;
    last_verified_at?: TimestampMs;
  };
  oauth: OauthStatus;
}
