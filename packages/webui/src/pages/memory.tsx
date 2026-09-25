/**
 * 记忆页(#/memory,docs/demo/memory.md):长期记忆的完整生命周期——
 *   系统模板/agent 复盘提炼 → proposed(待批准)→ 人工批准/拒绝 → active(已激活,判断
 *   时会被召回进证据,证据里显示为「记忆 mem-…」)→ 手动遗忘 / 被新记忆替代(superseded)。
 * 用户手写的记忆(POST /api/memory)不走审批,直接 active。
 *
 * react-query key 约定见 App.tsx 顶部注释:本页统一用 ['memory', ...] 前缀开子查询——
 * ['memory','list',symbol] / ['memory','search',q,symbol] / ['memory','detail',id]——
 * App.tsx 的单条 SSE 连接在 `memory.changed` 时按前缀把它们一次性全失效,本页不用自己
 * 再开一条 /api/events 连接。symbol 过滤下拉复用 ['overview'] 里的 workflow.watchlist。
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Plus, Search, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { MemoryCreateRequest, MemoryEvent, MemoryItem, MemoryKind, MemoryProposer, MemoryScope, MemoryStatus } from '@/api/types';
import { Pane, Workspace } from '@/components/pane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { fmtDateTime, relativeTime, useNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';

// ---------------------------------------------------------------------------
// 文案表(记忆契约独有,不进 lib/format.ts,只在本页用)

const KIND_LABEL: Record<MemoryKind, string> = tmap({
  lesson: '教训',
  preference: '偏好',
  fact: '事实',
  calibration: '校准',
});

const STATUS_LABEL: Record<MemoryStatus, string> = tmap({
  proposed: '待批准',
  active: '已激活',
  rejected: '已拒绝',
  superseded: '已被替代',
  forgotten: '已遗忘',
});

const PROPOSER_LABEL: Record<MemoryProposer, string> = tmap({
  agent: '复盘提炼',
  user: '手动添加',
  system: '交易事实模板',
});

const EVENT_KIND_LABEL: Record<MemoryEvent['kind'], string> = tmap({
  proposed: '提出',
  approved: '批准',
  rejected: '拒绝',
  forgotten: '遗忘',
  superseded: '被替代',
  used: '被召回使用',
  expired: '过期',
  dedup_hit: '去重命中',
});

const COUNT_BADGES: { key: MemoryStatus; label: string; cls: string }[] = [
  { key: 'proposed', label: '待批准', cls: 'bg-warn/15 text-warn border-warn/30' },
  { key: 'active', label: '已激活', cls: 'bg-up/15 text-up border-up/30' },
  { key: 'superseded', label: '已被替代', cls: 'bg-muted text-muted-foreground border-transparent' },
  { key: 'forgotten', label: '已遗忘', cls: 'bg-muted text-muted-foreground border-transparent' },
];

function scopeText(scope: MemoryScope): string {
  const parts = [scope.symbol, scope.regime, scope.timeframe].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(' · ') : t('全局');
}

/** source_refs 里的 thr-.../ep-... id,简单按前缀跳到对应页面(不深链到具体那一条)。 */
function jumpToRef(ref: string) {
  if (ref.startsWith('thr-')) window.location.hash = 'history';
  else if (ref.startsWith('ep-')) window.location.hash = 'judgments';
}

// ---------------------------------------------------------------------------
// 顶部:counts 徽章

