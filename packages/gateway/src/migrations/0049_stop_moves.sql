-- 移损独立账本；unknown 非终态，一个线程最多一个未解决动作。
CREATE TABLE demo_stop_moves (
  thread_id TEXT NOT NULL,
  run_id TEXT,
  target_stop TEXT NOT NULL,
  old_stop TEXT NOT NULL,
  new_cid TEXT NOT NULL UNIQUE,
  old_cid TEXT,
  old_algo_id TEXT,
  new_algo_id TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('planned','submitted','confirmed','replaced','failed','unknown')),
  method TEXT NOT NULL CHECK (method IN ('paper','amend','replace')),
  execution_key TEXT NOT NULL,
  request_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  attention TEXT,
  at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(thread_id, target_stop)
);
CREATE UNIQUE INDEX demo_stop_moves_pending ON demo_stop_moves(thread_id)
  WHERE phase IN ('planned','submitted','unknown') OR attention IS NOT NULL;
CREATE TABLE demo_stop_move_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  new_cid TEXT NOT NULL,
  phase TEXT NOT NULL,
  at INTEGER NOT NULL,
  data TEXT NOT NULL
);
