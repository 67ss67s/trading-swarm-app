/**
 * 策略回放 tab:K 线 + 逐笔计划回放(仿 8794 策略回放)。
 * 数据:GET /api/research/backtests/:id/replay?asset=&from_ms=&to_ms=(candles ≤ 5000,truncated 标截断)。
 * 截断时点选窗口外的计划,会按计划前后各 ~200 根重新拉一段。
 * plans 缺失(旧报告 / IR 没有 order 块)时只画 trades 的入场出场点。
 * 「SMC」开关:另拉一次 replay?overlay=smc,把订单块 / FVG / BOS·CHoCH / 溢价折价区 / 前日周高低叠到图上(smc-layer.ts)。
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, CircleAlert, RotateCcw } from 'lucide-react';
import type { BacktestPlan, BacktestReplay, BacktestReport, BacktestTrade, SmcOverlay } from '@trading-swarm/contracts';
import { researchApi } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtPrice } from '@/lib/format';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { EmptyNote } from './performance';
import { exitReasonLabel, pctSigned, ratio, segmentLabel, toneOf, ymd, ymdhm } from './format';
import { LEVEL_SOURCE_LABEL, PLAN_BLOCKED_LABEL, PLAN_EVENT_LABEL, PLAN_EXIT_LABEL, PLAN_STATUS_LABEL, assetPlans, eventDot, exitBadge } from './plans';
import { planEndAt } from './replay-model';
import { ReplayChart } from './replay-chart';
import { SMC_COLORS, SMC_LAYER_KEYS, type SmcLayerKey } from './smc-layer';

export type ReplayLoader = (assetKey: string, from_ms?: number, to_ms?: number) => Promise<BacktestReplay>;

const LIST_PAGE = 50;

/** SMC 图层:同一个 replay 接口带 overlay=smc(不经 api/client.ts,那边是信号市场的在改文件) */
export type SmcLoader = (reportId: string, assetKey: string, from_ms?: number, to_ms?: number) => Promise<SmcOverlay | null>;
const fetchSmc: SmcLoader = async (reportId, assetKey, from_ms, to_ms) => {
  const sp = new URLSearchParams({ asset: assetKey, overlay: 'smc' });
  if (from_ms !== undefined) sp.set('from_ms', String(from_ms));
  if (to_ms !== undefined) sp.set('to_ms', String(to_ms));
  const res = await fetch(`/api/research/backtests/${encodeURIComponent(reportId)}/replay?${sp.toString()}`);
  const body = (await res.json().catch(() => null)) as (BacktestReplay & { smc_overlay?: SmcOverlay; error?: { message?: string } }) | null;
  if (!res.ok) throw new Error(body?.error?.message ?? res.statusText);
  return body?.smc_overlay ?? null;
};
const SMC_LAYER_LABEL: Record<SmcLayerKey, string> = { structure: '结构 BOS/CHoCH', blocks: '订单块', fvg: 'FVG', zones: '溢价/折价区', levels: '前日/周高低' };

function tfMs(tf: string): number {
  const n = Number(tf.slice(0, -1));
  const u = tf.slice(-1);
  const unit = u === 'm' ? 60_000 : u === 'h' ? 3_600_000 : u === 'w' ? 7 * 86_400_000 : 86_400_000;
  return (Number.isFinite(n) && n > 0 ? n : 1) * unit;
}

