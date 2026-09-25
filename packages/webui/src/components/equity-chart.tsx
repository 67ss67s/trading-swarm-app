/** 复盘页的权益曲线:lightweight-charts 面积图,颜色按整段净盈亏定(赚绿亏红)。 */
import { useEffect, useRef } from 'react';
import { AreaSeries, ColorType, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { EquityPoint } from '@/api/types';
import { CHART_COLORS } from '@/lib/chart-colors';

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function EquityChart({ points }: { points: EquityPoint[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const colors = CHART_COLORS.dark;
    const chart = createChart(container, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: colors.text, fontSize: 11 },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: colors.border },
      timeScale: { borderColor: colors.border, timeVisible: true, secondsVisible: false },
      autoSize: true,
      handleScroll: { mouseWheel: false },
    });
    const series = chart.addSeries(AreaSeries, { lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const colors = CHART_COLORS.dark;
    // 去重 + 升序(同一秒只留最后一个点)
    const bySec = new Map<number, number>();
    for (const p of points) bySec.set(Math.floor(p.at / 1000), p.equity);
    const data = [...bySec.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ time: t as UTCTimestamp, value: v }));
    const first = data[0]?.value ?? 0;
    const last = data[data.length - 1]?.value ?? 0;
    const color = last >= first ? colors.up : colors.down;
    series.applyOptions({ lineColor: color, topColor: hexToRgba(color, 0.35), bottomColor: hexToRgba(color, 0.02) });
    series.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [points]);

  return <div ref={containerRef} className="h-full min-h-0 w-full" />;
}
