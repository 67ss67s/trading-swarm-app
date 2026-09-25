/**
 * Agent 页顶部「意图卡」(2026-09-25 改版,替换原来那条挤在一行的状态条):
 *   上半 = 一句话说清 agent 此刻在干什么(自由判断 / 按某条策略 + 运行方式 + 盯几个币 + 下一次扫描 + 执行通道),右侧主要操作;
 *   下半 = 事实条:当前策略胶囊(components/agent-strategy/current-strategy,点开即切换弹层)、观察列表、判断用量、信息员市场总结。
 * 句子由 components/agent/logic.ts 的 intentOf 生成(有单测)。「盯盘参数」抽屉仍装 components/watch/watch-panel。
 */
import { CurrentStrategyChip } from '@/components/agent-strategy/current-strategy';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Pause, Play, Radar, ScanSearch, ShieldAlert, SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import { useAgentStrategy } from '@/api/agent-strategy';
import { channelOf, fmtCountdown, intentOf, type IntentTone } from '@/components/agent/logic';
import { WatchPanel } from '@/components/watch/watch-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { BIAS_LABEL, REGIME_LABEL, fmtDateTime, relativeTime, useNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

const TONE_TEXT: Record<IntentTone, string> = { danger: 'text-destructive', warn: 'text-warn', ok: 'text-foreground', idle: 'text-muted-foreground' };
const TONE_DOT: Record<IntentTone, string> = { danger: 'bg-destructive', warn: 'bg-warn', ok: 'bg-up', idle: 'bg-muted-foreground' };

function stripQuote(sym: string): string {
  return sym.replace(/[-_]?(USDT|USDC|USD)(-SWAP)?$/i, '');
}

