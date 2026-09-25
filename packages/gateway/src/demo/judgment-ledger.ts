/**
 * 判断准确度账本(docs/design/strategy-loop-v2-and-events-2026-09-12.md §3;契约 §9.29)。
 *
 * 问题:复盘只有「这笔赚没赚」,分不清是**策略不行**还是**模型判断不行**。
 *
 * **两本账,别混**(09-12 复审 P1-12):
 *   (a) 判断反事实(`legs` / `outcome_r_*` / `judgment_alpha`):三条腿吃**同一份快照、同一时点、同一 horizon、
 *       同一套退出与成本口径**(0.8 ATR 止损 / 1.5R 目标 / 48 根 / 无费用),所以它们才是同一个实验。
 *   (b) 实际净结算(`realized`):这一笔在交易所真正拿到多少(含手续费与资金费、真实退出时点与风险基数)。
 *       它**不进** judgment_alpha —— 风险基数、退出时间、成本都不同,混进去比的就不是判断了。
 *
 * 三个方向:
 *   - 模型:Judgment 的表态(三态,见 `modelStanceOf`);
 *   - 议会:strategy_council 的共识(三态,见 `councilStanceOf`);
 *   - 机械基线:eval-a `mechanicalFor` 那枚硬币搬过来(1h EMA20/50 定方向 + 0.8 ATR 止损 + 1.5R 目标 + 48 根)。
 * 差值就是模型的增量:`judgment_alpha = mean(R_model − R_council)`。**全部代码算,零模型成本**。
 *
 * **三态,不是二态**(`LegStance`):
 *   - `direction` 提出方向并愿意入场 → 走反事实,拿真实的 R;
 *   - `flat` 明确不入场(NO_TRADE / WATCH / EXIT / INVALIDATE、议会没达成共识)→ **0R**。
 *     注意 `WATCH + direction=long` 是 flat:它给了方向但**不入场**,不能被模拟成一笔仓位;
 *   - `unknown` 缺数据/没跑(没有 judgment、方向读不出来、议会 off)→ **null,不进任何均值,也不算 flat**
 *     (把缺数据当 flat 会白送「不表态」一个 0R,偏袒不表态)。
 *
 * 样本口径:结论看**有效配对数** `alpha_n` 与**独立簇数** `alpha_clusters`(同一线程的多次复查是同一个簇,
 * 不是多个独立实验),不看总行数。任一不够就是 `insufficient`,此时 verdict 只能是 `'insufficient'`,
 * 不允许输出 `no_edge`/「模型没有增量」这种要人关模型的结论。
 *
 * 结算完整性(09-12 复审 P1-13):交易所结算按时间窗口归属,没有订单/CID 证明,空成交也会存下 settlement 对象。
 * `settlementCompleteness()` 把它分成 missing / partial / complete;**非 complete 的行不进任何统计**,
 * raw settlement 只当证据留着。
 *
 * 结算是异步的:落行时 outcome_* 全空、`settled_at = null`;runtime 巡检每轮找 `horizon_end_at <= now`
 * 的行,拉一次 K 线回填。取 K 线复用 market.ts 的 `fetchKlines`,不新开数据源。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { DemoStore } from './store.js';
import { openTrade, simulateOutcome, stepTrade, tradeR } from './outcome.js';
import { tfToMs } from './market.js';
import { tradeCard } from './reviewer.js';
import type { Direction, Episode, Kline, StrategyThread } from './types.js';

/**
 * jl-v2(09-23,judgment-exit-redesign §6 P0-1):行上多了三把分层键(`trigger_kind` / `holding_reason` /
 * `prompt_version`)与 `regret_hold` / `regret_exit`。三条腿与 regret 的口径**没变**;旧 jl-v1 行缺这些键,
 * 读的时候一律按 null / 'unknown' 处理(见 `decisionKeyOf`)。
 */
export const JUDGMENT_LEDGER_VERSION = 'jl-v2';

/** funnel.ts `OUTCOME_DEFAULTS` 的三个数(eval-a/mechanical.ts 原样搬过来,不跨包 import)。 */
export const MECHANICAL_STOP_ATR = 0.8;
export const MECHANICAL_TP_R = 1.5;
export const MECHANICAL_HORIZON_BARS = 48;

/** 分层样本不足的门槛:**有效配对数**低于这个数的层只显示,不下结论(不是总行数)。 */
export const LEDGER_MIN_SAMPLE = 10;

/**
 * 独立簇门槛:同一线程的多次复查吃的是同一段行情、同一个决定,只能算**一个**独立实验。
 * 有效配对数够、但簇数不够(例如 12 行全来自一条线程)照样是 insufficient。
 */
export const LEDGER_MIN_CLUSTERS = 10;

/** 线程还没结算完时,巡检愿意等多久再退回反事实。 */
export const MODEL_SETTLE_GRACE_MS = 24 * 3_600_000;

const EPS = 1e-9;
const round = (n: number): number => Math.round(n * 10_000) / 10_000;

// ---------------------------------------------------------------- 指标快照(从 episode 的证据里读)

/**
 * 反事实需要的那几个数。来源是 context.ts 写进 `Evidence` 的**代码生成**的结构行,
 * 格式固定(`收 X; …; EMA20 A EMA50 B; ATR14 C (p%); 20根高 H(距 …) 低 L(距 …); …`),所以可以稳定回读。
 * 代价:证据行按价格量级做过 toFixed(>100 取整),所以 ATR/价位会带最多半个显示单位的舍入。
 * 这点误差对「三条腿谁的 R 高」的比较不重要(三条腿吃同一份快照),但别拿它当成交价用。
 */
export interface LedgerSnapshot {
  /** 判断周期(第一条结构证据的周期);反事实走这个周期的 K 线。 */
  timeframe: string;
  last_close: number;
  /** 判断当时的标记价(复查腿的「此刻走人」用它)。 */
  mark: number | null;
  atr14: number;
  swing_high_20: number;
  swing_low_20: number;
  ema20_1h: number | null;
  ema50_1h: number | null;
}

const STRUCT_LABEL = /^(\S+)\s结构$/;

function pick(re: RegExp, text: string, group = 1): number | null {
  const m = re.exec(text);
  if (!m) return null;
  const n = Number(m[group]);
  return Number.isFinite(n) ? n : null;
}

interface TfRead {
  tf: string;
  last_close: number | null;
  ema20: number | null;
  ema50: number | null;
  atr14: number | null;
  swing_high_20: number | null;
  swing_low_20: number | null;
}

function readStructure(tf: string, value: string): TfRead {
  return {
    tf,
    last_close: pick(/收 (-?[\d.]+);/, value),
    ema20: pick(/EMA20 (-?[\d.]+) EMA50/, value),
    ema50: pick(/EMA20 -?[\d.]+ EMA50 (-?[\d.]+)/, value),
    atr14: pick(/ATR14 (-?[\d.]+)/, value),
    swing_high_20: pick(/20根高 (-?[\d.]+)\(/, value),
    swing_low_20: pick(/20根高 -?[\d.]+\(距 [^)]*\) 低 (-?[\d.]+)\(/, value),
  };
}

/** 判断当时的标记价(行情证据 `最新价 / 标记价` 那一行);没有为 null。不依赖结构证据能不能读。 */
export function markOfEpisode(ep: Episode): number | null {
  const markEv = ep.evidence.find((e) => e.kind === 'market' && e.label.includes('标记价'));
  return markEv ? pick(/mark (-?[\d.]+)/, markEv.value) ?? pick(/last (-?[\d.]+)/, markEv.value) : null;
}

/** episode 的结构/行情证据 → 快照;读不出来时给出为什么(写进 `mechanical_note`)。 */
export function snapshotFromEpisode(ep: Episode): { snapshot: LedgerSnapshot | null; note: string } {
  const reads: TfRead[] = [];
  for (const e of ep.evidence) {
    if (e.kind !== 'structure') continue;
    const m = STRUCT_LABEL.exec(e.label);
    if (!m) continue;
    reads.push(readStructure(m[1]!, e.value));
  }
  if (!reads.length) return { snapshot: null, note: '没有结构证据,读不出指标快照' };
  const primary = reads[0]!;
  if (primary.atr14 === null || !(primary.atr14 > 0)) return { snapshot: null, note: `${primary.tf} 结构证据里没有可用的 ATR14` };
  if (primary.last_close === null) return { snapshot: null, note: `${primary.tf} 结构证据里没有收盘价` };
  const h1 = reads.find((r) => r.tf === '1h') ?? null;
  const mark = markOfEpisode(ep);
  return {
    snapshot: {
      timeframe: primary.tf,
      last_close: primary.last_close,
      mark,
      atr14: primary.atr14,
      swing_high_20: primary.swing_high_20 ?? primary.last_close,
      swing_low_20: primary.swing_low_20 ?? primary.last_close,
      ema20_1h: h1?.ema20 ?? null,
      ema50_1h: h1?.ema50 ?? null,
    },
    note: '',
  };
}

/**
 * 机械基线的方向:1h EMA20 vs EMA50(eval-a `mechanicalFor` 的 `dir_h1`)。
 * 持平 / 没有 1h 结构 = 说不出方向,不计分。
 */
export function mechanicalDirection(s: LedgerSnapshot | null): { direction: Direction | null; note: string } {
  if (!s) return { direction: null, note: '没有指标快照' };
  const { ema20_1h: a, ema50_1h: b } = s;
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) return { direction: null, note: '没有 1h 结构证据,EMA20/50 读不到' };
  if (a === b) return { direction: null, note: '1h EMA20 === EMA50,方向说不出来' };
  return { direction: a > b ? 'long' : 'short', note: '' };
}

