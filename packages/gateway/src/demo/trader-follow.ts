/**
 * 跟单 session 的**决策层**:一条带单员信号进来,决定跟(copy)/ 让 agent 把关(gated)/ 只当证据(evidence),
 * 以及管理动作路由到哪条线程。设计 `docs/design/trader-follow-2026-09-12.md` §0–§3。
 *
 * 这个文件里**判定全是纯函数**(`resolveMode` / `duplicateCheck` / `reverseCheck` / `routeManagement` / `entryPlanFor`),
 * 编排(`TraderFollow`)只做「按判定调 deps」。这样设计 §5 的验收单测不需要起 runtime,也不需要网络。
 *
 * 硬规则(移植自 8794,标 [8794] 的见 `docs/research/copy-engine-rules-from-8794-2026-09-12.md`):
 * - **管理动作与开仓动作物理分离** [8794 移植清单第 1 条]:只有 `open`/`add` 能产生新触发;
 *   `reduce/close/cancel/stop_loss_update/take_profit_update/stopped_out` 一律路由到已关联线程。
 * - **`add` 不自动执行** [8794 §3.4]:copy 模式只记 `trader_add_manual` 留人工;gated 模式当一次新的 open 判断。
 * - **止损必需**:open/add 没有止损 → 降级 evidence,记 `trader_signal_no_stop`。
 * - **离场纪律强于入场**:`close`/`stopped_out` 在 copy 与 gated 下都自动平(8794 离场硬门的教训)。
 * - **止损只自动收紧**,放松进 `pending_review`(不自动放松 = 8794 `auto_apply` 默认全人工的那条纪律)。
 * - **补拉一律 review_only**,新鲜度超限只能 evidence。
 * - 仓位按 `risk_pct × weight` 算风险,**不用**带单员自称的「2% 保证金 100 倍」(那不是可比的风险权重)。
 */

import { type TraderStatsSnapshot, type WeightView } from './trader-stats.js';
import {
  EXECUTABLE_PRE_STATUS,
  ageSeconds,
  entryPriceForSide,
  isExpired,
  isManagementAction,
  isOpeningAction,
  marketableLimitPrice,
  mentionsCostBasis,
  remapTpShares,
  splitPercents,
  stopTightens,
  type FollowApproval, type FollowMode,
  type TraderAction,
  type TraderAgentVerdict,
  type TraderDecision,
  type TraderSignal,
  type TraderSignalStatus,
} from './trader-signal.js';
import type { DecisionReasonCode, Direction, StrategyThread } from './types.js';

// ---------------------------------------------------------------- 设置

export { DEFAULT_MARKET_SETTINGS as DEFAULT_FOLLOW_SETTINGS, normalizeMarketSettings as normalizeFollowSettings } from './asp-agent/settings.js';
import { type MarketSettings, subscriptionFor } from './asp-agent/settings.js';
export type FollowSettings = MarketSettings;
export function localWeight(trader: string, weight: number): WeightView {
  return { trader, manual_weight: weight, auto_mult: 1, weight, stale: false, stale_capped: false, stats: null };
}
export function followSettingsView(s: FollowSettings): FollowSettings { return structuredClone(s); }

// ---------------------------------------------------------------- 模式判定

export interface ModeDecision {
  /** null = 完全不处理(带单员不在名册 / 名册里关了 / 跟单总开关关了)。 */
  mode: FollowMode | null;
  /** 这条信号最终的落库状态。 */
  status: TraderSignalStatus;
  codes: DecisionReasonCode[];
  note: string;
  weight: WeightView | null;
}

export interface ResolveModeInputs {
  signal: TraderSignal;
  follow: FollowSettings;
  stats: TraderStatsSnapshot | null;
  now: number;
  /** 该带单员今天已产生的开仓触发数(每日上限闸)。 */
  openings_today?: number;
  /** 这个 symbol 当前通道支不支持(代币化美股信号在不支持的 backend 上只进 evidence,设计 §4)。 */
  symbol_supported?: boolean;
  /**
   * 权重计算的注入点。runtime 传的是带「最近一次有效权重天花板」的那版(二审 P1-13);
   * 不传就退回纯 `weightFor`(单测用)。
   */
  weight_of?: (trader: string, manualWeight: number) => WeightView;
}

/**
 * 一条 open/add 信号该走哪个模式。顺序即优先级:名册 → 过期 → 补拉 → 新鲜度 → 无止损 → 币种支持 → 每日上限 → 配置模式。
 * **降级只往安全的方向走**(copy → gated → evidence),永远不会因为哪一条规则而升格。
 */
export function resolveMode(inp: ResolveModeInputs): ModeDecision {
  const { signal, follow, now } = inp;
  const cfg = subscriptionFor(follow, signal);
  const weight = cfg ? (inp.weight_of ?? ((t, m) => localWeight(t, m)))(signal.trader, cfg.weight) : null;
  const base = (mode: FollowMode | null, status: TraderSignalStatus, codes: DecisionReasonCode[], note: string): ModeDecision => ({ mode, status, codes, note, weight });

  if (!follow.enabled) return base(null, 'skipped', [], '跟单总开关关闭');
  if (!cfg) return base(null, 'skipped', [], `带单员 ${signal.trader} 不在跟单名册(只留痕)`);
  if (!cfg.enabled) return base(null, 'skipped', [], `带单员 ${signal.trader} 已停用`);
  // R3-07:期限不可信的信号不许进入可执行状态 —— 不靠「碰巧已经过期」,直接判 expired。
  if (signal.invalid_validity) return base('evidence', 'expired', ['trader_signal_stale'], `valid_until 不可信(解析不出或早于原发时间),这条不进可执行状态`);
  if (isExpired(signal, now)) return base('evidence', 'expired', ['trader_signal_stale'], `信号已过 valid_until(${new Date(signal.valid_until!).toISOString()})`);

  // 配置模式是上限,后面的规则只会把它往下压。
  let mode: FollowMode = cfg.mode;
  const codes: DecisionReasonCode[] = [];
  const notes: string[] = [];

  // 补拉:一律 review_only,永远不自动开仓(8794 移植清单第 10 条)。标记在拉取那一刻就打好了。
  if (signal.backfill) {
    return base('evidence', 'review_only', ['trader_signal_stale'], '启动补拉信号:只进复盘,不自动开仓');
  }
  // 新鲜度:live 信号超龄只能 evidence。
  const age = ageSeconds(signal, now);
  if (age > follow.freshness_s) {
    mode = 'evidence';
    codes.push('trader_signal_stale');
    notes.push(`信号已 ${age}s(上限 ${follow.freshness_s}s)`);
  }
  // 止损必需:没有止损不进 copy/gated。
  if (signal.stop === null && !(mode === 'book' && signal.market_type === 'spot')) {
    mode = 'evidence';
    codes.push('trader_signal_no_stop');
    notes.push('信号没有止损');
  }
  // 币种支持(代币化美股等):backend 不支持 → 只当证据。
  if (inp.symbol_supported === false) {
    mode = 'evidence';
    notes.push(`${signal.symbol} 当前通道不支持交易`);
  }
  // 每日上限:超了当天不再产生新触发(只留证据)。
  const cap = 6;
  if (cap > 0 && (inp.openings_today ?? 0) >= cap) {
    mode = 'evidence';
    codes.push('trader_gate_blocked');
    notes.push(`${signal.trader} 今日跟单触发已到上限 ${cap}`);
  }
  // 权重 0 = 人把这位带单员的仓位调到零:还当证据,但不下单。
  if (mode !== 'evidence' && weight && weight.weight <= 0) {
    mode = 'evidence';
    notes.push(`${signal.trader} 权重为 0`);
  }
  // `add` 永远不自动执行(8794 至今没有自动加仓路,仓位链不可靠)。
  // **但首发它和 open 一样要走到 `review_only` + 可执行几何**(R4-07):
  // 首发口径是「含 copy 的 open/add 都等人工」,提前 skipped 会让人在界面上看不到几何、点不了跟。
  // 自动执行开闸之后 `trader_add_manual` 这个码仍然意味着「不自动」,那时它才回到 skipped。
  if (signal.action === 'add') {
    codes.push('trader_add_manual');
    notes.push('加仓信号不自动执行,等人工');
  }
  const status: TraderSignalStatus = mode === 'evidence' ? 'evidence' : 'triggered';
  if (mode === 'book') codes.push('trader_follow_book');
  return base(mode, status, codes, notes.length ? notes.join(';') : `${mode} 模式`);
}

// ---------------------------------------------------------------- 重复开仓 / 反向敞口

export type DuplicateVerdict = 'new' | 'duplicate_open' | 'reentry';

export interface DuplicateInputs {
  signal: TraderSignal;
  /** 这个带单员 + 这个币当前的**活**线程(pending_entry / in_position)。 */
  live_threads: readonly StrategyThread[];
  /**
   * 已经结束的同人同币线程(closed / canceled / invalidated)。只用来区分
   * 「从没跟成过,可以再入场」和「压根没跟过」——两者都放行,区别只在留痕文案。
   */
  prior_threads?: readonly StrategyThread[];
}

