/** 回测按实盘的执行层阈值挡单(2026-09-27)。覆盖:被挡的单不下、计数对得上、阈值在创建时存下来、旧记录重放结果不变、实盘候选生成不受影响。 */
import { afterEach, describe, it, expect } from 'vitest';
import { validate, type ResearchBar, type StrategyIR } from '@trade-gate/contracts';
import { openStateDb } from '../../../src/state-db.js';
import { ResearchStore } from '../../../src/demo/research/store.js';
import { ResearchService } from '../../../src/demo/research/service.js';
import { runBacktestReport, getBacktestReport, reportByKey, reportForRun, type BarsLoader } from '../../../src/demo/research/backtest-report.js';
import { runReplay } from '../../../src/demo/research/engine.js';
import { runPortfolio } from '../../../src/demo/research/portfolio.js';
import { buildUniverse } from '../../../src/demo/research/universe.js';
import { evaluateOrderGate, DEFAULT_ORDER_GATE, LEGACY_ORDER_GATE, orderGateFor } from '../../../src/demo/research/order-gate.js';
import { executionCheck, ExecutionTally, mergeExecutionGate, EXEC_GATE_VERSION } from '../../../src/demo/research/execution-gate.js';
import { DEFAULT_EXECUTION_THRESHOLDS, researchThresholds, stopGeometryReason, stopGeometry, type ExecutionThresholds } from '../../../src/demo/execution-policy.js';
import { simulateOrders, orderIntents, type OrderBar, type PlanIntent, type OrderExecParams } from '../../../src/demo/research/orders/index.js';
import { STRATEGY_SPEC_VERSION } from '../../../src/demo/research/strategy-spec.js';
import { node, policyToIR } from '../../../src/demo/research/strategy.js';
import { generateRunCandidate } from '../../../src/demo/strategy-run-orders.js';
import { SYNTH_POLICY } from '../../../src/demo/strategy-candidate.js';
import { synthBars, synthDataset, emaIR } from './backtest-report-fixtures.js';
import { fixture, params, study } from './fixtures.js';
const DAY = 86400000, H = 3600000, clean: (() => void)[] = [];
afterEach(() => clean.splice(0).forEach((f) => f()));
// 这些判定用例用的是 09-27 上午冻结的快照形态(百分比 0.3% 和 0.5×ATR 两条都判),老 run 重放就是这么判的;
// 新快照按模式折算(见下面「按模式冻结」那组)
const TH: ExecutionThresholds = { min_stop_pct: 0.3, max_stop_pct: 5, min_stop_atr: 0.5, min_net_rr: 1.5, round_trip_cost_bps: '12' };
const DEFAULT_SNAPSHOT = { min_stop_pct: 1, max_stop_pct: 5, min_stop_atr: 0, min_net_rr: 1.5, round_trip_cost_bps: '12' };
const LOOSE: ExecutionThresholds = { min_stop_pct: 0, max_stop_pct: 100, min_stop_atr: 0, min_net_rr: 0, round_trip_cost_bps: '0' };
const noModel = async (): Promise<never> => { throw Error('no model'); };
function db() { const d = openStateDb(':memory:'); clean.push(() => d.close()); return new ResearchStore(d.db); }

