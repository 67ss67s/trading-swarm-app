/**
 * 矩阵研究的纯函数:选择段门槛与主因、Deflated Sharpe 敏感性、有效试验数、留出段块 bootstrap 检验、Holm 校正、配对差区间、十进制金额。
 * 零 IO、零随机外部状态(随机数全部来自 protocol.seed)。
 */
import type { SlimScore } from '../batch/study.js';
import { deflatedSharpe, mean, seededRandom, variance } from '../improve/stats.js';
import type { FailureCause, GateRow, HoldoutTest, MatrixProtocol } from './types.js';

// ---------------------------------------------------------------- 十进制金额(12 位小数,BigInt 记账)
const SCALE = 1_000_000_000_000n;
export function usdUnits(s: string): bigint {
  if (!/^(0|[1-9]\d*)(\.\d{1,12})?$/.test(s)) throw Error('usd_decimal_invalid');
  const [a, b = ''] = s.split('.');
  return BigInt(a!) * SCALE + BigInt(b.padEnd(12, '0'));
}
export function usdString(n: bigint): string {
  const neg = n < 0n, v = neg ? -n : n;
  const s = `${v / SCALE}.${(v % SCALE).toString().padStart(12, '0')}`.replace(/\.?0+$/, '') || '0';
  return neg && s !== '0' ? `-${s}` : s;
}
export const usdMul = (s: string, k: number): string => usdString(usdUnits(s) * BigInt(Math.max(0, Math.floor(k))));

// ---------------------------------------------------------------- 选择段门槛
/** 选择段不能靠这些门槛填零:样本不足 / 期望 / 2 倍费率 / 同敞口持有 / 回撤 / 时间块数 / DSR */
export function selectionGates(s: SlimScore, dsr: number | null, p: MatrixProtocol): GateRow[] {
  const blocks = Math.floor(s.days / Math.max(1, p.block_days));
  return [
    { name: `selection_trades>=${p.min_trades}`, ok: s.trades >= p.min_trades, value: s.trades },
    { name: `selection_blocks>=${p.min_blocks}`, ok: blocks >= p.min_blocks, value: blocks },
    { name: 'expectancy>0', ok: s.expectancy !== null && s.expectancy > 0, value: s.expectancy },
    { name: 'net_return>0', ok: s.total_return > 0, value: s.total_return },
    { name: 'stress_2x>0', ok: s.stressed_return !== null && s.stressed_return > 0, value: s.stressed_return },
    { name: 'beats_exposure_matched_hold', ok: s.exposure_matched_hold !== null && s.total_return > s.exposure_matched_hold, value: s.exposure_matched_hold === null ? null : s.total_return - s.exposure_matched_hold },
    { name: `max_drawdown<=${p.max_drawdown}`, ok: s.max_drawdown <= p.max_drawdown, value: s.max_drawdown },
    { name: `deflated_sharpe>=${p.min_dsr}`, ok: dsr !== null && dsr >= p.min_dsr, value: dsr },
  ];
}
/** pass = 门槛全过;near = 期望为正但有门没过(进迭代环的候选池);fail = 其余 */
export function verdictOf(gates: GateRow[], s: SlimScore | null): 'pass' | 'near' | 'fail' {
  if (!s) return 'fail';
  if (gates.every((g) => g.ok)) return 'pass';
  return s.expectancy !== null && s.expectancy > 0 && s.total_return > 0 ? 'near' : 'fail';
}
/**
 * 不合格主因(一格只给一个):
 *   样本不足(笔数 / 时间块不够)优先 —— 证据不够时不能说它「亏」;
 *   毛收益为正但扣费后为负或 2 倍费率为负 → cost_dominated;
 *   其余(毛收益也不行、跑输同敞口持有、回撤超限、DSR 不够)→ underperform_hold。
 */
export function causeOf(s: SlimScore | null, gross: number | null, gates: GateRow[]): FailureCause | null {
  if (!s) return 'unsupported_execution';
  if (gates.every((g) => g.ok)) return null;
  const bad = (prefix: string) => gates.some((g) => g.name.startsWith(prefix) && !g.ok);
  if (bad('selection_trades') || bad('selection_blocks')) return 'insufficient_evidence';
  const netBad = s.total_return <= 0 || (s.stressed_return !== null && s.stressed_return <= 0);
  if (netBad && gross !== null && gross > 0) return 'cost_dominated';
  return 'underperform_hold';
}

