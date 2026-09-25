/**
 * 对话里的研究产物(research round 3 §2.2/§2.3):图表(JSON 规范,不是图片)、Markdown 报告、表格,
 * 以及代理每一轮的任务树。图表用 SVG 画(折线/柱/散点),数据量小(诊断级),不起 lightweight-charts。
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronRight, CircleAlert, FileText, Maximize2, PanelRight, Table2, TrendingUp, X } from 'lucide-react';
import { researchApi } from '@/api/client';
import type { ResearchArtifact, ResearchChartSpec, ResearchChatTask, ResearchTableSpec } from '@/api/research-types';
import { Markdown } from '@/components/markdown';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { AnimatePresence, Reveal, motion } from '@/components/research-workbench/motion';
import { fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { readableRuleText, humanMetricName, formatValue, nearestPoint, legacyRawPoints, unitLabel } from './presentation';

import { useResearchPreferences } from './preferences';
import { downloadArtifact } from './artifact-export';
import { ResearchChart, isResearchChart } from './research-chart';

const SERIES_COLORS = ['#3f9ac2', '#d9a441', '#a468e0', '#2aa76e', '#c94b3e', '#97a3b4'];

// ---------------------------------------------------------------------------
// 任务树

export function TaskTree({ tasks, compact = false }: { tasks: ResearchChatTask[]; compact?: boolean }) {
  const roots = tasks.filter((x) => !x.parent_id);
  const children = (id: string) => tasks.filter((x) => x.parent_id === id);
  if (!tasks.length) return null;
  const Node = ({ task, depth }: { task: ResearchChatTask; depth: number }) => (
    <Reveal layout className={cn('space-y-0.5', depth > 0 && 'ml-4 border-l pl-2.5')}>
      <div className={cn('flex items-start gap-1.5 text-[11.5px]', compact && 'text-[11px]')}>
        <span className="mt-[3px] inline-flex size-3 shrink-0 items-center justify-center">
          {task.status === 'running' ? (
            <motion.span className="inline-block size-2 rounded-full bg-primary" animate={{ scale: [1, 1.5, 1], opacity: [1, 0.55, 1] }} transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }} />
          ) : task.status === 'done' ? (
            <Check className="size-3 text-up" />
          ) : task.status === 'failed' ? (
            <X className="size-3 text-down" />
          ) : (
            <span className="inline-block size-1.5 rounded-full bg-muted-foreground/50" />
          )}
        </span>
        <span className={cn('min-w-0', task.status === 'running' ? 'text-foreground' : task.status === 'failed' ? 'text-down' : 'text-foreground/80')}>
          {task.title}
          {task.detail ? <span className="ml-1.5 text-muted-foreground">{task.detail}</span> : null}
        </span>
      </div>
      <AnimatePresence initial={false}>
        {children(task.id).map((c) => (
          <Node key={c.id} task={c} depth={depth + 1} />
        ))}
      </AnimatePresence>
    </Reveal>
  );
  return (
    <div className="space-y-0.5">
      <AnimatePresence initial={false}>
        {roots.map((r) => (
          <Node key={r.id} task={r} depth={0} />
        ))}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// artifacts

/** §9.44 的数据身份标签:估计 / 演示数据一定要标出来,不能混成实测。 */
export function DataKindBadge({ dataKind, availability }: { dataKind?: string | null; availability?: string | null }) {
  const label =
    dataKind === 'estimated' ? t('估计') : dataKind === 'synthetic' ? t('演示数据') : dataKind === 'derived' ? t('数据分析') : dataKind === 'observed' ? t('市场数据') : null;
  const avail = availability === 'stale' ? t('已过期') : availability === 'partial' ? t('部分覆盖') : availability === 'missing' ? t('缺数据') : availability === 'not_applicable' ? t('不适用') : null;
  if (!label && !avail) return null;
  const warn = dataKind === 'estimated' || dataKind === 'synthetic' || (availability && availability !== 'available');
  return (
    <span className={cn('rounded-sm border px-1 text-[9.5px] leading-[14px]', warn ? 'border-warn/40 bg-warn/10 text-warn' : 'border-border text-muted-foreground')}>
      {[label, avail].filter(Boolean).join(' · ')}
    </span>
  );
}