export function AgentStatusBar() {
  const qc = useQueryClient();
  const now = useNow(1000);
  const overviewQ = useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 20_000 });
  const executionQ = useQuery({ queryKey: ['execution'], queryFn: api.execution, refetchInterval: 30_000 });
  const stratQ = useAgentStrategy();
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

  const halted = loop?.halted ?? false;
  const paused = wf?.paused ?? loop?.paused ?? false;
  const next = loop?.next_at && !paused && !halted ? loop.next_at - now : null;
  const channel = channelOf(executionQ.data ?? (loop ? { backend: loop.backend } : null));
  const watchlist = wf?.watchlist ?? [];
  const intent = intentOf({
    halted,
    paused,
    capped: usage?.capped ?? false,
    strategy: stratQ.data ?? (stratQ.isError ? { kind: 'free' } : null),
    watchCount: watchlist.length,
    timeframe: wf?.timeframe,
    nextInMs: next,
    channel,
  });

  return (
    <div className="shrink-0 border-b">
      {/* 上半:它是谁、在干什么 + 主要操作 */}
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5">
        <div className="relative mt-0.5 grid size-9 shrink-0 place-items-center rounded-full border bg-primary/10 text-primary">
          <Bot className="size-4.5" />
          <span className={cn('absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-card', TONE_DOT[intent.tone], intent.tone === 'ok' && !paused && 'animate-pulse')} />
        </div>
        <div className="min-w-0 flex-1 basis-64">
          <div className="kicker text-[10px] text-muted-foreground">{t('这个 agent 现在')}</div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <h2 className={cn('text-[14px] font-semibold leading-snug', TONE_TEXT[intent.tone])}>{intent.title}</h2>
            {channel.kind === 'live' ? (
              <Badge variant="outline" className="h-5 gap-1 border-destructive/40 bg-destructive/10 px-1.5 text-[10.5px] text-destructive" title={t('单子会真的下到交易所')}>
                <ShieldAlert className="size-3" />
                {t('实盘')}
              </Badge>
            ) : channel.kind === 'sim' ? (
              <Badge variant="outline" className="h-5 px-1.5 text-[10.5px] text-muted-foreground" title={t('模拟单,不动真钱')}>
                {t('模拟')}
              </Badge>
            ) : null}
            {wf?.auto_approve ? (
              <Badge variant="outline" className="h-5 border-warn/40 px-1.5 text-[10.5px] text-warn" title={t('agent 的提议免确认直接执行')}>
                {t('自动执行')}
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{intent.sentence}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <Button size="sm" variant="outline" disabled={halted || togglePause.isPending} onClick={() => togglePause.mutate()} title={paused ? t('恢复后到点就会调模型') : t('暂停期间不调模型')}>
            {paused ? <Play data-slot="icon" /> : <Pause data-slot="icon" />}
            {paused ? t('恢复') : t('暂停')}
          </Button>
          <Button size="sm" disabled={scan.isPending || halted} onClick={() => scan.mutate()} title={t('对观察列表跑一轮扫描(会调模型)')}>
            <ScanSearch data-slot="icon" />
            {t('立即扫描')}
          </Button>
          <Button size="icon-sm" variant="ghost" disabled={info.isPending} onClick={() => info.mutate()} title={t('立刻跑一次信息员(走副脑)')} aria-label={t('信息员')}>
            <Radar />
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={() => setDrawer(true)} title={`${t('盯盘参数')}:${t('观察列表 / 周期 / 扫描方式 / 心跳 / 信息员频率')}`} aria-label={t('盯盘参数')}>
            <SlidersHorizontal />
          </Button>
        </div>
      </div>

      {/* 下半:事实条 */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t bg-muted/30 px-3 py-1.5 text-[11px]">
        <CurrentStrategyChip className="bg-card py-0.5 text-[11px]" />
        <button type="button" onClick={() => setDrawer(true)} className="flex min-w-0 items-center gap-1 rounded px-0.5 hover:bg-muted" title={t('盯盘参数')}>
          <span className="text-muted-foreground">{t('观察')}</span>
          {watchlist.length ? (
            <span className="num flex min-w-0 items-center gap-0.5">
              {watchlist.slice(0, 6).map((s) => (
                <span key={s} className={cn('rounded-sm border bg-card px-1 text-[10.5px]', wf?.watch_only?.includes(s) && 'border-dashed text-muted-foreground')}>
                  {stripQuote(s)}
                </span>
              ))}
              {watchlist.length > 6 ? <span className="text-muted-foreground">+{watchlist.length - 6}</span> : null}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
          <span className="num text-muted-foreground">· {wf?.timeframe ?? '—'}</span>
        </button>
        {next !== null ? (
          <span className="num text-muted-foreground" title={loop?.next_at ? fmtDateTime(loop.next_at) : undefined}>
            {t('下一轮 {t}', { t: fmtCountdown(next) })}
          </span>
        ) : null}
        {usage ? (
          <span className={cn('num text-muted-foreground', usage.capped && 'text-warn')} title={t('今日判断次数 / 上限 · 估算花费')}>
            {t('判断')} {usage.judgments}/{usage.cap || '∞'}
            {usage.est_cny != null ? ` · ¥${usage.est_cny.toFixed(2)}` : ''}
          </span>
        ) : null}
        <span className="hidden h-3.5 w-px bg-border sm:block" />
        {ms ? (
          <span className="flex min-w-0 flex-1 basis-56 items-center gap-1.5">
            <Badge variant="outline" className="h-5 shrink-0 bg-card px-1.5 text-[10.5px]">
              {REGIME_LABEL[ms.regime]}
            </Badge>
            <Badge variant="outline" className="h-5 shrink-0 bg-card px-1.5 text-[10.5px]">
              {BIAS_LABEL[ms.bias]}
            </Badge>
            <a href="#intel" className="min-w-0 truncate text-muted-foreground hover:text-foreground hover:underline" title={ms.summary}>
              {ms.summary}
            </a>
            <span className="shrink-0 text-muted-foreground/70" title={fmtDateTime(ms.as_of)}>
              {relativeTime(ms.as_of, now)}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">{t('信息员还没出总结')}</span>
        )}
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
