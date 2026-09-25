/**
 * Geometry Lab (2026-09-23) — frozen-data experiment: who places a long breakout's stop / target better?
 *   A = pure code from structure primitives, B = model one-shot from a text digest (production style),
 *   C = model in a read-only tool loop, D = model picks indices among code-enumerated levels.
 * Entries and management are IDENTICAL across arms; only the geometry differs. Design + results:
 * docs/research/geometry-lab-2026-09-23.md.
 *
 * This file is zero-model: the leak guard (View), features, swing points, candidate signal, arm A,
 * level enumeration for arm D, settlement (plan / chandelier trail) and the metrics.
 *
 * Reuse vs mirror:
 *   - ATR/EMA come from research/primitives/indicators.ts; HTF buckets from research/primitives/structure.ts
 *     (completeBuckets, complete buckets only); plan settlement is outcome.ts simulateOutcome, trail
 *     settlement uses outcome.ts openTrade/stepTrade/tradeCosts.
 *   - MIRRORED: `pivots()` mirrors structure()'s confirmed-pivot rule (rightmost tie) but allows an asymmetric
 *     left/right window (tool `swing_points(left,right,n)` needs it); a test pins it to structure() for L=R.
 *   - MIRRORED: `settleTrail()` mirrors scripts/ledger-backfill.ts walkChandelier (ATR22 simple mean of closed
 *     bars, HH since fill, tighten-only, 7 days max) because that script is not importable (top-level side
 *     effects); costs are added here via tradeCosts so both variants are net of the same fees/slippage.
 */
import type { ResearchBar } from '@trading-swarm/contracts';
import { atrSeries, emaSeries } from '../research/primitives/indicators.js';
import { completeBuckets } from '../research/primitives/structure.js';
import { openTrade, simulateOutcome, stepTrade, tradeCosts, tradeR } from '../outcome.js';

export type Bar = ResearchBar;
export const H1 = 3_600_000;
export const H4 = 4 * H1;
export const D1 = 24 * H1;
/** Bars every arm may see (20 days of 1h → 120 4h bars, 20 daily bars); also the signal warmup. */
export const LOOKBACK = 480;
/** Variant (i): exit at stop / target, else mark-to-close at 48 bars. */
export const PLAN_BARS = 48;
/** Variant (ii): chandelier ATR22×3 trail from the fill, no target, 7 days max. */
export const TRAIL_BARS = 168;
export const CHANDELIER_N = 22;
export const CHANDELIER_MULT = 3;

const N = (s: string): number => Number(s);
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

// ─────────────────────────────── leak guard ───────────────────────────────

/** Everything an arm is allowed to know. Built only by viewAt(); arms re-check it on entry. */
export interface View {
  readonly symbol: string;
  /** close_time of the signal bar; nothing that closes later may be visible. */
  readonly as_of: number;
  readonly bars: readonly Bar[];
}

export function assertVisible(v: View): void {
  if (!v.bars.length) throw new Error('empty_view');
  for (const b of v.bars) {
    if (b.close_time > v.as_of || (b.available_at ?? b.close_time) > v.as_of) throw new Error(`future_bar_leak:${b.close_time}>${v.as_of}`);
  }
}

/** Frozen slice of `all` (sorted ascending) with close_time ≤ asOf, at most `lookback` bars. */
export function viewAt(symbol: string, all: readonly Bar[], asOf: number, lookback = LOOKBACK): View {
  let lo = 0;
  let hi = all.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (all[mid]!.close_time <= asOf) lo = mid + 1;
    else hi = mid;
  }
  const bars = all.slice(Math.max(0, lo - lookback), lo).map((b) => Object.freeze({ ...b }));
  const v: View = Object.freeze({ symbol, as_of: asOf, bars: Object.freeze(bars) });
  assertVisible(v);
  return v;
}

/** Bars strictly after as_of — only settlement ever gets these. */
export function futureAfter(all: readonly Bar[], asOf: number): Bar[] {
  return all.filter((b) => b.open_time > asOf);
}

