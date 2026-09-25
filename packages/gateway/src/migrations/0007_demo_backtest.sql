-- 0007_demo_backtest.sql — 盲测回放(docs/design/blind-backtest-2026-09-05.md, v3-ui-contract.md §9.8)。
-- 一次回测 = 一行 demo_backtest_run + 每次判断一行 demo_backtest_step。判断本身不写 demo_episodes:
-- 回测不占每日判断上限、也不该混进「今日用量」的真实台账,花费只在 run 的 summary_json 里算。

CREATE TABLE demo_backtest_run (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  from_ms INTEGER NOT NULL,
  to_ms INTEGER NOT NULL,
  mode TEXT NOT NULL,                    -- triggers | every_close
  status TEXT NOT NULL,                  -- queued | running | done | failed | cancelled
  params_json TEXT NOT NULL,
  brain TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  progress_json TEXT,                    -- { done, total, last_action, at }
  summary_json TEXT,                     -- BacktestSummary(见 backtest.ts)
  error TEXT
);
CREATE INDEX idx_demo_backtest_run_created ON demo_backtest_run(created_at DESC);
CREATE INDEX idx_demo_backtest_run_scope ON demo_backtest_run(symbol, timeframe, from_ms, to_ms);

CREATE TABLE demo_backtest_step (
  run_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  at_ms INTEGER NOT NULL,                -- 这根 K 线的收盘时间(判断发生的时刻)
  kind TEXT NOT NULL,                    -- scan | review
  trigger TEXT,                          -- 触发器摘要(triggers 模式下命中的规则)
  visible_upto_ms INTEGER NOT NULL,      -- 模型可见的最后一根 K 线 close_time,盲测的硬边界
  judgment_json TEXT,
  action TEXT,
  direction TEXT,
  confidence REAL,
  gates_json TEXT,
  outcome_json TEXT,                     -- 这一步产生/推进的模拟交易(成交、出场、R、MAE/MFE)
  cost_json TEXT,                        -- { input_tokens, output_tokens, cny }
  PRIMARY KEY (run_id, idx)
);
CREATE INDEX idx_demo_backtest_step_at ON demo_backtest_step(run_id, at_ms);
