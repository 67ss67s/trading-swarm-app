import { HORIZON_POLICY, inferHorizon, type StrategyHorizon } from './horizon.js';
// 策略库(docs/design/strategy-library-2026-09-05.md;决定稿 §2 E/F;Codex 调研 Part 2)。
//
// 一条策略是一个**不可变的版本化对象**:触发(纯函数,哪些事件才唤醒它)+ 清单(代码必须能算出来的
// 证据)+ 规则(模型只能在这些边里选)+ 参数(带范围,改一个就是新版本 + 新 hash)+ 评测统计。
// 落库的只有数据;触发判定与「清单证据怎么算」是代码,按 strategy id 注册在下面的 registry 里,
// 所以一个策略的新版本换的是数字和措辞,不是行为的实现。
//
// 与长期记忆的分工(design v1 §11「记忆不改数字」):记忆只能 propose,策略参数只能由人点
// 「生成新版本」落成 draft,再一格一格晋升。没有「模型直接 set 参数」的路径。

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { indicatorSnapshot, squeeze } from './indicators.js';
import type { TfFeatures } from './market.js';
import type { ScanThresholds } from './review-metrics.js';
import { MIN_BARS as REVERSION_MIN_BARS, reversionStats, type ReversionStats } from './reversion-stats.js';
import { INDICATOR_SETS } from './routes-indicators.js';
import type { DailyRegime, Kline, MarketView, TriggerHit, TriggerKind } from './types.js';

export const EVENT_SUBKINDS = ['fomc', 'cpi', 'nfp', 'ppi', 'pce', 'gdp', 'claims', 'retail', 'unlock', 'listing', 'delisting', 'hack', 'etf_flow', 'regulation', 'upgrade', 'funding_extreme', 'vol_spike', 'unclassified'] as const;
export type EventSubkind = typeof EVENT_SUBKINDS[number];

// ---------------------------------------------------------------- 数据模型

export type StrategyStatus = 'draft' | 'backtest' | 'shadow' | 'paper' | 'live_capped' | 'retired';
export type StrategyFamily = 'trend_continuation' | 'mtf' | 'volatility' | 'derivatives' | 'mean_reversion' | 'relative_value';

/** 晋升只能沿这条线一格一格走;retired 不在其中(随时可退役,不可回)。 */
export const STATUS_ORDER: StrategyStatus[] = ['draft', 'backtest', 'shadow', 'paper', 'live_capped'];

export const FAMILY_LABEL: Record<StrategyFamily, string> = {
  trend_continuation: '趋势延续',
  mtf: '多周期',
  volatility: '波动结构',
  derivatives: '衍生品结构',
  mean_reversion: '均值回归',
  relative_value: '相对价值（离线）',
};

export const STATUS_LABEL: Record<StrategyStatus, string> = {
  draft: '草稿',
  backtest: '回测中',
  shadow: '影子',
  paper: '纸面',
  live_capped: '限额实盘',
  retired: '已退役',
};

export interface StrategyParam {
  value: number;
  min: number;
  max: number;
  unit?: string;
  note?: string;
}

export interface StrategyEvalStats extends Partial<import('./replay-stats.js').ReplayStats> {
  /** 跑过多少次回测。 */
  backtests: number;
  trades: number;
  win_rate: number | null;
  /** 每笔期望 R(平均 R)。 */
  expectancy_r: number | null;
  /** 最大不利偏移的中位数,单位 R(负数)。 */
  mae_r_p50: number | null;
  last_run_id: string | null;
  noise_note: string | null;
}

export const EMPTY_EVAL_STATS: StrategyEvalStats = { backtests: 0, trades: 0, win_rate: null, expectancy_r: null, mae_r_p50: null, last_run_id: null, noise_note: null };

/**
 * 09-12 §4「策略自定义证据」:这条策略要**哪些指标/事件/新闻主题**才判得出来。
 *
 * - `indicators`:指标库(routes-indicators.ts 的 `INDICATOR_SETS`)里的 id + 周期;context.ts 只按
 *   **启用策略的并集**装,没有策略要的指标不进 prompt(缩 token,也让「模型看到了什么」可解释)。
 * - `events`:普通触发与 trigger.kinds 取交集；事件 subkind 显式订阅增加 event 入口并按 subkind 匹配；空沿用 trigger.kinds。
 * - `info_topics`:信息员新闻的主题过滤(如 etf / listing / macro)。
 *
 * **进 content_hash**:它改变判断的输入,换一套证据就是换一条策略,必须是新版本。
 */
export interface StrategyEvidenceSpec {
  indicators: { id: string; tf: string; params?: Record<string, number> }[];
  events: (TriggerKind | EventSubkind)[];
  info_topics?: string[];
}

/**
 * 没写 `evidence` 的旧策略用的默认集 = 今天 context.ts 事实上装的那一套,**显式列出来**
 * (以前它散在 context.ts 的 if 里,「默认」说不清是什么)。事件留空 = 不收窄 trigger.kinds。
 */
export const DEFAULT_EVIDENCE: StrategyEvidenceSpec = {
  indicators: [
    { id: 'ema20', tf: '1h' },
    { id: 'ema50', tf: '1h' },
    { id: 'atr', tf: '1h' },
    { id: 'rsi', tf: '1h' },
  ],
  events: [],
  info_topics: [],
};

/** 这条策略的**生效**证据集(没写就用 {@link DEFAULT_EVIDENCE})。 */
export function evidenceOf(spec: Pick<StrategySpec, 'evidence'>): StrategyEvidenceSpec {
  return spec.evidence ?? DEFAULT_EVIDENCE;
}

export interface StrategySpec {
  health_by_backend?: Record<string, { status: StrategyStatus; generation: number; window_from: number }>;
  shadow_generation?: number;
  shadow_window_from?: number;
  id: string;
  version: number;
  /** sha256(name|family|trigger|checklist|rules|params|evidence);status 与 eval_stats 不进 hash。 */
  content_hash: string;
  name: string;
  family: StrategyFamily;
  horizon: StrategyHorizon;
  status: StrategyStatus;
  trigger: {
    /** 只有这些触发种类才唤醒这条策略。 */
    kinds: TriggerKind[];
    /** 低于这个周期不跑(避免 1m 噪声)。 */
    min_timeframe: string;
    /** 同一策略两次开仓之间至少隔多少根。 */
    cooldown_bars: number;
  };
  checklist: {
    /** 代码必须能算出来的证据 id(算不出来就不该让模型按这条策略开仓)。 */
    required: string[];
    timeframes: string[];
    /**
     * 09-12:这条策略的判据**最少要几根主周期 K 线**才算得出来(缺省 = 运行时的默认根数)。
     * 之前 range_mean_reversion 的回归统计硬要 400 根,而扫描/议会只拉 60/120/80 根,于是它永远
     * 静默弃权——「函数实现了、运行功能没交付」。现在取数根数由启用策略的 max(min_bars) 决定
     * (见 {@link minBarsFor}),拉不够时该策略的票面写「数据不足 N/400」。
     * **不进 content_hash**:它是这条策略 id 的数据需求常量,不是可调内容(改它不该产生新版本)。
     */
    min_bars?: number;
  };
  rules: {
    entry: string[];
    invalidation: string[];
    exit: string[];
    sizing_note?: string;
    /**
     * 09-12:`workflow.entry_style = 'limit_only'` 时的**唯一豁免**——这条策略的规则本身允许市价入场
     * (例如「触发即市价追进」的动量策略)。不写 = 不豁免。**不进 content_hash**(contentHashOf 只规范化
     * entry/invalidation/exit/sizing_note),所以给老版本补这个字段不会造出新版本。
     */
    entry_mode?: 'market_ok';
  };
  params: Record<string, StrategyParam>;
  /** 09-12 §4:这条策略要的指标/事件/新闻主题;不写 = {@link DEFAULT_EVIDENCE}。进 content_hash。 */
  evidence?: StrategyEvidenceSpec | null;
  eval_stats: StrategyEvalStats;
  /**
   * 09-07:Strategy Lab 的机械前瞻期望(漏斗法,零模型),按**这个版本**记,不混进 eval_stats(那是含模型的回放成绩)。
   * 只用于 draft→backtest→shadow 这两步「数据态」晋升;paper 及以上仍要 eval_stats + 人批。
   */
  lab_stats?: LabStats | null;
  created_at: number;
  parent_version?: number | null;
}

/**
 * 09-12 §1.2 影子实盘的成绩:与 paper 完全相同的触发/证据/时序下,虚拟线程按真实 K 线结算的 R。
 * 它是 shadow→paper 这道**自动**门的唯一数据来源;`n=0` 时每个数都是 null(不编数)。
 */
export interface ShadowStats {
  raw_n?: number;
  direction_proxy?: ShadowStats;
  full_strategy?: ShadowStats;
  net_expectancy_r?: number | null;
  net_max_drawdown_r?: number | null;
  n: number;
  win_rate: number | null;
  expectancy_r: number | null;
  total_r: number;
  /** 累计 R 曲线的最大回撤(正数,单位 R)。 */
  max_drawdown_r: number;
  first_at: number | null;
  last_at: number | null;
}

