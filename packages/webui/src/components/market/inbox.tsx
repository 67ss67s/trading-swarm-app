/**
 * 「信号」栏(2026-09-25 新用户视角改版,设计 docs/design/signal-market-ux-2026-09-25.md):
 *   - 「待你处理」只在有待处理信号时出现(沿用跟单流水线 apply / skip / reconcile);
 *   - 「收到的内容」= 入站账本(每条投递一行,告警 / 报告这类没有信号对象的也在)拼上跟单信号,
 *     按订阅分组的时间线,也可按订阅 / 类型筛选;每条一行,点开看原文与关键价位;
 *   - 平台通知(任务创建、收发回执)和不属于你订阅的消息默认不显示,可以打开。
 */
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { friendlyError } from '@/lib/edition';
import { api } from '@/api/client';
import { buildSignalFeed, offTypeFeedKeys } from '@/api/market-adapt';
import type { FeedItem, FeedKind } from '@/api/market-adapt';
import type { FollowOverview, MarketSubscriptionView, TraderSignal } from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Pane, Workspace } from '@/components/pane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { directionLabel, directionText, fmtDate, fmtDateTime, relativeTime, useNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { EmptyNote, ErrorNote, FEED_KIND_CLASS, FEED_KIND_LABEL, SUB_GROUP_CLASS, SUB_GROUP_TITLE, fmtFeedTime, subName, subProvider } from './shared';
import { LevelsRow, OutcomeTag, SignalActions, SignalDetail, SignalRow, feedOutcome } from './signal-row';

const KIND_FILTERS: ('all' | Exclude<FeedKind, 'system'>)[] = ['all', 'trade', 'intel', 'alert', 'report'];
/** 分组视图里每个订阅先露几条。 */
const GROUP_PREVIEW = 5;
const OTHER = '__other__';

type RowHandlers = {
  now: number;
  busy: boolean;
  threadHints: (sig: TraderSignal) => { tpPartial: { placed: string; dropped: { price: string; percent: number }[]; note: string } | null; entryExpired: boolean };
  onApply: (sig: TraderSignal) => void;
  onSkip: (sig: TraderSignal) => void;
  onReconcile: (sig: TraderSignal) => void;
};

