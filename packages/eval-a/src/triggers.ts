// trigger_precision: replay `demo.detectTriggers` on a case's *visible* bars and score each fired rule
// against the hidden future — "did the move the rule pointed at actually happen?". The rules are the
// live ones (triggers.ts in the gateway); nothing is re-implemented here except the direction each kind
// implies and the favourable-excursion measurement, which the runtime has no reason to know about.

import { demo } from '@trade-gate/gateway';
import type { EvalCase, Kline, MarketView } from './types.js';

export type TriggerDirection = 'long' | 'short' | null;

export interface TriggerCheck {
  case_id: string;
  kind: string;
  detail: string;
  score: number;
  direction: TriggerDirection;
  /** Max favourable excursion in the trigger's direction over the horizon, in ATR14 of the scan tf. */
  max_favorable_atr: number | null;
  /** null = not scoreable (no direction, or no hidden bars). */
  valid: boolean | null;
}

/** ≥ 1 ATR of same-direction displacement inside the horizon counts the trigger as having been right. */
export const VALID_ATR = 1;

/**
 * `TriggerInputs` from a case. Everything except `fast_move_pct` is reconstructible: prev_tf is the same
 * features one bar back, prev_session is the session one bar back, the threshold is the workflow default.
 * The mark-price ring buffer that feeds fast_move is *not* in the case, so fast_move can never fire here.
 */
export function triggerInputsFor(c: EvalCase): demo.TriggerInputs | null {
  const ks = c.visible.klines[c.timeframe];
  if (!ks) return null;
  return buildTriggerInputs({ symbol: c.symbol, tf: c.timeframe, tfKlines: ks, h1Klines: c.visible.klines['1h'] ?? null, market: c.visible.market, at: c.as_of });
}

export interface TriggerInputSpec {
  symbol: string;
  tf: string;
  /** The visible window on `tf` ending at the bar that just closed (≥ 21 bars, else null is returned). */
  tfKlines: Kline[];
  h1Klines: Kline[] | null;
  /** Only feeds the (unscored) funding rule; null is fine when the case's market view does not exist yet. */
  market: MarketView | null;
  at: number;
}

/**
 * The one place a `demo.TriggerInputs` is reconstructed from recorded bars — shared by the report (replay on
 * the as_of bar) and by `gen --sample triggers` (pick as_of AT a firing bar), so the generator and the metric
 * can never drift apart.
 */
export function buildTriggerInputs(spec: TriggerInputSpec): demo.TriggerInputs | null {
  const ks = spec.tfKlines;
  if (ks.length < 21) return null;
  const tfMs = demo.tfToMs(spec.tf);
  return {
    symbol: spec.symbol,
    now_tf: demo.tfFeatures(spec.tf, ks),
    prev_tf: demo.tfFeatures(spec.tf, ks.slice(0, -1)),
    h1: spec.h1Klines ? demo.tfFeatures('1h', spec.h1Klines) : null,
    market: spec.market,
    session: demo.sessionInfo(spec.at),
    fast_move_pct: null,
    fast_move_threshold_pct: Number(demo.DEFAULT_WORKFLOW.fast_move_pct),
    prev_session: demo.sessionInfo(spec.at - tfMs).name,
  };
}

/**
 * The trigger kinds `trigger_precision` can actually score (they imply a side). `gen --sample triggers` picks
 * as_of only at bars where at least one of these fires — funding/session/fast_move point nowhere.
 */
export const SCORED_TRIGGER_KINDS = ['breakout', 'vol_spike', 'retest', 'ema_cross'] as const;
export type ScoredTriggerKind = (typeof SCORED_TRIGGER_KINDS)[number];

/** The scoreable kinds that fire on these inputs, strongest first ([] = nothing worth sampling here). */
export function firedScoredKinds(inp: demo.TriggerInputs | null): ScoredTriggerKind[] {
  if (!inp) return [];
  const scored = new Set<string>(SCORED_TRIGGER_KINDS);
  const out: ScoredTriggerKind[] = [];
  for (const h of demo.detectTriggers(inp)) if (scored.has(h.kind) && !out.includes(h.kind as ScoredTriggerKind)) out.push(h.kind as ScoredTriggerKind);
  return out;
}

