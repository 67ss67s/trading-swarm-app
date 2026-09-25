/**
 * 规则挖掘 + 显著性:在「挖掘样本」上找 ≤3 个条件的组合,让好点比例明显高于基准。
 *
 * 挖掘:单条件全枚举 → 两两组合全枚举(不同特征、支持度 ≥ 下限)→ 以得分最高的 beam 个二元组为底再加第三个条件。
 *   得分 = (好点比例提升 − 1) × 覆盖数 = 好点数 / 基准比例 − 覆盖数,也就是「比基准多出来的好点」按基准折算。
 * 置换检验:保持特征不动、把标签打乱,每次重跑同样的挖掘。三种打乱:同步循环平移(rotateLabels,默认,保住自相关与跨资产同步)、
 *   资产内按块重排(permuteLabels,块长=标签视野)、资产内逐根 i.i.d.(最不保守,只作对照)。每次记下「最优规则得分」,得到零分布;p = (1 + #{零分布 ≥ 实际}) / (1 + 次数)。
 *   同一零分布也给每条规则一个单步 max-T 校正后的 p(控制族错误率)。
 * 多重检验:对全部试过的规则算单条 p(二项 z 检验,方差按标签自相关的设计效应放大),再做 Benjamini–Hochberg。
 * 全部用位图(Uint32Array)做与运算 + popcount,零模型。
 */
import type { Condition, FeatureDef } from './features.js';

export interface MiningTable {
  /** 列式特征(与 defs 同序),长度 = 行数 */
  cols: Float64Array[];
  defs: FeatureDef[];
  /** 0/1 标签 */
  good: Uint8Array;
  /** 净 R(报告平均 R 用) */
  r: Float64Array;
  /** 行所属资产(块置换在资产内进行;行在资产内按时间顺序) */
  asset: Int32Array;
  n: number;
}
export interface MineOptions {
  max_conditions: 1 | 2 | 3;
  min_support: number;
  beam: number;
  quantiles: number[];
  /** 加一个条件至少要把覆盖缩到上一级的这个比例以下,否则算冗余(挡掉「且 不是某个罕见形态」这类几乎不改样本的条件) */
  max_shrink: number;
}
export const DEFAULT_MINE: MineOptions = { max_conditions: 3, min_support: 300, beam: 30, quantiles: [0.1, 0.25, 0.5, 0.75, 0.9], max_shrink: 0.9 };

export interface CondSpec { cond: Condition; feature: number; bits: Uint32Array; n: number }
export interface MinedRule { conds: number[]; n: number; k: number; score: number }

export function popcount32(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}
const count = (a: Uint32Array) => { let s = 0; for (let w = 0; w < a.length; w++) s += popcount32(a[w]!); return s; };
const count2 = (a: Uint32Array, b: Uint32Array) => { let s = 0; for (let w = 0; w < a.length; w++) s += popcount32(a[w]! & b[w]!); return s; };
const count3 = (a: Uint32Array, b: Uint32Array, c: Uint32Array) => { let s = 0; for (let w = 0; w < a.length; w++) s += popcount32(a[w]! & b[w]! & c[w]!); return s; };
export function bitsOf(n: number, test: (row: number) => boolean): Uint32Array {
  const out = new Uint32Array(Math.ceil(n / 32));
  for (let i = 0; i < n; i++) if (test(i)) out[i >>> 5]! |= 1 << (i & 31);
  return out;
}
export const holds = (c: Condition, v: number) => Number.isFinite(v) && (c.op === '<=' ? v <= c.value : c.op === '>=' ? v >= c.value : v === c.value);

