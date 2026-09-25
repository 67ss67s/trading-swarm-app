/**
 * 4h 永续均线趋势 · 杠杆 × 组合仓位研究的纯函数(零模型;报告 docs/research/perp-trend-portfolio-2026-09-23.md)。
 *
 * 输入是每个资产「单资产子账户」的净值路径:同一 IR 在订单执行核里按固定保证金占比 mf(例如 0.25)× 杠杆 L 逐仓下单,
 *   这样一笔被强平只损失子账户的 mf,子账户不会归零、后续信号照常出现(mf=1 时强平一次子账户就死了)。
 *   一段持仓(episode)= 连续敞口 > 0 的样本 + 其后第一个样本(离场成交所在根);参考点 = 段前最后一个样本(信号根收盘)。
 *   该笔在保证金上的收益 = (E(t)/E(ref) − 1)/mf,手续费、资金费、强平都已在执行核里按名义值计入,与保证金成比例,所以可以按任意保证金缩放。
 * 组合(simulatePortfolio):一个共享现金账户,$10k 起;某资产开仓时按仓位规则取权重 w,保证金 m = min(w × 组合权益(信号根收盘), 可用现金),
 *   持仓价值 V(t) = m × (1 + 该笔在保证金上的收益到 t),离场时 V 回到现金。仓位规则(预先写死):
 *   - equal:w = 1/N(N = 该段资产池成员数);
 *   - equal_vt:w = (1/N) × min(1, 年化目标 / σ_i)(= 批量研究的 50% 波动率目标,只是放进共享资金账户);
 *   - inv_vol:w = (1/σ_i) / Σ_{j∈成员,σ_j 可得}(1/σ_j)(等风险;σ 在信号根收盘时刻算,成员全体一起归一,Σw = 1)。
 *   σ = 入场前已收盘的最近 20 天 4h 对数收益标准差年化(batch/evaluate.ts 的 realizedVol,由调用方以回调给)。
 * 基准:资产池等权持有(各成员归一持有价值的算术平均,晚到成员此前按 1)、等风险持有(段首按 1/σ 定权后不再平衡)、BTC 持有、
 *   同敞口持有 = 对应持有收益 × 策略平均敞口(名义/权益,含杠杆,可 > 1)。
 */
import { median, mean, stdev } from '../improve/stats.js';

export const PT_INITIAL = 10000;
export interface UnitPath {
  symbol: string;
  eligible: boolean;
  /** 子账户下单的保证金占比(执行核 margin_fraction) */
  mf: number;
  at: number[]; equity: number[];
  /** 名义值 / 子账户权益 */
  exposure: number[];
  /** 与 at 对齐的买入持有价值(同费率口径),缺为 null */
  bench: (number | null)[];
  /** 执行核的逐笔出场原因(按入场时间),用来数强平 */
  exits?: { entry_at: number; reason: string }[];
}
export type Sizing = 'equal' | 'equal_vt' | 'inv_vol';
export interface PortfolioTrade { symbol: string; entry_at: number; exit_at: number; weight: number; margin: number; ret_on_margin: number; pnl: number; open: boolean; reason: string | null }
export interface PortfolioRun { at: number[]; equity: number[]; exposure: number[]; trades: PortfolioTrade[]; cash_capped: number }
export type SigmaFn = (symbol: string, before_ms: number) => number | null;

/** 一个路径里的持仓段:[ref, first, last](last = 离场成交所在样本;期末仍持有时 last = 最后一个样本且 open=true) */
export function episodes(p: Pick<UnitPath, 'exposure'>): { ref: number; first: number; last: number; open: boolean }[] {
  const out: { ref: number; first: number; last: number; open: boolean }[] = [], n = p.exposure.length;
  for (let i = 1; i < n; i++) {
    if (!(p.exposure[i]! > 0 && p.exposure[i - 1]! <= 0)) continue;
    let j = i; while (j < n && p.exposure[j]! > 0) j++;
    if (j < n) { out.push({ ref: i - 1, first: i, last: j, open: false }); i = j; } else { out.push({ ref: i - 1, first: i, last: n - 1, open: true }); i = n; }
  }
  return out;
}

/** 截尾均值:两端各去掉 frac(向下取整个数) */
export function trimmedMean(xs: number[], frac = 0.1): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), k = Math.floor(s.length * frac), mid = s.slice(k, s.length - k);
  return mid.length ? mean(mid) : mean(s);
}

export function weightOf(sizing: Sizing, symbol: string, before_ms: number, members: string[], sigma: SigmaFn, vtAnnual = 0.5): number {
  const N = Math.max(1, members.length), s = sigma(symbol, before_ms);
  if (sizing === 'equal') return 1 / N;
  if (sizing === 'equal_vt') return s ? Math.min(1, vtAnnual / s) / N : 1 / N;
  if (!s) return 1 / N;
  let denom = 0; for (const m of members) { const x = sigma(m, before_ms); if (x) denom += 1 / x; }
  return denom > 0 ? (1 / s) / denom : 1 / N;
}

