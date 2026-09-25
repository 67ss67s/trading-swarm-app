/**
 * 回测报告 fixture(契约 research-backtest.json 的 BacktestReport)。后端 §9.46 还在做,
 * 前端先拿这份确定性假数据开发与测试。三种形态:
 *   full          BTC / ETH / BTC+ETH 全部完成,有交易
 *   no_trades     三个资产都完成,但策略一笔没成交(权益平线,持有基准照画)
 *   data_missing  BTC 完成;ETH 数据缺失;BTC+ETH 篮子因 ETH 缺失而失败
 *
 * 口径(与 research-types 的 spec_version 口径一致):收益 / 回撤 / 胜率 / 敞口一律是小数
 * (0.0737 = 7.37%),drawdown 与 max_drawdown 都是正数幅度(契约口径;视图对正负都容错,永远显示成红色负数)。
 * 价格是种子随机游走生成的,不是真实行情 —— 只用于开发与测试。
 */
import type {
  BacktestAsset,
  BacktestEquityPoint,
  BacktestMetrics,
  BacktestPeriodReturn,
  BacktestPlan,
  BacktestPlanEvent,
  BacktestReplay,
  BacktestReport,
  BacktestSegmentMetrics,
  BacktestTrade,
  BacktestTradeStats,
  StrategyIR,
} from '@trading-swarm/contracts';

const DAY = 86_400_000;
const FROM = Date.UTC(2020, 0, 1);
const TO = Date.UTC(2026, 8, 1);
const SPLIT = Date.UTC(2024, 8, 1); // 样本内 2020-01 → 2024-09,样本外 2024-09 → 2026-09
const INITIAL_CASH = 10_000;
const FEE_RATE = 0.0005;

/** mulberry32:确定性伪随机,测试每次拿到同一份数据。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number): number {
  const u = Math.max(1e-9, r());
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function makePrices(seed: number, start: number, drift: number, vol: number, n: number): number[] {
  const r = rng(seed);
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    // 加一点慢周期,让均线交叉有趋势段可抓
    const cyc = Math.sin(i / 90) * 0.004;
    p = p * Math.exp(drift + cyc + vol * gauss(r));
    out.push(p);
  }
  return out;
}

function sma(xs: number[], n: number, i: number): number | null {
  if (i + 1 < n) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += xs[k]!;
  return s / n;
}

interface Sim {
  equity: BacktestEquityPoint[];
  trades: BacktestTrade[];
}

/** 20/60 日均线金叉做多、死叉或 -8% 止损离场;enabled=false 时一笔不做(no_trades 形态)。 */
function simulate(symbol: string, times: number[], prices: number[], enabled: boolean): Sim {
  const equity: BacktestEquityPoint[] = [];
  const trades: BacktestTrade[] = [];
  let cash = INITIAL_CASH;
  let qty = 0;
  let entry: { at: number; price: number; idx: number; fee: number } | null = null;
  let peak = INITIAL_CASH;
  const p0 = prices[0]!;
  let seq = 0;
  for (let i = 0; i < prices.length; i++) {
    const price = prices[i]!;
    const at = times[i]!;
    const fast = sma(prices, 20, i);
    const slow = sma(prices, 60, i);
    const pf = sma(prices, 20, i - 1);
    const ps = sma(prices, 60, i - 1);
    if (enabled && fast !== null && slow !== null && pf !== null && ps !== null) {
      if (!entry && pf <= ps && fast > slow) {
        const fee = cash * FEE_RATE;
        qty = (cash - fee) / price;
        entry = { at, price, idx: i, fee };
        cash = 0;
      } else if (entry) {
        const stop = price <= entry.price * 0.92;
        const cross = pf >= ps && fast < slow;
        if (stop || cross || i === prices.length - 1) {
          const gross = qty * price;
          const fee = gross * FEE_RATE;
          const cost = qty * entry.price + entry.fee;
          cash = gross - fee;
          trades.push({
            id: `${symbol}-${++seq}`,
            symbol,
            side: 'long',
            entry_at: entry.at,
            entry_price: round(entry.price, 2),
            exit_at: at,
            exit_price: round(price, 2),
            qty: round(qty, 6),
            pnl: round(cash - cost, 2),
            return_pct: round(cash / cost - 1, 6),
            fees: round(fee + entry.fee, 2),
            bars_held: i - entry.idx,
            exit_reason: stop ? 'stop_loss' : cross ? 'signal_exit' : 'end_of_data',
            segment: entry.at >= SPLIT ? 'out_of_sample' : 'in_sample',
          });
          qty = 0;
          entry = null;
        }
      }
    }
    const eq = cash + qty * price;
    peak = Math.max(peak, eq);
    equity.push({
      at,
      equity: round(eq, 2),
      pnl_pct: round(eq / INITIAL_CASH - 1, 6),
      drawdown: round(1 - eq / peak, 6),
      benchmark_pct: round(price / p0 - 1, 6),
      exposure: qty > 0 ? 1 : 0,
    });
  }
  return { equity, trades };
}

