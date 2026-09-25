/** 确定性策略执行器。调用方负责按 close_time 切窗及持久化状态；这里不做 I/O。 */
import { adx } from './indicators.js';
import { reversionStats } from './reversion-stats.js';
import { atr, ema } from './market.js';
import type { Direction, Kline } from './types.js';
import type { StrategySpec, StrategyFamily } from './strategies.js';

export interface SignalState { compression_bars: number; armed: boolean; last_at: number }
export interface SignalContext {
  bars: Record<string, Kline[]>;
  params: StrategySpec['params'];
  derivatives: { funding: { at: number; rate: string }[]; oi_change_pct: number | null } | null;
  regime: 'bull' | 'bear' | 'range' | 'volatile' | null;
  timeframe: string;
  confirmation: string[];
  state: SignalState;
}
export interface Setup {
  at: number; direction: Direction; entry: 'market' | 'limit'; reference_price: string;
  trigger_price?: string; atr: number; stop_distance: string; tp_r: number; invalidation: string[];
  coverage: 'ohlcv' | 'funding_only' | 'funding_oi';
}
export type SignalFn = (ctx: SignalContext) => Setup | null;
const p = (c: SignalContext, k: string, fallback: number): number => c.params[k]?.value ?? fallback;
const dir = (bars: Kline[]): Direction | null => {
  if (bars.length < 50) return null;
  let a = Number(bars[0]!.close); let b = a;
  for (let i = 1; i < bars.length; i++) { const close = Number(bars[i]!.close); a += (close - a) * (2 / 21); b += (close - b) * (2 / 51); }
  return a > b ? 'long' : a < b ? 'short' : null;
};
function metrics(c: SignalContext) {
  const bars = c.bars[c.timeframe] ?? [];
  if (bars.length < 51) return null;
  const last = bars.at(-1)!; const prev = bars.slice(-21, -1);
  const a = atr(bars.slice(-15), 14); const close = Number(last.close);
  const hi = Math.max(...prev.map(b => Number(b.high))); const lo = Math.min(...prev.map(b => Number(b.low)));
  const volume = prev.reduce((n, b) => n + Number(b.volume), 0) / 20;
  if (!(a > 0 && volume > 0)) return null;
  return { bars, last, a, close, hi, lo, vol: Number(last.volume) / volume };
}
function setup(c: SignalContext, direction: Direction, stop = 0.8, tp = 1.5, coverage: Setup['coverage'] = 'ohlcv', m = metrics(c)): Setup | null {
  if (!m) return null;
  return { at: m.last.close_time, direction, entry: 'market', reference_price: String(m.close), atr: m.a, stop_distance: String(m.a * p(c, 'stop_atr', stop)), tp_r: p(c, 'tp_r', tp), invalidation: ['收盘回到触发位另一侧；按初始止损与持有期限结算'], coverage };
}
const veto = (c: SignalContext, d: Direction) => c.regime === (d === 'long' ? 'bear' : 'bull');
const breakout = (c: SignalContext, m = metrics(c)): Direction | null => { return !m ? null : m.close > m.hi ? 'long' : m.close < m.lo ? 'short' : null; };
const trend: SignalFn = c => {
  const m = metrics(c); if (!m) return null;
  const d = dir(c.bars[c.confirmation[0] ?? '1h'] ?? []);
  if (!d || veto(c, d) || m.a / m.close * 100 < p(c, 'atr_pct_floor', 0.05)) return null;
  let level: number | null = null;
  const window = Math.max(1, Math.round(p(c, 'breakout_window', 1)));
  for (let j = m.bars.length - 1; j >= Math.max(20, m.bars.length - window); j--) {
    const prior = m.bars.slice(j - 20, j);
    const edge = d === 'long' ? Math.max(...prior.map(b => Number(b.high))) : Math.min(...prior.map(b => Number(b.low)));
    if (d === 'long' ? Number(m.bars[j]!.close) > edge : Number(m.bars[j]!.close) < edge) { level = edge; break; }
  }
  if (level === null || (d === 'long' ? m.close <= level : m.close >= level) || Math.abs(m.close - level) / m.a > p(c, 'chase_atr_max', 1.5)) return null;
  if (m.vol < p(c, 'retest_vol_min', 1) || (c.regime === 'range' && m.vol < p(c, 'range_vol_min', 1.5))) return null;
  return { ...setup(c, d, 0.8, 1.5, 'ohlcv', m)!, trigger_price: String(level) };
};
const mtf: SignalFn = c => {
  const m = metrics(c); const d = breakout(c, m); if (!m || !d || veto(c, d)) return null;
  const confirms = [c.timeframe, ...c.confirmation.filter(tf => tf !== c.timeframe && tf !== '4h')];
  const vetoBars = c.bars['4h'] ?? [];
  const vetoDir = dir(vetoBars);
  if (vetoDir && vetoDir !== d) { const a = atr(vetoBars.slice(-15), 14); const e = ema(vetoBars.map(b => Number(b.close)), 20).at(-1)!; if (a > 0 && Math.abs(Number(vetoBars.at(-1)!.close) - e) / a > p(c, 'veto_atr', 1)) return null; }
  const count = Math.round(p(c, 'confirm_tf_count', 2));
  if (confirms.length < count || !confirms.slice(0, count).every(tf => dir(c.bars[tf] ?? []) === d)) return null;
  if (Math.abs(m.close - (d === 'long' ? m.hi : m.lo)) / m.a > p(c, 'chase_atr_max', 1.5)) return null;
  return { ...setup(c, d, 0.8, 1.5, 'ohlcv', m)!, trigger_price: String(d === 'long' ? m.hi : m.lo) };
};
/** 状态更新与发信号分开；同一根重复调用不消费 armed。 */
export function nextSignalState(c: SignalContext): SignalState {
  const m = metrics(c); if (!m || m.last.close_time <= c.state.last_at) return { ...c.state };
  const widths: number[] = [];
  const closes = m.bars.map(b => Number(b.close));
  let sum = 0; let square = 0;
  for (let i = 0; i < closes.length; i++) {
    const x = closes[i]!; sum += x; square += x * x;
    if (i >= 20) { const old = closes[i - 20]!; sum -= old; square -= old * old; }
    if (i >= 19 && i >= closes.length - 91) { const mean = sum / 20; widths.push(Math.sqrt(Math.max(0, square / 20 - mean * mean)) / mean); }
  }
  const current = widths.pop()!;
  const rank = widths.filter(w => w < current).length / Math.max(1, widths.length) * 100;
  const compressed = rank <= p(c, 'bb_width_rank_max', 20);
  const n = compressed ? c.state.compression_bars + 1 : 0;
  const released = c.state.armed && breakout(c, m) !== null && m.vol >= p(c, 'vol_spike_min', 1.8);
  return { compression_bars: n, armed: released ? false : c.state.armed || n >= p(c, 'squeeze_bars_min', 6), last_at: m.last.close_time };
}
const volatility: SignalFn = c => {
  const m = metrics(c); const d = breakout(c, m);
  if (!m || !d || !c.state.armed || c.state.last_at >= m.last.close_time || m.vol < p(c, 'vol_spike_min', 1.8)) return null;
  if (Math.abs(m.close - (d === 'long' ? m.hi : m.lo)) / m.a > p(c, 'chase_atr_max', 1.5)) return null;
  const out = setup(c, d, 1, 2, 'ohlcv', m);
  if (out) out.trigger_price = String(d === 'long' ? m.hi : m.lo);
  if (out) out.invalidation = [`${p(c, 'revert_bars', 2)} 根内收回压缩区间且量比 < 1，或收盘回到中轨另一侧`];
  return out;
};
const derivatives: SignalFn = c => {
  const m = metrics(c); const f = c.derivatives?.funding; if (!m || !f || f.length < 20) return null;
  const nextFunding = (Math.floor(m.last.close_time / 28_800_000) + 1) * 28_800_000;
  if (nextFunding - m.last.close_time <= p(c, 'minutes_before_funding', 30) * 60000) return null;
  const current = Number(f.at(-1)!.rate); const history = f.slice(0, -1).map(x => Number(x.rate));
  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  const sd = Math.sqrt(history.reduce((a, b) => a + (b - mean) ** 2, 0) / history.length);
  if (!(sd > 0) || Math.abs(current - mean) / sd < p(c, 'funding_z_min', 2) || Math.abs(current) * 100 < p(c, 'funding_abs_min', 0.05)) return null;
  const d: Direction = current > 0 ? 'short' : 'long';
  if (dir(c.bars[c.confirmation[0] ?? '1h'] ?? []) !== d) return null;
  const oi = c.derivatives!.oi_change_pct;
  if (oi !== null && oi > -p(c, 'oi_change_min', 1)) return null;
  return setup(c, d, 1.2, 1.5, oi === null ? 'funding_only' : 'funding_oi', m);
};
const reversion: SignalFn = c => {
  const m = metrics(c); if (!m || c.regime !== 'range' || m.vol >= 1) return null;
  const long = Number(m.last.low) < m.lo && m.close >= m.lo && m.close - m.lo <= 0.3 * m.a;
  const short = Number(m.last.high) > m.hi && m.close <= m.hi && m.hi - m.close <= 0.3 * m.a;
  if (long === short) return null;
  const mid = ema(m.bars.map(b => Number(b.close)), 20).at(-1)!;
  const deviation = Math.abs(m.close - mid) / m.a;
  if (deviation < p(c, 'dev_atr_min', 0)) return null;
  const adxValue = adx(m.bars).at(-1)?.adx;
  if (c.params.adx_max && (!Number.isFinite(adxValue) || adxValue! > c.params.adx_max.value)) return null;
  if (c.params.min_reversion_prob) {
    const horizon = Math.round(p(c, 'horizon_bars', 12));
    const stats = reversionStats(m.bars, { tf: c.timeframe, horizons: [horizon] });
    const cell = stats?.cells.filter(x => x.k >= p(c, 'dev_atr_min', 2) && x.k <= deviation && x.horizon === horizon).sort((a, b) => b.k - a.k)[0];
    if (cell?.prob == null || cell.prob * 100 < c.params.min_reversion_prob.value) return null;
  }
  return setup(c, long ? 'long' : 'short', 1, 1.5, 'ohlcv', m);
};
export const SIGNAL_REGISTRY: Record<StrategyFamily, SignalFn> = { trend_continuation: trend, mtf, volatility, derivatives, mean_reversion: reversion, relative_value: () => null };
const INDICATORS = new Set(['scan_checklist', 'daily_regime', 'indicator_snapshot', 'funding_stats', 'reversion_stats']);
export function measurable(spec: StrategySpec): boolean { return spec.family !== 'relative_value' && !!SIGNAL_REGISTRY[spec.family] && spec.checklist.required.every(k => INDICATORS.has(k)); }

