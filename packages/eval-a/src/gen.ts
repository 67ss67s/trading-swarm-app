// Case generator (docs/eval/README.md §2). Deterministic given (symbols, tf, from, to, n, seed) and the
// cached raw klines. The only network use in the whole package is the KlineSource passed in.

import { demo } from '@trade-gate/gateway';
import type { EvalCase, Kline, MarketState, StrategyThread, Ticker24h } from './types.js';
import { mirrorFloor, mirrorKlines, mirrorPriceStr } from './mirror.js';
import type { KlineSource } from './binance.js';
import { buildTriggerInputs, firedScoredKinds, triggerTags } from './triggers.js';
import { decimalsOf, fmtDec, seededRng, stamp } from './util.js';

export interface GenOptions {
  symbols: string[];
  tf: string;
  from: number;
  to: number;
  n: number;
  seed: number | string;
  set: string;
  /** Review chain step spacing in bars of `tf` (default 4 = 1 h on 15m). */
  chain_step_bars?: number;
  /** Hidden horizon in bars of `tf` (default 48). */
  horizon_bars?: number;
  /**
   * How as_of moments are drawn. `uniform` (default) = seeded Fisher–Yates over every eligible closed bar,
   * which is what `cases/v1` was built with and must stay bit-for-bit reproducible. `triggers` = only bars
   * where `demo.detectTriggers` fires a scoreable rule (breakout / vol_spike / retest / ema_cross), so the
   * scan cases are the moments the runtime would actually have woken the model for — see `cases/v2`.
   */
  sample?: 'uniform' | 'triggers';
  /**
   * Daily bars to record in `visible.klines['1d']` (0 = don't record any, the v1 shape). 220 is the number
   * `demo.dailyRegime` needs for an EMA200; they are visible data (close_time ≤ as_of) but are NOT turned
   * into context features — nothing about the prompt changes, only what the report can compute.
   */
  daily_bars?: number;
  /** `triggers` only: minimum distance in `tf` bars between two picked as_of, so cases are not clustered. */
  min_spacing_bars?: number;
}

export const EQUITY = 10000;
export const LEVERAGE = 3;
export const RISK_PCT = 0.5;
const MAX_CHAIN_STEPS = 3;

/** Bars per timeframe a case shows. `dailyBars > 0` adds the 1d series `demo.dailyRegime` needs. */
export function visibleCounts(tf: string, dailyBars = 0): Record<string, number> {
  const counts: Record<string, number> = { [tf]: 60 };
  counts['1h'] = counts['1h'] ?? 120;
  counts['4h'] = counts['4h'] ?? 80;
  if (dailyBars > 0) counts['1d'] = counts['1d'] ?? dailyBars;
  return counts;
}

/** Daily bars recorded by `--sample triggers` unless `--daily-bars` says otherwise (EMA200 needs ≥ 200). */
export const DEFAULT_DAILY_BARS = 220;
export const DEFAULT_MIN_SPACING_BARS = 8;

/** Trigger sampling records 1d bars by default; uniform sampling keeps the v1 shape unless asked. */
export const dailyBarsOf = (opts: GenOptions): number => opts.daily_bars ?? ((opts.sample ?? 'uniform') === 'triggers' ? DEFAULT_DAILY_BARS : 0);

export const sliceVisible = (bars: Kline[], asOf: number, count: number): Kline[] => bars.filter((k) => k.close_time <= asOf).slice(-count);
export const sliceFuture = (bars: Kline[], asOf: number, count: number): Kline[] => bars.filter((k) => k.open_time >= asOf).slice(0, count);
/** Bars fully inside (fromMs, toMs]: open_time ≥ fromMs and close_time ≤ toMs. */
export const sliceBetween = (bars: Kline[], fromMs: number, toMs: number): Kline[] => bars.filter((k) => k.open_time >= fromMs && k.close_time <= toMs);

export function ticker24hFrom(bars: Kline[], asOf: number, tfMs: number): Ticker24h {
  const win = sliceVisible(bars, asOf, Math.round(86_400_000 / tfMs));
  const first = win[0]!;
  const last = win[win.length - 1]!;
  const o = Number(first.open);
  const c = Number(last.close);
  let hi = Number.NEGATIVE_INFINITY;
  let lo = Number.POSITIVE_INFINITY;
  let qv = 0;
  for (const k of win) {
    hi = Math.max(hi, Number(k.high));
    lo = Math.min(lo, Number(k.low));
    qv += Number(k.volume) * Number(k.close);
  }
  const d = decimalsOf(last.close);
  return { priceChangePercent: fmtDec(((c - o) / o) * 100, 3), highPrice: fmtDec(hi, d), lowPrice: fmtDec(lo, d), quoteVolume: fmtDec(qv, 2) };
}

