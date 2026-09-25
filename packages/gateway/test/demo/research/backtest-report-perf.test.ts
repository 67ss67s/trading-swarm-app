// 回测报告实测耗时(合成行情,4h×6 年 / 日线 ×8 年,3 资产 + 篮子,A 臂零模型)。默认只跑日线;BACKTEST_BENCH=1 时跑 4h 并打印
import { it, expect } from 'vitest';
import { appendFileSync } from 'node:fs';
import { openStateDb } from '../../../src/state-db.js';
import { ResearchStore } from '../../../src/demo/research/store.js';
import { ResearchService } from '../../../src/demo/research/service.js';
import { runBacktestReport, type BarsLoader } from '../../../src/demo/research/backtest-report.js';
import { defaultIR } from '../../../src/demo/research/strategy.js';
import { synthBars, emaIR } from './backtest-report-fixtures.js';
const LOG = process.env.BACKTEST_BENCH_LOG;
async function bench(tf: string, step: number, n: number, ir = emaIR()) {
  const db = openStateDb(':memory:'), store = new ResearchStore(db.db), service = new ResearchService(store), start = Date.UTC(2018, 0, 1);
  const data: Record<string, ReturnType<typeof synthBars>> = { SOLUSDT: synthBars(n, step, 5, start, 20), BTCUSDT: synthBars(n, step, 7, start), ETHUSDT: synthBars(n, step, 9, start, 50) };
  const loader: BarsLoader = async (s, _tf, w) => ({ bars: data[s]!.filter((b) => b.open_time >= w.from_ms && b.close_time <= w.to_ms), source: 'synthetic' });
  const t = performance.now();
  const r = await runBacktestReport({ store, service, loader }, { strategy_ir: ir, timeframe: tf, from_ms: start + 300 * step, to_ms: start + n * step, meta: { session_id: null, inquiry_id: null, question: null, symbol: 'SOLUSDT' } });
  const ms = Math.round(performance.now() - t); db.close();
  const line = `${tf} ${n} bars × ${r.assets.length} assets (${ir.label}): ${ms} ms; trades ${r.assets.map((a) => a.key + '=' + (a.metrics?.trades ?? '-')).join(' ')}`;
  if (LOG) appendFileSync(LOG, line + '\n');
  return { ms, r };
}
it('日线 8 年 × 3 资产 + 篮子 < 5 秒(EMA 交叉)', async () => {
  const { ms, r } = await bench('1d', 86400000, 3000);
  expect(r.assets.every((a) => a.status === 'completed')).toBe(true);
  // 目标 < 5 秒(单跑实测 ~4.4 秒);全套并行跑时机器有负载,只在 BACKTEST_BENCH=1 时卡 5 秒
  expect(ms).toBeLessThan(process.env.BACKTEST_BENCH === '1' ? 5000 : 30000);
}, 60000);
it.runIf(process.env.BACKTEST_BENCH === '1')('4h 6 年 × 3 资产 + 篮子 < 20 秒', async () => {
  const a = await bench('4h', 4 * 3600000, 13140);
  const b = await bench('4h', 4 * 3600000, 13140, defaultIR());
  expect(a.ms).toBeLessThan(20000);
  void b;
}, 600000);
