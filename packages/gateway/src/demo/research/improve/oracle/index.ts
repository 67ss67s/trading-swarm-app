/**
 * 事后反推(oracle)候选生成器 —— 改进环第四种生成器(设计 docs/research/improver-design-2026-09-23.md 第三节第 4 条)。
 * Jacky:「逆过来反推一下怎么开单才能赚,然后看看当时场景能否归因还是噪声」。
 *
 * 流程(只用冻结数据的训练段,零模型):
 *  1. 训练段每根 K 线打事后标签(labels.ts,多空分开),≥ +2R 为好点 —— 标签含未来数据,方法固有;
 *  2. 每根算 as-of 特征(features.ts),离散成分位档;
 *  3. 训练段前 2/3 挖 ≤3 条件规则(mine.ts),按「好点比例提升 × 覆盖数」排序;后 1/3 看好点比例是否仍高于基准;
 *     置换检验给「最优规则」的零分布与 p,全体规则做 BH;
 *  4. 能用现有原语表达的规则转成 StrategyIR(入场 next_open_market,止损/离场沿用标签的机械管理),过零模型 checkIR。
 * 真回测(验证段)不在这里做:改进环主体按自己的门槛评估候选;独立研究脚本 scripts/research-oracle/study.ts 另跑验证段。
 */
import type { StrategyIR, StrategyPrimitive } from '@trading-swarm/contracts';
import type { CandidateGenerator, FrozenData, GeneratorContext, Candidate } from '../types.js';
import { computeFeatures, featureDefs, type Condition, type FeatureDef, type AssetFeatures } from './features.js';
import { labelSeries, labelHorizon, DEFAULT_MECHANICS, type Mechanics, type Side } from './labels.js';
import { checkIR } from '../../strategy.js';
import { buildConditions, buildPairs, mine, nullDistribution, permutationP, designEffect, ruleP, benjaminiHochberg, bitsOf, holds, DEFAULT_MINE, type MiningTable, type MineOptions, type CondSpec, type MinedRule, type PermutationMode } from './mine.js';

export { labelSeries, DEFAULT_MECHANICS } from './labels.js';
export { computeFeatures, featureDefs, trendSeries, structureSeries } from './features.js';
export type { Condition } from './features.js';

export interface OracleOptions extends Partial<MineOptions> {
  sides?: Side[];
  /** 置换次数(≥200 才报告正式 p) */
  permutations?: number;
  /** 'rotate' = 所有资产同步循环平移(默认,最保守:保住自相关与跨资产同步);'block' = 资产内按块重排;'iid' = 资产内逐根打乱 */
  permutation_mode?: PermutationMode;
  /** 块长,默认 = 标签视野(49 根) */
  block?: number;
  seed?: number;
  mechanics?: Mechanics;
  /** 特征预热(根);缺省 = max(data.warmup_bars, 日线趋势所需 51 天 + 1 天) */
  feature_warmup?: number;
  /** 报告保留前几条规则 */
  top?: number;
  /** 最多挑几条可表达规则转 IR */
  picks?: number;
  /** BH 的 FDR 水平 */
  fdr?: number;
  signal?: AbortSignal;
  progress?: (msg: string) => void;
}
export type { PermutationMode } from './mine.js';
export interface RuleStats { n: number; k: number; rate: number; base_rate: number; lift: number; mean_r: number }
export interface OracleRule {
  conditions: Condition[];
  text: string;
  score: number;
  train: RuleStats;
  /** 训练段后 1/3 */
  test: RuleStats;
  /** 训练段后 1/3 上好点比例仍高于基准 */
  holds_on_test: boolean;
  /** 单条 z 检验 p(设计效应校正) */
  p_rule: number;
  /** BH q 值 */
  q_bh: number;
  /** 置换零分布下的单步 max-T 校正 p(族错误率) */
  p_perm: number;
  expressible: boolean;
  /** 转成的 IR 是否过零模型 checkIR(做空草稿也记) */
  check_ok?: boolean;
  check_failed?: string[];
  /** 只做多:完整 IR(过 checkIR 才给);做空:带 order 块(direction=short)的草稿,仅供报告 */
  ir?: StrategyIR;
  unexpressed?: string[];
}
export interface OracleSideResult {
  side: Side;
  mining: { rows: number; good: number; base_rate: number; mean_r: number; from_ms: number; to_ms: number };
  test: { rows: number; good: number; base_rate: number; mean_r: number; from_ms: number; to_ms: number };
  conditions: number;
  rules_tried: number;
  design_effect: number;
  best_score: number;
  null_dist: { permutations: number; mode: string; block: number; mean: number; p95: number; max: number };
  /** 「最优规则得分」的置换 p —— 这是「能归因还是噪声」的主结论 */
  p_value: number;
  bh: { alpha: number; m: number; discoveries: number };
  top: OracleRule[];
  /** 可表达、后 1/3 仍成立的规则(≤ picks 条),转好了 IR */
  picks: OracleRule[];
}
export interface OracleResult { universe: string[]; timeframe: string; mechanics: Mechanics; options: Required<Pick<OracleOptions, 'permutations' | 'permutation_mode' | 'block' | 'seed'>> & MineOptions; sides: OracleSideResult[]; notes: string[]; elapsed_ms: number }

