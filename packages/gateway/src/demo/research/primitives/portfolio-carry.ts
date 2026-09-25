/**
 * 组合级原语:永续资金费套利两腿(portfolio_carry,2026-09-23 批量研究,最小可用版)。参数契约 research-batch.json#PortfolioCarryParams。
 *
 * 单资产两腿(纯函数,零 IO):
 *  - 持仓 = 现货多 + 永续空,等名义;资金 50/50 分给现货与永续保证金(1 倍,不借币、不跨保证金),所以名义 = 当时权益的一半。
 *  - 决策只在资金费结算时刻 ts 做:取 ts 及以前最近 window 期费率,各自按 8h 等效折算(rate × 8h / 与上一期的间隔,间隔夹在 1h–8h),
 *    平均值 > min_rate 就「应持有」,否则「应空仓」;状态变了才下单。ts 当期的费率在 ts 已结算、已公开,只用 ≤ ts 的数据(因果)。
 *  - 成交:ts 之后第一根开盘(K 线开盘时间 ≥ ts),两腿同时:现货按开盘 ×(1±滑点)、永续按永续开盘 ×(1∓滑点),各付吃单费。
 *    某一腿那根没有 K 线就顺延到两腿都有的下一根。
 *  - 再平衡:数量固定时价格涨跌会让两腿名义偏离「权益的一半」(涨三倍时名义是权益的 1.5 倍,1 倍空头早该爆仓)。
 *    所以持仓期间每根开盘检查,偏离超过 rebalance_band(缺省 20%)就把两腿都调回 权益/2,调整量按吃单费 + 滑点计成本
 *    (等价于把现货浮盈划给永续保证金,1 倍空头不会被强平)。
 *  - 资金费:持仓期间每个结算时刻 ts(严格晚于入场成交时刻、不晚于离场成交时刻,离场恰在 ts 开盘时先收这一期)收 名义(按永续最近收盘)× rate(正费率空头收钱)。
 *  - 盯市:权益 = 现金 + 现货数量 × 现货收盘 + 永续空头数量 ×(永续入场价 − 永续收盘);两腿收盘都取各自最近一根。
 *  - 交易 = 一次持有期,收益 = 离场后权益 / 入场前权益 − 1(含两腿费用、滑点、资金费与基差变化)。
 * 口径局限(报告里写明):不算借贷/划转、不做保证金不足强平(1 倍空头要涨一倍才爆);2022-01 前资金费为币安代理。
 */
import type { ResearchBar } from '@trading-swarm/contracts';
import type { FundingPoint, FundingSeries } from '../orders/types.js';
import type { PortfolioSample, PortfolioTrade } from './portfolio-xsmom.js';

export interface CarryParams { window: number; min_rate: number; spot_fee_rate?: number; perp_fee_rate?: number; slippage_bps?: number; rebalance_band?: number }
export interface CarryInput { symbol: string; spot: ResearchBar[]; perp: ResearchBar[]; funding: FundingSeries | null }
export interface CarryRun { samples: PortfolioSample[]; trades: PortfolioTrade[]; fees: number; funding: number; decisions: number; hold_fraction: number; rebalances: number; notes: string[] }
const H8 = 8 * 3600000, H1 = 3600000;

/** 各期 8h 等效费率(第一期按 8h 间隔) */
export function normalizedRates(points: FundingPoint[]): { ts: number; rate8h: number; rate: number }[] {
  const out: { ts: number; rate8h: number; rate: number }[] = [];
  for (let i = 0; i < points.length; i++) { const gap = i ? Math.min(H8, Math.max(H1, points[i]!.ts - points[i - 1]!.ts)) : H8; out.push({ ts: points[i]!.ts, rate: points[i]!.rate, rate8h: points[i]!.rate * H8 / gap }); }
  return out;
}
/** 每个结算时刻的「应持有」判定(纯函数,单独导出给测试) */
export function carrySignals(points: FundingPoint[], p: CarryParams): { ts: number; hold: boolean; avg8h: number }[] {
  const r = normalizedRates(points), out: { ts: number; hold: boolean; avg8h: number }[] = [];
  let sum = 0;
  for (let i = 0; i < r.length; i++) {
    sum += r[i]!.rate8h; if (i >= p.window) sum -= r[i - p.window]!.rate8h;
    if (i + 1 < p.window) continue;
    const avg = sum / p.window; out.push({ ts: r[i]!.ts, hold: avg > p.min_rate, avg8h: avg });
  }
  return out;
}

