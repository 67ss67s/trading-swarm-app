// 入场方式与挂单耐心(entry policy,2026-09-09,docs/design/limit-entry-and-patience-2026-09-09.md)。
//
// Jacky:「目前很多入场都是市价直接进,其实应该有限价进的,然后 agent 还能灵活判断订单要不要接着放着」。
//
// 两件事,都是**代码算证据 + 只拒不改**:
//   1. 入场方式:突破-回踩这类策略的规则本来就写着「回踩确认 → 市价;刚突破未回踩 → 限价挂回踩区」。
//      以前没人把这条规则代码化,模型就一路市价追。这里把它算成一条证据(建议 + 参考挂单区),
//      并给一个只会拒绝的闸:追得太远的市价单不许发,改限价等回踩。闸**不改价格**(改了就违反
//      AGENTS.md 第 4 条),只拒。
//   2. 挂单耐心:限价单挂上以后,复查时代码算「等了几根、离入场区多远、区间有没有被击穿后离开、
//      突破结构还在不在、量能有没有枯竭」,并给一个 cancel_warranted 的代码意见。撤单不动钱、
//      不改经济字段,所以挂单的 INVALIDATE 应该是常开的边(见 holding-policy 的 pending 放行)。
//
// 纯函数:不做 I/O、不调模型、不看时钟(now 由调用方传),eval/回放可以原样重放。

import { HORIZON_POLICY, threadHorizon, type StrategyHorizon } from './horizon.js';
import type { ScanChecklist } from './review-metrics.js';
import type { TfFeatures } from './market.js';
import type { Direction, Kline, StrategyThread } from './types.js';
import { flagLabel, noWord, yesWord } from './output-language.js';

export const ENTRY_POLICY_VERSION = 'entry-v1';

/**
 * free = 旧行为(模型自己选市价/限价);
 * prefer_limit(默认)= 追单太远的市价单被闸拒,只能限价等回踩;
 * limit_only = **市价开仓一律拒**(不看距离),唯一豁免是策略自己写了 `rules.entry_mode === 'market_ok'`。
 *   限价路径完全沿用现有的 tick 对齐 / 挂单耐心 / 撤单链,这一档只改「市价能不能用」。
 */
export type EntryStyle = 'free' | 'prefer_limit' | 'limit_only';

/**
 * 市价单允许的最大追单距离(ATR)。策略自己的「不追」上限是 1.5 ATR(chase_atr_max),而市价单拿的是
 * 最坏的那一档成交,所以给它三分之二:超过 1 ATR 的市价开仓算追单,闸会拒。
 * **闸只认这一条客观距离**;「回踩没确认」只影响建议与提示词,不硬拦——价就贴在突破位上时市价没有错。
 */
export const MARKET_CHASE_ATR = 1;

// ---------------------------------------------------------------- 1. 入场方式建议(扫描时)

export interface EntryStyleAdvice {
  /** 代码建议的入场方式;模型可以不听(free 模式),但要在理由里说明。 */
  recommended: 'market' | 'limit';
  /** 建议的限价区间(十进制字符串);算不出来时 null,此时不要求模型给区间。 */
  zone: [string, string] | null;
  /** 现价距突破位多少个 ATR(null = 清单没给)。 */
  dist_to_break_atr: number | null;
  /** 算这条建议时用的可执行价 —— 闸判 marketable limit 要拿它当基准(09-12 P1-07)。 */
  mark: number;
  /** **冻结**的突破位与 ATR:发送前重测距用同一个基准,不现算(现算会跟着行情漂)。算不出来为 null。 */
  breakout_level: number | null;
  atr: number | null;
  /** 算这条建议时那条策略的 `rules.entry_mode`;`limit_only` 下只有 `'market_ok'` 才放行市价。 */
  entry_mode: 'market_ok' | null;
  retest_confirmed: boolean;
  /** prefer_limit 模式下市价单会不会被闸拒。 */
  market_blocked: boolean;
  reason: string;
  text: string;
}

/** 现价距「这根之前」20 根极值的距离,单位 ATR;方向缺失或数据不足时 null。 */
export function distToBreakAtr(base: TfFeatures | undefined, side: Direction | null): number | null {
  if (!base || !side || !(base.atr14 > 0)) return null;
  const level = side === 'long' ? (base.swing_high_20_prev ?? base.swing_high_20) : (base.swing_low_20_prev ?? base.swing_low_20);
  return Number.isFinite(level) && level > 0 ? Math.abs(base.last_close - level) / base.atr14 : null;
}

/**
 * 价格**越过**突破位多少 ATR(带符号):做多 (px - level)/atr,做空 (level - px)/atr。正数 = 已经追出去,
 * 负数 = 还在突破位不利侧(做多在下方),那不是追单。「追」只有一个方向,判追单一律用这个,
 * 别拿 {@link distToBreakAtr} 的绝对值判(09-28:做多挂在自己给的回踩区里,被绝对距离判成追单撤掉)。
 */
