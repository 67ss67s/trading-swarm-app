/**
 * ASP 运行监视器(OKX.AI 页「监视」标签):GET /api/asp-services/monitor 的可视化 + 下钻。
 * 看的就是人工巡检那几样:上架状态、接单轮询、okx-a2a 守护、盘口录制器、网络/CLI 失败率、策略运行,
 * 各服务(以 OKX 上实际上架的为准,上架变化自动跟上)、近期订单(审核方测试单 + 真实订单)。30 秒自动刷新。
 *
 * 交互:检查项点开看处理建议;订阅服务点开看推送明细(信号行 / 详情 / 每个订阅的结果,可选 24h/3d/7d);
 * 按次服务点一下筛选订单表;订单点开看交付内容,交付失败/未知的可以重试;失败推送可一键立刻重发、上架状态可立刻重查。
 * 快照模式(评审站:响应带 snapshot 字段)下所有动作按钮隐藏,只读。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, RefreshCw, RotateCcw, ScanSearch } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { AspMonitor, AspMonitorCheck, AspMonitorLevel, AspMonitorService, AspMonitorTask } from '@/api/types';
import { Pane, Workspace } from '@/components/pane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { relativeTime, useNow } from '@/lib/format';
import { getLang, t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { EmptyNote } from './shared';

const H = 3_600_000;
const DOT: Record<AspMonitorLevel, string> = { ok: 'bg-up', warn: 'bg-warn', fail: 'bg-down', unknown: 'bg-muted-foreground/40' };
const TEXT: Record<AspMonitorLevel, string> = { ok: 'text-up', warn: 'text-warn', fail: 'text-down', unknown: 'text-muted-foreground' };
const BORDER: Record<AspMonitorLevel, string> = { ok: 'border-up/30', warn: 'border-warn/40', fail: 'border-down/40', unknown: 'border-border' };
const overallText = (l: AspMonitorLevel) => ({ ok: t('一切正常'), warn: t('有需要留意的项'), fail: t('有故障,需要处理'), unknown: t('状态未知') })[l];
const stateText = (s: string) =>
  (({
    delivered: t('已交付'), declined: t('已拒单'), closed: t('已关闭'), seen: t('待接单'), accepting: t('接单中'), accepted: t('已接单'), delivering: t('交付中'),
    deliver_failed: t('交付失败'), deliver_unknown: t('交付结果未知'), accept_unknown: t('接单结果未知'), decline_unknown: t('拒单结果未知'), declining: t('拒单中'),
    skipped: t('已跳过'), no_handler: t('无处理器'), failed: t('失败'), pending: t('处理中'),
  }) as Record<string, string>)[s] ?? s;
const channelText = (c: string) =>
  (({ market_brief: t('简报'), radar_feed: t('雷达'), micro_alerts: t('告警'), strategy_status: t('状态'), strategy_signal: t('信号') }) as Record<string, string>)[c] ?? c;
const pushLevel = (s: string): AspMonitorLevel => (s === 'delivered' ? 'ok' : s === 'failed' ? 'fail' : 'warn');

type TaskFilter = 'all' | 'reviewer' | 'real' | 'problem';

function Dot({ level, className }: { level: AspMonitorLevel; className?: string }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', DOT[level], className)} />;
}

/** 24 小时时间轴:每次推送一个点(绿=送达、红=失败、黄=处理中),右端是现在;中线是 12 小时前 */
function Timeline({ items, now }: { items: AspMonitorService['timeline']; now: number }) {
  const from = now - 24 * H;
  return (
    <div className="relative h-5 w-full rounded-sm bg-muted/40">
      <div className="absolute inset-y-0 w-px bg-border" style={{ left: '50%' }} />
      {items.map((x, i) => (
        <span
          key={i}
          className={cn('absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-1 ring-background', DOT[pushLevel(x.status)])}
          style={{ left: `${Math.min(100, Math.max(0, ((x.at - from) / (24 * H)) * 100))}%` }}
          title={`${new Date(x.at).toLocaleString()} · ${channelText(x.channel)} · ${stateText(x.status)}`}
        />
      ))}
      <span className="absolute -bottom-3.5 left-0 text-[9px] text-muted-foreground">{t('24 小时前')}</span>
      <span className="absolute -bottom-3.5 left-1/2 -translate-x-1/2 text-[9px] text-muted-foreground">12h</span>
      <span className="absolute -bottom-3.5 right-0 text-[9px] text-muted-foreground">{t('现在')}</span>
    </div>
  );
}

