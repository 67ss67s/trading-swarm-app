/**
 * Portfolio Manager(CODE 角色):账户级敞口计算。全部纯函数,零模型。
 *
 * 回答一个问题:「这笔已确定数量的提案成交后,账户的总/净敞口、风险簇集中度、止损预算会变成什么」。
 * 不预测价格、不做 Kelly、不改任何提案的经济字段;超限只拒(gates 里多一道「组合限额」闸)。
 * 设计:docs/design/team-roles-2026-09-06.md §3(Codex 稿的 §3 口径基本照收:
 * gross 不许先净掉再算;挂单/待批 intent 全部预留;止损预算不能被盈利仓抵销)。
 *
 * 数字口径:这里用 number 算(demo 账户是纸面/模拟盘,金额在 1e4 量级,double 够用);
 * 真钱路径(execd)会用十进制字符串,这个模块不进那条路。
 */
import { createHash } from 'node:crypto';
import type { Market, AccountView, DemoIntent, MarketView, StrategyThread } from './types.js';
import type { SymbolRules } from './gates.js';
import { capacityDecimal as dec, type CapacityDecimal } from './capacity-decimal.js';
import type { DemoPortfolioCapacity, DemoSymbolCapacity } from '@trading-swarm/contracts';

export type PortfolioCapacity = DemoPortfolioCapacity;

export interface CapacityConfig {
  default_stop_distance_pct: string;
  max_margin_ratio: number;
  max_rules_age_ms: number;
  max_market_age_ms: number;
}

export const DEFAULT_CAPACITY_CONFIG: CapacityConfig = {
  default_stop_distance_pct: '1.5', max_margin_ratio: 0.5,
  max_rules_age_ms: 10 * 60_000, max_market_age_ms: 3 * 60_000,
};

export interface CapacityRules extends SymbolRules {
  source: 'exchange' | 'paper';
  observed_at: number;
  trading: boolean;
}

export interface CapacityInputs {
  snapshot: PortfolioSnapshot;
  rules: ReadonlyMap<string, CapacityRules>;
  markets: ReadonlyMap<string, MarketView>;
  /** 当前周期 ATR 换算的百分数；过期的 ATR 不传，回到明确的默认情景。 */
  typical_stops?: ReadonlyMap<string, string>;
  watchlist: readonly string[];
  watch_only?: readonly string[];
  threads: readonly StrategyThread[];
  risk_pct: string;
  leverage: number;
  max_open_threads: number;
  config?: Partial<CapacityConfig>;
}

/**
 * 典型止损情景的容量账本(纯代码、只读缓存)。每币 verdict 只回答最小规模风险。
 * margin_slots 是已知可交易币中，按每笔完整风险预算可容纳的保证金槽位，并给出选币见证。
 * 它不是可执行线程数：真实 stop、组合止损/敞口闸与渠道保护能力仍由执行前检查裁决。
 */