// ─────────────────────────────── features ───────────────────────────────

export interface Features {
  close: number;
  atr14: number;
  ema20: number;
  ema50: number;
  hi20: number;
  lo20: number;
  hi50: number;
  lo50: number;
  ll10: number;
  vol_ratio20: number;
  chg_last_pct: number;
  chg5_pct: number;
}

export function tfFeatures(bars: readonly Bar[]): Features {
  const b = bars.slice();
  if (b.length < 51) throw new Error('features_need_51_bars');
  const closes = b.map((x) => N(x.close));
  const last = b.at(-1)!;
  const w = (n: number) => b.slice(-n);
  const prevVol = b.slice(-21, -1).map((x) => N(x.volume));
  const close = N(last.close);
  return {
    close,
    atr14: atrSeries(b, 14).at(-1)!,
    ema20: emaSeries(closes, 20).at(-1)!,
    ema50: emaSeries(closes, 50).at(-1)!,
    hi20: Math.max(...w(20).map((x) => N(x.high))),
    lo20: Math.min(...w(20).map((x) => N(x.low))),
    hi50: Math.max(...w(50).map((x) => N(x.high))),
    lo50: Math.min(...w(50).map((x) => N(x.low))),
    ll10: Math.min(...w(10).map((x) => N(x.low))),
    vol_ratio20: N(last.volume) / mean(prevVol),
    chg_last_pct: ((close - closes.at(-2)!) / closes.at(-2)!) * 100,
    chg5_pct: ((close - closes.at(-6)!) / closes.at(-6)!) * 100,
  };
}

export function atrOf(bars: readonly Bar[], n: number): number {
  return atrSeries(bars.slice(), n).at(-1)!;
}

export interface Pivot {
  kind: 'high' | 'low';
  price: number;
  index: number;
  /** close_time of the pivot candle */
  at: number;
  /** close_time of the bar that confirmed it (index + right) */
  confirmed_at: number;
}

/** Confirmed swing points: extreme of [k−left, k+right], rightmost equal extreme wins; k+right must be visible. */
export function pivots(bars: readonly Bar[], left = 3, right = 3): Pivot[] {
  const out: Pivot[] = [];
  for (let k = left; k + right < bars.length; k++) {
    const c = bars[k]!;
    for (const kind of ['high', 'low'] as const) {
      const price = N(c[kind]);
      let extreme = price;
      for (let j = k - left; j <= k + right; j++) extreme = kind === 'high' ? Math.max(extreme, N(bars[j]![kind])) : Math.min(extreme, N(bars[j]![kind]));
      if (price !== extreme) continue;
      let tieRight = false;
      for (let j = k + 1; j <= k + right; j++) if (N(bars[j]![kind]) === price) tieRight = true;
      if (tieRight) continue;
      out.push({ kind, price, index: k, at: c.close_time, confirmed_at: bars[k + right]!.close_time });
    }
  }
  return out;
}

export function htfBars(v: View, tfMs: number): Bar[] {
  return completeBuckets(v.bars.slice(), H1, tfMs);
}

export interface HtfLevels {
  tf: '4h' | '1d';
  complete_bars: number;
  highs_above: number[];
  lows_below: number[];
  range20_high: number | null;
  range20_low: number | null;
}

/** Closed-bucket HTF swing points (L=R=2), nearest first, relative to the latest 1h close. */
export function htfLevels(v: View, tf: '4h' | '1d'): HtfLevels {
  const bars = htfBars(v, tf === '4h' ? H4 : D1);
  const close = N(v.bars.at(-1)!.close);
  const ps = pivots(bars, 2, 2);
  const highs = [...new Set(ps.filter((p) => p.kind === 'high' && p.price > close).map((p) => p.price))].sort((a, b) => a - b);
  const lows = [...new Set(ps.filter((p) => p.kind === 'low' && p.price < close).map((p) => p.price))].sort((a, b) => b - a);
  const w = bars.slice(-20);
  return {
    tf,
    complete_bars: bars.length,
    highs_above: highs.slice(0, 3),
    lows_below: lows.slice(0, 3),
    range20_high: w.length ? Math.max(...w.map((b) => N(b.high))) : null,
    range20_low: w.length ? Math.min(...w.map((b) => N(b.low))) : null,
  };
}

