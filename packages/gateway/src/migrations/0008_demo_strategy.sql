-- 0008_demo_strategy.sql — 策略库(docs/design/strategy-library-2026-09-05.md;
-- 决定稿 docs/research/scan-and-strategy-decision-2026-09-05.md §2 E/F)。
--
-- 一条策略 = 一串不可变版本。触发/清单/规则/参数进 content_hash;status 与 eval_stats 是版本行上的
-- 可变元数据(晋升与回测统计会改它们,但改不了这个版本被判断时用的那份内容)。改任何参数或规则
-- 都要新建版本:旧成交永远指向它当时的 hash。

CREATE TABLE demo_strategy_version (
  id TEXT NOT NULL,                      -- 策略 id(跨版本稳定),如 breakout_retest
  version INTEGER NOT NULL,              -- 从 1 递增
  content_hash TEXT NOT NULL,            -- sha256(name|family|trigger|checklist|rules|params)
  status TEXT NOT NULL,                  -- draft | backtest | shadow | paper | live_capped | retired
  name TEXT NOT NULL,
  family TEXT NOT NULL,
  parent_version INTEGER,                -- 从哪个版本派生(null = 内置初版)
  created_at INTEGER NOT NULL,
  json TEXT NOT NULL,                    -- StrategySpec(strategies.ts)
  PRIMARY KEY (id, version)
);
CREATE INDEX idx_demo_strategy_version_status ON demo_strategy_version(status);
CREATE INDEX idx_demo_strategy_version_hash ON demo_strategy_version(content_hash);

-- 回测归因(便宜大脑读一次回测的成交 + 判断,吐 ≤ 3 个「问题点位」)。
-- 每条都同时提案成一条长期记忆(status=proposed),永远不自动应用。
CREATE TABLE demo_backtest_attribution (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  strategy_id TEXT,
  symbol TEXT,
  kind TEXT NOT NULL,                    -- rule_wording | param | checklist_item
  title TEXT NOT NULL,
  json TEXT NOT NULL,                    -- AttributionPoint(attribution.ts):证据说了什么/规则说了什么/实际发生什么/提议
  memory_id TEXT,                        -- 对应的记忆提案(MemoryStore.propose)
  applied_version INTEGER                -- 人点了「生成新版本」后落在哪个版本上;null = 还没采纳
);
CREATE INDEX idx_demo_backtest_attr_run ON demo_backtest_attribution(run_id, at);

-- 线程记下它跟的是哪条策略(json 里也有,这里出一列是为了直接 GROUP BY 归因)。
ALTER TABLE demo_threads ADD COLUMN strategy_id TEXT;
-- 回测每一步记下模型自称跟的策略。
ALTER TABLE demo_backtest_step ADD COLUMN strategy_id TEXT;