// ---------------------------------------------------------------- 一条腿的反事实

export type LegStatus = 'stop' | 'tp' | 'expired' | 'flat' | 'unscoreable';

/**
 * 一条腿的表态三态(09-12 复审 P1-12)。`flat` 与 `unknown` 是**两件事**:
 * 前者是「看见了、决定不做」(0R,是个真实决定),后者是「不知道」(null,不进任何均值)。
 */
export type LegStance = 'direction' | 'flat' | 'unknown';

/** 一方的表态读数。`direction` 只有 stance === 'direction' 时非空。 */
export interface StanceRead {
  stance: LegStance;
  direction: Direction | null;
  /** stance 不是 direction 时的原因(写进腿的 note)。 */
  note: string;
}

export interface LedgerLeg {
  stance: LegStance;
  direction: Direction | null;
  /** flat = 0;unscoreable / unknown = null。 */
  r: number | null;
  status: LegStatus;
  fill: number | null;
  stop: number | null;
  tp: number | null;
  bars_walked: number;
  note: string;
}

const FLAT: LedgerLeg = { stance: 'flat', direction: null, r: 0, status: 'flat', fill: null, stop: null, tp: null, bars_walked: 0, note: '明确不入场:这段 horizon 里什么也没做,记 0R' };
const unscoreable = (note: string, direction: Direction | null = null): LedgerLeg => ({ stance: direction ? 'direction' : 'unknown', direction, r: null, status: 'unscoreable', fill: null, stop: null, tp: null, bars_walked: 0, note });
/** 缺数据/没跑:null,不进任何均值,**不是** flat。 */
const unknownLeg = (note: string): LedgerLeg => ({ stance: 'unknown', direction: null, r: null, status: 'unscoreable', fill: null, stop: null, tp: null, bars_walked: 0, note: note || '表态未知(缺数据或没运行)' });

/**
 * 「按这个方向、用机械基线的风控参数走一遍」:下一根开盘市价成交,止损放在 20 根突破位外 0.8 ATR
 * (突破位落在成交价错误一侧时退化成「成交价 ∓ 0.8 ATR」,与 funnel.ts 一致),止盈 1.5R,最多 48 根,
 * 都没碰到就按第 48 根收盘 mark-to-market。`bars` 必须是 as_of 之后的那段(bars[0] = 成交那根)。
 */
export function counterfactualLeg(direction: Direction | null, snapshot: LedgerSnapshot | null, bars: readonly Kline[]): LedgerLeg {
  if (direction === null) return { ...FLAT };
  if (!snapshot) return unscoreable('没有指标快照', direction);
  if (!bars.length) return unscoreable('horizon 内没有 K 线', direction);
  const atr = snapshot.atr14;
  if (!(atr > 0)) return unscoreable('ATR 不可用', direction);
  const fill = Number(bars[0]!.open);
  if (!Number.isFinite(fill) || fill <= 0) return unscoreable('下一根开盘价不可用', direction);
  const long = direction === 'long';
  const level = long ? snapshot.swing_high_20 : snapshot.swing_low_20;
  const anchor = Number.isFinite(level) ? (long ? Math.min(level, fill) : Math.max(level, fill)) : fill;
  const stop = long ? anchor - MECHANICAL_STOP_ATR * atr : anchor + MECHANICAL_STOP_ATR * atr;
  const trade = openTrade(direction, fill, stop, null);
  if (!trade) return unscoreable(`止损 ${stop} 落在成交价 ${fill} 的错误一侧`, direction);
  const tp = long ? fill + MECHANICAL_TP_R * trade.stop_distance : fill - MECHANICAL_TP_R * trade.stop_distance;
  trade.tp = tp;
  const walk = bars.slice(0, MECHANICAL_HORIZON_BARS);
  let walked = 0;
  for (const bar of walk) {
    walked++;
    const step = stepTrade(trade, bar);
    if (!step.exit) continue;
    return { stance: 'direction', direction, r: round(tradeR(trade, step.exit.price)), status: step.exit.status, fill, stop, tp, bars_walked: walked, note: step.exit.note };
  }
  const lastClose = Number(walk[walk.length - 1]!.close);
  return { stance: 'direction', direction, r: round(tradeR(trade, lastClose)), status: 'expired', fill, stop, tp, bars_walked: walked, note: '到期按收盘价 mark-to-market' };
}

/**
 * 按三态出腿:`direction` 走反事实、`flat` 记 0R、`unknown` 记 null。
 * 三条腿都走这里,保证「同快照、同 horizon、同成本口径」—— 这是 (a) 那本账成立的前提。
 */
export function legForStance(read: StanceRead, snapshot: LedgerSnapshot | null, bars: readonly Kline[]): LedgerLeg {
  if (read.stance === 'unknown') return unknownLeg(read.note);
  if (read.stance === 'flat') return { ...FLAT, note: read.note || FLAT.note };
  return counterfactualLeg(read.direction, snapshot, bars);
}

// ---------------------------------------------------------------- 复查反事实(regret)

/** 复查那一刻线程的样子(落行时快照下来,之后线程再怎么变都不影响这行的口径)。 */
export interface LedgerReviewSnapshot {
  status: 'in_position' | 'pending_entry';
  side: Direction;
  entry_type: 'market' | 'limit';
  entry_price: number | null;
  fill: number | null;
  stop: number;
  tp: number | null;
  /**
   * true = 线程当时已经是终态(EXIT 之后),这份「退出前状态」是从线程上仍在的字段**重建**的。
   * 复审 P1-12:EXIT 的 regret 恰恰最需要退出前状态,直接返回 null 会把要比较的东西丢掉。
   */
  reconstructed: boolean;
}

export interface LedgerRegret {
  hold_r: number;
  exit_now_r: number;
  chosen_r: number;
  best_r: number;
  /** best_r − chosen_r,按构造 ≥ 0。 */
  regret_r: number;
  /**
   * 拿着的后悔(jl-v2):选了 hold 腿(HOLD/ADD)时 = max(0, exit_now_r − hold_r),否则 null。
   * 与 `regret_exit` 拆开,「该走没走」和「不该走却走了」才分得开。旧行没有这个字段。
   */
  regret_hold?: number | null;
  /** 走掉的后悔(jl-v2):EXIT/INVALIDATE 时 = max(0, hold_r − exit_now_r),否则 null。 */
  regret_exit?: number | null;
  hold_status: 'stop' | 'tp' | 'expired' | 'unfilled';
  note: string;
}

/**
 * 「如果不这么判会怎样」(eval-a counterfactual.ts 的口径搬过来):
 *   in_position  hold_r = 从成交价一直拿到止损/止盈,都没碰到按 horizon 末根收盘;exit_now_r = 按 as_of 价平掉
 *   pending_entry hold_r = 挂单留着(horizon 内触及入场价才成交,再走同一条路;整段没成交 = 0);exit_now_r = 0(撤单)
 * chosen:HOLD/ADD→hold,REDUCE→一半一半,EXIT/INVALIDATE→exit_now。regret = max(两者) − chosen。
 */
