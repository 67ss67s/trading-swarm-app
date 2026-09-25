-- 0018_demo_strategy_loop.sql — 策略闭环 v2(设计 docs/design/strategy-loop-v2-and-events-2026-09-12.md §1/§2;
-- 契约 docs/demo/v3-ui-contract.md §9.27/§9.28)。三张表,全部零模型。
--
-- 1) demo_strategy_event —— 生命周期台账:每次状态迁移 / 版本创建 / 降级 / 启停都记一行,
--    who ∈ code|human|lab|attribution,evidence 是**数字**(不是形容词),策略页画晋升时间线。
-- 2) demo_shadow_thread —— 影子实盘的虚拟线程:不下单、不占 Portfolio 容量、不进风控、不进 history
--    胜率,所以**刻意不进 demo_threads**。按真实 K 线在 horizon 内结算 R,写回该版本的 lab_stats.shadow。
-- 3) demo_lab_probe_queue —— attribution 的 param 类提案落在这里等下一轮 Lab 验证;
--    达标才 createVersion(模型永远没有晋升权)。

CREATE TABLE demo_strategy_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  at INTEGER NOT NULL,                  -- unix 毫秒
  who TEXT NOT NULL,                    -- code | human | lab | attribution
  kind TEXT NOT NULL,                   -- version_created | promote | demote | retire | activated | deactivated
  from_status TEXT,                     -- 迁移前状态;version_created 为 null
  to_status TEXT,
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL           -- Record<string, number|null>:判这一步时用到的数字
);
CREATE INDEX idx_demo_strategy_event_id ON demo_strategy_event(strategy_id, at DESC);
CREATE INDEX idx_demo_strategy_event_at ON demo_strategy_event(at DESC);

CREATE TABLE demo_shadow_thread (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  side TEXT NOT NULL,                   -- long | short
  opened_at INTEGER NOT NULL,           -- 判断时刻(as_of);反事实从这里往后走
  horizon_end_at INTEGER NOT NULL,      -- opened_at + 48 × 周期
  status TEXT NOT NULL,                 -- open | settled | unscoreable
  r REAL,                               -- 结算后的 R;算不出留 null(NULL 不是 0)
  settled_at INTEGER,
  episode_id TEXT,
  json TEXT NOT NULL                    -- ShadowThread 全文(快照 + 结算腿明细)
);
CREATE INDEX idx_demo_shadow_thread_strategy ON demo_shadow_thread(strategy_id, version, opened_at DESC);
CREATE INDEX idx_demo_shadow_thread_pending ON demo_shadow_thread(horizon_end_at) WHERE settled_at IS NULL;
CREATE UNIQUE INDEX idx_demo_shadow_thread_open ON demo_shadow_thread(strategy_id, version, symbol) WHERE status = 'open';

CREATE TABLE demo_lab_probe_queue (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  param TEXT NOT NULL,
  value REAL NOT NULL,
  source TEXT NOT NULL,                 -- attribution | human
  source_ref TEXT,                      -- attribution id / run id
  queued_at INTEGER NOT NULL,
  status TEXT NOT NULL,                 -- queued | verified | rejected
  checked_at INTEGER,
  note TEXT
);
CREATE INDEX idx_demo_lab_probe_queue_status ON demo_lab_probe_queue(status, queued_at ASC);
CREATE UNIQUE INDEX idx_demo_lab_probe_queue_open ON demo_lab_probe_queue(strategy_id, param, value) WHERE status = 'queued';
