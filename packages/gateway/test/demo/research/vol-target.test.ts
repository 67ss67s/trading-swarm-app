// 波动率目标仓位(vol_target sizing 原语,2026-09-23 晚):落进 StrategyIR / 执行核 / 改进环 / 编译。
// 第一段是旧口径钉子:vol_target 接入前实测的结构口径(DEFAULT_ORDER_GATE)结果哈希——不用 vol_target 的 IR 走 engine v5 快路径、
// 订单周期执行核(现货 + 永续)逐字节不变。哈希变了 = 旧 run 重放不再一致。
import { describe, it, expect } from 'vitest';
import type { ResearchRequest, StrategyIR } from '@trade-gate/contracts';
import { runReplay } from '../../../src/demo/research/engine.js';
import { runOrderPath } from '../../../src/demo/research/orders/index.js';
import { DEFAULT_ORDER_GATE, orderGateFor } from '../../../src/demo/research/order-gate.js';
import { hash } from '../../../src/demo/research/primitives.js';
import { node } from '../../../src/demo/research/strategy.js';
import { synthDataset } from './backtest-report-fixtures.js';
import { checkIR, compileStrategy, applySizingPhrases, volTargetValue } from '../../../src/demo/research/strategy.js';
import { registry } from '../../../src/demo/research/primitives/index.js';
import { realizedVolAt, volTargetWeight, volLookbackBars, VOL_TARGET_GRID } from '../../../src/demo/research/primitives/sizing.js';
import { realizedVol, volTargetEquity, evaluateIrVariant, poolScore, trainValWindow } from '../../../src/demo/research/batch/evaluate.js';
import { irVariants } from '../../../src/demo/research/batch/families.js';
import { EvalEnv } from '../../../src/demo/research/improve/evaluate.js';
import { makeSegments } from '../../../src/demo/research/improve/data.js';
import { sizingProposals, swapProposals } from '../../../src/demo/research/improve/generators/swap.js';
import { compileCheck } from '../../../src/demo/research/improve/runner.js';
import type { FrozenData } from '../../../src/demo/research/improve/types.js';
import { universeBars, H4, SYMS } from './improve/fixtures.js';