describe('executionCheck:与实盘同一套阈值', () => {
  // 正例的止损随周期放大(1h 0.8% / 4h 1.6% / 1d 3.2%),都 ≥0.5% 且 ≥0.5×ATR,目标 2R,扣 12bps 往返后净盈亏比仍 ≥1.5
  it.each([
    ['1h', 'long', 100, 99.2, 102, 1.0],
    ['4h', 'long', 100, 98.4, 103.2, 2.4],
    ['1d', 'long', 100, 96.8, 106.4, 5],
    ['4h', 'short', 100, 101.6, 96.8, 2.4],
  ] as const)('%s %s 止损 %s→%s 放行', (_tf, side, ref, stop, target, atr) => {
    expect(executionCheck(side, ref, stop, target, atr, TH)).toEqual({ blocks: [], reason: null });
  });
  it('四个原因各自命中;一个候选可以同时命中多条', () => {
    expect(executionCheck('long', 100, 99.8, 101, 0.3, TH).blocks).toEqual(['stop_distance']);
    expect(executionCheck('long', 100, 99.2, 102, 2.0, TH).blocks).toEqual(['stop_atr']);
    expect(executionCheck('long', 100, 94, 115, 5, TH).blocks).toEqual(['stop_too_wide']);
    // 不扣成本的盈亏比是 1.5,扣掉往返成本只剩 1.32,实盘会挡,这里也挡
    const rr = executionCheck('long', 100, 98.4, 102.4, 2.4, TH);
    expect(rr.blocks).toEqual(['min_net_rr']); expect(rr.reason).toMatch(/净盈亏比 1\.32 < 1\.5/);
    expect(executionCheck('long', 100, 99.8, 100.2, 1, TH).blocks).toEqual(['stop_distance', 'stop_atr', 'min_net_rr']);
  });
  it('没有止盈 = 净盈亏比不适用;ATR 缺失或 min_stop_atr=0 不判 ATR 下限', () => {
    expect(executionCheck('long', 100, 99.2, null, 1, TH).blocks).toEqual([]);
    expect(executionCheck('long', 100, 99.2, 102, null, TH).blocks).toEqual([]);
    expect(executionCheck('long', 100, 99.2, 102, 2.0, { ...TH, min_stop_atr: 0 }).blocks).toEqual([]);
  });
  it('ExecutionTally 按 symbol:at 去重(以最后一次为准),四原因分别计数,样例 ≤5;merge 全空 → null', () => {
    const t = new ExecutionTally(TH), bad = executionCheck('long', 100, 99.8, 100.2, 1, TH), ok = executionCheck('long', 100, 99.2, 102, 1, TH);
    t.add('BTCUSDT', 1, bad); t.add('BTCUSDT', 1, ok); // 候选估算被挡后入场又判一次过 → 只算一次、按放行
    for (let i = 2; i <= 8; i++) t.add('BTCUSDT', i, bad);
    const s = t.stats();
    expect(s).toMatchObject({ version: EXEC_GATE_VERSION, thresholds: TH, checked: 8, rejected: 7, rejected_by_execution: { stop_distance: 7, stop_atr: 7, stop_too_wide: 0, min_net_rr: 7 } });
    expect(s.examples).toHaveLength(5);
    expect(mergeExecutionGate([null, undefined])).toBeNull();
    const m = mergeExecutionGate([s, null, s])!;
    expect(m.checked).toBe(16); expect(m.rejected).toBe(14); expect(m.rejected_by_execution.min_net_rr).toBe(14); expect(m.examples).toHaveLength(5);
  });
});

describe('evaluateOrderGate:策略自己的检查先过才判执行层,而且只在决定下单时判', () => {
  const base = { side: 'long' as const, entry: '100', stop: '98.4', target: '102.4', costs: { fee_rate: '0.001', slippage_bps: '5' }, equity: '10000', qty: null };
  it('没有存阈值时输出和以前完全一样;成交那一刻不再判执行层', () => {
    const legacy = evaluateOrderGate({ ...base, params: DEFAULT_ORDER_GATE, atr: 2.4 });
    expect(legacy).not.toHaveProperty('execution'); expect(legacy.ok).toBe(true);
    const fill = evaluateOrderGate({ ...base, params: { ...DEFAULT_ORDER_GATE, execution_thresholds: TH } });
    expect(fill).toEqual(evaluateOrderGate({ ...base, params: DEFAULT_ORDER_GATE }));
  });
  it('有阈值时执行层的拒单原因写进 blocked_by;策略自己先挡了就不再判执行层', () => {
    const g = evaluateOrderGate({ ...base, params: { ...DEFAULT_ORDER_GATE, execution_thresholds: TH }, atr: 2.4 });
    expect(g.ok).toBe(false); expect(g.blocked_by).toEqual(['min_net_rr']); expect(g.execution!.blocks).toEqual(['min_net_rr']);
    const s = evaluateOrderGate({ ...base, stop: '99.9', params: { ...DEFAULT_ORDER_GATE, execution_thresholds: TH }, atr: 2.4 });
    expect(s.blocked_by).toEqual(['stop_too_close']); expect(s).not.toHaveProperty('execution');
  });
});

