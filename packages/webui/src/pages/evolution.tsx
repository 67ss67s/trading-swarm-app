/**
 * 进化页(#evolution,docs/design/evolution-floor-2026-09-23.md §六):
 *   标签「进化方格」:每个角色一行,按月排的日方格(Solana uptime 样式);颜色只看当天已结算结果
 *                    vs 该角色最近 14 天基线;点格子右侧抽屉看当天指标 / 记录 / 进化事件。
 *   标签「记忆」:直接渲染原记忆页(pages/memory.tsx);#memory 由 App.tsx 映射到这里的记忆标签。
 *
 * 路由:#evolution[?role=<role>][&date=YYYY-MM-DD][&tab=memory]  —— role 定位并高亮那一行,date 直接开抽屉。
 * 接口没上线时显示「进化数据接口未就绪」,九行照画、方格全灰(灰格本身就是「还没反馈回路」的信号)。
 * react-query key 见 api/evolution.ts:['evolution','daily',from,to] / ['evolution','day',role,date]。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Sprout } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useEvolutionDaily, useEvolutionDay, type EvoDay, type EvoMetric, type EvoRoleRow, type EvoStatus } from '@/api/evolution';
import { DayGrid, DayGridLegend, EVO_STATUS_LABEL } from '@/components/evolution/day-grid';
import { addDays, countStatuses, fillDays, parseEvolutionHash, statusColor, todayUtc } from '@/components/evolution/grid-logic';
import { evoRows } from '@/components/evolution/roles';
import { ROLE_META, fallbackRoleMeta } from '@/components/floor/roles';
import type { BotRole } from '@/components/floor/types';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { fmtDateTime } from '@/lib/format';
import { t, tmap } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { MemoryPage } from '@/pages/memory';

const EVENT_KIND_LABEL: Record<string, string> = tmap({
  memory_proposed: '记忆提案',
  memory_activated: '记忆激活',
  strategy_promoted: '策略晋升',
  improve_candidate: '改进环候选',
  prompt_version: 'prompt 版本',
  param_probe: '参数探针',
});

function roleMeta(role: string) {
  return ROLE_META[role as BotRole] ?? fallbackRoleMeta(role, 0);
}

/** 只改地址栏,不触发 hashchange(抽屉开关、切标签不该让 App 重算页面) */
function replaceHash(params: { tab?: 'grid' | 'memory'; role?: string | null; date?: string | null }) {
  const sp = new URLSearchParams();
  if (params.tab === 'memory') sp.set('tab', 'memory');
  if (params.role) sp.set('role', params.role);
  if (params.date) sp.set('date', params.date);
  const q = sp.toString();
  try {
    window.history.replaceState(null, '', `#evolution${q ? `?${q}` : ''}`);
  } catch {
    /* 沙箱里没有 history */
  }
}