const STEP = 4 * 3600000;
const d = synthDataset(1200, STEP, 'BTCUSDT', 23);
/** 批量研究 ma_trend:ema20_100_vt 的 IR 形状(不含仓位层):EMA20 在 EMA100 上方入场、反穿离场、ATR×3 灾难止损、50R 远端兜底 */
export const maTrendIR = (sizing = node('equal_notional', { max_allocation: '1' }), market: 'spot' | 'perp' = 'spot'): StrategyIR => ({
  version: 1, label: 'ma_trend ema20_100', description: 'EMA20 在 EMA100 上方入场,反穿离场,ATR×3 灾难止损;持有数十根,每 1000 根约 10 个信号',
  signal: [node('indicator_cross', { indicator: 'ema', args: { period: 20 }, compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: 100 }, direction: 'above' })],
  entry: node('next_open_market', {}), risk: { stop: node('atr_stop', { atr_period: 14, multiple: 3 }), sizing },
  exit: [node('indicator_cross_exit', { indicator: 'ema', args: { period: 20 }, compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: 100 }, direction: 'cross_below' })],
  order: { direction: 'long', market, ...(market === 'perp' ? { leverage: 1 } : {}), take_profits: [{ source: node('fixed_r_target', { r: 50 }) }], min_rr: 0, on_new_signal: { unfilled: 'replace', filled: 'ignore' } },
});
const trailIR = (): StrategyIR => ({ version: 1, label: '突破', description: '唐奇安突破', signal: [node('donchian_breakout', { lookback: 20, basis: 'close' })], entry: node('next_open_market', {}), risk: { stop: node('pivot_stop', { swing_length: 3 }), sizing: node('equal_notional', { max_allocation: '1' }) }, exit: [node('chandelier_trail', { atr_period: 22, multiple: 3 }), node('pivot_target', { swing_length: 3 })] });
const req = (ir: StrategyIR): ResearchRequest => ({ idempotency_key: 'pin', dataset_id: 'pin', study_id: 'pin', strategy_ir: ir, execution: { initial_cash: '10000', risk_fraction: '0.01', max_allocation: '1', fee_rate: '0.001', slippage_bps: '5', qty_step: '0.00000001', min_notional: '5', max_opens_per_day: 10, sizing_mode: 'unit_notional' }, order_gate: { ...DEFAULT_ORDER_GATE }, from_ms: d.bars[300]!.close_time, to_ms: d.bars[1190]!.close_time, arms: ['a_rules'], repeats: 1, max_model_calls: 0, timeout_ms: 60000, purpose: 'development', acknowledge_adaptive_search: true, spec_version: 'strategy-spec/v2;engine=v4' }) as ResearchRequest;
const none = async () => { throw new Error('no model'); };
const armHash = (r: Awaited<ReturnType<typeof runReplay>>) => hash({ v: r.engine_version, s: r.status, arms: r.arms.map((a) => ({ m: a.metrics, t: a.trades, e: a.equity, d: a.decisions.map((x) => [x.at, x.action, x.reason, x.gate_errors, x.input_hash, x.decision_hash]) })) });
const orderRun = (ir: StrategyIR) => runOrderPath({ ir, bars: d.bars, timeframe_ms: STEP, symbol: 'BTCUSDT', from_index: 300, to_index: 1190, initial_cash: 10000, ...(ir.order?.market === 'perp' ? {} : { fee_rate: '0.001' }), slippage_bps: '5', gate: orderGateFor(ir, DEFAULT_ORDER_GATE) });
const orderHash = (o: ReturnType<typeof orderRun>) => hash({ v: o.engine_version, plans: o.plans, stats: o.stats, notes: o.notes, equity: o.equity, trades: o.trades });

describe('vol_target 接入前后,不用它的 IR 结果逐字节不变', () => {
  it('engine v5 快路径与订单执行核(现货/永续)的结果哈希钉住', async () => {
    const got: Record<string, string> = {};
    got.trail_v5 = armHash(await runReplay(d, req(trailIR()), none, { fast: true }));
    const { order: _o, ...noOrder } = maTrendIR();
    got.ma_trend_nonorder_v5 = armHash(await runReplay(d, req(noOrder), none, { fast: true }));
    got.orders_spot = orderHash(orderRun(maTrendIR()));
    got.orders_perp = orderHash(orderRun(maTrendIR(undefined, 'perp')));
    expect(got).toMatchInlineSnapshot(`
      {
        "ma_trend_nonorder_v5": "e52d5c76720a9d72d4284044550cb1f59c5e6bb48e9692c3ab2ed6bcc5eb418b",
        "orders_perp": "eb15aa41d6880fc85c81b9dbcc3f58b86af9b33c35ebdb02917f2707b5da1eca",
        "orders_spot": "718e10ff3f73906bc2aa711890a4d1196f0adfd9149447a444687be89fcf59e8",
        "trail_v5": "87371f75250b3b84b1eafe6627da361115facb61f1d1c8487fdad638bf012d06",
      }
    `);
  }, 120000);
});

// ── 以下是 vol_target 本身的行为 ──────────────────────────────────────────────

const vt = (target_vol: number, extra: Record<string, unknown> = {}) => node('vol_target', { target_vol, ...extra });