describe('engine 和 portfolio:被挡的不下单,计数对得上,阈值放到最宽时结果和以前一样', { timeout: 120000 }, () => {
  const d = synthDataset(1500, DAY), req = (order_gate: typeof DEFAULT_ORDER_GATE) => ({ idempotency_key: 'x', dataset_id: 'x', study_id: 'x', strategy_ir: emaIR(), execution: { initial_cash: '10000', risk_fraction: '0.01', max_allocation: '1', fee_rate: '0.001', slippage_bps: '5', qty_step: '0.00000001', min_notional: '5', max_opens_per_day: 10, sizing_mode: 'unit_notional' as const }, order_gate, spec_version: STRATEGY_SPEC_VERSION, from_ms: d.bars[400]!.close_time, to_ms: d.bars[1400]!.close_time, arms: ['a_rules' as const], repeats: 1, max_model_calls: 0, timeout_ms: 600000, purpose: 'development' as const, acknowledge_adaptive_search: false });
  const execBlocked = (arm: Awaited<ReturnType<typeof runReplay>>['arms'][0]) => arm.decisions.filter((x) => x.action === 'blocked' && x.gate_errors.some((e) => ['stop_distance', 'stop_atr', 'stop_too_wide', 'min_net_rr'].includes(e)));
  it('默认阈值下,日线 3 倍 ATR 的止损大约 5% 到 6%,都超过 5% 的上限,一笔都不下,被挡数等于被挡的决策数', async () => {
    const arm = (await runReplay(d, req({ ...DEFAULT_ORDER_GATE, execution_thresholds: TH }), noModel, { fast: true })).arms[0]!;
    const g = arm.execution_gate!;
    expect(arm.trades).toHaveLength(0); expect(g.checked).toBeGreaterThan(0); expect(g.rejected).toBe(g.checked);
    expect(g.rejected_by_execution.stop_too_wide).toBe(g.rejected); expect(execBlocked(arm)).toHaveLength(g.rejected);
  });
  it('只挡一部分时,被挡的那根之后没有入场,放行的照常下单', async () => {
    const arm = (await runReplay(d, req({ ...DEFAULT_ORDER_GATE, execution_thresholds: { ...TH, max_stop_pct: 5.8 } }), noModel, { fast: true })).arms[0]!, g = arm.execution_gate!;
    expect(g.rejected).toBeGreaterThan(0); expect(g.rejected).toBeLessThan(g.checked); expect(arm.trades.length).toBeGreaterThan(0);
    const blocked = execBlocked(arm); expect(blocked).toHaveLength(g.rejected);
    const entries = new Set(arm.trades.map((t) => t.entry_at));
    for (const b of blocked) { const i = d.bars.findIndex((x) => x.close_time === b.at); expect(entries.has(d.bars[i + 1]!.open_time)).toBe(false); }
  });
  it.each([['结构止损规则', DEFAULT_ORDER_GATE], ['09-23 前的规则', LEGACY_ORDER_GATE]] as const)('%s:阈值放到最宽时,除了多出 execution_gate,结果和不带阈值完全一样', async (_n, gate) => {
    const legacy = (await runReplay(d, req({ ...gate }), noModel, { fast: true })).arms[0]!, loose = (await runReplay(d, req({ ...gate, execution_thresholds: LOOSE }), noModel, { fast: true })).arms[0]!;
    expect(legacy).not.toHaveProperty('execution_gate');
    const { execution_gate, ...rest } = loose; expect(execution_gate!.rejected).toBe(0); expect(rest).toEqual(legacy);
  });
  it('portfolio 也一样:阈值很严时全挡并按资产计数,放到最宽时和以前一样', async () => {
    const store = db(), datasets = ['BTCUSDT', 'SOLUSDT'].map((symbol) => ({ ...fixture(), symbol })), members = datasets.map((data) => ({ data, id: store.putDataset(data).id }));
    const universe = buildUniverse({ symbols: ['BTCUSDT', 'SOLUSDT'], timeframe: '1h', from_ms: 1, to_ms: 2000000000000, market_factor: { kind: 'btc', symbols: ['BTCUSDT'] } }, members); store.putUniverse(universe);
    const { dataset_id: _, ...b } = params(), r = (order_gate: typeof DEFAULT_ORDER_GATE) => ({ ...b, universe_id: universe.id, arms: ['a_rules'] as ['a_rules'], order_gate });
    const legacy = (await runPortfolio({ universe, datasets }, r({ ...LEGACY_ORDER_GATE }), noModel)).arms[0]!, loose = (await runPortfolio({ universe, datasets }, r({ ...LEGACY_ORDER_GATE, execution_thresholds: LOOSE }), noModel)).arms[0]!;
    const { execution_gate, ...rest } = loose; expect(rest).toEqual(legacy); expect(execution_gate!.checked).toBeGreaterThan(0);
    const strict = (await runPortfolio({ universe, datasets }, r({ ...LEGACY_ORDER_GATE, execution_thresholds: { ...TH, min_net_rr: 5 } }), noModel)).arms[0]!;
    expect(strict.execution_gate!.rejected).toBe(strict.execution_gate!.checked); expect(strict.execution_gate!.rejected_by_execution.min_net_rr).toBe(strict.execution_gate!.rejected);
    expect(strict.trades).toHaveLength(0);
  });
});