function round(v: number, d: number): number {
  const k = 10 ** d;
  return Math.round(v * k) / k;
}

/** 等权篮子:两条权益曲线按 pnl 平均,交易合并。 */
function basket(a: Sim, b: Sim): Sim {
  const equity: BacktestEquityPoint[] = [];
  let peak = INITIAL_CASH;
  for (let i = 0; i < a.equity.length; i++) {
    const x = a.equity[i]!;
    const y = b.equity[i]!;
    const pnl = (x.pnl_pct + y.pnl_pct) / 2;
    const eq = INITIAL_CASH * (1 + pnl);
    peak = Math.max(peak, eq);
    equity.push({
      at: x.at,
      equity: round(eq, 2),
      pnl_pct: round(pnl, 6),
      drawdown: round(1 - eq / peak, 6),
      benchmark_pct: round(((x.benchmark_pct ?? 0) + (y.benchmark_pct ?? 0)) / 2, 6),
      exposure: (x.exposure + y.exposure) / 2,
    });
  }
  const half = (t: BacktestTrade): BacktestTrade => ({ ...t, qty: round(t.qty / 2, 6), pnl: round(t.pnl / 2, 2), fees: round(t.fees / 2, 2) });
  const trades = [...a.trades.map(half), ...b.trades.map(half)].sort((p, q) => p.entry_at - q.entry_at);
  return { equity, trades };
}

function dailyReturns(eq: BacktestEquityPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < eq.length; i++) out.push(eq[i]!.equity / eq[i - 1]!.equity - 1);
  return out;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

function streaks(trades: BacktestTrade[]): { win: number; loss: number } {
  let win = 0;
  let loss = 0;
  let w = 0;
  let l = 0;
  for (const t of trades) {
    if (t.pnl > 0) {
      w++;
      l = 0;
    } else {
      l++;
      w = 0;
    }
    win = Math.max(win, w);
    loss = Math.max(loss, l);
  }
  return { win, loss };
}

