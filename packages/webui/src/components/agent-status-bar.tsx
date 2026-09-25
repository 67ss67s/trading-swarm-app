/**
 * Agent 页对话顶部的状态条(B+ 方案,docs/design/ui-consistency-agent-page-2026-09-06.md §3/§6):
 * 一行放「一直看」的运行摘要 + 高频快捷操作,「盯盘参数」抽屉装 components/watch/watch-panel(与 #watch 页同一个组件)。
 * 长配置(风险/额度/自动化/大脑)在设置页。
 */
import { CurrentStrategyChip } from '@/components/agent-strategy/current-strategy';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pause, Play, Radar, ScanSearch, SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { WatchPanel } from '@/components/watch/watch-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { BIAS_LABEL, REGIME_LABEL, fmtDateTime, relativeTime, useNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function AgentStatusBar() {
  const qc = useQueryClient();
  const now = useNow(1000);
  const overviewQ = useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 20_000 });
  const [drawer, setDrawer] = useState(false);
  const ov = overviewQ.data;
  const loop = ov?.loop;
  const wf = ov?.workflow;
  const ms = ov?.market_state;
  const usage = ov?.usage_today;

  const togglePause = useMutation({
    mutationFn: () => api.patchWorkflow({ paused: !wf?.paused }),
    onSuccess: (res) => {
      qc.setQueryData(['workflow'], res.workflow);
      void qc.invalidateQueries({ queryKey: ['overview'] });
      toast.success(res.workflow.paused ? t('已暂停:到点不再调模型') : t('已恢复运行'));
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
  const scan = useMutation({
    mutationFn: () => api.scanNow(),
    onSuccess: () => {
      toast.info(t('扫描已排上,结果会出现在对话的「动态」里'));
      void qc.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });
  const info = useMutation({
    mutationFn: api.infoRunNow,
    onSuccess: () => toast.info(t('已排上,信息员出了总结会自动刷新')),
    onError: (e) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  const next = loop?.next_at ? loop.next_at - now : null;
  const halted = loop?.halted ?? false;
  const paused = wf?.paused ?? loop?.paused ?? false;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b bg-muted/30 px-2.5 py-1.5 text-[11px]">
      {ms ? (
        <>
          <Badge variant="outline" className="h-5 px-1.5 text-[10.5px]">
            {REGIME_LABEL[ms.regime]}
          </Badge>
          <Badge variant="outline" className="h-5 px-1.5 text-[10.5px]">
            {BIAS_LABEL[ms.bias]}
          </Badge>
          <a href="#intel" className="max-w-[22rem] truncate text-muted-foreground hover:text-foreground hover:underline" title={ms.summary}>
            {ms.summary}
          </a>
          <span className="text-muted-foreground/70" title={fmtDateTime(ms.as_of)}>
            {relativeTime(ms.as_of, now)}
          </span>
        </>
      ) : (
        <span className="text-muted-foreground">{t('信息员还没出总结')}</span>
      )}
      <span className="mx-1 h-3.5 w-px bg-border" />
      <CurrentStrategyChip className="py-0.5 text-[11px]" />
      <span className="num text-muted-foreground">
        {t('盯盘')} <b className="text-foreground">{wf?.watchlist.length ?? 0}</b> {t('个币')} · {wf?.timeframe ?? '—'}
      </span>
      <span className={cn('num', halted ? 'text-destructive' : paused ? 'text-warn' : 'text-muted-foreground')}>
        {halted ? t('紧急停止') : paused ? t('已暂停') : next !== null ? t('下一轮 {t}', { t: fmtCountdown(next) }) : t('待机')}
      </span>
      {usage ? (
        <span className={cn('num text-muted-foreground', usage.capped && 'text-warn')} title={t('今日判断次数 / 上限 · 估算花费')}>
          {t('判断')} {usage.judgments}/{usage.cap || '∞'}
          {usage.est_cny != null ? ` · ¥${usage.est_cny.toFixed(2)}` : ''}
        </span>
      ) : null}
      {wf?.auto_approve ? (
        <Badge variant="outline" className="h-5 border-warn/40 px-1.5 text-[10px] text-warn" title={t('agent 的提议免确认直接执行')}>
          {t('自动执行')}
        </Badge>
      ) : null}

      <div className="ml-auto flex items-center gap-1">
        <Button size="xs" variant="outline" disabled={halted || togglePause.isPending} onClick={() => togglePause.mutate()} title={paused ? t('恢复后到点就会调模型') : t('暂停期间不调模型')}>
          {paused ? <Play data-slot="icon" /> : <Pause data-slot="icon" />}
          {paused ? t('恢复') : t('暂停')}
        </Button>
        <Button size="xs" variant="outline" disabled={scan.isPending || halted} onClick={() => scan.mutate()} title={t('对观察列表跑一轮扫描(会调模型)')}>
          <ScanSearch data-slot="icon" />
          {t('扫描')}
        </Button>
        <Button size="xs" variant="outline" disabled={info.isPending} onClick={() => info.mutate()} title={t('立刻跑一次信息员(走副脑)')}>
          <Radar data-slot="icon" />
          {t('信息员')}
        </Button>
        <Button size="xs" variant="secondary" onClick={() => setDrawer(true)} title={t('观察列表 / 周期 / 扫描方式 / 心跳 / 信息员频率')}>
          <SlidersHorizontal data-slot="icon" />
          {t('盯盘参数')}
        </Button>
      </div>

      <Sheet open={drawer} onOpenChange={setDrawer}>
        <SheetContent side="right" className="flex w-[26rem] flex-col gap-0 p-0 sm:max-w-[26rem]">
          <SheetHeader className="border-b px-4 py-3">
            <SheetTitle className="text-[13px]">{t('盯盘参数')}</SheetTitle>
            <SheetDescription className="text-[11px]">{t('改完点保存,下一轮生效;风险、额度、自动化、大脑在「设置 › 工作流」。')}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1">
            <WatchPanel layout="drawer" />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
