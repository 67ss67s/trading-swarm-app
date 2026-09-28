/**
 * Agent 页右栏「Jev 判断流」(docs/design/jev-live-2026-09-25.md):
 *   顶部今日汇总(调用数 / 花费 / 跟与不跟 / 影子与挡单 + 影子判断与实际结果的对照),
 *   下面每条判断一行:时间、币种方向、每个问题的概率条、跟或不跟、影子还是挡单、费用;点开看 state 摘要(盘口/清算可用性标出来)。
 * 数据:useJudgeLive(GET /api/judge/live + SSE judge.live)。
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { judgeLiveApi, useJudgeLive, type JudgeLiveItem, type JudgeLiveSummary } from '@/api/judge-live';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtClock } from '@/lib/format';
import { t, listSep } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { comparisonLine, directionText, fmtUsd, microBadges, microNote, MODE_LABEL, outcomeText, pct, questionRows, reasonLabel, stateRows, summaryLine, verdict, type QuestionRow } from './logic';

export interface JudgeLiveFeedProps {
  /** 只看某个运行;不传 = 全部运行 */
  runId?: string | null;
  limit?: number;
  className?: string;
}

export function JudgeLiveFeed({ runId = null, limit = 50, className }: JudgeLiveFeedProps) {
  const q = useJudgeLive({ runId, limit });
  return <JudgeLiveFeedView className={className} loading={q.isLoading} error={q.error ? (q.error as Error).message : null} items={q.data?.items} summary={q.data?.summary} />;
}

/** 纯展示(测试直接渲染它) */
export function JudgeLiveFeedView({ items, summary, loading, error, className, openId }: { items?: JudgeLiveItem[]; summary?: JudgeLiveSummary; loading?: boolean; error?: string | null; className?: string; openId?: string }) {
  return (
    <div className={cn('flex min-h-0 flex-col text-[11.5px]', className)}>
      <JudgeLiveSummaryBar summary={summary} />
      {error ? <div className="border-b bg-destructive/10 px-2.5 py-1.5 text-destructive">{t('判断流读取失败:{detail}', { detail: error })}</div> : null}
      {loading && !items ? (
        <div className="space-y-1.5 p-2.5"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
      ) : !items?.length ? (
        <div className="px-2.5 py-3 text-muted-foreground">{t('还没有实盘判断。策略运行出候选时,Jev 会在这里给出判断(没带判断要素的策略只做影子判断,不挡单)。')}</div>
      ) : (
        <ul className="divide-y">
          {items.map(it => <JudgeLiveRow key={it.id} item={it} defaultOpen={it.id === openId} />)}
        </ul>
      )}
    </div>
  );
}

export function JudgeLiveSummaryBar({ summary }: { summary?: JudgeLiveSummary }) {
  const s = summaryLine(summary), cmp = comparisonLine(summary);
  return (
    <div className="shrink-0 border-b">
      <div className="grid grid-cols-3 divide-x">
        <Stat k={t('今日调用')} v={s.calls} sub={s.modes} />
        <Stat k={t('花费')} v={s.cost} />
        <Stat k={t('跟 / 不跟')} v={s.ratio} />
      </div>
      {cmp ? <div className="border-t px-2.5 py-1 text-[10.5px] text-muted-foreground">{cmp}</div> : null}
      {summary && Object.keys(summary.today.skip_reasons).length ? (
        <div className="border-t px-2.5 py-1 text-[10.5px] text-muted-foreground">
          {t('没调用:')}{Object.entries(summary.today.skip_reasons).map(([k, n]) => `${reasonLabel(k)} ×${n}`).join(' · ')}
        </div>
      ) : null}
    </div>
  );
}