export function ArtifactCard({ id, inline = false, onOpen, caption }: { id: string; inline?: boolean; onOpen?: (id: string) => void; /** 答案里给这张图的一句说明(模型写、不含数字) */ caption?: string }) {
  const q = useQuery({ queryKey: ['research', 'artifact', id], queryFn: () => researchApi.artifact(id), staleTime: Infinity, retry: false });
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  if (q.isLoading) return <div className="my-1.5 h-24 animate-pulse rounded-md border bg-muted/30" />;
  if (q.error || !q.data) return <div className="my-1.5 rounded-md border border-down/40 px-2.5 py-1.5 text-[11px] text-down">{t('产物读不到')}:{id.slice(0, 8)}</div>;
  const a = q.data;
  const Icon = a.kind === 'chart' ? TrendingUp : a.kind === 'table' ? Table2 : FileText;
  return (
    <Reveal className={cn('my-4 overflow-hidden rounded-xl border border-border/80 bg-card', inline && 'my-3')}>
      <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-border/60 px-4 py-3 text-xs select-none">
        <button type="button" className="inline-flex items-center gap-1.5 text-foreground/85 hover:text-foreground" onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
          <Icon className="size-3" />
          <span className="font-medium">{a.title}</span>
        </button>
        <DataKindBadge dataKind={a.data_kind} availability={a.availability} />
        <ArtifactExports artifact={a} />
        <span className="ml-auto hidden text-[10px] text-muted-foreground sm:inline">{fmtDateTime(a.created_at)}</span>
        {onOpen ? (
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => onOpen(id)} title={t('在右侧结果面板打开')}>
            <PanelRight className="size-3" />
          </button>
        ) : null}
        <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => setOpen(true)} title={t('放大')}>
          <Maximize2 className="size-3" />
        </button>
      </div>
      <AnimatePresence initial={false}>
        {!collapsed ? (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            {caption ? <p className="px-4 pt-3 text-[12px] leading-relaxed text-foreground/80">{caption}</p> : null}
            <ArtifactBody artifact={a} height={inline ? 250 : 300} />
          </motion.div>
        ) : null}
      </AnimatePresence>
      <ArtifactProvenance artifact={a} />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] w-[min(1100px,94vw)] overflow-auto sm:max-w-[1100px]">
          <DialogTitle className="text-[14px]">{a.title}</DialogTitle>
          <ArtifactBody artifact={a} height={520} />
          <ArtifactProvenance artifact={a} />
        </DialogContent>
      </Dialog>
    </Reveal>
  );
}

/** §9.44:新接口把规范放 spec,旧沙箱产物放 content;两边都认,缺就是缺,不补线。 */
export function ArtifactBody({ artifact, height }: { artifact: ResearchArtifact; height: number }) {
  const prefs = useResearchPreferences();
  const body = artifact.content ?? artifact.spec ?? null;
  if (body === null || body === undefined) return <div className="p-2 text-[11px] text-muted-foreground">{t('这个产物没有可渲染的内容')}</div>;
  if (typeof body === 'object' && (body as any).view === 'research_report') return <ReportView body={body as any} />;
  if (typeof body === 'object' && (body as any).view === 'strategy_draft') return <DraftView body={body as any} />;
  if (artifact.kind === 'markdown') return <div className="px-3 py-2"><Markdown text={typeof body === 'string' ? body : String((body as any).text ?? '')} /></div>;
  if (artifact.kind === 'table') return <TableView spec={body as ResearchTableSpec} />;
  // 研究图表模板(research-chart/v1):Horizon 式渲染;旧图仍走下面的 ChartView
  if (artifact.kind === 'chart' && isResearchChart(body)) return <ResearchChart chart={body} height={prefs.compact_charts ? Math.min(height, 220) : height} framed={false} />;
  if (artifact.kind === 'chart') return <ChartView spec={body as ResearchChartSpec} height={prefs.compact_charts ? Math.min(height, 200) : height} />;
  return <pre className="max-h-64 overflow-auto p-2 text-[10.5px] whitespace-pre-wrap">{JSON.stringify(body, null, 1)}</pre>;
}