function CheckCell({ c, now }: { c: AspMonitorCheck; now: number }) {
  const [open, setOpen] = useState(c.status === 'fail');
  return (
    <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-col gap-1 border-b px-3 py-2 text-left hover:bg-muted/30">
      <div className="flex w-full items-center gap-2">
        <Dot level={c.status} />
        <span className="text-[12px] font-medium">{c.label}</span>
        {c.at ? <span className="ml-auto text-[10px] text-muted-foreground">{relativeTime(c.at, now)}</span> : null}
        {c.hint ? open ? <ChevronDown className="size-3 text-muted-foreground" /> : <ChevronRight className="size-3 text-muted-foreground" /> : null}
      </div>
      <p className={cn('text-[11px] leading-snug', c.status === 'ok' ? 'text-muted-foreground' : TEXT[c.status])}>{c.summary}</p>
      {open && c.hint ? <p className="rounded bg-muted/50 px-2 py-1 text-[10.5px] leading-snug text-muted-foreground">{c.hint}</p> : null}
    </button>
  );
}

function SubscriptionCard({ s, now, onOpen }: { s: AspMonitorService; now: number; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className={cn('flex min-w-0 flex-col gap-2 rounded-md border p-3 text-left transition-colors hover:bg-muted/30', BORDER[s.status])}>
      <div className="flex w-full items-center gap-2">
        <Dot level={s.status} />
        <span className="truncate text-[12.5px] font-medium">{s.name}</span>
        <Badge variant="outline" className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          {t('订阅者 {n}', { n: s.subscribers })}
        </Badge>
      </div>
      <p className={cn('text-[11.5px]', TEXT[s.status])}>{s.summary}</p>
      <div className="w-full pb-3">
        <Timeline items={s.timeline} now={now} />
      </div>
      <div className="flex w-full items-center gap-3 text-[10.5px] text-muted-foreground">
        <span>{t('24 小时推送 {n} 次', { n: s.timeline.length })}</span>
        {s.failed_recent ? <span className="text-down">{t('失败 {n}(会自动重发)', { n: s.failed_recent })}</span> : null}
        {s.price ? <span className="ml-auto">{s.price}</span> : null}
      </div>
      {s.last_signal ? (
        <code className="block w-full truncate rounded bg-muted/50 px-2 py-1 font-mono text-[10.5px] text-muted-foreground" title={s.last_signal}>
          {s.last_signal}
        </code>
      ) : null}
      <span className="text-[10.5px] text-primary">{t('点开看每次推送 →')}</span>
    </button>
  );
}

