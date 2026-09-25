/**
 * 矩阵研究详情(§9.53 B):阶段与进度 → 矩阵(每格两臂)→ 迭代 → 结论 → 留出段一次释放 + 组合回测 → 存成我的策略 → 设为 agent 当前策略。
 * 「我的策略」格子(family = my:<strategy_id>@v<version>)存下来是那条策略的新版本,不是新策略。
 */
import { useMemo, useState } from 'react';
import { ArrowLeft, Lock, Square, Sparkles, TriangleAlert, Unlock } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSetAgentStrategy } from '@/api/agent-strategy';
import { useMatrixAction, useMatrixStudy, type CellResult, type FailureCause, type MatrixArm, type MatrixFinalist, type MatrixStudyView, type MatrixTimeframe, type SlimScore } from '@/api/matrix-study';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { ARM_TEXT, CAUSE_TEXT, STAGE_TEXT, STATUS_TEXT, TF_HORIZON, VERDICT_CLS, familyLabel, parseMyFamily, pct, shortSyms } from './shared';

export function MatrixStudyDetail({ id, onBack }: { id: string; onBack?: () => void }) {
  const q = useMatrixStudy(id);
  const act = useMatrixAction();
  if (q.isLoading) return <div className="h-40 animate-pulse rounded-lg border" />;
  if (q.isError || !q.data) return <p className="text-[13px] text-destructive">{t('读取研究失败')}:{(q.error as Error | null)?.message}</p>;
  const s = q.data, st = s.state, p = st.progress;
  const running = ['queued', 'running', 'finalizing'].includes(s.status);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <a href="#matrix-study" onClick={onBack ? (e) => { e.preventDefault(); onBack(); } : undefined} className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" />{t('矩阵研究')}</a>
        <h2 className="text-[15px] font-medium">{shortSyms(s.manifest.spec.symbols)} — {s.manifest.spec.timeframes.map((tf) => `${tf}(${TF_HORIZON[tf]})`).join(' / ')}</h2>
        <span className="rounded-full border px-2 py-0.5 text-[11px]">{STATUS_TEXT[s.status] ?? s.status} · {STAGE_TEXT[st.stage] ?? st.stage}</span>
        {running ? <Button size="xs" variant="outline" className="ml-auto gap-1" disabled={act.cancel.isPending} onClick={() => act.cancel.mutate(id)}><Square className="size-3" />{t('取消')}</Button> : null}
      </div>
      <div className="rounded-lg border p-2.5 text-[12px]">
        <div className="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
          <span>{p.note}</span>
          <span className="num">{p.done}/{p.total}{p.eta_ms != null ? ` · ${t('约 {m} 分钟', { m: Math.ceil(p.eta_ms / 60000) })}` : ''}</span>
          <span className="num">Jev {st.usage.judge_calls} {t('次')} · ${st.usage.judge_usd}{st.usage.judge_unknown_cost_calls ? ` · ${t('{n} 次花费未知', { n: st.usage.judge_unknown_cost_calls })}` : ''}</span>
          {st.usage.wall_ms ? <span className="num">{t('用时 {m} 分钟', { m: Math.max(1, Math.round(st.usage.wall_ms / 60000)) })}</span> : null}
          {s.ledger ? <span className="num" title={t('每代每个新变体都算一次试验;Deflated Sharpe 按这个数折扣')}>{t('试验数')} {s.ledger.trial_count}</span> : null}
          <span className="inline-flex items-center gap-1">{st.holdout_state === 'released' ? <Unlock className="size-3" /> : <Lock className="size-3" />}{t('留出段')} {st.holdout_state === 'released' ? t('已释放') : t('锁定中')} · {s.auto_finalize ? t('候选冻结后自动释放一次') : t('我手动释放')}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${p.total ? (100 * p.done) / p.total : 0}%` }} /></div>
        {st.error ? <p className="mt-1 text-destructive">{st.error}</p> : null}
        {st.stop_reason ? <p className="mt-1 text-muted-foreground">{st.stop_reason}</p> : null}
      </div>
      {st.conclusion ? <Conclusion s={s} /> : null}
      <Grid s={s} />
      {st.generations.length ? <Generations s={s} /> : null}
      {st.finalists.length ? <Finalists s={s} finalize={() => act.finalize.mutate({ id, manifest_hash: s.manifest_hash }, { onError: (e) => toast.error((e as Error).message) })} finalizing={act.finalize.isPending} /> : null}
    </>
  );
}

function Conclusion({ s }: { s: MatrixStudyView }) {
  const c = s.state.conclusion!;
  const causes = (Object.entries(c.causes) as [FailureCause, number][]).filter(([, n]) => n > 0);
  return (
    <div className={cn('rounded-lg border p-2.5 text-[12px]', c.kind === 'passed' ? 'border-up/40 bg-up/5' : 'bg-muted/30')}>
      <div className="mb-1 font-medium">{c.kind === 'passed' ? t('找到 {n} 条通过留出段检验的候选', { n: c.finalist_ids.length }) : t('这次没有找到能用的策略')}</div>
      <p className="text-muted-foreground">{c.text}</p>
      {causes.length ? <p className="mt-1">{t('没通过的主因')}:{causes.map(([k, n]) => `${CAUSE_TEXT[k]} ${n}`).join(' · ')}{c.research_only ? ` · ${t('仅研究')} ${c.research_only}` : ''}{c.not_applicable ? ` · ${t('不适用')} ${c.not_applicable}` : ''}</p> : null}
    </div>
  );
}

function ScoreTip({ r }: { r: CellResult }) {
  const x = r.selection;
  return (
    <div className="space-y-0.5 text-[11px]">
      <div>{t('选择段')}:{x ? `${pct(x.total_return)} · ${t('{n} 笔', { n: x.trades })} · ${t('回撤')} ${pct(x.max_drawdown)} · ${t('同敞口持有')} ${pct(x.exposure_matched_hold)}` : '—'}</div>
      <div>DSR {r.dsr == null ? '—' : r.dsr.toFixed(2)} · {t('评估 {n} 个变体', { n: r.evaluated })}</div>
      {r.cause ? <div>{t('主因')}:{CAUSE_TEXT[r.cause]}</div> : null}
      {r.judge_delta?.error_ratio != null && r.judge_delta.error_ratio > 0.5 ? <div className="text-destructive">{t('判断不可用:{p} 的候选判断出错(版本不符 / 超时)', { p: pct(r.judge_delta.error_ratio, 0) })}</div>
        : r.judge_delta?.all_skipped ? <div className="text-warn">{t('Jev 全部跳过:只说明「都不做」,不算判断增量')}</div> : null}
      {r.judge_delta && !r.judge_delta.all_skipped ? <div>{t('Jev 相对纯代码')}:{r.judge_delta.mean_daily == null ? '—' : `${(r.judge_delta.mean_daily * 1e4).toFixed(1)}bp/${t('日')}`}{r.judge_delta.ci95 ? ` [${(r.judge_delta.ci95[0] * 1e4).toFixed(1)}, ${(r.judge_delta.ci95[1] * 1e4).toFixed(1)}]` : ''}{r.judge_delta.kept_ratio != null ? ` · ${t('保留')} ${pct(r.judge_delta.kept_ratio, 0)}` : ''}</div> : null}
      {r.gates.filter((g) => !g.ok).slice(0, 4).map((g) => <div key={g.name} className="text-destructive">✗ {g.name}{g.value != null ? ` (${Number(g.value).toFixed(3)})` : ''}</div>)}
    </div>
  );
}

function Grid({ s }: { s: MatrixStudyView }) {
  const cells = s.manifest.cells;
  const rows = useMemo(() => [...new Set(cells.map((c) => `${c.symbol}|${c.timeframe}|${c.side}`))], [cells]);
  const fams = useMemo(() => [...new Set(cells.map((c) => c.family))], [cells]);
  if (!cells.length) return null;
  return (
    <section className="overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-[12px]">
        <thead><tr className="text-[11px] text-muted-foreground">
          <th className="px-2 py-1.5 font-normal">{t('资产 · 周期 · 方向')}</th>
          {fams.map((f) => <th key={f} className={cn('px-1.5 py-1.5 font-normal', parseMyFamily(f) && 'text-primary')} title={parseMyFamily(f) ? t('我的策略') : undefined}>{familyLabel(f, s.my_strategies)}</th>)}
        </tr></thead>
        <tbody>
          {rows.map((row) => {
            const [sym, tf, side] = row.split('|') as [string, MatrixTimeframe, string];
            return (
              <tr key={row} className="border-t">
                <td className="whitespace-nowrap px-2 py-1"><span className="num font-medium">{sym.replace(/USDT$/, '')}</span> <span className="text-muted-foreground">{tf} · {TF_HORIZON[tf]} · {side === 'long' ? t('多') : t('空')}</span></td>
                {fams.map((f) => (
                  <td key={f} className="p-1">
                    <div className="flex gap-1">
                      {(['code', 'code_judge'] as MatrixArm[]).map((arm) => {
                        const def = cells.find((c) => c.symbol === sym && c.timeframe === tf && c.side === side && c.family === f && c.arm === arm);
                        if (!def) return null;
                        const r = s.state.cells[def.id];
                        const verdict = def.applicability !== 'applicable' ? 'ineligible' : r?.verdict;
                        const box = (
                          <div className={cn('min-w-16 rounded border px-1.5 py-0.5', verdict ? VERDICT_CLS[verdict] : 'border-dashed text-muted-foreground')}>
                            <div className="text-[10px] opacity-70">{ARM_TEXT[arm]}</div>
                            <div className="num">{def.applicability !== 'applicable' ? (def.applicability === 'research_only' ? t('仅研究') : t('不适用')) : r?.selection ? pct(r.selection.total_return) : '…'}</div>
                          </div>
                        );
                        return r ? <Tooltip key={arm}><TooltipTrigger asChild>{box}</TooltipTrigger><TooltipContent className="max-w-80"><ScoreTip r={r} /></TooltipContent></Tooltip> : <div key={arm} title={def.reason ?? undefined}>{box}</div>;
                      })}
                    </div>
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function Generations({ s }: { s: MatrixStudyView }) {
  return (
    <section className="rounded-lg border p-2.5">
      <h3 className="mb-1.5 text-[13px] font-medium">{t('迭代:发现问题 → 改了什么 → 结果')}</h3>
      <ol className="space-y-1.5 text-[12px]">
        {s.state.generations.map((g, i) => (
          <li key={i} className="grid grid-cols-[3rem_1fr] gap-2">
            <span className="num text-muted-foreground">{t('第 {n} 代', { n: g.n })}</span>
            <div>
              <div><span className="text-muted-foreground">{t('问题')}</span> {g.diagnosis}</div>
              <div><span className="text-muted-foreground">{t('改动')}</span> {g.change}</div>
              <div className={g.promoted ? 'text-up' : 'text-muted-foreground'}>{g.selection ? `${pct(g.selection.total_return)} · ${t('{n} 笔', { n: g.selection.trades })}` : '—'} {g.promoted ? t('(晋升)') : ''} {g.note}</div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Score({ label, x }: { label: string; x: SlimScore | null }) {
  return <div><span className="text-muted-foreground">{label}</span> {x ? `${pct(x.total_return)} · ${t('{n} 笔', { n: x.trades })} · ${t('回撤')} ${pct(x.max_drawdown)}` : '—'}</div>;
}

function Finalists({ s, finalize, finalizing }: { s: MatrixStudyView; finalize: () => void; finalizing: boolean }) {
  const act = useMatrixAction();
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
          <Button size="xs" className="ml-auto gap-1" disabled={finalizing} onClick={finalize} title={t('留出段只能看一次;释放后这批候选不能再改')}>
            <Unlock className="size-3" />{finalizing ? t('检验中…') : t('释放留出段并检验')}
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
            {released ? <Score label={t('留出段')} x={f.holdout} /> : <div className="text-muted-foreground"><Lock className="mr-1 inline size-3" />{t('留出段未释放')}</div>}
            {f.test ? <div className="text-muted-foreground">p={f.test.p_value?.toFixed(3) ?? '—'} · Holm {f.test.holm_threshold?.toFixed(3) ?? '—'}</div> : null}
            {f.portfolio ? (
              <div className="mt-1 rounded bg-muted/40 px-1.5 py-1">
                <span className="text-muted-foreground">{t('组合回测')}</span> {pct(f.portfolio.total_return)} · {t('回撤')} {pct(f.portfolio.max_drawdown)} · {t('{n} 笔', { n: f.portfolio.trades })} · {t('Jev 跳过 {n}', { n: f.portfolio.skipped_by_judge })} · {t('仓位满跳过 {n}', { n: f.portfolio.skipped_by_capacity })}
              </div>
            ) : null}
            <div className="mt-1.5 flex gap-1.5">
              {adopted[f.id] ? (
                <>
                  <a className="text-[11px] text-primary hover:underline" href={`#my-strategies?id=${encodeURIComponent(adopted[f.id]!.strategy_id)}`}>{t('打开策略')}</a>
                  <Button size="xs" className="ml-auto gap-1" disabled={setAgent.isPending} onClick={() => setAgent.mutate({ kind: 'strategy', strategy_id: adopted[f.id]!.strategy_id, version: adopted[f.id]!.version, mode: 'agent' }, { onSuccess: () => toast.success(t('agent 已切到这条策略')), onError: (e) => toast.error((e as Error).message) })}>
                    <Sparkles className="size-3" />{t('设为 agent 当前策略')}
                  </Button>
                </>
              ) : (
                <Button size="xs" variant="outline" className="ml-auto" disabled={!released || f.passed !== true || act.adopt.isPending} title={!released ? t('先释放留出段') : f.passed !== true ? t('留出段没通过的候选不能存') : undefined} onClick={() => adopt(f)}>
                  {parseMyFamily(f.family) ? t('存为这条策略的新版本') : t('存成我的策略')}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
      {!released ? <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground"><TriangleAlert className="size-3" />{s.auto_finalize ? t('候选按选择段挑出;候选冻结后会自动释放留出段一次,真正的结论只看那一次') : t('候选按选择段挑出;真正的结论只看留出段那一次')}</p> : null}
    </section>
  );
}
