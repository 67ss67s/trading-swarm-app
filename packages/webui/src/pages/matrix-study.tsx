/**
 * 矩阵研究(§9.53 B,#matrix-study[?id=|?from=<recommendation_id>]):
 *   新建:从推荐卡预填 资产 × 周期 × 策略族 × 两臂(纯代码 / 代码+Jev)→ 先估算(变体数、Jev 调用与美元、耗时)→ 开始;
 *   详情:阶段与进度 → 矩阵(每格两臂的判定与选择段成绩)→ 迭代(诊断 → 改动 → 结果)→ 结论(passed / no_candidate + 主因)
 *        → 留出段一次释放 + 组合回测 → 存成我的策略 → 设为 agent 当前策略;
 *   列表:最近的研究。
 * 纪律同后端:留出段只在最终候选冻结后释放一次;「没找到」是合法结论,不给放宽门槛的按钮。
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, FlaskConical, Lock, Play, Square, Sparkles, TriangleAlert, Unlock } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FAMILY_TEXT } from '@/components/chat/recommendation-card';
import { useSetAgentStrategy } from '@/api/agent-strategy';
import { matrixApi, useMatrixAction, useMatrixStudies, useMatrixStudy, type CellResult, type FailureCause, type MatrixArm, type MatrixFinalist, type MatrixSpecLite, type MatrixStudyView, type MatrixTimeframe, type SlimScore } from '@/api/matrix-study';
import { fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t, tmap } from '@/lib/i18n';

const TF_HORIZON: Record<MatrixTimeframe, string> = tmap({ '3m': '短线', '5m': '短线', '15m': '短线', '4h': '中线', '1d': '长线' });
const RUNNABLE: MatrixTimeframe[] = ['15m', '4h', '1d'];
const FAMILIES = ['breakout', 'ma_trend', 'ema_cross', 'pullback', 'mean_reversion', 'smc'] as const;
const ARM_TEXT: Record<MatrixArm, string> = tmap({ code: '纯代码', code_judge: '代码 + Jev' });
const CAUSE_TEXT: Record<FailureCause, string> = tmap({ cost_dominated: '费用吃掉', insufficient_evidence: '证据不足', unsupported_execution: '执行不支持', underperform_hold: '跑输持有' });
const STATUS_TEXT: Record<string, string> = tmap({ queued: '排队', running: '研究中', ready_to_finalize: '待释放留出段', finalizing: '留出段检验中', completed: '已完成', cancelled: '已取消', failed: '失败', interrupted: '中断' });
const STAGE_TEXT: Record<string, string> = tmap({ queued: '排队', data: '取数', matrix: '跑矩阵', iterate: '迭代找根因', sealed: '候选已冻结', holdout: '留出段检验', done: '完成' });
const VERDICT_CLS: Record<string, string> = { pass: 'bg-up/20 text-up border-up/40', near: 'bg-warn/15 text-warn border-warn/40', fail: 'bg-muted text-muted-foreground', ineligible: 'bg-transparent text-muted-foreground/60 border-dashed' };

const pct = (v: number | null | undefined, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
const route = () => new URLSearchParams(window.location.hash.split('?')[1] ?? '');

export function MatrixStudyPage() {
  const [q, setQ] = useState(route);
  useEffect(() => { const on = () => setQ(route()); window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on); }, []);
  const id = q.get('id'), from = q.get('from');
  return (
    <div className="mx-auto flex h-full min-h-0 max-w-6xl flex-col gap-3 overflow-y-auto p-1">
      {id ? <Detail id={id} /> : <><Create from={from} /><List /></>}
    </div>
  );
}

// ---------------------------------------------------------------- 新建

function Toggle<T extends string>({ all, value, onChange, label, disabled }: { all: readonly T[]; value: T[]; onChange: (v: T[]) => void; label: (x: T) => string; disabled?: (x: T) => string | null }) {
  return (
    <div className="flex flex-wrap gap-1">
      {all.map((x) => {
        const why = disabled?.(x) ?? null, on = value.includes(x);
        return (
          <button key={x} type="button" disabled={!!why} title={why ?? undefined} onClick={() => onChange(on ? value.filter((v) => v !== x) : [...value, x])}
            className={cn('rounded-full border px-2 py-0.5 text-[12px]', on ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted', why && 'cursor-not-allowed opacity-40')}>
            {label(x)}
          </button>
        );
      })}
    </div>
  );
}

function Create({ from }: { from: string | null }) {
  const pre = useQuery({ queryKey: ['matrix-prefill', from], queryFn: () => matrixApi.prefill(from!), enabled: !!from, retry: 0 });
  const [spec, setSpec] = useState<MatrixSpecLite | null>(null);
  const [symText, setSymText] = useState('');
  useEffect(() => { if (pre.data?.spec) { setSpec(pre.data.spec); setSymText(pre.data.spec.symbols.join(' ')); } }, [pre.data]);
  const cur: MatrixSpecLite = spec ?? { symbols: [], timeframes: ['4h'], families: ['breakout', 'ma_trend'], market: 'perp', sides: ['long'], arms: ['code', 'code_judge'], recommendation_id: from };
  const patch = (p: Partial<MatrixSpecLite>) => setSpec({ ...cur, ...p });
  const symbols = symText.split(/[\s,，]+/).map((s) => s.trim().toUpperCase()).filter(Boolean).map((s) => (s.endsWith('USDT') ? s : `${s}USDT`));
  const full = { ...cur, symbols };
  const est = useQuery({ queryKey: ['matrix-estimate', JSON.stringify(full)], queryFn: () => matrixApi.estimate(full), enabled: symbols.length > 0 && full.timeframes.length > 0 && full.families.length > 0, retry: 0 });
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try { const v = await matrixApi.create(full); window.location.hash = `matrix-study?id=${encodeURIComponent(v.id)}`; }
    catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <section className="rounded-lg border p-3">
      <div className="mb-2 flex items-center gap-2">
        <FlaskConical className="size-4 text-primary" />
        <h2 className="text-[15px] font-medium">{t('新建矩阵研究')}</h2>
        {from ? <span className="text-[11px] text-muted-foreground">{t('来自对话推荐 {id}', { id: from })}</span> : null}
      </div>
      {pre.isError ? <p className="mb-2 text-[12px] text-destructive">{t('推荐预填失败:{e}', { e: (pre.error as Error).message })}</p> : null}
      <div className="grid gap-2 text-[12px] md:grid-cols-[6rem_1fr]">
        <span className="text-muted-foreground">{t('资产')}</span>
        <input value={symText} onChange={(e) => setSymText(e.target.value)} placeholder={t('空格分隔,如 SOL DOGE HYPE(≤ 6 个)')} className="h-8 rounded-md border bg-background px-2" />
        <span className="text-muted-foreground">{t('周期')}</span>
        <Toggle all={['3m', '5m', '15m', '4h', '1d'] as MatrixTimeframe[]} value={cur.timeframes} onChange={(v) => patch({ timeframes: v })}
          label={(x) => `${x} · ${TF_HORIZON[x]}`} disabled={(x) => (RUNNABLE.includes(x) ? null : t('3m/5m 运行器暂不支持,只能离线研究,本版不进矩阵'))} />
        <span className="text-muted-foreground">{t('策略族')}</span>
        <Toggle all={FAMILIES} value={cur.families as (typeof FAMILIES)[number][]} onChange={(v) => patch({ families: v })} label={(x) => FAMILY_TEXT[x]} />
        <span className="text-muted-foreground">{t('方向 / 市场')}</span>
        <div className="flex flex-wrap items-center gap-3">
          <Toggle all={['long', 'short'] as const} value={cur.sides} onChange={(v) => patch({ sides: v })} label={(x) => (x === 'long' ? t('做多') : t('做空'))} disabled={(x) => (x === 'short' && cur.market === 'spot' ? t('现货不能做空') : null)} />
          <Toggle all={['perp', 'spot'] as const} value={[cur.market]} onChange={(v) => v.length && patch({ market: v[v.length - 1]!, sides: v[v.length - 1] === 'spot' ? ['long'] : cur.sides })} label={(x) => (x === 'perp' ? t('永续') : t('现货'))} />
        </div>
        <span className="text-muted-foreground">{t('对照臂')}</span>
        <Toggle all={['code', 'code_judge'] as MatrixArm[]} value={cur.arms} onChange={(v) => patch({ arms: v })} label={(x) => ARM_TEXT[x]} />
        <span className="text-muted-foreground">{t('留出段')}</span>
        <Toggle all={['auto', 'manual'] as const} value={[cur['auto_finalize'] === false ? 'manual' : 'auto']} onChange={(v) => v.length && patch({ auto_finalize: v[v.length - 1] === 'auto' })}
          label={(x) => (x === 'auto' ? t('候选冻结后自动释放一次') : t('我手动释放'))} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md bg-muted/40 px-2.5 py-2 text-[12px]">
        <span className="text-muted-foreground">{t('估算')}</span>
        {est.isLoading ? <span>…</span> : est.isError ? <span className="text-destructive">{(est.error as Error).message}</span> : est.data ? (() => {
          const e = est.data.estimate;
          return (
            <>
              <span className="num">{t('格子')} <b>{e.cells.applicable}</b>/{e.cells.total}{e.cells.research_only ? ` · ${t('仅研究')} ${e.cells.research_only}` : ''}</span>
              <span className="num">{t('试验')} <b>{e.matrix_trials}</b> + {t('迭代上限')} {e.iteration_trials_max}</span>
              <span className="num">Jev <b>{e.judge_calls}</b> {t('次')} ≈ <b>${e.judge_usd}</b></span>
              <span className="num">{t('冷数据最多约 {m} 分钟', { m: Math.ceil(e.data.cold_fetch_ms_upper / 60000) })}</span>
              {!e.within_budget ? <span className="text-destructive">{t('超出变体预算,减少资产/周期/策略族')}</span> : null}
              {e.warnings.slice(0, 2).map((w) => <span key={w} className="text-warn">{w}</span>)}
            </>
          );
        })() : <span className="text-muted-foreground">{t('填好资产后自动估算')}</span>}
        <Button size="sm" className="ml-auto gap-1" disabled={busy || est.data?.estimate.within_budget === false || !symbols.length || !cur.timeframes.length || !cur.families.length || !cur.arms.length} onClick={() => void start()}>
          <Play className="size-3.5" />{busy ? t('创建中…') : t('开始研究')}
        </Button>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">{t('训练 / 选择 / 留出三段按时间切;留出段锁死,最终候选冻结后只释放一次。「没找到」是正常结论。')}</p>
    </section>
  );
}

function List() {
  const q = useMatrixStudies();
  const items = q.data?.items ?? [];
  if (!items.length) return null;
  return (
    <section className="rounded-lg border p-3">
      <h3 className="mb-2 text-[13px] font-medium">{t('最近的矩阵研究')}</h3>
      <div className="divide-y">
        {items.slice(0, 20).map((s) => (
          <a key={s.id} href={`#matrix-study?id=${encodeURIComponent(s.id)}`} className="flex items-center gap-3 py-1.5 text-[12px] hover:bg-muted/50">
            <span className="num w-36 shrink-0 text-muted-foreground">{fmtDateTime(s.created_at)}</span>
            <span className="min-w-0 flex-1 truncate">{s.manifest.spec.symbols.map((x) => x.replace(/USDT$/, '')).join(' · ')} — {s.manifest.spec.timeframes.join('/')}</span>
            <span>{STATUS_TEXT[s.status] ?? s.status}</span>
            {s.state.conclusion ? <span className={s.state.conclusion.kind === 'passed' ? 'text-up' : 'text-muted-foreground'}>{s.state.conclusion.kind === 'passed' ? t('有候选') : t('没找到')}</span> : null}
          </a>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- 详情

function Detail({ id }: { id: string }) {
  const q = useMatrixStudy(id);
  const act = useMatrixAction();
  if (q.isLoading) return <div className="h-40 animate-pulse rounded-lg border" />;
  if (q.isError || !q.data) return <p className="text-[13px] text-destructive">{t('读取研究失败')}:{(q.error as Error | null)?.message}</p>;
  const s = q.data, st = s.state, p = st.progress;
  const running = ['queued', 'running', 'finalizing'].includes(s.status);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <a href="#matrix-study" className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" />{t('矩阵研究')}</a>
        <h2 className="text-[15px] font-medium">{s.manifest.spec.symbols.map((x) => x.replace(/USDT$/, '')).join(' · ')} — {s.manifest.spec.timeframes.map((tf) => `${tf}(${TF_HORIZON[tf]})`).join(' / ')}</h2>
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
          {fams.map((f) => <th key={f} className="px-1.5 py-1.5 font-normal">{FAMILY_TEXT[f as keyof typeof FAMILY_TEXT] ?? f}</th>)}
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
    onSuccess: (r) => { setLocal((m) => ({ ...m, [f.id]: r })); toast.success(t('已存成我的策略 v{v}', { v: r.version })); r.preflight?.warnings.slice(0, 2).forEach((w) => toast.warning(w.message)); },
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
              <span>{FAMILY_TEXT[f.family as keyof typeof FAMILY_TEXT] ?? f.family}</span>
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
                  {t('存成我的策略')}
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
