/**
 * 组合级原语:横截面动量调仓(portfolio_xsmom,2026-09-23 批量研究)。参数契约 packages/contracts/schema/research-batch.json#PortfolioXsmomParams。
 *
 * 语义(纯函数,零 IO):
 *  - 时间轴 = 所有资产 K 线 close_time 的并集(同周期、UTC 对齐),只取窗口 [from_ms, to_ms] 内的点;窗口前的 K 线只用来算回看收益。
 *  - 调仓时刻 t:weekly = 下一根开盘是周一 00:00 UTC 的那根收盘;daily = 下一根开盘是 UTC 00:00 的那根收盘。
 *  - 排名:t 时刻有收盘、且正好 lookback_days 天前也有收盘的资产才可排名;回看收益 = close_t / close_{t−N天} − 1。只用 ≤ t 的已收盘数据(因果)。
 *  - 持仓:long_only 等权持有前 top_k;long_short 多前 top_k、空后 top_k,多空各占一半权益(可排名资产 < 2×top_k 时两侧各取 ⌊n/2⌋)。
 *    abs_filter:回看收益 ≤ 0 的不做多(名额留现金),≥ 0 的不做空。select=random:同时刻、同名数随机挑(固定种子,随机入场基线)。
 *  - 成交:t 之后的下一根开盘按目标权重调到位;成交价向不利方向加滑点;成本 = 成交额 × 费率。某资产下一根没有 K 线就保持原仓位。
 *  - 盯市:每个时间点按各资产最近一根收盘估值;缺数据的资产沿用上一价。空头按线性合约记账(1 倍,不算保证金占用与强平)。
 *  - 资金费(long_short,可选):结算时刻 ts ∈ (上一点, 当前点] 时,多头付 / 空头收 名义值 × rate(名义值按当前点收盘)。
 *  - 「交易」= 某资产进入持仓到离开持仓的一段(中间的等权再平衡不拆单),收益按入场/离场成交价与两边费用算,给期望与笔数用。
 *  - 运行选项(不属参数契约,缺省不启用,旧结果逐位不变;2026-09-23 按时点资产池):
 *    eligible(t) = 调仓时刻 t 的可排名成员(按时点资产池),不在集合里的资产不参与排名(已持有的随调仓卖出);
 *    liquidate_delisted = 资产最后一根 K 线之后(退市/下架)仍有持仓的,在下一个时间点按最后收盘向不利方向加滑点、扣费清算成现金,
 *    不让它以最后价格永久留在权益里。
 */
import type { ResearchBar } from '@trade-gate/contracts';
import type { FundingSeries } from '../orders/types.js';

export interface PortfolioAsset { symbol: string; bars: ResearchBar[]; funding?: FundingSeries | null }
export interface PortfolioCost { fee_rate: number; slippage_bps: number }
export interface PortfolioSample { at: number; equity: number; /** 总名义 / 权益 */ exposure: number; /** 净名义(多 − 空)/ 权益 */ net_exposure: number }
export interface PortfolioTrade { symbol: string; side: 'long' | 'short'; entry_at: number; exit_at: number; entry_price: number; exit_price: number; return_pct: number; fees: number; open: boolean }
export interface PortfolioRebalance { at: number; ranked: number; holdings: { symbol: string; side: 'long' | 'short'; weight: number; score: number | null }[]; turnover: number; cost: number }
export interface PortfolioRun { samples: PortfolioSample[]; trades: PortfolioTrade[]; rebalances: PortfolioRebalance[]; fees: number; funding: number; notes: string[] }
export interface XsmomRunOptions { eligible?: (t: number) => ReadonlySet<string> | null; liquidate_delisted?: boolean }
export interface XsmomParams { lookback_days: number; top_k: number; rebalance: 'weekly' | 'daily'; abs_filter?: boolean; side?: 'long_only' | 'long_short'; select?: 'momentum' | 'random'; seed?: number }

