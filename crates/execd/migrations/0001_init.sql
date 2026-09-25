-- exec.sqlite v1(docs/contracts/README.md §9)。只有 execd 打开这个库。
-- 约定:每条记录的完整 JSON 放 json 列(契约形状),关键字段拆列做索引/约束;时间一律 unix 毫秒。

CREATE TABLE IF NOT EXISTS intents (
  intent_id        TEXT PRIMARY KEY,
  account          TEXT NOT NULL CHECK (account IN ('main','sub')),
  kind             TEXT NOT NULL,
  principal        TEXT NOT NULL,
  surface          TEXT NOT NULL,
  status           TEXT NOT NULL,
  idempotency_key  TEXT,
  symbol           TEXT,
  json             TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  terminal_at      INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_intents_idem ON intents(principal, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status, created_at);
CREATE INDEX IF NOT EXISTS idx_intents_account_symbol ON intents(account, symbol, created_at);

CREATE TABLE IF NOT EXISTS plans (
  plan_id     TEXT PRIMARY KEY,
  intent_id   TEXT NOT NULL REFERENCES intents(intent_id),
  version     INTEGER NOT NULL,
  plan_hash   TEXT NOT NULL,
  json        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (intent_id, version)
);

CREATE TABLE IF NOT EXISTS authorizations (
  authorization_id TEXT PRIMARY KEY,
  intent_id        TEXT NOT NULL REFERENCES intents(intent_id),
  plan_id          TEXT NOT NULL REFERENCES plans(plan_id),
  plan_hash        TEXT NOT NULL,
  by_whom          TEXT NOT NULL CHECK (by_whom IN ('user','policy')),
  status           TEXT NOT NULL,
  json             TEXT NOT NULL,
  granted_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_intent ON authorizations(intent_id, granted_at);

CREATE TABLE IF NOT EXISTS attempts (
  attempt_id       TEXT PRIMARY KEY,
  intent_id        TEXT NOT NULL REFERENCES intents(intent_id),
  plan_id          TEXT NOT NULL REFERENCES plans(plan_id),
  attempt_no       INTEGER NOT NULL,
  leg              TEXT NOT NULL,
  leg_index        INTEGER NOT NULL,
  client_order_id  TEXT NOT NULL UNIQUE,
  channel          TEXT NOT NULL CHECK (channel IN ('rest','mcp')),
  stage            TEXT NOT NULL,
  result           TEXT NOT NULL,
  json             TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  deadline_at      INTEGER NOT NULL,
  result_at        INTEGER,
  UNIQUE (intent_id, leg, leg_index, attempt_no)
);
CREATE INDEX IF NOT EXISTS idx_attempts_result ON attempts(result, created_at);

CREATE TABLE IF NOT EXISTS exchange_orders (
  observation_id     TEXT PRIMARY KEY,
  account            TEXT NOT NULL,
  exchange_order_id  TEXT NOT NULL,
  client_order_id    TEXT,
  status             TEXT NOT NULL,
  observed_at        INTEGER NOT NULL,
  json               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_identity ON exchange_orders(account, exchange_order_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_orders_client ON exchange_orders(client_order_id);

CREATE TABLE IF NOT EXISTS fills (
  fill_id            TEXT PRIMARY KEY,
  account            TEXT NOT NULL,
  exchange_order_id  TEXT NOT NULL,
  trade_id           TEXT NOT NULL,
  json               TEXT NOT NULL,
  trade_time         INTEGER NOT NULL,
  UNIQUE (account, exchange_order_id, trade_id)
);

CREATE TABLE IF NOT EXISTS position_effects (
  effect_id     TEXT PRIMARY KEY,
  intent_id     TEXT NOT NULL UNIQUE REFERENCES intents(intent_id),
  status        TEXT NOT NULL,
  json          TEXT NOT NULL,
  evaluated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account_snapshots (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  account          TEXT NOT NULL,
  account_version  TEXT,
  consistency      TEXT NOT NULL,
  computed_at      INTEGER NOT NULL,
  json             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_account ON account_snapshots(account, computed_at);

-- durable 执行队列(A2 填逻辑;A0 先把表立住)
CREATE TABLE IF NOT EXISTS ops_queue (
  op_id        TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  priority     INTEGER NOT NULL,
  lane         TEXT NOT NULL,
  state        TEXT NOT NULL,
  lease_owner  TEXT,
  lease_epoch  INTEGER,
  lease_until  INTEGER,
  attempt      INTEGER NOT NULL DEFAULT 0,
  checkpoint   TEXT,
  created_at   INTEGER NOT NULL,
  UNIQUE (kind, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_ops_lane ON ops_queue(lane, state, priority, created_at);

CREATE TABLE IF NOT EXISTS writer_lease (
  lane         TEXT PRIMARY KEY,
  instance_id  TEXT NOT NULL,
  epoch        INTEGER NOT NULL,
  until        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  event      TEXT NOT NULL,
  at         INTEGER NOT NULL,
  account    TEXT,
  intent_id  TEXT,
  json       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_intent ON events(intent_id, seq);

CREATE TABLE IF NOT EXISTS policy (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  version     INTEGER NOT NULL,
  json        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