export function evaluateCapacity(inp: Readonly<CapacityInputs>): PortfolioCapacity {
  const cfg = { ...DEFAULT_CAPACITY_CONFIG, ...inp.config };
  const zero = dec(0);
  const positive = (value: string | number): CapacityDecimal => {
    const d = dec(value);
    if (d.cmp(zero) <= 0) throw new Error('容量参数必须为正');
    return d;
  };
  const riskRatio = positive(inp.risk_pct).div(dec(100));
  const leverage = positive(inp.leverage);
  positive(cfg.default_stop_distance_pct);
  if (!(cfg.max_margin_ratio > 0 && cfg.max_margin_ratio <= 1)
    || !Number.isSafeInteger(inp.max_open_threads) || inp.max_open_threads < 0
    || !Number.isFinite(cfg.max_rules_age_ms) || cfg.max_rules_age_ms < 0
    || !Number.isFinite(cfg.max_market_age_ms) || cfg.max_market_age_ms < 0) throw new Error('容量配置无效');
  const snap = inp.snapshot;
  const safeAmount = (n: number): CapacityDecimal | null => Number.isFinite(n) && n >= 0 ? dec(n) : null;
  const equity = safeAmount(snap.equity);
  const available = safeAmount(snap.available);
  const budget = equity?.mul(riskRatio) ?? null;
  const active = inp.threads.filter((t) => t.status === 'pending_entry' || t.status === 'in_position');
  const occupied = new Set([...active.map((t) => t.symbol), ...snap.legs.map((l) => l.symbol)]);
  // 外部持仓/挂单也占槽；与本地线程同 symbol/side 的腿不重复加槽。
  const tracked = new Set(active.map((t) => `${t.market ?? 'perp'}:${t.symbol}:${t.side}`));
  const external = new Set(snap.legs.map((l) => `${l.market ?? 'perp'}:${l.symbol}:${l.side}`).filter((key) => !tracked.has(key)));
  const used = active.length + external.size;
  const free = Math.max(0, inp.max_open_threads - used);
  const marginBySymbol = new Map<string, CapacityDecimal>();
  const bySymbol: DemoSymbolCapacity[] = [...new Set(inp.watchlist)].map((symbol) => {
    const row: DemoSymbolCapacity = {
      symbol, verdict: 'rules_unknown', watch_only: inp.watch_only?.includes(symbol) ?? false, occupied: occupied.has(symbol),
      price: null, rules_source: null, rules_observed_at: null, stop_distance_pct: null, stop_source: null,
      min_qty: null, min_viable_notional: null, min_size_risk: null, required_equity: null,
      equity_shortfall: null, margin_per_thread: null, risk_budget: budget?.text() ?? null, budget_margin_per_thread: null,
    };
    const rules = inp.rules.get(symbol);
    if (!rules) return row;
    row.rules_source = rules.source;
    row.rules_observed_at = Number.isSafeInteger(rules.observed_at) && rules.observed_at >= 0 ? rules.observed_at : null;
    let step: CapacityDecimal, minQty: CapacityDecimal, minNotional: CapacityDecimal;
    try {
      if (row.rules_observed_at === null || rules.observed_at > snap.observed_at || snap.observed_at - rules.observed_at > cfg.max_rules_age_ms) return row;
      step = positive(rules.step_size);
      minQty = positive(rules.min_qty);
      minNotional = positive(rules.min_notional);
      positive(rules.tick_size);
    } catch { return row; }
    row.verdict = 'unavailable';
    const market = inp.markets.get(symbol);
    if (!rules.trading || !market || market.symbol !== symbol || !Number.isSafeInteger(market.as_of)
      || market.as_of > snap.observed_at || snap.observed_at - market.as_of > cfg.max_market_age_ms) return row;
    let price: CapacityDecimal;
    try { price = positive(market.mark); } catch { return row; }
    let stop = positive(cfg.default_stop_distance_pct);
    row.stop_source = 'default';
    const typical = inp.typical_stops?.get(symbol);
    if (typical !== undefined) {
      try { stop = positive(typical); row.stop_source = 'atr'; } catch { /* 默认情景明确标注。 */ }
    }
    const distance = stop.div(dec(100));
    const qty = minQty.max(minNotional.div(price)).ceilTo(step);
    const notional = qty.mul(price);
    const risk = notional.mul(distance);
    const required = risk.div(riskRatio);
    row.price = price.text();
    row.stop_distance_pct = stop.text();
    row.min_qty = qty.text();
    row.min_viable_notional = notional.text();
    row.min_size_risk = risk.text();
    row.required_equity = required.text(2);
    row.equity_shortfall = equity ? required.sub(equity).max(zero).text(2) : null;
    row.margin_per_thread = notional.div(market.market === 'spot' ? dec(1) : leverage).text();
    if (budget) {
      // 满风险预算的连续数量情景；至少覆盖最小规模，不能用最小保证金冒充正常 sizing 占用。
      const margin = budget.div(distance).max(notional).div(market.market === 'spot' ? dec(1) : leverage);
      row.budget_margin_per_thread = margin.text();
      marginBySymbol.set(symbol, margin);
    }
    if (snap.quality === 'ok' && equity && budget && equity.cmp(zero) > 0) row.verdict = risk.cmp(budget) <= 0 ? 'ok' : 'needs_equity';
    return row;
  });

  const limit = equity?.mul(dec(cfg.max_margin_ratio)) ?? null;
  // available 已扣的持仓/交易所挂单不再扣一遍；本地未出现在挂单里的 intent 另预留。
  const reserved = snap.legs.filter((l) => l.source === 'intent').reduce((sum, l) => sum.add(dec(l.notional).div(l.market === 'spot' ? dec(1) : leverage)), zero);
  const exchangeMargin = snap.legs.filter((l) => l.source !== 'intent').reduce((sum, l) => sum.add(dec(l.notional).div(l.market === 'spot' ? dec(1) : leverage)), zero);
  const committed = equity && available ? equity.sub(available).max(zero).max(exchangeMargin) : null;
  const policyFree = limit && committed ? limit.sub(committed).sub(reserved).max(zero) : null;
  const balanceFree = available ? available.sub(reserved).max(zero) : null;
  const marginFree = policyFree && balanceFree ? policyFree.min(balanceFree) : null;
  const candidates = bySymbol.filter((s) => s.verdict === 'ok' && !s.watch_only && !s.occupied)
    .sort((a, b) => marginBySymbol.get(a.symbol)!.cmp(marginBySymbol.get(b.symbol)!) || a.symbol.localeCompare(b.symbol));
  let spent = zero;
  const witness: string[] = [];
  for (const s of candidates.slice(0, free)) {
    const next = spent.add(marginBySymbol.get(s.symbol)!);
    if (!marginFree || next.cmp(marginFree) > 0) break;
    spent = next;
    witness.push(s.symbol);
  }
  const requiredMargin = candidates.length >= free
    ? candidates.slice(0, free).reduce((sum, s) => sum.add(marginBySymbol.get(s.symbol)!), zero) : null;
  const usable = snap.quality === 'ok' && equity !== null && equity.cmp(zero) > 0 && marginFree !== null;
  const relevant = bySymbol.filter((s) => !s.watch_only && !s.occupied);
  const binding: PortfolioCapacity['binding_constraint'] = !usable ? 'snapshot_unavailable'
    : free === 0 || witness.length === free ? 'thread_slots'
      : witness.length < Math.min(free, candidates.length) ? (balanceFree!.cmp(policyFree!) < 0 ? 'available_margin' : 'margin_budget')
        : relevant.some((s) => s.verdict === 'rules_unknown') ? 'rules_unknown'
          : relevant.some((s) => s.verdict === 'unavailable') ? 'market_unavailable'
            : relevant.some((s) => s.verdict === 'needs_equity') ? 'min_size_risk' : 'watchlist';
  return {
    schema_version: 1, snapshot_id: snap.snapshot_id, computed_at: snap.observed_at, basis: 'typical_stop_estimate', snapshot_quality: snap.quality,
    equity: equity?.text() ?? null, available: available?.text() ?? null, risk_pct: dec(inp.risk_pct).text(), leverage: inp.leverage,
    default_stop_distance_pct: dec(cfg.default_stop_distance_pct).text(), slots_total: inp.max_open_threads, slots_used: used, slots_free: free,
    margin_budget: { max_margin_ratio: cfg.max_margin_ratio, limit_usdt: limit?.text() ?? null, committed_usdt: committed?.text() ?? null,
      reserved_usdt: reserved.text(), free_usdt: marginFree?.text() ?? null, required_for_free_slots_usdt: usable ? requiredMargin?.text() ?? null : null,
      slots_supported: usable ? witness.length : null, witness_symbols: usable ? witness : [] },
    binding_constraint: binding, by_symbol: bySymbol,
  };
}

