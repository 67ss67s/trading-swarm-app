/**
 * 交易信号的展示件(2026-09-25 新用户视角改版):
 *   - 状态只出一个人话标签(signalOutcome),不再并排「模式 + 状态」两个「只留证据」;
 *   - 没有价位就不画价位行(情报 / 告警 / 分析类不再是「— — —」);
 *   - 细节(风险提示、AI 看法、下单方案)与原文收在展开区。
 * 按钮分支(后端终版,不变):
 *   - `needs_reconcile` 盖过一切:只有「已人工核对」;
 *   - `review_only` + open/add:「按这条下单」+「跳过」;其它动作只有「跳过」;
 *   - `apply_failed`:「重试下单」+「跳过」;其余状态只读。
 */
import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { signalLevels } from '@/api/market-adapt';
import type { FeedItem } from '@/api/market-adapt';
import type { TraderAction, TraderSignal } from '@/api/types';
import { DECISION_REASON_LABEL, TRADER_ACTION_LABEL } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { JudgeLock } from '@/components/judge-lock';
import { directionLabel, directionText, fmtDateTime, fmtPrice, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';

const OPENING_ACTIONS: readonly TraderAction[] = ['open', 'add'];

const ACTION_LABEL: Record<TraderAction, string> = tmap({ ...TRADER_ACTION_LABEL });

export type OutcomeTone = 'warn' | 'down' | 'up' | 'muted' | 'primary';
export const TONE_CLASS: Record<OutcomeTone, string> = {
  warn: 'bg-warn/15 text-warn border-warn/30',
  down: 'bg-down/10 text-down border-down/30',
  up: 'bg-up/15 text-up border-up/30',
  muted: 'bg-muted text-muted-foreground border-transparent',
  primary: 'bg-primary/15 text-primary border-primary/30',
};

export function reviewKind(sig: TraderSignal): 'reconcile' | 'open' | 'management' | 'retry' | null {
  if (sig.needs_reconcile) return 'reconcile';
  if (sig.status === 'review_only') return OPENING_ACTIONS.includes(sig.action) ? 'open' : 'management';
  if (sig.status === 'apply_failed') return 'retry';
  return null;
}

/** 一条信号现在是什么情况 —— 合并「处理方式 + 状态 + 待核对」成一个人话标签。 */
export function signalOutcome(sig: TraderSignal): { label: string; tone: OutcomeTone } {
  if (sig.needs_reconcile) return { label: t('需要你去核对'), tone: 'warn' };
  switch (sig.status) {
    case 'review_only':
      return OPENING_ACTIONS.includes(sig.action) ? { label: t('等你决定是否下单'), tone: 'warn' } : { label: t('需要你手动处理'), tone: 'warn' };
    case 'apply_failed':
      return { label: t('下单失败,可重试'), tone: 'down' };
    case 'new':
    case 'triggered':
      return { label: t('处理中'), tone: 'primary' };
    case 'applying':
      return { label: t('正在下单'), tone: 'primary' };
    case 'applied':
      return { label: t('已按这条下单'), tone: 'up' };
    case 'mgmt_applied':
      return { label: t('已执行'), tone: 'up' };
    case 'skipped':
      return { label: t('已跳过'), tone: 'muted' };
    case 'evidence':
      return { label: sig.kind === 'arbitrage' ? t('套利信号,只记录') : t('只记录,不下单'), tone: 'muted' };
    case 'expired':
      return { label: t('已过期,没处理'), tone: 'muted' };
    case 'dead':
      return { label: t('已失效'), tone: 'muted' };
    case 'mgmt_orphan':
      return { label: t('找不到对应持仓'), tone: 'down' };
    default:
      return { label: String(sig.status), tone: 'muted' };
  }
}

/** 时间线条目的状态标签:交易信号看跟单流水线;没读出信号对象的交易类按账本状态说一句;其余类型不打标签。 */
export function feedOutcome(item: FeedItem): { label: string; tone: OutcomeTone } | null {
  if (item.kind !== 'trade') return null;
  if (item.signal) return signalOutcome(item.signal);
  if (item.parse_status === 'duplicate') return { label: t('重复收到,已忽略'), tone: 'muted' };
  if (item.parse_status === 'expired') return { label: t('到达时已过期,没处理'), tone: 'muted' };
  if (item.parse_status === 'bad') return { label: t('格式没读懂,只存了原文'), tone: 'warn' };
  return null;
}

export function OutcomeTag({ label, tone }: { label: string; tone: OutcomeTone }) {
  return (
    <Badge variant="outline" className={cn('shrink-0 text-[10px]', TONE_CLASS[tone])}>
      {label}
    </Badge>
  );
}

/** 关键价位行;一个价位都没有就不画。 */
export function LevelsRow({ levels, className }: { levels: FeedItem['levels']; className?: string }) {
  if (!levels.entry && !levels.stop && levels.targets.length === 0) return null;
  const cell = (label: string, v: string | null) =>
    v ? (
      <span>
        {label} <span className="num text-foreground">{v}</span>
      </span>
    ) : null;
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground', className)}>
      {cell(t('入场'), levels.entry)}
      {cell(t('止损'), levels.stop)}
      {cell(t('止盈'), levels.targets.length ? levels.targets.join(' / ') : null)}
    </div>
  );
}

