-- IR judge：金额 TEXT；事务 claim；首次响应不可覆盖。
CREATE TABLE research_call_budgets (
 id TEXT PRIMARY KEY, max_calls INTEGER NOT NULL, max_usd TEXT NOT NULL,
 calls INTEGER NOT NULL DEFAULT 0, spent_usd TEXT NOT NULL DEFAULT '0', reserved_usd TEXT NOT NULL DEFAULT '0',
 cancelled INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE research_judge_responses (
 request_hash TEXT PRIMARY KEY, budget_id TEXT NOT NULL REFERENCES research_call_budgets(id),
 status TEXT NOT NULL, request_json TEXT NOT NULL, raw_json TEXT, error_code TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE research_call_attempts (
 attempt_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL UNIQUE REFERENCES research_judge_responses(request_hash),
 budget_id TEXT NOT NULL, reservation_usd TEXT NOT NULL, actual_usd TEXT, usage_json TEXT,
 provider_request_id TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE TABLE research_judge_decisions (
 decision_id TEXT PRIMARY KEY, decision_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
 input_hash TEXT NOT NULL, input_json TEXT NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TRIGGER judge_raw_immutable BEFORE UPDATE OF raw_json ON research_judge_responses WHEN OLD.raw_json IS NOT NULL
BEGIN SELECT RAISE(ABORT,'judge_raw_immutable'); END;

CREATE TRIGGER judge_decision_immutable BEFORE UPDATE ON research_judge_decisions
BEGIN SELECT RAISE(ABORT,'judge_decision_immutable'); END;
