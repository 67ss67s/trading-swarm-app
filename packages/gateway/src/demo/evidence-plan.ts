/**
 * 自定义证据的「装载计划」(设计 §4;契约 §9.27 附)。
 *
 * 以前每次判断装的是**固定一套**证据,谁也说不清模型为什么看到了 Ichimoku 却没看到 MFI。
 * 现在:每条启用策略在 `StrategySpec.evidence` 里声明自己要什么,这里把它们**取并集**,
 * 每条证据带 `required_by`(哪几条策略要它)。没有策略要的指标**不进 prompt**——省 token,
 * 也让「模型看到了什么」变成一个可回答的问题。
 *
 * 没写 `evidence` 的旧策略用 {@link DEFAULT_EVIDENCE},所以升级这一版不会让任何一条策略突然瞎掉。
 * 本文件是纯函数:不做 I/O,不看时钟。
 */

import { indicatorSnapshot, indicatorWithParams, minBarsForIndicator, periodOf, type IndicatorSnapshot } from './indicators.js';
import { INDICATOR_SETS, type IndicatorSet } from './routes-indicators.js';
import { evidenceOf, strategyKey, type StrategySpec } from './strategies.js';
import type { StrategyEvidenceSpec } from './strategies.js';
import type { Kline, TriggerKind } from './types.js';

const KNOWN = new Set<string>(INDICATOR_SETS as readonly string[]);

export interface IndicatorRequest {
  id: IndicatorSet;
  tf: string;
  /**
   * 09-12 §9.36(P1-11):指标参数。**进去重键** —— 同一个 RSI 不同参数是两条不同的证据,
   * 折叠成一条的后果是「哈希变了、算的东西没变」,或者用户点的参数**永远缺席**。
   */
  params?: Record<string, number>;
  /** 哪几条策略要它(排序去重)。 */
  required_by: string[];
}

/** 参数的规范化文本(键排序);没有参数 = 空串。去重键与 hash 都用它。 */
export function paramsKey(params: Record<string, number> | undefined): string {
  if (!params) return '';
  const keys = Object.keys(params).sort();
  if (!keys.length) return '';
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, params[k]!])));
}

/** 一条指标请求的唯一键:`id@tf#params`。 */
export function indicatorKey(req: { id: string; tf: string; params?: Record<string, number> }): string {
  return `${req.id}@${req.tf}#${paramsKey(req.params)}`;
}

export interface EvidencePlan {
  indicators: IndicatorRequest[];
  /** 信息员新闻的主题并集(空 = 不过滤)。 */
  info_topics: string[];
  /** 这批策略总共关心的触发种类并集(空 = 不收窄)。 */
  events: StrategyEvidenceSpec['events'];
}

/** 启用策略的证据并集。指标按 (id, tf) 去重;`required_by` 记下谁要它。 */
export function evidencePlan(specs: readonly StrategySpec[]): EvidencePlan {
  const byKey = new Map<string, IndicatorRequest>();
  const topics = new Set<string>();
  const events = new Set<StrategyEvidenceSpec['events'][number]>();
  for (const spec of specs) {
    const ev = evidenceOf(spec);
    for (const ind of ev.indicators) {
      if (!KNOWN.has(ind.id)) continue; // 指标库里没有的 id 一律忽略(策略校验时已经拦过一道)
      const key = indicatorKey(ind);
      const cur = byKey.get(key) ?? { id: ind.id as IndicatorSet, tf: ind.tf, ...(ind.params && Object.keys(ind.params).length ? { params: ind.params } : {}), required_by: [] };
      if (!cur.required_by.includes(spec.id)) cur.required_by.push(spec.id);
      byKey.set(key, cur);
    }
    for (const t of ev.info_topics ?? []) topics.add(t.toLowerCase());
    for (const e of ev.events) events.add(e);
  }
  const indicators = [...byKey.values()].sort((a, b) => a.tf.localeCompare(b.tf) || a.id.localeCompare(b.id) || paramsKey(a.params).localeCompare(paramsKey(b.params)));
  for (const i of indicators) i.required_by.sort();
  return { indicators, info_topics: [...topics].sort(), events: [...events].sort() };
}

// ---------------------------------------------------------------- 证据缺口(fail closed)

/** 指标快照至少要这么多根 K 线才算(与 context.ts 装证据时同一道门)。 */
export const INDICATOR_MIN_BARS = 30;

/**
 * §9.36 / P1-11 **fail closed**:哪几条策略点名要的指标这一轮**装不上**。
 *
 * runtime 在跑议会**之前**调它,把结果作为 `CouncilInputs.evidence_gaps` 传进去——有缺口的策略
 * 直接弃权。以前的行为是「silently skip」:指标没装上,策略照样按别的证据投票,谁也不知道
 * 它其实是瞎的。缺证据的策略投票比弃权危险,所以这里宁可少一票。
 *
 * 纯函数:只读 `klines`,不做 I/O、不看时钟。
 */
