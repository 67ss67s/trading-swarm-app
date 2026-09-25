/**
 * 「订阅」栏:`my-subscriptions --role buyer` ∪ 本地模式配置 ∪ 本地战绩(设计 §2.4)。
 */
import { useState } from 'react';
import type { MarketScorecard } from '@/api/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { marketSubscriptionAction } from '@/api/market-adapt';
import type { FollowApproval, FollowMode, MarketSubscriptionView } from '@/api/types';
import { FOLLOW_MODES, FOLLOW_MODE_LABEL } from '@/api/types';
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
import { t } from '@/lib/i18n';
import { EmptyNote, ErrorNote, MODE_HINT, ModeBadge, SUB_STATUS_LABEL, fmtR, fmtRate, shortId, subStatusClass } from './shared';

/** 事后回测一行:胜率 / 平均 R / 盈亏比 / 计划盈亏比(样本数)。没有 order 信号就不查。 */
function ScorecardRow({ jobId, orders }: { jobId: string; orders: number }) {
  const q = useQuery<MarketScorecard>({ queryKey: ['market', 'scorecard', jobId], queryFn: () => api.marketScorecard(jobId), enabled: orders > 0, staleTime: 10 * 60_000 });
  const qc = useQueryClient();
  const refresh = useMutation({ mutationFn: () => api.marketScorecard(jobId, true), onSuccess: (d) => qc.setQueryData(['market', 'scorecard', jobId], d) });
  const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(0)}%`);
  const num = (v: number | null, d = 2) => (v === null ? '—' : v.toFixed(d));
  const sc = q.data;
  return (
    <div className="grid grid-cols-3 gap-x-3 gap-y-0.5 border-t pt-2 text-[11px] text-muted-foreground">
      <span className="col-span-3 flex items-center gap-1.5">
        {t('信号回测')}
        <span className="text-[10px]">{orders === 0 ? t('还没有 order 信号') : sc ? t('{n} 条可评 / 共 {m}', { n: sc.n_scored, m: sc.n_signals }) : q.isLoading ? t('计算中…') : q.error ? t('回测失败') : ''}</span>
        {orders > 0 ? (
          <button className="ml-auto text-[10px] underline-offset-2 hover:underline" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
            {refresh.isPending ? t('重算中…') : t('重算')}
          </button>
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
          <span className="col-span-3">
            {t('计划盈亏比')} <span className="num text-foreground">{num(sc.avg_rr_planned)}</span>
            <span className="ml-2">{t('累计 R')} <span className={cn('num', sc.sum_r === null ? 'text-foreground' : sc.sum_r >= 0 ? 'text-up' : 'text-down')}>{num(sc.sum_r)}</span></span>
            <span className="ml-2">{t('持仓中')} <span className="num text-foreground">{sc.outcomes.filter((o) => o.status === 'open').length}</span></span>
          </span>
        </>
      ) : null}
    </div>
  );
}
function SubscriptionCard({
  sub,
  now,
  onPatch,
  onCancel,
  onReject,
  onAutorenew,
  onShowSignals,
  busy,
}: {
  sub: MarketSubscriptionView;
  now: number;
  onPatch: (body: Parameters<typeof api.marketPatchSubscription>[1]) => void;
  onCancel: () => void;
  onReject: () => void;
  onAutorenew: () => void;
  onShowSignals: () => void;
  busy: boolean;
}) {
  const [draftMode, setDraftMode] = useState<FollowMode>(sub.config.mode);
  const [draftWeight, setDraftWeight] = useState(String(sub.config.weight));
  const [draftApproval, setDraftApproval] = useState<FollowApproval>(sub.config.approval);
  const dirty = draftMode !== sub.config.mode || Number(draftWeight) !== sub.config.weight || draftApproval !== sub.config.approval;
  const active = sub.status_name === 'ACTIVE';
  const trial = sub.trial_type === 1;
  const endAt = trial ? sub.trial_end_time : sub.sub_end_time;
  return (
    <div className={cn('flex flex-col gap-2 rounded-md border bg-card p-3', !active && 'opacity-80')}>
      <div className="flex items-start justify-between gap-2">
        {sub.asp_avatar ? <img alt="" src={sub.asp_avatar} className="size-10 shrink-0 rounded-md border object-cover" loading="lazy" /> : <div className="size-10 shrink-0 rounded-md border bg-muted" />}
        <div className="min-w-0 flex-1">
          <button className="block max-w-full truncate text-left text-[13px] font-semibold hover:underline" title={sub.title} onClick={onShowSignals}>
            {sub.provider_name || sub.service_name || sub.title}
          </button>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10.5px] text-muted-foreground">
            <span className="truncate" title={sub.title}>{sub.asp_service_name || sub.title.replace(/^(trading-swarm|tg) · /, '')}</span>
            {sub.provider_agent_id ? <span className="num">#{sub.provider_agent_id}</span> : null}
            <span className="num" title={sub.job_id}>
              job {shortId(sub.job_id, 6, 4)}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge variant="outline" className={cn('text-[10px]', subStatusClass(sub.status_name))}>
            {trial && sub.status_name === 'CLOSED' ? t('已取消转付费') : trial && active ? t('试用中') : (SUB_STATUS_LABEL[sub.status_name] ?? sub.status_name)}
          </Badge>
          <ModeBadge mode={sub.config.mode} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>
          {t('当前期')} <span className="num text-foreground">{sub.period_index ?? '—'}</span>
        </span>
        <span title={endAt ? fmtDateTime(endAt) : ''}>
          {t('到期')} <span className="text-foreground">{endAt ? relativeTime(endAt, now) : '—'}</span>
        </span>
        <span>
          {t('费用')} <span className="num text-foreground">{sub.fee_amount ? `${sub.fee_amount} USDT/${t('月')}` : '—'}</span>
        </span>
        <span>
          {t('自动续费')} <span className="text-foreground">{sub.auto_renew ? t('开') : t('关')}</span>
        </span>
        <span>
          {t('最近投递')} <span className="text-foreground">{sub.last_delivery_at ? relativeTime(sub.last_delivery_at, now) : t('还没有')}</span>
        </span>
        <label className="flex items-center gap-1.5">
          <Switch className="scale-75" checked={sub.this_device_receives} disabled={busy || !active} onCheckedChange={(v) => onPatch({ this_device_receives: v })} />
          <span className={sub.this_device_receives ? 'text-foreground' : 'text-warn'}>{sub.this_device_receives ? t('本机接收') : t('本机不接收')}</span>
        </label>
      </div>

      <div className="flex items-center gap-2 border-t pt-2">
        <Switch className="scale-90" checked={sub.config.enabled} disabled={busy} onCheckedChange={(v) => onPatch({ enabled: v })} />
        <Select value={draftMode} onValueChange={(v) => setDraftMode(v as FollowMode)}>
          <SelectTrigger className="h-7 flex-1 text-[11.5px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FOLLOW_MODES.map((m) => (
              <SelectItem key={m} value={m} className="text-[12px]">
                {FOLLOW_MODE_LABEL[m]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input value={draftWeight} onChange={(e) => setDraftWeight(e.target.value)} type="number" min={0} max={1} step={0.05} className="h-7 w-20 text-[11.5px]" />
        {dirty ? (
          <Button size="xs" disabled={busy} onClick={() => onPatch({ mode: draftMode, approval: draftApproval, weight: Math.max(0, Math.min(1, Number(draftWeight) || 0)) })}>
            {t('保存')}
          </Button>
        ) : null}
      </div>
      <p className={cn('text-[10.5px]', draftMode === 'book' ? 'text-warn' : 'text-muted-foreground')}>{MODE_HINT[draftMode]}</p>
      {draftMode === 'book' ? (
        <div className="flex items-center gap-2 text-[11px]">
          <span className="shrink-0 text-muted-foreground">{t('过闸后')}</span>
          <Select value={draftApproval} onValueChange={(v) => setDraftApproval(v as FollowApproval)}>
            <SelectTrigger className="h-7 flex-1 text-[11.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="manual" className="text-[12px]">
                {t('生成待批意图,交易页点确认')}
              </SelectItem>
              <SelectItem value="auto" className="text-[12px]">
                {t('直接交执行(自动下单)')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="grid grid-cols-3 gap-x-3 gap-y-0.5 border-t pt-2 text-[11px] text-muted-foreground">
        <span>
          {t('收到')} <span className="num text-foreground">{sub.stats.received}</span>
        </span>
        <span>
          order <span className="num text-foreground">{sub.stats.orders}</span>
        </span>
        <span>
          analysis <span className="num text-foreground">{sub.stats.analysis}</span>
        </span>
        <span>
          {t('已开仓')} <span className="num text-foreground">{sub.stats.applied}</span>
        </span>
        <span>
          {t('待办')} <span className="num text-foreground">{sub.stats.review_only}</span>
        </span>
        <span>
          {t('跳过')} <span className="num text-foreground">{sub.stats.skipped}</span>
        </span>
        <span>
          {t('agent 同向率')} <span className="num text-foreground">{fmtRate(sub.stats.agent_agree_rate)}</span>
        </span>
        <span className="col-span-2">
          {t('已实现 R')} <span className="num text-foreground">{fmtR(sub.stats.realized_r)}</span>
          {sub.stats.settling > 0 ? <span className="ml-1 text-[10px]">({t('{n} 笔结算中', { n: sub.stats.settling })})</span> : null}
        </span>
      </div>

      <ScorecardRow jobId={sub.job_id} orders={sub.stats.orders} />
      <div className="flex flex-wrap items-center gap-1.5 border-t pt-2">
        <Button size="xs" variant="outline" onClick={onShowSignals}>
          {t('看信号')}
        </Button>
        {active && !sub.auto_renew && !trial ? (
          <Button size="xs" variant="outline" disabled={busy} onClick={onAutorenew}>
            {t('开自动续费')}
          </Button>
        ) : null}
        {active && !trial ? (
          <Button size="xs" variant="outline" disabled={busy} onClick={onReject}>
            {t('拒收本期')}
          </Button>
        ) : null}
        {active || sub.status_name === 'CREATED' ? (
          <Button size="xs" variant="destructive" disabled={busy} onClick={onCancel} className="ml-auto">
            {trial ? t('取消转付费') : sub.auto_renew ? t('关自动续费') : t('取消')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function SubscriptionsTab({ onShowSignals }: { onShowSignals: (jobId: string) => void }) {
  const qc = useQueryClient();
  const now = useNow();
  const q = useQuery({ queryKey: ['market', 'subscriptions'], queryFn: api.marketSubscriptions, refetchInterval: 60_000 });
  const [cancelTarget, setCancelTarget] = useState<MarketSubscriptionView | null>(null);
  const [rejectTarget, setRejectTarget] = useState<MarketSubscriptionView | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [operationError, setOperationError] = useState<string | null>(null);

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['market'] }); void qc.invalidateQueries({ queryKey: ['follow'] }); };
  const done = (msg: string) => () => { setOperationError(null); refresh(); toast.success(msg); };
  const fail = (msg: string) => (err: unknown) => { const message = err instanceof Error ? err.message : String(err); setOperationError(message); refresh(); toast.error(msg, { description: message }); };

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
      done(t('已提交拒收,等 ASP 一天内回应'))();
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
  const activeCount = subs.filter((s) => s.status_name === 'ACTIVE').length;

  return (
    <Pane title={t('订阅')} hint={t('{a} 个生效 / 共 {n} 个;模式与权重只在本机生效', { a: activeCount, n: subs.length })} className="min-h-0 flex-1" contentClassName="flex min-h-0 flex-col">
      {operationError ? <p role="alert" className="whitespace-pre-wrap break-words p-3 text-[12px] text-down">{operationError}</p> : null}
      {q.isLoading ? (
        <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      ) : q.isError ? (
        <ErrorNote err={q.error} />
      ) : subs.length === 0 ? (
        <EmptyNote>{q.data?.error ?? t('还没有订阅;去「市场」栏挑一个,或者先试用。')}</EmptyNote>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          {q.data?.error ? <div className="border-b bg-warn/10 px-3 py-1 text-[10.5px] text-warn">{q.data.error}</div> : null}
          <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3">
            {subs.map((sub) => (
              <SubscriptionCard
                key={sub.job_id}
                sub={sub}
                now={now}
                busy={busy}
                onPatch={(body) => patch.mutate({ jobId: sub.job_id, body })}
                onCancel={() => { setOperationError(null); setCancelTarget(sub); }}
                onReject={() => { setOperationError(null); setRejectTarget(sub); }}
                onAutorenew={() => autorenew.mutate(sub.job_id)}
                onShowSignals={() => onShowSignals(sub.job_id)}
              />
            ))}
          </div>
        </ScrollArea>
      )}

      <ConfirmDialog
        open={cancelTarget !== null}
        title={cancelTarget?.trial_type === 1 ? t('取消到期自动转付费?') : t('取消订阅?')}
        summary={t('OKX 侧的订阅动作')}
        danger
        busy={cancel.isPending}
        onCancel={() => !cancel.isPending && setCancelTarget(null)}
        onConfirm={() => cancelTarget && !cancel.isPending && cancel.mutate(cancelTarget.job_id)}
      >
        {operationError ? <p role="alert" className="whitespace-pre-wrap text-down">{operationError}</p> : null}
        {cancelTarget ? (
          <p>
            {cancelTarget.trial_type === 1
              ? t('试用期内取消 = 只取消到期自动扣款转付费;试用照常到 {end},期间信号继续投递,之后不会扣款。', { end: cancelTarget.trial_end_time ? fmtDateTime(cancelTarget.trial_end_time) : '—' })
              : t('付费订阅取消 = 关掉自动续费,本期到 {end} 为止仍然有效。', { end: cancelTarget.sub_end_time ? fmtDateTime(cancelTarget.sub_end_time) : '—' })}
          </p>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={rejectTarget !== null}
        title={t('拒收本期投递?')}
        summary={t('进 OKX 争议流程')}
        danger
        busy={reject.isPending}
        onCancel={() => !reject.isPending && setRejectTarget(null)}
        onConfirm={() => { if (!rejectReason.trim()) { setOperationError(t('拒收必须填写理由')); return; } if (rejectTarget && !reject.isPending) reject.mutate({ jobId: rejectTarget.job_id, reason: rejectReason.trim() }); }}
      >
        {operationError ? <p role="alert" className="whitespace-pre-wrap text-down">{operationError}</p> : null}
        <p>{t('拒收后 ASP 有约一天时间选择同意退款或提争议;争议由评审员投票。写清楚理由。')}</p>
        <Textarea maxLength={2000} disabled={reject.isPending} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder={t('理由(必填)')} className="text-[12px]" rows={3} />
      </ConfirmDialog>
    </Pane>
  );
}
