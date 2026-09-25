import { describe, expect, it } from 'vitest';
import { objectiveOf, plateauGate, trainGates, EvalEnv, runPool, scoreSegment, evaluateTrain, POOL_CASH } from '../../../../src/demo/research/improve/evaluate.js';
import { makeSegments } from '../../../../src/demo/research/improve/data.js';
import { DEFAULT_OBJECTIVE, type SegmentScore } from '../../../../src/demo/research/improve/types.js';
import { hash } from '../../../../src/demo/research/primitives.js';
import { emaIR, universeBars, START, H4, SYMS } from './fixtures.js';

const seg = (o: Partial<SegmentScore>): SegmentScore => ({ segment: 's', trades: 20, total_return: 0.1, sharpe: 1, max_drawdown: 0.1, exposure: 0.5, exposure_matched_hold: 0.05, stressed_return: 0.05, ...o });
describe('目标函数与门槛', () => {
  it('目标 = 各折夏普中位数 − 0.5×标准差;缺夏普按 0', () => {
    expect(objectiveOf([seg({ sharpe: 1 }), seg({ sharpe: 1 }), seg({ sharpe: 1 }), seg({ sharpe: 1 })], DEFAULT_OBJECTIVE)).toBeCloseTo(1, 12);
    const folds = [1, 2, 3, null].map((s) => seg({ sharpe: s }));
    const sd = Math.sqrt(((1 - 1.5) ** 2 + (2 - 1.5) ** 2 + (3 - 1.5) ** 2 + (0 - 1.5) ** 2) / 3);
    expect(objectiveOf(folds, DEFAULT_OBJECTIVE)).toBeCloseTo(1.5 - 0.5 * sd, 12);
    expect(objectiveOf(folds, { ...DEFAULT_OBJECTIVE, stability_penalty: 0 })).toBeCloseTo(1.5, 12);
  });
  it('门槛:每折笔数、总笔数、回撤、2 倍费率为正、跑赢同敞口持有', () => {
    const ok = trainGates(seg({ trades: 40 }), [12, 11, 10, 13].map((t) => seg({ trades: t })), DEFAULT_OBJECTIVE);
    expect(ok.every((g) => g.ok)).toBe(true);
    const bad = trainGates(seg({ trades: 29, max_drawdown: 0.4, stressed_return: -0.01, total_return: 0.04, exposure_matched_hold: 0.05 }), [9, 10, 10, 10].map((t) => seg({ trades: t })), DEFAULT_OBJECTIVE);
    expect(bad.filter((g) => !g.ok).map((g) => g.name)).toEqual(['min_trades_per_fold', 'min_trades_total', 'max_drawdown', 'stress_positive', 'beats_exposure_matched_hold']);
    expect(trainGates(seg({}), [], { ...DEFAULT_OBJECTIVE, require_stress_positive: false, require_beats_exposure_matched_hold: false }).map((g) => g.name)).not.toContain('stress_positive');
  });
  it('平台检验:邻域目标 ≥ ratio×目标才算平台;孤立尖峰淘汰;没有周期参数不适用', () => {
    expect(plateauGate(1, [{ label: 'a', objective: 0.8 }, { label: 'b', objective: 0.71 }], DEFAULT_OBJECTIVE).ok).toBe(true);
    expect(plateauGate(1, [{ label: 'a', objective: 0.8 }, { label: 'b', objective: 0.2 }], DEFAULT_OBJECTIVE)).toMatchObject({ ok: false, value: 0.2, threshold: expect.closeTo(0.7, 12) });
    expect(plateauGate(-1, [{ label: 'a', objective: -1.2 }], DEFAULT_OBJECTIVE)).toMatchObject({ ok: true, threshold: expect.closeTo(-1.3, 12) });
    expect(plateauGate(1, [], DEFAULT_OBJECTIVE).ok).toBe(true);
    expect(plateauGate(null, [], DEFAULT_OBJECTIVE).ok).toBe(false);
  });
});
describe('资产池评估', () => {
  it('等资金独立记账相加;持有基准、同敞口持有、2 倍费率压力、分折都算得出来', async () => {
    const data = universeBars(1500), assets = SYMS.map((s) => ({ symbol: s, dataset_id: s, bars: data[s]! }));
    const segments = makeSegments(data.BTCUSDT!, START + 300 * H4);
    const env = new EvalEnv({ universe: SYMS, timeframe: '4h', timeframe_ms: H4, assets, segments, warmup_bars: 300 });
    const ir = emaIR(), key = hash(ir), run = await runPool(env, ir, key, segments.train);
    expect(run.samples[0]!.equity).toBeCloseTo(POOL_CASH, 6);
    expect(run.per_asset.map((p) => p.initial)).toEqual([POOL_CASH / 3, POOL_CASH / 3, POOL_CASH / 3]);
    const last = run.samples.at(-1)!, sum = run.per_asset.reduce((a, p) => a + p.equity.at(-1)!.equity, 0);
    expect(last.equity).toBeCloseTo(sum, 6);
    const t = await evaluateTrain(env, ir, key, DEFAULT_OBJECTIVE);
    expect(t.folds).toHaveLength(4);
    expect(t.folds.reduce((a, f) => a + f.trades, 0)).toBe(t.train.trades);
    expect(t.train.stressed_return!).toBeLessThan(t.train.total_return);
    expect(t.train.exposure_matched_hold).toBeCloseTo(t.train.hold_return! * t.train.exposure, 12);
    expect(t.train.btc_hold_return).not.toBeNull();
    expect(t.train.per_asset!.map((p) => p.symbol)).toEqual(SYMS);
    // 分折首尾相接:各折收益连乘 = 训练段收益
    const chained = t.folds.reduce((a, f) => a * (1 + f.total_return), 1) - 1;
    expect(chained).toBeCloseTo(t.train.total_return, 8);
    // 同 IR 同窗口再跑一次逐位一致
    expect(scoreSegment('x', await runPool(env, ir, key, segments.train), segments.train)).toEqual(scoreSegment('x', run, segments.train));
  }, 60000);
});