export function chaseBeyondAtr(px: number, level: number | null, atr: number | null, side: Direction | null): number | null {
  if (!side || level === null || !Number.isFinite(level) || !(level > 0) || atr === null || !(atr > 0) || !(px > 0)) return null;
  return (side === 'long' ? px - level : level - px) / atr;
}

const dp = (n: number): number => (n > 100 ? 1 : n > 1 ? 3 : 6);
const fmt = (n: number, ref: number): string => n.toFixed(dp(ref));

export interface EntryStyleInputs {
  side: Direction | null;
  /** 该策略 horizon 的入场区宽度参考(ATR 倍数);缺省用 intraday。 */
  horizon: StrategyHorizon | null;
  checklist: ScanChecklist | null;
  /** 主周期特征(EMA20 / ATR / 突破位都从这里取)。 */
  base: TfFeatures | undefined;
  mark: number;
  style: EntryStyle;
  /** 这条策略的 `rules.entry_mode`(`limit_only` 的唯一豁免);不给 = 不豁免。 */
  entry_mode?: 'market_ok' | null;
}

/**
 * 建议市价还是限价。口径完全跟着 breakout_retest 的规则:
 * 回踩已确认(收在突破位外侧且放量)→ 市价可用;否则价离突破位越远越该挂限价等回踩。
 * 限价区间 = 突破位与 EMA20 之间那一段,再按 horizon 的 entry_zone_atr 收窄,永远落在现价的**不利侧**
 * (做多挂在现价下方),这样挂单才有等到的意义。
 */