export function evidenceGaps(specs: readonly StrategySpec[], klines: Record<string, Kline[] | undefined>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const snapCache = new Map<string, IndicatorSnapshot | null>();
  for (const spec of specs) {
    // 09-12 复审 P1-06 第 4 条:缺口按 **id@version** 汇总。按 id 汇总时,同 ID 新版影子票的缺口
    // 会让正式的旧版一起弃权(实测 v1 paper 数据齐全,却因为 v99 shadow 缺 30m RSI 被一起弃权)。
    const key = strategyKey(spec);
    const notes: string[] = [];
    for (const req of evidencePlan([spec]).indicators) {
      const bars = klines[req.tf];
      const label = `${req.tf} ${req.id}${req.params ? `(${paramsKey(req.params)})` : ''}`;
      // 09-12 P1-11:根数门也按自定义窗口算 —— 要 200 根窗口的指标,30 根「够了」是假的。
      const need = Math.max(INDICATOR_MIN_BARS, minBarsForIndicator(req.id, req.params));
      if (!bars || bars.length < need) {
        notes.push(`${label}(只有 ${bars?.length ?? 0} 根 K 线,要 ${need} 根)`);
        continue;
      }
      if (!snapCache.has(req.tf)) snapCache.set(req.tf, indicatorSnapshot(bars, req.tf));
      const base = snapCache.get(req.tf) ?? null;
      if (!base) {
        notes.push(`${label}(快照算不出来)`);
        continue;
      }
      // 参数**必须真的传下去**:算不了自定义窗口的指标一律当「装不上」,绝不把默认窗口的数字
      // 贴上自定义标签(那就是 P1-11 说的「RSI7/21 只是标签不同,算的还是 RSI14」)。
      const snap = indicatorWithParams(req.id, bars, base, req.params);
      if (!snap) {
        notes.push(`${label}(这个指标还不支持自定义参数)`);
        continue;
      }
      if (renderIndicator(req.id, snap, req.params) === null) notes.push(`${label}(快照里没有这个指标的值)`);
    }
    if (notes.length) out[key] = [...(out[key] ?? []), ...notes];
  }
  return out;
}

/**
 * 一条证据请求要多深的 K 线:**按它自己的窗口算**,不是一刀切 220。
 * 默认窗口(没写 params)仍给 {@link EVIDENCE_DEFAULT_BARS},因为 EMA200/TRIX30 这类要这么多才热;
 * 写了窗口就按 `窗口 × 2 + 50` 取,并保底 120 根。
 */
export function evidenceBarsFor(req: { id: string; params?: Record<string, number> }): number {
  if (!req.params || !Object.keys(req.params).length) return EVIDENCE_DEFAULT_BARS;
  const p = periodOf(req.id, req.params);
  if (p === null) return EVIDENCE_DEFAULT_BARS;
  return Math.max(120, p * 2 + 50);
}

/** 没有自定义窗口时证据周期的默认深度(与 strategy-council.EVIDENCE_TF_BARS 同数)。 */
export const EVIDENCE_DEFAULT_BARS = 220;

/** evidence plan 点名的全部周期(runtime 拉 K 线时按它补齐;深度见 `klinePlan`)。 */
export function evidenceTimeframes(specs: readonly StrategySpec[]): string[] {
  return [...new Set(evidencePlan(specs).indicators.map((i) => i.tf))].sort();
}

// ---------------------------------------------------------------- 渲染一条指标

const dec = (v: number): number => (Math.abs(v) > 100 ? 0 : Math.abs(v) > 1 ? 2 : 5);
const n = (v: number | null | undefined, d?: number): string => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d ?? dec(v)) : 'n/a');

/**
 * 指标库 id → 一行人话。读的是同一份 {@link IndicatorSnapshot},所以它和图表页、
 * `GET /api/market/indicators` 三处同源;算不出来返回 null(这条就不进证据,不写 0)。
 */
