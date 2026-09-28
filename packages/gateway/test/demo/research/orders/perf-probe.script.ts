/** 手动性能探针(非测试):node ../../node_modules/jiti/lib/jiti-cli.mjs test/demo/research/orders/perf-probe.script.ts [case] [fast|ref] [reps] */
import { orderIntents, runOrderPath } from '../../../../src/demo/research/orders/index.js';
import { numericBars } from '../../../../src/demo/research/engine.js';
import { setIndicatorFastPath } from '../../../../src/demo/research/primitives/indicators.js';
import { synthBars, benchIR, STEP15 } from './perf-fixture.js';
const N = Number(process.env.BARS ?? 8000), VIEW = Number(process.env.VIEW ?? 500), bars = synthBars(N), nbars = numericBars(bars);
const opts = { fee_rate: '0.0005', slippage_bps: '5', from_index: 600, to_index: N - 1, view: VIEW };
const cases: Record<string, () => unknown> = {
  str: () => orderIntents(benchIR('long'), bars, STEP15, opts),
  num: () => orderIntents(benchIR('long'), nbars, STEP15, opts),
  both: () => orderIntents(benchIR('both'), nbars, STEP15, opts),
  path: () => runOrderPath({ ir: benchIR('long'), bars: nbars, timeframe_ms: STEP15, symbol: 'B', from_index: 600, to_index: N - 1, initial_cash: 10000, view_bars: VIEW }),
  pathstr: () => runOrderPath({ ir: benchIR('long'), bars, timeframe_ms: STEP15, symbol: 'B', from_index: 600, to_index: N - 1, initial_cash: 10000, view_bars: VIEW }),
};
const names = (process.argv[2] ?? 'str,num,both,path').split(','), modes = (process.argv[3] ?? 'ref,fast').split(','), reps = Number(process.argv[4] ?? 3);
for (let r = 0; r < reps; r++) for (const n of names) for (const m of modes) {
  setIndicatorFastPath(m === 'fast'); const t = performance.now(), c = process.cpuUsage(); cases[n]!(); const u = process.cpuUsage(c);
  console.log(`${n} ${m} wall=${(performance.now() - t).toFixed(0)}ms cpu=${((u.user + u.system) / 1000).toFixed(0)}ms`);
}