export function entryStyleAdvice(inp: EntryStyleInputs): EntryStyleAdvice {
  const chk = inp.checklist;
  const base = inp.base;
  const retest = chk?.retest_confirmed ?? false;
  // 距突破位的距离**自己算**,量到「这根之前」的 20 根极值。09-27 之前清单里的 dist_to_break_atr 量的是含当根的
  // swing_high_20/low_20(刚突破的那根自己就是极值,距离恒等于 0,拿它当追单判据等于闸永不触发);现在
  // scanChecklist 也量到 _prev,两边同口径。这里仍自己算,是因为 side 可能与清单的趋势方向不同。特征缺失时退回清单的数。
  const dist = distToBreakAtr(base, inp.side) ?? chk?.dist_to_break_atr ?? null;
  const zoneAtr = HORIZON_POLICY[inp.horizon ?? 'intraday'].entry_zone_atr;
  // 追单只看有利侧:做多价在突破位下方不算追。特征缺失、只剩清单那个不带方向的数时,照旧按它判。
  const beyondLevel = base && inp.side ? (inp.side === 'long' ? (base.swing_high_20_prev ?? base.swing_high_20) : (base.swing_low_20_prev ?? base.swing_low_20)) : null;
  const beyond = base ? chaseBeyondAtr(base.last_close, beyondLevel, base.atr14, inp.side) : null;
  const chase = beyond ?? chk?.dist_to_break_atr ?? null;
  const belowBreak = beyond !== null && beyond < 0;
  const far = chase !== null && chase > MARKET_CHASE_ATR;
  const recommended: 'market' | 'limit' = inp.style === 'limit_only' && inp.entry_mode !== 'market_ok' ? 'limit' : retest && !far ? 'market' : 'limit';
  // 拒绝要有客观依据:距离算不出来时不拦(证据缺失不是拒单理由)。
  // limit_only 是另一条口径:不看距离,市价本身就不许用,除非策略规则写了 market_ok。
  const marketOk = inp.entry_mode === 'market_ok';
  const marketBlocked = inp.style === 'limit_only' ? !marketOk : inp.style === 'prefer_limit' && far;
  let zone: [string, string] | null = null;
  if (base && inp.side && base.atr14 > 0 && inp.mark > 0) {
    const level = inp.side === 'long' ? (base.swing_high_20_prev ?? base.swing_high_20) : (base.swing_low_20_prev ?? base.swing_low_20);
    const width = zoneAtr * base.atr14;
    // 锚 = 现价**不利侧**最近的那个结构位(做多:现价下方的突破位/EMA20 里最高的一个);两个都在有利侧
    // 时退化成现价本身,区间就贴着现价的不利侧铺开——挂单永远不会挂在「现在就能成交」的一侧。
    const structural = [level, base.ema20].filter((x) => Number.isFinite(x) && x > 0);
    const usable = inp.side === 'long' ? structural.filter((x) => x <= inp.mark) : structural.filter((x) => x >= inp.mark);
    const anchor = usable.length ? (inp.side === 'long' ? Math.max(...usable) : Math.min(...usable)) : inp.mark;
    const low = inp.side === 'long' ? anchor - width / 2 : Math.max(inp.mark, anchor - width / 2);
    const high = inp.side === 'long' ? Math.min(inp.mark, anchor + width / 2) : anchor + width / 2;
    // 靠近现价的那一端必须严格在现价不利侧,取整也朝不利方向取:以前 >100 的价只留 1 位小数,SOL 现价 121.09 时
    // 上沿被四舍五入成 121.1,模型按规则挂在上沿就立刻成交,被入场方式检查当成追单拒掉(09-27 评审站两次)
    const unit = 10 ** -dp(inp.mark);
    let lo = low, hi = high;
    if (inp.side === 'long') { hi = Math.floor(hi / unit + 1e-9) * unit; if (hi >= inp.mark) hi -= unit; lo = Math.floor(lo / unit + 1e-9) * unit; }
    else { lo = Math.ceil(lo / unit - 1e-9) * unit; if (lo <= inp.mark) lo += unit; hi = Math.ceil(hi / unit - 1e-9) * unit; }
    if (hi > 0 && lo > 0 && hi - lo > unit / 2) zone = [fmt(lo, inp.mark), fmt(hi, inp.mark)];
  }
  const reason = retest
    ? far
      ? `回踩已确认但已走出 ${dist!.toFixed(2)} ATR(市价上限 ${MARKET_CHASE_ATR}),追单成本过高`
      : '回踩已确认且离突破位不远,市价可用'
    : dist === null
      ? '清单没给突破距离,按限价等回踩更稳'
      : belowBreak
        ? `还没越过突破位(在${inp.side === 'long' ? '下' : '上'}方 ${dist.toFixed(2)} ATR,不算追单),按策略规则应挂限价等回踩`
        : `回踩未确认(距突破位 ${dist.toFixed(2)} ATR),按策略规则应挂限价等回踩`;
  const text = [
    `建议入场方式=${recommended === 'market' ? '市价' : '限价'}`,
    `${flagLabel('回踩确认')}${retest ? yesWord() : noWord()}`,
    `距突破位 ${dist === null ? 'n/a' : `${dist.toFixed(2)} ATR`}${belowBreak ? `(还在突破位${inp.side === 'long' ? '下' : '上'}方,不算追单)` : ''}(市价上限 ${MARKET_CHASE_ATR} ATR)`,
    zone ? `参考挂单区 ${zone[0]}–${zone[1]}(${zoneAtr} ATR 宽,现价 ${fmt(inp.mark, inp.mark)})` : '参考挂单区不可得',
    marketBlocked ? (inp.style === 'limit_only' ? '本档是 limit_only:市价开仓一律被「入场方式」闸拒绝(这条策略没写 entry_mode=market_ok),请给 limit + limit_price' : '本次市价单会被「入场方式」闸拒绝(已追出上限),请给 limit + limit_price') : recommended === 'limit' ? '市价不会被拦,但按策略规则这里更该挂限价等回踩' : '市价与限价都允许',
    reason,
  ].join(';');
  const frozenLevel = base && inp.side ? (inp.side === 'long' ? (base.swing_high_20_prev ?? base.swing_high_20) : (base.swing_low_20_prev ?? base.swing_low_20)) : null;
  return {
    recommended,
    zone,
    dist_to_break_atr: dist,
    mark: inp.mark,
    breakout_level: frozenLevel !== null && Number.isFinite(frozenLevel) && frozenLevel > 0 ? frozenLevel : null,
    atr: base && base.atr14 > 0 ? base.atr14 : null,
    entry_mode: inp.entry_mode ?? null,
    retest_confirmed: retest,
    market_blocked: marketBlocked,
    reason,
    text,
  };
}

/** 提议那一刻冻结下来的测距基准:结构位 + ATR + 当时的可执行价。 */
export interface FrozenEntryBasis {
  breakout_level: number | null;
  atr: number | null;
  mark: number;
  at: number;
}

/**
 * 09-12 P1-07:按**最终**方向从冻结特征里取结构位与 ATR。扫描时那份建议用的是模型之前的
 * 「breakout/第一条策略 + 趋势方向」;模型最后可能选了另一条策略、另一个方向,冻结基准必须跟着它重算一次。
 * 纯函数:特征从哪个周期来、截到哪一根,由调用方决定(发送前不再现算,否则基准会跟着行情漂)。
 */
export function freezeEntryBasis(base: TfFeatures | undefined | null, side: Direction | null, mark: number, at: number): FrozenEntryBasis | null {
  if (!base || !side) return null;
  const level = side === 'long' ? (base.swing_high_20_prev ?? base.swing_high_20) : (base.swing_low_20_prev ?? base.swing_low_20);
  return {
    breakout_level: Number.isFinite(level) && level > 0 ? level : null,
    atr: base.atr14 > 0 ? base.atr14 : null,
    mark,
    at,
  };
}

// ---------------------------------------------------------------- 1b. 限价单的两种身份(09-12 P1-07)