function Warn({ children, danger }: { children: React.ReactNode; danger?: boolean }) {
  return (
    <div className={cn('flex items-start gap-1.5 rounded border px-2 py-1 text-[10.5px]', danger ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-warn/30 bg-warn/10 text-warn')}>
      <AlertTriangle className="mt-0.5 size-3 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function goToThread() {
  window.location.hash = 'history';
}

/** 展开区:风险提示、系统理由、AI 看法、下单方案。 */
export function SignalDetail({
  sig,
  tpPartial,
  entryExpired,
}: {
  sig: TraderSignal;
  tpPartial: { placed: string; dropped: { price: string; percent: number }[]; note: string } | null;
  entryExpired: boolean;
}) {
  const codes = sig.decision?.codes ?? [];
  return (
    <div className="flex flex-col gap-1.5">
      {sig.entry_kind === 'ladder' ? <Warn>{t('这是分多档入场的信号,系统不会自动执行,需要你手动处理')}</Warn> : null}
      {sig.tps.length > 1 && !tpPartial ? <p className="text-[10.5px] text-muted-foreground">{t('如果下单,只会挂第一档止盈')}</p> : null}
      {tpPartial ? (
        <Warn>
          {t('只挂了第一档止盈 {placed},其余没挂', { placed: fmtPrice(tpPartial.placed) })}: {tpPartial.dropped.map((d) => `${fmtPrice(d.price)}(${d.percent}%)`).join(' / ')}
        </Warn>
      ) : null}
      {entryExpired ? <Warn>{t('入场挂单已过信号有效期;系统只提醒,不会自动撤单,请你确认是否撤掉')}</Warn> : null}
      {sig.invalid_validity ? <Warn danger>{t('这条信号的有效期看不懂或早于发布时间,系统不会按它下单')}</Warn> : null}
      {sig.backfill ? <p className="text-[10.5px] text-muted-foreground">{t('这是启动时补收的历史信号')}</p> : null}

      {codes.length || sig.decision?.note ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="text-muted-foreground">{t('系统理由')}</span>
          {codes.map((c) => (
            <Badge key={c} variant="outline" className="text-[10px] text-muted-foreground">
              {DECISION_REASON_LABEL[c] ?? c}
            </Badge>
          ))}
          {sig.decision?.note ? <span className="text-muted-foreground">{sig.decision.note}</span> : null}
        </div>
      ) : null}

      {sig.decision?.agent ? (
        <div className="flex flex-col gap-0.5 rounded border bg-muted/30 px-2 py-1.5 text-[10.5px]">
          <span className="font-semibold text-muted-foreground">{t('AI 的看法(仅供参考)')}</span>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground">
            <span>
              {t('结论')}{' '}
              <span className={cn('font-medium', sig.decision.agent.stance === 'agree' ? 'text-up' : sig.decision.agent.stance === 'disagree' ? 'text-down' : 'text-muted-foreground')}>
                {sig.decision.agent.stance === 'agree' ? t('认同') : sig.decision.agent.stance === 'disagree' ? t('反对') : t('建议不入场')}
              </span>
            </span>
            <span>
              {t('方向')} <span className="text-foreground">{directionLabel(sig.decision.agent.direction)}</span>
            </span>
            {sig.decision.agent.stop ? (
              <span>
                {t('止损')} <span className="num text-foreground">{fmtPrice(sig.decision.agent.stop)}</span>
              </span>
            ) : null}
            {sig.decision.agent.blocked.length ? (
              <span>
                {t('被风控拦下')} <span className="text-warn">{sig.decision.agent.blocked.join(' / ')}</span>
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {sig.decision?.plan ? (
        <div className="flex flex-col gap-0.5 rounded border border-primary/30 bg-primary/5 px-2 py-1.5 text-[10.5px]">
          <span className="font-semibold text-primary">{t('如果下单,会按这个方案')}</span>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground">
            <span>
              {t('入场')} <span className="num text-foreground">{fmtPrice(sig.decision.plan.entry)}</span> ({sig.decision.plan.intent === 'market' ? t('市价,限制最大偏离') : t('限价')})
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

      {sig.thread_id ? (
        <button className="self-start text-[11px] text-primary underline-offset-2 hover:underline" onClick={goToThread}>
          {t('查看这笔交易')}
        </button>
      ) : null}
    </div>
  );
}

export function SignalActions({ sig, busy, onApply, onSkip, onReconcile }: { sig: TraderSignal; busy: boolean; onApply: () => void; onSkip: () => void; onReconcile: () => void }) {
  const kind = reviewKind(sig);
  if (kind === 'reconcile')
    return (
      <div className="flex flex-wrap items-center gap-2">
        <JudgeLock feature="asp_reply">
          <Button size="xs" variant="destructive" disabled={busy} onClick={onReconcile}>
            {t('已人工核对')}
          </Button>
        </JudgeLock>
        <span className="text-[10.5px] text-warn">{t('先去交易页核对这笔的实际挂单/持仓;这个按钮只清除提醒,不动钱')}</span>
      </div>
    );
  if (kind === 'open' || kind === 'retry')
    return (
      <div className="flex flex-wrap items-center gap-2">
        <JudgeLock feature="asp_reply">
          <Button size="xs" variant="default" disabled={busy} onClick={onApply}>
            {kind === 'open' ? t('按这条下单') : t('重试下单')}
          </Button>
        </JudgeLock>
        <JudgeLock feature="asp_reply">
          <Button size="xs" variant="outline" disabled={busy} onClick={onSkip}>
            {t('跳过')}
          </Button>
        </JudgeLock>
      </div>
    );
  if (kind === 'management')
    return (
      <div className="flex flex-wrap items-center gap-2">
        <JudgeLock feature="asp_reply">
          <Button size="xs" variant="outline" disabled={busy} onClick={onSkip}>
            {t('跳过')}
          </Button>
        </JudgeLock>
        <span className="text-[10.5px] text-warn">{t('这是减仓/平仓类动作,请到交易页手动处理')}</span>
      </div>
    );
  return null;
}

/** 「待你处理」里的一条:头一行说清楚是什么、要你做什么,价位与按钮直接可见,细节与原文点开看。 */
export function SignalRow({
  sig,
  source,
  now,
  tpPartial,
  entryExpired,
  onApply,
  onSkip,
  onReconcile,
  busy,
}: {
  sig: TraderSignal;
  /** 来源服务名;拿不到就用信号自带的 trader。 */
  source?: string | null;
  now: number;
  tpPartial: { placed: string; dropped: { price: string; percent: number }[]; note: string } | null;
  entryExpired: boolean;
  onApply: () => void;
  onSkip: () => void;
  onReconcile: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const outcome = signalOutcome(sig);
  return (
    <div className="flex flex-col gap-1.5 border-b px-3 py-2.5 text-[12px] last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="num shrink-0 font-semibold">{sig.symbol}</span>
        {sig.side ? <span className={cn('font-medium', directionText(sig.side))}>{directionLabel(sig.side)}</span> : null}
        <span className="text-muted-foreground">{ACTION_LABEL[sig.action]}</span>
        {sig.market_type === 'spot' ? <span className="text-[10.5px] text-muted-foreground">{t('现货')}</span> : null}
        <OutcomeTag {...outcome} />
        <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground" title={fmtDateTime(sig.published_at)}>
          {relativeTime(sig.published_at, now)}
        </span>
      </div>
      <div className="min-w-0 truncate text-[11px] text-muted-foreground">{t('来自 {s}', { s: source || sig.trader })}</div>
      <LevelsRow levels={signalLevels(sig)} />
      <SignalActions sig={sig} busy={busy} onApply={onApply} onSkip={onSkip} onReconcile={onReconcile} />
      <button className="flex items-center gap-1 self-start text-[11px] text-muted-foreground hover:text-foreground" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {open ? t('收起详情') : t('详情与原文')}
      </button>
      {open ? (
        <div className="flex flex-col gap-1.5">
          <SignalDetail sig={sig} tpPartial={tpPartial} entryExpired={entryExpired} />
          {/* 来自其他用户的文本,原样展示,不解释为指令。 */}
          {sig.raw_text ? <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/30 p-2 text-[11px]">{sig.raw_text}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}
