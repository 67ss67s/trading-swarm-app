/**
 * 「我的产品」单张卡:名称 / 类型 / 价格 / 试用 / 状态 + 关键指标 + 最近交付,四个操作;展开看订阅者或订单。
 * 策略信号卡的展开区另外挂「高级:推送设置与推送记录」。
 */
import type { ReactNode } from 'react';
import { ChevronDown, ChevronUp, Eye, Pause, Pencil, Play, Upload } from 'lucide-react';
import type { AspProduct } from '@/api/asp-products';
import type { MarketAsp } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { JudgeLock } from '@/components/judge-lock';
import { fmtDateTime, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { CustomersList } from './customers';
import { KIND_LABEL, PRODUCT_STATUS_CLASS, PRODUCT_STATUS_LABEL, STRATEGY_KEY, fmtProductPrice, fmtTrialHours, successRate } from './labels';
import { StrategyAdvanced } from './strategy-advanced';

function Metric({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] text-muted-foreground">{label}</div>
      <div className="num text-[16px]/6 font-semibold">{value}</div>
      {sub ? <div className="text-[10.5px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

export function deliveryLine(p: AspProduct, now: number): string {
  const s = p.stats;
  if (s.last_delivery_at === null && s.deliveries_ok + s.deliveries_failed === 0) return t('还没交付过');
  const rate = successRate(s.deliveries_ok, s.deliveries_failed);
  const parts = [s.last_delivery_at === null ? t('最近交付 —') : t('最近交付 {ago}', { ago: relativeTime(s.last_delivery_at, now) })];
  if (rate !== null) parts.push(t('成功率 {p}%', { p: Math.round(rate * 100) }));
  return parts.join(' · ');
}

export interface ProductCardProps {
  product: AspProduct;
  now: number;
  expanded: boolean;
  asp: MarketAsp | null;
  busy: boolean;
  onToggle: () => void;
  onPreview: () => void;
  onPause: () => void;
  onAdjust: () => void;
}

export function ProductCard({ product: p, now, expanded, asp, busy, onToggle, onPreview, onPause, onAdjust }: ProductCardProps) {
  const sub = p.kind === 'subscription';
  const trial = fmtTrialHours(p.trial_hours);
  const onShelf = p.status !== 'not_listed';
  const failedMany = p.stats.deliveries_failed > 0 && (successRate(p.stats.deliveries_ok, p.stats.deliveries_failed) ?? 1) < 0.9;
  return (
    <article className={cn('flex min-w-0 flex-col gap-3 rounded-md border bg-card p-3', expanded && 'col-span-full', p.status === 'not_listed' && 'bg-muted/10')}>
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13px] font-semibold" title={p.name}>
            {p.name}
          </h3>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>{KIND_LABEL[p.kind]}</span>
            <span>·</span>
            <span className="num text-foreground">{fmtProductPrice(p)}</span>
            {trial ? (
              <Badge variant="outline" className="border-up/30 text-[10px] text-up">
                {trial}
              </Badge>
            ) : null}
          </div>
        </div>
        <Badge variant="outline" className={cn('shrink-0 text-[10px]', PRODUCT_STATUS_CLASS[p.status])}>
          {PRODUCT_STATUS_LABEL[p.status]}
        </Badge>
      </header>

      <div className="grid grid-cols-2 gap-2">
        {sub ? (
          <>
            <Metric label={t('活跃订阅者')} value={p.stats.active_subscribers} sub={p.stats.trial_subscribers ? t('其中试用中 {n}', { n: p.stats.trial_subscribers }) : null} />
            <Metric label={t('已付费')} value={Math.max(0, p.stats.active_subscribers - p.stats.trial_subscribers)} />
          </>
        ) : (
          <>
            <Metric label={t('近 7 天订单')} value={p.stats.orders_7d} />
            <Metric label={t('累计订单')} value={p.stats.orders_total} />
          </>
        )}
      </div>

      <p className={cn('text-[11px]', failedMany ? 'text-warn' : 'text-muted-foreground')} title={p.stats.last_delivery_at ? fmtDateTime(p.stats.last_delivery_at) : undefined}>
        {deliveryLine(p, now)}
        {p.stats.deliveries_failed > 0 ? ` · ${t('失败 {n}', { n: p.stats.deliveries_failed })}` : ''}
      </p>

      {p.status === 'paused' ? <p className="text-[10.5px] text-muted-foreground">{t('暂停中:新订单会被婉拒,已接的照常交付。')}</p> : null}
      {p.status === 'in_review' ? <p className="text-[10.5px] text-muted-foreground">{t('OKX 审核中,通过后买家才能看到最新内容。')}</p> : null}

      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        <JudgeLock feature="asp_publish">
          <Button size="xs" variant="outline" onClick={onPreview}>
            <Eye data-slot="icon" />
            {t('预览交付')}
          </Button>
        </JudgeLock>
        {onShelf ? (
          <JudgeLock feature="asp_publish">
            <Button size="xs" variant="outline" disabled={busy} onClick={onPause}>
              {p.paused ? <Play data-slot="icon" /> : <Pause data-slot="icon" />}
              {p.paused ? t('恢复接单') : t('暂停接单')}
            </Button>
          </JudgeLock>
        ) : null}
        <JudgeLock feature="asp_publish">
          <Button size="xs" variant={onShelf ? 'outline' : 'default'} onClick={onAdjust}>
            {onShelf ? <Pencil data-slot="icon" /> : <Upload data-slot="icon" />}
            {onShelf ? t('调整') : t('上架')}
          </Button>
        </JudgeLock>
        <Button size="xs" variant="ghost" className="ml-auto" onClick={onToggle} aria-expanded={expanded}>
          {expanded ? <ChevronUp data-slot="icon" /> : <ChevronDown data-slot="icon" />}
          {expanded ? t('收起') : sub ? t('订阅者') : t('订单')}
        </Button>
      </div>

      {expanded ? (
        <div className="flex flex-col gap-3 border-t pt-3">
          {p.description ? <p className="line-clamp-4 whitespace-pre-line text-[11px] text-muted-foreground">{p.description}</p> : null}
          <CustomersList product={p} now={now} />
          {p.key === STRATEGY_KEY ? <StrategyAdvanced asp={asp} now={now} /> : null}
        </div>
      ) : null}
    </article>
  );
}