export function vwap(bars: readonly Bar[], n = 24): number {
  const w = bars.slice(-n);
  let pv = 0;
  let vol = 0;
  for (const b of w) {
    const v = N(b.volume);
    pv += ((N(b.high) + N(b.low) + N(b.close)) / 3) * v;
    vol += v;
  }
  return vol > 0 ? pv / vol : N(bars.at(-1)!.close);
}

export interface VolumeProfile {
  n: number;
  bins: { lo: number; hi: number; mid: number; share: number }[];
  poc: number;
  /** local volume maxima (mid prices) with share ≥ 1.2× the mean bin share */
  hvn: number[];
}

/** Each bar's volume spread uniformly over its [low, high]; bins over the window's range. */
export function volumeProfile(bars: readonly Bar[], n = 120, bins = 24): VolumeProfile {
  const w = bars.slice(-n);
  const lo = Math.min(...w.map((b) => N(b.low)));
  const hi = Math.max(...w.map((b) => N(b.high)));
  const width = (hi - lo) / bins || 1;
  const vol = new Array<number>(bins).fill(0);
  for (const b of w) {
    const l = N(b.low);
    const h = N(b.high);
    const v = N(b.volume);
    if (h <= l) {
      vol[Math.min(bins - 1, Math.floor((l - lo) / width))]! += v;
      continue;
    }
    for (let i = 0; i < bins; i++) {
      const a = lo + i * width;
      const overlap = Math.min(h, a + width) - Math.max(l, a);
      if (overlap > 0) vol[i]! += (v * overlap) / (h - l);
    }
  }
  const total = vol.reduce((a, b) => a + b, 0) || 1;
  const out = vol.map((x, i) => ({ lo: lo + i * width, hi: lo + (i + 1) * width, mid: lo + (i + 0.5) * width, share: x / total }));
  const poc = out.reduce((a, b) => (b.share > a.share ? b : a)).mid;
  const avg = 1 / bins;
  const hvn = out.filter((b, i) => b.share >= 1.2 * avg && b.share >= (out[i - 1]?.share ?? 0) && b.share >= (out[i + 1]?.share ?? 0)).map((b) => b.mid);
  return { n: w.length, bins: out, poc, hvn };
}

// ─────────────────────────────── candidates ───────────────────────────────

export interface Candidate {
  id: string;
  symbol: string;
  signal_index: number;
  as_of: number;
  ref_close: number;
  atr14: number;
  donchian_high: number;
  vol_ratio: number;
}

export interface SignalOptions {
  donchian: number;
  vol_mult: number;
  /** min bars between two candidates on one symbol (breakouts cluster) */
  cooldown: number;
  warmup: number;
  /** forward bars that must exist so both variants settle on complete data */
  forward: number;
}
export const DEFAULT_SIGNAL: SignalOptions = { donchian: 20, vol_mult: 1.1, cooldown: 24, warmup: LOOKBACK, forward: TRAIL_BARS };

/** Long-only Donchian-20 close breakout with volume ≥ 1.1× the prior 20-bar mean; entry = next bar open. */
export function findCandidates(symbol: string, all: readonly Bar[], o: SignalOptions = DEFAULT_SIGNAL): Candidate[] {
  const out: Candidate[] = [];
  let last = -Infinity;
  for (let i = Math.max(o.warmup, o.donchian); i + o.forward < all.length; i++) {
    const prev = all.slice(i - o.donchian, i);
    const donchianHigh = Math.max(...prev.map((b) => N(b.high)));
    const bar = all[i]!;
    if (!(N(bar.close) > donchianHigh)) continue;
    const volRatio = N(bar.volume) / mean(prev.map((b) => N(b.volume)));
    if (!(volRatio >= o.vol_mult)) continue;
    if (i - last < o.cooldown) continue;
    last = i;
    const v = viewAt(symbol, all, bar.close_time);
    out.push({ id: `${symbol}:${bar.close_time}`, symbol, signal_index: i, as_of: bar.close_time, ref_close: N(bar.close), atr14: tfFeatures(v.bars).atr14, donchian_high: donchianHigh, vol_ratio: volRatio });
  }
  return out;
}

