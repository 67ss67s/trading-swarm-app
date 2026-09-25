// 策略议会(strategy council,2026-09-09,docs/design/strategy-council-2026-09-09.md)。
//
// 之前的判断循环是「一次大脑调用 + 所有被唤醒的策略一起塞进 prompt,模型自己挑一条」。Jacky 要的是
// 策略层成为循环里**独立的一步**:每条策略对每个资产先各自表态(适配 + 裁决),多条策略表态一致才允许
// 交易,并且这份表态**放回线程**,持仓复查时再核一遍「当初同意的那几家现在还同不同意」。
//
// 分工(和策略库/记忆一样的原则:模型不改数字,代码算证据):
//   - 裁决(verdict)默认是**代码**算的:每个策略 id 在 STRATEGY_VERDICT 里注册一个纯函数,读同一套
//     清单/指标(scanChecklist、策略证据行)给出 stance(long/short/neutral/abstain)+ 信心 + 逐项检查。
//     没注册的策略只能 abstain(弃权),弃权不算票——这是给 Opus 填的洞,见设计文档「待填」。
//   - 可选让模型逐策略表态(workflow.council_model = cheap/main):每策略一次小调用,只看这一条策略,
//     输出一个极小 JSON;buildVerdictPrompt / parseVerdict 是纯函数,runtime 负责调用与合并。
//   - 适配(fit)= 这条策略对这个资产合不合适:Radar 候选 fit_score、Lab/eval 期望、本币本策略历史战绩,
//     代码加权,缺的部分算 null,不编数。
//   - 共识(consensus)= 纯函数:同向且信心过线的票数 ≥ min_agree,且没有过线的反向票。
//   - 结果既进 episode(strategy_council)也进线程(council 快照),复查时 councilReview() 复核。
//
// 本文件不做 I/O、不调模型、不看时钟(now 由调用方传),eval/回放可以原样重放。

import { scanChecklist, type ScanChecklist } from './review-metrics.js';
import { HORIZON_POLICY, type StrategyHorizon } from './horizon.js';
import { evidenceBarsFor } from './evidence-plan.js';
import { evidenceOf, fundingZScore, minBarsFor, scanThresholdsOf, strategyEvidence, strategyKey, type StrategyEvidenceInput, type StrategyEvidenceLine, type StrategySpec } from './strategies.js';
import { createHash } from 'node:crypto';
import { MIN_BARS, reversionStats } from './reversion-stats.js';
import type { DailyRegime, Direction, Kline, MarketView, TriggerHit } from './types.js';
import type { TfFeatures } from './market.js';

export const COUNCIL_VERSION = 'council-v1';

/** off = 旧行为(不算);advise = 算出来当证据,不拦;require = PROPOSE 必须有共识(代码闸「策略共识」)。 */
export type CouncilMode = 'off' | 'advise' | 'require';
/** off = 只用代码裁决;cheap/main = 每条被唤醒的策略再各问一次模型(每策略一次调用,花钱)。 */
export type CouncilModelMode = 'off' | 'cheap' | 'main';

export type VerdictStance = 'long' | 'short' | 'neutral' | 'abstain';

/**
 * 09-12:**「策略方向成立」和「入场时机已确认」是两个裁决**(Jacky 拍板)。
 * 以前「突破了但还没回踩」被算成 neutral,整条策略等于没票——可策略原文本来就允许「未确认时挂限价等回踩」。
 * 现在方向成立照样投方向票,时机单独表达:
 *  - `confirmed` = 回踩/触发已确认,市价可用(仍受 entry-policy 的 1 ATR 追单闸);
 *  - `pending`   = 方向成立但时机未确认,**只许限价挂回踩区**(consensusGate 会拒市价开仓);
 *  - `failed`    = 时机判据直接不成立(不是「还没到」而是「过了/坏了」),不投方向票。
 * 弃权(abstain)时为 null:连方向都没有,谈不上时机。
 */
export type EntryTiming = 'confirmed' | 'pending' | 'failed';

export interface VerdictCheck {
  id: string;
  /** null = 这项算不出来(数据缺)。 */
  pass: boolean | null;
  note: string;
}

export interface StrategyFit {
  /** 0–1;null = 一个来源都没有(不编数)。 */
  score: number | null;
  parts: { radar: number | null; lab: number | null; eval: number | null; history: number | null };
  note: string;
}

export interface StrategyVerdict {
  strategy_id: string;
  version: number;
  content_hash: string;
  horizon: StrategyHorizon;
  stance: VerdictStance;
  /** 0–1;abstain 时为 0。 */
  confidence: number;
  /** 方向成立之外的第二个裁决:入场时机(见 {@link EntryTiming});abstain/无方向时为 null。 */
  entry_timing: EntryTiming | null;
  source: 'code' | 'model' | 'code+model';
  /**
   * 09-12 §1.2:**只表态、不计共识**的票(影子实盘策略)。`consensus()` 把它整条排除在
   * voting/agreeing/dissenting/abstaining 之外——一条还没到 paper 的策略不该影响真仓位。
   * 旧快照没有这个字段 → undefined = 正式票。
   */
  advisory?: boolean;
  fit: StrategyFit;
  checks: VerdictCheck[];
  reasons: string[];
  at: number;
}

export interface CouncilPolicy {
  mode: CouncilMode;
  /**
   * 至少几条策略同向才算共识。**不再被钳到「能投票的策略数」**:能投票的策略比它少时,
   * 判定为「共识闸当前无效」(fail closed,`gate_effective=false`、`reached=false`),
   * 而不是悄悄把门槛降到 1——数据更少反而更容易开仓是这条闸最危险的失效方式。
   */
  min_agree: number;
  /** 低于这个信心的票不算。 */
  confidence_floor: number;
}

export interface Consensus {
  reached: boolean;
  direction: Direction | null;
  agreeing: string[];
  dissenting: string[];
  neutral: string[];
  abstaining: string[];
  /** 用户设的 min_agree,**原样**(不再钳降);前端显示这个数就是真门槛。 */
  required: number;
  /** 这次真正能投票(非弃权)的策略 id。 */
  voting: string[];
  /**
   * 共识闸这次是否有效:能投票的策略够不够撑起 `required`(require 模式还要求至少 {@link REQUIRE_MIN_VOTERS} 条)。
   * false 时 `reached` 一定是 false,前端应显示「共识闸当前无效」而不是「无共识」。
   */
  gate_effective: boolean;
  /** gate_effective=false 时的可读原因;有效时为空串。 */
  gate_reason: string;
  /** 同意方里最保守的入场时机:任一条 pending 就是 pending;没有方向票时 null。 */
  entry_timing: EntryTiming | null;
  reason: string;
}

export interface CouncilResult {
  version: string;
  at: number;
  symbol: string;
  mode: CouncilMode;
  verdicts: StrategyVerdict[];
  /** **最终**共识 = 纯代码共识 ∩ 合并模型票后的共识(见 {@link narrowByCode});闸读的是这一份。 */
  consensus: Consensus;
  /**
   * 09-12 P1-05:**纯代码**票算出来的共识(允许集的上界)。模型只能在它之内收窄,不能扩大。
   * 旧快照没有这个字段 → undefined。
   */
  code_consensus?: Consensus;
  /** 进 prompt 的一行证据(代码汇总)。 */
  text: string;
}

/** 落在线程上的快照:开仓时谁同意、谁反对,复查时拿来对照。 */
export interface CouncilSnapshot {
  version: string;
  at: number;
  direction: Direction | null;
  reached: boolean;
  agreeing: string[];
  dissenting: string[];
  /** 开仓那一刻共识闸有没有效(旧快照没有这个字段 → undefined)。 */
  gate_effective?: boolean;
  entry_timing?: EntryTiming | null;
  /**
   * §9.36(P1-06 第 3 条)**全票池冻结**:开仓那一刻票池里每一条策略的版本与内容哈希——
   * 不只主策略。复查时按这份取回(`pinnedPoolFrom`),停用不会让辅助票凭空消失,
   * 升级也不会把当初那一票的规则换掉。旧快照没有这个字段 → undefined,复查退回旧口径。
   */
  pool?: { strategy_id: string; version: number; content_hash: string }[];
  /** {@link poolHash} of `pool`;两次判断票池一不一样看这个,不用逐条比。 */
  pool_hash?: string;
  votes: { strategy_id: string; version: number; content_hash?: string; stance: VerdictStance; confidence: number; fit: number | null }[];
}