/** `trig:<kind>` tags for a scan case, computed exactly the way the report replays the rules on its as_of bar. */
export function triggerTags(c: EvalCase): string[] {
  return firedScoredKinds(triggerInputsFor(c)).map((k) => `trig:${k}`);
}

/** The side a fired rule points at. funding / session / fast_move point nowhere and are not scored. */
export function directionOf(kind: string, inp: demo.TriggerInputs): TriggerDirection {
  const f = inp.now_tf;
  const p = inp.prev_tf;
  switch (kind) {
    case 'breakout':
      if (p) return f.last_close > p.swing_high_20 ? 'long' : f.last_close < p.swing_low_20 ? 'short' : null;
      return f.dist_to_high20_pct <= 0.02 && f.change_pct_last > 0 ? 'long' : f.dist_to_low20_pct <= 0.02 && f.change_pct_last < 0 ? 'short' : null;
    case 'ema_cross':
      return f.ema20 > f.ema50 ? 'long' : 'short';
    case 'vol_spike':
      return f.change_pct_last >= 0 ? 'long' : 'short';
    case 'retest':
      return inp.h1 ? (inp.h1.ema20 > inp.h1.ema50 ? 'long' : 'short') : null;
    default:
      return null; // funding: a squeeze either way; session: a calendar fact; fast_move: never fires here
  }
}

/** Max same-direction move from the as_of close over the horizon, in ATR. */
export function favorableAtr(c: EvalCase, direction: Exclude<TriggerDirection, null>, atr: number, close: number): number | null {
  const bars = c.hidden.future_klines.slice(0, c.hidden.horizon_bars);
  if (!bars.length || !(atr > 0)) return null;
  const best = direction === 'long' ? Math.max(...bars.map((k) => Number(k.high))) - close : close - Math.min(...bars.map((k) => Number(k.low)));
  return best / atr;
}

export function checkTriggers(c: EvalCase): TriggerCheck[] {
  const inp = triggerInputsFor(c);
  if (!inp) return [];
  const close = inp.now_tf.last_close;
  const atr = inp.now_tf.atr14;
  return demo.detectTriggers(inp).map((h) => {
    const direction = directionOf(h.kind, inp);
    const mfe = direction ? favorableAtr(c, direction, atr, close) : null;
    return { case_id: c.id, kind: h.kind, detail: h.detail, score: h.score, direction, max_favorable_atr: mfe === null ? null : Math.round(mfe * 1000) / 1000, valid: mfe === null ? null : mfe >= VALID_ATR };
  });
}

export interface TriggerPrecision {
  cases: number;
  hits: number;
  scored: number;
  valid: number;
  precision: number | null;
  by_kind: Record<string, { n: number; valid: number; precision: number | null; mean_mfe_atr: number | null }>;
  unscored_by_kind: Record<string, number>;
}

/**
 * Precision over the scan cases that carry distinct market data: the stale / halted variants are the
 * same bars as their base case (only observed_at / the halt flag differ) so counting them would just
 * triple every hit; mirrors are genuinely different price paths and are kept.
 */
export function triggerPrecision(cases: EvalCase[]): { summary: TriggerPrecision; in_sample: TriggerPrecision; checks: TriggerCheck[] } {
  const scan = cases.filter((c) => c.mode === 'scan' && !c.tags.includes('stale') && !c.tags.includes('halted'));
  const checks = scan.flatMap((c) => checkTriggers(c));
  const inSample = scan.flatMap((c) => inSampleChecks(c));
  return { summary: summarize(checks, scan.length), in_sample: summarize(inSample, scan.length), checks };
}

// ---------------------------------------------------------------- in-sample supplement

