-- 活动流使用 (at,id) 稳定游标；同一毫秒多条记录不丢失，避免翻页全表排序。
CREATE INDEX idx_demo_activity_at_id ON demo_activity(at DESC, id DESC);
CREATE INDEX idx_demo_activity_thread_at_id ON demo_activity(thread_id, at DESC, id DESC);

-- /api/bots 与 Reviewer 定时器按 thread_id 计数：避免每条线程重新解析全部 episode JSON。
CREATE INDEX idx_demo_episodes_thread_json ON demo_episodes(json_extract(json, '$.thread_id'));
-- 记忆后果回写：按已结算账本增量限量读取，既有证据/日志不删除。
CREATE INDEX idx_demo_judgment_settled_id ON demo_judgment_ledger(settled_at, episode_id) WHERE settled_at IS NOT NULL;
CREATE TABLE demo_memory_outcome_sweep (
  episode_id TEXT PRIMARY KEY,
  settled_at INTEGER NOT NULL
);
CREATE TRIGGER demo_memory_sweep_episode_changed AFTER UPDATE OF json ON demo_episodes
BEGIN DELETE FROM demo_memory_outcome_sweep WHERE episode_id = NEW.id; END;
