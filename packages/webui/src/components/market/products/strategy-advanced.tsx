/**
 * 「策略信号」卡展开区的高级部分:自动推送设置 + 推送记录(原首屏的发布器与投递账本,折到这里)。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { MarketAsp, MarketDeliveryOut, MarketPublisherSettings } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { JudgeLock } from '@/components/judge-lock';
import { friendlyMarketError } from '@/components/market/judge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { EmptyNote, ErrorNote, shortId } from '../shared';
import { PRODUCTS_KEY, errText } from './labels';

const SIGNAL_TYPE_LABEL = (v: string) => (v === 'order' ? t('真实交易') : v === 'analysis' ? t('观点') : v);

function SettingRow({ label, hint, checked, disabled, onChange }: { label: string; hint?: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 text-[11.5px]">
      <span className="min-w-0">
        {label}
        {hint ? <span className="ml-1 text-[10.5px] text-muted-foreground">{hint}</span> : null}
      </span>
      <JudgeLock feature="asp_settings">
        <Switch className="scale-90" checked={checked} disabled={disabled} onCheckedChange={onChange} />
      </JudgeLock>
    </label>
  );
}

export function PublisherSettings({ value, onSave, saving }: { value: MarketPublisherSettings; onSave: (v: MarketPublisherSettings) => void; saving: boolean }) {
  const [symbols, setSymbols] = useState(value.symbols.join(', '));
  const commitSymbols = () => {
    const list = symbols
      .split(/[,\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (list.join(',') !== value.symbols.join(',')) onSave({ ...value, symbols: list });
  };
  const row = (label: string, k: keyof MarketPublisherSettings, hint?: string) => (
    <SettingRow label={label} hint={hint} checked={Boolean(value[k])} disabled={saving} onChange={(v) => onSave({ ...value, [k]: v })} />
  );
  return (
    <div className="flex flex-col gap-2">
      {row(t('自动推送总开关'), 'enabled', value.enabled ? t('开着:每条新动态推给全部有效订阅者') : t('关着:不推送,记录照常保留'))}
      {row(t('推送真实交易(开仓 / 平仓 / 减仓)'), 'publish_orders')}
      {row(t('推送观点(有方向判断但没开仓)'), 'publish_analysis')}
      {row(t('模拟盘的交易可作为观点推送'), 'allow_paper_analysis', t('始终标注为模拟,不会当成真实交易'))}
      {row(t('平仓时附上真实盈亏'), 'include_realized_pnl')}
      <div className="flex flex-col gap-1 text-[11.5px] sm:flex-row sm:items-center sm:gap-2">
        <span className="shrink-0">{t('只推这些币')}</span>
        <JudgeLock feature="asp_settings" className="flex-1">
          <Input value={symbols} onChange={(e) => setSymbols(e.target.value)} onBlur={commitSymbols} placeholder={t('空 = 全部;逗号分开,如 BTCUSDT, ETHUSDT')} className="h-7 text-[11.5px]" />
        </JudgeLock>
      </div>
      <p className="text-[10.5px] text-muted-foreground">{t('永远不推:买来的别家信号、模拟盘的交易单、含「保证 / 稳赚」类字眼的内容。推送失败不会自动重试,可在下面的推送记录里逐个重发。')}</p>
    </div>
  );
}

function DeliveryRow({ d, now, onRetry, retrying }: { d: MarketDeliveryOut; now: number; onRetry: (jobId?: string) => void; retrying: boolean }) {
  const [open, setOpen] = useState(false);
  const delivered = d.jobs.filter((j) => j.status === 'delivered').length;
  const failed = d.jobs.filter((j) => j.status === 'failed').length;
  const pending = d.jobs.filter((j) => j.status === 'pending').length;
  return (
    <div className="border-b py-2 text-[11.5px] last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground" title={fmtDateTime(d.created_at)}>
          {relativeTime(d.created_at, now)}
        </span>
        <Badge variant="outline" className={cn('text-[10px]', d.signal_type === 'order' ? 'border-primary/40 text-primary' : 'text-muted-foreground')}>
          {SIGNAL_TYPE_LABEL(d.signal_type)}
        </Badge>
        <span className="num font-medium">{d.symbol}</span>
        <span className="text-muted-foreground">{d.action}</span>
        {d.blocked_reason ? (
          <Badge variant="outline" className="border-destructive/40 text-[10px] text-destructive" title={d.blocked_reason}>
            {t('已拦下')}
          </Badge>
        ) : (
          <span className="text-muted-foreground">
            <span className="num text-up">{delivered}</span> {t('成功')}
            {failed ? (
              <>
                {' '}
                · <span className="num text-down">{failed}</span> {t('失败')}
              </>
            ) : null}
            {pending ? (
              <>
                {' '}
                · <span className="num">{pending}</span> {t('待发')}
              </>
            ) : null}
            {d.jobs.length === 0 ? <span> · {t('当时没有订阅者')}</span> : null}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {failed ? (
            <JudgeLock feature="asp_publish">
              <Button size="xs" variant="outline" disabled={retrying} onClick={() => onRetry()}>
                {t('重发失败的')}
              </Button>
            </JudgeLock>
          ) : null}
          <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => setOpen((v) => !v)}>
            {open ? t('收起') : t('展开')}
          </button>
        </div>
      </div>
      {d.blocked_reason ? <p className="mt-1 text-[10.5px] text-destructive">{friendlyMarketError(d.blocked_reason)}</p> : null}
      {open ? (
        <div className="mt-2 flex flex-col gap-2">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border bg-muted/30 p-2 text-[10.5px]">{d.text}</pre>
          {d.jobs.map((j) => (
            <div key={j.job_id} className="flex flex-wrap items-center gap-2 text-[10.5px]">
              {j.buyer_agent_id ? <span className="num">#{j.buyer_agent_id}</span> : null}
              <span className="num text-muted-foreground" title={j.job_id}>
                {t('订阅')} {shortId(j.job_id, 6, 4)}
              </span>
              <Badge variant="outline" className={cn('text-[10px]', j.status === 'delivered' ? 'text-up' : j.status === 'failed' ? 'text-down' : 'text-muted-foreground')}>
                {j.status === 'delivered' ? t('已送达') : j.status === 'failed' ? t('失败') : t('待发')}
              </Badge>
              {j.attempt > 1 ? <span className="text-muted-foreground">{t('第 {n} 次', { n: j.attempt })}</span> : null}
              {j.error ? <span className="truncate text-down">{friendlyMarketError(j.error)}</span> : null}
              {j.status === 'failed' ? (
                <JudgeLock feature="asp_publish">
                  <Button size="xs" variant="ghost" disabled={retrying} onClick={() => onRetry(j.job_id)}>
                    {t('重发')}
                  </Button>
                </JudgeLock>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DeliveryLedger({ now }: { now: number }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['market', 'asp', 'deliveries'], queryFn: () => api.marketAspDeliveries(100), refetchInterval: 30_000 });
  const retry = useMutation({
    mutationFn: (a: { eventId: string; jobId?: string }) => api.marketAspRetryDelivery(a.eventId, a.jobId),
    retry: false,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['market', 'asp', 'deliveries'] });
      void qc.invalidateQueries({ queryKey: PRODUCTS_KEY });
      toast.success(t('已重发'));
    },
    onError: (err) => toast.error(t('重发失败'), { description: errText(err) }),
  });
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 pb-1">
        <span className="text-[11px] font-medium">{t('推送记录')}</span>
        <span className="text-[10.5px] text-muted-foreground">{t('每条动态一行,展开看每个订阅者是否收到')}</span>
        <Button size="icon-xs" variant="ghost" className="ml-auto" onClick={() => void q.refetch()} disabled={q.isFetching} aria-label={t('刷新')}>
          <RefreshCw className={cn(q.isFetching && 'animate-spin')} />
        </Button>
      </div>
      {q.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-full" />
        </div>
      ) : q.isError ? (
        <ErrorNote err={q.error} />
      ) : (q.data?.deliveries.length ?? 0) === 0 ? (
        <EmptyNote>{t('还没有推送记录;自动推送开着时,每条新动态会出现在这里。')}</EmptyNote>
      ) : (
        <div className="max-h-80 overflow-y-auto">
          {q.data!.deliveries.map((d) => (
            <DeliveryRow key={d.event_id} d={d} now={now} retrying={retry.isPending} onRetry={(jobId) => retry.mutate({ eventId: d.event_id, jobId })} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 高级:默认折叠,展开才拉推送记录。 */