function TableView({ spec }: { spec: ResearchTableSpec }) {
  const [raw, setRaw] = useState(false);
  const prefs = useResearchPreferences();
  if (!spec?.columns || !Array.isArray(spec.rows)) return <div className="p-4 text-xs text-muted-foreground">{t('这张表的数据格式暂时无法展示。')}</div>;
  const metricTable = spec.columns[0] === '指标' && spec.columns.includes('单位');
  const rows = spec.rows.slice(0, 500);
  const strength = (spec as ResearchTableSpec & { analysis?: { benchmark?: string; rows?: { canonical_id: string; return: { value: number | null; unit: string }; max_drawdown: { value: number | null; unit: string }; residual_sharpe: { value: number | null; unit: string } }[] } }).analysis;
  const strengthRows = strength?.benchmark && Array.isArray(strength.rows) ? strength.rows : null;
  if (strengthRows && !raw) return <div><div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr>{['资产', '区间收益', '最大回撤', '剔除大盘后的风险收益比'].map((c) => <th key={c} className="border-b px-4 py-3 text-left font-medium text-muted-foreground">{t(c)}</th>)}</tr></thead><tbody>{strengthRows.map((r) => <tr key={r.canonical_id} className="border-b border-border/50"><td className="px-4 py-3 font-medium">{r.canonical_id.replace(/^okx:(?:spot|perp):/, '').replace(/-USDT(?:-SWAP)?$/, '')}</td>{[r.return, r.max_drawdown, r.residual_sharpe].map((m, i) => <td className="num px-4 py-3 whitespace-nowrap" key={i}>{formatValue(m?.value, m?.unit)}</td>)}</tr>)}</tbody></table></div><div className="space-y-2 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground"><p>{t('最后一列衡量剔除大盘波动后，剩余收益与波动的关系；样本不足时留空，不代表未来表现。')}</p><button type="button" className="hover:text-foreground" onClick={() => setRaw(true)}>{t('查看完整指标与原始字段')}</button></div></div>;
  return <div>
    {metricTable && !raw && prefs.metric_summary ? <div className="grid grid-cols-1 gap-px border-b bg-border/50 sm:grid-cols-3">{rows.slice(0, 3).map((r, i) => <div className="bg-card px-4 py-4" key={i}><div className="mb-1 text-[11px] text-muted-foreground">{t(humanMetricName(String(r[0])))}</div><div className="num text-xl font-medium tracking-tight">{formatValue(r[1], String(r[2] ?? ''))}</div></div>)}</div> : null}
    <div className="max-h-80 overflow-auto"><table className="w-full text-xs"><thead className="sticky top-0 bg-card"><tr>{(metricTable && !raw ? ['指标', '数值', '状态'] : spec.columns).map((c) => <th key={c} className="border-b px-4 py-2.5 text-left font-medium whitespace-nowrap text-muted-foreground">{raw ? c : t(humanMetricName(c))}</th>)}</tr></thead><tbody>{rows.map((r, i) => <tr key={i} className="border-t border-border/50 hover:bg-muted/20">{(metricTable && !raw ? [humanMetricName(String(r[0])), formatValue(r[1], String(r[2] ?? '')), r[3] === 'ok' ? '已计算' : r[3] === 'insufficient' ? '样本不足' : r[3] === 'missing' ? '数据暂缺' : r[3] ?? '—'] : r).map((v, j) => <td key={j} className={cn('px-4 py-2.5', j > 0 && 'num whitespace-nowrap')}>{raw ? String(v ?? 'null') : typeof v === 'number' ? formatValue(v) : String(v ?? '—')}</td>)}</tr>)}</tbody></table></div>
    <div className="flex items-center justify-between border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground"><span>{spec.rows.length > 500 ? t('仅展示前500行；原始数据保留') : `${spec.rows.length} ${t('行数据')}`}</span><button type="button" className="hover:text-foreground" onClick={() => setRaw((v) => !v)}>{t(raw ? '返回易读视图' : '查看原始字段')}</button></div>
  </div>;
}

