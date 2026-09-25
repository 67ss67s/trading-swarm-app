// Judgment output contract validator (docs/demo/README.md §2 `Judgment`). Hand-written on purpose:
// the gateway must not grow a schema library just for one recipe, and the error strings feed the
// one repair attempt the brain gets before we fail closed to NO_TRADE.

import { ACTIONS, type Action, type Direction, type Evidence, type Judgment, type Proposal } from './types.js';

const DECIMAL = /^\d+(\.\d+)?$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strOrNull(v: unknown, field: string, errors: string[]): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') {
    errors.push(`${field} must be string or null`);
    return null;
  }
  return v;
}

function decimalOrNull(v: unknown, field: string, errors: string[]): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = typeof v === 'number' ? String(v) : v;
  if (typeof s !== 'string' || !DECIMAL.test(s)) {
    errors.push(`${field} must be a decimal string like "77650.5" or null`);
    return null;
  }
  return s;
}

function strArray(v: unknown, field: string, errors: string[], max = 8): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    errors.push(`${field} must be an array of strings`);
    return [];
  }
  const out = v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean);
  if (out.length !== v.length) errors.push(`${field} must contain only non-empty strings`);
  return out.slice(0, max);
}

export interface ValidationResult {
  judgment: Judgment | null;
  errors: string[];
}

export interface ValidateOptions {
  /**
   * v3.5 strategy library: the strategy ids the context offered. When non-empty, a PROPOSE must name one of
   * them (contract error → the same single repair round every other contract error gets).
   */
  strategies?: string[];
}

