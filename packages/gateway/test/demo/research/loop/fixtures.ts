import { vi } from "vitest";
import type {
  MarketData,
  Instrument,
  SnapshotDraft,
  Window,
} from "../../../../src/demo/research/data/index.js";
import type * as Analyses from "../../../../src/demo/research/data/analyses.js";
import { hash } from "../../../../src/demo/research/primitives.js";
export const NOW = Date.UTC(2026, 8, 22),
  WINDOW = { from_ms: NOW - 30 * 86400000, to_ms: NOW };
export function instrument(
  base = "BTC",
  market: "spot" | "perp" = "perp",
): Instrument {
  return {
    canonical_id: `okx:${market}:${base}-USDT${market === "perp" ? "-SWAP" : ""}`,
    asset_class: "crypto",
    venue: "okx",
    market_type: market,
    base,
    quote: "USDT",
    timezone: "UTC",
    ccxt_symbol: base + "/USDT" + (market === "perp" ? ":USDT" : ""),
    display: base,
  };
}
export function draft(
  kind: SnapshotDraft["kind"],
  i = instrument(),
  window = WINDOW,
): SnapshotDraft {
  const empty = i.market_type === "spot" && kind !== "price",
    rows: SnapshotDraft["rows"] = empty
      ? []
      : Array.from({ length: 40 }, (_, n) => {
          const ts = window.from_ms + n * 3600000;
          return kind === "price"
            ? {
                ts,
                open_time: ts,
                close_time: ts + 3599999,
                open: "100",
                high: "102",
                low: "99",
                close: "101",
                volume: "12",
              }
            : kind === "funding"
              ? { ts, rate: 0.0001, interval_ms: 28800000 }
              : kind === "open_interest"
                ? { ts, oi_value_usd: "10000" }
                : {
                    ts,
                    side: "buy",
                    pos_side: "short",
                    size: "1",
                    price: "101",
                  };
        });
  return {
    kind,
    provider: "okx",
    instrument: i,
    requested_window: window,
    actual_window: empty ? null : window,
    as_of: window.to_ms,
    fetched_at: NOW,
    frequency:
      kind === "funding" ? "8h" : kind === "liquidations" ? null : "1h",
    units:
      kind === "price"
        ? { price: "USDT", volume: i.base }
        : kind === "funding"
          ? { rate: "fraction_per_8h" }
          : kind === "open_interest"
            ? { oi_value_usd: "USD" }
            : { price: "USDT", size: i.base },
    coverage: empty
      ? "not_applicable"
      : kind === "liquidations"
        ? "partial"
        : "available",
    quality_flags: empty ? ["现货不适用"] : [],
    rows,
    method_version: "test-only/v1",
    checksum: hash({ kind, i, window, rows }),
  };
}
export function fakeMarket(): MarketData {
  return {
    resolve: vi.fn(async (input) =>
      (input.symbols ?? ["BTC"]).map((s) =>
        instrument(
          s.replace(/[-/:_].*$/, "").replace(/USDT$/, ""),
          input.market ?? "perp",
        ),
      ),
    ),
    coverage: vi.fn(async (i, metric) => ({
      availability:
        i.market_type === "spot" && metric !== "price"
          ? "not_applicable"
          : "available",
      note: i.market_type === "spot" ? "现货不适用" : "fixture coverage",
    })),
    price: vi.fn(async (i, _, w) => draft("price", i, w)),
    funding: vi.fn(async (i, w) => draft("funding", i, w)),
    openInterest: vi.fn(async (i, _, w) => draft("open_interest", i, w)),
    liquidations: vi.fn(async (i, w) => draft("liquidations", i, w)),
  };
}
const metric = { value: 0.1, unit: "fraction", status: "ok" as const };
export const fakeAnalyses: typeof Analyses = {
  analyzeLeverage: vi.fn((price, funding, oi) => ({
    price_change: metric,
    oi_change: oi?.rows.length
      ? metric
      : { value: null, unit: "fraction", status: "not_applicable" },
    funding_avg: funding?.rows.length
      ? metric
      : { value: null, unit: "fraction", status: "not_applicable" },
    funding_pctile_vs_window: metric,
    liquidation_count: { ...metric, value: 0, unit: "count" },
    observation: "测试观察，不作为市场证据",
    aligned: price.rows.map((row) => ({
      ts: Number(row.ts ?? row.close_time),
      close: Number(row.close),
      oi_value_usd: oi?.rows.length ? 10000 : null,
      funding_rate: funding?.rows.length ? 0.0001 : null,
    })),
    method_version: "test-only/v1",
    warnings: [],
  })),
  analyzeRelativeStrength: vi.fn((prices, benchmark) => ({
    benchmark: benchmark.instrument.canonical_id,
    window: benchmark.requested_window,
    rows: prices.map((s) => ({
      canonical_id: s.instrument.canonical_id,
      bars: 40,
      return: metric,
      beta: metric,
      alpha_annualized: metric,
      residual_sharpe: metric,
      max_drawdown: metric,
    })),
    method_version: "test-only/v1",
    warnings: [],
  })),
  compareBuyAndHold: vi.fn((_, window, fee, slip, strategy) => ({
    window,
    buy_and_hold_return: metric,
    strategy_net_return: { ...metric, value: strategy },
    comparable: true,
    note: "same window",
    method_version: "test-only/v1",
  })),
};
