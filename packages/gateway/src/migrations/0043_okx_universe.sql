-- OKX 资产全集(universe-okx.ts,设计 docs/design/watch-screener-review-2026-09-24.md 二-1)。零模型、只读公共行情。
-- 一行 = 一个规范符号(BTCUSDT),现货与永续合并;每次刷新整表替换(单事务),刷新失败保留上一次的表。
-- 金额/价格/资金费存 TEXT(十进制字符串,原样来自 OKX 或定点格式化);*_sort 列是 REAL 只用于排序,不对外。
CREATE TABLE okx_universe_asset(
  symbol TEXT PRIMARY KEY,
  base TEXT NOT NULL,
  markets_json TEXT NOT NULL,              -- ["spot","perp"] 的子集
  spot_inst_id TEXT,
  perp_inst_id TEXT,
  last TEXT,                               -- 最新价(有现货取现货,否则永续)
  change_24h TEXT,                         -- 24h 涨跌 %(同上一个市场,(last-open24h)/open24h×100,3 位小数)
  quote_volume_24h TEXT NOT NULL,          -- 24h 报价币成交额(现货 + 永续合计,USDT,2 位小数)
  spot_quote_volume_24h TEXT,
  perp_quote_volume_24h TEXT,
  volume_sort REAL NOT NULL DEFAULT 0,
  change_sort REAL,
  funding_rate TEXT,                       -- 永续当期资金费率(小数,非 %);仅永续
  funding_sort REAL,
  next_funding_at INTEGER,                 -- 下次结算 unix ms
  listed_at INTEGER,                       -- 最早的上线时间(两个市场取早的)
  rank_by_volume INTEGER,                  -- 在「未排除」集合里按 24h 成交额的名次;排除的为 NULL
  quote_volume_90d TEXT,                   -- 近 90 个完整 UTC 日成交额(只有每日扫描算过 K 线的前 N 个有;近似 Σ volume×close)
  rank_by_volume_90d INTEGER,
  excluded INTEGER NOT NULL DEFAULT 0,     -- 稳定币 / 法币锚定 / 包装与质押衍生币
  excluded_reason TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX okx_universe_asset_volume ON okx_universe_asset(excluded, volume_sort DESC);

-- 每次刷新(成功或失败)一行:给 UI 看「上次什么时候刷的、花了几个请求、为什么失败」。
CREATE TABLE okx_universe_refresh(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('running','done','failed')),
  reason TEXT NOT NULL,                    -- boot | timer | manual
  total INTEGER,
  requests INTEGER,
  duration_ms INTEGER,
  error TEXT
);
CREATE INDEX okx_universe_refresh_started ON okx_universe_refresh(started_at DESC);