export function reviewRegret(rev: LedgerReviewSnapshot, action: string, markAtAsOf: number | null, bars: readonly Kline[]): LedgerRegret | null {
  const walk = bars.slice(0, MECHANICAL_HORIZON_BARS);
  if (!walk.length) return null;
  let hold_r: number;
  let exit_now_r: number;
  let hold_status: LedgerRegret['hold_status'];
  let note: string;
  if (rev.status === 'in_position') {
    const fill = rev.fill ?? rev.entry_price;
    if (fill === null || markAtAsOf === null) return null;
    const trade = openTrade(rev.side, fill, rev.stop, rev.tp);
    if (!trade) return null;
    let exitPx: number | null = null;
    let status: 'stop' | 'tp' | null = null;
    for (const bar of walk) {
      const step = stepTrade(trade, bar);
      if (!step.exit) continue;
      exitPx = step.exit.price;
      status = step.exit.status;
      break;
    }
    if (exitPx === null) {
      exitPx = Number(walk[walk.length - 1]!.close);
      hold_status = 'expired';
      note = 'HOLD 到 horizon 末根收盘(止损/止盈都没碰到)';
    } else {
      hold_status = status!;
      note = `HOLD 走到${status === 'stop' ? '止损' : '止盈'}`;
    }
    hold_r = tradeR(trade, exitPx);
    exit_now_r = tradeR(trade, markAtAsOf);
  } else {
    const o = simulateOutcome({ direction: rev.side, entry: rev.entry_type, limit_price: rev.entry_price, stop: rev.stop, tp: rev.tp, bars: [...walk] });
    if (o.status === 'invalid') return null;
    hold_r = o.r ?? 0;
    exit_now_r = 0;
    hold_status = o.status === 'unfilled' ? 'unfilled' : o.status;
    note = o.status === 'unfilled' ? '挂单在 horizon 内没成交,留着与撤掉等价(0R)' : '挂单成交后按同一套止损/止盈走';
  }
  const chosen_r = action === 'REDUCE' ? (hold_r + exit_now_r) / 2 : action === 'EXIT' || action === 'INVALIDATE' ? exit_now_r : hold_r;
  const best_r = Math.max(hold_r, exit_now_r);
  const regret_hold = action === 'HOLD' || action === 'ADD' ? round(Math.max(0, exit_now_r - hold_r)) : null;
  const regret_exit = action === 'EXIT' || action === 'INVALIDATE' ? round(Math.max(0, hold_r - exit_now_r)) : null;
  return { hold_r: round(hold_r), exit_now_r: round(exit_now_r), chosen_r: round(chosen_r), best_r: round(best_r), regret_r: round(Math.max(0, best_r - chosen_r)), regret_hold, regret_exit, hold_status, note };
}

// ---------------------------------------------------------------- 账本行

/** `'thread_settlement'` 只为读得懂旧行保留;新行**永远不会**产出它(净结算搬去 `realized` 了)。 */
export type ModelOutcomeSource = 'thread_settlement' | 'counterfactual' | 'flat' | 'unscoreable';

/**
 * (b) 那本账:这一笔在交易所真正拿到多少。**不参与 judgment_alpha** ——
 * 风险基数、退出时点、手续费/资金费都与反事实腿不同,混进去比的就不是判断了。
 */
export interface LedgerRealized {
  /** tradeCard 的 r_multiple(净盈亏 ÷ |成交价−止损|×数量);算不出为 null。 */
  r: number | null;
  net_pnl: string | null;
  exit_price: number | null;
  /** tradeCard 的 exit_class(止盈/止损/手动…);没有为 null。 */
  exit_class: string | null;
  source: 'thread_settlement';
  /** 这笔净结算本身可不可信(P1-13)。非 complete 时这一行不进任何统计。 */
  settlement_status: SettlementStatus;
  reasons: string[];
}

export interface JudgmentLedgerRow {
  /**
   * `online` = 盯盘循环的模型判断(默认,统计口径就是它);`replay` = 判断回放;
   * `trader` = 跟单腿(带单员信号那一条,09-12 §9.38);`backfill` = 历史 episode 事后补记
   * (scripts/ledger-backfill.ts,止损/止盈从线程终态重建)。**四者不是同一个实验**,
   * 默认查询只看 `online`,列的维护靠 migrations 里的触发器(backfill 暂由脚本直接写列)。
   */
  source?: LedgerSource;
  version: string;
  episode_id: string;
  at: number;
  as_of: number;
  symbol: string;
  timeframe: string | null;
  mode: 'scan' | 'review';
  thread_id: string | null;
  /**
   * 独立实验簇:有线程用 thread_id,否则用 episode_id。同一条线程被复查 12 次 = 1 个簇,
   * 不是 12 个独立样本(复审 P1-12「伪重复样本」)。
   */
  cluster_id: string;
  strategy_id: string | null;
  model_action: string | null;
  /**
   * 分层键(jl-v2,09-23 §6 P0-1)。旧行没有 → 读作 null / 'unknown'。
   *   trigger_kind   episode.trigger.kind(heartbeat / kline_close / breakout / …)
   *   holding_reason 持仓动作闸给的理由(episode.holding_review.reason:thesis_intact /
   *                  confirmed_thesis_invalidation / hard_stop_touch / …);只对 review 行有意义,
   *                  09-09 之前没有这道闸的 episode 记 'unknown';scan 行为 null
   *   prompt_version episode.prompt_version
   */
  trigger_kind?: string | null;
  holding_reason?: string | null;
  prompt_version?: string | null;
  /**
   * 判断当时的标记价(jl-v2)。复查 regret 只要它 + 线程计划 + K 线,不要 ATR:旧 episode 的结构行按价格量级取整
   * (>100 取整,SOL 105 的 1m ATR 被写成 `ATR14 0`),快照读不出来时 regret 仍靠它算得出来。旧行没有。
   */
  mark?: number | null;
  /** 三态表态(P1-12)。`model_dir` 只在 `direction` 态非空,留给展示。 */
  model_stance: LegStance;
  model_dir: Direction | null;
  council_stance: LegStance;
  council_dir: Direction | null;
  /** 议会是否达成共识;没有议会为 null(不是 false)。 */
  council_agree: boolean | null;
  mechanical_dir: Direction | null;
  mechanical_note: string | null;
  horizon_end_at: number;
  outcome_r_model: number | null;
  outcome_r_council: number | null;
  outcome_r_mechanical: number | null;
  outcome_source_model: ModelOutcomeSource | null;
  regret_review: number | null;
  /** = regret.regret_hold(jl-v2);旧行没有。 */
  regret_hold?: number | null;
  settled_at: number | null;
  settle_note: string | null;
  /** null = 这一行不涉及交易所结算(纯扫描 / 线程还开着);否则见 `rowSettlementStatus`。 */
  settlement_status: SettlementStatus | null;
  /** (b) 那本账;没有已平线程为 null。 */
  realized: LedgerRealized | null;
  snapshot: LedgerSnapshot | null;
  review: LedgerReviewSnapshot | null;
  legs: { model: LedgerLeg | null; council: LedgerLeg | null; mechanical: LedgerLeg | null };
  regret: LedgerRegret | null;
}

/**
 * 复查那一刻线程的样子。线程还开着就直接照抄;已经 closed(EXIT 之后巡检才来结算)则用线程上仍在的
 * 字段**重建退出前状态**:有成交均价 = 当时在仓(in_position),没有 = 当时还是挂单(pending_entry)。
 * 实在缺止损价重建不出来才返回 null。
 */
export function reviewSnapshot(thread: StrategyThread | null): LedgerReviewSnapshot | null {
  if (!thread) return null;
  const stop = Number(thread.stop_price);
  if (!Number.isFinite(stop)) return null;
  const entry = thread.entry.price === null ? null : Number(thread.entry.price);
  const fillRaw = thread.filled_avg_price === null || thread.filled_avg_price === undefined ? null : Number(thread.filled_avg_price);
  const fill = fillRaw !== null && Number.isFinite(fillRaw) ? fillRaw : null;
  const live = thread.status === 'in_position' || thread.status === 'pending_entry';
  // 重建:成交过(有均价或 opened_at)= 退出前在仓;否则还是挂单。
  const status: 'in_position' | 'pending_entry' = live ? (thread.status as 'in_position' | 'pending_entry') : fill !== null || thread.opened_at !== null ? 'in_position' : 'pending_entry';
  const tpRaw = thread.take_profits[0];
  return {
    status,
    side: thread.side,
    entry_type: thread.entry.type,
    entry_price: entry !== null && Number.isFinite(entry) ? entry : null,
    fill,
    stop,
    tp: tpRaw === undefined ? null : Number(tpRaw),
    reconstructed: !live,
  };
}

// ---------------------------------------------------------------- 表态三态(P1-12)

/** 复查动作:模型在守一条已经存在的线程。 */
const HOLD_ACTIONS = new Set(['HOLD', 'ADD', 'REDUCE']);
/** 明确不入场的动作:全是 0R 的 flat 腿(`WATCH + direction` 也在里面)。 */
const FLAT_ACTIONS = new Set(['NO_TRADE', 'WATCH', 'EXIT', 'INVALIDATE']);
const REVIEW_ACTIONS = new Set([...HOLD_ACTIONS, 'EXIT', 'INVALIDATE']);
/** 线程复查触发(线程生命周期事件唤醒的那几种)。 */
const REVIEW_TRIGGERS = new Set(['thread_review', 'order_filled', 'tp_hit', 'sl_hit']);

/**
 * 模型这一刻的表态。**flat 按 action 判,不按 direction 判**:
 *   - `PROPOSE` + 方向、`HOLD/ADD/REDUCE`(方向用它守着的线程)= direction;
 *   - `NO_TRADE / WATCH / EXIT / INVALIDATE` = flat(0R)—— 注意 `WATCH + direction=long` 也是 flat,
 *     模型给了方向但明确不入场,把它模拟成一笔仓位就是替模型下了它没下的注;
 *   - 没有 judgment / 方向读不出来(HOLD 但线程也没了)= unknown(null,不进任何均值)。
 */
