/**
 * oracle 独立研究(2026-09-23):6 现货 × 1h × 2 年,训练 50% / 验证 25% / 留出 25%(留出段本轮不碰)。
 *  1. mineOracle 在训练段挖规则,三种置换零分布各 200 次(同步循环平移 = 主结论,块重排 / 逐根打乱作对照);
 *  2. 可表达的只做多规则(≤3 条)+ 「不加过滤、有空就进」的基线,用 backtest-report 的公开入口 runBacktestReport 在验证段真回测
 *     (scratch sqlite,不碰 18811 的库;K 线只给到验证段末);
 *  3. 随机入场基线:同一套机械管理、各资产与规则同样的成交笔数,随机挑进场根(非重叠),200 次;
 *  4. 结果写 ~/.trading-swarm-okx/research-oracle/study-result.json,由 publish.ts 落库、报告手写进 docs/research/oracle-study-2026-09-23.md。
 * 零模型。独立进程跑,不在网关里跑。
 * 用法:node --experimental-transform-types --no-warnings --import ./scripts/research-oracle/register.mjs scripts/research-oracle/study.ts
 */
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { BacktestReport, StrategyIR } from '@trading-swarm/contracts';
import { loadFrozen, DATA_DIR } from './frozen.ts';
import { mineOracle, ruleToIR, computeFeatures, labelSeries, DEFAULT_MECHANICS, type OracleResult, type OracleRule, type PermutationMode } from '../../packages/gateway/src/demo/research/improve/oracle/index.ts';
import { holds, rng } from '../../packages/gateway/src/demo/research/improve/oracle/mine.ts';
import { labelHorizon } from '../../packages/gateway/src/demo/research/improve/oracle/labels.ts';
import { runBacktestReport, type BarsLoader } from '../../packages/gateway/src/demo/research/backtest-report.ts';
import { ResearchStore } from '../../packages/gateway/src/demo/research/store.ts';
import { openStateDb } from '../../packages/gateway/src/state-db.ts';
import { checkIR } from '../../packages/gateway/src/demo/research/strategy.ts';

