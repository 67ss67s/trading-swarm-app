/** 预注册三对研究；纯函数，不读策略库、不写active、不连接交易所。 */
import { createHash } from 'node:crypto';
import { anchoredWalkForward, bootstrapCI, validKline, DAY } from './replay-stats.js';
import { estimatePairModel, PAIR_SIGNAL_REGISTRY } from './pair-signals.js';
import { simulatePairOutcome, type PairSeries } from './pair-outcome.js';
export const PAIR_STUDY = {
  version: 'pair-v1', trial_count: 3, from: Date.UTC(2026, 2, 16, 4), to: Date.UTC(2026, 8, 12, 4),
  pairs: [['BTCUSDT', 'ETHUSDT'], ['SOLUSDT', 'ETHUSDT'], ['BNBUSDT', 'BTCUSDT']] as const,
  train_days: 60, test_days: 20, purge_hours: 24, horizon: 24, entry_z: 2, stop_z: 3,
  half_life_hours: [1, 24], fee_bps: 5, slippage_bps: 1, cluster_hours: 24, bootstrap_iterations: 2000, seed: 0x51a7,
};
type Trade = ReturnType<typeof simulatePairOutcome> & { doubled_net: number; async_net: number; async_max_exposure: number; pair: string; fold: number };
const avg = (v: number[]) => v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
export function summarizePairTrades(trades: Trade[]) {
  const daily = new Map<number, number>();
  for (const t of trades) { const day = Math.floor(t.at / DAY); daily.set(day, (daily.get(day) ?? 0) + t.net); }
  const clusters = [...daily].sort(([a], [b]) => a - b).map(([, n]) => n);
  const sorted = trades.map(t => t.net).sort((a, b) => a - b);
  const sum = (key: 'net' | 'gross' | 'fees' | 'slippage' | 'funding' | 'single' | 'doubled_net' | 'async_net') => trades.reduce((v, t) => v + t[key], 0);
  return { raw_n: trades.length, effective_n: clusters.length, ci: bootstrapCI(clusters), net: sum('net'), gross: sum('gross'), fees: sum('fees'), slippage: sum('slippage'), funding: sum('funding'), single_leg_net: sum('single'), no_trade_net: 0, doubled_net: sum('doubled_net'), async_net: sum('async_net'), worst_trade: sorted[0] ?? null, tail_5pct_mean: avg(sorted.slice(0, Math.ceil(sorted.length * 0.05))), mean_initial_net_exposure: avg(trades.map(t => t.initial_net_exposure)), max_abs_net_exposure: trades.length ? Math.max(...trades.map(t => t.max_abs_net_exposure)) : null, async_max_abs_net_exposure: trades.length ? Math.max(...trades.map(t => t.async_max_exposure)) : null };
}
export function runPairStudy(input: Record<string, PairSeries>) {
  const folds = anchoredWalkForward(PAIR_STUDY.from, PAIR_STUDY.to, 24, 3600000);
  const data: Record<string, PairSeries> = {}; const errors: Record<string, string> = {}; const hashes: Record<string, string> = {};
  for (const symbol of new Set(PAIR_STUDY.pairs.flat())) {
    try {
      const raw = input[symbol]; if (!raw) throw new Error('缺少数据');
      const bars = raw.bars.filter(b => b.open_time >= PAIR_STUDY.from && b.close_time < PAIR_STUDY.to);
      const funding = raw.funding.filter(f => f.at >= PAIR_STUDY.from && f.at < PAIR_STUDY.to);
      if (bars.length !== 4320 || bars.some((b, i) => !validKline(b) || b.open_time !== PAIR_STUDY.from + i * 3600000 || b.close_time !== b.open_time + 3599999)) throw new Error('180d小时线不连续');
      // 本次四币研究固定UTC 8h资金费网格；变频数据必须阻断，不能猜缺失费率。
      const times = [PAIR_STUDY.from, ...funding.map(f => f.at), PAIR_STUDY.to];
      if (funding.length !== 540 || funding.some((f, i) => typeof f.rate !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(f.rate) || !Number.isFinite(Number(f.rate)) || !Number.isInteger(f.at) || Math.abs(f.at - (Math.ceil(PAIR_STUDY.from / (8 * 3600000)) + i) * 8 * 3600000) > 1000 || (i > 0 && f.at <= funding[i - 1]!.at)) || times.some((t, i) => i > 0 && t - times[i - 1]! > 8 * 3600000 + 1000)) throw new Error('资金费覆盖缺失/无效');
      data[symbol] = { bars, funding }; hashes[symbol] = createHash('sha256').update(JSON.stringify(data[symbol])).digest('hex');
    } catch (e) { errors[symbol] = String(e); }
  }
  const trials = PAIR_STUDY.pairs.map((symbols, trial) => {
    const trades: Trade[] = []; const models = []; const reasons: string[] = [];
    const a = data[symbols[0]]; const b = data[symbols[1]];
    if (!a || !b) reasons.push('data_coverage');
    else for (const [fi, fold] of folds.entries()) {
      const trainA = a.bars.filter(x => x.close_time < fold.train_to); const trainB = b.bars.filter(x => x.close_time < fold.train_to);
      try {
        const model = estimatePairModel(trainA.map(x => x.close), trainB.map(x => x.close));
        models.push({ fold: fi, ...fold, model, train_daily_quote_volume: [trainA, trainB].map(bs => bs.reduce((v, x) => v + Number(x.close) * Number(x.volume), 0) / (bs.length / 24)) });
        if (!model.stable) continue;
        for (let i = Math.ceil((fold.test_from - PAIR_STUDY.from) / 3600000); i < a.bars.length; i++) {
          // 所有预设期限与不同步压力都必须完整位于本折，不按已知提前退出放宽。
          if (!a.bars[i + 26] || a.bars[i + 26]!.close_time >= fold.test_to) break;
          const setup = PAIR_SIGNAL_REGISTRY.relative_value({ at: a.bars[i]!.close_time, symbols, closes: [a.bars[i]!.close, b.bars[i]!.close], model });
          if (!setup) continue;
          const base = simulatePairOutcome(setup, model, a, b, i + 1);
          const doubled = simulatePairOutcome(setup, model, a, b, i + 1, 2);
          const async = simulatePairOutcome(setup, model, a, b, i + 1, 1, 1);
          trades.push({ ...base, doubled_net: doubled.net, async_net: async.net, async_max_exposure: async.max_abs_net_exposure, pair: symbols.join('/'), fold: fi });
          i = async.exit_index; // 压力情景平仓前也不允许重叠机会。
        }
      } catch (e) { models.push({ fold: fi, ...fold, error: String(e) }); }
    }
    const stats = summarizePairTrades(trades);
    if (folds.length < 3) reasons.push('full_folds_lt_3');
    if (stats.effective_n < 30) reasons.push('effective_clusters_lt_30');
    if ((stats.ci.lower ?? -Infinity) <= 0) reasons.push('ci_lower_not_positive');
    if (stats.doubled_net <= 0) reasons.push('double_cost_failed');
    return { trial_id: `pair-${trial + 1}`, symbols, status: reasons.length ? 'rejected' : 'offline_evidence_only', reasons, stats, models, trades };
  });
  // 合并资本等分，只用于描述；不救单对，也不视为新增候选trial。
  const pooled = trials.flatMap(t => t.trades).map(t => ({ ...t, ...Object.fromEntries(['net', 'gross', 'fees', 'slippage', 'funding', 'single', 'doubled_net', 'async_net'].map(k => [k, t[k as 'net'] / 3])) }));
  return { preregistration: PAIR_STUDY, data_hashes: hashes, errors, folds, trials, pooled_equal_capital: summarizePairTrades(pooled), note: '收益为初始总名义归一的简单累计，非复利；暴露为单对名义比例，非BTC beta。所有trial保留，不晋升。' };
}