function metricsOf(eq: BacktestEquityPoint[], trades: BacktestTrade[]): BacktestMetrics {
  const first = eq[0]!;
  const last = eq[eq.length - 1]!;
  const years = (last.at - first.at) / (365.25 * DAY);
  const total = last.equity / INITIAL_CASH - 1;
  const rets = dailyReturns(eq);
  const s = std(rets);
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const downside = std(rets.filter((r) => r < 0));
  const maxDd = eq.reduce((m, p) => Math.max(m, p.drawdown), 0);
  // 最长回撤时长:连续 drawdown>0 的最长区间
  let longest = 0;
  let startAt: number | null = null;
  for (const p of eq) {
    if (p.drawdown > 1e-9) {
      if (startAt === null) startAt = p.at;
      longest = Math.max(longest, p.at - startAt);
    } else startAt = null;
  }
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.return_pct, 0) / wins.length : null;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.return_pct, 0) / losses.length : null;
  const bench = last.benchmark_pct;
  const cagr = years > 0 && total > -1 ? (1 + total) ** (1 / years) - 1 : null;
  const st = streaks(trades);
  const has = trades.length > 0;
  return {
    total_return: round(total, 6),
    cagr: cagr === null ? null : round(cagr, 6),
    max_drawdown: round(maxDd, 6),
    sharpe: has && s > 0 ? round((mean / s) * Math.sqrt(365), 4) : null,
    sortino: has && downside > 0 ? round((mean / downside) * Math.sqrt(365), 4) : null,
    calmar: has && cagr !== null && maxDd > 0 ? round(cagr / maxDd, 4) : null,
    volatility: has ? round(s * Math.sqrt(365), 6) : null,
    win_rate: has ? round(wins.length / trades.length, 6) : null,
    profit_factor: has && grossLoss > 0 ? round(grossWin / grossLoss, 4) : null,
    avg_win: avgWin === null ? null : round(avgWin, 6),
    avg_loss: avgLoss === null ? null : round(avgLoss, 6),
    risk_reward: avgWin !== null && avgLoss !== null && avgLoss !== 0 ? round(avgWin / Math.abs(avgLoss), 4) : null,
    expectancy: has ? round(trades.reduce((a, t) => a + t.return_pct, 0) / trades.length, 6) : null,
    max_win_streak: st.win,
    max_loss_streak: st.loss,
    time_in_drawdown: round(eq.filter((p) => p.drawdown > 1e-9).length / eq.length, 6),
    max_drawdown_duration_ms: longest,
    trades: trades.length,
    exposure: round(eq.reduce((a, p) => a + p.exposure, 0) / eq.length, 6),
    time_in_market: round(eq.filter((p) => p.exposure > 0).length / eq.length, 6),
    avg_holding_ms: has ? round((trades.reduce((a, t) => a + (t.exit_at - t.entry_at), 0) / trades.length), 0) : null,
    best_trade: has ? Math.max(...trades.map((t) => t.return_pct)) : null,
    worst_trade: has ? Math.min(...trades.map((t) => t.return_pct)) : null,
    net_pnl: round(last.equity - INITIAL_CASH, 2),
    fees: round(trades.reduce((a, t) => a + t.fees, 0), 2),
    benchmark_return: bench,
    excess_return: bench === null ? null : round(total - bench, 6),
    alpha: has ? round(total - 0.35 * (bench ?? 0), 6) : null,
    beta: has ? 0.35 : null,
  };
}

function periodReturns(eq: BacktestEquityPoint[], key: (d: Date) => string): BacktestPeriodReturn[] {
  const out: BacktestPeriodReturn[] = [];
  let cur: string | null = null;
  let startEq = INITIAL_CASH;
  let startBench = 0;
  let prev: BacktestEquityPoint | null = null;
  const flush = (end: BacktestEquityPoint) => {
    out.push({
      period: cur!,
      return: round(end.equity / startEq - 1, 6),
      benchmark: end.benchmark_pct === null ? null : round((1 + end.benchmark_pct) / (1 + startBench) - 1, 6),
    });
  };
  for (const p of eq) {
    const k = key(new Date(p.at));
    if (k !== cur) {
      if (cur !== null && prev) flush(prev);
      cur = k;
      startEq = prev ? prev.equity : INITIAL_CASH;
      startBench = prev?.benchmark_pct ?? 0;
    }
    prev = p;
  }
  if (cur !== null && prev) flush(prev);
  return out;
}

function histogram(values: number[], edges: number[]): { bins: number[]; counts: number[] } {
  const counts = new Array(edges.length - 1).fill(0) as number[];
  for (const v of values) {
    let k = edges.findIndex((e, i) => i < edges.length - 1 && v >= e && v < edges[i + 1]!);
    if (k < 0) k = v < edges[0]! ? 0 : edges.length - 2;
    counts[k]!++;
  }
  return { bins: edges, counts };
}

function tradeStats(trades: BacktestTrade[]): BacktestTradeStats | null {
  if (!trades.length) return null;
  const exit_reasons: Record<string, number> = {};
  for (const t of trades) exit_reasons[t.exit_reason] = (exit_reasons[t.exit_reason] ?? 0) + 1;
  return {
    exit_reasons,
    holding_histogram: histogram(trades.map((t) => t.bars_held), [0, 5, 10, 20, 40, 80, 160, 320]),
    return_histogram: histogram(trades.map((t) => t.return_pct), [-0.12, -0.08, -0.04, 0, 0.04, 0.08, 0.16, 0.32, 0.64]),
    long_trades: trades.filter((t) => t.side === 'long').length,
    short_trades: trades.filter((t) => t.side === 'short').length,
  };
}