describe('研究 run:创建时把阈值存进 manifest,重放用存下来的值', { timeout: 120000 }, () => {
  const brain = { name: 'stub', complete: async () => { throw Error('no model'); } }, identity = { kind: 'stub' as const, model: null, name: 'stub', configuration_hash: 'h' };
  it('创建时存下当前阈值,之后改设置不影响重放;同一请求还是同一个 run;传 null 就不挡;没接设置时用默认阈值', async () => {
    const store = db(), id = store.putDataset(fixture()).id; store.putStudy(study(id));
    let current: ExecutionThresholds = { min_stop_pct: 0.5, max_stop_pct: 4, min_stop_atr: 0.5, min_net_rr: 1.2, round_trip_cost_bps: '12' };
    const svc = new ResearchService(store, () => {}, { executionThresholds: () => current });
    const wait = async (rid: string) => { for (let i = 0; i < 400 && ['queued', 'running'].includes(store.get(rid)!.status); i++) await new Promise((r) => setTimeout(r, 25)); return store.get(rid)!; };
    const raw = { ...params(id), arms: ['a_rules'] as ['a_rules'], max_model_calls: 0 }, frozen = { ...current };
    const row = await wait(svc.start(raw, brain, identity, null, '').id);
    expect(row.status).toBe('completed');
    expect(row.manifest.request.order_gate!.execution_thresholds).toEqual(frozen);
    expect(row.result!.arms[0]!.execution_gate!.thresholds).toEqual(frozen);
    current = { ...current, min_net_rr: 4, max_stop_pct: 1 }; // workflow 改了:重放不读当前值
    expect((await svc.replay(row.id)).verified).toBe(true);
    expect(svc.start(raw, brain, identity, null, '').id).toBe(row.id); // 同一原始请求 → 同一 run(补字段不改 request_hash)
    const off = await wait(svc.start({ ...raw, idempotency_key: 'off', order_gate: { ...DEFAULT_ORDER_GATE, execution_thresholds: null } }, brain, identity, null, '').id);
    expect(off.manifest.request.order_gate!.execution_thresholds).toBeNull(); expect(off.result!.arms[0]).not.toHaveProperty('execution_gate');
    expect((await svc.replay(off.id)).verified).toBe(true);
    const plain = new ResearchService(store), dflt = await wait(plain.start({ ...raw, idempotency_key: 'default' }, brain, identity, null, '').id);
    // 默认是百分比模式:冻结成 1% 底线、ATR 下限记 0
    expect(dflt.manifest.request.order_gate!.execution_thresholds).toEqual(DEFAULT_SNAPSHOT);
  });
  it('以前的 manifest 没有阈值字段,重放结果不变,也不会多出 execution_gate', async () => {
    const store = db(), svc = new ResearchService(store), id = store.putDataset(fixture()).id; store.putStudy(study(id));
    const r = { ...params(id), arms: ['a_rules'] as ['a_rules'], order_gate: { ...DEFAULT_ORDER_GATE } }, row = store.create(r, null, identity, ''); // 直接调 store 不传阈值 = 旧 manifest 形态
    expect(row.manifest.request.order_gate).not.toHaveProperty('execution_thresholds');
    const out = await runReplay(fixture(), row.manifest.request, noModel, { diagnostics: true }); store.status(row.id, 'completed', out);
    expect(out.arms[0]).not.toHaveProperty('execution_gate'); expect((await svc.replay(row.id)).verified).toBe(true);
  });
});

