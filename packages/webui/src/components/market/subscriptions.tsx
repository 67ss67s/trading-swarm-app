import { CacheNote, cachePollMs } from '@/components/market/cache-note';
/**
 * 「订阅」栏(2026-09-25 新用户视角改版,设计 docs/design/signal-market-ux-2026-09-25.md):
 * 按分组排:进行中 → 试用中 → 等服务方接单 → 已取消续费但试用未到期 → 已结束(默认折叠)。
 * 每张卡先回答「是什么、什么状态、多少钱、收到了什么、能做什么」;
 * 收到后怎么处理(本机设置)和历史表现收进展开区。
 */
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { MarketScorecard, MarketSubscriptionGroup } from '@/api/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { friendlyError } from '@/lib/edition';
import { JudgeLock } from '@/components/judge-lock';
import { api } from '@/api/client';
import { SUB_GROUP_ORDER, buildSignalFeed, pickSnapshotAsOf, marketSubscriptionAction, offTypeFeedKeys } from '@/api/market-adapt';
import type { FeedItem } from '@/api/market-adapt';
import type { FollowApproval, FollowMode, MarketSubscriptionView } from '@/api/types';
import { FOLLOW_MODES } from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Pane } from '@/components/pane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { fmtDateTime, relativeTime, useNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { getLang, t } from '@/lib/i18n';
import {
  ErrorNote,
  FEED_KIND_CLASS,
  FEED_KIND_LABEL,
  MODE_HINT,
  MODE_LABEL,
  SUB_GROUP_CLASS,
  SUB_GROUP_TITLE,
  fmtMdHm,
  fmtR,
  fmtRate,
  fmtRemaining,
  subName,
  subProvider,
} from './shared';