export function renderIndicator(id: IndicatorSet, s: IndicatorSnapshot, params?: Record<string, number>): string | null {
  // 09-12 P1-11:窗口进标签。快照字段名(rsi14/ema20/…)是**默认窗口**的名字,自定义窗口时
  // 值已经由 {@link indicatorWithParams} 重算过,标签必须跟着换,不能写 RSI14 却是 7 根的数。
  const w = periodOf(id, params);
  const lbl = (name: string, fallback: number | null = w): string => `${name}${fallback === null ? '' : fallback}`;
  switch (id) {
    case 'ema20': return s.ema20 === null ? null : `${lbl('EMA')} ${n(s.ema20)}(价${s.last_close >= s.ema20 ? '上' : '下'})`;
    case 'ema50': return s.ema50 === null ? null : `${lbl('EMA')} ${n(s.ema50)}`;
    case 'ema200': return s.ema200 === null ? null : `${lbl('EMA')} ${n(s.ema200)}`;
    case 'sma20': return s.sma20 === null ? null : `${lbl('SMA')} ${n(s.sma20)}(价${s.last_close >= s.sma20 ? '上' : '下'})`;
    case 'sma50': return s.sma50 === null ? null : `${lbl('SMA')} ${n(s.sma50)}`;
    case 'sma200': return s.sma200 === null ? null : `${lbl('SMA')} ${n(s.sma200)}`;
    case 'wma20': return s.wma20 === null ? null : `${lbl('WMA')} ${n(s.wma20)}`;
    case 'dema20': return s.dema20 === null ? null : `${lbl('DEMA')} ${n(s.dema20)}`;
    case 'tema20': return s.tema20 === null ? null : `${lbl('TEMA')} ${n(s.tema20)}`;
    case 'bb': return s.bb === null ? null : `BB${w ?? ''} ${n(s.bb.lower)}~${n(s.bb.upper)},带宽 ${n(s.bb.width_pct, 2)}%${s.bb_width_rank_90 === null ? '' : `(${Math.round(s.bb_width_rank_90)} 分位)`}`;
    case 'keltner': return s.keltner20 === null ? null : `Keltner${w ?? ''} ${n(s.keltner20.lower)}~${n(s.keltner20.upper)}`;
    case 'donchian': return s.donchian20 === null ? null : `唐奇安${w ?? ''} ${n(s.donchian20.lower)}~${n(s.donchian20.upper)}`;
    case 'vwap': return s.vwap_day === null ? null : `VWAP(日) ${n(s.vwap_day)}${s.dist_to_vwap_atr === null ? '' : `,距 ${s.dist_to_vwap_atr >= 0 ? '+' : ''}${s.dist_to_vwap_atr.toFixed(2)} ATR`}`;
    case 'vwap_session': return s.vwap_session === null ? null : `VWAP(时段) ${n(s.vwap_session)}`;
    case 'supertrend': return s.supertrend === null || !Number.isFinite(s.supertrend.value) ? null : `超级趋势 ${s.supertrend.dir === 1 ? '多' : '空'} ${n(s.supertrend.value)}`;
    case 'psar': return s.psar === null || !Number.isFinite(s.psar.value) ? null : `PSAR ${n(s.psar.value)}(${s.psar.dir === 1 ? '多' : '空'})`;
    case 'ichimoku': return s.price_vs_cloud === null ? null : `一目云:价在云${s.price_vs_cloud === 'above' ? '上' : s.price_vs_cloud === 'below' ? '下' : '中'}`;
    case 'squeeze': return s.squeeze === null ? null : `挤压${s.squeeze.on ? `中(${s.squeeze.bars_on} 根)` : '否'}`;
    case 'rsi': return s.rsi14 === null ? null : `${lbl('RSI')} ${n(s.rsi14, 1)}`;
    case 'stochrsi': return s.stoch_rsi14 === null ? null : `${lbl('StochRSI')} ${n(s.stoch_rsi14, 1)}`;
    case 'stoch': return s.stoch === null || !Number.isFinite(s.stoch.k) ? null : `KD${w ?? ''} ${n(s.stoch.k, 0)}/${n(s.stoch.d, 0)}`;
    case 'macd': return s.macd === null || !Number.isFinite(s.macd.hist) ? null : `MACD 柱 ${n(s.macd.hist, dec(s.last_close) + 1)}`;
    case 'adx': return s.adx14 === null || !Number.isFinite(s.adx14.adx) ? null : `${lbl('ADX')} ${n(s.adx14.adx, 1)}(${s.trend_strength})`;
    case 'cci': return s.cci20 === null ? null : `${lbl('CCI')} ${n(s.cci20, 1)}`;
    case 'mfi': return s.mfi14 === null ? null : `${lbl('MFI')} ${n(s.mfi14, 1)}`;
    case 'willr': return s.williams_r14 === null ? null : `${lbl('Williams%R')} ${n(s.williams_r14, 1)}`;
    case 'atr': return s.atr14 === null ? null : `${lbl('ATR')} ${n(s.atr14)}(${n(s.atr_pct, 2)}%${s.atr_pct_rank_90 === null ? '' : `,${Math.round(s.atr_pct_rank_90)} 分位`})`;
    case 'natr': return s.natr14 === null ? null : `${lbl('NATR')} ${n(s.natr14, 2)}%`;
    case 'stddev': return s.stddev20 === null ? null : `${lbl('标准差')} ${n(s.stddev20)}`;
    case 'mom': return s.mom10 === null ? null : `${lbl('动量')} ${n(s.mom10)}`;
    case 'roc': return s.roc10 === null ? null : `${lbl('ROC')} ${n(s.roc10, 2)}%`;
    case 'trix': return s.trix30 === null ? null : `${lbl('TRIX')} ${n(s.trix30, 4)}`;
    case 'obv': return s.obv_slope_10 === null ? null : `OBV 10 根斜率 ${n(s.obv_slope_10, 2)}`;
    case 'ad': return s.ad === null ? null : `Chaikin A/D ${n(s.ad, 0)}`;
    case 'aroon': return s.aroon25 === null || !Number.isFinite(s.aroon25.up) ? null : `${lbl('Aroon')} 上 ${n(s.aroon25.up, 0)} 下 ${n(s.aroon25.down, 0)}`;
    default: return null;
  }
}
