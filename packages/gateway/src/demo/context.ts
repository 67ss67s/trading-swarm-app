import { RR_PROMPT } from './rr-prompt.js';
import { DEFAULT_EXECUTION_THRESHOLDS, renderStopFloor, type ExecutionThresholds } from './execution-policy.js';
import { evaluateHoldingReview, renderAtrChoices, renderFreeAtrChoices, type HoldingReview, type HoldingInputs } from './holding-policy.js';
import { HORIZON_POLICY, inferHorizon, threadHorizon, reviewTimeframe } from './horizon.js';
import type { CouncilResult, CouncilReview } from './strategy-council.js';
import { entryStyleAdvice, pendingEntryMetrics, type EntryStyle, type EntryStyleAdvice, type PendingEntryMetrics } from './entry-policy.js';
// EpisodeBuilder + ContextBuilder (docs/demo/README.md §5.2–5.3, v2-agent-loop.md §5). One function
// turns live inputs into (a) an evidence registry E1..En with as_of/source/staleness and (b) the exact
// text the model sees. The same text is stored on the episode, so replay == what the model saw.

import { createHash } from 'node:crypto';
import type { AccountView, Evidence, MarketState, MarketView, MemoryItem, StrategyThread, Trigger , DailyRegime, SessionInfo, TriggerHit } from './types.js';
import { memoryKindLabel } from './memory.js';
import type { TfFeatures } from './market.js';
import { tfToMs } from './market.js';
import { reviewMetrics, scanChecklist } from './review-metrics.js';
import { allowedActions, nodeFor, type NodeId } from './graph.js';
import { evidenceOf, renderStrategies, scanThresholdsOf, strategyEvidence, type StrategySpec } from './strategies.js';
import { evidencePlan, indicatorKey, renderIndicator } from './evidence-plan.js';
import { indicatorSnapshot, indicatorWithParams, minBarsForIndicator } from './indicators.js';
import type { Kline } from './types.js';
// **只导入类型**:events.ts 会拉进 info.ts,而 info.ts 的 FAPI/FNG 地址是模块级 const —— 一旦 context.ts
// 把它变成静态依赖,info.test.ts「设好 env 再动态 import info.js」的写法就会拿到冻结的真实地址。
// 窗口起点在这里手算一行(和 events.ts eventStartAt 同义),别为省一行把整条依赖拉回来。
import type { EventStats, MarketEvent } from './events.js';
import { flagWords } from './output-language.js';

export const PROMPT_VERSION = 'demo-playbook-v11.2-stopfloor'; // v11.2(09-27): 规则 5 的止损底线从写死的 0.3%–5% 改成按执行层当前模式给数(默认至少 1%),没绑策略的扫盘多一条「止损底线」计划证据 // v11.1(09-23): 「最近 4 根」OHLC 小数跟价格走(低价币之前全是 0)+ 同周期结构行去重;user 文本变了所以升号 // v11(09-12 P1-16): 规则 2b/2c 的派生数标注从「只给证据编号」改成「必须写字段级公式」,语义变了就必须换版本号 —— 它是 eval 回答的缓存键(eval-a/run.ts、eval-b/runner.ts),而 context_hash 只覆盖 user 侧文本、不含 system_text,不升号的话旧格式的缓存回答会被复用、在新口径下全判成幻觉 // v7.1: scan:stale 节点的允许集写进任务行(stale 变体越图 PROPOSE 3/266) // v7: 失效价越过从「必须 EXIT」降为「可以 EXIT」(带确认口径),只有止损是硬离场

export interface EpisodeInputs {
  verified_event?: HoldingInputs['event'];
  now: number;
  symbol: string;
  trigger: Trigger;
  mode: 'scan' | 'review';
  thread: StrategyThread | null; // the thread under review (mode=review) or null (scan)
  open_threads: StrategyThread[]; // all open threads (for portfolio awareness)
  account: AccountView;
  market: MarketView;
  features: TfFeatures[];
  oi_change_1h_pct: number | null;
  ticker24h: { priceChangePercent: string; highPrice: string; lowPrice: string; quoteVolume: string };
  market_state: MarketState | null;
  playbook_text: string;
  last_judgment_summary: string | null;
  halted: boolean;
  /** v3 code-computed context (optional so recorded v2 eval cases still build). */
  daily_regime?: DailyRegime | null;
  session?: SessionInfo | null;
  trigger_hits?: TriggerHit[];
  /** v3.2: approved long-term memories recalled for this symbol/regime (≤ 5, ≤ ~300 tokens), injected as 记忆 evidence. */
  memories?: MemoryItem[];
  /**
   * v3.5 strategy library (docs/design/strategy-library-2026-09-05.md): the strategies the model may pick
   * from this episode, already resolved to their head versions by the caller (the library does the DB I/O,
   * buildContext stays pure). Empty / absent → only `playbook_text` is rendered, exactly like v4.
   */
  strategies?: StrategySpec[];
  /** Bars visible at `now`, by timeframe — the strategies' checklist hooks need raw klines, features are not enough. */
  klines?: Record<string, Kline[]>;
  /** v3.9:这个币被用户标成只观察(PROPOSE 不是合法边)。 */
  watch_only?: boolean;
  /** 09-09 策略议会结果(scan:各策略表态 + 共识;review:当初同意方的重算)与复核;off 模式不传。 */
  strategy_council?: CouncilResult | null;
  council_review?: CouncilReview | null;
  /** 09-09 入场方式:prefer_limit 时追单的市价开仓会被闸拒(eval 不传 → free)。 */
  entry_style?: EntryStyle;
  /** 09-09 挂单等待上限(根);缺省 8。 */
  entry_max_wait_bars?: number;
  /** v7 失效确认口径(workflow;eval 不传 → 2 根 / 0.2 ATR)。 */
  invalidation_confirm_bars?: number;
  invalidation_buffer_atr?: number;
  /** Funding-rate history (fapi/v1/fundingRate) for the 30-day z-score; absent → that line says "不可得". */
  funding_history?: { at: number; rate: string }[];
  /**
   * 09-12 事件区(§5.2 第 3 步):窗口内、且与这个币相关的事件,调用方(runtime)已经按窗口/资产筛好。
   * 每条会带上 T−N 的一手信息简报和同 subkind 的历史统计——事件只是证据,不构成任何下单权。
   */
  events?: MarketEvent[];
  /** subkind → 同类历史聚合(eventStats);缺就不给先验,不编。 */
  event_stats?: Record<string, EventStats>;
  /**
   * 09-27 §9.56 执行层止损底线(workflow)和本币 stop_floor_atr_tf 那根 ATR 占价格的百分比。
   * 不传(eval 旧用例)= 按默认底线(至少 1%)写进规则。
   */
  stop_floor?: { thresholds: ExecutionThresholds; atr_pct: number | null };
}