export function validateJudgment(raw: unknown, validRefs: Set<string>, opts: ValidateOptions = {}): ValidationResult {
  const errors: string[] = [];
  if (!isObj(raw)) return { judgment: null, errors: ['output must be a single JSON object'] };

  const action = raw['action'];
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    errors.push(`action must be one of ${ACTIONS.join('|')}`);
  }
  let direction: Direction | null = null;
  if (raw['direction'] === 'long' || raw['direction'] === 'short') direction = raw['direction'];
  else if (raw['direction'] !== null && raw['direction'] !== undefined) errors.push('direction must be "long", "short" or null');

  const confidenceRaw = Number(raw['confidence']);
  const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : NaN;
  if (Number.isNaN(confidence)) errors.push('confidence must be a number between 0 and 1');

  const headline = typeof raw['headline'] === 'string' ? raw['headline'].trim() : '';
  if (!headline) errors.push('headline must be a non-empty string (≤ 40 chars)');
  const thesis = typeof raw['thesis'] === 'string' ? raw['thesis'].trim() : '';
  if (!thesis) errors.push('thesis must be a non-empty string');

  const reasons = strArray(raw['reasons'], 'reasons', errors, 6);
  if (reasons.length < 1) errors.push('reasons must have at least 1 item');

  const evidence_refs = strArray(raw['evidence_refs'], 'evidence_refs', errors, 20);
  const badRefs = evidence_refs.filter((r) => !validRefs.has(r));
  if (badRefs.length) errors.push(`evidence_refs contains unknown refs: ${badRefs.join(', ')} (allowed: ${[...validRefs].join(', ')})`);
  if (evidence_refs.length === 0) errors.push('evidence_refs must cite at least one E<n> ref');
  // Invariant 2 (docs/eval/README.md §1): every reason must cite at least one registered ref.
  reasons.forEach((r, i) => {
    const cited = [...r.matchAll(/\[(E\d+)(?:\]\[(E\d+))*\]/g)].flatMap((m) => m.slice(1).filter(Boolean));
    const anyRef = (r.match(/E\d+/g) ?? []).filter((x) => validRefs.has(x));
    if (anyRef.length === 0) errors.push(`reasons[${i}] must end with a citation like [E3] (registered refs only)`);
    else if (cited.some((c) => !validRefs.has(c))) errors.push(`reasons[${i}] cites an unregistered ref`);
  });

  const invalidation = strOrNull(raw['invalidation'], 'invalidation', errors);
  const invalidation_price = decimalOrNull(raw['invalidation_price'], 'invalidation_price', errors);
  const target_price = decimalOrNull(raw['target_price'], 'target_price', errors);
  const watch_conditions = strArray(raw['watch_conditions'], 'watch_conditions', errors, 6);

  let proposal: Proposal | null = null;
  const p = raw['proposal'];
  if (p !== null && p !== undefined) {
    if (!isObj(p)) errors.push('proposal must be an object or null');
    else {
      const pd = p['direction'];
      const market = p['market'] ?? 'perp';
      if (market !== 'perp' && market !== 'spot') errors.push('invalid_market');
      if (market === 'spot' && pd !== 'long') errors.push('spot_no_short');
      const entry = p['entry'];
      const stop = decimalOrNull(p['stop_price'], 'proposal.stop_price', errors);
      if (pd !== 'long' && pd !== 'short') errors.push('proposal.direction must be "long" or "short"');
      if (entry !== 'market' && entry !== 'limit') errors.push('proposal.entry must be "market" or "limit"');
      if (!stop && market !== 'spot') errors.push('proposal.stop_price is required');
      const limit_price = decimalOrNull(p['limit_price'], 'proposal.limit_price', errors);
      if (entry === 'limit' && !limit_price) errors.push('proposal.limit_price required when entry is "limit"');
      let take_profit_price = decimalOrNull(p['take_profit_price'], 'proposal.take_profit_price', errors);
      const take_profits: string[] = [];
      if (Array.isArray(p['take_profits'])) {
        for (const [i, tp] of (p['take_profits'] as unknown[]).entries()) {
          const d = decimalOrNull(tp, `proposal.take_profits[${i}]`, errors);
          if (d) take_profits.push(d);
        }
      }
      if (take_profit_price && take_profits.length === 0) take_profits.push(take_profit_price);
      if (!take_profit_price && take_profits[0]) take_profit_price = take_profits[0];
      let entry_zone: [string, string] | null = null;
      const z = p['entry_zone'];
      if (Array.isArray(z) && z.length === 2) {
        const lo = decimalOrNull(z[0], 'proposal.entry_zone[0]', errors);
        const hi = decimalOrNull(z[1], 'proposal.entry_zone[1]', errors);
        if (lo && hi) entry_zone = Number(lo) <= Number(hi) ? [lo, hi] : [hi, lo];
      } else if (z !== null && z !== undefined) errors.push('proposal.entry_zone must be [lo, hi] or null');
      const rationale = typeof p['rationale'] === 'string' ? p['rationale'] : '';
      if (pd === 'long' || pd === 'short') {
        if (entry === 'market' || entry === 'limit') {
          proposal = { market: market === 'spot' ? 'spot' : 'perp', direction: pd, entry, limit_price, entry_zone, stop_price: stop, take_profit_price, take_profits: take_profits.slice(0, 3), rationale };
          if (p['risk_plan'] !== undefined) {
            const rp = p['risk_plan'];
            if (!isObj(rp) || typeof rp['atr_timeframe'] !== 'string' || !['1m','3m','5m','15m','1h','4h','1d','1w'].includes(rp['atr_timeframe'])) errors.push('proposal.risk_plan.atr_timeframe is invalid');
            else {
              const multiple = decimalOrNull(rp['stop_atr_multiple'], 'proposal.risk_plan.stop_atr_multiple', errors);
              if (!multiple || Number(multiple) < 0.5 || Number(multiple) > 4) errors.push('proposal.risk_plan.stop_atr_multiple must be 0.5..4');
              else proposal.risk_plan = { atr_timeframe: rp['atr_timeframe'], stop_atr_multiple: multiple };
            }
          }
        }
      }
    }
  }
  const allowedStrategies = opts.strategies ?? [];
  let strategy_id: string | null = null;
  const rawStrategy = raw['strategy_id'];
  if (typeof rawStrategy === 'string' && rawStrategy.trim()) strategy_id = rawStrategy.trim();
  else if (rawStrategy !== null && rawStrategy !== undefined && rawStrategy !== '') errors.push('strategy_id must be a string or null');
  if (strategy_id !== null && allowedStrategies.length && !allowedStrategies.includes(strategy_id)) {
    errors.push(`strategy_id ${strategy_id} is not one of the active strategies (${allowedStrategies.join(', ')})`);
  }
  if (action === 'PROPOSE' && allowedStrategies.length && strategy_id === null) {
    errors.push(`action PROPOSE requires strategy_id, one of: ${allowedStrategies.join(', ')}`);
  }

  if (action === 'PROPOSE' && !proposal) errors.push('action PROPOSE requires a proposal object');
  if (action === 'PROPOSE' && proposal && direction && proposal.direction !== direction) errors.push('proposal.direction must equal direction');
  if (action === 'PROPOSE' && !direction) direction = proposal?.direction ?? null;
  if (action !== 'PROPOSE' && proposal) proposal = null; // ignore stray proposals

  if (errors.length) return { judgment: null, errors };
  return {
    judgment: {
      action: action as Action,
      direction,
      confidence,
      headline: headline.slice(0, 60),
      thesis: thesis.slice(0, 400),
      reasons,
      evidence_refs,
      invalidation,
      invalidation_price,
      target_price,
      watch_conditions,
      proposal,
      strategy_id,
    },
    errors: [],
  };
}