export const DAY_MS = 86400000, WEEK_MS = 7 * DAY_MS;
/** 1970-01-01 是周四:t+1 − 4 天 能被 7 天整除 ⇔ t+1 是周一 00:00 UTC */
export const isRebalanceClose = (close_time: number, rebalance: XsmomParams['rebalance']): boolean => rebalance === 'daily' ? (close_time + 1) % DAY_MS === 0 : (close_time + 1 - 4 * DAY_MS) % WEEK_MS === 0;
/** mulberry32,与 improve/stats.ts 同式(原语不依赖改进环模块) */
function rng(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

interface Series { symbol: string; byClose: Map<number, number>; closes: number[]; opens: number[]; times: number[]; funding: FundingSeries | null }
function toSeries(a: PortfolioAsset): Series {
  const s: Series = { symbol: a.symbol, byClose: new Map(), closes: [], opens: [], times: [], funding: a.funding ?? null };
  for (const b of a.bars) { s.byClose.set(b.close_time, s.times.length); s.times.push(b.close_time); s.closes.push(Number(b.close)); s.opens.push(Number(b.open)); }
  return s;
}

/** 目标持仓(纯排名逻辑,单独导出给测试):返回 symbol → 带符号权重(多正空负,合计 |w| ≤ 1)。 */
export function xsmomTargets(scores: { symbol: string; score: number }[], p: XsmomParams, random?: () => number): Map<string, number> {
  const out = new Map<string, number>(), side = p.side ?? 'long_only', n = scores.length;
  if (!n) return out;
  let order: { symbol: string; score: number }[];
  if ((p.select ?? 'momentum') === 'random' && random) { order = [...scores].sort((a, b) => a.symbol.localeCompare(b.symbol)); for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; } }
  else order = [...scores].sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  if (side === 'long_only') {
    const k = Math.min(p.top_k, n), picks = order.slice(0, k).filter((x) => !p.abs_filter || x.score > 0);
    for (const x of picks) out.set(x.symbol, 1 / k);
    return out;
  }
  const k = Math.min(p.top_k, Math.floor(n / 2));
  if (k < 1) return out;
  for (const x of order.slice(0, k)) if (!p.abs_filter || x.score > 0) out.set(x.symbol, 0.5 / k);
  for (const x of order.slice(n - k)) if (!p.abs_filter || x.score < 0) out.set(x.symbol, -0.5 / k);
  return out;
}

