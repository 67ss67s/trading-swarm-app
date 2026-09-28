-- 遗留角色会话只归档:消息留在原 session,不搬迁、不删除。default 保留原 id。
UPDATE demo_chat_session SET archived = 1
WHERE role IS NOT NULL AND id <> 'default'
  AND id <> CASE WHEN role = 'gate_captain' THEN 'default' ELSE 'agent:' || role END;

-- 规范会话由 DemoStore 启动时按 AGENT_REGISTRY upsert,名称不在迁移复制第二份。
UPDATE demo_chat_session SET role = 'gate_captain', archived = 0 WHERE id = 'default';
