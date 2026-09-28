/**
 * 策略线程列表的一行。第一行:状态 · 币种 · 方向 · 来源;第二行:入场 / 止损 / 止盈 / 更新时间;
 * 有问题的线程(提交结果未知 / attention)整行描边并把原因写出来,不和正常挂单混在一起。
 * Jev 判断过的候选在来源旁边带一个「Jev 跟 72%」小标。
 */
import { CircleQuestionMark, Hand, ScanSearch, Sparkles, TriangleAlert } from 'lucide-react';
import type { StrategyThread } from '@/api/types';
import type { JudgeLiveItem } from '@/api/judge-live';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { pct, questionRows, verdict } from '@/components/judge-live/logic';
import { askAgent, whyQuestion } from '@/lib/ask-agent';
import { THREAD_STATUS_LABEL, directionLabel, directionText, fmtPrice, marketOf, relativeTime, threadStatusBadgeClass } from '@/lib/format';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ThreadHealth, ThreadOrigin } from './logic';

export function entryText(thread: StrategyThread): string {
  if (thread.entry.zone) return `${fmtPrice(thread.entry.zone[0])} ~ ${fmtPrice(thread.entry.zone[1])}`;
  if (thread.entry.price) return fmtPrice(thread.entry.price);
  return thread.filled_avg_price ? fmtPrice(thread.filled_avg_price) : t('市价');
}

export const TONE_TEXT = { danger: 'text-down', warn: 'text-warn', info: 'text-primary', ok: 'text-muted-foreground' } as const;
export const TONE_BORDER = { danger: 'border-l-down', warn: 'border-l-warn', info: 'border-l-primary', ok: 'border-l-transparent' } as const;

export function JevMark({ item }: { item: JudgeLiveItem }) {
  const v = verdict(item);
  const first = questionRows(item)[0];
  return (
    <span
      className={cn('num inline-flex shrink-0 items-center gap-0.5 rounded-sm border px-1 text-[10px]', v.tone === 'up' ? 'border-up/30 text-up' : v.tone === 'down' ? 'border-down/30 text-down' : 'text-muted-foreground')}
      title={t('Jev {mode}判断:{v}', { mode: item.mode === 'gate' ? t('挡单') : t('影子'), v: v.text })}
    >
      Jev {v.text}
      {first?.top ? ` ${pct(first.top.p)}` : ''}
    </span>
  );
}

/** 线程来源徽章:策略运行(名字)/ AI Scan / 手动 / 对话 / 跟单 */
export function SourceBadge({ origin }: { origin: ThreadOrigin }) {
  const tone = origin.kind === 'run' ? 'border-primary/30 text-primary' : origin.kind === 'ai_scan' ? 'border-sky-500/30 text-sky-600 dark:text-sky-400' : 'border-border text-muted-foreground';
  const Icon = origin.kind === 'run' ? Sparkles : origin.kind === 'ai_scan' ? ScanSearch : origin.kind === 'manual' || origin.kind === 'chat' ? Hand : null;
  return (
    <span
      className={cn('inline-flex min-w-0 max-w-40 items-center gap-0.5 rounded-sm border px-1 text-[10px] leading-4', tone)}
      title={origin.kind === 'run' ? t('策略运行开的:{name}', { name: origin.label }) : origin.label}
      data-testid="trade-thread-source"
    >
      {Icon ? <Icon className="size-3 shrink-0" /> : null}
      <span className="truncate">{origin.label}</span>
    </span>
  );
}

