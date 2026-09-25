import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { TRADER_GRID } from "../packages/gateway/src/demo/trader-signals.ts";
import { spawnSync } from "node:child_process";
import {
  normalizeSignals,
  featureRows,
  attribution,
  replayHumans,
  replayMechanical,
} from "../packages/gateway/src/demo/trader-study.ts";
export async function run() {
  const args = process.argv.slice(2),
    opt = (key, fallback) => {
      const i = args.indexOf(key);
      return i >= 0 ? args[i + 1] : fallback;
    };
  if (args.includes("--fill")) {
    for (const extra of [[], ["--fine"]]) {
      const r = spawnSync(
        "python3",
        [
          "scripts/trader-cache.py",
          "--root",
          opt("--cache-root", `${homedir()}/.trading-swarm/demo`),
          "--to",
          "1789171200000",
          ...extra,
        ],
        { stdio: "inherit" },
      );
      if (r.status !== 0) throw Error("trader cache fill failed");
    }
  }
  const dir = "docs/research/data/traders-0912",
    root = opt("--cache-root", `${homedir()}/.trading-swarm/demo`),
    research = `${root}/research-traders`;
  const read = (path, fallback) => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT" && fallback !== undefined) return fallback;
      throw e;
    }
  };
  const hash = (x) =>
    createHash("sha256")
      .update(typeof x === "string" ? x : JSON.stringify(x))
      .digest("hex");
  const atomic = (path, value) => {
    writeFileSync(path + ".tmp", JSON.stringify(value, null, 2) + "\n");
    renameSync(path + ".tmp", path);
  };
  if (!existsSync(`${dir}/raw_messages.json`) || !existsSync(`${dir}/structured_signals.json`)) {
    console.error(`缺少原始输入:${dir}/raw_messages.json 与 structured_signals.json 不随仓库分发,重跑研究需自备`);
    process.exit(2);
  }
  const raw = read(`${dir}/raw_messages.json`),
    signals = read(`${dir}/structured_signals.json`),
    registration = read(`${dir}/preregistration.json`);
  const ticks = read(
      `${research}/ticks.json`,
      read(`${root}/research-entry/ticks.json`, {}),
    ),
    plans = normalizeSignals(raw, signals, read(`${dir}/corrections.json`, {})),
    hashes = {},
    cache = new Map(),
    coverageCache = new Map();
  const load = (symbol) => {
    if (cache.has(symbol)) return cache.get(symbol);
    const bars = {};
    for (const tf of ["1m", "5m", "15m", "1h", "4h", "1d"]) {
      const file = `${root}/klines/${symbol}-${tf}.json`;
      const value = read(file, { bars: [] }).bars;
      bars[tf] = value.filter(
        (b) => b.close_time < registration.corpus_to_exclusive,
      );
      hashes[`${symbol}:${tf}`] = hash(bars[tf]);
    }
    const funding = read(
      `${research}/${symbol}-funding.json`,
      read(`${root}/research-entry/${symbol}-funding.json`, { points: [] }),
    ).points;
    hashes[`${symbol}:funding`] = hash(funding);
    coverageCache.set(
      symbol,
      Object.entries(bars).map(([tf, bs]) => {
        const ms = {
            "1m": 60000,
            "5m": 300000,
            "15m": 900000,
            "1h": 3600000,
            "4h": 14400000,
            "1d": 86400000,
          }[tf],
          start = Date.parse("2026-05-20T00:00:00Z"),
          selected = bs.filter(
            (b) =>
              b.open_time >= start &&
              b.close_time < registration.corpus_to_exclusive,
          );
        return {
          symbol,
          tf,
          bars: selected.length,
          expected: (registration.corpus_to_exclusive - start) / ms,
          first_at: selected[0]?.open_time ?? null,
          last_at: selected.at(-1)?.close_time ?? null,
        };
      }),
    );
    if (cache.size >= 2) cache.delete(cache.keys().next().value);
    const data = {
      bars,
      funding,
      tick: ticks[symbol] ? Number(ticks[symbol]) : null,
    };
    cache.set(symbol, data);
    return data;
  };
  if (
    JSON.stringify(registration.hypotheses) !== JSON.stringify(TRADER_GRID) ||
    registration.horizon_hours !== 24
  )
    throw Error("registered grid/horizon differs from implemented study");
  const executionHash = hash([
    registration,
    readFileSync("packages/gateway/src/demo/trader-study.ts", "utf8"),
    readFileSync("packages/gateway/src/demo/trader-signals.ts", "utf8"),
    ...["outcome.ts", "replay-stats.ts", "market.ts", "indicators.ts"].map(
      (name) => readFileSync(`packages/gateway/src/demo/${name}`, "utf8"),
    ),
    readFileSync("scripts/trader-study.mjs", "utf8"),
  ]);
  mkdirSync(research, { recursive: true });
  // 独立 append-only 内容寻址 trial 登记：同一 protocol+参数不重复，数据刷新不制造新搜索。
  const ledgerPath = `${research}/trials.json`,
    ledger = read(ledgerPath, {}),
    trialCounts = {};
  for (const [family, params] of Object.entries({
    ...registration.hypotheses,
    ...Object.fromEntries(
      registration.human_families.map((family) => [
        family,
        [{ initial_plan_proxy: true }],
      ]),
    ),
  })) {
    ledger[family] ??= {};
    for (const p of params) {
      const key = hash([executionHash, family, p]);
      ledger[family][key] ??= { registered_at: Date.now(), params: p };
    }
    trialCounts[family] = Object.keys(ledger[family]).length;
  }
  atomic(ledgerPath, ledger);
  console.error(
    "normalization",
    plans.length,
    "eligible",
    plans.filter((p) => !p.excluded).length,
  );
  const features = featureRows(
    [...plans].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.at - b.at),
    load,
  ).sort((a, b) => a.at - b.at || a.signal_id - b.signal_id);
  console.error("features complete", features.length);
  const human = replayHumans(
      features,
      registration.from,
      registration.to,
      trialCounts,
    ),
    mechanical = replayMechanical(
      load,
      registration.from,
      registration.to,
      trialCounts,
    );
  for (const symbol of new Set(signals.map((s) => s.symbol)))
    if (!coverageCache.has(symbol)) load(symbol);
  const coverage = [...coverageCache.values()].flat();
  const marketCatalog = read(`${research}/exchange-info.json`, { symbols: [] })
    .symbols.filter((s) => signals.some((x) => x.symbol === s.symbol))
    .map((s) => ({
      symbol: s.symbol,
      underlying_type: s.underlyingType,
      underlying_sub_type: s.underlyingSubType,
      onboard_date: s.onboardDate,
    }));
  const count = (xs, key) =>
    Object.fromEntries(
      [...new Set(xs.map(key))].map((k) => [
        k,
        xs.filter((x) => key(x) === k).length,
      ]),
    );
  const corpus = Object.fromEntries(
    ["交易员B", "交易员A", "交易员C"].map((trader) => {
      const rs = raw.filter((r) => r.trader === trader),
        ss = signals.filter((s) => {
          const m = JSON.parse(s.metadata);
          return (
            raw.find((r) => r.source_message_id === m.candidate_id)?.trader ===
            trader
          );
        });
      return [
        trader,
        {
          raw: rs.length,
          unique_text: new Set(rs.map((r) => r.raw_text)).size,
          structured: ss.length,
          actions: count(ss, (s) => JSON.parse(s.metadata).action_type),
          keywords: Object.fromEntries(
            [
              "支撑",
              "阻力",
              "前低",
              "前高",
              "整数",
              "均线",
              "资金费",
              "保本",
              "加仓",
              "减仓",
              "止损",
              "异动",
              "不做",
              "市价",
            ].map((k) => [k, rs.filter((r) => r.raw_text.includes(k)).length]),
          ),
        },
      ];
    }),
  );
  const result = {
    registration,
    registration_hash: hash(registration),
    execution_hash: executionHash,
    input_hashes: {
      raw: hash(raw),
      structured: hash(signals),
      corrections: hash(read(`${dir}/corrections.json`, {})),
    },
    data_hashes: hashes,
    trial_count_snapshot: trialCounts,
    market_catalog: marketCatalog,
    corpus,
    counts: {
      open_add: plans.length,
      exclusions: count(features, (r) => r.excluded ?? "none"),
      r_status: count(features, (r) => r.r_status),
      eligible: features.filter((r) => r.eligible).length,
      delayed: features.filter((r) => r.flags.includes("delayed_forward"))
        .length,
    },
    coverage,
    attribution: attribution(features),
    human,
    mechanical,
  };
  atomic(`${dir}/features.json`, features);
  atomic(`${dir}/results.json`, result);
  console.table(
    human.map((r) => ({
      family: r.family,
      n: r.stats.raw_n,
      oos_n: r.stats.oos_n,
      net: r.stats.oos_net_expectancy,
      dsr: r.stats.dsr,
    })),
  );
  console.table(
    mechanical.map((r) => ({
      family: r.family,
      folds: r.selected_folds.length,
      n: r.selected_stats.raw_n,
      oos_n: r.selected_stats.oos_n,
      net: r.selected_stats.oos_net_expectancy,
      dsr: r.selected_stats.dsr,
    })),
  );
  await import("./trader-report.mjs?run=" + Date.now());
  console.log(
    JSON.stringify({ output: `${dir}/results.json`, counts: result.counts }),
  );
}
