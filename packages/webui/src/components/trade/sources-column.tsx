/**
 * 交易页左栏「① Sources」:全部来源 → 来源卡列表(AI Scan 在前,策略运行在后)→ 底部「Manual order」展开区(原下单面板)。
 * 点卡片 = 中栏线程只看它开的,再点一次或点「All sources」清除。
 */
import type { ReactNode } from 'react';
import { ChevronDown, ChevronUp, Hand, Layers } from 'lucide-react';
import type { StrategyRunMode } from '@/api/types';
import { lockReason } from '@/lib/edition';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { sameOriginFilter, type OriginFilter } from './logic';
import { SourceCard } from './source-card';
import type { SourceCardModel } from './sources-logic';

export function SourcesColumn({
  cards,
  filter,
  onFilter,
  counts,
  lock,
  busyKey,
  onToggleRun,
  onToggleAiScan,
  onModeRun,
  now,
  minStopAtr,
  manualOpen,
  onManualOpen,
  degraded,
  children,
}: {
  cards: SourceCardModel[];
  filter: OriginFilter;
  onFilter: (f: OriginFilter) => void;
  counts: { all: number; manual: number };
  lock: string | null;
  /** 正在改的来源(按钮转圈 / 禁用) */
  busyKey: string | null;
  onToggleRun: (card: SourceCardModel) => void;
  /** AI 扫盘单独暂停 / 继续;没有 = 不显示按钮(接口没就绪) */
  onToggleAiScan?: ((card: SourceCardModel) => void) | null;
  onModeRun: (card: SourceCardModel, mode: StrategyRunMode) => void;
  now: number;
  minStopAtr: string | number | null;
  manualOpen: boolean;
  onManualOpen: (open: boolean) => void;
  /** 来源接口没就绪 */
  degraded: boolean;
  /** 下单面板 */
  children: ReactNode;
}) {
  const pick = (f: OriginFilter) => onFilter(sameOriginFilter(filter, f) ? null : f);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn('flex min-h-0 flex-col gap-2 overflow-y-auto p-2', manualOpen ? 'max-h-[42%] shrink-0' : 'flex-1')} data-testid="trade-sources">
        <button
          type="button"
          onClick={() => onFilter(null)}
          className={cn('flex items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1.5 text-left text-[11.5px] transition-colors hover:bg-muted/50', filter === null ? 'border-primary/50 bg-primary/[0.04] text-foreground' : 'text-muted-foreground')}
          data-testid="trade-source-all"
        >
          <Layers className="size-3.5 shrink-0" />
          <span className="font-medium">{t('全部来源')}</span>
          <span className="num ml-auto">{t('{n} 条进行中', { n: counts.all })}</span>
        </button>
        {cards.map((card) => (
          <SourceCard
            key={card.key}
            model={card}
            active={sameOriginFilter(filter, card.filter)}
            onSelect={() => pick(card.filter)}
            // 评审版:AI 扫盘在跑时按钮是「暂停」,访客不许暂停(全站共用),直接禁用并说明;停着时「继续」照常可点
            lock={lock ?? (card.kind !== 'strategy_run' && (card.status === 'running' || card.status === 'capped') ? lockReason('ai_scan_pause') : null)}
            busy={busyKey === card.key}
            onToggle={card.kind === 'strategy_run' ? (card.status !== 'stopped' ? () => onToggleRun(card) : null) : onToggleAiScan && !card.degraded && card.status !== 'halted' ? () => onToggleAiScan(card) : null}
            onMode={card.kind === 'strategy_run' ? (m) => onModeRun(card, m) : null}
            now={now}
            minStopAtr={minStopAtr}
          />
        ))}
        {cards.length <= 1 ? (
          <a href="#my-strategies" className="rounded-md border border-dashed px-2.5 py-2 text-[11px] text-muted-foreground hover:border-primary/40 hover:text-primary">
            {t('还没有策略运行。在「我的策略」里一键运行一条,它会作为第二个来源出现在这里 →')}
          </a>
        ) : null}
        {degraded ? <p className="px-1 text-[10px] leading-snug text-muted-foreground">{t('来源接口还没就绪:运行卡显示累计数,被挡明细取自运行事件。')}</p> : null}
      </div>

      <div className={cn('flex min-h-0 flex-col border-t', manualOpen && 'flex-1')}>
        <div className="flex h-8 shrink-0 items-center gap-1.5 bg-muted/40 px-2.5">
          <button type="button" onClick={() => onManualOpen(!manualOpen)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" data-testid="trade-manual-toggle">
            <Hand className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="kicker text-[10.5px] text-foreground/85">{t('手动下单')}</span>
            {manualOpen ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronUp className="size-3.5 text-muted-foreground" />}
          </button>
          <button
            type="button"
            onClick={() => pick('manual')}
            className={cn('num shrink-0 rounded-sm px-1.5 py-0.5 text-[10.5px] transition-colors', filter === 'manual' ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}
            title={t('线程列表只看手动 / 对话下的')}
            data-testid="trade-source-manual"
          >
            {t('手动 {n}', { n: counts.manual })}
          </button>
        </div>
        {manualOpen ? <div className="min-h-0 flex-1">{children}</div> : null}
      </div>
    </div>
  );
}