/**
 * 重复开仓 [8794 §1.3 + R53]。
 *
 * **活线程一律算重复**,`pending_entry` 也算:挂单还在场上工作,它不是「原单已死」。
 * R53 的「原单入场腿全部终态未成交 → 允许再入场」在本仓库是**由构造满足**的 —— 入场腿被撤/过期
 * 会把线程推成 `canceled`,它就不在 `live_threads` 里了。所以这里只要看得见活线程就判重复,
 * 看不见就放行;`reentry` 只是给「以前跟过但没成交过」这一种放行加一句留痕。
 *
 * (第一版把 `pending_entry` 当成已死,等于带单员重发一遍就会在同一个币上叠第二张挂单。)
 */
export function duplicateCheck(inp: DuplicateInputs): { verdict: DuplicateVerdict; thread: StrategyThread | null; note: string } {
  const origin = `trader:${inp.signal.subscription_job_id ?? inp.signal.trader}`;
  const mine = inp.live_threads.filter((t) => t.symbol === inp.signal.symbol && t.origin === origin);
  const live = mine[0];
  if (live) {
    const where = live.status === 'in_position' ? '在仓' : '挂单在场';
    return { verdict: 'duplicate_open', thread: live, note: `${inp.signal.symbol} 已有${where}线程 ${live.id}` };
  }
  const dead = (inp.prior_threads ?? []).find((t) => t.symbol === inp.signal.symbol && t.origin === origin && t.filled_avg_price === null && t.opened_at === null);
  if (dead) return { verdict: 'reentry', thread: dead, note: `原单 ${dead.id} 入场腿全部终态未成交,允许再入场(R53)` };
  return { verdict: 'new', thread: null, note: '' };
}

/** 反向敞口 [8794 R55]:同币已有**反向**线程(不限来源)→ 拒。单向持仓模式下反向开仓等于平别人的仓。 */
export function reverseCheck(signal: TraderSignal, liveThreads: readonly StrategyThread[]): { blocked: boolean; thread: StrategyThread | null } {
  if (signal.side === null) return { blocked: false, thread: null };
  const opposite = liveThreads.find((t) => t.symbol === signal.symbol && t.side !== signal.side);
  return { blocked: opposite !== undefined, thread: opposite ?? null };
}

// ---------------------------------------------------------------- 入场几何

export interface EntryLeg {
  price: string;
  /** 这一档占总仓位的百分比(合计 100)。 */
  percent: number;
}

export interface EntryPlan {
  ok: boolean;
  /** `market` 意图也会被翻成「顶着偏离上限的限价」,所以这里只有 limit;`intent` 说明它是哪来的。 */
  entry: 'market' | 'limit';
  /**
   * 这张限价单的**意图**:`limit` = 带单员给的具体价(按 0.55%/0.05% 两道闸验);
   * `market` = 市价意图翻出来的顶偏离价(按本品种滑点上限验,见 `checkLimitPrice` 的 P1-03 注释)。
   */
  intent: 'limit' | 'market';
  /** 真正要挂的价(单档时 = legs[0].price)。 */
  price: string | null;
  legs: EntryLeg[];
  stop: string | null;
  /** 多档止盈 [{price, percent}]。 */
  take_profits: { price: string; percent: number }[];
  /**
   * 非空 = 这条信号的入场形态本实现**无法忠实执行**(目前只有多档阶梯),必须转人工,
   * 绝不许「按第一档挂全量」偷偷降级。`ok` 同时为 false。
   */
  unsupported: string | null;
  reason: string;
}

export interface EntryPlanInputs {
  signal: TraderSignal;
  mark: number;
  /** agent 给的止损(gated 模式);更紧的那个赢。 */
  agent_stop?: string | null;
}

/**
 * 信号 + mark → 入场计划。[8794] 的取价规则都在这:
 *
 * - **区间**(`zone`,原文给 low/high):按方向取更容易成交的一侧 —— 做空取**最大值**、做多取**最小值**,
 *   挂一张单。这是 8794 `entry_price_for_side` 的原口径。
 * - **单价**(`limit`):照挂。
 * - **市价意图**(`market`,或压根没给价):翻成「顶着滑点上限的限价」,`intent='market'`,
 *   由 `checkLimitPrice` 用滑点上限那把尺子验(不发裸市价、不追价)。
 * - **多档阶梯**(`ladder`,原文给 `prices: [...]` 这种明确的一串价位):8794 的口径是每档独立挂单、
 *   按权重均分。**本实现不支持**,所以返回 `unsupported` 转人工,而不是把全量挂在第一档上 ——
 *   后者是「计划说三档、场上一档」的假执行,风险分布和成交概率都和计划不是一回事(复审 P1-02)。
 *
 * 止损取「更紧的那个」(gated 模式下 agent 的止损更紧就用 agent 的,设计 §0),
 * 并且按**真正要挂的那个价**做方向体检。
 */
export function entryPlanFor(inp: EntryPlanInputs): EntryPlan {
  const { signal, mark } = inp;
  const side = signal.side;
  const base = { entry: 'limit' as const, intent: 'limit' as const, price: null, legs: [] as EntryLeg[], stop: null, take_profits: [] as { price: string; percent: number }[] };
  const fail = (reason: string): EntryPlan => ({ ...base, ok: false, unsupported: null, reason });
  if (side === null) return fail('信号没有方向');
  if (!(mark > 0)) return fail('标记价不可用');

  // 阶梯:先拒,别降级。
  if (signal.entry_kind === 'ladder' && signal.entry_prices.length > 1) {
    const percents = splitPercents(signal.entry_prices.length);
    return {
      ...base,
      ok: false,
      legs: signal.entry_prices.map((price, i) => ({ price, percent: percents[i]! })),
      unsupported: `多档阶梯入场(${signal.entry_prices.length} 档:${signal.entry_prices.join('/')})`,
      reason: `多档阶梯要每档独立挂单,本实现的线程只有一条入场腿 —— 不按第一档挂全量,转人工`,
    };
  }

  let leg: EntryLeg;
  let intent: 'limit' | 'market' = 'limit';
  let entryReason: string;
  if (signal.entry_kind === 'market' || !signal.entry_prices.length) {
    const px = marketableLimitPrice(mark, side, signal.symbol);
    if (px === null) return fail('市价意图算不出限价');
    leg = { price: px, percent: 100 };
    intent = 'market';
    entryReason = `市价意图 → 顶着滑点上限的限价 ${px}`;
  } else if (signal.entry_prices.length === 1) {
    leg = { price: signal.entry_prices[0]!, percent: 100 };
    entryReason = `单价入场 ${leg.price}`;
  } else {
    // 区间:按方向取更容易成交的一侧。**取的价就是要挂的价**(第一版算出 picked 只写进文案,
    // 挂的仍是排序后的第一个 → 空头区间永远挂在最低价那头,取错边)。
    const picked = entryPriceForSide(signal.entry_prices, side);
    if (picked === null) return fail('区间取价失败');
    leg = { price: picked, percent: 100 };
    entryReason = `区间 [${signal.entry_prices.join(', ')}] 做${side === 'long' ? '多取最小' : '空取最大'} → ${picked}`;
  }

  // 止损:信号的 vs agent 的,取更紧(离入场更近)的那个。
  const ref = Number(leg.price);
  const candidates = [signal.stop, inp.agent_stop ?? null].filter((x): x is string => x !== null && Number(x) > 0);
  let stop: string | null = null;
  for (const c of candidates) {
    if (stop === null) stop = c;
    else if (side === 'long' ? Number(c) > Number(stop) : Number(c) < Number(stop)) stop = c;
  }
  if (stop !== null) {
    const ok = side === 'long' ? Number(stop) < ref : Number(stop) > ref;
    if (!ok) return fail(`止损 ${stop} 在入场价 ${ref} 的错误一侧`);
  }
  const shares = remapTpShares(signal.tps);
  return {
    ok: true,
    entry: 'limit',
    intent,
    price: leg.price,
    legs: [leg],
    stop,
    take_profits: signal.tps.map((tp, i) => ({ price: tp.price, percent: shares[i]! })),
    unsupported: null,
    reason: entryReason + (inp.agent_stop && stop === inp.agent_stop ? `;止损取 agent 的 ${stop}(更紧)` : ''),
  };
}

// ---------------------------------------------------------------- 管理动作路由

export type ManagementKind = 'close' | 'reduce' | 'stop_tighten' | 'stop_loosen' | 'take_profit_update' | 'cancel_entries' | 'add_manual' | 'none';

export interface ManagementPlan {
  kind: ManagementKind;
  thread_id: string | null;
  /** `reduce` 的比例(百分数);信号没给 → 50(设计 §2)。 */
  reduce_pct: number | null;
  /** `stop_tighten` 的目标价。 */
  stop_price: string | null;
  /** `take_profit_update` 的新分档。 */
  take_profits: { price: string; percent: number }[];
  /** true = 要人批(放松止损);自动链路不动仓。 */
  pending_review: boolean;
  codes: DecisionReasonCode[];
  note: string;
}

export interface LinkResult {
  thread: StrategyThread | null;
  /** 关联不上时的原因(进 `trader_mgmt_orphan` 的留痕文案);关联成功为空串。 */
  reason: string;
}

