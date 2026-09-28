/**
 * 图表指标叠加层(GET /api/market/indicators,docs/demo/v3-ui-contract.md §9.10)。
 *
 * 单独拆一个 hook 而不是写进 trade-chart.tsx:复盘页(pages/replay.tsx)也有一张自己的
 * lightweight-charts,以后要长同样的叠加线。所有对 chart 的增删改都关在这个文件里,调用方只要
 * 把 chart / series 递进来、再把 enabled + toggle 画成一排 chip 就行,不用知道任何 series 生命周期。
 *
 * 两处约定值得单独记一下:
 *  - 网关发的 `t` 是毫秒,lightweight-charts 要秒;
 *  - 网关只发算得出来的点(预热期的 NaN 直接不发),所以各条线的起点不一样、长度也不一样,
 *    只能按 t 自己对齐,不能假设和 K 线一一对应。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type SeriesType,
  type UTCTimestamp,
  type WhitespaceData,
} from 'lightweight-charts';
import { api } from '@/api/client';
import type { IndicatorPoint, IndicatorsResponse } from '@/api/types';
import { CHART_COLORS } from '@/lib/chart-colors';
import { t } from '@/lib/i18n';
import { IS_JUDGE } from '@/lib/edition';

export interface IndicatorChip {
  key: string;
  label: string;
}

/** 画在主图价格轴上的(可以任意多开)。 */
export const OVERLAY_CHIPS: IndicatorChip[] = [
  { key: 'ema20', label: 'EMA20' },
  { key: 'ema50', label: 'EMA50' },
  { key: 'bb', label: 'BB' },
  { key: 'vwap', label: 'VWAP' },
  // label 是 i18n key(中文原文),渲染时由 trade-chart 过 t()
  { key: 'supertrend', label: '超级趋势' },
  { key: 'donchian', label: '唐奇安' },
];

/**
 * 画在副窗里的。lightweight-charts v5 的多窗格(addPane / addSeries(…, paneIndex) / removePane)
 * 能用,所以副窗做了;但**同时只开一个**——两个副窗会把 300px 高的交易页图挤到看不清,
 * 而且 removePane 之后窗格索引会整体前移,只留一个就永远是 1,生命周期不用猜。
 */
export const PANE_CHIPS: IndicatorChip[] = [
  { key: 'rsi', label: 'RSI' },
  { key: 'macd', label: 'MACD' },
];

const STORAGE_KEY = 'tg.chart.overlays';
const PANE_STORAGE_KEY = 'tg.chart.subpane';
const DEFAULT_OVERLAYS = ['ema20', 'ema50'];
// 与 trade-chart 同口径:评审版 30s(公网访客多,别把 OKX 限频打满)
const REFRESH_MS = IS_JUDGE ? 30_000 : 5_000;
const SUBPANE_HEIGHT = 92;

const OVERLAY_KEYS = new Set(OVERLAY_CHIPS.map((c) => c.key));
const PANE_KEYS = new Set(PANE_CHIPS.map((c) => c.key));

function readEnabled(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [...DEFAULT_OVERLAYS];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_OVERLAYS];
    return parsed.filter((x): x is string => typeof x === 'string' && OVERLAY_KEYS.has(x));
  } catch {
    return [...DEFAULT_OVERLAYS];
  }
}

function readPane(): string | null {
  try {
    const raw = localStorage.getItem(PANE_STORAGE_KEY);
    return raw !== null && PANE_KEYS.has(raw) ? raw : null;
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* 隐私模式/禁用存储:开关不记住就是了,不该因此炸掉图表 */
  }
}

// ---------------------------------------------------------------- 数据 → 线

type Point = LineData<UTCTimestamp> | WhitespaceData<UTCTimestamp>;

interface LineSpec {
  id: string;
  kind: 'line' | 'hist';
  pane: 0 | 1;
  color: string;
  title: string;
  width: 1 | 2;
  style: LineStyle;
  data: Point[];
}

const secondsOf = (p: IndicatorPoint): UTCTimestamp => Math.floor(p.t / 1000) as UTCTimestamp;

