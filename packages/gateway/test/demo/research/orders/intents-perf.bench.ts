/** 订单意图计算的性能基准(2026-09-26):`npx vitest bench --run test/demo/research/orders/intents-perf.bench.ts`。
 * 8000 根 15m K 线、view=500、indicator_cross 信号 + 方向门 + ATR 止损;字符串 K 线(原始数据集)与 numericBars(执行器实际喂的)各测一遍,
 * 另测 runOrderPath(含持仓管理 orderManager 的逐根离场判断)。 */
import { bench, describe } from 'vitest';
import { orderIntents, runOrderPath } from '../../../../src/demo/research/orders/index.js';
import { numericBars } from '../../../../src/demo/research/engine.js';
import { synthBars, benchIR, STEP15 } from './perf-fixture.js';

const N = 8000, VIEW = 500, bars = synthBars(N), nbars = numericBars(bars), ir = benchIR('long'), irBoth = benchIR('both');
const opts = { fee_rate: '0.0005', slippage_bps: '5', from_index: 600, to_index: N - 1, view: VIEW };
const B = { iterations: 3, warmupIterations: 1, time: 0, warmupTime: 0 };
describe(`orderIntents ${N} bars view ${VIEW}`, () => {
  bench('string bars, long', () => { orderIntents(ir, bars, STEP15, opts); }, B);
  bench('numeric bars, long', () => { orderIntents(ir, nbars, STEP15, opts); }, B);
  bench('numeric bars, both (mirrored + short regime)', () => { orderIntents(irBoth, nbars, STEP15, opts); }, B);
  bench('runOrderPath numeric, long (intents + manager)', () => {
    runOrderPath({ ir, bars: nbars, timeframe_ms: STEP15, symbol: 'BENCH-USDT', from_index: 600, to_index: N - 1, initial_cash: 10000, view_bars: VIEW });
  }, B);
});
