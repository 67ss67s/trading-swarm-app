-- Immutable ingress and frozen outbound content. Processing state lives separately.
CREATE TABLE okx_market_delivery_in (
 delivery_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, received_at INTEGER NOT NULL,
 raw TEXT NOT NULL, parse_status TEXT NOT NULL, signal_id TEXT, signal_json TEXT, errors_json TEXT NOT NULL,
 signal_type TEXT, session TEXT
);
CREATE INDEX market_in_job ON okx_market_delivery_in(job_id, received_at);
CREATE TRIGGER market_in_no_update BEFORE UPDATE ON okx_market_delivery_in BEGIN SELECT RAISE(ABORT, 'append-only inbox'); END;
CREATE TRIGGER market_in_no_delete BEFORE DELETE ON okx_market_delivery_in BEGIN SELECT RAISE(ABORT, 'append-only inbox'); END;
CREATE TABLE okx_market_delivery_out (
 event_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, event_json TEXT NOT NULL,
 subscriber_set_json TEXT NOT NULL, deliverable_text TEXT NOT NULL, payload_json TEXT NOT NULL,
 asp_id TEXT NOT NULL, refusal TEXT
);
CREATE TABLE okx_market_delivery_out_job (
 event_id TEXT NOT NULL REFERENCES okx_market_delivery_out(event_id), job_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','delivered','failed')), attempts INTEGER NOT NULL DEFAULT 0,
 error TEXT, result_json TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(event_id, job_id)
);
CREATE TABLE okx_market_aftersale (
 event_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, event TEXT NOT NULL, asp_id TEXT NOT NULL,
 buyer TEXT, period TEXT, reason TEXT, deadline INTEGER, received_at INTEGER NOT NULL,
 status TEXT NOT NULL, decision TEXT, result_json TEXT, raw TEXT NOT NULL
);
CREATE INDEX market_aftersale_job ON okx_market_aftersale(job_id, received_at);
ALTER TABLE demo_trader_signal ADD COLUMN subscription_job_id TEXT NOT NULL DEFAULT 'unknown';
CREATE INDEX trader_signal_subscription ON demo_trader_signal(subscription_job_id, published_at);