// ---------------------------------------------------------------- Deflated Sharpe 与有效试验数
export function dsrOf(s: SlimScore, trials: number, sharpeVariance: number): number | null {
  if (s.period_sharpe === null || s.days < 2) return null;
  return deflatedSharpe({ sharpe: s.period_sharpe, trials: Math.max(1, trials), sharpeVariance, days: s.days, skew: s.skew, kurtosis: s.kurtosis })?.dsr ?? null;
}
/** 选择段日收益两两相关(按日序号对齐,重叠 < 10 天的对不计)的平均值 */
export function averageCorrelation(series: { days: number[]; returns: number[] }[], maxPairs = 2000): number | null {
  const maps = series.map((s) => new Map(s.days.slice(1).map((d, i) => [d, s.returns[i]!] as const)));
  const cs: number[] = [];
  outer: for (let i = 0; i < maps.length; i++) for (let j = i + 1; j < maps.length; j++) {
    if (cs.length >= maxPairs) break outer;
    const a: number[] = [], b: number[] = [];
    for (const [d, x] of maps[i]!) { const y = maps[j]!.get(d); if (y !== undefined) { a.push(x); b.push(y); } }
    if (a.length < 10) continue;
    const ma = mean(a), mb = mean(b);
    let sab = 0, saa = 0, sbb = 0;
    for (let k = 0; k < a.length; k++) { sab += (a[k]! - ma) * (b[k]! - mb); saa += (a[k]! - ma) ** 2; sbb += (b[k]! - mb) ** 2; }
    if (saa > 0 && sbb > 0) cs.push(sab / Math.sqrt(saa * sbb));
  }
  return cs.length ? mean(cs) : null;
}
/** N_eff = N / (1 + (N−1)·ρ̄),夹在 [1, N];ρ̄ ≤ 0 时取 N */
export function effectiveByCorrelation(n: number, rho: number | null): number | null {
  if (rho === null || n < 1) return null;
  if (rho <= 0) return n;
  return Math.max(1, Math.min(n, n / (1 + (n - 1) * rho)));
}
export const sharpeVariance = (xs: (number | null)[]) => variance(xs.filter((x): x is number => x !== null && Number.isFinite(x)));

// ---------------------------------------------------------------- 时间块 bootstrap
/** 按块长把日收益切成连续块(末块可短) */
function blocksOf(r: number[], blockDays: number): number[][] {
  const out: number[][] = [], L = Math.max(1, blockDays);
  for (let i = 0; i < r.length; i += L) out.push(r.slice(i, i + L));
  return out;
}
/**
 * 单侧检验「日均净收益 > 0」:去均值后按块有放回重抽,p = (1 + #{重抽均值 ≥ 观测均值}) / (B + 1)。
 * 块数不够 min_blocks 时 p = null(证据不足,不是「不显著」)。
 */
export function blockBootstrapP(r: number[], p: Pick<MatrixProtocol, 'block_days' | 'min_blocks' | 'bootstrap_replicates' | 'seed'>): { mean: number | null; p: number | null; blocks: number } {
  const blocks = blocksOf(r, p.block_days);
  if (!r.length) return { mean: null, p: null, blocks: 0 };
  const m = mean(r);
  if (blocks.length < p.min_blocks) return { mean: m, p: null, blocks: blocks.length };
  const centered = blocks.map((b) => b.map((x) => x - m)), rnd = seededRandom(p.seed), B = p.bootstrap_replicates;
  let hit = 0;
  for (let k = 0; k < B; k++) {
    let sum = 0, n = 0;
    while (n < r.length) { const b = centered[Math.floor(rnd() * centered.length)]!; for (const x of b) { if (n >= r.length) break; sum += x; n++; } }
    if (sum / n >= m) hit++;
  }
  return { mean: m, p: (1 + hit) / (B + 1), blocks: blocks.length };
}
/** 配对日收益差(按日序号对齐)的均值与块 bootstrap 95% 区间 */
export function pairedDelta(a: { days: number[]; returns: number[] }, b: { days: number[]; returns: number[] }, p: Pick<MatrixProtocol, 'block_days' | 'bootstrap_replicates' | 'seed'>): { mean: number | null; ci95: [number, number] | null } {
  const mb = new Map(b.days.slice(1).map((d, i) => [d, b.returns[i]!] as const)), diff: number[] = [];
  a.days.slice(1).forEach((d, i) => { const y = mb.get(d); if (y !== undefined) diff.push(a.returns[i]! - y); });
  if (diff.length < 2) return { mean: diff.length ? diff[0]! : null, ci95: null };
  const blocks = blocksOf(diff, p.block_days), rnd = seededRandom(p.seed + 1), means: number[] = [];
  for (let k = 0; k < p.bootstrap_replicates; k++) {
    let sum = 0, n = 0;
    while (n < diff.length) { const bl = blocks[Math.floor(rnd() * blocks.length)]!; for (const x of bl) { if (n >= diff.length) break; sum += x; n++; } }
    means.push(sum / n);
  }
  means.sort((x, y) => x - y);
  const q = (f: number) => means[Math.min(means.length - 1, Math.max(0, Math.floor(f * (means.length - 1))))]!;
  return { mean: mean(diff), ci95: [q(0.025), q(0.975)] };
}

// ---------------------------------------------------------------- Holm
/** Holm 逐步下降:p 升序,第 i 个(0 起)阈值 α/(K−i),遇到第一个不拒绝即停;p=null 视为不拒绝 */
export function holm(ps: (number | null)[], alpha: number): { threshold: number | null; rejected: boolean }[] {
  const K = ps.length, order = ps.map((p, i) => ({ p, i })).sort((a, b) => (a.p ?? Infinity) - (b.p ?? Infinity) || a.i - b.i);
  const out = ps.map(() => ({ threshold: null as number | null, rejected: false }));
  let stop = false;
  order.forEach(({ p, i }, rank) => {
    const th = alpha / (K - rank);
    out[i] = { threshold: th, rejected: !stop && p !== null && p <= th };
    if (!out[i]!.rejected) stop = true;
  });
  return out;
}
/** 留出段检验结果(Holm 之前的单个检验;rejected 由 Holm 回填) */
export function holdoutTest(r: number[], p: MatrixProtocol): HoldoutTest {
  const t = blockBootstrapP(r, p);
  return { days: r.length, blocks: t.blocks, mean_daily: t.mean, p_value: t.p, holm_threshold: null, rejected: false };
}
