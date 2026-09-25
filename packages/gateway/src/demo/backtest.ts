import { effectiveReturns } from './replay-stats.js';
import { SIGNAL_REGISTRY, nextSignalState, closedWeeks, type SignalState } from './strategy-signals.js';
import { mechanicalDirection, type LedgerLeg, type LedgerSnapshot, type JudgmentLedgerRow } from './judgment-ledger.js';
// Blind backtest / replay engine (docs/design/blind-backtest-2026-09-05.md, v3-ui-contract.md §9.8).
//
// The question this answers: "would this agent's entries have been any good?" — asked WITHOUT letting the
// model see one candle it could not have seen at the time. The whole design is one invariant:
//
//   BLIND INVARIANT — at a bar whose close_time is T, every kline handed to buildContext() satisfies
//   close_time ≤ T, and every derived number (features, daily regime, 24h ticker, triggers) is computed
//   from exactly those bars. Nothing else about the future enters the context. The engine asserts this on
//   every step (assertBlind) and the test suite asserts it on the EpisodeInputs the brain actually saw.
//
// Everything downstream of the context is the live code, not a copy: buildContext (same PROMPT_VERSION),
// the same JSON contract validator + one repair round, the same judgment graph, the same gates.ts, the
// same reduceReview for HOLD/EXIT/REDUCE/INVALIDATE. What the model cannot have here — funding before
// the history endpoint's reach, open interest, news / the information officer, sub-bar ticks — is left
// out rather than faked; see the design doc's "what is not blind" table.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Brain } from './brain.js';
import { estimateCny, priceFor } from './brain.js';
import { buildContext, PROMPT_VERSION, type EpisodeInputs } from './context.js';
import { DEFAULT_GATES, evaluateGates, type GateConfig } from './gates.js';
import { dailyRegime, fetchKlines, tfFeatures, tfToMs, type TfFeatures } from './market.js';
import { openTrade, stepTrade, tradeR, tradeCosts, conservativeLimitFill, simulateOutcome, missedMove, type OpenTrade } from './outcome.js';
import { extractJson, findMemoryNumberLeaks, validateJudgment } from './schema.js';
import { runAttribution, type AttributionPoint } from './attribution.js';
import { BUILTIN_STRATEGIES, strategyWakes, type StrategyLibrary, type StrategySpec } from './strategies.js';
import type { DemoStore } from './store.js';
import { newThread, reduceReview } from './threads.js';
import { detectTriggers, sessionInfo } from './triggers.js';
import type { AccountView, BrainKind, DailyRegime, Direction, GateResult, Judgment, Kline, MarketView, PositionView, SessionInfo, StrategyThread, TriggerHit, Workflow } from './types.js';

// ---------------------------------------------------------------- types

export type BacktestMode = 'triggers' | 'every_close';
export type BacktestStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export type ReplayLegName = 'model' | 'council' | 'mechanical';
export interface BacktestParams {
  /** 显式传入启用判断回放；省略保留旧线程回放语义。 */
  legs?: ReplayLegName[];
  symbol: string;
  timeframe: string;
  from: number;
  to: number;
  mode: BacktestMode;
  /** Hard cap on model calls for the whole run (the money valve). */
  max_judgments: number;
  /** Review an open simulated thread on every close (true) or only on trigger bars (false). */
  review_every_close: boolean;
  brain: BrainKind;
  brain_model: string | null;
  /** Bars a pending entry may wait for a fill, and a position may be held, before it is force-resolved. */
  horizon_bars: number;
  risk_pct: number;
  max_opens_per_day: number;
  /**
   * v3.5: which strategies from the library this run judges with. Defaults to `workflow.active_strategies`;
   * unlike the live loop a run MAY name backtest-/shadow-status strategies (that is what backtests are for).
   */
  strategy_ids: string[];
  /** Run the cheap-brain attribution pass when the walk finishes (POST /api/backtest/:id/attribute does it later). */
  attribute: boolean;
}

export interface BacktestProgress {
  done: number;
  total: number;
  last_action: string | null;
  at: number;
}

export interface BacktestTrade {
  /** Index of the step whose PROPOSE opened this trade. */
  step_idx: number;
  /** The strategy the opening judgment named (null when the run had no strategies / the model omitted it). */
  strategy_id: string | null;
  direction: Direction;
  entry: 'market' | 'limit';
  limit_price: number | null;
  proposed_at: number;
  fill_at: number | null;
  fill_price: number | null;
  stop: number;
  tp: number | null;
  exit_at: number | null;
  exit_price: number | null;
  /** stop / tp = protective exit; review_exit = a blind review said EXIT/INVALIDATE; expired = horizon;
   *  unfilled = the limit never traded; open = still open when the data ran out. */
  status: 'stop' | 'tp' | 'review_exit' | 'expired' | 'unfilled' | 'open';
  close_reason: string;
  gross_r?: number | null;
  net_r?: number | null;
  funding_estimated?: boolean;
  r: number | null;
  mae_r: number | null;
  mfe_r: number | null;
  bars_held: number | null;
  /** Fraction of the position closed early by a REDUCE, and the R booked on it. */
  reduced_fraction: number;
  reduced_r: number | null;
}

export interface BacktestCost {
  input_tokens: number;
  output_tokens: number;
  cny: number | null;
}

export interface BacktestSummary {
  leg_stats?: Partial<Record<ReplayLegName, { n: number; gross_expectancy: number | null; net_expectancy: number | null }>>;
  gross?: { expectancy_r: number | null; total_r: number };
  net?: { expectancy_r: number | null; total_r: number };
  judgments: number;
  scans: number;
  reviews: number;
  /** action → count over every judgment in the run. */
  actions: Record<string, number>;
  trades: number;
  wins: number;
  losses: number;
  flat: number;
  win_rate: number | null;
  avg_r: number | null;
  sum_r: number;
  /** Worst peak-to-trough of the cumulative-R curve, in R (positive number). */
  max_drawdown_r: number;
  avg_hold_bars: number | null;
  cost: BacktestCost;
  model: string;
  /** Best move (in ATR of the judgment bar) within the horizon after a NO_TRADE / WATCH. */
  missed_move: { samples: number; avg_atr: number; max_atr: number } | null;
  bars: number;
  candidates: number;
  /** True when max_judgments stopped the walk before `to`. */
  capped: boolean;
  trade_rows: BacktestTrade[];
  /** v3.5: the strategies this run judged with (id@version, so a summary always says which content it tested). */
  strategies: { id: string; version: number; content_hash: string; status: string }[];
  /** v3.5: per-strategy breakdown of the trades. `unattributed` collects trades whose judgment named no strategy. */
  by_strategy: Record<string, StrategyBreakdown>;
}

export interface StrategyBreakdown {
  gross?: { expectancy_r: number | null; total_r: number };
  net?: { expectancy_r: number | null; total_r: number };
  trades: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  expectancy_r: number | null;
  sum_r: number;
  /** Median MAE in R (negative); null when no trade reported one. */
  mae_r_p50: number | null;
  /** Judgments (scans) this strategy was named on, PROPOSE or not. */
  proposals: number;
}

export interface BacktestRun {
  id: string;
  created_at: number;
  symbol: string;
  timeframe: string;
  from_ms: number;
  to_ms: number;
  mode: BacktestMode;
  status: BacktestStatus;
  params: BacktestParams;
  brain: string;
  prompt_version: string;
  progress: BacktestProgress | null;
  summary: BacktestSummary | null;
  error: string | null;
}

export interface BacktestStep {
  run_id: string;
  idx: number;
  at_ms: number;
  kind: 'scan' | 'review';
  trigger: string | null;
  /** The blind boundary: no kline with close_time greater than this was in the context. */
  visible_upto_ms: number;
  judgment: Judgment | null;
  action: string | null;
  direction: Direction | null;
  confidence: number | null;
  gates: GateResult[];
  /** What this step did to the simulated book (opened / advanced / closed a trade). */
  outcome: {
    kind: 'opened' | 'blocked' | 'closed' | 'reduced' | 'none';
    detail: string;
    trade_step_idx?: number;
    r?: number | null;
    /** For NO_TRADE / WATCH: the biggest move within the horizon after this bar, in ATR. */
    missed_move_atr?: number | null;
  } | null;
  cost: BacktestCost | null;
  /** v3.5: the strategy the judgment named (PROPOSE only, in practice). */
  strategy_id: string | null;
  /** Model text when the judgment failed the contract twice (fail-closed), for forensics. */
  error: string | null;
}

export interface BacktestEstimate {
  symbol: string;
  timeframe: string;
  from: number;
  to: number;
  mode: BacktestMode;
  bars: number;
  candidates: number;
  /** v3.5: candidate bars per strategy — how many of them that strategy's trigger set would actually wake. */
  candidates_by_strategy: Record<string, number>;
  per_judgment_cny: number | null;
  est_cny: number | null;
  max_cny: number | null;
  model: string;
  note: string;
}

// ---------------------------------------------------------------- constants

export const BACKTEST_DEFAULTS = {
  mode: 'triggers' as BacktestMode,
  max_judgments: 60,
  review_every_close: false,
  horizon_bars: 48,
};

/** What a single backtest run can honestly say about a strategy (goes into eval_stats.noise_note). */
export const NOISE_NOTE = '单次采样,噪声底 ~30%';

export const BACKTEST_LIMITS = { max_judgments: 500, max_bars: 6000 };

/**
 * Token counts a single judgment costs, for the up-front estimate only (real steps bill their actual
 * usage). Chosen so a GLM-5.3 judgment lands on the ≈¥0.006 figure the workflow panel already quotes.
 */