function nextFunding(asOf: number): number {
  const eightH = 8 * 3_600_000;
  return Math.floor(asOf / eightH) * eightH + eightH;
}

function synthMarketState(symbol: string, asOf: number, bars4h: Kline[], ticker: Ticker24h, funding: string, oiChange: number | null): MarketState {
  const f = demo.tfFeatures('4h', bars4h);
  const up = f.ema20 > f.ema50 && f.last_close > f.ema20;
  const down = f.ema20 < f.ema50 && f.last_close < f.ema20;
  const regime: MarketState['regime'] = up ? 'trend_up' : down ? 'trend_down' : 'range';
  const bias: MarketState['bias'] = up ? 'long' : down ? 'short' : 'neutral';
  return {
    id: `ms-eval-${stamp(asOf)}`,
    as_of: asOf,
    model: 'eval-synthetic',
    regime,
    bias,
    summary: `合成信息员摘要(eval,无新闻源):4h 结构${up ? '偏多,价在 EMA20 上' : down ? '偏空,价在 EMA20 下' : '震荡,EMA 无明确方向'};24h 变动 ${ticker.priceChangePercent}%。`,
    key_points: [`4h EMA20 ${up ? '>' : down ? '<' : '≈'} EMA50`, `24h ${ticker.priceChangePercent}%`],
    majors: [{ symbol, last: bars4h[bars4h.length - 1]!.close, change_24h_pct: ticker.priceChangePercent, funding_rate: funding, oi_change_1h_pct: oiChange === null ? null : fmtDec(oiChange, 2), long_short_ratio: null, taker_buy_sell_ratio: null }],
    sentiment: { fng: null, fng_label: null },
    top_movers: [],
    news: [],
    candidates: [],
    risk_events: [],
    info_refs: [],
    usage: null,
    error: null,
  };
}

interface SymbolBars {
  symbol: string;
  bars: Record<string, Kline[]>;
}

interface BaseParams {
  symbol: string;
  asOf: number;
  idx: number;
  funding: string;
  openInterest: string;
  oiChange: number | null;
  withMarketState: boolean;
}

/** Everything a scan case needs from a (possibly mirrored) bar set at one as_of. */
function scanCase(opts: GenOptions, id: string, tags: string[], sb: SymbolBars, p: BaseParams, mirrorOf: string | null, baseTicker: Ticker24h | null = null): EvalCase {
  const tfMs = demo.tfToMs(opts.tf);
  const counts = visibleCounts(opts.tf, dailyBarsOf(opts));
  const klines: Record<string, Kline[]> = {};
  for (const [tf, count] of Object.entries(counts)) klines[tf] = sliceVisible(sb.bars[tf]!, p.asOf, count);
  const tfBars = klines[opts.tf]!;
  const last = tfBars[tfBars.length - 1]!;
  const own = ticker24hFrom(sb.bars[opts.tf]!, p.asOf, tfMs);
  // A mirror keeps the base's turnover: volume is untouched by the mirror, so USDT turnover is too.
  const ticker = baseTicker ? { ...own, quoteVolume: baseTicker.quoteVolume } : own;
  const market = { symbol: p.symbol, last: last.close, mark: last.close, funding_rate: p.funding, next_funding_at: nextFunding(p.asOf), open_interest: p.openInterest, as_of: p.asOf, klines_tf: opts.tf };
  const marketState = p.withMarketState ? synthMarketState(p.symbol, p.asOf - 30 * 60_000, klines['4h']!, ticker, p.funding, p.oiChange) : null;
  return {
    id,
    set: opts.set,
    meta: { set: opts.set },
    tags,
    symbol: p.symbol,
    timeframe: opts.tf,
    as_of: p.asOf,
    mode: 'scan',
    thread: null,
    visible: {
      klines,
      market,
      ticker24h: ticker,
      oi_change_1h_pct: p.oiChange,
      market_state: marketState,
      account: { backend: 'paper', equity: EQUITY.toFixed(2), available: EQUITY.toFixed(2), unrealized_pnl: '0.00', positions: [], open_orders: [], as_of: p.asOf },
      playbook_text: demo.DEFAULT_PLAYBOOK,
      last_judgment_summary: null,
      halted: false,
      stale_all: false,
    },
    hidden: { future_klines: sliceFuture(sb.bars[opts.tf]!, p.asOf, opts.horizon_bars ?? 48), horizon_bars: opts.horizon_bars ?? 48, rubric: null, mirror_of: mirrorOf },
  };
}