export function modelStanceOf(ep: Episode, thread: StrategyThread | null): StanceRead {
  const j = ep.judgment;
  if (!j) return { stance: 'unknown', direction: null, note: '这次判断没有结果(模型没跑出来 / schema 没过)' };
  if (FLAT_ACTIONS.has(j.action)) return { stance: 'flat', direction: null, note: `模型 ${j.action}:明确不入场,记 0R` };
  if (j.direction) return { stance: 'direction', direction: j.direction, note: '' };
  if (thread && HOLD_ACTIONS.has(j.action)) return { stance: 'direction', direction: thread.side, note: '' };
  return { stance: 'unknown', direction: null, note: `模型 ${j.action} 但方向读不出来(没有 direction,也没有线程方向)` };
}

/** 兼容壳(旧调用方/旧测试):只有 `direction` 态才给方向,flat 与 unknown 都是 null。 */
export function modelStance(ep: Episode, thread: StrategyThread | null): Direction | null {
  return modelStanceOf(ep, thread).direction;
}

/** 议会最少需要的形状(不 import strategy-council.ts,避免账本反向依赖议会)。 */
export interface CouncilLike {
  consensus: { reached: boolean; direction: Direction | null };
  /**
   * 09-12 P1-12:**纯代码共识**(`runCouncil` 的 `code_consensus`)。账本的议会腿是拿来和模型腿
   * 比的,混了模型票的 `consensus` 当议会腿等于「模型和自己比」,alpha 会被系统性地压向 0。
   * 有这个字段就用它,没有(旧 episode)才退回 `consensus`。
   */
  code_consensus?: { reached: boolean; direction: Direction | null };
}

/** 账本该消费的那一份共识:优先纯代码票。 */
export function ledgerConsensusOf(council: CouncilLike | null | undefined): { reached: boolean; direction: Direction | null } | null {
  if (!council) return null;
  return council.code_consensus ?? council.consensus;
}

/**
 * 议会表态:**`reached === true` 才是 direction**。
 * 赞成票不够时 consensus 仍可能带着一张方向票的 direction,那不是「议会要入场」,是 flat。
 * 完全没有议会(off / 旧 episode)= unknown,不是 flat。
 */
export function councilStanceOf(council: CouncilLike | null | undefined): StanceRead {
  const c = ledgerConsensusOf(council);
  if (!c) return { stance: 'unknown', direction: null, note: '这次判断没有议会(off 或旧 episode)' };
  if (!c.reached) return { stance: 'flat', direction: null, note: '议会没达成共识:不入场,记 0R' };
  if (!c.direction) return { stance: 'flat', direction: null, note: '议会达成共识但没有方向:不入场,记 0R' };
  return { stance: 'direction', direction: c.direction, note: '' };
}

// ---------------------------------------------------------------- 结算完整性(P1-13)

export type SettlementStatus = 'missing' | 'partial' | 'complete';

/** 结算 note 里两句固定话(runtime.settleThread 写的),用来认出「空成交」与「资金费按 0 记」。 */
const NOTE_NO_TRADES = /没有这个币的成交|没有成交/;
const NOTE_NO_FUNDING = /资金费/;

/**
 * 归属证明开关:`ThreadSettlement` 目前**没有任何订单/CID 字段**(types.ts 只读不改),所以
 * 「按时间窗口归属」这条 caveat 一定会出现在 `reasons` 里作为证据,但默认不据此判 partial ——
 * 否则今天每一笔结算都是 partial,账本直接空掉。等 runtime 开始往 settlement 里写订单级归属,
 * 把这个开关翻成 true 就能收紧。
 */
export const SETTLEMENT_REQUIRE_ORDER_ATTRIBUTION = false;

/**
 * 一笔线程的**交易所结算完整性**(09-12 复审 P1-13)。
 *
 * 背景:`runtime.settleThread` 把 [开仓−宽限, 平仓+宽限] 窗口里该币的**所有**成交都归给这条线程,
 * 没有按订单/CID 归属;`funding` 读不到时按 0 写;窗口里一笔成交都没有时**照样存下 settlement 对象**,
 * 而 `settlePending` 只挑 `!settlement`,于是这种空壳结算之后再也不会被自动补。
 * 只要「见到 settlement 对象就当结算完成」,这些洞就会一路流进策略适配、降级与模型 alpha。
 *
 * 判定:
 *   - `missing`  没有线程 / 线程还没 closed / 压根没有 settlement 对象;
 *   - `partial`  有对象但不可信:窗口内 0 笔成交、没有平仓均价、资金费缺失被当 0;
 *   - `complete` 以上都不占。
 */
export function settlementCompleteness(thread: StrategyThread | null | undefined): { status: SettlementStatus; reasons: string[] } {
  if (!thread) return { status: 'missing', reasons: ['没有线程'] };
  const st = thread.settlement;
  if (!st) return { status: 'missing', reasons: thread.status === 'closed' ? ['线程已平但还没有交易所结算(结算中)'] : ['线程还没平仓,没有结算'] };
  const blocking: string[] = [];
  const note = st.note ?? '';
  if (!(st.trades > 0)) blocking.push('结算窗口内没有成交记录(trades = 0):这不是「盈亏为 0」,是没查到');
  if (st.exit_price === null) blocking.push('没有平仓腿均价(exit_price = null):只有开仓腿,或平仓成交没查到');
  if (NOTE_NO_TRADES.test(note)) blocking.push(`结算自带告警:${note}`);
  if (NOTE_NO_FUNDING.test(note)) blocking.push(`资金费缺失被当 0 写进净额:${note}`);
  const attribution = '归属口径:窗口内该币的全部成交都算这条线程,没有订单/CID 级归属证明';
  if (SETTLEMENT_REQUIRE_ORDER_ATTRIBUTION) blocking.push(attribution);
  return { status: blocking.length ? 'partial' : 'complete', reasons: [...blocking, attribution] };
}

/**
 * 账本行上的结算状态。**null = 这一行不涉及交易所结算**(纯扫描,或线程还开着)——
 * 那种行的三条腿全是反事实,不依赖结算,照常进统计。
 * 线程已经平掉的行才判:非 complete 的一律不进 `summarizeLedger`。
 */
export function rowSettlementStatus(thread: StrategyThread | null | undefined): SettlementStatus | null {
  if (!thread || thread.status !== 'closed') return null;
  return settlementCompleteness(thread).status;
}

// ---------------------------------------------------------------- mode(纯函数)

/**
 * scan 还是 review —— **按动作与触发判,不按 `ep.thread_id` 非空判**(复审 P1-12)。
 * 开仓 episode 在末尾会被填上刚建出来的 `thread_id`,只看它就会把「提议开仓」错记成「复查」。
 */
export function ledgerMode(ep: Episode, thread: StrategyThread | null): 'scan' | 'review' {
  const action = ep.judgment?.action ?? null;
  if (action === 'PROPOSE') return 'scan';
  if (action && REVIEW_ACTIONS.has(action)) return 'review';
  if (REVIEW_TRIGGERS.has(ep.trigger.kind)) return 'review';
  if (!ep.thread_id) return 'scan';
  // 有线程、动作又是 NO_TRADE/WATCH/没判断:线程还活着就是在复查它。
  return thread && (thread.status === 'in_position' || thread.status === 'pending_entry') ? 'review' : 'scan';
}

/** 一个 done 的 episode → 一行未结算的账本(outcome 全空)。不该记账的返回 null。 */
/** 已知的账本来源。`backfill` 见 `JudgmentLedgerRow.source`。 */
export type LedgerSource = 'online' | 'replay' | 'trader' | 'backfill';

/** review 行的持仓理由:闸门有记录就用它,没有(09-09 之前的 episode)= 'unknown'。 */
export function holdingReasonOf(ep: Episode, mode: 'scan' | 'review'): string | null {
  if (mode !== 'review') return null;
  const reason = (ep as { holding_review?: { reason?: unknown } | null }).holding_review?.reason;
  return typeof reason === 'string' && reason ? reason : 'unknown';
}