const EST_INPUT_TOKENS = 1600;
const EST_OUTPUT_TOKENS = 400;

/** Bars of warm-up each timeframe needs before `from` so features/regime match the live loop's window. */
const WARMUP_BARS: Record<string, number> = { '15m': 70, '1h': 130, '4h': 90, '1d': 400 };
const DEFAULT_WARMUP_BARS = 70;

/** Same per-call rule as market.ts `fapi()` — see the comment there. */
function fapiBase(): string {
  return process.env['TG_DEMO_MARKET_BASE'] ?? 'https://fapi.binance.com';
}
/**
 * Read per call, not once at import: `TG_DEMO_KLINE_CACHE_DIR` is set by tests in `beforeAll`, which
 * runs AFTER this module is imported — a module-level const meant those tests silently read the real
 * ~/.trading-swarm cache and only passed while it happened to be empty (2026-09-05: warming it for the
 * funnel made three blind-replay tests read live BTC bars).
 */
function cacheDir(): string {
  return process.env['TG_DEMO_KLINE_CACHE_DIR'] ?? join(homedir(), '.trading-swarm', 'demo', 'klines');
}

const id = (prefix: string): string => `${prefix}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

// ---------------------------------------------------------------- kline cache (repeat runs are free)
//
// Two things are cached per (symbol, tf): the bars, and the wall-clock spans we have already ASKED the
// exchange about. The second half is what makes deep history cheap. A span that came back with a hole in
// it — exchange downtime, or simply "this symbol did not exist yet" — stays *covered*, so the next
// request does not re-page the same emptiness; without it, any imperfect range refetched everything on
// every call. Only closed bars are persisted: the still-forming candle would otherwise be frozen into
// the file with a half-finished close.

/** A closed wall-clock interval, inclusive on both ends. */
export interface Span {
  from: number;
  to: number;
}

interface CacheFile {
  symbol: string;
  tf: string;
  bars: Kline[];
  /** Merged, ascending spans already fetched. Absent in files written before this field existed. */
  ranges?: Span[];
}

/** Sort + coalesce overlapping or touching spans. */
export function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans.filter((s) => Number.isFinite(s.from) && Number.isFinite(s.to) && s.to >= s.from).sort((a, b) => a.from - b.from);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.from <= last.to + 1) last.to = Math.max(last.to, s.to);
    else out.push({ from: s.from, to: s.to });
  }
  return out;
}

/** [from, to] minus everything already covered; fragments shorter than one bar are not worth a request. */
export function missingSpans(covered: Span[], from: number, to: number, step: number): Span[] {
  const out: Span[] = [];
  let cursor = from;
  for (const s of mergeSpans(covered)) {
    if (s.to < cursor) continue;
    if (s.from > to) break;
    if (s.from > cursor) out.push({ from: cursor, to: Math.min(to, s.from - 1) });
    cursor = Math.max(cursor, s.to + 1);
    if (cursor > to) break;
  }
  if (cursor <= to) out.push({ from: cursor, to });
  return out.filter((s) => s.to - s.from >= step);
}

/** Coverage implied by the bars alone — the fallback for cache files written before `ranges` existed. */
export function spansFromBars(bars: Kline[], step: number): Span[] {
  const out: Span[] = [];
  let start: number | null = null;
  let prev: Kline | null = null;
  for (const k of bars) {
    if (start === null || (prev && k.open_time - prev.open_time !== step)) {
      if (start !== null && prev) out.push({ from: start, to: prev.close_time });
      start = k.open_time;
    }
    prev = k;
  }
  if (start !== null && prev) out.push({ from: start, to: prev.close_time });
  return mergeSpans(out);
}

/** Union of two bar arrays, deduped on open_time and sorted ascending. */
export function mergeBars(a: Kline[], b: Kline[]): Kline[] {
  const m = new Map<number, Kline>();
  for (const k of a) m.set(k.open_time, k);
  for (const k of b) m.set(k.open_time, k);
  return [...m.values()].sort((x, y) => x.open_time - y.open_time);
}

function sliceBars(bars: Kline[], from: number, to: number): Kline[] {
  return bars.filter((k) => k.close_time >= from && k.open_time <= to);
}

function cachePath(symbol: string, tf: string): string {
  return join(cacheDir(), `${symbol}-${tf}.json`);
}

function readCache(symbol: string, tf: string): { bars: Kline[]; ranges: Span[] | null } {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(symbol, tf), 'utf8')) as CacheFile;
    const bars = Array.isArray(parsed.bars) ? parsed.bars : [];
    return { bars, ranges: Array.isArray(parsed.ranges) ? mergeSpans(parsed.ranges) : null };
  } catch {
    return { bars: [], ranges: null };
  }
}

function writeCache(symbol: string, tf: string, bars: Kline[], ranges: Span[]): void {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(cachePath(symbol, tf), JSON.stringify({ symbol, tf, bars, ranges } satisfies CacheFile));
  } catch {
    // A read-only home is not a reason to fail a backtest; it only costs the next run a refetch.
  }
}

/**
 * Public klines for [from, to], paging backwards with `endTime` (Binance's only cursor on this endpoint)
 * at 1500 per page. `reached_start` says whether the walk actually got back to `from` (or ran out of
 * history trying, which is the same thing for caching purposes) rather than hitting the page cap — only
 * then may the caller record the whole span as covered. A fake/misbehaving server that never moves the
 * cursor back cannot spin this loop.
 */
export async function fetchKlineSpan(symbol: string, tf: string, from: number, to: number): Promise<{ bars: Kline[]; reached_start: boolean }> {
  const out = new Map<number, Kline>();
  let end = to;
  let prevEarliest = Number.POSITIVE_INFINITY;
  let reached = false;
  for (let page = 0; page < 200; page++) {
    const rows = await fetchKlines(symbol, tf, 1500, end);
    if (!rows.length) {
      reached = true; // nothing further back exists — the symbol simply did not trade there
      break;
    }
    for (const k of rows) out.set(k.open_time, k);
    const earliest = rows[0]!.open_time;
    if (earliest <= from || earliest >= prevEarliest) {
      reached = true;
      break;
    }
    prevEarliest = earliest;
    end = earliest - 1;
  }
  return { bars: [...out.values()].sort((a, b) => a.open_time - b.open_time), reached_start: reached };
}

/** Back-compat wrapper: the bars only. */
export async function fetchKlineRange(symbol: string, tf: string, from: number, to: number): Promise<Kline[]> {
  return (await fetchKlineSpan(symbol, tf, from, to)).bars;
}

/** Cached klines for [from, to]; only the spans never asked about cost a request. */
export async function loadKlines(symbol: string, tf: string, from: number, to: number): Promise<Kline[]> {
  const step = tfToMs(tf);
  const cache = readCache(symbol, tf);
  const covered = cache.ranges ?? spansFromBars(cache.bars, step);
  const gaps = missingSpans(covered, from, to, step);
  if (gaps.length === 0) return sliceBars(cache.bars, from, to);

  const now = Date.now();
  let bars = cache.bars;
  const fetched: Span[] = [];
  for (const gap of gaps) {
    const page = await fetchKlineSpan(symbol, tf, gap.from, gap.to);
    bars = mergeBars(bars, page.bars);
    // Coverage stops at the last *closed* bar, and at whatever we actually reached going back.
    const left = page.reached_start ? gap.from : (page.bars[0]?.open_time ?? gap.to);
    const right = Math.min(gap.to, now - 1);
    if (right >= left) fetched.push({ from: left, to: right });
  }
  writeCache(
    symbol,
    tf,
    bars.filter((k) => k.close_time < now),
    mergeSpans([...covered, ...fetched]),
  );
  return sliceBars(bars, from, to);
}

interface FundingPoint {
  at: number;
  rate: string;
}

/**
 * Historical funding (fapi /fundingRate) — the one "market micro-structure" number that IS available
 * for a past timestamp. Best effort: any failure yields an empty history and the funding evidence line
 * is simply omitted from the context rather than filled with a made-up 0.
 */
export async function loadFunding(symbol: string, from: number, to: number): Promise<FundingPoint[]> {
  const out: FundingPoint[] = [];
  try {
    let start = from;
    for (let page = 0; page < 20 && start < to; page++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      let rows: { fundingTime: number; fundingRate: string }[];
      try {
        const res = await fetch(`${fapiBase()}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${Math.floor(start)}&endTime=${Math.floor(to)}&limit=1000`, { signal: ctrl.signal });
        if (!res.ok) break;
        rows = (await res.json()) as { fundingTime: number; fundingRate: string }[];
      } finally {
        clearTimeout(timer);
      }
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const r of rows) out.push({ at: Number(r.fundingTime), rate: String(r.fundingRate) });
      const lastAt = out[out.length - 1]!.at;
      if (rows.length < 1000 || lastAt <= start) break;
      start = lastAt + 1;
    }
  } catch {
    return out;
  }
  return out.sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------- visible-window helpers (the blind edge)

/** Index of the last bar with close_time ≤ t, or -1. Binary search: the walk asks this a lot. */
export function lastClosedIndex(bars: Kline[], t: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.close_time <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** The last `count` bars closed at or before `t` — the only klines a judgment at `t` may see. */
export function visibleWindow(bars: Kline[], t: number, count: number): Kline[] {
  const end = lastClosedIndex(bars, t);
  if (end < 0) return [];
  return bars.slice(Math.max(0, end - count + 1), end + 1);
}

/** 24h ticker rebuilt from the visible bars (Binance's own /ticker/24hr is a "now" endpoint). */
export function ticker24hFromBars(bars: Kline[], t: number, tf: string): { priceChangePercent: string; highPrice: string; lowPrice: string; quoteVolume: string } {
  const win = visibleWindow(bars, t, Math.max(1, Math.round(86_400_000 / tfToMs(tf))));
  if (!win.length) return { priceChangePercent: '0.000', highPrice: '0', lowPrice: '0', quoteVolume: '0' };
  const first = win[0]!;
  const last = win[win.length - 1]!;
  const o = Number(first.open);
  const c = Number(last.close);
  let hi = Number.NEGATIVE_INFINITY;
  let lo = Number.POSITIVE_INFINITY;
  let qv = 0;
  for (const k of win) {
    hi = Math.max(hi, Number(k.high));
    lo = Math.min(lo, Number(k.low));
    qv += Number(k.volume) * Number(k.close);
  }
  const d = (last.close.split('.')[1] ?? '').length;
  return { priceChangePercent: (o > 0 ? ((c - o) / o) * 100 : 0).toFixed(3), highPrice: hi.toFixed(d), lowPrice: lo.toFixed(d), quoteVolume: qv.toFixed(2) };
}

// ---------------------------------------------------------------- the series bundle

export interface BacktestSeries {
  /** tf → full bar array (warm-up + range + horizon tail). */
  byTf: Record<string, Kline[]>;
  funding: FundingPoint[];
  /** Bars of the run timeframe whose close falls inside [from, to] — the walk. */
  walk: Kline[];
}

function neededTimeframes(timeframe: string): string[] {
  return [...new Set([timeframe, '15m', '1h', '4h', '1d'])];
}

export async function loadSeries(p: Pick<BacktestParams, 'symbol' | 'timeframe' | 'from' | 'to' | 'horizon_bars'>): Promise<BacktestSeries> {
  const tfMs = tfToMs(p.timeframe);
  const tail = p.to + (p.horizon_bars + 2) * tfMs;
  const byTf: Record<string, Kline[]> = {};
  for (const tf of neededTimeframes(p.timeframe)) {
    const warm = (WARMUP_BARS[tf] ?? DEFAULT_WARMUP_BARS) * tfToMs(tf);
    byTf[tf] = await loadKlines(p.symbol, tf, p.from - warm, tail);
  }
  const funding = await loadFunding(p.symbol, p.from - 30 * 86_400_000, tail);
  const run = byTf[p.timeframe] ?? [];
  const walk = run.filter((k) => k.close_time >= p.from && k.close_time <= p.to);
  return { byTf, funding, walk };
}

// ---------------------------------------------------------------- per-bar inputs

interface BarContextDeps {
  params: BacktestParams;
  series: BacktestSeries;
  workflow: Workflow;
}

interface BarFeatures {
  features: TfFeatures[];
  regime: DailyRegime | null;
  market: MarketView;
  ticker: { priceChangePercent: string; highPrice: string; lowPrice: string; quoteVolume: string };
  session: SessionInfo;
}

/** Everything code-computed for one bar, from visible klines only. */
function barFeatures(d: BarContextDeps, t: number): BarFeatures | null {
  const { params: p, series } = d;
  const tfBars = visibleWindow(series.byTf[p.timeframe] ?? [], t, 60);
  const h1 = visibleWindow(series.byTf['1h'] ?? [], t, 120);
  const h4 = visibleWindow(series.byTf['4h'] ?? [], t, 80);
  if (tfBars.length < 5 || h1.length < 5 || h4.length < 5) return null;
  const features = [tfFeatures(p.timeframe, tfBars), tfFeatures('1h', h1), tfFeatures('4h', h4)];
  const daily = visibleWindow(series.byTf['1d'] ?? [], t, 260);
  const regime = daily.length >= 30 ? dailyRegime(daily, t) : null;
  const last = tfBars[tfBars.length - 1]!;
  const funding = series.funding.filter((f) => f.at <= t).at(-1) ?? null;
  const market: MarketView = {
    market: 'perp',
    symbol: p.symbol,
    last: last.close,
    // No tick data in a backtest: the bar's close IS the mark at that instant.
    mark: last.close,
    // '' = "not available for this timestamp"; context.ts omits the evidence line instead of printing a fake 0.
    funding_rate: funding ? funding.rate : '',
    next_funding_at: Math.floor(t / 28_800_000) * 28_800_000 + 28_800_000,
    open_interest: '',
    as_of: t,
    klines_tf: p.timeframe,
  };
  return { features, regime, market, ticker: ticker24hFromBars(series.byTf[p.timeframe] ?? [], t, p.timeframe), session: sessionInfo(t) };
}

function triggerHitsAt(d: BarContextDeps, t: number, bf: BarFeatures, prev: { tf: TfFeatures | null; session: SessionInfo['name'] | null }): TriggerHit[] {
  return detectTriggers({
    symbol: d.params.symbol,
    now_tf: bf.features[0]!,
    prev_tf: prev.tf,
    h1: bf.features[1] ?? null,
    market: bf.market,
    session: bf.session,
    // No sub-bar ticks in a backtest, so the 5-minute fast_move rule can never fire (design doc §3).
    fast_move_pct: null,
    fast_move_threshold_pct: Number(d.workflow.fast_move_pct ?? '0.8'),
    prev_session: prev.session,
  });
}

/** Throws if any kline in the built inputs closed after the blind boundary. Cheap; runs on every step. */
export function assertBlind(inp: EpisodeInputs, boundary: number): void {
  for (const f of inp.features) {
    const closeOfLast = f.last_open_time;
    if (closeOfLast > boundary) throw new Error(`盲测越界:${f.tf} 特征用了 open_time ${closeOfLast} > 边界 ${boundary}`);
  }
  if (inp.now > boundary) throw new Error(`盲测越界:now ${inp.now} > 边界 ${boundary}`);
  if (inp.market.as_of > boundary) throw new Error(`盲测越界:market.as_of ${inp.market.as_of} > 边界 ${boundary}`);
  if (inp.daily_regime && inp.daily_regime.as_of > boundary) throw new Error(`盲测越界:日线状态 as_of ${inp.daily_regime.as_of} > 边界 ${boundary}`);
}

function accountAt(equity: number, position: PositionView | null, t: number): AccountView {
  return {
    backend: 'paper',
    equity: equity.toFixed(2),
    available: equity.toFixed(2),
    unrealized_pnl: position ? position.unrealized_pnl : '0.00',
    positions: position ? [position] : [],
    open_orders: [],
    as_of: t,
  };
}

// ---------------------------------------------------------------- the brain round (same contract as live)

export interface JudgeResult {
  judgment: Judgment;
  raw: string;
  errors: string[];
  usage: { input_tokens: number; output_tokens: number; latency_ms: number };
  failed_closed: boolean;
}

/**
 * One judgment: the live contract, the live repair round, the live fail-closed. Deliberately the same
 * shape as runtime.executeEpisode's middle section — if that changes, this must too (the prompt itself
 * is shared through buildContext, so only the parse/repair policy lives in two places).
 */
export async function judgeOnce(brain: Brain, built: ReturnType<typeof buildContext>, mode: 'scan' | 'review'): Promise<JudgeResult> {
  const validRefs = new Set(built.evidence.map((e) => e.ref));
  const strategyIds = built.strategy_ids;
  let result = await brain.complete(built.system_text, built.user_text);
  let usage = { input_tokens: result.input_tokens, output_tokens: result.output_tokens, latency_ms: result.latency_ms };
  let judgment: Judgment | null = null;
  let errors: string[] = [];
  const tryParse = (text: string): void => {
    try {
      const v = validateJudgment(extractJson(text), validRefs, { strategies: strategyIds });
      judgment = v.judgment;
      errors = v.errors;
      if (judgment) {
        const leaks = findMemoryNumberLeaks(judgment, built.evidence);
        if (leaks.length) {
          errors = [...errors, ...leaks];
          judgment = null;
        }
      }
    } catch (e) {
      errors = [(e as Error).message];
    }
  };
  tryParse(result.text);
  if (judgment && !built.allowed_actions.includes((judgment as Judgment).action)) {
    errors = [`action ${(judgment as Judgment).action} 不在允许范围 ${built.allowed_actions.join('/')}`];
    judgment = null;
  }
  if (!judgment) {
    result = await brain.complete(built.system_text, `${built.user_text}\n\n你上一次的输出不符合契约,错误:\n- ${errors.join('\n- ')}\n上一次输出:\n${result.text.slice(0, 2000)}\n请只输出修正后的 JSON。`);
    usage = { input_tokens: usage.input_tokens + result.input_tokens, output_tokens: usage.output_tokens + result.output_tokens, latency_ms: usage.latency_ms + result.latency_ms };
    tryParse(result.text);
    if (judgment && !built.allowed_actions.includes((judgment as Judgment).action)) {
      errors = [`action ${(judgment as Judgment).action} 不在允许范围`];
      judgment = null;
    }
  }
  if (!judgment) {
    const failClosed: Judgment['action'] = mode === 'review' ? 'HOLD' : 'NO_TRADE';
    return {
      judgment: { action: failClosed, direction: null, confidence: 0, headline: '模型输出无法解析,按保守处理', thesis: '两次输出都不符合契约,系统 fail-closed。', reasons: [`契约错误:${errors.slice(0, 3).join('; ')}`], evidence_refs: [], invalidation: null, invalidation_price: null, target_price: null, watch_conditions: [], proposal: null },
      raw: result.text,
      errors,
      usage,
      failed_closed: true,
    };
  }
  return { judgment, raw: result.text, errors, usage, failed_closed: false };
}

// ---------------------------------------------------------------- strategies for a run

/**
 * Head versions for the run's strategy ids. Backtests deliberately accept any status except `retired`
 * (that is the whole point of `backtest` / `shadow`); the live loop's paper floor is enforced elsewhere.
 * Without a library (tests, the 3-arg estimate call) the built-in definitions stand in.
 */
/**
 * 回测要跑的策略版本。`id` 取 head;`id@N` 取**指定版本** —— 这是把 v1 和 v2 放在同一段行情上对跑的
 * 办法(生成一个新草稿会把 head 顶成新版本,不指定版本就再也回测不到老那一版了)。
 */
export function resolveRunStrategies(ids: string[], library?: StrategyLibrary): StrategySpec[] {
  const out: StrategySpec[] = [];
  for (const raw of [...new Set(ids)]) {
    const at = raw.lastIndexOf('@');
    const id = at > 0 ? raw.slice(0, at) : raw;
    const version = at > 0 ? Number(raw.slice(at + 1)) : null;
    const s = library
      ? version !== null && Number.isFinite(version)
        ? library.version(id, version)
        : library.head(id)
      : BUILTIN_STRATEGIES.find((b) => b.id === id) ?? null;
    if (s && s.status !== 'retired') out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------- estimate

function perJudgmentCny(model: string): number | null {
  return priceFor(model) ? estimateCny([{ model, input_tokens: EST_INPUT_TOKENS, output_tokens: EST_OUTPUT_TOKENS }]) : null;
}

/**
 * Candidate bars = the bars that WOULD wake the model, computed without calling it once.
 * `by_strategy` counts, per strategy, how many of those bars its own trigger set would wake — the
 * "which trigger is worth paying for" number, still free.
 */
export function countCandidates(d: BarContextDeps, strategies: StrategySpec[] = []): { bars: number; candidates: number; by_strategy: Record<string, number> } {
  const walk = d.series.walk;
  const by: Record<string, number> = {};
  for (const s of strategies) by[s.id] = 0;
  if (d.params.mode === 'every_close') {
    for (const s of strategies) by[s.id] = walk.length;
    return { bars: walk.length, candidates: walk.length, by_strategy: by };
  }
  let candidates = 0;
  let prevTf: TfFeatures | null = null;
  let prevSession: SessionInfo['name'] | null = null;
  for (const bar of walk) {
    const bf = barFeatures(d, bar.close_time);
    if (!bf) continue;
    const hits = triggerHitsAt(d, bar.close_time, bf, { tf: prevTf, session: prevSession });
    if (hits.length) candidates++;
    for (const s of strategies) if (strategyWakes(s, d.params.timeframe, hits)) by[s.id] = (by[s.id] ?? 0) + 1;
    prevTf = bf.features[0]!;
    prevSession = bf.session.name;
  }
  return { bars: walk.length, candidates, by_strategy: by };
}

/**
 * `library` is optional so http.ts's existing 3-argument call keeps working: without it the per-strategy
 * candidate counts fall back to the built-in definitions (right for every id the user has not re-versioned).
 */
export async function estimateBacktest(params: BacktestParams, workflow: Workflow, model: string, library?: StrategyLibrary): Promise<BacktestEstimate> {
  const series = await loadSeries(params);
  const strategies = resolveRunStrategies(params.strategy_ids ?? [], library);
  const { bars, candidates, by_strategy } = countCandidates({ params, series, workflow }, strategies);
  const per = params.legs && !params.legs.includes('model') ? 0 : perJudgmentCny(model);
  const billable = Math.min(candidates, params.max_judgments);
  return {
    symbol: params.symbol,
    timeframe: params.timeframe,
    from: params.from,
    to: params.to,
    mode: params.mode,
    bars,
    candidates,
    candidates_by_strategy: by_strategy,
    per_judgment_cny: per,
    est_cny: per === null ? null : Math.round(per * billable * 1000) / 1000,
    max_cny: per === null ? null : Math.round(per * params.max_judgments * 1000) / 1000,
    model,
    note:
      per === null
        ? '所选大脑走订阅额度,没有按 token 的单价(仍然会消耗订阅额度与时间)'
        : `按每次判断 ${per.toFixed(4)} 元估算;复查(持仓期间)不在候选数里,所以实际次数可能更多,上限就是 max_judgments = ${params.max_judgments}`,
  };
}

// ---------------------------------------------------------------- the run

interface SimTrade {
  step_idx: number;
  strategy_id: string | null;
  direction: Direction;
  entry: 'market' | 'limit';
  limit_price: number | null;
  stop: number;
  tp: number | null;
  proposed_at: number;
  /** Index into series.walk-extended bar array where the order becomes fillable. */
  from_bar: number;
  fill_bar: number | null;
  open: OpenTrade | null;
  thread: StrategyThread;
  reduced_fraction: number;
  reduced_r: number | null;
  bars_waited: number;
  atr: number;
  reductions: { fraction: number; price: number; at: number }[];
}

export interface BacktestDeps {
  store: DemoStore;
  /** Same lazily-cached brains the live loop uses (rt.brainFor). */
  brainFor: (kind: BrainKind, model: string | null) => Brain;
  workflow: () => Workflow;
  emit: (event: 'backtest.progress' | 'backtest.changed', data: unknown) => void;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

function normalizeStrategyIds(raw: unknown, workflow: Workflow, errors: string[]): string[] {
  const fallback = workflow.active_strategies?.length ? workflow.active_strategies : ['breakout_retest'];
  if (raw === undefined || raw === null || raw === '') return [...fallback];
  // The estimate arrives as a query string, the run as JSON — accept both rather than 400-ing the
  // estimate (the money valve the UI must call before it may start a run).
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null;
  if (!list) {
    errors.push('strategy_ids 必须是数组或逗号分隔的字符串');
    return [...fallback];
  }
  const ids = [...new Set(list.map((x) => String(x).trim()).filter(Boolean))].slice(0, 4);
  return ids.length ? ids : [...fallback];
}

export function normalizeParams(raw: Record<string, unknown>, workflow: Workflow): { params: BacktestParams; errors: string[] } {
  const errors: string[] = [];
  const rawLegs = raw['legs'];
  if (rawLegs !== undefined && (!Array.isArray(rawLegs) || !rawLegs.length || rawLegs.some(l => !['model', 'council', 'mechanical'].includes(String(l))))) errors.push('legs 必须是 model/council/mechanical 的非空数组');
  const symbol = String(raw['symbol'] ?? workflow.watchlist[0] ?? 'BTCUSDT').toUpperCase();
  const timeframe = String(raw['timeframe'] ?? workflow.timeframe ?? '15m');
  try {
    tfToMs(timeframe);
  } catch {
    errors.push(`timeframe ${timeframe} 不是合法周期`);
  }
  const from = Number(raw['from'] ?? 0);
  const to = Number(raw['to'] ?? 0);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= from) errors.push('from/to 必须是毫秒时间戳且 to > from');
  const mode: BacktestMode = raw['mode'] === 'every_close' ? 'every_close' : 'triggers';
  const maxJ = Math.max(1, Math.min(BACKTEST_LIMITS.max_judgments, Math.floor(Number(raw['max_judgments'] ?? BACKTEST_DEFAULTS.max_judgments))));
  if (!Number.isFinite(maxJ)) errors.push('max_judgments 必须是数字');
  const horizon = Math.max(4, Math.min(500, Math.floor(Number(raw['horizon_bars'] ?? BACKTEST_DEFAULTS.horizon_bars))));
  const brain = (['pi', 'claude', 'codex', 'stub'] as string[]).includes(String(raw['brain'] ?? '')) ? (String(raw['brain']) as BrainKind) : workflow.brain;
  const brainModel = raw['brain_model'] === undefined || raw['brain_model'] === null || raw['brain_model'] === '' ? (raw['brain'] ? null : workflow.brain_model) : String(raw['brain_model']);
  const params: BacktestParams = {
    ...(Array.isArray(rawLegs) && !errors.length ? { legs: [...new Set(rawLegs)] as ReplayLegName[] } : {}),
    symbol,
    timeframe,
    from,
    to,
    mode,
    max_judgments: maxJ,
    review_every_close: raw['review_every_close'] === true,
    brain,
    brain_model: brainModel,
    horizon_bars: horizon,
    risk_pct: Number(workflow.risk_pct ?? '0.5'),
    max_opens_per_day: Number(raw['max_opens_per_day'] ?? workflow.max_opens_per_day ?? DEFAULT_GATES.max_opens_per_day),
    strategy_ids: normalizeStrategyIds(raw['strategy_ids'], workflow, errors),
    attribute: raw['attribute'] === true,
  };
  if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
    const bars = (to - from) / tfToMs(errors.length ? '15m' : timeframe);
    if (bars > BACKTEST_LIMITS.max_bars) errors.push(`区间太长(${Math.round(bars)} 根 K 线,上限 ${BACKTEST_LIMITS.max_bars} 根),缩短时间范围或换大周期`);
  }
  return { params, errors };
}

export class BacktestManager {
  private running: string | null = null;
  private current: Promise<void> = Promise.resolve();
  private cancelled = new Set<string>();

  constructor(private readonly deps: BacktestDeps) {}

  brainName(params: Pick<BacktestParams, 'brain' | 'brain_model' | 'legs'>): string {
    if (params.legs && !params.legs.includes('model')) return 'deterministic';
    return this.deps.brainFor(params.brain, params.brain_model).name;
  }

  list(limit = 50): BacktestRun[] {
    return this.deps.store.backtestRuns(limit);
  }
  get(runId: string): { run: BacktestRun; steps: BacktestStep[]; trades: BacktestTrade[] } | null {
    const run = this.deps.store.backtestRun(runId);
    if (!run) return null;
    return { run, steps: this.deps.store.backtestSteps(runId), trades: run.summary?.trade_rows ?? [] };
  }
  isRunning(): string | null {
    return this.running;
  }

  cancel(runId: string): boolean {
    const run = this.deps.store.backtestRun(runId);
    if (!run || run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') return false;
    this.cancelled.add(runId);
    if (run.status === 'queued') {
      const next: BacktestRun = { ...run, status: 'cancelled' };
      this.deps.store.saveBacktestRun(next);
      this.deps.emit('backtest.changed', next);
    }
    return true;
  }

  /** Creates the run row and starts it in the background (one at a time; a second call is rejected). */
  start(params: BacktestParams): { run: BacktestRun; error: string | null } {
    const brain = this.brainName(params);
    const run: BacktestRun = {
      id: id('bt'),
      created_at: Date.now(),
      symbol: params.symbol,
      timeframe: params.timeframe,
      from_ms: params.from,
      to_ms: params.to,
      mode: params.mode,
      status: 'queued',
      params,
      brain,
      prompt_version: PROMPT_VERSION,
      progress: { done: 0, total: 0, last_action: null, at: Date.now() },
      summary: null,
      error: null,
    };
    if (this.running) {
      const busy: BacktestRun = { ...run, status: 'failed', error: `已有回测在跑(${this.running}),等它结束或先取消` };
      this.deps.store.saveBacktestRun(busy);
      this.deps.emit('backtest.changed', busy);
      return { run: busy, error: busy.error };
    }
    this.deps.store.saveBacktestRun(run);
    this.deps.emit('backtest.changed', run);
    this.running = run.id;
    this.current = this.execute(run).catch(() => undefined);
    return { run, error: null };
  }

  /** Exposed for tests / scripts: starts a run and resolves when it has finished. */
  async runToCompletion(params: BacktestParams): Promise<BacktestRun> {
    const { run, error } = this.start(params);
    if (error) return run;
    await this.current;
    return this.deps.store.backtestRun(run.id) ?? run;
  }

  private save(run: BacktestRun): void {
    this.deps.store.saveBacktestRun(run);
    this.deps.emit('backtest.changed', run);
  }

  private async execute(run0: BacktestRun): Promise<void> {
    let run: BacktestRun = { ...run0, status: 'running' };
    this.save(run);
    try {
      const summary = await this.walk(run);
      const cancelled = this.cancelled.has(run.id);
      run = { ...run, status: cancelled ? 'cancelled' : 'done', summary, progress: { done: run.params.legs ? summary.scans : summary.judgments, total: summary.candidates, last_action: null, at: Date.now() } };
      this.save(run);
      // 步骤 5:成绩回写策略的 eval_stats(累加 backtests,其余覆盖成最近一次)。
      this.recordEvalStats(run);
      // 步骤 5–6:跑完自动归因(可选;不影响回测本身的成败)。
      if (run.params.attribute && !cancelled && (!run.params.legs || run.params.legs.includes('model'))) {
        try {
          await this.attribute(run.id);
        } catch (e) {
          this.deps.log?.('warn', `回测 ${run.id} 归因失败:${(e as Error).message}`);
        }
      }
    } catch (e) {
      run = { ...run, status: 'failed', error: (e as Error).message.slice(0, 500) };
      this.deps.log?.('error', `回测 ${run.id} 失败:${run.error}`);
      this.save(run);
    } finally {
      this.cancelled.delete(run.id);
      this.running = null;
    }
  }

  // ---- the walk: one bar at a time, blind by construction

  private async walk(run: BacktestRun): Promise<BacktestSummary> {
    if (run.params.legs) return this.walkLegs(run);
    const p = run.params;
    const workflow = this.deps.workflow();
    const brain = this.deps.brainFor(p.brain, p.brain_model);
    const series = await loadSeries(p);
    const d: BarContextDeps = { params: p, series, workflow };
    const all = series.byTf[p.timeframe] ?? [];
    if (!series.walk.length) throw new Error('这个区间没有 K 线(时间范围或币种不对?)');
    const strategies = resolveRunStrategies(p.strategy_ids ?? [], this.deps.store.strategies);
    const { candidates } = countCandidates(d, strategies);

    const gateCfg: GateConfig = { ...DEFAULT_GATES, risk_pct: p.risk_pct, max_opens_per_day: p.max_opens_per_day };
    const steps: BacktestStep[] = [];
    const trades: BacktestTrade[] = [];
    const actions: Record<string, number> = {};
    const missed: number[] = [];
    let equity = 10_000;
    let judgments = 0;
    let scans = 0;
    let reviews = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let prevTf: TfFeatures | null = null;
    let prevSession: SessionInfo['name'] | null = null;
    let lastSummary: string | null = null;
    let trade: SimTrade | null = null;
    const opensByDay = new Map<number, number>();
    let capped = false;

    const pushStep = (s: Omit<BacktestStep, 'run_id' | 'idx' | 'visible_upto_ms'> & { at_ms: number }): void => {
      const row: BacktestStep = { run_id: run.id, idx: steps.length, visible_upto_ms: s.at_ms, ...s };
      steps.push(row);
      this.deps.store.saveBacktestStep(row);
    };

    const walkStart = all.findIndex((k) => k.close_time >= p.from);
    const startIdx = walkStart < 0 ? all.length : walkStart;

    const closeTrade = (t: SimTrade, at: number, price: number, status: BacktestTrade['status'], reason: string): BacktestTrade => {
      const r = t.open && status !== 'open' ? tradeR(t.open, price) : null;
      const weighted = r === null ? null : r * (1 - t.reduced_fraction) + (t.reduced_r ?? 0) * t.reduced_fraction;
      const remainingCost = t.open && t.fill_bar !== null ? tradeCosts(t.open, price, t.entry, all[t.fill_bar]!.open_time, at, t.atr, series.funding) : null;
      const partialCosts = t.open && t.fill_bar !== null ? t.reductions.map(r => ({ ...tradeCosts(t.open!, r.price, t.entry, all[t.fill_bar!]!.open_time, r.at, t.atr, series.funding), fraction: r.fraction })) : [];
      const cost = remainingCost ? { cost_r: remainingCost.cost_r * (1 - t.reduced_fraction) + partialCosts.reduce((a, r) => a + r.cost_r * r.fraction, 0), funding_estimated: remainingCost.funding_estimated || partialCosts.some(c => c.funding_estimated) } : null;
      const row: BacktestTrade = {
        step_idx: t.step_idx,
        strategy_id: t.strategy_id,
        direction: t.direction,
        entry: t.entry,
        limit_price: t.limit_price,
        proposed_at: t.proposed_at,
        fill_at: t.fill_bar === null ? null : (all[t.fill_bar]?.open_time ?? null),
        fill_price: t.open?.fill_price ?? null,
        stop: t.stop,
        tp: t.tp,
        exit_at: at,
        exit_price: t.open ? price : null,
        status,
        close_reason: reason,
        r: weighted,
        gross_r: weighted,
        net_r: weighted === null ? null : weighted - (cost?.cost_r ?? 0),
        funding_estimated: cost?.funding_estimated ?? false,
        mae_r: t.open?.mae_r ?? null,
        mfe_r: t.open?.mfe_r ?? null,
        bars_held: t.open?.bars_held ?? null,
        reduced_fraction: t.reduced_fraction,
        reduced_r: t.reduced_r,
      };
      trades.push(row);
      if (weighted !== null) equity += (equity * p.risk_pct) / 100 * weighted;
      return row;
    };

    for (let i = startIdx; i < all.length; i++) {
      const bar = all[i]!;
      const t = bar.close_time;
      const inRange = t <= p.to;
      if (this.cancelled.has(run.id)) break;
      if (!inRange && !trade) break; // past the range with nothing open → done

      // ---- 1. the bar plays out against an open order / position (intrabar, before any decision)
      let barOutcome: BacktestStep['outcome'] = null;
      if (trade) {
        if (trade.open === null && i >= trade.from_bar) {
          trade.bars_waited++;
          const fillPrice =
            trade.entry === 'market'
              ? i === trade.from_bar
                ? Number(bar.open)
                : null
              : trade.limit_price !== null ? conservativeLimitFill(trade.direction, trade.limit_price, bar) : null;
          if (fillPrice !== null) {
            const opened = openTrade(trade.direction, fillPrice, trade.stop, trade.tp);
            if (!opened) {
              closeTrade(trade, t, fillPrice, 'unfilled', '成交价落在止损的错误一侧,作废');
              trade = null;
            } else {
              trade.open = opened;
              trade.fill_bar = i;
              trade.thread = { ...trade.thread, status: 'in_position', filled_avg_price: fillPrice.toString(), opened_at: t };
            }
          } else if (trade.bars_waited >= p.horizon_bars) {
            closeTrade(trade, t, 0, 'unfilled', `限价 ${p.horizon_bars} 根内没成交,撤单`);
            trade = null;
          }
        }
        if (trade?.open) {
          const ambiguousFill = trade.entry === 'limit' && trade.fill_bar === i && (trade.direction === 'long' ? Number(bar.open) > trade.open.fill_price : Number(bar.open) < trade.open.fill_price);
          const step = stepTrade(trade.open, bar, !ambiguousFill);
          if (step.exit) {
            const row = closeTrade(trade, step.exit.at, step.exit.price, step.exit.status, step.exit.note);
            barOutcome = { kind: 'closed', detail: `${step.exit.note} @ ${step.exit.price}`, trade_step_idx: row.step_idx, r: row.r };
            trade = null;
          } else if (trade.open.bars_held >= p.horizon_bars) {
            const row = closeTrade(trade, t, Number(bar.close), 'expired', `持有 ${p.horizon_bars} 根到期,按收盘价出`);
            barOutcome = { kind: 'closed', detail: row.close_reason, trade_step_idx: row.step_idx, r: row.r };
            trade = null;
          }
        }
      }

      const bf = barFeatures(d, t);
      if (!bf) {
        prevSession = null;
        continue;
      }
      const hits = inRange ? triggerHitsAt(d, t, bf, { tf: prevTf, session: prevSession }) : [];
      prevTf = bf.features[0]!;
      prevSession = bf.session.name;


      if (!inRange) continue; // past `to`: resolve open trades only, never judge again
      if (judgments >= p.max_judgments) {
        capped = true;
        if (!trade) break;
        continue;
      }

      // ---- 2. does the model get woken at this close?
      const isCandidate = p.mode === 'every_close' || hits.length > 0;
      const wantScan = !trade && isCandidate;
      const wantReview = !!trade && (p.review_every_close || hits.length > 0);
      if (!wantScan && !wantReview) continue;

      const mode: 'scan' | 'review' = wantReview ? 'review' : 'scan';
      const position: PositionView | null =
        trade?.open && trade.thread.status === 'in_position'
          ? { market: 'perp', symbol: p.symbol, side: trade.direction, qty: trade.thread.qty, entry_price: trade.open.fill_price.toFixed(6), mark_price: bar.close, unrealized_pnl: (tradeR(trade.open, Number(bar.close)) * ((equity * p.risk_pct) / 100)).toFixed(2), leverage: workflow.leverage ?? 3 }
          : null;
      const trigger = hits[0] ?? null;
      const inputs: EpisodeInputs = {
        now: t,
        symbol: p.symbol,
        trigger: { kind: trigger ? trigger.kind : mode === 'review' ? 'thread_review' : 'kline_close', detail: trigger ? trigger.detail : `${p.timeframe} 收盘(盲测回放)` },
        mode,
        thread: mode === 'review' ? (trade?.thread ?? null) : null,
        open_threads: trade ? [trade.thread] : [],
        account: accountAt(equity, position, t),
        market: bf.market,
        features: bf.features,
        oi_change_1h_pct: null,
        ticker24h: bf.ticker,
        market_state: null, // no information officer / news in a backtest — see the design doc
        playbook_text: workflow.playbook_text,
        last_judgment_summary: lastSummary,
        halted: false,
        daily_regime: bf.regime,
        session: bf.session,
        trigger_hits: hits,
        memories: [], // long-term memories were written with hindsight; never injected into a blind run
        // v3.5: only the strategies this bar's triggers actually wake get rendered — that is what keeps the
        // prompt short when several are enabled, and it is the same purity the live loop uses.
        strategies: strategies.filter((st) => p.mode === 'every_close' || strategyWakes(st, p.timeframe, hits)),
        klines: { [p.timeframe]: visibleWindow(all, t, 600), '1h': visibleWindow(series.byTf['1h'] ?? [], t, 200), '4h': visibleWindow(series.byTf['4h'] ?? [], t, 120) },
        funding_history: series.funding.filter((f) => f.at <= t),
      };
      assertBlind(inputs, t);
      const built = buildContext(inputs);
      const judged = await judgeOnce(brain, built, mode);
      judgments++;
      if (mode === 'scan') scans++;
      else reviews++;
      inputTokens += judged.usage.input_tokens;
      outputTokens += judged.usage.output_tokens;
      const j = judged.judgment;
      actions[j.action] = (actions[j.action] ?? 0) + 1;
      lastSummary = `${new Date(t).toISOString().slice(11, 16)} UTC ${j.action}${j.direction ? `(${j.direction})` : ''}:${j.headline}`;
      const cost: BacktestCost = { input_tokens: judged.usage.input_tokens, output_tokens: judged.usage.output_tokens, cny: estimateCny([{ model: brain.name, input_tokens: judged.usage.input_tokens, output_tokens: judged.usage.output_tokens }]) };

      let gates: GateResult[] = [];
      let outcome: BacktestStep['outcome'] = barOutcome;
      barOutcome = null;

      if (mode === 'review' && trade) {
        const decision = reduceReview(trade.thread, j);
        trade.thread = { ...trade.thread, ...decision.patch, version: trade.thread.version + 1, updated_at: t };
        if (!decision.accepted || decision.effect === 'none') {
          outcome = { kind: 'none', detail: decision.reason };
        } else if (decision.effect === 'reduce_half' && trade.open) {
          const r = tradeR(trade.open, Number(bar.close));
          const fraction = Math.min(0.9 - trade.reduced_fraction, 0.5 * (1 - trade.reduced_fraction));
          const previous = trade.reduced_fraction;
          trade.reductions.push({ fraction, price: Number(bar.close), at: t });
          trade.reduced_fraction += fraction;
          trade.reduced_r = ((trade.reduced_r ?? 0) * previous + r * fraction) / trade.reduced_fraction;
          outcome = { kind: 'reduced', detail: `复查减半 @ ${bar.close}(该腿 ${r.toFixed(2)}R)`, r };
        } else if (decision.effect === 'close' || decision.effect === 'cancel_entry') {
          const price = trade.open ? Number(bar.close) : 0;
          const row = closeTrade(trade, t, price, trade.open ? 'review_exit' : 'unfilled', decision.patch.close_reason ?? decision.reason);
          outcome = { kind: 'closed', detail: `${row.close_reason} @ ${trade.open ? bar.close : '未成交'}`, trade_step_idx: row.step_idx, r: row.r };
          trade = null;
        }
      } else if (j.action === 'PROPOSE' && j.proposal) {
        const opensToday = opensByDay.get(Math.floor(t / 86_400_000)) ?? 0;
        const staleRefs = new Set(built.evidence.filter((e) => e.stale).map((e) => e.ref));
        gates = evaluateGates(j, { halted: false, paused: false, account: accountAt(equity, null, t), market: bf.market, opens_today: opensToday, stale_refs: staleRefs, now: t }, gateCfg);
        if (gates.every((g) => g.passed)) {
          const stop = Number(j.proposal.stop_price);
          const tp = j.proposal.take_profits[0] ? Number(j.proposal.take_profits[0]) : j.proposal.take_profit_price ? Number(j.proposal.take_profit_price) : null;
          const thread = newThread({
            id: `bt-thr-${steps.length}`,
            symbol: p.symbol,
            side: j.proposal.direction,
            source: 'agent',
            timeframe: p.timeframe,
            thesis: j.thesis,
            invalidation_text: j.invalidation,
            watch_conditions: j.watch_conditions,
            entry: { type: j.proposal.entry, price: j.proposal.limit_price ?? bar.close, zone: j.proposal.entry_zone },
            stop_price: j.proposal.stop_price,
            take_profits: j.proposal.take_profits.length ? j.proposal.take_profits : tp === null ? [] : [String(tp)],
            qty: '0',
            margin_usdt: null,
            leverage: workflow.leverage ?? 3,
            margin_mode: 'cross',
            strategy_id: j.strategy_id ?? null,
            now: t,
          });
          trade = { step_idx: steps.length, strategy_id: j.strategy_id ?? null, direction: j.proposal.direction, entry: j.proposal.entry, limit_price: j.proposal.limit_price === null ? null : Number(j.proposal.limit_price), stop, tp, proposed_at: t, from_bar: i + 1, fill_bar: null, open: null, thread, reduced_fraction: 0, reduced_r: null, bars_waited: 0, atr: bf.features[0]!.atr14, reductions: [] };
          opensByDay.set(Math.floor(t / 86_400_000), opensToday + 1);
          outcome = { kind: 'opened', detail: `${j.proposal.direction === 'long' ? '做多' : '做空'} ${j.proposal.entry === 'market' ? '市价(下一根开盘成交)' : `限价 ${j.proposal.limit_price}`},止损 ${stop}${tp === null ? '' : `,止盈 ${tp}`}`, trade_step_idx: steps.length };
        } else {
          outcome = { kind: 'blocked', detail: gates.filter((g) => !g.passed).map((g) => `${g.name}:${g.reason}`).join(';') };
        }
      } else if (j.action === 'NO_TRADE' || j.action === 'WATCH') {
        const future = all.slice(i + 1, i + 1 + p.horizon_bars);
        const mm = missedMove(Number(bar.close), bf.features[0]!.atr14, future);
        if (mm) missed.push(mm.max_atr);
        outcome = { kind: 'none', detail: j.action === 'WATCH' ? '记为观察' : '没有优势', missed_move_atr: mm?.max_atr ?? null };
      }

      pushStep({
        at_ms: t,
        kind: mode,
        trigger: hits.length ? hits.map((h) => `${h.kind}:${h.detail}`).join(';') : null,
        judgment: j,
        action: j.action,
        direction: j.direction,
        confidence: j.confidence,
        gates,
        outcome,
        cost,
        strategy_id: j.strategy_id ?? null,
        error: judged.failed_closed ? judged.errors.slice(0, 3).join('; ') : null,
      });
      this.deps.emit('backtest.progress', { run_id: run.id, done: judgments, total: Math.max(candidates, judgments), last_action: j.action, at: t });
    }

    // Anything still open when the data ran out is reported as-is (never marked a win).
    if (trade) {
      const last = all[all.length - 1]!;
      closeTrade(trade, last.close_time, trade.open ? Number(last.close) : 0, trade.open ? 'open' : 'unfilled', '数据用尽,未平仓');
    }

    const closed = trades.filter((t) => t.r !== null);
    const sumR = closed.reduce((a, b) => a + (b.r ?? 0), 0);
    let peak = 0;
    let cum = 0;
    let dd = 0;
    for (const t of closed) {
      cum += t.r ?? 0;
      peak = Math.max(peak, cum);
      dd = Math.max(dd, peak - cum);
    }
    const wins = closed.filter((t) => (t.r ?? 0) > 0).length;
    const losses = closed.filter((t) => (t.r ?? 0) < 0).length;
    const held = closed.filter((t) => t.bars_held !== null);
    return {
      gross: { expectancy_r: closed.length ? sumR / closed.length : null, total_r: sumR },
      net: { expectancy_r: closed.length ? closed.reduce((a, t) => a + (t.net_r ?? 0), 0) / closed.length : null, total_r: closed.reduce((a, t) => a + (t.net_r ?? 0), 0) },
      judgments,
      scans,
      reviews,
      actions,
      trades: trades.length,
      wins,
      losses,
      flat: closed.length - wins - losses,
      win_rate: closed.length ? wins / closed.length : null,
      avg_r: closed.length ? sumR / closed.length : null,
      sum_r: sumR,
      max_drawdown_r: dd,
      avg_hold_bars: held.length ? held.reduce((a, b) => a + (b.bars_held ?? 0), 0) / held.length : null,
      cost: { input_tokens: inputTokens, output_tokens: outputTokens, cny: estimateCny([{ model: brain.name, input_tokens: inputTokens, output_tokens: outputTokens }]) },
      model: brain.name,
      missed_move: missed.length ? { samples: missed.length, avg_atr: missed.reduce((a, b) => a + b, 0) / missed.length, max_atr: Math.max(...missed) } : null,
      bars: series.walk.length,
      candidates,
      capped,
      trade_rows: trades,
      strategies: strategies.map((st) => ({ id: st.id, version: st.version, content_hash: st.content_hash, status: st.status })),
      by_strategy: breakdownByStrategy(trades, steps),
    };
  }

  /** 判断回放不创建线程，三腿共享同一可见快照、未来窗口与交易成本。 */
  private async walkLegs(run: BacktestRun): Promise<BacktestSummary> {
    const p = run.params; const legs = p.legs!;
    const workflow = this.deps.workflow();
    const series = await loadSeries(p); const all = series.byTf[p.timeframe] ?? [];
    const d: BarContextDeps = { params: p, series, workflow };
    const strategies = resolveRunStrategies(p.strategy_ids ?? workflow.active_strategies ?? [], this.deps.store.strategies);
    const brain = legs.includes('model') ? this.deps.brainFor(p.brain, p.brain_model) : null;
    const weeks = closedWeeks(series.byTf['1d'] ?? [], p.to);
    const states = new Map<string, SignalState>();
    const lastSignals = new Map<string, number>();
    const rows: (JudgmentLedgerRow & { source: 'replay' })[] = [];
    let prevTf: TfFeatures | null = null; let prevSession: SessionInfo['name'] | null = null;
    let input = 0; let output = 0; let calls = 0;
    const actions: Record<string, number> = {};
    const totals: Partial<Record<ReplayLegName, { n: number; gross: number; net: number }>> = {};
    for (let i = 0; i < all.length; i++) {
      const bar = all[i]!; const t = bar.close_time;
      if (t > p.to || this.cancelled.has(run.id)) break;
      if (t < p.from - 150 * tfToMs(p.timeframe)) continue;
      const bf = barFeatures(d, t); if (!bf) continue;
      const hits = triggerHitsAt(d, t, bf, { tf: prevTf, session: prevSession });
      prevTf = bf.features[0]!; prevSession = bf.session.name;
      const klines = Object.fromEntries(Object.entries(series.byTf).map(([tf, bs]) => [tf, visibleWindow(bs, t, tf === '1d' ? 400 : 600)]));
      klines['1w'] = visibleWindow(weeks, t, 80);
      const votes: Direction[] = [];
      if (legs.includes('council')) for (const spec of strategies) {
        const tf = tfToMs(spec.trigger.min_timeframe) > tfToMs(p.timeframe) ? spec.trigger.min_timeframe : p.timeframe;
        const stateKey = `${spec.id}@${spec.version}`;
        const state = states.get(stateKey) ?? { compression_bars: 0, armed: false, last_at: -1 };
        const ctx = { bars: klines, timeframe: tf, confirmation: spec.checklist.timeframes.filter(f => f !== tf), params: spec.params, derivatives: { funding: series.funding.filter(f => f.at <= t), oi_change_pct: null }, regime: bf.regime?.regime ?? null, state };
        const setup = SIGNAL_REGISTRY[spec.family](ctx);
        if (spec.family === 'volatility') states.set(stateKey, nextSignalState(ctx));
        if (setup && setup.at > t) throw new Error('判断执行器输出未来 setup');
        if (setup && setup.at === t && setup.at - (lastSignals.get(stateKey) ?? -Infinity) >= spec.trigger.cooldown_bars * tfToMs(tf)) { votes.push(setup.direction); lastSignals.set(stateKey, setup.at); }
      }
      if (t < p.from || (p.mode !== 'every_close' && !hits.length)) continue;
      if (rows.length >= p.max_judgments) break;
      const primary = bf.features[0]!; const h1 = bf.features.find(f => f.tf === '1h');
      const snapshot: LedgerSnapshot = { timeframe: p.timeframe, last_close: primary.last_close, mark: Number(bar.close), atr14: primary.atr14, swing_high_20: primary.swing_high_20_prev ?? primary.swing_high_20, swing_low_20: primary.swing_low_20_prev ?? primary.swing_low_20, ema20_1h: h1?.ema20 ?? null, ema50_1h: h1?.ema50 ?? null };
      const inputs: EpisodeInputs = { now: t, symbol: p.symbol, trigger: { kind: hits[0]?.kind ?? 'kline_close', detail: hits[0]?.detail ?? '三腿判断回放' }, mode: 'scan', thread: null, open_threads: [], account: accountAt(10000, null, t), market: bf.market, features: bf.features, oi_change_1h_pct: null, ticker24h: bf.ticker, market_state: null, playbook_text: workflow.playbook_text, last_judgment_summary: null, halted: false, daily_regime: bf.regime, session: bf.session, trigger_hits: hits, memories: [], strategies, klines, funding_history: series.funding.filter(f => f.at <= t) };
      assertBlind(inputs, t);
      if (Object.values(klines).some(bs => bs.some(b => b.close_time > t))) throw new Error('判断回放 K 线越界');
      let modelDir: Direction | null = null; let modelAction: string | null = null;
      if (brain) {
        const judged = await judgeOnce(brain, buildContext(inputs), 'scan');
        modelAction = judged.judgment.action;
        modelDir = modelAction === 'PROPOSE' ? judged.judgment.direction : null;
        input += judged.usage.input_tokens; output += judged.usage.output_tokens;
        calls++;
        actions[modelAction] = (actions[modelAction] ?? 0) + 1;
      }
      const long = votes.filter(v => v === 'long').length; const short = votes.length - long;
      const councilDir: Direction | null = long > short ? 'long' : short > long ? 'short' : null;
      const mechanical = mechanicalDirection(snapshot);
      const dirs = { model: modelDir, council: councilDir, mechanical: mechanical.direction };
      const settled = { model: null, council: null, mechanical: null } as Record<ReplayLegName, ReturnType<typeof replayJudgmentLeg> | null>;
      const future = all.slice(i + 1, i + 1 + p.horizon_bars);
      // 每条腿自己的 stance:模型跑了但没方向 = flat(明确不入场);压根没跑 / 机械基线读不出方向 = unknown。
      const stances: Record<ReplayLegName, LedgerLeg['stance']> = {
        model: modelDir ? 'direction' : modelAction ? 'flat' : 'unknown',
        council: councilDir ? 'direction' : votes.length ? 'flat' : 'unknown',
        mechanical: mechanical.direction ? 'direction' : 'unknown',
      };
      for (const leg of legs) {
        const result = replayJudgmentLeg(dirs[leg], snapshot, future, p.horizon_bars, series.funding, { stance: stances[leg] });
        settled[leg] = result;
        if (result.r !== null) { const total = totals[leg] ?? { n: 0, gross: 0, net: 0 }; total.n++; total.net += result.r; total.gross += result.gross_r ?? 0; totals[leg] = total; }
      }
      const row: JudgmentLedgerRow & { source: 'replay' } = { version: 'jl-replay-v3', source: 'replay', episode_id: `replay:${run.id}:${rows.length}`, at: t, as_of: t, symbol: p.symbol, timeframe: p.timeframe, mode: 'scan', thread_id: null, strategy_id: null, model_action: modelAction, model_dir: modelDir, council_dir: legs.includes('council') ? councilDir : null, council_agree: legs.includes('council') ? councilDir !== null : null, mechanical_dir: legs.includes('mechanical') ? mechanical.direction : null, mechanical_note: mechanical.note, horizon_end_at: t + p.horizon_bars * tfToMs(p.timeframe), outcome_r_model: settled.model?.r ?? null, outcome_r_council: settled.council?.r ?? null, outcome_r_mechanical: settled.mechanical?.r ?? null, outcome_source_model: settled.model ? (modelDir ? (settled.model.r === null ? 'unscoreable' : 'counterfactual') : stances.model === 'flat' ? 'flat' : 'unscoreable') : null, regret_review: null, settled_at: Date.now(), settle_note: 'replay；同快照/同 horizon/同成本；未选择腿为 null', snapshot, review: null, legs: settled, regret: null, cluster_id: `${p.symbol}:${Math.floor(t / 14_400_000)}`, model_stance: stances.model, council_stance: !legs.includes('council') ? 'unknown' : stances.council, settlement_status: null, realized: null };
      this.deps.store.judgments.save(row); rows.push(row);
      this.deps.emit('backtest.progress', { run_id: run.id, done: rows.length, total: Math.min(series.walk.length, p.max_judgments), at: t, last_action: modelAction ?? 'deterministic' });
    }
    const legStats = Object.fromEntries(Object.entries(totals).map(([leg, v]) => [leg, { n: v.n, gross_expectancy: v.n ? v.gross / v.n : null, net_expectancy: v.n ? v.net / v.n : null }]));
    return { leg_stats: legStats, judgments: calls, scans: rows.length, reviews: 0, actions, trades: 0, wins: 0, losses: 0, flat: 0, win_rate: null, avg_r: null, sum_r: 0, max_drawdown_r: 0, avg_hold_bars: null, cost: { input_tokens: input, output_tokens: output, cny: brain ? estimateCny([{ model: brain.name, input_tokens: input, output_tokens: output }]) : 0 }, model: brain?.name ?? 'deterministic', missed_move: null, bars: series.walk.length, candidates: rows.length, capped: rows.length >= p.max_judgments, trade_rows: [], strategies: strategies.map(s => ({ id: s.id, version: s.version, content_hash: s.content_hash, status: s.status })), by_strategy: {} };
  }

  // ---- v3.5: 成绩回写 + 归因

  private recordEvalStats(run: BacktestRun): void {
    const sm = run.summary;
    if (!sm || run.status !== 'done' || sm.capped || sm.trade_rows.some(t => t.status === 'open')) return;
    const lib = this.deps.store.strategies;
    for (const st of sm.strategies) {
      const b = sm.by_strategy[st.id];
      const complete = sm.trade_rows.filter(t => t.strategy_id === st.id && t.fill_at !== null && t.exit_at !== null && t.net_r != null && t.status !== 'open' && t.status !== 'unfilled');
      if (sm.trade_rows.some(t => t.strategy_id === st.id && t.status !== 'unfilled' && (t.fill_at === null || t.exit_at === null || t.net_r == null))) continue;
      const effective = effectiveReturns(complete.map(t => ({ at: t.fill_at!, net_r: t.net_r! })));
      lib.updateEvalStatsExact(st.id, st.version, st.content_hash, {
        trades: effective.length,
        win_rate: b?.win_rate ?? null,
        expectancy_r: effective.length ? effective.reduce((a,b) => a+b,0)/effective.length : null,
        ...(b?.gross ? { gross: b.gross } : {}), ...(b?.net ? { net: b.net } : {}),
        mae_r_p50: b?.mae_r_p50 ?? null,
        last_run_id: run.id,
        noise_note: NOISE_NOTE,
      });
    }
    this.deps.emit('backtest.changed', run);
  }

  /**
   * 便宜大脑读这次回测的成交与判断,吐 ≤ 3 个问题点位;每条落一行 demo_backtest_attribution
   * 和一条 `proposed` 记忆。永不修改策略——采纳要人点「生成新版本」。
   */
  async attribute(runId: string, opts: { brain?: Brain } = {}): Promise<{ points: AttributionPoint[]; error: string | null }> {
    const run = this.deps.store.backtestRun(runId);
    if (!run) return { points: [], error: `没有这次回测:${runId}` };
    if (run.status !== 'done') return { points: [], error: `回测状态是 ${run.status},跑完了才能归因` };
    const steps = this.deps.store.backtestSteps(runId);
    const trades = run.summary?.trade_rows ?? [];
    const strategies = resolveRunStrategies(run.params.strategy_ids ?? [], this.deps.store.strategies);
    const wf = this.deps.workflow();
    const brain = opts.brain ?? this.deps.brainFor(wf.cheap_brain, wf.cheap_brain_model);
    const r = await runAttribution(run, steps, trades, strategies, {
      brain,
      memory: this.deps.store.memory,
      save: (a) => this.deps.store.saveAttribution(a),
    });
    if (r.points.length) this.deps.emit('backtest.changed', run);
    return { points: r.points, error: r.error };
  }
}

/** 中位数;空数组返回 null。 */
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** 按 strategy_id 拆成交;模型没标注的归到 `unattributed`。 */
export function breakdownByStrategy(trades: BacktestTrade[], steps: BacktestStep[]): Record<string, StrategyBreakdown> {
  const out: Record<string, StrategyBreakdown> = {};
  const bucket = (key: string): StrategyBreakdown => (out[key] ??= { trades: 0, wins: 0, losses: 0, win_rate: null, expectancy_r: null, sum_r: 0, mae_r_p50: null, proposals: 0 });
  const maes: Record<string, number[]> = {};
  const rs: Record<string, number[]> = {};
  for (const s of steps) if (s.strategy_id) bucket(s.strategy_id).proposals++;
  for (const t of trades) {
    const key = t.strategy_id ?? 'unattributed';
    const b = bucket(key);
    b.trades++;
    if (t.r !== null) {
      (rs[key] ??= []).push(t.r);
      b.sum_r += t.r;
      if (t.r > 0) b.wins++;
      else if (t.r < 0) b.losses++;
    }
    if (t.mae_r !== null) (maes[key] ??= []).push(t.mae_r);
  }
  for (const [key, b] of Object.entries(out)) {
    const list = rs[key] ?? [];
    b.win_rate = list.length ? b.wins / list.length : null;
    b.expectancy_r = list.length ? list.reduce((a, c) => a + c, 0) / list.length : null;
    b.sum_r = Math.round(b.sum_r * 1000) / 1000;
    const netRows = trades.filter(t => (t.strategy_id ?? 'unattributed') === key && t.net_r != null);
    const totalNet = netRows.reduce((a, t) => a + t.net_r!, 0);
    b.gross = { expectancy_r: b.expectancy_r, total_r: b.sum_r };
    b.net = { expectancy_r: netRows.length ? totalNet / netRows.length : null, total_r: totalNet };
    b.mae_r_p50 = median(maes[key] ?? []);
  }
  return out;
}

/**
 * mechanicalFor 的前 20 根突破位 + 0.8 ATR 锚定，三腿仅方向不同；r 为净值。
 *
 * 09-12 P1-12:`direction=null` **必须分清两件事** —— `stance='flat'` 是「明确决定不入场」(记 0R,
 * 那是不承担风险的真实价值);`stance='unknown'` 是「缺数据 / 这条腿没跑 / 方向读不出来」,记 null
 * 不记 0。以前一律 flat=0R,回放里的「机械基线算不出方向」就被当成了「它选择空仓」,而线上同一种情况
 * 记的是 unknown —— 两套口径不同的实验没法比较。
 */
export function replayJudgmentLeg(direction: Direction | null, snapshot: LedgerSnapshot, bars: Kline[], horizon: number, funding: { at: number; rate: string }[] = [], opts: { stance?: LedgerLeg['stance'] } = {}): LedgerLeg & { gross_r: number | null; funding_estimated: boolean } {
  const stance: LedgerLeg['stance'] = direction ? 'direction' : opts.stance ?? 'flat';
  if (bars.length < horizon) return { stance: direction ? 'direction' : stance, direction, r: null, gross_r: null, funding_estimated: false, status: 'unscoreable', fill: null, stop: null, tp: null, bars_walked: bars.length, note: '完整 horizon 数据不足' };
  if (!direction && stance !== 'flat') return { stance: 'unknown', direction: null, r: null, gross_r: null, funding_estimated: false, status: 'unscoreable', fill: null, stop: null, tp: null, bars_walked: 0, note: '缺数据 / 这条腿没跑出方向:记 unknown,不记 0R' };
  if (!direction) return { stance: 'flat', direction: null, r: 0, gross_r: 0, funding_estimated: false, status: 'flat', fill: null, stop: null, tp: null, bars_walked: 0, note: '明确未表态' };
  const fill = Number(bars[0]!.open); const long = direction === 'long'; const sign = long ? 1 : -1;
  const level = long ? snapshot.swing_high_20 : snapshot.swing_low_20;
  const anchor = long ? Math.min(level, fill) : Math.max(level, fill);
  const stop = anchor - sign * 0.8 * snapshot.atr14;
  const tp = fill + sign * 1.5 * Math.abs(fill - stop);
  const outcome = simulateOutcome({ direction, entry: 'market', limit_price: null, stop, tp, atr: snapshot.atr14, funding, bars: bars.slice(0, horizon) });
  return { stance: 'direction', direction, r: outcome.net_r ?? null, gross_r: outcome.gross_r ?? null, funding_estimated: outcome.funding_estimated ?? false, status: outcome.status === 'invalid' || outcome.status === 'unfilled' ? 'unscoreable' : outcome.status, fill: outcome.fill_price, stop, tp, bars_walked: outcome.bars_held ?? 0, note: outcome.note };
}