// ─────────────────────────────── geometry ───────────────────────────────

export interface Geometry {
  stop: number;
  target: number | null;
  rationale: string;
  source_levels: string[];
  /** e.g. fallback_a, hallucinated, miscited, invalid_output, stop_ungrounded, clamped_1atr */
  flags: string[];
}

/** Arm A: stop = nearer of (LL10 − 0.1 ATR, close − 2 ATR) but ≥ 1 ATR away; target = nearest 1h swing high in [1, 6] ATR. */
export function armA(v: View): Geometry {
  assertVisible(v);
  const f = tfFeatures(v.bars);
  const c = f.close;
  const a = f.atr14;
  const s1 = f.ll10 - 0.1 * a;
  const s2 = c - 2 * a;
  const nearer = Math.max(s1, s2);
  const stop = Math.min(nearer, c - a);
  const flags: string[] = stop < nearer ? ['clamped_1atr'] : [];
  const highs = pivots(v.bars, 3, 3)
    .filter((p) => p.kind === 'high' && p.price > c)
    .map((p) => p.price)
    .filter((px) => (px - c) / a >= 1 && (px - c) / a <= 6)
    .sort((x, y) => x - y);
  const target = highs[0] ?? null;
  return {
    stop,
    target,
    rationale: 'code: stop=nearer(LL10−0.1ATR, close−2ATR) floored at 1ATR; target=nearest 1h swing high in [1,6]ATR',
    source_levels: [nearer === s1 ? `LL10 ${f.ll10} −0.1ATR` : `close−2ATR`, ...(flags.length ? ['clamped to close−1ATR'] : []), target !== null ? `1h swing high ${target}` : 'no 1h swing high in [1,6]ATR'],
    flags,
  };
}

export interface LevelOption {
  idx: number;
  role: 'stop' | 'target';
  kind: string;
  label: string;
  /** null for R-multiple targets (resolved from the chosen stop) */
  price: number | null;
  r_multiple: number | null;
  dist_atr: number | null;
  dist_pct: number | null;
}

export interface LevelMenu {
  close: number;
  atr14: number;
  stops: LevelOption[];
  targets: LevelOption[];
}

export const MAX_OPTIONS = 8;