export function ledgerRowFor(ep: Episode, thread: StrategyThread | null): JudgmentLedgerRow | null {
  if (ep.status !== 'done') return null;
  if (ep.trigger.kind === 'chat') return null; // 对话里的提议不是盯盘判断,不进账本
  const council = ep.strategy_council ?? null;
  if (!ep.judgment && !council) return null;
  const { snapshot, note } = snapshotFromEpisode(ep);
  const mech = mechanicalDirection(snapshot);
  const model = modelStanceOf(ep, thread);
  const councilRead = councilStanceOf(council);
  const mode = ledgerMode(ep, thread);
  // jl-v2:快照读不出来的复查行退回线程周期 —— 三条腿照样 unscoreable(没有 ATR),但 regret 只要 K 线 + 标记价,不该跟着丢。
  const tf = snapshot?.timeframe ?? (mode === 'review' ? (thread?.timeframe ?? null) : null);
  const horizonMs = tf ? tfToMs(tf) * MECHANICAL_HORIZON_BARS : 0;
  return {
    version: JUDGMENT_LEDGER_VERSION,
    episode_id: ep.id,
    at: ep.at,
    as_of: ep.as_of,
    symbol: ep.symbol,
    timeframe: tf,
    mode,
    thread_id: ep.thread_id,
    cluster_id: ep.thread_id ?? ep.id,
    strategy_id: ep.judgment?.strategy_id ?? thread?.strategy_id ?? null,
    model_action: ep.judgment?.action ?? null,
    trigger_kind: ep.trigger?.kind ?? null,
    holding_reason: holdingReasonOf(ep, mode),
    prompt_version: ep.prompt_version ?? null,
    mark: markOfEpisode(ep),
    model_stance: model.stance,
    model_dir: model.direction,
    council_stance: councilRead.stance,
    council_dir: councilRead.direction,
    council_agree: council ? (ledgerConsensusOf(council)?.reached ?? null) : null,
    mechanical_dir: mech.direction,
    mechanical_note: mech.direction ? null : (note || mech.note),
    horizon_end_at: ep.as_of + horizonMs,
    outcome_r_model: null,
    outcome_r_council: null,
    outcome_r_mechanical: null,
    outcome_source_model: null,
    regret_review: null,
    settled_at: null,
    settle_note: snapshot ? null : note,
    settlement_status: rowSettlementStatus(thread),
    realized: null,
    snapshot,
    // regret 只对复查有意义;开仓 episode(mode=scan)不比「如果不这么判会怎样」。
    review: mode === 'review' ? reviewSnapshot(thread) : null,
    legs: { model: null, council: null, mechanical: null },
    regret: null,
  };
}

/**
 * 回填一行:`bars` 是 as_of 之后该周期的 K 线(bars[0] = 判断之后的第一根)。
 *
 * **模型腿永远是反事实**(复审 P1-12):同一份快照、同一时点、同一 horizon、同一套退出与成本口径,
 * 三条腿才是同一个实验。交易所的净 R 走 `realized` 那本账,不覆盖模型腿、不进 judgment_alpha。
 */
export function settleRow(
  row: JudgmentLedgerRow,
  bars: readonly Kline[],
  thread: StrategyThread | null,
  now: number,
  /**
   * `review_bars`:复查 regret 用的 K 线(线程自己的周期)。不给就用 `bars`(快照周期)——
   * 快照周期取的是第一条结构证据,15m 线程里有的 episode 先写了 1h 结构,那样 regret 的 horizon 会被拉到 48 小时。
   * 三条腿照旧吃 `bars`(它们要和快照的 ATR 同周期)。
   */
  opts: { review_bars?: readonly Kline[] } = {},
): JudgmentLedgerRow {
  const future = bars.filter((k) => k.open_time >= row.as_of);
  const reviewFuture = opts.review_bars ? opts.review_bars.filter((k) => k.open_time >= row.as_of) : future;
  const snapshot = row.snapshot;
  const model = legForStance({ stance: row.model_stance, direction: row.model_dir, note: '模型这次没有可用的表态' }, snapshot, future);
  const council = legForStance({ stance: row.council_stance, direction: row.council_dir, note: '这次判断没有议会' }, snapshot, future);
  // 机械基线读不出方向(EMA 打平 / 没有 1h 结构)= unknown,不是 flat:那是缺数据,不是「决定不做」。
  const mechanical = legForStance(
    row.mechanical_dir ? { stance: 'direction', direction: row.mechanical_dir, note: '' } : { stance: 'unknown', direction: null, note: row.mechanical_note ?? '机械基线方向说不出来' },
    snapshot,
    future,
  );
  const source: ModelOutcomeSource = model.stance === 'flat' ? 'flat' : model.r === null ? 'unscoreable' : 'counterfactual';
  // (b) 那本账:整笔完整净结算的实际 P&L,带着它自己的完整性标志。
  let realized: LedgerRealized | null = null;
  if (thread && thread.status === 'closed' && thread.settlement) {
    const card = tradeCard(thread);
    const completeness = settlementCompleteness(thread);
    realized = {
      r: card.r_multiple === null ? null : round(card.r_multiple),
      net_pnl: thread.settlement.net_pnl ?? null,
      exit_price: card.exit_price,
      exit_class: card.exit_class ?? null,
      source: 'thread_settlement',
      settlement_status: completeness.status,
      reasons: completeness.reasons,
    };
  }
  const regret = row.review && row.model_action ? reviewRegret(row.review, row.model_action, snapshot?.mark ?? row.mark ?? snapshot?.last_close ?? null, reviewFuture) : null;
  const notes: string[] = [];
  if (!snapshot) notes.push(row.settle_note ?? '没有指标快照');
  if (!future.length) notes.push('horizon 内取不到 K 线');
  if (realized && realized.settlement_status !== 'complete') notes.push(`交易所结算不完整(${realized.settlement_status}),这一行不进汇总统计`);
  return {
    ...row,
    outcome_r_model: model.r,
    outcome_r_council: council.r,
    outcome_r_mechanical: mechanical.r,
    outcome_source_model: source,
    regret_review: regret?.regret_r ?? null,
    regret_hold: regret?.regret_hold ?? null,
    settled_at: now,
    settle_note: notes.length ? notes.join(';') : null,
    settlement_status: rowSettlementStatus(thread) ?? row.settlement_status,
    realized,
    legs: { model, council, mechanical },
    regret,
  };
}

// ---------------------------------------------------------------- 汇总

export interface LedgerStratum {
  /** null = 全体(不分层)。按其它维度分层时也是 null,层名看 `dim` / `value`。 */
  strategy_id: string | null;
  /** 分层维度(jl-v2):'strategy' / 'trigger_kind' / 'holding_reason' / 'prompt_version';全体为 null。 */
  dim?: LedgerDim | null;
  /** 这一层的键值(旧行缺键 = 'unknown')。 */
  value?: string | null;
  /** 窗口内属于这一层的总行数(含未结算、含被排除的)。展示用,**不是**下结论的分母。 */
  n: number;
  /** 结算完整、可以进统计的行数。 */
  n_eligible: number;
  /** 因交易所结算不完整(P1-13)被排除的行数。 */
  excluded_incomplete: number;
  /**
   * 样本不足:**有效配对数 < LEDGER_MIN_SAMPLE 或独立簇数 < LEDGER_MIN_CLUSTERS**(不是总行数)。
   * 为 true 时 `verdict` 只能是 `'insufficient'`。
   */
  insufficient: boolean;
  /** mean(R_model − R_council);两条腿都有 R 的行才进(unknown 腿是 null,自动不进)。 */
  judgment_alpha: number | null;
  alpha_n: number;
  /** `alpha_n` 里的**独立簇**数(同一线程的多次复查算 1 个)。 */
  alpha_clusters: number;
  /** mean(R_model − R_mechanical)。 */
  alpha_vs_mechanical: number | null;
  alpha_mech_n: number;
  /** 行动覆盖率:表态已知的行里,模型/议会各自「给出方向并愿意入场」的占比。 */
  model_direction_rate: number | null;
  model_known_n: number;
  council_direction_rate: number | null;
  council_known_n: number;
  /** **双方都给方向**时的 mean(R_model − R_council):纯方向对照,不掺 flat。 */
  alpha_both_dir: number | null;
  alpha_both_dir_n: number;
  /** 模型表态与议会表态不一致的比例(两边表态都已知的行才算分母)。 */
  override_rate: number | null;
  override_n: number;
  /** 不一致时的 mean(R_model − R_council):< 0 = 模型每次「不听议会」都是亏的。 */
  override_alpha: number | null;
  /** 复查 regret 均值(越小越好)。 */
  review_regret: number | null;
  review_n: number;
  /** jl-v2:只看选了 hold 腿的复查行,mean(max(0, exit_now_r − hold_r))。旧行没有这个数,不进分母。 */
  review_regret_hold: number | null;
  review_hold_n: number;
  /** 结论口径见 `LEDGER_CONCLUSION`。 */
  verdict: 'insufficient' | 'no_edge' | 'model_adds' | 'model_hurts' | 'unclear';
}

export interface LedgerSummary {
  version: string;
  since: number | null;
  /** 窗口内的总行数(含未结算)。 */
  n: number;
  settled: number;
  unsettled: number;
  /** 因交易所结算不完整被排除出所有统计的行数(P1-13)。 */
  excluded_incomplete: number;
  overall: LedgerStratum;
  by_strategy: LedgerStratum[];
  /** jl-v2 分层(09-23 §6 P0-1)。 */
  by_trigger_kind: LedgerStratum[];
  by_holding_reason: LedgerStratum[];
  by_prompt_version: LedgerStratum[];
  /** 复查决策表:mode='review' 按 (model_action × holding_reason × trigger_kind × prompt_version) 分组。 */
  by_decision: DecisionStratum[];
  min_sample: number;
  min_clusters: number;
  conclusion: string;
}

