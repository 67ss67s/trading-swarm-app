/**
 * Agent 页右栏(2026-09-25 改版):
 *   1. 「需要你处理」置顶:告警 + 待批(两步确认卡 ApprovalsList)+ 交接,合成一块带总数;没有时显示一行「没有要你处理的事」。
 *   2. 「今天」小结:判断次数与花费、开仓 / 平仓 / 已实现、当前持仓(components/agent/logic.ts 的 todaySummary,有单测)。
 *   3. 入口条与新手旅程一致(开始清单 / 矩阵研究 / 我的策略 / 复盘)。
 *   4. tabs 状态 | 执行 | 团队 保留在最下面(降级):状态 = 权益 / 线程 / 后端;执行 = ExecutionSummary(只读);团队 = TeamRoster。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { api } from '@/api/client';
import { ApprovalsList, useNeedsYou } from '@/components/approvals';
import { readSavedSession } from '@/components/chat-session-bar';
import { ExecutionSummary } from '@/components/execution-panel';
import { isProtectionVerified } from '@/components/connect/blocks';
import { okxSimpleMode, wantsPerp } from '@/components/start/logic';
import { Pane, Workspace } from '@/components/pane';
import { AgentQuickLinks } from '@/components/agent/quick-links';
import { TeamRoster } from '@/components/agent/team-roster';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { exchangeInfo } from '@/lib/exchange';
import { THREAD_STATUS_LABEL, backendLabel, relativeTime, useNow } from '@/lib/format';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { todaySummary } from '@/components/agent/logic';
import { JudgeLiveFeed } from '@/components/judge-live';
import { StatusTag } from '@/components/tour/status-tag';
import { st } from '@/lib/server-text-en';
import { friendlyError } from '@/lib/edition';
import { fmtCost } from '@/lib/money';

type Tab = 'status' | 'jev' | 'execution' | 'team';
const TAB_KEY = 'tg.agent.side.tab';

interface Alert {
  id: string;
  level: 'danger' | 'warn';
  text: string;
  href?: string;
  hrefLabel?: string;
  onTab?: Tab;
}

export function AgentSide() {
  const now = useNow();
  const overviewQ = useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 20_000 });
  const executionQ = useQuery({ queryKey: ['execution'], queryFn: api.execution, refetchInterval: 30_000 });
  const botsQ = useQuery({ queryKey: ['bots'], queryFn: api.bots, retry: 0 });
  const sessionsQ = useQuery({ queryKey: ['chat', 'sessions', false], queryFn: () => api.chatSessions(false), retry: false, staleTime: 30_000 });
  const currentSessionId = readSavedSession();
  const riskQ = useQuery({ queryKey: ['risk', 'alerts', 'open'], queryFn: () => api.riskAlerts('open'), refetchInterval: 60_000, retry: false });
  const historyQ = useQuery({ queryKey: ['history'], queryFn: () => api.history(200), retry: 0, staleTime: 60_000 });
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const v = window.localStorage.getItem(TAB_KEY) as Tab | null;
      return v === 'jev' || v === 'execution' || v === 'team' ? v : 'status';
    } catch {
      return 'status';
    }
  });
  const pick = (t: string) => {
    setTab(t as Tab);
    try {
      window.localStorage.setItem(TAB_KEY, t);
    } catch {
      /* ignore */
    }
  };

  const ov = overviewQ.data;
  const threads = ov?.threads ?? [];
  const acc = ov?.account;
  const usage = ov?.usage_today;
  const pendingHandoffs = (botsQ.data?.handoffs ?? []).filter((h) => h.status === 'pending');
  const needs = useNeedsYou();
  // can_execute 自 §9.19 起只是「这个会话的意图卡显不显示执行按钮」的前端偏好
  const showExecute = sessionsQ.data?.sessions?.find((x) => x.id === currentSessionId)?.can_execute ?? true;

  const alerts: Alert[] = [];
  if (ov?.loop?.halted) alerts.push({ id: 'halt', level: 'danger', text: t('紧急停止中:任何开仓都会被拒'), href: '#settings', hrefLabel: t('去解除') });
  for (const th of threads) if (th.attention) alerts.push({ id: `attn:${th.id}`, level: 'danger', text: t('{symbol} 要你处理:{detail}', { symbol: th.symbol, detail: th.attention }), href: '#trade', hrefLabel: t('去交易页') });
  if (executionQ.data?.account_read_error) alerts.push({ id: 'acct-read', level: 'danger', text: t('执行通道读不到账户:{detail}', { detail: friendlyError(executionQ.data.account_read_error.message) }), onTab: 'execution', hrefLabel: t('去执行') });
  else if (executionQ.data?.account_funded === false) alerts.push({ id: 'unfunded', level: 'warn', text: t('{acct}还没入金:agent 开不了新仓(权益是真的 0,不是读失败)', { acct: exchangeInfo(executionQ.data).account }), href: exchangeInfo(executionQ.data).depositUrl, hrefLabel: t('去入金 ↗') });
  const conn = executionQ.data?.connection;
  if (executionQ.data && conn && conn.status !== 'connected' && executionQ.data.backend !== 'paper') alerts.push({ id: 'exec', level: conn.status === 'needs_auth' ? 'danger' : 'warn', text: t('执行后端 {backend}:{detail}', { backend: backendLabel(executionQ.data.backend), detail: friendlyError(conn.detail) || conn.status }), href: '#connect', hrefLabel: t('去接入') });
  // 09-25 ③-2:简单模式 + 工作流开着永续 = agent 的永续单会被 OKX 拒(51010),原因要在这里看得到
  if (okxSimpleMode(executionQ.data) && wantsPerp(ov?.workflow)) alerts.push({ id: 'simple-mode', level: 'warn', text: t('OKX 账户是简单模式,永续单会被拒(51010);现货照常'), href: '#connect', hrefLabel: t('去切换') });
  // 09-25 ③-3:保护单没标记验证 = 闸门不放开新开仓
  if (executionQ.data?.exchange === 'okx' && executionQ.data.okx?.available && executionQ.data.protection) {
    const pv = isProtectionVerified(executionQ.data);
    if (!pv.verified && !pv.verifying) alerts.push({ id: 'protection', level: 'warn', text: t('保护单还没标记验证:闸门不放开新开仓'), href: '#connect', hrefLabel: t('去验证') });
  }
  if (riskQ.data && (riskQ.data.level === 'high' || riskQ.data.level === 'critical')) {
    // 09-20:同一类合成一条;「×776」那种累计次数没信息量(每 5 秒评估一次),改成持续了多久
    const kinds = new Map<string, { title: string; since: number }>();
    for (const a of riskQ.data.alerts.filter((a) => a.severity === 'high' || a.severity === 'critical')) {
      const prev = kinds.get(a.kind);
      kinds.set(a.kind, { title: prev?.title ?? st(a.title), since: Math.min(prev?.since ?? Infinity, a.first_seen_at) });
    }
    for (const [kind, a] of kinds) {
      const mins = Math.round((Date.now() - a.since) / 60_000);
      alerts.push({ id: `risk:${kind}`, level: 'danger', text: `${a.title}${mins >= 2 ? ` · ${t('持续 {n} 分钟', { n: mins })}` : ''}`, href: '#floor?sel=risk_sentinel', hrefLabel: t('去楼层处理') });
    }
  }
  else if (riskQ.data && riskQ.data.level === 'warn') alerts.push({ id: 'risk', level: 'warn', text: t('风控告警 {n} 条:{first}', { n: riskQ.data.alerts.length, first: st(riskQ.data.alerts[0]?.title) ?? '' }), href: '#floor?sel=risk_sentinel', hrefLabel: t('去楼层') });
  if (usage?.capped) alerts.push({ id: 'cap', level: 'warn', text: t('今日判断到上限 {n} 次了,明天之前不再调模型', { n: usage.cap }), href: '#settings', hrefLabel: t('调上限') });
  // §9.19:待批意图不再是一句提示,下面直接渲染两步确认卡(ApprovalsList)
  if (pendingHandoffs.length) alerts.push({ id: 'handoffs', level: 'warn', text: t('{n} 条 bot 交接待读', { n: pendingHandoffs.length }), onTab: 'team', hrefLabel: t('看团队') });
  if (ov?.market?.as_of && now - ov.market.as_of > 3 * 60_000) alerts.push({ id: 'stale', level: 'warn', text: t('行情 {ago}没更新了', { ago: relativeTime(ov.market.as_of, now) }) }); // 日志页已下线,不再给跳转

  const today = todaySummary({ now, openThreads: threads, historyThreads: historyQ.data?.threads });
  const needTotal = alerts.length + needs.total;

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {/* 1. 需要你处理 */}
      <Workspace className="flex max-h-[45%] shrink-0 flex-col">
        <div className="kicker flex shrink-0 items-center gap-2 border-b bg-muted/40 px-2.5 py-1 text-[10.5px] text-foreground/85">
          {t('需要你处理')}
          {needTotal ? <span className="num rounded-sm bg-destructive/15 px-1 text-destructive">{needTotal}</span> : null}
          {needs.total ? <span className="ml-auto font-normal normal-case text-muted-foreground">{t('两步确认 · 120 秒')}</span> : null}
        </div>
        {!needTotal ? (
          <div className="flex items-center gap-1.5 px-2.5 py-2 text-[11.5px] text-muted-foreground">
            <CheckCircle2 className="size-3.5 text-up" />
            {t('没有要你处理的事')}
          </div>
        ) : null}
        <div className="min-h-0 overflow-y-auto">
        {alerts.length ? (
          <ul className="divide-y">
            {alerts.map((a) => (
              <li key={a.id} className={cn('flex items-start gap-2 px-2.5 py-1.5 text-[11.5px]', a.level === 'danger' ? 'bg-destructive/10 text-destructive' : 'bg-warn/10 text-warn')}>
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">{a.text}</span>
                {a.onTab ? (
                  <button type="button" className="shrink-0 underline" onClick={() => pick(a.onTab!)}>
                    {a.hrefLabel}
                  </button>
                ) : a.href ? (
                  <a href={a.href} className="shrink-0 underline" target={a.href.startsWith('http') ? '_blank' : undefined} rel={a.href.startsWith('http') ? 'noreferrer noopener' : undefined}>
                    {a.hrefLabel}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {needs.total ? <ApprovalsList data={needs} showExecute={showExecute} className={cn(alerts.length && 'border-t')} /> : null}
        </div>
      </Workspace>

      {/* 2. 今天 */}
      <Workspace className="shrink-0">
        <div className="kicker flex items-center gap-2 border-b bg-muted/40 px-2.5 py-1 text-[10.5px] text-foreground/85">
          {t('今天')}
          <a href="#history" className="ml-auto font-normal normal-case text-primary hover:underline">
            {t('去复盘')}
          </a>
        </div>
        <div className="grid grid-cols-3 divide-x text-[11.5px]">
          <Cell k={t('判断')} v={usage ? `${usage.judgments}/${usage.cap || '∞'}` : '—'} tone={usage?.capped ? 'warn' : undefined} />
          <Cell k={t('花费')} v={usage?.est_cny != null ? fmtCost(usage.est_cny) : '—'} />
          <Cell k={t('持仓')} v={String(today.holding)} sub={today.pendingEntry ? t('挂单 {n}', { n: today.pendingEntry }) : undefined} />
        </div>
        <div className="grid grid-cols-3 divide-x border-t text-[11.5px]">
          <Cell k={t('开仓')} v={historyQ.isError && !threads.length ? '—' : String(today.opened)} />
          <Cell k={t('平仓')} v={historyQ.isError ? '—' : String(today.closed)} />
          <Cell
            k={t('已实现')}
            v={today.realized == null ? '—' : `${today.realized >= 0 ? '+' : ''}${today.realized.toFixed(2)}`}
            tone={today.realized == null ? undefined : today.realized >= 0 ? 'up' : 'down'}
            sub={today.unsettled ? t('{n} 笔待结算', { n: today.unsettled }) : undefined}
          />
        </div>
      </Workspace>

      {/* 3. 新手旅程入口 */}
      <Workspace className="shrink-0">
        <AgentQuickLinks />
      </Workspace>

      {/* 4. 状态 / 执行 / 团队(降级到最下) */}
      <Workspace className="flex min-h-72 flex-1 flex-col lg:min-h-0">
        <Tabs value={tab} onValueChange={pick} className="flex min-h-0 flex-1 flex-col gap-0">
          <TabsList className="h-8 w-full justify-start rounded-none border-b bg-muted/40 px-1">
            <TabsTrigger value="status" className="h-6 text-[11.5px]">
              {t('状态')}
            </TabsTrigger>
            <TabsTrigger value="jev" className="h-6 text-[11.5px]">
              {t('Jev 判断')}
            </TabsTrigger>
            <TabsTrigger value="execution" className="h-6 text-[11.5px]">
              {t('执行')}
              {executionQ.data ? <span className="ml-1 text-[10px] text-muted-foreground">{backendLabel(executionQ.data.backend)}</span> : null}
            </TabsTrigger>
            <TabsTrigger value="team" className="h-6 text-[11.5px]">
              {t('团队')}
              {pendingHandoffs.length ? <span className="ml-1 rounded-sm bg-warn/20 px-1 text-[10px] text-warn">{pendingHandoffs.length}</span> : null}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="status" className="min-h-0 flex-1 overflow-y-auto">
            <div className="divide-y text-[11.5px]">
              <div className="grid grid-cols-3 divide-x">
                <Cell k={t('权益')} v={acc ? Number(acc.equity).toFixed(2) : '—'} />
                <Cell k={t('可用')} v={acc ? Number(acc.available).toFixed(2) : '—'} />
                <Cell k={t('未实现')} v={acc ? Number(acc.unrealized_pnl).toFixed(2) : '—'} tone={acc ? (Number(acc.unrealized_pnl) >= 0 ? 'up' : 'down') : undefined} />
              </div>
              <div className="px-2.5 py-1.5">
                <div className="mb-1 text-[10.5px] text-muted-foreground">{t('线程 {n}', { n: threads.length })}</div>
                {threads.length ? (
                  <ul className="space-y-1">
                    {threads.map((th) => (
                      <li key={th.id} className="flex items-center gap-2">
                        <span className="num font-semibold">{th.symbol}</span>
                        <span className={th.side === 'long' ? 'text-up' : 'text-down'}>{th.side === 'long' ? t('多') : t('空')}</span>
                        <span className="text-muted-foreground">{THREAD_STATUS_LABEL[th.status]}</span>
                        {th.attention ? <span className="text-destructive">!</span> : null}
                        <a href="#trade" className="ml-auto text-[10.5px] text-primary hover:underline">
                          {t('详情')}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-muted-foreground">{t('没有开着的线程。')}</div>
                )}
              </div>
              <div className="px-2.5 py-1.5 text-[10.5px] text-muted-foreground">
                {t('主脑')} {ov?.loop?.brain?.split(':').pop() ?? '—'} · {t('后端')} {backendLabel(ov?.loop?.backend)} · {t('每 {n} 分钟', { n: Math.round((ov?.loop?.every_ms ?? 0) / 60000) })} · {t('观察列表')} {ov?.workflow?.watchlist.join(' / ') || '—'}
              </div>
            </div>
          </TabsContent>
          <TabsContent value="jev" className="min-h-0 flex-1 overflow-y-auto">
            <Pane title={t('Jev 判断')} badge={<StatusTag kind="live" />} hint={t('每条候选 Jev 怎么判 · 影子只记录不挡单')}>
              <JudgeLiveFeed />
            </Pane>
          </TabsContent>
          <TabsContent value="execution" className="min-h-0 flex-1 overflow-y-auto">
            <Pane title={t('执行')} hint={t('只读摘要 · 改设置去接入页')}>
              <ExecutionSummary />
            </Pane>
          </TabsContent>
          <TabsContent value="team" className="min-h-0 flex-1 overflow-y-auto">
            <Pane
              title={t('团队')}
              hint={t('各角色状态 · 30 天方格')}
              actions={
                <a href="#floor" className="text-[11px] text-primary hover:underline">
                  {t('去楼层')}
                </a>
              }
            >
              <TeamRoster />
            </Pane>
          </TabsContent>
        </Tabs>
      </Workspace>
    </div>
  );
}

function Cell({ k, v, tone, sub }: { k: string; v: string; tone?: 'up' | 'down' | 'warn'; sub?: string }) {
  return (
    <div className="min-w-0 px-2.5 py-1.5">
      <div className="text-[10px] text-muted-foreground">{k}</div>
      <div className={cn('num truncate text-[12.5px] font-semibold', tone === 'up' && 'text-up', tone === 'down' && 'text-down', tone === 'warn' && 'text-warn')}>{v}</div>
      {sub ? <div className="truncate text-[9.5px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}
