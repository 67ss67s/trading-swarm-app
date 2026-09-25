/**
 * 复盘页的纯逻辑(不碰 React、不取数,方便单测):
 *   - centerStats:均值 / 中位数 / 截尾均值,口径**逐字对齐**网关 research/analyzer.ts centerStats
 *     (两端各截 floor(n × 10%) 个;n < 10 不截尾,截尾均值 = 均值;中位数偶数取中间两个的均值)。
 *   - ledgerKeyOf / rowEligible / clusterKeyOf:对齐网关 judgment-ledger.ts 的分层键、结算完整性过滤与簇键,
 *     这样前端从逐行算出来的均值能和 summary 的 judgment_alpha 对得上(同一批行、同一个簇均值口径)。
 *   - alphaCenter:按簇均值后的 (R_模型 − R_议会) 分布 → centerStats(单位「簇」)。
 *   - regretSplit:复查 regret 拆成「该走没走」(HOLD/ADD 的 regret_hold)与「不该走走了」(EXIT/INVALIDATE 的 regret_exit)。
 *   - strategyHref:策略 id → 「我的策略」深链(研究对象 rs_… 直接链;内置策略名经 lab_strategy_id 反查)。
 */
import type { CandidateRow, LedgerDimV2, LedgerRowV2, StrategyIndexItem } from '@/api/ledger-v2';

export const TRIM_FRACTION = 0.1;
/** 复盘页的「观察」门槛:样本 < 30 只看方向,不下结论(设计文档 二-4)。 */
export const OBSERVE_MIN = 30;
/** 网关把没指明策略的行归到这个值(不能当 strategy_id 查参数)。 */
export const UNNAMED_STRATEGY = '(未指明策略)';

export interface CenterStats {
  n: number;
  mean: number | null;
  median: number | null;
  trimmed_mean: number | null;
  trimmed_each_side: number;
  trim_fraction: number;
}

