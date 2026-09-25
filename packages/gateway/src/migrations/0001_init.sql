-- 0001_init.sql — state.sqlite base schema (gateway-owned; docs/contracts/README.md §9).
--
-- Applied inside one transaction by src/state-db.ts's migrator, tracked in schema_migrations.
-- Once this has shipped, treat it as immutable — add a new numbered file (0002_*.sql, ...) for
-- further changes rather than editing this one; the migrator skips any version already recorded
-- in schema_migrations, so an edited-after-the-fact file would silently never re-run.
--
-- A0 scope: tables + indexes only, no business writes yet (per the work package).

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  at INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('gateway', 'execd')),
  exec_seq INTEGER,
  json TEXT NOT NULL
);
CREATE INDEX idx_events_at ON events(at);
CREATE INDEX idx_events_source_exec_seq ON events(source, exec_seq);

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  trace_id TEXT,
  brain TEXT,
  recipe TEXT,
  status TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  json TEXT
);
CREATE INDEX idx_runs_started_at ON runs(started_at);

CREATE TABLE trace_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  trace_id TEXT,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  json TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);
CREATE INDEX idx_trace_events_run_id ON trace_events(run_id);
CREATE INDEX idx_trace_events_at ON trace_events(at);

CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  trace_id TEXT,
  tool_name TEXT NOT NULL,
  at INTEGER NOT NULL,
  latency_ms INTEGER,
  ok INTEGER,
  json TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);
CREATE INDEX idx_tool_calls_run_id ON tool_calls(run_id);
CREATE INDEX idx_tool_calls_at ON tool_calls(at);

CREATE TABLE llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  trace_id TEXT,
  brain TEXT,
  model TEXT,
  at INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  cost_micros INTEGER,
  json TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);
CREATE INDEX idx_llm_usage_run_id ON llm_usage(run_id);
CREATE INDEX idx_llm_usage_at ON llm_usage(at);

CREATE TABLE journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  kind TEXT,
  at INTEGER NOT NULL,
  json TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);
CREATE INDEX idx_journal_at ON journal(at);

CREATE TABLE lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  status TEXT,
  json TEXT
);
CREATE INDEX idx_lessons_created_at ON lessons(created_at);

CREATE TABLE monitors (
  id TEXT PRIMARY KEY,
  kind TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  json TEXT
);

CREATE TABLE cron_jobs (
  id TEXT PRIMARY KEY,
  schedule TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  json TEXT
);

CREATE TABLE cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cron_job_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT,
  json TEXT,
  FOREIGN KEY (cron_job_id) REFERENCES cron_jobs(id)
);
CREATE INDEX idx_cron_runs_cron_job_id ON cron_runs(cron_job_id);
CREATE INDEX idx_cron_runs_started_at ON cron_runs(started_at);

CREATE TABLE incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  severity TEXT,
  opened_at INTEGER NOT NULL,
  resolved_at INTEGER,
  json TEXT
);
CREATE INDEX idx_incidents_opened_at ON incidents(opened_at);

CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL
);