const HOUR = 3600000;
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));
const fmt = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(1) : Math.abs(x) >= 1 ? x.toFixed(3) : x.toPrecision(3));
export function conditionText(c: Condition, defs: FeatureDef[] = featureDefs()): string {
  const d = defs.find((x) => x.key === c.feature);
  if (!d) return `${c.feature} ${c.op} ${c.value}`;
  if (c.op === '==') return `${d.label} = ${d.levels?.[c.value] ?? c.value}`;
  return `${d.label} ${c.op === '<=' ? '≤' : '≥'} ${fmt(c.value)}`;
}

/** 机械管理对应的 IR 骨架(只做多,现货,≤1h,不用 Pine):signal/regime 由规则填 */
export function mechanicsIR(m: Mechanics = DEFAULT_MECHANICS): Pick<StrategyIR, 'entry' | 'risk' | 'exit'> {
  return {
    entry: { primitive: 'next_open_market', params: {} },
    risk: { stop: { primitive: 'atr_stop', params: { atr_period: m.atr_period, multiple: m.stop_multiple } }, sizing: { primitive: 'risk_fraction', params: { fraction: '0.01', max_allocation: '1' } } },
    exit: [
      { primitive: 'chandelier_trail', params: { atr_period: m.trail_period, multiple: m.trail_multiple } },
      { primitive: 'time_stop', params: { bars: m.max_bars }, optional: true },
      // checkIR 要求有独立止盈来源:放一个很远的固定 R 目标(标签里同样按它模拟),几乎不触发
      { primitive: 'fixed_r_target', params: { r: m.target_r }, optional: true },
    ],
  };
}
/** 「永远成立」的信号:规则只有方向门条件时 signal 不能为空 */
const ALWAYS: StrategyPrimitive = { primitive: 'indicator_threshold', params: { indicator: 'price', output: 'close', operator: 'above', threshold: 0 } };

/** 规则 → IR 节点;表达不了的条件列在 unexpressed 里 */
export function ruleNodes(conds: Condition[], side: Side, defs: FeatureDef[] = featureDefs()): { signal: StrategyPrimitive[]; regime: StrategyPrimitive | null; unexpressed: string[] } {
  const signal: StrategyPrimitive[] = [], unexpressed: string[] = [];
  let regime: StrategyPrimitive | null = null;
  for (const c of conds) {
    const d = defs.find((x) => x.key === c.feature), got = d?.ir?.(c, side) ?? null;
    if (!got) { unexpressed.push(conditionText(c, defs)); continue; }
    if (got.slot === 'regime') { if (regime) { unexpressed.push(`${conditionText(c, defs)}(IR 只能有一个方向门)`); continue; } regime = got.node; }
    else signal.push(got.node);
  }
  return { signal, regime, unexpressed };
}
/** 独立 IR:规则 + 机械管理。做空版带 order 块(direction=short,永续 1 倍),只作报告草稿 */
export function ruleToIR(conds: Condition[], side: Side, label: string, description: string, m: Mechanics = DEFAULT_MECHANICS): { ir: StrategyIR | null; unexpressed: string[] } {
  const { signal, regime, unexpressed } = ruleNodes(conds, side);
  if (unexpressed.length) return { ir: null, unexpressed };
  const ir: StrategyIR = { version: 1, label: label.slice(0, 160), description: description.slice(0, 5000), signal: (signal.length ? signal : [ALWAYS]) as StrategyIR["signal"], ...mechanicsIR(m), ...(regime ? { regime } : {}) };
  if (side === 'short') ir.order = { direction: 'short', market: 'perp', leverage: 1 };
  return { ir, unexpressed };
}
/** 以父 IR 为底,把规则作为入场过滤条件加进去(signal 追加 AND;方向门只在父 IR 没有 regime 时才能加) */
export function addRuleToParent(parent: StrategyIR, conds: Condition[]): { ir: StrategyIR; diff: Candidate['diff'] } | null {
  const { signal, regime, unexpressed } = ruleNodes(conds, 'long');
  if (unexpressed.length || (regime && parent.regime)) return null;
  if (parent.order && parent.order.direction !== 'long') return null;
  const ir = structuredClone(parent) as StrategyIR, diff: Candidate['diff'] = [];
  if (signal.length) { diff.push({ path: 'signal', from: parent.signal, to: [...parent.signal, ...signal] }); ir.signal = [...parent.signal, ...signal]; }
  if (regime) { diff.push({ path: 'regime', from: null, to: regime }); ir.regime = regime; }
  if (!diff.length) return null;
  return { ir, diff };
}

