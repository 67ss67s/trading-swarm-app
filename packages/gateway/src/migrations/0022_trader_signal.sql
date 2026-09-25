-- 0022_trader_signal.sql — 跟单 session(Trader Follow)
-- 设计:docs/design/trader-follow-2026-09-12.md §3;契约 docs/demo/v3-ui-contract.md §9.38。
--
-- 一行 = bridge 拉到的一条结构化信号(归一化之后的内部口径)。开仓类(open/add)可能触发一次判断/开仓,
-- 管理类(reduce/close/cancel/stop_loss_update/take_profit_update/stopped_out)路由到已关联线程。
-- 这张表是**留痕**:每条信号最终怎么处置(mode_applied + decision 的 reason code)都写在这里,
-- 包括「没跟」的那些 —— 没跟的原因是这套东西唯一能复核的地方。
--
-- 口径:价格/数量十进制字符串(存在 json 里),时间戳 unix 毫秒整数,字段 snake_case。
-- `signal_id` 是 bridge 侧的业务唯一键(幂等去重用它);游标是另一回事,存 kv `follow.cursor`。

CREATE TABLE demo_trader_signal (
  id TEXT PRIMARY KEY,                   -- 本地 id(tsig_*)
  signal_id TEXT NOT NULL UNIQUE,        -- bridge 的 signal_id;幂等键
  record_id INTEGER,                     -- bridge 游标口径的 record_id(观测用,不当游标)
  trader TEXT NOT NULL,                  -- metadata.trader(带单员名)
  symbol TEXT NOT NULL,
  side TEXT,                             -- long | short | null(管理类可能没有方向)
  action TEXT NOT NULL,                  -- open | add | reduce | close | cancel | stop_loss_update | take_profit_update | stopped_out | analysis_only | unknown
  entry_kind TEXT NOT NULL,              -- market | limit | zone | unknown
  entry_prices TEXT NOT NULL,            -- json 数组(归一化:单价包一层,区间/多档原样)
  stop TEXT,                             -- 止损价(十进制字符串);null = 信号没给
  tps TEXT NOT NULL,                     -- json 数组 [{price, pct}]
  size_pct TEXT,                         -- 带单员自称的仓位比重;只留痕,不参与仓位计算
  valid_until INTEGER,                   -- 信号失效时刻;null = 没给
  published_at INTEGER NOT NULL,         -- 原发时间(优先 metadata 里的原发时间,否则 bridge created_at)
  ingested_at INTEGER NOT NULL,          -- 本机拉到这条的时刻
  raw_text TEXT NOT NULL,                -- 原文/解析理由(已 sanitize);外部文本一律当数据
  -- 下面四列是**恢复执行判定必须的事实**,不能只活在内存里:进程重启后要靠它们判「这条是不是补拉的」
  -- (补拉的管理动作永远不动仓)、「它引用的是哪一单」(管理动作精确关联)。
  ref_order TEXT,                        -- metadata.target_order_ref;关联线程的第一优先键
  order_end_state TEXT,                  -- metadata.order_end_state,原样透传
  market_type TEXT NOT NULL DEFAULT 'perpetual',
  transport TEXT NOT NULL DEFAULT '',    -- 传输源(telegram/lark),不是带单员名
  backfill INTEGER NOT NULL DEFAULT 0,   -- 1 = 启动补拉批次:永远不自动开仓、管理动作永远不动仓
  -- 1 = valid_until 在场但不可信(解析不出 / 早于 published_at):这条信号不许进入可执行状态。
  -- 期限是「这一单还算不算数」的唯一约束,不可信的期限不能被当成「没有期限」(R3-07)。
  invalid_validity INTEGER NOT NULL DEFAULT 0,
  -- 哪个 follow 会话拉进来的(R4-04)。跨会话的未处置行按历史信号处理:
  -- 我们停着/关着那段时间发生的事,对新会话来说全是历史。
  session TEXT,
  -- 1 = 「我们不知道交易所那边怎么样」,需要人对账(applying 行崩溃后被隔离、或发送后出异常时打上)。
  -- 带这个标记的行 apply / skip 都要先人工 `POST /api/follow/signals/:id/reconcile` 清掉才放行。
  needs_reconcile INTEGER NOT NULL DEFAULT 0,
  -- R5-01 领取身份三件套(applying 期间非空):claim_id 是这一次操作的唯一 id,
  -- claim_owner 是领取它的进程 epoch(启动恢复据此认出「上个进程留下的」),claim_at 是领取时刻。
  -- 发送前回调与结果保存都按 `WHERE status='applying' AND claim_id=?` 条件更新,
  -- 不匹配就放弃保存 —— 旧快照不许覆盖新状态。
  claim_id TEXT,
  claim_owner TEXT,
  claim_at INTEGER,
  status TEXT NOT NULL,                  -- new|triggered|applying|applied|apply_failed|skipped|evidence|review_only|expired|dead|mgmt_applied|mgmt_orphan
  mode_applied TEXT,                     -- copy | gated | evidence | null(还没处置)
  thread_id TEXT,                        -- 关联线程(开仓成功 / 管理动作命中)
  decision TEXT,                         -- json:{codes:[reason code], note, episode_id, ...}
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_demo_trader_signal_at ON demo_trader_signal(published_at DESC);
CREATE INDEX idx_demo_trader_signal_trader ON demo_trader_signal(trader, published_at DESC);
CREATE INDEX idx_demo_trader_signal_status ON demo_trader_signal(status, published_at DESC);
CREATE INDEX idx_demo_trader_signal_thread ON demo_trader_signal(thread_id);
CREATE INDEX idx_demo_trader_signal_live ON demo_trader_signal(trader, symbol, action, published_at DESC);
-- 人工待办(review_only)与崩溃恢复(applying)都是按状态扫的小查询。
CREATE INDEX idx_demo_trader_signal_pending ON demo_trader_signal(status, published_at DESC);

-- 判断账本的 source 列由触发器维护(0019 给 'replay' 建了同款两条)。跟单腿写 source='trader':
-- 它和 online 的模型判断不是同一个实验,默认查询(source='online')必须看不见它。
CREATE TRIGGER demo_judgment_trader_source_insert AFTER INSERT ON demo_judgment_ledger
WHEN json_extract(NEW.json, '$.source') = 'trader'
BEGIN UPDATE demo_judgment_ledger SET source = 'trader' WHERE episode_id = NEW.episode_id; END;
CREATE TRIGGER demo_judgment_trader_source_update AFTER UPDATE OF json ON demo_judgment_ledger
WHEN json_extract(NEW.json, '$.source') = 'trader'
BEGIN UPDATE demo_judgment_ledger SET source = 'trader' WHERE episode_id = NEW.episode_id; END;