/** Arm D menu: ≤ 8 stops below close, ≤ 8 targets above; structure first, then ATR / R multiples; deduped at 0.15 ATR. */
export function enumerateLevels(v: View): LevelMenu {
  assertVisible(v);
  const f = tfFeatures(v.bars);
  const c = f.close;
  const a = f.atr14;
  const ps = pivots(v.bars, 3, 3);
  const lows1h = [...new Set(ps.filter((p) => p.kind === 'low' && p.price < c).map((p) => p.price))].sort((x, y) => y - x);
  const highs1h = [...new Set(ps.filter((p) => p.kind === 'high' && p.price > c).map((p) => p.price))].sort((x, y) => x - y);
  const h4 = htfLevels(v, '4h');
  const d1 = htfLevels(v, '1d');
  const vw = vwap(v.bars, 24);
  const vp = volumeProfile(v.bars, 120, 24);
  const buf = 0.1 * a;
  type Raw = { kind: string; label: string; price: number | null; r?: number };
  const stopRaw: Raw[] = [];
  lows1h.slice(0, 2).forEach((p, i) => stopRaw.push({ kind: 'swing_low_1h', label: `1h swing low #${i + 1} (${p}) −0.1ATR`, price: p - buf }));
  stopRaw.push({ kind: 'll10', label: `lowest low 10 bars (${f.ll10}) −0.1ATR`, price: f.ll10 - buf });
  if (h4.lows_below[0] !== undefined) stopRaw.push({ kind: 'swing_low_4h', label: `4h swing low (${h4.lows_below[0]}) −0.1ATR`, price: h4.lows_below[0] - buf });
  if (d1.lows_below[0] !== undefined) stopRaw.push({ kind: 'swing_low_1d', label: `1d swing low (${d1.lows_below[0]}) −0.1ATR`, price: d1.lows_below[0] - buf });
  if (vw < c) stopRaw.push({ kind: 'vwap24', label: `24h VWAP (${vw}) −0.1ATR`, price: vw - buf });
  for (const m of [1, 1.5, 2, 3]) stopRaw.push({ kind: `atr_${m}`, label: `${m}×ATR14 below close`, price: c - m * a });
  const stops: LevelOption[] = [];
  for (const r of stopRaw) {
    const d = (c - r.price!) / a;
    if (!(d >= 0.25 && d <= 6)) continue;
    if (stops.some((s) => Math.abs(s.price! - r.price!) < 0.15 * a)) continue;
    if (stops.length >= MAX_OPTIONS) break;
    stops.push({ idx: 0, role: 'stop', kind: r.kind, label: r.label, price: r.price, r_multiple: null, dist_atr: d, dist_pct: ((c - r.price!) / c) * 100 });
  }
  stops.sort((x, y) => y.price! - x.price!).forEach((s, i) => (s.idx = i));
  const tgtRaw: Raw[] = [];
  if (highs1h[0] !== undefined) tgtRaw.push({ kind: 'swing_high_1h', label: `1h swing high #1 (${highs1h[0]})`, price: highs1h[0] });
  if (h4.highs_above[0] !== undefined) tgtRaw.push({ kind: 'swing_high_4h', label: `4h swing high (${h4.highs_above[0]})`, price: h4.highs_above[0] });
  if (d1.highs_above[0] !== undefined) tgtRaw.push({ kind: 'swing_high_1d', label: `1d swing high (${d1.highs_above[0]})`, price: d1.highs_above[0] });
  if (highs1h[1] !== undefined) tgtRaw.push({ kind: 'swing_high_1h', label: `1h swing high #2 (${highs1h[1]})`, price: highs1h[1] });
  const hvnAbove = vp.hvn.filter((x) => x > c).sort((x, y) => x - y)[0];
  if (hvnAbove !== undefined) tgtRaw.push({ kind: 'hvn_120', label: `volume node above (120 bars, ${hvnAbove})`, price: hvnAbove });
  const structural: LevelOption[] = [];
  for (const r of tgtRaw) {
    const d = (r.price! - c) / a;
    if (!(d >= 0.5 && d <= 10)) continue;
    if (structural.some((s) => Math.abs(s.price! - r.price!) < 0.15 * a)) continue;
    structural.push({ idx: 0, role: 'target', kind: r.kind, label: r.label, price: r.price, r_multiple: null, dist_atr: d, dist_pct: ((r.price! - c) / c) * 100 });
  }
  structural.sort((x, y) => x.price! - y.price!);
  const rTargets: LevelOption[] = [2, 3, 1.5, 1].map((k) => ({ idx: 0, role: 'target', kind: `r_${k}`, label: `${k}R of the chosen stop`, price: null, r_multiple: k, dist_atr: null, dist_pct: null }));
  const targets = [...structural.slice(0, MAX_OPTIONS - 2), ...rTargets].slice(0, MAX_OPTIONS);
  targets.forEach((t, i) => (t.idx = i));
  return { close: c, atr14: a, stops, targets };
}

