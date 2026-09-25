-- 0016_demo_judgment_ledger.sql — 判断准确度账本
-- (docs/design/strategy-loop-v2-and-events-2026-09-12.md §3;契约 docs/demo/v3-ui-contract.md §9.29)。
--
-- 目的:把「模型判断准不准」从「策略好不好」里剥出来。每个 done 的 episode 落一行,
-- 三个方向(模型 / 议会 / 机械基线)在**同一个 horizon、同一批 K 线**上各自结算一次 R,
-- 差值就是模型的增量。全部代码算,零模型成本。
--
-- 结算是异步的:落行时 outcome_* 与 settled_at 全空,巡检等 horizon_end_at 到了再拉 K 线回填。
-- NULL 不是 0:算不出(方向说不出来 / 没有 K 线 / 止损在错误一侧)就留空,不进均值。

CREATE TABLE demo_judgment_ledger (
  episode_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,                   -- episode.at
  as_of INTEGER NOT NULL,                -- 判断看到的最后一根收盘时刻(反事实从这里往后走)
  symbol TEXT NOT NULL,
  timeframe TEXT,                        -- 判断周期(反事实用这个周期的 K 线);算不出为 null
  mode TEXT NOT NULL,                    -- scan | review
  thread_id TEXT,
  strategy_id TEXT,                      -- 模型自称跟的策略;没有则线程钉住的那条;都没有为 null
  model_action TEXT,                     -- Judgment.action;判断没跑出来为 null
  model_dir TEXT,                        -- long | short | null(不表态)
  council_dir TEXT,                      -- 议会共识方向;无议会/无共识为 null
  council_agree INTEGER,                 -- 议会是否达成共识(0/1);没有议会为 null
  mechanical_dir TEXT,                   -- 1h EMA20 vs EMA50;算不出为 null
  mechanical_note TEXT,                  -- mechanical_dir 为 null 时的原因
  horizon_end_at INTEGER NOT NULL,       -- as_of + 48 × 周期;巡检按它判断能不能结算
  outcome_r_model REAL,
  outcome_r_council REAL,
  outcome_r_mechanical REAL,
  outcome_source_model TEXT,             -- thread_settlement | counterfactual | flat | unscoreable
  regret_review REAL,                    -- 复查 HOLD/EXIT 的反事实 R 差(best − chosen,≥ 0);非复查为 null
  settled_at INTEGER,                    -- null = 还没结算
  settle_note TEXT,
  json TEXT NOT NULL                     -- JudgmentLedgerRow 全文(快照 + 三条反事实明细)
);
CREATE INDEX idx_demo_judgment_ledger_at ON demo_judgment_ledger(at DESC);
CREATE INDEX idx_demo_judgment_ledger_strategy ON demo_judgment_ledger(strategy_id, at DESC);
-- 巡检只扫「到期未结算」的行。
CREATE INDEX idx_demo_judgment_ledger_pending ON demo_judgment_ledger(horizon_end_at) WHERE settled_at IS NULL;
