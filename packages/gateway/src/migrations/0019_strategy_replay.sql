-- P1:试验计数独立于成功结果，失败候选也登记；判断回放与线上分源。
CREATE TABLE IF NOT EXISTS demo_strategy_trials (
  family TEXT NOT NULL,
  trial_key TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (family, trial_key)
);
ALTER TABLE demo_judgment_ledger ADD COLUMN source TEXT NOT NULL DEFAULT 'online';
CREATE INDEX idx_demo_judgment_ledger_source_at ON demo_judgment_ledger(source, at DESC);
-- 兼容既有 JudgmentLedgerStore.save：JSON 明确标 replay 的行同步独立列。
CREATE TRIGGER demo_judgment_replay_source_insert AFTER INSERT ON demo_judgment_ledger
WHEN json_extract(NEW.json, '$.source') = 'replay'
BEGIN UPDATE demo_judgment_ledger SET source = 'replay' WHERE episode_id = NEW.episode_id; END;
CREATE TRIGGER demo_judgment_replay_source_update AFTER UPDATE OF json ON demo_judgment_ledger
WHEN json_extract(NEW.json, '$.source') = 'replay'
BEGIN UPDATE demo_judgment_ledger SET source = 'replay' WHERE episode_id = NEW.episode_id; END;
