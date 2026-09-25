/**
 * K 线图(精简版,仿 8793 trade-chart.tsx 但砍掉深历史翻页/拖拽改价——那些需要 userTrades / 挂单
 * 改价接口,这里没有):蜡烛图 + 线程的入场/止损/止盈/出场价格线 + 开平仓标记。
 *
 * 两种用法:
 *   - 交易页:live=true(默认),每 5 秒刷新最近 300 根;
 *   - 复盘页:live=false + endTime(线程结束时间往后几根),只加载一次,叠加 markers。
 */
import { useEffect, useRef, useState } from 'react';
import {
  type CandlestickData,
  CandlestickSeries,
  ColorType,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { api } from '@/api/client';
import { useIndicatorOverlays } from '@/components/indicator-overlays';
import { CHART_COLORS } from '@/lib/chart-colors';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

const INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h'] as const;
type Interval = (typeof INTERVALS)[number];

const REFRESH_MS = 5_000;

export interface TradeChartLines {
  entryPrice?: string | null;
  entryZone?: [string, string] | null;
  stopPrice?: string | null;
  takeProfits?: string[];
  exitPrice?: string | null;
}

export interface TradeChartMarker {
  /** unix 毫秒;会对齐到所在 K 线的开盘时间 */
  at: number;
  kind: 'entry' | 'exit' | 'sl' | 'tp' | 'note';
  text: string;
  side?: 'long' | 'short';
}

export function intervalMs(tf: string): number {
  const n = Number(tf.slice(0, -1));
  const u = tf.slice(-1);
  const unit = u === 'm' ? 60_000 : u === 'h' ? 3_600_000 : u === 'd' ? 86_400_000 : 60_000;
  return (Number.isFinite(n) ? n : 1) * unit;
}

function toInterval(tf: string | undefined, fallback: Interval): Interval {
  return tf && (INTERVALS as readonly string[]).includes(tf) ? (tf as Interval) : fallback;
}

export function TradeChart({
  symbol,
  timeframe = '15m',
  lines,
  markers,
  endTime,
  limit = 300,
  live = true,
  showIntervals = true,
  showOverlays = true,
  className,
}: {
  symbol: string;
  timeframe?: Interval | string;
  lines?: TradeChartLines;
  markers?: TradeChartMarker[];
  endTime?: number;
  limit?: number;
  live?: boolean;
  showIntervals?: boolean;
  /** 复盘页那张图自己管叠加,所以能把这排 chip 关掉。 */
  showOverlays?: boolean;
  className?: string;
}) {
  const [interval, setInterval] = useState<Interval>(toInterval(timeframe, '15m'));
  useEffect(() => {
    if ((INTERVALS as readonly string[]).includes(timeframe)) setInterval(timeframe as Interval);
  }, [timeframe]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 叠加层要等 chart 真建出来才能挂线,而 ref 变了不会触发重渲染,所以另外用 state 广播一次就绪。
  const [chartApi, setChartApi] = useState<{ chart: IChartApi; series: ISeriesApi<'Candlestick'> } | null>(null);

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
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      borderVisible: false,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);
    setChartApi({ chart, series });
    return () => {
      setChartApi(null);
      markersRef.current?.detach();
      markersRef.current = null;
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      priceLinesRef.current = [];
    };
  }, []);

  const overlays = useIndicatorOverlays(chartApi?.chart ?? null, chartApi?.series ?? null, symbol, interval, { live, limit, endTime });

  // K 线数据:首屏拉 limit 根;往左拖到头(可见区 from < 20)自动再拉更早的 500 根拼在前面(抄 8794 的做法);
  // 5 秒刷新只合并最新那批,不再整份 setData 把拼上的历史冲掉。
  const barsRef = useRef<CandlestickData<UTCTimestamp>[]>([]);
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart || !symbol) return;
    let cancelled = false;
    let loadingEarlier = false;
    let exhausted = false;
    barsRef.current = [];
    setLoaded(false);
    setError(null);
    const toBar = (k: { open_time: number; open: string; high: string; low: string; close: string }): CandlestickData<UTCTimestamp> => ({
      time: Math.floor(k.open_time / 1000) as UTCTimestamp,
      open: Number(k.open),
      high: Number(k.high),
      low: Number(k.low),
      close: Number(k.close),
    });
    const merge = (incoming: CandlestickData<UTCTimestamp>[]) => {
      const map = new Map<number, CandlestickData<UTCTimestamp>>();
      for (const b of barsRef.current) map.set(b.time as number, b);
      for (const b of incoming) map.set(b.time as number, b);
      barsRef.current = [...map.values()].sort((a, b) => (a.time as number) - (b.time as number));
    };
    const load = (first: boolean) => {
      api
        .klines(interval, limit, symbol, endTime)
        .then((resp) => {
          if (cancelled) return;
          merge(resp.klines.map(toBar));
          series.setData(barsRef.current);
          if (first) chart.timeScale().fitContent();
          setLoaded(true);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          console.error('加载 K 线失败', err);
          setError(err instanceof Error ? err.message : String(err));
        });
    };
    const loadEarlier = () => {
      if (loadingEarlier || exhausted || barsRef.current.length === 0) return;
      loadingEarlier = true;
      const firstTime = (barsRef.current[0]!.time as number) * 1000;
      api
        .klines(interval, 500, symbol, firstTime - 1)
        .then((resp) => {
          if (cancelled) return;
          const older = resp.klines.map(toBar).filter((b) => (b.time as number) * 1000 < firstTime);
          if (older.length === 0) {
            exhausted = true;
            return;
          }
          const range = chart.timeScale().getVisibleLogicalRange();
          merge(older);
          series.setData(barsRef.current);
          // 拼上 N 根后逻辑坐标整体右移 N,把可见区挪回去,画面不跳
          if (range) chart.timeScale().setVisibleLogicalRange({ from: range.from + older.length, to: range.to + older.length });
        })
        .catch((err: unknown) => console.error('加载更早 K 线失败', err))
        .finally(() => {
          loadingEarlier = false;
        });
    };
    const onRange = (range: { from: number; to: number } | null) => {
      if (range && range.from < 20) loadEarlier();
    };
    load(true);
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    const timer = live ? window.setInterval(() => load(false), REFRESH_MS) : null;
    return () => {
      cancelled = true;
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      if (timer) window.clearInterval(timer);
    };
  }, [symbol, interval, endTime, limit, live]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const line of priceLinesRef.current) series.removePriceLine(line);
    priceLinesRef.current = [];
    const colors = CHART_COLORS.dark;
    const add = (price: string | null | undefined, color: string, style: LineStyle, title: string) => {
      const n = Number(price);
      if (!price || !Number.isFinite(n) || n <= 0) return;
      priceLinesRef.current.push(series.createPriceLine({ price: n, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    };
    add(lines?.entryPrice, colors.text, LineStyle.Solid, t('入场'));
    if (lines?.entryZone) {
      add(lines.entryZone[0], colors.text, LineStyle.Dotted, t('入场区间'));
      add(lines.entryZone[1], colors.text, LineStyle.Dotted, t('入场区间'));
    }
    add(lines?.stopPrice, colors.down, LineStyle.Dashed, t('止损'));
    (lines?.takeProfits ?? []).forEach((tp, i) => add(tp, colors.up, LineStyle.Dashed, i === 0 ? t('止盈') : `${t('止盈')}${i + 1}`));
    add(lines?.exitPrice, colors.vwap, LineStyle.Solid, t('出场'));
  }, [lines?.entryPrice, lines?.entryZone, lines?.stopPrice, lines?.takeProfits, lines?.exitPrice, loaded]);

  useEffect(() => {
    const plugin = markersRef.current;
    if (!plugin) return;
    const colors = CHART_COLORS.dark;
    const step = intervalMs(interval);
    const list: SeriesMarker<Time>[] = (markers ?? [])
      .map((m) => {
        const bar = Math.floor(m.at / step) * step;
        const time = Math.floor(bar / 1000) as UTCTimestamp;
        const isLong = m.side !== 'short';
        if (m.kind === 'entry') return { time, position: isLong ? 'belowBar' : 'aboveBar', shape: isLong ? 'arrowUp' : 'arrowDown', color: isLong ? colors.up : colors.down, text: m.text, size: 1.2 } as SeriesMarker<Time>;
        if (m.kind === 'exit') return { time, position: isLong ? 'aboveBar' : 'belowBar', shape: 'circle', color: colors.vwap, text: m.text, size: 1 } as SeriesMarker<Time>;
        if (m.kind === 'sl') return { time, position: 'aboveBar', shape: 'square', color: colors.down, text: m.text, size: 0.9 } as SeriesMarker<Time>;
        if (m.kind === 'tp') return { time, position: 'aboveBar', shape: 'square', color: colors.up, text: m.text, size: 0.9 } as SeriesMarker<Time>;
        return { time, position: 'aboveBar', shape: 'circle', color: colors.text, text: m.text, size: 0.7 } as SeriesMarker<Time>;
      })
      .sort((a, b) => Number(a.time) - Number(b.time));
    plugin.setMarkers(list);
  }, [markers, interval, loaded]);

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className="flex shrink-0 items-center gap-1 px-2 py-1">
        {showIntervals
          ? INTERVALS.map((item) => (
              <button
                key={item}
                onClick={() => setInterval(item)}
                className={cn(
                  'rounded px-1.5 py-0.5 text-[11px] transition-colors',
                  interval === item ? 'bg-accent font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {item}
              </button>
            ))
          : null}
        {showOverlays ? (
          <>
            <span className="mx-1 h-3 w-px shrink-0 bg-border" />
            {overlays.available.map((chip) => (
              <button
                key={chip.key}
                onClick={() => overlays.toggle(chip.key)}
                className={cn(
                  'rounded px-1.5 py-0.5 text-[11px] transition-colors',
                  overlays.enabled.includes(chip.key) ? 'bg-accent font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(chip.label)}
              </button>
            ))}
            <span className="mx-1 h-3 w-px shrink-0 bg-border" />
            {overlays.paneAvailable.map((chip) => (
              <button
                key={chip.key}
                onClick={() => overlays.togglePane(chip.key)}
                className={cn(
                  'rounded px-1.5 py-0.5 text-[11px] transition-colors',
                  overlays.pane === chip.key ? 'bg-accent font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(chip.label)}
              </button>
            ))}
          </>
        ) : null}
        {error ? <span className="text-[10.5px] text-destructive">{t('K 线加载失败')}:{error}</span> : null}
        {!error && showOverlays && overlays.error ? <span className="text-[10.5px] text-muted-foreground">{t('指标加载失败')}:{overlays.error}</span> : null}
        <span className="num ml-auto text-[10px] text-muted-foreground">
          {symbol}
          {!showIntervals ? ` · ${interval}` : ''}
        </span>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1" />
    </div>
  );
}