/**
 * 管理动作找线程(复审 P0-01)。**关联不上就是孤儿,绝不回退到「同币随便挑一条」** ——
 * 调用方执行的是「平掉这条线程认领的仓」,挑错线程 = 平掉一笔不属于这条信号的仓位。
 *
 * 四条硬规则:
 * 1. 原文明确引用了某一单(`target_order_ref`)→ **只认精确命中**。查不到就是孤儿:
 *    「昨天那单」已经结束、或引用解析不出来时,回退到当前在仓的新单就会用一条迟到的离场指令平掉新仓。
 * 2. 信号带方向 → 方向必须一致(`close_long` 只能平多仓)。方向不符按孤儿处理。
 * 3. 无引用、方向也定不下来时,候选**必须唯一**;同币多条活线程一律孤儿(挑不出来就不猜)。
 * 4. 永远只在 `origin === 'trader:<本人>'` 的线程里找:别人的线程、agent 自己的线程都不碰。
 */
export function linkThread(signal: TraderSignal, liveThreads: readonly StrategyThread[]): LinkResult {
  const origin = `trader:${signal.subscription_job_id ?? signal.trader}`;
  const mine = liveThreads.filter((t) => t.origin === origin && t.symbol === signal.symbol);
  if (!mine.length) return { thread: null, reason: `${signal.trader} 在 ${signal.symbol} 上没有活线程` };
  if (signal.ref_order) {
    const exact = mine.filter((t) => t.trader_signal_id === signal.ref_order || t.id === signal.ref_order);
    if (exact.length !== 1) {
      return { thread: null, reason: `信号明确引用 ${signal.ref_order},本地${exact.length === 0 ? '找不到那一单' : `有 ${exact.length} 条同引用线程`};不回退到别的线程` };
    }
    if (signal.side !== null && exact[0]!.side !== signal.side) {
      return { thread: null, reason: `引用的线程 ${exact[0]!.id} 是${exact[0]!.side},与信号方向 ${signal.side} 不符` };
    }
    return { thread: exact[0]!, reason: '' };
  }
  if (signal.side !== null) {
    const same = mine.filter((t) => t.side === signal.side);
    if (same.length === 1) return { thread: same[0]!, reason: '' };
    return { thread: null, reason: same.length === 0 ? `${signal.symbol} 上只有${mine[0]!.side}线程,与信号方向 ${signal.side} 不符` : `${signal.symbol} 上有 ${same.length} 条同向线程,挑不出是哪一单` };
  }
  if (mine.length > 1) return { thread: null, reason: `信号没有方向也没有引用,而 ${signal.symbol} 上有 ${mine.length} 条活线程,挑不出是哪一单` };
  return { thread: mine[0]!, reason: '' };
}

/** 减仓语义的关键词:百分比必须**贴着**这些词出现,才算「减多少」。 */
const REDUCE_TOKENS = ['减仓', '减', '平掉', '平', '止盈', '出', '减少', 'reduce', 'close', 'tp', 'take profit'];
/** 明显不是仓位比例的百分比(收益、涨跌幅、资金费…)。命中就当这条百分比与减仓无关。 */
const NOT_REDUCE_TOKENS = ['收益', '盈利', '利润', '回撤', '涨', '跌', '资金费', '仓位', '保证金', 'pnl', 'profit', 'roi'];

/**
 * 从原文抠减仓百分比(复审 P1-11)。
 *
 * 第一版是「全文第一个百分号」:「收益 100%,减仓 50%」会取到 100 直接全平,
 * 「2% 仓位,减半」会取到 2。现在只认**贴着减仓语义**的百分比:取每个百分比前后各 6 个字的窗口,
 * 窗口里有减仓词、且没有收益/仓位这类词才算候选。
 *
 * 返回 `{ pct, ambiguous }`:`ambiguous=true` 表示原文里有互相矛盾的候选(或只有一个不可信的百分比),
 * 调用方必须转人工,**不能**默认按一半 —— 「减一半」和「减 30%」之间猜错都是真金白银。
 */
export function reducePercentOf(signal: TraderSignal): { pct: number | null; ambiguous: boolean } {
  const text = signal.raw_text;
  const hits: number[] = [];
  let rejected = 0;
  for (const m of text.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0 || n > 100) continue;
    const at = m.index ?? 0;
    const window = text.slice(Math.max(0, at - 6), Math.min(text.length, at + (m[0]?.length ?? 0) + 6)).toLowerCase();
    const isReduce = REDUCE_TOKENS.some((t) => window.includes(t));
    const isOther = NOT_REDUCE_TOKENS.some((t) => window.includes(t));
    if (isReduce && !isOther) hits.push(n);
    else rejected++;
  }
  const unique = [...new Set(hits)];
  if (unique.length === 1) return { pct: unique[0]!, ambiguous: false };
  if (unique.length > 1) return { pct: null, ambiguous: true };
  // 一个都没认出来但原文里确实有百分比 → 那些百分比说的是别的事,这条没给比例。
  // 「减半 / 一半 / half」是明确的一半,不算含糊。
  if (/减半|一半|半仓|half/i.test(text)) return { pct: 50, ambiguous: false };
  return { pct: null, ambiguous: rejected > 0 };
}

/**
 * **首发总闸:跟单 session 不做任何自动的交易所写操作**(三审之后,2026-09-13 拍板)。
 *
 * `false` 时:copy/gated 的自动开仓、`close`/`stopped_out` 自动平仓、`cancel` 自动撤腿**全部不走**。
 * 所有 `open`/`add`(含 copy 模式)最终落 `review_only`;gated 仍然跑 agent 判断 ——
 * 那次判断的结论与理由码写进信号行,是**给人的依据**,不是执行许可。管理动作一律 `review_only`。
 *
 * 为什么是代码常量、不进设置也不进 API:它不是一个「功能开关」,而是「这套东西还没拿到自动动钱的资格」。
 * 三审列的 R3-01(close 仍会走到按 symbol 撤单/平整币)、R3-02(实际开仓与保护巡检没进同一条账户串行)、
 * R3-03(最后授权不在最后、不比冻结风险上限)、R3-05(信号几何没过持仓经济闸)都还在;
 * 这些修完、并且过了离线故障验收之后才谈打开它。
 *
 * 人做的事走**既有人工链路**:`POST /api/follow/signals/:id/apply`(用信号几何走手动开仓)、
 * `.../close`(手动平本线程)、`.../skip`。`review_only` 是唯一的「可执行前态」。
 *
 * 自动路径的代码留在这个常量后面(改回来是一行),但有一条「零写调用」测试兜底:
 * 任何模式、任何动作、任何恢复路径,follow 链路对 backend 的写方法调用次数必须是 0。
 */
export const FOLLOW_AUTO_EXECUTION = false;

/**
 * **首发自动执行的管理动作**(R2 收缩范围,2026-09-13):只有这三种。
 * 它们的共同点是「减敞口且不需要按比例定量」—— 平掉本线程、撤掉本线程自己那张入场腿。
 *
 * **注意**:`FOLLOW_AUTO_EXECUTION=false` 期间这张表一条都不会自动走 —— 它记的是
 * 「等自动执行开闸时,首批允许自动做的是哪几个」。
 */
export const AUTO_MANAGEMENT_ACTIONS: readonly TraderAction[] = ['close', 'stopped_out', 'cancel'];

/** 三类仓位管理动作固定转人工，订阅设置不能解除。 */
export const MANUAL_ONLY_ACTIONS: readonly TraderAction[] = ['reduce', 'stop_loss_update', 'take_profit_update'];

/**
 * 管理动作 → 动作计划(设计 §2「管理」+ §「首发范围收缩」)。
 *
 * 首发只自动执行 `close` / `stopped_out`(平本线程)与 `cancel`(撤本线程入场腿);
 * `reduce` / `stop_loss_update` / `take_profit_update` **一律 `pending_review`**,不动仓、不撤单
 * —— 二审 R2-04/R2-05 实锤:改保护腿的实现会按 symbol 扫撤同币条件单(能撤掉人工挂的保护)、
 * 撤一半失败没有恢复、TP 挂失败仍报成功;按比例减仓又缺成交归属与余量收口。这三样没做好之前,
 * 自动执行它们比不执行危险得多。
 *
 * 找不到关联线程 → `trader_mgmt_orphan`,不动仓(8794 孤儿仓纪律:只提醒不自动动手)。
 */