/** 分位数(线性插值),只看有限值 */
export function quantile(sorted: Float64Array, q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** 由挖掘样本定条件:数值特征在分位点上切 ≤/≥,类别特征逐取值;覆盖不足或全覆盖的条件丢掉。阈值只由挖掘样本决定。 */
export function buildConditions(t: MiningTable, o: MineOptions = DEFAULT_MINE): CondSpec[] {
  const out: CondSpec[] = [];
  t.defs.forEach((d, f) => {
    const col = t.cols[f]!, conds: Condition[] = [];
    if (d.kind === 'num') {
      const finite = Float64Array.from(col.filter((x) => Number.isFinite(x))).sort();
      if (finite.length < o.min_support) return;
      const qs = o.quantiles.map((q) => quantile(finite, q));
      o.quantiles.forEach((q, j) => { if (q <= 0.5) conds.push({ feature: d.key, op: '<=', value: qs[j]! }); if (q >= 0.5) conds.push({ feature: d.key, op: '>=', value: qs[j]! }); });
    } else {
      const levels = new Set<number>(); for (const x of col) if (Number.isFinite(x)) levels.add(x);
      for (const v of [...levels].sort((a, b) => a - b)) conds.push({ feature: d.key, op: '==', value: v });
    }
    const seen = new Set<string>();
    for (const c of conds) {
      const key = `${c.op}${c.value}`; if (seen.has(key)) continue; seen.add(key);
      const bits = bitsOf(t.n, (i) => holds(c, col[i]!)), n = count(bits);
      if (n >= o.min_support && n <= o.max_shrink * t.n) out.push({ cond: c, feature: f, bits, n });
    }
  });
  return out;
}

/** 两两组合的位图(与标签无关,算一次,置换时复用) */
export interface PairSpec { a: number; b: number; bits: Uint32Array; n: number }
export function buildPairs(conds: CondSpec[], o: MineOptions = DEFAULT_MINE): PairSpec[] {
  const out: PairSpec[] = [];
  if (o.max_conditions < 2) return out;
  for (let a = 0; a < conds.length; a++) for (let b = a + 1; b < conds.length; b++) {
    const ca = conds[a]!, cb = conds[b]!; if (ca.feature === cb.feature) continue;
    const bits = new Uint32Array(ca.bits.length); for (let w = 0; w < bits.length; w++) bits[w] = ca.bits[w]! & cb.bits[w]!;
    const n = count(bits);
    // 支持度不够,或者加了条件覆盖没变(冗余),都不要
    if (n >= o.min_support && n <= o.max_shrink * Math.min(ca.n, cb.n)) out.push({ a, b, bits, n });
  }
  return out;
}

export interface MineResult { best: MinedRule | null; rules: MinedRule[]; tried: number }
/**
 * 一次挖掘。keep=false 时只返回最优(置换用),keep=true 返回全部试过的规则。
 * tripleCount 缓存第三个条件的覆盖数(与标签无关),跨置换复用。
 */
export function mine(conds: CondSpec[], pairs: PairSpec[], good: Uint32Array, total: number, o: MineOptions, keep: boolean, tripleCount = new Map<number, number>()): MineResult {
  const G = count(good), p0 = G / total;
  const rules: MinedRule[] = [];
  let best: MinedRule | null = null, tried = 0;
  const consider = (conds_: number[], n: number, k: number) => {
    tried++;
    const score = p0 > 0 ? k / p0 - n : 0, r = { conds: conds_, n, k, score };
    if (keep) rules.push(r);
    if (!best || score > best.score) best = r;
    return r;
  };
  if (!(p0 > 0) || p0 >= 1) return { best: null, rules, tried };
  conds.forEach((c, i) => consider([i], c.n, count2(c.bits, good)));
  const pairScores: { p: number; score: number }[] = [];
  pairs.forEach((pr, idx) => { const r = consider([pr.a, pr.b], pr.n, count2(pr.bits, good)); pairScores.push({ p: idx, score: r.score }); });
  if (o.max_conditions >= 3 && pairs.length) {
    pairScores.sort((x, y) => y.score - x.score);
    const C = conds.length, seen = new Set<string>();
    for (const { p } of pairScores.slice(0, o.beam)) {
      const pr = pairs[p]!, fa = conds[pr.a]!.feature, fb = conds[pr.b]!.feature;
      for (let c = 0; c < C; c++) {
        const cc = conds[c]!; if (cc.feature === fa || cc.feature === fb) continue;
        const ids = [pr.a, pr.b, c].sort((x, y) => x - y), key = ids.join(',');
        if (seen.has(key)) continue; seen.add(key);
        const ck = p * C + c;
        let n = tripleCount.get(ck);
        if (n === undefined) { n = count2(pr.bits, cc.bits); tripleCount.set(ck, n); }
        if (n < o.min_support || n > o.max_shrink * Math.min(pr.n, cc.n)) continue;
        consider(ids, n, count3(pr.bits, cc.bits, good));
      }
    }
  }
  return { best, rules, tried };
}

/** 确定性伪随机(mulberry32) */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** 标签置换:block>1 时在每个资产内按块重排(保留自相关),block=1 即逐根 i.i.d. 打乱(同样限于资产内) */
export function permuteLabels(good: Uint8Array, asset: Int32Array, block: number, rand: () => number): Uint8Array {
  const out = new Uint8Array(good.length);
  let start = 0;
  while (start < good.length) {
    let end = start; while (end < good.length && asset[end] === asset[start]) end++;
    const blocks: [number, number][] = [];
    for (let s = start; s < end; s += block) blocks.push([s, Math.min(end, s + block)]);
    for (let i = blocks.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [blocks[i], blocks[j]] = [blocks[j]!, blocks[i]!]; }
    let w = start; for (const [s, e] of blocks) for (let i = s; i < e; i++) out[w++] = good[i]!;
    start = end;
  }
  return out;
}

/**
 * 同步循环平移:所有资产的标签序列按同一个随机位移 shift 循环错位(资产内按时间顺序)。
 * 保住标签的全部自相关与跨资产同步性(一次大跌同时打在所有币上),只打断「特征 ↔ 标签」的时间对齐;比块置换更保守。
 */
export function rotateLabels(good: Uint8Array, asset: Int32Array, shift: number): Uint8Array {
  const out = new Uint8Array(good.length);
  let start = 0;
  while (start < good.length) {
    let end = start; while (end < good.length && asset[end] === asset[start]) end++;
    const len = end - start, s = ((shift % len) + len) % len;
    for (let j = 0; j < len; j++) out[start + j] = good[start + ((j + s) % len)]!;
    start = end;
  }
  return out;
}

/** 标签自相关的设计效应:1 + 2 Σ_{k=1..K} (1 − k/(K+1)) ρ_k(资产内计算后按长度加权),至少 1 */
export function designEffect(good: Uint8Array, asset: Int32Array, K: number): number {
  let num = 0, den = 0, start = 0;
  while (start < good.length) {
    let end = start; while (end < good.length && asset[end] === asset[start]) end++;
    const len = end - start;
    if (len > 2 * K) {
      let mean = 0; for (let i = start; i < end; i++) mean += good[i]!; mean /= len;
      let v = 0; for (let i = start; i < end; i++) v += (good[i]! - mean) ** 2;
      if (v > 0) {
        let d = 1;
        for (let k = 1; k <= K; k++) { let c = 0; for (let i = start; i + k < end; i++) c += (good[i]! - mean) * (good[i + k]! - mean); d += 2 * (1 - k / (K + 1)) * (c / v); }
        num += Math.max(1, d) * len; den += len;
      }
    }
    start = end;
  }
  return den ? num / den : 1;
}
/** 标准正态上尾概率 */
export function normalSf(z: number): number {
  // Abramowitz–Stegun 7.1.26 的 erfc 近似,误差 < 1.5e-7
  const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
  const erfc = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return z >= 0 ? erfc / 2 : 1 - erfc / 2;
}
/** 单条规则的单侧 p:好点数相对基准的 z,方差 × 设计效应 */
export function ruleP(n: number, k: number, p0: number, deff: number): number {
  const sd = Math.sqrt(n * p0 * (1 - p0) * deff);
  return sd > 0 ? normalSf((k - n * p0) / sd) : 1;
}
/** Benjamini–Hochberg:返回每个 p 的 q 值(同序)与 q ≤ alpha 的发现数 */
export function benjaminiHochberg(ps: number[], alpha = 0.05): { q: Float64Array; discoveries: number } {
  const m = ps.length, order = ps.map((p, i) => [p, i] as [number, number]).sort((a, b) => a[0] - b[0]), q = new Float64Array(m);
  let min = 1, discoveries = 0;
  for (let j = m - 1; j >= 0; j--) { const [p, i] = order[j]!; min = Math.min(min, (p * m) / (j + 1)); q[i] = min; }
  for (let j = 0; j < m; j++) if (q[order[j]![1]]! <= alpha) discoveries++;
  return { q, discoveries };
}

export type PermutationMode = 'rotate' | 'block' | 'iid';
/**
 * 置换零分布:打乱标签 P 次,每次重跑同样的挖掘,记最优得分。rotate 的平移量取 [视野, 最短资产长度 − 视野) 内均匀(太小的平移几乎等于没打乱)。
 * 与 mineOracle 同一段代码,测试直接用它验证「纯噪声不显著、植入规律能找回」。
 */
export async function nullDistribution(t: MiningTable, conds: CondSpec[], pairs: PairSpec[], o: MineOptions, p: { permutations: number; mode: PermutationMode; block: number; horizon: number; seed: number; signal?: AbortSignal; tick?: (done: number) => void }, tripleCount = new Map<number, number>()): Promise<number[]> {
  const rand = rng(p.seed), out: number[] = [];
  const lens = new Map<number, number>(); for (const a of t.asset) lens.set(a, (lens.get(a) ?? 0) + 1);
  const minLen = Math.min(...lens.values());
  for (let k = 0; k < p.permutations; k++) {
    if (p.signal?.aborted) throw Error('CANCELLED');
    const perm = p.mode === 'rotate' ? rotateLabels(t.good, t.asset, p.horizon + Math.floor(rand() * Math.max(1, minLen - 2 * p.horizon))) : permuteLabels(t.good, t.asset, p.mode === 'iid' ? 1 : p.block, rand);
    out.push(mine(conds, pairs, bitsOf(t.n, (j) => perm[j] === 1), t.n, o, false, tripleCount).best?.score ?? 0);
    if (k % 10 === 9) { p.tick?.(k + 1); await new Promise<void>((r) => setImmediate(r)); }
  }
  return out;
}
/** 置换 p:(1 + #{零分布 ≥ x}) / (1 + 次数) */
export const permutationP = (nullBest: number[], x: number) => (1 + nullBest.filter((v) => v >= x).length) / (1 + nullBest.length);