describe('订单执行核:挂单前按执行层阈值判', () => {
  const T0 = Date.UTC(2026, 0, 1), bar = (i: number, p = 100): OrderBar => ({ open_time: T0 + i * H, close_time: T0 + (i + 1) * H - 1, open: p, high: p + 0.5, low: p - 0.5, close: p, volume: 1 });
  const bars = Array.from({ length: 6 }, (_, i) => bar(i));
  const intent = (stop: number, target: number, atr: number): PlanIntent => ({ side: 'long', reason: 't', entry: { type: 'market', price: null, source: null, note: '' }, reference_price: 100, expiry_bars: 3, stop: { price: stop, source: 'atr', note: '' }, take_profits: [{ price: target, size_pct: 1, source: 'rr', note: '' }], min_rr: null, atr });
  const P = (o: Partial<OrderExecParams> = {}): OrderExecParams => ({ symbol: 'BTCUSDT', market: 'spot', leverage: 1, timeframe_ms: H, initial_cash: 10000, taker_fee_rate: 0, maker_fee_rate: 0, slippage_bps: 0, ...o });
  it('0.2% 的止损被挡,记第一条原因;0.8% 的止损照常下单;不带阈值时和以前一样', () => {
    const its = [intent(99.8, 101, 0.3), null, null, intent(99.2, 102, 1), null, null];
    const r = simulateOrders(bars, its, P({ execution_thresholds: TH }));
    expect(r.plans.map((p) => [p.status, p.blocked_reason])).toEqual([['blocked', 'stop_distance'], [expect.any(String), null]]);
    expect(r.plans[1]!.filled_at).not.toBeNull();
    expect(r.execution_gate).toMatchObject({ checked: 2, rejected: 1, rejected_by_execution: { stop_distance: 1, stop_atr: 0, stop_too_wide: 0, min_net_rr: 0 } });
    expect(r.execution_gate!.examples![0]!.at).toBe(bars[0]!.close_time);
    const legacy = simulateOrders(bars, its, P());
    expect(legacy).not.toHaveProperty('execution_gate'); expect(legacy.plans[0]!.status).not.toBe('blocked');
  });
  it('多档止盈按仓位比例折成一个等效目标再算净盈亏比:30% 在 1R、70% 在 3R 等于 2.4R', () => {
    const two: PlanIntent = { ...intent(99, 101, 1), take_profits: [{ price: 101, size_pct: 0.3, source: 'rr', note: '' }, { price: 103, size_pct: 0.7, source: 'rr', note: '' }] };
    expect(simulateOrders(bars, [two, null, null, null, null, null], P({ execution_thresholds: TH })).execution_gate!.rejected).toBe(0);
    // 只看第一档(1R)的话扣完成本不到 1.5,会被挡
    expect(executionCheck('long', 100, 99, 101, 1, TH).blocks).toEqual(['min_net_rr']);
  });
  it('有阈值时意图里带上信号那根的 ATR;min_stop_atr 还是只在结构止损规则下才带', () => {
    const rb = synthBars(400, DAY), ir: StrategyIR = { ...emaIR(), order: { direction: 'long', market: 'spot' } };
    const first = (gate: typeof DEFAULT_ORDER_GATE) => orderIntents(ir, rb, DAY, { fee_rate: '0.001', slippage_bps: '5', gate }).intents.find((x) => x)!;
    const legacy = first({ ...LEGACY_ORDER_GATE }), withTh = first({ ...LEGACY_ORDER_GATE, execution_thresholds: TH });
    expect(legacy).not.toHaveProperty('atr'); expect(typeof withTh.atr).toBe('number'); expect(withTh).not.toHaveProperty('min_stop_atr');
    expect(first({ ...DEFAULT_ORDER_GATE, execution_thresholds: TH })).toEqual(first({ ...DEFAULT_ORDER_GATE }));
  });
});