/** 结论口径(设计文档 §3;09-12 复审 P1-12 收紧):写死在代码里,不让模型解释它。 */
export const LEDGER_CONCLUSION =
  `样本门槛先过:**有效配对数** alpha_n ≥ ${LEDGER_MIN_SAMPLE} 且**独立簇数** alpha_clusters ≥ ${LEDGER_MIN_CLUSTERS}(同一线程的多次复查算一个簇),` +
  '否则 insufficient —— 此时只看数字,不下任何结论,更不能说「模型没有增量」。够了之后:' +
  'judgment_alpha ≈ 0 且 override_alpha < 0 → 模型没有增量,该关掉模型让议会直接下单(省钱);' +
  'judgment_alpha > 0 只在某族 → 模型只在该族用;alpha_vs_mechanical ≤ 0 → 连那枚硬币都没赢,先别谈策略好坏。' +
  '读之前先看行动覆盖率(model/council_direction_rate)与 alpha_both_dir:' +
  'flat 腿的 0R 是「不承担风险」的真实价值,但它衡量不了方向准确度,两边都 flat 会把 alpha 稀释到 0。' +
  'realized(交易所净 R)是另一本账,不进 judgment_alpha;结算不完整的行整行不进统计。';

const mean = (xs: number[]): number | null => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/** 这一行的数字可不可信:结算不完整(P1-13)就整行不进统计。 */
export function ledgerRowEligible(r: JudgmentLedgerRow): boolean {
  return r.settlement_status === null || r.settlement_status === undefined || r.settlement_status === 'complete';
}

/** 表态已知(不是 unknown)。旧行没有 stance 字段:从 dir/agree 回推。 */
function modelStanceOfRow(r: JudgmentLedgerRow): LegStance {
  return r.model_stance ?? (r.model_dir ? 'direction' : 'flat');
}
function councilStanceOfRow(r: JudgmentLedgerRow): LegStance {
  return r.council_stance ?? (r.council_agree === null ? 'unknown' : r.council_dir ? 'direction' : 'flat');
}
/** 表态的「有效方向」:flat 没有方向,unknown 不参与比较。 */
const effDir = (stance: LegStance, dir: Direction | null): Direction | null => (stance === 'direction' ? dir : null);

export type LedgerDim = 'strategy' | 'trigger_kind' | 'holding_reason' | 'prompt_version';

/** 行上某个分层键的值;旧行(jl-v1)缺键时 = 'unknown'。 */
export function ledgerKeyOf(r: JudgmentLedgerRow, dim: LedgerDim): string {
  if (dim === 'strategy') return r.strategy_id ?? '(未指明策略)';
  const v = dim === 'trigger_kind' ? r.trigger_kind : dim === 'holding_reason' ? r.holding_reason : r.prompt_version;
  if (dim === 'holding_reason' && r.mode !== 'review') return '(scan)';
  return v === null || v === undefined || v === '' ? 'unknown' : v;
}

/** 复查决策表的一格。均值按**行**算(簇数单列,样本口径同 `LedgerStratum`)。 */
export interface DecisionStratum {
  model_action: string;
  holding_reason: string;
  trigger_kind: string;
  prompt_version: string;
  /** 这一格里已结算且 regret 可算的复查行数。 */
  n: number;
  /** 独立簇(线程)数。 */
  clusters: number;
  mean_regret: number | null;
  mean_hold_r: number | null;
  mean_exit_now_r: number | null;
  /** 只在 HOLD/ADD 格非空。 */
  mean_regret_hold: number | null;
  /** EXIT/INVALIDATE 行里 regret > 0.5R 的占比(「走早了、拿着能多赚半个 R 以上」);非 EXIT 格为 null。 */
  exit_regret_gt_half_share: number | null;
  /** 这些行里线程结算不完整(P1-13)的行数。regret 只读计划与 K 线、不读 realized,所以**不据此剔除**,只标出来。 */
  settlement_incomplete: number;
  /** n < LEDGER_MIN_SAMPLE 或 clusters < LEDGER_MIN_CLUSTERS。 */
  insufficient: boolean;
}

/** 复查 regret 超过这个数(R)算「明显后悔」。 */
export const DECISION_REGRET_THRESHOLD_R = 0.5;

/**
 * 复查决策表(09-23 §6 P0-1):回答「提前走」到底有多贵、是被哪种理由放出去的。
 * 只看 mode='review'、已结算、regret 可算的行。**不按结算完整性剔除**:regret 的三个数(hold_r / exit_now_r /
 * chosen_r)只读线程计划(成交价/止损/止盈)和 K 线,不读交易所净额;剔掉会把没有交易所结算的 paper 线程整条丢掉。
 */
export function summarizeDecisions(rows: readonly JudgmentLedgerRow[]): DecisionStratum[] {
  const groups = new Map<string, JudgmentLedgerRow[]>();
  for (const r of rows) {
    if (r.mode !== 'review' || r.settled_at === null || !r.regret || !r.model_action) continue;
    const key = JSON.stringify([r.model_action, ledgerKeyOf(r, 'holding_reason'), ledgerKeyOf(r, 'trigger_kind'), ledgerKeyOf(r, 'prompt_version')]);
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }
  const out: DecisionStratum[] = [];
  for (const [key, g] of groups) {
    const [model_action, holding_reason, trigger_kind, prompt_version] = JSON.parse(key) as [string, string, string, string];
    const exits = g.filter((r) => r.model_action === 'EXIT' || r.model_action === 'INVALIDATE');
    const holds = g.filter((r) => r.model_action === 'HOLD' || r.model_action === 'ADD');
    const clusters = new Set(g.map((r) => r.cluster_id ?? r.thread_id ?? r.episode_id)).size;
    out.push({
      model_action,
      holding_reason,
      trigger_kind,
      prompt_version,
      n: g.length,
      clusters,
      mean_regret: mean(g.map((r) => r.regret!.regret_r)),
      mean_hold_r: mean(g.map((r) => r.regret!.hold_r)),
      mean_exit_now_r: mean(g.map((r) => r.regret!.exit_now_r)),
      mean_regret_hold: holds.length ? mean(holds.map((r) => r.regret!.regret_hold ?? Math.max(0, r.regret!.exit_now_r - r.regret!.hold_r))) : null,
      exit_regret_gt_half_share: exits.length ? round(exits.filter((r) => r.regret!.regret_r > DECISION_REGRET_THRESHOLD_R).length / exits.length) : null,
      settlement_incomplete: g.filter((r) => !ledgerRowEligible(r)).length,
      insufficient: g.length < LEDGER_MIN_SAMPLE || clusters < LEDGER_MIN_CLUSTERS,
    });
  }
  return out.sort((a, b) => b.n - a.n || a.model_action.localeCompare(b.model_action) || a.holding_reason.localeCompare(b.holding_reason) || a.trigger_kind.localeCompare(b.trigger_kind) || a.prompt_version.localeCompare(b.prompt_version));
}