export type Cluster = 'crypto_major' | 'crypto_beta' | 'equity_linked' | 'metal' | 'unknown';

/** 风险簇:人工版本化配置,不是相关矩阵。未知币进 unknown 并阻断新增同类风险。 */
export const CLUSTER_MAP_VERSION = 1;
const MAJORS = new Set(['BTCUSDT', 'ETHUSDT']);
const EQUITY_LINKED = /^(TSLA|NVDA|AAPL|MSFT|AMZN|GOOGL?|META|COIN|MSTR|HOOD|CRCL|SPCX|SNDK|MU|SKHYNIX|CXMT|CL)USDT$/;
const METALS = /^(XAU|XAG|PAXG)USDT$/;
const CRYPTO = /^[A-Z0-9]{2,12}USDT$/;

export function clusterFor(symbol: string): Cluster {
  const s = symbol.toUpperCase();
  if (MAJORS.has(s)) return 'crypto_major';
  if (EQUITY_LINKED.test(s)) return 'equity_linked';
  if (METALS.test(s)) return 'metal';
  if (CRYPTO.test(s)) return 'crypto_beta';
  return 'unknown';
}

export interface PortfolioPolicy {
  version: number;
  /** projected gross / equity 上限 */
  max_quote_volume_pct: number; // 单笔名义 / 24h quote volume 百分数
  max_gross_ratio: number;
  /** projected |net| / equity 上限(最坏区间) */
  max_net_ratio: number;
  /** 任一风险簇 gross / equity 上限 */
  max_cluster_ratio: number;
  /** 所有持仓按止损价算的聚合亏损 / equity 上限 */
  max_stop_budget_ratio: number;
  /** 账户/行情组件最老允许多少毫秒(新开仓) */
  max_component_age_ms: number;
}

