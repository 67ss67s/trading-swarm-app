/** StrategyIR.order → 每根的入场计划意图 + 持仓管理回调(WP-F,2026-09-23)。
 * 规则:
 *  - 新信号 = 条件(regime ∧ signal)由假变真的那一根(上升沿)。状态型条件(RSI>50)连着成立只算一次,否则每根都会触发 replace/roll。
 *  - direction:long 用 signal+regime;short 用同一 signal+regime 当做空条件(按原文在真实 K 线上判定);both 时 short_signal(+short_regime)做空。
 *    同一根多空同时触发 → 两边都不下(冲突,计入 notes)。
 *  - 价位按角色取(primitives/levels.ts):入场=level、止损=stop、止盈=target。做空时,只含加减与比较的结构/ATR 原语
 *    (atr_stop / swing_low_stop / order_blocks / htf_structure / structure_target)在镜像 K 线(价格取负、高低互换)上计算再取负,
 *    多空对称由构造保证;指标类原语(indicator_level 等)在真实 K 线上按 ctx.side 取值,绝不镜像(RSI 之类镜像后语义会变)。
 *  - 缺省:入场=市价;止损=risk.stop;止盈=exit 里的 fixed_r_target(最小 r)或 structure_target(同 irCandidate 优先级),都没有则 1d 结构阻力;
 *    min_rr=order.min_rr(用户硬约束)否则 gate.min_rr;时效按周期 24/48/72h;周期上限=order.max_holding_bars 否则 time_stop。
 *  - 限价单上,以收盘价为锚的相对价位(atr_stop / atr_offset_level 的 N×ATR、pct_offset_level)改锚到挂单价;结构位与指标线是绝对价位不动。
 *  - 止损不窄于成本下限(order-gate stopFloorPct,stop_floor=widen 时放宽,note 标 cost_floor);fixed_r 止盈按放宽后的止损重算。
 * 结构口径(gate.min_stop_atr,2026-09-23 起新 run 缺省,见 order-gate.ts 文件头)下改为:
 *  - 缺省止盈 = IR 自己的价位来源(fixed_r_target / structure_target / pivot_target),都没有时 pivot_target(图上最近未被扫的摆动高点);
 *    用户给了信号离场(死叉离场等)就不补止盈;所有来源在这一根都算不出价位 → 不设止盈,不按 R 倍数补(持仓交给 IR 里的追踪止损);
 *  - min_rr 只认 order.min_rr(用户原话硬约束),gate 的 min_rr 不再作为门槛;
 *  - 不放宽止损;止损离参考价不到 min_stop_atr×ATR(14,信号根 Wilder)→ 执行核判 stop_too_close 不下单(意图里带 atr/min_stop_atr)。
 */
import type { ResearchBar, StrategyIR, StrategyPrimitive, OrderLevelSource, OrderGateParams, StrategyOrder } from '@trading-swarm/contracts';
import { registry } from '../primitives/index.js';
import type { PrimitiveContext, PrimitiveValue } from '../primitives/registry.js';
import { stopFloorPct, isStructureGate } from '../order-gate.js';
import { hasSignalExit } from '../strategy-spec.js';
import { atrSeries } from '../primitives/indicators.js';
import { volTargetOf, volTargetWeight, sizeNote } from '../primitives/sizing.js';
import { defaultExpiryBars } from './fills.js';
import { drainSync, drainAsync } from './drain.js';
import type { PlanIntent, Side, Manager, IntentLevel, IntentTakeProfit, NewSignalPolicy } from './types.js';
export const WINDOW = 5000;
const MIRROR_LEVEL = new Set(['atr_stop', 'swing_low_stop', 'order_blocks', 'htf_structure', 'structure_target']);
const MIRROR_EXIT = new Set(['chandelier_trail', 'swing_structure_stop', 'trend_break', 'macd_divergence_exit', 'double_top_exit', 'bearish_engulfing_exit']);
const TARGET_ONLY = new Set(['fixed_r_target', 'structure_target', 'pivot_target']);
/** 方向门里只含比较的结构原语(BOS 向上/位置分位):direction=short 时在镜像 K 线上判(= 高周期 BOS 向下),否则做空只会在多头结构里触发。
 * trend_state 用 EMA 比值算斜率,镜像后符号不翻,不在此列(做空时照原文判,notes 里提示)。 */
