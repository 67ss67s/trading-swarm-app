// Execution backends (docs/demo/README.md §5.8). `paper` is an in-process simulator; `demo` talks
// to the Rust `tgate-demo-exec` child over NDJSON — that process is the only one holding the
// Binance demo key (AGENTS.md rule 1 still holds in the demo).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Market, SpotHolding, AccountView, Backend, Direction, NetCheckResult, OpenOrderView, PositionView, SymbolInfo, TransportHealth } from './types.js';
import { fetchExchangeInfo } from './market.js';
import type { SymbolRules } from './gates.js';
import { compareStopPrices } from './threads.js';

export type OrderOutcome = 'filled' | 'submitted' | 'unknown' | 'failed';

export interface OrderReceipt {
  outcome: OrderOutcome;
  receipt: unknown;
  avg_price: string | null;
  error: string | null;
}

/** 移损只认精确归属、仍活动的市价止损；null 表示不能证明，不能据此重发。 */
export interface StopProtection {
  client_order_id: string; algo_id: string | null; symbol: string; market: Market;
  side: Direction; stop_price: string; qty: string; close_position: boolean;
  take_profit_price: string | null;
}
export interface StopMoveRequest {
  symbol: string; market: Market; side: Direction; qty: string; old_stop: string;
  target_stop: string; new_cid: string; old_cid: string; old_algo_id: string | null;
}

export interface EntryRequest {
  market?: Market;
  symbol: string;
  direction: Direction;
  qty: string;
  entry: 'market' | 'limit';
  limit_price: string | null;
  client_order_id: string;
}

/** 固定经济字段与三个 CID 均由 runtime 在提交前持久化。 */
export interface OpenWithProtectionRequest extends EntryRequest {
  entry: 'market';
  stop_price: string;
  stop_client_algo_id: string;
  take_profit?: { trigger_price: string; client_algo_id: string };
}

export interface AlgoLegReceipt {
  outcome: OrderOutcome | 'skipped';
  algo_id: string | null;
  error: string | null;
}

export interface OpenWithProtectionReceipt {
  entry: OrderReceipt & { executed_qty: string | null; order_id: string | null };
  stop: AlgoLegReceipt;
  tp: AlgoLegReceipt;
}

/** 通道能否可靠挂原生保护腿(closePosition STOP_MARKET)。unverified = 没在真实账户上验证过,新增开仓一律拒。 */
export type ProtectionCapability = 'verified' | 'unverified';

/** 09-08:结算用的一条交易所成交(accountTradeList 原样,数值不由模型汇总)。 */
export interface SettlementTrade {
  time: number;
  side: 'BUY' | 'SELL' | string;
  price: string;
  qty: string;
  realized_pnl: string;
  commission: string;
  position_side?: string | null;
}

export interface SettlementView {
  trades: SettlementTrade[];
  /** 窗口内的资金费流水合计(负数 = 支出);拿不到时 null。 */
  funding: string | null;
  note?: string;
}

