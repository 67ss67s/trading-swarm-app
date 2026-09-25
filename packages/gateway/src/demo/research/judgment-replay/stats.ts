/**
 * 统计:同一批事件、同一套管仓与成本,臂之间只差「做不做」。
 *
 * 每个事件在每个臂上的结果 = 做 ? 该事件的净 R : 0。于是
 *  - 每笔期望(只看做了的那些)回答「挑出来的单子好不好」;
 *  - 每事件均值(不做记 0)回答「这个过滤器整体值不值」,配对差就在它上面算(臂 X − 臂 Y,逐事件)。
 * 置信区间:按 UTC 日做整簇 bootstrap(同一天 6 个币高度相关,逐笔独立重抽会把区间算窄),2000 次,固定种子。
 * 随机基线 R:在同一子集里随机挑出与被比较的模型臂同样多的事件(不放回),固定种子 1..K 各抽一次;
 * 报告的是 K 次抽样的均值与 2.5%/97.5% 分位带(这是「随机挑同样多单」的分布,不是 bootstrap 区间),
 * 以及模型每笔期望不低于随机的比例(单侧,越小越说明模型确实挑得比随机好)。
 * 每笔期望旁边给中位数与截尾均值(两端各截 floor(n×10%) 笔,n<10 不截尾;口径见 ../analyzer.ts centerStats),
 * 防止一簇行情撑起整个平均值(几何实验室 8/19 的教训)。只是派生统计,不改事件、结算与决定。
 */
import { D1, type JrEvent, type Management } from './types.js';
import type { Decision } from './judge.js';
import { centerStats } from '../analyzer.js';

export type Follow = (e: JrEvent) => boolean;

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export const rOf = (e: JrEvent, m: Management): number | null => e[m].net_r;
export const dayOf = (e: JrEvent): number => Math.floor(e.as_of / D1);

/** 整簇 bootstrap:按 cluster 重抽,stat 在拼回来的事件上算;stat 返回 null 的那次丢掉。 */
export function clusterBootstrap<T>(items: T[], cluster: (x: T) => number | string, stat: (xs: T[]) => number | null, seed = 20260923, resamples = 2000): { lo: number | null; hi: number | null } {
  const groups = new Map<number | string, T[]>();
  for (const x of items) {
    const k = cluster(x);
    const g = groups.get(k);
    if (g) g.push(x);
    else groups.set(k, [x]);
  }
  const gs = [...groups.values()];
  if (!gs.length) return { lo: null, hi: null };
  const rand = rng(seed);
  const out: number[] = [];
  for (let b = 0; b < resamples; b++) {
    const pick: T[] = [];
    for (let i = 0; i < gs.length; i++) pick.push(...gs[Math.floor(rand() * gs.length)]!);
    const v = stat(pick);
    if (v !== null && Number.isFinite(v)) out.push(v);
  }
  return { lo: quantile(out, 0.025), hi: quantile(out, 0.975) };
}

export interface ArmStats {
  arm: string;
  management: Management;
  n_events: number;
  n_trades: number;
  follow_rate: number | null;
  /** 每笔期望(净 R)与 95% CI */
  mean_trade: number | null;
  ci_trade: [number | null, number | null];
  /** 每笔净 R 的中位数与截尾均值(两端各截 trim_each_side 笔) */
  median_trade: number | null;
  trimmed_trade: number | null;
  trim_each_side: number;
  win_rate: number | null;
  total_r: number;
  /** 每事件均值(不做记 0)与 95% CI */
  mean_event: number | null;
  ci_event: [number | null, number | null];
  model_errors: number;
  /** 随机基线专用:K 次抽样的每笔期望分位带 */
  band?: [number | null, number | null];
}

/** events 里 net R 为 null 的(结算不了)事先剔除;follow 决定做不做。 */
export function armStats(arm: string, events: JrEvent[], follow: Follow, m: Management, modelErrors = 0, seed = 20260923): ArmStats {
  const ev = events.filter((e) => rOf(e, m) !== null);
  const trades = ev.filter(follow);
  const rs = trades.map((e) => rOf(e, m)!);
  const tradeMean = (xs: JrEvent[]): number | null => mean(xs.filter(follow).map((e) => rOf(e, m)!));
  const eventMean = (xs: JrEvent[]): number | null => mean(xs.map((e) => (follow(e) ? rOf(e, m)! : 0)));
  const ct = clusterBootstrap(ev, dayOf, tradeMean, seed);
  const ce = clusterBootstrap(ev, dayOf, eventMean, seed);
  const c = centerStats(rs);
  return {
    arm,
    management: m,
    n_events: ev.length,
    n_trades: trades.length,
    follow_rate: ev.length ? trades.length / ev.length : null,
    mean_trade: mean(rs),
    ci_trade: [ct.lo, ct.hi],
    median_trade: c.median,
    trimmed_trade: c.trimmed_mean,
    trim_each_side: c.trimmed_each_side,
    win_rate: rs.length ? rs.filter((x) => x > 0).length / rs.length : null,
    total_r: rs.reduce((a, b) => a + b, 0),
    mean_event: eventMean(ev),
    ci_event: [ce.lo, ce.hi],
    model_errors: modelErrors,
  };
}

export interface PairedStats {
  a: string;
  b: string;
  management: Management;
  n: number;
  /** 逐事件 (a − b),不做记 0 */
  mean: number | null;
  ci: [number | null, number | null];
  /** 两臂决定不同的事件数,以及其中 a 更好 / 更差 */
  differ: number;
  better: number;
  worse: number;
}