function segmentsOf(sim: Sim): BacktestSegmentMetrics[] {
  const cut = sim.equity.findIndex((p) => p.at >= SPLIT);
  const inEq = sim.equity.slice(0, cut + 1);
  // 样本外单独从 1 起算,不然样本内的收益会被算进去
  const base = sim.equity[cut]!;
  let peak = INITIAL_CASH;
  const outEq = sim.equity.slice(cut).map((p) => {
    const eq = (p.equity / base.equity) * INITIAL_CASH;
    peak = Math.max(peak, eq);
    return { ...p, equity: eq, pnl_pct: eq / INITIAL_CASH - 1, drawdown: 1 - eq / peak, benchmark_pct: p.benchmark_pct === null || base.benchmark_pct === null ? null : (1 + p.benchmark_pct) / (1 + base.benchmark_pct) - 1 };
  });
  let inPeak = INITIAL_CASH;
  const inEqNorm = inEq.map((p) => {
    inPeak = Math.max(inPeak, p.equity);
    return { ...p, drawdown: 1 - p.equity / inPeak };
  });
  return [
    { name: 'in_sample', from_ms: FROM, to_ms: SPLIT, metrics: metricsOf(inEqNorm, sim.trades.filter((t) => t.segment === 'in_sample')) },
    { name: 'out_of_sample', from_ms: SPLIT, to_ms: TO, metrics: metricsOf(outEq, sim.trades.filter((t) => t.segment === 'out_of_sample')) },
  ];
}

function completedAsset(key: string, label: string, kind: 'single' | 'basket', symbols: string[], sim: Sim, bars: number): BacktestAsset {
  const ym = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const y = (d: Date) => String(d.getUTCFullYear());
  return {
    key,
    label,
    kind,
    symbols: symbols as BacktestAsset['symbols'],
    status: 'completed',
    error: null,
    metrics: metricsOf(sim.equity, sim.trades),
    segments: segmentsOf(sim) as BacktestAsset['segments'],
    equity: sim.equity,
    trades: sim.trades,
    monthly_returns: periodReturns(sim.equity, ym),
    yearly_returns: periodReturns(sim.equity, y),
    trade_stats: tradeStats(sim.trades),
    data: {
      source: 'okx:history-candles',
      first_at: sim.equity[0]!.at,
      last_at: sim.equity[sim.equity.length - 1]!.at,
      bars,
      timeframe: '1d',
      dataset_id: `ds_fixture_${key.replace(/[^A-Za-z]/g, '').toLowerCase()}_1d`,
      snapshot_id: null,
      warmup_bars: 60,
      warmup_borrowed: false,
      trading_from_ms: sim.equity[59]?.at ?? sim.equity[0]!.at,
    },
    window: { from_ms: sim.equity[59]?.at ?? sim.equity[0]!.at, to_ms: sim.equity[sim.equity.length - 1]!.at },
    plans: [],
    plan_stats: null,
    engine_version: 'bar-executor/1.0.0',
  };
}

function missingAsset(key: string, label: string, kind: 'single' | 'basket', symbols: string[], status: 'failed' | 'data_missing', error: string): BacktestAsset {
  return {
    key,
    label,
    kind,
    symbols: symbols as BacktestAsset['symbols'],
    status,
    error,
    metrics: null,
    segments: [],
    equity: [],
    trades: [],
    monthly_returns: [],
    yearly_returns: [],
    trade_stats: null,
    data: null,
  };
}

const IR: StrategyIR = {
  version: 1,
  label: 'BTC/ETH 日线均线交叉',
  description: '20/60 日均线金叉做多,死叉或 -8% 止损离场',
  signal: [{ primitive: 'ma_cross', params: { fast: 20, slow: 60 } }],
  entry: { primitive: 'market_next_open', params: {} },
  risk: { stop: { primitive: 'fixed_pct_stop', params: { pct: 0.08 } }, sizing: { primitive: 'full_equity', params: {} } },
  exit: [{ primitive: 'ma_cross_down', params: { fast: 20, slow: 60 } }],
};

