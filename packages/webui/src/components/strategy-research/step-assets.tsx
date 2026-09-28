/**
 * 第 1 步「选资产」:推荐卡片墙(短线 / 中线 / 长线三列),资产不让手填 —— 由推荐(POST /api/recommendations,纯代码、零模型费)给出。
 * 卡片:币种、适不适合、方向、建议策略族、证据(成交额 / 深度 / 日线状态 / 雷达档与名次)、证据时效;勾好点「去海选」带着币和周期进第 2 步。
 * 手动输入收在「高级」折叠里。推荐失败 / 为空:说原因 + 「重试」「去筛选页」。
 */
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, ChevronDown, Info, RefreshCw, Settings2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FAMILY_TEXT } from '@/components/chat/recommendation-card';
import { Toggle } from '@/components/matrix-study/shared';
import type { MatrixTimeframe } from '@/api/matrix-study';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, tmap, listSep } from '@/lib/i18n';
import { recommendApi, useFlowRecommendation } from './api';
import type { FlowGo } from './flow-intro';
import { HORIZONS, HORIZON_RADAR, HORIZON_TEXT, HORIZON_TF, RADAR_TIER_TEXT, cardKey, cardsByHorizon, defaultPicks, emptyReason, evidenceAge, fmtUsdShort, picksToScout, type FlowRoute, type Horizon, type RecCard, type RecLite } from './model';

const REGIME_TEXT: Record<string, string> = tmap({ bull: '多头', bear: '空头', range: '震荡', volatile: '高波动' });
const DIR_TEXT: Record<string, string> = tmap({ long: '做多', short: '做空', both: '双向' });
const REASON_TEXT: Record<string, string> = tmap({ liquidity: '流动性不够', history: '历史太短', regime: '行情不合', excluded: '已排除', unknown_asset: '找不到', no_market: '无该市场' });
const COL_CLS: Record<Horizon, string> = { short: 'from-sky-500/10', mid: 'from-primary/10', long: 'from-violet-500/10' };
const strip = (s: string) => s.replace(/USDT$/, '');

export function StepAssets({ route, go }: { route: FlowRoute; go: FlowGo }) {
  const q = useFlowRecommendation(route.rec);
  const qc = useQueryClient();
  const r = q.data ?? null;
  // 现算出来的推荐:把 id 写回地址栏,刷新时按 id 取同一份
  useEffect(() => { if (r && !route.rec) go({ rec: r.id }, { replace: true }); }, [r, route.rec, go]);
  const [picks, setPicks] = useState<string[] | null>(null);
  useEffect(() => {
    if (!r || picks) return;
    const fromRoute = route.syms.length ? HORIZONS.flatMap((h) => (route.tfs.includes(HORIZON_TF[h]) ? route.syms.map((s) => cardKey(s, h)) : [])) : [];
    const valid = new Set(HORIZONS.flatMap((h) => cardsByHorizon(r)[h].filter((c) => c.fit.eligible).map((c) => c.key)));
    const kept = fromRoute.filter((k) => valid.has(k));
    setPicks(kept.length ? kept : defaultPicks(r));
  }, [r, picks, route.syms, route.tfs]);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      const n = await recommendApi.create();
      qc.setQueryData(['strategy-research', 'recommendation', n.id], n);
      setPicks(null);
      go({ rec: n.id }, { replace: true });
    } catch (e) { toast.error((e as Error).message); }
    finally { setRefreshing(false); }
  };
  const retry = () => (route.rec ? void q.refetch() : void refresh());
  const now = Date.now();

  if (q.isLoading) return <WallSkeleton />;
  const reason = emptyReason(r, q.isError ? (q.error as Error).message : null);
  const sel = picks ?? [];
  const preset = r ? picksToScout(r, sel) : null;
  const toScout = (p: { syms: string[]; tfs: MatrixTimeframe[]; fams?: string[]; sides?: ('long' | 'short')[]; mkt?: 'spot' | 'perp' }) =>
    go({ step: 'scout', syms: p.syms, tfs: p.tfs, fams: p.fams ?? [], sides: p.sides ?? [], mkt: p.mkt ?? null, study: null, trial: null, sref: null });

  return (
    <div className="flex flex-col gap-3" data-testid="step-assets">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-semibold">{t('今天值得研究的币')}</h2>
        <span className="text-[11.5px] text-muted-foreground">{t('按成交额、深度、日线状态和雷达三档排名算出来的,不花模型的钱;推荐只说明值得研究,赚不赚要看回测。')}</span>
        {r ? <span className="num ml-auto text-[11px] text-muted-foreground">{t('推荐于 {time}', { time: relativeTime(r.as_of, now) })}</span> : null}
        <Button size="sm" variant="ghost" className={cn('gap-1', !r && 'ml-auto')} disabled={refreshing} onClick={() => void refresh()}><RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />{t('重新推荐')}</Button>
      </div>

      {reason ? (
        <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed bg-muted/20 p-4 text-[12.5px]" data-testid="assets-empty">
          <div className="flex items-start gap-1.5"><TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" /><span>{reason}</span></div>
          <div className="flex gap-2">
            <Button size="sm" onClick={retry} className="gap-1"><RefreshCw className="size-3.5" />{t('重试')}</Button>
            <Button size="sm" variant="outline" onClick={() => { window.location.hash = 'screener'; }}>{t('去筛选页')}</Button>
          </div>
        </div>
      ) : null}

      {r && !reason && r.warnings.length ? (
        <div className="flex items-start gap-1.5 rounded-lg border border-warn/30 bg-warn/5 px-3 py-1.5 text-[11.5px] text-muted-foreground"><TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />{r.warnings.join(';')}</div>
      ) : null}

      {r && !reason ? (
        <div className="grid gap-3 lg:grid-cols-3">
          {HORIZONS.map((h) => <Column key={h} h={h} r={r} now={now} picks={sel} onToggle={(k) => setPicks((p) => { const cur = p ?? []; return cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]; })} />)}
        </div>
      ) : null}

      {r && !reason ? (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-card/95 px-3 py-2 text-[12px] shadow-[0_-8px_24px_-18px_rgba(0,0,0,.5)] backdrop-blur">
          {preset && preset.syms.length ? (
            <>
              <span className="font-medium">{t('已选 {n} 个币', { n: preset.syms.length })}</span>
              <span className="num text-muted-foreground">{preset.syms.map(strip).join(' · ')}</span>
              <span className="text-muted-foreground">{t('周期')} {preset.tfs.join(' / ')}</span>
              {preset.fams.length ? <span className="text-muted-foreground">{preset.fams.map((f) => FAMILY_TEXT[f as keyof typeof FAMILY_TEXT] ?? f).join(listSep())}</span> : null}
              {new Set(sel.map((k) => k.split('|')[0])).size > 6 ? <span className="text-warn">{t('海选一次最多 6 个币,多的不带')}</span> : null}
            </>
          ) : <span className="text-muted-foreground">{t('勾几张卡片,再去海选')}</span>}
          <Button size="sm" className="ml-auto gap-1 font-semibold" disabled={!preset?.syms.length} onClick={() => preset && toScout(preset)} data-testid="to-scout">
            {t('去海选')}<ArrowRight className="size-3.5" />
          </Button>
        </div>
      ) : null}

      <ManualFold onGo={toScout} />
    </div>
  );
}

