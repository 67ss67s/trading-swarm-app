-- 实盘 Jev 判断账本(docs/design/jev-live-2026-09-25.md):策略运行里每次判断一行,影子(shadow)与挡单(gate)都记。
-- 原始问答仍在 research_judge_decisions(decision_id 关联;其 decision_key 以 live: 开头);这里是给前端/汇总用的平铺视图。
-- 金额十进制字符串,时间 unix 毫秒;行写入后不改(同 research_judge_decisions 不可变)。
CREATE TABLE judge_live_decisions (
 id TEXT PRIMARY KEY,
 decision_id TEXT,
 run_id TEXT NOT NULL,
 strategy_id TEXT NOT NULL,
 strategy_name TEXT NOT NULL,
 symbol TEXT NOT NULL,
 timeframe TEXT NOT NULL,
 as_of INTEGER NOT NULL,
 mode TEXT NOT NULL CHECK (mode IN ('shadow','gate')),
 status TEXT NOT NULL CHECK (status IN ('ok','uncertain','error','skipped')),
 action TEXT CHECK (action IS NULL OR action IN ('follow','skip')),
 candidate_json TEXT NOT NULL,
 questions_json TEXT NOT NULL,
 answers_json TEXT NOT NULL,
 predicates_json TEXT NOT NULL,
 state_json TEXT,
 reason_codes_json TEXT NOT NULL,
 cost_usd TEXT,
 latency_ms INTEGER,
 error TEXT,
 model TEXT,
 created_at INTEGER NOT NULL
);
CREATE INDEX judge_live_decisions_created ON judge_live_decisions(created_at DESC);
CREATE INDEX judge_live_decisions_run ON judge_live_decisions(run_id, created_at DESC);
CREATE TRIGGER judge_live_decision_immutable BEFORE UPDATE ON judge_live_decisions
BEGIN SELECT RAISE(ABORT,'judge_live_decision_immutable'); END;
