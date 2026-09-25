/**
 * 信息员页(#/intel)= RADAR 角色的情报工作台(docs/design/intel-page-2026-09-06.md,09-06 拍板):
 * 单页从上到下读,不再嵌 tab——
 *   顶栏(一句话态势 · 新鲜度 · 立即跑 · 频率 · 来源)→ 首屏重点(key_points + 风险事件)
 *   → 主栏新闻流(原文链接 / 来源徽章 / 相关度≠可信度 / 模型解读两行 / 拿去问 Agent)
 *   → 侧栏(主流币 / 情绪 / 异动,默认收起)→ 底部折叠(bias 时间线 / 原始事件)。
 * 边界:信息员只解释环境;「候选」这里叫「关注线索」并链到筛选页,排名/应用名单归筛选页。
 * 数据:沿用既有 react-query key(['market-state'] 等),App.tsx 单条 SSE 失效后自动重渲染。
 * 信息源:默认五源(CoinDesk / Cointelegraph / Decrypt / PANews / 美联储),**不开放自定义**,本页只读展示采集状态(§9.17)。
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Crosshair, MessageSquareText, RefreshCw, Rss } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/api/client';
import type { InfoSource, MarketState, Regime, Workflow } from '@/api/types';
import { BiasTimeline } from '@/components/intel/bias-timeline';
import { EventsTable } from '@/components/intel/events-table';
import { MajorsTable } from '@/components/intel/majors-table';
import { SentimentGauge } from '@/components/intel/sentiment-gauge';
import { Pane, Workspace } from '@/components/pane';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { askAgent } from '@/lib/ask-agent';
import { BIAS_LABEL, REGIME_LABEL, directionLabel, fmtDateTime, fmtPct, relativeTime, useNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';

const REGIME_BADGE_CLASS: Record<Regime, string> = {
  trend_up: 'bg-up/15 text-up border-up/30',
  trend_down: 'bg-down/15 text-down border-down/30',
  range: 'bg-muted text-muted-foreground border-transparent',
  volatile: 'bg-warn/15 text-warn border-warn/30',
  unclear: 'bg-muted text-muted-foreground border-transparent',
};

const BIAS_BADGE_CLASS: Record<MarketState['bias'], string> = {
  long: 'bg-up/15 text-up border-up/30',
  short: 'bg-down/15 text-down border-down/30',
  neutral: 'bg-muted text-muted-foreground border-transparent',
};

type Relevance = 'high' | 'medium' | 'low';
const RELEVANCE_LABEL: Record<Relevance, string> = tmap({ high: '强', medium: '中', low: '弱' });
const RELEVANCE_CLASS: Record<Relevance, string> = {
  high: 'bg-primary/15 text-primary border-primary/30',
  medium: 'bg-warn/15 text-warn border-warn/30',
  low: 'bg-muted text-muted-foreground border-transparent',
};

/** 09-06 拍板的默认五源;网关没给来源表之前,来源面板按这份名单显示「状态未知」 */
const DEFAULT_SOURCE_NAMES = ['CoinDesk', 'Cointelegraph', 'Decrypt', 'PANews', '美联储'];

const INFO_INTERVALS_MIN = [3, 5, 10, 15, 30, 60];

function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function newsHref(n: MarketState['news'][number]): string | null {
  return n.url && /^https?:\/\//.test(n.url) ? n.url : null;
}

// ---------------------------------------------------------------------------
// 顶栏:一句话态势 + 新鲜度 + 立即跑 + 频率 + 来源

type Freshness = { tone: 'ok' | 'stale' | 'failed' | 'none'; text: string };

