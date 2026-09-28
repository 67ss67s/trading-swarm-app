/**
 * 产品卡展开区:订阅类 = 订阅者列表;按次类 = 订单列表。展开时才拉。
 */
import { useQuery } from '@tanstack/react-query';
import { aspProductsApi, type AspProduct, type OrderItem, type SubscriberItem } from '@/api/asp-products';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { EmptyNote, ErrorNote, shortId } from '../shared';
import { customersKey } from './labels';

const fmtDay = (ts: number | null) => (ts === null ? '—' : fmtDateTime(ts));

function SubscriberRow({ s, now }: { s: SubscriberItem; now: number }) {
  return (
    <div className="flex flex-col gap-0.5 border-b py-1.5 text-[11px] last:border-b-0 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="num font-medium">{s.buyer_agent_id ? `#${s.buyer_agent_id}` : t('匿名买家')}</span>
        <Badge variant="outline" className={cn('text-[10px]', s.trial ? 'border-warn/30 bg-warn/15 text-warn' : 'border-up/30 bg-up/15 text-up')}>
          {s.trial ? t('试用中') : t('付费')}
        </Badge>
        {s.status_label ? <span className="text-muted-foreground">{s.status_label}</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 text-muted-foreground sm:ml-auto">
        <span title={fmtDay(s.started_at)}>
          {t('开始')} {s.started_at === null ? '—' : relativeTime(s.started_at, now)}
        </span>
        <span title={fmtDay(s.ends_at)}>
          {t('到期')} {s.ends_at === null ? '—' : fmtDateTime(s.ends_at)}
        </span>
        <span>{t('已推送 {n} 条', { n: s.pushes })}</span>
      </div>
    </div>
  );
}

function OrderRow({ o, now }: { o: OrderItem; now: number }) {
  return (
    <div className="flex flex-col gap-1 border-b py-1.5 text-[11px] last:border-b-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="num font-medium">{o.buyer_agent_id ? `#${o.buyer_agent_id}` : t('匿名买家')}</span>
        {o.state_label ? (
          <Badge variant="outline" className="text-[10px]">
            {o.state_label}
          </Badge>
        ) : null}
        <span className="num text-[10.5px] text-muted-foreground" title={o.job_id}>
          {shortId(o.job_id, 6, 4)}
        </span>
        <span className="ml-auto text-muted-foreground" title={fmtDay(o.created_at)}>
          {t('下单')} {o.created_at === null ? '—' : relativeTime(o.created_at, now)}
          {o.delivered_at !== null ? ` · ${t('交付')} ${relativeTime(o.delivered_at, now)}` : ''}
        </span>
      </div>
      {o.request ? (
        <p className="line-clamp-2 whitespace-pre-line text-muted-foreground" title={o.request}>
          <span className="text-foreground/70">{t('需求')}:</span>
          {o.request}
        </p>
      ) : null}
      {o.summary ? (
        <p className="line-clamp-2 whitespace-pre-line text-muted-foreground" title={o.summary}>
          <span className="text-foreground/70">{t('交付')}:</span>
          {o.summary}
        </p>
      ) : null}
    </div>
  );
}

export function CustomersList({ product, now }: { product: AspProduct; now: number }) {
  const q = useQuery({ queryKey: customersKey(product.key), queryFn: () => aspProductsApi.customers(product.key, product.kind), refetchInterval: 60_000 });
  const sub = product.kind === 'subscription';
  return (
    <div className="flex flex-col">
      <div className="pb-1 text-[11px] font-medium">{sub ? t('订阅者') : t('订单')}</div>
      {q.isLoading ? (
        <div className="space-y-1.5">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </div>
      ) : q.isError ? (
        <ErrorNote err={q.error} />
      ) : !q.data || q.data.items.length === 0 ? (
        <EmptyNote>{sub ? t('还没有订阅者。上架并通过审核后,买家订阅会出现在这里。') : t('还没有订单。买家下单后会出现在这里。')}</EmptyNote>
      ) : (
        <div className="max-h-72 overflow-y-auto">
          {q.data.kind === 'subscription'
            ? q.data.items.map((s, i) => <SubscriberRow key={s.job_id || i} s={s} now={now} />)
            : q.data.items.map((o, i) => <OrderRow key={o.job_id || i} o={o} now={now} />)}
        </div>
      )}
    </div>
  );
}