/**
 * **`entry='limit'` 这个枚举值本身不证明任何事**。做多挂在现价**之上**的限价单会立刻以对手价成交,
 * 它是一张换了名字的市价单(marketable limit);只有挂在现价不利侧、要等价格回来才成交的那种
 * (waiting limit)才兑现了「挂回踩区等」的语义。时机未确认(council entry_timing=pending)时只许后者。
 *
 * `unknown_limit` = 没给限价、价格解析不出来、或可执行价不新鲜 —— **不能证明它是等待型**,pending 下按 fail closed 处理。
 */
export type EntryOrderKind = 'market' | 'marketable_limit' | 'waiting_limit' | 'unknown_limit';

export function classifyEntryOrder(entry: 'market' | 'limit', limitPrice: string | null | undefined, mark: number, side: Direction | null): EntryOrderKind {
  if (entry === 'market') return 'market';
  const p = limitPrice === null || limitPrice === undefined || limitPrice === '' ? NaN : Number(limitPrice);
  if (!side || !(mark > 0) || !Number.isFinite(p) || p <= 0) return 'unknown_limit';
  // 做多:限价 ≥ 现价 → 立刻成交;做空:限价 ≤ 现价 → 立刻成交。等号算 marketable(贴着盘口就是吃单)。
  return side === 'long' ? (p >= mark ? 'marketable_limit' : 'waiting_limit') : p <= mark ? 'marketable_limit' : 'waiting_limit';
}

/** 「新鲜可执行价」的默认保质期:超过这么久的 mark 不能用来判 marketable。 */
export const FRESH_PRICE_MAX_AGE_MS = 30_000;

export interface FinalEntryInputs {
  /** **最终**方向(模型选完策略/方向之后的那个),不是扫描时先算好的建议方向。 */
  side: Direction | null;
  entry: 'market' | 'limit';
  limit_price: string | null;
  /** 发送前重新取的可执行价(mark/last)。 */
  mark: number;
  /** 这个价是什么时候取的;给了就按 {@link FRESH_PRICE_MAX_AGE_MS} 判新鲜度。 */
  mark_at?: number | null;
  now?: number;
  /** **冻结**的突破位:提议那一刻算出来的结构位,不要发送前现算(现算会跟着行情漂,口径就换了)。 */
  breakout_level: number | null;
  /** 同一时刻冻结的 ATR。 */
  atr: number | null;
  /** 议会最终的入场时机裁决;只有 require 模式才传,advise/off 传 null。 */
  entry_timing: 'confirmed' | 'pending' | 'failed' | null;
  style: EntryStyle;
  /** 最终那条策略的 `rules.entry_mode`;`limit_only` 下只有 `'market_ok'` 才允许市价。 */
  entry_mode?: 'market_ok' | null;
  max_chase_atr?: number;
}

export interface FinalEntryCheck {
  passed: boolean;
  kind: EntryOrderKind;
  /** 实际要成交的那个价距冻结突破位多少 ATR(市价/marketable 用现价,等待型用限价);算不出来为 null。 */
  dist_atr: number | null;
  code: 'ok' | 'timing_failed' | 'stale_mark' | 'market_under_pending' | 'marketable_limit_under_pending' | 'unproven_limit_under_pending' | 'chase_too_far' | 'waiting_limit_too_far' | 'market_not_allowed';
  reason: string;
}

/**
 * **发送前的最终测距**(09-12 P1-07)。扫描时的 `entryStyleAdvice` 用的是「模型之前的 breakout/第一条策略」
 * 的方向和那一刻的收盘价;模型最后可能选了另一条策略、另一个方向,价格也走了。所以下单前必须按
 * **最终策略/方向 + 冻结的突破位 + 新鲜可执行价**重测一次,并且把限价单的两种身份分开处理:
 *  - marketable limit(做多挂在现价之上)= 市价绕过:时机 pending 时拒,追出上限时按市价同样拒;
 *  - waiting limit(挂在不利侧等回踩)= 时机 pending 允许,但**它自己的挂单价**也要在追单上限内,
 *    否则那只是「提前挂在追高位置」,换个枚举值照样追。
 * 只拒不改价(AGENTS.md 第 4 条)。距离算不出来时不拿距离拒单(证据缺失不是拒单理由),但
 * pending + 身份证明不了(没给限价/价格不新鲜)时 fail closed。
 */
