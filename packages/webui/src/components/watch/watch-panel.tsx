/**
 * 盯盘参数(docs/design/watch-screener-review-2026-09-24.md 二-2):独立页 #watch 与 Agent 页「盯盘参数」抽屉共用。
 *   - 顶部一句话:这些参数影响每天判断次数与花费(附当前估算与今日已用)
 *   - 观察列表(watch-list):价 / 24h / 今日雷达候选 / 可交易开关 / 移除 / 拖动排序 —— 即点即存
 *   - 资产选择器(asset-picker):OKX 全集联想、筛选排序、一键 / 批量加入 —— 即点即存
 *   - 节奏(pace-section):分组 + 人话 + 推荐值,草稿 + 保存
 * 写入一律 PATCH /api/workflow。layout='drawer' 时三块用标签页切换(抽屉只有 26rem 宽)。
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { Workflow } from '@/api/types';
import { useUniverse } from '@/api/universe';
import { Pane, Workspace } from '@/components/pane';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { exchangeInfo } from '@/lib/exchange';
import { useNow } from '@/lib/format';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { AssetPicker } from './asset-picker';
import { PaceSection } from './pace-section';
import { useMarketScan } from './use-market-scan';
import { useWatchWriter } from './use-watch-writer';
import { WatchList, type WatchRowQuote } from './watch-list';
import { estimateDaily, mergeAdd, moveItem, radarHits, removeSymbols, setTradable } from './watch-logic';

type Positions = Map<string, 'in_position' | 'pending_entry' | 'orphan'>;

export function WatchPanel({ layout = 'page', className }: { layout?: 'page' | 'drawer'; className?: string }) {
  const now = useNow(60_000);
  const workflowQ = useQuery({ queryKey: ['workflow'], queryFn: api.workflow });
  const overviewQ = useQuery({ queryKey: ['overview'], queryFn: api.overview });
  // 交易所名只从 lib/exchange 取;还没读到执行视图时先写「交易所」,免得闪一下「币安」
  const executionQ = useQuery({ queryKey: ['execution'], queryFn: api.execution });
  const ex = { name: executionQ.data ? exchangeInfo(executionQ.data).name : t('交易所') };
  const universeQ = useUniverse();
  const scan = useMarketScan();
  const { write } = useWatchWriter();

  const wf = workflowQ.data ?? null;
  const watchlist = wf?.watchlist ?? [];
  const watchOnly = wf?.watch_only ?? [];
  const max = wf?.watchlist_max ?? 60;

  const radar = useMemo(() => radarHits(scan.sources, now), [scan.sources, now]);
  const universeBySym = useMemo(() => new Map((universeQ.data?.items ?? []).map((x) => [x.symbol, x])), [universeQ.data]);
  const quotes = useMemo(() => {
    const m = new Map<string, WatchRowQuote>();
    const mk = overviewQ.data?.markets ?? {};
    for (const s of watchlist) {
      const u = universeBySym.get(s);
      const o = mk[s] ?? mk[`perp:${s}`] ?? mk[`spot:${s}`];
      const last = u?.last ?? (o?.last != null && Number.isFinite(Number(o.last)) ? Number(o.last) : null);
      m.set(s, { last, change: u?.change_24h ?? null });
    }
    return m;
  }, [watchlist, universeBySym, overviewQ.data]);
  const positions: Positions = useMemo(() => {
    const m: Positions = new Map();
    for (const th of overviewQ.data?.threads ?? []) if (th.status === 'in_position' || th.status === 'pending_entry') m.set(th.symbol, th.status);
    for (const p of overviewQ.data?.account?.positions ?? []) if (!m.has(p.symbol)) m.set(p.symbol, 'orphan');
    return m;
  }, [overviewQ.data]);

  // ---- 写入(即点即存)
  const add = (syms: string[]) =>
    write((w) => {
      const r = mergeAdd(w.watchlist, syms, w.watchlist_max ?? 60);
      if (r.overflow.length) toast.error(t('超过名单上限,没加:{list}', { list: r.overflow.join('、') }));
      return r.added.length ? { watchlist: r.next } : null;
    }, syms.length === 1 ? t('{symbol} 加进观察列表了', { symbol: syms[0]! }) : t('加进观察列表了:{n} 个', { n: syms.length }));
  const remove = (sym: string) =>
    write((w) => {
      if (w.watchlist.length <= 1) {
        toast.error(t('名单不能为空'), { description: t('至少留一个币') });
        return null;
      }
      return removeSymbols({ watchlist: w.watchlist, watch_only: w.watch_only ?? [] }, [sym]);
    }, t('{symbol} 移出名单了', { symbol: sym }));
  const move = (from: number, to: number) => write((w) => ({ watchlist: moveItem(w.watchlist, from, to) }));
  const setTrade = (sym: string, trade: boolean) => write((w) => ({ watch_only: setTradable({ watchlist: w.watchlist, watch_only: w.watch_only ?? [] }, [sym], trade).watch_only }));
  const setMax = (n: number) => write(() => ({ watchlist_max: n }), t('名单上限改成 {n}', { n }));

  if (!wf) {
    return (
      <div className="space-y-2 p-3">
        {workflowQ.isError ? <div className="text-[12px] text-destructive">{t('工作流读取失败')}</div> : null}
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const header = <CostLine wf={wf} usage={overviewQ.data?.usage_today ?? null} />;
  const list = (
    <WatchList
      watchlist={watchlist}
      watchOnly={watchOnly}
      max={max}
      quotes={quotes}
      radar={radar}
      positions={positions}
      busy={false}
      onRemove={remove}
      onMove={move}
      onSetTrade={setTrade}
      onSetMax={setMax}
      className="h-full"
    />
  );
  const picker = <AssetPicker watchlist={watchlist} max={max} onAdd={add} radar={radar} exchangeName={ex.name} className="h-full" />;
  const pace = <PaceSection workflow={wf} className="h-full" />;

  if (layout === 'drawer') {
    return (
      <div className={cn('flex h-full min-h-0 flex-col', className)}>
        {header}
        <Tabs defaultValue="list" className="flex min-h-0 flex-1 flex-col gap-0">
          <TabsList variant="line" className="w-full shrink-0 border-b px-2">
            <TabsTrigger value="list" className="text-[12px]">
              {t('名单')} <span className="num text-[10.5px] text-muted-foreground">{watchlist.length}/{max}</span>
            </TabsTrigger>
            <TabsTrigger value="add" className="text-[12px]">
              {t('加币')}
            </TabsTrigger>
            <TabsTrigger value="pace" className="text-[12px]">
              {t('节奏')}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="list" className="min-h-0 flex-1">
            {list}
          </TabsContent>
          <TabsContent value="add" className="min-h-0 flex-1">
            {picker}
          </TabsContent>
          <TabsContent value="pace" className="min-h-0 flex-1">
            {pace}
          </TabsContent>
        </Tabs>
      </div>
    );
  }

  return (
    <div className={cn('flex h-full min-h-0 flex-col gap-3 overflow-y-auto', className)}>
      <Workspace className="shrink-0">{header}</Workspace>
      <div className="grid shrink-0 gap-3 lg:grid-cols-2">
        <Workspace className="flex h-[34rem] flex-col">
          <Pane title={t('观察列表')} hint={t('agent 能看、能交易的币就是这一份;拖动或用箭头排序')} className="min-h-0 flex-1" contentClassName="min-h-0">
            {list}
          </Pane>
        </Workspace>
        <Workspace className="flex h-[34rem] flex-col">
          <Pane title={t('加币 · {ex} 资产', { ex: ex.name })} hint={t('点「+」一键加入,或勾选后批量加入')} className="min-h-0 flex-1" contentClassName="min-h-0">
            {picker}
          </Pane>
        </Workspace>
      </div>
      <Workspace className="flex h-[36rem] shrink-0 flex-col">
        <Pane title={t('节奏')} hint={t('多久看一次 / 怎么扫 / 心跳;改完点保存')} className="min-h-0 flex-1" contentClassName="min-h-0">
          {pace}
        </Pane>
      </Workspace>
    </div>
  );
}

function CostLine({ wf, usage }: { wf: Workflow; usage: { judgments: number; cap: number; est_cny?: number | null } | null }) {
  const est = estimateDaily(
    { watchlist: wf.watchlist, timeframe: wf.timeframe, scan_mode: wf.scan_mode ?? 'triggered', heartbeat_every_ms: wf.heartbeat_every_ms ?? 30 * 60_000 },
    wf.daily_judgment_cap ?? 0,
  );
  return (
    <div className="shrink-0 border-b px-3 py-2 text-[11.5px] leading-5">
      <span className="text-foreground">{t('这些参数决定每天判断几次、花多少钱:名单越长、周期越短、心跳越勤,调用越多。')}</span>{' '}
      <span className="num text-muted-foreground">
        {t('现在约每天 {lo}–{hi} 次 · ≈¥{cost}', { lo: est.low, hi: est.high, cost: est.costHigh.toFixed(2) })}
        {usage ? ` · ${t('今天已用 {n}/{cap}', { n: usage.judgments, cap: usage.cap || '∞' })}` : ''}
        {usage?.est_cny != null ? ` (¥${usage.est_cny.toFixed(2)})` : ''}
      </span>
    </div>
  );
}