interface Row { asset: number; i: number }
function table(feats: AssetFeatures[], rows: Row[], label: { good: Uint8Array; r: Float64Array }[]): MiningTable {
  const defs = feats[0]!.defs, n = rows.length;
  const cols = defs.map(() => new Float64Array(n)), good = new Uint8Array(n), r = new Float64Array(n), asset = new Int32Array(n);
  rows.forEach((row, j) => { const f = feats[row.asset]!; defs.forEach((_, c) => { cols[c]![j] = f.cols[c]![row.i]!; }); good[j] = label[row.asset]!.good[row.i]!; r[j] = label[row.asset]!.r[row.i]!; asset[j] = row.asset; });
  return { cols, defs, good, r, asset, n };
}
function stats(t: MiningTable, pick: (row: number) => boolean): RuleStats {
  let n = 0, k = 0, sr = 0, G = 0, SR = 0;
  for (let j = 0; j < t.n; j++) { G += t.good[j]!; SR += t.r[j]!; if (pick(j)) { n++; k += t.good[j]!; sr += t.r[j]!; } }
  const base = t.n ? G / t.n : 0, rate = n ? k / n : 0;
  return { n, k, rate, base_rate: base, lift: base > 0 ? rate / base : 0, mean_r: n ? sr / n : 0 };
}
const ruleConds = (r: MinedRule, conds: CondSpec[]) => r.conds.map((i) => conds[i]!.cond);

/**
 * 独立可跑的挖掘入口:只读 data.segments.train 以内的 K 线(特征与标签都截在训练段末尾),验证/留出段一根不碰。
 */
