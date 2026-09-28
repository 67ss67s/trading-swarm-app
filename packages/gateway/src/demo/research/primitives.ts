import { checkIR,irWarmup,timeframeMillis } from './strategy.js';
import { createHash } from 'node:crypto';
import { validate, type ResearchDataset, type ResearchRequest } from '@trade-gate/contracts';
export const ENGINE_VERSION = 'research-spot-next-open-v1';
export const SCALE = 100_000_000n;
/** 账本使用 8 位定点数，禁止 Number 金额进入记账。指标统计才使用 Number。 */
export function q(s: string): bigint {
  if (!/^-?(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(s)) throw new Error(`invalid_decimal:${s}`);
  const neg = s.startsWith('-'); const [whole, fraction = ''] = s.replace(/^-/, '').split('.');
  const n = BigInt(whole!) * SCALE + BigInt(fraction.padEnd(8, '0')); return neg ? -n : n;
}
export function decimal(n: bigint): string { const sign = n < 0 ? '-' : ''; const a = n < 0 ? -n : n; return `${sign}${a / SCALE}.${(a % SCALE).toString().padStart(8, '0')}`; }
export const mul = (a: bigint, b: bigint): bigint => a * b / SCALE;
export const div = (a: bigint, b: bigint): bigint => { if (b === 0n) throw new Error('division_by_zero'); return a * SCALE / b; };
export const min = (...a: bigint[]): bigint => a.reduce((x,y) => x < y ? x : y);
export function canonical(v: unknown): string {
  if (v === undefined) throw new Error('undefined_not_canonical');
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string,unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export const hash = (v: unknown): string => createHash('sha256').update(canonical(v)).digest('hex');
export function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }
export function assertContract<T>(v: unknown): asserts v is T { const r = validate('research', v); if (!r.ok) throw new Error(`invalid_contract:${r.errors.join(';')}`); }
export function dataset(v: unknown, allowGaps = false): ResearchDataset {
  assertContract<ResearchDataset>(v); if (!('bars' in v)) throw new Error('expected_dataset');
  if (v.bars.length < 3) throw new Error('insufficient_bars');
  let prev = -1;
  for (const b of v.bars) {
    if (b.open_time <= prev || (prev >= 0 && (allowGaps ? (b.open_time-prev)%v.timeframe_ms!==0 : b.open_time !== prev + v.timeframe_ms))) throw new Error('unordered_duplicate_or_gap');
    if (b.close_time !== b.open_time + v.timeframe_ms - 1 || b.available_at !== b.close_time) throw new Error('requires_close_available_contiguous_bars');
    if (b.close_time > v.retrieved_at) throw new Error('bar_after_retrieval');
    const [o,h,l,c,vol] = [b.open,b.high,b.low,b.close,b.volume].map(q) as [bigint,bigint,bigint,bigint,bigint];
    if (l <= 0n || h < l || o < l || o > h || c < l || c > h || vol < 0n) throw new Error('invalid_ohlcv');
    prev = b.open_time;
  }
  return clone(v);
}
export function request(v: unknown, d: ResearchDataset, allowGaps=false): ResearchRequest {
  assertContract<ResearchRequest>(v); if (!('execution' in v)) throw new Error('expected_request');
  dataset(d,allowGaps);
  if (!v.study_id.trim() || !v.idempotency_key.trim()) throw new Error('empty_identity');
  const { execution:e,policy:p } = v;
  if (q(e.initial_cash) <= 0n || q(e.qty_step) <= 0n || q(e.risk_fraction) <= 0n || q(e.risk_fraction) > q('0.1') || q(e.max_allocation) <= 0n || q(e.max_allocation) > SCALE || q(e.fee_rate) > q('0.05') || q(e.slippage_bps) > q('500')) throw new Error('invalid_execution_bounds');
  const start=d.bars.findIndex(b=>b.close_time===v.from_ms), end=d.bars.findIndex(b=>b.close_time===v.to_ms);
  if(end-start+1>10000)throw new Error('walk_bar_budget_exceeded');
  if(v.strategy_ir){const check=checkIR(v.strategy_ir,`${d.timeframe_ms/60000}m`);if(!check.ok)throw new Error('strategy_ir_checks_failed:'+check.checks.filter(c=>!c.ok).map(c=>c.name).join(','));if(v.strategy_ir.universe?.screen&&!v.universe_id)throw new Error('strategy_screen_requires_universe');}
  const warmup=v.strategy_ir?irWarmup(v.strategy_ir,d.timeframe_ms)-1:Math.max(p!.lookback,p!.atr_period);
  if (start < warmup || end <= start) throw new Error('range_or_warmup_invalid');
  if (v.arms.some(a=>a !== 'a_rules') && v.max_model_calls === 0) throw new Error('model_budget_required');
  if (v.purpose === 'holdout' && v.parent_run_id) throw new Error('holdout_must_be_preregistered_not_adaptive');
  return clone(v);
}
