-- 0015_demo_equity_backend.sql — 权益曲线按执行通道分(paper 的 1 万接到 agent_mcp 的 45 会画出 −9900 的假回撤)。
-- 回填:agent_mcp 09-05 18:39 UTC 才第一次接上,此后权益 < 1000 的点都是它的;其余是 paper。
ALTER TABLE demo_equity ADD COLUMN backend TEXT NOT NULL DEFAULT 'paper';
UPDATE demo_equity SET backend = 'agent_mcp' WHERE at >= 1788633500000 AND equity < 1000;
CREATE INDEX idx_demo_equity_backend ON demo_equity(backend, at);