export type FixtureVariant = 'full' | 'no_trades' | 'data_missing';

interface FixtureSeries {
  n: number;
  times: number[];
  prices: Record<string, number[]>;
}
let seriesCache: FixtureSeries | null = null;
function fixtureSeries(): FixtureSeries {
  if (seriesCache) return seriesCache;
  const n = Math.round((TO - FROM) / DAY) + 1;
  const times = Array.from({ length: n }, (_, i) => FROM + i * DAY);
  seriesCache = { n, times, prices: { 'BTC-USDT-SWAP': makePrices(11, 7200, 0.0004, 0.029, n), 'ETH-USDT-SWAP': makePrices(29, 130, 0.0005, 0.038, n) } };
  return seriesCache;
}

// ---------------------------------------------------------------------------
// 逐笔计划(research-orders.json 的 BacktestPlan):每笔成交配一个已成交计划,空档里补未成交 / 被替换的挂单

function idxOf(times: number[], at: number): number {
  return Math.max(0, Math.min(times.length - 1, Math.round((at - FROM) / DAY)));
}

function plansFor(symbol: string, trades: BacktestTrade[], allowFills: boolean): BacktestPlan[] {
  const { times, prices } = fixtureSeries();
  const px = prices[symbol]!;
  const plans: BacktestPlan[] = [];
  const mine = trades.filter((t) => t.symbol === symbol).sort((a, b) => a.entry_at - b.entry_at);
  let seq = 0;
  const nextId = () => `${symbol.split('-')[0]}-P${++seq}`;
  const base = (at: number) => ({ symbol, side: 'long' as const, market: 'perp' as const, leverage: 1, placed_at: at, segment: (at >= SPLIT ? 'out_of_sample' : 'in_sample') as BacktestPlan['segment'] });
  // 空档里的未成交挂单
  const idle = (from: number, to: number) => {
    if (to - from < 40 * DAY) return;
    const at = from + Math.floor((to - from) / 2 / DAY) * DAY;
    const i = idxOf(times, at);
    const ref = px[i]!;
    const entry = round(ref * 0.93, 2);
    const expires = at + 5 * DAY;
    const id = nextId();
    const replaced = seq % 3 === 0;
    const events: BacktestPlanEvent[] = [
      { at, kind: 'placed', price: entry, note: '回踩 7% 限价挂单' },
      replaced ? { at: at + 3 * DAY, kind: 'replaced', price: null, note: '信号更新,换新计划' } : { at: expires, kind: 'no_fill', price: null, note: '有效期内未触及' },
    ];
    plans.push({
      ...base(at),
      id,
      reason: '均线多头排列,等回踩',
      entry_type: 'limit',
      entry_price: entry,
      reference_price: round(ref, 2),
      expires_at: expires,
      status: replaced ? 'replaced' : 'no_fill',
      filled_at: null,
      fill_price: null,
      fill_gap: false,
      legs: [],
      stop: { price: round(entry * 0.92, 2), size_pct: 1, source: 'fixed_pct', note: '-8%', filled_at: null, fill_price: null },
      take_profits: [{ price: round(entry * 1.1, 2), size_pct: 0.5, source: 'rr', note: '1.25R', filled_at: null, fill_price: null }],
      stop_path: [],
      planned_rr: 1.25,
      min_rr: 1,
      exit: null,
      pnl_pct: null,
      r_multiple: null,
      mfe_pct: null,
      mae_pct: null,
      funding_pct: null,
      fees_pct: 0,
      bars_held: 0,
      rolled_from: null,
      rolled_to: null,
      replaced_by: null,
      events,
    });
    if (replaced) {
      // 替换出来的新计划同样没成交
      const at2 = at + 3 * DAY;
      const e2 = round(px[idxOf(times, at2)]! * 0.95, 2);
      const id2 = nextId();
      plans[plans.length - 1]!.replaced_by = id2;
      plans.push({
        ...plans[plans.length - 1]!,
        id: id2,
        placed_at: at2,
        entry_price: e2,
        reference_price: round(px[idxOf(times, at2)]!, 2),
        expires_at: at2 + 5 * DAY,
        status: 'no_fill',
        replaced_by: null,
        stop: { price: round(e2 * 0.92, 2), size_pct: 1, source: 'fixed_pct', note: '-8%', filled_at: null, fill_price: null },
        take_profits: [{ price: round(e2 * 1.1, 2), size_pct: 0.5, source: 'rr', note: '1.25R', filled_at: null, fill_price: null }],
        events: [
          { at: at2, kind: 'placed', price: e2, note: '替换 ' + id },
          { at: at2 + 5 * DAY, kind: 'no_fill', price: null, note: '有效期内未触及' },
        ],
      });
    }
  };
  let prevEnd = FROM + 60 * DAY;
  for (const tr of allowFills ? mine : []) {
    idle(prevEnd, tr.entry_at - 2 * DAY);
    const placed = tr.entry_at - 2 * DAY;
    const ei = idxOf(times, tr.entry_at);
    const xi = idxOf(times, tr.exit_at);
    const entry = tr.entry_price;
    const stop = round(entry * 0.92, 2);
    const risk = entry - stop;
    const tp1 = round(entry * 1.1, 2);
    const tp2 = round(entry * 1.25, 2);
    let hi = entry;
    let lo = entry;
    let tp1At: number | null = null;
    let tp2At: number | null = null;
    for (let i = ei; i <= xi; i++) {
      const p = px[i]!;
      hi = Math.max(hi, p);
      lo = Math.min(lo, p);
      if (tp1At === null && p >= tp1) tp1At = times[i]!;
      if (tp2At === null && p >= tp2) tp2At = times[i]!;
    }
    const reason = tr.exit_reason === 'stop_loss' ? 'sl' : tr.exit_reason === 'end_of_data' ? 'end_of_data' : tr.exit_reason === 'signal_exit' ? 'signal_exit' : 'signal_exit';
    const events: BacktestPlanEvent[] = [
      { at: placed, kind: 'placed', price: entry, note: '金叉确认,限价挂在前一根收盘附近' },
      { at: tr.entry_at, kind: 'filled', price: entry, note: '' },
    ];
    const stopPath = [{ at: tr.entry_at, price: stop }];
    if (tp1At !== null && tp1At < tr.exit_at) {
      events.push({ at: tp1At, kind: 'tp_hit', price: tp1, note: 'TP1 减半仓' });
      events.push({ at: tp1At, kind: 'stop_moved', price: entry, note: '止损上移到保本' });
      stopPath.push({ at: tp1At, price: entry });
    }
    if (tp2At !== null && tp2At < tr.exit_at) events.push({ at: tp2At, kind: 'tp_hit', price: tp2, note: 'TP2' });
    const fundingDays = Math.max(0, xi - ei);
    events.push({ at: tr.entry_at + Math.floor(fundingDays / 2) * DAY, kind: 'funding', price: null, note: `资金费累计 ${(fundingDays * 0.03).toFixed(2)}%` });
    events.push({ at: tr.exit_at, kind: reason === 'sl' ? 'sl_hit' : 'closed', price: tr.exit_price, note: tr.exit_reason });
    events.sort((a, b) => a.at - b.at);
    plans.push({
      ...base(placed),
      id: nextId(),
      reason: '20/60 金叉',
      entry_type: 'limit',
      entry_price: entry,
      reference_price: round(px[idxOf(times, placed)]!, 2),
      expires_at: placed + 5 * DAY,
      status: 'filled',
      filled_at: tr.entry_at,
      fill_price: entry,
      fill_gap: false,
      legs: [{ at: tr.entry_at, price: entry, qty_frac: 1 }],
      stop: { price: stop, size_pct: 1, source: 'fixed_pct', note: '-8%', filled_at: reason === 'sl' ? tr.exit_at : null, fill_price: reason === 'sl' ? tr.exit_price : null },
      take_profits: [
        { price: tp1, size_pct: 0.5, source: 'rr', note: '1.25R', filled_at: tp1At !== null && tp1At < tr.exit_at ? tp1At : null, fill_price: tp1At !== null && tp1At < tr.exit_at ? tp1 : null },
        { price: tp2, size_pct: 0.5, source: 'structure_resistance', note: '前高', filled_at: tp2At !== null && tp2At < tr.exit_at ? tp2At : null, fill_price: tp2At !== null && tp2At < tr.exit_at ? tp2 : null },
      ] as BacktestPlan['take_profits'],
      stop_path: stopPath,
      planned_rr: round((tp1 - entry) / risk, 4),
      min_rr: 1,
      exit: { at: tr.exit_at, price: tr.exit_price, reason },
      pnl_pct: tr.return_pct,
      r_multiple: round((tr.exit_price - entry) / risk, 4),
      mfe_pct: round(hi / entry - 1, 6),
      mae_pct: round(lo / entry - 1, 6),
      funding_pct: round(-fundingDays * 0.0003, 6),
      fees_pct: 0.001,
      bars_held: tr.bars_held,
      rolled_from: null,
      rolled_to: null,
      replaced_by: null,
      events,
    });
    prevEnd = tr.exit_at + DAY;
  }
  idle(prevEnd, TO);
  if (!allowFills) {
    // 无成交形态:整段只挂出、全部未成交
    for (let at = FROM + 120 * DAY; at < TO - 60 * DAY; at += 200 * DAY) idle(at, at + 60 * DAY);
  }
  return plans.sort((a, b) => a.placed_at - b.placed_at);
}

