import { pickSnapshotAsOf, waitForMarketRead } from '@/api/market-adapt';
import { JudgeLock } from '@/components/judge-lock';
import { friendlyMarketError } from '@/components/market/judge';
import { CacheNote, cachePollMs } from './cache-note';
/**
 * 「市场」栏:搜 OKX.AI 上的 ASP 服务(`service-match` 直通)、看详情、试用 / 订阅。
 * 订阅确认弹窗是我们自己画的;网关跑 `create-subscribe`,**不带任何 autotrade 参数**,
 * 成功后把本机加进接收设备集合并写本地模式配置(设计 §2.3)。
 */
import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Search, Star } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { CatalogAgent, CatalogService, FollowApproval, FollowMode, MarketAspDetail, MarketFundingNotice, MarketService, MarketStatus } from '@/api/types';
import { resolveCatalogService } from '@/api/market-adapt';
import { CatalogView } from './catalog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FOLLOW_MODES, FOLLOW_MODE_LABEL } from '@/api/types';
import { Pane } from '@/components/pane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { EmptyNote, ErrorNote, MODE_HINT, fmtServicePrice, fmtTrial, fmtUsdt, isSubscriptionService } from './shared';

const DEFAULT_KEYWORDS = '信号 signal 合约 perp'; // i18n-ignore(OKX.AI 目录搜索词,服务标题多为中文,中英都要)

function aspUrl(agentId: string): string {
  return `https://www.okx.ai/agents/${encodeURIComponent(agentId)}`;
}

