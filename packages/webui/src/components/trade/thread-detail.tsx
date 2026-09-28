/**
 * 右侧「线程」tab:选中线程的详情。
 *   问题横幅(提交结果未知 / attention)→ 来源(策略运行 · 运行方式 · 统计 · 去策略研究)→ Jev 判断 → ASP 发布
 *   → 论点 / 持仓计划 / 失效条件 / 观察条件 → 数字。
 */
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Radio, TriangleAlert } from 'lucide-react';
import { strategyRunsApi } from '@/api/client';
import type { StrategyThread } from '@/api/types';
import { useJudgeLive, type JudgeLiveItem } from '@/api/judge-live';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { RUN_MODE_LABEL } from '@/components/my-strategies/run-panel';
import { fmtUsd, outcomeText, pct, questionRows, verdict } from '@/components/judge-live/logic';
import { THREAD_STATUS_LABEL, directionLabel, directionText, fmtClock, fmtDateTime, fmtPrice, fmtQty, marketOf, threadStatusBadgeClass } from '@/lib/format';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { aspForThread, fmtRunR, judgeForThread, runStatsLine, strategyRef, strategyResearchHref, type ThreadHealth, type ThreadOrigin } from './logic';
import { TONE_TEXT, entryText } from './thread-row';

export function ThreadDetail({
  thread,
  health,
  origin,
  judge,
  onClose,
  onOpenJev,
}: {
  thread: StrategyThread;
  health: ThreadHealth;
  origin: ThreadOrigin;
  judge: JudgeLiveItem | null;
  onClose: (() => void) | null;
  onOpenJev: () => void;
}) {
  const spot = marketOf(thread) === 'spot';
  const plan = thread.holding_plan;
  // 页面级判断流只取最近 200 条;策略运行开的单对不上时,按这个运行再取一次(同一个缓存 + SSE)
  const runId = origin.kind === 'run' ? origin.runId : null;
  const runJudgeQ = useJudgeLive({ runId, limit: 200, live: !!runId && !judge });
  const jev = judge ?? (runId ? judgeForThread(thread, runJudgeQ.data?.items) : null);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 text-[12.5px]" data-testid="trade-thread-detail">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className={threadStatusBadgeClass(thread.status)}>
          {THREAD_STATUS_LABEL[thread.status]}
        </Badge>
        <span className="num text-[14px] font-semibold">{thread.symbol}</span>
        <span className={cn('text-[12px] font-medium', directionText(thread.side))}>{spot ? t('现货持有') : directionLabel(thread.side)}</span>
        <span className="num ml-auto text-[11px] text-muted-foreground">{t('创建于 {at}', { at: fmtDateTime(thread.created_at) })}</span>
      </div>

      {health.kind === 'submit_unknown' || health.kind === 'attention' ? (
        <div className={cn('rounded-md border px-3 py-2', health.tone === 'danger' ? 'border-down/40 bg-down/[0.06]' : 'border-warn/40 bg-warn/[0.06]')} data-testid="trade-health-banner">
          <div className={cn('flex items-center gap-1.5 font-medium', TONE_TEXT[health.tone])}>
            <TriangleAlert className="size-3.5 shrink-0" />
            {health.label}
          </div>
          {health.detail ? <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{health.detail}</p> : null}
          {thread.entry_client_order_id ? <p className="num mt-1 text-[10.5px] text-muted-foreground">{t('订单号')} {thread.entry_client_order_id}</p> : null}
          {onClose ? (
            <div className="mt-2 flex gap-1.5">
              <Button size="xs" variant="outline" className="border-down/40 text-down hover:bg-down/10 hover:text-down" onClick={onClose}>
                {thread.status === 'pending_entry' ? (health.kind === 'submit_unknown' ? t('撤单并核对') : t('撤单')) : t('平仓')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <OriginBlock thread={thread} origin={origin} />

      {jev ? <JudgeBlock item={jev} onOpen={onOpenJev} /> : runId ? <p className="text-[11px] text-muted-foreground">{t('这笔没有对上的 Jev 判断(运行没开影子判断,或判断还没回来)')}</p> : null}

      <section className="space-y-1.5">
        <p className="leading-relaxed">{thread.thesis || <span className="text-muted-foreground">{t('没有写论点')}</span>}</p>
        {thread.invalidation_text ? (
          <p className="text-[11.5px] text-warn">
            {t('失效条件')}:{thread.invalidation_text}
          </p>
        ) : null}
        {thread.watch_conditions.length > 0 ? (
          <ul className="list-disc space-y-0.5 pl-4 text-[11.5px] text-muted-foreground">
            {thread.watch_conditions.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        ) : null}
      </section>

      {plan ? (
        <section className="rounded-md bg-muted/40 px-3 py-2 text-[11.5px] text-muted-foreground">
          <div className="kicker mb-1 text-[10px] text-foreground/80">{t('持仓计划')}</div>
          <div>
            {t('持仓周期 {a} · 确认 {b}', { a: plan.thesis_timeframe, b: plan.confirm_timeframe })} · {plan.origin === 'entry' ? t('入场计划已固定') : t('旧仓计划快照')}
          </div>
          <div className="num">
            {t('止损尺度 {tf} × {k} ATR', { tf: plan.atr_timeframe, k: Number(plan.atr_multiple_actual ?? plan.atr_multiple).toFixed(2) })}
            {reportedMultipleNote(plan)} · {t('成本后盈亏比 {rr}', { rr: plan.net_rr ? Number(plan.net_rr).toFixed(2) : t('未知') })}
          </div>
          <div>{plan.target_mode === 'single' ? t('止盈:首目标全平,其余目标仅供参考') : t('止盈:分批执行')}</div>
          {thread.last_policy_review ? (
            <div className="mt-1">
              {t('本次允许 {a}', { a: thread.last_policy_review.allowed_actions.join(' / ') })} · {thread.last_policy_review.reason}
            </div>
          ) : null}
        </section>
      ) : thread.status === 'in_position' ? (
        <p className="text-[11px] text-muted-foreground">{t('持仓计划将在下次复查建立;原保护单继续生效。')}</p>
      ) : null}

      <Separator />
      <dl className="num grid grid-cols-3 gap-x-4 gap-y-2 text-[11.5px]">
        <Field k={thread.status === 'in_position' ? t('开仓价') : t('入场')} v={entryText(thread)} />
        <Field k={t('止损')} v={thread.stop_price ? fmtPrice(thread.stop_price) : '—'} tone={thread.stop_price ? undefined : spot ? undefined : 'text-warn'} />
        <Field k={t('止盈')} v={thread.take_profits.length ? thread.take_profits.map((p) => fmtPrice(p)).join(' / ') : '—'} />
        <Field k={t('数量')} v={fmtQty(thread.qty)} />
        <Field k={spot ? t('花费') : t('保证金')} v={thread.margin_usdt ? `${Number(thread.margin_usdt).toFixed(2)} U` : '—'} />
        <Field k={spot ? t('市场') : t('杠杆')} v={spot ? t('现货') : `${thread.leverage}x · ${thread.margin_mode === 'cross' ? t('全仓') : t('逐仓')}`} />
      </dl>
    </div>
  );
}

function Field({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10.5px] text-muted-foreground">{k}</dt>
      <dd className={cn('truncate font-medium', tone)}>{v}</dd>
    </div>
  );
}

/** 来源:策略运行(名称 · 版本 · 运行方式 · 统计 · 去策略研究)/ 跟单 / 手动 / 对话 / AI Scan;ASP 发布情况一并写在这 */
function OriginBlock({ thread, origin }: { thread: StrategyThread; origin: ThreadOrigin }) {
  const ref = strategyRef(thread);
  const run = origin.kind === 'run' ? origin.run : null;
  const eventsQ = useQuery({
    queryKey: ['strategy-run-events', origin.kind === 'run' ? origin.runId : null, 200],
    queryFn: () => strategyRunsApi.events((origin as { runId: string }).runId, 200),
    enabled: origin.kind === 'run' && !!run,
    staleTime: 30_000,
    retry: false,
  });
  const asp = origin.kind === 'run' ? aspForThread(thread, run, eventsQ.data?.rows) : null;
  const r = run ? fmtRunR(run.stats.realized_r) : null;
  return (
    <section className="rounded-md border px-3 py-2" data-testid="trade-thread-origin">
      <div className="flex items-center gap-2">
        <span className="kicker text-[10px] text-muted-foreground">{t('来源')}</span>
        <span className="min-w-0 truncate font-medium">{origin.label}</span>
        {ref?.version ? <span className="num text-[11px] text-muted-foreground">v{ref.version}</span> : null}
        {run ? <span className="rounded-sm bg-primary/10 px-1.5 text-[11px] text-primary">{RUN_MODE_LABEL[run.mode]}</span> : null}
        {ref ? (
          <a href={strategyResearchHref(ref.id)} className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-[11px] text-primary hover:underline">
            {t('这条策略从哪来')}
            <ArrowUpRight className="size-3" />
          </a>
        ) : null}
      </div>
      {run ? (
        <div className="num mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
          <span>{runStatsLine(run)}</span>
          {r ? <span className={(run.stats.realized_r ?? 0) >= 0 ? 'text-up' : 'text-down'}>{t('已实现 {r}', { r })}</span> : null}
          <span>{run.execution.label}</span>
        </div>
      ) : origin.kind === 'run' ? (
        <div className="mt-1 text-[11px] text-muted-foreground">{t('运行 {id} 已不在列表里', { id: origin.runId })}</div>
      ) : (
        <div className="mt-1 text-[11px] text-muted-foreground">
          {origin.kind === 'manual' ? t('你在下单面板手动下的') : origin.kind === 'chat' ? t('在对话里让 agent 下的') : origin.kind === 'trader' ? t('带单员信号触发,agent 给依据') : t('AI Scan:agent 拿 playbook 看盘、模型判断后开的')}
        </div>
      )}
      {asp ? (
        <div className="mt-1 flex items-center gap-1 text-[11px]" data-testid="trade-thread-asp">
          <Radio className={cn('size-3', asp.kind === 'published' ? 'text-primary' : 'text-muted-foreground')} />
          {asp.kind === 'published' ? (
            <span>
              {t('这笔信号已发到信号市场')} <span className="num text-muted-foreground">{fmtClock(asp.at).slice(0, 5)}</span>
            </span>
          ) : asp.kind === 'off' ? (
            <span className="text-muted-foreground">{t('没发信号(运行没开 ASP 发布)')}</span>
          ) : asp.kind === 'not_found' ? (
            <span className="text-muted-foreground">{t('运行开着 ASP 发布,但这笔没查到发布记录')}</span>
          ) : (
            <span className="text-muted-foreground">{t('ASP 发布情况读取中…')}</span>
          )}
        </div>
      ) : null}
    </section>
  );
}

function JudgeBlock({ item, onOpen }: { item: JudgeLiveItem; onOpen: () => void }) {
  const v = verdict(item);
  const rows = questionRows(item);
  const out = outcomeText(item);
  return (
    <section className="rounded-md border px-3 py-2" data-testid="trade-thread-jev">
      <div className="flex items-center gap-2">
        <span className="kicker text-[10px] text-muted-foreground">Jev</span>
        <span className={cn('font-semibold', v.tone === 'up' ? 'text-up' : v.tone === 'down' ? 'text-down' : v.tone === 'warn' ? 'text-warn' : 'text-muted-foreground')}>{v.text}</span>
        <span className="text-[11px] text-muted-foreground">{item.mode === 'gate' ? t('挡单') : t('影子')}</span>
        <span className="num text-[11px] text-muted-foreground">{fmtUsd(item.cost_usd)}</span>
        <button type="button" onClick={onOpen} className="ml-auto text-[11px] text-primary hover:underline">
          {t('看判断流 →')}
        </button>
      </div>
      <div className="num mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
        {rows.slice(0, 3).map((r) => (
          <span key={r.key}>
            {r.name} {r.top ? `${r.top.name} ${pct(r.top.p)}` : '—'}
          </span>
        ))}
        {out ? <span>{out}</span> : null}
      </div>
    </section>
  );
}

/** 模型报的倍数和实际止损差得多(>10%)时补一句「模型报 ×1.5」;显示的主数字永远是实际倍数 */
function reportedMultipleNote(plan: { atr_multiple: string; atr_multiple_actual?: string }): string | null {
  const actual = Number(plan.atr_multiple_actual), reported = Number(plan.atr_multiple);
  if (!(actual > 0) || !(reported > 0) || Math.abs(reported - actual) / actual <= 0.1) return null;
  return t('(模型报 ×{k})', { k: reported.toFixed(1) });
}
