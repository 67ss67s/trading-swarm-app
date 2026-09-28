/**
 * Pine 脚本目录面板(研究域,零下单):引擎状态灯 + 脚本列表 / 搜索 + 详情(正文、参数表、准入报告)
 * + 「贴一段 Pine」新建(自动跑准入)+ 重跑准入 + 删除(页面内二次确认)。
 *
 * 后端:packages/gateway/src/demo/research/pine/routes.ts。
 * 这里自带一层 fetch(pineApi),错误统一抛 client.ts 导出的 ApiRequestError,react-query key 前缀 ['research','pine',...]。
 * 准入报告兼容 v1(只有顶层 checks,单一合成数据)与 v2(suites:每套数据一块)。
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, LoaderCircle, Plus, RefreshCw, Search, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { ApiRequestError } from '@/api/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { fmtDateTime } from '@/lib/format';
import { t, tmap, listSep } from '@/lib/i18n';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// 形状(对齐 gateway pine/catalog.ts + admission.ts v2;旧数据字段缺失时都按可选处理)

export type PineEngineStatus = 'up' | 'starting' | 'down' | 'disabled';

export interface PineHealth {
  status: PineEngineStatus;
  pid: number | null;
  port: number | null;
  restarts: number;
  last_error: string | null;
  engine: 'pinets' | string;
  version: string | null;
  scripts: number;
  admitted: number;
  hint?: string;
}

export type PineCheckName = 'outputs' | 'determinism' | 'causality' | 'warmup' | 'inputs';

export interface PineAdmissionCheck {
  name: PineCheckName | string;
  ok: boolean;
  message: string;
}

export interface PineAdmissionSuite {
  id: 'synthetic' | 'market' | 'custom' | string;
  label: string;
  dataset_id: string | null;
  symbol: string | null;
  timeframe: string;
  bars: number;
  ok: boolean;
  checks: PineAdmissionCheck[];
  outputs: string[];
  warmup_bars: number;
  sample_points: number[];
}

export interface PineAdmissionReport {
  ok: boolean;
  method_version: 'pine_admission_v1' | 'pine_admission_v2' | string;
  checks: PineAdmissionCheck[];
  outputs: string[];
  warmup_bars: number;
  sample_points: number[];
  bars: number;
  timeframe: string;
  tolerance: number;
  warnings: string[];
  ran_at: number;
  /** false = 研究库里没有日线 / 4h 数据集,只用了合成数据 */
  real_data?: boolean;
  suites?: PineAdmissionSuite[];
}

export interface PineInputParam {
  type: 'int' | 'float' | 'bool' | 'string' | 'source';
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: (string | number)[];
  title?: string;
}

export interface PineInputsSchema {
  params?: Record<string, PineInputParam>;
  defaults?: Record<string, unknown>;
}

export type PineSource = 'user' | 'agent' | 'community';

export interface PineScriptSummary {
  id: string;
  name: string;
  description: string;
  aliases: string[];
  inputs_schema: PineInputsSchema;
  outputs: string[];
  source: PineSource;
  license: string | null;
  author: string | null;
  admitted: boolean;
  created_at: number;
  updated_at: number;
  usage_count: number;
  admission_summary: { ok: boolean; warmup_bars: number; failed: string[] } | null;
}

export interface PineScript extends Omit<PineScriptSummary, 'admission_summary'> {
  script: string;
  admission_report: PineAdmissionReport | null;
}

export interface PineMutationResult {
  script: PineScript | null;
  admission: PineAdmissionReport | null;
  error: string | null;
}

export interface PineScriptCreate {
  name: string;
  description?: string;
  aliases?: string[];
  script: string;
  inputs_schema?: PineInputsSchema;
  source?: 'user';
  license?: string;
  author?: string;
}

// ---------------------------------------------------------------------------
// fetch:与 client.ts 的 request() 同口径(JSON、错误体 {error:{code,message}}),client.ts 没导出 request,这里自带一份。

async function pineRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = body as { error?: { code?: string; message?: string } } | null;
    throw new ApiRequestError(res.status, err?.error?.code ?? 'unknown', err?.error?.message ?? (text || res.statusText));
  }
  return body as T;
}

