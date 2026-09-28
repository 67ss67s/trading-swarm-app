/**
 * 策略回放 K 线图:蜡烛 + 每个计划的入场 / 止损 / 止盈线段 + 事件标记(用法仿 trade-chart.tsx)。
 * 线型编码:入场未成交 = 灰虚线,成交后 = 方向色实线(多蓝 / 空紫);止损红色阶梯;止盈绿色,一档一条。
 * 非选中计划整体压暗,选中计划单独一组高亮序列叠在最上层,并把视口缩放到它。
 * smc 给了就在蜡烛下层叠 SMC 图层(smc-layer.ts:订单块/FVG 色块、BOS/CHoCH 标签线、溢价/折价区背景)。
 */
import { useEffect, useMemo, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  LineSeries,
  LineStyle,
  LineType,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Logical,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { BacktestCandle, BacktestPlan, BacktestTrade, SmcOverlay } from '@trade-gate/contracts';
import { SmcPrimitive, type SmcLayerKey } from './smc-layer';
import { CHART_COLORS } from '@/lib/chart-colors';
import { cn } from '@/lib/utils';
import { hexAlpha } from './format';
import {
  LONG_COLOR,
  PENDING_COLOR,
  SHORT_COLOR,
  STOP_COLOR,
  TP_COLOR,
  assignLanes,
  planMarkers,
  planSegments,
  planSpan,
  segmentsToSeries,
  snapIndex,
  tradeMarkers,
  type ReplayMarker,
  type Seg,
} from './replay-model';

function roleStyle(seg: Pick<Seg, 'role' | 'side'>, focus: boolean): { color: string; style: LineStyle; width: 1 | 2; step: boolean } {
  const a = focus ? 1 : 0.38;
  if (seg.role === 'entry_pending') return { color: hexAlpha(PENDING_COLOR, focus ? 0.95 : 0.4), style: LineStyle.Dashed, width: 1, step: false };
  if (seg.role === 'entry_filled') return { color: hexAlpha(seg.side === 'long' ? LONG_COLOR : SHORT_COLOR, a), style: LineStyle.Solid, width: focus ? 2 : 1, step: false };
  if (seg.role === 'stop') return { color: hexAlpha(STOP_COLOR, a), style: LineStyle.Solid, width: focus ? 2 : 1, step: true };
  return { color: hexAlpha(TP_COLOR, a), style: LineStyle.Dotted, width: focus ? 2 : 1, step: false };
}

function toLw(m: ReplayMarker, focus: boolean): SeriesMarker<Time> {
  return { time: m.time as UTCTimestamp, position: m.position, shape: m.shape, color: focus ? m.color : hexAlpha(m.color.startsWith('#') ? m.color : '#97a3b4', 0.55), text: m.text, size: focus ? 1.2 : 0.8, id: m.planId ?? undefined };
}

export interface ReplayChartProps {
  candles: BacktestCandle[];
  plans: BacktestPlan[];
  /** plans 为空时退回只画成交点 */
  trades: BacktestTrade[];
  symbol: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  className?: string;
  /** SMC 图层数据;null/缺省不画 */
  smc?: SmcOverlay | null;
  smcLayers?: Set<SmcLayerKey>;
}

export function ReplayChart({ candles, plans, trades, symbol, selectedId, onSelect, className, smc, smcLayers }: ReplayChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const lineRefs = useRef<ISeriesApi<'Line'>[]>([]);
  const focusRefs = useRef<ISeriesApi<'Line'>[]>([]);
  const smcRef = useRef<SmcPrimitive | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const model = useMemo(() => {
    if (!candles.length) return null;
    const spans = plans.map((p) => planSpan(p, candles));
    const lanes = assignLanes(spans);
    const segsByPlan = new Map<string, Seg[]>();
    for (const p of plans) segsByPlan.set(p.id, planSegments(p, candles));
    // 泳道 × 角色 → 线段组
    const groups = new Map<string, Seg[]>();
    for (const p of plans) {
      const lane = lanes.get(p.id) ?? 0;
      for (const s of segsByPlan.get(p.id) ?? []) {
        const k = `${lane}|${s.role}`;
        (groups.get(k) ?? groups.set(k, []).get(k)!).push(s);
      }
    }
    return { spans: new Map(spans.map((s) => [s.planId, s])), segsByPlan, groups };
  }, [candles, plans]);

  // 图表与蜡烛
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const colors = CHART_COLORS.dark;
    const chart = createChart(container, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: colors.text, fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: colors.border },
      timeScale: { borderColor: colors.border, timeVisible: true, secondsVisible: false, minBarSpacing: 0.05 },
      autoSize: true,
      handleScroll: { mouseWheel: true },
    });
    const series = chart.addSeries(CandlestickSeries, { upColor: colors.up, downColor: colors.down, borderVisible: false, wickUpColor: colors.up, wickDownColor: colors.down, priceLineVisible: false });
    chartRef.current = chart;
    candleRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);
    const smcLayer = new SmcPrimitive();
    series.attachPrimitive(smcLayer);
    smcRef.current = smcLayer;
    return () => {
      series.detachPrimitive(smcLayer);
      smcRef.current = null;
      markersRef.current?.detach();
      markersRef.current = null;
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      lineRefs.current = [];
      focusRefs.current = [];
    };
  }, []);

  // SMC 图层数据(K 线 open_time 序列用来把时间换成逻辑下标)
  useEffect(() => {
    smcRef.current?.setModel(smc ?? null, candles.map((c) => c.t), smcLayers ?? new Set(['structure', 'blocks', 'fvg', 'zones', 'levels']), candles.at(-1)?.c ?? NaN);
  }, [smc, smcLayers, candles]);

  // 点击图表:选中覆盖该时刻、最晚挂出的计划
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !model) return;
    const handler = (param: { time?: Time }) => {
      if (param.time === undefined) return;
      const i = snapIndex(candles, Number(param.time) * 1000);
      let best: { id: string; start: number } | null = null;
      for (const s of model.spans.values()) if (i >= s.start && i <= s.end && (!best || s.start > best.start)) best = { id: s.planId, start: s.start };
      if (best) onSelectRef.current(best.id);
    };
    chart.subscribeClick(handler);
    return () => chart.unsubscribeClick(handler);
  }, [model, candles]);

  // 蜡烛 + 全部计划线(压暗)
  useEffect(() => {
    const chart = chartRef.current;
    const series = candleRef.current;
    if (!chart || !series) return;
    series.setData(candles.map((c) => ({ time: Math.floor(c.t / 1000) as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c })));
    for (const s of lineRefs.current) chart.removeSeries(s);
    lineRefs.current = [];
    if (model) {
      for (const [k, segs] of model.groups) {
        const st = roleStyle(segs[0]!, false);
        const s = chart.addSeries(LineSeries, {
          color: st.color,
          lineWidth: st.width,
          lineStyle: st.style,
          lineType: st.step ? LineType.WithSteps : LineType.Simple,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          title: '',
        });
        s.setData(segmentsToSeries(segs, candles).map((p) => (p.value === undefined ? { time: p.time as UTCTimestamp } : { time: p.time as UTCTimestamp, value: p.value })));
        void k;
        lineRefs.current.push(s);
      }
    }
    chart.timeScale().fitContent();
  }, [candles, model]);

  // 选中计划:高亮序列 + 标记 + 视口
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !candles.length) return;
    for (const s of focusRefs.current) chart.removeSeries(s);
    focusRefs.current = [];
    const sel = selectedId && model ? model.segsByPlan.get(selectedId) : undefined;
    for (const seg of sel ?? []) {
      const st = roleStyle(seg, true);
      const s = chart.addSeries(LineSeries, {
        color: st.color,
        lineWidth: st.width,
        lineStyle: st.style,
        lineType: st.step ? LineType.WithSteps : LineType.Simple,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: false,
      });
      s.setData(segmentsToSeries([seg], candles).map((p) => (p.value === undefined ? { time: p.time as UTCTimestamp } : { time: p.time as UTCTimestamp, value: p.value })));
      focusRefs.current.push(s);
    }
    // 标记:选中计划带文字,其余只画形状
    const ms: SeriesMarker<Time>[] = [];
    if (plans.length) {
      for (const p of plans) for (const m of planMarkers(p, candles, p.id === selectedId)) ms.push(toLw(m, !selectedId || p.id === selectedId));
    } else {
      for (const m of tradeMarkers(trades, candles, symbol)) ms.push(toLw(m, !selectedId || m.planId === selectedId));
    }
    markersRef.current?.setMarkers(ms.sort((a, b) => Number(a.time) - Number(b.time)));
    // 缩放到选中计划
    const span = selectedId ? model?.spans.get(selectedId) ?? tradeSpan(trades, selectedId, candles) : null;
    if (span) {
      const pad = Math.max(12, Math.round((span.end - span.start) * 0.8));
      chart.timeScale().setVisibleLogicalRange({ from: (span.start - pad) as Logical, to: (span.end + pad) as Logical });
    }
  }, [selectedId, model, candles, plans, trades, symbol]);

  return <div ref={containerRef} className={cn('h-full min-h-0 w-full', className)} data-testid="replay-chart" />;
}

function tradeSpan(trades: BacktestTrade[], id: string, candles: BacktestCandle[]): { start: number; end: number } | null {
  const tr = trades.find((x) => x.id === id);
  return tr ? { start: snapIndex(candles, tr.entry_at), end: snapIndex(candles, tr.exit_at) } : null;
}