/** v1 纸面政策(预注册,不是从本周 PnL 拟合出来的)。 */
export const DEFAULT_PORTFOLIO_POLICY: PortfolioPolicy = {
  version: 1,
  max_quote_volume_pct: 0.5,
  max_gross_ratio: 3.0,
  max_net_ratio: 2.0,
  max_cluster_ratio: 2.0,
  max_stop_budget_ratio: 0.015,
  max_component_age_ms: 30_000,
};

export function parsePolicy(raw: string | null | undefined): PortfolioPolicy {
  if (!raw) return DEFAULT_PORTFOLIO_POLICY;
  try {
    const p = JSON.parse(raw) as Partial<PortfolioPolicy>;
    const num = (v: unknown, d: number, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : d);
    return {
      version: Number.isInteger(p.version) ? (p.version as number) : DEFAULT_PORTFOLIO_POLICY.version,
      max_quote_volume_pct: num(p.max_quote_volume_pct, DEFAULT_PORTFOLIO_POLICY.max_quote_volume_pct, 0.000001, 100),
      max_gross_ratio: num(p.max_gross_ratio, DEFAULT_PORTFOLIO_POLICY.max_gross_ratio, 0.1, 20),
      max_net_ratio: num(p.max_net_ratio, DEFAULT_PORTFOLIO_POLICY.max_net_ratio, 0.1, 20),
      max_cluster_ratio: num(p.max_cluster_ratio, DEFAULT_PORTFOLIO_POLICY.max_cluster_ratio, 0.1, 20),
      max_stop_budget_ratio: num(p.max_stop_budget_ratio, DEFAULT_PORTFOLIO_POLICY.max_stop_budget_ratio, 0.001, 0.5),
      max_component_age_ms: num(p.max_component_age_ms, DEFAULT_PORTFOLIO_POLICY.max_component_age_ms, 1_000, 3_600_000),
    };
  } catch {
    return DEFAULT_PORTFOLIO_POLICY;
  }
}

/** 只允许**收紧**:每个上限只能小于等于当前值(风控代码可以否决/收紧,不能放宽——放宽要人在界面确认)。 */
export function tightenOnly(cur: PortfolioPolicy, next: PortfolioPolicy): string[] {
  const errs: string[] = [];
  if (next.max_quote_volume_pct > cur.max_quote_volume_pct) errs.push('max_quote_volume_pct 只能收紧');
  if (next.max_gross_ratio > cur.max_gross_ratio) errs.push('max_gross_ratio 只能收紧');
  if (next.max_net_ratio > cur.max_net_ratio) errs.push('max_net_ratio 只能收紧');
  if (next.max_cluster_ratio > cur.max_cluster_ratio) errs.push('max_cluster_ratio 只能收紧');
  if (next.max_stop_budget_ratio > cur.max_stop_budget_ratio) errs.push('max_stop_budget_ratio 只能收紧');
  if (next.max_component_age_ms > cur.max_component_age_ms) errs.push('max_component_age_ms 只能收紧');
  return errs;
}

export interface ExposureLeg {
  market?: Market;
  symbol: string;
  cluster: Cluster;
  side: 'long' | 'short';
  qty: number;
  mark: number;
  notional: number;
  /** 持仓 | 活挂单余量 | 本地待批/进行中 intent | 本次候选 */
  source: 'position' | 'open_order' | 'intent' | 'candidate';
  ref: string;
  /** 有可验证止损价时,按止损算的最大亏损(USDT,≥0);没有 → null */
  stop_loss_usdt: number | null;
}

export interface GroupExposure {
  gross: number;
  long: number;
  short: number;
  net: number;
  gross_ratio: number;
}

export type SnapshotQuality = 'ok' | 'stale' | 'inconsistent' | 'incomplete';

