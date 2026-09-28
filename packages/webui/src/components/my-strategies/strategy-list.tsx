/**
 * 「我的策略」列表(对齐 Horizon My Strategies):
 *   标题 + 副标题,右上「+ 新建策略」;搜索(防抖 300ms)· 筛选胶囊(带计数)· 排序下拉 · 网格/列表切换。
 * 搜索 / 排序与「关注 / 提醒」筛选走后端 query(researchApi.myStrategies({q,filter,sort}))。
 * 「实盘」胶囊按实盘注册表的真实状态算(2026-09-23 策略库合并):读 GET /api/strategies 与 /api/strategies/allocator,
 * 按 lab_strategy_id 对上,在票池或部署模式为模拟/实盘才算(deploy-model.ts isLiveDeployed);研究侧 status=live 只是状态记录,不算。
 * 接口 404(后端工作包还没上)时走空态,不报错。
 */
import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { LayoutGrid, List, Plus, Search, X } from 'lucide-react';
import type { ResearchStrategyList } from '@trade-gate/contracts';
import { api, researchApi } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useNow } from '@/lib/format';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { EMPTY_COUNTS, FILTERS, FILTER_LABEL, SORTS, SORT_LABEL, type StrategyFilter, type StrategySort } from './model';
import { StrategyCard, StrategyRow } from './strategy-card';
import { useStrategyActions } from './use-strategy-actions';
import { liveStrategyIds } from './deploy-model';
import { activeRunIds, runOf, useStrategyRuns } from './run-panel';

type ListResult = ResearchStrategyList & { unavailable?: boolean };

export async function fetchMyStrategies(opts: { q: string; filter: StrategyFilter; sort: StrategySort }): Promise<ListResult> {
  try {
    return await researchApi.myStrategies({ q: opts.q || undefined, filter: opts.filter, sort: opts.sort });
  } catch (e) {
    if ((e as { status?: number } | null)?.status === 404) return { strategies: [], counts: { ...EMPTY_COUNTS }, unavailable: true };
    throw e;
  }
}

const VIEW_KEY = 'tg.my-strategies.view';
type ViewMode = 'grid' | 'list';

function readView(): ViewMode {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const h = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(h);
  }, [value, ms]);
  return v;
}