export function paired(aName: string, fa: Follow, bName: string, fb: Follow, events: JrEvent[], m: Management, seed = 20260923): PairedStats {
  const ev = events.filter((e) => rOf(e, m) !== null);
  const d = (e: JrEvent): number => (fa(e) ? rOf(e, m)! : 0) - (fb(e) ? rOf(e, m)! : 0);
  const ci = clusterBootstrap(ev, dayOf, (xs) => mean(xs.map(d)), seed);
  const diffs = ev.map(d);
  return { a: aName, b: bName, management: m, n: ev.length, mean: mean(diffs), ci: [ci.lo, ci.hi], differ: ev.filter((e) => fa(e) !== fb(e)).length, better: diffs.filter((x) => x > 1e-9).length, worse: diffs.filter((x) => x < -1e-9).length };
}

export interface RandomBaseline {
  matched_to: string;
  management: Management;
  k: number;
  n: number;
  seeds: number;
  mean_trade: number | null;
  band_trade: [number | null, number | null];
  mean_event: number | null;
  band_event: [number | null, number | null];
  /** 模型每笔期望;随机抽样里 ≥ 它的比例(单侧) */
  model_mean_trade: number | null;
  p_random_ge_model: number | null;
  /** 每个种子挑中的事件下标(复现性测试用) */
  picks?: number[][];
}

/** 从 n 个事件里不放回抽 k 个(Fisher–Yates 前 k 步,mulberry32)。 */
export function sampleK(n: number, k: number, seed: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  const rand = rng(seed);
  for (let i = 0; i < Math.min(k, n); i++) {
    const j = i + Math.floor(rand() * (n - i));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  return idx.slice(0, Math.min(k, n)).sort((a, b) => a - b);
}

export function randomBaseline(matchedTo: string, model: Follow, events: JrEvent[], m: Management, seeds = 200, keepPicks = false): RandomBaseline {
  const ev = events.filter((e) => rOf(e, m) !== null);
  const k = ev.filter(model).length;
  const modelMean = mean(ev.filter(model).map((e) => rOf(e, m)!));
  const perTrade: number[] = [];
  const perEvent: number[] = [];
  const picks: number[][] = [];
  for (let s = 1; s <= seeds; s++) {
    const pick = sampleK(ev.length, k, s);
    if (keepPicks) picks.push(pick);
    const rs = pick.map((i) => rOf(ev[i]!, m)!);
    const mt = mean(rs);
    if (mt !== null) perTrade.push(mt);
    perEvent.push(ev.length ? rs.reduce((a, b) => a + b, 0) / ev.length : 0);
  }
  return {
    matched_to: matchedTo,
    management: m,
    k,
    n: ev.length,
    seeds,
    mean_trade: mean(perTrade),
    band_trade: [quantile(perTrade, 0.025), quantile(perTrade, 0.975)],
    mean_event: mean(perEvent),
    band_event: [quantile(perEvent, 0.025), quantile(perEvent, 0.975)],
    model_mean_trade: modelMean,
    p_random_ge_model: modelMean === null || !perTrade.length ? null : perTrade.filter((x) => x >= modelMean - 1e-12).length / perTrade.length,
    ...(keepPicks ? { picks } : {}),
  };
}

/** 模型臂的 follow:没有决定的事件不在它的子集里(调用方先按子集过滤);model_error 按生产 fail-closed 记不做。 */
export function modelFollow(dec: Map<string, Decision>): Follow {
  return (e) => dec.get(e.id)?.follow === true;
}

export interface GroupRow {
  group: string;
  arm: string;
  n_events: number;
  n_trades: number;
  mean_trade: number | null;
  median_trade: number | null;
  total_r: number;
  mean_event: number | null;
}

export function byGroup(events: JrEvent[], key: (e: JrEvent) => string, arms: [string, Follow][], m: Management): GroupRow[] {
  const groups = [...new Set(events.map(key))].sort();
  const out: GroupRow[] = [];
  for (const g of groups) {
    const ev = events.filter((e) => key(e) === g && rOf(e, m) !== null);
    for (const [name, f] of arms) {
      const rs = ev.filter(f).map((e) => rOf(e, m)!);
      out.push({ group: g, arm: name, n_events: ev.length, n_trades: rs.length, mean_trade: mean(rs), median_trade: centerStats(rs).median, total_r: rs.reduce((a, b) => a + b, 0), mean_event: ev.length ? rs.reduce((a, b) => a + b, 0) / ev.length : null });
    }
  }
  return out;
}

/**
 * 模型臂子集:按 (行情段, 币) 分层,每层内按「事件 id + 种子」的哈希排序取前 n_s 个。
 * 同一种子下,小样本一定是大样本的子集(GLM 的样本嵌在 DeepSeek 的样本里,才能做配对)。
 */
export function stratifiedSample(events: JrEvent[], n: number, hash: (s: string) => string, seed = 'jr-sample-v1'): JrEvent[] {
  if (n >= events.length) return [...events];
  const strata = new Map<string, JrEvent[]>();
  for (const e of events) {
    const k = `${e.period}|${e.symbol}`;
    const g = strata.get(k);
    if (g) g.push(e);
    else strata.set(k, [e]);
  }
  const keys = [...strata.keys()].sort();
  // 最大余数法分配名额,保证总数正好是 n
  const raw = keys.map((k) => (strata.get(k)!.length * n) / events.length);
  const alloc = raw.map(Math.floor);
  let left = n - alloc.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    alloc[i]!++;
    left--;
  }
  const out: JrEvent[] = [];
  keys.forEach((k, i) => {
    const ranked = [...strata.get(k)!].sort((a, b) => hash(`${seed}|${a.id}`).localeCompare(hash(`${seed}|${b.id}`)));
    out.push(...ranked.slice(0, alloc[i]));
  });
  return out.sort((a, b) => a.as_of - b.as_of || a.id.localeCompare(b.id));
}
