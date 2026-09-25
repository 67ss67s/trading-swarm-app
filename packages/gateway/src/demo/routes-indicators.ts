// GET /api/market/indicators — the indicator library (indicators.ts) as chart-ready series.
// Registered from http-extra.ts with one line; see docs/demo/v3-ui-contract.md §9.10 and
// docs/demo/indicators.md for the full inventory.

import type { RouteContext, RouteModule } from './http-extra.js';
import { fetchKlines } from './market.js';
import type { Kline } from './types.js';
import {
  adx,
  aroon,
  atr,
  bollinger,
  cci,
  chaikinAd,
  closes,
  dema,
  donchian,
  ema,
  ichimoku,
  indicatorSnapshot,
  describeIndicators,
  keltner,
  macd,
  mfi,
  momentum,
  obv,
  psar,
  roc,
  rsi,
  sma,
  squeeze,
  stochRsi,
  stochastic,
  stdev,
  supertrend,
  tema,
  trix,
  volumeProfile,
  vwap,
  williamsR,
  wma,
} from './indicators.js';

/** Every `set` name the route understands, in the order they are rendered. */
export const INDICATOR_SETS = [
  'ema20',
  'ema50',
  'ema200',
  'sma20',
  'sma50',
  'sma200',
  'wma20',
  'dema20',
  'tema20',
  'bb',
  'keltner',
  'donchian',
  'vwap',
  'vwap_session',
  'supertrend',
  'psar',
  'ichimoku',
  'squeeze',
  'rsi',
  'stochrsi',
  'stoch',
  'macd',
  'adx',
  'cci',
  'mfi',
  'willr',
  'atr',
  'natr',
  'stddev',
  'mom',
  'roc',
  'trix',
  'obv',
  'ad',
  'aroon',
] as const;

export type IndicatorSet = (typeof INDICATOR_SETS)[number];

/** Sets that belong on the price scale (chart overlay); everything else wants its own pane. */
export const OVERLAY_SETS: readonly IndicatorSet[] = ['ema20', 'ema50', 'ema200', 'sma20', 'sma50', 'sma200', 'wma20', 'dema20', 'tema20', 'bb', 'keltner', 'donchian', 'vwap', 'vwap_session', 'supertrend', 'psar', 'ichimoku'];

export const DEFAULT_SETS: readonly IndicatorSet[] = ['ema20', 'ema50', 'bb', 'vwap', 'rsi', 'macd', 'adx', 'supertrend', 'donchian'];

/** Enough history behind the requested window that EMA200 / Ichimoku(52+26) are warm at its first bar. */
const WARMUP_BARS = 260;
const MAX_LIMIT = 1000;

type Point = Record<string, number | boolean>;

const ok = (v: number | undefined): boolean => typeof v === 'number' && Number.isFinite(v);

/** Zip a numeric series onto bar open times, dropping warm-up NaN (JSON has no NaN). */
function scalarSeries(ks: readonly Kline[], values: readonly number[], from: number): Point[] {
  const out: Point[] = [];
  for (let i = from; i < ks.length; i++) if (ok(values[i])) out.push({ t: ks[i]!.open_time, v: values[i]! });
  return out;
}

/** Same, for object series: only the listed fields are emitted, and only when all of them are finite. */
function objectSeries<T extends object>(ks: readonly Kline[], values: readonly T[], from: number, fields: (keyof T & string)[], extra?: (v: T) => Point): Point[] {
  const out: Point[] = [];
  for (let i = from; i < ks.length; i++) {
    const v = values[i];
    if (!v) continue;
    const point: Point = { t: ks[i]!.open_time };
    let good = true;
    for (const f of fields) {
      const n = v[f] as unknown;
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        good = false;
        break;
      }
      point[f] = n;
    }
    if (!good) continue;
    if (extra) Object.assign(point, extra(v));
    out.push(point);
  }
  return out;
}