/**
 * The same rules replayed on every *visible* bar of a case and scored against the bars that follow it
 * inside the same visible window. This is a supplement, not the headline number: it is scored on data
 * the case already shows (no hidden bars), and it exists because the case set's as_of moments are drawn
 * uniformly, so a rule almost never happens to fire exactly on the as_of bar — see the note the report
 * prints. `min_forward` keeps the tail bars (too little room left to move) out of the sample.
 */
export function inSampleChecks(c: EvalCase, minForward = 8): TriggerCheck[] {
  const ks = c.visible.klines[c.timeframe];
  const h1 = c.visible.klines['1h'];
  if (!ks || ks.length < 22 + minForward) return [];
  const tfMs = demo.tfToMs(c.timeframe);
  const h1Features = h1 ? demo.tfFeatures('1h', h1) : null;
  const out: TriggerCheck[] = [];
  for (let i = 21; i < ks.length - minForward; i++) {
    const window = ks.slice(0, i + 1);
    const bar = ks[i]!;
    const at = bar.close_time + 1;
    const inp: demo.TriggerInputs = {
      symbol: c.symbol,
      now_tf: demo.tfFeatures(c.timeframe, window),
      prev_tf: demo.tfFeatures(c.timeframe, ks.slice(0, i)),
      // h1 features / funding are the as_of snapshot, not a per-bar replay: they only steer `retest`
      // direction and the (unscored) funding rule.
      h1: h1Features,
      market: c.visible.market,
      session: demo.sessionInfo(at),
      fast_move_pct: null,
      fast_move_threshold_pct: Number(demo.DEFAULT_WORKFLOW.fast_move_pct),
      prev_session: demo.sessionInfo(at - tfMs).name,
    };
    const close = inp.now_tf.last_close;
    const atr = inp.now_tf.atr14;
    const forward = ks.slice(i + 1, i + 1 + c.hidden.horizon_bars);
    for (const h of demo.detectTriggers(inp)) {
      const direction = directionOf(h.kind, inp);
      let mfe: number | null = null;
      if (direction && atr > 0 && forward.length) {
        const best = direction === 'long' ? Math.max(...forward.map((k) => Number(k.high))) - close : close - Math.min(...forward.map((k) => Number(k.low)));
        mfe = best / atr;
      }
      out.push({ case_id: `${c.id}@bar${i}`, kind: h.kind, detail: h.detail, score: h.score, direction, max_favorable_atr: mfe === null ? null : Math.round(mfe * 1000) / 1000, valid: mfe === null ? null : mfe >= VALID_ATR });
    }
  }
  return out;
}

export function summarize(checks: TriggerCheck[], cases: number): TriggerPrecision {
  const by_kind: TriggerPrecision['by_kind'] = {};
  const unscored: Record<string, number> = {};
  for (const t of checks) {
    if (t.valid === null) {
      unscored[t.kind] = (unscored[t.kind] ?? 0) + 1;
      continue;
    }
    const b = (by_kind[t.kind] ??= { n: 0, valid: 0, precision: null, mean_mfe_atr: null });
    b.n++;
    if (t.valid) b.valid++;
  }
  for (const [kind, b] of Object.entries(by_kind)) {
    b.precision = b.n ? Math.round((b.valid / b.n) * 10000) / 10000 : null;
    const mfes = checks.filter((t) => t.kind === kind && t.max_favorable_atr !== null).map((t) => t.max_favorable_atr!);
    b.mean_mfe_atr = mfes.length ? Math.round((mfes.reduce((a, x) => a + x, 0) / mfes.length) * 1000) / 1000 : null;
  }
  const scored = checks.filter((t) => t.valid !== null);
  const valid = scored.filter((t) => t.valid).length;
  return {
    cases,
    hits: checks.length,
    scored: scored.length,
    valid,
    precision: scored.length ? Math.round((valid / scored.length) * 10000) / 10000 : null,
    by_kind: Object.fromEntries(Object.entries(by_kind).sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))),
    unscored_by_kind: Object.fromEntries(Object.entries(unscored).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
  };
}
