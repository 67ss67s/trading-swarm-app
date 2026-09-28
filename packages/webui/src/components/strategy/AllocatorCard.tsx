/**
 * 策略页顶部「当前票池」区(契约 §9.35 策略自动轮换 allocator + `active_mode`)。
 *
 * 三条红线,界面上必须看得出来:
 *   1. 票池只有**人**和**代码**能改(台账 `who` ∈ code / human),模型没有任何一条路径能改它;
 *   2. `manual` = 今天的行为(只有人点启用/停用),allocator 只算预览不落库;
 *      `auto` = allocator 每天一次用代码决策,人还能一键回滚到上一票池;
 *   3. 排序用的期望可能是**毛值**(`lab_expectancy_r` 那一档),所以 `expectancy_source`
 *      一定要显示出来,不能让人把毛值当净值看。
 *
 * react-query key:['allocator'] = GET /api/strategies/allocator。任何写操作后
 * ['allocator'] / ['strategies'] / ['workflow'] 三个 key 一起失效(mode 写的是
 * workflow.active_mode,设置页那边要能立刻看到)。
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Play, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type {
  AllocatorCandidate,
  AllocatorExpectancySource,
  AllocatorMode,
  StrategyEvent,
  StrategyView,
} from '@/api/types';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { DAILY_REGIME_LABEL, dailyRegimeClass, fmtDate, fmtDateTime, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, tmap, listSep } from '@/lib/i18n';

/** 期望取自哪一档。`lab_expectancy_r` 是毛值——单独再挂一个「毛值」徽章。 */
const EXPECTANCY_SOURCE_LABEL: Record<AllocatorExpectancySource, string> = tmap({
  regime_net: '本 regime 净期望',
  net: '净期望',
  oos_net: '样本外净期望',
  lab_gross: 'Lab 期望',
  none: '无数据',
  // 契约正文里按 lab_stats 字段名写的那一套别名,一并认。
  regime_net_expectancy_r: '本 regime 净期望',
  net_expectancy_r: '净期望',
  oos_net_expectancy: '样本外净期望',
  lab_expectancy_r: 'Lab 期望',
});

/** 只有这一档是毛值(没扣手续费 / 滑点),必须单独标出来。 */
function isGross(src: AllocatorExpectancySource): boolean {
  return src === 'lab_gross' || src === 'lab_expectancy_r';
}

/** 没进票池的原因;null = 在池里 / 本轮没被任何一条闸拦住。 */
const BLOCKED_LABEL: Record<string, string> = tmap({
  status: '状态不够格',
  health: '健康度降级',
  family_taken: '同族已占位',
  correlated: '与已选重复',
  cooldown: '冷却中',
  rank: '排名没进前几',
});

/** allocator 每天跑一次;下次决策日按上一次跑的时间 + 1 天推。 */
const ONE_DAY_MS = 24 * 60 * 60_000;