function withPlans(asset: BacktestAsset, plans: BacktestPlan[]): BacktestAsset {
  asset.plans = plans;
  asset.plan_stats = null; // 故意留空:视图在没有 plan_stats 时按 plans 现算
  return asset;
}

/** fixture 版 GET /api/research/backtests/:id/replay(同一份种子行情,UTC 日线)。 */
export function makeFixtureReplay(report: BacktestReport, assetKey: string, from_ms?: number, to_ms?: number): BacktestReplay {
  const { times, prices } = fixtureSeries();
  const asset = report.assets.find((a) => a.key === assetKey);
  const symbol = asset?.symbols[0] ?? 'BTC-USDT-SWAP';
  const px = prices[symbol] ?? prices['BTC-USDT-SWAP']!;
  const r = rng(symbol.length * 7 + 3);
  const lo = from_ms ?? report.window.from_ms;
  const hi = to_ms ?? report.window.to_ms;
  const candles: BacktestReplay['candles'] = [];
  for (let i = 0; i < times.length; i++) {
    const at = times[i]!;
    const c = px[i]!;
    const o = i ? px[i - 1]! : c;
    const wick = 0.004 + r() * 0.018;
    if (at < lo || at > hi) continue;
    candles.push({ t: at, o: round(o, 2), h: round(Math.max(o, c) * (1 + wick), 2), l: round(Math.min(o, c) * (1 - wick * 0.9), 2), c: round(c, 2), v: round(1000 + r() * 9000, 0) });
  }
  const plans = (asset?.plans ?? []).filter((p) => p.symbol === symbol && p.placed_at <= hi && (p.exit?.at ?? p.expires_at ?? p.placed_at) >= lo);
  return { report_id: report.id, asset_key: assetKey, symbol, timeframe: report.timeframe, from_ms: lo, to_ms: hi, truncated: false, candles, plans };
}