export async function mineOracle(data: FrozenData, opts: OracleOptions = {}): Promise<OracleResult> {
  const t0 = Date.now(), m = opts.mechanics ?? DEFAULT_MECHANICS, H = labelHorizon(m);
  const mo: MineOptions = { ...DEFAULT_MINE, ...(Object.fromEntries(Object.entries(opts).filter(([k, v]) => k in DEFAULT_MINE && v !== undefined)) as Partial<MineOptions>) };
  const P = opts.permutations ?? 200, mode = opts.permutation_mode ?? 'rotate', block = mode === 'iid' ? 1 : opts.block ?? H, seed = opts.seed ?? 20260923;
  const warm = opts.feature_warmup ?? Math.max(data.warmup_bars, Math.ceil((52 * 86400000) / data.timeframe_ms));
  const train = data.segments.train, cut = train.from_ms + Math.floor((train.to_ms - train.from_ms) * 2 / 3);
  const log = opts.progress ?? (() => undefined), notes: string[] = [];
  // 1) 特征(每个资产截到训练段末)
  const assets = data.assets.map((a) => ({ ...a, bars: a.bars.filter((b) => b.close_time <= train.to_ms) })).filter((a) => a.bars.length > warm + H);
  const btc = assets.find((a) => /^BTC/.test(a.symbol))?.bars ?? null;
  if (!btc) notes.push('资产池里没有 BTC,「相对 BTC 残差」特征全为空');
  const feats: AssetFeatures[] = [];
  for (const a of assets) { if (opts.signal?.aborted) throw Error('CANCELLED'); feats.push(computeFeatures(a.symbol, a.bars, data.timeframe_ms, btc)); log(`特征 ${a.symbol} ${a.bars.length} 根`); await yieldLoop(); }
  notes.push('资金费/持仓量未加入特征:本研究是现货 1h,资金费/OI 只有永续有,且与现货 IR 无法表达;下一轮可从 data/perp-market.ts 对齐后只做归因');
  const sides: OracleSideResult[] = [];
  for (const side of opts.sides ?? ['long', 'short']) {
    // 2) 标签:limit = 训练段末根,标签看不到训练段之后
    const labels = assets.map((a) => labelSeries(a.bars, side, m, a.bars.length - 1));
    const mineRows: Row[] = [], testRows: Row[] = [];
    assets.forEach((a, ai) => {
      const lastMine = a.bars.findLastIndex((b) => b.close_time <= cut);
      for (let i = warm; i < a.bars.length; i++) {
        const b = a.bars[i]!; if (b.close_time < train.from_ms || labels[ai]!.good[i] === 255) continue;
        // 挖掘样本的标签不许伸进后 1/3(隔离带 = 标签视野)
        if (b.close_time <= cut) { if (i + H <= lastMine) mineRows.push({ asset: ai, i }); }
        else testRows.push({ asset: ai, i });
      }
    });
    const mt = table(feats, mineRows, labels), tt = table(feats, testRows, labels);
    const G = mt.good.reduce((s, x) => s + x, 0), p0 = G / Math.max(1, mt.n);
    const conds = buildConditions(mt, mo), pairs = buildPairs(conds, mo), tripleCount = new Map<number, number>();
    log(`${side}:挖掘 ${mt.n} 行(好点 ${G},基准 ${(p0 * 100).toFixed(2)}%),条件 ${conds.length},二元组 ${pairs.length}`);
    const goodBits = bitsOf(mt.n, (j) => mt.good[j] === 1);
    const obs = mine(conds, pairs, goodBits, mt.n, mo, true, tripleCount);
    // 3) 置换零分布
    const nullBest = await nullDistribution(mt, conds, pairs, mo, { permutations: P, mode, block, horizon: H, seed: seed + (side === 'short' ? 1 : 0), ...(opts.signal ? { signal: opts.signal } : {}), tick: (k) => log(`${side}:置换 ${k}/${P}`) }, tripleCount);
    const bestScore = obs.best?.score ?? 0, sortedNull = [...nullBest].sort((a, b) => a - b);
    const pOf = (score: number) => permutationP(nullBest, score);
    // 4) 单条 p + BH
    const deff = designEffect(mt.good, mt.asset, H);
    const ps = obs.rules.map((r) => ruleP(r.n, r.k, p0, deff)), bh = benjaminiHochberg(ps, opts.fdr ?? 0.05);
    const order = obs.rules.map((_, i) => i).sort((a, b) => obs.rules[b]!.score - obs.rules[a]!.score);
    const toRule = (idx: number): OracleRule => {
      const r = obs.rules[idx]!, cs = ruleConds(r, conds), colIdx = cs.map((c) => mt.defs.findIndex((d) => d.key === c.feature));
      const inRule = (t: MiningTable) => (j: number) => cs.every((c, q) => holds(c, t.cols[colIdx[q]!]![j]!));
      const trainS = stats(mt, inRule(mt)), testS = stats(tt, inRule(tt));
      const text = cs.map((c) => conditionText(c, mt.defs)).join(' 且 ');
      const built = ruleToIR(cs, side, `oracle ${side === 'long' ? '做多' : '做空'}:${text}`, `事后反推规则(${side}):${text}。训练段前 2/3 好点比例 ${(trainS.rate * 100).toFixed(1)}%(基准 ${(trainS.base_rate * 100).toFixed(1)}%),后 1/3 ${(testS.rate * 100).toFixed(1)}%(基准 ${(testS.base_rate * 100).toFixed(1)}%);置换 p=${pOf(r.score).toFixed(3)}。止损/离场沿用标签的机械管理。`, m);
      const check = built.ir ? checkIR(built.ir, data.timeframe) : null, failed = check && !check.ok ? check.checks.filter((c) => !c.ok).map((c) => `${c.name}:${c.message}`) : [];
      // 只做多的 IR 必须过零模型 checkIR 才算可表达;做空草稿(order 块)照实记录检查结果,不落库
      if (built.ir && failed.length && side === 'long') { built.unexpressed.push(...failed.map((f) => `checkIR 未过 ${f}`)); built.ir = null; }
      return { conditions: cs, text, score: r.score, ...(check ? { check_ok: check.ok, ...(failed.length ? { check_failed: failed } : {}) } : {}), train: trainS, test: testS, holds_on_test: testS.n >= 30 && testS.rate > testS.base_rate, p_rule: ps[idx]!, q_bh: bh.q[idx]!, p_perm: pOf(r.score), expressible: !!built.ir, ...(built.ir ? { ir: built.ir } : {}), ...(built.unexpressed.length ? { unexpressed: built.unexpressed } : {}) };
    };
    // 前 top 条(去掉只是在更强规则上加了个几乎不改变样本的条件的重复:同一组条件集合只留一次)
    const top = order.slice(0, opts.top ?? 10).map(toRule);
    // 挑可表达、后 1/3 仍成立的规则:先用 ruleNodes 快速筛掉表达不了的,再算统计(前 20000 条以内)
    const picks: OracleRule[] = [];
    for (const idx of order.slice(0, 20000)) {
      if (picks.length >= (opts.picks ?? 3)) break;
      if (ruleNodes(ruleConds(obs.rules[idx]!, conds), side).unexpressed.length) continue;
      const r = toRule(idx);
      if (r.expressible && r.holds_on_test && r.train.lift > 1) picks.push(r);
    }
    const testBase = stats(tt, () => true), mineBase = stats(mt, () => true);
    const span = (t: Row[]) => { let from_ms = Infinity, to_ms = -Infinity; for (const r of t) { const at = assets[r.asset]!.bars[r.i]!.close_time; if (at < from_ms) from_ms = at; if (at > to_ms) to_ms = at; } return t.length ? { from_ms, to_ms } : { from_ms: 0, to_ms: 0 }; };
    sides.push({
      side,
      mining: { rows: mt.n, good: G, base_rate: p0, mean_r: mineBase.mean_r, ...span(mineRows) },
      test: { rows: tt.n, good: testBase.k, base_rate: testBase.rate, mean_r: testBase.mean_r, ...span(testRows) },
      conditions: conds.length, rules_tried: obs.tried, design_effect: deff, best_score: bestScore,
      null_dist: { permutations: P, mode, block, mean: nullBest.reduce((a, b) => a + b, 0) / Math.max(1, P), p95: sortedNull[Math.floor(0.95 * (P - 1))] ?? 0, max: sortedNull.at(-1) ?? 0 },
      p_value: pOf(bestScore), bh: { alpha: opts.fdr ?? 0.05, m: ps.length, discoveries: bh.discoveries }, top, picks,
    });
    log(`${side}:最优得分 ${bestScore.toFixed(1)},置换 p=${pOf(bestScore).toFixed(3)},BH 发现 ${bh.discoveries}/${ps.length},可用规则 ${picks.length}`);
  }
  return { universe: data.universe, timeframe: data.timeframe, mechanics: m, options: { ...mo, permutations: P, permutation_mode: mode, block, seed }, sides, notes, elapsed_ms: Date.now() - t0 };
}

