/**
 * 矩阵研究 matrix study 的公共类型(契约 docs/demo/v3-ui-contract.md §9.53 B「2026-09-25 matrix study 修订」)。
 * 与旧 ResearchStudy / research_studies(预注册单次研究)不是同一个对象,名字刻意区分。
 * 金额一律十进制字符串,时间 unix 毫秒,统计量(收益/夏普/概率)用 number。
 */
import type { StrategyIR, StrategyJudge } from '@trading-swarm/contracts';
import type { FamilyKey } from '../batch/families.js';
import type { SlimScore } from '../batch/study.js';
import type { FrozenModelProfile } from '../judge/types.js';

export type MatrixTimeframe = '3m' | '5m' | '15m' | '4h' | '1d';
export const MATRIX_TIMEFRAMES: readonly MatrixTimeframe[] = ['3m', '5m', '15m', '4h', '1d'];
/** 首版运行器能完整执行的周期;3m/5m 只标 research_only,不评估、不填零 */
export const RUNNABLE_TIMEFRAMES: readonly MatrixTimeframe[] = ['15m', '4h', '1d'];
/** 单资产 IR 族(组合族 xsmom/carry 标 not_applicable,另走批量研究) */
export const SINGLE_ASSET_FAMILIES: readonly FamilyKey[] = ['breakout', 'ma_trend', 'ema_cross', 'pullback', 'mean_reversion', 'smc'];
export const ALL_FAMILIES: readonly FamilyKey[] = [...SINGLE_ASSET_FAMILIES, 'xsmom', 'carry'];
export type MatrixArm = 'code' | 'code_judge';
/** 矩阵的行:内置族,或「我的策略」某版本(`my:<strategy_id>@v<version>`) */
export type MatrixFamily = FamilyKey | `my:${string}`;
export const myFamilyKey = (strategy_id: string, version: number): `my:${string}` => `my:${strategy_id}@v${version}`;
export const isMyFamily = (f: string): f is `my:${string}` => f.startsWith('my:');
/** spec 里的自选策略引用(请求可省 version = 当前版本;规格里总是解析成具体版本) */
export interface MatrixStrategyRef { strategy_id: string; version: number }
/** manifest 冻结时解析出的自选策略快照(IR 就是这一版的 IR,之后不随策略变动) */
export interface MyStrategySnapshot { strategy_id: string; version: number; name: string; symbol: string; timeframe: string; ir: StrategyIR; ir_hash: string }
export type MatrixSide = 'long' | 'short';
export type Applicability = 'applicable' | 'not_applicable' | 'research_only';
/** 不合格主因(验收 B3/B4 + 评审第三节) */
export type FailureCause = 'cost_dominated' | 'insufficient_evidence' | 'unsupported_execution' | 'underperform_hold';
export const FAILURE_CAUSES: readonly FailureCause[] = ['cost_dominated', 'insufficient_evidence', 'unsupported_execution', 'underperform_hold'];

export type MatrixStudyStatus = 'queued' | 'running' | 'ready_to_finalize' | 'finalizing' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
export type MatrixStage = 'queued' | 'data' | 'matrix' | 'iterate' | 'sealed' | 'holdout' | 'done';
export type HoldoutState = 'sealed' | 'claimed' | 'released';

export interface MatrixWindow { from_ms: number; to_ms: number }
/** 一个周期的三段(close_time 闭区间);段间留 purge_bars 根空档 */
export interface TimeframeSegments { timeframe: MatrixTimeframe; timeframe_ms: number; train: MatrixWindow; selection: MatrixWindow; holdout: MatrixWindow; purge_bars: number }

export interface MatrixProtocol {
  version: 'matrix_v1';
  /** 留出段 Holm 校正后的家族错误率(单侧) */
  alpha: number;
  min_trades: number;
  /** 时间块 bootstrap:块长(天)与最少块数 */
  block_days: number;
  min_blocks: number;
  bootstrap_replicates: number;
  max_drawdown: number;
  /** 留出段相对同敞口持有的最小超额(总收益差) */
  min_effect: number;
  /** 选择段 Deflated Sharpe 门槛(按完整 trial_count 的保守值) */
  min_dsr: number;
  seed: number;
  /** 历史区间已被人看过时只能叫 historical_replay(评审第一节 2) */
  evidence_mode: 'historical_replay' | 'unseen_holdout';
  /** 分段边界协议:开发视图物理截断到选择段末 + 选择/训练按边界盯市 + 留出从空仓起跑 */
  boundary: 'mtm_truncate_v1';
}
export interface MatrixIterate { top_k: number; generations: number; candidates_per_generation: number; patience: number }
export interface MatrixBudget { max_variants: number; max_judge_calls: number; max_judge_usd: string; wall_clock_ms: number }

