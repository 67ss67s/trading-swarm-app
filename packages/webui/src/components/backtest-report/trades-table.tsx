/**
 * List of trades:可排序、按资产筛选、分页(每页 50,上千笔也不卡)。
 */
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react';
import type { BacktestReport, BacktestTrade } from '@trading-swarm/contracts';
import { Button } from '@/components/ui/button';
import { fmtPrice, fmtQty } from '@/lib/format';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { EmptyNote } from './performance';
import { ASSET_STATUS_LABEL, exitReasonLabel, pctSigned, segmentLabel, toneOf, usdSigned, ymdhm } from './format';

export const PAGE_SIZE = 50;

type SortKey = 'entry_at' | 'exit_at' | 'entry_price' | 'exit_price' | 'qty' | 'pnl' | 'return_pct' | 'bars_held' | 'exit_reason' | 'segment' | 'symbol';

interface Col {
  key: SortKey;
  label: string;
  align?: 'right';
}

function cols(): Col[] {
  return [
    { key: 'symbol', label: t('标的') },
    { key: 'entry_at', label: t('入场时间') },
    { key: 'entry_price', label: t('入场价'), align: 'right' },
    { key: 'exit_at', label: t('出场时间') },
    { key: 'exit_price', label: t('出场价'), align: 'right' },
    { key: 'qty', label: t('数量'), align: 'right' },
    { key: 'pnl', label: t('盈亏'), align: 'right' },
    { key: 'return_pct', label: t('收益率'), align: 'right' },
    { key: 'bars_held', label: t('持仓根数'), align: 'right' },
    { key: 'exit_reason', label: t('退出原因') },
    { key: 'segment', label: t('分段') },
  ];
}

export function sortTrades(trades: BacktestTrade[], key: SortKey, dir: 'asc' | 'desc'): BacktestTrade[] {
  const k = dir === 'asc' ? 1 : -1;
  return [...trades].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * k;
    return String(x).localeCompare(String(y)) * k;
  });
}

export function TradesTable({ report, assetKey, onAssetChange }: { report: BacktestReport; assetKey: string; onAssetChange: (k: string) => void }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'entry_at', dir: 'desc' });
  const [page, setPage] = useState(0);
  const asset = report.assets.find((a) => a.key === assetKey);
  const trades = asset?.trades ?? [];
  const sorted = useMemo(() => sortTrades(trades, sort.key, sort.dir), [trades, sort]);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const cur = Math.min(page, pages - 1);
  const rows = sorted.slice(cur * PAGE_SIZE, cur * PAGE_SIZE + PAGE_SIZE);
  const toggle = (key: SortKey) => {
    setPage(0);
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'symbol' || key === 'exit_reason' || key === 'segment' ? 'asc' : 'desc' }));
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label={t('按资产筛选')}>
        {report.assets.map((a) => (
          <button
            key={a.key}
            type="button"
            role="tab"
            aria-selected={a.key === assetKey}
            onClick={() => {
              setPage(0);
              onAssetChange(a.key);
            }}
            className={cn(
              'rounded-md border px-2 py-0.5 text-[12px] transition-colors',
              a.key === assetKey ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {a.label}
            <span className="num ml-1 text-[10.5px] opacity-70">{a.status === 'completed' ? a.trades.length : ASSET_STATUS_LABEL[a.status]}</span>
          </button>
        ))}
        <span className="ml-auto text-[11.5px] text-muted-foreground">{t('共 {n} 笔', { n: sorted.length })}</span>
      </div>
      {!asset || asset.status !== 'completed' ? (
        <EmptyNote>{asset?.error ?? t('没有可展示的资产')}</EmptyNote>
      ) : sorted.length === 0 ? (
        <EmptyNote>{t('无成交')}</EmptyNote>
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border border-border/70">
            <table className="w-full min-w-[980px] text-[12px]" data-testid="trades-table">
              <thead>
                <tr className="border-b border-border/70 bg-muted/30 text-[11px] text-muted-foreground">
                  <th className="px-2 py-1.5 text-left font-medium">#</th>
                  {cols().map((c) => (
                    <th key={c.key} className={cn('px-2 py-1.5 font-medium', c.align === 'right' ? 'text-right' : 'text-left')} aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button type="button" onClick={() => toggle(c.key)} className={cn('inline-flex items-center gap-0.5 hover:text-foreground', sort.key === c.key && 'text-foreground')}>
                        {c.label}
                        {sort.key === c.key ? sort.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : null}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((tr, i) => (
                  <tr key={tr.id} className="border-b border-border/40 last:border-0 hover:bg-muted/20">
                    <td className="num px-2 py-1 text-muted-foreground">{cur * PAGE_SIZE + i + 1}</td>
                    <td className="px-2 py-1 whitespace-nowrap">
                      {tr.symbol}
                      <span className={cn('ml-1 text-[10.5px]', tr.side === 'long' ? 'text-up' : 'text-down')}>{tr.side === 'long' ? t('多') : t('空')}</span>
                    </td>
                    <td className="num px-2 py-1 whitespace-nowrap text-muted-foreground">{ymdhm(tr.entry_at)}</td>
                    <td className="num px-2 py-1 text-right">{fmtPrice(tr.entry_price)}</td>
                    <td className="num px-2 py-1 whitespace-nowrap text-muted-foreground">{ymdhm(tr.exit_at)}</td>
                    <td className="num px-2 py-1 text-right">{fmtPrice(tr.exit_price)}</td>
                    <td className="num px-2 py-1 text-right">{fmtQty(tr.qty)}</td>
                    <td className={cn('num px-2 py-1 text-right', toneOf(tr.pnl))}>{usdSigned(tr.pnl)}</td>
                    <td className={cn('num px-2 py-1 text-right', toneOf(tr.return_pct))}>{pctSigned(tr.return_pct)}</td>
                    <td className="num px-2 py-1 text-right">{tr.bars_held}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{exitReasonLabel(tr.exit_reason)}</td>
                    <td className={cn('px-2 py-1 whitespace-nowrap', tr.segment === 'out_of_sample' ? 'text-primary' : 'text-muted-foreground')}>{segmentLabel(tr.segment)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 ? (
            <div className="flex items-center justify-end gap-2 text-[12px] text-muted-foreground">
              <Button variant="ghost" size="icon-sm" disabled={cur === 0} onClick={() => setPage(cur - 1)} aria-label={t('上一页')}>
                <ChevronLeft />
              </Button>
              <span className="num">
                {cur + 1} / {pages}
              </span>
              <Button variant="ghost" size="icon-sm" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} aria-label={t('下一页')}>
                <ChevronRight />
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