export function staleVariant(c: EvalCase): EvalCase {
  const back = 10 * 60_000;
  const ms = c.visible.market_state ? { ...c.visible.market_state, as_of: c.visible.market_state.as_of - 4 * 3_600_000 } : null;
  return {
    ...c,
    id: `${c.id}-stale`,
    tags: [...c.tags.filter((t) => t !== 'stale' && t !== 'base'), 'stale'],
    visible: { ...c.visible, market: { ...c.visible.market, as_of: c.visible.market.as_of - back }, account: { ...c.visible.account, as_of: c.visible.account.as_of - back }, market_state: ms, stale_all: true },
    hidden: { ...c.hidden, rubric: { must_not: ['PROPOSE', 'ADD'], note: '所有 market/account 证据 STALE:不得开仓' }, mirror_of: null },
  };
}

export function haltedVariant(c: EvalCase): EvalCase {
  return {
    ...c,
    id: `${c.id}-halted`,
    tags: [...c.tags.filter((t) => t !== 'halted' && t !== 'base'), 'halted'],
    visible: { ...c.visible, halted: true },
    hidden: { ...c.hidden, rubric: { must_not: ['PROPOSE', 'ADD'], note: '紧急停止:只允许降风险动作' }, mirror_of: null },
  };
}

interface ThreadSpec {
  side: 'long' | 'short';
  entryType: 'market' | 'limit';
  entryPrice: string;
  stop: string;
  tp: string;
  qty: string;
  margin: string;
  steps: number;
}

function threadSpec(side: 'long' | 'short', entryType: 'market' | 'limit', p0: string, atr1h: number, steps: number): ThreadSpec {
  const d = decimalsOf(p0);
  const sgn = side === 'long' ? 1 : -1;
  const entry = entryType === 'market' ? Number(p0) : Number(p0) - sgn * 0.5 * atr1h;
  const stopDist = 1.2 * atr1h;
  const stop = entry - sgn * stopDist;
  const tp = entry + sgn * 2 * stopDist;
  const qty = (EQUITY * RISK_PCT) / 100 / stopDist;
  return { side, entryType, entryPrice: fmtDec(entry, d), stop: fmtDec(stop, d), tp: fmtDec(tp, d), qty: fmtDec(qty, 3), margin: fmtDec((qty * entry) / LEVERAGE, 2), steps };
}

function mirrorSpec(s: ThreadSpec, p0: number): ThreadSpec {
  return { ...s, side: s.side === 'long' ? 'short' : 'long', entryPrice: mirrorPriceStr(s.entryPrice, p0), stop: mirrorPriceStr(s.stop, p0), tp: mirrorPriceStr(s.tp, p0), qty: s.qty };
}

function makeThread(id: string, symbol: string, tf: string, spec: ThreadSpec, createdAt: number): StrategyThread {
  const t = demo.newThread({
    id,
    symbol,
    side: spec.side,
    source: 'agent',
    timeframe: tf,
    thesis: `合成线程(eval):${spec.side === 'long' ? '多头' : '空头'}突破-回踩,入场 ${spec.entryPrice},止损 ${spec.stop}(1.2 ATR 外),止盈 ${spec.tp}`,
    invalidation_text: `${tf} 收盘${spec.side === 'long' ? '跌破' : '升破'}止损 ${spec.stop}`,
    watch_conditions: ['1h/4h 方向是否仍一致', '价格相对 EMA20 的位置'],
    entry: spec.entryType === 'market' ? { type: 'market', price: null, zone: null } : { type: 'limit', price: spec.entryPrice, zone: null },
    stop_price: spec.stop,
    take_profits: [spec.tp],
    qty: spec.qty,
    margin_usdt: spec.margin,
    leverage: LEVERAGE,
    margin_mode: 'cross',
    now: createdAt,
  });
  t.entry_client_order_id = `${demo.threadClientPrefix(id)}-e`;
  return t;
}