/** 共享资金组合模拟(见文件头)。paths 只取 eligible 的;members = 这些资产的代码。 */
export function simulatePortfolio(paths: UnitPath[], sizing: Sizing, sigma: SigmaFn, opts: { initial?: number; vtAnnual?: number } = {}): PortfolioRun {
  const mem = paths.filter((p) => p.eligible && p.at.length >= 2), members = mem.map((p) => p.symbol);
  const grid = [...new Set(mem.flatMap((p) => p.at))].sort((a, b) => a - b);
  type Ep = { ref: number; first: number; last: number; open: boolean };
  const eps = mem.map((p) => episodes(p)), starts = mem.map((p, k) => new Map<number, Ep>(eps[k]!.map((e) => [p.at[e.first]!, e])));
  const ptr = mem.map(() => 0), active: ({ e: Ep; m: number; V: number; w: number; entry_at: number } | null)[] = mem.map(() => null);
  const Phist = new Map<number, number>();
  let C = opts.initial ?? PT_INITIAL, capped = 0, lastP = C;
  const out: PortfolioRun = { at: [], equity: [], exposure: [], trades: [], cash_capped: 0 };
  const ret = (p: UnitPath, e: Ep, i: number) => (p.equity[e.ref]! > 0 ? (p.equity[i]! / p.equity[e.ref]! - 1) / p.mf : 0);
  const reasonOf = (p: UnitPath, t: number) => { let best: string | null = null, bt = Infinity; for (const x of p.exits ?? []) { const d = Math.abs(x.entry_at - t); if (d < bt && d <= 8 * 3600000) { bt = d; best = x.reason; } } return best; };
  for (const t of grid) {
    const entering: number[] = [];
    // 先结算已有持仓(含离场),再开新仓(同根离场释放的现金可用)
    mem.forEach((p, k) => {
      while (ptr[k]! < p.at.length && p.at[ptr[k]!]! < t) ptr[k]!++;
      const i = ptr[k]!; if (i >= p.at.length || p.at[i] !== t) return;
      const a = active[k];
      if (a) {
        a.V = a.m * (1 + ret(p, a.e, i));
        if (i === a.e.last && !a.e.open) { C += a.V; out.trades.push({ symbol: p.symbol, entry_at: a.entry_at, exit_at: t, weight: a.w, margin: a.m, ret_on_margin: a.V / a.m - 1, pnl: a.V - a.m, open: false, reason: reasonOf(p, a.entry_at) }); active[k] = null; }
      }
      if (!active[k] && starts[k]!.has(t)) entering.push(k);
    });
    for (const k of entering) {
      const p = mem[k]!, e = starts[k]!.get(t)!, refAt = p.at[e.ref]!, Pref = Phist.get(refAt) ?? lastP;
      const w = weightOf(sizing, p.symbol, refAt + 1, members, sigma, opts.vtAnnual), want = w * Pref, m = Math.min(want, Math.max(0, C));
      if (m < want - 1e-9) capped++;
      if (!(m > 1e-9)) continue;
      C -= m; active[k] = { e, m, V: m * (1 + ret(p, e, e.first)), w: m / Pref, entry_at: t };
      if (e.first === e.last && !e.open) { const a = active[k]!; C += a.V; out.trades.push({ symbol: p.symbol, entry_at: t, exit_at: t, weight: a.w, margin: a.m, ret_on_margin: a.V / a.m - 1, pnl: a.V - a.m, open: false, reason: reasonOf(p, t) }); active[k] = null; }
    }
    let P = C, notional = 0;
    mem.forEach((p, k) => { const a = active[k]; if (!a) return; P += a.V; const j = Math.min(ptr[k]!, p.at.length - 1), i = p.at[j]! <= t ? j : j - 1, E = p.equity[i]!, Eref = p.equity[a.e.ref]!; if (Eref > 0) notional += p.exposure[i]! * E * (a.m / (p.mf * Eref)); });
    Phist.set(t, P); lastP = P;
    out.at.push(t); out.equity.push(P); out.exposure.push(P > 0 ? notional / P : 0);
  }
  mem.forEach((p, k) => { const a = active[k]; if (a) out.trades.push({ symbol: p.symbol, entry_at: a.entry_at, exit_at: p.at.at(-1)!, weight: a.w, margin: a.m, ret_on_margin: a.V / a.m - 1, pnl: a.V - a.m, open: true, reason: 'open' }); });
  out.cash_capped = capped;
  return out;
}

