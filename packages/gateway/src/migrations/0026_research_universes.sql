-- Immutable member snapshots; retrieval time is provenance, not market-content identity.
CREATE TABLE research_market_snapshots (content_hash TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES research_datasets(id));
CREATE TABLE research_universes (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, json TEXT NOT NULL);
