-- 0009_demo_bots.sql — Bot 团队注册表 + Radar 筛选器(Phase-2-lite)。
-- 设计:docs/design/trade-gate-bot-team-guide-2026-09-04.ipynb §13「建议增加的持久对象」,
--       落地范围与取舍见 docs/design/screener-radar-2026-09-05.md。
--
-- 这一版只落四张表:bot_profiles / bot_runs / bot_handoffs(可审计的角色与交接)+ watch_candidates
-- (Radar 每次筛选的产物)。artifacts / routines / portfolio_* / risk_* 留给后面的阶段。
--
-- 红线(notebook §4 与 cell 6 的 validate_role_boundaries):`exchange.write` 这个 capability
-- 有且只有 executor 一个持有者。它写在数据里,开机时由 bots.ts 的 assertRoleBoundaries() 断言;
-- 手改一行 profile 把它塞给别人,进程就起不来。

-- 一个长期存在的角色。model_pin / capabilities / memory_scope 是 notebook 里 RoleSpec 的字段。
CREATE TABLE demo_bot_profile (
  role TEXT PRIMARY KEY,                 -- gate_captain | radar | thread_manager | strategy_lab |
                                         -- portfolio_manager | risk_sentinel | reviewer | executor
  name TEXT NOT NULL,                    -- 显示名(中文)
  kind TEXT NOT NULL,                    -- llm_session | llm_recipe | hybrid | deterministic+explainer | protected_service ...
  description TEXT NOT NULL,             -- 它拥有什么(owns)
  model_pin TEXT,                        -- 钉死的模型 id;null = 跟随 workflow 的大脑设置
  capabilities_json TEXT NOT NULL,       -- string[]
  memory_scope TEXT NOT NULL,
  approval_boundary TEXT NOT NULL,
  enabled INTEGER NOT NULL,              -- 0/1。这一版只有 radar 与「已经在跑的那几块」是 1
  note TEXT,                             -- enabled=0 时说明「还差什么」
  sort_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 一次有界的工作(notebook §13 bot_runs)。budget_json 记这次的预算,cost_cny 记实际花掉的钱。
CREATE TABLE demo_bot_run (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  routine TEXT NOT NULL,                 -- 'screen:short' | 'screen:swing' | 'screen:weekly' | ...
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,                  -- running | done | failed | skipped
  budget_json TEXT NOT NULL,             -- { max_symbols, max_cny, use_brain, ... }
  cost_cny REAL NOT NULL DEFAULT 0,
  summary TEXT,
  error TEXT
);
CREATE INDEX idx_demo_bot_run_role ON demo_bot_run(role, started_at DESC);

-- 可审计的异步交接(notebook §6 的 JSON 逐字段落表)。Bot-to-Bot 文本永远是 untrusted data:
-- 这张表只记录「谁把什么交给了谁」,它本身不构成任何授权。
CREATE TABLE demo_bot_handoff (
  handoff_id TEXT PRIMARY KEY,
  run_id TEXT,
  from_role TEXT NOT NULL,
  to_role TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- request | result | review | alert | blocked
  subject_type TEXT NOT NULL,            -- 'screen' | 'proposal' | 'thread' | ...
  subject_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,      -- string[]
  artifact_refs_json TEXT NOT NULL,      -- string[]
  requested_output_schema TEXT,
  priority INTEGER NOT NULL,
  deadline_at INTEGER,
  idempotency_key TEXT NOT NULL UNIQUE,  -- 同一个 key 不重复启动工作(notebook §6 纪律)
  status TEXT NOT NULL,                  -- pending | acked
  created_at INTEGER NOT NULL,
  acked_at INTEGER,
  payload_json TEXT                      -- 结构化产物(这里是 watchlist 提案)
);
CREATE INDEX idx_demo_bot_handoff_status ON demo_bot_handoff(status, created_at DESC);
CREATE INDEX idx_demo_bot_handoff_to ON demo_bot_handoff(to_role, created_at DESC);

-- Radar 一次筛选的元数据(哪些币、什么口径、花了多少)。
CREATE TABLE demo_screen (
  id TEXT PRIMARY KEY,
  horizon TEXT NOT NULL,                 -- short | swing | weekly
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,                  -- running | done | failed
  universe TEXT NOT NULL,                -- watchlist+whitelist | top_volume | explicit
  symbols_json TEXT NOT NULL,            -- 实际筛了哪些
  errors_json TEXT NOT NULL,             -- [{symbol, error}]
  run_id TEXT,                           -- 对应的 demo_bot_run
  handoff_id TEXT,                       -- 交给 gate_captain 的那条 handoff
  proposal_json TEXT,                    -- { symbols, active_strategies, k, note }
  brain_json TEXT,                       -- { used, model, cost_cny, dropped_lines, note }
  cost_cny REAL NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX idx_demo_screen_horizon ON demo_screen(horizon, started_at DESC);

-- 一次筛选里的一行:某个币 × 某条策略的机会卡(notebook §11.1 的 WatchCandidate)。
CREATE TABLE demo_watch_candidate (
  screen_id TEXT NOT NULL,
  horizon TEXT NOT NULL,
  symbol TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  fit_score REAL NOT NULL,               -- 0..1,确定性打分(不是模型给的)
  rank INTEGER NOT NULL,                 -- 1 = 这次筛选里最好的
  reasons_json TEXT NOT NULL,            -- string[](确定性文案;模型那句单独放 card 里)
  card_json TEXT NOT NULL,               -- OpportunityCard
  ttl_at INTEGER NOT NULL,               -- 过了这个时间这张卡就该重算,不该再当依据
  created_at INTEGER NOT NULL,
  PRIMARY KEY (screen_id, symbol, strategy_id)
);
CREATE INDEX idx_demo_watch_candidate_rank ON demo_watch_candidate(screen_id, rank);