export function routeManagement(signal: TraderSignal, thread: StrategyThread | null, opts: { link_reason?: string; auto_manage?: boolean } = {}): ManagementPlan {
  const none = (note: string, codes: DecisionReasonCode[] = []): ManagementPlan => ({ kind: 'none', thread_id: thread?.id ?? null, reduce_pct: null, stop_price: null, take_profits: [], pending_review: false, codes, note });
  const review = (kind: ManagementKind, note: string, patch: Partial<ManagementPlan> = {}): ManagementPlan => ({ kind, thread_id: thread?.id ?? null, reduce_pct: null, stop_price: null, take_profits: [], pending_review: true, codes: [], note, ...patch });
  if (signal.action === 'add') return { ...none('加仓信号不自动执行,留人工', ['trader_add_manual']), kind: 'add_manual', thread_id: thread?.id ?? null };
  if (!isManagementAction(signal.action)) return none(`${signal.action} 不是管理动作`);
  if (!thread) return { ...none(`${signal.trader} 的 ${signal.action} 关联不到线程,不动仓${opts.link_reason ? `:${opts.link_reason}` : ''}`, ['trader_mgmt_orphan']), kind: 'none' };

  // 三类管理动作固定人工；兼容调用传 auto_manage:true 也不能解除。
  if (MANUAL_ONLY_ACTIONS.includes(signal.action)) {
    const what = signal.action === 'reduce' ? '减仓' : signal.action === 'stop_loss_update' ? '移动止损' : '改止盈';
    const detail = signal.action === 'reduce'
      ? `想减${describeReduce(signal)}`
      : signal.action === 'stop_loss_update'
        ? `目标止损 ${signal.stop ?? '未给'}${mentionsCostBasis(signal.raw_text) ? '(原文提到保本/成本口径)' : ''}`
        : `目标止盈 ${signal.tps.map((t) => t.price).join('/') || '未给'}`;
    return review(signal.action === 'reduce' ? 'reduce' : signal.action === 'stop_loss_update' ? 'stop_tighten' : 'take_profit_update',
      `${signal.trader} 的${what}信号(${detail})—— 首发不自动执行仓位管理,已挂进人工队列,不动仓不撤单`,
      signal.action === 'take_profit_update' ? { take_profits: signal.tps.map((tp) => ({ price: tp.price, percent: 0 })) } : { stop_price: signal.action === 'stop_loss_update' ? signal.stop : null, reduce_pct: signal.action === 'reduce' ? reducePercentOf(signal).pct : null });
  }

  switch (signal.action) {
    case 'close':
    case 'stopped_out':
      // 离场纪律强于入场:copy 与 gated 都自动平(8794 离场硬门的教训)。
      return { kind: 'close', thread_id: thread.id, reduce_pct: null, stop_price: null, take_profits: [], pending_review: false, codes: [], note: `带单员${signal.action === 'close' ? '平仓' : '止损出局'} → 平线程 ${thread.id}` };
    case 'cancel':
      // 撤本线程自己那张未成交入场腿(8794 里这是唯一默认开的自动动作:减敞口)。已成交的仓不动。
      return { kind: 'cancel_entries', thread_id: thread.id, reduce_pct: null, stop_price: null, take_profits: [], pending_review: false, codes: [], note: `撤线程 ${thread.id} 未成交的入场腿` };
    default:
      // reduce / stop_loss_update / take_profit_update 只可能从上面那个分支出去。
      return review('none', `${signal.action} 首发不自动执行,已挂进人工队列`);
  }
}

/** 人工队列的文案用:把「想减多少」说清楚(读不出来就说读不出来)。 */
function describeReduce(signal: TraderSignal): string {
  const r = reducePercentOf(signal);
  if (r.pct !== null) return ` ${r.pct}%`;
  return r.ambiguous ? '仓(原文里的比例互相矛盾或含糊,读不出来)' : '仓(原文没给比例)';
}

// ---------------------------------------------------------------- 仓位

/**
 * 跟单仓位的风险预算:`risk_pct × weight`。**不用**带单员自称的仓位比重
 * (研究报告 §1「TraderB」节:2% 保证金 100 倍不是可比的风险权重)。
 */
export function followRiskPct(riskPct: string | number, weight: number): string {
  const base = Number(riskPct);
  const w = Number.isFinite(weight) && weight > 0 ? weight : 0;
  if (!Number.isFinite(base) || base <= 0 || w <= 0) return '0';
  return String(Math.round(base * w * 10000) / 10000);
}

// ---------------------------------------------------------------- agent 同向判定(gated)

export type AgentStance = 'agree' | 'disagree' | 'flat';

/** gated 模式:agent 这次判断跟信号是不是同向。 */
export function agentStanceFor(signalSide: Direction | null, agent: { action: string | null; direction: Direction | null } | null): { stance: AgentStance; code: DecisionReasonCode } {
  if (!agent || agent.action !== 'PROPOSE' || agent.direction === null) return { stance: 'flat', code: 'trader_follow_agent_flat' };
  if (signalSide === null) return { stance: 'flat', code: 'trader_follow_agent_flat' };
  return agent.direction === signalSide ? { stance: 'agree', code: 'trader_follow_agent_agree' } : { stance: 'disagree', code: 'trader_follow_agent_disagree' };
}

// ---------------------------------------------------------------- 编排

/**
 * 编排要用到的 runtime 能力。全是**函数注入**:单测给一组假实现就能把设计 §5 的分支跑遍,
 * 不起 http、不连交易所、不调模型。真实现在 `runtime.ts` 的 `followDeps()` 里。
 */
export interface FollowDeps {
  follow: () => FollowSettings;
  stats: () => TraderStatsSnapshot | null;
  signals: {
    capture: (sig: TraderSignal) => { signal: TraderSignal; created: boolean };
    save: (sig: TraderSignal) => void;
    find: (idOrSignalId: string) => TraderSignal | null;
    openingsSince: (trader: string, sinceAt: number) => number;
    /** 原子领取一条 `review_only` 去执行(写 claim 三件套);抢不到返回 null。 */
    claimForApply?: (idOrSignalId: string, owner: string, claimId: string, now: number) => TraderSignal | null;
    /** 这次领取还在不在(发送前回调用,R5-01)。 */
    claimStillOwned?: (id: string, claimId: string) => boolean;
    /** 按领取身份保存结果;返回 false = 已被隔离/接管,放弃保存。 */
    saveIfOwned?: (sig: TraderSignal, claimId: string) => boolean;
    /** 人工「已核对」:只清 needs_reconcile。 */
    clearNeedsReconcile?: (id: string, now: number) => TraderSignal | null;
  };
  /** 这一次操作的唯一 id(uuid);runtime 注入。 */
  newClaimId?: () => string;
  /** 领取者身份 = 本进程 epoch;runtime 注入。 */
  claimOwner?: () => string;
  now?: () => number;
  /** 当天的日界(每日上限按它数);缺省 UTC 零点。 */
  dayStart?: (now: number) => number;
  liveThreads: () => StrategyThread[];
  /** 已结束的同人同币线程(只给 R53 再入场留痕用);不给也行。 */
  priorThreads?: () => StrategyThread[];
  markOf: (symbol: string) => Promise<number | null>;
  symbolSupported: (symbol: string) => Promise<boolean>;
  /** 按信号几何开一条线程(复用手动开仓链:止损校验、名义上限、preflight)。 */
  /**
   * **人工**开仓:用信号几何走**既有的手动开仓链路**(`source:'manual'` 那条)。
   * 首发人点「跟」走的就是它 —— 止损校验、名义上限、`preflightOpen`、entry_style、事件黑窗、
   * 每日开仓上限全在那条链里,线程带 `origin:'trader:<name>'` 与 `trader_signal_id` 关联回信号。
   */
  manualOpen: (sig: TraderSignal, plan: EntryPlan, ctx: { weight: WeightView | null; episode_id: string | null; authorize?: () => { ok: boolean; reason: string } }) => Promise<OpenFromSignalResult>;
  /**
   * 按信号几何开一条线程(复用手动开仓链:止损校验、名义上限、preflight)。
   * 仓位由实现侧用 `followRiskPct(workflow.risk_pct, ctx.weight.weight)` 算 —— 这里只给权重,
   * 不给一个现成的 risk_pct,免得两处各算一遍对不上。
   */
  /** book 模式:交给组合经理那条路(runtime `bookOpenFromSignal`);`approval` 决定生成待批意图还是直接执行。 */
  openFromSignal: (sig: TraderSignal, plan: EntryPlan, ctx: { weight: WeightView | null; episode_id: string | null; approval: FollowApproval; authorize?: () => { ok: boolean; reason: string } }) => Promise<OpenFromSignalResult>;
  /** gated 模式:把信号当证据跑一次 scan episode,拿 agent 的结论。 */
  /**
   * gated 模式:把信号当证据跑一次 scan episode,拿 agent 的结论。
   * `blocked` 是**那次判断被哪些闸拒了**(reducer 不接受 / gates 有 false);非空时不许自动开仓(P1-04)。
   */
  judge: (sig: TraderSignal) => Promise<{ episode_id: string | null; action: string | null; direction: Direction | null; stop: string | null; blocked: string[]; error: string | null }>;
  /**
   * 管理动作的执行口。**只剩这两个**(R2 收缩范围):平本线程、撤本线程自己的入场腿。
   * 减仓 / 移损 / 改止盈没有执行器 —— 它们在 `routeManagement` 里就被判成 `pending_review`。
   *
   * **必须回报「有没有确认成功」**:`ok:false`(含回执 unknown)时编排不标 `mgmt_applied`,
   * 改成 `review_only` 并进人工队列(P1-08:失败/unknown 被标成已执行是最危险的撒谎)。
   */
  closeThread: (threadId: string, reason: string) => Promise<ManagementResult>;
  cancelEntries: (threadId: string, reason: string) => Promise<ManagementResult>;
  /** 判断账本落一行 `source='trader'`(每条 open/add 都落,跟不跟都落)。 */
  recordLedger: (sig: TraderSignal, ctx: { thread_id: string | null; episode_id: string | null; mode: FollowMode | null; codes: DecisionReasonCode[] }) => void;
  /** 权重(runtime 注入带天花板的那版,二审 P1-13);不注入则用纯 `weightFor`。 */
  weightOf?: (trader: string, manualWeight: number) => WeightView;
  /** 秘密脱敏(runtime 注入 `redactSecrets`);任何要落库 / 进 SSE / 进日志的外部文本都过它。 */
  redact?: (text: string) => string;
  /** 人工 apply 之后把执行关联补进判断账本那一行(复审 P2-02)。 */
  attachLedgerThread?: (sig: TraderSignal, threadId: string) => void;
  /** SSE `trader_signal`。 */
  emit: (sig: TraderSignal) => void;
  log: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /** 人工需要批准的动作进这里(放松止损);只留痕,不动仓。 */
  pendingReview?: (sig: TraderSignal, plan: ManagementPlan) => void;
}

function utcDayStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * 一次「按信号几何开仓」的**结构化结果**(R5-02)。
 *
 * 分四种,因为它们的善后完全不同:
 * - `rejected`:闸拒 / 参数不对 —— 交易所那边什么都没发生,**可以再试**。
 * - `failed_before_send`:线程建了但没发出去(发送前授权撤销、数量不可用)—— 同样可以再试。
 * - `unknown`:**已经在发送**之后出的问题 —— 交易所可能已经收到,必须带 `thread_id` 交给人对账,
 *   绝不能伪装成「明确失败」。
 * - `opened`:开出来了。
 *
 * 第一版把这四种全压成 `{thread_id:null, error}` → 一律记 `apply_failed`,把「需要核对」
 * 说成了「明确失败」,而且丢了线程关联。
 */
export type OpenFromSignalResult =
  | { outcome: 'opened'; thread_id: string; reason: string }
  | { outcome: 'rejected'; reason: string; thread_id?: string | null; /** §9.56 结构化拒绝:哪一层、原因码、原样闸结果 */ layer?: 'judge' | 'strategy' | 'gate' | 'execution'; code?: string; gates?: import('./types.js').GateResult[] }
  | { outcome: 'failed_before_send'; reason: string; thread_id?: string | null }
  | { outcome: 'unknown'; reason: string; thread_id?: string | null };

/** 一次管理动作的执行回报。`ok` 只在**确认成功**时为 true(unknown 一律 false)。 */
export interface ManagementResult {
  ok: boolean;
  /** 人能读的一句话:平了多少、挂上没有、失败原因。 */
  detail: string;
}

/**
 * 管理动作的新鲜度下限(秒)。比开仓的 `freshness_s`(默认 180s)宽:离场指令迟到几分钟仍然该跟,
 * 但也不能无限宽 —— 8794 的 `order_management.freshness_seconds` 默认就是 300s,这里取同一个数。
 */
export const MANAGEMENT_FRESHNESS_FLOOR_S = 300;

export interface IngestOutcome {
  signal: TraderSignal;
  mode: FollowMode | null;
  /** 管理动作的计划(开仓类为 null)。 */
  management: ManagementPlan | null;
  codes: DecisionReasonCode[];
  note: string;
}

/**
 * 跟单编排器。一条信号进来走一条路:
 * - 管理动作 → `routeManagement` → 执行(孤儿只留痕)
 * - open/add → `resolveMode` → copy 直接开 / gated 先判断再开 / evidence 只留痕
 *
 * **永远不抛**:一条信号处理失败只写 `skipped` 并 log(拉取循环不能被一条坏信号打断)。
 */
