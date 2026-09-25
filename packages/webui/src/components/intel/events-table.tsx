/**
 * 历史 tab · 原始事件:GET /api/info/events 的 kind / source / title / 时间。
 */
import type { InformationEvent } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { fmtDateTime, relativeTime, useNow } from '@/lib/format';
import { t, tmap } from '@/lib/i18n';

const KIND_LABEL: Record<InformationEvent['kind'], string> = tmap({
  news: '新闻',
  market_snapshot: '行情快照',
  sentiment: '情绪',
});

export function EventsTable({ events }: { events: InformationEvent[] }) {
  const now = useNow();
  if (events.length === 0) {
    return <div className="py-6 text-center text-[11.5px] text-muted-foreground">{t('还没有原始事件。')}</div>;
  }
  return (
    <Table className="table-dense text-[11.5px]">
      <TableHeader>
        <TableRow>
          <TableHead>{t('类型')}</TableHead>
          <TableHead>{t('来源')}</TableHead>
          <TableHead>{t('标题')}</TableHead>
          <TableHead>{t('资产')}</TableHead>
          <TableHead className="text-right">{t('时间')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((e) => (
          <TableRow key={e.id}>
            <TableCell>
              <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                {KIND_LABEL[e.kind] ?? e.kind}
              </Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">{e.source}</TableCell>
            <TableCell className="max-w-[320px] truncate" title={e.title || e.digest}>
              {e.title || e.digest || '—'}
            </TableCell>
            <TableCell className="num text-muted-foreground">{e.assets.length ? e.assets.join(', ') : '—'}</TableCell>
            <TableCell className="num text-right whitespace-nowrap text-muted-foreground" title={fmtDateTime(e.occurred_at)}>
              {relativeTime(e.occurred_at, now)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