/** 证据装载明细的版本号;形状变了就 bump(前端按它判断能不能画细节)。 */
export const EVIDENCE_PLAN_VERSION = 'ep-v2';

/**
 * §9.36(P1-11)**公共最小集**:不管启用哪条策略都会装的那一批证据,**显式固定下来**。
 *
 * Codex 的原话是「context 开头仍无条件装每个 features 周期的 EMA20/50、ATR、极值、量比……
 * 这不是『没有策略要的指标不进 prompt』。如确有公共最小集例外,需显式固定范围和契约」。
 * 这里就是那个范围:它是判断的**地板**(没有它模型连「现在什么价、什么结构」都说不出),
 * 但它**不随 evidence 请求膨胀** —— evidence 点名带进来的额外周期不再自动获得结构行,
 * 要它就在 evidence 里点名要那个周期的指标。
 */
export const PUBLIC_MIN_EVIDENCE = {
  /** 行情四行:最新价/标记价、资金费率、持仓量 OI、24h 变动(后两行没有值时整行不写,不编 0)。 */
  market: ['最新价 / 标记价', '资金费率', '持仓量 OI', '24h 变动 / 高低'] as const,
  /**
   * 会拿到「结构行」(EMA20/50、ATR、20/50 根极值、量比)的周期:**主周期 + 1h + 4h**;
   * 持仓/挂单线程另加它自己的论点/确认周期。仅此而已。
   */
  structure_tfs: ['<primary>', '1h', '4h'] as const,
  /** 主周期最近 4 根原始 K 线。 */
  last_bars: true,
  /** 日线状态、交易时段、本次触发器、已批准的长期记忆。 */
  context: ['日线状态', '交易时段', '本次触发器', '记忆'] as const,
  /** 公共最小集这些行的 `required_by` 写这个常量,**不是空数组** —— 空数组会被读成「没人要」。 */
  required_by: '(公共最小集)',
} as const;

/** 这一轮真正会拿到结构行的周期(公共最小集 + 调用方点名的持仓周期)。 */
export function publicStructureTfs(primaryTf: string, extra: readonly string[] = []): string[] {
  return [...new Set([primaryTf, '1h', '4h', ...extra].filter(Boolean))];
}

/** 一条证据是**从哪条路**进 prompt 的。`research` 目前只有事件简报一种来源。 */
export type EvidencePlanSourceKind = 'indicator' | 'event' | 'news' | 'research' | 'checklist' | 'structure';

/**
 * 「模型这次看到了什么」的一行(减黑盒,设计 §5)。`included=false` 的行是**要了但没装上**,
 * `note` 写为什么(K 线不够、快照算不出来)——不写这行,前端就分不清「没要」和「要了没有」。
 */
export interface EvidencePlanItem {
  kind: EvidencePlanSourceKind;
  /** 稳定键:指标是 `id@tf`,事件是 subkind,新闻是来源,清单是 `策略id:判据`。 */
  key: string;
  label: string;
  /** 哪几条启用策略点名要它(公共证据为空数组)。 */
  required_by: string[];
  included: boolean;
  /** 装上了的话是证据编号 E3,没装上是 null。 */
  ref: string | null;
  source: string;
  note: string | null;
}

/**
 * 这次判断的证据装载计划 + 明细。`hash` 只覆盖**要什么**(策略集合 + 并集后的请求),
 * 不覆盖当时有没有拿到数据 —— 所以同一套启用策略的连续判断共用一个 hash,可以直接分组对比。
 */
export interface EvidencePlanDetail {
  version: string;
  hash: string;
  /** 参与并集的启用策略 id(排序)。 */
  strategies: string[];
  requested: {
    indicators: { id: string; tf: string; params?: Record<string, number>; required_by: string[] }[];
    events: string[];
    info_topics: string[];
  };
  items: EvidencePlanItem[];
  counts: { requested_indicators: number; included_indicators: number; events: number; news: number; research: number; checklist: number };
}

/** 计划哈希:只看「要什么」,不看「拿到没有」(见 {@link EvidencePlanDetail.hash})。 */
export function evidencePlanHash(strategies: string[], requested: EvidencePlanDetail['requested']): string {
  return createHash('sha256')
    .update(JSON.stringify({ v: EVIDENCE_PLAN_VERSION, strategies: [...strategies].sort(), indicators: requested.indicators.map((i) => indicatorKey(i)).sort(), events: [...requested.events].sort(), info_topics: [...requested.info_topics].sort() }))
    .digest('hex');
}

export interface BuiltContext {
  holding_review?: HoldingReview;
  /** 09-09 扫描时的入场方式建议(代码算);runtime 的「入场方式」闸读它。 */
  entry_advice?: EntryStyleAdvice;
  /** 09-09 挂单复查时的耐心度量(代码算)。 */
  pending_entry?: PendingEntryMetrics;
  evidence: Evidence[];
  /** 09-12 §5 减黑盒:这次到底按谁的要求装了哪些证据、哪些要了没装上。 */
  evidence_plan: EvidencePlanDetail;
  /** {@link EvidencePlanDetail.hash} 的副本,方便按计划分组查 episode。 */
  evidence_plan_hash: string;
  system_text: string;
  user_text: string;
  context_text: string;
  context_hash: string;
  allowed_actions: string[];
  /** Judgment-graph node this context was built for (docs/design/graph-engineering-v2.md). */
  node: NodeId;
  /** Strategy ids the judgment's `strategy_id` is validated against (empty = no strategy contract this episode). */
  strategy_ids: string[];
}

const STALE_MS = 3 * 60_000;
const MARKET_STATE_STALE_MS = 3 * 3_600_000;

function fmt(n: number, d = 0): string {
  return Number.isFinite(n) ? n.toFixed(d) : 'n/a';
}

function baseAsset(symbol: string): string {
  return symbol.replace(/USDT$/, '');
}

