/**
 * Agent 页右栏「团队」(docs/design/watch-screener-review-2026-09-24.md 二-5):
 * 每个角色一行 = 状态(在干什么 / 最近一次 run / 待读交接)+ 最近 30 天进化小方格(复用 evolution/day-grid 的 compact 模式),
 * 点一行跳到这个角色对应的页面(楼层 ROLE_META.page,同一张表)。下面保留最近交接单(HandoffRow 来自 team-card)。
 *
 * 数据:['bots'](/api/bots)+ ['evolution','daily',null,null](/api/evolution/daily,和楼层 / 进化页共用缓存)。
 * 进化接口还没上线时方格全灰并提示,不影响状态列表。
 */
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { api } from '@/api/client';
import { useEvolutionDaily, type EvoRoleRow } from '@/api/evolution';
import type { BotProfile, BotRole, BotRun } from '@/api/types';
import { DayGrid } from '@/components/evolution/day-grid';
import { ROLE_META, ROLE_ORDER } from '@/components/floor/roles';
import { HandoffRow } from '@/components/team-card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { relativeTime, useNow } from '@/lib/format';
import { t, tmap } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { st as serverText } from '@/lib/server-text-en';

const RUN_STATUS: Record<BotRun['status'], string> = tmap({ running: '进行中', done: '完成', failed: '失败', skipped: '跳过' });

const PRESENCE_LABEL: Record<string, string> = tmap({ idle: '空闲', thinking: '思考中', working: '干活中', waiting: '等待', blocked: '受阻', done: '完成', off: '关闭' });

type Presence = { state?: string; action?: string | null };

function presenceOf(bot: BotProfile): Presence | undefined {
  return (bot as { presence?: Presence }).presence;
}

function stateTone(bot: BotProfile, lastRun: BotRun | null): string {
  if (!bot.enabled) return 'bg-muted-foreground/40';
  const st = presenceOf(bot)?.state;
  if (st === 'blocked' || (!st && lastRun?.status === 'failed')) return 'bg-destructive';
  if (st === 'working' || st === 'thinking' || lastRun?.status === 'running') return 'bg-up';
  if (st === 'waiting') return 'bg-warn';
  return 'bg-muted-foreground/60';
}

function RoleRow({ bot, evo, lastRun, pending, now, evoReady }: { bot: BotProfile; evo: EvoRoleRow | undefined; lastRun: BotRun | null; pending: number; now: number; evoReady: boolean }) {
  const meta = ROLE_META[bot.role as BotRole];
  const page = meta?.page ?? 'floor';
  const presence = presenceOf(bot);
  const s = evo?.summary;
  const status = !bot.enabled ? t('占位 · 未启用') : presence?.state ? (PRESENCE_LABEL[presence.state] ?? presence.state) : lastRun ? RUN_STATUS[lastRun.status] : t('还没跑过');
  return (
    <a
      href={`#${page}`}
      className={cn('group block px-2.5 py-1.5 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none', !bot.enabled && 'opacity-55')}
      title={t('去{page}', { page: meta ? t(meta.pageLabel) : page })}
    >
      <div className="flex items-center gap-1.5">
        <span className={cn('size-1.5 shrink-0 rounded-full', stateTone(bot, lastRun))} />
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium">{t(bot.name)}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{status}</span>
        {pending ? (
          <Badge variant="outline" className="h-4 shrink-0 border-warn/30 bg-warn/10 px-1 text-[9.5px] text-warn">
            {pending}
          </Badge>
        ) : null}
        <ChevronRight className="size-3 shrink-0 text-muted-foreground/60 group-hover:text-foreground" />
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-3">
        <span className="num min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
          {presence?.action ? `${serverText(presence.action)}` : lastRun ? `${lastRun.routine} ${RUN_STATUS[lastRun.status]} ${relativeTime(lastRun.started_at, now)}` : (evo?.metric_label ? t(evo.metric_label) : '—')}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 pl-3">
        <DayGrid days={evo?.days ?? []} mode="compact" compactDays={30} cell={5} gap={1} label={t('{who} 最近 30 天', { who: t(bot.name) })} tipSide="bottom" />
        <span className="num shrink-0 text-[9.5px] text-muted-foreground" title={evo?.metric_label ? t(evo.metric_label) : undefined}>
          {evoReady && s ? (
            <>
              <span className="text-up">{s.good}</span>/<span className="text-warn">{s.ok}</span>/<span className="text-down">{s.bad}</span>
            </>
          ) : (
            '—'
          )}
        </span>
      </div>
    </a>
  );
}

export function TeamRoster() {
  const now = useNow();
  const botsQ = useQuery({ queryKey: ['bots'], queryFn: api.bots, retry: 0 });
  const evoQ = useEvolutionDaily();
  const evoBy = new Map((evoQ.data?.roles ?? []).map((r) => [r.role, r]));

  if (botsQ.isLoading) {
    return (
      <div className="space-y-1.5 p-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-2/3" />
      </div>
    );
  }
  if (botsQ.isError || !botsQ.data) return <div className="px-3 py-4 text-[11.5px] text-muted-foreground">{t('团队还没接上(网关没有 /api/bots)。')}</div>;

  const order = new Map(ROLE_ORDER.map((r, i) => [r, i]));
  const bots = [...botsQ.data.bots].sort((a, b) => (order.get(a.role) ?? 99) - (order.get(b.role) ?? 99) || a.sort_order - b.sort_order);
  const lastRunByRole = new Map<BotRole, BotRun>();
  for (const r of botsQ.data.runs) if (!lastRunByRole.has(r.role)) lastRunByRole.set(r.role, r);
  const pendingByRole = new Map<BotRole, number>();
  for (const h of botsQ.data.handoffs) if (h.status === 'pending') pendingByRole.set(h.to_role, (pendingByRole.get(h.to_role) ?? 0) + 1);
  const handoffs = botsQ.data.handoffs.slice(0, 5);
  const evoReady = Boolean(evoQ.data);

  return (
    <div className="flex flex-col divide-y">
      <div className="flex items-center gap-2 px-2.5 py-1 text-[10px] text-muted-foreground">
        <span>{t('状态 · 最近 30 天(好/近/差)')}</span>
        {evoQ.isError ? <span className="ml-auto text-warn">{t('进化接口未就绪,方格全灰')}</span> : evoQ.isLoading ? <span className="ml-auto">{t('加载中…')}</span> : null}
      </div>
      <div className="divide-y">
        {bots.map((b) => (
          <RoleRow key={b.role} bot={b} evo={evoBy.get(b.role)} lastRun={lastRunByRole.get(b.role) ?? null} pending={pendingByRole.get(b.role) ?? 0} now={now} evoReady={evoReady} />
        ))}
      </div>
      <div className="px-2.5 py-1.5">
        <div className="pb-0.5 text-[10.5px] text-muted-foreground">{t('最近交接')}</div>
        {handoffs.length === 0 ? (
          <div className="py-2 text-[11.5px] text-muted-foreground">{t('还没有交接单。')}</div>
        ) : (
          <ul className="divide-y">
            {handoffs.map((h) => (
              <HandoffRow key={h.handoff_id} h={h} now={now} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