function Column({ h, r, now, picks, onToggle }: { h: Horizon; r: RecLite; now: number; picks: string[]; onToggle: (k: string) => void }) {
  const cards = useMemo(() => cardsByHorizon(r)[h], [r, h]);
  const ok = cards.filter((c) => c.fit.eligible), no = cards.filter((c) => !c.fit.eligible);
  const [showNo, setShowNo] = useState(false);
  const age = evidenceAge(r, h, now);
  return (
    <section className={cn('flex flex-col gap-2 rounded-xl border bg-gradient-to-b to-transparent p-2.5', COL_CLS[h])} data-horizon={h}>
      <header className="flex flex-wrap items-baseline gap-x-2 px-0.5">
        <h3 className="text-[14px] font-semibold">{HORIZON_TEXT[h]}</h3>
        <span className="num text-[11px] text-muted-foreground">{t('海选按 {tf} 跑', { tf: HORIZON_TF[h] })}</span>
        <span className={cn('ml-auto text-[10.5px]', age.stale ? 'text-warn' : 'text-muted-foreground')} title={age.source === 'radar' ? RADAR_TIER_TEXT[HORIZON_RADAR[h]] : undefined}>
          {age.at ? `${age.source === 'radar' ? RADAR_TIER_TEXT[HORIZON_RADAR[h]] : age.source === 'regime' ? t('日线状态') : t('全市场扫描')} · ${relativeTime(age.at, now)}${age.stale ? ` · ${t('已过期')}` : ''}` : t('证据时间未知')}
        </span>
      </header>
      {ok.length ? ok.map((c) => <Card key={c.key} c={c} on={picks.includes(c.key)} onToggle={() => onToggle(c.key)} />) : (
        <p className="rounded-lg border border-dashed px-3 py-4 text-center text-[12px] text-muted-foreground">{t('这一档眼下没有适合的币')}</p>
      )}
      {no.length ? (
        <div>
          <button type="button" onClick={() => setShowNo((v) => !v)} className="inline-flex items-center gap-1 px-0.5 text-[11px] text-muted-foreground hover:text-foreground">
            <ChevronDown className={cn('size-3 transition-transform', showNo && 'rotate-180')} />{t('不适合的 {n} 个', { n: no.length })}
          </button>
          {showNo ? (
            <ul className="mt-1 space-y-1">
              {no.map((c) => (
                <li key={c.key} className="flex items-center gap-2 rounded-md border border-dashed px-2 py-1 text-[11.5px] text-muted-foreground" data-eligible="false">
                  <span className="num font-medium text-foreground/70">{strip(c.symbol)}</span>
                  <span>{c.fit.reason ? REASON_TEXT[c.fit.reason] ?? c.fit.reason : t('不适合')}</span>
                  <span className="ml-auto truncate text-[10.5px]" title={c.fit.evidence.join('\n')}>{c.fit.evidence.at(-1) ?? ''}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Card({ c, on, onToggle }: { c: RecCard; on: boolean; onToggle: () => void }) {
  const row = c.row, fit = c.fit;
  const dirCls = fit.direction === 'short' ? 'border-down/40 bg-down/10 text-down' : fit.direction === 'both' ? 'border-primary/40 bg-primary/10 text-primary' : 'border-up/40 bg-up/10 text-up';
  const facts: [string, string][] = [
    [t('24h 成交额'), fmtUsdShort(row.quote_vol_24h)],
    [t('±0.5% 深度'), fmtUsdShort(row.depth_usd_05)],
    [t('日线'), row.regime ? REGIME_TEXT[row.regime] ?? row.regime : t('未知')],
    [t('雷达'), c.radar ? t('第 {n} 名', { n: c.radar.rank }) : row.scan ? t('扫描第 {n} 名', { n: row.scan.rank }) : '—'],
  ];
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      data-card={c.key}
      onClick={onToggle}
      className={cn(
        'group relative flex flex-col gap-1.5 rounded-lg border bg-card p-2.5 text-left transition-all hover:-translate-y-px hover:border-primary/50 hover:shadow-[0_10px_24px_-16px_var(--primary)] focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none',
        on && 'border-primary bg-primary/[0.06] ring-1 ring-primary/40',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn('grid size-4 shrink-0 place-items-center rounded border transition-colors', on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40 group-hover:border-primary/60')}>
          {on ? <Check className="size-3" /> : null}
        </span>
        <span className="num text-[15px] font-semibold tracking-tight">{strip(c.symbol)}</span>
        <span className="rounded border px-1 text-[10px] text-muted-foreground">{row.market === 'perp' ? t('永续') : t('现货')}</span>
        <span className={cn('ml-auto rounded-full border px-2 py-0.5 text-[11px] font-medium', dirCls)}>{fit.direction ? DIR_TEXT[fit.direction] : '—'}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {fit.families.slice(0, 4).map((f) => <span key={f} className="rounded-full bg-muted px-1.5 py-0.5 text-[10.5px]">{FAMILY_TEXT[f as keyof typeof FAMILY_TEXT] ?? f}</span>)}
      </div>
      <dl className="grid grid-cols-4 gap-1 text-[10.5px]">
        {facts.map(([k, v]) => (
          <div key={k} className="min-w-0 rounded bg-muted/40 px-1.5 py-1">
            <dt className="truncate text-muted-foreground">{k}</dt>
            <dd className="num truncate font-medium">{v}</dd>
          </div>
        ))}
      </dl>
      {fit.evidence.length ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex w-fit items-center gap-1 text-[10.5px] text-muted-foreground hover:text-foreground"><Info className="size-3" />{t('看证据({n} 条)', { n: fit.evidence.length })}</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-80"><ul className="space-y-0.5 text-[11px]">{fit.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul></TooltipContent>
        </Tooltip>
      ) : null}
    </button>
  );
}

function ManualFold({ onGo }: { onGo: (p: { syms: string[]; tfs: MatrixTimeframe[] }) => void }) {
  const [text, setText] = useState('');
  const [tfs, setTfs] = useState<MatrixTimeframe[]>(['4h']);
  const syms = [...new Set(text.split(/[\s,，]+/).map((s) => s.trim().toUpperCase()).filter(Boolean).map((s) => (s.endsWith('USDT') ? s : `${s}USDT`)))].slice(0, 6);
  return (
    <details className="group/adv rounded-lg border px-3 py-2 text-[12px]" data-testid="assets-advanced">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground hover:text-foreground">
        <Settings2 className="size-3.5" />{t('高级:手动指定资产')}<ChevronDown className="size-3 transition-transform group-open/adv:rotate-180" />
      </summary>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t('空格分隔,如 SOL DOGE HYPE(≤ 6 个)')} className="h-8 min-w-60 flex-1 rounded-md border bg-background px-2" />
        <Toggle all={['15m', '4h', '1d'] as MatrixTimeframe[]} value={tfs} onChange={setTfs} label={(x) => x} />
        <Button size="sm" variant="outline" disabled={!syms.length || !tfs.length} onClick={() => onGo({ syms, tfs })}>{t('用这些去海选')}</Button>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">{t('不推荐:手填的币没经过流动性和行情检查,海选结果可能更难看。')}</p>
    </details>
  );
}

function WallSkeleton() {
  return (
    <div className="grid gap-3 lg:grid-cols-3" data-testid="assets-loading" aria-busy>
      {HORIZONS.map((h) => (
        <div key={h} className="flex flex-col gap-2 rounded-xl border p-2.5">
          <Skeleton className="h-5 w-24" />
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 rounded-lg" />)}
        </div>
      ))}
    </div>
  );
}
