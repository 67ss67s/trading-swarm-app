-- 策略对象生命周期(§9.46):「策略 → 版本 → 报告/run」一条链。研究域,零交易所写入。
-- 报告本体在 research_backtests(WP-A),这里只存挂链关系 + 摘要快照,列表页一次查询出卡片。
-- lab_strategy_id / published_listing_id 是挂点:以后晋升交易侧 lab 策略库、swarm/ASP 发布订阅用同一个 strategy_id,本轮不写。
CREATE TABLE research_strategies(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('draft','backtested','paper','live','published','archived')),
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  watchlist INTEGER NOT NULL DEFAULT 0 CHECK(watchlist IN (0,1)),
  alerts INTEGER NOT NULL DEFAULT 0 CHECK(alerts IN (0,1)),
  current_version INTEGER NOT NULL DEFAULT 0,
  origin_json TEXT NOT NULL,
  origin_session_id TEXT GENERATED ALWAYS AS (json_extract(origin_json,'$.session_id')) VIRTUAL,
  -- 自动建策略时的原始报告标题(用户改名后仍能按「本会话同名」挂新版本)
  origin_title TEXT,
  -- 前端「新建策略」先建草稿再开会话,attach-session 把会话绑上来;绑定后该会话的回测报告都挂到这条策略
  session_bound INTEGER NOT NULL DEFAULT 0 CHECK(session_bound IN (0,1)),
  summary_json TEXT,
  lab_strategy_id TEXT,
  published_listing_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX research_strategies_status ON research_strategies(status,updated_at);
CREATE INDEX research_strategies_session ON research_strategies(origin_session_id,origin_title);
-- 版本不可变;同一策略同一 IR 哈希只有一个版本。run_ids / revision_refs / lab_strategy_ref 是往旧三张表的反向引用。
CREATE TABLE research_strategy_versions(
  strategy_id TEXT NOT NULL REFERENCES research_strategies(id),
  version INTEGER NOT NULL,
  ir_hash TEXT NOT NULL,
  ir_json TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  run_ids_json TEXT NOT NULL DEFAULT '[]',
  revision_refs_json TEXT NOT NULL DEFAULT '[]',
  lab_strategy_ref TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(strategy_id,version),
  UNIQUE(strategy_id,ir_hash)
);
CREATE INDEX research_strategy_versions_hash ON research_strategy_versions(ir_hash);
-- 版本 ↔ 回测报告:一份报告只挂一个版本;summary_json 是 BacktestReportSummary 快照(主资产指标 + 降采样曲线)。
CREATE TABLE research_strategy_reports(
  report_id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES research_strategies(id),
  version INTEGER NOT NULL,
  completed INTEGER NOT NULL CHECK(completed IN (0,1)),
  summary_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attached_at INTEGER NOT NULL
);
CREATE INDEX research_strategy_reports_version ON research_strategy_reports(strategy_id,version,created_at);
CREATE TABLE research_strategy_events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id TEXT NOT NULL REFERENCES research_strategies(id),
  at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('created','version_added','backtested','transition','renamed','flag_changed','archived','session_attached')),
  from_status TEXT,
  to_status TEXT,
  version INTEGER,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX research_strategy_events_strategy ON research_strategy_events(strategy_id,seq);
