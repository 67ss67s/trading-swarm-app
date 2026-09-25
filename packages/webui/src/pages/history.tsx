/**
 * 复盘页(v3,docs/demo/v3-ui-contract.md §2 / §8.3;09-24 重排见 docs/design/watch-screener-review-2026-09-24.md 二-4)。
 * 三个标签(hash:#history?tab=trades|judgment|candidates):
 *   「这笔赚没赚」  已结束线程的统计 + 权益曲线 + 分组条形 + 可筛可展开的交易表。展开一笔 → 那笔的 K 线
 *                  (入场/止损/止盈/出场线 + 开平仓标记)+ 判断时间线 +「问 agent 这笔为什么」。
 *   「这类判断值不值」判断账本 jl-v2(components/history/ledger-section.tsx)。
 *   「候选和策略」  影子候选结算 + 策略深链(components/history/candidates-section.tsx)。
 *
 * react-query key:['history'](App.tsx 在线程进终态时失效)、['thread', id](展开时懒加载);另两块见各自文件头。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, CircleQuestionMark, RefreshCw } from 'lucide-react';
import { api } from '@/api/client';
import type { HistoryStats, HistoryThread, ThreadSource } from '@/api/types';
import { CandidatesSection } from '@/components/history/candidates-section';
import { LedgerSection } from '@/components/history/ledger-section';
import { EquityChart } from '@/components/equity-chart';
import { Pane, Workspace } from '@/components/pane';
import { TradeChart, intervalMs, type TradeChartMarker } from '@/components/trade-chart';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { askAgent, whyQuestion } from '@/lib/ask-agent';
import {
  THREAD_SOURCE_LABEL,
  THREAD_STATUS_LABEL,
  actionBadgeClass,
  actionLabel,
  directionLabel,
  directionText,
  fmtClock,
  fmtDateTime,
  fmtDuration,
  fmtPrice,
  fmtQty,
  fmtSigned,
  pnlText,
  threadStatusBadgeClass,
  triggerLabel,
} from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, t as tr } from '@/lib/i18n';

// ---------------------------------------------------------------------------
// 动效:数字滚动

function useCountUp(target: number, durationMs = 700): number {
  const [value, setValue] = useState(0);
  const fromRef = useRef(0);
  useEffect(() => {
    const from = fromRef.current;
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      const v = from + (target - from) * eased;
      setValue(v);
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return value;
}

function StatCard({ label, value, format, sub, tone, delay = 0 }: { label: string; value: number; format: (n: number) => string; sub?: React.ReactNode; tone?: 'up' | 'down' | 'muted'; delay?: number }) {
  const v = useCountUp(value);
  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-500 fill-mode-both rounded-md border bg-card px-3 py-2.5" style={{ animationDelay: `${delay}ms` }}>
      <div className="text-[11px] text-muted-foreground select-none">{label}</div>
      <div className={cn('num mt-0.5 text-[20px]/7 font-semibold', tone === 'up' && 'text-up', tone === 'down' && 'text-down', tone === 'muted' && 'text-muted-foreground')}>{format(v)}</div>
      {sub ? <div className="num mt-0.5 text-[11px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

function BarList({ title, rows }: { title: string; rows: { label: string; count: number; pnl: number; wins?: number }[] }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setMounted(true), 30);
    return () => window.clearTimeout(t);
  }, []);
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.pnl)));
  return (
    <div className="flex min-h-0 flex-col rounded-md border bg-card">
      <div className="border-b px-3 py-1.5 text-[11px] font-semibold text-muted-foreground select-none">{title}</div>
      <div className="flex flex-col gap-1.5 overflow-y-auto p-2.5">
        {rows.length === 0 ? <div className="py-3 text-center text-[11px] text-muted-foreground">—</div> : null}
        {rows.map((r) => {
          const w = mounted ? (Math.abs(r.pnl) / max) * 100 : 0;
          return (
            <div key={r.label} className="text-[11.5px]">
              <div className="flex items-center gap-2">
                <span className="num min-w-0 flex-1 truncate">{r.label}</span>
                <span className="num text-[10.5px] text-muted-foreground">
                  {t('{n} 笔', { n: r.count })}{r.wins !== undefined ? ` · ${t('胜 {n}', { n: r.wins })}` : ''}
                </span>
                <span className={cn('num w-16 text-right', pnlText(r.pnl))}>{fmtSigned(r.pnl)}</span>
              </div>
              <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-muted">
                <div className={cn('h-full rounded-full transition-[width] duration-700 ease-out', r.pnl >= 0 ? 'bg-up' : 'bg-down')} style={{ width: `${w}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 交易表

type ResultFilter = 'all' | 'win' | 'loss';

function closeKind(reason: string | null): 'tp' | 'sl' | 'exit' | 'other' {
  if (!reason) return 'other';
  if (reason.includes('止盈')) return 'tp';
  if (reason.includes('止损')) return 'sl';
  if (reason.includes('离场') || reason.includes('平仓') || reason.includes('失效')) return 'exit';
  return 'other';
}

function TradeDetail({ thread }: { thread: HistoryThread }) {
  const detailQ = useQuery({ queryKey: ['thread', thread.id], queryFn: () => api.thread(thread.id) });
  const tf = thread.timeframe || '15m';
  const step = intervalMs(tf);
  const endAt = (thread.closed_at ?? thread.updated_at) + step * 12;
  const startAt = thread.created_at - step * 25;
  const limit = Math.max(60, Math.min(500, Math.ceil((endAt - startAt) / step)));
  const markers = useMemo<TradeChartMarker[]>(() => {
    const list: TradeChartMarker[] = [];
    const entryAt = thread.opened_at ?? thread.created_at;
    if (thread.filled_avg_price || thread.status === 'closed') list.push({ at: entryAt, kind: 'entry', side: thread.side, text: `${t('入场')} ${fmtPrice(thread.filled_avg_price ?? thread.entry.price)}` });
    if (thread.closed_at) {
      const k = closeKind(thread.close_reason);
      list.push({ at: thread.closed_at, kind: k === 'tp' ? 'tp' : k === 'sl' ? 'sl' : 'exit', side: thread.side, text: `${k === 'tp' ? t('止盈') : k === 'sl' ? t('止损') : t('出场')} ${thread.exit_price ? fmtPrice(thread.exit_price) : ''}` });
    }
    return list;
  }, [thread]);
  const episodes = useMemo(() => [...(detailQ.data?.episodes ?? [])].sort((a, b) => a.at - b.at), [detailQ.data]);

  return (
    <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-3 border-t bg-muted/20 p-3 animate-in fade-in slide-in-from-top-1 duration-300">
      <div className="flex h-72 min-h-0 flex-col rounded-md border bg-card">
        <TradeChart
          symbol={thread.symbol}
          timeframe={tf}
          live={false}
          showIntervals={false}
          endTime={endAt}
          limit={limit}
          markers={markers}
          lines={{ entryPrice: thread.filled_avg_price ?? thread.entry.price, entryZone: thread.entry.zone, stopPrice: thread.stop_price, takeProfits: thread.take_profits, exitPrice: thread.exit_price }}
        />
      </div>
      <div className="flex h-72 min-h-0 flex-col rounded-md border bg-card">
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
          <span className="text-[11px] font-semibold text-muted-foreground">{t('判断时间线')}</span>
          <span className="num text-[10.5px] text-muted-foreground">{t('{n} 次', { n: episodes.length })}</span>
          <Button
            size="xs"
            variant="outline"
            className="ml-auto"
            onClick={() => askAgent(whyQuestion({ symbol: thread.symbol, at: thread.created_at, action: null, threadId: thread.id }))}
          >
            <CircleQuestionMark data-slot="icon" />
            {t('问 agent 这笔为什么')}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <div className="mb-2 rounded-sm bg-muted/40 px-2 py-1.5 text-[11.5px] leading-relaxed">
            <span className="text-muted-foreground">{t('论点')}:</span>
            {thread.thesis || '—'}
            {thread.invalidation_text ? (
              <div className="mt-0.5 text-warn">{t('失效条件')}:{thread.invalidation_text}</div>
            ) : null}
          </div>
          {detailQ.isLoading ? <div className="p-2 text-[11px] text-muted-foreground">{t('加载中…')}</div> : null}
          {detailQ.isError ? <div className="p-2 text-[11px] text-destructive">{t('加载失败')}</div> : null}
          {!detailQ.isLoading && episodes.length === 0 ? <div className="p-2 text-[11px] text-muted-foreground">{t('这笔没有判断记录(手动单)。')}</div> : null}
          <ol className="relative ml-2 border-l pl-3">
            {episodes.map((e, i) => (
              <li key={e.id} className="relative pb-2.5 text-[11.5px] animate-in fade-in slide-in-from-left-1 duration-300 fill-mode-both" style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}>
                <span className={cn('absolute -left-[17px] top-1 size-2 rounded-full border-2 border-card', e.action === 'PROPOSE' || e.action === 'EXIT' ? 'bg-primary' : 'bg-muted-foreground/50')} />
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="num text-[10.5px] text-muted-foreground">{fmtClock(e.at)}</span>
                  <span className="text-[10.5px] text-muted-foreground">{triggerLabel(e.trigger.kind)}</span>
                  <Badge variant="outline" className={cn('h-4 px-1.5 text-[10px]', e.action ? actionBadgeClass(e.action, e.direction) : 'bg-muted text-muted-foreground border-transparent')}>
                    {e.action ? actionLabel(e.action, e.direction) : t('失败')}
                  </Badge>
                  <button
                    type="button"
                    className="ml-auto text-[10.5px] text-primary hover:underline"
                    onClick={() => askAgent(whyQuestion({ symbol: e.symbol, at: e.at, action: e.action, episodeId: e.id }))}
                  >
                    {t('为什么?')}
                  </button>
                </div>
                {e.headline ? <div className="mt-0.5 text-foreground/90">{e.headline}</div> : null}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

function TradeTable({ threads }: { threads: HistoryThread[] }) {
  const [result, setResult] = useState<ResultFilter>('all');
  const [symbol, setSymbol] = useState<string>('all');
  const [source, setSource] = useState<'all' | ThreadSource>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  const symbols = useMemo(() => [...new Set(threads.map((t) => t.symbol))].sort(), [threads]);
  const visible = useMemo(
    () =>
      threads
        .filter((t) => (result === 'all' ? true : result === 'win' ? t.pnl_num > 0 : t.pnl_num < 0))
        .filter((t) => (symbol === 'all' ? true : t.symbol === symbol))
        .filter((t) => (source === 'all' ? true : t.source === source))
        .sort((a, b) => (b.closed_at ?? b.updated_at) - (a.closed_at ?? a.updated_at)),
    [threads, result, symbol, source],
  );

  const chip = (active: boolean, label: string, onClick: () => void, key: string) => (
    <Button key={key} type="button" size="xs" variant={active ? 'default' : 'outline'} className="rounded-full" onClick={onClick}>
      {label}
    </Button>
  );

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-2">
        <span className="text-[11px] text-muted-foreground">{t('结果')}</span>
        {chip(result === 'all', t('全部'), () => setResult('all'), 'r-all')}
        {chip(result === 'win', t('盈利'), () => setResult('win'), 'r-win')}
        {chip(result === 'loss', t('亏损'), () => setResult('loss'), 'r-loss')}
        <span className="ml-2 text-[11px] text-muted-foreground">{t('来源')}</span>
        {chip(source === 'all', t('全部'), () => setSource('all'), 's-all')}
        {(['agent', 'manual', 'chat'] as ThreadSource[]).map((s) => chip(source === s, THREAD_SOURCE_LABEL[s], () => setSource(s), `s-${s}`))}
        {symbols.length > 1 ? (
          <>
            <span className="ml-2 text-[11px] text-muted-foreground">{t('币种')}</span>
            {chip(symbol === 'all', t('全部'), () => setSymbol('all'), 'sym-all')}
            {symbols.map((s) => chip(symbol === s, s, () => setSymbol(s), `sym-${s}`))}
          </>
        ) : null}
        <span className="num ml-auto text-[11px] text-muted-foreground">{t('{n} 笔', { n: visible.length })}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <Table className="table-dense">
          <TableHeader>
            <TableRow>
              <TableHead className="w-6" />
              <TableHead>{t('结束时间')}</TableHead>
              <TableHead>{t('币种')}</TableHead>
              <TableHead>{t('方向')}</TableHead>
              <TableHead>{t('来源')}</TableHead>
              <TableHead>{t('状态')}</TableHead>
              <TableHead className="text-right">{t('入场')}</TableHead>
              <TableHead className="text-right">{t('出场')}</TableHead>
              <TableHead className="text-right">{t('数量')}</TableHead>
              <TableHead className="text-right">{t('持仓时长')}</TableHead>
              <TableHead className="text-right">{t('盈亏')}</TableHead>
              <TableHead className="text-right">R</TableHead>
              <TableHead>{t('平仓原因')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={13} className="py-10 text-center text-muted-foreground">
                  {t('还没有结束的交易。agent 开的单、你手动下的单,结束之后都会到这里。')}
                </TableCell>
              </TableRow>
            ) : null}
            {visible.map((t, i) => {
              const open = openId === t.id;
              return (
                <RowGroup key={t.id} thread={t} open={open} onToggle={() => setOpenId(open ? null : t.id)} index={i} />
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function RowGroup({ thread: t, open, onToggle, index }: { thread: HistoryThread; open: boolean; onToggle: () => void; index: number }) {
  return (
    <>
      <TableRow
        onClick={onToggle}
        className={cn('cursor-pointer animate-in fade-in duration-300 fill-mode-both', open && 'bg-muted/40')}
        style={{ animationDelay: `${Math.min(index, 20) * 25}ms` }}
      >
        <TableCell className="text-muted-foreground">{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</TableCell>
        <TableCell className="num whitespace-nowrap">{fmtDateTime(t.closed_at ?? t.updated_at)}</TableCell>
        <TableCell className="num font-medium">{t.symbol}</TableCell>
        <TableCell className={cn('font-medium', directionText(t.side))}>{directionLabel(t.side)}</TableCell>
        <TableCell className="text-muted-foreground">{THREAD_SOURCE_LABEL[t.source]}</TableCell>
        <TableCell>
          <Badge variant="outline" className={cn('h-4 px-1.5 text-[10px]', threadStatusBadgeClass(t.status))}>
            {THREAD_STATUS_LABEL[t.status]}
          </Badge>
        </TableCell>
        <TableCell className="num text-right">{fmtPrice(t.filled_avg_price ?? t.entry.price)}</TableCell>
        <TableCell className="num text-right">{t.exit_price ? fmtPrice(t.exit_price) : t.settled === false ? <span className="text-[10px] text-muted-foreground">{tr('结算中')}</span> : '—'}</TableCell>
        <TableCell className="num text-right">{fmtQty(t.qty)}</TableCell>
        <TableCell className="num text-right whitespace-nowrap">{fmtDuration(t.hold_ms)}</TableCell>
        <TableCell className={cn('num text-right font-semibold', t.settled === false ? 'text-muted-foreground' : pnlText(t.realized_pnl))} title={t.settled === false ? tr('还没从交易所拉到这笔的成交明细,盈亏未知(不是 0)') : undefined}>
          {t.settled === false ? <span className="text-[10px] font-normal">{tr('结算中')}</span> : fmtSigned(t.realized_pnl)}
        </TableCell>
        <TableCell className={cn('num text-right', t.r_multiple !== null ? pnlText(t.r_multiple) : 'text-muted-foreground')}>{t.r_multiple !== null ? `${t.r_multiple >= 0 ? '+' : ''}${t.r_multiple.toFixed(2)}R` : '—'}</TableCell>
        <TableCell className="max-w-[220px] truncate text-muted-foreground" title={t.close_reason ?? ''}>
          {t.close_reason ?? '—'}
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={13} className="p-0">
            <TradeDetail thread={t} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
// ---------------------------------------------------------------------------
// 页面

function statsRows(stats: HistoryStats) {
  return {
    bySymbol: stats.by_symbol.map((r) => ({ label: r.symbol, count: r.count, pnl: Number(r.pnl), wins: r.wins })),
    bySource: stats.by_source.map((r) => ({ label: THREAD_SOURCE_LABEL[r.source] ?? r.source, count: r.count, pnl: Number(r.pnl), wins: r.wins })),
    byReason: stats.by_close_reason.map((r) => ({ label: r.reason, count: r.count, pnl: Number(r.pnl), wins: r.wins })),
  };
}

/** 「这笔赚没赚」:交易与账户(原复盘页主体,口径不变)。 */
function TradesSection() {
  const historyQ = useQuery({ queryKey: ['history'], queryFn: () => api.history(300), staleTime: 10_000, refetchInterval: 60_000 });
  const data = historyQ.data;
  const stats = data?.stats;
  const rows = useMemo(() => (stats ? statsRows(stats) : null), [stats]);
  const totalPnl = Number(stats?.total_pnl ?? 0);

  if (historyQ.isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="grid grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
        <Skeleton className="h-56 w-full" />
        <Skeleton className="min-h-0 flex-1 w-full" />
      </div>
    );
  }
  if (historyQ.isError || !data || !stats || !rows) {
    return (
      <Workspace className="flex min-h-[240px] flex-1 items-center justify-center">
        <div className="text-center text-[12.5px] text-muted-foreground">
          <p>{t('复盘数据加载失败')}:{historyQ.error instanceof Error ? historyQ.error.message : t('网关还没有 /api/history')}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => void historyQ.refetch()}>
            <RefreshCw data-slot="icon" />
            {t('重试')}
          </Button>
        </div>
      </Workspace>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="grid shrink-0 grid-cols-6 gap-3">
        <StatCard label={t('已结束交易')} value={stats.count} format={(n) => `${Math.round(n)}`} sub={`${t('盈 {n}', { n: stats.wins })} · ${t('亏 {n}', { n: stats.losses })}${stats.flat ? ` · ${t('平 {n}', { n: stats.flat })}` : ''}${stats.unsettled ? ` · ${t('结算中 {n} 笔', { n: stats.unsettled })}` : ''}`} delay={0} />
        <StatCard label={t('胜率')} value={stats.win_rate * 100} format={(n) => `${n.toFixed(0)}%`} sub={stats.count ? `${stats.wins}/${stats.count}` : '—'} delay={50} />
        <StatCard label={t('累计盈亏')} value={totalPnl} format={(n) => fmtSigned(n)} sub={t('USDT,已实现')} tone={totalPnl > 0 ? 'up' : totalPnl < 0 ? 'down' : 'muted'} delay={100} />
        <StatCard label={t('平均每笔')} value={Number(stats.avg_pnl)} format={(n) => fmtSigned(n)} sub="USDT" tone={Number(stats.avg_pnl) > 0 ? 'up' : Number(stats.avg_pnl) < 0 ? 'down' : 'muted'} delay={150} />
        <StatCard label={t('盈亏比')} value={stats.profit_factor ?? 0} format={(n) => (stats.profit_factor === null ? '—' : n.toFixed(2))} sub={t('总盈利 / 总亏损')} delay={200} />
        <StatCard
          label={t('平均持仓')}
          value={stats.avg_hold_ms / 60_000}
          format={(n) => fmtDuration(n * 60_000)}
          sub={
            stats.best && stats.worst ? (
              <span>
                {t('最好')} <span className="text-up">{fmtSigned(stats.best.pnl)}</span> · {t('最差')} <span className="text-down">{fmtSigned(stats.worst.pnl)}</span>
              </span>
            ) : undefined
          }
          delay={250}
        />
      </div>

      {data.threads.length === 0 && data.equity.length > 0 ? (
        <div className="shrink-0 rounded-md border border-dashed bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">
          {t('权益曲线是执行后端的账户快照(整个账户,含不是 agent 开的仓和资金变动);上面的统计和下面的交易表只算这个后端上已结束的线程。现在还没有结束的线程,所以两边对不上是正常的。')}
        </div>
      ) : null}

      <div className="grid h-56 shrink-0 grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3">
        <div className="flex min-h-0 flex-col rounded-md border bg-card animate-in fade-in duration-500">
          <div className="flex items-center border-b px-3 py-1.5 text-[11px] font-semibold text-muted-foreground select-none">
            {t('权益曲线')}
            <span className="num ml-auto font-normal" title={t('账户快照,不是交易累计')}>
              {t('{n} 点', { n: data.equity.length })}
            </span>
          </div>
          <div className="min-h-0 flex-1 p-1">
            {data.equity.length >= 2 ? <EquityChart points={data.equity} /> : <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">{t('权益点还不够画线')}</div>}
          </div>
        </div>
        <BarList title={t('按币种')} rows={rows.bySymbol} />
        <BarList title={t('按来源')} rows={rows.bySource} />
        <BarList title={t('按平仓原因')} rows={rows.byReason} />
      </div>

      <Workspace className="flex min-h-[320px] min-h-0 flex-1 flex-col">
        <Pane title={t('交易记录')} hint={t('共 {n} 笔', { n: data.threads.length })} contentClassName="flex min-h-0 flex-col">
          <TradeTable threads={data.threads} />
        </Pane>
      </Workspace>
    </div>
  );
}

