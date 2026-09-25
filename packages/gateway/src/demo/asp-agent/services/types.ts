/**
 * 按次计费 A2A 服务(OKX.AI 一次性任务)的公共类型。
 * 这里只有纯业务:job 输入 → 交付内容。接单轮询、accept-job-by-provider、deliver、落库去重都归 provider-tasks.ts,
 * 本目录不调任何 onchainos 写命令,也不碰交易所。
 */
import type { AssetRecommendation, RecommendArgs } from '../../recommend.js';
import type { DailyRegime } from '../../types.js';
import type { ResearchBar } from '@trading-swarm/contracts';
import type { JudgeCandidateSnapshot, JudgeResult } from '../../research/judge/types.js';

export type ServiceKey = 'asset_horizon' | 'research_report' | 'plan_gate' | 'jev_probability';
export const SERVICE_KEYS: readonly ServiceKey[] = ['asset_horizon', 'research_report', 'plan_gate', 'jev_probability'];

/** 一次性任务里处理器需要的全部输入(轮询方从 list-tasks / status 里摊平后传进来) */
export interface PerCallJob {
  job_id: string;
  service_key: ServiceKey;
  /** 买方 create-task 的 --description(20–2000 字符,自然语言) */
  description: string;
  /** 买方 create-task 的 --service-params(可能是 JSON,也可能是自由文本,也可能缺) */
  service_params: string | null;
  buyer_agent_id?: string | null;
}

/** 交付物:text 走 `deliver --deliverable-text`;超长时另给 file(完整 JSON),text 只留摘要 + 哈希 */
export interface Deliverable {
  service_key: ServiceKey;
  job_id: string;
  /** 一行结论,给账本/楼层/通知用 */
  summary: string;
  text: string;
  file: { filename: string; content: string } | null;
  /** 规范化 JSON 的 sha256(hex),同时写进 text 和 payload,方便买方自验与后续上链锚定 */
  sha256: string;
  payload: Record<string, unknown>;
}

/** 输入不合格:轮询方应在 accept 之前调 validate,拿到它就 decline-job-by-provider(退款),不接单 */
export class ServiceInputError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface MatrixLike {
  create(body: Record<string, unknown>): { id: string };
  get(id: string): MatrixViewLike;
}
/** MatrixStudyService.get 的子集(只列报告要读的字段) */
export interface MatrixViewLike {
  id: string; status: string; stage: string; manifest_hash: string; protocol_hash: string; created_at: number; updated_at: number;
  progress: { done: number; total: number; note: string };
  conclusion: { kind: 'passed' | 'no_candidate'; finalist_ids: string[]; causes: Record<string, number>; not_applicable: number; research_only: number; text: string } | null;
  usage: { judge_calls: number; judge_usd: string; wall_ms: number };
  stop_reason: string | null; error?: string | null;
  spec: { symbols: string[]; timeframes: string[]; families: string[]; market: string; sides: string[]; arms: string[]; protocol: { evidence_mode: string; alpha: number; min_trades: number } };
  cells?: { id: string; symbol: string; timeframe: string; family: string; side: string; arm: string; applicability: string; result: { verdict: string; cause: string | null; selection: ScoreLike | null } | null }[];
  finalists: { id: string; symbol: string; timeframe: string; family: string; side: string; arm: string; passed: boolean | null; cause?: string | null; selection?: ScoreLike; holdout?: ScoreLike | null; portfolio?: { total_return: number; max_drawdown: number; trades: number } | null }[];
}
export interface ScoreLike { trades: number; total_return: number; sharpe: number | null; max_drawdown: number; win_rate: number | null }

/** 处理器依赖:全部注入,测试零网络;运行时由 deps.ts 从 DemoRuntime 组装 */
export interface ServiceDeps {
  now(): number;
  recommend(args: RecommendArgs): Promise<AssetRecommendation>;
  matrix(): MatrixLike | null;
  /** 已收盘 K 线,升序;取不到返回 [] */
  bars(symbol: string, timeframe: string, limit: number, market: 'spot' | 'perp'): Promise<ResearchBar[]>;
  regime(symbol: string): Promise<DailyRegime | null>;
  /** Jev 判断(钉住的决策连接 + 单次上限);没绑定/不可用返回 null,处理器按「只看代码门槛」交付并说明 */
  judge?(candidate: JudgeCandidateSnapshot, bars: readonly ResearchBar[], scope: string): Promise<JudgeResult | null>;
  /** 矩阵研究等结果的轮询间隔与上限(测试调小) */
  poll_ms?: number;
  matrix_timeout_ms?: number;
  sleep?(ms: number): Promise<void>;
}

export interface PerCallService<P = unknown> {
  key: ServiceKey;
  /** accept 之前调用:只解析和校验,不取数、不花钱 */
  validate(job: PerCallJob): P;
  handle(job: PerCallJob, params: P, deps: ServiceDeps): Promise<Deliverable>;
}

// ---------------------------------------------------------------- 订阅频道(按月订阅,推送型)

/**
 * 订阅服务 = 一个或几个「频道」。频道只产出推送内容,不碰 CLI:
 * 何时调用(定时 / 事件 / 新订阅欢迎包)、扇出给哪些订阅 job、deliver、落账,都归 broadcaster(services/broadcast.ts)。
 * 没有活跃订阅者时 broadcaster 不会调用 tick(不取数、不花模型钱)。
 */
export type ChannelKey = 'market_brief' | 'radar_feed' | 'micro_alerts';
export interface ChannelPush {
  /** 全局唯一且可重放判重:同一内容重复 tick 必须给同一个 event_id(例:`radar:swing:<screen_id>`) */
  event_id: string;
  channel: ChannelKey;
  summary: string;
  /** 推给订阅者的全文(第一行是标题,人读;可附一段 JSON) */
  text: string;
  payload: Record<string, unknown>;
}
export interface ChannelDeps {
  now(): number;
  /** 频道私有的小状态(上次推送时间、冷却、游标),broadcaster 负责持久化 */
  state: { get(key: string): string | null; set(key: string, value: string): void };
  log(level: 'info' | 'warn' | 'error', msg: string): void;
}
export interface SubscriptionChannel<D = unknown> {
  key: ChannelKey;
  /** 定时检查:有新内容就返回推送,没有返回 null。broadcaster 按 every_ms 调用 */
  every_ms: number;
  tick(deps: ChannelDeps & D): Promise<ChannelPush | null>;
  /** 新订阅立即推的一份(可复用最近一份,必须有内容,不能返回空) */
  welcome(deps: ChannelDeps & D): Promise<ChannelPush>;
}
