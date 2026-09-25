/**
 * 批量研究 worker(worker_threads):收一个任务 → 在冻结数据上零模型回测 → 回结果。任务类型:
 *   eval    —— 一个变体在训练 + 验证段上的整池与筛资产两行(BatchRow);
 *   random  —— 随机入场基线(验证段,同离场/同入场单型/同期望笔数,固定种子);
 *   holdout —— 留出段(只给每族冠军)。
 * 数据按 (周期, 市场) 缓存,只留最近一组,控制内存。
 */
import { parentPort } from 'node:worker_threads';
import type { StrategyIR } from '@trading-swarm/contracts';
import { EvalEnv, runPool, scoreSegment } from '../../packages/gateway/src/demo/research/improve/evaluate.ts';
import { randomEntryBaseline } from '../../packages/gateway/src/demo/research/improve/random-entry.ts';
import { hash } from '../../packages/gateway/src/demo/research/primitives.ts';
import { evaluateIrVariant, poolScore, trainValWindow } from '../../packages/gateway/src/demo/research/batch/evaluate.ts';
import { evaluateXsmom, evaluateCarry } from '../../packages/gateway/src/demo/research/batch/portfolio.ts';
import { rowsFor, slim, assetStats } from '../../packages/gateway/src/demo/research/batch/study.ts';
import type { Variant, IrVariant, PortfolioVariant } from '../../packages/gateway/src/demo/research/batch/families.ts';
import type { FrozenData } from '../../packages/gateway/src/demo/research/improve/types.ts';
import { frozenData, readFrozen, readUniverse } from './common.ts';

export type Task = { type: 'eval'; variant: Variant } | { type: 'random'; variant: Variant; runs: number; seed: number; assets?: string[] } | { type: 'holdout'; variant: Variant; assets?: string[] };
let cacheKey = '', cache: { data: FrozenData; env: EvalEnv } | null = null;
function envFor(tf: string, market: 'spot' | 'perp') {
  const k = `${tf}:${market}`;
  if (k !== cacheKey || !cache) { cache = null; const { data } = frozenData(tf, market); cache = { data, env: new EvalEnv(data) }; cacheKey = k; }
  return cache;
}
const perAsset = (xs: import('../../packages/gateway/src/demo/research/batch/evaluate.ts').AssetSlice[]) => xs.map((x) => { const st = assetStats(x); return { symbol: x.symbol, eligible: x.eligible, return: st.ret, sharpe: st.sharpe, trades: x.trades, hold: x.hold.length ? x.hold.at(-1)! - 1 : null, expectancy: x.trade_returns.length ? x.trade_returns.reduce((a, b) => a + b, 0) / x.trade_returns.length : null }; });
const sideSign = (v: Variant): 1 | -1 => (v.kind === 'ir' && v.side === 'short' ? -1 : 1);
const meta = (v: Variant) => ({ variant_id: v.id, family: v.family, param: v.param, market: v.market, side: v.side, timeframe: v.timeframe });
const COST = { spot: { fee_rate: 0.001, slippage_bps: 5 }, perp: { fee_rate: 0.0005, slippage_bps: 5 } };
function portfolioAssets(tf: string, market: 'spot' | 'perp') { return readUniverse().map((s) => readFrozen(s, tf, market)).filter((f): f is NonNullable<typeof f> => !!f && f.bars.length > 0).map((f) => ({ symbol: f.symbol, bars: f.bars, funding: market === 'perp' ? f.funding ?? null : null })); }
function carryAssets() { return readUniverse().flatMap((s) => { const sp = readFrozen(s, '4h', 'spot'), pp = readFrozen(s, '4h', 'perp'); return sp && pp ? [{ symbol: s, spot: sp.bars, perp: pp.bars, funding: pp.funding ?? null }] : []; }); }
function runPortfolio(v: PortfolioVariant, segs: Record<string, { from_ms: number; to_ms: number }>, window: { from_ms: number; to_ms: number }) {
  if (v.node.primitive === 'portfolio_xsmom') return evaluateXsmom(portfolioAssets(v.timeframe, v.market), v.node.params, window, segs, COST[v.market]);
  return evaluateCarry(carryAssets(), v.node.params, window, segs);
}

