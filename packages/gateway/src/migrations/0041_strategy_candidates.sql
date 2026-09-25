-- 0041_strategy_candidates.sql — CandidateV0 影子候选(docs/research/candidate-v0-2026-09-23.md;契约 v3-ui-contract §9.50)。
--
-- 研究台 StrategyIR 在每根策略周期收盘时由代码算出的做多候选(方向/入场参考/止损/目标/失效线/RR),
-- 和同一币同一时段模型的判断(demo_episodes)配对,到期后按计划腿与吊灯腿结算。零下单、零模型。
-- 只有 strategy-candidate.ts 写这张表;迁移本身只建表,不回填。
-- 编号 0041:0033–0039 留给并行 session(0040_memory_scope 的约定),迁移按文件名字典序执行。

CREATE TABLE demo_strategy_candidate (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,                 -- 生成时刻(墙钟)
  as_of INTEGER NOT NULL,              -- 信号根收盘时刻(open_time + 周期,整点边界)
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  ir_hash TEXT NOT NULL,
  json TEXT NOT NULL,                  -- 完整 StrategyCandidate(含 unmapped / model / settlement)
  settle_due_at INTEGER NOT NULL,      -- as_of + horizon 根;过了才结算
  settled_at INTEGER,
  outcome_r REAL,                      -- 计划腿(止损/目标不动,到期按收盘)毛 R
  outcome_r_trail REAL,                -- 吊灯腿(ATR22×3 入场起追踪,无目标)毛 R
  outcome_source TEXT,                 -- plan_walk / invalid / unscoreable
  model_episode_id TEXT,
  model_action TEXT,                   -- 模型判断动作;'none' = 窗口内模型没被问过;NULL = 配对窗口还没关
  model_dir TEXT,
  model_matched_at INTEGER,
  UNIQUE(strategy_id, version, symbol, as_of)
);
CREATE INDEX idx_demo_strategy_candidate_symbol ON demo_strategy_candidate(symbol, as_of);
CREATE INDEX idx_demo_strategy_candidate_asof ON demo_strategy_candidate(as_of, id);
CREATE INDEX idx_demo_strategy_candidate_settle ON demo_strategy_candidate(settle_due_at) WHERE settled_at IS NULL;
CREATE INDEX idx_demo_strategy_candidate_match ON demo_strategy_candidate(as_of) WHERE model_action IS NULL;
