/**
 * 复盘页新接的后端(docs/design/watch-screener-review-2026-09-24.md 二-4)的类型 + 只读取数。
 * 放在独立文件,不改 api/types.ts(别人有未提交改动)。
 *
 *   GET /api/judgment-ledger/summary?since=   判断账本 jl-v2 汇总(网关 judgment-ledger.ts summarizeLedger)
 *   GET /api/judgment-ledger?limit&cursor&since  逐行(复盘页拿来算中位数 / 截尾均值 / regret 拆分)
 *   GET /api/candidates/summary?since=        影子候选汇总(strategy-candidate.ts summarizeCandidates)
 *   GET /api/candidates?limit&cursor&strategy_id  影子候选列表(新的在前)
 *   GET /api/research/strategies              我的策略列表(只取 id / name / lab_strategy_id 做深链索引)
 *
 * 口径提醒:summary 一次只取窗口内**最近 500 行**(routes-judgment.ts 的取数上限),逐行统计要对齐它,
 * 否则分层数字和中位数不是同一批行。
 */
import type { JudgmentLedgerRow, LedgerStratum, LedgerSummary } from '@/api/types';

// ---------------------------------------------------------------- 判断账本 jl-v2

export type LedgerDimV2 = 'strategy' | 'trigger_kind' | 'prompt_version' | 'holding_reason';

export interface LedgerStratumV2 extends LedgerStratum {
  dim?: LedgerDimV2 | null;
  value?: string | null;
  n_eligible?: number;
  excluded_incomplete?: number;
  /** alpha_n 里的独立簇数(同一线程的多次复查算 1 个)。 */
  alpha_clusters?: number;
  model_direction_rate?: number | null;
  model_known_n?: number;
  council_direction_rate?: number | null;
  council_known_n?: number;
  alpha_both_dir?: number | null;
  alpha_both_dir_n?: number;
  /** 只看选了 hold 腿(HOLD/ADD)的复查行:mean(max(0, exit_now_r − hold_r))。 */
  review_regret_hold?: number | null;
  review_hold_n?: number;
}

/** 复查决策表(review_decision_table):mode=review 按 动作 × 持仓原因 × 触发 × prompt 版本 分组。 */
export interface DecisionStratum {
  model_action: string;
  holding_reason: string;
  trigger_kind: string;
  prompt_version: string;
  n: number;
  clusters: number;
  mean_regret: number | null;
  mean_hold_r: number | null;
  mean_exit_now_r: number | null;
  mean_regret_hold: number | null;
  exit_regret_gt_half_share: number | null;
  settlement_incomplete: number;
  insufficient: boolean;
}

export interface LedgerSummaryV2 extends Omit<LedgerSummary, 'overall' | 'by_strategy'> {
  excluded_incomplete?: number;
  overall: LedgerStratumV2;
  by_strategy: LedgerStratumV2[];
  by_trigger_kind?: LedgerStratumV2[];
  by_holding_reason?: LedgerStratumV2[];
  by_prompt_version?: LedgerStratumV2[];
  by_decision?: DecisionStratum[];
  min_clusters?: number;
}

export interface LedgerRegretV2 {
  hold_r: number;
  exit_now_r: number;
  chosen_r: number;
  best_r: number;
  regret_r: number;
  /** 该走没走:选了 hold(HOLD/ADD)时 = max(0, exit_now_r − hold_r),否则 null。旧行没有。 */
  regret_hold?: number | null;
  /** 不该走走了:EXIT/INVALIDATE 时 = max(0, hold_r − exit_now_r),否则 null。旧行没有。 */
  regret_exit?: number | null;
  hold_status: string;
  note: string;
}

export type SettlementStatusV2 = 'complete' | 'partial' | 'missing' | (string & {});

export interface LedgerRowV2 extends Omit<JudgmentLedgerRow, 'regret'> {
  cluster_id?: string | null;
  trigger_kind?: string | null;
  holding_reason?: string | null;
  prompt_version?: string | null;
  model_stance?: 'direction' | 'flat' | 'unknown';
  council_stance?: 'direction' | 'flat' | 'unknown';
  regret_hold?: number | null;
  settlement_status?: SettlementStatusV2 | null;
  regret: LedgerRegretV2 | null;
}

export interface LedgerRowsPageV2 {
  rows: LedgerRowV2[];
  total: number;
  limit: number;
  next_cursor: string | null;
}

