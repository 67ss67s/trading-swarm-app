/**
 * 批量研究的评估(零模型,纯计算;设计见 docs/research/batch-study-2026-09-23.md 第三、五、六节)。
 *
 * 单资产 IR 变体:
 *   - 执行复用改进环的 runPool(同一执行器选择、同一费率口径:现货 0.1%、永续 0.05%/0.02%,滑点 5bp),训练 + 验证段一次连续跑完,
 *     另以 2 倍手续费再跑一次做压力;留出段单独跑(只给每族冠军)。
 *   - 波动率目标(ma_trend 族):在单位仓位的净值路径上逐段缩放(见 volTargetEquity)。
 *   - 切段:每个资产把净值、持有基准按 UTC 日取最后一点,前面补上「段首前最后一点」作起点,归一到 1;交易统计仅包含段内入场且段内退出的成熟交易；跨边界仓位收益按净值盯市归段。
 *   - 资产池:段首已有预热(该资产回测起点 ≤ 段首 + 段长 5%)的资产才算成员,等资金、各自记账、不再平衡 = 成员归一净值的算术平均。
 *     晚上市的币不进早期分段(不按闲置现金摊薄),成员名单写进结果。
 * 指标:日收益夏普(年化 √365)、日收盘回撤、总收益、压力收益、平均敞口、笔数、每笔扣成本期望(return_pct 均值)、胜率;
 *   基准:资产池等权持有、同敞口持有(持有 × 敞口,空头取负号)、BTC 持有。
 */
import type { ResearchBar, StrategyIR } from '@trading-swarm/contracts';
import { hash } from '../primitives.js';
import { runPool, type EvalEnv, type PoolRun, type Window } from '../improve/evaluate.js';
import { mean, stdev, moments, periodSharpe } from '../improve/stats.js';
import type { Segments } from '../improve/types.js';
import type { VolTarget } from './families.js';

export const DAY = 86400000;
export const STRESS_MULTIPLE = 2;
/** 资产进段资格的宽限:段长的 5% */
export const ELIGIBLE_SLACK = 0.05;
/** 一个资产在一段里的切片(日粒度,已归一) */
export interface AssetSlice {
  symbol: string;
  eligible: boolean;
  /** 日序号(floor(at/DAY));第 0 个是段首前最后一点所在日 */
  days: number[];
  eq: number[];
  stress: number[];
  hold: number[];
  trades: number;
  trade_returns: number[];
  exposure: number;
  fees: number;
}
export interface PoolScore {
  members: string[];
  trades: number;
  total_return: number;
  sharpe: number | null;
  /** 日收益夏普(不年化),Deflated Sharpe 用 */
  period_sharpe: number | null;
  days: number;
  skew: number;
  kurtosis: number;
  max_drawdown: number;
  exposure: number;
  expectancy: number | null;
  win_rate: number | null;
  stressed_return: number | null;
  hold_return: number | null;
  exposure_matched_hold: number | null;
  btc_hold_return: number | null;
  /** 日收益序列(给 Deflated Sharpe 方差、相关性用) */
  returns: number[];
}
export interface VariantSegments { train: AssetSlice[]; validation: AssetSlice[] }

/** 某段的切片:净值/压力/持有按 UTC 日最后一点,起点 = 段首前最后一点(没有则段内第一点)。 */
export function sliceAsset(symbol: string, samples: { at: number; equity: number; exposure: number; bench: number | null }[], stressSamples: { at: number; equity: number }[] | null, trades: { entry_at: number; exit_at: number; return_pct: number; fees: number }[], seg: Window, runStart: number | null): AssetSlice {
  const inside = samples.filter((s) => s.at >= seg.from_ms && s.at <= seg.to_ms), before = samples.filter((s) => s.at < seg.from_ms).at(-1);
  // 资格:回测起点不晚于段首 + 段长 5%(同一批上市的币差几天不该被整段剔掉;晚到的这几天按现金计)
  const eligible = runStart !== null && runStart <= seg.from_ms + ELIGIBLE_SLACK * (seg.to_ms - seg.from_ms) && inside.length > 0;
  const pts = before ? [before, ...inside] : inside;
  const dayOf = (t: number) => Math.floor(t / DAY);
  // 起点单独占一格:若与段内第一天同日,起点放前一天
  const first = pts[0];
  const days: number[] = [], eq: number[] = [], hold: number[] = [];
  if (first) {
    const d0 = Math.min(dayOf(first.at), (inside[0] ? dayOf(inside[0].at) : dayOf(first.at)) - 1);
    const map = new Map<number, (typeof pts)[number]>([[d0, first]]);
    for (const p of inside) map.set(dayOf(p.at), p);
    const e0 = first.equity, b0 = first.bench;
    for (const [d, p] of [...map.entries()].sort((a, b) => a[0] - b[0])) { days.push(d); eq.push(e0 > 0 ? p.equity / e0 : 1); hold.push(b0 && p.bench ? p.bench / b0 : 1); }
  }
  let stress: number[] = [];
  if (stressSamples && first) {
    const sIn = stressSamples.filter((s) => s.at >= seg.from_ms && s.at <= seg.to_ms), sB = stressSamples.filter((s) => s.at < seg.from_ms).at(-1) ?? sIn[0];
    const m = new Map<number, number>(); for (const p of sIn) m.set(dayOf(p.at), p.equity);
    let lastV = sB?.equity ?? 1; stress = days.map((d, i) => { if (i === 0) return 1; const v = m.get(d); if (v !== undefined) lastV = v; return sB && sB.equity > 0 ? lastV / sB.equity : 1; });
  }
  const lo = first ? first.at : seg.from_ms - 1, segTrades = trades.filter((t) => t.exit_at <= seg.to_ms && t.entry_at > lo && t.entry_at <= seg.to_ms);
  return { symbol, eligible, days, eq, stress, hold, trades: segTrades.length, trade_returns: segTrades.map((t) => t.return_pct), exposure: inside.length ? mean(inside.map((s) => s.exposure)) : 0, fees: segTrades.reduce((a, t) => a + t.fees, 0) };
}

