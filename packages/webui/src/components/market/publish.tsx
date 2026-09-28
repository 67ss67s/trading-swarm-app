/**
 * 「发布」栏(卖方侧,设计 docs/design/signal-market-ux-2026-09-25.md「发布」):
 *   ASP 身份条 → 新手引导(可关闭)→ 售后待办(只在有记录时出现)→ 我的产品(汇总一行 + 卡片网格,展开看订阅者 / 订单)。
 * 策略信号的推送设置与推送记录收进「策略信号」卡的展开区。
 * 没有 ASP 身份时整栏是引导 + 注册表单(校验 → 确认 → 上链注册)。
 */
import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { aspProductsApi, type AspProduct } from '@/api/asp-products';
import type { MarketAftersale, MarketAsp } from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CacheNote, cachePollMs } from '@/components/market/cache-note';
import { Pane, Workspace } from '@/components/pane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { JudgeLock } from '@/components/judge-lock';
import { friendlyMarketError } from '@/components/market/judge';
import { pickSnapshotAsOf } from '@/api/market-adapt';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { fmtDateTime, relativeTime, useNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { AdjustDialog } from './products/adjust-dialog';
import { IdentityBar } from './products/identity-bar';
import { PRODUCTS_KEY, errText, fallbackChecklist, identityPhase, readDismissed, sortProducts, summarize, summaryLine as productsSummaryLine, writeDismissed } from './products/labels';
import { OnboardingCard } from './products/onboarding-card';
import { PreviewDialog } from './products/preview-dialog';
import { ProductCard } from './products/product-card';
import { RegisterForm } from './products/register-form';
import { AFTERSALE_STATUS_LABEL, EmptyNote, ErrorNote, shortId } from './shared';

// ---------------------------------------------------------------------------
// 售后(买家拒收)

function AftersaleRow({ a, now, onDecide, busy }: { a: MarketAftersale; now: number; onDecide: (decision: 'agree_refund' | 'dispute') => void; busy: boolean }) {
  return (
    <div className="flex flex-col gap-1 border-b px-3 py-2 text-[11.5px] last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={cn('text-[10px]', a.status === 'pending' ? 'border-warn/40 text-warn' : 'text-muted-foreground')}>
          {AFTERSALE_STATUS_LABEL[a.status]}
        </Badge>
        <span>{t('买家拒收')}</span>
        {a.buyer_agent_id ? <span className="num text-muted-foreground">#{a.buyer_agent_id}</span> : null}
        <span className="num text-muted-foreground" title={a.job_id}>
          {shortId(a.job_id, 6, 4)}
        </span>
        {a.period_index !== null ? <span className="text-muted-foreground">{t('第 {n} 期', { n: a.period_index })}</span> : null}
        {a.deadline_at && a.status === 'pending' ? (
          <span className={cn('ml-auto', a.deadline_at - now < 6 * 3_600_000 ? 'text-down' : 'text-muted-foreground')} title={fmtDateTime(a.deadline_at)}>
            {t('截止')} {relativeTime(a.deadline_at, now)}
          </span>
        ) : null}
      </div>
      {a.reason ? <p className="whitespace-pre-line text-[11px] text-muted-foreground">{a.reason}</p> : null}
      {a.status === 'pending' ? (
        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <JudgeLock feature="asp_reply">
            <Button size="xs" variant="outline" disabled={busy} onClick={() => onDecide('agree_refund')}>
              {t('同意退款')}
            </Button>
          </JudgeLock>
          <JudgeLock feature="asp_reply">
            <Button size="xs" variant="destructive" disabled={busy} onClick={() => onDecide('dispute')}>
              {t('提争议')}
            </Button>
          </JudgeLock>
          <span className="text-[10.5px] text-muted-foreground">{t('超时不处理 = 自动退款')}</span>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 我的产品

function ProductsSection({
  q,
  products,
  asp,
  now,
  expanded,
  setExpanded,
  pauseBusy,
  onPreview,
  onPause,
  onAdjust,
  onShowGuide,
}: {
  q: { isLoading: boolean; isError: boolean; error: unknown; isFetching: boolean; refetch: () => unknown };
  products: AspProduct[];
  asp: MarketAsp | null;
  now: number;
  expanded: string | null;
  setExpanded: (k: string | null) => void;
  pauseBusy: boolean;
  onPreview: (p: AspProduct) => void;
  onPause: (p: AspProduct) => void;
  onAdjust: (p: AspProduct) => void;
  onShowGuide: (() => void) | null;
}) {
  const summaryLine = productsSummaryLine(summarize(products));
  return (
    <Pane
      title={t('我的产品')}
      hint={q.isLoading || q.isError ? undefined : summaryLine}
      actions={
        <>
          {onShowGuide ? (
            <Button size="xs" variant="ghost" onClick={onShowGuide}>
              {t('新手引导')}
            </Button>
          ) : null}
          <Button size="icon-xs" variant="ghost" onClick={() => void q.refetch()} disabled={q.isFetching} aria-label={t('刷新')}>
            <RefreshCw className={cn(q.isFetching && 'animate-spin')} />
          </Button>
        </>
      }
    >
      {q.isLoading ? (
        <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44 w-full" />
          ))}
        </div>
      ) : q.isError ? (
        <ErrorNote err={q.error} />
      ) : products.length === 0 ? (
        <EmptyNote>{t('还没有产品。')}</EmptyNote>
      ) : (
        <div className="flex flex-col gap-2 p-3">
          {/* 手机上 Pane 头放不下汇总,单独一行 */}
          <p className="text-[11.5px] text-muted-foreground sm:hidden">{summaryLine}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {products.map((p) => (
              <ProductCard
                key={p.key}
                product={p}
                now={now}
                asp={asp}
                expanded={expanded === p.key}
                busy={pauseBusy}
                onToggle={() => setExpanded(expanded === p.key ? null : p.key)}
                onPreview={() => onPreview(p)}
                onPause={() => onPause(p)}
                onAdjust={() => onAdjust(p)}
              />
            ))}
          </div>
        </div>
      )}
    </Pane>
  );
}

// ---------------------------------------------------------------------------

export function PublishTab() {
  const qc = useQueryClient();
  const now = useNow();
  const q = useQuery({ queryKey: ['market', 'asp'], queryFn: api.marketAsp, refetchInterval: cachePollMs });
  const hasIdentity = !!q.data?.identity;
  const pq = useQuery({ queryKey: PRODUCTS_KEY, queryFn: aspProductsApi.products, refetchInterval: 60_000, enabled: hasIdentity });

  const [dismissed, setDismissed] = useState(readDismissed);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<AspProduct | null>(null);
  const [adjusting, setAdjusting] = useState<AspProduct | null>(null);
  const [pauseTarget, setPauseTarget] = useState<AspProduct | null>(null);
  const [disputeTarget, setDisputeTarget] = useState<MarketAftersale | null>(null);
  const [disputeReason, setDisputeReason] = useState('');
  const [activeConfirm, setActiveConfirm] = useState<'activate' | 'deactivate' | null>(null);
  const productsRef = useRef<HTMLDivElement>(null);
  const registerRef = useRef<HTMLDivElement>(null);

  const put = (r: MarketAsp) => qc.setQueryData(['market', 'asp'], r);
  const fail = (msg: string) => (err: unknown) => toast.error(msg, { description: errText(err) });
  const refreshProducts = () => void qc.invalidateQueries({ queryKey: PRODUCTS_KEY });

  const activate = useMutation({
    mutationFn: api.marketAspActivate,
    retry: false,
    onSuccess: (r) => {
      put(r);
      setActiveConfirm(null);
      refreshProducts();
      toast.success(t('已提交上架'));
    },
    onError: fail(t('上架失败')),
  });
  const deactivate = useMutation({
    mutationFn: api.marketAspDeactivate,
    retry: false,
    onSuccess: (r) => {
      put(r);
      setActiveConfirm(null);
      refreshProducts();
      toast.success(t('已下架'));
    },
    onError: fail(t('下架失败')),
  });
  const claim = useMutation({
    mutationFn: api.marketAspClaim,
    retry: false,
    onSuccess: (r) => {
      put(r);
      refreshProducts();
      void qc.invalidateQueries({ queryKey: ['market', 'status'] });
      toast.success(t('已领取到 Agentic Wallet'));
    },
    onError: fail(t('领取失败')),
  });
  const decide = useMutation({
    mutationFn: (a: { jobId: string; decision: 'agree_refund' | 'dispute'; reason?: string }) => api.marketAspAftersale(a.jobId, { decision: a.decision, reason: a.reason }),
    retry: false,
    onSuccess: (r) => {
      put(r);
      setDisputeTarget(null);
      setDisputeReason('');
      toast.success(t('已提交'));
    },
    onError: fail(t('操作失败')),
  });
  const pause = useMutation({
    mutationFn: (a: { key: string; paused: boolean }) => aspProductsApi.pause(a.key, a.paused),
    retry: false,
    onSuccess: (_r, a) => {
      setPauseTarget(null);
      refreshProducts();
      toast.success(a.paused ? t('已暂停接单') : t('已恢复接单'));
    },
    onError: (err) => {
      refreshProducts();
      toast.error(t('操作失败'), { description: errText(err) });
    },
  });

  const asp = q.data ?? null;
  const products = useMemo(() => sortProducts(pq.data?.products ?? []), [pq.data]);
  const checklist = useMemo(() => (pq.data?.checklist.length ? pq.data.checklist : fallbackChecklist(hasIdentity, products)), [pq.data, hasIdentity, products]);
  const allDone = checklist.every((c) => c.done);
  const showGuide = !dismissed && !allDone;
  const aftersales = asp?.aftersales ?? [];
  const pendingAftersales = aftersales.filter((a) => a.status === 'pending');

  const dismissGuide = () => {
    writeDismissed(true);
    setDismissed(true);
  };
  const reopenGuide = () => {
    writeDismissed(false);
    setDismissed(false);
  };
  const scrollTo = (el: HTMLElement | null) => {
    try {
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {
      /* 老浏览器 */
    }
  };
  const goStep = (key: string) => {
    if (key === 'asp') return scrollTo(registerRef.current);
    if (key === 'listed') {
      const next = products.find((p) => p.status === 'not_listed');
      if (next) return setAdjusting(next);
      return scrollTo(productsRef.current);
    }
    if (key === 'review' && asp?.identity) {
      const phase = identityPhase(pq.data?.asp.approval, asp.identity.status === 'active');
      if (phase === 'not_submitted' || phase === 'rejected') return setActiveConfirm('activate');
    }
    if (key === 'first_customer') {
      const live = products.find((p) => p.status === 'listed') ?? products[0];
      if (live) return setPreviewing(live);
    }
    scrollTo(productsRef.current);
  };

  if (q.isLoading) {
    return (
      <Workspace className="shrink-0 p-3">
        <Skeleton className="h-40 w-full" />
      </Workspace>
    );
  }
  if (q.isError) {
    return (
      <Workspace className="shrink-0">
        <ErrorNote err={q.error} />
      </Workspace>
    );
  }
  if (asp?.cache?.fetched_at === null) {
    return (
      <Workspace className="shrink-0">
        <CacheNote cache={asp.cache} asOf={pickSnapshotAsOf(asp)} />
      </Workspace>
    );
  }
  if (!asp?.identity) {
    return (
      <div className="flex shrink-0 flex-col gap-3">
        {!dismissed ? <OnboardingCard items={fallbackChecklist(false, [])} onGo={goStep} onDismiss={dismissGuide} /> : null}
        <Workspace className="shrink-0">
          <Pane title={t('注册卖家身份')} hint={t('注册后,你的策略信号和服务才能在市场上出售')}>
            {asp?.error ? <div className="border-b bg-warn/10 px-3 py-1 text-[10.5px] text-warn">{friendlyMarketError(asp.error)}</div> : null}
            <RegisterForm ref={registerRef} onRegistered={() => void qc.invalidateQueries({ queryKey: ['market'] })} />
          </Pane>
        </Workspace>
      </div>
    );
  }

  const claimable = pq.data?.asp.claimable_usdt ?? asp.claimable.amount;

  return (
    <div className="flex shrink-0 flex-col gap-3">
      {/* 「数据时间」页头状态条已经有一行;这里只在数据过期 / 刷新失败时补一句,不再重复时间 */}
      {asp.cache?.stale || asp.cache?.error ? <CacheNote cache={asp.cache} asOf={pickSnapshotAsOf(asp)} /> : null}
      <Workspace className="shrink-0">
        <IdentityBar
          summary={pq.data?.asp ?? null}
          identity={asp.identity}
          claimable={claimable}
          claimError={asp.claimable.error}
          claiming={claim.isPending}
          onClaim={() => claim.mutate()}
          activeBusy={activate.isPending || deactivate.isPending}
          onActivate={() => setActiveConfirm('activate')}
          onDeactivate={() => setActiveConfirm('deactivate')}
        />
      </Workspace>

      {showGuide && !pq.isLoading ? <OnboardingCard items={checklist} onGo={goStep} onDismiss={dismissGuide} /> : null}

      {aftersales.length ? (
        <Workspace className="shrink-0">
          <Pane title={t('售后')} hint={pendingAftersales.length ? t('{n} 条待处理,约一天内要回应', { n: pendingAftersales.length }) : t('没有待处理')}>
            <div className="max-h-56 overflow-y-auto">
              {aftersales.map((a) => (
                <AftersaleRow
                  key={a.id}
                  a={a}
                  now={now}
                  busy={decide.isPending}
                  onDecide={(d) => (d === 'dispute' ? setDisputeTarget(a) : decide.mutate({ jobId: a.job_id, decision: 'agree_refund' }))}
                />
              ))}
            </div>
          </Pane>
        </Workspace>
      ) : null}

      <div ref={productsRef}>
        <Workspace className="shrink-0">
          <ProductsSection
            q={pq}
            products={products}
            asp={asp}
            now={now}
            expanded={expanded}
            setExpanded={setExpanded}
            pauseBusy={pause.isPending}
            onPreview={setPreviewing}
            onPause={setPauseTarget}
            onAdjust={setAdjusting}
            onShowGuide={dismissed && !allDone ? reopenGuide : null}
          />
        </Workspace>
      </div>

      <PreviewDialog product={previewing} onClose={() => setPreviewing(null)} />
      <AdjustDialog product={adjusting} onClose={() => setAdjusting(null)} />

      <ConfirmDialog
        open={pauseTarget !== null}
        title={pauseTarget?.paused ? t('恢复「{name}」接单?', { name: pauseTarget?.name ?? '' }) : t('暂停「{name}」接单?', { name: pauseTarget?.name ?? '' })}
        summary={pauseTarget?.paused ? t('恢复接单') : t('暂停接单')}
        danger={!pauseTarget?.paused}
        busy={pause.isPending}
        onCancel={() => setPauseTarget(null)}
        onConfirm={() => pauseTarget && pause.mutate({ key: pauseTarget.key, paused: !pauseTarget.paused })}
      >
        {pauseTarget?.paused ? (
          <p>{t('恢复后会重新接新订单,订阅者也会重新收到推送。')}</p>
        ) : (
          <p>{t('暂停后:新订单会被自动婉拒(买家看到「服务方暂停接单」),订阅推送也会暂停;已经接下的订单照常交付。产品仍在市场上,随时可以恢复。')}</p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={activeConfirm !== null}
        title={activeConfirm === 'activate' ? t('上架卖家身份?') : t('下架卖家身份?')}
        summary={activeConfirm === 'activate' ? t('提交上架') : t('下架')}
        danger={activeConfirm === 'deactivate'}
        busy={activate.isPending || deactivate.isPending}
        onCancel={() => setActiveConfirm(null)}
        onConfirm={() => (activeConfirm === 'activate' ? activate.mutate() : deactivate.mutate())}
      >
        {activeConfirm === 'activate' ? (
          <p>{t('会提交给 OKX 审核,通过后买家就能在市场里看到你和你的产品。')}</p>
        ) : (
          <p>{t('下架后新买家看不到你;已有订阅照常交付到期。随时可以再上架(需要重新审核)。')}</p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={disputeTarget !== null}
        title={t('对这次拒收提争议?')}
        summary={t('进入评审员投票')}
        danger
        busy={decide.isPending}
        onCancel={() => setDisputeTarget(null)}
        onConfirm={() => disputeTarget && disputeReason.trim() && decide.mutate({ jobId: disputeTarget.job_id, decision: 'dispute', reason: disputeReason.trim() })}
      >
        <p>{t('争议由至少 5 位评审员投票,多数决;输了退款。理由要能对上推送记录里的内容。')}</p>
        <Textarea value={disputeReason} onChange={(e) => setDisputeReason(e.target.value)} rows={3} className="text-[12px]" placeholder={t('理由(必填)')} />
      </ConfirmDialog>
    </div>
  );
}
