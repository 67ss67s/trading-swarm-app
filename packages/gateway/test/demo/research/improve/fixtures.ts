// 改进环测试用的合成资产池(确定性几何随机游走,只做工程验证,不是经济证据)
import type { ResearchBar, StrategyIR } from '@trading-swarm/contracts';
import { node } from '../../../../src/demo/research/strategy.js';
import { synthBars } from '../backtest-report-fixtures.js';
import type { BarsLoader } from '../../../../src/demo/research/backtest-report.js';
import type { ImproveSpec } from '../../../../src/demo/research/improve/store.js';
import { DEFAULT_BUDGET, DEFAULT_OBJECTIVE, type Objective } from '../../../../src/demo/research/improve/types.js';

export const H4 = 4 * 3600000, START = Date.UTC(2022, 0, 1);
export const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
/** 4h × n 根,三个资产各自种子。 */
export function universeBars(n = 2100, step = H4, syms = SYMS): Record<string, ResearchBar[]> {
  return Object.fromEntries(syms.map((s, i) => [s, synthBars(n, step, 11 + i * 3, START, 100 + i * 20)]));
}
export function loaderOf(data: Record<string, ResearchBar[]>): BarsLoader & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (s, _tf, w) => { calls.push(s); const bars = data[s]; if (!bars) throw Error('DATA_MISSING:' + s); return { bars: bars.filter((b) => b.open_time >= w.from_ms && b.close_time <= w.to_ms), source: 'synthetic' }; }) as BarsLoader & { calls: string[] };
  f.calls = calls; return f;
}
/** 20/50 EMA 金叉做多、死叉离场(与 18811 上的「20/50 EMA 金叉做多、死叉离场」同形)。 */
export function emaIR(fast = 20, slow = 50): StrategyIR {
  return { version: 1, label: `${fast}/${slow} EMA`, description: '测试', signal: [node('ema_cross', { fast, slow })], entry: node('next_open_market', {}), risk: { stop: node('order_blocks', { swing_length: 5 }), sizing: node('equal_notional', { max_allocation: '1' }) }, exit: [node('indicator_cross_exit', { indicator: 'ema', args: { period: fast }, compare_to: 'indicator', compare_indicator: 'ema', compare_args: { period: slow }, direction: 'cross_below' }), node('fixed_r_target', { r: 2 }, true), node('chandelier_trail', { atr_period: 22, multiple: 3 })] };
}
/** 门槛放宽到合成数据也能过(只测流程,不测经济含义) */
export const LOOSE: Objective = { ...DEFAULT_OBJECTIVE, min_trades_per_fold: 0, min_trades_total: 0, max_drawdown: 1, require_stress_positive: false, require_beats_exposure_matched_hold: false, plateau_ratio: 0 };
export function specOf(o: Partial<ImproveSpec> = {}, n = 2100, step = H4): ImproveSpec {
  return { strategy_id: null, strategy_version: null, strategy_ir: emaIR(), timeframe: step === H4 ? '4h' : '1h', universe: SYMS, from_ms: START + 300 * step, to_ms: START + n * step, objective: LOOSE, budget: { ...DEFAULT_BUDGET, generations: 2, candidates_per_generation: 3, promote_per_generation: 1 }, generators: ['diagnosis', 'neighborhood', 'swap'], dataset_ids: null, random_entry_runs: 3, seed: 7, write_version: false, ...o };
}