function FeedRow({ item, source, h }: { item: FeedItem; source: string | null; h: RowHandlers }) {
  const [open, setOpen] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const outcome = feedOutcome(item);
  const sig = item.kind === 'trade' ? item.signal : null;
  return (
    <div className="border-b last:border-b-0">
      <button
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-left text-[12px] hover:bg-muted/40"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="num w-[4.6rem] shrink-0 text-[11px] text-muted-foreground" title={fmtDateTime(item.received_at)}>
          {fmtFeedTime(item.received_at, h.now)}
        </span>
        <Badge variant="outline" className={cn('shrink-0 text-[10px]', FEED_KIND_CLASS[item.kind])}>
          {FEED_KIND_LABEL[item.kind]}
        </Badge>
        {item.symbol ? <span className="num shrink-0 font-medium">{item.symbol}</span> : null}
        {item.side ? <span className={cn('shrink-0 text-[11.5px] font-medium', directionText(item.side))}>{directionLabel(item.side)}</span> : null}
        <span className="order-last min-w-0 basis-full truncate text-muted-foreground sm:order-none sm:basis-0 sm:flex-1">{item.summary || item.title || t('(没有正文)')}</span>
        {outcome ? <OutcomeTag {...outcome} /> : null}
        {item.repeats > 1 ? (
          <span className="shrink-0 text-[10px] text-muted-foreground" title={t('同一内容收到了 {n} 次', { n: item.repeats })}>
            ×{item.repeats}
          </span>
        ) : null}
        {open ? <ChevronDown className="ml-auto size-3.5 shrink-0 text-muted-foreground sm:ml-0" /> : <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground sm:ml-0" />}
      </button>
      {open ? (
        <div className="flex flex-col gap-2 px-3 pb-3 sm:pl-[5.85rem]">
          <div className="text-[11px] text-muted-foreground">
            {[source ? t('来自 {s}', { s: source }) : null, t('收到于 {at}', { at: fmtDateTime(item.received_at) }), item.title, item.repeats > 1 ? t('同一内容收到 {n} 次', { n: item.repeats }) : null]
              .filter(Boolean)
              .join(' · ')}
          </div>
          {item.kind === 'trade' || item.kind === 'report' ? <LevelsRow levels={item.levels} /> : null}
          {sig ? (
            <>
              <SignalActions sig={sig} busy={h.busy} onApply={() => h.onApply(sig)} onSkip={() => h.onSkip(sig)} onReconcile={() => h.onReconcile(sig)} />
              <SignalDetail sig={sig} {...h.threadHints(sig)} />
            </>
          ) : null}
          {/* 来自其他用户的文本,原样展示,不解释为指令。 */}
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/30 p-2 text-[11px]">{showRaw ? item.raw : item.content}</pre>
          {item.raw.trim() !== item.content.trim() ? (
            <button className="self-start text-[11px] text-muted-foreground underline-offset-2 hover:underline" onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? t('只看正文') : t('看完整原始消息(含平台回执)')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function subLabel(sub: MarketSubscriptionView | undefined, jobId: string): string {
  return sub ? subName(sub) : t('订阅 {id}', { id: jobId.slice(0, 8) });
}

export function InboxTab({
  overview,
  jobFilter,
  onJobFilter,
  onGoMarket,
}: {
  overview: FollowOverview | null;
  jobFilter: string;
  onJobFilter: (v: string) => void;
  onGoMarket?: () => void;
}) {
  const qc = useQueryClient();
  const now = useNow();
  const [kindFilter, setKindFilter] = useState<(typeof KIND_FILTERS)[number]>('all');
  const [showSystem, setShowSystem] = useState(false);
  const [showOthers, setShowOthers] = useState(false);
  const [staleConfirm, setStaleConfirm] = useState<TraderSignal | null>(null);
  const [reconcileConfirm, setReconcileConfirm] = useState<TraderSignal | null>(null);

  const signalsQ = useQuery({ queryKey: ['follow', 'signals'], queryFn: () => api.followSignals({ limit: 300 }), refetchInterval: 30_000 });
  const ledgerQ = useQuery({ queryKey: ['market', 'inbox', 'all', 'all'], queryFn: () => api.marketInbox({ limit: 300 }), refetchInterval: 30_000 });
  const subsQ = useQuery({ queryKey: ['market', 'subscriptions'], queryFn: api.marketSubscriptions, staleTime: 60_000 });
  const openThreadsQ = useQuery({ queryKey: ['threads', 'open'], queryFn: () => api.threads('open'), staleTime: 15_000 });
  const threadById = useMemo(() => new Map((openThreadsQ.data?.threads ?? []).map((th) => [th.id, th])), [openThreadsQ.data]);

  const upsert = (r: { signal: TraderSignal }) => {
    qc.setQueryData(['follow', 'signals'], (old: unknown) => {
      const cur = old as { signals: TraderSignal[] } | undefined;
      if (!cur) return old;
      return { ...cur, signals: cur.signals.map((s) => (s.signal_id === r.signal.signal_id ? r.signal : s)) };
    });
    void qc.invalidateQueries({ queryKey: ['follow'], exact: true });
    void qc.invalidateQueries({ queryKey: ['market', 'subscriptions'] });
  };
  const fail = (msg: string) => (err: unknown) => toast.error(msg, { description: friendlyError(err instanceof Error ? err.message : String(err)) });
  const apply = useMutation({
    mutationFn: (a: { id: string; force_stale?: boolean }) => api.applyFollowSignal(a.id, { force_stale: a.force_stale }),
    onSuccess: (r) => {
      upsert(r);
      void qc.invalidateQueries({ queryKey: ['threads'] });
      toast.success(t('已提交下单'));
      setStaleConfirm(null);
    },
    onError: fail(t('下单失败')),
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
      toast.success(t('已清除核对提醒'));
      setReconcileConfirm(null);
    },
    onError: fail(t('操作失败')),
  });
  const busy = apply.isPending || skip.isPending || reconcile.isPending;

  const subs = subsQ.data?.subscriptions ?? [];
  const subById = useMemo(() => new Map(subs.map((s) => [s.job_id, s])), [subs]);
  /** 订阅列表真拿到了(不是缓存加载中)才按「是不是我的订阅」过滤,否则全显示。 */
  const subsKnown = !!subsQ.data && subsQ.data.cache?.fetched_at !== null;
  const isMine = (job: string | null) => !subsKnown || (job !== null && subById.has(job));

  const feed = useMemo(() => buildSignalFeed(ledgerQ.data?.rows ?? [], signalsQ.data?.signals ?? []), [ledgerQ.data, signalsQ.data]);
  /** 误推给情报 / 告警订阅的交易信号等「不属于该服务类型的历史消息」:默认收起,和「不属于你订阅的消息」共用一个开关。 */
  const offType = useMemo(() => (subsKnown ? offTypeFeedKeys(feed, subById) : new Set<string>()), [feed, subById, subsKnown]);
  const inDefaultView = (f: FeedItem) => isMine(f.job_id) && !offType.has(f.key);
  const systemCount = feed.filter((f) => f.kind === 'system' && isMine(f.job_id)).length;
  const othersCount = feed.filter((f) => !isMine(f.job_id)).length;
  const offTypeCount = feed.filter((f) => isMine(f.job_id) && offType.has(f.key)).length;
  const hiddenCount = othersCount + offTypeCount;
  const hiddenLabel =
    othersCount > 0 && offTypeCount > 0
      ? t('显示不属于你订阅或该服务类型的历史消息({n})', { n: hiddenCount })
      : offTypeCount > 0
        ? t('显示不属于该服务类型的历史消息({n})', { n: offTypeCount })
        : t('显示不属于你订阅的消息({n})', { n: othersCount });
  const hiddenHint = [
    othersCount > 0 ? t('多半是你作为服务方的订单往来,去「发布」栏看') : null,
    offTypeCount > 0 ? t('9 月 25 日 20:20 之前的一个问题把部分策略交易信号误推给了市场情报 / 微观告警订阅,这些默认收起') : null,
  ]
    .filter(Boolean)
    .join('\n');
  const visible = feed.filter(
    (f) =>
      (showSystem || f.kind !== 'system') &&
      (showOthers || inDefaultView(f)) &&
      (kindFilter === 'all' || f.kind === kindFilter) &&
      (jobFilter === 'all' || f.job_id === jobFilter),
  );
  const mineTotal = feed.filter((f) => f.kind !== 'system' && inDefaultView(f)).length;

  // 按订阅分组,组按最新一条倒序;不属于订阅的放最后。
  const groupMap = new Map<string, FeedItem[]>();
  for (const f of visible) {
    const k = isMine(f.job_id) && f.job_id ? f.job_id : OTHER;
    const arr = groupMap.get(k);
    if (arr) arr.push(f);
    else groupMap.set(k, [f]);
  }
  const groups = [...groupMap.entries()].sort((a, b) => (a[0] === OTHER ? 1 : b[0] === OTHER ? -1 : b[1][0]!.received_at - a[1][0]!.received_at));

  const pending = useMemo(() => [...(overview?.pending_review ?? [])].sort((a, b) => b.published_at - a.published_at), [overview]);
  const pendingTotal = overview?.pending_review_total ?? 0;
  const hidden = Math.max(0, pendingTotal - pending.length);
  const freshnessS = overview?.follow.freshness_s ?? 180;
  const isStale = (sig: TraderSignal) => sig.backfill || Date.now() - sig.published_at > freshnessS * 1000;
  const signalJob = (sig: TraderSignal): string | null => (sig as TraderSignal & { subscription_job_id?: string | null }).subscription_job_id ?? null;

  const h: RowHandlers = {
    now,
    busy,
    threadHints: (sig) => ({
      tpPartial: sig.thread_id ? (threadById.get(sig.thread_id)?.tp_partial_unsupported ?? null) : null,
      entryExpired: sig.thread_id ? threadById.get(sig.thread_id)?.attention === 'ENTRY_EXPIRED' : false,
    }),
    onApply: (sig) => (isStale(sig) ? setStaleConfirm(sig) : apply.mutate({ id: sig.id })),
    onSkip: (sig) => skip.mutate(sig.id),
    onReconcile: (sig) => setReconcileConfirm(sig),
  };
  const sourceOf = (job: string | null) => (job ? (subById.has(job) ? subLabel(subById.get(job), job) : null) : null);

  const loading = (ledgerQ.isLoading && signalsQ.isLoading) || (ledgerQ.isLoading && !signalsQ.data);
  const bothFailed = ledgerQ.isError && signalsQ.isError;
  const scope = overview?.scope ?? null;
  const jobOptions = subs.filter((s) => s.display.group !== 'ended' || feed.some((f) => f.job_id === s.job_id));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {pendingTotal > 0 ? (
        <Workspace className="flex min-h-0 max-h-[42vh] shrink-0 flex-col border-warn/40">
          <Pane title={t('待你处理')} hint={t('{n} 条信号等你决定', { n: pendingTotal })} className="min-h-0 flex-1" contentClassName="flex min-h-0 flex-col">
            {scope ? (
              <div className="border-b bg-warn/10 px-3 py-1.5 text-[11px] text-warn">
                {scope.auto_execution
                  ? t('有订阅设成了自动下单:开仓信号会自动下单(仍过风控);其余的在这里等你决定。')
                  : t('系统不会替你下单:点「按这条下单」才会真的下单;减仓、平仓一律到交易页手动处理。')}
              </div>
            ) : null}
            {hidden > 0 ? <div className="shrink-0 border-b px-3 py-1 text-[10.5px] text-muted-foreground">{t('还有 {n} 条没显示,先处理上面的', { n: hidden })}</div> : null}
            <ScrollArea className="min-h-0 flex-1">
              {pending.map((sig) => (
                <SignalRow
                  key={sig.id}
                  sig={sig}
                  source={sourceOf(signalJob(sig))}
                  now={now}
                  {...h.threadHints(sig)}
                  busy={busy}
                  onApply={() => h.onApply(sig)}
                  onSkip={() => h.onSkip(sig)}
                  onReconcile={() => h.onReconcile(sig)}
                />
              ))}
            </ScrollArea>
          </Pane>
        </Workspace>
      ) : null}

      <Workspace className="flex min-h-0 flex-1 flex-col">
        <Pane
          title={t('收到的内容')}
          hint={mineTotal ? t('{n} 条 · 最新在上', { n: mineTotal }) : undefined}
          className="min-h-0 flex-1"
          contentClassName="flex min-h-0 flex-col"
        >
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
            <Select value={jobFilter} onValueChange={onJobFilter}>
              <SelectTrigger className="h-7 w-full text-[11.5px] sm:w-56" aria-label={t('按订阅筛选')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-[12px]">
                  {t('全部订阅(按订阅分组)')}
                </SelectItem>
                {jobOptions.map((s) => (
                  <SelectItem key={s.job_id} value={s.job_id} className="text-[12px]">
                    {subName(s)}
                  </SelectItem>
                ))}
                {jobFilter !== 'all' && !jobOptions.some((s) => s.job_id === jobFilter) ? (
                  <SelectItem value={jobFilter} className="text-[12px]">
                    {subLabel(subById.get(jobFilter), jobFilter)}
                  </SelectItem>
                ) : null}
              </SelectContent>
            </Select>
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('按类型筛选')}>
              {KIND_FILTERS.map((k) => (
                <button
                  key={k}
                  className={cn(
                    'h-6 rounded-full border px-2 text-[11px]',
                    kindFilter === k ? 'border-primary/50 bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground',
                  )}
                  aria-pressed={kindFilter === k}
                  onClick={() => setKindFilter(k)}
                >
                  {k === 'all' ? t('全部类型') : FEED_KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </div>

          {ledgerQ.isError !== signalsQ.isError ? (
            <p role="alert" className="shrink-0 border-b bg-warn/10 px-3 py-1 text-[10.5px] text-warn">
              {ledgerQ.isError ? t('收件记录加载失败,下面只显示交易信号') : t('交易信号状态加载失败,下面的状态可能不全')}
            </p>
          ) : null}

          {loading ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : bothFailed ? (
            <ErrorNote err={ledgerQ.error} />
          ) : mineTotal === 0 && jobFilter === 'all' && !showOthers ? (
            <div className="flex flex-col items-center gap-2 p-6 text-center">
              <p className="text-[12.5px] font-medium">{t('订阅后收到的内容会出现在这里')}</p>
              <p className="max-w-md text-[11.5px] text-muted-foreground">{t('交易信号、市场情报、告警和报告都会按订阅分好组;点开任意一条能看原文和关键价位。')}</p>
              {onGoMarket ? (
                <Button size="xs" variant="outline" onClick={onGoMarket}>
                  {t('去市场挑一个服务')}
                </Button>
              ) : null}
            </div>
          ) : visible.length === 0 ? (
            <EmptyNote>{t('没有符合筛选条件的内容。')}</EmptyNote>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              {jobFilter === 'all' ? (
                groups.map(([job, items]) => {
                  const sub = job === OTHER ? undefined : subById.get(job);
                  const provider = sub ? subProvider(sub) : null;
                  return (
                    <section key={job} className="border-b last:border-b-0">
                      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b bg-muted/60 px-3 py-1.5 backdrop-blur">
                        <span className="min-w-0 truncate text-[12px] font-semibold">{job === OTHER ? t('不属于你订阅的消息') : subLabel(sub, job)}</span>
                        {provider ? <span className="truncate text-[11px] text-muted-foreground">{provider}</span> : null}
                        {sub ? (
                          <Badge variant="outline" className={cn('text-[10px]', SUB_GROUP_CLASS[sub.display.group])}>
                            {SUB_GROUP_TITLE[sub.display.group]}
                          </Badge>
                        ) : null}
                        <span className="text-[11px] text-muted-foreground">
                          {t('{n} 条', { n: items.length })} · {relativeTime(items[0]!.received_at, now)}
                        </span>
                        {job !== OTHER ? (
                          <button className="ml-auto text-[11px] text-primary underline-offset-2 hover:underline" onClick={() => onJobFilter(job)}>
                            {t('只看这个')}
                          </button>
                        ) : null}
                      </header>
                      {items.slice(0, GROUP_PREVIEW).map((item) => (
                        <FeedRow key={item.key} item={item} source={job === OTHER ? null : subLabel(sub, job)} h={h} />
                      ))}
                      {items.length > GROUP_PREVIEW && job !== OTHER ? (
                        <button className="w-full px-3 py-1.5 text-left text-[11px] text-primary hover:bg-muted/40" onClick={() => onJobFilter(job)}>
                          {t('还有 {n} 条,查看全部', { n: items.length - GROUP_PREVIEW })}
                        </button>
                      ) : null}
                      {items.length > GROUP_PREVIEW && job === OTHER
                        ? items.slice(GROUP_PREVIEW).map((item) => <FeedRow key={item.key} item={item} source={null} h={h} />)
                        : null}
                    </section>
                  );
                })
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-[11px]">
                    <button className="text-primary underline-offset-2 hover:underline" onClick={() => onJobFilter('all')}>
                      ← {t('全部订阅')}
                    </button>
                    {subById.get(jobFilter) ? <span className="text-muted-foreground">{subProvider(subById.get(jobFilter)!)}</span> : null}
                  </div>
                  {visible.map((item, i) => {
                    const day = fmtDate(item.received_at);
                    const prevDay = i > 0 ? fmtDate(visible[i - 1]!.received_at) : null;
                    return (
                      <div key={item.key}>
                        {day !== prevDay ? <div className="bg-muted/40 px-3 py-0.5 text-[10.5px] text-muted-foreground">{day}</div> : null}
                        <FeedRow item={item} source={sourceOf(item.job_id)} h={h} />
                      </div>
                    );
                  })}
                </>
              )}
            </ScrollArea>
          )}

          {systemCount > 0 || hiddenCount > 0 ? (
            <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
              {systemCount > 0 ? (
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" className="size-3" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
                  {t('显示平台通知({n})', { n: systemCount })}
                </label>
              ) : null}
              {hiddenCount > 0 ? (
                <label className="flex items-center gap-1.5" title={hiddenHint}>
                  <input type="checkbox" className="size-3" checked={showOthers} onChange={(e) => setShowOthers(e.target.checked)} />
                  {hiddenLabel}
                </label>
              ) : null}
            </div>
          ) : null}
        </Pane>
      </Workspace>

      <ConfirmDialog open={staleConfirm !== null} title={t('这条信号已经过时,仍按旧价下单?')} summary={t('信号已超过有效时间')} busy={apply.isPending} onCancel={() => setStaleConfirm(null)} onConfirm={() => staleConfirm && apply.mutate({ id: staleConfirm.id, force_stale: true })}>
        {staleConfirm ? (
          <p>
            {t('{symbol} 这条信号发布于 {age},{reason},行情可能已经变了。确定还要按信号里的价格下单吗?', {
              symbol: staleConfirm.symbol,
              age: relativeTime(staleConfirm.published_at, now),
              reason: staleConfirm.backfill ? t('而且是启动时补收的历史信号') : t('已超过有效时间'),
            })}
          </p>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog open={reconcileConfirm !== null} title={t('确认已人工核对?')} summary={t('这个按钮只清除提醒,不动钱')} danger busy={reconcile.isPending} onCancel={() => setReconcileConfirm(null)} onConfirm={() => reconcileConfirm && reconcile.mutate(reconcileConfirm.id)}>
        {reconcileConfirm ? (
          <p>
            {t('{symbol} 这条信号的下单结果不确定(不知道交易所那边是否成交)。请先到交易页核对实际的挂单和持仓,确认无误后再点确认——它只清除提醒,不会替你核对,也不会补下单或撤单。', {
              symbol: reconcileConfirm.symbol,
            })}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
