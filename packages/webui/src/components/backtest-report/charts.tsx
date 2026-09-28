/**
 * 回测报告的时间序列图(lightweight-charts,配色 / 选项与 equity-chart.tsx、arm-chart.tsx 一致):
 *   PnlChart        累计收益:策略面积线 / 三资产叠加 + 持有基准虚线,样本内外分段色块,十字光标读数
 *   UnderwaterChart 回撤水下图
 * 分段色块不是图表库自带的:用 timeToIndex + logicalToCoordinate 算出像素位置,叠一层绝对定位 div,
 * 视口平移 / 缩放 / 尺寸变化时重算。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AreaSeries,
  ColorType,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Logical,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { BacktestSegment } from '@trade-gate/contracts';
import { CHART_COLORS } from '@/lib/chart-colors';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { hexAlpha, pctDrawdown, pctSigned, segmentLabel, toneOf, ymd } from './format';
import type { LinePoint, PnlLine, PointInfo } from './series';

const pctFormat = { type: 'custom' as const, formatter: (v: number) => `${(v * 100).toFixed(2)}%`, minMove: 0.0001 };

function useLwChart(containerRef: React.RefObject<HTMLDivElement | null>): React.RefObject<IChartApi | null> {
  const chartRef = useRef<IChartApi | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const colors = CHART_COLORS.dark;
    const chart = createChart(container, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: colors.text, fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.06 } },
      // minBarSpacing 压到很小:几千根日线也要 fitContent 到整段窗口,不能只露出最近一截
      timeScale: { borderColor: colors.border, timeVisible: false, secondsVisible: false, minBarSpacing: 0.01 },
      crosshair: { horzLine: { visible: false, labelVisible: false }, vertLine: { labelVisible: false } },
      autoSize: true,
      handleScroll: { mouseWheel: false },
    });
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [containerRef]);
  return chartRef;
}

interface SegmentBox {
  name: string;
  left: number;
  width: number;
}

/** 分段在当前视口里的像素位置 */
function useSegmentBoxes(chartRef: React.RefObject<IChartApi | null>, segments: BacktestSegment[], dataKey: unknown): SegmentBox[] {
  const [boxes, setBoxes] = useState<SegmentBox[]>([]);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || segments.length === 0) {
      setBoxes([]);
      return;
    }
    const ts = chart.timeScale();
    const compute = () => {
      const width = ts.width();
      const x = (ms: number): number | null => {
        const idx = ts.timeToIndex(Math.floor(ms / 1000) as UTCTimestamp, true);
        if (idx === null) return null;
        return ts.logicalToCoordinate(idx as unknown as Logical);
      };
      const out: SegmentBox[] = [];
      for (const s of segments) {
        const a = x(s.from_ms);
        const b = x(s.to_ms);
        if (a === null || b === null) continue;
        const left = Math.max(0, Math.min(width, a));
        const right = Math.max(0, Math.min(width, b));
        if (right - left < 1) continue;
        out.push({ name: s.name, left, width: right - left });
      }
      setBoxes(out);
    };
    // 等 setData / fitContent 落地之后再算
    const raf = requestAnimationFrame(compute);
    ts.subscribeVisibleLogicalRangeChange(compute);
    ts.subscribeSizeChange(compute);
    return () => {
      cancelAnimationFrame(raf);
      ts.unsubscribeVisibleLogicalRangeChange(compute);
      ts.unsubscribeSizeChange(compute);
    };
  }, [chartRef, segments, dataKey]);
  return boxes;
}

