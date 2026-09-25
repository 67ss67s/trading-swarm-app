-- 矩阵研究 matrix study(契约 docs/demo/v3-ui-contract.md §9.53 B「2026-09-25 matrix study 修订」)。
-- 0047_research_judge.sql 只占 judge / 预算表;本文件建矩阵研究全部表。金额 TEXT,时间 unix 毫秒。
-- 与旧 research_studies(预注册单次研究)无关,表名刻意区分。

CREATE TABLE research_matrix_studies (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  research_program_id TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  protocol_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  state_json TEXT NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX matrix_studies_status ON research_matrix_studies(status, created_at);
CREATE INDEX matrix_studies_program ON research_matrix_studies(research_program_id, created_at);

-- manifest 展开出的格子(冻结,只插不改)
CREATE TABLE research_study_cells (
  study_id TEXT NOT NULL REFERENCES research_matrix_studies(id),
  cell_id TEXT NOT NULL,
  applicability TEXT NOT NULL,
  cell_json TEXT NOT NULL,
  PRIMARY KEY (study_id, cell_id)
);

-- 试验账本:每个看过成绩的不同配置一行(每代每个新变体都是新试验);谱系级按 config_hash 去重计数
CREATE TABLE research_study_trials (
  trial_id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL REFERENCES research_matrix_studies(id),
  research_program_id TEXT NOT NULL,
  cell_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  parent_trial_id TEXT,
  generation INTEGER NOT NULL,
  config_hash TEXT NOT NULL,
  ir_hash TEXT NOT NULL,
  judge_hash TEXT,
  model_revision TEXT,
  candidate_json TEXT NOT NULL,
  selection_visible_at INTEGER,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (study_id, config_hash)
);
CREATE INDEX matrix_trial_program ON research_study_trials(research_program_id, config_hash);
CREATE INDEX matrix_trial_study ON research_study_trials(study_id, generation);

-- 评估结果(唯一评估键;失败记状态不删行,恢复时复用 completed)
CREATE TABLE research_study_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL,
  trial_id TEXT NOT NULL,
  segment TEXT NOT NULL,
  cost_scenario TEXT NOT NULL,
  data_hash TEXT NOT NULL,
  engine_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (trial_id, segment, cost_scenario, data_hash, engine_hash)
);
CREATE INDEX matrix_eval_trial ON research_study_evaluations(study_id, trial_id);

-- 每次实际评估尝试(含失败 / 取消 / 恢复重跑),attempt_count 的来源
CREATE TABLE research_study_attempts (
  attempt_id TEXT PRIMARY KEY,
  evaluation_id TEXT NOT NULL,
  study_id TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX matrix_attempt_study ON research_study_attempts(study_id, started_at);

-- 留出释放:BEGIN IMMEDIATE 内 sealed → claimed(插入本行),一次释放全部 finalist
CREATE TABLE research_holdout_releases (
  release_id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL UNIQUE,
  research_program_id TEXT NOT NULL,
  data_scope_id TEXT NOT NULL,
  from_ms INTEGER NOT NULL,
  to_ms INTEGER NOT NULL,
  finalists_hash TEXT NOT NULL,
  protocol_hash TEXT NOT NULL,
  trial_ledger_hash TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  data_manifest_hash TEXT NOT NULL,
  capability_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  released_at INTEGER,
  result_json TEXT
);
CREATE INDEX matrix_holdout_program ON research_holdout_releases(research_program_id, from_ms, to_ms);

-- 数据暴露登记:研究谱系 × 数据区间 × 用途(search / holdout),防止换 id 重用留出
CREATE TABLE research_data_exposures (
  exposure_id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL,
  research_program_id TEXT NOT NULL,
  data_scope_id TEXT NOT NULL,
  from_ms INTEGER NOT NULL,
  to_ms INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  first_exposed_at INTEGER NOT NULL
);
CREATE INDEX matrix_exposure_program ON research_data_exposures(research_program_id, purpose, from_ms, to_ms);

-- 事件 outbox(与状态变更同事务写;SSE 投递后标 delivered_at;断线按 seq 续传)
CREATE TABLE research_study_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  study_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  stage TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX matrix_events_study ON research_study_events(study_id, seq);
CREATE INDEX matrix_events_undelivered ON research_study_events(delivered_at, seq);

-- code_judge 臂全部候选日志(含 skip / error / uncertain)
CREATE TABLE research_study_candidates (
  study_id TEXT NOT NULL,
  trial_id TEXT NOT NULL,
  segment TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  decision_json TEXT,
  PRIMARY KEY (study_id, trial_id, segment, candidate_id)
);

CREATE TABLE research_matrix_adoptions (
  study_id TEXT NOT NULL,
  finalist_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (study_id, finalist_id)
);

-- ---- 不变量
CREATE TRIGGER matrix_manifest_immutable BEFORE UPDATE OF manifest_hash, protocol_hash, manifest_json, research_program_id, idempotency_key ON research_matrix_studies
BEGIN SELECT RAISE(ABORT, 'matrix_manifest_immutable'); END;
CREATE TRIGGER matrix_cells_immutable BEFORE UPDATE ON research_study_cells
BEGIN SELECT RAISE(ABORT, 'matrix_cells_immutable'); END;
-- 留出占用后本 Study 不能再登记新试验(改策略必须开新的开发轮 + 新的未见区间)
CREATE TRIGGER matrix_no_trials_after_holdout BEFORE INSERT ON research_study_trials
WHEN EXISTS (SELECT 1 FROM research_holdout_releases WHERE study_id = NEW.study_id)
BEGIN SELECT RAISE(ABORT, 'matrix_holdout_claimed_no_more_search'); END;
-- 留出释放只进不退,结果写一次;冻结字段不可改;不可删
CREATE TRIGGER matrix_release_forward_only BEFORE UPDATE OF status ON research_holdout_releases
WHEN NOT (OLD.status = 'claimed' AND NEW.status IN ('claimed', 'released'))
BEGIN SELECT RAISE(ABORT, 'matrix_release_status_forward_only'); END;
CREATE TRIGGER matrix_release_result_immutable BEFORE UPDATE OF result_json ON research_holdout_releases
WHEN OLD.result_json IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'matrix_release_result_immutable'); END;
CREATE TRIGGER matrix_release_frozen BEFORE UPDATE OF finalists_hash, protocol_hash, trial_ledger_hash, model_revision, data_manifest_hash, capability_hash, research_program_id, data_scope_id, from_ms, to_ms ON research_holdout_releases
BEGIN SELECT RAISE(ABORT, 'matrix_release_frozen'); END;
CREATE TRIGGER matrix_release_no_delete BEFORE DELETE ON research_holdout_releases
BEGIN SELECT RAISE(ABORT, 'matrix_release_no_delete'); END;
-- 账本只增不删(取消 / 恢复不清零计数)
CREATE TRIGGER matrix_trials_no_delete BEFORE DELETE ON research_study_trials
BEGIN SELECT RAISE(ABORT, 'matrix_trials_append_only'); END;
CREATE TRIGGER matrix_attempts_no_delete BEFORE DELETE ON research_study_attempts
BEGIN SELECT RAISE(ABORT, 'matrix_attempts_append_only'); END;
CREATE TRIGGER matrix_exposures_no_delete BEFORE DELETE ON research_data_exposures
BEGIN SELECT RAISE(ABORT, 'matrix_exposures_append_only'); END;
