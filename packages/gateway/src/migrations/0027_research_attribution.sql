CREATE TABLE research_attributions (cache_key TEXT PRIMARY KEY, child_run_id TEXT NOT NULL REFERENCES research_runs(id), created_at INTEGER NOT NULL, json TEXT NOT NULL);