function fieldOf(p: IndicatorPoint, field: string): number | null {
  const v = p[field];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 缺一个点就发 whitespace,让线自己断开,而不是跨过缺口连一条假的直线。 */
function lineOf(points: IndicatorPoint[], field: string, keep?: (p: IndicatorPoint) => boolean): Point[] {
  return points.map((p) => {
    const v = keep && !keep(p) ? null : fieldOf(p, field);
    return v === null ? { time: secondsOf(p) } : { time: secondsOf(p), value: v };
  });
}

function specsFor(data: IndicatorsResponse, enabled: string[], pane: string | null): LineSpec[] {
  const c = CHART_COLORS.dark;
  const out: LineSpec[] = [];
  const add = (spec: Partial<LineSpec> & Pick<LineSpec, 'id' | 'color' | 'title' | 'data'>): void => {
    out.push({ kind: 'line', pane: 0, width: 1, style: LineStyle.Solid, ...spec });
  };
  const series = (name: string): IndicatorPoint[] => data.series[name] ?? [];

  for (const key of enabled) {
    const pts = series(key);
    if (pts.length === 0) continue;
    if (key === 'ema20') add({ id: 'ema20', color: c.emaFast, title: 'EMA20', width: 2, data: lineOf(pts, 'v') });
    if (key === 'ema50') add({ id: 'ema50', color: c.emaSlow, title: 'EMA50', width: 2, data: lineOf(pts, 'v') });
    if (key === 'vwap') add({ id: 'vwap', color: c.vwap, title: 'VWAP', width: 2, data: lineOf(pts, 'v') });
    if (key === 'bb') {
      add({ id: 'bb.upper', color: c.text, title: t('BB 上'), style: LineStyle.Dashed, data: lineOf(pts, 'upper') });
      add({ id: 'bb.mid', color: c.text, title: t('BB 中'), style: LineStyle.Dotted, data: lineOf(pts, 'mid') });
      add({ id: 'bb.lower', color: c.text, title: t('BB 下'), style: LineStyle.Dashed, data: lineOf(pts, 'lower') });
    }
    if (key === 'donchian') {
      add({ id: 'dc.upper', color: c.emaSlow, title: t('唐奇安上'), style: LineStyle.Dashed, data: lineOf(pts, 'upper') });
      add({ id: 'dc.mid', color: c.text, title: t('唐奇安中'), style: LineStyle.Dotted, data: lineOf(pts, 'mid') });
      add({ id: 'dc.lower', color: c.emaSlow, title: t('唐奇安下'), style: LineStyle.Dashed, data: lineOf(pts, 'lower') });
    }
    if (key === 'supertrend') {
      // 一条 LineSeries 没法按点换色,所以拆成两条:多头段一条、空头段一条,另一段发 whitespace。
      add({ id: 'st.up', color: c.up, title: t('超级趋势'), width: 2, data: lineOf(pts, 'value', (p) => p['dir'] === 1) });
      add({ id: 'st.down', color: c.down, title: t('超级趋势'), width: 2, data: lineOf(pts, 'value', (p) => p['dir'] === -1) });
    }
  }

  if (pane === 'rsi') {
    const pts = series('rsi');
    if (pts.length) add({ id: 'pane.rsi', pane: 1, color: c.vwap, title: 'RSI14', width: 2, data: lineOf(pts, 'v') });
  }
  if (pane === 'macd') {
    const pts = series('macd');
    if (pts.length) {
      out.push({ id: 'pane.macd.hist', kind: 'hist', pane: 1, color: c.text, title: t('MACD 柱'), width: 1, style: LineStyle.Solid, data: lineOf(pts, 'hist') });
      add({ id: 'pane.macd.line', pane: 1, color: c.emaFast, title: 'MACD', width: 2, data: lineOf(pts, 'macd') });
      add({ id: 'pane.macd.signal', pane: 1, color: c.emaSlow, title: 'Signal', width: 1, data: lineOf(pts, 'signal') });
    }
  }
  return out;
}

// ---------------------------------------------------------------- hook

export interface UseIndicatorOverlays {
  enabled: string[];
  toggle: (key: string) => void;
  available: IndicatorChip[];
  /** 当前副窗指标(单选,null = 不开副窗)。 */
  pane: string | null;
  togglePane: (key: string) => void;
  paneAvailable: IndicatorChip[];
  loading: boolean;
  error: string | null;
  /** describeIndicators() 的一行摘要,调用方想显示就显示。 */
  text: string | null;
}

export function useIndicatorOverlays(
  chart: IChartApi | null,
  series: ISeriesApi<'Candlestick'> | null,
  symbol: string,
  interval: string,
  options?: { live?: boolean; limit?: number; endTime?: number },
): UseIndicatorOverlays {
  const live = options?.live !== false;
  const limit = options?.limit ?? 300;
  const endTime = options?.endTime;

  const [enabled, setEnabled] = useState<string[]>(readEnabled);
  const [pane, setPane] = useState<string | null>(readPane);
  const [data, setData] = useState<IndicatorsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requested = useMemo(() => [...enabled, ...(pane ? [pane] : [])], [enabled, pane]);
  const requestKey = requested.join(',');

  const toggle = useCallback((key: string) => {
    setEnabled((prev) => {
      const next = prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key];
      write(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const togglePane = useCallback((key: string) => {
    setPane((prev) => {
      const next = prev === key ? null : key;
      write(PANE_STORAGE_KEY, next);
      return next;
    });
  }, []);

  // ---- 取数:和主图同一个 5 秒节奏,一次请求把叠加线和副窗都带回来
  useEffect(() => {
    if (!symbol || requestKey === '') {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const load = (): void => {
      setLoading(true);
      api
        .indicators(symbol, interval, { limit, set: requestKey.split(','), endTime })
        .then((resp) => {
          if (cancelled) return;
          setData(resp);
          setError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    if (!live) return () => void (cancelled = true);
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [symbol, interval, requestKey, live, limit, endTime]);

  // ---- 画:增量对账(该有的建、不该有的删),而不是每次全拆全建
  const linesRef = useRef<Map<string, ISeriesApi<SeriesType>>>(new Map());
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    // 换了一张图(复盘页重建)时旧 series 已经跟着旧 chart 一起没了,只清账本不去删。
    if (chartRef.current !== chart) {
      linesRef.current.clear();
      chartRef.current = chart;
    }
    // series 只作就绪信号:蜡烛图还没建好时价格轴的量纲还没定,这时候塞线会闪一下。
    if (!chart || !series) return;
    const specs = data ? specsFor(data, enabled, pane) : [];
    const wanted = new Map(specs.map((s) => [s.id, s]));

    for (const [id, api2] of [...linesRef.current]) {
      if (wanted.has(id)) continue;
      try {
        chart.removeSeries(api2);
      } catch {
        /* 图已经被父组件 remove 掉了(卸载顺序),这里删不掉也无所谓 */
      }
      linesRef.current.delete(id);
    }

    const needsPane = specs.some((s) => s.pane === 1);
    try {
      if (needsPane && chart.panes().length < 2) chart.addPane();
      if (!needsPane && chart.panes().length > 1) chart.removePane(1);
      if (needsPane) chart.panes()[1]?.setHeight(SUBPANE_HEIGHT);
    } catch {
      /* 老版本没有窗格 API:副窗不画,主图叠加照常 */
    }

    for (const spec of specs) {
      let line = linesRef.current.get(spec.id);
      if (!line) {
        try {
          line =
            spec.kind === 'hist'
              ? chart.addSeries(HistogramSeries, { color: spec.color, priceLineVisible: false, lastValueVisible: false, priceFormat: { type: 'price', precision: 2, minMove: 0.01 } }, spec.pane)
              : chart.addSeries(
                  LineSeries,
                  { color: spec.color, lineWidth: spec.width, lineStyle: spec.style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, title: spec.title },
                  spec.pane,
                );
        } catch {
          continue;
        }
        linesRef.current.set(spec.id, line);
      }
      line.setData(spec.data);
    }
  }, [chart, series, data, enabled, pane]);

  // 卸载时兜底清干净。父组件的 chart.remove() 可能已经先跑了,所以整段都要能吞异常。
  useEffect(
    () => () => {
      const c = chartRef.current;
      for (const line of linesRef.current.values()) {
        try {
          c?.removeSeries(line);
        } catch {
          /* 同上 */
        }
      }
      linesRef.current.clear();
    },
    [],
  );

  return { enabled, toggle, available: OVERLAY_CHIPS, pane, togglePane, paneAvailable: PANE_CHIPS, loading, error, text: data?.text ?? null };
}