// ---------------------------------------------------------------- §9.36 票池:口径、冻结、取回、K 线深度

/** 票池身份:`id@version@content_hash` 排序后的 sha256 前 16 位。 */
export function poolHash(specs: readonly Pick<StrategySpec, 'id' | 'version' | 'content_hash'>[]): string {
  const keys = specs.map((s) => `${s.id}@${s.version}@${s.content_hash}`).sort();
  return createHash('sha256').update(JSON.stringify(keys)).digest('hex').slice(0, 16);
}

/**
 * P1-06 第 2 条:**正式票池的唯一口径**。Radar 候选只能**排前**(优先扫描/优先渲染),
 * 不能把一条已经从 `workflow.active_strategies` 停掉的策略塞回正式票池——
 * 「停用 = 摘出票池」是前端与 §9.28 承诺过的权限边界,Radar 不是一条绕过它的后门。
 *
 * 返回的顺序:候选(如果它本来就在 active 里)排最前,其余按 active 原顺序。
 */
export function effectivePoolIds(activeIds: readonly string[], candidateId: string | null): string[] {
  const active = [...new Set(activeIds.map(String))];
  if (!candidateId || !active.includes(candidateId)) return active;
  return [candidateId, ...active.filter((x) => x !== candidateId)];
}

/**
 * P1-06 第 3 条:按开仓快照把**全票池**逐条取回(每条都用快照里的版本)。
 * `lookup(id, version)` 取不到就退回 `head(id)` 并在 `missing` 里记一笔——
 * 取不到的那一条不该被悄悄忽略,复查文本要说得出「当初那一票现在查不到了」。
 */
export function pinnedPoolFrom(
  snapshot: Pick<CouncilSnapshot, 'pool' | 'votes' | 'agreeing'>,
  lookup: (id: string, version: number) => StrategySpec | null,
  head: (id: string) => StrategySpec | null,
): { specs: StrategySpec[]; missing: string[]; abstained: string[] } {
  const want = snapshot.pool?.length
    ? snapshot.pool.map((p) => ({ id: p.strategy_id, version: p.version, content_hash: p.content_hash as string | undefined }))
    : snapshot.votes?.length
      ? snapshot.votes.map((v) => ({ id: v.strategy_id, version: v.version, content_hash: v.content_hash }))
      : snapshot.agreeing.map((id) => ({ id, version: 0, content_hash: undefined }));
  const specs: StrategySpec[] = [];
  const missing: string[] = [];
  const abstained: string[] = [];
  const seen = new Set<string>();
  for (const w of want) {
    if (seen.has(`${w.id}@${w.version}`)) continue;
    seen.add(`${w.id}@${w.version}`);
    if (w.version > 0) {
      // 冻结的是**那一版的内容**:版本号对得上、内容 hash 对不上(同 (id,version) 被覆盖写过)
      // 也算取不到。取不到时**弃权 + warn**,不拿 head 代投 —— 拿 head 投票等于用今天的规则
      // 去复查昨天那一票,复查对照的就不是同一场议会了(09-12 复审 §2)。
      const pinned = lookup(w.id, w.version);
      if (pinned && (!w.content_hash || pinned.content_hash === w.content_hash)) {
        specs.push(pinned);
        continue;
      }
      const why = pinned ? `内容 hash 对不上(冻结 ${String(w.content_hash).slice(0, 8)},库里 ${pinned.content_hash.slice(0, 8)})` : '库里已取不到这一版';
      missing.push(`${w.id} v${w.version}(${why},本轮这一票弃权)`);
      abstained.push(`${w.id}@${w.version}`);
      continue;
    }
    // 旧快照压根没记版本号(只有 agreeing 一串 id):那不是「冻结版本丢了」,是当初就没冻结,
    // 只能退回 head,并在 missing 里说清楚。
    const h = head(w.id);
    if (h) {
      specs.push(h);
      missing.push(`${w.id}(旧快照没记版本,只能用 head v${h.version} 对照)`);
    } else missing.push(`${w.id}(库里已无此策略)`);
  }
  return { specs, missing, abstained };
}

/** 票池成员键:`id@version@content_hash`(出队复查要比到内容,不只是 id)。 */
export function poolKeys(specs: readonly Pick<StrategySpec, 'id' | 'version' | 'content_hash'>[]): string[] {
  return specs.map((s) => `${s.id}@${s.version}@${s.content_hash}`);
}

/**
 * 出队前的票池复查(纯函数;runtime 的 `strategyGuard` 只负责取数与写日志)。
 *
 * 09-12 复审 §2:入队与出队之间票池可能被换掉/降级/改政策,带着一份已经不成立的票池去调模型,
 * 花的是真钱、拿回来的是一个注定被闸拒的提议。判据要与**正式执行池同口径**:
 *  1. 键比到 `id@version@content_hash` —— 同一条策略换了一版就是另一套规则,不算同一个池;
 *  2. `require` 模式下能投票的策略数要够 `max(min_agree, REQUIRE_MIN_VOTERS)`,否则共识闸必然
 *     fail closed(`consensus()` 不再钳降门槛)。
 */
export function poolGuard(inp: { enqueued: readonly string[]; current: readonly string[]; mode: CouncilPolicy['mode'] | 'off'; min_agree: number }): { drop: boolean; reason: string } {
  if (inp.enqueued.length && inp.current.length && !inp.enqueued.some((k) => inp.current.includes(k))) {
    return { drop: true, reason: `入队时的票池(${inp.enqueued.join('/')})已被整体换成(${inp.current.join('/')})` };
  }
  if (inp.mode === 'require') {
    const required = Math.max(inp.min_agree, REQUIRE_MIN_VOTERS);
    if (inp.current.length < required) return { drop: true, reason: `票池里只有 ${inp.current.length} 条 ≥paper 的策略(require 模式需要 ${required} 条):共识闸必然无效` };
  }
  return { drop: false, reason: '' };
}

/** 指标快照要算得出 EMA200/TRIX30 这类长窗口指标,evidence 点名的周期至少拉这么多根。 */
export const EVIDENCE_TF_BARS = 220;
/** 单个周期一次最多拉多少根(币安上限)。 */
export const KLINE_PLAN_CAP = 1500;

export interface KlinePlanInput {
  /** 本轮判断的主周期(扫描周期 / 线程复查周期)。 */
  primary_tf: string;
  /** 全票池:active ∪ shadow ∪ pinned ∪ Radar 候选。深度按**每条策略自己的 min_bars** 算。 */
  pool: readonly StrategySpec[];
  /** evidence plan 里点名的周期(指标要多少根由 {@link EVIDENCE_TF_BARS} 定)。 */
  evidence_tfs?: readonly string[];
  /** 别的地方点名要的周期与根数(线程持仓周期等)。 */
  extra?: readonly { tf: string; bars: number }[];
}

/**
 * P1-06 第 1 条:**按 tf 聚合取 max** 的 K 线拉取计划。
 *
 * 旧代码先按票池算了 `scanBars`(range_mean_reversion 要 400 根),再拼
 * `{[tf]: kTf, '1h': k1h, '4h': k4h}` —— tf 正好是 1h/4h 时后写的 120/80 **把 400 覆盖掉了**,
 * 于是那条策略在最常用的两个周期上永远「数据不足」。这里的规则很简单:同一个 tf 只有一个数字,
 * 取所有来源里的最大值。
 */
export function klinePlan(inp: KlinePlanInput): Record<string, number> {
  const out: Record<string, number> = {};
  const want = (tf: string, bars: number): void => {
    if (!tf) return;
    out[tf] = Math.min(KLINE_PLAN_CAP, Math.max(out[tf] ?? 0, Math.round(bars)));
  };
  // 基线:主周期 + 1h/4h 的大局周期(与旧行为同数,只是不再互相覆盖)。
  want(inp.primary_tf, minBarsFor([]));
  want('1h', 120);
  want('4h', 80);
  for (const spec of inp.pool) {
    const depth = minBarsFor([spec]);
    const hp = HORIZON_POLICY[spec.horizon];
    want(inp.primary_tf, depth);
    want(hp.timeframe, depth);
    // 确认周期的深度**不低于这条策略自己的 min_bars**:旧补拉循环用的就是 max(80, minBarsFor(spec)),
    // round(depth/2) 会把 400 根的策略在确认周期上砍到 200,于是它在那个周期永远「数据不足」。
    want(hp.confirm, Math.max(80, depth));
    // 这条策略自己点名的判据周期(checklist.timeframes)也要有够深的数据,否则它照样「静默弃权」。
    for (const ctf of spec.checklist.timeframes ?? []) want(ctf, Math.max(80, depth));
    // 深度按**这条证据自己的窗口**算(P1-11):点名 200 窗口的指标要 450 根,220 根是不够的。
    for (const ind of evidenceOf(spec).indicators) want(ind.tf, evidenceBarsFor(ind));
  }
  for (const tf of inp.evidence_tfs ?? []) want(tf, EVIDENCE_TF_BARS);
  for (const e of inp.extra ?? []) want(e.tf, e.bars);
  return out;
}

