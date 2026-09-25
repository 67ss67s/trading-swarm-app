# 方案 A:OKX.AI ASP 订阅信号 → 跟单页信号源(设计与契约)

日期:2026-09-20。前置:`okx-asp-wallet-proposal-2026-09-20.md`(Jacky 拍板:先 A 再 B;钱包只做状态灯)。

## 0. 结论

- 把 OKX.AI 上订阅到的 ASP 信号当成**第二个跟单信号源**(`transport: 'okx_asp'`),归一化成现有 `TraderSignal`,
  走现有 `TraderFollow.ingest` → agent 判断依据 → 人工 apply/skip/reconcile。**不走 OKX 自己的 autotrade 链路**,
  不在网关里持久化任何 consentSnapshot,零自动交易所写(与跟单 session 同一纪律)。
- 信号来源 = 本机 `okx-a2a` 守护落在 `~/.okx-agent-task/sqlite/session-store.sqlite` 表 `pending_gateway_deliveries`
  的投递(**消费即删的队列**,所以高频只读轮询,见一条落一条)。库文件路径按候选列表探测
  (`OKX_AGENT_TASK_HOME` 或 `~/.okx-agent-task` 下 `sqlite/session-store.sqlite` / `sqlite/input.sqlite` /
  `session-store.sqlite` / `input.sqlite`),用 `node:sqlite` 只读打开(`readOnly: true`);WAL 打不开时把文件
  拷到临时目录再读(okx-signal-lab collect.py 的做法)。
- 订阅动作本身(挑 ASP、付费、签 EIP-712)**不在我们前端做**,留给 OKX 的 `okx-ai` 技能;前端只读展示
  `onchainos agent my-subscriptions --role buyer` 的结果,并给「去订阅」的说明(在 Claude 里说「帮我订阅 …」)。
- 钱包:只做状态灯(`onchainos wallet status` 的 loggedIn/email/accountName),不接余额以外的任何链上动作。

## 1. 网关(`packages/gateway`)

### 1.1 新模块 `src/demo/okx-asp-feed.ts`

```ts
export interface OkxAspFeedDeps {
  kv: FollowKv;                        // 复用 trader-feed 的 kv 接口(get/set)
  now?: () => number;
  /** 注入点:读队列行。生产 = node:sqlite 只读;测试给假数组。 */
  readQueue?: () => Promise<QueueRow[]>;
  /** 注入点:跑 onchainos / okx-a2a 命令拿 JSON。生产 spawn;测试假实现。 */
  runCli?: (bin: 'onchainos' | 'okx-a2a', args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;
  log: (level, message, data?) => void;
}
export interface QueueRow { id: string; job_id: string | null; message_id: string | null; content: string; llm_content: string | null; payload_json: string | null; created_at: string }
```

职责:
1. `poll()`:读全部队列行,按 `message_id`(没有就 `row-<id>`)去重(已见集合持久化在 kv `okx_asp.seen`,
   上限 5000 条,FIFO 淘汰);对每条新行的 `content` / `llm_content` / `payload_json` 三个字段各扫一遍
   「顶层平衡 JSON 对象」(移植 collect.py 的 `find_json_objects` + `pick_signal`:只认含 `deliveryId` /
   `signal_type` / `signalTime` 之一的对象,优先直接带 `deliveryId` 的),挑不出信号的行**也留痕**
   (kv `okx_asp.raw:<message_id>` 只留前 4000 字,便于事后排查解析),然后归一化。
2. `normalizeAspSignal(obj, ctx)` → `NormalizeResult`(与 `normalizeBridgeSignal` 同返回形状,坏行不抛):
   - `signal_id` = `okxasp_<deliveryId>`;没有 deliveryId 就 `okxasp_sha256(原文)[:24]`;
   - `trader` = ctx 给的 ASP 名(按 `job_id` 从订阅缓存查 `providerAgentName`/服务名;查不到就 `ASP <job_id 前 8 位>`);
   - `symbol`:`symbol`/`instId`,`BTC-USDT-SWAP`/`BTC-USDT` → `BTCUSDT`(复用 `okx/instruments.ts` 的映射);
     没有 symbol → 坏行;
   - `signal_type`:只有 `order`(大小写不敏感)才是可跟信号;`analysis`/其它 → **不入跟单流**,
     只记一条 `note`(kv `okx_asp.skipped` 计数 + 最近 50 条摘要),前端「订阅源」里能看到「分析类 N 条已忽略」;
   - `action`:`LONG|BUY` → action `open` side long;`SHORT|SELL` → open short;`CLOSE|EXIT|FLAT` → `close`;
     `REDUCE|TP|PARTIAL` → `reduce`;`ADD` → `add`;其它 → 坏行(留痕);
   - 价格:`price`/`entry`/`entryPrice` → `entry_prices`(能解析成十进制字符串的都收);没有 → `entry_kind` 按市价;
   - 止损:`stop_loss|stopLoss|sl|slTriggerPx|stop`;止盈:`take_profit|takeProfit|tp|tpTriggerPx`(单值或数组);
   - `published_at`:`signalTime|signal_time|ts|time`(秒/毫秒/微秒/ISO 自适应,同 collect.py `norm_ms`);
     解析不出 → 用队列行 `created_at`;仍拿不到 → 坏行;
   - `valid_until`:`valid_until|validUntil|expireAt|expiresAt`,规则与 bridge 一致(早于 published_at → invalid_validity);
   - `size_pct`:`sz`/`position_pct`/`leverage` 只留痕到 `raw_text`,不参与仓位;
   - `raw_text` = 原投递文本(≤ 4000 字);`transport = 'okx_asp'`;`market_type = 'perp'`;`backfill = false`;
   - `can_enter`/`is_executable` 明确为 false 的 → 归一化成功但标 `review_only`(走现有 `backfill: true` 语义即可:
     永不自动开仓,只进人工待办)。
