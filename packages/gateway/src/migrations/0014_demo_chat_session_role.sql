-- 0014_demo_chat_session_role.sql — 会话可以「对着某个角色说」(楼层桌子 → 新会话)。null = 主会话(Gate Captain 路由)。
ALTER TABLE demo_chat_session ADD COLUMN role TEXT;
