/**
 * 交易页「来源 → 判断 → 风控与执行」三层(契约 docs/demo/v3-ui-contract.md §9.56;后端 gateway 在实现)。
 *
 *   GET   /api/execution-policy   → ExecutionPolicyView      风控与执行参数(所有来源共用)+ 区间 + 今日用量
 *   PATCH /api/execution-policy   {values…, confirm?}         人工改(公网演示仅 owner;live 通道要 confirm:'LIVE')
 *   GET   /api/trading/sources    → TradingSourcesView       机会来源:AI Scan(单例)+ 每个策略运行,今日漏斗与被挡原因
 *   GET   /api/demo/whoami        → { public_demo, role, read_only }   评审版网关才有;没有 = 本机/owner
 *
 * 404 / 网关还没这个接口 → hook 返回 null,组件走降级(AI Scan 卡用 agent-strategy + usage,运行卡用 runs.stats)。
 * 类型只放这里,不塞进 api/types.ts(别的会话在动)。
 */
import { useQuery } from '@tanstack/react-query';
import type { StrategyRunExecution, StrategyRunMode, StrategyRunStatus } from './types';

// ---------------------------------------------------------------------------
// 风控与执行

export type SizingAgentMode = 'off' | 'advise' | 'apply';

export interface ExecutionPolicyValues {
  /** 单笔风险 % 权益;十进制字符串或数字(网关两种都可能给) */
  risk_pct: string | number;
  leverage: number;
  margin_mode: 'cross' | 'isolated';
  min_stop_pct: string | number;
  max_stop_pct: string | number;
  /** 止损至少 k × ATR(波动率感知,默认 0.5);老网关没有 */
  min_stop_atr?: string | number;
  min_net_rr: string | number;
  max_open_threads: number;
  max_opens_per_day: number;
  daily_loss_stop_pct: string | number;
  sizing_agent: SizingAgentMode;
}
export type PolicyNumericKey = Exclude<keyof ExecutionPolicyValues, 'margin_mode' | 'sizing_agent'>;

/** 数字参数:min/max/step/agent_direct_*;枚举参数(margin_mode / sizing_agent):values / agent_direct_values */
export interface PolicyBound {
  min: number;
  max: number;
  values?: string[];
  agent_direct_values?: string[];
  step?: number;
  /** 模拟盘 agent 可以不经确认直接改的子区间;超出变提议 */
  agent_direct_min?: number;
  agent_direct_max?: number;
}

export interface ExecutionPolicyUsage {
  open_threads: number;
  opens_today: number;
  daily_loss_hit: boolean;
  max_open_threads?: number;
  max_opens_per_day?: number;
}

export interface ExecutionPolicyView {
  values: ExecutionPolicyValues;
  bounds: Partial<Record<keyof ExecutionPolicyValues, PolicyBound>>;
  /** 执行通道:paper / okx / binance … */
  backend: string;
  /** 真钱通道:保存要输入 LIVE */
  live: boolean;
  /** okx 模拟盘等;§9.56 不给,用 execution_label */
  profile?: 'demo' | 'live' | null;
  execution_label?: string;
  updated_at?: number;
  usage: ExecutionPolicyUsage;
}

/** §9.56 PATCH 只收执行层参数键(未知键整单 400),真钱确认只在界面上做 */
export type ExecutionPolicyPatch = Partial<ExecutionPolicyValues>;

// ---------------------------------------------------------------------------
// 机会来源

/** 候选在哪一层被挡:judge = 判断层不跟;strategy = 运行自己的上限/持仓规则(界面叫 Run cap);gate = 代码风控检查;execution = 下单/交易所 */
export type BlockLayer = 'judge' | 'gate' | 'strategy' | 'execution';

export interface SourceReasonExample {
  symbol?: string | null;
  at?: number | null;
  message?: string | null;
}
export interface SourceReason {
  layer: BlockLayer;
  key: string;
  label: string;
  count: number;
  /** 一条代表性样本;§9.56 给字符串「SYMBOL 原文」,也兼容对象 */
  example?: SourceReasonExample | string | null;
}

export interface SharedCapacity {
  open_threads: number;
  max_open_threads: number;
  opens_today: number;
  max_opens_per_day: number;
  daily_loss_hit: boolean;
  halted: boolean;
  paused: boolean;
}

export interface AiScanPlaybook {
  name: string;
  prompt_version?: string | number | null;
  custom?: boolean;
}

