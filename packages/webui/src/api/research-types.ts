/**
 * 研究工作台(Horizon 式 A/B/C 回放)前端类型,对应网关 `/api/research/*`
 * (docs/research/claude-frontend-handoff.md §3;核心对象的源 Schema 在 packages/contracts/schema/research.json)。
 * 比例一律小数(0.02 = 2%),价格/金额/数量一律十进制字符串,只在展示时格式化。
 */

export type ResearchArmKind = 'a_rules' | 'b_agent' | 'c_filter';
export type ResearchRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'budget_exhausted' | 'cancelling' | 'cancelled' | 'interrupted';

export interface ResearchPolicy {
  label: string;
  description: string;
  interpretation: 'donchian_close_long_v1';
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
  /** 第二轮多资产 */
  max_positions?: number;
  allocation?: 'equal_risk' | 'equal_notional';
  /** 第三轮:研究默认 unit_notional(每笔固定 100% 名义,剔除仓位因素) */
  sizing_mode?: 'unit_notional' | 'risk_fraction';
}

export interface ResearchRequest {
  idempotency_key: string;
  /** 与 universe_id 二选一 */
  dataset_id?: string;
  universe_id?: string;
  source_strategy_ref?: string;
  /** 与 strategy_ir 二选一;policy 是第一轮的预置模板 */
  policy?: ResearchPolicy;
  strategy_ir?: StrategyIR;
  execution: ResearchExecution;
  from_ms: number;
  to_ms: number;
  arms: ResearchArmKind[];
  repeats: number;
  max_model_calls: number;
  timeout_ms: number;
  purpose: 'development' | 'validation' | 'holdout';
  study_id: string;
  parent_run_id?: string;
  acknowledge_adaptive_search: boolean;
  /** 第二轮:单次模型调用超时(默认 120000,上限 300000);超时记 model_error 继续,连续 5 次才 failed */
  model_call_timeout_ms?: number;
  /** 第三轮 */
  order_gate?: OrderGateParams;
  shortlist?: { top_n: number; by: 'composite' | 'residual_sharpe' };
  precheck_overrides?: string[];
  /**
   * 第四轮:后端创建 run 时自动盖的策略规范版本(如 'strategy-spec/v1'),前端不用主动传。
   * 它同时是收益口径的判据:有 spec_version = expectancy_pct / per_trade_return_pct.* /
   * trade_return_histogram.bins 一律小数;没有 = 旧 run,这些字段是百分数。
   */
  spec_version?: string;
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

export interface ResearchDatasetSummary {
  id: string;
  created_at: number;
  venue: string;
  market: 'spot';
  symbol: string;
  source: string;
  timeframe_ms: number;
  bars: number;
  first_at?: number;
  last_at?: number;
}

export interface ResearchCapabilities {
  version: string;
  status: string;
  limits: { walk_bars: number; recording_bytes: number };
  active_run_id: string | null;
  markets: string[];
  directions: string[];
  interpreters: string[];
  decision_arms: ResearchArmKind[];
  execution: Record<string, string | number>;
  unsupported: string[];
  tools: { name: string; args: Record<string, unknown>; description: string }[];
  source_strategy_note: string;
  eval_status: string;
}

export interface ResearchEstimate {
  bars: number;
  upper_model_calls: number;
  hard_model_call_cap: number;
  timeout_ms: number;
  price: string | null;
  price_note: string;
}

export interface ResearchManifest {
  engine_version: string;
  adapter_version: string;
  request: ResearchRequest;
  dataset_hash: string;
  policy_hash: string;
  source_strategy: { id: string; version: number; name: string } | null;
  brain: { kind: string; model: string | null; name: string; configuration_hash: string };
  playbook: string;
  trial_number: number;
  created_at: number;
  hash: string;
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
  sharpe_status: 'insufficient' | 'estimated';
  avg_net_r: number | null;
  /** 第三轮:剔除仓位因素的每笔百分比收益 */
  per_trade_return_pct?: { avg: number | null; median: number | null; std: number | null; best: number | null; worst: number | null };
  expectancy_pct?: number | null;
  trade_return_histogram?: { bins: number[]; counts: number[] };
}

export interface ResearchRunSummary {
  id: string;
  status: ResearchRunStatus;
  created_at: number;
  updated_at: number;
  manifest: ResearchManifest;
  metrics: { arm: string; metrics: ResearchMetrics }[];
  error: string | null;
  result_ready: boolean;
}

export interface ResearchEquity {
  at: number;
  cash: string;
  holdings: string;
  equity: string;
  exposure: number;
  drawdown: number;
  by_symbol?: Record<string, string>;
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
  reason: 'stop' | 'target' | 'agent_exit' | 'agent_reduce' | 'horizon';
  timing: 'open' | 'intrabar_unknown';
  position_id: string;
  /** 第二轮 */
  symbol?: string;
  mae_r?: number | null;
  mfe_r?: number | null;
  /** 第三轮:每笔百分比收益(unit_notional 口径)与现金不足封顶标记 */
  return_pct?: number | null;
  capped?: boolean;
  /** 第三轮 order-gate:实际放下去的止损/止盈与它们的来源 */
  stop?: string;
  target?: string | null;
  fit?: ResearchFit;
}

export type ResearchAction = 'enter' | 'follow' | 'skip' | 'hold' | 'exit' | 'reduce' | 'no_trade' | 'blocked' | 'model_error';

export interface ResearchDecision {
  id: string;
  at: number;
  arm: string;
  candidate_id: string | null;
  action: ResearchAction;
  reason: string;
  input_hash: string;
  decision_hash: string;
  evidence_refs: string[];
  gate_errors: string[];
  /** 第二轮多资产 */
  symbol?: string;
  screen_rank?: number | null;
  /** 第三轮 order-gate:被拦/放行时代码先放的止损止盈 */
  fit?: ResearchFit;
  /** 第四轮:B 臂 proposal 违反策略规范的 code 列表(后端可能还没给) */
  spec_violations?: string[];
}

export interface ResearchArmResult {
  arm: string;
  metrics: ResearchMetrics;
  decisions: ResearchDecision[];
  trades: ResearchTrade[];
  equity: ResearchEquity[];
  pending_at_end: boolean;
  /** 第二轮:诊断与多资产分解(旧 run 没有) */
  diagnostics?: ResearchDiagnostics;
  by_symbol?: ResearchSymbolBreakdown[];
}

export interface ResearchDifference {
  at: number;
  candidate_id: string | null;
  a_action: string;
  b_action: string;
  arm: string;
  reason: string;
}

export interface ResearchComparison {
  arm: string;
  net_return_delta: number;
  exposure_delta: number;
  paired_bar_return_ci: { status: string; lower: number | null; upper: number | null; iterations: number; block_size: number };
  differences: ResearchDifference[];
  note: string;
}

export interface ResearchFilterControl {
  arm: string;
  eligible_candidates: number;
  followed: number;
  skipped: number;
  follow_avg_net_r: number | null;
  skip_avg_net_r: number | null;
  all_avg_net_r: number | null;
  follow_ci: { status: string; lower: number | null; upper: number | null } | null;
  matched_participation: { samples: number; avg_net_r: number | null; percentile: number | null; note?: string } | null;
  note: string;
}

export interface ResearchEvaluation {
  labels: { candidate_id: string; at: number; net_r: number | null; status: string }[];
  filter_controls: ResearchFilterControl[];
  repeat_agreement: { arm: string; paired_candidates: number; agreement: number | null }[];
  scope: string;
  economic_evidence: string;
  model_weight_leakage: string;
  promotion: string;
  trial_count_note: string;
}

export interface ResearchResult {
  engine_version: string;
  status: ResearchRunStatus;
  error: string | null;
  arms: ResearchArmResult[];
  comparison: ResearchComparison[];
  evaluation?: ResearchEvaluation;
}

export interface ResearchResultResponse {
  run_id: string;
  status: ResearchRunStatus;
  result: ResearchResult | null;
}

export interface ResearchEvent {
  seq: number;
  run_id: string;
  at: number;
  event: string;
  data: Record<string, unknown>;
}

export interface ResearchEvidenceResponse {
  recordings: unknown[];
  total: number;
  model_calls: unknown[];
  note: string;
}

export interface ResearchReplayResponse {
  run_id: string;
  verified: boolean;
  status: string;
  expected_hash: string;
  actual_hash: string;
  model_calls: number;
}

export interface ResearchChatTrace {
  round: number;
  call: unknown;
  result: unknown;
}

export interface ResearchChatResponse {
  id: string;
  status: 'completed' | 'failed' | 'running';
  final: string;
  trace: ResearchChatTrace[];
  error?: string;
  /** 第三轮 */
  tasks?: ResearchChatTask[];
  artifacts?: { id: string; kind: ResearchArtifactKind; title: string }[];
}

export interface ResearchDatasetFromMarketResponse {
  id: string;
  bars: number;
  symbol: string;
  timeframe: string;
  first_at: number;
  last_at: number;
}

/** 前端本地保存的一次「研究对话」记录(网关的 chat 是一问一答式,不保存会话) */
export interface ResearchChatTurn {
  id: string;
  at: number;
  role: 'user' | 'agent';
  text: string;
  trace?: ResearchChatTrace[];
  error?: string | null;
  chat_id?: string;
  tasks?: ResearchChatTask[];
  artifacts?: { id: string; kind: ResearchArtifactKind; title: string }[];
}

// ---------------------------------------------------------------------------
// 第二轮(research round 2):资产池与 screen、策略 IR、诊断与归因。
// 后端按同一份契约实现;这里所有新字段都按「可能还没有」处理(可选)。

export interface ResearchFactorMetrics {
  total_return: number;
  max_drawdown: number;
  drawdown_area: number;
  ulcer_index?: number;
  sharpe: number | null;
  sortino?: number | null;
  information_ratio?: number | null;
  volatility?: number;
}

export interface ResearchTrendState {
  state: 'up' | 'down' | 'range';
  adx?: number;
  ema_slope?: number;
  donchian_pos?: number;
  htf_state?: 'up' | 'down' | 'range';
}

export interface ResearchMarketFactor {
  kind: 'btc' | 'btc_eth_capw' | 'equal_weight_universe';
  symbols: string[];
  weights?: Record<string, string>;
  note?: string;
}

export interface ResearchUniverseMember {
  symbol: string;
  dataset_id: string;
  bars: number;
  first_at?: number;
  last_at?: number;
}

export interface ResearchUniverse {
  id: string;
  timeframe_ms: number;
  members: ResearchUniverseMember[];
  market_factor: ResearchMarketFactor;
  aligned_bars: number;
  first_at: number;
  last_at: number;
  retrieved_at: number;
  note?: string;
}

export interface ResearchScreenRow {
  symbol: string;
  bars: number;
  beta: number | null;
  alpha_annualized: number | null;
  r2: number | null;
  raw: ResearchFactorMetrics | null;
  residual: ResearchFactorMetrics | null;
  alpha_share: number | null;
  beta_share: number | null;
  trend: ResearchTrendState | null;
  momentum_12_1?: number | null;
  rank: { residual_sharpe?: number; alpha_share?: number; composite?: number } | null;
  status: 'ok' | 'insufficient';
}

export interface ResearchScreenResponse {
  universe_id: string;
  as_of: number;
  window_bars: number;
  lookback_bars: number;
  market_factor: ResearchMarketFactor;
  rows: ResearchScreenRow[];
  note?: string;
}

export interface ResearchPrimitive {
  name: string;
  category: 'signal' | 'entry' | 'stop' | 'sizing' | 'exit' | 'regime' | 'screen';
  params_schema: Record<string, unknown>;
  description: string;
  warmup_note?: string;
}

export interface StrategyIRNode {
  primitive: string;
  params: Record<string, unknown>;
  optional?: boolean;
}

export interface StrategyIR {
  version: number;
  label: string;
  description: string;
  universe?: { screen?: Record<string, unknown> };
  signal: StrategyIRNode[];
  entry: StrategyIRNode;
  risk: { stop: StrategyIRNode; sizing: StrategyIRNode };
  exit: StrategyIRNode[];
  regime?: StrategyIRNode;
}

export interface ResearchCompileCheck {
  name: string;
  ok: boolean;
  message?: string;
}

/** 编译时算出来的设计约束(成本/止损下限/盈亏比/ATR),后端会把它注进模型提示 */
export interface ResearchCompileConstraints {
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
}

/** 策略规范(spec)的一条违例;severity=block 表示不允许拿去跑实验 */
export interface ResearchSpecViolation {
  code: string;
  severity: 'block' | 'warn';
  message: string;
  field?: string;
}

/** 策略规范校验结果;text 是规范全文(折叠可看),后端没给时前端不伪造 */
export interface ResearchSpecReport {
  version: string;
  ok: boolean;
  violations: ResearchSpecViolation[];
  text: string;
}

/** 可读规则卡的一行:每条是一句中文,primitive 是它背后的原语名(高级区才显示) */
export interface ResearchRuleCard {
  category: 'signal' | 'entry' | 'stop' | 'sizing' | 'exit' | 'regime';
  primitive: string;
  text: string;
  optional?: boolean;
}

export interface ResearchCompileResponse {
  /** 结构无法解析时为 null(ok=false),不返回伪造 IR */
  ir: StrategyIR | null;
  checks: ResearchCompileCheck[];
  ok: boolean;
  hash: string | null;
  summary: string;
  unmapped: string[];
  constraints?: ResearchCompileConstraints;
  /** 第四轮(后端可选):策略规范校验 */
  spec?: ResearchSpecReport;
  /** 第四轮(后端可选):可读规则卡,六类各一句中文 */
  rules?: ResearchRuleCard[];
}

export interface ResearchDiagnostics {
  exit_reasons?: { reason: string; count: number; avg_net_r: number | null; net_pnl: string }[];
  r_histogram?: { bins: number[]; counts: number[] };
  mae_mfe?: { avg_mae_r: number | null; avg_mfe_r: number | null; winners_avg_mfe_r: number | null; losers_avg_mfe_r: number | null };
  cost_share?: { fees: string; slippage_est: string; gross_pnl: string; cost_over_gross_abs: number | null };
  factor?: { beta: number | null; alpha_annualized: number | null; alpha_share: number | null; beta_share: number | null; residual_max_dd: number | null; residual_sharpe: number | null; r2: number | null; status: 'ok' | 'insufficient' };
  holding_bars?: { avg: number; median: number; max: number };
  /** 第三轮 order-gate 统计(passed / adjusted 是「先放置再判定」之后才有的) */
  gate_stats?: { evaluated: number; blocked_by: Record<string, number>; passed?: number; adjusted?: { stop_widened: number; target_fallback: number } };
}

export interface ResearchSymbolBreakdown {
  symbol: string;
  closed_trades: number;
  net_pnl: string;
  win_rate: number | null;
  avg_net_r: number | null;
  contribution: number | null;
}

export interface ResearchAttributionResponse {
  parent_run_id: string;
  child_run_id: string;
  base_net_return: number;
  child_net_return: number;
  components: { section: string; changed: boolean; solo_net_return: number | null; delta: number | null }[];
  interaction: number | null;
  note: string;
}

// ---------------------------------------------------------------------------
// 第三轮(research round 3):研究沙箱与 artifacts、任务树、策略体检、
// unit_notional 收益口径、order-gate。后端按同一份契约实现;字段都按可能还没有处理。

export type ResearchArtifactKind = 'chart' | 'markdown' | 'table' | 'file';

export interface ResearchChartSpec {
  kind: 'chart';
  type: 'line' | 'bar' | 'scatter';
  title: string;
  x: 'time' | 'category';
  series: { name: string; field?: string; unit?: string; axis?: string; transformed?: boolean; color?: string; points: [number | string, number | null][] }[];
  layout?: 'panels' | 'overlay';
  x_domain?: [number, number];
  rows?: Record<string, unknown>[];
  y_label?: string;
  note?: string;
}

export interface ResearchTableSpec {
  kind: 'table';
  columns: string[];
  rows: (string | number | null)[][];
}

export interface ResearchArtifact {
  id: string;
  chat_id: string | null;
  run_id: string | null;
  kind: ResearchArtifactKind;
  title: string;
  content: ResearchChartSpec | ResearchTableSpec | string | unknown;
  created_at: number;
  // ---- §9.44 扩展列:旧行这些是 NULL,读时按 legacy 处理,不杜撰来源 ----
  /** 产生它的 inquiry(旧沙箱产物为 null) */
  inquiry_id?: string | null;
  /** 引用的不可变快照 id */
  snapshot_refs?: string[] | null;
  /** observed / derived / estimated / synthetic;estimated 一律标「估计」 */
  data_kind?: ResearchDataKind | null;
  availability?: ResearchAvailability | null;
  /** 这张图/这张表回答的问题 */
  question?: string | null;
  /** chartSpec / tableSpec;后端新接口把规范放这里,旧接口放 content */
  spec?: ResearchChartSpec | ResearchTableSpec | unknown;
  caption?: string | null;
  /** 来源 / 截至时间 / 窗口 / 单位:面板顶部那一行标签 */
  provider?: string | null;
  as_of?: number | null;
  window?: { from_ms: number; to_ms: number } | null;
  units?: Record<string, string> | null;
}

export interface ResearchChatTask {
  id: string;
  parent_id: string | null;
  title: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  detail?: string | null;
  started_at?: number;
  ended_at?: number | null;
}

/** SSE `research.chat` */
export interface ResearchChatEvent {
  chat_id: string;
  seq: number;
  at: number;
  event: 'task' | 'tool' | 'artifact' | 'final' | 'error';
  data: Record<string, unknown>;
}

export interface ResearchChatDetail {
  id: string;
  status: 'completed' | 'failed' | 'running';
  final: string;
  trace: ResearchChatTrace[];
  tasks?: ResearchChatTask[];
  artifacts?: { id: string; kind: ResearchArtifactKind; title: string }[];
  error?: string | null;
  request?: { message: string; run_id?: string };
  created_at?: number;
}

export interface ResearchPrecheckItem {
  name: string;
  ok: boolean;
  value: number | null;
  threshold?: number | null;
  note?: string;
}

export interface ResearchPrecheckResponse {
  ok: boolean;
  items: ResearchPrecheckItem[];
  suggestions: string[];
}

export interface OrderGateParams {
  min_rr: number;
  min_stop_cost_multiple: number;
  max_risk_fraction: string;
  require_target: boolean;
  /** 第三轮「先放置再判定」:策略止损窄于成本下限时 widen=放宽到下限(旧缺省),block=直接拦,none=只展示(2026-09-23 结构口径缺省) */
  stop_floor?: 'widen' | 'block' | 'none';
  /** 策略没给止盈时按止损距离的固定倍数补(默认 2);null = 不补,直接判 no_target */
  target_fallback_r?: number | null;
  /** 单笔风险上限适用范围:默认只对 risk_fraction 仓位法;unit_notional 已剔除仓位因素不套 */
  risk_cap_sizing?: 'risk_fraction_only' | 'all';
  /** 2026-09-23 结构口径(契约 OrderGateParams.min_stop_atr):止损离入场不到 k×ATR(14) 不做;字段非 null 即启用结构口径 */
  min_stop_atr?: number | null;
}

/** 候选出现时代码先放的止损/止盈,以及它们各自的来源(order-gate「先放置再判定」)。 */
export interface ResearchFit {
  stop_source: 'strategy' | 'cost_floor';
  target_source: 'strategy' | 'fallback_r' | 'none';
  strategy_stop: string;
  strategy_target: string | null;
  stop_pct: number;
  target_pct: number | null;
  rr: number | null;
  floor_pct: number;
}

// ---------------------------------------------------------------------------
// §9.44 研究会话与研究 loop(docs/demo/v3-ui-contract.md §9.44)。
//
// 对象链:Session → Message(blocks)→ Inquiry(一次提问的研究 run)→ Step(绑工具调用)
//          → Snapshot(不可变快照)→ Artifact(图/表/报告,引用快照)→ Claim(结论)。
// Inquiry ≠ 回测 run(ResearchRunSummary)≠ 策略版本:validate 类提问在某一步创建普通回测 run,
// step 里只引用它的 id,回测结果仍走 §9.41 的接口。
//
// 后端按同一份契约实现;这里所有字段都按「可能还没有」处理(可选 + 空态)。

export type ResearchTaskKind = 'market' | 'compare' | 'validate' | 'diagnose';

/** 旁路状态不是完成:awaiting_input 等用户答,incomplete = 预算耗尽/部分失败但已有产物。 */
export type ResearchInquiryStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'validating'
  | 'completed'
  | 'awaiting_input'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'incomplete';

export type ResearchStepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

/** 数据身份:observed 实测 / derived 派生 / estimated 估计 / synthetic 演示。estimated 一律标「估计」。 */
export type ResearchDataKind = 'observed' | 'derived' | 'estimated' | 'synthetic';

export type ResearchAvailability = 'available' | 'partial' | 'missing' | 'not_applicable';

export interface ResearchWindow {
  from_ms: number;
  to_ms: number;
}

/** 会话当前选中的引用,随下一条消息发给后端(「围绕:<产物>」)。 */
export interface ResearchSessionContext {
  instrument_refs?: string[];
  selected_artifact_id?: string | null;
  selected_inquiry_id?: string | null;
  selected_run_id?: string | null;
  selected_window?: ResearchWindow | null;
}

export interface ResearchSession {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  context?: ResearchSessionContext | null;
}

/** 计划里的一步(消息 blocks 内的轻量形态;完整步骤在 ResearchStep)。 */
export interface ResearchPlanStep {
  key: string;
  title: string;
  tool: string;
  status: ResearchStepStatus;
}

export interface ResearchPlan {
  task_kind: ResearchTaskKind;
  instruments?: string[];
  window?: ResearchWindow | null;
  timeframe?: string | null;
  steps: ResearchPlanStep[];
  /** 'model' | 'fallback_rules':模型不可用时走确定性规则路由 */
  source?: string;
  clarify?: string | null;
}

export type ResearchBlock =
  | { kind: 'text'; text: string }
  | ({ kind: 'plan' } & ResearchPlan)
  | { kind: 'step_ref'; step_id: string }
  | { kind: 'chart_ref'; artifact_id: string }
  | { kind: 'table_ref'; artifact_id: string }
  | { kind: 'report_ref'; artifact_id: string }
  | { kind: 'comparison_ref'; artifact_id: string }
  | { kind: 'strategy_ref'; run_id: string }
  | { kind: 'data_gap'; metric: string; availability: ResearchAvailability; note?: string }
  | { kind: 'run_status'; inquiry_id: string; status: ResearchInquiryStatus; reason?: string }
  | { kind: 'next_question'; text: string };

export interface ResearchMessage {
  id: string;
  session_id: string;
  seq: number;
  role: 'user' | 'assistant';
  created_at: number;
  blocks: ResearchBlock[];
  inquiry_id?: string | null;
}

export interface ResearchStep {
  id: string;
  inquiry_id: string;
  seq: number;
  parent_id?: string | null;
  /** 步骤的「目的」,默认只显示这一行 */
  title: string;
  /** 工具名(开发详情才显示) */
  tool: string;
  tool_version?: string;
  key?: string;
  status: ResearchStepStatus;
  input?: unknown;
  /** 展开后的摘要:数据范围 / 来源 / 行数 / 复用快照等 */
  output_summary?: Record<string, unknown> | null;
  snapshot_refs?: string[];
  artifact_refs?: string[];
  error_code?: string | null;
  error?: string | null;
  retryable?: boolean;
  started_at?: number | null;
  ended_at?: number | null;
  usage?: Record<string, number> | null;
}

export interface ResearchBudget {
  max_model_calls?: number;
  max_data_calls?: number;
  max_backtests?: number;
  wall_clock_ms?: number;
}

export interface ResearchUsage extends ResearchBudget {
  unknown_cost?: boolean;
}

export interface ResearchInquiry {
  id: string;
  session_id: string;
  user_message_id?: string;
  task_kind: ResearchTaskKind;
  status: ResearchInquiryStatus;
  question: string;
  plan?: ResearchPlan | null;
  budget?: ResearchBudget | null;
  usage?: ResearchUsage | null;
  error_code?: string | null;
  error?: string | null;
  created_at: number;
  updated_at: number;
  steps?: ResearchStep[];
  /** 后端 LoopCheckpoint;前端只读 concepts(报告「概念覆盖」段) */
  checkpoint?: { concepts?: import('@trading-swarm/contracts').LoopConcept[] } | null;
}

/** 恢复历史唯一来源:GET /api/research/sessions/:id */
export interface ResearchSessionDetail {
  session: ResearchSession;
  messages: ResearchMessage[];
  inquiries: ResearchInquiry[];
  artifacts?: ResearchArtifact[];
}

export interface ResearchSessionsResponse {
  items: ResearchSession[];
}

export interface ResearchMessageSendResponse {
  message: ResearchMessage;
  inquiry: ResearchInquiry;
}

/** SSE `research.inquiry`,按 seq 去重;断线用 GET /inquiries/:id/events?after= 补发。 */
export interface ResearchInquiryEvent {
  seq: number;
  inquiry_id: string;
  session_id: string;
  at: number;
  event:
    | 'inquiry.queued'
    | 'inquiry.planning'
    | 'inquiry.plan'
    | 'inquiry.awaiting_input'
    | 'step.started'
    | 'step.progress'
    | 'step.completed'
    | 'artifact.created'
    | 'usage.updated'
    | 'inquiry.completed'
    | 'inquiry.incomplete'
    | 'inquiry.failed'
    | 'inquiry.cancelled';
  data: Record<string, unknown>;
}

export interface ResearchInquiryEventsResponse {
  items: ResearchInquiryEvent[];
  next_cursor: number;
}

/** 不可变数据快照的元信息(GET /api/research/snapshots/:id?rows=0)。 */
export interface ResearchSnapshot {
  id: string;
  kind: string;
  provider: string;
  instrument?: Record<string, unknown> | null;
  requested_window?: ResearchWindow | null;
  actual_window?: ResearchWindow | null;
  as_of: number;
  fetched_at: number;
  frequency?: string | null;
  units?: Record<string, string> | null;
  coverage?: ResearchAvailability | string;
  quality_flags?: string[];
  rows?: unknown[];
  checksum?: string;
  method_version?: string;
}

/** GET /api/research/tools:给前端翻步骤标题与开发详情 */
export interface ResearchToolDefinition {
  name: string;
  version: string;
  task_kinds: ResearchTaskKind[];
  asset_classes: string[];
  access?: 'read' | 'compute' | 'create_run';
  budget_class?: string;
  title?: string;
  description?: string;
  input?: unknown;
}

export interface ResearchToolsResponse {
  items: ResearchToolDefinition[];
}


export interface ResearchRevisionCommand {
  mode: 'revise' | 'optimize' | 'rerun';
  baseline_run_id: string;
  instruction: string;
  max_candidates: 1 | 2;
  execution_overrides?: Partial<Pick<ResearchExecution, 'initial_cash' | 'fee_rate' | 'slippage_bps' | 'risk_fraction' | 'max_allocation'>>;
}
export interface ResearchRevisionContext {
  run_id: string; version: number; parent_run_id: string | null; manifest_hash: string;
  status: string; ir: StrategyIR | null; rules: ResearchRuleCard[]; execution: ResearchExecution;
  window: ResearchWindow; study_id: string; purpose: string; dataset_id: string | null;
  timeframe: string; remaining_candidates: number; blocked: string | null;
  versions: { run_id: string; version: number; parent_run_id: string | null; status: string; purpose: string; metrics: ResearchMetrics | null; created_at: number }[];
}