function OneTimeCard({ s, now, active, onFilter }: { s: AspMonitorService; now: number; active: boolean; onFilter: () => void }) {
  return (
    <button type="button" onClick={onFilter} className={cn('flex min-w-0 flex-col gap-1.5 rounded-md border px-3 py-2 text-left transition-colors hover:bg-muted/30', active ? 'border-primary/60 bg-primary/5' : BORDER[s.status])}>
      <div className="flex w-full items-center gap-2">
        <Dot level={s.status} />
        <span className="truncate text-[12px] font-medium">{s.name}</span>
        {s.price ? <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground">{s.price}</span> : null}
      </div>
      <p className={cn('text-[11px]', s.status === 'ok' ? 'text-muted-foreground' : TEXT[s.status])}>{s.summary}</p>
      <span className="text-[10.5px] text-muted-foreground">
        {s.last_order_at ? t('上一单 {t}', { t: relativeTime(s.last_order_at, now) }) : ''} {active ? t('· 已筛选订单,再点取消') : t('· 点一下只看它的订单')}
      </span>
    </button>
  );
}

function PushSheet({ s, onClose }: { s: AspMonitorService | null; onClose: () => void }) {
  const [hours, setHours] = useState(24);
  const [openId, setOpenId] = useState<string | null>(null);
  const now = useNow(30_000);
  const q = useQuery({
    queryKey: ['asp-services', 'monitor', 'pushes', s?.service_id, hours, getLang()],
    queryFn: () => api.aspMonitorPushes(s!.service_id, hours, s!.name),
    enabled: !!s,
  });
  return (
    <Sheet open={!!s} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-[640px] max-w-[95vw] overflow-y-auto sm:max-w-[640px]">
        <SheetHeader>
          <SheetTitle>{s?.name}</SheetTitle>
          <SheetDescription>{t('每次推送先发一条带类型头的信号行,再跟一条详情;下面每行是发给一个订阅的结果')}</SheetDescription>
        </SheetHeader>
        <div className="flex gap-1 px-4">
          {[24, 72, 168].map((h) => (
            <Button key={h} size="sm" variant={hours === h ? 'secondary' : 'ghost'} className="h-6 px-2 text-[11px]" onClick={() => setHours(h)}>
              {h === 24 ? t('24 小时') : h === 72 ? t('3 天') : t('7 天')}
            </Button>
          ))}
          <span className="ml-auto self-center text-[11px] text-muted-foreground">{q.data ? t('{n} 条', { n: q.data.items.length }) : ''}</span>
        </div>
        <div className="flex flex-col gap-1.5 px-4 pb-6">
          {q.isLoading ? <EmptyNote>{t('读取中…')}</EmptyNote> : null}
          {q.data && !q.data.items.length ? <EmptyNote>{t('这段时间没有推送')}</EmptyNote> : null}
          {q.data?.items.map((x) => {
            const id = `${x.event_id}:${x.job_id}`;
            return (
              <div key={id} className={cn('rounded-md border px-2.5 py-2', BORDER[pushLevel(x.status)])}>
                <div className="flex items-center gap-2 text-[11px]">
                  <Dot level={pushLevel(x.status)} />
                  <span className="font-medium">{stateText(x.status)}</span>
                  <Badge variant="outline" className="px-1 text-[9.5px]">{channelText(x.channel)}</Badge>
                  <span className="text-muted-foreground" title={new Date(x.created_at).toLocaleString()}>{relativeTime(x.created_at, now)}</span>
                  {x.attempts > 1 ? <span className="text-muted-foreground">{t('第 {n} 次尝试', { n: x.attempts })}</span> : null}
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">{x.job_id.slice(0, 10)}…</span>
                </div>
                {x.signal ? <code className="mt-1.5 block whitespace-pre-wrap break-words rounded bg-muted/50 px-2 py-1 font-mono text-[10.5px]">{x.signal}</code> : null}
                {x.error ? <p className="mt-1 text-[10.5px] text-down">{x.error}</p> : null}
                {x.detail ? (
                  <>
                    <button type="button" className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-primary" onClick={() => setOpenId(openId === id ? null : id)}>
                      {openId === id ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                      {t('详情全文')}
                    </button>
                    {openId === id ? <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 px-2 py-1.5 text-[10.5px] leading-snug">{x.detail}</pre> : null}
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function TaskSheet({ job, readOnly, onClose }: { job: AspMonitorTask | null; readOnly: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['asp-services', 'monitor', 'task', job?.job_id, getLang()], queryFn: () => api.aspMonitorTask(job!.job_id), enabled: !!job });
  const retry = useMutation({
    mutationFn: () => api.aspProviderTaskRetry(job!.job_id),
    onSuccess: () => {
      toast.success(t('已重新交付'));
      void qc.invalidateQueries({ queryKey: ['asp-services', 'monitor'] });
    },
    onError: (e) => toast.error(t('重试失败'), { description: e instanceof Error ? e.message : String(e) }),
  });
  const d = q.data;
  return (
    <Sheet open={!!job} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-[640px] max-w-[95vw] overflow-y-auto sm:max-w-[640px]">
        <SheetHeader>
          <SheetTitle>{job?.title ?? job?.job_id}</SheetTitle>
          <SheetDescription>
            {job?.service} · {job?.test_flag ? t('审核方') : t('买方')} #{job?.buyer ?? '—'}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-2 px-4 pb-6 text-[11.5px]">
          {job ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn('inline-flex items-center gap-1.5 font-medium', TEXT[job.status])}>
                <Dot level={job.status} />
                {stateText(job.state)}
              </span>
              {d?.remote_status ? <Badge variant="outline" className="text-[10px]">OKX: {d.remote_status}</Badge> : null}
              {d?.fee ? <Badge variant="outline" className="text-[10px]">{d.fee}</Badge> : null}
              <span className="text-muted-foreground">{t('接单 {a} 次 · 交付 {d} 次', { a: d?.accept_attempts ?? '—', d: d?.deliver_attempts ?? '—' })}</span>
              {!readOnly && job.retryable ? (
                <Button size="sm" variant="outline" className="ml-auto h-7 gap-1 text-[11px]" disabled={retry.isPending} onClick={() => retry.mutate()}>
                  <RotateCcw className="size-3.5" />
                  {t('重试交付')}
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>{t('下单')}: {job ? new Date(job.created_at).toLocaleString() : ''}</span>
            <span>{t('最近更新')}: {job ? new Date(job.updated_at).toLocaleString() : ''}</span>
            <span className="col-span-2 break-all font-mono text-[10px]">{job?.job_id}</span>
          </div>
          {d?.error ? <p className="rounded border border-down/30 bg-down/5 px-2 py-1 text-[11px] text-down">{String(d.error)}</p> : null}
          {d?.result_summary ? <p className="text-[11.5px]">{String(d.result_summary)}</p> : null}
          <span className="mt-1 text-[11px] font-medium">{t('交付内容')}</span>
          {q.isLoading ? <EmptyNote>{t('读取中…')}</EmptyNote> : d?.deliverable_text ? (
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 px-2 py-1.5 text-[10.5px] leading-snug">{String(d.deliverable_text)}</pre>
          ) : (
            <EmptyNote>{t('还没有交付内容')}</EmptyNote>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function AspMonitorTab() {
  const now = useNow(10_000);
  const qc = useQueryClient();
  const lang = getLang();
  const [fresh, setFresh] = useState(false);
  const q = useQuery({ queryKey: ['asp-services', 'monitor', lang], queryFn: () => api.aspMonitor(lang), refetchInterval: 30_000 });
  const [pushService, setPushService] = useState<AspMonitorService | null>(null);
  const [task, setTask] = useState<AspMonitorTask | null>(null);
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [serviceFilter, setServiceFilter] = useState<string | null>(null);
  const [showCli, setShowCli] = useState(false);

  const recheck = useMutation({
    mutationFn: () => api.aspMonitor(lang, true),
    onMutate: () => setFresh(true),
    onSettled: () => setFresh(false),
    onSuccess: (m) => qc.setQueryData(['asp-services', 'monitor', lang], m),
  });
  const retryPushes = useMutation({
    mutationFn: api.aspMonitorRetryPushes,
    onSuccess: (r) => {
      toast.success(r.expedited ? t('{n} 条失败推送已排入重发', { n: r.expedited }) : t('没有可重发的失败推送'));
      window.setTimeout(() => void qc.invalidateQueries({ queryKey: ['asp-services', 'monitor'] }), 8000);
    },
    onError: (e) => toast.error(t('重发失败'), { description: e instanceof Error ? e.message : String(e) }),
  });

  const m: AspMonitor | undefined = q.data;
  if (q.isLoading) return <Workspace><EmptyNote>{t('正在读取 ASP 运行状态…')}</EmptyNote></Workspace>;
  if (q.isError || !m) return <Workspace><EmptyNote>{t('读不到监视数据:{e}', { e: q.error instanceof Error ? q.error.message : t('网关没响应') })}</EmptyNote></Workspace>;

  const readOnly = !!m.snapshot;
  const subs = m.services.filter((s) => s.kind === 'subscription');
  const oneTime = m.services.filter((s) => s.kind === 'one_time');
  const failedPushes = subs.reduce((n, s) => n + s.failed_recent, 0);
  const tasks = m.tasks.items.filter((x) =>
    (serviceFilter ? x.service_id === serviceFilter : true) &&
    (filter === 'all' ? true : filter === 'reviewer' ? x.test_flag : filter === 'real' ? !x.test_flag : x.status !== 'ok'));
  const problems = m.tasks.items.filter((x) => x.status !== 'ok').length;
  const counts = Object.entries(m.tasks.counts_24h).map(([k, n]) => `${stateText(k)} ${n}`).join(' · ');

  return (
    <div className="flex flex-col gap-3">
      <Workspace className={cn('flex flex-wrap items-center gap-3 px-3 py-2.5', BORDER[m.overall])}>
        <Dot level={m.overall} className="size-3" />
        <span className={cn('text-[13px] font-medium', TEXT[m.overall])}>{overallText(m.overall)}</span>
        <span className="text-[11px] text-muted-foreground">
          {m.asp_name ?? 'ASP'} #{m.asp_id ?? '—'} · {readOnly ? t('快照时间 {t}', { t: relativeTime(m.at, now) }) : t('更新于 {t} · 每 30 秒自动刷新', { t: relativeTime(m.at, now) })}
        </span>
        <Badge variant="outline" className="text-[10px] text-muted-foreground" title={t('服务列表直接取 OKX 上本 ASP 实际上架的服务,上架、下架、改名会自动跟上')}>
          {m.services_source === 'listing' ? t('服务列表来自 OKX 上架') : t('服务列表来自本地配置')}
        </Badge>
        {!readOnly ? (
          <div className="ml-auto flex items-center gap-1">
            {failedPushes ? (
              <Button variant="outline" size="sm" className="h-7 gap-1 border-down/40 text-[11px] text-down" onClick={() => retryPushes.mutate()} disabled={retryPushes.isPending}>
                <RotateCcw className="size-3.5" />
                {t('立即重发失败推送')}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" className="h-7 gap-1 text-[11px]" onClick={() => recheck.mutate()} disabled={fresh} title={t('立刻向 OKX 重查上架状态和服务列表')}>
              <ScanSearch className={cn('size-3.5', fresh && 'animate-pulse')} />
              {t('重查上架')}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 gap-1 text-[11px]" onClick={() => void q.refetch()} disabled={q.isFetching}>
              <RefreshCw className={cn('size-3.5', q.isFetching && 'animate-spin')} />
              {t('刷新')}
            </Button>
          </div>
        ) : null}
      </Workspace>

      <Workspace>
        <Pane title={t('运行检查')} hint={t('点开任一项看处理建议;任何一项变红,接单或推送就可能中断')}>
          <div className="grid grid-cols-1 sm:grid-cols-2 sm:divide-x xl:grid-cols-4">
            {m.checks.map((c) => (
              <CheckCell key={`${c.key}:${c.status}`} c={c} now={now} />
            ))}
          </div>
        </Pane>
      </Workspace>

      <Workspace>
        <Pane title={t('订阅服务')} hint={t('距上次信号超过 7 小时变黄、超过 11 小时变红;平台 12 小时没收到带类型头的信号会判不合格')}>
          {subs.length ? (
            <div className="grid grid-cols-1 gap-2 p-2.5 lg:grid-cols-3">
              {subs.map((s) => (
                <SubscriptionCard key={s.service_id} s={s} now={now} onOpen={() => setPushService(s)} />
              ))}
            </div>
          ) : (
            <EmptyNote>{t('没有上架的订阅服务')}</EmptyNote>
          )}
        </Pane>
      </Workspace>

      {oneTime.length ? (
        <Workspace>
          <Pane title={t('按次服务')} hint={t('近 7 天的订单;点一下在下面的订单表里只看这个服务')}>
            <div className="grid grid-cols-1 gap-2 p-2.5 sm:grid-cols-2 xl:grid-cols-3">
              {oneTime.map((s) => (
                <OneTimeCard key={s.service_id} s={s} now={now} active={serviceFilter === s.service_id} onFilter={() => setServiceFilter(serviceFilter === s.service_id ? null : s.service_id)} />
              ))}
            </div>
          </Pane>
        </Workspace>
      ) : null}

      <Workspace>
        <Pane
          title={t('订单')}
          hint={t('近 24 小时:{c}', { c: counts || t('无') })}
          actions={
            <div className="flex items-center gap-0.5">
              {(
                [
                  ['all', t('全部')],
                  ['reviewer', t('审核方')],
                  ['real', t('真实买家')],
                  ['problem', problems ? t('异常 {n}', { n: problems }) : t('异常')],
                ] as [TaskFilter, string][]
              ).map(([k, label]) => (
                <Button key={k} size="sm" variant={filter === k ? 'secondary' : 'ghost'} className="h-6 px-2 text-[11px]" onClick={() => setFilter(k)}>
                  {label}
                </Button>
              ))}
              {serviceFilter ? (
                <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setServiceFilter(null)}>
                  {t('服务:{s} ✕', { s: m.services.find((x) => x.service_id === serviceFilter)?.name ?? '' })}
                </Button>
              ) : null}
            </div>
          }
        >
          {tasks.length ? (
            <div className="overflow-x-auto px-3 py-1.5">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-1 pr-3 font-normal">{t('时间')}</th>
                    <th className="py-1 pr-3 font-normal">{t('服务')}</th>
                    <th className="py-1 pr-3 font-normal">{t('订单')}</th>
                    <th className="py-1 pr-3 font-normal">{t('买方')}</th>
                    <th className="py-1 pr-3 font-normal">{t('状态')}</th>
                    <th className="py-1 font-normal">{readOnly ? '' : t('错误')}</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.slice(0, 40).map((x) => (
                    <tr key={x.job_id} className="cursor-pointer border-b last:border-0 hover:bg-muted/30" onClick={() => setTask(x)}>
                      <td className="whitespace-nowrap py-1.5 pr-3 text-muted-foreground" title={new Date(x.created_at).toLocaleString()}>{relativeTime(x.created_at, now)}</td>
                      <td className="py-1.5 pr-3"><span className="block max-w-[180px] truncate">{x.service}</span></td>
                      <td className="py-1.5 pr-3"><span className="block max-w-[260px] truncate" title={x.title ?? x.job_id}>{x.title ?? `${x.job_id.slice(0, 10)}…`}</span></td>
                      <td className="whitespace-nowrap py-1.5 pr-3 text-muted-foreground">
                        {x.test_flag ? <Badge variant="outline" className="border-warn/40 px-1 text-[9.5px] text-warn">{t('审核方')}</Badge> : null} #{x.buyer ?? '—'}
                      </td>
                      <td className="whitespace-nowrap py-1.5 pr-3">
                        <span className={cn('inline-flex items-center gap-1.5', TEXT[x.status])}>
                          <Dot level={x.status} />
                          {stateText(x.state)}
                        </span>
                      </td>
                      <td className="py-1.5"><span className="block max-w-[260px] truncate text-muted-foreground" title={x.error ?? ''}>{x.error ?? ''}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyNote>{t('没有符合条件的订单')}</EmptyNote>
          )}
        </Pane>
      </Workspace>

      {!readOnly ? (
        <Workspace>
          <Pane
            title={t('OKX CLI 调用')}
            hint={t('近 1 小时 {n} 次,失败 {f} 次', { n: m.cli.total, f: m.cli.failed }) + (Object.keys(m.cli.by_code).length ? `(${Object.entries(m.cli.by_code).map(([k, n]) => `${k} ×${n}`).join(', ')})` : '')}
            actions={
              m.cli.recent_errors.length ? (
                <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setShowCli((v) => !v)}>
                  {showCli ? t('收起') : t('看最近失败')}
                </Button>
              ) : null
            }
          >
            {showCli && m.cli.recent_errors.length ? (
              <ul className="flex flex-col gap-0.5 px-3 py-2 text-[11px] text-muted-foreground">
                {m.cli.recent_errors.map((e, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="w-20 shrink-0">{relativeTime(e.at, now)}</span>
                    <span className="w-44 shrink-0 font-mono">{e.command}</span>
                    <span className="text-down">{e.code ?? 'error'}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-2 text-[11px] text-muted-foreground">{m.cli.recent_errors.length ? t('失败会自动重试;点右上角看明细') : t('近 1 小时没有失败的调用')}</p>
            )}
          </Pane>
        </Workspace>
      ) : null}

      <PushSheet s={pushService} onClose={() => setPushService(null)} />
      <TaskSheet job={task} readOnly={readOnly} onClose={() => setTask(null)} />
    </div>
  );
}