export interface ExecBackend {
  marketsSupported(): Market[];
  spotHoldings?(): Promise<SpotHolding[]>;
  costControl?(): { read_mode: string; model_runs: number; direct_calls: number; cache_hits: number; model_budget: { blocked: boolean; blocked_at: number | null; reason: string | null } };
  resetModelBudget?(): void;
  readonly kind: Backend;
  /** 缺省视为 verified(paper / Rust 后端自己下 STOP_MARKET);agent_mcp 覆写。 */
  protectionCapability?(market?: Market): ProtectionCapability;
  /** 09-07:最近 30 分钟的传输健康(连接被掐/超时/无响应);不实现 = 不统计。 */
  transportHealth?(): TransportHealth;
  /** 09-07:网络自检,连续 n 次只读调用;不实现 = 该后端没有网络问题可测(纸面)。 */
  netCheck?(n: number): Promise<NetCheckResult>;
  start(): Promise<void>;
  stop(): Promise<void>;
  account(): Promise<AccountView>;
  symbolRules(symbol: string, market?: Market): Promise<SymbolRules>;
  markPrice(symbol: string, market?: Market): Promise<string>;
  placeEntry(req: EntryRequest): Promise<OrderReceipt>;
  /** 一次 CLI 内 MARKET RESULT 成交后立即挂 stop,随后可选 TP。 */
  openWithProtection?(req: OpenWithProtectionRequest): Promise<OpenWithProtectionReceipt>;
  /** v3.11 自验证用:这张条件单(按 clientAlgoId)现在挂着吗?null = 查不到/不确定(不是否定事实)。 */
  algoOrderExists?(symbol: string, client_algo_id: string, market?: Market): Promise<boolean | null>;
  /** v3.11 自验证用:撤一张条件单。 */
  cancelAlgoOrder?(symbol: string, client_algo_id: string, market?: Market): Promise<{ ok: boolean; error: string | null }>;
  /** 自验证用:这个币上现在挂着的所有条件单(clientAlgoId)。null = 查不到/不确定。 */
  listAlgoOrders?(symbol: string, market?: Market): Promise<{ client_algo_id: string; algo_id: string | null }[] | null>;
  /** STOP_MARKET closePosition=true at stop_price. */
  placeStop(symbol: string, position: Direction, stop_price: string, client_order_id: string, market?: Market): Promise<OrderReceipt>;
  /** 不声明能力的通道 fail closed；replace 只能先挂、确认、再撤，不能自动由 amend 降级。 */
  readonly stopMoveMode?: 'paper' | 'amend' | 'replace';
  getStopProtection?(symbol: string, cid: string, market: Market, algo_id?: string | null): Promise<StopProtection | null>;
  amendStop?(request: StopMoveRequest, authorize?: () => boolean): Promise<OrderReceipt>;
  replacePaperStop?(request: StopMoveRequest): Promise<OrderReceipt>;
  placeTakeProfit(symbol: string, position: Direction, tp_price: string, client_order_id: string, market?: Market): Promise<OrderReceipt>;
  /** 原生指定数量止盈;未实现的通道不得把部分止盈静默替换成全平。 */
  placePartialTakeProfit?(symbol: string, position: Direction, tp_price: string, qty: string, client_order_id: string, market?: Market): Promise<OrderReceipt>;
  /**
   * `ambiguous: true` = 请求可能已经到交易所了(写超时 / OKX 50004),结果**未知**:
   * 调用方要把意图留在 unknown、等新鲜仓位收敛,不能写成 failed。Binance 的实现不带这个字段
   * (undefined),行为不变(codex-review #7)。
   */
  closePosition(symbol: string, client_order_id: string, market?: Market): Promise<{ closed: boolean; receipt: unknown; error: string | null; ambiguous?: boolean }>;
  reducePosition(symbol: string, qty: string, client_order_id: string, market?: Market): Promise<OrderReceipt>;
  cancelAll(symbol: string, market?: Market): Promise<{ ok: boolean; error: string | null }>;
  cancelOrder(symbol: string, client_order_id: string, market?: Market): Promise<{ ok: boolean; error: string | null }>;
  getOrder(symbol: string, client_order_id: string, fresh?: boolean, market?: Market): Promise<OrderStatusView | null>;
  setLeverage(symbol: string, leverage: number): Promise<{ ok: boolean; error: string | null; receipt?: unknown }>;
  setMarginType(symbol: string, mode: 'cross' | 'isolated'): Promise<{ ok: boolean; error: string | null }>;
  symbols(market?: Market): Promise<SymbolInfo[]>;
  /**
   * 09-08:一个币在时间窗内的成交与资金费(平仓后回填真实盈亏/出场价)。
   * 不实现 = 这个后端的回执自带盈亏(纸面);返回 null = 这次没查到,调用方不得当成「没有盈亏」。
   */
  settlement?(symbol: string, startMs: number, endMs: number, fresh?: boolean, market?: Market): Promise<SettlementView | null>;
  /** Paper only: advance the simulator with a fresh mark price. Returns events for anything that triggered. */
  tick(symbol: string, mark: string, market?: Market): PaperEvent[];
  /**
   * 可选:这个通道的账户读天然能有多旧(毫秒)。agent_mcp 每次读是一趟 CLI 并带缓存,账户 as_of 本来就会比
   * 组合政策的 30 秒老得多;Portfolio/Risk 用 max(政策, 这个值) 判 stale,不然会把缓存当成过期。
   */
  accountStalenessMs?(): number;
  /** 09-08:丢掉账户缓存,让下一次 account() 一定去交易所读(疑似缺保护时用新鲜事实复判)。 */
  invalidateAccount?(): void;
}

export interface OrderStatusView {
  status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'EXPIRED' | 'REJECTED' | string;
  avg_price: string | null;
  executed_qty: string;
  raw: unknown;
}

export interface PaperEvent {
  market?: Market;
  kind: 'entry_filled' | 'sl_hit' | 'tp_hit';
  symbol: string;
  client_order_id: string;
  price: string;
  realized_pnl: string | null;
  message: string;
}

// ---------------------------------------------------------------- paper

export interface PaperPosition {
  entry_fee?: number;
  market?: Market;
  symbol: string;
  side: Direction;
  qty: number;
  entry: number;
  leverage: number;
}
export interface PaperOrder extends OpenOrderView {
  symbol: string;
  position_side: Direction; // the position this order belongs to
}

/** Persistence hook for {@link PaperBackend}: the whole simulator state as one JSON blob. */
export interface PaperPersist {
  load(): string | null;
  save(json: string): void;
}

/** Bump whenever the shape below changes incompatibly; older snapshots are discarded on load. */
export const PAPER_SNAPSHOT_VERSION = 1;

/**
 * Everything the paper simulator needs to keep behaving identically after a gateway restart.
 * Maps are serialized as entry arrays. `exchangeSymbols` is deliberately absent: it is a pure
 * network cache re-fetched by symbols() and would bloat every write.
 */
export interface PaperSnapshot {
  version: number;
  /** Realized balance (starting equity +/- realized pnl and fees); unrealized is derived from marks. */
  wallet: number;
  positions: PaperPosition[];
  orders: PaperOrder[];
  /** Terminal order states keyed by client_order_id, oldest first, capped at CLOSED_KEEP. */
  closed: [string, OrderStatusView][];
  marks: [string, string][];
  leverages: [string, number][];
}

/** Cap on how many terminal orders travel in a snapshot (getOrder() only looks up recent ids). */
const CLOSED_KEEP = 500;

const FEE_RATE = 0.0004;
const PAPER_SYMBOLS: SymbolInfo[] = [
  ['BTCUSDT', 1, 3, '0.001', '0.1'],
  ['ETHUSDT', 2, 3, '0.001', '0.01'],
  ['SOLUSDT', 3, 0, '1', '0.001'],
  ['BNBUSDT', 2, 2, '0.01', '0.01'],
  ['XRPUSDT', 4, 1, '0.1', '0.0001'],
  ['DOGEUSDT', 5, 0, '1', '0.00001'],
  ['ADAUSDT', 4, 0, '1', '0.0001'],
  ['AVAXUSDT', 3, 0, '1', '0.001'],
  ['LINKUSDT', 3, 2, '0.01', '0.001'],
  ['SUIUSDT', 4, 1, '0.1', '0.0001'],
  ['TONUSDT', 4, 1, '0.1', '0.0001'],
  ['LTCUSDT', 2, 3, '0.001', '0.01'],
  ['DOTUSDT', 3, 1, '0.1', '0.001'],
  ['ARBUSDT', 4, 1, '0.1', '0.0001'],
  ['OPUSDT', 4, 1, '0.1', '0.0001'],
  ['PEPEUSDT', 7, 0, '1', '0.0000001'],
  ['HYPEUSDT', 3, 2, '0.01', '0.001'],
  ['WLDUSDT', 4, 0, '1', '0.0001'],
  ['NEARUSDT', 3, 0, '1', '0.001'],
  ['APTUSDT', 4, 1, '0.1', '0.0001'],
].map(([symbol, pp, qp, step, tick]) => ({ symbol: symbol as string, status: 'TRADING', price_precision: pp as number, qty_precision: qp as number, step_size: step as string, tick_size: tick as string, min_qty: step as string, min_notional: '5' }));

