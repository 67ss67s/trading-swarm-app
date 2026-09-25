-- 0016_demo_market_events.sql — 事件区(Event Zone)。
-- 设计:docs/design/strategy-loop-v2-and-events-2026-09-12.md §5;契约 docs/demo/v3-ui-contract.md §9.30。
-- 实体全文在 json 里(events.ts MarketEvent),列出来的字段只是为了能索引/筛选,不是第二份真理。

CREATE TABLE market_events (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,             -- scheduled | news | exchange | onchain | derived
  subkind      TEXT NOT NULL,             -- fomc / cpi / nfp / unlock / listing / … / unclassified
  assets_json  TEXT NOT NULL,             -- string[];空数组 = 宏观事件(影响全市场)
  expected_at  INTEGER,                   -- 只有 scheduled 有;其余 NULL,窗口从 captured_at 起算
  window_ms    INTEGER NOT NULL,
  captured_at  INTEGER NOT NULL,
  starts_at    INTEGER NOT NULL,          -- = COALESCE(expected_at, captured_at),索引用的冗余列
  ends_at      INTEGER NOT NULL,          -- = starts_at + window_ms
  source       TEXT NOT NULL,
  source_ref   TEXT NOT NULL,
  confidence   TEXT NOT NULL,             -- confirmed | reported | rumor
  status       TEXT NOT NULL,             -- captured | briefed | live | resolved | retro_done | dismissed
  dedupe_key   TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  json         TEXT NOT NULL
);

-- 去重的最后一道防线:三路 capture 各自算 dedupe_key,同键只可能有一行。
CREATE UNIQUE INDEX idx_market_events_dedupe ON market_events(dedupe_key);
-- 「现在窗口里有哪些事件」是最热的查询(每次判断都要问)。
CREATE INDEX idx_market_events_window ON market_events(ends_at, starts_at);
CREATE INDEX idx_market_events_status ON market_events(status, starts_at DESC);
-- eventStats(subkind) 的同类聚合。
CREATE INDEX idx_market_events_subkind ON market_events(subkind, ends_at DESC);