export function finalEntryCheck(inp: FinalEntryInputs): FinalEntryCheck {
  const maxChase = inp.max_chase_atr ?? MARKET_CHASE_ATR;
  const fresh = inp.mark_at === null || inp.mark_at === undefined || inp.now === undefined ? inp.mark > 0 : inp.mark > 0 && inp.now - inp.mark_at <= FRESH_PRICE_MAX_AGE_MS;
  const kind = fresh ? classifyEntryOrder(inp.entry, inp.limit_price, inp.mark, inp.side) : inp.entry === 'market' ? 'market' : 'unknown_limit';
  const limit = inp.limit_price === null ? NaN : Number(inp.limit_price);
  const px = kind === 'waiting_limit' && Number.isFinite(limit) ? limit : inp.mark;
  const level = inp.breakout_level;
  const atr = inp.atr;
  const dist = level !== null && Number.isFinite(level) && level > 0 && atr !== null && atr > 0 && px > 0 ? Math.round((Math.abs(px - level) / atr) * 100) / 100 : null;
  // dist_atr 保持原来的绝对距离(日志/理由里读它);追单只认有利侧越过的距离,做多在突破位下方不是追。
  const beyond = chaseBeyondAtr(px, level, atr, inp.side);
  const far = dist !== null && beyond !== null && Math.round(beyond * 100) / 100 > maxChase;
  const pending = inp.entry_timing === 'pending';
  const reject = (code: FinalEntryCheck['code'], reason: string): FinalEntryCheck => ({ passed: false, kind, dist_atr: dist, code, reason });
  if (inp.entry_timing === 'failed') return reject('timing_failed', '入场时机判据已经不成立(不是「还没到」而是「过了/坏了」),不许开仓');
  // 09-12 P1-07:市价单成交在**现价**上,价不新鲜就等于闭着眼睛下单 —— 时机 confirmed 也一样拒。
  // (拿不到取价时刻时不判新鲜度:证据缺失不是拒单理由,由上游的行情过期闸兜底。)
  if (inp.entry === 'market' && !fresh && inp.mark_at !== null && inp.mark_at !== undefined && inp.now !== undefined) {
    return reject('stale_mark', `市价开仓要求可执行价新鲜:${inp.mark > 0 ? `这个价已经是 ${inp.now - inp.mark_at}ms 之前的(上限 ${FRESH_PRICE_MAX_AGE_MS}ms)` : '取不到可执行价'},拒`);
  }
  if (inp.style === 'limit_only' && (kind === 'market' || kind === 'marketable_limit') && inp.entry_mode !== 'market_ok') {
    return reject('market_not_allowed', `limit_only:${kind === 'market' ? '市价' : `限价 ${inp.limit_price} 会立刻成交,等同市价`}开仓一律拒(该策略规则没有 entry_mode=market_ok)`);
  }
  if (kind === 'market' && pending) return reject('market_under_pending', '方向成立但回踩未确认:只许挂等待型限价,市价拒');
  if (kind === 'marketable_limit' && pending) return reject('marketable_limit_under_pending', `限价 ${inp.limit_price} 在现价 ${inp.mark} 的${inp.side === 'long' ? '上' : '下'}方,会立刻成交(marketable limit = 市价绕过);回踩未确认只许挂在不利侧等`);
  if (kind === 'unknown_limit' && pending) return reject('unproven_limit_under_pending', `回踩未确认时必须证明这是等待型限价:${fresh ? '没有可用的限价' : `可执行价不新鲜(${inp.now! - inp.mark_at!}ms > ${FRESH_PRICE_MAX_AGE_MS}ms)`},按 fail closed 拒`);
  if (inp.style === 'prefer_limit' && far) {
    if (kind === 'market' || kind === 'marketable_limit') return reject('chase_too_far', `${kind === 'market' ? '市价' : '立刻成交的限价'}追单被拒:成交价 ${px} 距冻结突破位 ${level} 已 ${dist!.toFixed(2)} ATR,超过上限 ${maxChase} ATR`);
    if (kind === 'waiting_limit') return reject('waiting_limit_too_far', `等待型限价挂得太远:挂单价 ${inp.limit_price} 距冻结突破位 ${level} 有 ${dist!.toFixed(2)} ATR,超过上限 ${maxChase} ATR —— 换成限价不等于没在追`);
  }
  const sideNote = beyond !== null && beyond < 0 ? `,还在突破位${inp.side === 'long' ? '下' : '上'}方,不算追单` : '';
  return { passed: true, kind, dist_atr: dist, code: 'ok', reason: `${kind === 'market' ? '市价' : kind === 'waiting_limit' ? '等待型限价' : kind === 'marketable_limit' ? '立刻成交的限价' : '限价(身份未证明)'}:距冻结突破位 ${dist === null ? 'n/a' : `${dist.toFixed(2)} ATR`}${sideNote}(追单上限 ${maxChase})${pending ? ',时机待回踩' : ''}` };
}

/**
 * 只拒不改的代码闸:prefer_limit 模式下,回踩未确认或已追太远的**市价**开仓一律拒;
 * 09-12 P1-07 起,**立刻成交的限价单**(做多挂在现价之上)与市价单同等对待 —— 否则 `entry='limit'`
 * 这个枚举值就是一条免检通道。
 */