// ---------------------------------------------------------------- 影子候选 candidate-v0

export type PairBucket = 'propose_same' | 'propose_opposite' | 'no_trade' | 'watch' | 'review' | 'no_judgment' | 'no_episode' | 'pending';

export interface CandidateGroupStats {
  n: number;
  settled: number;
  plan_mean_r: number | null;
  trail_mean_r: number | null;
}

export interface CandidateSummary {
  version: string;
  n: number;
  open: number;
  settled: number;
  scoreable: number;
  since: number | null;
  first_as_of: number | null;
  last_as_of: number | null;
  mean_rr: number | null;
  share_with_target: number | null;
  plan_expectancy_r: number | null;
  plan_net_expectancy_r: number | null;
  trail_expectancy_r: number | null;
  plan_win_rate: number | null;
  nonoverlap: { n: number; plan_expectancy_r: number | null; plan_net_expectancy_r: number | null; trail_expectancy_r: number | null };
  by_symbol: Record<string, CandidateGroupStats>;
  by_strategy: Record<string, CandidateGroupStats & { strategy_id: string; version: number; ir_hash: string }>;
  pairing: Partial<Record<PairBucket, CandidateGroupStats>>;
  model_proposals_without_candidate: number;
  unmapped: Record<string, number>;
  sample_note: string;
}

export interface CandidateLeg {
  status: string;
  r: number | null;
  net_r?: number | null;
  fill_price: number | null;
  exit_price: number | null;
  bars_held: number | null;
  mae_r?: number | null;
  mfe_r?: number | null;
}

export interface CandidateRow {
  id: string;
  at: number;
  as_of: number;
  symbol: string;
  timeframe: string;
  strategy_id: string;
  version: number;
  ir_source: string;
  origin: 'online' | 'replay' | (string & {});
  direction: string;
  entry_ref: number;
  stop: number;
  target: number | null;
  rr: number | null;
  horizon_bars: number;
  reason: string;
  status: 'open' | 'settled' | (string & {});
  model: { status: string; bucket: PairBucket; episode_id: string | null; mode: string | null; action: string | null; direction: string | null; intent: boolean } | null;
  settlement: { source: 'plan_walk' | 'invalid' | 'unscoreable' | (string & {}); settled_at: number; bars_seen: number; plan: CandidateLeg | null; trail: CandidateLeg | null; note: string } | null;
}

export interface CandidatePage {
  rows: CandidateRow[];
  next_cursor: string | null;
  limit: number;
}

// ---------------------------------------------------------------- 我的策略索引

export interface StrategyIndexItem {
  id: string;
  name: string;
  lab_strategy_id: string | null;
}

// ---------------------------------------------------------------- fetch

export class LedgerV2Error extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = (body as { error?: { message?: unknown } } | null)?.error?.message;
    throw new LedgerV2Error(res.status, typeof msg === 'string' ? msg : res.statusText);
  }
  return body as T;
}

function qs(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** summary 的取数上限(routes-judgment.ts):逐行统计只取同样的最近 500 行。 */
export const LEDGER_SUMMARY_ROW_CAP = 500;

export const ledgerV2Api = {
  summary: (since: number | null) => getJson<LedgerSummaryV2>(`/api/judgment-ledger/summary${qs({ since })}`),
  /** 与 summary 同一批行:最近 500 行(一页)。 */
  rows: (since: number | null) => getJson<LedgerRowsPageV2>(`/api/judgment-ledger${qs({ since, limit: LEDGER_SUMMARY_ROW_CAP })}`),
  candidateSummary: (since: number | null) => getJson<CandidateSummary>(`/api/candidates/summary${qs({ since })}`),
  candidates: (opts: { limit?: number; cursor?: string | null; strategy_id?: string | null } = {}) => getJson<CandidatePage>(`/api/candidates${qs({ limit: opts.limit ?? 100, cursor: opts.cursor, strategy_id: opts.strategy_id })}`),
  strategyIndex: async (): Promise<StrategyIndexItem[]> => {
    const body = await getJson<{ strategies?: { id?: unknown; name?: unknown; lab_strategy_id?: unknown }[] }>('/api/research/strategies');
    return (body?.strategies ?? []).flatMap((s) => (typeof s.id === 'string' ? [{ id: s.id, name: typeof s.name === 'string' ? s.name : s.id, lab_strategy_id: typeof s.lab_strategy_id === 'string' ? s.lab_strategy_id : null }] : []));
  },
};