type HistoryTab = 'trades' | 'judgment' | 'candidates';

const HISTORY_TABS: { id: HistoryTab; label: string; hint: string }[] = [
  { id: 'trades', label: '这笔赚没赚', hint: '交易与账户' },
  { id: 'judgment', label: '这类判断值不值', hint: '判断账本' },
  { id: 'candidates', label: '候选和策略', hint: '影子候选 · 我的策略' },
];

function tabFromHash(hash: string): HistoryTab {
  const q = hash.split('?')[1] ?? '';
  const v = new URLSearchParams(q).get('tab');
  return v === 'judgment' || v === 'candidates' ? v : 'trades';
}

export function HistoryPage() {
  const [tab, setTab] = useState<HistoryTab>(() => tabFromHash(window.location.hash));
  useEffect(() => {
    const on = () => setTab(tabFromHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const pick = (next: HistoryTab) => {
    setTab(next);
    // 只改 URL 不触发 hashchange(App 按 '?' 前的段路由,仍然停在复盘页)
    try {
      window.history.replaceState(null, '', next === 'trades' ? '#history' : `#history?tab=${next}`);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto">
      <div role="tablist" aria-label={t('复盘')} className="flex shrink-0 items-center gap-1 border-b pb-2">
        {HISTORY_TABS.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            aria-selected={tab === x.id}
            onClick={() => pick(x.id)}
            className={cn(
              'flex items-baseline gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] transition-colors',
              tab === x.id ? 'bg-primary/15 font-semibold text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            {t(x.label)}
            <span className="text-[10.5px] font-normal text-muted-foreground">{t(x.hint)}</span>
          </button>
        ))}
      </div>
      {tab === 'trades' ? <TradesSection /> : tab === 'judgment' ? <LedgerSection /> : <CandidatesSection />}
    </div>
  );
}