const MIRROR_REGIME = new Set(['htf_structure_regime']);
/** 自带方向参数的方向门(htf_ma_state side=above/below):做空时照参数判,不镜像,提示里不写「偏多」 */
const SIDED_REGIME = new Set(['htf_ma_state']);
export interface ResolvedOrder {
  direction: 'long' | 'short' | 'both'; market: 'spot' | 'perp'; leverage: number;
  entry: { type: 'market' | 'limit'; price: StrategyPrimitive | null; expiry_bars: number };
  take_profits: { source: StrategyPrimitive; size_pct: number }[];
  min_rr: number | null; on_new_signal: NewSignalPolicy; max_adds: number; max_holding_bars: number | null; breakeven_after_tp: boolean;
  short_signal: StrategyPrimitive[] | null; short_regime: StrategyPrimitive | null;
}
/** 缺省止盈:与 irCandidate 同优先级——fixed_r_target(最小 r)> structure_target > 1d 结构阻力(旧口径)。
 * 结构口径(structure=true):fixed_r_target > structure_target > pivot_target(IR 里有的)> 信号离场型策略不补 > pivot_target 缺省。 */
export function defaultTakeProfits(ir: StrategyIR, timeframe_ms: number, structure = false): { source: StrategyPrimitive; size_pct: number }[] {
  if (structure) {
    const fixedS = ir.exit.filter((x) => x.primitive === 'fixed_r_target').sort((a, b) => Number(a.params.r) - Number(b.params.r))[0];
    const own = fixedS ?? ir.exit.find((x) => x.primitive === 'structure_target') ?? ir.exit.find((x) => x.primitive === 'pivot_target');
    if (own) return [{ source: { primitive: own.primitive, params: { ...own.params } }, size_pct: 1 }];
    return hasSignalExit(ir.exit) ? [] : [{ source: { primitive: 'pivot_target', params: { swing_length: 3 } }, size_pct: 1 }];
  }
  const fixed = ir.exit.filter((x) => x.primitive === 'fixed_r_target').sort((a, b) => Number(a.params.r) - Number(b.params.r))[0], structural = ir.exit.find((x) => x.primitive === 'structure_target');
  const source = fixed ?? structural ?? { primitive: 'structure_target', params: { swing_length: 3, htf: timeframe_ms >= 86400000 ? `${timeframe_ms / 86400000}d` : '1d' } };
  return [{ source: { primitive: source.primitive, params: { ...source.params } }, size_pct: 1 }];
}
export function resolveOrder(ir: StrategyIR, timeframe_ms: number, gate?: (Pick<OrderGateParams, 'min_rr'> & Partial<OrderGateParams>) | null): ResolvedOrder | null {
  const o: StrategyOrder | undefined = ir.order; if (!o) return null;
  const structure = isStructureGate(gate as OrderGateParams | null | undefined);
  const times = ir.exit.filter((x) => x.primitive === 'time_stop').map((x) => Number(x.params.bars)).filter((x) => x > 0);
  return {
    direction: o.direction, market: o.market, leverage: o.market === 'perp' ? o.leverage ?? 1 : 1,
    entry: { type: o.entry?.type ?? 'market', price: o.entry?.price ?? null, expiry_bars: o.entry?.expiry_bars ?? defaultExpiryBars(timeframe_ms) },
    take_profits: o.take_profits?.length ? o.take_profits.map((t) => ({ source: t.source, size_pct: t.size_pct ?? 0 })) : defaultTakeProfits(ir, timeframe_ms, structure),
    // 结构口径:盈亏比只在用户原话硬约束(order.min_rr>0)时才是门槛
    min_rr: structure ? (o.min_rr !== undefined && o.min_rr > 0 ? o.min_rr : null) : o.min_rr ?? gate?.min_rr ?? null,
    on_new_signal: { unfilled: o.on_new_signal?.unfilled ?? 'replace', filled: o.on_new_signal?.filled ?? 'roll' },
    max_adds: o.max_adds ?? 2, max_holding_bars: o.max_holding_bars ?? (times.length ? Math.min(...times) : null), breakeven_after_tp: o.breakeven_after_tp ?? false,
    short_signal: o.short_signal ?? null, short_regime: o.short_regime ?? null,
  };
}
/** 镜像 K 线:价格取负、高低互换。只对只含加减与比较的原语成立(见文件头)。 */
export const mirrorBars = (bars: ResearchBar[]): ResearchBar[] => bars.map((b) => ({ ...b, open: String(-Number(b.open)), high: String(-Number(b.low)), low: String(-Number(b.high)), close: String(-Number(b.close)) }));
const neg = (v: PrimitiveValue): PrimitiveValue => ({ ...v, ...(v.stop !== undefined ? { stop: -v.stop } : {}), ...(v.target !== undefined ? { target: -v.target } : {}), ...(v.level !== undefined ? { level: -v.level } : {}) });
type Role = 'entry' | 'stop' | 'tp';
export function levelSource(primitive: string, role: Role, side: Side): OrderLevelSource {
  if (['structure_level', 'htf_structure', 'order_blocks', 'swing_low_stop', 'structure_target', 'smc_ob_level', 'smc_liquidity_target', 'pivot_stop', 'pivot_target'].includes(primitive)) { const own = side === 'long' ? 'structure_support' : 'structure_resistance', other = side === 'long' ? 'structure_resistance' : 'structure_support'; return role === 'tp' ? other : own; }
  if (primitive === 'fixed_r_target') return 'rr';
  if (primitive === 'atr_stop' || primitive === 'atr_offset_level') return 'atr';
  if (primitive === 'indicator_level') return 'indicator';
  if (primitive === 'pct_offset_level') return 'fixed_pct';
  return 'user';
}
const noteOf = (x: StrategyPrimitive) => { const p = x.params as Record<string, unknown>; if (x.primitive === 'indicator_level') return `${String(p.indicator).toUpperCase()}${p.args ? `(${Object.values(p.args as object).join(',')})` : ''}${p.output ? `.${String(p.output)}` : ''}${Number(p.buffer_atr ?? 0) > 0 ? ` ±${String(p.buffer_atr)}ATR` : ''}`; return `${x.primitive}${Object.keys(p).length ? `(${Object.entries(p).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(',')})` : ''}`; };
/** view = 每根决策可见的最近根数(缺省 WINDOW=5000;全窗口回测传 engine v4 同口径的 viewBars,6×预热夹在 500–5000) */
export interface IntentContext { bars: ResearchBar[]; mirrored: ResearchBar[] | null; timeframe_ms: number; fee_rate?: number; view?: number }
const sliceCtx = (c: IntentContext, i: number, side: Side, mirrored = false): PrimitiveContext => { const src = mirrored ? c.mirrored! : c.bars, s = Math.max(0, i - (c.view ?? WINDOW) + 1), bars = src.slice(s, i + 1); return { bars, i: bars.length - 1, timeframe_ms: c.timeframe_ms, side, ...(c.fee_rate !== undefined ? { fee_rate: c.fee_rate } : {}), series: src, series_i: i }; };
/** 按角色取一个价位原语的价;做空的镜像安全原语在镜像 K 线上算。 */
export function evalLevel(node: StrategyPrimitive, role: Role, side: Side, c: IntentContext, i: number): number | null {
  const prim = registry.get(node.primitive); if (!prim) return null;
  const mirror = side === 'short' && MIRROR_LEVEL.has(node.primitive);
  let v: PrimitiveValue;
  try { v = mirror ? neg(prim.compute(sliceCtx(c, i, 'long', true), node.params)) : prim.compute(sliceCtx(c, i, side), node.params); } catch { return null; }
  const x = role === 'entry' ? v.level : role === 'stop' ? v.stop : v.target ?? v.level;
  return x !== undefined && Number.isFinite(x) && x > 0 ? x : null;
}
/** 以收盘价为锚的相对价位(N×ATR、固定比例)在限价单上改锚到挂单价:「ATR 止损」指入场价 −N×ATR,不是信号收盘价 −N×ATR。
 * 结构位、指标线是绝对价位,不改锚。市价单 ref=close,恒等。 */
