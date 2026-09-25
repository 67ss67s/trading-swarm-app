// 批量研究:切段/资产池/基准/波动率目标/筛资产/冠军/Deflated Sharpe/随机入场可复现(合成数据,只做工程验证)
import { describe, expect, it } from 'vitest';
import { validate } from '@trading-swarm/contracts';
import { allVariants, irVariants } from '../../../../src/demo/research/batch/families.js';
import { sliceAsset, poolScore, volTargetEquity, evaluateIrVariant, trainValWindow, DAY, type AssetSlice } from '../../../../src/demo/research/batch/evaluate.js';
import { screenAssets, familyChampions, withDeflated, withGates, leaderboard, rowsFor, type BatchRow } from '../../../../src/demo/research/batch/study.js';
import { rankUniverse, looksExcluded } from '../../../../src/demo/research/batch/universe.js';
import { makeSegments } from '../../../../src/demo/research/improve/data.js';
import { EvalEnv, runPool, scoreSegment } from '../../../../src/demo/research/improve/evaluate.js';
import { randomEntryBaseline, forcedCandidate } from '../../../../src/demo/research/improve/random-entry.js';
import { checkIR, node, irCandidate } from '../../../../src/demo/research/strategy.js';
import { hash } from '../../../../src/demo/research/primitives.js';
import type { FrozenData } from '../../../../src/demo/research/improve/types.js';
import { universeBars, H4, SYMS } from '../improve/fixtures.js';

