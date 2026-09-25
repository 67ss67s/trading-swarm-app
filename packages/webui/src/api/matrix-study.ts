/**
 * 矩阵研究(契约 §9.53 B,后端 gateway/src/demo/research/matrix-study/*,路由 routes-matrix-study.ts)。
 *
 *   GET  /api/research/matrix-studies/prefill?recommendation_id=  → { spec, notes }   从推荐卡预填
 *   POST /api/research/matrix-studies/estimate {spec}            → MatrixEstimate
 *   POST /api/research/matrix-studies {spec, idempotency_key}    → MatrixStudyView
 *   GET  /api/research/matrix-studies                            → { items: MatrixStudyView[] }
 *   GET  /api/research/matrix-studies/:id                        → MatrixStudyView
 *   POST /api/research/matrix-studies/:id/cancel | /finalize | /adopt {finalist_id}
 *
 * 类型只镜像界面用到的字段(后端 types.ts 为准);接口若改名只改本文件。不改 api/types.ts(别人在动)。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export type MatrixTimeframe = '3m' | '5m' | '15m' | '4h' | '1d';
export type MatrixArm = 'code' | 'code_judge';
export type FailureCause = 'cost_dominated' | 'insufficient_evidence' | 'unsupported_execution' | 'underperform_hold';
export type MatrixStudyStatus = 'queued' | 'running' | 'ready_to_finalize' | 'finalizing' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
export type MatrixStage = 'queued' | 'data' | 'matrix' | 'iterate' | 'sealed' | 'holdout' | 'done';

export interface SlimScore {
  trades: number; total_return: number; sharpe: number | null; max_drawdown: number; exposure: number;
  expectancy: number | null; win_rate: number | null; stressed_return: number | null; hold_return: number | null; exposure_matched_hold: number | null;
}
export interface GateRow { name: string; ok: boolean; value: number | null }
export interface MatrixSpecLite {
  symbols: string[]; timeframes: MatrixTimeframe[]; families: string[]; market: 'spot' | 'perp'; sides: ('long' | 'short')[]; arms: MatrixArm[];
  recommendation_id: string | null; [k: string]: unknown;
}
export interface MatrixCellDef { id: string; symbol: string; timeframe: MatrixTimeframe; family: string; side: 'long' | 'short'; arm: MatrixArm; applicability: 'applicable' | 'not_applicable' | 'research_only'; reason: string | null }
export interface CellResult {
  cell_id: string; verdict: 'pass' | 'near' | 'fail' | 'ineligible'; cause: FailureCause | null;
  selection: SlimScore | null; train: SlimScore | null; gates: GateRow[]; dsr: number | null; evaluated: number;
  judge_delta: { mean_daily: number | null; ci95: [number, number] | null; kept_ratio: number | null; error_ratio?: number | null; all_skipped?: boolean } | null;
}
export interface MatrixGeneration { n: number; cell_id: string; diagnosis: string; change: string; selection: SlimScore | null; promoted: boolean; note: string }
export interface PortfolioReplay { total_return: number; max_drawdown: number; trades: number; skipped_by_judge: number; skipped_by_capacity: number; exposure: number }
export interface MatrixFinalist {
  id: string; cell_id: string; arm: MatrixArm; symbol: string; timeframe: MatrixTimeframe; family: string; side: 'long' | 'short';
  selection: SlimScore; dsr: number | null; holdout: SlimScore | null; passed: boolean | null; cause: FailureCause | null;
  test: { p_value: number | null; holm_threshold: number | null; rejected: boolean } | null;
  portfolio?: PortfolioReplay | null; horizon?: 'short' | 'mid' | 'long';
}
export interface MatrixConclusion { kind: 'passed' | 'no_candidate'; finalist_ids: string[]; causes: Record<FailureCause, number>; not_applicable: number; research_only: number; text: string }
export interface MatrixStudyView {
  id: string; status: MatrixStudyStatus; stage: MatrixStage; created_at: number; updated_at: number; manifest_hash: string;
  manifest: { spec: MatrixSpecLite; cells: MatrixCellDef[] };
  state: {
    stage: MatrixStage; progress: { done: number; total: number; eta_ms: number | null; note: string };
    holdout_state: 'sealed' | 'claimed' | 'released';
    cells: Record<string, CellResult>; generations: MatrixGeneration[]; finalists: MatrixFinalist[];
    conclusion: MatrixConclusion | null;
    usage: { judge_calls: number; judge_usd: string; judge_reserved_usd?: string; judge_unknown_cost_calls?: number; llm_calls: number; llm_usd: string; wall_ms: number };
    stop_reason: string | null; notes: string[]; error: string | null;
  };
  ledger?: { attempt_count: number; trial_count: number; study_trial_count: number; effective_trials: { conservative: number } } | null;
  /** 已存成我的策略的 finalist(后端 detail.adoptions);刷新后据此恢复「已存」状态 */
  adoptions: Record<string, { strategy_id: string; version: number }>;
  auto_finalize: boolean;
}
export interface MatrixEstimate {
  cells: { total: number; applicable: number; not_applicable: number; research_only: number };
  matrix_trials: number; iteration_trials_max: number; variants: number;
  judge_calls: number; judge_usd: string;
  data: { series: number; bars: number; cold_fetch_ms_upper: number };
  within_budget: boolean; warnings: string[];
}
export interface MatrixEstimateResponse { spec: MatrixSpecLite; estimate: MatrixEstimate }

