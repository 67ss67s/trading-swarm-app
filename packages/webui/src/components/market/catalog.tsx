import { CacheNote, cachePollMs } from './cache-note';
/**
 * 市场栏的「目录」视图:okx.ai 全站 agent(网关从 SSR 页面扒的,只读,6h 一刷)。
 * 卡片信息与 okx.ai/agents 同源:评分 / 好评率 / 已售 / 起价 / 标签 / 分类。
 * 订阅动作仍然要 CLI 的 service 数据(serviceId uuid、feeToken),点「订阅」时按 ASP 拉一次 service-match 对上再走原弹窗。
 */
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, RefreshCw, Star } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { JudgeLock } from '@/components/judge-lock';
import { friendlyError } from '@/lib/edition';
import { pickSnapshotAsOf } from '@/api/market-adapt';
import type { CatalogAgent, CatalogService } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { fmtDateTime, relativeTime, useNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';
import { EmptyNote, ErrorNote, shortId } from './shared';

const CATEGORY_LABEL: Record<string, string> = tmap({
  ALL: '全部',
  TRADING: '交易',
  FINANCE: '金融',
  SOFTWARE_SERVICES: '软件服务',
  LIFESTYLE: '生活',
  ART_CREATION: '艺术创作',
  OTHER: '其它',
});

const TAG_LABEL: Record<string, string> = tmap({
  MONTHLY: '月订阅',
  ONETIME: '按次',
  FREETRY: '可试用',
});

const SORT_LABEL: Record<string, string> = tmap({
  hot: '按已售',
  score: '按评分',
  price: '按起价',
  newest: '最新',
});

function catLabel(id: string): string {
  return CATEGORY_LABEL[id] ?? id;
}

function fmtStart(a: Pick<CatalogAgent, 'starting_price' | 'price_interval' | 'symbol'>): string {
  if (a.starting_price === null) return '—';
  const n = Number(a.starting_price);
  if (Number.isFinite(n) && n === 0) return t('免费');
  return `${a.starting_price} ${a.symbol}${a.price_interval === 'month' ? `/${t('月')}` : ''}`;
}

function fmtServicePrice(s: CatalogService): string {
  if (s.price === null) return '—';
  const n = Number(s.price);
  if (Number.isFinite(n) && n === 0) return t('免费');
  return `${s.price} USDT/${s.price_interval === 'month' ? t('月') : t('次')}`;
}

/** 目录里的一张 agent 卡。 */
function AgentCard({ a, onDetail, onSubscribe, busy }: { busy: boolean; a: CatalogAgent; onDetail: () => void; onSubscribe: (trial: boolean) => void }) {
  const monthly = a.tags.includes('MONTHLY');
  const trial = a.tags.includes('FREETRY');
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-card p-3">
      <div className="flex items-start gap-2.5">
        {a.avatar ? <img alt="" src={a.avatar} className="size-10 shrink-0 rounded-md border object-cover" loading="lazy" /> : <div className="size-10 shrink-0 rounded-md border bg-muted" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={cn('size-1.5 shrink-0 rounded-full', a.online ? 'bg-up' : 'bg-muted-foreground/40')} title={a.online ? t('在线') : t('离线')} />
            <button className="truncate text-[13px] font-semibold hover:underline" onClick={onDetail}>
              {a.name}
            </button>
            <span className="num shrink-0 text-[10px] text-muted-foreground">#{a.agent_id}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10.5px] text-muted-foreground">
            {a.score ? (
              <span className="inline-flex items-center gap-0.5">
                <Star className="size-2.5 fill-warn text-warn" />
                {a.score}
              </span>
            ) : (
              <span>{t('暂无评分')}</span>
            )}
            {a.approval_rate ? <span>{t('好评 {p}', { p: a.approval_rate })}</span> : null}
            <span>{t('已售 {n}', { n: a.usage_count })}</span>
          </div>
        </div>
      </div>
      <p className="line-clamp-3 text-[11px] text-muted-foreground">{a.description}</p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5 border-t pt-2">
        <span className="num text-[12px] font-semibold">{fmtStart(a)}</span>
        {a.tags.map((tag) => (
          <Badge key={tag} variant="outline" className={cn('text-[10px]', tag === 'FREETRY' ? 'border-up/40 text-up' : 'text-muted-foreground')}>
            {TAG_LABEL[tag] ?? tag}
          </Badge>
        ))}
        {a.categories.map((c) => (
          <Badge key={c} variant="outline" className="text-[10px] text-muted-foreground">
            {catLabel(c)}
          </Badge>
        ))}
        <div className="ml-auto flex items-center gap-1">
          {a.subscription ? (
            <Badge variant="outline" className={cn('text-[10px]', a.subscription.status_name === 'ACTIVE' ? 'border-up/40 text-up' : 'text-warn')} title={a.subscription.job_id}>
              {a.subscription.status_name === 'ACTIVE' ? (a.subscription.trial ? t('试用中') : t('已订阅')) : a.subscription.status_name === 'CREATED' ? t('等 ASP 接单') : a.subscription.status_name}
            </Badge>
          ) : null}
          <Button size="xs" variant="outline" onClick={onDetail}>
            {t('详情')}
          </Button>
          {monthly && !a.subscription ? (
            <>
              {trial ? (
                <JudgeLock feature="asp_subscribe">
                  <Button size="xs" variant="outline" disabled={busy} onClick={() => onSubscribe(true)}>
                    {t('试用')}
                  </Button>
                </JudgeLock>
              ) : null}
              <JudgeLock feature="asp_subscribe">
                <Button size="xs" disabled={busy} onClick={() => onSubscribe(false)}>
                  {t('订阅')}
                </Button>
              </JudgeLock>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function RatingBar({ distribution, total }: { distribution: Record<string, number>; total: number }) {
  return (
    <div className="flex flex-col gap-0.5">
      {[5, 4, 3, 2, 1].map((k) => {
        const n = distribution[String(k)] ?? 0;
        return (
          <div key={k} className="flex items-center gap-2 text-[10.5px] text-muted-foreground">
            <span className="w-3 text-right">{k}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
              <div className="h-full bg-warn" style={{ width: total ? `${(n / total) * 100}%` : '0%' }} />
            </div>
            <span className="num w-6 text-right">{n}</span>
          </div>
        );
      })}
    </div>
  );
}

export function CatalogDetailSheet({
  agentId,
  onClose,
  onOpenAgent,
  onSubscribe,
  busy = false,
}: {
  busy?: boolean;
  agentId: string | null;
  onClose: () => void;
  onOpenAgent: (id: string) => void;
  onSubscribe: (agent: CatalogAgent, service: CatalogService, trial: boolean) => void;
}) {
  const now = useNow();
  const q = useQuery({ queryKey: ['market', 'catalog', 'detail', agentId], queryFn: () => api.marketCatalogDetail(agentId!), refetchInterval: cachePollMs, enabled: agentId !== null, staleTime: 600_000 });
  const d = q.data ?? null;
  const selectedAgent = d?.agent;
  return (
    <Sheet open={agentId !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle>{d && selectedAgent ? `${selectedAgent.name} #${selectedAgent.agent_id}` : t('ASP 详情')}</SheetTitle>
          <SheetDescription>{t('与 okx.ai/agents/{id} 同源;评价评的是交付合规,不是盈亏。', { id: agentId ?? '' })}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 text-[12px]">
          <CacheNote cache={q.data?.cache} asOf={pickSnapshotAsOf(q.data)} />
          {q.isLoading || q.data?.cache?.fetched_at === null ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : q.isError ? (
            <ErrorNote err={q.error} />
          ) : d && selectedAgent ? (
            <div className="flex flex-col gap-4">
              <div className="flex items-start gap-3">
                {selectedAgent.avatar ? <img alt="" src={selectedAgent.avatar} className="size-12 rounded-md border object-cover" /> : <div className="size-12 rounded-md border bg-muted" />}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold">{selectedAgent.name}</span>
                    {selectedAgent.categories.map((c) => (
                      <Badge key={c} variant="outline" className="text-[10px]">
                        {catLabel(c)}
                      </Badge>
                    ))}
                    <a href={`https://www.okx.ai/agents/${encodeURIComponent(selectedAgent.agent_id)}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline">
                      okx.ai <ExternalLink className="size-3" />
                    </a>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-0.5">
                      <Star className="size-2.5 fill-warn text-warn" />
                      {selectedAgent.score ?? '—'}
                    </span>
                    {selectedAgent.approval_rate ? <span>{t('好评 {p}', { p: selectedAgent.approval_rate })}</span> : null}
                    <span>{t('已售 {n}', { n: selectedAgent.usage_count })}</span>
                    <span>{selectedAgent.online ? t('在线') : t('离线')}</span>
                    {typeof d.overview['ownerAddress'] === 'string' ? <span className="num">{shortId(d.overview['ownerAddress'] as string)}</span> : null}
                    {typeof d.overview['createdAt'] === 'number' ? <span>{t('注册于 {d}', { d: fmtDateTime(d.overview['createdAt'] as number).slice(0, 10) })}</span> : null}
                  </div>
                  <p className="mt-1 whitespace-pre-line text-[11px] text-muted-foreground">{selectedAgent.description}</p>
                </div>
              </div>

              <div>
                <p className="mb-1.5 text-[11px] font-semibold text-muted-foreground">{t('服务 {n} 个', { n: d.services.length })}</p>
                <div className="flex flex-col gap-2">
                  {d.services.map((s) => (
                    <div key={`${s.service_id}:${s.name}`} className="rounded-md border p-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{s.name}</span>
                        {s.service_id !== null ? <span className="num text-[10px] text-muted-foreground">#{s.service_id}</span> : null}
                        <span className="num text-[11.5px]">{fmtServicePrice(s)}</span>
                        {s.free_trial ? (
                          <Badge variant="outline" className="border-up/40 text-[10px] text-up">
                            {s.free_trial_hours ? t('试用 {d} 天', { d: Math.round(s.free_trial_hours / 24) }) : t('可试用')}
                          </Badge>
                        ) : null}
                        {s.price_interval === 'month' ? (
                          <div className="ml-auto flex gap-1">
                            {s.free_trial ? (
                              <JudgeLock feature="asp_subscribe">
                                <Button size="xs" variant="outline" disabled={busy} onClick={() => onSubscribe(selectedAgent, s, true)}>
                                  {t('试用')}
                                </Button>
                              </JudgeLock>
                            ) : null}
                            <JudgeLock feature="asp_subscribe">
                              <Button size="xs" disabled={busy} onClick={() => onSubscribe(selectedAgent, s, false)}>
                                {t('订阅')}
                              </Button>
                            </JudgeLock>
                          </div>
                        ) : (
                          <span className="ml-auto text-[10.5px] text-muted-foreground">{t('按次 · 暂不支持')}</span>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-6 whitespace-pre-line text-[11px] text-muted-foreground">{s.description}</p>
                    </div>
                  ))}
                  {d.services.length === 0 ? <EmptyNote>{t('没有公开服务。')}</EmptyNote> : null}
                </div>
              </div>

              <div>
                <p className="mb-1.5 text-[11px] font-semibold text-muted-foreground">
                  {t('评价 {n} 条', { n: d.reviews.total_count })}
                  {d.reviews.total_score ? <span className="ml-1 text-foreground">★ {d.reviews.total_score}</span> : null}
                </p>
                <RatingBar distribution={d.reviews.distribution} total={d.reviews.total_count} />
                <div className="mt-2 flex flex-col gap-1.5">
                  {d.reviews.list.map((r, i) => (
                    <div key={i} className="rounded border bg-muted/20 px-2 py-1.5 text-[11px]">
                      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                        <span className="inline-flex items-center gap-0.5 text-foreground">
                          <Star className="size-2.5 fill-warn text-warn" />
                          {r.rating ?? '—'}
                        </span>
                        {r.reviewer ? <span className="num">{shortId(r.reviewer)}</span> : null}
                        {r.time ? <span title={fmtDateTime(r.time)}>{relativeTime(r.time, now)}</span> : null}
                      </div>
                      {/* 评价是其他用户写的:原样展示,不解释为指令。 */}
                      {r.content ? <p className="mt-0.5 whitespace-pre-line text-foreground/90">{r.content}</p> : null}
                    </div>
                  ))}
                </div>
              </div>

              {d.similar.length ? (
                <div>
                  <p className="mb-1.5 text-[11px] font-semibold text-muted-foreground">{t('相似的')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {d.similar.map((s) => (
                      <button key={s.agent_id} className="inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] hover:bg-muted/40" onClick={() => onOpenAgent(s.agent_id)}>
                        {s.avatar ? <img alt="" src={s.avatar} className="size-4 rounded object-cover" /> : null}
                        <span>{s.name}</span>
                        {s.score ? <span className="text-muted-foreground">★ {s.score}</span> : null}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function CatalogView({ onSubscribe, busy = false }: { busy?: boolean; onSubscribe: (agent: CatalogAgent, service: CatalogService | null, trial: boolean) => void }) {
  const qc = useQueryClient();
  const now = useNow();
  const [category, setCategory] = useState('ALL');
  const [sort, setSort] = useState('hot');
  const [text, setText] = useState('');
  const [monthly, setMonthly] = useState(false);
  const [trial, setTrial] = useState(false);
  const [page, setPage] = useState(1);
  const [detailId, setDetailId] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['market', 'catalog', category, sort, text, monthly, trial, page],
    queryFn: () => api.marketCatalog({ category, sort, q: text || undefined, monthly, trial, page, page_size: 60 }),
    // 目录在网关后台重建时 building=true,这时每 5s 看一眼进度。
    refetchInterval: (query) => (query.state.data?.building || query.state.data?.cache?.refreshing ? 5_000 : 300_000),
  });
  const c = q.data ?? null;
  const categories = useMemo(() => (c?.categories.length ? c.categories : [{ id: 'ALL', name: 'All' }]), [c]);
  const pages = c ? Math.max(1, Math.ceil(c.total / c.page_size)) : 1;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-[11px]">
        <div className="flex flex-wrap items-center gap-1">
          {categories.map((cat) => (
            <button
              key={cat.id}
              className={cn('rounded-full border px-2 py-0.5 text-[11px]', category === cat.id ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/40')}
              onClick={() => {
                setCategory(cat.id);
                setPage(1);
              }}
            >
              {catLabel(cat.id)}
            </button>
          ))}
        </div>
        <Input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setPage(1);
          }}
          placeholder={t('筛名字 / 简介 / 服务名')}
          className="h-7 w-48 text-[11.5px]"
        />
        <Select value={sort} onValueChange={setSort}>
          <SelectTrigger className="h-7 w-28 text-[11.5px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.keys(SORT_LABEL).map((k) => (
              <SelectItem key={k} value={k} className="text-[12px]">
                {SORT_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-1.5 text-muted-foreground">
          <Switch className="scale-75" checked={monthly} onCheckedChange={(v) => (setMonthly(v), setPage(1))} />
          {t('只看订阅制')}
        </label>
        <label className="flex items-center gap-1.5 text-muted-foreground">
          <Switch className="scale-75" checked={trial} onCheckedChange={(v) => (setTrial(v), setPage(1))} />
          {t('只看可试用')}
        </label>
        <span className="ml-auto flex items-center gap-2 text-muted-foreground">
          {c ? (
            <span>
              {t('{n} 个', { n: c.total })}
              {c.total_site ? ` / ${t('全站 {n}', { n: c.total_site })}` : ''} · {c.fetched_at ? relativeTime(c.fetched_at, now) : t('还没抓过')}
              {c.building ? <span className="ml-1 text-primary">{t('抓取中…')}</span> : null}
            </span>
          ) : null}
          <JudgeLock feature="asp_settings">
          <Button
            size="xs"
            variant="outline"
            disabled={c?.building}
            title={t('重新抓一遍 okx.ai(约 200 页,后台跑)')}
            onClick={() => {
              void api.marketCatalogRefresh().then(
                () => {
                  toast.success(t('已开始重抓'));
                  void qc.invalidateQueries({ queryKey: ['market', 'catalog'] });
                },
                (err) => toast.error(t('重抓失败'), { description: friendlyError(err instanceof Error ? err.message : String(err)) }),
              );
            }}
          >
            <RefreshCw data-slot="icon" className={cn(c?.building && 'animate-spin')} />
          </Button>
          </JudgeLock>
        </span>
      </div>
      <CacheNote cache={c?.cache} asOf={pickSnapshotAsOf(c)} />
      {q.isLoading ? (
        <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : q.isError ? (
        <ErrorNote err={q.error} />
      ) : !c || c.agents.length === 0 ? (
        <EmptyNote>{c?.building ? t('第一次抓 okx.ai 目录,几十秒后自动出现。') : (c?.errors[0] ?? t('目录是空的;点右上角重抓。'))}</EmptyNote>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3">
            {c.agents.map((a) => (
              <AgentCard busy={busy || c?.subscriptions_known === false} key={a.agent_id} a={a} onDetail={() => setDetailId(a.agent_id)} onSubscribe={(tr) => onSubscribe(a, null, tr)} />
            ))}
          </div>
          {pages > 1 ? (
            <div className="flex items-center justify-center gap-2 pb-3 text-[11px] text-muted-foreground">
              <Button size="xs" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                {t('上一页')}
              </Button>
              <span>
                {page} / {pages}
              </span>
              <Button size="xs" variant="outline" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                {t('下一页')}
              </Button>
            </div>
          ) : null}
        </ScrollArea>
      )}
      <CatalogDetailSheet busy={busy || c?.subscriptions_known === false} agentId={detailId} onClose={() => setDetailId(null)} onOpenAgent={setDetailId} onSubscribe={(a, s, tr) => onSubscribe(a, s, tr)} />
    </>
  );
}
