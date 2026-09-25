/**
 * 研究图表渲染器(Horizon 式,2026-09-23):渲染后端 research/loop/charts.ts 按模板从回测报告确定性生成的图表
 * (content.version = research-chart/v1:权益曲线对比、回撤对比、按退出类型/资产的盈亏柱、逐笔散点、月度热力图、多策略横比)。
 *
 * 对齐 Horizon 截图:暗色底、坐标轴标题、网格、统一悬停(竖虚线 + 一个框列出同一 x 上各序列的值)、底部横排图例
 * (点击隐藏序列)、带点的策略线、柱顶文字标签、散点盈绿亏红、分界竖线与标注、图下居中标题、右上 Share(复制/下载 PNG)。
 * 纯 SVG,不引 plotly;颜色按序列角色取(数据里不写死颜色),文字一律用中性墨色,颜色只放在图元与图例色块上。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Share } from 'lucide-react';
import type { LoopChart, LoopChartSeries, LoopSeriesRole } from '@trading-swarm/contracts';
import { cn } from '@/lib/utils';

export type ResearchChartSpec = LoopChart;

export function isResearchChart(x: unknown): x is ResearchChartSpec {
  return !!x && typeof x === 'object' && (x as { version?: unknown }).version === 'research-chart/v1' && Array.isArray((x as { series?: unknown }).series);
}

// ---------------------------------------------------------------------------
// 颜色(暗色底;分类色取自已校验的暗色分类盘,盈亏用红绿并总伴随正负号/柱顶文字)

const BG = '#111318';
const INK = '#e6e8ec';
const INK_2 = '#a3a9b4';
const INK_3 = '#6f7682';
const GRID = 'rgba(255,255,255,0.08)';
const AXIS = 'rgba(255,255,255,0.22)';
const POS = '#2fb36f';
const NEG = '#e5534b';
const ROLE_COLOR: Record<LoopSeriesRole, string> = {
  strategy: '#e0a030', benchmark: '#3987e5', asset: '#9085e9', basket: '#199e70', alt: '#d55181',
  positive: POS, negative: NEG, neutral: '#8b93a1', split: '#f2f3f5',
};
const ALT = ['#9085e9', '#199e70', '#d55181', '#d95926', '#8b93a1'];
function seriesColors(series: LoopChartSeries[]): string[] {
  let alt = 0;
  return series.map((s) => (s.role === 'alt' ? ALT[alt++ % ALT.length]! : ROLE_COLOR[s.role]));
}

// ---------------------------------------------------------------------------
// 数值格式:$ 用 10k / 9.97k 缩写;% 已是百分数

const trim = (s: string) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);
function abbrev(v: number, digits = 3): string {
  const a = Math.abs(v), sign = v < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}${trim((a / 1e9).toPrecision(digits))}B`;
  if (a >= 1e6) return `${sign}${trim((a / 1e6).toPrecision(digits))}M`;
  if (a >= 1e3) return `${sign}${trim((a / 1e3).toPrecision(digits))}k`;
  return `${sign}${trim(a >= 100 ? a.toFixed(0) : a.toPrecision(Math.min(digits, 3)))}`;
}
/** 悬停/标签用:带单位符号 */
export function formatChartValue(v: number | null | undefined, unit: LoopChart['y_unit']): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (unit === '$') return v < 0 ? `-$${abbrev(-v)}` : `$${abbrev(v)}`;
  if (unit === '%') return `${v > 0 ? '+' : ''}${Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(1)}%`;
  if (unit === 'count') return Math.round(v).toLocaleString('zh-CN');
  return trim(v.toFixed(Math.abs(v) < 10 ? 3 : 1));
}
/** 坐标轴刻度:$ 轴只写 10k(轴标题已写单位),% 轴写 -20% */
function formatTick(v: number, unit: LoopChart['y_unit'], step: number): string {
  if (unit === '$') return abbrev(v, 3);
  const d = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  if (unit === '%') return `${v.toFixed(d)}%`;
  return v.toFixed(d);
}

function niceStep(range: number, count: number): number {
  const raw = range / Math.max(1, count), mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}
