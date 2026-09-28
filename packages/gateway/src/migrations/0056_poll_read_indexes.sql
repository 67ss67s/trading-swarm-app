-- 轮询读路径的索引(只加不改)。
-- /api/bots 的最近 run / 最近交接:原来是全表扫描 + 临时 B 树排序,排序器要搬动整行(含 input_json/result_json 大字段)。
CREATE INDEX IF NOT EXISTS idx_demo_bot_run_started ON demo_bot_run(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_demo_bot_handoff_created ON demo_bot_handoff(created_at DESC);
-- Gate Captain presence 的待阅计数(to_role + status),只走索引不读行。
CREATE INDEX IF NOT EXISTS idx_demo_bot_handoff_to_status ON demo_bot_handoff(to_role, status, created_at DESC);
-- /api/strategy-runs 的统计:按 (run_id, kind) 计数走覆盖索引,不再逐请求读取并解析整段事件 JSON。
CREATE INDEX IF NOT EXISTS strategy_run_events_kind ON strategy_run_events(run_id, kind, at);