const BASE = '/api/research/matrix-studies';
async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = json as { error?: string | { message?: string }; message?: string } | null;
    throw new Error(typeof e?.error === 'string' ? e.error : e?.error?.message ?? e?.message ?? res.statusText);
  }
  return json as T;
}
/** 后端视图是平铺的(service.view):这里转成页面用的 manifest/state 形状;列表视图没有 cells 与明细 */
type RawCell = MatrixCellDef & { result: CellResult | null };
function unwrap(raw: unknown): MatrixStudyView {
  const v = raw as Record<string, unknown> & { cells?: RawCell[] };
  const cells = v.cells ?? [];
  return {
    id: v['id'] as string, status: v['status'] as MatrixStudyStatus, stage: v['stage'] as MatrixStage,
    created_at: v['created_at'] as number, updated_at: v['updated_at'] as number, manifest_hash: v['manifest_hash'] as string,
    manifest: { spec: v['spec'] as MatrixSpecLite, cells: cells.map(({ result: _r, ...c }) => c) },
    state: {
      stage: v['stage'] as MatrixStage,
      progress: (v['progress'] as MatrixStudyView['state']['progress']) ?? { done: 0, total: 0, eta_ms: null, note: '' },
      holdout_state: (v['holdout_state'] as MatrixStudyView['state']['holdout_state']) ?? 'sealed',
      cells: Object.fromEntries(cells.filter((c) => c.result).map((c) => [c.id, c.result!])),
      generations: (v['generations'] as MatrixGeneration[]) ?? [],
      finalists: (v['finalists'] as MatrixFinalist[]) ?? [],
      conclusion: (v['conclusion'] as MatrixConclusion | null) ?? null,
      usage: (v['usage'] as MatrixStudyView['state']['usage']) ?? { judge_calls: 0, judge_usd: '0', llm_calls: 0, llm_usd: '0', wall_ms: 0 },
      stop_reason: (v['stop_reason'] as string | null) ?? null, notes: (v['notes'] as string[]) ?? [], error: (v['error'] as string | null) ?? null,
    },
    ledger: (v['ledger'] as MatrixStudyView['ledger']) ?? null,
    adoptions: Object.fromEntries(((v['adoptions'] as { finalist_id: string; adopted: { strategy_id: string; version: number } }[] | undefined) ?? []).map((a) => [a.finalist_id, a.adopted])),
    auto_finalize: (v['spec'] as { auto_finalize?: boolean } | undefined)?.auto_finalize !== false,
  };
}

export const matrixApi = {
  prefill: (recommendationId: string) => call<{ spec: MatrixSpecLite; notes?: string[] }>('GET', `/prefill?recommendation_id=${encodeURIComponent(recommendationId)}`),
  estimate: (spec: MatrixSpecLite) => call<MatrixEstimateResponse>('POST', '/estimate', { spec }),
  create: (spec: MatrixSpecLite) => call<unknown>('POST', '', { spec, idempotency_key: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }).then(unwrap),
  list: () => call<{ items: unknown[] }>('GET', '').then((r) => ({ items: r.items.map(unwrap) })),
  get: (id: string) => call<unknown>('GET', `/${encodeURIComponent(id)}`).then(unwrap),
  cancel: (id: string) => call<unknown>('POST', `/${encodeURIComponent(id)}/cancel`, {}).then(unwrap),
  /** 留出段只释放一次;必须带创建时冻结的 manifest_hash,后端对不上就拒 */
  finalize: (id: string, manifestHash: string) => call<unknown>('POST', `/${encodeURIComponent(id)}/finalize`, { expected_manifest_hash: manifestHash }).then(unwrap),
  adopt: (id: string, finalistId: string) => call<{ strategy_id: string; version: number; preflight?: { deployable: boolean; warnings: { code: string; message: string }[] } }>('POST', `/${encodeURIComponent(id)}/adopt`, { finalist_id: finalistId }),
};

const LIVE: MatrixStudyStatus[] = ['queued', 'running', 'finalizing'];
export function useMatrixStudy(id: string | null) {
  return useQuery({
    queryKey: ['matrix-study', id], queryFn: () => matrixApi.get(id!), enabled: !!id,
    // 研究在跑时 3 秒刷新一次(不接 SSE,避免和别人改 client.ts 冲突)
    refetchInterval: (q) => (q.state.data && LIVE.includes(q.state.data.status) ? 3000 : false),
  });
}
export function useMatrixStudies() {
  return useQuery({ queryKey: ['matrix-studies'], queryFn: () => matrixApi.list(), refetchInterval: 15_000 });
}
export function useMatrixAction() {
  const qc = useQueryClient();
  const done = (v: MatrixStudyView) => { qc.setQueryData(['matrix-study', v.id], v); void qc.invalidateQueries({ queryKey: ['matrix-studies'] }); };
  return {
    cancel: useMutation({ mutationFn: (id: string) => matrixApi.cancel(id), onSuccess: done }),
    finalize: useMutation({ mutationFn: (a: { id: string; manifest_hash: string }) => matrixApi.finalize(a.id, a.manifest_hash), onSuccess: done }),
    adopt: useMutation({ mutationFn: (a: { id: string; finalist_id: string }) => matrixApi.adopt(a.id, a.finalist_id) }),
  };
}