export function runCarry(x: CarryInput, p: CarryParams, win: { from_ms: number; to_ms: number }, initial = 10000): CarryRun {
  const fs = p.spot_fee_rate ?? 0.001, fp = p.perp_fee_rate ?? 0.0005, slip = (p.slippage_bps ?? 5) / 1e4, notes: string[] = [];
  const perpBy = new Map(x.perp.map((b) => [b.open_time, b])), spotBy = new Map(x.spot.map((b) => [b.open_time, b]));
  const grid = [...new Set([...x.spot, ...x.perp].map((b) => b.open_time))].sort((a, b) => a - b).filter((o) => o + (x.spot[0] ? x.spot[0].close_time - x.spot[0].open_time : 0) <= win.to_ms);
  const step = x.spot[0] ? x.spot[0].close_time - x.spot[0].open_time + 1 : H8;
  const pts = (x.funding?.points ?? []).filter((f) => f.ts <= win.to_ms);
  const sig = carrySignals(pts, p), samples: PortfolioSample[] = [], trades: PortfolioTrade[] = [];
  let rebalances = 0, cash = initial, sq = 0, pq = 0, pEntry = 0, lastSpot = NaN, lastPerp = NaN, fees = 0, funding = 0, want = false, si = 0, fi = 0, holdBars = 0, bars = 0;
  let entry: { at: number; equity: number; fees: number; spot: number } | null = null, entryFillAt = -Infinity;
  const equity = () => cash + (sq ? sq * lastSpot : 0) + (pq ? pq * (pEntry - lastPerp) : 0);
  // 窗口前的结算只用来给第一根定状态(不交易)
  while (si < sig.length && sig[si]!.ts < win.from_ms) { want = sig[si]!.hold; si++; }
  while (fi < pts.length && pts[fi]!.ts < win.from_ms) fi++;
  for (const open of grid) {
    const close = open + step - 1; if (close < win.from_ms) { const s = spotBy.get(open), q = perpBy.get(open); if (s) lastSpot = Number(s.close); if (q) lastPerp = Number(q.close); continue; }
    const s = spotBy.get(open), q = perpBy.get(open);
    // 先结清开盘时刻及以前的结算(结算那一刻还持仓的收这一期),再按最新状态调仓
    const settle = (upTo: number) => { while (fi < pts.length && pts[fi]!.ts <= upTo) { const f = pts[fi]!; if (pq > 0 && f.ts > entryFillAt) { const got = pq * (Number.isFinite(lastPerp) ? lastPerp : pEntry) * f.rate; cash += got; funding += got; } fi++; } };
    settle(open);
    // 开盘:按最新状态调仓(两腿都有 K 线才动)
    while (si < sig.length && sig[si]!.ts <= open) { want = sig[si]!.hold; si++; }
    if (s && q) {
      const so = Number(s.open), po = Number(q.open), inPos = sq > 0;
      if (want && !inPos) {
        const eq = cash, n = eq / 2, sFill = so * (1 + slip), pFill = po * (1 - slip), f = n * fs + n * fp;
        sq = n / sFill; pq = n / pFill; pEntry = pFill; cash = eq - n - f; fees += f;
        entry = { at: open, equity: eq, fees: f, spot: sFill }; entryFillAt = open;
      } else if (want && inPos) {
        // 两腿名义偏离权益一半超过带宽 → 调回(先按开盘估权益)
        const eq = cash + sq * so + pq * (pEntry - po), target = eq / 2, band = p.rebalance_band ?? 0.2;
        if (eq > 0 && Math.abs(pq * po - target) / target > band) {
          const dS = target / so - sq, dP = target / po - pq;
          const sFill = so * (dS > 0 ? 1 + slip : 1 - slip), pFill = po * (dP > 0 ? 1 - slip : 1 + slip);
          const f = Math.abs(dS) * sFill * fs + Math.abs(dP) * pFill * fp;
          cash -= dS * sFill + f; sq += dS;
          // 永续:已实现旧仓的盈亏入现金,按新数量以新成交价重开均价(1 倍逐仓的等价记账)
          cash += pq * (pEntry - pFill); pq += dP; pEntry = pFill;
          fees += f; if (entry) entry.fees += f; rebalances++;
        }
      } else if (!want && inPos) {
        const sFill = so * (1 - slip), pFill = po * (1 + slip), sv = sq * sFill, pv = pq * pFill, f = sv * fs + pv * fp;
        cash += sv + pq * (pEntry - pFill) - f; fees += f;
        if (entry) trades.push({ symbol: x.symbol, side: 'long', entry_at: entry.at, exit_at: open, entry_price: entry.spot, exit_price: sFill, return_pct: cash / entry.equity - 1, fees: (entry.fees + f) / entry.equity, open: false });
        sq = 0; pq = 0; entry = null;
      }
    }
    if (s) lastSpot = Number(s.close); if (q) lastPerp = Number(q.close);
    // 资金费:结算时刻落在 (入场成交, 本根收盘] 且仍持仓
    settle(close);
    const eq = equity(), gross = sq ? sq * lastSpot + pq * lastPerp : 0;
    samples.push({ at: close, equity: eq, exposure: eq > 0 ? gross / eq : 0, net_exposure: eq > 0 && sq ? (sq * lastSpot - pq * lastPerp) / eq : 0 });
    bars++; if (sq > 0) holdBars++;
  }
  if (entry && sq > 0) trades.push({ symbol: x.symbol, side: 'long', entry_at: entry.at, exit_at: samples.at(-1)?.at ?? win.to_ms, entry_price: entry.spot, exit_price: lastSpot, return_pct: equity() / entry.equity - 1, fees: entry.fees / entry.equity, open: true });
  if (!pts.length) notes.push(`${x.symbol} 窗口内没有资金费序列,不交易`);
  return { samples, trades, fees, funding, decisions: sig.filter((z) => z.ts >= win.from_ms && z.ts <= win.to_ms).length, hold_fraction: bars ? holdBars / bars : 0, rebalances, notes };
}
