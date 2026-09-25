/** 运行器的研究适配:订单 IR 复用 orders 意图/方向/价位核;旧 IR 保持 irCandidate 口径。 */
import type { ResearchDataset, ResearchScreenRow } from '@trading-swarm/contracts';
import { candidateId, CANDIDATE_VERSION, generateCandidates, SYNTH_POLICY, toResearchBars, type GenerateInput, type StrategyCandidate } from './strategy-candidate.js';
import { passesUniverseScreen, timeframeMillis } from './research/strategy.js';
import { viewBars } from './research/engine.js';
import { orderIntents, resolveOrder } from './research/orders/intents.js';
import { firstLegMargin, fundedLeg } from './research/orders/shared.js';
import { volTargetOf, volTargetWeight, volLookbackBars, sizeNote } from './research/primitives/sizing.js';
import { q, decimal } from './research/primitives.js';
import type { StrategyIR } from '@trading-swarm/contracts';
import type { StrategyRun } from './strategy-run.js';
import { orderGateFor } from './research/order-gate.js';
import { screenUniverse } from './research/screen.js';
import { buildUniverse } from './research/universe.js';
import type { Kline } from './types.js';

export interface RunCandidate extends Omit<StrategyCandidate, 'direction' | 'entry_type'> {
  direction: 'long' | 'short'; entry_type: 'next_open_market' | 'limit';
  take_profits?: { price: number; size_pct: number }[];
  entry_expires_at?: number;
  size_weight?: number;
  size_note?: string;
}
export type RunGenerateInput = GenerateInput & { screen?: ResearchScreenRow };
export interface RunGenerateResult { candidate: RunCandidate | null; reason: string; as_of: number | null; view_bars: number }

export function generateRunCandidate(inp: RunGenerateInput): RunGenerateResult {
  const { shadow, symbol, now } = inp, ir = shadow.ir, ms = timeframeMillis(shadow.timeframe);
  const bars = toResearchBars(inp.klines[shadow.timeframe] ?? [], ms, now), w = viewBars(ir, SYNTH_POLICY, ms);
  const as_of = bars.length ? bars.at(-1)!.open_time + ms : null;
  const none = (reason: string): RunGenerateResult => ({ candidate: null, reason, as_of, view_bars: Math.min(w, bars.length) });
  if (!bars.length) return none('no_closed_bars');
  if (!passesUniverseScreen(ir, { screen: inp.screen })) return none('screen_filter');
  try {
    if (!ir.order) {
      // 旧候选不接 screen;在相同 ctx 上判筛选后移除该字段,其余几何仍走原函数。
      const out = generateCandidates({ ...inp, shadow: { ...shadow, ir: { ...ir, universe: undefined } } });
      const vt = volTargetOf(ir), sized = vt ? volTargetWeight(bars, bars.length - 1, ms, vt) : null;
      return { ...out, candidate: out.candidate && sized ? { ...out.candidate, size_weight: sized.weight, size_note: sizeNote(sized, vt!.target_vol) } : out.candidate };
    }
    const result = orderIntents(ir, bars, ms, { from_index: bars.length - 1, to_index: bars.length - 1, view: w, fee_rate: '0', slippage_bps: '0', gate: orderGateFor(ir) });
    const it = result.intents[0];
    if (!it) return none(result.notes.some(n => n.includes('同时触发')) ? 'direction_conflict:多空同时触发,本根不下单' : 'no_candidate');
    const entry = it.entry.type === 'limit' ? it.entry.price : it.reference_price, stop = it.stop?.price, dir = it.side === 'long' ? 1 : -1;
    if (!(entry && entry > 0 && Number.isFinite(entry))) return none('no_entry_price:信号根算不出限价,本根不下单');
    if (!(stop && stop > 0 && Number.isFinite(stop) && (entry - stop) * dir > 0)) return none('invalid_stop:止损不在正确一侧,请检查止损规则');
    const risk = Math.abs(entry - stop);
    if (it.min_stop_atr != null && it.atr != null && it.atr > 0 && risk < it.min_stop_atr * it.atr - 1e-12) return none('stop_too_close:止损距离小于研究核要求,本根不下单');
    // 与 simulateOrders.build 同顺序/比例归一化;未给比例时等分。错误方向明确留痕。
    const valid = it.take_profits.filter(t => Number.isFinite(t.price) && (t.price - entry) * dir > 0).sort((a, b) => (a.price - b.price) * dir);
    const sum = valid.reduce((a, t) => a + Math.max(0, t.size_pct), 0);
    const tps = valid.map(t => ({ price: t.price, size_pct: sum > 0 ? Math.max(0, t.size_pct) / sum : 1 / valid.length }));
    const rr = tps.length ? tps.reduce((a, t) => a + Math.abs(t.price - entry) * t.size_pct, 0) / risk : null;
    const target = tps[0]?.price ?? null;
    return { reason: it.reason, as_of, view_bars: Math.min(w, bars.length), candidate: {
      id: candidateId(shadow.strategy_id, shadow.version, symbol, as_of!), version_tag: CANDIDATE_VERSION, at: now, as_of: as_of!, symbol,
      timeframe: shadow.timeframe, strategy_id: shadow.strategy_id, version: shadow.version, ir_hash: shadow.ir_hash, ir_source: shadow.source,
      origin: inp.origin ?? 'online', direction: it.side, entry_type: it.entry.type === 'limit' ? 'limit' : 'next_open_market',
      entry_ref: entry, stop, target, target_source: null, take_profits: tps,
      ...(it.size_weight !== undefined ? { size_weight: it.size_weight, size_note: it.size_note } : {}),
      ...(it.entry.type === 'limit' ? { entry_expires_at: as_of! + it.expiry_bars * ms } : {}),
      rr, invalidation: stop, horizon_bars: shadow.horizon_bars, reason: `${shadow.label}:${it.reason}`,
      unmapped: [...result.notes, ...(valid.length !== it.take_profits.length ? ['研究核丢弃方向错误的止盈档位'] : [])],
      view_bars: Math.min(w, bars.length), status: 'open', model: null, settlement: null,
    } };
  } catch (e) { return none(`ir_error:${(e as Error).message}`); }
}

