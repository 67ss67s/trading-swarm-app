/**
 * 批量验证详情(内部名:矩阵研究,§9.53 B)。09-25 改版,面向第一次用的交易者:
 *   结论卡(只说一次;按三档说:通过 / 候补 · 可纸面观察 / 未通过;主因翻成人话 + 下一步建议)→ 进度与花费
 *   → 结果地图(资产·周期 × 策略,按三档上色;悬停看评分卡摘要,点开抽屉:指标表、运气折扣、存为候补策略、在研究台继续打磨)
 *   → Jev 判断的效果(每格「代码 + Jev 判断」减「纯代码」的每日差值与 95% 区间、放行比例)→ 收益最高的几组和同期持有比
 *   → 最终候选(最终验收一次 + 存成我的策略 → 设为 agent 当前策略)→ 自动诊断改进的时间线(发现 / 改了 / 结果,原文进折叠)。
 * 视图里没有逐日净值,所以不画净值曲线,只比最终收益;缺数据的块直接不显示,不编数。
 * 「我的策略」格子(family = my:<strategy_id>@v<version>)存下来是那条策略的新版本,不是新策略。
 */
import { useContext, useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, FlaskConical, Lightbulb, Lock, PlayCircle, Square, Sparkles, TriangleAlert, Unlock } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useSetAgentStrategy } from '@/api/agent-strategy';
import { useMatrixAction, useMatrixStudy, type CandidateAdoptResult, type CellResult, type FailureCause, type MatrixArm, type MatrixCellDef, type MatrixFinalist, type MatrixGeneration, type MatrixStudyView, type SlimScore } from '@/api/matrix-study';
import { cn } from '@/lib/utils';
import { t, listSep } from '@/lib/i18n';
import { canAdoptCandidate, causePlain, conclusionHead, gatePlain, groupGenerations, judgeRows, judgeStageNote, mainCause, mapTone, naReason, nextSteps, parseDiagnosis, plainChange, researchLink, scoreLabelText, splitNotes, topCells, type JudgeRow, type MapTone } from './explain';
import { ARM_TEXT, CAUSE_TEXT, DivisionNote, MatrixFlowContext, STAGE_TEXT, STATUS_TEXT, TF_HORIZON, familyLabel, parseMyFamily, pct, shortSyms } from './shared';
import { st as serverText } from '@/lib/server-text-en';