export const DEFAULT_COUNCIL_POLICY: CouncilPolicy = { mode: 'advise', min_agree: 2, confidence_floor: 0.4 };

// ---------------------------------------------------------------- 裁决(代码)

export interface VerdictInputs {
  now: number;
  symbol: string;
  /** 扫描周期(线程复查时是 reviewTimeframe)。 */
  timeframe: string;
  features: TfFeatures[];
  klines: Record<string, Kline[]>;
  market: MarketView;
  oi_change_1h_pct: number | null;
  funding_history?: { at: number; rate: string }[];
  daily_regime: DailyRegime | null;
  trigger_hits: TriggerHit[];
  /** 这条策略这次有没有被触发器唤醒(没唤醒 = 弃权,不是反对)。 */
  woken: boolean;
}

export interface VerdictOutput {
  stance: VerdictStance;
  confidence: number;
  /** 入场时机裁决(与方向分开);不填时按 stance 推断:有方向 = confirmed,无方向 = null。 */
  entry_timing?: EntryTiming | null;
  checks: VerdictCheck[];
  reasons: string[];
  /**
   * 弃权的原因(stance='abstain' 时有):
   *  - `unimplemented` = 这条策略还没有代码裁决,模型票可以补上;
   *  - `data` = 判据算不出来(K 线不足 / 行情缺失),**模型票也不能补**——它看的是同一份缺失的证据;
   *  - `not_woken` = 这次触发器没唤醒它。
   */
  abstain_reason?: 'unimplemented' | 'data' | 'not_woken';
}

export type StrategyVerdictFn = (spec: StrategySpec, inp: VerdictInputs, evidence: StrategyEvidenceLine[], checklist: ScanChecklist | null) => VerdictOutput;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** 这条策略的扫描清单:按它自己的 horizon 周期排前、用它自己的阈值。 */
export function checklistFor(spec: StrategySpec, inp: VerdictInputs): ScanChecklist | null {
  const hp = spec.horizon === 'swing' || spec.horizon === 'position' ? HORIZON_POLICY[spec.horizon] : null;
  const feats = hp ? inp.features.filter((f) => f.tf === hp.timeframe).concat(inp.features.filter((f) => f.tf !== hp.timeframe)) : inp.features;
  const tf = feats[0]?.tf ?? inp.timeframe;
  return scanChecklist(feats, inp.klines[tf], { ...scanThresholdsOf(spec), ...(hp ? { trend_timeframes: [hp.timeframe, hp.confirm] as const } : {}) });
}

function regimeAgainst(regime: DailyRegime | null, dir: Direction): boolean {
  if (!regime) return false;
  return (regime.regime === 'bear' && dir === 'long') || (regime.regime === 'bull' && dir === 'short');
}

/** 突破-回踩三族共用:趋势同向 + 追单距离内 + 回踩确认 + ATR 门槛 + 日线不反向。 */
const breakoutVerdict: StrategyVerdictFn = (_spec, inp, _ev, chk) => {
  if (!chk) return { stance: 'abstain', confidence: 0, checks: [], reasons: ['扫描清单不可得'], abstain_reason: 'data' };
  // ATR% 算不出来 = 判据缺一项,弃权(不是投中立票:中立是「看过了不做」,弃权是「看不到」)。
  if (chk.atr_pct === null) return { stance: 'abstain', confidence: 0, checks: [{ id: 'atr_ok', pass: null, note: 'ATR% 不可得(K 线不足)' }], reasons: ['ATR% 不可得,判不了追单与波动门槛'], abstain_reason: 'data' };
  const dir = chk.trend_agree;
  const checks: VerdictCheck[] = [
    { id: 'trend_agree', pass: dir !== null, note: chk.trend_note },
    { id: 'atr_ok', pass: chk.atr_ok, note: `ATR% ${chk.atr_pct?.toFixed(2) ?? 'n/a'} 门槛 ${chk.atr_floor}` },
    { id: 'within_chase', pass: dir ? chk.within_chase : null, note: `距突破位 ${chk.dist_to_break_atr?.toFixed(2) ?? 'n/a'} ATR` },
    { id: 'retest_confirmed', pass: dir ? chk.retest_confirmed : null, note: chk.retest_confirmed ? '回踩确认' : '回踩未确认' },
    { id: 'regime_ok', pass: dir ? !regimeAgainst(inp.daily_regime, dir) : null, note: inp.daily_regime ? `日线 ${inp.daily_regime.regime}` : '日线状态不可得' },
  ];
  const failed = checks.filter((c) => c.pass === false).map((c) => c.id);
  if (!dir) return { stance: 'neutral', confidence: 0, entry_timing: 'failed', checks, reasons: ['趋势周期不同向'] };
  if (failed.length === 0) return { stance: dir, confidence: clamp01(0.55 + (chk.vol_ratio && chk.vol_ratio > 1.5 ? 0.15 : 0) + (chk.trend_strength === 'strong' ? 0.1 : 0)), entry_timing: 'confirmed', checks, reasons: [`${dir === 'long' ? '做多' : '做空'}条件齐:${checks.map((c) => c.id).join('/')}`] };
  // 09-12:趋势同向、只差「回踩还没确认」= **方向成立、时机 pending**,而不是中立票。
  // 策略原文本来就写着「刚突破未回踩 → 限价挂突破位与 EMA20 之间」,以前一律投中立等于把这条入场方式判死。
  if (failed.length === 1 && failed[0] === 'retest_confirmed' && chk.watch_eligible) return { stance: dir, confidence: 0.45, entry_timing: 'pending', checks, reasons: ['趋势同向、回踩未确认:方向成立,只许限价挂回踩区'] };
  return { stance: 'neutral', confidence: 0, entry_timing: 'failed', checks, reasons: [`未过:${failed.join('/')}`] };
};

/** 多周期对齐:趋势同向 + 价在 EMA20 有利侧;不要求回踩。 */
const mtfVerdict: StrategyVerdictFn = (_spec, _inp, _ev, chk) => {
  if (!chk) return { stance: 'abstain', confidence: 0, checks: [], reasons: ['扫描清单不可得'], abstain_reason: 'data' };
  const dir = chk.trend_agree;
  const sideOk = dir === null || chk.price_above_ema20 === null ? null : dir === 'long' ? chk.price_above_ema20 : !chk.price_above_ema20;
  const checks: VerdictCheck[] = [
    { id: 'trend_agree', pass: dir !== null, note: chk.trend_note },
    { id: 'price_side', pass: sideOk, note: chk.price_above_ema20 === null ? 'EMA20 位置不可得' : chk.price_above_ema20 ? '价在 EMA20 上' : '价在 EMA20 下' },
    { id: 'atr_ok', pass: chk.atr_ok, note: `ATR% ${chk.atr_pct?.toFixed(2) ?? 'n/a'}` },
  ];
  // 价相对 EMA20 的位置算不出来 = 缺判据,弃权(以前混进「价不在有利侧」的中立票里)。
  if (dir && chk.price_above_ema20 === null) return { stance: 'abstain', confidence: 0, checks, reasons: ['EMA20 位置不可得,判不了入场侧'], abstain_reason: 'data' };
  if (dir && sideOk && chk.atr_ok) return { stance: dir, confidence: 0.5, entry_timing: 'confirmed', checks, reasons: ['多周期同向且价在有利侧'] };
  return { stance: 'neutral', confidence: 0, entry_timing: 'failed', checks, reasons: [dir ? '价不在有利侧或波动不足' : '周期不同向'] };
};

const param = (spec: StrategySpec, key: string, fallback: number): number => spec.params[key]?.value ?? fallback;

/** 突破方向:与 triggers.ts 同一口径(比的是**这根之前**的 20 根高低点),不是 EMA 趋势方向。 */
function breakoutDirection(f: TfFeatures | undefined): Direction | null {
  if (!f) return null;
  const hi = f.swing_high_20_prev ?? f.swing_high_20;
  const lo = f.swing_low_20_prev ?? f.swing_low_20;
  if (f.last_close > hi) return 'long';
  if (f.last_close < lo) return 'short';
  return null;
}

