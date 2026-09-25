/**
 * 进化页 + 楼层「今天」条的接口(docs/design/evolution-floor-2026-09-23.md §四,只读、零模型)。
 *
 *   GET /api/evolution/daily?from=&to=   → EvoDailyResponse(缺省最近 90 天,UTC 日)
 *   GET /api/evolution/day?role=&date=   → EvoDayDetail(点格子开抽屉才拉)
 *
 * react-query key:
 *   ['evolution','daily',from,to]   方格 + today(楼层与进化页共用;没有 SSE,5 分钟轮询)
 *   ['evolution','day',role,date]   单格明细
 *
 * 接口没上线(404 / 网络错)时查询进 error 态,调用方显示「进化数据接口未就绪」、方格全灰;
 * adapt* 对后端字段做防御式归一(缺字段 / 状态值写错都落到 none),别让半截数据把页面打崩。
 * LAB 最近产出(研究 / 回测 / 改进环)的只读查询也放在这里——它是楼层进化改动的一部分。
 */
import { useQuery } from '@tanstack/react-query';

export type EvoStatus = 'good' | 'ok' | 'bad' | 'none';

export interface EvoDay {
  /** UTC 日,YYYY-MM-DD */
  date: string;
  status: EvoStatus;
  score: number | null;
  headline: string | null;
  /** 当天进化事件数(提炼 / 验证 / 采纳),不影响颜色 */
  events?: number;
}

export interface EvoSummary {
  good: number;
  ok: number;
  bad: number;
  none: number;
  baseline_days: number;
}

export interface EvoRoleRow {
  role: string;
  label: string;
  metric_label: string;
  days: EvoDay[];
  summary: EvoSummary;
}

export interface EvoToday {
  date: string;
  /** 十进制字符串 */
  equity: string | null;
  judgments: { used: number; cap: number; cost_cny: number | null; idle_share: number | null } | null;
  live_pool: { size: number; reason: string | null } | null;
  candidates: { open: number; settled: number } | null;
}

export interface EvoDailyResponse {
  version: string;
  from: string;
  to: string;
  roles: EvoRoleRow[];
  today: EvoToday | null;
}

export interface EvoMetric {
  key: string;
  label: string;
  value: number | string | null;
  unit: string | null;
}

export interface EvoRecord {
  at: number;
  kind: string;
  title: string;
  /** 前端 hash 路由(如 '#judgments?episode=…');可为 null */
  ref: string | null;
}

export type EvoEventKind = 'memory_proposed' | 'memory_activated' | 'strategy_promoted' | 'improve_candidate' | 'prompt_version' | 'param_probe' | (string & {});

export interface EvoEvent {
  at: number;
  kind: EvoEventKind;
  title: string;
  ref: string | null;
}

export interface EvoDayDetail {
  role: string;
  date: string;
  status: EvoStatus;
  score: number | null;
  baseline: { days: number; mean: number | null; note: string | null } | null;
  metrics: EvoMetric[];
  records: EvoRecord[];
  events: EvoEvent[];
}

// ---------------------------------------------------------------- 归一

const STATUSES: readonly EvoStatus[] = ['good', 'ok', 'bad', 'none'];

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;
}