describe('vol_target 原语:注册、检查、σ 与批量层同式', () => {
  it('登记为 sizing 原语,checkIR 放行;参数越界、未知参数、资产池筛选策略判死;预热记 0', () => {
    const p = registry.get('vol_target')!;
    expect(p.category).toBe('sizing');
    expect(checkIR(maTrendIR(vt(0.5)), '4h').ok).toBe(true);
    expect(checkIR(maTrendIR(vt(0.3, { lookback_bars: 60 })), '4h').ok).toBe(true);
    for (const bad of [vt(0), vt(9), vt(0.5, { lookback_bars: 2 }), vt(0.5, { max_allocation: '1' })]) expect(checkIR(maTrendIR(bad), '4h').ok, JSON.stringify(bad)).toBe(false);
    const screened = { ...maTrendIR(vt(0.5)), universe: { screen: { top_n: 3 } } } as StrategyIR;
    expect(checkIR(screened, '4h').checks.find((c) => c.name === 'risk_bounds')!.ok).toBe(false);
    expect(p.warmup_bars({ target_vol: 0.5 }, STEP)).toBe(0); // 不拉长决策视图,信号与单位仓位同一批
    expect(volLookbackBars({}, STEP)).toBe(120); // 4h 缺省 20 天 = 120 根
    expect(volLookbackBars({}, 86400000)).toBe(20);
    expect(volLookbackBars({}, 60000)).toBe(4000); // 1m 缺省 28800 根,封顶 4000
  });
  it('σ 与批量层 realizedVol 逐位一致(4h 缺省回看 20 天);w = min(1, 目标/σ)', () => {
    let n = 0;
    for (let i = 100; i < 1150; i += 37) {
      const mine = realizedVolAt(d.bars, i, volLookbackBars({}, STEP), STEP), batch = realizedVol(d.bars, d.bars[i + 1]!.open_time, STEP, 20);
      expect(mine).toBe(batch);
      if (mine !== null) { n++; const w = volTargetWeight(d.bars, i, STEP, { target_vol: 0.3, lookback_bars: null }).weight; expect(w).toBeCloseTo(Math.min(1, 0.3 / mine), 12); }
    }
    expect(n).toBeGreaterThan(20);
    expect(volTargetWeight(d.bars, 50, STEP, { target_vol: 0.3, lookback_bars: null })).toMatchObject({ weight: 1, sigma: null }); // 历史不够 → 1
  });
});

describe('执行核按入场前 σ 缩放首腿仓位', () => {
  it('订单执行核:入场时点与单位仓位完全相同,每笔首腿保证金 = 入场前权益 × w,placed 事件写明 w', () => {
    const unit = orderRun(maTrendIR()), sized = orderRun(maTrendIR(vt(0.3)));
    const fu = unit.plans.filter((p) => p.filled_at !== null), fs = sized.plans.filter((p) => p.filled_at !== null);
    expect(fs.length).toBeGreaterThanOrEqual(3);
    expect(fs.map((p) => [p.filled_at, p.exit?.at, p.exit?.reason])).toEqual(fu.map((p) => [p.filled_at, p.exit?.at, p.exit?.reason]));
    const eqBefore = (at: number) => { let e = 10000; for (const x of sized.equity) if (x.at < at) e = x.equity; return e; };
    let scaled = 0;
    for (const p of fs) {
      const signal = d.bars.findIndex((b) => b.close_time === p.placed_at), w = volTargetWeight(d.bars, signal, STEP, { target_vol: 0.3, lookback_bars: null }).weight;
      expect(p.events[0]!.note).toContain('波动目标仓位 w=');
      if (w < 1) { scaled++; expect(p.margin!).toBeCloseTo(eqBefore(p.filled_at!) * w, 4); }
    }
    expect(scaled).toBeGreaterThan(0);
  });
  it('engine v5 快路径(不带订单块的 IR):入场时点不变,名义额度 = 可用资金 × w', async () => {
    const { order: _a, ...unitIR } = maTrendIR(), { order: _b, ...vtIR } = maTrendIR(vt(0.3));
    const u = (await runReplay(d, req(unitIR), none, { fast: true })).arms[0]!, v = (await runReplay(d, req(vtIR), none, { fast: true })).arms[0]!;
    expect(v.trades.length).toBeGreaterThanOrEqual(3);
    expect(v.trades.map((t) => t.entry_at)).toEqual(u.trades.map((t) => t.entry_at));
    expect(Number(v.metrics.avg_exposure)).toBeLessThan(Number(u.metrics.avg_exposure));
    const t0 = v.trades[0]!, i0 = d.bars.findIndex((b) => b.close_time === t0.entry_at - 1), w0 = volTargetWeight(d.bars, i0, STEP, { target_vol: 0.3, lookback_bars: null }).weight;
    expect(w0).toBeLessThan(1);
    expect(Number(t0.qty) * Number(t0.entry_price)).toBeCloseTo(10000 * w0, 2); // 第一笔:期初 10000 现金 × w
  });
});