/** 波动压缩→扩张:先压缩(带宽分位低或 squeeze 连续),再同根放量突破,顺扩张方向;没压缩过就不是这条策略的活。 */
const volCompressionVerdict: StrategyVerdictFn = (spec, inp, _ev, chk) => {
  if (!chk) return { stance: 'abstain', confidence: 0, checks: [], reasons: ['扫描清单不可得'], abstain_reason: 'data' };
  const rankMax = param(spec, 'bb_width_rank_max', 20);
  const barsMin = param(spec, 'squeeze_bars_min', 6);
  const spikeMin = param(spec, 'vol_spike_min', 1.8);
  const chaseMax = param(spec, 'chase_atr_max', 1.5);
  // 带宽分位与 squeeze 都算不出来 = 没有指标快照(K 线不足),这条策略无从判断。
  if (chk.bb_width_rank_90 === null && chk.squeeze_on === null) return { stance: 'abstain', confidence: 0, checks: [{ id: 'compression_data', pass: null, note: '带宽分位与 squeeze 都不可得(K 线不足)' }], reasons: ['压缩证据不可得,不投票'], abstain_reason: 'data' };
  const compressed = (chk.bb_width_rank_90 !== null && chk.bb_width_rank_90 <= rankMax) || (chk.squeeze_bars !== null && chk.squeeze_bars >= barsMin);
  const dir = breakoutDirection(inp.features[0]);
  // 清单里的 dist_to_break_atr 量的是**趋势同向**那个突破位;压缩→扩张的方向由突破那根决定,两者可能不同,
  // 所以这里按自己的方向重算一遍,不借用清单的数(借用会在方向不一致时量错对象)。
  const f0 = inp.features[0];
  const level = dir && f0 ? (dir === 'long' ? (f0.swing_high_20_prev ?? f0.swing_high_20) : (f0.swing_low_20_prev ?? f0.swing_low_20)) : null;
  const distAtr = level !== null && f0 && f0.atr14 > 0 ? Math.abs(f0.last_close - level) / f0.atr14 : null;
  // 量比是扩张那一根的核心判据;算不出来时以前落进「量比不足 → 中立」,那是把缺数据当成条件不成立。
  if (chk.vol_ratio === null) return { stance: 'abstain', confidence: 0, checks: [{ id: 'vol_spike', pass: null, note: '量比不可得(K 线不足)' }], reasons: ['扩张那根的量比不可得,不投票'], abstain_reason: 'data' };
  const volOk = chk.vol_ratio >= spikeMin;
  const within = distAtr === null ? null : distAtr <= chaseMax;
  const checks: VerdictCheck[] = [
    { id: 'compressed', pass: compressed, note: `带宽分位 ${chk.bb_width_rank_90 === null ? 'n/a' : `${Math.round(chk.bb_width_rank_90)}%`}(≤${rankMax}%),squeeze 连续 ${chk.squeeze_bars ?? 'n/a'} 根(≥${barsMin})` },
    { id: 'expansion_dir', pass: dir !== null, note: dir ? `突破方向 ${dir}` : '这根没有突破前 20 根高低点' },
    { id: 'vol_spike', pass: chk.vol_ratio === null ? null : volOk, note: `量比 ${chk.vol_ratio?.toFixed(2) ?? 'n/a'}(≥${spikeMin})` },
    { id: 'within_chase', pass: dir ? within : null, note: `距本次突破位 ${distAtr?.toFixed(2) ?? 'n/a'} ATR(≤${chaseMax})` },
    { id: 'atr_ok', pass: chk.atr_ok, note: `ATR% ${chk.atr_pct?.toFixed(2) ?? 'n/a'}(门槛 ${chk.atr_floor}）` },
  ];
  if (!compressed) return { stance: 'neutral', confidence: 0, entry_timing: 'failed', checks, reasons: ['没有先压缩,这不是压缩→扩张的形态'] };
  if (!dir) return { stance: 'neutral', confidence: 0.3, entry_timing: 'pending', checks, reasons: ['已压缩但还没扩张(等突破那一根)'] };
  if (!volOk || within === false || !chk.atr_ok) return { stance: 'neutral', confidence: 0, entry_timing: 'failed', checks, reasons: [`扩张不达标:${[!volOk ? '量比不足' : '', within === false ? '已追太远' : '', !chk.atr_ok ? 'ATR% 不足' : ''].filter(Boolean).join('/')}`] };
  // 压缩越深、量比越大,信心越高;上限 0.8。
  const deep = chk.bb_width_rank_90 !== null && chk.bb_width_rank_90 <= rankMax / 2 ? 0.1 : 0;
  const loud = chk.vol_ratio !== null && chk.vol_ratio >= spikeMin * 1.5 ? 0.1 : 0;
  return { stance: dir, confidence: clamp01(0.5 + deep + loud), entry_timing: 'confirmed', checks, reasons: [`压缩后第一次放量${dir === 'long' ? '向上' : '向下'}扩张`] };
};

/** 资金费率/OI 极值:极值 + OI 下降 = 逼仓已在去化,**反向**做(fade);极值但 OI 仍升 = 只顺势,信心低。 */
const fundingVerdict: StrategyVerdictFn = (spec, inp, _ev, chk) => {
  const raw = inp.market.funding_rate;
  if (raw === '' || !Number.isFinite(Number(raw))) return { stance: 'abstain', confidence: 0, checks: [{ id: 'funding_data', pass: null, note: '这个时刻取不到资金费率' }], reasons: ['资金费率不可得,不投票'], abstain_reason: 'data' };
  const cur = Number(raw);
  const { z, samples } = fundingZScore(inp.funding_history, cur, inp.now);
  if (z === null) return { stance: 'abstain', confidence: 0, checks: [{ id: 'funding_z', pass: null, note: `30 天历史不可得(样本 ${samples})` }], reasons: ['没有 30 天历史就没有极值口径,不投票'], abstain_reason: 'data' };
  const curPct = cur * 100;
  const absMin = param(spec, 'funding_abs_min', 0.05);
  const zMin = param(spec, 'funding_z_min', 2);
  const oiMin = param(spec, 'oi_change_min', 1);
  const quiet = param(spec, 'minutes_before_funding', 30);
  const mins = Math.max(0, Math.round((inp.market.next_funding_at - inp.now) / 60_000));
  const extreme = Math.abs(curPct) >= absMin && Math.abs(z) >= zMin;
  const oi = inp.oi_change_1h_pct;
  const checks: VerdictCheck[] = [
    { id: 'extreme', pass: extreme, note: `费率 ${curPct.toFixed(4)}%(≥${absMin}%),z=${z.toFixed(2)}(≥${zMin})` },
    { id: 'oi_confirm', pass: oi === null ? null : Math.abs(oi) >= oiMin, note: `OI 1h ${oi === null ? 'n/a' : `${oi >= 0 ? '+' : ''}${oi.toFixed(2)}%`}(门槛 ±${oiMin}%)` },
    { id: 'funding_window', pass: mins > quiet, note: `距结算 ${mins} 分钟(${quiet} 分钟内不新开)` },
  ];
  if (!extreme) return { stance: 'neutral', confidence: 0, entry_timing: 'failed', checks, reasons: ['费率没到极值'] };
  if (mins <= quiet) return { stance: 'neutral', confidence: 0, entry_timing: 'failed', checks, reasons: [`距结算只剩 ${mins} 分钟,不新开`] };
  // OI 变化是 fade/follow 的分叉判据:读不到就是**看不见**,弃权而不是投中立票。
  if (oi === null) return { stance: 'abstain', confidence: 0, checks, reasons: ['拿不到 OI 1h 变化,分不清 fade 还是顺势'], abstain_reason: 'data' };
  if (oi <= -oiMin) {
    // 正费率 = 多头拥挤,OI 在降 = 拥挤方正在平仓 → 做空;负费率反之。
    const dir: Direction = curPct > 0 ? 'short' : 'long';
    return { stance: dir, confidence: clamp01(0.5 + Math.min(0.2, (Math.abs(z) - zMin) * 0.05)), entry_timing: 'confirmed', checks, reasons: [`费率极值 ${curPct.toFixed(4)}% 且 OI 降 ${oi.toFixed(2)}%,拥挤方去化 → 反向`] };
  }
  if (oi >= oiMin) {
    const trend = chk?.trend_agree ?? null;
    if (!trend) return { stance: 'neutral', confidence: 0, entry_timing: 'failed', checks: [...checks, { id: 'trend_agree', pass: false, note: chk?.trend_note ?? '趋势周期不可得' }], reasons: ['OI 仍升,只许顺势,但趋势周期不同向'] };
    // 策略原文:follow 分支「只许顺势**限价挂回踩**」→ 方向成立、时机 pending,闸会挡掉市价。
    return { stance: trend, confidence: 0.45, entry_timing: 'pending', checks: [...checks, { id: 'trend_agree', pass: true, note: chk?.trend_note ?? '' }], reasons: ['OI 仍升不 fade,只顺势限价挂回踩(信心压低)'] };
  }
  return { stance: 'neutral', confidence: 0, entry_timing: 'failed', checks, reasons: ['OI 变化在门槛内,不确认'] };
};

