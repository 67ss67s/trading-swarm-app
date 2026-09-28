/**
 * 实盘 Jev 判断流(docs/design/jev-live-2026-09-25.md;后端 gateway/src/demo/judge-live.ts + routes-judge-live.ts)。
 *
 *   GET   /api/judge/live?limit=&run_id=   → { items: JudgeLiveItem[], summary: JudgeLiveSummary }
 *   GET   /api/judge/live/summary?run_id=  → JudgeLiveSummary
 *   GET   /api/judge/live/stream           → SSE `event: judge.live`(data = JudgeLiveRecord)
 *   PATCH /api/strategy-runs/:id {jev_shadow} → 开/关某个运行的影子判断
 *
 * 类型只镜像界面用到的字段(后端为准);不改 api/client.ts / api/types.ts(别的会话在动)。
 */
import { useEffect } from 'react';
import { t } from '../lib/i18n';
import { friendlyError } from '../lib/edition';
import { useQuery, useQueryClient } from '@tanstack/react-query';

export type JudgeLiveMode = 'shadow' | 'gate';
export type JudgeLiveStatus = 'ok' | 'uncertain' | 'error' | 'skipped';
export interface JudgeLiveCandidate { candidate_id: string | null; direction: 'long' | 'short'; entry: string; stop: string; target: string | null; reward_risk: number | null }
export interface JudgeLiveQuestion { key: string; type: 'noul' | 'score' | 'choice'; instructions: string; labels: string[] }
export interface JudgeLiveAnswer { question_key: string; probabilities: Record<string, number> }
export interface JudgeLivePredicate { question_key: string; label: string; probability: number; conservative: number; passed: boolean }
export interface JudgeLiveMicro { requested: boolean; book: boolean; liquidations: boolean; used: boolean; note: string | null }
export interface JudgeLiveState { candidate: Record<string, unknown>; features: Record<string, unknown>; micro: JudgeLiveMicro }
export interface JudgeLiveOutcome { thread_id: string; status: string; opened: boolean; closed: boolean; realized_r: number | null }
export interface JudgeLiveRecord {
  id: string; decision_id: string | null; run_id: string; strategy_id: string; strategy_name: string; symbol: string; timeframe: string;
  as_of: number; mode: JudgeLiveMode; status: JudgeLiveStatus; action: 'follow' | 'skip' | null;
  candidate: JudgeLiveCandidate; questions: JudgeLiveQuestion[]; answers: JudgeLiveAnswer[]; predicates: JudgeLivePredicate[];
  state: JudgeLiveState | null; reason_codes: string[]; cost_usd: string | null; latency_ms: number | null; error: string | null; model: string | null; created_at: number;
}
export type JudgeLiveItem = JudgeLiveRecord & { outcome?: JudgeLiveOutcome | null };
export interface JudgeLiveBucket { judged: number; traded: number; closed: number; wins: number; realized_r_sum: number | null; avg_r: number | null }
export interface JudgeLiveSummary {
  day_start: number;
  today: { judged: number; calls: number; cost_usd: string; reserved_usd: string; follow: number; skip: number; follow_ratio: number | null; errors: number; skipped: number; shadow: number; gate: number; skip_reasons: Record<string, number> };
  budgets: { run_id: string; max_calls: number; calls: number; max_usd: string; spent_usd: string; reserved_usd: string }[];
  comparison: { window_from: number; follow: JudgeLiveBucket; skip: JudgeLiveBucket };
}
export interface JudgeLiveResponse { items: JudgeLiveItem[]; summary: JudgeLiveSummary }

export class JudgeLiveError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(friendlyError(message)); }
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: init?.body ? { 'content-type': 'application/json' } : undefined, ...init });
  } catch {
    throw new JudgeLiveError(0, 'gateway_unavailable', t('网关暂时连不上'));
  }
  const text = await res.text();
  let body: unknown = null;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  if (!res.ok) {
    const e = body as { error?: string | { code?: string; message?: string }; code?: string } | null;
    const code = typeof e?.error === 'object' ? e.error?.code : e?.code;
    const message = typeof e?.error === 'string' ? e.error : e?.error?.message;
    throw new JudgeLiveError(res.status, code ?? 'unknown', message ?? res.statusText ?? `HTTP ${res.status}`);
  }
  return body as T;
}
function qs(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const judgeLiveApi = {
  list: (opts: { limit?: number; run_id?: string | null } = {}) => request<JudgeLiveResponse>(`/api/judge/live${qs({ limit: opts.limit, run_id: opts.run_id })}`),
  summary: (run_id?: string | null) => request<JudgeLiveSummary>(`/api/judge/live/summary${qs({ run_id })}`),
  /** 开/关某个运行的影子判断(只影响记录,不影响下单) */
  setShadow: (run_id: string, on: boolean) => request<{ run: { id: string; jev_shadow?: boolean } }>(`/api/strategy-runs/${encodeURIComponent(run_id)}`, { method: 'PATCH', body: JSON.stringify({ jev_shadow: on }) }),
};

export const judgeLiveKey = (run_id: string | null | undefined, limit: number) => ['judge', 'live', run_id ?? null, limit] as const;

/** 判断流数据:30 秒兜底轮询 + judge.live SSE 一来就刷新。楼层判断桌和 Agent 页共用同一个缓存键。 */
export function useJudgeLive(opts: { limit?: number; runId?: string | null; live?: boolean } = {}) {
  const limit = opts.limit ?? 50;
  useJudgeLiveStream(opts.live !== false);
  return useQuery({ queryKey: judgeLiveKey(opts.runId, limit), queryFn: () => judgeLiveApi.list({ limit, run_id: opts.runId ?? null }), refetchInterval: 30_000, retry: 1 });
}

/**
 * 订阅 /api/judge/live/stream。整页只开一条(引用计数),断线 1s 起退避到 5s 重连。
 * 每来一条就让 ['judge','live'] 下所有查询失效(列表 + 汇总一起刷新)。
 */
let es: EventSource | null = null, subscribers = 0, retryMs = 1000, retryTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<(row: JudgeLiveRecord) => void>();
function connect(): void {
  if (es || subscribers === 0 || typeof EventSource === 'undefined') return;
  const src = new EventSource('/api/judge/live/stream');
  es = src;
  src.addEventListener('judge.live', ((ev: MessageEvent) => {
    let row: JudgeLiveRecord;
    try { row = JSON.parse(ev.data) as JudgeLiveRecord; } catch { return; }
    for (const fn of listeners) { try { fn(row); } catch { /* 单个订阅者出错不影响别人 */ } }
  }) as EventListener);
  src.addEventListener('open', () => { retryMs = 1000; });
  src.addEventListener('error', () => {
    src.close(); if (es === src) es = null;
    if (subscribers === 0) return;
    retryTimer = setTimeout(connect, retryMs); retryMs = Math.min(5000, retryMs * 2);
  });
}
export function useJudgeLiveStream(enabled = true, onRow?: (row: JudgeLiveRecord) => void): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const fn = (row: JudgeLiveRecord) => { void qc.invalidateQueries({ queryKey: ['judge', 'live'] }); onRow?.(row); };
    listeners.add(fn); subscribers++; connect();
    return () => {
      listeners.delete(fn); subscribers--;
      if (subscribers === 0) { if (retryTimer) clearTimeout(retryTimer); retryTimer = undefined; es?.close(); es = null; }
    };
  }, [enabled, qc, onRow]);
}