export function entryStyleGate(
  j: { action: string; proposal: { entry: 'market' | 'limit'; limit_price?: string | null; direction?: Direction | null } | null; direction?: Direction | null },
  advice: EntryStyleAdvice | null,
  style: EntryStyle,
  opts: { entry_mode?: 'market_ok' | null } = {},
): { passed: boolean; reason: string } {
  if (style === 'free' || j.action !== 'PROPOSE' || !j.proposal) return { passed: true, reason: style === 'free' ? '入场方式不限制(free)' : '非开仓动作' };
  // limit_only:不看距离,也不需要 advice —— 市价本身就不许用,除非这条策略的规则写了 entry_mode=market_ok。
  if (style === 'limit_only') {
    if (j.proposal.entry !== 'market') return { passed: true, reason: 'limit_only:限价入场' };
    // 显式传了 entry_mode 就以它为准(最终策略可能不是扫描时算建议的那一条);没传才退回建议里那份。
    const marketOk = ('entry_mode' in opts ? opts.entry_mode ?? null : advice?.entry_mode ?? null) === 'market_ok';
    return marketOk
      ? { passed: true, reason: 'limit_only:该策略规则写了 entry_mode=market_ok,市价放行' }
      : { passed: false, reason: 'limit_only:市价开仓一律拒(该策略规则没有 entry_mode=market_ok);请给 entry="limit" + limit_price,挂单的对齐/耐心/撤单链照旧' };
  }
  if (!advice) return { passed: true, reason: '没有入场方式证据,不拦' };
  if (j.proposal.entry !== 'market') {
    if (!advice.market_blocked) return { passed: true, reason: '限价入场' };
    const side = j.proposal.direction ?? j.direction ?? null;
    const kind = classifyEntryOrder('limit', j.proposal.limit_price, advice.mark, side);
    if (kind !== 'marketable_limit') return { passed: true, reason: `限价入场(${kind === 'waiting_limit' ? '挂在现价不利侧等回踩' : '身份未证明,距离闸不拦'})` };
    return { passed: false, reason: `限价 ${j.proposal.limit_price} 在现价 ${advice.mark} 的${side === 'long' ? '上' : '下'}方会立刻成交,等同市价追单:距突破位 ${advice.dist_to_break_atr?.toFixed(2) ?? '?'} ATR 已超过上限 ${MARKET_CHASE_ATR} ATR;改挂回踩区(参考 ${advice.zone ? `${advice.zone[0]}–${advice.zone[1]}` : '按结构自定'})` };
  }
  if (!advice.market_blocked) return { passed: true, reason: advice.reason };
  return { passed: false, reason: `市价追单被拒:距突破位 ${advice.dist_to_break_atr?.toFixed(2) ?? '?'} ATR 已超过市价上限 ${MARKET_CHASE_ATR} ATR;改挂限价(参考区 ${advice.zone ? `${advice.zone[0]}–${advice.zone[1]}` : '按结构自定'})` };
}

// ---- 十进制定点(BigInt)工具:价格/tick 都是十进制字符串,不能用 float 做网格运算。
// 旧实现用 `p / tick` 再 floor/ceil + 1e-9 容差:1234567890.1 / 0.1 = 12345678900.999998,容差救不回来,
// 做多会退掉一整个 tick;极小 tick(1e-8)上同样量级的误差直接把价格挪出网格。

const DEC_RE = /^\s*([+-]?)(\d*)(?:\.(\d*))?\s*$/;

/** 十进制字符串 → 以 10^scale 为单位的整数;负数/非法/指数记法返回 null(调用方 fail closed)。 */
function toScaled(s: string, scale: number): bigint | null {
  const m = DEC_RE.exec(s);
  if (!m) return null;
  const [, sign, int = '', frac = ''] = m;
  if (sign === '-') return null;
  if (!int && !frac) return null;
  if (frac.length > scale) return null;
  return BigInt((int || '0') + frac.padEnd(scale, '0'));
}

/** 小数位数(尾零不算):"0.100" → 1,"100" → 0。 */
function fracDigits(s: string): number {
  const m = DEC_RE.exec(s);
  if (!m) return 0;
  return (m[3] ?? '').replace(/0+$/, '').length;
}

/** 以 10^scale 为单位的整数 → 保留 decimals 位小数的十进制字符串(scale ≥ decimals,且末尾多余位必为 0)。 */
function fromScaled(v: bigint, scale: number, decimals: number): string {
  const digits = v.toString().padStart(scale + 1, '0');
  const int = digits.slice(0, digits.length - scale);
  const frac = scale > 0 ? digits.slice(digits.length - scale) : '';
  return decimals > 0 ? `${int}.${frac.slice(0, decimals).padEnd(decimals, '0')}` : int;
}

/**
 * 交易所价格网格对齐:做多向下取、做空向上取(取到对自己更有利的一格),永远不越过网格。
 * 全程 BigInt 整数运算(缩放到 price/tick 两者小数位的较大者),极端价与极小 tick 都不会退错一格。
 * 非法输入(负数、非十进制、tick ≤ 0)或对齐后 ≤ 0 时**原样返回**,由上游的价格闸/交易所 filter 决定拒不拒。
 */