/** 区间均值回归:只在震荡、价离 EMA20 够远、且历史回归概率过线时,**反着偏离方向**做。没有 400 根历史就弃权。 */
const reversionVerdict: StrategyVerdictFn = (spec, inp, _ev, chk) => {
  const base = inp.features[0];
  const bars = inp.klines[base?.tf ?? inp.timeframe] ?? [];
  const devMin = param(spec, 'dev_atr_min', 2);
  const adxMax = param(spec, 'adx_max', 20);
  const horizonBars = Math.round(param(spec, 'horizon_bars', 12));
  const probMin = param(spec, 'min_reversion_prob', 55);
  const stats = bars.length ? reversionStats(bars, { tf: base?.tf ?? inp.timeframe, horizons: [...new Set([6, 12, 24, horizonBars])].sort((a, b) => a - b) }) : null;
  // 数据不足时的票面要写清「差多少」:以前只说「不足 400 根」,看不出运行时到底给了多少根,
  // 于是这条策略永远静默弃权也没人察觉(取数根数现在由 spec.checklist.min_bars 驱动,见 strategies.ts)。
  if (!stats) return { stance: 'abstain', confidence: 0, checks: [{ id: 'reversion_stats', pass: null, note: `数据不足 ${bars.length}/${MIN_BARS} 根(${base?.tf ?? inp.timeframe})` }], reasons: [`数据不足 ${bars.length}/${MIN_BARS}:没有历史回归概率就不投票`], abstain_reason: 'data' };
  const dev = base && base.atr14 > 0 ? (base.last_close - base.ema20) / base.atr14 : null;
  if (dev === null) return { stance: 'abstain', confidence: 0, checks: [{ id: 'deviation', pass: null, note: 'ATR14 不可得,算不出偏离' }], reasons: ['偏离(ATR 口径)不可得,不投票'], abstain_reason: 'data' };
  const adx = chk?.adx14 ?? null;
  const ranging = inp.daily_regime?.regime === 'range' || (adx !== null && adx < adxMax);
  // 取偏离档位不高于当前偏离的最大 k、且窗口 = horizon_bars 的那一格。
  // 取「不低于入场门槛 devMin、且不超过当前偏离」的最大 k:低于门槛的档位统计的是更浅的偏离,概率天然更高,
  // 拿它放行等于用乐观数字骗自己。这样的档位不存在时 prob 为 null → 不投方向票。
  const cell = stats.cells.filter((c) => c.horizon === horizonBars && c.k >= devMin && dev !== null && c.k <= Math.abs(dev)).sort((a, b) => b.k - a.k)[0] ?? null;
  const prob = cell?.prob === null || cell?.prob === undefined ? null : cell.prob * 100;
  const checks: VerdictCheck[] = [
    { id: 'ranging', pass: ranging, note: `日线 ${inp.daily_regime?.regime ?? 'n/a'},ADX14 ${adx?.toFixed(1) ?? 'n/a'}(上限 ${adxMax})` },
    { id: 'deviation', pass: dev === null ? null : Math.abs(dev) >= devMin, note: `价距 EMA20 ${dev === null ? 'n/a' : `${dev >= 0 ? '+' : ''}${dev.toFixed(2)} ATR`}(门槛 ${devMin})` },
    { id: 'reversion_prob', pass: prob === null ? null : prob >= probMin, note: `${horizonBars} 根内回归比例 ${prob === null ? 'n/a' : `${prob.toFixed(0)}%`}(门槛 ${probMin}%,样本 ${cell?.samples ?? 0})` },
  ];
  if (!ranging) return { stance: 'neutral', confidence: 0, entry_timing: 'failed', checks, reasons: ['不是震荡行情,均值回归不适用'] };
  if (Math.abs(dev) < devMin) return { stance: 'neutral', confidence: 0, entry_timing: 'pending', checks, reasons: ['偏离不够远(等更深的偏离)'] };
  if (prob === null || prob < probMin) return { stance: 'neutral', confidence: 0, entry_timing: 'failed', checks, reasons: [`历史回归概率 ${prob === null ? '不可得' : `${prob.toFixed(0)}% 低于 ${probMin}%`}`] };
  const dir: Direction = dev > 0 ? 'short' : 'long';
  // 偏离已经够深 = 入场时机就是现在(回归策略没有「等回踩」这一步)。
  return { stance: dir, confidence: clamp01(0.4 + Math.min(0.3, (prob - probMin) / 100)), entry_timing: 'confirmed', checks, reasons: [`震荡中偏离 ${dev.toFixed(2)} ATR,历史 ${horizonBars} 根内 ${prob.toFixed(0)}% 回到 EMA20 → 反向`] };
};

/**
 * 按策略 id 注册的代码裁决。**没登记的策略只能弃权**(不算票)。
 * 每条策略的判据都来自它自己在 STRATEGY_EVIDENCE 里已经算好的数字或 scanChecklist,裁决只把数字变成 stance;
 * 数据缺 = abstain(不投票),不是 neutral(投了中立票)。
 */
export const STRATEGY_VERDICT: Record<string, StrategyVerdictFn> = {
  breakout_retest: breakoutVerdict,
  swing_breakout_retest: breakoutVerdict,
  position_breakout_retest: breakoutVerdict,
  mtf_alignment: mtfVerdict,
  vol_compression_expansion: volCompressionVerdict,
  funding_oi_extreme: fundingVerdict,
  range_mean_reversion: reversionVerdict,
};

export function codeVerdict(spec: StrategySpec, inp: VerdictInputs): { out: VerdictOutput; evidence: StrategyEvidenceLine[]; checklist: ScanChecklist | null } {
  const evInput: StrategyEvidenceInput = { now: inp.now, symbol: inp.symbol, timeframe: inp.timeframe, features: inp.features, klines: inp.klines, market: inp.market, oi_change_1h_pct: inp.oi_change_1h_pct, funding_history: inp.funding_history, daily_regime: inp.daily_regime, trigger_hits: inp.trigger_hits };
  const evidence = strategyEvidence(spec, evInput);
  const checklist = checklistFor(spec, inp);
  if (!inp.woken) return { out: { stance: 'abstain', confidence: 0, checks: [], reasons: ['本次触发器没有唤醒这条策略'], abstain_reason: 'not_woken' }, evidence, checklist };
  const fn = STRATEGY_VERDICT[spec.id];
  if (!fn) return { out: { stance: 'abstain', confidence: 0, checks: [], reasons: ['该策略还没有代码裁决实现(待填)'], abstain_reason: 'unimplemented' }, evidence, checklist };
  try {
    return { out: fn(spec, inp, evidence, checklist), evidence, checklist };
  } catch (e) {
    return { out: { stance: 'abstain', confidence: 0, checks: [], reasons: [`裁决计算失败:${(e as Error).message.slice(0, 100)}`], abstain_reason: 'data' }, evidence, checklist };
  }
}

// ---------------------------------------------------------------- 适配(策略 ↔ 资产)

export interface FitInputs {
  /** Radar 最近一次筛选里这个币对这条策略的 fit_score(0–1),没有 = null。 */
  radar_fit: number | null;
  /** 本币 × 本策略的历史(已结算的线程);n=0 视为没有。 */
  history: { n: number; win_rate: number | null; expectancy_r: number | null } | null;
}

const expectancyToScore = (e: number | null | undefined, n: number): number | null => (e === null || e === undefined || n <= 0 ? null : clamp01(0.5 + Math.max(-0.5, Math.min(0.5, e))));