function Stat({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="min-w-0 px-2.5 py-1.5">
      <div className="text-[10px] text-muted-foreground">{k}</div>
      <div className="num truncate text-[12.5px] font-semibold">{v}</div>
      {sub ? <div className="truncate text-[9.5px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

const TONE: Record<string, string> = { up: 'bg-up/15 text-up', down: 'bg-down/15 text-down', warn: 'bg-warn/15 text-warn', muted: 'bg-muted text-muted-foreground' };

export function JudgeLiveRow({ item, defaultOpen = false }: { item: JudgeLiveItem; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const v = verdict(item), rows = questionRows(item), outcome = outcomeText(item);
  return (
    <li>
      <div role="button" tabIndex={0} className="flex w-full cursor-pointer flex-col gap-1 px-2.5 py-1.5 text-left hover:bg-muted/40" onClick={() => setOpen(o => !o)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o); } }} aria-expanded={open}>
        <div className="flex items-center gap-1.5">
          {open ? <ChevronDown className="size-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3 shrink-0 text-muted-foreground" />}
          <span className="num text-[10.5px] text-muted-foreground">{fmtClock(item.created_at)}</span>
          <span className="num font-semibold">{item.symbol}</span>
          <span className={item.candidate.direction === 'long' ? 'text-up' : 'text-down'}>{directionText(item.candidate.direction)}</span>
          <span className={cn('rounded-sm px-1 text-[10px]', item.mode === 'gate' ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground')} title={item.mode === 'gate' ? t('挡单:这次判断决定下不下单') : t('影子:只记录 Jev 会怎么选,不影响下单')}>
            {MODE_LABEL[item.mode]}
          </span>
          <span className={cn('rounded-sm px-1 text-[10.5px] font-semibold', TONE[v.tone])}>{v.text}</span>
          <span className="num ml-auto text-[10.5px] text-muted-foreground">{fmtUsd(item.cost_usd)}</span>
        </div>
        {rows.length && rows.some(r => r.segments.length) ? (
          <div className="space-y-0.5 pl-4">{rows.map(r => <ProbRow key={r.key} row={r} />)}</div>
        ) : item.status === 'skipped' || item.status === 'error' ? (
          <div className="pl-4 text-[10.5px] text-muted-foreground">{reasonLabel(item.reason_codes[0] ?? item.error ?? '')}</div>
        ) : null}
      </div>
      {open ? <JudgeLiveDetail item={item} outcome={outcome} /> : null}
    </li>
  );
}

const SEG_COLOR = ['bg-up/70', 'bg-down/60', 'bg-primary/60', 'bg-warn/60'];
const SCORE_COLOR = ['bg-down/60', 'bg-warn/60', 'bg-up/50', 'bg-up/80'];
export function ProbRow({ row }: { row: QuestionRow }) {
  const colors = row.segments.length === 4 ? SCORE_COLOR : SEG_COLOR;
  return (
    <div className="flex items-center gap-1.5" title={row.instructions}>
      <span className="w-16 shrink-0 truncate text-[10.5px] text-muted-foreground">{row.name}</span>
      <div className="flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" role="img" aria-label={row.segments.map(s => `${s.name} ${pct(s.p)}`).join(', ')}>
        {row.segments.map((s, i) => <div key={s.label} className={colors[i % colors.length]} style={{ width: `${s.p * 100}%` }} />)}
      </div>
      <span className={cn('num w-16 shrink-0 text-right text-[10.5px]', row.passed === false && 'text-down')}>{row.top ? `${row.top.name} ${pct(row.top.p)}` : '—'}</span>
    </div>
  );
}

export function JudgeLiveDetail({ item, outcome }: { item: JudgeLiveItem; outcome: string | null }) {
  const [busy, setBusy] = useState(false);
  const facts = stateRows(item.state), badges = microBadges(item.state), note = microNote(item.state?.micro.note);
  const c = item.candidate;
  const turnOff = async () => {
    setBusy(true);
    try { await judgeLiveApi.setShadow(item.run_id, false); toast.success(t('已关掉这个运行的影子判断')); }
    catch (e) { toast.error(t('关不掉:{detail}', { detail: (e as Error).message })); }
    finally { setBusy(false); }
  };
  return (
    <div className="space-y-1.5 bg-muted/30 px-2.5 py-2 pl-6 text-[10.5px]">
      <div className="text-muted-foreground">
        {item.strategy_name} · {item.timeframe} · {t('入场 {e} · 止损 {s} · 目标 {g}', { e: c.entry, s: c.stop, g: c.target ?? '—' })}{c.reward_risk != null ? ` · ${t('盈亏比 {rr}', { rr: c.reward_risk.toFixed(2) })}` : ''}
      </div>
      <div className="flex flex-wrap gap-1">
        {badges.map(b => <span key={b.key} className={cn('rounded-sm px-1', b.ok ? 'bg-up/15 text-up' : 'bg-muted text-muted-foreground')}>{b.text}</span>)}
        {note ? <span className="text-muted-foreground">{note}</span> : null}
      </div>
      {facts.length ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5">
          {facts.map(f => (
            <div key={f.key} className="flex min-w-0 justify-between gap-2">
              <dt className="truncate text-muted-foreground">{f.name}</dt>
              <dd className="num truncate">{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : <div className="text-muted-foreground">{t('这次没有生成判断状态')}</div>}
      <div className="text-muted-foreground">
        {[
          item.reason_codes.length ? t('原因:{r}', { r: item.reason_codes.map(reasonLabel).join(listSep()) }) : null,
          item.error && item.status !== 'skipped' ? t('错误:{e}', { e: item.error }) : null,
          item.latency_ms != null ? t('耗时 {ms} ms', { ms: item.latency_ms }) : null,
          item.model ? t('模型 {m}', { m: item.model }) : null,
          outcome ? t('后来:{o}', { o: outcome }) : null,
        ].filter(Boolean).join(' · ')}
      </div>
      {item.mode === 'shadow' ? (
        <button type="button" disabled={busy} className="text-primary hover:underline disabled:opacity-50" onClick={() => void turnOff()}>
          {t('关掉这个运行的影子判断')}
        </button>
      ) : null}
    </div>
  );
}