export function EvolutionPage() {
  const [route, setRoute] = useState(() => parseEvolutionHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseEvolutionHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const tab = route.tab;
  // 09-25 ③-13:记忆提案要人批,标签上显示待批数(和顶栏「需要你点」同一个 query key,共用缓存)
  const memQ = useQuery({ queryKey: ['memory', 'list', 'proposed'], queryFn: () => api.memoryList('proposed', undefined, 50), refetchInterval: 120_000, retry: false });
  const memPending = memQ.data?.counts?.proposed ?? memQ.data?.items?.length ?? 0;
  return (
    <Tabs
      value={tab}
      onValueChange={(v) => {
        const next = v === 'memory' ? 'memory' : 'grid';
        setRoute((r) => ({ ...r, tab: next }));
        replaceHash({ tab: next, role: next === 'grid' ? route.role : null });
      }}
      className="flex h-full min-h-0 flex-col gap-3"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        <TabsList>
          <TabsTrigger value="grid">{t('进化方格')}</TabsTrigger>
          <TabsTrigger value="memory">
            {t('记忆')}
            {memPending > 0 ? (
              <span className="ml-1 rounded-sm bg-warn/20 px-1 text-[10px] text-warn" title={t('{n} 条记忆提案待批', { n: memPending })} data-testid="memory-pending-count">
                {memPending}
              </span>
            ) : null}
          </TabsTrigger>
        </TabsList>
        <p className="min-w-0 flex-1 text-[11px] text-muted-foreground">
          {tab === 'grid' ? t('每个角色走同一个循环:记录 → 结算 → 提炼 → 验证 → 采纳 / 回滚。格子颜色只看当天已结算结果对比该角色最近 14 天基线;提炼、验证、采纳这些进化事件只在明细里列出。') : t('记忆是复盘提炼出来的教训:提案 → 人工批准 → 判断时召回。')}
        </p>
      </div>
      <TabsContent value="grid" className="min-h-0 flex-1 overflow-y-auto">
        <EvolutionGrid focusRole={route.role} initialDate={route.date} />
      </TabsContent>
      <TabsContent value="memory" className="min-h-0 flex-1">
        {tab === 'memory' ? <MemoryPage /> : null}
      </TabsContent>
    </Tabs>
  );
}

function EvolutionGrid({ focusRole, initialDate }: { focusRole: string | null; initialDate: string | null }) {
  const dailyQ = useEvolutionDaily();
  const data = dailyQ.data;
  const unavailable = dailyQ.isError;
  const to = data?.to || todayUtc();
  const from = data?.from || addDays(to, -89);
  const rows = useMemo(() => evoRows(data?.roles), [data]);
  const [sel, setSel] = useState<{ role: string; date: string } | null>(() => (focusRole && initialDate ? { role: focusRole, date: initialDate } : null));
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    if (!focusRole) return;
    const el = rowRefs.current[focusRole];
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusRole, dailyQ.isFetched]);
  useEffect(() => {
    if (focusRole && initialDate) setSel({ role: focusRole, date: initialDate });
  }, [focusRole, initialDate]);

  const open = (role: string, day: EvoDay) => {
    setSel({ role, date: day.date });
    replaceHash({ role, date: day.date });
  };

  return (
    <div className="flex flex-col gap-3 pb-4">
      {unavailable ? (
        <div className="rounded-md border border-warn/60 bg-warn/10 px-3 py-2 text-[12px]">
          <span className="font-medium text-warn">{t('进化数据接口未就绪')}</span>
          <span className="ml-2 text-muted-foreground">{t('GET /api/evolution/daily 还没上线({msg}),下面九行先按角色画出来,方格全灰。', { msg: dailyQ.error instanceof Error ? dailyQ.error.message : String(dailyQ.error) })}</span>
        </div>
      ) : null}

      {/* 顶部:图例 + 各角色 90 天计数 */}
      <section className="rounded-md border bg-card px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="kicker text-[10.5px] text-foreground/85">{t('图例')}</span>
          <DayGridLegend />
          <span className="ml-auto text-[11px] text-muted-foreground">
            {t('{from} → {to} · UTC 日', { from, to })}
            {data?.version ? ` · ${data.version}` : ''}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-1.5">
          {rows.map((r) => {
            const m = roleMeta(r.role);
            const c = data ? r.summary : countStatuses(fillDays(r.days, from, to));
            return (
              <a key={r.role} href={`#evolution?role=${r.role}`} className="flex items-center gap-2 rounded border px-2 py-1 text-[11px] hover:bg-muted/60" style={{ borderLeft: `3px solid ${m.color}` }}>
                <span className="num font-semibold" style={{ color: m.color }}>{m.callsign}</span>
                <span className="truncate text-muted-foreground">{t(r.label)}</span>
                <span className="num ml-auto flex gap-1.5">
                  {(['good', 'ok', 'bad', 'none'] as const).map((s) => (
                    <span key={s} title={EVO_STATUS_LABEL[s]} style={{ color: s === 'none' ? undefined : statusColor(s) }} className={cn(s === 'none' && 'text-muted-foreground')}>
                      {c[s]}
                    </span>
                  ))}
                </span>
              </a>
            );
          })}
        </div>
      </section>

      {/* 主体:每个角色一行 */}
      <section className="overflow-hidden rounded-md border bg-card">
        {dailyQ.isLoading ? (
          <div className="flex flex-col gap-2 p-3">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : (
          rows.map((r) => (
            <RoleRow
              key={r.role}
              row={r}
              from={from}
              to={to}
              focused={focusRole === r.role}
              selectedDate={sel?.role === r.role ? sel.date : null}
              onSelect={(d) => open(r.role, d)}
              refCb={(el) => {
                rowRefs.current[r.role] = el;
              }}
            />
          ))
        )}
      </section>

      <DayDrawer
        sel={sel}
        onClose={() => {
          setSel(null);
          replaceHash({ role: focusRole });
        }}
      />
    </div>
  );
}