/** 加权平均可得的部分;权重:历史 0.4、Radar 0.3、Lab 0.15、eval 0.15;样本 < 5 的历史权重减半。 */
export function strategyFit(spec: StrategySpec, inp: FitInputs): StrategyFit {
  const parts = {
    radar: inp.radar_fit === null ? null : clamp01(inp.radar_fit),
    lab: spec.lab_stats ? expectancyToScore(spec.lab_stats.expectancy_r, spec.lab_stats.n) : null,
    eval: expectancyToScore(spec.eval_stats.expectancy_r, spec.eval_stats.trades),
    history: inp.history && inp.history.n > 0 ? expectancyToScore(inp.history.expectancy_r ?? (inp.history.win_rate === null ? null : inp.history.win_rate - 0.5), inp.history.n) : null,
  };
  const weights: Record<keyof typeof parts, number> = { radar: 0.3, lab: 0.15, eval: 0.15, history: inp.history && inp.history.n < 5 ? 0.2 : 0.4 };
  let num = 0;
  let den = 0;
  for (const k of Object.keys(parts) as (keyof typeof parts)[]) {
    const v = parts[k];
    if (v === null) continue;
    num += v * weights[k];
    den += weights[k];
  }
  const score = den > 0 ? Math.round((num / den) * 100) / 100 : null;
  const note = score === null ? '无适配数据' : `适配 ${score.toFixed(2)}(${(Object.keys(parts) as (keyof typeof parts)[]).filter((k) => parts[k] !== null).map((k) => `${k} ${parts[k]!.toFixed(2)}`).join(' ')})`;
  return { score, parts, note };
}

// ---------------------------------------------------------------- 共识

/** require 模式下,共识闸要成立至少需要这么多条策略能投票(只有一条策略在投票不叫「多条策略一致」)。 */
export const REQUIRE_MIN_VOTERS = 2;

/**
 * 共识(纯函数)。09-12 起 **fail closed**:
 *  - `min_agree > 能投票的策略数` → 不再静默钳降到能投票的条数,而是判 `gate_effective=false`、`reached=false`;
 *  - `require` 模式下能投票的策略 < {@link REQUIRE_MIN_VOTERS} → 同样判闸无效并拒开仓,并给出可读原因。
 * 旧行为(钳降)的后果是:两条策略里一条因**数据缺**弃权,门槛就从 2 降到 1,另一条自己就能放行——
 * 数据越少越容易开仓。真想只要一票的人应该显式把 min_agree 设成 1。
 */
export function consensus(all: StrategyVerdict[], policy: CouncilPolicy): Consensus {
  // 影子策略的票只进证据文本,不进这里的任何一个集合(见 StrategyVerdict.advisory)。
  const verdicts = all.filter((v) => !v.advisory);
  const voting = verdicts.filter((v) => v.stance !== 'abstain');
  const votingIds = voting.map((v) => v.strategy_id);
  const abstaining = verdicts.filter((v) => v.stance === 'abstain').map((v) => v.strategy_id);
  const strong = voting.filter((v) => (v.stance === 'long' || v.stance === 'short') && v.confidence >= policy.confidence_floor);
  const longs = strong.filter((v) => v.stance === 'long').map((v) => v.strategy_id);
  const shorts = strong.filter((v) => v.stance === 'short').map((v) => v.strategy_id);
  const neutral = voting.filter((v) => !strong.includes(v)).map((v) => v.strategy_id);
  const required = Math.max(1, policy.min_agree);
  const minVoters = policy.mode === 'require' ? Math.max(required, REQUIRE_MIN_VOTERS) : required;
  const base: Omit<Consensus, 'reached' | 'gate_effective' | 'gate_reason' | 'reason'> = { direction: null, agreeing: [], dissenting: [], neutral, abstaining, required, voting: votingIds, entry_timing: null };
  if (voting.length < minVoters) {
    const why = voting.length === 0
      ? '没有策略能投票(全部弃权)'
      : `能投票的策略只有 ${voting.length} 条(${votingIds.join('/')}),不足门槛 ${minVoters} 条${policy.mode === 'require' && required < REQUIRE_MIN_VOTERS ? `(require 模式至少 ${REQUIRE_MIN_VOTERS} 条)` : ''};弃权:${abstaining.join('/') || '无'}`;
    return { ...base, reached: false, gate_effective: false, gate_reason: `共识闸当前无效:${why}`, reason: `共识闸当前无效:${why}` };
  }
  const eff = { gate_effective: true, gate_reason: '' };
  if (longs.length && shorts.length) return { ...base, ...eff, reached: false, dissenting: [...longs, ...shorts], reason: `策略方向冲突:多 ${longs.join('/')} vs 空 ${shorts.join('/')}` };
  const dir: Direction | null = longs.length ? 'long' : shorts.length ? 'short' : null;
  if (!dir) return { ...base, ...eff, reached: false, reason: '没有过线的方向票' };
  const agreeing = dir === 'long' ? longs : shorts;
  // 入场时机取同意方里**最保守**的一个:任一条说「还没回踩」就整体 pending(市价被拒,限价放行)。
  const timings = strong.filter((v) => v.stance === dir).map((v) => v.entry_timing ?? 'confirmed');
  const entry_timing: EntryTiming = timings.includes('pending') ? 'pending' : 'confirmed';
  const reached = agreeing.length >= required;
  return { ...base, ...eff, reached, direction: dir, agreeing, entry_timing, reason: reached ? `${agreeing.length} 条策略同向(${dir === 'long' ? '做多' : '做空'}),达到 ${required};入场时机${entry_timing === 'confirmed' ? '已确认' : '待回踩(只许限价)'}` : `同向 ${agreeing.length} 条,不足 ${required}` };
}

// ---------------------------------------------------------------- 编排(纯函数版;runtime 只负责喂数据和可选的模型票)

export interface CouncilInputs extends Omit<VerdictInputs, 'woken'> {
  strategies: StrategySpec[];
  /**
   * 这次被触发器唤醒的策略键(**`id@version`**,见 {@link strategyKey});不在其中的策略弃权。
   * 只写 `id`(不带版本)的旧口径仍然认,但那会把同 ID 的所有版本一起唤醒 —— runtime 一律传带版本的键。
   */
  woken_ids: string[];
  fit_for: (spec: StrategySpec) => FitInputs;
  policy: CouncilPolicy;
  /** 可选:模型票(runtime 调模型后传进来),按策略 id;合并规则见 mergeVerdict。 */
  model_votes?: Record<string, ModelVote>;
  /**
   * 09-12 §1.2 影子实盘:这些策略(status='shadow')**也表态,但不计入共识**。
   * 它们的裁决永远是代码算的(不问模型票,不花钱),结果用于建虚拟线程。
   */
  advisory_strategies?: StrategySpec[];
  /**
   * §9.36 / P1-11 **证据 fail-closed**:策略键 `id@version` → 这一轮它点名要、却**没装上**的证据
   * (一句话一条)。按 `id` 汇总会让同 ID 新版的缺口把正式旧版一起弃权(P1-06 第 4 条),所以键带版本;
   * 只写 `id` 的旧口径仍然认(那是「整条策略都缺」的意思)。
   * 有缺口的策略直接弃权(`abstain_reason='data'`),模型票也补不上——缺证据的策略投票 =
   * 拿看不见的东西投票,比弃权危险得多。
   */
  evidence_gaps?: Record<string, string[]>;
}

export interface ModelVote {
  stance: VerdictStance;
  confidence: number;
  reasons: string[];
}

/**
 * 代码票 × 模型票。09-12 起 **模型只能减权,不能增权**(Codex §B4):
 *  - 代码**任何**原因弃权(数据缺 / 还没实现 / 没被唤醒)→ 模型票只进理由,不成票。
 *    「没实现」也不行:那条策略的硬前置检查根本没人跑过,模型看的是同一份没被检查的证据。
 *  - 代码中立(含明确条件失败)→ 模型的方向票**不能**把它翻成可执行票(以前 0.9×0.7=0.63 就越过 0.4 阈值)。
 *  - 代码有方向 → 模型只能压低信心:反向 → 中立;中立/弃权 → 打七折;同向 → 取均值且**不超过代码票**。
 */