function stratum(strategy_id: string | null, all: readonly JudgmentLedgerRow[], dim: LedgerDim | null = strategy_id === null ? null : 'strategy', value: string | null = strategy_id): LedgerStratum {
  const rows = all.filter(ledgerRowEligible);
  const excluded = all.length - rows.length;
  const settled = rows.filter((r) => r.settled_at !== null);
  const paired = settled.filter((r) => r.outcome_r_model !== null && r.outcome_r_council !== null);
  const pairedMech = settled.filter((r) => r.outcome_r_model !== null && r.outcome_r_mechanical !== null);
  const clusters = new Set(paired.map((r) => r.cluster_id ?? r.thread_id ?? r.episode_id)).size;
  // 分母:两边的表态都知道(方向或明确的不表态);unknown 不进。未结算的行不算。
  const dirKnown = settled.filter((r) => modelStanceOfRow(r) !== 'unknown' && councilStanceOfRow(r) !== 'unknown');
  const overrides = dirKnown.filter((r) => effDir(modelStanceOfRow(r), r.model_dir) !== effDir(councilStanceOfRow(r), r.council_dir));
  const overridePaired = overrides.filter((r) => r.outcome_r_model !== null && r.outcome_r_council !== null);
  const bothDir = paired.filter((r) => modelStanceOfRow(r) === 'direction' && councilStanceOfRow(r) === 'direction');
  const modelKnown = settled.filter((r) => modelStanceOfRow(r) !== 'unknown');
  const councilKnown = settled.filter((r) => councilStanceOfRow(r) !== 'unknown');
  const regrets = settled.filter((r) => r.regret_review !== null);
  const holdRegrets = settled.filter((r) => r.regret_hold !== null && r.regret_hold !== undefined);
  // 09-12 P1-12:alpha 按**簇均值**汇总,不是行均值。同一个 4h 桶/同一条线程里的多行不是独立样本,
  // 行均值会让「一根行情里刷了 20 行」的那一簇主导整个结论(与 replay-stats.effectiveReturns 同一道理)。
  const clusterMean = (rows: readonly JudgmentLedgerRow[], value: (r: JudgmentLedgerRow) => number): number | null => {
    const buckets = new Map<string, number[]>();
    for (const r of rows) {
      const key = String(r.cluster_id ?? r.thread_id ?? r.episode_id);
      const v = buckets.get(key) ?? [];
      v.push(value(r));
      buckets.set(key, v);
    }
    const perCluster = [...buckets.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
    return mean(perCluster);
  };
  const alpha = clusterMean(paired, (r) => r.outcome_r_model! - r.outcome_r_council!);
  const alphaMech = clusterMean(pairedMech, (r) => r.outcome_r_model! - r.outcome_r_mechanical!);
  const overrideAlpha = clusterMean(overridePaired, (r) => r.outcome_r_model! - r.outcome_r_council!);
  // 样本门槛:有效配对数 + 独立簇数,**不看总行数**(复审 P1-12 的反例:9 行 pending + 1 对配对)。
  const insufficient = paired.length < LEDGER_MIN_SAMPLE || clusters < LEDGER_MIN_CLUSTERS || alpha === null;
  let verdict: LedgerStratum['verdict'];
  if (insufficient) verdict = 'insufficient'; // 样本不够时绝不输出 no_edge/model_adds
  else if (Math.abs(alpha!) <= 0.05 && overrideAlpha !== null && overrideAlpha < -EPS) verdict = 'no_edge';
  else if (alpha! > 0.1) verdict = 'model_adds';
  else if (alpha! < -0.1) verdict = 'model_hurts';
  else verdict = 'unclear';
  return {
    strategy_id,
    dim,
    value,
    n: all.length,
    n_eligible: rows.length,
    excluded_incomplete: excluded,
    insufficient,
    judgment_alpha: alpha,
    alpha_n: paired.length,
    alpha_clusters: clusters,
    alpha_vs_mechanical: alphaMech,
    alpha_mech_n: pairedMech.length,
    model_direction_rate: modelKnown.length ? round(modelKnown.filter((r) => modelStanceOfRow(r) === 'direction').length / modelKnown.length) : null,
    model_known_n: modelKnown.length,
    council_direction_rate: councilKnown.length ? round(councilKnown.filter((r) => councilStanceOfRow(r) === 'direction').length / councilKnown.length) : null,
    council_known_n: councilKnown.length,
    alpha_both_dir: clusterMean(bothDir, (r) => r.outcome_r_model! - r.outcome_r_council!),
    alpha_both_dir_n: bothDir.length,
    override_rate: dirKnown.length ? round(overrides.length / dirKnown.length) : null,
    override_n: overrides.length,
    override_alpha: overrideAlpha,
    review_regret: mean(regrets.map((r) => r.regret_review!)),
    review_n: regrets.length,
    review_regret_hold: mean(holdRegrets.map((r) => r.regret_hold!)),
    review_hold_n: holdRegrets.length,
    verdict,
  };
}

function byDim(rows: readonly JudgmentLedgerRow[], dim: LedgerDim): LedgerStratum[] {
  const values = [...new Set(rows.map((r) => ledgerKeyOf(r, dim)))].sort();
  return values.map((v) => stratum(null, rows.filter((r) => ledgerKeyOf(r, dim) === v), dim, v)).sort((a, b) => b.n - a.n || String(a.value).localeCompare(String(b.value)));
}

/** 按策略分层的判断增量。纯函数:喂给它什么行,它就只看什么行。 */
export function summarizeLedger(rows: readonly JudgmentLedgerRow[], opts: { since?: number | null } = {}): LedgerSummary {
  const since = opts.since ?? null;
  const scoped = since === null ? [...rows] : rows.filter((r) => r.at >= since);
  const ids = [...new Set(scoped.map((r) => r.strategy_id ?? '(未指明策略)'))].sort();
  return {
    version: JUDGMENT_LEDGER_VERSION,
    since,
    n: scoped.length,
    settled: scoped.filter((r) => r.settled_at !== null).length,
    unsettled: scoped.filter((r) => r.settled_at === null).length,
    excluded_incomplete: scoped.filter((r) => !ledgerRowEligible(r)).length,
    overall: stratum(null, scoped),
    by_strategy: ids.map((id) => stratum(id, scoped.filter((r) => (r.strategy_id ?? '(未指明策略)') === id))).sort((a, b) => b.n - a.n || String(a.strategy_id).localeCompare(String(b.strategy_id))),
    by_trigger_kind: byDim(scoped, 'trigger_kind'),
    by_holding_reason: byDim(scoped.filter((r) => r.mode === 'review'), 'holding_reason'),
    by_prompt_version: byDim(scoped, 'prompt_version'),
    by_decision: summarizeDecisions(scoped),
    min_sample: LEDGER_MIN_SAMPLE,
    min_clusters: LEDGER_MIN_CLUSTERS,
    conclusion: LEDGER_CONCLUSION,
  };
}

// ---------------------------------------------------------------- 持久化

export interface LedgerQuery {
  source?: LedgerSource | 'all';
  since?: number | null;
  strategy_id?: string | null;
  limit?: number;
  offset?: number;
  /** 游标分页:上一页最后一行的 `encodeLedgerCursor()`。给了就忽略 offset(游标优先,offset 留作兼容旧调用)。 */
  cursor?: string | null;
}

/** 游标 = "at:episode_id"(与 `list()` 的排序 `ORDER BY at DESC, episode_id DESC` 对齐,同一 `at` 也能稳定分页)。 */
export function encodeLedgerCursor(row: Pick<JudgmentLedgerRow, 'at' | 'episode_id'>): string {
  return `${row.at}:${row.episode_id}`;
}

export function decodeLedgerCursor(raw: string): { at: number; episode_id: string } | null {
  const idx = raw.indexOf(':');
  if (idx < 0) return null;
  const at = Number(raw.slice(0, idx));
  const episode_id = raw.slice(idx + 1);
  if (!Number.isFinite(at) || !episode_id) return null;
  return { at, episode_id };
}

export class JudgmentLedgerStore {
  constructor(private readonly db: DatabaseSync) {}

  save(row: JudgmentLedgerRow): void {
    this.db
      .prepare(
        `INSERT INTO demo_judgment_ledger(episode_id, at, as_of, symbol, timeframe, mode, thread_id, strategy_id,
           model_action, model_dir, council_dir, council_agree, mechanical_dir, mechanical_note, horizon_end_at,
           outcome_r_model, outcome_r_council, outcome_r_mechanical, outcome_source_model, regret_review,
           settled_at, settle_note, json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(episode_id) DO UPDATE SET
           outcome_r_model = excluded.outcome_r_model, outcome_r_council = excluded.outcome_r_council,
           outcome_r_mechanical = excluded.outcome_r_mechanical, outcome_source_model = excluded.outcome_source_model,
           regret_review = excluded.regret_review, settled_at = excluded.settled_at, settle_note = excluded.settle_note,
           json = excluded.json`,
      )
      .run(
        row.episode_id, row.at, row.as_of, row.symbol, row.timeframe, row.mode, row.thread_id, row.strategy_id,
        row.model_action, row.model_dir, row.council_dir, row.council_agree === null ? null : row.council_agree ? 1 : 0,
        row.mechanical_dir, row.mechanical_note, row.horizon_end_at,
        row.outcome_r_model, row.outcome_r_council, row.outcome_r_mechanical, row.outcome_source_model, row.regret_review,
        row.settled_at, row.settle_note, JSON.stringify(row),
      );
  }

  get(episodeId: string): JudgmentLedgerRow | null {
    const r = this.db.prepare('SELECT json FROM demo_judgment_ledger WHERE episode_id = ?').get(episodeId) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as JudgmentLedgerRow) : null;
  }

  /** 分页行,新的在前。给了 `cursor` 就走游标(WHERE (at, episode_id) < 游标),否则退回 offset。 */
  list(q: LedgerQuery = {}): JudgmentLedgerRow[] {
    const where: string[] = q.source === 'all' ? [] : ['source = ?'];
    const args: (string | number)[] = q.source === 'all' ? [] : [q.source ?? 'online'];
    if (q.since !== null && q.since !== undefined) {
      where.push('at >= ?');
      args.push(q.since);
    }
    if (q.strategy_id) {
      where.push('strategy_id = ?');
      args.push(q.strategy_id);
    }
    const cursor = q.cursor ? decodeLedgerCursor(q.cursor) : null;
    if (cursor) {
      where.push('(at < ? OR (at = ? AND episode_id < ?))');
      args.push(cursor.at, cursor.at, cursor.episode_id);
    }
    const limit = Math.min(500, Math.max(1, q.limit ?? 100));
    const sql = `SELECT json FROM demo_judgment_ledger ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, episode_id DESC LIMIT ?${cursor ? '' : ' OFFSET ?'}`;
    const rows = cursor
      ? (this.db.prepare(sql).all(...args, limit) as { json: string }[])
      : (this.db.prepare(sql).all(...args, limit, Math.max(0, q.offset ?? 0)) as { json: string }[]);
    return rows.map((r) => JSON.parse(r.json) as JudgmentLedgerRow);
  }

  count(q: Pick<LedgerQuery, 'since' | 'strategy_id' | 'source'> = {}): number {
    const where: string[] = q.source === 'all' ? [] : ['source = ?'];
    const args: (string | number)[] = q.source === 'all' ? [] : [q.source ?? 'online'];
    if (q.since !== null && q.since !== undefined) {
      where.push('at >= ?');
      args.push(q.since);
    }
    if (q.strategy_id) {
      where.push('strategy_id = ?');
      args.push(q.strategy_id);
    }
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM demo_judgment_ledger ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).get(...args) as { n: number };
    return Number(row.n);
  }

  /** horizon 已到、还没结算的行(最旧的先结)。 */
  pending(now: number, limit = 20): JudgmentLedgerRow[] {
    const rows = this.db
      .prepare('SELECT json FROM demo_judgment_ledger WHERE settled_at IS NULL AND horizon_end_at <= ? ORDER BY horizon_end_at ASC LIMIT ?')
      .all(now, Math.max(1, limit)) as { json: string }[];
    return rows.map((r) => JSON.parse(r.json) as JudgmentLedgerRow);
  }
}