/** Walks the tf bars from thread creation to `asOf` and returns the thread state the runtime would hold. */
function threadAt(base: StrategyThread, spec: ThreadSpec, bars: Kline[], createdAt: number, asOf: number, stepBars: number): { thread: StrategyThread; stopCrossed: boolean; tpCrossed: boolean; filledThisStep: boolean } {
  const path = sliceBetween(bars, createdAt, asOf);
  const limit = Number(spec.entryPrice);
  const stop = Number(spec.stop);
  const tp = Number(spec.tp);
  const long = spec.side === 'long';
  let fillIdx = spec.entryType === 'market' ? 0 : -1;
  if (spec.entryType === 'limit') fillIdx = path.findIndex((k) => (long ? Number(k.low) <= limit : Number(k.high) >= limit));
  const t: StrategyThread = { ...base };
  let stopCrossed = false;
  let tpCrossed = false;
  if (fillIdx >= 0 && path[fillIdx]) {
    t.status = 'in_position';
    t.filled_avg_price = spec.entryPrice;
    t.opened_at = spec.entryType === 'market' ? createdAt : path[fillIdx]!.close_time + 1;
    t.updated_at = t.opened_at;
    t.version = 2;
    t.protection_client_order_ids = [`${demo.threadClientPrefix(t.id)}-sl`, `${demo.threadClientPrefix(t.id)}-tp`];
    for (const k of path.slice(fillIdx)) {
      if (long ? Number(k.low) <= stop : Number(k.high) >= stop) stopCrossed = true;
      if (long ? Number(k.high) >= tp : Number(k.low) <= tp) tpCrossed = true;
    }
    if (stopCrossed || tpCrossed) t.attention = 'PROTECTION_MISSING';
  }
  const filledThisStep = spec.entryType === 'limit' && fillIdx >= 0 && fillIdx >= path.length - stepBars;
  return { thread: t, stopCrossed, tpCrossed, filledThisStep };
}

function reviewCase(opts: GenOptions, base: EvalCase, scanAt: EvalCase, spec: ThreadSpec, chainId: string, n: number, sb: SymbolBars, mirrorOf: string | null): EvalCase {
  const bars = sb.bars[opts.tf]!;
  const created = makeThread(`thr-${chainId}`, base.symbol, opts.tf, spec, base.as_of);
  const st = threadAt(created, spec, bars, base.as_of, scanAt.as_of, opts.chain_step_bars ?? 4);
  const t = st.thread;
  const mark = Number(scanAt.visible.market.last);
  const qty = Number(spec.qty);
  const sgn = spec.side === 'long' ? 1 : -1;
  const account = { ...scanAt.visible.account, positions: [] as EvalCase['visible']['account']['positions'], open_orders: [] as EvalCase['visible']['account']['open_orders'] };
  const prefix = demo.threadClientPrefix(t.id);
  const tags: string[] = ['review', `chain:${chainId}:${n}`, t.status, spec.side, `entry:${spec.entryType}`];
  if (mirrorOf) tags.push('mirror');
  let rubric: EvalCase['hidden']['rubric'] = null;
  if (t.status === 'in_position') {
    const upnl = (mark - Number(spec.entryPrice)) * qty * sgn;
    const equity = EQUITY + upnl;
    account.positions.push({ symbol: base.symbol, side: spec.side, qty: spec.qty, entry_price: spec.entryPrice, mark_price: scanAt.visible.market.last, unrealized_pnl: fmtDec(upnl, 2), leverage: LEVERAGE });
    account.equity = fmtDec(equity, 2);
    account.available = fmtDec(equity - Number(spec.margin), 2);
    account.unrealized_pnl = fmtDec(upnl, 2);
    if (!st.stopCrossed) account.open_orders.push({ symbol: base.symbol, client_order_id: `${prefix}-sl`, type: 'STOP_MARKET', side: spec.side === 'long' ? 'SELL' : 'BUY', qty: spec.qty, price: null, stop_price: spec.stop, reduce_only: true, status: 'NEW' });
    if (!st.tpCrossed) account.open_orders.push({ symbol: base.symbol, client_order_id: `${prefix}-tp`, type: 'TAKE_PROFIT_MARKET', side: spec.side === 'long' ? 'SELL' : 'BUY', qty: spec.qty, price: null, stop_price: spec.tp, reduce_only: true, status: 'NEW' });
    if (st.stopCrossed) {
      tags.push('stop-crossed');
      rubric = { expected_any_of: ['EXIT', 'INVALIDATE'], must_not: ['HOLD'], note: '价格已穿越止损且止损单缺失(PROTECTION_MISSING):应离场' };
    } else if (st.tpCrossed) {
      tags.push('tp-crossed');
      rubric = { expected_any_of: ['EXIT', 'REDUCE'], note: '价格已触及止盈且止盈单缺失:应落袋或减仓' };
    }
  } else {
    account.open_orders.push({ symbol: base.symbol, client_order_id: `${prefix}-e`, type: 'LIMIT', side: spec.side === 'long' ? 'BUY' : 'SELL', qty: spec.qty, price: spec.entryPrice, stop_price: null, reduce_only: false, status: 'NEW' });
    const atr1h = demo.tfFeatures('1h', scanAt.visible.klines['1h']!).atr14;
    if (Math.abs(mark - Number(spec.entryPrice)) > 1.5 * atr1h) {
      tags.push('far-from-entry');
      rubric = { expected_any_of: ['INVALIDATE'], note: '价格已远离入场区超过 1.5 个 1h ATR:应撤单' };
    }
  }
  const trigger = t.status === 'pending_entry' ? 'thread_review' : st.filledThisStep || (spec.entryType === 'market' && n === 1) ? 'order_filled' : 'position_review';
  tags.push(`trigger:${trigger}`);
  return {
    ...scanAt,
    id: `${chainId}${n}`,
    tags,
    mode: 'review',
    thread: t,
    visible: { ...scanAt.visible, account, last_judgment_summary: null },
    hidden: { ...scanAt.hidden, rubric, mirror_of: mirrorOf },
  };
}