/** 成员归一净值的算术平均(日网格取并集、前值填充)→ 资产池指标。sign=-1 时同敞口持有取负(空头)。 */
export function poolScore(slices: AssetSlice[], sign: 1 | -1 = 1, btcSymbol = 'BTCUSDT'): PoolScore {
  const mem = slices.filter((s) => s.eligible && s.days.length >= 2);
  const grid = [...new Set(mem.flatMap((s) => s.days))].sort((a, b) => a - b);
  const curve = (pick: (s: AssetSlice) => number[]) => {
    const ptr = mem.map(() => 0), val = mem.map((s) => pick(s)[0] ?? 1);
    return grid.map((d) => { let sum = 0; mem.forEach((s, k) => { const arr = pick(s); while (ptr[k]! < s.days.length && s.days[ptr[k]!]! <= d) { val[k] = arr[ptr[k]!] ?? val[k]!; ptr[k]!++; } sum += val[k]!; }); return sum / mem.length; });
  };
  const P = mem.length ? curve((s) => s.eq) : [], S = mem.length && mem.every((s) => s.stress.length) ? curve((s) => s.stress) : null, Hc = mem.length ? curve((s) => s.hold) : [];
  const r: number[] = []; for (let i = 1; i < P.length; i++) if (P[i - 1]! > 0) r.push(P[i]! / P[i - 1]! - 1);
  let peak = -Infinity, mdd = 0; for (const v of P) { peak = Math.max(peak, v); if (peak > 0) mdd = Math.max(mdd, 1 - v / peak); }
  const ps = periodSharpe(r), mo = moments(r), tr = mem.flatMap((s) => s.trade_returns), exposure = mem.length ? mean(mem.map((s) => s.exposure)) : 0;
  const hold = Hc.length ? Hc.at(-1)! - 1 : null, btc = mem.find((s) => s.symbol === btcSymbol);
  return {
    members: mem.map((s) => s.symbol), trades: mem.reduce((a, s) => a + s.trades, 0), total_return: P.length ? P.at(-1)! - 1 : 0, sharpe: ps === null ? null : ps * Math.sqrt(365), period_sharpe: ps, days: r.length, skew: mo.skew, kurtosis: mo.kurtosis, max_drawdown: mdd, exposure,
    expectancy: tr.length ? mean(tr) : null, win_rate: tr.length ? tr.filter((x) => x > 0).length / tr.length : null, stressed_return: S ? S.at(-1)! - 1 : null,
    hold_return: hold, exposure_matched_hold: hold === null ? null : sign * hold * exposure, btc_hold_return: btc && btc.hold.length ? btc.hold.at(-1)! - 1 : null, returns: r,
  };
}

/** 单资产年化实现波动:time 之前已收盘的最近 days 天(按根数折算)对数收益的标准差 × √(每年根数)。 */
export function realizedVol(bars: ResearchBar[], before_ms: number, step: number, days: number): number | null {
  let end = -1; for (let lo = 0, hi = bars.length - 1; lo <= hi;) { const m = (lo + hi) >> 1; if (bars[m]!.close_time < before_ms) { end = m; lo = m + 1; } else hi = m - 1; }
  const n = Math.max(5, Math.round((days * DAY) / step)); if (end < n) return null;
  const r: number[] = []; for (let i = end - n + 1; i <= end; i++) { const a = Number(bars[i - 1]!.close), b = Number(bars[i]!.close); if (a > 0 && b > 0) r.push(Math.log(b / a)); }
  const sd = stdev(r); return sd > 0 ? sd * Math.sqrt((365 * DAY) / step) : null;
}
/**
 * 波动率目标:把单位仓位(每笔 100% 权益)的净值路径逐段缩放。持仓段 = 连续敞口 > 0 的点 + 其后第一点(离场成交所在根);
 * 段参考点 = 段前最后一点;w = min(1, 目标年化 / 入场前实现波动)。段内 E_vt = E_vt(ref) × (1 + w × (E_u/E_u(ref) − 1)),段外随单位净值同比变动。
 * 每资产同时只有一笔、手续费与名义值成比例,所以这等价于每笔按 w × 权益下单(忽略名义值取整)。返回新净值与每笔权重(按入场时间)。
 */
