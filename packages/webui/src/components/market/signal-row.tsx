/**
 * 一条跟单信号(从跟单页原样搬来,去掉 transport 徽标——这页全是 OKX.AI 投递)。
 * 按钮分支(后端终版):
 *   - `needs_reconcile` 盖过一切:只有「已人工核对」;
 *   - `review_only` + open/add:「按此信号手动开仓」+「跳过」;其它动作只有「跳过」;
 *   - `apply_failed`:「重试开仓」+「跳过」;其余状态只读。
 */
import { AlertTriangle } from 'lucide-react';
import type { TraderAction, TraderEntryKind, TraderSignal } from '@/api/types';
import { DECISION_REASON_LABEL, FOLLOW_MODE_LABEL, TRADER_ACTION_LABEL, TRADER_SIGNAL_STATUS_LABEL } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { directionLabel, directionText, fmtDateTime, fmtPrice, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';
import { MODE_CLASS, STATUS_CLASS } from './shared';

const OPENING_ACTIONS: readonly TraderAction[] = ['open', 'add'];

const ENTRY_KIND_LABEL: Record<TraderEntryKind, string> = tmap({
  market: '市价意图',
  limit: '限价',
  zone: '区间',
  ladder: '多档阶梯',
  unknown: '',
});

const NEEDS_RECONCILE_CLASS = 'bg-warn/25 text-warn border-warn/50 font-semibold';

export function reviewKind(sig: TraderSignal): 'reconcile' | 'open' | 'management' | 'retry' | null {
  if (sig.needs_reconcile) return 'reconcile';
  if (sig.status === 'review_only') return OPENING_ACTIONS.includes(sig.action) ? 'open' : 'management';
  if (sig.status === 'apply_failed') return 'retry';
  return null;
}

function goToThread() {
  window.location.hash = 'history';
}

export function SignalRow({
  sig,
  now,
  tpPartial,
  entryExpired,
  onApply,
  onSkip,
  onReconcile,
  onShowRaw,
  busy,
}: {
  sig: TraderSignal;
  now: number;
  tpPartial: { placed: string; dropped: { price: string; percent: number }[]; note: string } | null;
  entryExpired: boolean;
  onApply: () => void;
  onSkip: () => void;
  onReconcile: () => void;
  /** 展开原投递全文(账本里的 raw)。 */
  onShowRaw?: () => void;
  busy: boolean;
}) {
  const codes = sig.decision?.codes ?? [];
  const kind = reviewKind(sig);
  return (
    <div className="flex flex-col gap-1.5 border-b px-3 py-2.5 text-[12px] last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate font-semibold">{sig.trader}</span>
        <span className="num text-muted-foreground">{sig.symbol}</span>
        {sig.side ? <span className={cn('font-medium', directionText(sig.side))}>{directionLabel(sig.side)}</span> : <span className="text-muted-foreground">—</span>}
        <Badge variant="outline" className="text-[10px]">
          {TRADER_ACTION_LABEL[sig.action]}
        </Badge>
        {sig.mode_applied ? (
          <Badge variant="outline" className={cn('text-[10px]', MODE_CLASS[sig.mode_applied])}>
            {FOLLOW_MODE_LABEL[sig.mode_applied]}
          </Badge>
        ) : null}
        <Badge variant="outline" className={cn('text-[10px]', STATUS_CLASS[sig.status])}>
          {TRADER_SIGNAL_STATUS_LABEL[sig.status]}
        </Badge>
        {sig.needs_reconcile ? (
          <Badge variant="outline" className={cn('gap-1 text-[10px]', NEEDS_RECONCILE_CLASS)} title={t('这条信号处在「不知道交易所那边到底怎么样」的状态,apply/skip 都会被拒,先去核对')}>
            <AlertTriangle className="size-2.5" />
            {t('待核对')}
          </Badge>
        ) : null}
        {sig.entry_kind === 'ladder' ? (
          <Badge variant="outline" className="gap-1 border-warn/30 bg-warn/10 text-[10px] text-warn" title={t('多档阶梯入场,本实现执行不了,转人工,绝不按第一档挂全量')}>
            <AlertTriangle className="size-2.5" />
            {t('阶梯转人工')}
          </Badge>
        ) : null}
        {sig.kind === 'arbitrage' ? (
          <Badge
            variant="outline"
            className="gap-1 border-primary/40 text-[10px] text-primary"
            title={t('期现套利信号(现货多 + 永续空):§9.40 只落账本不产生意图,等配对线程上线再执行')}
          >
            {t('套利 · 仅记录')}
            {sig.arbitrage?.basis_pct ? <span className="num">{t('基差')} {sig.arbitrage.basis_pct}%</span> : null}
            {sig.arbitrage?.expected_apr ? <span className="num">APR {sig.arbitrage.expected_apr}%</span> : null}
          </Badge>
        ) : null}
        {sig.market_type === 'spot' ? (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            {t('现货')}
          </Badge>
        ) : null}
        {sig.backfill ? (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            {t('补拉')}
          </Badge>
        ) : null}
        <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground" title={fmtDateTime(sig.published_at)}>
          {relativeTime(sig.published_at, now)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        <span>
          {t('入场')} <span className="num text-foreground">{sig.entry_prices.length ? sig.entry_prices.map(fmtPrice).join(' / ') : '—'}</span>
          {sig.entry_kind !== 'unknown' ? ` (${ENTRY_KIND_LABEL[sig.entry_kind]})` : ''}
        </span>
        <span>
          {t('止损')} <span className="num text-foreground">{sig.stop ? fmtPrice(sig.stop) : '—'}</span>
        </span>
        <span>
          {t('止盈')} <span className="num text-foreground">{sig.tps.length ? sig.tps.map((tp) => fmtPrice(tp.price)).join(' / ') : '—'}</span>
          {sig.tps.length > 1 && !tpPartial ? <span className="ml-1 text-[10px]">{t('(开仓只挂第一档)')}</span> : null}
        </span>
        {sig.thread_id ? (
          <button className="text-primary underline-offset-2 hover:underline" onClick={goToThread}>
            {t('查看线程')} {sig.thread_id.slice(0, 10)}
          </button>
        ) : null}
        {onShowRaw ? (
          <button className="text-muted-foreground underline-offset-2 hover:underline" onClick={onShowRaw}>
            {t('原文')}
          </button>
        ) : null}
      </div>

      {tpPartial ? (
        <div className="flex items-start gap-1.5 rounded border border-warn/30 bg-warn/10 px-2 py-1 text-[10.5px] text-warn">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span>
            {t('只挂了第一档 {placed},其余未兑现', { placed: fmtPrice(tpPartial.placed) })}: {tpPartial.dropped.map((d) => `${fmtPrice(d.price)}(${d.percent}%)`).join(' / ')}
          </span>
        </div>
      ) : null}

      {entryExpired ? (
        <div className="flex items-start gap-1.5 rounded border border-warn/30 bg-warn/10 px-2 py-1 text-[10.5px] text-warn">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span>{t('入场腿已过信号有效期(ENTRY_EXPIRED),系统只告警,不会自动撤单,请人工确认是否撤')}</span>
        </div>
      ) : null}

      {sig.invalid_validity ? (
        <div className="flex items-start gap-1.5 rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-[10.5px] text-destructive">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span>{t('valid_until 不可信(解析不出/早于原发时间,含倒挂):这条永远进不了可执行状态')}</span>
        </div>
      ) : null}

      {sig.decision ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          {codes.map((c) => (
            <Badge key={c} variant="outline" className="text-[10px] text-muted-foreground">
              {DECISION_REASON_LABEL[c] ?? c}
            </Badge>
          ))}
          {sig.decision.note ? <span className="text-muted-foreground">{sig.decision.note}</span> : null}
        </div>
      ) : null}

      {sig.decision?.agent ? (
        <div className="flex flex-col gap-0.5 rounded border bg-muted/30 px-2 py-1.5 text-[10.5px]">
          <span className="font-semibold text-muted-foreground">{t('agent 判断(依据)')}</span>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground">
            <span>
              {t('结论')}{' '}
              <span className={cn('font-medium', sig.decision.agent.stance === 'agree' ? 'text-up' : sig.decision.agent.stance === 'disagree' ? 'text-down' : 'text-muted-foreground')}>
                {sig.decision.agent.stance === 'agree' ? t('同向') : sig.decision.agent.stance === 'disagree' ? t('反向') : t('不入场')}
              </span>
            </span>
            <span>
              {t('动作')} <span className="text-foreground">{sig.decision.agent.action ?? '—'}</span>
            </span>
            <span>
              {t('方向')} <span className="text-foreground">{directionLabel(sig.decision.agent.direction)}</span>
            </span>
            <span>
              {t('止损')} <span className="num text-foreground">{sig.decision.agent.stop ? fmtPrice(sig.decision.agent.stop) : '—'}</span>
            </span>
            {sig.decision.agent.blocked.length ? (
              <span>
                {t('被闸拒')} <span className="text-warn">{sig.decision.agent.blocked.join(' / ')}</span>
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {sig.decision?.plan ? (
        <div className="flex flex-col gap-0.5 rounded border border-primary/30 bg-primary/5 px-2 py-1.5 text-[10.5px]">
          <span className="font-semibold text-primary">{t('将按此几何开仓')}</span>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground">
            <span>
              {t('入场')} <span className="num text-foreground">{fmtPrice(sig.decision.plan.entry)}</span> ({sig.decision.plan.intent === 'market' ? t('市价意图顶偏离价') : t('限价')})
            </span>
            <span>
              {t('止损')} <span className="num text-foreground">{fmtPrice(sig.decision.plan.stop)}</span>
            </span>
            <span>
              {t('止盈')} <span className="num text-foreground">{sig.decision.plan.take_profits.map(fmtPrice).join(' / ') || '—'}</span>
            </span>
          </div>
          {sig.decision.plan.reason ? <span className="text-muted-foreground">{sig.decision.plan.reason}</span> : null}
        </div>
      ) : null}

      {kind === 'reconcile' ? (
        <div className="flex items-center gap-2 pt-0.5">
          <Button size="xs" variant="destructive" disabled={busy} onClick={onReconcile}>
            {t('已人工核对')}
          </Button>
          <span className="text-[10.5px] text-warn">{t('先去交易页核对该线程/挂单实际状态;这个按钮只清标记,不动钱')}</span>
        </div>
      ) : kind === 'open' ? (
        <div className="flex items-center gap-2 pt-0.5">
          <Button size="xs" variant="default" disabled={busy} onClick={onApply}>
            {t('按此信号手动开仓')}
          </Button>
          <Button size="xs" variant="outline" disabled={busy} onClick={onSkip}>
            {t('跳过')}
          </Button>
        </div>
      ) : kind === 'retry' ? (
        <div className="flex items-center gap-2 pt-0.5">
          <Button size="xs" variant="default" disabled={busy} onClick={onApply}>
            {t('重试开仓')}
          </Button>
          <Button size="xs" variant="outline" disabled={busy} onClick={onSkip}>
            {t('跳过')}
          </Button>
        </div>
      ) : kind === 'management' ? (
        <div className="flex items-center gap-2 pt-0.5">
          <Button size="xs" variant="outline" disabled={busy} onClick={onSkip}>
            {t('跳过')}
          </Button>
          <span className="text-[10.5px] text-warn">{t('请到交易页对该线程手动平仓')}</span>
        </div>
      ) : null}
    </div>
  );
}