/** 冻结前的研究规格(POST 体 / 推荐预填后的完整形态) */
export interface MatrixStudySpec {
  research_program_id: string;
  symbols: string[];
  timeframes: MatrixTimeframe[];
  families: FamilyKey[];
  /** 「我的策略」行(与 families 并存,两者合计至少一项) */
  strategies: MatrixStrategyRef[];
  market: 'spot' | 'perp';
  sides: MatrixSide[];
  arms: MatrixArm[];
  judge: StrategyJudge | null;
  /** 每个组合单独计试验，只在训练段选择，再冻结进入 selection/holdout。 */
  judge_templates?: StrategyJudge[];
  model_profile: FrozenModelProfile | null;
  /** 各周期的窗口天数(缺省 15m 180 / 4h 730 / 1d 1460) */
  window_days: Partial<Record<MatrixTimeframe, number>>;
  /** 窗口终点(缺省 = 创建时 UTC 当日 0 点 − 1ms,已收盘) */
  to_ms: number;
  split: { train: number; selection: number; holdout: number };
  purge_bars: number;
  iterate: MatrixIterate;
  budget: MatrixBudget;
  protocol: MatrixProtocol;
  recommendation_id: string | null;
  /** 封存 finalist 后自动占用并释放留出(缺省 true);false 时等 POST /:id/finalize */
  auto_finalize: boolean;
  /** 留出段账户级回放:每笔风险(百分比,缺省 0.5 = 0.5%)与同时最多持仓 */
  portfolio: { risk_pct: number; max_open: number };
  /** 发起方(透传给完成回调,runtime 用来往对话推消息) */
  origin: { chat_session_id: string | null };
}

export type MatrixHorizon = 'short' | 'mid' | 'long';
export const HORIZON_OF: Record<MatrixTimeframe, MatrixHorizon> = { '3m': 'short', '5m': 'short', '15m': 'short', '4h': 'mid', '1d': 'long' };
/** 信息来源:推荐卡 / 雷达档位(short|swing|weekly)/ 全市场扫描时间 */
export interface MatrixSource { recommendation_id: string | null; radar_tier: 'short' | 'swing' | 'weekly' | null; universe_scan_at: number | null }

export interface MatrixVariantRef { template_group?: string; id: string; param: string; ir: StrategyIR; vol_target?: { annual: number; days: number } }
export interface MatrixCell {
  id: string; symbol: string; timeframe: MatrixTimeframe; family: MatrixFamily; side: MatrixSide; arm: MatrixArm;
  applicability: Applicability; reason: string | null; variants: MatrixVariantRef[];
  /** 本格实际三段:边界与周期外层相同,段间空档按本格变体最大持仓 + 挂单等待 + 下根执行(×1.25 余量)取,不少于 spec.purge_bars */
  segments: TimeframeSegments | null;
  /** 无界持仓族(追踪 / 信号离场)在研究里补的持仓上限(根);null = 族本身有上限 */
  holding_cap: number | null;
}
export interface MatrixManifest {
  version: 'matrix_manifest_v1';
  spec: MatrixStudySpec;
  /** spec.strategies 解析出的快照(旧 manifest 没有这个字段) */
  my_strategies?: MyStrategySnapshot[];
  segments: Partial<Record<MatrixTimeframe, TimeframeSegments>>;
  cells: MatrixCell[];
  /** 开发视图取数请求(资产 × 周期 × 截止到选择段末);实际数据指纹在 data 阶段写入 state.data_lock 且只写一次 */
  data_request_hash: string;
  protocol_hash: string;
  execution_spec_hash: string;
  data_scope_id: string;
  created_at: number;
}