const sideText = (side: string) => (side === 'long' ? t('做多') : t('做空'));
const cellName = (c: Pick<MatrixCellDef, 'symbol' | 'timeframe' | 'family' | 'side'>, s: MatrixStudyView) => `${c.symbol.replace(/USDT$/, '')} ${c.timeframe} · ${familyLabel(c.family, s.my_strategies)} · ${sideText(c.side)}`;
const signed = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}%`);

export function MatrixStudyDetail({ id, onBack }: { id: string; onBack?: () => void }) {
  const q = useMatrixStudy(id);
  if (q.isLoading) return <div className="h-40 animate-pulse rounded-lg border" />;
  if (q.isError || !q.data) return <p className="text-[13px] text-destructive">{t('读取研究失败')}:{(q.error as Error | null)?.message}</p>;
  return <MatrixStudyBody s={q.data} onBack={onBack} />;
}

/** 详情主体(拿到视图后的全部内容);独立导出给测试用真实返回渲染 */
export function MatrixStudyBody({ s, onBack }: { s: MatrixStudyView; onBack?: () => void }) {
  const act = useMatrixAction();
  const flow = useContext(MatrixFlowContext);
  const id = s.id, st = s.state;
  const running = ['queued', 'running', 'finalizing'].includes(s.status);
  const backFn = onBack ?? flow?.onBack;
  const back = backFn ? (e: React.MouseEvent) => { e.preventDefault(); backFn(); } : undefined;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <a href="#matrix-study" onClick={back} className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" />{flow ? t('海选') : t('批量验证')}</a>
        <h2 className="text-[15px] font-medium">{shortSyms(s.manifest.spec.symbols)} — {s.manifest.spec.timeframes.map((tf) => `${tf}(${TF_HORIZON[tf]})`).join(' / ')}</h2>
        <span className="rounded-full border px-2 py-0.5 text-[11px]">{STATUS_TEXT[s.status] ?? s.status}{running ? ` · ${STAGE_TEXT[st.stage] ?? st.stage}` : ''}</span>
        {running ? <Button size="xs" variant="outline" className="ml-auto gap-1" disabled={act.cancel.isPending} onClick={() => act.cancel.mutate(id)}><Square className="size-3" />{t('取消')}</Button> : null}
      </div>
      {!flow ? <DivisionNote here="matrix" /> : null}
      {st.conclusion ? <Conclusion s={s} onBack={back} /> : null}
      <Progress s={s} running={running} />
      <ResultMap s={s} />
      <JudgeEffect s={s} />
      <TopVsHold s={s} />
      {st.finalists.length ? <Finalists s={s} finalize={() => act.finalize.mutate({ id, manifest_hash: s.manifest_hash }, { onError: (e) => toast.error((e as Error).message) })} finalizing={act.finalize.isPending} /> : null}
      {st.generations.length ? (flow ? (
        <details className="group/legacy rounded-lg border p-2.5 text-[12px]" data-testid="legacy-iterations">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3.5 transition-transform group-open/legacy:rotate-90" />{t('旧版迭代记录(历史研究)')}<span className="text-[11px]">{t('· 海选不再自动迭代,改规则请到精修')}</span>
          </summary>
          <div className="mt-2"><Timeline s={s} /></div>
        </details>
      ) : <Timeline s={s} />) : null}
    </>
  );
}

/** 顶部结论卡:结论只说一次;没通过就给主因白话 + 下一步 */
function Conclusion({ s, onBack }: { s: MatrixStudyView; onBack?: (e: React.MouseEvent) => void }) {
  const flow = useContext(MatrixFlowContext);
  const c = s.state.conclusion!;
  const passed = c.kind === 'passed';
  const head = conclusionHead(c);
  const main = mainCause(c.causes);
  const total = Object.values(c.causes).reduce((a, b) => a + b, 0);
  const others = (Object.entries(c.causes) as [FailureCause, number][]).filter(([k, n]) => n > 0 && k !== main);
  const replay = (s.manifest.spec['protocol'] as { evidence_mode?: string } | undefined)?.evidence_mode === 'historical_replay';
  // notes 去重;resume → queued 这类过程事件不放结论区,进「技术信息」
  const { notes } = splitNotes(s.state.notes);
  return (
    <section className={cn('rounded-lg border p-3 text-[12.5px]', head.tone === 'pass' ? 'border-up/40 bg-up/5' : head.tone === 'candidate' ? 'border-primary/40 bg-primary/5' : 'bg-muted/30')}>
      <div className="text-[14px] font-medium">{head.title}</div>
      <p className="mt-0.5 text-muted-foreground">{head.sub}</p>
      {main && !passed ? (
        <div className="mt-2 rounded-md border bg-background/60 px-2.5 py-2">
          <div><span className="font-medium">{t('主要原因')}:{causePlain(main).title}</span> — {causePlain(main).detail}<span className="num text-muted-foreground">{t('({n}/{total} 组)', { n: c.causes[main], total })}</span></div>
          {others.length || c.not_applicable || c.research_only ? (
            <div className="mt-0.5 text-[11.5px] text-muted-foreground">
              {[...others.map(([k, n]) => t('{what} {n} 组', { what: CAUSE_TEXT[k], n })), c.not_applicable ? t('不适用 {n} 组', { n: c.not_applicable }) : null, c.research_only ? t('只研究 {n} 组', { n: c.research_only }) : null].filter(Boolean).join(' · ')}
            </div>
          ) : null}
          <div className="mt-2 flex items-start gap-1.5">
            <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-primary" />
            <div className="min-w-0">
              <div className="font-medium">{t('下一步可以试试')}</div>
              <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
                {head.tone === 'candidate' ? <li>{t('先把评分最高的几组存为候补策略,在我的策略里用模拟盘跑一段,看前向表现')}</li> : null}
                {nextSteps(main).map((x) => <li key={x}>{x}</li>)}
              </ul>
              <a href="#matrix-study" onClick={onBack} className="mt-1 inline-flex items-center gap-0.5 text-primary hover:underline">{flow ? t('换个设置再海选一次') : t('换个设置再验证一次')}<ChevronRight className="size-3" /></a>
            </div>
          </div>
        </div>
      ) : null}
      {replay ? <p className="mt-2 text-[11.5px] text-muted-foreground">{t('注意:这段历史之前有人看过,结果只能算回放参考;真上实盘前,还要再往后跑一段验证。')}</p> : null}
      {notes.length ? <ul className="mt-1 space-y-0.5 text-[11.5px] text-muted-foreground">{notes.map((n) => <li key={n}>{serverText(n)}</li>)}</ul> : null}
      <Fold label={t('系统原话')}><p className="text-muted-foreground">{serverText(c.text)}</p></Fold>
    </section>
  );
}

/** 进度与花费:跑的时候显示进度条;说明文字在出结论后就不再重复 */
function Progress({ s, running }: { s: MatrixStudyView; running: boolean }) {
  const st = s.state, p = st.progress, u = st.usage;
  const released = st.holdout_state === 'released';
  return (
    <div className="rounded-lg border p-2.5 text-[12px]">
      {running || !st.conclusion ? (
        <>
          <div className="mb-1 flex flex-wrap gap-x-4 gap-y-1">
            <span>{STAGE_TEXT[st.stage] ?? st.stage}</span>
            {p.note && !st.conclusion ? <span className="text-muted-foreground">{p.note}</span> : null}
            <span className="num text-muted-foreground">{p.done}/{p.total}{p.eta_ms != null && running ? ` · ${t('还要约 {m} 分钟', { m: Math.max(1, Math.ceil(p.eta_ms / 60000)) })}` : ''}</span>
          </div>
          <div className="mb-1.5 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${p.total ? Math.min(100, (100 * p.done) / p.total) : 0}%` }} /></div>
        </>
      ) : null}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        {s.manifest.spec.arms.includes('code_judge') ? <span className="num">{t('Jev 判断 {n} 次,花了 ${usd}', { n: u.judge_calls, usd: u.judge_usd })}{u.judge_unknown_cost_calls ? ` · ${t('{n} 次花费未知', { n: u.judge_unknown_cost_calls })}` : ''}</span> : <span>{t('没用 Jev,不花模型的钱')}</span>}
        {u.wall_ms ? <span className="num">{t('用时 {m} 分钟', { m: Math.max(1, Math.round(u.wall_ms / 60000)) })}</span> : null}
        {s.ledger ? <span className="num" title={t('每试一个新版本都记一次账;试得越多,通过的门槛越高,防止碰巧好看')}>{t('一共试了 {n} 个版本,都记了账', { n: s.ledger.trial_count })}</span> : null}
        <span className="inline-flex items-center gap-1">{released ? <Unlock className="size-3" /> : <Lock className="size-3" />}{released ? t('最终验收已做') : t('最终验收还没做')} · {s.auto_finalize ? t('自动验收一次') : t('我手动验收')}</span>
      </div>
      {st.error ? <p className="mt-1 text-destructive">{st.error}</p> : null}
      {st.stop_reason ? <p className="mt-1 text-muted-foreground">{t('提前停了:{r}', { r: st.stop_reason })}</p> : null}
      <Fold label={t('技术信息')}>
        <div className="num space-y-0.5 text-[11px] text-muted-foreground">
          <div>id {s.id}</div>
          <div>manifest {s.manifest_hash}</div>
          {s.ledger ? <div>attempts {s.ledger.attempt_count} · trials {s.ledger.trial_count} · effective {s.ledger.effective_trials.conservative}</div> : null}
          {splitNotes(st.notes).tech.map((n) => <div key={n}>{serverText(n)}</div>)}
        </div>
      </Fold>
    </div>
  );
}