export function alignLimitPrice(price: string, tickSize: string, side: Direction): string {
  const scale = Math.max(fracDigits(price), fracDigits(tickSize), (DEC_RE.exec(price)?.[3] ?? '').length, (DEC_RE.exec(tickSize)?.[3] ?? '').length);
  const p = toScaled(price, scale);
  const t = toScaled(tickSize, scale);
  if (p === null || t === null || p <= 0n || t <= 0n) return price;
  const units = side === 'long' ? p / t : (p + t - 1n) / t; // 正数:整除即 floor
  const aligned = units * t;
  if (aligned <= 0n) return price;
  const decimals = fracDigits(tickSize);
  return fromScaled(aligned, scale, decimals);
}

// ---------------------------------------------------------------- 2. 挂单耐心(复查时)

export interface PendingEntryMetrics {
  /** 已经等了几根 horizon 复查周期的 K 线。 */
  bars_waited: number;
  minutes_waited: number;
  max_wait_bars: number;
  /** 现价在入场区里吗(没有区间时按 ±0.1% 判)。 */
  in_zone: boolean;
  /** 现价距入场区最近一端多少个 ATR;在区间内为 0;ATR 不可得时 null。 */
  dist_to_zone_atr: number | null;
  /** 价格已经穿过入场区到**有利侧**并离开(单子没吃到、行情走了)。 */
  ran_away: boolean;
  /** 收盘已经跌回突破位的另一侧:这次突破的结构没了。 */
  structure_gone: boolean | null;
  /** 最近几根的量比中位数低于 1 = 量能枯竭,回踩没人接。 */
  volume_dry: boolean | null;
  /** 代码意见:继续挂着不再合理。模型仍可 HOLD,但要写理由。 */
  cancel_warranted: boolean;
  reasons: string[];
  text: string;
}

