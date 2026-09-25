/**
 * 日志页(v3,docs/demo/v3-ui-contract.md §3 / §8.4):
 *   上半 = 活动流(醒目徽章:交易类实色、agent 类描边、系统类灰;按小时分组;交易/agent/系统三组筛选
 *          + 关键词),给人看「发生了什么」;
 *   下半 = 原始日志(可折叠),给排错看。
 *
 * react-query key 约定见 src/App.tsx 顶部注释:['activity'](SSE `activity` 直接 prepend)与
 * ['logs'](SSE `log` prepend),本页不自己开 SSE 连接。
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, CircleQuestionMark, Search } from 'lucide-react';
import { api } from '@/api/client';
import type { ActivityItem, LogEntry } from '@/api/types';
import { Pane, Workspace } from '@/components/pane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { askAgent, whyQuestion } from '@/lib/ask-agent';
import { ACTIVITY_GROUP_LABEL, ACTIVITY_KIND_LABEL, activityBadgeClass, activityGroup, fmtClock, fmtHourBucket, fmtSigned, pnlText, type ActivityGroup } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';

// ---------------------------------------------------------------------------
// 活动流

type GroupFilter = 'all' | ActivityGroup;

function ActivityRow({ item }: { item: ActivityItem }) {
  const [open, setOpen] = useState(false);
  const group = activityGroup(item.kind);
  const pnl = typeof item.data['pnl'] === 'string' || typeof item.data['pnl'] === 'number' ? (item.data['pnl'] as string | number) : null;
  const canAsk = Boolean(item.episode_id || item.thread_id);
  const askable = canAsk && item.symbol;
  return (
    <div
      className={cn(
        'group/row rounded-md border border-transparent px-2 py-1.5 transition-colors animate-in fade-in slide-in-from-left-1 duration-300',
        group === 'trade' ? 'hover:border-border hover:bg-muted/40' : 'hover:bg-muted/30',
        item.detail && 'cursor-pointer',
      )}
      onClick={() => item.detail && setOpen((v) => !v)}
    >
      <div className="flex items-center gap-2">
        <span className="num w-14 shrink-0 text-[10.5px] text-muted-foreground">{fmtClock(item.at)}</span>
        <Badge variant="outline" className={cn('h-5 shrink-0 px-2 text-[10.5px] font-semibold tracking-wide', activityBadgeClass(item))}>
          {ACTIVITY_KIND_LABEL[item.kind] ?? item.kind}
        </Badge>
        {item.symbol ? <span className="num shrink-0 text-[11.5px] font-medium">{item.symbol}</span> : null}
        <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', group === 'trade' ? 'font-medium text-foreground' : group === 'agent' ? 'text-foreground/90' : 'text-muted-foreground')}>
          {item.title}
        </span>
        {pnl !== null ? <span className={cn('num shrink-0 text-[12px] font-semibold', pnlText(pnl))}>{fmtSigned(pnl)}</span> : null}
        {askable ? (
          <button
            type="button"
            title={t('问 agent 为什么')}
            aria-label={t('问 agent 为什么')}
            className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-primary group-hover/row:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              askAgent(whyQuestion({ symbol: item.symbol!, at: item.at, action: ACTIVITY_KIND_LABEL[item.kind], episodeId: item.episode_id, threadId: item.thread_id }));
            }}
          >
            <CircleQuestionMark className="size-3.5" />
          </button>
        ) : null}
        {item.detail ? (
          <span className="shrink-0 text-muted-foreground">{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</span>
        ) : null}
      </div>
      {open && item.detail ? (
        <div className="mt-1 pl-16 text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground animate-in fade-in duration-200">{item.detail}</div>
      ) : null}
    </div>
  );
}

function ActivityFeed() {
  const activityQ = useQuery({ queryKey: ['activity'], queryFn: () => api.activity(300), retry: 0 });
  const [group, setGroup] = useState<GroupFilter>('all');
  const [q, setQ] = useState('');

  const items = activityQ.data?.activity ?? [];
  const visible = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return items
      .filter((a) => (group === 'all' ? true : activityGroup(a.kind) === group))
      .filter((a) => (kw ? `${a.title} ${a.detail ?? ''} ${a.symbol ?? ''} ${ACTIVITY_KIND_LABEL[a.kind] ?? ''}`.toLowerCase().includes(kw) : true));
  }, [items, group, q]);

  const buckets = useMemo(() => {
    const out: { key: string; label: string; items: ActivityItem[] }[] = [];
    for (const a of visible) {
      const label = fmtHourBucket(a.at);
      const last = out[out.length - 1];
      if (last && last.key === label) last.items.push(a);
      else out.push({ key: label, label, items: [a] });
    }
    return out;
  }, [visible]);

  const counts = useMemo(() => {
    const c: Record<GroupFilter, number> = { all: items.length, trade: 0, agent: 0, system: 0 };
    for (const a of items) c[activityGroup(a.kind)]++;
    return c;
  }, [items]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-2">
        {(['all', 'trade', 'agent', 'system'] as GroupFilter[]).map((g) => (
          <Button key={g} type="button" variant={group === g ? 'default' : 'outline'} size="xs" className="rounded-full" onClick={() => setGroup(g)}>
            {g === 'all' ? t('全部') : ACTIVITY_GROUP_LABEL[g]}
            <span className="num ml-1 text-[10px] opacity-70">{counts[g]}</span>
          </Button>
        ))}
        <div className="relative ml-auto w-56">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('搜币种 / 关键词')} className="h-7 pl-7 text-[12px]" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-0.5 p-2">
          {activityQ.isLoading ? (
            <div className="space-y-1.5 p-1">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-2/3" />
            </div>
          ) : null}
          {activityQ.isError ? (
            <p className="py-6 text-center text-[12px] text-muted-foreground">{t('动态还没接上(网关没有 /api/activity),先看下面的原始日志。')}</p>
          ) : null}
          {!activityQ.isLoading && !activityQ.isError && visible.length === 0 ? (
            <p className="py-10 text-center text-[12px] text-muted-foreground">{items.length === 0 ? t('还没有动态。开仓、成交、止盈止损、出策略,都会出现在这里。') : t('没有匹配的动态。')}</p>
          ) : null}
          {buckets.map((b) => (
            <div key={b.key} className="mb-1">
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-card/95 px-2 py-1 text-[10.5px] font-semibold tracking-wide text-muted-foreground backdrop-blur select-none">
                {b.label}
                <span className="h-px flex-1 bg-border" />
                <span className="num font-normal">{b.items.length}</span>
              </div>
              {b.items.map((a) => (
                <ActivityRow key={a.id} item={a} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 原始日志

const LEVEL_LABEL: Record<LogEntry['level'], string> = tmap({ info: '信息', warn: '警告', error: '错误' });

function levelClass(level: LogEntry['level']): string {
  if (level === 'error') return 'text-destructive';
  if (level === 'warn') return 'text-warn';
  return 'text-muted-foreground';
}

type LevelFilter = 'all' | LogEntry['level'];

function RawLogs({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  const logsQ = useQuery({ queryKey: ['logs'], queryFn: () => api.logs(500) });
  const [level, setLevel] = useState<LevelFilter>('all');
  const logs = logsQ.data?.logs ?? [];
  const visible = level === 'all' ? logs : logs.filter((l) => l.level === level);
  const warnCount = logs.filter((l) => l.level !== 'info').length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <button type="button" onClick={onToggle} className="flex h-8 shrink-0 items-center gap-2 border-b bg-muted/40 px-2.5 text-left select-none hover:bg-muted/60">
        {expanded ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
        <span className="text-xs font-semibold tracking-wide">{t('原始日志')}</span>
        <span className="num text-[11px] text-muted-foreground">
          {t('{n} 条', { n: logs.length })}{warnCount ? ` · ${t('{n} 条警告 / 错误', { n: warnCount })}` : ''}
        </span>
        <span className="ml-auto text-[10.5px] text-muted-foreground">{expanded ? t('收起') : t('展开')}</span>
      </button>
      {expanded ? (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-1.5">
            {(['all', 'info', 'warn', 'error'] as const).map((lv) => (
              <Button key={lv} type="button" variant={level === lv ? 'default' : 'outline'} size="xs" className="rounded-full" onClick={() => setLevel(lv)}>
                {lv === 'all' ? t('全部') : LEVEL_LABEL[lv]}
              </Button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex flex-col gap-0.5 p-2">
              {logsQ.isError ? <p className="py-6 text-center text-[12px] text-destructive">{t('加载失败')}</p> : null}
              {!logsQ.isLoading && visible.length === 0 ? <p className="py-6 text-center text-[12px] text-muted-foreground">{t('没有日志。')}</p> : null}
              {visible.map((l, i) => (
                <div key={i} className="num flex items-start gap-2 rounded-sm px-1.5 py-1 text-[11.5px] hover:bg-muted/40">
                  <span className="shrink-0 text-muted-foreground">{fmtClock(l.at)}</span>
                  <span className={cn('w-9 shrink-0 font-medium', levelClass(l.level))}>{LEVEL_LABEL[l.level]}</span>
                  <span className="shrink-0 text-muted-foreground">{l.scope}</span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground">{l.message}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function LogsPage() {
  const [rawOpen, setRawOpen] = useState(false);
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Workspace className={cn('flex min-h-0 flex-col transition-[flex] duration-300', rawOpen ? 'flex-[3]' : 'flex-1')}>
        <Pane title={t('动态')} hint={t('发生了什么:开仓、成交、止盈止损、出策略、系统')} contentClassName="min-h-0">
          <ActivityFeed />
        </Pane>
      </Workspace>
      <Workspace className={cn('flex min-h-0 flex-col transition-[flex] duration-300', rawOpen ? 'flex-[2]' : 'shrink-0')}>
        <RawLogs expanded={rawOpen} onToggle={() => setRawOpen((v) => !v)} />
      </Workspace>
    </div>
  );
}