function expectancyText(v: number | null): string {
  return v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`;
}

export function AllocatorCard({ all, active }: { all: StrategyView[]; active: string[] }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [confirm, setConfirm] = useState<'run' | 'rollback' | null>(null);

  const allocQ = useQuery({ queryKey: ['allocator'], queryFn: () => api.allocator(), staleTime: 10_000 });
  const view = allocQ.data ?? null;

  /** 写操作后三个 key 一起失效:票池、策略库、workflow(active_mode 在它身上)。 */
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['allocator'] }),
      queryClient.invalidateQueries({ queryKey: ['strategies'] }),
      queryClient.invalidateQueries({ queryKey: ['workflow'] }),
    ]);
  };

  const failed = (err: unknown) => toast.error(err instanceof Error ? err.message : String(err));

  const modeMut = useMutation({
    mutationFn: (mode: AllocatorMode) => api.setAllocatorMode(mode),
    onSuccess: (res) => {
      toast.success(res.mode === 'auto' ? t('票池交给代码每天决策了') : t('票池改回只有人能改'));
      void refresh();
    },
    onError: failed,
  });

  const runMut = useMutation({
    mutationFn: () => api.runAllocator(true),
    onSuccess: (res) => {
      setConfirm(null);
      if (!res.applied) toast.info(t('算完了,但这一轮没有落库(只是预览)'));
      else if (res.decision.changed) toast.success(t('票池换好了:{reason}', { reason: res.decision.reason }));
      else toast.success(t('算完了,票池没有变化'));
      void refresh();
    },
    onError: (err) => {
      setConfirm(null);
      failed(err);
    },
  });

  const rollbackMut = useMutation({
    mutationFn: () => api.rollbackAllocator(),
    onSuccess: (res) => {
      setConfirm(null);
      toast.success(res.restored ? t('已回滚到上一票池') : t('票池没有变化'));
      void refresh();
    },
    onError: (err) => {
      setConfirm(null);
      failed(err);
    },
  });

  /** 每条策略最近一条 activated / deactivated 台账原文(挂在这一行的 tooltip 上)。 */
  const lastEventById = useMemo(() => {
    const map = new Map<string, StrategyEvent>();
    for (const e of view?.events ?? []) {
      const prev = map.get(e.strategy_id);
      if (!prev || e.at > prev.at) map.set(e.strategy_id, e);
    }
    return map;
  }, [view?.events]);

  const candidates = view?.candidates ?? [];
  const mode: AllocatorMode = view?.mode ?? 'manual';
  const pool = view?.active ?? active;
  const busy = modeMut.isPending || runMut.isPending || rollbackMut.isPending;
  /** 契约:previous === null 就是「没有可回滚的票池」,按钮禁用并说明。 */
  const canRollback = view !== null && view.previous !== null;

  return (
    <div className="border-t">
      {/* 第一行:票池本体 + 手动/自动 + 两个动作 */}
      <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-1.5">
        <span className="shrink-0 text-[10.5px] font-semibold text-muted-foreground select-none">{t('当前票池')}</span>
        {pool.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">{t('空的:没有策略参加议会表态,共识闸不会生效。')}</span>
        ) : (
          pool.map((id) => {
            const s = all.find((x) => x.id === id);
            return (
              <Badge
                key={id}
                variant="outline"
                className="num h-4 px-1.5 text-[10px]"
                title={s ? `${s.name} · v${s.version} · ${s.status_label}` : t('这个 id 不在策略库里')}
              >
                {s?.name ?? id}
                {s ? <span className="ml-1 text-muted-foreground">v{s.version}</span> : null}
              </Badge>
            );
          })
        )}
        {view?.regime ? (
          <Badge variant="outline" className={cn('h-4 px-1.5 text-[10px]', dailyRegimeClass(view.regime))}>
            {DAILY_REGIME_LABEL[view.regime]}
          </Badge>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          {allocQ.isLoading ? (
            <Skeleton className="h-6 w-28" />
          ) : (
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={mode}
              onValueChange={(v) => {
                if (!v || v === mode || busy) return;
                modeMut.mutate(v as AllocatorMode);
              }}
              className="h-6"
            >
              <ToggleGroupItem value="manual" className="h-6 px-2 text-[10.5px]" title={t('只有人改票池;allocator 只算预览,不落库')}>
                {t('手动')}
              </ToggleGroupItem>
              <ToggleGroupItem value="auto" className="h-6 px-2 text-[10.5px]" title={t('代码每天决策一次票池;模型永远改不了它')}>
                {t('自动')}
              </ToggleGroupItem>
            </ToggleGroup>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10.5px]"
            disabled={busy || allocQ.isLoading}
            onClick={() => setConfirm('run')}
            title={t('按当前规则现在算一遍,并把结果落进票池')}
          >
            <Play className="size-3" />
            {t('现在算一遍')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10.5px]"
            disabled={busy || !canRollback}
            onClick={() => setConfirm('rollback')}
            title={canRollback ? t('一步换回上一票池(不受最短驻留 / 冷却约束)') : t('没有可回滚的票池')}
          >
            <Undo2 className="size-3" />
            {t('回滚到上一票池')}
          </Button>
        </div>
      </div>

      {/* 第二行:自动模式下的决策时间与最近一次理由 */}
      {mode === 'auto' && view ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 pb-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
          <span>
            {t('上次决策')}:
            <span className="num ml-1 text-foreground/80">
              {view.last_run_at ? `${fmtDateTime(view.last_run_at)}(${relativeTime(view.last_run_at)})` : '—'}
            </span>
          </span>
          <span>
            {t('上次换人')}:
            <span className="num ml-1 text-foreground/80">{view.last_change_at ? fmtDateTime(view.last_change_at) : '—'}</span>
          </span>
          <span>
            {t('下次决策')}:
            <span className="num ml-1 text-foreground/80">
              {view.last_run_at ? fmtDate(view.last_run_at + ONE_DAY_MS) : t('等下一次日更')}
            </span>
          </span>
          {view.last_reason ? <span className="text-foreground/80">{view.last_reason}</span> : null}
        </div>
      ) : null}

      {/* 第三行:为什么在 / 不在票池 */}
      <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-1.5">
        <button
          type="button"
          className="flex items-center gap-1 text-[10.5px] text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          {t('为什么在 / 不在票池({n})', { n: candidates.length })}
        </button>
        <span className="ml-auto text-[10px] leading-relaxed text-muted-foreground">
          {mode === 'auto'
            ? t('票池由代码每天排一次;模型没有任何一条路径能改它,人随时能回滚。')
            : t('手动模式:票池只有人改,下面这一遍只是预览,不落库。')}
        </span>
      </div>

      {expanded ? (
        <div className="max-h-56 overflow-y-auto border-t">
          {allocQ.isLoading ? (
            <div className="space-y-1.5 p-2.5">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-4/5" />
              <Skeleton className="h-5 w-3/5" />
            </div>
          ) : allocQ.isError ? (
            <div className="p-2.5 text-[11px] text-destructive">
              {t('票池决策加载失败')}:{allocQ.error instanceof Error ? allocQ.error.message : t('网关没给数据')}
            </div>
          ) : candidates.length === 0 ? (
            <div className="p-2.5 text-[11px] text-muted-foreground">{t('没有可参选的策略。')}</div>
          ) : (
            candidates.map((c) => <CandidateRow key={c.id} c={c} event={lastEventById.get(c.id) ?? null} />)
          )}
        </div>
      ) : null}

      {/* 现在算一遍:会真的动票池,所以走确认 */}
      <ConfirmDialog
        open={confirm === 'run'}
        title={t('现在算一遍票池')}
        summary={t('确认重算票池')}
        busy={runMut.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => runMut.mutate()}
      >
        <p className="leading-relaxed">
          {t('按当前 regime 与最近 30 天的净期望重排一遍,并把结果**落进**票池(不是预览)。换下去的策略这一轮不再参加议会表态。')}
        </p>
        {view?.decision ? (
          <p className="num leading-relaxed text-muted-foreground">
            {t('预览')}:{view.decision.changed ? view.decision.reason : t('票池不会变')}
          </p>
        ) : null}
      </ConfirmDialog>

      {/* 回滚:人的撤销键,不受最短驻留 / 冷却约束 */}
      <ConfirmDialog
        open={confirm === 'rollback'}
        title={t('回滚到上一票池')}
        summary={t('确认回滚票池')}
        busy={rollbackMut.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => rollbackMut.mutate()}
      >
        <p className="leading-relaxed">{t('一步把票池换回上一次的样子。回滚不受最短驻留 3 天与冷却 1 天的约束,同样会写进台账。')}</p>
        {view?.previous ? (
          <p className="num leading-relaxed text-muted-foreground">
            {t('回滚到')}:{view.previous.map((id) => all.find((x) => x.id === id)?.name ?? id).join(listSep()) || t('空票池')}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

/** 一条候选:主文案是 candidates[].reason,右边挂最近一条台账原文。 */
function CandidateRow({ c, event }: { c: AllocatorCandidate; event: StrategyEvent | null }) {
  const muted = c.blocked_by !== null;
  return (
    <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-2.5 py-1.5 last:border-b-0', muted && 'text-muted-foreground')}>
      <span className={cn('shrink-0 text-[11px] font-medium', muted ? 'text-muted-foreground' : 'text-foreground')}>{c.name}</span>
      <span className="num shrink-0 text-[10px] text-muted-foreground">v{c.version}</span>
      {c.in_pool ? (
        <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-[10px] bg-primary/15 text-primary border-primary/30">
          {t('在池')}
        </Badge>
      ) : c.blocked_by ? (
        <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-[10px] opacity-70">
          {BLOCKED_LABEL[c.blocked_by] ?? c.blocked_by}
        </Badge>
      ) : null}
      <span className="min-w-0 flex-1 text-[10.5px] leading-relaxed">{c.reason}</span>

      {/* 期望 + 它取自哪一档;毛值那一档必须标出来 */}
      <span className="num shrink-0 text-[10.5px]" title={c.health_reason ?? undefined}>
        {expectancyText(c.expectancy_r)}
        {c.n != null ? <span className="ml-1 text-muted-foreground">n={c.n}</span> : null}
      </span>
      <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-[10px] opacity-80">
        {EXPECTANCY_SOURCE_LABEL[c.expectancy_source] ?? c.expectancy_source}
      </Badge>
      {isGross(c.expectancy_source) ? (
        <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-[10px] bg-warn/15 text-warn border-warn/30" title={t('这一档是毛值(没扣手续费 / 滑点),不是净值')}>
          {t('毛值')}
        </Badge>
      ) : null}

      {event ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="num shrink-0 cursor-help text-[10px] text-muted-foreground underline decoration-dotted underline-offset-2">
              {t('台账')}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <div className="num text-[10px] opacity-80">
              {fmtDateTime(event.at)} · {event.who === 'code' ? t('代码') : t('人')} · {event.kind === 'activated' ? t('启用') : t('停用')}
            </div>
            <div className="mt-0.5 leading-relaxed">{event.reason}</div>
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
