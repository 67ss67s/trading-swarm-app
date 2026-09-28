/**
 * 研究工作台的权益 / 回撤图:A/B/C 各臂一条线,统一时间轴,鼠标悬停在图例里读数。
 * lightweight-charts 实例自己起(和 equity-chart.tsx 一样的配色与选项),不复用 TradeChart。
 * 数值口径:equity 是净值(费用已扣),drawdown 是小数(0.08 = 8%),bar-close 时刻。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ColorType, LineSeries, LineStyle, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { ResearchArmResult } from '@/api/research-types';
import { CHART_COLORS } from '@/lib/chart-colors';
import { cn } from '@/lib/utils';
import { fmtDateTime } from '@/lib/format';
import { t } from '@/lib/i18n';

/** 臂的家族色:A 冰青、B 琥珀、C 紫;repeat 用同色系变淡。 */
export function armColor(arm: string): string {
  const [kind, rep] = arm.split(':');
  const n = Number(rep ?? 0);
  const base = kind === 'a_rules' ? ['#3f9ac2', '#6fb6d6'] : kind === 'b_agent' ? ['#d9a441', '#e8c383'] : ['#a468e0', '#c39aea'];
  return base[Math.min(n, base.length - 1)]!;
}

export function armLabel(arm: string): string {
  const [kind, rep] = arm.split(':');
  const name = kind === 'a_rules' ? t('A · 固定规则') : kind === 'b_agent' ? t('B · 代理判断') : kind === 'c_filter' ? t('C · 规则+代理筛选') : arm;
  return rep && rep !== '0' ? `${name} #${Number(rep) + 1}` : name;
}

export type ArmChartMode = 'equity' | 'drawdown' | 'exposure';

interface Props {
  arms: ResearchArmResult[];
  visible: Set<string>;
  mode: ArmChartMode;
  /** 差异表点选的时刻:在图上放一根竖线并把视口挪过去 */
  focusAt: number | null;
  initialCash: number;
  className?: string;
}

export function ArmChart({ arms, visible, mode, focusAt, initialCash, className }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const [hover, setHover] = useState<{ time: number; values: Record<string, number> } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const colors = CHART_COLORS.dark;
    const chart = createChart(container, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: colors.text, fontSize: 11 },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: colors.border, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: colors.border, timeVisible: true, secondsVisible: false },
      crosshair: { horzLine: { visible: false, labelVisible: false } },
      autoSize: true,
      handleScroll: { mouseWheel: false },
    });
    chartRef.current = chart;
    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.point) {
        setHover(null);
        return;
      }
      const values: Record<string, number> = {};
      for (const [arm, s] of seriesRef.current) {
        const d = param.seriesData.get(s) as { value?: number } | undefined;
        if (d && typeof d.value === 'number') values[arm] = d.value;
      }
      setHover({ time: Number(param.time) * 1000, values });
    });
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = new Map();
    };
  }, []);

  const data = useMemo(() => {
    const out = new Map<string, { time: UTCTimestamp; value: number }[]>();
    for (const a of arms) {
      const bySec = new Map<number, number>();
      for (const p of a.equity) {
        const v = mode === 'equity' ? (initialCash > 0 ? Number(p.equity) / initialCash - 1 : Number(p.equity)) : mode === 'drawdown' ? -p.drawdown : p.exposure;
        bySec.set(Math.floor(p.at / 1000), v);
      }
      out.set(a.arm, [...bySec.entries()].sort((x, y) => x[0] - y[0]).map(([t, v]) => ({ time: t as UTCTimestamp, value: v })));
    }
    return out;
  }, [arms, mode, initialCash]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const current = seriesRef.current;
    for (const [arm, s] of current) {
      if (!data.has(arm) || !visible.has(arm)) {
        chart.removeSeries(s);
        current.delete(arm);
      }
    }
    for (const [arm, points] of data) {
      if (!visible.has(arm)) continue;
      let s = current.get(arm);
      if (!s) {
        s = chart.addSeries(LineSeries, {
          color: armColor(arm),
          lineWidth: arm.startsWith('a_rules') ? 2 : 2,
          lineStyle: arm.endsWith(':0') || !arm.includes(':') ? LineStyle.Solid : LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: true,
          priceFormat: { type: 'custom', formatter: (v: number) => `${(v * 100).toFixed(2)}%`, minMove: 0.0001 },
        });
        current.set(arm, s);
      }
      s.setData(points);
    }
    chart.timeScale().fitContent();
  }, [data, visible]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || focusAt === null) return;
    const sec = Math.floor(focusAt / 1000) as UTCTimestamp;
    const range = chart.timeScale().getVisibleRange();
    if (range && (sec < Number(range.from) || sec > Number(range.to))) {
      const half = Math.max(1, (Number(range.to) - Number(range.from)) / 2);
      chart.timeScale().setVisibleRange({ from: (sec - half) as UTCTimestamp, to: (sec + half) as UTCTimestamp });
    }
  }, [focusAt]);

  const focusMarker = useMemo(() => {
    if (focusAt === null) return null;
    return fmtDateTime(focusAt);
  }, [focusAt]);

  const pct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;

  return (
    <div className={cn('relative h-full min-h-0 w-full', className)}>
      <div ref={containerRef} className="h-full min-h-0 w-full" />
      <div className="pointer-events-none absolute top-1.5 left-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        {[...data.keys()].filter((a) => visible.has(a)).map((arm) => (
          <span key={arm} className="inline-flex items-center gap-1.5">
            <i className="inline-block h-0.5 w-3" style={{ background: armColor(arm) }} />
            <span className="text-muted-foreground">{armLabel(arm)}</span>
            {hover && typeof hover.values[arm] === 'number' ? <span className="num text-foreground">{pct(hover.values[arm]!)}</span> : null}
          </span>
        ))}
        {hover ? <span className="num text-muted-foreground">{fmtDateTime(hover.time)}</span> : focusMarker ? <span className="num text-muted-foreground">{t('定位 {m}', { m: focusMarker })}</span> : null}
      </div>
    </div>
  );
}
