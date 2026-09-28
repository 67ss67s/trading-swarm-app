/**
 * 第 4 步「验收」:当前这条策略(地址栏 strategy)的四段状态条 —— 历史回测 / 最终验收 / 模拟盘前向 / 上岗条件(只建议,不硬拦);
 * 「用模拟盘跑起来」:GET /api/strategy-runs/preflight 看执行通道 → POST /api/strategy-runs(mode=auto,币池默认跟随与周期对应的雷达档);
 *   实盘通道仍要输入 LIVE。已在跑就显示运行状态条(复用「我的策略」的 RunStatusBar)。
 * 「回测里会怎么做 vs 模拟盘实际怎么做」:运行事件里每个候选 = 规则在那根 K 线上的计划,之后同币的处理 = 实际;没有就占位。
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, ChevronRight, Loader2, Radar, Rocket, Settings2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import type { ResearchStrategy } from '@trade-gate/contracts';
import { researchApi, strategyRunsApi } from '@/api/client';
import type { StrategyRun, StrategyRunPreflight, StrategyRunRequest } from '@/api/types';
import { useMatrixStudy } from '@/api/matrix-study';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { displayName, strategySource, SOURCE_TEXT } from '@/components/agent-strategy/switch-list';
import { RunDialog, RunStatusBar, scanSummary, useStrategyRuns } from '@/components/my-strategies/run-panel';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { FlowGo } from './flow-intro';
import { RADAR_TIER_TEXT, RADAR_TOP_N, finalState, forwardRunOf, parityRows, radarTierOf, statusSegments, studyIdOf, type FlowRoute, type ParityRow, type SegTone, type StatusSeg } from './model';
import { StrategyPicker } from './strategy-picker';

export function useFlowStrategy(id: string | null) {
  return useQuery({ queryKey: ['research', 'my-strategy', id, undefined], queryFn: () => researchApi.myStrategy(id!), enabled: !!id, retry: false });
}

export function StepValidate({ route, go }: { route: FlowRoute; go: FlowGo }) {
  if (!route.strategy) return <StrategyPicker title={t('选一条我的策略来验收')} onPick={(id) => go({ strategy: id })} onBack={{ label: t('回到精修'), go: () => go({ step: 'refine' }) }} />;
  return <ValidateBody key={route.strategy} id={route.strategy} route={route} go={go} />;
}

function ValidateBody({ id, route, go }: { id: string; route: FlowRoute; go: FlowGo }) {
  const q = useFlowStrategy(id);
  const s = q.data?.strategy ?? null;
  const studyId = route.study ?? (s ? studyIdOf(s.description) : null);
  const studyQ = useMatrixStudy(studyId);
  const runsQ = useStrategyRuns();
  const run = forwardRunOf(runsQ.data?.runs, id);
  if (q.isLoading) return <Skeleton className="h-60 rounded-xl" />;
  if (q.isError || !s) return (
    <div className="rounded-xl border border-dashed p-4 text-[12.5px]">
      <p className="text-destructive">{t('读不到这条策略:{e}', { e: (q.error as Error | null)?.message ?? id })}</p>
      <Button size="sm" variant="outline" className="mt-2" onClick={() => go({ strategy: null })}>{t('换一条')}</Button>
    </div>
  );
  const final = finalState(s, studyQ.data ?? null);
  const segs = statusSegments(s, final, run);
  const src = strategySource(s);
  return (
    <div className="flex flex-col gap-3" data-testid="step-validate">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="text-[15px] font-semibold">{displayName(s)} <span className="num text-muted-foreground">v{s.current_version}</span></h2>
        <span className="num text-[12px] text-muted-foreground">{s.symbol.replace(/USDT$/, '')} · {s.timeframe}</span>
        {src ? <span className="rounded-full border px-2 py-0.5 text-[10.5px] text-muted-foreground">{t(SOURCE_TEXT[src])}</span> : null}
        <div className="ml-auto flex items-center gap-3 text-[12px]">
          <a className="text-primary hover:underline" href={`#my-strategies?id=${encodeURIComponent(s.id)}`}>{t('打开策略详情')}</a>
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => go({ strategy: null })}>{t('换一条')}</button>
        </div>
      </header>

      <StatusBar segs={segs} />

      {run && run.status !== 'stopped' ? <RunStatusBar run={run} /> : <PaperRunCard strategy={s} stoppedRun={run} />}

      <ParityCard run={run} />

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => go({ step: 'refine' })}><ArrowLeft className="size-3.5" />{t('回到精修')}</button>
        {final !== 'passed' && studyId ? <button type="button" className="text-[12px] text-primary hover:underline" onClick={() => go({ step: 'scout', study: studyId })}>{t('回海选看最终验收')}</button> : null}
        <Button size="sm" className="ml-auto gap-1 font-semibold" onClick={() => go({ step: 'deploy' })} data-testid="to-deploy">{t('下一步:上岗')}<ArrowRight className="size-3.5" /></Button>
      </div>
    </div>
  );
}

const TONE: Record<SegTone, string> = {
  ok: 'border-up/40 bg-up/[0.07]',
  warn: 'border-warn/40 bg-warn/[0.07]',
  bad: 'border-down/40 bg-down/[0.07]',
  idle: 'border-dashed bg-muted/20',
};
const DOT: Record<SegTone, string> = { ok: 'bg-up', warn: 'bg-warn', bad: 'bg-down', idle: 'bg-muted-foreground/40' };

export function StatusBar({ segs }: { segs: StatusSeg[] }) {
  return (
    <ol className="grid gap-1.5 md:grid-cols-4" data-testid="validate-status">
      {segs.map((g, i) => (
        <li key={g.key} data-seg={g.key} data-tone={g.tone} className={cn('relative flex flex-col gap-0.5 rounded-lg border px-3 py-2', TONE[g.tone])}>
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><span className={cn('size-1.5 rounded-full', DOT[g.tone])} />{g.title}</span>
          <span className="num text-[14px] font-semibold">{g.value}</span>
          {g.note ? <span className="text-[11px] leading-snug text-muted-foreground">{g.note}</span> : null}
          {i < segs.length - 1 ? <ChevronRight aria-hidden className="absolute top-1/2 -right-2.5 z-10 hidden size-4 -translate-y-1/2 rounded-full bg-background text-muted-foreground/60 md:block" /> : null}
        </li>
      ))}
    </ol>
  );
}

function PaperRunCard({ strategy, stoppedRun }: { strategy: ResearchStrategy; stoppedRun: StrategyRun | null }) {
  const qc = useQueryClient();
  const pf = useQuery({ queryKey: ['strategy-run-preflight', strategy.id, null], queryFn: () => strategyRunsApi.preflight(strategy.id), retry: false });
  const tier = radarTierOf(strategy.timeframe);
  const [followRadar, setFollowRadar] = useState(true);
  const [confirm, setConfirm] = useState('');
  const [more, setMore] = useState(false);
  const start = useMutation({
    mutationFn: (p: StrategyRunPreflight) => strategyRunsApi.start(runRequest(strategy.id, p, followRadar, confirm)),
    onSuccess: (r) => {
      toast.success(t('「{name}」开始在模拟盘跑', { name: displayName(strategy) }), { description: `${t('刚扫了一遍')}:${scanSummary(r.scan)}` });
      void qc.invalidateQueries({ queryKey: ['strategy-runs'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const p = pf.data;
  const live = !!p?.requires_live_confirm;
  const can = !!p && p.deployable && !p.blockers.length && (!live || confirm.trim() === 'LIVE');
  return (
    <section className="flex flex-col gap-2 rounded-xl border bg-card px-4 py-3" data-testid="paper-run">
      <div className="flex flex-wrap items-center gap-2">
        <Rocket className="size-4 text-primary" />
        <h3 className="text-[14px] font-semibold">{t('用模拟盘跑一段')}</h3>
        <span className="text-[11.5px] text-muted-foreground">{t('回测只是历史;在模拟盘上按同一套规则真下单,攒够前向成交再决定上不上岗。')}</span>
      </div>
      {stoppedRun ? <p className="text-[11.5px] text-muted-foreground">{t('上一次运行已停止({time}),成绩留在上面的状态条里;重新开始会接着记。', { time: relativeTime(stoppedRun.updated_at) })}</p> : null}
      {pf.isLoading ? <Skeleton className="h-16 rounded-lg" /> : pf.isError || !p ? <p className="text-[12px] text-destructive">{t('读取运行预检失败')}:{(pf.error as Error | null)?.message}</p> : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <span className={cn('rounded-full border px-2.5 py-0.5 font-medium', live ? 'border-destructive/50 bg-destructive/10 text-destructive' : 'border-up/40 bg-up/10 text-up')} data-channel={live ? 'live' : 'paper'}>
              {t('下单到')} {p.execution.label}
            </span>
            <span className="rounded-full border px-2.5 py-0.5">{t('自动下单')}</span>
            <div role="radiogroup" aria-label={t('币池')} className="flex items-center gap-0.5 rounded-full border p-0.5">
              <button type="button" role="radio" aria-checked={followRadar} onClick={() => setFollowRadar(true)} className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5', followRadar ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>
                <Radar className="size-3" />{t('跟随{tier}前 {n}', { tier: RADAR_TIER_TEXT[tier], n: RADAR_TOP_N })}
              </button>
              <button type="button" role="radio" aria-checked={!followRadar} onClick={() => setFollowRadar(false)} className={cn('rounded-full px-2.5 py-0.5', !followRadar ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}>
                {t('固定:{syms}', { syms: p.defaults.symbols.map((x) => x.replace(/USDT$/, '')).join(' ') || '—' })}
              </button>
            </div>
          </div>
          {p.blockers.map((b) => <p key={b.code} className="flex items-start gap-1 text-[12px] text-destructive"><TriangleAlert className="mt-0.5 size-3 shrink-0" />{b.message}</p>)}
          {p.warnings.slice(0, 3).map((w) => <p key={w.code} className="flex items-start gap-1 text-[11.5px] text-muted-foreground"><TriangleAlert className="mt-0.5 size-3 shrink-0 text-warn" />{w.message}</p>)}
          {live ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-[12px]">
              <span>{t('当前账户接的是实盘,不是模拟盘。确定要用真钱跑,输入 LIVE:')}</span>
              <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="LIVE" className="h-7 w-28 text-[12px]" />
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <Button size="sm" className="gap-1 font-semibold" disabled={!can || start.isPending} onClick={() => start.mutate(p)} data-testid="start-paper">
              {start.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Rocket className="size-3.5" />}{live ? t('用实盘跑起来') : t('用模拟盘跑起来')}
            </Button>
            <Button size="sm" variant="ghost" className="gap-1" onClick={() => setMore(true)}><Settings2 className="size-3.5" />{t('更多设置')}</Button>
          </div>
        </>
      )}
      {more ? <RunDialog strategy={strategy} version={null} onClose={() => setMore(false)} /> : null}
    </section>
  );
}

/** 创建运行的请求体:mode=auto、市场 / 风险 / 持仓数取预检缺省;币池跟随雷达档时带 symbols_source(client 类型还没这个字段,后端已支持) */
export function runRequest(strategyId: string, p: StrategyRunPreflight, followRadar: boolean, confirm: string): StrategyRunRequest {
  const tier = radarTierOf(p.timeframe);
  const body = {
    strategy_id: strategyId, version: p.version, mode: 'auto' as const, market: p.defaults.market, symbols: p.defaults.symbols,
    risk_pct: p.defaults.risk_pct, max_open: p.defaults.max_open, publish_asp: false,
    ...(followRadar ? { symbols_source: { kind: 'radar', tier, top_n: RADAR_TOP_N } } : {}),
    ...(p.requires_live_confirm ? { confirm: confirm.trim() } : {}),
  };
  return body as StrategyRunRequest;
}

