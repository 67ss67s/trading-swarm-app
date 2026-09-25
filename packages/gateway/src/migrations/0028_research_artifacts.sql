CREATE TABLE IF NOT EXISTS research_artifacts (
 id TEXT PRIMARY KEY,
 chat_id TEXT NOT NULL,
 run_id TEXT,
 kind TEXT NOT NULL CHECK(kind IN ('chart','table','markdown')),
 title TEXT NOT NULL,
 content_json TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS research_artifacts_chat ON research_artifacts(chat_id,created_at);
