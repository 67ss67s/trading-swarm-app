/** 全窗口回测接订单周期执行核(WP-F 第二阶段):现货多头限价 no_fill/替换/结转、永续空头 3 倍(资金费、标记价强平)、篮子两腿走执行核、不带 order 块不变。 */
import { afterEach, describe, it, expect } from 'vitest';
import { validate, type StrategyIR } from '@trade-gate/contracts';
import { openStateDb } from '../../../../src/state-db.js';
import { ResearchStore } from '../../../../src/demo/research/store.js';
import { ResearchService } from '../../../../src/demo/research/service.js';
import { runBacktestReport, setAssetExecutor, DEFAULT_EXECUTION, type BarsLoader } from '../../../../src/demo/research/backtest-report.js';
import { registerBacktestRoutes } from '../../../../src/demo/research/backtest-routes.js';
import { orderExecutor } from '../../../../src/demo/research/orders/executor.js';
import { ORDERS_ENGINE_VERSION_V2 as ORDERS_ENGINE_VERSION, orderIntents, mirrorBars } from '../../../../src/demo/research/orders/index.js';
import { registry } from '../../../../src/demo/research/primitives/index.js';
import { orderGateFor, DEFAULT_ORDER_GATE, LEGACY_ORDER_GATE } from '../../../../src/demo/research/order-gate.js';
import { node, checkIR } from '../../../../src/demo/research/strategy.js';
import { emaIR } from '../backtest-report-fixtures.js';
import { data, perpLoader, shortIR } from './perp-fixture.js';
const clean: (() => void)[] = [];
afterEach(() => { clean.splice(0).forEach((f) => f()); setAssetExecutor(null); });
function env() { const db = openStateDb(':memory:'); clean.push(() => db.close()); const store = new ResearchStore(db.db); return { store, service: new ResearchService(store) }; }
const loader = (): BarsLoader => async (symbol, _tf, w) => { const b = data[symbol]; if (!b) throw Error('DATA_MISSING'); return { bars: b.filter((x) => x.open_time >= w.from_ms && x.close_time <= w.to_ms), source: 'synthetic' }; };
const meta = { session_id: 's1', inquiry_id: 'q1', question: 'orders', symbol: 'BTCUSDT' };
const W = { from_ms: Date.UTC(2022, 0, 1), to_ms: Date.UTC(2025, 1, 8) };
const rsiUp = node('indicator_threshold', { indicator: 'rsi', args: { period: 14 }, operator: 'above', threshold: 55 });
function spotIR(order: StrategyIR['order']): StrategyIR {
  return { version: 1, label: '限价回踩', description: 'RSI 上穿 55 后限价回踩;持有数天到数周,每 1000 根约数十个信号', signal: [rsiUp], entry: node('next_open_market', {}), risk: { stop: node('atr_stop', { atr_period: 14, multiple: 3 }), sizing: node('equal_notional', { max_allocation: '1' }) }, exit: [], order };
}
describe('全窗口回测 × 订单周期执行核', { timeout: 180000 }, () => {
  it('现货多头限价:有 no_fill、替换、结转;计划与统计进报告,过契约校验;回放返回 plans', async () => {
    const { store, service } = env();
    // 远限价(回撤 1.5 ATR)+ 长时效 → 未成交被新信号替换、到期 no_fill;成交后同向新信号 → 结转
    const ir = spotIR({ direction: 'long', market: 'spot', entry: { type: 'limit', price: node('atr_offset_level', { atr_period: 14, multiple: 1.5 }), expiry_bars: 12 }, take_profits: [{ source: node('indicator_level', { indicator: 'bbands', output: 'upper' }) }], min_rr: 0.5 });
    expect(checkIR(ir, '1d').ok).toBe(true);
    // 2026-09-27 执行层:本用例验证限价 no_fill/替换/结转的计划周期,与执行层无关;3×ATR 止损约 5.5–6.3% 超过执行层止损上限 5%、布林上轨止盈的净盈亏比多在 0.6–1.0,缺省阈值会把全部计划挡掉(stop_too_wide + min_net_rr),传 null,不按执行层挡单
    const r = await runBacktestReport({ store, service, loader: loader() }, { strategy_ir: ir, timeframe: '1d', ...W, meta, execution_thresholds: null });
    expect(validate('research-backtest', r).ok).toBe(true);
    expect(r.engine_version).toBe(ORDERS_ENGINE_VERSION);
    expect(r.execution).toMatchObject({ market: 'spot', leverage: 1, fee_rate: 0.001 });
    expect(r.execution.fill_model).toMatch(/订单周期执行核/);
    const btc = r.assets.find((a) => a.key === 'BTCUSDT')!;
    expect(btc.engine_version).toBe(ORDERS_ENGINE_VERSION);
    const st = btc.plan_stats!, statuses = new Set(btc.plans!.map((p) => p.status));
    expect(st.no_fill).toBeGreaterThan(0); expect(st.replaced).toBeGreaterThan(0); expect(st.filled).toBeGreaterThan(0);
    expect(statuses.has('no_fill') && statuses.has('replaced')).toBe(true);
    expect(st.fill_rate).toBeGreaterThan(0); expect(st.fill_rate).toBeLessThan(1);
    expect(btc.trades.every((t) => t.side === 'long')).toBe(true);
    expect(btc.metrics!.trades).toBe(btc.trades.length);
    expect(btc.segments.map((s) => s.name)).toEqual(['in_sample', 'out_of_sample']);
    // 结转:市价入场 + 频繁同向信号
    const roll = await runBacktestReport({ store, service, loader: loader() }, { strategy_ir: spotIR({ direction: 'long', market: 'spot', take_profits: [{ source: node('fixed_r_target', { r: 6 }) }], min_rr: 0 }), timeframe: '1d', ...W, meta, basket: false });
    const rb = roll.assets.find((a) => a.key === 'BTCUSDT')!;
    expect(rb.plan_stats!.rolled).toBeGreaterThan(0);
    const rolled = rb.plans!.find((p) => p.rolled_to)!; expect(rb.plans!.find((p) => p.id === rolled.rolled_to)!.rolled_from).toBe(rolled.id);
    // 回放路由对订单路径返回 plans
    const routes = new Map<string, Function>(), out: { status: number; body: any }[] = [];
    registerBacktestRoutes({ route: (m: string, p: string, h: Function) => routes.set(m + ' ' + p, h), json: (_r: unknown, status: number, body: unknown) => out.push({ status, body }), fail: (_r: unknown, status: number, message: string) => out.push({ status, body: { message } }) } as never, store, service, async () => null);
    await routes.get('GET /api/research/backtests/:id/replay')!({}, {}, new URL('http://x/api?asset=BTCUSDT'), { id: r.id });
    const replay = out.at(-1)!;
    expect(replay.status).toBe(200); expect(replay.body.plans.length).toBeGreaterThan(0);
    const lim = replay.body.plans.find((p: any) => p.entry_type === 'limit' && p.status === 'filled');
    expect(lim.entry_price).toBeGreaterThan(0); expect(lim.stop.price).toBeGreaterThan(0); expect(lim.take_profits.length).toBe(1);
  });
  it('永续空头 3 倍:K 线来自永续取数,资金费计入(正费率空头收到),标记价尖刺强平,溯源写明资金费分界,做空基准口径写进 warnings', async () => {
    const { store, service } = env(), calls: string[] = [];
    const ir = shortIR();
    expect(checkIR(ir, '1d').ok).toBe(true);
    const r = await runBacktestReport({ store, service, loader: async () => { throw Error('spot loader must not be used'); }, perpLoader: perpLoader({ calls }) }, { strategy_ir: ir, timeframe: '1d', ...W, meta });
    expect(validate('research-backtest', r).ok).toBe(true);
    expect(calls).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(r.execution).toMatchObject({ market: 'perp', leverage: 3, fee_rate: 0.0005 });
    const btc = r.assets.find((a) => a.key === 'BTCUSDT')!;
    expect(btc.data!.market).toBe('perp'); expect(btc.data!.perp!.instrument).toBe('BTC-USDT-SWAP');
    expect(btc.data!.perp!.funding_segments.map((s) => s.source)).toEqual(['binance_proxy', 'okx_archive']);
    expect(btc.data!.perp!.funding_note).toMatch(/币安代理.*OKX 月度归档/);
    expect(store.dataset(btc.data!.dataset_id!).symbol).toBe('BTC-USDT-SWAP'); expect(store.dataset(btc.data!.dataset_id!).market).toBe('perp');
    expect(btc.trades.length).toBeGreaterThan(3); expect(btc.trades.every((t) => t.side === 'short')).toBe(true);
    expect(btc.side_breakdown!.short.trades).toBe(btc.trades.length);
    const st = btc.plan_stats!;
    expect(st.funding_pnl!).toBeGreaterThan(0); expect(st.funding_periods!).toBeGreaterThan(0);
    expect(btc.plans!.filter((p) => p.filled_at).every((p) => p.leverage === 3 && p.market === 'perp' && p.liquidation_price! > p.fill_price!)).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/资金费分界/); expect(r.warnings.join('\n')).toMatch(/持有基准仍是买入持有/);
    // 同一策略、标记价在某根尖刺 60%:那根的在途空单按标记价强平,成交价 K 线本身没有触及止损
    const spikeRuns = [5, 40, 80, 120, 160, 200, 260, 300, 400];
    let liquidated = 0;
    for (const at of spikeRuns) {
      const x = await runBacktestReport({ store, service, perpLoader: perpLoader({ spikeAt: at }) }, { strategy_ir: ir, timeframe: '1d', ...W, meta, symbols: ['BTCUSDT'], basket: false });
      const a = x.assets[0]!; liquidated += a.plan_stats!.liquidated;
      if (a.plan_stats!.liquidated) { const p = a.plans!.find((q) => q.exit?.reason === 'liquidation')!; expect(p.pnl_pct!).toBeLessThan(-0.9); expect(a.plan_stats!.liquidation_loss!).toBeLessThan(0); expect(p.events.some((e) => e.kind === 'liquidated')).toBe(true); break; }
    }
    expect(liquidated).toBeGreaterThan(0);
  });
  it('做空的高周期结构方向门在镜像 K 线上判:每个做空计划那根,镜像结构都放行', () => {
    const bars = data.BTCUSDT!, regime = node('htf_structure_regime', { htf: '1d', swing_length: 3, require_bos: true });
    const ir = { ...shortIR(), regime };
    const { intents, notes } = orderIntents(ir, bars, 86400000, { fee_rate: '0.0005', slippage_bps: '5', from_index: 300, to_index: bars.length - 1 });
    expect(notes.join()).toMatch(/镜像/);
    const m = mirrorBars(bars), fired = intents.map((x, j) => (x ? 300 + j : -1)).filter((i) => i >= 0);
    expect(fired.length).toBeGreaterThan(0);
    for (const i of fired) { const w = m.slice(Math.max(0, i - 4999), i + 1); expect(registry.get('htf_structure_regime')!.compute({ bars: w, i: w.length - 1, timeframe_ms: 86400000, side: 'long' }, regime.params).pass).toBe(true); }
  });
  // 回测报告走 orderGateFor 缺省 = 结构口径,执行核记 research-orders-v2;旧口径(LEGACY_ORDER_GATE)的 2R 兜底只保留给显式传旧 gate 的调用方
  it('止盈来源算不出价位时:旧口径按 target_fallback_r 补一档、gate 没给兜底就不补;结构口径不补(不设止盈,交给追踪止损)', () => {
    const bars = Array.from({ length: 400 }, (_, i) => { const p = 2000 - i * 2 + (i % 10) * 3, t = Date.UTC(2022, 0, 1) + i * 86400000; return { open_time: t, close_time: t + 86399999, available_at: t + 86399999, open: String(p + 1), high: String(p + 4), low: String(p - 1), close: String(p), volume: '10' }; });
    const ir = { ...shortIR({ take_profits: [{ source: node('structure_target', { swing_length: 3 }) }] }), signal: [node('donchian_breakout', { lookback: 5, basis: 'close', direction: 'down' })] };
    const on = orderIntents(ir, bars, 86400000, { fee_rate: '0.0005', slippage_bps: '5', gate: LEGACY_ORDER_GATE, from_index: 300, to_index: 399 }).intents.filter(Boolean);
    const structure = orderIntents(ir, bars, 86400000, { fee_rate: '0.0005', slippage_bps: '5', gate: DEFAULT_ORDER_GATE, from_index: 300, to_index: 399 }).intents.filter(Boolean);
    expect(structure.length).toBeGreaterThan(0); expect(structure.every((x) => x!.take_profits.length === 0 && x!.min_stop_atr === 0.5)).toBe(true);
    const off = orderIntents(ir, bars, 86400000, { fee_rate: '0.0005', slippage_bps: '5', gate: { ...LEGACY_ORDER_GATE, target_fallback_r: 0 }, from_index: 300, to_index: 399 }).intents.filter(Boolean);
    expect(on.length).toBeGreaterThan(0);
    for (const x of on) { expect(x!.take_profits[0]!.note).toMatch(/fallback_r 2R/); expect(x!.take_profits[0]!.price).toBeCloseTo(x!.reference_price - 2 * (x!.stop!.price - x!.reference_price), 6); }
    expect(off.every((x) => x!.take_profits.length === 0)).toBe(true);
  });
  it('现货禁止做空/杠杆的校验保留;不带 order 块仍走 engine v4', async () => {
    const { store, service } = env();
    const bad = shortIR({ market: 'spot' });
    expect(checkIR(bad, '1d').checks.find((c) => c.name === 'order_block')!.ok).toBe(false);
    await expect(runBacktestReport({ store, service, loader: loader() }, { strategy_ir: bad, timeframe: '1d', ...W, meta })).rejects.toThrow(/order_block/);
    const r = await runBacktestReport({ store, service, loader: loader() }, { strategy_ir: emaIR(), timeframe: '1d', ...W, meta, basket: false });
    expect(r.engine_version).toBe('research-spot-ir-v5'); expect(r.assets[0]!.plans).toBeUndefined(); expect(r.execution.market).toBe('spot');
  });
  it('篮子两腿各半资金走执行核:篮子净值 = 两腿执行核净值之和', async () => {
    const { store, service } = env(), ir = shortIR();
    const r = await runBacktestReport({ store, service, perpLoader: perpLoader() }, { strategy_ir: ir, timeframe: '1d', ...W, meta });
    const basket = r.assets.find((a) => a.key === 'BTC+ETH')!;
    expect(basket.status).toBe('completed'); expect(basket.engine_version).toBe(ORDERS_ENGINE_VERSION);
    const legs = await Promise.all(['BTCUSDT', 'ETHUSDT'].map(async (sym) => {
      const asset = r.assets.find((a) => a.key === sym)!, d = store.dataset(asset.data!.dataset_id!), got = await perpLoader()(sym, '1d', { from_ms: d.bars[0]!.open_time, to_ms: d.bars.at(-1)!.close_time });
      // 2026-09-27 执行层:报告按冻结的阈值快照跑执行核,两腿复算必须用同一份快照(r.execution_gate.thresholds)才可比
      return orderExecutor({ symbol: sym, dataset: d, dataset_id: asset.data!.dataset_id!, ir, execution: { ...DEFAULT_EXECUTION, initial_cash: '5000' }, order_gate: { ...orderGateFor(ir), execution_thresholds: r.execution_gate!.thresholds }, timeframe: '1d', from_ms: basket.window!.from_ms, to_ms: basket.window!.to_ms, cache: new Map(), check: () => {}, fees: { taker: '0.0005', maker: '0.0002' }, perp: { mark: got.perp!.mark, funding: got.perp!.funding, tiers: got.perp!.tiers, max_lever: 100 } });
    }));
    expect(basket.equity.at(-1)!.equity).toBeCloseTo(legs[0]!.equity.at(-1)!.equity + legs[1]!.equity.at(-1)!.equity, 6);
    expect(basket.metrics!.trades).toBe(legs[0]!.trades.length + legs[1]!.trades.length);
  });
});
