/**
 * 主流币表:信息员 market_state.majors 的最新价 / 24h% / 资金费率 / OI 1h% /
 * 多空账户比 / 主动买卖比。数值列右对齐,涨跌用项目语义色(up/down)。
 */
import type { MarketState } from '@/api/types';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { t } from '@/lib/i18n';
import { fmtPct, fmtPrice, pnlText } from '@/lib/format';
import { cn } from '@/lib/utils';

type Major = MarketState['majors'][number];

function toNum(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 契约里 funding_rate="0.0100" 代表 1%(和 change_24h_pct 的刻度不一样),先 *100 再走 fmtPct。 */
function fmtFunding(v: string | null): string {
  const n = toNum(v);
  return n === null ? '—' : fmtPct(n * 100, 4);
}

/** 多空账户比 / 主动买卖比:纯比值,不是百分比,>1 偏多用 up 色,<1 偏空用 down 色。 */
function fmtRatio(v: string | null): { text: string; tone: string } {
  const n = toNum(v);
  if (n === null) return { text: '—', tone: 'text-muted-foreground' };
  return { text: n.toFixed(2), tone: n > 1 ? 'text-up' : n < 1 ? 'text-down' : 'text-muted-foreground' };
}

export function MajorsTable({ majors }: { majors: Major[] }) {
  if (majors.length === 0) {
    return <div className="py-6 text-center text-[11.5px] text-muted-foreground">{t('没有主流币数据。')}</div>;
  }
  return (
    <Table className="table-dense text-[11.5px]">
      <TableHeader>
        <TableRow>
          <TableHead>{t('币种')}</TableHead>
          <TableHead className="text-right">{t('最新价')}</TableHead>
          <TableHead className="text-right">24h%</TableHead>
          <TableHead className="text-right">{t('资金费率')}</TableHead>
          <TableHead className="text-right">OI 1h%</TableHead>
          <TableHead className="text-right">{t('多空账户比')}</TableHead>
          <TableHead className="text-right">{t('主动买卖比')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {majors.map((m) => {
          const ls = fmtRatio(m.long_short_ratio);
          const tb = fmtRatio(m.taker_buy_sell_ratio);
          return (
            <TableRow key={m.symbol}>
              <TableCell className="num font-medium">{m.symbol}</TableCell>
              <TableCell className="num text-right">{fmtPrice(m.last)}</TableCell>
              <TableCell className={cn('num text-right font-medium', pnlText(m.change_24h_pct))}>{fmtPct(m.change_24h_pct)}</TableCell>
              <TableCell className={cn('num text-right', pnlText(m.funding_rate))}>{fmtFunding(m.funding_rate)}</TableCell>
              <TableCell className={cn('num text-right', m.oi_change_1h_pct !== null ? pnlText(m.oi_change_1h_pct) : 'text-muted-foreground')}>
                {m.oi_change_1h_pct !== null ? fmtPct(m.oi_change_1h_pct) : '—'}
              </TableCell>
              <TableCell className={cn('num text-right', ls.tone)}>{ls.text}</TableCell>
              <TableCell className={cn('num text-right', tb.tone)}>{tb.text}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
