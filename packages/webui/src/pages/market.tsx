import { cachePollMs } from '@/components/market/cache-note';
/**
 * OKX.AI 页(#market,原「信号市场」;设计 docs/design/asp-market-2026-09-20.md;契约 §9.39)。
 * 信号源只有 OKX.AI 的 ASP 订阅投递。
 *
 * 一页四栏:市场(买)/ 订阅 / 信号(收,复用跟单流水线的 apply/skip/reconcile)/ 发布(卖)。
 * 顶部一条状态条:Agentic Wallet 钱包卡 + 身份 + 守护灯 + 入站采集器 + 收信号总开关。
 * 2026-09-25(docs/design/signal-market-ux-2026-09-25.md):每栏顶部一句「这栏是干什么的」+ 首次引导卡
 * (买方引导在「市场」「订阅」共用一张;「信号」一张;「发布」的引导卡在 publish.tsx 里,这里只给一句说明)。
 *
 * react-query key:
 *   ['market','status']         GET /api/market/status(30s)
 *   ['market','subscriptions']  GET /api/market/subscriptions
 *   ['market','inbox',…]        GET /api/market/inbox
 *   ['market','asp']            GET /api/market/asp;['market','asp','deliveries'] 出站账本
 *   ['follow']                  GET /api/follow(设置 + 待办;SSE trader_signal 让它失效,App.tsx)
 *   ['follow','signals']        GET /api/follow/signals(SSE 按 signal_id upsert)
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { BrowseTab } from '@/components/market/browse';
import { InboxTab } from '@/components/market/inbox';
import { PublishTab } from '@/components/market/publish';
import { AspMonitorTab } from '@/components/market/asp-monitor';
import { StatusStrip } from '@/components/market/status-strip';
import { GuideCard } from '@/components/market/shared';
import type { GuideStep } from '@/components/market/shared';
import { SubscriptionsTab } from '@/components/market/subscriptions';
import { Workspace } from '@/components/pane';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getLang, t } from '@/lib/i18n';
import { IS_JUDGE, OKX_AI_LISTING_URL } from '@/lib/edition';
import { fmtDateTime } from '@/lib/format';
import { pickSnapshotAsOf } from '@/api/market-adapt';
import { listingLabel, snapshotAsOfMs, snapshotBannerText } from '@/components/market/judge';
import { StatusTag } from '@/components/tour/status-tag';

/** 评审版顶部横幅:这一页是 OKX.AI 上真实 ASP 的只读快照(默认版不渲染)。 */
function SnapshotBanner({ asOf }: { asOf: unknown }) {
  const at = snapshotAsOfMs(asOf);
  const text = snapshotBannerText(at ? fmtDateTime(at) : null);
  if (!text) return null;
  return (
    <div role="note" data-tour="okx-snapshot" className="shrink-0 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-[12px] leading-snug text-foreground/90">
      <StatusTag kind="snapshot" className="mr-1.5 align-middle" />
      {text}{' '}
      <a href={OKX_AI_LISTING_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline-offset-2 hover:underline">
        {listingLabel()}
      </a>
    </div>
  );
}

type Tab = 'browse' | 'subscriptions' | 'inbox' | 'publish' | 'monitor';

function readTab(): Tab {
  const q = window.location.hash.split('?')[1];
  const v = q ? new URLSearchParams(q).get('tab') : null;
  return v === 'subscriptions' || v === 'inbox' || v === 'publish' || v === 'monitor' ? v : 'browse';
}

export function MarketPage() {
  const [tab, setTabState] = useState<Tab>(readTab);
  const [jobFilter, setJobFilter] = useState('all');
  const setTab = (v: Tab) => {
    setTabState(v);
    window.location.hash = v === 'browse' ? 'market' : `market?tab=${v}`;
  };

  const statusQ = useQuery({ queryKey: ['market', 'status'], queryFn: () => api.marketStatus(), refetchInterval: cachePollMs });
  const overviewQ = useQuery({ queryKey: ['follow'], queryFn: api.follow, refetchInterval: 15_000 });
  const subsQ = useQuery({ queryKey: ['market', 'subscriptions'], queryFn: api.marketSubscriptions, refetchInterval: cachePollMs, staleTime: 60_000 });
  const aspQ = useQuery({ queryKey: ['market', 'asp'], queryFn: api.marketAsp, refetchInterval: cachePollMs, staleTime: 60_000 });
  // 标签上的红黄点:和监视面板共用一个查询(同 queryKey),标签页没打开时 2 分钟刷一次
  const monitorQ = useQuery({ queryKey: ['asp-services', 'monitor', getLang()], queryFn: () => api.aspMonitor(getLang()), refetchInterval: tab === 'monitor' ? 30_000 : 120_000 });

  const pendingCount = overviewQ.data?.pending_review_total ?? 0;
  const subs = subsQ.data?.subscriptions ?? [];
  const inUseSubs = subs.filter((s) => s.display.group === 'active' || s.display.group === 'trial' || s.display.group === 'cancelled_trial').length;
  const pendingAftersales = (aspQ.data?.aftersales ?? []).filter((a) => a.status === 'pending').length;
  const subsLoaded = !!subsQ.data && subsQ.data.cache?.fetched_at !== null;
  const receivedTotal = subs.reduce((n, s) => n + s.stats.received, 0);

  const TAB_INTRO: Record<Tab, string> = {
    browse: t('在这里挑选 OKX.AI 上的交易信号、市场情报和分析服务;大多可以先免费试用。'),
    subscriptions: t('你买过或正在试用的服务:在用的排在前面;可以在这里取消续费,或者看每个服务发来了什么。'),
    inbox: t('订阅的服务发来的交易信号、情报、告警和报告都在这里,按订阅分组;默认只记录,不会自动下单。'),
    publish: t('把你自己的策略信号或分析服务上架到 OKX.AI,在这里管理产品、订阅者和收入。'),
    monitor: IS_JUDGE
      ? t('这个 ASP 在 OKX.AI 上的实时运行监控:接单、信号推送、守护进程和网络持续巡检;订阅服务 12 小时内必须发出信号,每一次推送和每一张订单都能点开看。')
      : t('你上架的 ASP 现在是否正常:接单、推送、守护进程和网络,每 30 秒刷新;变黄变红就是需要处理。'),
  };
  const buyerSteps: GuideStep[] = [
    {
      title: t('去「市场」挑一个服务'),
      detail: t('点开服务能看介绍、价格和评价。'),
      done: subsLoaded ? subs.length > 0 : undefined,
      action: tab === 'browse' ? undefined : { label: t('去市场'), onClick: () => setTab('browse') },
    },
    {
      title: t('先免费试用'),
      detail: t('多数服务支持试用;付费从你的 Agentic Wallet(XLayer 链上的 USDT)扣,试用期内随时可以取消续费。'),
      done: subsLoaded ? subs.some((s) => s.trial_type === 1 || s.display.group !== 'pending') : undefined,
    },
    {
      title: t('在「信号」看收到的内容'),
      detail: t('每条都能点开看原文和关键价位;默认只记录,不下单。'),
      done: subsLoaded ? receivedTotal > 0 : undefined,
      action: { label: t('去看信号'), onClick: () => setTab('inbox') },
    },
  ];
  const inboxSteps: GuideStep[] = [
    { title: t('按订阅分组看'), detail: t('每个订阅一组,点「只看这个」只看一个服务;上方可以按类型筛选。') },
    { title: t('点开一条看细节'), detail: t('原文、关键价位,交易信号还有系统理由和 AI 的看法。') },
    {
      title: t('决定收到后怎么处理'),
      detail: t('默认只记录,不下单。想让 AI 先把关、或按规则下单,到「订阅」里改。'),
      action: { label: t('去订阅'), onClick: () => setTab('subscriptions') },
    },
  ];

  const Count = ({ n, warn }: { n: number; warn?: boolean }) =>
    n > 0 ? (
      <Badge variant="outline" className={warn ? 'ml-1 border-warn/40 px-1 text-[9.5px] text-warn' : 'ml-1 px-1 text-[9.5px] text-muted-foreground'}>
        {n}
      </Badge>
    ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto">
      {IS_JUDGE ? <SnapshotBanner asOf={pickSnapshotAsOf(statusQ.data, subsQ.data, aspQ.data)} /> : null}
      <Workspace className="shrink-0">
        <StatusStrip status={statusQ.data ?? null} isLoading={statusQ.isLoading} error={statusQ.isError ? statusQ.error : null} />
      </Workspace>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="shrink-0">
        <TabsList>
          <TabsTrigger value="browse" className="text-[12px]">
            {t('市场')}
          </TabsTrigger>
          <TabsTrigger value="subscriptions" className="text-[12px]">
            {t('订阅')}
            <Count n={inUseSubs} />
          </TabsTrigger>
          <TabsTrigger value="inbox" className="text-[12px]">
            {t('信号')}
            <Count n={pendingCount} warn />
          </TabsTrigger>
          <TabsTrigger value="publish" className="text-[12px]">
            {t('发布')}
            <Count n={pendingAftersales} warn />
          </TabsTrigger>
          <TabsTrigger value="monitor" className="text-[12px]">
            {t('监视')}
            {monitorQ.data && monitorQ.data.overall !== 'ok' ? (
              <span className={monitorQ.data.overall === 'fail' ? 'ml-1 size-1.5 rounded-full bg-down' : 'ml-1 size-1.5 rounded-full bg-warn'} />
            ) : null}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="flex shrink-0 flex-col gap-2">
        <p className="px-0.5 text-[11.5px] leading-snug text-muted-foreground">{TAB_INTRO[tab]}</p>
        {tab === 'browse' || tab === 'subscriptions' ? <GuideCard storageKey="tg.market.guide.buyer.v1" title={t('第一次订阅?三步上手')} steps={buyerSteps} /> : null}
        {tab === 'inbox' ? <GuideCard storageKey="tg.market.guide.inbox.v1" title={t('怎么看收到的内容')} steps={inboxSteps} /> : null}
      </div>

      {tab === 'browse' ? (
        <Workspace className="flex min-h-0 flex-1 flex-col">
          <BrowseTab status={statusQ.data ?? null} onSubscribed={() => setTab('subscriptions')} />
        </Workspace>
      ) : null}
      {tab === 'subscriptions' ? (
        <Workspace className="flex min-h-0 flex-1 flex-col">
          <SubscriptionsTab
            onShowSignals={(jobId) => {
              setJobFilter(jobId);
              setTab('inbox');
            }}
            onGoMarket={() => setTab('browse')}
          />
        </Workspace>
      ) : null}
      {tab === 'inbox' ? <InboxTab overview={overviewQ.data ?? null} jobFilter={jobFilter} onJobFilter={setJobFilter} onGoMarket={() => setTab('browse')} /> : null}
      {tab === 'publish' ? <PublishTab /> : null}
      {tab === 'monitor' ? <AspMonitorTab /> : null}
    </div>
  );
}