export function volTargetEquity(samples: { at: number; equity: number; exposure: number; bench: number | null }[], bars: ResearchBar[], step: number, vt: VolTarget): { samples: typeof samples; weights: Map<number, number> } {
  const out: typeof samples = [], weights = new Map<number, number>();
  let i = 0, E = samples[0]?.equity ?? 0;
  while (i < samples.length) {
    const s = samples[i]!;
    if (i > 0 && s.exposure > 0 && samples[i - 1]!.exposure <= 0) {
      const ref = samples[i - 1]!, Eref = E, sigma = realizedVol(bars, s.at - step + 1, step, vt.days), w = sigma ? Math.min(1, vt.annual / sigma) : 1;
      weights.set(s.at, w);
      let j = i; for (; j < samples.length && samples[j]!.exposure > 0; j++) { const x = samples[j]!; E = Eref * (1 + w * (x.equity / ref.equity - 1)); out.push({ ...x, equity: E, exposure: x.exposure * w }); }
      if (j < samples.length) { const x = samples[j]!; E = Eref * (1 + w * (x.equity / ref.equity - 1)); out.push({ ...x, equity: E }); j++; }
      i = j; continue;
    }
    if (i > 0 && samples[i - 1]!.equity > 0) E = E * (s.equity / samples[i - 1]!.equity);
    out.push({ ...s, equity: E }); i++;
  }
  return { samples: out, weights };
}

/** 每笔交易的权重:取入场时间落在的那个持仓段的 w(找不到按 1) */
const weightOf = (weights: Map<number, number>, entry_at: number, step: number) => { let best = 1, bt = -Infinity; for (const [t, w] of weights) if (t >= entry_at && t - entry_at < 2 * step && t > bt) { best = w; bt = t; } return best; };

/** 从一次 PoolRun 取某资产的样本(带基准)与交易 */
function assetSamples(run: PoolRun, symbol: string) {
  const p = run.per_asset.find((x) => x.symbol === symbol);
  if (!p || p.status !== 'completed') return null;
  return { samples: p.equity.map((e) => ({ at: e.at, equity: e.equity, exposure: e.exposure, bench: p.bench.get(e.at) ?? null })), trades: p.trades, start: p.equity[0]?.at ?? null };
}

/** 单资产 IR 变体:在 window 上正常 + 压力各跑一次,切出 segs 里各段的资产切片。 */
export async function evaluateIrVariant(env: EvalEnv, ir: StrategyIR, window: Window, segs: Record<string, Window>, opts: { vol_target?: VolTarget } = {}): Promise<{ slices: Record<string, AssetSlice[]>; warnings: string[]; engine: string }> {
  const key = hash(ir), run = await runPool(env, ir, key, window), stressed = await runPool(env, ir, key, window, { feeMultiple: STRESS_MULTIPLE });
  const step = env.data.timeframe_ms, slices: Record<string, AssetSlice[]> = {};
  for (const name of Object.keys(segs)) slices[name] = [];
  for (const a of env.data.assets) {
    const x = assetSamples(run, a.symbol), y = assetSamples(stressed, a.symbol);
    for (const [name, seg] of Object.entries(segs)) {
      if (!x) { slices[name]!.push({ symbol: a.symbol, eligible: false, days: [], eq: [], stress: [], hold: [], trades: 0, trade_returns: [], exposure: 0, fees: 0 }); continue; }
      let samples = x.samples, sSamples = y?.samples ?? null, trades = x.trades.map((t) => ({ entry_at: t.entry_at, exit_at: t.exit_at, return_pct: t.return_pct, fees: t.fees }));
      if (opts.vol_target) {
        const vt = volTargetEquity(x.samples, a.bars, step, opts.vol_target);
        samples = vt.samples; if (y) sSamples = volTargetEquity(y.samples, a.bars, step, opts.vol_target).samples;
        trades = trades.map((t) => { const w = weightOf(vt.weights, t.entry_at, step); return { ...t, return_pct: t.return_pct * w, fees: t.fees * w }; });
      }
      slices[name]!.push(sliceAsset(a.symbol, samples, sSamples, trades, seg, x.start));
    }
  }
  return { slices, warnings: run.warnings.slice(0, 20), engine: run.engine_version };
}

/** 训练 + 验证连续窗口(留出段不碰) */
export const trainValWindow = (s: Segments): Window => ({ from_ms: s.train.from_ms, to_ms: s.validation.to_ms });