export function runXsmom(assets: PortfolioAsset[], p: XsmomParams, win: { from_ms: number; to_ms: number }, cost: PortfolioCost, initial = 10000, opts: XsmomRunOptions = {}): PortfolioRun {
  const ser = assets.map(toSeries), notes: string[] = [], slip = cost.slippage_bps / 1e4, fee = cost.fee_rate, look = p.lookback_days * DAY_MS;
  const times = [...new Set(ser.flatMap((s) => s.times))].filter((t) => t >= win.from_ms && t <= win.to_ms).sort((a, b) => a - b);
  const random = (p.select ?? 'momentum') === 'random' ? rng(p.seed ?? 1) : undefined;
  const qty = new Map<string, number>(), last = new Map<string, number>(), openTrade = new Map<string, { side: 'long' | 'short'; entry_at: number; entry_price: number; fees: number }>();
  let cash = initial, fees = 0, funding = 0, pending: Map<string, number> | null = null, prevT = times.length ? times[0]! - 1 : 0;
  const samples: PortfolioSample[] = [], trades: PortfolioTrade[] = [], rebalances: PortfolioRebalance[] = [];
  const value = () => { let v = cash; for (const [s, q] of qty) v += q * (last.get(s) ?? 0); return v; };
  const closeTrade = (s: string, at: number, px: number, f: number, open = false) => {
    const o = openTrade.get(s); if (!o) return;
    const gross = o.side === 'long' ? px / o.entry_price - 1 : o.entry_price / px - 1;
    trades.push({ symbol: s, side: o.side, entry_at: o.entry_at, exit_at: at, entry_price: o.entry_price, exit_price: px, return_pct: gross - (o.fees + f), fees: o.fees + f, open });
    openTrade.delete(s);
  };
  const lastTime = new Map(ser.map((s) => [s.symbol, s.times.at(-1) ?? -Infinity]));
  let delisted = 0;
  for (const t of times) {
    // 0) 退市清算(选项):最后一根 K 线已过去的持仓按最后收盘清掉
    if (opts.liquidate_delisted) for (const [s, q] of [...qty]) {
      if (lastTime.get(s)! >= t) continue;
      const px = last.get(s) ?? 0, fill = q > 0 ? px * (1 - slip) : px * (1 + slip), f = Math.abs(q * fill) * fee;
      cash += q * fill - f; fees += f; qty.delete(s); delisted++;
      closeTrade(s, t, fill, fee);
    }
    // 1) 上一个调仓时刻定下的目标,在本根开盘成交(本根有 K 线的资产才动)
    if (pending) {
      const target = pending; pending = null;
      const opens = new Map<string, number>();
      for (const s of ser) { const i = s.byClose.get(t); if (i !== undefined) opens.set(s.symbol, s.opens[i]!); }
      let eq = cash; for (const [s, q] of qty) eq += q * (opens.get(s) ?? last.get(s) ?? 0);
      let turnover = 0, c = 0;
      const all = new Set([...qty.keys(), ...target.keys()]);
      for (const s of all) {
        const px = opens.get(s); if (px === undefined || !(px > 0)) continue;
        const cur = (qty.get(s) ?? 0) * px, want = (target.get(s) ?? 0) * eq, d = want - cur;
        if (Math.abs(d) < 1e-9 * Math.max(1, eq)) continue;
        const fill = d > 0 ? px * (1 + slip) : px * (1 - slip), dq = d / fill, f = Math.abs(d) * fee;
        const before = qty.get(s) ?? 0, after = before + dq;
        cash -= dq * fill + f; fees += f; c += f; turnover += Math.abs(d);
        const sideOf = (q: number) => (q > 1e-12 ? 'long' : q < -1e-12 ? 'short' : null);
        // 交易记账:方向变化或清仓即平旧开新(同向加减仓不拆单,费用按比例计入)
        const sb = sideOf(before), sa = sideOf(after);
        if (sb && sb !== sa) closeTrade(s, t, fill, Math.min(Math.abs(d), Math.abs(before * fill)) / Math.max(1e-12, Math.abs(before * fill)) * fee);
        if (sa && sa !== sb) openTrade.set(s, { side: sa, entry_at: t, entry_price: fill, fees: fee });
        if (Math.abs(after) < 1e-12) qty.delete(s); else qty.set(s, after);
        last.set(s, px);
      }
      rebalances.at(-1)!.turnover = eq > 0 ? turnover / eq : 0; rebalances.at(-1)!.cost = c;
    }
    // 2) 收盘盯市 + 资金费
    for (const s of ser) { const i = s.byClose.get(t); if (i !== undefined) last.set(s.symbol, s.closes[i]!); }
    for (const s of ser) {
      const q = qty.get(s.symbol); if (!q || !s.funding) continue;
      const px = last.get(s.symbol) ?? 0;
      for (const f of s.funding.points) if (f.ts > prevT && f.ts <= t) { const pay = q * px * f.rate; cash -= pay; funding -= pay; }
    }
    prevT = t;
    const eq = value(); let gross = 0, net = 0; for (const [s, q] of qty) { const v = q * (last.get(s) ?? 0); gross += Math.abs(v); net += v; }
    samples.push({ at: t, equity: eq, exposure: eq > 0 ? gross / eq : 0, net_exposure: eq > 0 ? net / eq : 0 });
    // 3) 调仓时刻:排名,下一根开盘成交(窗口最后一根不再下单)
    if (isRebalanceClose(t, p.rebalance) && t < times.at(-1)!) {
      const scores: { symbol: string; score: number }[] = [], members = opts.eligible?.(t) ?? null;
      for (const s of ser) { if (members && !members.has(s.symbol)) continue; const i = s.byClose.get(t), j = s.byClose.get(t - look); if (i === undefined || j === undefined) continue; const a = s.closes[j]!, b = s.closes[i]!; if (a > 0 && b > 0) scores.push({ symbol: s.symbol, score: b / a - 1 }); }
      const target = xsmomTargets(scores, p, random), byScore = new Map(scores.map((x) => [x.symbol, x.score]));
      pending = target;
      rebalances.push({ at: t, ranked: scores.length, holdings: [...target.entries()].map(([symbol, w]) => ({ symbol, side: w > 0 ? 'long' as const : 'short' as const, weight: Math.abs(w), score: byScore.get(symbol) ?? null })), turnover: 0, cost: 0 });
    }
  }
  // 期末仍持有的按最后收盘记一笔未平仓(open=true,不扣离场费),不计入已平仓统计由调用方决定
  const end = times.at(-1) ?? win.to_ms;
  for (const s of [...openTrade.keys()]) closeTrade(s, end, last.get(s) ?? 0, 0, true);
  if (delisted) notes.push(`退市清算 ${delisted} 次(按最后收盘加滑点扣费)`);
  if (!rebalances.length) notes.push('窗口内没有调仓时刻(可排名资产不足或窗口太短)');
  return { samples, trades, rebalances, fees, funding, notes };
}