describe('一致性:新原语(入场时定仓) vs 批量层 volTargetEquity(单位仓位净值事后缩放)', () => {
  const bars = universeBars(1600, H4);
  const data: FrozenData = { universe: SYMS, timeframe: '4h', timeframe_ms: H4, assets: SYMS.map((s) => ({ symbol: s, dataset_id: 'x' + s, bars: bars[s]! })), segments: makeSegments(bars['BTCUSDT']!, bars['BTCUSDT']![0]!.close_time), warmup_bars: 300 };
  const v = irVariants('spot', 'long', '4h').find((x) => x.id === 'ma_trend:ema20_100_vt:spot:long:4h')!;
  it('ma_trend:ema20_100_vt 现货 4h:同一批交易,训练/验证两段资产池收益差 < 0.5 个百分点。差异来源:① 单位仓位首腿受「现金/(1+费率)」约束,事后缩放按它乘 w,入场定仓按权益乘 w;② 批量层只能从净值样本认持仓段,开仓当根就离场的单(整根内止损)没有敞口样本,批量层按 w=1 记,执行核照样按 w 缩;③ 敞口口径:批量层 = 单位敞口 × w 常数,执行核按盯市算(持仓涨了占比变大)', async () => {
    const s = data.segments, segs = { train: s.train, validation: s.validation }, target = { annual: 0.3, days: 20 };
    const batch = await evaluateIrVariant(new EvalEnv(data), v.ir, trainValWindow(s), segs, { vol_target: target });
    const ir = { ...v.ir, risk: { ...v.ir.risk, sizing: vt(0.3) } };
    const mine = await evaluateIrVariant(new EvalEnv(data), ir, trainValWindow(s), segs);
    for (const k of ['train', 'validation'] as const) {
      const a = poolScore(batch.slices[k]!), b = poolScore(mine.slices[k]!);
      expect(b.trades).toBe(a.trades);
      expect(Math.abs(b.total_return - a.total_return)).toBeLessThan(0.005);
      expect(b.exposure).toBeCloseTo(a.exposure, 2);
    }
    // 单资产净值路径逐点对照:w=1 的交易两边逐位相同;w<1 的交易差异 ≤ 该笔名义值 × 费率量级
    const unit = await evaluateIrVariant(new EvalEnv(data), v.ir, trainValWindow(s), segs);
    expect(poolScore(unit.slices.validation!).trades).toBe(poolScore(mine.slices.validation!).trades);
  }, 120000);
  it('volTargetEquity 直接对单资产净值:与执行核逐点相对误差 < 0.3%', async () => {
    const unit = orderRun(maTrendIR()), sized = orderRun(maTrendIR(vt(0.3)));
    const samples = [{ at: d.bars[300]!.close_time - 1, equity: 10000, exposure: 0, bench: null }, ...unit.equity.map((e) => ({ at: e.at, equity: e.equity, exposure: e.exposure, bench: null }))];
    const scaled = volTargetEquity(samples, d.bars, STEP, { annual: 0.3, days: 20 }).samples.slice(1);
    expect(scaled.length).toBe(sized.equity.length);
    let worst = 0; for (let k = 0; k < scaled.length; k++) worst = Math.max(worst, Math.abs(scaled[k]!.equity / sized.equity[k]!.equity - 1));
    expect(worst).toBeLessThan(0.003);
  });
});

