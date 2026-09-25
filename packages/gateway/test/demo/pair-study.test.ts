import { describe, it, expect } from 'vitest';
import { estimatePairModel, pairZ, PAIR_SIGNAL_REGISTRY, type PairModel, type PairSetup } from '../../src/demo/pair-signals.js';
import { settlePairLeg, simulatePairOutcome } from '../../src/demo/pair-outcome.js';
import { runPairStudy, PAIR_STUDY } from '../../src/demo/pair-study.js';
import { SIGNAL_REGISTRY } from '../../src/demo/strategy-signals.js';
import type { Kline } from '../../src/demo/types.js';
const model: PairModel = { alpha: 0, hedge_ratio: 1, mean: 0, variance: 0.01, phi: 0.9, half_life: 6.58, stable: true, train_n: 100 };
const bars = (price: number, n = 60): Kline[] => Array.from({ length: n }, (_, i) => ({ open_time: i * 3600000, close_time: (i + 1) * 3600000 - 1, open: String(price), close: String(price), high: String(price), low: String(price), volume: '100' }));
const setup: PairSetup = { at: 3599999, symbols: ['A', 'B'], hedge_ratio: 1, z: 2.5, direction: 'short_spread', legs: [{ symbol: 'A', direction: 'short' }, { symbol: 'B', direction: 'long' }] };
describe('离线相对价值预注册', () => {
  it('OLS恢复对数hedge并仅依赖训练输入；拒绝退化序列', () => {
    const b = Array.from({ length: 2000 }, (_, i) => String(Math.exp(3 + i * 0.001)));
    const a = b.map((v, i) => String(Math.exp(0.7 + 1.4 * Math.log(Number(v)) + 0.01 * Math.sin(i))));
    const m = estimatePairModel(a, b); expect(m.hedge_ratio).toBeCloseTo(1.4, 3); expect(m.alpha).toBeCloseTo(0.7, 2); expect(m.variance).toBeGreaterThan(0);
    expect(() => estimatePairModel(Array(60).fill('1'), Array(60).fill('1'))).toThrow();
    const before = JSON.stringify(m); pairZ(m, '100', '120'); expect(JSON.stringify(m)).toBe(before);
  });
  it('AR(1)稳定残差通过半衰期门，不把慢回归自动视为稳定', () => {
    let seed = 123; let residual = 0;
    const a: string[] = []; const b: string[] = [];
    for (let i = 0; i < 5000; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      residual = 0.8 * residual + (seed / 4294967296 - 0.5) * 0.01;
      const x = 3 + i * 0.0001; b.push(String(Math.exp(x))); a.push(String(Math.exp(0.4 + 1.2 * x + residual)));
    }
    const m = estimatePairModel(a, b); expect(m.stable).toBe(true); expect(m.phi).toBeCloseTo(0.8, 1);
    expect(m.half_life!).toBeGreaterThan(1); expect(m.half_life!).toBeLessThan(5);
  });
  it('冻结z、方向、稳定性和止损区域不新开；单腿族入口无信号', () => {
    expect(pairZ(model, String(100 * Math.exp(0.25)), '100')).toBeCloseTo(2.5);
    const c = { at: 0, symbols: ['A', 'B'] as const, closes: [String(100 * Math.exp(0.25)), '100'] as const, model };
    expect(PAIR_SIGNAL_REGISTRY.relative_value(c)?.direction).toBe('short_spread');
    expect(PAIR_SIGNAL_REGISTRY.relative_value({ ...c, model: { ...model, stable: false } })).toBeNull();
    expect(PAIR_SIGNAL_REGISTRY.relative_value({ ...c, closes: ['200', '100'] })).toBeNull();
    expect(SIGNAL_REGISTRY.relative_value({} as never)).toBeNull();
  });
  it('双腿零价格变化扣双向费滑点，funding按方向净额，倍费不放大收入', () => {
    const s = { bars: bars(100), funding: [{ at: 8 * 3600000, rate: '0.001' }] };
    const long = settlePairLeg(s, 1, 9, false, 1, 0.5); const short = settlePairLeg(s, 1, 9, false, -1, 0.5);
    expect(long.net + short.net).toBeCloseTo(-0.0012); expect(long.funding).toBeCloseTo(0.0005); expect(short.funding).toBeCloseTo(-0.0005);
    expect(settlePairLeg(s, 1, 9, false, -1, 0.5, 2).funding).toBeCloseTo(-0.0005);
    expect(settlePairLeg(s, 1, 9, false, 1, 0.5, 2).funding).toBeCloseTo(0.001);
    expect(settlePairLeg(s, 8, 9, false, -1, 0.5).funding).toBe(0);
    expect(settlePairLeg(s, 8, 9, false, 1, 0.5).funding).toBeCloseTo(0.0005);
  });
  it('z回零次根开盘出场，价格跳空按成交结算，延迟腿有单边暴露', () => {
    const a = { bars: bars(100), funding: [] }; const b = { bars: bars(100), funding: [] };
    a.bars[2]!.open = '90';
    const out = simulatePairOutcome(setup, model, a, b, 1);
    expect(out.reason).toBe('zero'); expect(out.exit_index).toBe(2); expect(out.gross).toBeCloseTo(0.05); expect(out.max_abs_net_exposure).toBeCloseTo(0.05);
    expect(simulatePairOutcome(setup, model, a, b, 1, 1, 1).max_abs_net_exposure).toBeGreaterThanOrEqual(0.5);
    b.bars[2]!.open = '110';
    const delayed = simulatePairOutcome(setup, model, a, b, 1, 1, 1);
    expect(delayed.legs[1]!.quantity).toBe(out.legs[1]!.quantity);
    expect(delayed.legs[1]!.gross).toBeCloseTo(-0.05);
  });
  it('完整合成历史可产生OOS成交；改变测试数据不改变该折训练模型；资金费缺口拒绝', () => {
    let seed = 456; let residual = 0;
    const start = PAIR_STUDY.from;
    const a = bars(100, 4320); const b = bars(100, 4320);
    for (let i = 0; i < a.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      residual = 0.8 * residual + (seed / 4294967296 - 0.5) * 0.025;
      const x = 4 + i * 0.0001;
      for (const [bs, price] of [[a, Math.exp(0.1 + x + residual)], [b, Math.exp(x)]] as const) {
        bs[i] = { ...bs[i]!, open_time: start + i * 3600000, close_time: start + (i + 1) * 3600000 - 1, open: String(price), close: String(price), high: String(price), low: String(price) };
      }
    }
    const funding = Array.from({ length: 540 }, (_, i) => ({ at: (Math.ceil(start / (8 * 3600000)) + i) * 8 * 3600000, rate: '0.0001' }));
    const input = { BTCUSDT: { bars: a, funding }, ETHUSDT: { bars: b, funding }, SOLUSDT: { bars: a, funding }, BNBUSDT: { bars: b, funding } };
    const first = runPairStudy(input); expect(first.trials[0]!.stats.raw_n).toBeGreaterThan(0);
    for (const trade of first.trials[0]!.trades) {
      expect(trade.at).toBeGreaterThanOrEqual(first.folds[trade.fold]!.test_from);
      expect(trade.exit_at).toBeLessThan(first.folds[trade.fold]!.test_to);
    }
    const altered = structuredClone(input);
    const index = (first.folds[0]!.test_from - start) / 3600000;
    altered.BTCUSDT.bars[index]!.close = altered.BTCUSDT.bars[index]!.high;
    // 改变OOS价格，包括OHLC，保持数据有效。
    for (const k of ['open', 'close', 'high', 'low'] as const) altered.BTCUSDT.bars[index]![k] = '1000';
    expect(runPairStudy(altered).trials[0]!.models[0]).toEqual(first.trials[0]!.models[0]);
    altered.BTCUSDT.funding[5]!.rate = '';
    expect(runPairStudy(altered).trials[0]!.reasons).toContain('data_coverage');
    altered.BTCUSDT.funding.splice(5, 2);
    expect(runPairStudy(altered).trials[0]!.reasons).toContain('data_coverage');
  });
  it('3z止损与24根期限；最后一根强平；不把缺数据变成合格trial', () => {
    const b = { bars: bars(100), funding: [] };
    const a = { bars: bars(100 * Math.exp(0.25)), funding: [] };
    const out = simulatePairOutcome(setup, model, a, b, 1); expect(out.reason).toBe('expired'); expect(out.exit_index).toBe(24);
    a.bars[1]!.close = String(100 * Math.exp(0.31)); expect(simulatePairOutcome(setup, model, a, b, 1).reason).toBe('stop');
    const r = runPairStudy({}); expect(r.folds).toHaveLength(5); expect(r.trials).toHaveLength(3); expect(r.trials.every(t => t.status === 'rejected' && t.reasons.includes('data_coverage'))).toBe(true);
  });
});
