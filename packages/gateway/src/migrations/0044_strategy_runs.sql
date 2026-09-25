-- 研究策略运行与研究对象同属 marketDb。IR/执行通道在创建或显式更新时钉住。
CREATE TABLE strategy_runs (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES research_strategies(id),
  status TEXT NOT NULL CHECK(status IN ('running','paused','stopped','error')),
  updated_at INTEGER NOT NULL,
  json TEXT NOT NULL,
  ir_json TEXT NOT NULL,
  execution_key TEXT NOT NULL
);
CREATE UNIQUE INDEX strategy_runs_one_active ON strategy_runs(strategy_id) WHERE status <> 'stopped';
CREATE TABLE strategy_run_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES strategy_runs(id),
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX strategy_run_events_page ON strategy_run_events(run_id, seq DESC);
CREATE TABLE strategy_run_seen (
  run_id TEXT NOT NULL REFERENCES strategy_runs(id),
  symbol TEXT NOT NULL,
  as_of INTEGER NOT NULL,
  PRIMARY KEY(run_id, symbol, as_of)
);
