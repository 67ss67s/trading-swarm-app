-- 独立 backend × 验证代际允许旧证据冻结、新窗口重新采样。
DROP INDEX idx_demo_shadow_thread_open;
CREATE UNIQUE INDEX idx_demo_shadow_thread_open ON demo_shadow_thread(strategy_id, version, symbol, COALESCE(json_extract(json, '$.backend'), ''), COALESCE(json_extract(json, '$.generation'), 0)) WHERE status = 'open';