export class TraderFollow {
  constructor(private readonly deps: FollowDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** 权重:有注入就用注入的(带天花板),否则纯函数版。 */
  private weightOf(trader: string, manualWeight: number, now: number): WeightView {
    const f = this.deps.follow();
    return this.deps.weightOf?.(trader, manualWeight) ?? localWeight(trader, manualWeight);
  }

  /** 一批信号顺序处理(顺序要紧:同一条线程的 open 必须在它的 close 之前处理完)。 */
  async ingestMany(signals: readonly TraderSignal[]): Promise<IngestOutcome[]> {
    const out: IngestOutcome[] = [];
    for (const sig of signals) out.push(await this.ingest(sig));
    return out;
  }

  async ingest(incoming: TraderSignal): Promise<IngestOutcome> {
    const { signal, created } = this.deps.signals.capture(incoming);
    if (signal.kind === 'arbitrage') return {signal, mode:'evidence', management:null, codes:[], note:'arbitrage_recorded_only'};
    // 幂等的判据是**状态**,不是「这行是不是刚建的」(P1-06)。
    // `new` = 落库了但一个动钱调用都还没发过 → 可以接着处理。
    // **`triggered` 一律不重跑**(R3-04):它是「已经发出、没记完」那个窗口的标记,
    // 重跑等于再发一次。这里和 runtime 的 `storeSignals` / `resumeInbox` 是同一条纪律 ——
    // 三个入口都拒绝,不是只有恢复那一个。
    if (!created && signal.status === 'triggered') {
      return { signal, mode: signal.mode_applied, management: null, codes: signal.decision?.codes ?? [], note: '这条上次已经发出过动作(状态不确定),不重发;等人工核对' };
    }
    if (!created && signal.status !== 'new') {
      return { signal, mode: signal.mode_applied, management: null, codes: signal.decision?.codes ?? [], note: `同一条信号已处置为 ${signal.status}(幂等)` };
    }
    if (created) this.deps.emit(signal);
    try {
      return isOpeningAction(signal.action) ? await this.ingestOpening(signal) : await this.ingestManagement(signal);
    } catch (e) {
      // P1-14:异常消息可能带着 bridge 凭证 / 原始 URL;它会进 decision.note → SSE → 前端。
      // 统一过一遍脱敏(没注入 redact 时退到原消息,但 runtime 侧一定注入)。
      const msg = (this.deps.redact ?? ((x: string) => x))((e as Error).message);
      // R2-02:异常**不当成「决定不跟」**。可能已经发出去过了,转人工核对而不是记 skipped。
      const latest = this.deps.signals.find(signal.signal_id) ?? signal;
      const uncertain = latest.status === 'triggered' || latest.needs_reconcile;
      const finished = this.finish({ ...latest, needs_reconcile: uncertain }, 'review_only', latest.mode_applied, latest.thread_id, ['trader_gate_blocked'], `处理过程中出错,状态不确定,等人工核对:${msg}`);
      this.deps.log('error', `跟单信号 ${signal.signal_id} 处理失败(转人工):${msg}`);
      this.deps.pendingReview?.(finished, { kind: 'none', thread_id: signal.thread_id, reduce_pct: null, stop_price: null, take_profits: [], pending_review: true, codes: [], note: `处理出错,状态不确定:${msg}` });
      return { signal: finished, mode: null, management: null, codes: [], note: msg };
    }
  }

  private finish(sig: TraderSignal, status: TraderSignalStatus, mode: FollowMode | null, threadId: string | null, codes: DecisionReasonCode[], note: string, extra: { episode_id?: string | null; weight?: number | null; agent?: TraderAgentVerdict | null; plan?: TraderDecision['plan'] } = {}): TraderSignal {
    const next: TraderSignal = {
      ...sig,
      status,
      mode_applied: mode,
      thread_id: threadId,
      decision: {
        codes,
        note: (this.deps.redact ?? ((x: string) => x))(note),
        at: this.now(),
        episode_id: extra.episode_id ?? sig.decision?.episode_id ?? null,
        weight: extra.weight ?? sig.decision?.weight ?? null,
        // R4-07:**不清空**已经算出来的 agent 结论与可执行几何 ——
        // 人工处理之后「当初为什么跟 / 按什么几何跟」必须还在行上,否则复盘时依据就没了。
        agent: extra.agent ?? sig.decision?.agent ?? null,
        plan: extra.plan ?? sig.decision?.plan ?? null,
      },
      updated_at: this.now(),
    };
    this.deps.signals.save(next);
    this.deps.emit(next);
    return next;
  }

  // ---- open / add

  private async ingestOpening(sig: TraderSignal): Promise<IngestOutcome> {
    const follow = this.deps.follow();
    const now = this.now();
    const dayStart = (this.deps.dayStart ?? utcDayStart)(now);
    const decision = resolveMode({
      signal: sig,
      follow,
      stats: this.deps.stats(),
      now,
      openings_today: this.deps.signals.openingsSince(sig.trader, dayStart),
      symbol_supported: await this.deps.symbolSupported(sig.symbol).catch(() => true),
      ...(this.deps.weightOf ? { weight_of: this.deps.weightOf } : {}),
    });
    const weight = decision.weight;
    // 每条 open/add 都要在判断账本里留一行(跟了没跟都留),否则跟单腿没法和反事实对账。
    // **thread_id 只在这条信号自己真的开出线程时才填**(复审 P2-02:重复开仓被拒时填别人的线程 id,
    // 会让多条没执行的信号去蹭同一笔仓的 realized)。
    const ledger = (threadId: string | null, episodeId: string | null): void => {
      try {
        this.deps.recordLedger(sig, { thread_id: threadId, episode_id: episodeId, mode: decision.mode, codes: decision.codes });
      } catch (e) {
        this.deps.log('warn', `跟单判断账本落行失败:${(e as Error).message}`);
      }
    };
    const stop = (status: TraderSignalStatus, codes: DecisionReasonCode[], note: string, extra: { episode_id?: string | null; agent?: TraderAgentVerdict | null; plan?: TraderDecision['plan'] } = {}): IngestOutcome => {
      const done = this.finish(sig, status, decision.mode, null, codes, note, { episode_id: extra.episode_id ?? null, weight: weight?.weight ?? null, agent: extra.agent ?? null, plan: extra.plan ?? null });
      ledger(null, extra.episode_id ?? null);
      return { signal: done, mode: decision.mode, management: null, codes, note };
    };

    // 复审 P1-01:**只有 `triggered` 才许进开仓分支**。
    // 第一版只看 `decision.mode`,于是 copy 模式下的 `add`(resolveMode 已经判了 `skipped` +
    // `trader_add_manual`)照样一路开到 applied —— 「加仓不自动执行」这条纪律直接被绕过去了。
    if (decision.mode === null || decision.mode === 'evidence' || decision.status !== 'triggered') {
      return stop(decision.status, decision.codes, decision.note);
    }

    const live = this.deps.liveThreads();
    // 反向敞口先判(它比重复开仓更硬:反向开仓等于平别人的仓)。
    const reverse = reverseCheck(sig, live);
    if (reverse.blocked) {
      const note = `${sig.symbol} 已有反向线程 ${reverse.thread?.id}(${reverse.thread?.side}),拒开`;
      this.deps.log('warn', `跟单拒开:${note}`);
      return stop('skipped', [...decision.codes, 'trader_reverse_exposure'], note);
    }
    const dup = duplicateCheck({ signal: sig, live_threads: live, prior_threads: this.deps.priorThreads?.() });
    if (dup.verdict === 'duplicate_open') {
      return stop('skipped', [...decision.codes, 'trader_duplicate_open'], dup.note);
    }

    // gated:先跑一次 scan episode,agent 同向**且那次判断的闸全过**才用信号几何开。
    let episodeId: string | null = null;
    let agentStop: string | null = null;
    let verdict: TraderAgentVerdict | null = null;
    const codes: DecisionReasonCode[] = [...decision.codes];
    if (decision.mode === 'gated') {
      const judged = await this.deps.judge(sig);
      episodeId = judged.episode_id;
      if (judged.error) {
        codes.push('trader_follow_agent_flat');
        return stop('skipped', codes, `agent 判断没跑成:${judged.error}`, { episode_id: episodeId });
      }
      const stance = agentStanceFor(sig.side, { action: judged.action, direction: judged.direction });
      codes.push(stance.code);
      // agent 结论一律落在信号行上(同向、反向、不入场都落):首发它就是给人看的依据。
      verdict = { stance: stance.stance, action: judged.action, direction: judged.direction, stop: judged.stop, blocked: judged.blocked };
      if (stance.stance !== 'agree') {
        const note = stance.stance === 'disagree' ? `agent 反向(${judged.direction}),不跟` : `agent 没提议入场(${judged.action ?? '无输出'}),不跟`;
        return stop('skipped', codes, note, { episode_id: episodeId, agent: verdict });
      }
      // 复审 P1-04:模型同向 ≠ 这次判断被放行。策略共识、票池、入场方式这些闸是在 episode 里评的,
      // 被拒时 `reducer.accepted=false` 而 `ep.error` 仍是 null —— 第一版只看 error,于是
      // 「议会没共识」「策略版本不匹配」这类否决被跟单腿整个绕过去了。任何否决都拦住自动开仓。
      if (judged.blocked.length) {
        codes.push('trader_gate_blocked');
        return stop('skipped', codes, `agent 同向但这次判断被闸拒:${judged.blocked.join(' / ')}`, { episode_id: episodeId, agent: verdict });
      }
      agentStop = judged.stop;
    }

    const mark = await this.deps.markOf(sig.symbol);
    const plan = entryPlanFor({ signal: sig, mark: mark ?? 0, agent_stop: agentStop });
    // 入场形态本实现执行不了(多档阶梯)→ 转人工,绝不降级成「第一档挂全量」。
    if (plan.unsupported) {
      const note = `${plan.unsupported}:${plan.reason}`;
      this.deps.pendingReview?.(sig, { kind: 'none', thread_id: null, reduce_pct: null, stop_price: null, take_profits: [], pending_review: true, codes: [], note });
      const done = this.finish(sig, 'review_only', decision.mode, null, codes, note, { episode_id: episodeId, weight: weight?.weight ?? null, agent: verdict });
      ledger(null, episodeId);
      return { signal: done, mode: decision.mode, management: null, codes, note };
    }
    if (!plan.ok || (plan.stop === null && !(decision.mode === 'book' && sig.market_type === 'spot'))) {
      const note = plan.stop === null ? '入场计划没有止损,不跟' : `入场计划不可用:${plan.reason}`;
      return stop('skipped', [...codes, 'trader_gate_blocked'], note, { episode_id: episodeId, agent: verdict });
    }
    const planView: TraderDecision['plan'] = {
      entry: plan.price!,
      intent: plan.intent,
      stop: plan.stop,
      take_profits: plan.take_profits.map((tp) => tp.price),
      reason: plan.reason,
    };

    // ---- 首发总闸(FOLLOW_AUTO_EXECUTION=false):**到此为止,不发任何单**。
    // 判定、agent 结论、可执行的几何都算好了并落在信号行上,状态 `review_only` ——
    // 人在界面上点「跟」(`POST /api/follow/signals/:id/apply`)才走手动开仓链路。
    if (!(decision.mode === 'book' && sig.action === 'open')) {
      const agentNote = verdict ? `;agent ${verdict.stance === 'agree' ? '同向' : verdict.stance}${verdict.stop ? `(止损 ${verdict.stop})` : ''}` : '';
      const note = `${decision.mode} 模式判定可跟,但首发不自动开仓:等人工确认(限价 ${planView.entry}${planView.intent === 'market' ? ',市价意图顶偏离价' : ''},止损 ${planView.stop}${planView.take_profits.length ? `,第一档止盈 ${planView.take_profits[0]}` : ''})${agentNote}`;
      this.deps.pendingReview?.(sig, { kind: 'none', thread_id: null, reduce_pct: null, stop_price: planView.stop, take_profits: planView.take_profits.map((price) => ({ price, percent: 0 })), pending_review: true, codes, note });
      const done = this.finish(sig, 'review_only', decision.mode, null, codes, note, { episode_id: episodeId, weight: weight?.weight ?? null, agent: verdict, plan: planView });
      ledger(null, episodeId);
      this.deps.log('info', `跟单 ${sig.trader} ${sig.symbol}:${note}`);
      return { signal: done, mode: decision.mode, management: null, codes, note };
    }

    // 复审 P1-05:发送前重新校验。模型/账户/交易所那几步可能走掉几十秒,这期间
    // 信号可能过期、跟单开关可能被关、这位带单员可能被改成 evidence 或权重调到 0。
    const recheck = this.authorizationNow(sig, 'book 取数之后');
    const subNow = subscriptionFor(this.deps.follow(), sig);
    if (subNow.mode !== 'book') return stop('review_only', [...codes, 'trader_gate_blocked'], 'book 模式已撤销，等人工');
    if (!recheck.ok) {
      return stop('skipped', [...codes, 'trader_gate_blocked'], recheck.reason, { episode_id: episodeId });
    }
    // R2-02:开仓也先把「已发出」落库(崩在发送窗口里时,恢复路径不会再发一次)。
    this.deps.signals.save({ ...sig, status: 'triggered', mode_applied: decision.mode, updated_at: this.now() });
    // R2-01 / P1-05:`openFromSignal` 里还有账户/行情/规则几次 I/O,真正发送前再问一次授权。
    const r = await this.deps.openFromSignal(sig, plan, {
      weight: recheck.weight,
      episode_id: episodeId,
      approval: subNow.approval,
      authorize: () => {
        const again = this.authorizationNow(sig, '发送前');
        const book = subscriptionFor(this.deps.follow(), sig).mode === 'book';
        const weightValid = (again.weight?.weight ?? 0) >= (recheck.weight?.weight ?? 0);
        return { ok: again.ok && book && weightValid, reason: !book ? 'book 模式已撤销' : !weightValid ? '订阅权重已降低，拒绝旧仓位计划' : again.reason };
      },
    });
    if (r.outcome === 'unknown') {
      const done = this.finish(sig, 'review_only', decision.mode, r.thread_id ?? null, ['trader_gate_blocked'], `执行结果未知:${r.reason}`);
      this.deps.signals.save({ ...done, needs_reconcile: true });
      return { signal: { ...done, needs_reconcile: true }, mode: decision.mode, management: null, codes: ['trader_gate_blocked'], note: r.reason };
    }
    if (r.outcome !== 'opened') {
      const note = `开仓被拒:${r.reason}`;
      this.deps.log('warn', `跟单 ${sig.trader} ${sig.symbol} ${note}`);
      return stop('skipped', [...codes, 'trader_gate_blocked'], note, { episode_id: episodeId });
    }
    const pendingApproval = subNow.approval !== 'auto';
    if (pendingApproval) codes.push('trader_follow_book_pending');
    const note = pendingApproval
      ? `组合经理已过闸并算好仓位,线程 ${r.thread_id} 的开仓意图等你在交易页确认(${plan.reason})`
      : `组合经理已过闸,线程 ${r.thread_id} 已交执行(${plan.reason})`;
    const done = this.finish(sig, 'applied', decision.mode, r.thread_id, codes, note, { episode_id: episodeId, weight: recheck.weight?.weight ?? null, agent: verdict, plan: planView });
    ledger(r.thread_id, episodeId);
    this.deps.log('info', `跟单 ${sig.trader} ${sig.symbol} ${sig.side}:${note}`);
    return { signal: done, mode: decision.mode, management: null, codes, note };
  }

  /**
   * 「此刻还准不准跟这条信号」(复审 P1-05)。发送前、人工 apply 前都要问一次:
   * 总开关、名册、模式、权重、信号有效期、新鲜度 —— 任何一条在等待期间变了都得拦住。
   */
  /**
   * 「此刻的**授权**」—— 名册 / 启用 / 模式 / 权重 / 期限可信度。**不含年龄**(R4-03)。
   *
   * 拆开的原因:第一版 `authorizationNow` 把年龄和授权揉在一起,超龄就提前 return,
   * 于是 `force_stale` 那条「reason 里含新鲜度就放行」的豁免会**连带跳过后面的权重检查** ——
   * 「等待期间权重被调成 0」这件事在 force_stale 下查不出来。现在两件事各自独立跑。
   */
  private policyNow(sig: TraderSignal, when: string): { ok: boolean; reason: string; weight: WeightView | null } {
    const follow = this.deps.follow();
    const now = this.now();
    const cfg = subscriptionFor(follow, sig);
    const no = (reason: string): { ok: false; reason: string; weight: null } => ({ ok: false, reason: `${when}:${reason}`, weight: null });
    if (!follow.enabled) return no('跟单总开关已关闭');
    if (!cfg) return no(`带单员 ${sig.trader} 已不在名册`);
    if (!cfg.enabled) return no(`带单员 ${sig.trader} 已停用`);
    if (cfg.mode === 'evidence') return no(`带单员 ${sig.trader} 已改成 evidence 模式`);
    if (sig.invalid_validity) return no('valid_until 不可信(解析不出或早于原发时间)');
    if (isExpired(sig, now)) return no(`信号已过 valid_until(${new Date(sig.valid_until!).toISOString()})`);
    const weight = this.weightOf(sig.trader, cfg.weight, now);
    if (!(weight.weight > 0)) return no(`带单员 ${sig.trader} 权重已是 0`);
    return { ok: true, reason: '', weight };
  }

  /** 「此刻的**年龄**」—— 只判新鲜度。`force_stale` 豁免的只有这一条。 */
  private ageNow(sig: TraderSignal, when: string): { ok: boolean; reason: string; age: number } {
    const follow = this.deps.follow();
    const age = ageSeconds(sig, this.now());
    if (age > follow.freshness_s) return { ok: false, reason: `${when}:信号已 ${age}s,超过新鲜度上限 ${follow.freshness_s}s`, age };
    return { ok: true, reason: '', age };
  }

  /** 两件事一起看(自动路径用;`force_stale` 是人工路径独有的概念)。 */
  private authorizationNow(sig: TraderSignal, when: string): { ok: boolean; reason: string; weight: WeightView | null } {
    const age = this.ageNow(sig, when);
    if (!age.ok) return { ok: false, reason: age.reason, weight: null };
    return this.policyNow(sig, when);
  }

  // ---- 管理动作

  private async ingestManagement(sig: TraderSignal): Promise<IngestOutcome> {
    const follow = this.deps.follow();
    const cfg = subscriptionFor(follow, sig);
    // 名册外 / 停用 / 总开关关:管理动作也只留痕(不能对一个我们没跟的人的信号动仓)。
    if (!follow.enabled || !cfg || !cfg.enabled || cfg.mode === 'evidence') {
      const note = !follow.enabled ? '跟单总开关关闭' : !cfg ? `带单员 ${sig.trader} 不在名册` : !cfg.enabled ? `带单员 ${sig.trader} 已停用` : `${sig.trader} 是 evidence 模式,管理动作只留痕`;
      const done = this.finish(sig, 'evidence', cfg?.mode ?? null, null, [], note);
      return { signal: done, mode: cfg?.mode ?? null, management: null, codes: [], note };
    }
    // ---- 复审 P0-02:**补拉的管理动作永远不动仓**。
    // 重启 / 重新打开 follow 时,补拉会把几天前的 close/reduce/移损重新灌进来;本地如果有在仓线程,
    // 一条三天前的「平了」就会把今天的新仓平掉。历史离场指令的恢复必须走人工,不能靠时间顺序碰运气。
    if (sig.backfill) {
      const plan = routeManagement(sig, null);
      const note = `启动补拉的历史管理动作(${sig.action}),不动仓,等人工确认要不要补执行`;
      this.deps.pendingReview?.(sig, { ...plan, kind: 'none', pending_review: true, note });
      const done = this.finish(sig, 'review_only', cfg.mode, null, [], note);
      this.deps.log('warn', `跟单补拉管理动作只留痕:${sig.trader} ${sig.symbol} ${sig.action}`);
      return { signal: done, mode: cfg.mode, management: null, codes: [], note };
    }
    // 超龄 / 已过有效期 / 期限不可信的管理动作同样不自动动仓(迟到的离场指令和补拉是同一类风险)。
    const now = this.now();
    const age = ageSeconds(sig, now);
    const staleLimit = Math.max(follow.freshness_s, MANAGEMENT_FRESHNESS_FLOOR_S);
    if (sig.invalid_validity || isExpired(sig, now) || age > staleLimit) {
      const note = sig.invalid_validity ? 'valid_until 不可信,管理动作不动仓,等人工' : isExpired(sig, now) ? '管理动作已过 valid_until,不动仓' : `管理动作已 ${age}s(上限 ${staleLimit}s),不动仓,等人工`;
      this.deps.pendingReview?.(sig, { kind: 'none', thread_id: null, reduce_pct: null, stop_price: null, take_profits: [], pending_review: true, codes: ['trader_signal_stale'], note });
      const done = this.finish(sig, 'review_only', cfg.mode, null, ['trader_signal_stale'], note);
      return { signal: done, mode: cfg.mode, management: null, codes: ['trader_signal_stale'], note };
    }

    const link = linkThread(sig, this.deps.liveThreads());
    const plan = routeManagement(sig, link.thread, { link_reason: link.reason });
    if (plan.kind === 'none' || plan.kind === 'add_manual') {
      const status: TraderSignalStatus = plan.codes.includes('trader_mgmt_orphan') ? 'mgmt_orphan' : 'skipped';
      const done = this.finish(sig, status, cfg.mode, plan.thread_id, plan.codes, plan.note);
      if (status === 'mgmt_orphan') this.deps.log('warn', `跟单管理动作孤儿:${plan.note}`);
      return { signal: done, mode: cfg.mode, management: plan, codes: plan.codes, note: plan.note };
    }
    if (plan.pending_review) {
      this.deps.pendingReview?.(sig, plan);
      const done = this.finish(sig, 'review_only', cfg.mode, plan.thread_id, plan.codes, plan.note);
      this.deps.log('warn', `跟单需人工:${plan.note}`);
      return { signal: done, mode: cfg.mode, management: plan, codes: plan.codes, note: plan.note };
    }
    const threadId = plan.thread_id!;

    // Management never reaches an exchange writer, independently of copy/open policy.
    const note = `${sig.trader} ${sig.action}:首发不自动动仓,不自动执行仓位管理,请到交易页自行处理(线程 ${threadId})`;
    const review = { ...plan, pending_review: true, note };
    this.deps.pendingReview?.(sig, review);
    const done = this.finish(sig, 'review_only', cfg.mode, threadId, plan.codes, note);
    return { signal: done, mode: cfg.mode, management: review, codes: plan.codes, note };

  }

  /**
   * 人工按信号几何下单(`POST /api/follow/signals/:id/apply`)。
   *
   * 首发这是**唯一**能让跟单信号真的下单的入口(`FOLLOW_AUTO_EXECUTION=false`),走的是
   * **既有手动开仓链路**(`deps.manualOpen` → runtime 的 `source:'manual'` 那条)。
   *
   * R4-03 / R4-07 的三条纪律:
   * 1. **只有 `review_only` 能 apply**,并且用条件更新**原子领取**成 `applying`;
   *    没抢到就是 409(并发点击 / 状态已变)。靠前端防双击不算互斥。
   * 2. **执行的几何就是行上展示的 `decision.plan`** —— 不重算。重算会让
   *    「页面上写着按 agent 的更紧止损 76500」和「实际发出去的 76000」对不上。
   * 3. **年龄与授权分开判**:`force_stale` 只豁免年龄;名册/启用/模式/权重/期限可信度
   *    独立跑,并且在**发送前**再跑一次(`authorize` 回调)。
   *
   * 终局:成功 → `applied`;明确失败 → `apply_failed`(note 已脱敏,人可以再试);
   * 崩在发送窗口里 → 行留在 `applying`,由 resume 隔离成 `review_only + needs_reconcile`,**不自动重发**。
   */
  async applyManually(idOrSignalId: string, opts: { force_stale?: boolean } = {}): Promise<{ signal: TraderSignal | null; error: string | null; status?: number }> {
    const found = this.deps.signals.find(idOrSignalId);
    if (!found) return { signal: null, error: '信号不存在', status: 404 };
    if (!isOpeningAction(found.action)) return { signal: found, error: '只有开仓类信号能跟', status: 409 };
    // R5-02:`apply_failed` 是**明确失败**,允许再试(状态机有 `apply_failed → applying` 这条边)。
    if (found.status !== EXECUTABLE_PRE_STATUS && found.status !== 'apply_failed') {
      return { signal: found, error: `只有 ${EXECUTABLE_PRE_STATUS} / apply_failed 的信号能跟(这条是 ${found.status})`, status: 409 };
    }
    // R5-01:未决事实没被人核对过之前不许再发 —— 先 `POST .../reconcile`。
    if (found.kind === 'arbitrage') return {signal:found, error:'arbitrage_recorded_only', status:409};
    if (found.needs_reconcile) {
      return { signal: found, error: '这条上次可能已经发出但结果未知;请先到交易所核对,再点「已核对」(reconcile)才能操作', status: 409 };
    }
    // ---- 先把「能不能跟」判完,再领取(领取之后每条失败路径都得落 apply_failed,越少越好)
    const plan = found.decision?.plan ?? null;
    if (!plan) return { signal: found, error: '这条信号行上没有可执行几何(decision.plan);不重算,拒绝执行', status: 409 };
    if (!(found.market_type === 'spot' && plan.stop === null) && !(Number(plan.stop) > 0)) return { signal: found, error: '行上的几何没有止损,不能开仓', status: 409 };
    const age = this.ageNow(found, '人工 apply');
    if (!age.ok && opts.force_stale !== true) {
      return { signal: found, error: `${age.reason};确认要按旧价跟请带 force_stale`, status: 409 };
    }
    // 授权**独立**判(force_stale 不豁免它)
    const policy = this.policyNow(found, '人工 apply');
    if (!policy.ok) return { signal: found, error: policy.reason, status: 409 };
    const live = this.deps.liveThreads();
    const reverse = reverseCheck(found, live);
    if (reverse.blocked) return { signal: found, error: `${found.symbol} 已有反向线程 ${reverse.thread?.id}`, status: 409 };
    if (duplicateCheck({ signal: found, live_threads: live, prior_threads: this.deps.priorThreads?.() }).verdict === 'duplicate_open') {
      return { signal: found, error: `${found.symbol} 已有在仓或挂单线程`, status: 409 };
    }

    // ---- 原子领取(R5-01):写下 claim_id + claim_owner + claim_at
    const claimId = this.deps.newClaimId?.() ?? `claim-${Math.random().toString(36).slice(2)}`;
    const owner = this.deps.claimOwner?.() ?? 'default';
    const claimed = this.deps.signals.claimForApply?.(found.id, owner, claimId, this.now()) ?? null;
    if (!claimed) return { signal: this.deps.signals.find(idOrSignalId), error: '这条信号已经被领取或状态已变(并发点击?)', status: 409 };
    this.deps.emit(claimed);

    /** 结果保存:必须**还持有这次领取**才写(R5-01)。不持有说明已被隔离/接管,旧快照不许覆盖。 */
    const saveOwned = (next: TraderSignal): TraderSignal => {
      const ok = this.deps.signals.saveIfOwned?.(next, claimId) ?? true;
      if (!ok) {
        this.deps.log('warn', `跟单 apply 结果放弃保存:${next.signal_id} 的领取已经不在了(被隔离或被接管),不覆盖当前状态`);
        return this.deps.signals.find(next.id) ?? next;
      }
      const saved = this.deps.signals.find(next.id) ?? next;
      this.deps.emit(saved);
      return saved;
    };

    // ---- 发送(几何原样用行上那份)
    const entryPlan: EntryPlan = {
      ok: true,
      entry: 'limit',
      intent: plan.intent,
      price: plan.entry,
      legs: [{ price: plan.entry, percent: 100 }],
      stop: plan.stop,
      take_profits: plan.take_profits.map((price) => ({ price, percent: 0 })),
      unsupported: null,
      reason: `人工按行上几何执行:${plan.reason}`,
    };
    const r = await this.deps.manualOpen(claimed, entryPlan, {
      weight: policy.weight,
      episode_id: claimed.decision?.episode_id ?? null,
      // 发送前最后一次:**领取还在不在** + 授权还成不成立(年龄那条已由人显式越过)。
      authorize: () => {
        if (this.deps.signals.claimStillOwned && !this.deps.signals.claimStillOwned(claimed.id, claimId)) {
          return { ok: false, reason: '这次领取已经不在了(被隔离或被接管),放弃发送' };
        }
        const again = this.policyNow(claimed, '发送前');
        return { ok: again.ok, reason: again.reason };
      },
    });

    const now = this.now();
    const redact = this.deps.redact ?? ((x: string) => x);
    const withDecision = (status: TraderSignalStatus, threadId: string | null, needsReconcile: boolean, codes: DecisionReasonCode[], note: string): TraderSignal => ({
      ...claimed,
      status,
      mode_applied: 'book',
      thread_id: threadId,
      needs_reconcile: needsReconcile,
      decision: {
        ...(claimed.decision ?? { codes: [], note: '', at: now }),
        codes,
        note: redact(note),
        at: now,
        weight: policy.weight?.weight ?? claimed.decision?.weight ?? null,
      },
      updated_at: now,
    });

    // ---- R5-02:按结果类型分三路善后
    if (r.outcome === 'unknown') {
      // **已经在发送**之后出的问题:保留线程关联 + 打 needs_reconcile,交给人对账;不当「明确失败」。
      const note = `人工 apply 发出后状态不确定:${r.reason};请核对交易所与线程后再决定(不会自动重发)`;
      const saved = saveOwned(withDecision('review_only', r.thread_id ?? claimed.thread_id, true, ['trader_gate_blocked'], note));
      this.deps.log('error', `跟单 apply 不确定:${redact(note)}`);
      return { signal: saved, error: r.reason, status: 409 };
    }
    if (r.outcome !== 'opened') {
      // 明确失败(闸拒 / 发送前失败):可以再试 —— 状态机允许 `apply_failed → applying`。
      const note = `人工 apply 失败(${r.outcome === 'rejected' ? '被闸拒' : '发送前失败'}):${r.reason}`;
      return { signal: saveOwned(withDecision('apply_failed', null, false, ['trader_gate_blocked'], note)), error: r.reason, status: 409 };
    }

    const note = `人工按行上几何跟单:线程 ${r.thread_id}(限价 ${plan.entry},止损 ${plan.stop})${!age.ok ? `;人工越过 ${age.age}s 新鲜度` : ''}`;
    const saved = saveOwned(withDecision('applied', r.thread_id, false, ['trader_follow_copy'], note));
    if (saved.status === 'applied') {
      try {
        this.deps.attachLedgerThread?.(claimed, r.thread_id);
      } catch (e) {
        this.deps.log('warn', `跟单账本补关联失败:${(e as Error).message}`);
      }
    }
    return { signal: saved, error: null };
  }

  /**
   * 人工「已核对」(`POST /api/follow/signals/:id/reconcile`)。
   *
   * **只清 `needs_reconcile` 标记,不动钱、不改别的**。带这个标记的行意味着
   * 「上次可能已经发出去了、我们不知道结果」—— 人去交易所核对完、确认了现状,才把它放回可操作。
   * 清掉之前 apply 与 skip 都拒(R5-01)。
   */
  reconcileManually(idOrSignalId: string): { signal: TraderSignal | null; error: string | null; status?: number } {
    const sig = this.deps.signals.find(idOrSignalId);
    if (!sig) return { signal: null, error: '信号不存在', status: 404 };
    if (!sig.needs_reconcile) return { signal: sig, error: '这条不需要对账', status: 409 };
    const cleared = this.deps.signals.clearNeedsReconcile?.(sig.id, this.now()) ?? null;
    if (!cleared) return { signal: sig, error: '清除标记失败', status: 409 };
    this.deps.log('info', `跟单:${sig.signal_id} 已由人工标记「已核对」,可以再操作`);
    this.deps.emit(cleared);
    return { signal: cleared, error: null };
  }

  /** 人工跳过一条(`POST /api/follow/signals/:id/skip`)。 */
  skipManually(idOrSignalId: string, note = '人工跳过'): { signal: TraderSignal | null; error: string | null; status?: number } {
    const sig = this.deps.signals.find(idOrSignalId);
    if (!sig) return { signal: null, error: '信号不存在', status: 404 };
    // R4-03:**只允许 `review_only`**。原来只拒 `applied`,于是一次 apply 正在发送
    // (`triggered`/`applying`)时 skip 能把「已发出」抹成终态 —— 崩溃后 resume 就不会隔离它了。
    if (sig.status !== EXECUTABLE_PRE_STATUS && sig.status !== 'apply_failed') {
      return { signal: sig, error: `只有 ${EXECUTABLE_PRE_STATUS} / apply_failed 的信号能跳过(这条是 ${sig.status})`, status: 409 };
    }
    // R5-01:未决事实要先人工核对(skip 会把它变成终态,等于把「不知道」永久盖掉)。
    if (sig.needs_reconcile) {
      return { signal: sig, error: '这条上次可能已经发出但结果未知;请先到交易所核对,再点「已核对」(reconcile)才能操作', status: 409 };
    }
    return { signal: this.finish(sig, 'skipped', sig.mode_applied, sig.thread_id, sig.decision?.codes ?? [], note), error: null };
  }
}