/** 按 UTC 日取最后一点的日收益 */
export function dailyCurve(at: number[], v: number[]): number[] {
  const m = new Map<number, number>(); at.forEach((t, i) => m.set(Math.floor(t / 86400000), v[i]!));
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1]);
}
export interface CurveStats { total_return: number; sharpe: number | null; max_drawdown: number; days: number; final_usd: number; pnl_usd: number }
/** 收益、日收益夏普(年化 √365)、回撤(按 4h 收盘逐点,比日收盘更严)、$ 盈亏(按 initial 起) */
export function curveStats(at: number[], v: number[], initial = PT_INITIAL): CurveStats {
  if (v.length < 2) return { total_return: 0, sharpe: null, max_drawdown: 0, days: 0, final_usd: initial, pnl_usd: 0 };
  const d = dailyCurve(at, v), r: number[] = []; for (let i = 1; i < d.length; i++) if (d[i - 1]! > 0) r.push(d[i]! / d[i - 1]! - 1);
  let peak = -Infinity, mdd = 0; for (const x of v) { peak = Math.max(peak, x); if (peak > 0) mdd = Math.max(mdd, 1 - x / peak); }
  const sd = stdev(r), tr = v.at(-1)! / v[0]! - 1;
  return { total_return: tr, sharpe: r.length >= 2 && sd > 0 ? (mean(r) / sd) * Math.sqrt(365) : null, max_drawdown: mdd, days: r.length, final_usd: initial * (1 + tr), pnl_usd: initial * tr };
}

/** 逐笔统计(保证金上的收益,含杠杆,扣费与资金费):笔数、均值、中位数、两端各 10% 截尾均值、胜率、强平笔数 */
export function tradeSummary(trades: PortfolioTrade[]): { n: number; closed: number; mean: number | null; median: number | null; trimmed: number | null; win_rate: number | null; liquidations: number } {
  const closed = trades.filter((t) => !t.open), xs = closed.map((t) => t.ret_on_margin);
  return { n: trades.length, closed: closed.length, mean: xs.length ? mean(xs) : null, median: median(xs), trimmed: trimmedMean(xs, 0.1), win_rate: xs.length ? xs.filter((x) => x > 0).length / xs.length : null, liquidations: closed.filter((t) => t.reason === 'liquidation').length };
}

/**
 * 持有基准:weights = null 为等权(各成员归一持有价值的算术平均,成员开始前按 1),否则按给定权重(段首定权,不再平衡)。
 * 返回与 grid 对齐的组合持有价值(起点 1)。
 */
export function holdCurve(paths: UnitPath[], grid: number[], weights: Map<string, number> | null = null): number[] {
  const mem = paths.filter((p) => p.eligible && p.at.length >= 2);
  if (!mem.length) return grid.map(() => 1);
  const wsum = weights ? mem.reduce((a, p) => a + (weights.get(p.symbol) ?? 0), 0) : mem.length;
  const w = mem.map((p) => (weights ? (weights.get(p.symbol) ?? 0) / (wsum || 1) : 1 / mem.length));
  const b0 = mem.map((p) => p.bench.find((x) => x !== null && x > 0) ?? null), ptr = mem.map(() => 0), val = mem.map(() => 1);
  return grid.map((t) => {
    let s = 0;
    mem.forEach((p, k) => { while (ptr[k]! < p.at.length && p.at[ptr[k]!]! <= t) { const b = p.bench[ptr[k]!]; if (b !== null && b !== undefined && b0[k]) val[k] = b / b0[k]!; ptr[k]!++; } s += w[k]! * val[k]!; });
    return s;
  });
}

/** 预先声明的训练段选择规则:训练段回撤 ≤ maxDD 且已平仓笔数 ≥ minTrades 的配置里取训练段总收益最高;没有过门槛的取回撤最小。 */
export function selectConfig<T extends { id: string; train: { total_return: number; max_drawdown: number; trades: number } }>(rows: T[], maxDD = 0.35, minTrades = 30): { pick: T | null; passed: string[]; rule: string } {
  const ok = rows.filter((r) => r.train.max_drawdown <= maxDD && r.train.trades >= minTrades);
  const pool = ok.length ? ok : rows, key = ok.length ? (r: T) => r.train.total_return : (r: T) => -r.train.max_drawdown;
  const pick = [...pool].sort((a, b) => key(b) - key(a) || a.id.localeCompare(b.id))[0] ?? null;
  return { pick, passed: ok.map((r) => r.id), rule: ok.length ? `训练段回撤 ≤ ${maxDD * 100}% 且 ≥ ${minTrades} 笔的 ${ok.length} 个配置里取训练段总收益最高` : `没有配置过回撤门槛,取训练段回撤最小` };
}