function niceTicks(min: number, max: number, count: number): { ticks: number[]; step: number; lo: number; hi: number } {
  if (!(max > min)) { const d = Math.abs(min) * 0.1 || 1; min -= d; max += d; }
  const step = niceStep(max - min, count), lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step, ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : v);
  return { ticks, step, lo, hi };
}
const DAY = 86400000;
function timeTicks(min: number, max: number, count: number): { at: number; label: string }[] {
  const span = max - min, out: { at: number; label: string }[] = [];
  const d0 = new Date(min);
  if (span > 3 * 365 * DAY) {
    const years = span / (365 * DAY), step = [1, 2, 5, 10].find((s) => years / s <= count) ?? 10;
    for (let y = Math.ceil(d0.getUTCFullYear() / step) * step; ; y += step) { const t = Date.UTC(y, 0, 1); if (t > max) break; if (t >= min) out.push({ at: t, label: String(y) }); }
  } else if (span > 60 * DAY) {
    const months = span / (30.4 * DAY), step = [1, 2, 3, 6, 12].find((s) => months / s <= count) ?? 12;
    for (let m = d0.getUTCFullYear() * 12 + d0.getUTCMonth(); ; m++) {
      const t = Date.UTC(Math.floor(m / 12), m % 12, 1); if (t > max) break;
      if (t >= min && (m % 12) % step === 0) out.push({ at: t, label: m % 12 === 0 ? String(Math.floor(m / 12)) : `${Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}` });
    }
  } else {
    const step = Math.max(1, Math.ceil(span / DAY / count));
    for (let t = Math.ceil(min / DAY) * DAY; t <= max; t += step * DAY) { const d = new Date(t); out.push({ at: t, label: `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}` }); }
  }
  return out;
}
function fmtDate(ms: number, span: number): string {
  const d = new Date(ms), ymd = d.toISOString().slice(0, 10);
  return span < 10 * DAY ? `${ymd} ${d.toISOString().slice(11, 16)}` : ymd;
}
const shorten = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const valid = (p: LoopChartSeries['points'][number]) => p[1] !== null && Number.isFinite(Number(p[1]));