const TONE_CLS: Record<MapTone, string> = {
  pass: 'border-up/50 bg-up/25 text-up',
  candidate: 'border-primary/60 bg-primary/15 text-primary',
  waiting: 'border-up/40 bg-up/10 text-up',
  near: 'border-warn/50 bg-warn/20 text-warn',
  fail: 'border-down/30 bg-down/10 text-down',
  na: 'border-dashed bg-transparent text-muted-foreground/60',
  pending: 'border-dashed bg-muted/40 text-muted-foreground',
  untested: 'border-dotted bg-transparent text-muted-foreground/80',
};
const TONE_TEXT: Record<MapTone, string> = { pass: '通过', candidate: '候补 · 可纸面观察', waiting: '等最终验收', near: '接近', fail: '未通过', na: '不适用', pending: '还在跑', untested: '未测 Jev' };

/** 结果地图:行 = 资产 · 周期,列 = 策略;每格里按方向(行)× 比较方式(列)再分小格 */
function ResultMap({ s }: { s: MatrixStudyView }) {
  const cells = s.manifest.cells;
  const [open, setOpen] = useState<string | null>(null);
  const openDef = open ? cells.find((c) => c.id === open) ?? null : null;
  const rows = useMemo(() => [...new Set(cells.map((c) => `${c.symbol}|${c.timeframe}`))], [cells]);
  const fams = useMemo(() => [...new Set(cells.map((c) => c.family))], [cells]);
  const sides = useMemo(() => (['long', 'short'] as const).filter((x) => cells.some((c) => c.side === x)), [cells]);
  const arms = useMemo(() => (['code', 'code_judge'] as MatrixArm[]).filter((x) => cells.some((c) => c.arm === x)), [cells]);
  const byKey = useMemo(() => new Map(cells.map((c) => [`${c.symbol}|${c.timeframe}|${c.family}|${c.side}|${c.arm}`, c])), [cells]);
  if (!cells.length) return null;
  const layout = [sides.length > 1 ? t('上行做多、下行做空') : sideText(sides[0] ?? 'long'), arms.length > 1 ? t('左边纯代码、右边代码 + Jev 判断') : ARM_TEXT[arms[0] ?? 'code']].join(';');
  const stageNote = judgeStageNote(s);
  const legend: MapTone[] = cells.some((c) => s.state.cells[c.id]?.tier) ? ['pass', 'candidate', 'waiting', 'fail', 'na'] : ['pass', 'near', 'fail', 'na'];
  if (cells.some((c) => mapTone(c.applicability, s.state.cells[c.id]) === 'untested')) legend.push('untested');
  return (
    <section className="rounded-lg border p-2.5">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[13px] font-medium">{t('结果地图')}</h3>
        <span className="text-[11px] text-muted-foreground">{t('每一格是一种组合,格子里的数是选择段(用来挑候选的那段历史)的收益;鼠标放上去看评分,点开看完整评分卡。')} {t('小格排法:{x}', { x: layout })}</span>
        {stageNote ? <span className="text-[11px] text-primary" data-testid="judge-stage-note">{stageNote}</span> : null}
        <span className="ml-auto flex flex-wrap gap-2 text-[11px]">
          {legend.map((k) => <span key={k} className="inline-flex items-center gap-1"><span className={cn('inline-block size-3 rounded-sm border', TONE_CLS[k])} />{t(TONE_TEXT[k])}</span>)}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-1 text-left text-[12px]">
          <thead><tr className="text-[11px] text-muted-foreground">
            <th className="px-1 font-normal">{t('资产 · 周期')}</th>
            {fams.map((f) => <th key={f} className={cn('px-1 font-normal', parseMyFamily(f) && 'text-primary')} title={parseMyFamily(f) ? t('我的策略') : undefined}>{familyLabel(f, s.my_strategies)}</th>)}
          </tr></thead>
          <tbody>
            {rows.map((row) => {
              const [sym, tf] = row.split('|') as [string, string];
              return (
                <tr key={row}>
                  <td className="whitespace-nowrap px-1"><span className="num font-medium">{sym.replace(/USDT$/, '')}</span> <span className="text-muted-foreground">{tf}</span></td>
                  {fams.map((f) => (
                    <td key={f} className="p-0 align-top">
                      <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${arms.length}, minmax(3rem, 1fr))` }}>
                        {sides.flatMap((side) => arms.map((arm) => {
                          const def = byKey.get(`${sym}|${tf}|${f}|${side}|${arm}`);
                          if (!def) return <div key={`${side}${arm}`} />;
                          return <MapSquare key={`${side}${arm}`} def={def} r={s.state.cells[def.id]} s={s} onOpen={() => setOpen(def.id)} />;
                        }))}
                      </div>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Sheet open={!!openDef} onOpenChange={(v) => { if (!v) setOpen(null); }}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader className="sr-only"><SheetTitle>{openDef ? cellName(openDef, s) : t('结果地图')}</SheetTitle><SheetDescription>{t('评分卡')}</SheetDescription></SheetHeader>
          {openDef ? <CellDrawer def={openDef} r={s.state.cells[openDef.id]} s={s} /> : null}
        </SheetContent>
      </Sheet>
    </section>
  );
}

function MapSquare({ def, r, s, onOpen }: { def: MatrixCellDef; r: CellResult | undefined; s: MatrixStudyView; onOpen?: () => void }) {
  const tone = mapTone(def.applicability, r);
  const x = r?.scorecard?.metrics.total_return ?? r?.selection?.total_return;
  const box = (
    <button type="button" data-tone={tone} disabled={tone === 'na' || tone === 'pending' || tone === 'untested'} onClick={onOpen} className={cn('num flex h-7 w-full items-center justify-center rounded border px-1 text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-primary enabled:cursor-pointer enabled:hover:brightness-110', TONE_CLS[tone])}>
      {tone === 'na' ? '—' : tone === 'untested' ? <span className="whitespace-nowrap text-[10px]">{t('未测 Jev')}</span> : x != null ? signed(x) : '…'}
    </button>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{box}</TooltipTrigger>
      <TooltipContent className="max-w-80">
        <div className="space-y-0.5 text-[11px]">
          <div className="font-medium">{cellName(def, s)} · {ARM_TEXT[def.arm]}</div>
          <div>{t('结果')}:{t(TONE_TEXT[tone])}{r?.scorecard ? ` · ${t('评分')} ${r.scorecard.score.value}(${scoreLabelText(r.scorecard.score.label)})` : ''}</div>
          {tone === 'na' ? <div>{naReason(def.reason)}</div> : tone === 'untested' ? <div>{r?.judge_stage === 'pending' ? t('两段式:纯代码还在跑,候补定下来后才决定这格要不要补跑 Jev') : t('两段式:这一格的纯代码没进候补,没有补跑 Jev(不是不适用)')}</div> : r ? <CellFacts r={r} /> : null}
          {r?.scorecard ? <div className="text-muted-foreground">{serverText(r.scorecard.luck.text)}</div> : null}
          {tone !== 'na' && tone !== 'pending' && tone !== 'untested' ? <div className="text-muted-foreground">{t('点开看完整评分卡')}</div> : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function CellFacts({ r }: { r: CellResult }) {
  const x = r.selection;
  const failed = r.gates.filter((g) => !g.ok);
  const jd = r.judge_delta;
  return (
    <>
      <div>{t('交易笔数')} {x ? x.trades : '—'} · {t('选择段收益')} {signed(x?.total_return)}{x?.hold_return != null ? `(${t('同期持有')} ${signed(x.hold_return)})` : ''}</div>
      {r.tier === 'paper_candidate' ? <div className="text-primary">{t('只差')}:{(r.tier_reasons ?? []).map(serverText).join(t(';'))}</div> : r.cause ? <div>{t('主因')}:{causePlain(r.cause).title} — {causePlain(r.cause).detail}</div> : null}
      {failed.length ? <div className="text-muted-foreground">{t('没过的门槛')}:{failed.slice(0, 4).map((g) => gatePlain(g.name) + (g.name.startsWith('selection_trades') && g.value != null ? t('(实际 {n})', { n: g.value }) : '')).join(listSep())}</div> : null}
      {jd?.all_skipped ? <div className="text-warn">{t('Jev 把信号全跳过了,没法比')}</div> : jd?.error_ratio != null && jd.error_ratio > 0.5 ? <div className="text-destructive">{t('Jev 判断出错太多({p}),没法比', { p: pct(jd.error_ratio, 0) })}</div>
        : jd?.kept_ratio != null ? <div>{t('Jev 放行了 {p} 的信号', { p: pct(jd.kept_ratio, 0) })}</div> : null}
    </>
  );
}

/** 点开一格:评分卡指标表、运气折扣、存为候补策略、在研究台继续打磨 */
export function CellDrawer({ def, r, s }: { def: MatrixCellDef; r: CellResult | undefined; s: MatrixStudyView }) {
  const act = useMatrixAction();
  const flow = useContext(MatrixFlowContext);
  const [saved, setSaved] = useState<CandidateAdoptResult | null>(null);
  const tone = mapTone(def.applicability, r);
  const card = r?.scorecard ?? null, m = card?.metrics;
  const trial = r?.tier_trial_id ?? r?.best_trial_id ?? null;
  const prior = trial ? s.candidate_adoptions?.[trial] : undefined;
  const done = saved ?? (prior ? { strategy_id: prior.strategy_id, version: prior.version, next: { link: `#my-strategies?id=${encodeURIComponent(prior.strategy_id)}`, text: t('去我的策略里用模拟盘跑起来') } } : null);
  const can = canAdoptCandidate(s, r);
  const adopt = () => trial && act.adoptCandidate.mutate({ id: s.id, trial_id: trial }, {
    onSuccess: (x) => { setSaved(x); toast.success(t('已存为候补策略 v{v}:去我的策略里用模拟盘跑起来', { v: x.version })); x.preflight?.warnings.slice(0, 2).forEach((w) => toast.warning(w.message)); },
    onError: (e) => toast.error((e as Error).message),
  });
  const rows: [string, string][] = m ? [
    [t('选择段收益'), signed(m.total_return)], [t('同期持有'), signed(m.hold_return)], [t('同等仓位持有'), signed(m.exposure_matched_hold)],
    [t('最大回撤'), pct(m.max_drawdown)], [t('夏普'), m.sharpe == null ? '—' : m.sharpe.toFixed(2)], [t('胜率'), pct(m.win_rate, 0)],
    [t('交易笔数'), String(m.trades)], [t('盈亏比'), m.profit_factor == null ? '—' : m.profit_factor.toFixed(2)], [t('每笔期望'), signed(m.expectancy, 2)],
    [t('手续费占毛收益'), pct(m.fee_share, 0)], [t('手续费翻倍后'), signed(m.stressed_return)],
    [t('训练段收益'), card?.train ? `${signed(card.train.total_return)} · ${t('{n} 笔', { n: card.train.trades })}` : '—'],
  ] : [];
  return (
    <div className="flex flex-col gap-3 p-4 text-[12.5px]" data-testid="cell-drawer">
      <div>
        <div className="pr-6 text-[14px] font-medium">{cellName(def, s)} · {ARM_TEXT[def.arm]}</div>
        <div className="mt-0.5 text-[12px] text-muted-foreground">
          <span className={cn('mr-1.5 inline-block rounded border px-1.5 text-[11px]', TONE_CLS[tone])}>{t(TONE_TEXT[tone])}</span>
          {(r?.tier_reasons ?? []).map(serverText).join(t(';'))}
        </div>
      </div>
      {card ? (
        <>
          <div className="flex items-baseline gap-2">
            <span className="num text-[22px] font-semibold">{card.score.value}</span>
            <span>{scoreLabelText(card.score.label)}</span>
            <span className="text-[11px] text-muted-foreground">{t('和研究台 / 我的策略同一套评分;只看训练段和选择段')}</span>
          </div>
          <table className="w-full text-[12px]"><tbody>
            {rows.map(([k, v]) => <tr key={k} className="border-b last:border-0"><td className="py-1 text-muted-foreground">{k}</td><td className="num py-1 text-right">{v}</td></tr>)}
          </tbody></table>
          <div className="rounded-md border bg-muted/30 p-2">
            <div className="font-medium">{t('运气折扣')}</div>
            <p className="mt-0.5 text-muted-foreground">{serverText(card.luck.text)}</p>
          </div>
          <Fold label={t('评分怎么算的')}>
            <ul className="space-y-0.5 text-[11px] text-muted-foreground">{card.score.components.map((c) => <li key={c.key}><span className="num">{Math.round(c.value)}</span> × {Math.round(c.weight * 100)}% · {c.note}</li>)}</ul>
            {card.notes.map((n) => <p key={n} className="mt-1 text-[11px] text-muted-foreground">{serverText(n)}</p>)}
          </Fold>
        </>
      ) : <p className="text-muted-foreground">{t('这一格没有评分卡(旧研究或还没有成绩)')}</p>}
      <div className="flex flex-col gap-1.5">
        {done ? (
          <div className="rounded-md border border-primary/40 bg-primary/5 p-2">
            <div>{t('已存为候补策略 v{v}(未经最终验收)', { v: done.version })}</div>
            {flow ? (
              <button type="button" className="mt-0.5 inline-flex items-center gap-1 text-primary hover:underline" onClick={() => flow.onValidate(done.strategy_id)}><PlayCircle className="size-3.5" />{t('去验收这一条')}</button>
            ) : (
              <a className="mt-0.5 inline-flex items-center gap-1 text-primary hover:underline" href={done.next.link}><PlayCircle className="size-3.5" />{t('去我的策略里用模拟盘跑起来')}</a>
            )}
          </div>
        ) : can ? (
          <Button size="sm" className="gap-1" disabled={act.adoptCandidate.isPending} onClick={adopt} title={t('没做最终验收,只建议先用模拟盘跑前向')}>
            {act.adoptCandidate.isPending ? t('保存中…') : t('存为候补策略')}
          </Button>
        ) : tone === 'pass' || tone === 'waiting' ? <p className="text-[11.5px] text-muted-foreground">{t('这一组在「最终候选」里,从那里存')}</p> : null}
        {trial && tone !== 'na' ? (flow ? (
          <Button size="sm" variant="outline" className="gap-1" data-testid="refine-this" onClick={() => flow.onRefine(s.id, trial)}><FlaskConical className="size-3.5" />{t('精修这一组')}</Button>
        ) : (
          <a href={researchLink(s.id, trial)} className="inline-flex items-center justify-center gap-1 rounded-md border px-3 py-1.5 hover:bg-muted"><FlaskConical className="size-3.5" />{t('在研究台继续打磨')}</a>
        )) : null}
      </div>
    </div>
  );
}

/** Jev 判断的效果:没有「代码 + Jev 判断」组就整块不显示 */
function JudgeEffect({ s }: { s: MatrixStudyView }) {
  const rows = useMemo(() => judgeRows(s), [s]);
  const stageNote = judgeStageNote(s);
  if (!s.manifest.spec.arms.includes('code_judge')) return null;
  if (!rows.length) {
    // 两段式还没补跑(或没有格子入选)时也说一句,免得以为 Jev 没跑是出错了
    return stageNote ? (
      <section className="rounded-lg border p-2.5 text-[12px]">
        <h3 className="text-[13px] font-medium">{t('Jev 判断的效果')}</h3>
        <p className="mt-0.5 text-[11.5px] text-primary" data-testid="judge-stage-note">{stageNote}</p>
      </section>
    ) : null;
  }
  const usable = rows.filter((r) => r.usable);
  const D = Math.max(1e-6, ...usable.flatMap((r) => [Math.abs(r.delta.mean_daily ?? 0), ...(r.delta.ci95 ?? []).map(Math.abs)]));
  const x = (v: number) => `${50 + (50 * v) / D}%`;
  const count = (tone: JudgeRow['tone']) => usable.filter((r) => r.tone === tone).length;
  const u = s.state.usage;
  return (
    <section className="rounded-lg border p-2.5 text-[12px]">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[13px] font-medium">{t('Jev 判断的效果')}</h3>
        <span className="text-[11px] text-muted-foreground">{t('Jev 一共判断 {n} 次,花了 ${usd}', { n: u.judge_calls, usd: u.judge_usd })}</span>
        {stageNote ? <span className="text-[11px] text-primary" data-testid="judge-stage-note">{stageNote}</span> : null}
      </div>
      <p className="mb-2 text-[11.5px] text-muted-foreground">
        {t('每一行是同一个组合:「代码 + Jev 判断」比「纯代码」每天多赚(往右)还是少赚(往左)。点是平均差,横线是 95% 的可能范围;横线跨过中线,就说明还看不出 Jev 有没有用。')}
        {usable.length ? ' ' + t('这次:{a} 组有帮助,{b} 组帮倒忙,{c} 组看不出差别。', { a: count('up'), b: count('down'), c: count('flat') }) : ''}
      </p>
      <div className="grid grid-cols-[minmax(8rem,14rem)_1fr_5.5rem] items-center gap-x-3 gap-y-1">
        <span className="text-[10.5px] text-muted-foreground">{t('哪一组')}</span>
        <div className="flex justify-between text-[10.5px] text-muted-foreground"><span>{t('少赚')} {signed(-D, 3)}{t('/天')}</span><span>0</span><span>{t('多赚')} {signed(D, 3)}{t('/天')}</span></div>
        <span className="text-[10.5px] text-muted-foreground">{t('Jev 放行比例')}</span>
        {rows.map((r) => (
          <JudgeRowView key={r.cell.id} r={r} name={cellName(r.cell, s)} x={x} />
        ))}
      </div>
    </section>
  );
}

function JudgeRowView({ r, name, x }: { r: JudgeRow; name: string; x: (v: number) => string }) {
  const d = r.delta;
  const color = r.tone === 'up' ? 'bg-up' : r.tone === 'down' ? 'bg-down' : 'bg-muted-foreground';
  return (
    <>
      <span className="truncate" title={name}>{name}</span>
      {r.usable ? (
        <div className="relative h-5" title={`${signed(d.mean_daily, 3)}${t('/天')}${d.ci95 ? ` [${signed(d.ci95[0], 3)}, ${signed(d.ci95[1], 3)}]` : ''}`}>
          <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
          {d.ci95 ? <div className={cn('absolute top-1/2 h-0.5 -translate-y-1/2 rounded-full opacity-60', color)} style={{ left: x(Math.min(d.ci95[0], d.ci95[1])), width: `calc(${x(Math.max(d.ci95[0], d.ci95[1]))} - ${x(Math.min(d.ci95[0], d.ci95[1]))})` }} /> : null}
          <div className={cn('absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background', color)} style={{ left: x(d.mean_daily ?? 0) }} />
        </div>
      ) : (
        <span className="text-[11px] text-muted-foreground">{d.all_skipped ? t('Jev 把信号全跳过了,没法比') : t('Jev 判断出错太多({p}),没法比', { p: pct(d.error_ratio ?? null, 0) })}</span>
      )}
      <div className="flex items-center gap-1.5">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary/70" style={{ width: `${Math.round((d.kept_ratio ?? 0) * 100)}%` }} /></div>
        <span className="num w-8 text-right text-[11px]">{d.kept_ratio == null ? '—' : pct(d.kept_ratio, 0)}</span>
      </div>
    </>
  );
}

/** 收益最高的几组 vs 同期持有(选择段的最终收益;视图里没有逐日净值,不画曲线) */
function TopVsHold({ s }: { s: MatrixStudyView }) {
  const top = useMemo(() => topCells(s, 5), [s]);
  if (!top.length) return null;
  const vals = top.flatMap(({ r }) => [r.selection!.total_return, r.selection!.hold_return, r.selection!.exposure_matched_hold]).filter((v): v is number => v != null);
  const D = Math.max(1e-6, ...vals.map(Math.abs));
  const bar = (v: number | null, cls: string, label: string) => v == null ? null : (
    <div className="relative h-2" title={`${label} ${signed(v)}`}>
      <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
      <div className={cn('absolute inset-y-0 rounded-sm', cls)} style={v >= 0 ? { left: '50%', width: `${(50 * v) / D}%` } : { right: '50%', width: `${(50 * -v) / D}%` }} />
    </div>
  );
  return (
    <section className="rounded-lg border p-2.5 text-[12px]">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[13px] font-medium">{t('收益最高的几组,和同期拿着不动比')}</h3>
        <span className="ml-auto flex flex-wrap gap-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-primary" />{t('策略')}</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-muted-foreground/50" />{t('同期持有')}</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-muted-foreground/25" />{t('同等仓位持有')}</span>
        </span>
      </div>
      <p className="mb-2 text-[11.5px] text-muted-foreground">{t('都是选择段的最终收益。「同等仓位持有」按策略平均仓位折算,策略大部分时间空仓时,和它比更公平。')}</p>
      <div className="grid grid-cols-[minmax(8rem,14rem)_1fr_7rem] items-center gap-x-3 gap-y-2">
        {top.map(({ cell, r }) => {
          const x = r.selection!;
          return (
            <div key={cell.id} className="contents">
              <span className="truncate" title={cellName(cell, s)}>{cellName(cell, s)}<span className="text-muted-foreground"> · {ARM_TEXT[cell.arm]}</span></span>
              <div className="space-y-0.5">
                {bar(x.total_return, x.total_return >= 0 ? 'bg-primary' : 'bg-down/70', t('策略'))}
                {bar(x.hold_return, 'bg-muted-foreground/50', t('同期持有'))}
                {bar(x.exposure_matched_hold, 'bg-muted-foreground/25', t('同等仓位持有'))}
              </div>
              <span className="num text-right text-[11px]"><span className={x.total_return >= 0 ? 'text-up' : 'text-down'}>{signed(x.total_return)}</span> · {t('{n} 笔', { n: x.trades })}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Score({ label, x }: { label: string; x: SlimScore | null }) {
  return <div><span className="text-muted-foreground">{label}</span> {x ? `${signed(x.total_return)} · ${t('{n} 笔', { n: x.trades })} · ${t('最大回撤')} ${pct(x.max_drawdown)}` : '—'}</div>;
}

function Finalists({ s, finalize, finalizing }: { s: MatrixStudyView; finalize: () => void; finalizing: boolean }) {
  const act = useMatrixAction();
  const flow = useContext(MatrixFlowContext);
  const setAgent = useSetAgentStrategy();
  const [local, setLocal] = useState<Record<string, { strategy_id: string; version: number }>>({});
  const adopted = { ...s.adoptions, ...local };
  const released = s.state.holdout_state === 'released';
  const adopt = (f: MatrixFinalist) => act.adopt.mutate({ id: s.id, finalist_id: f.id }, {
    onSuccess: (r) => {
      setLocal((m) => ({ ...m, [f.id]: r }));
      toast.success(parseMyFamily(f.family) ? t('已存为「{name}」的新版本 v{v}', { name: familyLabel(f.family, s.my_strategies).replace(/ v\d+$/, ''), v: r.version }) : t('已存成我的策略 v{v}', { v: r.version }));
      r.preflight?.warnings.slice(0, 2).forEach((w) => toast.warning(w.message));
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <section className="rounded-lg border p-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <h3 className="text-[13px] font-medium">{t('最终候选')}</h3>
        {!released && s.status === 'ready_to_finalize' ? (
          <Button size="xs" className="ml-auto gap-1" disabled={finalizing} onClick={finalize} title={t('没看过的那段历史只能用一次;验收后这批候选不能再改')}>
            <Unlock className="size-3" />{finalizing ? t('验收中…') : t('开始最终验收')}
          </Button>
        ) : null}
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {s.state.finalists.map((f) => (
          <div key={f.id} className={cn('rounded-md border p-2 text-[12px]', f.passed === true && 'border-up/40', f.passed === false && 'opacity-80')}>
            <div className="mb-1 flex items-center gap-1.5">
              <span className="num font-medium">{f.symbol.replace(/USDT$/, '')}</span>
              <span>{f.timeframe} · {TF_HORIZON[f.timeframe]}</span>
              <span>{familyLabel(f.family, s.my_strategies)}</span>
              <span className="rounded-full border px-1.5 text-[10px]">{ARM_TEXT[f.arm]}</span>
              {f.passed === true ? <span className="ml-auto text-up">{t('通过')}</span> : f.passed === false ? <span className="ml-auto text-muted-foreground">{f.cause ? CAUSE_TEXT[f.cause] : t('未通过')}</span> : null}
            </div>
            <Score label={t('选择段')} x={f.selection} />
            {released ? <Score label={t('验收段')} x={f.holdout} /> : <div className="text-muted-foreground"><Lock className="mr-1 inline size-3" />{t('还没做最终验收')}</div>}
            {f.portfolio ? (
              <div className="mt-1 rounded bg-muted/40 px-1.5 py-1">
                <span className="text-muted-foreground">{t('按真实账户规则回放')}</span> {signed(f.portfolio.total_return)} · {t('最大回撤')} {pct(f.portfolio.max_drawdown)} · {t('{n} 笔', { n: f.portfolio.trades })} · {t('Jev 跳过 {n}', { n: f.portfolio.skipped_by_judge })} · {t('仓位满跳过 {n}', { n: f.portfolio.skipped_by_capacity })}
              </div>
            ) : null}
            {f.test ? <Fold label={t('统计细节')}><div className="num text-[11px] text-muted-foreground">p={f.test.p_value?.toFixed(3) ?? '—'} · Holm {f.test.holm_threshold?.toFixed(3) ?? '—'} · DSR {f.dsr?.toFixed(2) ?? '—'} · {f.id}</div></Fold> : null}
            <div className="mt-1.5 flex gap-1.5">
              {adopted[f.id] ? (
                <>
                  <a className="text-[11px] text-primary hover:underline" href={`#my-strategies?id=${encodeURIComponent(adopted[f.id]!.strategy_id)}`}>{t('打开策略')}</a>
                  {flow ? <button type="button" className="text-[11px] text-primary hover:underline" onClick={() => flow.onValidate(adopted[f.id]!.strategy_id)}>{t('去验收')}</button> : null}
                  <Button size="xs" className="ml-auto gap-1" disabled={setAgent.isPending} onClick={() => setAgent.mutate({ kind: 'strategy', strategy_id: adopted[f.id]!.strategy_id, version: adopted[f.id]!.version, mode: 'agent' }, { onSuccess: () => toast.success(t('agent 已切到这条策略')), onError: (e) => toast.error((e as Error).message) })}>
                    <Sparkles className="size-3" />{t('设为 agent 当前策略')}
                  </Button>
                </>
              ) : (
                <Button size="xs" variant="outline" className="ml-auto" disabled={!released || f.passed !== true || act.adopt.isPending} title={!released ? t('先做最终验收') : f.passed !== true ? t('最终验收没通过的候选不能存') : undefined} onClick={() => adopt(f)}>
                  {parseMyFamily(f.family) ? t('存为这条策略的新版本') : t('存成我的策略')}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
      {!released ? <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground"><TriangleAlert className="size-3" />{s.auto_finalize ? t('候选是用选择段挑出来的;定下来后会自动拿没看过的那段历史考一次,只看那一次的结果') : t('候选是用选择段挑出来的;真正的结论只看最终验收那一次')}</p> : null}
    </section>
  );
}

/** 自动诊断改进的时间线:按组合分组、默认只展开第一组;每代三行白话,原文进「详情」 */
function Timeline({ s }: { s: MatrixStudyView }) {
  const groups = useMemo(() => groupGenerations(s.state.generations), [s.state.generations]);
  const defs = useMemo(() => new Map(s.manifest.cells.map((c) => [c.id, c])), [s.manifest.cells]);
  return (
    <section className="rounded-lg border p-2.5 text-[12px]">
      <h3 className="text-[13px] font-medium">{t('自动诊断改进的过程')}</h3>
      <p className="mb-2 text-[11.5px] text-muted-foreground">{t('没通过的组合,系统会自动找原因、改一处再重跑;比上一版好才留下,接着改。')}</p>
      <div className="space-y-1.5">
        {groups.map((g, i) => {
          const def = defs.get(g.cell_id);
          const last = [...g.gens].reverse().find((x) => x.promoted && x.selection)?.selection ?? null;
          return (
            <details key={g.cell_id} open={i === 0} className="group/tl rounded-md border">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 hover:bg-muted/40">
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/tl:rotate-90" />
                <span className="min-w-0 flex-1 truncate font-medium">{def ? `${cellName(def, s)} · ${ARM_TEXT[def.arm]}` : g.cell_id}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{t('改了 {n} 代', { n: g.gens.length })}{last ? ` · ${t('最好一版 {r}', { r: signed(last.total_return) })}` : ` · ${t('没改好')}`}</span>
              </summary>
              <ol className="ml-3.5 space-y-2 border-l py-2 pr-2 pl-3">
                {g.gens.map((gen) => <GenerationItem key={`${gen.n}-${gen.trial_id ?? ''}`} g={gen} />)}
              </ol>
            </details>
          );
        })}
      </div>
    </section>
  );
}

function GenerationItem({ g }: { g: MatrixGeneration }) {
  const found = parseDiagnosis(g.diagnosis);
  const ch = plainChange(g.change);
  return (
    <li className="relative">
      <span className={cn('absolute top-1 -left-[1.1rem] size-2 rounded-full ring-2 ring-background', g.promoted ? 'bg-up' : 'bg-muted-foreground/50')} />
      <div className="num text-[11px] text-muted-foreground">{t('第 {n} 代', { n: g.n })}</div>
      <div><span className="text-muted-foreground">{t('发现')}:</span>{found.map((x) => x.title).join(listSep()) || '—'}</div>
      <div><span className="text-muted-foreground">{t('改了')}:</span>{ch.how ? <span className="mr-1 rounded border px-1 text-[10.5px] text-muted-foreground">{ch.how}</span> : null}{ch.text}</div>
      <div><span className="text-muted-foreground">{t('结果')}:</span>{g.selection ? `${t('选择段收益')} ${signed(g.selection.total_return)} · ${t('{n} 笔', { n: g.selection.trades })} — ` : ''}<span className={g.promoted ? 'text-up' : 'text-muted-foreground'}>{g.promoted ? t('比上一版好,留下来接着改') : g.selection ? t('没比上一版好,没采用') : t('这一代没有新版本')}</span></div>
      <Fold label={t('详情')}>
        <div className="space-y-1 text-[11px] text-muted-foreground">
          {found.map((x, i) => <div key={i}><span className="text-foreground/80">{x.title}</span>{x.code ? <span className="num"> ({x.code})</span> : null}:{x.text}</div>)}
          <div><span className="text-foreground/80">{t('改法原文')}</span>:{g.change}</div>
          {g.note ? <div>{g.note}</div> : null}
          <div className="num">{[g.parent_trial_id ? `parent ${g.parent_trial_id}` : null, g.trial_id ? `trial ${g.trial_id}` : null, g.generator ? `generator ${g.generator}` : null].filter(Boolean).join(' · ')}</div>
        </div>
      </Fold>
    </li>
  );
}

/** 小折叠:技术字段 / 原文都放这里 */
function Fold({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="group/fold mt-1">
      <summary className="inline-flex cursor-pointer list-none items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3 transition-transform group-open/fold:rotate-90" />{label}
      </summary>
      <div className="mt-1 pl-3.5">{children}</div>
    </details>
  );
}