/** 事后回测一行:胜率 / 平均 R / 盈亏比 / 计划盈亏比(样本数)。没有交易信号就不查。 */
function ScorecardRow({ jobId, orders }: { jobId: string; orders: number }) {
  const q = useQuery<MarketScorecard>({ queryKey: ['market', 'scorecard', jobId], queryFn: () => api.marketScorecard(jobId), enabled: orders > 0, staleTime: 10 * 60_000 });
  const qc = useQueryClient();
  const refresh = useMutation({ mutationFn: () => api.marketScorecard(jobId, true), onSuccess: (d) => qc.setQueryData(['market', 'scorecard', jobId], d) });
  const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(0)}%`);
  const num = (v: number | null, d = 2) => (v === null ? '—' : v.toFixed(d));
  const sc = q.data;
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground sm:grid-cols-3">
      <span className="col-span-2 flex items-center gap-1.5 sm:col-span-3">
        <span className="font-medium text-foreground/80">{t('按 K 线事后检验')}</span>
        <span className="text-[10px]">{orders === 0 ? t('还没有交易信号可检验') : sc ? t('{n} 条可评 / 共 {m}', { n: sc.n_scored, m: sc.n_signals }) : q.isLoading ? t('计算中…') : q.error ? t('检验失败') : ''}</span>
        {orders > 0 ? (
          <JudgeLock feature="asp_settings" className="ml-auto">
            <button className="ml-auto text-[10px] underline-offset-2 hover:underline" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
              {refresh.isPending ? t('重算中…') : t('重算')}
            </button>
          </JudgeLock>
        ) : null}
      </span>
      {sc ? (
        <>
          <span>
            {t('胜率')} <span className="num text-foreground">{pct(sc.win_rate)}</span>
            <span className="ml-1 text-[10px]">{sc.wins}/{sc.wins + sc.losses}</span>
          </span>
          <span>
            {t('平均 R')} <span className={cn('num', sc.avg_r === null ? 'text-foreground' : sc.avg_r >= 0 ? 'text-up' : 'text-down')}>{num(sc.avg_r)}</span>
          </span>
          <span>
            {t('盈亏比')} <span className="num text-foreground">{num(sc.profit_factor)}</span>
          </span>
          <span>
            {t('累计 R')} <span className={cn('num', sc.sum_r === null ? 'text-foreground' : sc.sum_r >= 0 ? 'text-up' : 'text-down')}>{num(sc.sum_r)}</span>
          </span>
          <span>
            {t('持仓中')} <span className="num text-foreground">{sc.outcomes.filter((o) => o.status === 'open').length}</span>
          </span>
        </>
      ) : null}
    </div>
  );
}

/**
 * 试用到期会不会转付费:网关 display.label 带了「到期不续费 / 到期转付费」就以它为准,
 * 否则看远端 autoRenew(适配成 auto_renew;0 / false = 不续费)。
 */
export function trialRenews(sub: Pick<MarketSubscriptionView, 'auto_renew' | 'display'>): boolean {
  if (sub.display.label.includes('到期不续费')) return false;
  if (sub.display.label.includes('到期转付费')) return true;
  return sub.auto_renew;
}

/** 状态一句话:试用剩多久 + 到期是否转付费、试用到哪天、本期到哪天;其余用网关给的 label。 */
export function statusText(sub: MarketSubscriptionView, now: number): string {
  const { group, until, label } = sub.display;
  if (group === 'trial') {
    // 中文界面优先用网关的整句(「试用中 · 剩 2 天 19 小时 · 到期不续费」);英文或老网关没带续费标注时本地拼
    if (getLang() === 'zh' && /到期(不续费|转付费)/.test(label)) return label;
    const renew = trialRenews(sub) ? t('到期转付费') : t('到期不续费');
    const left = fmtRemaining(until, now);
    return `${left ? t('试用中 · 还剩 {left}', { left }) : t('试用中')} · ${renew}`;
  }
  if (group === 'cancelled_trial') return until ? t('已取消续费 · 试用至 {at}', { at: fmtMdHm(until) }) : label;
  if (group === 'active' && until) return sub.auto_renew ? t('进行中 · {at} 自动续费', { at: fmtMdHm(until) }) : t('进行中 · {at} 到期', { at: fmtMdHm(until) });
  return label;
}

function priceText(sub: MarketSubscriptionView): string {
  if (sub.display.group === 'cancelled_trial' || (sub.display.group === 'trial' && !trialRenews(sub))) return t('试用免费,到期不扣费');
  if (!sub.fee_amount) return '—';
  const fee = Number(sub.fee_amount);
  const monthly = Number.isFinite(fee) && fee === 0 ? t('免费') : t('{fee} USDT/月', { fee: sub.fee_amount });
  if (sub.display.group === 'trial') return t('试用免费,之后 {price}', { price: monthly });
  return monthly;
}

function SubscriptionCard({
  sub,
  now,
  latest,
  onPatch,
  onCancel,
  onReject,
  onAutorenew,
  onShowSignals,
  busy,
}: {
  sub: MarketSubscriptionView;
  now: number;
  latest: FeedItem | null;
  onPatch: (body: Parameters<typeof api.marketPatchSubscription>[1]) => void;
  onCancel: () => void;
  onReject: () => void;
  onAutorenew: () => void;
  onShowSignals: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draftMode, setDraftMode] = useState<FollowMode>(sub.config.mode);
  const [draftWeight, setDraftWeight] = useState(String(sub.config.weight));
  const [draftApproval, setDraftApproval] = useState<FollowApproval>(sub.config.approval);
  const dirty = draftMode !== sub.config.mode || Number(draftWeight) !== sub.config.weight || draftApproval !== sub.config.approval;
  const active = sub.status_name === 'ACTIVE';
  const trial = sub.trial_type === 1;
  const group = sub.display.group;
  const ended = group === 'ended';
  const provider = subProvider(sub);
  // 试用已关掉转付费(remote.autoRenew = 0)就没有「取消转付费」可点了
  const trialRenewOff = trial && group === 'trial' && !trialRenews(sub);
  return (
    <div className={cn('flex flex-col gap-2 rounded-md border bg-card p-3', ended && 'opacity-75')}>
      <div className="flex items-start gap-2.5">
        {sub.asp_avatar ? <img alt="" src={sub.asp_avatar} className="size-10 shrink-0 rounded-md border object-cover" loading="lazy" /> : <div className="size-10 shrink-0 rounded-md border bg-muted" />}
        <div className="min-w-0 flex-1">
          <button className="block max-w-full truncate text-left text-[13px] font-semibold hover:underline" title={subName(sub)} onClick={onShowSignals}>
            {subName(sub)}
          </button>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{provider ? t('服务方 {p}', { p: provider }) : t('服务方未知')}</div>
        </div>
      </div>

      <Badge variant="outline" className={cn('self-start text-[10.5px]', SUB_GROUP_CLASS[group])} title={sub.display.label}>
        {statusText(sub, now)}
      </Badge>

      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        <span className="col-span-2">
          {t('价格')} <span className="num text-foreground">{priceText(sub)}</span>
        </span>
        <span>
          {t('已收到')} <span className="num text-foreground">{t('{n} 条', { n: sub.stats.received })}</span>
        </span>
        <span>
          {t('最近收到')} <span className="text-foreground">{sub.last_delivery_at ? relativeTime(sub.last_delivery_at, now) : t('还没有')}</span>
        </span>
        {active && !sub.this_device_receives ? <span className="col-span-2 text-warn">{t('这台电脑没在接收推送')}</span> : null}
      </div>

      {latest ? (
        <button className="flex min-w-0 items-center gap-1.5 rounded border bg-muted/30 px-2 py-1 text-left text-[11px] hover:bg-muted/60" onClick={onShowSignals} title={latest.summary}>
          <Badge variant="outline" className={cn('shrink-0 text-[9.5px]', FEED_KIND_CLASS[latest.kind])}>
            {FEED_KIND_LABEL[latest.kind]}
          </Badge>
          {latest.symbol ? <span className="num shrink-0 font-medium">{latest.symbol}</span> : null}
          <span className="min-w-0 truncate text-muted-foreground">{latest.summary || latest.title}</span>
        </button>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5 border-t pt-2">
        <Button size="xs" variant="outline" onClick={onShowSignals}>
          {t('看收到的内容')}
        </Button>
        {active && !sub.auto_renew && !trial ? (
          <JudgeLock feature="asp_settings">
            <Button size="xs" variant="outline" disabled={busy} onClick={onAutorenew}>
              {t('开自动续费')}
            </Button>
          </JudgeLock>
        ) : null}
        {active && !trial ? (
          <JudgeLock feature="asp_cancel">
            <Button size="xs" variant="outline" disabled={busy} onClick={onReject}>
              {t('拒收本期')}
            </Button>
          </JudgeLock>
        ) : null}
        {((active && (!trial || group === 'trial')) || sub.status_name === 'CREATED') && !trialRenewOff ? (
          <JudgeLock feature="asp_cancel" className="ml-auto">
            <Button size="xs" variant="destructive" disabled={busy} onClick={onCancel} className="ml-auto">
              {trial ? t('取消转付费') : sub.auto_renew ? t('关自动续费') : t('取消')}
            </Button>
          </JudgeLock>
        ) : null}
      </div>

      {!ended ? (
        <>
          <button className="flex items-center gap-1 self-start text-[11px] text-muted-foreground hover:text-foreground" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {t('收到后怎么处理')}:<span className={cn('text-foreground', !sub.config.enabled && 'line-through')}>{MODE_LABEL[sub.config.mode]}</span>
            {!sub.config.enabled ? <span className="text-warn">({t('已暂停')})</span> : null}
          </button>
          {open ? (
            <div className="flex flex-col gap-2 rounded border bg-muted/20 p-2">
              <label className="flex items-center gap-2 text-[11.5px]">
                <JudgeLock feature="asp_settings">
                  <Switch className="scale-90" checked={sub.config.enabled} disabled={busy} onCheckedChange={(v) => onPatch({ enabled: v })} />
                </JudgeLock>
                {sub.config.enabled ? t('处理这个订阅的信号') : t('已暂停处理(内容照收,只是不处理)')}
              </label>
              <label className="flex items-center gap-2 text-[11.5px]">
                <JudgeLock feature="asp_settings">
                  <Switch className="scale-90" checked={sub.this_device_receives} disabled={busy || !active} onCheckedChange={(v) => onPatch({ this_device_receives: v })} />
                </JudgeLock>
                {sub.this_device_receives ? t('这台电脑接收推送') : t('这台电脑不接收推送')}
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={draftMode} onValueChange={(v) => setDraftMode(v as FollowMode)}>
                  <SelectTrigger className="h-7 min-w-0 flex-1 text-[11.5px]" aria-label={t('收到后怎么处理')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FOLLOW_MODES.map((m) => (
                      <SelectItem key={m} value={m} className="text-[12px]">
                        {MODE_LABEL[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {draftMode !== 'evidence' ? (
                  <label className="flex items-center gap-1 text-[11px] text-muted-foreground" title={t('下单时的风险预算 = 全局单笔风险 × 这个系数;0 = 不下单')}>
                    {t('仓位系数')}
                    <Input value={draftWeight} onChange={(e) => setDraftWeight(e.target.value)} type="number" min={0} max={1} step={0.05} className="h-7 w-16 text-[11.5px]" />
                  </label>
                ) : null}
              </div>
              <p className={cn('text-[10.5px]', draftMode === 'book' ? 'text-warn' : 'text-muted-foreground')}>{MODE_HINT[draftMode]}</p>
              {draftMode === 'book' ? (
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="shrink-0 text-muted-foreground">{t('算好方案后')}</span>
                  <Select value={draftApproval} onValueChange={(v) => setDraftApproval(v as FollowApproval)}>
                    <SelectTrigger className="h-7 flex-1 text-[11.5px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="manual" className="text-[12px]">
                        {t('等我在交易页确认')}
                      </SelectItem>
                      <SelectItem value="auto" className="text-[12px]">
                        {t('直接下单(自动)')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              {dirty ? (
                <JudgeLock feature="asp_settings" className="self-start">
                  <Button size="xs" className="self-start" disabled={busy} onClick={() => onPatch({ mode: draftMode, approval: draftApproval, weight: Math.max(0, Math.min(1, Number(draftWeight) || 0)) })}>
                    {t('保存')}
                  </Button>
                </JudgeLock>
              ) : null}
              <p className="text-[10px] text-muted-foreground">{t('这些设置只在这台电脑上生效。')}</p>

              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 border-t pt-2 text-[11px] text-muted-foreground sm:grid-cols-3">
                <span>
                  {t('交易信号')} <span className="num text-foreground">{sub.stats.orders}</span>
                </span>
                <span>
                  {t('情报/分析')} <span className="num text-foreground">{sub.stats.analysis}</span>
                </span>
                <span>
                  {t('已下单')} <span className="num text-foreground">{sub.stats.applied}</span>
                </span>
                <span>
                  {t('等你决定')} <span className="num text-foreground">{sub.stats.review_only}</span>
                </span>
                <span>
                  {t('已跳过')} <span className="num text-foreground">{sub.stats.skipped}</span>
                </span>
                <span>
                  {t('AI 认同率')} <span className="num text-foreground">{fmtRate(sub.stats.agent_agree_rate)}</span>
                </span>
                <span className="col-span-2 sm:col-span-3">
                  {t('已实现 R')} <span className="num text-foreground">{fmtR(sub.stats.realized_r)}</span>
                  {sub.stats.settling > 0 ? <span className="ml-1 text-[10px]">({t('{n} 笔结算中', { n: sub.stats.settling })})</span> : null}
                </span>
              </div>
              <div className="border-t pt-2">
                <ScorecardRow jobId={sub.job_id} orders={sub.stats.orders} />
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function SubscriptionsTab({ onShowSignals, onGoMarket }: { onShowSignals: (jobId: string) => void; onGoMarket?: () => void }) {
  const qc = useQueryClient();
  const now = useNow();
  const q = useQuery({ queryKey: ['market', 'subscriptions'], queryFn: api.marketSubscriptions, refetchInterval: cachePollMs });
  // 与「信号」栏共用缓存:拿每个订阅最近收到的一条。
  const ledgerQ = useQuery({ queryKey: ['market', 'inbox', 'all', 'all'], queryFn: () => api.marketInbox({ limit: 300 }), staleTime: 30_000 });
  const signalsQ = useQuery({ queryKey: ['follow', 'signals'], queryFn: () => api.followSignals({ limit: 300 }), staleTime: 30_000 });
  const [showEnded, setShowEnded] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<MarketSubscriptionView | null>(null);
  const [rejectTarget, setRejectTarget] = useState<MarketSubscriptionView | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [operationError, setOperationError] = useState<string | null>(null);

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['market'] }); void qc.invalidateQueries({ queryKey: ['follow'] }); };
  const done = (msg: string) => () => { setOperationError(null); refresh(); toast.success(msg); };
  const fail = (msg: string) => (err: unknown) => { const message = friendlyError(err instanceof Error ? err.message : String(err)); setOperationError(message); refresh(); toast.error(msg, { description: message }); };

  const patch = useMutation({
    mutationFn: (a: { jobId: string; body: Parameters<typeof api.marketPatchSubscription>[1] }) => api.marketPatchSubscription(a.jobId, a.body),
    onSuccess: done(t('已保存')),
    onError: fail(t('保存失败')),
  });
  const cancel = useMutation({
    retry: false,
    mutationFn: (jobId: string) => marketSubscriptionAction(jobId, 'cancel'),
    onSuccess: () => {
      done(t('已提交'))();
      setCancelTarget(null);
    },
    onError: fail(t('操作失败')),
  });
  const reject = useMutation({
    retry: false,
    mutationFn: (a: { jobId: string; reason: string }) => marketSubscriptionAction(a.jobId, 'reject', a.reason),
    onSuccess: () => {
      done(t('已提交拒收,服务方一天内回应'))();
      setRejectTarget(null);
      setRejectReason('');
    },
    onError: fail(t('操作失败')),
  });
  const autorenew = useMutation({
    retry: false,
    mutationFn: (jobId: string) => marketSubscriptionAction(jobId, 'autorenew'),
    onSuccess: done(t('自动续费已开')),
    onError: fail(t('操作失败')),
  });
  const busy = patch.isPending || cancel.isPending || reject.isPending || autorenew.isPending;
  const subs = q.data?.subscriptions ?? [];
  const inUse = subs.filter((s) => s.display.group === 'active' || s.display.group === 'trial' || s.display.group === 'cancelled_trial').length;

  const latestByJob = useMemo(() => {
    const m = new Map<string, FeedItem>();
    const feed = buildSignalFeed(ledgerQ.data?.rows ?? [], signalsQ.data?.signals ?? []);
    // 误推进来的、不属于该服务类型的历史消息不当「最近收到」(同「信号」栏默认收起的口径)
    const offType = offTypeFeedKeys(feed, new Map(subs.map((s) => [s.job_id, s])));
    for (const f of feed) {
      if (f.kind === 'system' || !f.job_id || m.has(f.job_id) || offType.has(f.key)) continue;
      m.set(f.job_id, f);
    }
    return m;
  }, [ledgerQ.data, signalsQ.data, subs]);

  const grouped = SUB_GROUP_ORDER.map((g) => [g, subs.filter((s) => s.display.group === g)] as const).filter(([, list]) => list.length > 0);

  const card = (sub: MarketSubscriptionView) => (
    <SubscriptionCard
      key={sub.job_id}
      sub={sub}
      now={now}
      latest={latestByJob.get(sub.job_id) ?? null}
      busy={busy}
      onPatch={(body) => patch.mutate({ jobId: sub.job_id, body })}
      onCancel={() => { setOperationError(null); setCancelTarget(sub); }}
      onReject={() => { setOperationError(null); setRejectTarget(sub); }}
      onAutorenew={() => autorenew.mutate(sub.job_id)}
      onShowSignals={() => onShowSignals(sub.job_id)}
    />
  );
  const groupHeader = (g: MarketSubscriptionGroup, n: number) => (
    <h3 className="flex items-center gap-2 text-[11.5px] font-semibold text-foreground/85">
      <span className={cn('size-2 rounded-full', g === 'active' ? 'bg-up' : g === 'trial' ? 'bg-primary' : g === 'pending' ? 'bg-warn' : 'bg-muted-foreground/40')} />
      {SUB_GROUP_TITLE[g]}
      <span className="font-normal text-muted-foreground">{n}</span>
    </h3>
  );

  return (
    <Pane title={t('我的订阅')} hint={subs.length ? t('{a} 个在用 · 共 {n} 个', { a: inUse, n: subs.length }) : undefined} className="min-h-0 flex-1" contentClassName="flex min-h-0 flex-col">
      <CacheNote cache={q.data?.cache} asOf={pickSnapshotAsOf(q.data)} />
      {operationError ? <p role="alert" className="whitespace-pre-wrap break-words p-3 text-[12px] text-down">{operationError}</p> : null}
      {q.isLoading ? (
        <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-44 w-full" />
          <Skeleton className="h-44 w-full" />
        </div>
      ) : q.isError ? (
        <ErrorNote err={q.error} />
      ) : q.data?.cache?.fetched_at === null ? null : subs.length === 0 ? (
        <div className="flex flex-col items-center gap-2 p-6 text-center">
          {q.data?.error ? <p className="text-[11.5px] text-warn">{friendlyError(q.data.error)}</p> : null}
          <p className="text-[12.5px] font-medium">{t('你还没有订阅任何服务')}</p>
          <p className="max-w-md text-[11.5px] text-muted-foreground">{t('去「市场」挑一个信号或情报服务,多数可以先免费试用;订阅后收到的内容会出现在「信号」栏。')}</p>
          {onGoMarket ? (
            <Button size="xs" variant="outline" onClick={onGoMarket}>
              {t('去市场看看')}
            </Button>
          ) : null}
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          {q.data?.error ? <div className="border-b bg-warn/10 px-3 py-1 text-[10.5px] text-warn">{friendlyError(q.data.error)}</div> : null}
          <div className="flex flex-col gap-4 p-3">
            {grouped.map(([g, list]) =>
              g === 'ended' ? (
                <section key={g} className="flex flex-col gap-2">
                  <button className="flex items-center gap-1 self-start" aria-expanded={showEnded} onClick={() => setShowEnded((v) => !v)}>
                    {showEnded ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
                    {groupHeader(g, list.length)}
                  </button>
                  {showEnded ? <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">{list.map(card)}</div> : null}
                </section>
              ) : (
                <section key={g} className="flex flex-col gap-2">
                  {groupHeader(g, list.length)}
                  {g === 'pending' ? <p className="text-[10.5px] text-muted-foreground">{t('已下单,等服务方确认;确认后开始收内容。')}</p> : null}
                  {g === 'cancelled_trial' ? <p className="text-[10.5px] text-muted-foreground">{t('试用到期后不会扣费,在此之前照常收内容。')}</p> : null}
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">{list.map(card)}</div>
                </section>
              ),
            )}
          </div>
        </ScrollArea>
      )}

      <ConfirmDialog
        open={cancelTarget !== null}
        title={cancelTarget?.trial_type === 1 ? t('取消试用到期后的自动转付费?') : t('取消订阅?')}
        summary={t('会在 OKX 上生效')}
        danger
        busy={cancel.isPending}
        onCancel={() => !cancel.isPending && setCancelTarget(null)}
        onConfirm={() => cancelTarget && !cancel.isPending && cancel.mutate(cancelTarget.job_id)}
      >
        {operationError ? <p role="alert" className="whitespace-pre-wrap text-down">{operationError}</p> : null}
        {cancelTarget ? (
          <p>
            {cancelTarget.trial_type === 1
              ? t('只是取消试用到期后的自动扣费:试用照常到 {end},期间照常收内容,之后不会扣款。', { end: cancelTarget.trial_end_time ? fmtDateTime(cancelTarget.trial_end_time) : '—' })
              : t('取消 = 关掉自动续费,本期到 {end} 为止仍然有效。', { end: cancelTarget.sub_end_time ? fmtDateTime(cancelTarget.sub_end_time) : '—' })}
          </p>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={rejectTarget !== null}
        title={t('拒收本期内容?')}
        summary={t('会进入 OKX 的争议流程')}
        danger
        busy={reject.isPending}
        onCancel={() => !reject.isPending && setRejectTarget(null)}
        onConfirm={() => { if (!rejectReason.trim()) { setOperationError(t('拒收必须填写理由')); return; } if (rejectTarget && !reject.isPending) reject.mutate({ jobId: rejectTarget.job_id, reason: rejectReason.trim() }); }}
      >
        {operationError ? <p role="alert" className="whitespace-pre-wrap text-down">{operationError}</p> : null}
        <p>{t('拒收后服务方有约一天时间选择同意退款或提出争议;争议由评审员投票决定。请写清楚理由。')}</p>
        <Textarea maxLength={2000} disabled={reject.isPending} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder={t('理由(必填)')} className="text-[12px]" rows={3} />
      </ConfirmDialog>
    </Pane>
  );
}