function CountsRow({ counts }: { counts: Record<MemoryStatus, number> | undefined }) {
  return (
    <div className="flex items-center gap-1.5">
      {COUNT_BADGES.map((b) => (
        <Badge key={b.key} variant="outline" className={cn('h-5 px-2 text-[11px]', b.cls)}>
          {t(b.label)} <span className="num ml-1">{counts ? (counts[b.key] ?? 0) : '—'}</span>
        </Badge>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 手动添加弹窗

function AddMemoryDialog({
  open,
  onOpenChange,
  watchlist,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  watchlist: string[];
  pending: boolean;
  onSubmit: (body: MemoryCreateRequest) => void;
}) {
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<MemoryKind>('preference');
  const [symbol, setSymbol] = useState<string>('none');
  const [tags, setTags] = useState('');

  useEffect(() => {
    if (!open) {
      setContent('');
      setKind('preference');
      setSymbol('none');
      setTags('');
    }
  }, [open]);

  const trimmed = content.trim();
  const submit = () => {
    if (!trimmed) return;
    onSubmit({
      content: trimmed,
      kind,
      symbol: symbol === 'none' ? null : symbol,
      tags: tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('手动添加记忆')}</DialogTitle>
          <DialogDescription>{t('手动加的记忆不用审批,提交就生效。')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-[13px]">
          <div className="flex flex-col gap-1.5">
            <Label className="text-[12px]">{t('内容(必填,≤300 字)')}</Label>
            <Textarea
              value={content}
              maxLength={300}
              placeholder={t('比如:BTCUSDT 高波动状态下止损容易被扫,考虑放宽到 1.5 倍 ATR')}
              onChange={(e) => setContent(e.target.value)}
              className="min-h-20 text-[12.5px]"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-[12px]">{t('类型')}</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as MemoryKind)}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="preference">{t('偏好')}</SelectItem>
                  <SelectItem value="lesson">{t('教训')}</SelectItem>
                  <SelectItem value="fact">{t('事实')}</SelectItem>
                  <SelectItem value="calibration">{t('校准')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-[12px]">{t('币种(可选)')}</Label>
              <Select value={symbol} onValueChange={setSymbol}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('全局(不限币种)')}</SelectItem>
                  {watchlist.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-[12px]">{t('标签(逗号分隔,可选)')}</Label>
            <Input value={tags} placeholder={t('风控, 止损')} onChange={(e) => setTags(e.target.value)} className="text-[12.5px]" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={pending} onClick={() => onOpenChange(false)}>
            {t('取消')}
          </Button>
          <Button size="sm" disabled={pending || !trimmed} onClick={submit}>
            {pending ? t('提交中…') : t('添加')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 「待批准」卡片

function ProposedCard({ item, busy, onApprove, onReject }: { item: MemoryItem; busy: boolean; onApprove: () => void; onReject: () => void }) {
  const now = useNow();
  return (
    <article className="rounded-md border bg-card p-3 text-[12px] animate-in fade-in slide-in-from-bottom-1 duration-300">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="text-[10.5px]">
          {KIND_LABEL[item.kind]}
        </Badge>
        <span className="text-muted-foreground">{scopeText(item.scope)}</span>
        <span className="text-[10.5px] text-muted-foreground">· {PROPOSER_LABEL[item.proposed_by]}</span>
        <span className="ml-auto text-[10.5px] text-muted-foreground" title={fmtDateTime(item.created_at)}>
          {relativeTime(item.created_at, now)}
        </span>
      </div>
      <p className="mt-1.5 leading-relaxed">{item.content}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10.5px]">
        <span className="flex items-center gap-1 text-muted-foreground">
          {t('置信度')}
          <span className="h-1 w-12 overflow-hidden rounded-full bg-muted">
            <span className="block h-full bg-primary" style={{ width: `${Math.round(item.confidence * 100)}%` }} />
          </span>
          <span className="num">{Math.round(item.confidence * 100)}%</span>
        </span>
        {item.source_refs.map((ref) => (
          <button key={ref} type="button" className="num text-primary hover:underline" onClick={() => jumpToRef(ref)}>
            {ref}
          </button>
        ))}
        {item.tags.map((t) => (
          <Badge key={t} variant="secondary" className="text-[10px]">
            {t}
          </Badge>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-end gap-1.5">
        <Button size="xs" variant="outline" disabled={busy} onClick={onReject}>
          {t('拒绝')}
        </Button>
        <Button size="xs" disabled={busy} onClick={onApprove}>
          {t('批准')}
        </Button>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// 「已激活」表格 + 展开的事件时间线

function ActiveDetail({ id }: { id: string }) {
  const detailQ = useQuery({ queryKey: ['memory', 'detail', id], queryFn: () => api.memoryDetail(id) });
  const now = useNow();
  const events = detailQ.data?.events ?? [];
  return (
    <div className="border-t bg-muted/20 p-3 animate-in fade-in slide-in-from-top-1 duration-200">
      {detailQ.isLoading ? <div className="text-[11px] text-muted-foreground">{t('加载中…')}</div> : null}
      {detailQ.isError ? <div className="text-[11px] text-destructive">{t('加载失败')}</div> : null}
      {!detailQ.isLoading && !detailQ.isError && events.length === 0 ? (
        <div className="text-[11px] text-muted-foreground">{t('还没有事件记录。')}</div>
      ) : null}
      {events.length > 0 ? (
        <ol className="relative ml-2 border-l pl-3">
          {events.map((e) => (
            <li key={e.id} className="relative pb-2 text-[11.5px]">
              <span className="absolute -left-[17px] top-1 size-2 rounded-full border-2 border-card bg-muted-foreground/50" />
              <span className="num text-[10.5px] text-muted-foreground">{relativeTime(e.at, now)}</span>
              <span className="ml-1.5 font-medium">{EVENT_KIND_LABEL[e.kind] ?? e.kind}</span>
              {e.detail ? <div className="mt-0.5 text-muted-foreground">{e.detail}</div> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function ActiveTable({
  items,
  expandedId,
  onToggle,
  onForget,
}: {
  items: MemoryItem[];
  expandedId: string | null;
  onToggle: (id: string) => void;
  onForget: (item: MemoryItem) => void;
}) {
  const now = useNow();
  return (
    <Table className="table-dense">
      <TableHeader>
        <TableRow>
          <TableHead className="w-6" />
          <TableHead>{t('类型')}</TableHead>
          <TableHead>{t('范围')}</TableHead>
          <TableHead>{t('内容')}</TableHead>
          <TableHead className="text-right">{t('信心')}</TableHead>
          <TableHead className="text-right">{t('用过几次')}</TableHead>
          <TableHead>{t('最近使用')}</TableHead>
          <TableHead>{t('创建时间')}</TableHead>
          <TableHead className="text-right">{t('操作')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.length === 0 ? (
          <TableRow>
            <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
              {t('没有已激活的记忆。')}
            </TableCell>
          </TableRow>
        ) : null}
        {items.map((item) => {
          const open = expandedId === item.id;
          return (
            <Fragment key={item.id}>
              <TableRow onClick={() => onToggle(item.id)} className={cn('cursor-pointer', open && 'bg-muted/40')}>
                <TableCell className="text-muted-foreground">{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-[10px]">
                    {KIND_LABEL[item.kind]}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{scopeText(item.scope)}</TableCell>
                <TableCell className="max-w-[360px] truncate" title={item.content}>
                  {item.content}
                </TableCell>
                <TableCell className="num text-right">{Math.round(item.confidence * 100)}%</TableCell>
                <TableCell className="num text-right">{item.use_count}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  {item.last_used_at ? relativeTime(item.last_used_at, now) : '—'}
                </TableCell>
                <TableCell className="num whitespace-nowrap text-muted-foreground">{fmtDateTime(item.created_at)}</TableCell>
                <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => onForget(item)}
                  >
                    {t('忘掉')}
                  </Button>
                </TableCell>
              </TableRow>
              {open ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={9} className="p-0">
                    <ActiveDetail id={item.id} />
                  </TableCell>
                </TableRow>
              ) : null}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// 「历史」表格(rejected / superseded / forgotten)

function HistoryTable({ items }: { items: MemoryItem[] }) {
  return (
    <Table className="table-dense">
      <TableHeader>
        <TableRow>
          <TableHead>{t('状态')}</TableHead>
          <TableHead>{t('类型')}</TableHead>
          <TableHead>{t('范围')}</TableHead>
          <TableHead>{t('内容')}</TableHead>
          <TableHead>{t('处理时间')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.length === 0 ? (
          <TableRow>
            <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
              {t('没有历史记录。')}
            </TableCell>
          </TableRow>
        ) : null}
        {items.map((item) => (
          <TableRow key={item.id} className="text-muted-foreground">
            <TableCell>
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                {STATUS_LABEL[item.status]}
              </Badge>
            </TableCell>
            <TableCell>
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                {KIND_LABEL[item.kind]}
              </Badge>
            </TableCell>
            <TableCell>{scopeText(item.scope)}</TableCell>
            <TableCell className="max-w-[420px] truncate" title={item.content}>
              {item.content}
            </TableCell>
            <TableCell className="num whitespace-nowrap">{fmtDateTime(item.decided_at ?? item.created_at)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// 搜索结果

function SearchResults({
  query,
  hits,
  isLoading,
  isError,
  onClear,
}: {
  query: string;
  hits: { item: MemoryItem; score: number; why: string[] }[];
  isLoading: boolean;
  isError: boolean;
  onClear: () => void;
}) {
  return (
    <Workspace className="shrink-0">
      <Pane
        title={t('搜索结果')}
        hint={`「${query}」`}
        actions={
          <Button size="xs" variant="ghost" onClick={onClear}>
            {t('清除')}
          </Button>
        }
      >
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto p-2">
          {isLoading ? (
            <>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </>
          ) : null}
          {isError ? <div className="py-4 text-center text-[11px] text-destructive">{t('搜索失败')}</div> : null}
          {!isLoading && !isError && hits.length === 0 ? (
            <div className="py-4 text-center text-[11px] text-muted-foreground">{t('没有匹配的记忆')}</div>
          ) : null}
          {hits.map((h) => (
            <div key={h.item.id} className="rounded-md border bg-card p-2.5 text-[12px]">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="text-[10px]">
                  {KIND_LABEL[h.item.kind]}
                </Badge>
                <Badge variant="outline" className="text-[10px] text-muted-foreground">
                  {STATUS_LABEL[h.item.status]}
                </Badge>
                <span className="text-muted-foreground">{scopeText(h.item.scope)}</span>
                <span className="num ml-auto text-[10.5px] text-muted-foreground">score {h.score.toFixed(2)}</span>
              </div>
              <p className="mt-1 leading-relaxed">{h.item.content}</p>
              {h.why.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {h.why.map((w, i) => (
                    <Badge key={i} variant="secondary" className="text-[10px]">
                      {w}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </Pane>
    </Workspace>
  );
}

// ---------------------------------------------------------------------------
// 页面

export function MemoryPage() {
  const queryClient = useQueryClient();
  const [symbolFilter, setSymbolFilter] = useState<string>('all');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [expandedActiveId, setExpandedActiveId] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(searchInput.trim()), 300);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const overviewQ = useQuery({ queryKey: ['overview'], queryFn: api.overview });
  const watchlist = overviewQ.data?.workflow.watchlist ?? [];

  const symbolParam = symbolFilter === 'all' ? undefined : symbolFilter;

  const listQ = useQuery({
    queryKey: ['memory', 'list', symbolFilter],
    queryFn: () => api.memoryList(undefined, symbolParam, 300),
    staleTime: 5_000,
  });

  const searchEnabled = debouncedQuery.length >= 3;
  const searchQ = useQuery({
    queryKey: ['memory', 'search', debouncedQuery, symbolFilter],
    queryFn: () => api.memorySearch(debouncedQuery, symbolParam),
    enabled: searchEnabled,
  });

  const reflect = useMutation({
    mutationFn: (limit?: number) => api.memoryReflect(limit),
    onSuccess: (res) => {
      toast.success(t('复盘提炼完了:新增 {added} 条提案(看了 {seen} 条,跳过 {skipped} 条)', { added: res.proposed.length, seen: res.considered, skipped: res.skipped }));
      void queryClient.invalidateQueries({ queryKey: ['memory'] });
    },
    onError: (err) => toast.error(t('复盘提炼失败'), { description: err instanceof Error ? err.message : String(err) }),
  });

  const createMemory = useMutation({
    mutationFn: (body: MemoryCreateRequest) => api.memoryCreate(body),
    onSuccess: () => {
      toast.success(t('记忆加好了'));
      setAddOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['memory'] });
    },
    onError: (err) => toast.error(t('添加失败'), { description: err instanceof Error ? err.message : String(err) }),
  });

  const act = useMutation({
    mutationFn: (vars: { id: string; action: 'approve' | 'reject' | 'forget'; reason?: string }) => api.memoryAction(vars.id, vars.action, vars.reason),
    onSuccess: (_res, vars) => {
      toast.success(vars.action === 'approve' ? t('已批准') : vars.action === 'reject' ? t('已拒绝') : t('已遗忘'));
      void queryClient.invalidateQueries({ queryKey: ['memory'] });
    },
    onError: (err) => toast.error(t('操作失败'), { description: err instanceof Error ? err.message : String(err) }),
  });

  const items = listQ.data?.items ?? [];
  const counts = listQ.data?.counts;
  const proposed = useMemo(() => [...items].filter((i) => i.status === 'proposed').sort((a, b) => b.created_at - a.created_at), [items]);
  const active = useMemo(
    () => [...items].filter((i) => i.status === 'active').sort((a, b) => (b.last_used_at ?? b.created_at) - (a.last_used_at ?? a.created_at)),
    [items],
  );
  const history = useMemo(
    () =>
      [...items]
        .filter((i) => i.status === 'rejected' || i.status === 'superseded' || i.status === 'forgotten')
        .sort((a, b) => (b.decided_at ?? b.created_at) - (a.decided_at ?? a.created_at)),
    [items],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <p className="shrink-0 text-[11px] text-muted-foreground">
        {t('记忆只调倾向和信心,不覆盖现场行情;判断引用了记忆,会在证据里显示成「记忆 mem-…」。')}
      </p>

      <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border bg-card px-3 py-2">
        <CountsRow counts={counts} />
        <div className="relative ml-1 w-56">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t('搜记忆(≥3 字)')}
            className="h-7 pl-7 text-[12px]"
          />
        </div>
        <Select value={symbolFilter} onValueChange={setSymbolFilter}>
          <SelectTrigger size="sm" className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('全部币种')}</SelectItem>
            {watchlist.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="outline" disabled={reflect.isPending} onClick={() => reflect.mutate(undefined)}>
            <Sparkles data-slot="icon" className={reflect.isPending ? 'animate-pulse' : undefined} />
            {reflect.isPending ? t('提炼中…') : t('复盘提炼')}
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus data-slot="icon" />
            {t('手动添加')}
          </Button>
        </div>
      </div>

      {searchEnabled ? (
        <SearchResults
          query={debouncedQuery}
          hits={searchQ.data?.hits ?? []}
          isLoading={searchQ.isLoading}
          isError={searchQ.isError}
          onClear={() => setSearchInput('')}
        />
      ) : null}

      <Tabs defaultValue="overview" className="min-h-0 flex-1">
        <TabsList>
          <TabsTrigger value="overview">{t('待批准 / 已激活')}</TabsTrigger>
          <TabsTrigger value="history">{t('历史')}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          <Workspace className="shrink-0">
            <Pane title={t('待批准')} hint={listQ.isLoading ? undefined : t('{n} 条', { n: proposed.length })}>
              {listQ.isLoading ? (
                <div className="flex flex-col gap-2 p-2">
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-24 w-full" />
                </div>
              ) : listQ.isError ? (
                <div className="py-8 text-center text-[12px] text-destructive">{t('加载失败')}</div>
              ) : proposed.length === 0 ? (
                <div className="py-8 text-center text-[12px] text-muted-foreground">{t('没有待批准的记忆')}</div>
              ) : (
                <div className="flex flex-col gap-2 p-2">
                  {proposed.map((item) => (
                    <ProposedCard
                      key={item.id}
                      item={item}
                      busy={act.isPending && act.variables?.id === item.id}
                      onApprove={() => act.mutate({ id: item.id, action: 'approve' })}
                      onReject={() => {
                        const reason = window.prompt(t('拒绝原因(可以留空):'));
                        if (reason === null) return;
                        act.mutate({ id: item.id, action: 'reject', reason: reason || undefined });
                      }}
                    />
                  ))}
                </div>
              )}
            </Pane>
          </Workspace>

          <Workspace className="min-h-0 flex-1">
            <Pane title={t('已激活')} hint={listQ.isLoading ? undefined : t('{n} 条', { n: active.length })} contentClassName="min-h-0 overflow-auto">
              {listQ.isLoading ? (
                <div className="flex flex-col gap-2 p-2">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : (
                <ActiveTable
                  items={active}
                  expandedId={expandedActiveId}
                  onToggle={(id) => setExpandedActiveId((cur) => (cur === id ? null : id))}
                  onForget={(item) => {
                    if (!window.confirm(`${t('确定忘掉这条记忆?')}\n${item.content}`)) return;
                    act.mutate({ id: item.id, action: 'forget' });
                  }}
                />
              )}
            </Pane>
          </Workspace>
        </TabsContent>

        <TabsContent value="history" className="min-h-0 overflow-y-auto">
          <Workspace>
            <Pane title={t('历史')} hint={listQ.isLoading ? undefined : t('{n} 条', { n: history.length })}>
              {listQ.isLoading ? (
                <div className="flex flex-col gap-2 p-2">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : (
                <HistoryTable items={history} />
              )}
            </Pane>
          </Workspace>
        </TabsContent>
      </Tabs>

      <AddMemoryDialog open={addOpen} onOpenChange={setAddOpen} watchlist={watchlist} pending={createMemory.isPending} onSubmit={(body) => createMemory.mutate(body)} />
    </div>
  );
}
