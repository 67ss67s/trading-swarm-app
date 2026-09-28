/**
 * 策略自动改进与复验环(Improver)的公共类型。设计见 docs/research/improver-design-2026-09-23.md。
 * 改进环主体(runner/evaluate/worker/routes)与各候选生成器(diagnosis/neighborhood/swap/oracle/model)都只依赖这里,互不 import。
 */
import type { ResearchBar, StrategyIR } from "@trade-gate/contracts";

/** 一次改进任务冻结的数据:资产池 × 周期 × 时间段,切成训练(内含滚动折)/验证/留出三段。 */
export interface FrozenAsset { symbol: string; dataset_id: string; bars: ResearchBar[];
  /** 永续(2026-09-23 补):与 bars 下标对齐的标记价/资金费/分档;现货缺省 */
  perp?: import('../backtest-report.js').AssetPerpInput | null }
export interface Segments {
  /** 训练段内的滚动前推折:[from_ms, to_ms] 均为 close_time */
  folds: { from_ms: number; to_ms: number }[];
  train: { from_ms: number; to_ms: number };
  validation: { from_ms: number; to_ms: number };
  holdout: { from_ms: number; to_ms: number };
}
export interface FrozenData { universe: string[]; timeframe: string; timeframe_ms: number; assets: FrozenAsset[]; segments: Segments; warmup_bars: number;
  /** 行情市场,缺省 spot;perp 时各资产带 perp 输入,IR 必须 order.market=perp */
  market?: 'spot' | 'perp' }

/** 候选:父 IR + 一个改动。diff 是给人看的逐条变更,ir 是改完的完整 IR。 */
export interface Candidate {
  id: string;
  parent_id: string | null;
  generation: number;
  generator: GeneratorName;
  ir: StrategyIR;
  diff: { path: string; from: unknown; to: unknown }[];
  rationale: string;
  /** 生成器自带的证据(诊断条目、oracle 的 p 值与特征、参数平台等) */
  evidence?: Record<string, unknown>;
}
export type GeneratorName = "baseline" | "diagnosis" | "neighborhood" | "swap" | "oracle" | "model";

/** 候选在某一段(某一折)上的扣成本表现,按资产池汇总(等资金、各资产独立记账后相加)。 */
export interface SegmentScore {
  segment: string;
  trades: number;
  total_return: number;
  sharpe: number | null;
  max_drawdown: number;
  exposure: number;
  /** 同敞口持有:资产池等权持有收益 × 平均敞口 */
  exposure_matched_hold: number | null;
  /** 2 倍手续费下的总收益 */
  stressed_return: number | null;
  // ---- 以下为改进环第一阶段补充的可选字段(不改上面字段的语义)
  /** 段起止(close_time) */
  from_ms?: number;
  to_ms?: number;
  /** 资产池等权买入持有收益(同一段、同费率) */
  hold_return?: number | null;
  /** BTC 单独买入持有收益(资产池不含 BTC 时为 null) */
  btc_hold_return?: number | null;
  /** 日收益(非年化)夏普:Deflated Sharpe 用 */
  daily_sharpe?: number | null;
  /** 日收益个数 */
  days?: number;
  win_rate?: number | null;
  profit_factor?: number | null;
  /** 实付手续费合计(报价币) */
  fees?: number;
  /** 逐资产拆分:各资产独立记账的收益、成交数与持有收益 */
  per_asset?: { symbol: string; total_return: number; trades: number; hold_return: number | null; status: string }[];
}
export interface GateResult { name: string; ok: boolean; value: number | null; threshold: number | null; note?: string }
export interface Evaluation {
  candidate_id: string;
  folds: SegmentScore[];
  /** 整个训练段(各折连续一次跑完)的汇总 */
  train?: SegmentScore;
  validation?: SegmentScore;
  holdout?: SegmentScore;
  objective: number | null;
  gates: GateResult[];
  passed: boolean;
}

/** 生成器的输入:父候选 + 它的评估 + 诊断 + 冻结数据(只允许用训练段)。 */
export interface GeneratorContext {
  parent: Candidate;
  evaluation: Evaluation;
  /** loop/diagnose.ts 的 findings(按训练段报告算) */
  diagnosis: { key: string; severity: string; text: string }[];
  data: FrozenData;
  /** 这一代还能出几个候选 */
  budget: number;
  signal?: AbortSignal;
  /** 零模型编译检查(不合法的候选直接丢) */
  check: (ir: StrategyIR) => { ok: boolean; reason?: string };
  /** 生成器内部需要快速回测时用(只能在训练段窗口内) */
  quickScore?: (ir: StrategyIR, window: { from_ms: number; to_ms: number }) => Promise<SegmentScore>;
}
export interface CandidateGenerator {
  name: GeneratorName;
  generate(ctx: GeneratorContext): Promise<Omit<Candidate, "id" | "parent_id" | "generation">[]>;
}

/** 目标函数与门槛(跑前冻结,跑中不许改;默认值待 Jacky 确认)。 */
export interface Objective {
  min_trades_per_fold: number;
  min_trades_total: number;
  max_drawdown: number;
  require_stress_positive: boolean;
  require_beats_exposure_matched_hold: boolean;
  /** 参数邻域平台:邻域候选目标值 ≥ 冠军的这个比例才算平台 */
  plateau_ratio: number;
  /** 目标 = 各折夏普中位数 − stability_penalty × 各折夏普标准差(缺省 0.5,把折间稳定性算进去) */
  stability_penalty?: number;
}
export const DEFAULT_OBJECTIVE: Objective = { min_trades_per_fold: 10, min_trades_total: 30, max_drawdown: 0.35, require_stress_positive: true, require_beats_exposure_matched_hold: true, plateau_ratio: 0.7 };
export interface Budget { generations: number; candidates_per_generation: number; promote_per_generation: number; wall_clock_ms: number; model_calls: number;
  /** 连续多少代没有改进就停(缺省 2,设计第四节);调大只为跑满代数做对照,不改选择规则 */
  patience?: number;
  /** 多步搜索(缺省开):没有 promote 的代,训练目标高于父策略的最好候选(门槛没过也行)作下一代父策略;冠军仍只从门槛全过且验证段优于基线的候选里选 */
  allow_explore?: boolean }
export const DEFAULT_BUDGET: Budget = { generations: 3, candidates_per_generation: 8, promote_per_generation: 2, wall_clock_ms: 30 * 60_000, model_calls: 0, allow_explore: true };

/** 过拟合账本:每条谱系累计试验数与折算指标。 */
export interface OverfitLedger {
  trials: number; deflated_sharpe: number | null; pbo: number | null; random_entry_baseline: SegmentScore | null; notes: string[];
  // ---- 第一阶段补充的可选字段
  /** Deflated Sharpe 的输入:冠军训练段日夏普、各候选日夏普方差、期望最大夏普 SR0、日收益个数、偏度、峰度 */
  deflated_inputs?: { sharpe: number; sharpe_variance: number; expected_max_sharpe: number; days: number; skew: number; kurtosis: number } | null;
  /** 平台检验额外跑的邻域点数(不参与选择,单独记) */
  plateau_checks?: number;
  /** 随机入场基线分布:同离场规则、同入场概率,固定种子 */
  random_entry?: { runs: number; seed: number; segment: string; returns: number[]; trades: number[]; sharpes: (number | null)[]; median_return: number | null; champion_return: number; champion_percentile: number | null; note: string } | null;
}