function SegmentOverlay({ boxes }: { boxes: SegmentBox[] }) {
  if (!boxes.length) return null;
  return (
    <div className="pointer-events-none absolute inset-y-0 left-0" aria-hidden>
      {boxes.map((b, i) => (
        <div
          key={`${b.name}-${i}`}
          className={cn('absolute inset-y-0', b.name === 'out_of_sample' ? 'bg-primary/[0.06]' : 'bg-transparent', i > 0 && 'border-l border-dashed border-primary/45')}
          style={{ left: b.left, width: b.width }}
        >
          {/* 标签贴在分界线两侧的顶部:样本内靠右、样本外靠左,不和图例 / 时间轴打架 */}
          {b.width > 48 ? (
            <span className={cn('absolute top-1 text-[10px] tracking-wide whitespace-nowrap', b.name === 'out_of_sample' ? 'left-1.5 text-primary/85' : 'right-1.5 text-muted-foreground/80')}>{segmentLabel(b.name)}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export interface PnlChartProps {
  lines: PnlLine[];
  lookup: Map<string, Map<number, PointInfo>>;
  segments: BacktestSegment[];
  overlay: boolean;
  className?: string;
  /** 图上方的补充内容(无成交提示等),叠在图例下面 */
  notice?: ReactNode;
  /** 受控视口:null = 整段 fitContent;有值 = 只看这段(看区间 / 刷选条联动) */
  visibleRange?: { from_ms: number; to_ms: number } | null;
  /** 用户在图上滚轮缩放 / 拖动平移后回报视口;覆盖整段数据时回报 null */
  onVisibleRangeChange?: (r: { from_ms: number; to_ms: number } | null) => void;
}

interface Hover {
  x: number;
  y: number;
  sec: number;
}

export function PnlChart({ lines, lookup, segments, overlay, className, notice, visibleRange = null, onVisibleRangeChange }: PnlChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useLwChart(containerRef);
  // 程序设置视口(fitContent / setVisibleRange)期间不回报,避免和受控值来回打架
  const quietUntil = useRef(0);
  const onRangeRef = useRef(onVisibleRangeChange);
  onRangeRef.current = onVisibleRangeChange;
  const rangeRef = useRef(visibleRange);
  rangeRef.current = visibleRange;
  const seriesRef = useRef<Map<string, ISeriesApi<'Line'> | ISeriesApi<'Area'>>>(new Map());
  const [hover, setHover] = useState<Hover | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const handler = (param: Parameters<Parameters<IChartApi['subscribeCrosshairMove']>[0]>[0]) => {
      if (!param.time || !param.point) {
        setHover(null);
        return;
      }
      setHover({ x: param.point.x, y: param.point.y, sec: Number(param.time) });
      setWidth(chart.timeScale().width());
    };
    chart.subscribeCrosshairMove(handler);
    return () => chart.unsubscribeCrosshairMove(handler);
  }, [chartRef]);

  const dataKey = useMemo(() => lines.map((l) => `${l.id}:${l.color}:${l.points.length}:${l.points[0]?.time ?? ''}:${l.points[l.points.length - 1]?.value ?? ''}`).join('|'), [lines]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const current = seriesRef.current;
    // 线的组合一变就全部重建(线型 / 面积与否不同),数量少,代价可忽略;旧线在 cleanup 里拆
    for (const l of lines) {
      const data = l.points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }));
      if (l.area) {
        const s = chart.addSeries(AreaSeries, {
          lineColor: l.color,
          topColor: hexAlpha(l.color, 0.32),
          bottomColor: hexAlpha(l.color, 0.02),
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          priceFormat: pctFormat,
          crosshairMarkerRadius: 4,
        });
        s.setData(data);
        current.set(l.id, s);
      } else {
        const s = chart.addSeries(LineSeries, {
          color: l.color,
          lineWidth: l.role === 'benchmark' ? 1 : 2,
          lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: l.role === 'strategy',
          priceFormat: pctFormat,
          crosshairMarkerVisible: l.role === 'strategy',
        });
        s.setData(data);
        current.set(l.id, s);
      }
    }
    quietUntil.current = performance.now() + 250;
    const vr = rangeRef.current;
    if (vr) applyRange(chart, vr);
    else chart.timeScale().fitContent();
    return () => {
      // 图表已经被 useLwChart 拆掉时 chartRef 为 null,只清 map
      const alive = chartRef.current;
      for (const s of current.values()) {
        try {
          alive?.removeSeries(s);
        } catch {
          /* 已随图表销毁 */
        }
      }
      current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartRef, dataKey]);

  // 受控视口 → 图:已经在这个视口(差不到一根)就不动,防止用户拖动时被拉回
  const span = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    let step = Infinity;
    for (const l of lines) {
      const p = l.points;
      if (!p.length) continue;
      lo = Math.min(lo, p[0]!.time);
      hi = Math.max(hi, p[p.length - 1]!.time);
      if (p.length > 1) step = Math.min(step, (p[p.length - 1]!.time - p[0]!.time) / (p.length - 1));
    }
    return Number.isFinite(lo) ? { lo, hi, step: Number.isFinite(step) ? step : 86_400 } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey]);
  const vrKey = visibleRange ? `${visibleRange.from_ms}:${visibleRange.to_ms}` : 'all';
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !span) return;
    const cur = chart.timeScale().getVisibleRange();
    const tol = span.step * 1.5;
    if (!visibleRange) {
      if (cur && Number(cur.from) <= span.lo + tol && Number(cur.to) >= span.hi - tol) return;
      quietUntil.current = performance.now() + 250;
      chart.timeScale().fitContent();
      return;
    }
    const f = visibleRange.from_ms / 1000;
    const to = visibleRange.to_ms / 1000;
    if (cur && Math.abs(Number(cur.from) - f) <= tol && Math.abs(Number(cur.to) - to) <= tol) return;
    quietUntil.current = performance.now() + 250;
    applyRange(chart, visibleRange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartRef, vrKey, span]);

  // 图 → 受控视口:用户缩放 / 平移;rAF 合并一帧内的多次回调
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !span) return;
    const ts = chart.timeScale();
    let raf = 0;
    const handler = () => {
      if (performance.now() < quietUntil.current || !onRangeRef.current) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = ts.getVisibleRange();
        if (!r) return;
        const tol = span.step * 1.5;
        const from = Math.max(Number(r.from), span.lo);
        const to = Math.min(Number(r.to), span.hi);
        if (from <= span.lo + tol && to >= span.hi - tol) onRangeRef.current?.(null);
        else if (to > from) onRangeRef.current?.({ from_ms: from * 1000, to_ms: to * 1000 });
      });
    };
    ts.subscribeVisibleTimeRangeChange(handler);
    return () => {
      cancelAnimationFrame(raf);
      ts.unsubscribeVisibleTimeRangeChange(handler);
    };
  }, [chartRef, span]);

  const boxes = useSegmentBoxes(chartRef, segments, dataKey);

  const strategyLines = lines.filter((l) => l.role === 'strategy');
  const benchLines = lines.filter((l) => l.role === 'benchmark');

  return (
    <div className={cn('relative h-full min-h-0 w-full', className)}>
      <SegmentOverlay boxes={boxes} />
      <div ref={containerRef} className="h-full min-h-0 w-full" />
      {/* 图例(左上,Horizon 同位置);线型是颜色之外的第二编码 */}
      <div className="pointer-events-none absolute top-1.5 left-2 flex flex-col gap-1">
        <div className="flex flex-col gap-0.5 rounded-md border border-border/60 bg-card/80 px-2 py-1 text-[11px] backdrop-blur-sm" data-testid="pnl-legend">
          {strategyLines.map((l) => (
            <span key={l.id} className="inline-flex items-center gap-1.5">
              <i className="inline-block h-0.5 w-3.5 rounded-full" style={{ background: l.color }} />
              <span className="text-foreground/90">{overlay ? l.label : t('策略')}</span>
            </span>
          ))}
          {overlay
            ? benchLines.length > 0 && (
                <span className="inline-flex items-center gap-1.5">
                  <i className="inline-block w-3.5 border-t border-dashed border-muted-foreground" />
                  <span className="text-muted-foreground">{t('持有基准(同色虚线)')}</span>
                </span>
              )
            : benchLines.map((l) => (
                <span key={l.id} className="inline-flex items-center gap-1.5">
                  <i className="inline-block w-3.5 border-t border-dashed" style={{ borderColor: l.color }} />
                  <span className="text-muted-foreground">{t('{label} 持有基准', { label: l.label })}</span>
                </span>
              ))}
        </div>
        {notice}
      </div>
      {hover ? <HoverCard hover={hover} width={width} lines={strategyLines} lookup={lookup} overlay={overlay} /> : null}
    </div>
  );
}