describe('资产池与策略族', () => {
  it('排除稳定币/包装币、缺永续、上市不足 85 天;按 90 天成交额排序且确定', () => {
    const r = rankUniverse([{ base: 'BTC', quote_volume_90d: 10, days: 90, has_swap: true }, { base: 'USDC', quote_volume_90d: 99, days: 90, has_swap: true }, { base: 'WBTC', quote_volume_90d: 50, days: 90, has_swap: true }, { base: 'NEW', quote_volume_90d: 80, days: 10, has_swap: true }, { base: 'XSTOCK', quote_volume_90d: 70, days: 90, has_swap: false }, { base: 'ETH', quote_volume_90d: 10, days: 90, has_swap: true }], { size: 5 });
    expect(r.members.map((m) => m.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(looksExcluded('FDUSD')).toBe(true); expect(looksExcluded('USDX')).toBe(true); expect(looksExcluded('SUI')).toBe(false);
  });
  it('全部变体过 checkIR / research-batch 契约;现货不做空、SMC 不做空;id 唯一', () => {
    const vs = allVariants();
    expect(new Set(vs.map((v) => v.id)).size).toBe(vs.length);
    for (const v of vs) {
      if (v.kind === 'ir') { const c = checkIR(v.ir, v.timeframe); expect(c.ok, v.id + ':' + c.checks.filter((x) => !x.ok).map((x) => x.name).join(',')).toBe(true); expect(v.ir.order!.market).toBe(v.market); }
      else expect(validate('research-batch', v.node)).toEqual({ ok: true });
    }
    expect(irVariants('spot', 'short', '1h')).toEqual([]);
    expect(irVariants('perp', 'short', '1h').some((v) => v.family === 'smc')).toBe(false);
    expect(irVariants('perp', 'long', '4h').every((v) => v.ir.order!.leverage === 1)).toBe(true);
  });
});

describe('切段与资产池指标', () => {
  const seg = { from_ms: 10 * DAY, to_ms: 20 * DAY - 1 };
  const samples = Array.from({ length: 30 }, (_, i) => ({ at: (i + 1) * DAY - 1, equity: 100 + i, exposure: i % 2, bench: 50 + i }));
  it('起点 = 段首前最后一点、只计段内成熟交易、资格要求回测起点 ≤ 段首', () => {
    const s = sliceAsset('X', samples, samples.map((x) => ({ at: x.at, equity: x.equity * 0.99 })), [{ entry_at: 9 * DAY + 5, exit_at: 10 * DAY, return_pct: 0.1, fees: 1 }, { entry_at: 15 * DAY, exit_at: 16 * DAY, return_pct: -0.05, fees: 1 }, { entry_at: 25 * DAY, exit_at: 26 * DAY, return_pct: 1, fees: 1 }], seg, 0);
    expect(s.eligible).toBe(true);
    expect(s.eq[0]).toBe(1); expect(s.eq.at(-1)).toBeCloseTo(119 / 109);
    expect(s.hold.at(-1)).toBeCloseTo(69 / 59);
    expect(s.trade_returns).toEqual([-0.05]);// 起点是段首前最后一点(第 10 天前最后一毫秒);在它之前入场的归上一段,段尾之后的不算
    expect(sliceAsset('X', samples, null, [], seg, 11 * DAY).eligible).toBe(false);
  });
  it('资产池 = 成员归一净值平均;不合格资产不进池;空头同敞口持有取负', () => {
    const a: AssetSlice = { symbol: 'BTCUSDT', eligible: true, days: [0, 1, 2], eq: [1, 1.1, 1.21], stress: [1, 1.09, 1.18], hold: [1, 1, 2], trades: 3, trade_returns: [0.1, 0.1, -0.1], exposure: 0.5, fees: 0 };
    const b: AssetSlice = { ...a, symbol: 'ETHUSDT', eq: [1, 0.9, 0.81], hold: [1, 1, 1] };
    const c: AssetSlice = { ...a, symbol: 'NEWUSDT', eligible: false, eq: [1, 5, 9] };
    const p = poolScore([a, b, c]);
    expect(p.members).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(p.total_return).toBeCloseTo((1.21 + 0.81) / 2 - 1);
    expect(p.hold_return).toBeCloseTo(0.5); expect(p.exposure_matched_hold).toBeCloseTo(0.25);
    expect(poolScore([a, b], -1).exposure_matched_hold).toBeCloseTo(-0.25);
    expect(p.btc_hold_return).toBeCloseTo(1);
    expect(p.expectancy).toBeCloseTo(1 / 30);
  });
  it('波动率目标:权重 1 时净值不变;权重 0.5 时持仓段收益减半、空仓段不动', () => {
    const bars = universeBars(400, H4)['BTCUSDT']!, step = H4;
    const s = [{ at: bars[300]!.close_time, equity: 100, exposure: 0, bench: null }, { at: bars[301]!.close_time, equity: 110, exposure: 1, bench: null }, { at: bars[302]!.close_time, equity: 120, exposure: 0, bench: null }, { at: bars[303]!.close_time, equity: 120, exposure: 0, bench: null }];
    volTargetEquity(s, bars, step, { annual: 100, days: 5 }).samples.forEach((x, i) => expect(x.equity).toBeCloseTo([100, 110, 120, 120][i]!, 9));
    const half = volTargetEquity(s, bars, step, { annual: 1e-9, days: 5 });// 目标极小 → w 极小
    expect(half.samples[2]!.equity).toBeCloseTo(100, 3);
    const w = [...half.weights.values()][0]!;
    expect(w).toBeGreaterThan(0); expect(w).toBeLessThan(1e-6);
  });
});

describe('汇总规则', () => {
  const sc = (sharpe: number | null, trades = 40) => ({ members: ['A'], trades, total_return: 0.1, sharpe, period_sharpe: sharpe === null ? null : sharpe / Math.sqrt(365), days: 300, skew: 0, kurtosis: 3, max_drawdown: 0.1, exposure: 0.5, expectancy: 0.01, win_rate: 0.5, stressed_return: 0.05, hold_return: 0.1, exposure_matched_hold: 0.05, btc_hold_return: 0.1 });
  const row = (id: string, family: BatchRow['family'], tr: number | null, va: number | null, trades = 40): BatchRow => ({ id, variant_id: id, family, param: 'p', market: 'spot', side: 'long', timeframe: '1h', scope: 'pool', train: sc(tr, trades), validation: sc(va) });
  it('每族冠军只看训练段;排行榜按验证段;Deflated 的试验数 = 行数;门槛四条', () => {
    const rows = [row('a', 'breakout', 1.0, -1), row('b', 'breakout', 0.5, 2), row('c', 'breakout', 3, 3, 10), row('d', 'smc', 0.2, 0.1)];
    const ch = familyChampions(rows);
    expect(ch.get('breakout')!.id).toBe('a');// c 训练段笔数不足,b 验证段更好但冠军不看验证段
    expect(familyChampions([...rows, { ...row('a@screen5', 'breakout', 9, 0), scope: 'screen5' }]).get('breakout')!.id).toBe('a');// 筛资产行不参评
    expect(leaderboard(rows).map((r) => r.id)).toEqual(['c', 'b', 'd', 'a']);
    const d = withGates(withDeflated(rows));
    expect(d.every((r) => r.deflated!.trials === 4)).toBe(true);
    expect(d.find((r) => r.id === 'b')!.promotable).toBe(true);
    const bad = withGates([{ ...rows[1]!, validation: { ...sc(2), stressed_return: -0.01 } }]);
    expect(bad[0]!.promotable).toBe(false);
  });
  it('训练段筛资产:≥5 笔且夏普 > 0,按夏普取前 5,确定', () => {
    const mk = (symbol: string, drift: number, trades = 10): AssetSlice => ({ symbol, eligible: true, days: [0, 1, 2, 3], eq: [1, 1 + drift, 1 + drift * 1.5, 1 + drift * 3], stress: [], hold: [1, 1, 1, 1], trades, trade_returns: [], exposure: 1, fees: 0 });
    const slices = [mk('A', 0.01), mk('B', 0.05), mk('C', -0.02), mk('D', 0.03, 2), mk('E', 0.02), mk('F', 0.04), mk('G', 0.015), mk('H', 0.012)];
    expect(screenAssets(slices)).toEqual(screenAssets([...slices].reverse()));
    expect(screenAssets(slices)).not.toContain('C'); expect(screenAssets(slices)).not.toContain('D');
    expect(screenAssets(slices)).toHaveLength(5);
    const rows = rowsFor({ variant_id: 'v', family: 'breakout', param: 'p', market: 'spot', side: 'long', timeframe: '1h' }, slices, slices, 1);
    expect(rows.map((r) => r.scope)).toEqual(['pool', 'screen5']);
    expect(rows[1]!.validation.members).toHaveLength(5);
  });
});

describe('随机入场的强制候选与 irCandidate 同口径', () => {
  it('pivot_target(结构口径缺省止盈)照样给出目标价;信号成立时与 irCandidate 逐位一致', () => {
    const bars = universeBars(700, H4)['BTCUSDT']!, ir = { version: 1 as const, label: 'x', description: 'x', signal: [node('indicator_threshold', { indicator: 'rsi', args: { period: 14 }, operator: 'above', threshold: 0 })], entry: node('next_open_market', {}), risk: { stop: node('atr_stop', { atr_period: 14, multiple: 2 }), sizing: node('equal_notional', { max_allocation: '1' }) }, exit: [node('pivot_target', { swing_length: 3 }), node('chandelier_trail', { atr_period: 22, multiple: 3 })] };
    let withTarget = 0;
    for (let i = 320; i < 700; i += 7) {
      const ctx = { bars: bars.slice(0, i + 1), i, timeframe_ms: H4 }, f = forcedCandidate(ir, ctx), c = irCandidate(ir, ctx);
      expect(f.entry?.stop).toBe(c.entry?.stop); expect(f.entry?.target ?? null).toBe(c.entry?.target ?? null);
      if (f.entry?.target) withTarget++;
    }
    expect(withTarget).toBeGreaterThan(0);
  });
});

describe('端到端(合成 4h):训练 + 验证连续一次跑、切段口径与随机入场可复现', () => {
  const bars = universeBars(1600, H4);
  const data: FrozenData = { universe: SYMS, timeframe: '4h', timeframe_ms: H4, assets: SYMS.map((s) => ({ symbol: s, dataset_id: 'x' + s, bars: bars[s]! })), segments: makeSegments(bars['BTCUSDT']!, bars['BTCUSDT']![0]!.close_time), warmup_bars: 300 };
  const v = irVariants('spot', 'long', '4h').find((x) => x.id.startsWith('breakout:dc20_ch3'))!;
  it('训练/验证两段互不重叠、验证段没有留出段的数据;重跑逐位一致', async () => {
    const s = data.segments, env = new EvalEnv(data);
    expect(s.train.to_ms).toBeLessThan(s.validation.from_ms); expect(s.validation.to_ms).toBeLessThan(s.holdout.from_ms);
    const a = await evaluateIrVariant(env, v.ir, trainValWindow(s), { train: s.train, validation: s.validation });
    const b = await evaluateIrVariant(new EvalEnv(data), v.ir, trainValWindow(s), { train: s.train, validation: s.validation });
    expect(a.slices).toEqual(b.slices);
    for (const x of a.slices.validation!) expect(x.days.at(-1)! * DAY).toBeLessThanOrEqual(s.validation.to_ms);
    const p = poolScore(a.slices.train!);
    expect(p.members).toEqual(SYMS); expect(p.trades).toBeGreaterThan(0);
    // 截掉留出段的数据,训练 + 验证结果不变(不偷看留出段)
    const cut: FrozenData = { ...data, assets: data.assets.map((x) => ({ ...x, bars: x.bars.filter((b) => b.close_time <= s.validation.to_ms) })) };
    const c = await evaluateIrVariant(new EvalEnv(cut), v.ir, trainValWindow(s), { train: s.train, validation: s.validation });
    expect(c.slices).toEqual(a.slices);
  }, 120000);
  it('订单执行核的随机入场基线:同种子逐位一致、换种子不同、笔数与策略同量级', async () => {
    const s = data.segments, env = new EvalEnv(data), key = hash(v.ir);
    const champ = scoreSegment('validation', await runPool(env, v.ir, key, s.validation), s.validation);
    const r1 = await randomEntryBaseline(env, v.ir, key, s.validation, champ, { runs: 4, seed: 3 });
    const r2 = await randomEntryBaseline(new EvalEnv(data), v.ir, key, s.validation, champ, { runs: 4, seed: 3 });
    const r3 = await randomEntryBaseline(env, v.ir, key, s.validation, champ, { runs: 4, seed: 4 });
    expect(r1).not.toBeNull();
    expect(r1!.ledger.returns).toEqual(r2!.ledger.returns);
    expect(r3!.ledger.returns).not.toEqual(r1!.ledger.returns);
    const mean = r1!.ledger.trades.reduce((x, y) => x + y, 0) / 4;
    expect(mean).toBeGreaterThan(champ.trades * 0.3); expect(mean).toBeLessThan(champ.trades * 3 + 3);
  }, 120000);
});
