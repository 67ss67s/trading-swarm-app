/** 离线零模型归因。I/O 留给 scripts/trader-study.mjs；不引用策略库或运行 DB。 */
import type { Kline, Direction } from "./types.js";
import { atr, dailyRegime } from "./market.js";
import {
  conservativeLimitFill,
  openTrade,
  stepTrade,
  tradeCosts,
  tradeR,
} from "./outcome.js";
import {
  DAY,
  anchoredWalkForward,
  effectiveReturns,
  bootstrapCI,
  summarizeReplay,
  selectWalkForward,
  validKline,
  type ReplaySample,
} from "./replay-stats.js";
import {
  TRADER_GRID,
  TRADER_SIGNAL_REGISTRY,
  HUMAN_SIGNAL_REGISTRY,
} from "./trader-signals.js";
import type { SignalContext } from "./strategy-signals.js";
export const MINUTE = 60000,
  HOUR = 3600000;
export const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const finite = (x: unknown): number | null =>
  x !== null && x !== undefined && Number.isFinite(Number(x)) && Number(x) > 0
    ? Number(x)
    : null;
export interface RawMessage {
  id: number;
  source_message_id: string;
  raw_text: string;
  received_at: string;
  trader: string;
}
export interface BridgeSignal {
  id: number;
  symbol: string;
  side: string;
  entry: string;
  stop_loss: string;
  take_profit: string;
  metadata: string;
  raw_payload: string;
  raw_text: string;
  received_at: string;
}
export interface Plan {
  id: number;
  raw_id: number;
  source_id: string;
  trader: string;
  symbol: string;
  direction: Direction;
  action: string;
  at: number;
  received_at: number;
  time_source: string;
  raw_text: string;
  levels: number[];
  market_first: boolean;
  stop: number | null;
  targets: { price: number; weight: number }[];
  break_even: boolean;
  flags: string[];
  excluded: string | null;
}
export interface MarketData {
  bars: Record<string, Kline[]>;
  funding: { at: number; rate: string }[];
  tick: number | null;
}
export function closedAt(bars: Kline[], at: number, count = 260): Kline[] {
  let lo = 0,
    hi = bars.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (bars[m]!.close_time <= at) lo = m + 1;
    else hi = m;
  }
  return bars.slice(Math.max(0, lo - count), lo);
}
export function forward(bars: Kline[], at: number, hours: number): Kline[] {
  if (!bars.length) return [];
  const step = bars[0]!.close_time - bars[0]!.open_time + 1;
  let lo = 0,
    hi = bars.length;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (bars[m]!.open_time < at) lo = m + 1;
    else hi = m;
  }
  const n = (hours * HOUR) / step,
    xs = bars.slice(lo, lo + n);
  return Number.isInteger(n) &&
    xs.length === n &&
    xs[0]!.open_time - at < step &&
    xs.every(
      (b, i) =>
        validKline(b) &&
        b.open_time === xs[0]!.open_time + i * step &&
        b.close_time === b.open_time + step - 1,
    )
    ? xs
    : [];
}
const decode = (s: string) =>
  s.replace(/\\u([a-f\d]{4})/gi, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
export interface SignalCorrection {
  raw_id: number;
  levels?: string[];
  excluded?: string;
  reason: string;
}
export function normalizeSignals(
  raw: RawMessage[],
  signals: BridgeSignal[],
  corrections: Record<string, SignalCorrection> = {},
): Plan[] {
  const index = new Map(raw.map((r) => [r.source_message_id, r])),
    seen = new Map<string, number>();
  const rows: Plan[] = [];
  for (const s of signals) {
    const m = JSON.parse(s.metadata);
    if (!["open", "add"].includes(m.action_type)) continue;
    const source = String(m.candidate_id ?? m.source_message_ids?.[0] ?? ""),
      r = index.get(source),
      text = r?.raw_text ?? s.raw_text;
    const payload = JSON.parse(s.raw_payload),
      received = Date.parse(
        (r?.received_at ?? s.received_at).replace(" ", "T") + "Z",
      );
    const embedded = text.match(
      /📅\s*(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s*\(Beijing\)/,
    );
    const original = Number(payload.message?.create_time);
    const at = embedded
      ? Date.parse(embedded[1]!.replace(" ", "T") + "+08:00")
      : Number.isFinite(original) && original > 0
        ? original
        : received;
    const sections = [...text.matchAll(/(?:^|\n)(BTC|ETH|SOL)\s+[^\n]*/g)];
    const section = sections.find((x) => s.symbol === x[1] + "USDT");
    const planText = section
      ? text.slice(
          section.index,
          sections.find((x) => x.index! > section.index!)?.index ?? text.length,
        )
      : text;
    const entry = JSON.parse(s.entry),
      sl = JSON.parse(s.stop_loss),
      tp = JSON.parse(s.take_profit) ?? [];
    let prices: number[] = (entry?.prices ?? [entry?.price])
      .map(finite)
      .filter((x: number | null): x is number => x !== null);
    const ladder = /再挂|第二笔|第一笔|分批入场/.test(planText),
      market =
        /市价.*(?:直接|做多|做空)|\d+\s*市价|市价\d|\d+附近直接(?:多|空|进)/.test(
          planText,
        ) || entry?.type === "market";
    const flags: string[] = [];
    if (!r) flags.push("missing_raw_link");
    if (received - at > 5 * MINUTE) flags.push("delayed_forward");
    if (/买了|买回|加了|加回|开了|接回了/.test(text))
      flags.push("completed_trade_notice");
    if (entry?.type === "zone" && !ladder && prices.length)
      prices = [mean(prices)!];
    if (ladder) flags.push("ladder_equal_risk_proxy");
    if (entry?.type === "zone" && !ladder) flags.push("zone_midpoint_proxy");
    if (market && entry?.type !== "market") flags.push("raw_market_override");
    const targets = tp.flatMap((x: { price?: number; size_pct?: number }) =>
      finite(x.price)
        ? [{ price: Number(x.price), weight: Number(x.size_pct ?? 0) }]
        : [],
    );
    const sum = targets.reduce(
      (n: number, t: { weight: number }) => n + t.weight,
      0,
    );
    if (targets.length)
      for (const t of targets)
        t.weight =
          sum >= 0.95 &&
          sum <= 1.05 &&
          targets.every((x: { weight: number }) => x.weight > 0)
            ? t.weight / sum
            : 1 / targets.length;
    const firstWeight = planText.match(
      /第一止盈[^\n]*(?:止盈|走)\s*(\d+(?:\.\d+)?)%/,
    );
    const alternativeTarget = planText.match(
      /第一止盈[^\n]*?[（(][^\n]*?(\d+(?:\.\d+)?)\s*止盈\s*70%/,
    );
    if (alternativeTarget) {
      flags.push("ambiguous_tp_weight");
    }
    if (firstWeight && targets.length && !alternativeTarget) {
      const w = Number(firstWeight[1]) / 100;
      if (w > 0 && w <= 1) {
        targets[0].weight = targets.length === 1 ? 1 : w;
        for (let i = 1; i < targets.length; i++)
          targets[i].weight = (1 - w) / (targets.length - 1);
        flags.push("raw_tp_weight_override");
      }
    }
    if (/全部止盈/.test(planText) && targets.length > 1)
      flags.push("alternative_exit_instruction");
    if (/小幅.*(?:跌破|涨破)|止损.*一点/.test(planText))
      flags.push("stop_boundary_proxy");
    const trader = r?.trader ?? decode(String(m.trader)),
      direction = s.side === "long" ? "long" : "short";
    const head = text.split(/Captain Hook/)[0]!.slice(0, 250);
    let excluded = !["long", "short"].includes(s.side)
      ? "invalid_side"
      : !r
        ? "missing_raw_link"
        : /已经.*止盈|恭喜|连胜.*止盈|止盈.*利润|利润.*止盈|昨天.*(?:做空|做多|止盈)|汇报利润|加仓.*策略.*(?:快到|到了).*止盈|现价止盈\s*\d|第一目标也到了|汇报你的.*利润/.test(
              head,
            ) && trader !== "TraderC"
          ? "retrospective_repost"
          : null;
    if (
      /不能提前.*(?:涨到|跌到)|否则.*失效|如果.*(?:不做这个单|不做这单)/.test(
        text,
      )
    )
      excluded ??= "unmodeled_conditional_invalidation";
    if (alternativeTarget) excluded ??= "ambiguous_alternative_tp";
    if (flags.includes("delayed_forward")) excluded ??= "delayed_forward";
    if (!market && !prices.length) excluded ??= "missing_entry";

    rows.push({
      id: s.id,
      raw_id: r?.id ?? -1,
      source_id: source,
      trader,
      symbol: s.symbol,
      direction,
      action: m.action_type,
      at,
      received_at: received,
      time_source: embedded
        ? "embedded_beijing"
        : original > 0
          ? "payload_create_time"
          : "received_utc",
      raw_text: text,
      levels: prices,
      market_first: market || flags.includes("completed_trade_notice"),
      stop: finite(sl?.price),
      targets,
      break_even: /移动保本|移.*保本损/.test(planText),
      flags,
      excluded,
    });
  }
  for (const p of rows) {
    const fix = corrections[String(p.id)];
    if (fix) {
      if (fix.raw_id !== p.raw_id) throw Error("correction raw id mismatch");
      if (fix.levels) p.levels = fix.levels.map(Number);
      if (fix.excluded) p.excluded = fix.excluded;
      p.flags.push("audited_raw_correction");
    }
  }
  rows.sort((a, b) => a.at - b.at || a.id - b.id);
  const sources = new Set<string>();
  for (const r of rows) {
    const key = JSON.stringify([
      r.trader,
      r.symbol,
      r.direction,
      r.levels,
      r.market_first,
      r.stop,
      r.targets,
    ]);
    if (sources.has(r.source_id + "|" + r.symbol + "|" + r.direction))
      r.excluded ??= "duplicate_source";
    if (seen.has(key) && r.at - seen.get(key)! < DAY)
      r.excluded ??= "duplicate_plan_24h";
    if (!r.excluded) {
      seen.set(key, r.at);
      sources.add(r.source_id + "|" + r.symbol + "|" + r.direction);
    }
  }
  return rows;
}
function sma(xs: Kline[], n: number) {
  return xs.length >= n ? mean(xs.slice(-n).map((b) => Number(b.close))) : null;
}
export function rsi(xs: Kline[], n = 14): number | null {
  if (xs.length < n + 1) return null;
  let up = 0,
    down = 0;
  for (let i = xs.length - n; i < xs.length; i++) {
    const d = Number(xs[i]!.close) - Number(xs[i - 1]!.close);
    up += Math.max(d, 0);
    down += Math.max(-d, 0);
  }
  return up + down === 0 ? 50 : (100 * up) / (up + down);
}
export function snapshot(data: MarketData, at: number, level: number) {
  const h = closedAt(data.bars["1h"] ?? [], at, 260),
    h4 = closedAt(data.bars["4h"] ?? [], at, 260),
    d = closedAt(data.bars["1d"] ?? [], at, 260),
    minute = closedAt(data.bars["1m"] ?? [], at, 1),
    quarter = closedAt(data.bars["15m"] ?? [], at, 1);
  const mark =
      minute.length && at - minute[0]!.close_time <= MINUTE
        ? minute[0]
        : quarter[0],
    a = h.length >= 15 ? atr(h.slice(-15), 14) : 0;
  if (
    !mark ||
    at - mark.close_time > 15 * MINUTE ||
    !(a > 0) ||
    at - h.at(-1)!.close_time > HOUR
  )
    return null;
  const price = Number(mark.close),
    dayStart = Math.floor(at / DAY) * DAY,
    vbars = closedAt(data.bars["15m"] ?? [], at, 100).filter(
      (b) => b.open_time >= dayStart,
    ),
    vol = vbars.reduce((n, b) => n + Number(b.volume), 0);
  const vwap =
    vol > 0
      ? vbars.reduce(
          (n, b) =>
            n +
            ((Number(b.high) + Number(b.low) + Number(b.close)) / 3) *
              Number(b.volume),
          0,
        ) / vol
      : null;
  const prior = d.find((b) => b.open_time === dayStart - DAY),
    roundStep = 10 ** (Math.floor(Math.log10(price)) - 2);
  const pivots: { high: number[]; low: number[] } = { high: [], low: [] };
  for (let i = 2; i < h4.length - 2; i++) {
    const win = h4.slice(i - 2, i + 3);
    if (Number(h4[i]!.high) === Math.max(...win.map((b) => Number(b.high))))
      pivots.high.push(Number(h4[i]!.high));
    if (Number(h4[i]!.low) === Math.min(...win.map((b) => Number(b.low))))
      pivots.low.push(Number(h4[i]!.low));
  }
  const nearest = (v: number[]) =>
    v.length
      ? v.reduce((best, x) =>
          Math.abs(x - level) < Math.abs(best - level) ? x : best,
        )
      : null;
  const dist = (x: number | null) => (x === null ? null : (level - x) / a);
  const trend = (bs: Kline[]) => {
    const x = sma(bs, 20),
      y = sma(bs, 50);
    return x === null || y === null
      ? "unknown"
      : x > y
        ? "up"
        : x < y
          ? "down"
          : "flat";
  };
  const levels = {
    swing_high: nearest(pivots.high),
    swing_low: nearest(pivots.low),
    round: Math.round(level / roundStep) * roundStep,
    prior_day_high: prior ? Number(prior.high) : null,
    prior_day_low: prior ? Number(prior.low) : null,
    vwap,
    sma20: sma(h, 20),
    sma50: sma(h, 50),
    sma200: sma(h, 200),
  };
  const funding = data.funding.filter((f) => f.at <= at).at(-1);
  return {
    price: String(price),
    price_at: mark.close_time,
    atr_1h: String(a),
    entry_distance_atr: (level - price) / a,
    round_step: String(roundStep),
    level_values: Object.fromEntries(
      Object.entries(levels).map(([k, v]) => [
        k,
        v === null ? null : String(v),
      ]),
    ),
    level_distance_atr: Object.fromEntries(
      Object.entries(levels).map(([k, v]) => [k, dist(v)]),
    ),
    trend_4h: trend(h4),
    trend_1d: trend(d),
    rsi_4h: rsi(h4),
    rsi_1d: rsi(d),
    funding_rate: funding?.rate ?? null,
    funding_at: funding?.at ?? null,
    funding_age_ms: funding ? at - funding.at : null,
    regime: dailyRegime(d, at)?.regime ?? null,
  };
}
export interface Leg {
  entry: "market" | "limit";
  price: number;
  stop: number;
  targets: { price: number; weight: number }[];
  break_even: boolean;
}
/** 多档止盈共用 stepTrade / tradeCosts；保本只在下一根生效，风险分母固定。 */
export function settleLeg(
  leg: Leg,
  direction: Direction,
  bars: Kline[],
  a: number,
  tick: number,
  funding: MarketData["funding"],
) {
  if (!bars.length) return null;
  const sign = direction === "long" ? 1 : -1;
  const plannedFill =
    leg.entry === "market" ? Number(bars[0]!.open) : leg.price;
  if (
    !(sign * (plannedFill - leg.stop) > 0) ||
    leg.targets.some(
      (t) => !(sign * (t.price - plannedFill) > 0) || !(t.weight > 0),
    ) ||
    (leg.targets.length &&
      Math.abs(leg.targets.reduce((n, t) => n + t.weight, 0) - 1) > 1e-6)
  )
    return null;
  const fi =
    leg.entry === "market"
      ? 0
      : bars.findIndex(
          (b) => conservativeLimitFill(direction, leg.price, b, tick) !== null,
        );
  const empty = {
    filled: false,
    net_r: 0,
    gross_r: 0,
    fee_r: 0,
    slip_r: 0,
    funding_r: 0,
    funding_known: 0,
    funding_expected: 0,
    exit_at: bars.at(-1)!.close_time,
    fill_at: null as number | null,
    mae_r: null as number | null,
    mfe_r: null as number | null,
    equity_marks: [] as { at: number; r: number }[],
  };
  if (leg.entry === "limit" && sign * (Number(bars[0]!.open) - leg.price) <= 0)
    return { ...empty, rejected: true };
  if (fi < 0) return { ...empty, rejected: false };
  const fill = leg.entry === "market" ? Number(bars[fi]!.open) : leg.price,
    risk = sign * (fill - leg.stop);
  if (!(risk > 0) || leg.targets.some((t) => sign * (t.price - fill) <= 0))
    return null;
  const targets = leg.targets.length
    ? leg.targets
    : [{ price: null, weight: 1 }];
  const parts = targets.map((t) => ({
    trade: openTrade(direction, fill, leg.stop, t.price)!,
    weight: t.weight,
    closed: false,
    gross: 0,
    net: 0,
  }));
  let be = false,
    net = 0,
    gross = 0,
    fees = 0,
    slip = 0,
    fund = 0,
    known = 0,
    expected = 0,
    exitAt = bars[fi]!.open_time;
  const marks: { at: number; r: number }[] = [];
  for (let i = fi; i < bars.length; i++) {
    const b = bars[i]!;
    if (be) for (const p of parts) if (!p.closed) p.trade.stop = fill;
    let tpThisBar = false;
    for (const p of parts) {
      if (p.closed) continue;
      const result = stepTrade(p.trade, b, leg.entry === "market" || i > fi);
      const last = i === bars.length - 1;
      if (result.exit || last) {
        const price = result.exit?.price ?? Number(b.close),
          at = result.exit?.at ?? b.close_time,
          c = tradeCosts(
            p.trade,
            price,
            leg.entry,
            bars[fi]!.open_time,
            at,
            a,
            funding,
            { tick },
          );
        p.closed = true;
        p.gross = tradeR(p.trade, price);
        p.net = p.gross - c.cost_r;
        gross += p.weight * p.gross;
        net += p.weight * p.net;
        fees += p.weight * c.fee_r;
        slip += p.weight * c.slip_r;
        fund += p.weight * c.funding_r;
        known += p.weight * c.funding_known;
        expected += p.weight * c.funding_expected;
        exitAt = Math.max(exitAt, at);
        if (result.exit?.status === "tp") tpThisBar = true;
      }
    }
    marks.push({
      at: b.close_time,
      r: parts.reduce(
        (s, p) =>
          s +
          p.weight *
            (p.closed
              ? p.net
              : tradeR(p.trade, Number(b.close)) -
                tradeCosts(
                  p.trade,
                  Number(b.close),
                  leg.entry,
                  bars[fi]!.open_time,
                  b.close_time,
                  a,
                  funding,
                  { tick },
                ).cost_r),
        0,
      ),
    });
    if (tpThisBar && leg.break_even) be = true;
    if (parts.every((p) => p.closed)) break;
  }
  return {
    filled: true,
    rejected: false,
    net_r: net,
    gross_r: gross,
    fee_r: fees,
    slip_r: slip,
    funding_r: fund,
    funding_known: known,
    funding_expected: expected,
    exit_at: exitAt,
    fill_at: bars[fi]!.open_time,
    mae_r: Math.min(...parts.map((p) => p.trade.mae_r)),
    mfe_r: Math.max(...parts.map((p) => p.trade.mfe_r)),
    equity_marks: marks,
  };
}
function estimate(rows: { at: number; value: number | null }[]) {
  const values = effectiveReturns(
    rows.flatMap((r) =>
      r.value === null ? [] : [{ at: r.at, net_r: r.value }],
    ),
  );
  return {
    mean: mean(values),
    effective_n: values.length,
    ci: bootstrapCI(values),
  };
}
export function fixedForward(
  data: MarketData,
  at: number,
  direction: Direction,
  hours: number,
) {
  const bs = forward(data.bars["15m"] ?? [], at, hours);
  if (!bs.length) return null;
  const price = Number(bs[0]!.open),
    sign = direction === "long" ? 1 : -1;
  return sign * (Number(bs.at(-1)!.close) / price - 1) * 10000;
}
export function fixedNetForward(
  data: MarketData,
  at: number,
  direction: Direction,
  hours: number,
) {
  const bs = forward(data.bars["15m"] ?? [], at, hours),
    h = closedAt(data.bars["1h"] ?? [], at, 15);
  if (!bs.length || !data.tick || h.length < 15) return null;
  const price = Number(bs[0]!.open),
    exit = Number(bs.at(-1)!.close),
    sign = direction === "long" ? 1 : -1,
    a = atr(h, 14);
  const c = tradeCosts(
    openTrade(direction, price, price - sign * price, null)!,
    exit,
    "market",
    bs[0]!.open_time,
    bs.at(-1)!.close_time,
    a,
    data.funding,
    { tick: data.tick },
  );
  return sign * (exit / price - 1) * 10000 - c.cost_r * 10000;
}
export function randomTimes(data: MarketData, at: number, id: number) {
  const from = Math.floor(at / (4 * HOUR)) * 4 * HOUR;
  const pool = (data.bars["15m"] ?? []).filter(
    (b) =>
      b.open_time >= from &&
      b.open_time < from + 4 * HOUR &&
      forward(data.bars["15m"] ?? [], b.open_time, 24).length,
  );
  let seed = id >>> 0;
  return Array.from({ length: pool.length ? 20 : 0 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return pool[Math.floor((seed / 4294967296) * pool.length)]!.open_time;
  });
}
export function featureRows(plans: Plan[], load: (s: string) => MarketData) {
  return plans.map((p) => {
    const data: MarketData =
        p.excluded === "symbol_identity_mismatch"
          ? { bars: {}, funding: [], tick: null }
          : load(p.symbol),
      quarter = forward(data.bars["15m"] ?? [], p.at, 24),
      sgn = p.direction === "long" ? 1 : -1,
      price = Number(quarter[0]?.open ?? NaN),
      level = p.market_first ? price : (p.levels[0] ?? price);
    const visible = closedAt(data.bars["1m"] ?? [], p.at, 1),
      coarse = closedAt(data.bars["15m"] ?? [], p.at, 1),
      publication = Number(
        visible.length && p.at - visible[0]!.close_time <= MINUTE
          ? visible[0]!.close
          : coarse[0]?.close,
      );
    const snap = Number.isFinite(p.market_first ? publication : level)
        ? snapshot(data, p.at, p.market_first ? publication : level)
        : null,
      a = snap ? Number(snap.atr_1h) : 0;
    const eligible = !p.excluded && !p.flags.includes("delayed_forward");
    const make = (entry: "market" | "limit", px: number) => ({
      entry,
      price: px,
      stop: p.stop!,
      targets: p.targets,
      break_even: p.break_even,
    });
    const legDefs = p.market_first
      ? [
          make("market", price),
          ...p.levels.slice(1).map((x) => make("limit", x)),
        ]
      : p.levels.map((x) => make("limit", x));
    const family =
      p.trader === "TraderA"
        ? "human_trader_a"
        : p.trader === "TraderB"
          ? "human_trader_b"
          : "human_trader_c";
    const signal =
      p.stop && snap
        ? HUMAN_SIGNAL_REGISTRY[family]!({
            at: p.at,
            direction: p.direction,
            entry: p.market_first ? "market" : "limit",
            reference_price: String(p.market_first ? publication : level),
            atr: a,
            stop_distance: String(
              Math.abs((p.market_first ? publication : level) - p.stop),
            ),
            tp_r: 1,
            invalidation: ["原文初始SL/TP；固定24h代理"],
            coverage: "ohlcv",
          })({
            bars: { "15m": closedAt(data.bars["15m"] ?? [], p.at, 1) },
            params: {},
            derivatives: null,
            regime: null,
            timeframe: "15m",
            confirmation: [],
            state: { last_at: -1, armed: false, compression_bars: 0 },
          })
        : null;
    const legs =
      signal && p.stop && a > 0 && data.tick && quarter.length
        ? legDefs.map((l) =>
            settleLeg(l, p.direction, quarter, a, data.tick!, data.funding),
          )
        : [];
    const complete = legs.length > 0 && legs.every((l) => l !== null),
      outcome = complete
        ? {
            net_r: mean(legs.map((l) => l!.net_r))!,
            gross_r: mean(legs.map((l) => l!.gross_r))!,
            filled: legs.some((l) => l!.filled),
            filled_legs: legs.filter((l) => l!.filled).length,
            rejected_legs: legs.filter((l) => l!.rejected).length,
            total_legs: legs.length,
            fee_r: mean(legs.map((l) => l!.fee_r)),
            slip_r: mean(legs.map((l) => l!.slip_r)),
            funding_r: mean(legs.map((l) => l!.funding_r)),
            funding_estimated: legs.some(
              (l) => l!.funding_known < l!.funding_expected,
            ),
            funding_known: legs.reduce((n, l) => n + l!.funding_known, 0),
            funding_expected: legs.reduce((n, l) => n + l!.funding_expected, 0),
            exit_at: Math.max(...legs.map((l) => l!.exit_at)),
            equity_marks: combineMarks(legs.map((l) => l!.equity_marks)),
          }
        : null;
    const touched =
      p.market_first && quarter.length
        ? 0
        : quarter.length && data.tick && sgn * (price - level) > 0
          ? quarter.findIndex(
              (b) =>
                conservativeLimitFill(p.direction, level, b, data.tick!) !==
                null,
            )
          : -1;
    const after = touched >= 0 ? quarter.slice(touched) : [],
      risk = p.stop ? sgn * (level - p.stop) : 0;
    const mfe = after.length
        ? Math.max(
            0,
            ...after.map(
              (b) => sgn * (Number(sgn === 1 ? b.high : b.low) - level),
            ),
          )
        : null,
      mae = after.length
        ? Math.max(
            0,
            ...after.map(
              (b) => sgn * (level - Number(sgn === 1 ? b.low : b.high)),
            ),
          )
        : null;
    const controls = randomTimes(data, p.at, p.id),
      f4 = fixedForward(data, p.at, p.direction, 4),
      f24 = fixedForward(data, p.at, p.direction, 24),
      random4 = mean(
        controls.flatMap((t) => {
          const x = fixedForward(data, t, p.direction, 4);
          return x === null ? [] : [x];
        }),
      ),
      random24 = mean(
        controls.flatMap((t) => {
          const x = fixedForward(data, t, p.direction, 24);
          return x === null ? [] : [x];
        }),
      );
    const perLevel = (
      p.market_first ? [price, ...p.levels.slice(1)] : p.levels
    ).map((px, i) => {
      const market = p.market_first && i === 0,
        f = Number.isFinite(market ? publication : px)
          ? snapshot(data, p.at, market ? publication : px)
          : null;
      const j =
        market && quarter.length
          ? 0
          : quarter.length && data.tick && sgn * (price - px) > 0
            ? quarter.findIndex(
                (b) =>
                  conservativeLimitFill(p.direction, px, b, data.tick!) !==
                  null,
              )
            : -1;
      const bs = j >= 0 ? quarter.slice(j) : [],
        d = p.stop ? sgn * (px - p.stop) : 0;
      const up = bs.length
        ? Math.max(
            0,
            ...bs.map((b) => sgn * (Number(sgn === 1 ? b.high : b.low) - px)),
          )
        : null;
      const down = bs.length
        ? Math.max(
            0,
            ...bs.map((b) => sgn * (px - Number(sgn === 1 ? b.low : b.high))),
          )
        : null;
      return {
        outcome: legs[i] ?? null,
        entry: market ? "market" : "limit",
        price: Number.isFinite(px) ? String(px) : null,
        snapshot: f,
        touched: quarter.length ? j >= 0 : null,
        touch_at: j >= 0 ? quarter[j]!.open_time : null,
        mfe_atr: up !== null && a > 0 ? up / a : null,
        mae_atr: down !== null && a > 0 ? down / a : null,
        mfe_r: up !== null && d > 0 ? up / d : null,
        mae_r: down !== null && d > 0 ? down / d : null,
      };
    });
    const marketBase =
      p.stop && a > 0 && data.tick && quarter.length
        ? settleLeg(
            make("market", price),
            p.direction,
            quarter,
            a,
            data.tick,
            data.funding,
          )
        : null;
    const commonRisk = p.stop ? sgn * (price - p.stop) : 0;
    const levelDelta =
      marketBase && complete && commonRisk > 0
        ? mean(
            legs.map(
              (l, i) =>
                (l!.net_r *
                  (sgn *
                    ((legDefs[i]!.entry === "market"
                      ? price
                      : legDefs[i]!.price) -
                      p.stop!))) /
                commonRisk,
            ),
          )! - marketBase.net_r
        : null;
    const net4 = fixedNetForward(data, p.at, p.direction, 4),
      net24 = fixedNetForward(data, p.at, p.direction, 24),
      randomNet4 = mean(
        controls.flatMap((t) => {
          const x = fixedNetForward(data, t, p.direction, 4);
          return x === null ? [] : [x];
        }),
      ),
      randomNet24 = mean(
        controls.flatMap((t) => {
          const x = fixedNetForward(data, t, p.direction, 24);
          return x === null ? [] : [x];
        }),
      );
    const fine = forward(data.bars["1m"] ?? [], p.at, 24),
      fineLegs =
        p.stop && a > 0 && data.tick && fine.length
          ? legDefs.map((l) =>
              settleLeg(l, p.direction, fine, a, data.tick!, data.funding),
            )
          : [];
    return {
      signal_family: family,
      signal_emitted: signal !== null,
      signal_id: p.id,
      raw_id: p.raw_id,
      source_id: p.source_id,
      trader: p.trader,
      symbol: p.symbol,
      direction: p.direction,
      action: p.action,
      at: p.at,
      received_at: p.received_at,
      time_source: p.time_source,
      session_utc: Math.floor((p.at % DAY) / (4 * HOUR)) * 4,
      flags: p.flags,
      excluded: p.excluded,
      eligible,
      snapshot: snap,
      levels: p.levels.map(String),
      stop: p.stop === null ? null : String(p.stop),
      targets: p.targets.map((t) => ({ ...t, price: String(t.price) })),
      price_forward_proxy: Number.isFinite(price) ? String(price) : null,
      per_level: perLevel,
      market_baseline_net_r: marketBase?.net_r ?? null,
      level_delta_net_r: levelDelta,
      full_24h: quarter.length > 0,
      touched: quarter.length && data.tick ? touched >= 0 : null,
      touch_at: touched >= 0 ? quarter[touched]!.open_time : null,
      mfe_atr: mfe !== null && a > 0 ? mfe / a : null,
      mae_atr: mae !== null && a > 0 ? mae / a : null,
      mfe_r: mfe !== null && risk > 0 ? mfe / risk : null,
      mae_r: mae !== null && risk > 0 ? mae / risk : null,
      level_improvement_atr:
        snap && !p.market_first
          ? (sgn * (Number(snap.price) - level)) / a
          : null,
      forward_4h_bps: f4,
      forward_24h_bps: f24,
      net_forward_4h_bps: net4,
      net_forward_24h_bps: net24,
      net_direction_component_bps: randomNet24,
      net_timing_4h_bps:
        net4 !== null && randomNet4 !== null ? net4 - randomNet4 : null,
      net_timing_24h_bps:
        net24 !== null && randomNet24 !== null ? net24 - randomNet24 : null,
      random_4h_bps: random4,
      random_24h_bps: random24,
      control_times: controls,
      timing_4h_bps: f4 !== null && random4 !== null ? f4 - random4 : null,
      timing_24h_bps: f24 !== null && random24 !== null ? f24 - random24 : null,
      direction_24h_bps: f24,
      outcome,
      one_minute_net_r:
        fineLegs.length && fineLegs.every((l) => l !== null)
          ? mean(fineLegs.map((l) => l!.net_r))
          : null,
      r_status: !p.stop
        ? "missing_stop"
        : !quarter.length
          ? "missing_future"
          : !a
            ? "missing_atr"
            : !data.tick
              ? "missing_tick"
              : !complete
                ? "invalid_stop_or_target"
                : "valid",
    };
  });
}
function combineMarks(legs: { at: number; r: number }[][]) {
  const deltas = new Map<number, number>();
  for (const marks of legs) {
    let prev = 0;
    for (const m of marks) {
      deltas.set(m.at, (deltas.get(m.at) ?? 0) + (m.r - prev) / legs.length);
      prev = m.r;
    }
  }
  let eq = 0;
  return [...deltas]
    .sort((a, b) => a[0] - b[0])
    .map(([at, d]) => ({ at, r: (eq += d) }));
}
export function attribution(rows: ReturnType<typeof featureRows>) {
  const metrics = [
    "direction_24h_bps",
    "timing_4h_bps",
    "timing_24h_bps",
    "level_improvement_atr",
    "level_delta_net_r",
    "net_forward_24h_bps",
    "net_direction_component_bps",
    "net_timing_4h_bps",
    "net_timing_24h_bps",
  ] as const;
  const summary = (xs: typeof rows) => ({
    n: xs.length,
    full_24h: xs.filter((x) => x.full_24h).length,
    r_valid: xs.filter((x) => x.outcome).length,
    fill_probability: estimate(
      xs.map((x) => ({
        at: x.at,
        value: x.touched === null ? null : Number(x.touched),
      })),
    ),
    ...Object.fromEntries(
      metrics.map((k) => [
        k,
        estimate(xs.map((x) => ({ at: x.at, value: x[k] }))),
      ]),
    ),
    expectancy_r: estimate(
      xs.map((x) => ({ at: x.at, value: x.outcome?.net_r ?? null })),
    ),
    mean_distance_atr: Object.fromEntries(
      [
        "swing_high",
        "swing_low",
        "round",
        "prior_day_high",
        "prior_day_low",
        "vwap",
        "sma20",
        "sma50",
        "sma200",
      ].map((k) => [
        k,
        mean(
          xs.flatMap((x) => {
            const v = x.snapshot?.level_distance_atr[k];
            return v === null || v === undefined ? [] : [Math.abs(v)];
          }),
        ),
      ]),
    ),
  });
  const eligible = rows.filter((x) => x.eligible);
  const group = (key: (r: (typeof rows)[number]) => string) => {
    const g = new Map<string, typeof rows>();
    for (const r of eligible) {
      const k = key(r);
      g.set(k, [...(g.get(k) ?? []), r]);
    }
    return Object.fromEntries([...g].map(([k, v]) => [k, summary(v)]));
  };
  return {
    by_trader: group((r) => r.trader),
    strata: group((r) =>
      [
        r.trader,
        r.symbol,
        r.direction,
        String(r.session_utc).padStart(2, "0"),
      ].join("|"),
    ),
    by_trader_symbol: group((r) => r.trader + "|" + r.symbol),
  };
}
export function replayHumans(
  rows: ReturnType<typeof featureRows>,
  from: number,
  to: number,
  trialCounts: Record<string, number> = {},
) {
  const folds = anchoredWalkForward(from, to, 24, HOUR);
  return ["TraderA", "TraderB", "TraderC"].map((trader) => {
    const family =
        trader === "TraderA"
          ? "human_trader_a"
          : trader === "TraderB"
            ? "human_trader_b"
            : "human_trader_c",
      trials = trialCounts[family] ?? 1;
    const selected = rows.filter(
      (r) =>
        r.trader === trader &&
        r.eligible &&
        r.outcome &&
        r.at >= from &&
        r.at + DAY < to,
    );
    const samples: ReplaySample[] = selected.map((r) => ({
      ...r.outcome!,
      at: r.at,
      horizon_end_at: Math.ceil(r.at / (15 * MINUTE)) * 15 * MINUTE + DAY - 1,
      symbol: r.symbol,
      regime:
        r.snapshot?.regime === "bull" || r.snapshot?.regime === "bear"
          ? "trend"
          : r.snapshot?.regime === "range"
            ? "range"
            : r.snapshot?.regime === "volatile"
              ? "high_vol"
              : "unknown",
    }));
    return {
      trader,
      family:
        trader === "TraderA"
          ? "human_trader_a"
          : trader === "TraderB"
            ? "human_trader_b"
            : "human_trader_c",
      available_from: selected.length
        ? Math.min(...selected.map((r) => r.at))
        : null,
      stats: {
        ...summarizeReplay(samples, folds, trials),
        universe_rule:
          "all corpus symbols; human publication availability; no pre-June observations",
      },
      common_crypto_stats: {
        ...summarizeReplay(
          samples.filter((s) => ["BTCUSDT", "ETHUSDT"].includes(s.symbol)),
          folds,
          trials,
        ),
        universe_rule: "BTCUSDT,ETHUSDT only; human availability",
      },
      fills: selected.filter((r) => r.outcome!.filled).length,
      samples,
    };
  });
}
export function replayMechanical(
  load: (s: string) => MarketData,
  from: number,
  to: number,
  trialCounts: Record<string, number>,
) {
  const folds = anchoredWalkForward(from, to, 24, HOUR),
    results = [];
  for (const family of Object.keys(
    TRADER_GRID,
  ) as (keyof typeof TRADER_GRID)[]) {
    const candidates = TRADER_GRID[family].map((params, index) => {
      const samples: ReplaySample[] = [];
      for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
        const data = load(symbol);
        if (!data.tick) continue;
        const tf = family === "trader_sr_reversal" ? "4h" : "1h",
          bs = data.bars[tf] ?? [];
        let last = -Infinity;
        for (const b of bs) {
          const at = b.close_time;
          if (at < from || at + DAY >= to || at - last < DAY) continue;
          const ctx: SignalContext = {
            bars: { [tf]: closedAt(bs, at, 60) },
            params: Object.fromEntries(
              Object.entries(params).map(([k, value]) => [
                k,
                { value, min: 0, max: 1, step: 0.1 },
              ]),
            ),
            derivatives: null,
            regime: null,
            timeframe: tf,
            confirmation: [],
            state: { compression_bars: 0, armed: false, last_at: -1 },
          };
          const signal = TRADER_SIGNAL_REGISTRY[family](ctx);
          if (!signal) continue;
          const future = forward(data.bars["15m"] ?? [], at, 24);
          if (!future.length) continue;
          last = at;
          const sign = signal.direction === "long" ? 1 : -1,
            price =
              signal.entry === "market"
                ? Number(future[0]!.open)
                : Number(signal.reference_price),
            risk = Number(signal.stop_distance),
            stop = price - sign * risk;
          const targets = [1, 2, 3].map((r) => ({
            price: price + sign * r * risk,
            weight: 1 / 3,
          }));
          const defs: Leg[] = [
            {
              entry: signal.entry,
              price,
              stop,
              targets,
              break_even: family === "trader_intraday_sweep",
            },
          ];
          if (family === "trader_intraday_sweep")
            defs.push({
              entry: "limit",
              price: price - sign * 0.3 * signal.atr,
              stop,
              targets,
              break_even: true,
            });
          const legs = defs.map((l) =>
            settleLeg(
              l,
              signal.direction,
              future,
              signal.atr,
              data.tick!,
              data.funding,
            ),
          );
          if (legs.some((l) => l === null)) continue;
          const regime = dailyRegime(
            closedAt(data.bars["1d"] ?? [], at, 260),
            at,
          )?.regime;
          samples.push({
            at,
            horizon_end_at: future.at(-1)!.close_time,
            exit_at: Math.max(...legs.map((l) => l!.exit_at)),
            net_r: mean(legs.map((l) => l!.net_r))!,
            gross_r: mean(legs.map((l) => l!.gross_r))!,
            equity_marks: combineMarks(legs.map((l) => l!.equity_marks)),
            symbol,
            regime:
              regime === "bull" || regime === "bear"
                ? "trend"
                : regime === "range"
                  ? "range"
                  : regime === "volatile"
                    ? "high_vol"
                    : "unknown",
          });
        }
      }
      return { key: String(index), params, samples };
    });
    const chosen = selectWalkForward(candidates, folds);
    const selected = chosen.flatMap((c) => c.samples),
      trialCount = trialCounts[family] ?? 3;
    results.push({
      family,
      trial_count: trialCount,
      candidates: candidates.map((c) => ({
        key: c.key,
        params: c.params,
        stats: {
          ...summarizeReplay(c.samples, folds, trialCount),
          universe_rule: "pre-registered BTCUSDT,ETHUSDT; conditional universe",
        },
      })),
      selected_folds: chosen.map((c) => ({
        fold: c.fold,
        key: c.key,
        is_expectancy: c.is_expectancy,
        n: c.samples.length,
      })),
      selected_stats: {
        ...summarizeReplay(selected, folds, trialCount),
        universe_rule: "pre-registered BTCUSDT,ETHUSDT; conditional universe",
      },
      selected_samples: selected,
    });
  }
  return results;
}
