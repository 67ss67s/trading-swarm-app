/**
 * 团队卡(Agent 页右栏):机器人名册 + 最近的交接单。
 *
 * 名册来自 GET /api/bots(网关 src/demo/bots.ts 的八个角色)。kind 决定徽章:
 *   llm_*            → AI(能自由调工具的模型)
 *   deterministic* / hybrid → CODE(纯代码 / 代码为主)
 *   protected_service       → EXEC(真的会写交易所的那一格)
 * enabled=false 的是占位角色,画灰,note 里写差什么(挂 title 上)。
 *
 * 交接单(handoff)是角色之间的收件箱:pending 的给一个「已阅」按钮 POST ack。
 * react-query key:['bots'],由 App.tsx 那条 SSE 的 bots.changed / screener.changed 失效。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { BotRunButton } from '@/components/agent-run-controls';
import type { BotHandoff, BotProfile, BotRole, BotRun, HandoffKind } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { fmtDateTime, relativeTime, useNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';
import { st } from '@/lib/server-text-en';

type BotBadge = 'AI' | 'CODE' | 'EXEC';

function botBadge(kind: string): BotBadge {
  if (kind.startsWith('llm_')) return 'AI';
  if (kind === 'protected_service') return 'EXEC';
  if (kind.startsWith('deterministic') || kind === 'hybrid') return 'CODE';
  return 'CODE';
}

const BADGE_CLASS: Record<BotBadge, string> = {
  AI: 'border-primary/30 bg-primary/10 text-primary',
  CODE: 'border-border bg-muted text-muted-foreground',
  EXEC: 'border-warn/30 bg-warn/10 text-warn',
};

const ROLE_LABEL: Record<BotRole, string> = tmap({
  gate_captain: '总协调',
  radar: '雷达',
  thread_manager: '线程管家',
  strategy_lab: '策略实验室',
  portfolio_manager: '仓位管理',
  risk_sentinel: '风控哨兵',
  reviewer: '复盘官',
  executor: '执行',
  asp_agent: '信号市场',
});

const HANDOFF_KIND_LABEL: Record<HandoffKind, string> = tmap({
  request: '请求',
  result: '结果',
  review: '复核',
  alert: '告警',
  blocked: '受阻',
});

function roleLabel(role: BotRole): string {
  return ROLE_LABEL[role] ?? role;
}

const RUN_STATUS: Record<BotRun['status'], string> = tmap({ running: '进行中', done: '完成', failed: '失败', skipped: '跳过' });

function BotRow({ bot, lastRun, pending, now }: { bot: BotProfile; lastRun: BotRun | null; pending: number; now: number }) {
  const badge = botBadge(bot.kind);
  const presence = (bot as { presence?: { state?: string; action?: string | null } }).presence;
  const row = (
    <div className={cn('flex items-center gap-1.5 py-1', !bot.enabled && !pending && 'opacity-45')}>
      <Badge variant="outline" className={cn('h-4 shrink-0 px-1 text-[9.5px] font-semibold', BADGE_CLASS[badge])}>
        {badge}
      </Badge>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px]">{bot.name}</span>
        {lastRun || pending || presence?.action ? (
          <span className="num block truncate text-[10px] text-muted-foreground">
            {presence?.action ? `${st(presence.action)} · ` : ''}
            {lastRun ? `${lastRun.routine} ${RUN_STATUS[lastRun.status]} ${relativeTime(lastRun.started_at, now)}${lastRun.cost_cny ? ` ¥${lastRun.cost_cny.toFixed(3)}` : ''}` : ''}
            {pending ? <span className="text-warn"> · {t('{n} 条待读', { n: pending })}</span> : null}
          </span>
        ) : null}
      </span>
      {bot.role === 'radar' ? (
        <a
          href="#screener"
          className="inline-flex shrink-0 items-center gap-0.5 text-[10.5px] text-primary hover:underline"
          title={t('去筛选页')}
        >
          {t('筛选')}
          <ExternalLink className="size-2.5" />
        </a>
      ) : null}
      <BotRunButton bot={bot} />
    </div>
  );
  const tip = bot.enabled ? bot.description : bot.note || bot.description;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div>{row}</div>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{tip}</TooltipContent>
    </Tooltip>
  );
}

export function HandoffRow({ h, now }: { h: BotHandoff; now: number }) {
  const queryClient = useQueryClient();
  const ack = useMutation({
    mutationFn: () => api.ackHandoff(h.handoff_id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bots'] });
      toast.success(t('已标记读过'));
    },
    onError: (err) => toast.error(t('标记失败'), { description: err instanceof Error ? err.message : String(err) }),
  });

  return (
    <li className="flex items-start gap-1.5 py-1 text-[11px]">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1 text-[10.5px] text-muted-foreground">
          <span className="text-foreground">{roleLabel(h.from_role)}</span>
          <ArrowRight className="size-2.5" />
          <span className="text-foreground">{roleLabel(h.to_role)}</span>
          <Badge variant="outline" className="h-4 px-1 text-[9.5px]">
            {HANDOFF_KIND_LABEL[h.kind] ?? h.kind}
          </Badge>
          <span title={fmtDateTime(h.created_at)}>{relativeTime(h.created_at, now)}</span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">{h.summary}</div>
      </div>
      {h.status === 'pending' ? (
        <Button size="xs" variant="outline" className="shrink-0" disabled={ack.isPending} onClick={() => ack.mutate()}>
          {t('标为已读')}
        </Button>
      ) : (
        <span className="shrink-0 text-[10px] text-muted-foreground">{t('已读')}</span>
      )}
    </li>
  );
}

export function TeamCard() {
  const now = useNow();
  const botsQ = useQuery({ queryKey: ['bots'], queryFn: api.bots, retry: 0 });

  if (botsQ.isLoading) {
    return (
      <div className="space-y-1.5 p-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (botsQ.isError || !botsQ.data) {
    return <div className="px-3 py-4 text-[11.5px] text-muted-foreground">{t('团队还没接上(网关没有 /api/bots)。')}</div>;
  }

  const bots = [...botsQ.data.bots].sort((a, b) => a.sort_order - b.sort_order);
  const handoffs = botsQ.data.handoffs.slice(0, 5);
  const pending = botsQ.data.handoffs.filter((h) => h.status === 'pending').length;
  // 每角色最近一次 run(runs 新在前)与待阅交接数
  const lastRunByRole = new Map<BotRole, BotRun>();
  for (const r of botsQ.data.runs) if (!lastRunByRole.has(r.role)) lastRunByRole.set(r.role, r);
  const pendingByRole = new Map<BotRole, number>();
  for (const h of botsQ.data.handoffs) if (h.status === 'pending') pendingByRole.set(h.to_role, (pendingByRole.get(h.to_role) ?? 0) + 1);

  return (
    <div className="flex flex-col divide-y">
      <div className="px-3 py-1.5">
        {bots.length === 0 ? <div className="py-2 text-[11.5px] text-muted-foreground">{t('没有角色。')}</div> : bots.map((b) => <BotRow key={b.role} bot={b} lastRun={lastRunByRole.get(b.role) ?? null} pending={pendingByRole.get(b.role) ?? 0} now={now} />)}
      </div>
      <div className="px-3 py-1.5">
        <div className="flex items-center gap-1.5 pb-0.5 text-[10.5px] text-muted-foreground">
          <span>{t('最近交接')}</span>
          {pending > 0 ? (
            <Badge variant="outline" className="h-4 border-warn/30 bg-warn/10 px-1 text-[9.5px] text-warn">
              {t('{n} 条待读', { n: pending })}
            </Badge>
          ) : null}
        </div>
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
