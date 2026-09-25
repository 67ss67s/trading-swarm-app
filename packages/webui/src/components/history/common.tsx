/**
 * 复盘页三块共用的小件:观察标记、均值旁的中位数 / 截尾均值、区块说明条。
 */
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { OBSERVE_MIN, isObservation, type CenterStats } from './ledger-stats';
import { rText, rTone } from './ledger-rows';

/** 样本 < 30:只看方向,不下结论。 */
export function ObserveBadge({ n, unit }: { n: number; unit?: string }) {
  if (!isObservation(n)) return null;
  return (
    <Badge variant="outline" className="h-4 border-warn/30 bg-warn/10 px-1 text-[9.5px] text-warn" title={t('样本 {n}{unit} < {m}:只看方向,不下结论', { n, unit: unit ?? '', m: OBSERVE_MIN })}>
      {t('观察')}
    </Badge>
  );
}

function basis(c: CenterStats, unit: string): string {
  return c.trimmed_each_side > 0
    ? t('两端各截 {k} {unit}({n} {unit} × 10% 向下取整)', { k: c.trimmed_each_side, n: c.n, unit })
    : t('{unit}数 {n} < 10,不截尾,截尾均值 = 均值', { n: c.n, unit });
}

/**
 * 均值(可由后端给,优先)+ 旁边的中位数 / 截尾均值(前端从逐行算)。
 * center 为 null = 逐行数据没取到,只显示均值并注明。
 */
export function MeanWithCenter({ mean, center, unit, className }: { mean: number | null | undefined; center: CenterStats | null; unit: string; className?: string }) {
  const m = mean ?? center?.mean ?? null;
  return (
    <span className={cn('num inline-flex flex-col items-end leading-tight', className)}>
      <span className={cn('font-semibold', rTone(m))}>{rText(m)}</span>
      {center ? (
        center.n ? (
          <span className="text-[9.5px] font-normal text-muted-foreground" title={basis(center, unit)}>
            {t('中位')} {rText(center.median)} · {t('截尾')} {rText(center.trimmed_mean)}
          </span>
        ) : null
      ) : (
        <span className="text-[9.5px] font-normal text-muted-foreground" title={t('逐行数据没取到,中位数和截尾均值算不了')}>
          {t('仅均值')}
        </span>
      )}
    </span>
  );
}

export function NoteStrip({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'warn' }) {
  return <div className={cn('shrink-0 border-b px-3 py-1.5 text-[10.5px] leading-relaxed', tone === 'warn' ? 'bg-warn/10 text-warn' : 'bg-muted/30 text-muted-foreground')}>{children}</div>;
}
