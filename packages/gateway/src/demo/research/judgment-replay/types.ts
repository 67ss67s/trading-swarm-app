/**
 * Judgment Replay(2026-09-23)—— 不带固定策略、由 agent 判断「做不做」的回测。
 * 设计与口径:docs/research/judgment-replay-2026-09-23.md。
 *
 * 这里只放共享类型与冻结常量。任何改变事件、管仓、提示词语义的改动都必须升对应的版本号,
 * 版本号会写进 run manifest,旧 manifest 的模型输出不会被新口径误读。
 */
import type { ResearchBar } from '@trading-swarm/contracts';
import type { TriggerHit } from '../../types.js';

export type Bar = ResearchBar;
export type Venue = 'spot' | 'perp';
export type Dir = 'long' | 'short';

export const H1 = 3_600_000;
export const H4 = 4 * H1;
export const D1 = 24 * H1;

/** 事件规则版本:生产触发器 → 带方向事件、冷却、结构止损、< 0.5 ATR 不做。 */
export const EVENT_RULES_VERSION = 'jr-events-v1';
/** 管仓版本:吊灯 ATR22×3(168 根)为主;结构止盈 + 48 根到期为副。 */
export const MANAGEMENT_VERSION = 'jr-mgmt-v1';
/** 研究侧提示词版本(prompt_mode=research 时才用;不是生产 harness)。 */
export const RESEARCH_PROMPT_VERSION = 'jr-research-prompt-v1';

/** 默认资产池:6 个大币,1h。 */
export const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'XRPUSDT', 'BNBUSDT'] as const;

export interface PeriodDef {
  id: string;
  /** 事件 as_of(信号根收盘)落在 [from, to) 内 */
  from: number;
  to: number;
  label: string;
}

/** geo = 几何实验室用过的那段(信号窗口 2026-06-13 → 09-14,单边上涨);bear = 下跌/震荡对照段。 */
export const PERIODS: Record<string, PeriodDef> = {
  geo: { id: 'geo', from: Date.UTC(2026, 5, 13), to: Date.UTC(2026, 8, 14), label: '几何实验室同段 2026-06-13→09-14' },
  bear: { id: 'bear', from: Date.UTC(2025, 8, 1), to: Date.UTC(2026, 2, 1), label: '下跌/震荡段 2025-09-01→2026-03-01' },
};

/** 结构止损离参考收盘不足这么多 ATR14 → 这笔不做(所有臂都不做,不叫模型)。 */
export const MIN_STOP_ATR = 0.5;
/** 结构位外的缓冲。 */
export const STOP_BUFFER_ATR = 0.1;
/** 主管仓:吊灯线(与几何实验室 settleTrail 同参)。 */
export const TRAIL_BARS = 168;
/** 副管仓:结构止盈 / 止损 / 48 根到期。 */
export const PLAN_BARS = 48;
/** 事件视图回看根数(与几何实验室 LOOKBACK 一致)。 */
export const LOOKBACK = 480;

export type Management = 'trail' | 'plan';

export interface SettleOut {
  management: Management;
  status: string;
  fill: number | null;
  exit_price: number | null;
  bars_held: number | null;
  gross_r: number | null;
  net_r: number | null;
  funding_r: number | null;
  funding_estimated: boolean;
  note: string;
}

/** 一个冻结事件。模型能看到的只有 prompt(按 as_of 截断的上下文);settle 只在结算时用未来 K 线。 */
export interface JrEvent {
  id: string;
  venue: Venue;
  symbol: string;
  period: string;
  as_of: number;
  direction: Dir;
  /** 选中的那条生产触发器 */
  kind: string;
  hits: TriggerHit[];
  ref_close: number;
  atr14: number;
  stop: number;
  stop_source: string;
  stop_atr: number;
  target: number | null;
  /** 代码过滤臂 A_f:1h 与 4h 的 EMA20/EMA50 都与方向一致(默认 playbook 的「适用」条件) */
  trend_ok: boolean;
  trail: SettleOut;
  plan: SettleOut;
}

export interface DropCounts {
  candidates: number;
  stop_too_close: number;
  cooldown: number;
  no_forward: number;
  no_features: number;
  accepted: number;
}