export class PaperBackend implements ExecBackend {
  readonly kind: Backend = 'paper';
  readonly stopMoveMode = 'paper' as const;
  marketsSupported(): Market[] { return ['perp', 'spot']; }
  private wallet: number;
  private positions = new Map<string, PaperPosition>();
  private orders: PaperOrder[] = [];
  private closed = new Map<string, OrderStatusView>();
  private marks = new Map<string, string>();
  private leverages = new Map<string, number>();

  private readonly liveSymbols: boolean;
  private readonly persist: PaperPersist | null;
  /**
   * `symbols: 'live'` pulls the public exchangeInfo (every USDT perp tradable on paper); 'static'
   * (default, tests) stays offline. `persist` makes the simulator survive a gateway restart: the
   * snapshot is read once here and rewritten after every state-changing call.
   */
  constructor(startingEquity = 10_000, opts: { symbols?: 'static' | 'live'; persist?: PaperPersist } = {}) {
    this.wallet = startingEquity;
    this.liveSymbols = opts.symbols === 'live';
    this.persist = opts.persist ?? null;
    this.restore();
  }

  /** The full simulator state, ready for JSON.stringify. */
  snapshot(): PaperSnapshot {
    const closed = [...this.closed.entries()];
    return {
      version: PAPER_SNAPSHOT_VERSION,
      wallet: this.wallet,
      positions: [...this.positions.values()],
      orders: this.orders.map((o) => ({ ...o })),
      closed: closed.length > CLOSED_KEEP ? closed.slice(closed.length - CLOSED_KEEP) : closed,
      marks: [...this.marks.entries()],
      leverages: [...this.leverages.entries()],
    };
  }

  /** Reads the persisted snapshot, if any. A missing/unreadable/stale blob is ignored, never thrown. */
  private restore(): void {
    if (!this.persist) return;
    let raw: string | null;
    try {
      raw = this.persist.load();
    } catch (e) {
      console.warn(`paper: snapshot load failed, starting fresh: ${String(e)}`);
      return;
    }
    if (!raw) return;
    let snap: PaperSnapshot;
    try {
      snap = JSON.parse(raw) as PaperSnapshot;
    } catch (e) {
      console.warn(`paper: snapshot is not valid JSON, starting fresh: ${String(e)}`);
      return;
    }
    if (!snap || typeof snap !== 'object' || snap.version !== PAPER_SNAPSHOT_VERSION) {
      console.warn(`paper: snapshot version ${String(snap?.version)} != ${PAPER_SNAPSHOT_VERSION}, discarding`);
      return;
    }
    if (typeof snap.wallet === 'number' && Number.isFinite(snap.wallet)) this.wallet = snap.wallet;
    this.positions = new Map((snap.positions ?? []).map((p) => [this.key(p.symbol, p.market ?? 'perp'), { ...p, market: p.market ?? 'perp' }]));
    this.orders = (snap.orders ?? []).map((o) => ({ ...o, market: o.market ?? 'perp' }));
    this.closed = new Map(snap.closed ?? []);
    this.marks = new Map(snap.marks ?? []);
    this.leverages = new Map(snap.leverages ?? []);
  }

