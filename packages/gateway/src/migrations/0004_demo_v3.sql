-- 0004_demo_v3.sql — demo v3 (docs/demo/v3-ui-contract.md): activity timeline + equity curve points.

CREATE TABLE demo_activity (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  level TEXT NOT NULL,
  symbol TEXT,
  thread_id TEXT,
  json TEXT NOT NULL
);
CREATE INDEX idx_demo_activity_at ON demo_activity(at);
CREATE INDEX idx_demo_activity_thread ON demo_activity(thread_id, at);

CREATE TABLE demo_equity (
  at INTEGER PRIMARY KEY,
  equity REAL NOT NULL,
  unrealized REAL NOT NULL
);