/** 波动率回看独立于信号视图；多取历史不能改变 EMA 等原语的决策窗口。 */
export function runHistoryBars(ir: StrategyIR, ms: number): number {
  const vt = volTargetOf(ir);
  return Math.max(viewBars(ir, SYNTH_POLICY, ms) + 2, vt ? volLookbackBars(ir.risk.sizing.params, ms) + 1 : 0);
}

/** runtime 在最终价位/账户快照确定后调用，再交原组合/风控闸；无权重返回 null，保留原 fixed_risk 路径。 */
export function sizeRunOrder(run: Pick<StrategyRun, 'market' | 'leverage'>, c: Pick<RunCandidate, 'size_weight'>, ir: StrategyIR, input: {
  equity: string; cash: string; price: string; fee_rate: string; step_size: string; leverage_cap: number;
  /** 加仓必须沿用首腿冻结额度，不能拿新信号的权重或新权益重算。 */
  base_leg_margin?: string;
}): { qty: string; margin: string; base_leg_margin: string; leverage: number; sizing_mode: 'vol_target' } | null {
  if (c.size_weight === undefined && input.base_leg_margin === undefined) return null;
  const weight = c.size_weight ?? 1, price = Number(input.price), fee = Number(input.fee_rate), equity = Number(input.equity), cash = Number(input.cash);
  const leverage = run.market === 'spot' ? 1 : Math.min(run.leverage, input.leverage_cap);
  if (!(weight > 0 && weight <= 1 && price > 0 && equity >= 0 && cash >= 0 && fee >= 0 && fee < 1 && leverage >= 1) || ![weight, price, fee, equity, cash, leverage].every(Number.isFinite) || !(Number(input.step_size) > 0)) throw new Error('invalid_run_sizing');
  const order = resolveOrder(ir, 1), adds = order?.on_new_signal.filled === 'add' ? order.max_adds : 0;
  const base = input.base_leg_margin === undefined ? firstLegMargin(equity, 1, adds, weight) : Number(input.base_leg_margin);
  if (!(base > 0) || !Number.isFinite(base)) throw new Error('invalid_base_leg_margin');
  const leg = fundedLeg(base, cash, leverage, fee, price), step = q(input.step_size);
  if (step <= 0n) throw new Error('invalid_run_step_size');
  // 研究核内部 number；边界量化为十进制字符串，交易步长向下对齐。
  const qty = decimal(BigInt(Math.floor(leg.qty * 1e8)) / step * step);
  return { qty, margin: (Number(qty) * price / leverage).toFixed(8), base_leg_margin: base.toFixed(8), leverage, sizing_mode: 'vol_target' };
}

/** 研究 portfolio 每根用 screenUniverse 产生 ctx.screen;运行币池等权作为市场因子。 */
export function runScreenRows(pool: Map<string, Kline[]>, ms: number, as_of: number, market: 'spot' | 'perp'): ResearchScreenRow[] {
  const datasets: ResearchDataset[] = [...pool].map(([symbol, ks]) => ({ symbol, venue: 'strategy_run', market, timeframe_ms: ms, source: 'runtime', retrieved_at: as_of, bars: toResearchBars(ks, ms, as_of) }));
  if (!datasets.length) return [];
  if (datasets.some(d => d.bars.length < 3)) return [];
  const times = datasets.map(d => new Set(d.bars.map(b => b.close_time)));
  const common = [...times[0]!].filter(t => times.every(set => set.has(t)));
  if (common.length < 3) return [];
  const symbols = datasets.map(d => d.symbol);
  const universe = buildUniverse({ symbols, timeframe: ['15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'].find(tf => timeframeMillis(tf) === ms)!, from_ms: Math.min(...datasets.map(d => d.bars[0]!.open_time)), to_ms: as_of - 1, market_factor: { kind: 'equal_weight_universe', symbols } } as Parameters<typeof buildUniverse>[0], datasets.map(data => ({ id: `run:${data.symbol}:${as_of}`, data })));
  return screenUniverse(universe, datasets, { as_of: as_of - 1 }).rows;
}