export function normStatus(v: unknown): EvoStatus {
  return typeof v === 'string' && (STATUSES as readonly string[]).includes(v) ? (v as EvoStatus) : 'none';
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function adaptDay(raw: unknown): EvoDay | null {
  const o = rec(raw);
  const date = str(o?.date);
  if (!o || !date || !DATE_RE.test(date)) return null;
  const events = num(o.events);
  return { date, status: normStatus(o.status), score: num(o.score), headline: str(o.headline), ...(events != null ? { events } : {}) };
}

function countSummary(days: EvoDay[]): EvoSummary {
  const s: EvoSummary = { good: 0, ok: 0, bad: 0, none: 0, baseline_days: 0 };
  for (const d of days) s[d.status] += 1;
  return s;
}

export function adaptDaily(raw: unknown): EvoDailyResponse {
  const o = rec(raw) ?? {};
  const roles: EvoRoleRow[] = arr(o.roles).flatMap((r) => {
    const ro = rec(r);
    const role = str(ro?.role);
    if (!ro || !role) return [];
    const days = arr(ro.days).map(adaptDay).filter((d): d is EvoDay => d !== null);
    const sm = rec(ro.summary);
    const summary: EvoSummary = sm
      ? { good: num(sm.good) ?? 0, ok: num(sm.ok) ?? 0, bad: num(sm.bad) ?? 0, none: num(sm.none) ?? 0, baseline_days: num(sm.baseline_days) ?? 0 }
      : countSummary(days);
    return [{ role, label: str(ro.label) ?? role, metric_label: str(ro.metric_label) ?? '', days, summary }];
  });
  const td = rec(o.today);
  const j = rec(td?.judgments);
  const lp = rec(td?.live_pool);
  const cd = rec(td?.candidates);
  const today: EvoToday | null = td
    ? {
        date: str(td.date) ?? '',
        equity: str(td.equity),
        judgments: j ? { used: num(j.used) ?? 0, cap: num(j.cap) ?? 0, cost_cny: num(j.cost_cny), idle_share: num(j.idle_share) } : null,
        live_pool: lp ? { size: num(lp.size) ?? 0, reason: str(lp.reason) } : null,
        candidates: cd ? { open: num(cd.open) ?? 0, settled: num(cd.settled) ?? 0 } : null,
      }
    : null;
  return { version: str(o.version) ?? '', from: str(o.from) ?? '', to: str(o.to) ?? '', roles, today };
}

export function adaptDayDetail(raw: unknown): EvoDayDetail {
  const o = rec(raw) ?? {};
  const b = rec(o.baseline);
  const item = (x: unknown) => {
    const r = rec(x);
    return r ? { at: num(r.at) ?? 0, kind: str(r.kind) ?? '', title: str(r.title) ?? '', ref: str(r.ref) } : null;
  };
  return {
    role: str(o.role) ?? '',
    date: str(o.date) ?? '',
    status: normStatus(o.status),
    score: num(o.score),
    baseline: b ? { days: num(b.days) ?? 0, mean: num(b.mean), note: str(b.note) } : null,
    metrics: arr(o.metrics).flatMap((m) => {
      const r = rec(m);
      if (!r) return [];
      const v = r.value;
      return [{ key: str(r.key) ?? '', label: str(r.label) ?? str(r.key) ?? '', value: typeof v === 'number' || typeof v === 'string' ? v : null, unit: str(r.unit) }];
    }),
    records: arr(o.records).map(item).filter((x): x is EvoRecord => x !== null),
    events: arr(o.events).map(item).filter((x): x is EvoEvent => x !== null),
  };
}

// ---------------------------------------------------------------- fetch

export class EvolutionApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(path);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = rec(rec(body)?.error)?.message;
    throw new EvolutionApiError(res.status, typeof msg === 'string' ? msg : res.statusText);
  }
  return body;
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const evolutionApi = {
  daily: async (opts: { from?: string; to?: string } = {}) => adaptDaily(await getJson(`/api/evolution/daily${qs(opts)}`)),
  day: async (role: string, date: string) => adaptDayDetail(await getJson(`/api/evolution/day${qs({ role, date })}`)),
};

/** 最近 90 天方格 + today;楼层与进化页共用同一份缓存 */
export function useEvolutionDaily(opts: { from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: ['evolution', 'daily', opts.from ?? null, opts.to ?? null],
    queryFn: () => evolutionApi.daily(opts),
    refetchInterval: 300_000,
    staleTime: 60_000,
    retry: false,
  });
}

export function useEvolutionDay(role: string | null, date: string | null) {
  return useQuery({
    queryKey: ['evolution', 'day', role, date],
    queryFn: () => evolutionApi.day(role!, date!),
    enabled: Boolean(role && date),
    staleTime: 60_000,
    retry: false,
  });
}

// ---------------------------------------------------------------- LAB 最近产出(研究 / 回测 / 改进环)

export interface LabImproveJob {
  id: string;
  status: string;
  label: string | null;
  strategy_id: string | null;
  updated_at: number;
  summary: string | null;
}

export function adaptImproveJobs(raw: unknown): LabImproveJob[] {
  return arr(rec(raw)?.jobs).flatMap((j) => {
    const r = rec(j);
    const id = str(r?.id);
    if (!r || !id) return [];
    return [{ id, status: str(r.status) ?? '', label: str(r.label), strategy_id: str(r.strategy_id), updated_at: num(r.finished_at) ?? num(r.updated_at) ?? num(r.created_at) ?? 0, summary: str(r.summary) ?? str(r.message) }];
  });
}

/** GET /api/research/improve?limit=(改进环任务列表;不在 client.ts 里,楼层只读用) */
export function useLabImproveJobs(limit = 3) {
  return useQuery({
    queryKey: ['research', 'improve', 'jobs', limit],
    queryFn: async () => adaptImproveJobs(await getJson(`/api/research/improve${qs({ limit })}`)),
    refetchInterval: 120_000,
    retry: false,
  });
}
