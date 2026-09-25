/**
 * 4h 永续均线趋势 · 杠杆 × 组合仓位研究的 worker(worker_threads,零模型)。数据 = 批量研究冻结的永续 4h 成交价 K 线与资金费
 * + perp-trend-fetch.ts 冻结的标记价 K 线与维持保证金分档(当前值)。每个任务在一个段(训练/验证/留出,makeSegments 切段)上独立跑
 * (预热向前借,不带上一段的持仓),子账户保证金占比 MF、杠杆 L,再按三种仓位规则在共享资金账户里合成组合(batch/perp-trend.ts)。
 * 任务:main(策略 + 2 倍手续费压力,出组合指标与基准)、random(随机入场基线,同离场/同杠杆/同仓位规则,固定种子)、check(复现批量研究 1 倍口径)。
 */
import { parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { StrategyIR } from '@trading-swarm/contracts';
import { EvalEnv, runPool, scoreSegment, windowIndex, type PoolRun, type Window } from '../../packages/gateway/src/demo/research/improve/evaluate.ts';
import { RandomOrderMemo } from '../../packages/gateway/src/demo/research/improve/random-entry.ts';
import { seededRandom } from '../../packages/gateway/src/demo/research/improve/stats.ts';
import { hash } from '../../packages/gateway/src/demo/research/primitives.ts';
import { irWarmup, node } from '../../packages/gateway/src/demo/research/strategy.ts';
import { realizedVol, ELIGIBLE_SLACK } from '../../packages/gateway/src/demo/research/batch/evaluate.ts';
import { irVariants } from '../../packages/gateway/src/demo/research/batch/families.ts';
import { simulatePortfolio, curveStats, tradeSummary, holdCurve, dailyCurve, type UnitPath, type Sizing } from '../../packages/gateway/src/demo/research/batch/perp-trend.ts';
import type { FrozenData } from '../../packages/gateway/src/demo/research/improve/types.ts';
import type { SignalCache } from '../../packages/gateway/src/demo/research/engine.ts';
import { BATCH_DIR, frozenData } from './common.ts';

export const MF = 0.25, VT_ANNUAL = 0.5, VOL_DAYS = 20, STRESS = 2;
export const SIGNALS = ['ema20_100_vt', 'ema50_200_vt'] as const, LEVERAGES = [1, 2, 3] as const, SIZINGS: Sizing[] = ['equal', 'equal_vt', 'inv_vol'];
export type Seg = 'train' | 'validation' | 'holdout';
export type Task =
  | { type: 'main'; signal: string; lev: number; seg: Seg; sizings?: Sizing[] }
  | { type: 'random'; signal: string; lev: number; seg: Seg; runs: number; seed: number; sizings?: Sizing[] }
  | { type: 'check'; signal: string };

/** 批量研究的变体 IR,改杠杆、改成固定保证金占比 MF(子账户被强平也不会归零) */
export function irOf(signal: string, lev: number, mf = MF): StrategyIR {
  const v = irVariants('perp', 'long', '4h').find((x) => x.param === signal);
  if (!v) throw Error('没有变体 ' + signal);
  return { ...v.ir, label: `${v.ir.label} ×${lev}`, risk: { ...v.ir.risk, sizing: node('equal_notional', { max_allocation: String(mf) }) }, order: { ...v.ir.order!, leverage: lev } };
}

let data: FrozenData | null = null, env: EvalEnv | null = null, plain: EvalEnv | null = null, markInfo: Record<string, { missing: number; first: number | null }> = {};
export function load() {
  if (data) return;
  const d = frozenData('4h', 'perp').data;
  for (const a of d.assets) {
    const f = JSON.parse(readFileSync(path.join(BATCH_DIR, 'perp-trend', 'data', `${a.symbol}-4h-mark.json`), 'utf8')) as { mark: ([number, number, number, number] | null)[]; tiers: { max_qty: number; mmr: number }[]; max_lever: number | null; mark_missing: number; mark_first_open: number | null };
    if (f.mark.length !== a.bars.length) throw Error(`${a.symbol} 标记价与成交价根数不一致`);
    const mark = f.mark.map((m, i) => (m ? { open_time: a.bars[i]!.open_time, close_time: a.bars[i]!.close_time, open: m[0], high: m[1], low: m[2], close: m[3], volume: 0 } : null));
    a.perp = { ...a.perp!, mark, tiers: f.tiers, max_lever: f.max_lever };
    markInfo[a.symbol] = { missing: f.mark_missing, first: f.mark_first_open };
  }
  data = d; env = new EvalEnv(d);
}
const sigCache = new Map<string, number | null>();
export function sigma(symbol: string, before: number): number | null {
  const k = symbol + '|' + before; if (sigCache.has(k)) return sigCache.get(k)!;
  const a = data!.assets.find((x) => x.symbol === symbol); const v = a ? realizedVol(a.bars, before, data!.timeframe_ms, VOL_DAYS) : null;
  sigCache.set(k, v); if (sigCache.size > 400000) sigCache.clear(); return v;
}
export const EXEC = { sizing_mode: 'risk_fraction' as const };
export function paths(run: PoolRun, win: Window): UnitPath[] {
  return run.per_asset.map((p) => {
    const start = p.equity[0]?.at ?? null, eligible = p.status === 'completed' && start !== null && start <= win.from_ms + ELIGIBLE_SLACK * (win.to_ms - win.from_ms) && p.equity.length >= 2;
    return { symbol: p.symbol, eligible, mf: MF, at: p.equity.map((e) => e.at), equity: p.equity.map((e) => e.equity), exposure: p.equity.map((e) => e.exposure), bench: p.equity.map((e) => p.bench.get(e.at) ?? null), exits: p.trades.map((t) => ({ entry_at: t.entry_at, reason: t.exit_reason })) };
  });
}
export const segWin = (seg: Seg): Window => data!.segments[seg];

function portfolio(ps: UnitPath[], stress: UnitPath[] | null, win: Window, sizings: Sizing[]) {
  const mem = ps.filter((p) => p.eligible), members = mem.map((p) => p.symbol);
  const out: Record<string, unknown> = {};
  // 基准:等权持有、等风险持有(段首 1/σ 定权)、BTC 持有
  const grid = [...new Set(mem.flatMap((p) => p.at))].sort((a, b) => a - b);
  const invw = new Map<string, number>(); const avail = members.map((s) => [s, sigma(s, win.from_ms + 1)] as const), inv = avail.filter(([, s]) => s).map(([, s]) => 1 / s!), fill = inv.length ? inv.reduce((a, b) => a + b, 0) / inv.length : 1;
  for (const [s, v] of avail) invw.set(s, v ? 1 / v : fill);
  const hEq = holdCurve(mem, grid), hInv = holdCurve(mem, grid, invw), btc = mem.find((p) => p.symbol === 'BTCUSDT');
  const holdEq = curveStats(grid, hEq.map((x) => x * 10000)), holdInv = curveStats(grid, hInv.map((x) => x * 10000));
  const btcHold = btc ? curveStats(grid, holdCurve([btc], grid).map((x) => x * 10000)) : null;
  for (const sz of sizings) {
    const r = simulatePortfolio(ps, sz, sigma, { vtAnnual: VT_ANNUAL }), st = curveStats(r.at, r.equity), ts = tradeSummary(r.trades);
    const expo = r.exposure.length ? r.exposure.reduce((a, b) => a + b, 0) / r.exposure.length : 0, base = sz === 'inv_vol' ? holdInv : holdEq;
    const sr = stress ? simulatePortfolio(stress, sz, sigma, { vtAnnual: VT_ANNUAL }) : null;
    const perAsset: Record<string, number> = {}; for (const t of r.trades) perAsset[t.symbol] = (perAsset[t.symbol] ?? 0) + 1;
    out[sz] = { ...st, trades: ts, avg_exposure: expo, in_market: r.exposure.filter((x) => x > 0).length / Math.max(1, r.exposure.length), cash_capped: r.cash_capped, stressed_return: sr ? curveStats(sr.at, sr.equity).total_return : null,
      hold_return: base.total_return, hold_mdd: base.max_drawdown, hold_sharpe: base.sharpe, exposure_matched_hold: base.total_return * expo, per_asset_trades: perAsset,
      daily: dailyCurve(r.at, r.equity).map((x) => Math.round(x)), days_from: r.at[0] ?? null };
  }
  return { members, hold_equal: holdEq, hold_inv_vol: holdInv, btc_hold: btcHold, results: out };
}

async function handle(t: Task): Promise<unknown> {
  load();
  if (t.type === 'check') {
    // 复现批量研究 1 倍口径:unit_notional、每笔 100% 权益、不叠波动率目标,验证段独立跑;对比无标记价 vs 有标记价
    const v = irVariants('perp', 'long', '4h').find((x) => x.param === t.signal)!, win = segWin('validation'), key = hash(v.ir);
    plain ??= new EvalEnv(frozenData('4h', 'perp').data);
    const a = scoreSegment('validation', await runPool(plain, v.ir, key, win), win), b = scoreSegment('validation', await runPool(env!, v.ir, key, win), win);
    return { no_mark: { total_return: a.total_return, trades: a.trades }, with_mark: { total_return: b.total_return, trades: b.trades } };
  }
  const ir = irOf(t.signal, t.lev), key = hash(ir), win = segWin(t.seg), sizings = t.sizings ?? SIZINGS;
  const run = await runPool(env!, ir, key, win, { execution: EXEC });
  const liq = run.trades.filter((x) => x.exit_reason === 'liquidation').length, exits: Record<string, number> = {};
  for (const x of run.trades) exits[x.exit_reason] = (exits[x.exit_reason] ?? 0) + 1;
  const markFallback = run.warnings.filter((w) => /没有标记价/.test(w));
  if (t.type === 'main') {
    const stress = await runPool(env!, ir, key, win, { execution: EXEC, feeMultiple: STRESS });
    return { signal: t.signal, lev: t.lev, seg: t.seg, window: win, engine: run.engine_version, liquidations_unit: liq, exit_reasons: exits, mark_fallback: markFallback, warnings: run.warnings.filter((w) => !/期末仍有持仓/.test(w)).slice(0, 12), ...portfolio(paths(run, win), paths(stress, win), win, sizings) };
  }
  // random:入场概率按策略自身在该段的每资产笔数与在场时间标定(与 improve/random-entry.ts 同式),离场/止损/杠杆/仓位规则不变
  const ps = paths(run, win).filter((p) => p.eligible), step = data!.timeframe_ms, warmup = irWarmup(ir, step);
  const assets = data!.assets.filter((a) => ps.some((p) => p.symbol === a.symbol));
  const idx = new Map(assets.map((a) => [a.symbol, windowIndex(a.bars, win, warmup)]));
  const nTr = run.trades.filter((x) => ps.some((p) => p.symbol === x.symbol)).length, inMarket = ps.map((p) => p.exposure.filter((x) => x > 0).length / p.exposure.length);
  const bars = assets.reduce((s, a) => { const i = idx.get(a.symbol); return s + (i ? i.end - i.start : 0); }, 0) / Math.max(1, assets.length);
  const flat = Math.max(1e-6, 1 - Math.min(0.95, inMarket.reduce((a, b) => a + b, 0) / Math.max(1, inMarket.length)));
  const p = Math.min(0.5, Math.max(1e-5, nTr / Math.max(1, assets.length) / Math.max(1, bars * flat)));
  const shared = new Map(assets.map((a) => [a.symbol, new Map<string, unknown>()])), out: Record<string, { returns: number[]; mdd: number[]; trades: number[] }> = {};
  for (const sz of sizings) out[sz] = { returns: [], mdd: [], trades: [] };
  for (let k = 0; k < t.runs; k++) {
    const rnd = seededRandom(t.seed + k), memos = new Map<string, SignalCache>();
    for (const a of assets) { const i = idx.get(a.symbol), chosen = new Set<number>(); if (i) for (let j = i.start; j <= i.end; j++) if (rnd() < p) chosen.add(j); memos.set(a.symbol, new RandomOrderMemo(chosen, shared.get(a.symbol)!) as unknown as SignalCache); }
    const rr = await runPool(env!, ir, key + '|random', win, { execution: EXEC, memo: (s) => memos.get(s)!, assets });
    const rps = paths(rr, win);
    for (const sz of sizings) { const r = simulatePortfolio(rps, sz, sigma, { vtAnnual: VT_ANNUAL }), st = curveStats(r.at, r.equity); out[sz]!.returns.push(st.total_return); out[sz]!.mdd.push(st.max_drawdown); out[sz]!.trades.push(r.trades.length); }
  }
  return { signal: t.signal, lev: t.lev, seg: t.seg, runs: t.runs, seed: t.seed, p, strategy_trades_unit: nTr, in_market: inMarket.reduce((a, b) => a + b, 0) / Math.max(1, inMarket.length), random: out };
}

parentPort?.on('message', async (m: { id: number; task: Task }) => {
  try { parentPort!.postMessage({ id: m.id, ok: true, result: await handle(m.task) }); }
  catch (e) { parentPort!.postMessage({ id: m.id, ok: false, error: e instanceof Error ? `${e.message}\n${e.stack?.split('\n').slice(1, 5).join('\n')}` : String(e) }); }
});
/** 给归因脚本用:已加载的冻结数据与评估环境 */
export function loaded(): { data: FrozenData; env: EvalEnv } { load(); return { data: data!, env: env! }; }