const avg = (xs: readonly number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function centerStats(values: readonly number[], trim = TRIM_FRACTION): CenterStats {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = xs.length;
  const k = Math.floor(n * trim + 1e-9);
  if (!n) return { n, mean: null, median: null, trimmed_mean: null, trimmed_each_side: 0, trim_fraction: trim };
  const median = (xs[Math.floor((n - 1) / 2)]! + xs[Math.floor(n / 2)]!) / 2;
  return { n, mean: avg(xs), median, trimmed_mean: avg(xs.slice(k, n - k)), trimmed_each_side: k, trim_fraction: trim };
}

export function isObservation(n: number): boolean {
  return n < OBSERVE_MIN;
}

// ---------------------------------------------------------------- 判断账本逐行

/** 结算不完整(partial / missing)的行不进任何统计(网关 ledgerRowEligible)。 */
export function rowEligible(r: LedgerRowV2): boolean {
  return r.settlement_status === null || r.settlement_status === undefined || r.settlement_status === 'complete';
}

export function clusterKeyOf(r: LedgerRowV2): string {
  return String(r.cluster_id ?? r.thread_id ?? r.episode_id);
}

/** 行上某个分层键的值;旧行(jl-v1)缺键 = 'unknown';holding_reason 只对复查行有意义,扫描行记 '(scan)'。 */
export function ledgerKeyOf(r: LedgerRowV2, dim: LedgerDimV2): string {
  if (dim === 'strategy') return r.strategy_id ?? UNNAMED_STRATEGY;
  if (dim === 'holding_reason' && r.mode !== 'review') return '(scan)';
  const v = dim === 'trigger_kind' ? r.trigger_kind : dim === 'holding_reason' ? r.holding_reason : r.prompt_version;
  return v === null || v === undefined || v === '' ? 'unknown' : v;
}

/** 按分层键把行分桶;holding_reason 只收复查行(与网关 by_holding_reason 同口径)。 */
export function groupRows(rows: readonly LedgerRowV2[], dim: LedgerDimV2): Map<string, LedgerRowV2[]> {
  const out = new Map<string, LedgerRowV2[]>();
  for (const r of rows) {
    if (dim === 'holding_reason' && r.mode !== 'review') continue;
    const k = ledgerKeyOf(r, dim);
    const g = out.get(k);
    if (g) g.push(r);
    else out.set(k, [r]);
  }
  return out;
}

export interface AlphaCenter extends CenterStats {
  /** 进统计的配对行数(已结算、结算完整、两条腿都有 R)。 */
  pairs: number;
}

/**
 * 判断增量的分布:先把每个簇内的 (R_模型 − R_议会) 求均值(网关 clusterMean 的做法),
 * 再对这些簇均值取 centerStats。所以 mean 应当 ≈ summary 的 judgment_alpha(网关四舍五入到 4 位)。
 */
export function alphaCenter(rows: readonly LedgerRowV2[]): AlphaCenter {
  const paired = rows.filter((r) => rowEligible(r) && r.settled_at !== null && r.outcome_r_model !== null && r.outcome_r_council !== null);
  const buckets = new Map<string, number[]>();
  for (const r of paired) {
    const k = clusterKeyOf(r);
    const v = buckets.get(k) ?? [];
    v.push(r.outcome_r_model! - r.outcome_r_council!);
    buckets.set(k, v);
  }
  const perCluster = [...buckets.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
  return { ...centerStats(perCluster), pairs: paired.length };
}

const HOLD_ACTIONS = new Set(['HOLD', 'ADD']);
const EXIT_ACTIONS = new Set(['EXIT', 'INVALIDATE']);

/** 「该走没走」:选了拿着(HOLD/ADD)的复查行;旧行没 regret_hold 时按同一公式从 hold_r / exit_now_r 回推。 */
export function regretHoldOf(r: LedgerRowV2): number | null {
  if (!r.regret || !r.model_action || !HOLD_ACTIONS.has(r.model_action)) return null;
  const v = r.regret.regret_hold ?? r.regret_hold;
  return v !== null && v !== undefined ? v : Math.max(0, r.regret.exit_now_r - r.regret.hold_r);
}

/** 「不该走走了」:选了走(EXIT/INVALIDATE)的复查行;旧行没 regret_exit 时回推。 */
export function regretExitOf(r: LedgerRowV2): number | null {
  if (!r.regret || !r.model_action || !EXIT_ACTIONS.has(r.model_action)) return null;
  const v = r.regret.regret_exit;
  return v !== null && v !== undefined ? v : Math.max(0, r.regret.hold_r - r.regret.exit_now_r);
}

export interface RegretSide extends CenterStats {
  /** regret > 0.5R 的占比(「明显后悔」,网关 DECISION_REGRET_THRESHOLD_R 同口径)。 */
  over_half_share: number | null;
  clusters: number;
}

export interface RegretSplit {
  /** 窗口内复查行总数(含未结算)。 */
  reviews: number;
  /** 已结算且 regret 算得出的复查行。 */
  scored: number;
  hold: RegretSide;
  exit: RegretSide;
}

function regretSide(rows: readonly LedgerRowV2[], pick: (r: LedgerRowV2) => number | null): RegretSide {
  const hits = rows.flatMap((r) => {
    const v = pick(r);
    return v === null ? [] : [{ v, c: clusterKeyOf(r) }];
  });
  const vs = hits.map((h) => h.v);
  return { ...centerStats(vs), over_half_share: vs.length ? vs.filter((v) => v > 0.5).length / vs.length : null, clusters: new Set(hits.map((h) => h.c)).size };
}

/**
 * 复查 regret 按「选了什么」拆开。与网关决策表一致:只看复查、已结算、regret 可算的行,**不按结算完整性剔除**
 * (regret 只读线程计划与 K 线,不读交易所净额)。
 */
export function regretSplit(rows: readonly LedgerRowV2[]): RegretSplit {
  const reviews = rows.filter((r) => r.mode === 'review');
  const scored = reviews.filter((r) => r.settled_at !== null && r.regret !== null);
  return { reviews: reviews.length, scored: scored.length, hold: regretSide(scored, regretHoldOf), exit: regretSide(scored, regretExitOf) };
}

// ---------------------------------------------------------------- 深链

/**
 * 策略 id → 「我的策略」详情深链(#my-strategies?id=<rs_…>)。
 * - 研究对象 id(rs_…)且在列表里 → 直接链;
 * - 内置策略名(breakout_retest 这类)→ 经 lab_strategy_id 精确反查;
 * - 合成策略(synth:…)、'(未指明策略)'、带版本后缀的变体 → null(不猜)。
 */
export function strategyHref(id: string | null | undefined, index: readonly StrategyIndexItem[]): string | null {
  if (!id || id === UNNAMED_STRATEGY) return null;
  const hit = index.find((s) => s.id === id) ?? index.find((s) => s.lab_strategy_id === id);
  return hit ? `#my-strategies?id=${encodeURIComponent(hit.id)}` : null;
}

// ---------------------------------------------------------------- 影子候选

/** 已按计划腿走完的候选的 R(plan / trail / 计划净 R)。invalid / unscoreable 不进。 */
export function candidateLegStats(rows: readonly CandidateRow[]): { plan: CenterStats; trail: CenterStats; net: CenterStats } {
  const walked = rows.filter((c) => c.settlement?.source === 'plan_walk');
  const pick = (f: (c: CandidateRow) => number | null | undefined) => walked.flatMap((c) => {
    const v = f(c);
    return v === null || v === undefined ? [] : [v];
  });
  return {
    plan: centerStats(pick((c) => c.settlement?.plan?.r)),
    trail: centerStats(pick((c) => c.settlement?.trail?.r)),
    net: centerStats(pick((c) => c.settlement?.plan?.net_r)),
  };
}