const t0 = Date.now(), log = (m: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`);
const data = loadFrozen(), seg = data.segments, H = labelHorizon(DEFAULT_MECHANICS);
log(`训练 ${iso(seg.train.from_ms)}→${iso(seg.train.to_ms)} 验证 ${iso(seg.validation.from_ms)}→${iso(seg.validation.to_ms)} 留出 ${iso(seg.holdout.from_ms)}→${iso(seg.holdout.to_ms)}(不用)`);
function iso(t: number) { return new Date(t).toISOString().slice(0, 16).replace('T', ' '); }

// 1) 挖掘 + 三种零分布
const modes: PermutationMode[] = ['rotate', 'block', 'iid'];
const mined: Record<string, OracleResult> = {};
for (const mode of modes) {
  mined[mode] = await mineOracle(data, { permutations: 200, permutation_mode: mode, top: 12, picks: 3, progress: (m) => { if (!/置换 \d+\//.test(m)) log(`[${mode}] ${m}`); } });
}
const primary = mined.rotate!;

// 2) 验证段真回测(scratch 库;loader 只给到验证段末,留出段一根不给)
const scratch = path.join(DATA_DIR, 'scratch');
rmSync(scratch, { recursive: true, force: true }); mkdirSync(scratch, { recursive: true });
const sdb = openStateDb(path.join(scratch, 'validation.sqlite')), store = new ResearchStore(sdb.db);
const bySymbol = new Map(data.assets.map((a) => [a.symbol, a.bars]));
const loader: BarsLoader = async (symbol, _tf, window) => ({ bars: (bySymbol.get(symbol) ?? []).filter((b) => b.open_time >= window.from_ms && b.close_time <= Math.min(window.to_ms, seg.validation.to_ms)), source: `oracle-frozen:okx:spot:1h:${symbol}` });
interface ValResult { label: string; report_id: string; trades: number; expectancy: number | null; win_rate: number | null; total_return_avg: number; sharpe_avg: number | null; exposure_avg: number; hold_return_avg: number; exposure_matched_hold_avg: number; per_asset: { symbol: string; trades: number; total_return: number; sharpe: number | null; exposure: number; hold: number | null; expectancy: number | null }[] }
async function validate(ir: StrategyIR, label: string): Promise<ValResult> {
  const rep: BacktestReport = await runBacktestReport({ store, service: null as never, loader }, { strategy_ir: ir, timeframe: '1h', symbols: data.universe, from_ms: seg.validation.from_ms, to_ms: seg.validation.to_ms, basket: false, title: label, meta: { session_id: null, inquiry_id: null, question: label, symbol: 'BTCUSDT' }, timeout_ms: 1800000 });
  const per = rep.assets.filter((a) => a.status === 'completed' && a.metrics).map((a) => {
    const m = a.metrics!, rets = a.trades.map((t) => t.return_pct);
    return { symbol: a.key, trades: m.trades, total_return: m.total_return, sharpe: m.sharpe, exposure: m.exposure, hold: m.benchmark_return, expectancy: rets.length ? rets.reduce((x, y) => x + y, 0) / rets.length : null, rets };
  });
  const all = per.flatMap((p) => p.rets), avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const sh = per.map((p) => p.sharpe).filter((x): x is number => x !== null);
  return { label, report_id: rep.id, trades: all.length, expectancy: all.length ? avg(all) : null, win_rate: all.length ? all.filter((x) => x > 0).length / all.length : null, total_return_avg: avg(per.map((p) => p.total_return)), sharpe_avg: sh.length ? avg(sh) : null, exposure_avg: avg(per.map((p) => p.exposure)), hold_return_avg: avg(per.map((p) => p.hold ?? 0)), exposure_matched_hold_avg: avg(per.map((p) => (p.hold ?? 0) * p.exposure)), per_asset: per.map(({ rets: _r, ...x }) => x) };
}

// 3) 随机入场基线 + 用同一模拟器复核规则(验证段,非重叠:空仓时才进,离场根之后才能再进)
const valFeat = data.assets.map((a) => { const bars = a.bars.filter((b) => b.close_time <= seg.validation.to_ms); return { symbol: a.symbol, bars, f: computeFeatures(a.symbol, bars, data.timeframe_ms, data.assets.find((x) => /^BTC/.test(x.symbol))!.bars.filter((b) => b.close_time <= seg.validation.to_ms)), lab: labelSeries(bars, 'long', DEFAULT_MECHANICS, bars.length - 1), labShort: labelSeries(bars, 'short', DEFAULT_MECHANICS, bars.length - 1) }; });
const inRule = (conds: OracleRule['conditions']) => (ai: number, i: number) => conds.every((c) => { const f = valFeat[ai]!.f, k = f.defs.findIndex((d) => d.key === c.feature); return holds(c, f.cols[k]![i]!); });
/** 验证段上的「标签口径」复核:规则覆盖的 K 线里好点比例 vs 验证段基准(逐根、重叠,和挖掘同口径) */
function labelCheck(conds: OracleRule['conditions'], side: 'long' | 'short') {
  let n = 0, k = 0, sr = 0, N = 0, G = 0, SR = 0; const pick = inRule(conds);
  valFeat.forEach((v, ai) => { const lab = side === 'long' ? v.lab : v.labShort; for (let i = 0; i < v.bars.length; i++) { if (v.bars[i]!.close_time < seg.validation.from_ms || lab.good[i] === 255) continue; N++; G += lab.good[i]!; SR += lab.r[i]!; if (pick(ai, i)) { n++; k += lab.good[i]!; sr += lab.r[i]!; } } });
  return { n, rate: n ? k / n : 0, base_rate: N ? G / N : 0, mean_r: n ? sr / n : 0, base_mean_r: N ? SR / N : 0 };
}
function simulate(pick: (ai: number, i: number) => boolean, side: 'long' | 'short' = 'long'): { trades: number[]; perAsset: number[] } {
  const trades: number[] = [], perAsset: number[] = [];
  valFeat.forEach((v0, ai) => {
    const v = side === 'long' ? v0 : { ...v0, lab: v0.labShort };
    let n = 0; const start = v.bars.findIndex((b) => b.close_time >= seg.validation.from_ms);
    for (let i = start; i < v.bars.length; i++) {
      if (v.lab.good[i] === 255) continue;
      if (!pick(ai, i)) continue;
      trades.push(v.lab.ret[i]!); n++; i = v.lab.exit_index[i]!; // 离场根收盘后才能再判断
    }
    perAsset.push(n);
  });
  return { trades, perAsset };
}
const ruleSim = (r: OracleRule, side: 'long' | 'short' = 'long') => simulate(inRule(r.conditions), side);
const meanOf = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function randomBaseline(perAsset: number[], draws = 200) {
  const rand = rng(7), means: number[] = [];
  for (let d = 0; d < draws; d++) {
    const all: number[] = [];
    valFeat.forEach((v, ai) => {
      const start = v.bars.findIndex((b) => b.close_time >= seg.validation.from_ms), avail = v.bars.length - start - H;
      const target = perAsset[ai]!; if (!target || avail <= 0) return;
      // 与规则同样多的成交(期望意义上):空仓时每根以 p 进场,p = 笔数 / (可用根数 − 笔数 × 平均持有根数)
      let hold = 0, cnt = 0; for (let i = start; i < v.bars.length; i++) if (v.lab.good[i] !== 255) { hold += v.lab.exit_index[i]! - i; cnt++; }
      const flat = Math.max(target, avail - target * (cnt ? hold / cnt : H)), p = Math.min(1, target / flat);
      for (let i = start; i < v.bars.length; i++) { if (v.lab.good[i] === 255 || rand() >= p) continue; all.push(v.lab.ret[i]!); i = v.lab.exit_index[i]!; }
    });
    if (all.length) means.push(all.reduce((a, b) => a + b, 0) / all.length);
  }
  means.sort((a, b) => a - b);
  return { draws: means.length, mean: means.reduce((a, b) => a + b, 0) / Math.max(1, means.length), p05: means[Math.floor(0.05 * (means.length - 1))] ?? null, p95: means[Math.floor(0.95 * (means.length - 1))] ?? null, sorted: means };
}

const out: Record<string, unknown> = { data: { universe: data.universe, timeframe: data.timeframe, segments: seg, bars: data.assets.map((a) => ({ symbol: a.symbol, n: a.bars.length, from: a.bars[0]!.open_time, to: a.bars.at(-1)!.close_time })) }, mined: Object.fromEntries(modes.map((m) => [m, mined[m]])) };
// 基线:不加过滤、有空就进(同一机械管理)
const baseIR = ruleToIR([], 'long', 'oracle 基线:有空就进', '不加任何入场过滤,空仓即在下一根 open 进场;止损/离场同标签机械管理。').ir!;
log('验证段回测:基线');
const baseVal = await validate(baseIR, baseIR.label);
const baseSim = simulate(() => true);
const validations: unknown[] = [];
const longPicks = primary.sides.find((s) => s.side === 'long')!.picks;
for (const r of longPicks) {
  log(`验证段回测:${r.text}`);
  const val = await validate(r.ir!, r.ir!.label), sim = ruleSim(r), rb = randomBaseline(val.per_asset.map((p) => p.trades));
  const exp = val.expectancy ?? -Infinity;
  const randPct = rb.sorted.filter((x) => x <= exp).length / Math.max(1, rb.sorted.length);
  const promote = val.trades >= 30 && exp > 0;
  validations.push({ rule: r.text, conditions: r.conditions, ir: r.ir, check: checkIR(r.ir!, '1h').ok, validation: val, simulator: { trades: sim.trades.length, expectancy: sim.trades.length ? sim.trades.reduce((a, b) => a + b, 0) / sim.trades.length : null }, random_entry: { draws: rb.draws, mean: rb.mean, p05: rb.p05, p95: rb.p95, rule_percentile: randPct }, promote });
  log(`  n=${val.trades} 期望=${((val.expectancy ?? 0) * 100).toFixed(3)}% 胜率=${((val.win_rate ?? 0) * 100).toFixed(1)}% 平均收益=${(val.total_return_avg * 100).toFixed(2)}% 夏普=${val.sharpe_avg?.toFixed(2)} 敞口=${(val.exposure_avg * 100).toFixed(1)}% 同敞口持有=${(val.exposure_matched_hold_avg * 100).toFixed(2)}% 随机入场均值=${(rb.mean * 100).toFixed(3)}% 分位=${randPct.toFixed(2)} promote=${promote}`);
}
out.baseline = { validation: baseVal, simulator: { trades: baseSim.trades.length, expectancy: baseSim.trades.reduce((a, b) => a + b, 0) / Math.max(1, baseSim.trades.length) } };
out.validations = validations;
// 做空版:只给 IR 草稿与检查结果,不回测不落库(做空执行由订单周期工作线在接)
const shortBase = simulate(() => true, 'short');
out.short_baseline_sim = { trades: shortBase.trades.length, expectancy: meanOf(shortBase.trades) };
out.short_drafts = primary.sides.find((s) => s.side === 'short')!.picks.map((r) => { const sim = ruleSim(r, 'short'); return { rule: r.text, conditions: r.conditions, ir: r.ir ?? null, check_ok: r.check_ok ?? null, check_failed: r.check_failed ?? [], train: r.train, test: r.test, p_perm: r.p_perm, validation_label: labelCheck(r.conditions, 'short'), validation_sim: { trades: sim.trades.length, expectancy: meanOf(sim.trades), win_rate: sim.trades.length ? sim.trades.filter((x) => x > 0).length / sim.trades.length : null } }; });
// 训练段排名前 5 的规则(不论能否表达)在验证段上的标签口径复核:能归因的规律应该在新数据上仍然抬高好点比例
out.top_validation = Object.fromEntries((['long', 'short'] as const).map((side) => [side, primary.sides.find((s) => s.side === side)!.top.slice(0, 5).map((r) => ({ rule: r.text, train: r.train, test: r.test, p_perm: r.p_perm, q_bh: r.q_bh, validation: labelCheck(r.conditions, side) }))]));
for (const d of out.short_drafts as { rule: string; validation_sim: { trades: number; expectancy: number | null } }[]) log(`做空草稿(模拟器口径)${d.rule}:n=${d.validation_sim.trades} 期望=${((d.validation_sim.expectancy ?? 0) * 100).toFixed(3)}%`);
log(`做空基线(模拟器)n=${shortBase.trades.length} 期望=${((meanOf(shortBase.trades) ?? 0) * 100).toFixed(3)}%`);
log(`基线 n=${baseVal.trades} 期望=${((baseVal.expectancy ?? 0) * 100).toFixed(3)}% 平均收益=${(baseVal.total_return_avg * 100).toFixed(2)}% 持有=${(baseVal.hold_return_avg * 100).toFixed(2)}%`);
writeFileSync(path.join(DATA_DIR, 'study-result.json'), JSON.stringify(out, (_k, v) => (v instanceof Float64Array ? Array.from(v) : v), 1));
sdb.close();
log(`完成 → ${path.join(DATA_DIR, 'study-result.json')}`);