/** 口径 = v3-ui-contract §9.17:任一源 error 黄;全部 error、总结失败、或 as_of 超过 info_every_ms×2 红 */
function freshness(state: MarketState | null, workflow: Workflow | null, sources: InfoSource[] | null, now: number): Freshness {
  if (!state) return { tone: 'none', text: t('还没跑过') };
  const ago = relativeTime(state.as_of, now);
  if (state.error) return { tone: 'failed', text: t('上次总结失败 · {ago}', { ago }) };
  const every = workflow?.info_every_ms ?? 0;
  if (every > 0 && now - state.as_of > every * 2) return { tone: 'failed', text: t('已过期 · {ago}更新的', { ago }) };
  const errs = sources?.filter((s) => s.last_status === 'error').length ?? 0;
  if (sources && sources.length > 0 && errs === sources.length) return { tone: 'failed', text: t('所有来源都抓失败了 · {ago}', { ago }) };
  if (errs > 0) return { tone: 'stale', text: t('{n} 个来源抓失败 · {ago}更新的', { n: errs, ago }) };
  return { tone: 'ok', text: t('{ago}更新的', { ago }) };
}

const FRESH_CLASS: Record<Freshness['tone'], string> = {
  ok: 'text-muted-foreground',
  stale: 'text-warn',
  failed: 'text-down',
  none: 'text-muted-foreground',
};