export function ArtifactProvenance({ artifact }: { artifact: ResearchArtifact }) {
  const prefs = useResearchPreferences();
  const refs = artifact.snapshot_refs ?? [];
  const content = artifact.content as { view?: string; baseline_run_id?: string; candidate_run_id?: string } | null;
  const runs = [...new Set([content?.baseline_run_id, content?.candidate_run_id, artifact.run_id].filter((id): id is string => !!id))];
  const q = useQuery({ queryKey: ['research', 'artifact-sources', artifact.id], queryFn: () => Promise.all(refs.map((id) => researchApi.snapshot(id, 0))), enabled: refs.length > 0, staleTime: Infinity, retry: false });
  if (!prefs.sources) return null;
  return <details className="border-t border-border/60 px-4 py-2.5 text-[11px] text-muted-foreground"><summary className="cursor-pointer">{t('数据来源与方法')}{q.data?.length ? ` · ${[...new Set(q.data.map((s) => s.provider))].join(' / ')}` : artifact.provider ? ` · ${artifact.provider}` : ''}</summary><div className="mt-3 space-y-3 break-words">{!refs.length ? runs.length ? <div><p>来源：已保存的回测与规则版本；实验可从本轮回测卡或设置中的版本记录打开。</p><p className="mt-1 break-all font-mono text-[10px]">{runs.join(' · ')}</p></div> : content?.view === 'research_report' ? <p>来源：本轮已保存的产物与执行记录；可在报告中打开引用证据。</p> : <p>{t('这份历史产物没有关联数据快照，来源未标注。')}</p> : q.error ? <p>{t('来源信息暂时未能加载。')}</p> : q.isLoading ? <p>{t('读取来源…')}</p> : q.data?.map((s, i) => <div key={refs[i]}><b className="text-foreground/80">{s.provider}</b><div>{t('截至')} {fmtDateTime(s.as_of)}</div>{s.actual_window ? <div>{t('覆盖区间')} {fmtDateTime(s.actual_window.from_ms)} → {fmtDateTime(s.actual_window.to_ms)}</div> : <div>{t('覆盖区间未标注')}</div>}<div>{t('覆盖状态')} {({ available: '完整覆盖', partial: '部分覆盖', missing: '数据暂缺', stale: '已过期', not_applicable: '不适用' } as Record<string, string>)[s.coverage ?? ""] ?? s.coverage ?? t("未标注")}</div></div>)}{artifact.caption ? <p>{artifact.caption}</p> : null}{artifact.data_kind === 'estimated' ? <p className="text-warn">{t('模型估计，不代表已经发生的成交。')}</p> : null}</div></details>;
}

/** 折线 / 柱 / 散点,SVG;x 为 time 时按时间等比放,category 时等距。悬停读数。 */
function ChartView({ spec, height }: { spec: ResearchChartSpec; height: number }) {
  const all = spec?.series ?? [];
  const needsPanels = spec.layout === 'panels' || new Set(all.map((s) => s.axis)).size > 1 || new Set(all.map((s) => s.unit ?? spec.y_label)).size > 1 || all.some((s) => s.transformed);
  // Old mixed-unit artifacts retain raw rows: derive display from those rows, without editing the snapshot.
  if (needsPanels && all.length > 1) {
    const validTimes = all.flatMap((s) => s.points.map((p) => Number(p[0]))).filter(Number.isFinite);
    const domain: [number, number] = [Math.min(...validTimes), Math.max(...validTimes)];
    return <div className="divide-y divide-border/60">{all.map((s, i) => {
      const field = s.field;
      const raw = legacyRawPoints(s, spec.rows);
      const label = raw ? humanMetricName(field!) : humanMetricName(s.name);
      const unit = raw ? s.unit : s.transformed ? '%' : s.unit ?? spec.y_label;
      return <div key={`${s.name}-${i}`} className="pt-3"><div className="flex items-center gap-2 px-4 text-xs font-medium"><i className="h-0.5 w-3" style={{ background: s.color ?? SERIES_COLORS[i % SERIES_COLORS.length] }} />{t(label)}<span className="ml-auto text-[10px] font-normal text-muted-foreground">{unitLabel(unit)}</span></div><SingleChart spec={{ ...spec, layout: 'overlay', series: [{ ...s, name: label, transformed: false, points: raw ?? s.points, color: s.color ?? SERIES_COLORS[i % SERIES_COLORS.length] }], x_domain: domain, y_label: unit, note: s.transformed && !raw ? '历史图保留归一化显示；原始底表不完整，无法还原全部观测。' : undefined }} height={Math.max(155, height / all.length)} /></div>;
    })}<p className="px-4 py-2 text-[11px] text-muted-foreground">{t('各图使用独立纵轴，共享同一时间范围。')}</p></div>;
  }
  return <SingleChart spec={spec} height={height} />;
}