export const EMPTY_SHADOW_STATS: ShadowStats = { n: 0, win_rate: null, expectancy_r: null, total_r: 0, max_drawdown_r: 0, first_at: null, last_at: null };

export interface LabStats extends Partial<import('./replay-stats.js').ReplayStats> {
  coverage?: Record<string, number>;
  run_id: string;
  at: number;
  symbols: number;
  setups: number;
  n: number;
  win_rate: number | null;
  expectancy_r: number | null;
  total_r: number;
  note: string;
  /** 09-12:影子实盘成绩,按**这个版本**记;漏斗数字(上面那几个)是它的对照面。 */
  shadow_by_backend?: Record<string, ShadowStats>;
  shadow?: (ShadowStats & { net_expectancy_r?: number | null; net_max_drawdown_r?: number | null }) | null;
}

/**
 * 一条策略**版本**的键:`id@version`。
 *
 * 09-12 复审 P1-06 第 4 条:证据缺口、唤醒集合这些外围键以前按 `strategy_id` 汇总,于是同一个 ID
 * 的两个版本互相串扰——v99 的影子票缺 30m RSI,能让正在 paper 上跑的 v1 一起弃权;反过来事件唤醒
 * 也会按 ID 把旧版本一起叫醒。凡是「按策略分组」的地方都必须用这个键。
 */
export function strategyKey(s: Pick<StrategySpec, 'id' | 'version'>): string {
  return `${s.id}@${s.version}`;
}

/** 研究态可共用定义；paper/live 资格只属于有证据的 backend。旧纸面种子归 paper。 */
export function strategyForBackend(spec: StrategySpec, backend: string): StrategySpec {
  const status = spec.health_by_backend?.[backend]?.status ?? ((spec.status === 'paper' || spec.status === 'live_capped') && (backend !== 'paper' || Object.keys(spec.health_by_backend ?? {}).length > 0) ? 'shadow' : spec.status);
  const shadow = spec.lab_stats?.shadow_by_backend?.[backend] ?? (backend === 'paper' && !Object.keys(spec.lab_stats?.shadow_by_backend ?? {}).length ? spec.lab_stats?.shadow ?? null : null);
  return { ...spec, status, lab_stats: spec.lab_stats ? { ...spec.lab_stats, shadow } : null };
}

