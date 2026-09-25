-- 策略自动改进与复验环(Improver,设计 docs/research/improver-design-2026-09-23.md):任务 + 候选谱系。研究域,零交易所写入、零模型。
-- 任务在创建时冻结目标函数与预算(spec_json),跑中不改;冻结数据(dataset_ids + 切段)写进 frozen_json,重跑同 id 结果一致。
-- 留出段每个任务只允许用一次:holdout_used_at 由 UPDATE ... WHERE holdout_used_at IS NULL 原子占用。
CREATE TABLE improve_jobs(
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','interrupted')),
  strategy_id TEXT,
  strategy_version INTEGER,
  spec_json TEXT NOT NULL,
  frozen_json TEXT,
  progress_json TEXT,
  ledger_json TEXT,
  result_json TEXT,
  error TEXT,
  holdout_used_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX improve_jobs_strategy ON improve_jobs(strategy_id,created_at);
CREATE INDEX improve_jobs_status ON improve_jobs(status,created_at);
-- 候选谱系:每个候选 = 父候选 + 一个改动(diff)+ 生成器 + 理由;evaluation_json 是训练段各折 / 验证段 / 留出段(仅冠军)的扣成本表现与门槛。
-- status:rejected(编译检查不过,不计试验数)/ evaluated / gated_out / plateau_failed / validated / parent / champion
CREATE TABLE improve_candidates(
  job_id TEXT NOT NULL REFERENCES improve_jobs(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  parent_id TEXT,
  generation INTEGER NOT NULL,
  generator TEXT NOT NULL,
  ir_hash TEXT NOT NULL,
  ir_json TEXT NOT NULL,
  diff_json TEXT NOT NULL,
  rationale TEXT NOT NULL,
  evidence_json TEXT,
  evaluation_json TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(job_id,id)
);
CREATE INDEX improve_candidates_gen ON improve_candidates(job_id,generation);
