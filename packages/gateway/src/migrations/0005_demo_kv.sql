-- 0005_demo_kv.sql — a general key/value scratchpad owned by the demo runtime (DemoStore.kvGet /
-- kvSet). Split out of the shared `kv` table of 0001 so demo-local blobs (halt flag, day anchor,
-- the `paper_state` PaperBackend snapshot) live next to the other demo_* tables. Existing demo
-- keys are carried over so an upgrade does not silently reset the halt flag / day anchor.

CREATE TABLE demo_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO demo_kv(key, value, updated_at)
  SELECT key, COALESCE(value, ''), updated_at FROM kv;
