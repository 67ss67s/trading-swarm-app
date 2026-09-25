-- 0012_demo_chat_sessions.sql — 对话分会话(Agent 页的 session 列表)。
-- 旧消息全部归到 'default' 会话;kind='narration' 的旁白不属于任何会话(session_id 留 NULL),按 kind 单独拉。
CREATE TABLE demo_chat_session (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  /** 本会话允许 agent 直接批准/否决待批 intent(chat_can_execute);默认关,用户在会话头上开。 */
  can_execute INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE demo_chat ADD COLUMN session_id TEXT;
CREATE INDEX idx_demo_chat_session ON demo_chat(session_id, at);
INSERT INTO demo_chat_session(id, title, created_at, updated_at, archived, can_execute)
  SELECT 'default', '默认会话', COALESCE(MIN(at), strftime('%s','now') * 1000), COALESCE(MAX(at), strftime('%s','now') * 1000), 0, 0 FROM demo_chat;
UPDATE demo_chat SET session_id = 'default' WHERE session_id IS NULL AND (json_extract(json, '$.kind') IS NULL OR json_extract(json, '$.kind') = 'chat');