/** 日线聚合为 UTC 周一开盘周线，只接收完整七天且连续的周；不泄漏未完成周。 */
export function closedWeeks(days: Kline[], at: number): Kline[] {
  const day = 86400000; const week = 7 * day; const buckets = new Map<number, Kline[]>();
  for (const b of days) {
    if (b.close_time > at) continue;
    const start = Math.floor((b.open_time + 3 * day) / week) * week - 3 * day;
    const arr = buckets.get(start) ?? []; arr.push(b); buckets.set(start, arr);
  }
  return [...buckets].sort(([a], [b]) => a - b).flatMap(([start, raw]) => {
    const bs = [...raw].sort((a, b) => a.open_time - b.open_time);
    if (bs.length !== 7 || bs.some((b, i) => b.open_time !== start + i * day) || start + week - 1 > at) return [];
    return [{ open_time: start, close_time: start + week - 1, open: bs[0]!.open, close: bs[6]!.close, high: String(Math.max(...bs.map(b => Number(b.high)))), low: String(Math.min(...bs.map(b => Number(b.low)))), volume: String(bs.reduce((a, b) => a + Number(b.volume), 0)) }];
  });
}

// 双腿接口独立注册，单腿入口显式不产生信号。
export { PAIR_SIGNAL_REGISTRY, estimatePairModel, pairZ } from './pair-signals.js';
export type { PairSetup, PairSignalFn, PairSignalContext, PairModel } from './pair-signals.js';

// 研究注册表与生产族隔离，离线 runner 显式选择。
export { TRADER_SIGNAL_REGISTRY, TRADER_GRID, humanSignal, HUMAN_SIGNAL_REGISTRY } from './trader-signals.js';
