/**
 * 交易页顶条:一行讲清三层模型 ①来源 → ②判断 → ③风控与执行,外加执行通道和异常状态。
 *
 *   左  = 执行通道(Paper / OKX Demo / Live)
 *   中  = ① Sources n 个在跑 → ② Judge 每个来源各自选 → ③ Risk & Execution 摘要胶囊(点开右栏 Risk)
 *   右  = 全局异常:急停 / 全部暂停 / 日亏停(正常不显示)
 *
 * 不再放 Agent 当前策略胶囊、自由判断额度、Jev 花费(分别进了 AI Scan 卡和 Jev tab)。
 */
import { ChevronRight, OctagonX, Pause, ShieldCheck, TrendingDown } from 'lucide-react';
import { StatusTag } from '@/components/tour/status-tag';
import { IS_JUDGE, JUDGE_CHANNEL_LABEL, lockReason } from '@/lib/edition';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ChannelKind } from './sources-logic';

export interface GlobalState {
  halted: boolean;
  paused: boolean;
  dailyLossHit: boolean;
}

const CHANNEL_TONE: Record<ChannelKind, string> = {
  paper: 'border-border bg-muted text-foreground',
  demo: 'border-primary/30 bg-primary/10 text-primary',
  live: 'border-down/40 bg-down/10 text-down',
  unknown: 'border-border text-muted-foreground',
};

export function TradeContextBar({
  channel,
  state,
  activeSources,
  totalSources,
  riskSummary,
  riskActive,
  onOpenRisk,
}: {
  channel: { kind: ChannelKind; label: string };
  state: GlobalState;
  activeSources: number;
  totalSources: number;
  /** 摘要文字;null = 风控接口没读到 */
  riskSummary: string | null;
  riskActive: boolean;
  onOpenRisk: () => void;
}) {
  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border bg-card px-2.5 py-1.5 text-[12px]" data-testid="trade-context-bar">
      {/* 评审版:通道固定 paper,胶囊写明「Paper · Judge demo」,悬停说明不能切主网/测试网(lockReason execution_channel) */}
      <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-[11px] font-medium', CHANNEL_TONE[IS_JUDGE ? 'paper' : channel.kind])} title={lockReason('execution_channel') ?? t('执行通道:订单发到哪里')} data-testid="trade-channel">
        <span className={cn('size-1.5 rounded-full', !IS_JUDGE && channel.kind === 'live' ? 'bg-down' : !IS_JUDGE && channel.kind === 'demo' ? 'bg-primary' : 'bg-muted-foreground')} />
        {IS_JUDGE ? JUDGE_CHANNEL_LABEL : channel.label}
      </span>

      <span className="h-5 w-px shrink-0 bg-border" />

      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-[11px]" data-testid="trade-pipeline">
        {/* data-tour:评审版新手引导「交易」一步指向来源(在跑的策略运行) */}
        <span className="inline-flex items-center gap-1 text-muted-foreground" title={t('机会从哪来:AI Scan(模型拿 playbook 看盘)和策略运行(代码收盘扫描)')} data-tour="trade-runs">
          {activeSources > 0 ? <StatusTag kind="live" /> : null}
          <Step n={1} />
          <span className="font-medium text-foreground">{t('机会来源')}</span>
          <span className="num">{t('{a}/{b} 在跑', { a: activeSources, b: totalSources })}</span>
        </span>
        <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />
        <span className="inline-flex items-center gap-1 text-muted-foreground" title={t('每个来源自己选判断方式:直接做 / Jev / LLM / 只发信号')}>
          <Step n={2} />
          <span className="font-medium text-foreground">{t('判断层')}</span>
          <span>{t('每个来源各自选')}</span>
        </span>
        <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />
        <button
          type="button"
          onClick={onOpenRisk}
          className={cn(
            'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 transition-colors hover:border-primary/50 hover:bg-primary/5',
            riskActive && 'border-primary bg-primary/5',
          )}
          title={t('风控与执行:全归代码,所有来源共用。点开看每一条和今天用了多少')}
          data-testid="trade-risk-chip"
        >
          <Step n={3} />
          <ShieldCheck className="size-3 shrink-0 text-primary" />
          <span className="shrink-0 font-medium">{t('风控与执行')}</span>
          <span className="num min-w-0 truncate text-muted-foreground">{riskSummary ?? t('读取中…')}</span>
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </div>

      {state.halted || state.paused || state.dailyLossHit ? (
        <div className="ml-auto flex shrink-0 items-center gap-1.5" data-testid="trade-global-state">
          {state.halted ? (
            <span className="inline-flex items-center gap-1 rounded-sm bg-down/15 px-1.5 py-0.5 text-[11px] font-medium text-down" title={t('紧急停止生效中:所有来源都不开新仓;在顶栏解除')}>
              <OctagonX className="size-3" />
              {t('急停中')}
            </span>
          ) : null}
          {state.paused && !state.halted ? (
            <span className="inline-flex items-center gap-1 rounded-sm bg-warn/15 px-1.5 py-0.5 text-[11px] font-medium text-warn" title={t('工作流暂停:所有来源都不开新仓,已有持仓照常管理;在顶栏 Agent 开关恢复')}>
              <Pause className="size-3" />
              {t('全部来源已暂停')}
            </span>
          ) : null}
          {state.dailyLossHit ? (
            <span className="inline-flex items-center gap-1 rounded-sm bg-down/15 px-1.5 py-0.5 text-[11px] font-medium text-down" title={t('今日亏损到了日亏停线:到明天之前不开新仓')}>
              <TrendingDown className="size-3" />
              {t('日亏停')}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function Step({ n }: { n: number }) {
  return <span className="num inline-flex size-3.5 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground">{n}</span>;
}
