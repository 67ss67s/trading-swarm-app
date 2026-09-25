/**
 * 信号市场(#/market;设计 docs/design/asp-market-2026-09-20.md;契约 §9.39)。
 * 取代原「跟单」页:8794 / bridge 零痕迹,信号源只剩 OKX.AI 的 ASP 订阅投递。
 *
 * 一页四栏:市场(买)/ 订阅 / 信号(收,复用跟单流水线的 apply/skip/reconcile)/ 发布(卖)。
 * 顶部一条状态条:Agentic Wallet 钱包卡 + 身份 + 守护灯 + 入站采集器 + 收信号总开关。
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
import { StatusStrip } from '@/components/market/status-strip';
import { SubscriptionsTab } from '@/components/market/subscriptions';
import { Workspace } from '@/components/pane';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { t } from '@/lib/i18n';

type Tab = 'browse' | 'subscriptions' | 'inbox' | 'publish';

function readTab(): Tab {
  const q = window.location.hash.split('?')[1];
  const v = q ? new URLSearchParams(q).get('tab') : null;
  return v === 'subscriptions' || v === 'inbox' || v === 'publish' ? v : 'browse';
}

export function MarketPage() {
  const [tab, setTabState] = useState<Tab>(readTab);
  const [jobFilter, setJobFilter] = useState('all');
  const setTab = (v: Tab) => {
    setTabState(v);
    window.location.hash = v === 'browse' ? 'market' : `market?tab=${v}`;
  };

  const statusQ = useQuery({ queryKey: ['market', 'status'], queryFn: () => api.marketStatus(), refetchInterval: 30_000 });
  const overviewQ = useQuery({ queryKey: ['follow'], queryFn: api.follow, refetchInterval: 15_000 });
  const subsQ = useQuery({ queryKey: ['market', 'subscriptions'], queryFn: api.marketSubscriptions, staleTime: 60_000 });
  const aspQ = useQuery({ queryKey: ['market', 'asp'], queryFn: api.marketAsp, staleTime: 60_000 });

  const pendingCount = overviewQ.data?.pending_review_total ?? 0;
  const activeSubs = (subsQ.data?.subscriptions ?? []).filter((s) => s.status_name === 'ACTIVE').length;
  const pendingAftersales = (aspQ.data?.aftersales ?? []).filter((a) => a.status === 'pending').length;

  const Count = ({ n, warn }: { n: number; warn?: boolean }) =>
    n > 0 ? (
      <Badge variant="outline" className={warn ? 'ml-1 border-warn/40 px-1 text-[9.5px] text-warn' : 'ml-1 px-1 text-[9.5px] text-muted-foreground'}>
        {n}
      </Badge>
    ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto">
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
            <Count n={activeSubs} />
          </TabsTrigger>
          <TabsTrigger value="inbox" className="text-[12px]">
            {t('信号')}
            <Count n={pendingCount} warn />
          </TabsTrigger>
          <TabsTrigger value="publish" className="text-[12px]">
            {t('发布')}
            <Count n={pendingAftersales} warn />
          </TabsTrigger>
        </TabsList>
      </Tabs>

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
          />
        </Workspace>
      ) : null}
      {tab === 'inbox' ? <InboxTab overview={overviewQ.data ?? null} jobFilter={jobFilter} onJobFilter={setJobFilter} /> : null}
      {tab === 'publish' ? <PublishTab /> : null}
    </div>
  );
}