export interface PendingEntryInputs {
  now: number;
  thread: StrategyThread;
  mark: number;
  /** 复查周期名(reviewTimeframe);K 线与特征都从这里取,必须与 tf_ms 同源。 */
  tf: string;
  /** 复查周期的一根毫秒数。 */
  tf_ms: number;
  features: TfFeatures[];
  klines: Record<string, Kline[]>;
  /** 超过这么多根还没成交就认为入场窗口过去了(workflow.entry_max_wait_bars)。 */
  max_wait_bars: number;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

export function pendingEntryMetrics(inp: PendingEntryInputs): PendingEntryMetrics | null {
  const t = inp.thread;
  if (t.status !== 'pending_entry' || !(inp.mark > 0)) return null;
  // 只有「已经挂在交易所、还没成交」的限价单才谈得上耐心:
  //  - 市价单停在 pending_entry 说明只拿到 ACK 还没查到成交,那是**查单**的问题,撤单只会把仓位状态弄得更不清楚;
  //  - 调用还在飞(entry_submitting_since)时撤单会被 runtime 拒,给模型看「该撤了」等于制造一次必然失败的动作。
  if (t.entry.type !== 'limit' || typeof t.entry_submitting_since === 'number') return null;
  // 09-12 P1-07:耐心从**挂单真的有 CID**那一刻起算,不是线程创建时间 —— 提议到发送之间的排队/审批
  // 不该算进「这张单等了几根」。还没有 CID 的线程根本没在交易所上等,不出度量。
  if (!t.entry_client_order_id) return null;
  const tf = inp.tf;
  const base = inp.features.find((f) => f.tf === tf) ?? inp.features[0];
  const atr = base && base.atr14 > 0 ? base.atr14 : null;
  const waitedMs = Math.max(0, inp.now - (t.entry_submitted_at ?? t.created_at));
  const bars = inp.tf_ms > 0 ? Math.floor(waitedMs / inp.tf_ms) : 0;
  const zone = t.entry.zone;
  const entry = t.entry.price ? Number(t.entry.price) : null;
  const lo = zone ? Number(zone[0]) : entry;
  const hi = zone ? Number(zone[1]) : entry;
  const inZone = lo !== null && hi !== null && Number.isFinite(lo) && Number.isFinite(hi) ? (zone ? inp.mark >= Math.min(lo, hi) && inp.mark <= Math.max(lo, hi) : Math.abs(inp.mark - lo) / lo <= 0.001) : false;
  const distAtr = atr !== null && lo !== null && hi !== null && Number.isFinite(lo) && Number.isFinite(hi) ? (inZone ? 0 : Math.min(Math.abs(inp.mark - Math.min(lo, hi)), Math.abs(inp.mark - Math.max(lo, hi))) / atr) : null;
  // 跑掉 = 价格已经到入场区的有利侧(做多:高于区间上沿)且离开了 1 个 ATR 以上。
  const ranAway = !inZone && distAtr !== null && hi !== null && lo !== null && distAtr >= 1 && (t.side === 'long' ? inp.mark > Math.max(lo, hi) : inp.mark < Math.min(lo, hi));
  // 结构没了 = 最近一根已收盘 K 线收回突破位的另一侧(做多:收在 20 根低点下方那一侧的反面判据用 EMA20 兜底)。
  const closed = (inp.klines[tf] ?? []).filter((b) => b.close_time <= inp.now);
  const lastClose = closed.length ? Number(closed[closed.length - 1]!.close) : null;
  const level = base ? (t.side === 'long' ? (base.swing_high_20_prev ?? base.swing_high_20) : (base.swing_low_20_prev ?? base.swing_low_20)) : null;
  const structureGone = lastClose === null || level === null || !Number.isFinite(level) ? null : t.side === 'long' ? lastClose < Math.min(level, base!.ema20) : lastClose > Math.max(level, base!.ema20);
  const recentVol = closed.slice(-3).map((b) => Number(b.volume)).filter((v) => Number.isFinite(v) && v > 0);
  const olderVol = closed.slice(-23, -3).map((b) => Number(b.volume)).filter((v) => Number.isFinite(v) && v > 0);
  const mRecent = median(recentVol);
  const mOlder = median(olderVol);
  const volumeDry = mRecent === null || mOlder === null || mOlder <= 0 ? null : mRecent / mOlder < 0.6;
  const reasons: string[] = [];
  if (bars >= inp.max_wait_bars) reasons.push(`已等 ${bars} 根 ${tf},超过上限 ${inp.max_wait_bars} 根`);
  if (ranAway) reasons.push(`价格已越过入场区 ${distAtr!.toFixed(2)} ATR 并离开,这单等不到了`);
  if (structureGone === true) reasons.push('最近收盘已回到突破位另一侧,这次突破的结构没了');
  const cancel = reasons.length > 0;
  const text = [
    `已等 ${bars} 根 ${tf}(${Math.round(waitedMs / 60_000)} 分钟,上限 ${inp.max_wait_bars} 根)`,
    `现价 ${inZone ? '在' : '不在'}入场区${zone ? ` ${zone[0]}–${zone[1]}` : t.entry.price ? ` ${t.entry.price}` : ''}`,
    `距入场区 ${distAtr === null ? 'n/a' : `${distAtr.toFixed(2)} ATR`}`,
    `${flagLabel('已跑掉')}${ranAway ? yesWord() : noWord()}`,
    `突破结构=${structureGone === null ? 'n/a' : structureGone ? '已失效' : '仍在'}`,
    `${flagLabel('量能枯竭')}${volumeDry === null ? 'n/a' : volumeDry ? yesWord() : noWord()}`,
    `代码意见=${cancel ? `撤单更合理(${reasons.join(';')})` : '继续挂着仍然合理'}`,
    '撤单不动钱、不改任何已批准的价格;继续等还是撤由你按上面这几项判断,不要凭单根噪声撤单。',
  ].join(';');
  return { bars_waited: bars, minutes_waited: Math.round(waitedMs / 60_000), max_wait_bars: inp.max_wait_bars, in_zone: inZone, dist_to_zone_atr: distAtr === null ? null : Math.round(distAtr * 100) / 100, ran_away: ranAway, structure_gone: structureGone, volume_dry: volumeDry, cancel_warranted: cancel, reasons, text };
}

/**
 * 挂单的复查节奏:入场窗口的寿命和持有周期无关(swing 策略的回踩也就那几根),所以挂单**最慢按 1 小时**
 * 一次,而不是跟着 horizon 走到 4h / 24h。scalp 仍然每次都过。
 */
export const PENDING_REVIEW_MAX_MS = 3_600_000;

export function pendingReviewDue(t: StrategyThread, now: number, last: number): boolean {
  if (t.status !== 'pending_entry') return false;
  const h = threadHorizon(t);
  if (h === 'scalp') return true;
  const anchor = Math.max(last, t.created_at);
  return now - anchor >= PENDING_REVIEW_MAX_MS;
}

/** 价格逼近或刚离开入场区 → 值得立刻叫醒一次(挂单版的 nearProtection)。 */
export function nearEntryZone(t: StrategyThread, mark: number, atr: number): string | null {
  if (t.status !== 'pending_entry' || !(mark > 0)) return null;
  const zone = t.entry.zone;
  const entry = t.entry.price ? Number(t.entry.price) : null;
  const lo = zone ? Math.min(Number(zone[0]), Number(zone[1])) : entry;
  const hi = zone ? Math.max(Number(zone[0]), Number(zone[1])) : entry;
  if (lo === null || hi === null || !Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const band = Math.max(atr > 0 ? atr * 0.3 : 0, mark * 0.0005);
  if (mark >= lo - band && mark <= hi + band) return `价格 ${mark} 已进入入场区附近 ${lo}–${hi}`;
  const away = t.side === 'long' ? mark - hi : lo - mark;
  if (atr > 0 && away >= atr) return `价格 ${mark} 已越过入场区 ${(away / atr).toFixed(2)} ATR`;
  return null;
}