const ADDITIVE = new Set(['atr_stop', 'atr_offset_level']), MULTIPLICATIVE = new Set(['pct_offset_level']);
function reanchor(primitive: string, price: number, close: number, ref: number): number { return ADDITIVE.has(primitive) ? price + (ref - close) : MULTIPLICATIVE.has(primitive) ? price * ref / close : price; }
const passes = (nodes: StrategyPrimitive[], ctx: PrimitiveContext) => nodes.every((x) => { const p = registry.get(x.primitive); return !!p && !!p.compute(ctx, x.params).pass; });
/** memo:同一资产同一份 IR 的逐根结果(条件是否成立、该根的计划意图)只依赖 ≤i 的 K 线,篮子腿复用单资产的记忆(同 engine v4 SignalCache) */
export interface OrderIntentOptions { fee_rate: string; slippage_bps: string; gate?: OrderGateParams | null; from_index?: number; to_index?: number; view?: number; memo?: Map<string, unknown> }
/** 返回与 bars[from..to] 对齐的意图数组(第 j 个 = bars[from+j] 收盘时的意图)。 */
export function orderIntents(ir: StrategyIR, bars: ResearchBar[], timeframe_ms: number, opts: OrderIntentOptions): IntentsResult { return drainSync(intentSteps(ir, bars, timeframe_ms, opts)); }
export function orderIntentsAsync(ir: StrategyIR, bars: ResearchBar[], timeframe_ms: number, opts: OrderIntentOptions, check?: () => void): Promise<IntentsResult> { return drainAsync(intentSteps(ir, bars, timeframe_ms, opts), check); }
export interface IntentsResult { order: ResolvedOrder; intents: (PlanIntent | null)[]; notes: string[] }
/** 逐根 yield 的意图计算本体(见 drain.ts)。 */
export function* intentSteps(ir: StrategyIR, bars: ResearchBar[], timeframe_ms: number, opts: OrderIntentOptions): Generator<void, IntentsResult, void> {
  const order = resolveOrder(ir, timeframe_ms, opts.gate); if (!order) throw new Error('strategy_has_no_order_block');
  const from = opts.from_index ?? 0, to = opts.to_index ?? bars.length - 1, notes: string[] = [];
  const needShort = order.direction !== 'long', c: IntentContext = { bars, mirrored: needShort ? mirrorBars(bars) : null, timeframe_ms, fee_rate: Number(opts.fee_rate), ...(opts.view ? { view: opts.view } : {}) }, memo = opts.memo;
  const floor = opts.gate ? stopFloorPct({ fee_rate: opts.fee_rate, slippage_bps: opts.slippage_bps }, opts.gate) : 0, widen = !!opts.gate && (opts.gate.stop_floor ?? 'widen') === 'widen';
  const minStopAtr = isStructureGate(opts.gate) ? opts.gate.min_stop_atr : null, vt = volTargetOf(ir);
  const longNodes = order.direction === 'short' ? null : { signal: ir.signal, regime: ir.regime ?? null };
  const shortNodes = order.direction === 'long' ? null : order.direction === 'short' ? { signal: ir.signal, regime: ir.regime ?? null } : { signal: order.short_signal ?? [], regime: order.short_regime };
  if (order.direction === 'both' && !order.short_signal?.length) notes.push('direction=both 但没有 short_signal,做空一侧不会触发');
  const mirrorRegime = order.direction === 'short' && !!ir.regime && MIRROR_REGIME.has(ir.regime.primitive);
  if (order.direction === 'short' && ir.regime && !mirrorRegime) notes.push(SIDED_REGIME.has(ir.regime.primitive) ? `做空策略的方向门 ${ir.regime.primitive} 按参数 side=${String(ir.regime.params.side ?? 'above')} 判定` : `做空策略的方向门 ${ir.regime.primitive} 按原文(偏多)判定,不做镜像`);
  if (mirrorRegime) notes.push(`做空:方向门 ${ir.regime!.primitive} 在镜像 K 线上判定(高周期结构向下才放行)`);
  const on0 = (nodes: { signal: StrategyPrimitive[]; regime: StrategyPrimitive | null } | null, i: number) => { if (!nodes || !nodes.signal.length || i < 0) return false; const ctx = sliceCtx(c, i, 'long'); try { if (nodes.regime && !registry.get(nodes.regime.primitive)?.compute(nodes === shortNodes && mirrorRegime ? sliceCtx(c, i, 'long', true) : ctx, nodes.regime.params).pass) return false; return passes(nodes.signal, ctx); } catch { return false; } };
  const on = (nodes: Parameters<typeof on0>[0], i: number) => { if (!memo || !nodes) return on0(nodes, i); const k = `o${nodes === longNodes ? 'L' : 'S'}${i}`, hit = memo.get(k); if (hit !== undefined) return hit as boolean; const v = on0(nodes, i); memo.set(k, v); return v; };
  let prevL = on(longNodes, from - 1), prevS = on(shortNodes, from - 1), conflicts = 0;
  const intents: (PlanIntent | null)[] = [];
  for (let i = from; i <= to; i++) {
    const L = on(longNodes, i), S = on(shortNodes, i), edgeL = L && !prevL, edgeS = S && !prevS; prevL = L; prevS = S;
    if (edgeL && edgeS) { conflicts++; intents.push(null); continue; }
    intents.push(edgeL ? built('long', i) : edgeS ? built('short', i) : null);
    yield;
  }
  if (conflicts) notes.push(`${conflicts} 根多空同时触发,按冲突不下单`);
  return { order, intents, notes };
  function built(side: Side, i: number): PlanIntent { if (!memo) return build(side, i); const k = `b${side}${i}`, hit = memo.get(k) as PlanIntent | undefined; if (hit) return hit; const v = build(side, i); memo.set(k, v); return v; }
  function build(side: Side, i: number): PlanIntent {
    const close = Number(bars[i]!.close), dir = side === 'long' ? 1 : -1;
    const limit = order!.entry.type === 'limit', entryPx = limit && order!.entry.price ? evalLevel(order!.entry.price, 'entry', side, c, i) : null, ref = limit ? entryPx : close;
    let stop: IntentLevel | null = null; const sp0 = evalLevel(ir.risk.stop, 'stop', side, c, i), sp = sp0 !== null && ref ? reanchor(ir.risk.stop.primitive, sp0, close, ref) : sp0;
    if (sp !== null) stop = { price: sp, source: levelSource(ir.risk.stop.primitive, 'stop', side), note: noteOf(ir.risk.stop) + (sp !== sp0 ? ';按限价重锚' : '') };
    if (stop && ref && widen && floor > 0 && (ref - stop.price) * dir > 0 && Math.abs(ref - stop.price) / ref < floor) stop = { ...stop, price: ref - dir * floor * ref, note: `${stop.note};cost_floor 放宽到 ${(floor * 100).toFixed(2)}%` };
    const tps: IntentTakeProfit[] = [];
    for (const t of order!.take_profits) {
      let px: number | null = null;
      if (t.source.primitive === 'fixed_r_target') { const r = Number(t.source.params.r); px = stop && ref && r > 0 ? ref + dir * r * Math.abs(ref - stop.price) : null; }
      else { const px0 = evalLevel(t.source, 'tp', side, c, i); px = px0 !== null && ref ? reanchor(t.source.primitive, px0, close, ref) : px0; }
      if (px !== null) tps.push({ price: px, size_pct: t.size_pct, source: levelSource(t.source.primitive, 'tp', side), note: noteOf(t.source) });
    }
    // 所有止盈来源在这一根都算不出价位(结构上没有目标位)时,与 order-gate / engine v4 同口径:按 target_fallback_r × 止损距离补一档,note 标 fallback_r;gate 没给兜底倍数才让执行核判 no_target
    const fb = opts.gate?.target_fallback_r ?? 0;
    if (!tps.length && fb > 0 && stop && ref && (ref - stop.price) * dir > 0) tps.push({ price: ref + dir * fb * Math.abs(ref - stop.price), size_pct: 1, source: 'rr', note: `fallback_r ${fb}R(止盈来源在此处算不出价位,按止损距离补)` });
    const nodes = side === 'long' ? longNodes! : shortNodes!;
    // 结构口径:信号根的 ATR(14,Wilder,同几何实验室)随意图交给执行核判 stop_too_close
    const atr = minStopAtr !== null ? atrSeries(sliceCtx(c, i, 'long').bars, 14).at(-1) ?? null : null;
    // 波动率目标仓位:σ 用信号根(含)及以前的已收盘 K 线(整段 bars 按下标取,不受决策视图截断),执行核在首腿按 w 缩放保证金
    const sized = vt ? volTargetWeight(bars, i, timeframe_ms, vt) : null;
    return { ...(sized ? { size_weight: sized.weight, size_note: sizeNote(sized, vt!.target_vol) } : {}), ...(minStopAtr !== null ? { atr: atr !== null && Number.isFinite(atr) ? atr : null, min_stop_atr: minStopAtr } : {}), side, reason: `${side === 'long' ? '做多' : '做空'}:${nodes.signal.map((x) => x.primitive).join('+')}${nodes.regime ? ` | ${nodes.regime.primitive}` : ''}`, entry: { type: order!.entry.type, price: limit ? entryPx : null, source: limit && order!.entry.price ? levelSource(order!.entry.price.primitive, 'entry', side) : null, note: limit && order!.entry.price ? noteOf(order!.entry.price) : '' }, reference_price: close, expiry_bars: order!.entry.expiry_bars, stop, take_profits: tps, min_rr: order!.min_rr };
  }
}
/** 持仓管理:按 ir.exit 的走势跟踪出场算移动止损与信号离场(止盈类与 time_stop 在执行核里处理,这里跳过)。
 * offset = bars 里第 0 根在 simulateOrders 输入里的下标偏移(simulateOrders 的 bar_index + offset = 这里的下标)。 */
