/**
 * 事件区(#/events,契约 docs/demo/v3-ui-contract.md §9.30;设计 strategy-loop-v2-and-events-2026-09-12.md §5)。
 *
 * 以前事件只活在信息员的一段新闻摘要里,看完就没了;现在它是**有生命周期的实体**:
 * 窗口前出简报进证据 → 窗口内给触发器一个 event 种类 + 事件封锁闸 → 窗口后代码回填 impact →
 * 同 subkind 聚合成历史先验。**事件永远不直接下单。**
 *
 * 页面从上到下:顶栏(日历核对时间 / 封锁闸 / 简报用量 / 手动补录)→ 筛选(状态 / 资产 / 类别)
 * → 三组卡片(即将到来 · 窗口内 · 已复盘,外加一组「过窗未复盘 / 已忽略」兜底,一条都不丢)
 * → 点一条开右侧抽屉(简报历史 / 被哪些判断引用 / 原文外链 / 同类历史统计 / 不算事件)。
 *
 * 三条硬规矩:
 *   1. **路径是 `/api/market-events`**,`/api/events` 是 SSE 长连接,不能占。
 *   2. 契约里能为 null 的数(impact 四个数、EventStats 后四个)一律显示「—」,不 toFixed,
 *      samples=0 要写「样本不足」——显示 0 会被读成「平均波动 0%」。
 *   3. `title` / `source_ref` 是外部文本:只当纯文本渲染,外链一律 rel="noreferrer noopener" 并标「外部链接」。
 *
 * react-query key(约定见 src/App.tsx 顶部):
 *   ['market-events', status, asset, subkind]  GET /api/market-events
 *   ['market-events', 'detail', id]            GET /api/market-events/:id(开抽屉才拉)
 * 通过 market_event / research_task SSE 失效；重连时补拉。
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, ExternalLink, RefreshCw, ShieldBan, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, useLiveEvents } from '@/api/client';
import { AssignResearch, CalendarBand, ResearchTasks } from '@/components/research/research';
import type { EventStats, MarketEvent, MarketEventConfidence, MarketEventStatus } from '@/api/types';
import { Pane, Workspace } from '@/components/pane';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtDateTime, fmtDuration, relativeTime, useNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';

// ---------------------------------------------------------------------------
// 标签表

const STATUS_LABEL: Record<MarketEventStatus, string> = tmap({
  captured: '已抓到',
  briefed: '已出简报',
  live: '窗口内',
  resolved: '已回填',
  retro_done: '已复盘',
  dismissed: '不算事件',
});

const STATUS_CLASS: Record<MarketEventStatus, string> = {
  captured: 'bg-muted text-muted-foreground border-transparent',
  briefed: 'bg-warn/15 text-warn border-warn/30',
  live: 'bg-primary/15 text-primary border-primary/30',
  resolved: 'bg-muted text-foreground/80 border-border',
  retro_done: 'bg-up/10 text-up border-up/30',
  dismissed: 'bg-muted text-muted-foreground/70 border-transparent line-through',
};

const CONFIDENCE_LABEL: Record<MarketEventConfidence, string> = tmap({ confirmed: '已确认', reported: '有报道', rumor: '传闻' });
const CONFIDENCE_CLASS: Record<MarketEventConfidence, string> = {
  confirmed: 'bg-up/10 text-up border-up/30',
  reported: 'bg-warn/15 text-warn border-warn/30',
  rumor: 'bg-down/10 text-down border-down/30',
};

/** 分类器认得的 subkind;网关的 `subkinds` 里有没见过的就原样显示。 */
const SUBKIND_LABEL: Record<string, string> = tmap({
  fomc: 'FOMC 利率',
  cpi: 'CPI',
  nfp: '非农',
  unlock: '代币解锁',
  listing: '上币',
  delisting: '下架',
  hack: '安全事故',
  etf_flow: 'ETF 流向',
  regulation: '监管',
  upgrade: '链上升级',
  funding_extreme: '资金费率极端',
  vol_spike: '波动异常',
  unclassified: '未分类',
});

function subkindLabel(s: string): string {
  return SUBKIND_LABEL[s] ?? s;
}