describe('实盘候选生成不受影响', () => {
  it('orderGateFor 不带阈值;即使回测会挡,generateRunCandidate 照样给出候选,实盘的执行层在 gates.ts 里单独判', () => {
    const ir = policyToIR(SYNTH_POLICY); delete ir.compatibility;
    ir.order = { market: 'spot', direction: 'long', on_new_signal: { unfilled: 'replace', filled: 'ignore' }, take_profits: [{ source: node('fixed_r_target', { r: 50 }) }] };
    expect(orderGateFor(ir)).not.toHaveProperty('execution_thresholds'); expect(orderGateFor(null)).not.toHaveProperty('execution_thresholds');
    const T = Date.UTC(2026, 8, 1), ks = Array.from({ length: 801 }, (_, i) => { const p = i === 800 ? 103 : i % 2 ? 100.3 : 99.7, r = i === 800 ? 0.2 : 1; return { open_time: T + i * H, close_time: T + (i + 1) * H - 1, open: String(p), high: String(p + r), low: String(p - r), close: String(p), volume: i === 800 ? '300' : '100' }; });
    const c = generateRunCandidate({ shadow: { strategy_id: 's', version: 1, ir_hash: 'h', timeframe: '1h', ir, source: 'research_strategy_version', label: 'G4', unmapped: [], horizon_bars: 48, pick_note: '' }, symbol: 'BTCUSDT', klines: { '1h': ks }, now: T + 801 * H }).candidate!;
    expect(c).not.toBeNull();
    expect(executionCheck('long', c.entry_ref, c.stop, c.target, null, { ...TH, min_stop_pct: 50 }).blocks).toContain('stop_distance');
  });
});

