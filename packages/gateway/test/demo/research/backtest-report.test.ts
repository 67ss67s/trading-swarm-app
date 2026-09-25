import { afterEach, describe, it, expect } from 'vitest';
import { validate, type ResearchBar } from '@trading-swarm/contracts';
import { openStateDb } from '../../../src/state-db.js';
import { ResearchStore } from '../../../src/demo/research/store.js';
import { ResearchService } from '../../../src/demo/research/service.js';
import { runBacktestReport, getBacktestReport, listBacktestReports, engineExecutor, tradingRange, DEFAULT_EXECUTION, WARMUP_BARS, type BarsLoader } from '../../../src/demo/research/backtest-report.js';
import { registerBacktestRoutes } from '../../../src/demo/research/backtest-routes.js';
import { onBacktestReport } from '../../../src/demo/research/hooks.js';
import { runReplay, FAST_ENGINE_MARK } from '../../../src/demo/research/engine.js';
import { SpotLedger } from '../../../src/demo/research/ledger.js';
import { DEFAULT_ORDER_GATE, LEGACY_ORDER_GATE, orderGateFor } from '../../../src/demo/research/order-gate.js';
import { STRATEGY_SPEC_VERSION } from '../../../src/demo/research/strategy-spec.js';
import { hash } from '../../../src/demo/research/primitives.js';
import { node } from '../../../src/demo/research/strategy.js';
import { synthBars, emaIR } from './backtest-report-fixtures.js';
import { fixture, params, study } from './fixtures.js';
const DAY = 86400000, clean: (() => void)[] = [];
afterEach(() => clean.splice(0).forEach((f) => f()));
function env() {
  const db = openStateDb(':memory:'); clean.push(() => db.close());
  const store = new ResearchStore(db.db); return { db, store, service: new ResearchService(store) };
}
const data: Record<string, ResearchBar[]> = { BTCUSDT: synthBars(1500, DAY, 7, Date.UTC(2021, 0, 1)), ETHUSDT: synthBars(1500, DAY, 99, Date.UTC(2021, 0, 1), 50) };
const loader = (bars = data, calls: string[] = []): BarsLoader => async (symbol, _tf, w) => { calls.push(symbol); const b = bars[symbol]; if (!b) throw Error('DATA_MISSING:no_' + symbol); return { bars: b.filter((x) => x.open_time >= w.from_ms && x.close_time <= w.to_ms), source: 'synthetic' }; };
const meta = { session_id: 's1', inquiry_id: 'q1', question: 'EMA 交叉', symbol: 'BTCUSDT' };
const W = { from_ms: Date.UTC(2022, 0, 1), to_ms: Date.UTC(2025, 1, 8) };
describe('全窗口多资产回测报告', { timeout: 120000 }, () => {
  it('全窗口 + 70/30 分段 + 三条序列(BTC / ETH / BTC+ETH),报告过契约校验并落库', async () => {
    const { store, service } = env();
    const r = await runBacktestReport({ store, service, loader: loader() }, { strategy_ir: emaIR(), timeframe: '1d', ...W, meta });
    expect(validate('research-backtest', r).ok).toBe(true);
    expect(r.engine_version).toBe('research-spot-ir-v5'); // 09-23 结构口径:报告缺省 order_gate 带 min_stop_atr
    expect(r.assets.map((a) => [a.key, a.kind, a.status])).toEqual([['BTCUSDT', 'single', 'completed'], ['ETHUSDT', 'single', 'completed'], ['BTC+ETH', 'basket', 'completed']]);
    // 窗口起点前有 365 根可借 ≥ 统一预热 300 根:交易从窗口起点开始,到最后一根已收盘 bar
    const btc = r.assets[0]!;
    expect(btc.data!.warmup_borrowed).toBe(true);
    expect(r.window.from_ms).toBe(W.from_ms + DAY - 1);
    expect(r.window.to_ms).toBeLessThanOrEqual(W.to_ms);
    const split = r.window.from_ms + Math.floor((r.window.to_ms - r.window.from_ms) * 0.7);
    expect(r.segments).toEqual([{ name: 'in_sample', from_ms: r.window.from_ms, to_ms: split }, { name: 'out_of_sample', from_ms: split + 1, to_ms: r.window.to_ms }]);
    for (const a of r.assets) {
      expect(a.segments.map((s) => s.name)).toEqual(['in_sample', 'out_of_sample']);
      expect(a.equity.length).toBeLessThanOrEqual(1000);
      expect(a.equity[0]!.benchmark_pct).toBe(0);
      expect(a.trades.every((t) => t.segment === (t.entry_at <= split ? 'in_sample' : 'out_of_sample'))).toBe(true);
      expect(a.metrics!.trades).toBe(a.trades.length);
      expect(a.yearly_returns.map((y) => y.period)).toEqual(['2022', '2023', '2024', '2025']);
    }
    expect(btc.metrics!.trades).toBeGreaterThan(0);
    expect(r.execution.fill_model).toMatch(/O→H→L→C/); expect(r.execution.basket_weighting).toMatch(/50\/50/);
    expect(getBacktestReport(store, r.id)).toEqual(r);
    const [summary] = listBacktestReports(store);
    expect(summary!.id).toBe(r.id); expect(summary!.sparkline.length).toBeLessThanOrEqual(120);
    expect(summary!.sparkline.at(-1)).toBeCloseTo(btc.equity.at(-1)!.pnl_pct, 12);
    // 原始 K 线引用:回放取 candles 用
    expect(store.dataset(btc.data!.dataset_id!).bars.length).toBe(btc.data!.bars);
  });
  it('A/B 两个策略共用同一窗口、同一分段、同一持有基准', async () => {
    const { store, service } = env();
    const b = emaIR(); b.signal = [node('ema_cross', { fast: 30, slow: 120 })];
    const [ra, rb] = [await runBacktestReport({ store, service, loader: loader() }, { strategy_ir: emaIR(), timeframe: '1d', ...W, meta }), await runBacktestReport({ store, service, loader: loader() }, { strategy_ir: b, timeframe: '1d', ...W, meta })];
    expect(rb.window).toEqual(ra.window); expect(rb.segments).toEqual(ra.segments);
    for (const k of ['BTCUSDT', 'ETHUSDT', 'BTC+ETH']) {
      const x = ra.assets.find((a) => a.key === k)!, y = rb.assets.find((a) => a.key === k)!;
      expect(y.metrics!.benchmark_return).toBe(x.metrics!.benchmark_return);
      expect(y.equity.map((e) => e.benchmark_pct).at(-1)).toBe(x.equity.map((e) => e.benchmark_pct).at(-1));
    }
  });
  it('借不到统一预热时所有策略用同一固定起点(首根 + 300 根)', () => {
    const bars = synthBars(800, DAY, 3, Date.UTC(2022, 0, 1));
    const a = tradingRange(bars, { from_ms: Date.UTC(2021, 0, 1), to_ms: Date.UTC(2030, 0, 1) }, 51)!, b = tradingRange(bars, { from_ms: Date.UTC(2021, 0, 1), to_ms: Date.UTC(2030, 0, 1) }, 250)!;
    expect(a.start).toBe(WARMUP_BARS); expect(b.start).toBe(WARMUP_BARS); expect(a.borrowed).toBe(false);
    const long = tradingRange(bars, { from_ms: Date.UTC(2021, 0, 1), to_ms: Date.UTC(2030, 0, 1) }, 400)!;
    expect(long.start).toBe(400); expect(long.warning).toMatch(/超过统一预热/);
  });
  it('篮子净值 = 两腿(各半资金)之和,基准同为 50/50 持有', async () => {
    const { store, service } = env();
    const r = await runBacktestReport({ store, service, loader: loader() }, { strategy_ir: emaIR(), timeframe: '1d', ...W, meta });
    const basket = r.assets.find((a) => a.key === 'BTC+ETH')!;
    const legs = await Promise.all(['BTCUSDT', 'ETHUSDT'].map(async (sym) => {
      const asset = r.assets.find((a) => a.key === sym)!, d = store.dataset(asset.data!.dataset_id!);
      const out = await engineExecutor({ symbol: sym, dataset: d, dataset_id: asset.data!.dataset_id!, ir: emaIR(), execution: { ...DEFAULT_EXECUTION, initial_cash: '5000' }, order_gate: orderGateFor(emaIR()), timeframe: '1d', from_ms: basket.window!.from_ms, to_ms: basket.window!.to_ms, cache: new Map(), check: () => {} });
      return out;
    }));
    const end = legs[0]!.equity.at(-1)!.equity + legs[1]!.equity.at(-1)!.equity;
    expect(basket.equity.at(-1)!.equity).toBeCloseTo(end, 6);
    expect(basket.metrics!.trades).toBe(legs[0]!.trades.length + legs[1]!.trades.length);
    const bBtc = r.assets[0]!.metrics!.benchmark_return!, bEth = r.assets[1]!.metrics!.benchmark_return!;
    expect(basket.metrics!.benchmark_return!).toBeCloseTo((bBtc + bEth) / 2, 9);
    // 逐资产贡献之和 = 篮子总收益;篮子同时持仓数在 0-2 之间
    expect(basket.per_symbol!.map((x) => x.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(basket.per_symbol!.reduce((a, x) => a + x.contribution, 0)).toBeCloseTo(basket.metrics!.total_return, 9);
    expect(basket.capital_usage!.avg_concurrent_positions).toBeGreaterThan(0); expect(basket.capital_usage!.avg_concurrent_positions).toBeLessThanOrEqual(2);
    expect(r.assets[0]!.side_breakdown!.long.trades).toBe(r.assets[0]!.metrics!.trades); expect(r.assets[0]!.side_breakdown!.short.trades).toBe(0);
    expect(r.assets[0]!.strategy_capacity!.capacity_usd).toBeGreaterThan(0);
    expect(Object.values(r.assets[0]!.trade_stats!.pnl_by_exit_reason!).reduce((a, x) => a + x.count, 0)).toBe(r.assets[0]!.metrics!.trades);
  });
  it('行情缺失:该资产 data_missing 并写原因,篮子随之 data_missing,不伪造', async () => {
    const { store, service } = env();
    const r = await runBacktestReport({ store, service, loader: loader({ BTCUSDT: data.BTCUSDT! }) }, { strategy_ir: emaIR(), timeframe: '1d', ...W, meta });
    expect(r.assets.map((a) => [a.key, a.status])).toEqual([['BTCUSDT', 'completed'], ['ETHUSDT', 'data_missing'], ['BTC+ETH', 'data_missing']]);
    expect(r.assets[1]!.error).toMatch(/ETHUSDT 行情获取失败/); expect(r.assets[1]!.metrics).toBeNull(); expect(r.assets[1]!.equity).toEqual([]);
  });
  it('主资产非 BTC/ETH 时排第一;同幂等键不重复计算;监听器回写 strategy_id', async () => {
    const { store, service } = env(), calls: string[] = [];
    const off = onBacktestReport(() => ({ strategy_id: 'st_1', strategy_version: 3 })); clean.push(off);
    const bars = { ...data, SOLUSDT: synthBars(1500, DAY, 5, Date.UTC(2021, 0, 1), 20) };
    const r = await runBacktestReport({ store, service, loader: loader(bars, calls) }, { strategy_ir: emaIR(), timeframe: '1d', ...W, meta: { ...meta, symbol: 'okx:spot:SOL-USDT' }, idempotency_key: 'q1:backtest' });
    expect(r.primary_key).toBe('SOLUSDT'); expect(r.assets.map((a) => a.key)).toEqual(['SOLUSDT', 'BTCUSDT', 'ETHUSDT', 'BTC+ETH']);
    expect(r.strategy_id).toBe('st_1'); expect(getBacktestReport(store, r.id)!.strategy_version).toBe(3);
    expect(listBacktestReports(store, { strategy_id: 'st_1' })).toHaveLength(1);
    const again = await runBacktestReport({ store, service, loader: loader(bars, calls) }, { strategy_ir: emaIR(), timeframe: '1d', ...W, meta, idempotency_key: 'q1:backtest' });
    expect(again.id).toBe(r.id); expect(calls).toHaveLength(3);
  });
});
describe('engine v4 执行与因果性', { timeout: 120000 }, () => {
  const ex = { initial_cash: '10000', risk_fraction: '0.01', max_allocation: '0.25', fee_rate: '0.001', slippage_bps: '5', qty_step: '0.00000001', min_notional: '5', max_opens_per_day: 10, sizing_mode: 'risk_fraction' as const };
  const req = (bars: ResearchBar[], from: number, to: number) => ({ idempotency_key: 'k', dataset_id: 'd', study_id: 's', strategy_ir: emaIR(), execution: ex, order_gate: DEFAULT_ORDER_GATE, spec_version: STRATEGY_SPEC_VERSION, from_ms: bars[from]!.close_time, to_ms: bars[to]!.close_time, arms: ['a_rules' as const], repeats: 1, max_model_calls: 0, timeout_ms: 600000, purpose: 'development' as const, acknowledge_adaptive_search: false });
  const ds = (bars: ResearchBar[]) => ({ venue: 'okx', market: 'spot' as const, symbol: 'BTCUSDT', timeframe_ms: 4 * 3600000, source: 'synthetic', retrieved_at: bars.at(-1)!.close_time + 1, bars });
  it('截断未来数据:截断点之前的决策、成交、净值逐字节不变', async () => {
    const bars = synthBars(2500, 4 * 3600000, 11), cut = 1800;
    const full = await runReplay(ds(bars), req(bars, 400, 2499), async () => { throw Error('x'); }, { fast: true });
    const part = await runReplay(ds(bars.slice(0, cut + 1)), req(bars, 400, cut), async () => { throw Error('x'); }, { fast: true });
    const a = full.arms[0]!, b = part.arms[0]!;
    expect(a.trades.length).toBeGreaterThan(3);
    const at = bars[cut]!.close_time;
    // 截断版最后一根是 terminal mark,不下新单;比较它之前的全部决策与已平仓成交
    expect(hash(b.decisions.slice(0, -1))).toBe(hash(a.decisions.filter((d) => d.at < at)));
    expect(hash(b.trades.filter((t) => t.exit_at < at))).toBe(hash(a.trades.filter((t) => t.exit_at < at)));
    expect(hash(b.equity)).toBe(hash(a.equity.filter((e) => e.at <= at)));
  });
  it('signal 记忆不改变结果(篮子腿复用单资产的记忆)', async () => {
    const bars = synthBars(1500, 4 * 3600000, 13), cache = new Map();
    const x = await runReplay(ds(bars), req(bars, 400, 1499), async () => { throw Error('x'); }, { fast: true, cache });
    const y = await runReplay(ds(bars), req(bars, 400, 1499), async () => { throw Error('x'); }, { fast: true, cache });
    const z = await runReplay(ds(bars), req(bars, 400, 1499), async () => { throw Error('x'); }, { fast: true });
    expect(hash(y.arms)).toBe(hash(x.arms)); expect(hash(z.arms)).toBe(hash(x.arms)); expect(cache.size).toBeGreaterThan(0);
  });
  it('Nautilus bar 路径:止损止盈同根触发,开盘靠近最高价先止盈,否则先止损;旧口径一律先止损', () => {
    const bar = (open: string, high: string, low: string) => ({ open_time: 0, close_time: 999, available_at: 999, open, high, low, close: '100', volume: '1' });
    const cfg = { ...ex, slippage_bps: '0', fee_rate: '0' };
    const run = (adaptive: boolean, b: ReturnType<typeof bar>) => { const l = new SpotLedger(cfg, adaptive ? { bar_path: 'adaptive' } : {}); l.pending = { action: 'enter', entry: { candidate_id: 'c', stop: '95', target: '110', reason: 'x' } }; l.step(b); return l.trades[0]!.reason; };
    expect(run(true, bar('108', '111', '94'))).toBe('target'); // 开盘离最高价近:O→H→L→C
    expect(run(true, bar('96', '111', '94'))).toBe('stop'); // 开盘离最低价近:O→L→H→C
    expect(run(false, bar('108', '111', '94'))).toBe('stop');
  });
  it('旧 manifest 走原口径:engine_version 与重放哈希不变;v4 标记的 run 也能零模型重放', async () => {
    const { store, service } = env();
    const d = fixture(), id = store.putDataset(d).id; store.putStudy(study(id));
    const brain = { name: 'stub', complete: async () => { throw Error('no model'); } }, identity = { kind: 'stub' as const, model: null, name: 'stub', configuration_hash: 'h' };
    const wait = async (rid: string) => { for (let i = 0; i < 400 && ['queued', 'running'].includes(store.get(rid)!.status); i++) await new Promise((r) => setTimeout(r, 25)); return store.get(rid)!; };
    const oldRow = await wait(service.start({ ...params(id), arms: ['a_rules'], max_model_calls: 0 }, brain, identity, null, '').id);
    expect(oldRow.result!.engine_version).toMatch(/v3$/);
    expect((await service.replay(oldRow.id)).verified).toBe(true);
    const fastRow = await wait(service.start({ ...params(id), idempotency_key: 'fast', arms: ['a_rules'], max_model_calls: 0, acknowledge_adaptive_search: true, spec_version: STRATEGY_SPEC_VERSION + FAST_ENGINE_MARK }, brain, identity, null, '').id);
    expect(fastRow.result!.engine_version).toBe('research-spot-ir-v5'); // 新 run 冻结结构口径 gate
    expect((await service.replay(fastRow.id)).verified).toBe(true);
    // 冻结旧 gate 的 v4 run(09-23 结构改造前)仍记 v4、零模型重放一致
    const legacyFast = await wait(service.start({ ...params(id), idempotency_key: 'fast-legacy', arms: ['a_rules'], max_model_calls: 0, acknowledge_adaptive_search: true, order_gate: { ...LEGACY_ORDER_GATE }, spec_version: 'strategy-spec/v1' + FAST_ENGINE_MARK }, brain, identity, null, '').id);
    expect(legacyFast.result!.engine_version).toBe('research-spot-ir-v4');
    expect((await service.replay(legacyFast.id)).verified).toBe(true);
  });
});
describe('回测报告路由', { timeout: 120000 }, () => {
  it('POST 同步算完返回 report_id;GET 详情 / 列表;404 与 400', async () => {
    const { store, service } = env(), routes = new Map<string, Function>(), out: { status: number; body: unknown }[] = [];
    const ctx = { route: (m: string, p: string, h: Function) => routes.set(m + ' ' + p, h), json: (_res: unknown, status: number, body: unknown) => out.push({ status, body }), fail: (_res: unknown, status: number, message: string) => out.push({ status, body: { message } }) } as never;
    let payload: unknown = null;
    registerBacktestRoutes(ctx, store, service, async () => payload);
    const call = async (key: string, params: Record<string, string> = {}, search = '') => { await routes.get(key)!({}, {}, new URL('http://x/api' + search), params); return out.at(-1)!; };
    // 路由默认走 OKX;测试里先把同一份合成数据存成数据集,POST 用 symbols 指到不存在的品种验证 400 路径,详情走 runBacktestReport 生成的报告
    const r = await runBacktestReport({ store, service, loader: loader() }, { strategy_ir: emaIR(), timeframe: '1d', ...W, meta });
    expect((await call('GET /api/research/backtests/:id', { id: r.id })).body).toEqual(r);
    expect((await call('GET /api/research/backtests/:id', { id: 'nope' })).status).toBe(404);
    const list = await call('GET /api/research/backtests', {}, '?limit=5');
    expect((list.body as { reports: { id: string }[] }).reports.map((x) => x.id)).toEqual([r.id]);
    payload = { timeframe: '1d' };
    expect((await call('POST /api/research/backtests')).status).toBe(400);
    payload = { strategy_ir: emaIR(), timeframe: '7x' };
    expect((await call('POST /api/research/backtests')).status).toBe(400);
  });
});