/** Pulls the first balanced top-level JSON object out of free text (models love to wrap in ``` fences). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  if (start < 0) throw new Error('no JSON object in output');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  throw new Error('unterminated JSON object in output');
}

// ---------------------------------------------------------------- MarketState (information officer output)

import type { MarketState, Regime } from './types.js';

const REGIMES: Regime[] = ['trend_up', 'trend_down', 'range', 'volatile', 'unclear'];

export interface MarketStateModelOutput {
  regime: Regime;
  bias: 'long' | 'short' | 'neutral';
  summary: string;
  key_points: string[];
  news: { ref: string; relevance: 'high' | 'medium' | 'low'; digest: string }[];
  candidates: MarketState['candidates'];
  risk_events: string[];
}

export function validateMarketState(raw: unknown, validInfoRefs: Set<string>, watchlist: string[]): { value: MarketStateModelOutput | null; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw)) return { value: null, errors: ['output must be a single JSON object'] };
  const regime = raw['regime'];
  if (typeof regime !== 'string' || !REGIMES.includes(regime as Regime)) errors.push(`regime must be one of ${REGIMES.join('|')}`);
  const bias = raw['bias'];
  if (bias !== 'long' && bias !== 'short' && bias !== 'neutral') errors.push('bias must be long|short|neutral');
  const summary = typeof raw['summary'] === 'string' ? raw['summary'].trim() : '';
  if (!summary) errors.push('summary must be a non-empty string (≤ 300 chars)');
  const key_points = strArray(raw['key_points'], 'key_points', errors, 6);
  if (key_points.length < 2) errors.push('key_points needs at least 2 items');
  const news: MarketStateModelOutput['news'] = [];
  if (Array.isArray(raw['news'])) {
    for (const n of raw['news'] as unknown[]) {
      if (!isObj(n)) continue;
      const ref = String(n['ref'] ?? '');
      if (!validInfoRefs.has(ref)) {
        errors.push(`news.ref ${ref} is not a registered I<n> ref`);
        continue;
      }
      const relevance = n['relevance'] === 'high' || n['relevance'] === 'medium' || n['relevance'] === 'low' ? n['relevance'] : 'low';
      news.push({ ref, relevance, digest: String(n['digest'] ?? '').slice(0, 200) });
    }
  }
  const candidates: MarketState['candidates'] = [];
  if (Array.isArray(raw['candidates'])) {
    for (const c of raw['candidates'] as unknown[]) {
      if (!isObj(c)) continue;
      const symbol = String(c['symbol'] ?? '').toUpperCase();
      const direction = c['direction'];
      if (!watchlist.includes(symbol)) {
        errors.push(`candidates.symbol ${symbol} is not in the watchlist (${watchlist.join(',')})`);
        continue;
      }
      if (direction !== 'long' && direction !== 'short') {
        errors.push('candidates.direction must be long|short');
        continue;
      }
      candidates.push({ symbol, direction, why: String(c['why'] ?? '').slice(0, 200) });
    }
  }
  const risk_events = strArray(raw['risk_events'], 'risk_events', errors, 6);
  if (errors.length) return { value: null, errors };
  return { value: { regime: regime as Regime, bias: bias as 'long' | 'short' | 'neutral', summary: summary.slice(0, 600), key_points, news: news.slice(0, 6), candidates: candidates.slice(0, 4), risk_events }, errors: [] };
}

// ---------------------------------------------------------------- v3.2 memory-number leak guard

const NUM_RE = /(?<![\w.])\d{3,}(?:\.\d+)?(?![\w])/g;

/**
 * Numbers (≥ 3 significant digits) in reasons/thesis that appear ONLY inside kind=`memory` evidence — i.e. the model
 * quoted a remembered price as if it were a market level (system rule 4b). Returned as repair errors; the eval's
 * `memory_number_leak` metric is the offline twin of this check.
 */
export function findMemoryNumberLeaks(j: Judgment, evidence: Evidence[]): string[] {
  const memEv = evidence.filter((e) => e.kind === 'memory');
  if (!memEv.length) return [];
  const nonMem = evidence.filter((e) => e.kind !== 'memory').map((e) => e.value).join(' ');
  const memText = memEv.map((e) => e.value).join(' ');
  const memNums = new Set([...memText.matchAll(NUM_RE)].map((m) => m[0]));
  if (!memNums.size) return [];
  const out: string[] = [];
  const texts = [...j.reasons, j.thesis];
  for (const t of texts) {
    for (const m of t.matchAll(NUM_RE)) {
      const n = m[0];
      if (!memNums.has(n)) continue;
      if (nonMem.includes(n)) continue; // also present in live evidence → fine
      out.push(`数字 ${n} 只出现在记忆证据里,不是现场行情,不能写进 reasons/thesis(规则 4b)`);
    }
  }
  return [...new Set(out)];
}
