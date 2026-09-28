-- 14 天运行加固(.codex-reports/soak-14d-report.md):日志合并与噪音摘要、研究缓存容量计量、公网演示额度。不改交易状态机。

-- 日志:写入端合并计数;ops_noise NULL=旧行待分类 0=保留 1=噪音明细 2=噪音每日摘要行;ops_key 为 log-policy.ts 的合并 key。
ALTER TABLE demo_logs ADD COLUMN repeat_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE demo_logs ADD COLUMN last_seen_at INTEGER;
ALTER TABLE demo_logs ADD COLUMN ops_noise INTEGER;
ALTER TABLE demo_logs ADD COLUMN ops_key TEXT;
CREATE INDEX idx_ops_logs_classify ON demo_logs(ops_noise, id);
CREATE INDEX idx_ops_logs_noise_at ON demo_logs(ops_noise, at);
CREATE INDEX idx_ops_logs_summary ON demo_logs(ops_key, at) WHERE ops_noise = 2;

-- 研究数据集:容量计量(触发器维护),写入端到上限拒绝新增,已有证据不删。
CREATE INDEX idx_research_datasets_created ON research_datasets(created_at);
CREATE TABLE ops_cache_usage (name TEXT PRIMARY KEY, bytes INTEGER NOT NULL, rows INTEGER NOT NULL);
INSERT INTO ops_cache_usage SELECT 'research_datasets', COALESCE(SUM(length(CAST(json AS BLOB))), 0), COUNT(*) FROM research_datasets;
CREATE TRIGGER ops_dataset_insert AFTER INSERT ON research_datasets BEGIN
  UPDATE ops_cache_usage SET bytes = bytes + length(CAST(NEW.json AS BLOB)), rows = rows + 1 WHERE name = 'research_datasets';
END;
CREATE TRIGGER ops_dataset_delete AFTER DELETE ON research_datasets BEGIN
  UPDATE ops_cache_usage SET bytes = bytes - length(CAST(OLD.json AS BLOB)), rows = rows - 1 WHERE name = 'research_datasets';
END;
CREATE TRIGGER ops_dataset_update AFTER UPDATE OF json ON research_datasets BEGIN
  UPDATE ops_cache_usage SET bytes = bytes + length(CAST(NEW.json AS BLOB)) - length(CAST(OLD.json AS BLOB)) WHERE name = 'research_datasets';
END;

-- 公网演示:按 UTC 日的访客次数与费用预留(微美元整数);访客会话归属。
CREATE TABLE ops_demo_usage (
  day INTEGER NOT NULL,
  subject TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  reserved_microusd INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, subject)
);
CREATE TABLE ops_demo_sessions (id TEXT PRIMARY KEY, visitor TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX idx_ops_demo_sessions_visitor ON ops_demo_sessions(visitor, created_at);