function SingleChart({ spec, height }: { spec: ResearchChartSpec; height: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const W = 800, H = Math.max(140, height), pad = { l: 90, r: 25, t: 14, b: 35 };
  const model = useMemo(() => {
    const series = (spec?.series ?? []).filter((s) => !hidden.has(s.name) && Array.isArray(s.points) && s.points.some((p) => p[1] != null && Number.isFinite(Number(p[1]))));
    if (!series.length) return null;
    const isTime = spec.x !== 'category';
    const cats = [...new Set(series.flatMap((s) => s.points.map((p) => String(p[0]))))];
    const xs = series.flatMap((s) => s.points.map((p) => Number(p[0]))).filter(Number.isFinite);
    const xMin = isTime ? spec.x_domain?.[0] ?? Math.min(...xs) : 0;
    const xMax = isTime ? spec.x_domain?.[1] ?? Math.max(...xs) : Math.max(1, cats.length - 1);
    const ys = series.flatMap((s) => s.points.filter((p) => p[1] !== null && Number.isFinite(Number(p[1]))).map((p) => Number(p[1])));
    let yMin = Math.min(...ys), yMax = Math.max(...ys);
    if (spec.type === 'bar') { yMin = Math.min(0, yMin); yMax = Math.max(0, yMax); }
    const margin = (yMax - yMin) * .08 || Math.abs(yMax) * .01 || 1;
    yMin -= margin; yMax += margin;
    const sx = (x: number | string) => pad.l + ((isTime ? Number(x) - xMin : cats.indexOf(String(x))) / (xMax - xMin || 1)) * (W - pad.l - pad.r);
    const sy = (y: number) => pad.t + (1 - (y - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);
    return { series, isTime, cats, xMin, xMax, yMin, yMax, sx, sy };
  }, [spec, H, hidden]);
  const fmtY = (v: number) => formatValue(v, spec.y_label);
  const formatTime = (v: number) => new Date(v).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  const plot = model;
  return <div className="relative">
    <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 pt-2 text-xs">{(spec?.series ?? []).map((s, i) => <button type="button" key={s.name} aria-pressed={!hidden.has(s.name)} onClick={() => setHidden((old) => { const next = new Set(old); if (next.has(s.name)) next.delete(s.name); else next.add(s.name); return next; })} className={cn('inline-flex items-center gap-1.5 py-1', hidden.has(s.name) && 'opacity-40')}><i className="h-0.5 w-3" style={{ background: s.color ?? SERIES_COLORS[i % SERIES_COLORS.length] }} />{t(humanMetricName(s.name))}</button>)}</div>
    {!plot ? <div className="flex min-h-28 items-center justify-center p-4 text-xs text-muted-foreground">{t(hidden.size ? '点击图例重新显示序列' : '当前产物没有可绘制的序列；原始资料仍保留。')}</div> : <>
      <svg role="img" aria-label={spec.title || t('研究图表')} viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }} onMouseLeave={() => setHover(null)} onMouseMove={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, ((e.clientX - box.left) / box.width * W - pad.l) / (W - pad.l - pad.r)));
        setHover(plot.xMin + ratio * (plot.xMax - plot.xMin));
      }}>
        <title>{spec.title}</title>
        {[0, .5, 1].map((k) => { const v = plot.yMin + (plot.yMax - plot.yMin) * k; return <g key={k}><line x1={pad.l} x2={W - pad.r} y1={plot.sy(v)} y2={plot.sy(v)} stroke="currentColor" strokeOpacity={.08} /><text x={pad.l - 8} y={plot.sy(v) + 3} fontSize={11} textAnchor="end" fill="currentColor" fillOpacity={.55}>{fmtY(v)}</text></g>; })}
        {(plot.isTime ? [plot.xMin, (plot.xMin + plot.xMax) / 2, plot.xMax] : plot.cats).map((v, i, arr) => <text key={i} x={plot.sx(v)} y={H - 9} fontSize={11} textAnchor={i === 0 ? 'start' : i === arr.length - 1 ? 'end' : 'middle'} fill="currentColor" fillOpacity={.55}>{plot.isTime ? formatTime(Number(v)) : String(v)}</text>)}
        {plot.series.map((s, si) => {
          const color = s.color ?? SERIES_COLORS[si % SERIES_COLORS.length];
          const valid = (p: [number | string, number | null]) => p[1] !== null && Number.isFinite(Number(p[1])) && (!plot.isTime || Number.isFinite(Number(p[0])));
          if (spec.type === 'bar') { const bw = Math.max(1, (W - pad.l - pad.r) / Math.max(1, s.points.length) * .7 / plot.series.length); return <g key={s.name}>{s.points.filter(valid).map((p, i) => <rect key={i} x={plot.sx(p[0]) + si * bw - bw * plot.series.length / 2} y={Math.min(plot.sy(Number(p[1])), plot.sy(0))} width={bw} height={Math.abs(plot.sy(Number(p[1])) - plot.sy(0))} fill={color} opacity={.8} />)}</g>; }
          if (spec.type === 'scatter') return <g key={s.name}>{s.points.filter(valid).map((p, i) => <circle key={i} cx={plot.sx(p[0])} cy={plot.sy(Number(p[1]))} r={2.5} fill={color} />)}</g>;
          let pen = false;
          const d = s.points.map((p) => { if (!valid(p)) { pen = false; return ''; } const cmd = pen ? 'L' : 'M'; pen = true; return `${cmd}${plot.sx(p[0]).toFixed(2)},${plot.sy(Number(p[1])).toFixed(2)}`; }).join(' ');
          return <g key={s.name}><path d={d} fill="none" stroke={color} strokeWidth={1.8} />{s.points.map((p, i) => valid(p) && (!s.points[i - 1] || !valid(s.points[i - 1]!)) && (!s.points[i + 1] || !valid(s.points[i + 1]!)) ? <circle key={i} cx={plot.sx(p[0])} cy={plot.sy(Number(p[1]))} r={2.7} fill={color} /> : null)}</g>;
        })}
        {hover !== null && plot.isTime ? <line x1={plot.sx(hover)} x2={plot.sx(hover)} y1={pad.t} y2={H - pad.b} stroke="currentColor" strokeOpacity={.3} strokeDasharray="3 3" /> : null}
      </svg>
      {hover !== null && plot.isTime ? <div className="pointer-events-none absolute top-9 right-4 max-w-[80%] rounded-lg border bg-card/95 px-3 py-2 text-[11px] shadow-lg">{plot.series.map((s) => { const p = nearestPoint(s.points, hover); return p ? <div key={s.name} className="flex flex-wrap gap-x-3"><span>{t(humanMetricName(s.name))}</span><b className="num">{p[1] === null ? '—' : fmtY(Number(p[1]))}</b><span className="text-muted-foreground">{fmtDateTime(Number(p[0]))}</span></div> : null; })}</div> : null}
    </>}
    {spec.note ? <p className="px-4 pb-3 text-[11px] leading-relaxed text-muted-foreground">{spec.note}</p> : null}
  </div>;
}