export interface AiScanSource {
  kind: 'ai_scan';
  id?: string;
  /** 网关给的显示名(中文);界面固定叫 AI Scan */
  name?: string;
  enabled: boolean;
  /** 为什么不开仓:急停 / 暂停 / Thread Manager 停 / Agent 绑了策略 */
  disabled_reason?: string | null;
  /** §9.56:对象 {name, prompt_version, custom};兼容老形状字符串 */
  playbook: AiScanPlaybook | string | null;
  judge: 'model';
  scan_mode?: string;
  budget?: { judgments_used_today: number; judgment_cap: number };
  /** 盯的币(观察列表去掉只观察) */
  symbols?: string[];
  timeframe?: string | null;
  today: {
    judgments: number;
    /** 老形状;§9.56 放在 budget.judgment_cap */
    cap?: number;
    /** 判断动作分布:PROPOSE / NO_TRADE / WATCH …(键以网关为准) */
    actions: Record<string, number>;
    proposals?: number;
    gate_rejected: number;
    orders: number;
    pending_approval?: number;
    failed?: number;
    open_threads?: number;
  };
  realized_r?: number | null;
  open_threads?: number;
  top_reasons: SourceReason[];
  /** 没做但不算被挡:模型判不交易/观察、暂停、行情没到等 */
  not_taken?: SourceReason[];
  /** 只停 AI 扫盘(workflow.ai_scan_paused),策略运行照跑 */
  paused?: boolean;
}

export interface SourceLastEvent {
  at: number;
  kind: string;
  symbol: string | null;
  message: string;
}

export interface StrategyRunSource {
  kind: 'strategy_run';
  run_id: string;
  strategy_id: string;
  name: string;
  version: number;
  symbols: string[];
  timeframe: string;
  mode: StrategyRunMode;
  status: StrategyRunStatus;
  execution?: StrategyRunExecution | null;
  today: {
    scans: number;
    candidates: number;
    judged: { follow: number; skip: number };
    gate_rejected: number;
    orders: number;
    open_threads: number;
  };
  realized_r?: number | null;
  last_event: SourceLastEvent | null;
  top_reasons: SourceReason[];
  not_taken?: SourceReason[];
}

export type TradingSource = AiScanSource | StrategyRunSource;

export interface TradingSourcesView {
  shared: SharedCapacity;
  sources: TradingSource[];
}

export interface DemoAccess {
  public_demo: boolean;
  role: string | null;
  read_only: boolean;
}

// ---------------------------------------------------------------------------
// 客户端

export class TradingApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 404 = 网关还没有这个接口 → null(调用方降级);其它错误抛 TradingApiError(code 取网关 error.code,如 judge_locked) */
async function request<T>(path: string, init?: RequestInit, opts: { nullOn404?: boolean } = {}): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(path, { headers: init?.body ? { 'content-type': 'application/json' } : undefined, ...init });
  } catch {
    throw new TradingApiError(0, 'gateway_unavailable', 'Gateway unreachable');
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
  if (res.status === 404 && opts.nullOn404 !== false) return null;
  if (!res.ok) {
    const e = body as { error?: string | { code?: string; message?: string }; code?: string; message?: string } | null;
    const code = (typeof e?.error === 'object' ? e.error?.code : undefined) ?? e?.code ?? 'unknown';
    const message = (typeof e?.error === 'string' ? e.error : e?.error?.message) ?? e?.message ?? res.statusText ?? `HTTP ${res.status}`;
    throw new TradingApiError(res.status, code, message);
  }
  if (typeof body === 'string') throw new TradingApiError(res.status, 'bad_response', 'Gateway returned non-JSON');
  // 评审版访客读仅所有者接口时可能回 200 + {locked:true, code:'judge_locked'} 占位
  if (body && typeof body === 'object' && (body as { locked?: unknown }).locked === true) throw new TradingApiError(403, 'judge_locked', 'Owner only in the public demo');
  return body as T;
}

export const tradingApi = {
  policy: () => request<ExecutionPolicyView>('/api/execution-policy'),
  patchPolicy: async (patch: ExecutionPolicyPatch): Promise<ExecutionPolicyView> => {
    const r = await request<ExecutionPolicyView | { policy: ExecutionPolicyView }>('/api/execution-policy', { method: 'PATCH', body: JSON.stringify(patch) }, { nullOn404: false });
    if (!r) throw new TradingApiError(500, 'bad_response', 'Empty response');
    return 'policy' in r ? r.policy : r;
  },
  sources: () => request<TradingSourcesView>('/api/trading/sources'),
  /** 单独暂停 / 继续 AI 扫盘 */
  patchAiScan: async (paused: boolean): Promise<void> => {
    await request('/api/trading/sources/ai_scan', { method: 'PATCH', body: JSON.stringify({ paused }) }, { nullOn404: false });
  },
  whoami: async (): Promise<DemoAccess> => (await request<DemoAccess>('/api/demo/whoami')) ?? { public_demo: false, role: null, read_only: false },
};

export const EXECUTION_POLICY_KEY = ['execution-policy'] as const;
export const TRADING_SOURCES_KEY = ['trading', 'sources'] as const;

/** null = 接口未就绪(404),undefined = 还在加载 */
export function useExecutionPolicy() {
  return useQuery({ queryKey: EXECUTION_POLICY_KEY, queryFn: tradingApi.policy, staleTime: 5_000, refetchInterval: 30_000, retry: false });
}
export function useTradingSources() {
  return useQuery({ queryKey: TRADING_SOURCES_KEY, queryFn: tradingApi.sources, staleTime: 5_000, refetchInterval: 15_000, retry: false });
}
export function useDemoAccess() {
  return useQuery({ queryKey: ['demo', 'whoami'], queryFn: tradingApi.whoami, staleTime: 5 * 60_000, retry: false });
}