function mix(a: string, b: string, t: number): string {
  const h = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const [x, y] = [h(a), h(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i]! - v) * t)).join(',')})`;
}

// ---------------------------------------------------------------------------

export function ResearchChart({ chart, height = 320, framed = true, className }: { chart: ResearchChartSpec; height?: number; framed?: boolean; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(720);
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());
  const [hover, setHover] = useState<{ px: number; py: number } | null>(null);
  const [shareState, setShareState] = useState<string | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => { const w = Math.floor(e!.contentRect.width); if (w > 0) setWidth(w); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const narrow = width <= 520;
  const colors = useMemo(() => seriesColors(chart.series), [chart.series]);
  const H = Math.max(narrow ? 220 : 240, height);
  const W = Math.max(280, width);
  const pad = narrow ? { l: 50, r: 10, t: 14, b: 44 } : { l: 70, r: 18, t: 16, b: 52 };
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
  const unit = chart.y_unit;

  const model = useMemo(() => {
    const shown = chart.series.map((s, i) => ({ s, i, color: colors[i]! })).filter((x) => !hidden.has(x.i));
    if (chart.type === 'heatmap') {
      const hm = chart.heatmap;
      if (!hm || !hm.y.length) return null;
      const vals = hm.z.flat().filter((v): v is number => v !== null && Number.isFinite(v));
      return { kind: 'heatmap' as const, hm, maxAbs: Math.max(1e-9, ...vals.map(Math.abs)) };
    }
    if (!shown.length) return null;
    const cats = chart.x === 'category' ? [...new Set(chart.series.flatMap((s) => s.points.map((p) => String(p[0]))))] : [];
    const xs = chart.x === 'category' ? [] : shown.flatMap(({ s }) => s.points.map((p) => Number(p[0]))).filter(Number.isFinite);
    const ys = shown.flatMap(({ s }) => s.points.filter(valid).map((p) => Number(p[1])));
    for (const a of chart.annotations) if (a.type === 'hline' && typeof a.y === 'number') ys.push(a.y);
    if (!ys.length) return null;
    let yMin = Math.min(...ys), yMax = Math.max(...ys);
    if (chart.type === 'bar') { yMin = Math.min(0, yMin); yMax = Math.max(0, yMax); const extra = (yMax - yMin) * 0.12; if (yMax > 0) yMax += extra; if (yMin < 0) yMin -= extra; }
    const yt = niceTicks(yMin, yMax, narrow ? 4 : 6);
    const xMin = xs.length ? Math.min(...xs) : 0, xMax = xs.length ? Math.max(...xs) : 1;
    const xPad = chart.x === 'linear' ? Math.max(0.5, (xMax - xMin) * 0.02) : 0;
    const x0 = xMin - xPad, x1 = xMax + xPad;
    const band = cats.length ? plotW / cats.length : 0;
    const sx = (x: number | string | null) => chart.x === 'category' ? pad.l + (cats.indexOf(String(x)) + 0.5) * band : pad.l + ((Number(x) - x0) / (x1 - x0 || 1)) * plotW;
    const sy = (y: number) => pad.t + (1 - (y - yt.lo) / (yt.hi - yt.lo || 1)) * plotH;
    const xt = chart.x === 'time' ? timeTicks(xMin, xMax, narrow ? 4 : 7) : chart.x === 'linear' ? niceTicks(Math.max(1, xMin), xMax, narrow ? 4 : 8).ticks.filter((v) => v >= xMin && v <= xMax && Number.isInteger(v)).map((v) => ({ at: v, label: String(v) })) : [];
    return { kind: 'xy' as const, shown, cats, band, sx, sy, yt, xt, xMin, xMax, x0, x1 };
  }, [chart, colors, hidden, narrow, plotW, plotH, pad.l, pad.t]);

  // 统一悬停:时间/数值轴吸附到最近的 x,类目轴按类目;散点取最近的点
  const hoverInfo = useMemo(() => {
    if (!hover || !model) return null;
    if (model.kind === 'heatmap') {
      const { hm } = model, cw = plotW / hm.x.length, ch = plotH / hm.y.length;
      const c = Math.floor((hover.px - pad.l) / cw), r = Math.floor((hover.py - pad.t) / ch);
      if (c < 0 || r < 0 || c >= hm.x.length || r >= hm.y.length) return null;
      return { x: pad.l + (c + 0.5) * cw, header: `${hm.y[r]} ${hm.x[c]}`, rows: [{ color: null as string | null, name: '收益', value: formatChartValue(hm.z[r]?.[c] ?? null, unit), extra: null as string | null, mode: 'bar' as const }] };
    }
    if (chart.type === 'scatter') {
      let best: { d: number; si: number; pi: number } | null = null;
      for (const { s, i } of model.shown) s.points.forEach((p, pi) => { if (!valid(p)) return; const d = Math.hypot(model.sx(p[0]) - hover.px, model.sy(Number(p[1])) - hover.py); if (d < 28 && (!best || d < best.d)) best = { d, si: i, pi }; });
      if (!best) return null;
      const { si, pi } = best as { si: number; pi: number }, s = chart.series[si]!, p = s.points[pi]!;
      const role = s.point_roles?.[pi];
      return { x: model.sx(p[0]), y: model.sy(Number(p[1])), header: `${chart.x_title} ${p[0]}`, rows: [{ color: role === 'negative' ? NEG : role === 'positive' ? POS : colors[si]!, name: s.name, value: formatChartValue(Number(p[1]), unit), extra: s.hover?.[pi] ?? null, mode: 'scatter' as const }] };
    }
    if (chart.x === 'category') {
      const idx = Math.floor((hover.px - pad.l) / (model.band || 1));
      const cat = model.cats[idx];
      if (cat === undefined) return null;
      return { x: model.sx(cat), header: cat, rows: model.shown.map(({ s, color }) => { const pi = s.points.findIndex((p) => String(p[0]) === cat); const p = s.points[pi]; return { color: s.point_roles?.[pi] === 'negative' ? NEG : s.point_roles?.[pi] === 'positive' ? POS : color, name: s.name, value: formatChartValue(p ? (p[1] as number | null) : null, unit), extra: s.labels?.[pi] ?? null, mode: s.mode }; }) };
    }
    const xv = model.x0 + ((hover.px - pad.l) / plotW) * (model.x1 - model.x0);
    // 吸附:取所有可见序列里离鼠标最近的 x
    let snap: number | null = null;
    for (const { s } of model.shown) for (const p of s.points) { const x = Number(p[0]); if (Number.isFinite(x) && (snap === null || Math.abs(x - xv) < Math.abs(snap - xv))) snap = x; }
    if (snap === null) return null;
    const near = (pts: LoopChartSeries['points']) => { let b: LoopChartSeries['points'][number] | undefined; for (const p of pts) { const x = Number(p[0]); if (Number.isFinite(x) && (!b || Math.abs(x - snap!) < Math.abs(Number(b[0]) - snap!))) b = p; } return b; };
    const span = model.xMax - model.xMin;
    return {
      x: model.sx(snap), header: chart.x === 'time' ? fmtDate(snap, span) : `${chart.x_title} ${snap}`,
      rows: model.shown.map(({ s, color }) => { const p = near(s.points); return { color, name: s.name, value: formatChartValue(p ? (p[1] as number | null) : null, unit), extra: null, mode: s.mode }; }),
      points: model.shown.map(({ s, color }) => { const p = near(s.points); return p && valid(p) ? { cx: model.sx(p[0]), cy: model.sy(Number(p[1])), color } : null; }).filter(Boolean) as { cx: number; cy: number; color: string }[],
    };
  }, [hover, model, chart, colors, unit, plotW, plotH, pad.l, pad.t]);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W, py = ((e.clientY - r.top) / r.height) * H;
    setHover(px >= pad.l && px <= W - pad.r && py >= pad.t && py <= H - pad.b ? { px, py } : null);
  };

  const legend = chart.type === 'heatmap' ? [] : chart.series.map((s, i) => ({ i, s, color: colors[i]! }));
  const polarity = chart.series.some((s) => s.point_roles?.length);

  async function share() {
    const svg = svgRef.current;
    if (!svg) return;
    try {
      const blob = await chartPng(svg, W, H, chart, legend.filter((l) => !hidden.has(l.i)).map((l) => ({ name: l.s.name, color: l.color })));
      const ok = await copyPng(blob);
      if (!ok) downloadPng(blob, chart.title);
      setShareState(ok ? '已复制 PNG' : '已下载 PNG');
    } catch {
      setShareState('导出失败');
    }
    setTimeout(() => setShareState(null), 1800);
  }

  // 悬停框放在光标空间更大的一侧,宽度不超过那一侧;两侧都放不下(窄屏)就横跨整个图上沿
  const tip = (() => {
    if (!hoverInfo) return null;
    const right = hoverInfo.x > W / 2, room = (right ? hoverInfo.x : W - hoverInfo.x) - 20;
    if (room < 220) return { left: 8, right: 8, maxWidth: undefined as number | undefined };
    return right ? { left: undefined, right: W - hoverInfo.x + 12, maxWidth: room } : { left: hoverInfo.x + 12, right: undefined, maxWidth: room };
  })();

  return (
    <figure className={cn('research-chart relative m-0', framed && 'rounded-2xl border border-white/10', className)} style={{ background: BG, color: INK }} data-template={chart.template}>
      <div className="flex items-start justify-end px-3 pt-3">
        {shareState ? <span className="mr-2 self-center text-[11px]" style={{ color: INK_2 }}>{shareState}</span> : null}
        <button type="button" onClick={share} className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 px-2.5 py-1 text-[12px] hover:bg-white/5" style={{ color: INK }} title="复制图表 PNG(不支持时下载)">
          Share <Share className="size-3.5" />
        </button>
      </div>
      <div ref={box} className="relative px-1">
        {!model ? (
          <div className="flex min-h-40 items-center justify-center p-4 text-xs" style={{ color: INK_2 }}>{hidden.size ? '点击图例重新显示序列' : '这张图没有可绘制的数据'}</div>
        ) : (
          <svg ref={svgRef} role="img" aria-label={chart.title} viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: 'block', fontFamily: 'ui-sans-serif, system-ui, -apple-system, "PingFang SC", sans-serif' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
            <title>{chart.title}</title>
            {model.kind === 'heatmap' ? <Heatmap model={model} pad={pad} plotW={plotW} plotH={plotH} unit={unit} narrow={narrow} /> : (
              <>
                {/* 网格与刻度 */}
                {model.yt.ticks.map((v) => <g key={`y${v}`}><line x1={pad.l} x2={W - pad.r} y1={model.sy(v)} y2={model.sy(v)} stroke={v === 0 && chart.type !== 'line' ? AXIS : GRID} /><text x={pad.l - 8} y={model.sy(v) + 4} fontSize={narrow ? 10 : 12} textAnchor="end" fill={INK_3}>{formatTick(v, unit, model.yt.step)}</text></g>)}
                {model.xt.map((t, i) => <g key={`x${i}`}><line x1={model.sx(t.at)} x2={model.sx(t.at)} y1={pad.t} y2={H - pad.b} stroke={GRID} /><text x={model.sx(t.at)} y={H - pad.b + 16} fontSize={narrow ? 10 : 12} textAnchor="middle" fill={INK_3}>{t.label}</text></g>)}
                {chart.x === 'category' ? model.cats.map((c) => <text key={c} x={model.sx(c)} y={H - pad.b + 16} fontSize={narrow ? 10 : 12} textAnchor="middle" fill={INK_2}>{shorten(c, Math.max(4, Math.floor(model.band / (narrow ? 8 : 9))))}</text>) : null}
                <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke={AXIS} />
                {/* 轴标题 */}
                <text x={pad.l + plotW / 2} y={H - 8} fontSize={narrow ? 11 : 13} textAnchor="middle" fill={INK_2} fontWeight={500}>{chart.x_title}</text>
                <text transform={`translate(${narrow ? 11 : 15},${pad.t + plotH / 2}) rotate(-90)`} fontSize={narrow ? 11 : 13} textAnchor="middle" fill={INK_2} fontWeight={500}>{chart.y_title}</text>
                {/* 参考横线 */}
                {chart.annotations.filter((a) => a.type === 'hline' && typeof a.y === 'number').map((a, i) => <line key={`h${i}`} x1={pad.l} x2={W - pad.r} y1={model.sy(a.y!)} y2={model.sy(a.y!)} stroke={AXIS} strokeWidth={1} />)}
                {/* 图元 */}
                {model.shown.map(({ s, i, color }) => <SeriesMarks key={i} s={s} color={color} model={model} nSeries={model.shown.length} order={model.shown.findIndex((x) => x.i === i)} narrow={narrow} unit={unit} />)}
                {/* 分界竖线 */}
                {chart.annotations.filter((a) => a.type === 'vline' && a.x !== undefined).map((a, i) => {
                  const x = model.sx(a.x as number);
                  if (!(x >= pad.l && x <= W - pad.r)) return null;
                  return <g key={`v${i}`}><line x1={x} x2={x} y1={pad.t} y2={H - pad.b} stroke={ROLE_COLOR.split} strokeOpacity={0.75} strokeDasharray="4 3" strokeWidth={1.4} />{a.label ? <g><rect x={x + 3} y={pad.t + 1} width={a.label.length * (narrow ? 10 : 11) + 6} height={15} rx={3} fill={BG} fillOpacity={0.85} /><text x={x + 6} y={pad.t + 12} fontSize={narrow ? 10 : 11} fill={INK_2}>{a.label}</text></g> : null}</g>;
                })}
                {/* 悬停 */}
                {hoverInfo && chart.type !== 'scatter' ? <line data-hover x1={hoverInfo.x} x2={hoverInfo.x} y1={pad.t} y2={H - pad.b} stroke={INK} strokeOpacity={0.55} strokeDasharray="3 3" /> : null}
                {hoverInfo && 'points' in hoverInfo ? hoverInfo.points!.map((p, i) => <circle data-hover key={i} cx={p.cx} cy={p.cy} r={3.5} fill={p.color} stroke={BG} strokeWidth={1.5} />) : null}
                {hoverInfo && 'y' in hoverInfo && hoverInfo.y !== undefined ? <circle data-hover cx={hoverInfo.x} cy={hoverInfo.y} r={6} fill="none" stroke={INK} strokeOpacity={0.8} /> : null}
                <rect x={pad.l} y={pad.t} width={plotW} height={plotH} fill="transparent" />
              </>
            )}
            {model.kind === 'heatmap' ? <rect x={pad.l} y={pad.t} width={plotW} height={plotH} fill="transparent" /> : null}
          </svg>
        )}
        {hoverInfo ? (
          <div className="pointer-events-none absolute z-10 rounded-lg border border-white/10 px-3 py-2 shadow-xl" style={{ top: 8, left: tip?.left, right: tip?.right, maxWidth: tip?.maxWidth, background: 'rgba(38,40,46,0.96)', color: INK }}>
            <div className="mb-1 text-[12.5px] font-medium">{hoverInfo.header}</div>
            {hoverInfo.rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2 text-[12px] leading-5 whitespace-nowrap">
                {r.color ? <Swatch color={r.color} mode={r.mode} /> : null}
                <span className="min-w-0 truncate" style={{ color: INK_2 }}>{shorten(r.name, narrow ? 16 : 26)}</span>
                <span className="num font-medium">: {r.value}</span>
                {r.extra ? <span style={{ color: INK_3 }}>· {r.extra}</span> : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {legend.length > 1 || polarity ? (
        <div className="flex flex-wrap justify-center gap-x-5 gap-y-1 px-3 pt-1 pb-1 text-[12.5px]">
          {polarity && legend.length <= 1
            ? [['盈利', POS], ['亏损', NEG]].map(([n, c]) => <span key={n} className="inline-flex items-center gap-1.5" style={{ color: INK_2 }}><Swatch color={c!} mode={chart.type === 'scatter' ? 'scatter' : 'bar'} />{n}</span>)
            : legend.map((l) => (
              <button type="button" key={l.i} aria-pressed={!hidden.has(l.i)} onClick={() => setHidden((old) => { const n = new Set(old); if (n.has(l.i)) n.delete(l.i); else if (n.size < legend.length - 1) n.add(l.i); return n; })} className={cn('inline-flex items-center gap-1.5 py-0.5', hidden.has(l.i) && 'opacity-35')} style={{ color: INK }}>
                <Swatch color={l.color} mode={l.s.mode} />{l.s.name}
              </button>
            ))}
        </div>
      ) : null}
      {chart.type === 'heatmap' && model?.kind === 'heatmap' ? <HeatLegend maxAbs={model.maxAbs} unit={unit} /> : null}
      <figcaption className="px-4 pt-2 pb-3 text-center">
        <div className="text-[13px]" style={{ color: INK_2 }}>{chart.title}</div>
        {chart.caption ? <div className="mx-auto mt-1 max-w-3xl text-[11.5px] leading-relaxed" style={{ color: INK_3 }}>{chart.caption}</div> : null}
        {chart.note ? <div className="mx-auto mt-0.5 max-w-3xl text-[11px] leading-relaxed" style={{ color: INK_3 }}>{chart.note}</div> : null}
      </figcaption>
    </figure>
  );
}

function Swatch({ color, mode }: { color: string; mode: LoopChartSeries['mode'] | 'bar' | 'scatter' }) {
  if (mode === 'bar') return <i className="inline-block size-2.5 shrink-0 rounded-[2px]" style={{ background: color }} />;
  if (mode === 'scatter') return <i className="inline-block size-2 shrink-0 rounded-full" style={{ background: color }} />;
  return (
    <svg width="28" height="10" className="shrink-0" aria-hidden>
      <line x1="1" x2="27" y1="5" y2="5" stroke={color} strokeWidth="2" />
      {mode === 'line+markers' ? <circle cx="14" cy="5" r="2.4" fill={color} /> : null}
    </svg>
  );
}

type XY = { sx: (x: number | string | null) => number; sy: (y: number) => number; band: number };
function SeriesMarks({ s, color, model, nSeries, order, narrow, unit }: { s: LoopChartSeries; color: string; model: XY; nSeries: number; order: number; narrow: boolean; unit: LoopChart['y_unit'] }) {
  const roleColor = (pi: number) => (s.point_roles?.[pi] === 'negative' ? NEG : s.point_roles?.[pi] === 'positive' ? POS : color);
  if (s.mode === 'bar') {
    const bw = Math.max(4, Math.min(64, (model.band * 0.62) / nSeries));
    return <g>{s.points.map((p, pi) => {
      if (!valid(p)) return null;
      const v = Number(p[1]), x = model.sx(p[0]) - (bw * nSeries) / 2 + order * bw, y0 = model.sy(0), y1 = model.sy(v);
      const top = Math.min(y0, y1), h = Math.max(1, Math.abs(y1 - y0)), r = Math.min(3, h / 2, bw / 2);
      // 数据端 3px 圆角,基线端直角
      const d = v >= 0
        ? `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${top + h} Z`
        : `M${x},${top} V${top + h - r} Q${x},${top + h} ${x + r},${top + h} H${x + bw - r} Q${x + bw},${top + h} ${x + bw},${top + h - r} V${top} Z`;
      const label = s.labels?.[pi];
      return <g key={pi}>
        <path d={d} fill={roleColor(pi)} fillOpacity={0.9} />
        <text x={x + bw / 2} y={v >= 0 ? top - 6 : top + h + 14} fontSize={narrow ? 10 : 11.5} textAnchor="middle" fill={INK_2}>{label ? `${label} · ${formatChartValue(v, unit)}` : formatChartValue(v, unit)}</text>
      </g>;
    })}</g>;
  }
  if (s.mode === 'scatter') return <g>{s.points.map((p, pi) => valid(p) ? <circle key={pi} cx={model.sx(p[0])} cy={model.sy(Number(p[1]))} r={narrow ? 3 : 3.8} fill={roleColor(pi)} fillOpacity={0.85} stroke={BG} strokeWidth={0.8} /> : null)}</g>;
  let pen = false;
  const d = s.points.map((p) => { if (!valid(p) || !Number.isFinite(Number(p[0]))) { pen = false; return ''; } const c = pen ? 'L' : 'M'; pen = true; return `${c}${model.sx(p[0]).toFixed(1)},${model.sy(Number(p[1])).toFixed(1)}`; }).join('');
  // 带点折线:点太密时等距取点,最多约 90 个,避免糊成一条粗线
  const pts = s.points.filter(valid);
  const every = Math.max(1, Math.ceil(pts.length / 90));
  return <g>
    <path d={d} fill="none" stroke={color} strokeWidth={s.role === 'benchmark' ? 1.6 : 1.9} strokeLinejoin="round" />
    {s.mode === 'line+markers' ? pts.map((p, i) => (i % every === 0 || i === pts.length - 1 ? <circle key={i} cx={model.sx(p[0])} cy={model.sy(Number(p[1]))} r={2.2} fill={color} /> : null)) : null}
  </g>;
}

function heatColor(v: number | null, maxAbs: number): string {
  if (v === null) return 'rgba(255,255,255,0.03)';
  const t = Math.min(1, Math.abs(v) / maxAbs);
  return mix('#2a2d33', v >= 0 ? POS : NEG, 0.15 + 0.85 * t);
}
function Heatmap({ model, pad, plotW, plotH, unit, narrow }: { model: { hm: NonNullable<LoopChart['heatmap']>; maxAbs: number }; pad: { l: number; t: number }; plotW: number; plotH: number; unit: LoopChart['y_unit']; narrow: boolean }) {
  const { hm, maxAbs } = model, cw = plotW / hm.x.length, ch = plotH / hm.y.length;
  return <g>
    {hm.y.map((y, r) => <text key={y} x={pad.l - 8} y={pad.t + (r + 0.5) * ch + 4} fontSize={narrow ? 10 : 12} textAnchor="end" fill={INK_3}>{y}</text>)}
    {hm.x.map((x, c) => <text key={x} x={pad.l + (c + 0.5) * cw} y={pad.t + plotH + 16} fontSize={narrow ? 9 : 11} textAnchor="middle" fill={INK_3}>{narrow ? x.replace('月', '') : x}</text>)}
    {hm.z.map((row, r) => row.map((v, c) => <g key={`${r}-${c}`}>
      <rect x={pad.l + c * cw + 1} y={pad.t + r * ch + 1} width={Math.max(0, cw - 2)} height={Math.max(0, ch - 2)} rx={3} fill={heatColor(v, maxAbs)} />
      {v !== null && cw >= 36 && ch >= 16 ? <text x={pad.l + (c + 0.5) * cw} y={pad.t + (r + 0.5) * ch + 4} fontSize={10.5} textAnchor="middle" fill={INK}>{formatChartValue(v, unit).replace('+', '')}</text> : null}
    </g>))}
  </g>;
}
function HeatLegend({ maxAbs, unit }: { maxAbs: number; unit: LoopChart['y_unit'] }) {
  return <div className="flex items-center justify-center gap-2 px-3 pt-1 text-[11px]" style={{ color: INK_3 }}>
    <span>{formatChartValue(-maxAbs, unit)}</span>
    <i className="inline-block h-2 w-40 rounded-sm" style={{ background: `linear-gradient(90deg, ${NEG}, #2a2d33, ${POS})` }} />
    <span>{formatChartValue(maxAbs, unit)}</span>
  </div>;
}