export function orderManager(ir: StrategyIR, bars: ResearchBar[], timeframe_ms: number, opts: { fee_rate: string; offset?: number; view?: number }): Manager {
  const needShort = ir.order?.direction !== 'long', c: IntentContext = { bars, mirrored: null, timeframe_ms, fee_rate: Number(opts.fee_rate), ...(opts.view ? { view: opts.view } : {}) };
  const fee = Number(opts.fee_rate), exits = ir.exit.filter((x) => !TARGET_ONLY.has(x.primitive) && x.primitive !== 'time_stop');
  return (v) => {
    const i = v.bar_index + (opts.offset ?? 0); if (i < 0 || i >= bars.length || !exits.length) return null;
    if (v.side === 'short' && needShort && !c.mirrored) c.mirrored = mirrorBars(bars);
    let stop: number | undefined, source: 'trail' | 'breakeven' | 'structure' | undefined, exit: string | null = null;
    const take = (s: number | undefined, src: 'trail' | 'breakeven' | 'structure') => { if (s === undefined || !Number.isFinite(s) || s <= 0) return; if (stop === undefined || (v.side === 'long' ? s > stop : s < stop)) { stop = s; source = src; } };
    for (const x of exits) {
      const prim = registry.get(x.primitive); if (!prim) continue;
      const src = x.primitive === 'breakeven_after_r' ? 'breakeven' : x.primitive === 'swing_structure_stop' ? 'structure' : 'trail';
      try {
        if (v.side === 'short' && x.primitive === 'breakeven_after_r') {
          const r = Number(x.params.r), low = Math.min(...bars.slice(Math.max(0, i - (c.view ?? WINDOW) + 1), i + 1).filter((b) => b.open_time >= v.entry_at).map((b) => Number(b.low)));
          if (v.initial_distance > 0 && low <= v.avg_entry - r * v.initial_distance) take(v.avg_entry * (1 - fee) / (1 + fee), 'breakeven');
          continue;
        }
        const mirrored = v.side === 'short' && MIRROR_EXIT.has(x.primitive), base = sliceCtx(c, i, mirrored ? 'long' : v.side, mirrored);
        const ctx: PrimitiveContext = { ...base, position: { entry_at: v.entry_at, entry_price: mirrored ? -v.avg_entry : v.avg_entry, initial_distance: v.initial_distance, bars_held: v.bars_held, high_water: mirrored ? -v.low_water : v.high_water } };
        const out = prim.compute(ctx, x.params); if (out.exit) exit ??= x.primitive;
        if (out.stop !== undefined) take(mirrored ? -out.stop : out.stop, src);
      } catch { /* 原语在预热不足时抛错 = 本根不给更新 */ }
    }
    return { ...(stop !== undefined ? { stop, stop_source: source } : {}), exit };
  };
}
/** 订单块里与执行核相关的参数(杠杆/市场/新信号策略/周期上限/保本)。 */
export function orderExecOverrides(o: ResolvedOrder): { market: 'spot' | 'perp'; leverage: number; on_new_signal: NewSignalPolicy; max_adds: number; max_holding_bars: number | null; breakeven_after_tp: boolean } {
  return { market: o.market, leverage: o.leverage, on_new_signal: o.on_new_signal, max_adds: o.max_adds, max_holding_bars: o.max_holding_bars, breakeven_after_tp: o.breakeven_after_tp };
}
