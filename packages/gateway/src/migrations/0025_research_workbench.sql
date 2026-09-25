-- Research state is isolated from trading / strategy promotion / judgment performance.
CREATE TABLE research_datasets (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE research_studies (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE research_runs (
  id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
  study_id TEXT NOT NULL REFERENCES research_studies(id), status TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, manifest_json TEXT NOT NULL, result_json TEXT
);
CREATE TABLE research_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES research_runs(id), at INTEGER NOT NULL, event TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX research_events_run_seq ON research_events(run_id, seq);
CREATE TABLE research_model_calls (run_id TEXT NOT NULL REFERENCES research_runs(id), call_index INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(run_id,call_index));
CREATE TABLE research_chats (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE research_policy_drafts (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, json TEXT NOT NULL);
ALTER TABLE research_runs ADD COLUMN summary_json TEXT;