export function makeFixtureReport(variant: FixtureVariant = 'full'): BacktestReport {
  const { n, times, prices } = fixtureSeries();
  const btcP = prices['BTC-USDT-SWAP']!;
  const ethP = prices['ETH-USDT-SWAP']!;
  const enabled = variant !== 'no_trades';
  const btc = simulate('BTC-USDT-SWAP', times, btcP, enabled);
  const eth = simulate('ETH-USDT-SWAP', times, ethP, enabled);
  const both = basket(btc, eth);

  const assets: BacktestAsset[] =
    variant === 'data_missing'
      ? [
          completedAsset('BTC', 'BTC', 'single', ['BTC-USDT-SWAP'], btc, n),
          missingAsset('ETH', 'ETH', 'single', ['ETH-USDT-SWAP'], 'data_missing', 'ETH-USDT-SWAP 在 2020-01-01 → 2026-09-01 缺 1d K 线(本地缓存只覆盖到 2022-12-31),未拉取'),
          missingAsset('BTC+ETH', 'BTC+ETH', 'basket', ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'], 'failed', '篮子依赖的 ETH 数据缺失,整篮不计算'),
        ]
      : [
          completedAsset('BTC', 'BTC', 'single', ['BTC-USDT-SWAP'], btc, n),
          completedAsset('ETH', 'ETH', 'single', ['ETH-USDT-SWAP'], eth, n),
          completedAsset('BTC+ETH', 'BTC+ETH', 'basket', ['BTC-USDT-SWAP', 'ETH-USDT-SWAP'], both, n),
        ];
  // 逐笔计划:单资产各自一份,篮子是两者合并
  const btcPlans = plansFor('BTC-USDT-SWAP', btc.trades, enabled);
  const ethPlans = plansFor('ETH-USDT-SWAP', eth.trades, enabled);
  withPlans(assets[0]!, btcPlans);
  if (assets[1]!.status === 'completed') withPlans(assets[1]!, ethPlans);
  if (assets[2]!.status === 'completed') withPlans(assets[2]!, [...btcPlans, ...ethPlans].sort((a, b) => a.placed_at - b.placed_at));

  const primary = assets.find((a) => a.key === 'BTC+ETH' && a.status === 'completed') ?? assets[0]!;
  const tradesN = primary.metrics?.trades ?? 0;
  const lowConf = variant !== 'full';
  return {
    id: `bt_fixture_${variant}`,
    created_at: Date.UTC(2026, 8, 22, 9, 30),
    engine_version: 'research-backtest/1.0.0',
    title: 'BTC/ETH 日线均线交叉',
    description: '20/60 日均线金叉做多,死叉或 -8% 止损离场,下一根 K 线开盘成交。',
    strategy_ir_hash: 'sha256:9f2c1e7ab04d5c3e',
    strategy_ir: IR,
    timeframe: '1d',
    window: { from_ms: FROM, to_ms: TO },
    segments: [
      { name: 'in_sample', from_ms: FROM, to_ms: SPLIT },
      { name: 'out_of_sample', from_ms: SPLIT, to_ms: TO },
    ],
    execution: { initial_cash: INITIAL_CASH, fee_rate: FEE_RATE, slippage_bps: 2, sizing_mode: 'full_equity', fill_model: 'next_bar_open', basket_weighting: 'equal_weight_daily_rebalance', market: 'perp', leverage: 1, view_bars: 'full_history' },
    primary_key: primary.key,
    assets: assets as BacktestReport['assets'],
    score: {
      value: variant === 'full' ? 58 : variant === 'no_trades' ? 0 : 41,
      label: variant === 'full' ? 'fair' : variant === 'no_trades' ? 'poor' : 'needs_work',
      confidence: lowConf ? 'low' : 'medium',
      confidence_reason: variant === 'no_trades' ? '0 笔成交,无法评估' : variant === 'data_missing' ? `仅 BTC 可算,${tradesN} 笔成交` : `${tradesN} 笔成交,样本外 2 年`,
      components: [
        { key: 'return', value: variant === 'no_trades' ? 0 : 62, weight: 0.3, note: '全窗口收益与 CAGR' },
        { key: 'risk', value: variant === 'no_trades' ? 0 : 48, weight: 0.3, note: '最大回撤与回撤时长' },
        { key: 'consistency', value: variant === 'no_trades' ? 0 : 55, weight: 0.2, note: '样本内外一致性' },
        { key: 'edge', value: variant === 'no_trades' ? 0 : 66, weight: 0.2, note: '相对持有基准的超额' },
      ],
    },
    run_ids: ['run_fixture_btc', 'run_fixture_eth'],
    inquiry_id: null,
    session_id: null,
    strategy_id: 'strat_fixture',
    strategy_version: 1,
    warnings: variant === 'data_missing' ? ['ETH 数据缺失,BTC+ETH 篮子未计算'] : [],
  };
}

export const FIXTURE_FULL = makeFixtureReport('full');
export const FIXTURE_NO_TRADES = makeFixtureReport('no_trades');
export const FIXTURE_DATA_MISSING = makeFixtureReport('data_missing');