/** 旧网关的 health 是 {ok, url, error, hint};收敛成新形状,避免后端切换期间整块白屏。 */
function normalizeHealth(raw: unknown): PineHealth {
  const r = (raw ?? {}) as Partial<PineHealth> & { ok?: boolean; error?: string };
  const status: PineEngineStatus = r.status ?? (r.ok ? 'up' : 'down');
  return {
    status,
    pid: r.pid ?? null,
    port: r.port ?? null,
    restarts: r.restarts ?? 0,
    last_error: r.last_error ?? r.error ?? null,
    engine: r.engine ?? 'pinets',
    version: r.version ?? null,
    scripts: r.scripts ?? 0,
    admitted: r.admitted ?? 0,
    ...(r.hint ? { hint: r.hint } : {}),
  };
}

export const pineApi = {
  health: () => pineRequest<unknown>('/api/research/pine/health').then(normalizeHealth),
  scripts: (opts: { q?: string; admitted?: boolean; limit?: number } = {}) => {
    const sp = new URLSearchParams();
    if (opts.q?.trim()) sp.set('q', opts.q.trim());
    if (opts.admitted) sp.set('admitted', 'true');
    if (opts.limit) sp.set('limit', String(opts.limit));
    const s = sp.toString();
    return pineRequest<{ items: PineScriptSummary[] }>(`/api/research/pine/scripts${s ? `?${s}` : ''}`);
  },
  script: (id: string) => pineRequest<PineScript>(`/api/research/pine/scripts/${encodeURIComponent(id)}`),
  create: (body: PineScriptCreate) => pineRequest<PineMutationResult>('/api/research/pine/scripts', { method: 'POST', body: JSON.stringify(body) }),
  admit: (id: string) => pineRequest<PineMutationResult>(`/api/research/pine/scripts/${encodeURIComponent(id)}/admit`, { method: 'POST', body: '{}' }),
  remove: (id: string) => pineRequest<{ ok: true }>(`/api/research/pine/scripts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

export const pineKeys = {
  all: ['research', 'pine'] as const,
  health: ['research', 'pine', 'health'] as const,
  scripts: (q: string, admitted: boolean) => ['research', 'pine', 'scripts', q, admitted] as const,
  script: (id: string) => ['research', 'pine', 'script', id] as const,
};

// ---------------------------------------------------------------------------
// 小件

const STATUS_LABEL: Record<PineEngineStatus, string> = tmap({ up: '运行中', starting: '启动中', down: '已停止', disabled: '未启用' });
const STATUS_DOT: Record<PineEngineStatus, string> = { up: 'bg-up', starting: 'bg-warn', down: 'bg-down', disabled: 'bg-muted-foreground/50' };
const CHECK_LABEL: Record<string, string> = tmap({ outputs: '输出', determinism: '确定性', causality: '因果(无未来函数)', warmup: '预热', inputs: '参数' });
const SOURCE_LABEL: Record<string, string> = tmap({ user: '用户', agent: 'Agent', community: '社区' });
const SUITE_LABEL: Record<string, string> = tmap({ synthetic: '合成数据', market: '市场数据', custom: '自定义数据' });
const CHECK_ORDER = ['causality', 'determinism', 'outputs', 'warmup', 'inputs'];

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const fmtValue = (v: unknown): string => (v === undefined ? '—' : v === null ? 'null' : typeof v === 'string' ? v : JSON.stringify(v));

function Section({ title, hint, children, right }: { title: string; hint?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="rounded-md border">
      <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-1.5">
        <span className="kicker text-foreground/85">{title}</span>
        {hint ? <span className="text-[10.5px] text-muted-foreground">{hint}</span> : null}
        {right ? <span className="ml-auto flex items-center gap-1">{right}</span> : null}
      </div>
      {children}
    </div>
  );
}

function OkIcon({ ok, className }: { ok: boolean; className?: string }) {
  return ok ? <CircleCheck className={cn('size-3.5 shrink-0 text-up', className)} aria-label={t('通过')} /> : <CircleX className={cn('size-3.5 shrink-0 text-down', className)} aria-label={t('未通过')} />;
}

export function AdmissionVerdictBadge({ ok, pending }: { ok: boolean | null; pending?: boolean }) {
  if (pending) return <Badge variant="outline" className="text-muted-foreground">{t('未准入')}</Badge>;
  if (ok === null) return <Badge variant="outline" className="text-muted-foreground">{t('未跑准入')}</Badge>;
  return ok ? <Badge className="bg-up/15 text-up">{t('已准入')}</Badge> : <Badge variant="destructive">{t('准入未通过')}</Badge>;
}

function EngineLight({ health, loading, error }: { health: PineHealth | undefined; loading: boolean; error: unknown }) {
  if (loading && !health) return <div className="flex items-center gap-2 text-[11px] text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />{t('查询 Pine 引擎状态…')}</div>;
  if (!health) return <div className="text-[11px] text-down">{t('Pine 引擎状态读不到')}:{errText(error)}</div>;
  const bad = health.status === 'down' || health.status === 'disabled';
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span className="inline-flex items-center gap-1.5">
          <i className={cn('inline-block size-2 rounded-full', STATUS_DOT[health.status], health.status === 'starting' && 'animate-pulse')} />
          <span className="font-medium">{t('Pine 引擎')}</span>
          <span className={cn(health.status === 'up' ? 'text-up' : health.status === 'starting' ? 'text-warn' : health.status === 'down' ? 'text-down' : 'text-muted-foreground')}>{STATUS_LABEL[health.status] ?? health.status}</span>
        </span>
        <span className="text-muted-foreground">{health.engine}{health.version ? ` ${health.version}` : ''}</span>
        {health.port !== null ? <span className="num text-muted-foreground">:{health.port}</span> : null}
        {health.pid !== null ? <span className="num text-muted-foreground">pid {health.pid}</span> : null}
        {health.restarts > 0 ? <span className="text-warn">{t('重启 {n} 次', { n: health.restarts })}</span> : null}
        <span className="text-muted-foreground">{t('脚本 {n} 个,已准入 {a} 个', { n: health.scripts, a: health.admitted })}</span>
      </div>
      {bad && (health.last_error || health.hint) ? (
        <div className="space-y-0.5 rounded-md border border-down/30 bg-down/5 px-2.5 py-1.5 text-[11px]">
          {health.last_error ? <div className="break-all text-down">{t('最近错误')}:{health.last_error}</div> : null}
          {health.hint ? <div className="break-all text-muted-foreground">{health.hint}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 参数表(inputs_schema):新形状 params;旧数据只有 defaults 时按默认值推类型

export function PineInputsTable({ schema }: { schema: PineInputsSchema | Record<string, unknown> | null | undefined }) {
  const s = (schema ?? {}) as PineInputsSchema;
  const rows = useMemo(() => {
    const params = s.params && typeof s.params === 'object' ? s.params : {};
    const defaults = s.defaults && typeof s.defaults === 'object' ? s.defaults : {};
    const names = [...new Set([...Object.keys(params), ...Object.keys(defaults)])];
    return names.map((name) => {
      const p = params[name];
      const d = p?.default !== undefined ? p.default : defaults[name];
      const inferred = typeof d === 'boolean' ? 'bool' : typeof d === 'number' ? (Number.isInteger(d) ? 'int' : 'float') : typeof d === 'string' ? 'string' : '—';
      const range = p && (p.min !== undefined || p.max !== undefined) ? `${p.min ?? '−∞'} ~ ${p.max ?? '+∞'}${p.step !== undefined ? ` / ${t('步长')} ${p.step}` : ''}` : p?.step !== undefined ? `${t('步长')} ${p.step}` : '—';
      return { name, title: p?.title, type: p?.type ?? inferred, def: fmtValue(d), range, options: p?.options?.length ? p.options.join(' / ') : '—', declared: !!p };
    });
  }, [s]);
  if (!rows.length) return <div className="px-3 py-2 text-[11px] text-muted-foreground">{t('没有声明可调参数(脚本按内置默认值运行)。')}</div>;
  return (
    <div className="overflow-x-auto">
      <Table className="text-xs">
        <TableHeader>
          <TableRow>
            {['名称', '类型', '默认', '范围', '枚举'].map((c) => <TableHead key={c} className="h-8 text-[11px]">{t(c)}</TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.name}>
              <TableCell className="py-1.5">
                <span className="font-mono">{r.name}</span>
                {r.title && r.title !== r.name ? <span className="ml-1.5 text-muted-foreground">{r.title}</span> : null}
                {!r.declared ? <span className="ml-1.5 text-[10px] text-muted-foreground">({t('仅默认值')})</span> : null}
              </TableCell>
              <TableCell className="py-1.5 font-mono">{r.type}</TableCell>
              <TableCell className="num py-1.5">{r.def}</TableCell>
              <TableCell className="num py-1.5">{r.range}</TableCell>
              <TableCell className="py-1.5">{r.options}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 准入报告

function ChecksList({ checks }: { checks: PineAdmissionCheck[] }) {
  const sorted = [...checks].sort((a, b) => {
    const ia = CHECK_ORDER.indexOf(a.name), ib = CHECK_ORDER.indexOf(b.name);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  if (!sorted.length) return <div className="text-[11px] text-muted-foreground">{t('没有检查项记录')}</div>;
  return (
    <ul className="space-y-1">
      {sorted.map((c) => (
        <li key={c.name} className={cn('flex items-start gap-1.5 text-[11px]', !c.ok && 'rounded-sm bg-down/10 px-1.5 py-1')}>
          <OkIcon ok={c.ok} className="mt-px" />
          <span className={cn('shrink-0 font-medium', !c.ok && 'text-down')}>{CHECK_LABEL[c.name] ?? c.name}</span>
          <span className={cn('min-w-0 break-words', c.ok ? 'text-muted-foreground' : 'text-down')}>{c.message}</span>
        </li>
      ))}
    </ul>
  );
}

function OutputsLine({ outputs, warmup }: { outputs: string[]; warmup: number }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
      <span>{t('输出')}:</span>
      {outputs.length ? outputs.map((o) => <Badge key={o} variant="outline" className="font-mono text-[10.5px]">{o}</Badge>) : <span className="text-down">{t('无数值输出')}</span>}
      <span className="ml-2">{t('预热 {n} 根', { n: warmup })}</span>
    </div>
  );
}

export function PineAdmissionReportView({ report }: { report: PineAdmissionReport | null | undefined }) {
  if (!report) return <div className="px-3 py-2 text-[11px] text-muted-foreground">{t('还没有准入报告。未准入的脚本不能被 pine_series 引用。')}</div>;
  const suites = Array.isArray(report.suites) && report.suites.length ? report.suites : null;
  const legacy = !suites;
  return (
    <div className="space-y-2 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <AdmissionVerdictBadge ok={report.ok} />
        <span className="font-mono text-muted-foreground">{report.method_version}</span>
        {report.ran_at ? <span className="text-muted-foreground">{t('跑于')} {fmtDateTime(report.ran_at)}</span> : null}
        {report.tolerance ? <span className="num text-muted-foreground">{t('容差')} {report.tolerance}</span> : null}
      </div>
      {legacy ? (
        <div className="flex items-start gap-1.5 rounded-md border border-warn/30 bg-warn/10 px-2.5 py-1.5 text-[11px] text-warn">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <span>{t('旧口径(单一合成数据),建议重跑准入。')}</span>
        </div>
      ) : null}
      {report.real_data === false ? (
        <div className="flex items-start gap-1.5 rounded-md border border-warn/30 bg-warn/10 px-2.5 py-1.5 text-[11px] text-warn">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <span>{t('研究库里没有日线 / 4h 数据集,本次只用了合成数据;真实行情上的表现未经验证。')}</span>
        </div>
      ) : null}
      {suites ? (
        suites.map((s) => (
          <div key={`${s.id}:${s.dataset_id ?? ''}`} className={cn('space-y-1.5 rounded-md border px-2.5 py-2', !s.ok && 'border-down/40')}>
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <OkIcon ok={s.ok} />
              <span className="font-medium">{s.label || SUITE_LABEL[s.id] || s.id}</span>
              <span className="text-muted-foreground">{[s.symbol, s.timeframe].filter(Boolean).join(' · ')}</span>
              <span className="num text-muted-foreground">{t('{n} 根', { n: s.bars })}</span>
              {s.dataset_id ? <span className="font-mono text-[10.5px] text-muted-foreground">{s.dataset_id}</span> : null}
            </div>
            <ChecksList checks={s.checks} />
            <OutputsLine outputs={s.outputs} warmup={s.warmup_bars} />
          </div>
        ))
      ) : (
        <div className={cn('space-y-1.5 rounded-md border px-2.5 py-2', !report.ok && 'border-down/40')}>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <OkIcon ok={report.ok} />
            <span className="font-medium">{t('合成数据')}</span>
            <span className="text-muted-foreground">{report.timeframe}</span>
            <span className="num text-muted-foreground">{t('{n} 根', { n: report.bars })}</span>
          </div>
          <ChecksList checks={report.checks} />
          <OutputsLine outputs={report.outputs} warmup={report.warmup_bars} />
        </div>
      )}
      {report.warnings?.length ? (
        <ul className="space-y-0.5 text-[10.5px] text-muted-foreground">
          {report.warnings.map((w, i) => <li key={i} className="break-all">· {w}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 详情

function ScriptDetail({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  useEffect(() => {
    setConfirming(false);
    setLastError(null);
  }, [id]);
  const q = useQuery({ queryKey: pineKeys.script(id), queryFn: () => pineApi.script(id), retry: false });
  const invalidate = () => qc.invalidateQueries({ queryKey: pineKeys.all });
  const admit = useMutation({
    mutationFn: () => pineApi.admit(id),
    onSuccess: (r) => {
      if (r.script) qc.setQueryData(pineKeys.script(id), r.script);
      setLastError(r.error);
      if (r.error) toast.error(t('准入没跑成') + ':' + r.error);
      else toast[r.admission?.ok ? 'success' : 'warning'](r.admission?.ok ? t('准入通过') : t('准入未通过'));
      void invalidate();
    },
    onError: (e: Error) => {
      setLastError(e.message);
      toast.error(e.message);
    },
  });
  const remove = useMutation({
    mutationFn: () => pineApi.remove(id),
    onSuccess: () => {
      toast.success(t('已删除'));
      qc.removeQueries({ queryKey: pineKeys.script(id) });
      void invalidate();
      onDeleted();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (q.isLoading) return <div className="flex items-center gap-2 p-4 text-[11px] text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />{t('读取脚本…')}</div>;
  if (q.error || !q.data) return <div className="p-4 text-[11px] text-down">{t('脚本读不到')}:{errText(q.error)}</div>;
  const s = q.data;
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{s.name}</span>
          <AdmissionVerdictBadge ok={s.admission_report ? s.admission_report.ok : null} />
          <span className="font-mono text-[10.5px] text-muted-foreground">{s.id}</span>
          <span className="ml-auto flex items-center gap-1">
            <Button size="xs" variant="outline" disabled={admit.isPending} onClick={() => admit.mutate()}>
              {admit.isPending ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
              {t('重跑准入')}
            </Button>
            {confirming ? (
              <>
                <span className="text-[11px] text-down">{t('确认删除这个脚本?')}</span>
                <Button size="xs" variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
                  {remove.isPending ? <LoaderCircle className="animate-spin" /> : null}
                  {t('确认删除')}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>{t('取消')}</Button>
              </>
            ) : (
              <Button size="xs" variant="ghost" className="text-muted-foreground hover:text-down" onClick={() => setConfirming(true)}>
                <Trash2 />
                {t('删除')}
              </Button>
            )}
          </span>
        </div>
        {s.description ? <p className="text-xs text-muted-foreground">{s.description}</p> : null}
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          <span>{t('来源')}:{SOURCE_LABEL[s.source] ?? s.source}</span>
          <span>{t('许可')}:{s.license ?? '—'}</span>
          <span>{t('作者')}:{s.author ?? '—'}</span>
          <span>{t('被引用 {n} 次', { n: s.usage_count })}</span>
          <span>{t('更新于')} {fmtDateTime(s.updated_at)}</span>
          {s.aliases.length ? <span>{t('别名')}:{s.aliases.join(' / ')}</span> : null}
        </div>
        {s.outputs.length ? (
          <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
            <span>{t('可引用输出')}:</span>
            {s.outputs.map((o) => <Badge key={o} variant="outline" className="font-mono text-[10.5px]">{o}</Badge>)}
          </div>
        ) : null}
        {lastError ? <div className="rounded-md border border-down/30 bg-down/5 px-2.5 py-1.5 text-[11px] break-all text-down">{t('准入没跑成')}:{lastError}</div> : null}
      </div>

      <Section title={t('准入报告')}>
        <PineAdmissionReportView report={s.admission_report} />
      </Section>

      <Section title={t('参数')} hint="inputs_schema">
        <PineInputsTable schema={s.inputs_schema} />
      </Section>

      <Section title={t('脚本正文')} hint={t('{n} 行', { n: s.script.split('\n').length })}>
        <pre className="max-h-[420px] overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre">{s.script}</pre>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 新建对话框

function CreateDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [script, setScript] = useState('');
  const [license, setLicense] = useState('');
  const [result, setResult] = useState<PineMutationResult | null>(null);
  const reset = () => {
    setName('');
    setDescription('');
    setScript('');
    setLicense('');
    setResult(null);
    create.reset();
  };
  const create = useMutation({
    mutationFn: () =>
      pineApi.create({
        name: name.trim(),
        script,
        source: 'user',
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(license.trim() ? { license: license.trim() } : {}),
      }),
    onSuccess: (r) => {
      setResult(r);
      if (r.script) {
        qc.setQueryData(pineKeys.script(r.script.id), r.script);
        onCreated(r.script.id);
      }
      void qc.invalidateQueries({ queryKey: pineKeys.all });
    },
  });
  const canSubmit = name.trim().length > 0 && script.trim().length > 0 && !create.isPending && !result;
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-h-[90vh] w-[min(880px,94vw)] overflow-auto sm:max-w-[880px]">
        <DialogHeader>
          <DialogTitle>{t('贴一段 Pine')}</DialogTitle>
          <DialogDescription>{t('保存后自动跑一次准入(因果 / 确定性 / 输出 / 预热),通过的脚本才能被策略引用。')}</DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="space-y-2">
            <div className="text-xs">
              {t('已保存为')} <span className="font-medium">{result.script?.name ?? name}</span>
              {result.script ? <span className="ml-1.5 font-mono text-[10.5px] text-muted-foreground">{result.script.id}</span> : null}
            </div>
            {result.error ? (
              <div className="rounded-md border border-down/30 bg-down/5 px-2.5 py-1.5 text-[11px] break-all text-down">
                {t('准入没跑成(脚本已保存但未准入,引擎就绪后可在详情里重跑)')}:{result.error}
              </div>
            ) : null}
            {result.admission ? <div className="rounded-md border"><PineAdmissionReportView report={result.admission} /></div> : null}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="pine-name">{t('名称')}</Label>
                <Input id="pine-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('唯一名称,例如 coppock_curve')} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pine-license">{t('许可(可选)')}</Label>
                <Input id="pine-license" value={license} onChange={(e) => setLicense(e.target.value)} placeholder="MIT / MPL-2.0 …" />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="pine-desc">{t('描述(可选)')}</Label>
              <Input id="pine-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('它算什么、判定规则是什么')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pine-script">{t('脚本正文')}</Label>
              <Textarea id="pine-script" value={script} onChange={(e) => setScript(e.target.value)} className="min-h-[260px] font-mono text-[11.5px]" spellCheck={false} placeholder={'//@version=5\nindicator("My indicator")\nplot(ta.ema(close, 20), "ema")'} />
            </div>
            {create.error ? <div className="rounded-md border border-down/30 bg-down/5 px-2.5 py-1.5 text-[11px] break-all text-down">{errText(create.error)}</div> : null}
          </div>
        )}
        <DialogFooter>
          {result ? (
            <Button
              size="sm"
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
            >
              {t('完成')}
            </Button>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>{t('取消')}</Button>
              <Button size="sm" disabled={!canSubmit} onClick={() => create.mutate()}>
                {create.isPending ? <LoaderCircle className="animate-spin" /> : null}
                {create.isPending ? t('保存并准入中…') : t('保存并准入')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 面板

export function PineCatalogPanel() {
  const [query, setQuery] = useState('');
  const [admittedOnly, setAdmittedOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const q = useDebounced(query, 300);

  const health = useQuery({ queryKey: pineKeys.health, queryFn: pineApi.health, refetchInterval: 10_000, retry: false });
  const list = useQuery({ queryKey: pineKeys.scripts(q, admittedOnly), queryFn: () => pineApi.scripts({ q, admitted: admittedOnly, limit: 200 }), placeholderData: (prev) => prev });
  const items = list.data?.items ?? [];

  return (
    <div className="space-y-3">
      <Section
        title={t('Pine 脚本目录')}
        hint={t('研究域,只读行情,不下单')}
        right={
          <Button size="xs" onClick={() => setCreating(true)}>
            <Plus />
            {t('贴一段 Pine')}
          </Button>
        }
      >
        <div className="px-3 py-2">
          <EngineLight health={health.data} loading={health.isLoading} error={health.error} />
        </div>
      </Section>

      <div className="grid gap-3 lg:grid-cols-[minmax(240px,320px)_1fr]">
        <div className="space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('按名称 / 别名 / 描述搜索')} className="h-8 pl-7 text-xs" />
          </div>
          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Switch size="sm" checked={admittedOnly} onCheckedChange={setAdmittedOnly} />
            {t('只看已准入')}
          </label>
          <div className="rounded-md border">
            {list.isLoading ? (
              <div className="flex items-center gap-2 p-3 text-[11px] text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />{t('加载中…')}</div>
            ) : list.error ? (
              <div className="p-3 text-[11px] text-down">{t('列表读不到')}:{errText(list.error)}</div>
            ) : !items.length ? (
              <div className="p-3 text-[11px] text-muted-foreground">{q || admittedOnly ? t('没有匹配的脚本。') : t('目录还是空的。贴一段 Pine,或让研究 loop 的 pine_author 写一段。')}</div>
            ) : (
              <ul className="max-h-[560px] divide-y overflow-auto">
                {items.map((s) => {
                  const sum = s.admission_summary;
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(s.id)}
                        className={cn('flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-muted/50', selected === s.id && 'bg-muted')}
                      >
                        <div className="flex w-full items-center gap-1.5">
                          {sum ? <OkIcon ok={sum.ok} /> : <span className="inline-block size-3.5 shrink-0 rounded-full border border-dashed border-muted-foreground/50" title={t('未跑准入')} />}
                          <span className="truncate text-xs font-medium">{s.name}</span>
                          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{SOURCE_LABEL[s.source] ?? s.source}</span>
                        </div>
                        {s.description ? <span className="line-clamp-2 text-[11px] text-muted-foreground">{s.description}</span> : null}
                        <div className="flex flex-wrap gap-x-2 text-[10.5px] text-muted-foreground">
                          {s.outputs.length ? <span className="font-mono">{s.outputs.slice(0, 3).join(', ')}{s.outputs.length > 3 ? '…' : ''}</span> : null}
                          {sum ? <span>{t('预热 {n} 根', { n: sum.warmup_bars })}</span> : null}
                          {sum && sum.failed.length ? <span className="text-down">{t('未过')}:{sum.failed.map((f) => CHECK_LABEL[f] ?? f).join(listSep())}</span> : null}
                          {s.usage_count ? <span>{t('引用 {n}', { n: s.usage_count })}</span> : null}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <div className="min-w-0">
          {selected ? (
            <ScriptDetail id={selected} onDeleted={() => setSelected(null)} />
          ) : (
            <div className="rounded-md border border-dashed p-6 text-center text-[11px] text-muted-foreground">{t('在左侧选一个脚本查看正文、参数与准入报告。')}</div>
          )}
        </div>
      </div>

      <CreateDialog open={creating} onOpenChange={setCreating} onCreated={(id) => setSelected(id)} />
    </div>
  );
}