const rText = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R`);

type Filter = 'all' | 'filled' | 'unfilled';

export function ReplayTab({ report, assetKey, onAssetChange, loader, smcLoader, defaultSmc = false, focus = null }: { report: BacktestReport; assetKey: string; onAssetChange: (k: string) => void; loader?: ReplayLoader; smcLoader?: SmcLoader; defaultSmc?: boolean; /** 概览里选的看区间:K 线按这段拉取 */ focus?: { from_ms: number; to_ms: number } | null }) {
  const asset = report.assets.find((a) => a.key === assetKey);
  const [range, setRange] = useState<{ from: number; to: number } | null>(() => (focus ? { from: Math.round(focus.from_ms), to: Math.round(focus.to_ms) } : null));
  const focusKey = focus ? `${Math.round(focus.from_ms)}:${Math.round(focus.to_ms)}` : '';
  useEffect(() => {
    setRange(focus ? { from: Math.round(focus.from_ms), to: Math.round(focus.to_ms) } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(0);
  const load: ReplayLoader = loader ?? ((k, from, to) => researchApi.backtestReplay(report.id, k, from, to));
  const completed = asset?.status === 'completed';
  const q = useQuery({
    queryKey: ['research', 'backtest', report.id, 'replay', assetKey, range?.from ?? null, range?.to ?? null],
    queryFn: () => load(assetKey, range?.from, range?.to),
    enabled: completed,
    staleTime: 5 * 60_000,
  });
  const replay = q.data;
  const [smcOn, setSmcOn] = useState(defaultSmc);
  const [smcLayers, setSmcLayers] = useState<Set<SmcLayerKey>>(() => new Set(SMC_LAYER_KEYS));
  const smcQ = useQuery({
    queryKey: ['research', 'backtest', report.id, 'replay-smc', assetKey, range?.from ?? null, range?.to ?? null],
    queryFn: () => (smcLoader ?? fetchSmc)(report.id, assetKey, range?.from, range?.to),
    enabled: completed && smcOn,
    staleTime: 5 * 60_000,
  });
  // 回放接口没带 plans 时用报告资产里的 plans;都没有就退回成交点
  const plans: BacktestPlan[] = useMemo(() => {
    if (replay?.plans.length) return replay.plans;
    const own = assetPlans(asset);
    return own ? own.filter((p) => !replay || p.symbol === replay.symbol) : [];
  }, [replay, asset]);
  const tradesOnly = plans.length === 0;
  // 被拦计划从没挂出(放置前就因盈亏比/止损方向被拒),图上不画,免得它们的价位把坐标轴拉歪;选中时单独画出来看
  const chartPlans = useMemo(() => plans.filter((p) => p.status !== 'blocked' || p.id === selected), [plans, selected]);
  const trades: BacktestTrade[] = useMemo(() => (asset?.trades ?? []).filter((x) => !replay || x.symbol === replay.symbol || asset?.kind === 'single'), [asset, replay]);
  const listed = useMemo(() => {
    const src = [...plans].sort((a, b) => b.placed_at - a.placed_at);
    if (filter === 'filled') return src.filter((p) => p.filled_at !== null);
    if (filter === 'unfilled') return src.filter((p) => p.filled_at === null);
    return src;
  }, [plans, filter]);
  const pages = Math.max(1, Math.ceil((tradesOnly ? trades.length : listed.length) / LIST_PAGE));
  const cur = Math.min(page, pages - 1);
  const selPlan = plans.find((p) => p.id === selected) ?? null;
  const selTrade = tradesOnly ? trades.find((x) => x.id === selected) ?? null : null;

  const select = (id: string) => {
    setSelected(id);
    if (!replay || !replay.candles.length) return;
    const p = plans.find((x) => x.id === id);
    const tr = trades.find((x) => x.id === id);
    const start = p?.placed_at ?? tr?.entry_at;
    const end = p ? planEndAt(p) : tr?.exit_at;
    if (start === undefined || end === undefined) return;
    const first = replay.candles[0]!.t;
    const last = replay.candles[replay.candles.length - 1]!.t;
    if (replay.truncated && (start < first || end > last)) {
      const pad = tfMs(replay.timeframe || report.timeframe) * 200;
      setRange({ from: Math.max(report.window.from_ms, start - pad), to: Math.min(report.window.to_ms, end + pad) });
    }
  };

  return (
    <div className="space-y-3" data-testid="replay-tab">
      <div className="flex flex-wrap items-center gap-1.5">
        {report.assets.map((a) => (
          <button
            key={a.key}
            type="button"
            onClick={() => {
              setSelected(null);
              setRange(null);
              setPage(0);
              onAssetChange(a.key);
            }}
            className={cn('rounded-md border px-2 py-0.5 text-[12px]', a.key === assetKey ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground')}
          >
            {a.label}
          </button>
        ))}
        {replay ? (
          <span className="ml-auto flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
            <span className="num">
              {replay.symbol} · {replay.timeframe} · {ymd(replay.from_ms)} → {ymd(replay.to_ms)} · {t('{n} 根', { n: replay.candles.length })}
            </span>
            {replay.truncated ? <span className="rounded-sm bg-warn/15 px-1.5 text-warn">{t('已截断')}</span> : null}
            <button
              type="button"
              onClick={() => setSmcOn((v) => !v)}
              aria-pressed={smcOn}
              title={t('Smart Money Concepts 图层:订单块、FVG、BOS/CHoCH、溢价/折价区')}
              data-testid="smc-toggle"
              className={cn('rounded-md border px-2 py-0.5 text-[11.5px] font-medium', smcOn ? 'border-primary/50 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground')}
            >
              SMC
            </button>
            {range ? (
              <Button variant="ghost" size="xs" onClick={() => setRange(null)}>
                <RotateCcw />
                {t('回到全窗口')}
              </Button>
            ) : null}
          </span>
        ) : null}
      </div>
      {!asset || !completed ? (
        <EmptyNote>{asset?.error ?? t('没有可展示的资产')}</EmptyNote>
      ) : q.isLoading ? (
        <Skeleton className="h-[420px] w-full" />
      ) : q.isError || !replay ? (
        <EmptyNote>
          <CircleAlert className="mr-1 inline size-3.5 align-[-2px]" />
          {t('回放数据加载失败:{e}', { e: q.error instanceof Error ? q.error.message : t('未知错误') })}
        </EmptyNote>
      ) : replay.candles.length === 0 ? (
        <EmptyNote>{t('这段窗口没有 K 线数据')}</EmptyNote>
      ) : (
        <>
          {smcOn ? <SmcBar layers={smcLayers} onToggle={(k) => setSmcLayers((cur) => { const n = new Set(cur); if (n.has(k)) n.delete(k); else n.add(k); return n; })} overlay={smcQ.data ?? null} loading={smcQ.isLoading} error={smcQ.isError ? (smcQ.error instanceof Error ? smcQ.error.message : t('未知错误')) : null} /> : null}
          {tradesOnly ? <p className="text-[11.5px] text-muted-foreground">{t('这份报告没有逐笔计划(旧报告或策略没有下单块),图上只标成交的入场与出场。')}</p> : <ReplayLegend />}
          <div className="grid gap-3 @3xl:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="h-[420px] min-w-0 rounded-md border border-border/60">
              <ReplayChart candles={replay.candles} plans={chartPlans} trades={trades} symbol={replay.symbol} selectedId={selected} onSelect={select} smc={smcOn ? smcQ.data ?? null : null} smcLayers={smcLayers} />
            </div>
            <aside className="min-w-0 rounded-md border border-border/60 bg-card/60 @3xl:max-h-[420px] @3xl:overflow-y-auto" data-testid="replay-detail">
              {selPlan ? <PlanDetail plan={selPlan} plans={plans} onSelect={select} /> : selTrade ? <TradeDetail trade={selTrade} /> : <p className="p-3 text-[12px] text-muted-foreground">{t('在下方列表或图上点一个计划,看它的事件时间线和盈亏拆解。')}</p>}
            </aside>
          </div>
          {tradesOnly ? (
            <TradeList trades={trades} page={cur} selected={selected} onSelect={select} />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                {(['all', 'filled', 'unfilled'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => {
                      setFilter(f);
                      setPage(0);
                    }}
                    className={cn('rounded-md px-2 py-0.5', filter === f ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}
                  >
                    {f === 'all' ? t('全部计划') : f === 'filled' ? t('已成交') : t('未成交 / 被替换')}
                  </button>
                ))}
                <span className="ml-auto text-muted-foreground">{t('共 {n} 个计划', { n: listed.length })}</span>
              </div>
              <PlanList plans={listed.slice(cur * LIST_PAGE, cur * LIST_PAGE + LIST_PAGE)} selected={selected} onSelect={select} />
            </>
          )}
          {pages > 1 ? (
            <div className="flex items-center justify-end gap-2 text-[12px] text-muted-foreground">
              <Button variant="ghost" size="icon-sm" disabled={cur === 0} onClick={() => setPage(cur - 1)} aria-label={t('上一页')}>
                <ChevronLeft />
              </Button>
              <span className="num">
                {cur + 1} / {pages}
              </span>
              <Button variant="ghost" size="icon-sm" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} aria-label={t('下一页')}>
                <ChevronRight />
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** SMC 图层的分层开关 + 图例 + 当前趋势 */
function SmcBar({ layers, onToggle, overlay, loading, error }: { layers: Set<SmcLayerKey>; onToggle: (k: SmcLayerKey) => void; overlay: SmcOverlay | null; loading: boolean; error: string | null }) {
  const sw = (c: string, a = 0.35) => <i className="inline-block h-2.5 w-3.5 rounded-[2px]" style={{ background: c, opacity: a + 0.3 }} />;
  const swatch: Record<SmcLayerKey, React.ReactNode> = {
    structure: <i className="inline-block w-4 border-t-2" style={{ borderColor: SMC_COLORS.bull }} />,
    blocks: sw(SMC_COLORS.obBull),
    fvg: sw(SMC_COLORS.fvgBull),
    zones: sw(SMC_COLORS.premium, 0.1),
    levels: <i className="inline-block w-4 border-t border-dashed" style={{ borderColor: SMC_COLORS.htf }} />,
  };
  const trend = (x: 'bullish' | 'bearish' | null) => (x === 'bullish' ? <span className="text-up">{t('看涨')}</span> : x === 'bearish' ? <span className="text-down">{t('看跌')}</span> : '—');
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="smc-bar">
      {SMC_LAYER_KEYS.map((k) => (
        <button key={k} type="button" aria-pressed={layers.has(k)} onClick={() => onToggle(k)} className={cn('inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5', layers.has(k) ? 'border-border bg-muted/40 text-foreground' : 'border-transparent text-muted-foreground/60 line-through')}>
          {swatch[k]}
          {t(SMC_LAYER_LABEL[k])}
        </button>
      ))}
      <span className="ml-auto text-muted-foreground">
        {loading ? t('SMC 图层加载中…') : error ? <span className="text-warn">{t('SMC 图层加载失败:{e}', { e: error })}</span> : overlay ? (
          <span className="num">
            {t('内部结构')} {trend(overlay.trend.internal)} · {t('摆动结构')} {trend(overlay.trend.swing)} · {t('{a} 个订单块 · {b} 个 FVG · {c} 次突破', { a: overlay.order_blocks.length, b: overlay.fvgs.length, c: overlay.structures.length })}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function ReplayLegend() {
  const item = (el: React.ReactNode, label: string) => (
    <span className="inline-flex items-center gap-1.5">
      {el}
      {label}
    </span>
  );
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {item(<i className="inline-block w-4 border-t border-dashed border-[#97a3b4]" />, t('限价挂单(未成交)'))}
      {item(<i className="inline-block h-0.5 w-4 bg-[#3f9ac2]" />, t('多单持仓'))}
      {item(<i className="inline-block h-0.5 w-4 bg-[#a468e0]" />, t('空单持仓'))}
      {item(<i className="inline-block h-0.5 w-4 bg-[#c94b3e]" />, t('止损(阶梯 = 移动)'))}
      {item(<i className="inline-block w-4 border-t-2 border-dotted border-[#2aa76e]" />, t('止盈(每档一条)'))}
    </div>
  );
}

function PlanList({ plans, selected, onSelect }: { plans: BacktestPlan[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border/70">
      <table className="w-full min-w-[760px] text-[12px]" data-testid="plan-list">
        <thead>
          <tr className="border-b border-border/70 bg-muted/30 text-left text-[11px] text-muted-foreground">
            <th className="px-2 py-1.5 font-medium">{t('计划')}</th>
            <th className="px-2 py-1.5 font-medium">{t('挂出时间')}</th>
            <th className="px-2 py-1.5 font-medium">{t('入场')}</th>
            <th className="px-2 py-1.5 font-medium">{t('状态')}</th>
            <th className="px-2 py-1.5 font-medium">{t('结局')}</th>
            <th className="px-2 py-1.5 text-right font-medium">{t('计划盈亏比')}</th>
            <th className="px-2 py-1.5 text-right font-medium">{t('实际 R')}</th>
            <th className="px-2 py-1.5 text-right font-medium">{t('收益率')}</th>
            <th className="px-2 py-1.5 font-medium">{t('分段')}</th>
          </tr>
        </thead>
        <tbody>
          {plans.map((p) => (
            <tr key={p.id} onClick={() => onSelect(p.id)} className={cn('cursor-pointer border-b border-border/40 last:border-0 hover:bg-muted/25', selected === p.id && 'bg-primary/8')} aria-selected={selected === p.id}>
              <td className="px-2 py-1 whitespace-nowrap">
                <span className={p.side === 'long' ? 'text-[#3f9ac2]' : 'text-[#a468e0]'}>{p.side === 'long' ? t('多') : t('空')}</span> <span className="num text-muted-foreground">{p.id}</span>
              </td>
              <td className="num px-2 py-1 whitespace-nowrap text-muted-foreground">{ymdhm(p.placed_at)}</td>
              <td className="num px-2 py-1 whitespace-nowrap">
                {p.entry_type === 'limit' ? t('限价') : t('市价')} {fmtPrice(p.entry_price ?? p.reference_price)}
              </td>
              <td className="px-2 py-1 whitespace-nowrap">{PLAN_STATUS_LABEL[p.status] ?? p.status}</td>
              <td className="px-2 py-1 whitespace-nowrap">{p.exit ? <span className={cn('rounded-sm border px-1 text-[10.5px]', exitBadge(p.exit.reason))}>{PLAN_EXIT_LABEL[p.exit.reason] ?? p.exit.reason}</span> : p.blocked_reason ? <span className="text-[10.5px] text-muted-foreground">{PLAN_BLOCKED_LABEL[p.blocked_reason] ?? p.blocked_reason}</span> : '—'}</td>
              <td className="num px-2 py-1 text-right">{ratio(p.planned_rr)}</td>
              <td className={cn('num px-2 py-1 text-right', toneOf(p.r_multiple))}>{rText(p.r_multiple)}</td>
              <td className={cn('num px-2 py-1 text-right', toneOf(p.pnl_pct))}>{pctSigned(p.pnl_pct)}</td>
              <td className={cn('px-2 py-1 whitespace-nowrap', p.segment === 'out_of_sample' ? 'text-primary' : 'text-muted-foreground')}>{segmentLabel(p.segment)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TradeList({ trades, page, selected, onSelect }: { trades: BacktestTrade[]; page: number; selected: string | null; onSelect: (id: string) => void }) {
  const rows = [...trades].sort((a, b) => b.entry_at - a.entry_at).slice(page * LIST_PAGE, page * LIST_PAGE + LIST_PAGE);
  if (!rows.length) return <EmptyNote>{t('无成交')}</EmptyNote>;
  return (
    <div className="overflow-x-auto rounded-md border border-border/70">
      <table className="w-full min-w-[620px] text-[12px]">
        <tbody>
          {rows.map((tr) => (
            <tr key={tr.id} onClick={() => onSelect(tr.id)} className={cn('cursor-pointer border-b border-border/40 last:border-0 hover:bg-muted/25', selected === tr.id && 'bg-primary/8')}>
              <td className="num px-2 py-1 text-muted-foreground">{tr.id}</td>
              <td className="num px-2 py-1">{ymdhm(tr.entry_at)}</td>
              <td className="num px-2 py-1">{ymdhm(tr.exit_at)}</td>
              <td className="px-2 py-1">{exitReasonLabel(tr.exit_reason)}</td>
              <td className={cn('num px-2 py-1 text-right', toneOf(tr.return_pct))}>{pctSigned(tr.return_pct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KV({ k, v, tone, title }: { k: string; v: string; tone?: string; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <div className="truncate text-[10px] text-muted-foreground">{k}</div>
      <div className={cn('num truncate text-[12px] font-medium', tone)}>{v}</div>
    </div>
  );
}

export function PlanDetail({ plan: p, plans, onSelect }: { plan: BacktestPlan; plans: BacktestPlan[]; onSelect: (id: string) => void }) {
  const link = (id: string | null, label: string) =>
    id && plans.some((x) => x.id === id) ? (
      <button type="button" className="text-primary underline-offset-2 hover:underline" onClick={() => onSelect(id)}>
        {label} {id}
      </button>
    ) : id ? (
      <span>
        {label} {id}
      </span>
    ) : null;
  return (
    <div className="space-y-2.5 p-3 text-[12px]" data-testid="plan-detail">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={cn('rounded-sm px-1.5 text-[11px] font-medium', p.side === 'long' ? 'bg-[#3f9ac2]/15 text-[#3f9ac2]' : 'bg-[#a468e0]/15 text-[#a468e0]')}>{p.side === 'long' ? t('做多') : t('做空')}</span>
        <span className="num text-muted-foreground">{p.id}</span>
        <span className="rounded-sm border border-border px-1 text-[10.5px] text-muted-foreground">{PLAN_STATUS_LABEL[p.status] ?? p.status}</span>
        {p.exit ? <span className={cn('rounded-sm border px-1 text-[10.5px]', exitBadge(p.exit.reason))}>{PLAN_EXIT_LABEL[p.exit.reason] ?? p.exit.reason}</span> : null}
        <span className={cn('num ml-auto text-[16px] font-semibold', toneOf(p.pnl_pct))}>{pctSigned(p.pnl_pct)}</span>
      </div>
      {p.reason ? <p className="text-[11.5px] text-foreground/80">{p.reason}</p> : null}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <KV k={t('计划盈亏比')} v={ratio(p.planned_rr)} title={t('首档止盈距离 / 止损距离;最低要求 {n}', { n: ratio(p.min_rr) })} />
        <KV k={t('实际 R')} v={rText(p.r_multiple)} tone={toneOf(p.r_multiple)} title={t('实际盈亏 / 计划单位风险')} />
        <KV k="MFE / MAE" v={`${pctSigned(p.mfe_pct)} / ${pctSigned(p.mae_pct)}`} title={t('持仓期间最大有利 / 最大不利偏移(按入场价)')} />
        <KV k={t('资金费')} v={pctSigned(p.funding_pct)} tone={toneOf(p.funding_pct)} />
        <KV k={t('手续费')} v={pctSigned(-Math.abs(p.fees_pct))} />
        <KV k={t('持仓根数')} v={String(p.bars_held)} />
        <KV k={t('入场')} v={`${p.entry_type === 'limit' ? t('限价') : t('市价')} ${fmtPrice(p.entry_price ?? p.reference_price)}`} />
        <KV k={t('成交价')} v={p.fill_price === null ? t('未成交') : `${fmtPrice(p.fill_price)}${p.fill_gap ? ` · ${t('跳空')}` : ''}`} tone={p.fill_gap ? 'text-warn' : undefined} />
        <KV k={t('杠杆 / 市场')} v={`${p.leverage}x · ${p.market === 'spot' ? t('现货') : t('永续')}`} />
        {p.market === 'perp' ? <KV k={t('强平价')} v={p.liquidation_price == null ? '—' : fmtPrice(p.liquidation_price)} tone={p.exit?.reason === 'liquidation' ? 'text-down' : undefined} title={t('逐仓强平价(按标记价判定);资金费期数 {n}', { n: p.funding_periods ?? 0 })} /> : null}
        <KV k={t('有效期至')} v={p.expires_at === null ? '—' : ymdhm(p.expires_at)} />
      </div>
      <div className="space-y-0.5 border-t border-border/50 pt-2">
        {p.stop ? (
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[#c94b3e]">{t('止损')}</span>
            <span className="num">
              {fmtPrice(p.stop.price)} <span className="text-[10.5px] text-muted-foreground">{LEVEL_SOURCE_LABEL[p.stop.source] ?? p.stop.source}</span>
            </span>
          </div>
        ) : null}
        {p.stop_path.length > 1 ? <div className="text-[10.5px] text-muted-foreground">{t('止损移动 {n} 次', { n: p.stop_path.length - 1 })}</div> : null}
        {p.take_profits.map((tp, i) => (
          <div key={i} className="flex items-baseline justify-between gap-2">
            <span className="text-[#2aa76e]">
              TP{i + 1} <span className="num text-[10.5px] text-muted-foreground">{Math.round(tp.size_pct * 100)}%</span>
            </span>
            <span className="num">
              {fmtPrice(tp.price)} {tp.filled_at ? <span className="text-[10.5px] text-up">✓ {ymd(tp.filled_at)}</span> : null}
            </span>
          </div>
        ))}
        {p.legs.length > 1 ? <div className="text-[10.5px] text-muted-foreground">{t('分 {n} 腿入场', { n: p.legs.length })}</div> : null}
        <div className="flex flex-wrap gap-x-3 text-[11px]">
          {link(p.rolled_from, t('滚自'))}
          {link(p.rolled_to, t('滚到'))}
          {link(p.replaced_by, t('被替换为'))}
        </div>
      </div>
      <ol className="space-y-1 border-t border-border/50 pt-2" data-testid="plan-events">
        {p.events.map((e, i) => (
          <li key={`${e.kind}-${e.at}-${i}`} className="flex items-baseline gap-1.5 text-[11px]" title={e.note || undefined}>
            <span className={cn('size-1.5 shrink-0 translate-y-px rounded-full', eventDot(e.kind))} />
            <time className="num w-[6.2em] shrink-0 text-muted-foreground">{ymd(e.at)}</time>
            <span className="min-w-0 truncate">
              {PLAN_EVENT_LABEL[e.kind] ?? e.kind}
              {e.note ? <span className="ml-1 text-muted-foreground">{e.note}</span> : null}
            </span>
            {e.price !== null ? <span className="num ml-auto shrink-0">@ {fmtPrice(e.price)}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function TradeDetail({ trade: tr }: { trade: BacktestTrade }) {
  return (
    <div className="space-y-2 p-3 text-[12px]">
      <div className="flex items-center gap-1.5">
        <span className="num text-muted-foreground">{tr.id}</span>
        <span className={cn('num ml-auto text-[16px] font-semibold', toneOf(tr.return_pct))}>{pctSigned(tr.return_pct)}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <KV k={t('入场')} v={`${ymd(tr.entry_at)} @ ${fmtPrice(tr.entry_price)}`} />
        <KV k={t('出场')} v={`${ymd(tr.exit_at)} @ ${fmtPrice(tr.exit_price)}`} />
        <KV k={t('退出原因')} v={exitReasonLabel(tr.exit_reason)} />
        <KV k={t('持仓根数')} v={String(tr.bars_held)} />
      </div>
    </div>
  );
}
