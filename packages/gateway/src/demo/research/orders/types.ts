/** 订单周期执行核的输入/输出类型(WP-F,2026-09-23)。契约侧对应 packages/contracts/schema/research-orders.json。
 * 执行核是纯函数:K 线、每根的计划意图、资金费序列、维持保证金分档都由调用方喂进来,不碰 DB/网络(同 8794 shadow.rs)。 */
import type { BacktestPlan, BacktestPlanStats, BacktestTrade, BacktestEquityPoint, BacktestSegmentName, OrderLevelSource, ExecutionGateStats } from '@trade-gate/contracts';
import type { ExecutionThresholds } from '../../execution-policy.js';
export type Side = 'long' | 'short';
/** 数值化的一根 K 线(open_time 为 K 线开始,close_time 为最后一毫秒)。 */
export interface OrderBar { open_time: number; close_time: number; open: number; high: number; low: number; close: number; volume: number }
export interface IntentLevel { price: number; source: OrderLevelSource; note: string }
export interface IntentTakeProfit extends IntentLevel { size_pct: number }
/** 第 i 根收盘时产生的一次入场计划意图;从第 i+1 根开始生效(与 8794「信号之后下一根开始生效」同口径)。 */
export interface PlanIntent {
  side: Side;
  reason: string;
  entry: { type: 'market' | 'limit'; price: number | null; source: OrderLevelSource | null; note: string };
  /** 信号那根收盘价;市价单的盈亏比锚点 */
  reference_price: number;
  /** 挂单时效(根):第 i+1..i+expiry_bars 根内可成交 */
  expiry_bars: number;
  stop: IntentLevel | null;
  take_profits: IntentTakeProfit[];
  /** 放置时的最小盈亏比;null = 不检查 */
  min_rr: number | null;
  /** 结构口径:信号根 ATR(14,Wilder)与「止损太近不做」倍数;止损离参考价 < min_stop_atr×atr → blocked stop_too_close。旧口径不带这两个字段。
   * 冻结了执行层阈值时也带 atr(执行层 ATR 止损下限用),min_stop_atr 仍只在结构口径下带 */
  atr?: number | null;
  min_stop_atr?: number | null;
  /** 波动率目标仓位(IR risk.sizing=vol_target):首腿保证金 × size_weight(0<w≤1),按信号根及以前的已收盘 K 线算;不用 vol_target 的 IR 不带这两个字段 */
  size_weight?: number;
  size_note?: string;
}
/** 一期资金费。rate 为每期分数(不年化),正 = 多付空收。source 用于溯源(OKX 官方 / 币安代理)。 */
export interface FundingPoint { ts: number; rate: number; source?: string }
/** 资金费序列:from_ms/to_ms 是序列声称覆盖的区间(不是首末点);区间外的持仓段标 partial/missing。 */
export interface FundingSeries { points: FundingPoint[]; from_ms: number; to_ms: number }
/** 维持保证金分档:持仓数量(base)≤ max_qty 用该档 mmr;按升序排列,最后一档兜底。 */
export interface MmrTier { max_qty: number; mmr: number }
/** 持仓期每根收盘时交给调用方的视图,调用方据此算移动止损 / 信号离场(与 ledger 的 irExit 同位置)。 */
export interface ManageView { plan_id: string; side: Side; bar_index: number; entry_at: number; avg_entry: number; initial_stop: number | null; initial_distance: number; bars_held: number; high_water: number; low_water: number; stop: number | null }
export interface ManageUpdate { stop?: number; stop_source?: 'trail' | 'breakeven' | 'structure'; exit?: string | null }
export type Manager = (view: ManageView) => ManageUpdate | null;
export interface NewSignalPolicy { unfilled: 'replace' | 'keep'; filled: 'roll' | 'add' | 'ignore' }
export interface OrderExecParams {
  symbol: string;
  market: 'spot' | 'perp';
  leverage: number;
  timeframe_ms: number;
  initial_cash: number;
  /** 吃单费率(市价入场、止损、信号/时间离场、反手);缺省 perp 0.0005 / spot 0.001 */
  taker_fee_rate?: number;
  /** 挂单费率(限价入场、止盈限价);缺省 perp 0.0002 / spot 同 taker */
  maker_fee_rate?: number;
  /** 市价类成交的不利滑点(bps);限价类不加滑点 */
  slippage_bps?: number;
  /** 首腿保证金占当时权益的比例,缺省 1(unit notional,与 v3 引擎 sizing_mode=unit_notional 同义) */
  margin_fraction?: number;
  on_new_signal?: Partial<NewSignalPolicy>;
  /** add 模式最多加仓腿数,缺省 2;每腿等权 = 首腿额度 / (max_adds+1) */
  max_adds?: number;
  max_holding_bars?: number | null;
  breakeven_after_tp?: boolean;
  /** 永续资金费;null/缺省 → 永续计划 funding_status=missing、funding_pct=null(不当 0) */
  funding?: FundingSeries | null;
  /** 维持保证金:固定比率或分档;缺省 0.004(OKX BTC-USDT-SWAP 第 1 档) */
  maintenance_margin?: number | MmrTier[];
  /** 与 bars 下标对齐的标记价 K 线;有则强平与浮盈按标记价,缺失的根退回成交价并记 flag */
  mark?: (OrderBar | null)[];
  segment_of?: (at: number) => BacktestSegmentName;
  id_prefix?: string;
  /** blocked 计划最多保留多少行(之后只计数),缺省 2000 */
  max_blocked_rows?: number;
  /** 结构口径(research-orders-v2):统计里多给 blocked_by(按原因计数),engine_version 记 v2;旧口径输出逐字不变 */
  structure?: boolean;
  /** 执行层阈值快照(2026-09-27,来自冻结的 order_gate.execution_thresholds):放置前在策略自身校验之后按实盘同一套阈值挡单,
   * 被挡 = blocked 行(blocked_reason 取第一条原因),统计进 execution_gate;不传或传 null 时输出和以前完全一样 */
  execution_thresholds?: ExecutionThresholds | null;
}
export interface OrderSimResult {
  candidates?: import('../judge/filter.js').CandidateLog[];
  engine_version: string;
  plans: BacktestPlan[];
  equity: BacktestEquityPoint[];
  /** 已结算(exit.reason≠open)的成交计划,一计划一行,可直接喂 analyzer */
  trades: BacktestTrade[];
  stats: BacktestPlanStats;
  /** 数据/口径标注:funding_missing / funding_partial / mark_fallback / spot_short_rejected ... */
  flags: string[];
  /** 执行层统计(只在 params.execution_thresholds 非空时出现) */
  execution_gate?: ExecutionGateStats;
}