/** final 文本里的 [[artifact:<id>]] 就地渲染成卡片,其余按 Markdown。 */
export function FinalWithArtifacts({ text, artifacts }: { text: string; artifacts: { id: string; kind: string; title: string }[] }) {
  const parts = useMemo(() => text.split(/(\[\[artifact:[A-Za-z0-9_-]+\]\])/g), [text]);
  const referenced = new Set<string>();
  const nodes = parts.map((part, i) => {
    const m = /^\[\[artifact:([A-Za-z0-9_-]+)\]\]$/.exec(part);
    if (m) {
      referenced.add(m[1]!);
      return <ArtifactCard key={`a-${i}`} id={m[1]!} inline />;
    }
    return part.trim() ? <Markdown key={`t-${i}`} text={part} /> : null;
  });
  const rest = artifacts.filter((a) => !referenced.has(a.id));
  return (
    <div>
      {nodes}
      {rest.map((a) => (
        <ArtifactCard key={a.id} id={a.id} inline />
      ))}
    </div>
  );
}

export function ErrorLine({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-1.5 text-[11px] text-down">
      <CircleAlert className="mt-0.5 size-3 shrink-0" />
      <span>{text}</span>
    </div>
  );
}

export function ArtifactExports({ artifact }: { artifact: ResearchArtifact }) {
  const body = (artifact.content ?? artifact.spec) as any;
  const formats: ('json' | 'csv' | 'md')[] = ['json'];
  if (Array.isArray(body?.columns) && Array.isArray(body?.rows)) formats.push('csv');
  if (artifact.kind === 'markdown') formats.push('md');
  return <span className="inline-flex gap-2 text-[10px] text-muted-foreground">{formats.map((format) => <button type="button" key={format} title={`导出 ${format.toUpperCase()}`} onClick={() => downloadArtifact(artifact, format)} className="hover:text-foreground">{format === 'md' ? 'Markdown' : format.toUpperCase()}</button>)}</span>;
}

