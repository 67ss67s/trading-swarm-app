-- 0006_demo_memory.sql — v3.2 long-term memory (docs/demo/memory.md, design §11 L3 "B7-lite").
-- One row per MemoryItem; history in demo_memory_events; FTS5 trigram index for free-text recall (Chinese-safe).

CREATE TABLE demo_memory (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  symbol TEXT,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  json TEXT NOT NULL
);
CREATE INDEX idx_demo_memory_status ON demo_memory(status, symbol);
CREATE INDEX idx_demo_memory_hash ON demo_memory(content_hash);

CREATE TABLE demo_memory_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX idx_demo_memory_events_mid ON demo_memory_events(memory_id, at);

CREATE VIRTUAL TABLE demo_memory_fts USING fts5(memory_id UNINDEXED, content, tags, tokenize='trigram');