describe('回测报告:阈值从哪来、存在哪、旧报告怎么读', { timeout: 120000 }, () => {
  const data: Record<string, ResearchBar[]> = { BTCUSDT: synthBars(1500, DAY, 7, Date.UTC(2021, 0, 1)), ETHUSDT: synthBars(1500, DAY, 99, Date.UTC(2021, 0, 1), 50) };
  const loader: BarsLoader = async (symbol, _tf, w) => ({ bars: data[symbol]!.filter((x) => x.open_time >= w.from_ms && x.close_time <= w.to_ms), source: 'synthetic' });
  const meta = { session_id: 's1', inquiry_id: 'q1', question: 'EMA', symbol: 'BTCUSDT' }, W = { from_ms: Date.UTC(2022, 0, 1), to_ms: Date.UTC(2025, 1, 8) };
  it('没接设置时用默认阈值;报告总数是各单资产相加,不算篮子;篮子有自己两条腿的合计', async () => {
    const store = db(), r = await runBacktestReport({ store, service: new ResearchService(store), loader }, { strategy_ir: emaIR(), timeframe: '1d', ...W, meta });
    expect(validate('research-backtest', r).ok).toBe(true);
    expect(r.execution_gate!.thresholds).toEqual(DEFAULT_SNAPSHOT);
    const [btc, eth, basket] = r.assets;
    expect(r.execution_gate!.checked).toBe(btc!.execution_gate!.checked + eth!.execution_gate!.checked);
    expect(r.execution_gate!.rejected).toBe(btc!.execution_gate!.rejected + eth!.execution_gate!.rejected);
    expect(btc!.metrics!.trades).toBe(0); expect(btc!.execution_gate!.rejected_by_execution.stop_too_wide).toBe(btc!.execution_gate!.checked);
    expect(basket!.kind).toBe('basket'); expect(basket!.execution_gate!.version).toBe(EXEC_GATE_VERSION);
  });
  it('接了设置时用设置里的阈值;传 null 就不挡,报告和各资产的 execution_gate 都是 null', async () => {
    const store = db(), th = { ...TH, max_stop_pct: 10 }, service = new ResearchService(store, () => {}, { executionThresholds: () => th });
    const r = await runBacktestReport({ store, service, loader }, { strategy_ir: emaIR(), timeframe: '1d', ...W, meta, basket: false });
    expect(r.execution_gate!.thresholds).toEqual(th); expect(r.assets[0]!.metrics!.trades).toBeGreaterThan(0);
    const off = await runBacktestReport({ store, service, loader }, { strategy_ir: emaIR(), timeframe: '1d', ...W, meta, basket: false, execution_thresholds: null });
    expect(off.execution_gate).toBeNull(); expect(off.assets.every((a) => a.execution_gate === null)).toBe(true);
    expect(off.warnings.some((w) => /没有按实盘的执行层阈值/.test(w))).toBe(true);
  });
  it('以前的报告没有 execution_gate,读出来当 null,不重新计算', async () => {
    const store = db(), r = await runBacktestReport({ store, service: new ResearchService(store), loader }, { strategy_ir: emaIR(), timeframe: '1d', ...W, meta, basket: false, idempotency_key: 'old', run_ids: ['run-old'] });
    const { execution_gate: _g, ...old } = r as unknown as Record<string, unknown>; old.assets = r.assets.map(({ execution_gate: _a, ...a }) => a);
    store.db.prepare('UPDATE research_backtests SET report_json=? WHERE id=?').run(JSON.stringify(old), r.id);
    for (const got of [getBacktestReport(store, r.id)!, reportByKey(store, 'old')!, reportForRun(store, 'run-old')!]) {
      expect(got.execution_gate).toBeNull(); expect(got.assets.every((a) => a.execution_gate === null)).toBe(true);
    }
  });
});

