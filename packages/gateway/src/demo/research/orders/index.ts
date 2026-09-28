/** 订单周期执行核入口(WP-F)。第二阶段由全窗口回测在 IR 带 order 块时调用 runOrderPath;不带 order 块时沿用旧执行路径。 */
import type { ResearchBar, StrategyIR, OrderGateParams, BacktestSegmentName } from '@trade-gate/contracts';
import { judgeWithBars } from '../judge/index.js';
import { intentSnapshot } from '../judge/candidate.js';
import { simulateOrders, simulateOrdersAsync } from './simulate.js';
import { orderIntents, orderIntentsAsync, orderManager, orderExecOverrides } from './intents.js';
import { toOrderBar } from './fills.js';
import { isStructureGate } from '../order-gate.js';
import type { FundingSeries, MmrTier, OrderBar, OrderSimResult } from './types.js';
export * from './types.js';
export { simulateOrders, simulateOrdersAsync, simulateSteps, ORDERS_ENGINE_VERSION, ORDERS_ENGINE_VERSION_V2 } from './simulate.js';
export { drainSync, drainAsync, YIELD_MS } from './drain.js';
export { entryLimitFill, stopFill, takeProfitFill, defaultExpiryBars, liquidationPrice, toOrderBar } from './fills.js';
export { orderIntents, orderIntentsAsync, intentSteps, orderManager, resolveOrder, evalLevel, mirrorBars, levelSource, defaultTakeProfits, type ResolvedOrder } from './intents.js';
export { planStats } from './stats.js';
export interface OrderPathInput {
  judge?: import('../judge/index.js').JudgeRuntime;
  candidate_filter?: (candidate: import('../judge/types.js').JudgeCandidateSnapshot, bars: ResearchBar[]) => Promise<import('../judge/types.js').JudgeResult>;
  on_candidate?: (candidate: import('../judge/types.js').JudgeCandidateSnapshot, decision: import('../judge/types.js').JudgeResult | null) => void;
  ir: StrategyIR; bars: ResearchBar[]; timeframe_ms: number; symbol: string;
  /** 回测窗口(含两端)在 bars 里的下标;之前的 bars 只做预热 */
  from_index: number; to_index: number;
  initial_cash: number;
  /** 执行成本:现货沿用 ResearchExecution 的 fee_rate/slippage_bps;永续缺省 taker 0.05% / maker 0.02% */
  fee_rate?: string; maker_fee_rate?: string; slippage_bps?: string;
  gate?: OrderGateParams | null;
  funding?: FundingSeries | null; mark?: (OrderBar | null)[]; maintenance_margin?: number | MmrTier[];
  segment_of?: (at: number) => BacktestSegmentName; id_prefix?: string; margin_fraction?: number;
  /** 每根决策可见根数(缺省 5000;全窗口回测传 viewBars)与逐根记忆(篮子腿复用) */
  view_bars?: number; memo?: Map<string, unknown>;
}
function pathSetup(x: OrderPathInput) {
  const perpDefault = x.ir.order?.market === 'perp';
  const taker = x.fee_rate ?? (perpDefault ? '0.0005' : '0.001'), maker = x.maker_fee_rate ?? (perpDefault ? '0.0002' : taker), slip = x.slippage_bps ?? '5';
  const opts = { fee_rate: taker, slippage_bps: slip, gate: x.gate ?? null, from_index: x.from_index, to_index: x.to_index, ...(x.view_bars ? { view: x.view_bars } : {}), ...(x.memo ? { memo: x.memo } : {}) };
  const params = (order: ReturnType<typeof orderExecOverrides>) => ({ symbol: x.symbol, timeframe_ms: x.timeframe_ms, initial_cash: x.initial_cash, taker_fee_rate: Number(taker), maker_fee_rate: Number(maker), slippage_bps: Number(slip), ...order, funding: x.funding ?? null, ...(x.mark ? { mark: x.mark.slice(x.from_index, x.to_index + 1) } : {}), ...(x.maintenance_margin !== undefined ? { maintenance_margin: x.maintenance_margin } : {}), ...(x.segment_of ? { segment_of: x.segment_of } : {}), ...(x.id_prefix ? { id_prefix: x.id_prefix } : {}), ...(x.margin_fraction !== undefined ? { margin_fraction: x.margin_fraction } : {}), ...(isStructureGate(x.gate) ? { structure: true } : {}), ...(x.gate?.execution_thresholds ? { execution_thresholds: x.gate.execution_thresholds } : {}) });
  const manager = () => orderManager(x.ir, x.bars, x.timeframe_ms, { fee_rate: taker, offset: x.from_index, ...(x.view_bars ? { view: x.view_bars } : {}) });
  return { opts, params, manager, window: () => x.bars.slice(x.from_index, x.to_index + 1).map(toOrderBar) };
}
export function runOrderPath(x: OrderPathInput): OrderSimResult & { notes: string[] } {
  if (x.ir.judge) throw Error('judge_requires_async_executor');
  const s = pathSetup(x), { order, intents, notes } = orderIntents(x.ir, x.bars, x.timeframe_ms, s.opts);
  return { ...simulateOrders(s.window(), intents, s.params(orderExecOverrides(order)), s.manager()), notes };
}
/** 全窗口回测用:与 runOrderPath 同一结果,意图计算与执行核都按时间让出事件循环(每 20ms 至少一次)。 */
export async function runOrderPathAsync(x: OrderPathInput, check?: () => void): Promise<OrderSimResult & { notes: string[] }> {
  const s = pathSetup(x), { order, intents, notes } = await orderIntentsAsync(x.ir, x.bars, x.timeframe_ms, s.opts, check);
  const candidates: import('../judge/filter.js').CandidateLog[] = [];
  if (x.ir.judge && !x.judge && !x.candidate_filter) throw Error('judge_runtime_missing');
  if (x.ir.judge || x.on_candidate) for (let i = 0; i < intents.length; i++) {
    check?.(); const intent = intents[i]; if (!intent) continue;
    const at = x.from_index + i, candidate = intentSnapshot(x.ir,intent,x.symbol,x.bars[at]!.open_time+x.timeframe_ms,x.timeframe_ms);
    const visible = x.bars.slice(Math.max(0,at-99),at+1);
    const decision = x.ir.judge ? await (x.candidate_filter ? x.candidate_filter(candidate,visible) : judgeWithBars(x.ir,candidate,visible,x.judge!)) : null;
    candidates.push({candidate,decision}); x.on_candidate?.(candidate,decision);
    if (decision && decision.action !== 'follow') intents[i] = null;
  }
  return { ...(await simulateOrdersAsync(s.window(), intents, s.params(orderExecOverrides(order)), s.manager(), check)), notes, ...(x.ir.judge || x.on_candidate ? {candidates} : {}) };
}
