-- 0040_memory_scope.sql — 记忆分域(docs/design/self-evolution-2026-09-23.md §5;契约 docs/demo/memory.md §1、v3-ui-contract §9.48)。
--
-- scope 从 {symbol,timeframe,regime} 扩成 {layer, role, strategy_id, symbol, timeframe, regime, thread_id}。
-- 读权(recall 按 reader_role 过滤)与写权(propose 校验 proposed_by_role)在 memory.ts 的 MEMORY_MATRIX。
-- demo_memory_fts 是独立 FTS5 表(不是 external-content),只存 memory_id/content/tags,加列不需要重建。
-- 编号跳到 0040:0033–0039 留给并行 session;迁移按文件名字典序执行(state-db.ts listMigrations)。

ALTER TABLE demo_memory ADD COLUMN layer TEXT NOT NULL DEFAULT 'global';
ALTER TABLE demo_memory ADD COLUMN role TEXT;
ALTER TABLE demo_memory ADD COLUMN strategy_id TEXT;
ALTER TABLE demo_memory ADD COLUMN thread_id TEXT;

-- 回填:旧行只有 symbol 一个维度 → 有币的是 symbol 层,其余是 global 层。json 里的 scope 同步补齐,
-- 让直接读 json 的旁路(导出 / eval)也看到同一份口径。
UPDATE demo_memory SET layer = CASE WHEN symbol IS NOT NULL THEN 'symbol' ELSE 'global' END;
UPDATE demo_memory SET json = json_set(json,
  '$.scope.layer', layer,
  '$.scope.role', json('null'),
  '$.scope.strategy_id', json('null'),
  '$.scope.thread_id', json('null'))
WHERE json_valid(json);

CREATE INDEX idx_demo_memory_layer ON demo_memory(status, layer, role, strategy_id);
CREATE INDEX idx_demo_memory_thread ON demo_memory(thread_id) WHERE thread_id IS NOT NULL;

-- §2.2 后果回写的幂等键:同一条记忆 × 同一个 episode 只记一次 outcome。
CREATE UNIQUE INDEX idx_demo_memory_events_outcome ON demo_memory_events(memory_id, json_extract(detail, '$.episode_id')) WHERE kind = 'outcome';