/** 筛选胶囊组(带计数);独立导出给测试用 */
export function FilterCapsules({ value, counts, onChange }: { value: StrategyFilter; counts: ResearchStrategyList['counts']; onChange: (f: StrategyFilter) => void }) {
  return (
    <div role="tablist" aria-label={t('筛选')} className="flex items-center gap-0.5 rounded-full border border-border bg-card p-1">
      {FILTERS.map((f) => {
        const active = f === value;
        return (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={active}
            data-filter={f}
            onClick={() => onChange(f)}
            className={cn(
              'relative inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition-colors',
              active ? 'text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {active ? <motion.span layoutId="ms-filter-pill" className="absolute inset-0 rounded-full bg-primary" transition={{ type: 'spring', stiffness: 500, damping: 38 }} /> : null}
            <span className="relative">{FILTER_LABEL[f]}</span>
            <span className={cn('num relative text-[10.5px]', active ? 'text-primary-foreground/75' : 'text-muted-foreground/70')} data-count={counts[f]}>
              {counts[f]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function StrategyList() {
  const reduced = useReducedMotion();
  const now = useNow(30_000);
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const [filter, setFilter] = useState<StrategyFilter>('all');
  const [sort, setSort] = useState<StrategySort>('updated');
  const [view, setViewState] = useState<ViewMode>(readView);
  const setView = (v: ViewMode) => {
    setViewState(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* 私密模式 */
    }
  };
  const { actions, dialogs, busy, create, creating } = useStrategyActions();

  // 「实盘」不走后端 status 过滤:取全部再按实盘注册表算
  const backendFilter: StrategyFilter = filter === 'live' ? 'all' : filter;
  const listQ = useQuery({
    queryKey: ['research', 'my-strategies', backendFilter, sort, q],
    queryFn: () => fetchMyStrategies({ q, filter: backendFilter, sort }),
    placeholderData: keepPreviousData,
    retry: false,
  });
  // 计数用的全量(filter=all 时与 listQ 是同一个 key,react-query 去重)
  const allQ = useQuery({ queryKey: ['research', 'my-strategies', 'all', sort, q], queryFn: () => fetchMyStrategies({ q, filter: 'all', sort }), placeholderData: keepPreviousData, retry: false });
  const registryQ = useQuery({ queryKey: ['strategies'], queryFn: () => api.strategies(true), staleTime: 10_000, retry: false });
  const allocatorQ = useQuery({ queryKey: ['allocator'], queryFn: () => api.allocator(), staleTime: 10_000, retry: false });
  const runsQ = useStrategyRuns();
  const runIds = activeRunIds(runsQ.data?.runs);
  const liveIds = new Set([...liveStrategyIds(allQ.data?.strategies ?? [], registryQ.data?.strategies, allocatorQ.data), ...runIds]);
  const data = listQ.data;
  const strategies = filter === 'live' ? (data?.strategies ?? []).filter((s) => liveIds.has(s.id)) : (data?.strategies ?? []);
  const counts = { ...(data?.counts ?? EMPTY_COUNTS), live: liveIds.size };

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 px-2 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[26px] font-semibold tracking-tight">{t('我的策略')}</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">{t('你构建、回测或部署过的每一条策略。')}</p>
        </div>
        <Button onClick={create} disabled={creating} className="h-9 rounded-lg px-4 text-[13px] font-semibold shadow-[0_6px_18px_-8px_var(--primary)]">
          <Plus />
          {creating ? t('创建中…') : t('新建策略')}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <label className="relative flex h-9 min-w-[220px] flex-1 items-center sm:max-w-md">
          <Search className="pointer-events-none absolute left-3 size-4 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('按名称或资产搜索策略…')}
            aria-label={t('按名称或资产搜索策略…')}
            className="h-9 w-full rounded-full border border-border bg-card pr-8 pl-9 text-[13px] outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
          />
          {search ? (
            <button type="button" aria-label={t('清空')} onClick={() => setSearch('')} className="absolute right-2.5 text-muted-foreground hover:text-foreground">
              <X className="size-3.5" />
            </button>
          ) : null}
        </label>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <FilterCapsules value={filter} counts={counts} onChange={setFilter} />
          <Select value={sort} onValueChange={(v) => setSort(v as StrategySort)}>
            <SelectTrigger className="h-9 min-w-[150px] rounded-full bg-card px-4 text-[12.5px]" aria-label={t('排序')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {SORTS.map((s) => (
                <SelectItem key={s} value={s} className="text-[12.5px]">
                  {SORT_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-0.5 rounded-full border border-border bg-card p-1">
            {(['grid', 'list'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-label={v === 'grid' ? t('网格视图') : t('列表视图')}
                title={v === 'grid' ? t('网格视图') : t('列表视图')}
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className={cn('inline-flex size-7 items-center justify-center rounded-full transition-colors [&_svg]:size-3.5', view === v ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                {v === 'grid' ? <LayoutGrid /> : <List />}
              </button>
            ))}
          </div>
        </div>
      </div>

      {listQ.isPending ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[292px] rounded-xl" />
          ))}
        </div>
      ) : listQ.isError ? (
        <EmptyState title={t('策略列表加载失败')} body={listQ.error instanceof Error ? listQ.error.message : String(listQ.error)} action={<Button size="sm" variant="outline" onClick={() => void listQ.refetch()}>{t('重试')}</Button>} />
      ) : strategies.length === 0 ? (
        data?.unavailable ? (
          <EmptyState title={t('策略对象接口还没上线')} body={t('后端 /api/research/strategies 返回 404。上线后,研究页产出的策略会自动出现在这里。')} />
        ) : q || filter !== 'all' ? (
          <EmptyState title={t('没有匹配的策略')} body={t('换个关键词或筛选试试。')} action={<Button size="sm" variant="outline" onClick={() => { setSearch(''); setFilter('all'); }}>{t('清除筛选')}</Button>} />
        ) : (
          <EmptyState
            title={t('还没有策略')}
            body={t('新建一条草稿,到研究页用自然语言把它搭出来,再回测。')}
            action={
              <Button size="sm" onClick={create} disabled={creating}>
                <Plus />
                {t('新建策略')}
              </Button>
            }
          />
        )
      ) : view === 'grid' ? (
        <motion.div layout={!reduced} className={cn('grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 transition-opacity', listQ.isPlaceholderData && 'opacity-60')}>
          <AnimatePresence initial={false} mode="popLayout">
            {strategies.map((s, i) => (
              <motion.div
                key={s.id}
                layout={!reduced}
                initial={reduced ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduced ? undefined : { opacity: 0, scale: 0.98 }}
                transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1], delay: Math.min(i, 8) * 0.025 }}
              >
                <StrategyCard strategy={s} actions={actions} busy={busy.has(s.id)} now={now} run={runOf(runsQ.data?.runs, s.id)} />
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      ) : (
        <div className={cn('overflow-x-auto rounded-xl border border-border bg-card transition-opacity', listQ.isPlaceholderData && 'opacity-60')}>
          <Table className="table-dense">
            <TableHeader>
              <TableRow>
                <TableHead>{t('策略')}</TableHead>
                <TableHead>{t('状态')}</TableHead>
                <TableHead>{t('曲线')}</TableHead>
                <TableHead className="text-right">{t('总收益')}</TableHead>
                <TableHead className="text-right">{t('夏普')}</TableHead>
                <TableHead className="text-right">{t('最大回撤')}</TableHead>
                <TableHead className="text-right">{t('胜率')}</TableHead>
                <TableHead className="text-right">{t('交易数')}</TableHead>
                <TableHead className="text-right">{t('更新')}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {strategies.map((s) => (
                <StrategyRow key={s.id} strategy={s} actions={actions} busy={busy.has(s.id)} now={now} run={runOf(runsQ.data?.runs, s.id)} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {dialogs}
    </div>
  );
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card/40 px-6 py-16 text-center">
      <div className="text-[14px] font-semibold">{title}</div>
      <p className="max-w-md text-[12.5px] text-muted-foreground">{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