export interface GateRow { name: string; ok: boolean; value: number | null }
/** 一个试验在开发视图上的成绩(训练 + 选择段,正常费率 + 2 倍费率) */
export interface DevResult {
  train: SlimScore; selection: SlimScore;
  /** 选择段日收益(DSR 方差、有效试验数相关性、配对差用) */
  selection_returns: number[]; selection_days: number[];
  /** 选择段手续费(报价币)与毛收益估计 = 净收益 + 手续费 / 资金 */
  selection_fees: number; selection_gross: number | null;
  diagnosis: { key: string; severity: string; text: string }[];
  judge: { candidates: number; follow: number; skip: number; error: number; uncertain: number } | null;
  warnings: string[]; engine: string;
}
export interface TrialView {
  trial_id: string; cell_id: string; variant_id: string; parent_trial_id: string | null; generation: number;
  config_hash: string; ir_hash: string; status: 'evaluated' | 'failed' | 'budget_skipped';
  error: string | null;
  dev: DevResult | null;
  gates: GateRow[]; dsr: number | null; verdict: 'pass' | 'near' | 'fail'; cause: FailureCause | null;
}
export interface CellResult {
  cell_id: string; verdict: 'pass' | 'near' | 'fail' | 'ineligible'; cause: FailureCause | null;
  best_trial_id: string | null; selection: SlimScore | null; train: SlimScore | null; gates: GateRow[]; dsr: number | null;
  evaluated: number;
  /** code_judge 臂相对同格 code 臂(同一变体参数)的选择段配对差:日收益差均值与块 bootstrap 95% 区间 */
  /** error_ratio = (error + uncertain) / 候选;all_skipped = 一笔没跟(此时增量只说明「全部不做」相对亏损基线,不算判断增量) */
  judge_delta: { mean_daily: number | null; ci95: [number, number] | null; kept_ratio: number | null; error_ratio?: number | null; all_skipped?: boolean } | null;
}
export interface MatrixGeneration {
  n: number; cell_id: string; parent_trial_id: string;
  /** 「诊断出什么问题 → 改了什么 → 选择段结果」 */
  diagnosis: string; change: string; trial_id: string | null; generator: string | null;
  selection: SlimScore | null; promoted: boolean; note: string;
}
export interface HoldoutTest { days: number; blocks: number; mean_daily: number | null; p_value: number | null; holm_threshold: number | null; rejected: boolean }
export interface MatrixFinalist {
  id: string; trial_id: string; cell_id: string; arm: MatrixArm; symbol: string; timeframe: MatrixTimeframe; family: MatrixFamily; side: MatrixSide;
  ir: StrategyIR; ir_hash: string; selection: SlimScore; dsr: number | null;
  holdout: SlimScore | null; holdout_gross: number | null; test: HoldoutTest | null; passed: boolean | null; cause: FailureCause | null;
  horizon: MatrixHorizon; source: MatrixSource;
  /** 留出段账户级回放(研究资产池全部资产、同资金、每笔风险、同时持仓上限;judge 决策复用) */
  portfolio: import('./portfolio.js').PortfolioSummary | null;
  judge: DevResult['judge'];
}
export interface TrialLedger {
  /** 实际评估尝试(含失败、取消、重试、恢复重跑),成本与审计用 */
  attempt_count: number;
  /** 本研究谱系全部看过成绩的不同配置(跨 Study 去重;每代每个新变体都算) */
  trial_count: number;
  study_trial_count: number;
  /** 有效独立试验数敏感性(只报告,不做门槛) */
  effective_trials: { conservative: number; by_cell: number; by_correlation: number | null; avg_correlation: number | null };
  dsr_sensitivity: { trials: number; dsr: number | null }[];
}
export interface MatrixConclusion {
  kind: 'passed' | 'no_candidate';
  finalist_ids: string[];
  causes: Record<FailureCause, number>;
  not_applicable: number; research_only: number;
  text: string;
}
export interface MatrixUsage { judge_calls: number; judge_usd: string; judge_reserved_usd: string; judge_unknown_cost_calls: number; llm_calls: number; llm_usd: string; wall_ms: number }
export interface MatrixProgress { done: number; total: number; eta_ms: number | null; note: string }
export interface MatrixState {
  stage: MatrixStage; progress: MatrixProgress;
  holdout_state: HoldoutState;
  data_lock: Record<string, { dataset_id: string; content_hash: string; bars: number; to_ms: number }> | null;
  data_lock_hash: string | null;
  cells: Record<string, CellResult>;
  generations: MatrixGeneration[];
  finalists: MatrixFinalist[];
  finalists_hash: string | null;
  trial_ledger_hash: string | null;
  conclusion: MatrixConclusion | null;
  /** 最近一次重算的试验账本与选择段日夏普方差(读视图按它重算每个试验的 DSR / 门槛) */
  ledger: TrialLedger | null;
  sharpe_variance: number | null;
  usage: MatrixUsage;
  stop_reason: string | null;
  notes: string[];
  error: string | null;
  started_at: number | null;
  run_ms: number;
}
export interface MatrixStudyRow {
  id: string; idempotency_key: string; research_program_id: string; manifest_hash: string; protocol_hash: string;
  manifest: MatrixManifest; status: MatrixStudyStatus; stage: MatrixStage; state: MatrixState;
  lease_token: string | null; lease_until: number | null; created_at: number; updated_at: number;
}
/** 事件 outbox 的一条(SSE `research.matrix_study` 的 data) */
export interface MatrixEvent {
  seq: number; study_id: string; at: number; stage: MatrixStage; status: MatrixStudyStatus;
  kind: 'status' | 'progress' | 'cell' | 'generation' | 'finalist' | 'conclusion' | 'adopted';
  progress: MatrixProgress; cell?: CellResult; generation?: MatrixGeneration; finalist?: MatrixFinalist; conclusion?: MatrixConclusion; adopted?: { finalist_id: string; strategy_id: string; version: number };
}
export const MATRIX_EVENT = 'research.matrix_study';
export const MATRIX_RUNNER_VERSION = 'matrix-runner/v1';