const ACTUAL_TEXT: Record<ParityRow['actual'], string> = { opened: '已下单', pending: '等你确认', rejected: '被拦下', skipped: '跳过', waiting: '处理中' };
const ACTUAL_CLS: Record<ParityRow['actual'], string> = { opened: 'text-up', pending: 'text-warn', rejected: 'text-down', skipped: 'text-muted-foreground', waiting: 'text-muted-foreground' };

function ParityCard({ run }: { run: StrategyRun | null }) {
  const q = useQuery({ queryKey: ['strategy-run-events', run?.id, 'parity'], queryFn: () => strategyRunsApi.events(run!.id, 50), enabled: !!run, retry: false, refetchInterval: run?.status === 'running' ? 30_000 : false });
  const rows = q.data ? parityRows(q.data.rows) : [];
  return (
    <section className="rounded-xl border px-4 py-3 text-[12px]" data-testid="parity">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
        <h3 className="text-[13px] font-semibold">{t('回测里会怎么做 vs 模拟盘实际怎么做')}</h3>
        <span className="text-[11px] text-muted-foreground">{t('左边是规则在那根 K 线上的计划(和回测同一套代码算的),右边是模拟盘上真实发生的事。')}</span>
      </div>
      {!rows.length ? (
        <p className="rounded-lg border border-dashed px-3 py-3 text-center text-muted-foreground" data-testid="parity-empty">{run ? t('前向成交在积累:还没有命中过信号,下一根 K 线收盘会再扫。') : t('前向成交在积累:先用模拟盘跑起来,这里会逐笔对照。')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead><tr className="text-[10.5px] text-muted-foreground">
              <th className="py-1 pr-2 font-normal">{t('时间')}</th><th className="py-1 pr-2 font-normal">{t('币')}</th>
              <th className="py-1 pr-2 font-normal">{t('回测规则会')}</th><th className="py-1 font-normal">{t('模拟盘实际')}</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.symbol}|${r.at}`} className="border-t align-top">
                  <td className="num py-1.5 pr-2 text-muted-foreground">{relativeTime(r.at)}</td>
                  <td className="num py-1.5 pr-2 font-medium">{r.symbol.replace(/USDT$/, '')}</td>
                  <td className="num py-1.5 pr-2">{r.direction === 'short' ? t('做空') : t('做多')} @ {r.plan.entry ?? '—'} · {t('止损')} {short(r.plan.stop)} · {t('目标')} {short(r.plan.target)}{r.plan.rr != null ? ` · ${t('盈亏比')} ${r.plan.rr.toFixed(2)}` : ''}</td>
                  <td className="py-1.5">
                    <span className={ACTUAL_CLS[r.actual]}>{t(ACTUAL_TEXT[r.actual])}</span>
                    {r.closed ? <span className="num ml-1">· {t('已平')} {r.realized_r == null ? '—' : `${r.realized_r >= 0 ? '+' : '−'}${Math.abs(r.realized_r).toFixed(2)}R`}</span> : null}
                    {r.reason ? <div className="text-[11px] text-muted-foreground">{r.reason}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
const short = (v: string | null) => { if (!v) return '—'; const n = Number(v); return Number.isFinite(n) ? String(Number(n.toPrecision(6))) : v; };