// ---------------------------------------------------------------------------
// Share:SVG 序列化到 canvas,补上图例与标题,复制 PNG 到剪贴板(不支持时下载)

async function chartPng(svg: SVGSVGElement, W: number, H: number, chart: ResearchChartSpec, legend: { name: string; color: string }[]): Promise<Blob> {
  const scale = 2, titleH = 34;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.querySelectorAll('[data-hover]').forEach((n) => n.remove()); // 悬停十字线不进导出图
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(W));
  clone.setAttribute('height', String(H));
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
  const img = new Image();
  await new Promise<void>((ok, fail) => { img.onload = () => ok(); img.onerror = () => fail(new Error('svg_load_failed')); img.src = url; });
  // 图例按宽度折行排好,再定画布高度
  const font = '12px ui-sans-serif, system-ui, "PingFang SC", sans-serif';
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const rows: { l: { name: string; color: string }; w: number }[][] = [];
  if (legend.length > 1) for (const l of legend) {
    const w = 30 + measure.measureText(l.name).width + 18, row = rows.at(-1);
    if (row && row.reduce((a, x) => a + x.w, 0) + w <= W - 16) row.push({ l, w }); else rows.push([{ l, w }]);
  }
  const legendH = rows.length * 22 + (rows.length ? 8 : 0);
  const canvas = document.createElement('canvas');
  canvas.width = W * scale; canvas.height = (H + legendH + titleH + 12) * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H + legendH + titleH + 12);
  ctx.drawImage(img, 0, 6, W, H);
  ctx.font = font;
  ctx.textBaseline = 'middle';
  rows.forEach((row, r) => {
    let x = Math.max(8, (W - row.reduce((a, b) => a + b.w, 0)) / 2);
    const y = H + 14 + r * 22;
    for (const { l, w } of row) { ctx.strokeStyle = l.color; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 24, y); ctx.stroke(); ctx.fillStyle = INK; ctx.fillText(l.name, x + 30, y); x += w; }
  });
  ctx.fillStyle = INK_2; ctx.font = '13px ui-sans-serif, system-ui, "PingFang SC", sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(chart.title, W / 2, H + 6 + legendH + titleH / 2);
  return await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error('png_failed'))), 'image/png'));
}
async function copyPng(blob: Blob): Promise<boolean> {
  try {
    const C = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
    if (!C || !navigator.clipboard?.write) return false;
    await navigator.clipboard.write([new C({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}
function downloadPng(blob: Blob, title: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${title.replace(/[\\/:*?"<>|\s]+/g, '_')}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