export function buildContext(inp: EpisodeInputs): BuiltContext {
  let entryAdvice: EntryStyleAdvice | undefined;
  let pendingMetrics: PendingEntryMetrics | undefined;
  const ev: Evidence[] = [];
  const add = (kind: string, label: string, value: string, observed_at: number, source: string, stale?: boolean, required_by?: string[]): string => {
    const ref = `E${ev.length + 1}`;
    ev.push({ ref, kind, label, value, observed_at, source, stale: stale ?? inp.now - observed_at > STALE_MS, required_by: required_by ?? [] });
    return ref;
  };

  // 09-12 §5 减黑盒:边装证据边记一行明细(要了没装上的也记),最后连同 hash 一起落进 episode。
  const planItems: EvidencePlanItem[] = [];
  // §9.36 公共最小集:结构行只给主周期 + 1h/4h(+ 持仓线程自己的论点/确认周期)。
  // evidence 请求带进来的额外周期**不再**顺带拿到一整行结构 —— 那正是 Codex 说的「无条件装」。
  const structureTfs = new Set(
    publicStructureTfs(inp.features[0]?.tf ?? '15m', inp.thread
      ? inp.thread.holding_plan
        ? [inp.thread.timeframe, inp.thread.holding_plan.thesis_timeframe, inp.thread.holding_plan.confirm_timeframe]
        : [inp.thread.timeframe, reviewTimeframe(inp.thread)]
      : []),
  );

  const m = inp.market;
  const holdingReview = inp.mode === 'review' && inp.thread?.holding_plan ? evaluateHoldingReview({ thread: inp.thread, now: inp.now, market: m, features: inp.features, klines: inp.klines ?? {}, ...(inp.verified_event ? { event: inp.verified_event } : {}) }) : undefined;
  add('market', '最新价 / 标记价', `last ${m.last}, mark ${m.mark}`, m.as_of, 'fapi premiumIndex+ticker');
  // Empty string = "this number does not exist for this timestamp" (blind backtests: funding before the
  // history endpoint's reach, open interest at all). We drop the evidence line rather than register a
  // fabricated 0 the model could quote — live always has both, so live is unaffected.
  if (m.funding_rate !== '') add('market', '资金费率', `${(Number(m.funding_rate) * 100).toFixed(4)}% (下次 ${new Date(m.next_funding_at).toISOString().slice(11, 16)} UTC)`, m.as_of, 'fapi premiumIndex');
  if (m.open_interest !== '')
    add(
      'market',
      '持仓量 OI',
      `${Number(m.open_interest).toFixed(0)} ${baseAsset(inp.symbol)}${inp.oi_change_1h_pct === null ? '' : `, 较 1h 前 ${inp.oi_change_1h_pct >= 0 ? '+' : ''}${inp.oi_change_1h_pct.toFixed(2)}%`}`,
      m.as_of,
      'fapi openInterest(+hist)',
    );
  const t = inp.ticker24h;
  add('market', '24h 变动 / 高低', `${t.priceChangePercent}%, H ${t.highPrice} L ${t.lowPrice}, 成交额 ${(Number(t.quoteVolume) / 1e6).toFixed(0)}M USDT`, m.as_of, 'fapi ticker/24hr');

  const structureSeen = new Set<string>();
  for (const f of inp.features) {
    if (!structureTfs.has(f.tf)) continue; // §9.36:公共最小集之外的周期不给整行结构(要就在 evidence 里点名)
    if (structureSeen.has(f.tf)) continue; // 同一周期的 features 传了两份(主周期=1h 时)只给一行结构
    structureSeen.add(f.tf);
    const trend = f.ema20 > f.ema50 ? 'EMA20>EMA50(偏多)' : 'EMA20<EMA50(偏空)';
    const pos = f.last_close > f.ema20 ? '价在 EMA20 上' : '价在 EMA20 下';
    const d = f.last_close > 100 ? 0 : f.last_close > 1 ? 2 : 5;
    add(
      'structure',
      `${f.tf} 结构`,
      `收 ${fmt(f.last_close, d)}; ${trend}, ${pos}; EMA20 ${fmt(f.ema20, d)} EMA50 ${fmt(f.ema50, d)}; ATR14 ${fmt(f.atr14, d)} (${fmt((f.atr14 / f.last_close) * 100, 2)}%); 20根高 ${fmt(f.swing_high_20, d)}(距 ${fmt(f.dist_to_high20_pct, 2)}%) 低 ${fmt(f.swing_low_20, d)}(距 ${fmt(f.dist_to_low20_pct, 2)}%); 50根高 ${fmt(f.swing_high_50, d)} 低 ${fmt(f.swing_low_50, d)}; 最近一根 ${f.change_pct_last >= 0 ? '+' : ''}${fmt(f.change_pct_last, 2)}%, 近5根 ${f.change_pct_5 >= 0 ? '+' : ''}${fmt(f.change_pct_5, 2)}%; 量比 ${fmt(f.vol_ratio_20, 2)}`,
      f.last_open_time,
      `fapi klines ${f.tf}`,
      false,
      [PUBLIC_MIN_EVIDENCE.required_by],
    );
    planItems.push({ kind: 'structure', key: `structure@${f.tf}`, label: `${f.tf} 结构`, required_by: [PUBLIC_MIN_EVIDENCE.required_by], included: true, ref: `E${ev.length}`, source: `fapi klines ${f.tf}`, note: null });
  }
  if (inp.features[0]) {
    add('structure', `${inp.features[0].tf} 最近 4 根`, inp.features[0].last_bars, inp.features[0].last_open_time, `fapi klines ${inp.features[0].tf}`, false, [PUBLIC_MIN_EVIDENCE.required_by]);
    planItems.push({ kind: 'structure', key: `last_bars@${inp.features[0].tf}`, label: `${inp.features[0].tf} 最近 4 根`, required_by: [PUBLIC_MIN_EVIDENCE.required_by], included: true, ref: `E${ev.length}`, source: `fapi klines ${inp.features[0].tf}`, note: null });
  }

  // v4 boundary metrics (docs/eval/results-2026-09-04.md 「v4:边界规则化」): the two decisions the model was
  // flipping on (NO_TRADE↔WATCH, HOLD↔EXIT) get one code-computed checklist each, so system rules 7/8 can be
  // stated as "read this line" and every derived number the model may quote has a registered source.
  if (inp.mode === 'scan') {
    // Thresholds come from the active breakout strategy when there is one (its params are the versioned
    // knobs: chase distance, retest volume, breakout window); raw klines let the checklist see the window.
    const bo = (inp.strategies ?? []).find((st) => st.id === 'breakout_retest') ?? (inp.strategies ?? [])[0];
    const hp = bo && (bo.horizon === 'swing' || bo.horizon === 'position') ? HORIZON_POLICY[bo.horizon] : null;
    const scanFeatures = hp ? inp.features.filter((f) => f.tf === hp.timeframe).concat(inp.features.filter((f) => f.tf !== hp.timeframe)) : inp.features;
    const chk = scanChecklist(scanFeatures, inp.klines?.[scanFeatures[0]?.tf ?? ''] ?? undefined, bo ? { ...scanThresholdsOf(bo), ...(hp ? { trend_timeframes: [hp.timeframe, hp.confirm] as const } : {}) } : undefined);
    if (chk && inp.features[0]) add('checklist', '扫描清单(代码计算)', chk.text, inp.features[0].last_open_time, 'scanChecklist()', false);
    // 09-09 入场方式:把「回踩确认 → 市价;未确认 → 限价挂回踩区」这条策略规则代码化(entry-policy.ts)。
    entryAdvice = entryStyleAdvice({ side: chk?.trend_agree ?? null, horizon: bo?.horizon ?? null, checklist: chk, base: scanFeatures[0], mark: Number(m.mark), style: inp.entry_style ?? 'free', entry_mode: bo?.rules.entry_mode ?? null });
    add('plan', '入场方式(代码计算)', entryAdvice.text, inp.now, 'entryStyleAdvice()', false);
  } else if (inp.thread && (inp.thread.status === 'pending_entry' || inp.thread.status === 'in_position')) {
    const th = inp.thread;
    const hp = HORIZON_POLICY[threadHorizon(th)];
    add('position', '策略持有周期', `horizon=${threadHorizon(th)},复查 ${reviewTimeframe(th)} 每 ${hp.review_bars} 根;长线策略不用短线思维。低周期噪声、fast_move 和短期新闻不能单独支持 EXIT/REDUCE/INVALIDATE;缺本周期证据时 HOLD。已挂硬止损仍有效,不能因耐心放宽已批准止损。`, inp.now, 'strategy horizon', false);
    const status: 'pending_entry' | 'in_position' = th.status === 'in_position' ? 'in_position' : 'pending_entry';
    const rm = reviewMetrics({
      now: inp.now,
      side: th.side,
      status,
      mark: m.mark,
      entry: th.filled_avg_price ?? th.entry.price,
      entry_zone: th.entry.zone,
      stop: th.stop_price,
      take_profits: th.take_profits,
      invalidation_text: th.holding_plan?.invalidation_price ?? th.invalidation_text,
      opened_at: th.opened_at,
      created_at: th.created_at,
      ...(th.holding_plan ? { horizon: th.holding_plan.horizon } : th.horizon ? { horizon: th.horizon } : {}),
      tf_ms: tfToMs(reviewTimeframe(th)),
      features: inp.features,
      klines: inp.klines?.[reviewTimeframe(th)],
      invalidation_confirm_bars: inp.invalidation_confirm_bars,
      invalidation_buffer_atr: Math.max(inp.invalidation_buffer_atr ?? 0.2, HORIZON_POLICY[threadHorizon(th)].invalidation_atr),
    });
    if (holdingReview) add('position', '持仓动作闸(代码计算)', `允许动作=${holdingReview.allowed_actions.join('/')}；原因=${holdingReview.reason}；冻结论点=${th.holding_plan!.thesis}；主周期=${th.holding_plan!.thesis_timeframe}，确认=${th.holding_plan!.confirm_timeframe}；失效价=${th.holding_plan!.invalidation_price ?? '未给'}，连续${th.holding_plan!.confirm_bars}根，缓冲${th.holding_plan!.invalidation_buffer_atr} ATR；ATR=${th.holding_plan!.atr_at_entry}(${th.holding_plan!.atr_timeframe})；${holdingReview.spike ? `急针状态=${holdingReview.spike.state}，冲击${holdingReview.spike.excursion_atr}ATR，回收${holdingReview.spike.recovery_fraction}` : '急针证据不足'}；单根反向针/小浮亏不是独立EXIT理由，硬止损不等反弹。`, inp.now, 'holding-policy', false);
    if (rm) add('position', status === 'in_position' ? '持仓度量(代码计算)' : '挂单度量(代码计算)', rm.text, m.as_of, 'reviewMetrics()');
    if (status === 'pending_entry') {
      const pm = pendingEntryMetrics({ now: inp.now, thread: th, mark: Number(m.mark), tf: reviewTimeframe(th), tf_ms: tfToMs(reviewTimeframe(th)), features: inp.features, klines: inp.klines ?? {}, max_wait_bars: inp.entry_max_wait_bars ?? 8 });
      if (pm) {
        pendingMetrics = pm;
        add('position', '挂单耐心(代码计算)', pm.text, inp.now, 'pendingEntryMetrics()', false);
      }
    }
  }

  // v3.5 strategy library: each active strategy may add its own code-computed checklist line (the ones that
  // reuse 扫描清单 add nothing). Same contract as every other evidence line: registered, sourced, citable.
  const activeStrategies = inp.strategies ?? [];
  // 新闻主题 → 哪几条策略点名要它(evidencePlan 只给并集,required_by 在这里算)。
  const topicOwners = new Map<string, string[]>();
  const eventOwners: string[] = [];
  for (const st of activeStrategies) {
    const ev = evidenceOf(st);
    for (const topic of ev.info_topics ?? []) {
      const key = topic.toLowerCase();
      const owners = topicOwners.get(key) ?? [];
      if (!owners.includes(st.id)) owners.push(st.id);
      topicOwners.set(key, owners);
    }
    if (ev.events.includes('event') && !eventOwners.includes(st.id)) eventOwners.push(st.id);
  }
  for (const st of activeStrategies) {
    for (const line of strategyEvidence(st, {
      now: inp.now,
      symbol: inp.symbol,
      timeframe: inp.features[0]?.tf ?? '15m',
      features: inp.features,
      klines: inp.klines,
      market: inp.market,
      oi_change_1h_pct: inp.oi_change_1h_pct,
      funding_history: inp.funding_history,
      daily_regime: inp.daily_regime ?? null,
      trigger_hits: inp.trigger_hits,
    })) {
      const ref = add('checklist', `${st.id}·${line.label}`, line.value, line.observed_at, line.source, false, [st.id]);
      planItems.push({ kind: 'checklist', key: `${st.id}:${line.label}`, label: line.label, required_by: [st.id], included: true, ref, source: line.source, note: null });
    }
  }

  // 09-12 §4 自定义证据:按**启用策略声明的并集**装指标,每条带 required_by(哪几条策略要它)。
  // 没有策略要的指标不进 prompt。没写 evidence 的旧策略走 DEFAULT_EVIDENCE,所以行为不会突然变空。
  const plan = evidencePlan(activeStrategies);
  const snapCache = new Map<string, ReturnType<typeof indicatorSnapshot>>();
  const indicatorSource = (tf: string): string => `indicatorSnapshot(${tf})`;
  const indLabel = (req: { id: string; tf: string; params?: Record<string, number> }): string => `${req.tf} ${req.id}${req.params && Object.keys(req.params).length ? `(${Object.keys(req.params).sort().map((k) => `${k}=${req.params![k]}`).join(',')})` : ''}`;
  const missIndicator = (req: { id: string; tf: string; params?: Record<string, number>; required_by: string[] }, note: string): void => {
    planItems.push({ kind: 'indicator', key: indicatorKey(req), label: indLabel(req), required_by: req.required_by, included: false, ref: null, source: indicatorSource(req.tf), note });
  };
  for (const req of plan.indicators) {
    const bars = inp.klines?.[req.tf];
    // 09-12 P1-11:根数门按**这条证据自己的窗口**算,参数也真的传进计算与标签
    // (以前 params 只进了去重键,RSI7/RSI21 算的都还是默认 RSI14)。
    const need = Math.max(30, minBarsForIndicator(req.id, req.params));
    if (!bars || bars.length < need) {
      missIndicator(req, `${req.tf} 只有 ${bars?.length ?? 0} 根 K 线(要 ${need} 根)`); // 数据不足就不写这一行(不编 0)
      continue;
    }
    if (!snapCache.has(req.tf)) snapCache.set(req.tf, indicatorSnapshot(bars, req.tf));
    const base = snapCache.get(req.tf) ?? null;
    if (!base) {
      missIndicator(req, `${req.tf} 快照算不出来`);
      continue;
    }
    const snap = indicatorWithParams(req.id, bars, base, req.params);
    if (!snap) {
      missIndicator(req, '这个指标还不支持自定义参数');
      continue;
    }
    const text = renderIndicator(req.id, snap, req.params);
    if (text === null) {
      missIndicator(req, '快照里没有这个指标的值');
      continue;
    }
    const ref = add('indicator', indLabel(req), text, snap.last_open_time, indicatorSource(req.tf), false, req.required_by);
    planItems.push({ kind: 'indicator', key: indicatorKey(req), label: indLabel(req), required_by: req.required_by, included: true, ref, source: indicatorSource(req.tf), note: null });
  }

  // 09-09 策略议会:各策略对本资产的独立表态与适配度,代码汇总成一行;require 模式下也是开仓闸(规则 9b)。
  if (inp.strategy_council) add('council', '策略议会(代码汇总)', inp.strategy_council.text, inp.strategy_council.at, `strategy-council ${inp.strategy_council.version}`, false);
  if (inp.council_review) add('council', '策略议会复核(代码计算)', inp.council_review.text, inp.now, 'councilReview()', false);

  // v3: the higher-timeframe picture and the calendar are computed by code and handed over as evidence
  // (docs/demo/v3-ui-contract.md §0) — the model should cite them, not infer them from a few bars.
  if (inp.daily_regime) add('regime', '日线状态(代码计算)', inp.daily_regime.text, inp.daily_regime.as_of, 'fapi klines 1d → dailyRegime()', false);
  if (inp.session) add('calendar', '交易时段', `${inp.session.text}${inp.session.minutes_to_us_open !== null && inp.session.minutes_to_us_open > 0 && inp.session.minutes_to_us_open <= 120 ? `;距美股开盘 ${inp.session.minutes_to_us_open} 分钟` : ''}`, inp.now, 'sessionInfo()', false);
  if (inp.trigger_hits && inp.trigger_hits.length) add('trigger', '本次触发器', inp.trigger_hits.map((h) => `${h.kind}:${h.detail}${h.event_id ? ` [event_id=${h.event_id};subkind=${h.event_subkind};source=${h.source_ref ?? 'unknown'}${h.research_task_id ? `;research_task_id=${h.research_task_id}` : ''}]` : ''}`).join(';'), inp.now, 'detectTriggers()/detectEventTriggers()', false);

  // v3.2 long-term memory: each recalled item is one evidence line labelled 记忆, so a reason can cite it like any
  // other E, and the runtime can tell which memories were actually used. Never stale (freshness is not the point),
  // never a source of market numbers (system rule 4b; eval excludes kind 'memory' from number sources).
  for (const m of inp.memories ?? []) {
    const scope = m.scope.symbol ? m.scope.symbol : '全局';
    add('memory', `记忆 ${m.id}·${memoryKindLabel(m.kind)}`, `${m.content}(范围 ${scope}${m.scope.regime ? `/${m.scope.regime}` : ''},信心 ${m.confidence.toFixed(2)},来源 ${m.source_refs.length} 条)`, m.decided_at ?? m.created_at, `长期记忆(${m.proposed_by} 提案,已批准)`, false);
  }

  // Market state from the information officer (as evidence, so reasons can cite it).
  const ms = inp.market_state;
  if (ms) {
    const stale = inp.now - ms.as_of > MARKET_STATE_STALE_MS;
    add('info', '信息员·市场状态', `${ms.regime} / 偏 ${ms.bias};${ms.summary}`, ms.as_of, `信息员 ${ms.model}`, stale);
    const asset = baseAsset(inp.symbol);
    const major = ms.majors.find((x) => x.symbol === inp.symbol);
    if (major) add('info', `信息员·${inp.symbol} 数据`, `24h ${major.change_24h_pct}%, 资金费率 ${major.funding_rate}, OI 1h ${major.oi_change_1h_pct ?? 'n/a'}%, 多空账户比 ${major.long_short_ratio ?? 'n/a'}, 主动买卖比 ${major.taker_buy_sell_ratio ?? 'n/a'}, 恐惧贪婪 ${ms.sentiment.fng ?? 'n/a'}`, ms.as_of, '信息员数值段', stale);
    // 09-12 §4:有策略声明了 info_topics 就优先装命中主题的新闻(命中的排前,不够再用原口径补满 3 条);
    // 没有策略声明主题时口径完全不变。
    const baseNews = ms.news.filter((n) => n.relevance !== 'low' || n.title.toUpperCase().includes(asset));
    const topicHit = (x: { title: string; digest: string }): boolean => plan.info_topics.some((t) => `${x.title} ${x.digest}`.toLowerCase().includes(t));
    const relevantNews = (plan.info_topics.length ? [...baseNews.filter(topicHit), ...baseNews.filter((x) => !topicHit(x))] : baseNews).slice(0, 3);
    for (const n of relevantNews) {
      const ref = add('info', `新闻·${n.source}`, `<untrusted_data>${n.title} —— ${n.digest}</untrusted_data>`, n.published_at, n.source, inp.now - n.published_at > 6 * 3_600_000);
      // 命中主题的新闻记下是谁点的名;没命中的是原口径补位,required_by 为空。
      const hits = [...topicOwners.keys()].filter((topic) => `${n.title} ${n.digest}`.toLowerCase().includes(topic));
      const owners = [...new Set(hits.flatMap((topic) => topicOwners.get(topic) ?? []))].sort();
      planItems.push({ kind: 'news', key: `${n.source}:${n.published_at}`, label: n.title.slice(0, 60), required_by: owners, included: true, ref, source: n.source, note: hits.length ? `命中主题 ${hits.join('/')}` : null });
    }
    if (ms.risk_events.length) add('info', '信息员·风险事件', ms.risk_events.join(';'), ms.as_of, '信息员', stale);
    const cand = ms.candidates.find((c) => c.symbol === inp.symbol);
    if (cand) add('info', '信息员·候选', `${cand.direction === 'long' ? '做多' : '做空'}候选:${cand.why}(只是线索,需按 playbook 重新判断)`, ms.as_of, '信息员', stale);
  }

  // 09-12 事件区:窗口内的事件进证据(至多 3 条,按窗口开始时间由近及远)。事件**不是**下单理由,
  // 它只说明「现在这个币头上压着一件什么事」;历史统计是同 subkind 的经验分布,不是预测。
  for (const e of (inp.events ?? []).slice(0, 3)) {
    const startedAt = e.expected_at ?? e.captured_at;
    const st = inp.event_stats?.[e.subkind];
    const statsText =
      st && st.samples > 0
        ? `同类历史 ${st.samples} 例:平均 |4h 波动| ${st.avg_abs_move_4h_pct ?? 'n/a'}%,方向一致率 ${st.direction_agreement === null ? 'n/a' : `${Math.round(st.direction_agreement * 100)}%`}${st.dominant_direction ? `(偏${st.dominant_direction === 'up' ? '涨' : '跌'})` : ''}`
        : '同类历史样本不足,没有先验';
    const briefText = e.brief?.source === 'research' && e.brief.task_id ? `一手研究简报(task_id=${e.brief.task_id}; /api/research/${e.brief.task_id}; refs=${e.brief.refs.join(',')}):<untrusted_data>${e.brief.text}</untrusted_data>` : '暂无 research 任务简报';
    const mins = Math.round((inp.now - startedAt) / 60_000);
    const eventRef = add(
      'event',
      `事件·${e.subkind}`,
      `<untrusted_data>${e.title}</untrusted_data>(${mins >= 0 ? `已开始 ${mins} 分钟` : `还有 ${-mins} 分钟`},窗口 ${Math.round(e.window_ms / 60_000)} 分钟,可信度 ${e.confidence},来源 ${e.source})。${briefText}。${statsText}。事件只是背景,不能单独作为开仓理由。`,
      startedAt,
      `事件区 ${e.source}`,
      false,
    );
    planItems.push({ kind: 'event', key: e.subkind, label: e.title.slice(0, 60), required_by: eventOwners, included: true, ref: eventRef, source: `事件区 ${e.source}`, note: null });
    // 事件的一手信息简报是**研究**来源:它和事件本身不是一回事(事件是日历,简报是抓回来的内容)。
    if (e.brief) planItems.push({ kind: 'research', key: `${e.subkind}:brief`, label: `事件简报 T−${e.brief.lead_minutes ?? '?'}m`, required_by: eventOwners, included: true, ref: eventRef, source: `事件简报 ${e.source}`, note: null });
  }

  const a = inp.account;
  const pos = a.positions.find((p) => p.symbol === inp.symbol);
  const posText = pos ? `${pos.side === 'long' ? '多' : '空'} ${pos.qty} @ ${pos.entry_price}, 标记 ${pos.mark_price}, 浮盈亏 ${pos.unrealized_pnl} USDT` : '本币无持仓';
  const others = inp.open_threads.filter((x) => x.symbol !== inp.symbol).map((x) => `${x.symbol} ${x.side === 'long' ? '多' : '空'}(${x.status === 'in_position' ? '持仓中' : '待入场'})`);
  const accountSource = a.backend === 'demo' ? 'Binance demo-fapi' : a.backend === 'agent_mcp' || a.backend === 'mcp' ? 'Binance Agentic 子账户(MCP)' : a.backend === 'cli' ? 'binance-cli(demo)' : '本地纸面账户';
  add('account', '账户', `${a.quality === 'unfunded' ? '执行通道账户未入金(读取成功,权益 0):不能开新仓;' : ''}权益 ${a.equity} USDT, 可用 ${a.available}, 未实现 ${a.unrealized_pnl}; ${inp.symbol}: ${posText}; 其他线程: ${others.join('、') || '无'}`, a.as_of, accountSource);

  // The allowed edge set comes from the judgment graph — the same table the reducer and the eval read.
  // 行情快照(最新价/标记价那条 E)过期 → scan:stale 节点,PROPOSE 不在允许集里(graph v2)。
  const marketStale = ev.some((e) => e.kind === 'market' && e.label === '最新价 / 标记价' && e.stale);
  const node = nodeFor(inp.mode === 'review' ? inp.thread : null, inp.halted, marketStale, inp.watch_only === true);
  const allowed: string[] = allowedActions(node).filter((action) => !holdingReview || holdingReview.allowed_actions.includes(action));
  if (inp.mode === 'scan' && inp.strategies?.length) add('plan', '可选ATR尺度', renderAtrChoices(inp.features, inp.strategies), inp.now, 'holding-policy', false);
  // 没绑策略也要告诉模型能选哪些 ATR 周期:以前不给,模型照 playbook 选 15m,入场检查只认 1h/4h,提议整条作废(09-26 评审站一天 94 次)
  else if (inp.mode === 'scan' && inp.features[0]) add('plan', '可选ATR尺度', renderFreeAtrChoices(inp.features, inferHorizon(inp.features[0].tf), inp.features[0].tf), inp.now, 'holding-policy', false);
  // 执行层的止损底线(按当前模式给具体数):代码在开仓检查和发送前都会按它拒单。没绑策略时单独列一条,让模型下单前就知道
  const floorText = renderStopFloor(inp.stop_floor?.thresholds ?? DEFAULT_EXECUTION_THRESHOLDS, inp.stop_floor?.atr_pct ?? null, inp.symbol);
  if (inp.mode === 'scan' && !inp.strategies?.length) add('plan', '止损底线(代码核验)', `${floorText}。和上面的 ATR 尺度两条都要满足,按更宽的那条放;止损放在结构位之外,够不到底线就等更好的位置,不要把止损挪到没有结构意义的地方去凑数。`, inp.now, 'execution-policy', false);

  const system = flagWords([
    '你是 trade-gate 的判断模块。你不是聊天助手,不做寒暄。你只在被事件唤醒时读一次新鲜状态,维护一个交易论点(thesis),并输出一个有限的判断。',
    '硬红线:',
    '1. 数量、杠杆、风险预算由代码决定,你只给方向、入场方式(市价或限价区间)、止损价、止盈价(可给 1-2 个)和理由。',
    '2. 只能引用下面登记过的证据编号(E1、E2…);每条 reason 末尾必须用 [E3] 这种形式标注依据,没有依据的话不要写这条理由。',
    '2b. reasons / thesis 里出现的每个数字,要么是证据里逐字出现的原数,要么是你自己由证据算出来的**派生数**;派生数必须在数字后面紧跟一个来源标注,而且标注里要写出**完整公式**,格式固定为 `(由 <公式> 算出)`——公式的操作数只能是 `E<编号>.<字段名>`(字段名照抄证据里那个数前面的标签)或常数,常数只允许 100(百分号换算)或该数字在你引用的证据里逐字出现过。例:「浮盈 66.34 USDT(由 (E6.mark-E7.成交)*E7.数量 算出)」「距止损 0.231%(由 (E9.成交-E9.止损)/E9.成交*100 算出)」「止损距离 249.66(由 E4.成交-E4.止损 算出)」。旧写法 `(由 E3,E7 算出)`(只给编号、不给公式)不再算复算通过,照样按幻觉计。',
    '2c. 公式里只能用 + - * / 和圆括号;代码会拿你标的那几条证据按公式**自己复算一遍**,结果要**带符号**跟你写的数字相等(允许四舍五入)才放行 —— 符号写反、字段名在证据里找不到、编号没登记、或引用了标了「记忆」的证据,一律按幻觉计。不确定怎么算的数就别写,改成引用证据原数。你自己算出来的价位仍然只写在 proposal 的字段里,不用标注。',
    '3. 没有足够优势就输出 NO_TRADE 或 WATCH,这是正常且重要的结果,不要为了"有动作"而交易。',
    '4. 标了 STALE 的证据不能作为 PROPOSE 的依据;信息员的候选只是线索,不是理由。',
    '4b. 标了「记忆」的证据是过去批准的教训/偏好/事实,只能用来调整倾向与信心,不能覆盖现场行情与账户数据;记忆里的价格、盈亏数字不是行情数字,不要当作当前价位引用。',
    `5. 止损价必须在入场价的另一侧:做多止损 < 入场价,做空止损 > 入场价;按入场价算,${floorText}。限价入场时 limit_price 放在 entry_zone 靠近现价的一端。`,
    '6. 只输出一个 JSON 对象,不要 markdown,不要解释文字。所有文字字段用简体中文,面向没有看过代码的交易员。',
    '7. 扫描先按「可用策略」(没有策略块时按 playbook)判断是否符合 PROPOSE 条件。清单里的「收破突破位」比较前 20 根(不含当根)的高/低点;「回踩确认=是」时应按当前启用策略考虑 PROPOSE,符合条件才给出 proposal,不符合则在 reasons 里写清缺少的条件。未满足 PROPOSE 条件时,WATCH/NO_TRADE 分界以「扫描清单(代码计算)」为准,不要自己重算:watch_eligible=是(策略确认周期同向、价距对应突破位在追单上限以内、回踩尚未确认)才可以 WATCH;watch_eligible=否 则 NO_TRADE。回踩已确认时不要退回 WATCH。理由必须引用这条清单证据的编号。',
    ...(holdingReview ? ['8. 以持仓动作闸(代码计算)的允许动作作为最终边界，旧持仓度量只用于解释。论点和失效条件在入场固定，HOLD不能重写。普通反向针先观察恢复与本周期结构；巨大振幅不等于已证实的黑天鹅。必须引用持仓动作闸证据。required_action硬止损必须EXIT；未授权的退出不执行。'] : ['8. 持仓复查以「持仓度量(代码计算)」为准,规则是不对称的:触及风险底线必须离场,结构证据可以支持提前离场,不设必须先亏到某个 R 才准离场的门槛。\n   ① 必须 EXIT:度量写明最近一根已收盘 K 线「已越过止损一侧」。此时无条件离场,不能用等待反弹的理由 HOLD 或 REDUCE。止损是唯一的硬离场线。\n   ② 可以 EXIT(由你判断):a)「失效确认=是」(失效价被连续越过达到确认口径),或 b)「论点趋势翻转=是」(当前线程 horizon 指定复查/确认周期的 EMA20-vs-EMA50 方向与持仓方向相反),或 c)「结构转弱=是」且浮盈 ≤ 0R。失效价只越过一根、深度不足确认口径时不是①,也不必走:看本 horizon 结构是否仍完好(复查/确认周期同向、价在本周期 EMA20 有利侧)再定;记忆里若有用户关于失效确认的偏好(如要几根、要多深),优先按偏好判。理由必须同时引用这条度量证据和一条支持离场的结构证据的编号。\n   ③ HOLD:论点未破且未触发①时默认持有;若②或④成立,可以依据证据选择相应降风险动作。\n   ④ 可以 REDUCE:未触发①、浮盈 ≥ +1R 且「结构转弱=是」时可以减半。\n   ⑤ INVALIDATE 只用于挂单未成交的线程;持仓中要走用 EXIT。以上复查理由必须引用这条度量证据的编号。']),
    '8b. 系统处于紧急停止(节点 scan:halted)时唯一合法的 action 是 NO_TRADE:不要输出 WATCH、PROPOSE 或任何别的动作,即便行情看起来有机会;输出别的动作会被判为越权并作废。',
    ...(activeStrategies.length
      ? [
          '9. 只能用可用策略；PROPOSE须填strategy_id和proposal.risk_plan，按可选ATR尺度选择，结构失效价invalidation_price必填且在入场不利侧与硬止损之间。代码核验实际止损宽度及扣成本净RR>=1.5，不达标等待更好入场，不为凑RR推远目标。',
        ]
      : inp.mode === 'scan'
        ? ['9. PROPOSE 须填 proposal.risk_plan:atr_timeframe 只能从「可选ATR尺度」里选,止损至少是所选周期 ATR 的下限倍数,同时不低于「止损底线(代码核验)」;代码会核验止损宽度和扣成本后的净RR>=1.5,不达标就等更好的入场,不要为凑RR推远目标。']
        : []),
    ...(inp.strategy_council && inp.strategy_council.mode === 'require'
      ? ['9b. 策略议会共识是开仓前置:「策略议会(代码汇总)」共识=否时不能 PROPOSE(只能 WATCH / NO_TRADE,把缺的票写进 watch_conditions);共识=是时 PROPOSE 的方向必须与共识一致,strategy_id 必须是同意方之一;理由必须引用这条证据编号。弃权=该策略没被唤醒或没有裁决实现,不是反对。']
      : inp.strategy_council
        ? ['9b. 「策略议会(代码汇总)」是各策略对本资产的独立表态与适配度:选 strategy_id 和定信心时参考它,方向与多数票相反时要在理由里说明;弃权=该策略没被唤醒或没有裁决实现,不是反对。']
        : []),
    ...(entryAdvice ? ['10. 入场方式按「入场方式(代码计算)」那条证据:建议=限价时应给 entry="limit" 与 limit_price(放在参考挂单区里靠近现价的一端),不要图省事用市价;距突破位超过 1 ATR 的市价单会被代码闸直接拒掉。挂限价等回踩不是缺点——回踩没确认就市价追是最常见的亏损来源;真的等不到,下一次判断再撤。'] : []),
    ...(pendingMetrics ? ['10b. 挂单要不要继续放着,按「挂单耐心(代码计算)」:代码意见=继续挂着仍然合理 → 默认 HOLD;代码意见=撤单更合理(等待超上限 / 价格已跑掉 / 突破结构没了)→ 应当 INVALIDATE 撤单。撤单不动钱也不改任何已批准价格,但不要凭单根噪声撤单;理由必须引用这条证据的编号。'] : []),
    ...(inp.council_review ? ['8c. 「策略议会复核」告诉你开仓时同意的策略现在还同不同意:翻向是一条结构证据,可支持规则 8 ②的离场判断,但不是硬离场线。'] : []),
    '',
    ...(inp.mode === 'scan' ? [RR_PROMPT, ''] : []),
    '输出契约(严格):',
    '{"action":"NO_TRADE|WATCH|PROPOSE|HOLD|REDUCE|EXIT|INVALIDATE","direction":"long|short|null","confidence":0.0-1.0,"headline":"≤40字一句话","thesis":"≤200字的论点","reasons":["… [E1]","… [E4]"],"evidence_refs":["E1","E4"],"invalidation":"失效条件(人话)或null","invalidation_price":"十进制字符串或null","target_price":"十进制字符串或null","watch_conditions":["下次要看什么"],"strategy_id":"策略 id 或 null","proposal":null 或 {"direction":"long|short","entry":"market|limit","limit_price":"…或null","entry_zone":["低","高"] 或 null,"stop_price":"必填","take_profits":["第一止盈","第二止盈(可选)"],"rationale":"一句话","risk_plan":{"atr_timeframe":"所选周期","stop_atr_multiple":"1/1.5/2/3中的十进制字符串"}}}',
    '',
    ...(activeStrategies.length ? ['可用策略:', renderStrategies(activeStrategies), ''] : []),
    activeStrategies.length ? '补充说明(用户写的,不覆盖策略):' : `Playbook(${PROMPT_VERSION}):`,
    inp.playbook_text,
  ].join('\n'));

  const lines: string[] = [];
  const trig = inp.trigger.kind === 'kline_close' || inp.trigger.kind === 'scan' ? 'K 线收盘扫描' : inp.trigger.kind === 'manual' ? '手动触发' : inp.trigger.kind === 'thread_review' || inp.trigger.kind === 'position_review' ? '线程复查' : inp.trigger.kind === 'order_filled' ? '入场成交后复查' : inp.trigger.kind === 'info_update' ? '信息员更新后复查' : inp.trigger.kind === 'chat' ? '对话中触发' : inp.trigger.kind;
  lines.push(`## 触发\n${trig}:${inp.trigger.detail}(标的 ${inp.symbol})`);
  lines.push(`\n## 证据登记(编号即 evidence_refs)`);
  for (const e of ev) lines.push(`${e.ref} [${e.label}] ${e.value}${e.stale ? ' (STALE)' : ''}`);
  if (inp.mode === 'review' && inp.thread) {
    const th = inp.thread;
    lines.push(`\n## 复查的线程`);
    lines.push(`${th.symbol} ${th.side === 'long' ? '做多' : '做空'},状态 ${th.status === 'pending_entry' ? '待入场(挂单中)' : '持仓中'},来源 ${th.source};论点:${th.thesis};入场:${th.entry.type === 'market' ? '市价' : `限价 ${th.entry.price}${th.entry.zone ? `(区间 ${th.entry.zone[0]}–${th.entry.zone[1]})` : ''}`}${th.filled_avg_price ? `,成交 @ ${th.filled_avg_price}` : ''};止损 ${th.stop_price ?? '无'};止盈 ${th.take_profits.join(' / ') || '无'};失效条件:${th.invalidation_text ?? '(无)'};上次要看的:${th.watch_conditions.join('、') || '(无)'};建立于 ${new Date(th.created_at).toISOString().slice(5, 16).replace('T', ' ')} UTC`);
  } else {
    lines.push(`\n## 当前状态\n${inp.symbol} 无线程。${inp.open_threads.length ? `其他线程 ${inp.open_threads.length} 条。` : ''}`);
  }
  if (inp.last_judgment_summary) lines.push(`上次对本币的判断:${inp.last_judgment_summary}`);
  lines.push(`\n## 任务`);
  const task =
    inp.mode === 'review'
      ? inp.thread?.status === 'pending_entry'
        ? '挂单还没成交。按「挂单耐心(代码计算)」判断要不要继续放着:代码意见=继续挂着仍然合理就 HOLD;代码意见=撤单更合理就 INVALIDATE(会撤单)。'
        : '你有持仓,请按规则 8 复查论点是否仍成立:HOLD / REDUCE(减半)/ EXIT(全平)。'
      : '你没有本币的线程,请判断是否有符合 playbook 的机会;有就 PROPOSE 并给 proposal;没有就 NO_TRADE 或 WATCH 并写清 watch_conditions。';
  lines.push(`现在时间 ${new Date(inp.now).toISOString()}。允许的 action:${allowed.join(' / ') || '(紧急停止中,无)'}。${task}${inp.halted ? ' 系统处于紧急停止:这次唯一合法的 action 是 NO_TRADE(规则 8b),WATCH 也不行。' : inp.watch_only && inp.mode === 'scan' ? ' 这个币被用户标为「只观察」:不能 PROPOSE,只能 NO_TRADE 或 WATCH,照常写清值不值得开放交易。' : node === 'scan:stale' ? ' 行情快照已过期(节点 scan:stale):这次不能 PROPOSE,只能 NO_TRADE 或 WATCH;形态再好也先写进 watch_conditions,等新快照再判。输出 PROPOSE 会被判为越权并作废。' : ''}`);
  lines.push('只输出 JSON。');
  const user = lines.join('\n');
  const context_text = `[system]\n${system}\n\n[user]\n${user}`;

  // 09-12 §5:证据装载计划落盘。requested = 「要什么」(并集后),items = 「实际装了什么 / 为什么没装」。
  const strategyIds = activeStrategies.map((s) => s.id);
  const requested: EvidencePlanDetail['requested'] = {
    indicators: plan.indicators.map((i) => ({ id: i.id, tf: i.tf, ...(i.params ? { params: i.params } : {}), required_by: i.required_by })),
    events: [...plan.events],
    info_topics: [...plan.info_topics],
  };
  const evidence_plan: EvidencePlanDetail = {
    version: EVIDENCE_PLAN_VERSION,
    hash: evidencePlanHash(strategyIds, requested),
    strategies: [...strategyIds].sort(),
    requested,
    items: planItems,
    counts: {
      requested_indicators: requested.indicators.length,
      included_indicators: planItems.filter((i) => i.kind === 'indicator' && i.included).length,
      events: planItems.filter((i) => i.kind === 'event').length,
      news: planItems.filter((i) => i.kind === 'news').length,
      research: planItems.filter((i) => i.kind === 'research').length,
      checklist: planItems.filter((i) => i.kind === 'checklist').length,
    },
  };

  return { evidence_plan, evidence_plan_hash: evidence_plan.hash, ...(holdingReview ? { holding_review: holdingReview } : {}), ...(entryAdvice ? { entry_advice: entryAdvice } : {}), ...(pendingMetrics ? { pending_entry: pendingMetrics } : {}), evidence: ev, system_text: system, user_text: user, context_text, context_hash: createHash('sha256').update(context_text).digest('hex'), allowed_actions: allowed, node, strategy_ids: activeStrategies.map((s) => s.id) };
}
