-- 全窗口多资产回测报告(§9.46,engine research-spot-ir-v4)。report_json 是完整 BacktestReport(契约 research-backtest.json),
-- summary_json 是列表页用的 BacktestReportSummary;strategy_id/version 由策略对象服务通过 onBacktestReport 回写。
-- idempotency_key:研究 loop 的 inquiry:step,超时重试不重复算;run_id:同一步骤的开发段 run(修订/优化链用),compare_buy_and_hold 按它找报告。
CREATE TABLE IF NOT EXISTS research_backtests (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  strategy_ir_hash TEXT NOT NULL,
  strategy_id TEXT,
  strategy_version INTEGER,
  inquiry_id TEXT,
  session_id TEXT,
  idempotency_key TEXT UNIQUE,
  run_id TEXT,
  report_json TEXT NOT NULL,
  summary_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS research_backtests_strategy ON research_backtests(strategy_id, created_at);
CREATE INDEX IF NOT EXISTS research_backtests_inquiry ON research_backtests(inquiry_id, created_at);
CREATE INDEX IF NOT EXISTS research_backtests_run ON research_backtests(run_id);