function RoleRow({ row, from, to, focused, selectedDate, onSelect, refCb }: { row: EvoRoleRow; from: string; to: string; focused: boolean; selectedDate: string | null; onSelect: (d: EvoDay) => void; refCb: (el: HTMLDivElement | null) => void }) {
  const m = roleMeta(row.role);
  const s = row.summary;
  return (
    <div ref={refCb} data-role={row.role} className={cn('flex flex-wrap items-start gap-x-5 gap-y-2 border-b px-3 py-3 last:border-b-0', focused && 'bg-muted/50')} style={{ boxShadow: `inset 3px 0 0 ${m.color}` }}>
      <div className="w-[220px] shrink-0 pl-1">
        <div className="flex items-baseline gap-2">
          <span className="num text-[13px] font-bold tracking-wider" style={{ color: m.color }}>
            {m.callsign}
          </span>
          <span className="text-[13px] font-medium">{t(row.label)}</span>
        </div>
        <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{row.metric_label ? t(row.metric_label) : t('指标口径待后端')}</div>
        <div className="num mt-1 flex flex-wrap gap-x-2 text-[10.5px] text-muted-foreground">
          <span style={{ color: statusColor('good') }}>{t('好 {n}', { n: s.good })}</span>
          <span style={{ color: statusColor('ok') }}>{t('平 {n}', { n: s.ok })}</span>
          <span style={{ color: statusColor('bad') }}>{t('差 {n}', { n: s.bad })}</span>
          <span>{t('基线 {n} 天', { n: s.baseline_days })}</span>
        </div>
      </div>
      <DayGrid days={row.days} from={from} to={to} mode="month" cell={12} gap={3} selectedDate={selectedDate} onSelect={onSelect} label={t('{who} 每日结算方格', { who: m.callsign })} className="min-w-0 flex-1" />
    </div>
  );
}

function fmtScore(v: number | null): string {
  return v == null ? '—' : `${v > 0 ? '+' : ''}${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)}`;
}

function fmtMetric(m: EvoMetric): string {
  if (m.value == null) return '—';
  if (typeof m.value === 'string') return m.unit ? `${m.value} ${m.unit}` : m.value;
  const v = m.value;
  if (m.unit === 'ratio' || m.unit === 'share') return `${(v * 100).toFixed(1)}%`;
  if (m.unit === 'R') return `${v > 0 ? '+' : ''}${v.toFixed(2)}R`;
  const s = Number.isInteger(v) ? String(v) : Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3);
  return m.unit ? `${s} ${m.unit}` : s;
}

function jump(ref: string | null) {
  if (!ref) return;
  window.location.hash = ref.replace(/^#/, '');
}

function StatusPill({ status }: { status: EvoStatus }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]">
      <span className="inline-block size-2 rounded-sm" style={{ background: statusColor(status) }} />
      {EVO_STATUS_LABEL[status]}
    </span>
  );
}