/** Arm D resolution: indices → prices. Throws on out-of-range indices (the caller treats that as invalid output). */
export function resolvePick(menu: LevelMenu, stopIdx: number, targetIdx: number | null): Geometry {
  const s = menu.stops[stopIdx];
  if (!Number.isInteger(stopIdx) || !s) throw new Error(`stop_idx_out_of_range:${stopIdx}`);
  let t: LevelOption | undefined;
  if (targetIdx !== null) {
    t = menu.targets[targetIdx];
    if (!Number.isInteger(targetIdx) || !t) throw new Error(`target_idx_out_of_range:${targetIdx}`);
  }
  const stop = s.price!;
  const target = t ? (t.r_multiple !== null ? menu.close + t.r_multiple * (menu.close - stop) : t.price) : null;
  return { stop, target, rationale: '', source_levels: [`stop[${stopIdx}] ${s.label}`, t ? `target[${targetIdx}] ${t.label}` : 'target: none'], flags: [] };
}

// ─────────────────────────────── settlement ───────────────────────────────

export interface Settlement {
  variant: 'plan' | 'trail';
  /** stop = initial stop hit; trail = exit after the chandelier raised the stop; tp; expired; invalid */
  status: string;
  fill: number | null;
  exit_price: number | null;
  bars_held: number | null;
  gross_r: number | null;
  net_r: number | null;
  mfe_r: number | null;
  mae_r: number | null;
  note: string;
}

const r4 = (x: number | null | undefined): number | null => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);

/** Variant (i): outcome.ts simulateOutcome over the next 48 bars (market fill at next open, stop wins ties, net of DEFAULT_COSTS). */
export function settlePlan(g: Geometry, future: readonly Bar[], atr14: number): Settlement {
  const o = simulateOutcome({ direction: 'long', entry: 'market', limit_price: null, stop: g.stop, tp: g.target, bars: future.slice(0, PLAN_BARS), atr: atr14 });
  return { variant: 'plan', status: o.status, fill: o.fill_price, exit_price: o.exit_price, bars_held: o.bars_held, gross_r: r4(o.gross_r), net_r: r4(o.net_r), mfe_r: r4(o.mfe_r), mae_r: r4(o.mae_r), note: o.note };
}

/** Variant (ii): same initial stop, chandelier HH−3×ATR22 on closed bars (tighten only), no target, ≤ 168 bars. */
export function settleTrail(g: Geometry, history: readonly Bar[], future: readonly Bar[], atr14: number): Settlement {
  const bars = future.slice(0, TRAIL_BARS);
  const none = (status: string, note: string): Settlement => ({ variant: 'trail', status, fill: null, exit_price: null, bars_held: null, gross_r: null, net_r: null, mfe_r: null, mae_r: null, note });
  if (!bars.length) return none('invalid', 'no future bars');
  const fill = N(bars[0]!.open);
  const t = openTrade('long', fill, g.stop, null);
  if (!t) return none('invalid', `stop ${g.stop} on the wrong side of fill ${fill}`);
  const seen: Bar[] = history.slice(-(CHANDELIER_N + 1));
  let extreme = fill;
  let exit: { price: number; at: number; status: string; held: number } | null = null;
  for (const b of bars) {
    const tail = seen.slice(-(CHANDELIER_N + 1));
    if (tail.length > CHANDELIER_N) {
      let tr = 0;
      for (let i = 1; i < tail.length; i++) {
        const h = N(tail[i]!.high);
        const l = N(tail[i]!.low);
        const pc = N(tail[i - 1]!.close);
        tr += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      }
      const trail = extreme - CHANDELIER_MULT * (tr / CHANDELIER_N);
      if (trail > t.stop) t.stop = trail;
    }
    const s = stepTrade(t, b, false);
    if (s.exit) {
      exit = { price: s.exit.price, at: s.exit.at, status: s.exit.status === 'stop' && t.stop > g.stop ? 'trail' : s.exit.status, held: t.bars_held };
      break;
    }
    seen.push(b);
    extreme = Math.max(extreme, N(b.high));
  }
  if (!exit) {
    const last = bars.at(-1)!;
    exit = { price: N(last.close), at: last.close_time, status: 'expired', held: t.bars_held };
  }
  const gross = tradeR(t, exit.price);
  const cost = tradeCosts(t, exit.price, 'market', bars[0]!.open_time, exit.at, atr14);
  return { variant: 'trail', status: exit.status, fill, exit_price: exit.price, bars_held: exit.held, gross_r: r4(gross), net_r: r4(gross - cost.cost_r), mfe_r: r4(t.mfe_r), mae_r: r4(t.mae_r), note: exit.status === 'trail' ? `trail stop ${t.stop}` : exit.status };
}

