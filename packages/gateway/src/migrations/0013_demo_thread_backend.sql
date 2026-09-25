-- 0013_demo_thread_backend.sql — 线程带执行通道归属(切通道 = 切账户上下文;paper 的线程不出现在 agent_mcp 下)。
-- 历史线程全部是纸面(agent_mcp 09-05 晚才接上,期间没开过线程)。
ALTER TABLE demo_threads ADD COLUMN backend TEXT;
UPDATE demo_threads SET backend = COALESCE(json_extract(json, '$.backend'), 'paper');
UPDATE demo_threads SET json = json_set(json, '$.backend', backend) WHERE json_extract(json, '$.backend') IS NULL;
CREATE INDEX idx_demo_threads_backend ON demo_threads(backend, status, updated_at);