3. `subscriptions()`:`onchainos agent my-subscriptions --role buyer`(JSON `data.list[]`),缓存 60s;
   映射 `job_id → { title, provider, status, period_end }`。CLI 失败 → 缓存为空但不影响轮询。
4. `status()`:`{ available, db_path, last_poll_at, last_error, seen, ingested, skipped_analysis, bad_rows, subscriptions[] }`。
5. 环境:`onchainos`/`okx-a2a` 二进制查找 `~/.local/bin/<name>` → PATH;进程环境原样继承(OKX API 要走 Clash 代理,
   见 memory okx-a2a-proxy-quirks,**别**去掉代理变量)。

### 1.2 接线(`runtime.ts` / `workflow.ts` / `routes-follow.ts`)

- `FollowSettings` 新增 `okx_asp_enabled: boolean`(默认 false)+ `okx_asp_poll_ms`(默认 3000,下限 1000)。
- 现有跟单 tick 里,`okx_asp_enabled` 时额外 `okxAspFeed.poll()`,拿到的 `TraderSignal[]` 走同一个 `handleSignals`
  (顺序、DLQ、`trader_signal` 事件全部复用)。跟单 session 的 `follow.enabled` 为 false 时也不轮询。
- 路由:`GET /api/follow/okx-asp`(status)、`POST /api/follow/okx-asp/poll`(手动拉一次)、
  `GET /api/okx/account`(三盏灯:`wallet`(onchainos wallet status)、`a2a`(okx-a2a status)、
  `trade_kit`(复用 `okxStatusView`);每盏 `{ ok, detail, checked_at }`,缓存 30s,`?fresh=1` 强刷)。
- `okx` 交易所之外(`TG_EXCHANGE=binance`)这些路由照常挂(它们不依赖交易所),但 `okx_asp_enabled` 默认 false。

### 1.3 测试

`test/demo/okx-asp-feed.test.ts`:JSON 抽取(嵌套/多对象/带人类文本)、`order` vs `analysis`、动作映射、
符号映射、时间自适应、坏行不抛且留痕、去重(同 message_id 两次只入一次;kv 淘汰)、`can_enter=false` → review_only、
订阅名映射、`runCli` 失败不影响轮询;再加一条端到端:假队列两行 → runtime tick → `store.traderSignals` 有两条
`transport='okx_asp'` 且状态是 `review_only`/`evidence`(按现有跟单模式决定)。

## 2. 前端(`packages/webui`)

- 跟单页(`pages/follow.tsx`)新增「订阅源 · OKX.AI」分栏:开关(`okx_asp_enabled`,POST /api/follow)、状态
  (库路径/上次轮询/入库 N/忽略分析 N/坏行 N)、订阅列表(标题、ASP、状态、周期到期)、「手动拉一次」按钮、
  一段说明「订阅/退订请在 Claude 里对 okx-ai 技能说『帮我订阅 …』/『退订 …』」。信号流里 `transport === 'okx_asp'`
  的行打一个 `OKX.AI` 徽标(现有列表已按 transport 显示来源,补一个标签映射即可)。
- 设置页(或执行页 OKX 块下方)「OKX 账户」三盏灯:钱包(邮箱/账户名)、A2A 守护(pid)、Trade Kit(profile/demo)。
  灯灭时给一行怎么点亮:钱包 `onchainos wallet login`、守护 `okx-a2a daemon start`(提醒跑过后要补代理,
  见 okx-signal-lab/fix-daemon-proxy.sh)、Trade Kit `okx config init`。
- i18n 补齐。

## 3. 验收

1. 关掉守护时:三盏灯里 A2A 灭,订阅源状态 `available:false`,轮询不报错刷屏(退避到 60s)。
2. 往假队列塞一条 `order` 信号(测试)→ 跟单页信号流出现,来源 OKX.AI,状态待人工。
3. 真实订阅(Jacky 在 Claude 里订一个 ASP)后,信号到达 ≤ 5s 出现在跟单页;`analysis` 类只计数不入流。