function ReportView({ body }: { body: { text: string; artifact_refs?: { id: string; title: string }[]; steps?: { id: string; title: string; status: string }[] } }) {
  const [evidence, setEvidence] = useState<string | null>(null);
  return <div className="space-y-4 p-4"><Markdown text={body.text} />
    <div className="flex flex-wrap gap-2">{body.artifact_refs?.map((a) => <button type="button" key={a.id} onClick={() => setEvidence(a.id)} className="rounded-md border px-3 py-2 text-xs hover:bg-muted">查看证据 · {a.title}</button>)}</div>
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">执行记录</summary><ul className="mt-2 space-y-2">{body.steps?.map((s) => <li key={s.id}>{s.title} · {({ succeeded: '已完成', failed: '未完成', skipped: '未执行', cancelled: '已取消' } as Record<string, string>)[s.status] ?? s.status}</li>)}</ul></details>
    <Dialog open={!!evidence} onOpenChange={(v) => { if (!v) setEvidence(null); }}><DialogContent className="max-h-[90vh] overflow-auto sm:max-w-4xl"><DialogTitle>报告引用的证据</DialogTitle>{evidence ? <ArtifactCard id={evidence} /> : null}</DialogContent></Dialog>
  </div>;
}

function DraftView({ body }: { body: { valid: boolean; summary?: string; rules?: { category: string; text: string }[]; notes?: string[]; unmapped?: string[]; checks?: unknown; columns: string[]; rows: unknown[][] } }) {
  return <div className="space-y-4 p-4 text-sm"><p className="font-medium">{body.valid ? '规则草稿已通过检查，等待本轮验证结果' : '规则检查未通过，未启动这份候选的回测'}</p>
    {body.summary ? <p className="text-muted-foreground">{body.summary}</p> : null}
    <ul className="space-y-2">{body.rules?.map((rule, i) => <li key={i}>{readableRuleText(rule.text)}</li>)}</ul>
    {[...(body.notes ?? []), ...(body.unmapped ?? [])].map((note, i) => <p key={i} className="text-warn">{note}</p>)}
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">查看具体字段变化与检查记录</summary><TableView spec={body as unknown as ResearchTableSpec} /><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(body.checks, null, 2)}</pre></details>
  </div>;
}