function applyRange(chart: IChartApi, r: { from_ms: number; to_ms: number }): void {
  try {
    chart.timeScale().setVisibleRange({ from: Math.floor(r.from_ms / 1000) as UTCTimestamp, to: Math.floor(r.to_ms / 1000) as UTCTimestamp });
  } catch {
    /* 还没有数据时 setVisibleRange 会抛,下次数据到位再设 */
  }
}

function HoverCard({ hover, width, lines, lookup, overlay }: { hover: Hover; width: number; lines: PnlLine[]; lookup: Map<string, Map<number, PointInfo>>; overlay: boolean }) {
  const rows = lines
    .map((l) => ({ l, info: lookup.get(l.assetKey)?.get(hover.sec) }))
    .filter((r): r is { l: PnlLine; info: PointInfo } => !!r.info);
  if (!rows.length) return null;
  const flip = width > 0 && hover.x > width * 0.6;
  return (
    <div
      className="pointer-events-none absolute z-10 min-w-40 rounded-md border border-border bg-popover/95 px-2.5 py-1.5 text-[11px] shadow-lg backdrop-blur-sm"
      style={{ top: Math.max(4, hover.y - 30), left: flip ? undefined : hover.x + 14, right: flip ? Math.max(4, width - hover.x + 14) : undefined }}
    >
      <div className="num mb-1 text-muted-foreground">{ymd(hover.sec * 1000)}</div>
      {rows.map(({ l, info }) => (
        <div key={l.id} className={cn(overlay && 'mt-1 first:mt-0')}>
          {overlay ? (
            <div className="mb-0.5 inline-flex items-center gap-1.5 text-foreground/90">
              <i className="inline-block h-0.5 w-3 rounded-full" style={{ background: l.color }} />
              {l.label}
            </div>
          ) : null}
          <div className="grid grid-cols-[auto_1fr] gap-x-3">
            <span className="text-muted-foreground">{t('策略')}</span>
            <span className={cn('num text-right', toneOf(info.pnl))}>{pctSigned(info.pnl)}</span>
            <span className="text-muted-foreground">{t('持有基准')}</span>
            <span className={cn('num text-right', toneOf(info.bench))}>{pctSigned(info.bench)}</span>
            <span className="text-muted-foreground">{t('回撤')}</span>
            <span className={cn('num text-right', info.dd > 0 ? 'text-down' : 'text-foreground')}>{pctDrawdown(info.dd)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 回撤水下图:0 在顶,向下是回撤;单资产一条红色面积。 */
export function UnderwaterChart({ points, segments, className }: { points: LinePoint[]; segments: BacktestSegment[]; className?: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useLwChart(containerRef);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const [hover, setHover] = useState<{ x: number; sec: number; v: number } | null>(null);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const color = CHART_COLORS.dark.down;
    const s = chart.addSeries(AreaSeries, {
      lineColor: color,
      topColor: hexAlpha(color, 0.05),
      bottomColor: hexAlpha(color, 0.4),
      invertFilledArea: true,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: pctFormat,
    });
    seriesRef.current = s;
    const handler = (param: Parameters<Parameters<IChartApi['subscribeCrosshairMove']>[0]>[0]) => {
      const d = param.time && param.point ? (param.seriesData.get(s) as { value?: number } | undefined) : undefined;
      if (!param.time || !param.point || typeof d?.value !== 'number') {
        setHover(null);
        return;
      }
      setHover({ x: param.point.x, sec: Number(param.time), v: d.value });
    };
    chart.subscribeCrosshairMove(handler);
    return () => {
      chart.unsubscribeCrosshairMove(handler);
      seriesRef.current = null;
    };
  }, [chartRef]);

  const dataKey = points.length ? `${points[0]!.time}:${points.length}:${points[points.length - 1]!.value}` : 'empty';
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    s.setData(points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    chartRef.current?.timeScale().fitContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartRef, dataKey]);

  const boxes = useSegmentBoxes(chartRef, segments, dataKey);

  return (
    <div className={cn('relative h-full min-h-0 w-full', className)}>
      <SegmentOverlay boxes={boxes} />
      <div ref={containerRef} className="h-full min-h-0 w-full" />
      {hover ? (
        <div className="pointer-events-none absolute top-1.5 left-2 rounded-md border border-border bg-popover/95 px-2 py-1 text-[11px]">
          <span className="num text-muted-foreground">{ymd(hover.sec * 1000)}</span>
          <span className="num ml-2 text-down">{pctDrawdown(hover.v)}</span>
        </div>
      ) : null}
    </div>
  );
}
