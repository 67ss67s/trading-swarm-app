-- §9.53 A:对话工具 recommend_assets 的结果。对话消息里只放 recommendation_ref,推荐卡与「去研究台验证」按 id 取。
CREATE TABLE asset_recommendations (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  body_json TEXT NOT NULL
);
CREATE INDEX asset_recommendations_created ON asset_recommendations(created_at DESC);
