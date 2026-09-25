/** 全窗口回测的订单周期执行器(WP-F 第二阶段,2026-09-23):IR 带 order 块时,backtest-report 的每个资产(含篮子两腿)走这里。
 * 口径:
 *  - 窗口 = 报告给的 [from_ms, to_ms](两端都是已收盘 bar 的 close_time),之前的 bars 只做预热;第 from 根收盘产生的意图在第 from+1 根生效(同 engine v4)。
 *  - 每根可见根数 = engine v4 的 viewBars(6×预热,500–5000),逐根条件与计划意图按资产记忆(篮子腿复用);Pine 序列不转数字(同 engine.ts)。
 *  - 仓位:unit_notional = 首腿保证金占权益 100%;其他 sizing_mode 按 max_allocation(执行核 margin_fraction),杠杆只在永续放大名义值。
 *  - 手续费由调用方给(现货沿用 execution.fee_rate;永续缺省 taker 0.05% / maker 0.02%,只在用户显式改 fee_rate 时跟随)。
 *  - 永续:标记价 K 线判强平、真实 8h 资金费序列、维持保证金分档(当前值)由调用方从 data/perp-market.ts 取来喂进;缺哪样执行核照 flags 标注,不伪造。
 *  - 输出与 engine v4 执行器同形(AssetRunOutput):净值序列前面补一点 from_ms-1 = 初始资金(与 v4 的 mark(first) 对齐,持有基准从同一点起算)。
 */
import type { BacktestPlan, ResearchPolicy, StrategyIR } from '@trading-swarm/contracts';
import type { AssetExecutor, AssetRunOutput } from '../backtest-report.js';
import { viewBars, numericBars } from '../engine.js';
import { strategyNodes, orderNodes } from '../strategy.js';
import { runOrderPathAsync, ORDERS_ENGINE_VERSION } from './index.js';
const usesPine = (ir: StrategyIR) => [...strategyNodes(ir), ...orderNodes(ir)].some((x) => x.node.primitive.startsWith('pine_'));
const FLAG_TEXT: Record<string, string> = {
  funding_missing: '部分永续计划的持仓段没有资金费序列,funding_pct 记为 null(不当 0)',
  funding_partial: '部分永续计划的持仓段只被资金费序列部分覆盖',
  spot_short_rejected: '现货不能做空:做空意图全部拒绝',
  blocked_rows_truncated: '被拦计划超过 2000 行,之后只计数不留行',
};
const flagText = (symbol: string, f: string) => f.startsWith('mark_fallback:') ? `${symbol} 有 ${f.split(':')[1]} 根没有标记价,这些根的强平与浮盈退回成交价` : `${symbol} ${FLAG_TEXT[f] ?? f}`;
export const orderExecutor: AssetExecutor = async (x) => {
  const bars = x.dataset.bars, step = x.dataset.timeframe_ms, fail = (error: string): AssetRunOutput => ({ status: 'failed', error, engine_version: ORDERS_ENGINE_VERSION, equity: [], trades: [], fees: 0, plans: [], plan_stats: null });
  const from = bars.findIndex((b) => b.close_time === x.from_ms), to = bars.findIndex((b) => b.close_time === x.to_ms);
  if (from < 0 || to <= from) return fail('window_not_in_dataset');
  const perp = x.ir.order?.market === 'perp';
  if (perp && !x.perp) return fail('perp_data_missing:永续回测需要永续行情(成交价/标记价 K 线、资金费、分档)');
  const ex = x.execution, mf = ex.sizing_mode === 'unit_notional' ? 1 : Math.min(1, Math.max(0, Number(ex.max_allocation) || 1)), initial = Number(ex.initial_cash);
  const view = viewBars(x.ir, { lookback: 1, atr_period: 1 } as ResearchPolicy, step), src = usesPine(x.ir) ? bars : numericBars(bars);
  let r: Awaited<ReturnType<typeof runOrderPathAsync>>;
  try {
    r = await runOrderPathAsync({ ir: x.ir, bars: src, judge: x.judge, candidate_filter: x.candidate_filter, on_candidate: x.on_candidate, timeframe_ms: step, symbol: x.symbol, from_index: from, to_index: to, initial_cash: initial, fee_rate: x.fees?.taker ?? ex.fee_rate, ...(x.fees?.maker ? { maker_fee_rate: x.fees.maker } : {}), slippage_bps: ex.slippage_bps, gate: x.order_gate, margin_fraction: mf, view_bars: view, memo: x.cache, ...(x.segment_of ? { segment_of: x.segment_of } : {}), ...(x.perp ? { funding: x.perp.funding, mark: x.perp.mark, ...(x.perp.tiers.length ? { maintenance_margin: x.perp.tiers } : {}) } : {}) }, x.check);
  } catch (e) { const msg = e instanceof Error ? e.message : String(e); if (/CANCELLED|TIMEOUT/.test(msg)) throw e; return fail(msg.slice(0, 400)); }
  const filled = r.plans.filter((p) => p.filled_at !== null), fees = filled.reduce((a, p) => a + p.fees_pct * (p.margin ?? 0), 0);
  const warnings = [...r.flags.map((f) => flagText(x.symbol, f)), ...r.notes.map((n) => `${x.symbol} ${n}`)];
  const open = r.plans.find((p: BacktestPlan) => p.exit?.reason === 'open');
  if (open) warnings.push(`${x.symbol} 期末仍有持仓(${open.id}),按最后收盘价盯市计入净值,不计入已平仓统计`);
  return {
    status: 'completed', error: null, engine_version: r.engine_version, ...(r.candidates ? {candidates:r.candidates} : {}),
    equity: [{ at: x.from_ms - 1, equity: initial, holdings: 0, exposure: 0 }, ...r.equity.map((e) => ({ at: e.at, equity: e.equity, holdings: e.exposure * e.equity, exposure: e.exposure }))],
    trades: r.trades.map(({ segment: _s, ...t }) => t), fees, plans: r.plans, plan_stats: r.stats, warnings,
  };
};
/** backtest-report 的执行器选择:IR 带 order 块 → 订单执行核;否则 null(engine v4)。 */
export const pickOrderExecutor = (ir: StrategyIR): AssetExecutor | null => (ir.order ? orderExecutor : null);
