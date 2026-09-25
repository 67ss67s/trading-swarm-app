-- 研究任务、已预留调用预算、原文摘录；均为只读研究，不含交易权限。
CREATE TABLE research_tasks (
 id TEXT PRIMARY KEY, auto_key TEXT UNIQUE, status TEXT NOT NULL, due_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL, json TEXT NOT NULL
);
CREATE INDEX research_tasks_due ON research_tasks(status, due_at);
CREATE TABLE research_daily_usage (day TEXT PRIMARY KEY, model_calls INTEGER NOT NULL DEFAULT 0, fetches INTEGER NOT NULL DEFAULT 0);
CREATE TABLE research_excerpts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, url TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL);