// ─────────────────────────────── metrics ───────────────────────────────

export interface ArmRow {
  id: string;
  arm: string;
  ref_close: number;
  atr14: number;
  g: Geometry;
  plan: Settlement;
  trail: Settlement;
  calls: number;
  in_tok: number;
  out_tok: number;
  latency_ms: number;
  cost_cny: number;
}

export interface ArmSummary {
  arm: string;
  variant: 'plan' | 'trail';
  n: number;
  invalid: number;
  exp_r: number | null;
  win_rate: number | null;
  stop_hit: number | null;
  target_hit: number | null;
  trail_exit: number | null;
  expired: number | null;
  stop_atr_mean: number | null;
  noise_stop_share: number | null;
  target_null_share: number | null;
  rr_p10: number | null;
  rr_p50: number | null;
  rr_p90: number | null;
  rr_share_13_17: number | null;
  hallucinated_rate: number | null;
  fallback_rate: number | null;
  calls_per: number | null;
  tokens_per: number | null;
  latency_s_per: number | null;
  cost_cny_per: number | null;
}

export function stopAtr(r: Pick<ArmRow, 'ref_close' | 'atr14' | 'g'>): number {
  return (r.ref_close - r.g.stop) / r.atr14;
}

export function plannedRR(r: Pick<ArmRow, 'ref_close' | 'g'>): number | null {
  return r.g.target === null ? null : (r.g.target - r.ref_close) / (r.ref_close - r.g.stop);
}

export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

const share = (xs: boolean[]): number | null => (xs.length ? xs.filter(Boolean).length / xs.length : null);
const avg = (xs: number[]): number | null => (xs.length ? mean(xs) : null);

export function summarizeArm(arm: string, variant: 'plan' | 'trail', rows: ArmRow[]): ArmSummary {
  const settled = rows.filter((r) => r[variant].net_r !== null);
  const st = settled.map((r) => r[variant]);
  const rr = rows.map(plannedRR).filter((x): x is number => x !== null);
  const model = rows.filter((r) => r.calls > 0 || r.arm !== 'A');
  return {
    arm,
    variant,
    n: settled.length,
    invalid: rows.length - settled.length,
    exp_r: avg(st.map((s) => s.net_r!)),
    win_rate: share(st.map((s) => s.net_r! > 0)),
    stop_hit: share(st.map((s) => s.status === 'stop')),
    target_hit: share(st.map((s) => s.status === 'tp')),
    trail_exit: share(st.map((s) => s.status === 'trail')),
    expired: share(st.map((s) => s.status === 'expired')),
    stop_atr_mean: avg(rows.map(stopAtr)),
    noise_stop_share: share(rows.map((r) => stopAtr(r) < 1)),
    target_null_share: share(rows.map((r) => r.g.target === null)),
    rr_p10: quantile(rr, 0.1),
    rr_p50: quantile(rr, 0.5),
    rr_p90: quantile(rr, 0.9),
    rr_share_13_17: rr.length ? rr.filter((x) => x >= 1.3 && x <= 1.7).length / rr.length : null,
    hallucinated_rate: model.length ? share(rows.map((r) => r.g.flags.includes('hallucinated'))) : null,
    fallback_rate: model.length ? share(rows.map((r) => r.g.flags.includes('fallback_a'))) : null,
    calls_per: avg(rows.map((r) => r.calls)),
    tokens_per: avg(rows.map((r) => r.in_tok + r.out_tok)),
    latency_s_per: avg(rows.map((r) => r.latency_ms / 1000)),
    cost_cny_per: avg(rows.map((r) => r.cost_cny)),
  };
}