describe('按模式冻结:契约快照只有 5 个数,模式靠数值表达', { timeout: 120000 }, () => {
  it('百分比模式 ATR 下限记 0;ATR 模式百分比记 0,倍数按周期开根号折算;老快照原样返回', () => {
    expect(researchThresholds(DEFAULT_EXECUTION_THRESHOLDS, H)).toEqual(DEFAULT_SNAPSHOT);
    const atr = { ...DEFAULT_EXECUTION_THRESHOLDS, stop_floor_mode: 'atr' as const };
    expect(researchThresholds(atr, H)).toMatchObject({ min_stop_pct: 0, min_stop_atr: 1 });
    expect(researchThresholds(atr, 15 * 60000)).toMatchObject({ min_stop_pct: 0, min_stop_atr: 2 }); // 1×1h ≈ 2×15m
    expect(researchThresholds({ ...atr, stop_floor_atr_tf: '4h' }, H)).toMatchObject({ min_stop_atr: 2 });
    expect(researchThresholds({ ...atr, stop_floor_atr_tf: '15m' }, H)).toMatchObject({ min_stop_atr: 0.5 });
    expect(researchThresholds(TH, H)).toEqual(TH);
    expect(Object.keys(researchThresholds(atr, H)).sort()).toEqual(['max_stop_pct', 'min_net_rr', 'min_stop_atr', 'min_stop_pct', 'round_trip_cost_bps']);
  });
  it('周期换算保留正数下限,不会因舍入而关闭 ATR 检查', () => {
    const snap = researchThresholds({ ...DEFAULT_EXECUTION_THRESHOLDS, stop_floor_mode: 'atr', stop_floor_atr_tf: '15m', min_stop_atr: 0.01 }, DAY);
    expect(snap.min_stop_atr).toBeCloseTo(0.01 * Math.sqrt(15 / 1440), 12);
    expect(stopGeometry(100, 99.4, null, snap)).toMatchObject({ mode: 'atr', atr_fallback: true, blocks: ['stop_distance'] });
  });
  it('ATR 模式快照:只看 ATR 倍数,0.6% 的止损只要够 1×ATR 就放行;ATR 取不到改按 1% 判', () => {
    const snap = researchThresholds({ ...DEFAULT_EXECUTION_THRESHOLDS, stop_floor_mode: 'atr' }, H);
    // ATR 0.4 = 0.4%:止损 0.6% = 1.5×ATR 放行(百分比底线不管);0.3% = 0.75×ATR 按 stop_atr 挡
    expect(executionCheck('long', 100, 99.4, 101.5, 0.4, snap).blocks).toEqual([]);
    expect(executionCheck('long', 100, 99.7, 101.5, 0.4, snap).blocks).toEqual(['stop_atr']);
    const g = stopGeometry(100, 99.4, null, snap);
    expect(g).toMatchObject({ mode: 'atr', atr_fallback: true, blocks: ['stop_distance'] });
    expect(stopGeometryReason(g, snap)).toContain('ATR 不可用,改按百分比');
    expect(executionCheck('long', 100, 98.5, 103.5, null, snap).blocks).toEqual([]);
    // 百分比模式快照:ATR 再小也不判倍数
    expect(executionCheck('long', 100, 98.8, 103, 2, DEFAULT_SNAPSHOT).blocks).toEqual([]);
    expect(executionCheck('long', 100, 99.4, 101.5, 0.1, DEFAULT_SNAPSHOT).blocks).toEqual(['stop_distance']);
  });
  it('回测报告:设置是 ATR 模式时冻结折算后的倍数,并在警告里说明折算', async () => {
    const data: Record<string, ResearchBar[]> = { BTCUSDT: synthBars(1500, DAY, 7, Date.UTC(2021, 0, 1)) };
    const loader: BarsLoader = async (symbol, _tf, w) => ({ bars: data[symbol]!.filter((x) => x.open_time >= w.from_ms && x.close_time <= w.to_ms), source: 'synthetic' });
    const store = db(), th = { ...DEFAULT_EXECUTION_THRESHOLDS, stop_floor_mode: 'atr' as const, stop_floor_atr_tf: '4h' as const, min_stop_atr: 1, max_stop_pct: 10 };
    const service = new ResearchService(store, () => {}, { executionThresholds: () => th });
    const r = await runBacktestReport({ store, service, loader }, { strategy_ir: emaIR(), timeframe: '1d', from_ms: Date.UTC(2022, 0, 1), to_ms: Date.UTC(2025, 1, 8), meta: { session_id: 's1', inquiry_id: 'q1', question: 'EMA', symbol: 'BTCUSDT' }, basket: false });
    expect(validate('research-backtest', r).ok).toBe(true);
    // 1×4h ATR 折到日线 ≈ 0.41×1d ATR
    expect(r.execution_gate!.thresholds).toEqual({ min_stop_pct: 0, max_stop_pct: 10, min_stop_atr: Math.sqrt(4 / 24), min_net_rr: 1.5, round_trip_cost_bps: '12' });
    expect(r.warnings.some((w) => /1×4h ATR/.test(w) && /开根号/.test(w))).toBe(true);
  });
});