async function handle(t: Task): Promise<unknown> {
  const v = t.variant, market = v.market, { data, env } = envFor(v.timeframe, market), s = data.segments;
  if (t.type === 'eval') {
    if (v.kind === 'ir') {
      const r = await evaluateIrVariant(env, v.ir, trainValWindow(s), { train: s.train, validation: s.validation }, v.vol_target ? { vol_target: v.vol_target } : {});
      return { rows: rowsFor(meta(v), r.slices.train!, r.slices.validation!, sideSign(v)), warnings: r.warnings, engine: r.engine };
    }
    const r = runPortfolio(v, { train: s.train, validation: s.validation }, trainValWindow(s));
    const extra = 'rebalances' in r ? { rebalances: r.rebalances, avg_turnover: r.avg_turnover, fees: r.fees, funding: r.funding } : { hold_fraction: r.hold_fraction, funding: r.funding, fees: r.fees };
    return { rows: rowsFor(meta(v), r.slices.train!, r.slices.validation!, 1), warnings: r.notes, engine: v.node.primitive, extra };
  }
  if (t.type === 'holdout') {
    if (v.kind === 'ir') {
      const ir = v.ir as StrategyIR, assets = t.assets ? data.assets.filter((a) => t.assets!.includes(a.symbol)) : data.assets;
      const sub = t.assets ? new EvalEnv({ ...data, assets }) : env;
      const r = await evaluateIrVariant(sub, ir, s.holdout, { holdout: s.holdout }, v.vol_target ? { vol_target: v.vol_target } : {});
      return { holdout: slim(poolScore(r.slices.holdout!, sideSign(v))), segment: s.holdout, per_asset: perAsset(r.slices.holdout!) };
    }
    const r = runPortfolio(v, { holdout: s.holdout }, s.holdout);
    return { holdout: slim(poolScore(r.slices.holdout!, 1)), segment: s.holdout, per_asset: perAsset(r.slices.holdout!) };
  }
  // random:验证段独立跑一遍(不带训练段的持仓进来),再跑 runs 次随机入场,比较收益分位
  if (v.kind === 'ir') {
    const ir = v.ir as StrategyIR, key = hash(ir), assets = t.assets ? data.assets.filter((a) => t.assets!.includes(a.symbol)) : undefined;
    const run = await runPool(env, ir, key, s.validation, assets ? { assets } : {}), champ = scoreSegment('validation', run, s.validation);
    const rnd = await randomEntryBaseline(env, ir, key, s.validation, champ, { runs: t.runs, seed: t.seed, segment: 'validation', ...(assets ? { assets } : {}) });
    return { champion: { total_return: champ.total_return, sharpe: champ.sharpe, trades: champ.trades, exposure: champ.exposure }, random: rnd?.ledger ?? null, note: v.vol_target ? '随机入场基线按单位仓位比较(未叠加波动率目标)' : null };
  }
  if (v.node.primitive === 'portfolio_xsmom') {
    const assets = portfolioAssets(v.timeframe, v.market), cost = COST[v.market], seg = { validation: s.validation };
    const champ = poolScore(evaluateXsmom(assets, v.node.params, s.validation, seg, cost).slices.validation!, 1);
    const returns: number[] = [], sharpes: (number | null)[] = [];
    for (let k = 0; k < t.runs; k++) { const p = poolScore(evaluateXsmom(assets, { ...v.node.params, select: 'random', seed: t.seed + k }, s.validation, seg, cost).slices.validation!, 1); returns.push(p.total_return); sharpes.push(p.sharpe); }
    const below = returns.filter((r) => r < champ.total_return).length;
    return { champion: { total_return: champ.total_return, sharpe: champ.sharpe, trades: champ.trades, exposure: champ.exposure }, random: { runs: t.runs, seed: t.seed, segment: 'validation', returns, sharpes, trades: [], median_return: [...returns].sort((a, b) => a - b)[Math.floor((returns.length - 1) / 2)] ?? null, champion_return: champ.total_return, champion_percentile: t.runs ? below / t.runs : null, note: `随机选币:同调仓时刻、同名数、固定种子 ${t.seed}+k;动量组合收益高于 ${below}/${t.runs} 次随机选币` }, note: null };
  }
  return { champion: null, random: null, note: '资金费套利不做随机入场基线:它的对照是「一直持有」(门槛放到最低)那一档' };
}

parentPort!.on('message', async (m: { id: number; task: Task }) => {
  try { parentPort!.postMessage({ id: m.id, ok: true, result: await handle(m.task) }); }
  catch (e) { parentPort!.postMessage({ id: m.id, ok: false, error: e instanceof Error ? `${e.message}\n${e.stack?.split('\n').slice(1, 4).join('\n')}` : String(e) }); }
});
