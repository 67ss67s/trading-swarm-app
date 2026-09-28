/** 订单周期执行核(WP-F,2026-09-23):把「每根 K 线收盘产生的入场计划意图」在历史 K 线上逐单模拟成
 * placed → filled/no_fill/replaced/cancelled/blocked → 止损/多档止盈/移动止损/信号离场/时间/结转/加仓/反手/强平 的完整周期。
 * 纯函数(同 8794 shadow.rs):不碰 DB/网络,K 线、意图、资金费、分档都由调用方喂。语义逐条对照 shadow.rs v11:
 *  - 成交规则见 fills.ts(v9 跳空按 open + 钳制);同根 SL/TP → SL 先(保守);多档 TP 按 size_pct 阶梯,最后一档吃余量(v6);
 *  - 市价 = 信号下一根 open;限价在时效窗口(8794 24/48/72h 分档)内触价才成交,否则 no_fill;
 *  - 未成交前同向新计划整体替换(v8 replace,可配 keep);已成交后同向新计划:roll(v7 结转,旧计划在下一根 open 以 rolled 记账、
 *    新计划的止损止盈接管同一仓位)/ add(v8 等权加仓腿,均价)/ ignore;反向新计划:未成交撤单、已成交在下一根 open 反手(flipped);
 *  - 首档 TP 后可选保本(8794 breakeven remainder 口径:止损移到入场均价,只收紧);
 *  - MFE/MAE:v11,成交根到出场根逐根恰好计一次(出场根整根计入,含 open 出场),锚定最终均价,不含杠杆。
 * 与 8794 的有意差异(都更保守或更贴近真实账户):
 *  - 盘中触价成交的限价入场根不判止盈(那根的高点可能早于成交),止损照判;8794 两者都判。
 *  - 同一根 open 上既有挂着的止损/止盈跳空又有结转/反手时,先结算挂着的保护单(成交价同为 open,只影响原因标注与费率),8794 先 roll。
 *  - 有手续费/滑点/资金费/杠杆/强平与净值:8794 L1 是固定 100 名义值的无费口径,这里 pnl_pct 是净收益/保证金,另给 price_move_pct 对齐 8794。
 *  - 加仓腿有自己的时效(与主入场同一 expiry),8794 的加仓腿无时效;每腿等权占首腿额度的 1/(max_adds+1),保证加满也不超配。
 *  - rolled 为统计每个计划的盈亏按下一根 open 记账,但结转不收手续费、不加滑点;新计划以结转价为成本、保证金按结转价重算(强平价随之重算)。
 * 资金费:K 线粒度近似——整点在某根开盘时刻的期,归开盘前已持有的仓位;落在某根内部的期,归该根开盘后仍持有、且不是当根盘中才成交的仓位;
 * 按当根 open 计名义值;多付空收(rate>0)。没有序列 → funding_status=missing、funding_pct=null,不当 0。资金费走现金,不移动强平价。
 * 强平:逐仓,强平价 = 均价×(1∓1/杠杆±mmr);按标记价 K 线判定(缺失退回成交价并记 flag);与止损同根时离开盘价更近者先;强平损失整份剩余保证金(差额记进 fees)。
 */