  /** Called at the end of every state-changing method; a failing store must not break trading. */
  private save(): void {
    if (!this.persist) return;
    try {
      this.persist.save(JSON.stringify(this.snapshot()));
    } catch (e) {
      console.warn(`paper: snapshot save failed: ${String(e)}`);
    }
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  setMark(symbol: string, mark: string, market: Market = 'perp'): void {
    this.marks.set(this.key(symbol, market), mark);
    this.save();
  }
  private key(symbol: string, market: Market): string { return market === 'perp' ? symbol : `spot:${symbol}`; }
  private mark(symbol: string, market: Market = 'perp'): number {
    return Number(this.marks.get(this.key(symbol, market)) ?? '0');
  }
  async markPrice(symbol: string, market: Market = 'perp'): Promise<string> {
    return this.marks.get(this.key(symbol, market)) ?? '0';
  }
  private exchangeSymbols = new Map<Market,SymbolInfo[]>();
  async symbolRules(symbol: string, market: Market = 'perp'): Promise<SymbolRules> {
    const list = await this.symbols(market);
    const s = list.find((x) => x.symbol === symbol) ?? PAPER_SYMBOLS.find((x) => x.symbol === symbol);
    return s ? { step_size: s.step_size, tick_size: s.tick_size, min_qty: s.min_qty, min_notional: s.min_notional } : { step_size: '0.001', tick_size: '0.01', min_qty: '0.001', min_notional: '5' };
  }
  /** Every USDT perpetual from the public exchangeInfo (so any Binance asset is tradable on paper); the static list is the offline fallback. */
  async symbols(market: Market = 'perp'): Promise<SymbolInfo[]> {
    if (!this.liveSymbols) return PAPER_SYMBOLS;
    try {
      const rows = await fetchExchangeInfo(market);
      if (rows.length) {
        this.exchangeSymbols.set(market,rows);
        return rows;
      }
    } catch {
      // offline / fake market server without exchangeInfo: fall through to the static list
    }
    return this.exchangeSymbols.get(market) ?? PAPER_SYMBOLS;
  }
  async setLeverage(symbol: string, leverage: number): Promise<{ ok: boolean; error: string | null }> {
    this.leverages.set(symbol, leverage);
    this.save();
    return { ok: true, error: null };
  }
  async setMarginType(): Promise<{ ok: boolean; error: string | null }> {
    return { ok: true, error: null };
  }
  private reservedSpot(): number { return this.orders.filter(o => o.market === 'spot' && o.type === 'LIMIT' && !o.reduce_only).reduce((v,o) => v + Number(o.price)*Number(o.qty)*(1+FEE_RATE),0); }
  async account(): Promise<AccountView> {
    let upnl = 0;
    let spotCost = 0;
    const positions: PositionView[] = [];
    for (const p of this.positions.values()) {
      // 没有行情(重启后还没拉到 / 429)时 mark 是 0,会把权益算成 0 并触发「日亏 100%」这种假告警;
      // 退回入场价(浮盈按 0 算)。Portfolio 快照那边会因为缺行情标 incomplete,新开仓照样被挡。
      const m = this.mark(p.symbol, p.market ?? 'perp') || p.entry;
      const pnl = (p.side === 'long' ? m - p.entry : p.entry - m) * p.qty;
      upnl += pnl;
      if (p.market === 'spot') spotCost += p.qty * p.entry;
      positions.push({ symbol: p.symbol, market: p.market ?? 'perp', side: p.side, qty: p.qty.toString(), entry_price: p.entry.toString(), mark_price: m.toString(), unrealized_pnl: pnl.toFixed(2), leverage: p.leverage });
    }
    const equity = this.wallet + spotCost + upnl;
    return {
      backend: 'paper',
      equity: equity.toFixed(2),
      available: (this.wallet - this.reservedSpot()).toFixed(2),
      unrealized_pnl: upnl.toFixed(2),
      positions,
      open_orders: this.orders.map(({ symbol, market, position_side: _p, ...o }) => ({ ...o, symbol, market })) as unknown as OpenOrderView[],
      as_of: Date.now(),
    };
  }
  private fill(symbol: string, side: Direction, qty: number, price: number, leverage: number, market: Market = 'perp'): void {
    const existing = this.positions.get(this.key(symbol, market));
    this.wallet -= price * qty * FEE_RATE;
    if (market === 'spot') this.wallet -= price * qty;
    if (!existing) {
      this.positions.set(this.key(symbol, market), { symbol, market, side, qty, entry: price, leverage, entry_fee: market === 'spot' ? price * qty * FEE_RATE : 0 });
      return;
    }
    if (existing.side === side) {
      existing.entry = (existing.entry * existing.qty + price * qty) / (existing.qty + qty);
      existing.qty += qty;
      if (market === 'spot') existing.entry_fee = (existing.entry_fee ?? 0) + price * qty * FEE_RATE;
      return;
    }
    // opposite side = reduce
    this.closeAt(symbol, price, qty, market);
  }
  async placeEntry(req: EntryRequest): Promise<OrderReceipt> {
    const market = req.market ?? 'perp';
    if (market === 'spot' && req.direction !== 'long') return { outcome: 'failed', receipt: {kind:'local_reject'}, avg_price:null, error:'spot_no_short' };
    const m = this.mark(req.symbol, market);
    if (!(m > 0)) return { outcome: 'failed', receipt: null, avg_price: null, error: 'paper: no mark price yet' };
    const qty = Number(req.qty);
    const lev = market === 'spot' ? 1 : this.leverages.get(req.symbol) ?? 3;
    if (market === 'spot' && Number(req.qty) * (req.entry === 'limit' ? Number(req.limit_price) : m) * (1 + FEE_RATE) > this.wallet - this.reservedSpot()) return {outcome:'failed', receipt:{kind:'local_reject'}, avg_price:null, error:'insufficient_balance'};
    if (req.entry === 'limit') {
      const price = Number(req.limit_price);
      if (!(price > 0)) return { outcome: 'failed', receipt: null, avg_price: null, error: 'paper: limit price required' };
      const crosses = req.direction === 'long' ? m <= price : m >= price;
      if (crosses) {
        this.fill(req.symbol, req.direction, qty, m, lev, market);
        this.save();
        return { outcome: 'filled', receipt: { paper: true, clientOrderId: req.client_order_id, avgPrice: m.toString(), executedQty: req.qty, status: 'FILLED' }, avg_price: m.toString(), error: null };
      }
      this.orders.push({ symbol: req.symbol, market, position_side: req.direction, client_order_id: req.client_order_id, type: 'LIMIT', side: req.direction === 'long' ? 'BUY' : 'SELL', qty: req.qty, price: req.limit_price, stop_price: null, reduce_only: false, status: 'NEW' });
      this.save();
      return { outcome: 'submitted', receipt: { paper: true, clientOrderId: req.client_order_id, price: req.limit_price, status: 'NEW' }, avg_price: null, error: null };
    }
    this.fill(req.symbol, req.direction, qty, m, lev, market);
    this.save();
    return { outcome: 'filled', receipt: { paper: true, clientOrderId: req.client_order_id, avgPrice: m.toString(), executedQty: req.qty, status: 'FILLED' }, avg_price: m.toString(), error: null };
  }
  private protective(symbol: string, position: Direction, price: string, id: string, type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET', market: Market = 'perp', quantity?: string): OrderReceipt {
    this.orders.push({ symbol, market, position_side: position, client_order_id: id, type, side: position === 'long' ? 'SELL' : 'BUY', qty: quantity ?? (market === 'spot' ? String(this.positions.get(this.key(symbol, market))?.qty ?? 0) : '0'), price: null, stop_price: price, reduce_only: true, status: 'NEW' });
    this.save();
    return { outcome: 'submitted', receipt: { paper: true, clientOrderId: id, type, stopPrice: price, status: 'NEW' }, avg_price: null, error: null };
  }
  async placeStop(symbol: string, position: Direction, stop_price: string, id: string, market: Market = 'perp'): Promise<OrderReceipt> {
    return this.protective(symbol, position, stop_price, id, 'STOP_MARKET', market);
  }
  async getStopProtection(symbol: string, cid: string, market: Market): Promise<StopProtection | null> {
    const o = this.orders.find(o => o.symbol === symbol && (o.market ?? 'perp') === market && o.client_order_id === cid && o.type === 'STOP_MARKET' && o.reduce_only && o.status === 'NEW');
    return o?.stop_price ? { client_order_id: cid, algo_id: null, symbol, market, side: o.position_side, stop_price: o.stop_price, qty: o.qty, close_position: market === 'perp' && o.qty === '0', take_profit_price: null } : null;
  }
  async replacePaperStop(r: StopMoveRequest): Promise<OrderReceipt> {
    const p = this.positions.get(this.key(r.symbol, r.market));
    const old = this.orders.find(o => o.symbol === r.symbol && (o.market ?? 'perp') === r.market && o.client_order_id === r.old_cid && o.type === 'STOP_MARKET' && o.position_side === r.side && o.stop_price && compareStopPrices(o.stop_price, r.old_stop) === 0);
    if (!old || !p || p.side !== r.side) return { outcome: 'failed', receipt: null, avg_price: null, error: 'paper_stop_or_position_changed' };
    // 一次快照持久化，没有先撤后挂空窗；存盘失败回滚内存，不能报告已确认。
    const orders = this.orders, closed = this.closed;
    this.orders = orders.map(o => o === old ? { ...o, client_order_id: r.new_cid, stop_price: r.target_stop } : o);
    this.closed = new Map(closed).set(this.key(r.old_cid, r.market), { status: 'CANCELED', avg_price: null, executed_qty: '0', raw: null });
    try { this.persist?.save(JSON.stringify(this.snapshot())); }
    catch (e) { this.orders = orders; this.closed = closed; return { outcome: 'unknown', receipt: null, avg_price: null, error: `paper_snapshot_unknown:${String(e)}` }; }
    return { outcome: 'submitted', receipt: { paper: true, clientOrderId: r.new_cid }, avg_price: null, error: null };
  }
  async placeTakeProfit(symbol: string, position: Direction, tp: string, id: string, market: Market = 'perp'): Promise<OrderReceipt> {
    return this.protective(symbol, position, tp, id, 'TAKE_PROFIT_MARKET', market);
  }
  async placePartialTakeProfit(symbol: string, position: Direction, tp: string, qty: string, id: string, market: Market = 'perp'): Promise<OrderReceipt> {
    const current = this.positions.get(this.key(symbol, market));
    if (!current || current.side !== position || !(Number(qty) > 0 && Number(qty) <= current.qty)) return { outcome: 'failed', receipt: null, avg_price: null, error: 'partial_tp_quantity_invalid' };
    return this.protective(symbol, position, tp, id, 'TAKE_PROFIT_MARKET', market, qty);
  }
  private closeAt(symbol: string, price: number, qty: number | undefined = undefined, market: Market = 'perp'): number {
    const p = this.positions.get(this.key(symbol, market));
    if (!p) return 0;
    const q = Math.min(p.qty, qty ?? p.qty);
    const pnl = (p.side === 'long' ? price - p.entry : p.entry - price) * q - price * q * FEE_RATE;
    const entryFee = market === 'spot' ? (p.entry_fee ?? 0) * q / p.qty : 0;
    p.entry_fee = (p.entry_fee ?? 0) - entryFee;
    this.wallet += pnl;
    if (market === 'spot') this.wallet += p.entry * q;
    if (q >= p.qty - 1e-12) {
      this.positions.delete(this.key(symbol, market));
      for (const o of this.orders.filter((x) => x.symbol === symbol && (x.market ?? 'perp') === market && x.reduce_only)) this.closed.set(this.key(o.client_order_id, market), { status: 'CANCELED', avg_price: null, executed_qty: '0', raw: null });
      this.orders = this.orders.filter((o) => !(o.symbol === symbol && (o.market ?? 'perp') === market && o.reduce_only));
    } else p.qty -= q;
    return pnl - entryFee;
  }
  async closePosition(symbol: string, id: string, market: Market = 'perp'): Promise<{ closed: boolean; receipt: unknown; error: string | null }> {
    if (!this.positions.has(this.key(symbol, market))) return { closed: false, receipt: null, error: null };
    const price = this.mark(symbol, market);
    const pnl = this.closeAt(symbol, price, undefined, market);
    this.save();
    return { closed: true, receipt: { paper: true, clientOrderId: id, avgPrice: price.toString(), realizedPnl: market === 'spot' ? pnl.toFixed(8) : pnl.toFixed(2) }, error: null };
  }
  async reducePosition(symbol: string, qty: string, id: string, market: Market = 'perp'): Promise<OrderReceipt> {
    if (!this.positions.has(this.key(symbol, market))) return { outcome: 'failed', receipt: null, avg_price: null, error: 'paper: no position' };
    if (market === 'spot') await this.cancelAll(symbol, market);
    const price = this.mark(symbol, market);
    const pnl = this.closeAt(symbol, price, Number(qty), market);
    this.save();
    return { outcome: 'filled', receipt: { paper: true, clientOrderId: id, avgPrice: price.toString(), realizedPnl: market === 'spot' ? pnl.toFixed(8) : pnl.toFixed(2) }, avg_price: price.toString(), error: null };
  }
  async cancelAll(symbol: string, market: Market = 'perp'): Promise<{ ok: boolean; error: string | null }> {
    for (const o of this.orders.filter((x) => x.symbol === symbol && (x.market ?? 'perp') === market)) this.closed.set(this.key(o.client_order_id, market), { status: 'CANCELED', avg_price: null, executed_qty: '0', raw: null });
    this.orders = this.orders.filter((o) => (o.symbol !== symbol || (o.market ?? 'perp') !== market));
    this.save();
    return { ok: true, error: null };
  }
  async cancelOrder(symbol: string, cid: string, market: Market = 'perp'): Promise<{ ok: boolean; error: string | null }> {
    const o = this.orders.find((x) => x.symbol === symbol && (x.market ?? 'perp') === market && x.client_order_id === cid);
    if (!o) return { ok: false, error: 'paper: order not found' };
    this.closed.set(this.key(cid, market), { status: 'CANCELED', avg_price: null, executed_qty: '0', raw: null });
    this.orders = this.orders.filter((x) => x !== o);
    this.save();
    return { ok: true, error: null };
  }
  async getOrder(_symbol: string, cid: string, _fresh = false, market: Market = 'perp'): Promise<OrderStatusView | null> {
    const open = this.orders.find((x) => x.client_order_id === cid && x.symbol === _symbol && x.market === market);
    if (open) return { status: 'NEW', avg_price: null, executed_qty: '0', raw: open };
    return this.closed.get(this.key(cid, market)) ?? null;
  }
  tick(symbol: string, mark: string, market: Market = 'perp'): PaperEvent[] {
    this.marks.set(this.key(symbol, market), mark);
    const m = Number(mark);
    const events: PaperEvent[] = [];
    // resting limit entries
    for (const o of this.orders.filter((x) => x.symbol === symbol && (x.market ?? 'perp') === market && x.type === 'LIMIT')) {
      const price = Number(o.price);
      const crosses = o.position_side === 'long' ? m <= price : m >= price;
      if (!crosses) continue;
      const lev = market === 'spot' ? 1 : this.leverages.get(symbol) ?? 3;
      this.fill(symbol, o.position_side, Number(o.qty), price, lev, market);
      this.orders = this.orders.filter((x) => x !== o);
      this.closed.set(this.key(o.client_order_id, market), { status: 'FILLED', avg_price: price.toString(), executed_qty: o.qty, raw: { paper: true } });
      events.push({ kind: 'entry_filled', symbol, market, client_order_id: o.client_order_id, price: price.toString(), realized_pnl: null, message: `限价入场成交 @ ${price}` });
    }
    const p = this.positions.get(this.key(symbol, market));
    if (!p) {
      this.save();
      return events;
    }
    for (const o of this.orders.filter((x) => x.symbol === symbol && (x.market ?? 'perp') === market && x.reduce_only)) {
      const trig = Number(o.stop_price);
      const hit = o.type === 'STOP_MARKET' ? (p.side === 'long' ? m <= trig : m >= trig) : p.side === 'long' ? m >= trig : m <= trig;
      if (hit) {
        const quantity = o.type === 'TAKE_PROFIT_MARKET' && Number(o.qty) > 0 ? Math.min(p.qty, Number(o.qty)) : p.qty;
        const pnl = this.closeAt(symbol, trig, quantity, market);
        this.orders = this.orders.filter(row => row.client_order_id !== o.client_order_id);
        this.closed.set(this.key(o.client_order_id, market), { status: 'FILLED', avg_price: trig.toString(), executed_qty: quantity.toString(), raw: { paper: true } });
        events.push({ kind: o.type === 'STOP_MARKET' ? 'sl_hit' : 'tp_hit', symbol, market, client_order_id: o.client_order_id, price: trig.toString(), realized_pnl: market === 'spot' ? pnl.toFixed(8) : pnl.toFixed(2), message: `${o.type === 'STOP_MARKET' ? '止损' : '止盈'}触发 @ ${trig},盈亏 ${pnl.toFixed(2)} USDT` });
        break;
      }
    }
    this.save();
    return events;
  }
}

// ---------------------------------------------------------------- demo (Rust child)

interface RpcError {
  kind: string;
  message: string;
  code?: number;
  ambiguous?: boolean;
}

export class DemoExecError extends Error {
  constructor(
    public readonly op: string,
    public readonly err: RpcError,
  ) {
    super(`${op}: ${err.kind}: ${err.message}`);
  }
}

export function defaultDemoExecBin(repoRoot: string): string {
  const fromEnv = process.env['TG_DEMO_EXEC_BIN'];
  if (fromEnv) return fromEnv;
  for (const p of ['target/exec-core/release/tgate-demo-exec', 'target/exec-core/debug/tgate-demo-exec', 'target/release/tgate-demo-exec', 'target/debug/tgate-demo-exec']) {
    const full = path.join(repoRoot, p);
    if (existsSync(full)) return full;
  }
  return path.join(repoRoot, 'target/exec-core/debug/tgate-demo-exec');
}

export class DemoBackend implements ExecBackend {
  readonly kind: Backend = 'demo';
  marketsSupported(): Market[] { return ['perp']; }
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; op: string; timer: NodeJS.Timeout }>();
  private hello: Record<string, unknown> | null = null;
  private rulesCache = new Map<string, SymbolRules>();
  private positionSideDual = false;