describe('改进环变异空间与编译', () => {
  it('没有 vol_target 的父策略:提议加 50/30/80%;有的:先提议去掉,再提议网格里的其他值;都过零模型编译检查', () => {
    const add = sizingProposals(maTrendIR());
    expect(add.map((p) => p.ir.risk.sizing.params.target_vol)).toEqual([0.5, 0.3, 0.8]);
    expect(add.every((p) => p.diff[0]!.path === 'risk.sizing' && compileCheck(p.ir, '4h').ok)).toBe(true);
    const has = sizingProposals(maTrendIR(vt(0.5, { lookback_bars: 60 })));
    expect(has.map((p) => [p.ir.risk.sizing.primitive, p.ir.risk.sizing.params.target_vol ?? null, p.ir.risk.sizing.params.lookback_bars ?? null])).toEqual([['equal_notional', null, null], ['vol_target', 0.3, 60], ['vol_target', 0.8, 60]]);
    expect(has.every((p) => compileCheck(p.ir, '4h').ok)).toBe(true);
    expect([...VOL_TARGET_GRID]).toEqual([0.3, 0.5, 0.8]);
    expect((swapProposals(maTrendIR(), '4h')[0]!.evidence as { section: string }).section).toBe('sizing');
  });
  it('原话 → vol_target:说了才加(带目标值就按原话),没说而模型加了就退回 equal_notional', () => {
    const ir = () => maTrendIR() as unknown as Record<string, unknown>;
    const cases: [string, number | null][] = [['4h EMA20/100 均线趋势,波动率目标 30%', 0.3], ['按波动调仓位,EMA 金叉做多', 0.5], ['均线趋势 vol target 0.8', 0.8], ['仓位按波动率缩放,目标年化波动 40', 0.4], ['EMA 金叉做多 死叉离场', null]];
    for (const [text, want] of cases) {
      const x = ir(); applySizingPhrases(text, x);
      const s = (x.risk as StrategyIR['risk']).sizing;
      expect(want === null ? s.primitive : [s.primitive, s.params.target_vol], text).toEqual(want === null ? 'equal_notional' : ['vol_target', want]);
    }
    const model = maTrendIR(vt(0.5)) as unknown as Record<string, unknown>, notes = applySizingPhrases('EMA 金叉做多 死叉离场', model);
    expect((model.risk as StrategyIR['risk']).sizing.primitive).toBe('equal_notional'); expect(notes[0]).toContain('没有提波动率目标');
    expect(volTargetValue('波动率目标 30%')).toBe(0.3); expect(volTargetValue('波动率目标')).toBe(null);
  });
  it('compileStrategy 端到端(stub 模型没写仓位):原话「波动率目标 30%」编出 vol_target,规范无 block', async () => {
    const { risk, ...rest } = maTrendIR(), bare = { ...rest, risk: { stop: risk.stop } };
    const brain = { name: 'stub', complete: async () => ({ text: JSON.stringify({ ir: bare, unmapped: [] }), latency_ms: 0, model: 'stub', input_tokens: 0, output_tokens: 0 }) };
    const out = await compileStrategy({ text: 'BTC 4小时 EMA20 在 EMA100 上方做多,EMA20 下穿 EMA100 离场,ATR 3 倍止损,波动率目标 30%', timeframe: '4h' }, brain as never);
    expect(out.ok, JSON.stringify(out.checks)).toBe(true);
    expect(out.ir!.risk.sizing).toEqual(vt(0.3));
    expect(out.spec!.violations.filter((x) => x.severity === 'block')).toEqual([]);
    expect(out.rules!.find((r) => r.category === 'sizing')!.text).toContain('波动率目标');
    const plain = await compileStrategy({ text: 'BTC 4小时 EMA20 在 EMA100 上方做多,EMA20 下穿 EMA100 离场,ATR 3 倍止损', timeframe: '4h' }, { ...brain, complete: async () => ({ text: JSON.stringify({ ir: maTrendIR(vt(0.5)), unmapped: [] }), latency_ms: 0, model: 'stub', input_tokens: 0, output_tokens: 0 }) } as never);
    expect(plain.ir!.risk.sizing.primitive).toBe('equal_notional');
  });
});