// ---------------------------------------------------------------- runtime 接线(两处调用)

/** runtime 钩子:episode done 之后落一行。抛错由调用方吞掉——账本坏了不能影响交易。 */
export function recordJudgment(store: DemoStore, ep: Episode): JudgmentLedgerRow | null {
  const thread = ep.thread_id ? store.thread(ep.thread_id) : null;
  const row = ledgerRowFor(ep, thread);
  if (!row) return null;
  if (store.judgments.get(row.episode_id)) return null; // 已经记过(重跑/补写不覆盖已结算的行)
  store.judgments.save(row);
  return row;
}

/**
 * 09-12 跟单:一条带单员 open/add 信号的账本行(`source='trader'`)。
 *
 * 与 `ledgerRowFor` 的区别:这条腿的**方向来自带单员**,不是模型 —— 所以 `model_stance/model_dir`
 * 记的是信号的方向(它就是这条腿要被评分的那个表态)。gated 模式下 agent 那次判断另有自己的
 * `online` 行,两者共用同一个 `cluster_id`(线程 id / episode id),这样才能算出「agent 把关加了多少分」。
 * copy / evidence 模式没有 episode,主键用 `trader:<signal_id>` 占位(和 episode id 撞不上,重放也只一行)。
 *
 * `snapshot` 给 null(拿不到指标)时这一行落库但**永远不可评分** —— 那是「缺数据」,不是 0R。
 * 结算走现有那套 `settleJudgmentLedger`,不另开一条路。
 */
/**
 * 快照可用的最大滞后(P2-01):决策时刻比信号发布晚得超过这个数,就不给这一行配指标快照 ——
 * 手上那份特征是「现在」的,配上一个更早的时点就是前视。
 */
export const LEDGER_SNAPSHOT_MAX_LAG_MS = 10 * 60_000;

export function traderLedgerRow(inp: {
  signal_id: string;
  symbol: string;
  side: Direction | null;
  /** **决策时刻**(我们看到这条信号并作出处置的那一刻);反事实从这里往后走。 */
  at: number;
  /** 信号自己的发布时刻,只作留痕(它和 `at` 不是一回事,见 P2-01)。 */
  published_at?: number;
  /** 跟单那一刻的指标快照(反事实腿用它);拿不到传 null。 */
  snapshot: LedgerSnapshot | null;
  thread_id: string | null;
  episode_id: string | null;
  strategy_id?: string | null;
  note?: string;
}): JudgmentLedgerRow {
  const tf = inp.snapshot?.timeframe ?? null;
  const horizonMs = tf ? tfToMs(tf) * MECHANICAL_HORIZON_BARS : 0;
  return {
    source: 'trader',
    version: JUDGMENT_LEDGER_VERSION,
    episode_id: `trader:${inp.signal_id}`,
    at: inp.at,
    as_of: inp.at,
    symbol: inp.symbol,
    timeframe: tf,
    mode: 'scan',
    thread_id: inp.thread_id,
    // 同一簇(设计 §3:gated 的 agent 判断与跟单腿同 cluster_id)。
    // **episode 优先**:gated 那次 episode 刻意不开仓(线程由信号几何开),所以它的 `ledgerRowFor`
    // 落的是 `cluster_id = ep.id`。跟单腿要跟它对齐就必须也用 episode id;拿 thread_id 会把两条腿
    // 分进两个簇,「agent 把关加了多少分」就永远算不出来。copy/evidence 没有 episode 才退到线程/信号。
    cluster_id: inp.episode_id ?? inp.thread_id ?? `trader:${inp.signal_id}`,
    strategy_id: inp.strategy_id ?? null,
    model_action: inp.side === null ? null : 'PROPOSE',
    model_stance: inp.side === null ? 'unknown' : 'direction',
    model_dir: inp.side,
    council_stance: 'unknown',
    council_dir: null,
    council_agree: null,
    mechanical_dir: mechanicalDirection(inp.snapshot).direction,
    mechanical_note: mechanicalDirection(inp.snapshot).direction ? null : mechanicalDirection(inp.snapshot).note,
    horizon_end_at: inp.at + horizonMs,
    outcome_r_model: null,
    outcome_r_council: null,
    outcome_r_mechanical: null,
    outcome_source_model: null,
    regret_review: null,
    settled_at: null,
    settle_note: inp.snapshot ? (inp.note ?? null) : `跟单腿没有可用的指标快照(或信号早于决策太多),这一行不可评分${inp.note ? `(${inp.note})` : ''}`,
    settlement_status: null,
    realized: null,
    snapshot: inp.snapshot,
    review: null,
    legs: { model: null, council: null, mechanical: null },
    regret: null,
  };
}

/** `TfFeatures` → `LedgerSnapshot`(跟单腿没有 episode 的结构证据,只能从特征直接搭)。 */
export function snapshotFromFeatures(f: { tf: string; last_close: number; atr14: number; swing_high_20: number; swing_low_20: number } | null | undefined, h1?: { ema20: number; ema50: number } | null, mark: number | null = null): LedgerSnapshot | null {
  if (!f || !(f.atr14 > 0) || !(f.last_close > 0)) return null;
  return {
    timeframe: f.tf,
    last_close: f.last_close,
    mark,
    atr14: f.atr14,
    swing_high_20: Number.isFinite(f.swing_high_20) ? f.swing_high_20 : f.last_close,
    swing_low_20: Number.isFinite(f.swing_low_20) ? f.swing_low_20 : f.last_close,
    ema20_1h: h1?.ema20 ?? null,
    ema50_1h: h1?.ema50 ?? null,
  };
}

export interface LedgerSettleDeps {
  now?: number;
  /** 每轮最多结几行(每行一次 K 线请求)。 */
  limit?: number;
  fetchKlines: (symbol: string, tf: string, limit: number, endTime?: number) => Promise<Kline[]>;
  log?: (level: 'info' | 'warn', message: string, data?: unknown) => void;
}

export interface LedgerSettleResult {
  settled: number;
  waiting: number;
  errors: number;
}

/** runtime 巡检:到期未结算的行拉一次 K 线回填。零模型,只读公共行情。 */
export async function settleJudgmentLedger(store: DemoStore, deps: LedgerSettleDeps): Promise<LedgerSettleResult> {
  const now = deps.now ?? Date.now();
  const out: LedgerSettleResult = { settled: 0, waiting: 0, errors: 0 };
  // limit 只限「真去取 K 线结算」的行数。等线程结算的行不取 K 线、很便宜，跳过后继续往后看;
  // 否则最旧的几行若都属于一条还在持仓的线程(它每 15 分钟产生一条复查行),每轮都卡在同一批上，后面的扫描行晚结算一整天(2026-09-24 实测 177 行积压)。
  const budget = deps.limit ?? 5;
  for (const row of store.judgments.pending(now, Math.max(budget, 200))) {
    if (out.settled + out.errors >= budget) break;
    const thread = row.thread_id ? store.thread(row.thread_id) : null;
    // 线程还在跑 / 还没结算完:等一天再退回反事实,别把「结算中」记成反事实。
    if (thread && !(thread.status === 'closed' && thread.settlement) && now < row.horizon_end_at + MODEL_SETTLE_GRACE_MS) {
      out.waiting++;
      continue;
    }
    let bars: Kline[] = [];
    if (row.timeframe) {
      try {
        const tfMs = tfToMs(row.timeframe);
        bars = await deps.fetchKlines(row.symbol, row.timeframe, MECHANICAL_HORIZON_BARS + 10, row.horizon_end_at + tfMs);
      } catch (e) {
        out.errors++;
        deps.log?.('warn', `${row.symbol} 判断账本取 K 线失败:${(e as Error).message}`, { episode_id: row.episode_id });
        continue;
      }
    }
    const settled = settleRow(row, bars, thread, now);
    store.judgments.save(settled);
    out.settled++;
  }
  if (out.settled) deps.log?.('info', `判断账本结算 ${out.settled} 行${out.waiting ? `,${out.waiting} 行等线程结算` : ''}`);
  return out;
}