export function mergeVerdict(code: VerdictOutput, model: ModelVote | undefined): { out: VerdictOutput; source: StrategyVerdict['source'] } {
  if (!model) return { out: code, source: 'code' };
  const noted = (tag: string): string[] => [...code.reasons, ...model.reasons.map((r) => `模型(${tag}):${r}`)];
  if (code.stance === 'abstain') return { out: { ...code, reasons: noted('不计票') }, source: 'code+model' };
  const codeDir = code.stance === 'long' || code.stance === 'short';
  const modelDir = model.stance === 'long' || model.stance === 'short';
  if (!codeDir) return { out: { ...code, reasons: noted(modelDir ? '不计票,代码中立不由模型翻案' : '不计票') }, source: 'code+model' };
  if (modelDir && code.stance !== model.stance) return { out: { stance: 'neutral', confidence: 0, entry_timing: 'failed', checks: code.checks, reasons: [`代码 ${code.stance} 与模型 ${model.stance} 相反,按中立`, ...model.reasons.map((r) => `模型:${r}`)] }, source: 'code+model' };
  if (!modelDir) return { out: { ...code, confidence: clamp01(code.confidence * 0.7), reasons: [...code.reasons, `模型持${model.stance === 'neutral' ? '中立' : '弃权'},信心打七折`] }, source: 'code+model' };
  return { out: { ...code, confidence: clamp01(Math.min(code.confidence, (code.confidence + model.confidence) / 2)), reasons: noted('同向') }, source: 'code+model' };
}

/** 证据缺口 → 一张直接弃权的票(§9.36)。 */
function gapVerdict(spec: StrategySpec, gaps: readonly string[], now: number, fit: StrategyFit, advisory: boolean): StrategyVerdict {
  return {
    strategy_id: spec.id,
    version: spec.version,
    content_hash: spec.content_hash,
    horizon: spec.horizon,
    stance: 'abstain',
    confidence: 0,
    entry_timing: null,
    source: 'code',
    ...(advisory ? { advisory: true } : {}),
    fit,
    checks: [{ id: 'evidence', pass: null, note: `证据缺:${gaps.join(';')}` }],
    reasons: [`这条策略点名要的证据这次没装上(${gaps.slice(0, 3).join(';')}),弃权而不是带着缺口投票`],
    at: now,
  };
}

/** 入场时机的保守序:`failed` 最严(不许开)> `pending`(只许等待型限价)> `confirmed`(市价也行)。 */
const TIMING_RANK: Record<EntryTiming, number> = { confirmed: 0, pending: 1, failed: 2 };

/**
 * **总决策的单调收窄**(09-12 P1-05)。单票只减权不够:模型可以靠**压低某一张票**间接删掉代码层的否决
 * (把反向票压成中立 → 冲突消失)或删掉等待条件(把 pending 那张票压到信心线以下 → 整体 timing 变 confirmed,
 * 市价获准)。那等于模型拿到了「删除代码闸」的权力,与「代码闸 + 模型只减权」的安全意图相反。
 *
 * 修法:**先冻结纯代码的允许集,再与合并模型后的允许集取交集**。允许集有四个维度,每一维只能收窄:
 *  - 闸是否有效:代码判无效 → 最终无效;
 *  - 是否达成共识:代码没达成 → 最终不达成(模型不能把「不可执行」变成可执行);
 *  - 方向:只能是代码的那个方向或 null(模型不能换方向,也不能凭空造方向);
 *  - 同意方集合:取交集(模型不能把代码没同意的策略塞进同意方);交集不足 `required` → 不达成;
 *  - 入场时机:取两者里**更保守**的一个(代码 pending → 最终不可能 confirmed)。
 */
export function narrowByCode(code: Consensus, merged: Consensus): Consensus {
  const gate_effective = code.gate_effective && merged.gate_effective;
  const agreeing = merged.agreeing.filter((id) => code.agreeing.includes(id));
  const sameDir = code.direction !== null && merged.direction === code.direction;
  const timingRank = Math.max(TIMING_RANK[code.entry_timing ?? 'confirmed'], TIMING_RANK[merged.entry_timing ?? 'confirmed']);
  const entry_timing: EntryTiming | null = code.entry_timing === null && merged.entry_timing === null ? null : ((Object.keys(TIMING_RANK) as EntryTiming[]).find((k) => TIMING_RANK[k] === timingRank) ?? 'confirmed');
  const reached = gate_effective && code.reached && merged.reached && sameDir && agreeing.length >= merged.required;
  // 收窄的理由要写清楚是**哪一边**拦的:代码拦下来的,不许在文本里说成「模型不同意」。
  const narrowed = code.reached && !reached;
  const blockedByCode = !code.reached || !code.gate_effective;
  const reason = reached
    ? merged.reason
    : blockedByCode
      ? `代码裁决不允许:${code.gate_effective ? code.reason : code.gate_reason}`
      : narrowed
        ? `模型票收窄后不再成立:${merged.reason}`
        : merged.reason;
  return {
    ...merged,
    gate_effective,
    gate_reason: code.gate_effective ? merged.gate_reason : code.gate_reason,
    reached,
    direction: reached ? code.direction : null,
    agreeing: reached ? agreeing : [],
    entry_timing: reached ? entry_timing : null,
    reason,
  };
}

export function runCouncil(inp: CouncilInputs): CouncilResult {
  // 缺口/唤醒都按 `id@version` 取;只给了裸 id 的旧口径(与老测试)仍然认。
  const gapsOf = (spec: StrategySpec): string[] => inp.evidence_gaps?.[strategyKey(spec)] ?? inp.evidence_gaps?.[spec.id] ?? [];
  const wokenOf = (spec: StrategySpec): boolean => inp.woken_ids.includes(strategyKey(spec)) || inp.woken_ids.includes(spec.id);
  // 纯代码票与「代码 × 模型」票各留一份:共识先按纯代码算一遍(允许集的上界),再与合并后的取交集。
  const codeVerdicts: StrategyVerdict[] = [];
  const verdicts: StrategyVerdict[] = [];
  const asVerdict = (spec: StrategySpec, out: VerdictOutput, source: StrategyVerdict['source'], extra: Partial<StrategyVerdict> = {}): StrategyVerdict => ({
    strategy_id: spec.id,
    version: spec.version,
    content_hash: spec.content_hash,
    horizon: spec.horizon,
    stance: out.stance,
    confidence: Math.round(out.confidence * 100) / 100,
    entry_timing: out.entry_timing ?? (out.stance === 'long' || out.stance === 'short' ? 'confirmed' : null),
    source,
    fit: strategyFit(spec, inp.fit_for(spec)),
    checks: out.checks,
    reasons: out.reasons,
    at: inp.now,
    ...extra,
  });
  for (const spec of inp.strategies) {
    // §9.36 fail closed:证据有缺口的策略**两份票都是同一张弃权票** —— 代码侧弃权,合并侧也弃权,
    // 所以 narrowByCode 的交集里它永远不在同意方。缺证据的策略不许靠模型票翻成一票。
    const gaps = gapsOf(spec);
    if (gaps.length) {
      const gv = gapVerdict(spec, gaps, inp.now, strategyFit(spec, inp.fit_for(spec)), false);
      codeVerdicts.push(gv);
      verdicts.push(gv);
      continue;
    }
    const woken = wokenOf(spec);
    const { out: code } = codeVerdict(spec, { ...inp, woken });
    const { out, source } = mergeVerdict(code, woken ? inp.model_votes?.[spec.id] : undefined);
    codeVerdicts.push(asVerdict(spec, code, 'code'));
    verdicts.push(asVerdict(spec, out, source));
  }
  for (const spec of inp.advisory_strategies ?? []) {
    // P1-06 第 4 条:去重键是 **id@version**,不是 id。v1 在 paper 上跑的时候,v2 的影子票
    // 不该被 v1 挡掉——「同 ID 两个版本并存」正是版本升级最常见的场景。
    if (verdicts.some((v) => v.strategy_id === spec.id && v.version === spec.version)) continue;
    const gaps = gapsOf(spec);
    if (gaps.length) {
      const gv = gapVerdict(spec, gaps, inp.now, strategyFit(spec, inp.fit_for(spec)), true);
      verdicts.push(gv);
      codeVerdicts.push(gv);
      continue;
    }
    const woken = wokenOf(spec);
    const { out } = codeVerdict(spec, { ...inp, woken });
    const v = asVerdict(spec, out, 'code', { advisory: true });
    verdicts.push(v);
    codeVerdicts.push(v);
  }
  const codeConsensus = consensus(codeVerdicts, inp.policy);
  const c = narrowByCode(codeConsensus, consensus(verdicts, inp.policy));
  return { version: COUNCIL_VERSION, at: inp.now, symbol: inp.symbol, mode: inp.policy.mode, verdicts, consensus: c, code_consensus: codeConsensus, text: renderCouncil(verdicts, c, inp.policy, codeConsensus) };
}