const KIND_LABEL: Record<string, string> = tmap({ scheduled: '日程', news: '新闻', exchange: '交易所', onchain: '链上', derived: '派生' });

/** 契约里能为 null 的数一律「—」,不 toFixed 黑屏。 */
function num(v: number | null | undefined, digits = 2, suffix = ''): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}${suffix}`;
}

function signedPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function moveClass(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'text-muted-foreground';
  return v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-muted-foreground';
}

/** 倒计时按本地 now 现算,不用服务端那一刻的 minutes_to_start(它会过期)。 */
function countdownText(e: MarketEvent, now: number): string {
  const ms = e.starts_at - now;
  if (ms > 0) return t('还有 {d}', { d: fmtDuration(ms) });
  const left = e.ends_at - now;
  if (left > 0) return t('窗口内 · 还剩 {d}', { d: fmtDuration(left) });
  return t('{d}前结束', { d: fmtDuration(-left) });
}

function assetsText(assets: string[]): string {
  return assets.length === 0 ? t('宏观(对每个币都相关)') : assets.join(' · ');
}

// ---------------------------------------------------------------------------
// 同类历史统计

function StatsLine({ stats }: { stats: EventStats | undefined }) {
  if (!stats) return null;
  if (stats.samples === 0) {
    return (
      <span className="text-[10.5px] text-muted-foreground" title={t('只数已回填 impact 的同类事件;0 样本时后四个数都是 null,显示 0 会被读成「平均波动 0%」')}>
        {t('同类历史:样本不足')}
      </span>
    );
  }
  return (
    <span className="text-[10.5px] text-muted-foreground">
      {t('同类 {n} 次', { n: stats.samples })} · {t('平均波幅')} <span className="num">{num(stats.avg_abs_move_4h_pct, 2, '%')}</span> ·{' '}
      {t('多数方向')}{' '}
      {stats.dominant_direction ? (
        <span className={cn('num', stats.dominant_direction === 'up' ? 'text-up' : 'text-down')}>
          {stats.dominant_direction === 'up' ? t('偏涨') : t('偏跌')}
          {stats.direction_agreement !== null ? ` ${(stats.direction_agreement * 100).toFixed(0)}%` : ''}
        </span>
      ) : (
        '—'
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 一条事件

function EventRow({ e, stats, now, onOpen }: { e: MarketEvent; stats: EventStats | undefined; now: number; onOpen: () => void }) {
  const live = e.in_window && e.status !== 'dismissed';
  const impact = e.impact;
  return (
    <li
      className={cn(
        'cursor-pointer px-3 py-2 text-[12px] hover:bg-muted/40',
        live && 'border-l-2 border-l-primary bg-primary/[0.04]',
        e.status === 'dismissed' && 'opacity-60',
      )}
      onClick={onOpen}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-muted-foreground">
        <Badge variant="outline" className="h-4 px-1.5 text-[10px]" title={t('类别 {kind}', { kind: KIND_LABEL[e.kind] ?? e.kind })}>
          {subkindLabel(e.subkind)}
        </Badge>
        <Badge variant="outline" className={cn('h-4 px-1.5 text-[10px]', STATUS_CLASS[e.status])}>
          {STATUS_LABEL[e.status]}
        </Badge>
        <Badge variant="outline" className={cn('h-4 px-1.5 text-[10px]', CONFIDENCE_CLASS[e.confidence])}>
          {CONFIDENCE_LABEL[e.confidence]}
        </Badge>
        <span className={cn('num', live && 'text-primary')} title={t('开始 {a} · 结束 {b}', { a: fmtDateTime(e.starts_at), b: fmtDateTime(e.ends_at) })}>
          {countdownText(e, now)}
        </span>
        <span className="truncate" title={assetsText(e.assets)}>
          {assetsText(e.assets)}
        </span>
        <span className="ml-auto shrink-0" title={t('已完成的简报数；模型预算按 research 任务持久化计量')}>
          {t('简报')} <span className="num">{e.brief_count}</span>
        </span>
      </div>
      {/* title 是外部文本:只当纯文本渲染 */}
      <div className="mt-0.5 font-medium text-foreground">{e.title || t('（无标题)')}</div>
      {e.brief ? (
        <div className="mt-0.5 line-clamp-2 text-[11.5px] text-muted-foreground">
          <span className="kicker mr-1 text-[9.5px] text-muted-foreground/70">
            {e.brief.source === 'research' ? t('研究简报') : t('历史简报（非 research）')}
          </span>
          {e.brief.text}
        </div>
      ) : null}
      {impact ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] text-muted-foreground">
          <span className="num" title={t('基准 = 事件时刻之前最后一根收盘价;宏观事件用 BTCUSDT 代表大盘')}>
            {impact.symbol}
          </span>
          <span>
            1h <span className={cn('num', moveClass(impact.move_1h_pct))}>{signedPct(impact.move_1h_pct)}</span>
          </span>
          <span>
            4h <span className={cn('num', moveClass(impact.move_4h_pct))}>{signedPct(impact.move_4h_pct)}</span>
          </span>
          <span title={t('24h 那一档要等够 24 小时才算得出来,算不出来就停在「已回填」,下一拍再补')}>
            24h <span className={cn('num', moveClass(impact.move_24h_pct))}>{signedPct(impact.move_24h_pct)}</span>
          </span>
          <span title={t('窗口内已实现波动 / 常态波动')}>
            {t('波动比')} <span className="num">{num(impact.realized_vol_ratio, 2, '×')}</span>
          </span>
        </div>
      ) : null}
      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
        <span title={e.source_ref || undefined}>{t('来源 {s}', { s: e.source })}</span>
        {e.used_by.length ? <span>{t('被 {n} 次判断引用', { n: e.used_by.length })}</span> : null}
        <StatsLine stats={stats} />
      </div>
    </li>
  );
}

function Group({ title, hint, events, stats, now, onOpen, empty }: { title: string; hint: string; events: MarketEvent[]; stats: Record<string, EventStats>; now: number; onOpen: (id: string) => void; empty: string }) {
  return (
    <Workspace>
      <Pane title={title} hint={hint}>
        {events.length === 0 ? (
          <div className="px-3 py-5 text-center text-[11.5px] text-muted-foreground">{empty}</div>
        ) : (
          <ul className="divide-y">
            {events.map((e) => (
              <EventRow key={e.id} e={e} stats={stats[e.subkind]} now={now} onOpen={() => onOpen(e.id)} />
            ))}
          </ul>
        )}
      </Pane>
    </Workspace>
  );
}

// ---------------------------------------------------------------------------
// 详情抽屉

function ExternalRef({ href }: { href: string }) {
  const ok = /^https?:\/\//.test(href);
  if (!href) return <span className="text-muted-foreground">—</span>;
  if (!ok) return <span className="break-all text-muted-foreground">{href}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 break-all text-primary hover:underline" title={t('外部链接,内容不可信')}>
      {href}
      <ExternalLink className="size-3 shrink-0" />
    </a>
  );
}

function EventDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const now = useNow(1000);
  const q = useQuery({ queryKey: ['market-events', 'detail', id], queryFn: () => api.marketEvent(id) });
  const dismiss = useMutation({
    mutationFn: () => api.dismissMarketEvent(id),
    onSuccess: () => {
      toast.success(t('已标记「不算事件」'));
      void queryClient.invalidateQueries({ queryKey: ['market-events'] });
    },
    onError: (err) => toast.error(t('标记失败'), { description: err instanceof Error ? err.message : String(err) }),
  });

  if (q.isLoading) return <div className="space-y-2 p-1">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>;
  if (q.isError || !q.data) return <div className="p-2 text-[12px] text-destructive">{t('事件加载失败')}:{q.error instanceof Error ? q.error.message : String(q.error)}</div>;

  const e = q.data.event;
  const stats = q.data.stats;
  const terminal = e.status === 'retro_done' || e.status === 'dismissed';

  return (
    <div className="flex flex-col gap-3 text-[12px]">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="h-5 px-2 text-[10.5px]">{subkindLabel(e.subkind)}</Badge>
        <Badge variant="outline" className={cn('h-5 px-2 text-[10.5px]', STATUS_CLASS[e.status])}>{STATUS_LABEL[e.status]}</Badge>
        <Badge variant="outline" className={cn('h-5 px-2 text-[10.5px]', CONFIDENCE_CLASS[e.confidence])}>{CONFIDENCE_LABEL[e.confidence]}</Badge>
        <span className="num text-[11px] text-muted-foreground">{countdownText(e, now)}</span>
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11.5px]">
        <dt className="text-muted-foreground">{t('资产')}</dt>
        <dd>{assetsText(e.assets)}</dd>
        <dt className="text-muted-foreground">{t('窗口')}</dt>
        <dd className="num">
          {fmtDateTime(e.starts_at)} → {fmtDateTime(e.ends_at)} <span className="text-muted-foreground">({fmtDuration(e.window_ms)})</span>
        </dd>
        <dt className="text-muted-foreground">{t('类别')}</dt>
        <dd>{KIND_LABEL[e.kind] ?? e.kind} · {e.subkind}</dd>
        <dt className="text-muted-foreground">{t('抓到')}</dt>
        <dd className="num">{fmtDateTime(e.captured_at)} <span className="text-muted-foreground">({t('来源 {s}', { s: e.source })})</span></dd>
        <dt className="text-muted-foreground">{t('原文')}</dt>
        <dd><ExternalRef href={e.source_ref} /></dd>
      </dl>

      <section>
        <div className="kicker mb-1 text-[10px] text-muted-foreground">{t('简报历史')}</div>
        {e.briefs.length === 0 ? (
          <div className="rounded-sm border bg-muted/30 px-2 py-1.5 text-[11.5px] text-muted-foreground">
            {t('还没出过研究简报。scheduled 事件在 T−24h 预研、T+2m 核对发布结果；每个 research 任务最多两次模型调用。')}
          </div>
        ) : (
          <ul className="space-y-1.5">
            {e.briefs.map((b, i) => (
              <li key={`${b.at}-${i}`} className="rounded-sm border bg-card px-2 py-1.5">
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span className="kicker">{b.source === 'research' ? t('研究简报') : t('历史简报（非 research）')}</span>
                  {b.source === 'research' && b.task_id ? <a className="text-primary underline" href={`/api/research/${encodeURIComponent(b.task_id)}`} target="_blank" rel="noreferrer">{t('任务与原文')} · {b.task_id}</a> : null}
                  <span className="num" title={fmtDateTime(b.at)}>{relativeTime(b.at, now)}</span>
                </div>
                <div className="mt-0.5 text-[11.5px] leading-relaxed">{b.text}</div>
                {b.refs.length ? (
                  <ul className="mt-1 space-y-0.5 text-[10.5px]">
                    {b.refs.map((r, j) => (
                      <li key={j}>{b.source === 'research' ? <span className="font-mono">{r}</span> : <ExternalRef href={r} />}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="kicker mb-1 text-[10px] text-muted-foreground">{t('复盘回填')}</div>
        {e.impact ? (
          <div className="grid grid-cols-4 gap-2 rounded-sm border bg-card p-2 text-center">
            {([
              ['1h', e.impact.move_1h_pct],
              ['4h', e.impact.move_4h_pct],
              ['24h', e.impact.move_24h_pct],
            ] as [string, number | null][]).map(([k, v]) => (
              <div key={k}>
                <div className="text-[10px] text-muted-foreground">{k}</div>
                <div className={cn('num text-[13px] font-semibold', moveClass(v))}>{signedPct(v)}</div>
              </div>
            ))}
            <div>
              <div className="text-[10px] text-muted-foreground">{t('波动比')}</div>
              <div className="num text-[13px] font-semibold">{num(e.impact.realized_vol_ratio, 2, '×')}</div>
            </div>
          </div>
        ) : (
          <div className="rounded-sm border bg-muted/30 px-2 py-1.5 text-[11.5px] text-muted-foreground">{t('窗口结束后由代码拉 1h K 线回填,现在还没有。')}</div>
        )}
      </section>

      <section>
        <div className="kicker mb-1 text-[10px] text-muted-foreground">{t('同类历史')}</div>
        <div className="rounded-sm border bg-card px-2 py-1.5 text-[11.5px]">
          {stats.samples === 0 ? (
            <span className="text-muted-foreground">{t('样本不足(还没有一条同类事件回填过 4h 波动)。')}</span>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>{t('样本')} <span className="num">{stats.samples}</span></span>
              <span>{t('平均波幅')} <span className="num">{num(stats.avg_abs_move_4h_pct, 2, '%')}</span></span>
              <span>{t('平均涨跌')} <span className={cn('num', moveClass(stats.avg_move_4h_pct))}>{signedPct(stats.avg_move_4h_pct)}</span></span>
              <span>
                {t('多数方向')}{' '}
                {stats.dominant_direction ? (
                  <span className={cn('num', stats.dominant_direction === 'up' ? 'text-up' : 'text-down')}>{stats.dominant_direction === 'up' ? t('偏涨') : t('偏跌')}</span>
                ) : (
                  '—'
                )}{' '}
                <span className="num text-muted-foreground">{stats.direction_agreement !== null ? `${(stats.direction_agreement * 100).toFixed(0)}%` : '—'}</span>
              </span>
            </div>
          )}
        </div>
      </section>

      <section>
        <div className="kicker mb-1 text-[10px] text-muted-foreground">{t('被哪些判断用过')}</div>
        {e.used_by.length === 0 ? (
          <div className="text-[11.5px] text-muted-foreground">{t('还没有判断引用过它。')}</div>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {e.used_by.map((ep) => (
              <li key={ep}>
                <a href="#judgments" className="num inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10.5px] text-primary hover:underline" title={t('去判断记录页找 {id}', { id: ep })}>
                  {ep}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AssignResearch event={e}/>
      <div className="flex items-center gap-2 border-t pt-2">
        <Button size="sm" variant="outline" disabled={terminal || dismiss.isPending} onClick={() => dismiss.mutate()} title={terminal ? t('终态事件不能再改') : t('人工判定「这不算事件」,幂等')}>
          <X data-slot="icon" />
          {t('不算事件')}
        </Button>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
          {t('关闭')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 手动补录

const WINDOW_PRESETS_H = [2, 4, 12, 24];

function CreateForm({ subkinds, onDone }: { subkinds: string[]; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [subkind, setSubkind] = useState('unclassified');
  const [assets, setAssets] = useState('');
  const [expectedAt, setExpectedAt] = useState('');
  const [windowH, setWindowH] = useState('4');
  const [sourceRef, setSourceRef] = useState('');

  const create = useMutation({
    mutationFn: () => {
      const ms = expectedAt ? new Date(expectedAt).getTime() : null;
      const hours = Number(windowH);
      return api.createMarketEvent({
        title: title.trim(),
        subkind,
        assets: assets
          .split(/[,,\s]+/)
          .map((a) => a.trim().toUpperCase())
          .filter(Boolean),
        expected_at: ms !== null && Number.isFinite(ms) ? ms : null,
        ...(Number.isFinite(hours) && hours > 0 ? { window_ms: Math.round(hours * 3_600_000) } : {}),
        ...(sourceRef.trim() ? { source_ref: sourceRef.trim() } : {}),
      });
    },
    onSuccess: (r) => {
      if (r.created) toast.success(t('补录好了'));
      else toast.info(t('命中去重,已有同一条事件'));
      void queryClient.invalidateQueries({ queryKey: ['market-events'] });
      onDone();
    },
    onError: (err) => toast.error(t('补录失败'), { description: err instanceof Error ? err.message : String(err) }),
  });

  return (
    <div className="flex flex-col gap-2.5 text-[12px]">
      <div>
        <Label className="text-[11px] text-muted-foreground">{t('标题')}</Label>
        <Input value={title} onChange={(ev) => setTitle(ev.target.value)} placeholder={t('比如:某交易所宣布下架 XXX')} className="mt-1 h-8 text-[12px]" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-[11px] text-muted-foreground">{t('类别')}</Label>
          <Select value={subkind} onValueChange={setSubkind}>
            <SelectTrigger className="mt-1 h-8 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {subkinds.map((s) => (
                <SelectItem key={s} value={s} className="text-[12px]">
                  {subkindLabel(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-[11px] text-muted-foreground">{t('资产')}</Label>
          <Input value={assets} onChange={(ev) => setAssets(ev.target.value)} placeholder={t('BTC ETH;留空 = 宏观')} className="mt-1 h-8 text-[12px]" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-[11px] text-muted-foreground">{t('预计时间')}</Label>
          <Input type="datetime-local" value={expectedAt} onChange={(ev) => setExpectedAt(ev.target.value)} className="mt-1 h-8 text-[12px]" />
          <div className="mt-1 text-[10px] text-muted-foreground">{t('留空 = 新闻类,窗口从现在起算')}</div>
        </div>
        <div>
          <Label className="text-[11px] text-muted-foreground">{t('影响窗口')}</Label>
          <div className="mt-1 flex items-center gap-1">
            <Input value={windowH} onChange={(ev) => setWindowH(ev.target.value)} className="num h-8 w-16 text-[12px]" inputMode="decimal" />
            <span className="text-[11px] text-muted-foreground">{t('小时')}</span>
          </div>
          <div className="mt-1 flex gap-1">
            {WINDOW_PRESETS_H.map((h) => (
              <Button key={h} size="xs" variant="outline" onClick={() => setWindowH(String(h))}>
                {t('{n}h', { n: h })}
              </Button>
            ))}
          </div>
        </div>
      </div>
      <div>
        <Label className="text-[11px] text-muted-foreground">{t('原文链接')}</Label>
        <Input value={sourceRef} onChange={(ev) => setSourceRef(ev.target.value)} placeholder="https://…" className="mt-1 h-8 text-[12px]" />
      </div>
      <div className="text-[10.5px] leading-4 text-muted-foreground">
        {t('手动补录不跑关键词分类器——你填了什么就是什么;留空按「未分类」。补录的事件 source=manual、可信度=已确认,和自动抓到的走同一条生命周期。')}
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!title.trim() || create.isPending} onClick={() => create.mutate()}>
          <CalendarPlus data-slot="icon" />
          {create.isPending ? t('提交中…') : t('补录这条事件')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          {t('取消')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 页面

type StatusFilter = 'all' | MarketEventStatus;
const STATUS_FILTERS: StatusFilter[] = ['all', 'captured', 'briefed', 'live', 'resolved', 'retro_done', 'dismissed'];

export function EventsPage() {
  const now = useNow(1000);
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<StatusFilter>('all');
  const [asset, setAsset] = useState('');
  const [assetInput, setAssetInput] = useState('');
  const [subkind, setSubkind] = useState<string>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<'events'|'research'>('events');
  const [connected, setConnected] = useState(false);
  const refreshEvents = () => { void queryClient.invalidateQueries({ queryKey: ['market-events'] }); };
  const refreshResearch = () => { void queryClient.invalidateQueries({ queryKey: ['research'] }); refreshEvents(); };
  useLiveEvents({ market_event: refreshEvents, research_task: refreshResearch }, ok => {
    setConnected(ok);
    if (ok) refreshResearch();
  });

  const q = useQuery({
    queryKey: ['market-events', status, asset, subkind],
    queryFn: () =>
      api.marketEvents({
        ...(status === 'all' ? {} : { status }),
        ...(asset ? { asset } : {}),
        ...(subkind === 'all' ? {} : { subkind }),
        limit: 500,
      }),
  });

  const events = useMemo(() => q.data?.events ?? [], [q.data]);
  const groups = useMemo(() => {
    const upcoming: MarketEvent[] = [];
    const live: MarketEvent[] = [];
    const done: MarketEvent[] = [];
    const other: MarketEvent[] = [];
    for (const e of events) {
      if (e.status === 'dismissed') other.push(e);
      else if (e.status === 'resolved' || e.status === 'retro_done') done.push(e);
      else if (e.in_window) live.push(e);
      else if (e.starts_at > now) upcoming.push(e);
      else other.push(e);
    }
    upcoming.sort((a, b) => a.starts_at - b.starts_at);
    live.sort((a, b) => a.ends_at - b.ends_at);
    done.sort((a, b) => b.ends_at - a.ends_at);
    other.sort((a, b) => b.updated_at - a.updated_at);
    return { upcoming, live, done, other };
  }, [events, now]);

  const stats = q.data?.stats ?? {};
  const calendar = q.data?.calendar ?? null;
  const blackout = q.data?.event_blackout_min ?? 0;
  const calendarWarnings = (calendar as { warnings?: string[] } | null)?.warnings ?? [];
  const subkinds = q.data?.subkinds ?? [];

  const applyAsset = () => setAsset(assetInput.trim().toUpperCase());

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* 顶栏 */}
      <div className="flex shrink-0 flex-col gap-1.5 rounded-md border bg-card px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="kicker text-[10.5px] text-foreground/85">{t('事件区')}</span>
          <span className="text-[11px] text-muted-foreground">{t('事件永远不直接下单:它只进证据、给触发器一个种类、以及事件封锁闸。')}</span>
          <div className="ml-auto flex items-center gap-1">
            <a
              href="#settings"
              className={cn('inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10.5px]', blackout > 0 ? 'border-warn/40 bg-warn/10 text-warn' : 'text-muted-foreground hover:text-foreground')}
              title={t('事件封锁:事件前 N 分钟到窗口结束不开新仓,不拦平仓。在设置页 · 风险组改')}
            >
              <ShieldBan className="size-3" />
              {blackout > 0 ? t('封锁 {n} 分钟', { n: blackout }) : t('封锁关闭')}
            </a>
            <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
              <CalendarPlus data-slot="icon" />
              {t('手动补录')}
            </Button>
            <Button size="sm" variant="ghost" disabled={q.isFetching} onClick={() => void q.refetch()} title={t('刷新')}>
              <RefreshCw data-slot="icon" className={q.isFetching ? 'animate-spin' : undefined} />
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted-foreground">
          <span title={t('最近日历抓取尝试时间；确认状态见各事件')}>
            {t('日历')} <span className="num">{calendar?.entries ?? '—'}</span> {t('条')} ·{' '}
            {calendar?.last_verified_at ? t('{ago}尝试抓取', { ago: relativeTime(calendar.last_verified_at, now) }) : t('没核对过')} ·{' '}
            {t('订阅源 {n}', { n: calendar?.feeds ?? 0 })}
          </span>
          <span>{t('研究调用与预算见「研究任务」页签')}</span>
          <span className="num">{t('共 {n} 条', { n: events.length })}</span>
        </div>
      </div>

      {calendarWarnings.length>0&&<details className="shrink-0 rounded border border-amber-500/30 p-2 text-xs"><summary className="cursor-pointer">{t('日历采集告警 {n} 条（覆盖可能不完整）', { n: calendarWarnings.length })}</summary>{calendarWarnings.map((w,i)=><p key={i} className="break-all p-1">{t(w)}</p>)}</details>}
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant={tab==='events'?'default':'outline'} onClick={()=>setTab('events')}>{t('宏观日历与事件')}</Button>
        <Button size="sm" variant={tab==='research'?'default':'outline'} onClick={()=>setTab('research')}>{t('研究任务')}</Button>
        <span className="ml-auto text-xs text-muted-foreground">{connected?t('实时更新'):t('连接中断，正在重连')}</span>
      </div>
      {tab==='events'&&<CalendarBand events={events} now={now} onOpen={setOpenId}/>}
      {tab==='research'&&<div className="min-h-0 flex-1 overflow-auto"><ResearchTasks/></div>}
      {/* 筛选 */}
      <div className={cn("flex shrink-0 flex-wrap items-center gap-1.5 rounded-md border bg-card px-3 py-2", tab==='research' && 'hidden')}>
        <span className="text-[11px] text-muted-foreground">{t('状态')}</span>
        {STATUS_FILTERS.map((s) => (
          <Button key={s} size="xs" variant={status === s ? 'default' : 'outline'} className="rounded-full" onClick={() => setStatus(s)}>
            {s === 'all' ? t('全部') : STATUS_LABEL[s]}
          </Button>
        ))}
        <span className="ml-2 text-[11px] text-muted-foreground">{t('类别')}</span>
        <Select value={subkind} onValueChange={setSubkind}>
          <SelectTrigger className="h-7 w-36 text-[11.5px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-[12px]">
              {t('全部')}
            </SelectItem>
            {subkinds.map((s) => (
              <SelectItem key={s} value={s} className="text-[12px]">
                {subkindLabel(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-2 text-[11px] text-muted-foreground">{t('资产')}</span>
        <Input
          value={assetInput}
          onChange={(e) => setAssetInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyAsset();
          }}
          onBlur={applyAsset}
          placeholder="BTC"
          className="h-7 w-24 text-[11.5px]"
          spellCheck={false}
        />
        {asset ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setAsset('');
              setAssetInput('');
            }}
          >
            <X data-slot="icon" />
            {asset}
          </Button>
        ) : null}
        <span className="ml-auto text-[10.5px] text-muted-foreground">{t('按资产筛时,宏观事件(资产为空)也会返回。')}</span>
      </div>

      {/* 三组 */}
      <div className={cn("min-h-0 flex-1 overflow-y-auto", tab==='research' && 'hidden')}>
        {q.isLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : q.isError ? (
          <Workspace className="flex h-40 items-center justify-center">
            <div className="text-center text-[12px] text-muted-foreground">
              <p>{t('事件区加载失败')}:{q.error instanceof Error ? q.error.message : String(q.error)}</p>
              <Button size="sm" variant="outline" className="mt-3" onClick={() => void q.refetch()}>
                <RefreshCw data-slot="icon" />
                {t('重试')}
              </Button>
            </div>
          </Workspace>
        ) : (
          <div className="flex flex-col gap-2 pb-2">
            <Group
              title={t('窗口内')}
              hint={t('{n} 条 · 这些币的判断会多一条事件触发器', { n: groups.live.length })}
              events={groups.live}
              stats={stats}
              now={now}
              onOpen={setOpenId}
              empty={t('现在没有事件在窗口里。')}
            />
            <Group
              title={t('即将到来')}
              hint={t('{n} 条 · 按开始时间排', { n: groups.upcoming.length })}
              events={groups.upcoming}
              stats={stats}
              now={now}
              onOpen={setOpenId}
              empty={t('日历和抓取都没有排到后面的事件。')}
            />
            <Group
              title={t('已复盘')}
              hint={t('{n} 条 · impact 由代码回填,某一档算不出来就留「—」', { n: groups.done.length })}
              events={groups.done}
              stats={stats}
              now={now}
              onOpen={setOpenId}
              empty={t('还没有事件走完窗口。')}
            />
            {groups.other.length ? (
              <Group
                title={t('过窗未复盘 / 已忽略')}
                hint={t('{n} 条', { n: groups.other.length })}
                events={groups.other}
                stats={stats}
                now={now}
                onOpen={setOpenId}
                empty=""
              />
            ) : null}
          </div>
        )}
      </div>

      <Sheet open={openId !== null} onOpenChange={(v) => !v && setOpenId(null)}>
        <SheetContent side="right" className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
          <SheetHeader className="border-b">
            <SheetTitle>{t('事件详情')}</SheetTitle>
            <SheetDescription>{t('生命周期只往前走:已抓到 → 已出简报 → 窗口内 → 已回填 → 已复盘;任意非终态可标「不算事件」。')}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{openId ? <EventDetail id={openId} onClose={() => setOpenId(null)} /> : null}</div>
        </SheetContent>
      </Sheet>

      <Sheet open={creating} onOpenChange={setCreating}>
        <SheetContent side="right" className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
          <SheetHeader className="border-b">
            <SheetTitle>{t('手动补录事件')}</SheetTitle>
            <SheetDescription>{t('自动抓不到、但你知道要来的事(听证会、解锁、某交易所公告)可以补一条,补完就进同一条生命周期。')}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <CreateForm
              subkinds={subkinds.length ? subkinds : ['unclassified']}
              onDone={() => {
                setCreating(false);
                void queryClient.invalidateQueries({ queryKey: ['market-events'] });
              }}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