export interface PortfolioSnapshot {
  snapshot_id: string;
  observed_at: number;
  /** 账户 as_of、各 symbol 行情 as_of 里最老的那个 */
  oldest_component_at: number;
  quality: SnapshotQuality;
  quality_note: string | null;
  equity: number;
  available: number;
  /** 只算持仓(不含预留) */
  positions: GroupExposure;
  /** 持仓 + 全部预留(挂单/intent) */
  projected: GroupExposure;
  /** 最坏净额区间:[net − 全部可增空, net + 全部可增多] / equity */
  worst_net_ratio: { low: number; high: number };
  by_symbol: Record<string, GroupExposure>;
  by_cluster: Record<string, GroupExposure>;
  /** 持仓按止损价的聚合亏损预算(USDT)与占权益比;缺保护的名义单列 */
  stop_budget_usdt: number;
  stop_budget_ratio: number;
  unprotected_notional: number;
  unprotected_symbols: string[];
  /** 无止损现货的名义(不进止损预算、不告警;只受组合总仓位/簇限额约束) */
  spot_no_stop_notional: number;
  legs: ExposureLeg[];
  cluster_map_version: number;
  /** 经济内容指纹(不含时间):变了才落库 */
  economic_fingerprint: string;
}

export interface SnapshotInputs {
  account: AccountView;
  markets: Map<string, MarketView>;
  /** 开着的线程(pending_entry / in_position):提供止损价与归属 */
  threads: StrategyThread[];
  /** 本地未终态的 intent(pending_approval / approved / submitted / unknown):预留 */
  intents: DemoIntent[];
  now: number;
  policy?: PortfolioPolicy;
  /** 账户组件允许的最大年龄(毫秒);缺省用 policy.max_component_age_ms。agent_mcp 这类带缓存的通道传更大的值。 */
  account_max_age_ms?: number;
}

const num = (s: string | null | undefined): number => {
  const v = Number(s);
  return Number.isFinite(v) ? v : 0;
};

function emptyGroup(): GroupExposure {
  return { gross: 0, long: 0, short: 0, net: 0, gross_ratio: 0 };
}
function addLeg(g: GroupExposure, leg: ExposureLeg): void {
  g.gross += leg.notional;
  if (leg.side === 'long') g.long += leg.notional;
  else g.short += leg.notional;
  g.net = g.long - g.short;
}
function finish(g: GroupExposure, equity: number): GroupExposure {
  return { ...g, gross_ratio: equity > 0 ? g.gross / equity : Infinity };
}

const RESERVED_INTENT: ReadonlySet<string> = new Set(['pending_approval', 'approved', 'submitted', 'unknown']);

/** 一条腿的止损亏损(USDT,≥0):止损在错误一侧 → 当作没有保护(null)。 */
export function stopLossUsdt(side: 'long' | 'short', qty: number, mark: number, stop: number | null): number | null {
  if (stop === null || !(stop > 0) || !(qty > 0)) return null;
  const loss = side === 'long' ? (mark - stop) * qty : (stop - mark) * qty;
  return loss >= 0 ? loss : null;
}

/**
 * 把账户事实压成一张不可变快照。质量口径:
 *   incomplete = 权益 ≤ 0 或有持仓/挂单的币缺行情;
 *   stale      = 最老组件比 now 旧超过 policy.max_component_age_ms;
 *   inconsistent = 组件之间时间跨度 > 15s;
 *   ok         = 其余。
 * 质量不是 ok 时快照照样算出来给人看,但不能用于放行新开仓。
 */
