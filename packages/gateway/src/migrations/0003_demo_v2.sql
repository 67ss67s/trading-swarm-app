-- 0003_demo_v2.sql — demo v2 (docs/demo/v2-agent-loop.md): information events, market states,
-- strategy threads, chat. Workflow settings live in kv ('demo.workflow').

CREATE TABLE demo_info_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  occurred_at INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX idx_demo_info_events_at ON demo_info_events(occurred_at);

CREATE TABLE demo_market_states (
  id TEXT PRIMARY KEY,
  as_of INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX idx_demo_market_states_as_of ON demo_market_states(as_of);

CREATE TABLE demo_threads (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX idx_demo_threads_status ON demo_threads(status, updated_at);
CREATE INDEX idx_demo_threads_symbol ON demo_threads(symbol, status);

CREATE TABLE demo_chat (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  role TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX idx_demo_chat_at ON demo_chat(at);