/** hash 只覆盖「内容」;status / eval_stats / created_at 是版本行上的可变元数据。 */
export function strategyContentHash(s: Pick<StrategySpec, 'name' | 'horizon' | 'family' | 'trigger' | 'checklist' | 'rules' | 'params' | 'evidence'>): string {
  const params: Record<string, [number, number, number, string]> = {};
  for (const key of Object.keys(s.params).sort()) {
    const p = s.params[key]!;
    params[key] = [p.value, p.min, p.max, p.unit ?? ''];
  }
  const canonical = JSON.stringify({
    name: s.name,
    family: s.family,
    horizon: s.horizon,
    trigger: { kinds: [...s.trigger.kinds].sort(), min_timeframe: s.trigger.min_timeframe, cooldown_bars: s.trigger.cooldown_bars },
    checklist: { required: [...s.checklist.required].sort(), timeframes: [...s.checklist.timeframes] },
    rules: { entry: s.rules.entry, invalidation: s.rules.invalidation, exit: s.rules.exit, sizing_note: s.rules.sizing_note ?? '' },
    params,
    // 没写 evidence 的旧策略**不加这个键**(JSON.stringify 丢 undefined),所以库里已有版本的 hash 一个字都不变;
    // 写了就进 hash——换一套证据 = 换了判断输入 = 必须是新版本。
    ...(s.evidence ? { evidence: canonicalEvidence(s.evidence) } : {}),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** 证据集的规范形式(排序 + 参数按键排序),让「同一套证据」不因书写顺序产生两个 hash。 */
function canonicalEvidence(e: StrategyEvidenceSpec): unknown {
  const indicators = [...e.indicators]
    .map((i) => ({ id: i.id, tf: i.tf, params: i.params ? Object.fromEntries(Object.keys(i.params).sort().map((k) => [k, i.params![k]!])) : {} }))
    .sort((a, b) => a.id.localeCompare(b.id) || a.tf.localeCompare(b.tf) || JSON.stringify(a.params).localeCompare(JSON.stringify(b.params)));
  return { indicators, events: [...e.events].sort(), info_topics: [...(e.info_topics ?? [])].sort() };
}

// ---------------------------------------------------------------- 证据集校验(§9.34)

/**
 * `evidence.events` 能写的全集 = {@link TriggerKind} 的全部取值(与 types.ts 的联合类型一一对应)。
 * 写在这里而不是 types.ts:那边是纯类型文件,这里是唯一需要**运行时**判成员的地方。
 */
export const TRIGGER_KIND_VALUES: readonly TriggerKind[] = [
  'kline_close', 'manual', 'schedule', 'monitor', 'position_review', 'scan', 'info_update', 'order_filled',
  'tp_hit', 'sl_hit', 'thread_review', 'chat', 'fast_move', 'breakout', 'ema_cross', 'vol_spike', 'retest',
  'session', 'funding', 'heartbeat', 'event',
];

/** 证据集的规模上限:证据要进 prompt,放开了就是把 token 账单交给 UI。 */
export const EVIDENCE_LIMITS = { indicators: 24, events: 24, info_topics: 12, topic_chars: 32 } as const;

/**
 * `PUT /api/strategies/:id/evidence` 的输入校验(契约 §9.34)。**纯函数,不碰库**。
 *
 * - `null` = 清空,回到 {@link DEFAULT_EVIDENCE}(不是「不改」;不改由调用方不传这个字段表达)。
 * - `indicators[].id` 必须在指标库 {@link INDICATOR_SETS} 里,`tf` 必须是 {@link tfMinutes} 认得的周期;
 *   同一 `(id, tf)` 去重(证据并集本来就按这个键去重,留重复只会让 hash 不稳)。
 * - `events` 必须 ⊆ {@link TRIGGER_KIND_VALUES};`info_topics` 是小写去空白的字符串数组。
 * 校验通过的返回值已经是**规范化**的(排序 + 去重),所以同一套证据只会有一个 content_hash。
 */
export function validateEvidenceSpec(raw: unknown): { evidence: StrategyEvidenceSpec | null; error: string | null } {
  if (raw === null) return { evidence: null, error: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { evidence: null, error: 'evidence 必须是对象或 null' };
  const o = raw as Record<string, unknown>;

  const rawInd = o['indicators'];
  if (!Array.isArray(rawInd)) return { evidence: null, error: 'evidence.indicators 必须是数组' };
  if (rawInd.length > EVIDENCE_LIMITS.indicators) return { evidence: null, error: `evidence.indicators 最多 ${EVIDENCE_LIMITS.indicators} 条` };
  const known = new Set<string>(INDICATOR_SETS as readonly string[]);
  const seen = new Set<string>();
  const indicators: StrategyEvidenceSpec['indicators'] = [];
  for (const item of rawInd) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return { evidence: null, error: 'evidence.indicators 的每一项必须是 {id, tf} 对象' };
    const it = item as Record<string, unknown>;
    const id = typeof it['id'] === 'string' ? it['id'].trim().toLowerCase() : '';
    if (!known.has(id)) return { evidence: null, error: `指标库里没有 ${typeof it['id'] === 'string' ? it['id'] : '(空)'}` };
    const tf = typeof it['tf'] === 'string' ? it['tf'].trim() : '';
    if (!Object.hasOwn(TF_MINUTES, tf)) return { evidence: null, error: `无效周期 ${tf || '(空)'}(只能是 ${Object.keys(TF_MINUTES).join(' / ')})` };
    let params: Record<string, number> | undefined;
    const rawParams = it['params'];
    if (rawParams !== undefined && rawParams !== null) {
      if (typeof rawParams !== 'object' || Array.isArray(rawParams)) return { evidence: null, error: `${id} 的 params 必须是对象` };
      params = {};
      for (const [k, v] of Object.entries(rawParams as Record<string, unknown>)) {
        const n = Number(v);
        if (!Number.isFinite(n)) return { evidence: null, error: `${id}.params.${k} 必须是数字` };
        params[k] = n;
      }
      if (Object.keys(params).length === 0) params = undefined;
    }
    const key = `${id}@${tf}`;
    if (seen.has(key)) continue; // 重复的 (id, tf) 直接吃掉,不报错(UI 多点一下不该是错误)
    seen.add(key);
    indicators.push({ id, tf, ...(params ? { params } : {}) });
  }

  const rawEvents = o['events'];
  if (!Array.isArray(rawEvents)) return { evidence: null, error: 'evidence.events 必须是数组' };
  if (rawEvents.length > EVIDENCE_LIMITS.events) return { evidence: null, error: `evidence.events 最多 ${EVIDENCE_LIMITS.events} 条` };
  const events: TriggerKind[] = [];
  for (const e of rawEvents) {
    if (typeof e !== 'string' || !(TRIGGER_KIND_VALUES as readonly string[]).includes(e)) return { evidence: null, error: `无效触发种类 ${typeof e === 'string' ? e : '(非字符串)'}` };
    if (!events.includes(e as TriggerKind)) events.push(e as TriggerKind);
  }

  const rawTopics = o['info_topics'];
  const info_topics: string[] = [];
  if (rawTopics !== undefined && rawTopics !== null) {
    if (!Array.isArray(rawTopics)) return { evidence: null, error: 'evidence.info_topics 必须是字符串数组' };
    if (rawTopics.length > EVIDENCE_LIMITS.info_topics) return { evidence: null, error: `evidence.info_topics 最多 ${EVIDENCE_LIMITS.info_topics} 条` };
    for (const raw of rawTopics) {
      if (typeof raw !== 'string') return { evidence: null, error: 'evidence.info_topics 必须是字符串数组' };
      const topic = raw.trim().toLowerCase();
      if (!topic) continue;
      if (topic.length > EVIDENCE_LIMITS.topic_chars) return { evidence: null, error: `新闻主题「${raw}」超过 ${EVIDENCE_LIMITS.topic_chars} 字` };
      if (!info_topics.includes(topic)) info_topics.push(topic);
    }
  }

  return { evidence: { indicators: indicators.sort((a, b) => a.id.localeCompare(b.id) || a.tf.localeCompare(b.tf)), events: events.sort(), info_topics: info_topics.sort() }, error: null };
}

/**
 * `checklist.required` 能写的 id 全集 —— **代码真的算得出来**的那几项(见 {@link STRATEGY_EVIDENCE}
 * 与 context.ts 里的清单行)。假设生成器的硬约束之一:写了这个集合之外的 id,整条假设直接丢。
 * 「算不出来的判据」等于让模型自由发挥,那正是策略库要消灭的东西。
 */
export const CHECKLIST_LIBRARY = ['scan_checklist', 'daily_regime', 'indicator_snapshot', 'funding_stats', 'reversion_stats'] as const;

/** 运行时默认拉的主周期根数;策略没声明 min_bars 时用它。 */
export const DEFAULT_SCAN_BARS = 60;

/**
 * 拉 K 线时多取几根的余量:运行时会按「已收盘」切一刀(还在走的那根被丢掉),
 * 正好取 min_bars 根会变成 min_bars-1 根可见,策略照样判「数据不足」。
 */
export const KLINE_FETCH_MARGIN = 5;

/**
 * 这批策略跑起来最少要拉多少根主周期 K 线(取各自 min_bars 的 max 再加余量;都没声明时 = {@link DEFAULT_SCAN_BARS})。
 */
export function minBarsFor(specs: { checklist: { min_bars?: number } }[]): number {
  const declared = specs.reduce((a, s) => Math.max(a, s.checklist.min_bars ?? 0), 0);
  return Math.max(DEFAULT_SCAN_BARS, declared > 0 ? declared + KLINE_FETCH_MARGIN : 0);
}

const TF_MINUTES: Record<string, number> = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240, '1d': 1440 };
export function tfMinutes(tf: string): number {
  return TF_MINUTES[tf] ?? 15;
}

/** 普通触发保留旧交集语义；显式事件 subkind 订阅增加 event 入口。 */
export function wakeKindsOf(s: StrategySpec): TriggerKind[] {
  const want = evidenceOf(s).events;
  const kinds = !want.length ? [...s.trigger.kinds] : s.trigger.kinds.filter((k) => want.includes(k));
  if (want.length && want.some(k => (EVENT_SUBKINDS as readonly string[]).includes(k)) && !kinds.includes('event')) kinds.push('event');
  // 09-12 跟单:带单员开单是**外部唤醒**,不是代码触发器算出来的行情事实 —— 每条策略都该有机会对它表态
  // (不然 gated 模式那次 scan 会因为「没有策略被唤醒」而没有票池,议会一票都投不出来)。
  // 它只决定「要不要问」,问出来什么仍由策略自己的规则与闸裁决。
  if (!kinds.includes('trader_signal')) kinds.push('trader_signal');
  return kinds;
}

/** subkind 订阅只匹配结构化事件，不从标题/detail 猜；周期下限仍生效。 */
export function strategyWakes(s: StrategySpec, timeframe: string, hits: { kind: TriggerKind; event_subkind?: string }[]): boolean {
  if (tfMinutes(timeframe) < tfMinutes(s.trigger.min_timeframe)) return false;
  const kinds = wakeKindsOf(s);
  const subkinds = evidenceOf(s).events.filter(k => (EVENT_SUBKINDS as readonly string[]).includes(k));
  return hits.some(h => kinds.includes(h.kind) && (h.kind !== 'event' || !subkinds.length || (h.event_subkind !== undefined && (subkinds as string[]).includes(h.event_subkind))));
}

// ---------------------------------------------------------------- 内置策略

const p = (value: number, min: number, max: number, unit?: string, note?: string): StrategyParam => ({ value, min, max, ...(unit ? { unit } : {}), ...(note ? { note } : {}) });

type BuiltIn = Omit<StrategySpec, 'content_hash' | 'created_at' | 'version' | 'eval_stats'>;

const BUILTIN_DEFS: BuiltIn[] = [
  {
    id: 'breakout_retest',
    horizon: 'intraday',
    name: '突破-回踩',
    family: 'trend_continuation',
    status: 'paper', // 今天在跑的 playbook 就是它
    trigger: { kinds: ['breakout', 'retest', 'ema_cross'], min_timeframe: '15m', cooldown_bars: 4 },
    checklist: { required: ['scan_checklist', 'daily_regime'], timeframes: ['15m', '1h', '4h'] },
    rules: {
      entry: [
        '方向随 1h EMA20/EMA50;4h 反向只许限价回踩、信心 ≤ 0.5。',
        '回踩确认(收在突破位外侧、量比 ≥ retest_vol_min)→ 市价;刚突破未回踩 → 限价挂突破位与 EMA20 之间。',
        '距突破位 > chase_atr_max ATR 或 ATR% < atr_pct_floor 不做;日线 bear 不做多、bull 不做空,range 要量比 ≥ range_vol_min。',
      ],
      invalidation: ['收盘回到突破位另一侧,或 1h 与 4h 双双转反向。'],
      exit: ['论点未变 HOLD;失效 EXIT;浮盈 ≥ 1R 且结构转弱 REDUCE;挂单远离入场区 INVALIDATE。'],
      sizing_note: '止损在最近 swing 外 ≥ 0.8 ATR,第一止盈 ≥ 1.5 倍止损。',
    },
    params: {
      atr_pct_floor: p(0.4, 0.05, 2, '%', '判断周期的 ATR% 下限'),
      chase_atr_max: p(1.5, 0.5, 3, 'ATR', '距突破位多远就不追'),
      retest_vol_min: p(1, 0.5, 3, '倍', '回踩确认要的量比'),
      range_vol_min: p(1.5, 1, 3, '倍', '日线 range 时突破要的量比'),
      breakout_window: p(1, 1, 24, '根', '突破发生后多少根内,回踩仍然算数'),
    },
  },
  {
    id: 'mtf_alignment',
    horizon: 'scalp',
    name: '多周期对齐',
    family: 'mtf',
    status: 'backtest',
    trigger: { kinds: ['breakout', 'retest', 'ema_cross'], min_timeframe: '5m', cooldown_bars: 4 },
    checklist: { required: ['scan_checklist'], timeframes: ['15m', '1h', '4h'] },
    rules: {
      entry: [
        '5m/15m 出现突破/回踩/EMA 交叉,且 15m 与 1h EMA20/50 同向,方向随之。',
        '4h 只作否决:4h 反向且距 EMA 超 veto_atr ATR 一律不开;4h 同向不算入场理由。',
        '距突破位 ≤ chase_atr_max ATR 才入场,超出只 WATCH。',
      ],
      invalidation: ['确认周期(15m 或 1h)收盘转反向,或价回到触发位另一侧。'],
      exit: ['确认周期仍同向 HOLD;转向 EXIT;浮盈 ≥ 1R 且 15m 收在 EMA20 另一侧 REDUCE。'],
      sizing_note: '止损在触发周期 swing 之外(≥ 0.8 ATR),第一止盈 ≥ 1.5R。',
    },
    params: {
      confirm_tf_count: p(2, 1, 3, '个', '要几个确认周期同向'),
      veto_atr: p(1, 0.3, 3, 'ATR', '4h 反向多远算否决'),
      chase_atr_max: p(1.5, 0.5, 3, 'ATR'),
    },
  },
  {
    id: 'vol_compression_expansion',
    horizon: 'intraday',
    name: '波动压缩→扩张',
    family: 'volatility',
    status: 'backtest',
    trigger: { kinds: ['vol_spike', 'breakout'], min_timeframe: '15m', cooldown_bars: 6 },
    checklist: { required: ['indicator_snapshot', 'scan_checklist'], timeframes: ['15m', '1h'] },
    rules: {
      entry: [
        '先压缩:带宽 90 根分位 ≤ bb_width_rank_max,或 squeeze 连续 ≥ squeeze_bars_min 根。',
        '再扩张:同一根同时突破 + 量比 ≥ vol_spike_min,方向由突破决定。',
        '只做压缩后第一次扩张;已走出 chase_atr_max ATR 不追。',
      ],
      invalidation: ['revert_bars 根内收回压缩区间且量比 < 1,或收盘回到布林中轨另一侧。'],
      exit: ['量比不衰减且价在带外 HOLD;回中轨 EXIT;浮盈 ≥ 1.5R 且量比 < 1 REDUCE。'],
      sizing_note: '止损在压缩区间另一端外(≥ 1 ATR);第一止盈 ≥ 2R,靠少数大赢家。',
    },
    params: {
      bb_width_rank_max: p(20, 5, 40, '%', '带宽 90 根分位上限'),
      squeeze_bars_min: p(6, 3, 20, '根', 'squeeze 连续根数'),
      vol_spike_min: p(1.8, 1.2, 4, '倍', '扩张那根的量比'),
      revert_bars: p(2, 1, 5, '根', '几根内收回算失效'),
      chase_atr_max: p(1.5, 0.5, 3, 'ATR'),
    },
  },
  {
    id: 'funding_oi_extreme',
    horizon: 'intraday',
    name: '资金费率/OI 极值',
    family: 'derivatives',
    status: 'backtest',
    trigger: { kinds: ['funding', 'fast_move'], min_timeframe: '15m', cooldown_bars: 8 },
    checklist: { required: ['funding_stats', 'scan_checklist'], timeframes: ['15m', '1h', '4h'] },
    rules: {
      entry: [
        '|费率| ≥ funding_abs_min 且 30 天 z ≥ funding_z_min 才算极值,只看绝对值不算。',
        'fade:正极值 + OI 降 ≥ oi_change_min 做空;负极值 + OI 降做多。',
        'follow:极值但 OI 仍升且 1h/4h 同向 → 只许顺势限价挂回踩。',
        '距结算 minutes_before_funding 分钟内不新开。',
      ],
      invalidation: ['费率回到 ±0.02% 内而价未跟随,或 OI 回升且价反向走出 1 ATR。'],
      exit: ['费率仍极端且论点未破 HOLD;归一且浮盈 > 0 REDUCE;归一且论点已破 EXIT。'],
      sizing_note: '条件性策略:止损 ≥ 1.2 ATR,仓位不超常规,第一止盈 1.5R。',
    },
    params: {
      funding_abs_min: p(0.05, 0.01, 0.5, '%', '费率绝对值门槛'),
      funding_z_min: p(2, 1, 4, 'σ', '30 天 z-score 门槛'),
      oi_change_min: p(1, 0.2, 10, '%', 'OI 1h 变化确认门槛'),
      minutes_before_funding: p(30, 0, 240, '分钟', '结算前多久不开新仓'),
    },
  },
  {
    id: 'range_mean_reversion',
    horizon: 'intraday',
    name: '区间均值回归',
    family: 'mean_reversion',
    status: 'backtest',
    trigger: { kinds: ['fast_move', 'vol_spike', 'kline_close'], min_timeframe: '15m', cooldown_bars: 6 },
    checklist: { required: ['reversion_stats', 'indicator_snapshot', 'daily_regime'], timeframes: ['15m', '1h', '4h'], min_bars: REVERSION_MIN_BARS },
    rules: {
      entry: [
        '只在震荡:日线 range 或 ADX14 < adx_max。',
        '价距 EMA20 ≥ dev_atr_min ATR,反着偏离方向做。',
        '「回归统计」里 horizon_bars 根内回归比例 < min_reversion_prob 不做。',
        '目标 EMA20/VWAP,不加仓摊平。',
      ],
      invalidation: ['收盘再偏离 0.5 ATR,或 ADX14 升破 25 / 日线转 trend。'],
      exit: ['触及 EMA20 EXIT;超回归中位根数 2 倍未回归 EXIT;浮盈 ≥ 1R 且走完一半 REDUCE。'],
      sizing_note: '止损在偏离方向再 stop_atr ATR;高胜率低盈亏比,止盈即 EMA20。',
    },
    params: {
      dev_atr_min: p(2, 1, 4, 'ATR', '偏离 EMA20 多少个 ATR 才算'),
      adx_max: p(20, 10, 30, '', '4h/判断周期 ADX 上限'),
      horizon_bars: p(12, 4, 48, '根', '回归观察窗口'),
      min_reversion_prob: p(55, 30, 90, '%', '历史回归比例下限'),
      stop_atr: p(1, 0.5, 2, 'ATR'),
    },
  },
];

/** 内置策略的初版(version 1);seed 与 estimate 的兜底都用它。 */
export const BUILTIN_STRATEGIES: StrategySpec[] = BUILTIN_DEFS.map((d) => ({
  ...d,
  version: 1,
  content_hash: strategyContentHash(d),
  eval_stats: { ...EMPTY_EVAL_STATS },
  created_at: 0,
  parent_version: null,
}));

for (const [id, horizon] of [['swing_breakout_retest', 'swing'], ['position_breakout_retest', 'position']] as const) {
  const base = BUILTIN_STRATEGIES[0]!;
  const hp = HORIZON_POLICY[horizon];
  const spec: StrategySpec = { ...base, id, horizon, name: horizon === 'swing' ? '中线突破回踩' : '长线突破回踩', status: 'backtest',
    trigger: { ...base.trigger, min_timeframe: hp.timeframe }, checklist: { ...base.checklist, timeframes: [...new Set([hp.timeframe, hp.confirm])] },
    rules: { entry: [`${hp.timeframe}/${hp.confirm} 趋势同向,在 ${hp.timeframe} 突破后等回踩;入场区参考 ${hp.entry_zone_atr} ATR。`], invalidation: [`仅按 ${hp.timeframe} 已收盘结构确认失效,不因低周期波动退出。`], exit: ['长线策略不用短线思维;论点未破 HOLD,本周期失效确认才考虑 EXIT/REDUCE。'], sizing_note: `止损至少 ${hp.stop_atr} 个 ${hp.timeframe} ATR,按固定风险预算缩量,不放大风险。` } };
  spec.content_hash = strategyContentHash(spec);
  BUILTIN_STRATEGIES.push(spec);
}

export const BUILTIN_IDS: string[] = BUILTIN_STRATEGIES.map((s) => s.id);
/** workflow.active_strategies 的默认值:今天在跑的那一条。 */
export const DEFAULT_ACTIVE_STRATEGIES = ['breakout_retest'];

// ---------------------------------------------------------------- 清单证据(代码计算)

export interface StrategyEvidenceInput {
  now: number;
  symbol: string;
  timeframe: string;
  features: TfFeatures[];
  /** 该时刻可见的 K 线,按周期;回测里是 visibleWindow 切出来的,实盘是刚拉的。 */
  klines?: Record<string, Kline[]>;
  market: MarketView;
  oi_change_1h_pct: number | null;
  /** 近 30 天资金费率历史(fapi/v1/fundingRate);缺就退化成「不可得」。 */
  funding_history?: { at: number; rate: string }[];
  daily_regime?: DailyRegime | null;
  trigger_hits?: TriggerHit[];
}

export interface StrategyEvidenceLine {
  label: string;
  value: string;
  observed_at: number;
  source: string;
}

export type StrategyEvidenceFn = (spec: StrategySpec, inp: StrategyEvidenceInput) => StrategyEvidenceLine[];

const val = (s: StrategySpec, key: string, fallback: number): number => s.params[key]?.value ?? fallback;

function baseBars(inp: StrategyEvidenceInput): Kline[] {
  return inp.klines?.[inp.timeframe] ?? [];
}

/** 均值:样本量 < 2 返回 null。 */
function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function stdev(xs: number[], m: number): number | null {
  if (xs.length < 2) return null;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** 资金费率 30 天 z-score(用历史序列;历史缺失时返回 null 而不是编一个 0)。 */
export function fundingZScore(history: { at: number; rate: string }[] | undefined, current: number, now: number, days = 30): { z: number | null; samples: number; mean: number | null; sd: number | null } {
  const cutoff = now - days * 86_400_000;
  const xs = (history ?? []).filter((f) => f.at >= cutoff && f.at <= now).map((f) => Number(f.rate)).filter((n) => Number.isFinite(n));
  const m = mean(xs);
  const sd = m === null ? null : stdev(xs, m);
  const z = m === null || sd === null || sd === 0 ? null : (current - m) / sd;
  return { z, samples: xs.length, mean: m, sd };
}

/** id → 该策略要往上下文里加的「清单证据」行。没有条目 = 复用现有的扫描清单,不加行。 */
export const STRATEGY_EVIDENCE: Record<string, StrategyEvidenceFn> = {
  // 突破-回踩 / 多周期对齐:完全复用「扫描清单(代码计算)」的字段,不新增证据行(决定稿 §2 E:零新字段)。
  breakout_retest: () => [],
  mtf_alignment: () => [],

  vol_compression_expansion: (spec, inp) => {
    const bars = baseBars(inp);
    if (bars.length < 30) return [{ label: '压缩状态(代码计算)', value: `可见 K 线不足(${bars.length} 根),带宽分位/squeeze 不可得——本次不得按本策略 PROPOSE`, observed_at: inp.now, source: 'indicators.ts(数据不足)' }];
    const snap = indicatorSnapshot(bars, inp.timeframe);
    const sq = squeeze(bars);
    const last = sq[sq.length - 1] ?? snap?.squeeze ?? null;
    const rank = snap?.bb_width_rank_90 ?? null;
    const atrRank = snap?.atr_pct_rank_90 ?? null;
    const barsOn = last?.bars_on ?? 0;
    const rankMax = val(spec, 'bb_width_rank_max', 20);
    const barsMin = val(spec, 'squeeze_bars_min', 6);
    const compressed = (rank !== null && rank <= rankMax) || barsOn >= barsMin;
    const volRatio = inp.features[0]?.vol_ratio_20 ?? null;
    const spikeMin = val(spec, 'vol_spike_min', 1.8);
    const value = [
      `带宽 90 根分位 ${rank === null ? 'n/a' : `${rank.toFixed(0)}%`}(门槛 ≤ ${rankMax}%)`,
      `ATR% 90 根分位 ${atrRank === null ? 'n/a' : `${atrRank.toFixed(0)}%`}`,
      `squeeze ${last?.on ? '开' : '关'},已连续 ${barsOn} 根(门槛 ≥ ${barsMin} 根)`,
      `压缩成立=${compressed ? '是' : '否'}`,
      `当根量比 ${volRatio === null ? 'n/a' : volRatio.toFixed(2)}(扩张门槛 ≥ ${spikeMin})`,
      `扩张成立=${compressed && volRatio !== null && volRatio >= spikeMin ? '是' : '否'}(还需同根出现突破)`,
    ].join(';');
    return [{ label: '压缩→扩张清单(代码计算)', value, observed_at: bars[bars.length - 1]?.close_time ?? inp.now, source: 'indicatorSnapshot()+squeeze()' }];
  },

  funding_oi_extreme: (spec, inp) => {
    const cur = inp.market.funding_rate === '' ? null : Number(inp.market.funding_rate);
    if (cur === null || !Number.isFinite(cur)) {
      return [{ label: '资金费率极值(代码计算)', value: '这个时刻取不到资金费率——本次不得按本策略 PROPOSE', observed_at: inp.now, source: 'fapi premiumIndex(缺失)' }];
    }
    const { z, samples, mean: m, sd } = fundingZScore(inp.funding_history, cur, inp.now);
    const absMin = val(spec, 'funding_abs_min', 0.05);
    const zMin = val(spec, 'funding_z_min', 2);
    const oiMin = val(spec, 'oi_change_min', 1);
    const curPct = cur * 100;
    const minsToFunding = Math.max(0, Math.round((inp.market.next_funding_at - inp.now) / 60_000));
    const oi = inp.oi_change_1h_pct;
    const extreme = Math.abs(curPct) >= absMin && z !== null && Math.abs(z) >= zMin;
    const value = [
      `当前费率 ${curPct.toFixed(4)}%(绝对值门槛 ${absMin}%)`,
      samples ? `30 天样本 ${samples} 次,均值 ${((m ?? 0) * 100).toFixed(4)}%,标准差 ${((sd ?? 0) * 100).toFixed(4)}%,z=${z === null ? 'n/a' : z.toFixed(2)}(门槛 ${zMin})` : '30 天历史不可得,z 无法计算',
      `极值成立=${extreme ? '是' : '否'}`,
      `OI 较 1h 前 ${oi === null ? 'n/a' : `${oi >= 0 ? '+' : ''}${oi.toFixed(2)}%`}(确认门槛 ±${oiMin}%,下降→fade,上升→只顺势限价)`,
      `距下次结算 ${minsToFunding} 分钟(${val(spec, 'minutes_before_funding', 30)} 分钟内不新开)`,
    ].join(';');
    return [{ label: '资金费率极值(代码计算)', value, observed_at: inp.market.as_of, source: 'fapi fundingRate 历史 + openInterestHist' }];
  },

  range_mean_reversion: (spec, inp) => {
    const out: StrategyEvidenceLine[] = [];
    const bars = baseBars(inp);
    const horizon = Math.round(val(spec, 'horizon_bars', 12));
    const devMin = val(spec, 'dev_atr_min', 2);
    const stats: ReversionStats | null = bars.length ? reversionStats(bars, { tf: inp.timeframe, horizons: [...new Set([6, 12, 24, horizon])].sort((a, b) => a - b) }) : null;
    out.push(
      stats
        ? { label: '回归统计(代码计算)', value: stats.text, observed_at: bars[bars.length - 1]?.close_time ?? inp.now, source: 'reversionStats()' }
        : { label: '回归统计(代码计算)', value: `可见 K 线 ${bars.length} 根,不足 400 根,历史回归概率不可得——本次不得按本策略 PROPOSE`, observed_at: inp.now, source: 'reversionStats()(样本不足)' },
    );
    const base = inp.features[0];
    if (base) {
      const dev = base.atr14 > 0 ? (base.last_close - base.ema20) / base.atr14 : null;
      const snap = bars.length >= 30 ? indicatorSnapshot(bars, inp.timeframe) : null;
      const adx = snap?.adx14?.adx ?? null;
      const adxMax = val(spec, 'adx_max', 20);
      const ranging = (inp.daily_regime?.regime === 'range') || (adx !== null && adx < adxMax);
      out.push({
        label: '偏离/震荡清单(代码计算)',
        value: [
          `价距 EMA20 ${dev === null ? 'n/a' : `${dev >= 0 ? '+' : ''}${dev.toFixed(2)} ATR`}(门槛 ${devMin} ATR,${dev !== null && dev > 0 ? '在上方→只考虑做空' : '在下方→只考虑做多'})`,
          `ADX14 ${adx === null ? 'n/a' : adx.toFixed(1)}(上限 ${adxMax})`,
          `日线状态 ${inp.daily_regime?.regime ?? 'n/a'}`,
          `震荡成立=${ranging ? '是' : '否'};偏离成立=${dev !== null && Math.abs(dev) >= devMin ? '是' : '否'}`,
        ].join(';'),
        observed_at: base.last_open_time,
        source: 'indicatorSnapshot()+dailyRegime()',
      });
    }
    return out;
  },
};

/**
 * 一条策略的参数 → 扫描清单要用的门槛(`scanChecklist(features, klines, thresholds)`)。
 *
 * 刻意**不**映射 `atr_pct_floor`:决定稿 §2 采纳 B 已经把 ATR% 门槛从"一个 0.4%"改成
 * review-metrics.ts 里的分周期表(15m 0.15%),策略参数里那个 0.4 是改之前的遗留值,拿它去覆盖
 * 分周期表等于把 15m 重新封死。其余三个是真正由策略版本决定的数。
 */
export function scanThresholdsOf(spec: StrategySpec): ScanThresholds {
  return {
    // 兜底值刻意写死而不是 import review-metrics 的常量:那会给 strategies.ts 加一条到 market.ts 的
    // 模块边,而 market.ts 的 base URL 曾经是 import 时求值的(见 market.ts `fapi()`)。数值同源于
    // CHASE_ATR_MAX / RETEST_VOL_MIN / BREAKOUT_WINDOW,由 funnel.test.ts 钉住。
    chase_atr_max: spec.params['chase_atr_max']?.value ?? 1.5,
    retest_vol_min: spec.params['retest_vol_min']?.value ?? 1,
    breakout_window: spec.params['breakout_window']?.value ?? 1,
  };
}

/**
 * `breakout_retest` v2 的草稿(docs/research/zero-propose-funnel-2026-09-05.md §5)。开机时若不存在
 * 就生成一次,状态停在 `backtest`(不是 active,也进不了实盘 —— 实盘只认 ≥ paper,`resolve()` 会退回
 * 到仍是 paper 的 v1)。参数依据是漏斗跑出来的真数:窗口 1 根让"突破-回踩"这个形态整个不可达,
 * 量比放在回踩那根天然不成立;把两处改掉是 27 币 60 天里唯一能把机械期望拉回 0 附近的组合。
 */
export const BREAKOUT_RETEST_V2: { params: Record<string, number>; rules: Partial<StrategySpec['rules']> } = {
  params: { breakout_window: 12, retest_vol_min: 2 },
  rules: {
    entry: [
      '方向随 1h EMA20/EMA50;4h 反向只许限价回踩、信心 ≤ 0.5。',
      '突破发生在最近 breakout_window 根内(与突破位比的是**该根之前**的 20 根高/低),且那根量比 ≥ retest_vol_min → 现在的回踩可以做;回踩那根本身缩量不算否决。',
      '距突破位 > chase_atr_max ATR 或 ATR% < 分周期门槛不做;日线 bear 不做多、bull 不做空,range 要量比 ≥ range_vol_min。',
    ],
  },
};

export function ensureBreakoutRetestV2(lib: StrategyLibrary, now = Date.now()): StrategySpec | null {
  const head = lib.head('breakout_retest');
  if (!head) return null;
  // Idempotent by content, not by version number: a user-made draft must not block (or be mistaken for) the
  // relaxed variant. It exists iff some version already carries the v2 breakout_window value.
  const want = BREAKOUT_RETEST_V2.params['breakout_window'];
  if (lib.versions('breakout_retest').some((v) => v.params['breakout_window']?.value === want && v.params['retest_vol_min']?.value === BREAKOUT_RETEST_V2.params['retest_vol_min'])) return null;
  if (!head.params['breakout_window']) return null; // 老库还没回填这个旋钮,下次开机再说
  const { spec } = lib.createVersion('breakout_retest', { params: { ...BREAKOUT_RETEST_V2.params }, rules: { ...BREAKOUT_RETEST_V2.rules } }, { now });
  if (!spec) return null;
  return lib.promote('breakout_retest', 'backtest').spec ?? spec;
}

export function strategyEvidence(spec: StrategySpec, inp: StrategyEvidenceInput): StrategyEvidenceLine[] {
  const fn = STRATEGY_EVIDENCE[spec.id === 'swing_breakout_retest' || spec.id === 'position_breakout_retest' ? 'breakout_retest' : spec.id];
  if (!fn) return [];
  try {
    return fn(spec, inp);
  } catch (e) {
    return [{ label: `${spec.name} 清单(代码计算)`, value: `清单计算失败:${(e as Error).message.slice(0, 120)}——本次不得按本策略 PROPOSE`, observed_at: inp.now, source: 'strategyEvidence()' }];
  }
}

// ---------------------------------------------------------------- 渲染进 prompt

/** 一条策略在 system prompt 里的样子;刻意短(两条 active 加起来 ≤ ~900 字)。 */
export function renderStrategy(s: StrategySpec): string {
  const params = Object.entries(s.params).map(([k, v]) => `${k}=${v.value}${v.unit ?? ''}`).join(' ');
  const hp = HORIZON_POLICY[s.horizon ?? inferHorizon(s.trigger.min_timeframe)];
  const lines = [`【${s.id}·${s.name} v${s.version}】`, `持有周期 horizon=${s.horizon};复查 ${hp.timeframe} 每 ${hp.review_bars} 根;止损至少 ${hp.stop_atr} ATR,入场区宽度参考 ${hp.entry_zone_atr} ATR(均为 ${hp.timeframe});长线策略不用短线思维。`, `入场:${s.rules.entry.join('')}`, `失效:${s.rules.invalidation.join('')}`, `离场:${s.rules.exit.join('')}`];
  if (s.rules.sizing_note) lines.push(`仓位:${s.rules.sizing_note}`);
  if (params) lines.push(`参数:${params}`);
  return lines.join('\n');
}

export function renderStrategies(specs: StrategySpec[]): string {
  return specs.map(renderStrategy).join('\n');
}

// ---------------------------------------------------------------- shadow → paper 的门(09-12 §1.2)

/** 预注册门槛；family 覆盖为空，不能为了让数据过门降低阈值。 */
export const PROMOTION_POLICY = {
  defaults: { oos_min_n: 30, oos_ci_lower: 0, dsr_min: 0, nonnegative_regimes: 2, max_dd_r: 3, shadow_min_n: 20, shadow_min_net_expectancy: 0.1, shadow_oos_divergence: 0.3 },
  families: {} as Partial<Record<StrategyFamily, Partial<{ oos_min_n: number; oos_ci_lower: number; dsr_min: number; nonnegative_regimes: number; max_dd_r: number; shadow_min_n: number; shadow_min_net_expectancy: number; shadow_oos_divergence: number }>>>,
};
export const SHADOW_MIN_N = PROMOTION_POLICY.defaults.shadow_min_n;
export const SHADOW_MIN_EXPECTANCY_R = PROMOTION_POLICY.defaults.shadow_min_net_expectancy;
export const SHADOW_LAB_DIVERGENCE_MAX_R = PROMOTION_POLICY.defaults.shadow_oos_divergence;
export const SHADOW_MAX_DRAWDOWN_R = PROMOTION_POLICY.defaults.max_dd_r;
export function promotionGaps(s: StrategySpec): Record<string, number | null> {
  const policy = { ...PROMOTION_POLICY.defaults, ...PROMOTION_POLICY.families[s.family] };
  const lab = s.lab_stats;
  const regimes = Object.entries(lab?.regime ?? {}).filter(([key, b]) => key !== 'unknown' && b.n > 0 && b.net_expectancy !== null && b.net_expectancy >= 0).length;
  return {
    oos_n_missing: Math.max(0, policy.oos_min_n - (lab?.oos_n ?? 0)),
    oos_ci_lower: lab?.oos_ci?.lower ?? null,
    oos_ci_gap: lab?.oos_ci?.lower == null ? null : Math.max(0, policy.oos_ci_lower - lab.oos_ci.lower),
    dsr: lab?.dsr ?? null,
    dsr_gap: lab?.dsr == null ? null : Math.max(0, policy.dsr_min - lab.dsr),
    regime_buckets_missing: Math.max(0, policy.nonnegative_regimes - regimes),
    max_dd_excess_r: lab?.max_dd_r == null ? null : Math.max(0, lab.max_dd_r - policy.max_dd_r),
    shadow_n_missing: Math.max(0, policy.shadow_min_n - (lab?.shadow?.n ?? 0)),
    shadow_net_gap: lab?.shadow?.net_expectancy_r == null ? null : Math.max(0, policy.shadow_min_net_expectancy - lab.shadow.net_expectancy_r),
    shadow_net_dd_excess: lab?.shadow?.net_max_drawdown_r == null ? null : Math.max(0, lab.shadow.net_max_drawdown_r - policy.max_dd_r),
    shadow_oos_divergence_excess: lab?.shadow?.net_expectancy_r == null || lab.oos_net_expectancy == null ? null : Math.max(0, Math.abs(lab.shadow.net_expectancy_r - lab.oos_net_expectancy) - policy.shadow_oos_divergence),
  };
}
/** 旧毛收益不能替代净值，未知数据 fail closed。 */
export function shadowToPaperGate(s: StrategySpec): string | null {
  const policy = { ...PROMOTION_POLICY.defaults, ...PROMOTION_POLICY.families[s.family] };
  const sh = s.lab_stats?.shadow;
  if (!sh || sh.n <= 0) return '还没有影子实盘数据';
  if (sh.n < policy.shadow_min_n) return `影子实盘只有 ${sh.n} 笔,不足 ${policy.shadow_min_n} 笔,还差 ${policy.shadow_min_n - sh.n}`;
  if (sh.net_expectancy_r == null || sh.net_max_drawdown_r == null || !Number.isFinite(sh.net_expectancy_r) || !Number.isFinite(sh.net_max_drawdown_r)) return '缺影子实盘净期望/净回撤，旧毛收益不能晋升';
  if (sh.net_expectancy_r < policy.shadow_min_net_expectancy) return `影子净期望 ${sh.net_expectancy_r.toFixed(2)}R < ${policy.shadow_min_net_expectancy}R,还差 ${(policy.shadow_min_net_expectancy - sh.net_expectancy_r).toFixed(3)}R`;
  if (sh.net_max_drawdown_r > policy.max_dd_r) return `影子最大回撤(净) ${sh.net_max_drawdown_r.toFixed(2)}R > ${policy.max_dd_r}R`;
  const lab = s.lab_stats?.oos_net_expectancy;
  if (lab == null || !Number.isFinite(lab)) return '缺 Lab OOS 净期望，不能检验一致性';
  if (Math.abs(sh.net_expectancy_r - lab) > policy.shadow_oos_divergence) return `影子净期望与 Lab OOS 净期望差 ${Math.abs(sh.net_expectancy_r - lab).toFixed(2)}R > ${policy.shadow_oos_divergence}R(两套口径不一致)`;
  return null;
}

// ---------------------------------------------------------------- 持久化

function readStrategy(json: string): StrategySpec {
  const s = JSON.parse(json) as StrategySpec;
  return { ...s, horizon: s.horizon ?? inferHorizon(s.trigger.min_timeframe) };
}

interface Row {
  json: string;
}

export interface PromoteResult {
  spec: StrategySpec | null;
  error: string | null;
}

export class StrategyLibrary {
  constructor(private readonly db: DatabaseSync) {}

  /** 首次启动写入内置策略;已存在的 (id, version 1) 一律不动 → 幂等。返回新写入的条数。 */
  seed(now = Date.now()): number {
    let n = 0;
    for (const s of BUILTIN_STRATEGIES) {
      const stored = this.version(s.id, 1);
      if (stored) {
        this.backfillParams(stored, s);
        continue;
      }
      this.write({ ...s, created_at: now });
      n++;
    }
    return n;
  }

  /**
   * 内置策略 v1 的**结构**补齐:代码里新加了一个旋钮(比如 `breakout_window`),而库里那行 v1 是加之前
   * 写的 —— 不补的话 `createVersion` 会说"策略没有参数 breakout_window",这个旋钮就永远调不了。
   *
   * 只加不改:已经存在的参数(value/min/max)一个字都不动,所以 v1 的**行为**完全不变;补进去的默认值
   * 就是"现行行为"(breakout_window=1)。这不是改参数,是把旧行迁到新结构上,和 §「不可变版本对象」
   * 的红线不冲突 —— 那条红线管的是"谁能改一条在跑的策略的数字",答案仍然是:只能生成新版本。
   */
  private backfillParams(stored: StrategySpec, builtin: StrategySpec): void {
    const missing = Object.keys(builtin.params).filter((k) => !stored.params[k]);
    // 09-12:checklist.min_bars 也是「新加的结构」——老库里那行 v1 没有它,不补就还是只拉 60 根,
    // 回归策略会继续永远弃权。它不进 content_hash,所以补它不改版本身份。
    const needBars = builtin.checklist.min_bars !== undefined && stored.checklist.min_bars === undefined;
    if (!missing.length && !needBars) return;
    const params = { ...stored.params };
    for (const k of missing) params[k] = { ...builtin.params[k]! };
    const next: StrategySpec = { ...stored, params, checklist: needBars ? { ...stored.checklist, min_bars: builtin.checklist.min_bars! } : stored.checklist };
    this.write({ ...next, content_hash: strategyContentHash(next) });
  }

  private write(s: StrategySpec): void {
    this.db
      .prepare(
        `INSERT INTO demo_strategy_version(id, version, content_hash, status, name, family, parent_version, created_at, json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id, version) DO UPDATE SET status = excluded.status, json = excluded.json`,
      )
      .run(s.id, s.version, s.content_hash, s.status, s.name, s.family, s.parent_version ?? null, s.created_at, JSON.stringify(s));
  }

  version(id: string, version: number): StrategySpec | null {
    const r = this.db.prepare('SELECT json FROM demo_strategy_version WHERE id = ? AND version = ?').get(id, version) as Row | undefined;
    return r ? readStrategy(r.json) : null;
  }

  /** 一条策略的所有版本,新的在前。 */
  versions(id: string): StrategySpec[] {
    const rows = this.db.prepare('SELECT json FROM demo_strategy_version WHERE id = ? ORDER BY version DESC').all(id) as unknown as Row[];
    return rows.map((r) => readStrategy(r.json));
  }

  /** 最新版本(head)。 */
  head(id: string): StrategySpec | null {
    const rows = this.db.prepare('SELECT json FROM demo_strategy_version WHERE id = ? ORDER BY version DESC LIMIT 1').all(id) as unknown as Row[];
    return rows[0] ? readStrategy(rows[0].json) : null;
  }

  /** 每条策略的 head,按 id 排序。 */
  list(opts: { include_retired?: boolean } = {}): StrategySpec[] {
    const ids = (this.db.prepare('SELECT DISTINCT id FROM demo_strategy_version ORDER BY id ASC').all() as { id: string }[]).map((r) => r.id);
    const out: StrategySpec[] = [];
    for (const id of ids) {
      const h = this.head(id);
      if (!h) continue;
      if (!opts.include_retired && h.status === 'retired') continue;
      out.push(h);
    }
    return out;
  }

  /**
   * 把 workflow.active_strategies / 回测参数里的 id 解析成 head 版本。
   * `allow_below_paper` = 回测/影子允许;实盘只认 status ≥ paper(决定稿 §2 F)。
   */
  resolve(ids: string[], opts: { allow_below_paper?: boolean; backend?: string } = {}): { specs: StrategySpec[]; errors: string[] } {
    const specs: StrategySpec[] = [];
    const errors: string[] = [];
    for (const id of [...new Set(ids)]) {
      const raw = this.head(id);
      const withHealth = (v: StrategySpec): StrategySpec => strategyForBackend(v, opts.backend ?? 'paper');
      const s = raw ? withHealth(raw) : null;
      if (!s) {
        errors.push(`策略 ${id} 不在策略库里`);
        continue;
      }
      if (s.status === 'retired') {
        errors.push(`策略 ${id} 已退役`);
        continue;
      }
      if (!opts.allow_below_paper && STATUS_ORDER.indexOf(s.status) < STATUS_ORDER.indexOf('paper')) {
        // head 是个还没晋升的新版本(草稿/回测中)时,实盘继续跑**仍然是 paper 的那一版**,而不是
        // 整条策略静默失效。没有这一步,"生成一个 v2 草稿去回测"会顺手把线上判断的策略清空。
        const fallback = this.versions(id).map(withHealth).find((v) => v.status !== 'retired' && STATUS_ORDER.indexOf(v.status) >= STATUS_ORDER.indexOf('paper'));
        if (!fallback) {
          errors.push(`策略 ${id} 状态是 ${s.status},未到 paper,不能在实盘判断里启用`);
          continue;
        }
        specs.push(fallback);
        continue;
      }
      specs.push(s);
    }
    return { specs, errors };
  }

  /** 从提案生成一个新 draft 版本(参数只能落在各自 [min,max] 内)。 */
  createVersion(id: string, patch: { params?: Record<string, number>; rules?: Partial<StrategySpec['rules']>; name?: string; horizon?: StrategyHorizon; evidence?: StrategyEvidenceSpec | null }, opts: { now?: number } = {}): { spec: StrategySpec | null; error: string | null } {
    const head = this.head(id);
    if (!head) return { spec: null, error: `策略 ${id} 不存在` };
    const params: StrategySpec['params'] = {};
    for (const [k, v] of Object.entries(head.params)) params[k] = { ...v };
    for (const [k, v] of Object.entries(patch.params ?? {})) {
      const cur = params[k];
      if (!cur) return { spec: null, error: `策略 ${id} 没有参数 ${k}` };
      const n = Number(v);
      if (!Number.isFinite(n)) return { spec: null, error: `参数 ${k} 必须是数字` };
      if (n < cur.min || n > cur.max) return { spec: null, error: `参数 ${k} = ${n} 超出范围 [${cur.min}, ${cur.max}]` };
      params[k] = { ...cur, value: n };
    }
    const rules: StrategySpec['rules'] = {
      entry: patch.rules?.entry ?? head.rules.entry,
      invalidation: patch.rules?.invalidation ?? head.rules.invalidation,
      exit: patch.rules?.exit ?? head.rules.exit,
      ...(patch.rules?.sizing_note ?? head.rules.sizing_note ? { sizing_note: patch.rules?.sizing_note ?? head.rules.sizing_note } : {}),
    };
    const name = (patch.name ?? head.name).slice(0, 40);
    if (patch.horizon !== undefined && !(patch.horizon in HORIZON_POLICY)) return { spec: null, error: '无效 horizon' };
    const evidence = patch.evidence === undefined ? head.evidence ?? null : patch.evidence;
    const content = { name, horizon: patch.horizon ?? head.horizon, family: head.family, trigger: head.trigger, checklist: head.checklist, rules, params, ...(evidence ? { evidence } : {}) };
    const hash = strategyContentHash(content);
    if (hash === head.content_hash) return { spec: null, error: '内容没有变化,不生成新版本' };
    const spec: StrategySpec = {
      ...head,
      ...content,
      evidence, // 显式落一次:patch.evidence=null 是「清空,回到默认集」,不能让 head 的旧值漏过来
      version: head.version + 1,
      content_hash: hash,
      status: 'draft',
      health_by_backend: {},
      shadow_generation: 0,
      shadow_window_from: 0,
      eval_stats: { ...EMPTY_EVAL_STATS },
      lab_stats: null, // 新版本没有任何证据,不继承上一版的 Lab 数据
      created_at: opts.now ?? Date.now(),
      parent_version: head.version,
    };
    this.write(spec);
    return { spec, error: null };
  }

  /** 晋升门(design 稿 §5):只往前走一格,且要过对应的统计门。 */
  promoteGate(s: StrategySpec, to: StrategyStatus, opts: { confirm?: boolean } = {}): string | null {
    const evaluate = (): string | null => {
    if (s.status === 'retired') return '已退役的策略不能晋升,先生成新版本';
    const from = STATUS_ORDER.indexOf(s.status);
    const next = STATUS_ORDER.indexOf(to);
    if (next < 0) return `不能晋升到 ${to}`;
    if (next !== from + 1) return `只能一格一格晋升:${s.status} 的下一格是 ${STATUS_ORDER[from + 1] ?? '(没有了)'}`;
    if (to === 'shadow') {
      const p = { ...PROMOTION_POLICY.defaults, ...PROMOTION_POLICY.families[s.family] };
      const lab = s.lab_stats;
      const gaps = promotionGaps(s);
      const missing: string[] = [];
      if ((lab?.oos_n ?? 0) < p.oos_min_n) missing.push(`OOS 成交不足 ${p.oos_min_n} 笔,还差 ${gaps.oos_n_missing}`);
      if (lab?.oos_ci?.status !== 'sufficient' || lab.oos_ci.lower == null || !Number.isFinite(lab.oos_ci.lower) || lab.oos_ci.lower <= p.oos_ci_lower) missing.push('OOS 净期望 CI 下界须 > 0');
      if (lab?.dsr == null || !Number.isFinite(lab.dsr) || lab.dsr <= p.dsr_min) missing.push('DSR 须 > 0');
      if ((gaps.regime_buckets_missing ?? 1) > 0) missing.push(`非负 regime 还差 ${gaps.regime_buckets_missing} 桶`);
      if (lab?.max_dd_r == null || !Number.isFinite(lab.max_dd_r) || lab.max_dd_r > p.max_dd_r) missing.push(`OOS 净最大回撤须 ≤ ${p.max_dd_r}R`);
      if (missing.length) return missing.join(';');
    }
    if (to === 'paper') return shadowToPaperGate(s);
    if (to === 'live_capped') {
      if (!opts.confirm) return '进限额实盘必须人工确认(confirm=true)';
      if (s.eval_stats.trades < 30) return '完整策略 eval 有效样本须 ≥ 30';
      if (s.eval_stats.expectancy_r == null || !Number.isFinite(s.eval_stats.expectancy_r) || s.eval_stats.expectancy_r < 0.15) return '完整策略 eval 净期望须 ≥ 0.15R';
    }
    return null;
    };
    const blocked = evaluate();
    this.db.prepare('INSERT INTO demo_strategy_event(strategy_id, version, at, who, kind, from_status, to_status, reason, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.id, s.version, Date.now(), 'code', 'gate_check', s.status, to, blocked ?? '统计门通过', JSON.stringify(promotionGaps(s)));
    return blocked;
  }

  promote(id: string, to: StrategyStatus, opts: { confirm?: boolean; backend?: string; version?: number } = {}): PromoteResult {
    const raw = opts.version === undefined ? this.head(id) : this.version(id, opts.version);
    const head = raw && opts.backend ? strategyForBackend(raw, opts.backend) : raw;
    if (!head) return { spec: null, error: `策略 ${id} 不存在` };
    const gate = this.promoteGate(head, to, opts);
    if (gate) return { spec: null, error: gate };
    const next: StrategySpec = opts.backend ? { ...raw!, health_by_backend: { ...raw!.health_by_backend, [opts.backend]: { status: to, generation: raw!.health_by_backend?.[opts.backend]?.generation ?? 0, window_from: raw!.health_by_backend?.[opts.backend]?.window_from ?? 0 } } } : { ...head, status: to, ...((to === 'paper' || to === 'live_capped' || head.health_by_backend?.paper) ? { health_by_backend: { ...head.health_by_backend, paper: { status: to, generation: head.shadow_generation ?? 0, window_from: head.shadow_window_from ?? 0 } } } : {}) };
    this.write(next);
    return { spec: next, error: null };
  }

  retire(id: string): PromoteResult {
    const head = this.head(id);
    if (!head) return { spec: null, error: `策略 ${id} 不存在` };
    if (head.status === 'retired') return { spec: head, error: null };
    const next: StrategySpec = { ...head, status: 'retired' };
    this.write(next);
    return { spec: next, error: null };
  }

  /**
   * 09-12 §1.2 降级:paper 及以上连续劣化时**退回 backtest 重来**,不是退役。
   * 退役是「这条策略不要了」,降级是「这一版还得再测一轮」——两者的后续动作完全不同,不能混。
   * 只允许往回走(到比现状低的一格),不能拿它当晋升的后门。
   */
  demote(id: string, to: StrategyStatus = 'backtest', opts: { version?: number; backend?: string; now?: number } = {}): PromoteResult {
    const raw = opts.version === undefined ? this.head(id) : this.version(id, opts.version);
    const head = raw && opts.backend ? strategyForBackend(raw, opts.backend) : raw;
    if (!head) return { spec: null, error: `策略 ${id} 不存在` };
    if (head.status === 'retired') return { spec: null, error: '已退役的策略不用降级' };
    const from = STATUS_ORDER.indexOf(head.status);
    const next = STATUS_ORDER.indexOf(to);
    if (next < 0) return { spec: null, error: `不能降级到 ${to}` };
    if (next >= from) return { spec: null, error: `${head.status} 不能「降级」到 ${to}` };
    const now = opts.now ?? Date.now();
    const generation = (head.shadow_generation ?? 0) + 1;
    const health = opts.backend ? { ...head.health_by_backend, [opts.backend]: { status: to, generation: (head.health_by_backend?.[opts.backend]?.generation ?? 0) + 1, window_from: now } } : { ...head.health_by_backend, paper: { status: to, generation, window_from: now } };
    const spec: StrategySpec = { ...head, status: opts.backend ? raw!.status : to, ...(health ? { health_by_backend: health } : {}), shadow_generation: generation, shadow_window_from: now, lab_stats: head.lab_stats ? { ...head.lab_stats, shadow: null, shadow_by_backend: { ...head.lab_stats.shadow_by_backend, [opts.backend ?? 'paper']: { ...EMPTY_SHADOW_STATS } } } : null };
    this.write(spec);
    return { spec, error: null };
  }

  /**
   * 09-12 §1.1 发现:落一条**全新策略**的 v1 草稿(假设生成器唯一的落库入口)。
   * 状态强制 draft、统计强制清空——模型在这里没有任何晋升权,它只能提出一个待测的形状。
   * id 已存在 → 直接拒(新族不许覆盖老族;想改老族请走 createVersion)。
   */
  createDraft(input: Omit<StrategySpec, 'version' | 'content_hash' | 'created_at' | 'status' | 'eval_stats' | 'lab_stats' | 'parent_version'>, opts: { now?: number } = {}): { spec: StrategySpec | null; error: string | null } {
    if (this.head(input.id)) return { spec: null, error: `策略 ${input.id} 已存在` };
    const hash = strategyContentHash(input);
    for (const row of this.db.prepare('SELECT json FROM demo_strategy_version WHERE content_hash = ? LIMIT 1').all(hash) as unknown as Row[]) {
      const dup = readStrategy(row.json);
      return { spec: null, error: `内容与已有策略 ${dup.id} v${dup.version} 完全相同(hash ${hash.slice(0, 12)}),不重复建` };
    }
    const spec: StrategySpec = {
      ...input,
      version: 1,
      content_hash: hash,
      status: 'draft',
      health_by_backend: {},
      shadow_generation: 0,
      shadow_window_from: 0,
      eval_stats: { ...EMPTY_EVAL_STATS },
      lab_stats: null,
      created_at: opts.now ?? Date.now(),
      parent_version: null,
    };
    this.write(spec);
    return { spec, error: null };
  }

  /** 09-07:Lab 实验结果按精确版本写回(不动 eval_stats)。版本不存在 → null。 */
  updateLabStats(id: string, version: number, stats: LabStats): StrategySpec | null {
    const s = this.version(id, version);
    if (!s) return null;
    // 影子成绩由 updateShadowStats 单独写;Lab 重跑不能顺手把它抹掉。
    const shadow = s.lab_stats?.shadow ?? null;
    const next: StrategySpec = { ...s, lab_stats: { ...stats, ...(s.lab_stats?.shadow_by_backend ? { shadow_by_backend: s.lab_stats.shadow_by_backend } : {}), shadow } };
    this.write(next);
    return next;
  }

  /**
   * 09-12:影子实盘成绩按精确版本写回 `lab_stats.shadow`。这个版本还没跑过 Lab 时先落一条
   * 空壳 lab_stats(n=0),免得「有影子数据但没有 lab_stats」这条路径丢数据。
   */
  updateShadowStats(id: string, version: number, shadow: ShadowStats, backend?: string): StrategySpec | null {
    const s = this.version(id, version);
    if (!s) return null;
    const base: LabStats = s.lab_stats ?? { run_id: '', at: shadow.last_at ?? 0, symbols: 0, setups: 0, n: 0, win_rate: null, expectancy_r: null, total_r: 0, note: '没跑过漏斗实验,只有影子实盘数据' };
    const next: StrategySpec = { ...s, lab_stats: { ...base, shadow_by_backend: { ...base.shadow_by_backend, [backend ?? 'paper']: shadow }, shadow } };
    this.write(next);
    return next;
  }

  updateEvalStatsExact(id: string, version: number, hash: string, stats: Omit<StrategyEvalStats, 'backtests'>): StrategySpec | null {
    const spec = this.version(id, version);
    if (!spec || spec.content_hash !== hash) return null;
    const next = { ...spec, eval_stats: { ...stats, backtests: spec.eval_stats.backtests + 1 } };
    this.write(next); return next;
  }

  /** 回测跑完后更新这条策略 head 的评测统计(累加 backtests,其余覆盖成最近一次)。 */
  updateEvalStats(id: string, stats: Omit<StrategyEvalStats, 'backtests'>): StrategySpec | null {
    const head = this.head(id);
    if (!head) return null;
    const next: StrategySpec = { ...head, eval_stats: { ...stats, backtests: head.eval_stats.backtests + 1 } };
    this.write(next);
    return next;
  }
}