export function StrategyAdvanced({ asp, now }: { asp: MarketAsp | null; now: number }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const save = useMutation({
    mutationFn: (publisher: MarketPublisherSettings) => api.setMarketSettings({ publisher }),
    retry: false,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['market', 'asp'] });
      void qc.invalidateQueries({ queryKey: ['market', 'status'] });
      toast.success(t('已保存'));
    },
    onError: (err) => toast.error(t('保存失败'), { description: errText(err) }),
  });
  const tr = asp?.track_record;
  return (
    <div className="flex flex-col gap-2 border-t pt-2">
      <button type="button" className="flex items-center gap-1 text-left text-[11.5px] font-medium text-muted-foreground hover:text-foreground" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {t('高级:推送设置与推送记录')}
      </button>
      {open ? (
        <div className="flex flex-col gap-3 pl-1">
          {tr ? (
            <p className="text-[11px] text-muted-foreground">
              {t('公开战绩')}:{t('开仓 {o} · 平仓 {c} · 盈利 {w}', { o: tr.orders, c: tr.closes, w: tr.wins })} · {t('累计')}{' '}
              <span className="num text-foreground">{tr.realized_r_sum === null ? '—' : `${tr.realized_r_sum >= 0 ? '+' : ''}${tr.realized_r_sum.toFixed(2)}R`}</span>
            </p>
          ) : null}
          {asp ? <PublisherSettings value={asp.publisher} onSave={(v) => save.mutate(v)} saving={save.isPending} /> : <Skeleton className="h-24 w-full" />}
          <DeliveryLedger now={now} />
        </div>
      ) : null}
    </div>
  );
}
