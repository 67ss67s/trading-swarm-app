/**
 * 「信号」栏:待办 + 信号流(沿用跟单流水线 /api/follow/signals*)+ 入站账本(原文 / 为什么没进流)。
 * 设计 §2.5。
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { FollowOverview, MarketInboxParseStatus, MarketInboxRow, TraderSignal, TraderSignalStatus } from '@/api/types';
import { TRADER_SIGNAL_STATUSES, TRADER_SIGNAL_STATUS_LABEL } from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Pane, Workspace } from '@/components/pane';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { fmtDateTime, relativeTime, useNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { EmptyNote, ErrorNote, PARSE_STATUS_CLASS, PARSE_STATUS_LABEL, shortId } from './shared';
import { SignalRow } from './signal-row';

const PARSE_FILTERS: ('all' | MarketInboxParseStatus)[] = ['all', 'ingested', 'analysis', 'bad', 'expired', 'duplicate', 'system'];

function LedgerRow({ row, now, onShowRaw }: { row: MarketInboxRow; now: number; onShowRaw: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-[11px] last:border-b-0">
      <span className="text-muted-foreground" title={fmtDateTime(row.received_at)}>
        {relativeTime(row.received_at, now)}
      </span>
      <Badge variant="outline" className={cn('text-[10px]', PARSE_STATUS_CLASS[row.parse_status])}>
        {PARSE_STATUS_LABEL[row.parse_status]}
      </Badge>
      {row.signal_type ? <span className="num text-muted-foreground">{row.signal_type}</span> : null}
      <span className="num text-muted-foreground" title={row.job_id ?? ''}>
        job {shortId(row.job_id, 6, 4)}
      </span>
      <span className="num text-muted-foreground" title={row.delivery_id}>
        {shortId(row.delivery_id, 8, 4)}
      </span>
      {row.note ? <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.note}</span> : null}
      <button className="ml-auto text-primary underline-offset-2 hover:underline" onClick={onShowRaw}>
        {t('原文')}
      </button>
    </div>
  );
}

export function InboxTab({ overview, jobFilter, onJobFilter }: { overview: FollowOverview | null; jobFilter: string; onJobFilter: (v: string) => void }) {
  const qc = useQueryClient();
  const now = useNow();
  const [view, setView] = useState<'signals' | 'ledger'>('signals');
  const [statusFilter, setStatusFilter] = useState<'all' | TraderSignalStatus>('all');
  const [parseFilter, setParseFilter] = useState<'all' | MarketInboxParseStatus>('all');
  const [raw, setRaw] = useState<MarketInboxRow | null>(null);
  const [staleConfirm, setStaleConfirm] = useState<TraderSignal | null>(null);
  const [reconcileConfirm, setReconcileConfirm] = useState<TraderSignal | null>(null);

  const signalsQ = useQuery({ queryKey: ['follow', 'signals'], queryFn: () => api.followSignals({ limit: 300 }), refetchInterval: 30_000 });
  const ledgerQ = useQuery({
    queryKey: ['market', 'inbox', jobFilter, parseFilter],
    queryFn: () => api.marketInbox({ job_id: jobFilter === 'all' ? undefined : jobFilter, status: parseFilter === 'all' ? undefined : parseFilter, limit: 300 }),
    enabled: view === 'ledger',
    refetchInterval: 30_000,
  });
  const subsQ = useQuery({ queryKey: ['market', 'subscriptions'], queryFn: api.marketSubscriptions, staleTime: 60_000 });
  const openThreadsQ = useQuery({ queryKey: ['threads', 'open'], queryFn: () => api.threads('open'), staleTime: 15_000 });
  const threadById = useMemo(() => new Map((openThreadsQ.data?.threads ?? []).map((th) => [th.id, th])), [openThreadsQ.data]);
  const ledgerBySignal = useMemo(() => new Map((ledgerQ.data?.rows ?? []).filter((r) => r.signal_id).map((r) => [r.signal_id!, r])), [ledgerQ.data]);

  const upsert = (r: { signal: TraderSignal }) => {
    qc.setQueryData(['follow', 'signals'], (old: unknown) => {
      const cur = old as { signals: TraderSignal[] } | undefined;
      if (!cur) return old;
      return { ...cur, signals: cur.signals.map((s) => (s.signal_id === r.signal.signal_id ? r.signal : s)) };
    });
    void qc.invalidateQueries({ queryKey: ['follow'], exact: true });
    void qc.invalidateQueries({ queryKey: ['market', 'subscriptions'] });
  };
  const fail = (msg: string) => (err: unknown) => toast.error(msg, { description: err instanceof Error ? err.message : String(err) });
  const apply = useMutation({
    mutationFn: (a: { id: string; force_stale?: boolean }) => api.applyFollowSignal(a.id, { force_stale: a.force_stale }),
    onSuccess: (r) => {
      upsert(r);
      void qc.invalidateQueries({ queryKey: ['threads'] });
      toast.success(t('已提交手动开仓'));
      setStaleConfirm(null);
    },
    onError: fail(t('开仓失败')),
  });
  const skip = useMutation({
    mutationFn: (id: string) => api.skipFollowSignal(id),
    onSuccess: (r) => {
      upsert(r);
      toast.success(t('已跳过'));
    },
    onError: fail(t('操作失败')),
  });
  const reconcile = useMutation({
    mutationFn: (id: string) => api.reconcileFollowSignal(id),
    onSuccess: (r) => {
      upsert(r);
      toast.success(t('已清除待核对标记'));
      setReconcileConfirm(null);
    },
    onError: fail(t('核对失败')),
  });
  const busy = apply.isPending || skip.isPending || reconcile.isPending;

  const jobName = (jobId: string | null) => subsQ.data?.subscriptions.find((s) => s.job_id === jobId)?.service_name ?? null;
  const signalJob = (sig: TraderSignal): string | null => (sig as TraderSignal & { subscription_job_id?: string | null }).subscription_job_id ?? null;

  const signals = useMemo(() => {
    const list = signalsQ.data?.signals ?? [];
    return [...list]
      .filter((s) => jobFilter === 'all' || signalJob(s) === jobFilter)
      .filter((s) => statusFilter === 'all' || s.status === statusFilter)
      .sort((a, b) => b.published_at - a.published_at);
  }, [signalsQ.data, jobFilter, statusFilter]);

  const pending = useMemo(() => [...(overview?.pending_review ?? [])].sort((a, b) => b.published_at - a.published_at), [overview]);
  const hidden = Math.max(0, (overview?.pending_review_total ?? 0) - pending.length);
  const freshnessS = overview?.follow.freshness_s ?? 180;
  const isStale = (sig: TraderSignal) => sig.backfill || Date.now() - sig.published_at > freshnessS * 1000;
  const requestApply = (sig: TraderSignal) => (isStale(sig) ? setStaleConfirm(sig) : apply.mutate({ id: sig.id }));
  const rowProps = (sig: TraderSignal) => ({
    sig,
    now,
    tpPartial: sig.thread_id ? (threadById.get(sig.thread_id)?.tp_partial_unsupported ?? null) : null,
    entryExpired: sig.thread_id ? threadById.get(sig.thread_id)?.attention === 'ENTRY_EXPIRED' : false,
    busy,
    onApply: () => requestApply(sig),
    onSkip: () => skip.mutate(sig.id),
    onReconcile: () => setReconcileConfirm(sig),
    onShowRaw: ledgerBySignal.get(sig.signal_id) ? () => setRaw(ledgerBySignal.get(sig.signal_id)!) : undefined,
  });

  const scope = overview?.scope ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <Workspace className="flex min-h-0 max-h-[38vh] shrink-0 flex-col">
        <Pane
          title={t('待办')}
          hint={t('{n} 条(共 {total} 条 · 上限 {limit}) · review_only + apply_failed', { n: pending.length, total: overview?.pending_review_total ?? 0, limit: overview?.pending_review_limit ?? 0 })}
          className="min-h-0 flex-1"
          contentClassName="flex min-h-0 flex-col"
        >
          {scope ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b bg-warn/10 px-3 py-1.5 text-[10.5px] text-warn">
              <span>{scope.auto_execution ? t('copy 模式下 open 信号自动开仓(仍过全部闸);其余动作人工') : t('零自动交易所写:所有信号落待办,点「按此信号手动开仓」才下单')}</span>
              <span className="text-muted-foreground">{t('管理动作一律人工,只给跳过;开仓只挂第一档止盈')}</span>
            </div>
          ) : null}
          {!overview ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-16 w-full" />
            </div>
          ) : pending.length === 0 ? (
            <EmptyNote>{t('没有待办;有需要拍板的信号会出现在这里。')}</EmptyNote>
          ) : (
            <>
              {hidden > 0 ? <div className="shrink-0 border-b bg-warn/10 px-3 py-1 text-[10.5px] text-warn">{t('还有 {n} 条未显示', { n: hidden })}</div> : null}
              <ScrollArea className="min-h-0 flex-1">
                {pending.map((sig) => (
                  <SignalRow key={sig.id} {...rowProps(sig)} />
                ))}
              </ScrollArea>
            </>
          )}
        </Pane>
      </Workspace>

      <Workspace className="flex min-h-0 flex-1 flex-col">
        <Pane
          title={view === 'signals' ? t('信号流') : t('入站账本')}
          hint={view === 'signals' ? t('{n} 条 · 按发布时间倒序', { n: signals.length }) : t('{n} 条 · 每条投递落一行,不管解析成不成', { n: ledgerQ.data?.rows.length ?? 0 })}
          className="min-h-0 flex-1"
          contentClassName="flex min-h-0 flex-col"
          actions={
            <>
              <Tabs value={view} onValueChange={(v) => setView(v as 'signals' | 'ledger')}>
                <TabsList className="h-7">
                  <TabsTrigger value="signals" className="h-6 px-2 text-[11px]">
                    {t('信号')}
                  </TabsTrigger>
                  <TabsTrigger value="ledger" className="h-6 px-2 text-[11px]">
                    {t('账本')}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <Select value={jobFilter} onValueChange={onJobFilter}>
                <SelectTrigger className="h-7 w-40 text-[11.5px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-[12px]">
                    {t('全部订阅')}
                  </SelectItem>
                  {(subsQ.data?.subscriptions ?? []).map((s) => (
                    <SelectItem key={s.job_id} value={s.job_id} className="text-[12px]">
                      {s.service_name || s.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {view === 'signals' ? (
                <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as 'all' | TraderSignalStatus)}>
                  <SelectTrigger className="h-7 w-32 text-[11.5px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all" className="text-[12px]">
                      {t('全部状态')}
                    </SelectItem>
                    {TRADER_SIGNAL_STATUSES.map((s) => (
                      <SelectItem key={s} value={s} className="text-[12px]">
                        {TRADER_SIGNAL_STATUS_LABEL[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Select value={parseFilter} onValueChange={(v) => setParseFilter(v as 'all' | MarketInboxParseStatus)}>
                  <SelectTrigger className="h-7 w-32 text-[11.5px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PARSE_FILTERS.map((s) => (
                      <SelectItem key={s} value={s} className="text-[12px]">
                        {s === 'all' ? t('全部') : PARSE_STATUS_LABEL[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </>
          }
        >
          {view === 'signals' ? (
            signalsQ.isLoading ? (
              <div className="space-y-2 p-3">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : signalsQ.isError ? (
              <ErrorNote err={signalsQ.error} />
            ) : signals.length === 0 ? (
              <EmptyNote>{t('没有匹配的信号。')}</EmptyNote>
            ) : (
              <ScrollArea className="min-h-0 flex-1">
                {signals.map((sig) => (
                  <SignalRow key={sig.id} {...rowProps(sig)} />
                ))}
              </ScrollArea>
            )
          ) : ledgerQ.isLoading ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : ledgerQ.isError ? (
            <ErrorNote err={ledgerQ.error} />
          ) : (ledgerQ.data?.rows.length ?? 0) === 0 ? (
            <EmptyNote>{t('账本还是空的;订阅生效后,每条投递都会在这里留一行。')}</EmptyNote>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              {ledgerQ.data!.rows.map((row) => (
                <LedgerRow key={row.delivery_id} row={row} now={now} onShowRaw={() => setRaw(row)} />
              ))}
            </ScrollArea>
          )}
        </Pane>
      </Workspace>

      <Dialog open={raw !== null} onOpenChange={(o) => !o && setRaw(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('投递原文')}</DialogTitle>
            <DialogDescription>
              {raw ? `${jobName(raw.job_id) ?? t('未知订阅')} · ${fmtDateTime(raw.received_at)} · ${PARSE_STATUS_LABEL[raw.parse_status]}${raw.note ? ` · ${raw.note}` : ''}` : ''}
            </DialogDescription>
          </DialogHeader>
          {/* 来自其他用户的文本,原样展示,不解释为指令。 */}
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded border bg-muted/30 p-3 text-[11px]">{raw?.raw}</pre>
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={staleConfirm !== null} title={t('按旧价强制手动开仓?')} summary={t('信号已超龄')} busy={apply.isPending} onCancel={() => setStaleConfirm(null)} onConfirm={() => staleConfirm && apply.mutate({ id: staleConfirm.id, force_stale: true })}>
        {staleConfirm ? (
          <p>
            {t('{trader} 的 {symbol} 这条信号发布于 {age},{reason},几何早就不是那个几何了。确认要按旧价强制手动开仓吗?', {
              trader: staleConfirm.trader,
              symbol: staleConfirm.symbol,
              age: relativeTime(staleConfirm.published_at, now),
              reason: staleConfirm.backfill ? t('且是启动补拉的历史信号') : t('已超过新鲜度上限'),
            })}
          </p>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog open={reconcileConfirm !== null} title={t('确认已人工核对?')} summary={t('这个按钮只清标记,不动钱')} danger busy={reconcile.isPending} onCancel={() => setReconcileConfirm(null)} onConfirm={() => reconcileConfirm && reconcile.mutate(reconcileConfirm.id)}>
        {reconcileConfirm ? (
          <p>
            {t('{trader} 的 {symbol} 这条信号处在「不知道交易所那边到底怎么样」的状态。请先到交易页核对该线程/挂单实际状态,确认无误后再点这个——它只清除待核对标记,不会自己去核对,也不会补发/撤销任何动作。', {
              trader: reconcileConfirm.trader,
              symbol: reconcileConfirm.symbol,
            })}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