const stanceLabel: Record<VerdictStance, string> = { long: '做多', short: '做空', neutral: '中立', abstain: '弃权' };

const timingLabel: Record<EntryTiming, string> = { confirmed: '时机已确认', pending: '时机待回踩', failed: '时机不成立' };

export function renderCouncil(verdicts: StrategyVerdict[], c: Consensus, policy: CouncilPolicy, codeConsensus?: Consensus): string {
  const votes = verdicts.map((v) => `${v.strategy_id} v${v.version}${v.advisory ? '(影子,不计票)' : ''}:${stanceLabel[v.stance]}${v.stance === 'abstain' ? '' : ` ${v.confidence.toFixed(2)}`}${v.entry_timing && v.stance !== 'abstain' ? `/${timingLabel[v.entry_timing]}` : ''}${v.fit.score === null ? '' : ` 适配 ${v.fit.score.toFixed(2)}`}(${v.reasons[0] ?? ''})`).join(';');
  const head = c.gate_effective
    ? `共识=${c.reached ? '是' : '否'}${c.direction ? `,方向 ${stanceLabel[c.direction]}` : ''}${c.entry_timing ? `,${timingLabel[c.entry_timing]}` : ''},需同向 ${c.required} 条,信心线 ${policy.confidence_floor}`
    : `共识闸当前无效(需同向 ${c.required} 条,能投票 ${c.voting.length} 条),按无共识处理`;
  // 纯代码允许集与最终允许集不一样时**写出来**:是模型收窄了,还是代码本来就不允许。
  const narrowNote = codeConsensus
    ? codeConsensus.reached && !c.reached
      ? `模型票收窄:纯代码共识 ${codeConsensus.direction ?? '无'}(同意 ${codeConsensus.agreeing.join('/') || '无'})合并模型后不再成立。`
      : !codeConsensus.reached
        ? `纯代码共识:${codeConsensus.gate_effective ? codeConsensus.reason : codeConsensus.gate_reason}(模型不能把它翻成可执行)。`
        : ''
    : '';
  return `${head};${c.reason}。同意:${c.agreeing.join('/') || '无'};反对:${c.dissenting.join('/') || '无'};中立:${c.neutral.join('/') || '无'};弃权:${c.abstaining.join('/') || '无'}。${narrowNote}${c.entry_timing === 'pending' ? '方向成立但回踩未确认:允许 PROPOSE,但入场方式必须是限价挂回踩区。' : ''}票:${votes}`;
}

export function snapshotOf(r: CouncilResult): CouncilSnapshot {
  // 快照只留正式票:线程复查对照的是「当初同意的那几条」,影子票从来不是同意方。
  const formal = r.verdicts.filter((v) => !v.advisory);
  // §9.36:**全票池**冻结(不只同意方、不只主策略),复查按这份版本取回。
  const pool = formal.map((v) => ({ strategy_id: v.strategy_id, version: v.version, content_hash: v.content_hash }));
  return { version: r.version, at: r.at, direction: r.consensus.direction, reached: r.consensus.reached, agreeing: r.consensus.agreeing, dissenting: r.consensus.dissenting, gate_effective: r.consensus.gate_effective, entry_timing: r.consensus.entry_timing, pool, pool_hash: poolHash(pool.map((p) => ({ id: p.strategy_id, version: p.version, content_hash: p.content_hash }))), votes: formal.map((v) => ({ strategy_id: v.strategy_id, version: v.version, content_hash: v.content_hash, stance: v.stance, confidence: v.confidence, fit: v.fit.score })) };
}

/**
 * PROPOSE 的代码闸(mode=require 才拦):要有共识(且共识闸本身有效)、方向一致、strategy_id 是同意方之一;
 * 再加一条 09-12 的时机闸:共识的 `entry_timing='pending'`(方向成立、回踩未确认)时**只许限价**,市价拒。
 * advise/off 永远通过。
 */
export function consensusGate(j: { action: string; direction: Direction | null; strategy_id?: string | null; proposal?: { entry: 'market' | 'limit' } | null }, r: CouncilResult | null, mode: CouncilMode): { passed: boolean; reason: string } {
  if (mode !== 'require' || j.action !== 'PROPOSE') return { passed: true, reason: mode === 'require' ? '非开仓动作' : `议会模式 ${mode},不拦` };
  if (!r) return { passed: false, reason: '议会没有运行(无结果)' };
  if (!r.consensus.gate_effective) return { passed: false, reason: r.consensus.gate_reason || '共识闸当前无效' };
  if (!r.consensus.reached) return { passed: false, reason: `无共识:${r.consensus.reason}` };
  if (j.direction !== r.consensus.direction) return { passed: false, reason: `提议方向 ${j.direction ?? 'null'} 与共识 ${r.consensus.direction} 不一致` };
  if (j.strategy_id && !r.consensus.agreeing.includes(j.strategy_id)) return { passed: false, reason: `strategy_id ${j.strategy_id} 不在同意方 ${r.consensus.agreeing.join('/')} 里` };
  if (r.consensus.entry_timing === 'pending' && j.proposal?.entry === 'market') return { passed: false, reason: `方向成立但入场时机未确认(回踩未确认),只许限价挂回踩区:${r.consensus.agreeing.join('/')}` };
  return { passed: true, reason: `共识 ${r.consensus.direction},同意 ${r.consensus.agreeing.join('/')}${r.consensus.entry_timing === 'pending' ? '(时机待回踩,限价入场)' : ''}` };
}

// ---------------------------------------------------------------- 复查:当初同意的还同不同意

export interface CouncilReview {
  still_agree: string[];
  flipped: string[];
  gone_neutral: string[];
  text: string;
}

/** 线程带的开仓快照 × 现在重算的裁决(只看当初同意的那几条)。只做证据,不是硬闸;规则 8 仍是最终边界。 */
export function councilReview(snapshot: CouncilSnapshot, current: StrategyVerdict[], side: Direction): CouncilReview {
  const still_agree: string[] = [];
  const flipped: string[] = [];
  const gone_neutral: string[] = [];
  for (const id of snapshot.agreeing) {
    const v = current.find((x) => x.strategy_id === id);
    if (!v || v.stance === 'abstain') gone_neutral.push(id);
    else if (v.stance === side) still_agree.push(id);
    else if (v.stance === 'neutral') gone_neutral.push(id);
    else flipped.push(id);
  }
  const text = `开仓时同意 ${snapshot.agreeing.length} 条(${snapshot.agreeing.join('/') || '无'});现在仍同向 ${still_agree.length}(${still_agree.join('/') || '无'}),转中立/弃权 ${gone_neutral.length}(${gone_neutral.join('/') || '无'}),翻向 ${flipped.length}(${flipped.join('/') || '无'})。翻向只是结构证据之一,离场仍按规则 8 的硬止损/失效口径。`;
  return { still_agree, flipped, gone_neutral, text };
}

// ---------------------------------------------------------------- 模型票(纯 prompt/解析;调用在 runtime)

export function buildVerdictPrompt(spec: StrategySpec, symbol: string, evidenceText: string, checklist: ScanChecklist | null): { system: string; user: string } {
  const system = [
    `你是策略「${spec.id}·${spec.name} v${spec.version}」的专属裁决员。你只按这一条策略的规则表态,不考虑别的策略,不给仓位。`,
    `入场:${spec.rules.entry.join('')}`,
    `失效:${spec.rules.invalidation.join('')}`,
    '只输出一个 JSON:{"stance":"long|short|neutral|abstain","confidence":0.0-1.0,"reasons":["≤40字,引用证据编号 [E1]"]}。证据不足或策略不适用于该资产输出 abstain。数字只能引用证据里的原数。',
  ].join('\n');
  const user = [`标的 ${symbol}`, '## 证据', evidenceText, checklist ? `## 扫描清单(代码计算)\n${checklist.text}` : '', '只输出 JSON。'].filter(Boolean).join('\n');
  return { system, user };
}

export function parseVerdict(text: string): ModelVote | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[0]) as Record<string, unknown>;
    const stance = raw['stance'];
    if (stance !== 'long' && stance !== 'short' && stance !== 'neutral' && stance !== 'abstain') return null;
    const c = Number(raw['confidence']);
    const reasons = Array.isArray(raw['reasons']) ? raw['reasons'].filter((r): r is string => typeof r === 'string').slice(0, 3) : [];
    return { stance, confidence: Number.isFinite(c) ? clamp01(c) : 0, reasons };
  } catch {
    return null;
  }
}
