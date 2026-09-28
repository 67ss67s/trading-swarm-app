/**
 * 优化(#refine,2026-09-28):「策略研究」第 3 步「精修」单独成页,侧栏紧跟在策略研究后面。
 *   没带入组合时先挑:最近的海选(批量验证)→ 这次海选里能精修的组合(按档位 + 评分排),点「优化这一组」带进研究台;
 *   也可以「从头开始」直接用研究台。带入之后和流程页第 3 步是同一个工作区(components/strategy-research/refine-workspace.tsx)。
 *   和流程页的区别:存好策略后不自动跳走,只提示并给「去验收」按钮(验收在策略研究流程里做)。
 * 地址栏规则见 components/strategy-research/refine-model.ts。
 */
import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, FlaskConical, Plus, SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { useMatrixStudies, useMatrixStudy, type MatrixStudyView } from '@/api/matrix-study';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { familyLabel, STATUS_TEXT, shortSyms } from '@/components/matrix-study/shared';
import type { MapTone } from '@/components/matrix-study/explain';
import { flowHash } from '@/components/strategy-research/model';
import { RefineWorkspace, type SavedStrategy } from '@/components/strategy-research/refine-workspace';
import { parseRefineRoute, refineCandidates, refineHash, type RefineRoute } from '@/components/strategy-research/refine-model';
import { fmtDateTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const go = (hash: string) => { window.location.hash = hash; };
const toValidate = (strategy: string) => go(flowHash({ step: 'validate', strategy }));
const toScout = (study?: string) => go(flowHash({ step: 'scout', ...(study ? { study } : {}) }));

function useRefineRoute(): RefineRoute {
  const [route, setRoute] = useState<RefineRoute>(() => parseRefineRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRefineRoute(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function RefinePage() {
  const route = useRefineRoute();
  const seed = route.study && route.trial ? { study: route.study, trial: route.trial } : null;
  const onSaved = useCallback((s: SavedStrategy) => {
    toast.success(t('「{name}」已存进我的策略', { name: s.label }), { action: { label: t('去验收'), onClick: () => toValidate(s.id) } });
  }, []);
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 pb-4" data-testid="refine-page">
      {seed || route.blank ? (
        <RefineWorkspace
          seed={seed}
          active
          onSaved={onSaved}
          onValidate={toValidate}
          back={{ label: t('换一组'), go: () => go(refineHash({})) }}
          onBackToScout={toScout}
          emptyText={t('从头开始:在研究台里描述你想试的策略,或者打开「策略构建」手写规则。')}
          hint={t('在研究台里改规则、跑回测;每次回测会自动存进「我的策略」,存好就可以去验收。')}
        />
      ) : (
        <RefinePicker />
      )}
    </div>
  );
}

const TONE_TEXT: Partial<Record<MapTone, string>> = { pass: '通过', waiting: '等最终验收', candidate: '候补 · 可纸面观察', near: '接近', fail: '未通过' };
const TONE_CLS: Partial<Record<MapTone, string>> = {
  pass: 'border-up/50 bg-up/15 text-up',
  waiting: 'border-up/40 bg-up/10 text-up',
  candidate: 'border-primary/60 bg-primary/10 text-primary',
  near: 'border-warn/40 bg-warn/10 text-warn',
  fail: 'text-muted-foreground',
};
const signed = (v: number | null) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
/** 已经出了结果的海选才有组合可挑 */
const hasResults = (s: MatrixStudyView) => s.status !== 'queued' && s.status !== 'failed' && s.status !== 'cancelled';

function RefinePicker() {
  const studiesQ = useMatrixStudies();
  const studies = (studiesQ.data?.items ?? []).filter(hasResults).slice(0, 8);
  const [picked, setPicked] = useState<string | null>(null);
  const studyId = picked ?? studies[0]?.id ?? null;
  return (
    <>
      <section className="rounded-xl border bg-card px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <SlidersHorizontal className="size-4 text-primary" />
          <h2 className="text-[14px] font-semibold">{t('优化')}</h2>
          <span className="text-[12.5px] text-muted-foreground">{t('挑一组海选结果,在研究台里逐条改规则、重新回测;每次回测都会自动存进「我的策略」。')}</span>
          <Button size="sm" variant="outline" className="ml-auto gap-1" onClick={() => go(refineHash({ blank: true }))} data-testid="refine-blank">
            <Plus className="size-3.5" />{t('从头开始')}
          </Button>
        </div>
      </section>
      {studiesQ.isLoading ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : studiesQ.isError ? (
        <p className="rounded-xl border border-dashed px-3 py-6 text-center text-[12.5px] text-destructive">{t('海选记录读不到:{e}', { e: (studiesQ.error as Error).message })}</p>
      ) : !studies.length ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-3 py-10 text-center text-[12.5px] text-muted-foreground" data-testid="refine-empty">
          <FlaskConical className="size-5 text-muted-foreground/70" />
          <p>{t('还没有海选结果。先在「策略研究」里跑一次海选,再回来挑一组优化;也可以直接从头开始。')}</p>
          <a href={`#${flowHash({ step: 'assets' })}`} className="inline-flex items-center gap-1 text-primary hover:underline">{t('去策略研究')}<ArrowRight className="size-3" /></a>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <section className="rounded-xl border p-2" aria-label={t('最近的海选')}>
            <h3 className="px-1 pb-1.5 text-[12.5px] font-medium">{t('最近的海选')}</h3>
            <ul className="flex flex-col gap-1">
              {studies.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setPicked(s.id)}
                    aria-current={s.id === studyId ? 'true' : undefined}
                    className={cn('flex w-full flex-col items-start rounded-lg border px-2.5 py-1.5 text-left transition-colors', s.id === studyId ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-muted/50')}
                  >
                    <span className="w-full truncate text-[12.5px] font-medium">{shortSyms(s.manifest.spec.symbols)} — {s.manifest.spec.timeframes.join('/')}</span>
                    <span className="num text-[11px] text-muted-foreground">{fmtDateTime(s.created_at)} · {STATUS_TEXT[s.status] ?? s.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          {studyId ? <StudyCandidates key={studyId} id={studyId} /> : null}
        </div>
      )}
    </>
  );
}

function StudyCandidates({ id }: { id: string }) {
  const q = useMatrixStudy(id);
  if (q.isLoading) return <Skeleton className="h-64 rounded-xl" />;
  if (q.isError || !q.data) return <p className="rounded-xl border border-dashed px-3 py-6 text-center text-[12.5px] text-destructive">{t('这次海选读不到:{e}', { e: q.error ? (q.error as Error).message : '—' })}</p>;
  const s = q.data;
  const rows = refineCandidates(s);
  return (
    <section className="rounded-xl border p-3" data-testid="refine-candidates">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-medium">{t('这次海选里能优化的组合')}</h3>
        <span className="text-[11.5px] text-muted-foreground">{t('按结果排:通过的在前,同档按评分')}</span>
        <button type="button" className="ml-auto inline-flex items-center gap-1 text-[12px] text-primary hover:underline" onClick={() => toScout(s.id)}>{t('看完整结果地图')}<ArrowRight className="size-3" /></button>
      </div>
      {!rows.length ? (
        <p className="py-6 text-center text-[12.5px] text-muted-foreground">{s.status === 'running' ? t('这次海选还在跑,出了结果会显示在这里。') : t('这次海选没有能带进研究台的组合。换一次海选,或者从头开始。')}</p>
      ) : (
        <ul className="divide-y">
          {rows.map((c) => (
            <li key={`${c.def.id}|${c.trial}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-[12.5px]">
              <span className="min-w-0 flex-1 truncate">
                <span className="num font-medium">{c.def.symbol.replace(/USDT$/, '')} {c.def.timeframe}</span>
                <span className="text-muted-foreground"> · {familyLabel(c.def.family, s.my_strategies)} · {c.def.side === 'long' ? t('做多') : t('做空')}{c.def.arm === 'code_judge' ? ` · ${t('代码 + Jev 判断')}` : ''}</span>
              </span>
              <span className={cn('shrink-0 rounded border px-1.5 text-[11px]', TONE_CLS[c.tone])}>{t(TONE_TEXT[c.tone] ?? '')}</span>
              <span className="num w-16 shrink-0 whitespace-nowrap text-right">{signed(c.total_return)}</span>
              <span className="num w-20 shrink-0 whitespace-nowrap text-right text-muted-foreground">{c.trades == null ? '—' : t('{n} 笔', { n: c.trades })}</span>
              <span className="num w-20 shrink-0 whitespace-nowrap text-right text-muted-foreground">{c.score == null ? '—' : `${t('评分')} ${c.score}`}</span>
              <Button size="xs" variant="outline" className="shrink-0 gap-1" onClick={() => go(refineHash({ study: s.id, trial: c.trial }))} data-testid="refine-pick">
                <SlidersHorizontal className="size-3" />{t('优化这一组')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