function DayDrawer({ sel, onClose }: { sel: { role: string; date: string } | null; onClose: () => void }) {
  const q = useEvolutionDay(sel?.role ?? null, sel?.date ?? null);
  const d = q.data;
  const m = sel ? roleMeta(sel.role) : null;
  return (
    <Sheet open={sel !== null} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            <Sprout className="size-4" style={{ color: m?.color }} />
            <span className="num" style={{ color: m?.color }}>{m?.callsign}</span>
            <span className="num text-muted-foreground">{sel?.date}</span>
          </SheetTitle>
          <SheetDescription>{t('当天结算结果 vs 该角色最近 14 天基线;进化事件不影响颜色。')}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[12px]">
          {q.isLoading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : q.isError ? (
            <div className="rounded border border-warn/60 bg-warn/10 px-2 py-1.5 text-[12px]">
              <span className="font-medium text-warn">{t('进化数据接口未就绪')}</span>
              <div className="text-muted-foreground">{q.error instanceof Error ? q.error.message : String(q.error)}</div>
            </div>
          ) : d ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={d.status} />
                <span className="num text-muted-foreground">
                  {t('分数')} <span className="text-foreground">{fmtScore(d.score)}</span>
                </span>
              </div>
              <section>
                <h3 className="kicker mb-1 text-[10.5px] text-foreground/85">{t('基线')}</h3>
                <div className="text-muted-foreground">
                  {d.baseline ? t('{n} 天 · 均值 {mean}', { n: d.baseline.days, mean: fmtScore(d.baseline.mean) }) : t('没有基线')}
                  {d.baseline?.note ? <div className="mt-0.5 text-warn">{d.baseline.note}</div> : null}
                </div>
              </section>
              <section>
                <h3 className="kicker mb-1 text-[10.5px] text-foreground/85">{t('指标')}</h3>
                {d.metrics.length ? (
                  <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
                    {d.metrics.map((x) => (
                      <div key={x.key} className="contents">
                        <dt className="text-muted-foreground">{x.label}</dt>
                        <dd className="num text-right">{fmtMetric(x)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <div className="text-muted-foreground">{t('当天没有指标')}</div>
                )}
              </section>
              <section>
                <h3 className="kicker mb-1 text-[10.5px] text-foreground/85">
                  {t('进化事件')} <span className="text-muted-foreground">{d.events.length}</span>
                </h3>
                {d.events.length ? (
                  <ul className="flex flex-col gap-1">
                    {d.events.map((e, i) => (
                      <li key={`${e.at}-${i}`} className="rounded border px-2 py-1">
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <span className="rounded bg-muted px-1 text-foreground/85">{EVENT_KIND_LABEL[e.kind] ?? e.kind}</span>
                          <span className="num">{fmtDateTime(e.at)}</span>
                        </div>
                        <RefTitle title={e.title} refHash={e.ref} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-muted-foreground">{t('当天没有提炼 / 验证 / 采纳事件')}</div>
                )}
              </section>
              <section>
                <h3 className="kicker mb-1 text-[10.5px] text-foreground/85">
                  {t('记录')} <span className="text-muted-foreground">{d.records.length}</span>
                  {d.records.length >= 50 ? <span className="ml-1 text-muted-foreground">{t('(只显示最近 50 条)')}</span> : null}
                </h3>
                {d.records.length ? (
                  <ul className="flex flex-col divide-y">
                    {d.records.map((r, i) => (
                      <li key={`${r.at}-${i}`} className="flex items-baseline gap-2 py-1">
                        <span className="num shrink-0 text-[11px] text-muted-foreground">{new Date(r.at).toISOString().slice(11, 16)}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">{r.kind}</span>
                        <RefTitle title={r.title} refHash={r.ref} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-muted-foreground">{t('当天没有记录')}</div>
                )}
              </section>
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function RefTitle({ title, refHash }: { title: string; refHash: string | null }) {
  if (!refHash) return <span className="min-w-0 break-words">{title}</span>;
  return (
    <button type="button" className="min-w-0 break-words text-left text-primary hover:underline" onClick={() => jump(refHash)} title={refHash}>
      {title}
    </button>
  );
}