/** Deterministic PRNG for the bootstrap (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Paired {
  arm: string;
  variant: 'plan' | 'trail';
  n: number;
  mean: number | null;
  lo: number | null;
  hi: number | null;
  better: number;
  worse: number;
  same: number;
}

/** Per-candidate (arm − A) net R with a 95% percentile bootstrap CI. */
export function pairedVsA(arm: string, variant: 'plan' | 'trail', rows: ArmRow[], aRows: ArmRow[], seed = 20260923, resamples = 5000): Paired {
  const a = new Map(aRows.map((r) => [r.id, r[variant].net_r]));
  const d: number[] = [];
  for (const r of rows) {
    const x = r[variant].net_r;
    const y = a.get(r.id);
    if (x === null || y === null || y === undefined) continue;
    d.push(x - y);
  }
  if (!d.length) return { arm, variant, n: 0, mean: null, lo: null, hi: null, better: 0, worse: 0, same: 0 };
  const ci = bootstrapCI(d, seed, resamples);
  return { arm, variant, n: d.length, mean: mean(d), lo: ci.lo, hi: ci.hi, better: d.filter((x) => x > 1e-9).length, worse: d.filter((x) => x < -1e-9).length, same: d.filter((x) => Math.abs(x) <= 1e-9).length };
}

export function bootstrapCI(d: number[], seed = 20260923, resamples = 5000): { lo: number | null; hi: number | null } {
  if (!d.length) return { lo: null, hi: null };
  const rand = rng(seed);
  const means: number[] = [];
  for (let k = 0; k < resamples; k++) {
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[Math.floor(rand() * d.length)]!;
    means.push(s / d.length);
  }
  return { lo: quantile(means, 0.025), hi: quantile(means, 0.975) };
}

export interface StopRuleRow {
  arm: string;
  k: number;
  n: number;
  rejected_share: number | null;
  kept_plan: number | null;
  rejected_plan: number | null;
  kept_trail: number | null;
  rejected_trail: number | null;
  /** per-candidate (rule − no rule): rejected trades become 0R, kept ones are unchanged */
  delta_plan: { mean: number | null; lo: number | null; hi: number | null };
  delta_trail: { mean: number | null; lo: number | null; hi: number | null };
}

/** "止血" rule: refuse the trade when its stop sits closer than k × ATR14 to the reference close (decision-time distance). */
export function stopRule(arm: string, rows: ArmRow[], k: number): StopRuleRow {
  const settled = rows.filter((r) => r.plan.net_r !== null && r.trail.net_r !== null);
  const rejected = (r: ArmRow): boolean => stopAtr(r) < k - 1e-9;
  const rej = settled.filter(rejected);
  const kept = settled.filter((r) => !rejected(r));
  const delta = (v: 'plan' | 'trail') => {
    const d = settled.map((r) => (rejected(r) ? -r[v].net_r! : 0));
    return { mean: d.length ? mean(d) : null, ...bootstrapCI(d) };
  };
  return {
    arm,
    k,
    n: settled.length,
    rejected_share: settled.length ? rej.length / settled.length : null,
    kept_plan: avg(kept.map((r) => r.plan.net_r!)),
    rejected_plan: avg(rej.map((r) => r.plan.net_r!)),
    kept_trail: avg(kept.map((r) => r.trail.net_r!)),
    rejected_trail: avg(rej.map((r) => r.trail.net_r!)),
    delta_plan: delta('plan'),
    delta_trail: delta('trail'),
  };
}

/** Systematic sample: every k-th candidate by as_of — deterministic, spread over time and symbols. */
export function pilotSample<T extends { as_of: number; id: string }>(cands: T[], n: number): T[] {
  const s = [...cands].sort((x, y) => x.as_of - y.as_of || x.id.localeCompare(y.id));
  if (s.length <= n) return s;
  const step = s.length / n;
  return Array.from({ length: n }, (_, i) => s[Math.floor(i * step + step / 2)]!);
}