function IntervalPopover({ workflow }: { workflow: Workflow | null }) {
  const queryClient = useQueryClient();
  const patch = useMutation({
    mutationFn: (minutes: number) => api.patchWorkflow({ info_every_ms: minutes * 60_000 }),
    onSuccess: (r) => {
      if (r.errors.length) toast.error(t('没改成'), { description: r.errors.join(';') });
      else toast.success(t('信息员频率改好了'));
      void queryClient.invalidateQueries({ queryKey: ['workflow'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (err) => toast.error(t('提交失败'), { description: err instanceof Error ? err.message : String(err) }),
  });
  const cur = workflow ? Math.round(workflow.info_every_ms / 60_000) : null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={cn(buttonVariants({ size: 'sm', variant: 'ghost' }), 'text-[11px] text-muted-foreground aria-expanded:bg-muted')} disabled={!workflow} title={t('信息员频率')}>
          {t('每 {n} 分钟', { n: cur ?? '—' })}
          <ChevronDown className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44 p-2">
        <div className="kicker mb-1.5 text-[10px] text-muted-foreground">{t('信息员频率')}</div>
        <div className="grid grid-cols-3 gap-1">
          {INFO_INTERVALS_MIN.map((m) => (
            <Button key={m} size="xs" variant={m === cur ? 'default' : 'outline'} disabled={patch.isPending} onClick={() => patch.mutate(m)}>
              {t('{n} 分', { n: m })}
            </Button>
          ))}
        </div>
        <div className="mt-1.5 text-[10px] leading-4 text-muted-foreground">{t('长配置在设置页 · 工作流的「节奏」组里。')}</div>
      </PopoverContent>
    </Popover>
  );
}

function SourceRow({ s, now }: { s: InfoSource; now: number }) {
  const bad = s.last_status === 'error';
  return (
    <li className="flex items-center gap-2 py-1 text-[11px]" title={t('{url} · {n}h 窗口', { url: s.url, n: s.max_age_hours })}>
      <span className={cn('size-1.5 shrink-0 rounded-full', bad ? 'bg-down' : s.last_status === 'ok' ? 'bg-up' : 'bg-muted-foreground/40')} />
      <span className="min-w-0 flex-1 truncate">
        {s.label} <span className="text-[10px] text-muted-foreground">{s.lang}</span>
      </span>
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {bad ? (
          <span className="text-down" title={s.last_error ?? undefined}>
            {t('失败')}
          </span>
        ) : s.last_fetch_at ? (
          relativeTime(s.last_fetch_at, now)
        ) : (
          t('还没抓过')
        )}
        {s.item_count != null ? ` · ${t('抓 {n}', { n: s.item_count })}${s.used_count != null ? ` ${t('用 {n}', { n: s.used_count })}` : ''}` : ''}
      </span>
    </li>
  );
}

function SourcesPopover({ now, sources, error }: { now: number; sources: InfoSource[] | null; error: boolean }) {
  const failed = sources?.filter((s) => s.last_status === 'error').length ?? 0;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={cn(buttonVariants({ size: 'sm', variant: 'ghost' }), 'text-[11px] aria-expanded:bg-muted', failed ? 'text-down' : 'text-muted-foreground')} title={t('新闻源和采集状态')}>
          <Rss className="size-3" />
          {t('新闻源')} {sources ? sources.length : DEFAULT_SOURCE_NAMES.length}
          {failed ? ` · ${t('{n} 个失败', { n: failed })}` : ''}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        <div className="kicker mb-1 text-[10px] text-muted-foreground">{t('新闻源(只读)')}</div>
        {sources ? (
          <ul className="divide-y">
            {sources.map((s) => (
              <SourceRow key={s.name} s={s} now={now} />
            ))}
          </ul>
        ) : (
          <>
            <ul className="divide-y">
              {DEFAULT_SOURCE_NAMES.map((n) => (
                <li key={n} className="flex items-center gap-2 py-1 text-[11px]">
                  <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40" />
                  <span className="flex-1">{t(n)}</span>
                  <span className="text-[10px] text-muted-foreground">{t('状态未知')}</span>
                </li>
              ))}
            </ul>
            <div className="mt-1.5 text-[10px] leading-4 text-warn">{error ? t('网关没返回来源状态(/api/info/sources)。') : t('读取中…')}</div>
          </>
        )}
        <div className="mt-1.5 text-[10px] leading-4 text-muted-foreground">{t('固定这五个源,不支持自定义;模型只读,不改来源。')}</div>
      </PopoverContent>
    </Popover>
  );
}

function IntelHeader({ state, workflow, now, running, onRunNow }: { state: MarketState | null; workflow: Workflow | null; now: number; running: boolean; onRunNow: () => void }) {
  const sourcesQ = useQuery({ queryKey: ['info-sources'], queryFn: api.infoSources, retry: false, refetchInterval: 60_000 });
  const sources = sourcesQ.data?.sources ?? null;
  const fresh = freshness(state, workflow, sources, now);
  const countdown = state && workflow ? state.as_of + workflow.info_every_ms - now : null;
  return (
    <div className="flex shrink-0 flex-col gap-1.5 rounded-md border bg-card px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        {state ? (
          <>
            <Badge variant="outline" className={cn('h-5 px-2 text-[11px]', REGIME_BADGE_CLASS[state.regime])}>
              {REGIME_LABEL[state.regime]}
            </Badge>
            <Badge variant="outline" className={cn('h-5 px-2 text-[11px]', BIAS_BADGE_CLASS[state.bias])}>
              {BIAS_LABEL[state.bias]}
            </Badge>
          </>
        ) : null}
        <span className={cn('text-[11px]', FRESH_CLASS[fresh.tone])} title={state ? fmtDateTime(state.as_of) : undefined}>
          {fresh.text}
        </span>
        {countdown !== null && fresh.tone === 'ok' ? <span className="num text-[11px] text-muted-foreground">{countdown > 0 ? t('下次 {t}', { t: fmtCountdown(countdown) }) : t('马上更新')}</span> : null}
        <div className="ml-auto flex items-center gap-1">
          <SourcesPopover now={now} sources={sources} error={sourcesQ.isError} />
          <IntervalPopover workflow={workflow} />
          <Button size="sm" variant="outline" disabled={running} onClick={onRunNow}>
            <RefreshCw data-slot="icon" className={running ? 'animate-spin' : undefined} />
            {running ? t('运行中…') : t('立即总结')}
          </Button>
        </div>
      </div>
      {state ? (
        <p className="text-[12.5px] leading-relaxed text-foreground">{state.summary || t('（这次没有总结)')}</p>
      ) : (
        <p className="text-[12px] text-muted-foreground">{t('信息员还没跑过。点「立即总结」出第一份态势。')}</p>
      )}
      {state?.error ? <div className="rounded-sm border border-down/30 bg-down/10 px-2 py-1 text-[11.5px] text-down">{t('采集失败')}:{state.error}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 首屏重点:三条 key_points + 风险事件 + 关注线索(链到筛选页)

function Highlights({ state }: { state: MarketState }) {
  const points = state.key_points.slice(0, 3);
  return (
    <Workspace>
      <Pane title={t('先看什么')} hint={state.model ? t('模型 {name}', { name: state.model }) : undefined}>
        <div className="grid grid-cols-1 gap-0 divide-y md:grid-cols-2 md:divide-x md:divide-y-0">
          <div className="p-3">
            <div className="kicker mb-1 text-[10px] text-muted-foreground">{t('重点')}</div>
            {points.length ? (
              <ol className="list-decimal space-y-1 pl-4 text-[12px] text-foreground">
                {points.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ol>
            ) : (
              <div className="text-[11.5px] text-muted-foreground">{t('这次没列出重点。')}</div>
            )}
          </div>
          <div className="p-3">
            <div className="kicker mb-1 text-[10px] text-muted-foreground">{t('风险事件')}</div>
            {state.risk_events.length ? (
              <ul className="space-y-1">
                {state.risk_events.map((r, i) => (
                  <li key={i} className="rounded-sm border border-down/30 bg-down/10 px-2 py-1 text-[11.5px] text-down">
                    {r}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-[11.5px] text-muted-foreground">{t('无')}</div>
            )}
            {state.candidates.length ? (
              <div className="mt-2 border-t pt-2">
                <div className="mb-1 flex items-center gap-1 text-[10px]">
                  <span className="kicker text-muted-foreground">{t('关注线索')}</span>
                  <a href="#screener" className="ml-auto inline-flex items-center gap-0.5 text-primary hover:underline">
                    <Crosshair className="size-3" />
                    {t('去筛选页排名')}
                  </a>
                </div>
                <ul className="space-y-0.5 text-[11.5px]">
                  {state.candidates.map((c, i) => (
                    <li key={`${c.symbol}-${i}`} className="flex items-baseline gap-1.5">
                      <span className={cn('shrink-0 text-[10px]', c.direction === 'long' ? 'text-up' : 'text-down')}>{directionLabel(c.direction)}</span>
                      <span className="font-medium">{c.symbol}</span>
                      <span className="min-w-0 truncate text-muted-foreground">{c.why}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-1 text-[10px] text-muted-foreground">{t('线索只解释环境;进不进名单,在筛选页定。')}</div>
              </div>
            ) : null}
          </div>
        </div>
      </Pane>
    </Workspace>
  );
}

// ---------------------------------------------------------------------------
// 新闻流

function NewsItem({ n, now }: { n: MarketState['news'][number]; now: number }) {
  const [open, setOpen] = useState(false);
  const href = newsHref(n);
  const ask = () => {
    const lines = [t('这条新闻对当前市场状态、对我们名单里的币,意味着什么?'), `${t('标题')}:${n.title || t('（无标题)')}`, `${t('来源')}:${n.source} · ${fmtDateTime(n.published_at)}`];
    if (href) lines.push(`${t('原文')}:${href}`);
    if (n.digest) lines.push(`${t('信息员解读')}:${n.digest}`);
    if (n.event_id) lines.push(t('(事件 {id})', { id: n.event_id }));
    askAgent(lines.join('\n'));
  };
  return (
    <li className="px-3 py-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-muted-foreground">
        <Badge variant="outline" className="h-4 px-1.5 text-[10px]" title={n.source}>
          {n.source_label ?? n.source}
        </Badge>
        <span title={fmtDateTime(n.published_at)}>{relativeTime(n.published_at, now)}</span>
        <span className="inline-flex items-center gap-1" title={t('相关度是模型估的「和我们盘面有多相关」,不是可信度')}>
          {t('相关度')}
          <Badge variant="outline" className={cn('h-4 px-1.5 text-[10px]', RELEVANCE_CLASS[n.relevance])}>
            {RELEVANCE_LABEL[n.relevance]}
          </Badge>
        </span>
        <Button size="xs" variant="ghost" className="ml-auto h-5 text-[10.5px] text-muted-foreground hover:text-primary" onClick={ask} title={t('跳到 Agent 页预填进对话框,发不发你定')}>
          <MessageSquareText data-slot="icon" />
          {t('拿去问 Agent')}
        </Button>
      </div>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer noopener" className="mt-0.5 block font-medium text-foreground hover:text-primary hover:underline" title={href}>
          {n.title || t('（无标题)')} <span className="text-[10px] text-muted-foreground">↗</span>
        </a>
      ) : (
        <div className="mt-0.5 font-medium text-foreground">
          {n.title || t('（无标题)')} <span className="text-[10px] text-muted-foreground">· {t('没有原文链接')}</span>
        </div>
      )}
      {n.digest ? (
        <button type="button" className="mt-0.5 block w-full text-left text-muted-foreground" onClick={() => setOpen((v) => !v)} title={open ? t('收起') : t('展开')}>
          <span className="kicker mr-1 text-[9.5px] text-muted-foreground/70">{t('模型解读')}</span>
          <span className={cn(!open && 'line-clamp-2')}>{n.digest}</span>
        </button>
      ) : null}
    </li>
  );
}

function NewsStream({ state, now }: { state: MarketState; now: number }) {
  const [mode, setMode] = useState<'time' | 'high'>('time');
  const list = useMemo(() => {
    const base = mode === 'high' ? state.news.filter((n) => n.relevance === 'high') : state.news;
    return [...base].sort((a, b) => b.published_at - a.published_at);
  }, [state.news, mode]);
  return (
    <Workspace className="min-h-0">
      <Pane
        title={t('新闻流')}
        hint={t('{n} 条', { n: state.news.length })}
        actions={
          <div className="flex gap-0.5">
            <Button size="xs" variant={mode === 'time' ? 'secondary' : 'ghost'} onClick={() => setMode('time')}>
              {t('按时间')}
            </Button>
            <Button size="xs" variant={mode === 'high' ? 'secondary' : 'ghost'} onClick={() => setMode('high')}>
              {t('高相关')}
            </Button>
          </div>
        }
      >
        {state.error && state.news.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11.5px] text-down">{t('采集失败,这轮没有新闻。')}</div>
        ) : state.news.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11.5px] text-muted-foreground">{t('这轮没有新闻。')}</div>
        ) : list.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11.5px] text-muted-foreground">{t('没有高相关的新闻。')}</div>
        ) : (
          <ul className="divide-y">
            {list.map((n) => (
              <NewsItem key={n.event_id ?? n.ref} n={n} now={now} />
            ))}
          </ul>
        )}
      </Pane>
    </Workspace>
  );
}

// ---------------------------------------------------------------------------
// 折叠块(侧栏 / 底部共用)

function Fold({ title, hint, defaultOpen = false, children }: { title: string; hint?: string; defaultOpen?: boolean; children: React.ReactNode }) {
  return (
    <details className="group rounded-md border bg-card" open={defaultOpen}>
      <summary className="flex h-8 cursor-pointer list-none items-center gap-2 border-b border-transparent px-2.5 select-none group-open:border-border">
        <ChevronDown className="size-3 text-muted-foreground transition-transform group-open:rotate-0 -rotate-90" />
        <span className="kicker text-[10.5px] text-foreground/85">{title}</span>
        {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      </summary>
      <div>{children}</div>
    </details>
  );
}

function MoversChips({ movers }: { movers: MarketState['top_movers'] }) {
  const sorted = useMemo(() => [...movers].sort((a, b) => Math.abs(Number(b.change_24h_pct)) - Math.abs(Number(a.change_24h_pct))), [movers]);
  if (sorted.length === 0) return <div className="py-3 text-center text-[11.5px] text-muted-foreground">{t('没有涨跌幅数据。')}</div>;
  return (
    <div className="flex flex-wrap gap-1.5 p-2">
      {sorted.map((m) => {
        const up = Number(m.change_24h_pct) >= 0;
        return (
          <span key={m.symbol} className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]', up ? 'border-up/30 bg-up/10' : 'border-down/30 bg-down/10')}>
            <span className="font-medium text-foreground">{m.symbol}</span>
            <span className={cn('num', up ? 'text-up' : 'text-down')}>{fmtPct(m.change_24h_pct)}</span>
          </span>
        );
      })}
    </div>
  );
}

function DataSide({ state }: { state: MarketState }) {
  return (
    <div className="flex flex-col gap-2">
      <Fold title={t('主流币')} hint={t('{n} 个', { n: state.majors.length })}>
        <MajorsTable majors={state.majors} />
      </Fold>
      <Fold title={t('情绪')} hint={state.sentiment.fng != null ? `F&G ${state.sentiment.fng}` : undefined}>
        <SentimentGauge value={state.sentiment.fng} label={state.sentiment.fng_label} />
      </Fold>
      <Fold title={t('异动')} hint={t('{n} 个', { n: state.top_movers.length })}>
        <MoversChips movers={state.top_movers} />
      </Fold>
    </div>
  );
}

function HistoryFolds() {
  const [wanted, setWanted] = useState(false);
  const historyQ = useQuery({ queryKey: ['market-state-history'], queryFn: () => api.marketStateHistory(50), enabled: wanted });
  const eventsQ = useQuery({ queryKey: ['info-events'], queryFn: () => api.infoEvents(100), enabled: wanted });
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-2" onClick={() => setWanted(true)}>
      <Fold title={t('偏向历史')} hint={historyQ.data ? t('{n} 条', { n: historyQ.data.history.length }) : undefined}>
        {historyQ.isLoading ? (
          <div className="space-y-2 p-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        ) : historyQ.isError ? (
          <div className="py-4 text-center text-[11.5px] text-destructive">{t('历史加载失败。')}</div>
        ) : (
          <div className="p-2">
            <BiasTimeline history={historyQ.data?.history ?? []} />
          </div>
        )}
      </Fold>
      <Fold title={t('原始事件')} hint={eventsQ.data ? t('{n} 条', { n: eventsQ.data.events.length }) : undefined}>
        {eventsQ.isLoading ? (
          <div className="space-y-2 p-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        ) : eventsQ.isError ? (
          <div className="py-4 text-center text-[11.5px] text-destructive">{t('事件加载失败。')}</div>
        ) : (
          <EventsTable events={eventsQ.data?.events ?? []} />
        )}
      </Fold>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 页面

export function IntelPage() {
  const queryClient = useQueryClient();
  const now = useNow(1000);

  const marketStateQ = useQuery({ queryKey: ['market-state'], queryFn: api.marketState });
  const workflowQ = useQuery({ queryKey: ['workflow'], queryFn: api.workflow });

  const runInfo = useMutation({
    mutationFn: api.infoRunNow,
    onSuccess: () => {
      toast.info(t('已排上,结果出来自动刷新'));
      void queryClient.invalidateQueries({ queryKey: ['market-state'] });
    },
    onError: (err) => toast.error(t('提交失败'), { description: err instanceof Error ? err.message : String(err) }),
  });

  const state = marketStateQ.data ?? null;
  const workflow = workflowQ.data ?? null;

  if (marketStateQ.isLoading) {
    return (
      <div className="flex h-full flex-col gap-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="min-h-0 w-full flex-1" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <IntelHeader state={state} workflow={workflow} now={now} running={runInfo.isPending} onRunNow={() => runInfo.mutate()} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {state ? (
          <div className="flex flex-col gap-2 pb-2">
            <Highlights state={state} />
            <div className="grid grid-cols-1 gap-2 lg:grid-cols-[minmax(0,1fr)_300px]">
              <NewsStream state={state} now={now} />
              <DataSide state={state} />
            </div>
            <HistoryFolds />
          </div>
        ) : (
          <Workspace className="flex h-48 items-center justify-center">
            <div className="text-[12.5px] text-muted-foreground">{t('信息员还没跑过。')}</div>
          </Workspace>
        )}
      </div>
    </div>
  );
}