import type { BacktestPlan, BacktestPlanEvent, BacktestPlanLevel, BacktestPlanStats, BacktestTrade, BacktestEquityPoint, OrderExitReason, BacktestPlanEventKind } from '@trade-gate/contracts';
import { entryLimitFill, stopFill, takeProfitFill, liquidationPrice, clampToBar } from './fills.js';
import type { OrderBar, PlanIntent, OrderExecParams, OrderSimResult, Manager, Side, MmrTier, NewSignalPolicy } from './types.js';
import { planStats } from './stats.js';
import { firstLegMargin, fundedLeg, tighterStop, newSignalAction } from './shared.js';
import { drainSync, drainAsync } from './drain.js';
import { ExecutionTally, executionCheck } from '../execution-gate.js';
import { blendedTarget } from '../../execution-policy.js';
export const ORDERS_ENGINE_VERSION = 'research-orders-v1';
/** 结构口径(2026-09-23):不按盈亏比拦单、止损太近(<k×ATR)不做、不按 R 补止盈;统计带 blocked_by */
export const ORDERS_ENGINE_VERSION_V2 = 'research-orders-v2';
const EPS = 1e-12, MAX_EVENTS = 500;
type StopSource = 'initial' | 'trail' | 'breakeven' | 'structure';
interface Tp { level: BacktestPlanLevel; weight: number; filled: boolean }
interface PendingAdd { intent: PlanIntent; signal_index: number; expiry_index: number }
interface Live {
  plan: BacktestPlan; intent: PlanIntent; side: Side; dir: 1 | -1;
  signal_index: number; expiry_index: number;
  filled: boolean; fill_index: number; intrabar_fill_index: number;
  qty: number; qty_total: number; avg: number; first_qty: number;
  margin_open: number; margin_total: number; base_leg_margin: number;
  gross: number; fees: number; funding: number; funding_periods: number; funding_seen: boolean;
  exit_value: number; exit_qty: number;
  stop: number | null; stop_source: StopSource; initial_stop: number | null; pending_breakeven: boolean;
  tps: Tp[]; tp_hit: boolean;
  hi: number; lo: number;
  scheduled: OrderExitReason | null;
  adds: PendingAdd[];
}
const r8 = (x: number) => Math.round(x * 1e8) / 1e8;
function mmrOf(m: OrderExecParams['maintenance_margin'], qty: number): number {
  if (m === undefined) return 0.004;
  if (typeof m === 'number') return m;
  const tiers = [...m].sort((a: MmrTier, b: MmrTier) => a.max_qty - b.max_qty);
  return (tiers.find((t) => qty <= t.max_qty) ?? tiers.at(-1))?.mmr ?? 0.004;
}
/** 同步入口(测试/小窗口);全窗口回测用 simulateOrdersAsync,按时间让出事件循环。 */
export function simulateOrders(bars: OrderBar[], intents: (PlanIntent | null)[], params: OrderExecParams, manage?: Manager): OrderSimResult { return drainSync(simulateSteps(bars, intents, params, manage)); }
/** 异步入口:与 simulateOrders 逐字同一结果,每 20ms 至少让出一次事件循环(研究回测与交易同进程)。 */
export function simulateOrdersAsync(bars: OrderBar[], intents: (PlanIntent | null)[], params: OrderExecParams, manage?: Manager, check?: () => void): Promise<OrderSimResult> { return drainAsync(simulateSteps(bars, intents, params, manage), check); }
/** 逐根推进的执行核本体:每根 K 线结束 yield 一次,由 drainSync / drainAsync 驱动。 */
export function* simulateSteps(bars: OrderBar[], intents: (PlanIntent | null)[], params: OrderExecParams, manage?: Manager): Generator<void, OrderSimResult, void> {
  const perp = params.market === 'perp', lev = perp ? params.leverage : 1;
  if (!perp && params.leverage !== 1) throw new Error('spot_leverage_forbidden');
  if (!(lev >= 1) || !Number.isFinite(lev)) throw new Error('invalid_leverage');
  if (intents.length !== bars.length) throw new Error('intents_bars_misaligned');
  if (params.mark && params.mark.length !== bars.length) throw new Error('mark_bars_misaligned');
  const taker = params.taker_fee_rate ?? (perp ? 0.0005 : 0.001), maker = params.maker_fee_rate ?? (perp ? 0.0002 : taker), slip = (params.slippage_bps ?? 0) / 10000;
  const policy: NewSignalPolicy = { unfilled: params.on_new_signal?.unfilled ?? 'replace', filled: params.on_new_signal?.filled ?? 'roll' };
  const maxAdds = policy.filled === 'add' ? Math.max(0, Math.floor(params.max_adds ?? 2)) : 0, mf = params.margin_fraction ?? 1, prefix = params.id_prefix ?? 'plan_';
  const segment = params.segment_of ?? (() => 'in_sample' as const), maxBlocked = params.max_blocked_rows ?? 2000;
  const funding = perp ? params.funding ?? null : null, fpoints = funding ? [...funding.points].sort((a, b) => a.ts - b.ts) : [];
  const plans: BacktestPlan[] = [], trades: BacktestTrade[] = [], equity: BacktestEquityPoint[] = [], flags = new Set<string>();
  const counters = { ignored: 0, blocked: 0, added: 0, spot_short: 0, blocked_by: {} as Record<string, number> };
  const execTh = params.execution_thresholds ?? null, tally = execTh ? new ExecutionTally(execTh) : null;
  let cash = params.initial_cash, peak = cash, seq = 0, live: Live | null = null, fi = 0, markFallback = 0;
  if (perp && !funding) flags.add('funding_missing');
  while (fi < fpoints.length && bars.length && fpoints[fi]!.ts <= bars[0]!.open_time) fi++;
  const n = bars.length;
  const ev = (p: BacktestPlan, at: number, kind: BacktestPlanEventKind, price: number | null, note = '') => { if (p.events.length < MAX_EVENTS) p.events.push({ at, kind, price: price === null ? null : r8(price), note } as BacktestPlanEvent); };
  const closeTimeOf = (i: number) => i < n ? bars[i]!.close_time : bars[n - 1]!.close_time + (i - n + 1) * params.timeframe_ms;
  const markBar = (k: number) => params.mark?.[k] ?? bars[k]!;
  const equityNow = () => cash + (live?.filled ? live.margin_open + live.qty * (bars[Math.max(0, lastMarked)]!.close - live.avg) * live.dir : 0);
  let lastMarked = -1;
  // ── 计划放置前校验:止损/止盈方向、盈亏比(用户硬约束 min_rr)。不过关 = blocked 行,不影响任何在途计划。
  function build(it: PlanIntent, signal_index: number): { plan: BacktestPlan; tps: Tp[]; blocked: string | null; note: string } {
    const b = bars[signal_index]!, limit = it.entry.type === 'limit', ref = limit ? it.entry.price : it.reference_price, dir = it.side === 'long' ? 1 : -1;
    const expiry_index = signal_index + Math.max(1, it.expiry_bars);
    const plan: BacktestPlan = { id: `${prefix}${++seq}`, symbol: params.symbol, side: it.side, market: params.market, leverage: lev, placed_at: b.close_time, reason: it.reason, entry_type: it.entry.type, entry_price: limit && ref !== null ? r8(ref) : null, reference_price: r8(it.reference_price), expires_at: limit ? closeTimeOf(expiry_index) : closeTimeOf(signal_index + 1), status: 'pending', filled_at: null, fill_price: null, fill_gap: false, legs: [], stop: it.stop ? { price: r8(it.stop.price), size_pct: 1, source: it.stop.source, note: it.stop.note, filled_at: null, fill_price: null } : null, take_profits: [], stop_path: [], planned_rr: null, min_rr: it.min_rr, exit: null, pnl_pct: null, r_multiple: null, mfe_pct: null, mae_pct: null, funding_pct: null, fees_pct: 0, bars_held: 0, rolled_from: null, rolled_to: null, replaced_by: null, segment: segment(b.close_time), events: [], price_move_pct: null, gross_pct: null, funding_status: perp ? (funding ? 'complete' : 'missing') : 'not_applicable', funding_periods: 0, liquidation_price: null, qty: 0, margin: 0, entry_source: limit ? it.entry.source : null, blocked_reason: null };
    const fail = (code: string, note: string) => ({ plan, tps: [] as Tp[], blocked: code, note });
    if (ref === null || !(ref > 0) || !Number.isFinite(ref)) return fail('no_entry_price', '限价单缺少有效挂单价');
    if (!it.stop || !Number.isFinite(it.stop.price)) return fail('no_stop', '没有有效止损来源');
    const risk = (ref - it.stop.price) * dir;
    if (!(risk > 0)) return fail('stop_side', `止损 ${r8(it.stop.price)} 不在${it.side === 'long' ? '入场价下方' : '入场价上方'}`);
    const valid = it.take_profits.filter((t) => Number.isFinite(t.price) && (t.price - ref) * dir > 0).sort((a, c) => (a.price - c.price) * dir);
    const dropped = it.take_profits.length - valid.length, wsum = valid.reduce((a, t) => a + (t.size_pct > 0 ? t.size_pct : 0), 0);
    const tps: Tp[] = valid.map((t) => { const weight = wsum > 0 ? (t.size_pct > 0 ? t.size_pct / wsum : 0) : 1 / valid.length; return { weight, filled: false, level: { price: r8(t.price), size_pct: weight, source: t.source, note: t.note, filled_at: null, fill_price: null } }; });
    plan.take_profits = tps.map((t) => t.level) as BacktestPlan['take_profits'];
    plan.planned_rr = tps.length ? tps.reduce((a, t) => a + t.weight * Math.abs(t.level.price - ref), 0) / Math.abs(risk) : null;
    const note = dropped ? `丢弃 ${dropped} 档方向错误的止盈` : '';
    // 结构口径:止损离参考价不到 k×ATR(14) 的单子直接不做,不把止损挪远(几何实验室止血规则;盈亏比照算照展示)
    if (it.min_stop_atr != null && it.atr != null && it.atr > 0 && Math.abs(risk) < it.min_stop_atr * it.atr - EPS) return { ...fail('stop_too_close', `止损离${limit ? '挂单价' : '入场参考价'} ${(Math.abs(risk) / it.atr).toFixed(2)}×ATR(14) < ${it.min_stop_atr}×ATR,不做`), tps };
    if (it.min_rr !== null && plan.planned_rr === null) return { ...fail('no_target', '有最小盈亏比约束但没有有效止盈'), tps };
    if (it.min_rr !== null && plan.planned_rr! < it.min_rr - 1e-9) return { ...fail('min_rr', `计划盈亏比 ${plan.planned_rr!.toFixed(2)} < 最小 ${it.min_rr}`), tps };
    // 执行层:用实盘同一套阈值再判一次,前面的检查都过了才判。参考价和上面一样,市价单用信号收盘价,限价单用挂单价。
    // 多档止盈按各档仓位比例折成一个等效目标再算净盈亏比,和实盘一样
    if (execTh) {
      const x = executionCheck(it.side, ref, it.stop.price, blendedTarget(valid.map((t, i) => ({ price: t.price, size: tps[i]!.weight }))), it.atr ?? null, execTh);
      tally!.add(params.symbol, b.close_time, x);
      if (x.blocks.length) return { ...fail(x.blocks[0]!, `执行层:${x.reason}`), tps };
    }
    return { plan, tps, blocked: null, note };
  }
  function place(it: PlanIntent, signal_index: number, built = build(it, signal_index)): void {
    const { plan, tps, note } = built;
    ev(plan, plan.placed_at, 'placed', plan.entry_price ?? plan.reference_price, [it.entry.type === 'limit' ? `限价 ${plan.entry_price}(${it.entry.note || it.entry.source})` : '市价:下一根 open', note, it.size_note ?? ''].filter(Boolean).join(';'));
    live = { plan, intent: it, side: it.side, dir: it.side === 'long' ? 1 : -1, signal_index, expiry_index: signal_index + Math.max(1, it.entry.type === 'market' ? 1 : it.expiry_bars), filled: false, fill_index: -1, intrabar_fill_index: -1, qty: 0, qty_total: 0, avg: 0, first_qty: 0, margin_open: 0, margin_total: 0, base_leg_margin: 0, gross: 0, fees: 0, funding: 0, funding_periods: 0, funding_seen: false, exit_value: 0, exit_qty: 0, stop: plan.stop?.price ?? null, stop_source: 'initial', initial_stop: plan.stop?.price ?? null, pending_breakeven: false, tps, tp_hit: false, hi: -Infinity, lo: Infinity, scheduled: null, adds: [] };
  }
  function blockedRow(built: ReturnType<typeof build>): void {
    counters.blocked++; if (built.blocked) counters.blocked_by[built.blocked] = (counters.blocked_by[built.blocked] ?? 0) + 1;
    if (counters.blocked > maxBlocked) { flags.add('blocked_rows_truncated'); seq--; return; }
    built.plan.status = 'blocked'; built.plan.blocked_reason = built.blocked; ev(built.plan, built.plan.placed_at, 'blocked', built.plan.entry_price ?? built.plan.reference_price, built.note); plans.push(built.plan);
  }
  const extreme = (l: Live, b: OrderBar) => { l.hi = Math.max(l.hi, b.high); l.lo = Math.min(l.lo, b.low); };
  const setLiq = (l: Live) => { if (perp) l.plan.liquidation_price = r8(liquidationPrice(l.avg, lev, mmrOf(params.maintenance_margin, l.qty), l.side)); };
  /** 成交一腿:保证金 = 首腿额度(权益×margin_fraction/(max_adds+1)),受现金约束;数量 = 保证金×杠杆/成交价。 */
  function fillLeg(l: Live, k: number, price: number, fee_rate: number, carried?: { qty: number }): boolean {
    const b = bars[k]!;
    let margin: number, qty: number, fee: number;
    if (carried) { qty = carried.qty; margin = qty * price / lev; fee = 0; }
    else {
      // 波动率目标仓位(intent.size_weight):首腿额度再 × w;不用 vol_target 的意图不带该字段,算式逐字不变
      if (!l.filled) l.base_leg_margin = firstLegMargin(equityNow(), mf, maxAdds, l.intent.size_weight);
      margin = fundedLeg(l.base_leg_margin, cash, lev, fee_rate, price).margin;
      if (!(margin > EPS)) return false;
      qty = margin * lev / price; fee = qty * price * fee_rate;
    }
    cash -= margin + fee;
    l.avg = (l.avg * l.qty_total + price * qty) / (l.qty_total + qty); l.qty += qty; l.qty_total += qty; l.margin_open += margin; l.margin_total += margin; l.fees += fee;
    if (!l.filled) { l.first_qty = qty; l.filled = true; l.fill_index = k; l.plan.filled_at = b.open_time; l.plan.fill_price = r8(price); l.plan.status = 'filled'; if (l.stop !== null) l.plan.stop_path.push({ at: b.open_time, price: r8(l.stop) }); }
    l.plan.legs.push({ at: b.open_time, price: r8(price), qty_frac: r8(qty / l.first_qty) });
    setLiq(l); return true;
  }
  /** 平掉 qty。liquidity: maker 限价(无滑点)/ taker 市价(不利滑点)/ none 结转记账(无费无滑点)/ liq 强平(损失整份剩余保证金)。 */
  function exitQty(l: Live, k: number, rawQty: number, rawPrice: number, liquidity: 'maker' | 'taker' | 'none' | 'liq', reason: OrderExitReason, at: number): void {
    const qty = Math.min(l.qty, rawQty); if (qty <= EPS) return;
    const price = liquidity === 'taker' ? rawPrice * (1 - slip * l.dir) : rawPrice;
    const released = l.margin_open * qty / l.qty; let gross = qty * (price - l.avg) * l.dir, fee = liquidity === 'maker' ? qty * price * maker : liquidity === 'taker' ? qty * price * taker : 0;
    if (liquidity === 'liq') { if (released + gross < 0) gross = -released; fee = released + gross; }
    cash += released + gross - fee; l.gross += gross; l.fees += fee; l.margin_open -= released; l.qty -= qty; l.exit_value += qty * price; l.exit_qty += qty;
    if (l.qty <= l.qty_total * 1e-9) { l.qty = 0; finalize(l, k, reason, at); }
  }
  function finalize(l: Live, k: number, reason: OrderExitReason, at: number, markPrice?: number): void {
    const p = l.plan, open = reason === 'open';
    const exitPrice = open ? (l.exit_value + l.qty * markPrice!) / l.qty_total : l.exit_value / l.exit_qty;
    const gross = open ? l.gross + l.qty * (markPrice! - l.avg) * l.dir : l.gross;
    p.exit = { at, price: r8(exitPrice), reason }; p.bars_held = k - l.fill_index; p.qty = r8(l.qty_total); p.margin = r8(l.margin_total);
    const basis = l.margin_total, net = gross + l.funding - l.fees;
    p.pnl_pct = basis > 0 ? net / basis : null; p.gross_pct = basis > 0 ? gross / basis : null; p.fees_pct = basis > 0 ? l.fees / basis : 0;
    p.price_move_pct = (exitPrice - l.avg) * l.dir / l.avg;
    const dist = l.initial_stop === null ? 0 : Math.abs(l.avg - l.initial_stop);
    p.r_multiple = dist > 0 ? (exitPrice - l.avg) * l.dir / dist : null;
    const hi = Math.max(l.hi, l.avg), lo = Math.min(l.lo, l.avg);
    p.mfe_pct = (l.dir > 0 ? hi - l.avg : l.avg - lo) / l.avg; p.mae_pct = (l.dir > 0 ? lo - l.avg : l.avg - hi) / l.avg;
    p.funding_periods = l.funding_periods;
    if (perp) {
      if (!funding) p.funding_status = 'missing';
      else { const from = p.filled_at!, to = at, inside = from >= funding.from_ms && to <= funding.to_ms + 8 * 3600_000, overlap = to >= funding.from_ms && from <= funding.to_ms; p.funding_status = inside ? 'complete' : overlap ? 'partial' : 'missing'; }
      p.funding_pct = p.funding_status === 'missing' ? null : basis > 0 ? l.funding / basis : null;
      if (p.funding_status === 'partial') flags.add('funding_partial'); if (p.funding_status === 'missing') flags.add('funding_missing');
      if (l.funding_periods) ev(p, at, 'funding', null, `资金费 ${l.funding_periods} 期合计 ${r8(l.funding)}(正=收到)`);
    }
    if (!open) { ev(p, at, 'closed', exitPrice, ({ tp: '止盈出清', sl: '止损', trail: '移动止损', breakeven: '保本止损', signal_exit: '信号离场,开盘成交', time: '持仓满周期上限,开盘离场', rolled: '结转', flipped: '反手', liquidation: '强平' } as Record<string, string>)[reason] ?? reason); trades.push({ id: p.id, symbol: p.symbol, side: p.side, entry_at: p.filled_at!, entry_price: r8(l.avg), exit_at: at, exit_price: r8(exitPrice), qty: r8(l.qty_total), pnl: r8(net), return_pct: p.pnl_pct ?? 0, fees: r8(l.fees), bars_held: p.bars_held, exit_reason: reason, segment: p.segment }); }
    plans.push(p); if (live === l) live = null;
  }
  const stopReason = (s: StopSource): OrderExitReason => s === 'initial' ? 'sl' : s === 'breakeven' ? 'breakeven' : 'trail';
  function chargeFunding(l: Live, rate: number, price: number, ts: number): void {
    const amt = -l.dir * rate * l.qty * price; cash += amt; l.funding += amt; l.funding_periods++; void ts;
  }
  /** 挂着的保护单在开盘就被越过:强平/止损/止盈按 open 成交(跳空)。返回是否已全部出场。 */
  function openGaps(l: Live, k: number): boolean {
    const b = bars[k]!, m = perp ? markBar(k) : b;
    if (perp && l.plan.liquidation_price != null && (m.open - l.plan.liquidation_price) * l.dir <= 0) { ev(l.plan, b.open_time, 'liquidated', l.plan.liquidation_price, '开盘标记价已越过强平价'); exitQty(l, k, l.qty, l.plan.liquidation_price!, 'liq', 'liquidation', b.open_time); return true; }
    if (l.stop !== null && (b.open - l.stop) * l.dir < 0) { ev(l.plan, b.open_time, 'sl_hit', b.open, '开盘已越过止损,按更差 open 成交(跳空)'); exitQty(l, k, l.qty, b.open, 'taker', stopReason(l.stop_source), b.open_time); return true; }
    return false;
  }
  function tpLadder(l: Live, k: number, onlyGap: boolean): void {
    const b = bars[k]!, wasHit = l.tp_hit;
    for (let i = 0; i < l.tps.length && live === l; i++) {
      const t = l.tps[i]!; if (t.filled) continue;
      const f = takeProfitFill(b, t.level.price, l.side); if (!f || (onlyGap && !f.gap)) continue;
      const last = l.tps.every((x, j) => j === i || x.filled), qty = last ? l.qty : Math.min(l.qty, t.weight * l.qty_total);
      t.filled = true; t.level.filled_at = b.open_time; t.level.fill_price = r8(f.price); l.tp_hit = true;
      ev(l.plan, b.open_time, 'tp_hit', f.price, `第 ${i + 1} 档 ${Math.round(t.weight * 100)}%${f.gap ? ';开盘已越过目标,按更优 open 成交(跳空)' : ''}`);
      exitQty(l, k, qty, f.price, 'maker', 'tp', b.open_time);
    }
    if (live === l && !wasHit && l.tp_hit && params.breakeven_after_tp) l.pending_breakeven = true;
  }
  for (let k = 0; k < n; k++) {
    const b = bars[k]!;
    // A. 落在本根开盘时刻及以前的资金费期 → 开盘前已持有的仓位
    while (fi < fpoints.length && fpoints[fi]!.ts <= b.open_time) { const l = live as Live | null; if (l?.filled) chargeFunding(l, fpoints[fi]!.rate, b.open, fpoints[fi]!.ts); fi++; }
    // B. 已成交仓位的开盘事件:先结算挂着的保护单跳空,再执行上一根收盘排定的信号/时间离场
    const lB = live as Live | null;
    if (lB?.filled) {
      const l: Live = lB; extreme(l, b);
      if (!openGaps(l, k)) { tpLadder(l, k, true); if ((live as Live | null) === l && l.scheduled) exitQty(l, k, l.qty, b.open, 'taker', l.scheduled, b.open_time); }
    }
    // C. 上一根收盘产生的新计划意图,在本根开盘生效
    const it = k > 0 ? intents[k - 1] : null;
    if (it) {
      if (!perp && it.side === 'short') { counters.spot_short++; flags.add('spot_short_rejected'); }
      else {
        const built = build(it, k - 1), cur = live as Live | null;
        if (built.blocked) blockedRow(built);
        else if (!cur) place(it, k - 1, built);
        else if (!cur.filled) {
          if (newSignalAction(policy, cur.side, it.side, false, 0, maxAdds) === 'ignore') { counters.ignored++; seq--; }
          else { cur.plan.status = cur.side === it.side ? 'replaced' : 'cancelled'; if (cur.side === it.side) { cur.plan.replaced_by = built.plan.id; ev(cur.plan, b.open_time, 'replaced', null, '未成交,被同向新计划整体替换(8794 v8)'); } else { cur.plan.blocked_reason = 'opposite_signal'; ev(cur.plan, b.open_time, 'cancelled', null, '未成交,反向新计划到达,撤单'); } plans.push(cur.plan); live = null; place(it, k - 1, built); }
        } else if (newSignalAction(policy, cur.side, it.side, true, cur.plan.legs.length - 1 + cur.adds.length, maxAdds) === 'flip') {
          ev(cur.plan, b.open_time, 'flipped', b.open, '反向新计划到达,开盘反手'); exitQty(cur, k, cur.qty, b.open, 'taker', 'flipped', b.open_time); place(it, k - 1, built);
        } else if (newSignalAction(policy, cur.side, it.side, true, cur.plan.legs.length - 1 + cur.adds.length, maxAdds) === 'roll') {
          const qty = cur.qty, px = b.open; built.plan.rolled_from = cur.plan.id; cur.plan.rolled_to = built.plan.id;
          ev(cur.plan, b.open_time, 'rolled_out', px, `结转到 ${built.plan.id}:按开盘价记账,不收手续费`); exitQty(cur, k, qty, px, 'none', 'rolled', b.open_time);
          place(it, k - 1, built); const nl = live as unknown as Live; nl.base_leg_margin = cur.base_leg_margin; fillLeg(nl, k, px, 0, { qty }); extreme(nl, b);
          ev(nl.plan, b.open_time, 'rolled_in', px, `承接 ${cur.plan.id} 的仓位;本计划止损/止盈接管`);
        } else if (newSignalAction(policy, cur.side, it.side, true, cur.plan.legs.length - 1 + cur.adds.length, maxAdds) === 'add') cur.adds.push({ intent: it, signal_index: k - 1, expiry_index: k - 1 + Math.max(1, it.entry.type === 'market' ? 1 : it.expiry_bars) }), seq--;
        else { counters.ignored++; seq--; }
      }
    }
    // D. 挂单成交判定(市价 = 本根 open;限价 = 时效窗口内触价)
    const lD = live as Live | null;
    if (lD && !lD.filled) {
      const l: Live = lD;
      if (k > l.expiry_index) { l.plan.status = 'no_fill'; ev(l.plan, closeTimeOf(l.expiry_index), 'no_fill', null, '时效窗口内未触价'); plans.push(l.plan); live = null; }
      else if (k > l.signal_index) {
        const market = l.intent.entry.type === 'market', f = market ? { price: clampToBar(b, b.open) * (1 + slip * l.dir), gap: false } : entryLimitFill(b, l.intent.entry.price!, l.side);
        if (f) {
          const badStop = l.stop !== null && (f.price - l.stop) * l.dir <= 0, badTp = l.tps.some((t) => (t.level.price - f.price) * l.dir <= 0);
          if (badStop || badTp) { l.plan.status = 'cancelled'; l.plan.blocked_reason = 'gap_invalidated'; ev(l.plan, b.open_time, 'cancelled', f.price, `成交价 ${r8(f.price)} 已越过${badStop ? '止损' : '止盈'},计划失效`); plans.push(l.plan); live = null; }
          else if (!fillLeg(l, k, f.price, market ? taker : maker)) { l.plan.status = 'cancelled'; l.plan.blocked_reason = 'insufficient_cash'; ev(l.plan, b.open_time, 'cancelled', null, '可用资金不足'); plans.push(l.plan); live = null; }
          else { l.plan.fill_gap = f.gap; if (!market && !f.gap) l.intrabar_fill_index = k; extreme(l, b); ev(l.plan, b.open_time, 'filled', f.price, market ? '市价:本根 open' : f.gap ? '开盘已越过限价,按更优 open 成交(跳空)' : '限价触价成交'); }
        }
      }
    }
    // E. 加仓腿(8794:先加仓再判出场)
    const lE = live as Live | null;
    if (lE?.filled && lE.adds.length) {
      const l: Live = lE;
      l.adds = l.adds.filter((a) => {
        if (k > a.expiry_index) return false; if (k <= a.signal_index) return true;
        const market = a.intent.entry.type === 'market', f = market ? { price: clampToBar(b, b.open) * (1 + slip * l.dir), gap: false } : entryLimitFill(b, a.intent.entry.price!, l.side);
        if (!f) return true;
        if (fillLeg(l, k, f.price, market ? taker : maker)) { counters.added++; ev(l.plan, b.open_time, 'added', f.price, `等权加仓腿(${a.intent.reason});均价 ${r8(l.avg)}`); }
        return false;
      });
    }
    // G. 落在本根内部的资金费期 → 开盘后仍持有、且不是本根盘中才成交的仓位
    while (fi < fpoints.length && fpoints[fi]!.ts <= b.close_time) { const l = live as Live | null; if (l?.filled && l.intrabar_fill_index !== k) chargeFunding(l, fpoints[fi]!.rate, b.open, fpoints[fi]!.ts); fi++; }
    // F. 盘中:强平 / 止损(同根 SL 先于 TP)/ 多档止盈
    const lF = live as Live | null;
    if (lF?.filled) {
      if (perp && params.mark && !params.mark[k]) markFallback++;
      const l: Live = lF, m = perp ? markBar(k) : b, liq = l.plan.liquidation_price ?? null;
      const stopHit = l.stop !== null ? stopFill(b, l.stop, l.side) : null, liqHit = perp && liq !== null && (l.dir > 0 ? m.low <= liq : m.high >= liq);
      const liqFirst = liqHit && (!stopHit || (l.dir > 0 ? liq! >= l.stop! : liq! <= l.stop!));
      if (liqFirst) { ev(l.plan, b.open_time, 'liquidated', liq, '标记价触及强平价'); exitQty(l, k, l.qty, liq!, 'liq', 'liquidation', b.open_time); }
      else if (stopHit) { ev(l.plan, b.open_time, 'sl_hit', stopHit.price, stopHit.gap ? '开盘已越过止损,按更差 open 成交(跳空)' : l.stop_source === 'initial' ? '触及止损' : `触及${l.stop_source === 'breakeven' ? '保本' : '移动'}止损`); exitQty(l, k, l.qty, stopHit.price, 'taker', stopReason(l.stop_source), b.open_time); }
      else if (l.intrabar_fill_index !== k) tpLadder(l, k, false);
    }
    // H. 收盘:移动止损(只收紧,下一根生效)/ 保本 / 信号离场 / 周期上限
    const lH = live as Live | null;
    if (lH?.filled) {
      const l: Live = lH, held = k - l.fill_index + 1;
      const tighten = (price: number, source: StopSource, note: string) => { if (!tighterStop(l.side, l.stop, price)) return; l.stop = price; l.stop_source = source; l.plan.stop_path.push({ at: b.close_time, price: r8(price) }); ev(l.plan, b.close_time, 'stop_moved', price, note); };
      if (l.pending_breakeven) { l.pending_breakeven = false; tighten(l.avg, 'breakeven', '首档止盈后止损移到入场均价(保本)'); }
      const u = manage?.({ plan_id: l.plan.id, side: l.side, bar_index: k, entry_at: l.plan.filled_at!, avg_entry: l.avg, initial_stop: l.initial_stop, initial_distance: l.initial_stop === null ? 0 : Math.abs(l.avg - l.initial_stop), bars_held: held, high_water: l.hi, low_water: l.lo, stop: l.stop });
      if (u?.stop !== undefined) tighten(u.stop, u.stop_source ?? 'trail', `移动止损(${u.stop_source ?? 'trail'})`);
      if (u?.exit) l.scheduled = 'signal_exit';
      if (!l.scheduled && params.max_holding_bars && held >= params.max_holding_bars) l.scheduled = 'time';
    }
    // I. 收盘记净值(浮盈按标记价收盘)
    lastMarked = k;
    const l = live as Live | null, mc = l?.filled ? (perp ? markBar(k).close : b.close) : 0;
    const eq = cash + (l?.filled ? l.margin_open + l.qty * (mc - l.avg) * l.dir : 0); if (eq > peak) peak = eq;
    equity.push({ at: b.close_time, equity: r8(eq), pnl_pct: eq / params.initial_cash - 1, drawdown: peak > 0 ? 1 - eq / peak : 0, benchmark_pct: null, exposure: l?.filled && eq > 0 ? l.qty * b.close / eq : 0 });
    yield;
  }
  const end = live as Live | null;
  if (end) { if (end.filled) finalize(end, n - 1, 'open', bars[n - 1]!.close_time, bars[n - 1]!.close); else { end.plan.status = end.expiry_index <= n - 1 ? 'no_fill' : 'pending'; if (end.plan.status === 'no_fill') ev(end.plan, closeTimeOf(end.expiry_index), 'no_fill', null, '时效窗口内未触价'); plans.push(end.plan); } }
  if (markFallback) flags.add(`mark_fallback:${markFallback}`);
  plans.sort((a, c) => a.placed_at - c.placed_at || Number(a.id.slice(prefix.length)) - Number(c.id.slice(prefix.length)));
  const { blocked_by, ...legacyCounters } = counters;
  return { engine_version: params.structure ? ORDERS_ENGINE_VERSION_V2 : ORDERS_ENGINE_VERSION, plans, equity, trades, stats: params.structure ? { ...planStats(plans, legacyCounters), blocked_by } : planStats(plans, legacyCounters), flags: [...flags], ...(tally ? { execution_gate: tally.stats() } : {}) };
}