export function computeSnapshot(inp: SnapshotInputs): PortfolioSnapshot {
  const policy = inp.policy ?? DEFAULT_PORTFOLIO_POLICY;
  const equity = num(inp.account.equity);
  const legs: ExposureLeg[] = [];
  const notes: string[] = [];
  const times: number[] = [inp.account.as_of];
  const stopByThread = new Map<string, { stop: number | null; cid: string | null; id: string }>();
  for (const t of inp.threads) {
    if (t.status !== 'in_position' && t.status !== 'pending_entry') continue;
    stopByThread.set(`${t.market ?? 'perp'}:${t.symbol}:${t.side}`, { stop: t.stop_price ? num(t.stop_price) : null, cid: t.entry_client_order_id, id: t.id });
  }

  // 持仓
  for (const p of inp.account.positions) {
    const qty = Math.abs(num(p.qty));
    if (!(qty > 0)) continue;
    const m = inp.markets.get(p.market === 'spot' ? `spot:${p.symbol}` : p.symbol);
    const mark = m ? num(m.mark) : num(p.mark_price);
    if (m) times.push(m.as_of);
    else notes.push(`${p.symbol} 无行情,用持仓自带标记价`);
    const th = stopByThread.get(`${p.market ?? 'perp'}:${p.symbol}:${p.side}`);
    // 09-07:没有线程的仓(手动单、被撤单竞态孤立的仓)只要交易所上挂着反向的止损条件单,也算有保护——
    // 之前只认线程止损,带止损的外部仓一律报「缺止损保护」并挡新开仓。
    const exchangeStop = th?.stop != null ? null : inp.account.open_orders.find((o) => o.symbol === p.symbol && (o.market ?? 'perp') === (p.market ?? 'perp') && o.stop_price && /STOP/i.test(o.type) && !/TAKE_PROFIT/i.test(o.type) && (p.side === 'long' ? /sell/i.test(o.side) : /buy/i.test(o.side)));
    const stop = th?.stop ?? (exchangeStop ? num(exchangeStop.stop_price) : null);
    legs.push({ market: p.market ?? 'perp', symbol: p.symbol, cluster: clusterFor(p.symbol), side: p.side, qty, mark, notional: qty * mark, source: 'position', ref: `position:${p.symbol}`, stop_loss_usdt: stopLossUsdt(p.side, qty, mark, stop) });
  }
  // 活挂单(非 reduce-only 的都是可增风险;reduce-only 不算已降险,也不算增险)
  const seenCids = new Set<string>();
  for (const o of inp.account.open_orders) {
    if (o.reduce_only) continue;
    const qty = Math.abs(num(o.qty));
    if (!(qty > 0)) continue;
    seenCids.add(o.client_order_id);
    const m = inp.markets.get(o.market === 'spot' ? `spot:${o.symbol}` : o.symbol);
    const ref = o.price ? num(o.price) : m ? num(m.mark) : 0;
    if (!(ref > 0)) {
      notes.push(`${o.symbol} 挂单 ${o.client_order_id} 无法定价`);
      continue;
    }
    if (m) times.push(m.as_of);
    const side: 'long' | 'short' = /buy/i.test(o.side) ? 'long' : 'short';
    // OpenOrderView 没有 executed_qty:拿不到余量就按原量保守预留。
    legs.push({ market: o.market ?? 'perp', symbol: o.symbol, cluster: clusterFor(o.symbol), side, qty, mark: ref, notional: qty * ref, source: 'open_order', ref: `order:${o.client_order_id}`, stop_loss_usdt: null });
  }
  // 本地未终态 intent(去重:已经以挂单出现的不重复预留)
  for (const it of inp.intents) {
    if (it.kind !== 'open' || !RESERVED_INTENT.has(it.status)) continue;
    if (it.client_order_id && seenCids.has(it.client_order_id)) continue;
    // 线程已经关闭/取消的 intent 不再是预留(2026-09-06:HYPE 补偿平仓后 intent 停在 submitted,占了 30 U 和一个槽)。
    if (it.thread_id && !inp.threads.some((t) => t.id === it.thread_id)) continue;
    const qty = Math.abs(num(it.quantity));
    const m = inp.markets.get(it.market === 'spot' ? `spot:${it.symbol}` : it.symbol);
    const ref = it.limit_price ? num(it.limit_price) : m ? num(m.mark) : 0;
    if (!(qty > 0) || !(ref > 0)) continue;
    legs.push({ market: it.market ?? 'perp', symbol: it.symbol, cluster: clusterFor(it.symbol), side: it.direction, qty, mark: ref, notional: qty * ref, source: 'intent', ref: `intent:${it.id}`, stop_loss_usdt: null });
  }

  const positions = emptyGroup();
  const projected = emptyGroup();
  const bySymbol = new Map<string, GroupExposure>();
  const byCluster = new Map<string, GroupExposure>();
  let stopBudget = 0;
  let unprotected = 0;
  let spotNoStop = 0;
  const unprotectedSymbols = new Set<string>();
  let addLong = 0;
  let addShort = 0;
  for (const leg of legs) {
    addLeg(projected, leg);
    const s = bySymbol.get(leg.symbol) ?? emptyGroup();
    addLeg(s, leg);
    bySymbol.set(leg.symbol, s);
    const c = byCluster.get(leg.cluster) ?? emptyGroup();
    addLeg(c, leg);
    byCluster.set(leg.cluster, c);
    if (leg.source === 'position') {
      addLeg(positions, leg);
      if (leg.stop_loss_usdt === null) {
        // 2026-09-21:无止损现货不进止损预算(之前按全额本金计入,demo 自带的 BTC/ETH/OKB 就把 1.5% 撑爆)。
        // 它的敞口仍由 gross / cluster 限额管着;这里单列名义,界面看得见但不告警。
        if (leg.market === 'spot') { spotNoStop += leg.notional; continue; }
        unprotected += leg.notional;
        unprotectedSymbols.add(leg.symbol);
      } else stopBudget += leg.stop_loss_usdt;
    } else if (leg.side === 'long') addLong += leg.notional;
    else addShort += leg.notional;
  }

  // 账户与行情分开判老:行情按政策(3 分钟内由 MARKET_STALE 另管,这里只看账户),账户按通道给的允许年龄。
  const marketTimes = times.slice(1);
  // 没有持仓/挂单就没有行情组件可老:别拿账户时间冒充行情时间(那会把带缓存通道的账户读判成行情过期)。
  const oldestMarket = marketTimes.length ? Math.min(...marketTimes) : inp.now;
  const oldest = Math.min(inp.account.as_of, oldestMarket);
  const accountMaxAge = Math.max(policy.max_component_age_ms, inp.account_max_age_ms ?? 0);
  let quality: SnapshotQuality = 'ok';
  if (!(equity > 0)) {
    quality = 'incomplete';
    notes.unshift('权益 ≤ 0 或缺失');
  } else if (notes.length) quality = 'incomplete';
  else if (inp.now - inp.account.as_of > accountMaxAge || inp.now - oldestMarket > policy.max_component_age_ms * 6) quality = 'stale';
  // 组件时间跨度:带缓存的通道账户天然比行情老,跨度阈值放到允许年龄那么大。
  else if (Math.max(...times) - oldest > (inp.account_max_age_ms ? Math.max(15_000, inp.account_max_age_ms) : 15_000)) quality = 'inconsistent';

  const fpBody = legs
    .map((l) => `${l.source}|${l.symbol}|${l.side}|${l.qty.toFixed(8)}|${l.notional.toFixed(2)}`)
    .sort()
    .join('\n') + `\n${equity.toFixed(2)}|${quality}`;
  const fingerprint = createHash('sha256').update(fpBody).digest('hex').slice(0, 16);

  return {
    snapshot_id: `pf-${inp.now.toString(36)}-${fingerprint.slice(0, 6)}`,
    observed_at: inp.now,
    oldest_component_at: oldest,
    quality,
    quality_note: notes.length ? notes.join(';') : null,
    equity,
    available: num(inp.account.available),
    positions: finish(positions, equity),
    projected: finish(projected, equity),
    worst_net_ratio: equity > 0 ? { low: (positions.net - addShort) / equity, high: (positions.net + addLong) / equity } : { low: -Infinity, high: Infinity },
    by_symbol: Object.fromEntries([...bySymbol].map(([k, v]) => [k, finish(v, equity)])),
    by_cluster: Object.fromEntries([...byCluster].map(([k, v]) => [k, finish(v, equity)])),
    stop_budget_usdt: stopBudget,
    stop_budget_ratio: equity > 0 ? stopBudget / equity : Infinity,
    unprotected_notional: unprotected,
    unprotected_symbols: [...unprotectedSymbols],
    spot_no_stop_notional: spotNoStop,
    legs,
    cluster_map_version: CLUSTER_MAP_VERSION,
    economic_fingerprint: fingerprint,
  };
}