/** 生成器用的显著性门槛:最优规则的置换 p 超过它就说明「挖到的只是噪声」,不出候选 */
export const ORACLE_MAX_P = 0.1;
export const oracleGenerator: CandidateGenerator = {
  name: 'oracle',
  async generate(ctx: GeneratorContext) {
    if (ctx.budget <= 0 || ctx.data.timeframe_ms > HOUR) return [];
    const res = await mineOracle(ctx.data, { sides: ['long'], picks: Math.min(3, ctx.budget), ...(ctx.signal ? { signal: ctx.signal } : {}) });
    const long = res.sides[0]!;
    if (long.p_value > ORACLE_MAX_P) return [];
    const out: Awaited<ReturnType<CandidateGenerator['generate']>> = [];
    for (const rule of long.picks) {
      const got = addRuleToParent(ctx.parent.ir, rule.conditions);
      if (!got || !ctx.check(got.ir).ok) continue;
      out.push({
        generator: 'oracle', ir: got.ir, diff: got.diff,
        rationale: `事后反推:训练段前 2/3 满足「${rule.text}」的 K 线里,按机械管理能跑到 ≥${res.mechanics.good_r}R 的比例是 ${(rule.train.rate * 100).toFixed(1)}%(基准 ${(rule.train.base_rate * 100).toFixed(1)}%),后 1/3 仍为 ${(rule.test.rate * 100).toFixed(1)}%(基准 ${(rule.test.base_rate * 100).toFixed(1)}%);作为入场过滤加到父策略上。标签含未来数据,是否有效以验证段回测为准。`,
        evidence: { p_value: long.p_value, p_perm: rule.p_perm, p_rule: rule.p_rule, q_bh: rule.q_bh, support: rule.train.n, train_rate: rule.train.rate, train_base: rule.train.base_rate, test_rate: rule.test.rate, test_base: rule.test.base_rate, test_support: rule.test.n, conditions: rule.conditions, permutations: long.null_dist.permutations, permutation_mode: long.null_dist.mode, bh_discoveries: long.bh.discoveries, rules_tried: long.rules_tried },
      });
      if (out.length >= ctx.budget) break;
    }
    return out;
  },
};