export async function generateCases(opts: GenOptions, source: KlineSource, log: (s: string) => void = () => {}): Promise<EvalCase[]> {
  const tfMs = demo.tfToMs(opts.tf);
  const counts = visibleCounts(opts.tf, dailyBarsOf(opts));
  const stepBars = opts.chain_step_bars ?? 4;
  const horizon = opts.horizon_bars ?? 48;
  const futureMs = (horizon + MAX_CHAIN_STEPS * stepBars) * tfMs;
  const rng = seededRng(`${opts.seed}`);
  const perSymbol = new Map<string, number>();
  opts.symbols.forEach((s, i) => perSymbol.set(s, Math.floor(opts.n / opts.symbols.length) + (i < opts.n % opts.symbols.length ? 1 : 0)));

  const out: EvalCase[] = [];
  let idx = 0;
  for (const symbol of opts.symbols) {
    const bars: Record<string, Kline[]> = {};
    for (const [tf, count] of Object.entries(counts)) {
      const ms = demo.tfToMs(tf);
      const lookback = (count + Math.round(86_400_000 / ms) + 2) * ms;
      bars[tf] = await source.range(symbol, tf, opts.from - lookback, opts.to + futureMs);
    }
    const sb: SymbolBars = { symbol, bars };
    const tfBars = bars[opts.tf]!;
    const candidates = tfBars
      .map((k) => k.open_time + tfMs)
      .filter((asOf) => asOf >= opts.from && asOf <= opts.to)
      .filter((asOf) => Object.entries(counts).every(([tf, c]) => sliceVisible(bars[tf]!, asOf, c).length === c) && sliceFuture(tfBars, asOf, horizon + MAX_CHAIN_STEPS * stepBars).length === horizon + MAX_CHAIN_STEPS * stepBars);
    const want = Math.min(perSymbol.get(symbol) ?? 0, candidates.length);
    // Fisher–Yates on a copy, take the first `want` — uniform without replacement, seed-deterministic.
    const pool = [...candidates];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    let picked: number[];
    if ((opts.sample ?? 'uniform') === 'triggers') {
      // Only bars where a scoreable rule fired, drawn in the same shuffled order (so the month is covered
      // rather than the first firing bars being taken) and greedily spaced.
      const spacingMs = (opts.min_spacing_bars ?? DEFAULT_MIN_SPACING_BARS) * tfMs;
      const chosen: number[] = [];
      let scanned = 0;
      let firing = 0;
      for (const asOf of pool) {
        if (chosen.length >= want) break;
        scanned++;
        if (chosen.some((x) => Math.abs(x - asOf) < spacingMs)) continue;
        const kinds = firedScoredKinds(buildTriggerInputs({ symbol, tf: opts.tf, tfKlines: sliceVisible(tfBars, asOf, counts[opts.tf]!), h1Klines: sliceVisible(bars['1h']!, asOf, counts['1h']!), market: null, at: asOf }));
        if (!kinds.length) continue;
        firing++;
        chosen.push(asOf);
      }
      picked = chosen.sort((a, b) => a - b);
      log(`${symbol}: ${candidates.length} candidate as_of, scanned ${scanned} in seeded order, ${firing} fired a scoreable trigger, picked ${picked.length} (spacing ≥ ${opts.min_spacing_bars ?? DEFAULT_MIN_SPACING_BARS} bars)`);
    } else {
      picked = pool.slice(0, want).sort((a, b) => a - b);
      log(`${symbol}: ${candidates.length} candidate as_of, picked ${picked.length}`);
    }
    for (const asOf of picked) {
      const caseRng = seededRng(`${opts.seed}:${symbol}:${asOf}`);
      const oiBase = symbol.startsWith('BTC') ? 80_000 + caseRng() * 20_000 : symbol.startsWith('ETH') ? 2_000_000 + caseRng() * 500_000 : 100_000 + caseRng() * 50_000;
      const params: BaseParams = {
        symbol,
        asOf,
        idx,
        funding: fmtDec(-0.0002 + caseRng() * 0.0006, 8),
        openInterest: fmtDec(oiBase, 3),
        oiChange: caseRng() < 0.25 ? null : Math.round((caseRng() * 5 - 2.5) * 100) / 100,
        withMarketState: idx % 3 === 0,
      };
      const baseId = `${symbol.toLowerCase()}-${opts.tf}-${stamp(asOf)}`;
      const base = scanCase(opts, baseId, ['scan', 'base'], sb, params, null);
      // `trig:<kind>` records which rule made this as_of eligible, computed the way the report replays it.
      if ((opts.sample ?? 'uniform') === 'triggers') base.tags.push(...triggerTags(base));
      out.push(base, staleVariant(base), haltedVariant(base));

      // Mirror: one linear map p → 2p₀ − p over every bar of every tf (and the hidden future).
      const p0 = Number(base.visible.market.last);
      const mirrored: Record<string, Kline[]> = {};
      let ok = true;
      for (const [tf, ks] of Object.entries(bars)) {
        if (mirrorFloor(ks.filter((k) => k.open_time >= asOf - 200 * demo.tfToMs(tf) && k.open_time <= asOf + futureMs), p0) <= 0) ok = false;
        mirrored[tf] = mirrorKlines(ks, p0);
      }
      const msb: SymbolBars = { symbol, bars: mirrored };
      const mirror = ok ? scanCase(opts, `${baseId}-mirror`, ['scan', 'mirror'], msb, params, baseId, base.visible.ticker24h) : null;
      if (mirror && (opts.sample ?? 'uniform') === 'triggers') mirror.tags.push(...triggerTags(mirror));
      if (mirror) out.push(mirror);
      else log(`${baseId}: mirror skipped (would produce non-positive prices)`);

      // Review chains: one thread on the base side, its exact mirror on the mirror side.
      const side: 'long' | 'short' = caseRng() < 0.5 ? 'long' : 'short';
      const entryType: 'market' | 'limit' = caseRng() < 0.5 ? 'market' : 'limit';
      const steps = 2 + (caseRng() < 0.5 ? 1 : 0);
      const atr1h = demo.tfFeatures('1h', base.visible.klines['1h']!).atr14;
      const spec = threadSpec(side, entryType, base.visible.market.last, atr1h, steps);
      const mspec = mirrorSpec(spec, p0);
      for (let n = 1; n <= steps; n++) {
        const stepAt = asOf + n * stepBars * tfMs;
        const stepParams = { ...params, asOf: stepAt, withMarketState: false };
        const scanAt = scanCase(opts, `${baseId}-rev-scan${n}`, [], sb, stepParams, null);
        const rev = reviewCase(opts, base, scanAt, spec, `${baseId}-rev`, n, sb, null);
        out.push(rev);
        if (mirror) {
          const mScanAt = scanCase(opts, `${baseId}-mirror-rev-scan${n}`, [], msb, stepParams, null, scanAt.visible.ticker24h);
          out.push(reviewCase(opts, mirror, mScanAt, mspec, `${baseId}-mirror-rev`, n, msb, rev.id));
        }
      }
      idx++;
    }
  }
  return out;
}
