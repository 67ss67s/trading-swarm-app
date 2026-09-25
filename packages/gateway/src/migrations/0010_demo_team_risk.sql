-- 0010_demo_team_risk.sql — Portfolio Manager 快照 + Risk Sentinel 告警(Phase-2,两个 CODE 角色)。
-- 设计:docs/design/team-roles-2026-09-06.md §3/§4。两个角色都是纯代码,零模型调用。

-- 账户级敞口快照(portfolio.ts computeSnapshot)。只在经济内容指纹变化或每 15 分钟抽样落一行,
-- 不把每次 15 秒轮询都落库;被待批 intent / 未结告警引用的行不清理。
CREATE TABLE demo_portfolio_snapshot (
  snapshot_id TEXT PRIMARY KEY,
  observed_at INTEGER NOT NULL,
  quality TEXT NOT NULL,                 -- ok | stale | inconsistent | incomplete
  economic_fingerprint TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  equity REAL NOT NULL,
  gross_ratio REAL NOT NULL,
  json TEXT NOT NULL                     -- PortfolioSnapshot 全文
);
CREATE INDEX idx_demo_portfolio_snapshot_at ON demo_portfolio_snapshot(observed_at DESC);

-- 风险告警(risk.ts evaluateRisk)。同指纹 = 同一条告警的持续:只更新 last_seen/observed_count;
-- 指纹从评估结果里消失 → resolved_at 落时间。ack 只表示人看过了,不构成任何授权。
CREATE TABLE demo_risk_alert (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,                -- info | warn | high | critical
  scope TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  value REAL,
  threshold REAL,
  refs_json TEXT NOT NULL,
  auto_action TEXT NOT NULL,             -- none | block_new_risk
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  observed_count INTEGER NOT NULL,
  resolved_at INTEGER,
  acked_at INTEGER,
  clean_streak INTEGER NOT NULL DEFAULT 0,   -- 连续多少轮评估里没再出现(滞回/恢复计数)
  recovery_ready INTEGER NOT NULL DEFAULT 0  -- high/critical:恢复事实已齐,等人点「确认恢复」
);
CREATE UNIQUE INDEX idx_demo_risk_alert_open ON demo_risk_alert(fingerprint) WHERE resolved_at IS NULL;
CREATE INDEX idx_demo_risk_alert_seen ON demo_risk_alert(resolved_at, last_seen_at DESC);