export function ThreadRow({
  thread,
  health,
  origin,
  judge,
  selected,
  closed = false,
  onSelect,
  onClose,
  onReview,
  reviewPending = false,
}: {
  thread: StrategyThread;
  health: ThreadHealth;
  origin: ThreadOrigin;
  judge: JudgeLiveItem | null;
  selected: boolean;
  /** 已结束:只读回看 */
  closed?: boolean;
  onSelect: () => void;
  onClose?: () => void;
  onReview?: () => void;
  reviewPending?: boolean;
}) {
  const spot = marketOf(thread) === 'spot';
  const flagged = health.kind === 'submit_unknown' || health.kind === 'attention';
  const stuck = health.kind === 'submit_unknown';
  return (
    <div
      onClick={onSelect}
      data-testid={stuck ? 'trade-thread-stuck' : 'trade-thread-row'}
      className={cn(
        'group cursor-pointer border-b border-l-2 px-2.5 py-2 text-[12px] transition-colors hover:bg-muted/40',
        TONE_BORDER[flagged ? health.tone : 'ok'],
        flagged && (health.tone === 'danger' ? 'bg-down/[0.04]' : 'bg-warn/[0.04]'),
        selected && 'bg-muted/60',
        closed && 'opacity-70 hover:opacity-100',
      )}
    >
      <div className="flex items-center gap-1.5">
        {stuck ? (
          <Badge variant="outline" className="shrink-0 border-down/40 bg-down/10 text-down">
            <TriangleAlert data-slot="icon" />
            {health.label}
          </Badge>
        ) : (
          <Badge variant="outline" className={cn('shrink-0', threadStatusBadgeClass(thread.status))}>
            {health.kind === 'submitting' ? health.label : THREAD_STATUS_LABEL[thread.status]}
          </Badge>
        )}
        <span className="num truncate font-semibold">{thread.symbol}</span>
        {spot ? <span className="shrink-0 text-[10px] text-muted-foreground">{t('现货')}</span> : null}
        <span className={cn('shrink-0 text-[11px] font-medium', directionText(thread.side))}>{spot ? t('持有') : directionLabel(thread.side)}</span>
        <span className="ml-auto flex min-w-0 items-center gap-1">
          {judge ? <JevMark item={judge} /> : null}
          <SourceBadge origin={origin} />
        </span>
      </div>

      {flagged && health.kind === 'attention' ? (
        <div className={cn('mt-1 flex items-center gap-1 text-[11px]', TONE_TEXT[health.tone])}>
          <TriangleAlert className="size-3 shrink-0" />
          {health.label}
        </div>
      ) : null}
      {stuck ? <div className="mt-1 text-[11px] leading-snug text-down/90">{t('交易所没回执,不确定有没有下出去')}</div> : null}

      <div className="num mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>
          {thread.status === 'in_position' ? t('开仓') : t('入场')} {entryText(thread)}
        </span>
        {thread.stop_price ? <span>{t('止损')} {fmtPrice(thread.stop_price)}</span> : null}
        {thread.take_profits[0] ? <span>{t('止盈')} {fmtPrice(thread.take_profits[0])}</span> : null}
        <span className="ml-auto shrink-0">{relativeTime(thread.updated_at)}</span>
      </div>

      {closed ? null : (
        <div className={cn('mt-1.5 flex items-center gap-1.5', !selected && !flagged && 'hidden group-hover:flex')}>
          {thread.status === 'in_position' && onReview ? (
            <Button
              size="xs"
              variant="outline"
              onClick={(e) => {
                e.stopPropagation();
                onReview();
              }}
              disabled={reviewPending}
            >
              {t('复查')}
            </Button>
          ) : null}
          {onClose ? (
            <Button
              size="xs"
              variant={stuck ? 'outline' : 'destructive'}
              className={cn(stuck && 'border-down/40 text-down hover:bg-down/10 hover:text-down')}
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
            >
              {thread.status === 'pending_entry' ? (stuck ? t('撤单并核对') : t('撤单')) : t('平仓')}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto text-muted-foreground"
            title={t('问 agent 这笔为什么')}
            onClick={(e) => {
              e.stopPropagation();
              askAgent(whyQuestion({ symbol: thread.symbol, at: thread.created_at, action: null, threadId: thread.id }));
            }}
          >
            <CircleQuestionMark data-slot="icon" />
            {t('问 agent')}
          </Button>
        </div>
      )}
    </div>
  );
}
