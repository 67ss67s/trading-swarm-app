-- 0002_demo.sql — demo runtime tables (docs/demo/README.md §5.9). Gateway-local, not the
-- contracts six-record model; these exist so every judgment episode is replayable from disk.

CREATE TABLE demo_strategies (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE demo_strategy_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  at INTEGER NOT NULL,
  episode_id TEXT,
  json TEXT NOT NULL
);
CREATE INDEX idx_demo_strategy_revisions_sid ON demo_strategy_revisions(strategy_id, version);

CREATE TABLE demo_episodes (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  status TEXT NOT NULL,
  action TEXT,
  json TEXT NOT NULL
);
CREATE INDEX idx_demo_episodes_at ON demo_episodes(at);

CREATE TABLE demo_intents (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  status TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX idx_demo_intents_at ON demo_intents(at);

CREATE TABLE demo_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  level TEXT NOT NULL,
  scope TEXT NOT NULL,
  message TEXT NOT NULL,
  json TEXT
);
CREATE INDEX idx_demo_logs_at ON demo_logs(at);