export interface Candidate {
  market?: Market;
  symbol: string;
  side: 'long' | 'short';
  qty: number;
  /** 成交参考价(市价 = mark;限价 = 限价与 mark 里对自己更不利的那个) */
  price: number;
  stop: number | null;
}

export type PortfolioVerdict = 'pass' | 'warn' | 'block' | 'unavailable';

export interface PortfolioImpact {
  snapshot_id: string;
  policy_version: number;
  verdict: PortfolioVerdict;
  reasons: string[];
  before: { gross_ratio: number; net_ratio: number; cluster: string; cluster_ratio: number; stop_budget_ratio: number };
  after: { gross_ratio: number; worst_net_ratio: number; cluster_ratio: number; stop_budget_ratio: number };
  headroom: { gross: number; cluster: number; stop_budget: number };
  computed_at: number;
}

/** 候选成交后的组合影响 + 按政策裁决。超限只 block,不改候选。 */
export function evaluateImpact(snap: PortfolioSnapshot, cand: Candidate, policy: PortfolioPolicy = DEFAULT_PORTFOLIO_POLICY, now = snap.observed_at): PortfolioImpact {
  const eq = snap.equity;
  const cluster = clusterFor(cand.symbol);
  const notional = cand.qty * cand.price;
  const reasons: string[] = [];
  const before = {
    gross_ratio: snap.projected.gross_ratio,
    net_ratio: eq > 0 ? snap.projected.net / eq : Infinity,
    cluster,
    cluster_ratio: snap.by_cluster[cluster]?.gross_ratio ?? 0,
    stop_budget_ratio: snap.stop_budget_ratio,
  };
  if (snap.quality !== 'ok' || !(eq > 0)) {
    return {
      snapshot_id: snap.snapshot_id,
      policy_version: policy.version,
      verdict: 'unavailable',
      reasons: [`账户快照质量 ${snap.quality}${snap.quality_note ? `(${snap.quality_note})` : ''},不能据此放行新开仓`],
      before,
      after: { gross_ratio: before.gross_ratio, worst_net_ratio: before.net_ratio, cluster_ratio: before.cluster_ratio, stop_budget_ratio: before.stop_budget_ratio },
      headroom: { gross: 0, cluster: 0, stop_budget: 0 },
      computed_at: now,
    };
  }
  const grossAfter = (snap.projected.gross + notional) / eq;
  const worstNet = cand.side === 'long' ? snap.worst_net_ratio.high + notional / eq : snap.worst_net_ratio.low - notional / eq;
  const clusterAfter = ((snap.by_cluster[cluster]?.gross ?? 0) + notional) / eq;
  const candStop = cand.market === 'spot' && cand.stop === null ? notional : stopLossUsdt(cand.side, cand.qty, cand.price, cand.stop);
  const stopAfter = (snap.stop_budget_usdt + (candStop ?? 0)) / eq;
  if (cluster === 'unknown') reasons.push(`${cand.symbol} 不在风险簇表里(unknown),不新增未知簇风险`);
  if (grossAfter > policy.max_gross_ratio) reasons.push(`成交后总敞口 ${grossAfter.toFixed(2)}× 权益 > 上限 ${policy.max_gross_ratio}×`);
  if (Math.abs(worstNet) > policy.max_net_ratio) reasons.push(`最坏净敞口 ${worstNet.toFixed(2)}× 权益 > 上限 ${policy.max_net_ratio}×`);
  if (clusterAfter > policy.max_cluster_ratio) reasons.push(`风险簇 ${cluster} 敞口 ${clusterAfter.toFixed(2)}× 权益 > 上限 ${policy.max_cluster_ratio}×`);
  if (candStop === null) reasons.push('候选没有可验证的止损(缺失或在错误一侧),不能进入止损预算');
  else if (stopAfter > policy.max_stop_budget_ratio) reasons.push(`聚合止损预算 ${(stopAfter * 100).toFixed(2)}% 权益 > 上限 ${(policy.max_stop_budget_ratio * 100).toFixed(2)}%`);
  if (snap.unprotected_notional > 0) reasons.push(`已有 ${snap.unprotected_symbols.join('/')} 缺止损保护(名义 ${snap.unprotected_notional.toFixed(0)} USDT),先补保护再加风险`);
  const verdict: PortfolioVerdict = reasons.length ? 'block' : grossAfter > policy.max_gross_ratio * 0.8 || clusterAfter > policy.max_cluster_ratio * 0.8 ? 'warn' : 'pass';
  if (verdict === 'warn') reasons.push('接近上限(> 80%)');
  return {
    snapshot_id: snap.snapshot_id,
    policy_version: policy.version,
    verdict,
    reasons,
    before,
    after: { gross_ratio: grossAfter, worst_net_ratio: worstNet, cluster_ratio: clusterAfter, stop_budget_ratio: stopAfter },
    headroom: { gross: Math.max(0, policy.max_gross_ratio - grossAfter), cluster: Math.max(0, policy.max_cluster_ratio - clusterAfter), stop_budget: Math.max(0, policy.max_stop_budget_ratio - stopAfter) },
    computed_at: now,
  };
}