function ServiceCard({ s, onDetail, onSubscribe }: { s: MarketService; onDetail: () => void; onSubscribe: (trial: boolean) => void }) {
  const trial = fmtTrial(s);
  const subscribable = isSubscriptionService(s);
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={cn('size-1.5 shrink-0 rounded-full', s.asp.online ? 'bg-up' : 'bg-muted-foreground/40')} title={s.asp.online ? t('在线') : t('离线')} />
            <button className="truncate text-[13px] font-semibold hover:underline" onClick={onDetail}>
              {s.asp.asp_name}
            </button>
            <span className="num shrink-0 text-[10px] text-muted-foreground">#{s.asp.asp_agent_id}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10.5px] text-muted-foreground">
            {s.asp.rating ? (
              <span className="inline-flex items-center gap-0.5">
                <Star className="size-2.5 fill-warn text-warn" />
                {s.asp.rating.replace('★', '').trim()}
              </span>
            ) : (
              <span>{t('暂无评分')}</span>
            )}
            {s.asp.feedback_rate !== null ? <span>{t('好评 {p}%', { p: s.asp.feedback_rate.toFixed(0) })}</span> : null}
            <span>{t('已售 {n}', { n: s.asp.sold_count })}</span>
          </div>
        </div>
        <Badge variant="outline" className="shrink-0 text-[10px]">
          {s.service_type}
        </Badge>
      </div>
      <div className="min-w-0">
        <div className="truncate text-[12px] font-medium">{s.service_name}</div>
        {/* 描述来自其他用户,原样展示、当不可信文本。 */}
        <p className="mt-0.5 line-clamp-3 whitespace-pre-line text-[11px] text-muted-foreground">{s.service_description}</p>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-2 border-t pt-2">
        <span className="num text-[12px] font-semibold">{fmtServicePrice(s)}</span>
        {trial ? (
          <Badge variant="outline" className="border-up/40 text-[10px] text-up">
            {trial}
          </Badge>
        ) : null}
        {s.is_subscribing ? (
          <Badge variant="outline" className="border-primary/40 text-[10px] text-primary">
            {t('已订阅')}
          </Badge>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <Button size="xs" variant="outline" onClick={onDetail}>
            {t('详情')}
          </Button>
          {subscribable && !s.is_subscribing ? (
            <>
              {trial ? (
                <JudgeLock feature="asp_subscribe">
                  <Button size="xs" variant="outline" onClick={() => onSubscribe(true)}>
                    {t('试用')}
                  </Button>
                </JudgeLock>
              ) : null}
              <JudgeLock feature="asp_subscribe">
                <Button size="xs" onClick={() => onSubscribe(false)}>
                  {t('订阅')}
                </Button>
              </JudgeLock>
            </>
          ) : !subscribable ? (
            <span className="text-[10.5px] text-muted-foreground" title={t('按次服务要发任务而不是订阅,这一版只接订阅制')}>
              {t('按次 · 暂不支持')}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DetailSheet({ agentId, onClose, onSubscribe }: { agentId: string | null; onClose: () => void; onSubscribe: (s: MarketService, trial: boolean) => void }) {
  const q = useQuery({ queryKey: ['market', 'asp-detail', agentId], queryFn: () => api.marketAspDetail(agentId!), refetchInterval: cachePollMs, enabled: agentId !== null, staleTime: 300_000 });
  const d: MarketAspDetail | null = q.data ?? null;
  return (
    <Sheet open={agentId !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle>{d ? `${d.profile.name} #${d.profile.agent_id}` : t('ASP 详情')}</SheetTitle>
          <SheetDescription>{t('资料 / 服务 / 评价。评价评的是交付合规,不是盈亏;市场上看不到 ASP 历史业绩。')}</SheetDescription>
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
          ) : d ? (
            <div className="flex flex-col gap-4">
              <div className="flex items-start gap-3">
                {d.profile.avatar ? <img alt="" src={d.profile.avatar} className="size-12 rounded-md border object-cover" /> : <div className="size-12 rounded-md border bg-muted" />}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold">{d.profile.name}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {d.profile.role}
                    </Badge>
                    <Badge variant="outline" className="text-[10px]">
                      {d.profile.status}
                    </Badge>
                    <a href={aspUrl(d.profile.agent_id)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline">
                      okx.ai <ExternalLink className="size-3" />
                    </a>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                    <span>{d.profile.rating ?? t('暂无评分')}</span>
                    {d.profile.feedback_rate !== null ? <span>{t('好评 {p}%', { p: d.profile.feedback_rate.toFixed(0) })}</span> : null}
                    <span>{t('已售 {n}', { n: d.profile.sold_count })}</span>
                    <span>{d.profile.online ? t('在线') : t('离线')}</span>
                  </div>
                  {d.profile.description ? <p className="mt-1 whitespace-pre-line text-[11px] text-muted-foreground">{d.profile.description}</p> : null}
                </div>
              </div>

              <div>
                <p className="mb-1.5 text-[11px] font-semibold text-muted-foreground">{t('服务')}</p>
                <div className="flex flex-col gap-2">
                  {d.services.map((s) => (
                    <div key={s.service_id} className="rounded-md border p-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{s.service_name}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {s.service_type}
                        </Badge>
                        <span className="num text-[11.5px]">{fmtServicePrice(s)}</span>
                        {fmtTrial(s) ? (
                          <Badge variant="outline" className="border-up/40 text-[10px] text-up">
                            {fmtTrial(s)}
                          </Badge>
                        ) : null}
                        {s.is_subscribing ? (
                          <Badge variant="outline" className="border-primary/40 text-[10px] text-primary">
                            {t('已订阅')}
                          </Badge>
                        ) : null}
                        {isSubscriptionService(s) && !s.is_subscribing ? (
                          <div className="ml-auto flex gap-1">
                            {fmtTrial(s) ? (
                              <JudgeLock feature="asp_subscribe">
                                <Button size="xs" variant="outline" onClick={() => onSubscribe(s, true)}>
                                  {t('试用')}
                                </Button>
                              </JudgeLock>
                            ) : null}
                            <JudgeLock feature="asp_subscribe">
                              <Button size="xs" onClick={() => onSubscribe(s, false)}>
                                {t('订阅')}
                              </Button>
                            </JudgeLock>
                          </div>
                        ) : null}
                      </div>
                      <p className="mt-1 whitespace-pre-line text-[11px] text-muted-foreground">{s.service_description}</p>
                    </div>
                  ))}
                  {d.services.length === 0 ? <EmptyNote>{t('没有公开服务。')}</EmptyNote> : null}
                </div>
              </div>

              <div>
                <p className="mb-1.5 text-[11px] font-semibold text-muted-foreground">{t('评价 {n} 条', { n: d.feedback.length })}</p>
                {d.feedback_error ? <p className="text-[11px] text-warn">{friendlyMarketError(d.feedback_error)}</p> : null}
                <div className="flex flex-col gap-1.5">
                  {d.feedback.map((f, i) => (
                    <div key={i} className="rounded border bg-muted/20 px-2 py-1.5 text-[11px]">
                      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                        <span className="inline-flex items-center gap-0.5 text-foreground">
                          <Star className="size-2.5 fill-warn text-warn" />
                          {f.score === null ? '—' : f.score.toFixed(2)}
                        </span>
                        {f.reviewer ? <span>{f.reviewer}</span> : null}
                        {f.date ? <span>{f.date}</span> : null}
                      </div>
                      {f.description ? <p className="mt-0.5 whitespace-pre-line text-foreground/90">{f.description}</p> : null}
                    </div>
                  ))}
                  {d.feedback.length === 0 && !d.feedback_error ? <EmptyNote>{t('还没有评价。')}</EmptyNote> : null}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** 订阅 / 试用确认弹窗。 */
function SubscribeDialog({
  target,
  status,
  onClose,
  onDone,
}: {
  target: { service: MarketService; trial: boolean } | null;
  status: MarketStatus | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const s = target?.service ?? null;
  const [autoRenew, setAutoRenew] = useState(false);
  const [mode, setMode] = useState<FollowMode>(status?.settings.default_mode ?? 'evidence');
  const [approval, setApproval] = useState<FollowApproval>('manual');
  const [weight, setWeight] = useState('1');
  const [title, setTitle] = useState('');
  const qc = useQueryClient();
  const [notice, setNotice] = useState<MarketFundingNotice | null>(null);
  const sub = useMutation({
    retry: false,
    mutationFn: () =>
      api.marketSubscribe({
        service_id: s!.service_id,
        provider_agent_id: s!.asp.asp_agent_id,
        fee_amount: s!.subscription.find((p) => p.interval === 'month')?.fee ?? s!.fee_amount ?? '0',
        fee_token_address: s!.fee_token_address ?? '',
        use_trial: target!.trial,
        auto_renew: autoRenew,
        title: title || `trade-gate · ${s!.service_name}`,
        description: t('trade-gate 信号市场订阅:投递进本机网关账本,人工/agent 判定后才执行。'),
        mode,
        approval,
        weight: Math.max(0, Math.min(1, Number(weight) || 0)),
      }),
    onSuccess: (r) => {
      if (r.funding_notice) {
        setNotice(r.funding_notice);
        toast.error(t('钱包余额不够'), { description: r.message ?? undefined });
        return;
      }
      if (!r.ok) {
        toast.error(t('订阅失败'), { description: r.message ?? undefined });
        return;
      }
      toast.success(target!.trial ? t('试用已开通') : t('已订阅'), {
        description: r.device_added ? t('本机已加入接收设备') : r.message ?? t('注意:本机没能加进接收设备,去「订阅」栏切一下'),
        duration: r.device_added ? 5000 : 15000,
      });
      onDone();
    },
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['market'] }); },
    onError: (err) => {
      toast.error(t('订阅失败'), { description: friendlyMarketError(err instanceof Error ? err.message : String(err)) });
    },
  });
  const fee = s ? fmtServicePrice(s) : '';
  return (
    <Dialog
      open={s !== null}
      onOpenChange={(o) => {
        if (!o && !sub.isPending) {
          setNotice(null);
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{target?.trial ? t('开通试用') : t('确认订阅')}</DialogTitle>
          <DialogDescription>{s ? `${s.asp.asp_name} · ${s.service_name}` : ''}</DialogDescription>
        </DialogHeader>
        {s ? (
          <div className="flex flex-col gap-3 text-[12px]">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded border bg-muted/20 p-2.5 text-[11px]">
              <span className="text-muted-foreground">
                {t('费用')} <span className="num text-foreground">{target?.trial ? t('试用期免费,之后 {fee}', { fee }) : fee}</span>
              </span>
              <span className="text-muted-foreground">
                {t('钱包余额')} <span className="num text-foreground">{fmtUsdt(status?.wallet.balance_usdt ?? null)}</span>
              </span>
              <span className="text-muted-foreground">
                {t('扣款')} <span className="text-foreground">{t('Agentic Wallet · XLayer USDT')}</span>
              </span>
              <span className="text-muted-foreground">
                {t('接收设备')} <span className="text-foreground">{status?.this_device?.name ?? t('本机')}</span>
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{t('订阅标题(给 OKX 那边看的)')}</Label>
              <Input maxLength={30} value={title} placeholder={`trade-gate · ${s.service_name}`} onChange={(e) => setTitle(e.target.value)} className="h-7 text-[11.5px]" />
            </div>
            <div className="flex items-center justify-between">
              <Label>{t('自动续费')}</Label>
              <div className="flex items-center gap-2">
                <span className="text-[10.5px] text-muted-foreground">{autoRenew ? t('到期自动扣下一期(要签 EIP-712)') : target?.trial ? t('试用到期仍会转付费，需提前取消转付费') : t('到期即止')}</span>
                <Switch checked={autoRenew} onCheckedChange={setAutoRenew} />
              </div>
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <div className="flex flex-col gap-1.5">
                <Label>{t('本地判定模式')}</Label>
                <Select value={mode} onValueChange={(v) => setMode(v as FollowMode)}>
                  <SelectTrigger className="h-7 text-[11.5px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FOLLOW_MODES.map((m) => (
                      <SelectItem key={m} value={m} className="text-[12px]">
                        {FOLLOW_MODE_LABEL[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex w-24 flex-col gap-1.5">
                <Label>{t('权重')}</Label>
                <Input type="number" min={0} max={1} step={0.05} value={weight} onChange={(e) => setWeight(e.target.value)} className="h-7 text-[11.5px]" />
              </div>
            </div>
            <p className={cn('text-[10.5px]', mode === 'book' ? 'text-warn' : 'text-muted-foreground')}>{MODE_HINT[mode]}</p>
            {mode === 'book' ? (
              <div className="flex items-center justify-between">
                <Label>{t('组合经理过闸之后')}</Label>
                <Select value={approval} onValueChange={(v) => setApproval(v as FollowApproval)}>
                  <SelectTrigger className="h-7 w-56 text-[11.5px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual" className="text-[12px]">
                      {t('生成待批意图,交易页点确认')}
                    </SelectItem>
                    <SelectItem value="auto" className="text-[12px]">
                      {t('直接交执行(自动下单)')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <p className="text-[10.5px] text-muted-foreground">{t('不走 OKX 自己的自动交易授权(autotrade);信号进本机账本,执行只发生在 trade-gate 的闸门之后。')}</p>
            {notice ? (
              <div className="flex flex-col items-center gap-2 rounded border border-warn/40 bg-warn/10 p-2.5">
                <span className="text-[11px] font-medium text-warn">{t('余额不够,先往 Agentic Wallet 充 XLayer USDT')}</span>
                {notice.qr_png_base64 ? <img alt="deposit qr" className="size-36 rounded border bg-white p-1" src={`data:image/png;base64,${notice.qr_png_base64}`} /> : null}
                {notice.deposit_address ? <span className="num break-all text-center text-[10.5px]">{notice.deposit_address}</span> : null}
                {notice.shortfall ? (
                  <span className="text-[10.5px] text-muted-foreground">
                    {t('缺口')} {notice.shortfall} {notice.currency ?? 'USDT'}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {sub.error ? <p role="alert" className="whitespace-pre-wrap break-words text-[12px] text-down">{friendlyMarketError(sub.error.message)}</p> : null}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={sub.isPending}>
            {t('取消')}
          </Button>
          <JudgeLock feature="asp_subscribe">
            <Button size="sm" onClick={() => sub.mutate()} disabled={sub.isPending || !status?.wallet.logged_in}>
              {sub.isPending ? t('签名中…') : target?.trial ? t('开通试用') : t('确认订阅')}
            </Button>
          </JudgeLock>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BrowseTab({ status, onSubscribed }: { status: MarketStatus | null; onSubscribed: () => void }) {
  const qc = useQueryClient();
  const [keywords, setKeywords] = useState(DEFAULT_KEYWORDS);
  const [submitted, setSubmitted] = useState(DEFAULT_KEYWORDS);
  const [onlyTrial, setOnlyTrial] = useState(false);
  const [onlySub, setOnlySub] = useState(true);
  const [maxFee, setMaxFee] = useState('');
  const [pages, setPages] = useState<MarketService[][]>([]);
  const [after, setAfter] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [subTarget, setSubTarget] = useState<{ service: MarketService; trial: boolean } | null>(null);
  const [mode, setMode] = useState<'catalog' | 'search'>('catalog');
  const [resolving, setResolving] = useState(false);
  const resolvingRef = useRef(false);
  /** 目录卡片点「订阅」:目录只有网页字段,订阅要 CLI 的 serviceId uuid / feeToken,按 ASP 拉一次 service-match 对上。 */
  const resolveAndSubscribe = async (agent: CatalogAgent, service: CatalogService | null, trial: boolean) => {
    if (resolvingRef.current) return;
    resolvingRef.current = true; setResolving(true);
    try {
      const r = await waitForMarketRead(() => api.marketServicesOf(agent.agent_id));
      const hit = resolveCatalogService(r.services, service, trial);
      setSubTarget({ service: hit, trial });
    } catch (err) {
      toast.error(t('拉不到服务信息'), { description: friendlyMarketError(err instanceof Error ? err.message : String(err)) });
    } finally {
      resolvingRef.current = false; setResolving(false);
    }
  };

  const q = useQuery({
    queryKey: ['market', 'search', submitted, maxFee],
    refetchInterval: cachePollMs, queryFn: () => api.marketSearch({ keywords: submitted, max_fee: maxFee || undefined }),
    staleTime: 60_000,
    enabled: mode === 'search',
  });
  const more = useMutation({
    mutationFn: () => waitForMarketRead(() => api.marketSearch({ after: after ?? q.data?.search_after ?? undefined })),
    onSuccess: (r) => {
      setPages((p) => [...p, r.services]);
      setAfter(r.search_after);
    },
    onError: (err) => toast.error(t('翻页失败'), { description: friendlyMarketError(err instanceof Error ? err.message : String(err)) }),
  });

  const services = useMemo(() => {
    const all = [...(q.data?.services ?? []), ...pages.flat()];
    return all.filter((s) => (!onlyTrial || fmtTrial(s) !== null) && (!onlySub || isSubscriptionService(s)));
  }, [q.data, pages, onlyTrial, onlySub]);
  const hasMore = pages.length ? after !== null : (q.data?.has_more ?? false);

  return (
    <Pane
      title={t('市场')}
      hint={mode === 'catalog' ? t('okx.ai 全站目录(网页同源,只读)') : t('OKX.AI 关键词搜索(CLI service-match,一页一条)')}
      className="min-h-0 flex-1"
      contentClassName="flex min-h-0 flex-col"
      actions={
        <>
        <Tabs value={mode} onValueChange={(v) => setMode(v as 'catalog' | 'search')}>
          <TabsList className="h-7">
            <TabsTrigger value="catalog" className="h-6 px-2 text-[11px]">
              {t('目录')}
            </TabsTrigger>
            <TabsTrigger value="search" className="h-6 px-2 text-[11px]">
              {t('搜索')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {mode === 'search' ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            setPages([]);
            setAfter(null);
            setSubmitted(keywords.trim() || DEFAULT_KEYWORDS);
          }}
        >
          <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder={t('关键词,空格分开')} className="h-7 w-56 text-[11.5px]" />
          <Input value={maxFee} onChange={(e) => setMaxFee(e.target.value)} placeholder={t('价格上限')} type="number" min={0} className="h-7 w-24 text-[11.5px]" />
          <Button size="xs" type="submit" variant="outline" disabled={q.isFetching}>
            <Search data-slot="icon" />
            {t('搜索')}
          </Button>
        </form>
        ) : null}
        </>
      }
    >
      {mode === 'catalog' ? (
        <>
          {resolving ? <div className="border-b bg-primary/5 px-3 py-1 text-[10.5px] text-primary">{t('正在从 CLI 对服务信息…')}</div> : null}
          <CatalogView busy={resolving} onSubscribe={(a, s, tr) => void resolveAndSubscribe(a, s, tr)} />
        </>
      ) : (
      <>
      <div className="flex flex-wrap items-center gap-4 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
        <label className="flex items-center gap-1.5">
          <Switch className="scale-75" checked={onlySub} onCheckedChange={setOnlySub} />
          {t('只看订阅制')}
        </label>
        <label className="flex items-center gap-1.5">
          <Switch className="scale-75" checked={onlyTrial} onCheckedChange={setOnlyTrial} />
          {t('只看可试用')}
        </label>
        <span className="ml-auto">{t('{n} 个服务', { n: services.length })}</span>
      </div>
      <CacheNote cache={q.data?.cache} asOf={pickSnapshotAsOf(q.data)} />
      {q.isLoading || q.data?.cache?.fetched_at === null ? (
        <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : q.isError ? (
        <ErrorNote err={q.error} />
      ) : services.length === 0 ? (
        <EmptyNote>{friendlyMarketError(q.data?.unmatch_reason) ?? t('没搜到服务;换个关键词,或者关掉筛选。')}</EmptyNote>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3">
            {services.map((s) => (
              <ServiceCard key={`${s.asp.asp_agent_id}:${s.service_id}`} s={s} onDetail={() => setDetailId(s.asp.asp_agent_id)} onSubscribe={(trial) => setSubTarget({ service: s, trial })} />
            ))}
          </div>
          {hasMore ? (
            <div className="flex justify-center pb-3">
              <Button size="sm" variant="outline" disabled={more.isPending} onClick={() => more.mutate()}>
                {t('再来一页')}
              </Button>
            </div>
          ) : null}
        </ScrollArea>
      )}
      </>
      )}

      <DetailSheet agentId={detailId} onClose={() => setDetailId(null)} onSubscribe={(s, trial) => setSubTarget({ service: s, trial })} />
      <SubscribeDialog
        key={`${subTarget?.service.service_id ?? 'closed'}:${subTarget?.trial}`}
        target={subTarget}
        status={status}
        onClose={() => setSubTarget(null)}
        onDone={() => {
          setSubTarget(null);
          void qc.invalidateQueries({ queryKey: ['market'] });
          onSubscribed();
        }}
      />
    </Pane>
  );
}
