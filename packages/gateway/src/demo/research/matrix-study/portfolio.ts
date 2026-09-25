/**
 * 留出段账户级回放(组合级回测,Jacky 09-25 验收项「带判断 + portfolio 下单」)。纯函数。
 *
 * 输入是 finalist 的 IR 在研究资产池全部资产上、留出段的一次订单核运行结果:每个资产的已平仓交易(100% 权益单位仓位,
 * return_pct 已扣手续费 / 滑点 / 资金费)+ 每个候选的快照(入场价 / 止损价)与判断决策(code 臂为 null)。
 * 口径(与 judgment-replay/account.ts 同思路,参数不同):
 *   - 同初始资金(缺省 10000),按入场时间顺序(同刻按资产代码)先结算已到期持仓再开新单,已实现权益复利;
 *   - 每笔风险 = 当前已实现权益 × risk_pct,名义 = 风险 ÷ 止损距离(|入场 − 止损| ÷ 入场),单笔名义 ≤ 当前权益;
 *   - 同时持仓 ≤ max_open,总名义 ≤ gross_cap × 权益(现货 1、永续 3),超了这一单跳过(skipped_by_capacity,不排队);
 *   - code_judge 臂被判断跳过的候选不会产生交易(订单核已过滤),计 skipped_by_judge;决策来自同一 judge 账本,已决策的复用不重复计费;
 *   - 盈亏 = return_pct × 名义,平仓时入账;回撤按平仓入账时的已实现权益记(不盯市,偏乐观);
 *   - 单资产订单核里「持仓中同向新信号忽略」造成的路径依赖原样保留(交易来自订单核,不重排)。
 */
export interface ReplayTrade { symbol: string; entry_at: number; exit_at: number; return_pct: number }
export interface ReplayCandidate { symbol: string; as_of: number; entry: string; stop: string; action: 'follow' | 'skip' | null }
export interface PortfolioOptions { initial?: number; risk_pct?: number; max_open?: number; gross_cap?: number }
export interface PortfolioSummary {
  initial: number; risk_pct: number; max_open: number; gross_cap: number;
  total_return: number; max_drawdown: number; trades: number;
  skipped_by_judge: number; skipped_by_capacity: number; skipped_no_stop: number;
  /** 持仓时间加权的平均名义 / 权益 */
  exposure: number;
  /** 平仓入账点的权益曲线(≤ 120 点) */
  equity: { at: number; equity: number }[];
}
export const PORTFOLIO_DEFAULTS = { initial: 10_000, risk_pct: 0.005, max_open: 3 } as const;

function downsample<T>(xs: T[], max = 120): T[] { if (xs.length <= max) return xs; const out: T[] = []; for (let i = 0; i < max; i++) out.push(xs[Math.round((i * (xs.length - 1)) / (max - 1))]!); return out; }

/** 交易匹配入场前最近的候选(同资产、as_of ≤ entry_at),取止损距离 */
function stopDistance(t: ReplayTrade, cands: ReplayCandidate[]): number | null {
  let best: ReplayCandidate | null = null;
  for (const c of cands) if (c.symbol === t.symbol && c.action !== 'skip' && c.as_of <= t.entry_at && (!best || c.as_of > best.as_of)) best = c;
  if (!best) return null;
  const e = Number(best.entry), s = Number(best.stop);
  return e > 0 && s > 0 && e !== s ? Math.abs(e - s) / e : null;
}

export function accountReplay(trades: ReplayTrade[], candidates: ReplayCandidate[], o: PortfolioOptions & { gross_cap: number }): PortfolioSummary {
  const initial = o.initial ?? PORTFOLIO_DEFAULTS.initial, risk = o.risk_pct ?? PORTFOLIO_DEFAULTS.risk_pct, maxOpen = o.max_open ?? PORTFOLIO_DEFAULTS.max_open;
  let eq = initial, peak = initial, mdd = 0, n = 0, capSkip = 0, noStop = 0, expo = 0, span = 0;
  const open: { exit_at: number; pnl: number; notional: number; entry_at: number }[] = [], curve: { at: number; equity: number }[] = [];
  const settle = (upTo: number) => {
    for (const c of open.filter((x) => x.exit_at <= upTo).sort((a, b) => a.exit_at - b.exit_at)) {
      expo += (c.notional / Math.max(eq, 1e-9)) * (c.exit_at - c.entry_at);
      eq += c.pnl; open.splice(open.indexOf(c), 1); peak = Math.max(peak, eq); mdd = Math.max(mdd, peak > 0 ? 1 - eq / peak : 0); curve.push({ at: c.exit_at, equity: eq });
    }
  };
  const sorted = [...trades].sort((a, b) => a.entry_at - b.entry_at || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  const t0 = sorted[0]?.entry_at ?? 0, t1 = Math.max(0, ...sorted.map((t) => t.exit_at));
  span = Math.max(1, t1 - t0);
  for (const t of sorted) {
    settle(t.entry_at);
    const dist = stopDistance(t, candidates);
    if (dist === null) { noStop++; continue; }
    if (open.length >= maxOpen) { capSkip++; continue; }
    const notional = Math.min(eq, (eq * risk) / dist), gross = open.reduce((a, c) => a + c.notional, 0);
    if (!(notional > 0) || gross + notional > o.gross_cap * eq + 1e-9) { capSkip++; continue; }
    open.push({ exit_at: t.exit_at, pnl: t.return_pct * notional, notional, entry_at: t.entry_at }); n++;
  }
  settle(Infinity);
  return {
    initial, risk_pct: risk, max_open: maxOpen, gross_cap: o.gross_cap, total_return: eq / initial - 1, max_drawdown: mdd, trades: n,
    skipped_by_judge: candidates.filter((c) => c.action === 'skip').length, skipped_by_capacity: capSkip, skipped_no_stop: noStop,
    exposure: expo / span, equity: downsample(curve),
  };
}
