/**
 * 批量研究里组合族(横截面动量、资金费套利)的评估:跑 primitives/portfolio-*.ts,再切成与单资产族同形的 AssetSlice,
 * 这样资产池指标、基准、排行榜都用同一套 poolScore。
 *  - 横截面动量:整个组合当作一个「资产」PORTFOLIO;持有基准 = 同一时刻可排名资产的等权买入持有(段首成员,前值填充);
 *    敞口记净敞口(多 − 空):现货多头 ≈ 持仓比例,永续多空 ≈ 0,同敞口持有随之取值。
 *  - 资金费套利:每个资产一条两腿曲线,持有基准 = 该资产现货买入持有;敞口记净敞口(≈ 0,市场中性)。
 *  - 资格:段首之前已有数据(横截面动量要求回看期已满)的资产才算成员,与单资产族同一规则。
 */
import type { ResearchBar } from '@trading-swarm/contracts';
import type { FundingSeries } from '../orders/types.js';
import { runXsmom, type PortfolioAsset, type PortfolioSample, type XsmomParams } from '../primitives/portfolio-xsmom.js';
import { runCarry, type CarryParams } from '../primitives/portfolio-carry.js';
import { sliceAsset, DAY, type AssetSlice } from './evaluate.js';
import type { Window } from '../improve/evaluate.js';

/** 等权买入持有指数:times 上各资产 close / 基准时刻 close 的均值,只含基准时刻已有收盘的资产 */
function holdIndex(assets: { bars: ResearchBar[] }[], times: number[]): Map<number, number> {
  const out = new Map<number, number>(); if (!times.length) return out;
  const maps = assets.map((a) => new Map(a.bars.map((b) => [b.close_time, Number(b.close)])));
  const t0 = times[0]!, mem = maps.filter((m) => (m.get(t0) ?? 0) > 0), base = mem.map((m) => m.get(t0)!), last = [...base];
  for (const t of times) { let s = 0; mem.forEach((m, k) => { const v = m.get(t); if (v !== undefined && v > 0) last[k] = v; s += last[k]! / base[k]!; }); out.set(t, mem.length ? s / mem.length : 1); }
  return out;
}
const toSamples = (s: PortfolioSample[], bench: Map<number, number>) => s.map((x) => ({ at: x.at, equity: x.equity, exposure: x.net_exposure, bench: bench.get(x.at) ?? null }));

export interface XsmomEval { slices: Record<string, AssetSlice[]>; rebalances: number; avg_turnover: number; fees: number; funding: number; notes: string[] }
/** 横截面动量:window 上一次连续运行(正常 + 2 倍费率),切 segs;资格 = 段首前回看期已满 */
export function evaluateXsmom(assets: PortfolioAsset[], p: XsmomParams, window: Window, segs: Record<string, Window>, cost: { fee_rate: number; slippage_bps: number }): XsmomEval {
  const run = runXsmom(assets, p, window, cost), stressed = runXsmom(assets, p, window, { ...cost, fee_rate: cost.fee_rate * 2 });
  const times = run.samples.map((s) => s.at), bench = holdIndex(assets, times), slices: Record<string, AssetSlice[]> = {};
  const firstRank = run.rebalances.find((r) => r.ranked >= Math.min(assets.length, p.top_k * ((p.side ?? 'long_only') === 'long_short' ? 2 : 1)))?.at ?? null;
  for (const [name, seg] of Object.entries(segs)) {
    // 起点 = 可排名资产首次够数的调仓时刻;不晚于段首后一个调仓周期(周调仓 8 天)才算有资格
    const slack = (p.rebalance === 'daily' ? 1 : 7) * DAY + DAY;
    const sl = sliceAsset('PORTFOLIO', toSamples(run.samples, bench), stressed.samples.map((x) => ({ at: x.at, equity: x.equity })), run.trades.filter((t) => !t.open).map((t) => ({ entry_at: t.entry_at, exit_at: t.exit_at, return_pct: t.return_pct, fees: t.fees })), seg, firstRank !== null && firstRank <= seg.from_ms + slack ? Math.min(window.from_ms, seg.from_ms) : null);
    slices[name] = [sl];
  }
  return { slices, rebalances: run.rebalances.length, avg_turnover: run.rebalances.length ? run.rebalances.reduce((a, r) => a + r.turnover, 0) / run.rebalances.length : 0, fees: run.fees, funding: run.funding, notes: run.notes };
}

export interface CarryAsset { symbol: string; spot: ResearchBar[]; perp: ResearchBar[]; funding: FundingSeries | null }
export interface CarryEval { slices: Record<string, AssetSlice[]>; hold_fraction: Record<string, number>; funding: number; fees: number; notes: string[] }
/** 资金费套利:每资产一条两腿曲线;资格 = 现货、永续、资金费三样在段首前都已有 */
export function evaluateCarry(assets: CarryAsset[], p: CarryParams, window: Window, segs: Record<string, Window>): CarryEval {
  const slices: Record<string, AssetSlice[]> = Object.fromEntries(Object.keys(segs).map((k) => [k, [] as AssetSlice[]]));
  const hold: Record<string, number> = {}, notes: string[] = [];
  let funding = 0, fees = 0;
  for (const a of assets) {
    const run = runCarry(a, p, window), stressed = runCarry(a, { ...p, spot_fee_rate: (p.spot_fee_rate ?? 0.001) * 2, perp_fee_rate: (p.perp_fee_rate ?? 0.0005) * 2 }, window);
    hold[a.symbol] = run.hold_fraction; funding += run.funding; fees += run.fees; notes.push(...run.notes);
    const spotBy = new Map(a.spot.map((b) => [b.close_time, Number(b.close)])), s0 = a.spot.find((b) => b.close_time >= window.from_ms);
    const bench = new Map<number, number>(); let lastPx = s0 ? Number(s0.close) : NaN; for (const x of run.samples) { const v = spotBy.get(x.at); if (v !== undefined) lastPx = v; bench.set(x.at, lastPx); }
    const start = Math.max(a.spot[0]?.close_time ?? Infinity, a.perp[0]?.close_time ?? Infinity, a.funding?.points[0]?.ts ?? Infinity) + 30 * DAY; // 至少 30 天资金费历史才开始算资格
    for (const [name, seg] of Object.entries(segs)) slices[name]!.push(sliceAsset(a.symbol, toSamples(run.samples, bench), stressed.samples.map((x) => ({ at: x.at, equity: x.equity })), run.trades.filter((t) => !t.open).map((t) => ({ entry_at: t.entry_at, exit_at: t.exit_at, return_pct: t.return_pct, fees: t.fees })), seg, Number.isFinite(start) && start <= seg.from_ms ? start : null));
  }
  return { slices, hold_fraction: hold, funding, fees, notes: [...new Set(notes)] };
}