  constructor(
    private readonly bin: string,
    private readonly log: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void,
  ) {}

  async start(): Promise<void> {
    if (!existsSync(this.bin)) throw new Error(`tgate-demo-exec not found at ${this.bin} (build: CARGO_TARGET_DIR=target/exec-core cargo build -p exec-core --bin tgate-demo-exec)`);
    const child = spawn(this.bin, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NO_PROXY: `${process.env['NO_PROXY'] ?? ''},localhost,127.0.0.1` } });
    this.child = child;
    child.stderr.on('data', (d) => this.log('info', `[demo-exec] ${String(d).trim()}`));
    const rl = readline.createInterface({ input: child.stdout });
    const helloPromise = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('tgate-demo-exec: no hello within 30s')), 30_000);
      rl.on('line', (line) => {
        let msg: { id: number | null; ok: boolean; result?: unknown; error?: RpcError };
        try {
          msg = JSON.parse(line);
        } catch {
          this.log('warn', `demo-exec: unparseable line: ${line.slice(0, 200)}`);
          return;
        }
        if (msg.id === 0) {
          clearTimeout(t);
          if (msg.ok) {
            this.hello = (msg.result ?? {}) as Record<string, unknown>;
            resolve();
          } else reject(new Error(`tgate-demo-exec hello failed: ${msg.error?.message}`));
          return;
        }
        const p = msg.id === null ? undefined : this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.id as number);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new DemoExecError(p.op, msg.error ?? { kind: 'transport', message: 'no error body', ambiguous: true }));
      });
    });
    child.on('exit', (code) => {
      this.log('error', `tgate-demo-exec exited with code ${code}`);
      for (const p of this.pending.values()) p.reject(new DemoExecError(p.op, { kind: 'transport', message: 'demo-exec exited', ambiguous: true }));
      this.pending.clear();
      this.child = null;
    });
    await helloPromise;
    this.log('info', `tgate-demo-exec ready: ${JSON.stringify(this.hello)}`);
  }

  async stop(): Promise<void> {
    this.child?.stdin.end();
    this.child?.kill('SIGTERM');
    this.child = null;
  }

  private call<T = unknown>(op: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    if (!this.child) return Promise.reject(new DemoExecError(op, { kind: 'transport', message: 'demo-exec not running', ambiguous: false }));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DemoExecError(op, { kind: 'transport', message: `timeout after ${timeoutMs}ms`, ambiguous: true }));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, op, timer });
      this.child!.stdin.write(`${JSON.stringify({ id, op, params })}\n`);
    });
  }

  async markPrice(symbol: string, market: Market = 'perp'): Promise<string> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    const r = await this.call<{ markPrice: string }>('mark_price', { symbol });
    return Number(r.markPrice).toFixed(2);
  }

  async symbolRules(symbol: string, market: Market = 'perp'): Promise<SymbolRules> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    const cached = this.rulesCache.get(symbol);
    if (cached) return cached;
    const r = await this.call<Record<string, unknown>>('symbol_rules', { symbol });
    const rules: SymbolRules = {
      step_size: String(r['step_size'] ?? '0.001'),
      tick_size: String(r['tick_size'] ?? '0.1'),
      min_qty: String(r['min_qty'] ?? '0.001'),
      min_notional: String(r['min_notional'] ?? '100'),
    };
    this.rulesCache.set(symbol, rules);
    return rules;
  }

  async account(): Promise<AccountView> {
    const [acct, pos, orders] = await Promise.all([
      this.call<Record<string, unknown>>('account'),
      this.call<Record<string, unknown>[]>('positions'),
      this.call<Record<string, unknown>[]>('open_orders'),
    ]);
    const positions: PositionView[] = [];
    for (const p of pos) {
      const amt = Number(p['positionAmt'] ?? '0');
      if (String(p['positionSide'] ?? 'BOTH') !== 'BOTH') this.positionSideDual = true;
      if (amt === 0) continue;
      positions.push({
        symbol: String(p['symbol']),
        market: 'perp',
        side: amt > 0 ? 'long' : 'short',
        qty: Math.abs(amt).toString(),
        entry_price: Number(p['entryPrice'] ?? '0').toFixed(1),
        mark_price: Number(p['markPrice'] ?? '0').toFixed(1),
        unrealized_pnl: Number(p['unRealizedProfit'] ?? p['unrealizedProfit'] ?? '0').toFixed(2),
        leverage: Number(p['leverage'] ?? '0'),
      });
    }
    const open_orders: OpenOrderView[] = orders.map((o) => ({
      symbol: String(o['symbol'] ?? ''),
      market: 'perp',
      client_order_id: String(o['clientOrderId'] ?? ''),
      type: String(o['type'] ?? ''),
      side: String(o['side'] ?? ''),
      qty: String(o['origQty'] ?? '0'),
      price: Number(o['price'] ?? '0') > 0 ? String(o['price']) : null,
      stop_price: Number(o['stopPrice'] ?? '0') > 0 ? String(o['stopPrice']) : null,
      reduce_only: Boolean(o['reduceOnly']) || Boolean(o['closePosition']),
      status: String(o['status'] ?? ''),
    }));
    const wallet = Number(acct['totalWalletBalance'] ?? '0');
    const upnl = Number(acct['totalUnrealizedProfit'] ?? '0');
    return {
      backend: 'demo',
      equity: (wallet + upnl).toFixed(2),
      available: Number(acct['availableBalance'] ?? '0').toFixed(2),
      unrealized_pnl: upnl.toFixed(2),
      positions,
      open_orders,
      as_of: Date.now(),
    };
  }

  private async order(params: Record<string, unknown>): Promise<OrderReceipt> {
    try {
      const receipt = await this.call<Record<string, unknown>>('place', params, 20_000);
      const status = String(receipt['status'] ?? '');
      const avg = Number(receipt['avgPrice'] ?? '0');
      return { outcome: status === 'FILLED' ? 'filled' : 'submitted', receipt, avg_price: avg > 0 ? avg.toFixed(1) : null, error: null };
    } catch (e) {
      if (e instanceof DemoExecError) return { outcome: e.err.ambiguous ? 'unknown' : 'failed', receipt: e.err, avg_price: null, error: e.message };
      return { outcome: 'failed', receipt: null, avg_price: null, error: String(e) };
    }
  }

  async placeEntry(req: EntryRequest): Promise<OrderReceipt> {
    if (req.market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    const base: Record<string, unknown> = {
      symbol: req.symbol,
      market: 'perp',
      side: req.direction === 'long' ? 'buy' : 'sell',
      order_type: req.entry === 'market' ? 'market' : 'limit',
      quantity: req.qty,
      new_client_order_id: req.client_order_id,
      new_order_resp_type: 'result',
    };
    if (req.entry === 'limit') {
      base['price'] = req.limit_price;
      base['time_in_force'] = 'gtc';
    }
    if (this.positionSideDual) base['position_side'] = req.direction;
    return this.order(base);
  }

  private closeSide(position: Direction): string {
    return position === 'long' ? 'sell' : 'buy';
  }

  async placeStop(symbol: string, position: Direction, stop_price: string, id: string, market: Market = 'perp'): Promise<OrderReceipt> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    const p: Record<string, unknown> = { symbol, side: this.closeSide(position), order_type: 'stop_market', stop_price, close_position: true, working_type: 'mark_price', new_client_order_id: id };
    if (this.positionSideDual) p['position_side'] = position;
    return this.order(p);
  }

  async placeTakeProfit(symbol: string, position: Direction, tp: string, id: string, market: Market = 'perp'): Promise<OrderReceipt> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    const p: Record<string, unknown> = { symbol, side: this.closeSide(position), order_type: 'take_profit_market', stop_price: tp, close_position: true, working_type: 'mark_price', new_client_order_id: id };
    if (this.positionSideDual) p['position_side'] = position;
    return this.order(p);
  }

  async closePosition(symbol: string, id: string, market: Market = 'perp'): Promise<{ closed: boolean; receipt: unknown; error: string | null }> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    try {
      const r = await this.call<{ closed: boolean; receipt?: unknown }>('close_position', { symbol, client_order_id: id }, 20_000);
      return { closed: Boolean(r.closed), receipt: r.receipt ?? null, error: null };
    } catch (e) {
      return { closed: false, receipt: null, error: String(e) };
    }
  }

  async reducePosition(symbol: string, qty: string, id: string, market: Market = 'perp'): Promise<OrderReceipt> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    const acct = await this.account();
    const pos = acct.positions.find((p) => p.symbol === symbol);
    if (!pos) return { outcome: 'failed', receipt: null, avg_price: null, error: 'no position' };
    const p: Record<string, unknown> = { symbol, side: this.closeSide(pos.side), order_type: 'market', quantity: qty, new_client_order_id: id, new_order_resp_type: 'result' };
    if (this.positionSideDual) p['position_side'] = pos.side;
    else p['reduce_only'] = true;
    return this.order(p);
  }

  async cancelAll(symbol: string, market: Market = 'perp'): Promise<{ ok: boolean; error: string | null }> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    try {
      await this.call('cancel_all', { symbol });
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  async getOrder(symbol: string, client_order_id: string, _fresh = false, market: Market = 'perp'): Promise<OrderStatusView | null> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    try {
      const raw = await this.call<Record<string, unknown>>('get_order', { symbol, client_order_id });
      const avg = Number(raw['avgPrice'] ?? '0');
      return { status: String(raw['status'] ?? ''), avg_price: avg > 0 ? String(raw['avgPrice']) : null, executed_qty: String(raw['executedQty'] ?? ''), raw };
    } catch (e) {
      if (e instanceof DemoExecError && e.err.kind === 'rejected') return null; // -2013 order does not exist
      throw e;
    }
  }

  async cancelOrder(symbol: string, client_order_id: string, market: Market = 'perp'): Promise<{ ok: boolean; error: string | null }> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    try {
      await this.call('cancel', { symbol, client_order_id });
      return { ok: true, error: null };
    } catch (e) {
      // Unknown-order business codes do not prove cancellation or zero fills.
      if (e instanceof DemoExecError && e.err.kind === 'rejected' && (e.err.code === -2011 || e.err.code === -2013)) return { ok: false, error: `cancel unknown: ${String(e)}` };
      return { ok: false, error: String(e) };
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<{ ok: boolean; error: string | null }> {
    try {
      await this.call('set_leverage', { symbol, leverage });
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  async setMarginType(symbol: string, mode: 'cross' | 'isolated'): Promise<{ ok: boolean; error: string | null }> {
    try {
      await this.call('set_margin_type', { symbol, margin_type: mode });
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  private symbolsCache: SymbolInfo[] | null = null;
  private symbolsFetchedAt = 0;
  async symbols(market: Market = 'perp'): Promise<SymbolInfo[]> {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    if (this.symbolsCache && Date.now() - this.symbolsFetchedAt < 10 * 60_000) return this.symbolsCache;
    this.symbolsFetchedAt = Date.now();
    const rows = await this.call<SymbolInfo[]>('exchange_info_symbols', {}, 30_000);
    this.symbolsCache = rows;
    for (const r of rows) this.rulesCache.set(r.symbol, { step_size: r.step_size, tick_size: r.tick_size, min_qty: r.min_qty, min_notional: r.min_notional });
    return rows;
  }

  tick(_symbol?: string, _mark?: string, market: Market = 'perp'): PaperEvent[] {
    if (market === 'spot') throw Object.assign(new Error('market_unsupported'), {kind:'local_reject', code:'market_unsupported'});
    return [];
  }
}

export function supportedMarkets(backend: ExecBackend): Market[] {
  const value = backend.marketsSupported?.();
  return Array.isArray(value) ? value : backend.kind === 'paper' ? ['perp', 'spot'] : ['perp'];
}