/** Compute one named set over `ks`, emitting only the bars at index ≥ `from`. */
export function seriesFor(name: IndicatorSet, ks: readonly Kline[], from: number): Point[] {
  const cl = closes(ks);
  switch (name) {
    case 'ema20':
      return scalarSeries(ks, ema(cl, 20), from);
    case 'ema50':
      return scalarSeries(ks, ema(cl, 50), from);
    case 'ema200':
      return scalarSeries(ks, ema(cl, 200), from);
    case 'sma20':
      return scalarSeries(ks, sma(cl, 20), from);
    case 'sma50':
      return scalarSeries(ks, sma(cl, 50), from);
    case 'sma200':
      return scalarSeries(ks, sma(cl, 200), from);
    case 'wma20':
      return scalarSeries(ks, wma(cl, 20), from);
    case 'dema20':
      return scalarSeries(ks, dema(cl, 20), from);
    case 'tema20':
      return scalarSeries(ks, tema(cl, 20), from);
    case 'bb':
      return objectSeries(ks, bollinger(cl, 20, 2), from, ['mid', 'upper', 'lower', 'width_pct']);
    case 'keltner':
      return objectSeries(ks, keltner(ks, 20, 1.5), from, ['mid', 'upper', 'lower']);
    case 'donchian':
      return objectSeries(ks, donchian(ks, 20), from, ['upper', 'lower', 'mid']);
    case 'vwap':
      return scalarSeries(ks, vwap(ks, 'day'), from);
    case 'vwap_session':
      return scalarSeries(ks, vwap(ks, 'session'), from);
    case 'supertrend':
      return objectSeries(ks, supertrend(ks, 10, 3), from, ['value'], (v) => ({ dir: v.dir }));
    case 'psar':
      return objectSeries(ks, psar(ks), from, ['value'], (v) => ({ dir: v.dir }));
    case 'ichimoku':
      return objectSeries(ks, ichimoku(ks), from, ['tenkan', 'kijun'], (v) => {
        const p: Point = {};
        if (Number.isFinite(v.cloud_top)) p['cloud_top'] = v.cloud_top;
        if (Number.isFinite(v.cloud_bottom)) p['cloud_bottom'] = v.cloud_bottom;
        return p;
      });
    case 'squeeze':
      return squeeze(ks)
        .map((v, i) => ({ t: ks[i]!.open_time, on: v.on, bars_on: v.bars_on }) as Point)
        .slice(from);
    case 'rsi':
      return scalarSeries(ks, rsi(cl, 14), from);
    case 'stochrsi':
      return scalarSeries(ks, stochRsi(cl, 14), from);
    case 'stoch':
      return objectSeries(ks, stochastic(ks, 14, 3), from, ['k', 'd']);
    case 'macd':
      return objectSeries(ks, macd(cl), from, ['macd', 'signal', 'hist']);
    case 'adx':
      return objectSeries(ks, adx(ks, 14), from, ['adx', 'plus_di', 'minus_di']);
    case 'cci':
      return scalarSeries(ks, cci(ks, 20), from);
    case 'mfi':
      return scalarSeries(ks, mfi(ks, 14), from);
    case 'willr':
      return scalarSeries(ks, williamsR(ks, 14), from);
    case 'atr':
      return scalarSeries(ks, atr(ks, 14), from);
    case 'natr':
      return scalarSeries(
        ks,
        atr(ks, 14).map((v, i) => (Number.isFinite(v) && cl[i]! > 0 ? (v / cl[i]!) * 100 : Number.NaN),
        ),
        from,
      );
    case 'stddev':
      return scalarSeries(ks, stdev(cl, 20), from);
    case 'mom':
      return scalarSeries(ks, momentum(cl, 10), from);
    case 'roc':
      return scalarSeries(ks, roc(cl, 10), from);
    case 'trix':
      return scalarSeries(ks, trix(cl, 30), from);
    case 'obv':
      return scalarSeries(ks, obv(ks), from);
    case 'ad':
      return scalarSeries(ks, chaikinAd(ks), from);
    case 'aroon':
      return objectSeries(ks, aroon(ks, 25), from, ['up', 'down', 'osc']);
    default:
      return [];
  }
}

/** `set=` parsing: unknown names are reported back rather than silently ignored. */
export function parseSets(raw: string | null): { sets: IndicatorSet[]; unknown: string[] } {
  if (raw === null || raw.trim() === '') return { sets: [...DEFAULT_SETS], unknown: [] };
  if (raw.trim() === 'all') return { sets: [...INDICATOR_SETS], unknown: [] };
  const wanted = raw
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x !== '');
  const known = new Set<string>(INDICATOR_SETS);
  const sets: IndicatorSet[] = [];
  const unknown: string[] = [];
  for (const w of wanted) {
    if (!known.has(w)) unknown.push(w);
    else if (!sets.includes(w as IndicatorSet)) sets.push(w as IndicatorSet);
  }
  return { sets: sets.length ? sets : [...DEFAULT_SETS], unknown };
}

export const indicatorRoutes: RouteModule = (ctx: RouteContext) => {
  ctx.route(
    'GET',
    '/api/market/indicators',
    ctx.guarded(async (_req, res, url) => {
      const symbol = (url.searchParams.get('symbol') ?? ctx.rt.workflow.watchlist[0] ?? 'BTCUSDT').toUpperCase();
      const interval = url.searchParams.get('interval') ?? url.searchParams.get('tf') ?? '1h';
      const limitRaw = Number(url.searchParams.get('limit') ?? '300');
      const limit = Math.min(MAX_LIMIT, Math.max(20, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 300));
      const endRaw = Number(url.searchParams.get('end_time') ?? '');
      const endTime = Number.isFinite(endRaw) && endRaw > 0 ? endRaw : undefined;
      const { sets, unknown } = parseSets(url.searchParams.get('set'));

      // Fetch warm-up bars BEFORE the window so EMA200 / Ichimoku are already converged at its first
      // bar; they are computed over everything and then trimmed away, never returned.
      const ks = await fetchKlines(symbol, interval, Math.min(1500, limit + WARMUP_BARS), endTime);
      if (ks.length === 0) return ctx.fail(res, 502, `${symbol} ${interval} 没有 K 线数据`, 'no_klines');
      const from = Math.max(0, ks.length - limit);

      const series: Record<string, Point[]> = {};
      for (const name of sets) series[name] = seriesFor(name, ks, from);
      const snapshot = indicatorSnapshot(ks, interval);
      const vp = volumeProfile(ks, 24, 120);

      ctx.json(res, 200, {
        symbol,
        interval,
        bars: ks.length - from,
        klines_from: ks[from]!.open_time,
        klines_to: ks[ks.length - 1]!.open_time,
        sets,
        unknown_sets: unknown,
        overlay: sets.filter((s) => OVERLAY_SETS.includes(s)),
        series,
        snapshot,
        text: describeIndicators(snapshot),
        volume_profile: vp ? { poc: vp.poc, vah: vp.vah, val: vp.val } : null,
      });
    }),
  );

  /** The names a UI can offer, without having to hard-code them. */
  ctx.route('GET', '/api/market/indicators/sets', async (_req, res) => {
    ctx.json(res, 200, { sets: INDICATOR_SETS, overlay: OVERLAY_SETS, defaults: DEFAULT_SETS });
  });
};
